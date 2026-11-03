/**
 * Correzioni della revisione della F3 (AREA A: serializer, piano, apply,
 * verifica, report) contro Radicale 3.7.8 reale, sui dati di forma produttiva
 * (stessa impostazione di migration-apply.test.ts, istanza e volume propri).
 *
 *  - F3R-1: serie con il DTSTART fuori dalla regola (mercoledì con
 *    BYDAY=MO,TU,TH,FR, con e senza COUNT, anche tutto il giorno):
 *    anomalia DTSTART_NOT_IN_RULE nell'anteprima, oggetto dalla prima
 *    occorrenza legacy, V3 e V4 senza rossi, V5 giallo DTSTART_REALIGNED;
 *  - V4-ONGOING-FALSE-RED: occorrenza ricorrente in corso all'avvio della
 *    verifica → V4 verde (prima: BUSY_EXTRA rosso);
 *  - REASONS-PER-OBJECT-TOO-BROAD: proiezione con l'orario sbagliato su
 *    Radicale → V3 rosso (prima: giallo BOOKING_REGENERATED);
 *  - F3R-3: evento spostato di calendario in PG dopo un primo apply, e
 *    spostamento della decisione 8 scelto dopo un primo apply: l'id legacy
 *    (e legacy_uid) passa alla posizione nuova, resolveEventRef la trova e la
 *    sync delle due collezioni conserva l'id;
 *  - F3R-6: tentativo 1 con le righe perse (processo ucciso prima del
 *    salvataggio) → il tentativo 2 non è "senza scritture"; salvataggio delle
 *    righe fallito → run fallito;
 *  - F3R-5: alla ripresa dello stesso run la "forza" per codice vale solo per
 *    i conflitti dell'anteprima: un TARGET_NEWER nato fra i tentativi resta
 *    un conflitto;
 *  - F3R-2 / F3R-SHD-01: proiezioni che superano i 24 mesi fra due giri:
 *    lo shadow e la riga adottata le riscrivono minimizzate (prima:
 *    adozione senza scrivere, nome e telefono restavano su Radicale);
 *  - V4-CAP-SWALLOWS-RED: oltre 100 differenze V4 gialle con più contributori
 *    e una rossa → calendario rosso e non accettabile.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createEvent, deleteEvent } from '../../src/lib/calendar/events';
import { type ExecuteContext, executePlanItem, migrationThrottle, runApply } from '../../src/lib/calendar/migration/apply';
import { runInit } from '../../src/lib/calendar/migration/init';
import { buildPlan, runPlan } from '../../src/lib/calendar/migration/plan';
import { runVerify, type VerifyRunSummary } from '../../src/lib/calendar/migration/verify';
import {
  type ApplyParams,
  type ApplySummary,
  DEFAULT_MIGRATION_OPTIONS,
  type InitParams,
  type PlanParams,
  type PlanSummary,
  type VerifyParams,
} from '../../src/lib/calendar/migration/types';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { resolveEventRef } from '../../src/lib/calendar/radicale/ids';
import { configureRadicaleRuntime, radicaleRuntime, syncCollection } from '../../src/lib/calendar/radicale/sync';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { RADICALE_PLUGINS_DIR, radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';
import { persistedRun, runItems, runToEnd } from '../calendar/_migration-apply-shared';
import { buildProductionShape, type ProductionShape, rome } from '../calendar/_migration-init-shared';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});
const fx = useFixtures('mig-f3r-rad');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f3r';
const DAY = 86_400_000;

const RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const OPTIONS = { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] };

function applyParams(extra: Partial<ApplyParams> = {}): ApplyParams {
  return { scope: {}, options: OPTIONS, expected_plan_hash: null, force_item_ids: [], force_codes: [], follow_up_verify: null, ...extra };
}

async function plan(scope: PlanParams['scope'] = {}): Promise<{ summary: PlanSummary; runId: string }> {
  return runToEnd<PlanParams, PlanSummary>('plan', { scope, options: OPTIONS }, (ctx) => runPlan(ctx));
}

async function apply(extra: Partial<ApplyParams> = {}): Promise<{ summary: ApplySummary; runId: string }> {
  return runToEnd<ApplyParams, ApplySummary>('apply', applyParams(extra), (ctx) => runApply(ctx));
}

async function verify(extra: Partial<VerifyParams> = {}): Promise<{ summary: VerifyRunSummary; runId: string }> {
  const r = await runToEnd<VerifyParams, VerifyRunSummary>('verify', { scope: {}, levels: ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 180, ...extra }, async (ctx) => (await runVerify(ctx)) as VerifyRunSummary);
  return { summary: r.summary, runId: r.runId };
}

async function liveHref(key: string): Promise<{ href: string; calendar_id: string }> {
  const rows = await sql<Array<{ href: string; calendar_id: string }>>`
    SELECT href, calendar_id::text AS calendar_id FROM cal_migration_ledger WHERE legacy_key = ${key} AND deleted_at IS NULL
  `;
  assert.equal(rows.length, 1, `una riga viva per ${key}`);
  return rows[0];
}

/** Data (YYYY-MM-DD) del primo giorno della settimana `weekday` (0 = domenica) almeno `minDays` giorni dopo oggi. */
function nextWeekday(weekday: number, minDays: number): string {
  const d = new Date(Date.now() + minDays * DAY);
  d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

const radicaleRuntimeClient = (): RadicaleClient => radicaleRuntime().client as RadicaleClient;

const compact = (rows: Awaited<ReturnType<typeof runItems>>): unknown => rows.map((i) => ({ level: i.level, code: i.code, key: i.legacy_key, expected: i.expected, reason: i.detail.reason, legacy: i.detail.legacy, target: i.detail.target }));

describe('correzioni della revisione F3 (area A) contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let shape: ProductionShape;

  const pathOf = (collection: string, href: string): string => objectPath(P, collection, href);

  before(async () => {
    rad = await startRadicale({
      label: 'f3r-fix',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: RIGHTS_RULES },
      pythonPath: [RADICALE_PLUGINS_DIR],
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    const runtimeClient = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    configureRadicaleRuntime({ client: runtimeClient, dataDir: rad.storageDir, principal: P, watch: 'off', identitySource: 'remote' });
    await resetCalendarBaseline();
    shape = await buildProductionShape(fx, { holidayYears: [2026] });
    await sql`UPDATE calendars SET ics_feed_enabled = true WHERE role <> 'subscription'`;
    await runToEnd<InitParams, object>('init', { action: 'initialize' }, (ctx) => runInit(ctx));
    const first = await apply();
    assert.equal(first.summary.failed, 0);
    assert.deepEqual(first.summary.conflicts, {});
  });

  after(async () => {
    configureRadicaleRuntime(null);
    svc?.close();
    await rad?.stop();
  });

  // ─── F3R-1 ───────────────────────────────

  test('F3R-1: serie che parte di mercoledì fuori dalla regola, con e senza COUNT e tutto il giorno: anomalia, V3/V4 senza rossi, V5 giallo DTSTART_REALIGNED', async () => {
    const wed = nextWeekday(3, 7);
    const wedNext = nextWeekday(3, 14);
    const plain = await fx.event({ calendar: shape.lavoro, summary: 'Serie dal mercoledì', start_time: rome(wed, '11:00'), end_time: rome(wed, '12:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', source: 'admin' });
    const counted = await fx.event({ calendar: shape.lavoro, summary: 'Serie dal mercoledì con COUNT', start_time: rome(wedNext, '16:00'), end_time: rome(wedNext, '17:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO,FR;COUNT=4', source: 'admin' });
    const allDay = await fx.event({ calendar: shape.lavoro, summary: 'Tutto il giorno dal mercoledì', start_time: rome(wed, '00:00'), end_time: rome(nextWeekday(4, 7), '00:00'), all_day: true, rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=3', source: 'admin' });
    const keys = [plain, counted, allDay].map((e) => `event:${e.id}`);

    const p = await plan({ calendar_ids: [shape.lavoro.id] });
    const anomalies = (await runItems(p.runId)).filter((i) => i.item_type === 'anomaly' && i.code === 'DTSTART_NOT_IN_RULE');
    assert.deepEqual(anomalies.map((a) => a.legacy_key).sort(), [...keys].sort(), 'anomalia visibile nell\'anteprima per le tre serie');
    const a = await apply();
    assert.equal(a.summary.writes.create, 3, JSON.stringify(a.summary));
    assert.equal(a.summary.failed, 0);

    // Oggetto scritto: DTSTART sulla prima occorrenza legacy (giovedì), COUNT invariato.
    const plainRow = await liveHref(keys[0]);
    const body = (await svc.get(pathOf('lavoro', plainRow.href))).body;
    assert.match(body, new RegExp(`DTSTART;TZID=Europe/Rome:${nextWeekday(4, 7).replace(/-/g, '')}T110000`), body);
    const countedBody = (await svc.get(pathOf('lavoro', (await liveHref(keys[1])).href))).body;
    assert.match(countedBody, /RRULE:FREQ=WEEKLY;BYDAY=MO,FR;COUNT=4/);
    const [snap] = await sql<Array<{ opt: boolean | null }>>`SELECT (legacy_snapshot->'options'->>'realign_dtstart')::boolean AS opt FROM cal_migration_ledger WHERE legacy_key = ${keys[1]} AND deleted_at IS NULL`;
    assert.equal(snap.opt, true, 'opzione registrata nello snapshot');

    const { summary, runId } = await verify({ levels: ['V3', 'V4', 'V5'], v4_days: 60, scope: { calendar_ids: [shape.lavoro.id] } });
    const mine = (await runItems(runId)).filter((i) => i.item_type === 'diff' && keys.includes(i.legacy_key ?? ''));
    assert.deepEqual(mine.filter((i) => i.level === 'V3' || i.level === 'V4'), [], `V3/V4 identici al legacy: ${JSON.stringify(compact(mine))}`);
    assert.ok(mine.length > 0, 'il feed legacy (RFC) ha l\'istanza del vecchio DTSTART');
    assert.ok(mine.every((i) => i.level === 'V5' && i.expected === true && i.detail.reason === 'DTSTART_REALIGNED'), JSON.stringify(compact(mine)));
    assert.equal(summary.v4?.without_subscriptions, 'green');
    assert.notEqual(summary.calendars.find((c) => c.calendar_id === shape.lavoro.id)?.color, 'red', JSON.stringify(compact(await runItems(runId))));

    for (const e of [plain, counted, allDay]) await deleteEvent(e.id);
    assert.equal((await apply()).summary.writes.delete, 3);
  });

  // ─── V4-ONGOING-FALSE-RED ───────────────────────────────

  test('V4: un\'occorrenza ricorrente già iniziata all\'avvio della verifica non è un BUSY_EXTRA rosso', async () => {
    const start = new Date(Math.floor((Date.now() - 3_600_000) / 60_000) * 60_000);
    // COUNT=3: nessuna occorrenza nella notte del cambio d'ora (lì legacy e RFC divergono per altri motivi).
    const series = await fx.event({ calendar: shape.c, summary: 'In corso adesso', start_time: start.toISOString(), end_time: new Date(start.getTime() + 2 * 3_600_000).toISOString(), rrule: 'FREQ=DAILY;COUNT=3', source: 'admin' });
    assert.equal((await apply()).summary.writes.create, 1);
    const { summary, runId } = await verify({ levels: ['V4'], v4_days: 14 });
    const rows = (await runItems(runId)).filter((i) => i.item_type === 'diff' && i.detail.variant !== 'with_subscriptions');
    assert.deepEqual(compact(rows), [], 'nessuna differenza del busy con dati identici');
    assert.equal(summary.v4?.without_subscriptions, 'green');
    await deleteEvent(series.id);
    assert.equal((await apply()).summary.writes.delete, 1);
  });

  // ─── REASONS-PER-OBJECT-TOO-BROAD ───────────────────────────────

  test('motivi per differenza: una proiezione con l\'orario sbagliato su Radicale è un rosso V3 (mai un giallo "proiezione rigenerata")', async () => {
    const key = `booking:${shape.confirmedBookingUid}`;
    const row = await liveHref(key);
    const obj = await svc.get(pathOf('bookings', row.href));
    const shifted = obj.body.replace(/(DTSTART[^:\r\n]*:\d{8}T)(\d{2})/, (_all, pre: string, hh: string) => `${pre}${String(Number(hh) + 1).padStart(2, '0')}`);
    assert.notEqual(shifted, obj.body);
    const put = await svc.put(pathOf('bookings', row.href), shifted, { ifMatch: obj.etag as string });
    try {
      const { summary, runId } = await verify({ levels: ['V3'], scope: { calendar_ids: [shape.bookings.id] } });
      const diffs = (await runItems(runId)).filter((i) => i.item_type === 'diff' && i.legacy_key === key);
      assert.ok(diffs.length > 0, 'differenza di occorrenza');
      assert.ok(diffs.every((d) => d.expected === false && d.detail.reason === null), JSON.stringify(compact(diffs)));
      const bk = summary.calendars.find((c) => c.calendar_id === shape.bookings.id);
      assert.equal(bk?.color, 'red', JSON.stringify(bk));
      assert.equal(summary.acceptable, false);
    } finally {
      const cur = await svc.get(pathOf('bookings', row.href));
      await svc.put(pathOf('bookings', row.href), obj.body, { ifMatch: (cur.etag ?? put.etag) as string });
    }
  });

  test('motivi per istanza: una serie con un override (OVERRIDE_UID_MASTER) e l\'orario del master cambiato su Radicale è un rosso V5 (prima: giallo per tutto l\'oggetto)', async () => {
    const first = nextWeekday(2, 10);
    const second = new Date(Date.parse(`${first}T12:00:00Z`) + 7 * DAY).toISOString().slice(0, 10);
    const series = await fx.series({
      calendar: shape.f, summary: 'Serie con override', start_time: rome(first, '10:00'), end_time: rome(first, '11:00'), rrule: 'FREQ=WEEKLY;COUNT=4', source: 'admin',
      overrides: [{ originalStart: rome(second, '10:00'), start: rome(second, '12:00'), end: rome(second, '13:00') }],
    });
    const key = `event:${series.master.id}`;
    assert.equal((await apply()).summary.failed, 0);
    const row = await liveHref(key);
    const obj = await svc.get(pathOf('f', row.href));
    const shifted = obj.body.replace(/(DTSTART;TZID=Europe\/Rome:\d{8}T)10/, '$111').replace(/(DTEND;TZID=Europe\/Rome:\d{8}T)11/, '$112');
    assert.notEqual(shifted, obj.body);
    const put = await svc.put(pathOf('f', row.href), shifted, { ifMatch: obj.etag as string });
    try {
      const { runId } = await verify({ levels: ['V5'], scope: { calendar_ids: [shape.f.id] } });
      const diffs = (await runItems(runId)).filter((i) => i.item_type === 'diff' && i.legacy_key === key && i.code === 'FEED_INSTANCES_DIFF');
      assert.ok(diffs.length > 0, 'istanze del feed diverse');
      assert.ok(diffs.every((d) => d.expected === false), `le istanze spostate non sono spiegate dall'override: ${JSON.stringify(compact(diffs))}`);
    } finally {
      const cur = await svc.get(pathOf('f', row.href));
      await svc.put(pathOf('f', row.href), obj.body, { ifMatch: (cur.etag ?? put.etag) as string });
      await deleteEvent(series.master.id);
      assert.equal((await apply()).summary.failed, 0);
    }
  });

  // ─── F3R-3 ───────────────────────────────

  async function idRow(id: string): Promise<Array<{ calendar_id: string; href: string; legacy_uid: string | null; legacy_event_id: string | null; retired_at: Date | null }>> {
    return sql`
      SELECT calendar_id::text AS calendar_id, href, legacy_uid, legacy_event_id::text AS legacy_event_id, retired_at
      FROM cal_object_ids WHERE id = ${id}::uuid
    `;
  }

  test('F3R-3: evento spostato di calendario in PG dopo un primo apply → id legacy e legacy_uid sulla posizione nuova, anche dopo la sync', async () => {
    const ev = await fx.event({ calendar: shape.c, summary: 'Da spostare', start_time: rome('2026-12-14', '10:00'), end_time: rome('2026-12-14', '11:00'), source: 'admin' });
    assert.equal((await apply()).summary.writes.create, 1);
    const before = await idRow(ev.id);
    assert.equal(before.length, 1);
    assert.equal(before[0].calendar_id, shape.c.id);
    // Indice della posizione vecchia presente (watcher acceso in produzione): cal_objects la riferisce.
    await syncCollection(shape.c.id, { reason: 'manual' });
    const [{ n: indexedOld }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_objects WHERE id = ${ev.id}::uuid AND calendar_id = ${shape.c.id}::uuid`;
    assert.equal(indexedOld, 1);

    await sql`UPDATE calendar_events SET calendar_id = ${shape.lavoro.id}::uuid WHERE id = ${ev.id}::uuid`;
    const moved = await apply();
    assert.equal(moved.summary.writes.create, 1, JSON.stringify(moved.summary));
    assert.equal(moved.summary.writes.delete, 1);
    const target = await liveHref(`event:${ev.id}`);
    assert.equal(target.calendar_id, shape.lavoro.id);
    const after = await idRow(ev.id);
    assert.equal(after.length, 1);
    assert.deepEqual({ ...after[0], retired_at: after[0].retired_at === null }, { calendar_id: shape.lavoro.id, href: target.href, legacy_uid: ev.uid, legacy_event_id: ev.id, retired_at: true });
    const ref = await resolveEventRef(sql, ev.id);
    assert.equal(ref.kind, 'found');
    assert.equal(ref.kind === 'found' ? ref.calendarId : null, shape.lavoro.id);

    // La sync delle due collezioni (in qualunque ordine) conserva l'id legacy sulla posizione nuova.
    await syncCollection(shape.lavoro.id, { reason: 'manual' });
    await syncCollection(shape.c.id, { reason: 'manual' });
    const indexed = await sql<Array<{ calendar_id: string; href: string }>>`SELECT calendar_id::text AS calendar_id, href FROM cal_objects WHERE id = ${ev.id}::uuid`;
    assert.deepEqual(indexed.map((r) => ({ calendar_id: r.calendar_id, href: r.href })), [{ calendar_id: shape.lavoro.id, href: target.href }]);
    assert.deepEqual((await idRow(ev.id)).map((r) => [r.calendar_id, r.href, r.legacy_uid]), [[shape.lavoro.id, target.href, ev.uid]]);
    assert.equal((await apply()).summary.zero_writes, true);
  });

  test('F3R-3: spostamento della decisione 8 scelto dopo un primo apply, e ritorno: l\'id legacy segue l\'oggetto', async () => {
    const ev = await fx.event({ calendar: shape.bookings, summary: 'Nota in Prenotazioni', start_time: rome('2026-12-15', '12:00'), end_time: rome('2026-12-15', '13:00'), source: 'admin' });
    assert.equal((await apply()).summary.writes.create, 1);
    assert.equal((await idRow(ev.id))[0]?.calendar_id, shape.bookings.id);
    const moveOptions = { ...OPTIONS, bookings_move_event_ids: [ev.id], bookings_move_target_calendar_id: shape.lavoro.id };
    const moved = await apply({ options: moveOptions });
    assert.equal(moved.summary.writes.create, 1, JSON.stringify(moved.summary));
    const inLavoro = await liveHref(`event:${ev.id}`);
    assert.deepEqual((await idRow(ev.id)).map((r) => [r.calendar_id, r.href, r.legacy_uid, r.retired_at]), [[shape.lavoro.id, inLavoro.href, ev.uid, null]]);
    const back = await apply();
    assert.equal(back.summary.writes.create, 1);
    const inBookings = await liveHref(`event:${ev.id}`);
    assert.deepEqual((await idRow(ev.id)).map((r) => [r.calendar_id, r.href, r.legacy_uid]), [[shape.bookings.id, inBookings.href, ev.uid]]);
    assert.equal((await apply()).summary.zero_writes, true);
  });

  // ─── F3R-6 ───────────────────────────────

  test('F3R-6: righe del tentativo 1 perse con il processo → il tentativo 2 non dichiara "zero scritture"', async () => {
    for (let i = 0; i < 3; i++) {
      await fx.event({ calendar: shape.c, summary: `Perse ${i}`, start_time: rome('2026-12-16', `${String(9 + i).padStart(2, '0')}:00`), end_time: rome('2026-12-16', `${String(9 + i).padStart(2, '0')}:30`), source: 'admin' });
    }
    const first = await persistedRun('apply', applyParams());
    const s1 = await runApply(first.ctx) as ApplySummary;
    assert.equal(s1.writes.create, 3);
    // Processo ucciso prima del salvataggio delle righe: il run resta 'running' senza righe 'object'.
    await sql`DELETE FROM cal_migration_items WHERE run_id = ${first.ctx.runId}::uuid`;
    const resumed = await persistedRun('apply', applyParams(), { runId: first.ctx.runId, attempt: 2 });
    const s2 = await runApply(resumed.ctx) as ApplySummary & { previous_attempt_ledger_rows: number };
    await resumed.finish({ summary: s2 });
    assert.equal(s2.writes.create + s2.writes.update + s2.writes.delete, 0, 'niente da scrivere al tentativo 2');
    assert.equal(s2.zero_writes, false, 'il run ha scritto: non è una seconda esecuzione idempotente');
    assert.ok(s2.previous_attempt_ledger_rows >= 3, JSON.stringify(s2));
    assert.equal((await apply()).summary.zero_writes, true);
  });

  test('F3R-6: le righe di un item che ha scritto si salvano subito, e un salvataggio fallito fa fallire il run', async () => {
    await fx.event({ calendar: shape.c, summary: 'Riga salvata 1', start_time: rome('2026-12-17', '09:00'), end_time: rome('2026-12-17', '09:30'), source: 'admin' });
    await fx.event({ calendar: shape.c, summary: 'Riga salvata 2', start_time: rome('2026-12-17', '10:00'), end_time: rome('2026-12-17', '10:30'), source: 'admin' });
    // Ogni riga di un item che ha scritto chiude il suo lotto: un processo ucciso subito dopo perde al più
    // l'item in corso (prima le righe restavano in memoria fino a 50 e un kill le perdeva tutte).
    const batches: string[][] = [];
    const run = await persistedRun('apply', applyParams());
    const save = run.ctx.addItems.bind(run.ctx);
    run.ctx.addItems = async (rows) => {
      batches.push(rows.map((r) => r.outcome ?? ''));
      return save(rows);
    };
    const s1 = await runApply(run.ctx) as ApplySummary;
    await run.finish({ summary: s1 });
    assert.equal(s1.writes.create, 2);
    assert.equal(batches.flat().filter((o) => o === 'done').length, 2);
    for (const b of batches) {
      assert.ok(b.slice(0, -1).every((o) => !['done', 'forced', 'adopted', 'failed'].includes(o)), `riga di una scrittura salvata subito: ${JSON.stringify(batches.map((x) => x.length))}`);
    }

    await fx.event({ calendar: shape.c, summary: 'Riga non salvabile', start_time: rome('2026-12-17', '11:00'), end_time: rome('2026-12-17', '11:30'), source: 'admin' });
    const failing = await persistedRun('apply', applyParams());
    failing.ctx.addItems = async () => {
      throw new Error('salvataggio delle righe fallito (test)');
    };
    await assert.rejects(runApply(failing.ctx), /salvataggio delle righe fallito/);
    await failing.finish({ error: new Error('salvataggio fallito') });
    assert.equal((await apply()).summary.zero_writes, true, 'il ledger ha registrato la scrittura comunque');
  });

  // ─── F3R-5 ───────────────────────────────

  test('F3R-5: ripresa dello stesso run → la forza per codice vale solo per i conflitti dell\'anteprima', async () => {
    assert.equal((await apply()).summary.failed, 0);
    const x = await fx.event({ calendar: shape.c, summary: 'Conflitto X', start_time: rome('2026-12-18', '09:00'), end_time: rome('2026-12-18', '10:00'), source: 'admin' });
    const y = await fx.event({ calendar: shape.c, summary: 'Conflitto Y', start_time: rome('2026-12-18', '11:00'), end_time: rome('2026-12-18', '12:00'), source: 'admin' });
    assert.equal((await apply()).summary.writes.create, 2);
    const touch = async (key: string, note: string): Promise<void> => {
      const row = await liveHref(key);
      const cur = await svc.get(pathOf('c', row.href));
      await svc.put(pathOf('c', row.href), cur.body.replace('END:VEVENT', `X-NOTE:${note}\r\nEND:VEVENT`).replace(/SUMMARY:([^\r\n]*)/, 'SUMMARY:$1 (device)'), { ifMatch: cur.etag as string });
    };
    await touch(`event:${x.id}`, 'x');
    for (let i = 0; i < 3; i++) {
      await fx.event({ calendar: shape.c, summary: `Ripresa ${i}`, start_time: rome('2026-12-19', `${String(9 + i).padStart(2, '0')}:00`), end_time: rome('2026-12-19', `${String(9 + i).padStart(2, '0')}:30`), source: 'admin' });
    }
    const p = await plan();
    const preview = (await runItems(p.runId)).filter((i) => i.item_type === 'object' && i.action === 'conflict');
    assert.deepEqual(preview.map((i) => [i.legacy_key, i.code]), [[`event:${x.id}`, 'TARGET_NEWER']]);

    const params = applyParams({ expected_plan_hash: p.summary.plan_hash, force_codes: ['TARGET_NEWER'] });
    const first = await persistedRun('apply', params, { planRunId: p.runId, planHash: p.summary.plan_hash });
    // Crash dopo due scritture riuscite (righe salvate): il tentativo 2 riprende senza riconfrontare l'hash.
    let written = 0;
    const save = first.ctx.addItems.bind(first.ctx);
    first.ctx.addItems = async (rows) => {
      const ids = await save(rows);
      written += rows.filter((r) => r.outcome === 'done' || r.outcome === 'forced').length;
      if (written >= 2) throw new Error('crash fra i tentativi');
      return ids;
    };
    await assert.rejects(runApply(first.ctx), /crash fra i tentativi/);
    // Fra i due tentativi Y cambia su Radicale: un conflitto che l'anteprima non ha mai mostrato.
    await touch(`event:${y.id}`, 'y');
    const resumed = await persistedRun('apply', params, { runId: first.ctx.runId, attempt: 2, planRunId: p.runId, planHash: p.summary.plan_hash });
    const s2 = await runApply(resumed.ctx) as ApplySummary;
    await resumed.finish({ summary: s2 });
    const items = await runItems(first.ctx.runId);
    const yRow = items.filter((i) => i.legacy_key === `event:${y.id}`).at(-1);
    assert.equal(yRow?.outcome, 'conflict', JSON.stringify(yRow));
    assert.equal(yRow?.code, 'TARGET_NEWER');
    assert.equal(yRow?.forced, false);
    const xRow = items.filter((i) => i.legacy_key === `event:${x.id}`).at(-1);
    assert.ok(xRow?.outcome === 'forced' || xRow?.outcome === 'done', JSON.stringify(xRow));
    assert.match((await svc.get(pathOf('c', (await liveHref(`event:${y.id}`)).href))).body, /X-NOTE:y/, 'modifica di Y conservata');
    // Pulizia: Y torna al legacy con la forza esplicita.
    const fixed = await apply({ force_codes: ['TARGET_NEWER'] });
    assert.equal(fixed.summary.failed, 0);
  });

  // ─── F3R-2 / F3R-SHD-01 ───────────────────────────────

  test('F3R-2: proiezioni che superano i 24 mesi fra due giri → shadow e riga adottata riscrivono SUMMARY "Prenotazione" senza telefono (mai un\'adozione senza scrivere)', async () => {
    // Fine tale che i 24 mesi (mesi UTC, come isBookingProjectionExpired) scadano fra 6 secondi.
    const crossAt = Date.now() + 6_000;
    const endAt = new Date(crossAt);
    endAt.setUTCMonth(endAt.getUTCMonth() - 24);
    const start = new Date(endAt.getTime() - shape.eventType.duration_minutes * 60_000).toISOString();
    const phone = '+39 333 1112223';
    const viaShadow = await fx.booking({ eventType: shape.eventType, start, attendee: { name: fx.name('Mario Ombra'), email: fx.email('f3r-shadow'), phone } });
    // Seconda prenotazione subito dopo la prima (vincolo di non sovrapposizione): [fine, fine + 1 s), stessa soglia.
    const adopted = await fx.booking({ eventType: shape.eventType, start: endAt.toISOString(), attendee: { name: fx.name('Mario Adottato'), email: fx.email('f3r-adopted'), phone } });
    const bStart = endAt.toISOString();
    const bEnd = new Date(endAt.getTime() + 1_000).toISOString();
    await sql`UPDATE calendar_bookings SET start_time = ${bStart}::timestamptz, end_time = ${bEnd}::timestamptz WHERE uid = ${adopted.booking.uid}`;
    if (adopted.projection) await sql`UPDATE calendar_events SET start_time = ${bStart}::timestamptz, end_time = ${bEnd}::timestamptz WHERE id = ${adopted.projection.id}::uuid`;
    const keyShadow = `booking:${viaShadow.booking.uid}` as const;
    const keyAdopted = `booking:${adopted.booking.uid}`;
    const rt = radicaleRuntimeClient();
    const built = await buildPlan({ db: sql, client: rt, principal: P, mode: 'apply', scope: { calendar_ids: [shape.bookings.id] }, options: OPTIONS, now: new Date() });
    const wanted = built.items.find((i) => i.legacy_key === keyAdopted && i.source);
    assert.ok(wanted?.source);
    await svc.put(pathOf('bookings', 'adottata-24-mesi.ics'), wanted.source.ics, { ifNoneMatch: '*' });
    const first = await apply({ scope: { calendar_ids: [shape.bookings.id] } });
    assert.equal(first.summary.adopted, 1, JSON.stringify(first.summary));
    assert.equal(first.summary.writes.create, 1);
    assert.ok(Date.now() < crossAt, 'primo giro prima della soglia (aumentare il margine se la macchina è lenta)');
    const bodyOf = async (key: string): Promise<string> => (await svc.get(pathOf('bookings', (await liveHref(key)).href))).body;
    assert.match(await bodyOf(keyShadow), /Tel: \+39 333 1112223/);
    await new Promise((r) => setTimeout(r, Math.max(0, crossAt - Date.now()) + 1_500));

    // Shadow (job della retention o del giro): update con la patch, mai 'adopt'.
    const ctx: ExecuteContext = { db: sql, client: rt, principal: P, runId: null, actor: 'system:shadow', mode: 'shadow', forced: false, throttle: migrationThrottle(), now: () => new Date() };
    const shadowPlan = await buildPlan({ db: sql, client: rt, principal: P, mode: 'shadow', scope: {}, options: OPTIONS, legacyKeys: [keyShadow], now: new Date() });
    const it = shadowPlan.items.find((i) => i.legacy_key === keyShadow);
    assert.equal(it?.action, 'update', JSON.stringify(it && { action: it.action, code: it.code }));
    assert.equal((await executePlanItem(it as NonNullable<typeof it>, ctx)).outcome, 'done');

    // Apply (giro notturno): la riga adottata passa dalla patch per campo e si minimizza; la shadow è già a posto.
    const second = await apply({ scope: { calendar_ids: [shape.bookings.id] } });
    assert.equal(second.summary.writes.update, 1, JSON.stringify(second.summary));
    assert.equal(second.summary.adopted, 0);
    for (const key of [keyShadow, keyAdopted]) {
      const body = await bodyOf(key);
      assert.match(body, /SUMMARY:Prenotazione\r?\n/, `${key}: ${body}`);
      assert.doesNotMatch(body, /333 1112223|Mario/, `${key}: nome e telefono rimossi`);
    }
    assert.equal((await apply({ scope: { calendar_ids: [shape.bookings.id] } })).summary.zero_writes, true);
    const { summary } = await verify({ levels: ['V1', 'V2'], scope: { calendar_ids: [shape.bookings.id] } });
    assert.equal(summary.calendars.find((c) => c.calendar_id === shape.bookings.id)?.color, 'green', JSON.stringify(summary.calendars));
  });

  // ─── V4-CAP-SWALLOWS-RED ───────────────────────────────

  test('V4: oltre 100 differenze gialle con più contributori, una rossa resta rossa (calendario rosso, non accettabile)', async () => {
    const from = new Date(Date.now() + DAY).toISOString().slice(0, 10);
    for (let i = 0; i < 2; i++) {
      await fx.event({ calendar: shape.lavoro, summary: 'BYDAY misto', start_time: rome(from, '15:00'), end_time: rome(from, '16:00'), rrule: 'FREQ=MONTHLY;BYDAY=1MO,MO,TU,WE,TH,FR,SA,SU', source: 'admin' });
    }
    const day = new Date(Date.now() + 170 * DAY).toISOString().slice(0, 10);
    const twins = [];
    for (let i = 0; i < 2; i++) {
      twins.push(await fx.event({ calendar: shape.lavoro, summary: 'Gemello', start_time: rome(day, '18:00'), end_time: rome(day, '19:00'), source: 'admin' }));
    }
    const a = await apply();
    assert.equal(a.summary.failed, 0);
    for (const t of twins) {
      const row = await liveHref(`event:${t.id}`);
      const cur = await svc.get(pathOf('lavoro', row.href));
      await svc.put(pathOf('lavoro', row.href), cur.body.replace(/(DTEND[^:\r\n]*:\d{8}T)19/, '$120'), { ifMatch: cur.etag as string });
    }
    const { summary, runId } = await verify({ levels: ['V4'], v4_days: 180 });
    const rows = (await runItems(runId)).filter((i) => i.item_type === 'diff' && i.calendar_id === shape.lavoro.id && i.detail.variant !== 'with_subscriptions');
    assert.ok(rows.filter((r) => r.expected === true).length >= 100, `gialle: ${rows.filter((r) => r.expected === true).length}`);
    const red = rows.filter((r) => r.expected === false);
    assert.ok(red.length >= 1, 'la differenza rossa non sparisce oltre il tetto');
    const summaryRow = rows.find((r) => typeof (r.detail.legacy as { omitted?: unknown } | null)?.omitted === 'number');
    assert.ok(summaryRow, 'riga riassuntiva delle omesse');
    assert.equal(summaryRow.expected, true);
    assert.match(String((summaryRow.detail.legacy as { omitted_sha256: string }).omitted_sha256), /^[0-9a-f]{64}$/);
    const lavoro = summary.calendars.find((c) => c.calendar_id === shape.lavoro.id);
    assert.equal(lavoro?.color, 'red', JSON.stringify(lavoro));
    assert.equal(summary.acceptable, false);
    assert.equal(summary.v4?.without_subscriptions, 'red');
  });
});
