/**
 * Transizioni di stato della F4 senza Radicale (apps/api/src/lib/calendar/
 * migration/transition.ts; design §13.9-§13.13; contratto
 * docs/calendar-radicale/contracts/f4-modules.md §2). La prova con Radicale
 * reale, i plugin e la PUT dei device è in test/integration/
 * migration-transition.test.ts.
 *
 * Cosa si verifica:
 *  - apertura e ripresa: mode di partenza, volume inizializzato, una sola
 *    transizione attiva, ripresa della stessa con il run nuovo;
 *  - journal: passo idempotente (eseguito una volta), fallimento registrato e
 *    ripetuto alla ripresa, passi saltati, chiusura solo a passi conclusi;
 *  - prima lo stato: freeze con mode e write_freeze nella stessa transazione
 *    del journal; un riavvio dell'API fra due passi non riporta la policy a
 *    live (control-plane nuovo, stessa policy frozen, heartbeat del mode di
 *    transizione, ripresa dal passo successivo);
 *  - passo d'epoch: PROPPATCH del marker poi transazione; ripresa dopo un
 *    crash fra le due (marker già E+1); marker diverso → nessuna modifica;
 *  - annullamento prima del passo d'epoch (cutover → postgres, rollback →
 *    radicale con il freeze di prima), mai dopo;
 *  - gate esclusivo: attende le scritture in corso; le scritture e i job che
 *    arrivano durante la transizione attendono il gate e poi ricevono
 *    l'indisponibilità per transizione (il job torna in coda senza consumare
 *    tentativi); MCP risponde con il ramo {error} senza scrivere;
 *  - quiescenza con dipendenze finte: policy frozen, attesa, probe fino al
 *    403, stat stabile (mount e remota), timeout e precondizioni.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { executeTool } from '../../src/lib/agent/tools';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import {
  enqueueCalendarJob,
  registerCalendarJobHandler,
  runCalendarJobsOnce,
  stopCalendarJobWorker,
  unregisterCalendarJobHandler,
} from '../../src/lib/calendar/jobs';
import { logger } from '../../src/lib/logger';
import {
  abortTransition,
  awaitDeviceQuiescence,
  beginTransition,
  buildTransitionView,
  completeTransition,
  epochStep,
  freezeStep,
  getActiveTransition,
  nextPendingStep,
  type QuiescenceDeps,
  quiesceStep,
  readJournal,
  readTransitionView,
  runStep,
  setTransitionTestHooks,
  skipStep,
  stateStep,
  type TransitionContext,
  TransitionError,
  withTransitionGate,
} from '../../src/lib/calendar/migration/transition';
import { CUTOVER_STEPS, F4_LIMITS, MigrationError, ROLLBACK_STEPS, type QuiescenceReport } from '../../src/lib/calendar/migration/types';
import type { RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { RadicaleForbiddenError, RadicaleNetworkError } from '../../src/lib/calendar/radicale/errors';
import { CalendarControlPlane, effectiveModeFromFiles, readHeartbeatFile, type ControlPlaneTick } from '../../src/lib/calendar/radicale/heartbeat';
import { fileIdentitySource, writeVolumeMarker } from '../../src/lib/calendar/radicale/identity';
import { readPolicyFile } from '../../src/lib/calendar/radicale/policy';
import { DEAD_PROP, principalPropsPath } from '../../src/lib/calendar/radicale/types';
import { withCalendarWriteGate, writeGateStatus } from '../../src/lib/calendar/radicale/write-gate';

const fx = useFixtures('transition', { resetBaseline: true });
onBeforeDatabaseClose(async () => {
  setTransitionTestHooks(null);
  await stopCalendarJobWorker();
  await sql`DELETE FROM cal_jobs WHERE kind LIKE 'tst\\_transition%'`;
  await resetCalendarBaseline();
});

const P = 'federico';
const VOLUME = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const ROOT = mkdtempSync(join(tmpdir(), 'caldes-transition-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

afterEach(async () => {
  setTransitionTestHooks(null);
  // Ogni test riparte da postgres senza transizioni.
  await sql`DELETE FROM cal_migration_transitions`;
  await sql`UPDATE calendar_backend_state SET mode = 'postgres', write_freeze = false, volume_id = NULL, epoch = 0, rollback_until = NULL, cutover_at = NULL, cutover_by = NULL WHERE id`;
  invalidateBackendModeCache();
});

const log = logger.child({ scope: 'test-transition' });

function context(runId: string | null = randomUUID()): TransitionContext {
  return { db: sql, runId, actor: 'admin:test-transition', log };
}

async function setBackend(mode: 'postgres' | 'radicale', opts: { epoch?: number; writeFreeze?: boolean } = {}): Promise<void> {
  const epoch = opts.epoch ?? 1;
  await sql`
    UPDATE calendar_backend_state
    SET mode = ${mode}, write_freeze = ${opts.writeFreeze ?? false}, volume_id = ${VOLUME}::uuid, epoch = ${epoch}
    WHERE id
  `;
  invalidateBackendModeCache();
}

async function backend(): Promise<{ mode: string; write_freeze: boolean; epoch: number; policy_version: number; rollback_until: Date | null }> {
  const [row] = await sql`SELECT mode, write_freeze, epoch, policy_version, rollback_until FROM calendar_backend_state WHERE id`;
  return { ...row } as never;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function settledWithin<T>(p: Promise<T>, ms: number): Promise<'settled' | 'pending'> {
  return Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), sleep(ms).then(() => 'pending' as const)]);
}

function expectTransitionError(runErrorCode: string, reason?: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof MigrationError, `MigrationError atteso, ricevuto ${String(err)}`);
    assert.equal(err.details?.run_error_code, runErrorCode, err.message);
    if (reason) assert.ok((err.details?.reasons as string[] | undefined)?.includes(reason), `motivo ${reason} in ${JSON.stringify(err.details)}`);
    return true;
  };
}

/** Client finto per il passo d'epoch: marker in memoria, PROPPATCH che lo aggiorna. */
function fakeMarkerClient(initial: { volume_id: string; epoch: number } | null) {
  const state = { marker: initial, proppatches: 0, failNext: 0 };
  const client = {
    async readProps(): Promise<Record<string, string> | null> {
      if (!state.marker) return {};
      return { [DEAD_PROP.volumeId]: state.marker.volume_id, [DEAD_PROP.epoch]: String(state.marker.epoch) };
    },
    async proppatchRaw(_path: string, body: string): Promise<void> {
      if (state.failNext > 0) {
        state.failNext -= 1;
        throw new RadicaleNetworkError({ method: 'PROPPATCH', path: '/federico/', outcomeUnknown: true, detail: 'connessione chiusa' } as never);
      }
      state.proppatches += 1;
      const volume = /<K:volume-id>([^<]+)<\/K:volume-id>/.exec(body)?.[1];
      const epoch = Number(/<K:epoch>(\d+)<\/K:epoch>/.exec(body)?.[1]);
      state.marker = { volume_id: String(volume), epoch };
    },
  };
  return { client: client as unknown as RadicaleClient, state };
}

// ─── Apertura, ripresa e journal ───────────────────────────────

describe('transizioni: apertura, ripresa e journal', () => {
  test('mode di partenza e volume inizializzato; una sola transizione attiva; ripresa con il run nuovo', async () => {
    await assert.rejects(beginTransition({ ctx: context(), kind: 'rollback' }), expectTransitionError('PRECONDITION_FAILED', 'MODE_NOT_RADICALE'));
    await assert.rejects(beginTransition({ ctx: context(), kind: 'cutover' }), expectTransitionError('PRECONDITION_FAILED', 'IDENTITY_NOT_OK'));
    await setBackend('postgres');
    await assert.rejects(beginTransition({ ctx: context(), kind: 'cutover', resume: true }), expectTransitionError('PRECONDITION_FAILED', 'NO_ACTIVE_TRANSITION'));

    const run1 = randomUUID();
    const { handle, resumed } = await beginTransition({ ctx: context(run1), kind: 'cutover', data: { window_days: 30 } });
    assert.equal(resumed, false);
    assert.deepEqual(
      { kind: handle.record.kind, from: handle.record.from_mode, to: handle.record.target_mode, epoch: handle.record.epoch_before, run: handle.record.run_id, data: handle.record.data },
      { kind: 'cutover', from: 'postgres', to: 'radicale', epoch: 1, run: run1, data: { window_days: 30 } },
    );
    await assert.rejects(beginTransition({ ctx: context(), kind: 'finalize' }), (err: unknown) => {
      assert.ok(err instanceof TransitionError);
      assert.equal(err.code, 'TRANSITION_IN_PROGRESS');
      assert.equal((err.details?.transition as { id: string }).id, handle.record.id);
      return true;
    });
    const run2 = randomUUID();
    const again = await beginTransition({ ctx: context(run2), kind: 'cutover', resume: true });
    assert.equal(again.resumed, true);
    assert.equal(again.handle.record.id, handle.record.id);
    assert.equal(again.handle.record.run_id, run2);
    assert.equal((await getActiveTransition(sql))?.run_id, run2);
  });

  test('passo idempotente: eseguito una volta, fallimento registrato e ripetuto alla ripresa', async () => {
    await setBackend('postgres');
    const { handle } = await beginTransition({ ctx: context(), kind: 'cutover' });
    let calls = 0;
    const first = await runStep(handle, 'preflight', async ({ attempt }) => { calls += 1; return { ok: true, attempt }; });
    const second = await runStep(handle, 'preflight', async () => { calls += 1; return { ok: false }; });
    assert.equal(calls, 1);
    assert.deepEqual(first, { ok: true, attempt: 1 });
    assert.deepEqual(second, first, 'un passo concluso restituisce i dati registrati');

    await assert.rejects(runStep(handle, 'delta_apply', async () => {
      throw new TransitionError('CALENDAR_UNAVAILABLE', 'Radicale non risponde', { runErrorCode: 'RADICALE_UNREACHABLE' });
    }), /Radicale non risponde/);
    let journal = await readJournal(sql, handle.record.id);
    const failed = journal.find((j) => j.step === 'delta_apply');
    assert.deepEqual({ status: failed?.status, code: failed?.error_code, attempts: failed?.attempts }, { status: 'failed', code: 'RADICALE_UNREACHABLE', attempts: 1 });
    assert.match(String(failed?.error), /Radicale non risponde/);
    // Un errore grezzo non finisce nel journal (niente messaggi del database o dati personali).
    await assert.rejects(runStep(handle, 'delta_verify', async () => { throw new Error('dettaglio interno con mario@example.com'); }));
    journal = await readJournal(sql, handle.record.id);
    assert.equal(journal.find((j) => j.step === 'delta_verify')?.error, 'Errore interno del passo: dettagli nei log del server');

    const retried = await runStep(handle, 'delta_apply', async ({ attempt }) => ({ attempt }));
    assert.deepEqual(retried, { attempt: 2 });
    journal = await readJournal(sql, handle.record.id);
    assert.deepEqual(journal.map((j) => [j.step, j.status, j.seq]), [['preflight', 'done', 0], ['delta_apply', 'done', 1], ['delta_verify', 'failed', 2]]);
    assert.equal(nextPendingStep('cutover', journal), 'freeze');
  });

  test('chiusura solo con tutti i passi conclusi o saltati; vista per il wizard', async () => {
    await setBackend('radicale');
    const { handle } = await beginTransition({ ctx: context(), kind: 'rollback' });
    await runStep(handle, 'preflight', async () => ({}));
    await assert.rejects(completeTransition(handle), /manca il passo freeze/);
    for (const step of ROLLBACK_STEPS.slice(1)) await skipStep(handle, step, 'prova');
    const done = await completeTransition(handle, { outcome: 'prova' });
    assert.equal(done.status, 'completed');
    assert.ok(done.finished_at);
    const view = await readTransitionView(sql);
    assert.ok(view);
    assert.deepEqual(
      { id: view.id, status: view.status, next: view.next_step, resumable: view.resumable, abortable: view.abortable, steps: view.steps.length },
      { id: handle.record.id, status: 'completed', next: null, resumable: false, abortable: false, steps: ROLLBACK_STEPS.length },
    );
    assert.equal(view.steps[1].status, 'skipped');
    assert.deepEqual(view.steps[1].data, { reason: 'prova' });
  });
});

// ─── Prima lo stato ───────────────────────────────

describe('transizioni: prima lo stato, poi la policy', () => {
  test('freeze: mode e write_freeze nella stessa transazione del journal; idempotente; stato inatteso rifiutato', async () => {
    await setBackend('radicale');
    const before = await backend();
    const { handle } = await beginTransition({ ctx: context(), kind: 'rollback' });
    const data = await freezeStep(handle);
    const after1 = await backend();
    assert.deepEqual({ mode: after1.mode, write_freeze: after1.write_freeze }, { mode: 'rollback', write_freeze: true });
    assert.ok(after1.policy_version > before.policy_version, 'policy_version sale: il NOTIFY fa riscrivere la policy');
    assert.deepEqual(
      { mode_before: data.mode_before, write_freeze_before: data.write_freeze_before, mode_after: data.mode_after, pv: data.policy_version },
      { mode_before: 'radicale', write_freeze_before: false, mode_after: 'rollback', pv: after1.policy_version },
    );
    const again = await freezeStep(handle);
    assert.deepEqual(again, data);
    assert.equal((await backend()).policy_version, after1.policy_version, 'la ripresa non riscrive lo stato');

    // Stato cambiato da fuori fra l'apertura e il freeze: rifiutato senza toccare nulla.
    await sql`DELETE FROM cal_migration_transitions`;
    await setBackend('postgres');
    const other = await beginTransition({ ctx: context(), kind: 'rollback' }).catch((e) => e);
    assert.ok(other instanceof TransitionError);
    await setBackend('radicale');
    const { handle: h2 } = await beginTransition({ ctx: context(), kind: 'rollback' });
    await setBackend('postgres');
    await assert.rejects(freezeStep(h2), expectTransitionError('TRANSITION_CONFLICT', 'MODE_NOT_RADICALE'));
    assert.equal((await backend()).mode, 'postgres');
    const journal = await readJournal(sql, h2.record.id);
    assert.equal(journal.find((j) => j.step === 'freeze')?.status, 'failed');
  });

  test('riavvio dell\'API fra due passi: la policy resta frozen e la transizione riprende dal passo successivo', async () => {
    const dir = join(ROOT, 'restart');
    const dataDir = join(dir, 'collections');
    mkdirSync(dir, { recursive: true });
    const propsPath = principalPropsPath(dataDir, P);
    mkdirSync(dirname(propsPath), { recursive: true });
    writeFileSync(propsPath, JSON.stringify({ [DEAD_PROP.volumeId]: VOLUME, [DEAD_PROP.epoch]: '1' }));
    const files = { policyFile: join(dir, 'policy.json'), heartbeatFile: join(dir, 'heartbeat.json'), principal: P };
    const newControlPlane = (): CalendarControlPlane => new CalendarControlPlane({
      db: sql, ...files, apiVersion: 'sha-transition', identitySource: fileIdentitySource(dataDir), intervalMs: 3_600_000, listen: false,
    });
    const policyMode = async (): Promise<string | null> => {
      const read = await readPolicyFile(files.policyFile, P);
      return read.state === 'ok' ? read.value.mode : null;
    };

    await setBackend('radicale');
    const first = newControlPlane();
    let tick = await first.syncNow('manual');
    assert.ok(tick.ok, tick.error ?? '');
    assert.equal(await policyMode(), 'live', 'prima della transizione i device scrivono');

    const { handle } = await beginTransition({ ctx: context(), kind: 'rollback' });
    await runStep(handle, 'preflight', async () => ({ ok: true }));
    await freezeStep(handle);
    tick = await first.syncNow('notify');
    assert.equal(await policyMode(), 'frozen');

    // "Crash" dell'API: il processo si ferma fra il freeze e la quiescenza.
    await first.stop();
    // Nuovo processo: il control-plane deriva la policy dallo stato, mai live.
    const second = newControlPlane();
    try {
      tick = await second.syncNow('manual');
      assert.ok(tick.ok, tick.error ?? '');
      assert.deepEqual({ mode: tick.policy?.mode, backend: tick.state?.mode }, { mode: 'frozen', backend: 'rollback' });
      assert.equal(await policyMode(), 'frozen');
      const hb = await readHeartbeatFile(files.heartbeatFile);
      assert.ok(hb.state === 'ok' && hb.value.mode === 'rollback');
      const effective = await effectiveModeFromFiles(files);
      assert.equal(effective.mode, 'frozen');

      // Ripresa con un run nuovo: il freeze risulta concluso, si riparte dalla quiescenza.
      const { handle: resumed } = await beginTransition({ ctx: context(randomUUID()), kind: 'rollback', resume: true });
      assert.equal(nextPendingStep('rollback', await readJournal(sql, resumed.record.id)), 'quiesce');
      const pv = (await backend()).policy_version;
      await freezeStep(resumed);
      assert.equal((await backend()).policy_version, pv, 'il passo concluso non si riesegue');
      tick = await second.syncNow('manual');
      assert.equal(await policyMode(), 'frozen', 'nessuna ripresa riporta la policy a live');
    } finally {
      await second.stop();
    }
  });

  test('stateStep: write_freeze tolto solo nel mode atteso (fine del freeze del cutover)', async () => {
    await setBackend('postgres');
    const { handle } = await beginTransition({ ctx: context(), kind: 'cutover' });
    await freezeStep(handle);
    await assert.rejects(stateStep(handle, 'unfreeze', { expectMode: 'radicale', set: { write_freeze: false } }), expectTransitionError('TRANSITION_CONFLICT'));
    assert.equal((await backend()).write_freeze, true);
    // Il cutover arriva in radicale con il passo d'epoch; qui lo simula lo stato.
    await sql`UPDATE calendar_backend_state SET mode = 'radicale', epoch = 2 WHERE id`;
    const data = await stateStep(handle, 'unfreeze', { expectMode: 'radicale', set: { write_freeze: false } });
    assert.deepEqual({ mode: data.mode, write_freeze: data.write_freeze }, { mode: 'radicale', write_freeze: false });
    await assert.rejects(stateStep(handle, 'x', { expectMode: 'radicale', mode: 'postgres' }), /non ammesso/);
  });
});

// ─── Epoch e annullamento ───────────────────────────────

describe('transizioni: passo d\'epoch e annullamento', () => {
  test('rollback: PROPPATCH del marker poi transazione; ripresa dopo un crash fra le due; marker diverso rifiutato', async () => {
    await setBackend('radicale', { epoch: 3 });
    await sql`UPDATE calendar_backend_state SET rollback_until = now() + interval '20 days', cutover_at = now(), cutover_by = 'admin:x' WHERE id`;
    const { handle } = await beginTransition({ ctx: context(), kind: 'rollback' });
    await freezeStep(handle);

    // Marker con un volume-id diverso: nessuna modifica.
    const wrong = fakeMarkerClient({ volume_id: randomUUID(), epoch: 3 });
    await assert.rejects(epochStep(handle, { client: wrong.client, principal: P }), expectTransitionError('EPOCH_CONFLICT', 'IDENTITY_NOT_OK'));
    assert.equal(wrong.state.proppatches, 0);
    assert.deepEqual({ mode: (await backend()).mode, epoch: (await backend()).epoch }, { mode: 'rollback', epoch: 3 });

    // Crash fra la PROPPATCH e la transazione: il marker è già 4, lo stato ancora 3.
    const crashed = fakeMarkerClient({ volume_id: VOLUME, epoch: 4 });
    const data = await epochStep(handle, { client: crashed.client, principal: P }, { set: { rollback_until: null, cutover_at: null, cutover_by: null, write_freeze: false } });
    assert.equal(crashed.state.proppatches, 0, 'marker già avanzato: nessuna seconda PROPPATCH');
    assert.deepEqual({ before: data.epoch_before, after: data.epoch_after, mode: data.mode, marker: data.marker }, { before: 3, after: 4, mode: 'postgres', marker: 'already' });
    const state = await backend();
    assert.deepEqual({ mode: state.mode, epoch: state.epoch, write_freeze: state.write_freeze, until: state.rollback_until }, { mode: 'postgres', epoch: 4, write_freeze: false, until: null });
    assert.equal((await getActiveTransition(sql))?.epoch_after, 4);
    // Passo concluso: una ripresa non rifà nulla.
    const again = await epochStep(handle, { client: wrong.client, principal: P });
    assert.deepEqual(again, data);
  });

  test('cutover: marker E → PROPPATCH E+1 (con un errore transitorio ripetuto), poi mode radicale e i campi del cutover', async () => {
    await setBackend('postgres', { epoch: 1 });
    const { handle } = await beginTransition({ ctx: context(), kind: 'cutover' });
    await freezeStep(handle);
    const fake = fakeMarkerClient({ volume_id: VOLUME, epoch: 1 });
    fake.state.failNext = 1;
    const until = new Date(Date.now() + 30 * 86_400_000);
    const data = await epochStep(handle, { client: fake.client, principal: P, sleep: async () => undefined }, {
      set: { rollback_until: until, cutover_at: new Date(), cutover_by: 'admin:test', api_min_version: 4 },
    });
    assert.equal(fake.state.proppatches, 1);
    assert.deepEqual(fake.state.marker, { volume_id: VOLUME, epoch: 2 });
    assert.deepEqual({ mode: data.mode, write_freeze: data.write_freeze, marker: data.marker }, { mode: 'radicale', write_freeze: true, marker: 'written' });
    const [row] = await sql`SELECT mode, epoch, write_freeze, rollback_until, cutover_by, api_min_version FROM calendar_backend_state WHERE id`;
    assert.deepEqual({ ...row, rollback_until: (row.rollback_until as Date).toISOString() }, {
      mode: 'radicale', epoch: 2, write_freeze: true, rollback_until: until.toISOString(), cutover_by: 'admin:test', api_min_version: 4,
    });
    // Dopo il punto di non ritorno il cutover non si annulla.
    await assert.rejects(abortTransition(handle, { code: 'CUTOVER_ABORTED', reason: 'prova' }), expectTransitionError('TRANSITION_CONFLICT', 'TRANSITION_NOT_ABORTABLE'));
    const view = buildTransitionView(handle.record, await readJournal(sql, handle.record.id), { runActive: false });
    assert.equal(view.abortable, false);
    assert.equal(view.resumable, true);
    assert.equal(view.next_step, 'preflight', 'i passi non eseguiti restano da fare nell\'ordine del tipo');
  });

  test('annullamento prima dell\'epoch: cutover torna a postgres, rollback torna a radicale con il freeze di prima', async () => {
    await setBackend('postgres');
    const { handle } = await beginTransition({ ctx: context(), kind: 'cutover' });
    await freezeStep(handle);
    assert.equal((await backend()).mode, 'cutover');
    const result = await abortTransition(handle, { code: 'VERIFY_RED', reason: 'verifica del delta con differenze rosse' });
    assert.deepEqual({ mode: result.mode, write_freeze: result.write_freeze, restored: result.restored }, { mode: 'postgres', write_freeze: false, restored: true });
    assert.deepEqual({ mode: (await backend()).mode, freeze: (await backend()).write_freeze }, { mode: 'postgres', freeze: false });
    assert.equal(handle.record.status, 'aborted');
    assert.deepEqual({ code: handle.record.outcome_code, outcome: handle.record.outcome }, { code: 'VERIFY_RED', outcome: 'verifica del delta con differenze rosse' });
    assert.equal(await getActiveTransition(sql), null);
    assert.deepEqual(await abortTransition(handle, { code: 'X', reason: 'y' }), { already: true });

    // Rollback con il freeze dell'admin già attivo: l'annullamento lo rimette.
    await setBackend('radicale', { writeFreeze: true });
    const { handle: rb } = await beginTransition({ ctx: context(), kind: 'rollback' });
    await freezeStep(rb);
    await abortTransition(rb, { code: 'PREVIEW_CHANGED', reason: 'anteprima cambiata' });
    assert.deepEqual({ mode: (await backend()).mode, freeze: (await backend()).write_freeze }, { mode: 'radicale', freeze: true });

    // Annullamento senza freeze (crash prima del passo): nulla da ripristinare.
    await setBackend('radicale');
    const { handle: rb2 } = await beginTransition({ ctx: context(), kind: 'rollback' });
    const r2 = await abortTransition(rb2, { code: 'ROLLBACK_ABORTED', reason: 'richiesta dell\'admin' });
    assert.equal(r2.restored, false);
    assert.equal((await backend()).mode, 'radicale');
  });

  test('F4R-TR-1: epoch iniziato o fallito con il marker già a E+1 → annullamento rifiutato; marker ancora a E → ammesso', async () => {
    // Caso 1: la PROPPATCH ha portato il marker a E+1, poi il processo cade prima di commitEpoch (passo 'failed').
    await setBackend('postgres', { epoch: 1 });
    const { handle } = await beginTransition({ ctx: context(), kind: 'cutover' });
    await freezeStep(handle);
    const fake = fakeMarkerClient({ volume_id: VOLUME, epoch: 1 });
    await assert.rejects(runStep(handle, 'epoch', async () => {
      await writeVolumeMarker(fake.client, P, { volume_id: VOLUME, epoch: 2 });
      throw new Error('crash del database prima di commitEpoch');
    }));
    assert.deepEqual(fake.state.marker, { volume_id: VOLUME, epoch: 2 });
    assert.equal((await readJournal(sql, handle.record.id)).find((j) => j.step === 'epoch')?.status, 'failed');
    const view = buildTransitionView(handle.record, await readJournal(sql, handle.record.id), { runActive: false });
    assert.equal(view.abortable, false, 'con il passo d\'epoch tentato la vista non offre l\'annullamento');
    await assert.rejects(
      abortTransition(handle, { code: 'CUTOVER_ABORTED', reason: 'prova', marker: { client: fake.client, principal: P } }),
      (err: unknown) => {
        expectTransitionError('TRANSITION_CONFLICT', 'TRANSITION_NOT_ABORTABLE')(err);
        assert.match((err as Error).message, /già a epoch E\+1/);
        return true;
      },
    );
    assert.equal((await backend()).mode, 'cutover', 'il mode non è stato toccato');
    // Senza il client del marker l'annullamento non è verificabile: rifiutato.
    await assert.rejects(abortTransition(handle, { code: 'CUTOVER_ABORTED', reason: 'prova' }), expectTransitionError('TRANSITION_CONFLICT', 'TRANSITION_NOT_ABORTABLE'));
    // Marker illeggibile (principal senza dead prop) → non verificabile.
    const empty = fakeMarkerClient(null);
    await assert.rejects(
      abortTransition(handle, { code: 'CUTOVER_ABORTED', reason: 'prova', marker: { client: empty.client, principal: P } }),
      (err: unknown) => {
        expectTransitionError('TRANSITION_CONFLICT', 'TRANSITION_NOT_ABORTABLE')(err);
        assert.match((err as Error).message, /marker non verificabile/);
        return true;
      },
    );
    assert.equal((await backend()).mode, 'cutover');
    await sql`DELETE FROM cal_migration_transitions`;

    // Caso 2: epoch fallito, marker ancora a E (la PROPPATCH non è partita) → annullamento ammesso.
    await setBackend('postgres', { epoch: 1 });
    const { handle: h2 } = await beginTransition({ ctx: context(), kind: 'cutover' });
    await freezeStep(h2);
    const intact = fakeMarkerClient({ volume_id: VOLUME, epoch: 1 });
    await assert.rejects(runStep(h2, 'epoch', async () => { throw new Error('errore prima della PROPPATCH'); }));
    const result = await abortTransition(h2, { code: 'CUTOVER_ABORTED', reason: 'marker ancora a E', marker: { client: intact.client, principal: P } });
    assert.deepEqual({ mode: result.mode, restored: result.restored }, { mode: 'postgres', restored: true });
    assert.equal((await backend()).mode, 'postgres');
    assert.equal(h2.record.status, 'aborted');
  });
});

// ─── Gate ───────────────────────────────

describe('transizioni: gate cal-write esclusivo', () => {
  const JOB_KIND = 'tst_transition_gate';

  test('attende le scritture in corso; scritture, job e MCP arrivati durante la transizione attendono il gate e poi ricevono l\'indisponibilità', async () => {
    // Calendario creato in mode postgres (con lo store Radicale servirebbe Radicale).
    const cal = await fx.calendar({ key: 'gate' });
    await setBackend('radicale');
    // W1: scrittura di RadicaleStore in corso (PUT in volo) prima della transizione.
    let releaseW1!: () => void;
    const w1Inside = new Promise<void>((r) => { releaseW1 = r; });
    let w1Entered!: () => void;
    const entered = new Promise<void>((r) => { w1Entered = r; });
    const w1 = withCalendarWriteGate(async (ctx) => {
      w1Entered();
      await w1Inside;
      return ctx.state.mode;
    }, { expect: 'radicale' });
    await entered;

    // Prima lo stato.
    const { handle } = await beginTransition({ ctx: context(), kind: 'rollback' });
    await freezeStep(handle);

    // Poi il gate: attende W1.
    let insideGate = false;
    let releaseGate!: () => void;
    const gateHeld = new Promise<void>((r) => { releaseGate = r; });
    let gateEntered!: () => void;
    const gateIn = new Promise<void>((r) => { gateEntered = r; });
    const gate = withTransitionGate(async ({ drained_ms }) => {
      insideGate = true;
      gateEntered();
      await gateHeld;
      return drained_ms;
    }, { timeoutMs: 10_000 });
    assert.equal(await settledWithin(gate, 300), 'pending', 'il gate esclusivo attende la scrittura in corso');
    assert.equal(insideGate, false);
    assert.equal(writeGateStatus().closing, true, 'il gate è chiuso ai nuovi ingressi del processo');

    // W2 (scrittura dell'admin) e un job arrivano durante la transizione: attendono.
    let w2Ran = false;
    const w2 = withCalendarWriteGate(async () => { w2Ran = true; return 'scritto'; }, { expect: 'radicale', timeoutMs: 10_000 });
    let jobRan = false;
    registerCalendarJobHandler(JOB_KIND, async () => withCalendarWriteGate(async () => { jobRan = true; return { result: 'scritto' }; }, { expect: 'radicale', timeoutMs: 10_000 }));
    try {
      await enqueueCalendarJob(JOB_KIND, `k-${randomUUID()}`, {});
      const jobRun = runCalendarJobsOnce({ limit: 1 });
      assert.equal(await settledWithin(w2, 200), 'pending', 'la scrittura nuova attende il gate');
      assert.equal(await settledWithin(jobRun, 200), 'pending', 'il job attende il gate');

      // MCP durante la transizione: ramo {error} esistente, nessuna scrittura.
      const mcp = JSON.parse(await executeTool('create_event', {
        calendar: cal.slug, summary: fx.name('da MCP durante il rollback'), start: '2027-06-01T09:00:00Z', end: '2027-06-01T10:00:00Z',
      })) as Record<string, unknown>;
      assert.ok(typeof mcp.error === 'string', JSON.stringify(mcp));
      assert.equal(mcp.code, undefined, 'nessun codice nuovo nel contratto MCP');
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM calendar_events WHERE calendar_id = ${cal.id}`;
      assert.equal(n, 0);

      // W1 finisce: il gate esclusivo entra.
      releaseW1();
      assert.equal(await w1, 'radicale', 'la scrittura in volo prima del freeze si conclude');
      await gateIn;
      assert.equal(insideGate, true);
      assert.equal(await settledWithin(w2, 200), 'pending', 'dentro il gate esclusivo nessuno scrive');
      releaseGate();
      const drained = await gate;
      assert.ok(drained.result >= 250, `attesa del gate: ${drained.result} ms`);

      // Dopo il gate, chi attendeva rilegge lo stato: transizione → 503.
      await assert.rejects(w2, (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'transition');
      assert.equal(w2Ran, false);
      await jobRun;
      assert.equal(jobRan, false);
      const [job] = await sql`SELECT status, attempts, last_error FROM cal_jobs WHERE kind = ${JOB_KIND}`;
      assert.deepEqual({ status: job.status, attempts: job.attempts }, { status: 'pending', attempts: 0 }, 'il job torna in coda senza consumare tentativi');
      assert.match(String(job.last_error), /rollback|sospese|transition/);
    } finally {
      releaseW1();
      releaseGate();
      unregisterCalendarJobHandler(JOB_KIND);
      await sql`DELETE FROM cal_jobs WHERE kind = ${JOB_KIND}`;
    }
  });

  test('gate non ottenuto entro il tempo: GATE_TIMEOUT, stato invariato', async () => {
    await setBackend('radicale');
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let inside!: () => void;
    const entered = new Promise<void>((r) => { inside = r; });
    const writer = withCalendarWriteGate(async () => { inside(); await hold; }, { expect: 'radicale' });
    await entered;
    try {
      await assert.rejects(withTransitionGate(async () => 'mai', { timeoutMs: 300 }), expectTransitionError('GATE_TIMEOUT'));
    } finally {
      release();
      await writer;
    }
    assert.equal((await backend()).mode, 'radicale');
  });
});

// ─── Quiescenza ───────────────────────────────

describe('transizioni: quiescenza dei device', () => {
  function tick(mode: 'frozen' | 'live' | 'shadow', ok = true): ControlPlaneTick {
    const at = new Date().toISOString();
    return {
      trigger: 'manual', startedAt: at, finishedAt: at, ok, failedStage: ok ? null : 'policy', error: ok ? null : 'disco pieno',
      state: { mode: 'rollback', epoch: 1, policy_version: 9, credential_epoch: 0 }, identity: null,
      policy: { written: true, previous: 'changed', mode, version: 9, reasons: [] }, heartbeat: ok ? { ts: at } : null,
    };
  }

  function deps(over: Partial<QuiescenceDeps> & { putResults?: Array<'open' | 403 | 500>; stats?: string[][] } = {}) {
    const calls = { puts: 0, deletes: 0, sleeps: [] as number[], statRounds: 0 };
    const puts = [...(over.putResults ?? [403])];
    const stats = over.stats ? over.stats.map((r) => [...r]) : null;
    const probe = {
      async put(path: string) {
        calls.puts += 1;
        const next = puts.length > 1 ? puts.shift()! : puts[0];
        if (next === 403) throw new RadicaleForbiddenError({ method: 'PUT', path, status: 403 });
        if (next === 500) throw new RadicaleNetworkError({ method: 'PUT', path, detail: 'reset' } as never);
        return { etag: '"e1"', created: true };
      },
    };
    const svc = {
      async delete() { calls.deletes += 1; },
      async readProps(path: string) {
        const round = stats?.[Math.min(calls.statRounds, stats.length - 1)] ?? ['x'];
        return { '{http://calendarserver.org/ns/}getctag': `${round[0]}:${path}`, '{DAV:}sync-token': 't' };
      },
    };
    let mountRound = -1;
    const d: QuiescenceDeps = {
      probe: probe as unknown as RadicaleClient,
      svc: svc as unknown as RadicaleClient,
      principal: P,
      collections: async () => ['c', 'lavoro', '_canary'],
      statSource: 'mount',
      statCollection: async (name) => BigInt((stats?.[Math.min(mountRound, stats.length - 1)] ?? ['1'])[0].length + name.length),
      statPrincipal: async () => {
        mountRound += 1;
        calls.statRounds = mountRound;
        return 1n;
      },
      syncControlPlane: async () => tick('frozen'),
      sleep: async (ms) => { calls.sleeps.push(ms); },
      now: () => new Date(),
      limits: { quiescenceStatMaxRounds: 5, quiescenceProbeAttempts: 4 },
      ...over,
    };
    return { deps: d, calls };
  }

  test('policy frozen, attesa oltre il ricontrollo dei plugin, probe fino al 403, stat stabile', async () => {
    const { deps: d, calls } = deps({ putResults: ['open', 'open', 403], stats: [['a'], ['bb'], ['ccc'], ['ccc']] });
    const report: QuiescenceReport = await awaitDeviceQuiescence(d, { drainedMs: 42 });
    assert.deepEqual(
      { probe: report.probe, stat: report.stat, policy: report.policy.mode, gate: report.gate },
      { probe: { attempts: 3, status: 403 }, stat: { source: 'mount', rounds: 4, collections: 2 }, policy: 'frozen', gate: { drained_ms: 42 } },
    );
    assert.equal(calls.deletes, 2, 'le risorse scritte dal probe a gate aperto si rimuovono subito');
    assert.ok(calls.sleeps.includes(F4_LIMITS.quiescencePolicyGraceMs), 'attesa minima dopo la policy');
  });

  test('stat remota (senza mount) con getctag e sync-token', async () => {
    const { deps: d } = deps({ statSource: 'remote', stats: [['a'], ['a']] });
    const report = await awaitDeviceQuiescence(d);
    assert.deepEqual(report.stat, { source: 'remote', rounds: 2, collections: 2 });
  });

  test('timeout e precondizioni: probe sempre scrivibile, collezioni che cambiano, probe o control-plane assenti, policy non frozen', async () => {
    await assert.rejects(awaitDeviceQuiescence(deps({ putResults: ['open'] }).deps), expectTransitionError('QUIESCENCE_TIMEOUT'));
    await assert.rejects(awaitDeviceQuiescence(deps({ putResults: [500] }).deps), expectTransitionError('QUIESCENCE_TIMEOUT'));
    await assert.rejects(awaitDeviceQuiescence(deps({ stats: [['a'], ['bb'], ['ccc'], ['dddd'], ['eeeee'], ['ffffff']] }).deps), expectTransitionError('QUIESCENCE_TIMEOUT'));
    await assert.rejects(awaitDeviceQuiescence(deps({ probe: null }).deps), expectTransitionError('PROBE_UNAVAILABLE', 'PROBE_UNAVAILABLE'));
    await assert.rejects(awaitDeviceQuiescence(deps({ syncControlPlane: null }).deps), expectTransitionError('CONTROL_PLANE_UNAVAILABLE', 'CONTROL_PLANE_UNAVAILABLE'));
    await assert.rejects(awaitDeviceQuiescence(deps({ syncControlPlane: async () => tick('live') }).deps), expectTransitionError('CONTROL_PLANE_UNAVAILABLE'));
    await assert.rejects(awaitDeviceQuiescence(deps({ syncControlPlane: async () => tick('frozen', false) }).deps), expectTransitionError('CONTROL_PLANE_UNAVAILABLE'));
  });

  test('passo quiesce: gate più quiescenza, report nel journal, nessuna ripetizione a passo concluso', async () => {
    await setBackend('radicale');
    const { handle } = await beginTransition({ ctx: context(), kind: 'rollback' });
    await freezeStep(handle);
    const seen: string[] = [];
    setTransitionTestHooks({ insideGate: (kind) => { seen.push(`${kind}:${writeGateStatus().closing}`); } });
    const { deps: d, calls } = deps();
    const report = await quiesceStep(handle, d);
    assert.deepEqual(seen, ['rollback:true']);
    assert.equal(report.probe.status, 403);
    const journal = await readJournal(sql, handle.record.id);
    assert.deepEqual(journal.find((j) => j.step === 'quiesce')?.data, report as unknown as Record<string, unknown>);
    const puts = calls.puts;
    await quiesceStep(handle, d);
    assert.equal(calls.puts, puts, 'passo concluso: nessuna nuova quiescenza');
    assert.deepEqual(nextPendingStep('rollback', journal), 'preflight');
    assert.ok(CUTOVER_STEPS.includes('quiesce'));
  });
});
