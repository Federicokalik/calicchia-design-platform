/**
 * model.ts: codifiche TEXT e temporali, durate, recurrence key, vista
 * tipizzata dell'evento, mappatura sul DTO dell'API nei due sensi,
 * provenienza X-CALDES-* e regola "blocks".
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  addDurationToTime,
  bookingHref,
  bookingProjectionUid,
  buildEventFromLegacy,
  classifyOccurrenceKind,
  closureHref,
  computeBlocks,
  CONSERVATIVE_RECURRENCE_KEY,
  createCalendarObject,
  createComponent,
  createProperty,
  createTimeListProperties,
  decodeParamValue,
  decodeText,
  deriveProvenance,
  encodeParamValue,
  encodeText,
  formatDurationValue,
  getParamValue,
  getProperties,
  getProperty,
  holidayHref,
  holidayUid,
  IcsValueError,
  isClientSource,
  isRecurrenceKey,
  joinTextList,
  legacyStatusOf,
  MASTER_RECURRENCE_KEY,
  normalizeLegacyRrule,
  parseCalendarObjectOrThrow,
  parseDurationValue,
  parseObjectHref,
  parseRecurrenceKey,
  parseTimeValue,
  readEvent,
  readTimeListProperty,
  readTimeProperty,
  recurrenceKeyOf,
  recurrenceKeyToTime,
  removeProperties,
  serializeObject,
  setParam,
  setProperty,
  setProvenance,
  setTextValue,
  splitTextList,
  timeToIso,
  toLegacyEventFields,
  UNTITLED_SUMMARY,
  utcMsToTime,
  type IcsComponent,
  type IcsDateTime,
  type IcsWarning,
  type LegacyEventFields,
} from '../src/index';
import { fixture, ics } from './helpers';
import { EV_ALLDAY, EV_OVERRIDE, EV_SERIES, EV_SINGLE, type LegacyEventLike } from './legacy-inputs';

const ROME = { tz: 'Europe/Rome' };
const NOW = new Date('2026-10-09T10:00:00Z');

/** Il VEVENT di un oggetto con un solo componente (master o override). */
function vevent(lines: string[]): IcsComponent {
  const obj = parseCalendarObjectOrThrow(ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR']));
  return obj.master ?? obj.overrides[0];
}

function legacyFieldsOf(ev: LegacyEventLike): LegacyEventFields {
  return {
    uid: ev.uid,
    summary: ev.summary,
    description: ev.description,
    location: ev.location,
    url: ev.url,
    start_time: ev.start_time,
    end_time: ev.end_time,
    all_day: ev.all_day,
    rrule: ev.rrule,
    exdates: ev.exdates,
    recurrence_id: ev.recurrence_id,
    status: ev.status,
  };
}

describe('TEXT e parametri', () => {
  test('escape e unescape di TEXT', () => {
    assert.equal(encodeText('a\\b;c,d\ne\r\nf'), 'a\\\\b\\;c\\,d\\ne\\nf');
    assert.equal(decodeText('a\\\\b\\;c\\,d\\ne\\Nf'), 'a\\b;c,d\ne\nf');
    assert.equal(decodeText('C:\\Utenti'), 'C:\\Utenti', 'escape sconosciuti restano letterali');
    for (const s of ['semplice', 'con, virgole; e\nrighe', 'àèìòù 😀 € \\ fine\\']) assert.equal(decodeText(encodeText(s)), s);
  });

  test('liste TEXT (CATEGORIES)', () => {
    assert.deepEqual(splitTextList('lavoro,cliente\\, importante,'), ['lavoro', 'cliente, importante', '']);
    assert.equal(joinTextList(['a,b', 'c']), 'a\\,b,c');
  });

  test('RFC 6868 nei parametri', () => {
    assert.equal(decodeParamValue("Via Roma^n00100 ^'Roma^' ^^"), 'Via Roma\n00100 "Roma" ^');
    assert.equal(encodeParamValue('a\n"b"^'), "a^n^'b^'^^");
  });

  test('helper dell\'albero: set e remove conservano l\'ordine', () => {
    const c = createComponent('VEVENT', [createProperty('UID', 'u'), createProperty('SUMMARY', 'a'), createProperty('X-A', '1'), createProperty('SUMMARY', 'b')]);
    setProperty(c, createProperty('SUMMARY', 'nuovo'));
    assert.deepEqual(c.properties.map((p) => `${p.name}:${p.value}`), ['UID:u', 'SUMMARY:nuovo', 'X-A:1']);
    setTextValue(c, 'DESCRIPTION', 'riga, una');
    assert.equal(getProperty(c, 'DESCRIPTION')?.value, 'riga\\, una');
    setTextValue(c, 'DESCRIPTION', null);
    assert.equal(removeProperties(c, 'X-A'), 1);
    const p = createProperty('ATTENDEE', 'mailto:a@b', { CN: 'A', ROLE: 'CHAIR' });
    setParam(p, 'CN', 'B');
    setParam(p, 'ROLE', null);
    assert.deepEqual(p.params, [{ name: 'CN', values: ['B'] }]);
  });
});

describe('valori temporali e durate', () => {
  test('DATE, DATE-TIME UTC, floating e con TZID', () => {
    assert.deepEqual(parseTimeValue('20261009', { value: 'DATE' }), { type: 'date', year: 2026, month: 10, day: 9 });
    assert.deepEqual(parseTimeValue('20261009'), { type: 'date', year: 2026, month: 10, day: 9 }, 'senza VALUE=DATE');
    assert.deepEqual(parseTimeValue('20261009T090000Z').type === 'date-time' && (parseTimeValue('20261009T090000Z') as IcsDateTime).zone, { kind: 'utc' });
    assert.deepEqual((parseTimeValue('20261009T090000') as IcsDateTime).zone, { kind: 'floating' });
    assert.deepEqual((parseTimeValue('20261009T090000', { tzid: 'Europe/Rome' }) as IcsDateTime).zone, { kind: 'tzid', tzid: 'Europe/Rome' });
    assert.deepEqual((parseTimeValue('20261009T090000Z', { tzid: 'Europe/Rome' }) as IcsDateTime).zone, { kind: 'utc' }, 'la Z vince');
  });

  test('valori non validi → IcsValueError tipizzati', () => {
    const isValueError = (code: string) => (err: unknown) => err instanceof IcsValueError && err.code === code;
    assert.throws(() => parseTimeValue('20260230', { value: 'DATE' }), isValueError('INVALID_DATE'));
    assert.throws(() => parseTimeValue('2026-10-09T09:00:00Z'), isValueError('INVALID_DATE_TIME'));
    assert.throws(() => parseTimeValue('20261009T250000'), isValueError('INVALID_DATE_TIME'));
    assert.throws(() => parseTimeValue('20261009', { value: 'PERIOD' }), isValueError('INVALID_VALUE'));
    assert.throws(() => parseDurationValue('P'), isValueError('INVALID_DURATION'));
    assert.throws(() => parseDurationValue('PT'), isValueError('INVALID_DURATION'));
    assert.throws(() => parseDurationValue('1H'), isValueError('INVALID_DURATION'));
  });

  test('liste EXDATE/RDATE, PERIOD e raggruppamento per tipo e zona', () => {
    const ex = readTimeListProperty(createProperty('EXDATE', '20261012T090000,20261013T090000', { TZID: 'Europe/Rome' }));
    assert.equal(ex.length, 2);
    const rd = readTimeListProperty(createProperty('RDATE', '20261015T080000Z/20261015T090000Z,20261016T080000Z/PT2H', { VALUE: 'PERIOD' }));
    assert.equal(rd[0].type, 'period');
    assert.equal(rd[1].type === 'period' && rd[1].duration?.hours, 2);
    const props = createTimeListProperties('EXDATE', [
      { type: 'date', year: 2026, month: 12, day: 25 },
      { type: 'date-time', year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } },
      { type: 'date', year: 2026, month: 12, day: 26 },
    ]);
    assert.deepEqual(props.map((p) => [p.params.map((x) => `${x.name}=${x.values[0]}`).join(';'), p.value]), [
      ['VALUE=DATE', '20261225,20261226'],
      ['TZID=Europe/Rome', '20261012T090000'],
    ]);
  });

  test('durate: forma canonica e aritmetica nominale a cavallo del cambio d\'ora', () => {
    assert.equal(formatDurationValue(parseDurationValue('P1W')), 'P1W');
    assert.equal(formatDurationValue(parseDurationValue('P1DT2H')), 'P1DT2H');
    assert.equal(formatDurationValue(parseDurationValue('-PT15M')), '-PT15M');
    assert.equal(formatDurationValue(parseDurationValue('PT0S')), 'PT0S');
    assert.equal(formatDurationValue(parseDurationValue('P1W2D')), 'P9D');
    const start = parseTimeValue('20261024T090000', { tzid: 'Europe/Rome' });
    // P1D è nominale: stessa ora da muro il giorno dopo (25 ore reali).
    const plusDay = addDurationToTime(start, parseDurationValue('P1D'), ROME);
    assert.equal(timeToIso(plusDay, ROME), '2026-10-25T08:00:00.000Z');
    // PT24H è esatto: 08:00 locali dopo il ritorno all'ora solare.
    const plus24h = addDurationToTime(start, parseDurationValue('PT24H'), ROME);
    assert.equal(timeToIso(plus24h, ROME), '2026-10-25T07:00:00.000Z');
    assert.equal((plus24h as IcsDateTime).hour, 8);
  });

  test('utcMsToTime tipizza come il valore di riferimento', () => {
    const ms = Date.parse('2026-10-12T07:00:00Z');
    assert.deepEqual(utcMsToTime(ms, parseTimeValue('20261009T090000', { tzid: 'Europe/Rome' }), ROME), {
      type: 'date-time', year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' },
    });
    assert.deepEqual(utcMsToTime(ms, parseTimeValue('20261009', { value: 'DATE' }), ROME), { type: 'date', year: 2026, month: 10, day: 12 });
  });
});

describe('recurrence key', () => {
  test('formato canonico per DATE, UTC, TZID e floating', () => {
    assert.equal(MASTER_RECURRENCE_KEY, '');
    assert.equal(recurrenceKeyOf(parseTimeValue('20261012', { value: 'DATE' }), ROME), '20261012');
    assert.equal(recurrenceKeyOf(parseTimeValue('20261012T090000', { tzid: 'Europe/Rome' }), ROME), '20261012T070000Z');
    assert.equal(recurrenceKeyOf(parseTimeValue('20261012T070000Z'), ROME), '20261012T070000Z');
    assert.equal(recurrenceKeyOf(parseTimeValue('20261012T090000'), ROME), '20261012T090000', 'floating senza Z');
    assert.equal(recurrenceKeyOf(parseTimeValue('20261012T090000'), { tz: 'America/New_York' }), '20261012T090000', 'stabile al cambio di fuso');
  });

  test('parse e conversione verso il tipo del DTSTART del master', () => {
    assert.deepEqual(parseRecurrenceKey(''), { type: 'master' });
    assert.deepEqual(parseRecurrenceKey(CONSERVATIVE_RECURRENCE_KEY), { type: 'conservative' });
    assert.deepEqual(parseRecurrenceKey('20261012'), { type: 'date', date: '2026-10-12' });
    assert.deepEqual(parseRecurrenceKey('20261012T070000Z'), { type: 'instant', utcMs: Date.parse('2026-10-12T07:00:00Z') });
    assert.ok(!isRecurrenceKey('2026-10-12'));
    assert.throws(() => parseRecurrenceKey('20261312'), (err: unknown) => err instanceof IcsValueError && err.code === 'INVALID_RECURRENCE_KEY');
    const masterTimed = parseTimeValue('20261009T090000', { tzid: 'Europe/Rome' });
    assert.deepEqual(recurrenceKeyToTime('20261012T070000Z', masterTimed, ROME), { ...masterTimed, day: 12 });
    // Chiave DATE su master timed: ora da muro del master.
    assert.deepEqual(recurrenceKeyToTime('20261013', masterTimed, ROME), { ...masterTimed, day: 13 });
    // Chiave istante su master DATE: data locale.
    assert.deepEqual(recurrenceKeyToTime('20261012T223000Z', parseTimeValue('20261009', { value: 'DATE' }), ROME), {
      type: 'date', year: 2026, month: 10, day: 13,
    });
    assert.throws(() => recurrenceKeyToTime('', masterTimed, ROME), IcsValueError);
  });
});

describe('vista tipizzata (readEvent)', () => {
  test('fixture Apple: campi, VALARM, invitati, geo, categorie', () => {
    const obj = parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'));
    const v = readEvent(obj.master!);
    assert.equal(v.uid, '6B29FC40-CA47-1067-B31D-00DD010662DA');
    assert.equal(v.summary, 'Visita al Colosseo con Mario');
    assert.equal(v.location, 'Colosseo\nPiazza del Colosseo, 00184 Roma RM, Italia');
    assert.equal(v.transp, 'OPAQUE');
    assert.deepEqual(v.rrules, ['FREQ=WEEKLY;COUNT=10;BYDAY=MO']);
    assert.equal(v.attendees.length, 2);
    assert.equal(v.attendees[0].cn, 'Rossi, Mario');
    assert.equal(v.organizer?.value, 'mailto:info@calicchia.test');
    assert.equal(v.alarms.length, 2);
    assert.equal(v.created?.year, 2026);
    assert.deepEqual(v.warnings, []);
    const ov = readEvent(obj.overrides[0]);
    assert.equal(ov.recurrenceId?.type === 'date-time' && ov.recurrenceId.day, 19);
  });

  test('avvisi non fatali: duplicati, DTEND e DURATION, tipi misti, EXDATE rotto, valori numerici e GEO non validi', () => {
    const v = readEvent(
      vevent([
        'UID:w', 'DTSTART;VALUE=DATE:20261009', 'DTEND:20261010T000000Z', 'DURATION:P1D', 'SUMMARY:a', 'SUMMARY:b',
        'EXDATE:non-valida', 'PRIORITY:alta', 'GEO:999;0', 'CATEGORIES:a,b\\,c', 'DTSTAMP:boh',
        'X-CALDES-SOURCE:mcp', 'X-CALDES-LEGACY-ID:1234',
      ]),
    );
    const codes = v.warnings.map((w) => w.code).sort();
    assert.deepEqual(codes, [
      'DTEND_AND_DURATION', 'DUPLICATE_PROPERTY', 'INVALID_PROPERTY_VALUE', 'INVALID_PROPERTY_VALUE', 'INVALID_PROPERTY_VALUE',
      'INVALID_PROPERTY_VALUE', 'VALUE_TYPE_MISMATCH',
    ]);
    assert.equal(v.summary, 'a');
    assert.deepEqual(v.exdates, []);
    assert.equal(v.priority, null);
    assert.equal(v.geo, null);
    assert.deepEqual(v.categories, ['a', 'b,c']);
    assert.deepEqual(v.caldes, { source: 'mcp', sourceId: null, legacyId: '1234', legacyRrule: null });
  });

  test('errori fatali: DTSTART assente o illeggibile, RECURRENCE-ID e DURATION non validi', () => {
    const isValueError = (code: string) => (err: unknown) => err instanceof IcsValueError && err.code === code;
    assert.throws(() => readEvent(vevent(['UID:x', 'SUMMARY:senza inizio'])), isValueError('MISSING_PROPERTY'));
    assert.throws(() => readEvent(vevent(['UID:x', 'DTSTART:ieri'])), isValueError('INVALID_DATE_TIME'));
    assert.throws(() => readEvent(vevent(['UID:x', 'DTSTART:20261009T090000Z', 'RECURRENCE-ID:boh'])), IcsValueError);
    assert.throws(() => readEvent(vevent(['UID:x', 'DTSTART:20261009T090000Z', 'DURATION:1 ora'])), isValueError('INVALID_DURATION'));
  });
});

describe('DTO legacy', () => {
  test('timed con TZID, floating e TZID sconosciuto (con avviso)', () => {
    const timed = toLegacyEventFields(vevent(['UID:t', 'DTSTART;TZID=Europe/Rome:20261012T090000', 'DTEND;TZID=Europe/Rome:20261012T100000', 'SUMMARY:Ciao\\, mondo']), ROME);
    assert.deepEqual([timed.start_time, timed.end_time, timed.summary, timed.all_day], ['2026-10-12T07:00:00.000Z', '2026-10-12T08:00:00.000Z', 'Ciao, mondo', false]);
    const floating = vevent(['UID:f', 'DTSTART:20261012T090000', 'DTEND:20261012T100000']);
    assert.equal(toLegacyEventFields(floating, ROME).start_time, '2026-10-12T07:00:00.000Z');
    assert.equal(toLegacyEventFields(floating, { tz: 'America/New_York' }).start_time, '2026-10-12T13:00:00.000Z');
    const warnings: IcsWarning[] = [];
    const unknown = toLegacyEventFields(vevent(['UID:u', 'DTSTART;TZID=Boh:20261012T090000']), { ...ROME, onWarning: (w) => warnings.push(w) });
    assert.equal(unknown.start_time, '2026-10-12T07:00:00.000Z');
    assert.equal(unknown.end_time, unknown.start_time, 'senza DTEND né DURATION: durata nulla');
    assert.deepEqual(warnings.map((w) => w.code), ['UNKNOWN_TZID']);
  });

  test('all-day: mezzanotte di Roma, fine esclusiva, anche con DURATION o senza fine', () => {
    const allDay = toLegacyEventFields(vevent(['UID:a', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261226']), ROME);
    assert.deepEqual([allDay.start_time, allDay.end_time, allDay.all_day], ['2026-12-23T23:00:00.000Z', '2026-12-25T23:00:00.000Z', true]);
    assert.equal(toLegacyEventFields(vevent(['UID:a', 'DTSTART;VALUE=DATE:20261224']), ROME).end_time, '2026-12-24T23:00:00.000Z');
    assert.equal(toLegacyEventFields(vevent(['UID:a', 'DTSTART;VALUE=DATE:20261224', 'DURATION:P3D']), ROME).end_time, '2026-12-26T23:00:00.000Z');
    const dst = toLegacyEventFields(vevent(['UID:a', 'DTSTART;VALUE=DATE:20261025', 'DTEND;VALUE=DATE:20261026']), ROME);
    assert.deepEqual([dst.start_time, dst.end_time], ['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z']);
  });

  test('stato, titolo mancante, stringhe vuote, EXDATE e RECURRENCE-ID in ISO', () => {
    const f = toLegacyEventFields(
      vevent([
        'UID:s', 'DTSTART;TZID=Europe/Rome:20261012T090000', 'DTEND;TZID=Europe/Rome:20261012T100000', 'STATUS:TENTATIVE', 'DESCRIPTION:', 'LOCATION:',
        'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Rome:20261019T090000,20261102T090000',
      ]),
      ROME,
    );
    assert.equal(f.status, 'tentative');
    assert.equal(f.summary, UNTITLED_SUMMARY);
    assert.equal(f.description, null);
    assert.equal(f.location, null);
    assert.deepEqual(f.exdates, ['2026-10-19T07:00:00.000Z', '2026-11-02T08:00:00.000Z']);
    assert.equal(legacyStatusOf('NEEDS-ACTION'), 'confirmed');
    assert.equal(legacyStatusOf(null), 'confirmed');
    assert.equal(legacyStatusOf('cancelled'), 'cancelled');
    assert.throws(
      () => toLegacyEventFields(createComponent('VEVENT', [createProperty('DTSTART', '20261009T090000Z')]), ROME),
      (err: unknown) => err instanceof IcsValueError && err.code === 'MISSING_PROPERTY' && err.property === 'UID',
    );
  });

  test('DTEND precedente a DTSTART → durata nulla con avviso', () => {
    const warnings: IcsWarning[] = [];
    const f = toLegacyEventFields(vevent(['UID:e', 'DTSTART:20261012T090000Z', 'DTEND:20261012T080000Z']), { ...ROME, onWarning: (w) => warnings.push(w) });
    assert.equal(f.end_time, f.start_time);
    assert.deepEqual(warnings.map((w) => w.code), ['END_BEFORE_START']);
  });

  test('ida e ritorno DTO → VEVENT → testo → DTO per le forme di produzione', () => {
    const cases: Array<{ ev: LegacyEventLike; masterStart?: boolean }> = [
      { ev: EV_SINGLE },
      { ev: EV_ALLDAY },
      { ev: EV_SERIES },
      { ev: { ...EV_OVERRIDE, uid: EV_SERIES.uid }, masterStart: true },
    ];
    const seriesMaster = buildEventFromLegacy({ ...EV_SERIES }, { tz: 'Europe/Rome', now: NOW });
    for (const { ev, masterStart } of cases) {
      const comp = buildEventFromLegacy(
        { ...ev, source: ev.source, legacy_id: ev.id },
        { tz: 'Europe/Rome', now: NOW, masterStart: masterStart ? readTimeProperty(getProperty(seriesMaster, 'DTSTART')!) : null },
      );
      const text = serializeObject(createCalendarObject({ uid: ev.uid, master: comp }));
      const parsed = parseCalendarObjectOrThrow(text);
      const back = parsed.master ?? parsed.overrides[0];
      assert.deepEqual(toLegacyEventFields(back, ROME), legacyFieldsOf(ev), ev.uid);
      assert.equal(getProperty(back, 'X-CALDES-LEGACY-ID')?.value, ev.id);
    }
  });

  test('builder: serie timed con TZID della serie, singoli con TZID del calendario, all-day in DATE', () => {
    const series = buildEventFromLegacy({ ...EV_SERIES }, { tz: 'America/New_York', seriesTz: 'Europe/Rome', now: NOW });
    assert.equal(getParamValue(getProperty(series, 'DTSTART')!, 'TZID'), 'Europe/Rome');
    assert.equal(getProperty(series, 'DTSTART')?.value, '20260907T090000');
    assert.equal(getProperty(series, 'EXDATE')?.value, '20261102T090000');
    const single = buildEventFromLegacy({ ...EV_SINGLE }, { tz: 'Europe/Rome', now: NOW });
    assert.equal(getProperty(single, 'DTSTART')?.value, '20261014T153000');
    assert.equal(getProperty(single, 'DTSTAMP')?.value, '20261009T100000Z');
    assert.equal(getProperty(single, 'STATUS')?.value, 'CONFIRMED');
    assert.equal(getProperty(single, 'TRANSP'), null, 'nessun TRANSP: timed OPAQUE, all-day non bloccanti');
    const utc = buildEventFromLegacy({ ...EV_SINGLE }, { tz: 'UTC', now: NOW });
    assert.equal(getProperty(utc, 'DTSTART')?.value, '20261014T133000Z');
    const allDay = buildEventFromLegacy({ ...EV_ALLDAY, rrule: 'FREQ=YEARLY;UNTIL=20301224T000000Z', exdates: ['2027-12-23T23:00:00.000Z'] }, { tz: 'Europe/Rome', now: NOW });
    assert.equal(getProperty(allDay, 'DTSTART')?.value, '20261224');
    assert.equal(getParamValue(getProperty(allDay, 'DTSTART')!, 'VALUE'), 'DATE');
    assert.equal(getProperty(allDay, 'DTEND')?.value, '20261226');
    assert.equal(getProperty(allDay, 'RRULE')?.value, 'FREQ=YEARLY;UNTIL=20301224');
    assert.equal(getProperty(allDay, 'EXDATE')?.value, '20271224');
  });

  test('festività di produzione (timed 00:00–24:00 di Roma, source=system) e chiusura manuale', () => {
    const holiday = buildEventFromLegacy(
      { uid: 'h1', summary: 'Natale', start_time: '2026-12-24T23:00:00.000Z', end_time: '2026-12-25T23:00:00.000Z', all_day: false, source: 'system', source_id: 'it-holiday-2026-12-25' },
      { tz: 'Europe/Rome', now: NOW },
    );
    assert.equal(getProperty(holiday, 'DTSTART')?.value, '20261225T000000');
    assert.equal(getProperty(holiday, 'DTEND')?.value, '20261226T000000');
    assert.equal(getProperty(holiday, 'X-CALDES-SOURCE')?.value, 'system');
    const f = toLegacyEventFields(holiday, ROME);
    assert.deepEqual([f.start_time, f.end_time, f.all_day], ['2026-12-24T23:00:00.000Z', '2026-12-25T23:00:00.000Z', false]);
  });

  test('normalizeLegacyRrule: UNTIL coerente con DTSTART, semantica legacy', () => {
    assert.equal(normalizeLegacyRrule('RRULE:FREQ=WEEKLY;UNTIL=20261231T000000Z', { allDay: false, tz: 'Europe/Rome' }), 'FREQ=WEEKLY;UNTIL=20261231T000000Z');
    // UNTIL DATE su serie timed: per il legacy è la mezzanotte locale (esclude il giorno).
    assert.equal(normalizeLegacyRrule('FREQ=DAILY;UNTIL=20261231', { allDay: false, tz: 'Europe/Rome' }), 'FREQ=DAILY;UNTIL=20261230T230000Z');
    assert.equal(normalizeLegacyRrule('FREQ=DAILY;UNTIL=20261231T120000', { allDay: false, tz: 'Europe/Rome' }), 'FREQ=DAILY;UNTIL=20261231T110000Z');
    assert.equal(normalizeLegacyRrule('FREQ=DAILY;COUNT=5', { allDay: true, tz: 'Europe/Rome' }), 'FREQ=DAILY;COUNT=5');
    assert.equal(normalizeLegacyRrule('FREQ=DAILY;UNTIL=20261230T230000Z', { allDay: true, tz: 'Europe/Rome' }), 'FREQ=DAILY;UNTIL=20261231');
  });

  test('builder: input non valido → errore tipizzato', () => {
    assert.throws(
      () => buildEventFromLegacy({ uid: 'x', summary: 'x', start_time: 'domani', end_time: 'dopodomani' }, { tz: 'Europe/Rome', now: NOW }),
      (err: unknown) => err instanceof IcsValueError && err.code === 'INVALID_ISO',
    );
  });
});

describe('provenienza e regola blocks', () => {
  test('href speciali', () => {
    assert.equal(bookingHref('bk7Hq2xLm9Pa'), 'booking-bk7Hq2xLm9Pa.ics');
    assert.equal(bookingProjectionUid('bk7Hq2xLm9Pa'), 'bk7Hq2xLm9Pa@caldes.it');
    assert.equal(holidayHref('2026-12-25'), 'it-holiday-2026-12-25.ics');
    assert.equal(holidayUid('2026-12-25'), 'it-holiday-2026-12-25@caldes.it');
    assert.equal(closureHref('abc'), 'closure-abc.ics');
    assert.deepEqual(parseObjectHref('/federico/bookings/booking-bk7Hq2xLm9Pa.ics'), {
      basename: 'booking-bk7Hq2xLm9Pa.ics', kind: 'booking', bookingUid: 'bk7Hq2xLm9Pa', holidayDate: null, closureId: null,
    });
    assert.equal(parseObjectHref('/federico/f/it-holiday-2026-12-25.ics').holidayDate, '2026-12-25');
    assert.equal(parseObjectHref('/federico/sub-1234abcd/r-abcdefghijklmnopqrstuvwxyz.ics').kind, 'remote');
    assert.equal(parseObjectHref('/federico/lavoro/6B29FC40.ics').kind, 'other');
  });

  test('deriveProvenance: solo collezione e href decidono booking e system', () => {
    const declared = (source: string) => createComponent('VEVENT', [createProperty('UID', 'x'), createProperty('X-CALDES-SOURCE', source)]);
    assert.deepEqual(deriveProvenance({ role: 'bookings', href: 'booking-bk1.ics' }), { source: 'booking', source_id: 'bk1' });
    assert.deepEqual(deriveProvenance({ role: 'bookings', href: 'evento.ics', component: declared('booking') }), { source: 'manual', source_id: null });
    assert.deepEqual(deriveProvenance({ role: 'bookings', href: 'evento.ics', component: declared('admin') }), { source: 'admin', source_id: null });
    assert.deepEqual(deriveProvenance({ role: 'holidays', href: 'it-holiday-2026-12-25.ics' }), { source: 'system', source_id: 'it-holiday-2026-12-25' });
    assert.deepEqual(deriveProvenance({ role: 'holidays', href: 'closure-1.ics' }), { source: 'admin', source_id: null });
    assert.deepEqual(deriveProvenance({ role: 'holidays', href: 'x.ics', component: declared('system') }), { source: 'admin', source_id: null });
    assert.deepEqual(deriveProvenance({ role: 'user', href: 'booking-bk1.ics' }), { source: 'manual', source_id: null }, 'booking-* fuori da bookings non conta');
    assert.deepEqual(deriveProvenance({ role: 'user', href: 'x.ics', component: declared('MCP') }), { source: 'mcp', source_id: null });
    assert.deepEqual(deriveProvenance({ role: 'subscription', href: 'r-x.ics', uid: 'remote@google.com' }), { source: 'ics_pull', source_id: 'remote@google.com' });
    // source_id da X-CALDES-SOURCE-ID per le source non di sistema (copie di "Duplica": source=admin, source_id = id originale).
    const duplicated = declared('admin');
    duplicated.properties.push(createProperty('X-CALDES-SOURCE-ID', '22222222-2222-4222-8222-222222222201'));
    assert.deepEqual(deriveProvenance({ role: 'user', href: 'copia.ics', component: duplicated }), { source: 'admin', source_id: '22222222-2222-4222-8222-222222222201' });
    const onlyId = createComponent('VEVENT', [createProperty('UID', 'y'), createProperty('X-CALDES-SOURCE-ID', 'esterno-1')]);
    assert.deepEqual(deriveProvenance({ role: 'user', href: 'y.ics', component: onlyId }), { source: 'manual', source_id: 'esterno-1' });
    // Mai sulle proiezioni e sulle festività di sistema.
    const fake = declared('admin');
    fake.properties.push(createProperty('X-CALDES-SOURCE-ID', 'altro'));
    assert.deepEqual(deriveProvenance({ role: 'bookings', href: 'booking-bk1.ics', component: fake }), { source: 'booking', source_id: 'bk1' });
    assert.deepEqual(deriveProvenance({ role: 'holidays', href: 'it-holiday-2026-12-25.ics', component: fake }), { source: 'system', source_id: 'it-holiday-2026-12-25' });
    assert.ok(isClientSource('agent'));
    assert.ok(!isClientSource('booking'));
    const c = declared('admin');
    setProvenance(c, { source: null, legacyId: 'id-1' });
    assert.equal(getProperties(c, 'X-CALDES-SOURCE').length, 0);
    assert.equal(getProperty(c, 'X-CALDES-LEGACY-ID')?.value, 'id-1');
  });

  test('classifyOccurrenceKind', () => {
    assert.equal(classifyOccurrenceKind('bookings', 'booking-bk1.ics', 'event'), 'booking_projection');
    assert.equal(classifyOccurrenceKind('bookings', 'booking-bk1.ics', 'conservative'), 'booking_projection');
    assert.equal(classifyOccurrenceKind('bookings', 'altro.ics', 'event'), 'event');
    assert.equal(classifyOccurrenceKind('holidays', 'it-holiday-2026-12-25.ics', 'event'), 'holiday_system');
    assert.equal(classifyOccurrenceKind('holidays', 'closure-1.ics', 'event'), 'closure');
    assert.equal(classifyOccurrenceKind('holidays', 'closure-1.ics', 'conservative'), 'conservative');
    assert.equal(classifyOccurrenceKind('user', 'x.ics', 'orphan_override'), 'orphan_override');
  });

  test('computeBlocks (design §9, decisione 6 non ancora attiva)', () => {
    const base = { componentType: 'VEVENT', status: null, transp: null, allDay: false, kind: 'event' as const };
    assert.equal(computeBlocks(base), true);
    assert.equal(computeBlocks({ ...base, status: 'CONFIRMED' }), true);
    assert.equal(computeBlocks({ ...base, status: 'TENTATIVE' }), false);
    assert.equal(computeBlocks({ ...base, status: 'CANCELLED' }), false);
    assert.equal(computeBlocks({ ...base, transp: 'TRANSPARENT' }), false);
    assert.equal(computeBlocks({ ...base, kind: 'booking_projection' }), false);
    assert.equal(computeBlocks({ ...base, kind: 'orphan_override' }), true);
    assert.equal(computeBlocks({ ...base, componentType: 'VTODO' }), false);
    assert.equal(computeBlocks({ ...base, allDay: true }), false);
    assert.equal(computeBlocks({ ...base, allDay: true, transp: 'OPAQUE' }), false);
    assert.equal(computeBlocks({ ...base, allDay: true, transp: 'OPAQUE' }, { allDayOpaqueBlocks: true }), true);
    assert.equal(computeBlocks({ ...base, allDay: true }, { allDayOpaqueBlocks: true }), false);
  });
});
