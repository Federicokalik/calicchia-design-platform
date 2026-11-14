/**
 * rrule-summary.ts: riepilogo in italiano delle RRULE (F6, contratto
 * f6-modules.md §5.5), puro e senza ical.js.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeRrule, type IcsTime } from '../src/index';

const TZ = 'Europe/Rome';
/** Giovedì 15 ottobre 2026, 09:00 a Roma. */
const START: IcsTime = { type: 'date-time', year: 2026, month: 10, day: 15, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: TZ } };
/** Sabato 3 gennaio 2026 (all-day). */
const ALL_DAY: IcsTime = { type: 'date', year: 2026, month: 1, day: 3 };

function d(rrule: string, start: IcsTime = START): string {
  return describeRrule(rrule, start, { tz: TZ });
}

describe('describeRrule: frequenze', () => {
  test('DAILY', () => {
    assert.equal(d('FREQ=DAILY'), 'Ogni giorno');
    assert.equal(d('FREQ=DAILY;INTERVAL=3'), 'Ogni 3 giorni');
    assert.equal(d('RRULE:FREQ=DAILY'), 'Ogni giorno', 'il prefisso RRULE: si ignora');
  });

  test('DAILY con BYDAY: giorni feriali o elenco', () => {
    assert.equal(d('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'), 'Ogni giorno feriale');
    assert.equal(d('FREQ=DAILY;BYDAY=MO,TH'), 'Ogni giorno, il lunedì e il giovedì');
  });

  test('WEEKLY con più BYDAY e INTERVAL (esempio del contratto)', () => {
    assert.equal(d('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20261231'), 'Ogni 2 settimane il lunedì e il giovedì, fino al 31 dicembre 2026');
    assert.equal(d('FREQ=WEEKLY;BYDAY=MO,WE,SU'), 'Ogni settimana il lunedì, il mercoledì e la domenica');
  });

  test('WEEKLY senza BYDAY usa il giorno dell\'inizio', () => {
    assert.equal(d('FREQ=WEEKLY'), 'Ogni settimana il giovedì');
    assert.equal(d('FREQ=WEEKLY;INTERVAL=4', ALL_DAY), 'Ogni 4 settimane il sabato');
  });

  test('WEEKLY: giorni feriali, intervalli di giorni e tutta la settimana', () => {
    assert.equal(d('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'), 'Ogni giorno feriale');
    assert.equal(d('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR'), 'Ogni 2 settimane dal lunedì al venerdì');
    assert.equal(d('FREQ=WEEKLY;BYDAY=MO,TU,WE'), 'Ogni settimana dal lunedì al mercoledì');
    assert.equal(d('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU'), 'Ogni giorno');
  });

  test('MONTHLY per BYMONTHDAY', () => {
    assert.equal(d('FREQ=MONTHLY;BYMONTHDAY=15'), 'Ogni mese il giorno 15');
    assert.equal(d('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1,15'), 'Ogni 3 mesi il giorno 1 e 15');
    assert.equal(d('FREQ=MONTHLY;BYMONTHDAY=-1'), 'Ogni mese l\'ultimo giorno del mese');
    assert.equal(d('FREQ=MONTHLY'), 'Ogni mese il giorno 15');
  });

  test('MONTHLY per BYDAY con ordinale o BYSETPOS', () => {
    assert.equal(d('FREQ=MONTHLY;BYDAY=1MO'), 'Ogni mese il primo lunedì');
    assert.equal(d('FREQ=MONTHLY;BYDAY=2TU,4TU'), 'Ogni mese il secondo martedì e il quarto martedì');
    assert.equal(d('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1'), 'Ogni mese l\'ultimo venerdì');
    assert.equal(d('FREQ=MONTHLY;BYDAY=-1SU'), 'Ogni mese l\'ultima domenica');
    assert.equal(d('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'), 'Ogni mese l\'ultimo giorno feriale');
    assert.equal(d('FREQ=MONTHLY;BYDAY=SA'), 'Ogni mese, tutti i sabati');
  });

  test('YEARLY', () => {
    assert.equal(d('FREQ=YEARLY'), 'Ogni anno il 15 ottobre');
    assert.equal(d('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1'), 'Ogni anno il 1° marzo');
    assert.equal(d('FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYDAY=1MO'), 'Ogni 2 anni il primo lunedì di marzo');
    assert.equal(d('FREQ=YEARLY;BYMONTH=6,9;BYMONTHDAY=5'), 'Ogni anno il 5 di giugno e settembre');
  });

  test('HOURLY', () => {
    assert.equal(d('FREQ=HOURLY'), 'Ogni ora');
    assert.equal(d('FREQ=HOURLY;INTERVAL=4'), 'Ogni 4 ore');
  });
});

describe('describeRrule: fine della serie', () => {
  test('COUNT', () => {
    assert.equal(d('FREQ=DAILY;COUNT=5'), 'Ogni giorno, per 5 volte');
    assert.equal(d('FREQ=WEEKLY;COUNT=1'), 'Ogni settimana il giovedì, una volta sola');
  });

  test('UNTIL DATE', () => {
    assert.equal(d('FREQ=DAILY;UNTIL=20270101', ALL_DAY), 'Ogni giorno, fino al 1° gennaio 2027');
  });

  test('UNTIL UTC: la data è quella locale del calendario', () => {
    // 2026-12-31T23:30:00Z è già il 1° gennaio 2027 a Roma.
    assert.equal(d('FREQ=DAILY;UNTIL=20261231T233000Z'), 'Ogni giorno, fino al 1° gennaio 2027');
    assert.equal(d('FREQ=DAILY;UNTIL=20261231T100000Z'), 'Ogni giorno, fino al 31 dicembre 2026');
  });

  test('UNTIL floating: la data così com\'è', () => {
    assert.equal(d('FREQ=DAILY;UNTIL=20261231T233000'), 'Ogni giorno, fino al 31 dicembre 2026');
  });
});

describe('describeRrule: ricorrenza personalizzata', () => {
  test('regola non interpretabile', () => {
    assert.equal(d('FREQ=BOH'), 'Ricorrenza personalizzata (FREQ=BOH)');
    assert.equal(d(''), 'Ricorrenza personalizzata ()');
  });

  test('parti non descrivibili', () => {
    assert.equal(d('FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO'), 'Ricorrenza personalizzata (FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO)');
    assert.equal(d('FREQ=DAILY;BYHOUR=9,17'), 'Ricorrenza personalizzata (FREQ=DAILY;BYHOUR=9,17)');
    assert.equal(d('FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1'), 'Ricorrenza personalizzata (FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1)');
    assert.equal(d('FREQ=SECONDLY'), 'Ricorrenza personalizzata (FREQ=SECONDLY)');
  });
});
