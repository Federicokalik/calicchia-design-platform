/**
 * Preflight dello strumento di migrazione e guardia delle sue scritture (fase
 * F3 del passaggio del calendario a Radicale; design §13.3; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §6.1 e §6.1.1).
 *
 * Il preflight è in sola lettura, con un'unica eccezione voluta: la PUT del
 * probe su `_canary`, che DEVE ricevere 403 (test negativo del gate). Ogni
 * controllo produce una riga `check` del run con il proprio esito:
 *  - pass: a posto; warn: da guardare, non blocca; skip: non applicabile ora
 *    (per esempio i probe prima dell'inizializzazione);
 *  - fail: blocca;
 *  - confirm: blocca finché l'admin non registra la dichiarazione indicata
 *    (remote mode accettata, 401 pubblico verificato dall'host, backup
 *    verificato, volume della Fase 0); con la dichiarazione diventa pass con
 *    `declared`.
 * `ready` vale true solo senza fail né confirm.
 *
 * Guardia delle scritture (assertMigrationWritable, createIdentityGuard): ogni
 * run che scrive (init create_missing, archivio, apply, riassegnazione) e ogni
 * job shadow rilegge lo stato SENZA cache (mode deve restare postgres per
 * tutta la F3) e l'identità del volume dal marker su Radicale (PROPFIND come
 * caldes-svc, mai dalla cache del campanello né dal mount), e la riverifica
 * prima di ogni collezione e almeno ogni 60 secondi. Un'identità diversa da
 * `ok`, o diversa da quella vista all'avvio, ferma il run: mai una scrittura su
 * un volume senza identità.
 *
 * Convenzione d'errore (contratto §5.2): le funzioni lanciano MigrationError;
 * quando l'esito del run ha un codice più preciso di PRECONDITION_FAILED
 * (IDENTITY_NOT_OK, IDENTITY_CHANGED, MODE_CHANGED, PRINCIPAL_EXISTS,
 * STATE_CHANGED, RADICALE_UNREACHABLE) lo mettono in `details.run_error_code`.
 *
 * Nessun dato personale nei dettagli: id, nomi delle collezioni, conteggi,
 * stati e codici.
 */

import { randomUUID } from 'node:crypto';
import { logger as rootLogger } from '../../logger';
import {
  type DeclarationKey,
  DEFAULT_MIGRATION_OPTIONS,
  type IdentityDiffView,
  MIGRATION_LIMITS,
  MIGRATION_STATE_COLUMNS,
  type MigrationBackendState,
  MigrationError,
  type MigrationItemInput,
  type MigrationRunContext,
  type MigrationRunErrorCode,
  normalizeMigrationState,
  type PreconditionReason,
  type PreflightCheck,
  type PreflightCheckCode,
  type PreflightCheckStatus,
  type PreflightParams,
  type PreflightSummary,
} from './types';
import { CAL_JOB_KINDS } from '../jobs';
import { CAL_LOCKS } from '../index-model';
import { type CanaryResult, lastCanaryResult } from '../radicale/canary';
import { collectionPath, objectPath, RadicaleClient } from '../radicale/client';
import { type DavPropName, NS } from '../radicale/dav-xml';
import { isRadicaleError, type RadicaleError } from '../radicale/errors';
import { type ControlPlaneStatus, type ControlPlaneTick, getCalendarControlPlane, requestControlPlaneSync } from '../radicale/heartbeat';
import { checkVolumeIdentity, remoteIdentitySource } from '../radicale/identity';
import type { Db } from '../radicale/policy';
import { currentWatchMode, radicaleRuntime, type WatchMode } from '../radicale/sync';
import { CANARY_COLLECTION, type IdentityStatus, identityStatus, PROBE_USER, SERVICE_USER, type VolumeMarker } from '../radicale/types';
import { plannedCollections, readVolumeCollections, type VolumeRead } from './init';
import { inventoryAppPasswords } from './inventory';
import { loadLegacySource, serializeLegacy } from './serialize';

const log = rootLogger.child({ scope: 'calendar-migration-preflight' });

/** Versione di Radicale dell'immagine pinnata (design §3.1). */
export const EXPECTED_RADICALE_VERSION = '3.7.8';

/** Proprietà `RADICALE:version` (Radicale 3.7.8 la espone sulle collezioni agli utenti autenticati). */
export const RADICALE_VERSION_PROP: DavPropName = Object.freeze({ ns: 'http://radicale.org/ns/', name: 'version' });

/** Privilegio DAV corrente dell'utente (RFC 3744 §5.4). */
const CURRENT_USER_PRIVILEGE_SET: DavPropName = Object.freeze({ ns: NS.DAV, name: 'current-user-privilege-set' });

/** Privilegi che danno scrittura su una collezione. */
const WRITE_PRIVILEGES: ReadonlySet<string> = new Set(['all', 'write', 'write-content', 'bind', 'unbind']);

/** Timeout delle richieste del preflight verso Radicale e verso l'URL pubblico. */
const PREFLIGHT_TIMEOUT_MS = 8_000;
/** Attesa massima del giro del control-plane richiesto dal controllo CONTROL_PLANE. */
const CONTROL_PLANE_SYNC_TIMEOUT_MS = 10_000;
/** Intervallo massimo fra due riverifiche dell'identità durante un run che scrive. */
export const IDENTITY_RECHECK_INTERVAL_MS = 60_000;

// ─── Stato ───────────────────────────────

/**
 * Riga di calendar_backend_state con le colonne della 165, riletta senza
 * cache (contratto §3.1). Lancia MigrationError('INTERNAL') se la riga manca.
 */
export async function readMigrationStateFresh(db: Db): Promise<MigrationBackendState> {
  const rows: Array<Record<string, unknown>> = await db`
    SELECT ${db(MIGRATION_STATE_COLUMNS as unknown as string[])}
    FROM calendar_backend_state
    WHERE id = true
  `;
  if (rows.length !== 1) throw new MigrationError('INTERNAL', 'calendar_backend_state: riga singleton assente');
  return normalizeMigrationState(rows[0]);
}

// ─── Errori ───────────────────────────────

/**
 * MigrationError PRECONDITION_FAILED con i motivi per il wizard e, quando
 * serve, il codice d'esito del run più preciso (`details.run_error_code`).
 */
export function preconditionError(
  message: string,
  reasons: ReadonlyArray<PreconditionReason | string>,
  runErrorCode?: MigrationRunErrorCode,
  extra: Record<string, unknown> = {},
): MigrationError {
  return new MigrationError('PRECONDITION_FAILED', message, {
    reasons: [...reasons],
    ...(runErrorCode ? { run_error_code: runErrorCode } : {}),
    ...extra,
  });
}

/** Client e principal del runtime di Radicale; MigrationError RADICALE_NOT_CONFIGURED se il client manca. */
export function requireRadicale(): { client: RadicaleClient; principal: string } {
  const rt = radicaleRuntime();
  if (!rt.client) {
    throw new MigrationError('RADICALE_NOT_CONFIGURED', `Radicale non configurato: ${rt.unavailableReason ?? 'RADICALE_URL assente'}`);
  }
  return { client: rt.client, principal: rt.principal };
}

/** Descrizione breve di un errore di Radicale (codice e status), senza URL né credenziali. */
export function describeRadicaleError(err: unknown): string {
  if (isRadicaleError(err)) return `${err.code}${err.status ? ` ${err.status}` : ''}`;
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}

// ─── Guardia delle scritture ───────────────────────────────

/**
 * Guardia di ogni scrittura dello strumento: stato riletto senza cache (mode
 * postgres), identità 'ok' letta da Radicale (remoteIdentitySource, mai dalla
 * cache del campanello), opzionalmente shadow acceso. Lancia
 * MigrationError('PRECONDITION_FAILED', …, { reasons: ['MODE_NOT_POSTGRES' | 'IDENTITY_NOT_OK'] }).
 */
export async function assertMigrationWritable(opts: { db: Db; client: RadicaleClient; principal: string; requireShadow?: boolean }): Promise<MigrationBackendState> {
  const state = await readMigrationStateFresh(opts.db);
  if (state.mode !== 'postgres') {
    throw preconditionError(`Lo strumento di migrazione scrive solo in mode postgres (ora ${state.mode})`, ['MODE_NOT_POSTGRES'], 'MODE_CHANGED', { mode: state.mode });
  }
  const check = await checkVolumeIdentity(state, remoteIdentitySource(opts.client, { timeoutMs: PREFLIGHT_TIMEOUT_MS }), opts.principal);
  if (check.status !== 'ok') {
    throw preconditionError(
      `Identità del volume non verificata (${check.status}${check.detail ? `: ${check.detail}` : ''}): nessuna scrittura su Radicale`,
      ['IDENTITY_NOT_OK'],
      'IDENTITY_NOT_OK',
      { identity: check.status },
    );
  }
  if (opts.requireShadow && !state.shadow_enabled) {
    throw preconditionError('Shadow mirror spento', ['SHADOW_DISABLED'], undefined, { shadow_enabled: false });
  }
  return state;
}

/** Guardia d'identità di un run che scrive (contratto §1.4 regola 2). */
export interface IdentityGuard {
  /** Stato verificato all'avvio (volume_id ed epoch di riferimento). */
  readonly state: MigrationBackendState;
  /**
   * Riverifica stato e marker se sono passati almeno 60 secondi dall'ultima
   * verifica, o sempre con `force` (prima di ogni collezione). Lancia
   * PRECONDITION_FAILED con run_error_code IDENTITY_CHANGED se l'identità non
   * è più `ok` o è cambiata rispetto all'avvio, MODE_CHANGED se il mode non è
   * più postgres.
   */
  recheck(opts?: { force?: boolean }): Promise<void>;
}

export async function createIdentityGuard(opts: {
  db: Db;
  client: RadicaleClient;
  principal: string;
  requireShadow?: boolean;
  intervalMs?: number;
  now?: () => number;
}): Promise<IdentityGuard> {
  const state = await assertMigrationWritable(opts);
  const interval = opts.intervalMs ?? IDENTITY_RECHECK_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  let last = now();
  return {
    state,
    async recheck(r: { force?: boolean } = {}): Promise<void> {
      if (!r.force && now() - last < interval) return;
      let current: MigrationBackendState;
      try {
        current = await assertMigrationWritable(opts);
      } catch (err) {
        if (err instanceof MigrationError && err.code === 'PRECONDITION_FAILED') {
          const details = err.details ?? {};
          const reasons = Array.isArray(details.reasons) ? details.reasons : [];
          throw new MigrationError('PRECONDITION_FAILED', `${err.message} (cambiata durante il run)`, {
            ...details,
            run_error_code: reasons.includes('MODE_NOT_POSTGRES') ? 'MODE_CHANGED' : 'IDENTITY_CHANGED',
          });
        }
        throw err;
      }
      if (current.volume_id !== state.volume_id || current.epoch !== state.epoch) {
        throw preconditionError(
          `Identità del volume cambiata durante il run (era ${state.volume_id}/${state.epoch}, ora ${current.volume_id}/${current.epoch})`,
          ['IDENTITY_NOT_OK'],
          'IDENTITY_CHANGED',
        );
      }
      last = now();
    },
  };
}

// ─── Dipendenze del preflight (sostituibili nei test) ───────────────────────────────

/** Ingressi esterni del preflight: client, probe, URL pubblico, campanello, control-plane, orologio. */
export interface PreflightDeps {
  /** Client come caldes-svc (null: Radicale non configurato). */
  client: RadicaleClient | null;
  unavailableReason: string | null;
  principal: string;
  /** Client come caldes-probe sulla rete interna (null: RADICALE_PROBE_PASSWORD assente). */
  probeClient: RadicaleClient | null;
  /** RADICALE_PUBLIC_URL (null se non impostata). */
  publicUrl: string | null;
  /** Client sull'URL pubblico con le credenziali di un utente di servizio (null se la password non è nota). */
  publicClient: (user: typeof SERVICE_USER | typeof PROBE_USER) => RadicaleClient | null;
  watch: () => { mode: WatchMode; reason: string | null };
  canary: () => CanaryResult | null;
  controlPlane: () => { status: ControlPlaneStatus | null; sync: () => Promise<ControlPlaneTick | null> };
  now: () => Date;
}

/** Dipendenze di produzione: runtime di Radicale, variabili d'ambiente, campanello e control-plane del processo. */
export function defaultPreflightDeps(env: NodeJS.ProcessEnv = process.env): PreflightDeps {
  const rt = radicaleRuntime();
  // Nome del contratto control-plane §1.3 (compose: RADICALE_PROBE_PASSWORD = CALDES_PROBE_PASSWORD
  // dell'healthcheck di Radicale); CALDES_PROBE_PASSWORD resta accettata come ripiego.
  const probePassword = env.RADICALE_PROBE_PASSWORD?.trim() || env.CALDES_PROBE_PASSWORD?.trim() || '';
  const publicUrl = env.RADICALE_PUBLIC_URL?.trim() || null;
  const svcPassword = env.RADICALE_SVC_PASSWORD ?? '';
  const probeClient = rt.client && probePassword
    ? new RadicaleClient({ baseUrl: rt.client.baseUrl, username: PROBE_USER, password: probePassword, timeoutMs: PREFLIGHT_TIMEOUT_MS, retries: 0, userAgent: 'caldes-api-preflight' })
    : null;
  return {
    client: rt.client,
    unavailableReason: rt.unavailableReason,
    principal: rt.principal,
    probeClient,
    publicUrl,
    publicClient: (user) => {
      const password = user === SERVICE_USER ? svcPassword : probePassword;
      if (!publicUrl || !password) return null;
      return new RadicaleClient({ baseUrl: publicUrl, username: user, password, timeoutMs: PREFLIGHT_TIMEOUT_MS, retries: 0, userAgent: 'caldes-api-preflight' });
    },
    watch: () => currentWatchMode(),
    canary: () => lastCanaryResult(),
    controlPlane: () => {
      const cp = getCalendarControlPlane();
      return {
        status: cp ? cp.status() : null,
        sync: () => withTimeout(requestControlPlaneSync(), CONTROL_PLANE_SYNC_TIMEOUT_MS, null),
      };
    },
    now: () => new Date(),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); timer.unref(); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Controlli ───────────────────────────────

function check(code: PreflightCheckCode, status: PreflightCheckStatus, message: string, extra: Partial<Omit<PreflightCheck, 'code' | 'status' | 'message'>> = {}): PreflightCheck {
  const out: PreflightCheck = { code, status, message };
  if (extra.detail !== undefined) out.detail = extra.detail;
  if (extra.remedy !== undefined) out.remedy = extra.remedy;
  if (extra.declaration !== undefined) out.declaration = extra.declaration;
  if (extra.declared !== undefined) out.declared = extra.declared;
  return out;
}

/** Controllo `confirm` che diventa `pass` con la dichiarazione registrata (e, se indicata, ancora valida). */
function confirmOrDeclared(
  state: MigrationBackendState,
  code: PreflightCheckCode,
  key: DeclarationKey,
  pending: { message: string; detail?: Record<string, unknown>; remedy?: string | null },
  declaredMessage: (value: Record<string, unknown>) => string,
  opts: { validHours?: number; now: Date } ,
): PreflightCheck {
  const declaration = state.migration_declarations[key] as { value: Record<string, unknown>; at: string; by: string } | undefined;
  if (declaration && typeof declaration === 'object') {
    const at = new Date(declaration.at);
    const fresh = opts.validHours === undefined
      || (Number.isFinite(at.getTime()) && opts.now.getTime() - at.getTime() <= opts.validHours * 3_600_000 && at.getTime() <= opts.now.getTime() + 60_000);
    if (fresh) {
      return check(code, 'pass', declaredMessage(declaration.value ?? {}), {
        detail: { ...(pending.detail ?? {}), declared_at: declaration.at, declared_by: declaration.by },
        declaration: key,
        declared: true,
      });
    }
  }
  return check(code, 'confirm', pending.message, { detail: pending.detail, remedy: pending.remedy ?? null, declaration: key, declared: false });
}

/** Controlli che leggono solo il database (anche senza Radicale). */
async function databaseChecks(db: Db, state: MigrationBackendState, deps: Pick<PreflightDeps, 'principal' | 'now'>): Promise<PreflightCheck[]> {
  const now = deps.now();
  const out: PreflightCheck[] = [];

  out.push(state.mode === 'postgres'
    ? check('MODE_POSTGRES', 'pass', 'Postgres è autorevole (mode postgres): la migrazione non toglie autorità al database.', { detail: { mode: state.mode } })
    : check('MODE_POSTGRES', 'fail', `Mode ${state.mode}: lo strumento della F3 lavora solo in mode postgres.`, { detail: { mode: state.mode } }));

  const guardActive = state.restore_guard_until !== null && state.restore_guard_until.getTime() > now.getTime();
  out.push(guardActive || state.rebuild_required
    ? check('RESTORE_GUARD', 'warn', 'Guardia post-ripristino attiva o rebuild richiesto: le scritture dello strumento passano per la rivalidazione del ledger.', {
        detail: { restore_guard_until: state.restore_guard_until?.toISOString() ?? null, rebuild_required: state.rebuild_required },
      })
    : check('RESTORE_GUARD', 'pass', 'Nessuna guardia post-ripristino attiva.'));

  const apps = await inventoryAppPasswords(db, deps.principal);
  out.push(apps.reserved.length > 0
    ? check('RESERVED_APP_PASSWORDS', 'fail', `${apps.reserved.length} app-password attive con username riservato (caldes-*): vanno revocate dall'admin prima di procedere.`, {
        detail: { ids: apps.reserved.map((r) => r.id) },
        remedy: 'Impostazioni → Calendario → App-password: revoca le voci con username caldes-*.',
      })
    : check('RESERVED_APP_PASSWORDS', 'pass', 'Nessuna app-password attiva con username riservato.'));
  out.push(check('NON_CANONICAL_APP_PASSWORDS', 'pass',
    apps.non_canonical.length > 0
      ? `${apps.non_canonical.length} app-password con username diverso da ${deps.principal}: continuano a funzionare, mappate sul principal canonico.`
      : `Tutte le app-password attive usano lo username ${deps.principal}.`,
    { detail: { active: apps.active, non_canonical: apps.non_canonical.length } }));

  out.push(backupCheck(state, now));
  out.push(await subscriptionSyncCheck(db));
  out.push(confirmOrDeclared(state, 'PHASE0_VOLUME', 'phase0',
    { message: 'Serve una dichiarazione sul vecchio volume radicale_data della Fase 0 (decisione 7): assente, importato nell\'archivio, o presente e non importato.', remedy: 'Sull\'host: scripts/radicale-maint.sh phase0-detect.' },
    (v) => `Volume della Fase 0 dichiarato: ${String(v.status ?? 'sconosciuto')}.`,
    { now }));
  out.push(await dstCheck(db, now));
  return out;
}

function backupCheck(state: MigrationBackendState, now: Date): PreflightCheck {
  const backup = state.last_stack_backup;
  const detail: Record<string, unknown> = { last_stack_backup: backup ? { id: backup.id, at: backup.at, complete: backup.complete, volume_id: backup.volume_id, epoch: backup.epoch } : null };
  if (backup) {
    const at = new Date(backup.at);
    const ageMs = now.getTime() - at.getTime();
    const recent = Number.isFinite(ageMs) && ageMs >= -60_000 && ageMs <= MIGRATION_LIMITS.backupMaxAgeHours * 3_600_000;
    const sameVolume = state.epoch === 0
      || (typeof backup.volume_id === 'string' && backup.volume_id.toLowerCase() === state.volume_id && backup.epoch === state.epoch);
    if (backup.complete === true && recent && sameVolume) {
      return check('BACKUP_RECENT', 'pass', `Backup coordinato completo di ${Math.max(0, Math.round(ageMs / 60_000))} minuti fa.`, { detail });
    }
    detail.problems = [
      ...(backup.complete === true ? [] : ['incompleto']),
      ...(recent ? [] : ['più vecchio di 24 ore']),
      ...(sameVolume ? [] : ['identità del volume diversa']),
    ];
  }
  return confirmOrDeclared(state, 'BACKUP_RECENT', 'backup_verified',
    {
      message: 'Nessun backup coordinato (database e volume) completo, recente e del volume corrente: eseguilo o dichiara di averlo verificato (valido 24 ore).',
      detail,
      remedy: 'Sull\'host: scripts/backup-calendar-stack.sh',
    },
    () => 'Backup verificato a mano nelle ultime 24 ore.',
    { now, validHours: MIGRATION_LIMITS.backupDeclarationValidHours });
}

/**
 * Pull delle iscrizioni in corso: lock `cal-sync:<sidecar>` tenuto da un pull
 * verso l'indice, o un job di specchio delle iscrizioni in esecuzione. Il
 * pull legacy (cron ics-pull) non prende lock e non è osservabile da qui.
 */
async function subscriptionSyncCheck(db: Db): Promise<PreflightCheck> {
  const sidecars: Array<{ id: string }> = await db`
    SELECT c.id FROM calendar_subscriptions s JOIN calendars c ON c.id = s.collection_calendar_id
    WHERE c.role = 'subscription'
  `;
  let locked = 0;
  if (sidecars.length > 0) {
    const keys = sidecars.map((s) => CAL_LOCKS.collection(String(s.id)));
    const [row]: Array<{ n: number }> = await db`
      SELECT count(*)::int AS n
      FROM pg_locks l
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
        AND ((l.classid::bigint << 32) | l.objid::bigint) IN (SELECT hashtext(k)::bigint FROM unnest(${keys}::text[]) AS k)
    `;
    locked = row?.n ?? 0;
  }
  const [jobs]: Array<{ n: number }> = await db`
    SELECT count(*)::int AS n FROM cal_jobs WHERE kind = ${CAL_JOB_KINDS.subscriptionMirror} AND status = 'running'
  `;
  const running = jobs?.n ?? 0;
  return locked + running > 0
    ? check('SUBSCRIPTION_SYNC_IDLE', 'warn', 'Un pull o uno specchio delle iscrizioni è in corso: ripeti il preflight fra qualche minuto.', { detail: { pulls: locked, mirror_jobs: running } })
    : check('SUBSCRIPTION_SYNC_IDLE', 'pass', 'Nessun pull delle iscrizioni in corso.');
}

/** Eccezioni DST_SHIFTED_EXCEPTION ancora in PG, viste dal serializer (una sola implementazione del criterio). */
async function dstCheck(db: Db, now: Date): Promise<PreflightCheck> {
  try {
    const source = await loadLegacySource(db, { now });
    const result = serializeLegacy(source, { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] }, { now });
    // Il serializer riporta un'anomalia per serie, con il numero di eccezioni da riallineare (to_fix) e non riallineabili.
    const shifted = result.anomalies.filter((a) => a.code === 'DST_SHIFTED_EXCEPTION');
    if (shifted.length === 0) return check('DST_EXCEPTIONS', 'pass', 'Nessuna eccezione con lo spostamento DST precedente al fix.');
    const masters = new Set(shifted.map((a) => a.legacy_key ?? a.detail?.event_id).filter(Boolean));
    const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const exceptions = shifted.reduce((n, a) => n + count(a.detail?.to_fix) + count(a.detail?.not_fixable), 0) || shifted.length;
    return check('DST_EXCEPTIONS', 'warn', `${exceptions} eccezioni DST_SHIFTED_EXCEPTION ancora in PG (${masters.size} serie): il serializer le riallinea nella destinazione; in PG si correggono con calendar:fix-dst.`, {
      detail: { exceptions, series: masters.size },
      remedy: 'Nel container dell\'API: pnpm calendar:fix-dst (dry-run), poi -- --apply --expect-plan <impronta>.',
    });
  } catch (err) {
    log.warn({ err }, 'conteggio delle eccezioni DST non riuscito');
    return check('DST_EXCEPTIONS', 'warn', 'Conteggio delle eccezioni DST non riuscito: ripeti il preflight o esegui calendar:fix-dst in dry-run.', {
      detail: { error: describeRadicaleError(err) },
    });
  }
}

/** Collezione utente presente sul volume su cui provare i permessi del probe (la prima del piano con ruolo user). */
async function probeTargetCollection(db: Db, volume: VolumeRead): Promise<string | null> {
  const present = new Set(volume.collections.map((c) => c.name));
  const planned = await plannedCollections(db);
  const candidate = planned.find((p) => p.kind === 'calendar' && p.role === 'user' && present.has(p.collection_name))
    ?? planned.find((p) => p.kind === 'calendar' && present.has(p.collection_name));
  return candidate?.collection_name ?? null;
}

/** Nomi dei privilegi in `current-user-privilege-set` (null se la proprietà non è riportata). */
async function readPrivileges(client: RadicaleClient, path: string): Promise<string[] | null> {
  const ms = await client.propfind(path, { props: [CURRENT_USER_PRIVILEGE_SET], depth: 0, timeoutMs: PREFLIGHT_TIMEOUT_MS });
  const entry = ms.find(path) ?? ms.responses[0];
  const el = entry?.element(CURRENT_USER_PRIVILEGE_SET);
  if (!el) return null;
  return el.children
    .filter((c) => c.ns === NS.DAV && c.name === 'privilege')
    .flatMap((p) => p.children.map((c) => c.name));
}

function publicRemedy(publicUrl: string | null): string {
  const url = (publicUrl ?? 'https://dav.calicchia.design').replace(/\/+$/, '');
  return [
    `curl -s -o /dev/null -w '%{http_code}\\n' -X PROPFIND -H 'Depth: 0' -u ${SERVICE_USER} ${url}/`,
    `curl -s -o /dev/null -w '%{http_code}\\n' -X PROPFIND -H 'Depth: 0' -u ${PROBE_USER} ${url}/`,
    'Lanciali sull\'host (curl chiede la password): entrambi devono rispondere 401.',
  ].join('\n');
}

/** Login di caldes-svc e caldes-probe sull'URL pubblico: devono ricevere 401 (design §13.3, gate del servizio). */
async function publicCheck(state: MigrationBackendState, deps: PreflightDeps, params: PreflightParams | undefined): Promise<PreflightCheck> {
  const now = deps.now();
  const remedy = publicRemedy(deps.publicUrl);
  const pending = (message: string, detail: Record<string, unknown>) => confirmOrDeclared(state, 'SERVICE_PUBLIC_401', 'public_401_verified',
    { message, detail, remedy },
    (v) => `401 sull'URL pubblico verificato a mano (${String(v.method ?? 'metodo non indicato')}).`,
    { now });
  if (!deps.publicUrl) return pending('RADICALE_PUBLIC_URL non impostata: verifica dall\'host che caldes-svc e caldes-probe ricevano 401 sull\'URL pubblico.', { public_url: null });
  if (params?.probe_public_url === false) return pending('Prova dell\'URL pubblico non richiesta: verifica dall\'host e registra la dichiarazione.', { public_url: deps.publicUrl, probed: false });

  const results: Record<string, number | string> = {};
  let unreachable = false;
  for (const user of [SERVICE_USER, PROBE_USER] as const) {
    const client = deps.publicClient(user);
    if (!client) {
      results[user] = 'password non disponibile';
      unreachable = true;
      continue;
    }
    try {
      await client.propfind('/', { props: [{ ns: NS.DAV, name: 'resourcetype' }], depth: 0, timeoutMs: PREFLIGHT_TIMEOUT_MS });
      results[user] = 207;
    } catch (err) {
      const e = err as RadicaleError;
      if (isRadicaleError(err) && e.status) results[user] = e.status;
      else {
        results[user] = describeRadicaleError(err);
        unreachable = true;
      }
    } finally {
      client.close();
    }
  }
  const statuses = Object.values(results);
  if (statuses.every((s) => s === 401)) {
    return check('SERVICE_PUBLIC_401', 'pass', 'caldes-svc e caldes-probe ricevono 401 sull\'URL pubblico.', { detail: { public_url: deps.publicUrl, results } });
  }
  const accepted = statuses.some((s) => typeof s === 'number' && ((s >= 200 && s < 300) || s === 403));
  if (accepted) {
    return check('SERVICE_PUBLIC_401', 'fail', 'Un utente di servizio è accettato dall\'URL pubblico: CALDES_SVC_CIDR o il proxy espongono il peer interno. Correggi prima di procedere.', {
      detail: { public_url: deps.publicUrl, results },
      remedy,
    });
  }
  return pending(unreachable
    ? 'URL pubblico non raggiungibile dal container (hairpin?): verifica dall\'host che caldes-svc e caldes-probe ricevano 401.'
    : 'Risposta inattesa dall\'URL pubblico: verifica dall\'host che caldes-svc e caldes-probe ricevano 401.', { public_url: deps.publicUrl, results });
}

/** Esito di tutti i controlli (senza scrivere righe). */
export async function collectPreflight(db: Db, deps: PreflightDeps, params?: PreflightParams): Promise<PreflightSummary> {
  const state = await readMigrationStateFresh(db);
  const checks: PreflightCheck[] = [];
  const dbChecks = await databaseChecks(db, state, deps);
  const byCode = new Map(dbChecks.map((c) => [c.code, c]));
  const take = (code: PreflightCheckCode) => byCode.get(code) as PreflightCheck;

  const watch = deps.watch();
  const summary: Omit<PreflightSummary, 'checks' | 'blocking' | 'ready'> = {
    identity: state.epoch === 0 ? 'uninitialized' : 'unverified',
    can_initialize: false,
    missing_collections: [],
    radicale: { configured: deps.client !== null, reachable: null, version: null },
    watch_mode: watch.mode,
  };

  checks.push(take('MODE_POSTGRES'), take('RESTORE_GUARD'));

  const client = deps.client;
  if (!client) {
    checks.push(check('RADICALE_CONFIGURED', 'fail', `Radicale non configurato: ${deps.unavailableReason ?? 'RADICALE_URL o la password di caldes-svc assenti'}.`, {
      remedy: 'Imposta RADICALE_URL e RADICALE_SVC_PASSWORD nel container dell\'API.',
    }));
    for (const code of ['RADICALE_REACHABLE', 'RADICALE_VERSION', 'SERVICE_LOGIN', 'IDENTITY', 'COLLECTIONS', 'CANARY_COLLECTION', 'PROBE_READONLY', 'PROBE_CANARY_FORBIDDEN', 'VOLUME_WATCH', 'CONTROL_PLANE', 'SERVICE_PUBLIC_401'] as const) {
      checks.push(check(code, 'skip', 'Non verificabile senza Radicale configurato.'));
    }
  } else {
    checks.push(check('RADICALE_CONFIGURED', 'pass', `Client di servizio configurato (${client.username}).`, { detail: { base_url: client.baseUrl } }));
    await radicaleChecks(db, state, deps, client, checks, summary, params);
  }

  checks.push(
    take('RESERVED_APP_PASSWORDS'),
    take('NON_CANONICAL_APP_PASSWORDS'),
    take('BACKUP_RECENT'),
    take('SUBSCRIPTION_SYNC_IDLE'),
    take('PHASE0_VOLUME'),
    take('DST_EXCEPTIONS'),
  );

  const order = new Map(PREFLIGHT_ORDER.map((c, i) => [c, i]));
  checks.sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99));
  const blocking = checks.filter((c) => c.status === 'fail' || c.status === 'confirm').map((c) => c.code);
  return { checks, blocking, ready: blocking.length === 0, ...summary };
}

const PREFLIGHT_ORDER: readonly PreflightCheckCode[] = [
  'MODE_POSTGRES', 'RESTORE_GUARD', 'RADICALE_CONFIGURED', 'RADICALE_REACHABLE', 'RADICALE_VERSION', 'SERVICE_LOGIN',
  'IDENTITY', 'COLLECTIONS', 'CANARY_COLLECTION', 'PROBE_READONLY', 'PROBE_CANARY_FORBIDDEN', 'VOLUME_WATCH',
  'CONTROL_PLANE', 'SERVICE_PUBLIC_401', 'RESERVED_APP_PASSWORDS', 'NON_CANONICAL_APP_PASSWORDS', 'BACKUP_RECENT',
  'SUBSCRIPTION_SYNC_IDLE', 'PHASE0_VOLUME', 'DST_EXCEPTIONS',
];

async function radicaleChecks(
  db: Db,
  state: MigrationBackendState,
  deps: PreflightDeps,
  client: RadicaleClient,
  checks: PreflightCheck[],
  summary: Omit<PreflightSummary, 'checks' | 'blocking' | 'ready'>,
  params: PreflightParams | undefined,
): Promise<void> {
  const { principal } = deps;
  const now = deps.now();

  // Raggiungibilità, login di servizio e versione: una PROPFIND della root.
  let reachable = false;
  let loginOk = false;
  try {
    const ms = await client.propfind('/', { props: [RADICALE_VERSION_PROP, { ns: NS.DAV, name: 'current-user-principal' }], depth: 0, timeoutMs: PREFLIGHT_TIMEOUT_MS });
    reachable = true;
    loginOk = true;
    const version = ms.responses[0]?.text(RADICALE_VERSION_PROP)?.trim() || null;
    summary.radicale.version = version;
    checks.push(check('RADICALE_REACHABLE', 'pass', 'Radicale risponde sulla rete interna.'));
    checks.push(check('SERVICE_LOGIN', 'pass', `${client.username} si autentica sulla rete interna.`));
    checks.push(version === EXPECTED_RADICALE_VERSION
      ? check('RADICALE_VERSION', 'pass', `Radicale ${version}.`, { detail: { version } })
      : check('RADICALE_VERSION', 'warn', version
          ? `Radicale ${version}: l'immagine pinnata è la ${EXPECTED_RADICALE_VERSION}.`
          : `Versione di Radicale non verificabile (attesa ${EXPECTED_RADICALE_VERSION}, garantita dall'immagine pinnata per digest).`, { detail: { version, expected: EXPECTED_RADICALE_VERSION } }));
  } catch (err) {
    const e = err as RadicaleError;
    if (isRadicaleError(err) && (e.code === 'unauthorized' || e.code === 'forbidden')) {
      reachable = true;
      checks.push(check('RADICALE_REACHABLE', 'pass', 'Radicale risponde sulla rete interna.'));
      checks.push(check('SERVICE_LOGIN', 'fail', e.code === 'unauthorized'
        ? `${client.username} non si autentica (401): password o rete interna (CALDES_SVC_CIDR) da verificare.`
        : `${client.username} è autenticato ma senza lettura della root (403): plugin dei permessi da verificare.`, { detail: { status: e.status } }));
      checks.push(check('RADICALE_VERSION', 'skip', 'Non verificabile senza il login di servizio.'));
    } else {
      checks.push(check('RADICALE_REACHABLE', 'fail', `Radicale non raggiungibile: ${describeRadicaleError(err)}.`, { detail: { error: describeRadicaleError(err) } }));
      checks.push(check('SERVICE_LOGIN', 'skip', 'Non verificabile: Radicale non raggiungibile.'));
      checks.push(check('RADICALE_VERSION', 'skip', 'Non verificabile: Radicale non raggiungibile.'));
    }
  }
  summary.radicale.reachable = reachable;

  // Identità e collezioni del volume.
  let volume: VolumeRead | null = null;
  let identity: IdentityStatus = state.epoch === 0 ? 'uninitialized' : 'unverified';
  if (loginOk) {
    try {
      volume = await readVolumeCollections(client, principal, { timeoutMs: PREFLIGHT_TIMEOUT_MS });
      identity = identityStatus(state, volume.marker);
    } catch (err) {
      checks.push(check('IDENTITY', 'fail', `Marker del volume non leggibile: ${describeRadicaleError(err)}.`, { detail: identityDetail(state, null, null) }));
    }
  } else {
    checks.push(check('IDENTITY', 'skip', 'Non verificabile senza il login di servizio.'));
  }
  summary.identity = identity;

  if (volume) {
    const detail = identityDetail(state, volume.marker, volume.principal_exists);
    if (identity === 'ok') {
      checks.push(check('IDENTITY', 'pass', `Identità del volume verificata (volume ${state.volume_id}, epoch ${state.epoch}).`, { detail }));
    } else if (state.epoch === 0 && !volume.principal_exists && state.mode === 'postgres') {
      summary.can_initialize = true;
      checks.push(check('IDENTITY', 'pass', 'Volume vuoto e stato non inizializzato: si può inizializzare Radicale.', { detail: { ...detail, can_initialize: true } }));
    } else {
      checks.push(check('IDENTITY', 'fail', identityExplanation(state, volume), {
        detail,
        remedy: 'Passo 1 → Verifica identità: confronta PG e volume e, solo se il volume è quello giusto, conferma la riassegnazione.',
      }));
    }
  }

  // Collezioni del piano e _canary (solo con l'identità verificata).
  if (volume && identity === 'ok') {
    const planned = await plannedCollections(db);
    const present = new Map(volume.collections.map((c) => [c.name, c]));
    const missing: string[] = [];
    const conflicts: Array<{ collection_name: string; calendar_id_prop: string | null }> = [];
    for (const p of planned) {
      if (p.kind === 'system') continue;
      const found = present.get(p.collection_name);
      if (!found) missing.push(p.collection_name);
      else if (p.calendar_id && (found.calendar_id_prop ?? '').toLowerCase() !== p.calendar_id.toLowerCase()) {
        conflicts.push({ collection_name: p.collection_name, calendar_id_prop: found.calendar_id_prop });
      }
    }
    summary.missing_collections = missing;
    checks.push(missing.length === 0 && conflicts.length === 0
      ? check('COLLECTIONS', 'pass', `Tutte le ${planned.filter((p) => p.kind !== 'system').length} collezioni del piano esistono.`, { detail: { planned: planned.filter((p) => p.kind !== 'system').map((p) => p.collection_name) } })
      : check('COLLECTIONS', 'warn', [
          missing.length ? `Collezioni mancanti: ${missing.join(', ')} (azione "Crea collezioni mancanti").` : '',
          conflicts.length ? `Collezioni con un'altra calendar-id (non toccate): ${conflicts.map((c) => c.collection_name).join(', ')}.` : '',
        ].filter(Boolean).join(' '), { detail: { missing, conflicts } }));
    const canaryPresent = present.has(CANARY_COLLECTION);
    checks.push(canaryPresent
      ? check('CANARY_COLLECTION', 'pass', `Collezione ${CANARY_COLLECTION} presente.`)
      : check('CANARY_COLLECTION', 'warn', `Collezione ${CANARY_COLLECTION} assente: la crea l'inizializzazione ("Crea collezioni mancanti").`));
    if (!canaryPresent) summary.missing_collections = [...missing, CANARY_COLLECTION];

    await probeChecks(db, deps, client, volume, canaryPresent, checks);
  } else {
    checks.push(check('COLLECTIONS', 'skip', 'Prima dell\'inizializzazione (o con l\'identità non verificata).'));
    checks.push(check('CANARY_COLLECTION', 'skip', 'Prima dell\'inizializzazione (o con l\'identità non verificata).'));
    checks.push(check('PROBE_READONLY', 'skip', 'Dopo l\'inizializzazione: con l\'identità non verificata il gate nega già tutto ai device.'));
    checks.push(check('PROBE_CANARY_FORBIDDEN', 'skip', 'Dopo l\'inizializzazione.'));
  }

  // Campanello: mount con canary e statfs superati, oppure remote mode dichiarata.
  const watch = deps.watch();
  const canary = deps.canary();
  if (watch.mode === 'mount' && canary?.ok && canary.fsLocal !== false) {
    checks.push(check('VOLUME_WATCH', 'pass', `Campanello in mount: canary e statfs superati${canary.fsType ? ` (${canary.fsType})` : ''}.`, {
      detail: { mode: watch.mode, fs_type: canary.fsType, mtime_lag_ms: canary.mtimeLagMs },
    }));
  } else {
    checks.push(confirmOrDeclared(state, 'VOLUME_WATCH', 'remote_mode_accepted',
      {
        message: `Campanello in ${watch.mode}${watch.reason ? ` (${watch.reason})` : ''}${canary && !canary.ok ? `, canary non superato (${canary.reason})` : ''}: accetta esplicitamente la remote mode o correggi il mount.`,
        detail: { mode: watch.mode, reason: watch.reason, canary: canary ? { ok: canary.ok, reason: canary.reason, fs_type: canary.fsType } : null },
      },
      (v) => `Remote mode accettata: ${String(v.reason ?? '')}`.trim(),
      { now }));
  }

  // Control-plane: policy e heartbeat scrivibili adesso.
  const cp = deps.controlPlane();
  if (!cp.status || !cp.status.running) {
    checks.push(check('CONTROL_PLANE', 'fail', 'Control-plane del calendario non attivo: policy.json e heartbeat.json non vengono scritti.', {
      remedy: 'Verifica il volume caldes_control montato nell\'API e CALDES_CONTROL_PLANE.',
    }));
  } else {
    const tick = await cp.sync().catch(() => null);
    if (tick && tick.ok) {
      checks.push(check('CONTROL_PLANE', 'pass', `Policy e heartbeat scritti (policy ${tick.policy?.mode ?? 'sconosciuta'}).`, {
        detail: { policy_mode: tick.policy?.mode ?? null, policy_version: tick.policy?.version ?? null, heartbeat: tick.heartbeat?.ts ?? null },
      }));
    } else {
      checks.push(check('CONTROL_PLANE', 'fail', tick
        ? `Giro del control-plane fallito (${tick.failedStage ?? 'sconosciuto'}): ${tick.error ?? ''}`.trim()
        : 'Giro del control-plane non concluso in tempo.', { detail: { failed_stage: tick?.failedStage ?? null, consecutive_failures: cp.status.consecutiveFailures } }));
    }
  }

  checks.push(await publicCheck(state, deps, params));
}

function identityDetail(state: MigrationBackendState, marker: VolumeMarker | null, principalExists: boolean | null): Record<string, unknown> {
  return {
    pg: { mode: state.mode, volume_id: state.volume_id, epoch: state.epoch },
    volume: { principal_exists: principalExists, marker },
  };
}

/** Spiegazione per il wizard di un'identità diversa (design §13.3). */
export function identityExplanation(state: Pick<MigrationBackendState, 'volume_id' | 'epoch' | 'mode'>, volume: Pick<VolumeRead, 'principal_exists' | 'marker' | 'collections'>): string {
  if (state.epoch === 0) {
    if (!volume.principal_exists) return 'Volume vuoto e stato non inizializzato: si può inizializzare Radicale.';
    if (volume.marker) {
      return `Il database non registra alcun volume ma il volume ha il marker ${volume.marker.volume_id} (epoch ${volume.marker.epoch}): il database è stato ripristinato a prima dell'inizializzazione, oppure l'inizializzazione si è interrotta fra il marker e l'aggiornamento dello stato. Se il volume è quello giusto, riassegna l'identità dal volume al database.`;
    }
    return `Il volume non è vuoto (principal presente${volume.collections.length ? ` con ${volume.collections.length} collezioni` : ''}) ma non ha un marker: è il volume della Fase 0, di un altro stack o creato a mano. Non viene mai inizializzato né adottato in automatico.`;
  }
  if (!volume.principal_exists) {
    return `Il database registra il volume ${state.volume_id} (epoch ${state.epoch}) ma su Radicale il principal non c'è: volume sostituito o perso. Ripristina il volume dal backup coordinato oppure riassegna l'identità del database a questo volume (diventerà il volume registrato; il ledger andrà rivalidato).`;
  }
  if (!volume.marker) {
    return `Il database registra il volume ${state.volume_id} (epoch ${state.epoch}) ma il volume non ha un marker: è un volume di un altro stack, della Fase 0 o creato a mano. Se è quello giusto, riassegna l'identità del database al volume.`;
  }
  return `Il volume ha il marker ${volume.marker.volume_id} (epoch ${volume.marker.epoch}) ma il database registra ${state.volume_id} (epoch ${state.epoch}): volume di un altro stack o ripristinato da uno snapshot di un altro momento. Ripristina il backup coordinato giusto oppure, solo se il volume è quello corretto, riassegna l'identità.`;
}

async function probeChecks(db: Db, deps: PreflightDeps, client: RadicaleClient, volume: VolumeRead, canaryPresent: boolean, checks: PreflightCheck[]): Promise<void> {
  const probe = deps.probeClient;
  if (!probe) {
    const remedy = 'Imposta RADICALE_PROBE_PASSWORD nel container dell\'API (la CALDES_PROBE_PASSWORD dell\'healthcheck di Radicale).';
    checks.push(check('PROBE_READONLY', 'fail', 'Password di caldes-probe non disponibile nell\'API: il gate dei device non è verificabile.', { remedy }));
    checks.push(check('PROBE_CANARY_FORBIDDEN', 'fail', 'Password di caldes-probe non disponibile nell\'API: il gate dei device non è verificabile.', { remedy }));
    return;
  }

  // Sola lettura su una collezione utente in shadow: current-user-privilege-set come caldes-probe.
  const target = await probeTargetCollection(db, volume);
  if (!target) {
    checks.push(check('PROBE_READONLY', 'skip', 'Nessuna collezione del piano presente sul volume su cui provare il probe.'));
  } else {
    const path = collectionPath(deps.principal, target);
    try {
      const privileges = await readPrivileges(probe, path);
      if (privileges === null) {
        checks.push(check('PROBE_READONLY', 'warn', `Privilegi di ${PROBE_USER} su ${target} non riportati da Radicale.`, { detail: { collection: target } }));
      } else {
        const writes = privileges.filter((p) => WRITE_PRIVILEGES.has(p));
        checks.push(writes.length === 0
          ? check('PROBE_READONLY', 'pass', `${PROBE_USER} ha solo la lettura su ${target}.`, { detail: { collection: target, privileges } })
          : check('PROBE_READONLY', 'fail', `${PROBE_USER} può scrivere su ${target} (${writes.join(', ')}): i device non sono in sola lettura.`, {
              detail: { collection: target, privileges },
              remedy: 'Controlla policy.json (mode shadow) e il plugin caldes_rights prima di procedere.',
            }));
      }
    } catch (err) {
      const e = err as RadicaleError;
      checks.push(isRadicaleError(err) && e.code === 'forbidden'
        ? check('PROBE_READONLY', 'warn', `${PROBE_USER} non vede ${target} (403): nessuna scrittura, ma nemmeno la lettura attesa in shadow.`, { detail: { collection: target, status: 403 } })
        : check('PROBE_READONLY', 'fail', `Permessi di ${PROBE_USER} non verificabili: ${describeRadicaleError(err)}.`, { detail: { collection: target, error: describeRadicaleError(err) } }));
    }
  }

  // PUT del probe su _canary: deve ricevere 403.
  if (!canaryPresent) {
    checks.push(check('PROBE_CANARY_FORBIDDEN', 'skip', `${CANARY_COLLECTION} assente: la prova si fa dopo "Crea collezioni mancanti".`));
    return;
  }
  const name = `preflight-${randomUUID()}.ics`;
  const path = objectPath(deps.principal, CANARY_COLLECTION, name);
  const body = probeIcs(name, deps.now());
  try {
    const put = await probe.put(path, body, { ifNoneMatch: '*' }, { timeoutMs: PREFLIGHT_TIMEOUT_MS });
    // Il gate è aperto: si rimuove subito la risorsa come caldes-svc.
    try {
      if (put.etag) await client.delete(path, { ifMatch: put.etag });
    } catch (err) {
      log.warn({ err, name }, 'rimozione della risorsa del probe su _canary non riuscita');
    }
    checks.push(check('PROBE_CANARY_FORBIDDEN', 'fail', `${PROBE_USER} ha scritto su ${CANARY_COLLECTION}: il gate dei device è aperto (atteso 403).`, {
      detail: { status: put.created ? 201 : 204 },
      remedy: 'Controlla policy.json (mode shadow) e il plugin caldes_rights prima di procedere.',
    }));
  } catch (err) {
    const e = err as RadicaleError;
    checks.push(isRadicaleError(err) && e.status === 403
      ? check('PROBE_CANARY_FORBIDDEN', 'pass', `La PUT di ${PROBE_USER} su ${CANARY_COLLECTION} riceve 403.`, { detail: { status: 403 } })
      : check('PROBE_CANARY_FORBIDDEN', 'fail', `Risposta inattesa alla PUT di ${PROBE_USER} su ${CANARY_COLLECTION}: ${describeRadicaleError(err)} (atteso 403).`, {
          detail: { status: isRadicaleError(err) ? e.status ?? null : null, error: describeRadicaleError(err) },
        }));
  }
}

function probeIcs(name: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Caldes//calendar-migration-preflight//IT',
    'BEGIN:VEVENT',
    `UID:${name.replace(/\.ics$/, '')}@caldes.it`,
    `DTSTAMP:${stamp}`,
    'DTSTART:20000101T000000Z',
    'DTEND:20000101T000100Z',
    'SUMMARY:caldes preflight',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

// ─── Righe del run ───────────────────────────────

function severityOf(status: PreflightCheckStatus): MigrationItemInput['severity'] {
  if (status === 'fail') return 'error';
  if (status === 'warn' || status === 'confirm') return 'warning';
  return 'info';
}

/** Righe `check` di un run di preflight (una per controllo, nell'ordine del contratto). */
export function preflightItems(checks: readonly PreflightCheck[]): MigrationItemInput[] {
  return checks.map((c) => ({
    item_type: 'check' as const,
    code: c.code,
    severity: severityOf(c.status),
    detail: {
      status: c.status,
      message: c.message,
      ...(c.detail !== undefined ? { detail: c.detail } : {}),
      ...(c.remedy ? { remedy: c.remedy } : {}),
      ...(c.declaration ? { declaration: c.declaration } : {}),
      ...(c.declared !== undefined ? { declared: c.declared } : {}),
    },
  }));
}

// ─── Run ───────────────────────────────

/** Controlli del design §13.3 (codici PREFLIGHT_CHECK_CODES, §6.1.1). In sola lettura salvo la PUT del probe su _canary. */
export async function runPreflight(ctx: MigrationRunContext<PreflightParams>): Promise<PreflightSummary> {
  return runPreflightWith(ctx, defaultPreflightDeps());
}

/** runPreflight con dipendenze esplicite (test, strumenti). Chiude i client creati per il probe. */
export async function runPreflightWith(ctx: MigrationRunContext<PreflightParams>, deps: PreflightDeps): Promise<PreflightSummary> {
  ctx.throwIfCancelled();
  await ctx.progress({ phase: 'checks', message: 'Controlli del preflight' });
  try {
    const summary = await collectPreflight(ctx.db, deps, ctx.params);
    ctx.throwIfCancelled();
    await ctx.addItems(preflightItems(summary.checks));
    await ctx.progress({ phase: 'done', done: summary.checks.length, total: summary.checks.length, message: summary.ready ? 'Preflight superato' : `Preflight con ${summary.blocking.length} blocchi` });
    ctx.log.info({ ready: summary.ready, blocking: summary.blocking, identity: summary.identity }, 'preflight della migrazione concluso');
    return summary;
  } finally {
    deps.probeClient?.close();
  }
}

/** Preflight senza Radicale configurato: RADICALE_CONFIGURED fallito, gli altri controlli di database sì. */
export async function preflightWithoutRadicale(db: Db): Promise<PreflightSummary> {
  const rt = radicaleRuntime();
  const deps: PreflightDeps = {
    client: null,
    unavailableReason: rt.unavailableReason,
    principal: rt.principal,
    probeClient: null,
    publicUrl: null,
    publicClient: () => null,
    watch: () => currentWatchMode(),
    canary: () => null,
    controlPlane: () => ({ status: null, sync: async () => null }),
    now: () => new Date(),
  };
  return collectPreflight(db, deps);
}

/** Identità ridotta per il controllo IDENTITY e per il wizard. */
export function reducedIdentityView(view: IdentityDiffView): Record<string, unknown> {
  return { status: view.status, pg: view.pg, marker: view.volume.marker, principal_exists: view.volume.principal_exists, allowed: view.allowed };
}
