/**
 * Semantica degli scope della v2 (lib/calendar/v2/series.ts; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §3.3, §3.7, §3.8, §5.4),
 * senza database né Radicale.
 *
 * Casi: toCoreOps (set_property → setProperty, nomi riservati); scope `this`
 * (materializzazione dell'override, divieto dei campi di serie, istanza non
 * più presente, noop); scope `all` da master e da istanza (spostamento Δ
 * della serie con RECURRENCE-ID, durata, propagazione agli override non
 * personalizzati, cambio di RRULE con override orfani); conflictingKeys
 * (campi disgiunti, valore già uguale, base mancante, proprietà non
 * tipizzate); planScopedDelete (tre scope, prima istanza, ultima istanza,
 * scope non ammessi); planThisAndFuture (prima istanza = intera serie, coda
 * con le op e RELATED-TO).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  type CalendarObject,
  expandObject,
  getProperty,
  type IcsComponent,
  parseCalendarObject,
  readFieldValues,
  RecurrenceTargetError,
  serializeObject,
  validateObject,
} from '@calicchia/calendar-core';
import type { CalV2Op } from '@calicchia/shared';
import { CalendarV2Error } from '../../src/lib/calendar/v2/errors';
import {
  applyOpsToNewSeries,
  applyScopedPatch,
  conflictingKeys,
  planScopedDelete,
  planThisAndFuture,
  toCoreOps,
} from '../../src/lib/calendar/v2/series';
import { tokenFor } from '../../src/lib/calendar/v2/view';

const TZ = 'Europe/Rome';
const NOW = new Date('2027-02-01T10:00:00Z');
const CTX = { tz: TZ, now: NOW };

/** Lunedì 2027-03-01 09:00 a Roma = 08:00Z (CET); dal 28 marzo CEST (07:00Z). */
const K_0301 = '20270301T080000Z';
const K_0308 = '20270308T080000Z';
const K_0315 = '20270315T080000Z';
const K_0322 = '20270322T080000Z';
const K_0329 = '20270329T070000Z';

function lines(...rows: string[]): string {
  return `${rows.join('\r\n')}\r\n`;
}

const HEAD = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN'];
const FOOT = ['END:VCALENDAR'];

function overrideLines(date: string, start: string, end: string, summary: string): string[] {
  return [
    'BEGIN:VEVENT',
    'UID:serie-1@test',
    'DTSTAMP:20270101T000000Z',
    `RECURRENCE-ID;TZID=Europe/Rome:${date}T090000`,
    `DTSTART;TZID=Europe/Rome:${date}T${start}`,
    `DTEND;TZID=Europe/Rome:${date}T${end}`,
    `SUMMARY:${summary}`,
    'LOCATION:Aula 1',
    'END:VEVENT',
  ];
}

/** Serie settimanale del lunedì (6 istanze), un override non personalizzato (8/3, spostato alle 10) e uno personalizzato (15/3). */
function series(opts: { count?: number } = {}): CalendarObject {
  const raw = lines(
    ...HEAD,
    'BEGIN:VEVENT',
    'UID:serie-1@test',
    'DTSTAMP:20270101T000000Z',
    'SEQUENCE:0',
    'SUMMARY:Studio',
    'LOCATION:Aula 1',
    'DTSTART;TZID=Europe/Rome:20270301T090000',
    'DTEND;TZID=Europe/Rome:20270301T100000',
    `RRULE:FREQ=WEEKLY;COUNT=${opts.count ?? 6};BYDAY=MO`,
    'X-CUSTOM:uno',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT10M',
    'DESCRIPTION:Studio',
    'END:VALARM',
    'END:VEVENT',
    ...overrideLines('20270308', '100000', '110000', 'Studio'),
    ...overrideLines('20270315', '090000', '100000', 'Speciale'),
    ...FOOT,
  );
  return parse(raw);
}

function single(): CalendarObject {
  return parse(lines(...HEAD, 'BEGIN:VEVENT', 'UID:singolo@test', 'DTSTAMP:20270101T000000Z', 'SUMMARY:Singolo', 'DTSTART;TZID=Europe/Rome:20270305T090000', 'DTEND;TZID=Europe/Rome:20270305T100000', ...['END:VEVENT'], ...FOOT));
}

function parse(raw: string): CalendarObject {
  const res = parseCalendarObject(raw);
  assert.ok(res.ok, res.ok ? '' : res.error.message);
  return res.value;
}

const set = <F extends string>(field: F, value: unknown): CalV2Op => ({ op: 'set', field, value }) as unknown as CalV2Op;
const local = (date: string, hh: number, mm = 0) => {
  const [year, month, day] = date.split('-').map(Number);
  return { type: 'date-time', year, month, day, hour: hh, minute: mm, second: 0, zone: { kind: 'tzid', tzid: TZ } } as const;
};

function fieldsOf(c: IcsComponent) {
  return readFieldValues(c);
}

function overrideAt(obj: CalendarObject, date: string): IcsComponent {
  const found = obj.overrides.find((o) => getProperty(o, 'RECURRENCE-ID')?.value.startsWith(date));
  assert.ok(found, `override del ${date}`);
  return found;
}

/** L'oggetto risultante è valido e si serializza. */
function assertValid(obj: CalendarObject): void {
  const res = validateObject(obj, { tz: TZ, now: NOW });
  assert.ok(res.ok, res.issues.map((i) => i.message).join('; '));
  assert.ok(serializeObject(obj).startsWith('BEGIN:VCALENDAR'));
}

function starts(obj: CalendarObject): Array<[string, string | null]> {
  const res = expandObject(obj, { from: Date.UTC(2027, 0, 1), to: Date.UTC(2027, 11, 31), tz: TZ });
  return res.occurrences.map((o) => [new Date(o.startUtc).toISOString(), o.kind === 'override' ? 'override' : null]);
}

describe('toCoreOps', () => {
  test('set passa così com\'è, set_property diventa setProperty', () => {
    const ops = toCoreOps([
      set('summary', 'Ciao'),
      { op: 'set_property', name: 'X-FOO', properties: [{ name: 'X-FOO', params: [{ name: 'X-P', values: ['1'] }], value: 'bar' }] },
    ]);
    assert.deepEqual(ops[0], { op: 'set', field: 'summary', value: 'Ciao' });
    assert.deepEqual(ops[1], { op: 'setProperty', name: 'X-FOO', properties: [{ name: 'X-FOO', params: [{ name: 'X-P', values: ['1'] }], value: 'bar' }] });
  });

  test('nomi riservati, non validi o con proprietà di un altro nome → VALIDATION_FAILED', () => {
    for (const name of ['SUMMARY', 'RRULE', 'UID', 'CREATED', 'LAST-MODIFIED', 'sequence', 'X FOO', '1ABC']) {
      assert.throws(() => toCoreOps([{ op: 'set_property', name, properties: [] }]), (e: unknown) => e instanceof CalendarV2Error && e.code === 'VALIDATION_FAILED', name);
    }
    assert.throws(() => toCoreOps([{ op: 'set_property', name: 'X-A', properties: [{ name: 'X-B', params: [], value: '' }] }]), CalendarV2Error);
  });
});

describe('scope this', () => {
  test('materializza l\'override con RECURRENCE-ID dello stesso tipo e TZID; il master non cambia', () => {
    const obj = series();
    const res = applyScopedPatch(obj, K_0322, 'this', [set('summary', 'Solo questa')], CTX);
    assert.equal(res.noop, false);
    assert.deepEqual(res.changed, ['summary']);
    assert.equal(res.sequenceBumped, false);
    assert.equal(res.targetKey, K_0322);
    assert.equal(res.object.overrides.length, 3);
    const created = overrideAt(res.object, '20270322');
    assert.equal(getProperty(created, 'RECURRENCE-ID')?.params.find((p) => p.name === 'TZID')?.values[0], TZ);
    assert.equal(fieldsOf(created).summary, 'Solo questa');
    assert.equal(fieldsOf(created).location, 'Aula 1', 'il resto è la copia del master');
    assert.equal(fieldsOf(res.object.master as IcsComponent).summary, 'Studio');
    assert.equal(obj.overrides.length, 2, 'l\'oggetto di partenza non cambia');
    assertValid(res.object);
  });

  test('un campo che cambia la pianificazione incrementa SEQUENCE', () => {
    const res = applyScopedPatch(series(), K_0322, 'this', [set('location', 'Aula 2')], CTX);
    assert.equal(res.sequenceBumped, true);
    assert.equal(getProperty(overrideAt(res.object, '20270322'), 'SEQUENCE')?.value, '1');
  });

  test('stesso valore: noop e nessun override creato', () => {
    const res = applyScopedPatch(series(), K_0322, 'this', [set('summary', 'Studio')], CTX);
    assert.equal(res.noop, true);
    assert.equal(res.object.overrides.length, 2);
  });

  test('rrule, rdates ed exdates → SCOPE_INVALID; dal master e istanza inesistente → errori', () => {
    const obj = series();
    for (const op of [set('rrule', 'FREQ=DAILY'), set('rdates', []), set('exdates', [])]) {
      assert.throws(() => applyScopedPatch(obj, K_0322, 'this', [op], CTX), (e: unknown) => e instanceof CalendarV2Error && e.code === 'SCOPE_INVALID');
    }
    assert.throws(() => applyScopedPatch(obj, '', 'this', [set('summary', 'x')], CTX), (e: unknown) => e instanceof CalendarV2Error && e.code === 'SCOPE_INVALID');
    assert.throws(
      () => applyScopedPatch(obj, '20270302T080000Z', 'this', [set('summary', 'x')], CTX),
      (e: unknown) => e instanceof RecurrenceTargetError && e.code === 'RECURRENCE_TARGET_GONE',
    );
  });

  test('un evento singolo ammette solo all', () => {
    assert.throws(() => applyScopedPatch(single(), '', 'this', [set('summary', 'x')], CTX), (e: unknown) => e instanceof CalendarV2Error && e.code === 'SCOPE_INVALID');
    const res = applyScopedPatch(single(), '', 'all', [set('summary', 'Rinominato')], CTX);
    assert.equal(fieldsOf(res.object.master as IcsComponent).summary, 'Rinominato');
  });
});

describe('scope all', () => {
  test('dal master: il campo si propaga agli override non personalizzati, non a quelli personalizzati', () => {
    const res = applyScopedPatch(series(), '', 'all', [set('summary', 'Studio avanzato')], CTX);
    assert.deepEqual(res.changed, ['summary']);
    assert.equal(res.noop, false);
    assert.equal(fieldsOf(res.object.master as IcsComponent).summary, 'Studio avanzato');
    assert.equal(fieldsOf(overrideAt(res.object, '20270308')).summary, 'Studio avanzato', 'non personalizzato: segue il master');
    assert.equal(fieldsOf(overrideAt(res.object, '20270315')).summary, 'Speciale', 'personalizzato: resta');
    assert.equal(fieldsOf(overrideAt(res.object, '20270308')).location, 'Aula 1');
    assertValid(res.object);
    // Un secondo invio dello stesso valore non cambia nulla.
    assert.equal(applyScopedPatch(res.object, '', 'all', [set('summary', 'Studio avanzato')], CTX).noop, true);
  });

  test('da un\'istanza senza override: i campi non temporali vanno al master e non creano override', () => {
    const res = applyScopedPatch(series(), K_0322, 'all', [set('description', 'Note per tutti')], CTX);
    assert.equal(fieldsOf(res.object.master as IcsComponent).description, 'Note per tutti');
    assert.equal(res.object.overrides.length, 2);
  });

  test('da un override esistente: il campo arriva anche al suo override, personalizzato o no', () => {
    const res = applyScopedPatch(series(), K_0315, 'all', [set('summary', 'Per tutti')], CTX);
    assert.equal(fieldsOf(res.object.master as IcsComponent).summary, 'Per tutti');
    assert.equal(fieldsOf(overrideAt(res.object, '20270315')).summary, 'Per tutti');
    assert.equal(fieldsOf(overrideAt(res.object, '20270308')).summary, 'Per tutti');
  });

  test('proprietà non tipizzate: si applicano al master; le assenti negli override non si propagano', () => {
    const res = applyScopedPatch(
      series(),
      '',
      'all',
      [{ op: 'set_property', name: 'X-CUSTOM', properties: [{ name: 'X-CUSTOM', params: [], value: 'due' }] }],
      CTX,
    );
    assert.deepEqual(res.changed, ['prop:X-CUSTOM']);
    assert.equal(getProperty(res.object.master as IcsComponent, 'X-CUSTOM')?.value, 'due');
    assert.equal(getProperty(overrideAt(res.object, '20270308'), 'X-CUSTOM'), null);
  });

  test('da un\'istanza: start ed end diventano lo spostamento Δ della serie e la durata del master', () => {
    const obj = series();
    const res = applyScopedPatch(obj, K_0322, 'all', [set('start', local('2027-03-22', 10)), set('end', local('2027-03-22', 11, 30))], CTX);
    assert.deepEqual([...res.changed].sort(), ['end', 'start']);
    assert.equal(res.sequenceBumped, true);
    const master = fieldsOf(res.object.master as IcsComponent);
    assert.deepEqual(master.start, local('2027-03-01', 10));
    assert.deepEqual(master.end, local('2027-03-01', 11, 30));
    // RECURRENCE-ID degli override spostati dello stesso Δ; gli orari propri degli override restano.
    const moved = overrideAt(res.object, '20270308');
    assert.equal(getProperty(moved, 'RECURRENCE-ID')?.value, '20270308T100000');
    assert.deepEqual(fieldsOf(moved).start, local('2027-03-08', 10));
    assert.deepEqual(fieldsOf(moved).end, local('2027-03-08', 11));
    assert.equal(res.orphanedOverrides.length, 0);
    assertValid(res.object);
    const occ = starts(res.object);
    assert.equal(occ[0][0], '2027-03-01T09:00:00.000Z', 'prima istanza alle 10:00 di Roma');
    assert.ok(occ.some(([iso]) => iso === '2027-03-22T09:00:00.000Z'), 'l\'istanza modificata è alle 10:00');
  });

  test('da un\'istanza: solo end → solo la durata del master', () => {
    const res = applyScopedPatch(series(), K_0322, 'all', [set('end', local('2027-03-22', 11))], CTX);
    assert.deepEqual(res.changed, ['end']);
    const master = fieldsOf(res.object.master as IcsComponent);
    assert.deepEqual(master.start, local('2027-03-01', 9));
    assert.deepEqual(master.end, local('2027-03-01', 11), 'durata di 2 ore sul master');
  });

  test('da un\'istanza: master con DURATION → la durata nuova va su DURATION', () => {
    const raw = lines(...HEAD, 'BEGIN:VEVENT', 'UID:d@test', 'DTSTAMP:20270101T000000Z', 'SUMMARY:D', 'DTSTART;TZID=Europe/Rome:20270301T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=4', 'END:VEVENT', ...FOOT);
    const res = applyScopedPatch(parse(raw), K_0308, 'all', [set('end', local('2027-03-08', 10, 30))], CTX);
    const master = fieldsOf(res.object.master as IcsComponent);
    assert.equal(master.end, null);
    assert.deepEqual(master.duration, { negative: false, weeks: 0, days: 0, hours: 1, minutes: 30, seconds: 0 });
  });

  test('cambio di RRULE: gli override che non trovano più l\'istanza sono orfani', () => {
    const res = applyScopedPatch(series(), '', 'all', [set('rrule', 'FREQ=WEEKLY;COUNT=2;BYDAY=MO')], CTX);
    assert.deepEqual(res.changed, ['rrule']);
    assert.deepEqual(res.orphanedOverrides, [K_0315]);
    assert.equal(fieldsOf(res.object.master as IcsComponent).rrule, 'FREQ=WEEKLY;COUNT=2;BYDAY=MO');
    assert.equal(res.object.overrides.length, 2, 'gli orfani restano dove sono');
  });

  test('l\'evento singolo si sposta senza serie', () => {
    const res = applyScopedPatch(single(), '', 'all', [set('start', local('2027-03-05', 11)), set('end', local('2027-03-05', 12))], CTX);
    assert.deepEqual(fieldsOf(res.object.master as IcsComponent).start, local('2027-03-05', 11));
    assert.equal(res.sequenceBumped, true);
  });

  test('l\'oggetto con soli override ammette solo this', () => {
    const only = parse(lines(...HEAD, ...overrideLines('20270308', '100000', '110000', 'Solo invito'), ...FOOT));
    assert.throws(() => applyScopedPatch(only, K_0308, 'all', [set('summary', 'x')], CTX), (e: unknown) => e instanceof CalendarV2Error && e.code === 'SCOPE_INVALID');
    const res = applyScopedPatch(only, K_0308, 'this', [set('summary', 'Rinominato')], CTX);
    assert.equal(fieldsOf(res.object.overrides[0]).summary, 'Rinominato');
  });
});

describe('conflictingKeys (§3.3)', () => {
  const obj = series();
  const master = obj.master as IcsComponent;
  const stale = (key: string) => ({ [key]: '0000000000000000' });

  test('base uguale al token corrente: nessun conflitto', () => {
    assert.deepEqual(conflictingKeys(obj, '', 'all', [set('summary', 'Altro')], { summary: tokenFor(master, 'summary') }, CTX), []);
  });

  test('campi disgiunti: la base di un campo non toccato da altri non confligge', () => {
    // Il server ha cambiato la località; l'admin tocca solo il titolo con la base del titolo.
    assert.deepEqual(conflictingKeys(obj, '', 'all', [set('summary', 'Altro')], { summary: tokenFor(master, 'summary') }, CTX), []);
  });

  test('stesso campo cambiato altrove: conflitto con i valori wire', () => {
    const conflicts = conflictingKeys(obj, '', 'all', [set('summary', 'Mio titolo')], stale('summary'), CTX);
    assert.deepEqual(conflicts, [{ field: 'summary', theirs: 'Studio', yours: 'Mio titolo' }]);
  });

  test('il server ha già il valore richiesto: nessun conflitto (un nuovo invio è un noop)', () => {
    assert.deepEqual(conflictingKeys(obj, '', 'all', [set('summary', 'Studio')], stale('summary'), CTX), []);
  });

  test('chiave assente da base: conflitto se la op cambierebbe ancora il valore', () => {
    assert.equal(conflictingKeys(obj, '', 'all', [set('location', 'Aula 9')], {}, CTX).length, 1);
    assert.equal(conflictingKeys(obj, '', 'all', [set('location', 'Aula 1')], {}, CTX).length, 0);
  });

  test('proprietà non tipizzate e proprietà assente (CAL_V2_ABSENT_TOKEN)', () => {
    const op: CalV2Op = { op: 'set_property', name: 'X-CUSTOM', properties: [{ name: 'X-CUSTOM', params: [], value: 'tre' }] };
    const conflicts = conflictingKeys(obj, '', 'all', [op], { 'prop:X-CUSTOM': '-' }, CTX);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].field, 'prop:X-CUSTOM');
    assert.deepEqual(conflicts[0].theirs, [{ name: 'X-CUSTOM', params: [], value: 'uno' }]);
    assert.deepEqual(conflicts[0].yours, op.op === 'set_property' ? op.properties : null);
    assert.deepEqual(conflictingKeys(obj, '', 'all', [op], { 'prop:X-CUSTOM': tokenFor(master, 'prop:X-CUSTOM') }, CTX), []);
    const absent: CalV2Op = { op: 'set_property', name: 'X-NUOVA', properties: [{ name: 'X-NUOVA', params: [], value: 'a' }] };
    assert.deepEqual(conflictingKeys(obj, '', 'all', [absent], { 'prop:X-NUOVA': '-' }, CTX), []);
  });

  test('i token sono quelli del target: per un\'istanza senza override, la pre-immagine', () => {
    const pre = (obj.master as IcsComponent) && conflictingKeys(obj, K_0322, 'this', [set('summary', 'x')], { summary: tokenFor(master, 'summary') }, CTX);
    assert.deepEqual(pre, [], 'la pre-immagine ha il titolo del master');
    const custom = conflictingKeys(obj, K_0315, 'this', [set('summary', 'x')], { summary: tokenFor(master, 'summary') }, CTX);
    assert.equal(custom.length, 1, 'l\'override personalizzato ha un titolo diverso');
    assert.equal(custom[0].theirs, 'Speciale');
  });

  test('istanza non più presente → RECURRENCE_TARGET_GONE', () => {
    assert.throws(() => conflictingKeys(obj, '20270302T080000Z', 'this', [set('summary', 'x')], {}, CTX), RecurrenceTargetError);
  });
});

describe('planScopedDelete (§3.7)', () => {
  test('all: elimina la risorsa', () => {
    assert.deepEqual(planScopedDelete(series(), K_0322, 'all', CTX), { action: 'delete' });
    assert.deepEqual(planScopedDelete(single(), '', 'all', CTX), { action: 'delete' });
  });

  test('this: EXDATE tipizzato e override rimosso', () => {
    const res = planScopedDelete(series(), K_0308, 'this', CTX);
    assert.equal(res.action, 'put');
    if (res.action !== 'put') return;
    assert.equal(res.object.overrides.length, 1, 'l\'override dell\'8/3 è sparito');
    const exdates = fieldsOf(res.object.master as IcsComponent).exdates;
    assert.deepEqual(exdates, [local('2027-03-08', 9)]);
    assertValid(res.object);
  });

  test('this sull\'ultima istanza rimasta elimina la risorsa', () => {
    const two = parse(lines(...HEAD, 'BEGIN:VEVENT', 'UID:due@test', 'DTSTAMP:20270101T000000Z', 'SUMMARY:Due', 'DTSTART;TZID=Europe/Rome:20270301T090000', 'DTEND;TZID=Europe/Rome:20270301T100000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'END:VEVENT', ...FOOT));
    const first = planScopedDelete(two, K_0301, 'this', CTX);
    assert.equal(first.action, 'put');
    if (first.action !== 'put') return;
    assert.deepEqual(planScopedDelete(first.object, K_0308, 'this', CTX), { action: 'delete' });
  });

  test('this_and_future: tronca la serie; sulla prima istanza elimina la risorsa', () => {
    const res = planScopedDelete(series(), K_0315, 'this_and_future', CTX);
    assert.equal(res.action, 'put');
    if (res.action !== 'put') return;
    assert.equal(fieldsOf(res.object.master as IcsComponent).rrule, 'FREQ=WEEKLY;COUNT=2;BYDAY=MO');
    assert.equal(res.object.overrides.length, 1, 'l\'override del 15/3 va via, quello dell\'8/3 resta');
    assert.deepEqual(planScopedDelete(series(), K_0301, 'this_and_future', CTX), { action: 'delete' });
  });

  test('scope non ammessi → SCOPE_INVALID; istanza inesistente → RECURRENCE_TARGET_GONE', () => {
    const invalid = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof CalendarV2Error && e.code === 'SCOPE_INVALID');
    invalid(() => planScopedDelete(single(), '', 'this', CTX));
    invalid(() => planScopedDelete(single(), '', 'this_and_future', CTX));
    invalid(() => planScopedDelete(series(), '', 'this', CTX));
    invalid(() => planScopedDelete(series(), '', 'this_and_future', CTX));
    assert.throws(() => planScopedDelete(series(), '20270302T080000Z', 'this', CTX), RecurrenceTargetError);
  });
});

describe('planThisAndFuture (§3.8)', () => {
  test('da un\'istanza intermedia: vecchia serie troncata e nuova serie con le op', () => {
    const plan = planThisAndFuture(series(), K_0322, [set('summary', 'Nuova serie'), set('location', 'Aula 7')], CTX);
    assert.equal(plan.wholeSeries, false);
    assert.ok(plan.head);
    assert.equal(fieldsOf(plan.head.master as IcsComponent).rrule, 'FREQ=WEEKLY;COUNT=3;BYDAY=MO', 'istanze 1/3, 8/3 e 15/3');
    assert.equal(fieldsOf(plan.head.master as IcsComponent).summary, 'Studio');
    const tail = plan.tail.master as IcsComponent;
    assert.notEqual(plan.tail.uid, 'serie-1@test');
    assert.deepEqual(fieldsOf(tail).start, local('2027-03-22', 9));
    assert.equal(fieldsOf(tail).summary, 'Nuova serie');
    assert.equal(fieldsOf(tail).location, 'Aula 7');
    assert.equal(fieldsOf(tail).rrule, 'FREQ=WEEKLY;COUNT=3;BYDAY=MO', 'COUNT residuo: 22/3, 29/3 e 5/4');
    const related = getProperty(tail, 'RELATED-TO');
    assert.equal(related?.value, 'serie-1@test');
    assert.equal(related?.params.find((p) => p.name === 'RELTYPE')?.values[0], 'SIBLING');
    assertValid(plan.head);
    assertValid(plan.tail);
  });

  test('la coda sposta anche i suoi override quando cambia l\'orario', () => {
    const plan = planThisAndFuture(series(), K_0315, [set('start', local('2027-03-15', 10)), set('end', local('2027-03-15', 11))], CTX);
    assert.equal(plan.wholeSeries, false);
    const override = plan.tail.overrides[0];
    assert.equal(getProperty(override, 'RECURRENCE-ID')?.value, '20270315T100000', 'RECURRENCE-ID dell\'override del taglio spostato');
    assert.equal(plan.tail.overrides.length, 1);
  });

  test('sulla prima istanza è come "tutta la serie"', () => {
    const plan = planThisAndFuture(series(), K_0301, [set('summary', 'Intera')], CTX);
    assert.equal(plan.wholeSeries, true);
    assert.equal(plan.head, null);
    assert.equal(plan.tail.uid, 'serie-1@test');
    assert.equal(fieldsOf(plan.tail.master as IcsComponent).summary, 'Intera');
  });

  test('scope non ammesso: dal master e per un evento singolo; istanza inesistente', () => {
    const invalid = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof CalendarV2Error && e.code === 'SCOPE_INVALID');
    invalid(() => planThisAndFuture(series(), '', [set('summary', 'x')], CTX));
    invalid(() => planThisAndFuture(single(), '', [set('summary', 'x')], CTX));
    assert.throws(() => planThisAndFuture(series(), '20270302T080000Z', [set('summary', 'x')], CTX), RecurrenceTargetError);
  });

  test('applyOpsToNewSeries applica le op alla nuova serie come planThisAndFuture', () => {
    const plan = planThisAndFuture(series(), K_0329, [set('summary', 'Coda')], CTX);
    assert.equal(plan.wholeSeries, false);
    assert.ok(plan.head);
    assert.equal(fieldsOf(plan.tail.master as IcsComponent).summary, 'Coda');
    const direct = applyOpsToNewSeries(parse(serializeObject(plan.tail)), toCoreOps([set('summary', 'Altra')]), CTX);
    assert.equal(fieldsOf(direct.master as IcsComponent).summary, 'Altra');
  });
});
