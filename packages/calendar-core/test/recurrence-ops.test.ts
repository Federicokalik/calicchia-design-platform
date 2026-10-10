/**
 * Operazioni sulle ricorrenze (src/recurrence-ops.ts, design §8 "Ricorrenze",
 * §14): solo questa (override), elimina questa (EXDATE o rimozione
 * dell'override), ripristina, tutta la serie (spostamento con Δ su
 * RECURRENCE-ID, EXDATE, RDATE e UNTIL; cambio di regola con dryRun), questa
 * e le successive (troncamento e nuova serie con COUNT residuo), duplica alla
 * data dell'occorrenza. Ogni esito si verifica anche attraverso expandObject:
 * è l'espansione che decide busy, admin e feed.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  type CalendarObject,
  changeRecurrence,
  duplicateOccurrence,
  excludeOccurrence,
  expandObject,
  type ExpansionResult,
  getProperties,
  getProperty,
  getSubcomponents,
  isCalendarCoreError,
  IcsValueError,
  MASTER_RECURRENCE_KEY,
  materializeOverride,
  occurrenceExists,
  RecurrenceTargetError,
  restoreOccurrence,
  serializeObject,
  shiftSeries,
  splitSeries,
  truncateSeries,
} from '../src/index';
import { iso, localOf, objectFromText, objectOf, propLine, ROME, vevent, wallMs } from './ical-builders';

const NOW = new Date('2026-10-09T10:00:00Z');
const CTX = { tz: ROME, now: NOW };
const D = (date: string, time = '00:00'): number => wallMs(date, time);
const WIN = { from: D('2025-01-01'), to: D('2028-01-01') };

function expand(obj: CalendarObject, from = WIN.from, to = WIN.to): ExpansionResult {
  return expandObject(obj, { from, to, tz: ROME });
}
const view = (r: ExpansionResult): string[] => r.occurrences.map((o) => `${localOf(o.startUtc)} ${o.kind}${o.status ? ` ${o.status}` : ''}`);

function goneError(key: string): (e: unknown) => boolean {
  return (e: unknown) => e instanceof RecurrenceTargetError && e.code === 'RECURRENCE_TARGET_GONE' && e.recurrenceKey === key;
}

/** Serie lun-mar-gio-ven 09:00-10:00 con allarme, X-prop, EXDATE e un override. */
function weekly(extra: string[] = []): CalendarObject {
  return objectFromText([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Caldes//test//IT',
    'BEGIN:VEVENT',
    'UID:lmgv@caldes.test',
    'DTSTAMP:20261001T080000Z',
    'DTSTART;TZID=Europe/Rome:20261012T090000',
    'DTEND;TZID=Europe/Rome:20261012T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;COUNT=12',
    'EXDATE;TZID=Europe/Rome:20261016T090000',
    'SUMMARY:Studio',
    'LOCATION:Via Roma 1',
    'SEQUENCE:2',
    'X-CALDES-LEGACY-ID:11111111-1111-4111-8111-111111111111',
    'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
    ...extra,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Promemoria', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:lmgv@caldes.test',
    'DTSTAMP:20261001T080000Z',
    'RECURRENCE-ID;TZID=Europe/Rome:20261020T090000',
    'DTSTART;TZID=Europe/Rome:20261020T150000',
    'DTEND;TZID=Europe/Rome:20261020T160000',
    'SUMMARY:Studio spostato',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));
}

// Occorrenze della serie base: 12 dalla regola (12/10 → 09/11), meno il 16/10 (EXDATE), 20/10 spostato.
const BASE_VIEW = [
  '2026-10-12 09:00 event', '2026-10-13 09:00 event', '2026-10-15 09:00 event',
  '2026-10-19 09:00 event', '2026-10-20 15:00 override', '2026-10-22 09:00 event', '2026-10-23 09:00 event',
  '2026-10-26 09:00 event', '2026-10-27 09:00 event', '2026-10-29 09:00 event', '2026-10-30 09:00 event',
];

test('la serie di base si espande come previsto', () => {
  assert.deepEqual(view(expand(weekly())), BASE_VIEW);
});

describe('occurrenceExists', () => {
  test('istanze correnti, escluse, fuori regola, override e chiavi malformate', () => {
    const o = weekly();
    assert.equal(occurrenceExists(o, '20261013T070000Z', CTX), true);
    assert.equal(occurrenceExists(o, '20261026T080000Z', CTX), true, 'dopo il cambio d\'ora');
    assert.equal(occurrenceExists(o, '20261016T070000Z', CTX), false, 'esclusa da EXDATE');
    assert.equal(occurrenceExists(o, '20261014T070000Z', CTX), false, 'mercoledì');
    assert.equal(occurrenceExists(o, '20261110T080000Z', CTX), false, 'oltre COUNT');
    assert.equal(occurrenceExists(o, '20261020T070000Z', CTX), true, 'override');
    assert.equal(occurrenceExists(o, MASTER_RECURRENCE_KEY, CTX), true);
    assert.throws(() => occurrenceExists(o, 'domani', CTX), (e: unknown) => e instanceof RecurrenceTargetError && e.code === 'INVALID_TARGET');
    assert.throws(() => occurrenceExists(o, 'conservative', CTX), RecurrenceTargetError);
  });

  test('budget esaurito: true (niente 409 spuri)', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20100101T090000', 'RRULE:FREQ=HOURLY;COUNT=1000000']));
    assert.equal(occurrenceExists(o, '20261007T070000Z', { ...CTX, iterationBudget: 1000 }), true);
  });
});

describe('solo questa: materializeOverride', () => {
  test('copia del master all\'istanza: proprietà, VALARM e X-* sì; RRULE, EXDATE e LEGACY-ID no', () => {
    const o = weekly();
    const before = serializeObject(o);
    const r = materializeOverride(o, '20261027T080000Z', CTX);
    assert.equal(r.created, true);
    assert.equal(serializeObject(o), before, 'oggetto in ingresso invariato');
    const ov = r.object.overrides[r.index];
    assert.equal(propLine(ov, 'RECURRENCE-ID'), 'RECURRENCE-ID;TZID=Europe/Rome:20261027T090000');
    assert.equal(propLine(ov, 'DTSTART'), 'DTSTART;TZID=Europe/Rome:20261027T090000');
    // Durata del master anche dopo il cambio d'ora (ora da muro, non istante + 1 h di ottobre).
    assert.equal(propLine(ov, 'DTEND'), 'DTEND;TZID=Europe/Rome:20261027T100000');
    assert.equal(getProperty(ov, 'SUMMARY')?.value, 'Studio');
    assert.equal(getProperty(ov, 'LOCATION')?.value, 'Via Roma 1');
    assert.equal(getProperty(ov, 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR')?.value, 'AUTOMATIC');
    assert.equal(getSubcomponents(ov, 'VALARM').length, 1);
    for (const name of ['RRULE', 'EXDATE', 'RDATE', 'X-CALDES-LEGACY-ID']) assert.equal(getProperty(ov, name), null, name);
    assert.equal(getProperty(ov, 'DTSTAMP')?.value, '20261009T100000Z');
    assert.equal(getProperty(ov, 'UID')?.value, 'lmgv@caldes.test');
    // L'espansione lo abbina: stessa vista, l'occorrenza diventa override.
    const after = expand(r.object);
    assert.deepEqual(view(after), BASE_VIEW.map((l) => (l.startsWith('2026-10-27') ? '2026-10-27 09:00 override' : l)));
  });

  test('override esistente restituito senza modifiche; istanza esclusa o fuori regola → 409; non ricorrente → NOT_RECURRING', () => {
    const o = weekly();
    const r = materializeOverride(o, '20261020T070000Z', CTX);
    assert.equal(r.created, false);
    assert.equal(r.index, 0);
    assert.equal(serializeObject(r.object), serializeObject(o));
    assert.throws(() => materializeOverride(o, '20261016T070000Z', CTX), goneError('20261016T070000Z'));
    assert.throws(() => materializeOverride(o, '20261014T070000Z', CTX), goneError('20261014T070000Z'));
    const single = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261012T090000']));
    assert.throws(() => materializeOverride(single, '20261012T070000Z', CTX), (e: unknown) => e instanceof RecurrenceTargetError && e.code === 'NOT_RECURRING');
    assert.throws(() => materializeOverride(o, MASTER_RECURRENCE_KEY, CTX), (e: unknown) => e instanceof RecurrenceTargetError && e.code === 'INVALID_TARGET');
    // Codice e chiave arrivano all'API (409 CALENDAR_CONFLICT).
    try {
      materializeOverride(o, '20261014T070000Z', CTX);
    } catch (e) {
      assert.ok(isCalendarCoreError(e));
      assert.equal((e as RecurrenceTargetError).code, 'RECURRENCE_TARGET_GONE');
    }
  });

  test('all-day: RECURRENCE-ID;VALUE=DATE e DTEND con gli stessi giorni', () => {
    const o = objectOf(vevent(['DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261007', 'RRULE:FREQ=WEEKLY;COUNT=3']));
    const r = materializeOverride(o, '20261012', CTX);
    const ov = r.object.overrides[r.index];
    assert.equal(propLine(ov, 'RECURRENCE-ID'), 'RECURRENCE-ID;VALUE=DATE:20261012');
    assert.equal(propLine(ov, 'DTSTART'), 'DTSTART;VALUE=DATE:20261012');
    assert.equal(propLine(ov, 'DTEND'), 'DTEND;VALUE=DATE:20261014');
  });

  test('istanza solo RDATE e master floating', () => {
    const rd = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DURATION:PT45M', 'RDATE;TZID=Europe/Rome:20261020T150000']));
    const r = materializeOverride(rd, '20261020T130000Z', CTX);
    assert.equal(propLine(r.object.overrides[0], 'RECURRENCE-ID'), 'RECURRENCE-ID;TZID=Europe/Rome:20261020T150000');
    assert.equal(getProperty(r.object.overrides[0], 'DURATION')?.value, 'PT45M');
    const fl = objectOf(vevent(['DTSTART:20261005T090000', 'DTEND:20261005T100000', 'RRULE:FREQ=DAILY;COUNT=3']));
    const f = materializeOverride(fl, '20261006T090000', CTX);
    assert.equal(propLine(f.object.overrides[0], 'RECURRENCE-ID'), 'RECURRENCE-ID:20261006T090000');
  });
});

describe('elimina questa: excludeOccurrence', () => {
  test('EXDATE tipizzato come DTSTART, SEQUENCE+1, l\'occorrenza sparisce', () => {
    const o = weekly();
    const out = excludeOccurrence(o, '20261027T080000Z', CTX);
    const master = out.master!;
    assert.deepEqual(getProperties(master, 'EXDATE').map((p) => `${p.params.map((x) => `${x.name}=${x.values[0]}`).join(';')}:${p.value}`), ['TZID=Europe/Rome:20261016T090000,20261027T090000']);
    assert.equal(getProperty(master, 'SEQUENCE')?.value, '3');
    assert.equal(getProperty(master, 'LAST-MODIFIED')?.value, '20261009T100000Z');
    assert.deepEqual(view(expand(out)), BASE_VIEW.filter((l) => !l.startsWith('2026-10-27')));
    assert.equal(occurrenceExists(out, '20261027T080000Z', CTX), false);
    // Stessa azione due volte: il target non c'è più → 409 (niente nuovi orfani).
    assert.throws(() => excludeOccurrence(out, '20261027T080000Z', CTX), goneError('20261027T080000Z'));
  });

  test('istanza con override: EXDATE più rimozione dell\'override (oggi: override CANCELLED, stesso effetto)', () => {
    const out = excludeOccurrence(weekly(), '20261020T070000Z', CTX);
    assert.equal(out.overrides.length, 0);
    assert.match(getProperties(out.master!, 'EXDATE').map((p) => p.value).join(','), /20261020T090000/);
    assert.deepEqual(view(expand(out)), BASE_VIEW.filter((l) => !l.startsWith('2026-10-20')));
  });

  test('all-day: EXDATE;VALUE=DATE; istanza solo RDATE: tolta dalla RDATE; override orfano: solo rimosso', () => {
    const ad = excludeOccurrence(objectOf(vevent(['DTSTART;VALUE=DATE:20261005', 'RRULE:FREQ=DAILY;COUNT=3'])), '20261006', CTX);
    assert.equal(propLine(ad.master!, 'EXDATE'), 'EXDATE;VALUE=DATE:20261006');
    const rd = excludeOccurrence(
      objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'RDATE;TZID=Europe/Rome:20261020T150000,20261021T150000'])),
      '20261020T130000Z', CTX,
    );
    assert.equal(propLine(rd.master!, 'RDATE'), 'RDATE;TZID=Europe/Rome:20261021T150000');
    assert.equal(getProperty(rd.master!, 'EXDATE'), null);
    const orphan = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'RRULE:FREQ=DAILY;COUNT=3']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261005T093000', 'DTSTART;TZID=Europe/Rome:20261005T140000']),
    );
    const out = excludeOccurrence(orphan, '20261005T073000Z', CTX);
    assert.equal(out.overrides.length, 0);
    assert.equal(getProperty(out.master!, 'EXDATE'), null);
    assert.equal(getProperty(out.master!, 'SEQUENCE'), null, 'master non toccato');
  });

  test('oggetto senza master: rimuove l\'override; chiave inesistente → errore', () => {
    const o = objectOf(vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261005T090000', 'DTSTART;TZID=Europe/Rome:20261005T140000']));
    assert.equal(excludeOccurrence(o, '20261005T070000Z', CTX).overrides.length, 0);
    assert.throws(() => excludeOccurrence(o, '20261006T070000Z', CTX), RecurrenceTargetError);
  });
});

describe('ripristina: restoreOccurrence', () => {
  test('toglie l\'EXDATE (anche di tipo diverso), nessun effetto se non esclusa, fuori regola → 409', () => {
    const r = restoreOccurrence(weekly(), '20261016T070000Z', CTX);
    assert.equal(getProperty(r.master!, 'EXDATE'), null);
    assert.equal(getProperty(r.master!, 'SEQUENCE')?.value, '3');
    assert.ok(view(expand(r)).includes('2026-10-16 09:00 event'));
    const typed = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;VALUE=DATE:20261006,20261007']));
    const t = restoreOccurrence(typed, '20261006T070000Z', CTX);
    assert.equal(propLine(t.master!, 'EXDATE'), 'EXDATE;VALUE=DATE:20261007');
    const untouched = restoreOccurrence(weekly(), '20261013T070000Z', CTX);
    assert.equal(serializeObject(untouched), serializeObject(weekly()));
    assert.throws(() => restoreOccurrence(weekly(), '20261014T070000Z', CTX), goneError('20261014T070000Z'));
  });
});

describe('tutta la serie: shiftSeries', () => {
  test('Δ di 90 minuti su DTSTART, DTEND, EXDATE e RECURRENCE-ID; orari propri degli override invariati; chiavi ri-mappate', () => {
    const o = weekly();
    const r = shiftSeries(o, { type: 'date-time', year: 2026, month: 10, day: 12, hour: 10, minute: 30, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } }, CTX);
    const m = r.object.master!;
    assert.equal(propLine(m, 'DTSTART'), 'DTSTART;TZID=Europe/Rome:20261012T103000');
    assert.equal(propLine(m, 'DTEND'), 'DTEND;TZID=Europe/Rome:20261012T113000');
    assert.equal(propLine(m, 'EXDATE'), 'EXDATE;TZID=Europe/Rome:20261016T103000');
    assert.equal(getProperty(m, 'SEQUENCE')?.value, '3');
    const ov = r.object.overrides[0];
    assert.equal(propLine(ov, 'RECURRENCE-ID'), 'RECURRENCE-ID;TZID=Europe/Rome:20261020T103000');
    assert.equal(propLine(ov, 'DTSTART'), 'DTSTART;TZID=Europe/Rome:20261020T150000');
    assert.deepEqual([...r.rekeyed], [['20261020T070000Z', '20261020T083000Z']]);
    // Nessun orfano: l'override resta abbinato e l'EXDATE continua a escludere.
    assert.deepEqual(view(expand(r.object)), BASE_VIEW.map((l) => l.replace(' 09:00 ', ' 10:30 ')));
  });

  test('Δ in ora da muro attraverso il cambio d\'ora; UNTIL spostato dello stesso Δ (stesso numero di istanze)', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261019T090000', 'DTEND;TZID=Europe/Rome:20261019T100000', 'RRULE:FREQ=WEEKLY;UNTIL=20261102T080000Z']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261026T090000', 'DTSTART;TZID=Europe/Rome:20261026T120000', 'DTEND;TZID=Europe/Rome:20261026T130000']),
    );
    const r = shiftSeries(o, { type: 'date-time', year: 2026, month: 10, day: 20, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } }, CTX);
    assert.equal(getProperty(r.object.master!, 'RRULE')?.value, 'FREQ=WEEKLY;UNTIL=20261103T080000Z');
    assert.equal(propLine(r.object.overrides[0], 'RECURRENCE-ID'), 'RECURRENCE-ID;TZID=Europe/Rome:20261027T090000');
    assert.deepEqual(view(expand(r.object)), ['2026-10-20 09:00 event', '2026-10-26 12:00 override', '2026-11-03 09:00 event']);
  });

  test('da timed ad all-day: RECURRENCE-ID ed EXDATE convertiti in DATE', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'DTEND;TZID=Europe/Rome:20261005T100000', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE;TZID=Europe/Rome:20261006T090000']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261007T090000', 'DTSTART;TZID=Europe/Rome:20261007T150000']),
    );
    const r = shiftSeries(o, { type: 'date', year: 2026, month: 10, day: 5 }, CTX);
    assert.equal(propLine(r.object.master!, 'DTSTART'), 'DTSTART;VALUE=DATE:20261005');
    assert.equal(propLine(r.object.master!, 'DTEND'), 'DTEND;VALUE=DATE:20261006');
    assert.equal(propLine(r.object.master!, 'EXDATE'), 'EXDATE;VALUE=DATE:20261006');
    assert.equal(propLine(r.object.overrides[0], 'RECURRENCE-ID'), 'RECURRENCE-ID;VALUE=DATE:20261007');
    const e = expand(r.object);
    assert.deepEqual(e.occurrences.map((x) => [x.recurrenceKey, x.kind]), [['20261005', 'event'], ['20261007', 'override'], ['20261008', 'event']]);
  });

  test('nessuno spostamento: copia invariata', () => {
    const o = weekly();
    const r = shiftSeries(o, { type: 'date-time', year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } }, CTX);
    assert.equal(serializeObject(r.object), serializeObject(o));
    assert.equal(r.rekeyed.size, 0);
  });
});

describe('tutta la serie: changeRecurrence', () => {
  test('dryRun: orfani previsti senza modifiche; applicata: EXDATE morte tolte, orfani lasciati', () => {
    const o = weekly();
    // Solo lunedì e giovedì: l'override di martedì 20 diventerebbe orfano, l'EXDATE di venerdì 16 morta.
    const dry = changeRecurrence(o, 'FREQ=WEEKLY;BYDAY=MO,TH;COUNT=6', { dryRun: true }, CTX);
    assert.deepEqual(dry.orphanedOverrides, ['20261020T070000Z']);
    assert.deepEqual(dry.staleExdates, ['20261016T070000Z']);
    assert.equal(serializeObject(dry.object), serializeObject(o));
    const real = changeRecurrence(o, 'FREQ=WEEKLY;BYDAY=MO,TH;COUNT=6', {}, CTX);
    assert.equal(getProperty(real.object.master!, 'RRULE')?.value, 'FREQ=WEEKLY;BYDAY=MO,TH;COUNT=6');
    assert.equal(getProperty(real.object.master!, 'EXDATE'), null);
    assert.equal(real.object.overrides.length, 1);
    assert.equal(getProperty(real.object.master!, 'SEQUENCE')?.value, '3');
    assert.ok(expand(real.object).occurrences.some((x) => x.kind === 'orphan_override'));
  });

  test('UNTIL normalizzato al tipo del DTSTART (Radicale rifiuta i tipi misti); RRULE nulla → evento singolo', () => {
    const o = weekly();
    const d = changeRecurrence(o, 'FREQ=DAILY;UNTIL=20261020', {}, CTX);
    assert.equal(getProperty(d.object.master!, 'RRULE')?.value, 'FREQ=DAILY;UNTIL=20261020T215959Z');
    assert.ok(view(expand(d.object)).includes('2026-10-20 15:00 override'));
    const ad = changeRecurrence(objectOf(vevent(['DTSTART;VALUE=DATE:20261005', 'RRULE:FREQ=DAILY;COUNT=3'])), 'FREQ=DAILY;UNTIL=20261009T220000Z', {}, CTX);
    assert.equal(getProperty(ad.object.master!, 'RRULE')?.value, 'FREQ=DAILY;UNTIL=20261010');
    const none = changeRecurrence(o, null, {}, CTX);
    for (const name of ['RRULE', 'RDATE', 'EXDATE']) assert.equal(getProperty(none.object.master!, name), null, name);
    assert.deepEqual(none.orphanedOverrides, ['20261020T070000Z']);
    assert.deepEqual(none.staleExdates, ['20261016T070000Z']);
  });

  test('RRULE non valida o oraria su un all-day → IcsValueError', () => {
    assert.throws(() => changeRecurrence(weekly(), 'FREQ=SPESSO', {}, CTX), IcsValueError);
    assert.throws(() => changeRecurrence(objectOf(vevent(['DTSTART;VALUE=DATE:20261005', 'RRULE:FREQ=DAILY'])), 'FREQ=HOURLY', {}, CTX), IcsValueError);
  });
});

describe('questa e le successive: truncateSeries e splitSeries', () => {
  test('troncamento: UNTIL all\'istante di taglio − 1 s in UTC; override ed EXDATE dal taglio in poi rimossi', () => {
    const o = objectOf(
      vevent(['DTSTART;TZID=Europe/Rome:20261019T090000', 'DTEND;TZID=Europe/Rome:20261019T100000', 'RRULE:FREQ=DAILY', 'EXDATE;TZID=Europe/Rome:20261020T090000,20261030T090000']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261021T090000', 'DTSTART;TZID=Europe/Rome:20261021T120000']),
      vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261028T090000', 'DTSTART;TZID=Europe/Rome:20261028T120000']),
    );
    const t = truncateSeries(o, '20261026T080000Z', CTX);
    assert.ok(t);
    assert.equal(getProperty(t.master!, 'RRULE')?.value, 'FREQ=DAILY;UNTIL=20261026T075959Z');
    assert.equal(propLine(t.master!, 'EXDATE'), 'EXDATE;TZID=Europe/Rome:20261020T090000');
    assert.equal(t.overrides.length, 1);
    const e = expand(t);
    assert.equal(localOf(e.occurrences[e.occurrences.length - 1].startUtc), '2026-10-25 09:00');
    assert.equal(e.rangeEnd, D('2026-10-25', '10:00'));
  });

  test('troncamento: all-day → UNTIL al giorno precedente; COUNT → COUNT ridotto; taglio sulla prima istanza → null', () => {
    const ad = truncateSeries(objectOf(vevent(['DTSTART;VALUE=DATE:20261005', 'RRULE:FREQ=DAILY'])), '20261010', CTX);
    assert.equal(getProperty(ad!.master!, 'RRULE')?.value, 'FREQ=DAILY;UNTIL=20261009');
    const c = truncateSeries(weekly(), '20261022T070000Z', CTX);
    // Istanze della regola prima del 22/10: 12, 13, 15, 16 (esclusa ma contata), 19, 20 → COUNT=6.
    assert.equal(getProperty(c!.master!, 'RRULE')?.value, 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;COUNT=6');
    assert.deepEqual(view(expand(c!)), BASE_VIEW.slice(0, 5));
    assert.equal(truncateSeries(weekly(), '20261012T070000Z', CTX), null);
    // Prima del taglio non resta nulla di visibile (DTSTART escluso): equivale a eliminare la serie.
    const hidden = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'RRULE:FREQ=DAILY', 'EXDATE;TZID=Europe/Rome:20261005T090000']));
    assert.equal(truncateSeries(hidden, '20261006T070000Z', CTX), null);
    assert.throws(() => truncateSeries(weekly(), '20261014T070000Z', CTX), goneError('20261014T070000Z'));
  });

  test('split: testa e coda insieme danno esattamente le occorrenze di prima, con COUNT residuo e override spostati', () => {
    const o = weekly(['RDATE;TZID=Europe/Rome:20261107T090000']);
    const before = expand(o);
    const s = splitSeries(o, '20261019T070000Z', { newUid: 'nuova-serie@caldes.test' }, CTX);
    assert.equal(s.wholeSeries, false);
    const head = s.head;
    const tail = s.tail!;
    assert.equal(getProperty(head.master!, 'RRULE')?.value, 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;COUNT=4');
    assert.equal(head.overrides.length, 0);
    assert.equal(getProperty(head.master!, 'RDATE'), null);
    // Coda: nuovo UID ovunque, DTSTART al taglio, COUNT residuo, RELATED-TO SIBLING, override ed EXDATE/RDATE dal taglio.
    assert.equal(tail.uid, 'nuova-serie@caldes.test');
    const tm = tail.master!;
    assert.equal(getProperty(tm, 'UID')?.value, 'nuova-serie@caldes.test');
    assert.equal(propLine(tm, 'DTSTART'), 'DTSTART;TZID=Europe/Rome:20261019T090000');
    assert.equal(propLine(tm, 'DTEND'), 'DTEND;TZID=Europe/Rome:20261019T100000');
    assert.equal(getProperty(tm, 'RRULE')?.value, 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;COUNT=8');
    assert.equal(propLine(tm, 'RELATED-TO'), 'RELATED-TO;RELTYPE=SIBLING:lmgv@caldes.test');
    assert.equal(propLine(tm, 'RDATE'), 'RDATE;TZID=Europe/Rome:20261107T090000');
    assert.equal(getProperty(tm, 'EXDATE'), null, 'l\'EXDATE del 16 resta alla testa');
    assert.equal(getProperty(tm, 'SEQUENCE')?.value, '0');
    assert.equal(getProperty(tm, 'X-CALDES-LEGACY-ID'), null);
    assert.equal(getSubcomponents(tm, 'VALARM').length, 1);
    assert.equal(tail.overrides.length, 1);
    assert.equal(getProperty(tail.overrides[0], 'UID')?.value, 'nuova-serie@caldes.test');
    assert.equal(propLine(tail.overrides[0], 'RECURRENCE-ID'), 'RECURRENCE-ID;TZID=Europe/Rome:20261020T090000');
    // Equivalenza: stesse occorrenze (istante, fine, tipo) prima e dopo lo split.
    const sig = (r: ExpansionResult): string[] => r.occurrences.map((x) => `${iso(x.startUtc)}|${iso(x.endUtc)}|${x.kind}`);
    assert.deepEqual([...sig(expand(head)), ...sig(expand(tail))].sort(), sig(before).sort());
  });

  test('split con EXDATE dopo il taglio, master all-day, taglio sulla prima istanza', () => {
    const o = objectOf(vevent(['DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006', 'RRULE:FREQ=DAILY;UNTIL=20261015', 'EXDATE;VALUE=DATE:20261003,20261012']));
    const s = splitSeries(o, '20261010', { newUid: 'b@caldes.test' }, CTX);
    assert.equal(getProperty(s.head.master!, 'RRULE')?.value, 'FREQ=DAILY;UNTIL=20261009');
    assert.equal(propLine(s.tail!.master!, 'DTSTART'), 'DTSTART;VALUE=DATE:20261010');
    assert.equal(getProperty(s.tail!.master!, 'RRULE')?.value, 'FREQ=DAILY;UNTIL=20261015');
    assert.equal(propLine(s.tail!.master!, 'EXDATE'), 'EXDATE;VALUE=DATE:20261012');
    assert.deepEqual(expand(s.tail!).occurrences.map((x) => x.startDate), ['2026-10-10', '2026-10-11', '2026-10-13', '2026-10-14', '2026-10-15']);
    const whole = splitSeries(o, '20261005', { newUid: 'c@caldes.test' }, CTX);
    assert.equal(whole.wholeSeries, true);
    assert.equal(whole.tail, null);
    assert.equal(serializeObject(whole.head), serializeObject(o));
    assert.throws(() => splitSeries(o, '20261010', { newUid: ' ' }, CTX), IcsValueError);
  });
});

describe('duplica: duplicateOccurrence', () => {
  test('copia alla data dell\'occorrenza (non del master), dalle proprietà dell\'override se c\'è', () => {
    const o = weekly();
    const plain = duplicateOccurrence(o, '20261027T080000Z', { newUid: 'copia@caldes.test' }, CTX);
    const m = plain.master!;
    assert.equal(propLine(m, 'DTSTART'), 'DTSTART;TZID=Europe/Rome:20261027T090000');
    assert.equal(propLine(m, 'DTEND'), 'DTEND;TZID=Europe/Rome:20261027T100000');
    for (const name of ['RRULE', 'EXDATE', 'RECURRENCE-ID', 'X-CALDES-LEGACY-ID']) assert.equal(getProperty(m, name), null, name);
    assert.equal(getProperty(m, 'UID')?.value, 'copia@caldes.test');
    assert.equal(getProperty(m, 'SEQUENCE')?.value, '0');
    assert.equal(getProperty(m, 'CREATED')?.value, '20261009T100000Z');
    assert.equal(getSubcomponents(m, 'VALARM').length, 1);
    assert.equal(plain.overrides.length, 0);
    assert.deepEqual(view(expand(plain)), ['2026-10-27 09:00 event']);
    const fromOverride = duplicateOccurrence(o, '20261020T070000Z', { newUid: 'copia2@caldes.test' }, CTX);
    assert.equal(getProperty(fromOverride.master!, 'SUMMARY')?.value, 'Studio spostato');
    assert.equal(propLine(fromOverride.master!, 'DTSTART'), 'DTSTART;TZID=Europe/Rome:20261020T150000');
    assert.throws(() => duplicateOccurrence(o, '20261016T070000Z', { newUid: 'x@caldes.test' }, CTX), goneError('20261016T070000Z'));
    const single = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'SUMMARY:Singolo', 'X-CALDES-LEGACY-ID:22222222-2222-4222-8222-222222222222']));
    const dup = duplicateOccurrence(single, MASTER_RECURRENCE_KEY, { newUid: 'y@caldes.test' }, CTX);
    assert.equal(getProperty(dup.master!, 'SUMMARY')?.value, 'Singolo');
    assert.equal(getProperty(dup.master!, 'X-CALDES-LEGACY-ID'), null);
  });
});

describe('errori', () => {
  test('oggetto senza master: operazioni di serie → NO_MASTER', () => {
    const o = objectOf(vevent(['RECURRENCE-ID;TZID=Europe/Rome:20261005T090000', 'DTSTART;TZID=Europe/Rome:20261005T140000']));
    assert.throws(() => materializeOverride(o, '20261005T070000Z', CTX), (e: unknown) => e instanceof RecurrenceTargetError && e.code === 'NO_MASTER');
    assert.throws(() => truncateSeries(o, '20261005T070000Z', CTX), (e: unknown) => e instanceof RecurrenceTargetError && e.code === 'NO_MASTER');
  });

  test('master illeggibile → IcsValueError', () => {
    const o = objectOf(vevent(['DTSTART;TZID=Europe/Rome:20261005T090000', 'RRULE:FREQ=DAILY;BYDAY=ZZ']));
    assert.throws(() => excludeOccurrence(o, '20261006T070000Z', CTX), IcsValueError);
  });
});
