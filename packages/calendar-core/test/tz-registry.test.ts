/**
 * tz-registry.ts: risoluzione dei TZID (IANA, alias, prefissi Mozilla, nomi
 * Windows e di Outlook, etichette di offset, VTIMEZONE personalizzati),
 * VTIMEZONE canonici e conversioni con le regole RFC 5545 per gli orari
 * inesistenti e ambigui.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import ICAL from 'ical.js';
import {
  canonicalVtimezone,
  CANONICAL_TZ_SOURCE,
  DEFAULT_TZ,
  getIcalTimezone,
  getProperty,
  ianaName,
  ianaZone,
  isValidIanaZone,
  listCanonicalTimezones,
  offsetAt,
  parseCalendarObjectOrThrow,
  resolveTzid,
  resolveZone,
  semanticFingerprint,
  serializeObject,
  TimezoneError,
  toLegacyEventFields,
  expandObject,
  utcToZoned,
  vtimezoneTzid,
  windowsToIana,
  zonedToUtc,
  type ConvertibleZone,
} from '../src/index';
import { fixture } from './helpers';

const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const wall = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => ({ year, month, day, hour, minute, second });

describe('risoluzione dei TZID', () => {
  test('IANA esatto, con maiuscole diverse e alias', () => {
    assert.deepEqual(resolveTzid('Europe/Rome'), { kind: 'iana', tzid: 'Europe/Rome', iana: 'Europe/Rome', via: 'exact', vtimezone: null });
    const lower = resolveTzid('europe/rome');
    assert.equal(lower.kind === 'iana' && lower.via, 'case-insensitive');
    const alias = resolveTzid('US/Eastern');
    assert.equal(alias.kind, 'iana');
    if (alias.kind === 'iana') {
      assert.equal(alias.iana, 'America/New_York');
      assert.equal(alias.via, 'alias');
    }
  });

  test('prefissi legacy di Mozilla/Lightning e simili', () => {
    for (const tzid of [
      '/mozilla.org/20050126_1/Europe/Rome',
      '/mozilla.org/20070129_1/Europe/Rome',
      '/softwarestudio.org/Olson_20011030_5/Europe/Rome',
      '/freeassociation.sourceforge.net/Tzfile/Europe/Rome',
      '/citadel.org/20190914_1/Europe/Rome',
    ]) {
      const r = resolveTzid(tzid);
      assert.equal(r.kind, 'iana', tzid);
      if (r.kind === 'iana') {
        assert.equal(r.iana, 'Europe/Rome');
        assert.equal(r.via, 'prefix');
      }
    }
    const deep = resolveTzid('/mozilla.org/20050126_1/America/Argentina/Buenos_Aires');
    // Il nome IANA è quello canonico per l'ICU in uso (America/Buenos_Aires o America/Argentina/Buenos_Aires).
    assert.equal(deep.kind === 'iana' && deep.iana, ianaName('America/Argentina/Buenos_Aires'));
  });

  test('nomi Windows (anche in minuscolo) e nomi visualizzati di Outlook', () => {
    const win = resolveTzid('W. Europe Standard Time');
    assert.equal(win.kind === 'iana' && `${win.iana}|${win.via}`, 'Europe/Berlin|windows');
    assert.equal(windowsToIana('w. europe standard time'), 'Europe/Berlin');
    assert.equal(windowsToIana('Romance Standard Time'), 'Europe/Paris');
    assert.equal(windowsToIana('GMT Standard Time'), 'Europe/London');
    assert.equal(windowsToIana('Eastern Standard Time'), 'America/New_York');
    assert.equal(windowsToIana('India Standard Time'), 'Asia/Kolkata');
    assert.equal(windowsToIana('Fuso inventato'), null);
    for (const display of [
      '(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna',
      '(GMT+01.00) Amsterdam / Berlin / Bern / Rome / Stockholm / Vienna',
    ]) {
      const r = resolveTzid(display);
      assert.equal(r.kind === 'iana' && `${r.iana}|${r.via}`, 'Europe/Berlin|windows-display', display);
    }
    const us = resolveTzid('(UTC-05:00) Eastern Time (US & Canada)');
    assert.equal(us.kind === 'iana' && us.iana, 'America/New_York');
  });

  test('etichette di offset fisso', () => {
    const plus = resolveTzid('GMT+01:00');
    assert.equal(plus.kind === 'iana' && `${plus.iana}|${plus.via}`, 'Etc/GMT-1|offset');
    const minus = resolveTzid('UTC-5');
    assert.equal(minus.kind === 'iana' && minus.iana, 'Etc/GMT+5');
    assert.equal(resolveTzid('UTC+05:30').kind, 'unknown', 'offset non intero: nessun Etc/GMT equivalente');
  });

  test('VTIMEZONE dell\'oggetto per i TZID non IANA, sconosciuto altrimenti', () => {
    const obj = parseCalendarObjectOrThrow(fixture('custom-tz.ics'));
    const custom = resolveTzid('Ora di Roma (personalizzata)', obj.timezones);
    assert.equal(custom.kind, 'custom');
    assert.equal(resolveTzid('Ora di Roma (personalizzata)').kind, 'unknown');
    // Un TZID IANA vince sul VTIMEZONE dell'oggetto, che resta accessibile.
    const apple = parseCalendarObjectOrThrow(fixture('apple-fidelity.ics'));
    const rome = resolveTzid('Europe/Rome', apple.timezones);
    assert.equal(rome.kind, 'iana');
    assert.ok(rome.kind === 'iana' && rome.vtimezone);
  });

  test('resolveZone: Z, floating nel fuso del calendario, TZID sconosciuto con fallback dichiarato', () => {
    assert.deepEqual(resolveZone({ kind: 'utc' }, { tz: 'Europe/Rome' }), { zone: { kind: 'utc' }, fallback: false });
    assert.deepEqual(resolveZone({ kind: 'floating' }, { tz: 'America/New_York' }), { zone: { kind: 'iana', iana: 'America/New_York' }, fallback: false });
    assert.deepEqual(resolveZone({ kind: 'tzid', tzid: 'Boh' }, { tz: 'Europe/Rome' }), { zone: { kind: 'iana', iana: 'Europe/Rome' }, fallback: true });
    assert.deepEqual(resolveZone({ kind: 'tzid', tzid: 'UTC' }, { tz: 'Europe/Rome' }).zone, { kind: 'utc' });
  });

  test('TZID uguali ai nomi di Object.prototype: sconosciuti, mai funzioni del prototype', () => {
    for (const tzid of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '(UTC+01:00) constructor', '(UTC) __proto__', '(GMT) toString']) {
      assert.equal(windowsToIana(tzid), null, tzid);
      assert.deepEqual(resolveTzid(tzid), { kind: 'unknown', tzid }, tzid);
      assert.equal(resolveZone({ kind: 'tzid', tzid }, { tz: 'Europe/Rome' }).fallback, true, tzid);
    }
    assert.equal(ianaName(undefined as unknown as string), null);
    assert.equal(windowsToIana(42 as unknown as string), null);
    // L'oggetto resta leggibile, serializzabile e con un fingerprint; l'espansione usa il fuso del calendario.
    const obj = parseCalendarObjectOrThrow(
      ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:proto@x', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=constructor:20261012T090000', 'DTEND;TZID=constructor:20261012T100000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:x', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'),
    );
    const ctx = { tz: 'Europe/Rome', timezones: obj.timezones };
    assert.match(semanticFingerprint(obj), /^v\d+:[0-9a-f]{64}$/);
    assert.match(serializeObject(obj), /DTSTART;TZID=constructor:20261012T090000/);
    assert.equal(toLegacyEventFields(obj.master as never, ctx).start_time, '2026-10-12T07:00:00.000Z');
    const exp = expandObject(obj, { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 11, 1), tz: 'Europe/Rome' });
    assert.equal(exp.health, 'ok');
    assert.equal(exp.occurrences.length, 2);
  });

  test('nomi IANA validi e non validi', () => {
    assert.ok(isValidIanaZone('Europe/Rome'));
    assert.ok(isValidIanaZone('UTC'));
    assert.ok(!isValidIanaZone('+01:00'));
    assert.ok(!isValidIanaZone(''));
    assert.ok(!isValidIanaZone('Europa/Roma'));
    assert.equal(ianaName('europe/rome'), 'Europe/Rome');
    assert.throws(() => ianaZone('Europa/Roma'), (err: unknown) => err instanceof TimezoneError && err.code === 'UNKNOWN_TIMEZONE');
    assert.equal(DEFAULT_TZ, 'Europe/Rome');
  });
});

describe('VTIMEZONE canonici', () => {
  test('Europe/Rome dal registro pinnato, senza LAST-MODIFIED', () => {
    assert.equal(CANONICAL_TZ_SOURCE, 'timezones-ical-library@2.3.2');
    const vtz = canonicalVtimezone('Europe/Rome');
    assert.ok(vtz);
    assert.equal(vtimezoneTzid(vtz), 'Europe/Rome');
    assert.equal(getProperty(vtz, 'X-LIC-LOCATION')?.value, 'Europe/Rome');
    assert.equal(getProperty(vtz, 'LAST-MODIFIED'), null);
    assert.deepEqual(vtz.components.map((c) => c.name), ['DAYLIGHT', 'STANDARD']);
    assert.equal(getProperty(vtz.components[0], 'RRULE')?.value, 'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU');
  });

  test('TZID impostato dal chiamante, copie indipendenti, fusi sconosciuti → null', () => {
    const a = canonicalVtimezone('Europe/Rome', '/mozilla.org/20070129_1/Europe/Rome');
    assert.equal(a && vtimezoneTzid(a), '/mozilla.org/20070129_1/Europe/Rome');
    a!.properties.length = 0;
    assert.equal(vtimezoneTzid(canonicalVtimezone('Europe/Rome')!), 'Europe/Rome');
    assert.equal(canonicalVtimezone('Fuso/Inesistente'), null);
    assert.ok(canonicalVtimezone('america/new_york'));
    assert.ok(listCanonicalTimezones().length > 400);
    assert.ok(listCanonicalTimezones().includes('Europe/Rome'));
  });
});

describe('conversioni', () => {
  test('Roma: ora legale e solare', () => {
    assert.equal(iso(zonedToUtc(wall(2026, 7, 1, 9), 'Europe/Rome')), '2026-07-01T07:00:00.000Z');
    assert.equal(iso(zonedToUtc(wall(2026, 1, 15, 9), 'Europe/Rome')), '2026-01-15T08:00:00.000Z');
    assert.deepEqual(utcToZoned(Date.UTC(2026, 6, 1, 7), 'Europe/Rome'), wall(2026, 7, 1, 9));
  });

  test('orario inesistente: offset precedente al buco (RFC 5545 §3.3.5)', () => {
    assert.equal(iso(zonedToUtc(wall(2026, 3, 29, 2, 30), 'Europe/Rome')), '2026-03-29T01:30:00.000Z');
    assert.deepEqual(utcToZoned(Date.UTC(2026, 2, 29, 1, 30), 'Europe/Rome'), wall(2026, 3, 29, 3, 30));
    assert.equal(iso(zonedToUtc(wall(2026, 3, 8, 2, 30), 'America/New_York')), '2026-03-08T07:30:00.000Z');
  });

  test('orario ambiguo: prima occorrenza (ora legale)', () => {
    assert.equal(iso(zonedToUtc(wall(2026, 10, 25, 2, 30), 'Europe/Rome')), '2026-10-25T00:30:00.000Z');
    assert.equal(iso(zonedToUtc(wall(2026, 11, 1, 1, 30), 'America/New_York')), '2026-11-01T05:30:00.000Z');
  });

  test('transizione al secondo esatto (cache per giorno)', () => {
    const t = Date.UTC(2026, 9, 25, 1, 0, 0);
    assert.equal(offsetAt(t - 1000, 'Europe/Rome'), 2 * H);
    assert.equal(offsetAt(t, 'Europe/Rome'), 1 * H);
    assert.deepEqual(utcToZoned(t - 1000, 'Europe/Rome'), wall(2026, 10, 25, 2, 59, 59));
    assert.deepEqual(utcToZoned(t, 'Europe/Rome'), wall(2026, 10, 25, 2, 0, 0));
  });

  test('storia completa da Intl (nessun offset 0 prima del 1970, a differenza di ical.js)', () => {
    assert.equal(offsetAt(Date.UTC(1960, 6, 1, 12), 'Europe/Rome'), 1 * H);
    assert.equal(iso(zonedToUtc(wall(1960, 7, 1, 9), 'Europe/Rome')), '1960-07-01T08:00:00.000Z');
  });

  test('VTIMEZONE personalizzati via ical.js, con le stesse regole RFC', () => {
    const obj = parseCalendarObjectOrThrow(fixture('custom-tz.ics'));
    const z = (tzid: string): ConvertibleZone => resolveZone({ kind: 'tzid', tzid }, { tz: 'UTC', timezones: obj.timezones }).zone;
    const rome = z('Ora di Roma (personalizzata)');
    assert.equal(rome.kind, 'custom');
    assert.equal(iso(zonedToUtc(wall(2026, 7, 1, 9), rome)), '2026-07-01T07:00:00.000Z');
    assert.equal(iso(zonedToUtc(wall(2026, 1, 15, 9), rome)), '2026-01-15T08:00:00.000Z');
    assert.equal(iso(zonedToUtc(wall(2026, 3, 29, 2, 30), rome)), '2026-03-29T01:30:00.000Z');
    assert.equal(iso(zonedToUtc(wall(2026, 10, 25, 2, 30), rome)), '2026-10-25T00:30:00.000Z');
    assert.deepEqual(utcToZoned(Date.UTC(2026, 6, 1, 7), rome), wall(2026, 7, 1, 9));
    const fixed = z('Fuso fisso +0530');
    assert.equal(iso(zonedToUtc(wall(2026, 7, 1, 14, 30), fixed)), '2026-07-01T09:00:00.000Z');
  });

  test('VTIMEZONE rotto → TimezoneError tipizzato', () => {
    const broken: ConvertibleZone = {
      kind: 'custom',
      tzid: 'Rotto',
      vtimezone: {
        name: 'VTIMEZONE',
        properties: [{ name: 'TZID', params: [], value: 'Rotto' }],
        components: [{ name: 'STANDARD', properties: [{ name: 'DTSTART', params: [], value: 'non-una-data' }, { name: 'TZOFFSETFROM', params: [], value: 'x' }, { name: 'TZOFFSETTO', params: [], value: 'y' }], components: [] }],
      },
    };
    assert.throws(() => zonedToUtc(wall(2026, 1, 1, 9), broken), (err: unknown) => err instanceof TimezoneError && err.code === 'INVALID_VTIMEZONE');
  });

  test('VTIMEZONE di forma non reale (regole non annuali, BY* abbondanti, costo eccessivo) → INVALID_VTIMEZONE in poche decine di ms', () => {
    const bomb = (rules: string[], dtstart = '19700101T000000', subs = 1): ConvertibleZone => ({
      kind: 'custom',
      tzid: 'Bomba',
      vtimezone: {
        name: 'VTIMEZONE',
        properties: [{ name: 'TZID', params: [], value: 'Bomba' }],
        components: Array.from({ length: subs }, () => ({
          name: 'STANDARD',
          properties: [
            { name: 'DTSTART', params: [], value: dtstart },
            { name: 'TZOFFSETFROM', params: [], value: '+0100' },
            { name: 'TZOFFSETTO', params: [], value: '+0100' },
            ...rules.map((r) => ({ name: 'RRULE', params: [], value: r })),
          ],
          components: [],
        })),
      },
    });
    const cases: Array<[string, ConvertibleZone]> = [
      ['DAILY', bomb(['FREQ=DAILY'])],
      ['HOURLY', bomb(['FREQ=HOURLY'])],
      ['MINUTELY', bomb(['FREQ=MINUTELY'])],
      ['SECONDLY', bomb(['FREQ=SECONDLY'])],
      ['DAILY 9999', bomb(['FREQ=DAILY'], '99990101T000000')],
      ['BY* abbondanti', bomb([`FREQ=YEARLY;BYMONTH=${Array.from({ length: 12 }, (_, i) => i + 1).join(',')};BYMONTHDAY=1,2,3;BYHOUR=0,1,2`])],
      ['BYHOUR', bomb(['FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;BYHOUR=2'])],
      ['INTERVAL', bomb(['FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYDAY=-1SU'])],
      ['64+ sottocomponenti', bomb(['FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU'], '19700101T000000', 65)],
      ['costo dal 0001', bomb(['FREQ=YEARLY;BYMONTH=3,10;BYDAY=SU'], '00010101T000000', 4)],
    ];
    for (const [label, zone] of cases) {
      const t = Date.now();
      assert.throws(() => zonedToUtc(wall(2026, 1, 1, 9), zone), (err: unknown) => err instanceof TimezoneError && err.code === 'INVALID_VTIMEZONE', label);
      assert.ok(Date.now() - t < 200, `${label}: ${Date.now() - t} ms`);
    }
    // Le forme reali passano: Outlook (DTSTART 1601, INTERVAL=1), Thunderbird, il registro.
    const outlook = bomb(['FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10'], '16010101T030000', 2);
    assert.equal(offsetAt(Date.UTC(2026, 0, 1), outlook), H);
  });

  test('istanti oltre la copertura (anno 2150, 9999): anno equivalente, stessi cambi d\'ora del fuso IANA, tempo limitato', () => {
    const obj = parseCalendarObjectOrThrow(fixture('custom-tz.ics'));
    const rome = resolveZone({ kind: 'tzid', tzid: 'Ora di Roma (personalizzata)' }, { tz: 'UTC', timezones: obj.timezones }).zone;
    const lastSunday = (year: number, month: number): number => {
      const d = new Date(Date.UTC(year, month, 0));
      return d.getUTCDate() - d.getUTCDay();
    };
    for (const year of [2150, 2399, 2400]) {
      for (const [month, day, hour] of [[1, 15, 9], [7, 1, 9], [3, lastSunday(year, 3), 1], [3, lastSunday(year, 3), 4], [10, lastSunday(year, 10), 0], [10, lastSunday(year, 10), 4]] as const) {
        const w = wall(year, month, day, hour);
        assert.equal(zonedToUtc(w, rome), zonedToUtc(w, 'Europe/Rome'), `${year}-${month}-${day} ${hour}`);
      }
    }
    const t = Date.now();
    assert.equal(iso(zonedToUtc(wall(9999, 7, 1, 9), rome)), '9999-07-01T07:00:00.000Z');
    assert.equal(iso(zonedToUtc(wall(9999, 1, 15, 9), rome)), '9999-01-15T08:00:00.000Z');
    assert.ok(Date.now() - t < 200, `${Date.now() - t} ms`);
  });

  test('getIcalTimezone per IANA e per VTIMEZONE personalizzati', () => {
    const tz = getIcalTimezone('Europe/Rome');
    const t = ICAL.Time.fromData({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, isDate: false }, tz);
    assert.equal(tz.utcOffset(t), 7200);
    assert.equal(getIcalTimezone({ kind: 'utc' }), ICAL.Timezone.utcTimezone);
  });
});
