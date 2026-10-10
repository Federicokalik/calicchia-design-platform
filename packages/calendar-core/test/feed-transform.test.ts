/**
 * feed-transform.ts: feed ICS pubblico dall'indice (design §10) e contenuto
 * delle proiezioni delle prenotazioni (decisione 3).
 *
 * - parità con il feed legacy (ics-feed.ts): stessi UID per gli oggetti
 *   migrati, stessi campi, stessa finestra, cancellati esclusi;
 * - correzioni del §14: override con l'UID del master, override cancellati
 *   come EXDATE;
 * - DTSTAMP stabile ed ETag che cambia solo quando cambia il corpo;
 * - privacy: whitelist, CLASS:PRIVATE → "Occupato";
 * - proiezioni: UID legacy, titolo con il nome, telefono e link all'admin,
 *   niente email/azienda/messaggio/ATTENDEE, "Prenotazione" dopo 24 mesi.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  BOOKING_PROJECTION_MINIMIZED_SUMMARY,
  bookingHref,
  bookingProjectionContent,
  type BookingProjectionData,
  buildBookingProjection,
  buildEventFromLegacy,
  buildFeed,
  type CalendarObject,
  contentSha256,
  createCalendarObject,
  deriveProvenance,
  FEED_PRIVATE_SUMMARY,
  FEED_PRODID,
  type FeedObjectInput,
  feedUid,
  getProperties,
  getProperty,
  getSubcomponents,
  getTextValue,
  type IcsComponent,
  isBookingProjectionExpired,
  parseCalendarObjectOrThrow,
  parseIcsOrThrow,
  readTimeProperty,
  serializeObject,
  splitCalendar,
  toLegacyEventFields,
  transformObjectForFeed,
  validateObject,
} from '../src/index';
import { assertPhysicalForm, fixture, ics, REPO_ROOT } from './helpers';
import { EV_ALLDAY, EV_CANCELLED, EV_OVERRIDE, EV_SERIES, EV_SINGLE, FEED_CALENDAR, FEED_EVENTS, type LegacyEventLike } from './legacy-inputs';

const TZ = 'Europe/Rome';
const NOW = new Date('2026-10-09T08:00:00Z');
const FIRST_SEEN = new Date('2026-09-01T10:00:00Z');
const DOMAIN = 'api.caldes.test';
const OPTS = { now: NOW, uidDomain: DOMAIN, tz: TZ };
const CAL_INFO = { name: FEED_CALENDAR.name, description: FEED_CALENDAR.description, timezone: FEED_CALENDAR.timezone, color: FEED_CALENDAR.color };

function eventObject(lines: string[], extra: string[] = []): CalendarObject {
  return parseCalendarObjectOrThrow(ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', ...extra, 'END:VCALENDAR']));
}

function input(object: CalendarObject, extra: Partial<FeedObjectInput> = {}): FeedObjectInput {
  return { object, firstSeenAt: FIRST_SEEN, ...extra };
}

/** Oggetti migrati dalle righe legacy (come farà il serializer F3), con legacy_uid = uid della riga. */
function migratedInputs(): FeedObjectInput[] {
  const build = (ev: LegacyEventLike, masterStart?: ReturnType<typeof readTimeProperty>): IcsComponent =>
    buildEventFromLegacy({ ...ev, legacy_id: ev.id }, { tz: TZ, seriesTz: TZ, now: new Date(ev.updated_at), masterStart });
  const series = build(EV_SERIES);
  const override = build({ ...EV_OVERRIDE, uid: EV_SERIES.uid }, readTimeProperty(getProperty(series, 'DTSTART') as never));
  return [
    input(createCalendarObject({ uid: EV_SINGLE.uid, master: build(EV_SINGLE) }), { legacyUid: EV_SINGLE.uid }),
    input(createCalendarObject({ uid: EV_ALLDAY.uid, master: build(EV_ALLDAY) }), { legacyUid: EV_ALLDAY.uid }),
    input(createCalendarObject({ uid: EV_SERIES.uid, master: series, overrides: [override] }), { legacyUid: EV_SERIES.uid }),
    input(createCalendarObject({ uid: EV_CANCELLED.uid, master: build(EV_CANCELLED) }), { legacyUid: EV_CANCELLED.uid }),
  ];
}

const FEED_PATH = resolve(REPO_ROOT, 'apps/api/src/lib/calendar/ics-feed.ts');
const liveFeed = existsSync(FEED_PATH)
  ? ((await import(pathToFileURL(FEED_PATH).href)) as { buildIcsFeed(opts: Record<string, unknown>): string }).buildIcsFeed
  : null;

describe('feedUid', () => {
  test('oggetti migrati: UID legacy più dominio (anche se contiene @); altri: suffisso solo senza @', () => {
    assert.equal(feedUid('bk7Hq2xLm9Pa@caldes.it', { uidDomain: DOMAIN, legacyUid: 'projlegacy000001' }), 'projlegacy000001@api.caldes.test');
    assert.equal(feedUid('evt@google.com', { uidDomain: DOMAIN, legacyUid: 'evt@google.com' }), 'evt@google.com@api.caldes.test');
    assert.equal(feedUid('nanoid0000000001', { uidDomain: DOMAIN }), 'nanoid0000000001@api.caldes.test');
    assert.equal(feedUid('ABC-123@icloud.com', { uidDomain: DOMAIN, legacyUid: null }), 'ABC-123@icloud.com');
  });
});

describe('parità con il feed legacy', () => {
  const legacyTexts: Array<{ label: string; text: () => string; skip: string | false }> = [
    { label: 'fixture', text: () => fixture('legacy-feed.ics'), skip: false },
    {
      label: 'live',
      text: () => (liveFeed as NonNullable<typeof liveFeed>)({ calendar: FEED_CALENDAR, events: FEED_EVENTS, uidDomain: DOMAIN }),
      skip: liveFeed ? false : 'sorgente dell\'API non raggiungibile da questo checkout',
    },
  ];
  for (const src of legacyTexts) {
    test(`stessi UID, stessi campi, cancellati esclusi, override con l'UID del master (${src.label})`, { skip: src.skip }, () => {
      const legacy = parseIcsOrThrow(src.text()).components.filter((c) => c.name === 'VEVENT');
      const { body } = buildFeed(CAL_INFO, migratedInputs(), OPTS);
      assertPhysicalForm(body);
      const ours = parseIcsOrThrow(body).components.filter((c) => c.name === 'VEVENT');

      const legacyMasters = legacy.filter((c) => !getProperty(c, 'RECURRENCE-ID'));
      const ourMasters = ours.filter((c) => !getProperty(c, 'RECURRENCE-ID'));
      const uid = (c: IcsComponent): string => getTextValue(c, 'UID') ?? '';
      assert.deepEqual(ourMasters.map(uid).sort(), legacyMasters.map(uid).sort());
      assert.ok(!ours.some((c) => uid(c).startsWith(EV_CANCELLED.uid)));

      for (const lm of legacyMasters) {
        const om = ourMasters.find((c) => uid(c) === uid(lm)) as IcsComponent;
        const a = toLegacyEventFields(lm, { tz: TZ });
        const b = toLegacyEventFields(om, { tz: TZ });
        assert.deepEqual({ ...b }, { ...a }, `campi diversi per ${uid(lm)}`);
      }

      // L'override: stesso contenuto, ma con l'UID del master (§14) invece del proprio.
      const legacyOverride = legacy.find((c) => getProperty(c, 'RECURRENCE-ID')) as IcsComponent;
      const ourOverride = ours.find((c) => getProperty(c, 'RECURRENCE-ID')) as IcsComponent;
      assert.equal(uid(legacyOverride), `${EV_OVERRIDE.uid}@${DOMAIN}`);
      assert.equal(uid(ourOverride), `${EV_SERIES.uid}@${DOMAIN}`);
      const { uid: _u1, ...lf } = toLegacyEventFields(legacyOverride, { tz: TZ });
      const { uid: _u2, ...of } = toLegacyEventFields(ourOverride, { tz: TZ });
      assert.deepEqual(of, lf);
    });
  }

  test('intestazione come il feed legacy, PRODID stabile', () => {
    const { body } = buildFeed(CAL_INFO, migratedInputs(), OPTS);
    const head = body.split('\r\n').slice(0, 9);
    assert.deepEqual(head, [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:${FEED_PRODID}`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Lavoro\\, clienti',
      'X-WR-CALDESC:Calendario Lavoro\\, clienti',
      'X-WR-TIMEZONE:Europe/Rome',
      'X-APPLE-CALENDAR-COLOR:#2563eb',
    ]);
    // Un solo VTIMEZONE Europe/Rome (canonico), anche con più oggetti che lo usano.
    assert.equal(body.match(/BEGIN:VTIMEZONE/g)?.length, 1);
    assert.ok(body.includes('TZID:Europe/Rome'));
  });
});

describe('finestra, filtri e correzioni del §14', () => {
  const single = (start: string, end: string, extra: string[] = []): CalendarObject =>
    eventObject([`UID:s-${start}`, 'DTSTAMP:20260101T000000Z', `DTSTART:${start}`, `DTEND:${end}`, 'SUMMARY:Singolo', ...extra]);

  test('singoli nella finestra [now − 90 g, now + 365 g] con la condizione del legacy; serie sempre', () => {
    assert.ok(transformObjectForFeed(input(single('20260712T080000Z', '20260712T090000Z')), OPTS)); // −89 g
    assert.equal(transformObjectForFeed(input(single('20260701T080000Z', '20260701T090000Z')), OPTS), null); // −100 g
    assert.ok(transformObjectForFeed(input(single('20271001T080000Z', '20271001T090000Z')), OPTS)); // +357 g
    assert.equal(transformObjectForFeed(input(single('20271101T080000Z', '20271101T090000Z')), OPTS), null); // +388 g
    // In corso a cavallo dell'inizio della finestra: incluso.
    assert.ok(transformObjectForFeed(input(single('20260601T080000Z', '20260801T090000Z')), OPTS));
    const oldSeries = eventObject(['UID:old', 'DTSTAMP:20260101T000000Z', 'DTSTART:20200106T080000Z', 'DTEND:20200106T090000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20200301T000000Z']);
    assert.ok(transformObjectForFeed(input(oldSeries), OPTS));
    // range_start/range_end dell'indice, se noti, al posto del calcolo.
    assert.equal(transformObjectForFeed(input(single('20261015T080000Z', '20261015T090000Z'), { rangeStart: Date.UTC(2020, 0, 1), rangeEnd: Date.UTC(2020, 0, 2) }), OPTS), null);
  });

  test('STATUS:CANCELLED escluso, anche scritto da un device; oggetti non VEVENT esclusi', () => {
    assert.equal(transformObjectForFeed(input(single('20261015T080000Z', '20261015T090000Z', ['STATUS:cancelled'])), OPTS), null);
    const todo = parseCalendarObjectOrThrow(ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO', 'UID:t', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261015T080000Z', 'END:VTODO', 'END:VCALENDAR']));
    assert.equal(transformObjectForFeed(input(todo), OPTS), null);
  });

  test('override cancellato → EXDATE del master tipizzata come il DTSTART; gli altri override con l\'UID del master', () => {
    const obj = eventObject(
      ['UID:serie-1', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Rome:20261012T090000', 'DTEND;TZID=Europe/Rome:20261012T100000', 'RRULE:FREQ=DAILY;COUNT=10', 'EXDATE;TZID=Europe/Rome:20261013T090000', 'SUMMARY:Serie'],
      [
        'BEGIN:VEVENT', 'UID:serie-1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20261014T070000Z', 'DTSTART;TZID=Europe/Rome:20261014T090000', 'DTEND;TZID=Europe/Rome:20261014T100000', 'STATUS:CANCELLED', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:serie-1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;TZID=Europe/Rome:20261015T090000', 'DTSTART;TZID=Europe/Rome:20261015T150000', 'DTEND;TZID=Europe/Rome:20261015T160000', 'SUMMARY:Spostata', 'END:VEVENT',
      ],
    );
    const out = transformObjectForFeed(input(obj), OPTS);
    assert.ok(out);
    assert.equal(out.components.length, 2);
    const [master, override] = out.components;
    const exdates = getProperties(master, 'EXDATE').map((p) => `${p.params.map((x) => `${x.name}=${x.values[0]}`).join(';')}:${p.value}`);
    assert.deepEqual(exdates, ['TZID=Europe/Rome:20261013T090000', 'TZID=Europe/Rome:20261014T090000']);
    assert.equal(getTextValue(override, 'UID'), `serie-1@${DOMAIN}`);
    assert.equal(getTextValue(override, 'SUMMARY'), 'Spostata');
    assert.deepEqual(out.tzids, ['Europe/Rome']);
  });

  test('risorsa con soli override: ognuno nella propria finestra', () => {
    const obj = parseCalendarObjectOrThrow(
      ics([
        'BEGIN:VCALENDAR', 'VERSION:2.0',
        'BEGIN:VEVENT', 'UID:inv', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20261020T080000Z', 'DTSTART:20261020T090000Z', 'DTEND:20261020T100000Z', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:inv', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20200120T080000Z', 'DTSTART:20200120T090000Z', 'DTEND:20200120T100000Z', 'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    const out = transformObjectForFeed(input(obj), OPTS);
    assert.equal(out?.components.length, 1);
  });
});

describe('privacy e DTSTAMP', () => {
  test('whitelist: niente VALARM, ATTENDEE, ORGANIZER, X-*, proprietà sconosciute né CLASS', () => {
    const apple = parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'));
    const out = transformObjectForFeed(input(apple), OPTS);
    assert.ok(out);
    for (const c of out.components) {
      assert.deepEqual(getSubcomponents(c, 'VALARM'), []);
      assert.equal(c.components.length, 0);
      for (const p of c.properties) {
        assert.ok(
          ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'STATUS', 'TRANSP', 'SEQUENCE', 'CREATED', 'LAST-MODIFIED'].includes(p.name),
          `proprietà ${p.name} nel feed`,
        );
      }
    }
    const { body } = buildFeed(CAL_INFO, [input(apple)], OPTS);
    assert.ok(!/mailto:|ATTENDEE|ORGANIZER|X-APPLE-STRUCTURED|VALARM|NEWIANAPROP/.test(body));
  });

  test('CLASS:PRIVATE/CONFIDENTIAL → "Occupato" senza descrizione, luogo e link; l\'override senza CLASS eredita', () => {
    const obj = eventObject(
      ['UID:p', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261012T080000Z', 'DTEND:20261012T090000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'CLASS:CONFIDENTIAL', 'SUMMARY:Visita medica', 'DESCRIPTION:Dettagli', 'LOCATION:Ospedale', 'URL:https://x.test'],
      ['BEGIN:VEVENT', 'UID:p', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20261013T080000Z', 'DTSTART:20261013T100000Z', 'DTEND:20261013T110000Z', 'SUMMARY:Visita spostata', 'LOCATION:Altro', 'END:VEVENT'],
    );
    const out = transformObjectForFeed(input(obj), OPTS);
    assert.ok(out);
    for (const c of out.components) {
      assert.equal(getTextValue(c, 'SUMMARY'), FEED_PRIVATE_SUMMARY);
      assert.equal(getProperty(c, 'DESCRIPTION'), null);
      assert.equal(getProperty(c, 'LOCATION'), null);
      assert.equal(getProperty(c, 'URL'), null);
    }
    const pub = eventObject(['UID:q', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261012T080000Z', 'DTEND:20261012T090000Z', 'CLASS:PUBLIC', 'SUMMARY:Riunione']);
    const pubOut = transformObjectForFeed(input(pub), OPTS)?.components[0] as IcsComponent;
    assert.equal(getTextValue(pubOut, 'SUMMARY'), 'Riunione');
    // TRANSP assente → OPAQUE esplicito come il feed legacy; TRANSPARENT resta.
    assert.equal(getProperty(pubOut, 'TRANSP')?.value, 'OPAQUE');
    const free = eventObject(['UID:r', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261012T080000Z', 'DTEND:20261012T090000Z', 'TRANSP:TRANSPARENT']);
    assert.deepEqual(getProperties(transformObjectForFeed(input(free), OPTS)?.components[0] as IcsComponent, 'TRANSP').map((p) => p.value), ['TRANSPARENT']);
  });

  test('DTSTAMP stabile (LAST-MODIFIED o first_seen_at): due richieste a orari diversi danno lo stesso corpo e lo stesso ETag', () => {
    const apple = parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'));
    const out = transformObjectForFeed(input(apple), OPTS);
    assert.equal(getProperty(out?.components[0] as IcsComponent, 'DTSTAMP')?.value, '20261001T081500Z'); // LAST-MODIFIED del master
    assert.equal(getProperty(out?.components[1] as IcsComponent, 'DTSTAMP')?.value, '20260901T100000Z'); // first_seen_at
    const inputs = [...migratedInputs(), input(apple)];
    const a = buildFeed(CAL_INFO, inputs, OPTS);
    const b = buildFeed(CAL_INFO, inputs, { ...OPTS, now: new Date(NOW.getTime() + 5 * 60_000) });
    assert.equal(b.body, a.body);
    assert.equal(b.etag, a.etag);
    assert.equal(a.etag, `"${contentSha256(a.body)}"`);
    // L'ordine degli oggetti in ingresso non conta.
    assert.equal(buildFeed(CAL_INFO, [...inputs].reverse(), OPTS).etag, a.etag);
  });

  test('ETag diverso quando la finestra scorre e un evento esce', () => {
    const inputs = migratedInputs();
    const today = buildFeed(CAL_INFO, inputs, OPTS);
    // Il singolo del 14/10/2026 esce dalla finestra dopo 90 giorni.
    const later = buildFeed(CAL_INFO, inputs, { ...OPTS, now: new Date('2027-01-13T08:00:00Z') });
    assert.notEqual(later.etag, today.etag);
    assert.ok(today.body.includes(`UID:${EV_SINGLE.uid}@${DOMAIN}`));
    assert.ok(!later.body.includes(`UID:${EV_SINGLE.uid}@${DOMAIN}`));
  });

  test('un oggetto che la trasformazione non sa trattare resta fuori senza far fallire il feed, e viene segnalato', () => {
    const inputs = migratedInputs();
    const good = buildFeed(CAL_INFO, inputs, OPTS);
    // Albero corrotto (difetto inatteso, non un valore illeggibile): TypeError dentro la trasformazione.
    const corrupt = input({ ...createCalendarObject({ uid: 'rotto', master: null }), master: { name: 'VEVENT', properties: undefined as never, components: [] } });
    const reported: string[] = [];
    const res = buildFeed(CAL_INFO, [...inputs, corrupt], { ...OPTS, onObjectError: (i, err) => reported.push(`${i.object.uid}:${err.code}`) });
    assert.deepEqual(reported, ['rotto:INTERNAL']);
    assert.equal(res.body, good.body);
    assert.equal(res.etag, good.etag);
    // Senza callback l'oggetto è solo escluso.
    assert.equal(buildFeed(CAL_INFO, [corrupt, ...inputs], OPTS).etag, good.etag);
  });

  test('VTIMEZONE personalizzati dagli oggetti, deduplicati; nessuno per i TZID sconosciuti', () => {
    const custom = parseCalendarObjectOrThrow(fixture('custom-tz.ics'));
    const unknown = eventObject(['UID:u', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Pianeta/Marte:20261012T090000', 'DTEND;TZID=Pianeta/Marte:20261012T100000', 'SUMMARY:x']);
    const { body } = buildFeed(CAL_INFO, [input(custom, { rangeStart: NOW.getTime(), rangeEnd: NOW.getTime() + 3600_000 }), input(custom), input(unknown)], { ...OPTS, pastDays: 1000 });
    assert.equal(body.match(/TZID:Ora di Roma \(personalizzata\)/g)?.length, 1);
    assert.ok(!body.includes('TZID:Non referenziato'));
    assert.ok(!body.includes('TZID:Pianeta/Marte\r\n'));
  });

  test('TZID uguali ai nomi di Object.prototype: il feed esce, l\'oggetto con quel TZID non lo rompe', () => {
    const inputs = migratedInputs();
    const good = buildFeed(CAL_INFO, inputs, OPTS);
    for (const tzid of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', '(UTC+01:00) constructor', '(UTC) __proto__']) {
      const bad = eventObject([
        'UID:proto@x',
        'DTSTAMP:20260101T000000Z',
        `DTSTART;TZID="${tzid}":20261012T090000`,
        `DTEND;TZID="${tzid}":20261012T100000`,
        'RRULE:FREQ=WEEKLY',
        'SUMMARY:serie',
      ]);
      const reported: string[] = [];
      const res = buildFeed(CAL_INFO, [...inputs, input(bad)], { ...OPTS, onObjectError: (i, err) => reported.push(`${i.object.uid}:${err.code}`) });
      assert.deepEqual(reported, [], tzid);
      // Gli altri oggetti escono identici (il TZID sconosciuto non produce VTIMEZONE).
      for (const obj of splitCalendar(parseIcsOrThrow(good.body)).objects) assert.ok(res.body.includes(`UID:${obj.uid}`), tzid);
      assert.ok(res.body.includes('UID:proto@x'), tzid);
    }
  });

  test('un oggetto che non si serializza resta fuori con onObjectError, gli altri escono', () => {
    const inputs = migratedInputs();
    const good = buildFeed(CAL_INFO, inputs, OPTS);
    // Valore con un a capo non codificato: SerializeError solo per questo oggetto.
    const broken = eventObject(['UID:rotto@x', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261012T090000Z', 'DTEND:20261012T100000Z', 'SUMMARY:ok']);
    (getProperty(broken.master as IcsComponent, 'SUMMARY') as { value: string }).value = 'riga\nspezzata';
    const reported: string[] = [];
    const res = buildFeed(CAL_INFO, [...inputs, input(broken)], { ...OPTS, onObjectError: (i) => reported.push(i.object.uid) });
    assert.deepEqual(reported, ['rotto@x']);
    assert.equal(res.etag, good.etag);
  });

  test('stesso TZID personalizzato con definizioni diverse: il secondo viene rinominato e il feed coincide con l\'indice', () => {
    const custom = (uid: string, offset: string): CalendarObject =>
      eventObject(
        [`UID:${uid}`, 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Customized Time Zone:20261012T090000', 'DTEND;TZID=Customized Time Zone:20261012T100000', 'SUMMARY:x'],
        ['BEGIN:VTIMEZONE', 'TZID:Customized Time Zone', 'BEGIN:STANDARD', 'DTSTART:16010101T000000', `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, 'END:STANDARD', 'END:VTIMEZONE'],
      );
    const ny = custom('ny@x', '-0400');
    const rome = custom('rome@x', '+0200');
    const ctx = (o: CalendarObject) => ({ tz: TZ, timezones: o.timezones });
    const indexStart = (o: CalendarObject) => toLegacyEventFields(o.master as IcsComponent, ctx(o)).start_time;
    const { body } = buildFeed(CAL_INFO, [input(rome), input(ny), input(custom('rome2@x', '+0200'))], OPTS);
    const parsed = splitCalendar(parseIcsOrThrow(body));
    assert.equal(parsed.objects.length, 3);
    for (const obj of parsed.objects) {
      const original = { 'ny@x': ny, 'rome@x': rome, 'rome2@x': rome }[obj.uid] as CalendarObject;
      assert.equal(toLegacyEventFields(obj.master as IcsComponent, ctx(obj)).start_time, indexStart(original), obj.uid);
    }
    // Due VTIMEZONE: quello condiviso dalle due definizioni uguali e quello rinominato.
    assert.equal(body.match(/BEGIN:VTIMEZONE/g)?.length, 2);
    assert.match(body, /TZID:Customized Time Zone \([0-9a-f]{8}\)/);
    // Stessa definizione due volte: nessuna rinomina.
    const same = buildFeed(CAL_INFO, [input(rome), input(custom('rome2@x', '+0200'))], OPTS).body;
    assert.equal(same.match(/BEGIN:VTIMEZONE/g)?.length, 1);
    assert.ok(!/Customized Time Zone \(/.test(same));
  });

  test('ALTREP e gli altri parametri dei campi TEXT non escono nel feed (resta LANGUAGE)', () => {
    const obj = eventObject([
      'UID:alt@x',
      'DTSTAMP:20260101T000000Z',
      'DTSTART:20261012T090000Z',
      'DTEND:20261012T100000Z',
      'SUMMARY;LANGUAGE=it;X-FOO=bar:Riunione',
      'DESCRIPTION;ALTREP="data:text/html,%3Cp%3EChiamare%20Mario%20al%20333%201234567%3C%2Fp%3E":Riunione spostata',
      'LOCATION;ALTREP="http://x.test/mappa?tel=3331234567":Studio',
    ]);
    const { body } = buildFeed(CAL_INFO, [input(obj)], OPTS);
    assert.ok(!body.includes('ALTREP'), body);
    assert.ok(!body.includes('333'), body);
    assert.ok(body.includes('SUMMARY;LANGUAGE=it:Riunione'));
    assert.ok(!body.includes('X-FOO'));
    // Anche nel ramo delle proiezioni (il contenuto si ricompone sul componente copiato).
    const projection = buildFeed(CAL_INFO, [input(obj, { bookingProjection: { data: null } })], OPTS).body;
    assert.ok(!projection.includes('ALTREP') && !projection.includes('333'), projection);
  });
});

describe('proiezioni delle prenotazioni (decisione 3)', () => {
  const DATA: BookingProjectionData = {
    bookingUid: 'bk7Hq2xLm9Pa',
    title: 'Consulenza gratuita',
    attendeeName: 'Rossi, Mario',
    attendeePhone: '+39 333 1234567',
    adminUrl: 'https://admin.caldes.test/calendario/prenotazioni?uid=bk7Hq2xLm9Pa',
    start: '2026-10-12T08:00:00.000Z',
    end: '2026-10-12T08:30:00.000Z',
    location: null,
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
  };

  test('contenuto: titolo con il nome, telefono e link all\'admin; mai email, azienda, messaggio', () => {
    const c = bookingProjectionContent(DATA, { now: NOW });
    assert.deepEqual(c, {
      summary: 'Consulenza gratuita – Rossi, Mario',
      description: 'Tel: +39 333 1234567\nPrenotazione: https://admin.caldes.test/calendario/prenotazioni?uid=bk7Hq2xLm9Pa',
      location: 'https://meet.google.com/abc-defg-hij',
      url: 'https://meet.google.com/abc-defg-hij',
      minimized: false,
    });
    assert.equal(bookingProjectionContent({ ...DATA, attendeePhone: null, adminUrl: null }, { now: NOW }).description, null);
    // Come la risorsa scritta dall'API: luogo della prenotazione se c'è, URL solo per i link http(s).
    const inPerson = bookingProjectionContent({ ...DATA, location: 'Via Roma 1', meetingUrl: 'tel:+390612345' }, { now: NOW });
    assert.deepEqual([inPerson.location, inPerson.url], ['Via Roma 1', null]);
  });

  test('dopo 24 mesi dalla fine, o senza dati: solo "Prenotazione"', () => {
    assert.equal(isBookingProjectionExpired(DATA.end, new Date('2028-10-12T08:29:59Z')), false);
    assert.equal(isBookingProjectionExpired(DATA.end, new Date('2028-10-12T08:30:00Z')), true);
    const minimized = { summary: BOOKING_PROJECTION_MINIMIZED_SUMMARY, description: null, location: null, url: null, minimized: true };
    assert.deepEqual(bookingProjectionContent(DATA, { now: new Date('2028-11-01T00:00:00Z') }), minimized);
    assert.deepEqual(bookingProjectionContent(null, { now: NOW }), minimized);
  });

  test('risorsa per la collezione bookings: UID dell\'invito, nessun ATTENDEE/ORGANIZER/VALARM, valida e riconosciuta come proiezione', () => {
    const obj = buildBookingProjection({ ...DATA, location: 'Via Roma 1' }, { now: NOW, tz: TZ, sequence: 1 });
    assert.equal(obj.uid, 'bk7Hq2xLm9Pa@caldes.it');
    const text = serializeObject(obj);
    assertPhysicalForm(text);
    assert.ok(text.includes('DTSTART;TZID=Europe/Rome:20261012T100000'));
    assert.ok(text.includes('SUMMARY:Consulenza gratuita – Rossi\\, Mario'));
    assert.ok(text.includes('STATUS:CONFIRMED'));
    assert.ok(!/ATTENDEE|ORGANIZER|VALARM|mailto:|X-CALDES-SOURCE/.test(text));
    const f = toLegacyEventFields(obj.master as IcsComponent, { tz: TZ });
    assert.equal(f.start_time, DATA.start);
    assert.equal(f.end_time, DATA.end);
    assert.equal(f.location, 'Via Roma 1');
    assert.equal(validateObject(obj, { tz: TZ, now: NOW }).ok, true);
    assert.deepEqual(deriveProvenance({ role: 'bookings', href: bookingHref(DATA.bookingUid), component: obj.master }), { source: 'booking', source_id: 'bk7Hq2xLm9Pa' });
  });

  test('feed: proiezione migrata con email nella DESCRIPTION → UID legacy e contenuto della decisione 3', () => {
    // Proiezione migrata tale e quale dalla riga legacy (caso peggiore: testo con email, azienda e note).
    const legacyRow = buildEventFromLegacy(
      {
        uid: 'bk7Hq2xLm9Pa@caldes.it',
        summary: 'Consulenza gratuita – Rossi, Mario',
        description: 'Cliente: Rossi, Mario <mario.rossi@example.com>\nTel: +39 333 1234567\nAzienda: Rossi SRL\n\nNote:\nVorrei un preventivo\n\nUID prenotazione: bk7Hq2xLm9Pa',
        url: 'https://meet.google.com/abc-defg-hij',
        start_time: DATA.start as string,
        end_time: DATA.end as string,
        source: 'booking',
        source_id: 'bk7Hq2xLm9Pa',
      },
      { tz: TZ, now: NOW },
    );
    const migrated = createCalendarObject({ uid: 'bk7Hq2xLm9Pa@caldes.it', master: legacyRow });
    const { body } = buildFeed(CAL_INFO, [input(migrated, { legacyUid: 'projlegacy000001', bookingProjection: { data: DATA } })], OPTS);
    const [obj] = splitCalendar(parseIcsOrThrow(body)).objects;
    assert.equal(obj.uid, `projlegacy000001@${DOMAIN}`); // l'UID che gli abbonati vedono oggi
    if (liveFeed) {
      // Lo stesso UID che ics-feed.ts produce oggi per la riga legacy della proiezione.
      const legacyProjectionRow: LegacyEventLike = {
        ...EV_SINGLE,
        id: '33333333-3333-4333-8333-333333333301',
        uid: 'projlegacy000001',
        summary: 'Consulenza gratuita – Rossi, Mario',
        start_time: DATA.start as string,
        end_time: DATA.end as string,
        source: 'booking',
        source_id: 'bk7Hq2xLm9Pa',
      };
      const legacyBody = liveFeed({ calendar: FEED_CALENDAR, events: [legacyProjectionRow], uidDomain: DOMAIN });
      assert.equal(splitCalendar(parseIcsOrThrow(legacyBody)).objects[0].uid, obj.uid);
    }
    const v = obj.master as IcsComponent;
    assert.equal(getTextValue(v, 'SUMMARY'), 'Consulenza gratuita – Rossi, Mario');
    assert.equal(getTextValue(v, 'DESCRIPTION'), bookingProjectionContent(DATA, { now: NOW }).description);
    assert.ok(!/mario\.rossi@example\.com|Rossi SRL|preventivo|Azienda|X-CALDES/.test(body));

    // Senza più la prenotazione (erasure GDPR): solo "Prenotazione".
    const gone = buildFeed(CAL_INFO, [input(migrated, { legacyUid: 'projlegacy000001', bookingProjection: { data: null } })], OPTS).body;
    const gv = splitCalendar(parseIcsOrThrow(gone)).objects[0].master as IcsComponent;
    assert.equal(getTextValue(gv, 'SUMMARY'), BOOKING_PROJECTION_MINIMIZED_SUMMARY);
    assert.equal(getProperty(gv, 'DESCRIPTION'), null);
    assert.equal(getProperty(gv, 'URL'), null);
    assert.ok(!/Rossi/.test(gone));
  });
});
