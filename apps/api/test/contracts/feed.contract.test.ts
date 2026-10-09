/**
 * Contratto del feed ICS pubblico (F0, design §10 e §15):
 * GET /api/calendar/feed/<token>.ics, usato da iPhone, macOS, Outlook e
 * Thunderbird per gli abbonamenti ai calendari (compreso 'f' per le festività).
 *
 * Si congelano: header (text/calendar, Cache-Control private 5 minuti, CORS *,
 * nessun ETag), corpo normalizzato (righe dopo l'unfold, DTSTAMP e UID
 * sostituiti), finestra degli eventi (singoli da -90 a +365 giorni, serie
 * sempre), filtri (niente cancellati, niente eventi delle iscrizioni, niente
 * altri calendari), serie con TZID Europe/Rome e VTIMEZONE, all-day come DATE,
 * escaping e folding RFC 5545, token disabilitato e rigenerazione dall'admin.
 *
 * Gli snapshot sono in __snapshots__/feed.contract.json. In F2 il feed nasce
 * dall'indice di Radicale: le differenze previste (override nella risorsa del
 * master, cancellazioni come EXDATE, DTSTAMP stabile, ETag) entreranno in
 * allowed-diffs.json con la loro motivazione.
 *
 * Comportamenti attuali congelati qui e da correggere dopo F0 (design §14),
 * ciascuno commentato nel caso relativo:
 *  - un'occorrenza cancellata con override ricompare negli abbonati: il master
 *    esce senza EXDATE per quella data e l'override cancellato è filtrato;
 *  - gli override escono con un UID proprio, diverso da quello del master
 *    (RFC 5545 vuole lo stesso UID con RECURRENCE-ID);
 *  - gli override di un master cancellato escono da soli (RECURRENCE-ID senza
 *    master);
 *  - DTSTAMP è l'ora della richiesta e non c'è ETag: ogni lettura cambia il
 *    corpo anche senza modifiche.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { onDatabaseReady, sql } from '../helpers/db';
import { api, type TestResponse } from '../helpers/http';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { createNormalizer, type SnapshotNormalizer } from '../helpers/normalize';
import { freezeTime, restoreTime } from '../helpers/clock';
import { cancelBooking } from '../../src/lib/calendar/booking';
import { getBookingsCalendar } from '../../src/lib/calendar/calendars';
import { updateEvent } from '../../src/lib/calendar/events';
import type { Calendar, CalendarEvent } from '../../src/lib/calendar/types';
import {
  contractCoverageTest,
  type HttpContractRequest,
  httpContractStore,
  icsEvents,
  icsProp,
  responseEntry,
  type ResponseEntryOptions,
  unfoldIcs,
} from './_http-contract';

const fx = useFixtures('contratto-feed', { resetBaseline: true });

const store = httpContractStore(
  'feed',
  'feed.contract.test.ts',
  'Feed ICS pubblico GET /api/calendar/feed/<token>.ics e gestione del token dall\'admin (toggle e rotate-token) ' +
    'sullo scenario di test/contracts/feed.contract.test.ts: richiesta, status, header e corpo normalizzati ' +
    '(righe iCalendar dopo l\'unfold, DTSTAMP e UID sostituiti). Baseline F0 su PgLegacyStore.',
);

/** "Adesso": venerdì 5 marzo 2027, 08:00 a Roma. Finestra dei singoli: 5 dicembre 2026 → 4 marzo 2028. */
const NOW = '2027-03-05T07:00:00.000Z';
const NOW_ICS = '20270305T070000Z';

/** Dominio degli UID del feed: host di PUBLIC_API_URL (helpers/env.ts). */
const UID_DOMAIN = 'api.caldes.test';

interface Scenario {
  shared: Calendar;
  other: Calendar;
  holidays: Calendar;
  bookings: Calendar;
  weekly: { master: CalendarEvent; moved: CalendarEvent; cancelled: CalendarEvent };
  cancelledSeries: { master: CalendarEvent; override: CalendarEvent };
  /** Uid delle prenotazioni proiettate in 'bookings' (citati nelle descrizioni). */
  bookingUids: { confirmed: string; cancelled: string };
}

let s: Scenario;

// ─── Scenario ───────────────────────────────

async function buildScenario(): Promise<Scenario> {
  const shared = await fx.calendar({
    key: 'condiviso', name: 'Agenda condivisa', description: 'Calendario condiviso con gli abbonati',
    color: '#22c55e', blocks_availability: false,
  });
  const other = await fx.calendar({ key: 'altro', name: 'Altro calendario', blocks_availability: false });

  // Singoli: escaping (virgole, punti e virgola, a capo, backslash), URL,
  // folding di un titolo lungo con lettere accentate, tentative.
  await fx.event({
    calendar: shared, summary: 'Riunione con il cliente, revisione; budget',
    description: 'Prima riga\nSeconda riga con \\ backslash',
    location: 'Sala 2, piano 1', url: 'https://example.test/riunione?x=1&y=2',
    start_time: romeIso('2027-03-10', '10:00'), end_time: romeIso('2027-03-10', '11:00'),
  });
  await fx.event({
    calendar: shared,
    summary: 'Revisione trimestrale del progetto con il cliente: perché è così importante andare più a fondo',
    start_time: romeIso('2027-03-11', '14:00'), end_time: romeIso('2027-03-11', '15:30'),
  });
  await fx.event({
    calendar: shared, summary: 'Da confermare', status: 'tentative',
    start_time: romeIso('2027-03-18', '16:00'), end_time: romeIso('2027-03-18', '17:00'),
  });
  // All-day di uno e di due giorni (mezzanotte di Roma, come l'editor admin).
  await fx.allDayEvent({ calendar: shared, summary: 'Giornata di formazione', date: '2027-03-12' });
  await fx.allDayEvent({ calendar: shared, summary: 'Fiera', date: '2027-03-15', days: 2 });

  // Serie settimanale del lunedì 09:00-09:30 attraverso il cambio dell'ora:
  // il 15 escluso con EXDATE, il 22 spostato alle 11:00, il 29 cancellato.
  const weekly = await fx.series({
    calendar: shared, summary: 'Riunione settimanale',
    start_time: romeIso('2027-03-08', '09:00'), end_time: romeIso('2027-03-08', '09:30'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=6',
    exdates: [romeIso('2027-03-15', '09:00')],
    overrides: [
      { originalStart: romeIso('2027-03-22', '09:00'), start: romeIso('2027-03-22', '11:00'), end: romeIso('2027-03-22', '11:30'), summary: 'Riunione settimanale (spostata)' },
      { originalStart: romeIso('2027-03-29', '09:00'), status: 'cancelled' },
    ],
  });
  // Serie iniziata molto prima della finestra: le serie escono sempre.
  await fx.event({
    calendar: shared, summary: 'Report mensile', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
    start_time: romeIso('2025-01-01', '08:00'), end_time: romeIso('2025-01-01', '08:30'),
  });
  // Serie con il master cancellato e un override confermato.
  const cancelledSeries = await fx.series({
    calendar: shared, summary: 'Corso annullato',
    start_time: romeIso('2027-04-06', '18:00'), end_time: romeIso('2027-04-06', '19:00'),
    rrule: 'FREQ=WEEKLY;COUNT=4',
    overrides: [{ originalStart: romeIso('2027-04-13', '18:00'), start: romeIso('2027-04-13', '18:30'), end: romeIso('2027-04-13', '19:30') }],
  });
  const cancelledMaster = await updateEvent(cancelledSeries.master.id, { status: 'cancelled' });
  assert.ok(cancelledMaster);

  // Esclusi: cancellato, fuori finestra (prima e dopo), altro calendario,
  // iscrizione ICS nello stesso calendario. Inclusi i due vicini ai bordi.
  await fx.event({ calendar: shared, summary: 'Annullato', status: 'cancelled', start_time: romeIso('2027-03-17', '10:00'), end_time: romeIso('2027-03-17', '11:00') });
  await fx.event({ calendar: shared, summary: 'Troppo vecchio', start_time: romeIso('2026-11-30', '10:00'), end_time: romeIso('2026-11-30', '11:00') });
  await fx.event({ calendar: shared, summary: 'Evento di dicembre', start_time: romeIso('2026-12-10', '10:00'), end_time: romeIso('2026-12-10', '11:00') });
  await fx.event({ calendar: shared, summary: 'Lontano ma incluso', start_time: romeIso('2028-02-20', '10:00'), end_time: romeIso('2028-02-20', '11:00') });
  await fx.event({ calendar: shared, summary: 'Troppo lontano', start_time: romeIso('2028-03-10', '10:00'), end_time: romeIso('2028-03-10', '11:00') });
  await fx.event({ calendar: other, summary: 'In un altro calendario', start_time: romeIso('2027-03-10', '12:00'), end_time: romeIso('2027-03-10', '13:00') });
  await fx.subscription({
    calendar: shared,
    events: [{
      remote_uid: 'esterno@example.test', summary: 'Dal calendario esterno',
      description: null, location: null, url: null,
      start_time: romeIso('2027-03-10', '15:00'), end_time: romeIso('2027-03-10', '16:00'),
      all_day: false, rrule: null, exdates: [], recurrence_id: null, status: 'confirmed',
    }],
  });

  // Calendario 'f': festività del cron (una passata, nella finestra) e una chiusura.
  const holidays = await fx.holidayCalendar();
  await fx.holidays(holidays, { year: 2026, only: ['2026-12-25'] });
  await fx.holidays(holidays, { year: 2027, only: ['2027-06-02'] });
  await fx.closure(holidays, { from: '2027-08-09', to: '2027-08-13', summary: 'Ferie estive' });

  // Calendario 'bookings' (seminato): una proiezione confermata, una
  // annullata (esclusa) e un evento manuale (decisione 8: resta lì).
  const bookings = await getBookingsCalendar();
  assert.ok(bookings, "Calendario 'bookings' assente: il database non è migrato?");
  const eventType = await fx.eventType({ key: 'consulenza', title: 'Consulenza', durationMinutes: 60 });
  const confirmed = await fx.booking({ eventType, start: romeIso('2027-03-10', '15:00'), attendee: { name: 'Mario Rossi', phone: '+39 06 1234567' } });
  const toCancel = await fx.booking({ eventType, start: romeIso('2027-03-11', '15:00'), attendee: { name: 'Lucia Bianchi' } });
  assert.ok(await cancelBooking(toCancel.booking.uid, { cancelled_by: 'admin', reason: 'Test' }));
  await fx.event({
    calendar: bookings, summary: 'Evento manuale in Prenotazioni',
    start_time: romeIso('2027-03-12', '15:00'), end_time: romeIso('2027-03-12', '16:00'),
  });

  return {
    shared,
    other,
    holidays,
    bookings,
    weekly: { master: weekly.master, moved: weekly.overrides[0], cancelled: weekly.overrides[1] },
    cancelledSeries: { master: cancelledMaster, override: cancelledSeries.overrides[0] },
    bookingUids: { confirmed: confirmed.booking.uid, cancelled: toCancel.booking.uid },
  };
}

// Scenario dopo migrazioni, baseline e pre-pulizia (onDatabaseReady): i
// before() di primo livello su Node 22 partono in parallelo.
onDatabaseReady(async () => {
  freezeTime(NOW);
  s = await buildScenario();
});

after(() => {
  restoreTime();
  store.flush();
});

// ─── Utilità ───────────────────────────────

function feedPath(token: string): string {
  return `/api/calendar/feed/${token}.ics`;
}

/** Token del feed letto dal database (cambia con rotate-token). */
async function feedToken(calendar: Calendar): Promise<string> {
  const [row] = await sql<Array<{ ics_feed_token: string }>>`SELECT ics_feed_token FROM calendars WHERE id = ${calendar.id}::uuid`;
  return row.ics_feed_token;
}

/** Normalizzatore del caso: prefisso, id dei calendari e token noti con nomi leggibili. */
function normalizer(tokens: Record<string, string> = {}): SnapshotNormalizer {
  const n = createNormalizer({ prefixes: [fx.prefix] });
  n.alias(s.shared.id, 'calendar:condiviso').alias(s.holidays.id, 'calendar:f').alias(s.bookings.id, 'calendar:bookings');
  n.alias(s.bookingUids.confirmed, 'booking:confermata').alias(s.bookingUids.cancelled, 'booking:annullata');
  for (const [label, token] of Object.entries(tokens)) n.alias(token, `token:${label}`);
  return n;
}

function record(
  caseId: string,
  res: TestResponse,
  n: SnapshotNormalizer,
  request: HttpContractRequest,
  opts: Omit<ResponseEntryOptions, 'request'> = {},
): void {
  store.check(caseId, responseEntry(res, n, { request, ...opts }));
}

/** Header comuni a ogni feed servito. */
function assertFeedHeaders(res: TestResponse, slug: string): void {
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(res.headers.get('content-disposition'), `inline; filename="${slug}.ics"`);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  // Nessun ETag oggi: i client riscaricano tutto il feed a ogni refresh.
  assert.equal(res.headers.get('etag'), null);
  assert.ok(res.text.endsWith('\r\n'), 'il corpo termina con CRLF');
  for (const line of res.text.split('\r\n')) {
    assert.ok(Buffer.byteLength(line) <= 75, `riga oltre 75 ottetti: ${line}`);
  }
}

// ─── Feed ───────────────────────────────

test('feed: calendario con singoli, all-day, serie, override, iscrizione e finestra temporale', async () => {
  const token = await feedToken(s.shared);
  const res = await api.get(feedPath(token));
  assertFeedHeaders(res, s.shared.slug);

  const lines = unfoldIcs(res.text);
  assert.deepEqual(lines.slice(0, 9), [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Caldes//Calendar//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${fx.prefix} Agenda condivisa`,
    'X-WR-CALDESC:Calendario condiviso con gli abbonati',
    'X-WR-TIMEZONE:Europe/Rome',
    'X-APPLE-CALENDAR-COLOR:#22c55e',
  ]);
  assert.equal(lines.filter((l) => l === 'BEGIN:VTIMEZONE').length, 1, 'un solo VTIMEZONE per le serie');
  assert.ok(!/BEGIN:VALARM|ORGANIZER|ATTENDEE/.test(res.text), 'niente VALARM, ORGANIZER né ATTENDEE');

  const events = icsEvents(res.text);
  const summary = (e: string[]): string => (icsProp(e, 'SUMMARY') ?? '').replace(`${fx.prefix} `, '');
  // Ordine per start_time; esclusi cancellati, fuori finestra, altro
  // calendario e iscrizione; le serie escono anche se iniziate prima.
  assert.deepEqual(events.map(summary), [
    'Report mensile',
    'Evento di dicembre',
    'Riunione settimanale',
    'Riunione con il cliente\\, revisione\\; budget',
    'Revisione trimestrale del progetto con il cliente: perché è così importante andare più a fondo',
    'Giornata di formazione',
    'Fiera',
    'Da confermare',
    'Riunione settimanale (spostata)',
    'Corso annullato',
    'Lontano ma incluso',
  ]);
  const byName = (name: string): string[] => events.find((e) => summary(e) === name)!;

  // Serie: ora locale con TZID, RRULE ed EXDATE nello stesso formato.
  const master = byName('Riunione settimanale');
  assert.equal(icsProp(master, 'UID'), `${s.weekly.master.uid}@${UID_DOMAIN}`);
  assert.ok(master.includes('DTSTART;TZID=Europe/Rome:20270308T090000'));
  assert.ok(master.includes('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6'));
  // BUG ATTUALE (design §14, "override cancellati che ricompaiono"): l'override
  // cancellato del 29 marzo è filtrato e il master non ha l'EXDATE del 29,
  // quindi negli abbonati l'occorrenza cancellata ricompare.
  assert.ok(master.includes('EXDATE;TZID=Europe/Rome:20270315T090000'), 'solo l\'EXDATE salvata, senza il 29');

  // Override spostato: RECURRENCE-ID con l'ora originale.
  const moved = byName('Riunione settimanale (spostata)');
  assert.ok(moved.includes('RECURRENCE-ID;TZID=Europe/Rome:20270322T090000'));
  assert.ok(moved.includes('DTSTART;TZID=Europe/Rome:20270322T110000'));
  // BUG ATTUALE (design §14, "UID degli override diversi"): l'override esce
  // con il proprio uid invece di quello del master.
  assert.equal(icsProp(moved, 'UID'), `${s.weekly.moved.uid}@${UID_DOMAIN}`);
  assert.notEqual(icsProp(moved, 'UID'), icsProp(master, 'UID'));

  // BUG ATTUALE: master cancellato escluso, ma il suo override confermato esce
  // da solo con RECURRENCE-ID (orfano negli abbonati).
  const orphan = byName('Corso annullato');
  assert.equal(icsProp(orphan, 'UID'), `${s.cancelledSeries.override.uid}@${UID_DOMAIN}`);
  assert.ok(orphan.some((l) => l.startsWith('RECURRENCE-ID;TZID=Europe/Rome:20270413T180000')));
  assert.ok(!events.some((e) => icsProp(e, 'UID') === `${s.cancelledSeries.master.uid}@${UID_DOMAIN}`));

  // Singoli in UTC; all-day come DATE (fine esclusiva); tentative.
  assert.ok(byName('Evento di dicembre').includes('DTSTART:20261210T090000Z'));
  assert.deepEqual(
    byName('Fiera').filter((l) => l.startsWith('DTSTART') || l.startsWith('DTEND')),
    ['DTSTART;VALUE=DATE:20270315', 'DTEND;VALUE=DATE:20270317'],
  );
  assert.equal(icsProp(byName('Da confermare'), 'STATUS'), 'TENTATIVE');
  const meeting = byName('Riunione con il cliente\\, revisione\\; budget');
  assert.equal(icsProp(meeting, 'DESCRIPTION'), 'Prima riga\\nSeconda riga con \\\\ backslash');
  assert.equal(icsProp(meeting, 'LOCATION'), 'Sala 2\\, piano 1');
  assert.equal(icsProp(meeting, 'URL'), 'https://example.test/riunione?x=1&y=2');

  // DTSTAMP è l'ora della richiesta (qui l'orologio fermo), uguale per tutti.
  assert.deepEqual([...new Set(events.map((e) => icsProp(e, 'DTSTAMP')))], [NOW_ICS]);
  // Tutti gli eventi sono OPAQUE, anche i tentative.
  assert.ok(events.every((e) => icsProp(e, 'TRANSP') === 'OPAQUE'));

  record('feed/calendario-condiviso', res, normalizer({ condiviso: token }), { method: 'GET', path: feedPath(token) });
});

test("feed: calendario 'f' con festività del cron e chiusura", async () => {
  const token = await feedToken(s.holidays);
  const res = await api.get(feedPath(token));
  assertFeedHeaders(res, 'f');
  const events = icsEvents(res.text);
  // Festività e chiusure sono timed 00:00→24:00 di Roma, emesse in UTC.
  assert.deepEqual(
    events.map((e) => [icsProp(e, 'SUMMARY'), icsProp(e, 'DTSTART'), icsProp(e, 'DTEND')]),
    [
      ['Natale', '20261224T230000Z', '20261225T230000Z'],
      ['Festa della Repubblica', '20270601T220000Z', '20270602T220000Z'],
      [`${fx.prefix} Ferie estive`, '20270808T220000Z', '20270813T220000Z'],
    ],
  );
  assert.ok(!res.text.includes('BEGIN:VTIMEZONE'), 'nessuna serie, nessun VTIMEZONE');
  record('feed/festivita-f', res, normalizer({ f: token }), { method: 'GET', path: feedPath(token) });
});

test("feed: calendario 'bookings' con proiezioni confermate ed eventi manuali", async () => {
  const [seed] = await sql<Array<{ ics_feed_enabled: boolean; ics_feed_token: string }>>`
    SELECT ics_feed_enabled, ics_feed_token FROM calendars WHERE id = ${s.bookings.id}::uuid
  `;
  assert.ok(seed.ics_feed_enabled, "feed del calendario 'bookings' disabilitato nel database dei test");
  const res = await api.get(feedPath(seed.ics_feed_token));
  assertFeedHeaders(res, 'bookings');
  const events = icsEvents(res.text);
  assert.deepEqual(events.map((e) => (icsProp(e, 'SUMMARY') ?? '').replace(`${fx.prefix} `, '')), [
    'Consulenza – Mario Rossi',
    'Evento manuale in Prenotazioni',
  ], 'la proiezione della prenotazione annullata è esclusa');
  // La descrizione della proiezione porta nome, email e telefono del cliente.
  assert.match(icsProp(events[0], 'DESCRIPTION') ?? '', /^Cliente: Mario Rossi <.+@test\.invalid>\\nTel: \+39 06 1234567\\n/);
  record('feed/bookings', res, normalizer({ bookings: seed.ics_feed_token }), { method: 'GET', path: feedPath(seed.ics_feed_token) });
});

test('feed: token non valido (400), sconosciuto (404) e percorso senza .ics', async () => {
  const cases: Array<[string, string, number]> = [
    ['token-corto', '/api/calendar/feed/abc123.ics', 400],
    ['token-maiuscolo', `/api/calendar/feed/${'A'.repeat(32)}.ics`, 400],
    ['token-con-simboli', `/api/calendar/feed/${'a'.repeat(31)}-.ics`, 400],
    ['token-sconosciuto', `/api/calendar/feed/${'0'.repeat(32)}.ics`, 404],
  ];
  for (const [name, path, status] of cases) {
    const res = await api.get(path);
    assert.equal(res.status, status, name);
    assert.equal(res.text, status === 400 ? 'Invalid feed token' : 'Feed not found or disabled', name);
    record(`feed/${status}-${name}`, res, normalizer(), { method: 'GET', path });
  }
  // Senza estensione la route del feed non corrisponde: 404 generico dell'app.
  const token = await feedToken(s.shared);
  const bare = await api.get(`/api/calendar/feed/${token}`);
  assert.equal(bare.status, 404);
  assert.deepEqual(bare.json, { error: 'Not Found' });
  record('feed/404-senza-estensione', bare, normalizer({ condiviso: token }), { method: 'GET', path: `/api/calendar/feed/${token}` });
});

test('feed: disattivato dall\'admin → 404 con lo stesso token; riattivato → di nuovo 200', async () => {
  const cal = await fx.calendar({ key: 'toggle', name: 'Feed da disattivare', blocks_availability: false });
  await fx.event({ calendar: cal, summary: 'Evento del feed', start_time: romeIso('2027-03-10', '09:00'), end_time: romeIso('2027-03-10', '10:00') });
  const token = cal.ics_feed_token;
  const n = () => normalizer({ toggle: token }).alias(cal.id, 'calendar:toggle');
  assert.equal((await api.get(feedPath(token))).status, 200);

  const off = await api.put(`/api/admin/calendar/calendars/${cal.id}`, { auth: 'admin', body: { ics_feed_enabled: false } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.calendar.ics_feed_enabled, false);
  assert.equal(off.json.calendar.ics_feed_url, null);
  assert.equal(off.json.calendar.ics_feed_token, token, 'il token resta quello di prima');
  record('admin/feed-disattivato', off, n(), {
    method: 'PUT', path: `/api/admin/calendar/calendars/${cal.id}`, body: { ics_feed_enabled: false }, auth: 'admin',
  });

  const disabled = await api.get(feedPath(token));
  assert.equal(disabled.status, 404);
  assert.equal(disabled.text, 'Feed not found or disabled');
  record('feed/404-disattivato', disabled, n(), { method: 'GET', path: feedPath(token) });

  const on = await api.put(`/api/admin/calendar/calendars/${cal.id}`, { auth: 'admin', body: { ics_feed_enabled: true } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.calendar.ics_feed_url, `https://api.caldes.test/api/calendar/feed/${token}.ics`);
  const enabled = await api.get(feedPath(token));
  assertFeedHeaders(enabled, cal.slug);
  record('feed/riattivato', enabled, n(), { method: 'GET', path: feedPath(token) });
});

test('feed: rotate-token invalida il vecchio URL e serve il feed sul nuovo; 401 e 404', async () => {
  const cal = await fx.calendar({ key: 'rotazione', name: 'Feed da rigenerare', blocks_availability: false });
  await fx.event({ calendar: cal, summary: 'Evento del feed', start_time: romeIso('2027-03-10', '09:00'), end_time: romeIso('2027-03-10', '10:00') });
  const oldToken = cal.ics_feed_token;
  const path = `/api/admin/calendar/calendars/${cal.id}/rotate-token`;

  const unauthenticated = await api.post(path);
  assert.equal(unauthenticated.status, 401);

  const res = await api.post(path, { auth: 'admin' });
  assert.equal(res.status, 200, res.text);
  const newToken: string = res.json.calendar.ics_feed_token;
  assert.match(newToken, /^[a-z0-9]{32}$/);
  assert.notEqual(newToken, oldToken);
  assert.equal(res.json.calendar.ics_feed_url, `https://api.caldes.test/api/calendar/feed/${newToken}.ics`);
  const n = () => normalizer({ vecchio: oldToken, nuovo: newToken }).alias(cal.id, 'calendar:rotazione');
  record('admin/rotate-token', res, n(), { method: 'POST', path, auth: 'admin' });

  const old = await api.get(feedPath(oldToken));
  assert.equal(old.status, 404);
  assert.equal(old.text, 'Feed not found or disabled');
  const fresh = await api.get(feedPath(newToken));
  assertFeedHeaders(fresh, cal.slug);
  record('feed/token-rigenerato', fresh, n(), { method: 'GET', path: feedPath(newToken) });

  const missing = await api.post('/api/admin/calendar/calendars/00000000-0000-4000-8000-00000000f00d/rotate-token', { auth: 'admin' });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: 'Calendario non trovato' });
});

test('feed: rotate-token su un feed disattivato restituisce comunque un URL (che risponde 404)', async () => {
  // Comportamento attuale: PUT e GET dei calendari danno ics_feed_url null se
  // il feed è disattivato, rotate-token invece costruisce sempre l'URL.
  const cal = await fx.calendar({ key: 'rotazione-spento', name: 'Feed spento', blocks_availability: false });
  const off = await api.put(`/api/admin/calendar/calendars/${cal.id}`, { auth: 'admin', body: { ics_feed_enabled: false } });
  assert.equal(off.json.calendar.ics_feed_url, null);
  const res = await api.post(`/api/admin/calendar/calendars/${cal.id}/rotate-token`, { auth: 'admin' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.calendar.ics_feed_enabled, false);
  assert.equal(res.json.calendar.ics_feed_url, `https://api.caldes.test/api/calendar/feed/${res.json.calendar.ics_feed_token}.ics`);
  assert.equal((await api.get(feedPath(res.json.calendar.ics_feed_token))).status, 404);
});

test('feed: due letture senza modifiche danno corpi diversi solo nel DTSTAMP', async () => {
  // DTSTAMP = ora della richiesta: con l'orologio fermo i corpi coincidono, un
  // minuto dopo cambiano solo le righe DTSTAMP (nessun ETag né 304 oggi).
  const token = await feedToken(s.shared);
  const first = await api.get(feedPath(token));
  freezeTime('2027-03-05T07:01:00.000Z');
  try {
    const second = await api.get(feedPath(token));
    assert.notEqual(second.text, first.text);
    const withoutStamp = (text: string): string => text.replace(/^DTSTAMP:.*$/gm, 'DTSTAMP:');
    assert.equal(withoutStamp(second.text), withoutStamp(first.text));
    assert.match(second.text, /^DTSTAMP:20270305T070100Z\r$/m);
  } finally {
    freezeTime(NOW);
  }
});

test.todo("feed: le occorrenze cancellate con override escono come EXDATE del master (design §14 e §10)");
test.todo("feed: gli override escono nella risorsa del master con lo stesso UID (RFC 5545, design §14)");
test.todo('feed: gli override di un master cancellato non escono come VEVENT orfani (design §10, CANCELLED_MASTER)');
test.todo('feed: DTSTAMP stabile, ETag dal corpo e 304 su If-None-Match (design §10)');

// ─── Copertura ───────────────────────────────

// Dopo tutti i casi: fallisce se nello snapshot restano casi non più eseguiti.
contractCoverageTest(store, 'feed.contract.test.ts');
