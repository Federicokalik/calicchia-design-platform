/**
 * Fixture del dominio calendario, costruite con le funzioni di src/lib/calendar
 * ovunque esistano, così i dati hanno la stessa forma di quelli di produzione:
 *  - calendari: createCalendar (calendars.ts);
 *  - eventi, serie, override: createEvent e createOccurrenceOverride (events.ts);
 *  - festività: stessa logica del cron (cron/italian-holidays.ts, date-holidays);
 *  - chiusure: stesso calcolo di POST /api/admin/calendar/closures;
 *  - prenotazioni: createBooking (booking.ts) oppure INSERT diretto con la
 *    stessa riga e la stessa proiezione di createBooking, per i casi che
 *    non devono dipendere da "adesso" (min_notice, max_advance, capacità);
 *  - app-password: createAppPassword (caldav-passwords.ts);
 *  - iscrizioni: createSubscription + parseIcs + replaceSubscriptionEvents
 *    (subscriptions.ts, ics-import.ts), senza rete;
 *  - token MCP e device: stesso formato di generateMcpToken e di POST /api/device/pair.
 * Dove src/ non espone una funzione (tipi di prenotazione, schedule) l'INSERT
 * replica colonne e default della route admin corrispondente.
 *
 * Ogni dato porta il prefisso del gruppo (slug, nomi, titoli, email, label) o
 * viene registrato per id: `cleanup()` lo rimuove tutto. Con `useFixtures()`
 * la pulizia avviene sia prima (residui di un run interrotto) sia dopo i test.
 */

import './env';
import { createHash, randomUUID } from 'node:crypto';
import { fromZonedTime } from 'date-fns-tz';
import Holidays from 'date-holidays';
import { customAlphabet } from 'nanoid';
import { sql, sqlInsert } from '../../src/db';
import { getEventType } from '../../src/lib/calendar/availability';
import { createBooking } from '../../src/lib/calendar/booking';
import { createAppPassword, type CalDavAppPassword } from '../../src/lib/calendar/caldav-passwords';
import { createCalendar, getBookingsCalendar } from '../../src/lib/calendar/calendars';
import { createEvent, createOccurrenceOverride, getEventBySource } from '../../src/lib/calendar/events';
import { parseIcs, type ParsedEvent } from '../../src/lib/calendar/ics-import';
import { resolveLocationForBooking } from '../../src/lib/calendar/meeting-url';
import {
  createSubscription,
  getSubscription,
  replaceSubscriptionEvents,
  type CalendarSubscription,
} from '../../src/lib/calendar/subscriptions';
import type {
  AvailabilityOverride,
  AvailabilitySchedule,
  AvailabilitySlot,
  Booking,
  BookingSource,
  BookingStatus,
  Calendar,
  CalendarEvent,
  CalendarEventStatus,
  CreateBookingInput,
  CreateCalendarInput,
  CreateEventInput,
  CustomQuestion,
  EventType,
  LocationType,
} from '../../src/lib/calendar/types';
import { generateMcpToken } from '../../src/lib/mcp/tokens';
import {
  cleanupTestData,
  onBeforeDatabaseClose,
  onDatabaseReady,
  slugify,
  testPrefix,
  useTestDatabase,
  type CleanupReport,
  type TrackedRows,
} from './db';

// ─── Tempo ───────────────────────────────

export const ROME_TZ = 'Europe/Rome';

/** Istante UTC (ISO) dell'ora locale di Roma indicata: romeIso('2027-03-15', '09:30'). */
export function romeIso(date: string, time = '00:00'): string {
  const hhmmss = time.length === 5 ? `${time}:00` : time;
  return fromZonedTime(`${date}T${hhmmss}`, ROME_TZ).toISOString();
}

/** Mezzanotte UTC della data (forma degli all-day importati dalle iscrizioni ICS). */
export function utcMidnightIso(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/** Data (YYYY-MM-DD) spostata di `days` giorni di calendario. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ISO spostato di `minutes` minuti. */
export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

// ─── Disponibilità ───────────────────────────────

/** Fascia settimanale: day 0 = domenica … 6 = sabato, orari 'HH:MM'. */
export interface WeeklySlotInput {
  day: number;
  start: string;
  end: string;
}

/** Orario d'ufficio dello schedule seminato (migrazione 068): lun-ven 09-13 e 14-18. */
export const OFFICE_HOURS: readonly WeeklySlotInput[] = Object.freeze(
  [1, 2, 3, 4, 5].flatMap((day) => [
    { day, start: '09:00', end: '13:00' },
    { day, start: '14:00', end: '18:00' },
  ]),
);

export interface ScheduleOverrideInput {
  date: string;
  unavailable?: boolean;
  start?: string;
  end?: string;
  note?: string;
}

export interface ScheduleFixture {
  schedule: AvailabilitySchedule;
  slots: AvailabilitySlot[];
  overrides: AvailabilityOverride[];
}

// ─── Input delle fixture ───────────────────────────────

/** Riferimento a un calendario: la riga, un oggetto con id o l'id. */
export type CalendarRef = Calendar | { id: string } | string;

const calendarIdOf = (ref: CalendarRef): string => (typeof ref === 'string' ? ref : ref.id);

export interface CalendarFixtureInput extends Partial<Omit<CreateCalendarInput, 'slug' | 'name'>> {
  /** Parte finale dello slug e del nome (default 'calendario'). */
  key?: string;
  /** Nome visibile (default = key); il prefisso viene anteposto. */
  name?: string;
}

export interface EventFixtureInput extends Omit<CreateEventInput, 'calendar_id' | 'summary'> {
  calendar: CalendarRef;
  summary: string;
  /** Antepone il prefisso al titolo (default true). Senza, l'evento è pulito per id. */
  prefixSummary?: boolean;
}

export interface AllDayFixtureInput extends Omit<EventFixtureInput, 'start_time' | 'end_time' | 'all_day'> {
  /** Primo giorno (YYYY-MM-DD). */
  date: string;
  /** Numero di giorni (default 1). */
  days?: number;
  /**
   * 'rome': mezzanotte di Roma, come l'editor admin con orari 00:00;
   * 'utc': mezzanotte UTC, come gli all-day DATE importati da parseIcs.
   */
  anchor?: 'rome' | 'utc';
}

export interface OverrideFixtureInput {
  /** Inizio originale dell'occorrenza sostituita (ISO). */
  originalStart: string;
  start?: string;
  end?: string;
  /** Titolo dell'override (il prefisso viene anteposto); default quello del master. */
  summary?: string;
  description?: string;
  status?: CalendarEventStatus;
}

export interface SeriesFixtureInput extends EventFixtureInput {
  rrule: string;
  /** Override (modificati o cancellati) creati con createOccurrenceOverride. */
  overrides?: OverrideFixtureInput[];
}

export interface SeriesFixture {
  master: CalendarEvent;
  overrides: CalendarEvent[];
}

export interface EventTypeFixtureInput {
  /** Parte finale dello slug (default 'tipo'). */
  key?: string;
  /** Titolo (default = key); il prefisso viene anteposto così anche le proiezioni lo portano. */
  title?: string;
  description?: string | null;
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  slotIncrementMinutes?: number;
  /** Default 0: le fixture non devono dipendere dall'ora corrente. */
  minNoticeHours?: number;
  /** Default 365 (massimo ammesso dalla route admin). */
  maxAdvanceDays?: number;
  locationType?: LocationType;
  locationValue?: string | null;
  color?: string;
  isActive?: boolean;
  isPublic?: boolean;
  requiresApproval?: boolean;
  customQuestions?: CustomQuestion[];
  workflowEventKey?: string | null;
  /** Schedule dedicato; senza, il tipo usa lo schedule di default (come in produzione). */
  schedule?: ScheduleFixture | AvailabilitySchedule | { id: string };
  sortOrder?: number;
}

export interface BookingAttendeeInput {
  name?: string;
  /** Default `<prefisso>-cliente@test.invalid`. */
  email?: string;
  phone?: string | null;
  company?: string | null;
  timezone?: string;
  message?: string | null;
}

export interface BookingFixtureInput {
  eventType: EventType;
  /** Inizio (ISO); la fine è start + duration_minutes come in createBooking. */
  start: string;
  status?: BookingStatus;
  source?: BookingSource;
  attendee?: BookingAttendeeInput;
  customResponses?: Record<string, unknown>;
  sourceMetadata?: Record<string, unknown>;
  /** Proietta l'evento nel calendario 'bookings' (default: solo se confirmed). */
  project?: boolean;
  cancelledBy?: 'attendee' | 'admin' | 'system';
  cancellationReason?: string | null;
  rescheduledFromUid?: string | null;
}

export interface BookingFixture {
  booking: Booking;
  eventType: EventType;
  /** Evento proiettato nel calendario 'bookings' (null se non proiettato). */
  projection: CalendarEvent | null;
}

export interface BookingViaLibInput extends Omit<CreateBookingInput, 'event_type_id' | 'event_type_slug' | 'attendee'> {
  eventType: EventType;
  attendee?: BookingAttendeeInput;
}

export interface SubscriptionFixtureInput {
  calendar: CalendarRef;
  name?: string;
  /** URL del feed (mai scaricato dalle fixture). */
  url?: string;
  /**
   * Corpo ICS passato al parser reale (parseIcs). Oggi il parser scarta tutti
   * i VEVENT di un VCALENDAR (bug noto, design §14): per avere eventi
   * importati usare `events`.
   */
  ics?: string;
  /** In alternativa a `ics`: eventi già "parsati". */
  events?: ParsedEvent[];
}

export interface SubscriptionFixture {
  subscription: CalendarSubscription;
  events: CalendarEvent[];
}

/** Stesso alfabeto e lunghezza degli uid di prenotazione di booking.ts. */
const generateBookingUid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

/** Nome e descrizione del calendario festività come in getOrCreateFestivitaCalendar. */
const HOLIDAY_CALENDAR = Object.freeze({
  name: 'Festività e chiusure',
  description: 'Festività nazionali italiane (auto) e chiusure manuali (ferie, ponti)',
  color: '#ef4444',
});

type TrackedKind = keyof TrackedRows;

// ─── Gruppo di fixture ───────────────────────────────

export class Fixtures {
  readonly prefix: string;
  private readonly tracked: Record<TrackedKind, Set<string>> = {
    calendarIds: new Set(),
    eventIds: new Set(),
    bookingIds: new Set(),
    eventTypeIds: new Set(),
    scheduleIds: new Set(),
    subscriptionIds: new Set(),
    appPasswordIds: new Set(),
    mcpTokenIds: new Set(),
    deviceTokenIds: new Set(),
    leadIds: new Set(),
  };

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  // ─── Nomi ───

  /** Testo con il prefisso: `tst-gruppo Riunione`. */
  name(text: string): string {
    return `${this.prefix} ${text}`;
  }

  /** Slug con il prefisso: `tst-gruppo-riunione`. */
  slug(text: string): string {
    const tail = slugify(text);
    return tail ? `${this.prefix}-${tail}` : this.prefix;
  }

  /** Email con il prefisso, riconosciuta dalla pulizia: `tst-gruppo-cliente@test.invalid`. */
  email(local = 'cliente'): string {
    return `${this.slug(local)}@test.invalid`;
  }

  /** Registra per la pulizia una riga creata fuori dalle fixture (es. via HTTP). */
  track(kind: TrackedKind, id: string): void {
    this.tracked[kind].add(id);
  }

  // ─── Calendari ───

  /** Calendario con slug e nome prefissati, creato con createCalendar. */
  async calendar(input: CalendarFixtureInput = {}): Promise<Calendar> {
    const { key = 'calendario', name, ...rest } = input;
    const calendar = await createCalendar({
      ...rest,
      slug: this.slug(key),
      name: this.name(name ?? key),
    });
    this.track('calendarIds', calendar.id);
    return calendar;
  }

  /**
   * Calendario delle festività con lo slug di produzione 'f' (decisioni.md) e
   * gli stessi nome, descrizione, colore e flag di getOrCreateFestivitaCalendar,
   * che lo ritrova per nome. Rifiuta se esiste già un calendario festività
   * (slug 'f' o 'festivita', o nome "Festività…"): la lookup per nome di
   * calendars.ts e capacity.ts diventerebbe ambigua. Usare resetCalendarBaseline().
   */
  async holidayCalendar(opts: { slug?: string } = {}): Promise<Calendar> {
    const slug = opts.slug ?? 'f';
    const existing = await sql<Array<{ slug: string; name: string }>>`
      SELECT slug, name FROM calendars
      WHERE slug = ${slug} OR slug = 'festivita' OR lower(name) IN ('festività', 'festività e chiusure')
    `;
    if (existing.length) {
      const list = existing.map((c) => `${c.slug} ("${c.name}")`).join(', ');
      throw new Error(`Calendario festività già presente: ${list}. Chiama resetCalendarBaseline() prima della fixture.`);
    }
    const calendar = await createCalendar({
      slug,
      name: HOLIDAY_CALENDAR.name,
      description: HOLIDAY_CALENDAR.description,
      color: HOLIDAY_CALENDAR.color,
      timezone: ROME_TZ,
      blocks_availability: true,
      is_system: true,
    });
    this.track('calendarIds', calendar.id);
    return calendar;
  }

  /**
   * Festività nazionali dell'anno come le crea il cron (cron/italian-holidays.ts):
   * set 'public' di date-holidays IT, eventi timed 00:00→24:00 di Roma,
   * source 'system', source_id `it-holiday-YYYY-MM-DD`. `only` limita alle date indicate.
   */
  async holidays(calendar: CalendarRef, opts: { year: number; only?: string[] }): Promise<CalendarEvent[]> {
    const hd = new Holidays('IT');
    const selected = hd
      .getHolidays(opts.year)
      .filter((h) => h.type === 'public')
      .filter((h) => !opts.only || opts.only.includes(h.date.slice(0, 10)));
    const events: CalendarEvent[] = [];
    for (const h of selected) {
      const event = await createEvent({
        calendar_id: calendarIdOf(calendar),
        summary: h.name,
        start_time: new Date(h.start).toISOString(),
        end_time: new Date(h.end).toISOString(),
        all_day: false,
        source: 'system',
        source_id: `it-holiday-${h.date.slice(0, 10)}`,
        status: 'confirmed',
      });
      this.track('eventIds', event.id);
      events.push(event);
    }
    return events;
  }

  /**
   * Chiusura dal–al come POST /closures: un evento timed dalla mezzanotte del
   * primo giorno a quella del giorno dopo l'ultimo (fuso del calendario),
   * source 'admin'. Titolo di default "Chiusura", con il prefisso.
   */
  async closure(calendar: Calendar, opts: { from: string; to?: string; summary?: string }): Promise<CalendarEvent> {
    const tz = calendar.timezone || ROME_TZ;
    const to = opts.to ?? opts.from;
    const event = await createEvent({
      calendar_id: calendar.id,
      summary: this.name(opts.summary ?? 'Chiusura'),
      start_time: fromZonedTime(`${opts.from}T00:00:00`, tz).toISOString(),
      end_time: fromZonedTime(`${addDays(to, 1)}T00:00:00`, tz).toISOString(),
      all_day: false,
      source: 'admin',
      status: 'confirmed',
    });
    this.track('eventIds', event.id);
    return event;
  }

  // ─── Eventi ───

  /** Evento (singolo o master se `rrule`) creato con createEvent. */
  async event(input: EventFixtureInput): Promise<CalendarEvent> {
    const { calendar, summary, prefixSummary = true, ...rest } = input;
    const event = await createEvent({
      ...rest,
      calendar_id: calendarIdOf(calendar),
      summary: prefixSummary ? this.name(summary) : summary,
    });
    this.track('eventIds', event.id);
    return event;
  }

  /** Evento di uno o più giorni interi (all_day=true). */
  async allDayEvent(input: AllDayFixtureInput): Promise<CalendarEvent> {
    const { date, days = 1, anchor = 'rome', ...rest } = input;
    const at = (d: string): string => (anchor === 'utc' ? utcMidnightIso(d) : romeIso(d));
    return this.event({ ...rest, start_time: at(date), end_time: at(addDays(date, days)), all_day: true });
  }

  /**
   * Serie ricorrente: master con RRULE ed exdates (createEvent) più override
   * modificati o cancellati (createOccurrenceOverride, come "solo questa" in admin).
   */
  async series(input: SeriesFixtureInput): Promise<SeriesFixture> {
    const { overrides = [], ...masterInput } = input;
    const master = await this.event(masterInput);
    const created: CalendarEvent[] = [];
    for (const ov of overrides) {
      const override = await createOccurrenceOverride({
        masterEventId: master.id,
        originalStartIso: ov.originalStart,
        newStartIso: ov.start,
        newEndIso: ov.end,
        newSummary: ov.summary ? this.name(ov.summary) : undefined,
        newDescription: ov.description,
        status: ov.status,
      });
      this.track('eventIds', override.id);
      created.push(override);
    }
    return { master, overrides: created };
  }

  // ─── Disponibilità e tipi di prenotazione ───

  /**
   * Schedule dedicato (is_default=false, così non sostituisce quello seminato)
   * con fasce settimanali e override di data, come le route /schedule.
   */
  async schedule(opts: { name?: string; timezone?: string; slots?: readonly WeeklySlotInput[]; overrides?: ScheduleOverrideInput[] } = {}): Promise<ScheduleFixture> {
    const [schedule] = await sql<AvailabilitySchedule[]>`
      INSERT INTO calendar_availability_schedules (name, timezone, is_default)
      VALUES (${this.name(opts.name ?? 'schedule')}, ${opts.timezone ?? ROME_TZ}, false)
      RETURNING id, name, timezone, is_default
    `;
    this.track('scheduleIds', schedule.id);

    const time = (t: string): string => (t.length === 5 ? `${t}:00` : t);
    for (const s of opts.slots ?? OFFICE_HOURS) {
      await sql`
        INSERT INTO calendar_availability_slots (schedule_id, day_of_week, start_time, end_time)
        VALUES (${schedule.id}::uuid, ${s.day}, ${time(s.start)}, ${time(s.end)})
      `;
    }
    for (const o of opts.overrides ?? []) {
      const unavailable = o.unavailable ?? !(o.start && o.end);
      await sql`
        INSERT INTO calendar_availability_overrides (schedule_id, override_date, is_unavailable, start_time, end_time, note)
        VALUES (
          ${schedule.id}::uuid, ${o.date}, ${unavailable},
          ${unavailable ? null : time(o.start!)}, ${unavailable ? null : time(o.end!)}, ${o.note ?? null}
        )
      `;
    }

    const [slots, overrides] = await Promise.all([
      sql<AvailabilitySlot[]>`
        SELECT id, schedule_id, day_of_week,
               to_char(start_time, 'HH24:MI:SS') AS start_time,
               to_char(end_time, 'HH24:MI:SS') AS end_time
        FROM calendar_availability_slots
        WHERE schedule_id = ${schedule.id}::uuid
        ORDER BY day_of_week, start_time
      `,
      sql<AvailabilityOverride[]>`
        SELECT id, schedule_id, override_date::text AS override_date, is_unavailable,
               to_char(start_time, 'HH24:MI:SS') AS start_time,
               to_char(end_time, 'HH24:MI:SS') AS end_time,
               note
        FROM calendar_availability_overrides
        WHERE schedule_id = ${schedule.id}::uuid
        ORDER BY override_date
      `,
    ]);
    return { schedule, slots, overrides };
  }

  /**
   * Tipo di prenotazione con le colonne e i default di POST
   * /api/admin/calendar/event-types, tranne min_notice_hours=0 e
   * location_type='custom_url' (la route vieta google_meet per i nuovi tipi).
   * Ritorna la forma di getEventType, la stessa usata da slot e prenotazioni.
   */
  async eventType(input: EventTypeFixtureInput = {}): Promise<EventType> {
    const key = input.key ?? 'tipo';
    const scheduleId = input.schedule
      ? 'schedule' in input.schedule ? input.schedule.schedule.id : input.schedule.id
      : null;
    const locationType = input.locationType ?? 'custom_url';
    const locationValue = input.locationValue !== undefined
      ? input.locationValue
      : locationType === 'custom_url' ? `https://meet.caldes.test/${this.slug(key)}` : null;

    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO calendar_event_types ${sqlInsert({
        slug: this.slug(key),
        title: this.name(input.title ?? key),
        description: input.description ?? null,
        duration_minutes: input.durationMinutes ?? 30,
        buffer_before_minutes: input.bufferBeforeMinutes ?? 0,
        buffer_after_minutes: input.bufferAfterMinutes ?? 0,
        slot_increment_minutes: input.slotIncrementMinutes ?? 30,
        min_notice_hours: input.minNoticeHours ?? 0,
        max_advance_days: input.maxAdvanceDays ?? 365,
        location_type: locationType,
        location_value: locationValue,
        color: input.color ?? '#7c3aed',
        is_active: input.isActive ?? true,
        is_public: input.isPublic ?? true,
        requires_approval: input.requiresApproval ?? false,
        custom_questions: input.customQuestions ?? [],
        workflow_event_key: input.workflowEventKey ?? null,
        schedule_id: scheduleId,
        sort_order: input.sortOrder ?? 0,
      })}
      RETURNING id
    `;
    this.track('eventTypeIds', row.id);
    const eventType = await getEventType(row.id, { includeInactive: true });
    if (!eventType) throw new Error(`Tipo di prenotazione ${row.id} non riletto`);
    return eventType;
  }

  // ─── Prenotazioni ───

  private attendeeOf(input?: BookingAttendeeInput): Required<BookingAttendeeInput> {
    return {
      name: input?.name ?? 'Cliente di test',
      email: input?.email ?? this.email('cliente'),
      phone: input?.phone ?? null,
      company: input?.company ?? null,
      timezone: input?.timezone ?? ROME_TZ,
      message: input?.message ?? null,
    };
  }

  /**
   * Proiezione di una prenotazione nel calendario 'bookings' con lo stesso
   * template di projectBookingEvent (booking.ts, funzione non esportata):
   * titolo "<tipo> – <cliente>", descrizione con contatti e UID, source
   * 'booking', source_id = uid della prenotazione.
   */
  async projectBooking(booking: Booking, eventType: EventType, meetingUrl: string | null = null): Promise<CalendarEvent> {
    const bookingsCal = await getBookingsCalendar();
    if (!bookingsCal) throw new Error("Calendario 'bookings' assente: il database non è migrato?");
    const event = await createEvent({
      calendar_id: bookingsCal.id,
      summary: `${eventType.title} – ${booking.attendee_name}`,
      description: [
        `Cliente: ${booking.attendee_name} <${booking.attendee_email}>`,
        booking.attendee_phone ? `Tel: ${booking.attendee_phone}` : null,
        booking.attendee_company ? `Azienda: ${booking.attendee_company}` : null,
        booking.attendee_message ? `\nNote:\n${booking.attendee_message}` : null,
        `\nUID prenotazione: ${booking.uid}`,
      ].filter(Boolean).join('\n'),
      location: booking.location_value,
      url: meetingUrl,
      start_time: booking.start_time,
      end_time: booking.end_time,
      source: 'booking',
      source_id: booking.uid,
      status: 'confirmed',
    });
    this.track('eventIds', event.id);
    return event;
  }

  /**
   * Prenotazione inserita direttamente con la stessa riga di createBooking
   * (uid di 12 caratteri, fine = inizio + durata, location risolta con
   * resolveLocationForBooking) senza i controlli legati ad "adesso" né quelli
   * di capacità: serve a costruire scenari deterministici. La EXCLUDE
   * constraint resta attiva. La proiezione segue projectBookingEvent.
   */
  async booking(input: BookingFixtureInput): Promise<BookingFixture> {
    const { eventType } = input;
    const attendee = this.attendeeOf(input.attendee);
    const uid = generateBookingUid();
    const start = new Date(input.start);
    if (Number.isNaN(start.getTime())) throw new Error(`Inizio prenotazione non valido: ${input.start}`);
    const startIso = start.toISOString();
    const endIso = new Date(start.getTime() + eventType.duration_minutes * 60_000).toISOString();
    const status = input.status ?? 'confirmed';

    const resolved = await resolveLocationForBooking({
      eventType,
      booking: { uid, start_time: startIso, end_time: endIso, attendee_name: attendee.name, attendee_email: attendee.email },
    });
    const cancelled = status === 'cancelled';

    const [booking] = await sql<Booking[]>`
      INSERT INTO calendar_bookings ${sqlInsert({
        uid,
        event_type_id: eventType.id,
        status,
        attendee_name: attendee.name,
        attendee_email: attendee.email.toLowerCase(),
        attendee_phone: attendee.phone,
        attendee_company: attendee.company,
        attendee_timezone: attendee.timezone,
        attendee_message: attendee.message,
        custom_responses: input.customResponses ?? {},
        start_time: startIso,
        end_time: endIso,
        location_type: eventType.location_type,
        location_value: resolved.locationValue || null,
        google_event_id: null,
        source: input.source ?? 'public_page',
        source_metadata: input.sourceMetadata ?? {},
        cancelled_by: cancelled ? input.cancelledBy ?? 'admin' : null,
        cancellation_reason: cancelled ? input.cancellationReason ?? null : null,
        rescheduled_from_uid: input.rescheduledFromUid ?? null,
      })}
      RETURNING *
    `;
    if (cancelled) {
      // Come cancelBooking: cancelled_at = NOW() del server.
      await sql`UPDATE calendar_bookings SET cancelled_at = NOW() WHERE id = ${booking.id}::uuid`;
    }
    this.track('bookingIds', booking.id);

    const shouldProject = input.project ?? status === 'confirmed';
    const projection = shouldProject ? await this.projectBooking(booking, eventType, resolved.meetingUrl) : null;
    const [fresh] = await sql<Booking[]>`SELECT * FROM calendar_bookings WHERE id = ${booking.id}::uuid`;
    return { booking: fresh, eventType, projection };
  }

  /**
   * Prenotazione con il flusso reale createBooking (capacità, buffer, lock per
   * settimana, proiezione, workflow). Dipende da "adesso" per min_notice e
   * max_advance: usarla con freezeTime() (helpers/clock.ts).
   */
  async bookingViaLib(input: BookingViaLibInput): Promise<BookingFixture> {
    const { eventType, attendee, ...rest } = input;
    const a = this.attendeeOf(attendee);
    const { booking } = await createBooking({
      ...rest,
      event_type_id: eventType.id,
      attendee: {
        name: a.name,
        email: a.email,
        phone: a.phone ?? undefined,
        company: a.company ?? undefined,
        timezone: a.timezone,
        message: a.message ?? undefined,
      },
    });
    this.track('bookingIds', booking.id);
    const projection = await getEventBySource('booking', booking.uid);
    if (projection) this.track('eventIds', projection.id);
    return { booking, eventType, projection };
  }

  // ─── Device, iscrizioni e token ───

  /** App-password CalDAV (createAppPassword); default username 'federico'. */
  async appPassword(opts: { username?: string; device?: string } = {}): Promise<{ password: string; row: CalDavAppPassword }> {
    const created = await createAppPassword({
      username: opts.username ?? 'federico',
      deviceName: this.name(opts.device ?? 'iPhone'),
      createdBy: null,
    });
    this.track('appPasswordIds', created.row.id);
    return created;
  }

  /**
   * Iscrizione ICS (createSubscription) con eventi importati senza rete: il
   * corpo `ics` passa dal parser reale (parseIcs), poi replaceSubscriptionEvents
   * e lo stesso aggiornamento di event_count/last_synced_at di syncSubscription.
   */
  async subscription(input: SubscriptionFixtureInput): Promise<SubscriptionFixture> {
    const calendarId = calendarIdOf(input.calendar);
    const created = await createSubscription({
      calendar_id: calendarId,
      name: this.name(input.name ?? 'iscrizione'),
      ics_url: input.url ?? `https://feeds.caldes.test/${this.prefix}.ics`,
    });
    this.track('subscriptionIds', created.id);

    const parsed = input.events ?? (input.ics !== undefined ? parseIcs(input.ics) : null);
    if (parsed) {
      const { inserted } = await replaceSubscriptionEvents(created.id, calendarId, parsed, { allowEmpty: true });
      await sql`
        UPDATE calendar_subscriptions
        SET last_synced_at = NOW(), last_error = NULL, event_count = ${inserted}
        WHERE id = ${created.id}::uuid
      `;
    }

    const subscription = await getSubscription(created.id);
    if (!subscription) throw new Error(`Iscrizione ${created.id} non riletta`);
    const events = await sql<CalendarEvent[]>`
      SELECT id, calendar_id, uid, summary, description, location, url,
             start_time, end_time, all_day, rrule, exdates, recurrence_id, recurrence_master_id,
             source, source_id, status, created_at, updated_at
      FROM calendar_events
      WHERE subscription_id = ${created.id}::uuid
      ORDER BY start_time, source_id
    `;
    for (const e of events) this.track('eventIds', e.id);
    return { subscription, events };
  }

  /** Token MCP (Bearer mcp_<64hex>) come POST /api/mcp-tokens; default scope 'write'. */
  async mcpToken(opts: { scope?: 'read' | 'write' | 'admin' } = {}): Promise<{ token: string; id: string }> {
    const { token, hash, prefix } = generateMcpToken();
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO mcp_tokens (token_hash, token_prefix, label, scope)
      VALUES (${hash}, ${prefix}, ${this.name('mcp')}, ${opts.scope ?? 'write'})
      RETURNING id
    `;
    this.track('mcpTokenIds', row.id);
    return { token, id: row.id };
  }

  /** Token device (Bearer dvt_<32hex>) come POST /api/device/pair. */
  async deviceToken(): Promise<{ token: string; id: string }> {
    const token = `dvt_${randomUUID().replace(/-/g, '')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO device_tokens (token_hash, token_prefix, label)
      VALUES (${hash}, ${token.slice(0, 12)}, ${this.name('device')})
      RETURNING id
    `;
    this.track('deviceTokenIds', row.id);
    return { token, id: row.id };
  }

  // ─── Pulizia ───

  /** Rimuove tutti i dati del gruppo (prefisso più righe registrate). */
  async cleanup(): Promise<CleanupReport> {
    return cleanupTestData(this.prefix, this.tracked);
  }
}

/** Gruppo di fixture con prefisso `tst-<etichetta>` (vedi testPrefix). */
export function createFixtures(label: string, opts: { random?: boolean } = {}): Fixtures {
  return new Fixtures(testPrefix(label, opts));
}

/**
 * Gruppo di fixture legato al ciclo di vita del file: registra il database
 * (useTestDatabase) e pulisce il prefisso dopo le migrazioni, prima del primo
 * test, e di nuovo dopo l'ultimo, prima della chiusura del pool.
 */
export function useFixtures(label: string, opts: { random?: boolean; resetBaseline?: boolean } = {}): Fixtures {
  const fixtures = createFixtures(label, { random: opts.random });
  useTestDatabase({ resetBaseline: opts.resetBaseline });
  onDatabaseReady(() => fixtures.cleanup());
  onBeforeDatabaseClose(() => fixtures.cleanup());
  return fixtures;
}
