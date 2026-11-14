/**
 * allday.ts: date di calendario, DTEND esclusivo e conversioni con le
 * convenzioni attuali dell'API (mezzanotte di Roma, mezzanotte UTC delle
 * iscrizioni, orari qualsiasi dell'editor admin).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  addDays,
  allDayRangeFromIcs,
  compareDates,
  dateFromParts,
  dateToLegacyIso,
  daysBetween,
  IcsValueError,
  isDateString,
  isLocalMidnight,
  legacyAllDayPointToDate,
  legacyAllDayToRange,
  legacyUntilToDate,
  localDateOf,
  localMidnightUtcMs,
  rangeToLegacyAllDay,
  stringToIcsDate,
  type IcsDate,
} from '../src/index';

const ROME = 'Europe/Rome';
const d = (s: string): IcsDate => stringToIcsDate(s);

describe('date di calendario', () => {
  test('validità, somma di giorni (anche a cavallo di anni bisestili) e differenze', () => {
    assert.ok(isDateString('2028-02-29'));
    assert.ok(!isDateString('2026-02-29'));
    assert.ok(!isDateString('2026-13-01'));
    assert.ok(!isDateString('20261009'));
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(daysBetween('2026-10-01', '2026-10-31'), 30);
    assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2, 'il cambio d\'ora non conta');
    assert.equal(compareDates('2026-10-09', '2026-10-10'), -1);
    assert.equal(dateFromParts(2026, 1, 32), '2026-02-01');
    assert.throws(() => addDays('9 ottobre', 1), (err: unknown) => err instanceof IcsValueError && err.code === 'INVALID_DATE_STRING');
  });

  test('mezzanotte locale, anche nei giorni del cambio d\'ora', () => {
    assert.equal(dateToLegacyIso('2026-12-25', ROME), '2026-12-24T23:00:00.000Z');
    assert.equal(dateToLegacyIso('2026-07-01', ROME), '2026-06-30T22:00:00.000Z');
    assert.equal(dateToLegacyIso('2026-10-25', ROME), '2026-10-24T22:00:00.000Z');
    assert.equal(dateToLegacyIso('2026-10-26', ROME), '2026-10-25T23:00:00.000Z');
    assert.ok(isLocalMidnight(localMidnightUtcMs('2026-03-29', ROME), ROME));
    assert.equal(localDateOf(Date.parse('2026-10-24T22:30:00Z'), ROME), '2026-10-25');
  });
});

describe('DTO legacy → date', () => {
  test('mezzanotte di Roma (forma attesa): date identiche, nessuna correzione', () => {
    assert.deepEqual(legacyAllDayToRange('2026-12-23T23:00:00.000Z', '2026-12-25T23:00:00.000Z', ROME), {
      start: '2026-12-24',
      end: '2026-12-26',
      convention: 'local-midnight',
      adjusted: false,
    });
    // Giorno di 25 ore (fine dell'ora legale).
    assert.deepEqual(legacyAllDayToRange('2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', ROME), {
      start: '2026-10-25',
      end: '2026-10-26',
      convention: 'local-midnight',
      adjusted: false,
    });
  });

  test('mezzanotte UTC delle iscrizioni legacy: stessa data', () => {
    assert.deepEqual(legacyAllDayToRange('2026-12-25T00:00:00.000Z', '2026-12-26T00:00:00.000Z', ROME), {
      start: '2026-12-25',
      end: '2026-12-26',
      convention: 'utc-midnight',
      adjusted: false,
    });
  });

  test('una mezzanotte locale e una UTC', () => {
    const r = legacyAllDayToRange('2026-12-24T23:00:00.000Z', '2026-12-26T00:00:00.000Z', ROME);
    assert.deepEqual([r.start, r.end, r.convention], ['2026-12-25', '2026-12-26', 'mixed']);
  });

  test('orari qualsiasi dell\'editor admin: giorno dell\'inizio, la fine copre il proprio giorno', () => {
    // 09:00–18:00 di Roma con "Tutto il giorno".
    assert.deepEqual(legacyAllDayToRange('2026-10-09T07:00:00Z', '2026-10-09T16:00:00Z', ROME), {
      start: '2026-10-09',
      end: '2026-10-10',
      convention: 'non-midnight',
      adjusted: true,
    });
    // 15:00 di Roma: la regola "+12 h" darebbe il giorno dopo, qui resta il 9.
    assert.equal(legacyAllDayToRange('2026-10-09T13:00:00Z', '2026-10-09T14:00:00Z', ROME).start, '2026-10-09');
    // Più giorni con orari.
    const multi = legacyAllDayToRange('2026-10-09T07:00:00Z', '2026-10-11T10:00:00Z', ROME);
    assert.deepEqual([multi.start, multi.end], ['2026-10-09', '2026-10-12']);
  });

  test('intervallo vuoto → un giorno', () => {
    const r = legacyAllDayToRange('2026-12-24T23:00:00.000Z', '2026-12-24T23:00:00.000Z', ROME);
    assert.deepEqual([r.start, r.end, r.adjusted], ['2026-12-25', '2026-12-26', true]);
  });

  test('istanti puntuali (EXDATE, RECURRENCE-ID)', () => {
    assert.equal(legacyAllDayPointToDate('2026-12-24T23:00:00.000Z', ROME), '2026-12-25');
    assert.equal(legacyAllDayPointToDate('2026-12-25T00:00:00.000Z', ROME), '2026-12-25');
    assert.equal(legacyAllDayPointToDate(new Date('2026-12-25T10:00:00Z'), ROME), '2026-12-25');
    assert.throws(() => legacyAllDayPointToDate('non una data', ROME), (err: unknown) => err instanceof IcsValueError && err.code === 'INVALID_ISO');
  });

  test('date → DTO legacy: mezzanotte di Roma in ISO UTC (differenza ammessa n. 2 per le iscrizioni)', () => {
    assert.deepEqual(rangeToLegacyAllDay({ start: '2026-12-25', end: '2026-12-26' }, ROME), {
      start_time: '2026-12-24T23:00:00.000Z',
      end_time: '2026-12-25T23:00:00.000Z',
    });
  });

  test('UNTIL di una serie all-day legacy', () => {
    // UNTIL a mezzanotte UTC (buildRRule dell'admin): il 31 è compreso.
    assert.equal(legacyUntilToDate(Date.parse('2026-12-31T00:00:00Z'), 0, ROME), '2026-12-31');
    // UNTIL alla mezzanotte di Roma del 31: compreso.
    assert.equal(legacyUntilToDate(Date.parse('2026-12-30T23:00:00Z'), 0, ROME), '2026-12-31');
    // UNTIL alle 23:00 di Roma del 30: il 31 è escluso.
    assert.equal(legacyUntilToDate(Date.parse('2026-12-30T22:00:00Z'), 0, ROME), '2026-12-30');
    // Serie all-day con inizio alle 09:00 (caso ambiguo): UNTIL alle 08:00 locali esclude quel giorno.
    assert.equal(legacyUntilToDate(Date.parse('2026-12-31T07:00:00Z'), 9 * 3600, ROME), '2026-12-30');
  });
});

describe('VEVENT all-day → intervallo', () => {
  const ctx = { tz: ROME };

  test('DTEND DATE esclusivo', () => {
    assert.deepEqual(allDayRangeFromIcs(d('2026-12-24'), d('2026-12-27'), null, ctx), { start: '2026-12-24', end: '2026-12-27', adjusted: false });
  });

  test('senza DTEND né DURATION: un giorno (RFC 5545 §3.6.1)', () => {
    assert.deepEqual(allDayRangeFromIcs(d('2026-12-24'), null, null, ctx), { start: '2026-12-24', end: '2026-12-25', adjusted: false });
  });

  test('DURATION in giorni e settimane, parte oraria arrotondata', () => {
    const dur = (days: number, weeks = 0, hours = 0) => ({ negative: false, weeks, days, hours, minutes: 0, seconds: 0 });
    assert.equal(allDayRangeFromIcs(d('2026-12-24'), null, dur(2), ctx).end, '2026-12-26');
    assert.equal(allDayRangeFromIcs(d('2026-12-24'), null, dur(0, 1), ctx).end, '2026-12-31');
    const withHours = allDayRangeFromIcs(d('2026-12-24'), null, dur(1, 0, 6), ctx);
    assert.deepEqual([withHours.end, withHours.adjusted], ['2026-12-26', true]);
  });

  test('DTEND DATE-TIME accanto a un DTSTART DATE (tipi misti)', () => {
    const atMidnight = allDayRangeFromIcs(
      d('2026-12-24'),
      { type: 'date-time', year: 2026, month: 12, day: 26, hour: 0, minute: 0, second: 0, zone: { kind: 'tzid', tzid: ROME } },
      null,
      ctx,
    );
    assert.deepEqual([atMidnight.end, atMidnight.adjusted], ['2026-12-26', true]);
    const afternoon = allDayRangeFromIcs(
      d('2026-12-24'),
      { type: 'date-time', year: 2026, month: 12, day: 25, hour: 15, minute: 0, second: 0, zone: { kind: 'utc' } },
      null,
      ctx,
    );
    assert.equal(afternoon.end, '2026-12-26');
  });

  test('fine non successiva all\'inizio → un giorno', () => {
    const r = allDayRangeFromIcs(d('2026-12-24'), d('2026-12-24'), null, ctx);
    assert.deepEqual([r.end, r.adjusted], ['2026-12-25', true]);
  });
});
