/**
 * Shadow mirror, proiezioni e filtro di PgLegacyStore senza Radicale (gruppo
 * SHADOW della F3: apps/api/src/lib/calendar/migration/shadow.ts,
 * radicale/booking-projection.ts, store.ts; design §13.8, decisioni 3 e 5;
 * contratto docs/calendar-radicale/contracts/f3-modules.md §1.3, §6.4 e §9).
 *
 * Casi:
 *  - parità (pura): serie verde, giro orario, giro non verde, un giro notturno
 *    verde per ognuno dei 7 giorni; getParity su run reali, coda e conflitti
 *    aperti (job shadow e apply successivi che li chiudono);
 *  - ordine degli item e item ammessi a una cancellazione GDPR con lo shadow
 *    spento (mai creazioni);
 *  - handler del job: shadow spento → chiuso senza azione; chiave non valida →
 *    dead letter; volume non inizializzato; Radicale non configurato → attesa;
 *    lock cal-migration occupato da un run → errore d'attesa;
 *  - setShadowEnabled: spegnimento sempre ammesso, precondizioni con tutti i
 *    motivi, già attivo;
 *  - iscrizioni: flag per singola iscrizione con sidecar invisibile al legacy,
 *    host del feed senza percorso;
 *  - cron ics-pull con lo store postgres: dopo il pull legacy, pull verso
 *    l'indice delle iscrizioni con sidecar;
 *  - riconciliazione in sola lettura delle proiezioni;
 *  - proiezioni: contenuto unico di calendar-core, minimizzazione (24 mesi e
 *    anonimizzazione) e riscrittura per campo che preserva VALARM e X-*;
 *  - filtro di PgLegacyStore: sidecar e archivio invisibili, contratti
 *    invariati senza quelle righe.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, mock, test } from 'node:test';
import { bookingProjectionContent, getTextValue, parseCalendarObject } from '@calicchia/calendar-core';
import { runIcsPull } from '../../src/cron/ics-pull';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { isCalendarJobWaitError, type CalendarJob } from '../../src/lib/calendar/jobs';
import {
  bookingAdminUrl,
  buildBookingProjectionIcs,
  isAnonymizedBooking,
  minimizationRewrite,
  projectionResourceMinimized,
} from '../../src/lib/calendar/booking-projection';
import {
  cancelShadowNightlyRetry,
  computeParityStreak,
  countOpenShadowConflicts,
  erasureOnlyExecutable,
  getParity,
  handleShadowMirror,
  inNightlyQuietWindow,
  isErasureMoveCreate,
  isFullVerifyParams,
  isHourlyVerifyParams,
  listSubscriptionsForMigration,
  parityDay,
  runShadowHourlyParity,
  runShadowNightly,
  ShadowLockBusyError,
  orderShadowItems,
  parityRounds,
  reconcileProjectionsReadOnly,
  setShadowEnabled,
  setSubscriptionMigrationFlags,
  verifyRunGreen,
  withShadowMigrationLock,
} from '../../src/lib/calendar/migration/shadow';
import { MIGRATION_LOCK_KEY, MigrationError, type PlanItem } from '../../src/lib/calendar/migration/types';
import { RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { configureRadicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import { getPgLegacyStore } from '../../src/lib/calendar/store';
import { logger } from '../../src/lib/logger';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { romeIso, useFixtures } from '../helpers/fixtures';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});
const fx = useFixtures('mig-shadow');

const DAY = 86_400_000;
const HOUR = 3_600_000;
const VOLUME = 'a1b2c3d4-0000-4000-8000-00000000f300';
const jobLog = logger.child({ scope: 'test-shadow' });

// ─── Utilità ───────────────────────────────

function fakeJob(key: string, payload: Record<string, unknown> = {}): CalendarJob {
  const now = new Date();
  return {
    id: '1', kind: 'shadow_mirror', key, payload, sourceVersion: null, priority: 100, attempts: 1, maxAttempts: 8,
    runAfter: now, leaseToken: '00000000-0000-4000-8000-000000000000', lockedBy: 'test', lockedUntil: new Date(now.getTime() + 60_000),
    lastError: null, createdAt: now,
  };
}

const jobCtx = { signal: new AbortController().signal, extendLease: async () => true, log: jobLog };

async function setState(values: { shadow?: boolean; volume?: string | null; mode?: 'postgres' | 'radicale' }): Promise<void> {
  if (values.volume !== undefined) {
    await sql`UPDATE calendar_backend_state SET volume_id = ${values.volume}::uuid, epoch = ${values.volume ? 1 : 0} WHERE id = true`;
  }
  if (values.shadow !== undefined) {
    await sql`UPDATE calendar_backend_state SET shadow_enabled = ${values.shadow}, shadow_since = ${values.shadow ? sql`now()` : null} WHERE id = true`;
  }
  if (values.mode !== undefined) await sql`UPDATE calendar_backend_state SET mode = ${values.mode} WHERE id = true`;
}

async function resetState(): Promise<void> {
  await sql`
    UPDATE calendar_backend_state SET mode = 'postgres', volume_id = NULL, epoch = 0, shadow_enabled = false, shadow_since = NULL
    WHERE id = true
  `;
}

async function insertRun(row: {
  kind: string; status: string; trigger: string; params?: object; summary?: object | null; finishedAt: Date; createdAt?: Date;
}): Promise<string> {
  const created = row.createdAt ?? new Date(row.finishedAt.getTime() - 60_000);
  const [r] = await sql<Array<{ id: string }>>`
    INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, summary, created_at, started_at, finished_at, attempts)
    VALUES (${row.kind}, ${row.status}, ${row.trigger}, 'system:shadow', ${sql.json((row.params ?? {}) as never)},
            ${row.summary ? sql.json(row.summary as never) : null}, ${created}, ${created}, ${row.finishedAt}, 1)
    RETURNING id::text AS id
  `;
  return r.id;
}

function planItem(o: Partial<PlanItem> & Pick<PlanItem, 'action'>): PlanItem {
  return {
    legacy_key: 'event:e0000000-0000-4000-8000-000000000001', kind: 'event', calendar_id: 'c0000000-0000-4000-8000-00000000000a',
    collection_name: 'lavoro', href: 'x.ics', code: null, source: null, ledger: null, target: null, patch: false, other_href: null, fields: [],
    ...o,
  };
}

// ─── Parità (pura) ───────────────────────────────

describe('parità dello shadow (pura)', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const nightly = (daysAgo: number, green = true) => ({
    kind: 'verify' as const, status: 'succeeded', trigger: 'schedule' as const,
    params: { levels: ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 180 },
    summary: { acceptable: green, overall: green ? 'green' : 'red' },
    finished_at: new Date(now.getTime() - daysAgo * DAY + HOUR),
  });
  const hourly = (hoursAgo: number, color: 'green' | 'yellow' | 'red') => ({
    kind: 'verify' as const, status: 'succeeded', trigger: 'schedule' as const,
    params: { levels: ['V4'], v4_days: 14 },
    summary: { acceptable: color === 'green', overall: color, v4: { without_subscriptions: color, with_subscriptions: 'yellow' } },
    finished_at: new Date(now.getTime() - hoursAgo * HOUR),
  });

  test('giro orario e notturno: colore e verde', () => {
    assert.equal(isHourlyVerifyParams({ levels: ['V4'], v4_days: 14 }), true);
    assert.equal(isHourlyVerifyParams({ levels: ['V1', 'V4'] }), false);
    assert.equal(verifyRunGreen(hourly(1, 'yellow')), true, 'V4 giallo non è rosso');
    assert.equal(verifyRunGreen(hourly(1, 'red')), false);
    assert.equal(verifyRunGreen(nightly(1, true)), true);
    assert.equal(verifyRunGreen({ ...nightly(1, true), status: 'failed' }), false);
  });

  test('7 giorni di giri verdi con un notturno al giorno → soddisfatta', () => {
    const rounds = parityRounds([...Array.from({ length: 9 }, (_, d) => nightly(d)), hourly(3, 'green'), hourly(30, 'yellow')]);
    const streak = computeParityStreak(rounds, { now, shadowSince: new Date(now.getTime() - 10 * DAY), requiredDays: 7 });
    assert.ok(streak.green_since);
    assert.ok(streak.days_green >= 7, `giorni verdi: ${streak.days_green}`);
    assert.equal(streak.satisfied, true);
  });

  test('un giro non verde riparte la serie dal primo verde successivo', () => {
    const rounds = parityRounds([...Array.from({ length: 9 }, (_, d) => nightly(d)), hourly(48, 'red'), hourly(47, 'green')]);
    const streak = computeParityStreak(rounds, { now, shadowSince: new Date(now.getTime() - 10 * DAY), requiredDays: 7 });
    assert.equal(streak.green_since?.toISOString(), new Date(now.getTime() - 47 * HOUR).toISOString());
    assert.equal(streak.days_green, 1);
    assert.equal(streak.satisfied, false);
  });

  test('un giorno senza giro notturno verde → non soddisfatta anche con 7 giorni di serie', () => {
    const runs = Array.from({ length: 9 }, (_, d) => nightly(d)).filter((_, d) => d !== 3);
    const streak = computeParityStreak(parityRounds([...runs, hourly(80, 'green')]), { now, shadowSince: new Date(now.getTime() - 10 * DAY), requiredDays: 7 });
    assert.ok(streak.days_green >= 7);
    assert.equal(streak.satisfied, false);
  });

  test('ultimo giro rosso, nessun giro o shadow spento → nessuna serie', () => {
    const since = new Date(now.getTime() - 10 * DAY);
    assert.equal(computeParityStreak(parityRounds([nightly(2), hourly(1, 'red')]), { now, shadowSince: since, requiredDays: 7 }).green_since, null);
    assert.equal(computeParityStreak([], { now, shadowSince: since, requiredDays: 7 }).green_since, null);
    assert.equal(computeParityStreak(parityRounds([nightly(1)]), { now, shadowSince: null, requiredDays: 7 }).green_since, null);
    // Un apply programmato fallito è un giro non verde.
    const failedApply = { kind: 'apply' as const, status: 'failed', trigger: 'schedule' as const, params: {}, summary: null, finished_at: new Date(now.getTime() - HOUR) };
    assert.equal(computeParityStreak(parityRounds([nightly(2), failedApply]), { now, shadowSince: since, requiredDays: 7 }).green_since, null);
    // I giri prima dell'attivazione non contano.
    assert.equal(computeParityStreak(parityRounds([nightly(5)]), { now, shadowSince: new Date(now.getTime() - DAY), requiredDays: 7 }).green_since, null);
  });
});

describe('parità dello shadow: verifiche complete, giorni di calendario e finestra del notturno (pura)', () => {
  const full = { scope: {}, levels: ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 180 };
  const sched = (params: object, acceptable: boolean, finished: Date) => ({
    kind: 'verify' as const, status: 'succeeded', trigger: 'schedule' as const, params,
    summary: { acceptable, overall: acceptable ? 'green' : 'red' }, finished_at: finished,
  });

  test('solo una verifica completa (tutti i calendari, V1-V5, V4 su 180 giorni) attesta la parità', () => {
    assert.equal(isFullVerifyParams(full), true);
    assert.equal(isFullVerifyParams({ levels: ['V1', 'V2', 'V3', 'V4', 'V5'] }), true, 'v4_days assente = default di 180');
    assert.equal(isFullVerifyParams({ ...full, scope: { calendar_ids: ['c0000000-0000-4000-8000-00000000000a'] } }), false, 'ambito parziale');
    assert.equal(isFullVerifyParams({ ...full, v4_days: 1 }), false, 'V4 su un giorno');
    assert.equal(isFullVerifyParams({ ...full, levels: ['V1', 'V2', 'V3', 'V5'] }), false);
    const at = new Date('2026-10-10T01:10:00Z');
    assert.equal(verifyRunGreen(sched(full, true, at)), true);
    assert.equal(verifyRunGreen(sched({ ...full, scope: { calendar_ids: ['c0000000-0000-4000-8000-00000000000a'] } }, true, at)), false);
    assert.equal(verifyRunGreen(sched({ ...full, v4_days: 1 }, true, at)), false);
    // Notturno parziale: giro notturno NON verde (interrompe la serie invece di attestarla).
    const rounds = parityRounds([sched({ ...full, scope: { calendar_ids: ['c0000000-0000-4000-8000-00000000000a'] } }, true, at)]);
    assert.deepEqual(rounds.map((r) => ({ green: r.green, nightly: r.nightly })), [{ green: false, nightly: true }]);
  });

  test('un giro notturno verde per giorno di Roma: nessun buco se il giro finisce più tardi del giorno prima', () => {
    const since = new Date('2026-10-01T00:00:00Z');
    // Giri notturni alle 03:xx di Roma (01:xx UTC, ora legale) con scarti di 2-25 minuti.
    const jitter = [2, 25, 5, 20, 3, 22, 7, 18, 10, 24];
    const runs = jitter.map((j, i) => sched(full, true, new Date(Date.UTC(2026, 9, 2 + i, 1, j))));
    const rounds = parityRounds(runs);
    let checked = 0;
    for (let m = 0; m < 24 * 60; m += 1) {
      const now = new Date(Date.UTC(2026, 9, 11, 0, 0) + m * 60_000);
      const streak = computeParityStreak(rounds, { now, shadowSince: since, requiredDays: 7 });
      if (streak.days_green < 7) continue;
      checked += 1;
      assert.equal(streak.satisfied, true, `soddisfatta alle ${now.toISOString()} (giorni verdi ${streak.days_green})`);
    }
    assert.ok(checked > 1000, `istanti controllati: ${checked}`);
    // Un giorno di calendario senza notturno resta un buco.
    const holed = parityRounds(runs.filter((_, i) => i !== 6));
    assert.equal(computeParityStreak(holed, { now: new Date('2026-10-11T12:00:00Z'), shadowSince: since, requiredDays: 7 }).satisfied, false);
    assert.equal(parityDay(new Date('2026-10-10T22:30:00Z')), '2026-10-11', 'giorno di Roma, non UTC');
  });

  test('finestra del notturno: il giro orario non parte fra 02:55 e 03:15 (ora locale del cron)', () => {
    const at = (h: number, m: number) => new Date(2026, 9, 16, h, m, 0);
    assert.equal(inNightlyQuietWindow(at(2, 54)), false);
    assert.equal(inNightlyQuietWindow(at(2, 55)), true);
    assert.equal(inNightlyQuietWindow(at(3, 0)), true);
    assert.equal(inNightlyQuietWindow(at(3, 14)), true);
    assert.equal(inNightlyQuietWindow(at(3, 15)), false);
    assert.equal(inNightlyQuietWindow(at(12, 0)), false);
  });
});

describe('giri programmati dello shadow', () => {
  after(async () => {
    cancelShadowNightlyRetry();
    configureRadicaleRuntime(null);
    await sql`DELETE FROM cal_jobs WHERE kind = 'migration_run'`;
    await sql`DELETE FROM cal_migration_runs`;
    await resetState();
  });

  test('notturno con un run attivo: nuovo tentativo, poi apply con la verifica di TUTTI i calendari anche con un\'anteprima parziale', async () => {
    await sql`DELETE FROM cal_migration_runs`;
    configureRadicaleRuntime({ client: new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0 }), principal: 'federico', watch: 'off', identitySource: 'remote' });
    await setState({ volume: VOLUME, shadow: true });
    const lavoroId = (await getPgLegacyStore().getCalendar('lavoro'))!.id;
    const planId = await insertRun({ kind: 'plan', status: 'succeeded', trigger: 'admin', params: { scope: { calendar_ids: [lavoroId] }, options: {} }, finishedAt: new Date() });
    const [active] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_migration_runs (kind, status, trigger, requested_by, params, started_at, attempts)
      VALUES ('verify', 'running', 'schedule', 'system:shadow', ${sql.json({ scope: {}, levels: ['V4'], v4_days: 14 } as never)}, now(), 1)
      RETURNING id::text AS id
    `;
    const outcome = await runShadowNightly({ retryDelayMs: 100, retryUntil: Date.now() + 10_000 });
    assert.equal(outcome, 'retry', 'il giorno non resta senza giro notturno');
    assert.equal((await sql`SELECT 1 FROM cal_migration_runs WHERE kind = 'apply'`).length, 0);
    await sql`UPDATE cal_migration_runs SET status = 'succeeded', finished_at = now() WHERE id = ${active.id}::uuid`;
    let apply: { params: { scope: unknown; follow_up_verify: { scope: unknown; levels: string[]; v4_days: number } }; plan_run_id: string } | undefined;
    for (let i = 0; i < 50 && !apply; i++) {
      await new Promise((r) => setTimeout(r, 50));
      [apply] = await sql<Array<{ params: { scope: unknown; follow_up_verify: { scope: unknown; levels: string[]; v4_days: number } }; plan_run_id: string }>>`
        SELECT params, plan_run_id::text AS plan_run_id FROM cal_migration_runs WHERE kind = 'apply' AND trigger = 'schedule'
      `;
    }
    assert.ok(apply, 'apply notturno accodato al nuovo tentativo');
    assert.equal(apply.plan_run_id, planId);
    assert.deepEqual(apply.params.scope, { calendar_ids: [lavoroId] }, 'l\'apply segue l\'ambito dell\'anteprima');
    assert.deepEqual(apply.params.follow_up_verify.scope, {}, 'la verifica copre tutti i calendari');
    assert.equal(apply.params.follow_up_verify.v4_days, 180);
    assert.equal(apply.params.follow_up_verify.levels.length, 5);

    // Run ancora attivo oltre la finestra: giro saltato, nessun timer lasciato.
    assert.equal(await runShadowNightly({ retryDelayMs: 100, retryUntil: Date.now() + 50 }), 'skipped');
    await sql`DELETE FROM cal_jobs WHERE kind = 'migration_run'`;
    await sql`DELETE FROM cal_migration_runs`;
  });

  test('orario nella finestra del notturno: nessuna verifica accodata', async () => {
    configureRadicaleRuntime({ client: new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0 }), principal: 'federico', watch: 'off', identitySource: 'remote' });
    await setState({ volume: VOLUME, shadow: true });
    await runShadowHourlyParity({ now: new Date(2026, 9, 16, 3, 2) });
    assert.equal((await sql`SELECT 1 FROM cal_migration_runs WHERE kind = 'verify'`).length, 0);
    await runShadowHourlyParity({ now: new Date(2026, 9, 16, 11, 0) });
    assert.equal((await sql`SELECT 1 FROM cal_migration_runs WHERE kind = 'verify'`).length, 1);
    await sql`DELETE FROM cal_jobs WHERE kind = 'migration_run'`;
    await sql`DELETE FROM cal_migration_runs`;
  });
});

// ─── Ordine e cancellazione con lo shadow spento ───────────────────────────────

describe('item dello shadow', () => {
  test('prima tutto tranne le delete, poi le delete', () => {
    const items = [planItem({ action: 'delete', href: 'a.ics' }), planItem({ action: 'create', href: 'b.ics' }), planItem({ action: 'noop', href: 'c.ics' })];
    assert.deepEqual(orderShadowItems(items).map((i) => `${i.action}:${i.href}`), ['create:b.ics', 'noop:c.ics', 'delete:a.ics']);
  });

  test('cancellazione GDPR con lo shadow spento: la create di uno spostamento si esegue (oggetto già su Radicale)', () => {
    const source = { uid: 'x' } as unknown as PlanItem['source'];
    const moved = new Set(['event:e0000000-0000-4000-8000-000000000001']);
    assert.equal(isErasureMoveCreate(planItem({ action: 'create', source }), moved, true), true);
    assert.equal(isErasureMoveCreate(planItem({ action: 'create', source }), moved, false), false, 'solo nei job di cancellazione');
    assert.equal(isErasureMoveCreate(planItem({ action: 'create', source }), new Set(), true), false, 'oggetto nuovo: mai con lo shadow spento');
    assert.equal(isErasureMoveCreate(planItem({ action: 'update', source }), moved, true), false);
  });

  test('cancellazione GDPR con lo shadow spento: solo oggetti tracciati, mai creazioni', () => {
    const ledger = { id: '1' } as PlanItem['ledger'];
    assert.equal(erasureOnlyExecutable(planItem({ action: 'create' })), false);
    assert.equal(erasureOnlyExecutable(planItem({ action: 'create', ledger })), false, 'nuova collezione di uno spostamento');
    assert.equal(erasureOnlyExecutable(planItem({ action: 'adopt' })), false);
    for (const action of ['update', 'delete', 'noop', 'adopt', 'conflict', 'skip'] as const) {
      assert.equal(erasureOnlyExecutable(planItem({ action, ledger })), true, action);
    }
  });
});

// ─── Handler del job ───────────────────────────────

describe('handler del job shadow_mirror senza Radicale', () => {
  after(async () => {
    configureRadicaleRuntime(null);
    await resetState();
  });

  test('chiave non valida → dead letter', async () => {
    await assert.rejects(handleShadowMirror(fakeJob('archive:x.ics'), jobCtx), (err: Error) => err.name === 'CalendarJobPermanentError');
    await assert.rejects(handleShadowMirror(fakeJob('nonsense'), jobCtx), (err: Error) => err.name === 'CalendarJobPermanentError');
  });

  test('shadow spento → chiuso senza azione; erasure sì ma senza volume nessuna scrittura', async () => {
    await resetState();
    const off = await handleShadowMirror(fakeJob('event:e0000000-0000-4000-8000-000000000001'), jobCtx);
    assert.equal((off as { result: { skipped: string } }).result.skipped, 'shadow_off');
    const erasure = await handleShadowMirror(fakeJob('booking:abc123', { erasure: true }), jobCtx);
    assert.equal((erasure as { result: { skipped: string } }).result.skipped, 'volume_not_initialized');
    await setState({ volume: VOLUME, shadow: true, mode: 'radicale' });
    const radicale = await handleShadowMirror(fakeJob('booking:abc123'), jobCtx);
    assert.equal((radicale as { result: { skipped: string } }).result.skipped, 'mode_not_postgres');
    await resetState();
  });

  test('Radicale non configurato → errore d\'attesa (tentativo non consumato)', async () => {
    configureRadicaleRuntime(null);
    await setState({ volume: VOLUME, shadow: true });
    await assert.rejects(handleShadowMirror(fakeJob('booking:abc123'), jobCtx), (err: unknown) => err instanceof CalendarUnavailableError && isCalendarJobWaitError(err));
    await resetState();
  });

  test('lock cal-migration occupato da un run → errore d\'attesa, nessuna esecuzione', async () => {
    const holder = await sql.reserve();
    try {
      await holder`SELECT pg_advisory_lock(hashtext(${MIGRATION_LOCK_KEY}))`;
      let ran = false;
      await assert.rejects(
        withShadowMigrationLock(async () => { ran = true; }),
        (err: unknown) => err instanceof ShadowLockBusyError && err instanceof CalendarUnavailableError && err.reason === 'transition' && isCalendarJobWaitError(err),
      );
      assert.equal(ran, false);
      configureRadicaleRuntime({ client: new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0 }), principal: 'federico', watch: 'off', identitySource: 'remote' });
      await setState({ volume: VOLUME, shadow: true });
      await assert.rejects(handleShadowMirror(fakeJob('booking:abc123'), jobCtx), (err: unknown) => err instanceof ShadowLockBusyError);
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtext(${MIGRATION_LOCK_KEY}))`;
      holder.release();
      configureRadicaleRuntime(null);
      await resetState();
    }
    // Lock libero: preso e rilasciato.
    assert.equal(await withShadowMigrationLock(async () => 42), 42);
    const [held] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
        AND ((classid::bigint << 32) | objid::bigint) = hashtext(${MIGRATION_LOCK_KEY})::bigint
    `;
    assert.equal(held.n, 0);
  });

  test('identità non verificabile → errore d\'attesa', async () => {
    configureRadicaleRuntime({ client: new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0 }), principal: 'federico', watch: 'off', identitySource: 'remote' });
    await setState({ volume: VOLUME, shadow: true });
    try {
      await assert.rejects(handleShadowMirror(fakeJob('booking:abc123'), jobCtx), (err: unknown) =>
        err instanceof CalendarUnavailableError && (err.reason === 'identity_unverified' || err.reason === 'identity_mismatch') && isCalendarJobWaitError(err));
    } finally {
      configureRadicaleRuntime(null);
      await resetState();
    }
  });
});

// ─── Attivazione ───────────────────────────────

describe('setShadowEnabled', () => {
  after(async () => {
    configureRadicaleRuntime(null);
    await resetState();
    await sql`DELETE FROM cal_migration_ledger`;
  });

  test('spegnimento sempre ammesso', async () => {
    await setState({ shadow: true });
    const res = await setShadowEnabled({ enabled: false, actor: 'admin:test' });
    assert.deepEqual(res, { shadow_enabled: false, shadow_since: null, catch_up_run: null });
    const [row] = await sql<Array<{ shadow_enabled: boolean; shadow_since: Date | null }>>`SELECT shadow_enabled, shadow_since FROM calendar_backend_state`;
    assert.equal(row.shadow_enabled, false);
    assert.equal(row.shadow_since, null);
  });

  test('accensione senza Radicale → RADICALE_NOT_CONFIGURED', async () => {
    configureRadicaleRuntime(null);
    await assert.rejects(setShadowEnabled({ enabled: true, actor: 'admin:test' }), (err: unknown) => err instanceof MigrationError && err.code === 'RADICALE_NOT_CONFIGURED');
  });

  test('precondizioni: tutti i motivi insieme, poi già attivo', async () => {
    configureRadicaleRuntime({ client: new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0 }), principal: 'federico', watch: 'off', identitySource: 'remote' });
    await sql`
      INSERT INTO cal_migration_ledger (calendar_id, collection_name, href, kind, legacy_key, revalidate_reason, revalidate_since)
      VALUES ('c0000000-0000-4000-8000-00000000000a', 'lavoro', 'x.ics', 'event', 'event:e0000000-0000-4000-8000-000000000001', 'backup-import', now())
    `;
    await assert.rejects(setShadowEnabled({ enabled: true, actor: 'admin:test' }), (err: unknown) => {
      assert.ok(err instanceof MigrationError);
      assert.equal(err.code, 'PRECONDITION_FAILED');
      const reasons = (err.details?.reasons ?? []) as string[];
      for (const r of ['IDENTITY_NOT_OK', 'APPLY_REQUIRED', 'VERIFY_REQUIRED', 'REVALIDATION_PENDING']) assert.ok(reasons.includes(r), `${r} in ${reasons.join(',')}`);
      return true;
    });
    const [row] = await sql<Array<{ shadow_enabled: boolean }>>`SELECT shadow_enabled FROM calendar_backend_state`;
    assert.equal(row.shadow_enabled, false, 'nessuna attivazione con precondizioni non soddisfatte');
    await setState({ shadow: true });
    await assert.rejects(setShadowEnabled({ enabled: true, actor: 'admin:test' }), (err: unknown) =>
      err instanceof MigrationError && ((err.details?.reasons ?? []) as string[]).includes('SHADOW_ALREADY'));
  });
});

describe('setShadowEnabled: verifica completa richiesta', () => {
  after(async () => {
    configureRadicaleRuntime(null);
    await sql`DELETE FROM cal_migration_runs`;
    await resetState();
  });

  test('una verifica accettabile con V4 su un solo giorno non vale per l\'accensione (VERIFY_REQUIRED)', async () => {
    await sql`DELETE FROM cal_migration_runs`;
    await resetState();
    configureRadicaleRuntime({ client: new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0 }), principal: 'federico', watch: 'off', identitySource: 'remote' });
    const t = Date.now();
    await insertRun({ kind: 'apply', status: 'succeeded', trigger: 'admin', summary: { totals: { conflict: 0, failed: 0 }, conflicts: {}, failed: 0 }, finishedAt: new Date(t - 2 * HOUR) });
    await insertRun({
      kind: 'verify', status: 'succeeded', trigger: 'admin', params: { scope: {}, levels: ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 1 },
      summary: { levels: ['V1', 'V2', 'V3', 'V4', 'V5'], overall: 'green', acceptable: true, calendars: [] }, finishedAt: new Date(t - HOUR),
    });
    await assert.rejects(setShadowEnabled({ enabled: true, actor: 'admin:test' }), (err: unknown) => {
      assert.ok(err instanceof MigrationError);
      const reasons = (err.details?.reasons ?? []) as string[];
      assert.ok(reasons.includes('VERIFY_REQUIRED'), reasons.join(','));
      assert.ok(!reasons.includes('APPLY_REQUIRED') && !reasons.includes('VERIFY_RED'), reasons.join(','));
      return true;
    });
  });
});

// ─── Parità su run reali, coda e conflitti ───────────────────────────────

describe('getParity e conflitti aperti', () => {
  after(async () => {
    await sql`DELETE FROM cal_migration_runs`;
    await sql`DELETE FROM cal_jobs WHERE kind = 'shadow_mirror'`;
    await resetState();
  });

  test('serie verde dai run programmati, ultimi giri, coda', async () => {
    await sql`DELETE FROM cal_migration_runs`;
    const now = new Date();
    await sql`UPDATE calendar_backend_state SET shadow_enabled = true, shadow_since = ${new Date(now.getTime() - 9 * DAY)} WHERE id = true`;
    let lastApply = '';
    let lastVerify = '';
    for (let d = 8; d >= 0; d--) {
      const at = new Date(now.getTime() - d * DAY - 2 * HOUR);
      lastApply = await insertRun({ kind: 'apply', status: 'succeeded', trigger: 'schedule', summary: { writes: { create: 1, update: 2, delete: 0 }, conflicts: {} }, finishedAt: at });
      lastVerify = await insertRun({
        kind: 'verify', status: 'succeeded', trigger: 'schedule', params: { scope: {}, levels: ['V1', 'V2', 'V3', 'V4', 'V5'], v4_days: 180 },
        summary: { acceptable: true, overall: 'yellow' }, createdAt: at, finishedAt: new Date(at.getTime() + 10 * 60_000),
      });
    }
    const hourlyId = await insertRun({
      kind: 'verify', status: 'succeeded', trigger: 'schedule', params: { scope: {}, levels: ['V4'], v4_days: 14 },
      summary: { acceptable: true, overall: 'green', v4: { without_subscriptions: 'green', with_subscriptions: 'yellow' } }, finishedAt: new Date(now.getTime() - HOUR),
    });
    await sql`
      INSERT INTO cal_jobs (kind, key, payload, status, run_after)
      VALUES ('shadow_mirror', 'event:e0000000-0000-4000-8000-0000000000aa', '{}'::jsonb, 'pending', now())
    `;
    const parity = await getParity(sql, now);
    assert.equal(parity.shadow_enabled, true);
    assert.equal(parity.required_days, 7);
    assert.ok(parity.days_green >= 7, `giorni verdi: ${parity.days_green}`);
    assert.equal(parity.satisfied, true);
    assert.equal(parity.last_nightly?.apply_run_id, lastApply);
    assert.equal(parity.last_nightly?.verify_run_id, lastVerify);
    assert.equal(parity.last_nightly?.color, 'yellow');
    assert.equal(parity.last_nightly?.green, true, 'giallo con le differenze accettate: verde per la parità');
    assert.equal(parity.last_hourly?.run_id, hourlyId);
    assert.equal(parity.last_hourly?.color, 'green');
    assert.equal(parity.recent[0].run_id, hourlyId);
    const apply = parity.recent.find((r) => r.kind === 'apply');
    assert.equal(apply?.writes, 3);
    assert.equal(apply?.conflicts, 0);
    assert.equal(parity.queue.pending, 1);
    assert.ok(parity.queue.oldest_pending_at);

    // Shadow spento: la parità non è soddisfatta.
    await sql`UPDATE calendar_backend_state SET shadow_enabled = false, shadow_since = NULL WHERE id = true`;
    assert.equal((await getParity(sql, now)).satisfied, false);
  });

  test('conflitti aperti: l\'ultimo esito per chiave decide (job shadow e apply)', async () => {
    await sql`DELETE FROM cal_jobs WHERE kind = 'shadow_mirror'`;
    await sql`DELETE FROM cal_migration_runs`;
    const t0 = new Date(Date.now() - 3 * HOUR);
    const job = async (key: string, outcome: string, at: Date) => {
      await sql`
        INSERT INTO cal_jobs (kind, key, payload, status, run_after, finished_at, result)
        VALUES ('shadow_mirror', ${key}, '{}'::jsonb, 'done', ${at}, ${at}, ${sql.json({ items: [{ legacy_key: key, outcome }] } as never)})
      `;
    };
    await job('event:e0000000-0000-4000-8000-0000000000a1', 'conflict', t0);
    await job('event:e0000000-0000-4000-8000-0000000000a2', 'conflict', t0);
    await job('event:e0000000-0000-4000-8000-0000000000a2', 'done', new Date(t0.getTime() + HOUR));
    assert.equal(await countOpenShadowConflicts(sql), 1);
    // Un apply successivo della chiave rimasta in conflitto la chiude; un altro conflitto dell'apply resta aperto.
    const runId = await insertRun({ kind: 'apply', status: 'succeeded', trigger: 'schedule', summary: {}, finishedAt: new Date(t0.getTime() + 2 * HOUR) });
    await sql`
      INSERT INTO cal_migration_items (run_id, seq, item_type, legacy_key, action, outcome, code)
      VALUES (${runId}::uuid, 0, 'object', 'event:e0000000-0000-4000-8000-0000000000a1', 'update', 'done', NULL),
             (${runId}::uuid, 1, 'object', 'event:e0000000-0000-4000-8000-0000000000a3', 'update', 'conflict', 'TARGET_NEWER')
    `;
    assert.equal(await countOpenShadowConflicts(sql), 1);
    assert.equal((await getParity(sql)).open_conflicts, 1);
  });
});

// ─── Iscrizioni e filtro di PgLegacyStore ───────────────────────────────

describe('iscrizioni per singola iscrizione e righe dello strumento invisibili al legacy', () => {
  after(async () => {
    await resetState();
  });

  test('primo flag: sidecar origin=migration invisibile al legacy, flag e device_visible sul sidecar', async () => {
    const lavoro = (await getPgLegacyStore().getCalendar('lavoro'))!;
    const { subscription } = await fx.subscription({ calendar: lavoro, url: 'http://127.0.0.1:9/privato/token-segreto.ics?k=1' });
    const before = await getPgLegacyStore().listCalendars();

    await assert.rejects(setSubscriptionMigrationFlags(subscription.id, {}, 'admin:test'), (err: unknown) => err instanceof MigrationError && err.code === 'VALIDATION_FAILED');
    await assert.rejects(setSubscriptionMigrationFlags(subscription.id, { blocks_availability: 'si' as never }, 'admin:test'), (err: unknown) => err instanceof MigrationError && err.code === 'VALIDATION_FAILED');

    const first = await setSubscriptionMigrationFlags(subscription.id, { blocks_availability: true }, 'admin:test');
    assert.equal(first.subscription.blocks_availability, true);
    assert.equal(first.subscription.device_visible, false);
    assert.equal(first.collection_missing, false);
    assert.equal(first.subscription.url_host, '127.0.0.1:9', 'solo l\'host, mai percorso e query');
    const sidecarId = first.subscription.sidecar_calendar_id;
    assert.ok(sidecarId);
    const [sidecar] = await sql<Array<{ role: string; origin: string; device_visible: boolean; collection_name: string }>>`
      SELECT role, origin, device_visible, collection_name FROM calendars WHERE id = ${sidecarId}::uuid
    `;
    assert.equal(sidecar.role, 'subscription');
    assert.equal(sidecar.origin, 'migration');
    assert.match(sidecar.collection_name, /^sub-[0-9a-f]{8}/);

    // §1.3: il legacy non vede il sidecar.
    const store = getPgLegacyStore();
    const after = await store.listCalendars();
    assert.deepEqual(after.map((c) => c.id).sort(), before.map((c) => c.id).sort());
    assert.equal(await store.getCalendar(sidecarId), null);
    assert.equal(await store.getCalendar(sidecar.collection_name), null);

    // device_visible: riportato sul sidecar; senza Radicale la collezione sub-* non è verificabile.
    const second = await setSubscriptionMigrationFlags(subscription.id, { device_visible: true }, 'admin:test');
    assert.equal(second.subscription.device_visible, true);
    assert.equal(second.subscription.blocks_availability, true, 'il flag non indicato resta');
    assert.equal(second.collection_missing, true);
    const [visible] = await sql<Array<{ device_visible: boolean }>>`SELECT device_visible FROM calendars WHERE id = ${sidecarId}::uuid`;
    assert.equal(visible.device_visible, true);

    const list = await listSubscriptionsForMigration(sql);
    assert.equal(list.find((s) => s.subscription_id === subscription.id)?.sidecar_calendar_id, sidecarId);
    assert.ok(!JSON.stringify(list).includes('token-segreto'));

    // Solo in mode postgres.
    await setState({ volume: VOLUME, mode: 'radicale' });
    await assert.rejects(setSubscriptionMigrationFlags(subscription.id, { device_visible: false }, 'admin:test'), (err: unknown) =>
      err instanceof MigrationError && ((err.details?.reasons ?? []) as string[]).includes('MODE_NOT_POSTGRES'));
    await resetState();
  });

  test('archivio della Fase 0 (origin=migration): invisibile a list, get, feed e conteggi', async () => {
    const token = 'z'.repeat(31) + 'a';
    const [archive] = await sql<Array<{ id: string }>>`
      INSERT INTO calendars (
        slug, name, description, color, timezone, is_default, is_system, blocks_availability,
        ics_feed_token, ics_feed_enabled, sort_order, collection_name, role, origin, lifecycle, device_visible
      ) VALUES (
        ${fx.slug('archivio')}, ${fx.name('Archivio Fase 0')}, NULL, '#64748b', 'Europe/Rome', false, false, false,
        ${token}, true, 1000, ${fx.slug('archivio')}, 'user', 'migration', 'active', true
      )
      RETURNING id::text AS id
    `;
    fx.track('calendarIds', archive.id);
    await sql`
      INSERT INTO calendar_events (calendar_id, uid, summary, start_time, end_time, source, status)
      VALUES (${archive.id}::uuid, ${fx.slug('arch-1')}, ${fx.name('Vecchio evento')}, ${romeIso('2026-03-01', '09:00')}, ${romeIso('2026-03-01', '10:00')}, 'manual', 'confirmed')
    `;
    const store = getPgLegacyStore();
    assert.ok(!(await store.listCalendars()).some((c) => c.id === archive.id));
    assert.equal(await store.getCalendar(archive.id), null);
    assert.equal(await store.getCalendarByFeedToken(token), null);
    assert.equal((await store.countEventsByCalendar()).has(archive.id), false);
    // I calendari normali restano quelli di prima.
    assert.equal((await store.getCalendar('lavoro'))?.slug, 'lavoro');
    assert.equal((await store.getDefaultCalendar())?.slug, 'lavoro');
  });
});

// ─── Cron ics-pull con lo store postgres ───────────────────────────────

describe('cron ics-pull con lo store postgres', () => {
  // Il pull rifiuta gli IP privati (difese SSRF): l'iscrizione usa un IP pubblico di documentazione e
  // un mock di fetch lo riscrive verso il server locale, come subscriptions-pull.test.ts.
  const PUBLIC_HOST = '203.0.113.10';
  let server: Server | null = null;
  let feed = '';
  let restoreFetch: (() => void) | null = null;

  const vevent = (uid: string, day: string, summary: string): string => [
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z', `DTSTART:${day}T090000Z`, `DTEND:${day}T100000Z`, `SUMMARY:${summary}`, 'END:VEVENT',
  ].join('\r\n');
  const calendarOf = (events: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//IT', ...events, 'END:VCALENDAR', ''].join('\r\n');

  after(async () => {
    restoreFetch?.();
    const s = server;
    server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  test('dopo il pull legacy, pull verso l\'indice delle iscrizioni con sidecar', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
      res.end(feed);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const realFetch = globalThis.fetch;
    const m = mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname === PUBLIC_HOST) url.hostname = '127.0.0.1';
      return realFetch(url, init);
    });
    restoreFetch = () => m.mock.restore();

    feed = calendarOf([vevent('remoto-1@feed.example', '20270301', 'Evento remoto')]);
    const lavoro = (await getPgLegacyStore().getCalendar('lavoro'))!;
    const { subscription } = await fx.subscription({ calendar: lavoro, url: `http://${PUBLIC_HOST}:${port}/feed.ics` });
    const flags = await setSubscriptionMigrationFlags(subscription.id, { blocks_availability: false }, 'admin:test');
    const sidecarId = flags.subscription.sidecar_calendar_id!;
    const count = async (): Promise<number> => {
      const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_components WHERE calendar_id = ${sidecarId}::uuid`;
      return row.n;
    };
    assert.equal(await count(), 1, 'pull forzato alla creazione del sidecar');

    feed = calendarOf([vevent('remoto-1@feed.example', '20270301', 'Evento remoto'), vevent('remoto-2@feed.example', '20270302', 'Secondo evento')]);
    await runIcsPull();
    assert.equal(await count(), 2, 'il cron porta le modifiche del feed nell\'indice');
    const [legacy] = await sql<Array<{ last_synced_at: Date | null }>>`SELECT last_synced_at FROM calendar_subscriptions WHERE id = ${subscription.id}::uuid`;
    assert.ok(legacy.last_synced_at, 'il pull legacy resta la fonte del busy in mode postgres');
  });
});

// ─── Riconciliazione delle proiezioni ───────────────────────────────

describe('riconciliazione in sola lettura delle proiezioni', () => {
  test('mancanti, orfane e con orari diversi; nessuna scrittura', async () => {
    const eventType = await fx.eventType({ key: 'riconcilia' });
    const ok = await fx.booking({ eventType, start: romeIso('2027-02-01', '10:00') });
    const missing = await fx.booking({ eventType, start: romeIso('2027-02-02', '10:00'), project: false });
    const drift = await fx.booking({ eventType, start: romeIso('2027-02-03', '10:00') });
    await sql`UPDATE calendar_events SET start_time = start_time + INTERVAL '1 hour', end_time = end_time + INTERVAL '1 hour' WHERE id = ${drift.projection!.id}`;
    const bookingsCal = (await getPgLegacyStore().getBookingsCalendar())!;
    await fx.event({ calendar: bookingsCal, summary: 'Proiezione senza prenotazione', start_time: romeIso('2027-02-04', '10:00'), end_time: romeIso('2027-02-04', '11:00'), source: 'booking', source_id: 'orfana000001' });
    const [{ n: before }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_events`;
    const res = await reconcileProjectionsReadOnly(sql);
    assert.ok(res.missing.includes(missing.booking.uid));
    assert.ok(!res.missing.includes(ok.booking.uid));
    assert.ok(res.drift.includes(drift.booking.uid));
    assert.ok(!res.drift.includes(ok.booking.uid));
    assert.ok(res.orphan.includes('orfana000001'));
    const [{ n: afterCount }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_events`;
    assert.equal(afterCount, before);
  });
});

// ─── Proiezioni: contenuto unico e minimizzazione ───────────────────────────────

describe('proiezione della prenotazione (decisione 3)', () => {
  const now = new Date('2026-10-10T08:00:00.000Z');
  const booking = {
    uid: 'abc123def456', attendee_name: 'Mario Rossi', attendee_phone: '+39 333 1234567',
    start_time: '2026-11-10T14:00:00.000Z', end_time: '2026-11-10T14:30:00.000Z', location_value: null, created_at: '2026-10-01T10:00:00.000Z',
  };

  function master(ics: string) {
    const parsed = parseCalendarObject(ics);
    assert.ok(parsed.ok && parsed.value.master);
    return parsed.value.master;
  }

  test('stesso contenuto di bookingProjectionContent di calendar-core, mai email', () => {
    const ics = buildBookingProjectionIcs({ booking, eventTitle: 'Consulenza', meetingUrl: 'https://meet.example/abc', now });
    const m = master(ics);
    const content = bookingProjectionContent({
      bookingUid: booking.uid, title: 'Consulenza', attendeeName: booking.attendee_name, attendeePhone: booking.attendee_phone,
      adminUrl: bookingAdminUrl(booking.uid), start: booking.start_time, end: booking.end_time, location: null, meetingUrl: 'https://meet.example/abc',
    }, { now });
    assert.equal(getTextValue(m, 'SUMMARY'), content.summary);
    assert.equal(getTextValue(m, 'SUMMARY'), 'Consulenza – Mario Rossi');
    assert.equal(getTextValue(m, 'DESCRIPTION'), content.description);
    assert.match(content.description ?? '', /Tel: \+39 333 1234567/);
    assert.equal(getTextValue(m, 'LOCATION'), content.location);
    assert.equal(getTextValue(m, 'URL'), content.url);
    assert.equal(getTextValue(m, 'UID'), 'abc123def456@caldes.it');
    assert.ok(!/@test\.invalid|ATTENDEE|ORGANIZER/.test(ics));
    assert.equal(projectionResourceMinimized(ics), false);
  });

  test('minimizzata oltre i 24 mesi o con la prenotazione anonimizzata', () => {
    const old = buildBookingProjectionIcs({ booking: { ...booking, start_time: '2024-10-01T14:00:00.000Z', end_time: '2024-10-01T14:30:00.000Z' }, eventTitle: 'Consulenza', meetingUrl: null, now });
    assert.equal(getTextValue(master(old), 'SUMMARY'), 'Prenotazione');
    assert.equal(getTextValue(master(old), 'DESCRIPTION'), null);
    assert.equal(projectionResourceMinimized(old), true);
    const anon = buildBookingProjectionIcs({ booking, eventTitle: 'Consulenza', meetingUrl: 'https://meet.example/abc', now, minimized: true });
    assert.equal(projectionResourceMinimized(anon), true);
    assert.ok(!anon.includes('Mario') && !anon.includes('333'));
    assert.equal(isAnonymizedBooking({ attendee_email: 'erased-0000@deleted.invalid' }), true);
    assert.equal(isAnonymizedBooking({ attendee_email: 'mario@example.com' }), false);
  });

  test('riscrittura per la minimizzazione: solo i campi della decisione 3, VALARM e X-* restano', () => {
    const current = buildBookingProjectionIcs({ booking, eventTitle: 'Consulenza', meetingUrl: 'https://meet.example/abc', now })
      .replace('END:VEVENT', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Promemoria\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT');
    const wanted = bookingProjectionContent(null, { now });
    const rewritten = minimizationRewrite(current, wanted, now);
    assert.ok(rewritten);
    const m = master(rewritten);
    assert.equal(getTextValue(m, 'SUMMARY'), 'Prenotazione');
    assert.equal(getTextValue(m, 'DESCRIPTION'), null);
    assert.equal(getTextValue(m, 'LOCATION'), null);
    assert.equal(getTextValue(m, 'URL'), null);
    assert.equal(m.components.filter((c) => c.name === 'VALARM').length, 1, 'VALARM preservato');
    assert.ok(rewritten.includes('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC'));
    assert.ok(rewritten.includes('DTSTART:20261110T140000Z'), 'orari invariati');
    // Stesso stato di minimizzazione: nessuna riscrittura (le modifiche dell'API non si annullano).
    const notMinimized = bookingProjectionContent({
      bookingUid: booking.uid, title: 'Altro', attendeeName: 'Altro', attendeePhone: null, adminUrl: null,
      start: booking.start_time, end: booking.end_time, location: null, meetingUrl: null,
    }, { now });
    assert.equal(minimizationRewrite(current, notMinimized, now), null);
    assert.equal(minimizationRewrite(rewritten, wanted, now), null);
    assert.equal(minimizationRewrite('non è un calendario', wanted, now), null);
  });
});
