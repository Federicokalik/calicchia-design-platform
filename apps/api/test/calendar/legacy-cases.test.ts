/**
 * Casi di scripts/verify-calendar-schema.ts e scripts/verify-calendar.ts
 * portati in node:test (piano F0, attività 5; design §15 "Porting di
 * verify-calendar*.ts").
 *
 * Stessi casi e stesse asserzioni degli script, con tre differenze di forma:
 *  - nessun .env: ambiente e database arrivano da helpers/env.ts
 *    (TEST_DATABASE_URL), il dominio calendario parte dalla baseline;
 *  - casi parametrici: ogni sezione è una tabella di casi { nome, esecuzione }
 *    e ogni caso è un test a sé, autonomo (crea i propri dati con le fixture,
 *    afterEach li rimuove), quindi gira anche da solo con --test-name-pattern.
 *    Le catene dello script (crea → riprogramma → annulla) sono rifatte
 *    dentro il singolo caso;
 *  - niente "adesso" reale: l'orologio è fermo a lunedì 4 gennaio 2027 alle
 *    08:00 di Roma e le date dello script (Date.now() + N) sono fisse.
 *
 * Le stampe informative degli script ("expected 4", "expected 2", schedule di
 * default, URL dei feed) diventano asserzioni sui valori attesi della
 * baseline (migrazioni 067, 068, 071).
 *
 * Parametrizzazione sullo store (design §15): oggi esiste solo PgLegacyStore.
 * Con CALENDAR_BACKEND diverso da 'postgres' la suite viene saltata con un
 * messaggio esplicito, finché in F2 i casi non passano dalla facade store().
 *
 * Esecuzione: pnpm --filter @calicchia/api test:calendar
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { after, afterEach, describe, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cleanupCalendarAudit,
  databaseNow,
  onBeforeDatabaseClose,
  onDatabaseReady,
  SEED_CALENDAR_SLUGS,
  SEED_EVENT_TYPE_SLUGS,
  sql,
} from '../helpers/db';
import { TEST_ENV } from '../helpers/env';
import { OFFICE_HOURS, useFixtures } from '../helpers/fixtures';
import { freezeTime, restoreTime } from '../helpers/clock';
import { getEventType } from '../../src/lib/calendar/availability';
import {
  approveBooking,
  BookingConflictError,
  BookingValidationError,
  cancelBooking,
  createBooking,
  rejectBooking,
  rescheduleBooking,
  validateCustomResponses,
} from '../../src/lib/calendar/booking';
import { revokeAppPassword, verifyCredentials } from '../../src/lib/calendar/caldav-passwords';
import { buildFeedUrl, getDefaultCalendar, listCalendars } from '../../src/lib/calendar/calendars';
import {
  createEvent,
  createOccurrenceOverride,
  deleteEvent,
  EventReadOnlyError,
  getEventBySource,
  listOccurrences,
  updateEvent,
} from '../../src/lib/calendar/events';
import { buildIcs } from '../../src/lib/calendar/ics';
import { buildIcsFeed } from '../../src/lib/calendar/ics-feed';
import { assertPublicUrl, IcsImportError, parseIcs, type ParsedEvent } from '../../src/lib/calendar/ics-import';
import { computeAvailableSlots } from '../../src/lib/calendar/slots';
import { replaceSubscriptionEvents } from '../../src/lib/calendar/subscriptions';
import { isTokenSecretConfigured, signBookingToken, verifyBookingToken } from '../../src/lib/calendar/token';
import type { Booking, Calendar, CustomQuestion, EventType, Slot } from '../../src/lib/calendar/types';

const fx = useFixtures('legacy-verify', { resetBaseline: true });

/** Store sotto test (matrice calendar-integration, design §15). */
const STORE = process.env.CALENDAR_BACKEND || 'postgres';

/** Lunedì 4 gennaio 2027, 08:00 a Roma: "adesso" per tutti i casi. */
const NOW = '2027-01-04T07:00:00.000Z';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Come lo script: tutte le righe portano l'email e gli slug di test; qui con il prefisso del gruppo.
const TEST_EMAIL = fx.email('verify-calendar');

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

/** Calendari creati dai casi: servono a ripulire audit_logs. */
const calendarIds = new Set<string>();
let since = '';

/**
 * Pulizia dopo ogni caso: dati del gruppo più le righe di audit_logs che la
 * pulizia per prefisso non vede (eventi cancellati da replaceSubscriptionEvents
 * o in cascata con il master).
 */
async function cleanupAll(): Promise<void> {
  await fx.cleanup();
  if (since) await cleanupCalendarAudit({ since, prefixes: [fx.prefix], ids: calendarIds });
}

// L'orologio si ferma dentro il `before` di useTestDatabase (dopo migrazioni,
// baseline e pre-pulizia), così vale anche per i run filtrati.
onDatabaseReady(async () => {
  since = await databaseNow();
  freezeTime(NOW);
});
onBeforeDatabaseClose(cleanupAll);
afterEach(cleanupAll);
after(() => restoreTime());

// ─── Utilità dello script ───────────────────────────────

/** Data di oggi (YYYY-MM-DD) a Roma più N giorni, sull'orologio fermo. */
function romeDatePlus(days: number): string {
  const d = new Date(Date.now() + days * DAY_MS);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);
}

/**
 * Tipi di prenotazione dello script (seedEventType): 30 minuti a passi di
 * 30, nessun buffer né preavviso, 60 giorni di anticipo, telefonata, non
 * pubblico, ordinamento 999.
 */
async function smokeEventType(opts: { requiresApproval: boolean }): Promise<EventType> {
  return fx.eventType({
    key: opts.requiresApproval ? 'smoke-approval' : 'smoke',
    title: 'Smoke test',
    description: 'created by verify-calendar.ts',
    durationMinutes: 30,
    slotIncrementMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeHours: 0,
    maxAdvanceDays: 60,
    locationType: 'phone',
    isPublic: false,
    requiresApproval: opts.requiresApproval,
    customQuestions: [],
    sortOrder: 999,
  });
}

/** Primi `count` slot liberi nei prossimi 14 giorni (lancia se non bastano). */
async function firstFreeSlots(eventType: EventType, count: number): Promise<Slot[]> {
  const result = await computeAvailableSlots({
    eventTypeIdOrSlug: eventType.slug,
    fromDateLocal: romeDatePlus(0),
    toDateLocal: romeDatePlus(14),
  });
  if (!result || result.slots.length < count) {
    throw new Error(`servono ${count} slot liberi nei prossimi 14 giorni, trovati ${result?.slots.length ?? 0}`);
  }
  return result.slots.slice(0, count);
}

/** Prenotazione con il motore reale, come lo script (source e nome a scelta). */
async function book(eventType: EventType, start: string, source: Booking['source'], name: string): Promise<Booking> {
  const { booking } = await createBooking({
    event_type_slug: eventType.slug,
    start,
    attendee: { name, email: TEST_EMAIL, timezone: 'Europe/Rome' },
    source,
    source_metadata: source === 'admin_manual' ? { verify_script: true } : undefined,
  });
  return booking;
}

async function bookingStatus(uid: string): Promise<string> {
  const [row] = await sql<Array<{ status: string }>>`SELECT status FROM calendar_bookings WHERE uid = ${uid}`;
  return row.status;
}

/** Calendario di test dello script (TEST_CAL_SLUG "Verify smoke ICS", con il feed disattivato). */
async function smokeCalendar(): Promise<Calendar> {
  const cal = await fx.calendar({ key: 'ics-cal', name: 'Verify smoke ICS', color: '#334155' });
  calendarIds.add(cal.id);
  await sql`UPDATE calendars SET ics_feed_enabled = false WHERE id = ${cal.id}::uuid`;
  return cal;
}

/** Calendario e iscrizione per i casi anti-wipe, come lo script (feed e sync disattivati). */
async function antiWipeFixture(): Promise<{ calendarId: string; subscriptionId: string }> {
  const cal = await smokeCalendar();
  const [sub] = await sql<Array<{ id: string }>>`
    INSERT INTO calendar_subscriptions (calendar_id, name, ics_url, sync_enabled)
    VALUES (${cal.id}::uuid, ${fx.name('verify-smoke-sub')}, 'https://example.invalid/verify-smoke.ics', false)
    RETURNING id
  `;
  fx.track('subscriptionIds', sub.id);
  return { calendarId: cal.id, subscriptionId: sub.id };
}

/** Evento remoto "parsato" a un'ora dall'adesso fermo (Date.now() + 1h nello script). */
function parsedEvent(uid: string, summary = `Smoke ${uid}`): ParsedEvent {
  return {
    remote_uid: uid,
    summary: fx.name(summary),
    description: null,
    location: null,
    url: null,
    start_time: new Date(Date.now() + HOUR_MS).toISOString(),
    end_time: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    all_day: false,
    rrule: null,
    exdates: [],
    recurrence_id: null,
    status: 'confirmed',
  };
}

async function subscriptionEventCount(subscriptionId: string): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM calendar_events WHERE subscription_id = ${subscriptionId}::uuid
  `;
  return row.n;
}

// ─── Casi ───────────────────────────────

interface LegacyCase {
  name: string;
  run: (t: TestContext) => Promise<void> | void;
}

interface LegacySection {
  /** Script di origine. */
  source: 'verify-calendar-schema.ts' | 'verify-calendar.ts';
  title: string;
  cases: LegacyCase[];
}

/** Tabelle che lo script schema legge con COUNT(*). */
const REQUIRED_TABLES = [
  'calendars',
  'calendar_events',
  'calendar_event_types',
  'calendar_bookings',
  'calendar_availability_schedules',
  'calendar_availability_slots',
] as const;

/** Calendari seminati dalla migrazione 071 con i flag stampati dallo script. */
const SEED_CALENDARS: ReadonlyArray<{ slug: string; isDefault: boolean; isSystem: boolean; blocks: boolean }> = [
  { slug: 'lavoro', isDefault: true, isSystem: false, blocks: true },
  { slug: 'personale', isDefault: false, isSystem: false, blocks: true },
  { slug: 'bookings', isDefault: false, isSystem: true, blocks: true },
  { slug: 'scadenze', isDefault: false, isSystem: true, blocks: false },
];

const CUSTOM_QUESTIONS: CustomQuestion[] = [
  { key: 'budget', label: 'Budget', type: 'select', required: true, options: ['<1k', '1-5k', '>5k'] },
  { key: 'note', label: 'Note', type: 'text', required: false },
];

/** URL che assertPublicUrl deve rifiutare (nessun lookup DNS: IP letterali o host locali). */
const PRIVATE_URLS = ['http://127.0.0.1/cal.ics', 'http://169.254.169.254/latest', 'http://10.0.0.5/x', 'http://localhost/feed'];

const SECTIONS: LegacySection[] = [
  // ─── verify-calendar-schema.ts ───
  {
    source: 'verify-calendar-schema.ts',
    title: 'tabelle richieste',
    cases: REQUIRED_TABLES.map((table) => ({
      name: `${table} esiste ed è leggibile`,
      run: async () => {
        const [row] = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM ${sql(table)}`;
        assert.equal(typeof row.n, 'number');
        assert.ok(row.n >= 0);
      },
    })),
  },
  {
    source: 'verify-calendar-schema.ts',
    title: 'dati seminati',
    cases: [
      {
        name: 'calendari seminati (attesi 4) con i flag di default, sistema e blocco',
        run: async () => {
          const rows = await sql<Array<{ slug: string; is_default: boolean; is_system: boolean; blocks_availability: boolean; ics_feed_token: string }>>`
            SELECT slug, is_default, is_system, blocks_availability, ics_feed_token
            FROM calendars ORDER BY sort_order
          `;
          assert.deepEqual(rows.map((r) => r.slug), [...SEED_CALENDAR_SLUGS]);
          for (const expected of SEED_CALENDARS) {
            const row = rows.find((r) => r.slug === expected.slug);
            assert.ok(row, `calendario ${expected.slug} mancante`);
            assert.deepEqual(
              { isDefault: row.is_default, isSystem: row.is_system, blocks: row.blocks_availability },
              { isDefault: expected.isDefault, isSystem: expected.isSystem, blocks: expected.blocks },
              `flag del calendario ${expected.slug}`,
            );
          }
        },
      },
      {
        name: 'tipi di prenotazione seminati (attesi 2)',
        run: async () => {
          const rows = await sql<Array<{ slug: string; duration_minutes: number }>>`
            SELECT slug, duration_minutes FROM calendar_event_types ORDER BY sort_order
          `;
          assert.deepEqual(rows.map((r) => r.slug), [...SEED_EVENT_TYPE_SLUGS]);
          for (const r of rows) assert.ok(r.duration_minutes > 0, `durata di ${r.slug}`);
        },
      },
      {
        name: 'schedule di default lun-ven 09-13 e 14-18',
        run: async () => {
          const rows = await sql<Array<{ day_of_week: number; start_time: string; end_time: string }>>`
            SELECT s.day_of_week, to_char(s.start_time, 'HH24:MI') AS start_time, to_char(s.end_time, 'HH24:MI') AS end_time
            FROM calendar_availability_slots s
            JOIN calendar_availability_schedules sch ON sch.id = s.schedule_id
            WHERE sch.is_default = true
            ORDER BY s.day_of_week, s.start_time
          `;
          assert.deepEqual(
            rows.map((r) => ({ day: r.day_of_week, start: r.start_time, end: r.end_time })),
            OFFICE_HOURS.map((s) => ({ ...s })),
          );
        },
      },
      {
        name: 'URL del feed ICS dei calendari seminati: token di 32 caratteri nel percorso pubblico',
        run: async () => {
          for (const cal of await listCalendars()) {
            // getCalendarByFeedToken accetta solo token di 32 caratteri.
            assert.equal(cal.ics_feed_token.length, 32, `token del feed di ${cal.slug}`);
            assert.equal(buildFeedUrl(cal), `${TEST_ENV.PUBLIC_API_URL}/api/calendar/feed/${cal.ics_feed_token}.ics`);
          }
        },
      },
    ],
  },
  {
    source: 'verify-calendar-schema.ts',
    title: 'vincoli e pulizia di Google Calendar',
    cases: [
      {
        name: 'EXCLUDE constraint calendar_bookings_no_overlap attiva',
        run: async () => {
          const rows = await sql`
            SELECT conname FROM pg_constraint
            WHERE conrelid = 'calendar_bookings'::regclass AND conname = 'calendar_bookings_no_overlap'
          `;
          assert.equal(rows.length, 1, 'constraint missing');
        },
      },
      {
        name: 'google_oauth_tokens eliminata',
        run: async () => {
          const [row] = await sql<Array<{ t: string | null }>>`SELECT to_regclass('public.google_oauth_tokens')::text AS t`;
          assert.equal(row.t, null, 'table still present');
        },
      },
      {
        name: 'legacy_google_calendar_events rinominata o assente (informativo)',
        run: async (t) => {
          const [row] = await sql<Array<{ t: string | null }>>`SELECT to_regclass('public.legacy_google_calendar_events')::text AS t`;
          // Lo script non fallisce in nessuno dei due casi: lo riporta e basta.
          t.diagnostic(row.t !== null ? 'renamed table present' : 'not present');
        },
      },
    ],
  },

  // ─── verify-calendar.ts: controlli senza database ───
  {
    source: 'verify-calendar.ts',
    title: 'hardening: validateCustomResponses',
    cases: [
      {
        name: 'required mancante -> rifiutato',
        run: () => {
          assert.throws(() => validateCustomResponses(CUSTOM_QUESTIONS, {}), BookingValidationError, 'accettato payload senza required');
        },
      },
      {
        name: 'select fuori opzioni -> rifiutato',
        run: () => {
          assert.throws(() => validateCustomResponses(CUSTOM_QUESTIONS, { budget: 'tutto' }), BookingValidationError, 'accettata opzione non valida');
        },
      },
      {
        name: 'payload valido -> chiavi sconosciute scartate',
        run: () => {
          const out = validateCustomResponses(CUSTOM_QUESTIONS, { budget: '1-5k', extra: 'x' });
          assert.equal(out.budget, '1-5k', 'risposta persa');
          assert.ok(!('extra' in out), 'chiave sconosciuta non scartata');
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'hardening: assertPublicUrl (SSRF)',
    cases: [
      ...PRIVATE_URLS.map((url) => ({
        name: `blocca ${url}`,
        run: async () => {
          await assert.rejects(assertPublicUrl(url), IcsImportError, 'URL privato accettato');
        },
      })),
      {
        name: 'accetta IP pubblico',
        run: async () => {
          await assertPublicUrl('https://93.184.216.34/calendar.ics');
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'token HMAC',
    cases: [
      {
        name: 'sign/verify round-trip',
        run: () => {
          // Lo script salta il caso senza secret: nei test BOOKING_TOKEN_SECRET è sempre impostato.
          assert.ok(isTokenSecretConfigured(), 'BOOKING_TOKEN_SECRET/JWT_SECRET non configurati');
          const token = signBookingToken('smoketest12ab');
          assert.ok(verifyBookingToken(token, 'smoketest12ab'), 'verifica fallita');
          assert.equal(verifyBookingToken(token, 'altro-uid0000'), null, 'uid mismatch accettato');
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'statico: nessun tool agent su cal_bookings',
    cases: [
      {
        name: 'tools.ts senza query su cal_bookings',
        run: () => {
          const src = readFileSync(resolve(SRC_DIR, 'lib/agent/tools.ts'), 'utf8');
          assert.doesNotMatch(src, /(FROM|INSERT\s+INTO|UPDATE)\s+cal_bookings\b/i, 'query su cal_bookings ancora presente');
        },
      },
    ],
  },

  // ─── verify-calendar.ts: controlli sul database ───
  {
    source: 'verify-calendar.ts',
    title: 'tipi di prenotazione',
    cases: [
      {
        name: 'lista pubblica >= 1 attivo',
        run: async () => {
          const [row] = await sql<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM calendar_event_types WHERE is_active AND is_public
          `;
          assert.ok(row.n >= 1, 'nessun event type pubblico attivo');
        },
      },
      {
        name: 'consulenza-gratuita-30min esiste',
        run: async () => {
          assert.ok(await getEventType('consulenza-gratuita-30min'), 'slug seed mancante');
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'calcolo degli slot',
    cases: [
      {
        name: 'slots 14 giorni, tz Europe/Rome, allineamento 30min',
        run: async () => {
          const et = await smokeEventType({ requiresApproval: false });
          const result = await computeAvailableSlots({
            eventTypeIdOrSlug: et.slug,
            fromDateLocal: romeDatePlus(0),
            toDateLocal: romeDatePlus(14),
          });
          assert.ok(result, 'event type non trovato');
          assert.equal(result.timezone, 'Europe/Rome');
          assert.ok(result.slots.length > 0, 'nessuno slot disponibile');
          const now = Date.now();
          for (const s of result.slots) {
            assert.ok(new Date(s.start).getTime() >= now, `slot nel passato: ${s.start}`);
            assert.equal(new Date(s.start).getUTCMinutes() % 30, 0, `slot non allineato: ${s.start}`);
          }
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'ciclo prenotazione (motore live)',
    cases: [
      {
        name: 'create -> confirmed + calendar_event linkato',
        run: async () => {
          const et = await smokeEventType({ requiresApproval: false });
          const [slot] = await firstFreeSlots(et, 1);
          const booking = await book(et, slot.start, 'admin_manual', 'Smoke Test');
          assert.equal(booking.status, 'confirmed');
          assert.ok(await getEventBySource('booking', booking.uid), 'calendar_event mancante');
        },
      },
      {
        name: 'doppio create stesso slot -> BookingConflictError',
        run: async () => {
          const et = await smokeEventType({ requiresApproval: false });
          const [slot] = await firstFreeSlots(et, 1);
          const first = await book(et, slot.start, 'admin_manual', 'Smoke Test');
          await assert.rejects(
            book(et, new Date(first.start_time).toISOString(), 'admin_manual', 'Smoke Dup'),
            BookingConflictError,
            'double-booking accettato',
          );
        },
      },
      {
        name: 'reschedule -> vecchia cancelled + rescheduled_from_uid',
        run: async () => {
          const et = await smokeEventType({ requiresApproval: false });
          const [slot] = await firstFreeSlots(et, 1);
          const original = await book(et, slot.start, 'admin_manual', 'Smoke Test');
          const [next] = await firstFreeSlots(et, 1);
          const { booking } = await rescheduleBooking(original.uid, next.start, { by: 'admin' });
          assert.equal(booking.rescheduled_from_uid, original.uid, 'link al precedente mancante');
          assert.equal(await bookingStatus(original.uid), 'cancelled');
          const oldEvent = await getEventBySource('booking', original.uid);
          if (oldEvent) assert.equal(oldEvent.status, 'cancelled', 'vecchio evento non cancellato');
        },
      },
      {
        name: 'cancel -> booking + evento cancellati',
        run: async () => {
          // Come lo script: si annulla la prenotazione nata dalla riprogrammazione.
          const et = await smokeEventType({ requiresApproval: false });
          const [slot] = await firstFreeSlots(et, 1);
          const original = await book(et, slot.start, 'admin_manual', 'Smoke Test');
          const [next] = await firstFreeSlots(et, 1);
          const { booking: rescheduled } = await rescheduleBooking(original.uid, next.start, { by: 'admin' });
          const result = await cancelBooking(rescheduled.uid, { cancelled_by: 'admin', reason: 'smoke test' });
          assert.equal(result?.booking.status, 'cancelled', 'cancel fallito');
          const linked = await getEventBySource('booking', rescheduled.uid);
          if (linked) assert.equal(linked.status, 'cancelled', 'evento non cancellato');
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'flusso di approvazione',
    cases: [
      {
        name: 'create public su requires_approval -> pending, nessun evento',
        run: async () => {
          const et = await smokeEventType({ requiresApproval: true });
          const [slot] = await firstFreeSlots(et, 1);
          const booking = await book(et, slot.start, 'public_page', 'Smoke Pending');
          assert.equal(booking.status, 'pending');
          assert.equal(await getEventBySource('booking', booking.uid), null, "calendar_event creato prima dell'approvazione");
        },
      },
      {
        name: 'pending blocca lo slot (conflict)',
        run: async () => {
          const et = await smokeEventType({ requiresApproval: true });
          const [slot] = await firstFreeSlots(et, 1);
          const pending = await book(et, slot.start, 'public_page', 'Smoke Pending');
          await assert.rejects(
            book(et, new Date(pending.start_time).toISOString(), 'public_page', 'Smoke Dup2'),
            BookingConflictError,
            'slot pending prenotabile da altri',
          );
        },
      },
      {
        name: 'approve -> confirmed + approved_at + evento creato',
        run: async () => {
          const et = await smokeEventType({ requiresApproval: true });
          const [slot] = await firstFreeSlots(et, 1);
          const pending = await book(et, slot.start, 'public_page', 'Smoke Pending');
          const result = await approveBooking(pending.uid);
          assert.equal(result?.booking.status, 'confirmed', 'approve fallito');
          assert.ok(result?.booking.approved_at, 'approved_at mancante');
          assert.ok(await getEventBySource('booking', pending.uid), 'calendar_event mancante dopo approve');
        },
      },
      {
        name: 'reject su pending -> cancelled con reason',
        run: async () => {
          const et = await smokeEventType({ requiresApproval: true });
          const [slot] = await firstFreeSlots(et, 1);
          const pending = await book(et, slot.start, 'public_page', 'Smoke Reject');
          const result = await rejectBooking(pending.uid, 'smoke reject');
          assert.equal(result?.booking.status, 'cancelled', 'reject fallito');
          assert.match(result?.booking.cancellation_reason ?? '', /smoke reject/, 'reason mancante');
        },
      },
      {
        name: 'admin_manual su requires_approval -> resta confirmed',
        run: async () => {
          const et = await smokeEventType({ requiresApproval: true });
          const [slot] = await firstFreeSlots(et, 1);
          const booking = await book(et, slot.start, 'admin_manual', 'Smoke Admin');
          assert.equal(booking.status, 'confirmed');
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'ICS',
    cases: [
      {
        name: 'buildIcs: VEVENT, UID, DTSTART UTC, no VTIMEZONE',
        run: async () => {
          // Come lo script: la prenotazione approvata del flusso di approvazione.
          const et = await smokeEventType({ requiresApproval: true });
          const [slot] = await firstFreeSlots(et, 1);
          const pending = await book(et, slot.start, 'public_page', 'Smoke Pending');
          await approveBooking(pending.uid);
          const [row] = await sql<Booking[]>`SELECT * FROM calendar_bookings WHERE uid = ${pending.uid}`;
          const eventType = await getEventType(et.slug);
          assert.ok(eventType, 'event type mancante');
          const ics = buildIcs({
            booking: row,
            eventType,
            organizerName: 'Smoke Test',
            organizerEmail: 'smoke@test.invalid',
          });
          assert.ok(ics.includes('BEGIN:VEVENT'), 'VEVENT mancante');
          assert.ok(ics.includes('UID:'), 'UID mancante');
          assert.match(ics, /DTSTART:\d{8}T\d{6}Z/, 'DTSTART non UTC');
          assert.ok(!ics.includes('BEGIN:VTIMEZONE'), 'VTIMEZONE morto ancora presente');
        },
      },
      {
        name: 'buildIcsFeed produce un feed valido',
        run: async () => {
          const cal = await getDefaultCalendar();
          assert.ok(cal, 'calendario default mancante');
          const feed = buildIcsFeed({ calendar: cal, events: [] });
          assert.ok(feed.includes('BEGIN:VCALENDAR') && feed.includes('END:VCALENDAR'), 'feed non valido');
          assert.ok(!feed.includes('BEGIN:VTIMEZONE'), 'VTIMEZONE morto ancora presente nel feed');
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'app-password CalDAV',
    cases: [
      {
        name: 'create/verify/revoke round-trip',
        run: async () => {
          const { password, row } = await fx.appPassword({ username: 'verify-smoke', device: 'verify-calendar-smoke' });
          assert.equal((await verifyCredentials('verify-smoke', password)).ok, true, 'verifica credenziali fallita');
          assert.equal((await verifyCredentials('verify-smoke', 'password-sbagliata')).ok, false, 'password errata accettata');
          assert.equal(await revokeAppPassword(row.id), true, 'revoca fallita');
          assert.equal((await verifyCredentials('verify-smoke', password)).ok, false, 'password revocata ancora valida');
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'ICS pull anti-wipe',
    cases: [
      {
        name: 'parseIcs rifiuta una pagina HTML (non VCALENDAR)',
        run: () => {
          assert.throws(() => parseIcs('<html><body>errore</body></html>'), IcsImportError, 'HTML accettato come calendario');
        },
      },
      {
        name: 'parseIcs rifiuta un body vuoto',
        run: () => {
          assert.throws(() => parseIcs(''), IcsImportError, 'body vuoto accettato come calendario');
        },
      },
      {
        name: 'feed vuoto NON cancella gli eventi locali (rollback)',
        run: async () => {
          const { calendarId, subscriptionId } = await antiWipeFixture();
          const seeded = await replaceSubscriptionEvents(subscriptionId, calendarId, [parsedEvent('smoke-a'), parsedEvent('smoke-b')]);
          assert.equal(seeded.inserted, 2);
          await assert.rejects(replaceSubscriptionEvents(subscriptionId, calendarId, []), IcsImportError, 'replace con feed vuoto non ha lanciato');
          assert.equal(await subscriptionEventCount(subscriptionId), 2, 'rollback mancato');
        },
      },
      {
        name: 'allowEmpty (force) svuota davvero',
        run: async () => {
          const { calendarId, subscriptionId } = await antiWipeFixture();
          await replaceSubscriptionEvents(subscriptionId, calendarId, [parsedEvent('smoke-a'), parsedEvent('smoke-b')]);
          const res = await replaceSubscriptionEvents(subscriptionId, calendarId, [], { allowEmpty: true });
          assert.equal(res.removed, 2);
          assert.equal(await subscriptionEventCount(subscriptionId), 0);
        },
      },
      {
        name: 'eventi ics_pull sono read-only (update/delete → EventReadOnlyError)',
        run: async () => {
          const { calendarId, subscriptionId } = await antiWipeFixture();
          await replaceSubscriptionEvents(subscriptionId, calendarId, [parsedEvent('smoke-ro', 'Smoke read-only')]);
          const [ev] = await sql<Array<{ id: string }>>`
            SELECT id FROM calendar_events WHERE subscription_id = ${subscriptionId}::uuid LIMIT 1
          `;
          assert.ok(ev, 'evento importato mancante');
          await assert.rejects(updateEvent(ev.id, { summary: 'rinominato' }), EventReadOnlyError);
          await assert.rejects(deleteEvent(ev.id), EventReadOnlyError);
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'occorrenze cancellate (override)',
    cases: [
      {
        name: "override cancellato sopprime l'occorrenza; niente duplicati; delete cascata",
        run: async () => {
          const cal = await smokeCalendar();
          // Domani, stessa ora per 5 giorni. I millisecondi non allineati
          // riproducono Date.now() dello script: l'espansione RRULE li tronca,
          // recurrence_id li conserva e l'abbinamento avviene al secondo.
          const base = new Date('2027-01-05T09:00:00.123Z').getTime();
          const master = await createEvent({
            calendar_id: cal.id,
            summary: fx.name('Smoke serie'),
            start_time: new Date(base).toISOString(),
            end_time: new Date(base + HOUR_MS).toISOString(),
            rrule: 'FREQ=DAILY',
            source: 'admin',
          });
          fx.track('eventIds', master.id);
          const day3 = new Date(base + 2 * DAY_MS).toISOString();
          await createOccurrenceOverride({ masterEventId: master.id, originalStartIso: day3, status: 'cancelled' });
          // Click ripetuto: non deve creare una seconda riga.
          await createOccurrenceOverride({ masterEventId: master.id, originalStartIso: day3, status: 'cancelled' });
          const overrideCount = async (): Promise<number> => (await sql<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM calendar_events WHERE recurrence_master_id = ${master.id}::uuid
          `)[0].n;
          assert.equal(await overrideCount(), 1, 'attesa 1 riga override');

          const range = { calendarId: cal.id, fromIso: new Date(base - HOUR_MS).toISOString(), toIso: new Date(base + 5 * DAY_MS).toISOString() };
          const serie = (await listOccurrences(range)).filter((o) => o.summary === fx.name('Smoke serie'));
          // Confronto a precisione di secondo: l'espansione RRULE tronca i ms.
          const day3Sec = Math.floor(new Date(day3).getTime() / 1000);
          assert.ok(
            !serie.some((o) => Math.floor(new Date(o.start_time).getTime() / 1000) === day3Sec),
            "occorrenza cancellata ancora presente nell'espansione",
          );
          // Range [base-1h, base+5g] inclusivo → 6 espansioni giornaliere, meno la cancellata.
          assert.equal(serie.length, 5, 'attese 5 occorrenze visibili su 6');

          const withCancelled = await listOccurrences({ ...range, includeCancelled: true });
          assert.ok(
            withCancelled.some((o) => o.is_override && o.status === 'cancelled'),
            "includeCancelled non restituisce l'override cancellato",
          );

          // Cascata sugli override figli (lo script la esegue nel finally).
          assert.equal(await deleteEvent(master.id), true);
          assert.equal(await overrideCount(), 0, 'override sopravvissuti alla cancellazione del master');
        },
      },
    ],
  },
  {
    source: 'verify-calendar.ts',
    title: 'igiene dei dati',
    cases: [
      {
        name: "0 bookings con status='rescheduled'",
        run: async () => {
          const [row] = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM calendar_bookings WHERE status = 'rescheduled'`;
          assert.equal(row.n, 0, `${row.n} righe legacy`);
        },
      },
      {
        name: 'nessun booking con end <= start',
        run: async () => {
          const [row] = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM calendar_bookings WHERE end_time <= start_time`;
          assert.equal(row.n, 0, `${row.n} righe incoerenti`);
        },
      },
    ],
  },
];

// ─── Registrazione ───────────────────────────────

describe(`casi legacy di verify-calendar*.ts [store: ${STORE}]`, {
  skip: STORE === 'postgres' ? false : `store "${STORE}" non ancora collegato ai casi legacy (arriva in F2 con la facade store())`,
}, () => {
  for (const section of SECTIONS) {
    describe(`${section.source} › ${section.title}`, () => {
      for (const c of section.cases) test(c.name, c.run);
    });
  }
});
