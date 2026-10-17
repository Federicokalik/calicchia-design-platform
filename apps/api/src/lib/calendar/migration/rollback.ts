/**
 * Rollback a Postgres (fase F4 del passaggio a Radicale; design §13.12, con
 * lo schema delle transizioni del §13.9; contratto docs/calendar-radicale/
 * contracts/f4-modules.md §5.1). Due run dello strumento di migrazione:
 *
 * - `rollback_preview` (nessuna scrittura tranne le righe del run): cambiamenti
 *   dal cutover per attore, piano completo della proiezione inversa, degradi
 *   per classe e per calendario, righe derivate, REVERSE_FAILED, confronto
 *   del busy legacy previsto con quello dell'indice (`busy_identical`) e
 *   `preview_hash`, che l'utente conferma;
 * - `rollback` (conferma digitata `TORNA A POSTGRES`, più `ROLLBACK DI
 *   EMERGENZA` per l'emergenza), passi ROLLBACK_STEPS nel journal di
 *   transition.ts, ognuno riprendibile dopo un crash:
 *
 *  1. preflight      mode radicale, finestra aperta, anteprima riuscita e
 *                    recente con l'hash confermato, identità del volume,
 *                    control-plane e probe;
 *  2. freeze         mode `rollback`, write_freeze (prima lo stato, poi la
 *                    policy frozen derivata): i device sono in sola lettura
 *                    PRIMA della fotografia finale;
 *  3. quiesce        gate cal-write esclusivo e quiescenza dei device (il
 *                    probe passa da 2xx a 403);
 *  4. index_sync     sync finale di tutte le collezioni (con l'emergenza un
 *                    errore non blocca: l'indice è la miglior conoscenza);
 *  5. reverse_final  piano completo della proiezione inversa: hash diverso
 *                    da quello confermato senza emergenza → annullamento
 *                    (PREVIEW_CHANGED, ritorno a radicale live) con la nuova
 *                    anteprima nel riassunto; altrimenti applicazione;
 *  6. rebaseline     ri-baseline del ledger (rebaseline.ts): un nuovo cutover
 *                    sarà noop per gli oggetti non toccati;
 *  7. epoch          PUNTO DI NON RITORNO: PROPPATCH dell'epoch E+1, poi mode
 *                    postgres, write_freeze false, rollback_until, cutover_at
 *                    e cutover_by a NULL (api_min_version resta: le righe
 *                    derivate richiedono il codice della F4);
 *  8. control_plane  policy shadow con il nuovo epoch, heartbeat postgres;
 *  9. cleanup        validatori delle iscrizioni azzerati (il pull legacy
 *                    riscarica i feed), job reverse_projection in coda chiusi;
 *                    i project_booking in coda restano (in mode postgres
 *                    convergono la proiezione legacy).
 *
 * Il volume Radicale resta intatto come archivio (design §13.12 passo 6); lo
 * shadow mirror, se acceso, riprende da solo in patch sulle righe adottate
 * dalla ri-baseline. Prima del passo d'epoch il rollback si annulla
 * (action 'abort': ritorno a radicale con il write_freeze di prima); dopo, si
 * riprende e basta.
 */

import type { Logger } from 'pino';
import { logger as rootLogger } from '../../logger';
import { indexBusyRanges } from '../busy';
import { CAL_JOB_KINDS } from '../jobs';
import type { RadicaleClient } from '../radicale/client';
import { type ControlPlaneStatus, type ControlPlaneTick, getCalendarControlPlane, requestControlPlaneSync } from '../radicale/heartbeat';
import { checkVolumeIdentity, type IdentityCheck, remoteIdentitySource } from '../radicale/identity';
import type { Db } from '../radicale/policy';
import { CollectionSyncError, type SyncCollectionResult, syncAllCollections, verifyVolumeIdentity } from '../radicale/sync';
import type { BusyRange } from '../types';
import { describeRadicaleError, preconditionError, requireRadicale } from './preflight';
import { runRebaseline } from './rebaseline';
import { referencePlan } from './shadow';
import {
  abortTransition,
  beginTransition,
  completedStep,
  completeTransition,
  epochStep,
  freezeStep,
  getLatestTransition,
  journalViews,
  mergeTransitionData,
  type QuiescenceDeps,
  quiesceStep,
  readJournal,
  readTransitionState,
  runStep,
  type TransitionContext,
  transitionContextFromRun,
  TransitionError,
  type TransitionHandle,
} from './transition';
import {
  type DegradationClass,
  F4_LIMITS,
  type MigrationBackendState,
  MigrationError,
  type MigrationItemInput,
  type MigrationRunContext,
  type PreconditionReason,
  type QuiescenceReport,
  type RebaselineSummary,
  type ReverseApplySummary,
  type RollbackParams,
  type RollbackPreviewParams,
  type RollbackPreviewSummary,
  type RollbackSummary,
  ROLLBACK_STEPS,
} from './types';

// Il proiettore inverso (gruppo REVERSE) si importa in modo differito: reverse-projector.ts importa runs.ts in modo
// dinamico e runs.ts importa questo modulo; i tipi restano verificati staticamente.
type ReverseModule = typeof import('./reverse-projector');
type ReversePlan = Awaited<ReturnType<ReverseModule['computeReversePlan']>>;

const log: Logger = rootLogger.child({ scope: 'calendar-rollback' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Orizzonte del confronto del busy (contratto §5.1). */
const BUSY_HORIZON_DAYS = 180;
/** Tentativi del giro del control-plane dopo il passo d'epoch. */
const CONTROL_PLANE_ATTEMPTS = 5;
const CONTROL_PLANE_RETRY_MS = 1_000;
/** Timeout della lettura del marker per le guardie d'identità. */
const IDENTITY_TIMEOUT_MS = 8_000;
/** Il contratto dei run ammette al più 500 righe per addItems. */
const ROWS_CHUNK = 500;
/** Righe 'degradation' al più per anteprima (i conteggi restano completi nel riassunto). */
const PREVIEW_ROWS_MAX = 5_000;

// ─── Utilità ───────────────────────────────

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}

async function reverseModule(): Promise<ReverseModule> {
  return import('./reverse-projector');
}

/** Intervalli ordinati e fusi (sovrapposti o contigui): forma canonica del busy per il confronto. */
export function mergeBusy(list: readonly BusyRange[]): Array<{ start: number; end: number }> {
  const ivs = list
    .map((r) => ({ start: Date.parse(r.start), end: Date.parse(r.end) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Array<{ start: number; end: number }> = [];
  for (const iv of ivs) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

/** Due busy uguali dopo la fusione degli intervalli. */
export function sameBusy(a: readonly BusyRange[], b: readonly BusyRange[]): boolean {
  const x = mergeBusy(a);
  const y = mergeBusy(b);
  return x.length === y.length && x.every((iv, i) => iv.start === y[i].start && iv.end === y[i].end);
}

// ─── Parametri ───────────────────────────────

/** Parametri del run normalizzati (VALIDATION_FAILED se fuori contratto). */
export function normalizeRollbackParams(params: Partial<RollbackParams> | null | undefined): RollbackParams {
  const p = params ?? {};
  const action = p.action ?? 'start';
  if (action !== 'start' && action !== 'resume' && action !== 'abort') {
    throw new MigrationError('VALIDATION_FAILED', 'action: attesi start, resume o abort');
  }
  const preview = p.preview_run_id ?? null;
  if (preview !== null && (typeof preview !== 'string' || !UUID_RE.test(preview))) {
    throw new MigrationError('VALIDATION_FAILED', 'preview_run_id: atteso l\'id (UUID) di un run rollback_preview');
  }
  const hash = p.expect_preview_hash ?? null;
  if (hash !== null && (typeof hash !== 'string' || !SHA256_RE.test(hash))) {
    throw new MigrationError('VALIDATION_FAILED', 'expect_preview_hash: atteso uno sha256 esadecimale');
  }
  if (p.emergency !== undefined && typeof p.emergency !== 'boolean') {
    throw new MigrationError('VALIDATION_FAILED', 'emergency: atteso un booleano');
  }
  return { action, preview_run_id: preview ? preview.toLowerCase() : null, expect_preview_hash: hash ? hash.toLowerCase() : null, emergency: p.emergency === true };
}

// ─── Dipendenze ───────────────────────────────

/** Ingressi esterni dei run (sostituibili nei test). */
export interface RollbackDeps {
  /** Client caldes-svc e principal (RADICALE_NOT_CONFIGURED se assente). */
  radicale: () => { client: RadicaleClient; principal: string };
  /** Dipendenze della quiescenza (undefined: quelle di produzione di transition.ts). */
  quiescence: () => QuiescenceDeps | undefined;
  /** Giro del control-plane (null se il control-plane non è attivo nel processo). */
  controlPlaneSync: () => Promise<ControlPlaneTick | null>;
  /** Stato del control-plane del processo (null se non attivo). */
  controlPlaneStatus: () => ControlPlaneStatus | null;
  /** Password di caldes-probe disponibile nell'API. */
  probeAvailable: () => boolean;
  /** Identità del volume letta da Radicale (senza cache) per lo stato dato. */
  checkIdentity: (state: MigrationBackendState) => Promise<IdentityCheck>;
  /** Identità riletta dopo il passo d'epoch. */
  verifyIdentity: () => Promise<IdentityCheck>;
  /** Sync di tutte le collezioni Radicale del sidecar. */
  syncAll: () => Promise<Array<SyncCollectionResult | CollectionSyncError>>;
  /** Piano della proiezione inversa (senza scrivere). */
  computeReversePlan: (db: Db, opts: { now: Date; signal?: AbortSignal }) => Promise<ReversePlan>;
  /** Applicazione del piano. */
  applyReversePlan: (db: Db, plan: ReversePlan, opts: { actor: string; runId: string | null; signal?: AbortSignal }) => Promise<ReverseApplySummary>;
  /** Ri-baseline del ledger. */
  rebaseline: (opts: { db: Db; actor: string; runId: string | null; signal?: AbortSignal }) => Promise<RebaselineSummary>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

/** Dipendenze di produzione. */
export function defaultRollbackDeps(env: NodeJS.ProcessEnv = process.env): RollbackDeps {
  return {
    radicale: requireRadicale,
    quiescence: () => undefined,
    controlPlaneSync: () => requestControlPlaneSync(),
    controlPlaneStatus: () => getCalendarControlPlane()?.status() ?? null,
    probeAvailable: () => Boolean(env.RADICALE_PROBE_PASSWORD?.trim() || env.CALDES_PROBE_PASSWORD?.trim()),
    checkIdentity: async (state) => {
      const { client, principal } = requireRadicale();
      return checkVolumeIdentity(state, remoteIdentitySource(client, { timeoutMs: IDENTITY_TIMEOUT_MS }), principal);
    },
    verifyIdentity: async () => (await verifyVolumeIdentity({ force: true })).check,
    syncAll: () => syncAllCollections({ reason: 'manual', actor: 'system:rollback' }),
    computeReversePlan: async (db, opts) => (await reverseModule()).computeReversePlan(db, opts),
    applyReversePlan: async (db, plan, opts) => (await reverseModule()).applyReversePlan(db, plan, opts),
    rebaseline: async (opts) => {
      const reference = await referencePlan(opts.db);
      return runRebaseline({ db: opts.db, actor: opts.actor, runId: opts.runId, options: reference.options, signal: opts.signal });
    },
    sleep: defaultSleep,
    now: () => new Date(),
  };
}

// ─── Anteprima ───────────────────────────────

type ChangeActor = keyof RollbackPreviewSummary['changes_since_cutover']['by_actor'];

/**
 * Origine di una versione dell'indice (cal_object_versions.actor): `sync` è un
 * cambiamento osservato su Radicale senza passare dall'API (device e client
 * CalDAV), `write-through:<source>` una scrittura dell'API (admin, MCP,
 * agente, prenotazioni, sistema), `rebuild`/`restore` la manutenzione.
 */
export function actorClass(actor: string | null): ChangeActor {
  const a = (actor ?? '').toLowerCase();
  if (a === 'sync' || a === 'device' || a.startsWith('device')) return 'device';
  const who = a.startsWith('write-through:') ? a.slice('write-through:'.length) : a;
  if (who.startsWith('admin')) return 'admin';
  if (who.startsWith('mcp')) return 'mcp';
  if (who.startsWith('agent')) return 'agent';
  if (who.includes('booking')) return 'booking';
  if (who.startsWith('system') || who === 'rebuild' || who === 'restore' || who === 'auditor' || who.startsWith('subscription')) return 'system';
  return 'other';
}

/** Cambiamenti dell'indice dopo il cutover (cal_object_versions), per tipo e per attore. */
async function changesSinceCutover(db: Db, cutoverAt: Date | null): Promise<RollbackPreviewSummary['changes_since_cutover']> {
  const out: RollbackPreviewSummary['changes_since_cutover'] = { created: 0, updated: 0, deleted: 0, by_actor: {} };
  if (!cutoverAt) return out;
  const rows = await db<Array<{ change_kind: string; actor: string | null; n: number }>>`
    SELECT v.change_kind, v.actor, count(*)::int AS n
    FROM cal_object_versions v
    WHERE v.created_at > ${cutoverAt}
      AND EXISTS (
        SELECT 1 FROM calendars c
        WHERE c.id = v.calendar_id AND c.role <> 'subscription' AND c.origin <> 'migration'
      )
    GROUP BY v.change_kind, v.actor
  `;
  for (const r of rows) {
    if (r.change_kind === 'create') out.created += r.n;
    else if (r.change_kind === 'update' || r.change_kind === 'restore') out.updated += r.n;
    else if (r.change_kind === 'delete') out.deleted += r.n;
    else continue;
    const k = actorClass(r.actor);
    out.by_actor[k] = (out.by_actor[k] ?? 0) + r.n;
  }
  return out;
}

/** Riassunto puro di un piano della proiezione inversa (degradi per classe, per calendario, derivate, REVERSE_FAILED). */
export function summarizeReversePlan(plan: Pick<ReversePlan, 'objects'>): Pick<RollbackPreviewSummary, 'objects' | 'derived_rows' | 'by_class' | 'reverse_failed' | 'calendars'> {
  const byClass: Partial<Record<DegradationClass, number>> = {};
  const calendars = new Map<string, RollbackPreviewSummary['calendars'][number]>();
  let derivedRows = 0;
  let failed = 0;
  let objects = 0;
  for (const o of plan.objects) {
    if (o.status === 'removed') continue;
    objects += 1;
    const cal = calendars.get(o.calendar_id) ?? { calendar_id: o.calendar_id, collection_name: o.collection_name, objects: 0, degraded: 0, failed: 0, derived_rows: 0 };
    cal.objects += 1;
    const derived = o.rows.filter((r) => r.role === 'derived').length;
    derivedRows += derived;
    cal.derived_rows += derived;
    if (o.status === 'failed') {
      failed += 1;
      cal.failed += 1;
      byClass.REVERSE_FAILED = (byClass.REVERSE_FAILED ?? 0) + 1;
    } else if (o.degradations.length > 0) {
      cal.degraded += 1;
    }
    for (const d of o.degradations) {
      if (d.class === 'REVERSE_FAILED' && o.status === 'failed') continue; // contato una volta per oggetto
      byClass[d.class] = (byClass[d.class] ?? 0) + 1;
    }
    calendars.set(o.calendar_id, cal);
  }
  return {
    objects,
    derived_rows: derivedRows,
    by_class: byClass,
    reverse_failed: failed,
    calendars: [...calendars.values()].sort((a, b) => a.collection_name.localeCompare(b.collection_name) || a.calendar_id.localeCompare(b.calendar_id)),
  };
}

/** Righe del run dell'anteprima: una 'degradation' per degrado, una 'object' per REVERSE_FAILED (nessun dato personale). */
function previewRows(plan: Pick<ReversePlan, 'objects'>): MigrationItemInput[] {
  const rows: MigrationItemInput[] = [];
  for (const o of plan.objects) {
    if (o.status === 'removed') continue;
    if (o.status === 'failed') {
      rows.push({
        item_type: 'object',
        calendar_id: o.calendar_id,
        collection_name: o.collection_name,
        href: o.href,
        code: 'REVERSE_FAILED',
        severity: 'error',
        detail: { object_id: o.object_id, message: (o.error?.message ?? 'proiezione non riuscita').slice(0, 300) },
      });
    }
    for (const d of o.degradations) {
      if (d.class === 'REVERSE_FAILED') continue;
      rows.push({
        item_type: 'degradation',
        calendar_id: o.calendar_id,
        collection_name: o.collection_name,
        href: o.href,
        code: d.class,
        severity: d.class.startsWith('SANITIZED_') || d.class.startsWith('REPR_LOSS_') ? 'info' : 'warning',
        detail: { object_id: o.object_id, recurrence_key: d.recurrence_key ?? null, ...(d.detail ?? {}) },
      });
    }
    if (rows.length >= PREVIEW_ROWS_MAX) break;
  }
  return rows.slice(0, PREVIEW_ROWS_MAX);
}

/**
 * Busy legacy dopo l'applicazione del piano contro il busy dell'indice
 * (180 giorni, intervalli fusi; il legacy comprende le proiezioni delle
 * prenotazioni come eventi del calendario Prenotazioni, quindi anche
 * l'indice le comprende).
 */
async function busyIdentical(db: Db, plan: Pick<ReversePlan, 'objects'>, now: Date): Promise<boolean | null> {
  const fromIso = now.toISOString();
  const toIso = new Date(now.getTime() + BUSY_HORIZON_DAYS * DAY_MS).toISOString();
  try {
    const { legacyBusyAfterPlan } = await reverseModule();
    const [legacy, index] = await Promise.all([
      legacyBusyAfterPlan(db, plan, fromIso, toIso),
      indexBusyRanges(db, fromIso, toIso, { includeBookingProjections: true }),
    ]);
    return sameBusy(legacy, index);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'confronto del busy dell\'anteprima del rollback non calcolato');
    return null;
  }
}

/** Anteprima completa (pura rispetto al database: nessuna scrittura). */
export async function computeRollbackPreview(db: Db, opts: { now: Date; signal?: AbortSignal; deps?: Partial<RollbackDeps> }): Promise<{ summary: RollbackPreviewSummary; plan: ReversePlan }> {
  const deps: RollbackDeps = { ...defaultRollbackDeps(), ...(opts.deps ?? {}) };
  const { reversePlanHash } = await reverseModule();
  const state = await readTransitionState(db);
  const plan = await deps.computeReversePlan(db, { now: opts.now, signal: opts.signal });
  const [changes, busy] = await Promise.all([changesSinceCutover(db, state.cutover_at), busyIdentical(db, plan, opts.now)]);
  const summary: RollbackPreviewSummary = {
    preview_hash: reversePlanHash(plan),
    generated_at: opts.now.toISOString(),
    cutover_at: iso(state.cutover_at),
    rollback_until: iso(state.rollback_until),
    changes_since_cutover: changes,
    ...summarizeReversePlan(plan),
    busy_identical: busy,
  };
  return { summary, plan };
}

/**
 * Run `rollback_preview` (contratto §5.1): solo in mode radicale; nessuna
 * scrittura tranne le righe del run. Il riassunto porta `preview_hash`, che
 * la richiesta di rollback riporta in `expect_preview_hash`.
 */
export async function runRollbackPreview(ctx: MigrationRunContext<RollbackPreviewParams>, depsIn: Partial<RollbackDeps> = {}): Promise<RollbackPreviewSummary> {
  const deps: RollbackDeps = { ...defaultRollbackDeps(), ...depsIn };
  const state = await readTransitionState(ctx.db);
  if (state.mode !== 'radicale') {
    throw preconditionError(`L'anteprima del rollback si calcola solo in mode radicale (adesso ${state.mode}).`, ['MODE_NOT_RADICALE']);
  }
  await ctx.progress({ phase: 'rollback_preview', message: 'Anteprima del rollback: proiezione inversa completa senza scrivere' });
  const { summary, plan } = await computeRollbackPreview(ctx.db, { now: deps.now(), signal: ctx.signal, deps });
  ctx.throwIfCancelled();
  // Righe di un tentativo precedente dello stesso run (ripresa dopo un riavvio): si rifanno da capo.
  await ctx.db`DELETE FROM cal_migration_items WHERE run_id = ${ctx.runId}::uuid`;
  const rows = previewRows(plan);
  for (let i = 0; i < rows.length; i += ROWS_CHUNK) await ctx.addItems(rows.slice(i, i + ROWS_CHUNK));
  await ctx.progress({ phase: 'done', message: `Anteprima pronta: ${plural(summary.objects, 'oggetto', 'oggetti')}, ${plural(summary.reverse_failed, 'REVERSE_FAILED', 'REVERSE_FAILED')}` });
  log.info({ objects: summary.objects, failed: summary.reverse_failed, busyIdentical: summary.busy_identical }, 'anteprima del rollback calcolata');
  return summary;
}

// ─── Preflight del rollback ───────────────────────────────

/** Run rollback_preview confermato (stato, età, hash). */
async function readPreviewRun(db: Db, runId: string | null): Promise<{ id: string; finished_at: Date; preview_hash: string | null } | null> {
  if (!runId) return null;
  const [row] = await db<Array<{ id: string; finished_at: Date | null; preview_hash: string | null }>>`
    SELECT id::text AS id, finished_at, summary->>'preview_hash' AS preview_hash
    FROM cal_migration_runs
    WHERE id = ${runId}::uuid AND kind = 'rollback_preview' AND status = 'succeeded'
  `;
  return row && row.finished_at ? { id: row.id, finished_at: row.finished_at, preview_hash: row.preview_hash } : null;
}

/**
 * Motivi che impediscono un rollback adesso (contratto §5.1, passo
 * preflight): lista vuota se si può partire. Sola lettura (l'identità si
 * legge da Radicale).
 */
export async function rollbackBlockers(
  db: Db,
  params: Pick<RollbackParams, 'preview_run_id' | 'expect_preview_hash' | 'emergency'>,
  opts: { now?: Date; deps?: Partial<RollbackDeps>; state?: MigrationBackendState } = {},
): Promise<Array<{ reason: PreconditionReason; message: string }>> {
  const deps: RollbackDeps = { ...defaultRollbackDeps(), ...(opts.deps ?? {}) };
  const now = opts.now ?? deps.now();
  const state = opts.state ?? await readTransitionState(db);
  const out: Array<{ reason: PreconditionReason; message: string }> = [];
  const modeOk = state.mode === 'radicale' || state.mode === 'rollback';
  if (!modeOk) out.push({ reason: 'MODE_NOT_RADICALE', message: `il backend è in mode ${state.mode}: il rollback parte solo da radicale` });
  if (modeOk && (!state.rollback_until || state.rollback_until.getTime() <= now.getTime())) {
    out.push({ reason: 'ROLLBACK_WINDOW_EXPIRED', message: state.rollback_until ? `finestra di rollback chiusa il ${state.rollback_until.toISOString()}` : 'nessuna finestra di rollback aperta' });
  }
  const preview = await readPreviewRun(db, params.preview_run_id);
  if (!preview) {
    out.push({ reason: 'PREVIEW_REQUIRED', message: 'serve un\'anteprima del rollback riuscita' });
  } else {
    const age = now.getTime() - preview.finished_at.getTime();
    if (!params.emergency && age > F4_LIMITS.rollbackPreviewMaxAgeMinutes * MINUTE_MS) {
      out.push({ reason: 'PREVIEW_STALE', message: `anteprima di più di ${F4_LIMITS.rollbackPreviewMaxAgeMinutes} minuti fa: ricalcolala` });
    }
    if (params.expect_preview_hash && preview.preview_hash !== params.expect_preview_hash) {
      out.push({ reason: 'PREVIEW_STALE', message: 'l\'anteprima confermata non è quella del run indicato: ricarica il passo' });
    }
    if (!params.expect_preview_hash && !params.emergency) {
      out.push({ reason: 'PREVIEW_REQUIRED', message: 'manca l\'hash dell\'anteprima confermata' });
    }
  }
  if (modeOk) {
    try {
      const check = await deps.checkIdentity(state);
      if (check.status !== 'ok') out.push({ reason: 'IDENTITY_NOT_OK', message: `identità del volume ${check.status}${check.detail ? ` (${check.detail})` : ''}` });
    } catch (err) {
      out.push({ reason: 'IDENTITY_NOT_OK', message: `identità del volume non verificabile (${describeRadicaleError(err)})` });
    }
  }
  const cp = deps.controlPlaneStatus();
  if (!cp || !cp.running || cp.lastTick?.ok !== true) {
    out.push({ reason: 'CONTROL_PLANE_UNAVAILABLE', message: 'control-plane del calendario non attivo o ultimo giro non riuscito' });
  }
  if (!deps.probeAvailable()) out.push({ reason: 'PROBE_UNAVAILABLE', message: 'RADICALE_PROBE_PASSWORD non impostata nell\'API' });
  return out;
}

// ─── Passi ───────────────────────────────

async function runIndexSyncStep(deps: RollbackDeps, emergency: boolean): Promise<Record<string, unknown>> {
  const results = await deps.syncAll();
  const failed = results.filter((r): r is CollectionSyncError => r instanceof CollectionSyncError);
  const ok = results.filter((r): r is SyncCollectionResult => !(r instanceof CollectionSyncError));
  if (failed.length && !emergency) {
    throw new TransitionError('CALENDAR_UNAVAILABLE', `Sync finale non riuscita per ${plural(failed.length, 'collezione', 'collezioni')} (${failed.map((f) => f.code).join(', ')}): riprendi il rollback quando Radicale risponde, o usa il rollback di emergenza.`, {
      runErrorCode: 'RADICALE_UNREACHABLE',
      details: { failed: failed.map((f) => ({ calendar_id: f.calendarId, code: f.code })) },
    });
  }
  if (failed.length) log.warn({ failed: failed.map((f) => f.calendarId) }, 'rollback di emergenza: sync finale con errori, l\'indice è la miglior conoscenza');
  const held = ok.filter((r) => r.status === 'held').map((r) => r.calendarId);
  return {
    collections: results.length,
    synced: ok.filter((r) => r.status === 'synced').length,
    unchanged: ok.filter((r) => r.status === 'unchanged').length,
    held,
    failed: failed.length,
    failed_collections: failed.map((f) => ({ calendar_id: f.calendarId, code: f.code })),
  };
}

async function runControlPlaneStep(handle: TransitionHandle, deps: RollbackDeps): Promise<Record<string, unknown>> {
  const E1 = handle.record.epoch_before + 1;
  let last = 'nessun giro';
  for (let attempt = 1; attempt <= CONTROL_PLANE_ATTEMPTS; attempt++) {
    const tick = await deps.controlPlaneSync();
    if (!tick) {
      throw new TransitionError('PRECONDITION_FAILED', 'Control-plane non attivo nel processo: policy e heartbeat con il nuovo epoch non scritti. Riavvia l\'API con il control-plane e riprendi il rollback.', {
        runErrorCode: 'CONTROL_PLANE_UNAVAILABLE', reasons: ['CONTROL_PLANE_UNAVAILABLE'],
      });
    }
    const aligned = tick.ok && tick.state?.mode === 'postgres' && tick.state.epoch === E1 && tick.policy?.mode === 'shadow' && tick.heartbeat !== null;
    if (aligned) {
      const identity = await deps.verifyIdentity();
      if (identity.status === 'ok') {
        return {
          policy: { mode: tick.policy?.mode ?? null, version: tick.policy?.version ?? null, reasons: [...(tick.policy?.reasons ?? [])] },
          heartbeat: { ts: tick.heartbeat?.ts ?? null, mode: tick.state?.mode ?? null, epoch: tick.state?.epoch ?? null },
          identity: { status: identity.status, checked_at: identity.checkedAt, marker_epoch: identity.marker?.epoch ?? null },
          attempts: attempt,
        };
      }
      last = `identità ${identity.status}${identity.detail ? ` (${identity.detail})` : ''}`;
    } else {
      last = tick.ok
        ? `policy ${tick.policy?.mode ?? '-'} per mode ${tick.state?.mode ?? '-'} ed epoch ${tick.state?.epoch ?? '-'}`
        : `giro fallito (${tick.failedStage ?? 'sconosciuto'})`;
    }
    if (attempt < CONTROL_PLANE_ATTEMPTS) await deps.sleep(CONTROL_PLANE_RETRY_MS);
  }
  throw new TransitionError('CALENDAR_UNAVAILABLE', `Policy e heartbeat non allineati al nuovo epoch ${E1}: ${last}. I device restano chiusi; riprendi il rollback.`, {
    runErrorCode: 'CONTROL_PLANE_UNAVAILABLE',
  });
}

async function runCleanupStep(db: Db): Promise<Record<string, unknown>> {
  // Validatori del pull legacy delle iscrizioni (§3.6): il pull ripartito in mode postgres riscarica i feed.
  const reset = await db`
    UPDATE calendar_subscriptions SET etag = NULL, last_modified = NULL
    WHERE etag IS NOT NULL OR last_modified IS NOT NULL
    RETURNING id
  `;
  const { closePendingReverseProjectionJobs } = await reverseModule();
  const dropped = await closePendingReverseProjectionJobs(db, 'rollback');
  const [bookings] = await db<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM cal_jobs WHERE kind = ${CAL_JOB_KINDS.projectBooking} AND status IN ('pending', 'running')
  `;
  return { subscriptions_reset: reset.length, reverse_jobs_dropped: dropped, project_booking_pending: bookings?.n ?? 0 };
}

// ─── Riassunto ───────────────────────────────

async function buildSummary(handle: TransitionHandle, outcome: 'completed' | 'aborted', abortReason: string | null): Promise<RollbackSummary> {
  const db = handle.ctx.db;
  const journal = await readJournal(db, handle.record.id);
  const data = (step: string): Record<string, unknown> | null => {
    const j = journal.find((s) => s.step === step && (s.status === 'done' || s.status === 'skipped'));
    return j ? j.data : null;
  };
  const sync = data('index_sync');
  const reverse = data('reverse_final');
  const tdata = handle.record.data;
  return {
    transition_id: handle.record.id,
    outcome,
    abort_reason: abortReason,
    emergency: tdata.emergency === true,
    preview_hash: typeof tdata.expect_preview_hash === 'string' ? tdata.expect_preview_hash : null,
    final_preview_hash: typeof tdata.final_preview_hash === 'string' ? tdata.final_preview_hash : (typeof reverse?.hash === 'string' ? reverse.hash : null),
    epoch_before: handle.record.epoch_before,
    epoch_after: handle.record.epoch_after,
    quiescence: (data('quiesce') as unknown as QuiescenceReport | null) ?? null,
    index_sync: sync ? { collections: Number(sync.collections ?? 0), failed: Number(sync.failed ?? 0) } : null,
    reverse: (reverse?.summary as ReverseApplySummary | undefined) ?? null,
    rebaseline: (data('rebaseline') as unknown as RebaselineSummary | null) ?? null,
    steps: await journalViews(handle),
  };
}

/** Annulla il rollback prima del passo d'epoch e fa fallire il run con ROLLBACK_ABORTED e il riassunto. */
async function abortRollback(handle: TransitionHandle, code: string, reason: string, extra: Record<string, unknown> = {}): Promise<never> {
  await abortTransition(handle, { code, reason });
  const summary = await buildSummary(handle, 'aborted', reason);
  log.warn({ transitionId: handle.record.id, code, reason }, 'rollback annullato: backend di nuovo in mode radicale');
  throw new TransitionError('PRECONDITION_FAILED', `Rollback annullato, Radicale resta autorevole: ${reason}.`, {
    runErrorCode: 'ROLLBACK_ABORTED',
    details: { transition_id: handle.record.id, abort_code: code, summary, ...extra },
  });
}

// ─── Run `rollback` ───────────────────────────────

/** Run `rollback` (contratto §5.1): avvio, ripresa o annullamento della transizione. */
export async function runRollback(ctx: MigrationRunContext<RollbackParams>): Promise<RollbackSummary> {
  return runRollbackWith(ctx, defaultRollbackDeps());
}

/** Come runRollback con le dipendenze esplicite (test). */
export async function runRollbackWith(ctx: MigrationRunContext<RollbackParams>, depsIn: Partial<RollbackDeps> = {}): Promise<RollbackSummary> {
  const deps: RollbackDeps = { ...defaultRollbackDeps(), ...depsIn };
  const params = normalizeRollbackParams(ctx.params);
  const tctx: TransitionContext = { ...transitionContextFromRun(ctx as MigrationRunContext<unknown>), now: deps.now };

  // Stesso run ripreso dall'esecutore dopo che la transizione si era già conclusa: l'esito registrato.
  const latest = await getLatestTransition(ctx.db, 'rollback');
  if (latest && latest.status !== 'active' && latest.run_id === ctx.runId) {
    const done: TransitionHandle = { ctx: tctx, record: latest };
    if (latest.status === 'completed') return buildSummary(done, 'completed', null);
    const summary = await buildSummary(done, 'aborted', latest.outcome);
    if (params.action === 'abort') return summary;
    throw new TransitionError('PRECONDITION_FAILED', `Rollback annullato, Radicale resta autorevole: ${latest.outcome ?? 'annullato'}.`, {
      runErrorCode: 'ROLLBACK_ABORTED',
      details: { transition_id: latest.id, abort_code: latest.outcome_code, summary },
    });
  }

  if (params.action === 'abort') {
    const { handle } = await beginTransition({ ctx: tctx, kind: 'rollback', resume: true });
    const reason = 'annullato dall\'admin';
    await abortTransition(handle, { code: 'ROLLBACK_ABORTED', reason });
    log.warn({ transitionId: handle.record.id, actor: ctx.actor }, 'rollback annullato dall\'admin: backend di nuovo in mode radicale');
    return buildSummary(handle, 'aborted', reason);
  }

  const { handle, resumed } = await beginTransition({
    ctx: tctx,
    kind: 'rollback',
    resume: params.action === 'resume',
    data: { preview_run_id: params.preview_run_id, expect_preview_hash: params.expect_preview_hash, emergency: params.emergency },
  });
  // I parametri confermati sono quelli registrati all'avvio della transizione (una ripresa non li cambia).
  const tdata = handle.record.data;
  const expectHash = typeof tdata.expect_preview_hash === 'string' ? tdata.expect_preview_hash : params.expect_preview_hash;
  const previewRunId = typeof tdata.preview_run_id === 'string' ? tdata.preview_run_id : params.preview_run_id;
  const emergency = typeof tdata.emergency === 'boolean' ? tdata.emergency : params.emergency;
  const total = ROLLBACK_STEPS.length;
  const progress = (index: number, message: string): Promise<void> => ctx.progress({ phase: ROLLBACK_STEPS[index], done: index, total, message });
  if (resumed) log.info({ transitionId: handle.record.id, runId: ctx.runId, attempt: ctx.attempt }, 'ripresa del rollback dal primo passo non concluso');

  // 1. Preflight (nessuno stato toccato: un fallimento lascia la transizione annullabile).
  await progress(0, 'Controllo delle condizioni del rollback');
  const preflight = async (): Promise<Record<string, unknown>> => {
    await deps.controlPlaneSync().catch(() => null);
    const blockers = await rollbackBlockers(ctx.db, { preview_run_id: previewRunId, expect_preview_hash: expectHash, emergency }, { now: deps.now(), deps });
    if (blockers.length) {
      throw preconditionError(
        `Rollback non ancora possibile: ${blockers.map((b) => b.message).join('; ')}`,
        [...new Set(blockers.map((b) => b.reason))],
      );
    }
    return { preview_run_id: previewRunId, expect_preview_hash: expectHash, emergency };
  };
  const preflightDoneBefore = (await completedStep(handle, 'preflight')) !== null;
  await runStep(handle, 'preflight', preflight);
  if (preflightDoneBefore && !(await completedStep(handle, 'freeze'))) {
    // Ripresa prima del freeze: le condizioni si ricontrollano adesso (l'anteprima può essere invecchiata).
    await preflight();
  }

  // 2. Freeze: prima lo stato, poi la policy frozen (i device non scrivono più).
  await progress(1, 'Scritture sospese: mode rollback, device in sola lettura');
  await freezeStep(handle);

  // 3. Gate esclusivo e quiescenza dei device (il probe passa da 2xx a 403).
  await progress(2, 'Attesa delle scritture in corso e quiescenza dei device');
  await quiesceStep(handle, (await completedStep(handle, 'quiesce')) ? undefined : deps.quiescence());

  // 4. Sync finale dell'indice.
  await progress(3, 'Sync finale dell\'indice');
  await runStep(handle, 'index_sync', async () => runIndexSyncStep(deps, emergency));

  // 5. Passata finale della proiezione inversa, con il confronto dell'anteprima confermata.
  await progress(4, 'Passata finale della proiezione inversa verso Postgres');
  if (!(await completedStep(handle, 'reverse_final'))) {
    const { reversePlanHash } = await reverseModule();
    const plan = await deps.computeReversePlan(ctx.db, { now: deps.now(), signal: ctx.signal });
    const finalHash = reversePlanHash(plan);
    await mergeTransitionData(handle, { final_preview_hash: finalHash });
    if (expectHash && finalHash !== expectHash && !emergency) {
      const { summary: preview } = await computeRollbackPreview(ctx.db, { now: deps.now(), signal: ctx.signal, deps: { ...deps, computeReversePlan: async () => plan } });
      await abortRollback(handle, 'PREVIEW_CHANGED', 'l\'anteprima ricalcolata dopo la quiescenza è diversa da quella confermata (degradi o oggetti cambiati)', { preview });
    }
    await runStep(handle, 'reverse_final', async () => {
      const summary = await deps.applyReversePlan(ctx.db, plan, { actor: ctx.actor, runId: ctx.runId, signal: ctx.signal });
      if (summary.failed > 0) log.warn({ failed: summary.failed }, 'passata finale con REVERSE_FAILED: oggetti senza righe legacy (restano nel volume)');
      return { hash: finalHash, matches_preview: expectHash ? finalHash === expectHash : null, summary: summary as unknown as Record<string, unknown> };
    });
  }

  // 6. Ri-baseline del ledger.
  await progress(5, 'Ri-baseline del ledger della migrazione');
  await runStep(handle, 'rebaseline', async () => (await deps.rebaseline({ db: ctx.db, actor: ctx.actor, runId: ctx.runId, signal: ctx.signal })) as unknown as Record<string, unknown>);

  // 7. Epoch: punto di non ritorno.
  await progress(6, 'Cambio di epoch: Postgres torna la fonte del calendario');
  const { client, principal } = deps.radicale();
  await epochStep(handle, { client, principal }, {
    set: { write_freeze: false, rollback_until: null, cutover_at: null, cutover_by: null },
  });

  // 8. Policy shadow e heartbeat postgres con il nuovo epoch.
  await progress(7, 'Policy dei device (sola lettura) e heartbeat con il nuovo epoch');
  await runStep(handle, 'control_plane', async () => runControlPlaneStep(handle, deps));

  // 9. Pulizia.
  await progress(8, 'Pulizia: iscrizioni da riscaricare e proiezione inversa ferma');
  await runStep(handle, 'cleanup', async () => runCleanupStep(ctx.db));

  await completeTransition(handle, { outcome: emergency ? 'Rollback di emergenza a Postgres completato' : 'Rollback a Postgres completato' });
  await ctx.progress({ phase: 'done', done: total, total, message: 'Rollback completato: Postgres è di nuovo autorevole' });
  log.info({ transitionId: handle.record.id, epoch: handle.record.epoch_after, emergency }, 'rollback completato: mode postgres, policy shadow, volume intatto come archivio');
  return buildSummary(handle, 'completed', null);
}
