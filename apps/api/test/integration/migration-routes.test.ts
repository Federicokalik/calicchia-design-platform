/**
 * Wizard della migrazione da capo a fondo attraverso le route e l'esecutore
 * reale dei run, contro Radicale 3.7.8 reale (routes/calendar/migration.ts,
 * lib/calendar/migration/runs.ts e i moduli dei gruppi INIT, SERIALIZE,
 * APPLY e SHADOW; design §13.2-§13.8, §13.13; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §5, §10 e §11).
 *
 * Dati di forma produttiva (inventario del 2026-10-09). Percorso:
 * preflight su volume vuoto → "Inizializza Radicale" (replay della chiave) →
 * archivio della Fase 0 caricato in multipart → dichiarazioni → preflight
 * pronto → anteprima → apply → nuova anteprima e apply a zero scritture →
 * verifica V1-V5 con accettazione delle differenze attese → shadow acceso con
 * l'apply di recupero → stato di ogni passo a ogni tappa. Postgres resta
 * autorevole: mode sempre postgres, nessuna riga legacy scritta.
 *
 * Il preflight usa le dipendenze reali tranne il control-plane (non avviato
 * nei test) e il campanello (remote mode dichiarata); il worker dei job è
 * sostituito da giri espliciti di runCalendarJobsOnce.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { runCalendarJobsOnce, unregisterCalendarJobHandler } from '../../src/lib/calendar/jobs';
import { type PreflightDeps, runPreflightWith } from '../../src/lib/calendar/migration/preflight';
import { registerMigrationRunJob, setMigrationRunHandlerOverride } from '../../src/lib/calendar/migration/runs';
import { MIGRATION_CONFIRMATIONS, MIGRATION_RUN_JOB_KIND, type MigrationRunContext, type PreflightParams } from '../../src/lib/calendar/migration/types';
import { RadicaleClient } from '../../src/lib/calendar/radicale/client';
import type { ControlPlaneStatus, ControlPlaneTick } from '../../src/lib/calendar/radicale/heartbeat';
import { configureRadicaleRuntime, invalidateIdentityCache } from '../../src/lib/calendar/radicale/sync';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';
import { RADICALE_PLUGINS_DIR, radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';
import { buildProductionShape, buildZip, eventIcs, uid } from '../calendar/_migration-init-shared';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  configureRadicaleRuntime(null);
  setMigrationRunHandlerOverride('preflight', null);
  unregisterCalendarJobHandler(MIGRATION_RUN_JOB_KIND);
  await resetCalendarBaseline();
});
const fx = useFixtures('mig-routes-rad');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f3-routes';
const PROBE_PASSWORD = 'test-only-probe-password-f3-routes';
const BASE = '/api/admin/calendar/migration';

const RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
  '[probe-principal]', 'user: caldes-probe', `collection: ${P}`, 'permissions: R', '',
  '[probe-user-collections]', 'user: caldes-probe', `collection: ${P}/[^_/][^/]*`, 'permissions: r', '',
].join('\n');

const RUNNING_CONTROL_PLANE: ControlPlaneStatus = {
  running: true, listening: true, policyFile: '/tmp/policy.json', heartbeatFile: '/tmp/heartbeat.json', identitySource: 'remote',
  lastTick: null, lastSuccessAt: null, lastPolicyWriteAt: null, lastHeartbeatAt: null, consecutiveFailures: 0,
};

function okTick(): ControlPlaneTick {
  const now = new Date().toISOString();
  return {
    trigger: 'manual', startedAt: now, finishedAt: now, ok: true, failedStage: null, error: null, state: null, identity: null,
    policy: { written: true, previous: 'same', mode: 'shadow', version: 7, reasons: [] }, heartbeat: { ts: now },
  };
}

const key = (): string => `routes-int-${randomUUID()}`;

async function drainJobs(max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    const r = await runCalendarJobsOnce({ limit: 5 });
    if (r.claimed === 0) return;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runToEnd(path: string, body: unknown, opts: { idempotencyKey?: string } = {}): Promise<any> {
  const res = await api.post(`${BASE}${path}`, { auth: 'admin', body: body as object, headers: opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {} });
  assert.equal(res.status, 202, `${path}: ${res.text}`);
  await drainJobs();
  const run = (await api.get(`${BASE}/runs/${res.json.run.id}`, { auth: 'admin' })).json;
  assert.equal(run.status, 'succeeded', `${path}: ${JSON.stringify(run.error)}`);
  return run;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function wizard(): Promise<any> {
  invalidateIdentityCache();
  const res = await api.get(`${BASE}/state`, { auth: 'admin' });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

const statuses = (s: { wizard: { steps: Array<{ status: string }> } }): string[] => s.wizard.steps.map((x) => x.status);

describe('wizard della migrazione attraverso le route, contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let probe: RadicaleClient;
  let uploadDir: string;
  const savedUploadEnv = process.env.CAL_MIGRATION_UPLOAD_DIR;

  before(async () => {
    rad = await startRadicale({
      label: 'f3-routes',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD, 'caldes-probe': PROBE_PASSWORD } },
      rights: { type: 'from_file', rules: RIGHTS_RULES },
      pythonPath: [RADICALE_PLUGINS_DIR],
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    probe = new RadicaleClient({ baseUrl: rad.url, username: 'caldes-probe', password: PROBE_PASSWORD, retries: 0 });
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'off', identitySource: 'remote' });
    uploadDir = await mkdtemp(join(tmpdir(), 'caldes-f3-routes-upload-'));
    process.env.CAL_MIGRATION_UPLOAD_DIR = uploadDir;
    await resetCalendarBaseline();
    await buildProductionShape(fx, { holidayYears: [2026] });
    await sql`UPDATE calendars SET ics_feed_enabled = true WHERE role <> 'subscription'`;

    registerMigrationRunJob();
    const deps = (): PreflightDeps => ({
      client: svc,
      unavailableReason: null,
      principal: P,
      probeClient: probe,
      publicUrl: null,
      publicClient: () => null,
      watch: () => ({ mode: 'remote', reason: 'test' }),
      canary: () => null,
      controlPlane: () => ({ status: RUNNING_CONTROL_PLANE, sync: async () => okTick() }),
      now: () => new Date(),
    });
    setMigrationRunHandlerOverride('preflight', (ctx: MigrationRunContext<PreflightParams>) => runPreflightWith(ctx, deps()));
  });

  after(async () => {
    if (savedUploadEnv === undefined) delete process.env.CAL_MIGRATION_UPLOAD_DIR;
    else process.env.CAL_MIGRATION_UPLOAD_DIR = savedUploadEnv;
    configureRadicaleRuntime(null);
    svc?.close();
    probe?.close();
    await rad?.stop();
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  });

  test('dal preflight allo shadow: run asincroni, conferme, idempotenza e stato dei passi a ogni tappa', async () => {
    const legacyBefore = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_events`;

    // 1. Preflight su un volume vuoto: si propone l'inizializzazione.
    let s = await wizard();
    assert.equal(s.radicale.configured, true);
    // Dalla F4 il passo 6 (passaggio) esiste: bloccato finché i criteri del cutover non sono soddisfatti.
    assert.deepEqual(statuses(s), ['todo', 'locked', 'locked', 'locked', 'locked', 'locked']);
    const pf1 = await runToEnd('/preflight', { probe_public_url: false });
    assert.equal(pf1.summary.can_initialize, true);
    assert.equal(pf1.summary.identity, 'uninitialized');
    s = await wizard();
    assert.equal(s.wizard.steps[0].status, 'attention');
    assert.equal(s.wizard.steps[0].actions.find((a: { id: string }) => a.id === 'initialize').enabled, true);

    // 2. Inizializzazione con conferma e chiave; il replay restituisce lo stesso run.
    const initKey = key();
    const init = await runToEnd('/init', { action: 'initialize', confirm: MIGRATION_CONFIRMATIONS.initialize }, { idempotencyKey: initKey });
    assert.equal(init.summary.epoch, 1);
    const replay = await api.post(`${BASE}/init`, { auth: 'admin', body: { action: 'initialize', confirm: MIGRATION_CONFIRMATIONS.initialize }, headers: { 'Idempotency-Key': initKey } });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.run.id, init.id);
    const again = await api.post(`${BASE}/init`, { auth: 'admin', body: { action: 'initialize', confirm: MIGRATION_CONFIRMATIONS.initialize }, headers: { 'Idempotency-Key': key() } });
    assert.equal(again.status, 409);
    assert.deepEqual(again.json.details.reasons, ['IDENTITY_NOT_UNINITIALIZED']);
    s = await wizard();
    assert.equal(s.identity.status, 'ok');
    assert.equal(s.backend.epoch, 1);
    const items = await api.get(`${BASE}/runs/${init.id}/items`, { auth: 'admin', query: { item_type: 'collection' } });
    assert.ok(items.json.items.some((i: { collection_name: string }) => i.collection_name === 'f'), 'collezione f con lo slug di oggi');

    // 3. Archivio della Fase 0 in multipart: run asincrono, file rimosso, dichiarazione phase0 = archived.
    const zip = buildZip([{ name: 'personale__evento.ics', data: eventIcs(uid('routes')) }]);
    const form = new FormData();
    form.set('file', new File([zip], 'archivio-fase0.zip', { type: 'application/zip' }));
    form.set('confirm', MIGRATION_CONFIRMATIONS.archive);
    const upload = await api.post(`${BASE}/phase0/archive`, { auth: 'admin', body: form, headers: { 'Idempotency-Key': key() } });
    assert.equal(upload.status, 202, upload.text);
    await drainJobs();
    const archive = (await api.get(`${BASE}/runs/${upload.json.run.id}`, { auth: 'admin' })).json;
    assert.equal(archive.status, 'succeeded', JSON.stringify(archive.error));
    assert.equal(archive.summary.imported, 1);
    assert.deepEqual(await readdir(uploadDir), [], 'il file caricato si cancella a fine run');

    // 4. Dichiarazioni che sbloccano i controlli da confermare.
    for (const body of [
      { key: 'remote_mode_accepted', value: { reason: 'stack di test senza mount' }, confirm: MIGRATION_CONFIRMATIONS.declare },
      { key: 'public_401_verified', value: { method: 'curl' }, confirm: MIGRATION_CONFIRMATIONS.declare },
      { key: 'backup_verified', value: { note: 'backup del test' }, confirm: MIGRATION_CONFIRMATIONS.declare },
    ]) {
      const res = await api.post(`${BASE}/declarations`, { auth: 'admin', body });
      assert.equal(res.status, 200, res.text);
    }
    s = await wizard();
    assert.equal(s.declarations.phase0.value.status, 'archived');
    assert.equal(s.wizard.steps[0].status, 'attention', 'preflight da ripetere dopo init e dichiarazioni');

    // 5. Preflight pronto: passo 1 concluso.
    const pf2 = await runToEnd('/preflight', { probe_public_url: false });
    assert.equal(pf2.summary.ready, true, JSON.stringify(pf2.summary.checks.filter((c: { status: string }) => c.status === 'fail' || c.status === 'confirm')));
    s = await wizard();
    assert.deepEqual(statuses(s).slice(0, 3), ['done', 'todo', 'locked']);
    assert.equal(s.wizard.current_step, 'anteprima');

    // 6. Anteprima e apply.
    const plan = await runToEnd('/plan', { options: { orphans: 'convert' } });
    assert.ok(plan.summary.writes > 10, `scritture previste: ${plan.summary.writes}`);
    assert.equal(plan.summary.totals.conflict, 0);
    assert.ok(plan.summary.preview.calendars.length >= 6);
    s = await wizard();
    assert.deepEqual(statuses(s).slice(1, 3), ['done', 'todo']);
    const badHash = await api.post(`${BASE}/apply`, {
      auth: 'admin', body: { plan_run_id: plan.id, expect_plan_hash: 'f'.repeat(64), confirm: MIGRATION_CONFIRMATIONS.apply }, headers: { 'Idempotency-Key': key() },
    });
    assert.equal(badHash.status, 202);
    await drainJobs();
    const changed = (await api.get(`${BASE}/runs/${badHash.json.run.id}`, { auth: 'admin' })).json;
    assert.equal(changed.status, 'failed');
    assert.equal(changed.error.code, 'PLAN_CHANGED', 'piano cambiato: si ferma prima di scrivere');
    const apply1 = await runToEnd('/apply', { plan_run_id: plan.id, confirm: MIGRATION_CONFIRMATIONS.apply }, { idempotencyKey: key() });
    assert.equal(apply1.plan_run_id, plan.id);
    assert.equal(apply1.summary.writes.create, plan.summary.totals.create);
    assert.equal(apply1.summary.zero_writes, false);
    s = await wizard();
    assert.equal(s.wizard.steps[2].status, 'attention');
    assert.ok(s.wizard.steps[2].blocking.includes('Ripeti per verificare zero scritture'));

    // 7. Seconda esecuzione: nuova anteprima, apply a zero scritture.
    const plan2 = await runToEnd('/plan', {});
    assert.equal(plan2.summary.writes, 0);
    const apply2 = await runToEnd('/apply', { plan_run_id: plan2.id, confirm: MIGRATION_CONFIRMATIONS.apply }, { idempotencyKey: key() });
    assert.equal(apply2.summary.zero_writes, true);
    s = await wizard();
    assert.deepEqual(statuses(s).slice(2, 4), ['done', 'todo']);

    // 8. Verifica V1-V5, accettazione delle sole differenze attese.
    const verify = await runToEnd('/verify', {});
    assert.notEqual(verify.summary.overall, 'red', JSON.stringify(verify.summary.calendars));
    s = await wizard();
    if (verify.summary.overall === 'yellow') {
      assert.equal(s.wizard.steps[3].status, 'attention');
      const accepted = await api.post(`${BASE}/runs/${verify.id}/accept`, { auth: 'admin', body: { all_expected: true, confirm: MIGRATION_CONFIRMATIONS.accept } });
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.json.acceptable, true);
      s = await wizard();
    }
    assert.equal(s.wizard.steps[3].status, 'done', JSON.stringify(s.wizard.steps[3]));
    assert.equal(s.wizard.steps[4].status, 'todo');
    assert.equal(s.wizard.steps[4].actions.find((a: { id: string }) => a.id === 'shadow_on').enabled, true);
    const report = await api.get(`${BASE}/runs/${verify.id}/report`, { auth: 'admin', query: { format: 'csv' } });
    assert.equal(report.status, 200);

    // 9. Shadow acceso con l'apply di recupero (zero scritture: la verifica resta valida).
    const on = await api.post(`${BASE}/shadow`, { auth: 'admin', body: { enabled: true, confirm: MIGRATION_CONFIRMATIONS.shadowOn } });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.shadow_enabled, true);
    assert.ok(on.json.catch_up_run, 'apply di recupero accodato');
    await drainJobs();
    const catchUp = (await api.get(`${BASE}/runs/${on.json.catch_up_run.id}`, { auth: 'admin' })).json;
    assert.equal(catchUp.status, 'succeeded', JSON.stringify(catchUp.error));
    assert.equal(catchUp.trigger, 'shadow');
    s = await wizard();
    assert.equal(s.backend.shadow_enabled, true);
    assert.equal(s.wizard.steps[3].status, 'done', 'un apply a zero scritture non invalida la verifica');
    assert.equal(s.wizard.steps[4].status, 'running');
    assert.equal(s.wizard.steps[5].status, 'locked');
    assert.equal(s.cutover.available, false);
    const parity = await api.get(`${BASE}/parity`, { auth: 'admin' });
    assert.equal(parity.json.shadow_enabled, true);

    // Spegnimento sempre ammesso, senza conferma.
    const off = await api.post(`${BASE}/shadow`, { auth: 'admin', body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.json.shadow_enabled, false);

    // Postgres resta autorevole: mode postgres, nessuna riga legacy aggiunta dallo strumento.
    const [{ mode }] = await sql<Array<{ mode: string }>>`SELECT mode FROM calendar_backend_state WHERE id = true`;
    assert.equal(mode, 'postgres');
    const legacyAfter = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_events`;
    assert.equal(legacyAfter[0].n, legacyBefore[0].n);
    const audits = await sql<Array<{ op: string }>>`SELECT metadata->>'operation' AS op FROM audit_logs WHERE table_name = 'calendar_migration'`;
    const ops = new Set(audits.map((a) => a.op));
    for (const op of ['preflight', 'init_initialize', 'phase0_archive', 'declare', 'plan', 'apply', 'verify', 'accept', 'shadow_on', 'shadow_off']) {
      if (op === 'accept' && verify.summary.overall !== 'yellow') continue;
      assert.ok(ops.has(op), `audit di ${op}`);
    }
  });
});
