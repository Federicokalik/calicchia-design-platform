/**
 * Indicizzatore: unico scrittore di cal_objects, cal_components e
 * cal_occurrences (fase F2 del passaggio a Radicale; migrazione 163; design
 * §4, §6.2 passi 7-11, §6.4, §6.5, §6.7, §6.9, §9; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §1.3, §2 e §5.1).
 *
 * Da (collezione, href, etag, ICS) alle righe dell'indice, in due tempi:
 *  1. prepareCollectionChanges(): solo CPU (index-worker.ts: parse, espansione
 *     nell'orizzonte con tetto e budget, fingerprint, provenienza, kind,
 *     blocks, quarantena), in un worker_thread oltre 200 oggetti;
 *  2. applyPreparedChanges(): UNA transazione sul pool calendario dedicato,
 *     dentro withCollectionWriteLock (semaforo di processo, connessione
 *     riservata, advisory lock cal-sync:<id>), con CAS sul sync-token, id
 *     persistenti (ids.ts), versioni (versions.ts), quarantena con ultima
 *     versione buona, interruttore anti-cancellazione (hold), orizzonte e
 *     index_version. Idempotente: un oggetto con lo stesso etag e lo stesso
 *     contenuto (o lo stesso fingerprint semantico, per le iscrizioni) non
 *     produce scritture, versioni né incremento di index_version.
 *
 * Salute per oggetto (contratto §2.5):
 *  - testo valido → ok, occorrenze rigenerate, versione valid=true;
 *  - testo non valido di un oggetto già noto → quarantined; restano (stale)
 *    le occorrenze dell'ultima versione buona, rigenerate dalla versione
 *    stessa quando c'è (anche dopo un rebuild) o tenute dall'indice;
 *    raw_ics, etag e content_sha256 diventano quelli correnti, semantic_fp
 *    NULL, versione valid=false, last_good_version_id invariato;
 *  - testo non valido di un oggetto nuovo → quarantined con l'occorrenza
 *    conservativa (espansione o conservativeRangeFromText; fine aperta → fine
 *    dell'orizzonte); senza intervallo nessuna occorrenza, motivo 'unreadable';
 *  - budget di espansione esaurito → quarantined con l'occorrenza conservativa
 *    di expandObject (blocca solo se il master bloccherebbe);
 *  - oltre 5000 occorrenze nell'orizzonte → ok con materialized_until;
 *  - 404 con file su disco (skip_broken_item) → quarantined 'radicale-skip';
 *  - remote mode, primo 404 → pending_404, continua a bloccare.
 * Un errore di parse non fa mai fallire la transazione: fa quarantena.
 *
 * Regole contro lo stallo (contratto §1.3): al massimo CAL_SYNC_CONCURRENCY
 * (default 2) scrittori dell'indice per processo, ognuno con una connessione
 * riservata dal lock alla COMMIT; nessun annidamento di lock di collezioni
 * diverse; la stessa collezione nello stesso flusso riusa il lock (rientrante).
 *
 * Mode postgres: chiamato solo dalle sync in shadow e dal pull delle
 * iscrizioni con sidecar; nessun percorso di contratto legge queste tabelle.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type postgres from 'postgres';
import type { Logger } from 'pino';
import { CAL_DB_POOL_MAX, calSql, sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import {
  CAL_LOCKS,
  type CalObjectRow,
  HEALTH_REASONS,
  INDEX_LIMITS,
  type ObjectHealth,
  type OccurrenceKind,
  type OriginStore,
  targetHorizon,
} from '../index-model';
import { raiseIndexAlert } from './health';
import { allocateObjectIds, retireObjectIds } from './ids';
import {
  type ChangeSetInput,
  type CollectionContext,
  expandRawOnTheFly,
  type IndexWorkerRequest,
  type IndexWorkerResponse,
  type PreparedComponent,
  type PreparedItem,
  type PreparedMaterialization,
  type PreparedOccurrence,
  prepareContextOf,
  prepareForcedQuarantine,
  prepareItem,
  prepareItems,
  prepareLastGood,
  type RawItem,
  safeTimezone,
  semanticFingerprintOfRaw,
  timedOutItem,
} from './index-worker';
import type { Db } from './policy';
import { CALENDAR_ROLES, type CalendarRole } from './types';
import { lastValidVersions, latestVersions, needsNewVersion, recordVersion } from './versions';

export type { ChangeSetInput, CollectionContext, PreparedComponent, PreparedItem, PreparedOccurrence, RawItem } from './index-worker';

const log: Logger = rootLogger.child({ scope: 'calendar-indexer' });

type ReservedSql = postgres.ReservedSql;

// ─── Errori ───────────────────────────────

/** Il sync-token in database non è quello di partenza (design §6.2 passo 8): la sync riparte dal REPORT. */
export class CollectionCasError extends Error {
  readonly code = 'COLLECTION_CAS' as const;
  constructor(readonly calendarId: string, readonly expected: string | null, readonly actual: string | null) {
    super(`sync-token della collezione ${calendarId} cambiato durante la sync`);
    this.name = 'CollectionCasError';
  }
}

/** Lock della collezione non ottenuto entro il deadline (semaforo, connessione o advisory lock). */
export class CollectionLockTimeoutError extends Error {
  readonly code = 'COLLECTION_LOCK_TIMEOUT' as const;
  constructor(readonly calendarId: string, readonly stage: 'semaphore' | 'connection' | 'advisory') {
    super(`lock della collezione ${calendarId} non ottenuto in tempo (${stage})`);
    this.name = 'CollectionLockTimeoutError';
  }
}

/** Il calendario non esiste (cancellato nel frattempo). */
export class CollectionNotFoundError extends Error {
  readonly code = 'COLLECTION_NOT_FOUND' as const;
  constructor(readonly calendarId: string) {
    super(`calendario ${calendarId} inesistente`);
    this.name = 'CollectionNotFoundError';
  }
}

/** Operazione interrotta da un AbortSignal. */
export class IndexAbortedError extends Error {
  readonly code = 'INDEX_ABORTED' as const;
  constructor(readonly calendarId: string) {
    super(`operazione sull'indice della collezione ${calendarId} interrotta`);
    this.name = 'IndexAbortedError';
  }
}

// ─── Contesto della collezione ───────────────────────────────

/** Decisione 6 (all-day TRANSP:OPAQUE bloccanti): spenta in F2, CAL_ALLDAY_OPAQUE_BLOCKS=on nella release successiva. */
export function allDayOpaqueBlocksFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CAL_ALLDAY_OPAQUE_BLOCKS ?? '').trim().toLowerCase() === 'on';
}

/** Contesto di indicizzazione di una collezione dal sidecar. Lancia CollectionNotFoundError se il calendario non c'è. */
export async function loadCollectionContext(db: Db, calendarId: string): Promise<CollectionContext> {
  const rows = await db<Array<{ id: string; collection_name: string | null; slug: string; role: string; timezone: string | null }>>`
    SELECT id, collection_name, slug, role, timezone FROM calendars WHERE id = ${calendarId}
  `;
  const row = rows[0];
  if (!row) throw new CollectionNotFoundError(calendarId);
  const role: CalendarRole = (CALENDAR_ROLES as readonly string[]).includes(row.role) ? (row.role as CalendarRole) : 'user';
  const originStore: OriginStore = role === 'subscription' ? 'remote' : 'radicale';
  return {
    calendarId: row.id,
    collectionName: row.collection_name ?? row.slug,
    role,
    timezone: safeTimezone(row.timezone),
    originStore,
    versions: role !== 'subscription',
    blockRules: { allDayOpaqueBlocks: allDayOpaqueBlocksFromEnv() },
  };
}

/**
 * Crea la riga di stato della collezione se manca (idempotente). Se esiste con
 * un'altra origine (cambio di ruolo) la allinea, azzerando token e mtime per
 * le collezioni remote (CHECK della 163).
 */
export async function ensureCollectionState(tx: Db, calendarId: string, originStore: OriginStore): Promise<void> {
  await tx`
    INSERT INTO cal_collection_state (calendar_id, origin_store)
    VALUES (${calendarId}, ${originStore})
    ON CONFLICT (calendar_id) DO UPDATE SET
      origin_store = EXCLUDED.origin_store,
      sync_token = CASE WHEN EXCLUDED.origin_store = 'remote' THEN NULL ELSE cal_collection_state.sync_token END,
      dir_mtime_ns = CASE WHEN EXCLUDED.origin_store = 'remote' THEN NULL ELSE cal_collection_state.dir_mtime_ns END
    WHERE cal_collection_state.origin_store IS DISTINCT FROM EXCLUDED.origin_store
  `;
}

// ─── Preparazione ───────────────────────────────

export interface PreparedChangeSet {
  readonly input: ChangeSetInput;
  readonly items: readonly PreparedItem[];
  readonly preparedAt: Date;
}

/**
 * Prepara un change set (solo CPU, nessun I/O sul database): parse,
 * espansione, fingerprint, provenienza, kind e blocks di ogni risorsa. Oltre
 * INDEX_LIMITS.workerThreadsThreshold risorse (o con worker: true) gira in un
 * worker_thread; se il worker non è disponibile si ripiega sul thread
 * principale (stesso risultato).
 *
 * Un change set che nel worker supera il tempo massimo NON si ripete nel
 * thread principale (lo stesso testo lo bloccherebbe, e con lui
 * verify-credentials): le risorse si ripreparano una per una nel worker, con
 * un tempo massimo per risorsa, e quella che lo supera va in quarantena
 * 'index-error' con il blocco conservativo dal testo (timedOutItem).
 * `timeoutMs` e `itemTimeoutMs` servono ai test.
 */
export async function prepareCollectionChanges(
  input: ChangeSetInput,
  opts: { worker?: boolean | 'auto'; timeoutMs?: number; itemTimeoutMs?: number } = {},
): Promise<PreparedChangeSet> {
  prepareContextOf(input); // orizzonte valido, prima di qualsiasi lavoro
  const count = input.upserts.length + input.radicaleSkipped.length;
  const mode = opts.worker ?? 'auto';
  const useWorker = count > 0 && (mode === true || (mode === 'auto' && count > INDEX_LIMITS.workerThreadsThreshold));
  let items: PreparedItem[] | null = null;
  if (useWorker) {
    try {
      items = await indexWorkerPool.prepare(
        { context: input.context, horizon: input.horizon, upserts: input.upserts, radicaleSkipped: input.radicaleSkipped },
        opts.timeoutMs ?? WORKER_REQUEST_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof IndexWorkerTimeoutError) {
        log.warn({ calendarId: input.context.calendarId, count }, 'preparazione nel worker oltre il tempo massimo: risorse ripreparate una per una nel worker');
        items = await prepareItemsOneByOne(input, opts.itemTimeoutMs ?? WORKER_ITEM_TIMEOUT_MS);
      } else {
        log.warn({ err, calendarId: input.context.calendarId, count }, 'worker dell\'indicizzatore non disponibile: preparazione nel thread principale');
      }
    }
  }
  items ??= prepareItems(input);
  return { input, items, preparedAt: new Date() };
}

/**
 * Dopo il timeout di un change set: ogni risorsa si prepara da sola nel
 * worker (riavviato dopo il timeout) con `itemTimeoutMs`. Oltre, quarantena
 * 'index-error' con il blocco conservativo dal testo; con il worker non
 * disponibile la singola risorsa si prepara nel thread principale (i limiti
 * strutturali di calendar-core lo proteggono già).
 */
async function prepareItemsOneByOne(input: ChangeSetInput, itemTimeoutMs: number): Promise<PreparedItem[]> {
  const pc = prepareContextOf(input);
  const entries: Array<[RawItem, PreparedItem['origin']]> = [
    ...input.upserts.map((i): [RawItem, PreparedItem['origin']] => [i, 'upsert']),
    ...input.radicaleSkipped.map((i): [RawItem, PreparedItem['origin']] => [i, 'radicale-skip']),
  ];
  const out: PreparedItem[] = [];
  for (const [item, origin] of entries) {
    try {
      const [prepared] = await indexWorkerPool.prepare(
        { context: input.context, horizon: input.horizon, upserts: origin === 'upsert' ? [item] : [], radicaleSkipped: origin === 'radicale-skip' ? [item] : [] },
        itemTimeoutMs,
      );
      if (!prepared) throw new Error('risposta vuota del worker dell\'indicizzatore');
      out.push(prepared);
    } catch (err) {
      if (err instanceof IndexWorkerTimeoutError) {
        log.error({ calendarId: input.context.calendarId, href: item.href }, 'risorsa oltre il tempo massimo di preparazione: quarantena index-error con il blocco conservativo dal testo');
        out.push(timedOutItem(item, origin, pc));
      } else {
        out.push(prepareItem(item, origin, pc));
      }
    }
  }
  return out;
}

// ─── Worker thread ───────────────────────────────

/**
 * Bootstrap del worker: l'API gira con tsx, i cui hook non si propagano ai
 * worker_thread; il worker registra quindi il loader TypeScript
 * (tsx/esm/api) prima di importare index-worker.ts. Con un'API compilata in
 * JavaScript `tsxApi` è null e l'entry è il .js accanto a questo file.
 */
const WORKER_BOOT = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  if (workerData.tsxApi) {
    const api = await import(workerData.tsxApi);
    api.register();
  }
  const mod = await import(workerData.entry);
  mod.runIndexWorker();
})().catch((err) => {
  parentPort.postMessage({ id: -1, ok: false, error: String((err && err.stack) || err) });
});
`;

/** Tempo massimo di una preparazione nel worker (change set intero); oltre, risorse una per una. */
const WORKER_REQUEST_TIMEOUT_MS = 120_000;
/** Tempo massimo della preparazione di UNA risorsa nel worker dopo il timeout del change set. */
const WORKER_ITEM_TIMEOUT_MS = 15_000;

/** Preparazione nel worker oltre il tempo massimo (il worker viene riavviato). */
class IndexWorkerTimeoutError extends Error {
  constructor() {
    super('preparazione nel worker oltre il tempo massimo');
    this.name = 'IndexWorkerTimeoutError';
  }
}
/** Il worker inattivo si chiude dopo questo tempo. */
const WORKER_IDLE_MS = 60_000;

class IndexWorkerPool {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(items: PreparedItem[]): void; reject(err: Error): void; timer: NodeJS.Timeout }>();
  private idleTimer: NodeJS.Timeout | null = null;
  private disabledReason: string | null = null;

  private bootData(): { tsxApi: string | null; entry: string } {
    const self = fileURLToPath(import.meta.url);
    const ext = extname(self) || '.ts';
    const entry = new URL(`./index-worker${ext}`, import.meta.url).href;
    let tsxApi: string | null = null;
    if (ext === '.ts') {
      const resolver = (import.meta as unknown as { resolve?: (specifier: string) => string }).resolve;
      if (!resolver) throw new Error('import.meta.resolve non disponibile');
      tsxApi = resolver('tsx/esm/api');
    }
    return { tsxApi, entry };
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    if (this.disabledReason) throw new Error(this.disabledReason);
    let data: { tsxApi: string | null; entry: string };
    try {
      data = this.bootData();
    } catch (err) {
      // Senza tsx (né un .js compilato) il worker non può partire: si resta nel thread principale.
      this.disabledReason = `worker dell'indicizzatore disabilitato: ${(err as Error).message}`;
      throw new Error(this.disabledReason);
    }
    const worker = new Worker(WORKER_BOOT, { eval: true, workerData: data, name: 'caldes-indexer' });
    worker.on('message', (msg: IndexWorkerResponse) => this.onMessage(msg));
    worker.on('error', (err) => this.fail(worker, err));
    worker.on('exit', (code) => this.fail(worker, new Error(`worker dell'indicizzatore terminato (codice ${code})`)));
    this.worker = worker;
    return worker;
  }

  private onMessage(msg: IndexWorkerResponse): void {
    if (msg.id === -1 && !msg.ok) {
      if (this.worker) this.fail(this.worker, new Error(msg.error));
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.items);
    else entry.reject(new Error(msg.error));
    this.afterRequest();
  }

  private fail(worker: Worker, err: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
    void worker.terminate().catch(() => undefined);
  }

  private afterRequest(): void {
    if (this.pending.size > 0) return;
    this.worker?.unref();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.stop(), WORKER_IDLE_MS);
    this.idleTimer.unref();
  }

  prepare(input: IndexWorkerRequest['input'], timeoutMs = WORKER_REQUEST_TIMEOUT_MS): Promise<PreparedItem[]> {
    const worker = this.start();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    worker.ref();
    const id = this.nextId++;
    return new Promise<PreparedItem[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new IndexWorkerTimeoutError());
        this.fail(worker, new Error('worker dell\'indicizzatore bloccato: riavviato'));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, input } satisfies IndexWorkerRequest);
    });
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const worker = this.worker;
    if (!worker) return;
    this.fail(worker, new Error('worker dell\'indicizzatore fermato'));
  }
}

const indexWorkerPool = new IndexWorkerPool();

/** Ferma il worker_thread dell'indicizzatore e l'ANALYZE programmato (shutdown dell'API, test). Idempotente. */
export async function stopIndexWorker(): Promise<void> {
  await stopIndexAnalyze();
  await indexWorkerPool.stop();
}

// ─── Lock della collezione ───────────────────────────────

export interface CollectionLock {
  readonly calendarId: string;
  readonly conn: ReservedSql;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** Attesa di default del lock quando il chiamante non dà un deadline. */
const DEFAULT_LOCK_WAIT_MS = 30_000;
/** Timeout dei lock di riga e delle istruzioni dentro la transazione dell'indicizzatore. */
const TX_LOCK_TIMEOUT = '15s';
const TX_STATEMENT_TIMEOUT = '120s';

/** Scrittori dell'indice contemporanei per processo (CAL_SYNC_CONCURRENCY, ≤ CAL_DB_POOL_MAX − 2). */
export function collectionWriteConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.CAL_SYNC_CONCURRENCY ?? '', 10);
  const wanted = Number.isFinite(raw) && raw > 0 ? raw : 2;
  return Math.max(1, Math.min(wanted, CAL_DB_POOL_MAX - 2));
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: () => number) {}

  async acquire(deadline: number, signal: AbortSignal | undefined, onTimeout: () => Error, onAbort: () => Error): Promise<() => void> {
    if (signal?.aborted) throw onAbort();
    if (this.active < this.max()) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const grant = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.active++;
        resolve();
      };
      const drop = (err: Error): void => {
        if (done) return;
        done = true;
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        signal?.removeEventListener('abort', abort);
        reject(err);
      };
      const abort = (): void => drop(onAbort());
      const timer = setTimeout(() => drop(onTimeout()), Math.max(0, deadline - Date.now()));
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(grant);
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      while (this.waiters.length > 0 && this.active < this.max()) {
        const next = this.waiters.shift();
        next?.();
      }
    };
  }
}

const writerSemaphore = new Semaphore(() => collectionWriteConcurrency());
const heldLock = new AsyncLocalStorage<CollectionLockImpl>();

class CollectionLockImpl implements CollectionLock {
  private inTransaction = false;
  closed = false;
  constructor(readonly calendarId: string, readonly conn: ReservedSql) {}

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error(`lock della collezione ${this.calendarId} già rilasciato`);
    const tx = this.conn as unknown as Db;
    if (this.inTransaction) return fn(tx); // annidata: stessa transazione
    await this.conn`BEGIN`;
    this.inTransaction = true;
    try {
      await this.conn.unsafe(`SET LOCAL lock_timeout = '${TX_LOCK_TIMEOUT}'`);
      await this.conn.unsafe(`SET LOCAL statement_timeout = '${TX_STATEMENT_TIMEOUT}'`);
      const result = await fn(tx);
      await this.conn`COMMIT`;
      return result;
    } catch (err) {
      try {
        await this.conn`ROLLBACK`;
      } catch (rollbackErr) {
        log.warn({ err: rollbackErr, calendarId: this.calendarId }, 'ROLLBACK della transazione dell\'indicizzatore non riuscito');
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveConnection(calendarId: string, deadline: number): Promise<ReservedSql> {
  const pending = calSql.reserve();
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CollectionLockTimeoutError(calendarId, 'connection')), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch (err) {
    // La connessione arrivata dopo il timeout torna subito al pool.
    void pending.then((conn) => conn.release()).catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Esegue `fn` tenendo il lock di scrittura dell'indice della collezione:
 * semaforo di processo (CAL_SYNC_CONCURRENCY), connessione riservata del pool
 * calendario e pg_try_advisory_lock(hashtext('cal-sync:<id>')) ritentato fino
 * al deadline (default 30 s). Rientrante per la stessa collezione nello stesso
 * flusso asincrono; vietato annidare collezioni diverse (stallo del pool,
 * contratto §1.3). Lancia CollectionLockTimeoutError o IndexAbortedError.
 */
export async function withCollectionWriteLock<T>(
  calendarId: string,
  fn: (lock: CollectionLock) => Promise<T>,
  opts: { deadline?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const id = calendarId.toLowerCase();
  const held = heldLock.getStore();
  if (held && !held.closed) {
    if (held.calendarId === id) return fn(held);
    throw new Error(`withCollectionWriteLock: lock di ${id} richiesto mentre si tiene quello di ${held.calendarId} (vietato, contratto f2-modules §1.3)`);
  }
  const deadline = opts.deadline ?? Date.now() + DEFAULT_LOCK_WAIT_MS;
  const signal = opts.signal;
  const release = await writerSemaphore.acquire(
    deadline,
    signal,
    () => new CollectionLockTimeoutError(id, 'semaphore'),
    () => new IndexAbortedError(id),
  );
  let conn: ReservedSql | null = null;
  try {
    conn = await reserveConnection(id, deadline);
    const key = CAL_LOCKS.collection(id);
    let wait = 20;
    for (;;) {
      if (signal?.aborted) throw new IndexAbortedError(id);
      const [row] = await conn<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${key})) AS ok`;
      if (row?.ok) break;
      if (Date.now() + wait > deadline) throw new CollectionLockTimeoutError(id, 'advisory');
      await sleep(wait);
      wait = Math.min(wait * 2, 250);
    }
    const lock = new CollectionLockImpl(id, conn);
    try {
      return await heldLock.run(lock, () => fn(lock));
    } finally {
      lock.closed = true;
      try {
        await conn`SELECT pg_advisory_unlock(hashtext(${key}))`;
      } catch (err) {
        // Connessione rotta: il server rilascia il lock alla chiusura della sessione.
        log.warn({ err, calendarId: id }, 'pg_advisory_unlock della collezione non riuscito');
      }
    }
  } finally {
    conn?.release();
    release();
  }
}

// ─── Apply ───────────────────────────────

export interface ApplyOptions {
  /** CAS (design §6.2 passo 8): undefined = nessun CAS. */
  expectedSyncToken?: string | null;
  /** undefined = invariato. */
  newSyncToken?: string | null;
  /** Già filtrata dalla finestra racy; undefined = invariata. */
  dirMtimeNs?: bigint | null;
  /** Interruttore anti-cancellazione scattato: le cancellazioni restano sospese. null/undefined = nessuna nuova sospensione. */
  hold?: { reason: string; pendingDeletions: string[] } | null;
  /** Rebuild: tutte le risorse del change set si riscrivono (niente scorciatoia "invariato"), nella stessa tx. */
  replaceAll?: boolean;
  syncedAt: Date;
  /**
   * Istante della stat di dir_mtime_ns (prima del REPORT). dirty_since si
   * azzera solo se il primo cambio segnato non è successivo: una modifica
   * osservata dopo la stat (quindi forse dopo il REPORT) resta pendente.
   * Default syncedAt.
   */
  observedAt?: Date;
}

export interface ApplyResult {
  /** int8 come stringa. */
  indexVersion: string;
  upserted: number;
  unchanged: number;
  deleted: number;
  quarantined: number;
  held: boolean;
  /** href → cal_objects.id per tutte le risorse del change set (invariate comprese). */
  objectIds: ReadonlyMap<string, string>;
}

/** Opzioni interne: rimaterializzazione e operazioni puntuali non sono una sync. */
interface InternalApplyOptions {
  /** 'sync': aggiorna last_synced_at, azzera i fallimenti e porta la salute a healthy; 'none': solo righe e contatori. */
  bookkeeping: 'sync' | 'none';
  /** L'orizzonte del change set copre ora tutte le risorse (rimaterializzazione completa). */
  forceHorizon?: boolean;
}

interface ExistingObject {
  id: string;
  href: string;
  etag: string | null;
  content_sha256: string | null;
  semantic_fp: string | null;
  raw_ics: string | null;
  health: ObjectHealth;
  health_reason: string | null;
  health_since: Date | null;
  last_good_version_id: string | null;
  range_start: Date | null;
  range_end: Date | null;
  is_recurring: boolean;
  materialized_until: Date | null;
  first_seen_at: Date;
  has_occ: boolean;
  has_stale: boolean;
}

interface StateRow {
  sync_token: string | null;
  health: string;
  hold_since: Date | null;
  hold_reason: string | null;
  pending_deletions: string[];
  horizon_start: Date | null;
  horizon_end: Date | null;
  last_synced_at: Date | null;
}

interface LastGoodEntry {
  objectId: string;
  versionId: string;
  materialization: PreparedMaterialization;
}

/** Decisione finale per una risorsa scritta. */
interface WriteRow {
  item: PreparedItem;
  objectId: string;
  componentIds: ReadonlyMap<string, string>;
  existing: ExistingObject | undefined;
  health: 'ok' | 'quarantined';
  healthReason: string | null;
  raw: string | null;
  sha256: string | null;
  etag: string | null;
  semanticFp: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  isRecurring: boolean;
  materializedUntil: string | null;
  /** replace: componenti e occorrenze nuovi; keep: si tengono quelli dell'indice (marcati stale). */
  occMode: 'replace' | 'keep';
  components: PreparedComponent[];
  occurrences: PreparedOccurrence[];
  stale: boolean;
  /** Chiavi degli override da tenere attive in cal_object_ids; null = non ritirare nulla. */
  keepOverrideKeys: string[] | null;
  lastGoodVersionId: string | null;
  contentChanged: boolean;
}

const HREF_FORBIDDEN_RE = /[/\\\u0001-\u001f\u007f]/;

/** Stesso CHECK di cal_object_ids.href. */
function isStorableHref(href: string): boolean {
  return typeof href === 'string' && href.length > 0 && Buffer.byteLength(href, 'utf8') <= 1024 && !HREF_FORBIDDEN_RE.test(href);
}

const HEALTH_REASON_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Righe per istruzione nelle INSERT con unnest (limite pratico per i parametri array). */
const INSERT_CHUNK = 5_000;

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const bool = (b: boolean): string => (b ? 'true' : 'false');

/**
 * Applica un change set preparato: la SOLA scrittura di cal_objects,
 * cal_components e cal_occurrences, in una transazione sulla connessione del
 * lock della collezione. Vedi la testa del file per le regole. Lancia
 * CollectionCasError se il sync-token non è quello atteso.
 */
export async function applyPreparedChanges(lock: CollectionLock, prepared: PreparedChangeSet, opts: ApplyOptions): Promise<ApplyResult> {
  return applyInternal(lock, prepared, opts, { bookkeeping: 'sync' });
}

async function applyInternal(lock: CollectionLock, prepared: PreparedChangeSet, opts: ApplyOptions, internal: InternalApplyOptions): Promise<ApplyResult> {
  const context = prepared.input.context;
  if (lock.calendarId !== context.calendarId.toLowerCase()) {
    throw new Error(`applyPreparedChanges: lock di ${lock.calendarId} usato per la collezione ${context.calendarId}`);
  }
  const lastGood = await prefetchLastGood(lock, prepared);
  const alerts: Array<() => void> = [];
  const result = await lock.transaction((tx) => applyInTx(tx, prepared, opts, internal, lastGood, alerts));
  for (const emit of alerts) emit();
  if (result.upserted + result.deleted >= BULK_ANALYZE_MIN_CHANGES) scheduleIndexAnalyze();
  return result;
}

// ─── Statistiche dopo le scritture in blocco ───────────────────────────────

/** Oggetti scritti o tolti in un solo change set oltre i quali si aggiornano le statistiche (import, rebuild). */
export const BULK_ANALYZE_MIN_CHANGES = 500;
/** Intervallo minimo fra due ANALYZE dell'indice nello stesso processo. */
const BULK_ANALYZE_INTERVAL_MS = 30_000;
/** Tabelle dell'indice lette dalle decisioni e dalle viste. */
const INDEX_TABLES = ['cal_object_ids', 'cal_objects', 'cal_components', 'cal_occurrences'] as const;

const analyzeState: {
  running: Promise<void> | null;
  lastAt: number;
  pending: boolean;
  disabled: boolean;
  /** Attesa dell'intervallo minimo in corso (annullabile dall'arresto). */
  timer: NodeJS.Timeout | null;
  wake: (() => void) | null;
  stopped: boolean;
} = { running: null, lastAt: 0, pending: false, disabled: false, timer: null, wake: null, stopped: false };

/**
 * Aggiorna le statistiche delle tabelle dell'indice dopo un change set in
 * blocco (prima indicizzazione di una collezione grande, import, rebuild),
 * fuori dalla transazione e senza attenderlo. Senza, fino al giro
 * dell'autovacuum (autovacuum_naptime, 1 minuto di default) il planner usa
 * le statistiche di una tabella quasi vuota e può scegliere piani che
 * scandiscono un'intera tabella per ogni riga (decisioni e /slots da
 * millisecondi a secondi). ANALYZE prende SHARE UPDATE EXCLUSIVE: non blocca
 * letture né scritture. Al più uno alla volta, non più di uno ogni 30 s (una
 * richiesta nel frattempo ne programma uno alla fine dell'intervallo); un
 * errore di permessi lo spegne per il processo (lo farà l'autovacuum).
 */
export function scheduleIndexAnalyze(): void {
  if (analyzeState.disabled || analyzeState.stopped) return;
  if (analyzeState.running) {
    analyzeState.pending = true;
    return;
  }
  const wait = Math.max(0, analyzeState.lastAt + BULK_ANALYZE_INTERVAL_MS - Date.now());
  analyzeState.running = (async () => {
    if (wait > 0) {
      await new Promise<void>((resolve) => {
        analyzeState.wake = resolve;
        analyzeState.timer = setTimeout(resolve, wait);
        // L'attesa non tiene vivo il processo (arresto, fine dei test).
        analyzeState.timer.unref();
      });
      analyzeState.timer = null;
      analyzeState.wake = null;
    }
    analyzeState.pending = false;
    if (analyzeState.stopped) {
      analyzeState.running = null;
      return;
    }
    const started = Date.now();
    try {
      await calSql.unsafe(`ANALYZE ${INDEX_TABLES.join(', ')}`);
      log.info({ durationMs: Date.now() - started }, 'statistiche dell\'indice aggiornate dopo una scrittura in blocco');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '42501') {
        analyzeState.disabled = true;
        log.warn({ err }, 'ANALYZE dell\'indice non permesso all\'utente del database: resta all\'autovacuum');
      } else {
        log.warn({ err }, 'ANALYZE dell\'indice non riuscito');
      }
    } finally {
      analyzeState.lastAt = Date.now();
      analyzeState.running = null;
      if (analyzeState.pending) scheduleIndexAnalyze();
    }
  })();
}

/** Attende l'ANALYZE dell'indice in corso o programmato (test). */
export async function waitForIndexAnalyze(): Promise<void> {
  while (analyzeState.running) await analyzeState.running;
}

/** Arresto: annulla l'ANALYZE in attesa dell'intervallo e attende quello in corso. */
async function stopIndexAnalyze(): Promise<void> {
  analyzeState.stopped = true;
  analyzeState.pending = false;
  if (analyzeState.timer) clearTimeout(analyzeState.timer);
  analyzeState.wake?.();
  await waitForIndexAnalyze();
  analyzeState.stopped = false;
}

/**
 * Per le risorse in quarantena per testo non valido: espande l'ultima
 * versione valida (fuori dalla transazione, sotto il lock) per rigenerarne le
 * occorrenze stale nell'orizzonte del change set.
 */
async function prefetchLastGood(lock: CollectionLock, prepared: PreparedChangeSet): Promise<Map<string, LastGoodEntry>> {
  const out = new Map<string, LastGoodEntry>();
  const context = prepared.input.context;
  if (!context.versions) return out;
  const hrefs = prepared.items.filter((i) => i.health === 'quarantined' && i.preferLastGood && isStorableHref(i.href)).map((i) => i.href);
  if (hrefs.length === 0) return out;
  const conn = lock.conn as unknown as Db;
  const ids = await conn<Array<{ href: string; id: string }>>`
    SELECT href, id FROM cal_object_ids
    WHERE calendar_id = ${context.calendarId} AND recurrence_key = '' AND href = ANY(${hrefs}::text[])
  `;
  if (ids.length === 0) return out;
  const versions = await lastValidVersions(conn, ids.map((r) => r.id));
  const pc = prepareContextOf(prepared.input);
  for (const { href, id } of ids) {
    const v = versions.get(id);
    if (!v?.raw_ics) continue;
    const materialization = prepareLastGood(href, v.raw_ics, pc);
    if (materialization) out.set(href, { objectId: id, versionId: v.id, materialization });
  }
  return out;
}

async function applyInTx(
  tx: Db,
  prepared: PreparedChangeSet,
  opts: ApplyOptions,
  internal: InternalApplyOptions,
  lastGood: Map<string, LastGoodEntry>,
  alerts: Array<() => void>,
): Promise<ApplyResult> {
  const input = prepared.input;
  const context = input.context;
  const calendarId = context.calendarId;
  const remote = context.originStore === 'remote';
  const now = new Date();
  const replaceAll = opts.replaceAll === true;

  await ensureCollectionState(tx, calendarId, context.originStore);
  const [state] = await tx<StateRow[]>`
    SELECT sync_token, health, hold_since, hold_reason, pending_deletions, horizon_start, horizon_end, last_synced_at
    FROM cal_collection_state
    WHERE calendar_id = ${calendarId}
    FOR UPDATE
  `;
  if (!state) throw new CollectionNotFoundError(calendarId);
  if (opts.expectedSyncToken !== undefined && (state.sync_token ?? null) !== (opts.expectedSyncToken ?? null)) {
    throw new CollectionCasError(calendarId, opts.expectedSyncToken ?? null, state.sync_token ?? null);
  }

  // Risorse con href non memorizzabile: mai indicizzabili (CHECK di cal_object_ids).
  const items: PreparedItem[] = [];
  const seen = new Set<string>();
  for (const item of prepared.items) {
    if (!isStorableHref(item.href)) {
      alerts.push(() => raiseIndexAlert('object-unreadable', 'Risorsa con href non indicizzabile', { calendarId, key: item.href.slice(0, 100) }));
      continue;
    }
    if (seen.has(item.href)) continue; // un href ripetuto nel change set: vale il primo
    seen.add(item.href);
    items.push(item);
  }
  const deletes = [...new Set(input.deletes.filter((h) => isStorableHref(h) && !seen.has(h)))];
  const pending404 = [...new Set(input.pending404.filter((h) => isStorableHref(h) && !seen.has(h) && !deletes.includes(h)))];

  const allHrefs = [...seen, ...deletes, ...pending404];
  const existingRows = allHrefs.length === 0 ? [] : await tx<ExistingObject[]>`
    SELECT o.id, o.href, o.etag, o.content_sha256, o.semantic_fp, o.raw_ics, o.health, o.health_reason, o.health_since,
           o.last_good_version_id, o.range_start, o.range_end, o.is_recurring, o.materialized_until, o.first_seen_at,
           EXISTS (SELECT 1 FROM cal_occurrences x WHERE x.object_id = o.id) AS has_occ,
           EXISTS (SELECT 1 FROM cal_occurrences x WHERE x.object_id = o.id AND x.stale) AS has_stale
    FROM cal_objects o
    WHERE o.calendar_id = ${calendarId} AND o.href = ANY(${allHrefs}::text[])
  `;
  const existing = new Map(existingRows.map((r) => [r.href, r]));

  // Invariati: stesso etag e stesso testo (Radicale) o stesso fingerprint (iscrizioni).
  const changed: PreparedItem[] = [];
  const objectIds = new Map<string, string>();
  let unchanged = 0;
  for (const item of items) {
    const ex = existing.get(item.href);
    if (!replaceAll && ex && isUnchanged(item, ex, remote)) {
      unchanged++;
      objectIds.set(item.href, ex.id);
      continue;
    }
    changed.push(item);
  }

  // Id persistenti (anche delle chiavi dell'ultima versione buona, che diventano componenti).
  const allocations = changed.length === 0 ? new Map() : await allocateObjectIds(
    tx,
    calendarId,
    changed.map((item) => {
      const lg = lastGood.get(item.href);
      const keys = new Set(item.overrideKeys);
      if (item.health === 'quarantined') {
        for (const c of lg?.materialization.components ?? []) if (c.recurrenceKey !== '') keys.add(c.recurrenceKey);
      }
      return { href: item.href, uid: item.uid, overrideKeys: [...keys], legacyId: item.legacyId };
    }),
    { now, idStrategy: input.idStrategy },
  );

  const versionsLatest = context.versions
    ? await latestVersions(tx, changed.map((i) => allocations.get(i.href)?.objectId).filter((id): id is string => !!id))
    : new Map();

  // Decisioni per risorsa.
  const writes: WriteRow[] = [];
  let quarantinedNow = 0;
  for (const item of changed) {
    const alloc = allocations.get(item.href);
    if (!alloc) continue;
    const ex = existing.get(item.href);
    const latest = versionsLatest.get(alloc.objectId);
    const raw = item.raw ?? (item.origin === 'radicale-skip' ? ex?.raw_ics ?? null : null);
    const sha256 = item.raw !== null ? item.sha256 : (item.origin === 'radicale-skip' ? ex?.content_sha256 ?? null : null);
    const etag = remote ? null : item.origin === 'radicale-skip' ? null : item.etag;
    const contentChanged = !ex || ex.content_sha256 !== sha256;
    const write: WriteRow = {
      item,
      objectId: alloc.objectId,
      componentIds: alloc.componentIds,
      existing: ex,
      health: item.health,
      healthReason: item.healthReason,
      raw,
      sha256,
      etag,
      semanticFp: item.health === 'ok' || !item.preferLastGood ? item.semanticFp : null,
      rangeStart: item.rangeStart,
      rangeEnd: item.rangeEnd,
      isRecurring: item.isRecurring,
      materializedUntil: item.materializedUntil,
      occMode: 'replace',
      components: item.components,
      occurrences: item.occurrences,
      stale: false,
      keepOverrideKeys: item.health === 'ok' ? item.overrideKeys : null,
      lastGoodVersionId: null,
      contentChanged,
    };

    // Versione (non per le iscrizioni): solo se il testo è nuovo rispetto all'ultima versione.
    let newVersionId: string | null = null;
    if (context.versions && raw !== null && sha256 !== null && item.raw !== null) {
      if (needsNewVersion(latest, { sha256, semanticFp: item.health === 'ok' ? item.semanticFp : null, valid: item.valid })) {
        newVersionId = await recordVersion(tx, {
          objectId: alloc.objectId,
          calendarId,
          href: item.href,
          etag,
          raw,
          sha256,
          semanticFp: item.health === 'ok' ? item.semanticFp : null,
          changeKind: !ex && (!latest || latest.changeKind === 'delete') ? 'create' : 'update',
          valid: item.valid,
          actor: input.actor,
        });
      }
    }

    if (item.health === 'ok') {
      // Senza versione nuova l'ultima è semanticamente uguale (o identica): resta l'ultima buona.
      write.lastGoodVersionId = context.versions ? (newVersionId ?? (latest && latest.valid && latest.changeKind !== 'delete' ? latest.id : null)) : null;
    } else {
      quarantinedNow++;
      const lg = lastGood.get(item.href);
      const exGood = ex && ex.has_occ && (ex.health === 'ok' || ex.health === 'pending_404' || ex.has_stale);
      write.lastGoodVersionId = ex?.last_good_version_id ?? null;
      if (item.preferLastGood && lg && lg.objectId === alloc.objectId) {
        // Occorrenze dell'ultima versione buona, rigenerate nell'orizzonte corrente.
        write.components = lg.materialization.components;
        write.occurrences = lg.materialization.occurrences;
        write.rangeStart = lg.materialization.rangeStart;
        write.rangeEnd = lg.materialization.rangeEnd;
        write.isRecurring = lg.materialization.isRecurring;
        write.materializedUntil = lg.materialization.materializedUntil;
        write.stale = true;
        write.lastGoodVersionId = lg.versionId;
      } else if (item.preferLastGood && ex && exGood) {
        // Nessuna versione (iscrizioni) o non rileggibile: restano le occorrenze già indicizzate.
        write.occMode = 'keep';
        write.components = [];
        write.occurrences = [];
        write.stale = true;
        write.rangeStart = ex.range_start?.toISOString() ?? null;
        write.rangeEnd = ex.range_end?.toISOString() ?? null;
        write.isRecurring = ex.is_recurring;
        write.materializedUntil = ex.materialized_until?.toISOString() ?? null;
      }
      if (write.occMode === 'replace' && write.occurrences.length === 0 && write.rangeStart === null) {
        // Nessun intervallo estraibile: escluso dal busy (rischio residuo dichiarato, design §6.5).
        write.healthReason = HEALTH_REASONS.unreadable;
      }
      if (write.healthReason && !HEALTH_REASON_RE.test(write.healthReason)) write.healthReason = HEALTH_REASONS.parseError;
      const wasSame = ex && ex.health === 'quarantined' && ex.health_reason === write.healthReason;
      if (!wasSame) {
        const reason = write.healthReason ?? 'parse-error';
        const code = reason === HEALTH_REASONS.radicaleSkip ? 'radicale-skip' : reason === HEALTH_REASONS.unreadable ? 'object-unreadable' : 'object-quarantined';
        alerts.push(() => raiseIndexAlert(code, `Oggetto in quarantena (${reason}) nella collezione ${context.collectionName}`, {
          calendarId,
          href: item.href,
          reason,
          lastGood: write.stale,
        }));
      }
    }
    if (item.health === 'ok' && item.warnings.includes('ORPHAN_OVERRIDE')) {
      alerts.push(() => raiseIndexAlert('orphan-override', `Override fuori dalla serie (occorrenza autonoma) nella collezione ${context.collectionName}`, { calendarId, href: item.href }));
    }
    if (item.health === 'ok' && ex && ex.health === 'quarantined') {
      log.info({ calendarId, href: item.href, reason: ex.health_reason }, 'oggetto uscito dalla quarantena');
    }
    objectIds.set(item.href, alloc.objectId);
    writes.push(write);
  }

  await writeObjects(tx, calendarId, context, writes, now);

  // Remote mode: primo 404 → pending_404, l'oggetto resta e continua a bloccare.
  const pendingHrefs = pending404.filter((h) => existing.has(h));
  if (pendingHrefs.length > 0) {
    await tx`
      UPDATE cal_objects
      SET health = 'pending_404',
          health_reason = NULL,
          health_since = CASE WHEN health = 'pending_404' THEN health_since ELSE ${now} END,
          pending_404_count = LEAST(pending_404_count + 1, 32767)
      WHERE calendar_id = ${calendarId} AND href = ANY(${pendingHrefs}::text[])
    `;
    for (const h of pendingHrefs) objectIds.set(h, (existing.get(h) as ExistingObject).id);
  }

  // Cancellazioni confermate: versione con l'ultimo testo, righe, id ritirati.
  const deleteHrefs = deletes.filter((h) => existing.has(h));
  if (deleteHrefs.length > 0) {
    if (context.versions) {
      const deleteActors = deleteHrefs.map((h) => input.deleteActors?.[h] ?? input.actor);
      await tx`
        INSERT INTO cal_object_versions (object_id, calendar_id, href, etag, raw_ics, content_sha256, semantic_fp, change_kind, valid, actor)
        SELECT o.id, o.calendar_id, o.href, o.etag, o.raw_ics, o.content_sha256, o.semantic_fp, 'delete', false, d.actor
        FROM cal_objects o
        JOIN unnest(${deleteHrefs}::text[], ${deleteActors}::text[]) AS d(href, actor) ON d.href = o.href
        WHERE o.calendar_id = ${calendarId}
      `;
    }
    await tx`DELETE FROM cal_objects WHERE calendar_id = ${calendarId} AND href = ANY(${deleteHrefs}::text[])`;
  }
  if (deletes.length > 0) await retireObjectIds(tx, calendarId, deletes, now);

  // Interruttore anti-cancellazione: le cancellazioni sospese restano finché l'admin non sceglie.
  // Una sospesa "ricompare" solo se una sync l'ha vista su Radicale: la
  // rimaterializzazione e la quarantena forzata riscrivono le righe dal testo
  // dell'indice (comprese le sospese), quindi non dicono nulla su Radicale e
  // l'hold resta com'è (motivo, inizio, elenco).
  const sync = internal.bookkeeping === 'sync';
  const reappeared = new Set(sync ? [...seen, ...deletes] : deletes);
  const candidatePending = [...new Set([...(state.pending_deletions ?? []), ...(opts.hold?.pendingDeletions ?? [])])].filter((h) => !reappeared.has(h));
  const stillPending = candidatePending.length === 0 ? [] : (await tx<Array<{ href: string }>>`
    SELECT href FROM cal_objects WHERE calendar_id = ${calendarId} AND href = ANY(${candidatePending}::text[]) ORDER BY href
  `).map((r) => r.href);
  const holdActive = Boolean(opts.hold) || (state.health === 'hold' && stillPending.length > 0);
  const holdReason = holdActive ? (opts.hold?.reason ?? state.hold_reason ?? 'mass-delete') : null;
  const holdSince = holdActive ? (state.hold_since ?? now) : null;
  if (opts.hold && state.health !== 'hold') {
    alerts.push(() => raiseIndexAlert('collection-hold', `Cancellazioni di massa sospese nella collezione ${context.collectionName}`, {
      calendarId,
      reason: holdReason,
      pending: stillPending.length,
    }));
  }

  // Orizzonte materializzato: quello garantito per TUTTE le risorse della collezione.
  let horizonStart = state.horizon_start;
  let horizonEnd = state.horizon_end;
  const initial = opts.expectedSyncToken === null;
  if (internal.forceHorizon || replaceAll || (!horizonStart && (input.full || initial))) {
    horizonStart = input.horizon.start;
    horizonEnd = input.horizon.end;
  } else if (horizonStart && horizonEnd && writes.length > 0) {
    const s = new Date(Math.max(horizonStart.getTime(), input.horizon.start.getTime()));
    const e = new Date(Math.min(horizonEnd.getTime(), input.horizon.end.getTime()));
    if (s.getTime() < e.getTime()) {
      horizonStart = s;
      horizonEnd = e;
    } else {
      log.warn({ calendarId, state: [horizonStart, horizonEnd], input: input.horizon }, 'orizzonte del change set disgiunto da quello della collezione: invariato');
    }
  }

  const anyChange = writes.length > 0 || deleteHrefs.length > 0;
  // Una sync è completa se elenca tutta la collezione (full) o parte da un token
  // nullo (REPORT sync-collection iniziale: restituisce tutti i membri); una
  // incrementale su una collezione mai sincronizzata lascia 'stale'.
  const complete = input.full || initial || state.last_synced_at !== null;
  const nextHealth = holdActive ? 'hold' : sync ? (complete ? 'healthy' : 'stale') : state.health === 'hold' ? 'healthy' : state.health;
  const setToken = sync && !remote && opts.newSyncToken !== undefined;
  const setMtime = sync && !remote && opts.dirMtimeNs !== undefined;
  const mtimeText = opts.dirMtimeNs === undefined || opts.dirMtimeNs === null ? null : opts.dirMtimeNs.toString();
  const clearDirty = setMtime && mtimeText !== null;
  const [updated] = await tx<Array<{ index_version: string }>>`
    UPDATE cal_collection_state SET
      sync_token = CASE WHEN ${setToken} THEN ${opts.newSyncToken ?? null}::text ELSE sync_token END,
      dir_mtime_ns = CASE WHEN ${setMtime} THEN ${mtimeText}::bigint ELSE dir_mtime_ns END,
      last_synced_at = CASE WHEN ${sync} THEN ${opts.syncedAt} ELSE last_synced_at END,
      last_full_sync_at = CASE WHEN ${sync && input.full} THEN ${opts.syncedAt} ELSE last_full_sync_at END,
      last_attempt_at = CASE WHEN ${sync} THEN ${opts.syncedAt} ELSE last_attempt_at END,
      consecutive_failures = CASE WHEN ${sync} THEN 0 ELSE consecutive_failures END,
      last_error = CASE WHEN ${sync} THEN NULL ELSE last_error END,
      health_since = CASE WHEN health IS DISTINCT FROM ${nextHealth} THEN ${now} ELSE health_since END,
      health = ${nextHealth},
      dirty_since = CASE WHEN ${clearDirty} AND (dirty_since IS NULL OR dirty_since <= ${opts.observedAt ?? opts.syncedAt}) THEN NULL ELSE dirty_since END,
      pending_deletions = ${stillPending}::text[],
      hold_reason = ${holdReason},
      hold_since = ${holdSince},
      object_count = (SELECT count(*) FROM cal_objects WHERE calendar_id = ${calendarId})::int,
      quarantined_count = (SELECT count(*) FROM cal_objects WHERE calendar_id = ${calendarId} AND health = 'quarantined')::int,
      index_version = index_version + CASE WHEN ${anyChange} THEN 1 ELSE 0 END,
      horizon_start = ${horizonStart},
      horizon_end = ${horizonEnd}
    WHERE calendar_id = ${calendarId}
    RETURNING index_version::text AS index_version
  `;

  return {
    indexVersion: updated?.index_version ?? '0',
    upserted: writes.length,
    unchanged,
    deleted: deleteHrefs.length,
    quarantined: quarantinedNow,
    held: holdActive,
    objectIds,
  };
}

/**
 * True se la risorsa non è cambiata rispetto all'indice: nessuna scrittura.
 * Radicale: stesso etag e stesso testo. Iscrizioni (contratto §2.7): stesso
 * fingerprint semantico, così un feed che rigenera DTSTAMP a ogni download non
 * produce scritture; per un oggetto in quarantena (semantic_fp NULL per
 * contratto, §2.5) a parità di motivo vale lo stesso testo o lo stesso
 * fingerprint del testo già indicizzato, altrimenti l'oggetto rotto verrebbe
 * riscritto (e index_version incrementata) a ogni pull.
 */
function isUnchanged(item: PreparedItem, ex: ExistingObject, remote: boolean): boolean {
  if (ex.health === 'pending_404') return false;
  if (item.origin === 'radicale-skip') {
    return ex.health === 'quarantined' && ex.health_reason === item.healthReason && (item.raw === null || ex.content_sha256 === item.sha256);
  }
  if (remote) {
    if (item.health === 'ok' && ex.health === 'ok') {
      if (item.semanticFp && ex.semantic_fp) return item.semanticFp === ex.semantic_fp;
      return item.sha256 !== null && ex.content_sha256 === item.sha256;
    }
    if (item.health === 'quarantined' && ex.health === 'quarantined' && ex.health_reason === item.healthReason) {
      if (item.sha256 !== null && ex.content_sha256 === item.sha256) return true;
      return item.semanticFp !== null && ex.raw_ics !== null && semanticFingerprintOfRaw(ex.raw_ics) === item.semanticFp;
    }
    return false;
  }
  return ex.etag === item.etag && item.sha256 !== null && ex.content_sha256 === item.sha256;
}

/** Scrive oggetti, componenti, occorrenze e id ritirati delle risorse decise, a lotti. */
async function writeObjects(tx: Db, calendarId: string, context: CollectionContext, writes: readonly WriteRow[], now: Date): Promise<void> {
  if (writes.length === 0) return;

  // Riga dell'oggetto con un id diverso (non dovrebbe accadere: ids.ts restituisce quello esistente).
  const mismatched = writes.filter((w) => w.existing && w.existing.id !== w.objectId).map((w) => w.item.href);
  if (mismatched.length > 0) {
    log.warn({ calendarId, count: mismatched.length }, 'id della risorsa cambiato: righe dell\'indice ricreate');
    await tx`DELETE FROM cal_objects WHERE calendar_id = ${calendarId} AND href = ANY(${mismatched}::text[])`;
  }
  // Stesso id in un'altra posizione (stato incoerente lasciato da un'interruzione): la riga vecchia si toglie.
  const ids = writes.map((w) => w.objectId);
  const stray = await tx<Array<{ id: string; calendar_id: string; href: string }>>`
    SELECT o.id, o.calendar_id, o.href FROM cal_objects o
    JOIN unnest(${ids}::uuid[], ${writes.map((w) => w.item.href)}::text[]) AS v(id, href) ON v.id = o.id
    WHERE o.calendar_id <> ${calendarId} OR o.href <> v.href
  `;
  if (stray.length > 0) {
    log.warn({ calendarId, stray: stray.map((s) => ({ calendarId: s.calendar_id, href: s.href })) }, 'righe dell\'indice con lo stesso id in un\'altra posizione: rimosse');
    await tx`DELETE FROM cal_objects WHERE id = ANY(${stray.map((s) => s.id)}::uuid[])`;
    // Le altre collezioni toccate cambiano contenuto: contatori e index_version (cache del feed, NOTIFY).
    const others = [...new Set(stray.map((s) => s.calendar_id))].filter((c) => c !== calendarId);
    if (others.length > 0) {
      await tx`
        UPDATE cal_collection_state st SET
          object_count = (SELECT count(*) FROM cal_objects o WHERE o.calendar_id = st.calendar_id)::int,
          quarantined_count = (SELECT count(*) FROM cal_objects o WHERE o.calendar_id = st.calendar_id AND o.health = 'quarantined')::int,
          index_version = st.index_version + 1
        WHERE st.calendar_id = ANY(${others}::uuid[])
      `;
    }
  }

  // Oggetti (upsert in blocco).
  for (const part of chunks(writes, INSERT_CHUNK)) {
    await tx`
      INSERT INTO cal_objects (
        id, calendar_id, href, uid, etag, component, raw_ics, content_sha256, semantic_fp, origin_store,
        range_start, range_end, is_recurring, materialized_until, health, health_reason, health_since,
        pending_404_count, last_good_version_id, source, source_id, x_source, x_source_id, size_bytes,
        first_seen_at, changed_at
      )
      SELECT v.id::uuid, ${calendarId}::uuid, v.href, v.uid, v.etag, v.component, v.raw, v.sha, v.fp, ${context.originStore},
             v.rs::timestamptz, v.re::timestamptz, v.rec::boolean, v.mu::timestamptz, v.health, v.reason,
             CASE WHEN v.health = 'ok' THEN NULL ELSE COALESCE(v.since::timestamptz, ${now}::timestamptz) END,
             0, v.lg::uuid, v.source, v.source_id, v.xs, v.xsid, v.size::int,
             COALESCE(v.first::timestamptz, ${now}::timestamptz), ${now}::timestamptz
      FROM unnest(
        ${part.map((w) => w.objectId)}::text[],
        ${part.map((w) => w.item.href)}::text[],
        ${part.map((w) => w.item.uid)}::text[],
        ${part.map((w) => w.etag)}::text[],
        ${part.map((w) => w.item.component)}::text[],
        ${part.map((w) => w.raw)}::text[],
        ${part.map((w) => w.sha256)}::text[],
        ${part.map((w) => w.semanticFp)}::text[],
        ${part.map((w) => w.rangeStart)}::text[],
        ${part.map((w) => w.rangeEnd)}::text[],
        ${part.map((w) => bool(w.isRecurring))}::text[],
        ${part.map((w) => w.materializedUntil)}::text[],
        ${part.map((w) => w.health)}::text[],
        ${part.map((w) => (w.health === 'ok' ? null : w.healthReason))}::text[],
        ${part.map((w) => (w.existing?.health === 'quarantined' && w.health === 'quarantined' ? w.existing.health_since?.toISOString() ?? null : null))}::text[],
        ${part.map((w) => w.lastGoodVersionId)}::text[],
        ${part.map((w) => w.item.source)}::text[],
        ${part.map((w) => w.item.sourceId)}::text[],
        ${part.map((w) => w.item.xSource)}::text[],
        ${part.map((w) => w.item.xSourceId)}::text[],
        ${part.map((w) => (w.item.sizeBytes === null ? null : String(w.item.sizeBytes)))}::text[],
        ${part.map((w) => w.existing?.first_seen_at.toISOString() ?? null)}::text[]
      ) AS v(id, href, uid, etag, component, raw, sha, fp, rs, re, rec, mu, health, reason, since, lg, source, source_id, xs, xsid, size, first)
      ON CONFLICT (calendar_id, href) DO UPDATE SET
        uid = EXCLUDED.uid,
        etag = EXCLUDED.etag,
        component = EXCLUDED.component,
        raw_ics = EXCLUDED.raw_ics,
        content_sha256 = EXCLUDED.content_sha256,
        semantic_fp = EXCLUDED.semantic_fp,
        origin_store = EXCLUDED.origin_store,
        range_start = EXCLUDED.range_start,
        range_end = EXCLUDED.range_end,
        is_recurring = EXCLUDED.is_recurring,
        materialized_until = EXCLUDED.materialized_until,
        health = EXCLUDED.health,
        health_reason = EXCLUDED.health_reason,
        health_since = EXCLUDED.health_since,
        pending_404_count = 0,
        last_good_version_id = EXCLUDED.last_good_version_id,
        source = EXCLUDED.source,
        source_id = EXCLUDED.source_id,
        x_source = EXCLUDED.x_source,
        x_source_id = EXCLUDED.x_source_id,
        size_bytes = EXCLUDED.size_bytes,
        changed_at = CASE WHEN cal_objects.content_sha256 IS DISTINCT FROM EXCLUDED.content_sha256
                          THEN EXCLUDED.changed_at ELSE cal_objects.changed_at END
    `;
  }

  // Occorrenze tenute (quarantena senza versione rileggibile): restano e si marcano stale.
  const kept = writes.filter((w) => w.occMode === 'keep').map((w) => w.objectId);
  if (kept.length > 0) {
    await tx`UPDATE cal_occurrences SET stale = true WHERE object_id = ANY(${kept}::uuid[]) AND NOT stale`;
  }

  // Componenti e occorrenze sostituiti.
  const replaced = writes.filter((w) => w.occMode === 'replace');
  const replacedIds = replaced.map((w) => w.objectId);
  if (replacedIds.length > 0) {
    await tx`DELETE FROM cal_occurrences WHERE object_id = ANY(${replacedIds}::uuid[])`;
    await tx`DELETE FROM cal_components WHERE object_id = ANY(${replacedIds}::uuid[])`;
  }
  const componentRows: Array<{ id: string; objectId: string; c: PreparedComponent }> = [];
  const occurrenceRows: Array<{ objectId: string; componentId: string | null; o: PreparedOccurrence; stale: boolean }> = [];
  for (const w of replaced) {
    const savedKeys = new Set<string>();
    for (const c of w.components) {
      const id = w.componentIds.get(c.recurrenceKey);
      if (!id) continue; // chiave senza id (non dovrebbe accadere): componente non salvato
      componentRows.push({ id, objectId: w.objectId, c });
      savedKeys.add(c.recurrenceKey);
    }
    for (const o of w.occurrences) {
      const componentId = o.componentKey !== null && savedKeys.has(o.componentKey) ? (w.componentIds.get(o.componentKey) ?? null) : null;
      occurrenceRows.push({ objectId: w.objectId, componentId, o, stale: w.stale });
    }
  }
  for (const part of chunks(componentRows, INSERT_CHUNK)) {
    await tx`
      INSERT INTO cal_components (
        id, object_id, calendar_id, recurrence_key, component, uid, summary, description, location, url, status,
        transp, class, start_utc, end_utc, all_day, start_date, end_date, tzid, floating, rrule, rdates, exdates,
        recurrence_id_utc, orphan, sequence, dtstamp, created, last_modified, x_source, x_source_id, has_alarms, has_attendees
      )
      SELECT v.id::uuid, v.object_id::uuid, ${calendarId}::uuid, v.rk, v.component, v.uid, v.summary, v.description,
             v.location, v.url, v.status, v.transp, v.class, v.su::timestamptz, v.eu::timestamptz, v.ad::boolean,
             v.sd::date, v.ed::date, v.tzid, v.fl::boolean, v.rrule, v.rdates::jsonb, v.exdates::jsonb,
             v.rid::timestamptz, v.orphan::boolean, v.seq::int, v.dtstamp::timestamptz, v.created::timestamptz,
             v.lm::timestamptz, v.xs, v.xsid, v.alarms::boolean, v.att::boolean
      FROM unnest(
        ${part.map((r) => r.id)}::text[],
        ${part.map((r) => r.objectId)}::text[],
        ${part.map((r) => r.c.recurrenceKey)}::text[],
        ${part.map((r) => r.c.component)}::text[],
        ${part.map((r) => r.c.uid)}::text[],
        ${part.map((r) => r.c.summary)}::text[],
        ${part.map((r) => r.c.description)}::text[],
        ${part.map((r) => r.c.location)}::text[],
        ${part.map((r) => r.c.url)}::text[],
        ${part.map((r) => r.c.status)}::text[],
        ${part.map((r) => r.c.transp)}::text[],
        ${part.map((r) => r.c.class)}::text[],
        ${part.map((r) => r.c.startUtc)}::text[],
        ${part.map((r) => r.c.endUtc)}::text[],
        ${part.map((r) => bool(r.c.allDay))}::text[],
        ${part.map((r) => r.c.startDate)}::text[],
        ${part.map((r) => r.c.endDate)}::text[],
        ${part.map((r) => r.c.tzid)}::text[],
        ${part.map((r) => bool(r.c.floating))}::text[],
        ${part.map((r) => r.c.rrule)}::text[],
        ${part.map((r) => JSON.stringify(r.c.rdates))}::text[],
        ${part.map((r) => JSON.stringify(r.c.exdates))}::text[],
        ${part.map((r) => r.c.recurrenceIdUtc)}::text[],
        ${part.map((r) => bool(r.c.orphan))}::text[],
        ${part.map((r) => (r.c.sequence === null ? null : String(r.c.sequence)))}::text[],
        ${part.map((r) => r.c.dtstamp)}::text[],
        ${part.map((r) => r.c.created)}::text[],
        ${part.map((r) => r.c.lastModified)}::text[],
        ${part.map((r) => r.c.xSource)}::text[],
        ${part.map((r) => r.c.xSourceId)}::text[],
        ${part.map((r) => bool(r.c.hasAlarms))}::text[],
        ${part.map((r) => bool(r.c.hasAttendees))}::text[]
      ) AS v(id, object_id, rk, component, uid, summary, description, location, url, status, transp, class, su, eu, ad,
             sd, ed, tzid, fl, rrule, rdates, exdates, rid, orphan, seq, dtstamp, created, lm, xs, xsid, alarms, att)
    `;
  }
  for (const part of chunks(occurrenceRows, INSERT_CHUNK)) {
    await tx`
      INSERT INTO cal_occurrences (
        object_id, recurrence_key, component_id, calendar_id, start_utc, end_utc, start_date, end_date, all_day,
        status, transp, kind, blocks, stale
      )
      SELECT v.object_id::uuid, v.rk, v.component_id::uuid, ${calendarId}::uuid, v.su::timestamptz, v.eu::timestamptz,
             v.sd::date, v.ed::date, v.ad::boolean, v.status, v.transp, v.kind, v.blocks::boolean, v.stale::boolean
      FROM unnest(
        ${part.map((r) => r.objectId)}::text[],
        ${part.map((r) => r.o.recurrenceKey)}::text[],
        ${part.map((r) => r.componentId)}::text[],
        ${part.map((r) => r.o.startUtc)}::text[],
        ${part.map((r) => r.o.endUtc)}::text[],
        ${part.map((r) => r.o.startDate)}::text[],
        ${part.map((r) => r.o.endDate)}::text[],
        ${part.map((r) => bool(r.o.allDay))}::text[],
        ${part.map((r) => r.o.status)}::text[],
        ${part.map((r) => r.o.transp)}::text[],
        ${part.map((r) => r.o.kind)}::text[],
        ${part.map((r) => bool(r.o.blocks))}::text[],
        ${part.map((r) => bool(r.stale))}::text[]
      ) AS v(object_id, rk, component_id, su, eu, sd, ed, ad, status, transp, kind, blocks, stale)
    `;
  }

  // Override non più presenti: id ritirati (restano per il cestino e i ripristini).
  const retireFor = writes.filter((w) => w.keepOverrideKeys !== null);
  if (retireFor.length > 0) {
    const active = await tx<Array<{ id: string; href: string; recurrence_key: string }>>`
      SELECT id, href, recurrence_key FROM cal_object_ids
      WHERE calendar_id = ${calendarId} AND href = ANY(${retireFor.map((w) => w.item.href)}::text[])
        AND recurrence_key <> '' AND retired_at IS NULL
    `;
    const keep = new Map(retireFor.map((w) => [w.item.href, new Set(w.keepOverrideKeys ?? [])]));
    const retire = active.filter((r) => !keep.get(r.href)?.has(r.recurrence_key)).map((r) => r.id);
    if (retire.length > 0) {
      await tx`UPDATE cal_object_ids SET retired_at = ${now} WHERE id = ANY(${retire}::uuid[]) AND retired_at IS NULL`;
    }
  }
}

// ─── Comodità per SYNC, SUBS, STORE e i test ───────────────────────────────

/** prepare + lock + apply (comodità per SYNC, SUBS e i test). */
export async function applyCollectionChanges(input: ChangeSetInput, opts: ApplyOptions & { deadline?: number; signal?: AbortSignal }): Promise<ApplyResult> {
  const prepared = await prepareCollectionChanges(input);
  const { deadline, signal, ...applyOpts } = opts;
  return withCollectionWriteLock(input.context.calendarId, (lock) => applyPreparedChanges(lock, prepared, applyOpts), { deadline, signal });
}

/** Orizzonte corrente della collezione (o l'obiettivo, se non è mai stata materializzata). */
async function collectionHorizon(db: Db, calendarId: string): Promise<{ start: Date; end: Date }> {
  const [row] = await db<Array<{ horizon_start: Date | null; horizon_end: Date | null }>>`
    SELECT horizon_start, horizon_end FROM cal_collection_state WHERE calendar_id = ${calendarId}
  `;
  if (row?.horizon_start && row.horizon_end) return { start: row.horizon_start, end: row.horizon_end };
  return targetHorizon(new Date());
}

function emptyInput(context: CollectionContext, horizon: { start: Date; end: Date }, actor: string): ChangeSetInput {
  return { context, upserts: [], deletes: [], radicaleSkipped: [], pending404: [], full: false, horizon, actor };
}

/**
 * Toglie dall'indice le risorse indicate (versione 'delete' con l'ultimo
 * testo, id ritirati). Non è una sync: non tocca token, mtime né salute.
 */
export async function removeIndexedObjects(calendarId: string, hrefs: readonly string[], opts: { actor: string; deadline?: number }): Promise<ApplyResult> {
  const context = await loadCollectionContext(sql, calendarId);
  return withCollectionWriteLock(calendarId, async (lock) => {
    const conn = lock.conn as unknown as Db;
    const input = { ...emptyInput(context, await collectionHorizon(conn, context.calendarId), opts.actor), deletes: [...hrefs] };
    return applyInternal(lock, { input, items: [], preparedAt: new Date() }, { syncedAt: new Date() }, { bookkeeping: 'none' });
  }, { deadline: opts.deadline });
}

/**
 * Mette in quarantena una risorsa con il motivo dato (auditor: file su disco
 * che Radicale non elenca; admin). Con `raw` il testo corrente (letto dal
 * mount), altrimenti quello già indicizzato. Le occorrenze: ultima versione
 * buona, quelle già indicizzate o il blocco conservativo dal testo.
 */
export async function quarantineIndexedObject(
  calendarId: string,
  href: string,
  reason: string,
  opts: { actor: string; raw?: string | null; deadline?: number },
): Promise<ApplyResult> {
  if (!HEALTH_REASON_RE.test(reason)) throw new Error(`quarantineIndexedObject: motivo non valido: ${JSON.stringify(reason)}`);
  if (!isStorableHref(href)) throw new Error(`quarantineIndexedObject: href non valido: ${JSON.stringify(href)}`);
  const context = await loadCollectionContext(sql, calendarId);
  return withCollectionWriteLock(calendarId, async (lock) => {
    const conn = lock.conn as unknown as Db;
    let raw = opts.raw;
    if (raw === undefined) {
      const [row] = await conn<Array<{ raw_ics: string | null }>>`
        SELECT raw_ics FROM cal_objects WHERE calendar_id = ${context.calendarId} AND href = ${href}
      `;
      raw = row?.raw_ics ?? null;
    }
    const horizon = await collectionHorizon(conn, context.calendarId);
    const input = emptyInput(context, horizon, opts.actor);
    const item = prepareForcedQuarantine(href, raw, reason, prepareContextOf(input));
    return applyInternal(lock, { input, items: [item], preparedAt: new Date() }, { syncedAt: new Date() }, { bookkeeping: 'none' });
  }, { deadline: opts.deadline });
}

/**
 * Rigenera le occorrenze della collezione da cal_objects.raw_ics con
 * l'orizzonte, il ruolo, il fuso e la regola blocks correnti (orizzonte che
 * scorre, cambio di ruolo o di fuso, decisione 6). Nessun I/O verso Radicale,
 * nessuna versione nuova (il testo non cambia). Le risorse in pending_404
 * restano com'erano finché la sync non le risolve.
 */
export async function rematerializeCollection(
  calendarId: string,
  opts: { horizon: { start: Date; end: Date }; reason: 'horizon' | 'role' | 'timezone' | 'rules'; deadline?: number },
): Promise<ApplyResult> {
  const context = await loadCollectionContext(sql, calendarId);
  return withCollectionWriteLock(calendarId, async (lock) => {
    const conn = lock.conn as unknown as Db;
    const rows = await conn<Array<Pick<CalObjectRow, 'href' | 'etag' | 'raw_ics' | 'semantic_fp' | 'health' | 'health_reason'>>>`
      SELECT href, etag, raw_ics, semantic_fp, health, health_reason
      FROM cal_objects
      WHERE calendar_id = ${context.calendarId} AND health <> 'pending_404'
      ORDER BY href
    `;
    const input: ChangeSetInput = {
      ...emptyInput(context, opts.horizon, `rematerialize:${opts.reason}`),
      full: true,
      upserts: rows
        .filter((r) => !(r.health === 'quarantined' && r.health_reason === HEALTH_REASONS.radicaleSkip))
        .map((r): RawItem => ({ href: r.href, etag: r.etag, raw: r.raw_ics, semanticFp: context.originStore === 'remote' ? r.semantic_fp : undefined })),
    };
    const preparedSet = await prepareCollectionChanges(input);
    const pc = prepareContextOf(input);
    // Le risorse che Radicale salta restano in quarantena 'radicale-skip' (il testo non dice nulla sul motivo).
    const skipped = rows
      .filter((r) => r.health === 'quarantined' && r.health_reason === HEALTH_REASONS.radicaleSkip)
      .map((r) => ({ ...prepareForcedQuarantine(r.href, r.raw_ics, HEALTH_REASONS.radicaleSkip, pc), etag: null }));
    const prepared: PreparedChangeSet = { input, items: [...preparedSet.items, ...skipped], preparedAt: new Date() };
    return applyInternal(lock, prepared, { replaceAll: true, syncedAt: new Date() }, { bookkeeping: 'none', forceHorizon: true });
  }, { deadline: opts.deadline });
}

// ─── Espansione al volo ───────────────────────────────

/**
 * Espansione al volo di un oggetto indicizzato su una finestra (busy oltre
 * materialized_until, admin fuori orizzonte), con le stesse regole di kind e
 * blocks dell'indicizzatore. Non lancia: testo illeggibile o espansione non
 * riuscita → blocco conservativo della sola finestra per quel solo oggetto.
 */
export function expandIndexedObject(
  row: Pick<CalObjectRow, 'id' | 'calendar_id' | 'href' | 'raw_ics' | 'health'>,
  context: CollectionContext,
  window: { from: Date; to: Date },
): { occurrences: Array<{ recurrenceKey: string; start: Date; end: Date; allDay: boolean; kind: OccurrenceKind; blocks: boolean }>; conservative: boolean } {
  const from = window.from.getTime();
  const to = window.to.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return { occurrences: [], conservative: false };
  try {
    return expandRawOnTheFly(row.raw_ics, row.href, context, { from, to });
  } catch (err) {
    log.warn({ err, objectId: row.id }, 'espansione al volo non riuscita: blocco conservativo della finestra');
    return {
      occurrences: [{ recurrenceKey: 'conservative', start: window.from, end: window.to, allDay: false, kind: 'conservative', blocks: true }],
      conservative: true,
    };
  }
}
