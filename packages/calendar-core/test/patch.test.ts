/**
 * patch.ts: patch lossless per campo (VALARM, ATTENDEE, X-*, parametri e
 * proprietà sconosciute restano), SEQUENCE/LAST-MODIFIED/DTSTAMP secondo il
 * design §5 e §8, noop a contenuto invariato, ritipizzazione timed ↔ all-day,
 * CAS per campo, traduzione dell'update v1 e del diff dello shadow mirror.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyComponentOps,
  applyLegacyUpdate,
  applyPatch,
  buildEventFromLegacy,
  type CalendarObject,
  checkBase,
  cloneCalendarObject,
  createCalendarObject,
  createProperty,
  diffFieldValues,
  fieldValuesEqual,
  getProperties,
  getProperty,
  getSubcomponents,
  getTextValue,
  type IcsComponent,
  expandObject,
  IcsValueError,
  MASTER_RECURRENCE_KEY,
  opsFromLegacyDiff,
  opsFromLegacyUpdate,
  parseCalendarObjectOrThrow,
  PatchConflictError,
  type PatchOp,
  readFieldValues,
  readTimeProperty,
  RecurrenceTargetError,
  serializeComponent,
  serializeObject,
  toLegacyEventFields,
  validateObject,
} from '../src/index';
import { fixture, ics } from './helpers';

const NOW = new Date('2026-10-09T10:00:00Z');
const NOW_STAMP = '20261009T100000Z';
const CTX = { tz: 'Europe/Rome', now: NOW };

function apple(): CalendarObject {
  return parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'));
}

/** Righe serializzate del componente esclusi i nomi dati: per verificare che tutto il resto sia identico. */
function linesWithout(c: IcsComponent, names: string[]): string[] {
  const skip = new Set(names);
  return serializeComponent(c)
    .split('\r\n')
    .filter((l) => {
      const m = /^([A-Z0-9-]+)[;:]/.exec(l);
      return !(m && skip.has(m[1]));
    });
}

describe('applyPatch: preservazione lossless', () => {
  test('cambio del titolo: VALARM, ATTENDEE, X-*, proprietà sconosciute e parametri restano byte per byte', () => {
    const before = apple();
    const res = applyPatch(before, MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'summary', value: 'Visita al Colosseo con Luigi' }], CTX);
    assert.equal(res.noop, false);
    assert.deepEqual(res.changed, ['summary']);
    assert.equal(res.sequenceBumped, false);
    const m = res.object.master as IcsComponent;
    // Il parametro LANGUAGE della SUMMARY resta.
    assert.equal(serializeComponent(m).includes('SUMMARY;LANGUAGE=it:Visita al Colosseo con Luigi'), true);
    // Tutto il resto, VALARM e componenti sconosciuti compresi, è identico.
    assert.deepEqual(
      linesWithout(m, ['SUMMARY', 'DTSTAMP', 'LAST-MODIFIED']),
      linesWithout(before.master as IcsComponent, ['SUMMARY', 'DTSTAMP', 'LAST-MODIFIED']),
    );
    assert.equal(getSubcomponents(m, 'VALARM').length, 2);
    assert.equal(getProperties(m, 'ATTENDEE').length, 2);
    assert.ok(getProperty(m, 'X-APPLE-STRUCTURED-LOCATION'));
    assert.ok(getProperty(m, 'NEWIANAPROP'));
    assert.equal(getSubcomponents(m, 'X-CALDES-CUSTOM').length, 1);
    // DTSTAMP e LAST-MODIFIED a now, SEQUENCE invariata (il titolo non la incrementa).
    assert.equal(getProperty(m, 'DTSTAMP')?.value, NOW_STAMP);
    assert.equal(getProperty(m, 'LAST-MODIFIED')?.value, NOW_STAMP);
    assert.equal(getProperty(m, 'SEQUENCE')?.value, '3');
    // Override, VTIMEZONE e componenti di primo livello invariati; l'oggetto in ingresso non è toccato.
    assert.equal(serializeComponent(res.object.overrides[0]), serializeComponent(before.overrides[0]));
    assert.deepEqual(res.object.otherComponents, before.otherComponents);
    assert.equal(serializeObject(before), serializeObject(apple()));
  });

  test('il serializzato cambia solo nelle righe toccate', () => {
    const before = apple();
    const res = applyPatch(before, MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'description', value: 'Nuova descrizione' }], CTX);
    const a = serializeObject(before).split('\r\n');
    const b = serializeObject(res.object).split('\r\n');
    const removed = a.filter((l) => !b.includes(l));
    const added = b.filter((l) => !a.includes(l));
    // DESCRIPTION (piegata su più righe), DTSTAMP e LAST-MODIFIED del master.
    assert.ok(removed.every((l) => /^(DESCRIPTION|DTSTAMP|LAST-MODIFIED|\s)/.test(l)), removed.join('\n'));
    assert.ok(added.every((l) => /^(DESCRIPTION|DTSTAMP|LAST-MODIFIED)/.test(l)), added.join('\n'));
  });

  test('luogo e stato incrementano SEQUENCE (da 0 se assente)', () => {
    const res = applyPatch(apple(), MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'location', value: 'Foro Romano' }], CTX);
    assert.equal(res.sequenceBumped, true);
    assert.equal(getProperty(res.object.master as IcsComponent, 'SEQUENCE')?.value, '4');
    const noSeq = parseCalendarObjectOrThrow(ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:x', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261012T090000Z', 'DTEND:20261012T100000Z', 'END:VEVENT', 'END:VCALENDAR']));
    const r2 = applyPatch(noSeq, MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'status', value: 'CANCELLED' }], CTX);
    assert.equal(getProperty(r2.object.master as IcsComponent, 'SEQUENCE')?.value, '1');
    assert.equal(getProperty(r2.object.master as IcsComponent, 'STATUS')?.value, 'CANCELLED');
  });

  test('nessuna modifica semantica → noop e oggetto invariato', () => {
    const before = apple();
    const ops: PatchOp[] = [
      { op: 'set', field: 'summary', value: 'Visita al Colosseo con Mario' },
      { op: 'set', field: 'location', value: 'Colosseo\nPiazza del Colosseo, 00184 Roma RM, Italia' },
      { op: 'set', field: 'rrule', value: 'BYDAY=MO;COUNT=10;FREQ=WEEKLY' },
      { op: 'set', field: 'transp', value: 'OPAQUE' },
    ];
    const res = applyPatch(before, MASTER_RECURRENCE_KEY, ops, CTX);
    assert.equal(res.noop, true);
    assert.deepEqual(res.changed, []);
    assert.equal(serializeObject(res.object), serializeObject(before));
    assert.equal(getProperty(res.object.master as IcsComponent, 'DTSTAMP')?.value, '20261001T081500Z');
  });

  test('VALARM: sostituzione esplicita dei soli VALARM, gli altri sottocomponenti restano', () => {
    const res = applyPatch(apple(), MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'alarms', value: [] }], CTX);
    const m = res.object.master as IcsComponent;
    assert.equal(getSubcomponents(m, 'VALARM').length, 0);
    assert.equal(getSubcomponents(m, 'X-CALDES-CUSTOM').length, 1);
    assert.deepEqual(res.changed, ['alarms']);
  });

  test('ATTENDEE invariati in un altro ordine → nessuna modifica', () => {
    const before = apple();
    const attendees = getProperties(before.master as IcsComponent, 'ATTENDEE').reverse();
    assert.equal(applyPatch(before, MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'attendees', value: attendees }], CTX).noop, true);
  });

  test('setProperty su una X-prop: sostituita al suo posto; nome riservato rifiutato', () => {
    const before = apple();
    const res = applyPatch(
      before,
      MASTER_RECURRENCE_KEY,
      [{ op: 'setProperty', name: 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR', properties: [createProperty('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR', 'DISABLED')] }],
      CTX,
    );
    const m = res.object.master as IcsComponent;
    assert.equal(getProperty(m, 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR')?.value, 'DISABLED');
    const idx = (c: IcsComponent): number => c.properties.findIndex((p) => p.name === 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR');
    assert.equal(idx(m), idx(before.master as IcsComponent));
    assert.deepEqual(res.changed, ['X-APPLE-TRAVEL-ADVISORY-BEHAVIOR']);
    assert.throws(
      () => applyPatch(before, MASTER_RECURRENCE_KEY, [{ op: 'setProperty', name: 'DTSTART', properties: [] }], CTX),
      (e: unknown) => e instanceof IcsValueError && e.code === 'INVALID_VALUE',
    );
  });
});

describe('applyPatch: tempi', () => {
  test('nuovo orario: TZID e parametri estranei di DTSTART restano, SEQUENCE+1', () => {
    const before = parseCalendarObjectOrThrow(
      ics([
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:t1', 'DTSTAMP:20260101T000000Z', 'SEQUENCE:2',
        'DTSTART;X-FOO=bar;TZID=Europe/Rome:20261012T090000', 'DTEND;TZID=Europe/Rome:20261012T100000',
        'SUMMARY:A', 'END:VEVENT', 'END:VCALENDAR',
      ]),
    );
    const res = applyPatch(
      before,
      MASTER_RECURRENCE_KEY,
      [
        { op: 'set', field: 'start', value: { type: 'date-time', year: 2026, month: 10, day: 12, hour: 11, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } } },
        { op: 'set', field: 'end', value: { type: 'date-time', year: 2026, month: 10, day: 12, hour: 12, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } } },
      ],
      CTX,
    );
    const m = res.object.master as IcsComponent;
    assert.equal(serializeComponent(m).includes('DTSTART;TZID=Europe/Rome;X-FOO=bar:20261012T110000'), true);
    assert.equal(getProperty(m, 'SEQUENCE')?.value, '3');
    assert.deepEqual(res.changed.sort(), ['end', 'start']);
  });

  test('end toglie DURATION e duration toglie DTEND', () => {
    const withDuration = parseCalendarObjectOrThrow(
      ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:d1', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261012T090000Z', 'DURATION:PT1H', 'END:VEVENT', 'END:VCALENDAR']),
    );
    const r1 = applyPatch(withDuration, MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'end', value: { type: 'date-time', year: 2026, month: 10, day: 12, hour: 11, minute: 0, second: 0, zone: { kind: 'utc' } } }], CTX);
    const m1 = r1.object.master as IcsComponent;
    assert.equal(getProperty(m1, 'DURATION'), null);
    assert.equal(getProperty(m1, 'DTEND')?.value, '20261012T110000Z');
    assert.deepEqual(r1.changed.sort(), ['duration', 'end']);
    const r2 = applyPatch(r1.object, MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'duration', value: { negative: false, weeks: 0, days: 0, hours: 0, minutes: 30, seconds: 0 } }], CTX);
    const m2 = r2.object.master as IcsComponent;
    assert.equal(getProperty(m2, 'DTEND'), null);
    assert.equal(getProperty(m2, 'DURATION')?.value, 'PT30M');
  });

  test('fine non successiva all\'inizio → IcsValueError e componente invariato', () => {
    const before = apple();
    const m = cloneCalendarObject(before).master as IcsComponent;
    const snapshot = serializeComponent(m);
    assert.throws(
      () =>
        applyComponentOps(
          m,
          [{ op: 'set', field: 'end', value: { type: 'date-time', year: 2026, month: 10, day: 12, hour: 8, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } } }],
          { ...CTX, timezones: before.timezones },
        ),
      (e: unknown) => e instanceof IcsValueError && /successiva/.test(e.message),
    );
    assert.equal(serializeComponent(m), snapshot);
    assert.throws(
      () => applyComponentOps(m, [{ op: 'set', field: 'end', value: null }, { op: 'set', field: 'duration', value: { negative: false, weeks: 0, days: 0, hours: 1, minutes: 0, seconds: 0 } }, { op: 'set', field: 'end', value: readTimeProperty(getProperty(m, 'DTEND') as never) }], CTX),
      IcsValueError,
    );
  });

  test('timed → all-day su una serie: EXDATE, UNTIL e RECURRENCE-ID ritipizzati, chiavi degli override rimappate', () => {
    const series = parseCalendarObjectOrThrow(
      ics([
        'BEGIN:VCALENDAR', 'VERSION:2.0',
        'BEGIN:VEVENT', 'UID:s1', 'DTSTAMP:20260101T000000Z',
        'DTSTART;TZID=Europe/Rome:20261012T090000', 'DTEND;TZID=Europe/Rome:20261012T100000',
        'RRULE:FREQ=DAILY;UNTIL=20261031T080000Z', 'EXDATE;TZID=Europe/Rome:20261014T090000', 'SUMMARY:Serie',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'DESCRIPTION:x', 'END:VALARM',
        'END:VEVENT',
        'BEGIN:VEVENT', 'UID:s1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;TZID=Europe/Rome:20261015T090000',
        'DTSTART;TZID=Europe/Rome:20261015T150000', 'DTEND;TZID=Europe/Rome:20261015T160000', 'SUMMARY:Spostata', 'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    const res = applyPatch(
      series,
      MASTER_RECURRENCE_KEY,
      [
        { op: 'set', field: 'start', value: { type: 'date', year: 2026, month: 10, day: 12 } },
        { op: 'set', field: 'end', value: { type: 'date', year: 2026, month: 10, day: 13 } },
      ],
      CTX,
    );
    const m = res.object.master as IcsComponent;
    assert.equal(serializeComponent(m).includes('DTSTART;VALUE=DATE:20261012'), true);
    assert.equal(getProperty(m, 'EXDATE')?.value, '20261014');
    assert.equal(getProperty(m, 'EXDATE')?.params.find((p) => p.name === 'VALUE')?.values[0], 'DATE');
    assert.equal(getProperty(m, 'RRULE')?.value, 'FREQ=DAILY;UNTIL=20261031');
    assert.equal(getSubcomponents(m, 'VALARM').length, 1);
    const ov = res.object.overrides[0];
    assert.equal(getProperty(ov, 'RECURRENCE-ID')?.value, '20261015');
    assert.deepEqual([...(res.rekeyed ?? new Map())], [['20261015T070000Z', '20261015']]);
    assert.ok(res.changed.includes('exdates') && res.changed.includes('rrule'));
    assert.equal(validateObject(res.object, { tz: 'Europe/Rome', now: NOW }).ok, true);

    // E ritorno: all-day → timed alle 09:00 Roma; UNTIL torna un istante UTC (ultima istanza inclusa).
    const back = applyPatch(
      res.object,
      MASTER_RECURRENCE_KEY,
      [
        { op: 'set', field: 'start', value: { type: 'date-time', year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } } },
        { op: 'set', field: 'end', value: { type: 'date-time', year: 2026, month: 10, day: 12, hour: 10, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } } },
      ],
      CTX,
    );
    const mb = back.object.master as IcsComponent;
    assert.equal(getProperty(mb, 'RRULE')?.value, 'FREQ=DAILY;UNTIL=20261031T080000Z');
    assert.equal(serializeComponent(mb).includes('EXDATE;TZID=Europe/Rome:20261014T090000'), true);
    assert.equal(getProperty(back.object.overrides[0], 'RECURRENCE-ID')?.value, '20261015T090000');
    assert.equal(validateObject(back.object, { tz: 'Europe/Rome', now: NOW }).ok, true);
  });
});

describe('applyPatch: target', () => {
  test('override esistente: si modifica solo lui', () => {
    const before = apple();
    const res = applyPatch(before, '20261019T070000Z', [{ op: 'set', field: 'summary', value: 'Spostata ancora' }], CTX);
    assert.equal(getTextValue(res.object.overrides[0], 'SUMMARY'), 'Spostata ancora');
    assert.equal(serializeComponent(res.object.master as IcsComponent), serializeComponent(before.master as IcsComponent));
  });

  test('override con RECURRENCE-ID di tipo diverso dalla chiave: abbinato per data locale', () => {
    const obj = parseCalendarObjectOrThrow(
      ics([
        'BEGIN:VCALENDAR', 'VERSION:2.0',
        'BEGIN:VEVENT', 'UID:a1', 'DTSTAMP:20260101T000000Z', 'DTSTART;VALUE=DATE:20261012', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Tutto il giorno', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:a1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;TZID=Europe/Rome:20261014T000000', 'DTSTART;VALUE=DATE:20261014', 'SUMMARY:Override', 'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    const res = applyPatch(obj, '20261014', [{ op: 'set', field: 'summary', value: 'Override modificato' }], CTX);
    assert.equal(getTextValue(res.object.overrides[0], 'SUMMARY'), 'Override modificato');
  });

  test('la recurrence key di expandObject indica sempre il componente che si vede', () => {
    // Serie timed con un override RECURRENCE-ID DATE (tollerato) e due override duplicati della stessa istanza:
    // l'ombra (SEQUENCE più bassa) viene prima nel file, il vincitore è quello che expandObject mostra.
    const obj = parseCalendarObjectOrThrow(
      ics([
        'BEGIN:VCALENDAR', 'VERSION:2.0',
        'BEGIN:VEVENT', 'UID:k1', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=Europe/Rome:20261012T090000', 'DTEND;TZID=Europe/Rome:20261012T100000', 'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:Serie', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:k1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;VALUE=DATE:20261014', 'DTSTART;TZID=Europe/Rome:20261014T110000', 'DTEND;TZID=Europe/Rome:20261014T120000', 'SUMMARY:Per data', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:k1', 'DTSTAMP:20260101T000000Z', 'SEQUENCE:1', 'RECURRENCE-ID:20261016T070000Z', 'DTSTART;TZID=Europe/Rome:20261016T170000', 'DTEND;TZID=Europe/Rome:20261016T180000', 'SUMMARY:Ombra', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:k1', 'DTSTAMP:20260101T000000Z', 'SEQUENCE:3', 'RECURRENCE-ID;TZID=Europe/Rome:20261016T090000', 'DTSTART;TZID=Europe/Rome:20261016T150000', 'DTEND;TZID=Europe/Rome:20261016T160000', 'SUMMARY:Vincitore', 'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    const occ = expandObject(obj, { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1), tz: 'Europe/Rome' }).occurrences;
    for (const summary of ['Per data', 'Vincitore']) {
      const shown = occ.find((o) => o.source.type === 'override' && getTextValue(obj.overrides[o.source.index], 'SUMMARY') === summary);
      assert.ok(shown, summary);
      const res = applyPatch(obj, shown.recurrenceKey, [{ op: 'set', field: 'location', value: 'Sala B' }], CTX);
      assert.equal(res.object.overrides.length, 3, `${summary}: nessun override nuovo`);
      const touched = res.object.overrides.filter((o) => getTextValue(o, 'LOCATION') === 'Sala B').map((o) => getTextValue(o, 'SUMMARY'));
      assert.deepEqual(touched, [summary]);
    }
  });

  test('evento singolo con override orfano, master illeggibile: l\'override esistente resta modificabile', () => {
    const orphan = parseCalendarObjectOrThrow(
      ics([
        'BEGIN:VCALENDAR', 'VERSION:2.0',
        'BEGIN:VEVENT', 'UID:o1', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261012T080000Z', 'DTEND:20261012T090000Z', 'SUMMARY:Singolo', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:o1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20261020T080000Z', 'DTSTART:20261020T100000Z', 'DTEND:20261020T110000Z', 'SUMMARY:Orfano', 'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    const res = applyPatch(orphan, '20261020T080000Z', [{ op: 'set', field: 'summary', value: 'Orfano modificato' }], CTX);
    assert.equal(getTextValue(res.object.overrides[0], 'SUMMARY'), 'Orfano modificato');
    assert.throws(
      () => applyPatch(orphan, '20261021T080000Z', [{ op: 'set', field: 'summary', value: 'x' }], CTX),
      (e: unknown) => e instanceof RecurrenceTargetError && e.code === 'RECURRENCE_TARGET_GONE',
    );

    const brokenMaster = cloneCalendarObject(orphan);
    (getProperty(brokenMaster.master as IcsComponent, 'DTSTART') as { value: string }).value = 'non-una-data';
    const fixed = applyPatch(brokenMaster, '20261020T080000Z', [{ op: 'set', field: 'summary', value: 'Ancora modificabile' }], CTX);
    assert.equal(getTextValue(fixed.object.overrides[0], 'SUMMARY'), 'Ancora modificabile');
  });

  test('target inesistente con createOverride=false → RECURRENCE_TARGET_GONE; master assente → NO_MASTER', () => {
    assert.throws(
      () => applyPatch(apple(), '20261026T080000Z', [{ op: 'set', field: 'summary', value: 'x' }], { ...CTX, createOverride: false }),
      (e: unknown) => e instanceof RecurrenceTargetError && e.code === 'RECURRENCE_TARGET_GONE',
    );
    const onlyOverride = createCalendarObject({ uid: 'o', master: null, overrides: [apple().overrides[0]] });
    assert.throws(
      () => applyPatch(onlyOverride, MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'summary', value: 'x' }], CTX),
      (e: unknown) => e instanceof RecurrenceTargetError && e.code === 'NO_MASTER',
    );
  });

  test('istanza senza override: materializzata da recurrence-ops, VALARM copiati; noop se le ops non cambiano nulla', () => {
    const before = apple();
    const res = applyPatch(before, '20261026T080000Z', [{ op: 'set', field: 'summary', value: 'Solo questa' }], CTX);
    assert.equal(res.object.overrides.length, 2);
    const created = res.object.overrides.find((o) => getTextValue(o, 'SUMMARY') === 'Solo questa') as IcsComponent;
    assert.ok(created);
    assert.equal(getSubcomponents(created, 'VALARM').length, 2);
    const noop = applyPatch(before, '20261026T080000Z', [{ op: 'set', field: 'summary', value: 'Visita al Colosseo con Mario' }], CTX);
    assert.equal(noop.noop, true);
    assert.equal(noop.object.overrides.length, 1);
  });
});

describe('CAS per campo', () => {
  test('base uguale al corrente → si applica; base diversa → PatchConflictError senza modifiche', () => {
    const before = apple();
    const ok = applyPatch(before, MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'summary', value: 'Nuovo' }], {
      ...CTX,
      base: { summary: 'Visita al Colosseo con Mario', location: 'valore che non conta: campo non toccato' },
    });
    assert.equal(getTextValue(ok.object.master as IcsComponent, 'SUMMARY'), 'Nuovo');
    assert.throws(
      () =>
        applyPatch(before, MASTER_RECURRENCE_KEY, [{ op: 'set', field: 'summary', value: 'Nuovo' }], {
          ...CTX,
          base: { summary: 'Titolo letto prima della modifica del device' },
        }),
      (e: unknown) => {
        assert.ok(e instanceof PatchConflictError);
        assert.equal(e.code, 'PATCH_CONFLICT');
        assert.deepEqual(e.conflicts, [
          { field: 'summary', base: 'Titolo letto prima della modifica del device', theirs: 'Visita al Colosseo con Mario', yours: 'Nuovo' },
        ]);
        return true;
      },
    );
    assert.equal(serializeObject(before), serializeObject(apple()));
  });

  test('checkBase su proprietà grezze e su tempi (stesso istante in un\'altra zona = conflitto)', () => {
    const m = apple().master as IcsComponent;
    const ops: PatchOp[] = [
      { op: 'setProperty', name: 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR', properties: [] },
      { op: 'set', field: 'start', value: { type: 'date-time', year: 2026, month: 10, day: 12, hour: 10, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } } },
    ];
    assert.deepEqual(
      checkBase(m, ops, {
        properties: { 'x-apple-travel-advisory-behavior': [createProperty('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR', 'AUTOMATIC')] },
        start: { type: 'date-time', year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } },
      }),
      [],
    );
    const conflicts = checkBase(m, ops, {
      start: { type: 'date-time', year: 2026, month: 10, day: 12, hour: 7, minute: 0, second: 0, zone: { kind: 'utc' } },
    });
    assert.deepEqual(conflicts.map((c) => c.field), ['start']);
  });
});

describe('confronti e diff', () => {
  test('fieldValuesEqual: RRULE per parti, liste senza ordine, testo con fine riga normalizzati, durate canoniche', () => {
    assert.ok(fieldValuesEqual('rrule', 'FREQ=WEEKLY;BYDAY=MO,TU;INTERVAL=1', 'BYDAY=TU,MO;FREQ=WEEKLY'));
    assert.ok(!fieldValuesEqual('rrule', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2'));
    assert.ok(fieldValuesEqual('categories', ['a', 'b', 'a'], ['b', 'a']));
    assert.ok(fieldValuesEqual('description', 'riga 1\r\nriga 2', 'riga 1\nriga 2'));
    assert.ok(fieldValuesEqual('summary', '', null));
    assert.ok(fieldValuesEqual('duration', { negative: false, weeks: 0, days: 0, hours: 0, minutes: 60, seconds: 0 }, { negative: false, weeks: 0, days: 0, hours: 1, minutes: 0, seconds: 0 }));
    assert.ok(!fieldValuesEqual('duration', { negative: false, weeks: 0, days: 1, hours: 0, minutes: 0, seconds: 0 }, { negative: false, weeks: 0, days: 0, hours: 24, minutes: 0, seconds: 0 }));
    assert.ok(
      !fieldValuesEqual(
        'start',
        { type: 'date-time', year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } },
        { type: 'date-time', year: 2026, month: 10, day: 12, hour: 7, minute: 0, second: 0, zone: { kind: 'utc' } },
      ),
    );
    assert.ok(fieldValuesEqual('exdates', [{ type: 'date', year: 2026, month: 1, day: 2 }, { type: 'date', year: 2026, month: 1, day: 1 }], [{ type: 'date', year: 2026, month: 1, day: 1 }, { type: 'date', year: 2026, month: 1, day: 2 }]));
  });

  test('readFieldValues e diffFieldValues', () => {
    const m = apple().master as IcsComponent;
    const v = readFieldValues(m);
    assert.equal(v.summary, 'Visita al Colosseo con Mario');
    assert.equal(v.transp, 'OPAQUE');
    assert.equal(v.rrule, 'FREQ=WEEKLY;COUNT=10;BYDAY=MO');
    assert.equal(v.alarms?.length, 2);
    assert.equal(v.attendees?.length, 2);
    assert.equal(v.organizer?.name, 'ORGANIZER');
    assert.equal(v.end?.type, 'date-time');
    assert.deepEqual(readFieldValues(m, ['summary', 'status']), { summary: 'Visita al Colosseo con Mario', status: null });
    const ops = diffFieldValues(v, { ...v, summary: 'Altro', categories: ['x'] });
    assert.deepEqual(ops, [
      { op: 'set', field: 'summary', value: 'Altro' },
      { op: 'set', field: 'categories', value: ['x'] },
    ]);
  });
});

describe('opsFromLegacyUpdate (admin v1, MCP)', () => {
  const seriesComponent = (): IcsComponent =>
    buildEventFromLegacy(
      {
        uid: 'series0000000001',
        summary: 'Blocco lavoro',
        location: 'Studio',
        start_time: '2026-09-07T07:00:00.000Z',
        end_time: '2026-09-07T11:00:00.000Z',
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR',
        exdates: ['2026-11-02T08:00:00.000Z'],
      },
      { tz: 'Europe/Rome', now: new Date('2026-09-01T00:00:00Z') },
    );

  test('campi assenti → nessuna op; stessi valori → nessuna op; stringhe vuote → null', () => {
    const c = seriesComponent();
    assert.deepEqual(opsFromLegacyUpdate(c, {}, CTX), []);
    assert.deepEqual(opsFromLegacyUpdate(c, { summary: 'Blocco lavoro', start_time: '2026-09-07T07:00:00Z', end_time: '2026-09-07T11:00:00.000Z' }, CTX), []);
    assert.deepEqual(opsFromLegacyUpdate(c, { location: '', description: null }, CTX), [{ op: 'set', field: 'location', value: null }]);
    assert.deepEqual(opsFromLegacyUpdate(c, { status: 'tentative', calendar_id: 'altro' }, CTX), [{ op: 'set', field: 'status', value: 'TENTATIVE' }]);
  });

  test('nuovo orario di una serie: resta nel TZID del DTSTART, EXDATE dal client normalizzate', () => {
    const c = seriesComponent();
    const ops = opsFromLegacyUpdate(c, { start_time: '2026-09-07T08:00:00.000Z', end_time: '2026-09-07T12:00:00.000Z', exdates: ['2026-11-03T09:00:00.000Z'] }, CTX);
    const byField = Object.fromEntries(ops.map((o) => [o.op === 'set' ? o.field : o.name, o]));
    assert.deepEqual((byField.start as { value: unknown }).value, { type: 'date-time', year: 2026, month: 9, day: 7, hour: 10, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } });
    assert.deepEqual((byField.exdates as { value: unknown }).value, [{ type: 'date-time', year: 2026, month: 11, day: 3, hour: 10, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } }]);
    const res = applyComponentOps(c, ops, CTX);
    assert.equal(res.sequenceBumped, true);
    const fields = toLegacyEventFields(c, { tz: 'Europe/Rome' });
    assert.equal(fields.start_time, '2026-09-07T08:00:00.000Z');
    assert.equal(fields.end_time, '2026-09-07T12:00:00.000Z');
    assert.deepEqual(fields.exdates, ['2026-11-03T09:00:00.000Z']);
  });

  test('all_day attivato: DATE con fine esclusiva, EXDATE e UNTIL esistenti ritipizzati', () => {
    const c = buildEventFromLegacy(
      { uid: 'x', summary: 'Ferie', start_time: '2026-10-12T07:00:00.000Z', end_time: '2026-10-12T08:00:00.000Z', rrule: 'FREQ=DAILY;UNTIL=20261020T070000Z', exdates: ['2026-10-14T07:00:00.000Z'] },
      { tz: 'Europe/Rome', now: NOW },
    );
    const ops = opsFromLegacyUpdate(c, { all_day: true, start_time: '2026-10-11T22:00:00.000Z', end_time: '2026-10-12T22:00:00.000Z' }, CTX);
    applyComponentOps(c, ops, CTX);
    assert.equal(serializeComponent(c).includes('DTSTART;VALUE=DATE:20261012'), true);
    assert.equal(serializeComponent(c).includes('DTEND;VALUE=DATE:20261013'), true);
    assert.equal(getProperty(c, 'EXDATE')?.value, '20261014');
    assert.equal(getProperty(c, 'RRULE')?.value, 'FREQ=DAILY;UNTIL=20261020');
    assert.equal(validateObject(createCalendarObject({ uid: 'x', master: c }), { tz: 'Europe/Rome', now: NOW }).ok, true);
  });

  test('DTSTART in UTC o floating conserva la propria rappresentazione', () => {
    const utc = parseCalendarObjectOrThrow(ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261012T090000Z', 'DTEND:20261012T100000Z', 'END:VEVENT', 'END:VCALENDAR'])).master as IcsComponent;
    const ops = opsFromLegacyUpdate(utc, { start_time: '2026-10-12T08:00:00.000Z' }, CTX);
    assert.deepEqual(ops, [{ op: 'set', field: 'start', value: { type: 'date-time', year: 2026, month: 10, day: 12, hour: 8, minute: 0, second: 0, zone: { kind: 'utc' } } }]);
  });

  test('evento con DURATION: un update che non cambia nulla non trasforma DURATION in DTEND', () => {
    const c = parseCalendarObjectOrThrow(ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:d', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261012T090000Z', 'DURATION:PT1H', 'END:VEVENT', 'END:VCALENDAR'])).master as IcsComponent;
    assert.deepEqual(opsFromLegacyUpdate(c, { start_time: '2026-10-12T09:00:00Z', end_time: '2026-10-12T10:00:00Z' }, CTX), []);
    const moved = opsFromLegacyUpdate(c, { start_time: '2026-10-12T09:30:00Z' }, CTX);
    // Come il legacy, la fine resta ferma: DTEND esplicito al posto di DURATION.
    assert.deepEqual(moved.map((o) => (o.op === 'set' ? o.field : o.name)).sort(), ['end', 'start']);
  });
});

describe('applyLegacyUpdate (update v1 su un componente)', () => {
  test('"solo questa" da admin v1 o MCP: override materializzato, ops calcolate sull\'override, master intatto', () => {
    const before = apple();
    // Istanza del 26/10 (dopo il cambio d'ora: 09:00 Europe/Rome = 08:00Z), senza override.
    const res = applyLegacyUpdate(before, '20261026T080000Z', { start_time: '2026-10-26T10:00:00.000Z', end_time: '2026-10-26T11:30:00.000Z' }, CTX);
    assert.equal(res.noop, false);
    assert.deepEqual(res.ops.map((o) => (o.op === 'set' ? o.field : o.name)).sort(), ['end', 'start']);
    const created = res.object.overrides.find((o) => getProperty(o, 'RECURRENCE-ID')?.value === '20261026T090000') as IcsComponent;
    assert.ok(created);
    assert.equal(getProperty(created, 'DTSTART')?.value, '20261026T110000');
    assert.deepEqual(getProperty(created, 'DTSTART')?.params, [{ name: 'TZID', values: ['Europe/Rome'] }]);
    assert.equal(getProperty(created, 'DTEND')?.value, '20261026T123000');
    assert.equal(getSubcomponents(created, 'VALARM').length, 2);
    assert.equal(getTextValue(created, 'SUMMARY'), 'Visita al Colosseo con Mario');
    assert.equal(serializeComponent(res.object.master as IcsComponent), serializeComponent(before.master as IcsComponent));
    // Nessun errore nuovo: resta solo il componente estraneo di primo livello della fixture Apple.
    const errors = validateObject(res.object, { tz: 'Europe/Rome', now: NOW, previous: before }).issues.filter((i) => i.severity === 'error');
    assert.deepEqual(errors.map((i) => i.code), ['COMPONENT_NOT_ALLOWED']);
  });

  test('stessi valori dell\'istanza → noop, nessun override materializzato', () => {
    const before = apple();
    const same = applyLegacyUpdate(
      before,
      '20261026T080000Z',
      { start_time: '2026-10-26T08:00:00.000Z', end_time: '2026-10-26T09:30:00.000Z', summary: 'Visita al Colosseo con Mario' },
      CTX,
    );
    assert.equal(same.noop, true);
    assert.deepEqual(same.ops, []);
    assert.equal(same.object.overrides.length, before.overrides.length);
  });

  test('override esistente: le ops partono dai suoi valori, non da quelli del master', () => {
    const before = apple();
    // L'override del 19/10 è già alle 15:00-16:30: riscrivere quegli orari non cambia nulla.
    const res = applyLegacyUpdate(before, '20261019T070000Z', { start_time: '2026-10-19T13:00:00.000Z', end_time: '2026-10-19T14:30:00.000Z', location: 'Foro Romano' }, CTX);
    assert.deepEqual(res.ops.map((o) => (o.op === 'set' ? o.field : o.name)), ['location']);
    assert.equal(getTextValue(res.object.overrides[0], 'LOCATION'), 'Foro Romano');
  });
});

describe('opsFromLegacyDiff (shadow mirror)', () => {
  test('modifica legacy del solo titolo su un oggetto con VALARM e luogo cambiato dal device → solo il titolo', () => {
    const obj = apple();
    const m = obj.master as IcsComponent;
    const radicaleNow = toLegacyEventFields(m, { tz: 'Europe/Rome', timezones: obj.timezones });
    // Lo snapshot legacy aveva un altro luogo: il device lo ha cambiato in Radicale, il legacy no.
    const before = { ...radicaleNow, location: 'Luogo vecchio' };
    const after = { ...before, summary: 'Titolo dal legacy' };
    const ops = opsFromLegacyDiff(m, before, after, { ...CTX, timezones: obj.timezones });
    assert.deepEqual(ops, [{ op: 'set', field: 'summary', value: 'Titolo dal legacy' }]);
    const res = applyPatch(obj, MASTER_RECURRENCE_KEY, ops, CTX);
    const nm = res.object.master as IcsComponent;
    assert.equal(getTextValue(nm, 'SUMMARY'), 'Titolo dal legacy');
    assert.equal(getTextValue(nm, 'LOCATION'), radicaleNow.location);
    assert.equal(getSubcomponents(nm, 'VALARM').length, 2);
    assert.equal(getProperties(nm, 'ATTENDEE').length, 2);
  });

  test('nessuna differenza fra before e after → nessuna op', () => {
    const m = apple().master as IcsComponent;
    const f = toLegacyEventFields(m, { tz: 'Europe/Rome' });
    assert.deepEqual(opsFromLegacyDiff(m, f, { ...f, start_time: new Date(f.start_time).toISOString() }, CTX), []);
  });
});
