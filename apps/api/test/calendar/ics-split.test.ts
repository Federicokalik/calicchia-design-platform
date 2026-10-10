/**
 * Split dei feed ICS remoti (apps/api/src/lib/calendar/ics-split.ts; design
 * §5 "UID e href", §6.6, §14 "parseIcs rotto"; contratto
 * docs/calendar-radicale/contracts/f2-modules.md §8.1). Nessun database.
 *
 * Casi: href deterministico r-<base32(sha256(UID))[0..26]>.ics; un oggetto
 * per UID con gli override insieme (il parser legacy li perdeva tutti);
 * fingerprint invariato con DTSTAMP, LAST-MODIFIED, SEQUENCE o il nome del
 * calendario diversi e diverso per un cambio vero; fingerprint del testo
 * salvato uguale a quello dello split (indicizzatore e specchio lo rileggono);
 * METHOD tolto dalle risorse; UID rotti presenti con href e testo (quarantena,
 * mai cancellazione); componenti senza UID scartati; VTODO ignorati; righe
 * malformate saltate; feed vuoto, HTML o troncato rifiutato per intero.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { parseCalendarObject, semanticFingerprint } from '@calicchia/calendar-core';
import { IcsFeedError, REMOTE_HREF_RE, remoteHref, splitIcsFeed, tolerantFingerprint } from '../../src/lib/calendar/ics-split';

const FIXTURES = join(import.meta.dirname, '../../../../packages/calendar-core/test/fixtures');

function feed(events: string[][], extra: string[] = []): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//Feed remoto//IT',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Calendario remoto',
    ...extra,
    ...events.flatMap((props) => ['BEGIN:VEVENT', ...props, 'END:VEVENT']),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function event(uid: string, opts: { dtstamp?: string; summary?: string; start?: string; extra?: string[] } = {}): string[] {
  return [
    `UID:${uid}`,
    `DTSTAMP:${opts.dtstamp ?? '20261001T000000Z'}`,
    `DTSTART:${opts.start ?? '20270104T080000Z'}`,
    'DTEND:20270104T090000Z',
    `SUMMARY:${opts.summary ?? 'Riunione'}`,
    ...(opts.extra ?? []),
  ];
}

function fingerprintOfRaw(raw: string): string {
  const parsed = parseCalendarObject(raw);
  assert.ok(parsed.ok, `testo salvato non rileggibile: ${parsed.ok ? '' : parsed.error.message}`);
  return semanticFingerprint(parsed.value);
}

describe('remoteHref', () => {
  test('r-<base32(sha256(UID))[0..26]>.ics: deterministico, minuscolo, sicuro per qualsiasi UID', () => {
    const href = remoteHref('evento@google.com');
    assert.match(href, REMOTE_HREF_RE);
    assert.equal(href, remoteHref('evento@google.com'));
    assert.notEqual(href, remoteHref('evento2@google.com'));
    // Base32 RFC 4648 dei primi 130 bit dello SHA-256 (verifica indipendente sui primi 5 byte = 8 caratteri).
    const digest = createHash('sha256').update('evento@google.com', 'utf8').digest();
    const bits = [...digest.subarray(0, 5)].map((b) => b.toString(2).padStart(8, '0')).join('');
    const expected = bits.match(/.{5}/g)!.map((chunk) => 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(chunk, 2)]).join('');
    assert.equal(href.slice(2, 10), expected);
    for (const uid of ['con/barra', 'spazi e àccenti', '../../etc/passwd', 'x'.repeat(2000)]) assert.match(remoteHref(uid), REMOTE_HREF_RE);
  });
});

describe('splitIcsFeed', () => {
  test('un oggetto per UID con gli override insieme, METHOD tolto, VTIMEZONE canonici, fingerprint del testo salvato stabile', () => {
    const body = feed([
      ['UID:serie@remoto', 'DTSTAMP:20261001T000000Z', 'DTSTART;TZID=Europe/Rome:20270104T090000', 'DTEND;TZID=Europe/Rome:20270104T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'SUMMARY:Studio'],
      ['UID:serie@remoto', 'DTSTAMP:20261001T000000Z', 'RECURRENCE-ID;TZID=Europe/Rome:20270105T090000', 'DTSTART;TZID=Europe/Rome:20270105T110000', 'DTEND;TZID=Europe/Rome:20270105T120000', 'SUMMARY:Studio (spostato)'],
      event('singolo@remoto'),
    ]);
    const r = splitIcsFeed(body);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.objects.map((o) => o.uid).sort(), ['serie@remoto', 'singolo@remoto']);
    const serie = r.objects.find((o) => o.uid === 'serie@remoto')!;
    assert.equal(serie.href, remoteHref('serie@remoto'));
    assert.equal((serie.raw.match(/BEGIN:VEVENT/g) ?? []).length, 2, 'master e override nella stessa risorsa');
    assert.doesNotMatch(serie.raw, /^METHOD:/m, 'METHOD non è ammesso in una risorsa CalDAV');
    assert.match(serie.raw, /^BEGIN:VTIMEZONE\r\nTZID:Europe\/Rome/m, 'VTIMEZONE canonico per il TZID referenziato');
    assert.match(serie.raw, /\r\n$/);
    for (const o of r.objects) assert.equal(fingerprintOfRaw(o.raw), o.semanticFp, `fingerprint del testo salvato di ${o.uid}`);
  });

  test('DTSTAMP, LAST-MODIFIED, SEQUENCE e nome del calendario nuovi: stesso fingerprint; un cambio vero lo cambia', () => {
    const a = splitIcsFeed(feed([event('e1', { dtstamp: '20261001T000000Z', extra: ['SEQUENCE:0', 'LAST-MODIFIED:20261001T000000Z'] })]));
    const b = splitIcsFeed(feed([event('e1', { dtstamp: '20261009T101010Z', extra: ['SEQUENCE:3', 'LAST-MODIFIED:20261009T101010Z'] })])
      .replace('X-WR-CALNAME:Calendario remoto', 'X-WR-CALNAME:Rinominato'));
    assert.equal(a.objects[0].semanticFp, b.objects[0].semanticFp);
    assert.notEqual(a.objects[0].raw, b.objects[0].raw, 'il testo cambia (DTSTAMP), il fingerprint no');
    const c = splitIcsFeed(feed([event('e1', { summary: 'Riunione spostata' })]));
    assert.notEqual(a.objects[0].semanticFp, c.objects[0].semanticFp);
    const d = splitIcsFeed(feed([event('e1', { start: '20270104T083000Z' })]));
    assert.notEqual(a.objects[0].semanticFp, d.objects[0].semanticFp);
  });

  test('UID rotto: presente negli errori con href e testo (quarantena, mai cancellazione); senza UID: scartato', () => {
    const body = feed([
      event('doppio@remoto'),
      event('doppio@remoto', { summary: 'Secondo master' }),
      ['DTSTAMP:20261001T000000Z', 'DTSTART:20270105T080000Z', 'DTEND:20270105T090000Z', 'SUMMARY:Senza UID'],
      event('buono@remoto'),
    ]);
    const r = splitIcsFeed(body);
    assert.deepEqual(r.objects.map((o) => o.uid), ['buono@remoto']);
    const broken = r.errors.find((e) => e.uid === 'doppio@remoto');
    assert.ok(broken);
    assert.equal(broken.code, 'DUPLICATE_MASTER');
    assert.equal(broken.href, remoteHref('doppio@remoto'));
    assert.ok(broken.raw);
    assert.equal((broken.raw.match(/BEGIN:VEVENT/g) ?? []).length, 2, 'entrambi i componenti nel testo della quarantena');
    const parsed = parseCalendarObject(broken.raw);
    assert.equal(parsed.ok, false, 'l\'indicizzatore lo metterà in quarantena');
    const noUid = r.errors.find((e) => e.uid === null);
    assert.deepEqual([noUid?.code, noUid?.href, noUid?.raw, noUid?.fingerprint], ['MISSING_UID', null, null, null]);

    // Fingerprint tollerante del UID rotto: stesso con un DTSTAMP nuovo, diverso con un cambio vero.
    assert.equal(broken.fingerprint, tolerantFingerprint(broken.raw));
    const again = splitIcsFeed(feed([event('doppio@remoto', { dtstamp: '20261009T000000Z' }), event('doppio@remoto', { dtstamp: '20261009T000000Z', summary: 'Secondo master' })]));
    assert.equal(again.errors[0].fingerprint, broken.fingerprint);
    const changed = splitIcsFeed(feed([event('doppio@remoto'), event('doppio@remoto', { summary: 'Altro titolo' })]));
    assert.notEqual(changed.errors[0].fingerprint, broken.fingerprint);
    assert.equal(tolerantFingerprint('non è iCalendar'), null);
  });

  test('VTODO ignorati, righe malformate saltate, RRULE invalida passata all\'indicizzatore (quarantena lì)', () => {
    const body = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//IT',
      'BEGIN:VTODO',
      'UID:todo@remoto',
      'DTSTAMP:20261001T000000Z',
      'SUMMARY:Da fare',
      'END:VTODO',
      'BEGIN:VEVENT',
      'UID:ev@remoto',
      'DTSTAMP:20261001T000000Z',
      'questa riga non è una proprietà',
      'DTSTART:20270104T080000Z',
      'DTEND:20270104T090000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=XX',
      'SUMMARY:Rotta',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const r = splitIcsFeed(body);
    assert.deepEqual(r.objects.map((o) => o.uid), ['ev@remoto']);
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings >= 2, 'riga saltata e VTODO ignorato contano negli avvisi');
    assert.match(r.objects[0].raw, /RRULE:FREQ=WEEKLY;BYDAY=XX/);
  });

  test('feed vuoto, HTML, troncato o senza VCALENDAR: IcsFeedError (nessun oggetto utilizzabile)', () => {
    const cases: Array<[string, string]> = [
      ['', 'EMPTY_INPUT'],
      ['   \r\n', 'EMPTY_INPUT'],
      ['<html><body>Accedi</body></html>', 'NOT_ICALENDAR'],
      [feed([event('e1')]).replace('END:VCALENDAR\r\n', ''), 'UNTERMINATED_COMPONENT'],
    ];
    for (const [body, code] of cases) {
      assert.throws(() => splitIcsFeed(body), (err: unknown) => err instanceof IcsFeedError && err.code === code, `codice ${code}`);
    }
    // Un VCALENDAR valido senza eventi non è un errore: lo decide l'anti-wipe del pull.
    assert.deepEqual(splitIcsFeed(feed([])), { objects: [], errors: [], warnings: 0 });
  });

  test('fixture di Google, Outlook (fuso Windows), Thunderbird (TZID Mozilla), fuso personalizzato: fingerprint del testo salvato uguale', () => {
    for (const name of ['google-feed.ics', 'outlook-windows-tz.ics', 'thunderbird-mozilla-tz.ics', 'custom-tz.ics', 'apple-fidelity.ics', 'legacy-feed.ics']) {
      const r = splitIcsFeed(readFileSync(join(FIXTURES, name), 'utf8'));
      assert.ok(r.objects.length > 0, `${name}: nessun oggetto`);
      for (const o of r.objects) {
        assert.equal(fingerprintOfRaw(o.raw), o.semanticFp, `${name}: ${o.uid}`);
        assert.equal(o.href, remoteHref(o.uid));
      }
    }
    // Google: Natale all-day, serie di New York con override, floating; senza UID e master doppio negli errori.
    const google = splitIcsFeed(readFileSync(join(FIXTURES, 'google-feed.ics'), 'utf8'));
    assert.deepEqual(google.objects.map((o) => o.uid).sort(), ['floating@google.com', 'natale-2026@google.com', 'ny-standup@google.com']);
    assert.deepEqual(google.errors.map((e) => e.code).sort(), ['DUPLICATE_MASTER', 'MISSING_UID']);
  });

  test('5000 eventi: split sotto 1,5 s, fingerprint tutti uguali con DTSTAMP nuovo', () => {
    const big = (stamp: string): string => feed(Array.from({ length: 5000 }, (_, i) => {
      const start = new Date(Date.UTC(2027, 0, 1) + i * 7 * 3_600_000).toISOString().replace(/[-:]/g, '').slice(0, 15);
      return [`UID:ev-${i}@remoto`, `DTSTAMP:${stamp}`, `DTSTART;TZID=Europe/Rome:${start}`, 'DURATION:PT1H', `SUMMARY:Evento ${i}`];
    }));
    const t0 = performance.now();
    const a = splitIcsFeed(big('20261001T000000Z'));
    const elapsed = performance.now() - t0;
    const b = splitIcsFeed(big('20261002T000000Z'));
    assert.equal(a.objects.length, 5000);
    assert.ok(a.objects.every((o, i) => o.semanticFp === b.objects[i].semanticFp));
    assert.ok(elapsed < 1500, `split di 5000 eventi in ${Math.round(elapsed)} ms`);
  });
});
