/**
 * Route e run dello strumento di migrazione della F3, senza Radicale
 * (routes/calendar/migration.ts e lib/calendar/migration/runs.ts; design
 * §13.2, §13.13; contratto docs/calendar-radicale/contracts/f3-modules.md
 * §5, §10 e §11).
 *
 * Casi: JWT admin obbligatorio; stato del wizard (6 passi, passaggio sempre
 * disabilitato, criteri del cutover informativi); preflight senza Radicale
 * chiuso subito con RADICALE_CONFIGURED fallito; conferme digitate esatte;
 * chiave d'idempotenza (obbligatoria per i run che scrivono, replay con la
 * stessa richiesta, IDEMPOTENCY_KEY_REUSED con una diversa); 503 senza
 * Radicale per i run asincroni; MIGRATION_BUSY con il run in corso;
 * PHASE_NOT_AVAILABLE per cutover, rollback e finalize; dichiarazioni (con
 * CONFERMO per quelle che tolgono un controllo) e audit; paginazione e filtri
 * delle righe; download del report; annullamento; ciclo di vita del run con
 * l'esecutore reale dei job (successo, errore senza dati personali,
 * annullamento a metà, ripresa dopo il lease scaduto con seq continuo,
 * interrupted dal reaper, run queued senza job), verifica accodata dopo un
 * apply con follow_up_verify, lock cal-migration; derivazione dei passi del
 * wizard per ogni stato; validazioni di archivio, shadow, accettazione e
 * iscrizioni.
 *
 * Il runtime di Radicale, quando serve "configurato", ha un client con un
 * trasporto che fallisce sempre (nessuna rete): le route vedono Radicale
 * configurato, le letture d'identità risultano non verificate.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { runCalendarJobsOnce, unregisterCalendarJobHandler } from '../../src/lib/calendar/jobs';
import { RadicaleClient, TransportError } from '../../src/lib/calendar/radicale/client';
import { configureRadicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import {
  createMigrationRun,
  deriveWizardSteps,
  MigrationLockBusyError,
  reapInterruptedRuns,
  recordCompletedRun,
  registerMigrationRunJob,
  setMigrationRunHandlerOverride,
  withMigrationLock,
  type WizardStateInputs,
} from '../../src/lib/calendar/migration/runs';
import {
  DEFAULT_MIGRATION_OPTIONS,
  MIGRATION_CONFIRMATIONS,
  MIGRATION_LIMITS,
  MIGRATION_RUN_JOB_KIND,
  MigrationError,
  type MigrationBackendState,
  type MigrationItemInput,
  type MigrationRunContext,
  type MigrationRunKind,
  WIZARD_STEP_IDS,
} from '../../src/lib/calendar/migration/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { api, ensureTestAdmin, signTestToken, TEST_ADMIN } from '../helpers/http';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  configureRadicaleRuntime(null);
  for (const kind of ['preflight', 'init', 'inventory', 'plan', 'apply', 'verify'] as MigrationRunKind[]) setMigrationRunHandlerOverride(kind, null);
  unregisterCalendarJobHandler(MIGRATION_RUN_JOB_KIND);
  await resetCalendarBaseline();
});

const BASE = '/api/admin/calendar/migration';
let keySeq = 0;
const newKey = (): string => `test-key-${Date.now().toString(36)}-${(keySeq++).toString(36)}-${randomUUID().slice(0, 8)}`;

function offlineClient(): RadicaleClient {
  return new RadicaleClient({
    baseUrl: 'http://127.0.0.1:9',
    password: 'test-only-offline',
    retries: 0,
    timeoutMs: 1_000,
    transport: async () => {
      throw new TransportError('network', 'Radicale non raggiungibile (test senza rete)', false, 'ECONNREFUSED');
    },
  });
}

/** Radicale "configurato" ma irraggiungibile: le route accettano i run asincroni. */
function withOfflineRadicale(): void {
  configureRadicaleRuntime({ client: offlineClient(), principal: 'federico', watch: 'off', identitySource: 'remote' });
}

function withoutRadicale(): void {
  configureRadicaleRuntime(null);
}

async function clearRuns(): Promise<void> {
  await sql`DELETE FROM cal_jobs WHERE kind = ${MIGRATION_RUN_JOB_KIND}`;
  await sql`DELETE FROM cal_migration_runs`;
}

async function runJobsUntilIdle(max = 5): Promise<void> {
  for (let i = 0; i < max; i++) {
    const r = await runCalendarJobsOnce({ limit: 5 });
    if (r.claimed === 0) return;
  }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('condizione non raggiunta in tempo');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('autenticazione', () => {
  test('senza JWT 401, con un JWT non admin 403', async () => {
    const anon = await api.get(`${BASE}/state`);
    assert.equal(anon.status, 401);
    const client = await api.get(`${BASE}/state`, { auth: { bearer: await signTestToken({ role: 'client' }) } });
    assert.equal(client.status, 403);
  });
});

describe('GET /state', () => {
  test('database appena migrato: 6 passi, prerequisiti da fare, passaggio disabilitato con i criteri', async () => {
    withoutRadicale();
    await clearRuns();
    const res = await api.get(`${BASE}/state`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    const s = res.json;
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(s.contract_version, 1);
    assert.equal(s.phase, 'F3');
    assert.equal(s.backend.mode, 'postgres');
    assert.equal(s.backend.shadow_enabled, false);
    assert.equal(s.backend.epoch, 0);
    assert.equal(s.radicale.configured, false);
    assert.equal(s.identity.status, 'uninitialized');
    assert.equal(s.active_run, null);
    assert.deepEqual(s.last_runs, {});
    assert.deepEqual(s.ledger, { live: 0, pending_intents: 0, revalidation_pending: 0 });
    assert.deepEqual(s.wizard.steps.map((x: { id: string }) => x.id), [...WIZARD_STEP_IDS]);
    assert.equal(s.wizard.current_step, 'prerequisiti');
    const [s1, s2, s3, s4, s5, s6] = s.wizard.steps;
    assert.equal(s1.status, 'todo');
    assert.equal(s2.status, 'locked');
    assert.equal(s3.status, 'locked');
    assert.equal(s4.status, 'locked');
    assert.equal(s5.status, 'locked');
    assert.equal(s6.status, 'disabled');
    const act = (step: { actions: Array<{ id: string; enabled: boolean; confirm: string | null; reason: string | null }> }, id: string) => step.actions.find((a) => a.id === id)!;
    assert.equal(act(s1, 'preflight').enabled, true);
    assert.equal(act(s1, 'initialize').enabled, false);
    assert.equal(act(s1, 'initialize').confirm, MIGRATION_CONFIRMATIONS.initialize);
    assert.match(act(s1, 'initialize').reason!, /Radicale non configurato/);
    assert.equal(act(s6, 'cutover').enabled, false);
    assert.equal(act(s6, 'cutover').confirm, MIGRATION_CONFIRMATIONS.cutover);
    assert.equal(s.cutover.available, false);
    assert.equal(s.cutover.phase, 'F4');
    assert.deepEqual(s.cutover.criteria.map((c: { id: string }) => c.id), ['verify_acceptable', 'shadow_parity', 'device_matrix', 'backup_recent', 'no_open_conflicts']);
    assert.ok(s.cutover.criteria.every((c: { ok: boolean; label: string }) => typeof c.ok === 'boolean' && c.label.length > 0));
  });
});

describe('POST /preflight senza Radicale', () => {
  test('run chiuso subito con RADICALE_CONFIGURED fallito; replay e riuso della chiave', async () => {
    withoutRadicale();
    await clearRuns();
    const key = newKey();
    const res = await api.post(`${BASE}/preflight`, { auth: 'admin', body: { probe_public_url: false }, headers: { 'Idempotency-Key': key } });
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json.replayed, false);
    const run = res.json.run;
    assert.equal(run.kind, 'preflight');
    assert.equal(run.status, 'succeeded');
    assert.equal(run.trigger, 'admin');
    assert.equal(run.requested_by, `admin:${TEST_ADMIN.id}`);
    assert.equal(run.summary.ready, false);
    assert.ok(run.summary.blocking.includes('RADICALE_CONFIGURED'));
    const check = run.summary.checks.find((c: { code: string }) => c.code === 'RADICALE_CONFIGURED');
    assert.equal(check.status, 'fail');

    const items = await api.get(`${BASE}/runs/${run.id}/items`, { auth: 'admin', query: { item_type: 'check' } });
    assert.equal(items.status, 200);
    assert.equal(items.json.total, run.summary.checks.length);
    assert.ok(items.json.items.some((i: { code: string; severity: string }) => i.code === 'RADICALE_CONFIGURED' && i.severity === 'error'));

    const replay = await api.post(`${BASE}/preflight`, { auth: 'admin', body: { probe_public_url: false }, headers: { 'Idempotency-Key': key } });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.run.id, run.id);

    const reused = await api.post(`${BASE}/preflight`, { auth: 'admin', body: { probe_public_url: true }, headers: { 'Idempotency-Key': key } });
    assert.equal(reused.status, 409);
    assert.equal(reused.json.code, 'IDEMPOTENCY_KEY_REUSED');

    const bad = await api.post(`${BASE}/preflight`, { auth: 'admin', body: {}, headers: { 'Idempotency-Key': 'corta' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'VALIDATION_FAILED');

    // Il passo 1 diventa bloccato con il controllo fallito.
    const state = (await api.get(`${BASE}/state`, { auth: 'admin' })).json;
    assert.equal(state.wizard.steps[0].status, 'blocked');
    assert.equal(state.wizard.steps[0].last_run_id, run.id);
    assert.equal(state.last_runs.preflight.id, run.id);
  });
});

describe('conferme, chiavi e precondizioni', () => {
  test('init: azione, conferma esatta, chiave obbligatoria, 503 senza Radicale', async () => {
    withoutRadicale();
    await clearRuns();
    const bad = await api.post(`${BASE}/init`, { auth: 'admin', body: { action: 'format', confirm: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'VALIDATION_FAILED');

    const noConfirm = await api.post(`${BASE}/init`, { auth: 'admin', body: { action: 'initialize', confirm: 'inizializza radicale' } });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.json.code, 'CONFIRMATION_REQUIRED');
    assert.equal(noConfirm.json.details.expected, MIGRATION_CONFIRMATIONS.initialize);

    const createMissing = await api.post(`${BASE}/init`, { auth: 'admin', body: { action: 'create_missing', confirm: MIGRATION_CONFIRMATIONS.initialize } });
    assert.equal(createMissing.json.details.expected, MIGRATION_CONFIRMATIONS.createCollections);

    const noKey = await api.post(`${BASE}/init`, { auth: 'admin', body: { action: 'initialize', confirm: MIGRATION_CONFIRMATIONS.initialize } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const noRadicale = await api.post(`${BASE}/init`, {
      auth: 'admin', body: { action: 'initialize', confirm: MIGRATION_CONFIRMATIONS.initialize }, headers: { 'Idempotency-Key': newKey() },
    });
    assert.equal(noRadicale.status, 503);
    assert.equal(noRadicale.json.code, 'RADICALE_NOT_CONFIGURED');

    const keyInBody = await api.post(`${BASE}/init`, {
      auth: 'admin', body: { action: 'initialize', confirm: MIGRATION_CONFIRMATIONS.initialize, idempotency_key: newKey() },
    });
    assert.equal(keyInBody.status, 503, 'la chiave nel corpo vale come quella nell\'header');

    const mismatch = await api.post(`${BASE}/init`, {
      auth: 'admin', body: { action: 'initialize', confirm: MIGRATION_CONFIRMATIONS.initialize, idempotency_key: newKey() }, headers: { 'Idempotency-Key': newKey() },
    });
    assert.equal(mismatch.status, 400);
  });

  test('init initialize con il volume non verificabile: precondizione dal diff d\'identità', async () => {
    withOfflineRadicale();
    await clearRuns();
    await sql`UPDATE calendar_backend_state SET volume_id = ${randomUUID()}::uuid, epoch = 1 WHERE id = true`;
    try {
      const res = await api.post(`${BASE}/init`, {
        auth: 'admin', body: { action: 'initialize', confirm: MIGRATION_CONFIRMATIONS.initialize }, headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.code, 'PRECONDITION_FAILED');
      assert.deepEqual(res.json.details.reasons, ['IDENTITY_NOT_UNINITIALIZED']);

      const missing = await api.post(`${BASE}/init`, {
        auth: 'admin', body: { action: 'create_missing', confirm: MIGRATION_CONFIRMATIONS.createCollections }, headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(missing.status, 409);
      assert.deepEqual(missing.json.details.reasons, ['IDENTITY_NOT_OK']);
    } finally {
      await sql`UPDATE calendar_backend_state SET volume_id = NULL, epoch = 0 WHERE id = true`;
      withoutRadicale();
    }
  });

  test('apply: anteprima obbligatoria, FORZA per gli item forzati, chiave obbligatoria', async () => {
    withOfflineRadicale();
    await clearRuns();
    try {
      const noPlan = await api.post(`${BASE}/apply`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.apply } });
      assert.equal(noPlan.status, 400);

      const planRunId = randomUUID();
      const noConfirm = await api.post(`${BASE}/apply`, { auth: 'admin', body: { plan_run_id: planRunId, confirm: 'applica' } });
      assert.equal(noConfirm.json.code, 'CONFIRMATION_REQUIRED');
      assert.equal(noConfirm.json.details.expected, MIGRATION_CONFIRMATIONS.apply);

      const force = await api.post(`${BASE}/apply`, {
        auth: 'admin', body: { plan_run_id: planRunId, confirm: MIGRATION_CONFIRMATIONS.apply, force_codes: ['TARGET_NEWER'] },
      });
      assert.equal(force.json.code, 'CONFIRMATION_REQUIRED');
      assert.equal(force.json.details.expected, MIGRATION_CONFIRMATIONS.force);

      const notForceable = await api.post(`${BASE}/apply`, {
        auth: 'admin', body: { plan_run_id: planRunId, confirm: MIGRATION_CONFIRMATIONS.apply, force_codes: ['COLLECTION_MISSING'], confirm_force: 'FORZA' },
      });
      assert.equal(notForceable.status, 400);
      assert.equal(notForceable.json.code, 'VALIDATION_FAILED');

      const noKey = await api.post(`${BASE}/apply`, { auth: 'admin', body: { plan_run_id: planRunId, confirm: MIGRATION_CONFIRMATIONS.apply } });
      assert.equal(noKey.json.code, 'IDEMPOTENCY_KEY_REQUIRED');

      const missingPlan = await api.post(`${BASE}/apply`, {
        auth: 'admin', body: { plan_run_id: planRunId, confirm: MIGRATION_CONFIRMATIONS.apply }, headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(missingPlan.status, 409);
      assert.deepEqual(missingPlan.json.details.reasons, ['PLAN_REQUIRED']);

      // Anteprima vecchia di più di 24 ore → PLAN_STALE; anomalia bloccante → PREFLIGHT_BLOCKING.
      const hash = 'a'.repeat(64);
      const [old] = await sql<Array<{ id: string }>>`
        INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, started_at, finished_at, created_at)
        VALUES ('plan', 'succeeded', 'admin', 'admin:test', ${sql.json({ scope: {}, options: DEFAULT_MIGRATION_OPTIONS } as never)},
                ${sql.json({ plan_hash: hash, preview: { blocking: [] } } as never)}, now() - interval '30 hours', now() - interval '30 hours', now() - interval '30 hours')
        RETURNING id::text AS id
      `;
      const stale = await api.post(`${BASE}/apply`, {
        auth: 'admin', body: { plan_run_id: old.id, confirm: MIGRATION_CONFIRMATIONS.apply }, headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(stale.status, 409);
      assert.deepEqual(stale.json.details.reasons, ['PLAN_STALE']);

      const [blocked] = await sql<Array<{ id: string }>>`
        INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, started_at, finished_at)
        VALUES ('plan', 'succeeded', 'admin', 'admin:test', ${sql.json({ scope: {}, options: DEFAULT_MIGRATION_OPTIONS } as never)},
                ${sql.json({ plan_hash: hash, preview: { blocking: ['COLLECTION_NAME_INVALID'] } } as never)}, now(), now())
        RETURNING id::text AS id
      `;
      const blocking = await api.post(`${BASE}/apply`, {
        auth: 'admin', body: { plan_run_id: blocked.id, confirm: MIGRATION_CONFIRMATIONS.apply }, headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(blocking.status, 409);
      assert.deepEqual(blocking.json.details.reasons, ['PREFLIGHT_BLOCKING']);

      // Anteprima valida ma identità non verificata (Radicale irraggiungibile, volume inizializzato in PG).
      await sql`UPDATE calendar_backend_state SET volume_id = ${randomUUID()}::uuid, epoch = 1 WHERE id = true`;
      const [fresh] = await sql<Array<{ id: string }>>`
        INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, started_at, finished_at)
        VALUES ('plan', 'succeeded', 'admin', 'admin:test', ${sql.json({ scope: {}, options: DEFAULT_MIGRATION_OPTIONS } as never)},
                ${sql.json({ plan_hash: hash, preview: { blocking: [] } } as never)}, now(), now())
        RETURNING id::text AS id
      `;
      const identity = await api.post(`${BASE}/apply`, {
        auth: 'admin', body: { plan_run_id: fresh.id, confirm: MIGRATION_CONFIRMATIONS.apply }, headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(identity.status, 409);
      assert.deepEqual(identity.json.details.reasons, ['IDENTITY_NOT_OK']);
    } finally {
      await sql`UPDATE calendar_backend_state SET volume_id = NULL, epoch = 0 WHERE id = true`;
      withoutRadicale();
    }
  });

  test('plan: preflight riuscito e senza blocchi richiesto; opzioni validate', async () => {
    withOfflineRadicale();
    await clearRuns();
    try {
      const badOptions = await api.post(`${BASE}/plan`, { auth: 'admin', body: { options: { orphans: 'boh' } } });
      assert.equal(badOptions.status, 400);
      const noPreflight = await api.post(`${BASE}/plan`, { auth: 'admin', body: {} });
      assert.equal(noPreflight.status, 409);
      assert.deepEqual(noPreflight.json.details.reasons, ['PREFLIGHT_REQUIRED']);
      await sql`
        INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, started_at, finished_at)
        VALUES ('preflight', 'succeeded', 'admin', 'admin:test', '{}'::jsonb, ${sql.json({ ready: false, blocking: ['BACKUP_RECENT'], checks: [] } as never)}, now(), now())
      `;
      const blocked = await api.post(`${BASE}/plan`, { auth: 'admin', body: {} });
      assert.equal(blocked.status, 409);
      assert.deepEqual(blocked.json.details.reasons, ['PREFLIGHT_BLOCKING']);
      assert.deepEqual(blocked.json.details.blocking, ['BACKUP_RECENT']);
      const badScope = await api.post(`${BASE}/plan`, { auth: 'admin', body: { scope: { calendar_ids: ['non-uuid'] } } });
      assert.equal(badScope.status, 400);
    } finally {
      withoutRadicale();
    }
  });

  test('verify, inventory e identità: validazioni', async () => {
    withOfflineRadicale();
    await clearRuns();
    try {
      const levels = await api.post(`${BASE}/verify`, { auth: 'admin', body: { levels: ['V9'] } });
      assert.equal(levels.status, 400);
      const days = await api.post(`${BASE}/verify`, { auth: 'admin', body: { v4_days: 0 } });
      assert.equal(days.status, 400);
      const dir = await api.post(`${BASE}/identity/reassign`, { auth: 'admin', body: { direction: 'sideways', confirm: MIGRATION_CONFIRMATIONS.identityReassign } });
      assert.equal(dir.status, 400);
      const confirm = await api.post(`${BASE}/identity/reassign`, { auth: 'admin', body: { direction: 'pg_to_volume', confirm: 'RIASSEGNA IDENTITA' } });
      assert.equal(confirm.json.code, 'CONFIRMATION_REQUIRED');
      assert.equal(confirm.json.details.expected, MIGRATION_CONFIRMATIONS.identityReassign);
      const expected = await api.post(`${BASE}/identity/reassign`, { auth: 'admin', body: { direction: 'pg_to_volume', confirm: MIGRATION_CONFIRMATIONS.identityReassign, expected: 'x' } });
      assert.equal(expected.status, 400);
      const identity = await api.get(`${BASE}/identity`, { auth: 'admin' });
      assert.equal(identity.status, 200);
      assert.equal(identity.json.status, 'uninitialized');
      assert.ok(identity.json.volume.read_error, 'lettura del volume non riuscita senza rete');
    } finally {
      withoutRadicale();
    }
  });

  test('cutover, rollback e finalize: 409 PHASE_NOT_AVAILABLE', async () => {
    for (const path of ['/cutover', '/rollback/preview', '/rollback', '/finalize']) {
      const res = await api.post(`${BASE}${path}`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover } });
      assert.equal(res.status, 409, path);
      assert.equal(res.json.code, 'PHASE_NOT_AVAILABLE');
    }
    const [{ mode }] = await sql<Array<{ mode: string }>>`SELECT mode FROM calendar_backend_state WHERE id = true`;
    assert.equal(mode, 'postgres');
  });
});

describe('dichiarazioni', () => {
  test('CONFERMO per quelle che tolgono un controllo, validazione dei valori, audit senza dati personali', async () => {
    await ensureTestAdmin();
    const noConfirm = await api.post(`${BASE}/declarations`, { auth: 'admin', body: { key: 'backup_verified', value: { note: 'tar verificato' } } });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.json.details.expected, MIGRATION_CONFIRMATIONS.declare);

    const ok = await api.post(`${BASE}/declarations`, { auth: 'admin', body: { key: 'backup_verified', value: { note: 'tar verificato', extra: 'x' }, confirm: MIGRATION_CONFIRMATIONS.declare } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json.declarations.backup_verified.value, { note: 'tar verificato' });
    assert.equal(ok.json.declarations.backup_verified.by, `admin:${TEST_ADMIN.id}`);

    const phase0 = await api.post(`${BASE}/declarations`, { auth: 'admin', body: { key: 'phase0', value: { status: 'absent' } } });
    assert.equal(phase0.status, 200);
    assert.equal(phase0.json.declarations.phase0.value.status, 'absent');
    assert.ok(phase0.json.declarations.backup_verified, 'le altre dichiarazioni restano');

    const archivedWithoutRun = await api.post(`${BASE}/declarations`, { auth: 'admin', body: { key: 'phase0', value: { status: 'archived', archive_run_id: randomUUID() } } });
    assert.equal(archivedWithoutRun.status, 409);

    const badMatrix = await api.post(`${BASE}/declarations`, { auth: 'admin', body: { key: 'device_matrix', value: { result: 'passed', strict_preconditions: true, allday_transp_rule: 'x', devices: ['ios'] } } });
    assert.equal(badMatrix.status, 400);
    const matrix = await api.post(`${BASE}/declarations`, {
      auth: 'admin', body: { key: 'device_matrix', value: { result: 'passed', strict_preconditions: true, allday_transp_rule: 'opaque_blocks', devices: ['thunderbird', 'ios', 'ios'] } },
    });
    assert.equal(matrix.status, 200);
    assert.deepEqual(matrix.json.declarations.device_matrix.value.devices, ['ios', 'thunderbird']);

    const unknown = await api.post(`${BASE}/declarations`, { auth: 'admin', body: { key: 'altro', value: {} } });
    assert.equal(unknown.status, 400);

    const audits = await sql<Array<{ action: string; metadata: Record<string, unknown> }>>`
      SELECT action, metadata FROM audit_logs WHERE table_name = 'calendar_migration' AND metadata->>'operation' = 'declare' ORDER BY created_at
    `;
    assert.ok(audits.length >= 3);
    assert.ok(audits.every((a) => a.action === 'UPDATE' && a.metadata.actor === `admin:${TEST_ADMIN.id}`));
    assert.ok(!JSON.stringify(audits).includes('tar verificato'), 'le note non finiscono nell\'audit');
    await sql`UPDATE calendar_backend_state SET migration_declarations = '{}'::jsonb WHERE id = true`;
  });
});

describe('run: elenco, righe, report, annullamento', () => {
  test('paginazione delle righe con cursor e filtri; report JSON e CSV; 404', async () => {
    withoutRadicale();
    await clearRuns();
    const items: MigrationItemInput[] = Array.from({ length: 12 }, (_, i) => ({
      item_type: i % 3 === 0 ? 'anomaly' : 'check',
      code: i % 3 === 0 ? 'POSSIBLE_DUPLICATE' : `CHECK_${i}`,
      severity: i % 2 === 0 ? 'warning' : 'info',
      detail: { n: i },
    }));
    const created = await recordCompletedRun({ kind: 'inventory', trigger: 'admin', requestedBy: 'admin:test', params: { scope: {} } }, { summary: { ok: true }, items });
    const id = created.run.id;
    const page1 = await api.get(`${BASE}/runs/${id}/items`, { auth: 'admin', query: { limit: 5 } });
    assert.equal(page1.status, 200);
    assert.equal(page1.json.total, 12);
    assert.deepEqual(page1.json.items.map((i: { seq: number }) => i.seq), [0, 1, 2, 3, 4]);
    assert.ok(page1.json.next_cursor);
    const page2 = await api.get(`${BASE}/runs/${id}/items`, { auth: 'admin', query: { limit: 5, cursor: page1.json.next_cursor } });
    assert.deepEqual(page2.json.items.map((i: { seq: number }) => i.seq), [5, 6, 7, 8, 9]);
    const page3 = await api.get(`${BASE}/runs/${id}/items`, { auth: 'admin', query: { limit: 5, cursor: page2.json.next_cursor } });
    assert.deepEqual(page3.json.items.map((i: { seq: number }) => i.seq), [10, 11]);
    assert.equal(page3.json.next_cursor, null);

    const anomalies = await api.get(`${BASE}/runs/${id}/items`, { auth: 'admin', query: { item_type: 'anomaly', severity: 'warning' } });
    assert.equal(anomalies.json.total, 2);
    assert.ok(anomalies.json.items.every((i: { item_type: string; severity: string }) => i.item_type === 'anomaly' && i.severity === 'warning'));
    const badFilter = await api.get(`${BASE}/runs/${id}/items`, { auth: 'admin', query: { item_type: 'nulla' } });
    assert.equal(badFilter.status, 400);
    const badLimit = await api.get(`${BASE}/runs/${id}/items`, { auth: 'admin', query: { limit: 0 } });
    assert.equal(badLimit.status, 400);

    const missing = await api.get(`${BASE}/runs/${randomUUID()}`, { auth: 'admin' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'RUN_NOT_FOUND');
    assert.equal((await api.get(`${BASE}/runs/non-uuid`, { auth: 'admin' })).status, 404);
    assert.equal((await api.get(`${BASE}/runs/${randomUUID()}/items`, { auth: 'admin' })).status, 404);

    const json = await api.get(`${BASE}/runs/${id}/report`, { auth: 'admin', query: { format: 'json' } });
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-disposition') ?? '', /^attachment; filename="migrazione-calendario-inventory-.*\.json"$/);
    assert.equal(json.json.items.length, 12);
    const csv = await api.get(`${BASE}/runs/${id}/report`, { auth: 'admin', query: { format: 'csv' } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.equal(csv.text.trim().split('\r\n').length, 13);
    assert.equal((await api.get(`${BASE}/runs/${id}/report`, { auth: 'admin', query: { format: 'xml' } })).status, 400);

    const list = await api.get(`${BASE}/runs`, { auth: 'admin', query: { kind: 'inventory', limit: 1 } });
    assert.equal(list.status, 200);
    assert.equal(list.json.runs[0].id, id);
    assert.equal((await api.get(`${BASE}/runs`, { auth: 'admin', query: { status: 'boh' } })).status, 400);
  });

  test('annullamento di un run in coda e RUN_NOT_ACTIVE su un run concluso', async () => {
    withOfflineRadicale();
    await clearRuns();
    try {
      const res = await api.post(`${BASE}/inventory`, { auth: 'admin', body: {} });
      assert.equal(res.status, 202, res.text);
      assert.equal(res.json.run.status, 'queued');
      const busy = await api.post(`${BASE}/verify`, { auth: 'admin', body: {} });
      assert.equal(busy.status, 409);
      assert.equal(busy.json.code, 'MIGRATION_BUSY');
      assert.equal(busy.json.details.active_run.id, res.json.run.id);
      assert.match(busy.json.error, /già in corso un run di migrazione \(inventory\)/);

      const state = (await api.get(`${BASE}/state`, { auth: 'admin' })).json;
      assert.equal(state.active_run.id, res.json.run.id);
      assert.equal(state.wizard.steps[0].actions.find((a: { id: string }) => a.id === 'preflight').enabled, false);

      const cancel = await api.post(`${BASE}/runs/${res.json.run.id}/cancel`, { auth: 'admin' });
      assert.equal(cancel.status, 200);
      assert.equal(cancel.json.run.status, 'cancelled');
      assert.equal(cancel.json.run.cancel_requested, true);
      assert.equal(cancel.json.run.error.code, 'CANCELLED');
      const again = await api.post(`${BASE}/runs/${res.json.run.id}/cancel`, { auth: 'admin' });
      assert.equal(again.status, 409);
      assert.equal(again.json.code, 'RUN_NOT_ACTIVE');

      // Il job del run annullato si chiude senza eseguire nulla.
      registerMigrationRunJob();
      let called = false;
      setMigrationRunHandlerOverride('inventory', async () => { called = true; return {}; });
      await runJobsUntilIdle();
      assert.equal(called, false);
      const [job] = await sql<Array<{ status: string }>>`SELECT status FROM cal_jobs WHERE kind = ${MIGRATION_RUN_JOB_KIND} AND key = ${res.json.run.id}`;
      assert.equal(job.status, 'done');
    } finally {
      setMigrationRunHandlerOverride('inventory', null);
      withoutRadicale();
    }
  });
});

describe('ciclo di vita dei run con l\'esecutore dei job', () => {
  test('successo: running, avanzamento, righe e riassunto; poi errore senza dati personali', async () => {
    withOfflineRadicale();
    await clearRuns();
    registerMigrationRunJob();
    let seenCtx: MigrationRunContext | null = null;
    setMigrationRunHandlerOverride('inventory', async (ctx: MigrationRunContext) => {
      seenCtx = ctx;
      const [row] = await sql<Array<{ status: string; started_at: Date | null }>>`SELECT status, started_at FROM cal_migration_runs WHERE id = ${ctx.runId}::uuid`;
      assert.equal(row.status, 'running');
      assert.ok(row.started_at);
      await ctx.progress({ phase: 'count', done: 1, total: 2, message: 'Conteggio' });
      const ids = await ctx.addItems([
        { item_type: 'anomaly', code: 'POSSIBLE_DUPLICATE', severity: 'info', detail: { a: 1 } },
        { item_type: 'anomaly', code: 'MIXED_BYDAY', severity: 'warning', detail: { b: 2 }, action: 'create', level: 'V3', expected: true },
      ]);
      assert.equal(ids.length, 2);
      await ctx.progress({ phase: 'done', done: 2, total: 2, message: 'Fatto' });
      return { generated_at: new Date().toISOString(), totals: { rows: 2 } };
    });
    try {
      const res = await api.post(`${BASE}/inventory`, { auth: 'admin', body: { scope: {} } });
      assert.equal(res.status, 202);
      await runJobsUntilIdle();
      const run = (await api.get(`${BASE}/runs/${res.json.run.id}`, { auth: 'admin' })).json;
      assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
      assert.equal(run.attempts, 1);
      assert.deepEqual(run.summary.totals, { rows: 2 });
      assert.equal(run.progress.phase, 'done');
      assert.equal(run.progress.done, 2);
      assert.ok(run.finished_at && run.started_at && run.heartbeat_at);
      assert.equal(seenCtx!.actor, `admin:${TEST_ADMIN.id}`);
      assert.equal(seenCtx!.attempt, 1);
      const items = (await api.get(`${BASE}/runs/${run.id}/items`, { auth: 'admin' })).json.items;
      assert.deepEqual(items.map((i: { seq: number }) => i.seq), [0, 1]);
      assert.equal(items[1].action, null, 'azione solo per le righe object');
      assert.equal(items[1].level, null, 'livello solo per le righe diff');
      assert.equal(items[1].expected, null);

      // Errore inatteso con dati personali nel messaggio: mai salvato nel run.
      setMigrationRunHandlerOverride('inventory', async () => {
        throw new Error('duplicate key (attendee_email)=(mario.rossi@example.com)');
      });
      const failing = await api.post(`${BASE}/inventory`, { auth: 'admin', body: { scope: {} } });
      await runJobsUntilIdle();
      const failed = (await api.get(`${BASE}/runs/${failing.json.run.id}`, { auth: 'admin' })).json;
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error.code, 'INTERNAL');
      assert.ok(!failed.error.message.includes('@'), failed.error.message);

      // MigrationError con run_error_code: il codice d'esito è quello preciso.
      setMigrationRunHandlerOverride('inventory', async () => {
        throw new MigrationError('PRECONDITION_FAILED', 'Identità del volume cambiata durante il run', { reasons: ['IDENTITY_NOT_OK'], run_error_code: 'IDENTITY_CHANGED' });
      });
      const precise = await api.post(`${BASE}/inventory`, { auth: 'admin', body: { scope: {} } });
      await runJobsUntilIdle();
      const preciseRun = (await api.get(`${BASE}/runs/${precise.json.run.id}`, { auth: 'admin' })).json;
      assert.equal(preciseRun.error.code, 'IDENTITY_CHANGED');
      assert.equal(preciseRun.error.message, 'Identità del volume cambiata durante il run');
    } finally {
      setMigrationRunHandlerOverride('inventory', null);
      withoutRadicale();
    }
  });

  test('annullamento a metà: il modulo si ferma al punto sicuro e il run è cancelled', async () => {
    withOfflineRadicale();
    await clearRuns();
    registerMigrationRunJob();
    let reached = false;
    setMigrationRunHandlerOverride('inventory', async (ctx: MigrationRunContext) => {
      reached = true;
      await ctx.addItems([{ item_type: 'anomaly', code: 'POSSIBLE_DUPLICATE', detail: {} }]);
      for (let i = 0; i < 200; i++) {
        ctx.throwIfCancelled();
        await new Promise((r) => setTimeout(r, 50));
      }
      return { never: true };
    });
    try {
      const res = await api.post(`${BASE}/inventory`, { auth: 'admin', body: {} });
      const worker = runCalendarJobsOnce({ limit: 1 });
      await waitFor(async () => reached);
      const cancel = await api.post(`${BASE}/runs/${res.json.run.id}/cancel`, { auth: 'admin' });
      assert.equal(cancel.status, 200);
      assert.equal(cancel.json.run.cancel_requested, true);
      await worker;
      const run = (await api.get(`${BASE}/runs/${res.json.run.id}`, { auth: 'admin' })).json;
      assert.equal(run.status, 'cancelled');
      assert.equal(run.error.code, 'CANCELLED');
      const items = (await api.get(`${BASE}/runs/${run.id}/items`, { auth: 'admin' })).json;
      assert.equal(items.total, 1, 'le righe già scritte restano');
    } finally {
      setMigrationRunHandlerOverride('inventory', null);
      withoutRadicale();
    }
  });

  test('ripresa dopo un crash (lease scaduto): stesso run, attempt 2, seq che continua', async () => {
    withOfflineRadicale();
    await clearRuns();
    registerMigrationRunJob();
    const attempts: number[] = [];
    setMigrationRunHandlerOverride('inventory', async (ctx: MigrationRunContext) => {
      attempts.push(ctx.attempt);
      await ctx.addItems([{ item_type: 'anomaly', code: 'POSSIBLE_DUPLICATE', detail: { attempt: ctx.attempt } }]);
      return { attempt: ctx.attempt };
    });
    try {
      const res = await api.post(`${BASE}/inventory`, { auth: 'admin', body: {} });
      const runId = res.json.run.id as string;
      // Primo tentativo "morto" a metà: run running con una riga, job in lease scaduto.
      await sql`UPDATE cal_migration_runs SET status = 'running', started_at = now() - interval '2 minutes', attempts = 1, heartbeat_at = now() - interval '2 minutes' WHERE id = ${runId}::uuid`;
      await sql`
        INSERT INTO cal_migration_items (run_id, seq, item_type, code, detail) VALUES (${runId}::uuid, 0, 'anomaly', 'POSSIBLE_DUPLICATE', '{"attempt": 1}'::jsonb)
      `;
      await sql`
        UPDATE cal_jobs SET status = 'running', attempts = 1, lease_token = gen_random_uuid(), locked_by = 'morto', locked_until = now() - interval '1 second', started_at = now() - interval '2 minutes'
        WHERE kind = ${MIGRATION_RUN_JOB_KIND} AND key = ${runId}
      `;
      // Il reaper non lo tocca: il job può ancora riprenderlo.
      assert.equal(await reapInterruptedRuns(), 0);
      await runJobsUntilIdle();
      const run = (await api.get(`${BASE}/runs/${runId}`, { auth: 'admin' })).json;
      assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
      assert.equal(run.attempts, 2);
      assert.deepEqual(attempts, [2]);
      const items = (await api.get(`${BASE}/runs/${runId}/items`, { auth: 'admin' })).json.items;
      assert.deepEqual(items.map((i: { seq: number; detail: { attempt: number } }) => [i.seq, i.detail.attempt]), [[0, 1], [1, 2]]);
    } finally {
      setMigrationRunHandlerOverride('inventory', null);
      withoutRadicale();
    }
  });

  test('reaper: running senza battito con il job morto → interrupted; queued senza job → failed', async () => {
    await clearRuns();
    const [running] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, started_at, heartbeat_at, attempts)
      VALUES ('apply', 'running', 'admin', 'admin:test', now() - interval '20 minutes', now() - interval '10 minutes', 3)
      RETURNING id::text AS id
    `;
    const [job] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_jobs (kind, key, payload, status, attempts, max_attempts, finished_at)
      VALUES (${MIGRATION_RUN_JOB_KIND}, ${running.id}, '{}'::jsonb, 'dead', 3, 3, now())
      RETURNING id::text AS id
    `;
    await sql`UPDATE cal_migration_runs SET job_id = ${job.id}::bigint WHERE id = ${running.id}::uuid`;
    assert.equal(await reapInterruptedRuns(), 1);
    const [r1] = await sql<Array<{ status: string; error_code: string }>>`SELECT status, error_code FROM cal_migration_runs WHERE id = ${running.id}::uuid`;
    assert.deepEqual(r1, { status: 'interrupted', error_code: 'INTERRUPTED' });

    const [queued] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, created_at) VALUES ('verify', 'queued', 'schedule', 'system:shadow', now() - interval '5 minutes')
      RETURNING id::text AS id
    `;
    assert.equal(await reapInterruptedRuns(), 1);
    const [r2] = await sql<Array<{ status: string }>>`SELECT status FROM cal_migration_runs WHERE id = ${queued.id}::uuid`;
    assert.equal(r2.status, 'failed');

    // Battito recente: non si tocca nemmeno con il job morto.
    const [fresh] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, started_at, heartbeat_at) VALUES ('apply', 'running', 'admin', 'admin:test', now(), now())
      RETURNING id::text AS id
    `;
    assert.equal(await reapInterruptedRuns(), 0);
    await sql`DELETE FROM cal_migration_runs WHERE id = ${fresh.id}::uuid`;
  });

  test('apply con follow_up_verify: la verifica nasce nella transazione che chiude l\'apply', async () => {
    withOfflineRadicale();
    await clearRuns();
    registerMigrationRunJob();
    setMigrationRunHandlerOverride('apply', async () => ({ zero_writes: true, totals: {}, writes: { create: 0, update: 0, delete: 0 }, conflicts: {}, failed: 0 }));
    let verified: MigrationRunContext | null = null;
    setMigrationRunHandlerOverride('verify', async (ctx: MigrationRunContext) => {
      verified = ctx;
      return { overall: 'green', acceptable: true, calendars: [] };
    });
    try {
      const created = await createMigrationRun({
        kind: 'apply',
        trigger: 'schedule',
        requestedBy: 'system:shadow',
        params: { scope: {}, options: DEFAULT_MIGRATION_OPTIONS, expected_plan_hash: null, force_item_ids: [], force_codes: [], follow_up_verify: { scope: {}, levels: ['V1', 'V4'], v4_days: 14 } },
      });
      await runJobsUntilIdle();
      const runs = await sql<Array<{ kind: string; status: string; trigger: string; params: Record<string, unknown> }>>`
        SELECT kind, status, trigger, params FROM cal_migration_runs ORDER BY created_at
      `;
      assert.deepEqual(runs.map((r) => [r.kind, r.status, r.trigger]), [['apply', 'succeeded', 'schedule'], ['verify', 'succeeded', 'schedule']]);
      assert.deepEqual(runs[1].params, { scope: {}, levels: ['V1', 'V4'], v4_days: 14 });
      assert.equal(verified!.actor, 'system:shadow');
      assert.ok(created.run.id);
    } finally {
      setMigrationRunHandlerOverride('apply', null);
      setMigrationRunHandlerOverride('verify', null);
      withoutRadicale();
    }
  });

  test('lock cal-migration: try occupato → MIGRATION_BUSY; l\'esecutore aspetta che si liberi', async () => {
    withOfflineRadicale();
    await clearRuns();
    registerMigrationRunJob();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = withMigrationLock(() => held, { wait: false });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(withMigrationLock(async () => 1, { wait: false }), (err: unknown) => err instanceof MigrationLockBusyError && err.code === 'MIGRATION_BUSY');
    setMigrationRunHandlerOverride('inventory', async () => ({ ok: true }));
    try {
      const res = await api.post(`${BASE}/inventory`, { auth: 'admin', body: {} });
      const worker = runCalendarJobsOnce({ limit: 1 });
      await new Promise((r) => setTimeout(r, 400));
      const [mid] = await sql<Array<{ status: string }>>`SELECT status FROM cal_migration_runs WHERE id = ${res.json.run.id}::uuid`;
      assert.equal(mid.status, 'queued', 'in attesa del lock');
      release();
      await holder;
      await worker;
      const run = (await api.get(`${BASE}/runs/${res.json.run.id}`, { auth: 'admin' })).json;
      assert.equal(run.status, 'succeeded');
    } finally {
      release();
      setMigrationRunHandlerOverride('inventory', null);
      withoutRadicale();
    }
  });
});

describe('altre route', () => {
  test('archivio: file, formato, conferma, chiave e Radicale', async () => {
    withoutRadicale();
    const form = (opts: { name?: string; content?: string; confirm?: string; withFile?: boolean } = {}): FormData => {
      const fd = new FormData();
      if (opts.withFile !== false) fd.set('file', new File([opts.content ?? 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'], opts.name ?? 'archivio-fase0.zip'));
      if (opts.confirm !== undefined) fd.set('confirm', opts.confirm);
      return fd;
    };
    const noFile = await api.post(`${BASE}/phase0/archive`, { auth: 'admin', body: form({ withFile: false, confirm: MIGRATION_CONFIRMATIONS.archive }) });
    assert.equal(noFile.status, 400);
    const badExt = await api.post(`${BASE}/phase0/archive`, { auth: 'admin', body: form({ name: 'dati.exe', confirm: MIGRATION_CONFIRMATIONS.archive }) });
    assert.equal(badExt.status, 400);
    const noConfirm = await api.post(`${BASE}/phase0/archive`, { auth: 'admin', body: form({ confirm: 'importa' }) });
    assert.equal(noConfirm.json.code, 'CONFIRMATION_REQUIRED');
    assert.equal(noConfirm.json.details.expected, MIGRATION_CONFIRMATIONS.archive);
    const noKey = await api.post(`${BASE}/phase0/archive`, { auth: 'admin', body: form({ confirm: MIGRATION_CONFIRMATIONS.archive }) });
    assert.equal(noKey.json.code, 'IDEMPOTENCY_KEY_REQUIRED');
    const noRadicale = await api.post(`${BASE}/phase0/archive`, { auth: 'admin', body: form({ confirm: MIGRATION_CONFIRMATIONS.archive }), headers: { 'Idempotency-Key': newKey() } });
    assert.equal(noRadicale.status, 503);
    assert.equal(noRadicale.json.code, 'RADICALE_NOT_CONFIGURED');
  });

  test('shadow: conferma per accendere, spegnimento sempre ammesso; accettazione solo sulle verifiche', async () => {
    withoutRadicale();
    const noConfirm = await api.post(`${BASE}/shadow`, { auth: 'admin', body: { enabled: true } });
    assert.equal(noConfirm.json.code, 'CONFIRMATION_REQUIRED');
    assert.equal(noConfirm.json.details.expected, MIGRATION_CONFIRMATIONS.shadowOn);
    const noRadicale = await api.post(`${BASE}/shadow`, { auth: 'admin', body: { enabled: true, confirm: MIGRATION_CONFIRMATIONS.shadowOn } });
    assert.equal(noRadicale.status, 503);
    const off = await api.post(`${BASE}/shadow`, { auth: 'admin', body: { enabled: false } });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.shadow_enabled, false);
    assert.equal((await api.post(`${BASE}/shadow`, { auth: 'admin', body: { enabled: 'si' } })).status, 400);

    await clearRuns();
    const created = await recordCompletedRun({ kind: 'inventory', trigger: 'admin', requestedBy: 'admin:test', params: {} }, { summary: {}, items: [] });
    const notVerify = await api.post(`${BASE}/runs/${created.run.id}/accept`, { auth: 'admin', body: { all_expected: true, confirm: MIGRATION_CONFIRMATIONS.accept } });
    assert.equal(notVerify.status, 409);
    assert.deepEqual(notVerify.json.details.reasons, ['RUN_KIND_NOT_VERIFY']);
    const noConfirmAccept = await api.post(`${BASE}/runs/${created.run.id}/accept`, { auth: 'admin', body: { all_expected: true } });
    assert.equal(noConfirmAccept.json.code, 'CONFIRMATION_REQUIRED');
    assert.equal((await api.post(`${BASE}/runs/${randomUUID()}/accept`, { auth: 'admin', body: { all_expected: true, confirm: MIGRATION_CONFIRMATIONS.accept } })).status, 404);

    const parity = await api.get(`${BASE}/parity`, { auth: 'admin' });
    assert.equal(parity.status, 200);
    assert.equal(parity.json.shadow_enabled, false);
    assert.equal(parity.json.required_days, MIGRATION_LIMITS.parityDaysRequired);
    const subs = await api.get(`${BASE}/subscriptions`, { auth: 'admin' });
    assert.equal(subs.status, 200);
    assert.ok(Array.isArray(subs.json.subscriptions));
    const badSub = await api.patch(`${BASE}/subscriptions/non-uuid`, { auth: 'admin', body: { device_visible: true } });
    assert.equal(badSub.status, 400);
    const noFlags = await api.patch(`${BASE}/subscriptions/${randomUUID()}`, { auth: 'admin', body: {} });
    assert.equal(noFlags.status, 400);
  });
});

// ─── Passi del wizard (derivazione pura) ───────────────────────────────

const NOW = new Date('2026-10-12T10:00:00Z');
const minutesAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

function state(overrides: Partial<MigrationBackendState> = {}): MigrationBackendState {
  return {
    mode: 'postgres', write_freeze: false, volume_id: '11111111-1111-4111-8111-111111111111', epoch: 1, credential_epoch: 0, policy_version: 3,
    restore_guard_until: null, rebuild_required: false, shadow_enabled: false, shadow_since: null, cutover_at: null, cutover_by: null,
    rollback_until: null, finalized_at: null, api_min_version: 0, last_stack_backup: null,
    migration_declarations: { phase0: { value: { status: 'absent' }, at: minutesAgo(600).toISOString(), by: 'admin:x' } },
    ...overrides,
  } as MigrationBackendState;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runRow(kind: MigrationRunKind, finishedMinutesAgo: number, summary: any, extra: Record<string, unknown> = {}): any {
  return {
    id: randomUUID(), kind, status: 'succeeded', trigger: 'admin', requested_by: 'admin:x', idempotency_key: null, request_hash: null,
    params: {}, plan_run_id: null, plan_hash: null, progress: {}, summary, error: null, error_code: null, attempts: 1, job_id: null,
    heartbeat_at: minutesAgo(finishedMinutesAgo), cancel_requested_at: null, created_at: minutesAgo(finishedMinutesAgo + 1),
    started_at: minutesAgo(finishedMinutesAgo + 1), finished_at: minutesAgo(finishedMinutesAgo), ...extra,
  };
}

const READY_PREFLIGHT = { ready: true, blocking: [], checks: [{ code: 'RADICALE_VERSION', status: 'warn', message: 'non verificabile' }], identity: 'ok', can_initialize: false, missing_collections: [], radicale: { configured: true, reachable: true, version: null }, watch_mode: 'mount' };

function inputs(over: Partial<WizardStateInputs> & { runs?: unknown[] } = {}): WizardStateInputs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runs = (over.runs ?? []) as any[];
  const succeeded = new Map();
  const finished = new Map();
  for (const r of runs) {
    if (r.status === 'succeeded') succeeded.set(r.kind, r);
    if (r.finished_at) finished.set(r.kind, r);
  }
  return {
    now: NOW,
    state: state(),
    configured: true,
    identity: { status: 'ok', checked_at: NOW.toISOString(), detail: null },
    active: null,
    lastByKind: finished,
    lastFinishedByKind: finished,
    lastSucceededByKind: succeeded,
    verify: { runId: null, verdicts: [], acceptable: false, finished_at: null },
    parity: null,
    ledger: { live: 0, pending_intents: 0, revalidation_pending: 0 },
    ...over,
  };
}

const statuses = (i: WizardStateInputs): string[] => deriveWizardSteps(i).steps.map((s) => s.status);
const green = (calendar: string) => ({ calendar_id: randomUUID(), collection_name: calendar, slug: calendar, color: 'green' as const, accepted: true, levels: {} });

describe('passi del wizard', () => {
  test('passo 1: da fare, inizializzazione proposta, in corso, concluso nonostante gli avvisi, preflight da ripetere', () => {
    assert.deepEqual(statuses(inputs({ identity: { status: 'uninitialized', checked_at: null, detail: null }, state: state({ volume_id: null, epoch: 0 }) })).slice(0, 2), ['todo', 'locked']);
    const empty = deriveWizardSteps(inputs({
      identity: { status: 'uninitialized', checked_at: null, detail: null },
      state: state({ volume_id: null, epoch: 0 }),
      runs: [runRow('preflight', 5, { ...READY_PREFLIGHT, ready: false, identity: 'uninitialized', can_initialize: true, checks: [{ code: 'IDENTITY', status: 'pass', message: 'ok' }] })],
    }));
    assert.equal(empty.steps[0].status, 'attention');
    assert.equal(empty.steps[0].actions.find((a) => a.id === 'initialize')!.enabled, true);
    assert.match(empty.steps[0].summary, /inizializza Radicale/);

    const active = runRow('init', 0, null, { status: 'running', finished_at: null });
    assert.equal(statuses(inputs({ active }))[0], 'running');

    const done = inputs({ runs: [runRow('preflight', 5, READY_PREFLIGHT)] });
    assert.deepEqual(statuses(done).slice(0, 2), ['done', 'todo']);
    assert.match(deriveWizardSteps(done).steps[0].summary, /1 avviso/);

    const failed = inputs({ runs: [runRow('preflight', 5, { ...READY_PREFLIGHT, ready: false, checks: [{ code: 'PROBE_READONLY', status: 'fail', message: 'il probe scrive' }] })] });
    assert.equal(statuses(failed)[0], 'blocked');

    const stale = inputs({ runs: [runRow('preflight', 30, READY_PREFLIGHT), runRow('init', 5, {})] });
    assert.equal(statuses(stale)[0], 'attention');
    assert.ok(deriveWizardSteps(stale).steps[0].blocking.some((b) => /ripetilo/.test(b)));

    const matrixLater = inputs({
      state: state({
        migration_declarations: {
          phase0: { value: { status: 'absent' }, at: minutesAgo(600).toISOString(), by: 'admin:x' },
          device_matrix: { value: { result: 'passed', strict_preconditions: true, allday_transp_rule: 'opaque_blocks', devices: ['ios'] }, at: minutesAgo(1).toISOString(), by: 'admin:x' },
        },
      }),
      runs: [runRow('preflight', 5, READY_PREFLIGHT)],
    });
    assert.equal(statuses(matrixLater)[0], 'done', 'la matrice device non rende vecchio il preflight');

    const noPhase0 = inputs({ state: state({ migration_declarations: {} }), runs: [runRow('preflight', 5, READY_PREFLIGHT)] });
    assert.equal(statuses(noPhase0)[0], 'attention');
  });

  test('passi 2-4: anteprima, apply da ripetere fino a zero scritture, verifica rossa, gialla e accettata', () => {
    const preflight = runRow('preflight', 600, READY_PREFLIGHT);
    const plan = runRow('plan', 300, { writes: 30, totals: { noop: 0 }, conflicts: {}, preview: { blocking: [] } });
    assert.deepEqual(statuses(inputs({ runs: [preflight, plan] })).slice(1, 4), ['done', 'todo', 'locked']);
    const oldPlan = runRow('plan', 60 * 30, { writes: 30, totals: { noop: 0 }, conflicts: {}, preview: { blocking: [] } }, { finished_at: minutesAgo(60 * 30) });
    const oldPre = runRow('preflight', 60 * 31, READY_PREFLIGHT);
    const oldDecl = state({ migration_declarations: { phase0: { value: { status: 'absent' }, at: minutesAgo(60 * 40).toISOString(), by: 'admin:x' } } });
    assert.equal(statuses(inputs({ runs: [oldPre, oldPlan], state: oldDecl }))[1], 'attention', 'anteprima di più di 24 ore');
    const blockedPlan = runRow('plan', 300, { writes: 0, totals: { noop: 0 }, conflicts: {}, preview: { blocking: ['COLLECTION_NAME_INVALID'] } });
    const blockedSteps = deriveWizardSteps(inputs({ runs: [preflight, blockedPlan] })).steps;
    assert.equal(blockedSteps[1].status, 'attention');
    assert.equal(blockedSteps[2].actions[0].enabled, false);

    const firstApply = runRow('apply', 200, { zero_writes: false, writes: { create: 30, update: 0, delete: 0 }, conflicts: {}, failed: 0 });
    const s1 = deriveWizardSteps(inputs({ runs: [preflight, plan, firstApply] })).steps;
    assert.equal(s1[2].status, 'attention');
    assert.ok(s1[2].blocking.includes('Ripeti per verificare zero scritture'));
    assert.equal(s1[3].status, 'todo');

    const second = runRow('apply', 100, { zero_writes: true, writes: { create: 0, update: 0, delete: 0 }, conflicts: {}, failed: 0 });
    assert.equal(statuses(inputs({ runs: [preflight, plan, second] }))[2], 'done');
    const conflicted = runRow('apply', 100, { zero_writes: false, writes: { create: 0, update: 0, delete: 0 }, conflicts: { TARGET_NEWER: 2 }, failed: 0 });
    assert.equal(statuses(inputs({ runs: [preflight, plan, conflicted] }))[2], 'attention');
    const failedApply = runRow('apply', 100, null, { status: 'failed', error: 'Radicale giù' });
    assert.equal(statuses(inputs({ runs: [preflight, plan, failedApply] }))[2], 'attention');

    const base = [preflight, plan, second];
    const verifyAt = minutesAgo(50);
    const red = inputs({ runs: base, verify: { runId: randomUUID(), verdicts: [{ ...green('c'), color: 'red', accepted: false }], acceptable: false, finished_at: verifyAt } });
    assert.equal(statuses(red)[3], 'blocked');
    const yellow = inputs({ runs: base, verify: { runId: randomUUID(), verdicts: [{ ...green('f'), color: 'yellow', accepted: false }], acceptable: false, finished_at: verifyAt } });
    const ySteps = deriveWizardSteps(yellow).steps;
    assert.equal(ySteps[3].status, 'attention');
    assert.equal(ySteps[3].actions.find((a) => a.id === 'accept')!.enabled, true);
    assert.equal(ySteps[4].status, 'locked');
    const accepted = inputs({ runs: base, verify: { runId: randomUUID(), verdicts: [green('c'), { ...green('f'), color: 'yellow', accepted: true }], acceptable: true, finished_at: verifyAt } });
    const aSteps = deriveWizardSteps(accepted).steps;
    assert.equal(aSteps[3].status, 'done');
    assert.equal(aSteps[4].status, 'todo');
    assert.equal(aSteps[4].actions.find((a) => a.id === 'shadow_on')!.enabled, true);
    const oldVerify = inputs({ runs: base, verify: { runId: randomUUID(), verdicts: [green('c')], acceptable: true, finished_at: minutesAgo(150) } });
    assert.equal(statuses(oldVerify)[3], 'todo', 'verifica precedente all\'ultimo apply');
    // Un apply a zero scritture dopo la verifica (recupero dello shadow, giro notturno) non la rende vecchia.
    const zeroAfter = inputs({
      runs: [preflight, plan, runRow('apply', 10, { zero_writes: true, writes: { create: 0, update: 0, delete: 0 }, conflicts: {}, failed: 0 })],
      verify: { runId: randomUUID(), verdicts: [green('c')], acceptable: true, finished_at: verifyAt },
      lastWritingApplyAt: minutesAgo(200),
    });
    assert.equal(statuses(zeroAfter)[3], 'done');
    const wroteAfter = inputs({ runs: base, verify: { runId: randomUUID(), verdicts: [green('c')], acceptable: true, finished_at: verifyAt }, lastWritingApplyAt: minutesAgo(10) });
    assert.equal(statuses(wroteAfter)[3], 'todo', 'un apply che ha scritto dopo la verifica la rende vecchia');
  });

  test('passi 5-6: shadow in corso, conflitti, parità soddisfatta con e senza matrice device; passaggio sempre disabilitato', () => {
    const base = [runRow('preflight', 600, READY_PREFLIGHT), runRow('plan', 300, { writes: 0, totals: { noop: 1 }, conflicts: {}, preview: { blocking: [] } }), runRow('apply', 100, { zero_writes: true, writes: { create: 0, update: 0, delete: 0 }, conflicts: {}, failed: 0 })];
    const verify = { runId: randomUUID(), verdicts: [green('c')], acceptable: true, finished_at: minutesAgo(50) };
    const parity = (over: Record<string, unknown> = {}) => ({
      shadow_enabled: true, shadow_since: minutesAgo(60 * 24 * 8).toISOString(), green_since: minutesAgo(60 * 24 * 3).toISOString(), days_green: 3, required_days: 7, satisfied: false,
      last_nightly: { apply_run_id: null, verify_run_id: randomUUID(), color: 'green' as const, green: true, finished_at: NOW.toISOString() }, last_hourly: null, recent: [],
      queue: { pending: 0, running: 0, dead: 0, oldest_pending_at: null }, open_conflicts: 0, ...over,
    });
    const shadowOn = state({ shadow_enabled: true, shadow_since: minutesAgo(60 * 24 * 8) });
    const running = deriveWizardSteps(inputs({ runs: base, verify, state: shadowOn, parity: parity() }));
    assert.equal(running.steps[4].status, 'running');
    assert.equal(running.steps[4].actions.find((a) => a.id === 'shadow_off')!.enabled, true);
    assert.equal(running.steps[4].actions.find((a) => a.id === 'shadow_on')!.enabled, false);
    assert.match(running.steps[4].summary, /3\/7/);

    const conflicts = deriveWizardSteps(inputs({ runs: base, verify, state: shadowOn, parity: parity({ open_conflicts: 2 }) }));
    assert.equal(conflicts.steps[4].status, 'attention');
    // Giro notturno giallo: verde per la parità se le differenze sono accettate, da guardare altrimenti.
    const nightly = (green: boolean) => ({ apply_run_id: randomUUID(), verify_run_id: randomUUID(), color: 'yellow' as const, green, finished_at: NOW.toISOString() });
    const yellowAccepted = deriveWizardSteps(inputs({ runs: base, verify, state: shadowOn, parity: parity({ last_nightly: nightly(true) }) }));
    assert.equal(yellowAccepted.steps[4].status, 'running');
    assert.deepEqual(yellowAccepted.steps[4].blocking, []);
    const yellowOpen = deriveWizardSteps(inputs({ runs: base, verify, state: shadowOn, parity: parity({ last_nightly: nightly(false) }) }));
    assert.equal(yellowOpen.steps[4].status, 'attention');
    assert.match(yellowOpen.steps[4].blocking.join(' '), /Ultimo giro giallo/);
    const satisfiedNoMatrix = deriveWizardSteps(inputs({ runs: base, verify, state: shadowOn, parity: parity({ satisfied: true, days_green: 8 }) }));
    assert.equal(satisfiedNoMatrix.steps[4].status, 'attention');

    const withMatrix = state({
      shadow_enabled: true, shadow_since: minutesAgo(60 * 24 * 8),
      last_stack_backup: { id: 'b1', at: minutesAgo(60).toISOString(), complete: true, volume_id: '11111111-1111-4111-8111-111111111111', epoch: 1, manifest_sha256: null },
      migration_declarations: {
        phase0: { value: { status: 'absent' }, at: minutesAgo(6000).toISOString(), by: 'admin:x' },
        device_matrix: { value: { result: 'passed', strict_preconditions: true, allday_transp_rule: 'opaque_blocks', devices: ['ios', 'macos', 'davx5', 'thunderbird'] }, at: minutesAgo(6000).toISOString(), by: 'admin:x' },
      },
    });
    const all = deriveWizardSteps(inputs({ runs: base, verify, state: withMatrix, parity: parity({ satisfied: true, days_green: 8 }) }));
    assert.equal(all.steps[4].status, 'done');
    assert.equal(all.steps[5].status, 'disabled');
    assert.equal(all.steps[5].actions[0].enabled, false);
    assert.equal(all.cutover.available, false);
    assert.ok(all.cutover.criteria.every((c) => c.ok), JSON.stringify(all.cutover.criteria));
    assert.match(all.steps[5].summary, /F4/);

    const noBackup = deriveWizardSteps(inputs({ runs: base, verify, state: { ...withMatrix, last_stack_backup: null }, parity: parity({ satisfied: true, days_green: 8 }) }));
    assert.equal(noBackup.cutover.criteria.find((c) => c.id === 'backup_recent')!.ok, false);
  });
});
