/**
 * Gli ICS prodotti oggi dall'API (apps/api/src/lib/calendar/ics.ts e
 * ics-feed.ts) letti da calendar-core senza perdite: invito della
 * prenotazione (REQUEST e CANCEL), feed pubblico e risorsa CalDAV legacy.
 *
 * Ogni caso gira due volte: sulle fixture catturate (test/fixtures/legacy-*.ics,
 * DTSTAMP normalizzato) e, se il codice dell'API è raggiungibile dal
 * pacchetto, sull'output generato al momento con gli stessi input
 * (test/legacy-inputs.ts). Il pacchetto non dipende da apps/api: senza il
 * sorgente dell'API i casi "live" vengono saltati con il motivo.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  getParam,
  getProperties,
  getProperty,
  getSubcomponents,
  parseCalendarObjectOrThrow,
  parseIcsOrThrow,
  readEvent,
  serializeCalendar,
  serializeObject,
  splitCalendar,
  toLegacyEventFields,
} from '../src/index';
import { assertPhysicalForm, fixture, normalizeDtstamp, REPO_ROOT } from './helpers';
import {
  BOOKING,
  BOOKING_EVENT_TYPE,
  BOOKING_OPTIONS,
  EV_ALLDAY,
  EV_OVERRIDE,
  EV_SERIES,
  EV_SINGLE,
  FEED_CALENDAR,
  FEED_EVENTS,
} from './legacy-inputs';

const ROME = { tz: 'Europe/Rome' };

interface LegacyGenerators {
  buildIcs(opts: Record<string, unknown>): string;
  buildIcsFeed(opts: Record<string, unknown>): string;
  buildIcsResource(opts: Record<string, unknown>): string;
}

const ICS_PATH = resolve(REPO_ROOT, 'apps/api/src/lib/calendar/ics.ts');
const FEED_PATH = resolve(REPO_ROOT, 'apps/api/src/lib/calendar/ics-feed.ts');

async function loadGenerators(): Promise<LegacyGenerators | null> {
  if (!existsSync(ICS_PATH) || !existsSync(FEED_PATH)) return null;
  const ics = (await import(pathToFileURL(ICS_PATH).href)) as Pick<LegacyGenerators, 'buildIcs'>;
  const feed = (await import(pathToFileURL(FEED_PATH).href)) as Pick<LegacyGenerators, 'buildIcsFeed' | 'buildIcsResource'>;
  return { buildIcs: ics.buildIcs, buildIcsFeed: feed.buildIcsFeed, buildIcsResource: feed.buildIcsResource };
}

const generators = await loadGenerators();
const SKIP_LIVE = generators ? false : 'sorgente dell\'API non raggiungibile da questo checkout';

type Source = { label: string; text: () => string; skip: string | false };

function sources(fixtureName: string, live: (g: LegacyGenerators) => string): Source[] {
  return [
    { label: 'fixture', text: () => fixture(fixtureName), skip: false },
    { label: 'live', text: () => normalizeDtstamp(live(generators as LegacyGenerators)), skip: SKIP_LIVE },
  ];
}

/** La descrizione che ics.ts compone per l'invito. */
const EXPECTED_BOOKING_DESCRIPTION = [
  BOOKING_EVENT_TYPE.description,
  `\n\nMessaggio: ${BOOKING.attendee_message}`,
  `\n\nLink meeting: ${BOOKING_OPTIONS.meetingUrl}`,
  `\n\nGestisci la prenotazione: ${BOOKING_OPTIONS.manageUrl}`,
].join('');

describe('invito della prenotazione (ics.ts)', () => {
  for (const src of sources('legacy-booking-request.ics', (g) => g.buildIcs({ booking: BOOKING, eventType: BOOKING_EVENT_TYPE, ...BOOKING_OPTIONS, method: 'REQUEST' }))) {
    test(`REQUEST (${src.label})`, { skip: src.skip }, () => {
      const obj = parseCalendarObjectOrThrow(src.text());
      assert.equal(obj.uid, `${BOOKING.uid}@caldes.it`);
      assert.equal(getProperty({ name: 'VCALENDAR', properties: obj.calendarProperties, components: [] }, 'METHOD')?.value, 'REQUEST');
      const master = obj.master!;
      assert.equal(getSubcomponents(master, 'VALARM').length, 2);
      const attendee = getProperty(master, 'ATTENDEE')!;
      assert.deepEqual(getParam(attendee, 'PARTSTAT')?.values, ['ACCEPTED']);
      assert.equal(readEvent(master).attendees[0].cn, 'Rossi, Mario', 'CN con la virgola "escapata" da ics.ts');
      assert.equal(readEvent(master).organizer?.cn, BOOKING_OPTIONS.organizerName);

      const f = toLegacyEventFields(master, ROME);
      assert.equal(f.start_time, BOOKING.start_time);
      assert.equal(f.end_time, BOOKING.end_time);
      assert.equal(f.summary, BOOKING_EVENT_TYPE.title);
      assert.equal(f.description, EXPECTED_BOOKING_DESCRIPTION);
      assert.equal(f.location, BOOKING_OPTIONS.meetingUrl);
      assert.equal(f.status, 'confirmed');
      assert.equal(readEvent(master).sequence, BOOKING_OPTIONS.sequence);

      // Round-trip: stesso albero, folding a 75 ottetti anche con emoji e accentate.
      const again = serializeObject(obj, { prodid: 'preserve' });
      assertPhysicalForm(again);
      assert.deepEqual(parseCalendarObjectOrThrow(again).master, master);
    });
  }

  for (const src of sources('legacy-booking-cancel.ics', (g) => g.buildIcs({ booking: BOOKING, eventType: BOOKING_EVENT_TYPE, ...BOOKING_OPTIONS, method: 'CANCEL' }))) {
    test(`CANCEL (${src.label})`, { skip: src.skip }, () => {
      const obj = parseCalendarObjectOrThrow(src.text());
      const v = readEvent(obj.master!);
      assert.equal(v.status, 'CANCELLED');
      assert.equal(v.transp, 'TRANSPARENT');
      assert.equal(v.alarms.length, 0);
      assert.equal(toLegacyEventFields(obj.master!, ROME).status, 'cancelled');
    });
  }
});

describe('feed pubblico (ics-feed.ts buildIcsFeed)', () => {
  for (const src of sources('legacy-feed.ics', (g) => g.buildIcsFeed({ calendar: FEED_CALENDAR, events: FEED_EVENTS, uidDomain: 'api.caldes.test' }))) {
    test(`eventi, all-day, serie con EXDATE e override (${src.label})`, { skip: src.skip }, () => {
      const cal = parseIcsOrThrow(src.text());
      const split = splitCalendar(cal);
      assert.deepEqual(split.errors, []);
      const byUid = new Map(split.objects.map((o) => [o.uid, o]));
      assert.equal(byUid.size, 4, 'l\'evento cancellato è escluso dal feed');

      const single = toLegacyEventFields(byUid.get(`${EV_SINGLE.uid}@api.caldes.test`)!.master!, ROME);
      assert.deepEqual(
        [single.start_time, single.end_time, single.summary, single.description, single.location, single.url],
        [EV_SINGLE.start_time, EV_SINGLE.end_time, EV_SINGLE.summary, EV_SINGLE.description, EV_SINGLE.location, EV_SINGLE.url],
      );

      const allDay = toLegacyEventFields(byUid.get(`${EV_ALLDAY.uid}@api.caldes.test`)!.master!, ROME);
      assert.deepEqual([allDay.start_time, allDay.end_time, allDay.all_day], [EV_ALLDAY.start_time, EV_ALLDAY.end_time, true]);

      const series = byUid.get(`${EV_SERIES.uid}@api.caldes.test`)!;
      assert.equal(series.timezones.length, 1);
      const s = toLegacyEventFields(series.master!, { ...ROME, timezones: series.timezones });
      assert.deepEqual([s.start_time, s.end_time, s.rrule, s.exdates], [EV_SERIES.start_time, EV_SERIES.end_time, EV_SERIES.rrule, EV_SERIES.exdates]);

      // Bug del feed legacy (design §14): l'override esce con un UID suo, quindi
      // diventa una risorsa con il solo override (master assente).
      const ov = byUid.get(`${EV_OVERRIDE.uid}@api.caldes.test`)!;
      assert.equal(ov.master, null);
      const o = toLegacyEventFields(ov.overrides[0], ROME);
      assert.deepEqual([o.start_time, o.end_time, o.recurrence_id], [EV_OVERRIDE.start_time, EV_OVERRIDE.end_time, EV_OVERRIDE.recurrence_id]);

      // Forma canonica: VTIMEZONE legacy sostituito da quello del registro, X-WR-* conservate.
      const canonical = serializeCalendar(cal);
      assertPhysicalForm(canonical);
      const re = parseIcsOrThrow(canonical);
      assert.equal(getProperty(re.components.find((c) => c.name === 'VTIMEZONE')!, 'X-LIC-LOCATION')?.value, 'Europe/Rome');
      assert.equal(getProperty(re, 'X-WR-CALNAME')?.value, 'Lavoro\\, clienti');
      assert.equal(getProperties(re, 'METHOD')[0].value, 'PUBLISH');
      assert.equal(re.components.filter((c) => c.name === 'VEVENT').length, 4);
    });
  }
});

describe('risorsa CalDAV legacy (ics-feed.ts buildIcsResource)', () => {
  for (const src of sources('legacy-resource.ics', (g) => g.buildIcsResource({ calendar: FEED_CALENDAR, master: EV_SERIES, overrides: [EV_OVERRIDE], uidDomain: 'caldes.it' }))) {
    test(`master e override con lo stesso UID (${src.label})`, { skip: src.skip }, () => {
      const obj = parseCalendarObjectOrThrow(src.text());
      assert.equal(obj.uid, `${EV_SERIES.uid}@caldes.it`);
      assert.ok(obj.master);
      assert.equal(obj.overrides.length, 1);
      const ctx = { ...ROME, timezones: obj.timezones };
      const m = toLegacyEventFields(obj.master, ctx);
      assert.deepEqual([m.rrule, m.exdates, m.recurrence_id], [EV_SERIES.rrule, EV_SERIES.exdates, null]);
      const o = toLegacyEventFields(obj.overrides[0], ctx);
      assert.equal(o.uid, `${EV_SERIES.uid}@caldes.it`, 'override con l\'UID del master (differenza ammessa n. 1)');
      assert.equal(o.recurrence_id, EV_OVERRIDE.recurrence_id);
      assert.equal(o.start_time, EV_OVERRIDE.start_time);
    });
  }
});
