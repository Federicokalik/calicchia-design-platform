/**
 * Smoke dell'infrastruttura di test: ambiente, database, app in-process, JWT,
 * fixture, orologio fisso, normalizzazione e pulizia funzionano insieme.
 *
 * Non è un test di contratto: verifica i punti di aggancio che gli altri test
 * danno per scontati. Le date sono fisse nel 2027 e "adesso" viene fermato con
 * freezeTime() dove conta, quindi l'esito non dipende dal giorno di esecuzione.
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseTestDatabaseUrl, TEST_DATABASE, withEnv } from '../helpers/env';
import { SEED_CALENDAR_SLUGS, sql, testPrefix } from '../helpers/db';
import {
  api,
  bookingManagePath,
  bookingManageToken,
  bookingManageTokenWithSecret,
  expiredBookingManageToken,
  signTestToken,
  TEST_ADMIN,
} from '../helpers/http';
import { OFFICE_HOURS, romeIso, useFixtures } from '../helpers/fixtures';
import { createNormalizer } from '../helpers/normalize';
import { freezeTime, restoreTime } from '../helpers/clock';

const fx = useFixtures('smoke-infra', { resetBaseline: true });

// Lunedì 4 gennaio 2027, 08:00 a Roma: "adesso" per i test che lo richiedono.
const NOW = '2027-01-04T07:00:00.000Z';

test('env: protezione del database e ambiente ermetico', async () => {
  const refuses = (url: string | undefined, reason: RegExp): void => {
    assert.throws(() => parseTestDatabaseUrl(url), reason);
  };
  refuses(undefined, /TEST_DATABASE_URL non impostata/);
  refuses('postgresql://caldes:caldes@db.example.com:5432/caldes_test', /non è localhost/);
  refuses('postgresql://caldes:caldes@localhost,db.example.com/caldes_test', /non è localhost/);
  refuses('postgresql://caldes:caldes@localhost:5432/caldes', /non contiene 'test' né 'caldes_f<N>'/);
  refuses('postgresql://caldes:caldes@localhost:5432/caldes_fx', /non contiene 'test' né 'caldes_f<N>'/);
  refuses('postgresql://caldes:caldes@localhost:5432/caldes_test?database=caldes', /parametro "database" non ammesso/);
  refuses('mysql://caldes:caldes@localhost:3306/caldes_test', /protocollo non supportato/);
  // La password non finisce mai nel messaggio d'errore.
  assert.throws(
    () => parseTestDatabaseUrl('postgresql://caldes:segretissima@db.example.com/caldes_test'),
    (err: Error) => !err.message.includes('segretissima'),
  );

  const accepted = parseTestDatabaseUrl('postgresql://caldes:caldes@127.0.0.1:5432/caldes_f0_x');
  assert.equal(accepted.database, 'caldes_f0_x');
  assert.equal(parseTestDatabaseUrl('postgresql://caldes:caldes@localhost/caldes_f1_found').database, 'caldes_f1_found');
  assert.match(accepted.url, /[?&]TimeZone=UTC/);

  assert.equal(process.env.DATABASE_URL, TEST_DATABASE.url);
  assert.equal(process.env.NODE_ENV, 'test');
  // TZ=UTC come il container di produzione, anche in ora legale.
  assert.equal(new Date('2027-07-01T12:00:00Z').getTimezoneOffset(), 0);
  assert.equal(process.env.RESEND_API_KEY, undefined);
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, undefined);

  await withEnv({ ORGANIZER_NAME: 'Organizzatore di prova' }, () => {
    assert.equal(process.env.ORGANIZER_NAME, 'Organizzatore di prova');
  });
  assert.equal(process.env.ORGANIZER_NAME, undefined);

  // Un prefisso che contiene (o è contenuto in) uno già usato è rifiutato.
  assert.throws(() => testPrefix('smoke'), /in conflitto/);
  assert.throws(() => testPrefix('smoke-infra-bis'), /in conflitto/);
});

test('database: connessione al DB dei test, migrazioni applicate, sessione in UTC', async () => {
  const [session] = await sql<Array<{ db: string; tz: string }>>`
    SELECT current_database() AS db, current_setting('TimeZone') AS tz
  `;
  assert.equal(session.db, TEST_DATABASE.database);
  assert.equal(session.tz, 'UTC');

  const migrationsDir = resolve(fileURLToPath(import.meta.url), '../../../../../database/migrations');
  const latest = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().at(-1);
  assert.ok(latest, 'nessuna migrazione trovata');
  const ledger = await sql<Array<{ version: string }>>`
    SELECT version FROM schema_migrations WHERE version IN (${latest}, 'base/001_schema.sql')
  `;
  assert.equal(ledger.length, 2, `migrazione ${latest} o schema base assenti dal ledger`);
});

test('baseline: dominio calendario come un database appena migrato', async () => {
  const calendars = await sql<Array<{ slug: string; is_default: boolean }>>`
    SELECT slug, is_default FROM calendars ORDER BY slug
  `;
  assert.deepEqual(calendars.map((c) => c.slug), [...SEED_CALENDAR_SLUGS].sort());
  assert.deepEqual(calendars.filter((c) => c.is_default).map((c) => c.slug), ['lavoro']);
  const [counts] = await sql<Array<{ events: number; bookings: number; passwords: number }>>`
    SELECT
      (SELECT count(*)::int FROM calendar_events) AS events,
      (SELECT count(*)::int FROM calendar_bookings) AS bookings,
      (SELECT count(*)::int FROM caldav_app_passwords) AS passwords
  `;
  assert.deepEqual(counts, { events: 0, bookings: 0, passwords: 0 });
});

test('app: health, JWT admin, ruoli, sessione scaduta e 404', async () => {
  const health = await api.get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.checks.database, 'ok');

  const path = '/api/admin/calendar/calendars';
  assert.equal((await api.get(path)).status, 401);
  const client = await api.get(path, { auth: { bearer: await signTestToken({ role: 'client' }) } });
  assert.equal(client.status, 403);
  const stale = await api.get(path, { auth: { bearer: await signTestToken({ authAt: Date.now() - 13 * 3600_000 }) } });
  assert.equal(stale.status, 401);

  const admin = await api.get(path, { auth: 'admin' });
  assert.equal(admin.status, 200);
  assert.deepEqual(
    admin.json.calendars.map((c: { slug: string }) => c.slug).sort(),
    [...SEED_CALENDAR_SLUGS].sort(),
  );
  // ensureTestAdmin crea le righe users/profiles richieste dalle foreign key.
  const [profile] = await sql<Array<{ role: string }>>`SELECT role FROM profiles WHERE id = ${TEST_ADMIN.id}::uuid`;
  assert.equal(profile?.role, 'admin');

  const missing = await api.get('/api/non-esiste');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: 'Not Found' });
});

test('fixture: calendario, evento singolo, all-day e serie con exdate e override', async () => {
  // Non bloccante: gli eventi di questo test non devono togliere slot al test
  // delle prenotazioni (i dati restano fino alla pulizia finale).
  const cal = await fx.calendar({ key: 'lavoro', name: 'Lavoro di prova', blocks_availability: false });
  assert.equal(cal.slug, `${fx.prefix}-lavoro`);
  await fx.event({ calendar: cal, summary: 'Riunione', start_time: romeIso('2027-01-05', '15:00'), end_time: romeIso('2027-01-05', '16:00') });
  await fx.allDayEvent({ calendar: cal, summary: 'Trasferta', date: '2027-01-07' });
  // Serie giornaliera di 5 occorrenze alle 08:00 di Roma: il 6 escluso con
  // EXDATE, il 5 spostato alle 10:00 e il 7 cancellato con due override.
  const { master, overrides } = await fx.series({
    calendar: cal,
    summary: 'Standup',
    start_time: romeIso('2027-01-04', '08:00'),
    end_time: romeIso('2027-01-04', '08:30'),
    rrule: 'FREQ=DAILY;COUNT=5',
    exdates: [romeIso('2027-01-06', '08:00')],
    overrides: [
      { originalStart: romeIso('2027-01-05', '08:00'), start: romeIso('2027-01-05', '10:00') },
      { originalStart: romeIso('2027-01-07', '08:00'), status: 'cancelled' },
    ],
  });
  assert.equal(master.rrule, 'FREQ=DAILY;COUNT=5');
  assert.equal(overrides.length, 2);

  const res = await api.get('/api/admin/calendar/events', {
    auth: 'admin',
    query: { calendar_id: cal.id, from: '2027-01-04T00:00:00Z', to: '2027-01-11T00:00:00Z' },
  });
  assert.equal(res.status, 200);
  const seen = res.json.events.map((e: { summary: string; start_time: string; all_day: boolean; is_override: boolean }) =>
    [e.summary.replace(`${fx.prefix} `, ''), e.start_time, e.all_day, e.is_override]);
  assert.deepEqual(seen, [
    ['Standup', '2027-01-04T07:00:00.000Z', false, false],
    ['Standup', '2027-01-05T09:00:00.000Z', false, true],
    ['Riunione', '2027-01-05T14:00:00.000Z', false, false],
    ['Trasferta', '2027-01-06T23:00:00.000Z', true, false],
    ['Standup', '2027-01-08T07:00:00.000Z', false, false],
  ]);

  // Normalizzazione di una risposta reale: id, token e timestamp sostituiti,
  // campi semantici e ordine delle chiavi intatti.
  const n = createNormalizer().alias(cal.id, 'cal:lavoro');
  const detail = await api.get(`/api/admin/calendar/calendars/${cal.slug}`, { auth: 'admin' });
  const normalized = n.normalize(detail.json) as { calendar: Record<string, unknown> };
  assert.deepEqual(Object.keys(normalized.calendar), Object.keys(detail.json.calendar));
  assert.equal(normalized.calendar.id, '<cal:lavoro>');
  assert.equal(normalized.calendar.slug, cal.slug);
  assert.equal(normalized.calendar.created_at, '<timestamp>');
  assert.equal(normalized.calendar.ics_feed_token, '<token:1>');
  assert.equal(normalized.calendar.ics_feed_url, 'https://api.caldes.test/api/calendar/feed/<token:1>.ics');
});

test("prenotazioni: festività in 'f', slot, proiezione, token di gestione e POST pubblica", async () => {
  freezeTime(NOW);
  try {
    // Calendario festività con lo slug di produzione: getOrCreateFestivitaCalendar
    // (usato da /closures e dal cron) lo ritrova per nome.
    const holidays = await fx.holidayCalendar();
    assert.equal(holidays.slug, 'f');
    const [befana] = await fx.holidays(holidays, { year: 2027, only: ['2027-01-06'] });
    assert.equal(befana.source, 'system');
    assert.equal(befana.source_id, 'it-holiday-2027-01-06');
    assert.equal(new Date(befana.start_time).toISOString(), '2027-01-05T23:00:00.000Z');
    const closures = await api.get('/api/admin/calendar/closures', { auth: 'admin' });
    assert.equal(closures.status, 200);
    assert.equal(closures.json.calendar.id, holidays.id);

    const schedule = await fx.schedule({ slots: OFFICE_HOURS });
    const eventType = await fx.eventType({ key: 'consulenza', durationMinutes: 60, slotIncrementMinutes: 60, schedule });
    const { booking, projection } = await fx.booking({ eventType, start: romeIso('2027-01-05', '09:00') });
    assert.ok(projection, 'prenotazione confermata senza proiezione');
    assert.equal(projection.source, 'booking');
    assert.equal(projection.source_id, booking.uid);
    assert.equal(projection.summary, `${eventType.title} – Cliente di test`);
    const [bookingsCal] = await sql<Array<{ id: string }>>`SELECT id FROM calendars WHERE slug = 'bookings'`;
    assert.equal(projection.calendar_id, bookingsCal.id);

    // Slot: il 5 manca l'ora prenotata, il 6 è festivo (Befana nel calendario 'f').
    const slots = await api.get(`/api/calendar/event-types/${eventType.slug}/slots`, {
      query: { from: '2027-01-05', to: '2027-01-06' },
    });
    assert.equal(slots.status, 200);
    const hours = (date: string): string[] => slots.json.slots_by_date[date].map((s: { start: string }) =>
      new Date(s.start).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }));
    assert.deepEqual(hours('2027-01-05'), ['10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00']);
    assert.deepEqual(hours('2027-01-06'), []);

    // Token di gestione: valido → 200; scaduto, di un altro secret o di un altro uid → 401.
    const token = bookingManageToken(booking.uid);
    const manage = await api.get(bookingManagePath(booking.uid, token));
    assert.equal(manage.status, 200);
    assert.equal(manage.json.booking.uid, booking.uid);
    assert.equal(manage.json.booking.status, 'confirmed');
    for (const bad of [
      expiredBookingManageToken(booking.uid),
      bookingManageTokenWithSecret(booking.uid, 'un-altro-secret-di-almeno-trentadue-caratteri'),
      bookingManageToken('altrouid0000'),
    ]) {
      assert.equal((await api.get(bookingManagePath(booking.uid, bad))).status, 401);
    }
    const ics = await api.get(bookingManagePath(booking.uid, token, 'ics'));
    assert.equal(ics.status, 200);
    assert.match(ics.contentType ?? '', /text\/calendar/);
    const icsNormalized = createNormalizer().normalizeIcs(ics.text);
    assert.match(icsNormalized, /^UID:<uid:1>@/m);
    assert.match(icsNormalized, /^DTSTAMP:<dtstamp>$/m);
    assert.match(icsNormalized, /^METHOD:REQUEST$/m);

    // POST pubblica (captcha non configurato → saltato come in sviluppo):
    // prenotazione confermata, lead creato, proiezione; stesso slot → 409.
    const body = {
      event_type_slug: eventType.slug,
      start: romeIso('2027-01-05', '10:00'),
      attendee: { name: 'Cliente dal sito', email: fx.email('sito'), timezone: 'Europe/Rome' },
      gdpr_consent: true,
    };
    const created = await api.post('/api/calendar/bookings', { body });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.json.booking.status, 'confirmed');
    const uid: string = created.json.booking.uid;
    const [lead] = await sql<Array<{ email: string }>>`SELECT email FROM leads WHERE source_id = ${uid}`;
    assert.equal(lead?.email, fx.email('sito'));
    const [publicProjection] = await sql<Array<{ summary: string }>>`
      SELECT summary FROM calendar_events WHERE source = 'booking' AND source_id = ${uid}
    `;
    assert.equal(publicProjection?.summary, `${eventType.title} – Cliente dal sito`);
    const conflict = await api.post('/api/calendar/bookings', { body });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'BOOKING_CONFLICT');

    // Flusso reale createBooking con l'orologio fermo.
    const viaLib = await fx.bookingViaLib({ eventType, start: romeIso('2027-01-05', '11:00'), source: 'admin_manual' });
    assert.equal(viaLib.booking.status, 'confirmed');
    assert.equal(viaLib.projection?.source_id, viaLib.booking.uid);
  } finally {
    restoreTime();
  }
});

test('fixture: app-password, iscrizioni, token MCP e device', async () => {
  const { password } = await fx.appPassword({ device: 'iPhone' });
  const verify = (pwd: string, withService = true) => api.post('/api/caldav-backend/verify-credentials', {
    body: { username: 'federico', password: pwd },
    auth: withService ? { caldavService: true } : undefined,
  });
  const ok = await verify(password);
  assert.equal(ok.status, 200);
  // F1 (contratto control-plane §9.4): principal canonico ed expires_at (null: nessuna scadenza).
  assert.deepEqual(ok.json, { ok: true, principal: 'federico', expires_at: null });
  assert.equal((await verify('password-sbagliata')).status, 401);
  assert.equal((await verify(password, false)).status, 401);

  const cal = await fx.calendar({ key: 'esterno', name: 'Google esterno', blocks_availability: false });
  const parsed = await fx.subscription({
    calendar: cal,
    events: [{
      remote_uid: 'remoto-1@example.test',
      summary: 'Evento esterno',
      description: null,
      location: null,
      url: null,
      start_time: '2027-01-05T10:00:00.000Z',
      end_time: '2027-01-05T11:00:00.000Z',
      all_day: false,
      rrule: null,
      exdates: [],
      recurrence_id: null,
      status: 'confirmed',
    }],
  });
  assert.equal(parsed.subscription.event_count, 1);
  assert.deepEqual(parsed.events.map((e) => [e.source, e.source_id, e.summary]), [['ics_pull', 'remoto-1@example.test', 'Evento esterno']]);

  // Corpo ICS dal parser reale. BUG ATTUALE (design §14, "parseIcs rotto"):
  // BEGIN:VCALENDAR incrementa il contatore dei blocchi da saltare, quindi
  // tutte le proprietà dei VEVENT vengono ignorate e il feed risulta vuoto.
  // L'asserzione congela il comportamento di oggi; il fix arriva con ics-split (F2).
  const fromIcs = await fx.subscription({
    calendar: cal,
    name: 'feed ics',
    ics: [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//IT',
      'BEGIN:VEVENT', 'UID:remoto-2@example.test', 'DTSTAMP:20270101T000000Z',
      'DTSTART:20270105T100000Z', 'DTEND:20270105T110000Z', 'SUMMARY:Evento dal feed',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n'),
  });
  assert.equal(fromIcs.events.length, 0);
  assert.equal(fromIcs.subscription.event_count, 0);

  const mcp = await fx.mcpToken({ scope: 'read' });
  const tools = await api.get('/api/mcp/tools', { auth: { bearer: mcp.token } });
  assert.equal(tools.status, 200);
  assert.equal(tools.json.scope, 'read');
  assert.ok(tools.json.tools.length > 0);

  const device = await fx.deviceToken();
  const agenda = await api.get('/api/device/agenda', { auth: { bearer: device.token }, query: { date: '2027-01-05' } });
  assert.equal(agenda.status, 200);
  assert.equal(agenda.json.date, '2027-01-05');
  assert.ok(agenda.json.events.some((e: { summary: string }) => e.summary === 'Evento esterno'));
});

test('normalizzazione: segnaposto stabili, ordine e campi semantici conservati', () => {
  const n = createNormalizer({ prefixes: ['tst-casuale-ab12cd'] });
  const calId = '6f1c2a9e-3b4d-4e5f-8a7b-0c1d2e3f4a5b';
  const out = n.normalize({
    events: [
      {
        id: 'aaaaaaaa-1111-4111-8111-111111111111',
        calendar_id: calId,
        uid: 'abcdefghij012345',
        summary: 'tst-casuale-ab12cd Riunione',
        description: 'UID prenotazione: k3j4h5g6f7d8',
        source: 'booking',
        source_id: 'k3j4h5g6f7d8',
        start_time: '2027-01-05T09:00:00.000Z',
        created_at: new Date('2026-10-09T12:00:00Z'),
        updated_at: '2026-10-09T12:00:01.000Z',
      },
      { id: 'bbbbbbbb-2222-4222-8222-222222222222', calendar_id: calId, recurrence_id: new Date('2027-01-06T07:00:00Z') },
    ],
    feed: `https://api.caldes.test/api/calendar/feed/x.ics?c=${calId}`,
  });
  assert.deepEqual(out, {
    events: [
      {
        id: '<id:1>',
        calendar_id: '<id:2>',
        uid: '<uid:1>',
        summary: '<prefix> Riunione',
        description: 'UID prenotazione: <uid:2>',
        source: 'booking',
        source_id: '<uid:2>',
        start_time: '2027-01-05T09:00:00.000Z',
        created_at: '<timestamp>',
        updated_at: '<timestamp>',
      },
      { id: '<id:3>', calendar_id: '<id:2>', recurrence_id: '2027-01-06T07:00:00.000Z' },
    ],
    feed: 'https://api.caldes.test/api/calendar/feed/x.ics?c=<id:2>',
  });

  const ics = n.normalizeIcs([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:abcdefghij012345@api.caldes.test',
    'DTSTAMP:20261009T120000Z',
    'DESCRIPTION:Dettagli molto lunghi che vanno a capo sec',
    ' ondo RFC 5545',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n'));
  assert.equal(ics, [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:<uid:1>@api.caldes.test',
    'DTSTAMP:<dtstamp>',
    'DESCRIPTION:Dettagli molto lunghi che vanno a capo secondo RFC 5545',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\n'));
});

test('pulizia: nessun dato del prefisso dopo cleanup()', async () => {
  // Dati propri (il test deve reggersi anche da solo con --test-name-pattern):
  // un calendario, una prenotazione con proiezione in 'bookings' (senza
  // prefisso nel calendario, pulita per uid) e un evento senza prefisso
  // registrato per id; nel run completo restano anche i dati dei test sopra.
  const cal = await fx.calendar({ key: 'da-pulire' });
  const eventType = await fx.eventType({ key: 'da-pulire' });
  const { projection } = await fx.booking({ eventType, start: romeIso('2027-02-01', '09:00') });
  assert.ok(projection);
  await fx.event({ calendar: cal, summary: 'Senza prefisso', prefixSummary: false, start_time: romeIso('2027-02-01', '12:00'), end_time: romeIso('2027-02-01', '13:00') });

  const report = await fx.cleanup();
  assert.ok((report.calendars ?? 0) >= 1, `calendari cancellati: ${report.calendars}`);
  assert.ok((report.calendar_bookings ?? 0) >= 1, `prenotazioni cancellate: ${report.calendar_bookings}`);
  assert.ok((report.calendar_events ?? 0) >= 1, `proiezioni cancellate: ${report.calendar_events}`);

  const like = `${fx.prefix}%`;
  const [left] = await sql<Array<Record<string, number>>>`
    SELECT
      (SELECT count(*)::int FROM calendars WHERE slug LIKE ${like} OR slug = 'f') AS calendars,
      (SELECT count(*)::int FROM calendar_events) AS events,
      (SELECT count(*)::int FROM calendar_bookings) AS bookings,
      (SELECT count(*)::int FROM leads WHERE email LIKE ${like}) AS leads,
      (SELECT count(*)::int FROM calendar_event_types WHERE slug LIKE ${like}) AS event_types,
      (SELECT count(*)::int FROM calendar_availability_schedules WHERE name LIKE ${like}) AS schedules,
      (SELECT count(*)::int FROM calendar_subscriptions) AS subscriptions,
      (SELECT count(*)::int FROM caldav_app_passwords) AS app_passwords,
      (SELECT count(*)::int FROM mcp_tokens WHERE label LIKE ${like}) AS mcp_tokens,
      (SELECT count(*)::int FROM device_tokens WHERE label LIKE ${like}) AS device_tokens
  `;
  assert.deepEqual(left, {
    calendars: 0, events: 0, bookings: 0, leads: 0, event_types: 0, schedules: 0,
    subscriptions: 0, app_passwords: 0, mcp_tokens: 0, device_tokens: 0,
  });
});
