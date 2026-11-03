/**
 * Facade a due store del calendario (fase F2 del passaggio a Radicale;
 * design §2, §12 "Facade", §13.1; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §1).
 *
 * - CalendarStore: le firme pubbliche di oggi di events.ts, calendars.ts e
 *   subscriptions.ts. Le facade (quei tre moduli) mantengono nomi ed
 *   esportazioni e delegano qui, quindi nessun import del resto del codice
 *   cambia.
 * - PgLegacyStore: il codice di prima, spostato senza modifiche in legacy/.
 *   È lo store di mode postgres (la produzione dopo il deploy della F2) e di
 *   cutover.
 * - RadicaleStore (radicale/store.ts): store di mode radicale, rollback e
 *   finalized. Finché non è implementato lancia CalendarStoreUnavailableError.
 *
 * Selezione (backend-mode.ts): letture con il modo in cache per 2 s,
 * scritture con il modo riletto senza cache e 503 in cutover e rollback. In
 * mode postgres il comportamento è quello di oggi: stesse query, stessi
 * errori, stessi risultati (i contratti F0 lo verificano).
 *
 * Override per i test: overrideCalendarStore('radicale' | 'postgres' | store).
 */

import {
  type CalendarStoreKind,
  overrideStoreKind,
  readStoreKind,
  resolveWriteStoreKind,
} from './backend-mode';
import type { ParsedEvent } from './ics-import';
import * as calendarsPg from './legacy/calendars-pg';
import * as eventsPg from './legacy/events-pg';
import * as subscriptionsPg from './legacy/subscriptions-pg';
import { getRadicaleStore } from './radicale/store';
import type {
  BusyRange,
  Calendar,
  CalendarEvent,
  CalendarEventOccurrence,
  CalendarFeedOptions,
  CalendarFeedResult,
  CalendarSubscription,
  ClosuresView,
  CreateCalendarInput,
  CreateEventInput,
  CreateOccurrenceOverrideInput,
  CreateSubscriptionInput,
  ListEventsOptions,
  SyncResult,
  UpdateCalendarInput,
  UpdateEventInput,
  UpdateSubscriptionInput,
} from './types';

export type { CalendarStoreKind } from './backend-mode';

// ─── Interfaccia ───────────────────────────────

/** Eventi: firme di events.ts, più il feed ICS portato sullo store nella F2. */
export interface CalendarEventsStore {
  getEvent(idOrUid: string): Promise<CalendarEvent | null>;
  getEventBySource(source: string, sourceId: string): Promise<CalendarEvent | null>;
  createEvent(input: CreateEventInput): Promise<CalendarEvent>;
  updateEvent(id: string, input: UpdateEventInput): Promise<CalendarEvent | null>;
  deleteEvent(id: string): Promise<boolean>;
  createOccurrenceOverride(opts: CreateOccurrenceOverrideInput): Promise<CalendarEvent>;
  listOccurrences(opts: ListEventsOptions): Promise<CalendarEventOccurrence[]>;
  getBusyRanges(fromIso: string, toIso: string): Promise<BusyRange[]>;
  listEventsForCollection(calendarId: string): Promise<CalendarEvent[]>;
  getEventOverrides(masterId: string): Promise<CalendarEvent[]>;
  /** Feed ICS pubblico di un calendario (prima: query inline in routes/calendar/feed.ts). */
  buildCalendarFeed(calendar: Calendar, opts: CalendarFeedOptions): Promise<CalendarFeedResult>;
}

/**
 * Calendari: firme di calendars.ts (le funzioni pure restano nella facade),
 * più le letture dei consumatori portate sullo store nella F2.
 */
export interface CalendarsStore {
  listCalendars(): Promise<Calendar[]>;
  getCalendar(idOrSlug: string): Promise<Calendar | null>;
  getCalendarByFeedToken(token: string): Promise<Calendar | null>;
  getDefaultCalendar(): Promise<Calendar | null>;
  getBookingsCalendar(): Promise<Calendar | null>;
  getOrCreateFestivitaCalendar(): Promise<Calendar>;
  createCalendar(input: CreateCalendarInput): Promise<Calendar>;
  updateCalendar(id: string, input: UpdateCalendarInput): Promise<Calendar | null>;
  deleteCalendar(id: string): Promise<void>;
  rotateFeedToken(id: string): Promise<Calendar | null>;
  /**
   * Eventi non cancellati per calendario, con la semantica legacy di
   * event_count (prima: query inline in routes/calendar/admin.ts e nel tool
   * list_calendars).
   */
  countEventsByCalendar(): Promise<Map<string, number>>;
  /** Chiusure per GET /closures (prima: query inline in routes/calendar/admin.ts). */
  listClosures(): Promise<ClosuresView>;
}

/** Iscrizioni: firme di subscriptions.ts. */
export interface SubscriptionsStore {
  listSubscriptions(): Promise<CalendarSubscription[]>;
  getSubscription(id: string): Promise<CalendarSubscription | null>;
  createSubscription(input: CreateSubscriptionInput): Promise<CalendarSubscription>;
  updateSubscription(id: string, input: UpdateSubscriptionInput): Promise<CalendarSubscription | null>;
  deleteSubscription(id: string): Promise<boolean>;
  syncSubscription(id: string, opts?: { force?: boolean }): Promise<SyncResult>;
  replaceSubscriptionEvents(
    subscriptionId: string,
    calendarId: string,
    parsed: ParsedEvent[],
    opts?: { allowEmpty?: boolean },
  ): Promise<{ inserted: number; removed: number }>;
  syncAllSubscriptions(): Promise<{ total: number; ok: number; failed: number; notModified: number }>;
}

/**
 * Uno store del calendario: le firme pubbliche della facade di prima della F2,
 * più tre letture che i consumatori facevano con SQL inline su
 * calendar_events (countEventsByCalendar, listClosures, buildCalendarFeed).
 */
export interface CalendarStore extends CalendarEventsStore, CalendarsStore, SubscriptionsStore {
  readonly kind: CalendarStoreKind;
}

/** Nomi delle operazioni di CalendarStore (utile a stub, test e log). */
export const CALENDAR_STORE_OPERATIONS = [
  'getEvent', 'getEventBySource', 'createEvent', 'updateEvent', 'deleteEvent', 'createOccurrenceOverride',
  'listOccurrences', 'getBusyRanges', 'listEventsForCollection', 'getEventOverrides', 'buildCalendarFeed',
  'listCalendars', 'getCalendar', 'getCalendarByFeedToken', 'getDefaultCalendar', 'getBookingsCalendar',
  'getOrCreateFestivitaCalendar', 'createCalendar', 'updateCalendar', 'deleteCalendar', 'rotateFeedToken',
  'countEventsByCalendar', 'listClosures',
  'listSubscriptions', 'getSubscription', 'createSubscription', 'updateSubscription', 'deleteSubscription',
  'syncSubscription', 'replaceSubscriptionEvents', 'syncAllSubscriptions',
] as const satisfies readonly Exclude<keyof CalendarStore, 'kind'>[];
export type CalendarStoreOperation = (typeof CALENDAR_STORE_OPERATIONS)[number];

/**
 * Operazioni che scrivono (o possono scrivere: getOrCreateFestivitaCalendar
 * crea il calendario se manca, le sync delle iscrizioni scrivono gli eventi).
 * Passano da calendarStoreForWrite(): modo riletto senza cache, 503 in
 * cutover e rollback.
 */
export const CALENDAR_STORE_WRITE_OPERATIONS: ReadonlySet<CalendarStoreOperation> = new Set<CalendarStoreOperation>([
  'createEvent', 'updateEvent', 'deleteEvent', 'createOccurrenceOverride',
  'getOrCreateFestivitaCalendar', 'createCalendar', 'updateCalendar', 'deleteCalendar', 'rotateFeedToken',
  'createSubscription', 'updateSubscription', 'deleteSubscription', 'syncSubscription',
  'replaceSubscriptionEvents', 'syncAllSubscriptions',
]);

// ─── PgLegacyStore ───────────────────────────────

/**
 * Store legacy su calendar_events: delega al codice spostato in legacy/
 * senza modifiche. Nessuna logica propria, così il comportamento in mode
 * postgres resta quello della baseline F0.
 */
export class PgLegacyStore implements CalendarStore {
  readonly kind = 'postgres' as const;

  getEvent(idOrUid: string) { return eventsPg.getEvent(idOrUid); }
  getEventBySource(source: string, sourceId: string) { return eventsPg.getEventBySource(source, sourceId); }
  createEvent(input: CreateEventInput) { return eventsPg.createEvent(input); }
  updateEvent(id: string, input: UpdateEventInput) { return eventsPg.updateEvent(id, input); }
  deleteEvent(id: string) { return eventsPg.deleteEvent(id); }
  createOccurrenceOverride(opts: CreateOccurrenceOverrideInput) { return eventsPg.createOccurrenceOverride(opts); }
  listOccurrences(opts: ListEventsOptions) { return eventsPg.listOccurrences(opts); }
  getBusyRanges(fromIso: string, toIso: string) { return eventsPg.getBusyRanges(fromIso, toIso); }
  listEventsForCollection(calendarId: string) { return eventsPg.listEventsForCollection(calendarId); }
  getEventOverrides(masterId: string) { return eventsPg.getEventOverrides(masterId); }
  buildCalendarFeed(calendar: Calendar, opts: CalendarFeedOptions) { return eventsPg.buildCalendarFeed(calendar, opts); }

  listCalendars() { return calendarsPg.listCalendars(); }
  getCalendar(idOrSlug: string) { return calendarsPg.getCalendar(idOrSlug); }
  getCalendarByFeedToken(token: string) { return calendarsPg.getCalendarByFeedToken(token); }
  getDefaultCalendar() { return calendarsPg.getDefaultCalendar(); }
  getBookingsCalendar() { return calendarsPg.getBookingsCalendar(); }
  getOrCreateFestivitaCalendar() { return calendarsPg.getOrCreateFestivitaCalendar(); }
  createCalendar(input: CreateCalendarInput) { return calendarsPg.createCalendar(input); }
  updateCalendar(id: string, input: UpdateCalendarInput) { return calendarsPg.updateCalendar(id, input); }
  deleteCalendar(id: string) { return calendarsPg.deleteCalendar(id); }
  rotateFeedToken(id: string) { return calendarsPg.rotateFeedToken(id); }
  countEventsByCalendar() { return calendarsPg.countEventsByCalendar(); }
  listClosures() { return calendarsPg.listClosures(); }

  listSubscriptions() { return subscriptionsPg.listSubscriptions(); }
  getSubscription(id: string) { return subscriptionsPg.getSubscription(id); }
  createSubscription(input: CreateSubscriptionInput) { return subscriptionsPg.createSubscription(input); }
  updateSubscription(id: string, input: UpdateSubscriptionInput) { return subscriptionsPg.updateSubscription(id, input); }
  deleteSubscription(id: string) { return subscriptionsPg.deleteSubscription(id); }
  syncSubscription(id: string, opts: { force?: boolean } = {}) { return subscriptionsPg.syncSubscription(id, opts); }
  replaceSubscriptionEvents(subscriptionId: string, calendarId: string, parsed: ParsedEvent[], opts: { allowEmpty?: boolean } = {}) {
    return subscriptionsPg.replaceSubscriptionEvents(subscriptionId, calendarId, parsed, opts);
  }
  syncAllSubscriptions() { return subscriptionsPg.syncAllSubscriptions(); }
}

const pgLegacyStore = new PgLegacyStore();

/** Istanza di PgLegacyStore del processo. */
export function getPgLegacyStore(): PgLegacyStore {
  return pgLegacyStore;
}

// ─── Selezione ───────────────────────────────

let instanceOverride: CalendarStore | null = null;

function storeOfKind(kind: CalendarStoreKind): CalendarStore {
  return kind === 'postgres' ? pgLegacyStore : getRadicaleStore();
}

/**
 * Store per le letture di visualizzazione (modo in cache per 2 s). Lancia
 * CalendarUnavailableError solo se lo stato non si è mai potuto leggere.
 */
export async function calendarStore(): Promise<CalendarStore> {
  if (instanceOverride) return instanceOverride;
  return storeOfKind(await readStoreKind());
}

/**
 * Store per le scritture: modo riletto senza cache; CalendarUnavailableError
 * (503) in cutover, rollback, con write_freeze sullo store Radicale o con lo
 * stato illeggibile. In mode postgres restituisce PgLegacyStore come oggi.
 */
export async function calendarStoreForWrite(): Promise<CalendarStore> {
  if (instanceOverride) return instanceOverride;
  return storeOfKind(await resolveWriteStoreKind());
}

/**
 * Forza lo store (solo test): un tipo ('postgres' | 'radicale') vale anche
 * per backend-mode.ts e quindi per il busy; un'istanza sostituisce lo store
 * della facade (per esempio uno store finto che registra le chiamate). null
 * toglie entrambi gli override. Vietato con NODE_ENV=production.
 */
export function overrideCalendarStore(value: CalendarStoreKind | CalendarStore | null): void {
  if (value !== null && process.env.NODE_ENV === 'production') {
    throw new Error('overrideCalendarStore: override dello store vietato in produzione');
  }
  if (value === null) {
    instanceOverride = null;
    overrideStoreKind(null);
  } else if (typeof value === 'string') {
    instanceOverride = null;
    overrideStoreKind(value);
  } else {
    instanceOverride = value;
    overrideStoreKind(value.kind);
  }
}
