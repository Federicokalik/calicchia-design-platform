/**
 * parse.ts: struttura lossless, componenti e proprietà sconosciuti,
 * oggetti calendario (master + override per UID), split dei feed ed errori
 * tipizzati sugli ICS non validi.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  calendarToObject,
  getParam,
  getProperties,
  getProperty,
  getSubcomponents,
  IcsParseError,
  parseCalendarObject,
  parseCalendarObjectOrThrow,
  parseComponents,
  parseIcs,
  parseIcsOrThrow,
  parsePropertyLine,
  splitCalendar,
  type IcsParseErrorCode,
} from '../src/index';
import { fixture, fixtureBytes, ics } from './helpers';

function expectError(input: string | Uint8Array, code: IcsParseErrorCode, opts: Parameters<typeof parseIcs>[1] = {}): IcsParseError {
  const r = parseIcs(input, opts);
  assert.equal(r.ok, false, `atteso errore ${code}`);
  if (r.ok) throw new Error('irraggiungibile');
  assert.ok(r.error instanceof IcsParseError);
  assert.equal(r.error.code, code);
  return r.error;
}

describe('parse: struttura lossless', () => {
  test('fixture Apple: proprietà, parametri, VALARM, ATTENDEE, X-* e componenti sconosciuti restano', () => {
    const cal = parseIcsOrThrow(fixture('apple-fidelity.ics'));
    assert.equal(cal.name, 'VCALENDAR');
    assert.deepEqual(
      cal.properties.map((p) => p.name),
      ['METHOD', 'VERSION', 'X-WR-CALNAME', 'PRODID', 'CALSCALE'],
    );
    assert.deepEqual(
      cal.components.map((c) => c.name),
      ['VTIMEZONE', 'VEVENT', 'VEVENT', 'X-WR-UNKNOWN-TOP'],
    );
    const master = cal.components[1];
    // Ordine delle proprietà conservato, nomi in maiuscolo.
    assert.equal(master.properties[0].name, 'TRANSP');
    assert.equal(master.properties[1].name, 'DTEND');

    const loc = getProperty(master, 'X-APPLE-STRUCTURED-LOCATION');
    assert.ok(loc);
    assert.equal(loc.value, 'geo:41.890251,12.492373');
    assert.deepEqual(getParam(loc, 'X-ADDRESS')?.values, ['Piazza del Colosseo, 00184 Roma RM, Italia']);
    assert.deepEqual(getParam(loc, 'X-TITLE')?.values, ['Colosseo']);
    assert.deepEqual(getParam(loc, 'VALUE')?.values, ['URI']);

    const attendees = getProperties(master, 'ATTENDEE');
    assert.equal(attendees.length, 2);
    assert.deepEqual(getParam(attendees[0], 'CN')?.values, ['Rossi, Mario']);
    assert.deepEqual(getParam(attendees[0], 'DELEGATED-FROM')?.values, ['mailto:a@example.com', 'mailto:b@example.com']);
    assert.deepEqual(getParam(attendees[0], 'X-NUM-GUESTS')?.values, ['0']);
    assert.equal(attendees[0].value, 'mailto:mario@example.com');

    const unknown = getProperty(master, 'X-CALDES-UNKNOWN-PROP');
    assert.ok(unknown);
    assert.equal(unknown.value, 'valore grezzo con \\, virgola e : due punti');
    assert.deepEqual(unknown.params, [
      { name: 'X-FOO', values: ['bar'] },
      { name: 'X-EMPTY', values: [''] },
    ]);
    const iana = getProperty(master, 'NEWIANAPROP');
    assert.deepEqual(iana?.params, [{ name: 'NEWPARAM', values: ['a:b;c', 'x'] }]);

    const alarms = getSubcomponents(master, 'VALARM');
    assert.equal(alarms.length, 2);
    assert.equal(getProperty(alarms[0], 'X-APPLE-DEFAULT-ALARM')?.value, 'TRUE');
    assert.equal(getProperty(alarms[0], 'ACKNOWLEDGED')?.value, '20261005T080000Z');
    assert.deepEqual(getParam(getProperty(alarms[1], 'TRIGGER')!, 'RELATED')?.values, ['END']);
    assert.equal(getSubcomponents(master, 'X-CALDES-CUSTOM').length, 1);
  });

  test('il folding UTF-8 si ricompone (DESCRIPTION lunga con accentate ed emoji)', () => {
    const cal = parseIcsOrThrow(fixture('apple-fidelity.ics'));
    const desc = getProperty(cal.components[1], 'DESCRIPTION');
    assert.ok(desc?.value.includes('25 € a persona 😀🎉'));
    assert.ok(desc?.value.endsWith('àèìòù ÀÈÌÒÙ.'));
    assert.deepEqual(getParam(desc!, 'LANGUAGE')?.values, ['it']);
  });

  test('fini riga LF e CR, BOM e righe vuote sono tollerati', () => {
    const lf = '﻿BEGIN:VCALENDAR\nVERSION:2.0\n\nBEGIN:VEVENT\nUID:a\nDTSTART:20261009T090000Z\nSUMMARY:una\n  riga\nEND:VEVENT\nEND:VCALENDAR\n';
    const cal = parseIcsOrThrow(lf);
    assert.equal(getProperty(cal.components[0], 'SUMMARY')?.value, 'una riga');
    const cr = lf.replace(/\n/g, '\r');
    assert.equal(getProperty(parseIcsOrThrow(cr).components[0], 'SUMMARY')?.value, 'una riga');
  });

  test('continuazione con TAB', () => {
    const cal = parseIcsOrThrow(ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:ab', '\tcd', 'END:VEVENT', 'END:VCALENDAR']));
    assert.equal(getProperty(cal.components[0], 'SUMMARY')?.value, 'abcd');
  });

  test('Uint8Array: un carattere multibyte spezzato da un folding scorretto si ricompone', () => {
    const enc = new TextEncoder();
    const desc = 'à'.repeat(40);
    const line = enc.encode(`DESCRIPTION:${desc}`);
    // Spezza a metà di una "à" (2 ottetti): 12 ottetti di "DESCRIPTION:" + 61 = dentro il 31° carattere.
    const cut = 12 + 61;
    const parts = [
      enc.encode('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\n'),
      line.subarray(0, cut),
      enc.encode('\r\n '),
      line.subarray(cut),
      enc.encode('\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'),
    ];
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let off = 0;
    for (const p of parts) {
      bytes.set(p, off);
      off += p.byteLength;
    }
    const fromBytes = parseIcsOrThrow(bytes);
    assert.equal(getProperty(fromBytes.components[0], 'DESCRIPTION')?.value, desc);
    // Dalla stringa già decodificata non si può recuperare: restano due U+FFFD.
    const fromString = parseIcsOrThrow(new TextDecoder().decode(bytes));
    assert.ok(getProperty(fromString.components[0], 'DESCRIPTION')?.value.includes('�'));
  });

  test('Uint8Array: BOM, CRLF e fixture reale', () => {
    const bytes = fixtureBytes('outlook-windows-tz.ics');
    const withBom = new Uint8Array(bytes.byteLength + 3);
    withBom.set([0xef, 0xbb, 0xbf]);
    withBom.set(bytes, 3);
    const cal = parseIcsOrThrow(withBom);
    assert.equal(cal.components.length, 2);
  });

  test('più VEVENT per UID: master e override in un oggetto', () => {
    const obj = parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'));
    assert.equal(obj.uid, '6B29FC40-CA47-1067-B31D-00DD010662DA');
    assert.equal(obj.componentType, 'VEVENT');
    assert.ok(obj.master);
    assert.equal(obj.overrides.length, 1);
    assert.equal(getProperty(obj.overrides[0], 'RECURRENCE-ID')?.value, '20261019T090000');
    assert.equal(obj.timezones.length, 1);
    assert.deepEqual(obj.otherComponents.map((c) => c.name), ['X-WR-UNKNOWN-TOP']);
    assert.equal(obj.calendarProperties.length, 5);
  });

  test('oggetto con soli override (master assente) è ammesso', () => {
    const r = parseCalendarObject(
      ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:solo', 'RECURRENCE-ID:20261009T090000Z', 'DTSTART:20261009T100000Z', 'END:VEVENT', 'END:VCALENDAR']),
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.master, null);
      assert.equal(r.value.overrides.length, 1);
    }
  });

  test('override duplicati: avviso, restano entrambi', () => {
    const r = parseCalendarObject(
      ics([
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT', 'UID:d', 'DTSTART:20261009T090000Z', 'RRULE:FREQ=DAILY', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:d', 'RECURRENCE-ID:20261010T090000Z', 'DTSTART:20261010T100000Z', 'END:VEVENT',
        'BEGIN:VEVENT', 'UID:d', 'RECURRENCE-ID:20261010T090000Z', 'DTSTART:20261010T110000Z', 'END:VEVENT',
        'END:VCALENDAR',
      ]),
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.overrides.length, 2);
      assert.deepEqual(r.warnings.map((w) => w.code), ['DUPLICATE_RECURRENCE_ID']);
    }
  });

  test('parametri: senza valore, vuoti, quotati con virgole e due punti', () => {
    const p = parsePropertyLine('X-TEST;ENCODING;EMPTY=;Q="a,b:c";MULTI=x,"y;z",w:valore:con:due:punti');
    assert.equal(p.name, 'X-TEST');
    assert.deepEqual(p.params, [
      { name: 'ENCODING', values: [] },
      { name: 'EMPTY', values: [''] },
      { name: 'Q', values: ['a,b:c'] },
      { name: 'MULTI', values: ['x', 'y;z', 'w'] },
    ]);
    assert.equal(p.value, 'valore:con:due:punti');
  });

  test('nomi in minuscolo diventano maiuscoli, il valore resta grezzo', () => {
    const p = parsePropertyLine('summary;language=it:Ciao\\, mondo');
    assert.equal(p.name, 'SUMMARY');
    assert.equal(p.params[0].name, 'LANGUAGE');
    assert.equal(p.value, 'Ciao\\, mondo');
  });

  test('parseComponents: un VTIMEZONE isolato', () => {
    const r = parseComponents('BEGIN:VTIMEZONE\r\nTZID:X\r\nEND:VTIMEZONE\r\n');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value[0].name, 'VTIMEZONE');
  });
});

describe('parse: errori tipizzati', () => {
  test('input vuoto', () => {
    expectError('', 'EMPTY_INPUT');
    expectError('   \r\n\r\n', 'EMPTY_INPUT');
  });

  test('HTML o testo qualsiasi → NOT_ICALENDAR', () => {
    expectError('<!doctype html><html><body>Login</body></html>', 'NOT_ICALENDAR');
    expectError('BEGIN:VCARD\r\nFN:Mario\r\nEND:VCARD\r\n', 'NOT_ICALENDAR');
  });

  test('componente radice diverso da VCALENDAR', () => {
    expectError(ics(['BEGIN:VEVENT', 'UID:a', 'END:VEVENT', 'BEGIN:VCALENDAR', 'END:VCALENDAR']), 'NOT_ICALENDAR');
  });

  test('riga senza due punti, con riga indicata', () => {
    const err = expectError(ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'QUESTA RIGA NON VA', 'END:VEVENT', 'END:VCALENDAR']), 'MALFORMED_LINE');
    assert.equal(err.line, 4);
  });

  test('virgolette non chiuse', () => {
    expectError(ics(['BEGIN:VCALENDAR', 'X-A;P="aperta:valore', 'END:VCALENDAR']), 'MALFORMED_LINE');
  });

  test('END senza BEGIN o con nome diverso', () => {
    expectError(ics(['BEGIN:VCALENDAR', 'END:VEVENT', 'END:VCALENDAR']), 'UNBALANCED_COMPONENT');
    expectError(ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'END:VTODO', 'END:VCALENDAR']), 'UNBALANCED_COMPONENT');
  });

  test('componente mai chiuso', () => {
    const err = expectError(ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a']), 'UNTERMINATED_COMPONENT');
    assert.equal(err.line, 2);
  });

  test('contenuto fuori dal VCALENDAR', () => {
    expectError(ics(['X-PRIMA:1', 'BEGIN:VCALENDAR', 'END:VCALENDAR']), 'CONTENT_OUTSIDE_VCALENDAR');
  });

  test('più VCALENDAR: errore o unione esplicita', () => {
    const two = ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'END:VEVENT', 'END:VCALENDAR', 'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:b', 'END:VEVENT', 'END:VCALENDAR']);
    expectError(two, 'MULTIPLE_VCALENDAR');
    const merged = parseIcs(two, { multipleCalendars: 'merge' });
    assert.ok(merged.ok);
    if (merged.ok) {
      assert.equal(merged.value.components.length, 2);
      assert.deepEqual(merged.warnings.map((w) => w.code), ['MERGED_VCALENDAR']);
    }
  });

  test('troppo grande e troppo profondo', () => {
    expectError(ics(['BEGIN:VCALENDAR', `X-A:${'x'.repeat(200)}`, 'END:VCALENDAR']), 'TOO_LARGE', { maxBytes: 100 });
    const deep = ['BEGIN:VCALENDAR', ...Array.from({ length: 20 }, () => 'BEGIN:X-N'), ...Array.from({ length: 20 }, () => 'END:X-N'), 'END:VCALENDAR'];
    expectError(ics(deep), 'TOO_DEEP');
  });

  test('UTF-8 non valido: errore o sostituzione esplicita', () => {
    const bytes = new TextEncoder().encode(ics(['BEGIN:VCALENDAR', 'X-A:ok', 'END:VCALENDAR']));
    const bad = new Uint8Array(bytes);
    bad[bytes.indexOf(0x6f)] = 0xff; // la "o" di "ok"
    expectError(bad, 'INVALID_ENCODING');
    const replaced = parseIcs(bad, { invalidUtf8: 'replace' });
    assert.ok(replaced.ok);
    if (replaced.ok) assert.deepEqual(replaced.warnings.map((w) => w.code), ['INVALID_UTF8_REPLACED']);
  });

  test('righe malformate saltate su richiesta, con avviso', () => {
    const r = parseIcs(ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'riga rotta', 'SUMMARY:ok', 'END:VEVENT', 'END:VCALENDAR']), {
      malformedLines: 'skip',
    });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(getProperty(r.value.components[0], 'SUMMARY')?.value, 'ok');
      assert.deepEqual(r.warnings.map((w) => [w.code, w.line]), [['SKIPPED_LINE', 4]]);
    }
  });

  test('errori per oggetto: NO_COMPONENT, MISSING_UID, MULTIPLE_UIDS, MIXED_COMPONENT_TYPES, DUPLICATE_MASTER', () => {
    const cases: Array<[string[], IcsParseErrorCode]> = [
      [['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:X', 'END:VTIMEZONE', 'END:VCALENDAR'], 'NO_COMPONENT'],
      [['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:20261009T090000Z', 'END:VEVENT', 'END:VCALENDAR'], 'MISSING_UID'],
      [['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b', 'END:VEVENT', 'END:VCALENDAR'], 'MULTIPLE_UIDS'],
      [['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'END:VEVENT', 'BEGIN:VTODO', 'UID:a', 'END:VTODO', 'END:VCALENDAR'], 'MIXED_COMPONENT_TYPES'],
      [['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:a', 'END:VEVENT', 'END:VCALENDAR'], 'DUPLICATE_MASTER'],
    ];
    for (const [lines, code] of cases) {
      const r = parseCalendarObject(ics(lines));
      assert.equal(r.ok, false, code);
      if (!r.ok) {
        assert.ok(r.error instanceof IcsParseError);
        assert.equal(r.error.code, code);
      }
    }
  });

  test('le varianti OrThrow lanciano IcsParseError tipizzati', () => {
    assert.throws(() => parseIcsOrThrow('nulla'), (err: unknown) => err instanceof IcsParseError && err.code === 'NOT_ICALENDAR');
    assert.throws(() => parsePropertyLine('senza-due-punti'), (err: unknown) => err instanceof IcsParseError && err.code === 'MALFORMED_LINE');
  });
});

describe('parse: split dei feed', () => {
  test('un oggetto per UID, errori per oggetto, VTIMEZONE referenziati', () => {
    const cal = parseIcsOrThrow(fixture('google-feed.ics'));
    const split = splitCalendar(cal);
    assert.deepEqual(
      split.objects.map((o) => o.uid),
      ['natale-2026@google.com', 'ny-standup@google.com', 'floating@google.com'],
    );
    const standup = split.objects[1];
    assert.ok(standup.master);
    assert.equal(standup.overrides.length, 1);
    assert.deepEqual(standup.timezones.map((t) => getProperty(t, 'TZID')?.value), ['America/New_York']);
    assert.equal(split.objects[0].timezones.length, 0);
    assert.deepEqual(
      split.errors.map((e) => [e.uid, e.error.code]),
      [
        [null, 'MISSING_UID'],
        ['dup@google.com', 'DUPLICATE_MASTER'],
      ],
    );
    assert.deepEqual(split.warnings.map((w) => w.code), ['IGNORED_COMPONENT']);
  });

  test('duplicateMasters: keep-first conserva il primo con avviso', () => {
    const split = splitCalendar(parseIcsOrThrow(fixture('google-feed.ics')), { duplicateMasters: 'keep-first' });
    const dup = split.objects.find((o) => o.uid === 'dup@google.com');
    assert.ok(dup);
    assert.equal(getProperty(dup.master!, 'SUMMARY')?.value, 'Duplicato A');
    assert.ok(split.warnings.some((w) => w.code === 'DUPLICATE_MASTER_DROPPED'));
  });

  test('calendarToObject non accetta una radice diversa da VCALENDAR', () => {
    const r = calendarToObject({ name: 'VEVENT', properties: [], components: [] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'NOT_ICALENDAR');
  });
});
