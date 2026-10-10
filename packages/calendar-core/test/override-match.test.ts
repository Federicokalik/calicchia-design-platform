/**
 * Abbinamento degli override (src/override-match.ts, design §6.4): chiave
 * sull'istante UTC per i DATE-TIME con zona, sulla data locale nel fuso del
 * calendario quando c'è di mezzo un DATE, floating nel fuso del calendario;
 * duplicati per SEQUENCE; orfani indipendenti dalla finestra (badge
 * dell'admin, anomalia della migrazione, 409 di recurrence-ops).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildOverrideIndex,
  expandObject,
  findOrphanOverrides,
  parseCalendarObjectOrThrow,
  type IcsTime,
  type IcsZone,
  isSameOccurrence,
  matchKey,
} from '../src/index';
import { objectOf, ROME, vevent } from './ical-builders';

const dt = (y: number, mo: number, d: number, h: number, mi: number, zone: IcsZone): IcsTime => ({
  type: 'date-time', year: y, month: mo, day: d, hour: h, minute: mi, second: 0, zone,
});
const date = (y: number, mo: number, d: number): IcsTime => ({ type: 'date', year: y, month: mo, day: d });
const romeZ = { kind: 'tzid' as const, tzid: 'Europe/Rome' };
const utcZ = { kind: 'utc' as const };
const floatZ = { kind: 'floating' as const };
const ctx = { tz: ROME };

describe('matchKey e isSameOccurrence', () => {
  test('master DATE: sempre la data locale nel fuso del calendario', () => {
    assert.equal(matchKey(date(2026, 10, 12), 'date', ctx), '20261012');
    assert.equal(matchKey(dt(2026, 10, 12, 0, 0, romeZ), 'date', ctx), '20261012');
    // 23:30Z dell'11 è già il 12 a Roma.
    assert.equal(matchKey(dt(2026, 10, 11, 23, 30, utcZ), 'date', ctx), '20261012');
    assert.equal(matchKey(dt(2026, 10, 11, 21, 30, utcZ), 'date', ctx), '20261011');
    // Floating: la sua data da muro.
    assert.equal(matchKey(dt(2026, 10, 12, 23, 59, floatZ), 'date', ctx), '20261012');
  });

  test('master DATE-TIME: istante al secondo; un DATE resta la data', () => {
    assert.equal(matchKey(dt(2026, 10, 12, 9, 0, romeZ), 'date-time', ctx), '20261012T070000Z');
    assert.equal(matchKey(dt(2026, 10, 26, 9, 0, romeZ), 'date-time', ctx), '20261026T080000Z');
    assert.equal(matchKey(dt(2026, 10, 12, 8, 0, { kind: 'tzid', tzid: 'Europe/London' }), 'date-time', ctx), '20261012T070000Z');
    assert.equal(matchKey(date(2026, 10, 12), 'date-time', ctx), '20261012');
    // Floating nel fuso del calendario.
    assert.equal(matchKey(dt(2026, 10, 12, 9, 0, floatZ), 'date-time', ctx), '20261012T070000Z');
    assert.equal(matchKey(dt(2026, 10, 12, 9, 0, floatZ), 'date-time', { tz: 'America/New_York' }), '20261012T130000Z');
    // Fuso del calendario sconosciuto: Europe/Rome, nessuna eccezione.
    assert.equal(matchKey(dt(2026, 10, 12, 9, 0, floatZ), 'date-time', { tz: 'Non/Esiste' }), '20261012T070000Z');
  });

  test('isSameOccurrence: tollerante al tipo e alla zona', () => {
    assert.equal(isSameOccurrence(dt(2026, 10, 12, 9, 0, romeZ), dt(2026, 10, 12, 7, 0, utcZ), 'date-time', ctx), true);
    assert.equal(isSameOccurrence(dt(2026, 10, 12, 9, 0, romeZ), dt(2026, 10, 12, 9, 30, romeZ), 'date-time', ctx), false);
    assert.equal(isSameOccurrence(date(2026, 10, 12), dt(2026, 10, 12, 15, 0, romeZ), 'date-time', ctx), true);
    assert.equal(isSameOccurrence(dt(2026, 10, 12, 0, 0, romeZ), date(2026, 10, 12), 'date', ctx), true);
    assert.equal(isSameOccurrence(dt(2026, 10, 11, 22, 0, utcZ), date(2026, 10, 12), 'date', ctx), true);
    assert.equal(isSameOccurrence(date(2026, 10, 12), date(2026, 10, 13), 'date', ctx), false);
  });
});

describe('buildOverrideIndex', () => {
  const master = vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000', 'RRULE:FREQ=HOURLY;COUNT=72']);

  test('lookup sull\'istante, vincitore fra i duplicati, ombre e RECURRENCE-ID illeggibili', () => {
    const o = objectOf(
      master,
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261005T110000', 'DTSTART;TZID=Europe/Rome:20261005T113000', 'SEQUENCE:2']),
      vevent(['RECURRENCE-ID:20261005T090000Z', 'DTSTART;TZID=Europe/Rome:20261005T114500', 'SEQUENCE:1']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261005T1', 'DTSTART;TZID=Europe/Rome:20261005T120000']),
    );
    const idx = buildOverrideIndex(o, ctx);
    assert.equal(idx.lookup(dt(2026, 10, 5, 11, 0, romeZ)), 0);
    assert.equal(idx.lookup(dt(2026, 10, 5, 10, 0, romeZ)), undefined);
    assert.deepEqual(idx.shadowed, [1]);
    assert.deepEqual(idx.invalid, [2]);
    assert.equal(idx.keys.get(0), '20261005T090000Z');
    assert.equal(idx.keys.get(1), '20261005T090000Z');
  });

  test('RECURRENCE-ID DATE su master DATE-TIME: restituito per ogni occorrenza di quel giorno', () => {
    const o = objectOf(master, vevent(['RECURRENCE-ID;VALUE=DATE:20261006', 'DTSTART;TZID=Europe/Rome:20261006T150000']));
    const idx = buildOverrideIndex(o, ctx);
    assert.equal(idx.lookup(dt(2026, 10, 6, 0, 0, romeZ)), 0);
    assert.equal(idx.lookup(dt(2026, 10, 6, 23, 0, romeZ)), 0);
    assert.equal(idx.lookup(dt(2026, 10, 7, 0, 0, romeZ)), undefined);
    assert.equal(idx.keys.get(0), '20261006');
  });

  test('master DATE: lookup per data anche con RECURRENCE-ID DATE-TIME', () => {
    const o = objectOf(
      vevent(['DTSTART;VALUE=DATE:20261005', 'RRULE:FREQ=DAILY;COUNT=5']),
      vevent(['RECURRENCE-ID:20261006T220000Z', 'DTSTART;VALUE=DATE:20261009']),
    );
    const idx = buildOverrideIndex(o, ctx);
    assert.equal(idx.lookup(date(2026, 10, 7)), 0);
    assert.equal(idx.lookup(date(2026, 10, 6)), undefined);
  });

  test('nessun override: indice vuoto', () => {
    const idx = buildOverrideIndex(objectOf(master), ctx);
    assert.equal(idx.lookup(dt(2026, 10, 5, 9, 0, romeZ)), undefined);
    assert.deepEqual([idx.shadowed, idx.invalid, idx.keys.size], [[], [], 0]);
  });
});

describe('findOrphanOverrides', () => {
  const lmgv = vevent(['DTSTART;TZID=Europe/Rome:20250106T090000', 'DTEND;TZID=Europe/Rome:20250106T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'EXDATE;TZID=Europe/Rome:20261020T090000']);

  test('orfani fuori regola; override su istanza esclusa da EXDATE non è orfano; tipi misti abbinati', () => {
    const o = objectOf(
      lmgv,
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261019T090000', 'DTSTART;TZID=Europe/Rome:20261019T110000']), // valido
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261021T090000', 'DTSTART;TZID=Europe/Rome:20261021T110000']), // mercoledì: orfano
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261020T090000', 'DTSTART;TZID=Europe/Rome:20261020T150000']), // escluso ma prevale
      vevent(['RECURRENCE-ID;VALUE=DATE:20261022', 'DTSTART;TZID=Europe/Rome:20261022T150000']), // DATE: istanza del giorno
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261023T093000', 'DTSTART;TZID=Europe/Rome:20261023T150000']), // orario sbagliato: orfano
      vevent(['RECURRENCE-ID:garbage', 'DTSTART;TZID=Europe/Rome:20261023T170000']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261019T090000', 'DTSTART;TZID=Europe/Rome:20261019T120000', 'SEQUENCE:5']), // duplicato vincente
    );
    const r = findOrphanOverrides(o, ctx);
    assert.deepEqual(r.orphans, [1, 4]);
    assert.deepEqual(r.invalid, [5]);
    assert.deepEqual(r.shadowed, [0]);
    assert.deepEqual(r.undetermined, []);
  });

  test('istanze anni dopo il DTSTART (fast-forward) e prima del DTSTART (orfano)', () => {
    const o = objectOf(
      lmgv,
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20300104T090000', 'DTSTART;TZID=Europe/Rome:20300104T100000']), // venerdì 2030: valido
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20241231T090000', 'DTSTART;TZID=Europe/Rome:20241231T100000']), // prima del DTSTART
    );
    assert.deepEqual(findOrphanOverrides(o, ctx).orphans, [1]);
  });

  test('COUNT: un override oltre l\'ultima istanza è orfano', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'RRULE:FREQ=DAILY;COUNT=3']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261007T090000', 'DTSTART;TZID=Europe/Rome:20261007T100000']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261008T090000', 'DTSTART;TZID=Europe/Rome:20261008T100000']),
    );
    assert.deepEqual(findOrphanOverrides(o, ctx).orphans, [1]);
  });

  test('budget insufficiente o master non interpretabile: undetermined, mai orfani per errore', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20100101T090000', 'RRULE:FREQ=HOURLY;COUNT=1000000']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261007T090000', 'DTSTART;TZID=Europe/Rome:20261007T100000']),
    );
    const r = findOrphanOverrides(o, { ...ctx, iterationBudget: 1000 });
    assert.deepEqual(r.orphans, []);
    assert.deepEqual(r.undetermined, [0]);
    const broken = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'RRULE:FREQ=DAILY;BYDAY=ZZ']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261007T090000', 'DTSTART;TZID=Europe/Rome:20261007T100000']),
    );
    assert.deepEqual(findOrphanOverrides(broken, ctx).undetermined, [0]);
  });

  test('senza master tutti gli override sono orfani', () => {
    const o = objectOf(
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261007T090000', 'DTSTART;TZID=Europe/Rome:20261007T100000']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261008T090000', 'DTSTART;TZID=Europe/Rome:20261008T100000']),
    );
    assert.deepEqual(findOrphanOverrides(o, ctx).orphans, [0, 1]);
  });

  test('due override (istante e data) sulla stessa istanza: vince SEQUENCE più alta, l\'altro è un\'ombra', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'RRULE:FREQ=DAILY;COUNT=3']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261006T090000', 'DTSTART;TZID=Europe/Rome:20261006T100000', 'SEQUENCE:1']),
      vevent(['RECURRENCE-ID;VALUE=DATE:20261006', 'DTSTART;TZID=Europe/Rome:20261006T110000', 'SEQUENCE:2']),
    );
    const r = findOrphanOverrides(o, ctx);
    assert.deepEqual(r.orphans, []);
    assert.deepEqual(r.shadowed, [0]);
  });
});

describe('findOrphanOverrides ed expandObject: costo lineare negli override orfani', () => {
  test('8000 e 32000 orfani in tempi lineari (prima O(n²): decine di secondi con 32000)', () => {
    const build = (n: number): string => {
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:o@x', 'DTSTAMP:20260101T000000Z', 'DTSTART:20200101T090000Z', 'DTEND:20200101T100000Z', 'RRULE:FREQ=DAILY', 'END:VEVENT'];
      for (let i = 0; i < n; i++) {
        const d = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
        lines.push('BEGIN:VEVENT', 'UID:o@x', 'DTSTAMP:20260101T000000Z', `RECURRENCE-ID:${d}T093000Z`, `DTSTART:${d}T110000Z`, `DTEND:${d}T120000Z`, 'END:VEVENT');
      }
      lines.push('END:VCALENDAR', '');
      return lines.join('\r\n');
    };
    for (const n of [8000, 32_000]) {
      const obj = parseCalendarObjectOrThrow(build(n), { objectLimits: false });
      const t = Date.now();
      const res = findOrphanOverrides(obj, { tz: ROME });
      const exp = expandObject(obj, { from: Date.UTC(2025, 0, 1), to: Date.UTC(2027, 0, 1), tz: ROME });
      const ms = Date.now() - t;
      assert.equal(res.orphans.length, n);
      assert.equal(exp.health, 'ok');
      assert.ok(ms < (n === 8000 ? 3000 : 8000), `${n} orfani: ${ms} ms`);
    }
  });
});
