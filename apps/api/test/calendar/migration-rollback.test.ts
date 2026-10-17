/**
 * Rollback, ri-baseline, finalize e backup della F4 senza Radicale
 * (apps/api/src/lib/calendar/migration/{rollback,rebaseline,finalize}.ts,
 * serializer e piano per le righe derivate, routes/backup.ts ed export v2;
 * contratto docs/calendar-radicale/contracts/f4-modules.md §5). La parte con
 * Radicale reale (rollback completo, kill a ogni passo, nuovo cutover a zero
 * scritture) è in test/integration/migration-rollback.test.ts.
 *
 *  - pure: busy fuso, attori delle versioni, parametri, riassunto del piano
 *    inverso, riconciliazione della ri-baseline (categorie A-G), decisioni
 *    del piano per le sorgenti derived (noop, DERIVED_EDITED, forza senza
 *    scrittura), zip e .ics dell'export v2, nomi delle tabelle con la vista;
 *  - database: righe derivate raggruppate dal serializer in una sorgente
 *    `derived` (mai eventi singoli), blocchi del rollback, blocchi e run del
 *    finalize, backup v1 con calendar_events vista (simulata) ed export v2
 *    rifiutato in mode postgres.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { after, describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { TEST_ENV } from '../helpers/env';
import { useFixtures } from '../helpers/fixtures';
import { api, type TestResponse } from '../helpers/http';
import { persistedRun } from './_migration-apply-shared';
import { buildZip, collectionIcs, crc32, topLevelComponents } from '../../src/lib/calendar/export-v2';
import { finalizeBlockers, finalizeBlockersDetailed, LEGACY_FINALIZE_PENDING_NOTE, runFinalize } from '../../src/lib/calendar/migration/finalize';
import { computePlan, type TargetSnapshot } from '../../src/lib/calendar/migration/plan';
import { decideRebaseline } from '../../src/lib/calendar/migration/rebaseline';
import { actorClass, mergeBusy, normalizeRollbackParams, rollbackBlockers, sameBusy, summarizeReversePlan } from '../../src/lib/calendar/migration/rollback';
import { isDerivedObject, loadLegacySource, serializeLegacy } from '../../src/lib/calendar/migration/serialize';
import {
  DEFAULT_MIGRATION_OPTIONS,
  type FinalizeParams,
  type FinalizeSummary,
  type LedgerRow,
  type LegacyDerivedSnapshot,
  type LegacyKey,
  MigrationError,
  type SerializedObject,
  type TargetObject,
} from '../../src/lib/calendar/migration/types';
import { calendarEventsIsView, exportKeyOf, importKeyOf } from '../../src/routes/backup';

const fx = useFixtures('rollback', { resetBaseline: true });
onBeforeDatabaseClose(async () => {
  await resetCalendarBaseline();
});

const CAL = '11111111-1111-4111-8111-111111111111';
const OBJ = '22222222-2222-4222-8222-222222222222';
const DAY_MS = 86_400_000;
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

// ─── Utilità dei test ───────────────────────────────

function target(href: string, etag: string, fingerprint: string | null = `fp-${href}`): TargetObject {
  return { calendar_id: CAL, collection_name: 'c', href, etag, uid: `${href}-uid`, fingerprint, raw: null };
}

function snapshotTarget(objects: TargetObject[], exists = true): TargetSnapshot {
  return {
    read_at: new Date('2027-01-01T00:00:00Z'),
    collections: new Map([[CAL, { calendar_id: CAL, collection_name: 'c', exists, objects: new Map(objects.map((o) => [o.href, o])) }]]),
  };
}

function ledgerRow(over: Partial<LedgerRow> & Pick<LedgerRow, 'href' | 'legacy_key'>): LedgerRow {
  return {
    id: String(Math.floor(Math.random() * 1e9)),
    calendar_id: CAL,
    collection_name: 'c',
    kind: 'event',
    legacy_event_id: null,
    uid: `${over.href}-uid`,
    legacy_snapshot: null,
    legacy_hash: null,
    written_etag: null,
    written_fingerprint: null,
    written_at: null,
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
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  };
}

function derivedObject(href: string, hash: string): SerializedObject {
  const snapshot: LegacyDerivedSnapshot = {
    v: 1,
    kind: 'derived',
    calendar: { id: CAL, collection_name: 'c', timezone: 'Europe/Rome' } as LegacyDerivedSnapshot['calendar'],
    object_id: OBJ,
    rows: [],
  };
  return {
    legacy_key: `event:${OBJ}` as LegacyKey,
    kind: 'event',
    calendar_id: CAL,
    collection_name: 'c',
    href,
    uid: 'serie@iphone',
    ics: '',
    fingerprint: '',
    legacy_snapshot: snapshot,
    legacy_hash: hash,
    legacy_event_id: OBJ,
    legacy_uid: null,
    object_ids: [],
    anomalies: [],
    expected_reasons: [],
    summary: 'Serie',
  };
}

function plan(objects: SerializedObject[], ledger: LedgerRow[], t: TargetSnapshot, forceCodes: string[] = []) {
  return computePlan({
    mode: 'apply',
    serialization: { serializer_version: 1, objects, skipped: [], anomalies: [] },
    ledger,
    target: t,
    scope: { calendarIds: new Set([CAL]), legacyKeys: null },
    force: { itemKeys: new Set(), codes: new Set(forceCodes as never[]) },
  });
}

/** Lettore minimo di zip (directory centrale; stored o deflate). */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + csize);
    const content = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    assert.equal(crc32(content), crc, `CRC di ${name}`);
    out.set(name, content);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

// ─── Pure ───────────────────────────────

describe('rollback: funzioni pure', () => {
  test('busy fuso e confronto: intervalli sovrapposti o contigui coincidono, un minuto in più no', () => {
    const a = [{ start: '2027-01-01T09:00:00Z', end: '2027-01-01T10:00:00Z' }, { start: '2027-01-01T10:00:00Z', end: '2027-01-01T11:00:00Z' }];
    const b = [{ start: '2027-01-01T09:00:00Z', end: '2027-01-01T11:00:00Z' }, { start: '2027-01-01T09:30:00Z', end: '2027-01-01T10:30:00Z' }];
    assert.equal(mergeBusy(a).length, 1);
    assert.equal(sameBusy(a, b), true);
    assert.equal(sameBusy(a, [{ start: '2027-01-01T09:00:00Z', end: '2027-01-01T11:01:00Z' }]), false);
    assert.equal(sameBusy([], []), true);
  });

  test('attori delle versioni dell\'indice', () => {
    assert.equal(actorClass('sync'), 'device');
    assert.equal(actorClass('write-through:admin'), 'admin');
    assert.equal(actorClass('write-through:admin_manual'), 'admin');
    assert.equal(actorClass('write-through:mcp'), 'mcp');
    assert.equal(actorClass('write-through:project_booking'), 'booking');
    assert.equal(actorClass('rebuild'), 'system');
    assert.equal(actorClass('write-through:api'), 'other');
    assert.equal(actorClass(null), 'other');
  });

  test('parametri del rollback: default, emergenza, valori fuori contratto', () => {
    assert.deepEqual(normalizeRollbackParams(null), { action: 'start', preview_run_id: null, expect_preview_hash: null, emergency: false });
    const id = randomUUID().toUpperCase();
    const hash = 'A'.repeat(64);
    assert.deepEqual(normalizeRollbackParams({ action: 'resume', preview_run_id: id, expect_preview_hash: hash, emergency: true }), {
      action: 'resume', preview_run_id: id.toLowerCase(), expect_preview_hash: hash.toLowerCase(), emergency: true,
    });
    assert.throws(() => normalizeRollbackParams({ action: 'boh' as never }), (e: unknown) => e instanceof MigrationError && e.code === 'VALIDATION_FAILED');
    assert.throws(() => normalizeRollbackParams({ preview_run_id: 'non-un-uuid' }), MigrationError);
    assert.throws(() => normalizeRollbackParams({ expect_preview_hash: 'xyz' }), MigrationError);
  });

  test('riassunto del piano inverso: classi, derivate, REVERSE_FAILED contato una volta', () => {
    const row = (role: 'master' | 'derived') => ({ id: randomUUID(), recurrence_key: role === 'master' ? '' : 'k', role, row: {} as never });
    const summary = summarizeReversePlan({
      objects: [
        { object_id: 'a', calendar_id: CAL, collection_name: 'c', href: 'a.ics', source_etag: null, source_sha256: null, status: 'degraded', rows: [row('master')], degradations: [{ class: 'REPR_LOSS_VALARM' }], delete_row_ids: [], error: null, unchanged: false },
        { object_id: 'b', calendar_id: CAL, collection_name: 'c', href: 'b.ics', source_etag: null, source_sha256: null, status: 'degraded', rows: [row('derived'), row('derived')], degradations: [{ class: 'SEMANTIC_EXPANDED' }], delete_row_ids: [], error: null, unchanged: false },
        { object_id: 'c', calendar_id: CAL, collection_name: 'c', href: 'c.ics', source_etag: null, source_sha256: null, status: 'failed', rows: [], degradations: [{ class: 'REVERSE_FAILED' }], delete_row_ids: [], error: { code: 'REVERSE_FAILED', message: 'x' }, unchanged: false },
        { object_id: 'd', calendar_id: CAL, collection_name: 'c', href: 'd.ics', source_etag: null, source_sha256: null, status: 'removed', rows: [], degradations: [], delete_row_ids: [], error: null, unchanged: false },
      ],
    } as never);
    assert.equal(summary.objects, 3);
    assert.equal(summary.derived_rows, 2);
    assert.equal(summary.reverse_failed, 1);
    assert.deepEqual(summary.by_class, { REPR_LOSS_VALARM: 1, SEMANTIC_EXPANDED: 1, REVERSE_FAILED: 1 });
    assert.deepEqual(summary.calendars, [{ calendar_id: CAL, collection_name: 'c', objects: 3, degraded: 2, failed: 1, derived_rows: 2 }]);
  });
});

describe('ri-baseline: riconciliazione per categoria (contratto §5.3)', () => {
  test('A/B/E righe volute all\'href reale; D senza sorgente con la risorsa → untrack; F risorsa sparita → retire; G fuori ambito invariata', () => {
    const a = { ...derivedObject('a.ics', 's1:' + 'a'.repeat(64)), legacy_snapshot: { kind: 'event' } as never, legacy_key: 'event:a' as LegacyKey };
    const b = derivedObject('serie.ics', 's1:' + 'b'.repeat(64));
    const e = { ...a, href: 'IPHONE-1.ics', legacy_key: 'event:e' as LegacyKey };
    const missing = { ...a, href: 'mai-migrato.ics', legacy_key: 'event:m' as LegacyKey };
    const t = snapshotTarget([target('a.ics', '"1"'), target('serie.ics', '"2"'), target('IPHONE-1.ics', '"3"'), target('fallito.ics', '"4"')]);
    const ledger = [
      ledgerRow({ href: 'a.ics', legacy_key: 'event:a' as LegacyKey, written_etag: '"0"', written_fingerprint: 'x', written_at: new Date() }),
      ledgerRow({ href: 'fallito.ics', legacy_key: 'event:f' as LegacyKey, written_etag: '"4"', written_fingerprint: 'y', written_at: new Date() }),
      ledgerRow({ href: 'sparito.ics', legacy_key: 'event:s' as LegacyKey, written_etag: '"5"', written_fingerprint: 'z', written_at: new Date() }),
      ledgerRow({ href: 'altro.ics', legacy_key: 'event:o' as LegacyKey, calendar_id: '33333333-3333-4333-8333-333333333333' }),
      ledgerRow({ href: 'archivio.ics', legacy_key: 'archive:x' as LegacyKey, kind: 'archive' }),
    ];
    const d = decideRebaseline({ objects: [a, b, e, missing], ledger, target: t, calendarIds: new Set([CAL]) });
    assert.deepEqual(d.desired.map((x) => x.s.href).sort(), ['IPHONE-1.ics', 'a.ics', 'serie.ics']);
    assert.deepEqual(d.untrack.map((l) => l.href), ['fallito.ics']);
    assert.deepEqual(d.retire.map((l) => l.href), ['sparito.ics']);
    assert.deepEqual(d.missing.map((s) => s.href), ['mai-migrato.ics']);
  });
});

describe('piano: sorgenti derived (contratto §5.6)', () => {
  const hash = 's1:' + 'c'.repeat(64);
  test('stesso hash e stesso etag → noop; etag cambiato con lo stesso contenuto → adopt', () => {
    const s = derivedObject('serie.ics', hash);
    const l = ledgerRow({ href: 'serie.ics', legacy_key: s.legacy_key, derived: true, adopted: true, legacy_hash: hash, written_etag: '"e1"', written_fingerprint: 'fp-serie.ics', written_at: new Date() });
    assert.deepEqual(plan([s], [l], snapshotTarget([target('serie.ics', '"e1"')])).map((i) => [i.action, i.code]), [['noop', null]]);
    assert.deepEqual(plan([s], [l], snapshotTarget([target('serie.ics', '"e2"')])).map((i) => [i.action, i.code]), [['adopt', null]]);
  });

  test('righe derivate modificate in PG, senza ledger o risorsa sparita → DERIVED_EDITED, mai una scrittura', () => {
    const s = derivedObject('serie.ics', hash);
    const edited = ledgerRow({ href: 'serie.ics', legacy_key: s.legacy_key, derived: true, legacy_hash: 's1:' + 'd'.repeat(64), written_etag: '"e1"', written_fingerprint: 'fp', written_at: new Date() });
    for (const [ledger, objects] of [[[edited], [target('serie.ics', '"e1"')]], [[], [target('serie.ics', '"e1"')]], [[edited], []]] as const) {
      const items = plan([s], [...ledger], snapshotTarget([...objects]));
      assert.equal(items.length, 1);
      assert.deepEqual([items[0].action, items[0].code], ['conflict', 'DERIVED_EDITED']);
    }
  });

  test('forza DERIVED_EDITED: "mantieni la risorsa di Radicale" (adopt senza scrittura); senza risorsa resta conflitto', () => {
    const s = derivedObject('serie.ics', hash);
    const forced = plan([s], [], snapshotTarget([target('serie.ics', '"e1"')]), ['DERIVED_EDITED']);
    assert.deepEqual([forced[0].action, forced[0].code], ['adopt', 'DERIVED_EDITED']);
    const gone = plan([s], [], snapshotTarget([]), ['DERIVED_EDITED']);
    assert.deepEqual([gone[0].action, gone[0].code], ['conflict', 'DERIVED_EDITED']);
  });
});

describe('export v2: zip e .ics per collezione', () => {
  test('CRC-32 di riferimento e zip leggibile (deflate e stored)', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    const big = Buffer.from('BEGIN:VCALENDAR\r\n'.repeat(200));
    const tiny = Buffer.from('x');
    const zip = buildZip([{ name: 'manifest.json', data: tiny }, { name: 'collections/c.ics', data: big }, { name: 'collections/città.ics', data: big }]);
    const entries = readZip(zip);
    assert.deepEqual([...entries.keys()], ['manifest.json', 'collections/c.ics', 'collections/città.ics']);
    assert.ok(entries.get('collections/c.ics')!.equals(big));
    assert.ok(entries.get('manifest.json')!.equals(tiny));
    assert.ok(zip.length < big.length, 'le entry ripetitive sono compresse');
  });

  test('VCALENDAR di collezione: VTIMEZONE una volta per TZID, componenti piegati intatti, nome con escape', () => {
    const tz = ['BEGIN:VTIMEZONE', 'TZID:Europe/Rome', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE'];
    const obj = (uid: string, extra: string[] = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...tz, 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTART;TZID=Europe/Rome:20270101T090000', 'SUMMARY:Riunione molto lunga che viene piegata dal client perché supera i set', ' tantacinque ottetti', ...extra, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const ics = collectionIcs('Creattivamente, SRL; c', [obj('a'), obj('b')]);
    assert.equal((ics.match(/BEGIN:VTIMEZONE/g) ?? []).length, 1);
    assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2);
    assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 2);
    assert.ok(ics.includes('X-WR-CALNAME:Creattivamente\\, SRL\\; c'));
    assert.ok(ics.includes('\r\n tantacinque ottetti\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.deepEqual(topLevelComponents(ics).map((c) => c.name), ['VTIMEZONE', 'VEVENT', 'VEVENT']);
  });

  test('nomi delle tabelle del backup con calendar_events vista (dopo la 167)', () => {
    assert.equal(exportKeyOf('public.calendar_events_legacy', true), 'public.calendar_events');
    assert.equal(exportKeyOf('public.calendar_events_legacy', false), 'public.calendar_events_legacy');
    assert.equal(importKeyOf('public.calendar_events', true, ['public.calendar_events']), 'public.calendar_events_legacy');
    assert.equal(importKeyOf('public.calendar_events', false, ['public.calendar_events']), 'public.calendar_events');
    assert.equal(importKeyOf('public.calendar_events', true, ['public.calendar_events', 'public.calendar_events_legacy']), 'public.calendar_events');
  });
});

// ─── Database ───────────────────────────────

/** Stato del backend in mode radicale con un volume, come dopo un cutover (diretto: nessun Radicale in questi test). */
async function radicaleState(opts: { cutoverDaysAgo: number; windowDays?: number }): Promise<void> {
  const now = Date.now();
  await sql`
    UPDATE calendar_backend_state SET
      mode = 'radicale', write_freeze = false, volume_id = ${randomUUID()}::uuid, epoch = 3,
      cutover_at = ${new Date(now - opts.cutoverDaysAgo * DAY_MS)}, cutover_by = 'admin:test',
      rollback_until = ${new Date(now + (opts.windowDays ?? 30 - opts.cutoverDaysAgo) * DAY_MS)}
    WHERE id
  `;
}

async function postgresState(): Promise<void> {
  await sql`
    UPDATE calendar_backend_state SET mode = 'postgres', write_freeze = false, volume_id = NULL, epoch = 0,
      rollback_until = NULL, cutover_at = NULL, cutover_by = NULL, finalized_at = NULL
    WHERE id
  `;
  await sql`DELETE FROM cal_migration_transitions`;
}

describe('serializer: righe derivate raggruppate in una sorgente derived', () => {
  after(postgresState);

  test('le righe caldes_derived di una risorsa diventano un solo oggetto event:<object_id>, mai eventi singoli', async () => {
    const cal = await fx.calendar({ key: 'derivate', timezone: 'Europe/Rome' });
    const single = await fx.event({ calendar: cal, summary: 'Normale', start_time: '2027-02-01T09:00:00Z', end_time: '2027-02-01T10:00:00Z' });
    const objectId = randomUUID();
    const rows = ['2027-02-05T09:00:00Z', '2027-02-12T09:00:00Z', '2027-02-19T09:00:00Z'];
    for (const [i, start] of rows.entries()) {
      await sql`
        INSERT INTO calendar_events (id, calendar_id, uid, summary, start_time, end_time, all_day, source, status, caldes_object_id, caldes_derived)
        VALUES (${randomUUID()}::uuid, ${cal.id}::uuid, ${`serie-${objectId}#k${i}`}, ${fx.name('Corso')}, ${start}::timestamptz,
                ${new Date(Date.parse(start) + 3_600_000).toISOString()}::timestamptz, false, 'manual', 'confirmed', ${objectId}::uuid, true)
      `;
    }
    const source = await loadLegacySource(sql, { scope: { calendar_ids: [cal.id] } });
    assert.equal(source.events.filter((e) => e.calendar_id === cal.id).length, 1, 'solo la riga normale fra gli eventi');
    assert.equal(source.derived?.length, 1);
    assert.equal(source.derived?.[0].rows.length, 3);
    const out = serializeLegacy(source, { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] }, { now: new Date() });
    const mine = out.objects.filter((o) => o.calendar_id === cal.id);
    assert.deepEqual(mine.map((o) => o.legacy_key).sort(), [`event:${objectId}`, `event:${single.id}`].sort());
    const derived = mine.find((o) => o.legacy_key === `event:${objectId}`)!;
    assert.equal(isDerivedObject(derived), true);
    assert.equal(derived.ics, '');
    assert.match(derived.legacy_hash, /^s\d+:[0-9a-f]{64}$/);
    // Hash stabile e sensibile al contenuto delle righe (base di noop e DERIVED_EDITED).
    const again = serializeLegacy(await loadLegacySource(sql, { scope: { calendar_ids: [cal.id] } }), { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] }, { now: new Date() });
    assert.equal(again.objects.find((o) => o.legacy_key === `event:${objectId}`)?.legacy_hash, derived.legacy_hash);
    await sql`UPDATE calendar_events SET summary = 'Cambiato in PG' WHERE caldes_object_id = ${objectId}::uuid AND start_time = ${rows[0]}::timestamptz`;
    const changed = serializeLegacy(await loadLegacySource(sql, { legacyKeys: [`event:${objectId}` as LegacyKey] }), { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] }, { now: new Date() });
    const changedObj = changed.objects.find((o) => o.legacy_key === `event:${objectId}`);
    assert.ok(changedObj, 'la chiave della risorsa carica le righe derivate');
    assert.notEqual(changedObj.legacy_hash, derived.legacy_hash);
  });
});

describe('rollback: blocchi del preflight', () => {
  after(postgresState);
  const deps = {
    checkIdentity: async () => ({ status: 'ok' }) as never,
    controlPlaneStatus: () => ({ running: true, lastTick: { ok: true } }) as never,
    probeAvailable: () => true,
  };

  test('mode postgres, nessuna anteprima, anteprima vecchia o con un altro hash, finestra chiusa', async () => {
    await postgresState();
    const none = await rollbackBlockers(sql, { preview_run_id: null, expect_preview_hash: null, emergency: false }, { deps });
    assert.deepEqual(none.map((b) => b.reason).sort(), ['MODE_NOT_RADICALE', 'PREVIEW_REQUIRED']);

    await radicaleState({ cutoverDaysAgo: 2 });
    const hash = 'e'.repeat(64);
    const [run] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, started_at, finished_at, attempts)
      VALUES ('rollback_preview', 'succeeded', 'admin', 'admin:test', '{}'::jsonb, ${sql.json({ preview_hash: hash } as never)}, now() - interval '2 hours', now() - interval '2 hours', 1)
      RETURNING id::text AS id
    `;
    const stale = await rollbackBlockers(sql, { preview_run_id: run.id, expect_preview_hash: hash, emergency: false }, { deps });
    assert.deepEqual(stale.map((b) => b.reason), ['PREVIEW_STALE']);
    // Con l'emergenza l'età dell'anteprima non blocca.
    assert.deepEqual(await rollbackBlockers(sql, { preview_run_id: run.id, expect_preview_hash: hash, emergency: true }, { deps }), []);
    await sql`UPDATE cal_migration_runs SET finished_at = now() WHERE id = ${run.id}::uuid`;
    assert.deepEqual(await rollbackBlockers(sql, { preview_run_id: run.id, expect_preview_hash: hash, emergency: false }, { deps }), []);
    const other = await rollbackBlockers(sql, { preview_run_id: run.id, expect_preview_hash: 'f'.repeat(64), emergency: false }, { deps });
    assert.deepEqual(other.map((b) => b.reason), ['PREVIEW_STALE']);
    await sql`UPDATE calendar_backend_state SET rollback_until = now() - interval '1 minute' WHERE id`;
    const expired = await rollbackBlockers(sql, { preview_run_id: run.id, expect_preview_hash: hash, emergency: true }, { deps });
    assert.deepEqual(expired.map((b) => b.reason), ['ROLLBACK_WINDOW_EXPIRED']);
    const noCp = await rollbackBlockers(sql, { preview_run_id: run.id, expect_preview_hash: hash, emergency: true }, {
      deps: { ...deps, controlPlaneStatus: () => null, probeAvailable: () => false, checkIdentity: async () => ({ status: 'mismatch', detail: 'epoch' }) as never },
    });
    assert.deepEqual(noCp.map((b) => b.reason).sort(), ['CONTROL_PLANE_UNAVAILABLE', 'IDENTITY_NOT_OK', 'PROBE_UNAVAILABLE', 'ROLLBACK_WINDOW_EXPIRED']);
  });
});

describe('finalize: blocchi e run', () => {
  after(async () => {
    await sql`DELETE FROM cal_migration_reverse_state`;
    await sql`DELETE FROM cal_jobs WHERE kind = 'reverse_projection' OR key LIKE 'test-finalize-%'`;
    await postgresState();
  });
  const greenHealth = { health: async () => ({ status: 'ok' as const, reasons: [] }) };

  test('mode, 14 giorni, salute, job morti e REVERSE_FAILED bloccano la chiusura della finestra', async () => {
    await postgresState();
    // Calendari creati in mode postgres (in mode radicale passerebbero da Radicale).
    const cal = await fx.calendar({ key: 'finalize' });
    assert.deepEqual(await finalizeBlockers(sql, new Date(), { deps: greenHealth }), ['MODE_NOT_RADICALE']);
    await radicaleState({ cutoverDaysAgo: 3 });
    assert.deepEqual(await finalizeBlockers(sql, new Date(), { deps: greenHealth }), ['FINALIZE_TOO_EARLY']);
    await radicaleState({ cutoverDaysAgo: 20 });
    assert.deepEqual(await finalizeBlockers(sql, new Date(), { deps: greenHealth }), []);
    await sql`
      INSERT INTO cal_migration_reverse_state (object_id, calendar_id, href, status, rows, degradations, error_code, error, attempts)
      VALUES (${randomUUID()}::uuid, ${cal.id}::uuid, 'rotto.ics', 'failed', '[]'::jsonb, '[]'::jsonb, 'REVERSE_FAILED', 'vincolo', 1)
    `;
    await sql`
      INSERT INTO cal_jobs (kind, key, status, payload, attempts, max_attempts, finished_at)
      VALUES ('index_rebuild', ${`test-finalize-${randomUUID()}`}, 'dead', '{}'::jsonb, 5, 5, now())
    `.catch(async () => {
      // Colonne minime diverse fra versioni dello schema: il job morto si inserisce con i default.
      await sql`INSERT INTO cal_jobs (kind, key, status) VALUES ('index_rebuild', ${`test-finalize-${randomUUID()}`}, 'dead')`;
    });
    const detailed = await finalizeBlockersDetailed(sql, new Date(), { deps: { health: async () => ({ status: 'degraded', reasons: ['jobs_dead'] }) } });
    assert.deepEqual(detailed.map((b) => b.reason).sort(), ['DEAD_JOBS', 'HEALTH_NOT_GREEN', 'REVERSE_FAILED_OPEN']);
    for (const b of detailed) assert.doesNotMatch(b.message, /@/, 'nessun dato personale nei messaggi');
    await sql`DELETE FROM cal_migration_reverse_state`;
    await sql`DELETE FROM cal_jobs WHERE key LIKE 'test-finalize-%'`;
  });

  test('run finalize: mode finalized, proiezione inversa ferma, legacy_finalize saltato fino alla F7', async () => {
    await postgresState();
    const cal = await fx.calendar({ key: 'dopo-finalize' });
    await radicaleState({ cutoverDaysAgo: 20 });
    await sql`
      INSERT INTO cal_jobs (kind, key, status, payload)
      VALUES ('reverse_projection', ${randomUUID()}, 'pending', '{}'::jsonb)
    `;
    const run = await persistedRun<FinalizeParams>('finalize', { action: 'start' });
    let summary: FinalizeSummary;
    try {
      summary = await runFinalize(run.ctx, greenHealth);
      await run.finish({ summary });
    } catch (err) {
      await run.finish({ error: err });
      throw err;
    }
    assert.equal(summary.legacy_finalized, false);
    assert.equal(summary.legacy_note, LEGACY_FINALIZE_PENDING_NOTE);
    assert.equal(summary.reverse_jobs_dropped, 1);
    assert.deepEqual(summary.steps.map((s) => [s.step, s.status]), [['preflight', 'done'], ['stop_reverse', 'done'], ['state', 'done'], ['legacy_finalize', 'skipped']]);
    const [state] = await sql`SELECT mode, rollback_until, finalized_at, epoch FROM calendar_backend_state WHERE id`;
    assert.equal(state.mode, 'finalized');
    assert.equal(state.rollback_until, null);
    assert.ok(state.finalized_at);
    assert.equal(state.epoch, 3, 'nessun cambio d\'epoch');
    const [t] = await sql`SELECT status FROM cal_migration_transitions WHERE kind = 'finalize'`;
    assert.equal(t.status, 'completed');
    // Dopo il finalize la guardia 166 rifiuta le scritture dirette (precisazione 1).
    await assert.rejects(
      sql`INSERT INTO calendar_events (calendar_id, uid, summary, start_time, end_time) VALUES (${cal.id}, ${`g-${randomUUID()}`}, 'x', now(), now() + interval '1 hour')`,
      (err: unknown) => (err as { code?: string }).code === 'CD166',
    );
    // Un secondo finalize non parte (mode finalized).
    const again = await persistedRun<FinalizeParams>('finalize', { action: 'start' });
    await assert.rejects(runFinalize(again.ctx, greenHealth), (err: unknown) => err instanceof MigrationError);
    await again.finish({ error: new MigrationError('PRECONDITION_FAILED', 'atteso') });
  });
});

describe('backup: calendar_events vista (simulata) ed export v2', () => {
  const CONFIRM = 'RIPRISTINA-DATABASE';
  const preRestore = new Set<string>();
  after(() => {
    for (const name of preRestore) rmSync(join(TEST_ENV.UPLOAD_DIR, 'backups', name), { force: true });
  });

  async function importBackup(file: unknown): Promise<TestResponse> {
    const fd = new FormData();
    fd.append('file', new Blob([JSON.stringify(file)], { type: 'application/json' }), 'backup.json');
    fd.append('confirm', CONFIRM);
    const res = await api.post('/api/backup/import', { auth: 'admin', body: fd });
    if (res.json?.preRestoreBackup) preRestore.add(res.json.preRestoreBackup);
    return res;
  }

  test('export v2 in mode postgres: 409 con l\'indicazione di usare v1; formato sconosciuto: 400', async () => {
    await postgresState();
    const res = await api.get('/api/backup/export', { auth: 'admin', query: { format: 'calendar-v2' } });
    assert.equal(res.status, 409);
    assert.equal(res.json?.code, 'EXPORT_V2_NOT_AVAILABLE');
    assert.match(String(res.json?.error), /v1/);
    const bad = await api.get('/api/backup/export', { auth: 'admin', query: { format: 'xml' } });
    assert.equal(bad.status, 400);
  });

  test('con calendar_events vista l\'export usa il nome storico e l\'import (anche di un backup senza colonne caldes_*) va in calendar_events_legacy', async () => {
    await postgresState();
    const cal = await fx.calendar({ key: 'vista' });
    const ev = await fx.event({ calendar: cal, summary: 'Prima del finalize', start_time: '2027-06-01T09:00:00Z', end_time: '2027-06-01T10:00:00Z' });
    assert.equal(await calendarEventsIsView(), false);
    await sql.unsafe('ALTER TABLE calendar_events RENAME TO calendar_events_legacy');
    try {
      await sql.unsafe('CREATE VIEW calendar_events AS SELECT * FROM calendar_events_legacy');
      assert.equal(await calendarEventsIsView(), true);
      const exported = await api.get('/api/backup/export', { auth: 'admin' });
      assert.equal(exported.status, 200, exported.text.slice(0, 300));
      const tables = exported.json.tables as Record<string, Array<Record<string, unknown>>>;
      assert.equal('public.calendar_events_legacy' in tables, false, 'nessuna tabella _legacy nel formato v1');
      const rows = tables['public.calendar_events'];
      assert.ok(rows.some((r) => r.id === ev.id), 'righe della tabella legacy col nome storico');

      // Backup "storico" (prima della 166): senza le colonne caldes_*, che prendono i default.
      const historic = { ...exported.json, tables: { ...tables, 'public.calendar_events': rows.map(({ caldes_object_id: _o, caldes_derived: _d, ...r }) => r) } };
      await sql`SELECT set_config('caldes.reverse_sync', 'on', false)`;
      await sql`DELETE FROM calendar_events_legacy WHERE id = ${ev.id}::uuid`;
      await sql`SELECT set_config('caldes.reverse_sync', 'off', false)`;
      const res = await importBackup(historic);
      assert.equal(res.status, 200, res.text.slice(0, 500));
      const [back] = await sql`SELECT id, caldes_derived, caldes_object_id FROM calendar_events_legacy WHERE id = ${ev.id}::uuid`;
      assert.ok(back, 'riga importata nella tabella legacy');
      assert.equal(back.caldes_derived, false);
      assert.equal(back.caldes_object_id, null);
      assert.equal(res.json.skipped.calendar.length, 0, 'dominio calendario ripristinato in mode postgres');
    } finally {
      await sql.unsafe('DROP VIEW IF EXISTS calendar_events');
      await sql.unsafe('ALTER TABLE IF EXISTS calendar_events_legacy RENAME TO calendar_events');
      await sql`UPDATE calendar_backend_state SET rebuild_required = false, restore_guard_until = NULL WHERE id`;
    }
    assert.equal(await calendarEventsIsView(), false);
    assert.equal(sha(''), sha(''));
  });
});
