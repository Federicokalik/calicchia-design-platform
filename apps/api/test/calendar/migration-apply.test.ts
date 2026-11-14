/**
 * Gruppo APPLY della F3 senza Radicale (apps/api/src/lib/calendar/migration/
 * {apply,verify,report}.ts; design §13.6-§13.7; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §4, §6.3 e §8).
 *
 *  - Funzioni pure: finestre di V3, firma delle differenze, unione e
 *    differenza di intervalli del busy, verdetti per calendario, campi del
 *    piano confrontati da V2.
 *  - Primitive del ledger sul database reale: riga d'intento (inserimento,
 *    riuso di una riga ritirata, riattivazione, spostamento di una riga mai
 *    scritta, conflitti di href e UID), esito, azzeramento, ritiro, adozione,
 *    id legacy preassegnati in cal_object_ids, letture filtrate.
 *  - executePlanItem con un trasporto finto (nessuna rete): esiti del
 *    protocollo per 201, 412 (create e update), esito ignoto (intento
 *    pendente), rifiuto certo (intento azzerato), 404, forza non autorizzata,
 *    delete con If-Match, adozione di un intento, noop che smarca la
 *    rivalidazione.
 *  - Limitatore di processo e lock cal-migration.
 *  - Accettazioni (solo differenze attese, riporto per firma, riassunto
 *    aggiornato), ultima verifica completa, report JSON e CSV.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { parseCalendarObject, semanticFingerprint } from '@calicchia/calendar-core';
import {
  adoptTarget,
  clearIntent,
  completeIntent,
  type ExecuteContext,
  executePlanItem,
  LedgerConflictError,
  LedgerStateError,
  migrationThrottle,
  readLedger,
  recordIntent,
  type RecordIntentInput,
  retireLedgerRow,
  withMigrationRunLock,
} from '../../src/lib/calendar/migration/apply';
import { planCounts } from '../../src/lib/calendar/migration/plan';
import {
  acceptDiffs,
  buildRunReport,
  buildVerdicts,
  calendarVerdicts,
  carryOverAcceptances,
  latestVerifyVerdicts,
  summarizePlanItems,
} from '../../src/lib/calendar/migration/report';
import { diffSignature, LEVEL_EXPECTED_REASONS, mergeIntervals, planFieldDiffs, subtractIntervals, v3Windows } from '../../src/lib/calendar/migration/verify';
import {
  type LedgerRow,
  type LegacyKey,
  type LegacySnapshot,
  MigrationError,
  type MigrationItemInput,
  type PlanAction,
  type PlanItem,
  type SerializedObject,
  type TargetObject,
  type VerifyParams,
} from '../../src/lib/calendar/migration/types';
import { RadicaleClient, TransportError, type TransportRequest, type TransportResponse } from '../../src/lib/calendar/radicale/client';
import type { Calendar } from '../../src/lib/calendar/types';
import { onDatabaseReady, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { closeActiveRuns, insertItems, persistedRun, TEST_ACTOR } from './_migration-apply-shared';

useTestDatabase({ resetBaseline: true });
const fx = useFixtures('mig-apply-unit');

let cal: Calendar;
let collection: string;
onDatabaseReady(async () => {
  cal = await fx.calendar({ key: 'ledger' });
  const [row] = await sql<Array<{ collection_name: string }>>`SELECT collection_name FROM calendars WHERE id = ${cal.id}::uuid`;
  collection = row.collection_name;
});

// ─── Fabbriche ───────────────────────────────

const P = 'federico';

function ics(uid: string, summary: string, extra: string[] = []): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Caldes//calendar-core//IT',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T080000Z', 'DTSTART:20261201T090000Z', 'DTEND:20261201T100000Z', `SUMMARY:${summary}`,
    ...extra, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function fingerprintOf(text: string): string {
  const parsed = parseCalendarObject(text);
  assert.ok(parsed.ok);
  return semanticFingerprint(parsed.value);
}

function hashOf(text: string): string {
  return `s1:${createHash('sha256').update(text).digest('hex')}`;
}

function snapshot(id: string, uid: string, summary: string): LegacySnapshot {
  return {
    v: 1,
    kind: 'event',
    calendar: { id: cal.id, collection_name: collection, timezone: 'Europe/Rome', role: 'user' },
    master: {
      id, uid, calendar_id: cal.id, summary, description: null, location: null, url: null,
      start_time: '2026-12-01T09:00:00.000Z', end_time: '2026-12-01T10:00:00.000Z', all_day: false, rrule: null, exdates: [],
      recurrence_id: null, recurrence_master_id: null, source: 'admin', source_id: null, status: 'confirmed',
    },
    overrides: [],
    options: {},
  };
}

interface Fixture { id: string; key: LegacyKey; uid: string; href: string; s: SerializedObject }

function source(summary = 'Riunione', opts: { id?: string; uid?: string; href?: string } = {}): Fixture {
  const id = opts.id ?? randomUUID();
  const uid = opts.uid ?? `tst-apply-${id.slice(0, 8)}`;
  const href = opts.href ?? `${uid}.ics`;
  const text = ics(uid, summary);
  const key = `event:${id}` as LegacyKey;
  return {
    id, key, uid, href,
    s: {
      legacy_key: key, kind: 'event', calendar_id: cal.id, collection_name: collection, href, uid, ics: text,
      fingerprint: fingerprintOf(text), legacy_snapshot: snapshot(id, uid, summary), legacy_hash: hashOf(summary + id),
      legacy_event_id: id, legacy_uid: uid, object_ids: [{ recurrence_key: '', id, legacy_event_id: id }],
      anomalies: [], expected_reasons: [], summary,
    },
  };
}

function item(action: PlanAction, f: Fixture, extra: Partial<PlanItem> = {}): PlanItem {
  return {
    legacy_key: f.key, kind: 'event', calendar_id: cal.id, collection_name: collection, href: f.href, action,
    code: null, source: f.s, ledger: null, target: null, patch: false, other_href: null, fields: [], ...extra,
  };
}

function target(f: Fixture, etag: string, text = f.s.ics, href = f.href): TargetObject {
  return { calendar_id: cal.id, collection_name: collection, href, etag, uid: f.uid, fingerprint: fingerprintOf(text), raw: text };
}

function intentInput(f: Fixture, extra: Partial<RecordIntentInput> = {}): RecordIntentInput {
  return {
    ledgerId: null, calendar_id: cal.id, collection_name: collection, href: f.href, kind: 'event', legacy_key: f.key,
    legacy_event_id: f.id, uid: f.uid, op: 'create', fingerprint: f.s.fingerprint, legacy_hash: f.s.legacy_hash,
    snapshot: f.s.legacy_snapshot, if_match: null, runId: null, objectIds: f.s.object_ids, legacy_uid: f.uid, ...extra,
  };
}

async function row(id: string): Promise<LedgerRow> {
  const rows = await readLedger(sql, { calendarIds: [cal.id], includeDeleted: true });
  const found = rows.find((r) => r.id === id);
  assert.ok(found, `riga ${id}`);
  return found;
}

/** Riga scritta (create completato) per una fixture. */
async function written(f: Fixture, etag = '"e-1"'): Promise<LedgerRow> {
  const intent = await recordIntent(sql, intentInput(f));
  return completeIntent(sql, intent.id, { etag, runId: null });
}

type Handler = (req: TransportRequest) => TransportResponse | Promise<TransportResponse>;

function fake(handler: Handler): { ctx: ExecuteContext; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const client = new RadicaleClient({
    baseUrl: 'http://radicale.test',
    password: 'test-only',
    retries: 0,
    transport: async (req) => {
      calls.push(req);
      return handler(req);
    },
  });
  return {
    calls,
    ctx: { db: sql, client, principal: P, runId: null, actor: TEST_ACTOR, mode: 'apply', forced: false, throttle: async () => undefined, now: () => new Date() },
  };
}

const ok = (status: number, headers: Record<string, string> = {}, body = ''): TransportResponse => ({ status, headers, body });

function multistatusEtag(etag: string): string {
  return `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/x</href><propstat><prop><getetag>${etag}</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
}

// ─── Funzioni pure ───────────────────────────────

describe('funzioni pure di verify e report', () => {
  test('v3Windows: finestre contigue di al più 60 giorni, l\'ultima parziale; intervallo vuoto o invertito senza finestre', () => {
    const from = new Date('2025-10-10T00:00:00Z');
    const to = new Date('2028-10-09T00:00:00Z');
    const windows = v3Windows(from, to);
    assert.equal(windows[0].from.getTime(), from.getTime());
    assert.equal(windows[windows.length - 1].to.getTime(), to.getTime());
    for (let i = 0; i < windows.length; i++) {
      assert.ok(windows[i].to.getTime() - windows[i].from.getTime() <= 60 * 86_400_000);
      if (i > 0) assert.equal(windows[i].from.getTime(), windows[i - 1].to.getTime());
    }
    assert.equal(windows.length, Math.ceil((to.getTime() - from.getTime()) / (60 * 86_400_000)));
    assert.deepEqual(v3Windows(to, from), []);
    assert.equal(v3Windows(from, new Date(from.getTime() + 86_400_000), 7).length, 1);
    assert.throws(() => v3Windows(new Date('x'), to), TypeError);
    assert.throws(() => v3Windows(from, to, 0), TypeError);
  });

  test('diffSignature: stabile rispetto all\'ordine delle chiavi, sensibile a motivo e valori, indifferente al messaggio', () => {
    const base = { level: 'V3' as const, code: 'OCCURRENCE_EXTRA' as const, expected: true, calendar_id: cal?.id ?? randomUUID(), collection_name: 'c', href: 'a.ics', legacy_key: 'event:1' as LegacyKey };
    const a = diffSignature({ ...base, detail: { reason: 'UNTIL_REALIGNED', legacy: null, target: { start: 'x', end: 'y' }, message: 'uno' } });
    const b = diffSignature({ ...base, detail: { message: 'due', target: { end: 'y', start: 'x' }, legacy: null, reason: 'UNTIL_REALIGNED' } });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, diffSignature({ ...base, detail: { reason: null, legacy: null, target: { start: 'x', end: 'y' } } }));
    assert.notEqual(a, diffSignature({ ...base, detail: { reason: 'UNTIL_REALIGNED', legacy: null, target: { start: 'x', end: 'z' } } }));
    assert.notEqual(a, diffSignature({ ...base, level: 'V5', detail: { reason: 'UNTIL_REALIGNED', legacy: null, target: { start: 'x', end: 'y' } } }));
  });

  test('intervalli del busy: unione di sovrapposti e contigui, differenza in entrambi i versi', () => {
    assert.deepEqual(mergeIntervals([{ start: 5, end: 7 }, { start: 1, end: 3 }, { start: 3, end: 4 }, { start: 6, end: 9 }, { start: 10, end: 10 }]), [{ start: 1, end: 4 }, { start: 5, end: 9 }]);
    const a = mergeIntervals([{ start: 0, end: 10 }, { start: 20, end: 30 }]);
    const b = mergeIntervals([{ start: 2, end: 4 }, { start: 8, end: 22 }, { start: 25, end: 26 }]);
    assert.deepEqual(subtractIntervals(a, b), [{ start: 0, end: 2 }, { start: 4, end: 8 }, { start: 22, end: 25 }, { start: 26, end: 30 }]);
    assert.deepEqual(subtractIntervals(b, a), [{ start: 10, end: 20 }]);
    assert.deepEqual(subtractIntervals(a, a), []);
    assert.deepEqual(subtractIntervals(a, []), a);
  });

  test('verdetti: verde senza differenze, giallo accettato solo con tutte le attese accettate, rosso mai; le informative non contano', () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    const c3 = randomUUID();
    const verdicts = buildVerdicts(
      [{ calendar_id: c1, collection_name: 'a', slug: 'a' }, { calendar_id: c2, collection_name: 'b', slug: 'b' }, { calendar_id: c3, collection_name: 'c', slug: 'c' }],
      ['V1', 'V3', 'V4'],
      [
        { calendar_id: c1, level: 'V4', expected: true, accepted: false, variant: 'with_subscriptions' },
        { calendar_id: c2, level: 'V3', expected: true, accepted: true },
        { calendar_id: c2, level: 'V3', expected: true, accepted: false },
        { calendar_id: c3, level: 'V1', expected: false, accepted: false },
        { calendar_id: c3, level: 'V3', expected: true, accepted: true },
      ],
    );
    const by = new Map(verdicts.map((v) => [v.calendar_id, v]));
    assert.equal(by.get(c1)?.color, 'green');
    assert.equal(by.get(c1)?.accepted, true);
    assert.equal(by.get(c2)?.color, 'yellow');
    assert.equal(by.get(c2)?.accepted, false);
    assert.deepEqual(by.get(c2)?.levels.V3, { color: 'yellow', diffs: 2, expected: 2, unexpected: 0 });
    assert.equal(by.get(c3)?.color, 'red');
    assert.equal(by.get(c3)?.accepted, false);
    assert.equal(by.get(c3)?.levels.V1?.color, 'red');
    assert.deepEqual(by.get(c3)?.levels.V4, { color: 'green', diffs: 0, expected: 0, unexpected: 0 });
  });

  test('motivi attesi: V4 solo quelli degli oggetti sovrapposti; V5 comprende quelli del feed', () => {
    assert.ok(!LEVEL_EXPECTED_REASONS.V4.includes('ORPHAN_CONVERTED'));
    assert.ok(LEVEL_EXPECTED_REASONS.V4.includes('DST_REALIGNED'));
    for (const r of ['OVERRIDE_UID_MASTER', 'CANCELLED_OVERRIDE_SUPPRESSED', 'NON_PROJECTION_MOVED', 'CANCELLED_MASTER_SKIPPED'] as const) {
      assert.ok(LEVEL_EXPECTED_REASONS.V5.includes(r), r);
    }
    assert.ok(LEVEL_EXPECTED_REASONS.V3.includes('NON_PROJECTION_MOVED'));
  });

  test('campi del piano (V2): i campi cambiati contano, VALARM e X-* dei device no', () => {
    const base = ics('tst-v2', 'Riunione', ['X-CALDES-SOURCE:admin']);
    const withAlarm = ics('tst-v2', 'Riunione', ['X-CALDES-SOURCE:admin', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Promemoria', 'END:VALARM']);
    const renamed = ics('tst-v2', 'Riunione spostata', ['X-CALDES-SOURCE:mcp']);
    const p = (t: string) => {
      const r = parseCalendarObject(t);
      assert.ok(r.ok);
      return r.value;
    };
    assert.deepEqual(planFieldDiffs(p(withAlarm), p(base), 'Europe/Rome'), []);
    assert.deepEqual(planFieldDiffs(p(renamed), p(base), 'Europe/Rome').sort(), ['X-CALDES-SOURCE', 'summary']);
  });

  test('summarizePlanItems è la stessa implementazione dell\'anteprima', () => {
    const f = source('Conteggi');
    const items = [item('create', f), item('noop', f), item('conflict', f, { code: 'TARGET_NEWER' }), item('skip', f, { code: 'CANCELLED_MASTER', source: null })];
    assert.deepEqual(summarizePlanItems(items), planCounts(items));
    assert.equal(summarizePlanItems(items).writes, 1);
  });
});

// ─── Primitive del ledger ───────────────────────────────

describe('primitive del ledger', () => {
  test('intento di create: riga senza scritture e id legacy preassegnati; esito: etag, fingerprint, hash e snapshot dell\'intento', async () => {
    const f = source('Intento');
    const intent = await recordIntent(sql, intentInput(f, { runId: null }));
    assert.equal(intent.intent_op, 'create');
    assert.equal(intent.intent_fingerprint, f.s.fingerprint);
    assert.equal(intent.written_etag, null);
    assert.equal(intent.legacy_hash, null);
    const [ids] = await sql<Array<{ id: string; legacy_event_id: string; legacy_uid: string; uid: string }>>`
      SELECT id::text AS id, legacy_event_id::text AS legacy_event_id, legacy_uid, uid FROM cal_object_ids
      WHERE calendar_id = ${cal.id}::uuid AND href = ${f.href} AND recurrence_key = ''
    `;
    assert.deepEqual(ids, { id: f.id, legacy_event_id: f.id, legacy_uid: f.uid, uid: f.uid });

    const done = await completeIntent(sql, intent.id, { etag: '"e-1"', runId: null });
    assert.equal(done.written_etag, '"e-1"');
    assert.equal(done.written_fingerprint, f.s.fingerprint);
    assert.equal(done.legacy_hash, f.s.legacy_hash);
    assert.deepEqual(done.legacy_snapshot, f.s.legacy_snapshot);
    assert.equal(done.intent_op, null);
    assert.equal(done.adopted, false);
    await assert.rejects(completeIntent(sql, intent.id, { etag: '"e-2"', runId: null }), LedgerStateError);
  });

  test('azzeramento: una riga scritta conserva le scritture, una mai scritta si ritira e una ripresa la riattiva', async () => {
    const f = source('Azzeramento');
    const w = await written(f);
    const upd = await recordIntent(sql, intentInput(f, { ledgerId: w.id, op: 'update', if_match: '"e-1"' }));
    assert.equal(upd.intent_op, 'update');
    assert.equal(upd.intent_etag, '"e-1"');
    await clearIntent(sql, upd.id);
    const kept = await row(w.id);
    assert.equal(kept.deleted_at, null);
    assert.equal(kept.written_etag, '"e-1"');
    assert.equal(kept.intent_op, null);

    const g = source('Mai scritta');
    const pending = await recordIntent(sql, intentInput(g));
    await clearIntent(sql, pending.id);
    const retired = await row(pending.id);
    assert.ok(retired.deleted_at, 'riga mai scritta ritirata');
    const revived = await recordIntent(sql, intentInput(g, { ledgerId: pending.id }));
    assert.equal(revived.id, pending.id);
    assert.equal(revived.deleted_at, null);
    assert.equal(revived.intent_op, 'create');
  });

  test('una riga ritirata allo stesso href si riutilizza anche per un\'altra chiave; una viva di un\'altra chiave è un conflitto', async () => {
    const f = source('Prima');
    const w = await written(f);
    await retireLedgerRow(sql, w.id, null);
    const g = source('Seconda', { href: f.href });
    const reused = await recordIntent(sql, intentInput(g));
    assert.equal(reused.id, w.id, 'una riga per href');
    assert.equal(reused.legacy_key, g.key);
    assert.equal(reused.uid, g.uid);
    assert.equal(reused.legacy_event_id, g.id);
    await completeIntent(sql, reused.id, { etag: '"e-2"', runId: null });

    const h = source('Terza', { href: f.href });
    await assert.rejects(recordIntent(sql, intentInput(h)), (err: unknown) => err instanceof LedgerConflictError && err.reason === 'href');
  });

  test('UID: una riga mai scritta di un\'altra chiave con lo stesso UID si ritira, una scritta è un conflitto', async () => {
    const f = source('Uid A', { uid: `tst-apply-uid-${randomUUID().slice(0, 6)}` });
    const stale = await recordIntent(sql, intentInput(f));
    await sql`UPDATE cal_migration_ledger SET intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL, intent_etag = NULL, intent_at = NULL, intent_run_id = NULL WHERE id = ${stale.id}::bigint`;
    const g = source('Uid B', { uid: f.uid, href: `altro-${f.href}` });
    const ok2 = await recordIntent(sql, intentInput(g));
    assert.ok((await row(stale.id)).deleted_at, 'riga mai scritta con lo stesso UID ritirata');
    await completeIntent(sql, ok2.id, { etag: '"e-1"', runId: null });
    const h = source('Uid C', { uid: f.uid, href: `terzo-${f.href}` });
    await assert.rejects(recordIntent(sql, intentInput(h)), (err: unknown) => err instanceof LedgerConflictError && err.reason === 'uid');
  });

  test('una riga mai scritta della stessa chiave si sposta all\'href voluto; una scritta no', async () => {
    const f = source('Spostata');
    const first = await recordIntent(sql, intentInput(f));
    await sql`UPDATE cal_migration_ledger SET intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL, intent_etag = NULL, intent_at = NULL, intent_run_id = NULL WHERE id = ${first.id}::bigint`;
    const moved = await recordIntent(sql, intentInput(f, { href: `nuovo-${f.href}` }));
    assert.equal(moved.id, first.id);
    assert.equal(moved.href, `nuovo-${f.href}`);
    await completeIntent(sql, moved.id, { etag: '"e-1"', runId: null });
    await assert.rejects(recordIntent(sql, intentInput(f, { href: `terzo-${f.href}` })), (err: unknown) => err instanceof LedgerConflictError && err.reason === 'key');
  });

  test('intento di delete e completeIntent: la riga si ritira con scritture, hash e snapshot a NULL', async () => {
    const f = source('Da cancellare');
    const w = await written(f);
    const del = await recordIntent(sql, intentInput(f, { ledgerId: w.id, op: 'delete', fingerprint: null, legacy_hash: null, snapshot: null, if_match: '"e-1"', objectIds: [] }));
    assert.equal(del.intent_op, 'delete');
    assert.equal(del.intent_snapshot, null);
    await completeIntent(sql, del.id, { etag: null, runId: null });
    const r = await row(w.id);
    assert.ok(r.deleted_at);
    assert.equal(r.written_etag, null);
    assert.equal(r.legacy_hash, null);
    assert.equal(r.legacy_snapshot, null);
  });

  test('validazione: create senza fingerprint, update senza If-Match, chiave incoerente', async () => {
    const f = source('Validazione');
    await assert.rejects(recordIntent(sql, intentInput(f, { fingerprint: null })), TypeError);
    await assert.rejects(recordIntent(sql, intentInput(f, { op: 'update' })), TypeError);
    await assert.rejects(recordIntent(sql, intentInput(f, { kind: 'booking' })), TypeError);
  });

  test('id legacy già usato da un\'altra posizione: la riga d\'intento si scrive comunque (l\'id lo assegnerà la sync)', async () => {
    const f = source('Id conteso');
    await written(f);
    const g = source('Id conteso bis');
    const intent = await recordIntent(sql, intentInput(g, { objectIds: [{ recurrence_key: '', id: f.id, legacy_event_id: f.id }] }));
    assert.equal(intent.intent_op, 'create');
  });

  test('adozione: riga nuova adottata; destinazione ancora quella scritta → flag conservato; riga mai scritta spostata sull\'href trovato', async () => {
    const f = source('Adottata');
    const a = await adoptTarget(sql, { item: item('adopt', f), target: target(f, '"t-1"'), runId: null });
    assert.equal(a.adopted, true);
    assert.equal(a.written_etag, '"t-1"');
    assert.equal(a.legacy_hash, f.s.legacy_hash);

    const g = source('Rinfresco');
    const w = await written(g, '"e-1"');
    const refreshed = await adoptTarget(sql, { item: item('adopt', g, { ledger: w }), target: target(g, '"e-1"'), runId: null });
    assert.equal(refreshed.id, w.id);
    assert.equal(refreshed.adopted, false, 'stesso etag dell\'ultima scrittura: non diventa adottata');

    const h = source('Altro href');
    const stale = await recordIntent(sql, intentInput(h));
    await sql`UPDATE cal_migration_ledger SET intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL, intent_etag = NULL, intent_at = NULL, intent_run_id = NULL WHERE id = ${stale.id}::bigint`;
    const other = await adoptTarget(sql, { item: item('adopt', h, { ledger: stale, other_href: 'trovato.ics' }), target: target(h, '"o-1"', h.s.ics, 'trovato.ics'), runId: null });
    assert.equal(other.id, stale.id);
    assert.equal(other.href, 'trovato.ics');
    assert.equal(other.adopted, true);
  });

  test('readLedger: filtri per calendario, chiave e righe ritirate', async () => {
    const f = source('Lettura');
    const w = await written(f);
    assert.ok((await readLedger(sql, { legacyKeys: [f.key] })).some((r) => r.id === w.id));
    assert.deepEqual(await readLedger(sql, { legacyKeys: [] }), []);
    await retireLedgerRow(sql, w.id, null);
    assert.ok(!(await readLedger(sql, { calendarIds: [cal.id] })).some((r) => r.id === w.id));
    assert.ok((await readLedger(sql, { calendarIds: [cal.id], includeDeleted: true })).some((r) => r.id === w.id));
  });
});

// ─── executePlanItem ───────────────────────────────

describe('executePlanItem con un trasporto finto', () => {
  test('create 201: If-None-Match, esito done con l\'etag della risposta; senza etag lo legge con un PROPFIND', async () => {
    const f = source('Creato');
    const { ctx, calls } = fake(() => ok(201, { etag: '"n-1"' }));
    const res = await executePlanItem(item('create', f), ctx);
    assert.equal(res.outcome, 'done');
    assert.equal(res.etag_after, '"n-1"');
    assert.equal(calls[0].headers['If-None-Match'], '*');
    const r = (await readLedger(sql, { legacyKeys: [f.key] }))[0];
    assert.equal(r.written_etag, '"n-1"');
    assert.equal(r.intent_op, null);

    const g = source('Senza etag');
    const second = fake((req) => (req.method === 'PUT' ? ok(201) : ok(207, {}, multistatusEtag('"p-1"'))));
    const res2 = await executePlanItem(item('create', g), second.ctx);
    assert.equal(res2.outcome, 'done');
    assert.equal(res2.etag_after, '"p-1"');
    assert.deepEqual(second.calls.map((c) => c.method), ['PUT', 'PROPFIND']);
  });

  test('create 412: con lo stesso contenuto già presente si adotta, altrimenti UNTRACKED_TARGET e intento azzerato', async () => {
    const f = source('Gara uguale');
    const same = fake((req) => (req.method === 'PUT' ? ok(412) : ok(200, { etag: '"g-1"' }, f.s.ics)));
    const res = await executePlanItem(item('create', f), same.ctx);
    assert.equal(res.outcome, 'adopted');
    const r = (await readLedger(sql, { legacyKeys: [f.key] }))[0];
    assert.equal(r.adopted, true);
    assert.equal(r.written_etag, '"g-1"');

    const g = source('Gara diversa');
    const diff = fake((req) => (req.method === 'PUT' ? ok(412) : ok(200, { etag: '"g-2"' }, ics(g.uid, 'Altro'))));
    const res2 = await executePlanItem(item('create', g), diff.ctx);
    assert.equal(res2.outcome, 'conflict');
    assert.equal(res2.code, 'UNTRACKED_TARGET');
    assert.deepEqual(await readLedger(sql, { legacyKeys: [g.key] }), [], 'riga mai scritta ritirata');
  });

  test('update 412: BOTH_CHANGED, intento azzerato e scritture precedenti intatte', async () => {
    const f = source('Update conteso');
    const w = await written(f, '"e-1"');
    const { ctx, calls } = fake(() => ok(412));
    const res = await executePlanItem(item('update', f, { ledger: w, target: target(f, '"e-1"') }), ctx);
    assert.equal(res.outcome, 'conflict');
    assert.equal(res.code, 'BOTH_CHANGED');
    assert.equal(calls[0].headers['If-Match'], '"e-1"');
    const r = await row(w.id);
    assert.equal(r.intent_op, null);
    assert.equal(r.written_etag, '"e-1"');
  });

  test('connessione caduta dopo la PUT: esito ignoto, failed con l\'intento pendente; rifiuto certo (400): intento azzerato', async () => {
    const f = source('Esito ignoto');
    const lost = fake(() => {
      throw new TransportError('network', 'reset', true, 'ECONNRESET');
    });
    const res = await executePlanItem(item('create', f), lost.ctx);
    assert.equal(res.outcome, 'failed');
    const pending = (await readLedger(sql, { legacyKeys: [f.key] }))[0];
    assert.equal(pending.intent_op, 'create', 'intento rimasto per il giro successivo');

    const g = source('Rifiutato');
    const bad = fake(() => ok(400));
    const res2 = await executePlanItem(item('create', g), bad.ctx);
    assert.equal(res2.outcome, 'failed');
    assert.equal(res2.http_status, 400);
    assert.deepEqual(await readLedger(sql, { legacyKeys: [g.key] }), []);
  });

  test('404 sulla PUT: COLLECTION_MISSING (mai una collezione creata)', async () => {
    const f = source('Senza collezione');
    const { ctx, calls } = fake(() => ok(404));
    const res = await executePlanItem(item('create', f), ctx);
    assert.equal(res.code, 'COLLECTION_MISSING');
    assert.ok(calls.every((c) => c.method !== 'MKCALENDAR' && c.method !== 'MKCOL'));
  });

  test('item forzato senza la conferma del chiamante: resta un conflitto e nessuna richiesta; con la conferma esito forced', async () => {
    const f = source('Forzato');
    const { ctx, calls } = fake(() => ok(201, { etag: '"f-1"' }));
    const res = await executePlanItem(item('create', f, { code: 'DELETED_IN_TARGET' }), ctx);
    assert.equal(res.outcome, 'conflict');
    assert.equal(res.code, 'DELETED_IN_TARGET');
    assert.equal(calls.length, 0);
    const res2 = await executePlanItem(item('create', f, { code: 'DELETED_IN_TARGET' }), { ...ctx, forced: true });
    assert.equal(res2.outcome, 'forced');
  });

  test('delete: 204 → riga ritirata; 404 → già sparita (adozione); 412 → TARGET_NEWER e riga intatta', async () => {
    const a = source('Delete ok');
    const wa = await written(a, '"d-1"');
    const okDel = fake(() => ok(204));
    const r1 = await executePlanItem(item('delete', a, { source: null, ledger: wa, target: target(a, '"d-1"') }), okDel.ctx);
    assert.equal(r1.outcome, 'done');
    assert.equal(okDel.calls[0].method, 'DELETE');
    assert.equal(okDel.calls[0].headers['If-Match'], '"d-1"');
    assert.ok((await row(wa.id)).deleted_at);

    const b = source('Delete sparito');
    const wb = await written(b, '"d-2"');
    const r2 = await executePlanItem(item('delete', b, { source: null, ledger: wb, target: target(b, '"d-2"') }), fake(() => ok(404)).ctx);
    assert.equal(r2.outcome, 'adopted');
    assert.ok((await row(wb.id)).deleted_at);

    const c = source('Delete conteso');
    const wc = await written(c, '"d-3"');
    const r3 = await executePlanItem(item('delete', c, { source: null, ledger: wc, target: target(c, '"d-3"') }), fake(() => ok(412)).ctx);
    assert.equal(r3.code, 'TARGET_NEWER');
    const after = await row(wc.id);
    assert.equal(after.deleted_at, null);
    assert.equal(after.intent_op, null);
    assert.equal(after.written_etag, '"d-3"');
  });

  test('adozione di un intento: create con la destinazione già scritta → esito senza richiesta; delete con la destinazione assente → ritiro', async () => {
    const f = source('Intento applicato');
    const intent = await recordIntent(sql, intentInput(f));
    const { ctx, calls } = fake(() => ok(500));
    const res = await executePlanItem(item('adopt', f, { ledger: intent, target: target(f, '"a-1"') }), ctx);
    assert.equal(res.outcome, 'adopted');
    assert.equal(calls.length, 0);
    const r = await row(intent.id);
    assert.equal(r.adopted, true);
    assert.equal(r.written_etag, '"a-1"');
    assert.equal(r.intent_op, null);

    const g = source('Delete applicato');
    const w = await written(g, '"x-1"');
    const del = await recordIntent(sql, intentInput(g, { ledgerId: w.id, op: 'delete', fingerprint: null, legacy_hash: null, snapshot: null, if_match: '"x-1"', objectIds: [] }));
    const res2 = await executePlanItem(item('adopt', g, { source: null, ledger: del, target: null }), ctx);
    assert.equal(res2.outcome, 'adopted');
    assert.ok((await row(w.id)).deleted_at);
  });

  test('noop: la rivalidazione si toglie senza scrivere; skip non tocca nulla', async () => {
    const f = source('Rivalidata');
    const w = await written(f);
    await sql`UPDATE cal_migration_ledger SET revalidate_reason = 'backup-import', revalidate_since = now() WHERE id = ${w.id}::bigint`;
    const { ctx, calls } = fake(() => ok(500));
    const res = await executePlanItem(item('noop', f, { ledger: { ...w, revalidate_reason: 'backup-import' }, target: target(f, '"e-1"') }), ctx);
    assert.equal(res.outcome, 'noop');
    assert.equal((await row(w.id)).revalidate_reason, null);
    const skipped = await executePlanItem(item('skip', f, { code: 'CANCELLED_MASTER', source: null }), ctx);
    assert.equal(skipped.outcome, 'skipped');
    assert.equal(skipped.code, 'CANCELLED_MASTER');
    assert.equal(calls.length, 0);
  });
});

// ─── Limitatore e lock ───────────────────────────────

describe('limitatore di processo e lock cal-migration', () => {
  test('migrationThrottle: al più 20 richieste al secondo, condiviso fra le funzioni restituite', async () => {
    const a = migrationThrottle();
    const b = migrationThrottle();
    const started = Date.now();
    await Promise.all([a(), b(), a(), b(), a(), b()]);
    assert.ok(Date.now() - started >= 200, `6 slot a 20/s richiedono almeno 250 ms (misurati ${Date.now() - started})`);
  });

  test('withMigrationRunLock: preso e rilasciato se libero; con il lock dell\'esecutore il run procede senza prenderlo', async () => {
    const heldBy = async (): Promise<number> => {
      const [r] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext('cal-migration')::bigint
      `;
      return r.n;
    };
    assert.equal(await heldBy(), 0);
    await withMigrationRunLock(sql, async () => {
      assert.equal(await heldBy(), 1, 'preso dal modulo');
    });
    assert.equal(await heldBy(), 0, 'rilasciato');

    const executor = await sql.reserve();
    try {
      await executor`SELECT pg_advisory_lock(hashtext('cal-migration'))`;
      let ran = false;
      await withMigrationRunLock(sql, async () => {
        ran = true;
        assert.equal(await heldBy(), 1);
      });
      assert.equal(ran, true);
      assert.equal(await heldBy(), 1, 'il lock resta all\'esecutore');
      await executor`SELECT pg_advisory_unlock(hashtext('cal-migration'))`;
    } finally {
      executor.release();
    }
  });
});

// ─── Accettazioni e report ───────────────────────────────

function diffRow(calendarId: string, opts: { expected: boolean; signature: string; level?: string; code?: string; message?: string; variant?: string }): MigrationItemInput {
  return {
    item_type: 'diff',
    calendar_id: calendarId,
    collection_name: 'c',
    href: 'a.ics',
    legacy_key: 'event:00000000-0000-4000-8000-000000000001',
    code: opts.code ?? 'OCCURRENCE_EXTRA',
    level: (opts.level ?? 'V3') as 'V3',
    expected: opts.expected,
    severity: opts.expected ? 'warning' : 'error',
    detail: { reason: opts.expected ? 'UNTIL_REALIGNED' : null, signature: opts.signature, message: opts.message ?? null, ...(opts.variant ? { variant: opts.variant } : {}) },
  };
}

async function verifyRun(rows: MigrationItemInput[], opts: { levels?: VerifyParams['levels']; scope?: VerifyParams['scope']; status?: 'succeeded' | 'running' } = {}): Promise<{ runId: string; ids: string[] }> {
  const params: VerifyParams = { scope: opts.scope ?? {}, levels: opts.levels ?? ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 180 };
  const run = await persistedRun('verify', params);
  const ids = await insertItems(run.ctx.runId, rows);
  if (opts.status !== 'running') {
    await run.finish({ summary: { generated_at: new Date().toISOString(), levels: params.levels, overall: 'yellow', acceptable: false, calendars: [{ calendar_id: cal.id, collection_name: collection, slug: cal.slug, color: 'yellow', accepted: false, levels: {} }], v4: null, totals: { diffs: rows.length, expected: 0, unexpected: 0, accepted: 0 } } });
  }
  return { runId: run.ctx.runId, ids };
}

describe('accettazioni, ultima verifica e report', () => {
  test('acceptDiffs: solo run di verifica riusciti, mai le rosse; accettazione per righe o per calendario con riassunto aggiornato', async () => {
    const plan = await persistedRun('plan', { scope: {}, options: {} });
    await plan.finish({ summary: {} });
    await assert.rejects(acceptDiffs(sql, { runId: plan.ctx.runId, allExpected: true, actor: TEST_ACTOR }), (err: unknown) => err instanceof MigrationError && err.code === 'PRECONDITION_FAILED' && (err.details?.reasons as string[]).includes('RUN_KIND_NOT_VERIFY'));
    await assert.rejects(acceptDiffs(sql, { runId: randomUUID(), allExpected: true, actor: TEST_ACTOR }), (err: unknown) => err instanceof MigrationError && err.code === 'RUN_NOT_FOUND');

    const running = await verifyRun([diffRow(cal.id, { expected: true, signature: 'a'.repeat(64) })], { status: 'running' });
    await assert.rejects(acceptDiffs(sql, { runId: running.runId, allExpected: true, actor: TEST_ACTOR }), (err: unknown) => err instanceof MigrationError && err.code === 'PRECONDITION_FAILED');
    await closeActiveRuns();

    const v = await verifyRun([
      diffRow(cal.id, { expected: true, signature: 'b'.repeat(64) }),
      diffRow(cal.id, { expected: true, signature: 'c'.repeat(64) }),
      diffRow(cal.id, { expected: false, signature: 'd'.repeat(64), level: 'V1', code: 'TARGET_UNTRACKED' }),
    ]);
    await assert.rejects(acceptDiffs(sql, { runId: v.runId, itemIds: [v.ids[0], v.ids[2]], actor: TEST_ACTOR }), (err: unknown) => err instanceof MigrationError && err.code === 'NOT_ACCEPTABLE');
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_migration_items WHERE run_id = ${v.runId}::uuid AND accepted_at IS NOT NULL`;
    assert.equal(n, 0, 'nessuna accettazione parziale');
    await assert.rejects(acceptDiffs(sql, { runId: v.runId, actor: TEST_ACTOR }), (err: unknown) => err instanceof MigrationError && err.code === 'VALIDATION_FAILED');

    const one = await acceptDiffs(sql, { runId: v.runId, itemIds: [v.ids[0]], actor: TEST_ACTOR });
    assert.equal(one.accepted, 1);
    const rest = await acceptDiffs(sql, { runId: v.runId, calendarId: cal.id, actor: TEST_ACTOR });
    assert.equal(rest.accepted, 1, 'le rosse restano fuori');
    const verdict = rest.calendars.find((c) => c.calendar_id === cal.id);
    assert.equal(verdict?.color, 'red');
    assert.equal(verdict?.accepted, false);
    assert.equal(rest.acceptable, false);
    const [run] = await sql<Array<{ summary: { totals: { accepted: number }; acceptable: boolean } }>>`SELECT summary FROM cal_migration_runs WHERE id = ${v.runId}::uuid`;
    assert.equal(run.summary.totals.accepted, 2);
    assert.equal(run.summary.acceptable, false);
  });

  test('carryOverAcceptances: stessa firma accettata in una verifica precedente → accettata; firma nuova o rossa no', async () => {
    const sigA = 'e'.repeat(64);
    const sigB = 'f'.repeat(64);
    const first = await verifyRun([diffRow(cal.id, { expected: true, signature: sigA })]);
    await acceptDiffs(sql, { runId: first.runId, allExpected: true, actor: 'admin:altro' });
    const second = await verifyRun([
      diffRow(cal.id, { expected: true, signature: sigA }),
      diffRow(cal.id, { expected: true, signature: sigB }),
      diffRow(cal.id, { expected: false, signature: sigA, level: 'V2', code: 'CONTENT_MISMATCH' }),
    ]);
    assert.equal(await carryOverAcceptances(sql, second.runId), 1);
    const rows = await sql<Array<{ id: string; accepted_by: string | null }>>`SELECT id::text AS id, accepted_by FROM cal_migration_items WHERE run_id = ${second.runId}::uuid ORDER BY seq`;
    assert.deepEqual(rows.map((r) => r.accepted_by), ['admin:altro', null, null]);
    const verdicts = await calendarVerdicts(sql, second.runId);
    assert.equal(verdicts.find((x) => x.calendar_id === cal.id)?.color, 'red');
  });

  test('latestVerifyVerdicts: l\'ultima verifica completa (tutti i livelli, tutti i calendari), non quelle parziali', async () => {
    const full = await verifyRun([diffRow(cal.id, { expected: true, signature: '1'.repeat(64) })]);
    await verifyRun([], { levels: ['V4'] });
    await verifyRun([], { scope: { calendar_ids: [cal.id] } });
    const latest = await latestVerifyVerdicts(sql);
    assert.equal(latest.runId, full.runId);
    assert.equal(latest.acceptable, false);
    await acceptDiffs(sql, { runId: full.runId, allExpected: true, actor: TEST_ACTOR });
    assert.equal((await latestVerifyVerdicts(sql)).acceptable, true);
  });

  test('report: JSON con run, sezione leggibile e righe; CSV con le formule neutralizzate e il BOM; formato e run validati', async () => {
    const v = await verifyRun([
      diffRow(cal.id, { expected: true, signature: '2'.repeat(64), message: '=HYPERLINK("http://x")' }),
      diffRow(cal.id, { expected: false, signature: '3'.repeat(64), level: 'V1', code: 'TARGET_UNTRACKED', message: 'riga, con "virgolette"' }),
    ]);
    const json = await buildRunReport(sql, v.runId, 'json');
    assert.equal(json.contentType, 'application/json; charset=utf-8');
    const body = JSON.parse(json.body) as { report_version: number; run: { id: string; kind: string }; readable: { overall: string; calendars: Array<{ unexpected: unknown[]; to_accept: unknown[] }> }; items: Array<{ id: string }>; verdicts: unknown[] };
    assert.equal(body.report_version, 1);
    assert.equal(body.run.id, v.runId);
    assert.equal(body.readable.overall, 'red');
    assert.equal(body.items.length, 2);
    assert.equal(body.readable.calendars[0].unexpected.length, 1);
    assert.equal(body.readable.calendars[0].to_accept.length, 1);

    const csv = await buildRunReport(sql, v.runId, 'csv');
    assert.match(csv.filename, /\.csv$/);
    assert.ok(csv.body.startsWith('﻿id,seq,item_type'));
    const lines = csv.body.slice(1).trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.ok(!/(^|,)=/.test(lines[1]), 'nessuna cella che inizia con =');
    assert.match(csv.body, /virgolette/);

    await assert.rejects(buildRunReport(sql, v.runId, 'xml' as 'json'), (err: unknown) => err instanceof MigrationError && err.code === 'VALIDATION_FAILED');
    await assert.rejects(buildRunReport(sql, randomUUID(), 'json'), (err: unknown) => err instanceof MigrationError && err.code === 'RUN_NOT_FOUND');
  });
});
