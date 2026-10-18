/**
 * Viste dell'API admin del calendario v2 (lib/calendar/v2/view.ts; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §3.4, §4, §5.3), senza
 * database né Radicale.
 *
 * Casi: viste costruite dalle fixture dei client (Apple, Google, Thunderbird,
 * Outlook, DAVx5) con campi tipizzati, VALARM decodificati, proprietà non
 * tipizzate (X-* comprese), campi in sola lettura, componenti, anteprima della
 * ricorrenza; token di base (formato, stabilità, indipendenza dall'ordine,
 * proprietà assenti, un solo token cambia con un solo campo); oggetto
 * illeggibile; note e motivi di sola lettura; test di tipo: i DTO di
 * @calicchia/shared sono assegnabili da e verso i tipi di calendar-core.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  applyComponentOps,
  type CalendarObject,
  cloneComponent,
  type IcsComponent,
  type IcsDuration,
  type IcsProperty,
  type IcsTime,
  parseCalendarObject,
  type PatchFieldValues,
  readFieldValues,
} from '@calicchia/calendar-core';
import {
  CAL_V2_ABSENT_TOKEN,
  CAL_V2_FIELDS,
  CAL_V2_RESERVED_PROPERTIES,
  type CalV2Component,
  type CalV2Duration,
  type CalV2FieldValues,
  type CalV2Property,
  type CalV2Time,
} from '@calicchia/shared';
import { splitIcsFeed } from '../../src/lib/calendar/ics-split';
import { buildComponentView, buildObjectView, buildPreview, type ObjectViewContext, tokenFor } from '../../src/lib/calendar/v2/view';

const FIXTURES = resolve(import.meta.dirname, '../../../../packages/calendar-core/test/fixtures');
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');
const NOW = new Date('2026-10-17T10:00:00Z');
const TZ = 'Europe/Rome';

function parse(raw: string): CalendarObject {
  const res = parseCalendarObject(raw);
  assert.ok(res.ok, res.ok ? '' : res.error.message);
  return res.value;
}

function ctx(over: Partial<ObjectViewContext> = {}): ObjectViewContext {
  return {
    objectId: 'obj-1',
    calendarId: 'cal-1',
    calendarTz: TZ,
    href: 'evento.ics',
    etag: '"e1"',
    source: 'radicale',
    health: 'ok',
    healthReason: null,
    collectionHealth: 'healthy',
    provenance: { source: 'manual', source_id: null },
    readonlyReason: null,
    deleteBlockedReason: null,
    notices: [],
    componentIds: new Map(),
    now: NOW,
    ...over,
  };
}

function view(raw: string, targetKey: string | null = null, over: Partial<ObjectViewContext> = {}) {
  return buildObjectView(raw, parse(raw), null, targetKey, ctx(over));
}

const minutes = (m: number): IcsDuration => ({ negative: true, weeks: 0, days: 0, hours: 0, minutes: m, seconds: 0 });

describe('vista dalle fixture dei client', () => {
  test('Apple: campi, VALARM, ATTENDEE, proprietà non tipizzate e componenti conservati', () => {
    const v = view(fixture('apple-fidelity.ics'));
    assert.equal(v.component_type, 'VEVENT');
    assert.equal(v.uid, '6B29FC40-CA47-1067-B31D-00DD010662DA');
    assert.equal(v.recurring, true);
    assert.equal(v.readonly_reason, null);
    assert.equal(v.etag, '"e1"');
    const m = v.master;
    assert.ok(m);
    assert.equal(m.recurrence_key, '');
    assert.equal(m.component_id, 'obj-1');
    assert.equal(m.is_override, false);
    assert.equal(m.fields.summary, 'Visita al Colosseo con Mario');
    assert.equal(m.fields.rrule, 'FREQ=WEEKLY;COUNT=10;BYDAY=MO');
    assert.equal(m.fields.transp, 'OPAQUE');
    assert.deepEqual(m.fields.start, { type: 'date-time', year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } });
    assert.equal(m.start_utc, '2026-10-12T07:00:00.000Z');
    assert.equal(m.end_utc, '2026-10-12T08:30:00.000Z');
    assert.equal(m.all_day, false);
    assert.deepEqual([m.readonly.uid, m.readonly.sequence], ['6B29FC40-CA47-1067-B31D-00DD010662DA', 3]);
    assert.equal(m.readonly.dtstamp?.year, 2026);
    assert.equal(m.readonly.created?.day, 30);
    assert.equal(m.readonly.last_modified?.hour, 8);
    assert.equal(m.readonly.recurrence_id, null);

    // VALARM decodificati.
    assert.equal(m.alarms.length, 2);
    assert.deepEqual(m.alarms[0], {
      index: 0,
      action: 'AUDIO',
      trigger: { kind: 'relative', related: 'START', offset: minutes(15) },
      description: null,
      summary: null,
      attendees: [],
      repeat: null,
      duration: null,
      apple_default: true,
      uid: '1C1C4B9B-4B1A-4E4E-9E0F-1A2B3C4D5E6F',
    });
    assert.equal(m.alarms[1].action, 'EMAIL');
    assert.deepEqual(m.alarms[1].trigger, { kind: 'relative', related: 'END', offset: { negative: false, weeks: 0, days: 1, hours: 0, minutes: 0, seconds: 0 } });
    assert.deepEqual([m.alarms[1].summary, m.alarms[1].description, m.alarms[1].attendees, m.alarms[1].apple_default], ['Promemoria', 'Tra un giorno', ['mailto:info@calicchia.test'], false]);
    assert.equal(m.fields.alarms.length, 2, 'fields.alarms ha i VALARM completi');

    // Organizzatore e invitati con tutti i parametri.
    assert.equal(m.organizer?.value, 'mailto:info@calicchia.test');
    assert.equal(m.organizer?.cn, 'Calicchia, Federico');
    assert.equal(m.attendees.length, 2);
    assert.equal(m.attendees[0].cn, 'Rossi, Mario');
    assert.ok(m.attendees[0].params.some((p) => p.name === 'X-NUM-GUESTS'), 'parametri sconosciuti conservati');
    assert.ok(v.notices.includes('no_scheduling'));

    // Proprietà non tipizzate, per nome e nell'ordine del testo.
    assert.deepEqual(
      Object.keys(m.extra_properties),
      ['X-APPLE-TRAVEL-ADVISORY-BEHAVIOR', 'X-APPLE-STRUCTURED-LOCATION', 'X-CALDES-UNKNOWN-PROP', 'NEWIANAPROP'],
    );
    assert.equal(m.extra_properties['X-CALDES-UNKNOWN-PROP'][0].value, 'valore grezzo con \\, virgola e : due punti');
    assert.deepEqual(m.extra_properties['X-APPLE-STRUCTURED-LOCATION'][0].params.find((p) => p.name === 'X-TITLE')?.values, ['Colosseo']);
    for (const reserved of CAL_V2_RESERVED_PROPERTIES) assert.equal(reserved in m.extra_properties, false, reserved);

    assert.deepEqual(v.other_components, ['X-WR-UNKNOWN-TOP']);
    assert.deepEqual(v.timezones, ['Europe/Rome']);
    assert.ok(v.calendar_properties.some((p) => p.name === 'PRODID' && p.value.includes('Apple')));
    assert.equal(v.parse_error, null);
    assert.ok(v.ics.startsWith('BEGIN:VCALENDAR'));
  });

  test('Apple: override, istanza senza override (pre-immagine) e istanza inesistente', () => {
    const raw = fixture('apple-fidelity.ics');
    const v = view(raw, null, { componentIds: new Map([['', 'obj-1'], ['20261019T070000Z', 'comp-override']]) });
    assert.equal(v.overrides.length, 1);
    const o = v.overrides[0];
    assert.equal(o.recurrence_key, '20261019T070000Z');
    assert.equal(o.is_override, true);
    assert.equal(o.component_id, 'comp-override');
    assert.equal(o.fields.summary, 'Visita al Colosseo (spostata)');
    assert.equal(o.start_utc, '2026-10-19T13:00:00.000Z');
    assert.equal(o.readonly.recurrence_id?.type, 'date-time');

    const instance = view(raw, '20261026T080000Z');
    assert.ok(instance.target);
    assert.equal(instance.target.is_override, false);
    assert.equal(instance.target.component_id, null);
    assert.equal(instance.target.recurrence_key, '20261026T080000Z');
    assert.equal(instance.target.fields.summary, 'Visita al Colosseo con Mario', 'pre-immagine = copia del master all\'istanza');
    assert.equal(instance.target.start_utc, '2026-10-26T08:00:00.000Z');
    assert.equal(instance.target.end_utc, '2026-10-26T09:30:00.000Z');
    assert.equal(instance.target.fields.rrule, null, 'la pre-immagine non ha RRULE');

    assert.equal(view(raw, '20261019T070000Z').target?.is_override, true);
    assert.equal(view(raw, '20261020T070000Z').target, null, 'un martedì non è un\'istanza');
  });

  test('Apple: anteprima della ricorrenza', () => {
    const v = view(fixture('apple-fidelity.ics'));
    assert.ok(v.preview);
    assert.equal(v.preview.rrule_summary, 'Ogni settimana il lunedì, per 10 volte');
    assert.equal(v.preview.instances_in_horizon, 10);
    assert.equal(v.preview.truncated, false);
    assert.equal(v.preview.next.length, 9);
    assert.equal(v.preview.next[0].recurrence_key, '20261019T070000Z');
    assert.equal(v.preview.next[0].is_override, true);
    assert.equal(v.preview.next[1].is_override, false);
    const fromTarget = view(fixture('apple-fidelity.ics'), '20261102T080000Z');
    assert.equal(fromTarget.preview?.next[0].recurrence_key, '20261102T080000Z', 'l\'anteprima parte dall\'istanza del target');
  });

  test('Thunderbird: TZID di Mozilla, VALARM con VALUE=DURATION e X-MOZ-*', () => {
    const v = view(fixture('thunderbird-mozilla-tz.ics'));
    assert.equal(v.recurring, false);
    assert.equal(v.preview, null);
    const m = v.master;
    assert.ok(m);
    assert.equal(m.fields.summary, 'Revisione preventivi');
    assert.equal(m.start_utc, '2026-11-03T13:30:00.000Z');
    assert.equal(m.end_utc, '2026-11-03T14:30:00.000Z');
    assert.deepEqual(m.alarms[0].trigger, { kind: 'relative', related: 'START', offset: minutes(10) });
    assert.equal(m.alarms[0].description, 'Default Mozilla Description');
    assert.deepEqual(Object.keys(m.extra_properties), ['X-MOZ-GENERATION', 'X-MOZ-LASTACK', 'X-MOZ-SEND-INVITATIONS']);
    assert.equal(v.overrides.length, 0);
  });

  test('Outlook: fuso di Windows, priorità, classe e X-MICROSOFT-*', () => {
    const v = view(fixture('outlook-windows-tz.ics'));
    const m = v.master;
    assert.ok(m);
    assert.equal(m.fields.summary, 'Avanzamento progetto');
    assert.equal(m.fields.location, 'Microsoft Teams');
    assert.equal(m.fields.priority, 5);
    assert.equal(m.fields.class, 'PUBLIC');
    assert.equal(m.fields.transp, 'OPAQUE');
    assert.equal(m.start_utc, '2026-11-10T09:00:00.000Z');
    assert.equal(m.fields.start.type, 'date-time');
    assert.ok(m.fields.description?.startsWith('Riunione di avanzamento'));
    assert.deepEqual(Object.keys(m.extra_properties).sort(), [
      'X-MICROSOFT-CDO-BUSYSTATUS', 'X-MICROSOFT-CDO-IMPORTANCE', 'X-MICROSOFT-DISALLOW-COUNTER', 'X-MS-OLK-AUTOFILLLOCATION', 'X-MS-OLK-CONFTYPE',
    ]);
    assert.equal(m.alarms[0].action, 'DISPLAY');
  });

  test('Google: serie con override, tutto il giorno trasparente e ora locale (floating)', () => {
    const split = splitIcsFeed(fixture('google-feed.ics'));
    const byUid = (uid: string) => {
      const o = split.objects.find((x) => x.uid === uid);
      assert.ok(o, uid);
      return o;
    };
    const ny = view(byUid('ny-standup@google.com').raw);
    assert.equal(ny.recurring, true);
    assert.equal(ny.overrides.length, 1);
    assert.equal(ny.overrides[0].recurrence_key, '20261007T130000Z');
    assert.equal(ny.overrides[0].fields.summary, 'Standup NY (spostato)');
    assert.equal(ny.preview?.rrule_summary, 'Ogni giorno, per 5 volte');
    assert.deepEqual(ny.timezones, ['America/New_York']);

    const natale = view(byUid('natale-2026@google.com').raw);
    assert.equal(natale.master?.all_day, true);
    assert.equal(natale.master?.fields.transp, 'TRANSPARENT');
    assert.equal(natale.master?.fields.start.type, 'date');

    const floating = view(byUid('floating@google.com').raw);
    assert.equal(floating.master?.fields.start.type === 'date-time' && floating.master.fields.start.zone.kind, 'floating');
    assert.equal(floating.master?.start_utc, '2026-10-15T18:00:00.000Z', 'floating: ora locale del calendario (CEST)');
  });

  test('DAVx5: ricorrenza con INTERVAL e BYDAY, VALARM relativo e assoluto, ATTENDEE con ruoli', () => {
    const v = view(fixture('davx5-android.ics'));
    const m = v.master;
    assert.ok(m);
    assert.equal(m.fields.summary, 'Sopralluogo cantiere');
    assert.equal(m.fields.location, 'Via Roma 12, Perugia');
    assert.equal(m.fields.status, 'CONFIRMED');
    assert.equal(m.fields.class, 'PRIVATE');
    assert.equal(m.readonly.sequence, 2);
    assert.deepEqual(m.alarms[0].trigger, { kind: 'relative', related: 'START', offset: minutes(15) });
    assert.equal(m.alarms[0].description, 'Sopralluogo cantiere');
    assert.equal(m.alarms[1].action, 'EMAIL');
    assert.equal(m.alarms[1].trigger?.kind, 'absolute');
    assert.deepEqual(m.alarms[1].trigger?.kind === 'absolute' && m.alarms[1].trigger.at, { type: 'date-time', year: 2026, month: 10, day: 14, hour: 6, minute: 0, second: 0, zone: { kind: 'utc' } });
    assert.deepEqual(m.alarms[1].attendees, ['mailto:info@calicchia.test']);
    assert.deepEqual(Object.keys(m.extra_properties), ['X-DAVX5-ORIGINAL-ID']);
    assert.deepEqual(m.attendees.map((a) => a.cn), ['Direttore Lavori', 'Impresa Edile']);
    assert.equal(v.overrides[0].recurrence_key, '20261016T130000Z');
    assert.equal(v.overrides[0].fields.summary, 'Sopralluogo cantiere (anticipato)');
    assert.equal(v.preview?.rrule_summary, 'Ogni 2 settimane il mercoledì e il venerdì, per 12 volte');
    assert.equal(v.preview?.instances_in_horizon, 12);
    assert.ok(v.calendar_properties.some((p) => p.name === 'PRODID' && p.value.includes('DAVx5')));
  });
});

describe('token di base', () => {
  const raw = fixture('apple-fidelity.ics');

  test('formato, un token per campo e per proprietà non tipizzata, stabilità', () => {
    const a = view(raw).master;
    const b = view(raw).master;
    assert.ok(a && b);
    assert.deepEqual(a.tokens, b.tokens, 'stesso testo, stessi token');
    for (const f of CAL_V2_FIELDS) assert.match(a.tokens[f], /^[0-9a-f]{16}$/, f);
    for (const name of Object.keys(a.extra_properties)) assert.match(a.tokens[`prop:${name}`], /^[0-9a-f]{16}$/, name);
    assert.equal(Object.keys(a.tokens).length, CAL_V2_FIELDS.length + Object.keys(a.extra_properties).length);
    assert.equal(tokenFor(parse(raw).master as IcsComponent, 'prop:X-NON-ESISTE'), CAL_V2_ABSENT_TOKEN);
    assert.equal(CAL_V2_ABSENT_TOKEN, '-');
  });

  test('cambiare un campo cambia solo il suo token (DTSTAMP e LAST-MODIFIED non contano)', () => {
    const obj = parse(raw);
    const before = buildComponentView(obj, '', { tz: TZ, now: NOW, componentId: null });
    const master = obj.master as IcsComponent;
    applyComponentOps(master, [{ op: 'set', field: 'summary', value: 'Altro titolo' }], { tz: TZ, now: new Date('2026-10-18T09:00:00Z'), timezones: obj.timezones });
    const after = buildComponentView(obj, '', { tz: TZ, now: NOW, componentId: null });
    assert.ok(before && after);
    const changed = Object.keys(after.tokens).filter((k) => after.tokens[k] !== before.tokens[k]);
    assert.deepEqual(changed, ['summary']);
  });

  test('categorie in ordine diverso e invitati riordinati hanno lo stesso token', () => {
    const obj = parse(raw);
    const master = obj.master as IcsComponent;
    const clone = cloneComponent(master);
    applyComponentOps(master, [{ op: 'set', field: 'categories', value: ['uno', 'due'] }], { tz: TZ, now: NOW, timezones: obj.timezones });
    applyComponentOps(clone, [{ op: 'set', field: 'categories', value: ['due', 'uno'] }], { tz: TZ, now: NOW, timezones: obj.timezones });
    assert.equal(tokenFor(master, 'categories'), tokenFor(clone, 'categories'));
    const reversed = cloneComponent(master);
    const attendees = reversed.properties.filter((p) => p.name === 'ATTENDEE');
    reversed.properties = [...reversed.properties.filter((p) => p.name !== 'ATTENDEE'), ...attendees.reverse()];
    assert.equal(tokenFor(reversed, 'attendees'), tokenFor(master, 'attendees'));
    applyComponentOps(clone, [{ op: 'set', field: 'categories', value: ['uno'] }], { tz: TZ, now: NOW, timezones: obj.timezones });
    assert.notEqual(tokenFor(master, 'categories'), tokenFor(clone, 'categories'));
  });

  test('una proprietà non tipizzata cambia token con il suo valore', () => {
    const obj = parse(raw);
    const master = obj.master as IcsComponent;
    const before = tokenFor(master, 'prop:X-APPLE-TRAVEL-ADVISORY-BEHAVIOR');
    const clone = cloneComponent(master);
    (clone.properties.find((p) => p.name === 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR') as IcsProperty).value = 'DISABLED';
    assert.notEqual(tokenFor(clone, 'prop:X-APPLE-TRAVEL-ADVISORY-BEHAVIOR'), before);
    assert.equal(tokenFor(clone, 'prop:x-apple-travel-advisory-behavior'), tokenFor(clone, 'prop:X-APPLE-TRAVEL-ADVISORY-BEHAVIOR'), 'il nome non distingue le maiuscole');
  });
});

describe('oggetti illeggibili, note e motivi di sola lettura', () => {
  test('testo non interpretabile: nessun componente, sola lettura "unreadable", testo così com\'è', () => {
    const raw = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:rotto-1\r\nEND:VCALENDAR\r\n';
    const v = buildObjectView(raw, null, 'VEVENT senza END', null, ctx());
    assert.equal(v.master, null);
    assert.deepEqual(v.overrides, []);
    assert.equal(v.target, null);
    assert.equal(v.readonly_reason, 'unreadable');
    assert.equal(v.ics, raw);
    assert.equal(v.uid, 'rotto-1');
    assert.equal(v.parse_error, 'VEVENT senza END');
    assert.equal(v.preview, null);
  });

  test('note: prenotazione, ripiego sull\'indice, collezione in hold; motivi dal contesto', () => {
    const raw = fixture('thunderbird-mozilla-tz.ics');
    const v = view(raw, null, {
      source: 'index',
      collectionHealth: 'hold',
      provenance: { source: 'booking', source_id: 'abc' },
      readonlyReason: 'archive',
      deleteBlockedReason: 'booking_active',
    });
    assert.deepEqual([...v.notices].sort(), ['booking_projection', 'collection_hold', 'index_fallback']);
    assert.equal(v.readonly_reason, 'archive');
    assert.equal(v.delete_blocked_reason, 'booking_active');
    assert.equal(v.source, 'index');
    assert.deepEqual(v.provenance, { source: 'booking', source_id: 'abc' });
  });

  test('VTODO: component_unsupported', () => {
    const raw = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//EN', 'BEGIN:VTODO', 'UID:t1', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261020T090000Z', 'SUMMARY:Da fare', 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n');
    const v = view(raw);
    assert.equal(v.component_type, 'VTODO');
    assert.equal(v.readonly_reason, 'component_unsupported');
  });

  test('buildPreview: null per un evento singolo', () => {
    assert.equal(buildPreview(parse(fixture('thunderbird-mozilla-tz.ics')), { tz: TZ, now: NOW }), null);
  });
});

// ─── Test di tipo: i DTO sono assegnabili da e verso calendar-core (§4) ───────────────────────────────

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const typeChecks: {
  time: Mutual<CalV2Time, IcsTime>;
  duration: Mutual<CalV2Duration, IcsDuration>;
  property: Mutual<CalV2Property, IcsProperty>;
  component: Mutual<CalV2Component, IcsComponent>;
  fields: Mutual<CalV2FieldValues, PatchFieldValues>;
} = { time: true, duration: true, property: true, component: true, fields: true };

describe('DTO condivisi e calendar-core', () => {
  test('i tipi sono assegnabili da e verso calendar-core (verificato dal typecheck)', () => {
    assert.deepEqual(Object.values(typeChecks), [true, true, true, true, true]);
  });

  test('CAL_V2_FIELDS coincide con i campi di PatchFieldValues', () => {
    const parsedObj = parse(fixture('apple-fidelity.ics'));
    const fields = Object.keys(readFieldValues(parsedObj.master as IcsComponent)).sort();
    assert.deepEqual([...CAL_V2_FIELDS].sort(), fields);
  });

  test('assegnazioni esplicite nei due versi', () => {
    const t: CalV2Time = { type: 'date', year: 2027, month: 1, day: 1 };
    const core: IcsTime = t;
    const back: CalV2Time = core;
    const f = {} as PatchFieldValues;
    const wire: CalV2FieldValues = f;
    const again: PatchFieldValues = wire;
    assert.equal(back.type, 'date');
    assert.ok(again !== undefined);
  });
});
