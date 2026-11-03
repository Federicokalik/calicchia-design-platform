/**
 * Facade degli eventi del calendario: stesse esportazioni e firme di prima
 * della fase F2 (CRUD, override, espansione delle ricorrenze, busy, risorse
 * CalDAV legacy), delegate allo store selezionato dal modo del backend
 * (store.ts; design §12 "Facade").
 *
 * - Letture: store in cache per 2 s (calendarStore()).
 * - Scritture: modo riletto senza cache (calendarStoreForWrite()), 503
 *   CALENDAR_UNAVAILABLE in cutover e rollback.
 *
 * In mode postgres lo store è PgLegacyStore, cioè il codice di prima spostato
 * in legacy/events-pg.ts: il comportamento non cambia. Pattern RRULE/override
 * legacy (master con rrule, override con recurrence_master_id e
 * recurrence_id, exdates JSONB) documentato in legacy/events-pg.ts.
 */

import { calendarStore, calendarStoreForWrite } from './store';
import type {
  BusyRange,
  Calendar,
  CalendarEvent,
  CalendarEventOccurrence,
  CalendarFeedOptions,
  CalendarFeedResult,
  CreateEventInput,
  CreateOccurrenceOverrideInput,
  ListEventsOptions,
  UpdateEventInput,
} from './types';

export { EventReadOnlyError, EventValidationError } from './errors';
export type {
  BusyRange,
  CalendarFeedOptions,
  CalendarFeedResult,
  CreateOccurrenceOverrideInput,
  ListEventsOptions,
  UpdateEventInput,
} from './types';
/** ETag CalDAV legacy di una riga di calendar_events (funzione pura, indipendente dallo store). */
export { caldavEtag } from './legacy/events-pg';

// ============================================
// CRUD base
// ============================================

export async function getEvent(idOrUid: string): Promise<CalendarEvent | null> {
  return (await calendarStore()).getEvent(idOrUid);
}

export async function getEventBySource(source: string, sourceId: string): Promise<CalendarEvent | null> {
  return (await calendarStore()).getEventBySource(source, sourceId);
}

export async function createEvent(input: CreateEventInput): Promise<CalendarEvent> {
  return (await calendarStoreForWrite()).createEvent(input);
}

export async function updateEvent(id: string, input: UpdateEventInput): Promise<CalendarEvent | null> {
  return (await calendarStoreForWrite()).updateEvent(id, input);
}

export async function deleteEvent(id: string): Promise<boolean> {
  return (await calendarStoreForWrite()).deleteEvent(id);
}

/**
 * Crea (o aggiorna) l'override di una singola occorrenza di un master
 * ricorrente: "modifica/cancella solo questa occorrenza".
 */
export async function createOccurrenceOverride(opts: CreateOccurrenceOverrideInput): Promise<CalendarEvent> {
  return (await calendarStoreForWrite()).createOccurrenceOverride(opts);
}

// ============================================
// Espansione ricorrenze
// ============================================

/**
 * Eventi (master, singoli, override) espansi in occorrenze concrete nel range
 * richiesto, ordinati per start_time.
 */
export async function listOccurrences(opts: ListEventsOptions): Promise<CalendarEventOccurrence[]> {
  return (await calendarStore()).listOccurrences(opts);
}

// ============================================
// Busy (livello visualizzazione: find_free_slots MCP). Le decisioni di
// prenotazione usano busy.ts, che rilegge il modo senza cache.
// ============================================

export async function getBusyRanges(fromIso: string, toIso: string): Promise<BusyRange[]> {
  return (await calendarStore()).getBusyRanges(fromIso, toIso);
}

// ============================================
// CalDAV legacy: una risorsa = un UID (master + override), senza espansione.
// ============================================

/** Risorse (master e singoli, senza override e cancellati) di un calendario. */
export async function listEventsForCollection(calendarId: string): Promise<CalendarEvent[]> {
  return (await calendarStore()).listEventsForCollection(calendarId);
}

/** Override (occorrenze materializzate) di un master ricorrente. */
export async function getEventOverrides(masterId: string): Promise<CalendarEvent[]> {
  return (await calendarStore()).getEventOverrides(masterId);
}

// ============================================
// Feed ICS pubblico (GET /api/calendar/feed/:token.ics)
// ============================================

/**
 * Corpo (ed ETag, se lo store lo calcola) del feed ICS di un calendario. Con
 * PgLegacyStore è il feed di prima, senza ETag; con lo store Radicale si
 * genera dall'indice della collezione (design §10).
 */
export async function buildCalendarFeed(calendar: Calendar, opts: CalendarFeedOptions): Promise<CalendarFeedResult> {
  return (await calendarStore()).buildCalendarFeed(calendar, opts);
}
