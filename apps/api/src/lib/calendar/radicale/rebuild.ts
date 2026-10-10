/**
 * Ricostruzione dell'indice (fase F2 del passaggio a Radicale; design §6.7,
 * §16.2, §16.3; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §3 e §5.3).
 *
 * Protocollo (design §6.7, revisione red-team punto 18):
 *  1. requestIndexRebuild(): in UNA transazione rebuild_required=true e, per
 *     tutte le collezioni Radicale, dir_mtime_ns=NULL e sync_token=NULL; più
 *     il job index_rebuild (outbox: esiste solo dopo la COMMIT). Da questo
 *     momento le decisioni trovano dir_mtime_ns NULL e forzano la sync
 *     completa della collezione entro il budget, altrimenti rispondono 503
 *     (rebuild_in_progress): mai busy su righe vecchie che sembrano fresche,
 *     mai busy vuoto;
 *  2. runIndexRebuild() (handler del job): ogni collezione Radicale-backed si
 *     ricostruisce con syncCollection(id, { reason: 'rebuild', full: true }),
 *     cioè listing completo e apply con replaceAll (delete e insert della
 *     collezione nella stessa transazione), passando per l'interruttore
 *     anti-cancellazione; gli id restano in cal_object_ids e si ripresentano
 *     identici (con cal_object_ids vuota, scenario B del design §16.3, gli id
 *     nuovi sono deterministici: uuidv5(UID|recurrence_key));
 *  3. rebuild_required=false solo se tutte le collezioni richieste sono
 *     riuscite con identità ok e nessuna nuova richiesta è arrivata nel
 *     frattempo. Con epoch = 0 (volume non inizializzato, mode postgres) non
 *     c'è nulla da ricostruire e si azzera subito; senza Radicale raggiungibile
 *     resta true (policy frozen: in mode postgres stessi permessi di shadow) e
 *     il job si ripete con backoff, poi l'auditor lo riaccoda.
 *
 * Un solo rebuild completo alla volta fra processi: pg_try_advisory_lock
 * 'cal-rebuild' su una connessione riservata del pool PRINCIPALE (le sync del
 * rebuild usano il pool calendario: tenere lì anche il lock del rebuild
 * violerebbe la regola contro lo stallo del contratto §1.3).
 */

import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { CAL_JOB_KINDS, CAL_JOB_PRIORITY, type CalendarJob, enqueueCalendarJob, registerCalendarJobHandler } from '../jobs';
import { CAL_LOCKS, targetHorizon } from '../index-model';
import { errorText, raiseIndexAlert } from './health';
import { rematerializeCollection } from './indexer';
import type { Db } from './policy';
import { readBackendState } from './policy';
import { syncCollection } from './sync';

const log: Logger = rootLogger.child({ scope: 'calendar-index-rebuild' });

/** Chiave del job che ricostruisce tutte le collezioni (le altre chiavi sono calendar_id). */
export const REBUILD_ALL_KEY = 'all';
/** Lease del job index_rebuild: una collezione grande richiede secondi, il lease si estende a ogni collezione. */
const REBUILD_LEASE_MS = 10 * 60_000;
/** Scadenza della sync di una collezione durante il rebuild. */
const COLLECTION_SYNC_DEADLINE_MS = 5 * 60_000;

/** Un altro processo sta già ricostruendo l'indice: il job riprova più tardi. */
export class IndexRebuildBusyError extends Error {
  readonly code = 'INDEX_REBUILD_BUSY' as const;
  constructor() {
    super('rebuild dell\'indice già in corso in un altro processo');
    this.name = 'IndexRebuildBusyError';
  }
}

/** Rebuild concluso senza ricostruire tutte le collezioni richieste (Radicale giù, identità diversa...). */
export class IndexRebuildIncompleteError extends Error {
  readonly code = 'INDEX_REBUILD_INCOMPLETE' as const;
  constructor(readonly report: RebuildReport) {
    const failed = report.collections.filter((c) => !c.ok).length;
    super(`rebuild dell'indice incompleto: ${failed} collezioni non ricostruite`);
    this.name = 'IndexRebuildIncompleteError';
  }
}

/**
 * Richiede la ricostruzione dell'indice (import di un backup, restore,
 * admin): una sola transazione con rebuild_required=true, dir_mtime_ns e
 * sync_token azzerati per tutte le collezioni Radicale e il job
 * index_rebuild accodato. Con un pool apre la transazione; dentro una
 * transazione del chiamante (sql.begin) usa quella.
 */
export async function requestIndexRebuild(db: Db, opts: { reason: string; actor: string }): Promise<void> {
  const run = async (tx: Db): Promise<void> => {
    await tx`UPDATE calendar_backend_state SET rebuild_required = true WHERE id = true`;
    await tx`
      UPDATE cal_collection_state
      SET dir_mtime_ns = NULL, sync_token = NULL
      WHERE origin_store = 'radicale' AND (dir_mtime_ns IS NOT NULL OR sync_token IS NOT NULL)
    `;
    await enqueueCalendarJob(
      CAL_JOB_KINDS.indexRebuild,
      REBUILD_ALL_KEY,
      { reason: opts.reason.slice(0, 200), actor: opts.actor.slice(0, 200) },
      { db: tx, priority: CAL_JOB_PRIORITY.high },
    );
  };
  if (typeof (db as Partial<Db>).begin === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js (vedi Db in policy.ts)
    await db.begin(async (tx: any) => run(tx));
  } else {
    await run(db);
  }
  log.warn({ reason: opts.reason, actor: opts.actor }, 'rebuild dell\'indice richiesto: decisioni con sync forzata fino alla fine');
}

/**
 * Rebuild richiesto (rebuild_required) senza un job index_rebuild attivo:
 * lo richiede con requestIndexRebuild (token e dir_mtime_ns azzerati, job
 * accodato). Serve all'avvio dell'API dopo restore-calendar-stack.sh o un
 * UPDATE manuale dello stato, che impostano solo il flag: senza, il rebuild
 * partirebbe solo con l'auditor notturno. true se l'ha richiesto.
 */
export async function ensureRequestedRebuild(db: Db = sql, opts: { reason?: string; actor?: string } = {}): Promise<boolean> {
  const [row] = await db<Array<{ required: boolean; active: boolean }>>`
    SELECT s.rebuild_required AS required,
           EXISTS (SELECT 1 FROM cal_jobs j WHERE j.kind = ${CAL_JOB_KINDS.indexRebuild} AND j.status IN ('pending', 'running')) AS active
    FROM calendar_backend_state s WHERE s.id = true
  `;
  if (!row?.required || row.active) return false;
  await requestIndexRebuild(db, { reason: opts.reason ?? 'startup', actor: opts.actor ?? 'startup' });
  return true;
}

export interface RebuildReport {
  startedAt: Date;
  finishedAt: Date;
  collections: Array<{ calendarId: string; ok: boolean; error?: string }>;
  /** rebuild_required azzerato da questo giro. */
  cleared: boolean;
}

interface RebuildTarget {
  id: string;
  collection_name: string;
  missing: boolean;
}

/** Collezioni Radicale-backed attive (mai iscrizioni né collezioni di sistema `_*`). */
async function rebuildTargets(db: Db): Promise<RebuildTarget[]> {
  const rows = await db<RebuildTarget[]>`
    SELECT id, collection_name, (missing_since IS NOT NULL) AS missing
    FROM calendars
    WHERE role <> 'subscription' AND lifecycle = 'active'
      AND collection_name IS NOT NULL AND collection_name NOT LIKE '\\_%'
    ORDER BY sort_order, collection_name, id
  `;
  return Array.from(rows);
}

/**
 * Ricostruisce l'indice di tutte le collezioni Radicale-backed (handler del
 * job index_rebuild 'all'). Vedi la testa del file. Lancia
 * IndexRebuildBusyError se un altro processo tiene il lock 'cal-rebuild';
 * i fallimenti delle singole collezioni finiscono nel rapporto.
 */
export async function runIndexRebuild(opts: { signal?: AbortSignal; extendLease?: () => Promise<boolean> } = {}): Promise<RebuildReport> {
  const startedAt = new Date();
  const conn = await sql.reserve();
  try {
    const [lock] = await conn<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${CAL_LOCKS.rebuild})) AS ok`;
    if (!lock?.ok) throw new IndexRebuildBusyError();
    try {
      return await rebuildAll(conn as unknown as Db, startedAt, opts);
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext(${CAL_LOCKS.rebuild}))`.catch((err: unknown) => {
        log.warn({ err }, 'pg_advisory_unlock del rebuild non riuscito');
      });
    }
  } finally {
    conn.release();
  }
}

async function rebuildAll(db: Db, startedAt: Date, opts: { signal?: AbortSignal; extendLease?: () => Promise<boolean> }): Promise<RebuildReport> {
  const state = await readBackendState(db);
  const collections: RebuildReport['collections'] = [];

  if (state.epoch === 0) {
    // Volume mai inizializzato: in Radicale non c'è nulla di autorevole da ricostruire.
    const cleared = await db`UPDATE calendar_backend_state SET rebuild_required = false WHERE id = true AND rebuild_required RETURNING 1`;
    log.info({ cleared: cleared.length > 0 }, 'rebuild dell\'indice: volume non inizializzato, nulla da ricostruire');
    return { startedAt, finishedAt: new Date(), collections, cleared: true };
  }

  // Scenario B (database perso): senza id persistenti si allocano id deterministici.
  const [{ empty }] = await db<Array<{ empty: boolean }>>`SELECT NOT EXISTS (SELECT 1 FROM cal_object_ids) AS empty`;
  const idStrategy = empty ? 'deterministic' : 'random';

  const targets = await rebuildTargets(db);
  const required: string[] = [];
  let stopReason: string | null = null;
  for (const target of targets) {
    if (target.missing) {
      // Collezione sparita da Radicale: niente da scaricare, l'indice ne tiene le occorrenze (design §6.3).
      collections.push({ calendarId: target.id, ok: false, error: 'collezione assente in Radicale (missing_since)' });
      continue;
    }
    required.push(target.id);
    if (stopReason !== null || opts.signal?.aborted) {
      collections.push({ calendarId: target.id, ok: false, error: stopReason ?? 'rebuild interrotto' });
      continue;
    }
    try {
      await syncCollection(target.id, {
        reason: 'rebuild',
        full: true,
        actor: 'rebuild',
        idStrategy,
        signal: opts.signal,
        deadline: Date.now() + COLLECTION_SYNC_DEADLINE_MS,
      });
      collections.push({ calendarId: target.id, ok: true });
    } catch (err) {
      const message = errorText(err);
      collections.push({ calendarId: target.id, ok: false, error: message });
      log.error({ err, calendarId: target.id }, 'rebuild della collezione non riuscito');
      const code = (err as { code?: unknown }).code;
      // Senza Radicale o con l'identità diversa falliranno anche le altre: si smette subito.
      if (code === 'identity' || code === 'not_configured') stopReason = message;
    }
    if (opts.extendLease) await opts.extendLease().catch(() => false);
  }

  // Iscrizioni: la fonte è il feed remoto, l'indice è la cache; si rimaterializzano dal testo indicizzato.
  const remote = await db<Array<{ calendar_id: string }>>`
    SELECT s.calendar_id FROM cal_collection_state s JOIN calendars c ON c.id = s.calendar_id
    WHERE s.origin_store = 'remote' AND c.lifecycle = 'active'
  `;
  const horizon = targetHorizon(new Date());
  for (const { calendar_id } of remote) {
    if (opts.signal?.aborted) break;
    try {
      await rematerializeCollection(calendar_id, { horizon, reason: 'rules', deadline: Date.now() + 60_000 });
    } catch (err) {
      log.warn({ err, calendarId: calendar_id }, 'rimaterializzazione di un\'iscrizione durante il rebuild non riuscita');
    }
  }

  const allOk = required.every((id) => collections.some((c) => c.calendarId === id && c.ok));
  let cleared = false;
  if (allOk && !opts.signal?.aborted) {
    // Una nuova richiesta arrivata durante il giro ha riazzerato i token: in quel caso si lascia al prossimo job.
    const rows = await db`
      UPDATE calendar_backend_state SET rebuild_required = false
      WHERE id = true AND rebuild_required
        AND NOT EXISTS (
          SELECT 1 FROM cal_collection_state s
          WHERE s.calendar_id = ANY(${required}::uuid[]) AND s.origin_store = 'radicale' AND s.sync_token IS NULL
        )
      RETURNING 1
    `;
    cleared = rows.length > 0;
    if (!cleared) {
      const [still] = await db<Array<{ rebuild_required: boolean }>>`SELECT rebuild_required FROM calendar_backend_state WHERE id = true`;
      cleared = still?.rebuild_required === false;
    }
  }
  const report: RebuildReport = { startedAt, finishedAt: new Date(), collections, cleared };
  if (cleared) {
    log.info({ collections: required.length, durationMs: report.finishedAt.getTime() - startedAt.getTime() }, 'rebuild dell\'indice completato');
  } else {
    raiseIndexAlert('rebuild-failed', 'Rebuild dell\'indice non completato: decisioni con sync forzata o 503 finché non riesce', {
      key: 'all',
      failed: collections.filter((c) => !c.ok).length,
      reason: stopReason ?? undefined,
    });
  }
  return report;
}

/** Rebuild di una sola collezione (job index_rebuild con chiave calendar_id): non tocca rebuild_required. */
async function rebuildOne(calendarId: string, signal: AbortSignal): Promise<void> {
  const [{ empty }] = await sql<Array<{ empty: boolean }>>`SELECT NOT EXISTS (SELECT 1 FROM cal_object_ids) AS empty`;
  await syncCollection(calendarId, {
    reason: 'rebuild',
    full: true,
    actor: 'rebuild',
    idStrategy: empty ? 'deterministic' : 'random',
    signal,
    deadline: Date.now() + COLLECTION_SYNC_DEADLINE_MS,
  });
}

/**
 * Registra l'handler del job index_rebuild (da chiamare al boot prima di
 * startCalendarJobWorker). Un rebuild incompleto fallisce in modo ripetibile
 * (backoff 5 s → 1 h); un rebuild già in corso altrove si ripete più tardi.
 */
export function registerIndexRebuildJob(): void {
  registerCalendarJobHandler(
    CAL_JOB_KINDS.indexRebuild,
    async (job: CalendarJob, ctx) => {
      if (job.key === REBUILD_ALL_KEY) {
        const report = await runIndexRebuild({ signal: ctx.signal, extendLease: () => ctx.extendLease(REBUILD_LEASE_MS) });
        if (!report.cleared) throw new IndexRebuildIncompleteError(report);
        return {
          result: {
            collections: report.collections.length,
            failed: report.collections.filter((c) => !c.ok).length,
            durationMs: report.finishedAt.getTime() - report.startedAt.getTime(),
          },
        };
      }
      await rebuildOne(job.key, ctx.signal);
      return { result: { calendarId: job.key } };
    },
    { leaseMs: REBUILD_LEASE_MS },
  );
}
