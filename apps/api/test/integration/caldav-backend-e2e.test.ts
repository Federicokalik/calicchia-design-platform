/**
 * End-to-end del login dei device (fase F1, piano T7; contratto
 * control-plane §9): Radicale 3.7.8 reale con il plugin caldes_auth che
 * chiama la route REALE POST /api/caldav-backend/verify-credentials
 * dell'API, servita su una porta effimera con @hono/node-server come in
 * produzione (stesso app di src/app.ts, stesso database dei test).
 *
 * Prova il criterio di uscita della F1 dal lato dell'autenticazione:
 *  - un'app-password creata dall'admin con uno username storico ('iphone')
 *    autentica in Radicale come il principal canonico 'federico';
 *  - l'IP del device (X-Remote-Addr di CloudPanel → X-Forwarded-For del
 *    plugin) arriva in last_used_ip;
 *  - password errata e username riservati → 401;
 *  - revoca dall'admin: finché la policy porta il vecchio credential_epoch la
 *    cache di 60 s del plugin accetta ancora la password; con la policy
 *    riscritta dallo stato (policyFromState, credential_epoch + 1) il plugin
 *    svuota le cache e la richiesta successiva riceve 401.
 *
 * I permessi qui sono quelli di default del harness (owner_only): la matrice
 * dei permessi di caldes_rights ha i propri test. La policy la scrive il test
 * con le funzioni pure del contratto (policyFromState + serializeControlFile),
 * le stesse del writer dell'API.
 *
 * Gira solo con Radicale disponibile (RADICALE_BIN o `radicale` nel PATH).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { serve, type ServerType } from '@hono/node-server';
import { TEST_ENV } from '../helpers/env';
import { sql } from '../helpers/db';
import { api } from '../helpers/http';
import { useFixtures } from '../helpers/fixtures';
import {
  DAV_PROPS,
  NS,
  RADICALE_PLUGINS_DIR,
  radicaleAvailability,
  TEST_PRINCIPAL,
  useRadicale,
  xmlChild,
} from '../helpers/radicale';
import { app } from '../../src/app';
import {
  normalizeBackendState,
  policyFromState,
  serializeControlFile,
} from '../../src/lib/calendar/radicale/types';

// Principal canonico del contratto: una variabile rimasta nella shell non
// deve cambiare l'esito.
delete process.env.RADICALE_PRINCIPAL;

const radicale = radicaleAvailability();
const fx = useFixtures('e2e-caldav-backend', { resetBaseline: true });

const SVC_PASSWORD = 'test-only-svc-password-e2e';
const PROBE_PASSWORD = 'test-only-probe-password-e2e';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Regressione: con la richiesta "Connection: close" l'API Node risponde con
 * "Connection: close" e Content-Length; http.client passa allora il socket
 * alla risposta, che lo chiude appena letto il corpo. Il ciclo di lettura del
 * plugin deve fermarsi lì (post_verify_credentials: `while not
 * response.isclosed()`), altrimenti ogni login di un device risponde 500.
 * Il mock di verify-credentials ora manda lo stesso header, e test_auth.py
 * prova ogni framing HTTP; questa suite lo verifica contro la route reale.
 */
describe('caldes_auth reale contro la route verify-credentials reale', { skip: radicale.skip }, () => {
  let controlDir = '';
  let server: ServerType | null = null;
  let backendUrl = '';

  /** Riscrive policy.json dallo stato in PG, come il writer dell'API (scrittura atomica). */
  async function writePolicyFromState(): Promise<number> {
    const [row] = await sql<Array<Record<string, unknown>>>`
      SELECT mode, write_freeze, volume_id, epoch, credential_epoch, policy_version, restore_guard_until, rebuild_required
      FROM calendar_backend_state WHERE id
    `;
    const state = normalizeBackendState(row);
    const policy = policyFromState({ state, identity: 'uninitialized', collections: [], principal: TEST_PRINCIPAL, now: new Date() });
    const path = join(controlDir, 'policy.json');
    const tmp = join(controlDir, `.policy.json.${process.pid}.tmp`);
    writeFileSync(tmp, serializeControlFile(policy), { mode: 0o644 });
    renameSync(tmp, path);
    return state.credential_epoch;
  }

  // Registrato prima di useRadicale: API e policy esistono quando il plugin parte.
  before(async () => {
    controlDir = mkdtempSync(join(tmpdir(), 'caldes-e2e-auth-'));
    // Policy provvisoria valida (epoch 0): quella dallo stato si scrive nei
    // test, dopo che useTestDatabase ha applicato le migrazioni.
    writeFileSync(join(controlDir, 'policy.json'), `${JSON.stringify({
      schema: 1, version: 1, generated_at: new Date().toISOString(), backend_mode: 'postgres', mode: 'shadow',
      reasons: [], principal: TEST_PRINCIPAL, volume_id: null, epoch: 0, credential_epoch: 0,
      readonly: [], hidden: ['_canary'],
    }, null, 2)}\n`, { mode: 0o644 });
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    backendUrl = `http://127.0.0.1:${port}/api/caldav-backend`;
  });
  after(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (controlDir) rmSync(controlDir, { recursive: true, force: true });
  });

  const rad = useRadicale(() => ({
    label: 'caldes-auth-api-reale',
    auth: {
      type: 'plugin',
      module: 'caldes_auth',
      pythonPath: [RADICALE_PLUGINS_DIR],
      env: {
        RADICALE_PRINCIPAL: TEST_PRINCIPAL,
        CALDAV_BACKEND_URL: backendUrl,
        CALDAV_SERVICE_TOKEN: TEST_ENV.CALDAV_SERVICE_TOKEN,
        CALDES_SVC_CIDR: '127.0.0.2/32',
        CALDES_SVC_PASSWORD_SHA256: sha256(SVC_PASSWORD),
        CALDES_PROBE_PASSWORD_SHA256: sha256(PROBE_PASSWORD),
        CALDES_AUTHCACHE_KEY: 'test-only-authcache-key-e2e-0123456789abcdef',
        CALDES_AUTHCACHE_DIR: join(controlDir, 'authcache'),
        CALDES_POLICY_FILE: join(controlDir, 'policy.json'),
      },
    },
  }));

  test('app-password storica (username iphone) creata dall\'admin → utente federico; IP del device in last_used_ip', async () => {
    await writePolicyFromState();
    const created = await api.post('/api/caldav-tokens', {
      auth: 'admin',
      body: { username: 'iphone', device_name: fx.name('iPhone e2e') },
    });
    assert.equal(created.status, 201, created.text);
    fx.track('appPasswordIds', created.json.id);

    const client = rad.server.client('iphone', created.json.password).withHeaders({ 'X-Remote-Addr': '203.0.113.80' });
    const res = await client.propfind('/', { props: [DAV_PROPS.currentUserPrincipal] });
    assert.equal(res.status, 207, res.text);
    const href = res.multistatus().responses[0].element(DAV_PROPS.currentUserPrincipal);
    assert.equal(href && xmlChild(href, NS.DAV, 'href')?.text, `/${TEST_PRINCIPAL}/`);
    assert.match(rad.server.logs(), /Successful login: 'iphone' -> 'federico'/);
    assert.ok(!rad.server.logs().includes(created.json.password), 'mai la password nei log');

    const [row] = await sql<Array<{ last_used_ip: string | null; usage_count: number }>>`
      SELECT last_used_ip, usage_count FROM caldav_app_passwords WHERE id = ${created.json.id}
    `;
    assert.deepEqual(row, { last_used_ip: '203.0.113.80', usage_count: 1 });

    // Le richieste successive usano la cache di 60 s del plugin.
    assert.equal((await client.propfind('/')).status, 207);
    const [again] = await sql<Array<{ usage_count: number }>>`SELECT usage_count FROM caldav_app_passwords WHERE id = ${created.json.id}`;
    assert.equal(again.usage_count, 1);
  });

  test('password errata e username riservati → 401', async () => {
    await writePolicyFromState();
    const { password } = await fx.appPassword({ device: 'Mac e2e' });
    assert.equal((await rad.server.client('federico', '0'.repeat(32)).propfind('/')).status, 401);
    // Riservati: il plugin non li manda mai al backend; da 127.0.0.1 caldes-svc
    // non è ammesso nemmeno con la password giusta.
    assert.equal((await rad.server.client('caldes-svc', SVC_PASSWORD).propfind('/')).status, 401);
    assert.equal((await rad.server.client('caldes-altro', password).propfind('/')).status, 401);
    assert.equal((await rad.server.client('federico', password).propfind('/')).status, 207);
  });

  test('revoca dall\'admin: la policy con il nuovo credential_epoch chiude subito anche la cache del plugin', async () => {
    const epochBefore = await writePolicyFromState();
    const { password, row } = await fx.appPassword({ device: 'DAVx5 e2e' });
    const client = rad.server.client('federico', password);
    assert.equal((await client.propfind('/')).status, 207, 'prima della revoca');

    const revoked = await api.delete(`/api/caldav-tokens/${row.id}`, { auth: 'admin' });
    assert.equal(revoked.status, 200, revoked.text);

    // Senza la policy nuova il plugin non sa della revoca: la cache in memoria
    // (60 s) accetta ancora la password. È il motivo di credential_epoch.
    assert.equal((await client.propfind('/')).status, 207, 'cache del plugin con il vecchio epoch');

    const epochAfter = await writePolicyFromState();
    assert.equal(epochAfter, epochBefore + 1, 'la revoca incrementa credential_epoch');
    // Il plugin ricontrolla la policy al massimo una volta al secondo.
    await sleep(1_100);
    assert.equal((await client.propfind('/')).status, 401, 'dopo il cambio di epoch la password revocata è rifiutata');
    assert.match(rad.server.logs(), /credential_epoch_changed/);
  });
});
