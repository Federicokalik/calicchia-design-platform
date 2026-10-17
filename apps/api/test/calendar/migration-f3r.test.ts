/**
 * Correzioni della revisione della F3 (AREA A: serializer, piano), senza
 * database né Radicale: serializeLegacy e computePlan su sorgenti, ledger e
 * destinazioni costruiti a mano (stessa impostazione di migration-plan.test.ts).
 *
 *  - F3R-1: serie con il DTSTART fuori dalla regola. rrule.js (legacy) e
 *    dateutil (Radicale) non contano il DTSTART che non soddisfa la RRULE,
 *    RFC 5545 (calendar-core, device, feed) sì: l'oggetto migrato parte dalla
 *    prima occorrenza legacy con la stessa durata (COUNT invariato), con
 *    l'anomalia DTSTART_NOT_IN_RULE nell'anteprima e il motivo atteso
 *    DTSTART_REALIGNED (V5) con il suo ambito;
 *  - F3R-2 / F3R-SHD-01: proiezione che supera i 24 mesi fra due giri: la
 *    ricostruzione dello snapshot precedente non si minimizza col tempo, la
 *    patch riscrive SUMMARY e DESCRIPTION e lo shadow propone un update
 *    (prima: adozione senza scrivere, nome e telefono restavano sui device);
 *  - F3R-4: riga scritta senza etag registrato (fingerprint sì): resta
 *    "scritta" (delete con la fonte sparita, update con la fonte cambiata);
 *  - F3R-5: "forza" legata ai conflitti dell'anteprima (chiave, codice, etag);
 *  - F3R-SHD-02: erasure GDPR su una riga da rivalidare: update con la patch
 *    senza base, mai REVALIDATION_REQUIRED;
 *  - F3R6-01: collezione con un'altra calendar-id: COLLECTION_MISSING, mai
 *    forzabile, nessuna scrittura.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { expandObject, getProperty, getTextValue, parseCalendarObject, readTimeProperty, semanticFingerprint } from '@calicchia/calendar-core';
import { expandRRule } from '../../src/lib/calendar/legacy/rrule-legacy';
import { computePlan, type PlanInput, planItemKey, type TargetCollection, type TargetSnapshot } from '../../src/lib/calendar/migration/plan';
import {
  buildObjectFromSnapshot,
  expectedReasonScopes,
  type LegacySource,
  patchFromLegacyDiff,
  serializeLegacy,
} from '../../src/lib/calendar/migration/serialize';
import {
  ANOMALY_DEFINITIONS,
  DEFAULT_MIGRATION_OPTIONS,
  EXPECTED_DIFF_REASONS,
  type LedgerRow,
  type LegacyEventSnapshot,
  type LegacyKey,
  type MigrationCalendar,
  type PlanItem,
  type PlanMode,
  type SerializationResult,
  type SerializedObject,
  type TargetObject,
} from '../../src/lib/calendar/migration/types';

const NOW = new Date('2026-10-16T10:00:00.000Z');
const CAL_A = 'c1000000-0000-4000-8000-00000000000a';
const CAL_B = 'c1000000-0000-4000-8000-00000000000b';
const CAL_BK = 'c1000000-0000-4000-8000-0000000000bc';
const DAY = 86_400_000;
const MODES: PlanMode[] = ['apply', 'shadow'];
const OPTIONS = { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] };

function calendar(id: string, slug: string, extra: Partial<MigrationCalendar> = {}): MigrationCalendar {
  return {
    id, slug, name: slug, description: null, color: '#7c3aed', timezone: 'Europe/Rome', sort_order: 0,
    is_default: false, is_system: false, blocks_availability: true, ics_feed_enabled: true, collection_name: slug,
    role: 'user', origin: 'admin', lifecycle: 'active', device_visible: true, included: true, excluded_reason: null,
    ...extra,
  };
}

const CALENDARS: MigrationCalendar[] = [
  calendar(CAL_A, 'lavoro', { is_default: true }),
  calendar(CAL_B, 'personale'),
  calendar(CAL_BK, 'bookings', { role: 'bookings' }),
];

type EventRow = LegacySource['events'][number];
type BookingRow = LegacySource['bookings'][number];

let seq = 0;
function row(o: Partial<EventRow> & Pick<EventRow, 'start_time' | 'end_time'>): EventRow {
  seq += 1;
  return {
    id: `e1000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, uid: `f3r-${seq}`, calendar_id: CAL_A, summary: `Evento ${seq}`,
    description: null, location: null, url: null, all_day: false, rrule: null, exdates: [],
    recurrence_id: null, recurrence_master_id: null, source: 'admin', source_id: null, status: 'confirmed',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
    ...o,
  };
}

function source(events: EventRow[], bookings: BookingRow[] = [], now = NOW): LegacySource {
  return { read_at: now, calendars: CALENDARS, events, bookings, objectIds: new Map(), ledger: [] };
}

function serialize(events: EventRow[], bookings: BookingRow[] = [], now = NOW): SerializationResult {
  return serializeLegacy(source(events, bookings, now), OPTIONS, { now });
}

function objectOf(result: SerializationResult, key: string): SerializedObject {
  const o = result.objects.find((x) => x.legacy_key === key);
  assert.ok(o, `oggetto ${key} assente dal serializer`);
  return o;
}

const ev = (r: EventRow): LegacyKey => `event:${r.id}` as LegacyKey;

/** Inizi (ISO) dell'oggetto migrato in [from, to), espanso da calendar-core come i device. */
function migratedStarts(o: SerializedObject, from: number, to: number): string[] {
  const parsed = parseCalendarObject(o.ics);
  assert.ok(parsed.ok);
  return expandObject(parsed.value, { from, to, tz: 'Europe/Rome', computeRangeEnd: false }).occurrences.map((x) => new Date(x.startUtc).toISOString());
}

/** Inizi (ISO) del legacy in [from, to) per la riga (listOccurrences: rrule.js in ora flottante di Roma). */
function legacyStarts(r: EventRow, from: number, to: number): string[] {
  return expandRRule({ rrule: r.rrule as string, masterStartIso: r.start_time, fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() })
    .map((iso) => new Date(iso).toISOString());
}

let ledgerSeq = 0;
function written(o: SerializedObject, extra: Partial<LedgerRow> = {}): LedgerRow {
  ledgerSeq += 1;
  return {
    id: String(ledgerSeq), calendar_id: o.calendar_id, collection_name: o.collection_name, href: o.href, kind: o.kind,
    legacy_key: o.legacy_key, legacy_event_id: o.legacy_event_id, uid: o.uid, legacy_snapshot: o.legacy_snapshot,
    legacy_hash: o.legacy_hash, written_etag: '"w1"', written_fingerprint: o.fingerprint, written_at: NOW,
    intent_op: null, intent_fingerprint: null, intent_legacy_hash: null, intent_snapshot: null, intent_etag: null,
    intent_at: null, intent_run_id: null, adopted: false, derived: false, revalidate_reason: null, revalidate_since: null,
    deleted_at: null, last_run_id: null, created_at: NOW, updated_at: NOW,
    ...extra,
  };
}

function targetOf(o: SerializedObject, etag = '"w1"', raw = o.ics): TargetObject {
  const parsed = parseCalendarObject(raw);
  assert.ok(parsed.ok);
  return { calendar_id: o.calendar_id, collection_name: o.collection_name, href: o.href, etag, uid: parsed.value.uid, fingerprint: semanticFingerprint(parsed.value), raw };
}

function snapshot(objects: TargetObject[], opts: { foreign?: Record<string, string>; readAt?: Date } = {}): TargetSnapshot {
  const collections = new Map<string, TargetCollection>();
  for (const c of CALENDARS) {
    const map = new Map<string, TargetObject>();
    for (const t of objects) if (t.calendar_id === c.id) map.set(t.href, t);
    collections.set(c.id, { calendar_id: c.id, collection_name: c.collection_name as string, exists: true, objects: map, foreign: opts.foreign?.[c.id] ?? null });
  }
  return { read_at: opts.readAt ?? NOW, collections };
}

function plan(input: {
  serialization: SerializationResult;
  ledger?: LedgerRow[];
  targets?: TargetObject[];
  mode?: PlanMode;
  foreign?: Record<string, string>;
  readAt?: Date;
  force?: Partial<PlanInput['force']>;
}): PlanItem[] {
  return computePlan({
    mode: input.mode ?? 'apply',
    serialization: input.serialization,
    ledger: input.ledger ?? [],
    target: snapshot(input.targets ?? [], { foreign: input.foreign, readAt: input.readAt }),
    scope: { calendarIds: new Set(CALENDARS.map((c) => c.id)), legacyKeys: null },
    force: { itemKeys: new Set(), codes: new Set(), ...input.force },
  });
}

function itemOf(items: PlanItem[], key: string): PlanItem {
  const found = items.filter((i) => i.legacy_key === key);
  assert.equal(found.length, 1, `atteso un item per ${key}, trovati ${found.length}`);
  return found[0];
}

// ─── F3R-1 ───────────────────────────────

describe('F3R-1: DTSTART fuori dalla regola', () => {
  // Mercoledì 14/10/2026 09:00 di Roma (07:00Z): la regola lun-mar-gio-ven non lo contiene.
  const wed = row({ start_time: '2026-10-14T07:00:00.000Z', end_time: '2026-10-14T08:00:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR' });
  // Mercoledì 21/10 con COUNT: il legacy non conta il DTSTART (23/10, 26/10, 30/10, 02/11).
  const wedCount = row({ start_time: '2026-10-21T07:00:00.000Z', end_time: '2026-10-21T08:00:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO,FR;COUNT=4' });
  // Tutto il giorno: mercoledì 14/10 (mezzanotte di Roma), solo il giovedì, tre volte.
  const allDay = row({ start_time: '2026-10-13T22:00:00.000Z', end_time: '2026-10-14T22:00:00.000Z', all_day: true, rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=3' });
  // Sabato prima del cambio d'ora: la prima occorrenza (lunedì) è in ora solare, stessa ora "da muro".
  const dst = row({ start_time: '2026-10-24T07:00:00.000Z', end_time: '2026-10-24T08:00:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU' });
  // UNTIL prima del primo giorno valido: il legacy non ha nessuna occorrenza.
  const none = row({ start_time: '2026-10-14T07:00:00.000Z', end_time: '2026-10-14T08:00:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261018T215959Z' });
  // Allineata (lunedì): nessuna anomalia, snapshot invariato.
  const aligned = row({ start_time: '2026-10-12T07:00:00.000Z', end_time: '2026-10-12T08:00:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR' });
  // BYDAY misto: resta l'unione RFC (MIXED_BYDAY), niente riallineamento anche con l'intersezione vuota.
  const mixed = row({ start_time: '2026-10-14T07:00:00.000Z', end_time: '2026-10-14T08:00:00.000Z', rrule: 'FREQ=MONTHLY;BYDAY=1MO,FR' });
  const events = [wed, wedCount, allDay, dst, none, aligned, mixed];
  const result = serialize(events);

  test('le occorrenze dell\'oggetto migrato (calendar-core, come i device) coincidono con il legacy, con e senza COUNT, anche tutto il giorno', () => {
    for (const r of [wed, wedCount, allDay, dst]) {
      const o = objectOf(result, ev(r));
      const from = Date.parse(r.start_time) - DAY;
      const to = from + 120 * DAY;
      assert.deepEqual(migratedStarts(o, from, to), legacyStarts(r, from, to), `${r.rrule}${r.all_day ? ' (tutto il giorno)' : ''}`);
      assert.ok(o.anomalies.includes('DTSTART_NOT_IN_RULE'), r.rrule as string);
      assert.ok(o.expected_reasons.includes('DTSTART_REALIGNED'));
      assert.equal((o.legacy_snapshot as LegacyEventSnapshot).options.realign_dtstart, true);
      // Lo snapshot conserva il DTSTART salvato in PG: il riallineamento si ricalcola alla costruzione.
      assert.equal((o.legacy_snapshot as LegacyEventSnapshot).master.start_time, r.start_time);
    }
    const count = objectOf(result, ev(wedCount));
    assert.deepEqual(migratedStarts(count, Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-12-01T00:00:00Z')),
      ['2026-10-23T07:00:00.000Z', '2026-10-26T08:00:00.000Z', '2026-10-30T08:00:00.000Z', '2026-11-02T08:00:00.000Z']);
    assert.match(count.ics, /RRULE:FREQ=WEEKLY;BYDAY=MO,FR;COUNT=4/, 'COUNT invariato');
    assert.match(objectOf(result, ev(wed)).ics, /DTSTART;TZID=Europe\/Rome:20261015T090000/, 'DTSTART sulla prima occorrenza legacy (giovedì 15/10)');
    assert.match(objectOf(result, ev(wed)).ics, /DTEND;TZID=Europe\/Rome:20261015T100000/, 'stessa durata');
    assert.match(objectOf(result, ev(allDay)).ics, /DTSTART;VALUE=DATE:20261015/);
  });

  test('anteprima: anomalia DTSTART_NOT_IN_RULE con le prime occorrenze legacy e quelle RFC dal DTSTART salvato', () => {
    const [a] = result.anomalies.filter((x) => x.code === 'DTSTART_NOT_IN_RULE' && x.legacy_key === ev(wed));
    assert.ok(a, 'anomalia nell\'anteprima');
    assert.equal(a.severity, ANOMALY_DEFINITIONS.DTSTART_NOT_IN_RULE.severity);
    assert.equal(a.detail.dtstart_from, wed.start_time);
    assert.equal(a.detail.dtstart_to, '2026-10-15T07:00:00.000Z');
    assert.equal((a.detail.legacy as string[])[0], '2026-10-15T07:00:00.000Z');
    assert.equal((a.detail.rfc_from_saved_dtstart as string[])[0], '2026-10-14T07:00:00.000Z', 'l\'istanza in più che RFC 5545 conterebbe');
    assert.ok(EXPECTED_DIFF_REASONS.includes('DTSTART_REALIGNED'));
  });

  test('nessuna occorrenza legacy → salto UNTIL_BEFORE_DTSTART (motivo no_legacy_occurrence); serie allineata e BYDAY misto invariati', () => {
    const skip = result.skipped.find((s) => s.legacy_key === ev(none));
    assert.equal(skip?.code, 'UNTIL_BEFORE_DTSTART');
    const [a] = result.anomalies.filter((x) => x.code === 'UNTIL_BEFORE_DTSTART' && x.legacy_key === ev(none));
    assert.equal(a?.detail.reason, 'no_legacy_occurrence');
    const ok = objectOf(result, ev(aligned));
    assert.equal(ok.anomalies.includes('DTSTART_NOT_IN_RULE'), false);
    assert.deepEqual((ok.legacy_snapshot as LegacyEventSnapshot).options, {});
    const m = objectOf(result, ev(mixed));
    assert.equal(m.anomalies.includes('DTSTART_NOT_IN_RULE'), false);
    assert.ok(m.anomalies.includes('MIXED_BYDAY'));
    assert.match(m.ics, /DTSTART;TZID=Europe\/Rome:20261014T090000/);
  });

  test('uno snapshot senza il riallineamento (scritto prima della correzione) ricostruisce lo scritto, e la patch per campo sposta il DTSTART', () => {
    const o = objectOf(result, ev(wed));
    const current = o.legacy_snapshot as LegacyEventSnapshot;
    const old: LegacyEventSnapshot = { ...current, options: {} };
    const oldBuilt = buildObjectFromSnapshot(old, { now: NOW });
    const start = readTimeProperty(getProperty(oldBuilt.object.master!, 'DTSTART')!);
    assert.equal(start.day, 14, 'ricostruzione fedele allo scritto (DTSTART del mercoledì)');
    const patch = patchFromLegacyDiff(oldBuilt.object, old, current, { tz: 'Europe/Rome', now: NOW });
    assert.equal(patch.changed, true);
    assert.ok(patch.fields.includes('start'), JSON.stringify(patch.fields));
    // Stesso contenuto dell'oggetto voluto ricostruito dallo snapshot (CREATED e LAST-MODIFIED vengono dalle righe).
    assert.equal(semanticFingerprint(patch.object), buildObjectFromSnapshot(current, { now: NOW }).fingerprint, 'dopo la patch l\'oggetto è quello voluto');
  });

  test('ambito di DTSTART_REALIGNED: l\'istanza del DTSTART salvato e, con COUNT, l\'ultima occorrenza legacy', () => {
    const scope = expectedReasonScopes(objectOf(result, ev(wedCount)).legacy_snapshot, NOW).get('DTSTART_REALIGNED');
    assert.ok(scope);
    assert.ok(scope.seconds.has(Date.parse(wedCount.start_time) / 1000));
    assert.ok(scope.seconds.has(Date.parse('2026-11-02T08:00:00.000Z') / 1000), 'la quarta occorrenza, che il feed legacy (RFC) perde');
    assert.equal(scope.seconds.has(Date.parse('2026-10-26T08:00:00.000Z') / 1000), false);
  });
});

// ─── F3R-2 / F3R-SHD-01 ───────────────────────────────

describe('F3R-2: proiezione oltre i 24 mesi fra due giri', () => {
  const T1 = new Date('2026-10-16T10:00:00.000Z');
  const T2 = new Date(T1.getTime() + 60_000);
  // Fine della prenotazione: 24 mesi prima di T1 più 40 s (non scaduta a T1, scaduta a T2).
  const end = new Date(T1);
  end.setUTCMonth(end.getUTCMonth() - 24);
  end.setTime(end.getTime() + 40_000);
  const booking: BookingRow = {
    uid: 'f3r-bk-1', status: 'confirmed', start_time: new Date(end.getTime() - 3_600_000).toISOString(), end_time: end.toISOString(),
    title: 'Consulenza', attendee_name: 'Mario Rossi', attendee_phone: '+39 333 1112223', location: null, meeting_url: null,
    created_at: '2024-09-01T00:00:00.000Z', anonymized: false,
  };
  const key = `booking:${booking.uid}`;
  const before = objectOf(serialize([], [booking], T1), key);
  const after = objectOf(serialize([], [booking], T2), key);

  test('la minimizzazione la decide solo lo snapshot: quello precedente, ricostruito dopo la soglia, ha ancora nome e telefono', () => {
    assert.equal((before.legacy_snapshot as { minimized: boolean }).minimized, false);
    assert.equal((after.legacy_snapshot as { minimized: boolean }).minimized, true);
    const rebuilt = buildObjectFromSnapshot(before.legacy_snapshot, { now: T2 });
    assert.equal(getTextValue(rebuilt.object.master!, 'SUMMARY'), 'Consulenza – Mario Rossi');
    assert.equal(rebuilt.fingerprint, before.fingerprint, 'stesso contenuto dello scritto');
    const minimized = parseCalendarObject(after.ics);
    assert.ok(minimized.ok);
    assert.equal(getTextValue(minimized.value.master!, 'SUMMARY'), 'Prenotazione', 'snapshot corrente minimizzato');
  });

  test('patch per campo dallo snapshot precedente: SUMMARY "Prenotazione", niente DESCRIPTION (telefono)', () => {
    const target = parseCalendarObject(before.ics);
    assert.ok(target.ok);
    const p = patchFromLegacyDiff(target.value, before.legacy_snapshot, after.legacy_snapshot, { tz: 'Europe/Rome', now: T2 });
    assert.equal(p.changed, true);
    assert.deepEqual(p.fields.filter((f) => f === 'summary' || f === 'description').sort(), ['description', 'summary']);
    assert.equal(getTextValue(p.object.master!, 'SUMMARY'), 'Prenotazione');
    assert.equal(getTextValue(p.object.master!, 'DESCRIPTION'), null);
  });

  test('shadow e apply sulle righe adottate: update con patch (mai un\'adozione senza scrivere)', () => {
    const s = serialize([], [booking], T2);
    for (const extra of [{}, { adopted: true }]) {
      for (const mode of MODES) {
        const item = itemOf(plan({ serialization: s, mode, ledger: [written(before, extra)], targets: [targetOf(before)], readAt: T2 }), key);
        assert.equal(item.action, 'update', `${mode} ${JSON.stringify(extra)}`);
        if (mode === 'shadow' || 'adopted' in extra) assert.equal(item.patch, true);
      }
    }
  });
});

// ─── Piano: F3R-4, F3R-5, F3R-SHD-02, F3R6-01 ───────────────────────────────

describe('piano: correzioni della revisione', () => {
  const single = row({ start_time: '2026-11-03T09:00:00.000Z', end_time: '2026-11-03T10:00:00.000Z', summary: 'Riunione' });
  const other = row({ calendar_id: CAL_B, start_time: '2026-11-04T15:00:00.000Z', end_time: '2026-11-04T16:00:00.000Z', summary: 'Dentista' });
  const base = [single, other];
  const s0 = serialize(base);
  const o = objectOf(s0, ev(single));
  const o2 = objectOf(s0, ev(other));

  test('F3R-4: scritta senza etag registrato (fingerprint sì): fonte sparita → delete con l\'etag letto; invariata → adopt; cambiata → update', () => {
    const noEtag = written(o, { written_etag: null });
    for (const mode of MODES) {
      const gone = itemOf(plan({ serialization: serialize([other]), mode, ledger: [noEtag], targets: [targetOf(o, '"t9"')] }), ev(single));
      assert.equal(gone.action, 'delete', mode);
      assert.equal(gone.target?.etag, '"t9"');
      const same = itemOf(plan({ serialization: s0, mode, ledger: [noEtag], targets: [targetOf(o, '"t9"')] }), ev(single));
      assert.equal(same.action, 'adopt', mode);
      const changed = itemOf(plan({ serialization: serialize([{ ...single, summary: 'Riunione spostata' }, other]), mode, ledger: [noEtag], targets: [targetOf(o, '"t9"')] }), ev(single));
      assert.equal(changed.action, 'update', mode);
    }
  });

  test('F3R-5: con l\'anteprima la forza vale solo per i conflitti mostrati (stessa chiave, codice ed etag della destinazione)', () => {
    const device = (x: SerializedObject, etag: string) => targetOf(x, etag, x.ics.replace(/SUMMARY:[^\r\n]*/, 'SUMMARY:Cambiato da un device'));
    const targets = [device(o, '"x1"'), device(o2, '"x2"')];
    const ledger = [written(o), written(o2)];
    const unforced = plan({ serialization: s0, ledger, targets });
    const k1 = planItemKey(itemOf(unforced, ev(single)));
    const k2 = planItemKey(itemOf(unforced, ev(other)));
    assert.equal(itemOf(unforced, ev(other)).code, 'TARGET_NEWER');
    // L'anteprima mostrava solo il conflitto di `single`: `other` è nato dopo (per esempio fra due tentativi).
    const preview = new Map([[k1, { code: 'TARGET_NEWER', target_etag: '"x1"' }]]);
    const forced = plan({ serialization: s0, ledger, targets, force: { itemKeys: new Set([k1]), preview } });
    assert.equal(itemOf(forced, ev(single)).action, 'update');
    assert.equal(itemOf(forced, ev(single)).code, 'TARGET_NEWER', 'item forzato');
    assert.equal(itemOf(forced, ev(other)).action, 'conflict', 'conflitto mai mostrato: resta un conflitto');
    // Anche con la chiave nella forza (per codice), un etag diverso da quello dell'anteprima resta un conflitto.
    const stale = plan({ serialization: s0, ledger, targets, force: { itemKeys: new Set([k1, k2]), preview: new Map([[k1, { code: 'TARGET_NEWER', target_etag: '"x0"' }], [k2, { code: 'BOTH_CHANGED', target_etag: '"x2"' }]]) } });
    assert.equal(itemOf(stale, ev(single)).action, 'conflict', 'destinazione cambiata di nuovo dopo l\'anteprima');
    assert.equal(itemOf(stale, ev(other)).action, 'conflict', 'codice diverso da quello dell\'anteprima');
  });

  test('F3R-SHD-02: erasure (snapshot redatto) su una riga da rivalidare → update con la patch senza base, mai REVALIDATION_REQUIRED', () => {
    const s = serialize([{ ...single, summary: 'Prenotazione', description: null }, other]);
    for (const mode of MODES) {
      const redacted = itemOf(plan({ serialization: s, mode, ledger: [written(o, { legacy_snapshot: null, legacy_hash: null, revalidate_reason: 'backup-import', revalidate_since: NOW })], targets: [targetOf(o)] }), ev(single));
      assert.equal(redacted.action, 'update', mode);
      assert.equal(redacted.patch, true);
      // Una riga non redatta da rivalidare resta un conflitto da forzare.
      const guarded = itemOf(plan({ serialization: s, mode, ledger: [written(o, { revalidate_reason: 'backup-import', revalidate_since: NOW })], targets: [targetOf(o)] }), ev(single));
      assert.equal(guarded.code, 'REVALIDATION_REQUIRED', mode);
    }
  });

  test('F3R6-01: collezione con un\'altra calendar-id → COLLECTION_MISSING per ogni chiave del calendario, anche con "forza"', () => {
    for (const mode of MODES) {
      const items = plan({ serialization: s0, mode, foreign: { [CAL_A]: 'f0000000-0000-4000-8000-0000000000ff' }, force: { codes: new Set(['COLLECTION_MISSING' as never, 'UNTRACKED_TARGET']) } });
      const a = itemOf(items, ev(single));
      assert.equal(a.action, 'conflict', mode);
      assert.equal(a.code, 'COLLECTION_MISSING');
      // Righe già scritte in quella collezione: nessuna cancellazione.
      const gone = itemOf(plan({ serialization: serialize([other]), mode, ledger: [written(o)], targets: [targetOf(o)], foreign: { [CAL_A]: '' } }), ev(single));
      assert.equal(gone.action, 'conflict');
      assert.equal(gone.code, 'COLLECTION_MISSING');
      assert.equal(itemOf(items, ev(other)).action, 'create', 'le altre collezioni restano utilizzabili');
    }
  });
});
