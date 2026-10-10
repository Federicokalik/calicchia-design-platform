/**
 * validate.ts: esiti per oggetto con codici stabili, mai eccezioni.
 * Casi limite: component-set, UID, DTSTART, tipi coerenti, DTEND/DURATION,
 * RRULE (FREQ, BYxxx, COUNT/UNTIL, combinazioni impossibili), istanze
 * nell'orizzonte, stima di Radicale, TZID, override duplicati, dimensione.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertValidObject,
  buildEventFromLegacy,
  type CalendarObject,
  canonicalRruleText,
  createCalendarObject,
  createComponent,
  expandObject,
  MAX_INSTANCES_IN_HORIZON,
  MAX_OBJECT_BYTES,
  parseCalendarObjectOrThrow,
  RADICALE_MAX_OCCURRENCES,
  rruleParts,
  type ValidationCode,
  ValidationError,
  validateObject,
  validateRrule,
} from '../src/index';
import { fixture, ics } from './helpers';

const NOW = new Date('2026-10-09T10:00:00Z');
const OPTS = { tz: 'Europe/Rome', now: NOW };

function event(props: string[], extra: string[] = []): CalendarObject {
  return parseCalendarObjectOrThrow(
    ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//IT', 'BEGIN:VEVENT', 'UID:v-1', 'DTSTAMP:20261009T080000Z', ...props, 'END:VEVENT', ...extra, 'END:VCALENDAR']),
  );
}

function codes(obj: CalendarObject, opts: Parameters<typeof validateObject>[1] = OPTS): ValidationCode[] {
  return validateObject(obj, opts)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.code);
}

function warnings(obj: CalendarObject): ValidationCode[] {
  return validateObject(obj, OPTS)
    .issues.filter((i) => i.severity === 'warning')
    .map((i) => i.code);
}

const TIMED = ['DTSTART;TZID=Europe/Rome:20261012T090000', 'DTEND;TZID=Europe/Rome:20261012T100000'];
const ALLDAY = ['DTSTART;VALUE=DATE:20261012', 'DTEND;VALUE=DATE:20261013'];

describe('validateObject: oggetti validi', () => {
  test('evento timed, all-day e la serie di produzione lun-mar-gio-ven senza fine', () => {
    assert.deepEqual(validateObject(event(TIMED), OPTS), { ok: true, issues: [] });
    assert.deepEqual(codes(event(ALLDAY)), []);
    assert.deepEqual(codes(event([...TIMED, 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR'])), []);
  });

  test('oggetti costruiti dal DTO legacy (buildEventFromLegacy) sono validi', () => {
    const now = new Date('2026-09-01T00:00:00Z');
    const series = buildEventFromLegacy(
      { uid: 's', summary: 'Serie', start_time: '2026-09-07T07:00:00Z', end_time: '2026-09-07T11:00:00Z', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR;UNTIL=20261231', exdates: ['2026-11-02T08:00:00Z'] },
      { tz: 'Europe/Rome', now },
    );
    const allDay = buildEventFromLegacy(
      { uid: 'a', summary: 'Ferie', start_time: '2026-12-23T23:00:00Z', end_time: '2026-12-25T23:00:00Z', all_day: true, rrule: 'FREQ=YEARLY;UNTIL=20301224T230000Z', exdates: ['2027-12-23T23:00:00Z'] },
      { tz: 'Europe/Rome', now },
    );
    assert.deepEqual(codes(createCalendarObject({ uid: 's', master: series })), []);
    assert.deepEqual(codes(createCalendarObject({ uid: 'a', master: allDay })), []);
  });

  test('fixture reali: Apple (componente estraneo di primo livello → rifiutato come farebbe Radicale), Outlook e Thunderbird validi', () => {
    assert.deepEqual(codes(parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'))), ['COMPONENT_NOT_ALLOWED']);
    const outlook = parseCalendarObjectOrThrow(fixture('outlook-windows-tz.ics'));
    const thunderbird = parseCalendarObjectOrThrow(fixture('thunderbird-mozilla-tz.ics'));
    assert.equal(validateObject(outlook, OPTS).ok, true, JSON.stringify(validateObject(outlook, OPTS).issues));
    assert.equal(validateObject(thunderbird, OPTS).ok, true, JSON.stringify(validateObject(thunderbird, OPTS).issues));
  });
});

describe('validateObject: struttura e proprietà obbligatorie', () => {
  test('component-set della collezione e componenti estranei', () => {
    const todo = parseCalendarObjectOrThrow(ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO', 'UID:t', 'DTSTAMP:20261009T080000Z', 'SUMMARY:Da fare', 'END:VTODO', 'END:VCALENDAR']));
    assert.deepEqual(codes(todo), ['COMPONENT_NOT_ALLOWED']);
    assert.deepEqual(codes(todo, { ...OPTS, allowedComponents: ['VEVENT', 'VTODO'] }), []);
    const withFreebusy = event(TIMED, ['BEGIN:VFREEBUSY', 'UID:fb', 'END:VFREEBUSY']);
    assert.deepEqual(codes(withFreebusy), ['COMPONENT_NOT_ALLOWED']);
  });

  test('UID mancante, override con UID diverso, master senza DTSTART', () => {
    const noUid: CalendarObject = { ...event(TIMED), uid: '' };
    (noUid.master as { properties: unknown[] }).properties = noUid.master?.properties.filter((p) => p.name !== 'UID') ?? [];
    assert.ok(codes(noUid).includes('MISSING_UID'));
    const mismatch = event(TIMED, [
      'BEGIN:VEVENT', 'UID:v-1', 'DTSTAMP:20261009T080000Z', 'RECURRENCE-ID;TZID=Europe/Rome:20261019T090000', ...TIMED, 'END:VEVENT',
    ]);
    mismatch.overrides[0].properties = mismatch.overrides[0].properties.map((p) => (p.name === 'UID' ? { ...p, value: 'altro' } : p));
    assert.ok(codes(mismatch).includes('OVERRIDE_UID_MISMATCH'));
    assert.deepEqual(codes(event(['DTEND;TZID=Europe/Rome:20261012T100000'])), ['MISSING_DTSTART']);
  });

  test('valori illeggibili → INVALID_VALUE, mai un\'eccezione', () => {
    assert.deepEqual(codes(event(['DTSTART:2026-10-12', 'SUMMARY:x'])), ['INVALID_VALUE']);
    assert.deepEqual(codes(event([...TIMED.slice(0, 1), 'DTEND:domani'])), ['INVALID_VALUE']);
    assert.deepEqual(codes(event([TIMED[0], 'DURATION:un\'ora'])), ['INVALID_VALUE']);
    assert.ok(codes(event([...TIMED, 'RRULE:FREQ=DAILY', 'EXDATE:boh'])).includes('INVALID_VALUE'));
    // Oggetto senza componenti e oggetto fuori schema: esito, non eccezione.
    assert.deepEqual(codes(createCalendarObject({ uid: 'x', master: null })), ['INVALID_VALUE']);
    const weird = createCalendarObject({ uid: 'x', master: createComponent('VEVENT', [{ name: 'DTSTART', params: [], value: '' }]) });
    assert.doesNotThrow(() => validateObject(weird, OPTS));
    assert.equal(validateObject(weird, OPTS).ok, false);
  });

  test('valori non standard di STATUS, TRANSP, PRIORITY, GEO: solo avvisi', () => {
    const obj = event([...TIMED, 'STATUS:MAYBE', 'TRANSP:SOMETIMES', 'PRIORITY:12', 'GEO:100;200']);
    assert.deepEqual(codes(obj), []);
    assert.deepEqual(warnings(obj).sort(), ['INVALID_VALUE', 'INVALID_VALUE', 'INVALID_VALUE', 'INVALID_VALUE']);
  });
});

describe('validateObject: tempi coerenti', () => {
  test('DTEND dello stesso tipo e successivo, DURATION positiva, non insieme', () => {
    assert.deepEqual(codes(event(['DTSTART;VALUE=DATE:20261012', 'DTEND;TZID=Europe/Rome:20261013T000000'])), ['DTEND_TYPE_MISMATCH']);
    assert.deepEqual(codes(event(['DTSTART;TZID=Europe/Rome:20261012T090000', 'DTEND;TZID=Europe/Rome:20261012T090000'])), ['END_NOT_AFTER_START']);
    assert.deepEqual(codes(event(['DTSTART;VALUE=DATE:20261012', 'DTEND;VALUE=DATE:20261012'])), ['END_NOT_AFTER_START']);
    // Stesso istante in zone diverse: non successivo.
    assert.deepEqual(codes(event(['DTSTART;TZID=Europe/Rome:20261012T090000', 'DTEND:20261012T070000Z'])), ['END_NOT_AFTER_START']);
    assert.deepEqual(codes(event([TIMED[0], 'DURATION:-PT1H'])), ['END_NOT_AFTER_START']);
    assert.deepEqual(codes(event([TIMED[0], 'DURATION:PT0S'])), ['END_NOT_AFTER_START']);
    assert.deepEqual(codes(event(['DTSTART;VALUE=DATE:20261012', 'DURATION:PT2H'])), ['INVALID_VALUE']);
    assert.deepEqual(codes(event([...TIMED, 'DURATION:PT1H'])), ['DTEND_AND_DURATION']);
  });

  test('quirk di Thunderbird: DTEND più DURATION:PT0S è solo un avviso', () => {
    const obj = event([...TIMED, 'DURATION:PT0S']);
    assert.deepEqual(codes(obj), []);
    assert.deepEqual(warnings(obj), ['DTEND_AND_DURATION']);
  });

  test('EXDATE, RDATE e RECURRENCE-ID dello stesso tipo del DTSTART', () => {
    assert.deepEqual(codes(event([...TIMED, 'RRULE:FREQ=DAILY', 'EXDATE;VALUE=DATE:20261014'])), ['EXDATE_TYPE_MISMATCH']);
    assert.deepEqual(codes(event([...ALLDAY, 'RRULE:FREQ=DAILY', 'EXDATE:20261014T000000Z'])), ['EXDATE_TYPE_MISMATCH']);
    assert.deepEqual(codes(event([...ALLDAY, 'RDATE;VALUE=PERIOD:20261020T090000Z/PT1H'])), ['RDATE_TYPE_MISMATCH']);
    assert.deepEqual(codes(event([...TIMED, 'RDATE;VALUE=DATE:20261020'])), ['RDATE_TYPE_MISMATCH']);
    assert.deepEqual(codes(event([...TIMED, 'RDATE;VALUE=PERIOD:20261020T100000Z/20261020T090000Z'])), ['INVALID_VALUE']);
    assert.deepEqual(codes(event([...TIMED, 'RDATE;VALUE=PERIOD:20261020T090000Z/PT1H'])), []);
    const allDayWithTimedOverride = event(
      [...ALLDAY, 'RRULE:FREQ=DAILY;COUNT=5'],
      ['BEGIN:VEVENT', 'UID:v-1', 'DTSTAMP:20261009T080000Z', 'RECURRENCE-ID;TZID=Europe/Rome:20261014T000000', 'DTSTART;VALUE=DATE:20261014', 'END:VEVENT'],
    );
    assert.deepEqual(codes(allDayWithTimedOverride), ['RECURRENCE_ID_TYPE_MISMATCH']);
  });

  test('override duplicati per la stessa occorrenza (anche con TZID diversi)', () => {
    const obj = event(
      [...TIMED, 'RRULE:FREQ=DAILY;COUNT=5'],
      [
        'BEGIN:VEVENT', 'UID:v-1', 'DTSTAMP:20261009T080000Z', 'RECURRENCE-ID;TZID=Europe/Rome:20261013T090000', 'DTSTART;TZID=Europe/Rome:20261013T150000', 'DTEND;TZID=Europe/Rome:20261013T160000', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:v-1', 'DTSTAMP:20261009T080000Z', 'RECURRENCE-ID:20261013T070000Z', 'DTSTART;TZID=Europe/Rome:20261013T170000', 'DTEND;TZID=Europe/Rome:20261013T180000', 'END:VEVENT',
      ],
    );
    assert.deepEqual(codes(obj), ['DUPLICATE_OVERRIDE']);
  });

  test('TZID sconosciuto senza VTIMEZONE → UNKNOWN_TZID; nomi Windows e VTIMEZONE personalizzati ammessi', () => {
    assert.deepEqual(codes(event(['DTSTART;TZID=Pianeta/Marte:20261012T090000', 'DTEND;TZID=Pianeta/Marte:20261012T100000'])), ['UNKNOWN_TZID']);
    assert.deepEqual(codes(event(['DTSTART;TZID=W. Europe Standard Time:20261012T090000', 'DTEND;TZID=W. Europe Standard Time:20261012T100000'])), []);
    assert.equal(validateObject(parseCalendarObjectOrThrow(fixture('custom-tz.ics')), OPTS).issues.some((i) => i.code === 'UNKNOWN_TZID'), false);
  });
});

describe('validateObject: RRULE', () => {
  const rr = (rule: string, start: string[] = TIMED): ValidationCode[] => codes(event([...start, `RRULE:${rule}`]));

  test('FREQ obbligatoria e valida; SECONDLY e MINUTELY non ammesse', () => {
    assert.deepEqual(rr('BYDAY=MO'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=FORTNIGHTLY'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=MINUTELY;COUNT=10'), ['RRULE_FREQ_NOT_ALLOWED']);
    assert.deepEqual(rr('FREQ=SECONDLY'), ['RRULE_FREQ_NOT_ALLOWED']);
  });

  test('COUNT, INTERVAL, UNTIL: valori, tipo e ordine', () => {
    assert.deepEqual(rr('FREQ=DAILY;COUNT=0'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=DAILY;INTERVAL=0'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=DAILY;COUNT=5;UNTIL=20261031T000000Z'), ['RRULE_COUNT_AND_UNTIL']);
    assert.deepEqual(rr('FREQ=DAILY;UNTIL=20261031'), ['UNTIL_TYPE_MISMATCH']);
    assert.deepEqual(rr('FREQ=DAILY;UNTIL=20261031T090000'), ['UNTIL_TYPE_MISMATCH']);
    assert.deepEqual(rr('FREQ=DAILY;UNTIL=20261031T080000Z', ALLDAY), ['UNTIL_TYPE_MISMATCH']);
    assert.deepEqual(rr('FREQ=DAILY;UNTIL=20261001T000000Z'), ['UNTIL_BEFORE_DTSTART']);
    assert.deepEqual(rr('FREQ=DAILY;UNTIL=20261011', ALLDAY), ['UNTIL_BEFORE_DTSTART']);
    assert.deepEqual(rr('FREQ=DAILY;UNTIL=20261012', ALLDAY), []);
    assert.deepEqual(rr('FREQ=DAILY;UNTIL=20261012T070000Z'), []); // UNTIL = DTSTART: ammesso (una sola istanza)
    assert.deepEqual(rr('FREQ=DAILY;UNTIL=domani'), ['RRULE_INVALID']);
    // Floating con UNTIL floating.
    assert.deepEqual(codes(event(['DTSTART:20261012T090000', 'DTEND:20261012T100000', 'RRULE:FREQ=DAILY;UNTIL=20261020T090000'])), []);
  });

  test('parti BYxxx: domini e coerenza con FREQ', () => {
    assert.deepEqual(rr('FREQ=DAILY;BYHOUR=25'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=YEARLY;BYMONTH=13'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=MONTHLY;BYMONTHDAY=0'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=WEEKLY;BYDAY=XX'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=WEEKLY;BYDAY=1MO'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=MONTHLY;BYDAY=6MO'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=MONTHLY;BYDAY=-1FR'), []);
    assert.deepEqual(rr('FREQ=WEEKLY;BYMONTHDAY=1'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=MONTHLY;BYYEARDAY=100'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=MONTHLY;BYWEEKNO=10'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=MONTHLY;BYSETPOS=1'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'), []);
    assert.deepEqual(rr('FREQ=WEEKLY;WKST=XX'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=WEEKLY;FOO=1'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=WEEKLY;COUNT=3;COUNT=4'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=WEEKLY;BYDAY'), ['RRULE_INVALID']);
  });

  test('combinazioni impossibili (30 febbraio) rifiutate prima di iterare', () => {
    assert.deepEqual(rr('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=YEARLY;BYMONTH=2,4;BYMONTHDAY=31'), ['RRULE_INVALID']);
    assert.deepEqual(rr('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29'), []);
  });

  test('RSCALE (RFC 7529): avviso, non errore; RRULE in un override o ripetuta: avviso', () => {
    const obj = event([...TIMED, 'RRULE:RSCALE=GREGORIAN;FREQ=YEARLY']);
    assert.deepEqual(codes(obj), []);
    assert.deepEqual(warnings(obj), ['RRULE_INVALID']);
    assert.deepEqual(warnings(event([...TIMED, 'RRULE:FREQ=DAILY;COUNT=2', 'RRULE:FREQ=WEEKLY;COUNT=2'])), ['RRULE_INVALID']);
  });

  test('RSCALE e SKIP diversi dal gregoriano/OMIT: errore (il motore li rifiuterebbe); parti X-...: avviso', () => {
    assert.deepEqual(rr('RSCALE=CHINESE;FREQ=YEARLY'), ['RRULE_INVALID']);
    assert.deepEqual(rr('RSCALE=GREGORIAN;SKIP=FORWARD;FREQ=YEARLY;BYMONTHDAY=31'), ['RRULE_INVALID']);
    const xPart = event([...TIMED, 'RRULE:FREQ=WEEKLY;X-NAME=valore;COUNT=4']);
    assert.deepEqual(codes(xPart), []);
    assert.deepEqual(warnings(xPart), ['RRULE_INVALID']);
  });

  test('ciò che il motore dell\'indice non legge è RRULE_INVALID anche se le singole parti sono valide', () => {
    // Oltre 2000 caratteri: recur.ts la rifiuta, quindi l'indice metterebbe l'oggetto in quarantena.
    const long = `FREQ=DAILY;BYMINUTE=${Array(1100).fill('0').join(',')}`;
    assert.deepEqual(rr(long), ['RRULE_INVALID']);
    assert.deepEqual(validateRrule(long, { type: 'date', year: 2026, month: 10, day: 12 }, { tz: 'Europe/Rome' }).map((i) => i.code), ['RRULE_INVALID']);
  });
});

describe('validateObject: stesso motore e stesso tetto dell\'indice', () => {
  test('esattamente MAX_INSTANCES_IN_HORIZON istanze nell\'orizzonte: valida; una di più: TOO_MANY_INSTANCES', () => {
    const hourly = (count: number): CalendarObject => event(['DTSTART:20261012T090000Z', 'DTEND:20261012T093000Z', `RRULE:FREQ=HOURLY;COUNT=${count}`]);
    assert.deepEqual(codes(hourly(MAX_INSTANCES_IN_HORIZON)), []);
    assert.deepEqual(codes(hourly(MAX_INSTANCES_IN_HORIZON + 1)), ['TOO_MANY_INSTANCES']);
  });

  test('un oggetto accettato si espande senza quarantena né troncamento nella finestra dell\'indice', () => {
    const horizon = { from: NOW.getTime() - 400 * 86_400_000, to: NOW.getTime() + 800 * 86_400_000 };
    const rules = [
      'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR',
      'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
      'FREQ=HOURLY;INTERVAL=6',
      'FREQ=DAILY;BYHOUR=9,14;BYMINUTE=0,30',
      'FREQ=YEARLY;BYWEEKNO=1,53;BYDAY=MO',
    ];
    for (const rule of rules) {
      const obj = event([...TIMED, `RRULE:${rule}`]);
      const result = validateObject(obj, OPTS);
      const expansion = expandObject(obj, { ...horizon, tz: 'Europe/Rome' });
      if (result.ok) {
        assert.equal(expansion.health, 'ok', rule);
        assert.equal(expansion.materializedUntil, null, rule);
      } else {
        assert.ok(expansion.health === 'quarantined' || expansion.materializedUntil != null, `${rule}: ${JSON.stringify(result.issues)}`);
      }
    }
  });

  test('fuso del calendario sconosciuto: avviso e DEFAULT_TZ, come nell\'espansione', () => {
    const result = validateObject(event([...TIMED, 'RRULE:FREQ=WEEKLY']), { tz: 'Pianeta/Marte', now: NOW });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.issues.map((i) => [i.code, i.severity]),
      [['UNKNOWN_TZID', 'warning']],
    );
  });
});

describe('validateObject: modifiche di oggetti esistenti (previous)', () => {
  // Scritto da un device: EXDATE DATE su una serie timed (RFC 5545 lo vieta, l'indice lo tollera).
  const deviceObject = (summary: string): CalendarObject =>
    event([...TIMED, `SUMMARY:${summary}`, 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;VALUE=DATE:20261019']);

  test('un difetto già presente non blocca la modifica di un altro campo: diventa un avviso', () => {
    const before = deviceObject('Prima');
    const after = deviceObject('Dopo');
    assert.deepEqual(codes(after), ['EXDATE_TYPE_MISMATCH']);
    const result = validateObject(after, { ...OPTS, previous: before });
    assert.equal(result.ok, true);
    const issue = result.issues.find((i) => i.code === 'EXDATE_TYPE_MISMATCH');
    assert.equal(issue?.severity, 'warning');
    assert.match(issue?.message ?? '', /già presente prima della modifica/);
  });

  test('un errore nuovo blocca anche con previous; RADICALE_LIMIT e COMPONENT_NOT_ALLOWED restano sempre errori', () => {
    const before = deviceObject('Prima');
    const broken = event([...TIMED, 'SUMMARY:Dopo', 'RRULE:FREQ=MINUTELY', 'EXDATE;VALUE=DATE:20261019']);
    assert.deepEqual(codes(broken, { ...OPTS, previous: before }), ['RRULE_FREQ_NOT_ALLOWED']);

    const huge = (summary: string): CalendarObject => event([...TIMED, `SUMMARY:${summary}`, `RRULE:FREQ=DAILY;COUNT=${RADICALE_MAX_OCCURRENCES + 1}`]);
    assert.deepEqual(codes(huge('Dopo'), { ...OPTS, previous: huge('Prima') }), ['RADICALE_LIMIT']);

    const todo = (summary: string): CalendarObject =>
      parseCalendarObjectOrThrow(ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//T//IT', 'BEGIN:VTODO', 'UID:t', `SUMMARY:${summary}`, 'END:VTODO', 'END:VCALENDAR']));
    assert.deepEqual(codes(todo('Dopo'), { ...OPTS, previous: todo('Prima') }), ['COMPONENT_NOT_ALLOWED']);
  });
});

describe('validateObject: istanze e limiti', () => {
  test('HOURLY infinita → TOO_MANY_INSTANCES; DAILY dal 2010 senza fine → valida', () => {
    assert.deepEqual(codes(event([...TIMED, 'RRULE:FREQ=HOURLY'])), ['TOO_MANY_INSTANCES']);
    assert.deepEqual(codes(event(['DTSTART;TZID=Europe/Rome:20100104T090000', 'DTEND;TZID=Europe/Rome:20100104T100000', 'RRULE:FREQ=DAILY'])), []);
  });

  test('tetto configurabile e conteggio con EXDATE e RDATE', () => {
    const obj = event([...TIMED, 'RRULE:FREQ=DAILY;COUNT=10', 'EXDATE;TZID=Europe/Rome:20261013T090000,20261014T090000', 'RDATE;TZID=Europe/Rome:20261101T090000']);
    assert.deepEqual(codes(obj, { ...OPTS, maxInstances: 9 }), []); // 10 − 2 + 1 = 9
    assert.deepEqual(codes(obj, { ...OPTS, maxInstances: 8 }), ['TOO_MANY_INSTANCES']);
    // Fuori dall'orizzonte non conta.
    const old = event(['DTSTART:20000101T090000Z', 'DTEND:20000101T100000Z', 'RRULE:FREQ=DAILY;COUNT=40']);
    assert.deepEqual(codes(old, { ...OPTS, maxInstances: 10 }), []);
  });

  test('stima di Radicale: COUNT oltre il limite, (UNTIL − DTSTART) / FREQ oltre il limite, conteggio delle regole finite', () => {
    assert.deepEqual(codes(event([...TIMED, `RRULE:FREQ=DAILY;COUNT=${RADICALE_MAX_OCCURRENCES + 1}`])), ['RADICALE_LIMIT']);
    // 200 anni giornalieri ≈ 73000 > 50000, anche se con INTERVAL=7 le istanze vere sarebbero ~10400 (Radicale ignora INTERVAL).
    assert.deepEqual(codes(event([...TIMED, 'RRULE:FREQ=DAILY;INTERVAL=7;UNTIL=22261012T070000Z'])), ['RADICALE_LIMIT']);
    // Mensile su tutti i giorni per 200 anni: stima per FREQ bassa (2400) ma 73000 istanze vere.
    assert.deepEqual(
      codes(event([...TIMED, 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28;UNTIL=22261012T070000Z']), {
        ...OPTS,
        maxInstances: 100_000,
      }),
      ['RADICALE_LIMIT'],
    );
    assert.deepEqual(codes(event([...TIMED, 'RRULE:FREQ=DAILY;COUNT=1000'])), []);
  });

  test('dimensione massima del testo serializzato', () => {
    const big = event([...TIMED, `DESCRIPTION:${'x'.repeat(2000)}`]);
    assert.deepEqual(codes(big, { ...OPTS, maxBytes: 1024 }), ['TOO_LARGE']);
    assert.deepEqual(codes(big, { ...OPTS, serializedBytes: MAX_OBJECT_BYTES + 1 }), ['TOO_LARGE']);
    assert.deepEqual(codes(big), []);
  });
});

describe('assertValidObject e validateRrule', () => {
  test('assertValidObject lancia ValidationError con i codici', () => {
    assert.doesNotThrow(() => assertValidObject(event(TIMED), OPTS));
    assert.throws(
      () => assertValidObject(event([...TIMED, 'RRULE:FREQ=MINUTELY']), OPTS),
      (e: unknown) => e instanceof ValidationError && e.code === 'VALIDATION_FAILED' && (e.details.codes as string[]).includes('RRULE_FREQ_NOT_ALLOWED'),
    );
  });

  test('validateRrule rispetto al DTSTART, con o senza prefisso', () => {
    const start = { type: 'date-time' as const, year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid' as const, tzid: 'Europe/Rome' } };
    assert.deepEqual(validateRrule('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', start, { tz: 'Europe/Rome' }), []);
    assert.deepEqual(validateRrule('FREQ=WEEKLY;UNTIL=20261231', start, { tz: 'Europe/Rome' }).map((i) => i.code), ['UNTIL_TYPE_MISMATCH']);
    assert.deepEqual(validateRrule('', start, { tz: 'Europe/Rome' }).map((i) => i.code), ['RRULE_INVALID']);
  });

  test('rruleParts e canonicalRruleText', () => {
    assert.deepEqual(rruleParts('RRULE:freq=weekly; byday=MO'), [
      { key: 'FREQ', value: 'weekly' },
      { key: 'BYDAY', value: 'MO' },
    ]);
    assert.equal(canonicalRruleText('freq=weekly;byday=tu,mo,mo;interval=1;wkst=MO'), 'BYDAY=MO,TU;FREQ=WEEKLY');
    assert.equal(canonicalRruleText('FREQ=MONTHLY;BYMONTHDAY=10,-1,2'), 'BYMONTHDAY=-1,2,10;FREQ=MONTHLY');
  });
});
