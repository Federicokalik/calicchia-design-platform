/**
 * End-to-end del criterio di uscita della fase F1 (piano F1; contratto
 * docs/calendar-radicale/contracts/control-plane.md §10): tutti i pezzi reali
 * insieme, in locale.
 *
 *  - Radicale 3.7.8 con il config di PRODUZIONE del repository
 *    (apps/radicale/config/config) e i plugin del repository
 *    (PYTHONPATH=apps/radicale/plugins: caldes_auth, caldes_rights,
 *    sitecustomize con caldes_vobject_fix). Del config cambiano solo i
 *    percorsi e l'indirizzo d'ascolto (vedi productionConfig()): auth con
 *    delay = 1, delay_on_error = 0, permessi, storage e logging restano quelli
 *    che girano in produzione;
 *  - verify-credentials servito dall'API VERA (src/app.ts con
 *    @hono/node-server su una porta effimera, stesso database dei test), con
 *    app-password create come oggi dall'admin o dalla libreria;
 *  - caldes_control scritto dal control-plane dell'API avviato come in
 *    produzione (startCalendarControlPlane con le variabili del contratto
 *    §1.3: policy.json da calendar_backend_state, heartbeat.json, identità
 *    del volume dal mount, LISTEN del NOTIFY della 162);
 *  - inizializzazione con lo script di F1 (scripts/radicale-init.ts, prova a
 *    vuoto e --apply) come caldes-svc dal peer della rete caldav-int;
 *  - healthcheck dell'immagine (caldes_healthcheck.py) come caldes-probe.
 *
 * Rete simulata sul loopback /8 (Linux): 127.0.0.2 è l'API sulla rete
 * interna caldav-int (CALDES_SVC_CIDR), 127.0.0.3 il gateway di app-net da cui
 * arriva il traffico pubblicato (CloudPanel, cioè internet), 127.0.0.1 il
 * loopback del container (solo il probe).
 *
 * Verifica, in ordine:
 *  1. avvio: policy shadow senza volume e heartbeat scritti dall'API,
 *     healthcheck 207;
 *  2. login di caldes-svc (e caldes-probe) da un peer non interno → 401
 *     anche con la password giusta e un header contraffatto;
 *  3. volume vuoto: un'app-password esistente con username 'iphone'
 *     autentica come federico, ma sotto /federico/ riceve 403 e non si crea
 *     nessuna directory;
 *  4. inizializzazione: marker sul principal, stato in PG, policy riscritta
 *     dal NOTIFY senza giri manuali;
 *  5. /federico/ in sola lettura per l'app-password 'iphone' e per una
 *     creata dall'admin con lo username canonico;
 *  6. heartbeat scaduto (API ferma da oltre 10 minuti) → frozen: con la
 *     policy live le scritture tornano 403 finché l'API non riparte;
 *  7. marker diverso sul volume → 403 e policy frozen; ripristino;
 *  8. revoca dall'admin: credential_epoch + 1, NOTIFY, policy riscritta, il
 *     plugin rifiuta la password anche se era in cache.
 *
 * Lo stato del backend torna alla baseline a fine file. Gira solo con
 * Radicale e Python disponibili (RADICALE_BIN); i passi che richiedono
 * 127.0.0.2/127.0.0.3 come indirizzi sorgente vengono saltati con il motivo
 * dove non sono utilizzabili.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test, type TestContext } from 'node:test';
import { serve, type ServerType } from '@hono/node-server';
import { TEST_ENV } from '../helpers/env';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { api } from '../helpers/http';
import { useFixtures } from '../helpers/fixtures';
import {
  canBindLocalAddress,
  DAV_PROPS,
  NS,
  pythonAvailability,
  RADICALE_PLUGINS_DIR,
  radicaleAvailability,
  resolvePython,
  TEST_PRINCIPAL,
  useRadicale,
  xmlChild,
} from '../helpers/radicale';
import { app } from '../../src/app';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import {
  effectiveModeFromFiles,
  getCalendarControlPlane,
  readHeartbeatFile,
  requestControlPlaneSync,
  startCalendarControlPlane,
  stopCalendarControlPlane,
} from '../../src/lib/calendar/radicale/heartbeat';
import { readVolumeMarkerFromFile, writeVolumeMarker } from '../../src/lib/calendar/radicale/identity';
import { readBackendState, readPolicyFile, writeControlFileAtomic } from '../../src/lib/calendar/radicale/policy';
import { type CaldesPolicy, serializeControlFile } from '../../src/lib/calendar/radicale/types';
import { runRadicaleInit } from '../../scripts/radicale-init';

const radicale = radicaleAvailability();
const python = pythonAvailability();
const fx = useFixtures('e2e-f1', { resetBaseline: true });
onBeforeDatabaseClose(() => resetCalendarBaseline());

const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f1-e2e';
const PROBE_PASSWORD = 'test-only-probe-password-f1-e2e';
const AUTHCACHE_KEY = 'test-only-authcache-key-f1-e2e-0123456789abcdef';
/** API sulla rete interna caldav-int: l'unico peer ammesso per caldes-svc. */
const SVC_PEER = '127.0.0.2';
/** Gateway di app-net: da qui arriva tutto il traffico pubblicato (internet). */
const GATEWAY = '127.0.0.3';
/** Ricontrollo dei file di policy, heartbeat e props nei plugin: al massimo una volta al secondo. */
const PLUGIN_RELOAD_MS = 1_100;
const API_VERSION = 'sha-f1e2e00';

const PRODUCTION_CONFIG = join(RADICALE_PLUGINS_DIR, '..', 'config', 'config');
const HEALTHCHECK = join(RADICALE_PLUGINS_DIR, 'caldes_healthcheck.py');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chiavi del config di produzione che dipendono dall'ambiente: le uniche sostituite. */
function productionOverrides(paths: { storageDir: string; policyFile: string; heartbeatFile: string }): Record<string, Record<string, string>> {
  return {
    // Porta scelta dal sistema (il harness la legge dal log), solo loopback.
    server: { hosts: '127.0.0.1:0' },
    storage: { filesystem_folder: paths.storageDir },
    rights: { caldes_policy_file: paths.policyFile, caldes_heartbeat_file: paths.heartbeatFile },
  };
}

/**
 * apps/radicale/config/config con i soli percorsi dell'ambiente sostituiti.
 * Lancia se una delle chiavi attese manca: il test deve accorgersi di un
 * config di produzione cambiato di forma, non girare su uno diverso.
 */
function productionConfig(paths: { storageDir: string; policyFile: string; heartbeatFile: string }): string {
  const overrides = productionOverrides(paths);
  const seen = new Set<string>();
  let section = '';
  const lines = readFileSync(PRODUCTION_CONFIG, 'utf8').split('\n').map((line) => {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1];
      return line;
    }
    const entry = /^([A-Za-z0-9_]+)\s*=/.exec(line);
    const value = entry ? overrides[section]?.[entry[1]] : undefined;
    if (!entry || value === undefined) return line;
    const key = `${section}.${entry[1]}`;
    if (seen.has(key)) throw new Error(`chiave ripetuta nel config di produzione: ${key}`);
    seen.add(key);
    return `${entry[1]} = ${value}`;
  });
  const missing = Object.entries(overrides).flatMap(([s, values]) => Object.keys(values).map((k) => `${s}.${k}`)).filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`config di produzione senza le chiavi attese: ${missing.join(', ')}`);
  return lines.join('\n');
}

/** Evento iCalendar minimo con date fisse (2027). */
function eventIcs(uid: string, summary = 'Evento e2e F1'): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Caldes//Test e2e F1//IT', 'BEGIN:VEVENT',
    `UID:${uid}`, 'DTSTAMP:20270101T000000Z', 'DTSTART:20270111T090000Z', 'DTEND:20270111T100000Z', `SUMMARY:${summary}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

/** Eventi `caldes_event {json}` di un plugin in un testo di log di Radicale. */
function caldesEvents(text: string, plugin: string, event: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const at = line.indexOf('caldes_event ');
    if (at < 0) continue;
    try {
      const payload = JSON.parse(line.slice(at + 'caldes_event '.length)) as Record<string, unknown>;
      if (payload.plugin === plugin && payload.event === event) out.push(payload);
    } catch {
      // riga troncata o non JSON: non è un evento del contratto
    }
  }
  return out;
}

/** Attende che `probe` restituisca un valore vero (polling ogni 50 ms). */
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

describe('criterio di uscita F1: config e plugin reali, control-plane e verify-credentials dell\'API', {
  skip: radicale.skip || python.skip,
}, () => {
  let root = '';
  let controlDir = '';
  let policyFile = '';
  let heartbeatFile = '';
  let apiServer: ServerType | null = null;
  let backendUrl = '';
  let peersOk = false;
  let svc: RadicaleClient | null = null;
  /** App-password storica con username 'iphone' (creata prima della F1). */
  let iphone: { id: string; password: string } | null = null;
  /** App-password creata dall'admin dopo la F1, con lo username canonico. */
  let canonical: { id: string; password: string } | null = null;

  // Registrato prima di useRadicale: cartelle e API esistono quando Radicale parte.
  before(async () => {
    peersOk = (await canBindLocalAddress(SVC_PEER)) && (await canBindLocalAddress(GATEWAY));
    root = mkdtempSync(join(tmpdir(), 'caldes-f1-e2e-'));
    // Contratto §1.1: caldes_control 0755 (file 0644 dell'API), authcache 0700.
    controlDir = join(root, 'control');
    mkdirSync(controlDir, { mode: 0o755 });
    chmodSync(controlDir, 0o755);
    mkdirSync(join(root, 'authcache'), { mode: 0o700 });
    policyFile = join(controlDir, 'policy.json');
    heartbeatFile = join(controlDir, 'heartbeat.json');
    apiServer = await new Promise<ServerType>((resolve) => {
      const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(server));
    });
    backendUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}/api/caldav-backend`;
  });
  after(async () => {
    await stopCalendarControlPlane();
    svc?.close();
    if (apiServer) await new Promise<void>((resolve) => apiServer!.close(() => resolve()));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // Radicale parte senza policy, come al primo deploy (contratto §5.3).
  const rad = useRadicale(() => ({
    label: 'f1-e2e',
    // Solo per PYTHONPATH ed env: il config è quello di produzione.
    auth: { type: 'plugin', module: 'caldes_auth' },
    configText: ({ storageDir }) => productionConfig({ storageDir, policyFile, heartbeatFile }),
    pythonPath: [RADICALE_PLUGINS_DIR],
    env: {
      RADICALE_PRINCIPAL: P,
      CALDAV_BACKEND_URL: backendUrl,
      CALDAV_SERVICE_TOKEN: TEST_ENV.CALDAV_SERVICE_TOKEN,
      CALDES_SVC_CIDR: `${SVC_PEER}/32`,
      CALDES_SVC_PASSWORD_SHA256: sha256(SVC_PASSWORD),
      CALDES_PROBE_PASSWORD_SHA256: sha256(PROBE_PASSWORD),
      CALDES_AUTHCACHE_KEY: AUTHCACHE_KEY,
      CALDES_AUTHCACHE_DIR: join(root, 'authcache'),
      CALDES_POLICY_FILE: policyFile,
      TAKE_FILE_OWNERSHIP: 'false',
    },
  }));

  /** Variabili del control-plane dell'API (contratto §1.3), come nel compose. */
  const controlPlaneEnv = (): NodeJS.ProcessEnv => ({
    CALDES_CONTROL_PLANE: 'on',
    CALDES_POLICY_FILE: policyFile,
    CALDES_HEARTBEAT_FILE: heartbeatFile,
    RADICALE_PRINCIPAL: P,
    RADICALE_DATA_DIR: rad.server.storageDir,
    CALDES_IDENTITY_SOURCE: 'file',
    CALDES_API_VERSION: API_VERSION,
  });

  before(async () => {
    const cp = await startCalendarControlPlane(controlPlaneEnv());
    assert.ok(cp, 'control-plane non avviato');
    svc = new RadicaleClient({ baseUrl: rad.server.url, password: SVC_PASSWORD, localAddress: SVC_PEER, timeoutMs: 10_000 });
  });

  const requirePeers = (t: TestContext): boolean => {
    if (!peersOk) t.skip('127.0.0.2/127.0.0.3 non utilizzabili come indirizzi sorgente');
    return peersOk;
  };
  /** Device da internet: dal gateway, con l'IP vero nell'X-Remote-Addr di CloudPanel. */
  const device = (who: { password: string }, username: string, ip: string) =>
    rad.server.client(username, who.password).fromAddress(GATEWAY).withHeaders({ 'X-Remote-Addr': ip });
  const policyNow = async (): Promise<CaldesPolicy | null> => {
    const read = await readPolicyFile(policyFile, P);
    return read.state === 'ok' ? read.value : null;
  };
  const files = () => ({ policyFile, heartbeatFile, principal: P });

  test('il config usato è quello di produzione, con i soli percorsi sostituiti', () => {
    const original = readFileSync(PRODUCTION_CONFIG, 'utf8').split('\n');
    const used = readFileSync(rad.server.configPath, 'utf8').split('\n');
    assert.equal(used.length, original.length);
    const changed = original.map((line, i) => (line === used[i] ? null : line.split('=')[0].trim())).filter(Boolean);
    assert.deepEqual(changed.sort(), ['caldes_heartbeat_file', 'caldes_policy_file', 'filesystem_folder', 'hosts']);
    for (const key of ['type = caldes_auth', 'type = caldes_rights', 'delay = 1', 'delay_on_error = 0', 'permit_delete_collection = False', 'predefined_collections = {}']) {
      assert.ok(used.includes(key), `manca "${key}"`);
    }
  });

  test('avvio: policy shadow senza volume e heartbeat scritti dal control-plane dell\'API; healthcheck del probe 207', async () => {
    const tick = await requestControlPlaneSync();
    assert.ok(tick?.ok, tick?.error ?? 'nessun giro');
    assert.equal(tick.identity?.status, 'uninitialized');
    const policy = await policyNow();
    assert.ok(policy, 'policy.json valida');
    assert.deepEqual(
      { backend_mode: policy.backend_mode, mode: policy.mode, reasons: policy.reasons, volume_id: policy.volume_id, epoch: policy.epoch, readonly: policy.readonly, hidden: policy.hidden },
      { backend_mode: 'postgres', mode: 'shadow', reasons: [], volume_id: null, epoch: 0, readonly: ['bookings', 'scadenze'], hidden: ['_canary'] },
    );
    const heartbeat = await readHeartbeatFile(heartbeatFile);
    assert.ok(heartbeat.state === 'ok');
    assert.deepEqual({ mode: heartbeat.value.mode, epoch: heartbeat.value.epoch, api_version: heartbeat.value.api_version }, { mode: 'postgres', epoch: 0, api_version: API_VERSION });
    for (const file of [policyFile, heartbeatFile]) assert.equal(statSync(file).mode & 0o777, 0o644, file);
    assert.equal(getCalendarControlPlane()?.status().listening, true, 'LISTEN calendar_policy_changed attivo');

    // HEALTHCHECK dell'immagine: PROPFIND Depth:0 sulla root come caldes-probe da 127.0.0.1.
    const healthcheck = (password: string) => spawnSync(resolvePython(), ['-I', HEALTHCHECK], {
      env: { PATH: process.env.PATH ?? '', CALDES_PROBE_PASSWORD: password, CALDES_HEALTHCHECK_URL: `${rad.server.url}/` },
      encoding: 'utf8',
      timeout: 20_000,
    });
    const ok = healthcheck(PROBE_PASSWORD);
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    assert.notEqual(healthcheck('password-sbagliata').status, 0, 'probe con la password sbagliata → unhealthy');
  });

  test('login del servizio da un peer non interno → 401 anche con la password giusta; dal peer di caldav-int → 207', async (t) => {
    if (!requirePeers(t)) return;
    const svcAs = (address: string, headers: Record<string, string> = {}) =>
      rad.server.client('caldes-svc', SVC_PASSWORD).fromAddress(address).withHeaders(headers);
    assert.equal((await svcAs(SVC_PEER).propfind('/', { depth: 0 })).status, 207, 'caldes-svc dal peer della rete interna');
    const mark = rad.server.logMark();
    assert.equal((await svcAs(GATEWAY).propfind('/', { depth: 0 })).status, 401, 'da internet (gateway di app-net)');
    // Un header non conta mai: il peer si legge solo dal socket.
    assert.equal((await svcAs(GATEWAY, { 'X-Remote-Addr': SVC_PEER, 'X-Forwarded-For': SVC_PEER }).propfind('/', { depth: 0 })).status, 401);
    assert.equal((await svcAs('127.0.0.1').propfind('/', { depth: 0 })).status, 401, '127.0.0.1 vale solo per il probe');
    const probe = rad.server.client('caldes-probe', PROBE_PASSWORD).fromAddress(GATEWAY);
    assert.equal((await probe.propfind('/', { depth: 0 })).status, 401, 'il probe da internet');
    const denied = caldesEvents(rad.server.logsSince(mark), 'caldes_auth', 'reserved_denied');
    assert.equal(denied.length, 4);
    assert.ok(denied.every((e) => e.peer === GATEWAY || e.peer === '127.0.0.1'), JSON.stringify(denied));
    assert.ok(!rad.server.logs().includes(SVC_PASSWORD), 'mai la password nei log');
  });

  test('volume vuoto: app-password esistente con username "iphone" → utente federico, 403 sotto /federico/, nessuna directory creata', async (t) => {
    if (!requirePeers(t)) return;
    // App-password creata prima della F1 con uno username storico.
    const created = await fx.appPassword({ username: 'iphone', device: 'iPhone storico' });
    iphone = { id: created.row.id, password: created.password };
    const client = device(iphone, 'iphone', '203.0.113.41');

    const rootListing = await client.propfind('/', { depth: 0, props: [DAV_PROPS.currentUserPrincipal] });
    assert.equal(rootListing.status, 207, rootListing.describe());
    const href = rootListing.multistatus().responses[0].element(DAV_PROPS.currentUserPrincipal);
    assert.equal(href && xmlChild(href, NS.DAV, 'href')?.text, `/${P}/`, 'principal canonico, non /iphone/');
    assert.match(rad.server.logs(), /Successful login: 'iphone' -> 'federico'/);

    for (const depth of [0, 1] as const) assert.equal((await client.propfind(`/${P}/`, { depth })).status, 403, `PROPFIND Depth:${depth}`);
    assert.equal((await client.propfind('/iphone/', { depth: 0 })).status, 403);
    assert.equal((await client.mkcalendar(`/${P}/lavoro/`)).status, 403);
    assert.equal(existsSync(rad.server.fsPath(P)), false, 'nessuna auto-creazione del principal');
    assert.equal(existsSync(rad.server.fsPath('iphone')), false);

    const [row] = await sql<Array<{ last_used_ip: string | null }>>`SELECT last_used_ip FROM caldav_app_passwords WHERE id = ${iphone.id}`;
    assert.equal(row.last_used_ip, '203.0.113.41', 'IP del device da X-Remote-Addr, via X-Forwarded-For del plugin');
  });

  test('inizializzazione con lo script di F1: prova a vuoto, poi --apply; policy riscritta dal NOTIFY senza giri manuali', async (t) => {
    if (!requirePeers(t)) return;
    const dry = await runRadicaleInit({ db: sql, client: svc!, principal: P, apply: false });
    assert.equal(dry.action, 'initialize');
    assert.equal(dry.refused, null);
    assert.equal(dry.principal_exists, false);
    assert.equal(existsSync(rad.server.fsPath(P)), false, 'la prova a vuoto non crea nulla');

    const report = await runRadicaleInit({ db: sql, client: svc!, principal: P, apply: true });
    assert.equal(report.refused, null, report.refused?.message);
    assert.ok(report.result?.volume_id);
    const volumeId = report.result.volume_id;
    assert.deepEqual(report.result.collections.map((c) => [c.collectionName, c.status]).sort(), [
      ['bookings', 'created'], ['lavoro', 'created'], ['personale', 'created'], ['scadenze', 'created'],
    ]);
    const state = await readBackendState(sql);
    assert.deepEqual({ mode: state.mode, volume_id: state.volume_id, epoch: state.epoch }, { mode: 'postgres', volume_id: volumeId, epoch: 1 });
    assert.deepEqual(await readVolumeMarkerFromFile(rad.server.storageDir, P), { state: 'ok', marker: { volume_id: volumeId, epoch: 1 } });

    // Nessun syncNow: è il NOTIFY della 162 (UPDATE dello stato) a far riscrivere la policy.
    const policy = await waitFor('policy con il volume inizializzato', async () => {
      const p = await policyNow();
      return p && p.volume_id === volumeId && p.epoch === 1 ? p : null;
    });
    assert.equal(policy.mode, 'shadow');
    assert.deepEqual(policy.reasons, []);
    await waitFor('heartbeat con epoch 1', async () => {
      const hb = await readHeartbeatFile(heartbeatFile);
      return hb.state === 'ok' && hb.value.epoch === 1;
    });

    // Rieseguito: già inizializzato, identità ok → solo collezioni mancanti (nessuna).
    const again = await runRadicaleInit({ db: sql, client: svc!, principal: P, apply: true });
    assert.equal(again.action, 'create_missing_collections');
    assert.ok(again.result?.collections.every((c) => c.status === 'exists'));
  });

  test('dopo l\'inizializzazione: /federico/ in sola lettura per "iphone" e per un\'app-password creata dall\'admin', async (t) => {
    if (!requirePeers(t)) return;
    assert.ok(iphone, 'app-password iphone del passo precedente');
    const created = await api.post('/api/caldav-tokens', { auth: 'admin', body: { device_name: fx.name('Mac e2e') } });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.username, P, 'username di default = principal canonico');
    fx.track('appPasswordIds', created.json.id);
    canonical = { id: created.json.id, password: created.json.password };
    await sleep(PLUGIN_RELOAD_MS);

    // Il servizio scrive (nessun controllo di modalità per caldes-svc), i device leggono.
    await svc!.put(objectPath(P, 'lavoro', 'dal-servizio.ics'), eventIcs('tst-e2e-f1-servizio@caldes.test'), { ifNoneMatch: '*' });
    for (const [who, username] of [[iphone, 'iphone'], [canonical, P]] as const) {
      const client = device(who, username, '203.0.113.42');
      const listing = await client.propfind(`/${P}/`, { depth: 1 });
      assert.equal(listing.status, 207, `${username}: ${listing.describe()}`);
      const names = listing.multistatus().paths().map((p) => p.split('/').filter(Boolean)[1]).filter(Boolean).sort();
      assert.deepEqual(names, ['bookings', 'lavoro', 'personale', 'scadenze'], username);
      assert.equal((await client.get(`/${P}/lavoro/dal-servizio.ics`)).status, 200, `${username} legge`);
    }

    const client = device(iphone, 'iphone', '203.0.113.42');
    assert.equal((await client.put(`/${P}/lavoro/dal-device.ics`, eventIcs('tst-e2e-f1-device@caldes.test'), { ifNoneMatch: '*' })).status, 403, 'shadow: PUT');
    assert.equal((await client.put(`/${P}/bookings/dal-device.ics`, eventIcs('tst-e2e-f1-device-b@caldes.test'), { ifNoneMatch: '*' })).status, 403);
    assert.equal((await client.delete(`/${P}/lavoro/dal-servizio.ics`)).status, 403, 'shadow: DELETE di un item');
    assert.equal((await client.mkcalendar(`/${P}/nuovo-dal-telefono/`)).status, 403, 'shadow: MKCALENDAR');
    assert.equal((await client.delete(`/${P}/lavoro/`)).status, 403, 'DELETE della collezione');
    assert.equal(
      (await client.proppatch(`/${P}/`, { set: [{ ns: NS.CALDES, name: 'epoch', value: '9' }] })).status,
      403,
      'il marker sul principal non è modificabile dai device',
    );
    assert.equal(existsSync(rad.server.fsPath(P, 'nuovo-dal-telefono')), false);
  });

  test('heartbeat scaduto (API ferma da oltre 10 minuti) → frozen: con la policy live le scritture tornano 403', async (t) => {
    if (!requirePeers(t)) return;
    assert.ok(iphone);
    const client = device(iphone, 'iphone', '203.0.113.43');
    // Policy live solo per provare il gate: in F1 il backend resta postgres, lo
    // stato torna così alla fine del test (e alla baseline a fine file).
    await sql`UPDATE calendar_backend_state SET mode = 'radicale' WHERE id`;
    try {
      await waitFor('policy live', async () => (await policyNow())?.mode === 'live');
      await waitFor('heartbeat del backend radicale', async () => {
        const hb = await readHeartbeatFile(heartbeatFile);
        return hb.state === 'ok' && hb.value.mode === 'radicale';
      });
      await sleep(PLUGIN_RELOAD_MS);
      assert.equal((await client.put(`/${P}/lavoro/live-1.ics`, eventIcs('tst-e2e-f1-live-1@caldes.test'), { ifNoneMatch: '*' })).status, 201, 'live: PUT ammessa');
      assert.equal((await client.put(`/${P}/bookings/live-1.ics`, eventIcs('tst-e2e-f1-live-b@caldes.test'), { ifNoneMatch: '*' })).status, 403, 'bookings resta in sola lettura');

      // API ferma: niente più heartbeat. Quello sul volume ha 11 minuti.
      await stopCalendarControlPlane();
      const state = await readBackendState(sql);
      await writeControlFileAtomic(heartbeatFile, serializeControlFile({
        schema: 1, api_version: API_VERSION, mode: state.mode, epoch: state.epoch, ts: new Date(Date.now() - 11 * 60_000).toISOString(),
      }));
      const effective = await effectiveModeFromFiles(files());
      assert.equal(effective.mode, 'frozen');
      assert.deepEqual(effective.reasons, ['heartbeat_stale']);
      await sleep(PLUGIN_RELOAD_MS);
      const mark = rad.server.logMark();
      assert.equal((await client.put(`/${P}/lavoro/frozen.ics`, eventIcs('tst-e2e-f1-frozen@caldes.test'), { ifNoneMatch: '*' })).status, 403, 'frozen: PUT negata');
      assert.equal((await client.get(`/${P}/lavoro/live-1.ics`)).status, 200, 'frozen: lettura ammessa');
      const changed = caldesEvents(rad.server.logsSince(mark), 'caldes_rights', 'effective_mode_changed');
      assert.ok(changed.some((e) => e.mode === 'frozen' && Array.isArray(e.reasons) && e.reasons.includes('heartbeat_stale')), JSON.stringify(changed));

      // L'API riparte: heartbeat fresco al primo giro, di nuovo live.
      assert.ok(await startCalendarControlPlane(controlPlaneEnv()));
      await waitFor('heartbeat fresco', async () => {
        const hb = await readHeartbeatFile(heartbeatFile);
        return hb.state === 'ok' && Date.now() - Date.parse(hb.value.ts) < 60_000;
      });
      await sleep(PLUGIN_RELOAD_MS);
      assert.equal((await client.put(`/${P}/lavoro/live-2.ics`, eventIcs('tst-e2e-f1-live-2@caldes.test'), { ifNoneMatch: '*' })).status, 201, 'di nuovo live');
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = 'postgres' WHERE id`;
      // Se il test si è fermato con l'API "ferma", i passi successivi ne hanno bisogno.
      if (!getCalendarControlPlane()) await startCalendarControlPlane(controlPlaneEnv());
    }
    await waitFor('policy di nuovo shadow', async () => (await policyNow())?.mode === 'shadow');
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal((await client.put(`/${P}/lavoro/shadow.ics`, eventIcs('tst-e2e-f1-shadow@caldes.test'), { ifNoneMatch: '*' })).status, 403, 'shadow: di nuovo sola lettura');
  });

  test('marker diverso sul volume → 403 e policy frozen identity_mismatch; marker ripristinato → di nuovo leggibile', async (t) => {
    if (!requirePeers(t)) return;
    assert.ok(iphone);
    const client = device(iphone, 'iphone', '203.0.113.44');
    const state = await readBackendState(sql);
    await writeVolumeMarker(svc!, P, { volume_id: state.volume_id as string, epoch: 2 });
    try {
      await sleep(PLUGIN_RELOAD_MS);
      assert.equal((await client.propfind(`/${P}/`, { depth: 0 })).status, 403, 'caldes_rights confronta marker e policy da solo');
      const tick = await requestControlPlaneSync();
      assert.equal(tick?.identity?.status, 'mismatch');
      assert.equal(tick?.policy?.mode, 'frozen');
      assert.deepEqual(tick?.policy?.reasons, ['identity_mismatch']);
    } finally {
      await writeVolumeMarker(svc!, P, { volume_id: state.volume_id as string, epoch: 1 });
    }
    const back = await requestControlPlaneSync();
    assert.equal(back?.identity?.status, 'ok');
    assert.equal(back?.policy?.mode, 'shadow');
    await sleep(PLUGIN_RELOAD_MS);
    assert.equal((await client.propfind(`/${P}/`, { depth: 0 })).status, 207);
  });

  test('revoca dall\'admin: credential_epoch + 1 → NOTIFY → policy riscritta → password rifiutata anche se in cache', async (t) => {
    if (!requirePeers(t)) return;
    assert.ok(iphone && canonical);
    const revoked = device(iphone, 'iphone', '203.0.113.45');
    const other = device(canonical, P, '203.0.113.46');
    assert.equal((await revoked.propfind('/', { depth: 0 })).status, 207, 'prima della revoca (ora in cache nel plugin)');
    const before = await policyNow();
    assert.ok(before);

    const res = await api.delete(`/api/caldav-tokens/${iphone.id}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    await waitFor('policy con il nuovo credential_epoch', async () => (await policyNow())?.credential_epoch === before.credential_epoch + 1);
    await sleep(PLUGIN_RELOAD_MS);

    const mark = rad.server.logMark();
    assert.equal((await revoked.propfind('/', { depth: 0 })).status, 401, 'password revocata');
    assert.ok(caldesEvents(rad.server.logs(), 'caldes_auth', 'credential_epoch_changed').length >= 1);
    // Le altre app-password restano valide (riverificate sull'API dopo lo svuotamento della cache).
    assert.equal((await other.propfind(`/${P}/`, { depth: 0 })).status, 207);
    assert.equal(caldesEvents(rad.server.logsSince(mark), 'caldes_auth', 'backend_error').length, 0);
  });
});
