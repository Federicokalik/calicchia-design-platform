/**
 * Cutover della F4 senza Radicale (apps/api/src/lib/calendar/migration/
 * {cutover,smoke}.ts, apps/api/src/lib/calendar/api-level.ts, archivio in
 * sola lettura di radicale/types.ts e policy.ts; design §13.10, §16.6;
 * contratto docs/calendar-radicale/contracts/f4-modules.md §3). Il cutover
 * completo, la verifica rossa, i kill a ogni passo e i contratti in mode
 * radicale sono in test/integration/migration-cutover.test.ts.
 *
 * Cosa si verifica:
 *  - parametri del run e finestra di rollback (CAL_ROLLBACK_WINDOW_DAYS);
 *  - criteri del §3.2 uno per uno, con un motivo per ciascuno e backup_recent
 *    solo informativo; dopo un rollback concluso la parità di 7 giorni è
 *    sostituita da una verifica accettabile successiva;
 *  - run: preflight non soddisfatto → transizione aperta, nessuno stato
 *    toccato, motivi nel run; annullamento dall'admin → mode postgres con il
 *    write_freeze di prima; annullamento senza transizione → NO_ACTIVE_TRANSITION;
 *  - prenotazioni a cavallo del freeze: project_booking accodato per le
 *    prenotazioni create o cambiate dopo l'istante;
 *  - smoke in mode postgres: tutti i controlli verdi e nessuna prenotazione,
 *    job, workflow o audit residuo;
 *  - livello dell'API: api_min_version oltre CALENDAR_API_LEVEL → facade in
 *    503 'store_not_available' (letture e scritture); in mode postgres con 0
 *    nulla cambia;
 *  - archivio della Fase 0 (origin migration) in sola lettura per i device
 *    anche in live, letto dal sidecar.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { logger } from '../../src/lib/logger';
import {
  calendarApiLevelBlocked,
  checkCalendarApiLevel,
  enforceCalendarApiLevelAtBoot,
  resetCalendarApiLevelForTests,
} from '../../src/lib/calendar/api-level';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { listCalendars } from '../../src/lib/calendar/calendars';
import { createBooking } from '../../src/lib/calendar/booking';
import { getBusyRanges } from '../../src/lib/calendar/busy';
import { getCapacityWeeks } from '../../src/lib/calendar/capacity';
import { CalendarStoreUnavailableError } from '../../src/lib/calendar/errors';
import { computeAvailableSlots } from '../../src/lib/calendar/slots';
import { createEvent } from '../../src/lib/calendar/events';
import {
  assertCutoverReady,
  cutoverCriteria,
  type CutoverCriteriaDeps,
  defaultRollbackWindowDays,
  normalizeCutoverParams,
  reconcileBookingsAfterCutover,
  runCutoverWith,
} from '../../src/lib/calendar/migration/cutover';
import { runCutoverSmoke, SMOKE_ATTENDEE_EMAIL } from '../../src/lib/calendar/migration/smoke';
import { beginTransition, epochStep, freezeStep, getActiveTransition, readJournal, runStep, type TransitionContext } from '../../src/lib/calendar/migration/transition';
import type { RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { CollectionSyncError } from '../../src/lib/calendar/radicale/sync';
import { DEAD_PROP } from '../../src/lib/calendar/radicale/types';
import {
  CALENDAR_API_LEVEL,
  type CutoverParams,
  F4_LIMITS,
  type MigrationBackendState,
  MigrationError,
  type MigrationRunContext,
  SMOKE_CHECK_CODES,
} from '../../src/lib/calendar/migration/types';
import { readSidecarCollections } from '../../src/lib/calendar/radicale/policy';
import { DEFAULT_BACKEND_STATE, policyFromState } from '../../src/lib/calendar/radicale/types';

const fx = useFixtures('cutover', { resetBaseline: true });
onBeforeDatabaseClose(async () => {
  resetCalendarApiLevelForTests();
  await resetCalendarBaseline();
});

const VOLUME = '7a2c3b4d-5e6f-4a70-8b9c-0d1e2f3a4b5c';
const log = logger.child({ scope: 'test-cutover' });
const HOUR = 3_600_000;
const DAY = 86_400_000;

afterEach(async () => {
  resetCalendarApiLevelForTests();
  await sql`DELETE FROM cal_migration_transitions`;
  await sql`DELETE FROM cal_migration_runs`;
  await sql`DELETE FROM cal_migration_ledger`;
  await sql`
    UPDATE calendar_backend_state
    SET mode = 'postgres', write_freeze = false, volume_id = NULL, epoch = 0, rollback_until = NULL, cutover_at = NULL, cutover_by = NULL,
        shadow_enabled = false, shadow_since = NULL, last_stack_backup = NULL, migration_declarations = '{}'::jsonb, api_min_version = 0
    WHERE id
  `;
  invalidateBackendModeCache();
});

async function initializedState(): Promise<void> {
  await sql`UPDATE calendar_backend_state SET mode = 'postgres', write_freeze = false, volume_id = ${VOLUME}::uuid, epoch = 1 WHERE id`;
  invalidateBackendModeCache();
}

/** Dipendenze dei criteri senza Radicale: identità verificata, control-plane attivo, probe presente. */
function okDeps(over: Partial<CutoverCriteriaDeps> = {}): Partial<CutoverCriteriaDeps> {
  return {
    assertWritable: async (db) => {
      const [row] = await db`SELECT mode FROM calendar_backend_state WHERE id`;
      if (row.mode !== 'postgres') throw new MigrationError('PRECONDITION_FAILED', 'mode non postgres', { reasons: ['MODE_NOT_POSTGRES'] });
      return {} as MigrationBackendState;
    },
    controlPlaneStatus: () => ({
      running: true, listening: true, policyFile: '/tmp/p.json', heartbeatFile: '/tmp/h.json', identitySource: 'remote',
      lastTick: {
        trigger: 'manual', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, failedStage: null, error: null,
        state: null, identity: null, policy: { written: true, previous: 'same', mode: 'shadow', version: 1, reasons: [] }, heartbeat: { ts: new Date().toISOString() },
      },
      lastSuccessAt: new Date().toISOString(), lastPolicyWriteAt: null, lastHeartbeatAt: null, consecutiveFailures: 0,
    }),
    probeAvailable: () => true,
    principal: () => 'federico',
    ...over,
  };
}

async function insertRun(kind: string, opts: { status?: string; trigger?: string; params?: object; summary?: object | null; finishedAt: Date }): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, created_at, started_at, finished_at, attempts)
    VALUES (${kind}, ${opts.status ?? 'succeeded'}, ${opts.trigger ?? 'admin'}, 'admin:test-cutover', ${sql.json((opts.params ?? {}) as never)},
            ${opts.summary === null ? null : sql.json((opts.summary ?? {}) as never)}, ${opts.finishedAt}, ${opts.finishedAt}, ${opts.finishedAt}, 1)
    RETURNING id::text AS id
  `;
  return row.id;
}

const FULL_VERIFY = { scope: {}, levels: ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 180 };

/**
 * Stato pronto per il cutover: volume inizializzato, shadow con 8 giorni di
 * giri notturni verdi, apply e poi verifica completa verde, matrice device
 * superata, backup coordinato di 10 minuti con l'identità corrente.
 */
async function readyState(now: Date): Promise<{ verifyRunId: string }> {
  await initializedState();
  await sql`UPDATE calendar_backend_state SET shadow_enabled = true, shadow_since = ${new Date(now.getTime() - 9 * DAY)} WHERE id`;
  for (let d = 7; d >= 0; d--) {
    await insertRun('verify', { trigger: 'schedule', params: FULL_VERIFY, summary: { acceptable: true, overall: 'green' }, finishedAt: new Date(now.getTime() - d * DAY - 2 * HOUR) });
  }
  await insertRun('apply', { summary: { zero_writes: false, writes: { create: 3, update: 0, delete: 0 } }, finishedAt: new Date(now.getTime() - 30 * 60_000) });
  const verifyRunId = await insertRun('verify', { params: FULL_VERIFY, summary: { acceptable: true, overall: 'green', calendars: [] }, finishedAt: new Date(now.getTime() - 20 * 60_000) });
  const matrix = { device_matrix: { value: { result: 'passed', devices: ['ios', 'macos', 'davx5', 'thunderbird'], strict_preconditions: true, allday_transp_rule: 'opaque_blocks', note: null }, at: new Date(now.getTime() - DAY).toISOString(), by: 'admin:test' } };
  await sql`
    UPDATE calendar_backend_state
    SET migration_declarations = ${sql.json(matrix as never)},
        last_stack_backup = ${sql.json({ id: 'b1', at: new Date(now.getTime() - 10 * 60_000).toISOString(), complete: true, volume_id: VOLUME, epoch: 1, manifest_sha256: null } as never)}
    WHERE id
  `;
  return { verifyRunId };
}

function byId(list: Array<{ id: string; ok: boolean; detail: string | null }>): Record<string, { ok: boolean; detail: string | null }> {
  return Object.fromEntries(list.map((c) => [c.id, { ok: c.ok, detail: c.detail }]));
}

function runContext(params: Partial<CutoverParams>, runId = randomUUID()): MigrationRunContext<CutoverParams> {
  return {
    runId, kind: 'cutover', trigger: 'admin', actor: 'admin:test-cutover', params: params as CutoverParams, planRunId: null, planHash: null, attempt: 1,
    signal: new AbortController().signal, log, db: sql,
    async progress() {}, async addItems(rows) { return rows.map((_, i) => String(i)); }, throwIfCancelled() {},
  };
}

function expectPrecondition(...reasons: string[]) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof MigrationError, `MigrationError atteso, ricevuto ${String(err)}`);
    assert.equal(err.code, 'PRECONDITION_FAILED', err.message);
    for (const r of reasons) assert.ok((err.details?.reasons as string[] | undefined)?.includes(r), `motivo ${r} in ${JSON.stringify(err.details?.reasons)}`);
    return true;
  };
}

describe('cutover: parametri e finestra di rollback', () => {
  test('finestra di default 30 giorni, CAL_ROLLBACK_WINDOW_DAYS fra 14 e 90, valori fuori intervallo ignorati', () => {
    assert.equal(defaultRollbackWindowDays({}), F4_LIMITS.rollbackWindowDays);
    assert.equal(defaultRollbackWindowDays({ CAL_ROLLBACK_WINDOW_DAYS: '45' }), 45);
    assert.equal(defaultRollbackWindowDays({ CAL_ROLLBACK_WINDOW_DAYS: '7' }), 30);
    assert.equal(defaultRollbackWindowDays({ CAL_ROLLBACK_WINDOW_DAYS: 'trenta' }), 30);
  });

  test('parametri normalizzati e validati', () => {
    assert.deepEqual(normalizeCutoverParams({}, {}), { action: 'start', rollback_window_days: 30, verify_run_id: null });
    const id = randomUUID().toUpperCase();
    assert.deepEqual(normalizeCutoverParams({ action: 'resume', rollback_window_days: 14, verify_run_id: id }, {}), { action: 'resume', rollback_window_days: 14, verify_run_id: id.toLowerCase() });
    assert.throws(() => normalizeCutoverParams({ rollback_window_days: 13 }, {}), /rollback_window_days/);
    assert.throws(() => normalizeCutoverParams({ rollback_window_days: 91 }, {}), /rollback_window_days/);
    assert.throws(() => normalizeCutoverParams({ action: 'boh' as never }, {}), /action/);
    assert.throws(() => normalizeCutoverParams({ verify_run_id: 'non-un-uuid' }, {}), /verify_run_id/);
  });
});

describe('cutover: criteri del contratto §3.2', () => {
  test('stato pronto: tutti i criteri soddisfatti', async () => {
    const now = new Date();
    const { verifyRunId } = await readyState(now);
    const criteria = await assertCutoverReady(sql, { now, verifyRunId, deps: okDeps() });
    const ids = criteria.map((c) => c.id).sort();
    assert.deepEqual(ids, [
      'api_image_pinned', 'archive_readonly', 'backup_fresh', 'backup_recent', 'control_plane', 'device_matrix', 'identity_ok', 'no_active_transition',
      'no_open_conflicts', 'no_revalidation', 'probe', 'shadow_parity', 'verify_acceptable',
    ]);
    for (const c of criteria) assert.equal(c.ok, true, `${c.id}: ${c.detail}`);
  });

  test('ogni criterio non soddisfatto ha il proprio motivo; backup_recent è solo informativo', async () => {
    const now = new Date();
    const { verifyRunId } = await readyState(now);

    // Backup coordinato di 3 ore: backup_fresh no, backup_recent sì (informativo).
    await sql`UPDATE calendar_backend_state SET last_stack_backup = jsonb_set(last_stack_backup, '{at}', ${sql.json(new Date(now.getTime() - 3 * HOUR).toISOString() as never)}) WHERE id`;
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId, deps: okDeps() }), expectPrecondition('BACKUP_TOO_OLD'));
    let c = byId(await cutoverCriteria(sql, { now, verifyRunId, deps: okDeps() }));
    assert.equal(c.backup_fresh.ok, false);
    assert.equal(c.backup_recent.ok, true);
    // Backup di un altro volume: non vale.
    await sql`UPDATE calendar_backend_state SET last_stack_backup = jsonb_set(jsonb_set(last_stack_backup, '{at}', ${sql.json(new Date(now.getTime() - 5 * 60_000).toISOString() as never)}), '{volume_id}', '"00000000-0000-4000-8000-000000000000"') WHERE id`;
    c = byId(await cutoverCriteria(sql, { now, verifyRunId, deps: okDeps() }));
    assert.equal(c.backup_fresh.ok, false);
    assert.match(c.backup_fresh.detail ?? '', /identità/);
    await sql`UPDATE calendar_backend_state SET last_stack_backup = jsonb_set(last_stack_backup, '{volume_id}', ${sql.json(VOLUME as never)}) WHERE id`;

    // Matrice device negativa.
    await sql`UPDATE calendar_backend_state SET migration_declarations = jsonb_set(migration_declarations, '{device_matrix,value,result}', '"failed"') WHERE id`;
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId, deps: okDeps() }), expectPrecondition('DEVICE_MATRIX_REQUIRED'));
    await sql`UPDATE calendar_backend_state SET migration_declarations = jsonb_set(migration_declarations, '{device_matrix,value,result}', '"passed"') WHERE id`;

    // Control-plane e probe.
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId, deps: okDeps({ controlPlaneStatus: () => null }) }), expectPrecondition('CONTROL_PLANE_UNAVAILABLE'));
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId, deps: okDeps({ probeAvailable: () => false }) }), expectPrecondition('PROBE_UNAVAILABLE'));

    // Identità non verificata.
    await assert.rejects(
      assertCutoverReady(sql, { now, verifyRunId, deps: okDeps({ assertWritable: async () => { throw new MigrationError('PRECONDITION_FAILED', 'Identità del volume non verificata (mismatch)', { reasons: ['IDENTITY_NOT_OK'] }); } }) }),
      expectPrecondition('IDENTITY_NOT_OK'),
    );

    // Verifica vista nel wizard non più l'ultima; verifica precedente a un apply che ha scritto; verifica rossa.
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId: randomUUID(), deps: okDeps() }), expectPrecondition('VERIFY_REQUIRED'));
    const lateApply = await insertRun('apply', { summary: { zero_writes: false }, finishedAt: new Date(now.getTime() - 5 * 60_000) });
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId, deps: okDeps() }), expectPrecondition('VERIFY_REQUIRED'));
    await sql`DELETE FROM cal_migration_runs WHERE id = ${lateApply}::uuid`;
    const cal = await fx.calendar({ key: 'rosso' });
    await sql`UPDATE cal_migration_runs SET summary = ${sql.json({ acceptable: false, overall: 'red', calendars: [{ calendar_id: cal.id, collection_name: cal.slug, slug: cal.slug }] } as never)} WHERE id = ${verifyRunId}::uuid`;
    await sql`
      INSERT INTO cal_migration_items (run_id, seq, item_type, calendar_id, collection_name, code, level, severity, expected, detail)
      VALUES (${verifyRunId}::uuid, 0, 'diff', ${cal.id}::uuid, ${cal.slug}, 'TARGET_UNTRACKED', 'V1', 'error', false, '{"signature":"x"}'::jsonb)
    `;
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId, deps: okDeps() }), expectPrecondition('VERIFY_RED'));
    await sql`DELETE FROM cal_migration_items WHERE run_id = ${verifyRunId}::uuid`;

    // Parità: shadow spento.
    await sql`UPDATE calendar_backend_state SET shadow_enabled = false, shadow_since = NULL WHERE id`;
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId, deps: okDeps() }), expectPrecondition('SHADOW_PARITY_REQUIRED'));
    await sql`UPDATE calendar_backend_state SET shadow_enabled = true, shadow_since = ${new Date(now.getTime() - 9 * DAY)} WHERE id`;

    // Ledger: intento pendente e riga da rivalidare.
    await sql`
      INSERT INTO cal_migration_ledger (calendar_id, collection_name, href, kind, legacy_key, intent_op, intent_at)
      VALUES (${cal.id}::uuid, ${cal.slug}, 'x.ics', 'event', ${`event:${randomUUID()}`}, 'delete', now())
    `;
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId, deps: okDeps() }), expectPrecondition('OPEN_CONFLICTS'));
    await sql`UPDATE cal_migration_ledger SET intent_op = NULL, intent_at = NULL, revalidate_reason = 'backup-import', revalidate_since = now()`;
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId, deps: okDeps() }), expectPrecondition('REVALIDATION_PENDING'));
    await sql`DELETE FROM cal_migration_ledger`;

    // Un'altra transizione attiva.
    const { handle } = await beginTransition({ ctx: { db: sql, runId: null, actor: 'admin:test', log }, kind: 'cutover' });
    await assert.rejects(assertCutoverReady(sql, { now, verifyRunId, deps: okDeps() }), expectPrecondition('TRANSITION_ACTIVE'));
    // La stessa che si riprende non conta.
    await assertCutoverReady(sql, { now, verifyRunId, transitionId: handle.record.id, deps: okDeps() });
  });

  test('nuovo cutover dopo un rollback: basta una verifica accettabile successiva al rollback', async () => {
    const now = new Date();
    const { verifyRunId } = await readyState(now);
    await sql`UPDATE calendar_backend_state SET shadow_enabled = false, shadow_since = NULL WHERE id`;
    await sql`
      INSERT INTO cal_migration_transitions (kind, status, from_mode, target_mode, epoch_before, epoch_after, started_by, started_at, finished_at)
      VALUES ('rollback', 'completed', 'radicale', 'postgres', 1, 2, 'admin:test', ${new Date(now.getTime() - 60 * 60_000)}, ${new Date(now.getTime() - 40 * 60_000)})
    `;
    let c = byId(await cutoverCriteria(sql, { now, verifyRunId, deps: okDeps() }));
    assert.equal(c.shadow_parity.ok, true, c.shadow_parity.detail ?? '');
    // Verifica precedente al rollback: non basta.
    await sql`UPDATE cal_migration_runs SET finished_at = ${new Date(now.getTime() - 50 * 60_000)} WHERE id = ${verifyRunId}::uuid`;
    await sql`UPDATE cal_migration_runs SET finished_at = ${new Date(now.getTime() - 55 * 60_000)} WHERE kind = 'apply'`;
    c = byId(await cutoverCriteria(sql, { now, verifyRunId, deps: okDeps() }));
    assert.equal(c.shadow_parity.ok, false);
  });

  test('OPS-1: in produzione un\'immagine dell\'API senza versione blocca il cutover (API_IMAGE_UNVERSIONED); con sha-<short> o fuori produzione no', async () => {
    const now = new Date();
    const { verifyRunId } = await readyState(now);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(
        assertCutoverReady(sql, { now, verifyRunId, deps: okDeps({ apiVersion: () => 'unversioned' }) }),
        expectPrecondition('API_IMAGE_UNVERSIONED'),
      );
      const blocked = byId(await cutoverCriteria(sql, { now, verifyRunId, deps: okDeps({ apiVersion: () => 'unversioned' }) }));
      assert.equal(blocked.api_image_pinned.ok, false);
      const pinned = byId(await cutoverCriteria(sql, { now, verifyRunId, deps: okDeps({ apiVersion: () => 'sha-abc1234' }) }));
      assert.equal(pinned.api_image_pinned.ok, true);
      await assertCutoverReady(sql, { now, verifyRunId, deps: okDeps({ apiVersion: () => 'sha-abc1234' }) });
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
    // Fuori produzione (sviluppo, test) l'assenza di versione non blocca.
    const dev = byId(await cutoverCriteria(sql, { now, verifyRunId, deps: okDeps({ apiVersion: () => 'unversioned' }) }));
    assert.equal(dev.api_image_pinned.ok, true);
  });

  test('archivio della Fase 0: in sola lettura per i device nella policy derivata per il live', async () => {
    const now = new Date();
    const { verifyRunId } = await readyState(now);
    const archive = await fx.calendar({ key: 'archivio' });
    await sql`UPDATE calendars SET origin = 'migration', collection_name = ${archive.slug}, role = 'user', device_visible = true WHERE id = ${archive.id}::uuid`;
    const c = byId(await cutoverCriteria(sql, { now, verifyRunId, deps: okDeps() }));
    assert.equal(c.archive_readonly.ok, true, c.archive_readonly.detail ?? '');
    assert.match(c.archive_readonly.detail ?? '', /sola lettura/);
  });
});

describe('cutover: run senza Radicale (preflight, annullamento)', () => {
  test('preflight non soddisfatto: run fallito con i motivi, transizione aperta, nessuno stato toccato', async () => {
    await initializedState();
    const before = await sql`SELECT mode, write_freeze, epoch, policy_version FROM calendar_backend_state WHERE id`;
    await assert.rejects(
      runCutoverWith(runContext({ action: 'start', rollback_window_days: 30 }), { criteria: okDeps(), controlPlaneSync: async () => null }),
      expectPrecondition('DEVICE_MATRIX_REQUIRED', 'BACKUP_TOO_OLD', 'VERIFY_REQUIRED'),
    );
    const after = await sql`SELECT mode, write_freeze, epoch, policy_version FROM calendar_backend_state WHERE id`;
    assert.deepEqual({ ...after[0] }, { ...before[0] });
    const active = await getActiveTransition(sql);
    assert.ok(active, 'transizione aperta e annullabile');
    assert.equal(active.kind, 'cutover');
    const journal = await readJournal(sql, active.id);
    assert.deepEqual(journal.map((j) => [j.step, j.status]), [['preflight', 'failed']]);
    assert.equal(journal[0].error_code, 'PRECONDITION_FAILED');

    // Annullamento dall'admin: nessuno stato da ripristinare, transizione annullata.
    const summary = await runCutoverWith(runContext({ action: 'abort' }), { criteria: okDeps() });
    assert.equal(summary.outcome, 'aborted');
    assert.equal(summary.abort_reason, 'annullato dall\'admin');
    assert.equal(await getActiveTransition(sql), null);
    const [t] = await sql`SELECT status, outcome_code FROM cal_migration_transitions WHERE id = ${active.id}::uuid`;
    assert.deepEqual({ ...t }, { status: 'aborted', outcome_code: 'CUTOVER_ABORTED' });
  });

  test('annullamento dopo il freeze: mode postgres con il write_freeze di prima', async () => {
    await initializedState();
    const ctx: TransitionContext = { db: sql, runId: randomUUID(), actor: 'admin:test-cutover', log };
    const { handle } = await beginTransition({ ctx, kind: 'cutover' });
    await freezeStep(handle);
    const [frozen] = await sql`SELECT mode, write_freeze FROM calendar_backend_state WHERE id`;
    assert.deepEqual({ ...frozen }, { mode: 'cutover', write_freeze: true });
    const summary = await runCutoverWith(runContext({ action: 'abort' }), { criteria: okDeps() });
    assert.equal(summary.outcome, 'aborted');
    const [state] = await sql`SELECT mode, write_freeze, epoch FROM calendar_backend_state WHERE id`;
    assert.deepEqual({ ...state }, { mode: 'postgres', write_freeze: false, epoch: 1 });
    assert.deepEqual(summary.steps.map((s) => s.step), ['freeze', 'abort']);
  });

  test('stesso run ripreso dall\'esecutore dopo la conclusione: esito registrato, nessuna riesecuzione', async () => {
    await initializedState();
    const ctx: TransitionContext = { db: sql, runId: randomUUID(), actor: 'admin:test-cutover', log };
    const { handle } = await beginTransition({ ctx, kind: 'cutover' });
    await freezeStep(handle);
    const runId = randomUUID();
    const first = await runCutoverWith(runContext({ action: 'abort' }, runId), { criteria: okDeps() });
    assert.equal(first.outcome, 'aborted');
    // Lease scaduto dopo l'annullamento: lo stesso run non trova più una transizione attiva ma restituisce l'esito.
    const again = await runCutoverWith(runContext({ action: 'abort' }, runId), { criteria: okDeps() });
    assert.equal(again.outcome, 'aborted');
    assert.equal(again.transition_id, first.transition_id);
    // Un altro run, invece, non ha nulla da annullare.
    await assert.rejects(runCutoverWith(runContext({ action: 'abort' }), {}), expectPrecondition('NO_ACTIVE_TRANSITION'));
  });

  test('annullamento o ripresa senza una transizione attiva: NO_ACTIVE_TRANSITION', async () => {
    await initializedState();
    await assert.rejects(runCutoverWith(runContext({ action: 'abort' }), {}), expectPrecondition('NO_ACTIVE_TRANSITION'));
    await assert.rejects(runCutoverWith(runContext({ action: 'resume' }), {}), expectPrecondition('NO_ACTIVE_TRANSITION'));
  });

  test('cutover da un mode diverso da postgres: MODE_NOT_POSTGRES senza transizione', async () => {
    await sql`UPDATE calendar_backend_state SET mode = 'radicale', write_freeze = false, volume_id = ${VOLUME}::uuid, epoch = 2 WHERE id`;
    invalidateBackendModeCache();
    await assert.rejects(runCutoverWith(runContext({ action: 'start' }), {}), expectPrecondition('MODE_NOT_POSTGRES'));
    assert.equal(await getActiveTransition(sql), null);
  });
});

describe('cutover: dopo il punto di non ritorno i passi persistenti non bloccano (F4R-TR-2)', () => {
  /** Client finto del marker: PROPPATCH aggiorna volume-id ed epoch in memoria. */
  function fakeMarkerClient(initial: { volume_id: string; epoch: number }): RadicaleClient {
    const state = { ...initial };
    return {
      async readProps(): Promise<Record<string, string>> {
        return { [DEAD_PROP.volumeId]: state.volume_id, [DEAD_PROP.epoch]: String(state.epoch) };
      },
      async proppatchRaw(_path: string, body: string): Promise<void> {
        state.volume_id = String(/<K:volume-id>([^<]+)<\/K:volume-id>/.exec(body)?.[1]);
        state.epoch = Number(/<K:epoch>(\d+)<\/K:epoch>/.exec(body)?.[1]);
      },
    } as unknown as RadicaleClient;
  }

  test('index_sync con una collezione che non sincronizza e reverse_start che lancia: transizione conclusa, freeze tolto, degradi nel journal', async () => {
    await initializedState();
    const tctx: TransitionContext = { db: sql, runId: randomUUID(), actor: 'admin:test-cutover', log };
    const { handle } = await beginTransition({ ctx: tctx, kind: 'cutover' });
    await freezeStep(handle);
    for (const step of ['preflight', 'quiesce', 'delta_apply', 'delta_verify']) {
      await runStep(handle, step, async () => (step === 'delta_verify' ? { acceptable: true, overall: 'green', calendars: [] } : {}));
    }
    const client = fakeMarkerClient({ volume_id: VOLUME, epoch: 1 });
    await epochStep(handle, { client, principal: 'federico' }, { set: { rollback_until: new Date(Date.now() + 30 * DAY), cutover_at: new Date(), cutover_by: 'admin:test-cutover', api_min_version: CALENDAR_API_LEVEL } });
    assert.equal((await sql`SELECT mode FROM calendar_backend_state WHERE id`)[0].mode, 'radicale');

    const calendarId = randomUUID();
    const smokeOk = { ok: true, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), checks: [] };
    const summary = await runCutoverWith(runContext({ action: 'resume' }), {
      radicale: () => ({ client, principal: 'federico' }),
      controlPlaneSync: async () => ({
        ok: true, failedStage: null, state: { mode: 'radicale', epoch: 2 }, policy: { mode: 'frozen', version: 3, reasons: [] }, heartbeat: { ts: new Date().toISOString() },
      }) as never,
      verifyIdentity: async () => ({ status: 'ok', checkedAt: new Date().toISOString(), marker: { epoch: 2 }, detail: null }) as never,
      syncAll: async () => [new CollectionSyncError(calendarId, 'collection_missing', 'collezione assente su Radicale')],
      reverse: async () => { throw new Error('proiezione inversa: errore persistente'); },
      smoke: async () => smokeOk as never,
      sleep: async () => undefined,
    });

    assert.equal(summary.outcome, 'completed');
    assert.equal(summary.reverse, null, 'la prima passata saltata non compare come riassunto');
    const [st] = await sql`SELECT mode, write_freeze FROM calendar_backend_state WHERE id`;
    assert.deepEqual({ mode: st.mode, write_freeze: st.write_freeze }, { mode: 'radicale', write_freeze: false });
    assert.equal((await sql`SELECT status FROM cal_migration_transitions WHERE id = ${handle.record.id}::uuid`)[0].status, 'completed');
    const journal = await readJournal(sql, handle.record.id);
    const indexSync = journal.find((j) => j.step === 'index_sync');
    assert.equal(indexSync?.status, 'done');
    assert.deepEqual(indexSync?.data.failed, [{ calendar_id: calendarId, code: 'collection_missing' }]);
    assert.equal(indexSync?.data.degraded, true);
    const reverse = journal.find((j) => j.step === 'reverse_start');
    assert.equal(reverse?.status, 'done');
    assert.equal(reverse?.data.skipped, true);
    assert.equal(reverse?.data.error_code, 'REVERSE_START_FAILED');
  });
});

describe('cutover: prenotazioni a cavallo del freeze', () => {
  test('project_booking accodato per le prenotazioni create o cambiate dopo l\'istante', async () => {
    const eventType = await fx.eventType({ key: 'rec' });
    await fx.booking({ eventType, start: new Date(Date.now() + 5 * DAY).toISOString(), status: 'confirmed', project: false });
    await new Promise((r) => setTimeout(r, 20));
    const since = new Date();
    const fresh = await fx.booking({ eventType, start: new Date(Date.now() + 6 * DAY).toISOString(), status: 'confirmed', project: false });
    await sql`DELETE FROM cal_jobs WHERE kind = 'project_booking'`;
    const n = await reconcileBookingsAfterCutover(sql, since);
    assert.equal(n, 1);
    const jobs = await sql<Array<{ key: string }>>`SELECT key FROM cal_jobs WHERE kind = 'project_booking' ORDER BY key`;
    assert.deepEqual(jobs.map((j) => j.key), [fresh.booking.uid]);
    // Idempotente: una seconda volta non duplica il job pendente.
    await reconcileBookingsAfterCutover(sql, since);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM cal_jobs WHERE kind = 'project_booking' AND status = 'pending'`;
    assert.equal(count, 1);
    await sql`DELETE FROM cal_jobs WHERE kind = 'project_booking'`;
  });
});

describe('cutover: smoke senza effetti collaterali', () => {
  test('in mode postgres tutti i controlli passano e nulla resta (prenotazioni, job, workflow, audit)', async () => {
    const pub = await fx.eventType({ key: 'smoke-pub', isPublic: true });
    await fx.eventType({ key: 'smoke-priv', isPublic: false });
    const cal = await fx.calendar({ key: 'smoke' });
    await sql`UPDATE calendars SET ics_feed_enabled = true WHERE id = ${cal.id}::uuid`;
    const e = await createEvent({ calendar_id: cal.id, summary: fx.name('Evento smoke'), start_time: new Date(Date.now() + DAY).toISOString(), end_time: new Date(Date.now() + DAY + HOUR).toISOString(), all_day: false, source: 'admin', status: 'confirmed' });
    fx.track('eventIds', e.id);
    const counts = async () => (await sql`
      SELECT (SELECT count(*)::int FROM calendar_bookings) AS bookings, (SELECT count(*)::int FROM cal_jobs) AS jobs,
             (SELECT count(*)::int FROM workflow_executions) AS workflows, (SELECT count(*)::int FROM audit_logs) AS audits
    `)[0];
    const before = { ...(await counts()) };
    const report = await runCutoverSmoke({ db: sql });
    assert.deepEqual(report.checks.map((c) => c.code), [...SMOKE_CHECK_CODES]);
    for (const c of report.checks) assert.equal(c.ok, true, `${c.code}: ${c.detail}`);
    assert.equal(report.ok, true);
    const booking = report.checks.find((c) => c.code === 'BOOKING_ROLLBACK');
    assert.match(booking?.detail ?? '', /non pubblico/);
    assert.match(booking?.detail ?? '', /transazione annullata/);
    const after = { ...(await counts()) };
    assert.deepEqual(after, before, 'nessuna riga nuova nelle tabelle osservate');
    const [left] = await sql`SELECT count(*)::int AS n FROM calendar_bookings WHERE attendee_email = ${SMOKE_ATTENDEE_EMAIL}`;
    assert.equal(left.n, 0);
    // Nessun dato personale né token nel rapporto.
    assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SMOKE_ATTENDEE_EMAIL}|ics_feed_token`));
    void pub;
  });
});

describe('livello dell\'API (design §16.6)', () => {
  test('api_min_version 0: livello sufficiente, nessun blocco', async () => {
    const check = await checkCalendarApiLevel(sql);
    assert.deepEqual(check, { ok: true, required: 0, current: CALENDAR_API_LEVEL });
    assert.equal(await enforceCalendarApiLevelAtBoot(sql), true);
    assert.equal(calendarApiLevelBlocked(), false);
    await listCalendars();
  });

  test('api_min_version oltre il livello dell\'immagine: calendario non servito (503 store_not_available)', async () => {
    await sql`UPDATE calendar_backend_state SET api_min_version = ${CALENDAR_API_LEVEL + 1} WHERE id`;
    assert.equal(await enforceCalendarApiLevelAtBoot(sql), false);
    assert.equal(calendarApiLevelBlocked(), true);
    await assert.rejects(listCalendars(), (err: unknown) => err instanceof CalendarStoreUnavailableError && err.reason === 'store_not_available');
    await assert.rejects(
      createEvent({ calendar_id: randomUUID(), summary: 'x', start_time: new Date().toISOString(), end_time: new Date(Date.now() + HOUR).toISOString(), all_day: false, source: 'admin', status: 'confirmed' }),
      (err: unknown) => err instanceof CalendarStoreUnavailableError,
    );
    // Livello di nuovo sufficiente al prossimo avvio.
    await sql`UPDATE calendar_backend_state SET api_min_version = ${CALENDAR_API_LEVEL} WHERE id`;
    assert.equal(await enforceCalendarApiLevelAtBoot(sql), true);
    assert.equal(calendarApiLevelBlocked(), false);
  });
});

describe('livello dell\'API: ingressi che non passano dalla facade (F4R-TR-5)', () => {
  test('con api_min_version oltre il livello: slot, busy, capacità e decisione di prenotazione rifiutano con store_not_available', async () => {
    const et = await fx.eventType({ key: 'livello' });
    await sql`UPDATE calendar_backend_state SET api_min_version = 99 WHERE id`;
    assert.equal(await enforceCalendarApiLevelAtBoot(sql), false);
    assert.equal(calendarApiLevelBlocked(), true);
    const refused = (err: unknown): boolean => err instanceof CalendarStoreUnavailableError && err.reason === 'store_not_available';
    const start = new Date(Date.now() + 5 * DAY);
    const day = start.toISOString().slice(0, 10);
    await assert.rejects(computeAvailableSlots({ eventTypeIdOrSlug: et.id, fromDateLocal: day, toDateLocal: day }), refused);
    await assert.rejects(getBusyRanges(start.toISOString(), new Date(start.getTime() + HOUR).toISOString()), refused);
    await assert.rejects(getCapacityWeeks(start.toISOString(), new Date(start.getTime() + HOUR).toISOString()), refused);
    // beginDecision è la prima cosa della sezione critica di createBooking.
    await assert.rejects(
      createBooking({ event_type_id: et.id, start: start.toISOString(), attendee: { name: 'Livello', email: fx.email('livello'), timezone: 'Europe/Rome' }, source: 'admin_manual', skip_emails: true }),
      refused,
    );
    const [none] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_bookings WHERE event_type_id = ${et.id}`;
    assert.equal(none.n, 0, 'nessuna prenotazione creata');
    // Livello di nuovo sufficiente: gli ingressi tornano a funzionare.
    await sql`UPDATE calendar_backend_state SET api_min_version = 0 WHERE id`;
    assert.equal(await enforceCalendarApiLevelAtBoot(sql), true);
    await getBusyRanges(start.toISOString(), new Date(start.getTime() + HOUR).toISOString());
  });
});

describe('archivio della Fase 0 in sola lettura (contratto §3.5)', () => {
  test('origin migration in readonly anche in live; le altre collezioni seguono il mode', () => {
    const state = { ...DEFAULT_BACKEND_STATE, mode: 'radicale' as const, volume_id: VOLUME, epoch: 2 };
    const policy = policyFromState({
      state,
      identity: 'ok',
      collections: [
        { collection_name: 'archivio-fase0', role: 'user', lifecycle: 'active', device_visible: true, origin: 'migration' },
        { collection_name: 'c', role: 'user', lifecycle: 'active', device_visible: true, origin: 'admin' },
        { collection_name: 'lavoro', role: 'user', lifecycle: 'active', device_visible: true },
        { collection_name: 'f', role: 'holidays', lifecycle: 'active', device_visible: true, origin: 'admin' },
      ],
      principal: 'federico',
      now: new Date(),
    });
    assert.equal(policy.mode, 'live');
    assert.deepEqual(policy.readonly, ['archivio-fase0', 'f']);
    assert.deepEqual(policy.hidden, ['_canary']);
    // Archivio nascosto: resta solo in hidden.
    const hidden = policyFromState({
      state, identity: 'ok', principal: 'federico', now: new Date(),
      collections: [{ collection_name: 'archivio-fase0', role: 'user', lifecycle: 'active', device_visible: false, origin: 'migration' }],
    });
    assert.deepEqual(hidden.readonly, []);
    assert.deepEqual(hidden.hidden, ['_canary', 'archivio-fase0']);
  });

  test('readSidecarCollections legge origin dal sidecar', async () => {
    const cal = await fx.calendar({ key: 'arch' });
    await sql`UPDATE calendars SET origin = 'migration', collection_name = ${cal.slug} WHERE id = ${cal.id}::uuid`;
    const rows = await readSidecarCollections(sql);
    const row = rows.find((r) => r.collection_name === cal.slug);
    assert.equal(row?.origin, 'migration');
    for (const r of rows) assert.ok(['admin', 'device', 'system', 'migration'].includes(r.origin as string));
  });
});
