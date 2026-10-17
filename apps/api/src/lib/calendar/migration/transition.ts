/**
 * Transizioni di stato del calendario (fase F4 del passaggio a Radicale;
 * design §13.9-§13.13; contratto docs/calendar-radicale/contracts/
 * f4-modules.md §2). Fondazione comune di cutover.ts, rollback.ts e
 * finalize.ts: nessuno di quei moduli cambia `calendar_backend_state` o il
 * marker del volume se non attraverso le funzioni di questo file.
 *
 * Schema di ogni transizione che riduce i permessi dei device (design §13.9):
 *  1. **Prima lo stato** (freezeStep): in una transazione si scrivono `mode`
 *     (cutover o rollback) e `write_freeze`, con la riga del journal nella
 *     stessa transazione. La policy la riscrive poi il control-plane con
 *     policyFromState(): nessun riavvio o riconciliatore può riportarla a
 *     live, perché deriva dallo stato. La SELECT … FOR UPDATE della riga di
 *     stato è anche la barriera delle scritture legacy: la guardia 166 legge
 *     lo stato con FOR SHARE, quindi l'UPDATE attende chi ha già scritto
 *     calendar_events e ogni scrittura successiva fallisce;
 *  2. **Gate di scrittura dell'API** (quiesceStep): lock esclusivo
 *     `cal-write` (withExclusiveCalendarWriteGate): attende le scritture di
 *     RadicaleStore e dei job in corso; le nuove, entrate dopo, rileggono lo
 *     stato dentro il gate e ricevono 503 `transition` (o `write_freeze`);
 *  3. **Quiescenza dei device** (awaitDeviceQuiescence, dentro il gate):
 *     giro del control-plane con la policy frozen, attesa di almeno 2 s oltre
 *     il ricontrollo di 1 s dei plugin, PUT del probe su `_canary` che deve
 *     ricevere 403 (fino a 10 tentativi), `stat` delle collezioni (o
 *     PROPFIND di getctag e sync-token senza mount) finché due letture
 *     consecutive a 1 s coincidono;
 *  4. solo a quel punto il modulo della transizione scatta la fotografia
 *     (delta del cutover, sync finale e proiezione inversa del rollback).
 *
 * Il passo d'epoch (epochStep) fa PROPPATCH di `epoch + 1` sul principal e
 * poi, in una transazione, scrive mode d'arrivo ed epoch; fra i due il
 * mismatch d'epoch tiene i device chiusi (fail-closed). È il punto di non
 * ritorno: prima si può annullare (abortTransition), dopo no.
 *
 * Journal (cal_migration_transitions, cal_migration_journal, migrazione
 * 166): ogni passo è registrato come iniziato, concluso, saltato o fallito; i
 * passi che cambiano lo stato scrivono `done` nella stessa transazione
 * dell'UPDATE. Una ripresa dopo un crash (stesso run dopo il lease scaduto, o
 * un run nuovo con action 'resume') riparte dal primo passo non concluso con
 * lo stato già scritto; i passi senza effetti sullo stato sono idempotenti e
 * si ripetono.
 *
 * Lock: le transizioni girano come run dello strumento (runs.ts), quindi
 * dentro `cal-migration`; il gate `cal-write` si prende dopo (ordine
 * cal-migration → cal-write, mai il contrario). Dentro il gate esclusivo
 * nessuna chiamata usa il pool calendario (regola 1 contro lo stallo, f2
 * §1.3): le collezioni si leggono dal pool principale e la quiescenza fa solo
 * HTTP e stat.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { invalidateBackendModeCache } from '../backend-mode';
import { isCalendarUnavailable } from '../errors';
import { objectPath, RadicaleClient, collectionPath } from '../radicale/client';
import { DAV_PROPS } from '../radicale/dav-xml';
import { isRadicaleError } from '../radicale/errors';
import { type ControlPlaneTick, getCalendarControlPlane, requestControlPlaneSync } from '../radicale/heartbeat';
import { readVolumeMarkerRemote, writeVolumeMarker } from '../radicale/identity';
import type { Db } from '../radicale/policy';
import {
  currentWatchMode,
  invalidateIdentityCache,
  radicaleCollections,
  radicaleRuntime,
  statMtimeNs,
  collectionDirPath,
  principalDirPath,
} from '../radicale/sync';
import { type BackendMode, CANARY_COLLECTION, PROBE_USER } from '../radicale/types';
import { withExclusiveCalendarWriteGate } from '../radicale/write-gate';
import { describeRadicaleError, readMigrationStateFresh } from './preflight';
import {
  CALENDAR_EVENTS_GUARD_SQLSTATE,
  CUTOVER_STEPS,
  F4_LIMITS,
  FINALIZE_STEPS,
  type JournalStepStatus,
  type JournalStepView,
  type MigrationBackendState,
  MigrationError,
  type MigrationErrorCode,
  type MigrationRunContext,
  type MigrationRunErrorCode,
  POINT_OF_NO_RETURN_STEP,
  type PreconditionReason,
  type QuiescenceReport,
  ROLLBACK_STEPS,
  TRANSITION_ABORT_STEP,
  TRANSITION_MODES,
  type TransitionKind,
  type TransitionStatus,
  type TransitionView,
} from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-transition' });

// ─── Errori ───────────────────────────────

/**
 * Errore di una transizione: codice REST (MigrationErrorCode) e codice del run
 * (details.run_error_code, che l'esecutore di runs.ts usa come error_code).
 * Messaggi in italiano, mai dati personali.
 */
export class TransitionError extends MigrationError {
  constructor(code: MigrationErrorCode, message: string, opts: { runErrorCode?: MigrationRunErrorCode; reasons?: PreconditionReason[]; details?: Record<string, unknown> } = {}) {
    const details: Record<string, unknown> = { ...(opts.details ?? {}) };
    if (opts.runErrorCode) details.run_error_code = opts.runErrorCode;
    if (opts.reasons) details.reasons = opts.reasons;
    super(code, message, Object.keys(details).length ? details : undefined);
    this.name = 'TransitionError';
  }
}

/**
 * true se `err` (o una sua causa) è il rifiuto della guardia 166 di
 * calendar_events: SQLSTATE CD166, una scrittura legacy fuori da mode
 * postgres. Chi la incontra la tratta come indisponibilità per transizione.
 */
export function isCalendarEventsGuardError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if ((current as { code?: unknown }).code === CALENDAR_EVENTS_GUARD_SQLSTATE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ─── Contesto, record e lettura ───────────────────────────────

/** Contesto di una transizione: lo costruisce il modulo del tipo dal contesto del run. */
export interface TransitionContext {
  /** Pool principale: transazioni brevi, mai attorno all'HTTP. */
  readonly db: Db;
  readonly runId: string | null;
  /** Attore di audit (admin:<id>, system:...). */
  readonly actor: string;
  readonly log: Logger;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/** Contesto della transizione dal contesto di un run (cutover, rollback, finalize). */
export function transitionContextFromRun(ctx: MigrationRunContext<unknown>): TransitionContext {
  return { db: ctx.db, runId: ctx.runId, actor: ctx.actor, log: ctx.log, signal: ctx.signal };
}

/** Riga di cal_migration_transitions. */
export interface TransitionRecord {
  id: string;
  kind: TransitionKind;
  status: TransitionStatus;
  from_mode: BackendMode;
  target_mode: BackendMode;
  run_id: string | null;
  epoch_before: number;
  epoch_after: number | null;
  started_by: string;
  started_at: Date;
  finished_at: Date | null;
  outcome_code: string | null;
  outcome: string | null;
  data: Record<string, unknown>;
}

/** Riga di cal_migration_journal. */
export interface JournalStepRecord {
  transition_id: string;
  step: string;
  seq: number;
  status: JournalStepStatus;
  attempts: number;
  run_id: string | null;
  data: Record<string, unknown>;
  error_code: string | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

/** Transizione aperta da beginTransition: record aggiornato dalle funzioni di questo file. */
export interface TransitionHandle {
  readonly ctx: TransitionContext;
  record: TransitionRecord;
}

const TRANSITION_COLUMNS = [
  'id', 'kind', 'status', 'from_mode', 'target_mode', 'run_id', 'epoch_before', 'epoch_after',
  'started_by', 'started_at', 'finished_at', 'outcome_code', 'outcome', 'data',
] as const;

const JOURNAL_COLUMNS = [
  'transition_id', 'step', 'seq', 'status', 'attempts', 'run_id', 'data', 'error_code', 'error', 'started_at', 'finished_at',
] as const;

function toTransition(row: Record<string, unknown>): TransitionRecord {
  return {
    id: String(row.id),
    kind: row.kind as TransitionKind,
    status: row.status as TransitionStatus,
    from_mode: row.from_mode as BackendMode,
    target_mode: row.target_mode as BackendMode,
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    epoch_before: Number(row.epoch_before),
    epoch_after: row.epoch_after === null || row.epoch_after === undefined ? null : Number(row.epoch_after),
    started_by: String(row.started_by),
    started_at: row.started_at as Date,
    finished_at: (row.finished_at as Date | null) ?? null,
    outcome_code: (row.outcome_code as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    data: (row.data as Record<string, unknown>) ?? {},
  };
}

function toJournal(row: Record<string, unknown>): JournalStepRecord {
  return {
    transition_id: String(row.transition_id),
    step: String(row.step),
    seq: Number(row.seq),
    status: row.status as JournalStepStatus,
    attempts: Number(row.attempts),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    data: (row.data as Record<string, unknown>) ?? {},
    error_code: (row.error_code as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    started_at: row.started_at as Date,
    finished_at: (row.finished_at as Date | null) ?? null,
  };
}

/** Passi nell'ordine di un tipo di transizione (types.ts). */
export function stepsOf(kind: TransitionKind): readonly string[] {
  if (kind === 'cutover') return CUTOVER_STEPS;
  if (kind === 'rollback') return ROLLBACK_STEPS;
  return FINALIZE_STEPS;
}

/** Stato del backend con le colonne della 165, riletto senza cache. */
export function readTransitionState(db: Db = sql): Promise<MigrationBackendState> {
  return readMigrationStateFresh(db);
}

/** Transizione attiva (in corso o da riprendere), se c'è. */
export async function getActiveTransition(db: Db = sql): Promise<TransitionRecord | null> {
  const rows = await db`
    SELECT ${db(TRANSITION_COLUMNS as unknown as string[])} FROM cal_migration_transitions WHERE status = 'active'
  `;
  return rows.length ? toTransition(rows[0]) : null;
}

export async function getTransition(db: Db, id: string): Promise<TransitionRecord | null> {
  const rows = await db`
    SELECT ${db(TRANSITION_COLUMNS as unknown as string[])} FROM cal_migration_transitions WHERE id = ${id}::uuid
  `;
  return rows.length ? toTransition(rows[0]) : null;
}

/** Ultima transizione (attiva o conclusa) di un tipo, o di qualsiasi tipo. */
export async function getLatestTransition(db: Db = sql, kind?: TransitionKind): Promise<TransitionRecord | null> {
  const rows = await db`
    SELECT ${db(TRANSITION_COLUMNS as unknown as string[])} FROM cal_migration_transitions
    ${kind ? db`WHERE kind = ${kind}` : db``}
    ORDER BY (status = 'active') DESC, started_at DESC
    LIMIT 1
  `;
  return rows.length ? toTransition(rows[0]) : null;
}

export async function readJournal(db: Db, transitionId: string): Promise<JournalStepRecord[]> {
  const rows = await db`
    SELECT ${db(JOURNAL_COLUMNS as unknown as string[])} FROM cal_migration_journal
    WHERE transition_id = ${transitionId}::uuid ORDER BY seq
  `;
  return Array.from(rows, (r) => toJournal(r as Record<string, unknown>));
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function journalView(j: JournalStepRecord): JournalStepView {
  return {
    step: j.step,
    seq: j.seq,
    status: j.status,
    attempts: j.attempts,
    run_id: j.run_id,
    started_at: j.started_at.toISOString(),
    finished_at: iso(j.finished_at),
    error_code: j.error_code,
    error: j.error,
    data: j.data,
  };
}

/** Primo passo non concluso (né done né skipped) nell'ordine del tipo; null se concluso tutto. */
export function nextPendingStep(kind: TransitionKind, journal: readonly JournalStepRecord[]): string | null {
  const finished = new Set(journal.filter((j) => j.status === 'done' || j.status === 'skipped').map((j) => j.step));
  return stepsOf(kind).find((s) => !finished.has(s)) ?? null;
}

/** true se il passo d'epoch è concluso: la transizione non si annulla più. */
export function pastPointOfNoReturn(journal: readonly JournalStepRecord[]): boolean {
  return journal.some((j) => j.step === POINT_OF_NO_RETURN_STEP && j.status === 'done');
}

/**
 * DTO della transizione per il wizard e le route (types.ts TransitionView).
 * `runActive`: c'è un run queued/running che la sta eseguendo (lo passa chi
 * conosce i run, runs.ts): senza, una transizione attiva è da riprendere.
 */
export function buildTransitionView(record: TransitionRecord, journal: readonly JournalStepRecord[], opts: { runActive: boolean }): TransitionView {
  const active = record.status === 'active';
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    from_mode: record.from_mode,
    target_mode: record.target_mode,
    run_id: record.run_id,
    epoch_before: record.epoch_before,
    epoch_after: record.epoch_after,
    started_by: record.started_by,
    started_at: record.started_at.toISOString(),
    finished_at: iso(record.finished_at),
    outcome_code: record.outcome_code,
    outcome: record.outcome,
    data: record.data,
    steps: journal.map(journalView),
    next_step: active ? nextPendingStep(record.kind, journal) : null,
    resumable: active && !opts.runActive,
    abortable: active && record.kind !== 'finalize' && !pastPointOfNoReturn(journal),
  };
}

/** Vista della transizione attiva, o dell'ultima conclusa, con i passi (null se non ce n'è mai stata una). */
export async function readTransitionView(db: Db = sql, opts: { runActive?: boolean } = {}): Promise<TransitionView | null> {
  const record = await getLatestTransition(db);
  if (!record) return null;
  return buildTransitionView(record, await readJournal(db, record.id), { runActive: opts.runActive ?? false });
}

// ─── Hook dei test ───────────────────────────────

/** Punti in cui i test simulano un crash o una pausa fra due passi. */
export interface TransitionTestHooks {
  /** Prima di eseguire un passo (anche se poi risulta già concluso). */
  beforeStep?: (kind: TransitionKind, step: string) => void | Promise<void>;
  /** Dopo che un passo è stato registrato come concluso (o saltato). */
  afterStep?: (kind: TransitionKind, step: string) => void | Promise<void>;
  /** Dentro il gate esclusivo, prima della quiescenza (scritture e job in attesa). */
  insideGate?: (kind: TransitionKind) => void | Promise<void>;
}

let testHooks: TransitionTestHooks | null = null;

/** Imposta gli hook dei test (null li toglie). Vietato con NODE_ENV=production. */
export function setTransitionTestHooks(hooks: TransitionTestHooks | null): void {
  if (hooks && process.env.NODE_ENV === 'production') throw new Error('setTransitionTestHooks: vietato in produzione');
  testHooks = hooks;
}

// ─── Inizio e ripresa ───────────────────────────────

function nowOf(ctx: TransitionContext): Date {
  return ctx.now ? ctx.now() : new Date();
}

function throwIfAborted(ctx: TransitionContext): void {
  if (ctx.signal?.aborted) throw new MigrationError('CANCELLED', 'Transizione interrotta: riprende dal passo corrente');
}

function modeReason(kind: TransitionKind): PreconditionReason {
  return TRANSITION_MODES[kind].from === 'postgres' ? 'MODE_NOT_POSTGRES' : 'MODE_NOT_RADICALE';
}

const MODE_LABEL: Readonly<Record<BackendMode, string>> = Object.freeze({
  postgres: 'postgres', cutover: 'cutover (passaggio in corso)', radicale: 'radicale', rollback: 'rollback (ritorno in corso)', finalized: 'finalized',
});

/**
 * Apre una transizione o riprende quella attiva dello stesso tipo
 * (contratto f4-modules §2.2):
 *  - un'altra transizione attiva → TRANSITION_IN_PROGRESS (details.transition);
 *  - quella dello stesso tipo → ripresa (run_id aggiornato), `resumed: true`;
 *  - nessuna, con `resume` → PRECONDITION_FAILED NO_ACTIVE_TRANSITION;
 *  - nessuna → mode di partenza del tipo (TRANSITION_MODES) e volume
 *    inizializzato, poi la riga nuova con epoch_before = epoch corrente.
 * Non cambia lo stato del backend: lo fanno i passi.
 */
export async function beginTransition(opts: {
  ctx: TransitionContext;
  kind: TransitionKind;
  data?: Record<string, unknown>;
  resume?: boolean;
}): Promise<{ handle: TransitionHandle; resumed: boolean }> {
  const { ctx, kind } = opts;
  const db = ctx.db;
  const active = await getActiveTransition(db);
  if (active) {
    if (active.kind !== kind) {
      throw new TransitionError('TRANSITION_IN_PROGRESS', `È attiva una transizione ${active.kind}: va conclusa o annullata prima di avviarne un'altra.`, {
        runErrorCode: 'TRANSITION_CONFLICT',
        reasons: ['TRANSITION_ACTIVE'],
        details: { transition: { id: active.id, kind: active.kind, status: active.status } },
      });
    }
    const rows = await db`
      UPDATE cal_migration_transitions SET run_id = ${ctx.runId}::uuid
      WHERE id = ${active.id}::uuid AND status = 'active'
      RETURNING ${db(TRANSITION_COLUMNS as unknown as string[])}
    `;
    if (!rows.length) throw new TransitionError('TRANSITION_IN_PROGRESS', 'La transizione è cambiata durante la ripresa: riprova.', { runErrorCode: 'TRANSITION_CONFLICT' });
    const record = toTransition(rows[0]);
    ctx.log.info({ transitionId: record.id, kind, runId: ctx.runId }, 'ripresa della transizione');
    return { handle: { ctx, record }, resumed: true };
  }
  if (opts.resume) {
    throw new TransitionError('PRECONDITION_FAILED', `Nessuna transizione ${kind} da riprendere.`, { runErrorCode: 'PRECONDITION_FAILED', reasons: ['NO_ACTIVE_TRANSITION'] });
  }
  const state = await readTransitionState(db);
  const modes = TRANSITION_MODES[kind];
  if (state.mode !== modes.from) {
    throw new TransitionError('PRECONDITION_FAILED', `La transizione ${kind} parte da mode ${modes.from}; il backend è in ${MODE_LABEL[state.mode]}.`, {
      runErrorCode: 'PRECONDITION_FAILED',
      reasons: [modeReason(kind)],
      details: { mode: state.mode },
    });
  }
  if (state.epoch < 1 || !state.volume_id) {
    throw new TransitionError('PRECONDITION_FAILED', 'Volume di Radicale non inizializzato: nessuna transizione possibile.', { runErrorCode: 'PRECONDITION_FAILED', reasons: ['IDENTITY_NOT_OK'] });
  }
  try {
    const rows = await db`
      INSERT INTO cal_migration_transitions (kind, from_mode, target_mode, run_id, epoch_before, started_by, data)
      VALUES (${kind}, ${modes.from}, ${modes.to}, ${ctx.runId}::uuid, ${state.epoch}, ${ctx.actor.slice(0, 200)}, ${db.json((opts.data ?? {}) as never)})
      RETURNING ${db(TRANSITION_COLUMNS as unknown as string[])}
    `;
    const record = toTransition(rows[0]);
    ctx.log.info({ transitionId: record.id, kind, epoch: state.epoch, runId: ctx.runId }, 'transizione avviata');
    return { handle: { ctx, record }, resumed: false };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new TransitionError('TRANSITION_IN_PROGRESS', 'Un\'altra transizione è stata avviata nel frattempo.', { runErrorCode: 'TRANSITION_CONFLICT', reasons: ['TRANSITION_ACTIVE'] });
    }
    throw err;
  }
}

/** Ricarica il record della transizione (dopo i passi che lo aggiornano). */
export async function refreshTransition(handle: TransitionHandle): Promise<TransitionRecord> {
  const record = await getTransition(handle.ctx.db, handle.record.id);
  if (!record) throw new TransitionError('INTERNAL', 'Transizione sparita dal journal', { runErrorCode: 'INTERNAL' });
  handle.record = record;
  return record;
}

/** Aggiorna `data` della transizione (unione superficiale delle chiavi). */
export async function mergeTransitionData(handle: TransitionHandle, patch: Record<string, unknown>): Promise<void> {
  const db = handle.ctx.db;
  await db`
    UPDATE cal_migration_transitions SET data = data || ${db.json(patch as never)}
    WHERE id = ${handle.record.id}::uuid
  `;
  handle.record = { ...handle.record, data: { ...handle.record.data, ...patch } };
}

// ─── Journal ───────────────────────────────

async function journalRow(db: Db, transitionId: string, step: string): Promise<JournalStepRecord | null> {
  const rows = await db`
    SELECT ${db(JOURNAL_COLUMNS as unknown as string[])} FROM cal_migration_journal
    WHERE transition_id = ${transitionId}::uuid AND step = ${step}
  `;
  return rows.length ? toJournal(rows[0]) : null;
}

/** Registra l'inizio (o un nuovo tentativo) di un passo. */
async function markStarted(db: Db, handle: TransitionHandle, step: string): Promise<JournalStepRecord> {
  const rows = await db`
    INSERT INTO cal_migration_journal (transition_id, step, seq, status, attempts, run_id)
    VALUES (
      ${handle.record.id}::uuid, ${step},
      (SELECT COALESCE(MAX(seq) + 1, 0) FROM cal_migration_journal WHERE transition_id = ${handle.record.id}::uuid),
      'started', 1, ${handle.ctx.runId}::uuid
    )
    ON CONFLICT (transition_id, step) DO UPDATE SET
      status = 'started', attempts = cal_migration_journal.attempts + 1, run_id = EXCLUDED.run_id,
      error_code = NULL, error = NULL, finished_at = NULL, started_at = now()
    WHERE cal_migration_journal.status NOT IN ('done', 'skipped')
    RETURNING ${db(JOURNAL_COLUMNS as unknown as string[])}
  `;
  if (rows.length) return toJournal(rows[0]);
  const existing = await journalRow(db, handle.record.id, step);
  if (!existing) throw new TransitionError('INTERNAL', `Passo ${step} non registrabile nel journal`, { runErrorCode: 'INTERNAL' });
  return existing;
}

async function markDone(db: Db, handle: TransitionHandle, step: string, data: Record<string, unknown>, status: 'done' | 'skipped' = 'done'): Promise<void> {
  const rows = await db`
    UPDATE cal_migration_journal
    SET status = ${status}, data = ${db.json(data as never)}, finished_at = now(), error_code = NULL, error = NULL, run_id = ${handle.ctx.runId}::uuid
    WHERE transition_id = ${handle.record.id}::uuid AND step = ${step}
    RETURNING step
  `;
  if (!rows.length) throw new TransitionError('INTERNAL', `Passo ${step} assente dal journal`, { runErrorCode: 'INTERNAL' });
}

function errorCodeOf(err: unknown): string {
  if (err instanceof MigrationError) {
    const fromDetails = err.details?.run_error_code;
    if (typeof fromDetails === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(fromDetails)) return fromDetails;
    return err.code;
  }
  if (isRadicaleError(err)) return 'RADICALE_UNREACHABLE';
  if (isCalendarUnavailable(err)) return 'CALENDAR_UNAVAILABLE';
  return 'INTERNAL';
}

/** Messaggio salvato nel journal: solo testi dei moduli (in italiano, senza dati personali), mai messaggi grezzi. */
function errorMessageOf(err: unknown): string {
  if (err instanceof MigrationError) return err.message.slice(0, 1000);
  if (isRadicaleError(err)) return `Errore di Radicale (${describeRadicaleError(err)})`;
  if (isCalendarUnavailable(err)) return `Calendario non disponibile (${err.reason})`;
  return 'Errore interno del passo: dettagli nei log del server';
}

async function markFailed(db: Db, handle: TransitionHandle, step: string, err: unknown): Promise<void> {
  await db`
    UPDATE cal_migration_journal
    SET status = 'failed', finished_at = now(), error_code = ${errorCodeOf(err)}, error = ${errorMessageOf(err)}
    WHERE transition_id = ${handle.record.id}::uuid AND step = ${step} AND status = 'started'
  `.catch((e: unknown) => handle.ctx.log.warn({ err: e instanceof Error ? e.message : String(e), step }, 'esito fallito del passo non registrato'));
}

/** Esito di un passo già concluso, o null. */
export async function completedStep(handle: TransitionHandle, step: string): Promise<JournalStepRecord | null> {
  const row = await journalRow(handle.ctx.db, handle.record.id, step);
  return row && (row.status === 'done' || row.status === 'skipped') ? row : null;
}

async function afterStepHook(handle: TransitionHandle, step: string): Promise<void> {
  if (testHooks?.afterStep) await testHooks.afterStep(handle.record.kind, step);
}

/**
 * Passo idempotente del journal (contratto f4-modules §2.3): già concluso →
 * restituisce i dati registrati senza rieseguire; altrimenti lo registra come
 * iniziato (attempts + 1), esegue `fn` e lo chiude come concluso con i dati
 * restituiti (JSON senza dati personali). Un errore lo chiude come fallito e
 * si propaga: la ripresa lo ripete. `fn` NON deve cambiare lo stato del
 * backend: per quello ci sono i passi di stato (freezeStep, epochStep,
 * stateStep, abortTransition).
 */
export async function runStep<T extends Record<string, unknown>>(
  handle: TransitionHandle,
  step: string,
  fn: (info: { attempt: number }) => Promise<T>,
): Promise<T> {
  const { ctx } = handle;
  if (testHooks?.beforeStep) await testHooks.beforeStep(handle.record.kind, step);
  const done = await completedStep(handle, step);
  if (done) return done.data as T;
  throwIfAborted(ctx);
  const started = await markStarted(ctx.db, handle, step);
  if (started.status === 'done' || started.status === 'skipped') return started.data as T;
  const t0 = Date.now();
  let data: T;
  try {
    data = await fn({ attempt: started.attempts });
  } catch (err) {
    await markFailed(ctx.db, handle, step, err);
    throw err;
  }
  await markDone(ctx.db, handle, step, data);
  ctx.log.info({ transitionId: handle.record.id, kind: handle.record.kind, step, attempt: started.attempts, ms: Date.now() - t0 }, 'passo della transizione concluso');
  await afterStepHook(handle, step);
  return data;
}

/** Segna un passo come saltato (con il motivo nei dati), se non è già concluso. */
export async function skipStep(handle: TransitionHandle, step: string, reason: string): Promise<void> {
  if (testHooks?.beforeStep) await testHooks.beforeStep(handle.record.kind, step);
  if (await completedStep(handle, step)) return;
  await markStarted(handle.ctx.db, handle, step);
  await markDone(handle.ctx.db, handle, step, { reason }, 'skipped');
  await afterStepHook(handle, step);
}

// ─── Passi di stato ───────────────────────────────

/** Colonne di calendar_backend_state che i passi di stato possono scrivere (contratto f4-modules §2.4). */
export interface StateFieldUpdates {
  write_freeze?: boolean;
  rollback_until?: Date | null;
  cutover_at?: Date | null;
  cutover_by?: string | null;
  finalized_at?: Date | null;
  api_min_version?: number;
}

/** Colonne e valori di `set` per l'helper di UPDATE di postgres-js (usato subito dopo SET, che ne decide il formato). */
function stateEntries(set: StateFieldUpdates): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  if (set.write_freeze !== undefined) entries.write_freeze = set.write_freeze;
  if (set.rollback_until !== undefined) entries.rollback_until = set.rollback_until;
  if (set.cutover_at !== undefined) entries.cutover_at = set.cutover_at;
  if (set.cutover_by !== undefined) entries.cutover_by = set.cutover_by === null ? null : set.cutover_by.slice(0, 200);
  if (set.finalized_at !== undefined) entries.finalized_at = set.finalized_at;
  if (set.api_min_version !== undefined) entries.api_min_version = set.api_min_version;
  return entries;
}

/**
 * Esegue `fn` in una transazione con la riga di stato bloccata FOR UPDATE
 * (barriera delle scritture legacy, guardia 166) e la riga del journal del
 * passo: se il passo risulta già concluso dentro la transazione, non esegue
 * nulla. Restituisce i dati del passo.
 */
async function withStateStep<T extends Record<string, unknown>>(
  handle: TransitionHandle,
  step: string,
  fn: (tx: Db, state: MigrationBackendState) => Promise<T>,
): Promise<{ data: T; changed: boolean }> {
  const { ctx } = handle;
  if (testHooks?.beforeStep) await testHooks.beforeStep(handle.record.kind, step);
  const done = await completedStep(handle, step);
  if (done) return { data: done.data as T, changed: false };
  throwIfAborted(ctx);
  await markStarted(ctx.db, handle, step);
  let result: { data: T; changed: boolean };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js (vedi Db)
    result = (await ctx.db.begin(async (tx: any) => {
      await tx`SELECT 1 FROM calendar_backend_state WHERE id FOR UPDATE`;
      const [journal] = await tx`
        SELECT status FROM cal_migration_journal WHERE transition_id = ${handle.record.id}::uuid AND step = ${step} FOR UPDATE
      `;
      if (journal && (journal.status === 'done' || journal.status === 'skipped')) {
        const again = await journalRow(tx, handle.record.id, step);
        return { data: (again?.data ?? {}) as T, changed: false };
      }
      const state = await readTransitionState(tx);
      const data = await fn(tx, state);
      await markDone(tx, handle, step, data);
      return { data, changed: true };
    })) as { data: T; changed: boolean };
  } catch (err) {
    await markFailed(ctx.db, handle, step, err);
    throw err;
  }
  if (result.changed) {
    invalidateBackendModeCache();
    invalidateIdentityCache();
    ctx.log.info({ transitionId: handle.record.id, kind: handle.record.kind, step, data: result.data }, 'stato del backend aggiornato dalla transizione');
  }
  await afterStepHook(handle, step);
  return result;
}

/** Giro del control-plane dopo un passo di stato (la policy deriva dallo stato appena scritto). */
async function syncControlPlaneAfterState(ctx: TransitionContext): Promise<ControlPlaneTick | null> {
  try {
    return await requestControlPlaneSync();
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'giro del control-plane dopo la transizione non riuscito: lo ripete il heartbeat');
    return null;
  }
}

/**
 * Passo 'freeze' (design §13.9 punto 1): mode intermedio del tipo (cutover o
 * rollback) e write_freeze = true, in una transazione con la riga del
 * journal. Ripreso dopo il commit → già concluso. Lo stato deve essere ancora
 * quello di partenza con l'epoch di inizio; uno stato già nel mode
 * intermedio (impostato a mano) si accetta. Poi giro del control-plane.
 */
export async function freezeStep(handle: TransitionHandle): Promise<Record<string, unknown>> {
  const modes = TRANSITION_MODES[handle.record.kind];
  const via = modes.via;
  if (!via) throw new TransitionError('INTERNAL', `La transizione ${handle.record.kind} non ha un mode intermedio`, { runErrorCode: 'INTERNAL' });
  const { data, changed } = await withStateStep(handle, 'freeze', async (tx, state) => {
    if (state.epoch !== handle.record.epoch_before) {
      throw new TransitionError('PRECONDITION_FAILED', `Epoch del volume cambiato durante la transizione (${handle.record.epoch_before} → ${state.epoch}).`, { runErrorCode: 'EPOCH_CONFLICT' });
    }
    if (state.mode !== modes.from && state.mode !== via) {
      throw new TransitionError('PRECONDITION_FAILED', `Il backend è in ${MODE_LABEL[state.mode]}: la transizione ${handle.record.kind} non può congelarlo.`, {
        runErrorCode: 'TRANSITION_CONFLICT', reasons: [modeReason(handle.record.kind)],
      });
    }
    const before = { mode: state.mode, write_freeze: state.write_freeze };
    if (state.mode !== via || !state.write_freeze) {
      await tx`UPDATE calendar_backend_state SET mode = ${via}, write_freeze = true WHERE id`;
    }
    const [after] = await tx`SELECT policy_version FROM calendar_backend_state WHERE id`;
    return {
      mode_before: before.mode,
      write_freeze_before: before.write_freeze,
      mode_after: via,
      write_freeze_after: true,
      policy_version: Number(after.policy_version),
    };
  });
  if (changed) await syncControlPlaneAfterState(handle.ctx);
  return data;
}

/**
 * Passo di stato senza cambio d'epoch (contratto f4-modules §2.4): 'unfreeze'
 * del cutover (write_freeze = false), 'state' del finalize (mode finalized),
 * 'cleanup' del rollback. `expectMode` è il mode in cui deve trovarsi il
 * backend; `mode` il nuovo mode (solo il finalize lo cambia).
 */
export async function stateStep(
  handle: TransitionHandle,
  step: string,
  opts: { expectMode: BackendMode; mode?: BackendMode; set?: StateFieldUpdates; data?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  if (opts.mode && opts.mode !== opts.expectMode && !(handle.record.kind === 'finalize' && opts.expectMode === 'radicale' && opts.mode === 'finalized')) {
    throw new TransitionError('INTERNAL', `Cambio di mode ${opts.expectMode} → ${opts.mode} non ammesso fuori dai passi d'epoch`, { runErrorCode: 'INTERNAL' });
  }
  const { data, changed } = await withStateStep(handle, step, async (tx, state) => {
    if (state.mode !== opts.expectMode) {
      throw new TransitionError('PRECONDITION_FAILED', `Il passo ${step} richiede mode ${opts.expectMode}; il backend è in ${MODE_LABEL[state.mode]}.`, { runErrorCode: 'TRANSITION_CONFLICT' });
    }
    await tx`
      UPDATE calendar_backend_state SET ${tx({ mode: opts.mode ?? state.mode, ...stateEntries(opts.set ?? {}) })}
      WHERE id
    `;
    const [after] = await tx`SELECT mode, write_freeze, policy_version FROM calendar_backend_state WHERE id`;
    return { ...(opts.data ?? {}), mode: after.mode, write_freeze: after.write_freeze, policy_version: Number(after.policy_version) };
  });
  if (changed) await syncControlPlaneAfterState(handle.ctx);
  return data;
}

/** Dipendenze del passo d'epoch (sostituibili nei test). */
export interface EpochDeps {
  /** Client caldes-svc (rete interna). */
  client: RadicaleClient;
  principal: string;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Passo 'epoch' (design §13.10 passo 4, §13.12 passo 5; contratto §2.5):
 *  1. riga del journal 'started' committata (sappiamo che il marker può
 *     essere già cambiato);
 *  2. lettura del marker come caldes-svc: volume_id deve coincidere con PG;
 *     epoch = E → PROPPATCH di E + 1; epoch = E + 1 → già scritto (ripresa);
 *     altro → EPOCH_CONFLICT senza toccare nulla;
 *  3. transazione: stato ancora nel mode intermedio con epoch E → mode
 *     d'arrivo, epoch E + 1 e i campi di `set`; epoch_after della transizione;
 *     journal 'done'.
 * Fra 2 e 3 il mismatch d'epoch tiene i device chiusi (fail-closed). Radicale
 * irraggiungibile: nuovi tentativi, poi il run fallisce con lo stato ancora
 * congelato (si riprende).
 */
export async function epochStep(handle: TransitionHandle, deps: EpochDeps, opts: { set?: StateFieldUpdates } = {}): Promise<Record<string, unknown>> {
  const { ctx } = handle;
  const modes = TRANSITION_MODES[handle.record.kind];
  const via = modes.via;
  if (!via) throw new TransitionError('INTERNAL', `La transizione ${handle.record.kind} non ha un passo d'epoch`, { runErrorCode: 'INTERNAL' });
  const step = POINT_OF_NO_RETURN_STEP;
  if (testHooks?.beforeStep) await testHooks.beforeStep(handle.record.kind, step);
  const done = await completedStep(handle, step);
  if (done) return done.data;
  throwIfAborted(ctx);
  await markStarted(ctx.db, handle, step);
  const E = handle.record.epoch_before;
  const sleep = deps.sleep ?? defaultSleep;
  let data: Record<string, unknown>;
  try {
    const state = await readTransitionState(ctx.db);
    if (state.mode === modes.to && state.epoch === E + 1) {
      // Lo stato è già oltre (impossibile con il journal nella stessa tx, salvo intervento a mano): si registra.
      data = { epoch_before: E, epoch_after: E + 1, mode: modes.to, write_freeze: state.write_freeze, policy_version: state.policy_version, marker: 'already' };
      await ctx.db`UPDATE cal_migration_transitions SET epoch_after = ${E + 1} WHERE id = ${handle.record.id}::uuid`;
      await markDone(ctx.db, handle, step, data);
      handle.record = { ...handle.record, epoch_after: E + 1 };
    } else {
      if (state.mode !== via || state.epoch !== E || !state.volume_id) {
        throw new TransitionError('PRECONDITION_FAILED', `Passo d'epoch con il backend in ${MODE_LABEL[state.mode]} ed epoch ${state.epoch} (attesi ${MODE_LABEL[via]} ed epoch ${E}).`, { runErrorCode: 'TRANSITION_CONFLICT' });
      }
      const marker = await ensureEpochMarker(deps, state.volume_id, E, sleep, ctx);
      data = await commitEpoch(handle, { via, to: modes.to, E, set: opts.set ?? {}, marker });
    }
  } catch (err) {
    await markFailed(ctx.db, handle, step, err);
    throw err;
  }
  invalidateBackendModeCache();
  invalidateIdentityCache();
  await syncControlPlaneAfterState(ctx);
  ctx.log.info({ transitionId: handle.record.id, kind: handle.record.kind, epoch: E + 1, mode: modes.to }, 'passo d\'epoch concluso: punto di non ritorno superato');
  await afterStepHook(handle, step);
  return data;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}

/** Porta il marker del volume a E + 1 (idempotente). Restituisce come l'ha trovato. */
async function ensureEpochMarker(deps: EpochDeps, volumeId: string, E: number, sleep: (ms: number) => Promise<void>, ctx: TransitionContext): Promise<'written' | 'already'> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= F4_LIMITS.epochRetryAttempts; attempt++) {
    throwIfAborted(ctx);
    const read = await readVolumeMarkerRemote(deps.client, deps.principal);
    if (read.state === 'ok') {
      if (read.marker.volume_id.toLowerCase() !== volumeId.toLowerCase()) {
        throw new TransitionError('PRECONDITION_FAILED', 'Il marker del volume ha un volume-id diverso da quello registrato: identità cambiata, nessuna modifica fatta.', { runErrorCode: 'EPOCH_CONFLICT', reasons: ['IDENTITY_NOT_OK'] });
      }
      if (read.marker.epoch === E + 1) return 'already';
      if (read.marker.epoch !== E) {
        throw new TransitionError('PRECONDITION_FAILED', `Epoch del marker ${read.marker.epoch} diverso da quello atteso (${E} o ${E + 1}): nessuna modifica fatta.`, { runErrorCode: 'EPOCH_CONFLICT', reasons: ['IDENTITY_NOT_OK'] });
      }
      try {
        await writeVolumeMarker(deps.client, deps.principal, { volume_id: volumeId.toLowerCase(), epoch: E + 1 });
      } catch (err) {
        lastError = err;
        if (!isRadicaleError(err) || !(err.transient || err.outcomeUnknown)) throw err;
        await sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      const check = await readVolumeMarkerRemote(deps.client, deps.principal);
      if (check.state === 'ok' && check.marker.epoch === E + 1 && check.marker.volume_id.toLowerCase() === volumeId.toLowerCase()) return 'written';
      lastError = new Error(`marker non aggiornato dopo la PROPPATCH (${check.state})`);
    } else if (read.state === 'absent') {
      throw new TransitionError('PRECONDITION_FAILED', 'Marker del volume assente sul principal: identità non verificabile, nessuna modifica fatta.', { runErrorCode: 'EPOCH_CONFLICT', reasons: ['IDENTITY_NOT_OK'] });
    } else {
      lastError = new Error(read.detail ?? 'marker illeggibile');
    }
    await sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)));
  }
  throw new TransitionError('PRECONDITION_FAILED', `Radicale non raggiungibile per il passo d'epoch: lo stato resta congelato, riprendi la transizione quando Radicale risponde (${lastError instanceof Error ? lastError.message : 'errore sconosciuto'}).`, { runErrorCode: 'RADICALE_UNREACHABLE' });
}

async function commitEpoch(
  handle: TransitionHandle,
  p: { via: BackendMode; to: BackendMode; E: number; set: StateFieldUpdates; marker: 'written' | 'already' },
): Promise<Record<string, unknown>> {
  const db = handle.ctx.db;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js (vedi Db)
  return (await db.begin(async (tx: any) => {
    await tx`SELECT 1 FROM calendar_backend_state WHERE id FOR UPDATE`;
    const state = await readTransitionState(tx);
    if (state.mode === p.to && state.epoch === p.E + 1) {
      // Già committato da un tentativo precedente (non dovrebbe accadere: il journal è nella stessa tx).
    } else if (state.mode !== p.via || state.epoch !== p.E) {
      throw new TransitionError('PRECONDITION_FAILED', `Stato cambiato durante il passo d'epoch (${MODE_LABEL[state.mode]}, epoch ${state.epoch}).`, { runErrorCode: 'TRANSITION_CONFLICT' });
    } else {
      await tx`
        UPDATE calendar_backend_state SET ${tx({ mode: p.to, epoch: p.E + 1, ...stateEntries(p.set) })}
        WHERE id AND mode = ${p.via} AND epoch = ${p.E}
      `;
    }
    await tx`UPDATE cal_migration_transitions SET epoch_after = ${p.E + 1} WHERE id = ${handle.record.id}::uuid`;
    const [after] = await tx`SELECT mode, epoch, write_freeze, policy_version FROM calendar_backend_state WHERE id`;
    const data = {
      epoch_before: p.E,
      epoch_after: p.E + 1,
      mode: after.mode as string,
      write_freeze: after.write_freeze as boolean,
      policy_version: Number(after.policy_version),
      marker: p.marker,
    };
    await markDone(tx, handle, POINT_OF_NO_RETURN_STEP, data);
    handle.record = { ...handle.record, epoch_after: p.E + 1 };
    return data;
  })) as Record<string, unknown>;
}

/**
 * Annulla una transizione prima del passo d'epoch (contratto §2.6): il
 * backend torna al mode di partenza (cutover → postgres con policy shadow;
 * rollback → radicale) con il write_freeze che aveva prima del freeze; la
 * transizione diventa `aborted` con codice e motivo. Dopo il passo d'epoch →
 * PRECONDITION_FAILED TRANSITION_NOT_ABORTABLE. Idempotente su una
 * transizione già annullata.
 */
export async function abortTransition(handle: TransitionHandle, opts: { code: MigrationRunErrorCode | string; reason: string }): Promise<Record<string, unknown>> {
  const { ctx } = handle;
  const modes = TRANSITION_MODES[handle.record.kind];
  if (!modes.abort_to || !modes.via) {
    throw new TransitionError('PRECONDITION_FAILED', `La transizione ${handle.record.kind} non si annulla.`, { runErrorCode: 'TRANSITION_CONFLICT', reasons: ['TRANSITION_NOT_ABORTABLE'] });
  }
  const current = await refreshTransition(handle);
  if (current.status === 'aborted') return { already: true };
  if (current.status !== 'active') {
    throw new TransitionError('PRECONDITION_FAILED', 'La transizione è già conclusa.', { runErrorCode: 'TRANSITION_CONFLICT', reasons: ['NO_ACTIVE_TRANSITION'] });
  }
  const journal = await readJournal(ctx.db, current.id);
  if (pastPointOfNoReturn(journal)) {
    throw new TransitionError('PRECONDITION_FAILED', 'Il passo d\'epoch è già concluso: la transizione non si annulla più, va completata (o, dopo il cutover, si usa il rollback).', {
      runErrorCode: 'TRANSITION_CONFLICT', reasons: ['TRANSITION_NOT_ABORTABLE'],
    });
  }
  const freeze = journal.find((j) => j.step === 'freeze' && j.status === 'done');
  const freezeBefore = typeof freeze?.data.write_freeze_before === 'boolean' ? freeze.data.write_freeze_before : false;
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(opts.code) ? opts.code : 'TRANSITION_ABORTED';
  const reason = opts.reason.slice(0, 1000);
  const abortTo = modes.abort_to;
  const via = modes.via;
  await markStarted(ctx.db, handle, TRANSITION_ABORT_STEP);
  let data: Record<string, unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js (vedi Db)
    data = (await ctx.db.begin(async (tx: any) => {
      await tx`SELECT 1 FROM calendar_backend_state WHERE id FOR UPDATE`;
      const state = await readTransitionState(tx);
      if (state.epoch !== current.epoch_before) {
        throw new TransitionError('PRECONDITION_FAILED', 'Epoch cambiato: annullamento non sicuro, serve un intervento manuale.', { runErrorCode: 'EPOCH_CONFLICT' });
      }
      let restored = false;
      if (state.mode === via) {
        await tx`UPDATE calendar_backend_state SET mode = ${abortTo}, write_freeze = ${freezeBefore} WHERE id`;
        restored = true;
      } else if (state.mode !== abortTo) {
        throw new TransitionError('PRECONDITION_FAILED', `Il backend è in ${MODE_LABEL[state.mode]}: annullamento non applicabile.`, { runErrorCode: 'TRANSITION_CONFLICT' });
      }
      await tx`
        UPDATE cal_migration_transitions
        SET status = 'aborted', finished_at = now(), outcome_code = ${code}, outcome = ${reason}
        WHERE id = ${current.id}::uuid AND status = 'active'
      `;
      const result = { mode: abortTo, write_freeze: restored ? freezeBefore : state.write_freeze, restored, code };
      await markDone(tx, handle, TRANSITION_ABORT_STEP, result);
      return result;
    })) as Record<string, unknown>;
  } catch (err) {
    await markFailed(ctx.db, handle, TRANSITION_ABORT_STEP, err);
    throw err;
  }
  invalidateBackendModeCache();
  invalidateIdentityCache();
  await syncControlPlaneAfterState(ctx);
  await refreshTransition(handle);
  ctx.log.warn({ transitionId: current.id, kind: current.kind, code, reason }, 'transizione annullata: backend di nuovo nel mode di partenza');
  return data;
}

/**
 * Chiude la transizione come conclusa (contratto §2.7): tutti i passi del
 * tipo devono essere conclusi o saltati. Idempotente.
 */
export async function completeTransition(handle: TransitionHandle, opts: { outcome?: string } = {}): Promise<TransitionRecord> {
  const { ctx } = handle;
  const current = await refreshTransition(handle);
  if (current.status === 'completed') return current;
  if (current.status !== 'active') {
    throw new TransitionError('PRECONDITION_FAILED', `La transizione è ${current.status}: non si conclude.`, { runErrorCode: 'TRANSITION_CONFLICT' });
  }
  const pending = nextPendingStep(current.kind, await readJournal(ctx.db, current.id));
  if (pending) {
    throw new TransitionError('INTERNAL', `Transizione non conclusa: manca il passo ${pending}.`, { runErrorCode: 'INTERNAL' });
  }
  await ctx.db`
    UPDATE cal_migration_transitions
    SET status = 'completed', finished_at = now(), outcome_code = NULL, outcome = ${opts.outcome?.slice(0, 1000) ?? null}
    WHERE id = ${current.id}::uuid AND status = 'active'
  `;
  ctx.log.info({ transitionId: current.id, kind: current.kind }, 'transizione conclusa');
  return refreshTransition(handle);
}

// ─── Gate e quiescenza ───────────────────────────────

/**
 * Esegue `fn` dentro il gate cal-write esclusivo (design §13.9 punto 2):
 * attende le scritture in corso del processo e degli altri processi; le
 * nuove attendono e poi rileggono lo stato. Gate non ottenuto entro il tempo
 * → GATE_TIMEOUT (stato invariato: già congelato dal passo precedente). `fn`
 * non deve usare il pool calendario (regola 1 contro lo stallo).
 */
export async function withTransitionGate<T>(fn: (info: { drained_ms: number }) => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<{ result: T; drained_ms: number }> {
  const t0 = Date.now();
  let drained = -1;
  try {
    const result = await withExclusiveCalendarWriteGate(async () => {
      drained = Date.now() - t0;
      return fn({ drained_ms: drained });
    }, { timeoutMs: opts.timeoutMs ?? F4_LIMITS.exclusiveGateTimeoutMs });
    return { result, drained_ms: drained };
  } catch (err) {
    if (drained < 0 && isCalendarUnavailable(err)) {
      throw new TransitionError('CALENDAR_UNAVAILABLE', 'Scritture del calendario ancora in corso: gate esclusivo non ottenuto, riprova la transizione.', { runErrorCode: 'GATE_TIMEOUT' });
    }
    throw err;
  }
}

/** Dipendenze della quiescenza (sostituibili nei test). */
export interface QuiescenceDeps {
  /** Client caldes-probe sulla rete interna: la sua PUT su _canary deve ricevere 403. null = password assente. */
  probe: RadicaleClient | null;
  /** Client caldes-svc: rimozione della risorsa scritta dal probe a gate aperto e stat remota. */
  svc: RadicaleClient;
  principal: string;
  /** Nomi delle collezioni da osservare (dal pool principale, mai da calSql). */
  collections: () => Promise<string[]>;
  /** mount: mtime delle directory; remote: PROPFIND di getctag e sync-token. */
  statSource: 'mount' | 'remote';
  /** mtime in ns della directory di una collezione (mount). */
  statCollection: (name: string) => Promise<bigint | null>;
  /** mtime in ns della directory del principal (mount: MKCALENDAR di un device). */
  statPrincipal: () => Promise<bigint | null>;
  /** Giro del control-plane che scrive la policy dello stato corrente; null = control-plane non attivo nel processo. */
  syncControlPlane: (() => Promise<ControlPlaneTick | null>) | null;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Limiti della quiescenza (default F4_LIMITS; i test li accorciano). */
  limits?: Partial<Record<'quiescencePolicyGraceMs' | 'quiescenceProbeAttempts' | 'quiescenceProbeIntervalMs' | 'quiescenceStatIntervalMs' | 'quiescenceStatMaxRounds', number>>;
}

let probeClient: RadicaleClient | null = null;
let probeClientKey = '';

/** Client caldes-probe dalle variabili d'ambiente (RADICALE_PROBE_PASSWORD, ripiego CALDES_PROBE_PASSWORD). */
function probeFromEnv(svc: RadicaleClient, env: NodeJS.ProcessEnv): RadicaleClient | null {
  const password = env.RADICALE_PROBE_PASSWORD?.trim() || env.CALDES_PROBE_PASSWORD?.trim() || '';
  if (!password) return null;
  const key = `${svc.baseUrl}\0${password}`;
  if (probeClient && probeClientKey === key) return probeClient;
  probeClient?.close();
  probeClient = new RadicaleClient({ baseUrl: svc.baseUrl, username: PROBE_USER, password, timeoutMs: 5_000, retries: 0, userAgent: 'caldes-api-transition' });
  probeClientKey = key;
  return probeClient;
}

/**
 * Dipendenze di produzione: client di servizio del runtime, probe
 * dall'ambiente, collezioni Radicale del sidecar lette dal pool principale,
 * sorgente della stat dal campanello (mount se il campanello è in mount,
 * altrimenti remota), control-plane del processo. Lancia
 * RADICALE_NOT_CONFIGURED senza client.
 */
export function defaultQuiescenceDeps(env: NodeJS.ProcessEnv = process.env): QuiescenceDeps {
  const rt = radicaleRuntime();
  if (!rt.client) throw new TransitionError('RADICALE_NOT_CONFIGURED', rt.unavailableReason ?? 'Radicale non configurato', { runErrorCode: 'RADICALE_NOT_CONFIGURED' });
  const svc = rt.client;
  const watch = currentWatchMode();
  return {
    probe: probeFromEnv(svc, env),
    svc,
    principal: rt.principal,
    collections: async () => (await radicaleCollections(sql)).map((c) => c.collectionName),
    statSource: watch.mode === 'mount' ? 'mount' : 'remote',
    statCollection: (name) => statMtimeNs(collectionDirPath(name, rt)),
    statPrincipal: () => statMtimeNs(principalDirPath(rt)),
    syncControlPlane: getCalendarControlPlane() ? () => requestControlPlaneSync() : null,
    sleep: defaultSleep,
    now: () => new Date(),
  };
}

function probeIcs(name: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Caldes//calendar-transition//IT',
    'BEGIN:VEVENT',
    `UID:${name.replace(/\.ics$/, '')}@caldes.it`,
    `DTSTAMP:${stamp}`,
    'DTSTART:20000101T000000Z',
    'DTEND:20000101T000100Z',
    'SUMMARY:caldes quiescenza',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** Fotografia della stat delle collezioni (chiave → valore confrontabile). */
async function statSnapshot(deps: QuiescenceDeps, names: readonly string[]): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  if (deps.statSource === 'mount') {
    snap.set('/', String(await deps.statPrincipal()));
    for (const name of names) snap.set(name, String(await deps.statCollection(name)));
    return snap;
  }
  for (const name of names) {
    let props: Record<string, string> | null;
    try {
      props = await deps.svc.readProps(collectionPath(deps.principal, name), [DAV_PROPS.getctag, DAV_PROPS.syncToken], { timeoutMs: 5_000 });
    } catch (err) {
      throw new TransitionError('CALENDAR_UNAVAILABLE', `Stato della collezione ${name} non leggibile da Radicale (${describeRadicaleError(err)}): quiescenza non verificabile.`, { runErrorCode: 'QUIESCENCE_TIMEOUT' });
    }
    snap.set(name, props ? `${props['{http://calendarserver.org/ns/}getctag'] ?? ''}|${props['{DAV:}sync-token'] ?? ''}` : 'absent');
  }
  return snap;
}

function sameSnapshot(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Quiescenza dei device (design §13.9 punto 3, contratto §2.8):
 *  1. giro del control-plane: la policy dello stato corrente deve essere
 *     `expectPolicyMode` (frozen); senza control-plane → CONTROL_PLANE_UNAVAILABLE;
 *  2. attesa di almeno quiescencePolicyGraceMs dalla scrittura;
 *  3. PUT del probe su _canary con If-None-Match: * → 403 atteso, fino a
 *     quiescenceProbeAttempts tentativi (una risorsa scritta a gate aperto si
 *     rimuove subito come caldes-svc); senza probe → PROBE_UNAVAILABLE;
 *  4. stat delle collezioni ripetuta finché due letture consecutive a
 *     quiescenceStatIntervalMs coincidono, al più quiescenceStatMaxRounds giri.
 * Ogni fallimento → QUIESCENCE_TIMEOUT (o il codice sopra) con lo stato
 * invariato: la transizione resta congelata e si riprende.
 */
export async function awaitDeviceQuiescence(
  deps: QuiescenceDeps,
  opts: { expectPolicyMode?: 'frozen' | 'shadow'; signal?: AbortSignal; drainedMs?: number } = {},
): Promise<QuiescenceReport> {
  const limits: Record<'quiescencePolicyGraceMs' | 'quiescenceProbeAttempts' | 'quiescenceProbeIntervalMs' | 'quiescenceStatIntervalMs' | 'quiescenceStatMaxRounds', number> = {
    quiescencePolicyGraceMs: deps.limits?.quiescencePolicyGraceMs ?? F4_LIMITS.quiescencePolicyGraceMs,
    quiescenceProbeAttempts: deps.limits?.quiescenceProbeAttempts ?? F4_LIMITS.quiescenceProbeAttempts,
    quiescenceProbeIntervalMs: deps.limits?.quiescenceProbeIntervalMs ?? F4_LIMITS.quiescenceProbeIntervalMs,
    quiescenceStatIntervalMs: deps.limits?.quiescenceStatIntervalMs ?? F4_LIMITS.quiescenceStatIntervalMs,
    quiescenceStatMaxRounds: deps.limits?.quiescenceStatMaxRounds ?? F4_LIMITS.quiescenceStatMaxRounds,
  };
  const expected = opts.expectPolicyMode ?? 'frozen';
  const aborted = (): void => {
    if (opts.signal?.aborted) throw new MigrationError('CANCELLED', 'Quiescenza interrotta');
  };
  if (!deps.probe) {
    throw new TransitionError('PRECONDITION_FAILED', `Password di ${PROBE_USER} non disponibile nell'API (RADICALE_PROBE_PASSWORD): la quiescenza dei device non è verificabile.`, {
      runErrorCode: 'PROBE_UNAVAILABLE', reasons: ['PROBE_UNAVAILABLE'],
    });
  }
  if (!deps.syncControlPlane) {
    throw new TransitionError('PRECONDITION_FAILED', 'Control-plane non attivo nel processo: lo stato non arriverebbe ai device.', {
      runErrorCode: 'CONTROL_PLANE_UNAVAILABLE', reasons: ['CONTROL_PLANE_UNAVAILABLE'],
    });
  }

  // 1. Policy dello stato corrente.
  let tick: ControlPlaneTick | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    aborted();
    tick = await deps.syncControlPlane();
    if (tick?.ok && tick.policy?.mode === expected) break;
    tick = null;
    await deps.sleep(limits.quiescenceProbeIntervalMs);
  }
  if (!tick) {
    throw new TransitionError('CALENDAR_UNAVAILABLE', `Policy dei device non allineata allo stato (attesa ${expected}): control-plane non riuscito.`, { runErrorCode: 'CONTROL_PLANE_UNAVAILABLE' });
  }
  const policyAt = deps.now();

  // 2. Attesa oltre il ricontrollo dei plugin.
  const t0 = Date.now();
  await deps.sleep(limits.quiescencePolicyGraceMs);

  // 3. PUT del probe su _canary: 403 atteso.
  let probeStatus = 0;
  let probeAttempts = 0;
  for (; probeAttempts < limits.quiescenceProbeAttempts;) {
    aborted();
    probeAttempts += 1;
    const name = `quiesce-${randomUUID()}.ics`;
    const path = objectPath(deps.principal, CANARY_COLLECTION, name);
    try {
      const put = await deps.probe.put(path, probeIcs(name, deps.now()), { ifNoneMatch: '*' }, { timeoutMs: 5_000 });
      probeStatus = put.created ? 201 : 204;
      log.warn({ attempt: probeAttempts }, 'quiescenza: il probe scrive ancora su _canary (policy non ancora ricaricata dai plugin)');
      try {
        if (put.etag) await deps.svc.delete(path, { ifMatch: put.etag });
      } catch (err) {
        log.warn({ err: describeRadicaleError(err) }, 'quiescenza: risorsa del probe su _canary non rimossa');
      }
    } catch (err) {
      if (isRadicaleError(err) && err.status === 403) {
        probeStatus = 403;
        break;
      }
      probeStatus = isRadicaleError(err) ? err.status ?? 0 : 0;
      log.warn({ attempt: probeAttempts, err: describeRadicaleError(err) }, 'quiescenza: risposta inattesa alla PUT del probe');
    }
    if (probeAttempts < limits.quiescenceProbeAttempts) await deps.sleep(limits.quiescenceProbeIntervalMs);
  }
  if (probeStatus !== 403) {
    throw new TransitionError('CALENDAR_UNAVAILABLE', `I device non risultano in sola lettura: la PUT di ${PROBE_USER} su ${CANARY_COLLECTION} non riceve 403 dopo ${probeAttempts} tentativi (ultimo stato ${probeStatus || 'nessuna risposta'}).`, {
      runErrorCode: 'QUIESCENCE_TIMEOUT',
    });
  }

  // 4. Stat stabile.
  const names = (await deps.collections()).filter((n) => n !== CANARY_COLLECTION && !n.startsWith('_'));
  let previous = await statSnapshot(deps, names);
  let rounds = 1;
  let stable = false;
  while (rounds < limits.quiescenceStatMaxRounds) {
    aborted();
    await deps.sleep(limits.quiescenceStatIntervalMs);
    const current = await statSnapshot(deps, names);
    rounds += 1;
    if (sameSnapshot(previous, current)) {
      stable = true;
      break;
    }
    previous = current;
  }
  if (!stable) {
    throw new TransitionError('CALENDAR_UNAVAILABLE', `Le collezioni continuano a cambiare dopo ${rounds} letture: scritture dei device ancora in corso.`, { runErrorCode: 'QUIESCENCE_TIMEOUT' });
  }
  return {
    gate: { drained_ms: opts.drainedMs ?? 0 },
    policy: { mode: tick.policy?.mode ?? null, version: tick.policy?.version ?? null, reasons: [...(tick.policy?.reasons ?? [])], written_at: policyAt.toISOString() },
    waited_ms: Date.now() - t0,
    probe: { attempts: probeAttempts, status: probeStatus },
    stat: { source: deps.statSource, rounds, collections: names.length },
    finished_at: deps.now().toISOString(),
  };
}

/**
 * Passo 'quiesce' (design §13.9 punti 2-3): gate esclusivo, poi la
 * quiescenza dentro il gate; journal con il report. Rieseguito per intero se
 * interrotto (idempotente: non scrive nulla tranne la risorsa del probe a
 * gate aperto, subito rimossa).
 */
export async function quiesceStep(handle: TransitionHandle, deps?: QuiescenceDeps): Promise<QuiescenceReport> {
  return runStep(handle, 'quiesce', async () => {
    const effective = deps ?? defaultQuiescenceDeps();
    const { result } = await withTransitionGate(async ({ drained_ms }) => {
      if (testHooks?.insideGate) await testHooks.insideGate(handle.record.kind);
      return awaitDeviceQuiescence(effective, { expectPolicyMode: 'frozen', signal: handle.ctx.signal, drainedMs: drained_ms });
    });
    return result as unknown as Record<string, unknown>;
  }) as unknown as Promise<QuiescenceReport>;
}

// ─── Utilità per i moduli dei tipi ───────────────────────────────

/** Ora della transizione (orologio del contesto). */
export function transitionNow(handle: TransitionHandle): Date {
  return nowOf(handle.ctx);
}

/** Viste dei passi del journal (riassunti dei run). */
export async function journalViews(handle: TransitionHandle): Promise<JournalStepView[]> {
  return (await readJournal(handle.ctx.db, handle.record.id)).map(journalView);
}
