/**
 * Capacità settimanale (ore disponibili, minuti usati da time entry,
 * prenotazioni ed eventi del calendario) per la dashboard, il filtro degli
 * slot e la sezione critica delle prenotazioni.
 *
 * Fase F2 del passaggio a Radicale (design §7 "Capacity", §9; contratto dei
 * moduli docs/calendar-radicale/contracts/f2-modules.md §7.2): stesse
 * esportazioni e firme di prima, con `opts` in coda (`db` e `level`).
 * Dentro la sezione critica di una prenotazione si passa la tx: time entry e
 * prenotazioni si leggono con la stessa connessione (prima servivano due
 * connessioni per prenotazione, e la riprogrammazione vedeva ancora come
 * confermata la prenotazione che stava annullando).
 *
 * Minuti del calendario, per store:
 *  - postgres (oggi e in cutover): algoritmo di prima, occorrenze legacy
 *    espanse dei calendari bloccanti, festività riconosciuta per slug o nome
 *    come in getOrCreateFestivitaCalendar (parità: la correzione "per ruolo"
 *    del design §14 esce con lo store Radicale);
 *  - radicale: una sola aggregazione SQL sull'indice per tutte le settimane
 *    richieste, con le esclusioni di oggi (proiezioni `source='booking'`,
 *    festività `source='system'`, calendario role='holidays', all-day, eventi
 *    non confermati) più quelle che il modello legacy non poteva esprimere
 *    (TRANSP:TRANSPARENT e VTODO, cioè `blocks` falso) e i blocchi
 *    conservativi degli oggetti illeggibili (già sottratti dagli slot dal busy:
 *    contarli qui azzererebbe la capacità di settimane intere per un solo
 *    oggetto rotto). Bucket per source come oggi. I flag dei calendari sono
 *    quelli della query di busy (design §7): un'iscrizione conta solo se
 *    bloccano sia lei sia il calendario di destinazione.
 *
 * Confini delle settimane: come oggi (date_trunc della settimana a Roma,
 * +7 giorni); la correzione dei confini dopo il cambio dell'ora è un test.todo
 * del contratto capacity-and-slots e uscirà in una release separata.
 */

import { sql } from '../../db';
import { readBackendStateFresh, readStoreKind, storeKindForMode, storeKindOverride, type CalendarStoreKind } from './backend-mode';
import type { BusyLevel } from './busy';
import type { Db } from './radicale/policy';
import { getPgLegacyStore } from './store';
import type { Slot } from './types';

export interface CapacityWeekUsage {
  weekStartIso: string;
  weekEndIso: string;
  hoursAvailable: number;
  minutesUsed: number;
  minutesRemaining: number;
  timeEntryMinutes: number;
  timeEntryCount: number;
  bookingMinutes: number;
  bookingCount: number;
  calendarMinutes: number;
  calendarBySource: Record<string, { minutes: number; count: number }>;
  runningTimers: number;
}

export interface CapacityOptions {
  /** Connessione o transazione del chiamante (default pool principale); nella sezione critica la tx della prenotazione. */
  db?: Db;
  /**
   * 'decision' rilegge il modo senza cache con `db` (sezione critica);
   * default 'display' (modo in cache per 2 s).
   */
  level?: BusyLevel;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function overlapMinutes(startIso: string, endIso: string, fromIso: string, toIsoValue: string): number {
  const start = Math.max(new Date(startIso).getTime(), new Date(fromIso).getTime());
  const end = Math.min(new Date(endIso).getTime(), new Date(toIsoValue).getTime());
  return Math.max(0, Math.round((end - start) / 60_000));
}

export async function getWeeklyCapacityHours(db: Db = sql): Promise<number> {
  const rows = await db<Array<{ hours: number | string | null }>>`
    SELECT (value->>'weekly_capacity_hours')::int AS hours
    FROM site_settings WHERE key = 'freelancer.studio' LIMIT 1
  `;
  const hours = Number(rows[0]?.hours ?? 40);
  return Number.isFinite(hours) && hours >= 0 ? hours : 40;
}

async function getWeekBounds(fromIso: string, toIsoValue: string, db: Db): Promise<Array<{ start: string; end: string }>> {
  const rows = await db<Array<{ week_start: string | Date; week_end: string | Date }>>`
    SELECT
      gs AS week_start,
      gs + INTERVAL '7 days' AS week_end
    FROM generate_series(
      date_trunc('week', ${fromIso}::timestamptz AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome',
      date_trunc('week', ${toIsoValue}::timestamptz AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome',
      INTERVAL '7 days'
    ) AS gs
  `;
  return rows.map((row) => ({ start: toIso(row.week_start), end: toIso(row.week_end) }));
}

/** Store dei minuti del calendario: modo in cache per la visualizzazione, riletto con `db` nelle decisioni. */
async function capacityStoreKind(db: Db, level: BusyLevel): Promise<CalendarStoreKind> {
  const forced = storeKindOverride();
  if (forced) return forced;
  if (level === 'decision') return storeKindForMode((await readBackendStateFresh(db)).mode);
  return readStoreKind(db);
}

type CalendarUsage = { minutes: number; bySource: Record<string, { minutes: number; count: number }> };

/**
 * Minuti del calendario per settimana con l'algoritmo legacy (store
 * postgres): occorrenze espanse dei calendari bloccanti, filtrate in memoria.
 * Il codice legacy legge dal pool principale.
 */
async function legacyCalendarUsage(weeks: Array<{ start: string; end: string }>, db: Db): Promise<CalendarUsage[]> {
  // Il calendario "Festività e chiusure" rappresenta INDISPONIBILITÀ (festività
  // auto, ferie/ponti), non carico di lavoro: i suoi eventi timed 24h/multi-day
  // sono già sottratti dagli slot come busy. Contarli anche qui azzererebbe la
  // capacity dell'intera settimana (es. chiusura 3gg = 72h > 40h) bloccando
  // pure i giorni aperti.
  // Stesso criterio di getOrCreateFestivitaCalendar: in prod il calendario
  // esiste con slug abbreviato ('f'), il match affidabile è sul nome.
  const [festivita] = await db<Array<{ id: string }>>`
    SELECT id FROM calendars
    WHERE slug = 'festivita' OR lower(name) IN ('festività', 'festività e chiusure')
    ORDER BY created_at ASC
    LIMIT 1
  `;
  const legacy = getPgLegacyStore();
  const out: CalendarUsage[] = [];
  // Una settimana alla volta, come prima: in parallelo un intervallo lungo
  // terrebbe molte connessioni del pool mentre la sezione critica ne tiene una.
  for (const week of weeks) {
    const occurrences = await legacy.listOccurrences({ fromIso: week.start, toIso: week.end, blockingOnly: true });
    const bySource: Record<string, { minutes: number; count: number }> = {};
    let minutes = 0;
    for (const occurrence of occurrences) {
      if (occurrence.status !== 'confirmed' || occurrence.all_day || occurrence.source === 'booking') continue;
      if (occurrence.source === 'system' || (festivita && occurrence.calendar_id === festivita.id)) continue;
      const m = overlapMinutes(occurrence.start_time, occurrence.end_time, week.start, week.end);
      if (m <= 0) continue;
      minutes += m;
      const bucket = bySource[occurrence.source] ?? { minutes: 0, count: 0 };
      bucket.minutes += m;
      bucket.count += 1;
      bySource[occurrence.source] = bucket;
    }
    out.push({ minutes, bySource });
  }
  return out;
}

/**
 * Minuti del calendario per settimana dall'indice (store Radicale): una sola
 * query per tutte le settimane. Per ogni occorrenza i minuti di
 * sovrapposizione con la settimana, arrotondati come overlapMinutes; contano
 * solo quelle con almeno un minuto. I bucket per source escono nell'ordine
 * della loro prima occorrenza della settimana, come nell'algoritmo legacy
 * (che li riempie scorrendo le occorrenze per inizio): l'ordine di
 * `breakdown` nella risposta di capacity-week resta quello di oggi.
 */
async function indexCalendarUsage(weeks: Array<{ start: string; end: string }>, db: Db): Promise<CalendarUsage[]> {
  const out: CalendarUsage[] = weeks.map(() => ({ minutes: 0, bySource: {} }));
  if (weeks.length === 0) return out;
  const starts = weeks.map((w) => w.start);
  const ends = weeks.map((w) => w.end);
  const rows = await db<Array<{ idx: number; source: string; minutes: number; count: number }>>`
    WITH weeks AS (
      SELECT (w.ord - 1)::int AS idx, w.week_start, w.week_end
      FROM unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) WITH ORDINALITY AS w(week_start, week_end, ord)
    ),
    occ AS (
      -- La provenienza dell'oggetto con una lettura per chiave primaria per
      -- ogni occorrenza della finestra (LATERAL con OFFSET 0: il planner non
      -- la trasforma in un join). Con le statistiche ancora quelle di una
      -- tabella quasi vuota (subito dopo un import o un rebuild, prima
      -- dell'ANALYZE) un join normale finiva in un nested loop con la
      -- scansione intera di cal_objects per ogni occorrenza: /slots oltre 1 s.
      SELECT o.start_utc, o.end_utc, ob.source
      FROM cal_occurrences o
      CROSS JOIN LATERAL (SELECT x.source FROM cal_objects x WHERE x.id = o.object_id OFFSET 0) ob
      JOIN calendars c ON c.id = o.calendar_id
      LEFT JOIN calendars p ON p.id = c.parent_calendar_id
      LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
      WHERE o.blocks
        AND NOT o.all_day
        AND o.status = 'confirmed'
        AND o.kind <> 'conservative'
        AND ob.source NOT IN ('booking', 'system')
        AND c.role <> 'holidays'
        AND CASE WHEN c.role = 'subscription'
                 THEN COALESCE(s.blocks_availability, false) AND COALESCE(p.blocks_availability, false)
                 ELSE c.blocks_availability END
        AND o.span && tstzrange((SELECT min(week_start) FROM weeks), (SELECT max(week_end) FROM weeks), '[)')
    ),
    per_week AS (
      SELECT w.idx, occ.source, occ.start_utc,
             round(extract(epoch FROM (LEAST(occ.end_utc, w.week_end) - GREATEST(occ.start_utc, w.week_start))) / 60) AS minutes
      FROM weeks w
      JOIN occ ON occ.start_utc < w.week_end AND occ.end_utc > w.week_start
    )
    SELECT idx, source, SUM(minutes)::int AS minutes, COUNT(*)::int AS count
    FROM per_week
    WHERE minutes > 0
    GROUP BY idx, source
    ORDER BY idx, MIN(start_utc), source
  `;
  for (const row of rows) {
    const usage = out[row.idx];
    if (!usage) continue;
    const minutes = Number(row.minutes);
    usage.minutes += minutes;
    usage.bySource[row.source] = { minutes, count: Number(row.count) };
  }
  return out;
}

export async function getCapacityWeeks(fromIso: string, toIsoValue: string, opts: CapacityOptions = {}): Promise<CapacityWeekUsage[]> {
  const db = opts.db ?? sql;
  const level: BusyLevel = opts.level ?? 'display';
  const hoursAvailable = await getWeeklyCapacityHours(db);
  const weeks = await getWeekBounds(fromIso, toIsoValue, db);
  const kind = await capacityStoreKind(db, level);
  const calendar = kind === 'postgres' ? await legacyCalendarUsage(weeks, db) : await indexCalendarUsage(weeks, db);

  const results: CapacityWeekUsage[] = [];
  for (const [i, week] of weeks.entries()) {
    const [timeRows, bookingRows] = await Promise.all([
      db<Array<{ minutes: number | string; entries_count: number | string; running_count: number | string }>>`
        SELECT
          COALESCE(SUM(EXTRACT(EPOCH FROM (
            LEAST(end_time, ${week.end}::timestamptz) - GREATEST(start_time, ${week.start}::timestamptz)
          )) / 60), 0)::int AS minutes,
          COUNT(*) FILTER (WHERE end_time IS NOT NULL)::int AS entries_count,
          COUNT(*) FILTER (WHERE end_time IS NULL)::int AS running_count
        FROM time_entries
        WHERE start_time < ${week.end}::timestamptz
          AND COALESCE(end_time, start_time) > ${week.start}::timestamptz
      `,
      db<Array<{ minutes: number | string; count: number | string }>>`
        SELECT
          COALESCE(SUM(EXTRACT(EPOCH FROM (
            LEAST(end_time, ${week.end}::timestamptz) - GREATEST(start_time, ${week.start}::timestamptz)
          )) / 60), 0)::int AS minutes,
          COUNT(*)::int AS count
        FROM calendar_bookings
        WHERE status IN ('confirmed', 'pending')
          AND start_time < ${week.end}::timestamptz
          AND end_time > ${week.start}::timestamptz
      `,
    ]);

    const calendarMinutes = calendar[i]?.minutes ?? 0;
    const calendarBySource = calendar[i]?.bySource ?? {};
    const timeEntryMinutes = Number(timeRows[0]?.minutes ?? 0);
    const bookingMinutes = Number(bookingRows[0]?.minutes ?? 0);
    const minutesUsed = timeEntryMinutes + bookingMinutes + calendarMinutes;
    const capacityMinutes = hoursAvailable * 60;

    results.push({
      weekStartIso: week.start,
      weekEndIso: week.end,
      hoursAvailable,
      minutesUsed,
      minutesRemaining: Math.max(0, capacityMinutes - minutesUsed),
      timeEntryMinutes,
      timeEntryCount: Number(timeRows[0]?.entries_count ?? 0),
      bookingMinutes,
      bookingCount: Number(bookingRows[0]?.count ?? 0),
      calendarMinutes,
      calendarBySource,
      runningTimers: Number(timeRows[0]?.running_count ?? 0),
    });
  }

  return results;
}

export async function hasWeeklyCapacityForBooking(startIso: string, durationMinutes: number, opts: CapacityOptions = {}): Promise<boolean> {
  const startMs = new Date(startIso).getTime();
  if (isNaN(startMs)) return false;
  const endIso = new Date(startMs + durationMinutes * 60_000).toISOString();
  const weeks = await getCapacityWeeks(startIso, endIso, opts);
  return weeks.every((week) => {
    const minutesInWeek = overlapMinutes(startIso, endIso, week.weekStartIso, week.weekEndIso);
    return week.minutesUsed + minutesInWeek <= week.hoursAvailable * 60;
  });
}

export async function filterSlotsByWeeklyCapacity(slots: Slot[], _durationMinutes: number, opts: CapacityOptions = {}): Promise<Slot[]> {
  if (slots.length === 0) return slots;
  const fromIso = slots[0].start;
  const toIsoValue = slots[slots.length - 1].end;
  const weeks = await getCapacityWeeks(fromIso, toIsoValue, opts);
  return slots.filter((slot) => {
    return weeks.every((week) => {
      const minutesInWeek = overlapMinutes(slot.start, slot.end, week.weekStartIso, week.weekEndIso);
      if (minutesInWeek <= 0) return true;
      return week.minutesUsed + minutesInWeek <= week.hoursAvailable * 60;
    });
  });
}
