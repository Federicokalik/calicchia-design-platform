/**
 * Helper del contratto admin v1 (admin-calendar-v1.contract.test.ts).
 *
 * Contiene ciò che serve solo a quel file e che helpers/ non offre:
 *  - alias leggibili per gli snapshot (calendari seminati, schedule di
 *    default, eventi e prenotazioni dello scenario);
 *  - lettura degli effetti sul database (righe di eventi, prenotazioni,
 *    calendari, iscrizioni) dopo le richieste di scrittura;
 *  - salvataggio e ripristino dello schedule di default, che le route
 *    /schedule* modificano e resetCalendarBaseline() ripristina solo in parte
 *    (gli slot sì, nome e fuso no);
 *  - un server ICS remoto simulato: `fetch` sostituito con mock.method di
 *    node:test, così il sync delle iscrizioni non esce mai in rete.
 */

import { mock } from 'node:test';
import { SEED_CALENDAR_SLUGS, SEED_EVENT_TYPE_SLUGS, sql } from '../helpers/db';
import type { BookingFixture, SeriesFixture } from '../helpers/fixtures';
import { createNormalizer, type SnapshotNormalizer } from '../helpers/normalize';
import type { CalendarEvent } from '../../src/lib/calendar/types';
import { isRadicaleBackend } from '../helpers/calendar-backend';
import {
  storeCalendarEventRows,
  storeEventRows,
  storeOverrideRows,
  storeProjectionRows,
  storeSubscriptionEventRows,
} from '../helpers/calendar-rows';

// ─── Alias ───────────────────────────────

/** Etichette leggibili per valori noti dello scenario (id, uid, token). */
export class AdminAliases {
  private readonly entries = new Map<string, string>();

  /** Registra `value` → `<label>`. Lo stesso valore non può avere due etichette. */
  add(value: string | null | undefined, label: string): void {
    if (!value) return;
    // Il normalizzatore confronta gli UUID in minuscolo.
    const key = /^[0-9a-f-]{36}$/i.test(value) ? value.toLowerCase() : value;
    const existing = this.entries.get(key);
    if (existing && existing !== label) throw new Error(`Alias in conflitto per ${value}: ${existing} / ${label}`);
    this.entries.set(key, label);
  }

  /** Evento: id → `ev:<key>`, uid → `uid:<key>`. */
  event(key: string, event: Pick<CalendarEvent, 'id' | 'uid'>): void {
    this.add(event.id, `ev:${key}`);
    this.add(event.uid, `uid:${key}`);
  }

  /**
   * Serie: master più override con le chiavi indicate (nello stesso ordine).
   * Con lo store Radicale un override ha l'UID del master (RFC 5545, design
   * §12 differenza ammessa 1): il suo uid resta con l'alias del master.
   */
  series(key: string, series: SeriesFixture, overrideKeys: string[] = []): void {
    this.event(key, series.master);
    series.overrides.forEach((ov, i) => {
      const overrideKey = overrideKeys[i] ?? `${key}-override-${i + 1}`;
      if (ov.uid === series.master.uid) this.add(ov.id, `ev:${overrideKey}`);
      else this.event(overrideKey, ov);
    });
  }

  /** Prenotazione: id → `bk-id:<key>`, uid pubblico → `bk:<key>`, più la proiezione se c'è. */
  booking(key: string, fixture: BookingFixture): void {
    this.add(fixture.booking.id, `bk-id:${key}`);
    this.add(fixture.booking.uid, `bk:${key}`);
    if (fixture.projection) this.event(`proiezione-${key}`, fixture.projection);
  }

  /** Nuovo normalizzatore (segnaposto numerati da 1) con tutti gli alias registrati. */
  normalizer(): SnapshotNormalizer {
    const n = createNormalizer();
    for (const [value, label] of this.entries) n.alias(value, label);
    return n;
  }
}

/** Righe seminate del database dei test (diverse per id e token fra un database e l'altro). */
export interface SeedRows {
  calendars: Record<string, { id: string; ics_feed_token: string }>;
  defaultScheduleId: string;
  eventTypes: Record<string, string>;
}

/**
 * Legge le righe seminate e le registra come alias: calendari `cal:<slug>`
 * (token `token:<slug>`), schedule di default `schedule:default`, tipi di
 * prenotazione `et:<slug>`. Va chiamata dopo resetCalendarBaseline().
 */
export async function registerSeedAliases(aliases: AdminAliases): Promise<SeedRows> {
  const calendars = await sql<Array<{ id: string; slug: string; ics_feed_token: string }>>`
    SELECT id, slug, ics_feed_token FROM calendars WHERE slug = ANY(${[...SEED_CALENDAR_SLUGS]}::text[])
  `;
  const [schedule] = await sql<Array<{ id: string }>>`
    SELECT id FROM calendar_availability_schedules WHERE is_default = true ORDER BY created_at ASC LIMIT 1
  `;
  const eventTypes = await sql<Array<{ id: string; slug: string }>>`
    SELECT id, slug FROM calendar_event_types WHERE slug = ANY(${[...SEED_EVENT_TYPE_SLUGS]}::text[])
  `;
  if (calendars.length !== SEED_CALENDAR_SLUGS.length || !schedule) {
    throw new Error('Righe seminate del calendario assenti: il database dei test non è alla baseline');
  }

  const seed: SeedRows = { calendars: {}, defaultScheduleId: schedule.id, eventTypes: {} };
  for (const c of calendars) {
    aliases.add(c.id, `cal:${c.slug}`);
    aliases.add(c.ics_feed_token, `token:${c.slug}`);
    seed.calendars[c.slug] = { id: c.id, ics_feed_token: c.ics_feed_token };
  }
  aliases.add(schedule.id, 'schedule:default');
  for (const et of eventTypes) {
    aliases.add(et.id, `et:${et.slug}`);
    seed.eventTypes[et.slug] = et.id;
  }
  return seed;
}

// ─── Effetti sul database ───────────────────────────────

type Row = Record<string, unknown>;

/** Righe di calendar_events (colonne che decidono il comportamento), nell'ordine degli id; le assenti come `{ id, deleted: true }`. */
export async function eventRows(ids: string[]): Promise<Row[]> {
  if (isRadicaleBackend()) {
    return storeEventRows(ids, ['calendar', 'id', 'uid', 'summary', 'description', 'location', 'url', 'start_time', 'end_time',
      'all_day', 'rrule', 'exdates', 'recurrence_id', 'recurrence_master_id', 'source', 'source_id', 'status']);
  }
  const rows = await sql<Row[]>`
    SELECT c.slug AS calendar, e.id, e.uid, e.summary, e.description, e.location, e.url,
           e.start_time, e.end_time, e.all_day, e.rrule, e.exdates, e.recurrence_id,
           e.recurrence_master_id, e.source, e.source_id, e.status
    FROM calendar_events e
    JOIN calendars c ON c.id = e.calendar_id
    WHERE e.id = ANY(${ids}::uuid[])
  `;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return ids.map((id) => byId.get(id) ?? { id, deleted: true });
}

/** Tutte le righe di un calendario (master, singoli e override), in ordine stabile. */
export async function calendarEventRows(calendarId: string): Promise<Row[]> {
  if (isRadicaleBackend()) {
    return storeCalendarEventRows(calendarId, ['id', 'uid', 'summary', 'start_time', 'end_time', 'all_day', 'rrule', 'exdates',
      'recurrence_id', 'recurrence_master_id', 'source', 'source_id', 'status']);
  }
  return [...await sql<Row[]>`
    SELECT id, uid, summary, start_time, end_time, all_day, rrule, exdates, recurrence_id,
           recurrence_master_id, source, source_id, status
    FROM calendar_events
    WHERE calendar_id = ${calendarId}::uuid
    ORDER BY start_time, recurrence_id NULLS FIRST, summary
  `];
}

/** Override di una serie, ordinati per recurrence_id. */
export async function overrideRows(masterId: string): Promise<Row[]> {
  if (isRadicaleBackend()) return storeOverrideRows(masterId, ['id', 'calendar_id', 'summary', 'start_time', 'end_time', 'recurrence_id', 'status']);
  return [...await sql<Row[]>`
    SELECT id, calendar_id, summary, start_time, end_time, recurrence_id, status
    FROM calendar_events
    WHERE recurrence_master_id = ${masterId}::uuid
    ORDER BY recurrence_id
  `];
}

/** Proiezioni (calendar_events con source 'booking') delle prenotazioni indicate, per uid. */
export async function projectionRows(bookingUids: string[]): Promise<Row[]> {
  if (isRadicaleBackend()) {
    return storeProjectionRows(bookingUids, ['calendar', 'id', 'summary', 'description', 'location', 'url', 'start_time', 'end_time',
      'source', 'source_id', 'status']);
  }
  return [...await sql<Row[]>`
    SELECT c.slug AS calendar, e.id, e.summary, e.description, e.location, e.url,
           e.start_time, e.end_time, e.source, e.source_id, e.status
    FROM calendar_events e
    JOIN calendars c ON c.id = e.calendar_id
    WHERE e.source = 'booking' AND e.source_id = ANY(${bookingUids}::text[])
    ORDER BY e.start_time, e.source_id
  `];
}

/** Righe di calendar_bookings (stato e campi del ciclo di vita), per uid nell'ordine dato. */
export async function bookingRows(uids: string[]): Promise<Row[]> {
  const rows = await sql<Row[]>`
    SELECT uid, status, start_time, end_time, source, location_value,
           cancelled_by, cancellation_reason, cancelled_at, approved_at, rescheduled_from_uid
    FROM calendar_bookings
    WHERE uid = ANY(${uids}::text[])
  `;
  const byUid = new Map(rows.map((r) => [String(r.uid), r]));
  return uids.map((uid) => byUid.get(uid) ?? { uid, deleted: true });
}

/** Riga di calendars (senza timestamp) o null. */
export async function calendarRow(id: string): Promise<Row | null> {
  const [row] = await sql<Row[]>`
    SELECT id, slug, name, description, color, icon, timezone, is_default, is_system,
           blocks_availability, ics_feed_token, ics_feed_enabled, sort_order
    FROM calendars WHERE id = ${id}::uuid
  `;
  return row ?? null;
}

/** Calendari predefiniti (slug), per verificare la promozione e la demozione di is_default. */
export async function defaultCalendarSlugs(): Promise<string[]> {
  const rows = await sql<Array<{ slug: string }>>`SELECT slug FROM calendars WHERE is_default ORDER BY slug`;
  return rows.map((r) => r.slug);
}

/** Riga di calendar_subscriptions senza timestamp di sistema. */
export async function subscriptionRow(id: string): Promise<Row | null> {
  const [row] = await sql<Row[]>`
    SELECT id, calendar_id, name, ics_url, sync_enabled, last_error, etag, last_modified, event_count
    FROM calendar_subscriptions WHERE id = ${id}::uuid
  `;
  return row ?? null;
}

/** Eventi importati da un'iscrizione (source ics_pull), in ordine stabile. */
export async function subscriptionEventRows(subscriptionId: string): Promise<Row[]> {
  if (isRadicaleBackend()) {
    return storeSubscriptionEventRows(subscriptionId, ['summary', 'start_time', 'end_time', 'all_day', 'rrule', 'exdates',
      'recurrence_id', 'source', 'source_id', 'status']);
  }
  return [...await sql<Row[]>`
    SELECT summary, start_time, end_time, all_day, rrule, exdates, recurrence_id, source, source_id, status
    FROM calendar_events
    WHERE subscription_id = ${subscriptionId}::uuid
    ORDER BY start_time, source_id
  `];
}

// ─── Schedule di default ───────────────────────────────

export interface SavedDefaultSchedule {
  id: string;
  name: string;
  timezone: string;
  slots: Array<{ day_of_week: number; start_time: string; end_time: string }>;
  overrides: Array<{
    override_date: string;
    is_unavailable: boolean;
    start_time: string | null;
    end_time: string | null;
    note: string | null;
  }>;
}

/** Fotografia dello schedule di default (nome, fuso, slot e override), da ripristinare a fine test. */
export async function saveDefaultSchedule(): Promise<SavedDefaultSchedule> {
  const [schedule] = await sql<Array<{ id: string; name: string; timezone: string }>>`
    SELECT id, name, timezone FROM calendar_availability_schedules
    WHERE is_default = true ORDER BY created_at ASC LIMIT 1
  `;
  if (!schedule) throw new Error('Schedule di default assente: il database dei test non è alla baseline');
  const slots = await sql<SavedDefaultSchedule['slots']>`
    SELECT day_of_week, start_time::text AS start_time, end_time::text AS end_time
    FROM calendar_availability_slots WHERE schedule_id = ${schedule.id}::uuid
    ORDER BY day_of_week, start_time
  `;
  const overrides = await sql<SavedDefaultSchedule['overrides']>`
    SELECT override_date::text AS override_date, is_unavailable,
           start_time::text AS start_time, end_time::text AS end_time, note
    FROM calendar_availability_overrides WHERE schedule_id = ${schedule.id}::uuid
    ORDER BY override_date
  `;
  return { ...schedule, slots: [...slots], overrides: [...overrides] };
}

/** Ripristina lo schedule di default salvato con saveDefaultSchedule (in una transazione). */
export async function restoreDefaultSchedule(saved: SavedDefaultSchedule): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tipo tx di postgres-js (stesso pattern di src/)
  await sql.begin(async (tx: any) => {
    await tx`
      UPDATE calendar_availability_schedules SET name = ${saved.name}, timezone = ${saved.timezone}
      WHERE id = ${saved.id}::uuid
    `;
    await tx`DELETE FROM calendar_availability_slots WHERE schedule_id = ${saved.id}::uuid`;
    for (const s of saved.slots) {
      await tx`
        INSERT INTO calendar_availability_slots (schedule_id, day_of_week, start_time, end_time)
        VALUES (${saved.id}::uuid, ${s.day_of_week}, ${s.start_time}, ${s.end_time})
      `;
    }
    await tx`DELETE FROM calendar_availability_overrides WHERE schedule_id = ${saved.id}::uuid`;
    for (const o of saved.overrides) {
      await tx`
        INSERT INTO calendar_availability_overrides (schedule_id, override_date, is_unavailable, start_time, end_time, note)
        VALUES (${saved.id}::uuid, ${o.override_date}, ${o.is_unavailable}, ${o.start_time}, ${o.end_time}, ${o.note})
      `;
    }
  });
}

// ─── Server ICS remoto simulato ───────────────────────────────

/** Richiesta ricevuta dal server simulato (header che decidono la cache e la sicurezza). */
export interface RemoteIcsRequest {
  url: string;
  method: string;
  redirect: string | null;
  user_agent: string | null;
  accept: string | null;
  if_none_match: string | null;
  if_modified_since: string | null;
}

/** Risposta del server simulato. */
export interface RemoteIcsResponse {
  status: number;
  statusText?: string;
  body?: string | null;
  headers?: Record<string, string>;
}

export type RemoteIcsHandler = (req: RemoteIcsRequest) => RemoteIcsResponse;

/**
 * Server ICS remoto in memoria: sostituisce `globalThis.fetch` (usato da
 * fetchIcs in lib/calendar/ics-import.ts) con mock.method di node:test.
 *
 * Gli URL devono essere IP letterali pubblici (es. 203.0.113.0/24, TEST-NET-3):
 * assertPublicUrl li accetta senza lookup DNS, quindi nessuna richiesta esce
 * dal processo. Un URL senza rotta fallisce come un errore di rete.
 */
export class RemoteIcsServer {
  private readonly routes = new Map<string, RemoteIcsHandler>();
  private log: RemoteIcsRequest[] = [];
  private restoreFetch: (() => void) | null = null;

  /** Registra la risposta (fissa o calcolata dalla richiesta) per un URL esatto. */
  route(url: string, response: RemoteIcsResponse | RemoteIcsHandler): this {
    this.routes.set(url, typeof response === 'function' ? response : () => response);
    return this;
  }

  /** Installa il mock di fetch; da abbinare sempre a restore() in un finally. */
  install(): this {
    if (this.restoreFetch) return this;
    const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const req: RemoteIcsRequest = {
        url,
        method: init?.method ?? 'GET',
        redirect: init?.redirect ?? null,
        user_agent: headers.get('user-agent'),
        accept: headers.get('accept'),
        if_none_match: headers.get('if-none-match'),
        if_modified_since: headers.get('if-modified-since'),
      };
      this.log.push(req);
      const handler = this.routes.get(url);
      if (!handler) throw new TypeError(`fetch failed (URL non simulato: ${url})`);
      const res = handler(req);
      return new Response(res.body ?? null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    });
    this.restoreFetch = () => fetchMock.mock.restore();
    return this;
  }

  /** Ripristina il fetch reale. Idempotente. */
  restore(): void {
    this.restoreFetch?.();
    this.restoreFetch = null;
  }

  /** Richieste ricevute dall'ultima chiamata (e svuota il registro). */
  takeRequests(): RemoteIcsRequest[] {
    const out = this.log;
    this.log = [];
    return out;
  }
}

/** Corpo iCalendar (CRLF) con i VEVENT indicati, ciascuno come elenco di righe di proprietà. */
export function icsCalendar(events: string[][]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Caldes test//Feed remoto//IT',
    ...events.flatMap((props) => ['BEGIN:VEVENT', ...props, 'END:VEVENT']),
    'END:VCALENDAR',
  ];
  return `${lines.join('\r\n')}\r\n`;
}
