/**
 * Contratto del backend CalDAV interno e delle app-password (fase F1 del
 * passaggio a Radicale, piano T7; contratto control-plane §9.4 e §9.6,
 * verify-credentials.schema.json).
 *
 * Copre:
 *  - POST /api/caldav-backend/verify-credentials, chiamata da caldes_auth:
 *    principal canonico per ogni app-password valida (anche con username
 *    storico), expires_at, negazione esplicita solo come 401 {ok:false},
 *    username riservati `caldes-*` rifiutati senza lookup, login malformati,
 *    Bearer di servizio (401 {error} che NON è una negazione), IP del device
 *    da X-Forwarded-For o X-Remote-Addr, rate limit per (IP, username),
 *    RADICALE_PRINCIPAL configurato o non valido (503, mai 401);
 *  - rimozione delle route /collections* del vecchio plugin di storage
 *    (404 con il Bearer, 401 senza);
 *  - /api/caldav-tokens dall'admin: username di default = principal
 *    canonico, username riservati rifiutati, campi dell'elenco, revoca che
 *    incrementa credential_epoch (e policy_version, con NOTIFY
 *    calendar_policy_changed) nella stessa transazione.
 *
 * Nessuna baseline F0 copriva queste route (il plugin di storage era rotto in
 * produzione): lo snapshot nasce in F1. Le differenze rispetto al
 * comportamento precedente sono volute e documentate qui:
 *  - il principal non è più lo username ma sempre RADICALE_PRINCIPAL;
 *  - la risposta 200 ha anche expires_at;
 *  - gli username caldes-* sono rifiutati (prima erano app-password normali);
 *  - l'IP viene solo da X-Forwarded-For/X-Remote-Addr (prima anche da
 *    CF-Connecting-IP e X-Real-IP) e il limite è per (IP, username) invece
 *    che per IP;
 *  - un errore del database risponde 503 {error} invece di 500;
 *  - /collections* non esiste più;
 *  - POST /api/caldav-tokens senza username usa il principal (prima 400).
 *
 * Gli snapshot sono in __snapshots__/caldav-backend.contract.json.
 * Aggiornamento (dopo aver verificato che il cambiamento è voluto):
 *   UPDATE_SNAPSHOTS=1 pnpm --filter @calicchia/api test test/contracts/caldav-backend.contract.test.ts
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withEnv } from '../helpers/env';
import { sql } from '../helpers/db';
import { api, type TestRequestOptions, type TestResponse } from '../helpers/http';
import { useFixtures } from '../helpers/fixtures';
import { createNormalizer, type SnapshotNormalizer } from '../helpers/normalize';
import { validateJsonSchema } from '../helpers/json-schema-lite';
import { revokeAppPassword } from '../../src/lib/calendar/caldav-passwords';
import { VERIFY_RATE_LIMIT_MAX } from '../../src/routes/calendar/caldav-backend';
import {
  contractCoverageTest,
  type HttpContractRequest,
  httpContractStore,
  responseEntry,
} from './_http-contract';

// Il contratto si verifica con il principal di default: una variabile
// rimasta nella shell non deve cambiare gli snapshot.
delete process.env.RADICALE_PRINCIPAL;

const fx = useFixtures('contratto-caldav', { resetBaseline: true });

const store = httpContractStore(
  'caldav-backend',
  'caldav-backend.contract.test.ts',
  'Backend CalDAV interno (POST /api/caldav-backend/verify-credentials, route /collections* rimosse) e ' +
    'app-password dall\'admin (/api/caldav-tokens) sullo scenario di test/contracts/caldav-backend.contract.test.ts: ' +
    'richiesta, status, header e corpo normalizzati, più gli effetti sulle righe. Contratto F1 (control-plane §9.4, §9.6).',
);
after(() => store.flush());

const VERIFY = '/api/caldav-backend/verify-credentials';
const TOKENS = '/api/caldav-tokens';

// ─── Schema del contratto ────────────────────────────────

const CONTRACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/calendar-radicale/contracts');
const VERIFY_SCHEMA = JSON.parse(readFileSync(resolve(CONTRACTS_DIR, 'verify-credentials.schema.json'), 'utf8')) as {
  $defs: object;
};

type VerifyDef = 'request' | 'responseOk' | 'responseDenied' | 'responseServiceUnauthorized' | 'responseRateLimited';

function schemaErrors(def: VerifyDef, value: unknown): string[] {
  return validateJsonSchema({ $defs: VERIFY_SCHEMA.$defs, $ref: `#/$defs/${def}` }, value);
}

/** La risposta rispetta la definizione `def` di verify-credentials.schema.json. */
function assertSchema(def: VerifyDef, value: unknown): void {
  const errors = schemaErrors(def, value);
  assert.deepEqual(errors, [], `${def}: ${errors.join('; ')}`);
}

/**
 * Negazione esplicita per caldes_auth: 401 con {ok:false} e nient'altro. Ogni
 * altro 401 (Bearer) o errore è un errore del backend (stale-if-error).
 */
function assertDenied(res: TestResponse, label: string): void {
  assert.equal(res.status, 401, `${label}: status ${res.status} ${res.text}`);
  assert.deepEqual(res.json, { ok: false }, label);
  assertSchema('responseDenied', res.json);
}

// ─── Richieste e snapshot ────────────────────────────────

interface VerifyOptions {
  ip?: string;
  headers?: Record<string, string>;
  /** false: senza Bearer; stringa: Bearer arbitrario. */
  bearer?: false | string;
  /** Corpo grezzo (stringa) al posto del JSON. */
  raw?: string;
}

function verify(body: unknown, opts: VerifyOptions = {}): Promise<TestResponse> {
  const req: TestRequestOptions = {
    body: opts.raw !== undefined ? opts.raw : body,
    ip: opts.ip,
    headers: opts.raw !== undefined ? { 'content-type': 'application/json', ...opts.headers } : opts.headers,
  };
  if (opts.bearer === undefined) req.auth = { caldavService: true };
  else if (typeof opts.bearer === 'string') req.auth = { bearer: opts.bearer };
  return api.post(VERIFY, req);
}

/** Normalizzatore per un caso, con il prefisso delle fixture. */
function normalizer(): SnapshotNormalizer {
  return createNormalizer({ prefixes: [fx.prefix] });
}

function record(
  caseId: string,
  res: TestResponse,
  request: HttpContractRequest,
  opts: { effects?: unknown; n?: SnapshotNormalizer; select?: (json: unknown) => unknown } = {},
): void {
  store.check(caseId, responseEntry(res, opts.n ?? normalizer(), { request, effects: opts.effects, select: opts.select }));
}

/**
 * Richiesta di verify-credentials come compare nello snapshot. Gli header
 * dell'IP, quando il caso li fissa, si registrano accanto alla richiesta (le
 * altre richieste hanno un X-Forwarded-For casuale dell'helper HTTP).
 */
function verifyRequest(body: unknown, auth = 'caldav-service', headers?: Record<string, string>): HttpContractRequest {
  const request = { method: 'POST', path: VERIFY, body, auth, ...(headers ? { headers } : {}) };
  return request as HttpContractRequest;
}

// ─── Lettura delle righe ─────────────────────────────────

interface UsageRow {
  username: string;
  last_used_ip: string | null;
  usage_count: number;
  used: boolean;
}

async function usage(id: string): Promise<UsageRow> {
  const [row] = await sql<UsageRow[]>`
    SELECT username, last_used_ip, COALESCE(usage_count, 0)::int AS usage_count, last_used_at IS NOT NULL AS used
    FROM caldav_app_passwords WHERE id = ${id}
  `;
  assert.ok(row, `app-password ${id} assente`);
  return row;
}

interface EpochState {
  credential_epoch: number;
  policy_version: number;
}

async function epochs(): Promise<EpochState> {
  const [row] = await sql<EpochState[]>`SELECT credential_epoch, policy_version FROM calendar_backend_state WHERE id`;
  assert.ok(row, 'calendar_backend_state assente');
  return { credential_epoch: Number(row.credential_epoch), policy_version: Number(row.policy_version) };
}

/** Riga storica con uno username che oggi sarebbe rifiutato (prima della F1 si poteva creare). */
async function legacyRow(username: string, password: string, device: string): Promise<string> {
  const hash = createHash('sha256').update(password).digest('hex');
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO caldav_app_passwords (token_hash, token_prefix, username, device_name)
    VALUES (${hash}, ${password.slice(0, 8)}, ${username}, ${fx.name(device)})
    RETURNING id
  `;
  fx.track('appPasswordIds', row.id);
  return row.id;
}

// ─── verify-credentials: credenziali valide ──────────────

test('verify-credentials: app-password con username canonico → principal canonico, IP registrato', async () => {
  const { password, row } = await fx.appPassword({ device: 'iPhone' });
  const body = { username: 'federico', password };
  const res = await verify(body, { ip: '203.0.113.10' });

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { ok: true, principal: 'federico', expires_at: null });
  assertSchema('request', body);
  assertSchema('responseOk', res.json);
  const effects = await usage(row.id);
  assert.deepEqual(effects, { username: 'federico', last_used_ip: '203.0.113.10', usage_count: 1, used: true });
  record('verify-credentials/valida-username-canonico', res, verifyRequest(body), { effects });
});

test('verify-credentials: app-password storica con username diverso → sempre il principal canonico', async () => {
  const { password, row } = await fx.appPassword({ username: 'iphone', device: 'iPhone storico' });
  const body = { username: 'iphone', password };
  const res = await verify(body, { ip: '203.0.113.11' });

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { ok: true, principal: 'federico', expires_at: null });
  assertSchema('responseOk', res.json);
  const effects = await usage(row.id);
  assert.equal(effects.username, 'iphone', 'lo username resta per audit');
  record('verify-credentials/valida-username-storico', res, verifyRequest(body), { effects });
});

test('verify-credentials: scadenza futura → expires_at in ISO UTC', async () => {
  const { password, row } = await fx.appPassword({ device: 'Mac con scadenza' });
  await sql`UPDATE caldav_app_passwords SET expires_at = '2099-01-01T00:00:00Z' WHERE id = ${row.id}`;
  const body = { username: 'federico', password };
  const res = await verify(body, { ip: '203.0.113.12' });

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { ok: true, principal: 'federico', expires_at: '2099-01-01T00:00:00.000Z' });
  assertSchema('responseOk', res.json);
  record('verify-credentials/valida-con-scadenza', res, verifyRequest(body));
});

test('verify-credentials: RADICALE_PRINCIPAL configurato → principal di configurazione', async () => {
  const { password } = await fx.appPassword({ device: 'Principal configurato' });
  const body = { username: 'federico', password };
  const res = await withEnv({ RADICALE_PRINCIPAL: 'agenda' }, () => verify(body, { ip: '203.0.113.13' }));

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { ok: true, principal: 'agenda', expires_at: null });
  record('verify-credentials/principal-configurato', res, verifyRequest(body));
});

// ─── verify-credentials: negazioni esplicite ─────────────

test('verify-credentials: scaduta, revocata, password errata, username diverso → 401 {ok:false} senza uso', async () => {
  const expired = await fx.appPassword({ device: 'Scaduta' });
  await sql`UPDATE caldav_app_passwords SET expires_at = now() - interval '1 minute' WHERE id = ${expired.row.id}`;
  const revoked = await fx.appPassword({ device: 'Revocata' });
  assert.equal(await revokeAppPassword(revoked.row.id), true);
  const storico = await fx.appPassword({ username: 'iphone', device: 'Legata allo username' });
  const valid = await fx.appPassword({ device: 'Valida' });

  const cases: Array<[string, { username: string; password: string }, string]> = [
    ['scaduta', { username: 'federico', password: expired.password }, expired.row.id],
    ['revocata', { username: 'federico', password: revoked.password }, revoked.row.id],
    ['password-errata', { username: 'federico', password: '0'.repeat(32) }, valid.row.id],
    // L'app-password resta legata al proprio username: il principal canonico
    // vale solo per l'esito, non per la ricerca.
    ['username-diverso', { username: 'federico', password: storico.password }, storico.row.id],
  ];
  for (const [name, body, rowId] of cases) {
    const res = await verify(body, { ip: '203.0.113.14' });
    assertDenied(res, name);
    const effects = await usage(rowId);
    assert.equal(effects.usage_count, 0, `${name}: nessun uso registrato`);
    record(`verify-credentials/${name}`, res, verifyRequest(body));
  }
});

test('verify-credentials: username riservati caldes-* → 401 anche con una riga storica e la password giusta', async () => {
  const usernames = ['caldes-svc', 'CALDES-Probe', 'caldes-altro'];
  // token_hash è UNIQUE: una password diversa per riga.
  const passwords = ['f', 'e', 'd'].map((ch) => ch.repeat(32));
  const ids: string[] = [];
  for (const [index, username] of usernames.entries()) {
    ids.push(await legacyRow(username, passwords[index], `Riga storica ${username}`));
  }
  for (const [index, username] of usernames.entries()) {
    const body = { username, password: passwords[index] };
    const res = await verify(body, { ip: '203.0.113.15' });
    assertDenied(res, username);
    // Nessun lookup né aggiornamento della riga.
    assert.deepEqual(await usage(ids[index]), { username, last_used_ip: null, usage_count: 0, used: false });
    if (index === 0) record('verify-credentials/username-riservato', res, verifyRequest(body));
  }
});

test('verify-credentials: login malformati → 401 {ok:false}', async () => {
  const { password } = await fx.appPassword({ device: 'Malformati' });
  const cases: Array<{ name: string; body?: unknown; raw?: string; described?: unknown }> = [
    { name: 'corpo-non-json', raw: 'username=federico', described: '<corpo non JSON>' },
    { name: 'corpo-array', body: [{ username: 'federico', password }], described: ['<oggetto con credenziali valide>'] },
    { name: 'campi-mancanti', body: { username: 'federico' } },
    { name: 'campi-vuoti', body: { username: '', password: '' } },
    { name: 'campi-non-stringa', body: { username: 42, password: true } },
    { name: 'username-con-controllo', body: { username: 'fede\u0001rico', password } },
    // 256 byte UTF-8 (128 × 'à'): oltre il limite del contratto anche con 128 caratteri.
    { name: 'username-oltre-255-byte', body: { username: 'à'.repeat(128), password }, described: { username: '<128 × à: 256 byte>', password: '<password>' } },
    { name: 'password-oltre-1024', body: { username: 'federico', password: 'a'.repeat(1025) }, described: { username: 'federico', password: '<1025 caratteri>' } },
  ];
  for (const c of cases) {
    const res = await verify(c.body, { ip: '203.0.113.16', raw: c.raw });
    assertDenied(res, c.name);
    record(`verify-credentials/${c.name}`, res, verifyRequest(c.described ?? c.body));
  }
});

// ─── verify-credentials: errori del backend ──────────────

test('verify-credentials: Bearer assente o errato → 401 {error}, che NON è una negazione', async () => {
  const { password } = await fx.appPassword({ device: 'Bearer' });
  const body = { username: 'federico', password };
  for (const [name, bearer] of [['bearer-assente', false], ['bearer-errato', 'token-sbagliato']] as const) {
    const res = await verify(body, { ip: '203.0.113.17', bearer });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'Unauthorized' });
    assertSchema('responseServiceUnauthorized', res.json);
    assert.notDeepEqual(schemaErrors('responseDenied', res.json), [], 'non deve sembrare una negazione');
    record(`verify-credentials/${name}`, res, verifyRequest(body, name === 'bearer-assente' ? 'nessuna' : 'bearer errato'));
  }
});

test('verify-credentials: RADICALE_PRINCIPAL non valido → 503 {error}, mai 401', async () => {
  const { password } = await fx.appPassword({ device: 'Principal non valido' });
  const body = { username: 'federico', password };
  const res = await withEnv({ RADICALE_PRINCIPAL: 'caldes-agenda' }, () => verify(body, { ip: '203.0.113.18' }));
  assert.equal(res.status, 503, res.text);
  assert.equal(typeof res.json.error, 'string');
  assert.notDeepEqual(schemaErrors('responseDenied', res.json), []);
  record('verify-credentials/principal-non-valido', res, verifyRequest(body));

  // Gli username riservati restano rifiutati anche con la configurazione rotta.
  const reserved = await withEnv({ RADICALE_PRINCIPAL: 'caldes-agenda' }, () =>
    verify({ username: 'caldes-svc', password }, { ip: '203.0.113.18' }));
  assertDenied(reserved, 'riservato con principal non valido');
});

// ─── verify-credentials: IP del device ───────────────────

test('verify-credentials: IP da X-Forwarded-For (primo elemento, IPv4-mapped) o da X-Remote-Addr', async () => {
  const cases: Array<{ name: string; headers: Record<string, string>; expected: string | null }> = [
    { name: 'ip-x-forwarded-for-multiplo', headers: { 'x-forwarded-for': '203.0.113.21, 10.0.0.1' }, expected: '203.0.113.21' },
    { name: 'ip-ipv4-mapped', headers: { 'x-forwarded-for': '::ffff:203.0.113.22' }, expected: '203.0.113.22' },
    { name: 'ip-ipv6', headers: { 'x-forwarded-for': '2001:DB8::7' }, expected: '2001:db8::7' },
    { name: 'ip-da-x-remote-addr', headers: { 'x-forwarded-for': '', 'x-remote-addr': '203.0.113.23' }, expected: '203.0.113.23' },
    { name: 'ip-non-valido', headers: { 'x-forwarded-for': 'non-un-ip' }, expected: null },
    // CF-Connecting-IP e X-Real-IP non vengono mai dal plugin: ignorati.
    { name: 'ip-header-non-del-plugin', headers: { 'x-forwarded-for': '', 'cf-connecting-ip': '198.51.100.1', 'x-real-ip': '198.51.100.2' }, expected: null },
  ];
  for (const c of cases) {
    const { password, row } = await fx.appPassword({ device: `IP ${c.name}` });
    const body = { username: 'federico', password };
    const res = await verify(body, { headers: c.headers });
    assert.equal(res.status, 200, `${c.name}: ${res.text}`);
    const effects = await usage(row.id);
    assert.equal(effects.last_used_ip, c.expected, c.name);
    record(`verify-credentials/${c.name}`, res, verifyRequest(body, 'caldav-service', c.headers), { effects });
  }
});

// ─── verify-credentials: rate limit ──────────────────────

test('verify-credentials: rate limit dei tentativi falliti per (IP, username), mai sulla password corretta', async () => {
  const federico = await fx.appPassword({ device: 'Rate limit federico' });
  const iphone = await fx.appPassword({ username: 'iphone', device: 'Rate limit iphone' });
  const ip = '203.0.113.30';
  const wrong = { username: 'federico', password: '1'.repeat(32) };

  for (let i = 0; i < VERIFY_RATE_LIMIT_MAX; i++) {
    assertDenied(await verify(wrong, { ip }), `tentativo ${i + 1}`);
  }
  // Oltre il limite un tentativo fallito risponde 429 invece di 401: per
  // caldes_auth è una negazione temporanea (401 dopo il delay di Radicale),
  // mai un errore del backend che aprirebbe lo stale-if-error.
  const limited = await verify(wrong, { ip });
  assert.equal(limited.status, 429, limited.text);
  assertSchema('responseRateLimited', limited.json);
  assert.notDeepEqual(schemaErrors('responseDenied', limited.json), []);
  record('verify-credentials/rate-limit-superato', limited, verifyRequest(wrong));

  // La password corretta non è mai limitata: chi esaurisce il bucket di uno
  // username (anche quello comune, senza X-Remote-Addr) non blocca il device
  // legittimo. E un successo non consuma il bucket.
  const body = { username: 'federico', password: federico.password };
  for (let i = 0; i < 3; i++) {
    const ok = await verify(body, { ip });
    assert.equal(ok.status, 200, ok.text);
    assertSchema('responseOk', ok.json);
  }
  assert.equal((await usage(federico.row.id)).usage_count, 3);
  assert.equal((await usage(federico.row.id)).last_used_ip, ip);

  // Stesso bucket senza distinzione di maiuscole (FEDERICO non è lo username
  // dell'app-password: tentativo fallito).
  assert.equal((await verify({ username: 'FEDERICO', password: federico.password }, { ip })).status, 429);
  // Il Bearer viene prima di tutto.
  assert.equal((await verify(wrong, { ip, bearer: 'token-sbagliato' })).status, 401);
  // Altro username dallo stesso IP e stesso username da un altro IP: bucket propri.
  assertDenied(await verify({ username: 'iphone', password: '2'.repeat(32) }, { ip }), 'altro username');
  const otherUser = await verify({ username: 'iphone', password: iphone.password }, { ip });
  assert.equal(otherUser.status, 200, otherUser.text);
  assertDenied(await verify(wrong, { ip: '203.0.113.31' }), 'altro IP');
  const otherIp = await verify(body, { ip: '203.0.113.31' });
  assert.equal(otherIp.status, 200, otherIp.text);
  assert.equal((await usage(federico.row.id)).last_used_ip, '203.0.113.31');
});

// ─── verify-credentials: peer TCP ammessi ────────────────

test('verify-credentials: con CALDAV_BACKEND_ALLOWED_PEERS solo il peer di Radicale, anche con il Bearer giusto', async () => {
  const { password } = await fx.appPassword({ device: 'Peer ammessi' });
  const body = { username: 'federico', password };
  // Le richieste in-process non hanno un socket: peer sconosciuto → 404 come
  // se la route non esistesse (il vhost pubblico dell'API resta cieco).
  await withEnv({ CALDAV_BACKEND_ALLOWED_PEERS: '172.31.250.3/32' }, async () => {
    const res = await verify(body);
    assert.equal(res.status, 404, res.text);
    assert.deepEqual(res.json, { error: 'Not Found' });
    assert.equal((await verify(body, { bearer: false })).status, 404, 'il peer viene prima del Bearer');
  });
  // Valore non valido: backend chiuso con 503 (errore di configurazione per
  // caldes_auth, mai una negazione).
  for (const value of ['non-una-rete', '172.31.250.0/0', '172.31.250.3/33', '172.31.250.3/x']) {
    await withEnv({ CALDAV_BACKEND_ALLOWED_PEERS: value }, async () => {
      const res = await verify(body);
      assert.equal(res.status, 503, `${value}: ${res.text}`);
    });
  }
  // Senza variabile (sviluppo, test): controllo spento.
  assert.equal((await verify(body)).status, 200);
});

// ─── Route /collections* rimosse ─────────────────────────

test('route /collections* del vecchio plugin di storage: rimosse (404), sempre dietro il Bearer', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//IT',
    'BEGIN:VEVENT', `UID:${fx.prefix}-collections@example.test`, 'DTSTAMP:20270101T000000Z',
    'DTSTART:20270105T100000Z', 'DTEND:20270105T110000Z', 'SUMMARY:Non deve arrivare',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const cases: Array<[string, 'GET' | 'PUT' | 'DELETE', string]> = [
    ['elenco', 'GET', '/collections'],
    ['collezione', 'GET', '/collections/lavoro'],
    ['items', 'GET', '/collections/lavoro/items'],
    ['item', 'GET', '/collections/lavoro/items/evento.ics'],
    ['put', 'PUT', '/collections/lavoro/items/evento.ics'],
    ['delete', 'DELETE', '/collections/lavoro/items/evento.ics'],
  ];
  for (const [name, method, suffix] of cases) {
    const path = `/api/caldav-backend${suffix}`;
    const opts: TestRequestOptions = {
      auth: { caldavService: true },
      ...(method === 'PUT' ? { body: ics, headers: { 'content-type': 'text/calendar' } } : {}),
    };
    const res = method === 'GET' ? await api.get(path, opts) : method === 'PUT' ? await api.put(path, opts) : await api.delete(path, opts);
    assert.equal(res.status, 404, `${name}: ${res.text}`);
    assert.deepEqual(res.json, { error: 'Not Found' });
    record(`collections-rimosse/${name}`, res, { method, path, auth: 'caldav-service', ...(method === 'PUT' ? { body: '<VCALENDAR con un VEVENT>' } : {}) });
  }
  const [{ count }] = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM calendar_events WHERE uid LIKE ${`${fx.prefix}-collections%`}
  `;
  assert.equal(count, 0, 'la PUT non deve creare eventi');

  // Il prefisso resta protetto dal Bearer: senza, 401 prima del 404.
  const unauthenticated = await api.get('/api/caldav-backend/collections');
  assert.equal(unauthenticated.status, 401);
  record('collections-rimosse/senza-bearer', unauthenticated, { method: 'GET', path: '/api/caldav-backend/collections', auth: 'nessuna' });
});

// ─── /api/caldav-tokens (admin) ──────────────────────────

/** Corpo della creazione senza i campi volatili, per le asserzioni puntuali. */
function created(res: TestResponse): { id: string; username: string } {
  assert.equal(res.status, 201, res.text);
  fx.track('appPasswordIds', res.json.id);
  return { id: res.json.id, username: res.json.username };
}

test('caldav-tokens: username assente o vuoto → principal canonico; storico ammesso; creazione senza epoch', async () => {
  const before = await epochs();
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['crea-senza-username', { device_name: fx.name('iPhone nuovo') }, 'federico'],
    ['crea-username-vuoto', { username: '   ', device_name: fx.name('Mac nuovo') }, 'federico'],
    ['crea-username-canonico', { username: 'federico', device_name: fx.name('iPad') }, 'federico'],
    ['crea-username-storico', { username: 'iphone', device_name: fx.name('Script storico') }, 'iphone'],
  ];
  for (const [name, body, expected] of cases) {
    const res = await api.post(TOKENS, { auth: 'admin', body });
    const row = created(res);
    assert.equal(row.username, expected, name);
    assert.equal(typeof res.json.password, 'string');
    assert.match(res.json.password, /^[0-9a-f]{32}$/);
    assert.ok(String(res.json.warning).includes(`"${expected}"`), 'il messaggio cita lo username da usare');
    assert.equal(res.json.last_used_ip, null);
    assert.equal(res.json.expires_at, null);
    record(`caldav-tokens/${name}`, res, { method: 'POST', path: TOKENS, body, auth: 'admin' });

    // L'app-password appena creata funziona subito con lo username restituito.
    const ok = await verify({ username: row.username, password: res.json.password }, { ip: '203.0.113.40' });
    assert.deepEqual(ok.json, { ok: true, principal: 'federico', expires_at: null });
  }
  assert.deepEqual(await epochs(), before, 'la creazione non cambia credential_epoch né la policy');

  const configured = await withEnv({ RADICALE_PRINCIPAL: 'agenda' }, () =>
    api.post(TOKENS, { auth: 'admin', body: { device_name: fx.name('Principal configurato') } }));
  assert.equal(created(configured).username, 'agenda');
});

test('caldav-tokens: username riservati o non validi → 400, nessuna riga creata', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['crea-username-riservato', { username: 'caldes-svc', device_name: fx.name('Riservato svc') }],
    ['crea-username-riservato-maiuscole', { username: 'CALDES-Probe', device_name: fx.name('Riservato probe') }],
    ['crea-username-solo-prefisso', { username: 'caldes-', device_name: fx.name('Solo prefisso') }],
    ['crea-username-caratteri-non-ammessi', { username: 'fede/rico', device_name: fx.name('Caratteri') }],
    ['crea-username-troppo-lungo', { username: 'a'.repeat(65), device_name: fx.name('Lungo') }],
    ['crea-username-non-stringa', { username: 42, device_name: fx.name('Non stringa') }],
    ['crea-device-mancante', { username: 'federico' }],
  ];
  for (const [name, body] of cases) {
    const res = await api.post(TOKENS, { auth: 'admin', body });
    assert.equal(res.status, 400, `${name}: ${res.text}`);
    assert.equal(typeof res.json.error, 'string');
    record(`caldav-tokens/${name}`, res, { method: 'POST', path: TOKENS, body, auth: 'admin' });
  }
  const riservato = await api.post(TOKENS, { auth: 'admin', body: { username: 'Caldes-Svc', device_name: fx.name('Riservato misto') } });
  assert.match(riservato.json.error, /caldes-/);
  const [{ count }] = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM caldav_app_passwords
    WHERE device_name LIKE ${`${fx.prefix} Riservato%`} OR device_name LIKE ${`${fx.prefix} Solo prefisso%`}
  `;
  assert.equal(count, 0);
});

test('caldav-tokens: elenco con principal, stato del backend, IP e scadenza', async () => {
  const one = await fx.appPassword({ device: 'Elenco uno' });
  const two = await fx.appPassword({ username: 'iphone', device: 'Elenco due' });
  await sql`UPDATE caldav_app_passwords SET expires_at = '2099-06-01T00:00:00Z' WHERE id = ${two.row.id}`;
  assert.equal((await verify({ username: 'federico', password: one.password }, { ip: '203.0.113.50' })).status, 200);

  const res = await api.get(TOKENS, { auth: 'admin' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.principal, 'federico');
  // Baseline dei test: mode postgres, volume non inizializzato.
  assert.deepEqual(res.json.calendar_backend, { mode: 'postgres', initialized: false });
  const mine = (res.json.passwords as Array<{ id: string }>).filter((p) => p.id === one.row.id || p.id === two.row.id);
  assert.equal(mine.length, 2);
  for (const p of res.json.passwords as Array<Record<string, unknown>>) {
    assert.ok(!('token_hash' in p), 'mai l\'hash nella risposta');
  }
  const n = normalizer().alias(one.row.id, 'app-password:uno').alias(two.row.id, 'app-password:due');
  record('caldav-tokens/elenco', res, { method: 'GET', path: TOKENS, auth: 'admin' }, {
    n,
    select: (json) => {
      const body = json as { passwords: Array<{ id: string }>; principal: string; calendar_backend: unknown };
      return { ...body, passwords: body.passwords.filter((p) => p.id === one.row.id || p.id === two.row.id) };
    },
  });

  assert.equal((await api.get(TOKENS)).status, 401, 'solo admin');
});

test('caldav-tokens: la revoca incrementa credential_epoch e policy_version nella stessa transazione, con NOTIFY', async () => {
  const { password, row } = await fx.appPassword({ device: 'Da revocare' });
  assert.equal((await verify({ username: 'federico', password }, { ip: '203.0.113.60' })).status, 200);

  const notifications: string[] = [];
  const listener = await sql.listen('calendar_policy_changed', (payload) => notifications.push(payload));
  try {
    const before = await epochs();
    const res = await api.delete(`${TOKENS}/${row.id}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { revoked: true });
    const afterRevoke = await epochs();
    const [revoked] = await sql<Array<{ is_active: boolean; revoked: boolean; revoked_reason: string }>>`
      SELECT is_active, revoked_at IS NOT NULL AS revoked, revoked_reason FROM caldav_app_passwords WHERE id = ${row.id}
    `;
    const effects = {
      credential_epoch_delta: afterRevoke.credential_epoch - before.credential_epoch,
      policy_version_delta: afterRevoke.policy_version - before.policy_version,
      row: revoked,
    };
    assert.deepEqual(effects, {
      credential_epoch_delta: 1,
      policy_version_delta: 1,
      row: { is_active: false, revoked: true, revoked_reason: 'revoked from admin' },
    });
    const n = normalizer().alias(row.id, 'app-password');
    record('caldav-tokens/revoca', res, { method: 'DELETE', path: `${TOKENS}/${row.id}`, auth: 'admin' }, { n, effects });

    // Il writer della policy la riscrive subito (NOTIFY della 162, source "state").
    const deadline = Date.now() + 2_000;
    while (!notifications.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(notifications.some((p) => JSON.parse(p).source === 'state'), `NOTIFY atteso, ricevuti: ${notifications.join(', ')}`);

    // Le credenziali revocate sono rifiutate subito.
    assertDenied(await verify({ username: 'federico', password }, { ip: '203.0.113.60' }), 'dopo la revoca');

    // Revoca ripetuta, id inesistente, id non valido: nessun cambio di epoch.
    const again = await api.delete(`${TOKENS}/${row.id}`, { auth: 'admin' });
    assert.equal(again.status, 404);
    record('caldav-tokens/revoca-ripetuta', again, { method: 'DELETE', path: `${TOKENS}/${row.id}`, auth: 'admin' }, { n: normalizer().alias(row.id, 'app-password') });
    const missing = await api.delete(`${TOKENS}/00000000-0000-4000-8000-000000000000`, { auth: 'admin' });
    assert.equal(missing.status, 404);
    const invalid = await api.delete(`${TOKENS}/non-un-uuid`, { auth: 'admin' });
    assert.equal(invalid.status, 400);
    record('caldav-tokens/revoca-id-non-valido', invalid, { method: 'DELETE', path: `${TOKENS}/non-un-uuid`, auth: 'admin' });
    assert.deepEqual(await epochs(), afterRevoke, 'nessun incremento senza una revoca effettiva');
  } finally {
    await listener.unlisten();
  }
});

test('revokeAppPassword: se l\'incremento di credential_epoch fallisce, anche la revoca viene annullata', async () => {
  const { password, row } = await fx.appPassword({ device: 'Atomica' });
  const before = await epochs();
  // Trigger di prova che fa fallire solo l'incremento dell'epoch: la revoca,
  // nella stessa transazione, deve tornare indietro con lui. Il trigger vive
  // solo per questo test (i file di test girano in sequenza sul database).
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION caldes_test_fail_credential_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.credential_epoch IS DISTINCT FROM OLD.credential_epoch THEN
        RAISE EXCEPTION 'incremento di credential_epoch rifiutato (test)';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS caldes_test_fail_credential_epoch ON calendar_backend_state;
    CREATE TRIGGER caldes_test_fail_credential_epoch BEFORE UPDATE ON calendar_backend_state
      FOR EACH ROW EXECUTE FUNCTION caldes_test_fail_credential_epoch();
  `);
  try {
    await assert.rejects(revokeAppPassword(row.id), /credential_epoch rifiutato/);
  } finally {
    await sql.unsafe(`
      DROP TRIGGER IF EXISTS caldes_test_fail_credential_epoch ON calendar_backend_state;
      DROP FUNCTION IF EXISTS caldes_test_fail_credential_epoch();
    `);
  }
  assert.deepEqual(await epochs(), before, 'epoch invariato');
  const [state] = await sql<Array<{ is_active: boolean; revoked: boolean }>>`
    SELECT is_active, revoked_at IS NOT NULL AS revoked FROM caldav_app_passwords WHERE id = ${row.id}
  `;
  assert.deepEqual(state, { is_active: true, revoked: false }, 'revoca annullata');
  assert.equal((await verify({ username: 'federico', password }, { ip: '203.0.113.70' })).status, 200, 'ancora valida');

  // Senza il trigger la stessa revoca riesce e incrementa l'epoch di uno.
  assert.equal(await revokeAppPassword(row.id), true);
  assert.equal((await epochs()).credential_epoch, before.credential_epoch + 1);
});

contractCoverageTest(store, 'caldav-backend.contract.test.ts');
