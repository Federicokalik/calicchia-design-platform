/**
 * Salute dell'indice per collezione e per oggetto (fase F2 del passaggio a
 * Radicale; design §6.5, §7, §16.5; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §2.5 e §5.2).
 *
 * Stato di una collezione (cal_collection_state):
 *
 * | Stato        | Quando                                                     | Decisioni |
 * |--------------|------------------------------------------------------------|-----------|
 * | `healthy`    | ultima sync riuscita, nessuna modifica pendente da > 2 min | normali |
 * | `stale`      | dirty_since più vecchio di 2 minuti senza fallimenti, o mai sincronizzata | la freshness forza la sync |
 * | `unsyncable` | sync fallita (consecutive_failures > 0) con dirty_since non nullo | se bloccante: 503 subito nelle decisioni, dopo 10 minuti nel livello display |
 * | `hold`       | interruttore anti-cancellazione scattato                   | le occorrenze esistenti bloccano; nessun 503 |
 *
 * Il valore memorizzato in `health` è un'istantanea scritta da indicizzatore,
 * markCollectionDirty() e recordSyncFailure(); 'stale' dipende dal tempo, quindi
 * chi decide usa sempre deriveCollectionHealth() con l'orologio corrente.
 *
 * dirty_since: lo imposta chi osserva la directory diversa da dir_mtime_ns
 * (watcher, freshness: markCollectionDirty) e lo azzera la sync riuscita che
 * salva una dir_mtime_ns non racy (indexer.applyPreparedChanges). Una sync
 * fallita su una collezione Radicale senza una dir_mtime_ns verificata (mai
 * sincronizzata, rebuild richiesto, remote mode senza mount) lo imposta a sua
 * volta: senza una base verificata non si può escludere che ci siano
 * modifiche pendenti, e la decisione deve fallire chiusa (design §6.7: durante
 * il rebuild "altrimenti 503").
 *
 * Oggetti: ok, quarantined (con o senza ultima versione buona), pending_404
 * (continua a bloccare). Un singolo oggetto non porta mai a un 503: solo una
 * collezione bloccante unsyncable lo fa (invariante 2).
 *
 * Gli avvisi (raiseIndexAlert) vanno nei log, a Bugsink e, se configurato, su
 * Telegram, con una deduplicazione in memoria per non inondare il canale.
 */

import type { Logger } from 'pino';
import { sql } from '../../../db';
import { captureException } from '../../bugsink';
import { logger as rootLogger } from '../../logger';
import { isTelegramConfigured, notifyTelegram } from '../../telegram';
import { type CalCollectionStateRow, type CollectionHealth, INDEX_TIMING, type OriginStore } from '../index-model';
import type { Db } from './policy';
import type { CalendarRole } from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-index-health' });

/** Lunghezza massima di last_error (testo dell'errore, mai dati del calendario). */
const MAX_ERROR_TEXT = 1_000;

/** Oggetti in quarantena elencati nel riepilogo (il conteggio per collezione resta completo). */
const QUARANTINE_LIST_LIMIT = 500;

// ─── Viste ───────────────────────────────

export interface CollectionHealthView {
  calendarId: string;
  collectionName: string | null;
  role: CalendarRole;
  originStore: OriginStore;
  /** La collezione conta nel busy (flag del calendario; per le iscrizioni anche il flag dell'iscrizione). */
  blocking: boolean;
  /** Stato derivato all'istante del calcolo (deriveCollectionHealth). */
  health: CollectionHealth;
  /** Da quando vale lo stato derivato (per 'unsyncable' è la base dei 10 minuti del livello display). */
  healthSince: Date;
  dirtySince: Date | null;
  lastSyncedAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  holdReason: string | null;
  pendingDeletions: number;
  objectCount: number;
  quarantined: number;
  /** int8 come stringa. */
  indexVersion: string;
  horizon: { start: Date; end: Date } | null;
}

export interface IndexHealthSummary {
  collections: CollectionHealthView[];
  quarantined: Array<{ objectId: string; calendarId: string; href: string; reason: string | null; since: Date; hasLastGood: boolean }>;
  /** Override il cui RECURRENCE-ID non appartiene alla serie (occorrenze autonome, design §6.4). */
  orphanOverrides: number;
  /** Oggetti in quarantena senza alcuna occorrenza: esclusi dal busy (badge "illeggibile", design §6.5). */
  unreadable: number;
  /** Oggetti con più di 5000 occorrenze nell'orizzonte (materialized_until). */
  materializedLimited: number;
  generatedAt: Date;
}

// ─── Stato derivato ───────────────────────────────

/**
 * Stato effettivo di una collezione all'istante `now` (pura):
 * hold → hold; fallimenti con modifiche pendenti → unsyncable; modifiche
 * pendenti da oltre 2 minuti → stale; mai sincronizzata (stato memorizzato
 * 'stale' senza dirty_since) → stale; altrimenti healthy.
 */
export function deriveCollectionHealth(
  state: Pick<CalCollectionStateRow, 'health' | 'consecutive_failures' | 'dirty_since' | 'hold_since'>,
  now: Date,
): CollectionHealth {
  if (state.hold_since || state.health === 'hold') return 'hold';
  const failures = Number(state.consecutive_failures ?? 0);
  if (failures > 0 && state.dirty_since) return 'unsyncable';
  if (state.dirty_since && now.getTime() - state.dirty_since.getTime() >= INDEX_TIMING.staleAfterMs) return 'stale';
  if (state.health === 'stale' && !state.dirty_since) return 'stale';
  return 'healthy';
}

/**
 * true se la collezione deve produrre un 503 (design §6.5, §7): solo se è
 * bloccante e unsyncable; nelle decisioni subito, nel livello display dopo 10
 * minuti di unsyncable (health_since). hold e stale non producono mai 503.
 */
export function blocksDecisions(view: CollectionHealthView, level: 'display' | 'decision', now: Date): boolean {
  if (!view.blocking || view.health !== 'unsyncable') return false;
  if (level === 'decision') return true;
  return now.getTime() - view.healthSince.getTime() >= INDEX_TIMING.unsyncableDisplayGraceMs;
}

// ─── Lettura ───────────────────────────────

interface HealthRow {
  calendar_id: string;
  collection_name: string | null;
  role: CalendarRole;
  blocking: boolean;
  has_state: boolean;
  origin_store: OriginStore | null;
  health: CollectionHealth | null;
  health_since: Date | null;
  dirty_since: Date | null;
  last_synced_at: Date | null;
  consecutive_failures: number | null;
  last_error: string | null;
  hold_reason: string | null;
  hold_since: Date | null;
  pending_deletions: number | null;
  object_count: number | null;
  quarantined_count: number | null;
  index_version: string | null;
  horizon_start: Date | null;
  horizon_end: Date | null;
  calendar_created_at: Date;
}

/** Da quando vale lo stato derivato, dai campi memorizzati. */
function sinceOf(health: CollectionHealth, row: HealthRow): Date {
  const stored = row.health_since ?? row.calendar_created_at;
  switch (health) {
    case 'hold':
      return row.hold_since ?? stored;
    case 'unsyncable':
      // health_since è aggiornato quando lo stato memorizzato diventa unsyncable;
      // altrimenti (stato memorizzato più vecchio) vale l'inizio delle modifiche pendenti.
      return row.health === 'unsyncable' ? stored : (row.dirty_since ?? stored);
    case 'stale':
      return row.dirty_since ? new Date(row.dirty_since.getTime() + INDEX_TIMING.staleAfterMs) : stored;
    default:
      return row.health === 'healthy' ? stored : (row.last_synced_at ?? stored);
  }
}

function toView(row: HealthRow, now: Date): CollectionHealthView {
  const originStore: OriginStore = row.origin_store ?? (row.role === 'subscription' ? 'remote' : 'radicale');
  const stateLike = {
    // Una collezione senza riga di stato non è mai stata sincronizzata.
    health: row.health ?? 'stale',
    consecutive_failures: row.consecutive_failures ?? 0,
    dirty_since: row.dirty_since,
    hold_since: row.hold_since,
  } as Pick<CalCollectionStateRow, 'health' | 'consecutive_failures' | 'dirty_since' | 'hold_since'>;
  const health = deriveCollectionHealth(stateLike, now);
  return {
    calendarId: row.calendar_id,
    collectionName: row.collection_name,
    role: row.role,
    originStore,
    blocking: row.blocking,
    health,
    healthSince: sinceOf(health, row),
    dirtySince: row.dirty_since,
    lastSyncedAt: row.last_synced_at,
    consecutiveFailures: row.consecutive_failures ?? 0,
    lastError: row.last_error,
    holdReason: row.hold_reason,
    pendingDeletions: row.pending_deletions ?? 0,
    objectCount: row.object_count ?? 0,
    quarantined: row.quarantined_count ?? 0,
    indexVersion: row.index_version ?? '0',
    horizon: row.horizon_start && row.horizon_end ? { start: row.horizon_start, end: row.horizon_end } : null,
  };
}

/**
 * Viste di salute delle collezioni: tutte quelle con una riga di stato, più le
 * collezioni Radicale attive del sidecar non ancora indicizzate (stato 'stale',
 * "mai sincronizzata"). Con `calendarIds` solo quelle indicate.
 */
export async function listCollectionHealth(db: Db = sql, opts: { calendarIds?: readonly string[]; now?: Date } = {}): Promise<CollectionHealthView[]> {
  const now = opts.now ?? new Date();
  const ids = opts.calendarIds ? [...opts.calendarIds] : null;
  const rows = await db<HealthRow[]>`
    SELECT c.id AS calendar_id, c.collection_name, c.role, c.created_at AS calendar_created_at,
           CASE WHEN c.role = 'subscription'
                THEN COALESCE(s.blocks_availability, false) AND COALESCE(p.blocks_availability, false)
                ELSE c.blocks_availability END AS blocking,
           (st.calendar_id IS NOT NULL) AS has_state,
           st.origin_store, st.health, st.health_since, st.dirty_since, st.last_synced_at,
           st.consecutive_failures, st.last_error, st.hold_reason, st.hold_since,
           COALESCE(cardinality(st.pending_deletions), 0)::int AS pending_deletions,
           st.object_count, st.quarantined_count, st.index_version::text AS index_version,
           st.horizon_start, st.horizon_end
    FROM calendars c
    LEFT JOIN cal_collection_state st ON st.calendar_id = c.id
    LEFT JOIN calendars p ON p.id = c.parent_calendar_id
    LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
    WHERE (${ids === null} OR c.id = ANY(${ids ?? []}::uuid[]))
      AND (
        st.calendar_id IS NOT NULL
        OR (c.role <> 'subscription' AND c.lifecycle = 'active'
            AND c.collection_name IS NOT NULL AND c.collection_name NOT LIKE '\\_%')
      )
    ORDER BY c.sort_order, c.collection_name NULLS LAST, c.id
  `;
  return rows.map((r) => toView(r, now));
}

/** Vista di una sola collezione, o null se il calendario non esiste o non è una collezione indicizzabile. */
export async function collectionHealthView(db: Db, calendarId: string, now: Date = new Date()): Promise<CollectionHealthView | null> {
  const [view] = await listCollectionHealth(db, { calendarIds: [calendarId], now });
  return view ?? null;
}

/** Riepilogo completo della salute dell'indice (pagina "Salute del calendario", /api/health/calendar). */
export async function getIndexHealth(db: Db = sql): Promise<IndexHealthSummary> {
  const generatedAt = new Date();
  const collections = await listCollectionHealth(db, { now: generatedAt });
  const quarantined = await db<Array<{ id: string; calendar_id: string; href: string; health_reason: string | null; health_since: Date | null; has_last_good: boolean }>>`
    SELECT o.id, o.calendar_id, o.href, o.health_reason, o.health_since,
           (o.last_good_version_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM cal_occurrences x WHERE x.object_id = o.id AND x.stale)) AS has_last_good
    FROM cal_objects o
    WHERE o.health = 'quarantined'
    ORDER BY o.health_since DESC NULLS LAST, o.id
    LIMIT ${QUARANTINE_LIST_LIMIT}
  `;
  const [counts] = await db<Array<{ orphans: number; unreadable: number; limited: number }>>`
    SELECT
      (SELECT count(*) FROM cal_components WHERE orphan)::int AS orphans,
      (SELECT count(*) FROM cal_objects o
        WHERE o.health = 'quarantined'
          AND NOT EXISTS (SELECT 1 FROM cal_occurrences x WHERE x.object_id = o.id))::int AS unreadable,
      (SELECT count(*) FROM cal_objects WHERE materialized_until IS NOT NULL)::int AS limited
  `;
  return {
    collections,
    quarantined: quarantined.map((q) => ({
      objectId: q.id,
      calendarId: q.calendar_id,
      href: q.href,
      reason: q.health_reason,
      since: q.health_since ?? generatedAt,
      hasLastGood: q.has_last_good,
    })),
    orphanOverrides: counts?.orphans ?? 0,
    unreadable: counts?.unreadable ?? 0,
    materializedLimited: counts?.limited ?? 0,
    generatedAt,
  };
}

// ─── Scritture dello stato ───────────────────────────────

/**
 * Registra che la directory della collezione è diversa da dir_mtime_ns
 * (watcher, freshness): dirty_since resta il primo istante osservato. Se la
 * collezione aveva già sync fallite, da adesso è unsyncable (health_since =
 * observedAt). Crea la riga di stato se manca (collezione mai sincronizzata);
 * non fa nulla se il calendario non esiste.
 */
export async function markCollectionDirty(db: Db, calendarId: string, observedAt: Date): Promise<void> {
  await db`
    INSERT INTO cal_collection_state (calendar_id, origin_store, dirty_since, health, health_since)
    SELECT c.id, CASE WHEN c.role = 'subscription' THEN 'remote' ELSE 'radicale' END, ${observedAt}, 'stale', ${observedAt}
    FROM calendars c
    WHERE c.id = ${calendarId}
    ON CONFLICT (calendar_id) DO UPDATE SET
      health = CASE
        WHEN cal_collection_state.health <> 'hold' AND cal_collection_state.consecutive_failures > 0
             AND cal_collection_state.dirty_since IS NULL THEN 'unsyncable'
        ELSE cal_collection_state.health END,
      health_since = CASE
        WHEN cal_collection_state.health NOT IN ('hold', 'unsyncable') AND cal_collection_state.consecutive_failures > 0
             AND cal_collection_state.dirty_since IS NULL THEN EXCLUDED.dirty_since
        ELSE cal_collection_state.health_since END,
      dirty_since = COALESCE(cal_collection_state.dirty_since, EXCLUDED.dirty_since)
  `;
}

/** Testo breve e sicuro di un errore per last_error (niente stack, niente testo del calendario). */
export function errorText(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    text = typeof code === 'string' && !error.message.includes(code) ? `${code}: ${error.message}` : error.message;
  } else {
    text = String(error);
  }
  text = text.replace(/[\r\n\t]+/g, ' ').trim() || 'errore sconosciuto';
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT - 1)}…` : text;
}

/**
 * Registra una sync fallita: consecutive_failures + 1, last_error e
 * last_attempt_at. Per una collezione Radicale senza dir_mtime_ns verificata
 * imposta anche dirty_since (vedi testa del file). Restituisce lo stato
 * derivato dopo il fallimento; lo stato memorizzato diventa 'unsyncable'
 * (health_since = at) la prima volta che ci sono fallimenti con modifiche
 * pendenti. Crea la riga di stato se manca.
 */
export async function recordSyncFailure(db: Db, calendarId: string, error: unknown, at: Date): Promise<CollectionHealth> {
  const message = errorText(error);
  const rows = await db<Array<Pick<CalCollectionStateRow, 'health' | 'consecutive_failures' | 'dirty_since' | 'hold_since'>>>`
    INSERT INTO cal_collection_state
      (calendar_id, origin_store, consecutive_failures, last_error, last_attempt_at, dirty_since, health, health_since)
    SELECT c.id, CASE WHEN c.role = 'subscription' THEN 'remote' ELSE 'radicale' END, 1, ${message}, ${at},
           CASE WHEN c.role = 'subscription' THEN NULL ELSE ${at}::timestamptz END,
           CASE WHEN c.role = 'subscription' THEN 'stale' ELSE 'unsyncable' END, ${at}
    FROM calendars c
    WHERE c.id = ${calendarId}
    ON CONFLICT (calendar_id) DO UPDATE SET
      consecutive_failures = cal_collection_state.consecutive_failures + 1,
      last_error = EXCLUDED.last_error,
      last_attempt_at = EXCLUDED.last_attempt_at,
      dirty_since = COALESCE(
        cal_collection_state.dirty_since,
        CASE WHEN cal_collection_state.origin_store = 'radicale' AND cal_collection_state.dir_mtime_ns IS NULL
             THEN EXCLUDED.last_attempt_at END
      ),
      health = CASE
        WHEN cal_collection_state.health = 'hold' THEN 'hold'
        WHEN COALESCE(
               cal_collection_state.dirty_since,
               CASE WHEN cal_collection_state.origin_store = 'radicale' AND cal_collection_state.dir_mtime_ns IS NULL
                    THEN EXCLUDED.last_attempt_at END
             ) IS NOT NULL THEN 'unsyncable'
        ELSE cal_collection_state.health END,
      health_since = CASE
        WHEN cal_collection_state.health NOT IN ('hold', 'unsyncable')
             AND COALESCE(
               cal_collection_state.dirty_since,
               CASE WHEN cal_collection_state.origin_store = 'radicale' AND cal_collection_state.dir_mtime_ns IS NULL
                    THEN EXCLUDED.last_attempt_at END
             ) IS NOT NULL THEN EXCLUDED.last_attempt_at
        ELSE cal_collection_state.health_since END
    RETURNING health, consecutive_failures, dirty_since, hold_since
  `;
  const row = rows[0];
  if (!row) {
    log.warn({ calendarId }, 'recordSyncFailure: calendario inesistente, fallimento non registrato');
    return 'unsyncable';
  }
  const health = deriveCollectionHealth(row, at);
  if (health === 'unsyncable' && row.consecutive_failures === 1) {
    raiseIndexAlert('collection-unsyncable', `Collezione ${calendarId} non sincronizzabile con modifiche pendenti`, { calendarId, error: message });
  }
  return health;
}

// ─── Avvisi ───────────────────────────────

/** Intervallo minimo fra due avvisi con la stessa chiave (log a ogni occorrenza, Bugsink e Telegram deduplicati). */
const ALERT_DEDUP_MS = 6 * 3_600_000;
const ALERT_MEMORY_MAX = 1_000;
const lastAlertAt = new Map<string, number>();

/**
 * Codici degli avvisi dell'indice. Elenco aperto: i moduli SYNC e SUBS
 * possono usarne altri (es. 'collection-hold').
 */
export type IndexAlertCode =
  | 'object-quarantined'
  | 'object-unreadable'
  | 'radicale-skip'
  | 'orphan-override'
  | 'collection-unsyncable'
  | 'collection-hold'
  | 'horizon-insufficient'
  | 'audit-drift'
  | 'audit-broken-file'
  | 'audit-identity'
  | 'audit-policy'
  | 'audit-heartbeat'
  | 'booking-missing-projection'
  | 'booking-orphan-projection'
  | 'booking-drift'
  | 'booking-conflict'
  | 'rebuild-failed'
  | (string & {});

/**
 * Avviso operativo dell'indice (design §16.5): log warn sempre; Bugsink e
 * Telegram (se configurato) al più una volta ogni 6 ore per chiave
 * (codice + `details.key`, o codice + calendarId + href). Non lancia mai e non
 * attende l'invio. `details` non deve contenere testo del calendario (titoli,
 * descrizioni, email): solo id, href, codici.
 */
export function raiseIndexAlert(code: IndexAlertCode, message: string, details: Record<string, unknown> = {}): void {
  try {
    log.warn({ alert: code, ...details }, message);
    const key = `${code}|${String(details.key ?? '')}|${String(details.calendarId ?? '')}|${String(details.href ?? '')}`;
    const now = Date.now();
    const last = lastAlertAt.get(key);
    if (last !== undefined && now - last < ALERT_DEDUP_MS) return;
    if (lastAlertAt.size >= ALERT_MEMORY_MAX) {
      for (const [k, t] of lastAlertAt) if (now - t >= ALERT_DEDUP_MS) lastAlertAt.delete(k);
      if (lastAlertAt.size >= ALERT_MEMORY_MAX) lastAlertAt.clear();
    }
    lastAlertAt.set(key, now);
    captureException(new Error(`[calendario] ${code}: ${message}`), { source: 'calendar-index', alert: code, ...details });
    if (isTelegramConfigured()) {
      const body = Object.entries(details)
        .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
        .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`)
        .join('\n');
      void notifyTelegram(`Calendario: ${code}`, body ? `${message}\n${body}` : message).catch((err: unknown) => {
        log.debug({ err }, 'invio dell\'avviso su Telegram non riuscito');
      });
    }
  } catch (err) {
    log.error({ err, alert: code }, 'raiseIndexAlert: invio dell\'avviso non riuscito');
  }
}

/** Solo test: dimentica gli avvisi già inviati (deduplicazione). */
export function resetIndexAlertsForTests(): void {
  lastAlertAt.clear();
}
