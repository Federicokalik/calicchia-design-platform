/**
 * Rollback della F4 contro Radicale 3.7.8 reale con il config e i plugin di
 * produzione (apps/api/src/lib/calendar/migration/{rollback,rebaseline,
 * finalize}.ts, export v2 di routes/backup.ts; design §13.12-§13.13, §16.2;
 * contratto docs/calendar-radicale/contracts/f4-modules.md §5). La parte
 * senza Radicale è in test/calendar/migration-rollback.test.ts.
 *
 * Stack come integration/migration-cutover: caldes_auth con
 * verify-credentials simulato, caldes_rights con policy.json e heartbeat.json
 * del control-plane dell'API, caldes-svc da 127.0.0.2, device dal gateway
 * (127.0.0.3), probe da 127.0.0.1. Copia sintetica della produzione portata
 * fino al cutover completato (mode radicale, policy live).
 *
 * Casi:
 *  1. finestra: un iPhone crea un evento con un href proprio e uno con RDATE
 *     (espanso in righe derivate), l'admin e MCP ne creano e modificano altri;
 *     export v2 (zip con manifest e un .ics per collezione); finalize bloccato
 *     (FINALIZE_TOO_EARLY);
 *  2. anteprima del rollback: cambiamenti per attore, degradi per classe,
 *     righe derivate, busy legacy identico a quello dell'indice, hash;
 *  3. anteprima cambiata dopo la quiescenza (oggetto comparso durante il
 *     freeze) → annullamento PREVIEW_CHANGED, ritorno a radicale live;
 *  4. rollback completo con un kill prima di ogni passo e la ripresa con un
 *     run nuovo: policy frozen prima della fotografia (PUT del device 403),
 *     mode postgres, epoch E+2 su Radicale e in PG, policy shadow, volume
 *     intatto, busy legacy uguale a quello di Radicale, righe degli oggetti
 *     della finestra in PG, ledger ri-baseline (categorie A, B, C, E);
 *  5. nuovo cutover dopo il rollback: piano a zero scritture (noop per
 *     l'oggetto dell'iPhone con il suo href, per le righe derivate e per gli
 *     oggetti toccati da admin e MCP); export v2 rifiutato in mode postgres.
 *
 * Senza RADICALE_BIN, Python o gli indirizzi 127.0.0.2/127.0.0.3 la suite è
 * saltata con il motivo. Lo stato del backend torna alla baseline a fine file.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { adminToken, api, app } from '../helpers/http';
import {
  type CalDavClient,
  pythonAvailability,
  RADICALE_PLUGINS_DIR,
  radicaleAvailability,
  resolvePython,
  TEST_PRINCIPAL,
  useMockVerify,
  useRadicale,
} from '../helpers/radicale';
import { closeActiveRuns, persistedRun, runToEnd } from '../calendar/_migration-apply-shared';
import { buildProductionShape, type ProductionShape } from '../calendar/_migration-init-shared';
import { executeTool } from '../../src/lib/agent/tools';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { indexBusyRanges } from '../../src/lib/calendar/busy';
import { getBusyRanges as legacyBusyRanges } from '../../src/lib/calendar/legacy/events-pg';
import { runApply } from '../../src/lib/calendar/migration/apply';
import { runCutoverWith } from '../../src/lib/calendar/migration/cutover';
import { finalizeBlockers } from '../../src/lib/calendar/migration/finalize';
import { runInit } from '../../src/lib/calendar/migration/init';
import { buildPlan, runPlan } from '../../src/lib/calendar/migration/plan';
import { acceptDiffs, latestVerifyVerdicts } from '../../src/lib/calendar/migration/report';
import { runReverseProjection } from '../../src/lib/calendar/migration/reverse-projector';
import { runRollbackPreview, runRollbackWith, sameBusy } from '../../src/lib/calendar/migration/rollback';
import { getActiveTransition, readJournal, setTransitionTestHooks } from '../../src/lib/calendar/migration/transition';
import {
  type ApplyParams,
  type CalendarExportManifest,
  CALENDAR_API_LEVEL,
  type CutoverParams,
  type CutoverSummary,
  DEFAULT_MIGRATION_OPTIONS,
  type InitParams,
  MigrationError,
  type PlanParams,
  type PlanSummary,
  ROLLBACK_STEPS,
  type RollbackParams,
  type RollbackPreviewParams,
  type RollbackPreviewSummary,
  type RollbackSummary,
  type VerifyParams,
  type VerifySummary,
} from '../../src/lib/calendar/migration/types';
import { runVerify } from '../../src/lib/calendar/migration/verify';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { readHeartbeatFile, startCalendarControlPlane, stopCalendarControlPlane } from '../../src/lib/calendar/radicale/heartbeat';
import { readVolumeMarkerRemote } from '../../src/lib/calendar/radicale/identity';
import { readPolicyFile } from '../../src/lib/calendar/radicale/policy';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { configureRadicaleRuntime, drainSyncs, syncAllCollections, updateWatchMode } from '../../src/lib/calendar/radicale/sync';
import { startCalendarWatcher, stopCalendarWatcher } from '../../src/lib/calendar/radicale/watcher';
import type { CaldesPolicy } from '../../src/lib/calendar/radicale/types';

const radicale = radicaleAvailability();
const python = pythonAvailability();
const fx = useFixtures('rollback-rad', { resetBaseline: true });
onBeforeDatabaseClose(async () => {
  setTransitionTestHooks(null);
  await stopCalendarWatcher();
  await stopCalendarControlPlane();
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});

const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f4-rollback';
const PROBE_PASSWORD = 'test-only-probe-password-f4-rollback';
const AUTHCACHE_KEY = 'test-only-authcache-key-f4-rollback-0123456789abcdef';
const SVC_PEER = '127.0.0.2';
const GATEWAY = '127.0.0.3';
const PLUGIN_RELOAD_MS = 1_100;
const API_VERSION = 'sha-f4rollback';
const PRODUCTION_CONFIG = join(RADICALE_PLUGINS_DIR, '..', 'config', 'config');
const DEVICE = { username: 'iphone', password: 'tst-app-password-f4-rollback', ip: '203.0.113.42', userAgent: 'iOS/18.0 (22A3354) dataaccessd/1.0' };
const DAY_MS = 86_400_000;
const OPTIONS = { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] };
const FULL_VERIFY: VerifyParams = { scope: {}, levels: ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 180 };
const KILL = 'kill simulato del processo';
const BUSY_FROM = new Date(Date.now() - DAY_MS).toISOString();
const BUSY_TO = new Date(Date.now() + 170 * DAY_MS).toISOString();

function peersAvailable(): string | null {
  for (const address of [SVC_PEER, GATEWAY]) {
    const res = spawnSync(resolvePython(), ['-I', '-c', 'import socket,sys; s=socket.socket(); s.bind((sys.argv[1], 0)); s.close()', address], { timeout: 10_000 });
    if (res.status !== 0) return `${address} non utilizzabile come indirizzo sorgente`;
  }
  return null;
}
const PEERS_SKIP = radicale.skip || python.skip ? null : peersAvailable();

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function productionConfig(paths: { storageDir: string; policyFile: string; heartbeatFile: string }): string {
  const overrides: Record<string, Record<string, string>> = {
    server: { hosts: '127.0.0.1:0' },
    storage: { filesystem_folder: paths.storageDir },
    rights: { caldes_policy_file: paths.policyFile, caldes_heartbeat_file: paths.heartbeatFile },
  };
  let section = '';
  const seen = new Set<string>();
  const out = readFileSync(PRODUCTION_CONFIG, 'utf8').split('\n').map((line) => {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1];
      return line;
    }
    const entry = /^([A-Za-z0-9_]+)\s*=/.exec(line);
    const value = entry ? overrides[section]?.[entry[1]] : undefined;
    if (!entry || value === undefined) return line;
    seen.add(`${section}.${entry[1]}`);
    return `${entry[1]} = ${value}`;
  });
  const missing = Object.entries(overrides).flatMap(([s, v]) => Object.keys(v).map((k) => `${s}.${k}`)).filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`config di produzione senza le chiavi attese: ${missing.join(', ')}`);
  return out.join('\n');
}

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) throw new Error(`timeout in attesa di: ${what}${lastError ? ` (${(lastError as Error).message})` : ''}`);
    await sleep(50);
  }
}

function eventIcs(uid: string, summary: string, opts: { date?: string; extra?: string[] } = {}): string {
  const date = opts.date ?? '20270210';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iPhone OS 18.0//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261016T080000Z', `DTSTART:${date}T090000Z`, `DTEND:${date}T100000Z`, `SUMMARY:${summary}`,
    ...(opts.extra ?? []),
    'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
}

/** Lettore minimo di zip (directory centrale, stored o deflate): il formato dello zip deve essere standard. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'fine della directory centrale');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + csize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('rollback F4 con Radicale reale: anteprima, annullamento, kill a ogni passo, ri-baseline, nuovo cutover a zero scritture', {
  skip: radicale.skip || python.skip || PEERS_SKIP || false,
}, () => {
  let root = '';
  let policyFile = '';
  let heartbeatFile = '';
  let svc: RadicaleClient | null = null;
  let volumeId = '';
  let epochBefore = 0;
  let shape: ProductionShape | null = null;
  let preview: { summary: RollbackPreviewSummary; runId: string } | null = null;
  const window = { iphoneHref: '', iphoneUid: '', rdateHref: '', adminEventId: '', mcpEventId: '', mcpEditedId: '' };
  const previousProbe = process.env.RADICALE_PROBE_PASSWORD;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'caldes-f4-rollback-'));
    const controlDir = join(root, 'control');
    mkdirSync(controlDir, { mode: 0o755 });
    chmodSync(controlDir, 0o755);
    mkdirSync(join(root, 'authcache'), { mode: 0o700 });
    policyFile = join(controlDir, 'policy.json');
    heartbeatFile = join(controlDir, 'heartbeat.json');
    process.env.RADICALE_PROBE_PASSWORD = PROBE_PASSWORD;
  });
  after(async () => {
    setTransitionTestHooks(null);
    await stopCalendarWatcher();
    await drainSyncs(5_000).catch(() => undefined);
    await stopIndexWorker();
    await stopCalendarControlPlane();
    configureRadicaleRuntime(null);
    updateWatchMode('off', 'test concluso');
    svc?.close();
    if (previousProbe === undefined) delete process.env.RADICALE_PROBE_PASSWORD;
    else process.env.RADICALE_PROBE_PASSWORD = previousProbe;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const verify = useMockVerify({ users: [{ username: DEVICE.username, password: DEVICE.password }] });
  const rad = useRadicale(() => ({
    label: 'f4-rollback',
    auth: { type: 'plugin', module: 'caldes_auth' },
    configText: ({ storageDir }) => productionConfig({ storageDir, policyFile, heartbeatFile }),
    pythonPath: [RADICALE_PLUGINS_DIR],
    env: {
      RADICALE_PRINCIPAL: P,
      CALDAV_BACKEND_URL: verify.mock.backendUrl,
      CALDAV_SERVICE_TOKEN: verify.mock.token,
      CALDES_SVC_CIDR: `${SVC_PEER}/32`,
      CALDES_XRA_PEER_CIDR: `${GATEWAY}/32`,
      CALDES_SVC_PASSWORD_SHA256: sha256(SVC_PASSWORD),
      CALDES_PROBE_PASSWORD_SHA256: sha256(PROBE_PASSWORD),
      CALDES_AUTHCACHE_KEY: AUTHCACHE_KEY,
      CALDES_AUTHCACHE_DIR: join(root, 'authcache'),
      CALDES_POLICY_FILE: policyFile,
      TAKE_FILE_OWNERSHIP: 'false',
    },
  }));

  const controlPlaneEnv = (): NodeJS.ProcessEnv => ({
    CALDES_CONTROL_PLANE: 'on',
    CALDES_POLICY_FILE: policyFile,
    CALDES_HEARTBEAT_FILE: heartbeatFile,
    RADICALE_PRINCIPAL: P,
    RADICALE_DATA_DIR: rad.server.storageDir,
    CALDES_IDENTITY_SOURCE: 'file',
    CALDES_API_VERSION: API_VERSION,
  });

  const policyNow = async (): Promise<CaldesPolicy | null> => {
    const read = await readPolicyFile(policyFile, P);
    return read.state === 'ok' ? read.value : null;
  };
  const device = (): CalDavClient =>
    rad.server.client(DEVICE.username, DEVICE.password).fromAddress(GATEWAY).withHeaders({ 'X-Remote-Addr': DEVICE.ip, 'User-Agent': DEVICE.userAgent });
  const devicePutIcs = async (collection: string, name: string, ics: string): Promise<number> =>
    (await device().put(`/${P}/${collection}/${name}`, ics, { ifNoneMatch: '*' })).status;
  const backend = async () => {
    const [row] = await sql`
      SELECT mode, write_freeze, epoch, api_min_version, rollback_until, cutover_at, cutover_by FROM calendar_backend_state WHERE id
    `;
    return row as { mode: string; write_freeze: boolean; epoch: number; api_min_version: number; rollback_until: Date | null; cutover_at: Date | null; cutover_by: string | null };
  };
  const markerEpoch = async (): Promise<number | null> => {
    const read = await readVolumeMarkerRemote(svc!, P);
    return read.state === 'ok' ? read.marker.epoch : null;
  };
  const collectionNames = async (): Promise<string[]> => (await sql<Array<{ n: string }>>`
    SELECT collection_name AS n FROM calendars WHERE collection_name IS NOT NULL AND role <> 'subscription' AND lifecycle = 'active' ORDER BY 1
  `).map((r) => r.n);
  /** Risorse del volume per collezione (PROPFIND come caldes-svc). */
  const volumeListing = async (): Promise<Record<string, string[]>> => {
    const out: Record<string, string[]> = {};
    for (const name of await collectionNames()) {
      const res = await svc!.propfind(`/${P}/${name}/`, { depth: 1 });
      out[name] = res.responses.map((r) => r.href.split('/').filter(Boolean).pop() ?? '').filter((h) => h.endsWith('.ics')).sort();
    }
    return out;
  };
  const syncAndProject = async (): Promise<void> => {
    await syncAllCollections({ reason: 'manual', actor: 'test' });
    await runReverseProjection({ db: sql, actor: 'test:reverse' });
  };

  async function rollbackRun(params: Partial<RollbackParams>): Promise<{ summary: RollbackSummary | null; error: unknown }> {
    const run = await persistedRun<RollbackParams>('rollback', {
      action: 'start', preview_run_id: preview?.runId ?? null, expect_preview_hash: preview?.summary.preview_hash ?? null, emergency: false, ...params,
    } as RollbackParams);
    try {
      const summary = await runRollbackWith(run.ctx);
      await run.finish({ summary });
      return { summary, error: null };
    } catch (error) {
      await run.finish({ error });
      return { summary: null, error };
    }
  }

  async function previewRun(): Promise<{ summary: RollbackPreviewSummary; runId: string }> {
    const r = await runToEnd<RollbackPreviewParams, RollbackPreviewSummary>('rollback_preview', { scope: {} }, (ctx) => runRollbackPreview(ctx));
    return { summary: r.summary, runId: r.runId };
  }

  before(async () => {
    svc = new RadicaleClient({ baseUrl: rad.server.url, password: SVC_PASSWORD, localAddress: SVC_PEER, timeoutMs: 15_000 });
    configureRadicaleRuntime({ client: svc, principal: P, dataDir: rad.server.storageDir, watch: 'off', identitySource: 'remote' });
    shape = await buildProductionShape(fx, { holidayYears: [2026] });
    await sql`UPDATE calendars SET ics_feed_enabled = true WHERE role <> 'subscription'`;

    await runToEnd<InitParams, object>('init', { action: 'initialize' }, (ctx) => runInit(ctx));
    configureRadicaleRuntime({ client: svc, principal: P, dataDir: rad.server.storageDir, watch: 'auto', identitySource: 'remote' });
    updateWatchMode('mount', null);
    await startCalendarWatcher({ intervalMs: 200 });
    const [state] = await sql`SELECT volume_id, epoch FROM calendar_backend_state WHERE id`;
    volumeId = String(state.volume_id);
    epochBefore = Number(state.epoch);
    assert.ok(await startCalendarControlPlane(controlPlaneEnv()), 'control-plane non avviato');
    await waitFor('policy shadow con il volume', async () => {
      const p = await policyNow();
      return p?.volume_id === volumeId && p.mode === 'shadow';
    });

    const now = Date.now();
    await sql`UPDATE calendar_backend_state SET shadow_enabled = true, shadow_since = ${new Date(now - 9 * DAY_MS)} WHERE id`;
    for (let d = 7; d >= 0; d--) {
      const at = new Date(now - d * DAY_MS - 2 * 3_600_000);
      await sql`
        INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, created_at, started_at, finished_at, attempts)
        VALUES ('verify', 'succeeded', 'schedule', 'system:shadow', ${sql.json(FULL_VERIFY as never)}, ${sql.json({ acceptable: true, overall: 'green' } as never)}, ${at}, ${at}, ${at}, 1)
      `;
    }
    const plan = await runToEnd<PlanParams, PlanSummary>('plan', { scope: {}, options: OPTIONS }, (ctx) => runPlan(ctx));
    const applyParams: ApplyParams = { scope: {}, options: OPTIONS, expected_plan_hash: plan.summary.plan_hash, force_item_ids: [], force_codes: [], follow_up_verify: null };
    await runToEnd<ApplyParams, object>('apply', applyParams, (ctx) => runApply(ctx), { planRunId: plan.runId, planHash: plan.summary.plan_hash });
    const verified = await runToEnd<VerifyParams, object>('verify', FULL_VERIFY, (ctx) => runVerify(ctx));
    await acceptDiffs(sql, { runId: verified.runId, allExpected: true, actor: 'admin:test-rollback' }).catch((err: unknown) => {
      if (!(err instanceof MigrationError && err.code === 'VALIDATION_FAILED')) throw err;
    });
    const declarations = { device_matrix: { value: { result: 'passed', devices: ['ios', 'macos', 'davx5', 'thunderbird'], strict_preconditions: true, allday_transp_rule: 'opaque_blocks', note: null }, at: new Date().toISOString(), by: 'admin:test' } };
    await sql`
      UPDATE calendar_backend_state
      SET migration_declarations = migration_declarations || ${sql.json(declarations as never)},
          last_stack_backup = ${sql.json({ id: 'b-rollback', at: new Date().toISOString(), complete: true, volume_id: volumeId, epoch: epochBefore, manifest_sha256: null } as never)}
      WHERE id
    `;
    invalidateBackendModeCache();

    // Cutover completo (un solo run): mode radicale, policy live, proiezione inversa iniziale.
    const run = await persistedRun<CutoverParams>('cutover', { action: 'start', rollback_window_days: 30, verify_run_id: null });
    let summary: CutoverSummary;
    try {
      summary = await runCutoverWith(run.ctx);
      await run.finish({ summary });
    } catch (error) {
      await run.finish({ error });
      throw error;
    }
    assert.equal(summary.outcome, 'completed', JSON.stringify(summary.steps.filter((s) => s.status !== 'done')));
    assert.equal((await backend()).mode, 'radicale');
    await waitFor('policy live con il nuovo epoch', async () => {
      const p = await policyNow();
      return p?.mode === 'live' && p.epoch === epochBefore + 1;
    });
    await sleep(PLUGIN_RELOAD_MS);
    invalidateBackendModeCache();
  });

  test('1. finestra di rollback: iPhone, admin e MCP scrivono; export v2; finalize troppo presto', async () => {
    assert.ok(shape);
    // iPhone: evento con un href proprio (diverso dall'UID) e uno con RDATE (espanso in righe derivate).
    window.iphoneUid = `${randomUUID().toUpperCase()}`;
    window.iphoneHref = `${randomUUID().toUpperCase()}.ics`;
    assert.equal(await devicePutIcs('c', window.iphoneHref, eventIcs(window.iphoneUid, 'Dentista (iPhone)', { date: '20270301', extra: ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Promemoria', 'TRIGGER:-PT15M', 'END:VALARM'] })), 201);
    window.rdateHref = `${randomUUID().toUpperCase()}.ics`;
    assert.equal(await devicePutIcs('c', window.rdateHref, eventIcs(`${randomUUID()}@iphone.test`, 'Corso con date sparse', { date: '20270305', extra: ['RDATE:20270312T090000Z,20270319T090000Z'] })), 201);

    // Admin v1 (store Radicale): creazione e modifica di un evento migrato.
    const created = await api.post('/api/admin/calendar/events', {
      auth: 'admin',
      body: { calendar_id: shape.c.id, summary: fx.name('Admin nella finestra'), start_time: '2027-03-08T08:00:00Z', end_time: '2027-03-08T09:00:00Z' },
    });
    assert.equal(created.status, 200, created.text);
    window.adminEventId = (created.json as { event: { id: string } }).event.id;
    const single = shape.singles[0];
    assert.ok(single, 'evento singolo migrato');
    const edited = await api.put(`/api/admin/calendar/events/${single.id}`, { auth: 'admin', body: { summary: fx.name('Modificato dall\'admin nella finestra') } });
    assert.equal(edited.status, 200, edited.text);

    // MCP: creazione e modifica.
    const mcpCreated = JSON.parse(await executeTool('create_event', { calendar: 'c', summary: fx.name('Da MCP nella finestra'), start: '2027-03-09T09:00:00Z', end: '2027-03-09T10:00:00Z' }));
    assert.equal(mcpCreated.error, undefined, JSON.stringify(mcpCreated));
    window.mcpEventId = String(mcpCreated.event?.id ?? mcpCreated.id ?? '');
    const target = shape.singles[1] ?? shape.singles[0];
    const mcpEdited = JSON.parse(await executeTool('update_event', { id_or_uid: target.id, location: 'Sala riunioni (MCP)' }));
    assert.equal(mcpEdited.error, undefined, JSON.stringify(mcpEdited));
    window.mcpEditedId = target.id;

    await syncAndProject();
    const [iphoneRow] = await sql`
      SELECT e.id::text AS id, e.uid, e.caldes_derived FROM calendar_events e
      JOIN cal_object_ids o ON o.id = e.caldes_object_id
      WHERE o.href = ${window.iphoneHref} AND e.recurrence_master_id IS NULL
    `;
    assert.ok(iphoneRow, 'evento dell\'iPhone proiettato in PG');
    assert.equal(iphoneRow.uid, window.iphoneUid);
    const [{ derived }] = await sql`
      SELECT count(*)::int AS derived FROM calendar_events e JOIN cal_object_ids o ON o.id = e.caldes_object_id
      WHERE o.href = ${window.rdateHref} AND e.caldes_derived
    `;
    assert.ok(derived >= 3, `righe derivate della serie con RDATE: ${derived}`);

    // Export v2: zip con manifest e un .ics per collezione, oggetti dall'indice.
    const res = await app.request('/api/backup/export?format=calendar-v2', {
      headers: { Authorization: `Bearer ${await adminToken()}`, 'X-Forwarded-For': '198.18.250.1' },
    });
    assert.equal(res.status, 200, res.status === 200 ? '' : await res.text());
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const zip = readZip(Buffer.from(await res.arrayBuffer()));
    const manifest = JSON.parse(zip.get('manifest.json')!.toString('utf8')) as CalendarExportManifest;
    assert.equal(manifest.format, 'caldes-calendar-export');
    assert.equal(manifest.version, 2);
    assert.equal(manifest.backend_mode, 'radicale');
    assert.equal(manifest.epoch, epochBefore + 1);
    const cEntry = manifest.collections.find((c) => c.collection_name === 'c');
    assert.ok(cEntry, 'collezione c nel manifest');
    const cIcs = zip.get(cEntry.file)!;
    assert.equal(sha256(cIcs), cEntry.sha256);
    const text = cIcs.toString('utf8');
    assert.match(text, /^BEGIN:VCALENDAR\r\n/);
    assert.ok(text.includes(`UID:${window.iphoneUid}`), 'evento dell\'iPhone nel .ics della collezione');
    assert.ok(text.includes('BEGIN:VALARM'), 'la rappresentazione completa del volume resta nell\'export');
    assert.equal((text.match(/BEGIN:VEVENT/g) ?? []).length >= cEntry.objects, true);

    // Finalize: troppo presto (14 giorni dal cutover).
    assert.ok((await finalizeBlockers(sql)).includes('FINALIZE_TOO_EARLY'));
  });

  test('2. anteprima del rollback: cambiamenti per attore, degradi, derivate, busy identico', async () => {
    preview = await previewRun();
    const s = preview.summary;
    assert.match(s.preview_hash, /^[0-9a-f]{64}$/);
    assert.ok(s.objects > 0);
    assert.ok(s.derived_rows >= 3, `righe derivate: ${s.derived_rows}`);
    assert.ok((s.by_class.SEMANTIC_EXPANDED ?? 0) >= 1, JSON.stringify(s.by_class));
    assert.ok((s.by_class.REPR_LOSS_VALARM ?? 0) >= 1, JSON.stringify(s.by_class));
    assert.equal(s.reverse_failed, 0);
    assert.equal(s.busy_identical, true, 'busy legacy previsto uguale a quello dell\'indice');
    assert.ok(s.changes_since_cutover.created >= 4, JSON.stringify(s.changes_since_cutover));
    // L'attribuzione per attore è quella delle versioni dell'indice (best effort: una sync write-through della
    // collezione registra anche i cambiamenti dei device osservati nello stesso giro); i totali sono esatti.
    const byActor = s.changes_since_cutover.by_actor;
    const c = s.changes_since_cutover;
    assert.ok(c.updated >= 2, `modifiche dell'admin e di MCP: ${JSON.stringify(c)}`);
    assert.equal(Object.values(byActor).reduce((a, n) => a + (n ?? 0), 0), c.created + c.updated + c.deleted);
    assert.ok(Object.keys(byActor).every((k) => ['device', 'admin', 'mcp', 'agent', 'system', 'booking', 'other'].includes(k)), JSON.stringify(byActor));
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM cal_migration_items WHERE run_id = ${preview.runId}::uuid AND item_type = 'degradation'`;
    assert.ok(n >= 2, 'righe degradation nel run dell\'anteprima');
  });

  test('3. anteprima cambiata dopo la quiescenza: annullamento PREVIEW_CHANGED, Radicale resta autorevole', async () => {
    const name = `comparso-${randomUUID().slice(0, 8)}.ics`;
    setTransitionTestHooks({
      beforeStep: async (_kind, step) => {
        if (step !== 'index_sync') return;
        setTransitionTestHooks(null);
        await svc!.put(objectPath(P, 'c', name), eventIcs(`${name}@svc.test`, 'Comparso durante il freeze', { date: '20270320' }), { ifNoneMatch: '*' });
      },
    });
    const { error } = await rollbackRun({ action: 'start' });
    assert.ok(error instanceof MigrationError, String(error));
    assert.equal(error.details?.run_error_code, 'ROLLBACK_ABORTED', error.message);
    assert.equal(error.details?.abort_code, 'PREVIEW_CHANGED');
    assert.ok(error.details?.preview, 'nuova anteprima nel riassunto');
    const state = await backend();
    assert.deepEqual({ mode: state.mode, write_freeze: state.write_freeze, epoch: state.epoch }, { mode: 'radicale', write_freeze: false, epoch: epochBefore + 1 });
    assert.equal(await getActiveTransition(sql), null);
    await waitFor('policy di nuovo live', async () => (await policyNow())?.mode === 'live');
    // Pulizia: l'oggetto comparso si toglie e l'anteprima si ricalcola.
    const got = await svc!.get(objectPath(P, 'c', name));
    await svc!.delete(objectPath(P, 'c', name), { ifMatch: got.etag as string });
    await syncAndProject();
    preview = await previewRun();
  });

  test('4. rollback completo con un kill prima di ogni passo e la ripresa', async () => {
    assert.ok(preview);
    const listingBefore = await volumeListing();
    const indexBusy = await indexBusyRanges(sql, BUSY_FROM, BUSY_TO, { includeBookingProjections: true });
    const killed = new Set<string>();
    let deviceChecked = false;
    setTransitionTestHooks({
      beforeStep: async (_kind, step) => {
        if (step === 'index_sync' && !deviceChecked) {
          // Policy frozen prima della fotografia: il device non scrive più.
          deviceChecked = true;
          await waitFor('policy frozen', async () => (await policyNow())?.mode === 'frozen');
          await sleep(PLUGIN_RELOAD_MS);
          assert.equal(await devicePutIcs('c', `durante-${randomUUID().slice(0, 8)}.ics`, eventIcs(`${randomUUID()}@iphone.test`, 'Durante il rollback')), 403);
        }
        if (killed.has(step)) return;
        killed.add(step);
        throw new Error(KILL);
      },
    });
    let summary: RollbackSummary | null = null;
    let runs = 0;
    let action: RollbackParams['action'] = 'start';
    try {
      for (; runs < 20 && !summary;) {
        runs += 1;
        const r = await rollbackRun({ action });
        if (r.summary) {
          summary = r.summary;
          break;
        }
        assert.match(String((r.error as Error)?.message), new RegExp(KILL), `run ${runs}: ${String((r.error as Error)?.message)}`);
        action = 'resume';
        const transition = await getActiveTransition(sql);
        assert.ok(transition, `transizione attiva dopo il run ${runs}`);
        const journal = await readJournal(sql, transition.id);
        const state = await backend();
        if (journal.some((j) => j.step === 'epoch' && j.status === 'done')) {
          assert.equal(state.mode, 'postgres');
          assert.equal(state.epoch, epochBefore + 2);
        } else if (journal.some((j) => j.step === 'freeze' && j.status === 'done')) {
          assert.equal(state.mode, 'rollback');
          assert.equal(state.write_freeze, true);
        }
      }
    } finally {
      setTransitionTestHooks(null);
    }
    assert.ok(summary, 'rollback concluso');
    assert.equal(runs, ROLLBACK_STEPS.length + 1, 'un kill prima di ogni passo, poi la ripresa che conclude');
    assert.equal(summary.outcome, 'completed');
    assert.deepEqual(summary.steps.map((s) => s.step), [...ROLLBACK_STEPS]);
    for (const s of summary.steps) assert.equal(s.status, 'done', `${s.step}: ${s.error}`);
    assert.equal(summary.final_preview_hash, preview.summary.preview_hash);
    assert.equal(summary.epoch_after, epochBefore + 2);
    assert.ok(summary.rebaseline && summary.rebaseline.adopted > 0, JSON.stringify(summary.rebaseline));
    assert.ok(summary.rebaseline.created >= 3, `righe nuove del ledger (oggetti della finestra): ${JSON.stringify(summary.rebaseline)}`);
    assert.ok(summary.rebaseline.derived >= 1);

    // Stato, marker, policy shadow, heartbeat postgres, device in sola lettura.
    const state = await backend();
    assert.deepEqual(
      { mode: state.mode, write_freeze: state.write_freeze, epoch: state.epoch, api_min_version: state.api_min_version, rollback_until: state.rollback_until, cutover_at: state.cutover_at, cutover_by: state.cutover_by },
      { mode: 'postgres', write_freeze: false, epoch: epochBefore + 2, api_min_version: CALENDAR_API_LEVEL, rollback_until: null, cutover_at: null, cutover_by: null },
    );
    assert.equal(await markerEpoch(), epochBefore + 2);
    await waitFor('policy shadow con il nuovo epoch', async () => {
      const p = await policyNow();
      return p?.mode === 'shadow' && p.epoch === epochBefore + 2;
    });
    await waitFor('heartbeat postgres', async () => {
      const hb = await readHeartbeatFile(heartbeatFile);
      return hb.state === 'ok' && hb.value.mode === 'postgres' && hb.value.epoch === epochBefore + 2;
    });
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await devicePutIcs('c', `dopo-${randomUUID().slice(0, 8)}.ics`, eventIcs(`${randomUUID()}@iphone.test`, 'Dopo il rollback')), 403);

    // Volume intatto come archivio.
    assert.deepEqual(await volumeListing(), listingBefore, 'nessuna risorsa del volume creata o cancellata dal rollback');

    // Busy legacy uguale a quello di Radicale sull'orizzonte; righe della finestra in PG; scritture legacy di nuovo ammesse.
    invalidateBackendModeCache();
    assert.ok(sameBusy(await legacyBusyRanges(BUSY_FROM, BUSY_TO), indexBusy), 'busy legacy dopo il rollback uguale a quello di Radicale');
    for (const id of [window.adminEventId, window.mcpEventId].filter(Boolean)) {
      const [row] = await sql`SELECT id FROM calendar_events WHERE id = ${id}::uuid`;
      assert.ok(row, `evento ${id} della finestra in PG con lo stesso id`);
    }
    const [{ jobs }] = await sql`SELECT count(*)::int AS jobs FROM cal_jobs WHERE kind = 'reverse_projection' AND status = 'pending'`;
    assert.equal(jobs, 0, 'proiezione inversa ferma');
    const written = await api.post('/api/admin/calendar/events', {
      auth: 'admin',
      body: { calendar_id: shape!.c.id, summary: fx.name('Admin dopo il rollback'), start_time: '2027-05-04T08:00:00Z', end_time: '2027-05-04T09:00:00Z' },
    });
    assert.equal(written.status, 200, written.text);
    // L'evento dopo il rollback si toglie subito: il piano del passo 5 riguarda gli oggetti non toccati.
    await sql`DELETE FROM calendar_events WHERE id = ${(written.json as { event: { id: string } }).event.id}::uuid`;
  });

  test('5. nuovo cutover dopo il rollback: piano a zero scritture; export v2 rifiutato in mode postgres', async () => {
    const plan = await buildPlan({ db: sql, client: svc!, principal: P, mode: 'apply', scope: {}, options: OPTIONS, now: new Date() });
    const notNoop = plan.items.filter((i) => i.action !== 'noop' && i.action !== 'skip');
    assert.deepEqual(notNoop.map((i) => `${i.collection_name}/${i.href} ${i.legacy_key} ${i.action}${i.code ? `:${i.code}` : ''}`), [], 'nessuna scrittura, adozione o conflitto');
    const iphone = plan.items.find((i) => i.href === window.iphoneHref);
    assert.ok(iphone, 'oggetto dell\'iPhone nel piano con il suo href');
    assert.equal(iphone.action, 'noop');
    const derived = plan.items.find((i) => i.href === window.rdateHref);
    assert.ok(derived && derived.source?.legacy_snapshot.kind === 'derived', 'righe derivate come sorgente derived');
    assert.equal(derived.action, 'noop');
    for (const id of [window.mcpEditedId, shape!.singles[0].id]) {
      const item = plan.items.find((i) => i.legacy_key === `event:${id}`);
      assert.ok(item, `oggetto toccato nella finestra (${id}) nel piano`);
      assert.equal(item.action, 'noop');
    }

    // Verifica completa dopo il rollback (precondizione del nuovo cutover): le righe derivate si confrontano
    // per occorrenze e l'oggetto dell'iPhone (adottato, con VALARM) non ha differenze nei campi del piano.
    const verified = await runToEnd<VerifyParams, VerifySummary>('verify', FULL_VERIFY, (ctx) => runVerify(ctx));
    const diffs = await sql<Array<{ level: string; code: string; href: string; detail: unknown }>>`
      SELECT level, code, href, detail FROM cal_migration_items
      WHERE run_id = ${verified.runId}::uuid AND item_type = 'diff' AND href = ANY(${[window.rdateHref, window.iphoneHref]}::text[])
    `;
    // Righe derivate: confrontate per occorrenze (nessuna differenza V2/V3); nel feed legacy un evento per
    // occorrenza, differenza attesa come gli orfani convertiti.
    const onDerived = diffs.filter((d) => d.href === window.rdateHref);
    assert.ok(onDerived.every((d) => d.level === 'V5' && (d.detail as { reason?: string | null }).reason === 'ORPHAN_CONVERTED'), `righe derivate: ${JSON.stringify(onDerived)}`);
    // Oggetto dell'iPhone: nessuna differenza. La riga del ledger ri-allineata dal rollback (stesso etag,
    // stessa riga legacy) non si confronta per campi con il testo ricostruito dal serializer (la riga legacy
    // è la proiezione della risorsa del device, non la sua sorgente); le occorrenze restano confrontate da V3.
    const onIphone = diffs.filter((d) => d.href === window.iphoneHref);
    assert.deepEqual(onIphone, [], `oggetto dell'iPhone: ${JSON.stringify(onIphone)}`);
    await acceptDiffs(sql, { runId: verified.runId, allExpected: true, actor: 'admin:test-rollback' }).catch((err: unknown) => {
      if (!(err instanceof MigrationError && err.code === 'VALIDATION_FAILED')) throw err;
    });
    const latest = await latestVerifyVerdicts(sql);
    assert.equal(latest.runId, verified.runId);
    assert.equal(latest.acceptable, true, `verifica dopo il rollback accettabile (nuovo cutover possibile): ${JSON.stringify(latest.verdicts.filter((v) => v.color !== 'green'))}`);

    const res = await api.get('/api/backup/export', { auth: 'admin', query: { format: 'calendar-v2' } });
    assert.equal(res.status, 409);
    assert.equal(res.json?.code, 'EXPORT_V2_NOT_AVAILABLE');
    await closeActiveRuns();
  });
});
