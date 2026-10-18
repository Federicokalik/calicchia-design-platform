/**
 * Transizioni di stato della F4 contro Radicale 3.7.8 reale con il config e i
 * plugin di produzione (apps/api/src/lib/calendar/migration/transition.ts;
 * design §13.9-§13.12; contratto docs/calendar-radicale/contracts/
 * f4-modules.md §2). La parte senza Radicale è in test/calendar/
 * migration-transition.test.ts.
 *
 * Lo stack è quello di integration/device-emulation: caldes_auth con
 * verify-credentials simulato, caldes_rights con policy.json e heartbeat.json
 * scritti dal control-plane dell'API, volume inizializzato da caldes-svc dal
 * peer di caldav-int (127.0.0.2), device dal gateway della porta pubblicata
 * (127.0.0.3), probe da 127.0.0.1 (healthcheck).
 *
 * Casi (rollback da mode radicale con la policy live):
 *  1. una scrittura MCP partita prima del freeze attende il gate esclusivo e,
 *     appena lo stato è cambiato, riceve l'indisponibilità sul ramo {error}
 *     senza scrivere nulla su Radicale;
 *  2. prima del freeze la PUT del device riesce; dopo il passo di freeze e la
 *     quiescenza (PUT del probe su _canary con 403, stat stabile) la PUT del
 *     device risponde 403;
 *  3. un riavvio dell'API fra due passi (control-plane fermato e ripartito)
 *     non riporta la policy a live: il device resta in sola lettura e la
 *     transizione riprende dal passo successivo;
 *  4. passo d'epoch reale: PROPPATCH del marker a E+1, mode postgres, policy
 *     shadow con il nuovo epoch, device in lettura con l'identità verificata.
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
import { executeTool } from '../../src/lib/agent/tools';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { createCalendar } from '../../src/lib/calendar/calendars';
import {
  beginTransition,
  defaultQuiescenceDeps,
  epochStep,
  freezeStep,
  nextPendingStep,
  quiesceStep,
  readJournal,
  runStep,
  type TransitionContext,
  type TransitionHandle,
  withTransitionGate,
} from '../../src/lib/calendar/migration/transition';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import {
  effectiveModeFromFiles,
  getCalendarControlPlane,
  readHeartbeatFile,
  startCalendarControlPlane,
  stopCalendarControlPlane,
} from '../../src/lib/calendar/radicale/heartbeat';
import { initializeVolume, readVolumeMarkerRemote } from '../../src/lib/calendar/radicale/identity';
import { readPolicyFile } from '../../src/lib/calendar/radicale/policy';
import { configureRadicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import { PROBE_USER, type CaldesPolicy } from '../../src/lib/calendar/radicale/types';
import { logger } from '../../src/lib/logger';

const radicale = radicaleAvailability();
const python = pythonAvailability();
const fx = useFixtures('transition-rad', { resetBaseline: true });
onBeforeDatabaseClose(async () => {
  await stopCalendarControlPlane();
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});

const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f4-transition';
const PROBE_PASSWORD = 'test-only-probe-password-f4-transition';
const AUTHCACHE_KEY = 'test-only-authcache-key-f4-transition-0123456789abcdef';
const SVC_PEER = '127.0.0.2';
const GATEWAY = '127.0.0.3';
const PLUGIN_RELOAD_MS = 1_100;
const API_VERSION = 'sha-f4trans';
const PRODUCTION_CONFIG = join(RADICALE_PLUGINS_DIR, '..', 'config', 'config');
const DEVICE = { username: 'iphone', password: 'tst-app-password-f4-transition', ip: '203.0.113.40', userAgent: 'iOS/18.0 (22A3354) dataaccessd/1.0' };

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

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
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

function eventIcs(uid: string, summary: string): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iPhone OS 18.0//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261016T080000Z', 'DTSTART:20270210T090000Z', 'DTEND:20270210T100000Z', `SUMMARY:${summary}`, 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
}

describe('transizioni F4 con Radicale reale: gate, freeze, quiescenza, riavvio ed epoch', {
  skip: radicale.skip || python.skip || PEERS_SKIP || false,
}, () => {
  let root = '';
  let policyFile = '';
  let heartbeatFile = '';
  let svc: RadicaleClient | null = null;
  let probe: RadicaleClient | null = null;
  let volumeId = '';
  let handle: TransitionHandle | null = null;
  const log = logger.child({ scope: 'test-transition-rad' });
  const ctx = (): TransitionContext => ({ db: sql, runId: randomUUID(), actor: 'admin:test-transition-rad', log });

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'caldes-f4-transition-'));
    const controlDir = join(root, 'control');
    mkdirSync(controlDir, { mode: 0o755 });
    chmodSync(controlDir, 0o755);
    mkdirSync(join(root, 'authcache'), { mode: 0o700 });
    policyFile = join(controlDir, 'policy.json');
    heartbeatFile = join(controlDir, 'heartbeat.json');
  });
  after(async () => {
    await stopCalendarControlPlane();
    configureRadicaleRuntime(null);
    svc?.close();
    probe?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const verify = useMockVerify({ users: [{ username: DEVICE.username, password: DEVICE.password }] });
  const rad = useRadicale(() => ({
    label: 'f4-transition',
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
  const devicePut = async (name: string): Promise<number> =>
    (await device().put(`/${P}/c/${name}.ics`, eventIcs(`${name}@device.test`, `Dal telefono ${name}`), { ifNoneMatch: '*' })).status;
  const quiescenceDeps = () => ({ ...defaultQuiescenceDeps(), probe });

  before(async () => {
    // Calendario c come in produzione, creato in mode postgres.
    const c = await createCalendar({ slug: 'c', name: fx.name('Creattivamente SRL'), timezone: 'Europe/Rome', blocks_availability: true });
    fx.track('calendarIds', c.id);
    svc = new RadicaleClient({ baseUrl: rad.server.url, password: SVC_PASSWORD, localAddress: SVC_PEER, timeoutMs: 10_000 });
    probe = new RadicaleClient({ baseUrl: rad.server.url, username: PROBE_USER, password: PROBE_PASSWORD, timeoutMs: 5_000, retries: 0 });
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    volumeId = init.volumeId;
    assert.equal(init.canary, 'created');
    configureRadicaleRuntime({ client: svc, principal: P, dataDir: rad.server.storageDir, watch: 'off', identitySource: 'remote' });
    assert.ok(await startCalendarControlPlane(controlPlaneEnv()), 'control-plane non avviato');
    await waitFor('policy con il volume inizializzato', async () => (await policyNow())?.volume_id === volumeId);

    // Mode radicale con la policy live (come dopo un cutover).
    await sql`UPDATE calendar_backend_state SET mode = 'radicale', write_freeze = false WHERE id`;
    invalidateBackendModeCache();
    await waitFor('policy live', async () => (await policyNow())?.mode === 'live');
    await waitFor('heartbeat del backend radicale', async () => {
      const hb = await readHeartbeatFile(heartbeatFile);
      return hb.state === 'ok' && hb.value.mode === 'radicale';
    });
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await devicePut('prima-del-freeze'), 201, 'in live, prima della transizione, il device scrive');
  });

  test('1. scrittura MCP partita prima del freeze: attende il gate e riceve {error}, nessuna PUT su Radicale', async () => {
    const t = await beginTransition({ ctx: ctx(), kind: 'rollback' });
    handle = t.handle;
    await runStep(handle, 'preflight', async () => ({ test: true }));
    const before = (await svc!.propfind(`/${P}/c/`, { depth: 1 })).responses.length;
    // Gate esclusivo preso con lo stato ancora radicale (come una transizione che
    // svuota le scritture). La scrittura MCP parte fuori dal contesto del gate (la
    // rientranza vale solo nello stesso flusso asincrono).
    let releaseGate!: () => void;
    const hold = new Promise<void>((r) => { releaseGate = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const gate = withTransitionGate(async () => {
      entered();
      await hold;
    });
    await inside;
    const mcp = executeTool('create_event', {
      calendar: 'c', summary: fx.name('MCP durante il rollback'), start: '2027-02-11T09:00:00Z', end: '2027-02-11T10:00:00Z',
    });
    try {
      const pending = await Promise.race([mcp.then((v) => `settled:${v}`), sleep(400).then(() => 'pending')]);
      assert.equal(pending, 'pending', 'la scrittura MCP attende il gate esclusivo');
      // Lo stato cambia mentre MCP attende (il freeze non richiede il gate).
      await freezeStep(handle);
    } finally {
      releaseGate();
      await gate;
    }
    const response = JSON.parse(await mcp) as Record<string, unknown>;
    assert.ok(typeof response.error === 'string', JSON.stringify(response));
    assert.equal(response.code, undefined);
    const afterCount = (await svc!.propfind(`/${P}/c/`, { depth: 1 })).responses.length;
    assert.equal(afterCount, before, 'nessuna risorsa scritta su Radicale');
  });

  test('2. dopo il freeze e la quiescenza la PUT del device risponde 403 (prima riusciva)', async () => {
    assert.ok(handle);
    // Il freeze è del test 1 (prima del freeze la PUT del device riusciva: before()).
    const freeze = (await readJournal(sql, handle.record.id)).find((j) => j.step === 'freeze');
    assert.equal(freeze?.status, 'done');
    const report = await quiesceStep(handle, quiescenceDeps());
    assert.equal(report.probe.status, 403);
    assert.equal(report.policy.mode, 'frozen');
    assert.equal(report.stat.source, 'remote');
    const res = await device().put(`/${P}/c/dopo-freeze.ics`, eventIcs('dopo-freeze@device.test', 'Dopo il freeze'), { ifNoneMatch: '*' });
    assert.equal(res.status, 403, res.describe());
    assert.equal(res.headers.get('www-authenticate'), null, '403 senza challenge: il client non scarta la password');
    const read = await device().propfind(`/${P}/c/`, { depth: 0 });
    assert.equal(read.status, 207, 'la lettura resta ammessa');
  });

  test('3. riavvio dell\'API fra due passi: la policy resta frozen, il device resta in sola lettura, la transizione riprende', async () => {
    assert.ok(handle);
    await stopCalendarControlPlane();
    assert.equal(getCalendarControlPlane(), null);
    assert.ok(await startCalendarControlPlane(controlPlaneEnv()), 'control-plane non ripartito');
    await waitFor('primo giro del control-plane nuovo', async () => getCalendarControlPlane()?.status().lastSuccessAt);
    const policy = await policyNow();
    assert.deepEqual({ mode: policy?.mode, backend: policy?.backend_mode }, { mode: 'frozen', backend: 'rollback' });
    const effective = await effectiveModeFromFiles({ policyFile, heartbeatFile, principal: P });
    assert.equal(effective.mode, 'frozen');
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await devicePut('dopo-riavvio'), 403);

    const { handle: resumed, resumed: wasResumed } = await beginTransition({ ctx: ctx(), kind: 'rollback', resume: true });
    assert.equal(wasResumed, true);
    const journal = await readJournal(sql, resumed.record.id);
    assert.equal(nextPendingStep('rollback', journal), 'index_sync', 'freeze e quiescenza concluse non si ripetono');
    handle = resumed;
  });

  test('4. passo d\'epoch reale: marker E+1 su Radicale, mode postgres, policy shadow con il nuovo epoch', async () => {
    assert.ok(handle);
    for (const step of ['index_sync', 'reverse_final', 'rebaseline']) await runStep(handle, step, async () => ({ test: true }));
    const E = handle.record.epoch_before;
    const data = await epochStep(handle, { client: svc!, principal: P }, { set: { write_freeze: false, rollback_until: null } });
    assert.deepEqual({ before: data.epoch_before, after: data.epoch_after, mode: data.mode, marker: data.marker }, { before: E, after: E + 1, mode: 'postgres', marker: 'written' });
    const marker = await readVolumeMarkerRemote(svc!, P);
    assert.ok(marker.state === 'ok');
    assert.deepEqual(marker.marker, { volume_id: volumeId, epoch: E + 1 });
    const [state] = await sql`SELECT mode, epoch, write_freeze FROM calendar_backend_state WHERE id`;
    assert.deepEqual({ ...state }, { mode: 'postgres', epoch: E + 1, write_freeze: false });
    await waitFor('policy shadow con il nuovo epoch', async () => {
      const p = await policyNow();
      return p?.mode === 'shadow' && p.epoch === E + 1;
    });
    await waitFor('heartbeat con il nuovo epoch', async () => {
      const hb = await readHeartbeatFile(heartbeatFile);
      return hb.state === 'ok' && hb.value.epoch === E + 1 && hb.value.mode === 'postgres';
    });
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal(await devicePut('in-shadow'), 403, 'in postgres i device restano in sola lettura');
    const read = await device().propfind(`/${P}/c/`, { depth: 0 });
    assert.equal(read.status, 207, 'identità verificata con il nuovo epoch: lettura ammessa');
    // Il marker scritto da caldes-svc non è scrivibile dai device.
    const res = await device().request('PROPPATCH', `/${P}/`, {
      body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:K="urn:calicchia:caldes"><D:set><D:prop><K:epoch>99</K:epoch></D:prop></D:set></D:propertyupdate>',
    });
    assert.equal(res.status, 403);
    assert.equal(objectPath(P, 'c', 'x.ics'), `/${P}/c/x.ics`);
  });
});
