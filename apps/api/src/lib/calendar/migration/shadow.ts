/**
 * Shadow mirror PG → Radicale, parità osservata, iscrizioni per singolo flag
 * e riconciliazione delle proiezioni (fase F3 del piano; design §13.8, §6.6,
 * §16.2; decisioni 3 e 5; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §6.4 e §9).
 *
 * Postgres resta autorevole: lo shadow porta su Radicale ogni scrittura
 * legacy mentre i device leggono in sola lettura (policy `shadow`), senza mai
 * stare nel percorso critico delle scritture legacy.
 *
 * Accodamento (outbox): i trigger della migrazione 165 su calendar_events e
 * calendar_bookings accodano `shadow_mirror(<chiave>)` in cal_jobs nella
 * STESSA transazione della scrittura legacy, solo con mode postgres, shadow
 * acceso e volume registrato (chiavi `event:<master>` e `booking:<uid>`,
 * coalescenza sui pending, debounce di 2 s). Così ogni scrittore legacy è
 * coperto, anche quelli che non passano dalla facade, e la scrittura legacy
 * non aspetta mai Radicale (precisazione 1 del contratto).
 *
 * Handler (§9.2): stato riletto (mode ≠ postgres, o shadow spento senza
 * `payload.erasure` → chiuso senza azione); lock `cal-migration` con try
 * (occupato da un run → errore d'attesa, il job si riaccoda); identità del
 * volume letta da Radicale (diversa → errore d'attesa, dead letter dopo
 * 48 h); piano `shadow` per la sola chiave con le opzioni dell'ultima
 * anteprima riuscita; esecuzione item per item con il protocollo delle righe
 * d'intento di apply.ts (unico scrittore del ledger). Un oggetto assente si
 * scrive per intero dal piano (sicuro: i device sono in sola lettura); un
 * oggetto presente riceve la patch per campo fra legacy_snapshot e righe
 * correnti, con If-Match dell'ETag appena letto, così VALARM, ATTENDEE e X-*
 * aggiunti dopo restano (su 412 si rilegge e si riprova una volta, poi
 * conflitto). L'handler non restituisce currentSourceVersion: una scrittura
 * legacy durante il job produce un nuovo pending che girerà dopo.
 *
 * Cadenza: all'attivazione apply completo di recupero (trigger 'shadow');
 * ogni notte apply completo con verifica V1-V5 di tutti i calendari
 * (runShadowNightly, che con un run in corso riprova invece di saltare il
 * giorno); ogni ora V4 sui prossimi 14 giorni (runShadowHourlyParity, mai a
 * ridosso del notturno). La parità (getParity) è quella che il wizard mostra
 * al passo 5: almeno 7 giorni di giri verdi con un giro notturno verde, cioè
 * una verifica completa e accettabile, per ogni giorno di calendario di Roma.
 *
 * Proiezioni: chiave `booking:<uid>`, contenuto da calendar_bookings con
 * buildBookingProjectionIcs (decisione 3), patch sui soli campi della
 * proiezione. Iscrizioni: mai copiate dallo shadow; flag per singola
 * iscrizione (decisione 5) con il sidecar invisibile al legacy.
 *
 * Mai dati personali nei log, nei risultati dei job e negli avvisi: solo
 * chiavi, href, codici e conteggi.
 */

import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { storeKindForMode, storeKindOverride } from '../backend-mode';
import { CalendarUnavailableError } from '../errors';
import { CAL_JOB_DEFAULTS, type CalendarJob, CalendarJobPermanentError, registerCalendarJobHandler } from '../jobs';
import { collectionPath } from '../radicale/client';
import { DAV_PROPS } from '../radicale/dav-xml';
import { isRadicaleError } from '../radicale/errors';
import { raiseIndexAlert } from '../radicale/health';
import type { Db } from '../radicale/policy';
import { PROJECTED_BOOKING_STATUSES } from '../radicale/booking-projection';
import { radicaleRuntime } from '../radicale/sync';
import { requestSubscriptionMirror } from '../subscriptions/mirror';
import { enableSubscriptionIndex, pullSubscriptionToIndex } from '../subscriptions/pull';
import { type ExecuteContext, type ExecutedItem, executePlanItem, migrationThrottle } from './apply';
import { computeSubscriptionImpacts } from './inventory';
import { buildPlan } from './plan';
import { assertMigrationWritable, preconditionError, readMigrationStateFresh, requireRadicale } from './preflight';
import { latestVerifyVerdicts } from './report';
import type * as RunsModule from './runs';
import {
  type ApplyOutcome,
  type ApplyParams,
  type ApplySummary,
  DEFAULT_MIGRATION_OPTIONS,
  isMigrationError,
  type LegacyKey,
  type MigrationBackendState,
  MIGRATION_LIMITS,
  MigrationError,
  type MigrationOptions,
  type MigrationRunTrigger,
  type MigrationRunView,
  type MigrationScope,
  type ParityView,
  parseLegacyKey,
  type PlanItem,
  type PreconditionReason,
  resolveMigrationOptions,
  type RunCreatedResponse,
  SHADOW_MIRROR_JOB_KIND,
  type ShadowStateResponse,
  type SubscriptionFlagsRequest,
  type SubscriptionFlagsResponse,
  type SubscriptionMigrationView,
  VERIFY_LEVELS,
  type VerifyColor,
  type VerifyParams,
  type VerifySummary,
} from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-migration-shadow' });

// ─── Costanti ───────────────────────────────

/** Attore dello shadow nel ledger, nei log e nei run programmati. */
export const SHADOW_ACTOR = 'system:shadow';

/** Lease del job shadow_mirror: un piano per chiave e poche scritture. */
export const SHADOW_JOB_LEASE_MS = CAL_JOB_DEFAULTS.leaseMs;

/** Codice dell'avviso di un conflitto dello shadow (raiseIndexAlert). */
export const SHADOW_CONFLICT_ALERT = 'shadow-conflict';

/** Giri programmati elencati in ParityView.recent. */
const PARITY_RECENT_LIMIT = 30;

/** Ora (locale del server, come runAtHour del cron) del giro notturno: cron/index.ts la usa per calendar-shadow-nightly. */
export const SHADOW_NIGHTLY_HOUR = 3;

/** Giro notturno saltato per un run in corso: nuovo tentativo ogni 10 minuti per al più 3 ore. */
export const SHADOW_NIGHTLY_RETRY_MS = 10 * 60_000;
export const SHADOW_NIGHTLY_RETRY_WINDOW_MS = 3 * 3_600_000;

/**
 * Il giro orario non parte fra 5 minuti prima e 15 minuti dopo l'ora del giro
 * notturno: una verifica V4 in corso alle 03:00 farebbe saltare il notturno.
 */
const HOURLY_QUIET_BEFORE_MIN = 5;
const HOURLY_QUIET_AFTER_MIN = 15;

/** Giorni di calendario della parità: Europe/Rome (un giro notturno verde per giorno). */
const PARITY_TIME_ZONE = 'Europe/Rome';
const PARITY_DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: PARITY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Esiti di una scrittura riuscita (anche senza scrivere): sbloccano la delete di uno spostamento. */
const SOURCE_SETTLED: ReadonlySet<ApplyOutcome> = new Set<ApplyOutcome>(['done', 'adopted', 'noop', 'forced']);

// ─── Tipi ───────────────────────────────

/** Esito di un item nel risultato del job (cal_jobs.result.items). */
export interface ShadowItemResult {
  legacy_key: string;
  calendar_id: string;
  href: string;
  action: PlanItem['action'];
  outcome: ApplyOutcome | 'skipped';
  code: string | null;
  fields: string[];
  /** Solo per gli item non eseguiti dallo shadow (spento, fuori ambito, spostamento non riuscito). */
  reason?: string;
}

export interface ShadowJobResult {
  legacy_key: string;
  erasure: boolean;
  items: ShadowItemResult[];
  conflicts: number;
  /** Motivo per cui il job si è chiuso senza azione. */
  skipped?: string;
}

/** Anteprima di riferimento dello shadow: opzioni, ambito e run. */
interface ReferencePlan {
  runId: string | null;
  options: MigrationOptions;
  scope: MigrationScope;
}

/**
 * runs.ts (ROUTES) con un import differito: runs.ts importa questo modulo
 * (getParity per lo stato del wizard) e un import statico creerebbe un ciclo
 * fra i due moduli. Staticamente si importano solo i tipi (cancellati in
 * esecuzione), così le firme restano verificate dal compilatore.
 */
async function runs(): Promise<typeof RunsModule> {
  const specifier = './runs';
  return (await import(specifier)) as typeof RunsModule;
}

/** createMigrationRun di runs.ts (MIGRATION_BUSY con un run attivo, contratto §5.2). */
async function createRun(input: RunsModule.CreateRunInput): Promise<RunCreatedResponse> {
  return (await runs()).createMigrationRun(input);
}

// ─── Lock dello strumento ───────────────────────────────

/**
 * Il lock cal-migration è tenuto da un run in esecuzione: errore d'attesa
 * (CalendarUnavailableError('transition')), il job shadow_mirror si riaccoda
 * senza consumare tentativi (contratto §5.3, §9.2 passo 2).
 */
export class ShadowLockBusyError extends CalendarUnavailableError {
  constructor(options?: { cause?: unknown }) {
    super('transition', 'run di migrazione in corso: shadow mirror rimandato', options);
    this.name = 'ShadowLockBusyError';
  }
}

/**
 * withMigrationLock(…, { wait: false }) di runs.ts (contratto §9.2): un solo
 * tentativo di prendere `cal-migration` su una connessione riservata del pool
 * principale, la stessa chiave dell'esecutore dei run e di apply.ts. Lock
 * occupato (MIGRATION_BUSY prima di entrare in `fn`) → ShadowLockBusyError.
 * Gli errori di `fn` passano invariati.
 */
export async function withShadowMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
  const { withMigrationLock } = await runs();
  let entered = false;
  try {
    return await withMigrationLock(async () => {
      entered = true;
      return fn();
    }, { wait: false });
  } catch (err) {
    if (!entered && isMigrationError(err) && err.code === 'MIGRATION_BUSY') throw new ShadowLockBusyError({ cause: err });
    throw err;
  }
}


// ─── Utilità ───────────────────────────────

function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const v = d instanceof Date ? d : new Date(d);
  return Number.isFinite(v.getTime()) ? v.toISOString() : null;
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function normalizeScope(raw: unknown): MigrationScope {
  const ids = asObject(raw).calendar_ids;
  if (!Array.isArray(ids)) return {};
  const clean = [...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)).map((id) => id.toLowerCase()))].sort();
  return clean.length > 0 ? { calendar_ids: clean } : {};
}

/** Opzioni e ambito dell'ultima anteprima riuscita (o i default se non ce n'è una). */
export async function referencePlan(db: Db): Promise<ReferencePlan> {
  const [row] = await db<Array<{ id: string; params: unknown }>>`
    SELECT id::text AS id, params FROM cal_migration_runs
    WHERE kind = 'plan' AND status = 'succeeded'
    ORDER BY finished_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  if (!row) return { runId: null, options: resolveMigrationOptions(DEFAULT_MIGRATION_OPTIONS), scope: {} };
  const params = asObject(row.params);
  return {
    runId: row.id,
    options: resolveMigrationOptions(asObject(params.options) as Partial<MigrationOptions>),
    scope: normalizeScope(params.scope),
  };
}

/**
 * Ordine d'esecuzione dello shadow (come runApply): prima tutto tranne le
 * delete, poi le delete (uno spostamento crea nella nuova collezione prima di
 * cancellare nella vecchia).
 */
export function orderShadowItems(items: readonly PlanItem[]): PlanItem[] {
  return [...items.filter((i) => i.action !== 'delete'), ...items.filter((i) => i.action === 'delete')];
}

/**
 * Item che un job di cancellazione GDPR esegue con lo shadow spento (§9.1):
 * solo quelli su oggetti già tracciati dal ledger (patch dei campi redatti,
 * proiezioni minimizzate, cancellazioni); mai una creazione nuova, che
 * equivarrebbe a uno shadow acceso.
 */
export function erasureOnlyExecutable(item: PlanItem): boolean {
  if (!item.ledger) return false;
  return item.action === 'update' || item.action === 'delete' || item.action === 'noop' || item.action === 'adopt' || item.action === 'conflict' || item.action === 'skip';
}

/**
 * Create di uno spostamento in un job di cancellazione GDPR (§9.1, §13.1):
 * la chiave ha una delete su una riga viva del ledger in un'altra collezione,
 * quindi l'oggetto esiste già su Radicale ed è tracciato. Con lo shadow spento
 * si esegue comunque (create nella nuova collezione con il contenuto redatto,
 * poi delete nella vecchia): saltarla lascerebbe solo la delete, e l'evento
 * sparirebbe dai device fino al prossimo apply.
 */
export function isErasureMoveCreate(item: PlanItem, movedKeys: ReadonlySet<string>, erasure: boolean): boolean {
  return erasure && item.action === 'create' && !item.ledger && item.source !== null && movedKeys.has(item.legacy_key);
}

/** Fallimento di un item che un nuovo tentativo non risolve (richiesta rifiutata da Radicale con un 4xx). */
function permanentFailure(executed: ExecutedItem): boolean {
  const status = executed.http_status;
  return status !== null && status >= 400 && status < 500 && ![408, 409, 412, 423, 425, 429].includes(status);
}

// ─── Job shadow_mirror ───────────────────────────────

/** Registra l'handler del job shadow_mirror (bootstrap, prima di startCalendarJobWorker). Idempotente. */
export function registerShadowMirrorJob(): void {
  registerCalendarJobHandler(SHADOW_MIRROR_JOB_KIND, handleShadowMirror, { leaseMs: SHADOW_JOB_LEASE_MS });
}

/** Handler del job shadow_mirror (§9.2, testa del file). */
export async function handleShadowMirror(
  job: CalendarJob,
  ctx: { signal: AbortSignal; extendLease(ms?: number): Promise<boolean>; log: Logger },
): Promise<{ result?: unknown } | void> {
  const key = job.key as LegacyKey;
  const parsed = parseLegacyKey(job.key);
  if (!parsed || parsed.kind === 'archive') {
    throw new CalendarJobPermanentError(`chiave dello shadow mirror non valida: ${job.key.slice(0, 80)}`);
  }
  const erasure = asObject(job.payload).erasure === true;
  const skipped = (reason: string): { result: ShadowJobResult } => ({ result: { legacy_key: key, erasure, items: [], conflicts: 0, skipped: reason } });

  // 1. Stato riletto senza cache.
  const before = await readMigrationStateFresh(sql);
  if (before.mode !== 'postgres') return skipped('mode_not_postgres');
  if (!before.shadow_enabled && !erasure) return skipped('shadow_off');
  if (!before.volume_id) return skipped('volume_not_initialized');
  const rt = radicaleRuntime();
  if (!rt.client) throw new CalendarUnavailableError('radicale_unreachable', rt.unavailableReason ?? 'Radicale non configurato');
  const client = rt.client;
  const principal = rt.principal;

  // 2. Lock cal-migration con try: un run in corso ha la precedenza (errore d'attesa, il job si riaccoda).
  return withShadowMigrationLock(async () => {
    // 3. Identità letta da Radicale, stato riletto dentro il lock.
    let state: MigrationBackendState;
    try {
      state = await assertMigrationWritable({ db: sql, client, principal });
    } catch (err) {
      if (isMigrationError(err) && err.code === 'PRECONDITION_FAILED') {
        const reasons = Array.isArray(err.details?.reasons) ? (err.details?.reasons as string[]) : [];
        if (reasons.includes('MODE_NOT_POSTGRES')) return skipped('mode_not_postgres');
        const identity = String(err.details?.identity ?? 'unverified');
        throw new CalendarUnavailableError(identity === 'mismatch' ? 'identity_mismatch' : 'identity_unverified', `shadow mirror sospeso: identità del volume ${identity}`);
      }
      throw err;
    }
    if (!state.shadow_enabled && !erasure) return skipped('shadow_off');
    // 4-5. Piano per la chiave ed esecuzione.
    return { result: await mirrorKey(key, { erasure, shadowEnabled: state.shadow_enabled, client, principal, signal: ctx.signal, extendLease: ctx.extendLease, log: ctx.log }) };
  });
}

/** Piano shadow della chiave ed esecuzione degli item (dentro il lock, identità verificata). */
async function mirrorKey(
  key: LegacyKey,
  opts: {
    erasure: boolean;
    shadowEnabled: boolean;
    client: ExecuteContext['client'];
    principal: string;
    signal: AbortSignal;
    extendLease(ms?: number): Promise<boolean>;
    log: Logger;
  },
): Promise<ShadowJobResult> {
  const ref = await referencePlan(sql);
  const scoped = ref.scope.calendar_ids?.length ? new Set(ref.scope.calendar_ids) : null;
  const plan = await buildPlan({
    db: sql,
    client: opts.client,
    principal: opts.principal,
    mode: 'shadow',
    scope: ref.scope,
    options: ref.options,
    legacyKeys: [key],
    now: new Date(),
    signal: opts.signal,
  });

  const exec: ExecuteContext = {
    db: sql,
    client: opts.client,
    principal: opts.principal,
    runId: null,
    actor: SHADOW_ACTOR,
    mode: 'shadow',
    forced: false,
    signal: opts.signal,
    throttle: migrationThrottle(),
    now: () => new Date(),
  };

  const results: ShadowItemResult[] = [];
  const sourceOutcome = new Map<string, ApplyOutcome | 'skipped'>();
  const failures: Array<{ item: PlanItem; executed: ExecutedItem }> = [];
  // Chiavi con una delete su una riga viva del ledger: un oggetto già su Radicale che cambia collezione (spostamento).
  const movedKeys = new Set(plan.items.filter((i) => i.action === 'delete' && i.ledger).map((i) => i.legacy_key));
  let conflicts = 0;
  for (const item of orderShadowItems(plan.items)) {
    const base = { legacy_key: item.legacy_key, calendar_id: item.calendar_id, href: item.href, action: item.action };
    // Shadow spento (solo cancellazione GDPR): mai creazioni nuove, tranne la create di uno spostamento (l'oggetto
    // esiste già su Radicale nella vecchia collezione: la create porta il contenuto redatto dove deve stare).
    if (!opts.shadowEnabled && !erasureOnlyExecutable(item) && !isErasureMoveCreate(item, movedKeys, opts.erasure)) {
      results.push({ ...base, outcome: 'skipped', code: item.code, fields: item.fields, reason: 'shadow_off' });
      if (item.source) sourceOutcome.set(item.legacy_key, 'skipped');
      continue;
    }
    // Calendario fuori dall'ambito dell'anteprima e mai scritto: lo porta l'apply quando l'ambito lo comprende.
    if (scoped && !scoped.has(item.calendar_id.toLowerCase()) && !item.ledger) {
      results.push({ ...base, outcome: 'skipped', code: item.code, fields: item.fields, reason: 'out_of_scope' });
      continue;
    }
    // Spostamento (decisione 8): la delete nella vecchia collezione aspetta la scrittura nella nuova. In un job di
    // cancellazione GDPR no: la copia nella vecchia collezione ha ancora i dati da togliere, si cancella comunque.
    let moveIncomplete = false;
    if (item.action === 'delete' && sourceOutcome.has(item.legacy_key) && !SOURCE_SETTLED.has(sourceOutcome.get(item.legacy_key) as ApplyOutcome)) {
      if (!opts.erasure) {
        results.push({ ...base, outcome: 'skipped', code: item.code, fields: item.fields, reason: 'move_pending' });
        continue;
      }
      moveIncomplete = true;
    }
    if (opts.signal.aborted) throw new CalendarUnavailableError('transition', 'shadow mirror interrotto');
    const executed = await executePlanItem(item, exec);
    if (item.source) sourceOutcome.set(item.legacy_key, executed.outcome);
    results.push({ ...base, outcome: executed.outcome, code: executed.code, fields: executed.fields, ...(moveIncomplete ? { reason: 'move_incomplete' } : {}) });
    if (moveIncomplete) {
      raiseIndexAlert('shadow-move-incomplete', 'Shadow mirror: cancellazione GDPR di un oggetto spostato senza la scrittura nella nuova collezione, lo riporta il prossimo apply', {
        key: item.legacy_key,
        calendarId: item.calendar_id,
        href: item.href,
      });
    }
    if (executed.outcome === 'conflict') {
      conflicts += 1;
      raiseIndexAlert(SHADOW_CONFLICT_ALERT, 'Shadow mirror: conflitto su un oggetto di Radicale, da risolvere dal wizard della migrazione', {
        key: item.legacy_key,
        calendarId: item.calendar_id,
        href: item.href,
        code: executed.code ?? undefined,
      });
    } else if (executed.outcome === 'failed') {
      failures.push({ item, executed });
    }
    await opts.extendLease().catch(() => false);
  }

  const result: ShadowJobResult = { legacy_key: key, erasure: opts.erasure, items: results, conflicts };
  if (failures.length > 0) {
    // Un fallimento lascia l'eventuale intento pendente: il nuovo tentativo lo risolve con un GET (§4.3).
    const summary = failures.map((f) => `${f.item.href}:${f.executed.http_status ?? 'rete'}`).join(', ').slice(0, 500);
    if (failures.every((f) => permanentFailure(f.executed))) {
      raiseIndexAlert('shadow-failed', 'Shadow mirror: scrittura rifiutata da Radicale, job in dead letter', { key, items: failures.length });
      throw new CalendarJobPermanentError(`shadow mirror ${key}: scritture rifiutate (${summary})`);
    }
    throw new Error(`shadow mirror ${key}: ${failures.length} scritture non riuscite (${summary}), nuovo tentativo`);
  }
  opts.log.info({ legacyKey: key, items: results.length, conflicts, erasure: opts.erasure }, 'shadow mirror eseguito');
  return result;
}

// ─── Attivazione ───────────────────────────────

interface LastApply {
  id: string;
  status: string;
  summary: Partial<ApplySummary> | null;
  finished_at: Date | null;
}

async function lastFinishedApply(db: Db): Promise<LastApply | null> {
  const [row] = await db<Array<{ id: string; status: string; summary: unknown; finished_at: Date | null }>>`
    SELECT id::text AS id, status, summary, finished_at
    FROM cal_migration_runs
    WHERE kind = 'apply' AND status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
    ORDER BY finished_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  return row ? { id: row.id, status: row.status, summary: row.summary as Partial<ApplySummary> | null, finished_at: row.finished_at } : null;
}

function applyHasConflicts(summary: Partial<ApplySummary> | null): boolean {
  if (!summary) return true;
  const conflictCount = Object.values(summary.conflicts ?? {}).reduce((a: number, b) => a + (Number(b) || 0), 0);
  return conflictCount > 0 || (summary.totals?.conflict ?? 0) > 0 || (summary.failed ?? 0) > 0 || (summary.totals?.failed ?? 0) > 0;
}

/** Parametri di un apply completo con le opzioni e l'ambito dell'anteprima di riferimento. */
function applyParamsFrom(ref: ReferencePlan, followUpVerify: VerifyParams | null): ApplyParams {
  return {
    scope: ref.scope,
    options: ref.options,
    expected_plan_hash: null,
    force_item_ids: [],
    force_codes: [],
    follow_up_verify: followUpVerify,
  };
}

/**
 * POST /shadow (§9.5). Accensione: mode postgres, identità 'ok', ultimo
 * apply riuscito senza conflitti né fallimenti, ultima verifica completa
 * successiva accettabile, nessuna riga del ledger da rivalidare; poi
 * shadow_since = now() e apply di recupero accodato (trigger 'shadow'; se un
 * run è attivo catch_up_run = null e ci pensa il giro notturno). Altrimenti
 * PRECONDITION_FAILED con tutti i motivi. Spegnimento: sempre ammesso; i job
 * pending si chiudono senza azione (tranne quelli di cancellazione GDPR).
 */
export async function setShadowEnabled(input: { enabled: boolean; actor: string }): Promise<ShadowStateResponse> {
  const actor = String(input.actor ?? '').trim().slice(0, 200) || 'admin';
  if (!input.enabled) {
    await sql`
      UPDATE calendar_backend_state SET shadow_enabled = false, shadow_since = NULL
      WHERE id = true AND shadow_enabled
    `;
    log.info({ actor }, 'shadow mirror spento');
    return { shadow_enabled: false, shadow_since: null, catch_up_run: null };
  }

  const { client, principal } = requireRadicale();
  const state = await readMigrationStateFresh(sql);
  if (state.shadow_enabled) throw preconditionError('Lo shadow mirror è già attivo', ['SHADOW_ALREADY']);
  const reasons = new Set<PreconditionReason>();
  if (state.mode !== 'postgres') reasons.add('MODE_NOT_POSTGRES');
  try {
    await assertMigrationWritable({ db: sql, client, principal });
  } catch (err) {
    if (!(isMigrationError(err) && err.code === 'PRECONDITION_FAILED')) throw err;
    const found: PreconditionReason[] = Array.isArray(err.details?.reasons) ? (err.details?.reasons as PreconditionReason[]) : ['IDENTITY_NOT_OK'];
    for (const r of found) reasons.add(r);
  }
  const apply = await lastFinishedApply(sql);
  if (!apply || apply.status !== 'succeeded') reasons.add('APPLY_REQUIRED');
  else if (applyHasConflicts(apply.summary)) reasons.add('APPLY_CONFLICTS');
  const verify = await latestVerifyVerdicts(sql);
  const [verifyRun] = verify.runId
    ? await sql<Array<{ params: unknown }>>`SELECT params FROM cal_migration_runs WHERE id = ${verify.runId}::uuid`
    : [];
  if (!verify.runId || !verify.finished_at || (apply?.finished_at && verify.finished_at.getTime() <= apply.finished_at.getTime())) {
    reasons.add('VERIFY_REQUIRED');
  } else if (!isFullVerifyParams(verifyRun?.params)) {
    // V4 su meno dei 180 giorni del contratto (§8.1), o verifica parziale: non attesta la migrazione.
    reasons.add('VERIFY_REQUIRED');
  } else if (!verify.acceptable) {
    reasons.add('VERIFY_RED');
  }
  const [reval] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM cal_migration_ledger WHERE deleted_at IS NULL AND revalidate_reason IS NOT NULL
  `;
  if ((reval?.n ?? 0) > 0) reasons.add('REVALIDATION_PENDING');
  if (reasons.size > 0) {
    throw preconditionError('Shadow mirror non attivabile: completa prima i passi indicati', [...reasons], undefined, {
      apply_run_id: apply?.id ?? null,
      verify_run_id: verify.runId,
      revalidation_pending: reval?.n ?? 0,
    });
  }

  const [updated] = await sql<Array<{ shadow_since: Date }>>`
    UPDATE calendar_backend_state SET shadow_enabled = true, shadow_since = now()
    WHERE id = true AND mode = 'postgres' AND NOT shadow_enabled AND volume_id IS NOT NULL
    RETURNING shadow_since
  `;
  if (!updated) {
    const now = await readMigrationStateFresh(sql);
    if (now.shadow_enabled) throw preconditionError('Lo shadow mirror è già attivo', ['SHADOW_ALREADY']);
    throw preconditionError('Stato del backend cambiato durante l\'attivazione dello shadow', [now.mode !== 'postgres' ? 'MODE_NOT_POSTGRES' : 'IDENTITY_NOT_OK']);
  }
  log.info({ actor }, 'shadow mirror attivo');

  // Apply di recupero: porta su Radicale le scritture legacy precedenti all'attivazione.
  let catchUp: MigrationRunView | null = null;
  try {
    const ref = await referencePlan(sql);
    const created = await createRun({
      kind: 'apply',
      trigger: 'shadow',
      requestedBy: actor,
      params: applyParamsFrom(ref, null),
      planRunId: ref.runId,
      planHash: null,
    });
    catchUp = created.run;
  } catch (err) {
    if (isMigrationError(err) && err.code === 'MIGRATION_BUSY') {
      log.info('apply di recupero dello shadow non accodato: run in corso, ci pensa il giro notturno');
    } else {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'apply di recupero dello shadow non accodato: ci pensa il giro notturno');
    }
  }
  return { shadow_enabled: true, shadow_since: iso(updated.shadow_since), catch_up_run: catchUp };
}

// ─── Cadenza ───────────────────────────────

/**
 * Il giro programmato può partire: shadow acceso, mode postgres, Radicale
 * configurato, nessun run attivo ('busy': un run in corso, da riprovare).
 */
async function scheduledRunGate(what: string, opts: { quiet?: boolean } = {}): Promise<'ok' | 'busy' | 'skip'> {
  if (!radicaleRuntime().client) {
    log.info(`${what}: Radicale non configurato, giro saltato`);
    return 'skip';
  }
  const state = await readMigrationStateFresh(sql);
  if (state.mode !== 'postgres') {
    log.info({ mode: state.mode }, `${what}: mode diverso da postgres, giro saltato`);
    return 'skip';
  }
  if (!state.shadow_enabled) {
    log.info(`${what}: shadow spento, giro saltato`);
    return 'skip';
  }
  const active = await (await runs()).activeMigrationRun(sql);
  if (active) {
    if (!opts.quiet) log.info({ activeRun: active.id, kind: active.kind }, `${what}: run di migrazione in corso`);
    return 'busy';
  }
  return 'ok';
}

/** Esito di runShadowNightly: accodato, saltato, o nuovo tentativo programmato (run in corso). */
export type ShadowNightlyOutcome = 'queued' | 'skipped' | 'retry';

let nightlyRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** Annulla il nuovo tentativo programmato del giro notturno (arresto dell'API, test). */
export function cancelShadowNightlyRetry(): void {
  if (nightlyRetryTimer) clearTimeout(nightlyRetryTimer);
  nightlyRetryTimer = null;
}

function scheduleNightlyRetry(deadline: number, delayMs: number): ShadowNightlyOutcome {
  cancelShadowNightlyRetry();
  if (Date.now() + delayMs > deadline) {
    log.warn('shadow notturno: run di migrazione in corso fino alla fine della finestra dei tentativi, giro saltato (la parità richiede un giro notturno verde al giorno)');
    return 'skipped';
  }
  nightlyRetryTimer = setTimeout(() => {
    nightlyRetryTimer = null;
    runShadowNightly({ retryUntil: deadline, retryDelayMs: delayMs }).catch((err: unknown) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'shadow notturno: nuovo tentativo non riuscito');
    });
  }, delayMs);
  nightlyRetryTimer.unref?.();
  log.info({ retryInMs: delayMs }, 'shadow notturno: run di migrazione in corso, nuovo tentativo programmato');
  return 'retry';
}

/**
 * Cron notturno: apply completo (trigger 'schedule', plan_run_id e opzioni
 * dell'ultima anteprima riuscita, expected_plan_hash null) con
 * follow_up_verify V1-V5 su TUTTI i calendari (scope vuoto e V4 su 180
 * giorni, anche se l'anteprima e quindi l'apply hanno un ambito parziale: la
 * parità deve coprire ogni calendario). Salta (con un log) se lo shadow è
 * spento o il mode non è postgres; con un run attivo (per esempio la verifica
 * oraria) riprova ogni SHADOW_NIGHTLY_RETRY_MS per al più
 * SHADOW_NIGHTLY_RETRY_WINDOW_MS, così il giorno non resta senza giro
 * notturno.
 */
export async function runShadowNightly(opts: { retryUntil?: number; retryDelayMs?: number } = {}): Promise<ShadowNightlyOutcome> {
  const delayMs = opts.retryDelayMs ?? SHADOW_NIGHTLY_RETRY_MS;
  const deadline = opts.retryUntil ?? Date.now() + SHADOW_NIGHTLY_RETRY_WINDOW_MS;
  cancelShadowNightlyRetry();
  const gate = await scheduledRunGate('shadow notturno');
  if (gate === 'busy') return scheduleNightlyRetry(deadline, delayMs);
  if (gate === 'skip') return 'skipped';
  const ref = await referencePlan(sql);
  if (!ref.runId) {
    log.warn('shadow notturno: nessuna anteprima riuscita di riferimento, giro saltato');
    return 'skipped';
  }
  try {
    const created = await createRun({
      kind: 'apply',
      trigger: 'schedule',
      requestedBy: SHADOW_ACTOR,
      params: applyParamsFrom(ref, { scope: {}, levels: [...VERIFY_LEVELS], v4_days: MIGRATION_LIMITS.v4Days }),
      planRunId: ref.runId,
      planHash: null,
    });
    log.info({ runId: created.run.id }, 'shadow notturno: apply completo con verifica V1-V5 accodato');
    return 'queued';
  } catch (err) {
    if (isMigrationError(err) && err.code === 'MIGRATION_BUSY') return scheduleNightlyRetry(deadline, delayMs);
    throw err;
  }
}

/** Il giro orario cade nella finestra del giro notturno (ora locale del server, come il cron). */
export function inNightlyQuietWindow(now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const nightly = SHADOW_NIGHTLY_HOUR * 60;
  const day = 24 * 60;
  const delta = ((minutes - nightly) % day + day) % day; // minuti dopo l'ora del notturno, in [0, 1440)
  return delta < HOURLY_QUIET_AFTER_MIN || delta >= day - HOURLY_QUIET_BEFORE_MIN;
}

/** Cron orario: verifica V4 sui prossimi 14 giorni (giro orario della parità). */
export async function runShadowHourlyParity(opts: { now?: Date } = {}): Promise<void> {
  if (inNightlyQuietWindow(opts.now ?? new Date())) {
    log.info('parità oraria dello shadow: finestra del giro notturno, giro saltato');
    return;
  }
  if ((await scheduledRunGate('parità oraria dello shadow')) !== 'ok') return;
  try {
    const created = await createRun({
      kind: 'verify',
      trigger: 'schedule',
      requestedBy: SHADOW_ACTOR,
      params: { scope: {}, levels: ['V4'], v4_days: MIGRATION_LIMITS.v4HourlyDays } satisfies VerifyParams,
    });
    log.info({ runId: created.run.id }, 'parità oraria dello shadow: verifica V4 accodata');
  } catch (err) {
    if (isMigrationError(err) && err.code === 'MIGRATION_BUSY') {
      log.info('parità oraria dello shadow: run di migrazione in corso, giro saltato');
      return;
    }
    throw err;
  }
}

// ─── Parità ───────────────────────────────

interface ScheduledRunRow {
  id: string;
  kind: 'apply' | 'verify';
  status: string;
  trigger: MigrationRunTrigger;
  params: unknown;
  summary: unknown;
  created_at: Date;
  finished_at: Date;
}

/** Verifica del giro orario: solo V4 sui prossimi 14 giorni. */
export function isHourlyVerifyParams(params: unknown): boolean {
  const p = asObject(params);
  const levels = Array.isArray(p.levels) ? p.levels : [];
  return levels.length === 1 && levels[0] === 'V4';
}

/**
 * Verifica completa (§8.1, §19 punto 5): tutti i livelli V1-V5, nessun ambito
 * (tutti i calendari) e V4 su almeno MIGRATION_LIMITS.v4Days giorni. Solo
 * questa conta come giro notturno della parità e per l'accensione dello
 * shadow.
 */
export function isFullVerifyParams(params: unknown): boolean {
  const p = asObject(params);
  const levels = Array.isArray(p.levels) && p.levels.length > 0 ? p.levels : [...VERIFY_LEVELS];
  if (!VERIFY_LEVELS.every((l) => levels.includes(l))) return false;
  const ids = asObject(p.scope).calendar_ids;
  if (Array.isArray(ids) && ids.length > 0) return false;
  const days = p.v4_days === undefined || p.v4_days === null ? MIGRATION_LIMITS.v4Days : Number(p.v4_days);
  return Number.isFinite(days) && days >= MIGRATION_LIMITS.v4Days;
}

/** Colore di un run di verifica concluso, per la parità (null se non riuscito). */
function verifyRunColor(run: Pick<ScheduledRunRow, 'status' | 'params' | 'summary'>): VerifyColor | null {
  if (run.status !== 'succeeded') return null;
  const s = asObject(run.summary) as Partial<VerifySummary>;
  if (isHourlyVerifyParams(run.params)) return (s.v4?.without_subscriptions ?? s.overall ?? null) as VerifyColor | null;
  return (s.overall ?? null) as VerifyColor | null;
}

/**
 * Un giro programmato è verde quando la verifica è accettabile (per il giro
 * orario: V4 senza iscrizioni non rossa). Una verifica che non è né il giro
 * orario né completa (ambito parziale, livelli mancanti, V4 su meno di 180
 * giorni) non è mai verde: non attesta la parità di tutti i calendari.
 */
export function verifyRunGreen(run: Pick<ScheduledRunRow, 'status' | 'params' | 'summary'>): boolean {
  if (run.status !== 'succeeded') return false;
  const s = asObject(run.summary) as Partial<VerifySummary>;
  if (isHourlyVerifyParams(run.params)) {
    const color = s.v4?.without_subscriptions ?? s.overall ?? null;
    return color !== null && color !== 'red';
  }
  return s.acceptable === true && isFullVerifyParams(run.params);
}

function applyWrites(summary: unknown): number | null {
  const w = asObject(asObject(summary).writes);
  if (Object.keys(w).length === 0) return null;
  return (Number(w.create) || 0) + (Number(w.update) || 0) + (Number(w.delete) || 0);
}

function applyConflicts(summary: unknown): number | null {
  const c = asObject(asObject(summary).conflicts);
  if (!asObject(summary).conflicts) return null;
  return Object.values(c).reduce((a: number, b) => a + (Number(b) || 0), 0);
}

/** Un giro della parità: verifica programmata conclusa, o apply programmato fallito (giro non verde). */
interface ParityRound {
  at: Date;
  green: boolean;
  nightly: boolean;
}

/**
 * Giri e loro colore (puro): verifiche programmate concluse e apply
 * programmati non riusciti, in ordine di fine. Ogni verifica programmata che
 * non è il giro orario V4 è un giro notturno, verde solo se completa e
 * accettabile (verifyRunGreen): una verifica notturna parziale interrompe la
 * serie invece di attestarla.
 */
export function parityRounds(runs: readonly Pick<ScheduledRunRow, 'kind' | 'status' | 'trigger' | 'params' | 'summary' | 'finished_at'>[]): ParityRound[] {
  const rounds: ParityRound[] = [];
  for (const r of runs) {
    if (r.trigger !== 'schedule') continue;
    if (r.kind === 'verify') rounds.push({ at: r.finished_at, green: verifyRunGreen(r), nightly: !isHourlyVerifyParams(r.params) });
    else if (r.kind === 'apply' && r.status !== 'succeeded') rounds.push({ at: r.finished_at, green: false, nightly: true });
  }
  return rounds.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Giorno di calendario (YYYY-MM-DD) di un istante in Europe/Rome. */
export function parityDay(at: Date): string {
  return PARITY_DAY_FORMAT.format(at);
}

function shiftParityDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Serie verde e criterio dei 7 giorni (puro): green_since è la fine del primo
 * giro verde dopo l'ultimo giro non verde (o dopo shadow_since); satisfied
 * richiede almeno `requiredDays` giorni di serie verde e un giro notturno
 * verde in ognuno degli ultimi `requiredDays` giorni di calendario
 * (Europe/Rome): da ieri all'indietro, oppure da oggi se il giro notturno di
 * oggi c'è già. Giorni di calendario e non finestre di 24 ore ancorate a now:
 * un giro che finisce qualche minuto più tardi del giorno prima non apre un
 * buco.
 */
export function computeParityStreak(rounds: readonly ParityRound[], opts: { now: Date; shadowSince: Date | null; requiredDays: number }):
  { green_since: Date | null; days_green: number; satisfied: boolean } {
  if (!opts.shadowSince) return { green_since: null, days_green: 0, satisfied: false };
  const since = opts.shadowSince.getTime();
  const relevant = rounds.filter((r) => r.at.getTime() >= since && r.at.getTime() <= opts.now.getTime());
  if (relevant.length === 0 || !relevant[relevant.length - 1].green) return { green_since: null, days_green: 0, satisfied: false };
  let lastBad = -1;
  relevant.forEach((r, i) => {
    if (!r.green) lastBad = i;
  });
  const firstGreen = relevant[lastBad + 1];
  const greenSince = firstGreen.at;
  const daysGreen = Math.max(0, Math.floor((opts.now.getTime() - greenSince.getTime()) / DAY_MS));
  let satisfied = daysGreen >= opts.requiredDays;
  if (satisfied) {
    const greenNightlyDays = new Set(relevant.slice(lastBad + 1).filter((r) => r.nightly && r.green).map((r) => parityDay(r.at)));
    const today = parityDay(opts.now);
    const last = greenNightlyDays.has(today) ? today : shiftParityDay(today, -1);
    for (let d = 0; d < opts.requiredDays && satisfied; d++) satisfied = greenNightlyDays.has(shiftParityDay(last, -d));
  }
  return { green_since: greenSince, days_green: daysGreen, satisfied };
}

/**
 * Conflitti aperti dello shadow: chiavi il cui esito più recente (ultimo job
 * shadow_mirror concluso o ultimo apply) è un conflitto. Un job o un apply
 * successivo della stessa chiave senza conflitto lo chiude.
 */
export async function countOpenShadowConflicts(db: Db): Promise<number> {
  const [row] = await db<Array<{ n: number }>>`
    WITH shadow AS (
      SELECT DISTINCT ON (j.key) j.key AS legacy_key, j.finished_at AS at,
             EXISTS (
               SELECT 1 FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(j.result->'items') = 'array' THEN j.result->'items' ELSE '[]'::jsonb END
               ) it WHERE it->>'outcome' = 'conflict'
             ) AS conflict
      FROM cal_jobs j
      WHERE j.kind = ${SHADOW_MIRROR_JOB_KIND} AND j.status = 'done' AND j.finished_at IS NOT NULL
      ORDER BY j.key, j.finished_at DESC
    ),
    per_run AS (
      SELECT i.legacy_key, r.finished_at AS at, bool_or(i.outcome = 'conflict') AS conflict
      FROM cal_migration_items i
      JOIN cal_migration_runs r ON r.id = i.run_id
      WHERE r.kind = 'apply' AND r.finished_at IS NOT NULL
        AND i.item_type = 'object' AND i.legacy_key IS NOT NULL AND i.outcome IS NOT NULL
      GROUP BY i.legacy_key, r.id, r.finished_at
    ),
    applied AS (
      SELECT DISTINCT ON (legacy_key) legacy_key, at, conflict
      FROM per_run
      ORDER BY legacy_key, at DESC
    ),
    latest AS (
      SELECT DISTINCT ON (legacy_key) legacy_key, conflict
      FROM (SELECT legacy_key, at, conflict FROM shadow UNION ALL SELECT legacy_key, at, conflict FROM applied) x
      ORDER BY legacy_key, at DESC NULLS LAST
    )
    SELECT count(*)::int AS n FROM latest WHERE conflict
  `;
  return row?.n ?? 0;
}

/** Parità osservata dello shadow per il wizard (§9.5): serie verde, giri recenti, coda e conflitti aperti. */
export async function getParity(db: Db, now: Date = new Date()): Promise<ParityView> {
  const state = await readMigrationStateFresh(db);
  const required = MIGRATION_LIMITS.parityDaysRequired;
  const windowStart = state.shadow_since
    ? new Date(Math.max(state.shadow_since.getTime(), now.getTime() - MIGRATION_LIMITS.runRetentionDays * DAY_MS))
    : new Date(now.getTime() - MIGRATION_LIMITS.runRetentionDays * DAY_MS);

  const runs = await db<ScheduledRunRow[]>`
    SELECT id::text AS id, kind, status, trigger, params, summary, created_at, finished_at
    FROM cal_migration_runs
    WHERE kind IN ('apply', 'verify') AND trigger IN ('schedule', 'shadow')
      AND status IN ('succeeded', 'failed', 'cancelled', 'interrupted') AND finished_at IS NOT NULL
      AND finished_at >= ${windowStart}
    ORDER BY finished_at ASC, created_at ASC
  `;
  const streak = computeParityStreak(parityRounds(runs), { now, shadowSince: state.shadow_since, requiredDays: required });

  // Ultimo giro notturno: apply programmato e verifica completa creata alla sua chiusura.
  const applies = runs.filter((r) => r.kind === 'apply' && r.trigger === 'schedule');
  const lastApply = applies[applies.length - 1] ?? null;
  const nightlyVerifies = runs.filter((r) => r.kind === 'verify' && r.trigger === 'schedule' && !isHourlyVerifyParams(r.params));
  let lastNightly: ParityView['last_nightly'] = null;
  if (lastApply) {
    const verify = nightlyVerifies.find((v) => v.created_at.getTime() >= lastApply.finished_at.getTime() - 1_000) ?? null;
    lastNightly = {
      apply_run_id: lastApply.id,
      verify_run_id: verify?.id ?? null,
      color: verify ? verifyRunColor(verify) : lastApply.status === 'succeeded' ? null : 'red',
      green: verify ? verifyRunGreen(verify) : lastApply.status === 'succeeded' ? null : false,
      finished_at: iso(verify?.finished_at ?? lastApply.finished_at),
    };
  } else if (nightlyVerifies.length > 0) {
    const verify = nightlyVerifies[nightlyVerifies.length - 1];
    lastNightly = { apply_run_id: null, verify_run_id: verify.id, color: verifyRunColor(verify), green: verifyRunGreen(verify), finished_at: iso(verify.finished_at) };
  }
  const hourly = runs.filter((r) => r.kind === 'verify' && r.trigger === 'schedule' && isHourlyVerifyParams(r.params) && r.status === 'succeeded');
  const lastHourlyRun = hourly[hourly.length - 1] ?? null;
  const lastHourlyColor = lastHourlyRun ? verifyRunColor(lastHourlyRun) : null;

  const recent = [...runs].reverse().slice(0, PARITY_RECENT_LIMIT).map((r) => ({
    run_id: r.id,
    kind: r.kind,
    trigger: r.trigger,
    finished_at: iso(r.finished_at) as string,
    color: r.kind === 'verify' ? verifyRunColor(r) : null,
    writes: r.kind === 'apply' ? applyWrites(r.summary) : null,
    conflicts: r.kind === 'apply' ? applyConflicts(r.summary) : null,
  }));

  const [queue] = await db<Array<{ pending: number; running: number; dead: number; oldest: Date | null }>>`
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'running')::int AS running,
           count(*) FILTER (WHERE status = 'dead')::int AS dead,
           min(created_at) FILTER (WHERE status = 'pending') AS oldest
    FROM cal_jobs WHERE kind = ${SHADOW_MIRROR_JOB_KIND}
  `;

  return {
    shadow_enabled: state.shadow_enabled,
    shadow_since: iso(state.shadow_since),
    green_since: iso(streak.green_since),
    days_green: streak.days_green,
    required_days: required,
    satisfied: state.shadow_enabled && streak.satisfied,
    last_nightly: lastNightly,
    last_hourly: lastHourlyRun && lastHourlyColor
      ? { run_id: lastHourlyRun.id, color: lastHourlyColor, finished_at: iso(lastHourlyRun.finished_at) as string }
      : null,
    recent,
    queue: { pending: queue?.pending ?? 0, running: queue?.running ?? 0, dead: queue?.dead ?? 0, oldest_pending_at: iso(queue?.oldest ?? null) },
    open_conflicts: await countOpenShadowConflicts(db),
  };
}

// ─── Iscrizioni (decisione 5) ───────────────────────────────

/** Host dell'URL di un feed (mai percorso e query: possono contenere token). */
function urlHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Iscrizioni con impatto, flag e stato del sidecar per il passo 2 del wizard. */
export async function listSubscriptionsForMigration(db: Db): Promise<SubscriptionMigrationView[]> {
  const impacts = await computeSubscriptionImpacts(db, { now: new Date() });
  if (impacts.length === 0) return [];
  const rows = await db<Array<{ id: string; ics_url: string | null }>>`
    SELECT id::text AS id, ics_url FROM calendar_subscriptions
  `;
  const hosts = new Map(rows.map((r) => [r.id.toLowerCase(), urlHost(r.ics_url)]));
  const collections = await existingSubscriptionCollections(impacts.map((i) => i.collection_name).filter((n): n is string => Boolean(n)));
  return impacts.map((i) => ({
    ...i,
    collection_exists: i.collection_name ? (collections.get(i.collection_name) ?? i.collection_exists) : i.collection_exists,
    url_host: hosts.get(i.subscription_id.toLowerCase()) ?? null,
  }));
}

/** Esistenza delle collezioni sub-* su Radicale (null se non verificabile). */
async function existingSubscriptionCollections(names: readonly string[]): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const rt = radicaleRuntime();
  for (const name of names) {
    if (!rt.client) {
      out.set(name, null);
      continue;
    }
    try {
      await rt.client.propfind(collectionPath(rt.principal, name), { props: [DAV_PROPS.resourcetype], depth: 0 });
      out.set(name, true);
    } catch (err) {
      out.set(name, isRadicaleError(err, 'not_found') ? false : null);
    }
  }
  return out;
}

/**
 * Flag per singola iscrizione (decisione 5, §9.4): la prima impostazione crea
 * il sidecar (invisibile al legacy, §1.3) e forza un pull verso l'indice;
 * device_visible si riporta sul sidecar e, se la collezione `sub-<id8>` esiste
 * (la crea solo l'init `create_missing`), accoda lo specchio. In mode postgres
 * i flag non cambiano il busy legacy.
 */
export async function setSubscriptionMigrationFlags(
  subscriptionId: string,
  flags: SubscriptionFlagsRequest,
  actor: string,
): Promise<SubscriptionFlagsResponse> {
  if (typeof subscriptionId !== 'string' || !UUID_RE.test(subscriptionId)) throw new MigrationError('VALIDATION_FAILED', 'Iscrizione non valida');
  const blocks = flags?.blocks_availability;
  const visible = flags?.device_visible;
  if (blocks !== undefined && typeof blocks !== 'boolean') throw new MigrationError('VALIDATION_FAILED', 'blocks_availability: atteso un booleano');
  if (visible !== undefined && typeof visible !== 'boolean') throw new MigrationError('VALIDATION_FAILED', 'device_visible: atteso un booleano');
  if (blocks === undefined && visible === undefined) throw new MigrationError('VALIDATION_FAILED', 'Indica almeno un flag (blocks_availability o device_visible)');

  const state = await readMigrationStateFresh(sql);
  if (state.mode !== 'postgres') {
    throw preconditionError('I flag delle iscrizioni dello strumento di migrazione si impostano solo in mode postgres', ['MODE_NOT_POSTGRES']);
  }
  const [sub] = await sql<Array<{ id: string; collection_calendar_id: string | null }>>`
    SELECT id::text AS id, collection_calendar_id::text AS collection_calendar_id
    FROM calendar_subscriptions WHERE id = ${subscriptionId}::uuid
  `;
  if (!sub) throw new MigrationError('VALIDATION_FAILED', 'Iscrizione non trovata');

  // Sidecar (prima impostazione) e pull forzato verso l'indice.
  let sidecarId = sub.collection_calendar_id;
  if (!sidecarId) {
    try {
      sidecarId = await enableSubscriptionIndex(subscriptionId, { allowPostgresMode: true });
    } catch (err) {
      if (err instanceof CalendarUnavailableError) throw new MigrationError('CALENDAR_UNAVAILABLE', err.message);
      throw err;
    }
    const pulled = await pullSubscriptionToIndex(subscriptionId, { force: true });
    log.info({ subscriptionId, status: pulled.status }, 'sidecar dell\'iscrizione creato dal wizard: pull verso l\'indice');
  }

  const [updated] = await sql<Array<{ device_visible: boolean }>>`
    UPDATE calendar_subscriptions SET
      blocks_availability = COALESCE(${blocks ?? null}::boolean, blocks_availability),
      device_visible = COALESCE(${visible ?? null}::boolean, device_visible)
    WHERE id = ${subscriptionId}::uuid
    RETURNING device_visible
  `;
  const [sidecar] = await sql<Array<{ collection_name: string | null }>>`
    UPDATE calendars SET device_visible = ${updated.device_visible}
    WHERE id = ${sidecarId}::uuid
    RETURNING collection_name
  `;

  let collectionMissing = false;
  if (updated.device_visible) {
    const name = sidecar?.collection_name ?? null;
    const exists = name ? (await existingSubscriptionCollections([name])).get(name) ?? null : false;
    collectionMissing = exists !== true;
    if (exists === true) await requestSubscriptionMirror(subscriptionId);
  }
  log.info({ actor: String(actor ?? '').slice(0, 200), subscriptionId, blocks, visible, collectionMissing }, 'flag dell\'iscrizione per la migrazione aggiornati');

  const views = await listSubscriptionsForMigration(sql);
  const view = views.find((v) => v.subscription_id.toLowerCase() === subscriptionId.toLowerCase());
  if (!view) throw new MigrationError('INTERNAL', 'Iscrizione non più presente dopo l\'aggiornamento');
  return { subscription: view, collection_missing: collectionMissing };
}

// ─── Riconciliazione delle proiezioni ───────────────────────────────

/**
 * Riconciliazione in sola lettura (piano F3, attività 3; design §16.2 e
 * §16.3): prenotazioni proiettate senza proiezione (`missing`), proiezioni
 * senza una prenotazione proiettata (`orphan`) e proiezioni con orari diversi
 * dalla prenotazione (`drift`), come uid delle prenotazioni. Con lo store
 * postgres le proiezioni sono le righe legacy (source='booking'), con lo store
 * Radicale le risorse booking-<uid>.ics dell'indice. Mai cancellazioni né
 * scritture.
 */
export async function reconcileProjectionsReadOnly(db: Db): Promise<{ missing: string[]; orphan: string[]; drift: string[] }> {
  const state = await readMigrationStateFresh(db);
  const kind = storeKindOverride() ?? storeKindForMode(state.mode);
  const statuses = [...PROJECTED_BOOKING_STATUSES];
  const bookings = await db<Array<{ uid: string; start_time: Date; end_time: Date }>>`
    SELECT uid, start_time, end_time FROM calendar_bookings WHERE status = ANY(${statuses}::text[])
  `;
  const projections = kind === 'radicale'
    ? await db<Array<{ uid: string; start_time: Date | null; end_time: Date | null }>>`
        SELECT substr(ob.href, 9, length(ob.href) - 12) AS uid, cc.start_utc AS start_time, cc.end_utc AS end_time
        FROM cal_objects ob
        JOIN calendars c ON c.id = ob.calendar_id AND c.role = 'bookings'
        LEFT JOIN cal_components cc ON cc.object_id = ob.id AND cc.recurrence_key = ''
        WHERE ob.href LIKE 'booking-%.ics' AND COALESCE(cc.status, 'confirmed') <> 'cancelled'
      `
    : await db<Array<{ uid: string; start_time: Date | null; end_time: Date | null }>>`
        SELECT btrim(source_id) AS uid, start_time, end_time
        FROM calendar_events
        WHERE source = 'booking' AND nullif(btrim(source_id), '') IS NOT NULL AND status <> 'cancelled'
      `;
  const wanted = new Map(bookings.map((b) => [b.uid, b]));
  const present = new Map<string, { start_time: Date | null; end_time: Date | null }>();
  for (const p of projections) if (!present.has(p.uid)) present.set(p.uid, p);
  const ms = (d: Date | string | null): number | null => (d === null ? null : new Date(d).getTime());

  const missing: string[] = [];
  const drift: string[] = [];
  for (const [uid, b] of wanted) {
    const p = present.get(uid);
    if (!p) missing.push(uid);
    else if (ms(p.start_time) !== ms(b.start_time) || ms(p.end_time) !== ms(b.end_time)) drift.push(uid);
  }
  const orphan = [...present.keys()].filter((uid) => !wanted.has(uid));
  return { missing: missing.sort(), orphan: orphan.sort(), drift: drift.sort() };
}
