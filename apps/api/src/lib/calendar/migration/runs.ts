/**
 * Run dello strumento di migrazione: creazione, esecuzione in background,
 * stato interrogabile e stato derivato del wizard (fase F3 del piano; design
 * §13.2, §13.13; contratto docs/calendar-radicale/contracts/f3-modules.md
 * §5, §6.5 e §11).
 *
 * Ogni azione del wizard che fa lavoro (preflight, inizializzazione,
 * archivio, riassegnazione d'identità, inventario, anteprima, apply,
 * verifica) è un run in cal_migration_runs eseguito da un job `migration_run`
 * della coda cal_jobs (164):
 *
 *  1. Creazione (createMigrationRun): in una transazione INSERT del run
 *     `queued` e accodamento del job (outbox: il job esiste solo dopo la
 *     COMMIT). L'indice unico parziale cal_migration_runs_single_active
 *     ammette un solo run queued o running in tutto il database (secondo run
 *     → MIGRATION_BUSY con il run in corso); la chiave d'idempotenza del
 *     client restituisce lo stesso run per la stessa richiesta (replay) e
 *     rifiuta una richiesta diversa con la stessa chiave
 *     (IDEMPOTENCY_KEY_REUSED).
 *  2. Esecuzione (handleMigrationRunJob, registrato da
 *     registerMigrationRunJob): lock `cal-migration` su una connessione
 *     riservata del pool principale (attesa breve: un job shadow lo tiene per
 *     pochi secondi), run portato a `running` (attempts + 1, started_at alla
 *     prima esecuzione), contesto MigrationRunContext con avanzamento,
 *     righe e annullamento, poi la funzione del modulo proprietario del tipo.
 *     Un timer aggiorna il battito (heartbeat_at) ed estende il lease del job;
 *     un secondo controllo legge cancel_requested_at ogni 2 secondi.
 *  3. Esito: `succeeded` con il riassunto; `failed` con error_code e un
 *     messaggio in italiano senza dati personali; `cancelled` su richiesta
 *     (il segnale si accende e il modulo si ferma al primo punto sicuro).
 *     Un apply con follow_up_verify crea il run di verifica nella stessa
 *     transazione che lo chiude.
 *  4. Ripresa: un riavvio o un crash lasciano il job in lease; allo scadere
 *     torna pending e lo stesso run riprende (attempt > 1): le funzioni dei
 *     moduli sono idempotenti. reapInterruptedRuns() porta a `interrupted` un
 *     run `running` senza battito il cui job è morto o sparito, e a `failed`
 *     un run `queued` senza job.
 *
 * Lo stato del wizard non è mai salvato: buildMigrationStateView() lo deriva
 * dai run, dallo stato del backend, dal ledger e dalla parità dello shadow
 * (regole del contratto §11.2). Questo modulo non scrive mai mode,
 * write_freeze, cutover_*, rollback_until, finalized_at né api_min_version;
 * scrive solo i run, le righe e migration_declarations.
 *
 * Fase F4 (contratto f4-modules §6.2): i run cutover, rollback_preview,
 * rollback, rebaseline e finalize hanno i propri handler (cutover.ts,
 * rollback.ts, rebaseline.ts, finalize.ts); le transizioni di stato le fanno
 * solo quei moduli attraverso transition.ts, con il journal che sopravvive al
 * run. Un run di transizione interrotto lascia la transizione `active`: il
 * wizard la mostra da riprendere (o da annullare prima del passo d'epoch). Lo
 * stato del wizard aggiunge la transizione, la finestra di rollback e la
 * salute della proiezione inversa.
 */

import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { CalendarUnavailableError, isCalendarUnavailable } from '../errors';
import {
  CAL_JOB_PRIORITY,
  type CalendarJob,
  type CalendarJobContext,
  type CalendarJobOutcome,
  CalendarJobPermanentError,
  enqueueCalendarJob,
  registerCalendarJobHandler,
} from '../jobs';
import { lastCanaryResult } from '../radicale/canary';
import { isRadicaleError } from '../radicale/errors';
import type { Db } from '../radicale/policy';
import { currentWatchMode, lastIdentityCheck, radicaleRuntime, verifyVolumeIdentity } from '../radicale/sync';
import type { IdentityStatus } from '../radicale/types';
import { runArchiveImport, runIdentityReassign, runInit } from './init';
import { runInventory } from './inventory';
import { runPlan } from './plan';
import { describeRadicaleError, readMigrationStateFresh, runPreflight } from './preflight';
import { runApply } from './apply';
import { runVerify } from './verify';
import { latestVerifyVerdicts } from './report';
import { getParity } from './shadow';
import { cutoverCriteria, runCutover } from './cutover';
import { finalizeBlockers, runFinalize } from './finalize';
import { runRebaselineRun } from './rebaseline';
import { readReverseProjectionHealth } from './reverse-projector';
import { runRollback, runRollbackPreview } from './rollback';
import { buildTransitionView, getLatestTransition, readJournal } from './transition';
import {
  ACTIVE_RUN_STATUSES,
  type ApplyParams,
  type ApplySummary,
  type CalendarVerdict,
  type CutoverAvailability,
  type CutoverCriterion,
  type DeclarationKey,
  DECLARATION_KEYS,
  type DeclarationValues,
  F3_RUN_KINDS,
  type FinalizeParams,
  F4_LIMITS,
  F4_RUN_KINDS,
  ITEM_SEVERITIES,
  type ItemSeverity,
  MIGRATION_CONFIRMATIONS,
  MIGRATION_CONTRACT_VERSION,
  MIGRATION_ITEM_TYPES,
  MIGRATION_LIMITS,
  MIGRATION_LOCK_KEY,
  MIGRATION_PHASE,
  MIGRATION_RUN_ERROR_CODES,
  MIGRATION_RUN_JOB_KIND,
  MIGRATION_RUN_KINDS,
  MIGRATION_RUN_STATUSES,
  MIGRATION_RUN_TRIGGERS,
  type MigrationBackendState,
  type MigrationDeclarations,
  MigrationError,
  type MigrationItemInput,
  type MigrationItemType,
  type MigrationItemView,
  type MigrationProgress,
  type MigrationRunContext,
  type MigrationRunErrorCode,
  type MigrationRunHandler,
  type MigrationRunKind,
  type MigrationRunStatus,
  type MigrationRunTrigger,
  type MigrationRunView,
  type MigrationStateView,
  type ParityView,
  PLAN_ACTIONS,
  type PlanAction,
  type PlanSummary,
  type PreconditionReason,
  type PreflightSummary,
  type RebaselineParams,
  type ReverseProjectionHealthView,
  type RollbackParams,
  type RollbackPreviewParams,
  type RollbackPreviewSummary,
  type RollbackPreviewCheck,
  type RollbackWindowView,
  type RunCreatedResponse,
  type RunItemsResponse,
  type RunsListResponse,
  SHADOW_MIRROR_JOB_KIND,
  TERMINAL_RUN_STATUSES,
  type TransitionKind,
  type TransitionView,
  VERIFY_LEVELS,
  type VerifyLevel,
  type VerifyParams,
  WIZARD_STEP_IDS,
  WIZARD_STEP_TITLES,
  type WizardAction,
  type WizardActionId,
  type WizardStepId,
  type WizardStepStatus,
  type WizardStepView,
} from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-migration-runs' });

// ─── Costanti ───────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID_RE = /^[0-9]{1,19}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Attesa massima del lock cal-migration da parte dell'esecutore (un job shadow lo tiene per pochi secondi). */
export const MIGRATION_LOCK_WAIT_MS = 30_000;
/** Intervallo fra due tentativi di prendere il lock in attesa. */
const LOCK_POLL_MS = 250;
/** Controllo di cancel_requested_at durante un run (annullamento chiesto da un altro processo). */
const CANCEL_POLL_MS = 2_000;
/** Un run queued senza job da più di così è fallito (la creazione è atomica: è solo una difesa). */
const QUEUED_WITHOUT_JOB_GRACE_MS = 60_000;
/** Righe inserite al più per comando (contratto §5.4: blocchi di al più 500). */
const ITEMS_INSERT_CHUNK = 500;
/** Run elencati al più per pagina. */
const RUNS_PAGE_MAX = 100;
const RUNS_PAGE_DEFAULT = 20;

const RUN_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(MIGRATION_RUN_ERROR_CODES);
const TERMINAL_SET: ReadonlySet<string> = new Set<string>(TERMINAL_RUN_STATUSES);

// ─── Righe ───────────────────────────────

interface RunRow {
  id: string;
  kind: MigrationRunKind;
  status: MigrationRunStatus;
  trigger: MigrationRunTrigger;
  requested_by: string;
  idempotency_key: string | null;
  request_hash: string | null;
  params: Record<string, unknown> | null;
  plan_run_id: string | null;
  plan_hash: string | null;
  progress: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  error: string | null;
  error_code: string | null;
  attempts: number;
  job_id: string | null;
  heartbeat_at: Date | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Colonne del run (int8 e uuid come testo). */
function runColumns(db: Db) {
  return db`
    id::text AS id, kind, status, trigger, requested_by, idempotency_key, request_hash, params,
    plan_run_id::text AS plan_run_id, plan_hash, progress, summary, error, error_code, attempts,
    job_id::text AS job_id, heartbeat_at, cancel_requested_at, created_at, started_at, finished_at
  `;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isUniqueViolation(err: unknown): err is { code: string; constraint_name?: string } {
  return (err as { code?: unknown } | null)?.code === '23505';
}

/** Vista REST di un run (MigrationRunView). */
function toRunView(row: RunRow): MigrationRunView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    trigger: row.trigger,
    requested_by: row.requested_by,
    created_at: iso(row.created_at) as string,
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    heartbeat_at: iso(row.heartbeat_at),
    progress: asObject(row.progress) as MigrationRunView['progress'],
    summary: (row.summary ?? null) as MigrationRunView['summary'],
    error: row.error ? { code: row.error_code ?? 'INTERNAL', message: row.error } : null,
    plan_run_id: row.plan_run_id,
    plan_hash: row.plan_hash,
    attempts: row.attempts,
    cancel_requested: row.cancel_requested_at !== null,
  };
}

async function readRunRow(db: Db, id: string): Promise<RunRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db<RunRow[]>`SELECT ${runColumns(db)} FROM cal_migration_runs WHERE id = ${id.toLowerCase()}::uuid`;
  return row ?? null;
}

async function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const begin = (db as unknown as { begin?: unknown }).begin;
  if (typeof begin !== 'function') return fn(db);
  return (await db.begin(async (trx) => fn(trx as unknown as Db))) as T;
}

// ─── Lettura ───────────────────────────────

/** Un run per id (null se non esiste o l'id non è un UUID). */
export async function getMigrationRun(id: string, db: Db = sql): Promise<MigrationRunView | null> {
  const row = await readRunRow(db, id);
  return row ? toRunView(row) : null;
}

/** Run queued o running, se c'è (al più uno: indice unico parziale). */
export async function activeMigrationRun(db: Db = sql): Promise<MigrationRunView | null> {
  const [row] = await db<RunRow[]>`
    SELECT ${runColumns(db)} FROM cal_migration_runs
    WHERE status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return row ? toRunView(row) : null;
}

/** Run dal più recente, con filtri e paginazione (cursor = id dell'ultimo run della pagina precedente). */
export async function listMigrationRuns(
  filter: { kind?: MigrationRunKind; status?: MigrationRunStatus; limit?: number; cursor?: string | null },
  db: Db = sql,
): Promise<RunsListResponse> {
  if (filter.kind !== undefined && !(MIGRATION_RUN_KINDS as readonly string[]).includes(filter.kind)) {
    throw new MigrationError('VALIDATION_FAILED', `kind non valido: ammessi ${MIGRATION_RUN_KINDS.join(', ')}`);
  }
  if (filter.status !== undefined && !(MIGRATION_RUN_STATUSES as readonly string[]).includes(filter.status)) {
    throw new MigrationError('VALIDATION_FAILED', `status non valido: ammessi ${MIGRATION_RUN_STATUSES.join(', ')}`);
  }
  const limit = clampLimit(filter.limit, RUNS_PAGE_DEFAULT, RUNS_PAGE_MAX);
  let cursor: { created_at: Date; id: string } | null = null;
  if (filter.cursor) {
    if (!UUID_RE.test(filter.cursor)) throw new MigrationError('VALIDATION_FAILED', 'cursor non valido: atteso l\'id di un run');
    const [c] = await db<Array<{ created_at: Date; id: string }>>`
      SELECT created_at, id::text AS id FROM cal_migration_runs WHERE id = ${filter.cursor.toLowerCase()}::uuid
    `;
    if (!c) throw new MigrationError('VALIDATION_FAILED', 'cursor non valido: run inesistente');
    cursor = c;
  }
  const rows = await db<RunRow[]>`
    SELECT ${runColumns(db)} FROM cal_migration_runs
    WHERE TRUE
      ${filter.kind ? db`AND kind = ${filter.kind}` : db``}
      ${filter.status ? db`AND status = ${filter.status}` : db``}
      ${cursor ? db`AND (created_at, id) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)` : db``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  return { runs: page.map(toRunView), next_cursor: rows.length > limit ? page[page.length - 1].id : null };
}

function clampLimit(value: number | undefined, def: number, max: number): number {
  if (value === undefined || value === null || Number.isNaN(value)) return def;
  if (!Number.isInteger(value) || value < 1) throw new MigrationError('VALIDATION_FAILED', `limit non valido: intero da 1 a ${max}`);
  return Math.min(value, max);
}

interface ItemRow {
  id: string;
  seq: number;
  item_type: MigrationItemType;
  calendar_id: string | null;
  collection_name: string | null;
  href: string | null;
  legacy_key: string | null;
  action: PlanAction | null;
  outcome: MigrationItemView['outcome'];
  code: string | null;
  level: VerifyLevel | null;
  severity: ItemSeverity;
  expected: boolean | null;
  detail: Record<string, unknown> | null;
  forced: boolean;
  accepted_at: Date | null;
  accepted_by: string | null;
}

function toItemView(r: ItemRow): MigrationItemView {
  return {
    id: r.id,
    seq: r.seq,
    item_type: r.item_type,
    calendar_id: r.calendar_id,
    collection_name: r.collection_name,
    href: r.href,
    legacy_key: r.legacy_key,
    action: r.action,
    outcome: r.outcome,
    code: r.code,
    level: r.level,
    severity: r.severity,
    expected: r.expected,
    detail: r.detail ?? {},
    forced: r.forced,
    accepted_at: iso(r.accepted_at),
    accepted_by: r.accepted_by,
  };
}

/** Filtri delle righe di un run (contratto §10.2, più `outcome` per l'apply). */
export interface RunItemsFilter {
  item_type?: MigrationItemType;
  code?: string;
  calendar_id?: string;
  action?: PlanAction;
  outcome?: MigrationItemView['outcome'];
  level?: VerifyLevel;
  expected?: boolean;
  severity?: ItemSeverity;
  cursor?: string | null;
  limit?: number;
}

const APPLY_OUTCOME_VALUES = ['done', 'adopted', 'noop', 'skipped', 'conflict', 'failed', 'forced'] as const;

/** Righe di un run in ordine (seq), con filtri e paginazione (cursor = id dell'ultima riga). RUN_NOT_FOUND se il run non c'è. */
export async function listRunItems(runId: string, filter: RunItemsFilter, db: Db = sql): Promise<RunItemsResponse> {
  const run = await readRunRow(db, runId);
  if (!run) throw new MigrationError('RUN_NOT_FOUND', 'Run di migrazione non trovato');
  if (filter.item_type !== undefined && !(MIGRATION_ITEM_TYPES as readonly string[]).includes(filter.item_type)) {
    throw new MigrationError('VALIDATION_FAILED', `item_type non valido: ammessi ${MIGRATION_ITEM_TYPES.join(', ')}`);
  }
  if (filter.code !== undefined && !ERROR_CODE_RE.test(filter.code)) throw new MigrationError('VALIDATION_FAILED', 'code non valido');
  if (filter.calendar_id !== undefined && !UUID_RE.test(filter.calendar_id)) throw new MigrationError('VALIDATION_FAILED', 'calendar_id non valido: atteso un UUID');
  if (filter.action !== undefined && !(PLAN_ACTIONS as readonly string[]).includes(filter.action)) {
    throw new MigrationError('VALIDATION_FAILED', `action non valida: ammesse ${PLAN_ACTIONS.join(', ')}`);
  }
  if (filter.outcome !== undefined && filter.outcome !== null && !(APPLY_OUTCOME_VALUES as readonly string[]).includes(filter.outcome)) {
    throw new MigrationError('VALIDATION_FAILED', `outcome non valido: ammessi ${APPLY_OUTCOME_VALUES.join(', ')}`);
  }
  if (filter.level !== undefined && !(VERIFY_LEVELS as readonly string[]).includes(filter.level)) {
    throw new MigrationError('VALIDATION_FAILED', `level non valido: ammessi ${VERIFY_LEVELS.join(', ')}`);
  }
  if (filter.severity !== undefined && !(ITEM_SEVERITIES as readonly string[]).includes(filter.severity)) {
    throw new MigrationError('VALIDATION_FAILED', `severity non valida: ammesse ${ITEM_SEVERITIES.join(', ')}`);
  }
  const limit = clampLimit(filter.limit, MIGRATION_LIMITS.itemsPageDefault, MIGRATION_LIMITS.itemsPageMax);
  let afterSeq: number | null = null;
  if (filter.cursor) {
    if (!ITEM_ID_RE.test(filter.cursor)) throw new MigrationError('VALIDATION_FAILED', 'cursor non valido: atteso l\'id di una riga');
    const [c] = await db<Array<{ seq: number }>>`
      SELECT seq FROM cal_migration_items WHERE run_id = ${run.id}::uuid AND id = ${filter.cursor}::bigint
    `;
    if (!c) throw new MigrationError('VALIDATION_FAILED', 'cursor non valido: riga inesistente in questo run');
    afterSeq = c.seq;
  }
  const where = db`
    run_id = ${run.id}::uuid
    ${filter.item_type ? db`AND item_type = ${filter.item_type}` : db``}
    ${filter.code ? db`AND code = ${filter.code}` : db``}
    ${filter.calendar_id ? db`AND calendar_id = ${filter.calendar_id.toLowerCase()}::uuid` : db``}
    ${filter.action ? db`AND action = ${filter.action}` : db``}
    ${filter.outcome ? db`AND outcome = ${filter.outcome}` : db``}
    ${filter.level ? db`AND level = ${filter.level}` : db``}
    ${filter.expected !== undefined ? db`AND expected = ${filter.expected}` : db``}
    ${filter.severity ? db`AND severity = ${filter.severity}` : db``}
  `;
  const [{ total }] = await db<Array<{ total: number }>>`SELECT count(*)::int AS total FROM cal_migration_items WHERE ${where}`;
  const rows = await db<ItemRow[]>`
    SELECT id::text AS id, seq, item_type, calendar_id::text AS calendar_id, collection_name, href, legacy_key,
           action, outcome, code, level, severity, expected, detail, forced, accepted_at, accepted_by
    FROM cal_migration_items
    WHERE ${where} ${afterSeq !== null ? db`AND seq > ${afterSeq}` : db``}
    ORDER BY seq
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  return { items: page.map(toItemView), next_cursor: rows.length > limit ? page[page.length - 1].id : null, total };
}

/** Stato del backend con le colonne della 165, riletto senza cache. */
export async function readMigrationState(db: Db = sql): Promise<MigrationBackendState> {
  return readMigrationStateFresh(db);
}

// ─── Creazione ───────────────────────────────

export interface CreateRunInput {
  kind: MigrationRunKind;
  trigger: MigrationRunTrigger;
  requestedBy: string;
  params: object;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  planRunId?: string | null;
  planHash?: string | null;
}

interface NormalizedRunInput {
  kind: MigrationRunKind;
  trigger: MigrationRunTrigger;
  requestedBy: string;
  params: Record<string, unknown>;
  idempotencyKey: string | null;
  requestHash: string | null;
  planRunId: string | null;
  planHash: string | null;
}

function normalizeRunInput(input: CreateRunInput): NormalizedRunInput {
  if (!F3_RUN_KINDS.has(input.kind) && !F4_RUN_KINDS.has(input.kind)) {
    throw new MigrationError('PHASE_NOT_AVAILABLE', `Tipo di run ${String(input.kind)} non disponibile in ${MIGRATION_PHASE}`);
  }
  if (!(MIGRATION_RUN_TRIGGERS as readonly string[]).includes(input.trigger)) {
    throw new MigrationError('VALIDATION_FAILED', `trigger non valido: ammessi ${MIGRATION_RUN_TRIGGERS.join(', ')}`);
  }
  const requestedBy = String(input.requestedBy ?? '').trim().slice(0, 200);
  if (!requestedBy) throw new MigrationError('VALIDATION_FAILED', 'Richiedente del run mancante');
  const params = input.params ?? {};
  if (typeof params !== 'object' || Array.isArray(params)) throw new MigrationError('VALIDATION_FAILED', 'params del run: serve un oggetto');
  const key = input.idempotencyKey ?? null;
  if (key !== null && !IDEMPOTENCY_KEY_RE.test(key)) {
    throw new MigrationError('VALIDATION_FAILED', 'Chiave d\'idempotenza non valida: 8-200 caratteri [A-Za-z0-9._:-]');
  }
  const requestHash = input.requestHash ?? null;
  if (requestHash !== null && !HASH_RE.test(requestHash)) throw new MigrationError('VALIDATION_FAILED', 'request_hash non valido');
  const planRunId = input.planRunId ?? null;
  if (planRunId !== null && !UUID_RE.test(planRunId)) throw new MigrationError('VALIDATION_FAILED', 'plan_run_id non valido');
  const planHash = input.planHash ?? null;
  if (planHash !== null && !HASH_RE.test(planHash)) throw new MigrationError('VALIDATION_FAILED', 'plan_hash non valido');
  return {
    kind: input.kind,
    trigger: input.trigger,
    requestedBy,
    params: params as Record<string, unknown>,
    idempotencyKey: key,
    requestHash,
    planRunId: planRunId ? planRunId.toLowerCase() : null,
    planHash,
  };
}

/** Errore MIGRATION_BUSY con il run in corso (details.active_run). */
function busyError(active: MigrationRunView | null): MigrationError {
  const what = active ? ` (${active.kind})` : '';
  return new MigrationError('MIGRATION_BUSY', `È già in corso un run di migrazione${what}.`, { active_run: active });
}

async function findByIdempotencyKey(db: Db, key: string): Promise<RunRow | null> {
  const [row] = await db<RunRow[]>`SELECT ${runColumns(db)} FROM cal_migration_runs WHERE idempotency_key = ${key}`;
  return row ?? null;
}

/** Stessa chiave: replay se la richiesta è la stessa, altrimenti IDEMPOTENCY_KEY_REUSED. */
function replayOrReject(existing: RunRow, requestHash: string | null): RunCreatedResponse {
  if (existing.request_hash !== requestHash) {
    throw new MigrationError('IDEMPOTENCY_KEY_REUSED', 'Chiave d\'idempotenza già usata per una richiesta diversa: genera una chiave nuova', {
      run_id: existing.id,
    });
  }
  return { run: toRunView(existing), replayed: true };
}

/**
 * Replay anticipato per le route: con una chiave già usata restituisce il run
 * esistente (stessa richiesta) o lancia IDEMPOTENCY_KEY_REUSED, prima di
 * controllare precondizioni che dopo il primo run non valgono più (per
 * esempio "volume non inizializzato" dopo un'inizializzazione riuscita).
 * null se la chiave è nuova.
 */
export async function replayMigrationRun(idempotencyKey: string, requestHash: string | null, db: Db = sql): Promise<RunCreatedResponse | null> {
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new MigrationError('VALIDATION_FAILED', 'Chiave d\'idempotenza non valida: 8-200 caratteri [A-Za-z0-9._:-]');
  }
  const existing = await findByIdempotencyKey(db, idempotencyKey);
  return existing ? replayOrReject(existing, requestHash) : null;
}

/** INSERT del run queued e accodamento del job nella transazione `tx`. */
async function insertQueuedRun(tx: Db, input: NormalizedRunInput): Promise<string> {
  const [row] = await tx<Array<{ id: string }>>`
    INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, idempotency_key, request_hash, params, plan_run_id, plan_hash)
    VALUES (
      ${input.kind}, 'queued', ${input.trigger}, ${input.requestedBy}, ${input.idempotencyKey}, ${input.requestHash},
      ${tx.json(input.params as never)}, ${input.planRunId}::uuid, ${input.planHash}
    )
    RETURNING id::text AS id
  `;
  const job = await enqueueCalendarJob(MIGRATION_RUN_JOB_KIND, row.id, {}, {
    db: tx,
    maxAttempts: MIGRATION_LIMITS.runJobMaxAttempts,
    priority: CAL_JOB_PRIORITY.high,
  });
  await tx`UPDATE cal_migration_runs SET job_id = ${job.id}::bigint, updated_at = now() WHERE id = ${row.id}::uuid`;
  return row.id;
}

/**
 * Crea un run queued e il job che lo esegue, in una transazione. Errori:
 * MIGRATION_BUSY (details.active_run) se c'è già un run attivo,
 * IDEMPOTENCY_KEY_REUSED se la chiave è già stata usata per un'altra
 * richiesta; con la stessa chiave e la stessa richiesta restituisce il run
 * esistente con replayed = true (anche se nel frattempo è concluso).
 */
export async function createMigrationRun(input: CreateRunInput, opts: { db?: Db } = {}): Promise<RunCreatedResponse> {
  const db = opts.db ?? sql;
  const normalized = normalizeRunInput(input);
  if (normalized.idempotencyKey) {
    const existing = await findByIdempotencyKey(db, normalized.idempotencyKey);
    if (existing) return replayOrReject(existing, normalized.requestHash);
  }
  let id: string;
  try {
    id = await inTransaction(db, (tx) => insertQueuedRun(tx, normalized));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    if (normalized.idempotencyKey) {
      const existing = await findByIdempotencyKey(db, normalized.idempotencyKey);
      if (existing) return replayOrReject(existing, normalized.requestHash);
    }
    throw busyError(await activeMigrationRun(db));
  }
  const run = await getMigrationRun(id, db);
  if (!run) throw new MigrationError('INTERNAL', 'Run appena creato non trovato');
  log.info({ runId: id, kind: normalized.kind, trigger: normalized.trigger }, 'run di migrazione accodato');
  return { run, replayed: false };
}

/**
 * Run concluso subito, senza job (preflight senza Radicale configurato,
 * contratto §5.2 punto 5): riga `succeeded` con il riassunto e le righe.
 * Stesse regole d'idempotenza di createMigrationRun; un run attivo non lo
 * impedisce (non scrive nulla e non tiene il lock).
 */
export async function recordCompletedRun(
  input: CreateRunInput,
  result: { summary: object; items: readonly MigrationItemInput[]; progress?: MigrationProgress },
  opts: { db?: Db } = {},
): Promise<RunCreatedResponse> {
  const db = opts.db ?? sql;
  const normalized = normalizeRunInput(input);
  if (normalized.idempotencyKey) {
    const existing = await findByIdempotencyKey(db, normalized.idempotencyKey);
    if (existing) return replayOrReject(existing, normalized.requestHash);
  }
  let id: string;
  try {
    id = await inTransaction(db, async (tx) => {
      const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO cal_migration_runs (
          kind, status, trigger, requested_by, idempotency_key, request_hash, params, plan_run_id, plan_hash,
          progress, summary, attempts, started_at, finished_at, heartbeat_at
        ) VALUES (
          ${normalized.kind}, 'succeeded', ${normalized.trigger}, ${normalized.requestedBy}, ${normalized.idempotencyKey},
          ${normalized.requestHash}, ${tx.json(normalized.params as never)}, ${normalized.planRunId}::uuid, ${normalized.planHash},
          ${tx.json(sanitizeProgress(result.progress ?? { phase: 'done' }) as never)}, ${tx.json(result.summary as never)},
          1, now(), now(), now()
        )
        RETURNING id::text AS id
      `;
      await insertItems(tx, row.id, 0, result.items);
      return row.id;
    });
  } catch (err) {
    if (isUniqueViolation(err) && normalized.idempotencyKey) {
      const existing = await findByIdempotencyKey(db, normalized.idempotencyKey);
      if (existing) return replayOrReject(existing, normalized.requestHash);
    }
    throw err;
  }
  const run = await getMigrationRun(id, db);
  if (!run) throw new MigrationError('INTERNAL', 'Run appena creato non trovato');
  return { run, replayed: false };
}

// ─── Righe dei run ───────────────────────────────

/** Riga normalizzata ai vincoli della 165 (azione ed esito solo per object, livello e attesa solo per diff). */
function normalizeItem(item: MigrationItemInput, seq: number): Record<string, unknown> {
  if (!(MIGRATION_ITEM_TYPES as readonly string[]).includes(item.item_type)) {
    throw new MigrationError('INTERNAL', `tipo di riga non valido: ${String(item.item_type)}`);
  }
  const isObject = item.item_type === 'object';
  const isDiff = item.item_type === 'diff';
  const code = item.code ?? null;
  if (code !== null && !ERROR_CODE_RE.test(code)) throw new MigrationError('INTERNAL', `codice di riga non valido: ${code.slice(0, 80)}`);
  return {
    seq,
    item_type: item.item_type,
    calendar_id: item.calendar_id ?? null,
    collection_name: item.collection_name ?? null,
    href: item.href ?? null,
    legacy_key: item.legacy_key ?? null,
    action: isObject ? item.action ?? null : null,
    outcome: isObject ? item.outcome ?? null : null,
    code,
    level: isDiff ? item.level ?? null : null,
    severity: item.severity ?? 'info',
    expected: isDiff ? item.expected === true : null,
    detail: item.detail ?? {},
    forced: isObject ? item.forced === true : false,
  };
}

/** INSERT a blocchi delle righe a partire da `firstSeq`; restituisce gli id in ordine. */
async function insertItems(db: Db, runId: string, firstSeq: number, items: readonly MigrationItemInput[]): Promise<string[]> {
  const ids: string[] = [];
  for (let start = 0; start < items.length; start += ITEMS_INSERT_CHUNK) {
    const chunk = items.slice(start, start + ITEMS_INSERT_CHUNK).map((item, i) => normalizeItem(item, firstSeq + start + i));
    const rows = await db<Array<{ id: string; seq: number }>>`
      INSERT INTO cal_migration_items (
        run_id, seq, item_type, calendar_id, collection_name, href, legacy_key, action, outcome, code, level,
        severity, expected, detail, forced
      )
      SELECT ${runId}::uuid, r.seq, r.item_type, r.calendar_id, r.collection_name, r.href, r.legacy_key, r.action,
             r.outcome, r.code, r.level, r.severity, r.expected, COALESCE(r.detail, '{}'::jsonb), COALESCE(r.forced, false)
      FROM jsonb_to_recordset(${db.json(chunk as never)}::jsonb) AS r(
        seq int, item_type text, calendar_id uuid, collection_name text, href text, legacy_key text, action text,
        outcome text, code text, level text, severity text, expected boolean, detail jsonb, forced boolean
      )
      ORDER BY r.seq
      RETURNING id::text AS id, seq
    `;
    rows.sort((a, b) => a.seq - b.seq);
    for (const r of rows) ids.push(r.id);
  }
  return ids;
}

function sanitizeProgress(update: MigrationProgress): Record<string, unknown> {
  const out: Record<string, unknown> = { phase: String(update.phase ?? '').slice(0, 64) || 'run' };
  if (typeof update.done === 'number' && Number.isFinite(update.done)) out.done = Math.max(0, Math.floor(update.done));
  if (typeof update.total === 'number' && Number.isFinite(update.total)) out.total = Math.max(0, Math.floor(update.total));
  if (update.calendar_id !== undefined) out.calendar_id = typeof update.calendar_id === 'string' && UUID_RE.test(update.calendar_id) ? update.calendar_id : null;
  if (update.message !== undefined) out.message = update.message === null ? null : String(update.message).slice(0, 300);
  return out;
}

// ─── Lock ───────────────────────────────

/** Lock cal-migration occupato (MIGRATION_BUSY): lo shadow lo traduce in un'attesa del job. */
export class MigrationLockBusyError extends MigrationError {
  constructor(message = 'Lock cal-migration occupato da un altro run o da un job dello shadow') {
    super('MIGRATION_BUSY', message, { lock: MIGRATION_LOCK_KEY });
    this.name = 'MigrationLockBusyError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}

/**
 * Lock cal-migration (`pg_advisory_lock(hashtext('cal-migration'))` di
 * sessione) su una connessione riservata del pool principale, mai del pool
 * calendario: wait=true per l'esecutore (tentativi ogni 250 ms fino a
 * `timeoutMs`, default 30 s), false per lo shadow (un solo tentativo).
 * Occupato → MigrationLockBusyError (MIGRATION_BUSY). Rilasciato sempre,
 * anche se `fn` lancia.
 */
export async function withMigrationLock<T>(fn: () => Promise<T>, opts: { wait: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
  const conn = await sql.reserve();
  let owned = false;
  try {
    const deadline = Date.now() + (opts.wait ? Math.max(0, opts.timeoutMs ?? MIGRATION_LOCK_WAIT_MS) : 0);
    for (;;) {
      const [row] = await conn<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${MIGRATION_LOCK_KEY})) AS ok`;
      if (row?.ok === true) {
        owned = true;
        break;
      }
      if (!opts.wait || Date.now() >= deadline || opts.signal?.aborted) throw new MigrationLockBusyError();
      await sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
    }
    return await fn();
  } finally {
    if (owned) {
      await conn`SELECT pg_advisory_unlock(hashtext(${MIGRATION_LOCK_KEY}))`.catch((err: unknown) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'rilascio del lock cal-migration non riuscito: pg_advisory_unlock_all');
        return conn`SELECT pg_advisory_unlock_all()`.catch(() => undefined);
      });
    }
    conn.release();
  }
}

/** true se una sessione di questo database tiene il lock cal-migration. */
async function migrationLockHeld(db: Db): Promise<boolean> {
  const [row] = await db<Array<{ held: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks l
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext(${MIGRATION_LOCK_KEY})::bigint
    ) AS held
  `;
  return row?.held === true;
}

// ─── Esecutore ───────────────────────────────

/** Blocchi del finalize (finalize.ts, contratto f4 §5.4): per il wizard e la route POST /finalize. */
export async function finalizeBlockersOf(db: Db = sql, now: Date = new Date()): Promise<PreconditionReason[]> {
  return finalizeBlockers(db, now);
}

/** Funzione del modulo proprietario per ogni tipo di run (f3 §5.1, f4 §6.2). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RUN_HANDLERS: Readonly<Record<string, MigrationRunHandler<any, object>>> = Object.freeze({
  preflight: runPreflight,
  init: runInit,
  archive: runArchiveImport,
  identity: runIdentityReassign,
  inventory: runInventory,
  plan: runPlan,
  apply: runApply,
  verify: runVerify,
  cutover: runCutover,
  // Le funzioni del gruppo ROLLBACK accettano dipendenze facoltative come secondo argomento: l'esecutore passa solo il contesto.
  rollback_preview: (ctx: MigrationRunContext<RollbackPreviewParams>) => runRollbackPreview(ctx),
  rollback: (ctx: MigrationRunContext<RollbackParams>) => runRollback(ctx),
  rebaseline: (ctx: MigrationRunContext<RebaselineParams>) => runRebaselineRun(ctx),
  finalize: (ctx: MigrationRunContext<FinalizeParams>) => runFinalize(ctx),
});

/** Run che eseguono una transizione journalizzata (cal_migration_transitions). */
const TRANSITION_RUN_KINDS: ReadonlySet<MigrationRunKind> = new Set<MigrationRunKind>(['cutover', 'rollback', 'finalize']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlerOverrides = new Map<MigrationRunKind, MigrationRunHandler<any, object>>();

/**
 * Sostituisce la funzione di un tipo di run (solo test: ciclo di vita,
 * ripresa, annullamento). `null` ripristina quella del modulo.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setMigrationRunHandlerOverride(kind: MigrationRunKind, handler: MigrationRunHandler<any, object> | null): void {
  if (handler) handlerOverrides.set(kind, handler);
  else handlerOverrides.delete(kind);
}

/** Esecuzioni in corso nel processo: annullamento immediato da requestRunCancel(). */
const activeExecutions = new Map<string, { cancel: () => void }>();

/** Registra l'handler del job migration_run (bootstrap, prima di startCalendarJobWorker()). Idempotente. */
export function registerMigrationRunJob(): void {
  registerCalendarJobHandler(MIGRATION_RUN_JOB_KIND, handleMigrationRunJob, { leaseMs: MIGRATION_LIMITS.runJobLeaseMs });
}

/** Codice d'esito di un errore del run (MigrationError.code o details.run_error_code se è un MigrationRunErrorCode). */
export function runErrorCodeOf(err: unknown): MigrationRunErrorCode {
  if (err instanceof MigrationError) {
    const fromDetails = err.details?.run_error_code;
    if (typeof fromDetails === 'string' && RUN_ERROR_CODE_SET.has(fromDetails)) return fromDetails as MigrationRunErrorCode;
    if (RUN_ERROR_CODE_SET.has(err.code)) return err.code as MigrationRunErrorCode;
    return 'INTERNAL';
  }
  if (isRadicaleError(err)) return 'RADICALE_UNREACHABLE';
  if (isCalendarUnavailable(err)) {
    if (err.reason === 'identity_mismatch' || err.reason === 'identity_unverified') return 'IDENTITY_NOT_OK';
    if (err.reason === 'radicale_unreachable') return 'RADICALE_UNREACHABLE';
  }
  return 'INTERNAL';
}

/** Messaggio d'errore salvato nel run: solo testi dei moduli (in italiano, senza dati personali), mai messaggi grezzi del database. */
export function runErrorMessageOf(err: unknown): string {
  if (err instanceof MigrationError) return err.message.slice(0, 1000);
  if (isRadicaleError(err)) return `Errore di Radicale (${describeRadicaleError(err)}): riprova; se si ripete controlla la salute del calendario`;
  if (isCalendarUnavailable(err)) return `Calendario non disponibile (${err.reason}): riprova tra poco`;
  return 'Errore interno durante il run: dettagli nei log del server';
}

/**
 * Handler del job migration_run (contratto §5.2): il job ha come chiave l'id
 * del run. Un run già concluso o sparito chiude il job senza azione; un run
 * queued con l'annullamento richiesto diventa `cancelled`; altrimenti lock,
 * esecuzione ed esito. Lock occupato oltre l'attesa → errore d'attesa del
 * calendario (il job si riaccoda senza consumare tentativi).
 */
export async function handleMigrationRunJob(job: CalendarJob, jobCtx: CalendarJobContext): Promise<CalendarJobOutcome | void> {
  const runId = job.key.toLowerCase();
  if (!UUID_RE.test(runId)) throw new CalendarJobPermanentError(`chiave del job migration_run non valida: ${job.key.slice(0, 80)}`);
  const initial = await readRunRow(sql, runId);
  if (!initial) return { result: { run_id: runId, skipped: 'run_missing' } };
  if (TERMINAL_SET.has(initial.status)) return { result: { run_id: runId, skipped: 'run_terminal', status: initial.status } };
  if (initial.status === 'queued' && initial.cancel_requested_at) {
    await closeQueuedAsCancelled(runId);
    return { result: { run_id: runId, status: 'cancelled' } };
  }
  await jobCtx.extendLease(MIGRATION_LIMITS.runJobLeaseMs).catch(() => false);
  let locked = false;
  try {
    return await withMigrationLock(async () => {
      locked = true;
      return executeLocked(job, jobCtx, runId);
    }, { wait: true, timeoutMs: MIGRATION_LOCK_WAIT_MS, signal: jobCtx.signal });
  } catch (err) {
    if (!locked && err instanceof MigrationLockBusyError) {
      throw new CalendarUnavailableError('transition', 'lock cal-migration occupato: run di migrazione rimandato', { cause: err });
    }
    throw err;
  }
}

async function closeQueuedAsCancelled(runId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE cal_migration_runs
    SET status = 'cancelled', finished_at = now(), cancel_requested_at = COALESCE(cancel_requested_at, now()),
        error_code = 'CANCELLED', error = 'Annullato prima dell''avvio', updated_at = now()
    WHERE id = ${runId}::uuid AND status = 'queued'
    RETURNING id
  `;
  return rows.length > 0;
}

async function closeRunningAsCancelled(runId: string, progress: Record<string, unknown> | null): Promise<void> {
  await sql`
    UPDATE cal_migration_runs
    SET status = 'cancelled', finished_at = now(), heartbeat_at = now(),
        error_code = 'CANCELLED', error = 'Annullato su richiesta: le scritture già fatte restano registrate nel ledger e una nuova esecuzione riprende da lì',
        progress = COALESCE(${progress ? sql.json(progress as never) : null}::jsonb, progress), updated_at = now()
    WHERE id = ${runId}::uuid AND status = 'running'
  `;
}

async function executeLocked(job: CalendarJob, jobCtx: CalendarJobContext, runId: string): Promise<CalendarJobOutcome> {
  // Stato riletto dentro il lock: un altro esecutore può averlo concluso nel frattempo.
  const [row] = await sql<RunRow[]>`
    UPDATE cal_migration_runs
    SET status = 'running', started_at = COALESCE(started_at, now()), attempts = attempts + 1,
        heartbeat_at = now(), job_id = ${job.id}::bigint, error = NULL, error_code = NULL, updated_at = now()
    WHERE id = ${runId}::uuid
      AND (status = 'running' OR (status = 'queued' AND cancel_requested_at IS NULL))
    RETURNING ${runColumns(sql)}
  `;
  if (!row) {
    const current = await readRunRow(sql, runId);
    if (current?.status === 'queued' && current.cancel_requested_at) {
      await closeQueuedAsCancelled(runId);
      return { result: { run_id: runId, status: 'cancelled' } };
    }
    return { result: { run_id: runId, skipped: 'run_not_runnable', status: current?.status ?? null } };
  }
  if (row.cancel_requested_at) {
    // Annullamento chiesto mentre girava e mai concluso (crash): si chiude senza riprendere.
    await closeRunningAsCancelled(runId, null);
    return { result: { run_id: runId, status: 'cancelled' } };
  }

  const handler = handlerOverrides.get(row.kind) ?? RUN_HANDLERS[row.kind];
  if (!handler) {
    await failRun(runId, 'PRECONDITION_FAILED', `Tipo di run ${row.kind} non eseguibile in ${MIGRATION_PHASE}`, null);
    return { result: { run_id: runId, status: 'failed' } };
  }

  const runLog = log.child({ runId, kind: row.kind, attempt: row.attempts });
  const controller = new AbortController();
  let abortCause: 'cancel' | 'job' | null = null;
  const abort = (cause: 'cancel' | 'job', reason: unknown): void => {
    if (controller.signal.aborted) return;
    abortCause = cause;
    controller.abort(reason);
  };
  const onJobAbort = (): void => abort('job', jobCtx.signal.reason ?? new Error('esecutore fermato'));
  if (jobCtx.signal.aborted) onJobAbort();
  else jobCtx.signal.addEventListener('abort', onJobAbort, { once: true });
  activeExecutions.set(runId, { cancel: () => abort('cancel', new MigrationError('CANCELLED', 'Run annullato su richiesta')) });

  // Avanzamento: al più una scrittura ogni progressWriteIntervalMs, l'ultima sempre nell'esito.
  let latestProgress: Record<string, unknown> | null = null;
  let lastProgressWrite = 0;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let progressWrite: Promise<void> = Promise.resolve();
  const writeProgress = (): Promise<void> => {
    if (!latestProgress) return progressWrite;
    const value = latestProgress;
    lastProgressWrite = Date.now();
    progressWrite = progressWrite
      .then(async () => {
        await sql`
          UPDATE cal_migration_runs SET progress = ${sql.json(value as never)}, heartbeat_at = now(), updated_at = now()
          WHERE id = ${runId}::uuid AND status = 'running'
        `;
      })
      .catch((err: unknown) => runLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'avanzamento del run non salvato'));
    return progressWrite;
  };

  // Righe: seq in ordine anche dopo una ripresa (continua dall'ultima del tentativo precedente).
  const [{ next }] = await sql<Array<{ next: number }>>`
    SELECT COALESCE(MAX(seq) + 1, 0)::int AS next FROM cal_migration_items WHERE run_id = ${runId}::uuid
  `;
  let nextSeq = next;
  let itemsChain: Promise<unknown> = Promise.resolve();

  const ctx: MigrationRunContext<Record<string, unknown>> = {
    runId,
    kind: row.kind,
    trigger: row.trigger,
    actor: row.requested_by,
    params: asObject(row.params),
    planRunId: row.plan_run_id,
    planHash: row.plan_hash,
    attempt: row.attempts,
    signal: controller.signal,
    log: runLog,
    db: sql,
    async progress(update) {
      latestProgress = sanitizeProgress(update);
      const wait = MIGRATION_LIMITS.progressWriteIntervalMs - (Date.now() - lastProgressWrite);
      if (wait <= 0) {
        if (progressTimer) {
          clearTimeout(progressTimer);
          progressTimer = null;
        }
        await writeProgress();
      } else if (!progressTimer) {
        progressTimer = setTimeout(() => {
          progressTimer = null;
          void writeProgress();
        }, wait);
        progressTimer.unref?.();
      }
    },
    addItems(items) {
      const result = itemsChain.then(async () => {
        const first = nextSeq;
        nextSeq += items.length;
        try {
          return await insertItems(sql, runId, first, items);
        } catch (err) {
          nextSeq = first;
          throw err;
        }
      });
      itemsChain = result.catch(() => undefined);
      return result;
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw new MigrationError('CANCELLED', 'Run annullato');
    },
  };

  // Battito, lease del job e annullamento chiesto da un altro processo.
  let ticks = 0;
  const heartbeatEvery = Math.max(1, Math.round(MIGRATION_LIMITS.heartbeatIntervalMs / CANCEL_POLL_MS));
  let tickRunning = false;
  const ticker = setInterval(() => {
    if (tickRunning) return;
    tickRunning = true;
    ticks += 1;
    void (async () => {
      try {
        const [r] = await sql<Array<{ cancel_requested_at: Date | null; status: MigrationRunStatus }>>`
          SELECT cancel_requested_at, status FROM cal_migration_runs WHERE id = ${runId}::uuid
        `;
        if (r?.cancel_requested_at) abort('cancel', new MigrationError('CANCELLED', 'Run annullato su richiesta'));
        else if (r && r.status !== 'running') abort('job', new Error(`run passato a ${r.status} da un altro processo`));
        if (ticks % heartbeatEvery === 0) {
          await sql`UPDATE cal_migration_runs SET heartbeat_at = now(), updated_at = now() WHERE id = ${runId}::uuid AND status = 'running'`;
          const ok = await jobCtx.extendLease(MIGRATION_LIMITS.runJobLeaseMs);
          if (!ok) abort('job', new Error('lease del job migration_run perso'));
        }
      } catch (err) {
        runLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'battito del run non riuscito');
      } finally {
        tickRunning = false;
      }
    })();
  }, CANCEL_POLL_MS);
  ticker.unref?.();

  const started = Date.now();
  runLog.info('run di migrazione avviato');
  try {
    const summary = await handler(ctx);
    await itemsChain;
    if (progressTimer) clearTimeout(progressTimer);
    await progressWrite;
    const closed = await finishSucceeded(row, summary, latestProgress);
    runLog.info({ ms: Date.now() - started, closed }, 'run di migrazione concluso');
    return { result: { run_id: runId, status: closed ? 'succeeded' : 'not_running' } };
  } catch (err) {
    await itemsChain;
    if (progressTimer) clearTimeout(progressTimer);
    await progressWrite;
    if (abortCause === 'cancel' || (err instanceof MigrationError && err.code === 'CANCELLED' && (await cancelRequested(runId)))) {
      await closeRunningAsCancelled(runId, latestProgress);
      runLog.info({ ms: Date.now() - started }, 'run di migrazione annullato');
      return { result: { run_id: runId, status: 'cancelled' } };
    }
    if (abortCause === 'job') {
      // Arresto dell'API o lease perso: il run resta running e riprende (stesso run, attempt + 1).
      runLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'run di migrazione interrotto dall\'esecutore: riprenderà');
      throw err;
    }
    const code = runErrorCodeOf(err);
    const message = runErrorMessageOf(err);
    await failRun(runId, code, message, latestProgress);
    if (err instanceof MigrationError) runLog.warn({ code, migrationCode: err.code, ms: Date.now() - started }, `run di migrazione fallito: ${err.message}`);
    else runLog.error({ err, code, ms: Date.now() - started }, 'run di migrazione fallito per un errore inatteso');
    return { result: { run_id: runId, status: 'failed', error_code: code } };
  } finally {
    clearInterval(ticker);
    jobCtx.signal.removeEventListener('abort', onJobAbort);
    activeExecutions.delete(runId);
  }
}

async function cancelRequested(runId: string): Promise<boolean> {
  const [r] = await sql<Array<{ c: boolean }>>`SELECT cancel_requested_at IS NOT NULL AS c FROM cal_migration_runs WHERE id = ${runId}::uuid`;
  return r?.c === true;
}

async function failRun(runId: string, code: MigrationRunErrorCode, message: string, progress: Record<string, unknown> | null): Promise<void> {
  await sql`
    UPDATE cal_migration_runs
    SET status = 'failed', finished_at = now(), heartbeat_at = now(), error_code = ${code}, error = ${message},
        progress = COALESCE(${progress ? sql.json(progress as never) : null}::jsonb, progress), updated_at = now()
    WHERE id = ${runId}::uuid AND status = 'running'
  `;
}

/**
 * Chiude il run come riuscito; per un apply con follow_up_verify crea il run
 * di verifica nella stessa transazione (dopo la chiusura, così l'indice del
 * run attivo lo ammette). false se il run non era più running.
 */
async function finishSucceeded(row: RunRow, summary: object, progress: Record<string, unknown> | null): Promise<boolean> {
  const followUp = row.kind === 'apply' ? followUpVerifyOf(row.params) : null;
  return inTransaction(sql, async (tx) => {
    const closed = await tx`
      UPDATE cal_migration_runs
      SET status = 'succeeded', finished_at = now(), heartbeat_at = now(), summary = ${tx.json(summary as never)},
          progress = COALESCE(${progress ? tx.json(progress as never) : null}::jsonb, progress),
          error = NULL, error_code = NULL, updated_at = now()
      WHERE id = ${row.id}::uuid AND status = 'running'
      RETURNING id
    `;
    if (closed.length === 0) return false;
    if (followUp) {
      try {
        await (tx as unknown as { savepoint: (fn: (sp: Db) => Promise<unknown>) => Promise<unknown> }).savepoint(async (sp) => {
          await insertQueuedRun(sp, {
            kind: 'verify',
            trigger: row.trigger,
            requestedBy: row.requested_by,
            params: followUp as unknown as Record<string, unknown>,
            idempotencyKey: null,
            requestHash: null,
            planRunId: row.plan_run_id,
            planHash: null,
          });
        });
      } catch (err) {
        log.warn({ runId: row.id, err: err instanceof Error ? err.message : String(err) }, 'verifica successiva all\'apply non accodata');
      }
    }
    return true;
  });
}

function followUpVerifyOf(params: Record<string, unknown> | null): VerifyParams | null {
  const raw = asObject(params).follow_up_verify as Partial<VerifyParams> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const levels = Array.isArray(raw.levels) ? raw.levels.filter((l): l is VerifyLevel => (VERIFY_LEVELS as readonly string[]).includes(l)) : [...VERIFY_LEVELS];
  const days = typeof raw.v4_days === 'number' && Number.isInteger(raw.v4_days) && raw.v4_days > 0 ? raw.v4_days : MIGRATION_LIMITS.v4Days;
  const ids = Array.isArray(raw.scope?.calendar_ids) ? raw.scope.calendar_ids.filter((id) => typeof id === 'string' && UUID_RE.test(id)) : [];
  return { scope: ids.length ? { calendar_ids: ids } : {}, levels: levels.length ? levels : [...VERIFY_LEVELS], v4_days: days };
}

// ─── Annullamento e ripresa ───────────────────────────────

/**
 * Annullamento richiesto dall'admin: un run queued si chiude subito come
 * `cancelled`; uno running riceve cancel_requested_at (il modulo si ferma al
 * primo punto sicuro, mai fra intento ed esito di una scrittura).
 * RUN_NOT_FOUND / RUN_NOT_ACTIVE.
 */
export async function requestRunCancel(id: string, actor: string): Promise<MigrationRunView> {
  const run = await readRunRow(sql, id);
  if (!run) throw new MigrationError('RUN_NOT_FOUND', 'Run di migrazione non trovato');
  if (TERMINAL_SET.has(run.status)) {
    throw new MigrationError('RUN_NOT_ACTIVE', `Il run è già concluso (${run.status})`, { status: run.status });
  }
  if (run.status === 'queued' && (await closeQueuedAsCancelled(run.id))) {
    log.info({ runId: run.id, actor }, 'run di migrazione annullato prima dell\'avvio');
  } else {
    const rows = await sql`
      UPDATE cal_migration_runs SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
      WHERE id = ${run.id}::uuid AND status IN ('queued', 'running')
      RETURNING id
    `;
    if (rows.length === 0) {
      const now = await readRunRow(sql, run.id);
      throw new MigrationError('RUN_NOT_ACTIVE', `Il run è già concluso (${now?.status ?? 'sconosciuto'})`, { status: now?.status ?? null });
    }
    activeExecutions.get(run.id)?.cancel();
    log.info({ runId: run.id, actor }, 'annullamento del run di migrazione richiesto');
  }
  const view = await getMigrationRun(run.id);
  if (!view) throw new MigrationError('RUN_NOT_FOUND', 'Run di migrazione non trovato');
  return view;
}

/**
 * Run rimasti senza esecutore (avvio e ogni 5 minuti): `running` senza
 * battito da staleHeartbeatMs, con il lock libero e il job morto, concluso o
 * sparito → `interrupted`; `queued` senza un job che possa eseguirlo →
 * `failed`. Un run il cui job è pending o in lease riprende da solo e non si
 * tocca. Restituisce quanti run ha chiuso.
 */
export async function reapInterruptedRuns(opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - MIGRATION_LIMITS.staleHeartbeatMs);
  const queuedBefore = new Date(now.getTime() - QUEUED_WITHOUT_JOB_GRACE_MS);
  const rows = await sql<Array<{ id: string; kind: MigrationRunKind; status: MigrationRunStatus; job_status: string | null; last_beat: Date; created_at: Date }>>`
    SELECT r.id::text AS id, r.kind, r.status, j.status AS job_status,
           COALESCE(r.heartbeat_at, r.started_at, r.created_at) AS last_beat, r.created_at
    FROM cal_migration_runs r
    LEFT JOIN cal_jobs j ON j.id = r.job_id
    WHERE r.status IN ('queued', 'running')
  `;
  let closed = 0;
  for (const r of rows) {
    const jobGone = r.job_status === null || r.job_status === 'dead' || r.job_status === 'done' || r.job_status === 'superseded';
    if (!jobGone) continue;
    if (r.status === 'running') {
      if (r.last_beat.getTime() >= staleBefore.getTime()) continue;
      if (await migrationLockHeld(sql)) continue;
      // Run di transizione: la transizione resta `active` (journal) e il wizard la propone da riprendere.
      const message = TRANSITION_RUN_KINDS.has(r.kind)
        ? 'Esecutore interrotto: la transizione resta attiva con i passi già conclusi nel journal; riprendila (o annullala, se ammesso) dal wizard'
        : 'Esecutore interrotto senza ripresa possibile: ripeti l\'azione dal wizard (le scritture già fatte sono nel ledger)';
      const upd = await sql`
        UPDATE cal_migration_runs
        SET status = 'interrupted', finished_at = now(), error_code = 'INTERRUPTED',
            error = ${message},
            updated_at = now()
        WHERE id = ${r.id}::uuid AND status = 'running'
          AND COALESCE(heartbeat_at, started_at, created_at) < ${staleBefore}::timestamptz
        RETURNING id
      `;
      if (upd.length) {
        closed += 1;
        log.warn({ runId: r.id, jobStatus: r.job_status }, 'run di migrazione interrotto: nessun esecutore attivo');
      }
    } else if (r.created_at.getTime() < queuedBefore.getTime()) {
      const upd = await sql`
        UPDATE cal_migration_runs
        SET status = 'failed', finished_at = now(), error_code = 'INTERRUPTED',
            error = 'Run in coda senza un job che possa eseguirlo: ripeti l''azione dal wizard', updated_at = now()
        WHERE id = ${r.id}::uuid AND status = 'queued'
        RETURNING id
      `;
      if (upd.length) {
        closed += 1;
        log.warn({ runId: r.id, jobStatus: r.job_status }, 'run di migrazione in coda senza job: chiuso come fallito');
      }
    }
  }
  return closed;
}

// ─── Dichiarazioni ───────────────────────────────

const NOTE_MAX = 500;
const DEVICE_IDS = ['ios', 'macos', 'davx5', 'thunderbird'] as const;

function optionalNote(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new MigrationError('VALIDATION_FAILED', `${name}: atteso un testo`);
  const trimmed = value.trim();
  if (trimmed.length > NOTE_MAX) throw new MigrationError('VALIDATION_FAILED', `${name}: al più ${NOTE_MAX} caratteri`);
  return trimmed || null;
}

/** Valore di una dichiarazione validato e ridotto ai campi del contratto (§11.4). VALIDATION_FAILED altrimenti. */
export function normalizeDeclaration<K extends DeclarationKey>(key: K, value: unknown): DeclarationValues[K] {
  if (!(DECLARATION_KEYS as readonly string[]).includes(key)) {
    throw new MigrationError('VALIDATION_FAILED', `Dichiarazione sconosciuta: ammesse ${DECLARATION_KEYS.join(', ')}`);
  }
  const v = asObject(value);
  switch (key) {
    case 'phase0': {
      const status = v.status;
      if (status !== 'absent' && status !== 'archived' && status !== 'present_not_imported') {
        throw new MigrationError('VALIDATION_FAILED', 'phase0.status: ammessi absent, archived, present_not_imported');
      }
      const runId = v.archive_run_id ?? null;
      if (runId !== null && (typeof runId !== 'string' || !UUID_RE.test(runId))) throw new MigrationError('VALIDATION_FAILED', 'phase0.archive_run_id: atteso un UUID');
      return { status, note: optionalNote(v.note, 'phase0.note'), archive_run_id: runId ? runId.toLowerCase() : null } as DeclarationValues[K];
    }
    case 'remote_mode_accepted': {
      const reason = optionalNote(v.reason, 'remote_mode_accepted.reason');
      if (!reason || reason.length < 3) throw new MigrationError('VALIDATION_FAILED', 'remote_mode_accepted.reason: spiega perché accetti la remote mode');
      return { reason } as DeclarationValues[K];
    }
    case 'public_401_verified': {
      const method = v.method;
      if (method !== 'curl' && method !== 'browser' && method !== 'other') {
        throw new MigrationError('VALIDATION_FAILED', 'public_401_verified.method: ammessi curl, browser, other');
      }
      return { method, note: optionalNote(v.note, 'public_401_verified.note') } as DeclarationValues[K];
    }
    case 'backup_verified':
      return { note: optionalNote(v.note, 'backup_verified.note') } as DeclarationValues[K];
    case 'device_matrix': {
      const result = v.result;
      if (result !== 'passed' && result !== 'failed') throw new MigrationError('VALIDATION_FAILED', 'device_matrix.result: ammessi passed, failed');
      if (typeof v.strict_preconditions !== 'boolean') throw new MigrationError('VALIDATION_FAILED', 'device_matrix.strict_preconditions: atteso un booleano');
      const rule = v.allday_transp_rule;
      if (rule !== 'opaque_blocks' && rule !== 'never_block') {
        throw new MigrationError('VALIDATION_FAILED', 'device_matrix.allday_transp_rule: ammessi opaque_blocks, never_block');
      }
      const devices = v.devices;
      if (!Array.isArray(devices) || devices.length === 0 || devices.some((d) => !(DEVICE_IDS as readonly string[]).includes(d as string))) {
        throw new MigrationError('VALIDATION_FAILED', `device_matrix.devices: almeno uno fra ${DEVICE_IDS.join(', ')}`);
      }
      const unique = [...new Set(devices as string[])].sort() as DeclarationValues['device_matrix']['devices'];
      return {
        result,
        strict_preconditions: v.strict_preconditions,
        allday_transp_rule: rule,
        devices: unique,
        notes: optionalNote(v.notes, 'device_matrix.notes'),
      } as DeclarationValues[K];
    }
    default:
      throw new MigrationError('VALIDATION_FAILED', 'Dichiarazione sconosciuta');
  }
}

/**
 * Registra una dichiarazione del wizard in migration_declarations (con
 * istante e autore) e restituisce tutte le dichiarazioni. `phase0` con
 * stato `archived` richiede un run d'archivio riuscito (lo scrive anche
 * l'archivio stesso).
 */
export async function writeDeclaration<K extends DeclarationKey>(key: K, value: DeclarationValues[K], actor: string): Promise<MigrationDeclarations> {
  const clean = normalizeDeclaration(key, value);
  const by = String(actor ?? '').trim().slice(0, 200);
  if (!by) throw new MigrationError('VALIDATION_FAILED', 'Autore della dichiarazione mancante');
  if (key === 'phase0') {
    const p = clean as DeclarationValues['phase0'];
    if (p.status === 'archived') {
      if (!p.archive_run_id) throw new MigrationError('VALIDATION_FAILED', 'phase0 archived: indica il run d\'archivio (archive_run_id)');
      const [ok] = await sql<Array<{ id: string }>>`
        SELECT id::text AS id FROM cal_migration_runs WHERE id = ${p.archive_run_id}::uuid AND kind = 'archive' AND status = 'succeeded'
      `;
      if (!ok) throw new MigrationError('PRECONDITION_FAILED', 'phase0 archived: il run indicato non è un archivio riuscito', { reasons: [] });
    }
  }
  const declaration = { value: clean, at: new Date().toISOString(), by };
  const [row] = await sql<Array<{ migration_declarations: MigrationDeclarations }>>`
    UPDATE calendar_backend_state
    SET migration_declarations = migration_declarations || jsonb_build_object(${key}::text, ${sql.json(declaration as never)}::jsonb)
    WHERE id = true
    RETURNING migration_declarations
  `;
  if (!row) throw new MigrationError('INTERNAL', 'Stato del backend calendario assente');
  log.info({ key, by }, 'dichiarazione del wizard registrata');
  return row.migration_declarations;
}

// ─── Stato del wizard ───────────────────────────────

/** Dichiarazioni che cambiano l'esito del preflight (device_matrix no: è del passo 5). */
const PREFLIGHT_DECLARATIONS: readonly DeclarationKey[] = ['phase0', 'remote_mode_accepted', 'public_401_verified', 'backup_verified'];
const PREREQUISITE_KINDS: ReadonlySet<MigrationRunKind> = new Set<MigrationRunKind>(['preflight', 'init', 'archive', 'identity']);
const PREVIEW_KINDS: ReadonlySet<MigrationRunKind> = new Set<MigrationRunKind>(['inventory', 'plan']);
const HOUR_MS = 3_600_000;

const ACTIVE_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  preflight: 'preflight', init: 'inizializzazione', archive: 'archivio della Fase 0', identity: 'riassegnazione d\'identità',
  inventory: 'inventario', plan: 'anteprima', apply: 'apply', verify: 'verifica',
  cutover: 'passaggio a Radicale', rollback_preview: 'anteprima del rollback', rollback: 'ritorno a Postgres',
  rebaseline: 'ri-baseline del ledger', finalize: 'chiusura della finestra',
});

const COLOR_LABELS: Readonly<Record<string, string>> = Object.freeze({ green: 'verde', yellow: 'giallo', red: 'rosso' });

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function action(id: WizardActionId, enabled: boolean, reason: string | null, confirm: string | null = null): WizardAction {
  return { id, enabled, reason: enabled ? null : reason, confirm };
}

function ms(d: Date | null | undefined): number {
  return d ? d.getTime() : 0;
}

/** Ingressi della derivazione dei passi del wizard (deriveWizardSteps). */
export interface WizardStateInputs {
  now: Date;
  state: MigrationBackendState;
  configured: boolean;
  identity: { status: IdentityStatus; checked_at: string | null; detail: string | null };
  active: RunRow | null;
  lastByKind: Map<MigrationRunKind, RunRow>;
  lastFinishedByKind: Map<MigrationRunKind, RunRow>;
  lastSucceededByKind: Map<MigrationRunKind, RunRow>;
  verify: { runId: string | null; verdicts: CalendarVerdict[]; acceptable: boolean; finished_at: Date | null };
  parity: ParityView | null;
  ledger: { live: number; pending_intents: number; revalidation_pending: number };
  /**
   * Fine dell'ultimo apply riuscito che ha scritto qualcosa (null se nessuno):
   * un apply a zero scritture (recupero dello shadow, giro notturno senza
   * modifiche) non rende vecchia la verifica. Assente = l'ultimo apply riuscito.
   */
  lastWritingApplyAt?: Date | null;
  /**
   * Ingressi della F4 (contratto f4-modules §6.3): criteri del passaggio
   * (cutoverCriteria, null se non valutati o fuori da mode postgres),
   * transizione attiva o ultima, finestra di rollback e salute della
   * proiezione inversa. Assenti = derivazione senza la F4 (criteri ricavati
   * dagli ingressi puri, passaggio non disponibile).
   */
  f4?: {
    criteria: CutoverCriterion[] | null;
    transition: TransitionView | null;
    rollbackWindow: RollbackWindowView | null;
    reverse: ReverseProjectionHealthView | null;
  };
}

function activeBlocker(inputs: WizardStateInputs): string | null {
  if (!inputs.active) return null;
  return `È in corso un run (${ACTIVE_KIND_LABELS[inputs.active.kind] ?? inputs.active.kind}): attendi che finisca o annullalo`;
}

/** Ultimo backup coordinato recente (o dichiarazione di backup verificato valida). */
function backupRecent(state: MigrationBackendState, now: Date): { ok: boolean; detail: string | null } {
  const b = state.last_stack_backup;
  if (b && b.complete && typeof b.at === 'string') {
    const age = now.getTime() - Date.parse(b.at);
    const sameVolume = state.volume_id === null || b.volume_id === null || b.volume_id === state.volume_id;
    if (Number.isFinite(age) && age >= 0 && age < MIGRATION_LIMITS.backupMaxAgeHours * HOUR_MS && sameVolume) {
      return { ok: true, detail: `Backup coordinato del ${b.at}` };
    }
  }
  const d = state.migration_declarations.backup_verified;
  if (d && now.getTime() - Date.parse(d.at) < MIGRATION_LIMITS.backupDeclarationValidHours * HOUR_MS) {
    return { ok: true, detail: `Backup verificato a mano il ${d.at}` };
  }
  return { ok: false, detail: b ? `Ultimo backup coordinato: ${b.at}${b.complete ? '' : ' (incompleto)'}` : 'Nessun backup coordinato registrato' };
}

function preflightSummaryOf(row: RunRow | undefined): PreflightSummary | null {
  if (!row?.summary) return null;
  const s = row.summary as unknown as PreflightSummary;
  return Array.isArray(s.checks) ? s : null;
}

function applySummaryOf(row: RunRow | undefined): ApplySummary | null {
  if (!row?.summary) return null;
  return row.summary as unknown as ApplySummary;
}

function conflictCount(summary: Pick<ApplySummary, 'conflicts'> | Pick<PlanSummary, 'conflicts'> | null | undefined): number {
  if (!summary?.conflicts) return 0;
  return Object.values(summary.conflicts).reduce((acc: number, n) => acc + (typeof n === 'number' ? n : 0), 0);
}

function planBlockingAnomalies(summary: Record<string, unknown> | null): string[] {
  const preview = asObject(asObject(summary).preview);
  return Array.isArray(preview.blocking) ? (preview.blocking as unknown[]).filter((c): c is string => typeof c === 'string') : [];
}

/** Passo 1: prerequisiti e inizializzazione. */
function stepPrerequisites(inputs: WizardStateInputs): WizardStepView {
  const { state, configured, identity, active } = inputs;
  const busy = activeBlocker(inputs);
  const lastPreflight = inputs.lastSucceededByKind.get('preflight');
  const pf = preflightSummaryOf(lastPreflight);
  const blocking: string[] = [];

  // Il preflight vale finché non cambiano volume, collezioni o dichiarazioni.
  const changedAfter = Math.max(
    ms(inputs.lastSucceededByKind.get('init')?.finished_at),
    ms(inputs.lastSucceededByKind.get('archive')?.finished_at),
    ms(inputs.lastSucceededByKind.get('identity')?.finished_at),
    ...PREFLIGHT_DECLARATIONS.map((k) => {
      const d = state.migration_declarations[k];
      return d && typeof d.at === 'string' ? Date.parse(d.at) || 0 : 0;
    }),
  );
  const stale = !!lastPreflight && ms(lastPreflight.finished_at) < changedAfter;
  const failed = pf ? pf.checks.filter((c) => c.status === 'fail') : [];
  const toConfirm = pf ? pf.checks.filter((c) => c.status === 'confirm') : [];
  const warnings = pf ? pf.checks.filter((c) => c.status === 'warn') : [];
  const missing = pf?.missing_collections ?? [];
  const canaryMissing = pf ? pf.checks.some((c) => c.code === 'CANARY_COLLECTION' && c.status === 'warn') : false;
  const phase0 = state.migration_declarations.phase0;

  let status: WizardStepStatus;
  let summary: string;
  if (active && PREREQUISITE_KINDS.has(active.kind)) {
    status = 'running';
    summary = `In corso: ${ACTIVE_KIND_LABELS[active.kind]}`;
  } else if (!pf) {
    status = 'todo';
    summary = configured ? 'Esegui il preflight per controllare Radicale, identità del volume, gate e backup' : 'Radicale non è configurato: il preflight lo segnala e non si può procedere';
    if (!configured) blocking.push('Radicale non configurato (RADICALE_URL e credenziali di caldes-svc)');
  } else {
    for (const c of failed) blocking.push(`${c.code}: ${c.message}`);
    for (const c of toConfirm) blocking.push(`${c.code}: serve la dichiarazione ${c.declaration ?? ''}`.trim());
    if (identity.status !== 'ok') blocking.push(identity.status === 'uninitialized' ? 'Volume non ancora inizializzato' : `Identità del volume: ${identity.status}`);
    if (missing.length) blocking.push(`Collezioni mancanti: ${missing.join(', ')}`);
    if (canaryMissing) blocking.push('Collezione _canary mancante');
    if (!phase0) blocking.push('Manca la dichiarazione sul volume della Fase 0');
    if (stale) blocking.push('Il preflight è precedente all\'ultima inizializzazione o dichiarazione: ripetilo');
    const done = pf.ready && identity.status === 'ok' && missing.length === 0 && !canaryMissing && !!phase0 && !stale;
    if (done) {
      // Gli avvisi che restano (versione di Radicale non verificabile, eccezioni DST
      // ancora in PG...) non bloccano: il passo è concluso e li riporta nel riassunto,
      // altrimenti un avviso permanente fermerebbe tutto il wizard.
      status = 'done';
      summary = warnings.length
        ? `Prerequisiti a posto (${plural(warnings.length, 'avviso', 'avvisi')} da guardare)`
        : 'Prerequisiti a posto: volume inizializzato, collezioni e gate verificati';
    } else if (failed.length) {
      status = 'blocked';
      summary = `${plural(failed.length, 'controllo fallito', 'controlli falliti')}: correggi e ripeti il preflight`;
    } else {
      status = 'attention';
      summary = identity.status === 'uninitialized' && pf.can_initialize
        ? 'Volume vuoto: inizializza Radicale, poi ripeti il preflight'
        : toConfirm.length
          ? `${plural(toConfirm.length, 'controllo richiede', 'controlli richiedono')} una dichiarazione esplicita`
          : 'Completa i passi indicati e ripeti il preflight';
    }
  }

  const noRadicale = configured ? null : 'Radicale non configurato';
  const initReason = noRadicale ?? busy
    ?? (!pf ? 'Esegui prima il preflight'
      : identity.status !== 'uninitialized' ? 'Volume già inizializzato'
        : !pf.can_initialize ? 'Il volume non è vuoto o il principal esiste già: serve la riassegnazione d\'identità' : null);
  const createReason = noRadicale ?? busy
    ?? (identity.status !== 'ok' ? 'Serve un volume inizializzato con identità verificata'
      : !pf ? 'Esegui prima il preflight'
        : missing.length === 0 && !canaryMissing ? 'Nessuna collezione mancante secondo l\'ultimo preflight' : null);
  const archiveReason = noRadicale ?? busy ?? (identity.status !== 'ok' ? 'Serve un volume inizializzato con identità verificata' : null);
  const reassignPossible = state.mode === 'postgres' && (
    identity.status === 'mismatch' || (identity.status === 'unverified' && state.epoch >= 1)
    || (identity.status === 'uninitialized' && !!pf && !pf.can_initialize && pf.radicale.reachable === true)
  );
  const reassignReason = noRadicale ?? busy ?? (reassignPossible ? null : 'Identità del volume coerente: nessuna riassegnazione da fare');

  return {
    id: 'prerequisiti',
    index: 1,
    title: WIZARD_STEP_TITLES.prerequisiti,
    status,
    summary,
    blocking,
    last_run_id: (active && PREREQUISITE_KINDS.has(active.kind) ? active.id : lastPreflight?.id) ?? null,
    actions: [
      action('preflight', !busy, busy),
      action('initialize', initReason === null, initReason, MIGRATION_CONFIRMATIONS.initialize),
      action('create_collections', createReason === null, createReason, MIGRATION_CONFIRMATIONS.createCollections),
      action('archive', archiveReason === null, archiveReason, MIGRATION_CONFIRMATIONS.archive),
      action('declare', true, null, MIGRATION_CONFIRMATIONS.declare),
      action('identity_reassign', reassignReason === null, reassignReason, MIGRATION_CONFIRMATIONS.identityReassign),
    ],
  };
}

/** Anteprima valida: plan riuscito dopo l'ultimo preflight riuscito. */
function currentPlan(inputs: WizardStateInputs): RunRow | null {
  const plan = inputs.lastSucceededByKind.get('plan');
  const preflight = inputs.lastSucceededByKind.get('preflight');
  if (!plan || !preflight) return null;
  return ms(plan.finished_at) >= ms(preflight.finished_at) ? plan : null;
}

/** Passo 2: anteprima e opzioni. */
function stepPreview(inputs: WizardStateInputs, prev: WizardStepView): WizardStepView {
  const { active, now } = inputs;
  const busy = activeBlocker(inputs);
  const plan = currentPlan(inputs);
  const blocking: string[] = [];
  let status: WizardStepStatus;
  let summary: string;
  const prereqDone = prev.status === 'done';
  if (active && PREVIEW_KINDS.has(active.kind)) {
    status = 'running';
    summary = `In corso: ${ACTIVE_KIND_LABELS[active.kind]}`;
  } else if (!prereqDone) {
    status = 'locked';
    summary = 'Completa prima i prerequisiti';
  } else if (!plan) {
    status = 'todo';
    summary = 'Genera l\'anteprima: conteggi per calendario, anomalie e opzioni';
  } else {
    const s = plan.summary as unknown as PlanSummary;
    const conflicts = conflictCount(s);
    const anomalyBlocks = planBlockingAnomalies(plan.summary);
    const ageHours = (now.getTime() - ms(plan.finished_at)) / HOUR_MS;
    if (anomalyBlocks.length) blocking.push(`Anomalie bloccanti da correggere in PG: ${anomalyBlocks.join(', ')}`);
    if (conflicts) blocking.push(`${plural(conflicts, 'conflitto', 'conflitti')} nel piano`);
    if (ageHours > MIGRATION_LIMITS.planMaxAgeHours) blocking.push(`Anteprima di più di ${MIGRATION_LIMITS.planMaxAgeHours} ore fa: rigenerala`);
    status = blocking.length ? 'attention' : 'done';
    summary = `Anteprima: ${plural(s.writes ?? 0, 'scrittura', 'scritture')}, ${plural(s.totals?.noop ?? 0, 'oggetto invariato', 'oggetti invariati')}${conflicts ? `, ${plural(conflicts, 'conflitto', 'conflitti')}` : ''}`;
  }
  const reason = !prereqDone ? 'Completa prima i prerequisiti' : busy;
  return {
    id: 'anteprima',
    index: 2,
    title: WIZARD_STEP_TITLES.anteprima,
    status,
    summary,
    blocking,
    last_run_id: (active && PREVIEW_KINDS.has(active.kind) ? active.id : plan?.id ?? inputs.lastSucceededByKind.get('plan')?.id) ?? null,
    actions: [
      action('inventory', reason === null, reason),
      action('plan', reason === null, reason),
    ],
  };
}

/** Passo 3: apply. */
function stepApply(inputs: WizardStateInputs, preview: WizardStepView): WizardStepView {
  const { active, identity } = inputs;
  const busy = activeBlocker(inputs);
  const plan = currentPlan(inputs);
  const lastApply = inputs.lastFinishedByKind.get('apply');
  const blocking: string[] = [];
  let status: WizardStepStatus;
  let summary: string;
  if (active?.kind === 'apply') {
    status = 'running';
    summary = 'Apply in corso';
  } else if (!plan && !lastApply) {
    status = 'locked';
    summary = 'Serve un\'anteprima riuscita';
  } else if (!lastApply) {
    status = 'todo';
    summary = 'Applica il piano dell\'anteprima';
  } else if (lastApply.status !== 'succeeded') {
    status = 'attention';
    summary = `Ultimo apply ${lastApply.status === 'failed' ? 'fallito' : lastApply.status === 'cancelled' ? 'annullato' : 'interrotto'}: ripetilo (riprende dal ledger)`;
    if (lastApply.error) blocking.push(lastApply.error);
  } else {
    const s = applySummaryOf(lastApply);
    const conflicts = conflictCount(s);
    const failed = s?.failed ?? 0;
    const writes = s ? (s.writes?.create ?? 0) + (s.writes?.update ?? 0) + (s.writes?.delete ?? 0) : 0;
    if (conflicts) blocking.push(`${plural(conflicts, 'conflitto', 'conflitti')}: rivedi le righe e forza solo dove serve`);
    if (failed) blocking.push(`${plural(failed, 'oggetto fallito', 'oggetti falliti')}: ripeti l'apply`);
    if (plan && ms(plan.finished_at) > ms(lastApply.created_at)) blocking.push('Anteprima più recente dell\'ultimo apply: applica di nuovo');
    if (!s?.zero_writes) blocking.push('Ripeti per verificare zero scritture');
    status = blocking.length ? 'attention' : 'done';
    summary = s?.zero_writes
      ? 'Ultimo apply senza scritture: migrazione idempotente confermata'
      : `Ultimo apply: ${plural(writes, 'scrittura', 'scritture')}${conflicts ? `, ${plural(conflicts, 'conflitto', 'conflitti')}` : ''}${failed ? `, ${failed} falliti` : ''}`;
  }
  const blockingAnomalies = plan ? planBlockingAnomalies(plan.summary) : [];
  const reason = busy
    ?? (preview.status === 'locked' || !plan ? 'Serve un\'anteprima riuscita dopo l\'ultimo preflight'
      : identity.status !== 'ok' ? 'Identità del volume non verificata'
        : blockingAnomalies.length ? `Anomalie bloccanti: ${blockingAnomalies.join(', ')}` : null);
  return {
    id: 'applica',
    index: 3,
    title: WIZARD_STEP_TITLES.applica,
    status,
    summary,
    blocking,
    last_run_id: (active?.kind === 'apply' ? active.id : lastApply?.id) ?? null,
    actions: [action('apply', reason === null, reason, MIGRATION_CONFIRMATIONS.apply)],
  };
}

/** Passo 4: verifica. */
function stepVerify(inputs: WizardStateInputs): WizardStepView {
  const { active, verify } = inputs;
  const busy = activeBlocker(inputs);
  const lastApply = inputs.lastSucceededByKind.get('apply');
  const blocking: string[] = [];
  let status: WizardStepStatus;
  let summary: string;
  const reference = inputs.lastWritingApplyAt !== undefined ? inputs.lastWritingApplyAt : lastApply?.finished_at ?? null;
  const fresh = !!verify.runId && !!lastApply && ms(verify.finished_at) > ms(reference);
  const yellowPending = fresh ? verify.verdicts.filter((v) => v.color === 'yellow' && !v.accepted) : [];
  const red = fresh ? verify.verdicts.filter((v) => v.color === 'red') : [];
  if (active?.kind === 'verify' && !isHourlyRun(active)) {
    status = 'running';
    summary = 'Verifica in corso';
  } else if (!lastApply) {
    status = 'locked';
    summary = 'Serve un apply riuscito';
  } else if (!fresh) {
    status = 'todo';
    summary = 'Verifica V1-V5 dopo l\'ultimo apply';
  } else if (red.length) {
    status = 'blocked';
    summary = `${plural(red.length, 'calendario rosso', 'calendari rossi')}: differenze inattese da correggere`;
    for (const v of red) blocking.push(`${v.slug || v.collection_name}: differenze inattese`);
  } else if (yellowPending.length) {
    status = 'attention';
    summary = `${plural(yellowPending.length, 'calendario giallo', 'calendari gialli')} con differenze attese da accettare`;
    for (const v of yellowPending) blocking.push(`${v.slug || v.collection_name}: differenze attese da accettare`);
  } else {
    status = 'done';
    const yellow = verify.verdicts.filter((v) => v.color === 'yellow').length;
    summary = yellow ? `Tutti i calendari verdi o gialli accettati (${yellow} gialli)` : 'Tutti i calendari verdi';
  }
  const verifyReason = busy ?? (lastApply ? null : 'Serve un apply riuscito');
  const acceptReason = !fresh ? 'Nessuna verifica successiva all\'ultimo apply' : yellowPending.length === 0 ? 'Nessuna differenza attesa da accettare' : null;
  return {
    id: 'verifica',
    index: 4,
    title: WIZARD_STEP_TITLES.verifica,
    status,
    summary,
    blocking,
    last_run_id: (active?.kind === 'verify' && !isHourlyRun(active) ? active.id : verify.runId) ?? null,
    actions: [
      action('verify', verifyReason === null, verifyReason),
      action('accept', acceptReason === null, acceptReason, MIGRATION_CONFIRMATIONS.accept),
    ],
  };
}

function isHourlyRun(row: RunRow): boolean {
  const levels = asObject(row.params).levels;
  return row.trigger === 'schedule' && Array.isArray(levels) && levels.length === 1 && levels[0] === 'V4';
}

/** Passo 5: shadow e prova sui device. */
function stepShadow(inputs: WizardStateInputs, verifyStep: WizardStepView): WizardStepView {
  const { state, parity } = inputs;
  const matrix = state.migration_declarations.device_matrix;
  const matrixPassed = matrix?.value.result === 'passed';
  const blocking: string[] = [];
  let status: WizardStepStatus;
  let summary: string;
  if (!state.shadow_enabled) {
    if (verifyStep.status !== 'done') {
      status = 'locked';
      summary = 'Serve una verifica accettabile (verde o gialla accettata)';
    } else {
      status = 'todo';
      summary = 'Attiva lo shadow mirror: ogni scrittura legacy arriva su Radicale, i device restano in sola lettura';
    }
  } else {
    const p = parity;
    const days = p?.days_green ?? 0;
    const required = p?.required_days ?? MIGRATION_LIMITS.parityDaysRequired;
    const conflicts = p?.open_conflicts ?? 0;
    const lastColor = p?.last_nightly?.color ?? null;
    if (conflicts) blocking.push(`${plural(conflicts, 'conflitto aperto', 'conflitti aperti')} dello shadow`);
    // Stessa regola della parità: un giro notturno giallo con le differenze accettate è verde.
    if (p?.last_nightly?.green === false) {
      const detail = lastColor === 'yellow' ? ' con differenze non accettate' : '';
      blocking.push(`Ultimo giro ${COLOR_LABELS[lastColor ?? 'red'] ?? 'non verde'}${detail}: controlla la verifica notturna`);
    }
    if (p?.last_hourly?.color === 'red') blocking.push('Ultimo giro orario rosso: controlla la verifica V4 dei prossimi 14 giorni');
    if (p?.queue.dead) blocking.push(`${plural(p.queue.dead, 'job dello shadow in dead letter', 'job dello shadow in dead letter')}`);
    if (p?.satisfied && !matrixPassed) blocking.push(matrix ? 'Matrice device con esito negativo: ripeti la prova' : 'Registra l\'esito della matrice device');
    if (p?.satisfied && matrixPassed && blocking.length === 0) {
      status = 'done';
      summary = `Parità verde da ${days} giorni e matrice device superata`;
    } else if (blocking.length) {
      status = 'attention';
      summary = `Shadow attivo: ${days}/${required} giorni di parità verde`;
    } else {
      status = 'running';
      summary = `Shadow attivo: ${days}/${required} giorni di parità verde`;
    }
  }
  const onReason = state.shadow_enabled ? 'Lo shadow è già attivo'
    : verifyStep.status !== 'done' ? 'Serve una verifica accettabile dopo l\'ultimo apply'
      : !inputs.configured ? 'Radicale non configurato'
        : inputs.identity.status !== 'ok' ? 'Identità del volume non verificata'
          : inputs.ledger.revalidation_pending ? 'Righe del ledger da rivalidare: esegui un apply con "forza" REVALIDATION_REQUIRED' : null;
  return {
    id: 'shadow',
    index: 5,
    title: WIZARD_STEP_TITLES.shadow,
    status,
    summary,
    blocking,
    last_run_id: parity?.last_nightly?.verify_run_id ?? parity?.last_nightly?.apply_run_id ?? null,
    actions: [
      action('shadow_on', onReason === null, onReason, MIGRATION_CONFIRMATIONS.shadowOn),
      action('shadow_off', state.shadow_enabled, 'Lo shadow è già spento'),
      action('declare', true, null, null),
    ],
  };
}

/**
 * Criteri del cutover ricavati dai soli ingressi puri (quelli della F3): si
 * usano quando la derivazione non ha i criteri della F4 (cutoverCriteria,
 * che leggono database, control-plane e probe), per esempio nei test della
 * derivazione o se la loro lettura fallisce.
 */
function derivedCutoverCriteria(inputs: WizardStateInputs, verifyStep: WizardStepView): CutoverCriterion[] {
  const { state, parity, now } = inputs;
  const backup = backupRecent(state, now);
  const lastApply = applySummaryOf(inputs.lastSucceededByKind.get('apply'));
  const openConflicts = (parity?.open_conflicts ?? 0) + conflictCount(lastApply);
  const matrix = state.migration_declarations.device_matrix;
  return [
    {
      id: 'verify_acceptable',
      label: 'Verifica V1-V5: tutti i calendari verdi o gialli accettati',
      ok: verifyStep.status === 'done',
      detail: verifyStep.summary,
    },
    {
      id: 'shadow_parity',
      label: `Shadow con parità verde da almeno ${MIGRATION_LIMITS.parityDaysRequired} giorni`,
      ok: parity?.satisfied === true,
      detail: parity ? `${parity.days_green}/${parity.required_days} giorni${parity.shadow_enabled ? '' : ' (shadow spento)'}` : 'Parità non disponibile',
    },
    {
      id: 'device_matrix',
      label: 'Matrice device superata (iOS, macOS, DAVx5, Thunderbird) e decisioni documentate',
      ok: matrix?.value.result === 'passed',
      detail: matrix ? `Esito ${matrix.value.result === 'passed' ? 'superato' : 'negativo'} del ${matrix.at}` : 'Esito non registrato',
    },
    {
      id: 'backup_recent',
      label: `Backup coordinato di meno di ${MIGRATION_LIMITS.backupMaxAgeHours} ore`,
      ok: backup.ok,
      detail: backup.detail,
    },
    {
      id: 'no_open_conflicts',
      label: 'Nessun conflitto aperto (apply e shadow)',
      ok: openConflicts === 0,
      detail: openConflicts ? plural(openConflicts, 'conflitto aperto', 'conflitti aperti') : null,
    },
  ];
}

/** Criteri solo informativi: non bloccano il passaggio (per il cutover vale backup_fresh, contratto f4 §3.2). */
const INFORMATIVE_CRITERIA: ReadonlySet<CutoverCriterion['id']> = new Set<CutoverCriterion['id']>(['backup_recent']);

/** Criteri che bloccano il passaggio. */
function blockingCriteria(criteria: readonly CutoverCriterion[]): CutoverCriterion[] {
  return criteria.filter((c) => !c.ok && !INFORMATIVE_CRITERIA.has(c.id));
}

const TRANSITION_KIND_LABELS: Readonly<Record<TransitionKind, string>> = Object.freeze({
  cutover: 'Passaggio a Radicale',
  rollback: 'Ritorno a Postgres',
  finalize: 'Chiusura della finestra di rollback',
});

/** Frase digitata che riprende una transizione del tipo dato (contratto f4 §6.1). */
export const TRANSITION_RESUME_CONFIRMATIONS: Readonly<Record<TransitionKind, string>> = Object.freeze({
  cutover: MIGRATION_CONFIRMATIONS.cutover,
  rollback: MIGRATION_CONFIRMATIONS.rollback,
  finalize: MIGRATION_CONFIRMATIONS.finalize,
});

/** Motivi dei blocchi del finalize in italiano (finalizeBlockers, contratto f4 §5.4). */
const FINALIZE_BLOCKER_LABELS: Readonly<Partial<Record<PreconditionReason, string>>> = Object.freeze({
  MODE_NOT_RADICALE: 'il backend non è in mode radicale',
  FINALIZE_TOO_EARLY: `servono almeno ${F4_LIMITS.finalizeMinDays} giorni dal passaggio`,
  HEALTH_NOT_GREEN: 'la salute del calendario non è verde',
  DEAD_JOBS: 'ci sono job del calendario in dead letter',
  REVERSE_FAILED_OPEN: 'ci sono risorse non proiettate in Postgres (REVERSE_FAILED)',
  TRANSITION_ACTIVE: 'è attiva un\'altra transizione',
  ROLLBACK_WINDOW_EXPIRED: 'la finestra di rollback è scaduta',
});

/** Testo dei blocchi del finalize per il wizard. */
export function describeFinalizeBlockers(blockers: readonly PreconditionReason[]): string {
  return blockers.map((b) => FINALIZE_BLOCKER_LABELS[b] ?? b).join('; ');
}

const NOT_AUTHORITATIVE = 'Postgres non è più autorevole: le azioni della migrazione che scrivono sono ferme';
/** Azioni dei passi 1-5 che scrivono (o preparano una scrittura): ferme fuori da mode postgres (contratto f4 §6.3). */
const F3_WRITING_ACTIONS: ReadonlySet<WizardActionId> = new Set<WizardActionId>([
  'initialize', 'create_collections', 'archive', 'declare', 'identity_reassign', 'plan', 'apply', 'verify', 'accept', 'shadow_on',
]);

function freezeF3Actions(step: WizardStepView): WizardStepView {
  return {
    ...step,
    actions: step.actions.map((a) => (F3_WRITING_ACTIONS.has(a.id) ? { ...a, enabled: false, reason: NOT_AUTHORITATIVE } : a)),
  };
}

export type { RollbackPreviewCheck };

function previewCheckOf(row: RunRow | null | undefined, state: MigrationBackendState, now: Date): RollbackPreviewCheck {
  const base = { run_id: row?.id ?? null, finished_at: iso(row?.finished_at ?? null) };
  const summary = (row?.summary ?? null) as Partial<RollbackPreviewSummary> | null;
  const hash = summary && typeof summary.preview_hash === 'string' && HASH_RE.test(summary.preview_hash) ? summary.preview_hash : null;
  if (!row || row.kind !== 'rollback_preview' || row.status !== 'succeeded' || !hash || !row.finished_at) {
    return { ...base, ok: false, reason: 'PREVIEW_REQUIRED', message: 'Genera prima l\'anteprima del rollback', preview_hash: hash };
  }
  if (state.cutover_at && row.finished_at.getTime() < state.cutover_at.getTime()) {
    return { ...base, ok: false, reason: 'PREVIEW_REQUIRED', message: 'L\'anteprima è di un passaggio precedente: rigenerala', preview_hash: hash };
  }
  const ageMin = (now.getTime() - row.finished_at.getTime()) / 60_000;
  if (ageMin > F4_LIMITS.rollbackPreviewMaxAgeMinutes) {
    return { ...base, ok: false, reason: 'PREVIEW_STALE', message: `Anteprima di più di ${F4_LIMITS.rollbackPreviewMaxAgeMinutes} minuti fa: rigenerala`, preview_hash: hash };
  }
  return { ...base, ok: true, reason: null, message: null, preview_hash: hash };
}

/** Validità di un run d'anteprima del rollback (route POST /rollback, contratto f4 §5.1 preflight). */
export async function rollbackPreviewValidity(db: Db, previewRunId: string, now: Date = new Date()): Promise<RollbackPreviewCheck> {
  const [row, state] = await Promise.all([readRunRow(db, previewRunId), readMigrationState(db)]);
  return previewCheckOf(row, state, now);
}

/** Disponibilità del passaggio (contratto f4 §3.2 e §6.3). */
function cutoverAvailability(inputs: WizardStateInputs, verifyStep: WizardStepView): CutoverAvailability {
  const { state } = inputs;
  const f4 = inputs.f4;
  const transition = f4?.transition?.status === 'active' ? f4.transition : null;
  if (state.mode !== 'postgres') {
    return {
      available: false,
      phase: 'F4',
      reason: state.mode === 'finalized'
        ? 'Passaggio concluso e finestra di rollback chiusa: Radicale è l\'unico calendario'
        : state.mode === 'radicale'
          ? 'Passaggio già eseguito: Radicale è autorevole'
          : `Transizione in corso (mode ${state.mode})`,
      criteria: f4?.criteria ?? [],
    };
  }
  if (!f4?.criteria) {
    return {
      available: false,
      phase: 'F4',
      reason: 'Criteri del passaggio non valutati (database, control-plane o Radicale non leggibili): ricarica tra poco',
      criteria: derivedCutoverCriteria(inputs, verifyStep),
    };
  }
  const missing = blockingCriteria(f4.criteria);
  let reason: string;
  if (transition) reason = `${TRANSITION_KIND_LABELS[transition.kind]} in corso: riprendilo o annullalo`;
  else if (missing.length) reason = `Criteri mancanti: ${missing.length} di ${f4.criteria.filter((c) => !INFORMATIVE_CRITERIA.has(c.id)).length}`;
  else if (inputs.active) reason = activeBlocker(inputs) ?? 'Run in corso';
  else reason = 'Tutti i criteri sono soddisfatti: il passaggio si avvia con la conferma digitata';
  return {
    available: !transition && missing.length === 0 && !inputs.active,
    phase: 'F4',
    reason,
    criteria: f4.criteria,
  };
}

function journalProgress(t: TransitionView): { done: number; total: number } {
  const total = t.kind === 'cutover' ? 12 : t.kind === 'rollback' ? 9 : 4;
  const done = t.steps.filter((s) => s.step !== 'abort' && (s.status === 'done' || s.status === 'skipped')).length;
  return { done: Math.min(done, total), total };
}

/** Passo 6 con una transizione attiva: avanzamento, ripresa e annullamento. */
function stepTransitionActive(inputs: WizardStateInputs, t: TransitionView): WizardStepView {
  const { done, total } = journalProgress(t);
  const failed = t.steps.find((s) => s.status === 'failed' && s.step === t.next_step) ?? null;
  const runningHere = !t.resumable;
  const otherRun = inputs.active && inputs.active.kind !== t.kind ? activeBlocker(inputs) : null;
  const blocking: string[] = [];
  if (failed) blocking.push(`Passo ${failed.step} non riuscito${failed.error_code ? ` (${failed.error_code})` : ''}: ${failed.error ?? 'dettagli nel journal'}`);
  if (!runningHere) blocking.push(`Transizione ferma${t.next_step ? ` al passo ${t.next_step}` : ''}: riprendila${t.abortable ? ' o annullala' : ' (oltre il passo d\'epoch non si annulla più)'}`);
  const label = TRANSITION_KIND_LABELS[t.kind];
  const resumeReason = runningHere ? 'La transizione è già in esecuzione' : otherRun ?? 'Ripresa non disponibile';
  const abortReason = t.kind === 'finalize'
    ? 'La chiusura della finestra non si annulla'
    : !t.abortable
      ? 'Oltre il passo d\'epoch la transizione non si annulla più: riprendila fino in fondo'
      : runningHere
        ? 'Annulla prima il run in corso (o attendi che si fermi), poi annulla la transizione'
        : otherRun ?? 'Annullamento non disponibile';
  return {
    id: 'passaggio',
    index: 6,
    title: WIZARD_STEP_TITLES.passaggio,
    status: runningHere ? 'running' : 'attention',
    summary: runningHere
      ? `${label} in corso: ${done}/${total} passi${t.next_step ? `, ora ${t.next_step}` : ''}`
      : `${label} fermo${t.next_step ? ` al passo ${t.next_step}` : ''} (${done}/${total} passi conclusi)`,
    blocking,
    last_run_id: t.run_id,
    actions: [
      action('transition_resume', t.resumable && !otherRun, resumeReason, TRANSITION_RESUME_CONFIRMATIONS[t.kind]),
      action('cutover_abort', t.kind !== 'finalize' && t.abortable && t.resumable && !otherRun, abortReason, MIGRATION_CONFIRMATIONS.cutoverAbort),
      action('export_v2', false, 'Export non disponibile durante una transizione'),
    ],
  };
}

/** Passo 6 in mode postgres: criteri, passaggio e (dopo un rollback) ri-baseline di riparazione. */
function stepCutoverPostgres(inputs: WizardStateInputs, availability: CutoverAvailability, shadowStep: WizardStepView): WizardStepView {
  const f4 = inputs.f4;
  const busy = activeBlocker(inputs);
  const last = f4?.transition ?? null;
  const missing = f4?.criteria ? blockingCriteria(f4.criteria) : null;
  const notes: string[] = [];
  if (last?.kind === 'cutover' && last.status === 'aborted') {
    notes.push(`Ultimo passaggio annullato${last.finished_at ? ` il ${last.finished_at}` : ''}${last.outcome ? ` (${last.outcome})` : ''}`);
  }
  const rollbackDone = last?.kind === 'rollback' && last.status === 'completed';
  if (rollbackDone) notes.push(`Rollback concluso${last.finished_at ? ` il ${last.finished_at}` : ''}: Postgres autorevole, per ripassare serve una verifica completa accettabile`);

  let status: WizardStepStatus;
  let summary: string;
  if (inputs.active?.kind === 'cutover') {
    status = 'running';
    summary = 'Passaggio a Radicale in avvio';
  } else if (!missing) {
    status = 'locked';
    summary = 'Criteri del passaggio non valutati';
  } else if (missing.length === 0) {
    status = 'todo';
    summary = 'Criteri soddisfatti: puoi passare a Radicale';
  } else {
    status = shadowStep.status === 'done' ? 'blocked' : 'locked';
    summary = `Criteri mancanti: ${missing.length} di ${f4!.criteria!.filter((c) => !INFORMATIVE_CRITERIA.has(c.id)).length}`;
  }
  if (notes.length) summary = `${summary}. ${notes.join('. ')}`;
  const blocking = missing ? missing.map((c) => c.detail ?? c.label) : [availability.reason];

  const rebaselineReason = busy
    ?? (!rollbackDone ? 'La ri-baseline di riparazione serve solo dopo un rollback'
      : !inputs.configured ? 'Radicale non configurato'
        : inputs.identity.status !== 'ok' ? 'Identità del volume non verificata' : null);
  return {
    id: 'passaggio',
    index: 6,
    title: WIZARD_STEP_TITLES.passaggio,
    status,
    summary,
    blocking,
    last_run_id: inputs.lastByKind.get('cutover')?.id ?? null,
    actions: [
      action('cutover', availability.available, busy ?? availability.reason, MIGRATION_CONFIRMATIONS.cutover),
      action('rebaseline', rebaselineReason === null, rebaselineReason, MIGRATION_CONFIRMATIONS.apply),
      action('export_v2', false, 'L\'export v2 (un .ics per collezione) è disponibile dopo il passaggio: in mode postgres usa il backup JSON'),
    ],
  };
}

/** Passo 6 in mode radicale o finalized: finestra di rollback, anteprima, rollback, finalize ed export. */
function stepCutoverRadicale(inputs: WizardStateInputs): WizardStepView {
  const { state, now } = inputs;
  const f4 = inputs.f4;
  const busy = activeBlocker(inputs);
  const w = f4?.rollbackWindow ?? null;
  const reverse = f4?.reverse ?? null;
  const finalized = state.mode === 'finalized';
  const expired = w ? w.expired : !state.rollback_until || state.rollback_until.getTime() <= now.getTime();
  const preview = previewCheckOf(inputs.lastSucceededByKind.get('rollback_preview'), state, now);
  const cutoverSummary = asObject(inputs.lastSucceededByKind.get('cutover')?.summary);
  const smoke = asObject(cutoverSummary.smoke);
  const blocking: string[] = [];
  if (!finalized) {
    if (smoke.ok === false) blocking.push('Le prove finali del passaggio non sono riuscite: controlla il riassunto e valuta il rollback');
    if (reverse && reverse.by_status.failed > 0) blocking.push(`${plural(reverse.by_status.failed, 'risorsa non proiettata', 'risorse non proiettate')} in Postgres (REVERSE_FAILED): il rollback le perderebbe`);
    if (reverse && reverse.queue.dead > 0) blocking.push(`${plural(reverse.queue.dead, 'job della proiezione inversa', 'job della proiezione inversa')} in dead letter`);
    if (expired) blocking.push('Finestra di rollback scaduta: chiudila con "Chiudi finestra"');
  }

  let summary: string;
  if (finalized) {
    summary = `Finestra di rollback chiusa${state.finalized_at ? ` il ${state.finalized_at.toISOString()}` : ''}: Radicale è l'unico calendario`;
  } else if (expired) {
    summary = 'Radicale autorevole; finestra di rollback scaduta';
  } else {
    const days = w?.days_left ?? Math.max(0, Math.floor(((state.rollback_until?.getTime() ?? 0) - now.getTime()) / 86_400_000));
    summary = `Radicale autorevole${state.cutover_at ? ` dal ${state.cutover_at.toISOString()}` : ''}: ${plural(days, 'giorno', 'giorni')} per tornare a Postgres`;
  }

  const windowReason = finalized ? 'Finestra di rollback chiusa: il ritorno a Postgres non è più possibile'
    : expired ? 'Finestra di rollback scaduta' : null;
  const previewReason = busy ?? windowReason ?? (!inputs.configured ? 'Radicale non configurato' : null);
  const rollbackReason = busy ?? windowReason ?? (preview.ok ? null : preview.message);
  const finalizeReason = finalized ? 'Finestra già chiusa'
    : busy ?? (!w ? 'Stato della finestra non disponibile'
      : w.finalize_ready ? null
        : `Non ancora: ${describeFinalizeBlockers(w.finalize_blockers) || 'condizioni non soddisfatte'}${w.finalize_blockers.includes('FINALIZE_TOO_EARLY') ? ` (dal ${w.finalize_available_at})` : ''}`);
  return {
    id: 'passaggio',
    index: 6,
    title: WIZARD_STEP_TITLES.passaggio,
    status: finalized ? 'done' : blocking.length ? 'attention' : 'done',
    summary,
    blocking,
    last_run_id: inputs.lastByKind.get('rollback_preview')?.id ?? inputs.lastByKind.get('cutover')?.id ?? null,
    actions: [
      action('rollback_preview', previewReason === null, previewReason),
      action('rollback', rollbackReason === null, rollbackReason, MIGRATION_CONFIRMATIONS.rollback),
      action('finalize', finalizeReason === null, finalizeReason, MIGRATION_CONFIRMATIONS.finalize),
      action('export_v2', true, null),
    ],
  };
}

/** Passo 6: passaggio, rollback e chiusura della finestra (contratto f4 §6.3). */
function stepCutover(inputs: WizardStateInputs, availability: CutoverAvailability, shadowStep: WizardStepView): WizardStepView {
  const t = inputs.f4?.transition ?? null;
  if (t && t.status === 'active') return stepTransitionActive(inputs, t);
  const mode = inputs.state.mode;
  if (mode === 'postgres') return stepCutoverPostgres(inputs, availability, shadowStep);
  if (mode === 'radicale' || mode === 'finalized') return stepCutoverRadicale(inputs);
  // Mode di transizione senza una transizione attiva nel journal: stato incoerente, nessuna azione.
  return {
    id: 'passaggio',
    index: 6,
    title: WIZARD_STEP_TITLES.passaggio,
    status: 'blocked',
    summary: `Backend in mode ${mode} senza una transizione attiva nel journal`,
    blocking: ['Stato incoerente: controlla i log del server e la tabella cal_migration_transitions prima di qualsiasi azione'],
    last_run_id: null,
    actions: [
      action('transition_resume', false, 'Nessuna transizione attiva da riprendere'),
      action('cutover_abort', false, 'Nessuna transizione attiva da annullare'),
    ],
  };
}

/** Passi del wizard dallo stato (pura, esportata per i test). */
export function deriveWizardSteps(inputs: WizardStateInputs): { steps: WizardStepView[]; cutover: CutoverAvailability } {
  const s1 = stepPrerequisites(inputs);
  const s2 = stepPreview(inputs, s1);
  const s3 = stepApply(inputs, s2);
  const s4 = stepVerify(inputs);
  const s5 = stepShadow(inputs, s4);
  const cutover = cutoverAvailability(inputs, s4);
  const s6 = stepCutover(inputs, cutover, s5);
  const first = [s1, s2, s3, s4, s5];
  const steps = inputs.state.mode === 'postgres' ? [...first, s6] : [...first.map(freezeF3Actions), s6];
  return { steps, cutover };
}

/** Transizione attiva (o ultima conclusa) con `resumable` calcolato dai run (contratto f4 §6.2). */
export async function currentTransitionView(db: Db = sql): Promise<TransitionView | null> {
  const record = await getLatestTransition(db);
  if (!record) return null;
  let runActive = false;
  if (record.status === 'active') {
    // Un run dello stesso tipo in coda o in esecuzione la sta eseguendo (anche una ripresa appena chiesta).
    const [r] = await db<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_migration_runs WHERE status IN ('queued', 'running') AND kind = ${record.kind}
    `;
    runActive = (r?.n ?? 0) > 0;
  }
  return buildTransitionView(record, await readJournal(db, record.id), { runActive });
}

/** Finestra di rollback per il wizard (contratto f4 §6.3), null in mode postgres o senza passaggio. */
async function rollbackWindowFor(db: Db, state: MigrationBackendState, now: Date, lastPreview: RunRow | null | undefined): Promise<RollbackWindowView | null> {
  if (state.mode === 'postgres' || state.mode === 'cutover' || !state.cutover_at) return null;
  const until = state.rollback_until;
  const expired = !until || until.getTime() <= now.getTime();
  let blockers: PreconditionReason[] = [];
  if (state.mode === 'radicale') {
    try {
      blockers = await finalizeBlockersOf(db, now);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'blocchi del finalize non letti');
      blockers = ['HEALTH_NOT_GREEN'];
    }
  }
  return {
    cutover_at: state.cutover_at.toISOString(),
    cutover_by: state.cutover_by ?? null,
    rollback_until: until ? until.toISOString() : null,
    days_left: expired || !until ? 0 : Math.floor((until.getTime() - now.getTime()) / 86_400_000),
    expired,
    finalize_available_at: new Date(state.cutover_at.getTime() + F4_LIMITS.finalizeMinDays * 86_400_000).toISOString(),
    finalize_ready: state.mode === 'radicale' && blockers.length === 0,
    finalize_blockers: blockers,
    preview: previewCheckOf(lastPreview, state, now),
  };
}

async function identityForView(state: MigrationBackendState, configured: boolean): Promise<WizardStateInputs['identity']> {
  if (!configured) {
    return {
      status: state.epoch === 0 || state.volume_id === null ? 'uninitialized' : 'unverified',
      checked_at: null,
      detail: `Radicale non configurato${radicaleRuntime().unavailableReason ? `: ${radicaleRuntime().unavailableReason}` : ''}`,
    };
  }
  try {
    const { check } = await verifyVolumeIdentity({ state });
    return { status: check.status, checked_at: check.checkedAt, detail: check.detail };
  } catch (err) {
    const last = lastIdentityCheck();
    if (last) return { status: last.status, checked_at: last.checkedAt, detail: last.detail };
    return { status: state.epoch === 0 ? 'uninitialized' : 'unverified', checked_at: null, detail: err instanceof Error ? err.message.slice(0, 200) : 'identità non verificata' };
  }
}

async function runsByKind(db: Db, where: 'all' | 'finished' | 'succeeded'): Promise<Map<MigrationRunKind, RunRow>> {
  const rows = where === 'all'
    ? await db<RunRow[]>`
        SELECT DISTINCT ON (kind) ${runColumns(db)} FROM cal_migration_runs
        ORDER BY kind, created_at DESC, id DESC`
    : where === 'finished'
      ? await db<RunRow[]>`
          SELECT DISTINCT ON (kind) ${runColumns(db)} FROM cal_migration_runs
          WHERE finished_at IS NOT NULL
          ORDER BY kind, finished_at DESC, created_at DESC`
      : await db<RunRow[]>`
          SELECT DISTINCT ON (kind) ${runColumns(db)} FROM cal_migration_runs
          WHERE status = 'succeeded'
            AND NOT (kind = 'verify' AND trigger = 'schedule' AND params->'levels' = '["V4"]'::jsonb)
          ORDER BY kind, finished_at DESC NULLS LAST, created_at DESC`;
  return new Map(rows.map((r) => [r.kind, r]));
}

/**
 * Stato del wizard per GET /state (contratto §11.2): backend, identità,
 * Radicale, dichiarazioni, run attivo e ultimi run per tipo, ledger, coda
 * dello shadow, passi con le azioni ammesse e criteri del cutover. Mai
 * salvato: derivato a ogni chiamata.
 */
export async function buildMigrationStateView(): Promise<MigrationStateView> {
  const db = sql;
  const now = new Date();
  const state = await readMigrationState(db);
  const rt = radicaleRuntime();
  const configured = rt.client !== null;
  const [identity, lastByKind, lastFinishedByKind, lastSucceededByKind, activeRows, ledgerRows, queueRows, verify, writingApply] = await Promise.all([
    identityForView(state, configured),
    runsByKind(db, 'all'),
    runsByKind(db, 'finished'),
    runsByKind(db, 'succeeded'),
    db<RunRow[]>`SELECT ${runColumns(db)} FROM cal_migration_runs WHERE status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`,
    db<Array<{ live: number; pending_intents: number; revalidation_pending: number }>>`
      SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS live,
             count(*) FILTER (WHERE deleted_at IS NULL AND intent_op IS NOT NULL)::int AS pending_intents,
             count(*) FILTER (WHERE deleted_at IS NULL AND revalidate_reason IS NOT NULL)::int AS revalidation_pending
      FROM cal_migration_ledger
    `,
    db<Array<{ pending: number; running: number; dead: number }>>`
      SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'running')::int AS running,
             count(*) FILTER (WHERE status = 'dead')::int AS dead
      FROM cal_jobs WHERE kind = ${SHADOW_MIRROR_JOB_KIND}
    `,
    latestVerifyVerdicts(db).catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'verdetti dell\'ultima verifica non letti');
      return { runId: null, verdicts: [] as CalendarVerdict[], acceptable: false, finished_at: null as Date | null };
    }),
    db<Array<{ finished_at: Date }>>`
      SELECT finished_at FROM cal_migration_runs
      WHERE kind = 'apply' AND status = 'succeeded' AND finished_at IS NOT NULL
        AND COALESCE(summary->>'zero_writes', 'false') <> 'true'
      ORDER BY finished_at DESC
      LIMIT 1
    `,
  ]);
  let parity: ParityView | null = null;
  try {
    parity = await getParity(db, now);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'parità dello shadow non letta');
  }
  const active = activeRows[0] ?? null;
  const ledger = ledgerRows[0] ?? { live: 0, pending_intents: 0, revalidation_pending: 0 };
  const f4 = await readF4Inputs(db, state, identity, now, lastSucceededByKind);
  const inputs: WizardStateInputs = {
    now, state, configured, identity, active, lastByKind, lastFinishedByKind, lastSucceededByKind, verify, parity, ledger,
    lastWritingApplyAt: writingApply[0]?.finished_at ?? null,
    f4,
  };
  const { steps, cutover } = deriveWizardSteps(inputs);
  // Fuori da mode postgres, o con una transizione attiva, il lavoro è tutto nel passo 6.
  const onCutoverStep = state.mode !== 'postgres' || f4.transition?.status === 'active';
  const current = onCutoverStep
    ? ('passaggio' as WizardStepId)
    : steps.find((s) => s.status !== 'done' && s.id !== 'passaggio')?.id ?? ('passaggio' as WizardStepId);

  const lastRuns: MigrationStateView['last_runs'] = {};
  for (const [kind, row] of lastByKind) lastRuns[kind] = toRunView(row);
  const watch = currentWatchMode();
  const canary = lastCanaryResult();

  return {
    contract_version: MIGRATION_CONTRACT_VERSION,
    phase: MIGRATION_PHASE,
    backend: {
      mode: state.mode,
      shadow_enabled: state.shadow_enabled,
      shadow_since: iso(state.shadow_since),
      volume_id: state.volume_id,
      epoch: state.epoch,
      policy_version: state.policy_version,
      restore_guard_until: iso(state.restore_guard_until),
      rebuild_required: state.rebuild_required,
      api_min_version: state.api_min_version,
      cutover_at: iso(state.cutover_at),
      rollback_until: iso(state.rollback_until),
      finalized_at: iso(state.finalized_at),
    },
    identity,
    radicale: {
      configured,
      watch_mode: watch.mode,
      canary: canary ? { ok: canary.ok, reason: canary.reason ?? null } : null,
    },
    declarations: state.migration_declarations,
    last_stack_backup: state.last_stack_backup,
    active_run: active ? toRunView(active) : null,
    last_runs: lastRuns,
    ledger,
    shadow_queue: queueRows[0] ?? { pending: 0, running: 0, dead: 0 },
    wizard: { current_step: current, steps },
    cutover,
    transition: f4.transition,
    rollback_window: f4.rollbackWindow,
    reverse_projection: f4.reverse,
  };
}

/**
 * Ingressi della F4 per lo stato del wizard: transizione (con i run attivi),
 * criteri del passaggio in mode postgres (senza una nuova lettura remota
 * dell'identità: vale quella appena verificata per la vista, con la sua cache
 * breve; la route e il run ricontrollano tutto), finestra di rollback e salute
 * della proiezione inversa. Ogni lettura che fallisce lascia il proprio campo
 * a null (il wizard mostra "non disponibile") senza far fallire GET /state.
 */
async function readF4Inputs(
  db: Db,
  state: MigrationBackendState,
  identity: WizardStateInputs['identity'],
  now: Date,
  lastSucceededByKind: Map<MigrationRunKind, RunRow>,
): Promise<NonNullable<WizardStateInputs['f4']>> {
  const warn = (what: string) => (err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, `${what} non letti`);
    return null;
  };
  const transition = await currentTransitionView(db).catch(warn('transizione e journal'));
  const criteria = state.mode !== 'postgres'
    ? null
    : await cutoverCriteria(db, {
      now,
      transitionId: transition?.status === 'active' ? transition.id : null,
      deps: {
        assertWritable: async () => {
          if (identity.status !== 'ok') {
            throw new MigrationError('PRECONDITION_FAILED', `Identità del volume non verificata (${identity.status}${identity.detail ? `: ${identity.detail}` : ''})`, { reasons: ['IDENTITY_NOT_OK'] });
          }
          return state;
        },
      },
    }).catch(warn('criteri del passaggio'));
  const [rollbackWindow, reverse] = await Promise.all([
    rollbackWindowFor(db, state, now, lastSucceededByKind.get('rollback_preview')).catch(warn('finestra di rollback')),
    state.mode === 'radicale' || state.mode === 'rollback'
      ? readReverseProjectionHealth(db, now).catch(warn('salute della proiezione inversa'))
      : Promise.resolve(null),
  ]);
  return { criteria, transition, rollbackWindow, reverse };
}

/** Parametri di un apply dall'anteprima di riferimento (route POST /apply). */
export function applyParamsFromPlan(
  planParams: Record<string, unknown> | null,
  request: { expected_plan_hash: string | null; force_item_ids: string[]; force_codes: ApplyParams['force_codes'] },
): ApplyParams {
  const p = asObject(planParams);
  const scope = asObject(p.scope);
  const ids = Array.isArray(scope.calendar_ids) ? (scope.calendar_ids as unknown[]).filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)) : [];
  return {
    scope: ids.length ? { calendar_ids: ids } : {},
    options: (p.options ?? {}) as ApplyParams['options'],
    expected_plan_hash: request.expected_plan_hash,
    force_item_ids: request.force_item_ids,
    force_codes: request.force_codes,
    follow_up_verify: null,
  };
}

/** Stato attivo di un run (per le route). */
export function isRunActive(view: Pick<MigrationRunView, 'status'>): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(view.status);
}

/** Id dei passi in ordine (per l'admin e i test). */
export const WIZARD_STEPS: readonly WizardStepId[] = WIZARD_STEP_IDS;
