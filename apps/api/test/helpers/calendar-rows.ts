/**
 * Effetti sul database degli eventi del calendario, letti in modo neutro
 * rispetto allo store (matrice CALENDAR_BACKEND, helpers/calendar-backend.ts).
 *
 * I contratti F0 registrano negli `effects` le righe di calendar_events (la
 * tabella dello store legacy) con le colonne che decidono il comportamento.
 * Con lo store Radicale quella tabella non viene scritta (design §1, §4: la
 * fonte è Radicale, in PG c'è solo l'indice derivato), quindi qui le stesse
 * righe si ricostruiscono dalla facade, cioè da ciò che RadicaleStore legge da
 * Radicale e dall'indice:
 *  - una "riga" = il DTO legacy della facade (getEvent, getEventOverrides,
 *    getEventBySource), con le stesse chiavi della SELECT legacy e il calendario
 *    come slug;
 *  - una posizione che non esiste più (oggetto cancellato, override rimosso,
 *    occorrenza esclusa con EXDATE) è assente, come una riga cancellata;
 *  - le proiezioni delle prenotazioni hanno la descrizione che vedono admin e
 *    MCP (ricomposta da calendar_bookings, design §12 "Proiezioni"), non quella
 *    della decisione 3 scritta per i device.
 *
 * Con lo store Postgres i contratti continuano a usare le loro SELECT su
 * calendar_events: questo modulo serve solo al ramo Radicale.
 */

import './env';
import { getEvent, getEventBySource, getEventOverrides } from '../../src/lib/calendar/events';
import { withProjectionDescriptions } from '../../src/lib/calendar/projection-descriptions';
import type { CalendarEvent } from '../../src/lib/calendar/types';
import { sql } from './db';

type Row = Record<string, unknown>;

/** Slug dei calendari per id (minuscolo), per la colonna `calendar` delle righe legacy. */
async function calendarSlugs(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (!unique.length) return new Map();
  const rows = await sql<Array<{ id: string; slug: string }>>`
    SELECT id::text AS id, slug FROM calendars WHERE id = ANY(${unique}::uuid[])
  `;
  return new Map(rows.map((r) => [r.id.toLowerCase(), r.slug]));
}

/** Riga con le colonne indicate (nell'ordine dato), dal DTO della facade. */
function pick(event: CalendarEvent, columns: readonly string[], slugs: Map<string, string>): Row {
  const source = event as unknown as Row;
  const row: Row = {};
  for (const column of columns) {
    row[column] = column === 'calendar' ? slugs.get(String(event.calendar_id).toLowerCase()) ?? null : source[column] ?? null;
  }
  return row;
}

/** Eventi della facade con la descrizione delle proiezioni come la vedono admin e MCP. */
async function asSeenByAdmin(events: CalendarEvent[]): Promise<CalendarEvent[]> {
  return withProjectionDescriptions(events, { force: true });
}

/** Righe per id, nell'ordine dato; le assenti come `{ id, deleted: true }` (come le SELECT legacy). */
export async function storeEventRows(ids: readonly string[], columns: readonly string[]): Promise<Row[]> {
  const events = await asSeenByAdmin((await Promise.all(ids.map((id) => getEvent(id)))).filter((e): e is CalendarEvent => !!e));
  const slugs = await calendarSlugs(events.map((e) => e.calendar_id));
  const byId = new Map(events.map((e) => [e.id.toLowerCase(), e]));
  return ids.map((id) => {
    const event = byId.get(id.toLowerCase());
    return event ? pick(event, columns, slugs) : { id, deleted: true };
  });
}

/** Posizioni vive (master, singoli, override) di una collezione, dalla tabella degli id persistenti. */
async function livePositions(calendarId: string): Promise<CalendarEvent[]> {
  const ids = await sql<Array<{ id: string }>>`
    SELECT id::text AS id FROM cal_object_ids
    WHERE calendar_id = ${calendarId}::uuid AND retired_at IS NULL
  `;
  const events = await Promise.all(ids.map((r) => getEvent(r.id)));
  return events.filter((e): e is CalendarEvent => !!e);
}

const time = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : Number.NEGATIVE_INFINITY);
const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/**
 * Tutte le posizioni di un calendario (master, singoli e override, anche
 * cancellati), ordinate come la SELECT legacy: inizio, override dopo il
 * master (recurrence_id NULLS FIRST), titolo.
 */
export async function storeCalendarEventRows(calendarId: string, columns: readonly string[]): Promise<Row[]> {
  const events = await asSeenByAdmin(await livePositions(calendarId));
  events.sort((a, b) =>
    time(a.start_time) - time(b.start_time)
    || (a.recurrence_id === null ? -1 : 0) - (b.recurrence_id === null ? -1 : 0)
    || time(a.recurrence_id) - time(b.recurrence_id)
    || text(a.summary).localeCompare(text(b.summary)));
  const slugs = await calendarSlugs(events.map((e) => e.calendar_id));
  return events.map((e) => pick(e, columns, slugs));
}

/** Override di una serie (anche cancellati), ordinati per recurrence_id. */
export async function storeOverrideRows(masterId: string, columns: readonly string[]): Promise<Row[]> {
  const overrides = await getEventOverrides(masterId);
  overrides.sort((a, b) => time(a.recurrence_id) - time(b.recurrence_id));
  const slugs = await calendarSlugs(overrides.map((e) => e.calendar_id));
  return overrides.map((e) => pick(e, columns, slugs));
}

/**
 * Proiezioni delle prenotazioni indicate: la risorsa booking-<uid>.ics della
 * collezione Prenotazioni, se esiste. Con lo store Radicale una prenotazione
 * annullata non ha più la risorsa (design §9: stato desiderato "assente"),
 * mentre la riga legacy restava con status 'cancelled'.
 */
export async function storeProjectionRows(bookingUids: readonly string[], columns: readonly string[]): Promise<Row[]> {
  const found = (await Promise.all(bookingUids.map((uid) => getEventBySource('booking', uid)))).filter((e): e is CalendarEvent => !!e);
  const events = await asSeenByAdmin(found);
  events.sort((a, b) => time(a.start_time) - time(b.start_time) || text(a.source_id).localeCompare(text(b.source_id)));
  const slugs = await calendarSlugs(events.map((e) => e.calendar_id));
  return events.map((e) => pick(e, columns, slugs));
}

/** Eventi di un'iscrizione (master, singoli e override del sidecar), ordinati per inizio e UID remoto. */
export async function storeSubscriptionEventRows(subscriptionId: string, columns: readonly string[]): Promise<Row[]> {
  const [link] = await sql<Array<{ collection_calendar_id: string | null }>>`
    SELECT collection_calendar_id::text AS collection_calendar_id FROM calendar_subscriptions WHERE id = ${subscriptionId}::uuid
  `;
  if (!link?.collection_calendar_id) return [];
  const events = await livePositions(link.collection_calendar_id);
  events.sort((a, b) => time(a.start_time) - time(b.start_time) || text(a.source_id).localeCompare(text(b.source_id)));
  const slugs = await calendarSlugs(events.map((e) => e.calendar_id));
  return events.map((e) => pick(e, columns, slugs));
}

/** Numero di posizioni (master, singoli, override) di un calendario nell'indice, comprese quelle cancellate. */
export async function storeCalendarEventCount(calendarId: string): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM cal_object_ids WHERE calendar_id = ${calendarId}::uuid AND retired_at IS NULL
  `;
  return row?.n ?? 0;
}
