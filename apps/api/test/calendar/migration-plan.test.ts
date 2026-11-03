/**
 * Piano della migrazione (gruppo SERIALIZE della F3): `computePlan` è pura e
 * qui si prova ogni riga della tabella del contratto
 * docs/calendar-radicale/contracts/f3-modules.md §7.2, nei due modi (`apply`
 * e `shadow`), più "forza", rivalidazione, ambito per calendario e per chiave,
 * hash del piano, chiavi degli item, conteggi e anteprima leggibile.
 *
 * Gli oggetti voluti vengono dal serializer vero (serializeLegacy su una
 * sorgente costruita a mano), quindi testo, fingerprint e legacy_hash hanno
 * la forma reale; ledger e destinazione sono costruiti accanto. Nessun
 * database né Radicale.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type CalendarObject, getTextValue, parseCalendarObject, semanticFingerprint } from '@calicchia/calendar-core';
import {
  buildPlanPreview,
  computePlan,
  objectItemDetail,
  planCounts,
  planHash,
  planItemKey,
  planItemRow,
  type PlanInput,
  type TargetCollection,
  type TargetSnapshot,
} from '../../src/lib/calendar/migration/plan';
import { type LegacySource, patchTowardSnapshot, serializeLegacy } from '../../src/lib/calendar/migration/serialize';
import {
  type ConflictCode,
  DEFAULT_MIGRATION_OPTIONS,
  type LedgerRow,
  type LegacyKey,
  type MigrationCalendar,
  type MigrationOptions,
  type PlanItem,
  type PlanMode,
  type SerializationResult,
  type SerializedObject,
  type TargetObject,
} from '../../src/lib/calendar/migration/types';

// ─── Dati ───────────────────────────────

const NOW = new Date('2026-10-10T08:00:00.000Z');
const CAL_A = 'c0000000-0000-4000-8000-00000000000a';
const CAL_B = 'c0000000-0000-4000-8000-00000000000b';
const CAL_BK = 'c0000000-0000-4000-8000-0000000000bc';

const E_SINGLE = 'e0000000-0000-4000-8000-000000000001';
const E_SERIES = 'e0000000-0000-4000-8000-000000000002';
const E_OVERRIDE = 'e0000000-0000-4000-8000-000000000003';
const E_ORPHAN = 'e0000000-0000-4000-8000-000000000004';
const E_OTHER = 'e0000000-0000-4000-8000-000000000005';
const E_BOOKINGS_MANUAL = 'e0000000-0000-4000-8000-000000000006';
const E_CANCELLED = 'e0000000-0000-4000-8000-000000000007';
const E_GONE = 'e0000000-0000-4000-8000-000000000008';

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

function row(o: Partial<EventRow> & Pick<EventRow, 'id' | 'uid' | 'summary' | 'start_time' | 'end_time'>): EventRow {
  return {
    calendar_id: CAL_A, description: null, location: null, url: null, all_day: false, rrule: null, exdates: [],
    recurrence_id: null, recurrence_master_id: null, source: 'admin', source_id: null, status: 'confirmed',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
    ...o,
  };
}

function baseEvents(): EventRow[] {
  return [
    row({ id: E_SINGLE, uid: 'singolo-1', summary: 'Riunione', start_time: '2026-11-03T09:00:00.000Z', end_time: '2026-11-03T10:00:00.000Z' }),
    row({ id: E_SERIES, uid: 'serie-1', summary: 'Gestione', start_time: '2026-03-02T08:00:00.000Z', end_time: '2026-03-02T09:00:00.000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO' }),
    row({
      id: E_OVERRIDE, uid: 'serie-1-ov', summary: 'Gestione spostata', start_time: '2026-03-09T10:00:00.000Z', end_time: '2026-03-09T11:00:00.000Z',
      recurrence_id: '2026-03-09T08:00:00.000Z', recurrence_master_id: E_SERIES,
    }),
    // Orfano: martedì, fuori dalla regola del lunedì.
    row({
      id: E_ORPHAN, uid: 'serie-1-orfano', summary: 'Gestione straordinaria', start_time: '2026-03-10T08:00:00.000Z', end_time: '2026-03-10T09:00:00.000Z',
      recurrence_id: '2026-03-10T08:00:00.000Z', recurrence_master_id: E_SERIES,
    }),
    row({ id: E_OTHER, uid: 'personale-1', calendar_id: CAL_B, summary: 'Dentista', start_time: '2026-11-04T15:00:00.000Z', end_time: '2026-11-04T16:00:00.000Z', source: 'manual' }),
    row({ id: E_BOOKINGS_MANUAL, uid: 'manuale-bk', calendar_id: CAL_BK, summary: 'Promemoria', start_time: '2026-11-05T15:00:00.000Z', end_time: '2026-11-05T16:00:00.000Z', source: 'manual' }),
    row({ id: E_CANCELLED, uid: 'annullato-1', summary: 'Annullato', start_time: '2026-11-06T15:00:00.000Z', end_time: '2026-11-06T16:00:00.000Z', status: 'cancelled' }),
  ];
}

function source(events: EventRow[] = baseEvents()): LegacySource {
  return { read_at: NOW, calendars: CALENDARS, events, bookings: [], objectIds: new Map(), ledger: [] };
}

function serialize(events: EventRow[] = baseEvents(), options: Partial<MigrationOptions> = {}): SerializationResult {
  return serializeLegacy(source(events), { ...DEFAULT_MIGRATION_OPTIONS, ...options }, { now: NOW });
}

/** Stessa sorgente con un campo di una riga cambiato. */
function withChange(id: string, patch: Partial<EventRow>): EventRow[] {
  return baseEvents().map((e) => (e.id === id ? { ...e, ...patch } : e));
}

function obj(result: SerializationResult, key: string): SerializedObject {
  const o = result.objects.find((x) => x.legacy_key === key);
  assert.ok(o, `oggetto ${key} assente dal serializer`);
  return o;
}

let ledgerSeq = 0;

/** Riga del ledger "scritta" con il contenuto di `o` (come la lascia la transazione 2 dell'apply). */
function written(o: SerializedObject, extra: Partial<LedgerRow> = {}): LedgerRow {
  ledgerSeq += 1;
  return {
    id: String(ledgerSeq),
    calendar_id: o.calendar_id,
    collection_name: o.collection_name,
    href: o.href,
    kind: o.kind,
    legacy_key: o.legacy_key,
    legacy_event_id: o.legacy_event_id,
    uid: o.uid,
    legacy_snapshot: o.legacy_snapshot,
    legacy_hash: o.legacy_hash,
    written_etag: '"w1"',
    written_fingerprint: o.fingerprint,
    written_at: NOW,
    intent_op: null,
    intent_fingerprint: null,
    intent_legacy_hash: null,
    intent_snapshot: null,
    intent_etag: null,
    intent_at: null,
    intent_run_id: null,
    adopted: false,
    derived: false,
    revalidate_reason: null,
    revalidate_since: null,
    deleted_at: null,
    last_run_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
}

function target(calendarId: string, collection: string, href: string, raw: string, etag: string): TargetObject {
  const parsed = parseCalendarObject(raw);
  assert.ok(parsed.ok, 'testo della destinazione non valido');
  return { calendar_id: calendarId, collection_name: collection, href, etag, uid: parsed.value.uid, fingerprint: semanticFingerprint(parsed.value), raw };
}

/** Destinazione con lo stesso contenuto di `o` all'href voluto. */
function targetOf(o: SerializedObject, etag = '"w1"', raw = o.ics): TargetObject {
  return target(o.calendar_id, o.collection_name, o.href, raw, etag);
}

/** Destinazione letta solo con PROPFIND (etag, senza contenuto). */
function etagOnly(o: SerializedObject, etag = '"w1"'): TargetObject {
  return { calendar_id: o.calendar_id, collection_name: o.collection_name, href: o.href, etag, uid: null, fingerprint: null, raw: null };
}

function snapshot(objects: TargetObject[], opts: { missing?: string[] } = {}): TargetSnapshot {
  const collections = new Map<string, TargetCollection>();
  for (const c of CALENDARS) {
    const exists = !(opts.missing ?? []).includes(c.id);
    const map = new Map<string, TargetObject>();
    if (exists) for (const t of objects) if (t.calendar_id === c.id) map.set(t.href, t);
    collections.set(c.id, { calendar_id: c.id, collection_name: c.collection_name as string, exists, objects: map });
  }
  return { read_at: NOW, collections };
}

function plan(input: {
  serialization: SerializationResult;
  ledger?: LedgerRow[];
  targets?: TargetObject[];
  missing?: string[];
  mode?: PlanMode;
  keys?: LegacyKey[];
  calendarIds?: string[];
  forceKeys?: string[];
  forceCodes?: ConflictCode[];
}): PlanItem[] {
  const full: PlanInput = {
    mode: input.mode ?? 'apply',
    serialization: input.serialization,
    ledger: input.ledger ?? [],
    target: snapshot(input.targets ?? [], { missing: input.missing }),
    scope: { calendarIds: new Set(input.calendarIds ?? CALENDARS.map((c) => c.id)), legacyKeys: input.keys ? new Set(input.keys) : null },
    force: { itemKeys: new Set(input.forceKeys ?? []), codes: new Set(input.forceCodes ?? []) },
  };
  return computePlan(full);
}

function itemOf(items: PlanItem[], key: string, calendarId?: string): PlanItem {
  const found = items.filter((i) => i.legacy_key === key && (!calendarId || i.calendar_id === calendarId));
  assert.equal(found.length, 1, `atteso un item per ${key}${calendarId ? ` in ${calendarId}` : ''}, trovati ${found.length}`);
  return found[0];
}

const MODES: PlanMode[] = ['apply', 'shadow'];

/** VALARM aggiunto da un device (o dall'admin nel futuro) nel primo VEVENT. */
function withAlarm(ics: string): string {
  return ics.replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Promemoria\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT');
}

/** Oggetto iCalendar letto (fallisce il test se il testo non è valido). */
function parseOk(ics: string): CalendarObject {
  const parsed = parseCalendarObject(ics);
  assert.ok(parsed.ok, 'oggetto iCalendar valido');
  return parsed.value;
}

const KEY_SINGLE = `event:${E_SINGLE}` as LegacyKey;
const KEY_SERIES = `event:${E_SERIES}` as LegacyKey;
const KEY_ORPHAN = `detached:${E_ORPHAN}` as LegacyKey;
const KEY_OTHER = `event:${E_OTHER}` as LegacyKey;
const KEY_BK = `event:${E_BOOKINGS_MANUAL}` as LegacyKey;
const KEY_CANCELLED = `event:${E_CANCELLED}` as LegacyKey;

// ─── Righe della tabella §7.2 ───────────────────────────────

describe('computePlan: righe senza ledger (3, 4, 5, 16)', () => {
  for (const mode of MODES) {
    test(`[${mode}] riga 3: nessuna riga, destinazione assente, UID libero → create; riga 16: salto senza righe → skip`, () => {
      const s = serialize();
      const items = plan({ serialization: s, mode });
      const single = itemOf(items, KEY_SINGLE);
      assert.equal(single.action, 'create');
      assert.equal(single.code, null);
      assert.equal(single.target, null);
      assert.equal(single.href, 'singolo-1.ics');
      assert.equal(itemOf(items, KEY_ORPHAN).action, 'create', 'override orfano staccato');
      const cancelled = itemOf(items, KEY_CANCELLED);
      assert.equal(cancelled.action, 'skip');
      assert.equal(cancelled.code, 'CANCELLED_MASTER');
      // Primo apply: solo create e skip.
      assert.deepEqual([...new Set(items.map((i) => i.action))].sort(), ['create', 'skip']);
    });

    test(`[${mode}] riga 4: destinazione presente e non tracciata → adopt se uguale, UNTRACKED_TARGET se diversa`, () => {
      const s = serialize();
      const o = obj(s, KEY_SINGLE);
      const same = itemOf(plan({ serialization: s, mode, targets: [targetOf(o, '"x"')] }), KEY_SINGLE);
      assert.equal(same.action, 'adopt');
      assert.equal(same.target?.etag, '"x"');
      const other = itemOf(plan({ serialization: s, mode, targets: [targetOf(o, '"x"', o.ics.replace('SUMMARY:Riunione', 'SUMMARY:Altro'))] }), KEY_SINGLE);
      assert.equal(other.action, 'conflict');
      assert.equal(other.code, 'UNTRACKED_TARGET');
    });

    test(`[${mode}] riga 5: UID a un altro href non tracciato → adopt di quell'href se uguale, UID_AT_OTHER_HREF se diverso`, () => {
      const s = serialize();
      const o = obj(s, KEY_SINGLE);
      const elsewhere = target(o.calendar_id, o.collection_name, 'dal-telefono.ics', o.ics, '"d1"');
      const adopt = itemOf(plan({ serialization: s, mode, targets: [elsewhere] }), KEY_SINGLE);
      assert.equal(adopt.action, 'adopt');
      assert.equal(adopt.other_href, 'dal-telefono.ics');
      const changed = target(o.calendar_id, o.collection_name, 'dal-telefono.ics', o.ics.replace('SUMMARY:Riunione', 'SUMMARY:Modificata'), '"d2"');
      const conflict = itemOf(plan({ serialization: s, mode, targets: [changed] }), KEY_SINGLE);
      assert.equal(conflict.action, 'conflict');
      assert.equal(conflict.code, 'UID_AT_OTHER_HREF');
      assert.equal(conflict.other_href, 'dal-telefono.ics');
    });

    test(`[${mode}] riga 2: collezione assente → COLLECTION_MISSING, mai forzabile`, () => {
      const s = serialize();
      const items = plan({ serialization: s, mode, missing: [CAL_A], forceCodes: ['COLLECTION_MISSING'], forceKeys: [planItemKey({ calendar_id: CAL_A, href: 'singolo-1.ics', legacy_key: KEY_SINGLE })] });
      const single = itemOf(items, KEY_SINGLE);
      assert.equal(single.action, 'conflict');
      assert.equal(single.code, 'COLLECTION_MISSING');
      assert.equal(itemOf(items, KEY_OTHER).action, 'create', 'le altre collezioni non cambiano');
    });
  }

  test('UID tracciato da un\'altra chiave allo stesso href diverso → UID_AT_OTHER_HREF (mai una PUT destinata al 409)', () => {
    const s = serialize();
    const o = obj(s, KEY_SINGLE);
    const foreign = written({ ...o, legacy_key: 'event:e0000000-0000-4000-8000-0000000000ff' as LegacyKey, href: 'altro.ics' });
    const items = plan({ serialization: s, ledger: [foreign], targets: [etagOnly({ ...o, href: 'altro.ics' })] });
    const item = itemOf(items, KEY_SINGLE);
    assert.equal(item.action, 'conflict');
    assert.equal(item.code, 'UID_AT_OTHER_HREF');
    assert.equal(item.other_href, 'altro.ics');
  });
});

describe('computePlan: righe con il ledger (6-11)', () => {
  for (const mode of MODES) {
    test(`[${mode}] riga 6: hash ed etag uguali → noop; seconda esecuzione a zero scritture`, () => {
      const s = serialize();
      const ledger = s.objects.map((o) => written(o));
      const targets = s.objects.map((o) => etagOnly(o));
      const items = plan({ serialization: s, mode, ledger, targets });
      assert.deepEqual([...new Set(items.map((i) => i.action))].sort(), ['noop', 'skip']);
      assert.equal(planCounts(items).writes, 0);
    });

    test(`[${mode}] riga 8: etag cambiata ma contenuto uguale allo scritto → adopt (hash invariato) o update con l'etag nuova`, () => {
      const s = serialize();
      const o = obj(s, KEY_SINGLE);
      const same = itemOf(plan({ serialization: s, mode, ledger: [written(o)], targets: [targetOf(o, '"w2"')] }), KEY_SINGLE);
      assert.equal(same.action, 'adopt');
      assert.equal(same.target?.etag, '"w2"');

      const s2 = serialize(withChange(E_SINGLE, { summary: 'Riunione spostata' }));
      const changed = itemOf(plan({ serialization: s2, mode, ledger: [written(o)], targets: [targetOf(o, '"w2"')] }), KEY_SINGLE);
      assert.equal(changed.action, 'update');
      assert.equal(changed.target?.etag, '"w2"', 'If-Match con l\'etag appena letta');
      assert.ok(changed.fields.includes('summary'));
    });

    test(`[${mode}] riga 11: scritta e poi sparita → DELETED_IN_TARGET; forza → create`, () => {
      const s = serialize();
      const o = obj(s, KEY_SINGLE);
      const item = itemOf(plan({ serialization: s, mode, ledger: [written(o)] }), KEY_SINGLE);
      assert.equal(item.action, 'conflict');
      assert.equal(item.code, 'DELETED_IN_TARGET');
      const forced = itemOf(plan({ serialization: s, mode, ledger: [written(o)], forceKeys: [planItemKey(item)] }), KEY_SINGLE);
      assert.equal(forced.action, 'create');
      assert.equal(forced.code, 'DELETED_IN_TARGET', 'il codice resta: item forzato');
      assert.equal(forced.target, null);
    });
  }

  test('[apply] riga 7: hash cambiato, etag uguale → update (riscrittura completa; patch per le righe adottate)', () => {
    const before = obj(serialize(), KEY_SINGLE);
    const s = serialize(withChange(E_SINGLE, { summary: 'Riunione spostata', location: 'Sala 2' }));
    const item = itemOf(plan({ serialization: s, ledger: [written(before)], targets: [etagOnly(before)] }), KEY_SINGLE);
    assert.equal(item.action, 'update');
    assert.equal(item.patch, false);
    assert.equal(item.target?.etag, '"w1"');
    assert.deepEqual(item.fields, ['location', 'summary']);
    const adopted = itemOf(plan({ serialization: s, ledger: [written(before, { adopted: true })], targets: [targetOf(before)] }), KEY_SINGLE);
    assert.equal(adopted.action, 'update');
    assert.equal(adopted.patch, true, 'riga adottata: patch per campo sull\'oggetto corrente');
    // Erasure GDPR: snapshot e hash redatti → patch senza base verso l'oggetto voluto, adottata o no
    // (§4.4: mai la riscrittura completa; solo i campi del piano, così la cancellazione dovuta non
    // aspetta la rivalidazione), anche con la riga da rivalidare dopo un import del backup.
    const redacted = itemOf(plan({ serialization: s, ledger: [written(before, { adopted: true, legacy_snapshot: null, legacy_hash: null })], targets: [targetOf(before)] }), KEY_SINGLE);
    assert.equal(redacted.action, 'update');
    assert.equal(redacted.patch, true);
    const redactedPlain = itemOf(plan({ serialization: s, ledger: [written(before, { legacy_snapshot: null, legacy_hash: null })], targets: [targetOf(before)] }), KEY_SINGLE);
    assert.equal(redactedPlain.action, 'update');
    assert.equal(redactedPlain.patch, true);
    const redactedRevalidate = itemOf(plan({ serialization: s, ledger: [written(before, { legacy_snapshot: null, legacy_hash: null, revalidate_reason: 'backup-import', revalidate_since: new Date() })], targets: [targetOf(before)] }), KEY_SINGLE);
    assert.equal(redactedRevalidate.action, 'update', 'erasure con la riga da rivalidare: si scrive comunque (solo i campi del piano)');
    assert.equal(redactedRevalidate.patch, true);
    for (const mode of MODES) {
      const same = itemOf(plan({ serialization: serialize(), mode, ledger: [written(before, { legacy_snapshot: null, legacy_hash: null })], targets: [targetOf(before)] }), KEY_SINGLE);
      assert.equal(same.action, 'adopt', `${mode}: hash NULL con il contenuto già giusto → solo il nuovo snapshot`);
    }
  });

  test('[shadow] riga 7: hash cambiato, etag uguale → update con patch per campo', () => {
    const before = obj(serialize(), KEY_SINGLE);
    const s = serialize(withChange(E_SINGLE, { summary: 'Riunione spostata' }));
    const item = itemOf(plan({ serialization: s, mode: 'shadow', ledger: [written(before)], targets: [targetOf(before)] }), KEY_SINGLE);
    assert.equal(item.action, 'update');
    assert.equal(item.patch, true);
    assert.deepEqual(item.fields, ['summary']);
  });

  test('hash cambiato ma contenuto voluto uguale allo scritto → adopt (nuovo snapshot senza scrittura)', () => {
    const before = obj(serialize(), KEY_SINGLE);
    // updated_at entra solo in LAST-MODIFIED, escluso dal fingerprint e dallo snapshot: stesso hash.
    // Un hash diverso con lo stesso contenuto si ottiene con una riga del ledger di una versione precedente.
    const l = written(before, { legacy_hash: `s0:${'0'.repeat(64)}` });
    for (const mode of MODES) {
      const item = itemOf(plan({ serialization: serialize(), mode, ledger: [l], targets: [etagOnly(before)] }), KEY_SINGLE);
      assert.equal(item.action, 'adopt', mode);
    }
  });

  test('riga 9: hash invariato, destinazione cambiata → TARGET_NEWER (apply), noop (shadow); uguale al voluto → adopt', () => {
    const s = serialize();
    const o = obj(s, KEY_SINGLE);
    const changed = targetOf(o, '"dev"', o.ics.replace('SUMMARY:Riunione', 'SUMMARY:Dal telefono'));
    assert.equal(itemOf(plan({ serialization: s, ledger: [written(o)], targets: [changed] }), KEY_SINGLE).code, 'TARGET_NEWER');
    assert.equal(itemOf(plan({ serialization: s, mode: 'shadow', ledger: [written(o)], targets: [changed] }), KEY_SINGLE).action, 'noop');
    // Destinazione riscritta da qualcun altro con il contenuto voluto (per esempio dopo un ripristino del volume).
    const sameContent = targetOf(o, '"dev2"', o.ics.replace('DTSTAMP:', 'DTSTAMP:2027').replace(/DTSTAMP:2027\d{8}T\d{6}Z/, 'DTSTAMP:20270101T000000Z'));
    for (const mode of MODES) {
      assert.equal(itemOf(plan({ serialization: s, mode, ledger: [written(o, { written_fingerprint: 'v1:altro' })], targets: [sameContent] }), KEY_SINGLE).action, 'adopt', mode);
    }
  });

  test('riga 10: entrambi cambiati → BOTH_CHANGED (apply); shadow: patch se il campo toccato non è cambiato anche nella destinazione', () => {
    const before = obj(serialize(), KEY_SINGLE);
    const s = serialize(withChange(E_SINGLE, { summary: 'Riunione spostata' }));
    // La destinazione ha un VALARM in più: campo diverso da quello toccato.
    const alarm = targetOf(before, '"dev"', withAlarm(before.ics));
    const apply = itemOf(plan({ serialization: s, ledger: [written(before)], targets: [alarm] }), KEY_SINGLE);
    assert.equal(apply.action, 'conflict');
    assert.equal(apply.code, 'BOTH_CHANGED');
    const shadow = itemOf(plan({ serialization: s, mode: 'shadow', ledger: [written(before)], targets: [alarm] }), KEY_SINGLE);
    assert.equal(shadow.action, 'update');
    assert.equal(shadow.patch, true);
    assert.deepEqual(shadow.fields, ['summary']);
    // Lo stesso campo cambiato anche nella destinazione: conflitto con i campi.
    const clash = targetOf(before, '"dev"', before.ics.replace('SUMMARY:Riunione', 'SUMMARY:Dal telefono'));
    const conflict = itemOf(plan({ serialization: s, mode: 'shadow', ledger: [written(before)], targets: [clash] }), KEY_SINGLE);
    assert.equal(conflict.action, 'conflict');
    assert.equal(conflict.code, 'BOTH_CHANGED');
    assert.deepEqual(conflict.fields, ['summary']);
    // Forza: scrittura del contenuto del piano con If-Match dell'etag corrente.
    const forced = itemOf(plan({ serialization: s, ledger: [written(before)], targets: [alarm], forceCodes: ['BOTH_CHANGED'] }), KEY_SINGLE);
    assert.equal(forced.action, 'update');
    assert.equal(forced.code, 'BOTH_CHANGED');
    assert.equal(forced.patch, false);
    assert.equal(forced.target?.etag, '"dev"');
  });

  test('[shadow] snapshot redatto dall\'erasure GDPR: patch senza base verso l\'oggetto voluto, VALARM della destinazione preservato', () => {
    const before = obj(serialize(), KEY_SINGLE);
    const s = serialize(withChange(E_SINGLE, { description: '[dato rimosso]' }));
    const redacted = { legacy_snapshot: null, legacy_hash: null };
    // Destinazione invariata dall'ultima scrittura, con il VALARM che lo strumento aveva preservato.
    const alarm = targetOf(before, '"w1"', withAlarm(before.ics));
    const same = itemOf(plan({ serialization: s, mode: 'shadow', ledger: [written(before, { ...redacted, adopted: true, written_fingerprint: 'v1:con-valarm' })], targets: [alarm] }), KEY_SINGLE);
    assert.equal(same.action, 'update');
    assert.equal(same.patch, true);
    assert.deepEqual(same.fields, ['description']);
    // Destinazione cambiata da un device dopo l'ultima scrittura: senza base nessun conflitto, vince il legacy.
    const changed = itemOf(plan({ serialization: s, mode: 'shadow', ledger: [written(before, redacted)], targets: [targetOf(before, '"dev"', withAlarm(before.ics))] }), KEY_SINGLE);
    assert.equal(changed.action, 'update');
    assert.equal(changed.patch, true);
    // La destinazione ha già i campi voluti: si registra lo snapshot nuovo senza scrivere.
    const done = itemOf(plan({ serialization: s, mode: 'shadow', ledger: [written(before, redacted)], targets: [targetOf(before, '"dev"', withAlarm(obj(s, KEY_SINGLE).ics))] }), KEY_SINGLE);
    assert.equal(done.action, 'adopt');
    // Il contenuto della patch: descrizione redatta, VALARM preservato.
    const patched = patchTowardSnapshot(parseOk(withAlarm(before.ics)), obj(s, KEY_SINGLE).legacy_snapshot, { tz: 'Europe/Rome', now: NOW });
    assert.equal(patched.changed, true);
    assert.deepEqual(patched.fields, ['description']);
    assert.equal(getTextValue(patched.object.master!, 'DESCRIPTION'), '[dato rimosso]');
    assert.equal(patched.object.master!.components.filter((c) => c.name === 'VALARM').length, 1);
  });

  test('forza TARGET_NEWER e UNTRACKED_TARGET per item: scrittura con If-Match dell\'etag corrente', () => {
    const s = serialize();
    const o = obj(s, KEY_SINGLE);
    const changed = targetOf(o, '"dev"', o.ics.replace('SUMMARY:Riunione', 'SUMMARY:Dal telefono'));
    const conflict = itemOf(plan({ serialization: s, ledger: [written(o)], targets: [changed] }), KEY_SINGLE);
    const forced = itemOf(plan({ serialization: s, ledger: [written(o)], targets: [changed], forceKeys: [planItemKey(conflict)] }), KEY_SINGLE);
    assert.equal(forced.action, 'update');
    assert.equal(forced.code, 'TARGET_NEWER');
    assert.equal(forced.target?.etag, '"dev"');
    // Un'altra chiave forzata non cambia questo item.
    assert.equal(itemOf(plan({ serialization: s, ledger: [written(o)], targets: [changed], forceKeys: ['x/y#event:z'] }), KEY_SINGLE).action, 'conflict');

    const untracked = itemOf(plan({ serialization: s, targets: [changed], forceCodes: ['UNTRACKED_TARGET'] }), KEY_SINGLE);
    assert.equal(untracked.action, 'update');
    assert.equal(untracked.code, 'UNTRACKED_TARGET');

    const elsewhere = target(o.calendar_id, o.collection_name, 'dal-telefono.ics', o.ics.replace('SUMMARY:Riunione', 'SUMMARY:Modificata'), '"d2"');
    const uidForced = itemOf(plan({ serialization: s, targets: [elsewhere], forceCodes: ['UID_AT_OTHER_HREF'] }), KEY_SINGLE);
    assert.equal(uidForced.action, 'update');
    assert.equal(uidForced.other_href, 'dal-telefono.ics');
    assert.equal(uidForced.target?.href, 'dal-telefono.ics');
    assert.equal(uidForced.target?.etag, '"d2"');
  });
});

describe('computePlan: intento pendente (riga 1)', () => {
  for (const mode of MODES) {
    test(`[${mode}] create interrotta dopo la PUT → adopt; mai arrivata → create di nuovo; altro contenuto → UNTRACKED_TARGET`, () => {
      const s = serialize();
      const o = obj(s, KEY_SINGLE);
      const pending = written(o, {
        written_etag: null, written_fingerprint: null, written_at: null, legacy_hash: null, legacy_snapshot: null,
        intent_op: 'create', intent_fingerprint: o.fingerprint, intent_legacy_hash: o.legacy_hash, intent_snapshot: o.legacy_snapshot, intent_at: NOW,
      });
      const adopt = itemOf(plan({ serialization: s, mode, ledger: [pending], targets: [targetOf(o, '"new"')] }), KEY_SINGLE);
      assert.equal(adopt.action, 'adopt');
      assert.equal(adopt.ledger?.intent_op, 'create');
      const again = itemOf(plan({ serialization: s, mode, ledger: [pending] }), KEY_SINGLE);
      assert.equal(again.action, 'create', 'intento mai applicato: si ripianifica');
      const other = itemOf(plan({ serialization: s, mode, ledger: [pending], targets: [targetOf(o, '"new"', o.ics.replace('SUMMARY:Riunione', 'SUMMARY:Altro'))] }), KEY_SINGLE);
      assert.equal(other.action, 'conflict');
      assert.equal(other.code, 'UNTRACKED_TARGET');
    });

    test(`[${mode}] update interrotto: destinazione col contenuto dell'intento → adopt; con quello scritto → si ripianifica (update)`, () => {
      const before = obj(serialize(), KEY_SINGLE);
      const s = serialize(withChange(E_SINGLE, { summary: 'Nuovo titolo' }));
      const o = obj(s, KEY_SINGLE);
      const pending = written(before, { intent_op: 'update', intent_fingerprint: o.fingerprint, intent_legacy_hash: o.legacy_hash, intent_snapshot: o.legacy_snapshot, intent_etag: '"w1"', intent_at: NOW });
      assert.equal(itemOf(plan({ serialization: s, mode, ledger: [pending], targets: [targetOf(o, '"w2"')] }), KEY_SINGLE).action, 'adopt');
      const stale = itemOf(plan({ serialization: s, mode, ledger: [pending], targets: [targetOf(before, '"w1"')] }), KEY_SINGLE);
      assert.equal(stale.action, 'update');
      assert.equal(stale.ledger?.intent_op, 'update', 'apply azzera l\'intento vecchio');
    });

    test(`[${mode}] delete interrotta: destinazione assente → adopt (ritiro); stessa etag → delete di nuovo; altro → TARGET_NEWER`, () => {
      const o = obj(serialize(), KEY_SINGLE);
      const s = serialize(baseEvents().filter((e) => e.id !== E_SINGLE));
      const pending = written(o, { intent_op: 'delete', intent_etag: '"w1"', intent_at: NOW });
      const retire = itemOf(plan({ serialization: s, mode, ledger: [pending] }), KEY_SINGLE);
      assert.equal(retire.action, 'adopt');
      assert.equal(retire.source, null);
      const again = itemOf(plan({ serialization: s, mode, ledger: [pending], targets: [etagOnly(o)] }), KEY_SINGLE);
      assert.equal(again.action, 'delete');
      const newer = itemOf(plan({ serialization: s, mode, ledger: [pending], targets: [targetOf(o, '"dev"', o.ics.replace('SUMMARY:Riunione', 'SUMMARY:X'))] }), KEY_SINGLE);
      assert.equal(newer.action, 'conflict');
      assert.equal(newer.code, 'TARGET_NEWER');
    });
  }
});

describe('computePlan: fonte sparita, salti e spostamenti (12-16)', () => {
  for (const mode of MODES) {
    test(`[${mode}] righe 12-14: fonte sparita → delete con If-Match, adopt se già assente, TARGET_NEWER se cambiata`, () => {
      const goneObj = obj(serialize([...baseEvents(), row({ id: E_GONE, uid: 'sparito-1', summary: 'Sparito', start_time: '2026-11-07T09:00:00.000Z', end_time: '2026-11-07T10:00:00.000Z' })]), `event:${E_GONE}`);
      const s = serialize();
      const l = written(goneObj);
      const del = itemOf(plan({ serialization: s, mode, ledger: [l], targets: [etagOnly(goneObj)] }), `event:${E_GONE}`);
      assert.equal(del.action, 'delete');
      assert.equal(del.code, null);
      assert.equal(del.target?.etag, '"w1"');
      assert.equal(itemOf(plan({ serialization: s, mode, ledger: [l] }), `event:${E_GONE}`).action, 'adopt');
      const changed = targetOf(goneObj, '"dev"', goneObj.ics.replace('SUMMARY:Sparito', 'SUMMARY:Ripreso'));
      const newer = itemOf(plan({ serialization: s, mode, ledger: [l], targets: [changed] }), `event:${E_GONE}`);
      assert.equal(newer.code, 'TARGET_NEWER');
      // Forza su una fonte sparita: delete con l'etag corrente.
      const forced = itemOf(plan({ serialization: s, mode, ledger: [l], targets: [changed], forceCodes: ['TARGET_NEWER'] }), `event:${E_GONE}`);
      assert.equal(forced.action, 'delete');
      assert.equal(forced.target?.etag, '"dev"');
    });

    test(`[${mode}] riga 12 per un salto: master scritto e poi annullato → delete con il motivo CANCELLED_MASTER`, () => {
      const live = obj(serialize(withChange(E_CANCELLED, { status: 'confirmed' })), KEY_CANCELLED);
      const item = itemOf(plan({ serialization: serialize(), mode, ledger: [written(live)], targets: [etagOnly(live)] }), KEY_CANCELLED);
      assert.equal(item.action, 'delete');
      assert.equal(item.code, 'CANCELLED_MASTER');
    });

    test(`[${mode}] riga 15: spostamento della decisione 8 → create nella nuova collezione e delete nella vecchia`, () => {
      const stay = serialize();
      const stayObj = obj(stay, KEY_BK);
      assert.equal(stayObj.calendar_id, CAL_BK, 'default: resta in Prenotazioni');
      const moved = serialize(baseEvents(), { bookings_move_event_ids: [E_BOOKINGS_MANUAL] });
      const movedObj = obj(moved, KEY_BK);
      assert.equal(movedObj.calendar_id, CAL_A, 'spostato nel calendario di default');
      assert.ok(movedObj.expected_reasons.includes('NON_PROJECTION_MOVED'));
      const items = plan({ serialization: moved, mode, ledger: [written(stayObj)], targets: [etagOnly(stayObj)] });
      assert.equal(itemOf(items, KEY_BK, CAL_A).action, 'create');
      const del = itemOf(items, KEY_BK, CAL_BK);
      assert.equal(del.action, 'delete');
      assert.equal(del.source, null);
    });

    test(`[${mode}] riga 16 con la riga viva fuori dall'ambito: nessun item`, () => {
      const live = obj(serialize(withChange(E_CANCELLED, { status: 'confirmed' })), KEY_CANCELLED);
      const items = plan({ serialization: serialize(), mode, ledger: [written(live)], targets: [etagOnly(live)], calendarIds: [CAL_B] });
      assert.equal(items.filter((i) => i.legacy_key === KEY_CANCELLED).length, 0);
    });
  }

  test('orfano che rientra nella regola: la riga detached viva si cancella', () => {
    const s0 = serialize();
    const det = obj(s0, KEY_ORPHAN);
    assert.equal(det.kind, 'detached');
    // L'override torna su un lunedì della regola: niente più orfano.
    const s1 = serialize(withChange(E_ORPHAN, { recurrence_id: '2026-03-16T08:00:00.000Z', start_time: '2026-03-16T08:00:00.000Z', end_time: '2026-03-16T09:00:00.000Z' }));
    assert.equal(s1.objects.some((o) => o.legacy_key === KEY_ORPHAN), false);
    const item = itemOf(plan({ serialization: s1, ledger: [written(det)], targets: [etagOnly(det)] }), KEY_ORPHAN);
    assert.equal(item.action, 'delete');
  });
});

describe('computePlan: rivalidazione (riga 17)', () => {
  for (const mode of MODES) {
    test(`[${mode}] scrittura su una riga da rivalidare → REVALIDATION_REQUIRED; noop resta noop; forza esegue l'azione sospesa`, () => {
      const before = obj(serialize(), KEY_SINGLE);
      const s = serialize(withChange(E_SINGLE, { summary: 'Dopo il ripristino' }));
      const l = written(before, { revalidate_reason: 'backup-import', revalidate_since: NOW });
      const conflict = itemOf(plan({ serialization: s, mode, ledger: [l], targets: [targetOf(before)] }), KEY_SINGLE);
      assert.equal(conflict.action, 'conflict');
      assert.equal(conflict.code, 'REVALIDATION_REQUIRED');
      const forced = itemOf(plan({ serialization: s, mode, ledger: [l], targets: [targetOf(before)], forceCodes: ['REVALIDATION_REQUIRED'] }), KEY_SINGLE);
      assert.equal(forced.action, 'update');
      assert.equal(forced.code, 'REVALIDATION_REQUIRED');
      const noop = itemOf(plan({ serialization: serialize(), mode, ledger: [l], targets: [etagOnly(before)] }), KEY_SINGLE);
      assert.equal(noop.action, 'noop', 'un noop smarca la riga (lo fa l\'apply)');

      // Fonte sparita dopo un ripristino: mai una cancellazione senza conferma.
      const gone = itemOf(plan({ serialization: serialize(baseEvents().filter((e) => e.id !== E_SINGLE)), mode, ledger: [l], targets: [etagOnly(before)] }), KEY_SINGLE);
      assert.equal(gone.action, 'conflict');
      assert.equal(gone.code, 'REVALIDATION_REQUIRED');
      const goneForced = itemOf(plan({ serialization: serialize(baseEvents().filter((e) => e.id !== E_SINGLE)), mode, ledger: [l], targets: [etagOnly(before)], forceKeys: [planItemKey(gone)] }), KEY_SINGLE);
      assert.equal(goneForced.action, 'delete');
    });
  }
});

describe('computePlan: ambito per chiave (shadow)', () => {
  test('event:<master> comprende l\'oggetto e le righe detached di quel master; le altre chiavi restano fuori', () => {
    const s0 = serialize();
    const det = obj(s0, KEY_ORPHAN);
    // L'override orfano è stato cancellato in PG: la sua riga detached va tolta con la chiave del master.
    const s1 = serialize(baseEvents().filter((e) => e.id !== E_ORPHAN));
    const ledger = [written(obj(s0, KEY_SERIES)), written(det), written(obj(s0, KEY_SINGLE))];
    const targets = [etagOnly(obj(s0, KEY_SERIES)), etagOnly(det), etagOnly(obj(s0, KEY_SINGLE))];
    const items = plan({ serialization: s1, mode: 'shadow', ledger, targets, keys: [KEY_SERIES] });
    assert.deepEqual(items.map((i) => `${i.legacy_key}:${i.action}`).sort(), [`${KEY_ORPHAN}:delete`, `${KEY_SERIES}:noop`].sort());
  });
});

// ─── Hash, chiavi, righe e anteprima ───────────────────────────────

describe('hash del piano, chiavi e righe del run', () => {
  test('planHash: deterministico, indipendente dall\'ordine, sensibile a etag e azioni', () => {
    const s = serialize();
    const items = plan({ serialization: s });
    assert.match(planHash(items), /^[0-9a-f]{64}$/);
    assert.equal(planHash(items), planHash([...items].reverse()));
    assert.equal(planHash(items), planHash(plan({ serialization: serialize() })));
    const o = obj(s, KEY_SINGLE);
    const other = plan({ serialization: s, targets: [targetOf(o, '"x"')] });
    assert.notEqual(planHash(items), planHash(other));
  });

  test('planItemKey e riga \'object\' senza dati personali delle proiezioni', () => {
    const items = plan({ serialization: serialize() });
    const single = itemOf(items, KEY_SINGLE);
    assert.equal(planItemKey(single), `${CAL_A}/singolo-1.ics#${KEY_SINGLE}`);
    const r = planItemRow(single);
    assert.equal(r.item_type, 'object');
    assert.equal(r.action, 'create');
    assert.equal(r.href, 'singolo-1.ics');
    const detail = objectItemDetail(single);
    assert.equal(detail.summary, 'Riunione');
    assert.equal(detail.planned_fingerprint, single.source?.fingerprint);
    // Proiezione: nessun titolo nel dettaglio.
    const booking: PlanItem = { ...single, kind: 'booking', legacy_key: 'booking:abc' as LegacyKey };
    assert.equal(objectItemDetail(booking).summary, null);
  });

  test('ordine: per collezione adozioni, scritture e cancellazioni per ultime', () => {
    const goneObj = obj(serialize([...baseEvents(), row({ id: E_GONE, uid: 'sparito-1', summary: 'Sparito', start_time: '2026-11-07T09:00:00.000Z', end_time: '2026-11-07T10:00:00.000Z' })]), `event:${E_GONE}`);
    const s = serialize();
    const single = obj(s, KEY_SINGLE);
    const items = plan({ serialization: s, ledger: [written(goneObj)], targets: [etagOnly(goneObj), targetOf(single, '"t"')] }).filter((i) => i.calendar_id === CAL_A);
    const actions = items.map((i) => i.action);
    assert.ok(actions.indexOf('adopt') < actions.indexOf('create'));
    assert.ok(actions.indexOf('create') < actions.indexOf('delete'));
  });

  test('planCounts e anteprima leggibile: conteggi per calendario, esempi, anomalie e opzioni', () => {
    const s = serialize(baseEvents(), { orphans: 'convert' });
    const items = plan({ serialization: s });
    const counts = planCounts(items);
    assert.equal(counts.writes, counts.totals.create);
    assert.equal(counts.skips.CANCELLED_MASTER, 1);
    const preview = buildPlanPreview(items, s, CALENDARS, { ...DEFAULT_MIGRATION_OPTIONS });
    const lavoro = preview.calendars.find((c) => c.calendar_id === CAL_A);
    assert.ok(lavoro);
    assert.ok((lavoro.examples.create ?? []).length > 0 && (lavoro.examples.create ?? []).length <= 5);
    assert.ok(preview.anomalies.some((a) => a.code === 'ORPHAN_OVERRIDE_NOT_IN_RULE' && a.option === 'orphans' && a.count === 1));
    assert.ok(preview.anomalies.some((a) => a.code === 'NON_PROJECTION_IN_BOOKINGS'));
    assert.deepEqual(preview.bookings_move_candidates.map((c) => c.event_id), [E_BOOKINGS_MANUAL]);
    const orphans = preview.options.find((o) => o.key === 'orphans');
    assert.equal(orphans?.affected, 1);
    assert.equal(preview.blocking.length, 0);
    assert.deepEqual(preview.fixed_rules.map((r) => [r.key, r.affected]), [['cancelled_masters', 1], ['subscriptions_not_copied', 0]]);
    assert.deepEqual(preview.subscription_defaults, { blocks_availability: false, device_visible: false });
  });
});

describe('opzione orphans: discard', () => {
  test('l\'orfano scartato è un salto ORPHAN_DISCARDED; se era già scritto si cancella', () => {
    const det = obj(serialize(), KEY_ORPHAN);
    const s = serialize(baseEvents(), { orphans: 'discard' });
    const skip = itemOf(plan({ serialization: s }), KEY_ORPHAN);
    assert.equal(skip.action, 'skip');
    assert.equal(skip.code, 'ORPHAN_DISCARDED');
    const del = itemOf(plan({ serialization: s, ledger: [written(det)], targets: [etagOnly(det)] }), KEY_ORPHAN);
    assert.equal(del.action, 'delete');
    assert.equal(del.code, 'ORPHAN_DISCARDED');
  });
});
