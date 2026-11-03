/**
 * Coda dei lavori del calendario (apps/api/src/lib/calendar/jobs.ts,
 * migrazione 164; design §4 "164 Lavori", §8; contratto
 * docs/calendar-radicale/contracts/f2-modules.md §3).
 *
 * Coalescenza solo sui pending, outbox dentro la transazione del chiamante,
 * claim con lease e SKIP LOCKED, complete con controllo della source_version,
 * fail con backoff e dead letter, lease scaduti, worker con handler
 * registrati e sveglia via NOTIFY calendar_jobs.
 *
 * Ogni test usa tipi di lavoro propri (prefisso tst_jobs_) e li ripulisce:
 * la coda è condivisa con il resto del processo.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { calSql } from '../../src/db';
import {
  CAL_JOB_DEFAULTS,
  CAL_JOB_PRIORITY,
  CalendarJobPermanentError,
  calendarJobStats,
  claimCalendarJobs,
  completeCalendarJob,
  computeCalendarJobBackoffMs,
  enqueueCalendarJob,
  extendCalendarJobLease,
  failCalendarJob,
  purgeFinishedCalendarJobs,
  recoverExpiredCalendarJobLeases,
  registerCalendarJobHandler,
  registeredCalendarJobKinds,
  retryDeadCalendarJob,
  runCalendarJobsOnce,
  startCalendarJobWorker,
  stopCalendarJobWorker,
  unregisterCalendarJobHandler,
} from '../../src/lib/calendar/jobs';
import { onBeforeDatabaseClose, onDatabaseReady, sql, useTestDatabase } from '../helpers/db';

useTestDatabase();

const PREFIX = 'tst_jobs_';

async function purgeTestJobs(): Promise<void> {
  await sql`DELETE FROM cal_jobs WHERE kind LIKE ${`${PREFIX.replace(/_/g, '\\_')}%`}`;
}

onDatabaseReady(purgeTestJobs);
onBeforeDatabaseClose(async () => {
  await stopCalendarJobWorker();
  await purgeTestJobs();
});

afterEach(async () => {
  for (const kind of registeredCalendarJobKinds()) if (kind.startsWith(PREFIX)) unregisterCalendarJobHandler(kind);
  await stopCalendarJobWorker();
  await purgeTestJobs();
});

interface JobRow {
  id: string;
  kind: string;
  key: string;
  status: string;
  attempts: number;
  payload: Record<string, unknown>;
  source_version: string | null;
  priority: number;
  run_after: Date;
  last_error: string | null;
  lease_token: string | null;
  result: unknown;
}

async function jobs(kind: string): Promise<JobRow[]> {
  return Array.from(await sql<JobRow[]>`
    SELECT id::text AS id, kind, key, status, attempts, payload, source_version, priority, run_after, last_error,
           lease_token::text AS lease_token, result
    FROM cal_jobs WHERE kind = ${kind} ORDER BY id
  `, (r) => ({ ...r }));
}

async function dbNow(): Promise<number> {
  const [{ now }] = await sql<Array<{ now: Date }>>`SELECT now() AS now`;
  return now.getTime();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Enqueue ───────────────────────────────

describe('enqueue: coalescenza solo sui pending', () => {
  test('stessa chiave pending: payload e source_version nuovi, priorità e run_after più urgenti, attempts a 0', async () => {
    const kind = `${PREFIX}coalesce`;
    const first = await enqueueCalendarJob(kind, 'b1', { n: 1 }, { sourceVersion: 'v1', delayMs: 60_000, priority: CAL_JOB_PRIORITY.low });
    assert.equal(first.coalesced, false);
    await sql`UPDATE cal_jobs SET attempts = 3 WHERE id = ${first.id}`;
    const second = await enqueueCalendarJob(kind, 'b1', { n: 2 }, { sourceVersion: 'v2', priority: CAL_JOB_PRIORITY.high });
    assert.equal(second.coalesced, true);
    assert.equal(second.id, first.id);
    const [row] = await jobs(kind);
    assert.deepEqual(row.payload, { n: 2 });
    assert.equal(row.source_version, 'v2');
    assert.equal(row.priority, CAL_JOB_PRIORITY.high);
    assert.equal(row.attempts, 0);
    assert.ok(row.run_after.getTime() <= (await dbNow()) + 1_000, 'run_after anticipato al più urgente');
    // Chiavi diverse: job distinti.
    await enqueueCalendarJob(kind, 'b2', {});
    assert.equal((await jobs(kind)).length, 2);
  });

  test('un job running non assorbe il nuovo accodamento: nasce un pending', async () => {
    const kind = `${PREFIX}running`;
    await enqueueCalendarJob(kind, 'k', { v: 1 }, { sourceVersion: '1' });
    const [claimed] = await claimCalendarJobs({ kinds: [kind] });
    assert.ok(claimed);
    const again = await enqueueCalendarJob(kind, 'k', { v: 2 }, { sourceVersion: '2' });
    assert.equal(again.coalesced, false);
    assert.deepEqual((await jobs(kind)).map((j) => [j.status, j.source_version]), [['running', '1'], ['pending', '2']]);
  });

  test('outbox: accodato nella transazione del chiamante esiste solo dopo il commit', async () => {
    const kind = `${PREFIX}outbox`;
    await sql.begin(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
      await enqueueCalendarJob(kind, 'committed', {}, { db: tx as any });
    });
    try {
      await sql.begin(async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
        await enqueueCalendarJob(kind, 'rolled-back', {}, { db: tx as any });
        throw new Error('rollback');
      });
    } catch { /* voluto */ }
    assert.deepEqual((await jobs(kind)).map((j) => j.key), ['committed']);
  });

  test('argomenti non validi rifiutati prima del database', async () => {
    await assert.rejects(enqueueCalendarJob('Tipo-Sbagliato', 'k'), TypeError);
    await assert.rejects(enqueueCalendarJob(`${PREFIX}x`, ''), TypeError);
    await assert.rejects(enqueueCalendarJob(`${PREFIX}x`, 'k', [] as unknown as Record<string, unknown>), TypeError);
  });
});

// ─── Claim ───────────────────────────────

describe('claim: lease, SKIP LOCKED, priorità e run_after', () => {
  test('due claim concorrenti non prendono mai lo stesso job', async () => {
    const kind = `${PREFIX}skip`;
    for (let i = 0; i < 6; i++) await enqueueCalendarJob(kind, `k${i}`, {});
    const [a, b] = await Promise.all([
      claimCalendarJobs({ kinds: [kind], limit: 4, workerId: 'a' }),
      claimCalendarJobs({ kinds: [kind], limit: 4, workerId: 'b' }),
    ]);
    const ids = [...a, ...b].map((j) => j.id);
    assert.equal(new Set(ids).size, ids.length, 'nessun job preso due volte');
    assert.equal(ids.length, 6);
    for (const j of [...a, ...b]) {
      assert.equal(j.attempts, 1);
      assert.match(j.leaseToken, /^[0-9a-f-]{36}$/);
      assert.ok(j.lockedUntil.getTime() > Date.now());
    }
  });

  test('ordine per priorità, run_after futuro escluso, filtro per tipo', async () => {
    const kind = `${PREFIX}order`;
    const other = `${PREFIX}other`;
    await enqueueCalendarJob(kind, 'low', {}, { priority: CAL_JOB_PRIORITY.low });
    await enqueueCalendarJob(kind, 'high', {}, { priority: CAL_JOB_PRIORITY.high });
    await enqueueCalendarJob(kind, 'later', {}, { delayMs: 3_600_000, priority: 1 });
    await enqueueCalendarJob(other, 'x', {}, { priority: 1 });
    const claimed = await claimCalendarJobs({ kinds: [kind], limit: 10 });
    assert.deepEqual(claimed.map((j) => j.key), ['high', 'low']);
    assert.deepEqual(await claimCalendarJobs({ kinds: [] }), []);
  });

  test('extendLease solo con il lease giusto', async () => {
    const kind = `${PREFIX}extend`;
    await enqueueCalendarJob(kind, 'k', {});
    const [job] = await claimCalendarJobs({ kinds: [kind], leaseMs: 5_000 });
    assert.equal(await extendCalendarJobLease(job, 60_000), true);
    assert.equal(await extendCalendarJobLease({ id: job.id, leaseToken: '00000000-0000-4000-8000-000000000000' }, 60_000), false);
    const [{ remaining }] = await sql<Array<{ remaining: number }>>`
      SELECT EXTRACT(EPOCH FROM locked_until - now())::float8 AS remaining FROM cal_jobs WHERE id = ${job.id}
    `;
    assert.ok(remaining > 50, `lease prolungato (${remaining} s)`);
  });
});

// ─── Chiusura ───────────────────────────────

describe('complete e fail', () => {
  test('complete: done con risultato; lease non più suo → lost', async () => {
    const kind = `${PREFIX}complete`;
    await enqueueCalendarJob(kind, 'k', {}, { sourceVersion: 'v1' });
    const [job] = await claimCalendarJobs({ kinds: [kind] });
    assert.equal(await completeCalendarJob({ ...job, leaseToken: '00000000-0000-4000-8000-000000000000' }), 'lost');
    assert.equal(await completeCalendarJob(job, { result: { href: 'booking-k.ics' }, currentSourceVersion: 'v1' }), 'done');
    const [row] = await jobs(kind);
    assert.equal(row.status, 'done');
    assert.deepEqual(row.result, { href: 'booking-k.ics' });
    assert.equal(row.lease_token, null);
    assert.equal(await completeCalendarJob(job), 'lost', 'un secondo complete non cambia nulla');
  });

  test('source_version cambiata a fine lavoro: riaccodato; con un pending già presente: superseded', async () => {
    const kind = `${PREFIX}version`;
    await enqueueCalendarJob(kind, 'a', {}, { sourceVersion: 'v1' });
    const [a] = await claimCalendarJobs({ kinds: [kind] });
    assert.equal(await completeCalendarJob(a, { currentSourceVersion: 'v2' }), 'requeued');
    let [row] = await jobs(kind);
    assert.deepEqual([row.status, row.source_version, row.attempts], ['pending', 'v2', 0]);

    const [again] = await claimCalendarJobs({ kinds: [kind] });
    await enqueueCalendarJob(kind, 'a', {}, { sourceVersion: 'v3' });
    assert.equal(await completeCalendarJob(again, { currentSourceVersion: 'v3' }), 'superseded');
    const rows = await jobs(kind);
    assert.deepEqual(rows.map((r) => [r.status, r.source_version]), [['superseded', 'v2'], ['pending', 'v3']]);
    [row] = rows;
    assert.equal(row.lease_token, null);
  });

  test('fail ripetibile: backoff e tentativi conservati; tentativi finiti o errore permanente: dead letter', async () => {
    const kind = `${PREFIX}fail`;
    await enqueueCalendarJob(kind, 'retry', {}, { maxAttempts: 2 });
    const [first] = await claimCalendarJobs({ kinds: [kind] });
    const before = await dbNow();
    assert.equal(await failCalendarJob(first, new Error('Radicale giù')), 'requeued');
    let [row] = await jobs(kind);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error ?? '', /Radicale giù/);
    assert.ok(row.run_after.getTime() >= before + 3_000, 'backoff applicato');

    await sql`UPDATE cal_jobs SET run_after = now() WHERE id = ${first.id}`;
    const [second] = await claimCalendarJobs({ kinds: [kind] });
    assert.equal(second.attempts, 2);
    assert.equal(await failCalendarJob(second, new Error('ancora giù')), 'dead');
    [row] = await jobs(kind);
    assert.equal(row.status, 'dead');

    await enqueueCalendarJob(kind, 'perm', {});
    const [perm] = await claimCalendarJobs({ kinds: [kind] });
    assert.equal(await failCalendarJob(perm, new CalendarJobPermanentError('prenotazione inesistente')), 'dead');
    assert.equal(await failCalendarJob(perm, new Error('x')), 'lost');
  });

  test('fail con un pending già presente per la stessa chiave: superseded', async () => {
    const kind = `${PREFIX}failsup`;
    await enqueueCalendarJob(kind, 'k', {});
    const [job] = await claimCalendarJobs({ kinds: [kind] });
    await enqueueCalendarJob(kind, 'k', { nuovo: true });
    assert.equal(await failCalendarJob(job, new Error('x'), { retryAfterMs: 0 }), 'superseded');
    assert.deepEqual((await jobs(kind)).map((r) => r.status), ['superseded', 'pending']);
  });

  test('backoff esponenziale con jitter e tetto', () => {
    const mid = () => 0.5;
    assert.equal(computeCalendarJobBackoffMs(1, mid), CAL_JOB_DEFAULTS.backoffBaseMs);
    assert.equal(computeCalendarJobBackoffMs(2, mid), CAL_JOB_DEFAULTS.backoffBaseMs * 2);
    assert.equal(computeCalendarJobBackoffMs(50, mid), CAL_JOB_DEFAULTS.backoffMaxMs);
    for (let a = 1; a < 20; a++) {
      const lo = computeCalendarJobBackoffMs(a, () => 0);
      const hi = computeCalendarJobBackoffMs(a, () => 0.999999);
      assert.ok(lo >= 1_000 && hi <= CAL_JOB_DEFAULTS.backoffMaxMs && lo <= hi);
    }
  });
});

// ─── Lease scaduti e amministrazione ───────────────────────────────

describe('lease scaduti, dead letter e pulizia', () => {
  test('lease scaduto: di nuovo pending, superseded se c\'è già un pending, dead a tentativi finiti', async () => {
    const kind = `${PREFIX}lease`;
    await enqueueCalendarJob(kind, 'requeue', {});
    await enqueueCalendarJob(kind, 'dead', {}, { maxAttempts: 1 });
    await enqueueCalendarJob(kind, 'sup', {});
    const claimed = await claimCalendarJobs({ kinds: [kind], limit: 3 });
    assert.equal(claimed.length, 3);
    await enqueueCalendarJob(kind, 'sup', { nuovo: true });
    await sql`UPDATE cal_jobs SET locked_until = now() - interval '1 second' WHERE kind = ${kind} AND status = 'running'`;
    const res = await recoverExpiredCalendarJobLeases();
    assert.deepEqual(res, { requeued: 1, superseded: 1, dead: 1 });
    const rows = await jobs(kind);
    const find = (key: string, status: string) => rows.find((r) => r.key === key && r.status === status);
    assert.ok(find('requeue', 'pending'));
    assert.ok(find('dead', 'dead'));
    assert.ok(find('sup', 'superseded'));
    assert.deepEqual(find('sup', 'pending')?.payload, { nuovo: true });
    assert.match(find('requeue', 'pending')?.last_error ?? '', /lease scaduto/);
    // Il worker originale arriva tardi: il suo complete non vale più.
    const late = claimed.find((j) => j.key === 'requeue')!;
    assert.equal(await completeCalendarJob(late), 'lost');
  });

  test('retryDead rimette in coda; purge cancella i chiusi oltre la retention; statistiche', async () => {
    const kind = `${PREFIX}admin`;
    await enqueueCalendarJob(kind, 'd', {});
    const [job] = await claimCalendarJobs({ kinds: [kind] });
    await failCalendarJob(job, new CalendarJobPermanentError('no'));
    let stats = await calendarJobStats();
    assert.ok(stats.dead >= 1);
    assert.ok((stats.byKind[kind]?.dead ?? 0) === 1);
    assert.equal(await retryDeadCalendarJob(job.id), true);
    assert.equal(await retryDeadCalendarJob(job.id), false, 'non è più dead');
    const [row] = await jobs(kind);
    assert.deepEqual([row.status, row.attempts], ['pending', 0]);

    const [again] = await claimCalendarJobs({ kinds: [kind] });
    await completeCalendarJob(again);
    await sql`UPDATE cal_jobs SET finished_at = now() - interval '30 days' WHERE id = ${again.id}`;
    assert.ok(await purgeFinishedCalendarJobs() >= 1);
    assert.deepEqual(await jobs(kind), []);

    await enqueueCalendarJob(kind, 'due', {});
    stats = await calendarJobStats();
    assert.ok(stats.byKind[kind]?.pending === 1);
    assert.ok(stats.due >= 1);
    assert.notEqual(stats.oldestDueAgeSeconds, null);
  });
});

// ─── Worker ───────────────────────────────

describe('worker: handler registrati', () => {
  test('esegue i soli tipi registrati: successo, errore ripetibile e source_version cambiata', async () => {
    const ok = `${PREFIX}w_ok`;
    const ko = `${PREFIX}w_ko`;
    const ver = `${PREFIX}w_ver`;
    const orphan = `${PREFIX}w_orphan`;
    const seen: string[] = [];
    registerCalendarJobHandler(ok, async (job) => { seen.push(job.key); return { result: { ok: true } }; });
    registerCalendarJobHandler(ko, async () => { throw new Error('Radicale irraggiungibile'); });
    registerCalendarJobHandler(ver, async () => ({ currentSourceVersion: 'nuova' }));
    assert.throws(() => registerCalendarJobHandler(ok, async () => {}), /già registrato/);

    await enqueueCalendarJob(ok, 'a', {});
    await enqueueCalendarJob(ko, 'b', {});
    await enqueueCalendarJob(ver, 'c', {}, { sourceVersion: 'vecchia' });
    await enqueueCalendarJob(orphan, 'd', {});
    const summary = await runCalendarJobsOnce({ limit: 10 });
    // ver: riaccodato subito con la versione nuova e rieseguito nello stesso
    // giro, poi completato; ko: in backoff, non ripreso.
    assert.equal(summary.claimed, 4, JSON.stringify(summary));
    assert.equal(summary.done, 2);
    assert.equal(summary.requeued, 2);
    assert.deepEqual(seen, ['a']);
    assert.equal((await jobs(ok))[0].status, 'done');
    assert.equal((await jobs(ko))[0].status, 'pending');
    assert.match((await jobs(ko))[0].last_error ?? '', /irraggiungibile/);
    const [v] = await jobs(ver);
    assert.deepEqual([v.status, v.source_version, v.attempts], ['done', 'nuova', 1]);
    assert.equal((await jobs(orphan))[0].status, 'pending', 'tipo senza handler: resta in coda');
    assert.equal((await jobs(orphan))[0].attempts, 0);
  });

  test('handler oltre il lease: annullato e riaccodato come ripetibile', async () => {
    const kind = `${PREFIX}w_slow`;
    let aborted = false;
    registerCalendarJobHandler(kind, (_job, ctx) => new Promise((_, reject) => {
      ctx.signal.addEventListener('abort', () => { aborted = true; reject(ctx.signal.reason); }, { once: true });
    }), { leaseMs: 1_000 });
    await enqueueCalendarJob(kind, 'k', {});
    const summary = await runCalendarJobsOnce({ limit: 1 });
    assert.equal(summary.requeued, 1);
    assert.equal(aborted, true);
    assert.match((await jobs(kind))[0].last_error ?? '', /lease/);
  });

  test('il worker di processo si sveglia con NOTIFY calendar_jobs', async () => {
    const kind = `${PREFIX}w_notify`;
    const done: string[] = [];
    registerCalendarJobHandler(kind, async (job) => { done.push(job.key); });
    await startCalendarJobWorker({ intervalMs: 60_000, db: calSql });
    await sleep(200);
    await enqueueCalendarJob(kind, 'subito', {});
    for (let i = 0; i < 100 && done.length === 0; i++) await sleep(20);
    assert.deepEqual(done, ['subito']);
    await stopCalendarJobWorker();
    for (let i = 0; i < 50; i++) {
      const [row] = await jobs(kind);
      if (row?.status === 'done') break;
      await sleep(20);
    }
    assert.equal((await jobs(kind))[0].status, 'done');
  });
});
