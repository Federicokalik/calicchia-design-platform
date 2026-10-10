/**
 * Espansione delle occorrenze (src/expand.ts, design §6.4, §6.5, §9; piano
 * F2, sezione Test, voce Espansione): ora locale del TZID anche al cambio
 * d'ora, all-day con EXDATE e override, UNTIL inclusivo, RDATE, fusi diversi
 * da Europe/Rome e floating, abbinamento degli override tollerante al tipo,
 * orfani autonomi, tetto contato nella finestra con budget di iterazioni,
 * COUNT dal DTSTART, quarantena con occorrenza conservativa e busy
 * conservativo dal testo.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CalendarCoreError,
  classifyOccurrenceKind,
  computeBlocks,
  conservativeRangeFromText,
  CONSERVATIVE_RECURRENCE_KEY,
  EXPANSION_ITERATION_BUDGET,
  type ExpandedOccurrence,
  expandObject,
  type ExpansionResult,
  MASTER_RECURRENCE_KEY,
  MAX_OCCURRENCES_PER_OBJECT,
  getProperty,
} from '../src/index';
import { fixture } from './helpers';
import { DAY_MS, HOUR_MS, iso, localOf, objectFromText, objectOf, ROME, vcalendar, vevent, wallMs } from './ical-builders';

const D = (date: string, time = '00:00', tz = ROME): number => wallMs(date, time, tz);

function expand(obj: ReturnType<typeof objectOf>, from: number, to: number, extra: Partial<Parameters<typeof expandObject>[1]> = {}): ExpansionResult {
  return expandObject(obj, { from, to, tz: ROME, ...extra });
}

const starts = (r: ExpansionResult): string[] => r.occurrences.map((o) => iso(o.startUtc));
const locals = (r: ExpansionResult, tz = ROME): string[] => r.occurrences.map((o) => localOf(o.startUtc, tz));
const codes = (r: ExpansionResult): string[] => r.warnings.map((w) => w.code);

/** Invarianti di ogni esito: chiavi uniche, ordine, fine ≥ inizio, all-day con date coerenti. */
function assertInvariants(r: ExpansionResult): void {
  const keys = new Set<string>();
  let prev: ExpandedOccurrence | null = null;
  for (const o of r.occurrences) {
    assert.ok(!keys.has(o.recurrenceKey), `chiave duplicata ${o.recurrenceKey}`);
    keys.add(o.recurrenceKey);
    assert.ok(o.endUtc >= o.startUtc, `fine prima dell'inizio: ${o.recurrenceKey}`);
    if (prev) assert.ok(prev.startUtc < o.startUtc || (prev.startUtc === o.startUtc && prev.recurrenceKey < o.recurrenceKey), 'ordine');
    if (o.allDay) {
      assert.ok(o.startDate && o.endDate && o.endDate > o.startDate, `date all-day incoerenti: ${o.startDate} ${o.endDate}`);
    } else {
      assert.equal(o.startDate, null);
      assert.equal(o.endDate, null);
    }
    prev = o;
  }
}

// ─── Serie di produzione e cambio d'ora ───────────────────────────────

describe('ora locale del TZID e cambio d\'ora', () => {
  // Serie infinita lun-mar-gio-ven alle 09:00 di Roma (calendario "c" in produzione).
  const lmgv = objectOf(vevent([
    'DTSTART;TZID=Europe/Rome:20250106T090000',
    'DTEND;TZID=Europe/Rome:20250106T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR',
    'SUMMARY:Studio',
  ]));

  test('serie infinita lun-mar-gio-ven 09:00: resta alle 09:00 locali dopo il 25/10/2026', () => {
    const r = expand(lmgv, Date.UTC(2026, 9, 19), Date.UTC(2026, 10, 2));
    assertInvariants(r);
    assert.deepEqual(starts(r), [
      '2026-10-19T07:00:00.000Z', '2026-10-20T07:00:00.000Z', '2026-10-22T07:00:00.000Z', '2026-10-23T07:00:00.000Z',
      '2026-10-26T08:00:00.000Z', '2026-10-27T08:00:00.000Z', '2026-10-29T08:00:00.000Z', '2026-10-30T08:00:00.000Z',
    ]);
    assert.ok(locals(r).every((l) => l.endsWith('09:00')));
    assert.ok(r.occurrences.every((o) => o.endUtc - o.startUtc === HOUR_MS && o.kind === 'event' && o.source.type === 'master'));
    assert.equal(r.occurrences[4].recurrenceKey, '20261026T080000Z');
    assert.equal(r.health, 'ok');
    assert.equal(r.isRecurring, true);
    assert.equal(r.rangeStart, D('2025-01-06', '09:00'));
    assert.equal(r.rangeEnd, null, 'serie illimitata');
    assert.equal(r.materializedUntil, null);
    assert.ok(r.iterations < 100, `fast-forward: ${r.iterations} iterazioni`);
  });

  test('anche al passaggio all\'ora legale (28/03/2027) e su tutto l\'orizzonte dell\'indice', () => {
    const r = expand(lmgv, Date.UTC(2027, 2, 22), Date.UTC(2027, 3, 3));
    assert.deepEqual(locals(r), ['2027-03-22 09:00', '2027-03-23 09:00', '2027-03-25 09:00', '2027-03-26 09:00', '2027-03-29 09:00', '2027-03-30 09:00', '2027-04-01 09:00', '2027-04-02 09:00']);
    assert.equal(iso(r.occurrences[3].startUtc), '2027-03-26T08:00:00.000Z');
    assert.equal(iso(r.occurrences[4].startUtc), '2027-03-29T07:00:00.000Z');
    // Orizzonte [oggi − 400 g, oggi + 800 g]: circa 4 occorrenze a settimana, tutte alle 09:00.
    const today = Date.UTC(2026, 9, 9);
    const h = expand(lmgv, today - 400 * DAY_MS, today + 800 * DAY_MS);
    assertInvariants(h);
    assert.ok(h.occurrences.length > 650 && h.occurrences.length < 700, `${h.occurrences.length}`);
    assert.ok(locals(h).every((l) => l.endsWith('09:00')));
    assert.equal(h.materializedUntil, null);
  });

  test('orari inesistenti e ambigui secondo RFC 5545', () => {
    const night = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261024T023000', 'DTEND;TZID=Europe/Rome:20261024T033000', 'RRULE:FREQ=DAILY']));
    // 25/10/2026: le 02:30 capitano due volte → la prima (ancora CEST).
    const fall = expand(night, Date.UTC(2026, 9, 24), Date.UTC(2026, 9, 27));
    assert.deepEqual(starts(fall), ['2026-10-24T00:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
    // 28/03/2027: le 02:30 non esistono → offset precedente al buco (01:30Z, cioè le 03:30 CEST).
    const spring = expand(night, Date.UTC(2027, 2, 27), Date.UTC(2027, 2, 30));
    assert.deepEqual(starts(spring), ['2027-03-27T01:30:00.000Z', '2027-03-28T01:30:00.000Z', '2027-03-29T00:30:00.000Z']);
    assert.equal(localOf(spring.occurrences[1].startUtc), '2027-03-28 03:30');
  });

  test('serie oraria nel buco del passaggio all\'ora legale: nessun istante doppio (RFC 5545: insieme di istanti)', () => {
    const hourly = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20260328T230000', 'DURATION:PT30M', 'RRULE:FREQ=HOURLY;COUNT=8']));
    const r = expand(hourly, Date.UTC(2026, 2, 28), Date.UTC(2026, 2, 30));
    assertInvariants(r);
    // 02:00 non esiste: vale come le 03:00 (01:00Z), che quindi non si ripete.
    assert.deepEqual(starts(r), [
      '2026-03-28T22:00:00.000Z', '2026-03-28T23:00:00.000Z', '2026-03-29T00:00:00.000Z', '2026-03-29T01:00:00.000Z',
      '2026-03-29T02:00:00.000Z', '2026-03-29T03:00:00.000Z', '2026-03-29T04:00:00.000Z',
    ]);
    const minutely = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20260329T014500', 'DURATION:PT1M', 'RRULE:FREQ=MINUTELY;INTERVAL=15;COUNT=12']));
    const m = expand(minutely, Date.UTC(2026, 2, 28), Date.UTC(2026, 2, 30));
    assertInvariants(m);
    assert.deepEqual(locals(m), ['2026-03-29 01:45', '2026-03-29 03:00', '2026-03-29 03:15', '2026-03-29 03:30', '2026-03-29 03:45', '2026-03-29 04:00', '2026-03-29 04:15', '2026-03-29 04:30']);
  });

  test('fuso diverso da Europe/Rome: la serie segue l\'ora di New York (fine dell\'ora legale USA il 01/11/2026)', () => {
    const ny = objectOf(vevent(['DTSTART;TZID=America/New_York:20261026T090000', 'DTEND;TZID=America/New_York:20261026T093000', 'RRULE:FREQ=WEEKLY;COUNT=3']));
    const r = expand(ny, Date.UTC(2026, 9, 1), Date.UTC(2026, 11, 1));
    assert.deepEqual(starts(r), ['2026-10-26T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-09T14:00:00.000Z']);
    assert.deepEqual(locals(r, 'America/New_York'), ['2026-10-26 09:00', '2026-11-02 09:00', '2026-11-09 09:00']);
    assert.equal(r.occurrences[1].recurrenceKey, '20261102T140000Z');
    assert.equal(r.rangeEnd, Date.parse('2026-11-09T14:30:00Z'));
  });

  test('TZID non IANA: VTIMEZONE personalizzato, nome Windows di Outlook, prefisso Mozilla', () => {
    const custom = fixture('custom-tz.ics').replace(
      'DTSTART;TZID=Ora di Roma (personalizzata):20260701T090000\r\nDTEND;TZID=Fuso fisso +0530:20260701T143000',
      'DTSTART;TZID=Ora di Roma (personalizzata):20261022T090000\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=4',
    );
    assert.ok(custom.includes('RRULE:FREQ=DAILY;COUNT=4'), 'fixture cambiata');
    const c = expand(objectFromText(custom), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.deepEqual(starts(c), ['2026-10-22T07:00:00.000Z', '2026-10-23T07:00:00.000Z', '2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z']);
    assert.ok(c.occurrences.every((o) => o.endUtc - o.startUtc === HOUR_MS));

    const outlook = expand(objectFromText(fixture('outlook-windows-tz.ics')), Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1));
    assert.equal(iso(outlook.occurrences[0].startUtc), '2026-11-10T09:00:00.000Z');
    assert.equal(outlook.occurrences[0].endUtc - outlook.occurrences[0].startUtc, 90 * 60_000);

    const tb = expand(objectFromText(fixture('thunderbird-mozilla-tz.ics')), Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1));
    assert.equal(iso(tb.occurrences[0].startUtc), '2026-11-03T13:30:00.000Z');
    assert.deepEqual(codes(tb).filter((x) => x === 'UNKNOWN_TZID'), []);
  });

  test('TZID sconosciuto senza VTIMEZONE: fuso del calendario con avviso; fuso del calendario non valido: Europe/Rome', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Pianeta/Marte:20261020T090000', 'DTEND;TZID=Pianeta/Marte:20261020T100000']));
    const r = expand(o, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.equal(iso(r.occurrences[0].startUtc), '2026-10-20T07:00:00.000Z');
    assert.ok(codes(r).includes('UNKNOWN_TZID'));
    assert.equal(r.health, 'ok');
    const floating = objectOf(vevent(['DTSTART:20261020T090000', 'DTEND:20261020T100000']));
    const z = expandObject(floating, { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1), tz: 'Non/Esiste' });
    assert.equal(iso(z.occurrences[0].startUtc), '2026-10-20T07:00:00.000Z');
    assert.ok(codes(z).includes('UNKNOWN_TZID'));
  });

  test('floating: ora da muro nel fuso del calendario, chiave senza Z', () => {
    const f = objectOf(vevent(['DTSTART:20261024T090000', 'DTEND:20261024T100000', 'RRULE:FREQ=DAILY;COUNT=3']));
    const rome = expand(f, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.deepEqual(starts(rome), ['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z']);
    assert.deepEqual(rome.occurrences.map((o) => o.recurrenceKey), ['20261024T090000', '20261025T090000', '20261026T090000']);
    const ny = expandObject(f, { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1), tz: 'America/New_York' });
    assert.deepEqual(starts(ny), ['2026-10-24T13:00:00.000Z', '2026-10-25T13:00:00.000Z', '2026-10-26T13:00:00.000Z']);
    assert.deepEqual(ny.occurrences.map((o) => o.recurrenceKey), ['20261024T090000', '20261025T090000', '20261026T090000']);
  });
});

// ─── All-day, UNTIL, RDATE ───────────────────────────────

describe('all-day, UNTIL inclusivo, RDATE', () => {
  test('all-day con EXDATE e override spostato e allungato', () => {
    const o = objectOf(
      vevent(['DTSTART;VALUE=DATE:20261001', 'DTEND;VALUE=DATE:20261002', 'RRULE:FREQ=WEEKLY;COUNT=6', 'EXDATE;VALUE=DATE:20261015', 'SUMMARY:Turno']),
      vevent(['RECURRENCE-ID;VALUE=DATE:20261022', 'DTSTART;VALUE=DATE:20261023', 'DTEND;VALUE=DATE:20261025', 'SUMMARY:Turno spostato', 'SEQUENCE:1']),
    );
    const r = expand(o, Date.UTC(2026, 8, 1), Date.UTC(2026, 11, 1));
    assertInvariants(r);
    assert.deepEqual(r.occurrences.map((x) => [x.recurrenceKey, x.kind, x.startDate, x.endDate]), [
      ['20261001', 'event', '2026-10-01', '2026-10-02'],
      ['20261008', 'event', '2026-10-08', '2026-10-09'],
      ['20261022', 'override', '2026-10-23', '2026-10-25'],
      ['20261029', 'event', '2026-10-29', '2026-10-30'],
      ['20261105', 'event', '2026-11-05', '2026-11-06'],
    ]);
    assert.ok(r.occurrences.every((x) => x.allDay));
    // Mezzanotte di Roma: prima e dopo il cambio d'ora.
    assert.equal(iso(r.occurrences[0].startUtc), '2026-09-30T22:00:00.000Z');
    assert.equal(iso(r.occurrences[3].startUtc), '2026-10-28T23:00:00.000Z');
    assert.equal(r.occurrences[2].originalStartUtc, D('2026-10-22'));
    assert.deepEqual(r.occurrences[2].source, { type: 'override', index: 0 });
    assert.equal(r.rangeStart, D('2026-10-01'));
    assert.equal(r.rangeEnd, D('2026-11-06'));
    // Gli all-day non bloccano finché la decisione 6 non è attiva (parità con oggi).
    assert.equal(computeBlocks({ componentType: 'VEVENT', status: null, transp: null, allDay: true, kind: 'event' }), false);
  });

  test('all-day di più giorni con DURATION e giorno di 25 ore', () => {
    const o = objectOf(vevent(['DTSTART;VALUE=DATE:20261024', 'DURATION:P2D', 'RRULE:FREQ=YEARLY;COUNT=2']));
    const r = expand(o, Date.UTC(2026, 0, 1), Date.UTC(2028, 0, 1));
    assert.deepEqual(r.occurrences.map((x) => [x.startDate, x.endDate]), [['2026-10-24', '2026-10-26'], ['2027-10-24', '2027-10-26']]);
    assert.equal(r.occurrences[0].endUtc - r.occurrences[0].startUtc, 49 * HOUR_MS, '24 + 25 ore');
  });

  test('UNTIL inclusivo: UTC, DATE su un master con orario (tutta la giornata), all-day', () => {
    const base = ['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000'];
    const utc = expand(objectOf(vevent([...base, 'RRULE:FREQ=DAILY;UNTIL=20261009T070000Z'])), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.deepEqual(locals(utc), ['2026-10-05 09:00', '2026-10-06 09:00', '2026-10-07 09:00', '2026-10-08 09:00', '2026-10-09 09:00']);
    assert.equal(utc.rangeEnd, D('2026-10-09', '10:00'));
    const justBefore = expand(objectOf(vevent([...base, 'RRULE:FREQ=DAILY;UNTIL=20261009T065959Z'])), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.equal(justBefore.occurrences.length, 4);
    const date = expand(objectOf(vevent([...base, 'RRULE:FREQ=DAILY;UNTIL=20261009'])), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.equal(date.occurrences.length, 5);
    assert.ok(codes(date).includes('UNTIL_TYPE_MISMATCH'));
    const allDay = expand(objectOf(vevent(['DTSTART;VALUE=DATE:20261005', 'RRULE:FREQ=DAILY;UNTIL=20261009'])), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.deepEqual(allDay.occurrences.map((x) => x.startDate), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    // All-day senza DTEND né DURATION: un giorno.
    assert.ok(allDay.occurrences.every((x) => x.endDate === new Date(Date.parse(`${x.startDate}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)));
  });

  test('RDATE: date-time, PERIOD con durata propria, insieme a RRULE ed EXDATE', () => {
    const only = objectOf(vevent([
      'DTSTART;TZID=Europe/Rome:20261005T090000',
      'DTEND;TZID=Europe/Rome:20261005T100000',
      'RDATE;TZID=Europe/Rome:20261007T150000,20261012T090000',
      'RDATE;VALUE=PERIOD:20261010T080000Z/PT3H',
    ]));
    const r = expand(only, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assertInvariants(r);
    assert.deepEqual(r.occurrences.map((o) => [iso(o.startUtc), (o.endUtc - o.startUtc) / HOUR_MS, o.recurrenceKey]), [
      ['2026-10-05T07:00:00.000Z', 1, '20261005T070000Z'],
      ['2026-10-07T13:00:00.000Z', 1, '20261007T130000Z'],
      ['2026-10-10T08:00:00.000Z', 3, '20261010T080000Z'],
      ['2026-10-12T07:00:00.000Z', 1, '20261012T070000Z'],
    ]);
    assert.equal(r.isRecurring, true);
    assert.equal(r.rangeEnd, Date.parse('2026-10-12T08:00:00Z'));

    const mixed = objectOf(vevent([
      'DTSTART;TZID=Europe/Rome:20261005T090000',
      'DTEND;TZID=Europe/Rome:20261005T100000',
      'RRULE:FREQ=DAILY;COUNT=3',
      'RDATE;TZID=Europe/Rome:20261020T090000',
      'EXDATE;TZID=Europe/Rome:20261006T090000',
    ]));
    assert.deepEqual(locals(expand(mixed, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1))), ['2026-10-05 09:00', '2026-10-07 09:00', '2026-10-20 09:00']);
  });

  test('EXDATE tolleranti al tipo: DATE su master con orario, DATE-TIME su master all-day, altro TZID', () => {
    const timed = objectOf(vevent([
      'DTSTART;TZID=Europe/Rome:20261005T090000',
      'DTEND;TZID=Europe/Rome:20261005T100000',
      'RRULE:FREQ=DAILY;COUNT=4',
      'EXDATE;VALUE=DATE:20261006',
      'EXDATE:20261007T070000Z',
    ]));
    const t = expand(timed, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.deepEqual(locals(t), ['2026-10-05 09:00', '2026-10-08 09:00']);
    assert.ok(codes(t).includes('EXDATE_TYPE_MISMATCH'));
    const allDay = objectOf(vevent(['DTSTART;VALUE=DATE:20261005', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;TZID=Europe/Rome:20261006T000000']));
    assert.deepEqual(expand(allDay, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)).occurrences.map((o) => o.startDate), ['2026-10-05', '2026-10-07']);
  });
});

// ─── Override ───────────────────────────────

describe('override: abbinamento proprio e tollerante al tipo', () => {
  test('override DATE-TIME su master DATE (TZID e UTC) abbinati sulla data locale', () => {
    for (const rid of ['RECURRENCE-ID;TZID=Europe/Rome:20261012T000000', 'RECURRENCE-ID:20261011T220000Z']) {
      const o = objectOf(
        vevent(['DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006', 'RRULE:FREQ=WEEKLY;COUNT=3']),
        vevent([rid, 'DTSTART;VALUE=DATE:20261013', 'DTEND;VALUE=DATE:20261014', 'SUMMARY:Spostato']),
      );
      const r = expand(o, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
      assertInvariants(r);
      assert.deepEqual(r.occurrences.map((x) => [x.recurrenceKey, x.kind, x.startDate]), [
        ['20261005', 'event', '2026-10-05'],
        ['20261012', 'override', '2026-10-13'],
        ['20261019', 'event', '2026-10-19'],
      ], rid);
      assert.ok(!codes(r).includes('ORPHAN_OVERRIDE'));
    }
  });

  test('override DATE su master DATE-TIME: sostituisce l\'istanza di quel giorno, chiave del master', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000', 'RRULE:FREQ=DAILY;COUNT=3']),
      vevent(['RECURRENCE-ID;VALUE=DATE:20261006', 'DTSTART;TZID=Europe/Rome:20261006T150000', 'DTEND;TZID=Europe/Rome:20261006T160000']),
    );
    const r = expand(o, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.deepEqual(r.occurrences.map((x) => [x.recurrenceKey, x.kind, localOf(x.startUtc)]), [
      ['20261005T070000Z', 'event', '2026-10-05 09:00'],
      ['20261006T070000Z', 'override', '2026-10-06 15:00'],
      ['20261007T070000Z', 'event', '2026-10-07 09:00'],
    ]);
    assert.equal(r.occurrences[1].originalStartUtc, D('2026-10-06', '09:00'));
  });

  test('override con un altro TZID ma lo stesso istante; override senza DTEND eredita la durata', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T103000', 'RRULE:FREQ=DAILY;COUNT=3']),
      vevent(['RECURRENCE-ID;TZID=Europe/London:20261006T080000', 'DTSTART;TZID=Europe/Rome:20261006T120000']),
    );
    const r = expand(o, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.equal(r.occurrences.length, 3);
    assert.equal(r.occurrences[1].kind, 'override');
    assert.equal(localOf(r.occurrences[1].startUtc), '2026-10-06 12:00');
    assert.equal(r.occurrences[1].endUtc - r.occurrences[1].startUtc, 90 * 60_000);
  });

  test('override fuori regola → occorrenza autonoma bloccante (orphan_override) con avviso', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20250106T090000', 'DTEND;TZID=Europe/Rome:20250106T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR']),
      // Mercoledì: non è un giorno della regola.
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261021T090000', 'DTSTART;TZID=Europe/Rome:20261021T100000', 'DTEND;TZID=Europe/Rome:20261021T110000', 'SUMMARY:Da device']),
      // Giovedì, ma alle 09:30: nessuna istanza a quell'ora.
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261022T093000', 'DTSTART;TZID=Europe/Rome:20261022T140000', 'DTEND;TZID=Europe/Rome:20261022T150000']),
    );
    const r = expand(o, Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 24));
    assertInvariants(r);
    assert.deepEqual(r.occurrences.map((x) => [localOf(x.startUtc), x.kind, x.recurrenceKey]), [
      ['2026-10-19 09:00', 'event', '20261019T070000Z'],
      ['2026-10-20 09:00', 'event', '20261020T070000Z'],
      ['2026-10-21 10:00', 'orphan_override', '20261021T070000Z'],
      ['2026-10-22 09:00', 'event', '20261022T070000Z'],
      ['2026-10-22 14:00', 'orphan_override', '20261022T073000Z'],
      ['2026-10-23 09:00', 'event', '20261023T070000Z'],
    ]);
    assert.equal(codes(r).filter((c) => c === 'ORPHAN_OVERRIDE').length, 2);
    const orphan = r.occurrences[2];
    assert.equal(orphan.originalStartUtc, D('2026-10-21', '09:00'));
    const kind = classifyOccurrenceKind('user', 'serie.ics', orphan.kind);
    assert.equal(kind, 'orphan_override');
    assert.equal(computeBlocks({ componentType: 'VEVENT', status: orphan.status, transp: orphan.transp, allDay: false, kind }), true);
  });

  test('override orfani senza master: occorrenze autonome', () => {
    const o = objectOf(
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261020T090000', 'DTSTART;TZID=Europe/Rome:20261020T110000', 'DTEND;TZID=Europe/Rome:20261020T120000']),
      vevent(['RECURRENCE-ID;VALUE=DATE:20261022', 'DTSTART;VALUE=DATE:20261022', 'DTEND;VALUE=DATE:20261023']),
    );
    assert.equal(o.master, null);
    const r = expand(o, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.deepEqual(r.occurrences.map((x) => [x.kind, x.recurrenceKey, x.allDay]), [
      ['orphan_override', '20261020T070000Z', false],
      ['orphan_override', '20261022', true],
    ]);
    assert.equal(r.health, 'ok');
    assert.equal(r.rangeStart, D('2026-10-20', '11:00'));
    assert.equal(r.rangeEnd, D('2026-10-23'));
  });

  test('override su un\'istanza esclusa da EXDATE prevale; override CANCELLED resta (non blocca)', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE;TZID=Europe/Rome:20261006T090000']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261006T090000', 'DTSTART;TZID=Europe/Rome:20261006T180000', 'DTEND;TZID=Europe/Rome:20261006T190000']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261007T090000', 'DTSTART;TZID=Europe/Rome:20261007T090000', 'DTEND;TZID=Europe/Rome:20261007T100000', 'STATUS:CANCELLED']),
    );
    const r = expand(o, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.deepEqual(r.occurrences.map((x) => [localOf(x.startUtc), x.kind, x.status]), [
      ['2026-10-05 09:00', 'event', null],
      ['2026-10-06 18:00', 'override', null],
      ['2026-10-07 09:00', 'override', 'CANCELLED'],
      ['2026-10-08 09:00', 'event', null],
    ]);
    assert.equal(computeBlocks({ componentType: 'VEVENT', status: 'CANCELLED', transp: null, allDay: false, kind: 'override' }), false);
  });

  test('override duplicati: vince SEQUENCE più alta, a parità l\'ultimo nel file', () => {
    const master = vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000', 'RRULE:FREQ=DAILY;COUNT=2']);
    const ov = (seq: number, hour: string): string[] =>
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261006T090000', `DTSTART;TZID=Europe/Rome:20261006T${hour}0000`, `DTEND;TZID=Europe/Rome:20261006T${hour}3000`, `SEQUENCE:${seq}`]);
    const r = expand(objectOf(master, ov(3, '11'), ov(1, '12')), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.equal(localOf(r.occurrences[1].startUtc), '2026-10-06 11:00');
    assert.deepEqual(r.occurrences[1].source, { type: 'override', index: 0 });
    assert.ok(codes(r).includes('DUPLICATE_RECURRENCE_ID'));
    const tie = expand(objectOf(master, ov(1, '11'), ov(1, '12')), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    assert.equal(localOf(tie.occurrences[1].startUtc), '2026-10-06 12:00');
    assert.equal(tie.occurrences.length, 2);
  });

  test('override spostato fuori o dentro la finestra; RANGE=THISANDFUTURE come singola istanza', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000', 'RRULE:FREQ=DAILY;COUNT=10']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261006T090000', 'DTSTART;TZID=Europe/Rome:20261020T090000', 'DTEND;TZID=Europe/Rome:20261020T100000']),
      vevent(['RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Rome:20261012T090000', 'DTSTART;TZID=Europe/Rome:20261008T120000', 'DTEND;TZID=Europe/Rome:20261008T130000']),
    );
    const r = expand(o, D('2026-10-05'), D('2026-10-10'));
    assert.deepEqual(r.occurrences.map((x) => [localOf(x.startUtc), x.kind]), [
      ['2026-10-05 09:00', 'event'],
      ['2026-10-07 09:00', 'event'],
      ['2026-10-08 09:00', 'event'],
      ['2026-10-08 12:00', 'override'],
      ['2026-10-09 09:00', 'event'],
    ]);
    assert.ok(codes(r).includes('RANGE_THISANDFUTURE_IGNORED'));
    const later = expand(o, D('2026-10-19'), D('2026-10-21'));
    assert.deepEqual(later.occurrences.map((x) => [localOf(x.startUtc), x.kind, x.recurrenceKey]), [['2026-10-20 09:00', 'override', '20261006T070000Z']]);
  });

  test('fixture Apple: override del 19/10 abbinato, VALARM e proprietà sconosciute non disturbano', () => {
    const r = expand(objectFromText(fixture('apple-fidelity.ics')), Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 1));
    assertInvariants(r);
    const ov = r.occurrences.filter((o) => o.kind !== 'event');
    assert.equal(ov.length, 1);
    assert.equal(ov[0].kind, 'override');
    assert.equal(ov[0].recurrenceKey, '20261019T070000Z');
    assert.equal(localOf(ov[0].startUtc), '2026-10-19 15:00');
    assert.ok(!r.occurrences.some((o) => o.kind === 'event' && o.recurrenceKey === '20261019T070000Z'));
  });
});

// ─── Tetto, budget, COUNT ───────────────────────────────

describe('tetto nella finestra, budget di iterazioni e COUNT', () => {
  const today = Date.UTC(2026, 9, 9);
  const horizon = { from: today - 400 * DAY_MS, to: today + 800 * DAY_MS };

  test('costanti del design', () => {
    assert.equal(MAX_OCCURRENCES_PER_OBJECT, 5000);
    assert.equal(EXPANSION_ITERATION_BUDGET, 200_000);
  });

  test('DAILY dal 2010 → occorrenze della settimana corrente in pochi ms', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20100104T090000', 'DTEND;TZID=Europe/Rome:20100104T093000', 'RRULE:FREQ=DAILY']));
    expand(o, Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 12)); // riscaldamento (Intl, fusi)
    const t0 = performance.now();
    const r = expand(o, Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 12));
    const ms = performance.now() - t0;
    assert.equal(r.occurrences.length, 7);
    assert.equal(localOf(r.occurrences[0].startUtc), '2026-10-05 09:00');
    assert.equal(r.health, 'ok');
    assert.ok(r.iterations < 50, `iterazioni: ${r.iterations}`);
    assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
    const h = expand(o, horizon.from, horizon.to);
    assert.equal(h.occurrences.length, 1200);
    assert.ok(h.iterations < 2000, `iterazioni sull'orizzonte: ${h.iterations}`);
  });

  test('COUNT con una regola che dopo il DTSTART non produce istanze: ok con il solo DTSTART, come senza COUNT (niente quarantena su tutto l\'orizzonte)', () => {
    for (const rule of ['FREQ=WEEKLY;BYDAY=SU;BYSETPOS=2;COUNT=5', 'FREQ=DAILY;BYMONTH=4;BYMONTHDAY=31;COUNT=3', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;COUNT=2']) {
      const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20260105T090000', 'DTEND;TZID=Europe/Rome:20260105T100000', `RRULE:${rule}`]));
      const r = expand(o, horizon.from, horizon.to);
      assert.equal(r.health, 'ok', rule);
      assert.equal(r.healthReason, null, rule);
      assert.deepEqual(locals(r), ['2026-01-05 09:00'], rule);
      assert.ok(!codes(r).includes('EXPANSION_BUDGET'), rule);
      assertInvariants(r);
    }
    // Una COUNT vera che il budget non raggiunge resta in quarantena (il rifacimento non la copre).
    const big = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20100104T090000', 'DTEND;TZID=Europe/Rome:20100104T090100', 'RRULE:FREQ=MINUTELY;COUNT=99999999']));
    const q = expand(big, horizon.from, horizon.to);
    assert.equal(q.health, 'quarantined');
    assert.equal(q.healthReason, 'expansion-budget');
  });

  test('HOURLY infinita dal 2010 → materializedUntil senza eccezioni, poi espansione al volo oltre quella data', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20100101T000000', 'DTEND;TZID=Europe/Rome:20100101T001500', 'RRULE:FREQ=HOURLY']));
    const r = expand(o, horizon.from, horizon.to);
    assertInvariants(r);
    assert.equal(r.health, 'ok');
    assert.equal(r.occurrences.length, MAX_OCCURRENCES_PER_OBJECT);
    assert.ok(r.materializedUntil != null);
    const mu = r.materializedUntil as number;
    assert.ok(r.occurrences.every((x) => x.startUtc < mu));
    assert.equal(mu, r.occurrences[r.occurrences.length - 1].startUtc + HOUR_MS);
    assert.ok(codes(r).includes('MAX_OCCURRENCES'));
    assert.ok(r.iterations < EXPANSION_ITERATION_BUDGET);
    assert.equal(r.rangeEnd, null);
    // Decisione oltre materializedUntil: si espande al volo la sola finestra richiesta.
    const w = expand(o, mu, mu + DAY_MS, { computeRangeEnd: false });
    assert.equal(w.health, 'ok');
    assert.equal(w.occurrences.length, 24);
    assert.equal(w.occurrences[0].startUtc, mu);
    assert.equal(w.materializedUntil, null);
  });

  test('MINUTELY infinita creata da device: tetto, nessuna quarantena', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20200101T000000', 'DURATION:PT1M', 'RRULE:FREQ=MINUTELY;INTERVAL=5']));
    const r = expand(o, horizon.from, horizon.to);
    assert.equal(r.health, 'ok');
    assert.equal(r.occurrences.length, MAX_OCCURRENCES_PER_OBJECT);
    assert.equal(r.occurrences[0].startUtc, horizon.from);
    assert.equal(r.materializedUntil, horizon.from + 5000 * 5 * 60_000);
  });

  test('COUNT contato dal DTSTART, anche quando la finestra inizia dopo o la serie finisce prima', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261001T090000', 'DTEND;TZID=Europe/Rome:20261001T100000', 'RRULE:FREQ=DAILY;COUNT=5']));
    const r = expand(o, D('2026-10-03'), D('2026-10-20'));
    assert.deepEqual(locals(r), ['2026-10-03 09:00', '2026-10-04 09:00', '2026-10-05 09:00']);
    assert.equal(r.rangeEnd, D('2026-10-05', '10:00'));
    // Serie con COUNT nata nel 2010 e finita prima della finestra.
    const old = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20100101T090000', 'DTEND;TZID=Europe/Rome:20100101T093000', 'RRULE:FREQ=DAILY;COUNT=5000']));
    const e = expand(old, horizon.from, horizon.to);
    assert.equal(e.occurrences.length, 0);
    assert.equal(e.health, 'ok');
    const lastDate = new Date(Date.UTC(2010, 0, 1) + 4999 * DAY_MS).toISOString().slice(0, 10);
    assert.equal(e.rangeEnd, D(lastDate, '09:30'));
    // HOURLY con COUNT dal 2010: senza fast-forward, circa 145k iterazioni per arrivare alla finestra (entro il budget).
    const hourly = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20100101T000000', 'DTEND;TZID=Europe/Rome:20100101T001500', 'RRULE:FREQ=HOURLY;COUNT=1000000']));
    const hr = expand(hourly, horizon.from, horizon.from + 10 * DAY_MS, { computeRangeEnd: false });
    assert.equal(hr.health, 'ok');
    assert.equal(hr.occurrences.length, 240);
    assert.ok(hr.iterations > 100_000 && hr.iterations < EXPANSION_ITERATION_BUDGET, `iterazioni: ${hr.iterations}`);
  });

  test('budget esaurito → quarantena con una sola occorrenza conservativa, bloccante solo se il master bloccherebbe', () => {
    const lines = ['DTSTART;TZID=Europe/Rome:20200101T090000', 'DTEND;TZID=Europe/Rome:20200101T100000', 'RRULE:FREQ=DAILY;COUNT=100000'];
    const r = expand(objectOf(vevent(lines)), D('2026-10-05'), D('2026-10-12'), { iterationBudget: 500 });
    assert.equal(r.health, 'quarantined');
    assert.equal(r.healthReason, 'expansion-budget');
    assert.deepEqual(r.occurrences.map((o) => [o.kind, o.recurrenceKey, o.startUtc, o.endUtc]), [['conservative', CONSERVATIVE_RECURRENCE_KEY, D('2026-10-05'), D('2026-10-12')]]);
    assert.ok(codes(r).includes('EXPANSION_BUDGET'));
    const blocks = (res: ExpansionResult): boolean => {
      const o = res.occurrences[0];
      return computeBlocks({ componentType: 'VEVENT', status: o.status, transp: o.transp, allDay: o.allDay, kind: classifyOccurrenceKind('user', 'x.ics', o.kind) });
    };
    assert.equal(blocks(r), true);
    const free = expand(objectOf(vevent([...lines, 'TRANSP:TRANSPARENT'])), D('2026-10-05'), D('2026-10-12'), { iterationBudget: 500 });
    assert.equal(free.occurrences[0].transp, 'TRANSPARENT');
    assert.equal(blocks(free), false);
    // Con UNTIL la conservativa si ferma all'UNTIL più la durata (COUNT impedisce il fast-forward).
    const until = expand(
      objectOf(vevent(['DTSTART;TZID=Europe/Rome:20200101T090000', 'DTEND;TZID=Europe/Rome:20200101T100000', 'RRULE:FREQ=DAILY;COUNT=100000;UNTIL=20261007T080000Z'])),
      D('2026-10-05'), D('2026-10-12'), { iterationBudget: 300 },
    );
    assert.equal(until.healthReason, 'expansion-budget');
    assert.deepEqual(until.occurrences.map((o) => [o.kind, o.startUtc, o.endUtc]), [['conservative', D('2026-10-05'), D('2026-10-07', '11:00')]]);
    // Senza COUNT la stessa regola arriva alla finestra con il fast-forward: nessuna quarantena.
    const seekable = expand(
      objectOf(vevent(['DTSTART;TZID=Europe/Rome:20200101T090000', 'DTEND;TZID=Europe/Rome:20200101T100000', 'RRULE:FREQ=DAILY;UNTIL=20261007T080000Z'])),
      D('2026-10-05'), D('2026-10-12'), { iterationBudget: 300 },
    );
    assert.equal(seekable.health, 'ok');
    assert.equal(seekable.occurrences.length, 3);
  });

  test('il tetto conta solo dentro la finestra: una serie lunga prima della finestra non lo consuma', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20100101T080000', 'DTEND;TZID=Europe/Rome:20100101T081500', 'RRULE:FREQ=DAILY;BYHOUR=8,12,18']));
    const r = expand(o, D('2026-10-05'), D('2026-10-12'), { maxOccurrences: 30 });
    assert.equal(r.occurrences.length, 21);
    assert.equal(r.materializedUntil, null);
    const capped = expand(o, D('2026-10-05'), D('2026-10-12'), { maxOccurrences: 10 });
    assert.equal(capped.occurrences.length, 10);
    assert.equal(capped.materializedUntil, D('2026-10-08', '12:00'));
  });
});

// ─── Quarantena e salute ───────────────────────────────

describe('quarantena senza eccezioni', () => {
  test('RRULE non valida → invalid-rrule con occorrenza conservativa da max(DTSTART, from) a fine finestra', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261001T090000', 'DTEND;TZID=Europe/Rome:20261001T100000', 'RRULE:FREQ=DAILY;BYDAY=XX']));
    const r = expand(o, D('2026-10-05'), D('2026-10-12'));
    assert.equal(r.health, 'quarantined');
    assert.equal(r.healthReason, 'invalid-rrule');
    assert.deepEqual(r.occurrences.map((x) => [x.kind, x.startUtc, x.endUtc]), [['conservative', D('2026-10-05'), D('2026-10-12')]]);
    // Serie che inizia dentro la finestra: la conservativa parte dal DTSTART.
    const late = expand(o, D('2026-09-01'), D('2026-10-12'));
    assert.equal(late.occurrences[0].startUtc, D('2026-10-01', '09:00'));
    // RRULE oraria su un all-day: stessa sorte, conservativa all-day.
    const ad = expand(objectOf(vevent(['DTSTART;VALUE=DATE:20261001', 'RRULE:FREQ=HOURLY'])), D('2026-10-05'), D('2026-10-12'));
    assert.equal(ad.healthReason, 'invalid-rrule');
    assert.equal(ad.occurrences[0].allDay, true);
    assert.equal(ad.occurrences[0].startDate, '2026-10-05');
    assert.equal(ad.occurrences[0].endDate, '2026-10-12');
  });

  test('RRULE non valida con UNTIL leggibile → conservativa da DTSTART a UNTIL più la durata (intervallo noto, design §6.5)', () => {
    const start = ['DTSTART;TZID=Europe/Rome:20261006T150000', 'DTEND;TZID=Europe/Rome:20261006T160000'];
    const kinds = (r: ReturnType<typeof expand>) => r.occurrences.map((x) => [x.kind, x.startUtc, x.endUtc]);
    // BYDAY ripetuto (Radicale lo accetta, RFC 5545 §3.3.10 lo vieta) con UNTIL in UTC.
    const utc = expand(objectOf(vevent([...start, 'RRULE:FREQ=DAILY;BYDAY=MO;BYDAY=TU;UNTIL=20261007T130000Z'])), D('2026-10-01'), D('2026-10-31'));
    assert.equal(utc.healthReason, 'invalid-rrule');
    assert.deepEqual(kinds(utc), [['conservative', D('2026-10-06', '15:00'), D('2026-10-07', '16:00')]]);
    // UNTIL locale (senza Z) nella zona del DTSTART.
    const wall = expand(objectOf(vevent([...start, 'RRULE:FREQ=DAILY;BYDAY=XX;UNTIL=20261008T150000'])), D('2026-10-01'), D('2026-10-31'));
    assert.deepEqual(kinds(wall), [['conservative', D('2026-10-06', '15:00'), D('2026-10-08', '16:00')]]);
    // UNTIL DATE: tutta la giornata locale, più la durata.
    const date = expand(objectOf(vevent([...start, 'RRULE:FREQ=DAILY;BYDAY=XX;UNTIL=20261009'])), D('2026-10-01'), D('2026-10-31'));
    assert.deepEqual(kinds(date), [['conservative', D('2026-10-06', '15:00'), D('2026-10-10', '01:00')]]);
    // UNTIL prima del DTSTART: resta almeno l'istanza del DTSTART.
    const before = expand(objectOf(vevent([...start, 'RRULE:FREQ=DAILY;BYDAY=XX;UNTIL=20261001T000000Z'])), D('2026-10-01'), D('2026-10-31'));
    assert.deepEqual(kinds(before), [['conservative', D('2026-10-06', '15:00'), D('2026-10-06', '16:00')]]);
    // Con RDATE, UNTIL illeggibile o ripetuto il blocco resta aperto fino a fine finestra.
    for (const extra of [
      ['RRULE:FREQ=DAILY;BYDAY=XX;UNTIL=20261007T130000Z', 'RDATE;TZID=Europe/Rome:20261020T150000'],
      ['RRULE:FREQ=DAILY;BYDAY=XX;UNTIL=2026-10-07'],
      ['RRULE:FREQ=DAILY;BYDAY=XX;UNTIL=20261007T130000Z;UNTIL=20261008T130000Z'],
    ]) {
      const open = expand(objectOf(vevent([...start, ...extra])), D('2026-10-01'), D('2026-10-31'));
      assert.deepEqual(kinds(open), [['conservative', D('2026-10-06', '15:00'), D('2026-10-31')]], extra.join(' '));
    }
  });

  test('DTSTART illeggibile o assente nel VEVENT → invalid-value, nessuna occorrenza; VTODO senza DTSTART → nessuna occorrenza, ok', () => {
    const bad = objectOf(vevent(['DTSTART;TZID=Europe/Rome:2026-10-01 09:00', 'DTEND;TZID=Europe/Rome:20261001T100000']));
    const r = expand(bad, D('2026-10-01'), D('2026-10-12'));
    assert.equal(r.health, 'quarantined');
    assert.equal(r.healthReason, 'invalid-value');
    assert.equal(r.occurrences.length, 0);
    const todo = objectFromText(vcalendar(['BEGIN:VTODO', 'UID:t@caldes.test', 'DTSTAMP:20261001T080000Z', 'SUMMARY:Da fare', 'END:VTODO']));
    const t = expand(todo, D('2026-10-01'), D('2026-10-12'));
    assert.equal(t.health, 'ok');
    assert.equal(t.occurrences.length, 0);
    const todoDue = objectFromText(vcalendar(['BEGIN:VTODO', 'UID:t2@caldes.test', 'DTSTAMP:20261001T080000Z', 'DTSTART;TZID=Europe/Rome:20261005T090000', 'DUE;TZID=Europe/Rome:20261005T110000', 'END:VTODO']));
    const td = expand(todoDue, D('2026-10-01'), D('2026-10-12'));
    assert.equal(td.occurrences[0].endUtc - td.occurrences[0].startUtc, 2 * HOUR_MS);
  });

  test('finestra non valida: errore INTERNAL (difetto del chiamante)', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261001T090000']));
    assert.throws(() => expand(o, 10, 5), (e: unknown) => e instanceof CalendarCoreError && e.code === 'INTERNAL');
    assert.throws(() => expand(o, Number.NaN, 5), CalendarCoreError);
  });
});

// ─── Sovrapposizione e singoli ───────────────────────────────

describe('sovrapposizione alla finestra e eventi singoli', () => {
  test('occorrenze in corso all\'inizio della finestra incluse (il legacy le perdeva), durata nulla solo se inizia dentro', () => {
    const night = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261001T230000', 'DTEND;TZID=Europe/Rome:20261002T020000', 'RRULE:FREQ=DAILY']));
    const r = expand(night, D('2026-10-05'), D('2026-10-06'));
    assert.deepEqual(locals(r), ['2026-10-04 23:00', '2026-10-05 23:00']);
    const single = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000']));
    const s = expand(single, D('2026-10-05', '09:30'), D('2026-10-05', '12:00'));
    assert.deepEqual(s.occurrences.map((o) => [o.recurrenceKey, o.kind]), [[MASTER_RECURRENCE_KEY, 'event']]);
    assert.equal(s.isRecurring, false);
    assert.equal(s.rangeEnd, D('2026-10-05', '10:00'));
    assert.equal(expand(single, D('2026-10-05', '10:00'), D('2026-10-05', '12:00')).occurrences.length, 0, 'fine esclusiva');
    const point = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261005T090000']));
    assert.equal(expand(point, D('2026-10-05', '09:00'), D('2026-10-05', '10:00')).occurrences.length, 1);
    assert.equal(expand(point, D('2026-10-05', '08:00'), D('2026-10-05', '09:00')).occurrences.length, 0);
  });

  test('festività: timed 00:00 → 24:00 di Roma (parità), 25 ore nel giorno del cambio d\'ora', () => {
    const h = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261025T000000', 'DTEND;TZID=Europe/Rome:20261026T000000', 'SUMMARY:Festa'], 'it-holiday-2026-10-25@caldes.it'));
    const r = expand(h, D('2026-10-01'), D('2026-11-01'));
    assert.equal(r.occurrences[0].endUtc - r.occurrences[0].startUtc, 25 * HOUR_MS);
    assert.equal(classifyOccurrenceKind('holidays', 'it-holiday-2026-10-25.ics', r.occurrences[0].kind), 'holiday_system');
  });

  test('DTSTART fuori regola: prima occorrenza (RFC 5545) e conta per COUNT, con avviso', () => {
    // Mercoledì 7 ottobre con BYDAY=MO: il legacy (rrule.js) lo scarta e conta 3 lunedì.
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261007T090000', 'DTEND;TZID=Europe/Rome:20261007T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3']));
    const r = expand(o, D('2026-10-01'), D('2026-12-01'));
    assert.deepEqual(locals(r), ['2026-10-07 09:00', '2026-10-12 09:00', '2026-10-19 09:00']);
    assert.ok(codes(r).includes('DTSTART_NOT_IN_RULE'));
  });

  test('BYDAY misto: unione di RFC 5545 (il legacy e dateutil non danno occorrenze), avviso MIXED_BYDAY', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261001T090000', 'DTEND;TZID=Europe/Rome:20261001T100000', 'RRULE:FREQ=MONTHLY;BYDAY=MO,1FR']));
    const r = expand(o, D('2026-10-02'), D('2026-11-01'));
    assert.deepEqual(locals(r), ['2026-10-02 09:00', '2026-10-05 09:00', '2026-10-12 09:00', '2026-10-19 09:00', '2026-10-26 09:00']);
    assert.ok(codes(r).includes('MIXED_BYDAY'));
  });

  test('BYDAY misto con COUNT: il messaggio non dice più che il legacy non mostra nulla (mostra l\'intersezione, con date diverse)', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20260102T090000', 'DTEND;TZID=Europe/Rome:20260102T100000', 'RRULE:FREQ=MONTHLY;BYDAY=FR,1FR;COUNT=6']));
    const r = expand(o, D('2026-01-01'), D('2026-07-01'));
    // Unione RFC: sei venerdì da gennaio; il legacy e dateutil: 02/01, 06/02, 06/03, 03/04, 01/05, 05/06.
    assert.deepEqual(locals(r), ['2026-01-02 09:00', '2026-01-09 09:00', '2026-01-16 09:00', '2026-01-23 09:00', '2026-01-30 09:00', '2026-02-06 09:00']);
    const w = r.warnings.find((x) => x.code === 'MIXED_BYDAY');
    assert.ok(w && /intersezione/.test(w.message) && /date che l'unione non ha/.test(w.message), w?.message);
    assert.ok(!/non ne mostrano/.test(w.message));
    const plain = expand(objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261001T090000', 'RRULE:FREQ=MONTHLY;BYDAY=MO,1FR'])), D('2026-10-02'), D('2026-11-01'));
    assert.ok(!/non ne mostrano/.test(plain.warnings.find((x) => x.code === 'MIXED_BYDAY')?.message ?? ''));
  });

  test('DTEND prima di DTSTART: durata nulla con avviso', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T080000', 'RRULE:FREQ=DAILY;COUNT=2']));
    const r = expand(o, D('2026-10-01'), D('2026-10-12'));
    assert.ok(r.occurrences.every((x) => x.endUtc === x.startUtc));
    assert.ok(codes(r).includes('END_BEFORE_START'));
  });
});

// ─── Busy conservativo dal testo ───────────────────────────────

describe('conservativeRangeFromText', () => {
  test('testo rotto: DTSTART e DTEND letti riga per riga con TZID, VTIMEZONE ignorato', () => {
    const raw = [
      'BEGIN:VCALENDAR',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Rome',
      'BEGIN:STANDARD',
      'DTSTART:19701025T030000',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:rotto',
      'DTSTART;TZID=Europe/Rome:20261005T090000',
      'DTEND;TZID=Europe/Rome:20261005T1',
      ' 00000',
      'SUMMARY:testo con riga \u0000 spazzatura',
      'GARBAGE LINE',
      'END:VEVENT',
    ].join('\r\n');
    assert.deepEqual(conservativeRangeFromText(raw, { tz: ROME }), { start: D('2026-10-05', '09:00'), end: D('2026-10-05', '10:00'), recurring: false });
  });

  test('RRULE con UNTIL → fine all\'UNTIL più la durata; senza UNTIL → fine aperta; RDATE allarga', () => {
    const base = ['BEGIN:VEVENT', 'DTSTART;TZID=Europe/Rome:20261005T090000', 'DURATION:PT2H'];
    assert.deepEqual(conservativeRangeFromText([...base, 'RRULE:FREQ=DAILY;UNTIL=20261010T070000Z', 'END:VEVENT'].join('\n'), { tz: ROME }), {
      start: D('2026-10-05', '09:00'), end: D('2026-10-10', '11:00'), recurring: true,
    });
    assert.deepEqual(conservativeRangeFromText([...base, 'RRULE:FREQ=DAILY;COUNT=10', 'END:VEVENT'].join('\n'), { tz: ROME }), {
      start: D('2026-10-05', '09:00'), end: null, recurring: true,
    });
    assert.deepEqual(conservativeRangeFromText([...base, 'RDATE;TZID=Europe/Rome:20261020T090000', 'END:VEVENT'].join('\n'), { tz: ROME }), {
      start: D('2026-10-05', '09:00'), end: D('2026-10-20', '11:00'), recurring: true,
    });
  });

  test('più componenti (override spostati prima del master), DATE e floating nel fuso del calendario', () => {
    const raw = [
      'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261010', 'END:VEVENT',
      'BEGIN:VEVENT', 'RECURRENCE-ID;VALUE=DATE:20261011', 'DTSTART:20261003T150000', 'END:VEVENT',
    ].join('\r\n');
    assert.deepEqual(conservativeRangeFromText(raw, { tz: ROME }), { start: D('2026-10-03', '15:00'), end: D('2026-10-11'), recurring: false });
    const ny = conservativeRangeFromText('BEGIN:VEVENT\nDTSTART:20261003T150000\nEND:VEVENT', { tz: 'America/New_York' });
    assert.equal(ny?.start, D('2026-10-03', '15:00', 'America/New_York'));
  });

  test('senza DTSTART leggibile → null; mai un\'eccezione', () => {
    assert.equal(conservativeRangeFromText('BEGIN:VEVENT\nSUMMARY:niente\nEND:VEVENT', { tz: ROME }), null);
    assert.equal(conservativeRangeFromText('', { tz: ROME }), null);
    assert.equal(conservativeRangeFromText('\u0000�;;;:::BEGIN:', { tz: 'Non/Esiste' }), null);
    const frag = conservativeRangeFromText('DTSTART:20261005T090000Z', { tz: ROME });
    assert.deepEqual(frag, { start: Date.parse('2026-10-05T09:00:00Z'), end: Date.parse('2026-10-05T10:00:00Z'), recurring: false });
  });
});

// ─── Proprietà generali ───────────────────────────────

describe('proprietà generali dell\'esito', () => {
  test('stesso esito su finestre diverse (fast-forward esatto) e chiavi stabili', () => {
    const o = objectOf(
      // Settimane alterne dal 06/01/2025: quella del 12/10/2026 è attiva, quella del 19/10 no.
      vevent(['DTSTART;TZID=Europe/Rome:20250106T090000', 'DTEND;TZID=Europe/Rome:20250106T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;INTERVAL=2', 'EXDATE;TZID=Europe/Rome:20261013T090000']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261015T090000', 'DTSTART;TZID=Europe/Rome:20261015T170000', 'DTEND;TZID=Europe/Rome:20261015T180000']),
    );
    const wide = expand(o, D('2026-01-01'), D('2027-06-01'));
    const narrow = expand(o, D('2026-10-01'), D('2026-11-15'));
    const inNarrow = wide.occurrences.filter((x) => x.endUtc > D('2026-10-01') && x.startUtc < D('2026-11-15'));
    assert.deepEqual(narrow.occurrences, inNarrow);
    assertInvariants(wide);
    assert.ok(!wide.occurrences.some((x) => x.recurrenceKey === '20261013T070000Z'));
    assert.equal(wide.occurrences.find((x) => x.recurrenceKey === '20261015T070000Z')?.kind, 'override');
    assert.ok(wide.occurrences.some((x) => x.recurrenceKey === '20261012T070000Z'));
    assert.ok(!wide.occurrences.some((x) => x.recurrenceKey === '20261019T070000Z'), 'settimana non attiva');
  });

  test('non modifica l\'oggetto in ingresso', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000', 'RRULE:FREQ=DAILY;COUNT=3']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261006T090000', 'DTSTART;TZID=Europe/Rome:20261006T120000']),
    );
    const before = JSON.stringify(o);
    expand(o, D('2026-10-01'), D('2026-11-01'));
    assert.equal(JSON.stringify(o), before);
    assert.equal(getProperty(o.master!, 'RRULE')?.value, 'FREQ=DAILY;COUNT=3');
  });
});
