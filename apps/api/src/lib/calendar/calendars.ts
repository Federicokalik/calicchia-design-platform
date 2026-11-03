/**
 * Facade dei calendari: stesse esportazioni e firme di prima della fase F2,
 * delegate allo store selezionato dal modo del backend (store.ts; design §12
 * "Facade"). In mode postgres lo store è PgLegacyStore, cioè il codice di
 * prima spostato in legacy/calendars-pg.ts: il comportamento non cambia.
 *
 * Mono-utente Federico: tutti i calendari sono di sua proprietà. I calendari
 * di sistema (is_system=true) come 'bookings' e 'scadenze' non sono
 * eliminabili dall'admin (DELETE blocca con 422).
 *
 * Funzioni pure (indipendenti dallo store): isValidTimeZone (validation.ts) e
 * buildFeedUrl (qui).
 */

import { publicApiUrl } from '../public-url';
import { calendarStore, calendarStoreForWrite } from './store';
import type { Calendar, ClosuresView, CreateCalendarInput, UpdateCalendarInput } from './types';

export { CalendarConflictError, CalendarSystemError, CalendarValidationError } from './errors';
export { isValidTimeZone } from './validation';

export async function listCalendars(): Promise<Calendar[]> {
  return (await calendarStore()).listCalendars();
}

export async function getCalendar(idOrSlug: string): Promise<Calendar | null> {
  return (await calendarStore()).getCalendar(idOrSlug);
}

export async function getCalendarByFeedToken(token: string): Promise<Calendar | null> {
  return (await calendarStore()).getCalendarByFeedToken(token);
}

/** Calendario di default — usato come fallback quando un evento non specifica calendar_id */
export async function getDefaultCalendar(): Promise<Calendar | null> {
  return (await calendarStore()).getDefaultCalendar();
}

/** Calendario 'bookings' (is_system) — destinazione per eventi auto-creati da prenotazioni */
export async function getBookingsCalendar(): Promise<Calendar | null> {
  return (await calendarStore()).getBookingsCalendar();
}

/**
 * Calendario "Festività e chiusure": lo trova (anche col vecchio nome
 * "Festività" o con lo slug di produzione 'f') o lo crea. Passa dal percorso
 * di scrittura perché può creare la riga. Condiviso da cron/italian-holidays.ts
 * e dalle route /closures.
 */
export async function getOrCreateFestivitaCalendar(): Promise<Calendar> {
  return (await calendarStoreForWrite()).getOrCreateFestivitaCalendar();
}

export async function createCalendar(input: CreateCalendarInput): Promise<Calendar> {
  return (await calendarStoreForWrite()).createCalendar(input);
}

export async function updateCalendar(id: string, input: UpdateCalendarInput): Promise<Calendar | null> {
  return (await calendarStoreForWrite()).updateCalendar(id, input);
}

export async function deleteCalendar(id: string): Promise<void> {
  return (await calendarStoreForWrite()).deleteCalendar(id);
}

export async function rotateFeedToken(id: string): Promise<Calendar | null> {
  return (await calendarStoreForWrite()).rotateFeedToken(id);
}

/**
 * Eventi non cancellati per calendario (override compresi): event_count di
 * GET /api/admin/calendar/calendars e del tool list_calendars.
 */
export async function countEventsByCalendar(): Promise<Map<string, number>> {
  return (await calendarStore()).countEventsByCalendar();
}

/**
 * Chiusure per GET /api/admin/calendar/closures. Con PgLegacyStore crea il
 * calendario festività se manca, come prima; lo store Radicale no (design §7).
 */
export async function listClosures(): Promise<ClosuresView> {
  return (await calendarStore()).listClosures();
}

/**
 * Costruisce l'URL pubblico ICS feed per un calendario.
 * Es. https://api.calicchia.design/api/calendar/feed/abc123def456...ics
 */
export function buildFeedUrl(calendar: Calendar, baseUrl?: string): string {
  const base = baseUrl || publicApiUrl();
  return `${base}/api/calendar/feed/${calendar.ics_feed_token}.ics`;
}
