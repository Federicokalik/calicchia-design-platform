/**
 * Orizzonte dell'indice (fase F2 del passaggio a Radicale; design §6.4,
 * §6.9; contratto dei moduli docs/calendar-radicale/contracts/f2-modules.md
 * §2.6 e §5.5).
 *
 * cal_occurrences copre, per ogni collezione, [oggi − 400 g, oggi + 800 g]
 * (targetHorizon, allineato al giorno UTC). L'orizzonte materializzato è per
 * collezione (cal_collection_state.horizon_start/end) e lo aggiorna
 * l'indicizzatore nella stessa transazione delle occorrenze.
 *
 *  - ensureHorizon() (cron giornaliero): rimaterializza da cal_objects.raw_ics
 *    le collezioni il cui orizzonte è indietro di almeno un giorno rispetto
 *    all'obiettivo, così le serie infinite e quelle troncate dal tetto delle
 *    5000 occorrenze (materialized_until) avanzano con il tempo. Nessun I/O
 *    verso Radicale: vale anche con Radicale giù o con l'identità del volume
 *    da verificare (si riespande ciò che l'indice ha già, mai dati nuovi).
 *  - assertHorizonCovers() (decisioni): garanzia statica
 *    horizon_end ≥ oggi + max(max_advance_days) + 14 g; se non regge per una
 *    collezione bloccante la decisione fallisce chiusa con
 *    CalendarUnavailableError('horizon_insufficient').
 *
 * Fuori dall'orizzonte (admin nel 2030, export) e oltre materialized_until si
 * espande al volo con indexer.expandIndexedObject.
 */

import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { readBackendStateFresh, storeKindForMode, storeKindOverride } from '../backend-mode';
import { CalendarUnavailableError } from '../errors';
import { requiredHorizonEnd, targetHorizon } from '../index-model';
import { raiseIndexAlert } from './health';
import { CollectionNotFoundError, rematerializeCollection } from './indexer';
import type { Db } from './policy';

const log: Logger = rootLogger.child({ scope: 'calendar-index-horizon' });

const DAY_MS = 86_400_000;
/** Attesa massima del lock di una collezione per la rimaterializzazione (lavoro di fondo). */
const REMATERIALIZE_LOCK_WAIT_MS = 120_000;

/**
 * max(max_advance_days) dei tipi di prenotazione attivi (0 se non ce ne
 * sono): con i 14 giorni di margine dà la fine minima dell'orizzonte per le
 * decisioni.
 */
export async function maxAdvanceDays(db: Db): Promise<number> {
  const [row] = await db<Array<{ days: number | null }>>`
    SELECT MAX(max_advance_days)::int AS days FROM calendar_event_types WHERE is_active
  `;
  const days = Number(row?.days ?? 0);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/** Collezioni da rimaterializzare per l'obiettivo dato. */
async function collectionsBehind(db: Db, target: { start: Date; end: Date }): Promise<string[]> {
  const endLimit = new Date(target.end.getTime() - DAY_MS);
  const startLimit = new Date(target.start.getTime() - DAY_MS);
  const rows = await db<Array<{ calendar_id: string }>>`
    SELECT s.calendar_id
    FROM cal_collection_state s
    JOIN calendars c ON c.id = s.calendar_id
    WHERE c.lifecycle = 'active'
      AND (
        (s.horizon_end IS NULL AND s.object_count > 0)
        OR s.horizon_end <= ${endLimit}
        OR s.horizon_start <= ${startLimit}
      )
    ORDER BY s.horizon_end NULLS FIRST, s.calendar_id
  `;
  return rows.map((r) => r.calendar_id);
}

/**
 * Estende (e fa avanzare) l'orizzonte delle collezioni rimaste indietro di
 * almeno un giorno: rimaterializzazione completa della collezione con
 * l'orizzonte obiettivo, una collezione alla volta. Restituisce gli id estesi
 * e quelli falliti (che restano con l'orizzonte precedente: le decisioni oltre
 * quell'orizzonte falliscono chiuse). Non lancia per il fallimento di una
 * collezione.
 */
export async function ensureHorizon(opts: { now?: Date; signal?: AbortSignal } = {}): Promise<{ extended: string[]; failed: string[] }> {
  const now = opts.now ?? new Date();
  const target = targetHorizon(now);
  const extended: string[] = [];
  const failed: string[] = [];
  const ids = await collectionsBehind(sql, target);
  for (const calendarId of ids) {
    if (opts.signal?.aborted) break;
    try {
      await rematerializeCollection(calendarId, { horizon: target, reason: 'horizon', deadline: Date.now() + REMATERIALIZE_LOCK_WAIT_MS });
      extended.push(calendarId);
    } catch (err) {
      if (err instanceof CollectionNotFoundError) continue; // calendario cancellato nel frattempo
      failed.push(calendarId);
      log.error({ err, calendarId }, 'estensione dell\'orizzonte della collezione non riuscita');
    }
  }
  if (extended.length > 0 || failed.length > 0) {
    log.info({ extended: extended.length, failed: failed.length, horizonEnd: target.end.toISOString() }, 'orizzonte dell\'indice aggiornato');
  }

  // Garanzia statica per le decisioni (design §6.9): avviso se non regge.
  // Conta solo con lo store Radicale, come nell'auditor e nella salute: in
  // mode postgres (indice in shadow, volume forse non inizializzato fino alla
  // F3) le collezioni senza stato sarebbero un falso allarme ogni notte.
  try {
    const state = await readBackendStateFresh(sql);
    if ((storeKindOverride() ?? storeKindForMode(state.mode)) !== 'radicale') return { extended, failed };
    const required = requiredHorizonEnd(now, await maxAdvanceDays(sql));
    const short = await collectionsShortOf(sql, required);
    if (short.length > 0) {
      raiseIndexAlert('horizon-insufficient', `Orizzonte dell'indice più corto della garanzia per ${short.length} collezioni bloccanti`, {
        key: 'ensure',
        required: required.toISOString(),
        collections: short.length,
      });
    }
  } catch (err) {
    log.warn({ err }, 'verifica della garanzia dell\'orizzonte non riuscita');
  }
  return { extended, failed };
}

interface CoverageRow {
  calendar_id: string;
  horizon_end: Date | null;
  has_state: boolean;
}

/**
 * Collezioni bloccanti (stesse regole della query di busy, design §7) con
 * l'orizzonte assente o più corto di `until`. Le collezioni Radicale sparite
 * (missing_since) e mai indicizzate non hanno nulla da coprire e non contano.
 * Le iscrizioni (role 'subscription', fonte remota) non contano mai: nelle
 * decisioni vale l'ultimo pull completato (design §6.6) e "mai scaricata"
 * equivale a "nessun evento"; un sidecar con oggetti e orizzonte corto o
 * assente lo copre l'espansione al volo del busy. Il guasto di un feed
 * esterno non porta mai le prenotazioni in 503.
 */
async function collectionsShortOf(db: Db, until: Date, calendarIds?: readonly string[]): Promise<CoverageRow[]> {
  const ids = calendarIds ? [...calendarIds] : null;
  const rows = await db<CoverageRow[]>`
    SELECT c.id AS calendar_id, st.horizon_end, (st.calendar_id IS NOT NULL) AS has_state
    FROM calendars c
    LEFT JOIN cal_collection_state st ON st.calendar_id = c.id
    WHERE c.lifecycle = 'active'
      AND c.role <> 'subscription'
      AND (${ids === null} OR c.id = ANY(${ids ?? []}::uuid[]))
      AND c.blocks_availability
      AND (
        st.calendar_id IS NOT NULL
        OR (c.missing_since IS NULL AND c.collection_name IS NOT NULL AND c.collection_name NOT LIKE '\\_%')
      )
      AND (st.horizon_end IS NULL OR st.horizon_end < ${until})
  `;
  return Array.from(rows);
}

/**
 * Garanzia dell'orizzonte per una decisione (design §6.9): ogni collezione
 * bloccante (o quelle indicate) deve avere occorrenze materializzate almeno
 * fino a `until`. Altrimenti CalendarUnavailableError('horizon_insufficient'):
 * mai decidere su un intervallo che l'indice non copre.
 */
export async function assertHorizonCovers(db: Db, until: Date, calendarIds?: string[]): Promise<void> {
  if (!Number.isFinite(until.getTime())) throw new TypeError('assertHorizonCovers: istante non valido');
  const short = await collectionsShortOf(db, until, calendarIds);
  if (short.length === 0) return;
  const neverIndexed = short.filter((r) => !r.has_state || r.horizon_end === null).length;
  throw new CalendarUnavailableError(
    'horizon_insufficient',
    `${short.length} collezioni bloccanti senza orizzonte fino a ${until.toISOString()}${neverIndexed ? ` (${neverIndexed} mai indicizzate)` : ''}`,
  );
}
