/**
 * fingerprint.ts: SHA-256 puro contro node:crypto e fingerprint semantico
 * insensibile a DTSTAMP, LAST-MODIFIED, SEQUENCE, PRODID, folding, ordine
 * delle proprietà, dei VALARM, degli override e dei valori delle liste,
 * forma degli escape, VTIMEZONE equivalenti dei TZID IANA; sensibile a tutto
 * il resto (X-*, VTIMEZONE non IANA, contenuto).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  canonicalSemanticText,
  type CalendarObject,
  contentSha256,
  FINGERPRINT_VERSION,
  parseCalendarObjectOrThrow,
  parseIcsOrThrow,
  semanticFingerprint,
  serializeObject,
  splitCalendar,
} from '../src/index';
import { fixture, ics } from './helpers';

const nodeSha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function obj(lines: string[]): CalendarObject {
  return parseCalendarObjectOrThrow(ics(lines));
}

const BASE_EVENT = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//A//IT',
  'BEGIN:VEVENT',
  'UID:evt-1@example.com',
  'DTSTAMP:20261009T080000Z',
  'DTSTART;TZID=Europe/Rome:20261012T090000',
  'DTEND;TZID=Europe/Rome:20261012T100000',
  'SUMMARY:Riunione\\, con virgola',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TU',
  'EXDATE;TZID=Europe/Rome:20261013T090000,20261019T090000',
  'CATEGORIES:Lavoro,Clienti',
  'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
  'END:VEVENT',
  'END:VCALENDAR',
];

describe('contentSha256', () => {
  test('coincide con node:crypto su ASCII, UTF-8 multibyte, emoji e confini di blocco', () => {
    const cases = [
      '',
      'abc',
      'à è ì ò ù — € 😀🎉',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(63),
      'a'.repeat(64),
      'a'.repeat(65),
      'x'.repeat(1000) + 'ü'.repeat(333),
      fixture('apple-fidelity.ics'),
    ];
    for (const c of cases) assert.equal(contentSha256(c), nodeSha(c), `caso di ${c.length} caratteri`);
  });

  test('esadecimale minuscolo di 64 caratteri', () => {
    assert.match(contentSha256('Caldes'), /^[0-9a-f]{64}$/);
  });
});

describe('semanticFingerprint', () => {
  test('prefisso di versione', () => {
    assert.ok(semanticFingerprint(obj(BASE_EVENT)).startsWith(`v${FINGERPRINT_VERSION}:`));
    assert.match(semanticFingerprint(obj(BASE_EVENT)), /^v1:[0-9a-f]{64}$/);
  });

  test('feed con DTSTAMP sempre nuovo (e LAST-MODIFIED, SEQUENCE riscritti) → stesso fingerprint per ogni oggetto', () => {
    const text = fixture('google-feed.ics');
    const first = splitCalendar(parseIcsOrThrow(text), { duplicateMasters: 'keep-first' }).objects;
    const rewritten = text
      .replace(/DTSTAMP:\d{8}T\d{6}Z/g, 'DTSTAMP:20261010T234501Z')
      .replace(/LAST-MODIFIED:\d{8}T\d{6}Z/g, 'LAST-MODIFIED:20261010T234501Z')
      .replace(/SEQUENCE:0/g, 'SEQUENCE:7')
      .replace('PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'PRODID:-//Google Inc//Google Calendar 71.0000//EN');
    assert.notEqual(rewritten, text);
    const second = splitCalendar(parseIcsOrThrow(rewritten), { duplicateMasters: 'keep-first' }).objects;
    assert.equal(first.length, second.length);
    assert.ok(first.length >= 3);
    for (let i = 0; i < first.length; i++) {
      assert.equal(first[i].uid, second[i].uid);
      assert.equal(semanticFingerprint(first[i]), semanticFingerprint(second[i]), `fingerprint diverso per ${first[i].uid}`);
    }
  });

  test('un cambio vero nel feed cambia il fingerprint del solo oggetto toccato', () => {
    const text = fixture('google-feed.ics');
    const a = splitCalendar(parseIcsOrThrow(text), { duplicateMasters: 'keep-first' }).objects;
    const b = splitCalendar(parseIcsOrThrow(text.replace('SUMMARY:Natale', 'SUMMARY:Natale (chiuso)')), { duplicateMasters: 'keep-first' }).objects;
    const changed = a.filter((o, i) => semanticFingerprint(o) !== semanticFingerprint(b[i])).map((o) => o.uid);
    assert.deepEqual(changed, ['natale-2026@google.com']);
  });

  test('il nome del feed (X-WR-CALNAME) non riscrive tutti gli oggetti, X-WR-TIMEZONE sì', () => {
    const text = fixture('google-feed.ics');
    const fp = (t: string): string[] => splitCalendar(parseIcsOrThrow(t), { duplicateMasters: 'keep-first' }).objects.map((o) => semanticFingerprint(o));
    assert.deepEqual(fp(text.replace('X-WR-CALNAME:Personale', 'X-WR-CALNAME:Privato')), fp(text));
    assert.notDeepEqual(fp(text.replace('X-WR-TIMEZONE:Europe/Rome', 'X-WR-TIMEZONE:Europe/London')), fp(text));
  });

  test('insensibile a folding, maiuscole dei nomi, quotatura, escape TEXT e ordine delle proprietà', () => {
    const a = obj(BASE_EVENT);
    const b = obj([
      'BEGIN:VCALENDAR',
      'PRODID:-//Altro//B//EN',
      'VERSION:2.0',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'x-apple-travel-advisory-behavior:AUTOMATIC',
      'categories:Clienti,Lavoro',
      'EXDATE;TZID="Europe/Rome":20261019T090000',
      'EXDATE;TZID=Europe/Rome;VALUE=DATE-TIME:20261013T090000',
      'RRULE:BYDAY=TU,MO;INTERVAL=1;FREQ=WEEKLY;WKST=MO',
      'summary:Riunione\\, con',
      '  virgola',
      'dtend;tzid=Europe/Rome:20261012T100000',
      'DTSTART;VALUE=DATE-TIME;TZID=Europe/Rome:20261012T090000',
      'SEQUENCE:12',
      'LAST-MODIFIED:20270101T000000Z',
      'DTSTAMP:20270101T000000Z',
      'UID:evt-1@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    assert.equal(semanticFingerprint(b), semanticFingerprint(a));
    // Il testo canonico è lo stesso anche dopo un round-trip di serializzazione.
    assert.equal(semanticFingerprint(parseCalendarObjectOrThrow(serializeObject(a))), semanticFingerprint(a));
  });

  test('VTIMEZONE equivalenti di un TZID IANA (Apple, Thunderbird, canonico, assente) → stesso fingerprint', () => {
    const apple = parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'));
    const reserialized = parseCalendarObjectOrThrow(serializeObject(apple)); // VTIMEZONE canonico del registro
    const noTz = { ...apple, timezones: [] };
    assert.equal(semanticFingerprint(reserialized), semanticFingerprint(apple));
    assert.equal(semanticFingerprint(noTz), semanticFingerprint(apple));
    const otherDefinition = obj([
      ...BASE_EVENT.slice(0, 3),
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Rome',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0100',
      'END:STANDARD',
      'END:VTIMEZONE',
      ...BASE_EVENT.slice(3),
    ]);
    assert.equal(semanticFingerprint(otherDefinition), semanticFingerprint(obj(BASE_EVENT)));
  });

  test('VTIMEZONE non IANA: la definizione conta', () => {
    const custom = parseCalendarObjectOrThrow(fixture('custom-tz.ics'));
    const tzText = serializeObject(custom, { timezones: 'preserve' });
    const changed = parseCalendarObjectOrThrow(tzText.replace(/TZOFFSETTO:\+0200/, 'TZOFFSETTO:+0300'));
    assert.notEqual(semanticFingerprint(changed), semanticFingerprint(custom));
  });

  test('grafie diverse dello stesso TZID IANA (prefisso Mozilla, maiuscole) → stesso fingerprint; un nome Windows resta distinto', () => {
    const base = semanticFingerprint(obj(BASE_EVENT));
    const respell = (tzid: string): CalendarObject => obj(BASE_EVENT.map((l) => l.replace('TZID=Europe/Rome', `TZID=${tzid}`)));
    assert.equal(semanticFingerprint(respell('/mozilla.org/20050126_1/Europe/Rome')), base);
    assert.equal(semanticFingerprint(respell('europe/rome')), base);
    assert.notEqual(semanticFingerprint(respell('W. Europe Standard Time')), base);
    // Il testo dell'oggetto conserva la grafia del client: cambia solo il confronto.
    assert.match(serializeObject(respell('europe/rome')), /DTSTART;TZID=europe\/rome:/);
  });

  test('ordine dei VALARM e degli override indifferente', () => {
    const apple = parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'));
    const swapped: CalendarObject = {
      ...apple,
      master: apple.master ? { ...apple.master, components: [...apple.master.components].reverse() } : null,
      overrides: [...apple.overrides].reverse(),
    };
    assert.equal(semanticFingerprint(swapped), semanticFingerprint(apple));
  });

  test('sensibile a X-*, parametri sconosciuti, contenuto dei VALARM, durate diverse', () => {
    const base = semanticFingerprint(obj(BASE_EVENT));
    const variant = (from: string, to: string): string => semanticFingerprint(obj(BASE_EVENT.map((l) => (l === from ? to : l))));
    assert.notEqual(variant('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:DISABLED'), base);
    assert.notEqual(variant('SUMMARY:Riunione\\, con virgola', 'SUMMARY;LANGUAGE=it:Riunione\\, con virgola'), base);
    assert.notEqual(variant('RRULE:FREQ=WEEKLY;BYDAY=MO,TU', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU;INTERVAL=2'), base);
    assert.notEqual(variant('EXDATE;TZID=Europe/Rome:20261013T090000,20261019T090000', 'EXDATE;TZID=Europe/Rome:20261013T090000'), base);
    // Stesso istante in un'altra zona: è una modifica.
    assert.notEqual(variant('DTSTART;TZID=Europe/Rome:20261012T090000', 'DTSTART:20261012T070000Z'), base);
  });

  test('durate: P1W = P7D e PT60M = PT1H, ma P1D ≠ PT24H', () => {
    const withDuration = (d: string): string =>
      semanticFingerprint(
        obj(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:d', 'DTSTART:20261012T090000Z', `DURATION:${d}`, 'END:VEVENT', 'END:VCALENDAR']),
      );
    assert.equal(withDuration('P1W'), withDuration('P7D'));
    assert.equal(withDuration('PT60M'), withDuration('PT1H'));
    assert.equal(withDuration('PT90M'), withDuration('PT1H30M'));
    assert.notEqual(withDuration('P1D'), withDuration('PT24H'));
  });

  test('EXDATE e CATEGORIES: più proprietà o una sola con le virgole, duplicati compresi, sono la stessa cosa', () => {
    const a = obj(BASE_EVENT);
    const b = obj(
      BASE_EVENT.flatMap((l) =>
        l.startsWith('EXDATE')
          ? ['EXDATE;TZID=Europe/Rome:20261019T090000', 'EXDATE;TZID=Europe/Rome:20261013T090000,20261019T090000']
          : l.startsWith('CATEGORIES')
            ? ['CATEGORIES:Clienti', 'CATEGORIES:Lavoro,Clienti']
            : [l],
      ),
    );
    assert.equal(semanticFingerprint(b), semanticFingerprint(a));
  });

  test('ignoreProperties esclude proprietà aggiuntive (confronti fra store)', () => {
    const a = obj(BASE_EVENT);
    const b = obj(BASE_EVENT.flatMap((l) => (l.startsWith('UID') ? [l, 'X-CALDES-LEGACY-ID:2222'] : [l])));
    assert.notEqual(semanticFingerprint(b), semanticFingerprint(a));
    assert.equal(semanticFingerprint(b, { ignoreProperties: ['x-caldes-legacy-id'] }), semanticFingerprint(a));
  });

  test('testo canonico leggibile e deterministico, senza DTSTAMP né PRODID', () => {
    const text = canonicalSemanticText(parseCalendarObjectOrThrow(fixture('apple-fidelity.ics')));
    assert.ok(text.startsWith('BEGIN:VCALENDAR\n'));
    assert.ok(!/DTSTAMP|PRODID|LAST-MODIFIED|SEQUENCE/.test(text));
    assert.ok(text.includes('X-APPLE-STRUCTURED-LOCATION'));
    assert.ok(text.includes('BEGIN:VALARM'));
    assert.equal(canonicalSemanticText(parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'))), text);
  });
});
