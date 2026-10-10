/**
 * Coda dei lavori del calendario su cal_jobs (fase F2 del passaggio a
 * Radicale; migrazione 164; design §4 "164 Lavori", §8 "Scrittori di
 * sistema", §9; contratto dei moduli docs/calendar-radicale/contracts/
 * f2-modules.md §3).
 *
 * Semantica:
 *  - enqueue con coalescenza SOLO sui pending (UNIQUE (kind, key) WHERE
 *    status='pending'): un nuovo accodamento con la stessa chiave aggiorna
 *    payload e source_version del pending esistente; un job già in
 *    esecuzione non lo assorbe, quindi nasce un nuovo pending che lo
 *    rieseguirà (revisione red-team punto 17). Si può accodare dentro la
 *    transazione del chiamante (opts.db): il job esiste solo se la tx fa
 *    commit (outbox, es. la prenotazione con il suo project_booking);
 *  - claim con lease: FOR UPDATE SKIP LOCKED, attempts+1, lease_token nuovo e
 *    locked_until; solo chi presenta il lease_token completa, fallisce o
 *    estende il job. Un lease scaduto (worker morto) rimette il job in coda,
 *    o in dead letter se ha esaurito i tentativi;
 *  - complete con controllo della source_version: se l'handler riporta una
 *    versione corrente diversa da quella del job, il job si riaccoda (o
 *    risulta 'superseded' se nel frattempo è nato un pending con la stessa
 *    chiave);
 *  - fail con backoff esponenziale e jitter; dead letter ('dead') per errori
 *    non ripetibili (CalendarJobPermanentError) o tentativi esauriti. Le
 *    indisponibilità del calendario (isCalendarJobWaitError: Radicale giù,
 *    transizione, freeze, identità, sync fallita per Radicale) non consumano
 *    tentativi: il job attende con una pausa fino a 15 minuti e va in dead
 *    letter solo dopo 48 h dalla creazione.
 *
 * Gli handler sono convergenti e idempotenti: lo stato desiderato si calcola
 * al momento dell'esecuzione (es. project_booking legge calendar_bookings),
 * mai dal payload, che è solo un suggerimento.
 *
 * Pool: claim, complete, fail e il worker usano il pool calendario dedicato
 * (calSql, src/db/index.ts) con comandi brevi; enqueue usa la connessione del
 * chiamante (default: pool principale).
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Logger } from 'pino';
import { calSql, sql } from '../../db';
import { captureException } from '../bugsink';
import { logger as rootLogger } from '../logger';
import { CalendarUnavailableError } from './errors';
import { CAL_CHANNELS } from './index-model';
import { isRadicaleError } from './radicale/errors';
import type { Db } from './radicale/policy';

const log: Logger = rootLogger.child({ scope: 'calendar-jobs' });

// ─── Tipi di lavoro ───────────────────────────────

/**
 * Tipi di lavoro noti (registro aperto: il CHECK della 164 accetta qualsiasi
 * `^[a-z][a-z0-9_]{0,63}$`). Ogni tipo ha un solo modulo proprietario che ne
 * registra l'handler (contratto f2-modules §3.2). Un job di un tipo senza
 * handler registrato resta pending: un'API più vecchia non lo esegue a metà.
 */
export const CAL_JOB_KINDS = Object.freeze({
  /** Proiezione di una prenotazione nella collezione bookings (booking.ts, solo store Radicale). */
  projectBooking: 'project_booking',
  /** Controllo post-commit delle sovrapposizioni prenotazione/evento (booking.ts). */
  bookingConflictCheck: 'booking_conflict_check',
  /** Specchio su Radicale di un'iscrizione device_visible (subscriptions/mirror.ts). */
  subscriptionMirror: 'subscription_mirror',
  /** Saga "questa e le successive" (radicale/store.ts). */
  recurrenceSplit: 'recurrence_split',
  /** Completamento di una creazione o cancellazione di calendario rimasta a metà (radicale/store.ts). */
  calendarLifecycle: 'calendar_lifecycle',
  /** Rebuild dell'indice, collezione per collezione (radicale/rebuild.ts). */
  indexRebuild: 'index_rebuild',
  /** F3: shadow mirror PG→Radicale. */
  shadowMirror: 'shadow_mirror',
  /** F4: proiezione inversa Radicale→PG nella finestra di rollback. */
  reverseProjection: 'reverse_projection',
});
export type CalJobKind = (typeof CAL_JOB_KINDS)[keyof typeof CAL_JOB_KINDS];

const KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Priorità: più basso = prima. */
export const CAL_JOB_PRIORITY = Object.freeze({
  high: 10,
  normal: 100,
  /** Specchio delle iscrizioni e altri lavori di fondo (design §6.6). */
  low: 200,
});

export const CAL_JOB_DEFAULTS = Object.freeze({
  maxAttempts: 8,
  /** Durata del lease di un claim. */
  leaseMs: 120_000,
  /** Backoff: base e tetto (con jitter ±20%). */
  backoffBaseMs: 5_000,
  backoffMaxMs: 3_600_000,
  /** Intervallo del worker senza notifiche. */
  workerIntervalMs: 5_000,
  /** Job per giro del worker. */
  workerBatch: 10,
  /** Retention dei job chiusi (done, superseded) e della dead letter. */
  finishedRetentionDays: 14,
  deadRetentionDays: 90,
  /**
   * Indisponibilità del calendario (Radicale giù, transizione F3/F4, freeze,
   * identità non verificata): il job attende senza consumare tentativi, con
   * una pausa che cresce con l'età del job fino a questo tetto.
   */
  unavailableBackoffMaxMs: 15 * 60_000,
  /** Tetto di tempo dell'attesa per indisponibilità, da created_at: oltre, dead letter. */
  unavailableMaxAgeMs: 48 * 3_600_000,
});

// ─── Errori ───────────────────────────────

/** Errore non ripetibile: il job va subito in dead letter. */
export class CalendarJobPermanentError extends Error {
  readonly code = 'CALENDAR_JOB_PERMANENT' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CalendarJobPermanentError';
  }
}

// ─── Modello ───────────────────────────────

export type CalJobStatus = 'pending' | 'running' | 'done' | 'dead' | 'superseded';

/** Job in lease, restituito dal claim. */
export interface CalendarJob<P extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  kind: string;
  key: string;
  payload: P;
  sourceVersion: string | null;
  priority: number;
  /** Tentativi compreso quello in corso. */
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  leaseToken: string;
  lockedBy: string;
  lockedUntil: Date;
  lastError: string | null;
  createdAt: Date;
}

interface JobRow {
  id: string;
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  source_version: string | null;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  lease_token: string;
  locked_by: string;
  locked_until: Date;
  last_error: string | null;
  created_at: Date;
}

function toJob(row: JobRow): CalendarJob {
  return {
    id: String(row.id),
    kind: row.kind,
    key: row.key,
    payload: row.payload ?? {},
    sourceVersion: row.source_version,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    leaseToken: row.lease_token,
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/** Messaggio d'errore sicuro per last_error (troncato, senza stack). */
function errorText(error: unknown): string {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return msg.slice(0, 2000);
}

/** Identità del worker nei log e in locked_by. */
export const DEFAULT_WORKER_ID = `${hostname()}:${process.pid}`;

// ─── Enqueue ───────────────────────────────

export interface EnqueueCalendarJobOptions {
  /** Versione della sorgente all'accodamento (es. updated_at della prenotazione). */
  sourceVersion?: string | null;
  /** Primo istante di esecuzione (default adesso). */
  runAfter?: Date;
  /** In alternativa a runAfter: ritardo da adesso. */
  delayMs?: number;
  /** Più basso = prima (default CAL_JOB_PRIORITY.normal). */
  priority?: number;
  maxAttempts?: number;
  /** Connessione o transazione del chiamante (default pool principale). */
  db?: Db;
}

export interface EnqueueCalendarJobResult {
  id: string;
  /** true se il job è stato fuso in un pending esistente con la stessa chiave. */
  coalesced: boolean;
}

/**
 * Accoda un job o lo fonde nel pending con la stessa (kind, key): payload e
 * source_version diventano quelli nuovi, run_after e priorità i più urgenti,
 * attempts torna a 0 (è una nuova intenzione). Un job running con la stessa
 * chiave non viene toccato.
 */
export async function enqueueCalendarJob(
  kind: string,
  key: string,
  payload: Record<string, unknown> = {},
  opts: EnqueueCalendarJobOptions = {},
): Promise<EnqueueCalendarJobResult> {
  if (!KIND_RE.test(kind)) throw new TypeError(`tipo di job non valido: ${JSON.stringify(kind)}`);
  if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 512) {
    throw new TypeError('chiave del job non valida (1-512 byte)');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('payload del job: serve un oggetto JSON');
  }
  const db = opts.db ?? sql;
  const priority = opts.priority ?? CAL_JOB_PRIORITY.normal;
  const maxAttempts = opts.maxAttempts ?? CAL_JOB_DEFAULTS.maxAttempts;
  const delayMs = Math.max(0, opts.delayMs ?? 0);
  const runAfterIso = opts.runAfter ? opts.runAfter.toISOString() : null;

  const [row] = await db<Array<{ id: string; inserted: boolean }>>`
    INSERT INTO cal_jobs (kind, key, payload, source_version, priority, max_attempts, run_after)
    VALUES (
      ${kind}, ${key}, ${db.json(payload as Parameters<typeof db.json>[0])}, ${opts.sourceVersion ?? null}, ${priority}, ${maxAttempts},
      COALESCE(${runAfterIso}::timestamptz, now() + ${delayMs} * INTERVAL '1 millisecond')
    )
    ON CONFLICT (kind, key) WHERE status = 'pending' DO UPDATE SET
      payload        = EXCLUDED.payload,
      source_version = EXCLUDED.source_version,
      priority       = LEAST(cal_jobs.priority, EXCLUDED.priority),
      max_attempts   = GREATEST(cal_jobs.max_attempts, EXCLUDED.max_attempts),
      run_after      = LEAST(cal_jobs.run_after, EXCLUDED.run_after),
      attempts       = 0
    RETURNING id, (xmax = 0) AS inserted
  `;
  return { id: String(row.id), coalesced: !row.inserted };
}

// ─── Claim ───────────────────────────────

export interface ClaimCalendarJobsOptions {
  /** Solo questi tipi (default tutti). */
  kinds?: readonly string[];
  /** Massimo di job (default 1). */
  limit?: number;
  leaseMs?: number;
  workerId?: string;
  db?: Db;
}

/**
 * Prende fino a `limit` job pending maturi (run_after ≤ adesso) in ordine di
 * priorità, con FOR UPDATE SKIP LOCKED: due worker non prendono mai lo stesso
 * job. Ogni job passa a running con attempts+1 e un lease nuovo.
 */
export async function claimCalendarJobs(opts: ClaimCalendarJobsOptions = {}): Promise<CalendarJob[]> {
  const db = opts.db ?? calSql;
  const limit = Math.max(1, Math.min(opts.limit ?? 1, 100));
  const leaseMs = Math.max(1_000, opts.leaseMs ?? CAL_JOB_DEFAULTS.leaseMs);
  const workerId = (opts.workerId ?? DEFAULT_WORKER_ID).slice(0, 200);
  const kinds = opts.kinds ? [...opts.kinds] : null;
  if (kinds && kinds.length === 0) return [];

  const rows = await db<JobRow[]>`
    WITH picked AS (
      SELECT id FROM cal_jobs
      WHERE status = 'pending'
        AND run_after <= now()
        ${kinds ? db`AND kind = ANY(${kinds}::text[])` : db``}
      ORDER BY priority, run_after, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE cal_jobs j SET
      status       = 'running',
      attempts     = j.attempts + 1,
      lease_token  = gen_random_uuid(),
      locked_by    = ${workerId},
      locked_until = now() + ${leaseMs} * INTERVAL '1 millisecond',
      started_at   = now()
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.id, j.kind, j.key, j.payload, j.source_version, j.priority, j.attempts, j.max_attempts,
              j.run_after, j.lease_token, j.locked_by, j.locked_until, j.last_error, j.created_at
  `;
  return rows
    .map(toJob)
    .sort((a, b) => a.priority - b.priority || a.runAfter.getTime() - b.runAfter.getTime() || Number(a.id) - Number(b.id));
}

/** Prolunga il lease di un job in esecuzione. false se il lease non è più suo. */
export async function extendCalendarJobLease(job: Pick<CalendarJob, 'id' | 'leaseToken'>, leaseMs: number, db: Db = calSql): Promise<boolean> {
  const rows = await db`
    UPDATE cal_jobs SET locked_until = now() + ${Math.max(1_000, leaseMs)} * INTERVAL '1 millisecond'
    WHERE id = ${job.id} AND status = 'running' AND lease_token = ${job.leaseToken}::uuid
    RETURNING id
  `;
  return rows.length === 1;
}

// ─── Chiusura ───────────────────────────────

/**
 * Esito di un aggiornamento di chiusura:
 * - done: completato;
 * - requeued: rimesso in coda (source_version cambiata, o errore ripetibile);
 * - superseded: chiuso perché esiste già un pending con la stessa chiave;
 * - dead: dead letter;
 * - lost: il lease non era più di chi chiama (scaduto e ripreso da un altro
 *   worker): nessuna modifica.
 */
export type CalendarJobCloseOutcome = 'done' | 'requeued' | 'superseded' | 'dead' | 'lost';

/**
 * Riporta un job running a pending, o a superseded se un pending con la
 * stessa chiave esiste già (l'indice parziale ne ammette uno solo). La corsa
 * con un enqueue concorrente si risolve ritentando dopo la violazione 23505.
 */
async function requeueOrSupersede(
  db: Db,
  job: Pick<CalendarJob, 'id' | 'leaseToken'>,
  set: {
    runAfterMs: number;
    resetAttempts: boolean;
    /** Restituisce il tentativo preso dal claim (attesa per indisponibilità). */
    refundAttempt?: boolean;
    sourceVersion?: string | null;
    lastError?: string | null;
    onlyIfExpired?: boolean;
  },
): Promise<CalendarJobCloseOutcome> {
  const hasSv = set.sourceVersion !== undefined;
  const expiredOnly = set.onlyIfExpired === true;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Superseded: la riga resta com'era (run_after, attempts, source_version
      // del lavoro eseguito); pending: nuovo run_after ed eventualmente la
      // versione corrente della sorgente.
      const rows = await db<Array<{ status: CalJobStatus }>>`
        WITH target AS (
          SELECT j.id, EXISTS (
                   SELECT 1 FROM cal_jobs p
                   WHERE p.kind = j.kind AND p.key = j.key AND p.status = 'pending' AND p.id <> j.id
                 ) AS has_pending
          FROM cal_jobs j
          WHERE j.id = ${job.id} AND j.status = 'running' AND j.lease_token = ${job.leaseToken}::uuid
            AND (NOT ${expiredOnly} OR j.locked_until < now())
        )
        UPDATE cal_jobs j SET
          status         = CASE WHEN t.has_pending THEN 'superseded' ELSE 'pending' END,
          finished_at    = CASE WHEN t.has_pending THEN now() ELSE NULL END,
          run_after      = CASE WHEN t.has_pending THEN j.run_after
                                ELSE now() + ${set.runAfterMs} * INTERVAL '1 millisecond' END,
          attempts       = CASE WHEN NOT t.has_pending AND ${set.resetAttempts} THEN 0
                                WHEN NOT t.has_pending AND ${set.refundAttempt === true} THEN GREATEST(j.attempts - 1, 0)
                                ELSE j.attempts END,
          source_version = CASE WHEN NOT t.has_pending AND ${hasSv} THEN ${set.sourceVersion ?? null} ELSE j.source_version END,
          last_error     = COALESCE(${set.lastError ?? null}, j.last_error),
          lease_token    = NULL,
          locked_by      = NULL,
          locked_until   = NULL
        FROM target t
        WHERE j.id = t.id
        RETURNING j.status
      `;
      if (rows.length === 0) return 'lost';
      return rows[0].status === 'superseded' ? 'superseded' : 'requeued';
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 2) throw err;
    }
  }
  return 'lost';
}

export interface CompleteCalendarJobOptions {
  /** Risultato informativo salvato nella riga (JSON). */
  result?: unknown;
  /**
   * Versione corrente della sorgente letta dall'handler a fine lavoro. Se
   * diversa da job.sourceVersion il job si riaccoda (design §4).
   */
  currentSourceVersion?: string | null;
  db?: Db;
}

/** Completa un job in lease (o lo riaccoda se la sorgente è cambiata nel frattempo). */
export async function completeCalendarJob(
  job: Pick<CalendarJob, 'id' | 'leaseToken' | 'sourceVersion'>,
  opts: CompleteCalendarJobOptions = {},
): Promise<CalendarJobCloseOutcome> {
  const db = opts.db ?? calSql;
  if (opts.currentSourceVersion !== undefined && opts.currentSourceVersion !== job.sourceVersion) {
    return requeueOrSupersede(db, job, { runAfterMs: 0, resetAttempts: true, sourceVersion: opts.currentSourceVersion });
  }
  const result = opts.result === undefined ? null : db.json(opts.result as Parameters<typeof db.json>[0]);
  const rows = await db`
    UPDATE cal_jobs SET
      status = 'done', finished_at = now(), result = ${result},
      lease_token = NULL, locked_by = NULL, locked_until = NULL
    WHERE id = ${job.id} AND status = 'running' AND lease_token = ${job.leaseToken}::uuid
    RETURNING id
  `;
  return rows.length === 1 ? 'done' : 'lost';
}

/** Backoff esponenziale con jitter ±20% (attempts = tentativi già fatti, ≥ 1). */
export function computeCalendarJobBackoffMs(attempts: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempts));
  const base = Math.min(CAL_JOB_DEFAULTS.backoffMaxMs, CAL_JOB_DEFAULTS.backoffBaseMs * 2 ** Math.min(n - 1, 30));
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.min(CAL_JOB_DEFAULTS.backoffMaxMs, Math.max(1_000, Math.round(base * jitter)));
}

export interface FailCalendarJobOptions {
  /** false: dead letter subito. Default: false solo per CalendarJobPermanentError. */
  retryable?: boolean;
  /** Ritardo esplicito del prossimo tentativo (default backoff esponenziale). */
  retryAfterMs?: number;
  db?: Db;
}

/** Codici di CollectionSyncError (radicale/sync.ts) che sono indisponibilità, non errori del job. */
const WAITING_SYNC_CODES: ReadonlySet<string> = new Set(['identity', 'not_configured', 'radicale', 'cas_exhausted', 'lock_timeout', 'timeout']);

/**
 * true se l'errore è un'indisponibilità del calendario e non un errore del
 * lavoro: calendario non verificabile o non scrivibile adesso
 * (CalendarUnavailableError: Radicale giù, transizione, write_freeze,
 * identità, freshness), errore transitorio o dall'esito ignoto di Radicale,
 * sync fallita per Radicale o lock, rebuild in corso. Il job attende senza
 * consumare tentativi (failCalendarJob).
 */
export function isCalendarJobWaitError(err: unknown): boolean {
  if (err instanceof CalendarJobPermanentError) return false;
  if (err instanceof CalendarUnavailableError) return true;
  if (isRadicaleError(err)) return err.transient || err.outcomeUnknown;
  const e = err as { name?: unknown; code?: unknown } | null;
  if (e?.name === 'CollectionSyncError') return typeof e.code === 'string' && WAITING_SYNC_CODES.has(e.code);
  if (e?.name === 'IndexRebuildBusyError') return true;
  return false;
}

/**
 * Pausa dell'attesa per indisponibilità: cresce con l'età del job (metà
 * dell'età, da 5 s a 15 minuti) senza un contatore dedicato, perché il
 * tentativo non viene consumato.
 */
export function computeCalendarJobWaitMs(ageMs: number, random: () => number = Math.random): number {
  const base = Math.min(CAL_JOB_DEFAULTS.unavailableBackoffMaxMs, Math.max(CAL_JOB_DEFAULTS.backoffBaseMs, Math.max(0, ageMs) / 2));
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.min(CAL_JOB_DEFAULTS.unavailableBackoffMaxMs, Math.max(1_000, Math.round(base * jitter)));
}

/**
 * Registra il fallimento di un job in lease: nuovo tentativo dopo il backoff,
 * oppure dead letter se l'errore non è ripetibile o i tentativi sono finiti.
 * Un'indisponibilità del calendario (isCalendarJobWaitError) non consuma il
 * tentativo: il job si riaccoda con la pausa dell'attesa finché l'età non
 * supera unavailableMaxAgeMs (48 h), poi va in dead letter. Così un fermo di
 * Radicale o una transizione più lunghi di qualche minuto non uccidono le
 * proiezioni, i controlli delle prenotazioni degradate e le saghe, che
 * ripartono da soli quando il calendario torna disponibile.
 */
export async function failCalendarJob(
  job: Pick<CalendarJob, 'id' | 'leaseToken' | 'attempts' | 'maxAttempts'> & { createdAt?: Date },
  error: unknown,
  opts: FailCalendarJobOptions = {},
): Promise<CalendarJobCloseOutcome> {
  const db = opts.db ?? calSql;
  const text = errorText(error);
  const retryable = opts.retryable ?? !(error instanceof CalendarJobPermanentError);
  if (retryable && isCalendarJobWaitError(error)) {
    const ageMs = job.createdAt ? Date.now() - job.createdAt.getTime() : 0;
    if (ageMs < CAL_JOB_DEFAULTS.unavailableMaxAgeMs) {
      const delay = opts.retryAfterMs ?? computeCalendarJobWaitMs(ageMs);
      return requeueOrSupersede(db, job, { runAfterMs: Math.max(0, delay), resetAttempts: false, refundAttempt: true, lastError: text });
    }
  }
  if (!retryable || job.attempts >= job.maxAttempts || isCalendarJobWaitError(error)) {
    const rows = await db`
      UPDATE cal_jobs SET
        status = 'dead', finished_at = now(), last_error = ${text},
        lease_token = NULL, locked_by = NULL, locked_until = NULL
      WHERE id = ${job.id} AND status = 'running' AND lease_token = ${job.leaseToken}::uuid
      RETURNING id
    `;
    return rows.length === 1 ? 'dead' : 'lost';
  }
  const delay = opts.retryAfterMs ?? computeCalendarJobBackoffMs(job.attempts);
  return requeueOrSupersede(db, job, { runAfterMs: Math.max(0, delay), resetAttempts: false, lastError: text });
}

// ─── Lease scaduti ───────────────────────────────

export interface RecoverExpiredLeasesResult {
  requeued: number;
  superseded: number;
  dead: number;
}

/**
 * Riprende i job running con il lease scaduto (worker morto o bloccato): di
 * nuovo pending (il tentativo perso conta), superseded se esiste già un
 * pending con la stessa chiave, dead se i tentativi sono finiti.
 */
export async function recoverExpiredCalendarJobLeases(db: Db = calSql, limit = 100): Promise<RecoverExpiredLeasesResult> {
  const expired = await db<Array<{ id: string; lease_token: string; attempts: number; max_attempts: number; locked_by: string | null }>>`
    SELECT id, lease_token, attempts, max_attempts, locked_by FROM cal_jobs
    WHERE status = 'running' AND locked_until < now()
    ORDER BY locked_until, id
    LIMIT ${Math.max(1, limit)}
  `;
  const out: RecoverExpiredLeasesResult = { requeued: 0, superseded: 0, dead: 0 };
  for (const row of expired) {
    const job = { id: String(row.id), leaseToken: row.lease_token, attempts: row.attempts, maxAttempts: row.max_attempts };
    const reason = `lease scaduto (${row.locked_by ?? 'worker sconosciuto'})`;
    // Riverifica nel WHERE (lease_token e locked_until): un worker lento che
    // completa adesso vince, e qui l'aggiornamento non trova la riga.
    if (job.attempts >= job.maxAttempts) {
      const rows = await db`
        UPDATE cal_jobs SET
          status = 'dead', finished_at = now(), last_error = ${reason},
          lease_token = NULL, locked_by = NULL, locked_until = NULL
        WHERE id = ${job.id} AND status = 'running' AND lease_token = ${job.leaseToken}::uuid AND locked_until < now()
        RETURNING id
      `;
      if (rows.length) out.dead++;
      continue;
    }
    // onlyIfExpired: un worker che nel frattempo ha esteso il lease lo conserva.
    const outcome = await requeueOrSupersede(db, job, { runAfterMs: 0, resetAttempts: false, lastError: reason, onlyIfExpired: true });
    if (outcome === 'requeued') out.requeued++;
    else if (outcome === 'superseded') out.superseded++;
  }
  if (out.requeued || out.superseded || out.dead) log.warn(out, 'job del calendario con lease scaduto ripresi');
  return out;
}

// ─── Amministrazione ───────────────────────────────

/** Rimette in coda un job della dead letter (azione dell'admin). false se non è dead o se esiste già un pending con la stessa chiave. */
export async function retryDeadCalendarJob(id: string, db: Db = calSql): Promise<boolean> {
  try {
    const rows = await db`
      UPDATE cal_jobs SET status = 'pending', attempts = 0, run_after = now(), finished_at = NULL
      WHERE id = ${id} AND status = 'dead'
      RETURNING id
    `;
    return rows.length === 1;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** Cancella i job chiusi oltre la retention (done e superseded 14 giorni, dead 90). */
export async function purgeFinishedCalendarJobs(
  opts: { finishedOlderThanDays?: number; deadOlderThanDays?: number; db?: Db } = {},
): Promise<number> {
  const db = opts.db ?? calSql;
  const finishedDays = opts.finishedOlderThanDays ?? CAL_JOB_DEFAULTS.finishedRetentionDays;
  const deadDays = opts.deadOlderThanDays ?? CAL_JOB_DEFAULTS.deadRetentionDays;
  const rows = await db`
    DELETE FROM cal_jobs
    WHERE (status IN ('done', 'superseded') AND finished_at < now() - ${finishedDays} * INTERVAL '1 day')
       OR (status = 'dead' AND finished_at < now() - ${deadDays} * INTERVAL '1 day')
    RETURNING id
  `;
  return rows.length;
}

export interface CalendarJobStats {
  pending: number;
  /** Pending già maturi (run_after passato). */
  due: number;
  running: number;
  dead: number;
  /** Età in secondi del pending maturo più vecchio (backlog), null se nessuno. */
  oldestDueAgeSeconds: number | null;
  /** Running con lease scaduto. */
  expiredLeases: number;
  byKind: Record<string, { pending: number; running: number; dead: number }>;
}

/** Statistiche della coda per /api/health/calendar. */
export async function calendarJobStats(db: Db = sql): Promise<CalendarJobStats> {
  const rows = await db<Array<{ kind: string; status: CalJobStatus; n: number; due: number; oldest: number | null; expired: number }>>`
    SELECT kind, status, count(*)::int AS n,
           count(*) FILTER (WHERE status = 'pending' AND run_after <= now())::int AS due,
           EXTRACT(EPOCH FROM now() - min(run_after) FILTER (WHERE status = 'pending' AND run_after <= now()))::float8 AS oldest,
           count(*) FILTER (WHERE status = 'running' AND locked_until < now())::int AS expired
    FROM cal_jobs
    WHERE status IN ('pending', 'running', 'dead')
    GROUP BY kind, status
  `;
  const stats: CalendarJobStats = { pending: 0, due: 0, running: 0, dead: 0, oldestDueAgeSeconds: null, expiredLeases: 0, byKind: {} };
  for (const r of rows) {
    const k = (stats.byKind[r.kind] ??= { pending: 0, running: 0, dead: 0 });
    if (r.status === 'pending') { stats.pending += r.n; k.pending += r.n; }
    if (r.status === 'running') { stats.running += r.n; k.running += r.n; }
    if (r.status === 'dead') { stats.dead += r.n; k.dead += r.n; }
    stats.due += r.due;
    stats.expiredLeases += r.expired;
    if (r.oldest !== null) stats.oldestDueAgeSeconds = Math.max(stats.oldestDueAgeSeconds ?? 0, Math.round(r.oldest));
  }
  return stats;
}

// ─── Handler e worker ───────────────────────────────

export interface CalendarJobContext {
  /** Annullato allo stop del worker o allo scadere del lease. */
  signal: AbortSignal;
  /** Prolunga il lease (lavori lunghi come il rebuild). */
  extendLease(ms?: number): Promise<boolean>;
  log: Logger;
}

/** Esito di un handler: risultato informativo e versione corrente della sorgente. */
export interface CalendarJobOutcome {
  result?: unknown;
  currentSourceVersion?: string | null;
}

export type CalendarJobHandler = (job: CalendarJob, ctx: CalendarJobContext) => Promise<CalendarJobOutcome | void>;

export interface CalendarJobHandlerOptions {
  /** Lease del claim per questo tipo (default CAL_JOB_DEFAULTS.leaseMs). */
  leaseMs?: number;
}

interface RegisteredHandler {
  handler: CalendarJobHandler;
  leaseMs: number;
}

const handlers = new Map<string, RegisteredHandler>();

/**
 * Registra l'handler di un tipo di job. Un tipo ha un solo handler: una
 * seconda registrazione è un errore di programmazione (due moduli che si
 * contendono lo stesso tipo).
 */
export function registerCalendarJobHandler(kind: string, handler: CalendarJobHandler, opts: CalendarJobHandlerOptions = {}): void {
  if (!KIND_RE.test(kind)) throw new TypeError(`tipo di job non valido: ${JSON.stringify(kind)}`);
  const existing = handlers.get(kind);
  if (existing && existing.handler !== handler) throw new Error(`handler già registrato per il tipo di job ${kind}`);
  handlers.set(kind, { handler, leaseMs: opts.leaseMs ?? CAL_JOB_DEFAULTS.leaseMs });
}

/** Toglie l'handler di un tipo (test). */
export function unregisterCalendarJobHandler(kind: string): void {
  handlers.delete(kind);
}

/** Tipi con un handler registrato nel processo. */
export function registeredCalendarJobKinds(): string[] {
  return [...handlers.keys()].sort();
}

export interface RunCalendarJobsSummary {
  claimed: number;
  done: number;
  requeued: number;
  superseded: number;
  dead: number;
  lost: number;
  recovered: RecoverExpiredLeasesResult;
}

/**
 * Un giro del worker: riprende i lease scaduti, poi prende ed esegue in
 * sequenza fino a `limit` job dei soli tipi con un handler registrato (un
 * claim per job, così il lease parte quando il job parte). Un handler che
 * lancia passa da failCalendarJob (backoff o dead letter); un handler oltre il
 * proprio lease viene annullato e il job fallisce come ripetibile.
 */
export async function runCalendarJobsOnce(
  opts: { limit?: number; workerId?: string; signal?: AbortSignal; db?: Db } = {},
): Promise<RunCalendarJobsSummary> {
  const db = opts.db ?? calSql;
  const workerId = opts.workerId ?? DEFAULT_WORKER_ID;
  const summary: RunCalendarJobsSummary = {
    claimed: 0, done: 0, requeued: 0, superseded: 0, dead: 0, lost: 0,
    recovered: await recoverExpiredCalendarJobLeases(db),
  };
  const limit = Math.max(1, opts.limit ?? CAL_JOB_DEFAULTS.workerBatch);

  for (let i = 0; i < limit; i++) {
    if (opts.signal?.aborted) break;
    const kinds = registeredCalendarJobKinds();
    if (kinds.length === 0) break;
    // Lease del tipo: si prende un job alla volta, con il lease più lungo fra
    // i tipi registrati e poi lo si adegua a quello del tipo preso.
    const maxLease = Math.max(...kinds.map((k) => handlers.get(k)!.leaseMs));
    const [job] = await claimCalendarJobs({ kinds, limit: 1, leaseMs: maxLease, workerId, db });
    if (!job) break;
    summary.claimed++;
    const entry = handlers.get(job.kind);
    if (!entry) {
      // Handler tolto fra il claim e qui (solo nei test): il job torna in coda.
      summary[await requeueOrSupersede(db, job, { runAfterMs: 0, resetAttempts: false }) === 'superseded' ? 'superseded' : 'requeued']++;
      continue;
    }
    if (entry.leaseMs !== maxLease) await extendCalendarJobLease(job, entry.leaseMs, db);
    const outcome = await executeJob(job, entry, db, opts.signal);
    summary[outcome]++;
  }
  return summary;
}

async function executeJob(job: CalendarJob, entry: RegisteredHandler, db: Db, outer?: AbortSignal): Promise<CalendarJobCloseOutcome> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer?.reason ?? new Error('worker fermato'));
  outer?.addEventListener('abort', onOuterAbort, { once: true });
  let leaseMs = entry.leaseMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`lease di ${leaseMs} ms scaduto`)), leaseMs);
    timer.unref?.();
  };
  armTimer();
  const jobLog = log.child({ jobId: job.id, kind: job.kind, key: job.key, attempt: job.attempts });
  const ctx: CalendarJobContext = {
    signal: controller.signal,
    log: jobLog,
    extendLease: async (ms = entry.leaseMs) => {
      const ok = await extendCalendarJobLease(job, ms, db);
      if (ok) { leaseMs = ms; armTimer(); }
      return ok;
    },
  };
  try {
    const result = await Promise.race([
      entry.handler(job, ctx),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      }),
    ]);
    const outcome = await completeCalendarJob(job, {
      result: result?.result,
      currentSourceVersion: result && 'currentSourceVersion' in result ? result.currentSourceVersion : undefined,
      db,
    });
    if (outcome === 'lost') jobLog.warn('job completato dopo la scadenza del lease: esito non registrato');
    return outcome;
  } catch (err) {
    const outcome = await failCalendarJob(job, err, { db });
    if (outcome === 'dead') {
      jobLog.error({ err }, 'job del calendario in dead letter');
      captureException(err instanceof Error ? err : new Error(String(err)), { scope: 'calendar-jobs', kind: job.kind, jobId: job.id });
    } else if (isCalendarJobWaitError(err)) {
      jobLog.info({ err: (err as Error)?.message ?? String(err), outcome }, 'calendario non disponibile: job in attesa (tentativo non consumato)');
    } else {
      jobLog.warn({ err, outcome }, 'job del calendario fallito');
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

// ─── Worker di processo ───────────────────────────────

interface WorkerState {
  stop: () => Promise<void>;
}

let worker: WorkerState | null = null;

/**
 * Avvia il worker dei job nel processo API: un giro ogni `intervalMs` (default
 * 5 s) e subito a ogni NOTIFY calendar_jobs. I giri non si sovrappongono.
 * Idempotente. Lo avvia il bootstrap (src/index.ts o il motore cron), lo
 * ferma lo shutdown con stopCalendarJobWorker().
 */
export async function startCalendarJobWorker(opts: { intervalMs?: number; workerId?: string; db?: Db } = {}): Promise<void> {
  if (worker) return;
  const db = opts.db ?? calSql;
  const intervalMs = Math.max(250, opts.intervalMs ?? CAL_JOB_DEFAULTS.workerIntervalMs);
  const controller = new AbortController();
  let running: Promise<void> | null = null;
  let again = false;

  const tick = (): void => {
    if (controller.signal.aborted) return;
    if (running) { again = true; return; }
    running = (async () => {
      try {
        do {
          again = false;
          await runCalendarJobsOnce({ workerId: opts.workerId, signal: controller.signal, db });
        } while (again && !controller.signal.aborted);
      } catch (err) {
        log.error({ err }, 'giro del worker dei job fallito');
      } finally {
        running = null;
      }
    })();
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  let unlisten: (() => Promise<void>) | null = null;
  try {
    const sub = await db.listen(CAL_CHANNELS.jobs, () => tick());
    unlisten = () => sub.unlisten();
  } catch (err) {
    log.warn({ err }, 'LISTEN calendar_jobs non disponibile: il worker gira solo a intervalli');
  }
  worker = {
    stop: async () => {
      controller.abort(new Error('worker fermato'));
      clearInterval(timer);
      await unlisten?.().catch(() => {});
      await running;
    },
  };
  tick();
}

/** Ferma il worker dei job e attende il giro in corso. Idempotente. */
export async function stopCalendarJobWorker(): Promise<void> {
  const current = worker;
  worker = null;
  await current?.stop();
}

/** Genera un lease token (esportato per i test che costruiscono job a mano). */
export function newLeaseToken(): string {
  return randomUUID();
}
