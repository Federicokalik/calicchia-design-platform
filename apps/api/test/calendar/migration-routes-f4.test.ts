/**
 * Route, esecutore e stato del wizard della F4 senza Radicale reale
 * (routes/calendar/migration.ts, lib/calendar/migration/runs.ts; contratto
 * docs/calendar-radicale/contracts/f4-modules.md §6), più la route della saga
 * "questa e le successive" (routes/calendar/admin.ts, §6.4 punto 1) con
 * PgLegacyStore.
 *
 * Casi: fase F4 e PHASE_NOT_AVAILABLE sparito; criteri del passaggio della F4
 * nello stato; conferme digitate e chiave d'idempotenza obbligatoria per
 * cutover, rollback, finalize e ri-baseline; 409 PRECONDITION_FAILED con i
 * motivi (mode, identità, finestra, anteprima); 409 TRANSITION_IN_PROGRESS
 * con details.transition per ogni azione che avvia una transizione mentre
 * un'altra è attiva; ripresa con la frase del tipo, annullamento solo prima
 * del passo d'epoch; replay della chiave; GET /transition e GET /reverse;
 * passo 6 del wizard per ogni mode (postgres, transizione ferma o in corso,
 * radicale, finalized) e azioni dei passi 1-5 ferme fuori da mode postgres;
 * messaggio del reaper per i run di transizione. Nessun run viene eseguito:
 * gli handler sono sostituiti e i job non girano (le transizioni vere sono
 * nei test dei moduli CUTOVER e ROLLBACK).
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { RadicaleClient, TransportError } from '../../src/lib/calendar/radicale/client';
import { configureRadicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import {
  deriveWizardSteps,
  reapInterruptedRuns,
  recordCompletedRun,
  type WizardStateInputs,
} from '../../src/lib/calendar/migration/runs';
import {
  F4_LIMITS,
  MIGRATION_CONFIRMATIONS,
  MIGRATION_LIMITS,
  MIGRATION_RUN_JOB_KIND,
  type CutoverCriterion,
  type MigrationBackendState,
  type TransitionView,
} from '../../src/lib/calendar/migration/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { api } from '../helpers/http';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  configureRadicaleRuntime(null);
  await clearAll();
  await resetCalendarBaseline();
});

const BASE = '/api/admin/calendar/migration';
const EVENTS = '/api/admin/calendar/events';
const VOLUME_ID = '6f0c2a7e-8a2b-4c1d-9e3f-0123456789ab';
let keySeq = 0;
const newKey = (): string => `f4-key-${Date.now().toString(36)}-${(keySeq++).toString(36)}-${randomUUID().slice(0, 8)}`;

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

function withOfflineRadicale(): void {
  configureRadicaleRuntime({ client: offlineClient(), principal: 'federico', watch: 'off', identitySource: 'remote' });
}

async function clearAll(): Promise<void> {
  await sql`DELETE FROM cal_jobs WHERE kind = ${MIGRATION_RUN_JOB_KIND}`;
  await sql`DELETE FROM cal_migration_runs`;
  await sql`DELETE FROM cal_migration_transitions`;
  await sql`
    UPDATE calendar_backend_state
    SET mode = 'postgres', write_freeze = false, volume_id = NULL, epoch = 0, rollback_until = NULL,
        cutover_at = NULL, cutover_by = NULL, finalized_at = NULL
    WHERE id
  `;
  invalidateBackendModeCache();
}

/** Volume inizializzato in mode postgres (epoch 1). */
async function initializedPostgres(): Promise<void> {
  await clearAll();
  await sql`UPDATE calendar_backend_state SET volume_id = ${VOLUME_ID}::uuid, epoch = 1 WHERE id`;
  invalidateBackendModeCache();
}

/** Dopo il passaggio: mode radicale con la finestra di rollback aperta (o scaduta). */
async function radicaleMode(opts: { cutoverAgoDays?: number; windowDays?: number } = {}): Promise<void> {
  await clearAll();
  const ago = opts.cutoverAgoDays ?? 1;
  const window = opts.windowDays ?? 30;
  await sql`
    UPDATE calendar_backend_state
    SET mode = 'radicale', volume_id = ${VOLUME_ID}::uuid, epoch = 2,
        cutover_at = now() - make_interval(days => ${ago}), cutover_by = 'admin:test',
        rollback_until = now() - make_interval(days => ${ago}) + make_interval(days => ${window})
    WHERE id
  `;
  invalidateBackendModeCache();
}

/** Transizione attiva (con i passi indicati già conclusi), senza un run che la esegua. */
async function activeTransition(kind: 'cutover' | 'rollback' | 'finalize', doneSteps: string[] = [], data: Record<string, unknown> = {}): Promise<string> {
  const from = kind === 'cutover' ? 'postgres' : 'radicale';
  const to = kind === 'cutover' ? 'radicale' : kind === 'rollback' ? 'postgres' : 'finalized';
  const [{ epoch }] = await sql<Array<{ epoch: number }>>`SELECT epoch FROM calendar_backend_state WHERE id`;
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO cal_migration_transitions (kind, from_mode, target_mode, run_id, epoch_before, started_by, data)
    VALUES (${kind}, ${from}, ${to}, ${randomUUID()}::uuid, ${epoch}, 'admin:test', ${sql.json(data as never)})
    RETURNING id::text AS id
  `;
  let seq = 0;
  for (const step of doneSteps) {
    await sql`
      INSERT INTO cal_migration_journal (transition_id, step, seq, status, attempts, run_id, data, started_at, finished_at)
      VALUES (${row.id}::uuid, ${step}, ${seq++}, 'done', 1, NULL, '{}'::jsonb, now(), now())
    `;
  }
  return row.id;
}

async function recordPreview(opts: { hash?: string; minutesAgo?: number } = {}): Promise<{ id: string; hash: string }> {
  const hash = opts.hash ?? createHash('sha256').update(randomUUID()).digest('hex');
  const created = await recordCompletedRun(
    { kind: 'rollback_preview', trigger: 'admin', requestedBy: 'admin:test', params: { scope: {} }, idempotencyKey: null, requestHash: null },
    { summary: { preview_hash: hash, objects: 0, by_class: {}, reverse_failed: 0, busy_identical: true }, items: [] },
  );
  if (opts.minutesAgo) {
    await sql`UPDATE cal_migration_runs SET finished_at = now() - make_interval(mins => ${opts.minutesAgo}) WHERE id = ${created.run.id}::uuid`;
  }
  return { id: created.run.id, hash };
}

async function stateView(): Promise<Record<string, any>> {
  const res = await api.get(`${BASE}/state`, { auth: 'admin' });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

type Step = { id: string; status: string; summary: string; blocking: string[]; actions: Array<{ id: string; enabled: boolean; confirm: string | null; reason: string | null }> };
const step6 = (s: Record<string, any>): Step => (s.wizard.steps as Step[]).find((x) => x.id === 'passaggio')!;
const act = (step: Step, id: string) => step.actions.find((a) => a.id === id);

async function backendRow(): Promise<{ mode: string; epoch: number; write_freeze: boolean }> {
  const [row] = await sql<Array<{ mode: string; epoch: number; write_freeze: boolean }>>`SELECT mode, epoch, write_freeze FROM calendar_backend_state WHERE id`;
  return row;
}

// ─── Fase, stato del wizard e criteri ───────────────────────────────

describe('stato del wizard in F4', () => {
  test('mode postgres: fase F4, criteri del passaggio della F4, passaggio non disponibile senza i criteri, nessuna transizione', async () => {
    configureRadicaleRuntime(null);
    await clearAll();
    const s = await stateView();
    assert.equal(s.phase, 'F4');
    assert.equal(s.backend.mode, 'postgres');
    assert.equal(s.transition, null);
    assert.equal(s.rollback_window, null);
    assert.equal(s.reverse_projection, null);
    const ids = (s.cutover.criteria as CutoverCriterion[]).map((c) => c.id);
    for (const id of ['no_active_transition', 'identity_ok', 'verify_acceptable', 'shadow_parity', 'device_matrix', 'backup_fresh', 'no_open_conflicts', 'no_revalidation', 'control_plane', 'probe', 'archive_readonly']) {
      assert.ok(ids.includes(id as CutoverCriterion['id']), `criterio ${id} presente: ${ids.join(', ')}`);
    }
    assert.equal(s.cutover.available, false);
    const s6 = step6(s);
    assert.notEqual(s6.status, 'disabled', 'il passo 6 non è più disabilitato per fase');
    assert.equal(act(s6, 'cutover')?.enabled, false);
    assert.equal(act(s6, 'cutover')?.confirm, MIGRATION_CONFIRMATIONS.cutover);
    assert.equal(act(s6, 'rebaseline')?.enabled, false, 'la ri-baseline serve solo dopo un rollback');
    assert.equal(act(s6, 'export_v2')?.enabled, false);
    assert.ok(s6.blocking.length > 0, 'i criteri mancanti sono elencati');
  });

  test('transizione ferma: passo 6 in attenzione con ripresa e annullamento; corrente il passo 6', async () => {
    withOfflineRadicale();
    try {
      await initializedPostgres();
      const id = await activeTransition('cutover', ['preflight'], { rollback_window_days: 21 });
      const s = await stateView();
      assert.equal(s.transition.id, id);
      assert.equal(s.transition.status, 'active');
      assert.equal(s.transition.next_step, 'freeze');
      assert.equal(s.transition.resumable, true);
      assert.equal(s.transition.abortable, true);
      assert.equal(s.wizard.current_step, 'passaggio');
      const s6 = step6(s);
      assert.equal(s6.status, 'attention');
      assert.equal(act(s6, 'transition_resume')?.enabled, true);
      assert.equal(act(s6, 'transition_resume')?.confirm, MIGRATION_CONFIRMATIONS.cutover);
      assert.equal(act(s6, 'cutover_abort')?.enabled, true);
      assert.equal(act(s6, 'cutover_abort')?.confirm, MIGRATION_CONFIRMATIONS.cutoverAbort);
      assert.equal(s.cutover.available, false);
      assert.equal((s.cutover.criteria as CutoverCriterion[]).find((c) => c.id === 'no_active_transition')?.ok, true, 'la transizione attiva non conta come "un\'altra"');

      // Oltre il passo d'epoch: niente annullamento.
      await sql`INSERT INTO cal_migration_journal (transition_id, step, seq, status, attempts, data, started_at, finished_at) VALUES (${id}::uuid, 'epoch', 9, 'done', 1, '{}'::jsonb, now(), now())`;
      const after = step6(await stateView());
      assert.equal(act(after, 'cutover_abort')?.enabled, false);
      assert.match(act(after, 'cutover_abort')?.reason ?? '', /epoch/);
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('mode radicale: finestra, anteprima e rollback, finalize troppo presto, export, passi 1-5 fermi', async () => {
    withOfflineRadicale();
    try {
      await radicaleMode({ cutoverAgoDays: 1, windowDays: 30 });
      const s = await stateView();
      assert.equal(s.backend.mode, 'radicale');
      assert.equal(s.wizard.current_step, 'passaggio');
      assert.ok(s.rollback_window, 'finestra di rollback nello stato');
      assert.equal(s.rollback_window.expired, false);
      assert.ok(s.rollback_window.days_left >= 28 && s.rollback_window.days_left <= 29, String(s.rollback_window.days_left));
      assert.equal(s.rollback_window.finalize_ready, false);
      assert.ok(s.reverse_projection === null || typeof s.reverse_projection.objects === 'number');
      const s6 = step6(s);
      assert.equal(act(s6, 'rollback_preview')?.enabled, true);
      assert.equal(act(s6, 'rollback')?.enabled, false);
      assert.match(act(s6, 'rollback')?.reason ?? '', /anteprima/);
      assert.equal(act(s6, 'rollback')?.confirm, MIGRATION_CONFIRMATIONS.rollback);
      assert.equal(act(s6, 'finalize')?.enabled, false);
      assert.equal(act(s6, 'finalize')?.confirm, MIGRATION_CONFIRMATIONS.finalize);
      assert.equal(act(s6, 'export_v2')?.enabled, true);
      for (const st of (s.wizard.steps as Step[]).slice(0, 5)) {
        for (const a of st.actions) {
          if (['initialize', 'create_collections', 'archive', 'declare', 'identity_reassign', 'plan', 'apply', 'verify', 'accept', 'shadow_on'].includes(a.id)) {
            assert.equal(a.enabled, false, `${st.id}/${a.id} ferma fuori da mode postgres`);
            assert.match(a.reason ?? '', /Postgres non è più autorevole/);
          }
        }
      }

      // Anteprima fresca dopo il passaggio: rollback abilitato.
      await recordPreview();
      const withPreview = step6(await stateView());
      assert.equal(act(withPreview, 'rollback')?.enabled, true, JSON.stringify(act(withPreview, 'rollback')));

      // Anteprima vecchia: da rigenerare.
      await sql`DELETE FROM cal_migration_runs`;
      await recordPreview({ minutesAgo: F4_LIMITS.rollbackPreviewMaxAgeMinutes + 5 });
      const stale = step6(await stateView());
      assert.equal(act(stale, 'rollback')?.enabled, false);
      assert.match(act(stale, 'rollback')?.reason ?? '', /minuti/);
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('finestra scaduta e mode finalized: niente rollback, export sempre disponibile', async () => {
    withOfflineRadicale();
    try {
      await radicaleMode({ cutoverAgoDays: 40, windowDays: 30 });
      const expired = await stateView();
      assert.equal(expired.rollback_window.expired, true);
      assert.equal(expired.rollback_window.days_left, 0);
      const s6 = step6(expired);
      assert.equal(s6.status, 'attention');
      assert.equal(act(s6, 'rollback_preview')?.enabled, false);
      assert.equal(act(s6, 'rollback')?.enabled, false);

      await sql`UPDATE calendar_backend_state SET mode = 'finalized', finalized_at = now(), rollback_until = NULL WHERE id`;
      invalidateBackendModeCache();
      const fin = await stateView();
      const f6 = step6(fin);
      assert.equal(f6.status, 'done');
      assert.equal(act(f6, 'rollback')?.enabled, false);
      assert.equal(act(f6, 'export_v2')?.enabled, true);
      assert.equal(fin.reverse_projection, null);
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });
});

// ─── Conferme, chiavi, precondizioni ───────────────────────────────

describe('POST /cutover', () => {
  test('conferma esatta, chiave obbligatoria, finestra 14-90, Radicale configurato, criteri: Postgres resta autorevole', async () => {
    configureRadicaleRuntime(null);
    await clearAll();
    const noConfirm = await api.post(`${BASE}/cutover`, { auth: 'admin', body: { confirm: 'passa a radicale' }, headers: { 'Idempotency-Key': newKey() } });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.json.code, 'CONFIRMATION_REQUIRED');
    assert.equal(noConfirm.json.details.expected, MIGRATION_CONFIRMATIONS.cutover);

    const noKey = await api.post(`${BASE}/cutover`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.code, 'IDEMPOTENCY_KEY_REQUIRED');

    for (const days of [7, 91, 30.5, '30']) {
      const bad = await api.post(`${BASE}/cutover`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover, rollback_window_days: days }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(bad.status, 400, String(days));
      assert.equal(bad.json.code, 'VALIDATION_FAILED');
    }

    const noRadicale = await api.post(`${BASE}/cutover`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover }, headers: { 'Idempotency-Key': newKey() } });
    assert.equal(noRadicale.status, 503);
    assert.equal(noRadicale.json.code, 'RADICALE_NOT_CONFIGURED');

    withOfflineRadicale();
    try {
      await initializedPostgres();
      const blocked = await api.post(`${BASE}/cutover`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover, rollback_window_days: 30 }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(blocked.status, 409, blocked.text);
      assert.equal(blocked.json.code, 'PRECONDITION_FAILED');
      const reasons = blocked.json.details.reasons as string[];
      for (const r of ['IDENTITY_NOT_OK', 'VERIFY_REQUIRED', 'DEVICE_MATRIX_REQUIRED', 'BACKUP_TOO_OLD', 'PROBE_UNAVAILABLE', 'CONTROL_PLANE_UNAVAILABLE']) {
        assert.ok(reasons.includes(r), `motivo ${r}: ${reasons.join(', ')}`);
      }
      assert.ok(Array.isArray(blocked.json.details.criteria));
      const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_migration_runs`;
      assert.equal(n, 0, 'nessun run creato');
      assert.deepEqual(await backendRow(), { mode: 'postgres', epoch: 1, write_freeze: false });
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('mode radicale: MODE_NOT_POSTGRES', async () => {
    withOfflineRadicale();
    try {
      await radicaleMode();
      const res = await api.post(`${BASE}/cutover`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(res.status, 409);
      assert.ok((res.json.details.reasons as string[]).includes('MODE_NOT_POSTGRES'));
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });
});

describe('transizione attiva', () => {
  test('ogni avvio riceve 409 TRANSITION_IN_PROGRESS con la transizione; GET /transition la mostra', async () => {
    withOfflineRadicale();
    try {
      await initializedPostgres();
      const id = await activeTransition('cutover', ['preflight']);
      const view = await api.get(`${BASE}/transition`, { auth: 'admin' });
      assert.equal(view.status, 200);
      assert.equal(view.headers.get('cache-control'), 'no-store');
      assert.equal(view.json.id, id);
      assert.equal(view.json.kind, 'cutover');
      assert.equal(view.json.steps.length, 1);

      const attempts: Array<[string, Record<string, unknown>]> = [
        ['/cutover', { confirm: MIGRATION_CONFIRMATIONS.cutover }],
        ['/rollback/preview', {}],
        ['/rollback', { confirm: MIGRATION_CONFIRMATIONS.rollback, preview_run_id: randomUUID() }],
        ['/finalize', { confirm: MIGRATION_CONFIRMATIONS.finalize }],
        ['/rebaseline', { confirm: MIGRATION_CONFIRMATIONS.apply }],
      ];
      for (const [path, body] of attempts) {
        const res = await api.post(`${BASE}${path}`, { auth: 'admin', body, headers: { 'Idempotency-Key': newKey() } });
        assert.equal(res.status, 409, `${path}: ${res.text}`);
        assert.equal(res.json.code, 'TRANSITION_IN_PROGRESS', path);
        assert.equal((res.json.details.transition as TransitionView).id, id, path);
        assert.ok((res.json.details.reasons as string[]).includes('TRANSITION_ACTIVE'));
      }
      const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_migration_runs`;
      assert.equal(n, 0);
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('ripresa: frase del tipo, run del tipo con action resume e i parametri della transizione; replay della chiave', async () => {
    withOfflineRadicale();
    try {
      await initializedPostgres();
      const verifyId = randomUUID();
      await activeTransition('cutover', ['preflight', 'freeze'], { rollback_window_days: 21, verify_run_id: verifyId });
      const wrong = await api.post(`${BASE}/transition/resume`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.rollback }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(wrong.status, 400);
      assert.equal(wrong.json.details.expected, MIGRATION_CONFIRMATIONS.cutover);
      const noKey = await api.post(`${BASE}/transition/resume`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover } });
      assert.equal(noKey.status, 400);
      assert.equal(noKey.json.code, 'IDEMPOTENCY_KEY_REQUIRED');

      const key = newKey();
      const res = await api.post(`${BASE}/transition/resume`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover }, headers: { 'Idempotency-Key': key } });
      assert.equal(res.status, 202, res.text);
      assert.equal(res.json.run.kind, 'cutover');
      assert.equal(res.json.run.status, 'queued');
      const [run] = await sql<Array<{ params: Record<string, unknown> }>>`SELECT params FROM cal_migration_runs WHERE id = ${res.json.run.id}::uuid`;
      assert.deepEqual(run.params, { action: 'resume', rollback_window_days: 21, verify_run_id: verifyId });
      const [audit] = await sql<Array<{ metadata: Record<string, unknown> }>>`
        SELECT metadata FROM audit_logs WHERE table_name = 'calendar_migration' AND record_id = ${res.json.run.id} ORDER BY created_at DESC LIMIT 1
      `;
      assert.equal(audit.metadata.operation, 'transition_resume');

      const replay = await api.post(`${BASE}/transition/resume`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover }, headers: { 'Idempotency-Key': key } });
      assert.equal(replay.status, 200);
      assert.equal(replay.json.replayed, true);
      assert.equal(replay.json.run.id, res.json.run.id);

      // Con il run in coda la transizione non è più "da riprendere".
      const view = await api.get(`${BASE}/transition`, { auth: 'admin' });
      assert.equal(view.json.resumable, false);
      const s6 = step6(await stateView());
      assert.equal(s6.status, 'running');
      assert.equal(act(s6, 'transition_resume')?.enabled, false);
      assert.equal(act(s6, 'cutover_abort')?.enabled, false);
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('F4R3-05: replay della ripresa anche a transizione conclusa nel frattempo (risposta persa): stessa chiave e corpo → lo stesso run, non l\'errore NO_ACTIVE_TRANSITION', async () => {
    withOfflineRadicale();
    try {
      await initializedPostgres();
      const transitionId = await activeTransition('cutover', ['preflight', 'freeze'], { rollback_window_days: 21 });
      const key = newKey();
      const body = { confirm: MIGRATION_CONFIRMATIONS.cutover };
      const first = await api.post(`${BASE}/transition/resume`, { auth: 'admin', body, headers: { 'Idempotency-Key': key } });
      assert.equal(first.status, 202, first.text);
      // La risposta si perde e la transizione si conclude prima del nuovo tentativo.
      await sql`UPDATE cal_migration_transitions SET status = 'completed', finished_at = now() WHERE id = ${transitionId}::uuid`;
      const retry = await api.post(`${BASE}/transition/resume`, { auth: 'admin', body, headers: { 'Idempotency-Key': key } });
      assert.ok(retry.status >= 200 && retry.status < 300, retry.text);
      assert.equal(retry.json.replayed, true);
      assert.equal(retry.json.run.id, first.json.run.id);
      // Una chiave nuova, invece, trova davvero la transizione conclusa.
      const fresh = await api.post(`${BASE}/transition/resume`, { auth: 'admin', body, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(fresh.status, 409, fresh.text);
      assert.ok((fresh.json.details.reasons as string[]).includes('NO_ACTIVE_TRANSITION'));
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('ripresa di un rollback: TORNA A POSTGRES e i parametri dell\'anteprima; nessuna transizione → NO_ACTIVE_TRANSITION', async () => {
    withOfflineRadicale();
    try {
      await radicaleMode();
      const none = await api.post(`${BASE}/transition/resume`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.rollback }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(none.status, 409);
      assert.ok((none.json.details.reasons as string[]).includes('NO_ACTIVE_TRANSITION'));

      const previewId = randomUUID();
      const hash = 'a'.repeat(64);
      await activeTransition('rollback', ['preflight'], { preview_run_id: previewId, expect_preview_hash: hash, emergency: true });
      const res = await api.post(`${BASE}/transition/resume`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.rollback }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(res.status, 202, res.text);
      assert.equal(res.json.run.kind, 'rollback');
      const [run] = await sql<Array<{ params: Record<string, unknown> }>>`SELECT params FROM cal_migration_runs WHERE id = ${res.json.run.id}::uuid`;
      assert.deepEqual(run.params, { action: 'resume', preview_run_id: previewId, expect_preview_hash: hash, emergency: true });
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('annullamento: ANNULLA IL PASSAGGIO, solo prima del passo d\'epoch e solo del tipo giusto', async () => {
    withOfflineRadicale();
    try {
      await initializedPostgres();
      const none = await api.post(`${BASE}/cutover/abort`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutoverAbort }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(none.status, 409);
      assert.ok((none.json.details.reasons as string[]).includes('NO_ACTIVE_TRANSITION'));

      const id = await activeTransition('cutover', ['preflight', 'freeze']);
      const wrongKind = await api.post(`${BASE}/rollback/abort`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutoverAbort }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(wrongKind.status, 409);
      assert.ok((wrongKind.json.details.reasons as string[]).includes('NO_ACTIVE_TRANSITION'));

      const noConfirm = await api.post(`${BASE}/cutover/abort`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutover }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(noConfirm.status, 400);
      assert.equal(noConfirm.json.details.expected, MIGRATION_CONFIRMATIONS.cutoverAbort);

      const ok = await api.post(`${BASE}/cutover/abort`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutoverAbort }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(ok.status, 202, ok.text);
      const [run] = await sql<Array<{ kind: string; params: Record<string, unknown> }>>`SELECT kind, params FROM cal_migration_runs WHERE id = ${ok.json.run.id}::uuid`;
      assert.equal(run.kind, 'cutover');
      assert.equal(run.params.action, 'abort');

      await sql`DELETE FROM cal_jobs WHERE kind = ${MIGRATION_RUN_JOB_KIND}`;
      await sql`DELETE FROM cal_migration_runs`;
      await sql`INSERT INTO cal_migration_journal (transition_id, step, seq, status, attempts, data, started_at, finished_at) VALUES (${id}::uuid, 'epoch', 9, 'done', 1, '{}'::jsonb, now(), now())`;
      const late = await api.post(`${BASE}/cutover/abort`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.cutoverAbort }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(late.status, 409);
      assert.ok((late.json.details.reasons as string[]).includes('TRANSITION_NOT_ABORTABLE'));
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });
});

// ─── Rollback, anteprima, finalize, ri-baseline ───────────────────────────────

describe('rollback e anteprima', () => {
  test('anteprima: solo in mode radicale con la finestra aperta; run asincrono con replay', async () => {
    withOfflineRadicale();
    try {
      await initializedPostgres();
      const pg = await api.post(`${BASE}/rollback/preview`, { auth: 'admin', body: {} });
      assert.equal(pg.status, 409);
      assert.ok((pg.json.details.reasons as string[]).includes('MODE_NOT_RADICALE'));

      await radicaleMode({ cutoverAgoDays: 40, windowDays: 30 });
      const expired = await api.post(`${BASE}/rollback/preview`, { auth: 'admin', body: {} });
      assert.equal(expired.status, 409);
      assert.ok((expired.json.details.reasons as string[]).includes('ROLLBACK_WINDOW_EXPIRED'));

      await radicaleMode();
      const key = newKey();
      const res = await api.post(`${BASE}/rollback/preview`, { auth: 'admin', body: {}, headers: { 'Idempotency-Key': key } });
      assert.equal(res.status, 202, res.text);
      assert.equal(res.json.run.kind, 'rollback_preview');
      const again = await api.post(`${BASE}/rollback/preview`, { auth: 'admin', body: {}, headers: { 'Idempotency-Key': key } });
      assert.equal(again.status, 200);
      assert.equal(again.json.replayed, true);
      const busy = await api.post(`${BASE}/rollback/preview`, { auth: 'admin', body: {}, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(busy.status, 409);
      assert.equal(busy.json.code, 'MIGRATION_BUSY');
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('rollback: anteprima obbligatoria, fresca e coerente; conferme (anche di emergenza); identità', async () => {
    withOfflineRadicale();
    try {
      await radicaleMode();
      const noPreview = await api.post(`${BASE}/rollback`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.rollback }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(noPreview.status, 400);
      assert.equal(noPreview.json.code, 'VALIDATION_FAILED');

      const preview = await recordPreview();
      const noConfirm = await api.post(`${BASE}/rollback`, { auth: 'admin', body: { preview_run_id: preview.id, confirm: 'torna a postgres' }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(noConfirm.status, 400);
      assert.equal(noConfirm.json.details.expected, MIGRATION_CONFIRMATIONS.rollback);

      const emergencyNoPhrase = await api.post(`${BASE}/rollback`, {
        auth: 'admin',
        body: { preview_run_id: preview.id, confirm: MIGRATION_CONFIRMATIONS.rollback, emergency: true },
        headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(emergencyNoPhrase.status, 400);
      assert.equal(emergencyNoPhrase.json.details.expected, MIGRATION_CONFIRMATIONS.rollbackEmergency);

      const noKey = await api.post(`${BASE}/rollback`, { auth: 'admin', body: { preview_run_id: preview.id, confirm: MIGRATION_CONFIRMATIONS.rollback } });
      assert.equal(noKey.status, 400);
      assert.equal(noKey.json.code, 'IDEMPOTENCY_KEY_REQUIRED');

      const unknown = await api.post(`${BASE}/rollback`, { auth: 'admin', body: { preview_run_id: randomUUID(), confirm: MIGRATION_CONFIRMATIONS.rollback }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(unknown.status, 409);
      assert.ok((unknown.json.details.reasons as string[]).includes('PREVIEW_REQUIRED'));

      const mismatch = await api.post(`${BASE}/rollback`, {
        auth: 'admin',
        body: { preview_run_id: preview.id, expect_preview_hash: 'b'.repeat(64), confirm: MIGRATION_CONFIRMATIONS.rollback },
        headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(mismatch.status, 409);
      assert.ok((mismatch.json.details.reasons as string[]).includes('PREVIEW_STALE'));

      const stale = await recordPreview({ minutesAgo: F4_LIMITS.rollbackPreviewMaxAgeMinutes + 1 });
      const old = await api.post(`${BASE}/rollback`, { auth: 'admin', body: { preview_run_id: stale.id, confirm: MIGRATION_CONFIRMATIONS.rollback }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(old.status, 409);
      assert.ok((old.json.details.reasons as string[]).includes('PREVIEW_STALE'));

      // Anteprima valida, ma Radicale irraggiungibile: identità non verificata, nessun run.
      const identity = await api.post(`${BASE}/rollback`, {
        auth: 'admin',
        body: { preview_run_id: preview.id, expect_preview_hash: preview.hash, confirm: MIGRATION_CONFIRMATIONS.rollback },
        headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(identity.status, 409, identity.text);
      assert.ok((identity.json.details.reasons as string[]).includes('IDENTITY_NOT_OK'));
      const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_migration_runs WHERE kind = 'rollback'`;
      assert.equal(n, 0);
      assert.equal((await backendRow()).mode, 'radicale');

      await sql`UPDATE calendar_backend_state SET rollback_until = now() - interval '1 minute' WHERE id`;
      const expired = await api.post(`${BASE}/rollback`, { auth: 'admin', body: { preview_run_id: preview.id, confirm: MIGRATION_CONFIRMATIONS.rollback }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(expired.status, 409);
      assert.ok((expired.json.details.reasons as string[]).includes('ROLLBACK_WINDOW_EXPIRED'));
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('F4R3-04: anteprima A riuscita e B fallita → la finestra espone A (quella che il server valida) e POST /rollback con A è accettato', async () => {
    withOfflineRadicale();
    try {
      await radicaleMode();
      const a = await recordPreview();
      // Rigenerazione fallita (Radicale instabile): l'ultima anteprima per esito è B, ma il server valida A.
      await sql`
        INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, error_code, error, created_at, started_at, finished_at, attempts)
        VALUES ('rollback_preview', 'failed', 'admin', 'admin:test', '{}'::jsonb, NULL, 'RADICALE_UNREACHABLE', 'Radicale non risponde', now(), now(), now(), 1)
      `;
      const view = await stateView();
      assert.equal(view.last_runs.rollback_preview.status, 'failed', 'l\'ultima anteprima per esito è quella fallita');
      assert.equal(view.rollback_window.preview.run_id, a.id);
      assert.equal(view.rollback_window.preview.ok, true);
      assert.equal(view.rollback_window.preview.preview_hash, a.hash);

      const res = await api.post(`${BASE}/rollback`, {
        auth: 'admin',
        body: { preview_run_id: view.rollback_window.preview.run_id, expect_preview_hash: view.rollback_window.preview.preview_hash, confirm: MIGRATION_CONFIRMATIONS.rollback },
        headers: { 'Idempotency-Key': newKey() },
      });
      const reasons = ((res.json.details?.reasons ?? []) as string[]);
      assert.ok(!reasons.includes('PREVIEW_REQUIRED') && !reasons.includes('PREVIEW_STALE'), `anteprima accettata: ${res.text}`);
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('finalize: CHIUDI LA FINESTRA, chiave, mode radicale e blocchi del finalize', async () => {
    withOfflineRadicale();
    try {
      await initializedPostgres();
      const pg = await api.post(`${BASE}/finalize`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.finalize }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(pg.status, 409);
      assert.ok((pg.json.details.reasons as string[]).includes('MODE_NOT_RADICALE'));

      await radicaleMode({ cutoverAgoDays: 1 });
      const noConfirm = await api.post(`${BASE}/finalize`, { auth: 'admin', body: { confirm: 'chiudi' }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(noConfirm.status, 400);
      assert.equal(noConfirm.json.details.expected, MIGRATION_CONFIRMATIONS.finalize);
      const noKey = await api.post(`${BASE}/finalize`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.finalize } });
      assert.equal(noKey.status, 400);
      assert.equal(noKey.json.code, 'IDEMPOTENCY_KEY_REQUIRED');
      const early = await api.post(`${BASE}/finalize`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.finalize }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(early.status, 409, early.text);
      assert.equal(early.json.code, 'PRECONDITION_FAILED');
      assert.ok((early.json.details.reasons as string[]).includes('FINALIZE_TOO_EARLY'), early.text);
      assert.equal((await backendRow()).mode, 'radicale');
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('ri-baseline: APPLICA, chiave, solo mode postgres con l\'identità verificata', async () => {
    withOfflineRadicale();
    try {
      await radicaleMode();
      const radicale = await api.post(`${BASE}/rebaseline`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.apply }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(radicale.status, 409);
      assert.ok((radicale.json.details.reasons as string[]).includes('MODE_NOT_POSTGRES'));

      await initializedPostgres();
      const noConfirm = await api.post(`${BASE}/rebaseline`, { auth: 'admin', body: { confirm: 'applica' }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(noConfirm.status, 400);
      const noKey = await api.post(`${BASE}/rebaseline`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.apply } });
      assert.equal(noKey.status, 400);
      assert.equal(noKey.json.code, 'IDEMPOTENCY_KEY_REQUIRED');
      const identity = await api.post(`${BASE}/rebaseline`, { auth: 'admin', body: { confirm: MIGRATION_CONFIRMATIONS.apply }, headers: { 'Idempotency-Key': newKey() } });
      assert.equal(identity.status, 409);
      assert.ok((identity.json.details.reasons as string[]).includes('IDENTITY_NOT_OK'));
    } finally {
      configureRadicaleRuntime(null);
      await clearAll();
    }
  });

  test('GET /reverse: salute della proiezione inversa', async () => {
    await clearAll();
    const res = await api.get(`${BASE}/reverse`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.json.active, false);
    for (const k of ['projected', 'degraded', 'failed', 'removed']) assert.equal(typeof res.json.by_status[k], 'number');
  });
});

// ─── Esecutore ───────────────────────────────

describe('esecutore dei run F4', () => {
  test('reaper: un run di transizione interrotto lascia la transizione attiva e lo dice nel messaggio', async () => {
    await initializedPostgres();
    const transitionId = await activeTransition('cutover', ['preflight']);
    const [run] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, started_at, heartbeat_at, attempts)
      VALUES ('cutover', 'running', 'admin', 'admin:test', '{"action":"start","rollback_window_days":30,"verify_run_id":null}'::jsonb,
              now() - interval '1 hour', now() - make_interval(secs => ${Math.ceil(MIGRATION_LIMITS.staleHeartbeatMs / 1000) + 60}), 1)
      RETURNING id::text AS id
    `;
    const closed = await reapInterruptedRuns();
    assert.ok(closed >= 1);
    const [after] = await sql<Array<{ status: string; error: string }>>`SELECT status, error FROM cal_migration_runs WHERE id = ${run.id}::uuid`;
    assert.equal(after.status, 'interrupted');
    assert.match(after.error, /transizione resta attiva/);
    const [t] = await sql<Array<{ status: string }>>`SELECT status FROM cal_migration_transitions WHERE id = ${transitionId}::uuid`;
    assert.equal(t.status, 'active');
    const view = await api.get(`${BASE}/transition`, { auth: 'admin' });
    assert.equal(view.json.resumable, true);
    await clearAll();
  });
});

// ─── Derivazione pura del passo 6 ───────────────────────────────

describe('passo 6 (derivazione pura)', () => {
  const now = new Date('2026-10-17T10:00:00Z');
  const baseState = (over: Partial<MigrationBackendState> = {}): MigrationBackendState => ({
    id: true, mode: 'postgres', write_freeze: false, volume_id: VOLUME_ID, epoch: 1, credential_epoch: 0, policy_version: 1,
    restore_guard_until: null, rebuild_required: false, shadow_enabled: true, shadow_since: new Date('2026-10-01T00:00:00Z'),
    cutover_at: null, cutover_by: null, rollback_until: null, finalized_at: null, api_min_version: 0,
    last_stack_backup: null, migration_declarations: {}, updated_at: now,
    ...over,
  } as unknown as MigrationBackendState);
  const inputs = (over: Partial<WizardStateInputs>): WizardStateInputs => ({
    now,
    state: baseState(),
    configured: true,
    identity: { status: 'ok', checked_at: now.toISOString(), detail: null },
    active: null,
    lastByKind: new Map(),
    lastFinishedByKind: new Map(),
    lastSucceededByKind: new Map(),
    verify: { runId: null, verdicts: [], acceptable: false, finished_at: null },
    parity: null,
    ledger: { live: 0, pending_intents: 0, revalidation_pending: 0 },
    ...over,
  });
  const criteria = (ok: boolean): CutoverCriterion[] => [
    { id: 'no_active_transition', label: 'x', ok: true, detail: null },
    { id: 'identity_ok', label: 'x', ok: true, detail: null },
    { id: 'verify_acceptable', label: 'x', ok, detail: ok ? null : 'verifica mancante' },
    { id: 'backup_recent', label: 'x', ok: false, detail: null },
  ];

  test('criteri F4: tutti ok → passaggio abilitato (backup_recent è informativo); uno mancante → no', () => {
    const ok = deriveWizardSteps(inputs({ f4: { criteria: criteria(true), transition: null, rollbackWindow: null, reverse: null } }));
    assert.equal(ok.cutover.available, true);
    const s6 = ok.steps[5];
    assert.equal(s6.status, 'todo');
    assert.equal(s6.actions.find((a) => a.id === 'cutover')?.enabled, true);

    const missing = deriveWizardSteps(inputs({ f4: { criteria: criteria(false), transition: null, rollbackWindow: null, reverse: null } }));
    assert.equal(missing.cutover.available, false);
    assert.ok(missing.steps[5].blocking.includes('verifica mancante'));
    assert.equal(missing.steps[5].actions.find((a) => a.id === 'cutover')?.enabled, false);
  });

  test('senza ingressi F4: criteri ricavati, passaggio non disponibile', () => {
    const r = deriveWizardSteps(inputs({}));
    assert.equal(r.cutover.available, false);
    assert.equal(r.steps[5].status, 'locked');
    assert.equal(r.steps[5].actions.find((a) => a.id === 'cutover')?.enabled, false);
  });

  test('rollback concluso in mode postgres: ri-baseline di riparazione abilitata', () => {
    const transition = {
      id: randomUUID(), kind: 'rollback', status: 'completed', from_mode: 'radicale', target_mode: 'postgres', run_id: null,
      epoch_before: 2, epoch_after: 3, started_by: 'admin:x', started_at: now.toISOString(), finished_at: now.toISOString(),
      outcome_code: null, outcome: null, data: {}, steps: [], next_step: null, resumable: false, abortable: false,
    } as TransitionView;
    const r = deriveWizardSteps(inputs({ f4: { criteria: criteria(false), transition, rollbackWindow: null, reverse: null } }));
    assert.equal(r.steps[5].actions.find((a) => a.id === 'rebaseline')?.enabled, true);
    assert.match(r.steps[5].summary, /Rollback concluso/);
  });
});

// ─── Saga "questa e le successive" con PgLegacyStore ───────────────────────────────

describe('POST /api/admin/calendar/events/:id/split (PgLegacyStore)', () => {
  async function lavoroId(): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`SELECT id::text AS id FROM calendars WHERE slug = 'lavoro'`;
    return row.id;
  }
  async function createSeries(rrule = 'FREQ=DAILY;COUNT=10'): Promise<Record<string, any>> {
    const res = await api.post(EVENTS, {
      auth: 'admin',
      body: {
        calendar_id: await lavoroId(),
        summary: 'Standup F4',
        start_time: '2026-11-02T08:00:00.000Z',
        end_time: '2026-11-02T08:30:00.000Z',
        rrule,
      },
    });
    assert.equal(res.status, 200, res.text);
    return res.json.event;
  }

  test('sposta questa e le successive: master troncato a cutoff − 60 s e nuova serie con COUNT residuo, nella stessa transazione', async () => {
    await clearAll();
    const master = await createSeries();
    const res = await api.post(`${EVENTS}/${master.id}/split`, {
      auth: 'admin',
      body: { original_start: '2026-11-04T08:00:00.000Z', start_time: '2026-11-04T09:00:00.000Z', end_time: '2026-11-04T10:00:00.000Z' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.whole_series, false);
    assert.match(res.json.head.rrule, /UNTIL=20261104T075900Z/);
    assert.doesNotMatch(res.json.head.rrule, /COUNT=/);
    assert.equal(new Date(res.json.tail.start_time).toISOString(), '2026-11-04T09:00:00.000Z');
    assert.equal(new Date(res.json.tail.end_time).toISOString(), '2026-11-04T10:00:00.000Z');
    assert.match(res.json.tail.rrule, /COUNT=8/, 'COUNT residuo: 10 occorrenze, 2 prima del taglio (parità con splitSeries di calendar-core)');
    assert.equal(res.json.tail.source, 'admin');
    assert.equal(res.json.tail.summary, 'Standup F4');
    assert.equal('caldes_object_id' in res.json.tail, false, 'solo le colonne legacy');
    const rows = await sql`SELECT id FROM calendar_events WHERE id IN (${master.id}::uuid, ${res.json.tail.id}::uuid)`;
    assert.equal(rows.length, 2);
  });

  test('F4R3-03: COUNT=10 con EXDATE e override dopo il taglio → 10 occorrenze totali, nessun duplicato, EXDATE rispettata, override spostati con lo scarto', async () => {
    await clearAll();
    const master = await createSeries('FREQ=DAILY;COUNT=10');
    // Occorrenze: 2026-11-02 … 2026-11-11 alle 08:00Z (la serie parte il 2026-11-02T08:00Z). EXDATE del 08/11 (dopo il taglio) e
    // override spostato del 07/11.
    const exdate = '2026-11-08T08:00:00.000Z';
    const overrideRid = '2026-11-07T08:00:00.000Z';
    await sql`UPDATE calendar_events SET exdates = ${sql.json([exdate] as never)} WHERE id = ${master.id}::uuid`;
    const [ov] = await sql<Array<{ id: string }>>`
      INSERT INTO calendar_events (calendar_id, uid, summary, start_time, end_time, recurrence_master_id, recurrence_id, source, status)
      SELECT calendar_id, uid || '-ov', 'Spostata dopo il taglio', '2026-11-07T14:00:00Z', '2026-11-07T14:30:00Z', id, ${overrideRid}::timestamptz, 'admin', 'confirmed'
      FROM calendar_events WHERE id = ${master.id}::uuid
      RETURNING id
    `;
    // Taglio a 2026-11-05 (4ª occorrenza) con spostamento di +1 h.
    const res = await api.post(`${EVENTS}/${master.id}/split`, {
      auth: 'admin',
      body: { original_start: '2026-11-05T08:00:00.000Z', start_time: '2026-11-05T09:00:00.000Z', end_time: '2026-11-05T09:30:00.000Z' },
    });
    assert.equal(res.status, 200, res.text);
    assert.match(res.json.tail.rrule, /COUNT=7/, '3 occorrenze nella testa → 7 residue');
    const rows = await sql<Array<{ id: string; recurrence_master_id: string | null; recurrence_id: Date | null; exdates: string[] }>>`
      SELECT id::text AS id, recurrence_master_id::text AS recurrence_master_id, recurrence_id, exdates FROM calendar_events WHERE id IN (${master.id}::uuid, ${res.json.tail.id}::uuid, ${ov.id}::uuid)
    `;
    const head = rows.find((r) => r.id === master.id)!;
    const tail = rows.find((r) => r.id === res.json.tail.id)!;
    const moved = rows.find((r) => r.id === ov.id)!;
    assert.deepEqual(head.exdates, [], 'EXDATE dopo il taglio tolta dalla testa');
    assert.deepEqual(tail.exdates, ['2026-11-08T09:00:00.000Z'], 'EXDATE traslata dello scarto (+1 h) nella nuova serie');
    assert.equal(moved.recurrence_master_id, res.json.tail.id, 'override passato alla nuova serie');
    assert.equal(moved.recurrence_id?.toISOString(), '2026-11-07T09:00:00.000Z', 'recurrence_id traslato');

    const { listOccurrences } = await import('../../src/lib/calendar/legacy/events-pg');
    const occ = await listOccurrences({ fromIso: '2026-11-01T00:00:00Z', toIso: '2026-12-31T00:00:00Z' });
    const ids = new Set([master.id, res.json.tail.id, ov.id]);
    const mine = occ.filter((o) => ids.has(o.id));
    assert.equal(mine.length, 10 - 1, '10 occorrenze meno quella esclusa dall\'EXDATE (l\'override è l\'occorrenza del 07/11, non una in più)');
    const starts = mine.map((o) => new Date(o.start_time).toISOString());
    assert.equal(new Set(starts).size, starts.length, 'nessun duplicato');
    assert.ok(!starts.includes('2026-11-08T09:00:00.000Z') && !starts.includes('2026-11-08T08:00:00.000Z'), 'EXDATE rispettata');
    assert.ok(starts.includes('2026-11-07T14:00:00.000Z'), 'override spostato presente');
    assert.ok(!starts.includes('2026-11-07T09:00:00.000Z'), 'l\'occorrenza sostituita dall\'override non ricompare');
  });

  test('elimina questa e le successive: solo il taglio; prima occorrenza = tutta la serie', async () => {
    await clearAll();
    const master = await createSeries('FREQ=DAILY');
    const before = (await sql`SELECT id FROM calendar_events WHERE summary = 'Standup F4'`).length;
    const res = await api.post(`${EVENTS}/${master.id}/split`, { auth: 'admin', body: { original_start: '2026-11-05T08:00:00.000Z', delete: true } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.tail, null);
    assert.match(res.json.head.rrule, /UNTIL=20261105T075900Z/);
    assert.equal((await sql`SELECT id FROM calendar_events WHERE summary = 'Standup F4'`).length, before, 'nessuna serie nuova');

    const second = await createSeries();
    const first = await api.post(`${EVENTS}/${second.id}/split`, {
      auth: 'admin',
      body: { original_start: '2026-11-02T08:00:00.000Z', start_time: '2026-11-02T07:00:00.000Z', end_time: '2026-11-02T07:45:00.000Z' },
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.whole_series, true);
    assert.equal(new Date(first.json.tail.start_time).toISOString(), '2026-11-02T07:00:00.000Z');
    assert.equal(first.json.tail.rrule, second.rrule, 'la regola della serie intera non cambia');
  });

  test('F4R3-06: difesa CSRF — text/plain → 415, Sec-Fetch-Site cross-site → 403 CSRF_REJECTED, Origin estranea → 403; same-origin passa', async () => {
    await clearAll();
    const master = await createSeries();
    const json = JSON.stringify({ original_start: '2026-11-04T08:00:00.000Z', delete: true });
    const plain = await api.post(`${EVENTS}/${master.id}/split`, { auth: 'admin', body: json, headers: { 'Content-Type': 'text/plain' } });
    assert.equal(plain.status, 415, plain.text);
    const cross = await api.post(`${EVENTS}/${master.id}/split`, {
      auth: 'admin', body: json, headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(cross.status, 403, cross.text);
    assert.equal(cross.json.code, 'CSRF_REJECTED');
    const foreign = await api.post(`${EVENTS}/${master.id}/split`, {
      auth: 'admin', body: json, headers: { 'Content-Type': 'application/json', Origin: 'https://evil.caldes.test' },
    });
    assert.equal(foreign.status, 403, foreign.text);
    assert.equal(foreign.json.code, 'CSRF_REJECTED');
    const [intact] = await sql`SELECT rrule FROM calendar_events WHERE id = ${master.id}::uuid`;
    assert.equal(intact.rrule, master.rrule, 'nessuna scrittura per le richieste rifiutate');
    const ok = await api.post(`${EVENTS}/${master.id}/split`, {
      auth: 'admin', body: json, headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(ok.status, 200, ok.text);
  });

  test('validazione: original_start, master ricorrente, delete con orari, 404; 503 durante una transizione', async () => {
    await clearAll();
    const master = await createSeries();
    const noStart = await api.post(`${EVENTS}/${master.id}/split`, { auth: 'admin', body: {} });
    assert.equal(noStart.status, 400);
    const both = await api.post(`${EVENTS}/${master.id}/split`, { auth: 'admin', body: { original_start: '2026-11-04T08:00:00.000Z', delete: true, start_time: '2026-11-04T09:00:00.000Z' } });
    assert.equal(both.status, 400);
    const missing = await api.post(`${EVENTS}/${randomUUID()}/split`, { auth: 'admin', body: { original_start: '2026-11-04T08:00:00.000Z' } });
    assert.equal(missing.status, 404);
    const single = await api.post(EVENTS, {
      auth: 'admin',
      body: { calendar_id: await lavoroId(), summary: 'Singolo F4', start_time: '2026-11-02T08:00:00.000Z', end_time: '2026-11-02T08:30:00.000Z' },
    });
    const notSeries = await api.post(`${EVENTS}/${single.json.event.id}/split`, { auth: 'admin', body: { original_start: '2026-11-02T08:00:00.000Z' } });
    assert.equal(notSeries.status, 400);

    await sql`UPDATE calendar_backend_state SET mode = 'cutover', volume_id = ${VOLUME_ID}::uuid, epoch = 1, write_freeze = true WHERE id`;
    invalidateBackendModeCache();
    try {
      const frozen = await api.post(`${EVENTS}/${master.id}/split`, { auth: 'admin', body: { original_start: '2026-11-04T08:00:00.000Z', delete: true } });
      assert.equal(frozen.status, 503, frozen.text);
      assert.equal(frozen.json.code, 'CALENDAR_UNAVAILABLE');
    } finally {
      await clearAll();
    }
  });
});
