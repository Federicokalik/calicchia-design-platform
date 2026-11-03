/**
 * Feed ICS pubblico dall'indice (apps/api/src/lib/calendar/feed-builder.ts e
 * routes/calendar/feed.ts con lo store Radicale; design §10, §14 "Feed";
 * contratto dei moduli docs/calendar-radicale/contracts/f2-modules.md §9),
 * senza Radicale: l'indice è popolato con l'API dell'indicizzatore come lo
 * popolerebbe la sync, e la route si prova con overrideCalendarStore('radicale').
 *
 * Casi del piano F2 (voce "Test", gruppo CONSUMERS): ETag diverso al cambio di
 * data (la finestra scorre e un evento entra a +365 giorni), STATUS:CANCELLED
 * escluso (anche scritto dai device), UID legacy delle proiezioni migrate. Più:
 * proiezioni ricomposte da calendar_bookings con la decisione 3 (anche dopo
 * un'erasure), UID legacy degli oggetti migrati senza legacy_uid,
 * corpo ed ETag identici per tutto il giorno e fra processi (DTSTAMP stabile,
 * cache svuotata), override nella risorsa del master con le cancellazioni come
 * EXDATE, whitelist e CLASS:PRIVATE → "Occupato", suffisso del dominio degli
 * UID, iscrizioni mai nel feed, oggetto in quarantena con l'ultima versione
 * buona, oggetto illeggibile escluso senza far fallire il feed, collezione mai
 * indicizzata → 503 (mai un feed vuoto), 304 su If-None-Match, feed disattivato
 * → 404, dominio degli UID da CAL_FEED_UID_DOMAIN.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { buildCalendarFeed } from '../../src/lib/calendar/events';
import { bookingAdminUrl } from '../../src/lib/calendar/booking-projection';
import { buildIndexFeed, clearIndexFeedCache, feedBookingAdminUrl, feedUidDomain, feedWindowAnchor } from '../../src/lib/calendar/feed-builder';
import { applyCollectionChanges, loadCollectionContext, type RawItem, stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar, EventType } from '../../src/lib/calendar/types';
import { icsEvents, icsProp, unfoldIcs } from '../contracts/_http-contract';
import { onBeforeDatabaseClose, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { api } from '../helpers/http';
import { useFixtures } from '../helpers/fixtures';

useTestDatabase({ resetBaseline: true });
const fx = useFixtures('cons-feed');

/** Orizzonte materializzato fisso, abbastanza lungo da coprire l'evento "lontano". */
const H = Object.freeze({ start: new Date('2026-01-01T00:00:00Z'), end: new Date('2029-01-01T00:00:00Z') });
/** Dominio degli UID dei test (host di PUBLIC_API_URL, helpers/env.ts). */
const UID_DOMAIN = 'api.caldes.test';

/** Domenica 10 gennaio 2027, 11:00 a Roma: la finestra arriva al 10 gennaio 2028 (fine giornata). */
const DAY1 = new Date('2027-01-10T10:00:00Z');
/** Stesso giorno di Roma, sera. */
const DAY1_EVENING = new Date('2027-01-10T21:30:00Z');
/** Lunedì 11 gennaio 2027: la finestra scorre di un giorno. */
const DAY2 = new Date('2027-01-11T10:00:00Z');

function ics(...components: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Feed//IT', ...components, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(lines: string[]): string {
  return ['BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'].join('\r\n');
}

const TEXTS = {
  single: ics(vevent([
    'UID:singolo-feed', 'DTSTART:20270104T120000Z', 'DTEND:20270104T130000Z', 'SUMMARY:Riunione',
    'LAST-MODIFIED:20261201T100000Z', 'ATTENDEE;CN=Ospite:mailto:ospite@example.test', 'X-CALDES-SOURCE:admin',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Promemoria', 'TRIGGER:-PT15M', 'END:VALARM',
  ])),
  private: ics(vevent([
    'UID:privato-feed@test.invalid', 'DTSTART:20270105T090000Z', 'DTEND:20270105T100000Z', 'SUMMARY:Visita medica',
    'DESCRIPTION:Referto', 'LOCATION:Ospedale', 'CLASS:PRIVATE',
  ])),
  // Annullato da un device: master STATUS:CANCELLED, mai nel feed.
  cancelled: ics(vevent(['UID:annullato-feed@test.invalid', 'DTSTART:20270106T090000Z', 'DTEND:20270106T100000Z', 'SUMMARY:Annullato', 'STATUS:CANCELLED'])),
  series: ics(
    vevent([
      'UID:serie-feed@test.invalid', 'DTSTART;TZID=Europe/Rome:20261102T090000', 'DTEND;TZID=Europe/Rome:20261102T100000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'SUMMARY:Studio',
    ]),
    vevent([
      'UID:serie-feed@test.invalid', 'RECURRENCE-ID;TZID=Europe/Rome:20270105T090000',
      'DTSTART;TZID=Europe/Rome:20270105T110000', 'DTEND;TZID=Europe/Rome:20270105T120000', 'SUMMARY:Studio spostato',
    ]),
    vevent([
      'UID:serie-feed@test.invalid', 'RECURRENCE-ID;TZID=Europe/Rome:20270107T090000',
      'DTSTART;TZID=Europe/Rome:20270107T090000', 'DTEND;TZID=Europe/Rome:20270107T100000', 'SUMMARY:Studio', 'STATUS:CANCELLED',
    ]),
  ),
  // Fuori dalla finestra del 10 gennaio 2027 (fine: 10 gennaio 2028 a mezzanotte di Roma), dentro quella dell'11.
  far: ics(vevent(['UID:lontano-feed@test.invalid', 'DTSTART:20280111T100000Z', 'DTEND:20280111T110000Z', 'SUMMARY:Evento lontano'])),
  // Singolo vecchio: fuori dalla finestra (−90 giorni) in entrambi i giorni.
  old: ics(vevent(['UID:vecchio-feed@test.invalid', 'DTSTART:20260901T100000Z', 'DTEND:20260901T110000Z', 'SUMMARY:Evento vecchio'])),
  good: ics(vevent(['UID:recuperato-feed@test.invalid', 'DTSTART:20270108T150000Z', 'DTEND:20270108T160000Z', 'SUMMARY:Versione buona'])),
  // Componente non chiuso: illeggibile.
  broken: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:rotto-feed@test.invalid', 'DTSTART:20270109T150000Z', 'DTEND:20270109T160000Z', 'END:VCALENDAR', ''].join('\r\n'),
  remote: ics(vevent(['UID:remoto-feed@google.test', 'DTSTART:20270105T140000Z', 'DTEND:20270105T150000Z', 'SUMMARY:Evento remoto'])),
};

interface Scenario {
  cal: Calendar;
  bookings: Calendar;
  neverIndexed: Calendar;
  disabled: Calendar;
  projectionUid: string;
  plainProjectionUid: string;
  goneProjectionUid: string;
  eventType: EventType;
}

let sc: Scenario;

async function indexItems(calendarId: string, items: Array<{ href: string; raw: string }>, opts: { remote?: boolean; full?: boolean } = {}): Promise<void> {
  const context = await loadCollectionContext(sql, calendarId);
  const upserts: RawItem[] = items.map((i, n) => ({ href: i.href, etag: opts.remote ? null : `"etag-${i.href}-${n}-${i.raw.length}"`, raw: i.raw }));
  await applyCollectionChanges({
    context,
    upserts,
    deletes: [],
    radicaleSkipped: [],
    pending404: [],
    full: opts.full ?? false,
    horizon: { start: H.start, end: H.end },
    actor: 'test',
  }, { syncedAt: new Date() });
}

async function sidecarCalendar(parent: Calendar, key: string): Promise<string> {
  const slug = fx.slug(key);
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO calendars (slug, name, color, timezone, is_default, is_system, blocks_availability, ics_feed_token, ics_feed_enabled,
                           sort_order, collection_name, role, origin, lifecycle, parent_calendar_id, device_visible)
    VALUES (${slug}, ${fx.name(key)}, '#123456', 'Europe/Rome', false, false, false,
            ${randomBytes(16).toString('hex')}, false, 0, ${slug}, 'subscription', 'admin', 'active', ${parent.id}, false)
    RETURNING id
  `;
  fx.track('calendarIds', row.id);
  return row.id;
}

onDatabaseReady(async () => {
  overrideCalendarStore(null);
  clearIndexFeedCache();
  const cal = await fx.calendar({ key: 'principale', name: 'Principale', description: 'Calendario di prova del feed', color: '#336699' });
  const bookings = await fx.calendar({ key: 'prenotazioni', name: 'Prenotazioni prova' });
  await sql`UPDATE calendars SET role = 'bookings' WHERE id = ${bookings.id}`;
  const neverIndexed = await fx.calendar({ key: 'mai-indicizzato' });
  const disabled = await fx.calendar({ key: 'disattivato' });

  await indexItems(cal.id, [
    { href: 'singolo-feed.ics', raw: TEXTS.single },
    { href: 'privato.ics', raw: TEXTS.private },
    { href: 'annullato.ics', raw: TEXTS.cancelled },
    { href: 'serie.ics', raw: TEXTS.series },
    { href: 'lontano.ics', raw: TEXTS.far },
    { href: 'vecchio.ics', raw: TEXTS.old },
    { href: 'recuperato.ics', raw: TEXTS.good },
    { href: 'rotto.ics', raw: TEXTS.broken },
  ], { full: true });
  // Il testo di recuperato.ics si rompe: quarantena con l'ultima versione buona.
  await indexItems(cal.id, [{ href: 'recuperato.ics', raw: TEXTS.broken.replace('rotto-feed', 'recuperato-feed') }]);

  // Iscrizione con destinazione il calendario principale: mai nel suo feed.
  const sidecar = await sidecarCalendar(cal, 'iscrizione');
  await indexItems(sidecar, [{ href: 'r-remoto.ics', raw: TEXTS.remote }], { remote: true, full: true });

  // Proiezioni: una migrata (legacy_uid in cal_object_ids) con il testo legacy
  // (email, azienda e note nella DESCRIPTION), una nuova, una la cui
  // prenotazione non c'è più (erasure). Le prenotazioni esistono in
  // calendar_bookings senza proiezione legacy (project: false).
  const eventType = await fx.eventType({ key: 'consulenza', title: 'Consulenza', durationMinutes: 30 });
  const migrated = await fx.booking({
    eventType, start: '2027-01-12T10:00:00Z', project: false,
    attendee: { name: 'Mario Rossi', phone: '+39 06 1234567', company: 'Rossi SRL', message: 'Vorrei un preventivo' },
  });
  const plain = await fx.booking({ eventType, start: '2027-01-13T10:00:00Z', project: false, attendee: { name: 'Anna Neri' } });
  const projectionUid = migrated.booking.uid;
  const plainProjectionUid = plain.booking.uid;
  const goneProjectionUid = 'prensparita9z';
  await indexItems(bookings.id, [
    { href: `booking-${projectionUid}.ics`, raw: ics(vevent([
      `UID:${projectionUid}@caldes.it`, 'DTSTART:20270112T100000Z', 'DTEND:20270112T103000Z', 'SUMMARY:Consulenza – Mario Rossi',
      `DESCRIPTION:Cliente: Mario Rossi <${migrated.booking.attendee_email}>\\nTel: +39 06 1234567\\nAzienda: Rossi SRL\\n\\nNote:\\nVorrei un preventivo`,
    ])) },
    { href: `booking-${plainProjectionUid}.ics`, raw: ics(vevent([`UID:${plainProjectionUid}@caldes.it`, 'DTSTART:20270113T100000Z', 'DTEND:20270113T103000Z', 'SUMMARY:Consulenza – Anna Neri'])) },
    { href: `booking-${goneProjectionUid}.ics`, raw: ics(vevent([
      `UID:${goneProjectionUid}@caldes.it`, 'DTSTART:20270114T100000Z', 'DTEND:20270114T103000Z', 'SUMMARY:Consulenza – Luca Verdi',
      'DESCRIPTION:Tel: +39 333 9999999',
    ])) },
  ], { full: true });
  await sql`
    UPDATE cal_object_ids SET legacy_uid = 'uid-legacy-proiezione'
    WHERE calendar_id = ${bookings.id} AND href = ${`booking-${projectionUid}.ics`} AND recurrence_key = ''
  `;

  await indexItems(disabled.id, [{ href: 'singolo.ics', raw: TEXTS.good }], { full: true });
  await sql`UPDATE calendars SET ics_feed_enabled = false WHERE id = ${disabled.id}`;

  sc = { cal, bookings, neverIndexed, disabled, projectionUid, plainProjectionUid, goneProjectionUid, eventType };
});

onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  clearIndexFeedCache();
  await stopIndexWorker();
});

async function feedAt(calendar: Calendar, now: Date): Promise<{ body: string; etag: string | null }> {
  return buildIndexFeed(sql, calendar, { now, uidDomain: UID_DOMAIN });
}

function summaries(body: string): string[] {
  return icsEvents(body).map((e) => icsProp(e, 'SUMMARY') ?? '');
}

function eventBy(body: string, summary: string): string[] {
  const ev = icsEvents(body).find((e) => icsProp(e, 'SUMMARY') === summary);
  assert.ok(ev, `VEVENT "${summary}" assente`);
  return ev;
}

describe('feed dall\'indice: contenuto (design §10)', () => {
  test('ETag diverso al cambio di data: la finestra scorre e l\'evento a +365 giorni entra', async () => {
    const day1 = await feedAt(sc.cal, DAY1);
    const day2 = await feedAt(sc.cal, DAY2);
    assert.match(day1.etag ?? '', /^"[0-9a-f]{64}"$/, 'ETag forte: sha256 del corpo fra virgolette');
    assert.ok(!summaries(day1.body).includes('Evento lontano'));
    assert.ok(summaries(day2.body).includes('Evento lontano'));
    assert.notEqual(day1.etag, day2.etag);
    assert.notEqual(day1.body, day2.body);
    // Il singolo vecchio è fuori in entrambi i giorni, le serie ci sono sempre.
    for (const f of [day1, day2]) {
      assert.ok(!summaries(f.body).includes('Evento vecchio'));
      assert.ok(summaries(f.body).includes('Studio'));
    }
  });

  test('stesso giorno di Roma: corpo ed ETag identici, anche senza cache (DTSTAMP stabile, nessun orario nel corpo)', async () => {
    const morning = await feedAt(sc.cal, DAY1);
    clearIndexFeedCache();
    const evening = await feedAt(sc.cal, DAY1_EVENING);
    assert.equal(evening.etag, morning.etag);
    assert.equal(evening.body, morning.body);
    // DTSTAMP = LAST-MODIFIED se c'è, altrimenti first_seen_at: mai l'ora della richiesta.
    assert.equal(icsProp(eventBy(morning.body, 'Riunione'), 'DTSTAMP'), '20261201T100000Z');
    const [seen] = await sql<Array<{ first_seen_at: Date }>>`
      SELECT first_seen_at FROM cal_objects WHERE calendar_id = ${sc.cal.id} AND href = 'privato.ics'
    `;
    const expectedStamp = seen.first_seen_at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    assert.equal(icsProp(eventBy(morning.body, 'Occupato'), 'DTSTAMP'), expectedStamp);
  });

  test('cambio dell\'indice: corpo ed ETag nuovi nello stesso giorno', async () => {
    const before = await feedAt(sc.cal, DAY1);
    await indexItems(sc.cal.id, [{ href: 'aggiunto.ics', raw: ics(vevent(['UID:aggiunto-feed@test.invalid', 'DTSTART:20270120T100000Z', 'DTEND:20270120T110000Z', 'SUMMARY:Aggiunto'])) }]);
    const after = await feedAt(sc.cal, DAY1);
    assert.notEqual(after.etag, before.etag);
    assert.ok(summaries(after.body).includes('Aggiunto'));
  });

  test('STATUS:CANCELLED escluso; override nella risorsa del master, cancellazione come EXDATE', async () => {
    const { body } = await feedAt(sc.cal, DAY1);
    assert.ok(!summaries(body).includes('Annullato'), 'master STATUS:CANCELLED (anche da device) mai nel feed');
    assert.ok(!/STATUS:CANCELLED/.test(body));
    const series = icsEvents(body).filter((e) => icsProp(e, 'UID') === 'serie-feed@test.invalid');
    assert.equal(series.length, 2, 'master e override spostato, con lo stesso UID');
    const master = series.find((e) => icsProp(e, 'RRULE')) as string[];
    assert.ok(master.some((l) => /^EXDATE;TZID=Europe\/Rome:20270107T090000$/.test(l)), `EXDATE dell'occorrenza cancellata: ${master.join(' | ')}`);
    const moved = series.find((e) => icsProp(e, 'RECURRENCE-ID')) as string[];
    assert.equal(icsProp(moved, 'SUMMARY'), 'Studio spostato');
    assert.match(body, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Rome/);
    assert.equal((body.match(/BEGIN:VTIMEZONE/g) ?? []).length, 1, 'VTIMEZONE deduplicati');
  });

  test('privacy: whitelist (niente VALARM, ATTENDEE, X-*) e CLASS:PRIVATE → "Occupato"', async () => {
    const { body } = await feedAt(sc.cal, DAY1);
    assert.ok(!/BEGIN:VALARM|ATTENDEE|ORGANIZER|X-CALDES-SOURCE|^CLASS/m.test(body));
    const priv = eventBy(body, 'Occupato');
    assert.equal(icsProp(priv, 'DESCRIPTION'), undefined);
    assert.equal(icsProp(priv, 'LOCATION'), undefined);
    assert.ok(!body.includes('Visita medica') && !body.includes('Ospedale'));
    // Intestazione del feed legacy.
    const lines = unfoldIcs(body);
    assert.ok(lines.includes('X-WR-CALNAME:tst-cons-feed Principale'));
    assert.ok(lines.includes('X-WR-CALDESC:Calendario di prova del feed'));
    assert.ok(lines.includes('X-WR-TIMEZONE:Europe/Rome'));
    assert.ok(lines.includes('X-APPLE-CALENDAR-COLOR:#336699'));
    assert.ok(lines.includes('PRODID:-//Caldes//Calendar//IT'));
  });

  test('UID: suffisso del dominio per gli UID senza @, gli altri invariati', async () => {
    const { body } = await feedAt(sc.cal, DAY1);
    assert.equal(icsProp(eventBy(body, 'Riunione'), 'UID'), `singolo-feed@${UID_DOMAIN}`);
    assert.equal(icsProp(eventBy(body, 'Occupato'), 'UID'), 'privato-feed@test.invalid');
  });

  test('UID legacy delle proiezioni migrate (legacy_uid@CAL_FEED_UID_DOMAIN), le nuove con <uid>@caldes.it', async () => {
    const { body } = await feedAt(sc.bookings, DAY1);
    assert.equal(icsProp(eventBy(body, `${sc.eventType.title} – Mario Rossi`), 'UID'), `uid-legacy-proiezione@${UID_DOMAIN}`);
    assert.equal(icsProp(eventBy(body, `${sc.eventType.title} – Anna Neri`), 'UID'), `${sc.plainProjectionUid}@caldes.it`);
  });

  test('proiezioni: contenuto della decisione 3 ricomposto da calendar_bookings al momento del feed, qualunque sia il testo in Radicale', async () => {
    const { body } = await feedAt(sc.bookings, DAY1);
    // Migrata con email, azienda e note nella DESCRIPTION: il feed pubblica solo titolo con il nome, telefono e link all'admin.
    const migrated = eventBy(body, `${sc.eventType.title} – Mario Rossi`);
    assert.equal(icsProp(migrated, 'DESCRIPTION'), `Tel: +39 06 1234567\\nPrenotazione: ${feedBookingAdminUrl(sc.projectionUid)}`);
    assert.ok(!/@test\.invalid|Rossi SRL|preventivo|Cliente:/.test(body), 'niente email, azienda né messaggio nel feed');
    // Luogo e link della riunione come la risorsa scritta dall'API (event type custom_url).
    assert.equal(icsProp(migrated, 'URL'), sc.eventType.location_value);
    // Prenotazione sparita (erasure): solo "Prenotazione", senza descrizione né telefono.
    const gone = icsEvents(body).find((e) => icsProp(e, 'UID') === `${sc.goneProjectionUid}@caldes.it`);
    assert.ok(gone, 'la proiezione senza prenotazione resta nel feed come "Prenotazione"');
    assert.equal(icsProp(gone, 'SUMMARY'), 'Prenotazione');
    assert.equal(icsProp(gone, 'DESCRIPTION'), undefined);
    assert.ok(!body.includes('Luca Verdi') && !body.includes('9999999'));
    // Stesso link della risorsa dei device (booking-projection.bookingAdminUrl).
    assert.equal(feedBookingAdminUrl(sc.projectionUid), bookingAdminUrl(sc.projectionUid));
  });

  test('oggetto migrato senza legacy_uid: UID legacy con il dominio anche se contiene @ (come il feed legacy)', async () => {
    await indexItems(sc.cal.id, [{ href: 'migrato-device.ics', raw: ics(vevent(['UID:ABC-123@icloud.com', 'DTSTART:20270121T100000Z', 'DTEND:20270121T110000Z', 'SUMMARY:Migrato da iCloud'])) }]);
    await sql`
      UPDATE cal_object_ids SET legacy_event_id = '11111111-2222-4333-8444-555555555555'
      WHERE calendar_id = ${sc.cal.id} AND href = 'migrato-device.ics' AND recurrence_key = ''
    `;
    clearIndexFeedCache();
    const { body } = await feedAt(sc.cal, DAY1);
    assert.equal(icsProp(eventBy(body, 'Migrato da iCloud'), 'UID'), `ABC-123@icloud.com@${UID_DOMAIN}`);
    // Un UID con '@' di un oggetto non migrato resta invariato.
    assert.equal(icsProp(eventBy(body, 'Occupato'), 'UID'), 'privato-feed@test.invalid');
  });

  test('iscrizioni mai nel feed del calendario di destinazione', async () => {
    const { body } = await feedAt(sc.cal, DAY1);
    assert.ok(!summaries(body).includes('Evento remoto'));
    assert.ok(!body.includes('remoto-feed@google.test'));
  });

  test('quarantena: ultima versione buona pubblicata; illeggibile senza versione buona escluso, il feed resta valido', async () => {
    const [state] = await sql<Array<{ health: string; has_good: boolean }>>`
      SELECT health, last_good_version_id IS NOT NULL AS has_good FROM cal_objects WHERE calendar_id = ${sc.cal.id} AND href = 'recuperato.ics'
    `;
    assert.deepEqual(state, { health: 'quarantined', has_good: true });
    const { body } = await feedAt(sc.cal, DAY1);
    assert.ok(summaries(body).includes('Versione buona'), 'ultima versione buona di un oggetto in quarantena');
    assert.ok(!body.includes('rotto-feed'), 'illeggibile senza versione buona: escluso');
    assert.ok(body.startsWith('BEGIN:VCALENDAR\r\n') && body.endsWith('END:VCALENDAR\r\n'));
  });

  test('collezione mai indicizzata: CalendarUnavailableError, mai un feed vuoto', async () => {
    await assert.rejects(feedAt(sc.neverIndexed, DAY1), (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'collection_unsyncable');
  });

  test('finestra ancorata al giorno di Roma e dominio degli UID', () => {
    assert.deepEqual(feedWindowAnchor(new Date('2027-01-10T23:30:00Z')), { day: '2027-01-11', anchor: new Date('2027-01-10T23:00:00Z') });
    assert.deepEqual(feedWindowAnchor(new Date('2027-07-01T21:59:00Z')), { day: '2027-07-01', anchor: new Date('2027-06-30T22:00:00Z') });
    assert.equal(feedUidDomain({ PUBLIC_API_URL: 'https://api.caldes.test' } as NodeJS.ProcessEnv), UID_DOMAIN);
    assert.equal(feedUidDomain({ CAL_FEED_UID_DOMAIN: 'api.calicchia.design' } as NodeJS.ProcessEnv), 'api.calicchia.design');
    // Valore non valido: ripiego sull'host di PUBLIC_API_URL (quello del processo di test).
    assert.equal(feedUidDomain({ CAL_FEED_UID_DOMAIN: 'non valido@x' } as NodeJS.ProcessEnv), UID_DOMAIN);
  });
});

describe('route GET /api/calendar/feed/<token>.ics con lo store Radicale', () => {
  test('ETag dal corpo, 304 su If-None-Match (anche debole), header di oggi', async () => {
    overrideCalendarStore('radicale');
    try {
      const path = `/api/calendar/feed/${sc.cal.ics_feed_token}.ics`;
      const res = await api.get(path);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal(res.headers.get('content-disposition'), `inline; filename="${sc.cal.slug}.ics"`);
      const etag = res.headers.get('etag');
      assert.match(etag ?? '', /^"[0-9a-f]{64}"$/);
      const direct = await buildCalendarFeed(sc.cal, { now: new Date(), uidDomain: feedUidDomain() });
      assert.equal(etag, direct.etag, 'stesso ETag della facade');
      assert.ok(summaries(res.text).includes('Riunione'));

      const notModified = await api.get(path, { headers: { 'If-None-Match': etag as string } });
      assert.equal(notModified.status, 304);
      assert.equal(notModified.text, '');
      assert.equal(notModified.headers.get('etag'), etag);
      const weak = await api.get(path, { headers: { 'If-None-Match': `"altro", W/${etag}` } });
      assert.equal(weak.status, 304);
      const other = await api.get(path, { headers: { 'If-None-Match': '"0000"' } });
      assert.equal(other.status, 200);
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('collezione mai indicizzata → 503 con Retry-After; feed disattivato → 404', async () => {
    overrideCalendarStore('radicale');
    try {
      const unavailable = await api.get(`/api/calendar/feed/${sc.neverIndexed.ics_feed_token}.ics`);
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.headers.get('retry-after'), '120');
      assert.equal(unavailable.headers.get('cache-control'), 'no-store');
      const disabled = await api.get(`/api/calendar/feed/${sc.disabled.ics_feed_token}.ics`);
      assert.equal(disabled.status, 404);
      assert.equal(disabled.text, 'Feed not found or disabled');
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('mode postgres: feed legacy, senza ETag e senza 304', async () => {
    const path = `/api/calendar/feed/${sc.cal.ics_feed_token}.ics`;
    const res = await api.get(path, { headers: { 'If-None-Match': '*' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), null);
  });
});
