/**
 * Gruppo INIT della F3 contro Radicale 3.7.8 reale (apps/api/src/lib/
 * calendar/migration/{preflight,init}.ts e scripts/radicale-init.ts; design
 * §6.3, §13.2, §13.3, §16.3; decisione 7; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §1.4, §2.1, §6.1 e §12).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea, auth
 * htpasswd con caldes-svc e caldes-probe, rights from_file con la matrice di
 * caldes-svc del contratto control-plane §8 e un probe come in shadow (lettura
 * delle collezioni utente, niente su `_canary`). Il runtime della sync punta al
 * client di servizio (identità letta dal marker su Radicale).
 *
 * Casi:
 *  - preflight su un volume vuoto (si può inizializzare) e dopo
 *    l'inizializzazione (identità ok, collezioni, probe in sola lettura, PUT
 *    del probe su `_canary` con 403; con il gate aperto entrambi falliscono
 *    senza lasciare risorse; campanello, control-plane, 401 pubblico,
 *    app-password riservate);
 *  - inizializzazione sui dati di forma produttiva: principal, marker, epoch
 *    1, collezioni con il nome esatto dello slug (`c` e `f` comprese) e le dead
 *    prop, `_canary`; journal nei params del run prima della MKCOL;
 *    idempotenza; collezioni mancanti; conflitto mai toccato;
 *  - rifiuto di un volume non vuoto con identità diversa (Fase 0, altro
 *    stack), anche con il journal di una ripresa;
 *  - ripresa dopo un crash fra MKCOL e UPDATE (marker già scritto, principal
 *    vuoto, stato già aggiornato);
 *  - guardia delle scritture: identità e mode riletti, cambio durante il run;
 *  - riassegnazione d'identità nei due versi, mai un epoch che torna indietro,
 *    rivalidazione del ledger;
 *  - archivio della Fase 0: collezione archivio-fase0 non bloccante e fuori
 *    dal piano, PUT con If-None-Match, idempotente (seconda esecuzione senza
 *    PUT), intento pendente adottato, destinazione cambiata mai sovrascritta,
 *    dichiarazione phase0, file caricato rimosso; tar.gz del vecchio volume
 *    con la stessa chiave del ledger dello zip;
 *  - scripts/radicale-init.ts (calendar:radicale-init) delega a migration/init.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { runRadicaleInit } from '../../scripts/radicale-init';
import {
  ARCHIVE_CALENDAR_NAME,
  ARCHIVE_COLLECTION_NAME,
  plannedCollections,
  readIdentityDiff,
  readVolumeCollections,
  runArchiveImport,
  runIdentityReassign,
  runInit,
} from '../../src/lib/calendar/migration/init';
import { loadMigrationCalendars } from '../../src/lib/calendar/migration/inventory';
import {
  assertMigrationWritable,
  collectPreflight,
  createIdentityGuard,
  type PreflightDeps,
  runPreflightWith,
} from '../../src/lib/calendar/migration/preflight';
import {
  type ArchiveParams,
  type IdentityParams,
  type InitParams,
  type InitSummary,
  MigrationError,
  type PreflightCheck,
  type PreflightSummary,
} from '../../src/lib/calendar/migration/types';
import { collectionPath, createNodeTransport, objectPath, principalPath, RadicaleClient, type RadicaleTransport } from '../../src/lib/calendar/radicale/client';
import { DAV_PROPS } from '../../src/lib/calendar/radicale/dav-xml';
import type { ControlPlaneStatus, ControlPlaneTick } from '../../src/lib/calendar/radicale/heartbeat';
import { writeVolumeMarker } from '../../src/lib/calendar/radicale/identity';
import { configureRadicaleRuntime, invalidateIdentityCache } from '../../src/lib/calendar/radicale/sync';
import { CANARY_COLLECTION } from '../../src/lib/calendar/radicale/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { RADICALE_PLUGINS_DIR, radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';
import { buildProductionShape, buildTar, buildZip, eventIcs, insertRun, testRun, uid } from '../calendar/_migration-init-shared';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});
const fx = useFixtures('mig-init-rad');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f3-init';
const PROBE_PASSWORD = 'test-only-probe-password-f3-init';

/**
 * Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal,
 * rwD collezioni) e caldes-probe come in shadow: R su root e principal, r
 * sulle collezioni utente, niente sulle collezioni di sistema (`_canary`).
 */
const RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
  '[probe-principal]', 'user: caldes-probe', `collection: ${P}`, 'permissions: R', '',
  '[probe-user-collections]', 'user: caldes-probe', `collection: ${P}/[^_/][^/]*`, 'permissions: r', '',
].join('\n');

interface Recorded { method: string; path: string; ifMatch: string | null; ifNoneMatch: string | null }

/** Trasporto node che registra metodo, percorso e precondizioni di ogni richiesta. */
function recordingTransport(): { transport: RadicaleTransport; take(): Recorded[]; close(): void } {
  const node = createNodeTransport({ maxSockets: 4 });
  let log: Recorded[] = [];
  return {
    transport: async (req) => {
      log.push({ method: req.method, path: decodeURIComponent(req.url.pathname), ifMatch: req.headers['If-Match'] ?? null, ifNoneMatch: req.headers['If-None-Match'] ?? null });
      return node(req);
    },
    take: () => {
      const out = log;
      log = [];
      return out;
    },
    close: () => node.close(),
  };
}

function checkOf(summary: PreflightSummary, code: PreflightCheck['code']): PreflightCheck {
  const found = summary.checks.find((c) => c.code === code);
  assert.ok(found, `controllo ${code} presente`);
  return found;
}

function isPrecondition(reason: string, runErrorCode?: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof MigrationError, `MigrationError atteso, ricevuto ${String(err)}`);
    assert.equal(err.code, 'PRECONDITION_FAILED', err.message);
    assert.ok((err.details?.reasons as string[]).includes(reason), `motivo ${reason} in ${JSON.stringify(err.details)}`);
    if (runErrorCode) assert.equal(err.details?.run_error_code, runErrorCode);
    return true;
  };
}

async function backendState(): Promise<{ mode: string; volume_id: string | null; epoch: number }> {
  const [row] = await sql<Array<{ mode: string; volume_id: string | null; epoch: number }>>`SELECT mode, volume_id, epoch FROM calendar_backend_state WHERE id = true`;
  return row;
}

const RUNNING_CONTROL_PLANE: ControlPlaneStatus = {
  running: true, listening: true, policyFile: '/tmp/policy.json', heartbeatFile: '/tmp/heartbeat.json', identitySource: 'remote',
  lastTick: null, lastSuccessAt: null, lastPolicyWriteAt: null, lastHeartbeatAt: null, consecutiveFailures: 0,
};

function tick(ok: boolean): ControlPlaneTick {
  const now = new Date().toISOString();
  return {
    trigger: 'manual', startedAt: now, finishedAt: now, ok, failedStage: ok ? null : 'policy', error: ok ? null : 'EACCES',
    state: null, identity: null,
    policy: ok ? { written: true, previous: 'same', mode: 'shadow', version: 7, reasons: [] } : null,
    heartbeat: ok ? { ts: now } : null,
  };
}

describe('gruppo INIT della F3 contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let probe: RadicaleClient;
  let recorder: ReturnType<typeof recordingTransport>;
  let runtimeClient: RadicaleClient;
  let uploadDir: string;
  const savedUploadEnv = process.env.CAL_MIGRATION_UPLOAD_DIR;

  /** Dipendenze del preflight con il client di servizio e il probe veri. */
  function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
    return {
      client: svc,
      unavailableReason: null,
      principal: P,
      probeClient: probe,
      publicUrl: null,
      publicClient: () => null,
      watch: () => ({ mode: 'remote', reason: 'test' }),
      canary: () => null,
      controlPlane: () => ({ status: null, sync: async () => null }),
      now: () => new Date(),
      ...overrides,
    };
  }

  /** Volume vuoto e stato non inizializzato (ledger compreso). */
  async function wipeVolume(): Promise<void> {
    await rm(join(rad.collectionRoot, P), { recursive: true, force: true });
    await sql`UPDATE calendar_backend_state SET volume_id = NULL, epoch = 0, migration_declarations = '{}'::jsonb WHERE id = true`;
    await sql`DELETE FROM cal_migration_ledger`;
    invalidateIdentityCache();
  }

  async function initialize(): Promise<InitSummary> {
    const run = await testRun<InitParams>('init', { action: 'initialize' });
    return runInit(run.ctx);
  }

  async function collectionNames(): Promise<string[]> {
    return (await readVolumeCollections(svc, P)).collections.map((c) => c.name);
  }

  before(async () => {
    rad = await startRadicale({
      label: 'f3-init',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD, 'caldes-probe': PROBE_PASSWORD } },
      rights: { type: 'from_file', rules: RIGHTS_RULES },
      // sitecustomize dell'immagine: la patch di fedeltà di vobject attiva come in produzione.
      pythonPath: [RADICALE_PLUGINS_DIR],
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    probe = new RadicaleClient({ baseUrl: rad.url, username: 'caldes-probe', password: PROBE_PASSWORD, retries: 0 });
    recorder = recordingTransport();
    runtimeClient = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0, transport: recorder.transport });
    configureRadicaleRuntime({ client: runtimeClient, dataDir: rad.storageDir, principal: P, watch: 'off', identitySource: 'remote' });
    uploadDir = await mkdtemp(join(tmpdir(), 'caldes-f3-upload-'));
    process.env.CAL_MIGRATION_UPLOAD_DIR = uploadDir;
    await resetCalendarBaseline();
    await buildProductionShape(fx, { holidayYears: [2026] });
  });

  after(async () => {
    if (savedUploadEnv === undefined) delete process.env.CAL_MIGRATION_UPLOAD_DIR;
    else process.env.CAL_MIGRATION_UPLOAD_DIR = savedUploadEnv;
    configureRadicaleRuntime(null);
    recorder?.close();
    svc?.close();
    probe?.close();
    await rad?.stop();
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  });

  // ─── Preflight su un volume vuoto ───────────────────────────────

  test('preflight su un volume vuoto: Radicale raggiungibile, login di servizio, identità da inizializzare, probe saltati', async () => {
    const summary = await collectPreflight(sql, deps());
    assert.equal(checkOf(summary, 'RADICALE_CONFIGURED').status, 'pass');
    assert.equal(checkOf(summary, 'RADICALE_REACHABLE').status, 'pass');
    assert.equal(checkOf(summary, 'SERVICE_LOGIN').status, 'pass');
    assert.ok(['pass', 'warn'].includes(checkOf(summary, 'RADICALE_VERSION').status), 'la versione non è mai un fallimento');
    const identity = checkOf(summary, 'IDENTITY');
    assert.equal(identity.status, 'pass');
    assert.equal((identity.detail as { can_initialize?: boolean }).can_initialize, true);
    assert.equal(summary.can_initialize, true);
    assert.equal(summary.identity, 'uninitialized');
    for (const code of ['COLLECTIONS', 'CANARY_COLLECTION', 'PROBE_READONLY', 'PROBE_CANARY_FORBIDDEN'] as const) {
      assert.equal(checkOf(summary, code).status, 'skip', `${code} prima dell'inizializzazione`);
    }
    assert.equal(checkOf(summary, 'VOLUME_WATCH').status, 'confirm');
    assert.equal(checkOf(summary, 'CONTROL_PLANE').status, 'fail', 'control-plane non attivo nel test');
    assert.equal(summary.radicale.reachable, true);
    assert.deepEqual(await readdir(rad.collectionRoot).catch(() => []), [], 'il preflight non crea nulla sul volume');
  });

  // ─── Inizializzazione ───────────────────────────────

  test('inizializzazione: principal, marker ed epoch 1, collezioni con lo slug di oggi (c e f comprese) e dead prop, _canary; journal nei params', async () => {
    recorder.take();
    const run = await testRun<InitParams>('init', { action: 'initialize' });
    const summary = await runInit(run.ctx);
    const [row] = await sql<Array<{ params: { volume_id?: string } }>>`SELECT params FROM cal_migration_runs WHERE id = ${run.ctx.runId}::uuid`;
    assert.equal(row.params.volume_id, summary.volume_id, 'il volume_id del journal è quello registrato');
    assert.equal(summary.action, 'initialize');
    assert.equal(summary.epoch, 1);
    assert.equal(summary.canary, 'created');
    const state = await backendState();
    assert.deepEqual(state, { mode: 'postgres', volume_id: summary.volume_id, epoch: 1 });

    const calendars = await loadMigrationCalendars(sql);
    const bySlug = new Map(calendars.map((c) => [c.slug, c]));
    const volume = await readVolumeCollections(svc, P);
    assert.deepEqual(volume.marker, { volume_id: summary.volume_id, epoch: 1 });
    const present = new Map(volume.collections.map((c) => [c.name, c]));
    for (const slug of ['c', 'f', 'lavoro', 'personale', 'bookings', 'scadenze']) {
      const cal = bySlug.get(slug)!;
      const col = present.get(slug);
      assert.ok(col, `collezione ${slug} creata con il nome dello slug`);
      assert.equal(col.calendar_id_prop, cal.id, `calendar-id di ${slug}`);
      assert.equal(col.role_prop, cal.role, `role di ${slug}`);
      assert.equal(col.is_calendar, true);
      assert.ok(summary.collections.some((p) => p.collectionName === slug && p.status === 'created'));
    }
    assert.equal(present.get('f')?.role_prop, 'holidays');
    assert.equal(present.get('bookings')?.role_prop, 'bookings');
    assert.ok(present.has(CANARY_COLLECTION));
    const methods = recorder.take().map((r) => r.method);
    assert.equal(methods.filter((m) => m === 'MKCOL').length, 1, 'una sola MKCOL: il principal');
    assert.equal(methods.filter((m) => m === 'MKCALENDAR').length, summary.collections.length + 1, 'una MKCALENDAR per collezione e _canary');
    assert.ok(!methods.includes('PUT') && !methods.includes('DELETE'), 'l\'inizializzazione non scrive oggetti');

    // Righe 'collection' del run.
    assert.equal(run.items.length, summary.collections.length + 1);
    assert.ok(run.items.every((i) => i.item_type === 'collection' && i.code === 'CREATED'));

    // Seconda esecuzione: tutto già presente, nessuna creazione.
    const again = await testRun<InitParams>('init', { action: 'create_missing' });
    const second = await runInit(again.ctx);
    assert.ok(second.collections.every((c) => c.status === 'exists'));
    assert.equal(second.canary, 'exists');
    assert.ok(!recorder.take().some((r) => r.method === 'MKCALENDAR' || r.method === 'MKCOL'));

    // Una nuova inizializzazione è rifiutata (volume già registrato).
    await assert.rejects(initialize(), isPrecondition('IDENTITY_NOT_UNINITIALIZED'));
    assert.deepEqual(await backendState(), state);
  });

  test('collezioni mancanti: solo quelle che mancano; una collezione con un\'altra calendar-id è un conflitto mai toccato', async () => {
    const nuovo = await fx.calendar({ key: 'nuovo' });
    const conteso = await fx.calendar({ key: 'conteso' });
    const foreignId = randomUUID();
    await svc.mkcalendar(collectionPath(P, conteso.slug), { displayName: 'Estranea', props: [{ ...DAV_PROPS.calendarId, value: foreignId }] });

    const before = await collectPreflight(sql, deps());
    const collections = checkOf(before, 'COLLECTIONS');
    assert.equal(collections.status, 'warn');
    assert.deepEqual((collections.detail as { missing: string[] }).missing, [nuovo.slug]);
    assert.deepEqual((collections.detail as { conflicts: Array<{ collection_name: string }> }).conflicts.map((c) => c.collection_name), [conteso.slug]);
    assert.deepEqual(before.missing_collections, [nuovo.slug]);

    const run = await testRun<InitParams>('init', { action: 'create_missing' });
    const summary = await runInit(run.ctx);
    const status = Object.fromEntries(summary.collections.map((c) => [c.collectionName, c.status]));
    assert.equal(status[nuovo.slug], 'created');
    assert.equal(status[conteso.slug], 'conflict');
    assert.equal(status.c, 'exists');
    const item = run.items.find((i) => i.collection_name === conteso.slug);
    assert.equal(item?.severity, 'error');
    const props = await svc.readProps(collectionPath(P, conteso.slug), [DAV_PROPS.calendarId]);
    assert.equal(Object.values(props ?? {})[0]?.trim(), foreignId, 'la collezione contesa non è stata toccata');

    // Pulizia: la collezione estranea resta su Radicale ma il calendario sparisce dal piano.
    await sql`UPDATE calendars SET lifecycle = 'deleting' WHERE id = ${conteso.id}`;
  });

  // ─── Preflight dopo l'inizializzazione ───────────────────────────────

  test('preflight dopo l\'inizializzazione: identità ok, collezioni, probe in sola lettura e 403 sulla PUT in _canary', async () => {
    const summary = await collectPreflight(sql, deps({
      watch: () => ({ mode: 'mount', reason: null }),
      canary: () => ({ ok: true, mode: 'mount', reason: null, fsType: 'ext4 (0xef53)', fsLocal: true, mtimeLagMs: 3, checkedAt: new Date() }),
      controlPlane: () => ({ status: RUNNING_CONTROL_PLANE, sync: async () => tick(true) }),
    }));
    assert.equal(checkOf(summary, 'IDENTITY').status, 'pass');
    assert.equal(summary.identity, 'ok');
    assert.equal(summary.can_initialize, false);
    assert.equal(checkOf(summary, 'COLLECTIONS').status, 'pass');
    assert.deepEqual(summary.missing_collections, []);
    assert.equal(checkOf(summary, 'CANARY_COLLECTION').status, 'pass');
    const readonly = checkOf(summary, 'PROBE_READONLY');
    assert.equal(readonly.status, 'pass', readonly.message);
    const privileges = (readonly.detail as { privileges: string[] }).privileges;
    assert.ok(privileges.includes('read') && !privileges.some((p) => ['all', 'write', 'write-content', 'bind', 'unbind'].includes(p)), JSON.stringify(privileges));
    const canary = checkOf(summary, 'PROBE_CANARY_FORBIDDEN');
    assert.equal(canary.status, 'pass', canary.message);
    assert.equal(checkOf(summary, 'VOLUME_WATCH').status, 'pass');
    assert.equal(checkOf(summary, 'CONTROL_PLANE').status, 'pass');
    assert.deepEqual((await readdir(rad.fsPath(P, CANARY_COLLECTION))).filter((n) => n.endsWith('.ics')), [], 'nessuna risorsa del probe in _canary');
  });

  test('preflight con il gate aperto: probe che può scrivere e PUT su _canary accettata falliscono, la risorsa viene rimossa', async () => {
    const open = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    const run = await testRun('preflight', { probe_public_url: false });
    const summary = await runPreflightWith(run.ctx, deps({ probeClient: open }));
    const readonly = checkOf(summary, 'PROBE_READONLY');
    assert.equal(readonly.status, 'fail');
    assert.ok((readonly.detail as { privileges: string[] }).privileges.includes('write'));
    const canary = checkOf(summary, 'PROBE_CANARY_FORBIDDEN');
    assert.equal(canary.status, 'fail');
    assert.match(canary.message, /gate dei device è aperto/);
    assert.ok(summary.blocking.includes('PROBE_READONLY') && summary.blocking.includes('PROBE_CANARY_FORBIDDEN'));
    assert.deepEqual((await readdir(rad.fsPath(P, CANARY_COLLECTION))).filter((n) => n.startsWith('preflight-')), [], 'la PUT riuscita è stata cancellata');
    assert.equal(run.items.find((i) => i.code === 'PROBE_CANARY_FORBIDDEN')?.severity, 'error');
  });

  test('preflight: campanello in remote mode, control-plane fallito, 401 sull\'URL pubblico, app-password riservate', async () => {
    // Remote mode: confirm finché non c'è la dichiarazione.
    let summary = await collectPreflight(sql, deps({ controlPlane: () => ({ status: RUNNING_CONTROL_PLANE, sync: async () => tick(false) }) }));
    assert.equal(checkOf(summary, 'VOLUME_WATCH').status, 'confirm');
    assert.equal(checkOf(summary, 'VOLUME_WATCH').declaration, 'remote_mode_accepted');
    assert.equal(checkOf(summary, 'CONTROL_PLANE').status, 'fail');
    await sql`UPDATE calendar_backend_state SET migration_declarations = ${sql.json({ remote_mode_accepted: { value: { reason: 'volume su NFS' }, at: new Date().toISOString(), by: 'admin:test' } } as never)} WHERE id = true`;
    summary = await collectPreflight(sql, deps());
    assert.equal(checkOf(summary, 'VOLUME_WATCH').status, 'pass');
    assert.equal(checkOf(summary, 'VOLUME_WATCH').declared, true);

    // URL pubblico: 401 per entrambi gli utenti di servizio → pass.
    const wrong = (user: 'caldes-svc' | 'caldes-probe') => new RadicaleClient({ baseUrl: rad.url, username: user, password: 'password-sbagliata', retries: 0 });
    summary = await collectPreflight(sql, deps({ publicUrl: rad.url, publicClient: wrong }));
    assert.equal(checkOf(summary, 'SERVICE_PUBLIC_401').status, 'pass');
    // Un utente di servizio accettato dall'URL pubblico → fail.
    const right = (user: 'caldes-svc' | 'caldes-probe') => new RadicaleClient({ baseUrl: rad.url, username: user, password: user === 'caldes-svc' ? SVC_PASSWORD : PROBE_PASSWORD, retries: 0 });
    summary = await collectPreflight(sql, deps({ publicUrl: rad.url, publicClient: right }));
    assert.equal(checkOf(summary, 'SERVICE_PUBLIC_401').status, 'fail');
    // Non raggiungibile dal container (hairpin): confirm con il comando curl da lanciare sull'host.
    const closed = (user: 'caldes-svc' | 'caldes-probe') => new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', username: user, password: 'x', retries: 0, timeoutMs: 1000 });
    summary = await collectPreflight(sql, deps({ publicUrl: 'http://127.0.0.1:9', publicClient: closed }));
    const unreachable = checkOf(summary, 'SERVICE_PUBLIC_401');
    assert.equal(unreachable.status, 'confirm');
    assert.equal(unreachable.declaration, 'public_401_verified');
    assert.match(String(unreachable.remedy), /curl .*-u caldes-svc/);

    // App-password con username riservato: blocca.
    const app = await fx.appPassword({ username: 'servizio', device: 'Riservata' });
    await sql`UPDATE caldav_app_passwords SET username = 'caldes-svc' WHERE id = ${app.row.id}`;
    summary = await collectPreflight(sql, deps());
    assert.equal(checkOf(summary, 'RESERVED_APP_PASSWORDS').status, 'fail');
    await sql`UPDATE caldav_app_passwords SET revoked_at = now() WHERE id = ${app.row.id}`;
    await sql`UPDATE calendar_backend_state SET migration_declarations = '{}'::jsonb WHERE id = true`;
  });

  // ─── Guardia delle scritture ───────────────────────────────

  test('guardia delle scritture: identità dal marker su Radicale, mode postgres, cambio d\'identità durante il run', async () => {
    const state = await assertMigrationWritable({ db: sql, client: svc, principal: P });
    assert.equal(state.mode, 'postgres');
    assert.equal(state.epoch, 1);

    let clock = 0;
    const guard = await createIdentityGuard({ db: sql, client: svc, principal: P, intervalMs: 60_000, now: () => clock });
    const original = { volume_id: state.volume_id as string, epoch: state.epoch };
    await writeVolumeMarker(svc, P, { volume_id: randomUUID(), epoch: 1 });
    // Entro i 60 secondi senza force nessuna rilettura; con force o dopo 60 s il cambio ferma il run.
    await guard.recheck();
    clock = 61_000;
    await assert.rejects(guard.recheck(), isPrecondition('IDENTITY_NOT_OK', 'IDENTITY_CHANGED'));
    await assert.rejects(guard.recheck({ force: true }), isPrecondition('IDENTITY_NOT_OK', 'IDENTITY_CHANGED'));
    await assert.rejects(assertMigrationWritable({ db: sql, client: svc, principal: P }), isPrecondition('IDENTITY_NOT_OK', 'IDENTITY_NOT_OK'));
    // Collezioni mancanti con l'identità non verificata: rifiutato senza toccare il volume.
    const run = await testRun<InitParams>('init', { action: 'create_missing' });
    await assert.rejects(runInit(run.ctx), (err: unknown) => err instanceof MigrationError && err.code === 'PRECONDITION_FAILED');
    await writeVolumeMarker(svc, P, original);
    await guard.recheck({ force: true });

    // Mode diverso da postgres: mai una scrittura dello strumento.
    await sql`UPDATE calendar_backend_state SET mode = 'radicale' WHERE id = true`;
    try {
      await assert.rejects(assertMigrationWritable({ db: sql, client: svc, principal: P }), isPrecondition('MODE_NOT_POSTGRES', 'MODE_CHANGED'));
      await assert.rejects(guard.recheck({ force: true }), isPrecondition('MODE_NOT_POSTGRES', 'MODE_CHANGED'));
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = 'postgres' WHERE id = true`;
    }
    assert.ok(await assertMigrationWritable({ db: sql, client: svc, principal: P, requireShadow: false }));
    await assert.rejects(assertMigrationWritable({ db: sql, client: svc, principal: P, requireShadow: true }), isPrecondition('SHADOW_DISABLED'));
  });

  // ─── Volume con un'altra identità ───────────────────────────────

  test('volume non vuoto senza marker (Fase 0) o con un marker estraneo: mai inizializzato né adottato, anche con il journal', async () => {
    await wipeVolume();
    // Volume della Fase 0: principal con una collezione e un oggetto, nessun marker.
    await svc.mkcol(principalPath(P));
    await svc.mkcalendar(collectionPath(P, 'vecchio'), { displayName: 'Vecchio calendario' });
    await svc.put(objectPath(P, 'vecchio', 'evento.ics'), eventIcs(uid('fase0')), { ifNoneMatch: '*' });

    await assert.rejects(initialize(), isPrecondition('PRINCIPAL_EXISTS', 'PRINCIPAL_EXISTS'));
    // Anche una "ripresa" con il journal non adotta un principal che non è vuoto.
    const runId = await insertRun('init', { action: 'initialize', volume_id: randomUUID() });
    const resumed = await testRun<InitParams>('init', { action: 'initialize' }, { runId, attempt: 2 });
    await assert.rejects(runInit(resumed.ctx), isPrecondition('PRINCIPAL_EXISTS', 'PRINCIPAL_EXISTS'));
    let volume = await readVolumeCollections(svc, P);
    assert.equal(volume.marker, null, 'nessun marker scritto');
    assert.deepEqual(volume.collections.map((c) => c.name), ['vecchio'], 'nessuna collezione creata');
    assert.deepEqual(await backendState(), { mode: 'postgres', volume_id: null, epoch: 0 });

    let summary = await collectPreflight(sql, deps());
    assert.equal(checkOf(summary, 'IDENTITY').status, 'fail');
    assert.match(checkOf(summary, 'IDENTITY').message, /Fase 0/);
    assert.equal(summary.can_initialize, false);
    let diff = await readIdentityDiff(sql);
    assert.deepEqual(diff.allowed, [], 'nessuna riassegnazione automatica di un volume senza marker');
    assert.equal(diff.volume.collections.find((c) => c.name === 'vecchio')?.items, 1);

    // Marker di un altro stack: rifiutato anche con un journal che porta un altro volume_id.
    const foreign = randomUUID();
    await writeVolumeMarker(svc, P, { volume_id: foreign, epoch: 4 });
    await assert.rejects(initialize(), isPrecondition('PRINCIPAL_EXISTS'));
    volume = await readVolumeCollections(svc, P);
    assert.deepEqual(volume.marker, { volume_id: foreign, epoch: 4 }, 'marker estraneo intatto');
    summary = await collectPreflight(sql, deps());
    assert.equal(checkOf(summary, 'IDENTITY').status, 'fail');
    diff = await readIdentityDiff(sql);
    assert.deepEqual(diff.allowed, ['volume_to_pg']);
    assert.equal(diff.status, 'uninitialized', 'PG non registra alcun volume: la riassegnazione volume_to_pg va confermata');
    assert.deepEqual(diff.volume.marker, { volume_id: foreign, epoch: 4 });
  });

  test('ripresa dell\'inizializzazione dopo un crash: marker già sul volume, principal vuoto, stato già aggiornato', async () => {
    // Crash fra PROPPATCH del marker e UPDATE dello stato.
    await wipeVolume();
    const volumeId = randomUUID();
    const runId = await insertRun('init', { action: 'initialize', volume_id: volumeId });
    await svc.mkcol(principalPath(P));
    await writeVolumeMarker(svc, P, { volume_id: volumeId, epoch: 1 });
    const resumed = await testRun<InitParams>('init', { action: 'initialize' }, { runId, attempt: 2 });
    const summary = await runInit(resumed.ctx);
    assert.equal(summary.volume_id, volumeId);
    assert.deepEqual(await backendState(), { mode: 'postgres', volume_id: volumeId, epoch: 1 });
    assert.ok(summary.collections.some((c) => c.collectionName === 'c' && c.status === 'created'));

    // Crash dopo l'UPDATE: la ripresa trova lo stato già registrato dal proprio journal e completa le collezioni.
    await rm(rad.fsPath(P, 'c'), { recursive: true, force: true });
    const again = await testRun<InitParams>('init', { action: 'initialize' }, { runId, attempt: 3 });
    const third = await runInit(again.ctx);
    assert.equal(third.volume_id, volumeId);
    assert.equal(third.collections.find((c) => c.collectionName === 'c')?.status, 'created');

    // Crash fra MKCOL e PROPPATCH: principal vuoto senza marker.
    await wipeVolume();
    const volume2 = randomUUID();
    const runId2 = await insertRun('init', { action: 'initialize', volume_id: volume2 });
    await svc.mkcol(principalPath(P));
    const resumed2 = await testRun<InitParams>('init', { action: 'initialize' }, { runId: runId2, attempt: 2 });
    const summary2 = await runInit(resumed2.ctx);
    assert.equal(summary2.volume_id, volume2);
    assert.deepEqual((await readVolumeCollections(svc, P)).marker, { volume_id: volume2, epoch: 1 });

    // Senza journal (primo tentativo) lo stesso principal vuoto è rifiutato: potrebbe essere di qualcun altro.
    await wipeVolume();
    await svc.mkcol(principalPath(P));
    await assert.rejects(initialize(), isPrecondition('PRINCIPAL_EXISTS'));
  });

  test('journal scritto prima della MKCOL: un tentativo che fallisce sulla MKCOL lascia il volume_id nei params', async () => {
    await wipeVolume();
    const node = createNodeTransport({ maxSockets: 2 });
    const failing = new RadicaleClient({
      baseUrl: rad.url, password: SVC_PASSWORD, retries: 0,
      transport: async (req) => {
        if (req.method === 'MKCOL') throw Object.assign(new Error('connessione interrotta'), { code: 'ECONNRESET' });
        return node(req);
      },
    });
    configureRadicaleRuntime({ client: failing });
    const run = await testRun<InitParams>('init', { action: 'initialize' });
    try {
      await assert.rejects(runInit(run.ctx));
    } finally {
      configureRadicaleRuntime({ client: runtimeClient });
      failing.close();
      node.close();
    }
    const [row] = await sql<Array<{ params: { volume_id?: string } }>>`SELECT params FROM cal_migration_runs WHERE id = ${run.ctx.runId}::uuid`;
    assert.match(String(row.params.volume_id), /^[0-9a-f-]{36}$/);
    assert.deepEqual(await backendState(), { mode: 'postgres', volume_id: null, epoch: 0 });
    // La ripresa dello stesso run usa lo stesso volume_id.
    const resumed = await testRun<InitParams>('init', { action: 'initialize' }, { runId: run.ctx.runId, attempt: 2 });
    const summary = await runInit(resumed.ctx);
    assert.equal(summary.volume_id, row.params.volume_id);
  });

  // ─── Riassegnazione d'identità ───────────────────────────────

  test('riassegnazione d\'identità nei due versi, mai un epoch che torna indietro, ledger da rivalidare', async () => {
    const start = await backendState();
    const v1 = start.volume_id as string;
    await sql`
      INSERT INTO cal_migration_ledger (calendar_id, collection_name, href, kind, legacy_key, uid)
      VALUES (${randomUUID()}::uuid, 'c', 'esempio.ics', 'event', ${`event:${randomUUID()}`}, 'esempio')
    `;

    // volume_to_pg: PG ripristinato a prima dell'inizializzazione.
    await sql`UPDATE calendar_backend_state SET volume_id = NULL, epoch = 0 WHERE id = true`;
    let diff = await readIdentityDiff(sql);
    assert.deepEqual(diff.allowed, ['volume_to_pg']);
    assert.match(diff.explanation, /ripristinato a prima dell'inizializzazione/);
    const expectedV2P = { pg_volume_id: null, pg_epoch: 0, marker_volume_id: v1, marker_epoch: 1 };
    // Diff cambiato rispetto a quello confermato → rifiutato.
    const stale = await testRun<IdentityParams>('identity', { direction: 'volume_to_pg', expected: { ...expectedV2P, marker_epoch: 2 } });
    await assert.rejects(runIdentityReassign(stale.ctx), isPrecondition('IDENTITY_DIFF_CHANGED'));
    const run = await testRun<IdentityParams>('identity', { direction: 'volume_to_pg', expected: expectedV2P });
    const summary = await runIdentityReassign(run.ctx);
    assert.deepEqual(summary.after, { volume_id: v1, epoch: 1 });
    assert.equal(summary.ledger_revalidation, 1);
    assert.deepEqual(await backendState(), { mode: 'postgres', volume_id: v1, epoch: 1 });
    const [ledger] = await sql<Array<{ revalidate_reason: string | null }>>`SELECT revalidate_reason FROM cal_migration_ledger`;
    assert.equal(ledger.revalidate_reason, 'identity-reassign');
    assert.equal(run.items[0]?.code, 'IDENTITY');
    // Ripresa dello stesso run: già fatto, stesso esito.
    const replay = await testRun<IdentityParams>('identity', { direction: 'volume_to_pg', expected: expectedV2P }, { runId: run.ctx.runId, attempt: 2 });
    assert.deepEqual((await runIdentityReassign(replay.ctx)).after, { volume_id: v1, epoch: 1 });

    // pg_to_volume: volume sostituito da uno vuoto.
    await rm(join(rad.collectionRoot, P), { recursive: true, force: true });
    diff = await readIdentityDiff(sql);
    assert.deepEqual(diff.allowed, ['pg_to_volume']);
    assert.equal(diff.volume.principal_exists, false);
    const p2v = await testRun<IdentityParams>('identity', { direction: 'pg_to_volume', expected: { pg_volume_id: v1, pg_epoch: 1, marker_volume_id: null, marker_epoch: null } });
    const s2 = await runIdentityReassign(p2v.ctx);
    assert.deepEqual(s2.after, { volume_id: v1, epoch: 1 });
    assert.deepEqual((await readVolumeCollections(svc, P)).marker, { volume_id: v1, epoch: 1 });
    const preflight = await collectPreflight(sql, deps());
    assert.equal(checkOf(preflight, 'IDENTITY').status, 'pass');
    assert.ok(preflight.missing_collections.includes('c'), 'le collezioni del volume nuovo mancano');
    const fill = await testRun<InitParams>('init', { action: 'create_missing' });
    const filled = await runInit(fill.ctx);
    assert.ok(filled.collections.filter((c) => c.status === 'created').length >= 6);

    // pg_to_volume con un marker di epoch più alto: l'epoch non torna mai indietro.
    const foreign = randomUUID();
    await writeVolumeMarker(svc, P, { volume_id: foreign, epoch: 3 });
    const up = await testRun<IdentityParams>('identity', { direction: 'pg_to_volume', expected: { pg_volume_id: v1, pg_epoch: 1, marker_volume_id: foreign, marker_epoch: 3 } });
    const s3 = await runIdentityReassign(up.ctx);
    assert.deepEqual(s3.after, { volume_id: v1, epoch: 3 });
    assert.deepEqual(await backendState(), { mode: 'postgres', volume_id: v1, epoch: 3 });
    assert.deepEqual((await readVolumeCollections(svc, P)).marker, { volume_id: v1, epoch: 3 });
    assert.equal((await readIdentityDiff(sql)).status, 'ok');
    assert.deepEqual((await readIdentityDiff(sql)).allowed, []);
    // Niente da riassegnare con l'identità già allineata.
    const noop = await testRun<IdentityParams>('identity', { direction: 'pg_to_volume', expected: { pg_volume_id: v1, pg_epoch: 3, marker_volume_id: v1, marker_epoch: 3 } });
    await assert.rejects(runIdentityReassign(noop.ctx), isPrecondition('IDENTITY_DIFF_CHANGED'));
  });

  // ─── Archivio della Fase 0 ───────────────────────────────

  async function upload(name: string, data: Buffer): Promise<ArchiveParams> {
    const path = join(uploadDir, name);
    await writeFile(path, data, { mode: 0o600 });
    return { upload_path: path, upload_sha256: createHash('sha256').update(data).digest('hex'), original_name: 'archivio-fase0.zip' };
  }

  const ARCHIVE_ZIP = () => buildZip([
    { name: 'lavoro__riunione.ics', data: eventIcs('riunione@fase0', { summary: 'Riunione della Fase 0' }) },
    { name: 'lavoro__serie.ics', data: eventIcs('serie@fase0', { summary: 'Serie della Fase 0', extra: ['RRULE:FREQ=WEEKLY;COUNT=5'] }), method: 'deflate' },
    { name: 'personale__todo.ics', data: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Radicale Fase 0//IT\r\nBEGIN:VTODO\r\nUID:todo@fase0\r\nDTSTAMP:20250101T080000Z\r\nSUMMARY:Da fare\r\nEND:VTODO\r\nEND:VCALENDAR\r\n' },
    { name: 'personale__doppio.ics', data: eventIcs('riunione@fase0', { summary: 'Stesso UID' }) },
    { name: 'rotto.ics', data: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' },
    { name: 'manifest.json', data: '{"items":5}' },
  ]);

  test('archivio della Fase 0: collezione archivio-fase0 non bloccante e fuori dal piano, PUT con If-None-Match, dichiarazione phase0', async () => {
    recorder.take();
    const params = await upload('archivio-1.zip', ARCHIVE_ZIP());
    const run = await testRun('archive', params);
    const summary = await runArchiveImport(run.ctx);
    assert.equal(summary.collection_name, ARCHIVE_COLLECTION_NAME);
    assert.equal(summary.created_collection, true);
    assert.deepEqual([summary.total, summary.imported, summary.unchanged, summary.invalid, summary.duplicates], [5, 3, 0, 1, 1]);
    await assert.rejects(stat(params.upload_path), 'file caricato rimosso a fine run');

    const [row] = await sql<Array<{ id: string; name: string; role: string; origin: string; is_system: boolean; blocks_availability: boolean; ics_feed_enabled: boolean; collection_name: string }>>`
      SELECT id, name, role, origin, is_system, blocks_availability, ics_feed_enabled, collection_name FROM calendars WHERE collection_name = ${ARCHIVE_COLLECTION_NAME}
    `;
    assert.deepEqual({ ...row, id: undefined }, {
      id: undefined, name: ARCHIVE_CALENDAR_NAME, role: 'user', origin: 'migration', is_system: false, blocks_availability: false, ics_feed_enabled: false, collection_name: ARCHIVE_COLLECTION_NAME,
    });
    fx.track('calendarIds', row.id);
    assert.equal(summary.calendar_id, row.id);
    const archived = (await loadMigrationCalendars(sql)).find((c) => c.id === row.id);
    assert.equal(archived?.excluded_reason, 'archive', 'escluso da piano, verifica e shadow');
    assert.ok((await plannedCollections(sql)).some((p) => p.kind === 'archive' && p.calendar_id === row.id));

    const volume = await readVolumeCollections(svc, P);
    assert.equal(volume.collections.find((c) => c.name === ARCHIVE_COLLECTION_NAME)?.calendar_id_prop, row.id);
    const puts = recorder.take().filter((r) => r.method === 'PUT');
    assert.equal(puts.length, 3);
    assert.ok(puts.every((r) => r.ifNoneMatch === '*' && r.ifMatch === null), 'mai sovrascritto: If-None-Match: *');
    const files = (await readdir(rad.fsPath(P, ARCHIVE_COLLECTION_NAME))).filter((n) => n.endsWith('.ics')).sort();
    assert.deepEqual(files, ['lavoro__riunione.ics', 'lavoro__serie.ics', 'personale__todo.ics']);

    const ledger = await sql<Array<{ kind: string; legacy_key: string; href: string; written_etag: string | null; intent_op: string | null }>>`
      SELECT kind, legacy_key, href, written_etag, intent_op FROM cal_migration_ledger WHERE calendar_id = ${row.id} AND deleted_at IS NULL ORDER BY href
    `;
    assert.deepEqual(ledger.map((l) => [l.kind, l.legacy_key, l.href]), [
      ['archive', 'archive:lavoro__riunione.ics', 'lavoro__riunione.ics'],
      ['archive', 'archive:lavoro__serie.ics', 'lavoro__serie.ics'],
      ['archive', 'archive:personale__todo.ics', 'personale__todo.ics'],
    ]);
    assert.ok(ledger.every((l) => l.written_etag && l.intent_op === null));

    const [decl] = await sql<Array<{ phase0: { value: { status: string; archive_run_id: string }; by: string } }>>`
      SELECT migration_declarations->'phase0' AS phase0 FROM calendar_backend_state WHERE id = true
    `;
    assert.equal(decl.phase0.value.status, 'archived');
    assert.equal(decl.phase0.value.archive_run_id, run.ctx.runId);
    assert.equal(decl.phase0.by, 'admin:test-init');
    const preflight = await collectPreflight(sql, deps());
    assert.equal(checkOf(preflight, 'PHASE0_VOLUME').status, 'pass');

    const kinds = new Set(run.items.map((i) => `${i.item_type}:${i.code ?? i.outcome}`));
    assert.ok(kinds.has('anomaly:INVALID_OBJECT') && kinds.has('anomaly:POSSIBLE_DUPLICATE'));
    assert.equal(run.items.filter((i) => i.item_type === 'object' && i.outcome === 'done').length, 3);
  });

  test('archivio: seconda esecuzione tutta unchanged senza PUT, intento pendente adottato, destinazione cambiata mai sovrascritta', async () => {
    recorder.take();
    const second = await testRun('archive', await upload('archivio-2.zip', ARCHIVE_ZIP()));
    const summary = await runArchiveImport(second.ctx);
    assert.equal(summary.created_collection, false);
    assert.deepEqual([summary.imported, summary.unchanged], [0, 3]);
    const requests = recorder.take();
    assert.deepEqual(requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE' || r.method === 'MKCALENDAR'), [], 'nessuna scrittura alla seconda esecuzione');

    // Crash fra la PUT e la chiusura dell'intento: la riga resta con l'intento, la risorsa c'è.
    await sql`
      UPDATE cal_migration_ledger
      SET intent_op = 'update', intent_fingerprint = written_fingerprint, intent_legacy_hash = legacy_hash,
          intent_snapshot = legacy_snapshot, intent_etag = written_etag, intent_at = now(), intent_run_id = ${second.ctx.runId}::uuid
      WHERE legacy_key = 'archive:lavoro__serie.ics'
    `;
    // Un device (o un altro strumento) cambia la riunione nella destinazione.
    const path = objectPath(P, ARCHIVE_COLLECTION_NAME, 'lavoro__riunione.ics');
    const current = await svc.get(path);
    await svc.put(path, eventIcs('riunione@fase0', { summary: 'Cambiata a mano' }), { ifMatch: current.etag as string });

    const third = await testRun('archive', await upload('archivio-3.zip', ARCHIVE_ZIP()));
    const s3 = await runArchiveImport(third.ctx);
    const outcome = Object.fromEntries(third.items.filter((i) => i.item_type === 'object').map((i) => [i.href, [i.action, i.outcome, i.code]]));
    assert.deepEqual(outcome['lavoro__serie.ics'], ['adopt', 'adopted', null], 'intento pendente adottato per fingerprint');
    assert.deepEqual(outcome['lavoro__riunione.ics'], ['conflict', 'conflict', 'TARGET_NEWER'], 'destinazione cambiata: conflitto, mai sovrascritta');
    assert.match((await svc.get(path)).body, /Cambiata a mano/);
    assert.equal(s3.unchanged, 2);
    const [pending] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_migration_ledger WHERE intent_op IS NOT NULL`;
    assert.equal(pending.n, 0);
    // Con un conflitto il file caricato resta per un nuovo tentativo (lo cancella la retention).
    assert.ok(await stat(third.ctx.params.upload_path));
  });

  test('archivio dal tar.gz del vecchio volume (phase0-backup): stessi item dello zip già importati, nessuna PUT', async () => {
    const serie = eventIcs('serie@fase0', { summary: 'Serie della Fase 0', extra: ['RRULE:FREQ=WEEKLY;COUNT=5'] });
    const todo = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Radicale Fase 0//IT\r\nBEGIN:VTODO\r\nUID:todo@fase0\r\nDTSTAMP:20250101T080000Z\r\nSUMMARY:Da fare\r\nEND:VTODO\r\nEND:VCALENDAR\r\n';
    const tar = buildTar([
      { name: 'collection-root/federico/.Radicale.props', data: '{}' },
      { name: 'collection-root/federico/lavoro/.Radicale.props', data: '{"tag": "VCALENDAR"}' },
      { name: 'collection-root/federico/lavoro/serie.ics', data: serie },
      { name: 'collection-root/federico/personale/todo.ics', data: todo },
    ]);
    recorder.take();
    const run = await testRun('archive', await upload('radicale_data.tar.gz', gzipSync(tar)));
    const summary = await runArchiveImport(run.ctx);
    assert.deepEqual([summary.total, summary.imported, summary.unchanged], [2, 0, 2]);
    assert.deepEqual(recorder.take().filter((r) => r.method === 'PUT'), [], 'stessa chiave del ledger dal tar e dallo zip: nessuna nuova scrittura');
    await assert.rejects(stat(run.ctx.params.upload_path), 'file caricato rimosso');
  });

  test('archivio: riga da rivalidare e risorsa sparita mai ricreate senza conferma, sorgente cambiata riscritta con If-Match', async () => {
    const todoText = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Radicale Fase 0//IT\r\nBEGIN:VTODO\r\nUID:todo@fase0\r\nDTSTAMP:20250101T080000Z\r\nSUMMARY:Da fare\r\nEND:VTODO\r\nEND:VCALENDAR\r\n';
    const serieText = (summary: string) => eventIcs('serie@fase0', { summary, extra: ['RRULE:FREQ=WEEKLY;COUNT=5'] });
    const zip = (serieSummary: string) => buildZip([
      { name: 'lavoro__serie.ics', data: serieText(serieSummary), method: 'deflate' },
      { name: 'personale__todo.ics', data: todoText },
    ]);
    const outcomes = (items: Array<{ item_type: string; href?: string | null; action?: string | null; outcome?: string | null; code?: string | null }>) =>
      Object.fromEntries(items.filter((i) => i.item_type === 'object').map((i) => [i.href, [i.action, i.outcome, i.code]]));

    // Import di un backup JSON (o riassegnazione d'identità): righe da rivalidare. Un device cancella il todo.
    await sql`SELECT cal_migration_ledger_require_revalidation('backup-import')`;
    const todoPath = objectPath(P, ARCHIVE_COLLECTION_NAME, 'personale__todo.ics');
    await svc.delete(todoPath, { ifMatch: (await svc.get(todoPath)).etag as string });
    recorder.take();
    const first = await testRun('archive', await upload('archivio-5.zip', zip('Serie della Fase 0')));
    await runArchiveImport(first.ctx);
    let out = outcomes(first.items);
    assert.deepEqual(out['lavoro__serie.ics'], ['adopt', 'adopted', null], 'contenuto invariato: l\'adozione smarca la rivalidazione');
    assert.deepEqual(out['personale__todo.ics'], ['conflict', 'conflict', 'REVALIDATION_REQUIRED'], 'nessuna ricreazione senza conferma');
    assert.deepEqual(recorder.take().filter((r) => r.method === 'PUT'), []);
    const marks = await sql<Array<{ legacy_key: string; revalidate_reason: string | null }>>`
      SELECT legacy_key, revalidate_reason FROM cal_migration_ledger
      WHERE legacy_key IN ('archive:lavoro__serie.ics', 'archive:personale__todo.ics') ORDER BY legacy_key
    `;
    assert.deepEqual(marks.map((m) => [m.legacy_key, m.revalidate_reason]), [['archive:lavoro__serie.ics', null], ['archive:personale__todo.ics', 'backup-import']]);

    // Senza rivalidazione la risorsa sparita resta un conflitto DELETED_IN_TARGET; la sorgente cambiata si riscrive con If-Match.
    await sql`UPDATE cal_migration_ledger SET revalidate_reason = NULL, revalidate_since = NULL WHERE legacy_key = 'archive:personale__todo.ics'`;
    const second = await testRun('archive', await upload('archivio-6.zip', zip('Serie della Fase 0 (riesportata)')));
    const summary = await runArchiveImport(second.ctx);
    out = outcomes(second.items);
    assert.deepEqual(out['personale__todo.ics'], ['conflict', 'conflict', 'DELETED_IN_TARGET']);
    assert.deepEqual(out['lavoro__serie.ics'], ['update', 'done', null]);
    const puts = recorder.take().filter((r) => r.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.ok(puts[0].ifMatch && puts[0].ifNoneMatch === null, 'update con If-Match');
    assert.match((await svc.get(objectPath(P, ARCHIVE_COLLECTION_NAME, 'lavoro__serie.ics'))).body, /riesportata/);
    assert.equal((summary as typeof summary & { updated: number }).updated, 1);
  });

  test('archivio: file con sha256 diverso o fuori dalla cartella dei caricamenti rifiutato, file non valido rimosso', async () => {
    const params = await upload('archivio-4.zip', ARCHIVE_ZIP());
    const bad = await testRun('archive', { ...params, upload_sha256: '0'.repeat(64) });
    await assert.rejects(runArchiveImport(bad.ctx), (err: unknown) => err instanceof MigrationError && err.code === 'VALIDATION_FAILED' && err.details?.run_error_code === 'ARCHIVE_INVALID');
    await assert.rejects(stat(params.upload_path), 'file non corrispondente rimosso');

    const outside = join(tmpdir(), `fuori-${randomUUID()}.zip`);
    await writeFile(outside, ARCHIVE_ZIP(), { mode: 0o600 });
    try {
      const out = await testRun('archive', { upload_path: outside, upload_sha256: createHash('sha256').update(ARCHIVE_ZIP()).digest('hex'), original_name: 'x.zip' });
      await assert.rejects(runArchiveImport(out.ctx), (err: unknown) => err instanceof MigrationError && err.code === 'VALIDATION_FAILED');
      assert.ok(await stat(outside), 'mai rimosso un file fuori dalla cartella della migrazione');
    } finally {
      await rm(outside, { force: true });
    }

    const empty = await upload('vuoto.zip', buildZip([{ name: 'manifest.json', data: '{}' }]));
    const emptyRun = await testRun('archive', empty);
    await assert.rejects(runArchiveImport(emptyRun.ctx), /Archivio vuoto/);
    await assert.rejects(stat(empty.upload_path));
  });

  // ─── Script calendar:radicale-init ───────────────────────────────

  test('scripts/radicale-init.ts: prova a vuoto e --apply delegano a migration/init, rifiuto di un volume estraneo', async () => {
    await wipeVolume();
    const dry = await runRadicaleInit({ db: sql, client: svc, principal: P, apply: false });
    assert.equal(dry.action, 'initialize');
    assert.equal(dry.refused, null);
    assert.equal(dry.result, null);
    for (const slug of ['c', 'f', 'lavoro', 'bookings']) assert.ok(dry.collections.some((c) => c.collection_name === slug));
    assert.ok(dry.collections.some((c) => c.collection_name === ARCHIVE_COLLECTION_NAME), 'archivio della Fase 0 nel piano');
    assert.deepEqual(await readdir(rad.collectionRoot).catch(() => []), [], 'la prova a vuoto non scrive');

    const applied = await runRadicaleInit({ db: sql, client: svc, principal: P, apply: true });
    assert.equal(applied.action, 'initialize');
    assert.equal(applied.result?.epoch, 1);
    assert.equal(applied.result?.canary, 'created');
    assert.ok(applied.result?.collections.some((c) => c.collectionName === 'c' && c.status === 'created'));
    assert.deepEqual(await backendState(), { mode: 'postgres', volume_id: applied.result?.volume_id ?? null, epoch: 1 });

    const missing = await runRadicaleInit({ db: sql, client: svc, principal: P, apply: true });
    assert.equal(missing.action, 'create_missing_collections');
    assert.ok(missing.result?.collections.every((c) => c.status === 'exists'));

    await writeVolumeMarker(svc, P, { volume_id: randomUUID(), epoch: 1 });
    invalidateIdentityCache();
    const refused = await runRadicaleInit({ db: sql, client: svc, principal: P, apply: true });
    assert.equal(refused.action, 'refuse');
    assert.equal(refused.refused?.code, 'identity_not_ok');
    assert.equal(refused.result, null);
  });
});
