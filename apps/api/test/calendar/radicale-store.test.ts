/**
 * RadicaleStore senza Radicale (apps/api/src/lib/calendar/radicale/store.ts,
 * adapters.ts; design §7, §8, §12; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §6.2-§6.3): le letture
 * dall'indice e le guardie delle scritture che non arrivano a Radicale.
 *
 * L'indice è popolato con l'API dell'indicizzatore (applyCollectionChanges),
 * come lo popolerebbe la sync; lo store è forzato con
 * overrideCalendarStore('radicale') e la facade si usa come la usano route e
 * tool MCP. RADICALE_URL non è impostata: le scritture rispondono 503
 * 'radicale_unreachable' dopo le guardie, getEvent risponde dall'indice.
 *
 * Casi: DTO di listOccurrences con le chiavi e l'ordine legacy (singolo,
 * serie con override spostato e cancellato, all-day a mezzanotte di Roma,
 * oggetto illeggibile come occorrenza conservativa, iscrizione con il
 * calendario di destinazione); includeCancelled e blockingOnly; espansione al
 * volo oltre l'orizzonte materializzato; getEvent di master e override
 * dall'indice, per UID e ambiguità; getEventBySource; conteggi legacy;
 * chiusure senza festività e senza creare il calendario; calendari visibili;
 * guardie (titolo, date, source, iscrizione in sola lettura, proiezione di una
 * prenotazione attiva); replaceSubscriptionEvents solo legacy; descrizione
 * delle proiezioni ricomposta come booking.ts.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { projectionDescription } from '../../src/lib/calendar/adapters';
import { countEventsByCalendar, getCalendar, listCalendars, listClosures } from '../../src/lib/calendar/calendars';
import {
  CalendarStoreUnavailableError,
  CalendarUnavailableError,
  EventReadOnlyError,
  EventValidationError,
} from '../../src/lib/calendar/errors';
import {
  buildCalendarFeed,
  createEvent,
  createOccurrenceOverride,
  deleteEvent,
  getEvent,
  getEventBySource,
  getEventOverrides,
  listEventsForCollection,
  listOccurrences,
  updateEvent,
} from '../../src/lib/calendar/events';
import { applyCollectionChanges, type CollectionContext, loadCollectionContext, type RawItem, stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import {
  ACTIVE_BOOKING_MESSAGE,
  getRadicaleStore,
  ICS_READ_ONLY_MESSAGE,
  setRadicaleFeedBuilder,
  UNREADABLE_SUMMARY,
} from '../../src/lib/calendar/radicale/store';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar, CalendarEventOccurrence } from '../../src/lib/calendar/types';
import { onBeforeDatabaseClose, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';

useTestDatabase({ resetBaseline: true });
const fx = useFixtures('store-rad');

/** Orizzonte materializzato fisso: oltre, l'espansione è al volo. */
const H = Object.freeze({ start: new Date('2026-01-01T00:00:00Z'), end: new Date('2028-01-01T00:00:00Z') });

/** Chiavi e ordine di CalendarEventOccurrence nello store legacy (toOccurrence di events-pg). */
const OCCURRENCE_KEYS = [
  'id', 'calendar_id', 'uid', 'summary', 'description', 'location', 'url', 'start_time', 'end_time', 'all_day',
  'recurrence_id', 'source', 'source_id', 'status', 'created_at', 'updated_at', 'original_start', 'is_override',
];
/** Chiavi e ordine di CalendarEvent (COLUMNS di events-pg). */
const EVENT_KEYS = [
  'id', 'calendar_id', 'uid', 'summary', 'description', 'location', 'url', 'start_time', 'end_time', 'all_day',
  'rrule', 'exdates', 'recurrence_id', 'recurrence_master_id', 'source', 'source_id', 'status', 'created_at', 'updated_at',
];

function ics(...components: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Store//IT', ...components, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(lines: string[]): string {
  return ['BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'].join('\r\n');
}

const SERIES_UID = 'serie-store@test.invalid';
const SINGLE_UID = 'singolo-store@test.invalid';

const TEXTS = {
  single: ics(vevent([
    `UID:${SINGLE_UID}`, 'DTSTART:20270104T120000Z', 'DTEND:20270104T130000Z', 'SUMMARY:Riunione',
    'LOCATION:Sala A', 'X-CALDES-SOURCE:admin', 'X-CALDES-SOURCE-ID:orig-1',
  ])),
  series: ics(
    vevent([
      `UID:${SERIES_UID}`, 'DTSTART;TZID=Europe/Rome:20260105T090000', 'DTEND;TZID=Europe/Rome:20260105T100000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'SUMMARY:Studio',
    ]),
    vevent([
      `UID:${SERIES_UID}`, 'RECURRENCE-ID;TZID=Europe/Rome:20270105T090000',
      'DTSTART;TZID=Europe/Rome:20270105T110000', 'DTEND;TZID=Europe/Rome:20270105T120000', 'SUMMARY:Studio spostato',
    ]),
    vevent([
      `UID:${SERIES_UID}`, 'RECURRENCE-ID;TZID=Europe/Rome:20270107T090000',
      'DTSTART;TZID=Europe/Rome:20270107T090000', 'DTEND;TZID=Europe/Rome:20270107T100000', 'STATUS:CANCELLED', 'SUMMARY:Studio',
    ]),
  ),
  allDay: ics(vevent(['UID:allday-store@test.invalid', 'DTSTART;VALUE=DATE:20270106', 'DTEND;VALUE=DATE:20270107', 'SUMMARY:Ferie'])),
  // Componente non chiuso: illeggibile, resta un blocco conservativo dal testo.
  broken: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:rotto-store@test.invalid', 'DTSTART:20270108T150000Z', 'DTEND:20270108T160000Z', 'END:VCALENDAR', ''].join('\r\n'),
  remote: ics(vevent(['UID:remoto-store@google.test', 'DTSTART:20270105T140000Z', 'DTEND:20270105T150000Z', 'SUMMARY:Evento remoto'])),
  holiday: ics(vevent([
    'UID:it-holiday-2027-01-06@caldes.it', 'DTSTART;TZID=Europe/Rome:20270106T000000', 'DTEND;TZID=Europe/Rome:20270107T000000',
    'SUMMARY:Epifania', 'STATUS:CONFIRMED',
  ])),
  closure: ics(vevent([
    'UID:chiusura-store@test.invalid', 'DTSTART;TZID=Europe/Rome:20270810T000000', 'DTEND;TZID=Europe/Rome:20270821T000000',
    'SUMMARY:Ferie estive', 'X-CALDES-SOURCE:admin',
  ])),
};

interface Scenario {
  a: Calendar;
  b: Calendar;
  f: Calendar;
  bookings: Calendar;
  sidecarId: string;
  subscriptionId: string;
  bookingUid: string;
  bookingHref: string;
  ids: Record<string, string>;
  overrideId: string;
  cancelledOverrideId: string;
}

let sc: Scenario;

async function indexItems(calendarId: string, items: Array<{ href: string; raw: string }>, remote = false): Promise<CollectionContext> {
  const context = await loadCollectionContext(sql, calendarId);
  const upserts: RawItem[] = items.map((i, n) => ({ href: i.href, etag: remote ? null : `"etag-${n}"`, raw: i.raw }));
  await applyCollectionChanges({
    context,
    upserts,
    deletes: [],
    radicaleSkipped: [],
    pending404: [],
    full: true,
    horizon: { start: H.start, end: H.end },
    actor: 'test',
  }, { syncedAt: new Date() });
  return context;
}

async function objectId(calendarId: string, href: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`SELECT id FROM cal_objects WHERE calendar_id = ${calendarId} AND href = ${href}`;
  assert.ok(row, `oggetto ${href} non indicizzato`);
  return row.id;
}

async function componentId(objectIdValue: string, key: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`SELECT id FROM cal_components WHERE object_id = ${objectIdValue} AND recurrence_key = ${key}`;
  assert.ok(row, `componente ${key} assente`);
  return row.id;
}

onDatabaseReady(async () => {
  overrideCalendarStore(null);
  const a = await fx.calendar({ key: 'a', blocks_availability: true });
  const b = await fx.calendar({ key: 'b', blocks_availability: false });
  const f = await fx.holidayCalendar();
  const [bookings] = await sql<Calendar[]>`SELECT * FROM calendars WHERE slug = 'bookings'`;
  const eventType = await fx.eventType({ key: 'store' });
  const { booking } = await fx.booking({ eventType, start: '2027-02-01T10:00:00Z', status: 'confirmed' });

  // Iscrizione con il proprio sidecar (role=subscription), destinazione il calendario a.
  const [sub] = await sql<Array<{ id: string }>>`
    INSERT INTO calendar_subscriptions (calendar_id, name, ics_url, sync_enabled)
    VALUES (${a.id}, ${fx.name('iscrizione')}, 'https://example.invalid/feed.ics', true)
    RETURNING id
  `;
  const sidecarSlug = fx.slug('sub');
  const [sidecar] = await sql<Array<{ id: string }>>`
    INSERT INTO calendars (slug, name, color, timezone, is_default, is_system, blocks_availability, ics_feed_token, ics_feed_enabled,
                           sort_order, collection_name, role, origin, lifecycle, parent_calendar_id, device_visible)
    VALUES (${sidecarSlug}, ${fx.name('sidecar')}, '#123456', 'Europe/Rome', false, false, false,
            ${randomBytes(16).toString('hex')}, false, 0, ${sidecarSlug}, 'subscription', 'admin', 'active', ${a.id}, false)
    RETURNING id
  `;
  await sql`UPDATE calendar_subscriptions SET collection_calendar_id = ${sidecar.id} WHERE id = ${sub.id}`;

  await indexItems(a.id, [
    { href: 'singolo.ics', raw: TEXTS.single },
    { href: 'serie.ics', raw: TEXTS.series },
    { href: 'allday.ics', raw: TEXTS.allDay },
    { href: 'rotto.ics', raw: TEXTS.broken },
  ]);
  await indexItems(sidecar.id, [{ href: 'r-remoto.ics', raw: TEXTS.remote }], true);
  await indexItems(f.id, [{ href: 'it-holiday-2027-01-06.ics', raw: TEXTS.holiday }, { href: 'closure-x1.ics', raw: TEXTS.closure }]);
  const bookingHref = `booking-${booking.uid}.ics`;
  await indexItems(bookings.id, [{
    href: bookingHref,
    raw: ics(vevent([`UID:${booking.uid}@caldes.it`, 'DTSTART:20270201T100000Z', 'DTEND:20270201T103000Z', 'SUMMARY:Prenotazione'])),
  }]);

  const ids: Record<string, string> = {};
  for (const href of ['singolo.ics', 'serie.ics', 'allday.ics', 'rotto.ics']) ids[href] = await objectId(a.id, href);
  sc = {
    a,
    b,
    f,
    bookings,
    sidecarId: sidecar.id,
    subscriptionId: sub.id,
    bookingUid: booking.uid,
    bookingHref,
    ids,
    overrideId: await componentId(ids['serie.ics'], '20270105T080000Z'),
    cancelledOverrideId: await componentId(ids['serie.ics'], '20270107T080000Z'),
  };
  overrideCalendarStore('radicale');
});

onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  setRadicaleFeedBuilder(null);
  await stopIndexWorker();
});

function brief(o: CalendarEventOccurrence): [string, string, boolean, string | null, string] {
  return [o.start_time, o.summary, o.is_override, o.original_start, o.status];
}

describe('RadicaleStore: letture dall\'indice', () => {
  test('listOccurrences: DTO legacy (chiavi e ordine), override, cancellate escluse, all-day, conservativo, iscrizione', async () => {
    const occ = await listOccurrences({ calendarId: sc.a.id, fromIso: '2027-01-04T00:00:00Z', toIso: '2027-01-11T00:00:00Z' });
    for (const o of occ) assert.deepEqual(Object.keys(o), OCCURRENCE_KEYS);
    assert.deepEqual(occ.map(brief), [
      ['2027-01-04T08:00:00.000Z', 'Studio', false, '2027-01-04T08:00:00.000Z', 'confirmed'],
      ['2027-01-04T12:00:00.000Z', 'Riunione', false, null, 'confirmed'],
      ['2027-01-05T10:00:00.000Z', 'Studio spostato', true, '2027-01-05T08:00:00.000Z', 'confirmed'],
      ['2027-01-05T14:00:00.000Z', 'Evento remoto', false, null, 'confirmed'],
      ['2027-01-05T23:00:00.000Z', 'Ferie', false, null, 'confirmed'],
      ['2027-01-08T08:00:00.000Z', 'Studio', false, '2027-01-08T08:00:00.000Z', 'confirmed'],
      ['2027-01-08T15:00:00.000Z', UNREADABLE_SUMMARY, false, null, 'confirmed'],
    ]);
    const single = occ.find((o) => o.summary === 'Riunione') as CalendarEventOccurrence;
    assert.equal(single.id, sc.ids['singolo.ics']);
    assert.equal(single.uid, SINGLE_UID);
    assert.equal(single.source, 'admin');
    assert.equal(single.source_id, 'orig-1');
    assert.equal(single.location, 'Sala A');
    assert.equal(single.calendar_id, sc.a.id);
    const moved = occ.find((o) => o.is_override) as CalendarEventOccurrence;
    assert.equal(moved.id, sc.overrideId, 'un override ha l\'id del proprio componente');
    assert.equal(moved.uid, SERIES_UID, 'differenza ammessa 1: UID del master');
    assert.equal(moved.recurrence_id, '2027-01-05T08:00:00.000Z');
    const master = occ.filter((o) => o.summary === 'Studio');
    assert.ok(master.every((o) => o.id === sc.ids['serie.ics'] && o.recurrence_id === null));
    const allDay = occ.find((o) => o.all_day) as CalendarEventOccurrence;
    assert.equal(allDay.end_time, '2027-01-06T23:00:00.000Z', 'fine esclusiva a mezzanotte di Roma');
    const remote = occ.find((o) => o.summary === 'Evento remoto') as CalendarEventOccurrence;
    assert.equal(remote.calendar_id, sc.a.id, 'le iscrizioni portano il calendario di destinazione');
    assert.equal(remote.source, 'ics_pull');
    assert.equal(remote.source_id, 'remoto-store@google.test');
  });

  test('includeCancelled mostra l\'override cancellato; blockingOnly applica i flag di calendari e iscrizioni', async () => {
    const all = await listOccurrences({ calendarId: sc.a.id, fromIso: '2027-01-07T00:00:00Z', toIso: '2027-01-08T00:00:00Z', includeCancelled: true });
    assert.deepEqual(all.map(brief), [['2027-01-07T08:00:00.000Z', 'Studio', true, '2027-01-07T08:00:00.000Z', 'cancelled']]);
    assert.equal(all[0].id, sc.cancelledOverrideId);
    const none = await listOccurrences({ calendarId: sc.a.id, fromIso: '2027-01-07T00:00:00Z', toIso: '2027-01-08T00:00:00Z' });
    assert.deepEqual(none, []);

    const blocking = await listOccurrences({ fromIso: '2027-01-05T00:00:00Z', toIso: '2027-01-06T00:00:00Z', blockingOnly: true });
    const summaries = blocking.map((o) => o.summary);
    assert.ok(summaries.includes('Studio spostato'));
    assert.ok(!summaries.includes('Evento remoto'), 'iscrizione non bloccante di default (decisione 5)');
    await sql`UPDATE calendar_subscriptions SET blocks_availability = true WHERE id = ${sc.subscriptionId}`;
    try {
      const withSub = await listOccurrences({ fromIso: '2027-01-05T00:00:00Z', toIso: '2027-01-06T00:00:00Z', blockingOnly: true });
      assert.ok(withSub.some((o) => o.summary === 'Evento remoto'), 'flag dell\'iscrizione e del calendario di destinazione');
    } finally {
      await sql`UPDATE calendar_subscriptions SET blocks_availability = false WHERE id = ${sc.subscriptionId}`;
    }
    const other = await listOccurrences({ calendarId: sc.b.id, fromIso: '2027-01-01T00:00:00Z', toIso: '2027-02-01T00:00:00Z' });
    assert.deepEqual(other, []);
  });

  test('oltre l\'orizzonte materializzato si espande al volo da raw_ics', async () => {
    const occ = await listOccurrences({ calendarId: sc.a.id, fromIso: '2029-03-05T00:00:00Z', toIso: '2029-03-12T00:00:00Z' });
    const series = occ.filter((o) => o.summary === 'Studio');
    assert.deepEqual(series.map((o) => o.start_time), [
      '2029-03-05T08:00:00.000Z', '2029-03-06T08:00:00.000Z', '2029-03-08T08:00:00.000Z', '2029-03-09T08:00:00.000Z',
    ]);
    for (const o of series) {
      assert.deepEqual(Object.keys(o), OCCURRENCE_KEYS);
      assert.equal(o.id, sc.ids['serie.ics']);
      assert.equal(o.original_start, o.start_time);
      assert.equal(o.calendar_id, sc.a.id);
    }
    // A cavallo del confine dell'orizzonte: nessun doppione fra query e espansione al volo.
    const edge = await listOccurrences({ calendarId: sc.a.id, fromIso: '2027-12-30T00:00:00Z', toIso: '2028-01-04T00:00:00Z' });
    const starts = edge.filter((o) => o.summary === 'Studio').map((o) => o.start_time);
    assert.deepEqual(starts, ['2027-12-30T08:00:00.000Z', '2027-12-31T08:00:00.000Z', '2028-01-03T08:00:00.000Z']);
  });

  test('getEvent dall\'indice (Radicale non configurato): master, override, UID; getEventOverrides e listEventsForCollection', async () => {
    const master = await getEvent(sc.ids['serie.ics']);
    assert.ok(master);
    assert.deepEqual(Object.keys(master), EVENT_KEYS);
    assert.equal(master.uid, SERIES_UID);
    assert.equal(master.rrule, 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR');
    assert.equal(master.recurrence_master_id, null);
    assert.equal(master.start_time, '2026-01-05T08:00:00.000Z');

    const override = await getEvent(sc.overrideId);
    assert.ok(override);
    assert.equal(override.id, sc.overrideId);
    assert.equal(override.recurrence_master_id, sc.ids['serie.ics']);
    assert.equal(override.recurrence_id, '2027-01-05T08:00:00.000Z');
    assert.equal(override.summary, 'Studio spostato');
    assert.equal(override.rrule, null);

    const byUid = await getEvent(SINGLE_UID);
    assert.equal(byUid?.id, sc.ids['singolo.ics']);
    assert.equal(await getEvent('uid-che-non-esiste@test.invalid'), null);

    const overrides = await getEventOverrides(sc.ids['serie.ics']);
    assert.deepEqual(overrides.map((e) => e.id), [sc.overrideId, sc.cancelledOverrideId]);
    const resources = await listEventsForCollection(sc.a.id);
    assert.deepEqual(resources.map((e) => e.uid).sort(), ['allday-store@test.invalid', SERIES_UID, SINGLE_UID].sort());
  });

  test('UID ambiguo fra due collezioni scrivibili → EventValidationError con i candidati', async () => {
    await indexItems(sc.b.id, [{ href: 'copia.ics', raw: TEXTS.single }]);
    try {
      await assert.rejects(getEvent(SINGLE_UID), (err: unknown) => err instanceof EventValidationError && /Candidati/.test(err.message));
    } finally {
      await sql`DELETE FROM cal_objects WHERE calendar_id = ${sc.b.id}`;
      await sql`DELETE FROM cal_object_ids WHERE calendar_id = ${sc.b.id}`;
    }
  });

  test('getEventBySource: provenienza da collezione e href (system per le festività, X-CALDES per le altre)', async () => {
    const holiday = await getEventBySource('system', 'it-holiday-2027-01-06');
    assert.equal(holiday?.summary, 'Epifania');
    assert.equal(holiday?.calendar_id, sc.f.id);
    const copy = await getEventBySource('admin', 'orig-1');
    assert.equal(copy?.uid, SINGLE_UID);
    assert.equal(await getEventBySource('booking', 'inesistente'), null);
  });

  test('countEventsByCalendar: semantica legacy (override compresi, cancellati esclusi, iscrizioni nel padre)', async () => {
    const counts = await countEventsByCalendar();
    // a: singolo + master + override confermato + all-day = 4, più l'evento remoto dell'iscrizione.
    assert.equal(counts.get(sc.a.id), 5);
    assert.equal(counts.get(sc.f.id), 2);
    assert.equal(counts.get(sc.sidecarId), undefined);
  });

  test('listClosures: collezione holidays senza le it-holiday-*, nessuna creazione', async () => {
    const view = await listClosures();
    assert.equal(view.calendar.id, sc.f.id);
    assert.deepEqual(view.closures.map((c) => [c.summary, c.source, c.status]), [['Ferie estive', 'admin', 'confirmed']]);
  });

  test('calendari: niente sidecar d\'iscrizione né righe non attive; getCalendar idem', async () => {
    const before = (await listCalendars()).map((c) => c.id);
    assert.ok(before.includes(sc.a.id));
    assert.ok(!before.includes(sc.sidecarId));
    assert.equal(await getCalendar(sc.sidecarId), null);
    await sql`UPDATE calendars SET lifecycle = 'deleting' WHERE id = ${sc.b.id}`;
    try {
      assert.ok(!(await listCalendars()).some((c) => c.id === sc.b.id));
      assert.equal(await getCalendar(sc.b.slug), null);
    } finally {
      await sql`UPDATE calendars SET lifecycle = 'active' WHERE id = ${sc.b.id}`;
    }
    const cal = await getCalendar(sc.a.id);
    assert.deepEqual(Object.keys(cal ?? {}), [
      'id', 'slug', 'name', 'description', 'color', 'icon', 'timezone', 'is_default', 'is_system',
      'blocks_availability', 'ics_feed_token', 'ics_feed_enabled', 'sort_order', 'created_at', 'updated_at',
    ]);
  });

  test('buildCalendarFeed delega a feed-builder con il pool principale', async () => {
    let seen: string | null = null;
    setRadicaleFeedBuilder({
      async buildIndexFeed(_db, calendar) {
        seen = calendar.id;
        return { body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', etag: '"x"' };
      },
    });
    try {
      const res = await buildCalendarFeed(sc.a, { now: new Date('2027-01-01T00:00:00Z'), uidDomain: 'api.caldes.test' });
      assert.equal(res.etag, '"x"');
      assert.equal(seen, sc.a.id);
    } finally {
      setRadicaleFeedBuilder(null);
    }
  });
});

describe('RadicaleStore: guardie delle scritture', () => {
  test('createEvent: messaggi legacy prima di Radicale, poi 503 radicale_unreachable', async () => {
    const base = { calendar_id: sc.a.id, summary: 'Prova', start_time: '2027-03-01T09:00:00Z', end_time: '2027-03-01T10:00:00Z' };
    await assert.rejects(createEvent({ ...base, calendar_id: '' }), { message: 'calendar_id richiesto' });
    await assert.rejects(createEvent({ ...base, summary: '  ' }), { message: 'Titolo richiesto' });
    await assert.rejects(createEvent({ ...base, start_time: 'non-una-data' }), { message: 'Date non valide' });
    await assert.rejects(createEvent({ ...base, end_time: base.start_time }), { message: 'end_time deve essere > start_time' });
    await assert.rejects(createEvent({ ...base, source: 'booking' }), EventValidationError);
    await assert.rejects(createEvent({ ...base, source: 'ics_pull' }), EventValidationError);
    // Valori che lo store legacy rifiutava con i vincoli di calendar_events: stesso errore del database
    // (mapDbError: CHECK → 400, foreign key → 409, cast dell'uuid → 400), così route e MCP rispondono come oggi.
    const pgError = (code: string, constraint?: string) => (err: unknown): boolean => {
      const e = err as { code?: string; constraint_name?: string };
      return e.code === code && (constraint === undefined || e.constraint_name === constraint);
    };
    await assert.rejects(createEvent({ ...base, source: 'sconosciuta' as never }), pgError('23514', 'calendar_events_source_check'));
    await assert.rejects(createEvent({ ...base, status: 'sospeso' as never }), pgError('23514', 'calendar_events_status_check'));
    await assert.rejects(createEvent({ ...base, calendar_id: 'non-un-uuid' }), pgError('22P02'));
    await assert.rejects(createEvent({ ...base, calendar_id: '00000000-0000-4000-8000-000000000000' }), pgError('23503', 'calendar_events_calendar_id_fkey'));
    await assert.rejects(createEvent({ ...base, source: 'system', source_id: 'it-holiday-2027-03-01' }), EventValidationError,
      'system solo nel calendario delle festività');
    // Il sidecar di un'iscrizione non è un calendario di destinazione (lo store legacy non lo elencava).
    await assert.rejects(createEvent({ ...base, calendar_id: sc.sidecarId }), pgError('23503', 'calendar_events_calendar_id_fkey'));
    // Validatori di calendar-core (design §8) prima di Radicale: 400, mai 503.
    await assert.rejects(createEvent({ ...base, rrule: 'FREQ=NOPE' }), { message: 'RRULE non valida' });
    await assert.rejects(createEvent({ ...base, rrule: 'FREQ=MINUTELY' }), (err: unknown) => err instanceof EventValidationError && err.message.startsWith('RRULE non valida:'));
    await assert.rejects(createEvent({ ...base, rrule: 'FREQ=HOURLY' }), (err: unknown) => err instanceof EventValidationError && err.message.startsWith('RRULE non valida:'),
      'oltre 5000 istanze nell\'orizzonte: mai scritta una serie che finirebbe troncata');
    await assert.rejects(createEvent(base), (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'radicale_unreachable');
  });

  test('iscrizioni in sola lettura con il testo di assertWritable; proiezione di una prenotazione attiva non eliminabile', async () => {
    const [remote] = await sql<Array<{ id: string }>>`SELECT id FROM cal_objects WHERE calendar_id = ${sc.sidecarId}`;
    await assert.rejects(updateEvent(remote.id, { summary: 'x' }), (err: unknown) => err instanceof EventReadOnlyError && err.message === ICS_READ_ONLY_MESSAGE);
    await assert.rejects(deleteEvent(remote.id), EventReadOnlyError);
    await assert.rejects(createOccurrenceOverride({ masterEventId: remote.id, originalStartIso: '2027-01-05T14:00:00Z' }), EventReadOnlyError);
    const projection = await objectId(sc.bookings.id, sc.bookingHref);
    await assert.rejects(deleteEvent(projection), (err: unknown) => err instanceof EventReadOnlyError && err.message === ACTIVE_BOOKING_MESSAGE);
    // Le modifiche di campo delle proiezioni restano ammesse dall'API (design §9): qui arrivano a Radicale.
    await assert.rejects(updateEvent(projection, { summary: 'x' }), (err: unknown) => err instanceof CalendarUnavailableError);
  });

  test('evento inesistente: updateEvent null, deleteEvent false, override → Master event non trovato', async () => {
    assert.equal(await updateEvent('00000000-0000-4000-8000-000000000000', { summary: 'x' }), null);
    assert.equal(await deleteEvent('00000000-0000-4000-8000-000000000000'), false);
    await assert.rejects(createOccurrenceOverride({ masterEventId: 'inesistente', originalStartIso: '2027-01-05T08:00:00Z' }), { message: 'Master event non trovato' });
    await assert.rejects(createOccurrenceOverride({ masterEventId: sc.overrideId, originalStartIso: '2027-01-05T08:00:00Z' }), { message: 'L\'evento non è ricorrente' });
  });

  test('replaceSubscriptionEvents è solo dello store legacy', async () => {
    await assert.rejects(getRadicaleStore().replaceSubscriptionEvents(sc.subscriptionId, sc.a.id, []), CalendarStoreUnavailableError);
  });

  test('projectionDescription ricompone il testo della proiezione legacy (booking.ts)', async () => {
    const [booking] = await sql`SELECT * FROM calendar_bookings WHERE uid = ${sc.bookingUid}`;
    const [legacy] = await sql<Array<{ description: string }>>`
      SELECT description FROM calendar_events WHERE source = 'booking' AND source_id = ${sc.bookingUid}
    `;
    assert.ok(legacy, 'proiezione legacy creata dalla fixture');
    assert.equal(projectionDescription(booking as never), legacy.description);
  });
});
