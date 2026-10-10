/**
 * Client CalDAV di servizio e control-plane dell'API contro Radicale (fase
 * F1, piano T6).
 *
 * Tre suite:
 *  1. "client con server simulato": errori tipizzati, retry solo dove
 *     idempotente, timeout, limite di connessioni e di dimensione, header e
 *     precondizioni, contro un server HTTP locale programmabile. Non richiede
 *     Radicale e gira sempre;
 *  2. "client contro Radicale reale": tutti i metodi (PROPFIND, PROPPATCH,
 *     MKCOL, MKCALENDAR, PUT con If-Match/If-None-Match, GET, DELETE, MOVE,
 *     REPORT calendar-query, multiget e sync-collection) e gli esiti 412, 409
 *     no-uid-conflict, 409, 403, 404 con un Radicale 3.7.8 avviato
 *     dall'harness di F0 (helpers/radicale.ts). Configurazione:
 *       - se nel working tree ci sono i plugin di F1 (apps/radicale/plugins/
 *         caldes_auth.py e caldes_rights.py) il server usa quelli, con
 *         caldes-svc ammesso solo dal peer 127.0.0.2 (CALDES_SVC_CIDR, la rete
 *         caldav-int dei test) e il client che si connette da lì
 *         (`localAddress`), come in produzione;
 *       - altrimenti (o se 127.0.0.2 non è utilizzabile come indirizzo
 *         sorgente) auth htpasswd con l'utente caldes-svc e rights from_file
 *         con la stessa matrice di caldes-svc del contratto §8 (R sulla root,
 *         RW sul principal, rwD sulle collezioni). La modalità scelta è
 *         riportata come diagnostica del primo test; con
 *         TEST_RADICALE_CLIENT_MODE=htpasswd si forza la seconda anche con i
 *         plugin presenti;
 *  3. "control-plane end-to-end con caldes_auth e caldes_rights" (solo con i
 *     plugin): policy e heartbeat scritti dall'API dallo stato nel database
 *     dei test, inizializzazione esplicita del volume (contratto §4.4) e
 *     risposte reali ai device: 403 senza identità e nessuna directory creata,
 *     207 in sola lettura dopo l'inizializzazione, heartbeat scaduto → frozen,
 *     marker diverso → 403 e policy frozen.
 *
 * Il database (TEST_DATABASE_URL) serve alle suite 2 e 3: lo stato del
 * backend torna alla baseline a fine file. Radicale gira in directory
 * temporanee rimosse allo stop. Date fisse nel 2027.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import {
  canBindLocalAddress,
  pythonAvailability,
  RADICALE_PLUGINS_DIR,
  radicaleAvailability,
  type StartRadicaleOptions,
  TEST_PRINCIPAL,
  useMockVerify,
  useRadicale,
} from '../helpers/radicale';
import {
  assertRequestPath,
  collectionPath,
  objectPath,
  principalPath,
  RadicaleClient,
  radicaleClientFromEnv,
} from '../../src/lib/calendar/radicale/client';
import { clark, DAV_PROPS, NS } from '../../src/lib/calendar/radicale/dav-xml';
import {
  RadicaleBadRequestError,
  RadicaleConfigError,
  RadicaleConflictError,
  type RadicaleError,
  RadicaleForbiddenError,
  RadicaleInvalidSyncTokenError,
  RadicaleNetworkError,
  RadicaleNotFoundError,
  RadicalePreconditionFailedError,
  RadicalePropPatchError,
  RadicaleProtocolError,
  RadicaleServerError,
  RadicaleTimeoutError,
  RadicaleUidConflictError,
  RadicaleUnauthorizedError,
} from '../../src/lib/calendar/radicale/errors';
import { CalendarControlPlane, effectiveModeFromFiles, readHeartbeatFile } from '../../src/lib/calendar/radicale/heartbeat';
import {
  checkVolumeIdentity,
  createMissingCollections,
  fileIdentitySource,
  initializeVolume,
  readVolumeMarkerFromFile,
  readVolumeMarkerRemote,
  remoteIdentitySource,
  VolumeInitError,
  writeVolumeMarker,
} from '../../src/lib/calendar/radicale/identity';
import { readBackendState, readPolicyFile, writeControlFileAtomic } from '../../src/lib/calendar/radicale/policy';
import { DEAD_PROP, principalPropsPath, serializeControlFile } from '../../src/lib/calendar/radicale/types';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(() => resetCalendarBaseline());

const radicale = radicaleAvailability();
const python = pythonAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f1-client';
const PROBE_PASSWORD = 'test-only-probe-password-f1-client';
const SVC_PEER = '127.0.0.2';
const REPO_PLUGINS = ['caldes_auth.py', 'caldes_rights.py'].every((f) => existsSync(join(RADICALE_PLUGINS_DIR, f)));
/** Forza la suite del client in modalità htpasswd + from_file anche con i plugin presenti. */
const FORCE_HTPASSWD = process.env.TEST_RADICALE_CLIENT_MODE === 'htpasswd';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Evento singolo UTC in un VCALENDAR minimo (CRLF, righe corte). */
function eventIcs(uid: string, start: string, end: string, summary = 'Evento di prova'): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Calicchia Design//Test client F1//IT',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T080000Z',
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** Esegue `fn` e restituisce l'errore lanciato (fallisce se non lancia). */
async function caught<T extends Error = RadicaleError>(fn: () => Promise<unknown>): Promise<T> {
  try {
    await fn();
  } catch (err) {
    return err as T;
  }
  assert.fail('la chiamata doveva fallire');
}

// ─── 1. Server simulato ───────────────────────────────

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
  remoteAddress: string | undefined;
}

type Responder = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

/** Server HTTP locale con risposte in coda (l'ultima si ripete) e registro delle richieste. */
class FakeDavServer {
  readonly requests: RecordedRequest[] = [];
  private responders: Responder[] = [];
  private server: Server | null = null;
  active = 0;
  maxActive = 0;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const recorded: RecordedRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          remoteAddress: req.socket.remoteAddress,
        };
        this.requests.push(recorded);
        this.active++;
        this.maxActive = Math.max(this.maxActive, this.active);
        res.on('close', () => this.active--);
        const responder = this.responders.length > 1 ? this.responders.shift() : this.responders[0];
        void Promise.resolve(responder ? responder(recorded, res) : reply(500, '')(recorded, res));
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  respond(...responders: Responder[]): void {
    this.responders = responders;
    this.requests.length = 0;
    this.maxActive = 0;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

function reply(status: number, body = '', headers: Record<string, string> = {}, delayMs = 0): Responder {
  return async (_req, res) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': body.startsWith('<') ? 'text/xml; charset=utf-8' : 'text/plain', ...headers });
    res.end(body);
  };
}

const davError = (inner: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${inner}</D:error>`;

const MULTISTATUS_ROOT = '<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:"><response><href>/</href>'
  + '<propstat><prop><current-user-principal><href>/caldes-svc/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat>'
  + '</response></multistatus>';

describe('client CalDAV con server simulato (errori, retry, timeout)', () => {
  const fake = new FakeDavServer();
  before(() => fake.start());
  after(() => fake.stop());
  const client = (opts: Partial<ConstructorParameters<typeof RadicaleClient>[0]> = {}): RadicaleClient =>
    new RadicaleClient({ baseUrl: fake.url, password: SVC_PASSWORD, retryBaseDelayMs: 5, ...opts });

  test('mappa gli status sugli errori tipizzati con condizione, metodo e percorso', async () => {
    const c = client();
    const path = '/federico/lavoro/a.ics';
    const cases: Array<[Responder, new (...args: never[]) => RadicaleError, string, string | null]> = [
      [reply(412), RadicalePreconditionFailedError, 'precondition_failed', null],
      [reply(409, davError('<C:no-uid-conflict/>')), RadicaleUidConflictError, 'uid_conflict', 'no-uid-conflict'],
      [reply(409, davError('<D:resource-must-be-null/>')), RadicaleConflictError, 'conflict', 'resource-must-be-null'],
      [reply(409), RadicaleConflictError, 'conflict', null],
      [reply(403, davError('<D:valid-sync-token/>')), RadicaleInvalidSyncTokenError, 'invalid_sync_token', 'valid-sync-token'],
      [reply(403), RadicaleForbiddenError, 'forbidden', null],
      [reply(404), RadicaleNotFoundError, 'not_found', null],
      [reply(401), RadicaleUnauthorizedError, 'unauthorized', null],
      [reply(400), RadicaleBadRequestError, 'bad_request', null],
      [reply(507), RadicaleServerError, 'server_error', null],
      [reply(301, '', { Location: '/altrove' }), RadicaleProtocolError, 'protocol', null],
    ];
    for (const [responder, cls, code, condition] of cases) {
      fake.respond(responder);
      const err = await caught(() => c.put(path, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { ifMatch: '"x"' }));
      assert.ok(err instanceof cls, `${code}: ${err.name}`);
      assert.equal(err.code, code);
      assert.equal(err.method, 'PUT');
      assert.equal(err.path, path);
      assert.equal(err.condition?.name ?? null, condition);
      assert.equal(fake.requests.length, 1, `${code}: le scritture non si ripetono`);
    }
    assert.ok(new RadicaleInvalidSyncTokenError({ method: 'REPORT', path }) instanceof RadicaleForbiddenError);
  });

  test('metodi sicuri: retry su 502/503/504 con backoff; 500 mai ripetuto', async () => {
    const c = client();
    fake.respond(reply(503), reply(502), reply(207, MULTISTATUS_ROOT));
    assert.equal(await c.currentUserPrincipal(), '/caldes-svc/');
    assert.equal(fake.requests.length, 3);

    fake.respond(reply(503));
    const exhausted = await caught(() => c.propfind('/'));
    assert.ok(exhausted instanceof RadicaleServerError);
    assert.equal(exhausted.attempts, 3);
    assert.equal(exhausted.outcomeUnknown, false, 'una lettura non ha effetti');
    assert.equal(fake.requests.length, 3);

    fake.respond(reply(500));
    const internal = await caught(() => c.propfind('/'));
    assert.equal(internal.status, 500);
    assert.equal(fake.requests.length, 1);
  });

  test('scritture: nessun retry dopo che la richiesta è partita; 5xx → esito ignoto', async () => {
    const c = client();
    for (const method of ['put', 'delete', 'mkcalendar', 'proppatch', 'move'] as const) {
      fake.respond(reply(503));
      const call = {
        put: () => c.put('/federico/lavoro/a.ics', 'x', { ifNoneMatch: '*' }),
        delete: () => c.delete('/federico/lavoro/a.ics', { ifMatch: '"e"' }),
        mkcalendar: () => c.mkcalendar('/federico/nuovo/'),
        proppatch: () => c.proppatch('/federico/', { set: [{ ...DAV_PROPS.displayname, value: 'x' }] }),
        move: () => c.move('/federico/a/x.ics', '/federico/b/x.ics'),
      }[method];
      const err = await caught(call);
      assert.ok(err instanceof RadicaleServerError, method);
      assert.equal(err.outcomeUnknown, true, `${method}: l'esito va riletto`);
      assert.equal(err.transient, true);
      assert.equal(fake.requests.length, 1, `${method}: una sola richiesta`);
    }
  });

  test('timeout: GET ripetuta fino al limite, PUT mai ripetuta e con esito ignoto', async () => {
    const c = client({ timeoutMs: 80 });
    fake.respond(reply(200, 'BEGIN:VCALENDAR', {}, 400));
    const getErr = await caught(() => c.get('/federico/lavoro/a.ics'));
    assert.ok(getErr instanceof RadicaleTimeoutError);
    assert.equal(getErr.attempts, 3);
    assert.equal(getErr.outcomeUnknown, false);
    assert.equal(fake.requests.length, 3);

    fake.respond(reply(201, '', { ETag: '"n"' }, 400));
    const putErr = await caught<RadicaleTimeoutError>(() => c.put('/federico/lavoro/a.ics', 'x', { ifNoneMatch: '*' }));
    assert.ok(putErr instanceof RadicaleTimeoutError);
    assert.equal(putErr.timeoutMs, 80);
    assert.equal(putErr.outcomeUnknown, true);
    assert.equal(putErr.attempts, 1);
    // timeout per singola chiamata
    fake.respond(reply(200, 'ok', {}, 150));
    assert.equal((await c.get('/x.ics', { timeoutMs: 1_000 })).body, 'ok');
  });

  test('connessione rifiutata: anche una scrittura si ripete (non è mai partita), poi errore di rete', async () => {
    const closed = new FakeDavServer();
    await closed.start();
    const url = closed.url;
    await closed.stop();
    const c = new RadicaleClient({ baseUrl: url, password: 'x', retries: 2, retryBaseDelayMs: 1 });
    const err = await caught<RadicaleNetworkError>(() => c.put('/federico/lavoro/a.ics', 'x', { ifNoneMatch: '*' }));
    assert.ok(err instanceof RadicaleNetworkError);
    assert.equal(err.errno, 'ECONNREFUSED');
    assert.equal(err.attempts, 3);
    assert.equal(err.outcomeUnknown, false);
    c.close();
  });

  test('header: Basic di caldes-svc, Depth, If-Match verbatim, If-None-Match, Destination assoluta, Overwrite', async () => {
    const c = client({ userAgent: 'caldes-api/test' });
    fake.respond(reply(204, '', { ETag: '"nuovo"' }));
    const put = await c.put('/federico/lavoro/a.ics', 'BEGIN:VCALENDAR', { ifMatch: '"abc"' });
    assert.deepEqual(put, { etag: '"nuovo"', created: false });
    let req = fake.requests[0];
    assert.equal(req.headers.authorization, `Basic ${Buffer.from(`caldes-svc:${SVC_PASSWORD}`).toString('base64')}`);
    assert.equal(req.headers['if-match'], '"abc"');
    assert.equal(req.headers['if-none-match'], undefined);
    assert.equal(req.headers['content-type'], 'text/calendar; charset=utf-8');
    assert.equal(req.headers['user-agent'], 'caldes-api/test');

    fake.respond(reply(201));
    await c.put('/federico/lavoro/b.ics', 'x', { ifNoneMatch: '*' });
    assert.equal(fake.requests[0].headers['if-none-match'], '*');

    fake.respond(reply(201));
    assert.deepEqual(await c.move('/federico/a/x.ics', '/federico/b/y%20z.ics'), { created: true });
    req = fake.requests[0];
    assert.equal(req.method, 'MOVE');
    assert.equal(req.headers.destination, `${fake.url}/federico/b/y%20z.ics`);
    assert.equal(req.headers.overwrite, 'F');

    fake.respond(reply(207, MULTISTATUS_ROOT));
    await c.propfind('/federico/', { depth: 1, props: [DAV_PROPS.displayname, DAV_PROPS.calendarId] });
    req = fake.requests[0];
    assert.equal(req.headers.depth, '1');
    assert.match(req.body, /<calendar-id xmlns="urn:calicchia:caldes"\/>/);

    // Precondizioni obbligatorie e valori pericolosi rifiutati prima della rete.
    fake.respond(reply(201));
    await assert.rejects(c.put('/federico/lavoro/c.ics', 'x', {} as never), TypeError);
    await assert.rejects(c.put('/federico/lavoro/c.ics', 'x', { ifMatch: '"a"\r\nX: y' }), TypeError);
    await assert.rejects(c.delete('/federico/lavoro/c.ics', { ifMatch: '' }), TypeError);
    assert.equal(fake.requests.length, 0);
  });

  test('risposte fuori protocollo: multistatus illeggibile, DOCTYPE, corpo oltre il limite, PROPPATCH parziale', async () => {
    const c = client({ maxResponseBytes: 2_000 });
    fake.respond(reply(207, '<multistatus xmlns="DAV:"><response>'));
    assert.ok((await caught(() => c.propfind('/'))) instanceof RadicaleProtocolError);
    fake.respond(reply(207, '<!DOCTYPE x [<!ENTITY a "b">]><multistatus xmlns="DAV:"/>'));
    assert.ok((await caught(() => c.propfind('/'))) instanceof RadicaleProtocolError);
    fake.respond(reply(200, 'x'.repeat(5_000)));
    const big = await caught(() => c.get('/a.ics'));
    assert.ok(big instanceof RadicaleProtocolError);
    assert.match(big.message, /oltre 2000 byte/);
    fake.respond(reply(207, '<multistatus xmlns="DAV:" xmlns:K="urn:calicchia:caldes"><response><href>/federico/</href>'
      + '<propstat><prop><displayname/></prop><status>HTTP/1.1 200 OK</status></propstat>'
      + '<propstat><prop><K:epoch/></prop><status>HTTP/1.1 403 Forbidden</status></propstat></response></multistatus>'));
    const partial = await caught<RadicalePropPatchError>(() => c.proppatch('/federico/', { set: [{ ...DAV_PROPS.displayname, value: 'F' }, { ...DAV_PROPS.volumeEpoch, value: '1' }] }));
    assert.ok(partial instanceof RadicalePropPatchError);
    assert.deepEqual(partial.failed, [{ property: '{urn:calicchia:caldes}epoch', status: 403 }]);
  });

  test('limite di connessioni contemporanee (maxSockets)', async () => {
    const c = client({ maxSockets: 2 });
    fake.respond(reply(207, MULTISTATUS_ROOT, {}, 60));
    await Promise.all(Array.from({ length: 6 }, () => c.propfind('/')));
    assert.equal(fake.requests.length, 6);
    assert.ok(fake.maxActive <= 2, `connessioni contemporanee: ${fake.maxActive}`);
    c.close();
  });

  test('percorsi: costruttori con codifica dei segmenti, percorsi pericolosi rifiutati', async () => {
    assert.equal(principalPath('federico'), '/federico/');
    assert.equal(collectionPath('federico', 'f'), '/federico/f/');
    assert.equal(collectionPath('federico', '_canary'), '/federico/_canary/');
    assert.equal(objectPath('federico', 'lavoro', 'a b@c.ics'), '/federico/lavoro/a%20b%40c.ics');
    assert.throws(() => principalPath('caldes-svc'));
    assert.throws(() => collectionPath('federico', '../x'));
    assert.throws(() => objectPath('federico', 'lavoro', '.Radicale.props'));
    for (const bad of ['federico/', '/a/../b', '/a/%2e%2e/b', '/a?x=1', '/a#b', '/a b', '/a/%2F/b']) {
      assert.throws(() => assertRequestPath(bad), TypeError, bad);
    }
    fake.respond(reply(200));
    await assert.rejects(client().get('/a/../b.ics'), TypeError);
    assert.equal(fake.requests.length, 0);
  });

  test('configurazione da ambiente', () => {
    assert.equal(radicaleClientFromEnv({}), null, 'Radicale non installato');
    assert.throws(() => radicaleClientFromEnv({ RADICALE_URL: 'http://radicale-int:5232' }), RadicaleConfigError);
    assert.throws(() => radicaleClientFromEnv({ RADICALE_URL: 'http://radicale-int:5232/dav', RADICALE_SVC_PASSWORD: 'x' }), RadicaleConfigError);
    assert.throws(() => radicaleClientFromEnv({ RADICALE_URL: 'ftp://x', RADICALE_SVC_PASSWORD: 'x' }), RadicaleConfigError);
    assert.throws(() => radicaleClientFromEnv({ RADICALE_URL: 'http://x', RADICALE_SVC_PASSWORD: 'x', RADICALE_TIMEOUT_MS: 'abc' }), RadicaleConfigError);
    const c = radicaleClientFromEnv({ RADICALE_URL: 'http://radicale-int:5232/', RADICALE_SVC_PASSWORD: 'x' });
    assert.ok(c);
    assert.equal(c.baseUrl, 'http://radicale-int:5232');
    assert.equal(c.username, 'caldes-svc');
    c.close();
  });
});

// ─── 2. Radicale reale ───────────────────────────────

/** Regole from_file con la matrice di caldes-svc del contratto §8 (modalità senza plugin). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

interface ServerMode {
  plugins: boolean;
  controlDir: string;
}

/** Opzioni del server: plugin del repo (con il control dir) o htpasswd + from_file. */
function serverOptions(mode: ServerMode, backendUrl: string, token: string, label: string): StartRadicaleOptions {
  if (!mode.plugins) {
    return { label, auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } }, rights: { type: 'from_file', rules: SVC_RIGHTS_RULES } };
  }
  return {
    label,
    auth: {
      type: 'plugin',
      module: 'caldes_auth',
      pythonPath: [RADICALE_PLUGINS_DIR],
      env: {
        RADICALE_PRINCIPAL: P,
        CALDAV_BACKEND_URL: backendUrl,
        CALDAV_SERVICE_TOKEN: token,
        CALDES_SVC_CIDR: `${SVC_PEER}/32`,
        CALDES_SVC_PASSWORD_SHA256: sha256(SVC_PASSWORD),
        CALDES_PROBE_PASSWORD_SHA256: sha256(PROBE_PASSWORD),
        CALDES_AUTHCACHE_KEY: 'test-only-authcache-key-f1-client-0123456789',
        CALDES_AUTHCACHE_DIR: join(mode.controlDir, 'authcache'),
        CALDES_POLICY_FILE: join(mode.controlDir, 'policy.json'),
      },
    },
    rights: {
      type: 'plugin',
      module: 'caldes_rights',
      pythonPath: [RADICALE_PLUGINS_DIR],
      options: {
        caldes_policy_file: join(mode.controlDir, 'policy.json'),
        caldes_heartbeat_file: join(mode.controlDir, 'heartbeat.json'),
        // Ricontrollo dei file a ogni richiesta: i test cambiano policy e marker fra una richiesta e l'altra.
        caldes_reload_interval: 0,
      },
      env: { RADICALE_PRINCIPAL: P },
    },
  };
}

const realSkip = radicale.skip || (REPO_PLUGINS ? python.skip : false);

describe('client CalDAV contro Radicale reale', { skip: realSkip }, () => {
  const mode: ServerMode = { plugins: false, controlDir: '' };
  before(async () => {
    mode.plugins = REPO_PLUGINS && !FORCE_HTPASSWD && (await canBindLocalAddress(SVC_PEER));
    mode.controlDir = mkdtempSync(join(tmpdir(), 'caldes-client-control-'));
  });
  after(() => {
    if (mode.controlDir) rmSync(mode.controlDir, { recursive: true, force: true });
  });
  const verify = REPO_PLUGINS ? useMockVerify({ users: [] }) : null;
  const rad = useRadicale(() => serverOptions(mode, verify?.mock.backendUrl ?? 'http://127.0.0.1:9', verify?.mock.token ?? 'x', 'client-f1'));
  let svc: RadicaleClient;
  before(() => {
    svc = new RadicaleClient({ baseUrl: rad.server.url, password: SVC_PASSWORD, localAddress: mode.plugins ? SVC_PEER : undefined, timeoutMs: 10_000 });
  });
  after(() => svc?.close());

  const A = `/${P}/tst-client-a/`;
  const B = `/${P}/tst-client-b/`;
  const VOLUME = '6f1d2c3b-4a59-4e8d-9c7b-1a2b3c4d5e6f';

  test(`connessione e credenziali (modalità: ${REPO_PLUGINS && !FORCE_HTPASSWD ? 'plugin del repo se 127.0.0.2 è utilizzabile' : 'htpasswd + from_file'})`, async (t) => {
    t.diagnostic(`modalità effettiva: ${mode.plugins ? 'plugin caldes_auth + caldes_rights, peer 127.0.0.2' : 'htpasswd + from_file'}`);
    assert.equal(await svc.currentUserPrincipal(), '/caldes-svc/');
    assert.equal(existsSync(rad.server.fsPath('caldes-svc')), false, 'nessuna auto-creazione di /caldes-svc/');
    const wrong = new RadicaleClient({ baseUrl: rad.server.url, password: 'sbagliata', localAddress: mode.plugins ? SVC_PEER : undefined });
    try {
      assert.ok((await caught(() => wrong.propfind('/'))) instanceof RadicaleUnauthorizedError);
    } finally {
      wrong.close();
    }
    if (mode.plugins) {
      // Dal peer sbagliato (gateway) la stessa credenziale vale 401.
      const fromGateway = new RadicaleClient({ baseUrl: rad.server.url, password: SVC_PASSWORD });
      try {
        assert.ok((await caught(() => fromGateway.propfind('/'))) instanceof RadicaleUnauthorizedError);
      } finally {
        fromGateway.close();
      }
    }
  });

  test('principal assente → 404; l\'inizializzazione non adotta un principal esistente', async () => {
    assert.equal(await svc.readProps(principalPath(P), [DAV_PROPS.resourcetype]), null);
    assert.ok((await caught(() => svc.propfind(principalPath(P)))) instanceof RadicaleNotFoundError);
    await svc.mkcol(principalPath(P));
    const again = await caught(() => svc.mkcol(principalPath(P)));
    assert.ok(again instanceof RadicaleBadRequestError);
    assert.equal(again.status, 405);
    // Volume non vuoto senza marker: initializeVolume si rifiuta e PG resta non inizializzato.
    const init = await caught<VolumeInitError>(() => initializeVolume({ db: sql, client: svc, principal: P }));
    assert.ok(init instanceof VolumeInitError);
    assert.equal(init.code, 'principal_exists');
    assert.equal((await readBackendState(sql)).epoch, 0);
  });

  test('marker d\'identità: PROPPATCH di caldes-svc, letto via PROPFIND e dal file come lo legge caldes_rights', async () => {
    assert.deepEqual(await readVolumeMarkerRemote(svc, P), { state: 'absent', detail: 'marker assente o malformato' });
    await writeVolumeMarker(svc, P, { volume_id: VOLUME, epoch: 3 });
    assert.deepEqual(await readVolumeMarkerRemote(svc, P), { state: 'ok', marker: { volume_id: VOLUME, epoch: 3 } });
    assert.deepEqual(await readVolumeMarkerFromFile(rad.server.storageDir, P), { state: 'ok', marker: { volume_id: VOLUME, epoch: 3 } });
    const props = JSON.parse(readFileSync(principalPropsPath(rad.server.storageDir, P), 'utf8'));
    assert.equal(props[DEAD_PROP.volumeId], VOLUME, 'chiavi in notazione Clark, valori stringa');
    assert.equal(props[DEAD_PROP.epoch], '3');
    const remote = await checkVolumeIdentity({ volume_id: VOLUME, epoch: 3 }, remoteIdentitySource(svc), P);
    assert.equal(remote.status, 'ok');
    assert.equal((await checkVolumeIdentity({ volume_id: VOLUME, epoch: 4 }, remoteIdentitySource(svc), P)).status, 'mismatch');
    const unreachable = new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0, timeoutMs: 1_000 });
    try {
      assert.equal((await checkVolumeIdentity({ volume_id: VOLUME, epoch: 3 }, remoteIdentitySource(unreachable), P)).status, 'unverified');
    } finally {
      unreachable.close();
    }
  });

  test('MKCALENDAR con dead prop; collezione esistente → 409 resource-must-be-null', async () => {
    await svc.mkcalendar(A, {
      displayName: 'Prova A',
      color: '#7c3aed',
      description: 'Collezione di prova, con virgole',
      order: 3,
      props: [{ ...DAV_PROPS.calendarId, value: '11111111-2222-4333-8444-555555555555' }, { ...DAV_PROPS.role, value: 'user' }],
    });
    await svc.mkcalendar(B, { displayName: 'Prova B', components: ['VEVENT', 'VTODO'] });
    const props = await svc.readProps(A, [DAV_PROPS.displayname, DAV_PROPS.calendarColor, DAV_PROPS.calendarId, DAV_PROPS.role, DAV_PROPS.calendarDescription]);
    assert.ok(props);
    assert.equal(props[clark(DAV_PROPS.displayname)], 'Prova A');
    assert.equal(props[clark(DAV_PROPS.calendarId)], '11111111-2222-4333-8444-555555555555');
    assert.equal(props[clark(DAV_PROPS.role)], 'user');
    assert.equal(props[clark(DAV_PROPS.calendarDescription)], 'Collezione di prova, con virgole');
    const conflict = await caught(() => svc.mkcalendar(A));
    assert.ok(conflict instanceof RadicaleConflictError);
    assert.equal(conflict.condition?.name, 'resource-must-be-null');
    // Genitore assente (profondità 3: nessun permesso nella matrice, quindi 403 prima del 409).
    const orphan = await caught(() => svc.mkcalendar(`/${P}/manca/sotto/`));
    assert.ok([403, 409].includes(orphan.status ?? 0), orphan.message);
  });

  test('PUT con precondizioni: If-None-Match crea, If-Match aggiorna, 412 sugli ETag vecchi, 409 no-uid-conflict', async () => {
    const path = `${A}evento-1.ics`;
    const ics = eventIcs('tst-client-1@caldes.test', '20270104T080000Z', '20270104T090000Z');
    const created = await svc.put(path, ics, { ifNoneMatch: '*' });
    assert.equal(created.created, true);
    assert.match(created.etag ?? '', /^"[0-9a-f]+"$/);
    assert.ok((await caught(() => svc.put(path, ics, { ifNoneMatch: '*' }))) instanceof RadicalePreconditionFailedError);
    assert.ok((await caught(() => svc.put(path, ics, { ifMatch: '"vecchio"' }))) instanceof RadicalePreconditionFailedError);
    const updated = await svc.put(path, eventIcs('tst-client-1@caldes.test', '20270104T080000Z', '20270104T093000Z', 'Aggiornato'), { ifMatch: created.etag as string });
    assert.equal(updated.created, false);
    assert.notEqual(updated.etag, created.etag);
    const got = await svc.get(path);
    assert.equal(got.etag, updated.etag);
    assert.match(got.body, /SUMMARY:Aggiornato/);
    assert.match(got.contentType ?? '', /text\/calendar/);
    // Stesso UID su un altro href della collezione.
    const dup = await caught(() => svc.put(`${A}evento-dup.ics`, ics, { ifNoneMatch: '*' }));
    assert.ok(dup instanceof RadicaleUidConflictError);
    assert.equal(dup.condition?.ns, NS.CALDAV);
    // Oggetto inesistente con If-Match → 412 (non 404); GET → 404.
    assert.ok((await caught(() => svc.put(`${A}manca.ics`, ics.replace('tst-client-1', 'tst-client-x'), { ifMatch: '"x"' }))) instanceof RadicalePreconditionFailedError);
    assert.ok((await caught(() => svc.get(`${A}manca.ics`))) instanceof RadicaleNotFoundError);
  });

  test('REPORT calendar-query (time-range) e calendar-multiget con href mancanti', async () => {
    await svc.put(`${A}evento-2.ics`, eventIcs('tst-client-2@caldes.test', '20270301T080000Z', '20270301T090000Z'), { ifNoneMatch: '*' });
    const january = await svc.calendarQuery(A, { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' });
    assert.deepEqual(january.map((o) => o.name), ['evento-1.ics']);
    assert.match(january[0].data ?? '', /UID:tst-client-1@caldes.test/);
    assert.ok(january[0].etag);
    const all = await svc.calendarQuery(A);
    assert.deepEqual(all.map((o) => o.name).sort(), ['evento-1.ics', 'evento-2.ics']);
    assert.deepEqual(await svc.calendarQuery(A, { component: 'VTODO' }), []);
    const multi = await svc.calendarMultiget(A, [`${A}evento-2.ics`, `${A}non-esiste.ics`]);
    assert.deepEqual(multi.objects.map((o) => o.name), ['evento-2.ics']);
    assert.deepEqual(multi.missing, [`${A}non-esiste.ics`]);
    assert.deepEqual(await svc.calendarMultiget(A, []), { objects: [], missing: [] });
  });

  test('REPORT sync-collection: iniziale, delta con modifiche e cancellazioni, token invalido', async () => {
    const initial = await svc.syncCollection(A);
    assert.ok(initial.syncToken);
    assert.deepEqual(initial.changed.map((c) => c.name).sort(), ['evento-1.ics', 'evento-2.ics']);
    const unchanged = await svc.syncCollection(A, { syncToken: initial.syncToken });
    assert.deepEqual(unchanged.changed, []);
    assert.deepEqual(unchanged.removed, []);

    const e2 = (await svc.get(`${A}evento-2.ics`)).etag as string;
    await svc.delete(`${A}evento-2.ics`, { ifMatch: e2 });
    await svc.put(`${A}evento-3.ics`, eventIcs('tst-client-3@caldes.test', '20270401T080000Z', '20270401T090000Z'), { ifNoneMatch: '*' });
    const delta = await svc.syncCollection(A, { syncToken: initial.syncToken, withData: true });
    assert.deepEqual(delta.changed.map((c) => c.name), ['evento-3.ics']);
    assert.match(delta.changed[0].data ?? '', /UID:tst-client-3@caldes.test/);
    assert.deepEqual(delta.removed, [`${A}evento-2.ics`]);
    assert.notEqual(delta.syncToken, initial.syncToken);

    const invalid = await caught(() => svc.syncCollection(A, { syncToken: 'http://radicale.org/ns/sync/sconosciuto' }));
    assert.ok(invalid instanceof RadicaleInvalidSyncTokenError);
    assert.equal(invalid.code, 'invalid_sync_token');
  });

  test('MOVE fra collezioni: 201, destinazione esistente senza Overwrite → 412, UID già presente → 409', async () => {
    const moved = await svc.move(`${A}evento-3.ics`, `${B}evento-3.ics`);
    assert.equal(moved.created, true);
    assert.ok((await caught(() => svc.get(`${A}evento-3.ics`))) instanceof RadicaleNotFoundError);
    assert.match((await svc.get(`${B}evento-3.ics`)).body, /tst-client-3/);

    await svc.put(`${A}occupato.ics`, eventIcs('tst-client-4@caldes.test', '20270501T080000Z', '20270501T090000Z'), { ifNoneMatch: '*' });
    await svc.put(`${B}occupato.ics`, eventIcs('tst-client-5@caldes.test', '20270501T080000Z', '20270501T090000Z'), { ifNoneMatch: '*' });
    assert.ok((await caught(() => svc.move(`${A}occupato.ics`, `${B}occupato.ics`))) instanceof RadicalePreconditionFailedError);

    await svc.put(`${B}stesso-uid.ics`, eventIcs('tst-client-1@caldes.test', '20270104T080000Z', '20270104T090000Z'), { ifNoneMatch: '*' });
    assert.ok((await caught(() => svc.move(`${A}evento-1.ics`, `${B}altro.ics`))) instanceof RadicaleUidConflictError);
    assert.ok((await caught(() => svc.move(`${A}non-esiste.ics`, `${B}x.ics`))) instanceof RadicaleNotFoundError);
  });

  test('DELETE con If-Match: 412 sull\'ETag vecchio, 404 se già sparito; collezione cancellabile solo dal servizio', async () => {
    const path = `${A}occupato.ics`;
    const etag = (await svc.get(path)).etag as string;
    assert.ok((await caught(() => svc.delete(path, { ifMatch: '"vecchio"' }))) instanceof RadicalePreconditionFailedError);
    await svc.delete(path, { ifMatch: etag });
    assert.ok((await caught(() => svc.delete(path, { ifMatch: '*' }))) instanceof RadicaleNotFoundError);
    // Fuori dal principal caldes-svc non ha permessi.
    assert.ok((await caught(() => svc.propfind('/altro-principal/'))) instanceof RadicaleForbiddenError);
    // DELETE della collezione: ammessa per caldes-svc (D) anche con permit_delete_collection = False.
    await svc.delete(B, { ifMatch: '*' });
    assert.ok((await caught(() => svc.propfind(B))) instanceof RadicaleNotFoundError);
  });
});

// ─── 3. Control-plane end-to-end ───────────────────────────────

describe('control-plane end-to-end con caldes_auth e caldes_rights (Radicale reale e database)', {
  skip: radicale.skip || python.skip || (!REPO_PLUGINS && 'plugin caldes_auth/caldes_rights assenti nel working tree'),
}, () => {
  const IPHONE = { username: 'iphone', password: 'test-only-app-password-iphone-f1' };
  const mode: ServerMode = { plugins: true, controlDir: '' };
  let peerOk = false;
  before(async () => {
    peerOk = await canBindLocalAddress(SVC_PEER);
    mode.controlDir = mkdtempSync(join(tmpdir(), 'caldes-e2e-control-'));
  });
  after(() => {
    if (mode.controlDir) rmSync(mode.controlDir, { recursive: true, force: true });
  });
  const verify = useMockVerify({ users: [IPHONE] });
  const rad = useRadicale(() => serverOptions(mode, verify.mock.backendUrl, verify.mock.token, 'e2e-f1'));
  let svc: RadicaleClient;
  let cp: CalendarControlPlane;
  before(() => {
    svc = new RadicaleClient({ baseUrl: rad.server.url, password: SVC_PASSWORD, localAddress: SVC_PEER });
    cp = new CalendarControlPlane({
      db: sql,
      policyFile: join(mode.controlDir, 'policy.json'),
      heartbeatFile: join(mode.controlDir, 'heartbeat.json'),
      principal: P,
      apiVersion: 'sha-e2etest',
      identitySource: fileIdentitySource(rad.server.storageDir),
      listen: false,
    });
  });
  after(async () => {
    await cp?.stop();
    svc?.close();
    await resetCalendarBaseline();
  });

  const device = () => rad.server.client(IPHONE.username, IPHONE.password).withHeaders({ 'X-Remote-Addr': '203.0.113.20' });
  const files = () => ({ policyFile: join(mode.controlDir, 'policy.json'), heartbeatFile: join(mode.controlDir, 'heartbeat.json'), principal: P });

  test('volume vuoto: policy shadow senza volume, device 403 sotto il principal e nessuna directory creata', async (t) => {
    if (!peerOk) return t.skip('127.0.0.2 non utilizzabile come indirizzo sorgente');
    const tick = await cp.syncNow('start');
    assert.equal(tick.ok, true, tick.error ?? '');
    assert.equal(tick.identity?.status, 'uninitialized');
    const policy = await readPolicyFile(files().policyFile, P);
    assert.ok(policy.state === 'ok' && policy.value.mode === 'shadow' && policy.value.volume_id === null);
    assert.equal((await device().propfind('/', { depth: 0 })).status, 207, 'la root resta leggibile');
    assert.equal((await device().propfind(`/${P}/`, { depth: 0 })).status, 403);
    assert.equal((await device().propfind(`/${IPHONE.username}/`, { depth: 0 })).status, 403);
    assert.equal(existsSync(rad.server.fsPath(P)), false, 'nessuna auto-creazione del principal');
    assert.equal(existsSync(rad.server.fsPath(IPHONE.username)), false);
  });

  test('inizializzazione esplicita: principal, marker, stato in PG e collezioni del sidecar con dead prop', async (t) => {
    if (!peerOk) return t.skip('127.0.0.2 non utilizzabile come indirizzo sorgente');
    const result = await initializeVolume({ db: sql, client: svc, principal: P });
    assert.equal(result.epoch, 1);
    const state = await readBackendState(sql);
    assert.equal(state.volume_id, result.volumeId);
    assert.equal(state.epoch, 1);
    assert.equal(state.mode, 'postgres');
    assert.deepEqual(await readVolumeMarkerFromFile(rad.server.storageDir, P), { state: 'ok', marker: { volume_id: result.volumeId, epoch: 1 } });
    // Calendari seminati della baseline: tutti creati, con calendar-id e role.
    const rows: Array<{ id: string; collection_name: string; role: string }> = await sql`
      SELECT id, collection_name, role FROM calendars WHERE lifecycle = 'active' AND collection_name IS NOT NULL ORDER BY collection_name
    `;
    assert.deepEqual(result.collections.map((c) => c.collectionName).sort(), rows.map((r) => r.collection_name));
    assert.ok(result.collections.every((c) => c.status === 'created'));
    for (const row of rows) {
      const props = await svc.readProps(collectionPath(P, row.collection_name), [DAV_PROPS.calendarId, DAV_PROPS.role]);
      assert.equal(props?.[clark(DAV_PROPS.calendarId)], row.id.toLowerCase(), row.collection_name);
      assert.equal(props?.[clark(DAV_PROPS.role)], row.role);
    }
    // Ripetibile senza effetti: lo stato non è più inizializzabile, le collezioni ci sono già.
    const again = await caught<VolumeInitError>(() => initializeVolume({ db: sql, client: svc, principal: P }));
    assert.equal(again.code, 'already_initialized');
    const provisioning = await createMissingCollections({ db: sql, client: svc, principal: P });
    assert.ok(provisioning.every((c) => c.status === 'exists'));
  });

  test('dopo l\'inizializzazione: identità ok, device in sola lettura (207 sul principal, 403 in scrittura)', async (t) => {
    if (!peerOk) return t.skip('127.0.0.2 non utilizzabile come indirizzo sorgente');
    const tick = await cp.syncNow();
    assert.equal(tick.identity?.status, 'ok', tick.identity?.detail ?? '');
    assert.equal(tick.policy?.mode, 'shadow');
    assert.equal(tick.policy?.written, true);
    const hb = await readHeartbeatFile(files().heartbeatFile);
    assert.ok(hb.state === 'ok' && hb.value.epoch === 1);
    const effective = await effectiveModeFromFiles(files());
    assert.equal(effective.mode, 'shadow');

    const listing = await device().propfind(`/${P}/`, { depth: 1 });
    assert.equal(listing.status, 207, listing.describe());
    const names = listing.multistatus().paths().map((p) => p.split('/').filter(Boolean)[1]).filter(Boolean).sort();
    assert.deepEqual(names, ['bookings', 'lavoro', 'personale', 'scadenze']);
    const ics = eventIcs('tst-e2e-device@caldes.test', '20270104T080000Z', '20270104T090000Z');
    assert.equal((await device().put(`/${P}/lavoro/device.ics`, ics, { ifNoneMatch: '*' })).status, 403, 'shadow: sola lettura');
    assert.equal((await device().mkcalendar(`/${P}/nuovo-dal-telefono/`)).status, 403);
    assert.equal((await device().delete(`/${P}/lavoro/`)).status, 403);
    // Il servizio scrive comunque (nessun controllo di modalità per caldes-svc).
    await svc.put(objectPath(P, 'lavoro', 'servizio.ics'), ics.replace('tst-e2e-device', 'tst-e2e-svc'), { ifNoneMatch: '*' });
    const read = await device().get(`/${P}/lavoro/servizio.ics`);
    assert.equal(read.status, 200, 'il device legge ciò che scrive il servizio');
  });

  test('heartbeat scaduto → frozen: stessi permessi di shadow (lettura sì, scrittura no)', async (t) => {
    if (!peerOk) return t.skip('127.0.0.2 non utilizzabile come indirizzo sorgente');
    const state = await readBackendState(sql);
    const old = { schema: 1 as const, api_version: 'sha-e2etest', mode: state.mode, epoch: state.epoch, ts: new Date(Date.now() - 11 * 60_000).toISOString() };
    await writeControlFileAtomic(files().heartbeatFile, serializeControlFile(old));
    const effective = await effectiveModeFromFiles(files());
    assert.equal(effective.mode, 'frozen');
    assert.deepEqual(effective.reasons, ['heartbeat_stale']);
    assert.equal((await device().propfind(`/${P}/lavoro/`, { depth: 0 })).status, 207);
    assert.equal((await device().put(`/${P}/lavoro/x.ics`, eventIcs('tst-e2e-x@caldes.test', '20270104T080000Z', '20270104T090000Z'), { ifNoneMatch: '*' })).status, 403);
    // Il giro successivo ripristina il heartbeat.
    assert.equal((await cp.syncNow()).ok, true);
    assert.equal((await effectiveModeFromFiles(files())).mode, 'shadow');
  });

  test('marker diverso sul volume: device 403, API mismatch e policy frozen; marker ripristinato → di nuovo leggibile', async (t) => {
    if (!peerOk) return t.skip('127.0.0.2 non utilizzabile come indirizzo sorgente');
    const state = await readBackendState(sql);
    await writeVolumeMarker(svc, P, { volume_id: state.volume_id as string, epoch: 2 });
    assert.equal((await device().propfind(`/${P}/`, { depth: 0 })).status, 403, 'caldes_rights confronta da solo marker e policy');
    const tick = await cp.syncNow();
    assert.equal(tick.identity?.status, 'mismatch');
    assert.equal(tick.policy?.mode, 'frozen');
    assert.deepEqual(tick.policy?.reasons, ['identity_mismatch']);
    assert.equal((await device().propfind(`/${P}/`, { depth: 0 })).status, 403);

    await writeVolumeMarker(svc, P, { volume_id: state.volume_id as string, epoch: 1 });
    const back = await cp.syncNow();
    assert.equal(back.identity?.status, 'ok');
    assert.equal(back.policy?.mode, 'shadow');
    assert.equal((await device().propfind(`/${P}/`, { depth: 0 })).status, 207);
    // La verifica remota (PROPFIND come caldes-svc) concorda con quella dal mount.
    assert.equal((await checkVolumeIdentity(state, remoteIdentitySource(svc), P)).status, 'ok');
  });

  test('policy corrotta dopo una valida: i device restano in sola lettura (ultima policy valida)', async (t) => {
    if (!peerOk) return t.skip('127.0.0.2 non utilizzabile come indirizzo sorgente');
    assert.equal((await device().propfind(`/${P}/lavoro/`, { depth: 0 })).status, 207);
    writeFileSync(files().policyFile, '{"schema": 1, corrotta');
    assert.equal((await device().propfind(`/${P}/lavoro/`, { depth: 0 })).status, 207);
    assert.equal((await device().put(`/${P}/lavoro/y.ics`, eventIcs('tst-e2e-y@caldes.test', '20270104T080000Z', '20270104T090000Z'), { ifNoneMatch: '*' })).status, 403);
    const tick = await cp.syncNow();
    assert.equal(tick.policy?.previous, 'invalid');
    assert.equal(tick.policy?.written, true);
  });
});
