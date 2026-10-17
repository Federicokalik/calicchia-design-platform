/**
 * Cutover della F4 contro Radicale 3.7.8 reale con il config e i plugin di
 * produzione (apps/api/src/lib/calendar/migration/cutover.ts e smoke.ts;
 * design §13.9-§13.10; contratto docs/calendar-radicale/contracts/
 * f4-modules.md §3). La parte senza Radicale è in test/calendar/
 * migration-cutover.test.ts.
 *
 * Stack come integration/migration-transition: caldes_auth con
 * verify-credentials simulato, caldes_rights con policy.json e heartbeat.json
 * scritti dal control-plane dell'API, caldes-svc dal peer di caldav-int
 * (127.0.0.2), device dal gateway (127.0.0.3), probe da 127.0.0.1.
 *
 * Copia sintetica della produzione (buildProductionShape: `c` con la serie
 * infinita, `f` con festività e chiusura, Prenotazioni con una proiezione),
 * feed attivi, volume inizializzato, anteprima, apply, verifica completa con
 * le differenze attese accettate, parità dello shadow di 8 giorni, matrice
 * device superata e backup coordinato fresco: lo stato in cui il wizard
 * abilita il passaggio.
 *
 * Casi:
 *  1. criteri del §3.2 tutti soddisfatti sullo stato pronto;
 *  2. delta in conflitto (oggetto cambiato su Radicale durante il freeze) →
 *     annullamento CUTOVER_ABORTED: mode postgres, policy shadow, device in
 *     sola lettura, epoch invariato;
 *  3. verifica del delta rossa (oggetto non tracciato comparso) →
 *     annullamento VERIFY_RED con lo stesso ritorno sicuro;
 *  4. kill prima di ogni passo fino al punto di non ritorno compreso, poi
 *     annullamento: sempre mode postgres con la policy shadow, marker
 *     invariato;
 *  5. cutover completo con un kill prima di ogni passo e la ripresa con un run
 *     nuovo (13 run), una prenotazione presa a cavallo del freeze: mode
 *     radicale, epoch E+1 su Radicale e in PG, api_min_version 4, finestra di
 *     30 giorni, policy live (device scrive su `c`, non su `bookings`), smoke
 *     verdi senza residui, guardia 166 attiva, proiezione della prenotazione;
 *  6. contratti in mode radicale: slot e prenotazione del sito, feed con lo
 *     stesso token, tool MCP in lettura e in scrittura sullo store Radicale.
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
import { after, before, describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';
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
import { createBooking, registerBookingJobs } from '../../src/lib/calendar/booking';
import { runCalendarJobsOnce } from '../../src/lib/calendar/jobs';
import { runApply } from '../../src/lib/calendar/migration/apply';
import { cutoverCriteria, runCutoverWith } from '../../src/lib/calendar/migration/cutover';
import { SMOKE_ATTENDEE_EMAIL } from '../../src/lib/calendar/migration/smoke';
import { runInit } from '../../src/lib/calendar/migration/init';
import { runPlan } from '../../src/lib/calendar/migration/plan';
import { acceptDiffs, latestVerifyVerdicts } from '../../src/lib/calendar/migration/report';
import { getActiveTransition, readJournal, setTransitionTestHooks } from '../../src/lib/calendar/migration/transition';
import {
  type ApplyParams,
  CALENDAR_API_LEVEL,
  CUTOVER_STEPS,
  type CutoverParams,
  type CutoverSummary,
  DEFAULT_MIGRATION_OPTIONS,
  type InitParams,
  MigrationError,
  type PlanParams,
  type PlanSummary,
  type VerifyParams,
} from '../../src/lib/calendar/migration/types';
import { runVerify } from '../../src/lib/calendar/migration/verify';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { readHeartbeatFile, startCalendarControlPlane, stopCalendarControlPlane } from '../../src/lib/calendar/radicale/heartbeat';
import { readVolumeMarkerRemote } from '../../src/lib/calendar/radicale/identity';
import { readPolicyFile } from '../../src/lib/calendar/radicale/policy';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { configureRadicaleRuntime, drainSyncs, updateWatchMode } from '../../src/lib/calendar/radicale/sync';
import { startCalendarWatcher, stopCalendarWatcher } from '../../src/lib/calendar/radicale/watcher';
import { calendarStore } from '../../src/lib/calendar/store';
import type { CaldesPolicy } from '../../src/lib/calendar/radicale/types';
import { logger } from '../../src/lib/logger';

const radicale = radicaleAvailability();
const python = pythonAvailability();
const fx = useFixtures('cutover-rad', { resetBaseline: true });
onBeforeDatabaseClose(async () => {
  setTransitionTestHooks(null);
  await stopCalendarWatcher();
  await stopCalendarControlPlane();
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});

const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f4-cutover';
const PROBE_PASSWORD = 'test-only-probe-password-f4-cutover';
const AUTHCACHE_KEY = 'test-only-authcache-key-f4-cutover-0123456789abcdef';
const SVC_PEER = '127.0.0.2';
const GATEWAY = '127.0.0.3';
const PLUGIN_RELOAD_MS = 1_100;
const API_VERSION = 'sha-f4cutover';
const PRODUCTION_CONFIG = join(RADICALE_PLUGINS_DIR, '..', 'config', 'config');
const DEVICE = { username: 'iphone', password: 'tst-app-password-f4-cutover', ip: '203.0.113.41', userAgent: 'iOS/18.0 (22A3354) dataaccessd/1.0' };
const DAY_MS = 86_400_000;
const OPTIONS = { ...DEFAULT_MIGRATION_OPTIONS, bookings_move_event_ids: [] };
const FULL_VERIFY: VerifyParams = { scope: {}, levels: ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 180 };
const KILL = 'kill simulato del processo';


function peersAvailable(): string | null {
  for (const address of [SVC_PEER, GATEWAY]) {
    const res = spawnSync(resolvePython(), ['-I', '-c', 'import socket,sys; s=socket.socket(); s.bind((sys.argv[1], 0)); s.close()', address], { timeout: 10_000 });
    if (res.status !== 0) return `${address} non utilizzabile come indirizzo sorgente`;
  }
  return null;
}
const PEERS_SKIP = radicale.skip || python.skip ? null : peersAvailable();

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
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

function eventIcs(uid: string, summary: string, date = '20270210'): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iPhone OS 18.0//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261016T080000Z', `DTSTART:${date}T090000Z`, `DTEND:${date}T100000Z`, `SUMMARY:${summary}`, 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
}

describe('cutover F4 con Radicale reale: criteri, annullamenti, kill a ogni passo, mode radicale', {
  skip: radicale.skip || python.skip || PEERS_SKIP || false,
}, () => {
  let root = '';
  let policyFile = '';
  let heartbeatFile = '';
  let svc: RadicaleClient | null = null;
  let volumeId = '';
  let epochBefore = 0;
  let shape: ProductionShape | null = null;
  const previousProbe = process.env.RADICALE_PROBE_PASSWORD;
  const log = logger.child({ scope: 'test-cutover-rad' });

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'caldes-f4-cutover-'));
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
    label: 'f4-cutover',
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
  const devicePut = async (collection: string, name: string): Promise<number> =>
    (await device().put(`/${P}/${collection}/${name}.ics`, eventIcs(`${name}@device.test`, `Dal telefono ${name}`), { ifNoneMatch: '*' })).status;
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

  /** Un run di cutover come l'esecutore (riga running, righe persistite, esito registrato). */
  async function cutoverRun(params: Partial<CutoverParams>): Promise<{ summary: CutoverSummary | null; error: unknown; runId: string }> {
    const run = await persistedRun<CutoverParams>('cutover', { action: 'start', rollback_window_days: 30, verify_run_id: null, ...params } as CutoverParams);
    try {
      const summary = await runCutoverWith(run.ctx);
      await run.finish({ summary });
      return { summary, error: null, runId: run.ctx.runId };
    } catch (error) {
      await run.finish({ error });
      return { summary: null, error, runId: run.ctx.runId };
    }
  }

  /** Evento creato dall'admin v1 nel calendario `c` (route di oggi). */
  const adminCreate = async (label: string) => api.post('/api/admin/calendar/events', {
    auth: 'admin',
    body: { calendar_id: shape!.c.id, summary: fx.name(`Admin ${label}`), start_time: '2027-04-06T08:00:00Z', end_time: '2027-04-06T09:00:00Z' },
  });

  /** Ritorno sicuro: mode postgres senza freeze, policy shadow, device in sola lettura, epoch e marker invariati. */
  async function assertSafePostgres(what: string): Promise<void> {
    const state = await backend();
    assert.deepEqual({ mode: state.mode, write_freeze: state.write_freeze, epoch: state.epoch }, { mode: 'postgres', write_freeze: false, epoch: epochBefore }, what);
    assert.equal(await markerEpoch(), epochBefore, `${what}: marker invariato`);
    await waitFor(`${what}: policy shadow`, async () => (await policyNow())?.mode === 'shadow');
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await devicePut('c', `ritorno-${randomUUID().slice(0, 8)}`), 403, `${what}: device in sola lettura`);
    assert.equal(await getActiveTransition(sql), null, `${what}: nessuna transizione attiva`);
  }

  async function trackedObject(collection: string): Promise<{ href: string; etag: string; body: string }> {
    const [row] = await sql<Array<{ href: string }>>`
      SELECT href FROM cal_migration_ledger
      WHERE collection_name = ${collection} AND deleted_at IS NULL AND written_etag IS NOT NULL AND kind = 'event'
      ORDER BY href LIMIT 1
    `;
    assert.ok(row, `oggetto tracciato in ${collection}`);
    const got = await svc!.get(objectPath(P, collection, row.href));
    return { href: row.href, etag: got.etag as string, body: got.body };
  }

  before(async () => {
    svc = new RadicaleClient({ baseUrl: rad.server.url, password: SVC_PASSWORD, localAddress: SVC_PEER, timeoutMs: 15_000 });
    configureRadicaleRuntime({ client: svc, principal: P, dataDir: rad.server.storageDir, watch: 'off', identitySource: 'remote' });
    shape = await buildProductionShape(fx, { holidayYears: [2026] });
    await sql`UPDATE calendars SET ics_feed_enabled = true WHERE role <> 'subscription'`;

    // Volume inizializzato dallo strumento (collezioni dagli slug di oggi), campanello e control-plane attivi.
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

    // Parità dello shadow: 8 giri notturni verdi nei giorni passati (prima della verifica vera).
    const now = Date.now();
    await sql`UPDATE calendar_backend_state SET shadow_enabled = true, shadow_since = ${new Date(now - 9 * DAY_MS)} WHERE id`;
    for (let d = 7; d >= 0; d--) {
      const at = new Date(now - d * DAY_MS - 2 * 3_600_000);
      await sql`
        INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, created_at, started_at, finished_at, attempts)
        VALUES ('verify', 'succeeded', 'schedule', 'system:shadow', ${sql.json(FULL_VERIFY as never)}, ${sql.json({ acceptable: true, overall: 'green' } as never)}, ${at}, ${at}, ${at}, 1)
      `;
    }

    // Anteprima, apply e verifica completa con le differenze attese accettate.
    const plan = await runToEnd<PlanParams, PlanSummary>('plan', { scope: {}, options: OPTIONS }, (ctx) => runPlan(ctx));
    const applyParams: ApplyParams = { scope: {}, options: OPTIONS, expected_plan_hash: plan.summary.plan_hash, force_item_ids: [], force_codes: [], follow_up_verify: null };
    await runToEnd<ApplyParams, object>('apply', applyParams, (ctx) => runApply(ctx), { planRunId: plan.runId, planHash: plan.summary.plan_hash });
    const verified = await runToEnd<VerifyParams, object>('verify', FULL_VERIFY, (ctx) => runVerify(ctx));
    await acceptDiffs(sql, { runId: verified.runId, allExpected: true, actor: 'admin:test-cutover' }).catch((err: unknown) => {
      if (!(err instanceof MigrationError && err.code === 'VALIDATION_FAILED')) throw err;
    });
    const latest = await latestVerifyVerdicts(sql);
    assert.equal(latest.runId, verified.runId);
    assert.equal(latest.acceptable, true, `verifica accettabile: ${JSON.stringify(latest.verdicts.filter((v) => v.color !== 'green'))}`);

    // Matrice device superata e backup coordinato fresco con l'identità corrente.
    const declarations = { device_matrix: { value: { result: 'passed', devices: ['ios', 'macos', 'davx5', 'thunderbird'], strict_preconditions: true, allday_transp_rule: 'opaque_blocks', note: null }, at: new Date().toISOString(), by: 'admin:test' } };
    await sql`
      UPDATE calendar_backend_state
      SET migration_declarations = migration_declarations || ${sql.json(declarations as never)},
          last_stack_backup = ${sql.json({ id: 'b-cutover', at: new Date().toISOString(), complete: true, volume_id: volumeId, epoch: epochBefore, manifest_sha256: null } as never)}
      WHERE id
    `;
    invalidateBackendModeCache();
    registerBookingJobs();
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await devicePut('c', 'prima-del-passaggio'), 403, 'in mode postgres i device sono in sola lettura');
  });

  test('1. criteri del passaggio tutti soddisfatti sullo stato pronto', async () => {
    const criteria = await cutoverCriteria(sql);
    for (const c of criteria) assert.equal(c.ok, true, `${c.id}: ${c.detail}`);
  });

  test('2. delta in conflitto (oggetto cambiato su Radicale durante il freeze): annullamento, Postgres resta autorevole', async () => {
    const target = await trackedObject('c');
    setTransitionTestHooks({
      beforeStep: async (_kind, step) => {
        if (step !== 'delta_apply') return;
        setTransitionTestHooks(null);
        const changed = target.body.replace(/^SUMMARY:.*$/m, 'SUMMARY:Cambiato fuori dallo strumento');
        await svc!.put(objectPath(P, 'c', target.href), changed, { ifMatch: target.etag });
      },
    });
    const { error } = await cutoverRun({ action: 'start' });
    assert.ok(error instanceof MigrationError, String(error));
    assert.equal(error.details?.run_error_code, 'CUTOVER_ABORTED', error.message);
    assert.equal(error.details?.abort_code, 'CUTOVER_ABORTED');
    const summary = error.details?.summary as CutoverSummary;
    assert.equal(summary.outcome, 'aborted');
    assert.ok(Object.values(summary.delta?.conflicts ?? {}).reduce((a, b) => a + (b ?? 0), 0) >= 1, 'conflitto del delta nel riassunto');
    assert.deepEqual(summary.steps.map((s) => [s.step, s.status]), [
      ['preflight', 'done'], ['freeze', 'done'], ['quiesce', 'done'], ['delta_apply', 'done'], ['abort', 'done'],
    ]);
    await assertSafePostgres('dopo il delta in conflitto');
    // Ripristino del contenuto scritto dallo strumento (il prossimo delta lo adotta senza scrivere).
    const now = await svc!.get(objectPath(P, 'c', target.href));
    await svc!.put(objectPath(P, 'c', target.href), target.body, { ifMatch: now.etag as string });
  });

  test('3. verifica del delta rossa (oggetto non tracciato): annullamento VERIFY_RED, ritorno sicuro', async () => {
    const name = `non-tracciato-${randomUUID().slice(0, 8)}.ics`;
    setTransitionTestHooks({
      beforeStep: async (_kind, step) => {
        if (step !== 'delta_verify') return;
        setTransitionTestHooks(null);
        await svc!.put(objectPath(P, 'c', name), eventIcs(`${name}@estraneo.test`, 'Comparso durante il passaggio'), { ifNoneMatch: '*' });
      },
    });
    const { error } = await cutoverRun({ action: 'start' });
    assert.ok(error instanceof MigrationError, String(error));
    assert.equal(error.details?.run_error_code, 'CUTOVER_ABORTED', error.message);
    assert.equal(error.details?.abort_code, 'VERIFY_RED');
    const [t] = await sql`SELECT status, outcome_code FROM cal_migration_transitions ORDER BY started_at DESC LIMIT 1`;
    assert.deepEqual({ ...t }, { status: 'aborted', outcome_code: 'VERIFY_RED' });
    await assertSafePostgres('dopo la verifica rossa');
    const got = await svc!.get(objectPath(P, 'c', name));
    await svc!.delete(objectPath(P, 'c', name), { ifMatch: got.etag as string });
  });

  test('4. kill prima di ogni passo fino al punto di non ritorno: l\'annullamento torna sempre a postgres con la policy shadow', async () => {
    for (const step of ['preflight', 'freeze', 'quiesce', 'delta_apply', 'delta_verify', 'epoch']) {
      setTransitionTestHooks({
        beforeStep: (_kind, s) => {
          if (s !== step) return;
          setTransitionTestHooks(null);
          throw new Error(KILL);
        },
      });
      const { error } = await cutoverRun({ action: 'start' });
      assert.match(String((error as Error)?.message), new RegExp(KILL), `kill a ${step}`);
      const state = await backend();
      const frozen = CUTOVER_STEPS.indexOf(step as never) > CUTOVER_STEPS.indexOf('freeze');
      assert.equal(state.mode, frozen ? 'cutover' : 'postgres', `mode dopo il kill a ${step}`);
      assert.equal(await markerEpoch(), epochBefore, `marker invariato dopo il kill a ${step}`);
      if (frozen) {
        await waitFor(`policy frozen dopo il kill a ${step}`, async () => (await policyNow())?.mode === 'frozen');
        await sleep(PLUGIN_RELOAD_MS);
        assert.equal(await devicePut('c', `kill-${step}`), 403);
      }
      const active = await getActiveTransition(sql);
      assert.ok(active, `transizione attiva dopo il kill a ${step}`);
      const aborted = await cutoverRun({ action: 'abort' });
      assert.equal(aborted.error, null, String(aborted.error));
      assert.equal(aborted.summary?.outcome, 'aborted');
      await assertSafePostgres(`annullamento dopo il kill a ${step}`);
    }
  });

  test('5. cutover completo con un kill prima di ogni passo e la ripresa; prenotazione a cavallo del freeze', async () => {
    assert.ok(shape);
    const killed = new Set<string>();
    setTransitionTestHooks({
      beforeStep: (_kind, step) => {
        if (killed.has(step)) return;
        killed.add(step);
        throw new Error(KILL);
      },
    });
    let bookingUid: string | null = null;
    let summary: CutoverSummary | null = null;
    let runs = 0;
    let action: CutoverParams['action'] = 'start';
    try {
      for (; runs < 20 && !summary;) {
        runs += 1;
        const r = await cutoverRun({ action });
        if (r.summary) {
          summary = r.summary;
          break;
        }
        assert.match(String((r.error as Error)?.message), new RegExp(KILL), `run ${runs}: ${String((r.error as Error)?.message)}`);
        action = 'resume';
        const state = await backend();
        const transition = await getActiveTransition(sql);
        assert.ok(transition, `transizione attiva dopo il run ${runs}`);
        const journal = await readJournal(sql, transition.id);
        const epochDone = journal.some((j) => j.step === 'epoch' && j.status === 'done');
        if (epochDone) {
          assert.equal(state.mode, 'radicale');
          assert.equal(state.epoch, epochBefore + 1);
          assert.equal(await markerEpoch(), epochBefore + 1);
          const unfrozen = journal.some((j) => j.step === 'unfreeze' && j.status === 'done');
          assert.equal(state.write_freeze, !unfrozen, 'write_freeze fino al passo unfreeze');
        } else {
          assert.equal(state.epoch, epochBefore);
        }
        // Scritture dell'admin durante la transizione: 503 (transition in cutover, write_freeze dopo l'epoch).
        if (state.mode === 'cutover' || (state.mode === 'radicale' && state.write_freeze)) {
          const res = await adminCreate(`durante-${state.mode}-${runs}`);
          assert.equal(res.status, 503, `scrittura dell'admin in ${state.mode} (freeze ${state.write_freeze}): ${res.text}`);
          assert.equal(typeof res.json?.code, 'string');
        }
        // Prenotazione presa durante il freeze (mode cutover): busy legacy, proiezione in coda.
        if (!bookingUid && state.mode === 'cutover') {
          const start = new Date(Date.now() + 9 * DAY_MS);
          start.setUTCHours(14, 0, 0, 0);
          const created = await createBooking({
            event_type_id: shape.eventType.id,
            start: start.toISOString(),
            attendee: { name: fx.name('Cliente durante il passaggio'), email: fx.email('passaggio'), timezone: 'Europe/Rome' },
            source: 'admin_manual',
          });
          bookingUid = created.booking.uid;
          assert.equal(created.decision.store, 'postgres', 'in cutover il busy resta quello legacy');
          assert.equal(created.decision.projection, 'job');
        }
      }
    } finally {
      setTransitionTestHooks(null);
    }
    assert.ok(summary, 'cutover concluso');
    assert.equal(runs, CUTOVER_STEPS.length + 1, 'un kill prima di ogni passo, poi la ripresa che conclude');
    assert.equal(summary.outcome, 'completed');
    assert.deepEqual(summary.steps.filter((s) => s.step !== 'abort').map((s) => s.step), [...CUTOVER_STEPS]);
    for (const s of summary.steps) assert.equal(s.status, 'done', `${s.step}: ${s.error}`);
    assert.equal(summary.epoch_before, epochBefore);
    assert.equal(summary.epoch_after, epochBefore + 1);
    assert.ok(summary.smoke?.ok, `smoke: ${JSON.stringify(summary.smoke?.checks.filter((c) => !c.ok))}`);
    assert.ok(summary.bookings_reconciled >= 1, 'prenotazione a cavallo del freeze riaccodata');
    assert.equal(summary.verify?.acceptable, true);
    assert.equal(summary.delta?.failed, 0);
    assert.ok(summary.reverse && summary.reverse.objects > 0, `prima passata della proiezione inversa: ${JSON.stringify(summary.reverse)}`);
    const [{ owned }] = await sql`SELECT count(*)::int AS owned FROM calendar_events WHERE caldes_object_id IS NOT NULL`;
    assert.ok(owned > 0, 'righe legacy possedute dalla proiezione inversa');
    const [{ residue }] = await sql`SELECT count(*)::int AS residue FROM calendar_bookings WHERE attendee_email = ${SMOKE_ATTENDEE_EMAIL}`;
    assert.equal(residue, 0, 'nessuna prenotazione residua degli smoke');

    // Stato e identità.
    const state = await backend();
    assert.equal(state.mode, 'radicale');
    assert.equal(state.write_freeze, false);
    assert.equal(state.epoch, epochBefore + 1);
    assert.equal(state.api_min_version, CALENDAR_API_LEVEL);
    assert.equal(state.cutover_by, 'admin:test-apply');
    assert.ok(state.cutover_at && state.rollback_until);
    assert.ok(Math.abs(state.rollback_until.getTime() - state.cutover_at.getTime() - 30 * DAY_MS) < 5_000, 'finestra di rollback di 30 giorni');
    assert.equal(await markerEpoch(), epochBefore + 1);
    const [t] = await sql`SELECT status, epoch_after FROM cal_migration_transitions WHERE kind = 'cutover' ORDER BY started_at DESC LIMIT 1`;
    assert.deepEqual({ ...t }, { status: 'completed', epoch_after: epochBefore + 1 });

    // Policy live con il nuovo epoch: il device scrive su c, non su bookings (sola lettura) né su f.
    await waitFor('policy live con il nuovo epoch', async () => {
      const p = await policyNow();
      return p?.mode === 'live' && p.epoch === epochBefore + 1;
    });
    await waitFor('heartbeat radicale con il nuovo epoch', async () => {
      const hb = await readHeartbeatFile(heartbeatFile);
      return hb.state === 'ok' && hb.value.mode === 'radicale' && hb.value.epoch === epochBefore + 1;
    });
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await devicePut('c', 'dopo-il-passaggio'), 201, 'in live il device scrive');
    assert.equal(await devicePut('bookings', 'dopo-il-passaggio'), 403, 'Prenotazioni resta in sola lettura');
    assert.equal(await devicePut('f', 'dopo-il-passaggio'), 403, 'Festività resta in sola lettura');

    // Facade sullo store Radicale; guardia 166 su calendar_events.
    invalidateBackendModeCache();
    assert.equal((await calendarStore()).kind, 'radicale');
    await assert.rejects(
      sql`INSERT INTO calendar_events (calendar_id, uid, summary, start_time, end_time) VALUES (${shape.c.id}, ${`guardia-${randomUUID()}`}, 'x', now(), now() + interval '1 hour')`,
      (err: unknown) => (err as { code?: string }).code === 'CD166',
    );

    // Scrittura dell'admin dopo il passaggio: sullo store Radicale (oggetto nella collezione c).
    const written = await adminCreate('dopo il passaggio');
    assert.equal(written.status, 200, written.text);
    const createdId = (written.json as { event: { id: string } }).event.id;
    const [{ href }] = await sql`SELECT href FROM cal_object_ids WHERE id = ${createdId}::uuid`;
    const stored = await svc!.get(objectPath(P, 'c', href));
    assert.match(stored.body, /Admin dopo il passaggio/);

    // Proiezione della prenotazione presa durante il freeze.
    assert.ok(bookingUid);
    await runCalendarJobsOnce({ limit: 50 });
    const projection = await svc!.get(objectPath(P, 'bookings', `booking-${bookingUid}.ics`));
    assert.match(projection.body, /BEGIN:VEVENT/);
    log.info({ runs }, 'cutover completo con i kill');
  });

  test('6. contratti in mode radicale: sito, feed con lo stesso token, MCP in lettura e scrittura', async () => {
    assert.ok(shape);
    // Slot del sito.
    const from = new Date(Date.now() + 2 * DAY_MS).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 8 * DAY_MS).toISOString().slice(0, 10);
    const slots = await api.get(`/api/calendar/event-types/${shape.eventType.slug}/slots`, { query: { from, to } });
    assert.equal(slots.status, 200, slots.text);
    assert.equal(typeof slots.json, 'object');
    // Feed con il token di sempre.
    const feeds = await sql<Array<{ slug: string; token: string }>>`
      SELECT slug, ics_feed_token AS token FROM calendars WHERE ics_feed_enabled AND role <> 'subscription' AND origin <> 'migration' ORDER BY slug
    `;
    assert.ok(feeds.length >= 4);
    for (const f of feeds) {
      const res = await api.get(`/api/calendar/feed/${f.token}.ics`);
      assert.equal(res.status, 200, `feed ${f.slug}`);
      assert.match(res.text, /BEGIN:VCALENDAR/);
      assert.ok(res.headers.get('etag'), `ETag del feed ${f.slug} dallo store Radicale`);
    }
    // MCP: lettura e scrittura sullo store Radicale.
    const list = JSON.parse(await executeTool('list_events', { from: new Date().toISOString(), to: new Date(Date.now() + 30 * DAY_MS).toISOString() }));
    assert.equal(list.error, undefined, JSON.stringify(list));
    const created = JSON.parse(await executeTool('create_event', {
      calendar: 'c', summary: fx.name('Da MCP dopo il passaggio'), start: '2027-03-02T09:00:00Z', end: '2027-03-02T10:00:00Z',
    }));
    assert.equal(created.error, undefined, JSON.stringify(created));
    const listing = await svc!.propfind(`/${P}/c/`, { depth: 1 });
    assert.ok(listing.responses.length > 2, 'oggetti nella collezione c');
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM cal_objects o JOIN calendars c ON c.id = o.calendar_id WHERE c.slug = 'c'`;
    assert.ok(n >= 1, 'indice della collezione c popolato');
    await closeActiveRuns();
  });
});
