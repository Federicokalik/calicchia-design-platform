/**
 * Gate delle scritture `cal-write` (apps/api/src/lib/calendar/radicale/
 * write-gate.ts; design §8 passo 2, §13.9; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §1.3 e §6.1), senza Radicale.
 *
 * Casi: lock condiviso preso e rilasciato (pg_locks), stato riletto senza
 * cache dopo il lock, cutover/rollback → 503 'transition', write_freeze → 503
 * 'write_freeze' (solo con lo store Radicale), `expect: 'radicale'` in mode
 * postgres → 503 salvo l'override di test, rientranza senza riprendere il
 * lock, scritture contemporanee su una sola connessione riservata, esclusivo
 * del processo che chiude il gate ai nuovi scrittori e attende quelli in
 * corso, esclusivo di un'altra sessione → 503 entro il timeout.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { CAL_LOCKS } from '../../src/lib/calendar/index-model';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import {
  insideCalendarWriteGate,
  withCalendarWriteGate,
  withExclusiveCalendarWriteGate,
  writeGateStatus,
} from '../../src/lib/calendar/radicale/write-gate';
import { onBeforeDatabaseClose, onDatabaseReady, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';

useTestDatabase({ resetBaseline: true });

const VOLUME = '3c1e2d4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

onDatabaseReady(async () => {
  overrideCalendarStore(null);
});

onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  await resetCalendarBaseline();
});

async function setState(mode: string, opts: { freeze?: boolean } = {}): Promise<void> {
  await sql`
    UPDATE calendar_backend_state
    SET mode = ${mode}, write_freeze = ${opts.freeze ?? false},
        volume_id = ${mode === 'postgres' ? null : VOLUME}, epoch = ${mode === 'postgres' ? 0 : 1}
    WHERE id
  `;
  invalidateBackendModeCache();
}

/** Advisory lock cal-write tenuti in questo momento (per modo). */
async function heldWriteLocks(): Promise<Array<{ mode: string; granted: boolean }>> {
  const rows = await sql<Array<{ mode: string; granted: boolean }>>`
    SELECT l.mode, l.granted FROM pg_locks l
    WHERE l.locktype = 'advisory'
      AND l.objsubid = 1
      AND l.objid = (hashtext(${CAL_LOCKS.write})::bigint & 4294967295)::oid
    ORDER BY l.mode
  `;
  return rows.map((r) => ({ mode: r.mode, granted: r.granted }));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function expectUnavailable(p: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof CalendarUnavailableError, `atteso CalendarUnavailableError, ricevuto ${String(err)}`);
    assert.equal(err.reason, reason);
    return true;
  });
}

describe('gate cal-write', () => {
  test('mode radicale: lock condiviso durante la scrittura, stato riletto senza cache, rilascio alla fine', async () => {
    await setState('radicale');
    const seen = await withCalendarWriteGate(async (ctx) => {
      assert.equal(ctx.state.mode, 'radicale');
      assert.equal(insideCalendarWriteGate(), true);
      const locks = await heldWriteLocks();
      assert.deepEqual(locks, [{ mode: 'ShareLock', granted: true }]);
      assert.deepEqual(writeGateStatus(), { holders: 1, closing: false, reservedConnection: true });
      return 'ok';
    }, { expect: 'radicale' });
    assert.equal(seen, 'ok');
    assert.equal(insideCalendarWriteGate(), false);
    // Il rilascio è asincrono: attende la fine dell'unlock.
    for (let i = 0; i < 50 && (await heldWriteLocks()).length > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(await heldWriteLocks(), []);
    assert.deepEqual(writeGateStatus(), { holders: 0, closing: false, reservedConnection: false });
  });

  test('cutover e rollback → 503 transition; write_freeze → 503 write_freeze; mode postgres con expect radicale → 503', async () => {
    await setState('cutover');
    await expectUnavailable(withCalendarWriteGate(async () => 'no'), 'transition');
    await setState('rollback');
    await expectUnavailable(withCalendarWriteGate(async () => 'no'), 'transition');
    await setState('finalized', { freeze: true });
    await expectUnavailable(withCalendarWriteGate(async () => 'no', { expect: 'radicale' }), 'write_freeze');
    await setState('postgres');
    await expectUnavailable(withCalendarWriteGate(async () => 'no', { expect: 'radicale' }), 'transition');
    // Senza expect, in mode postgres il gate ammette la scrittura (futuro gate dello store legacy, F4).
    assert.equal(await withCalendarWriteGate(async (ctx) => ctx.state.mode), 'postgres');
  });

  test('mode postgres con write_freeze: il freeze non conta (contratto control-plane §6.2)', async () => {
    await setState('postgres', { freeze: true });
    assert.equal(await withCalendarWriteGate(async () => 'ok'), 'ok');
  });

  test('override di test dello store Radicale: in mode postgres il gate ammette lo store forzato', async () => {
    await setState('postgres');
    overrideCalendarStore('radicale');
    try {
      assert.equal(await withCalendarWriteGate(async (ctx) => ctx.state.mode, { expect: 'radicale' }), 'postgres');
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('il cambio di modo si vede subito dopo il lock (nessuna cache)', async () => {
    await setState('radicale');
    // Riempie la cache della facade con radicale, poi passa a cutover senza invalidarla.
    await withCalendarWriteGate(async () => undefined);
    await sql`UPDATE calendar_backend_state SET mode = 'cutover' WHERE id`;
    await expectUnavailable(withCalendarWriteGate(async () => 'no'), 'transition');
  });

  test('rientranza: una scrittura annidata non riprende il lock', async () => {
    await setState('radicale');
    await withCalendarWriteGate(async () => {
      const inner = await withCalendarWriteGate(async (ctx) => {
        assert.equal(writeGateStatus().holders, 1);
        return ctx.state.mode;
      });
      assert.equal(inner, 'radicale');
      assert.deepEqual(await heldWriteLocks(), [{ mode: 'ShareLock', granted: true }]);
    });
  });

  test('scritture contemporanee: una sola connessione riservata, conteggio di riferimento', async () => {
    await setState('radicale');
    const gate = deferred();
    const entered: number[] = [];
    const writers = [1, 2, 3].map((n) => withCalendarWriteGate(async () => {
      entered.push(n);
      await gate.promise;
      return n;
    }));
    for (let i = 0; i < 100 && entered.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(entered.length, 3);
    assert.deepEqual(writeGateStatus(), { holders: 3, closing: false, reservedConnection: true });
    assert.equal((await heldWriteLocks()).length, 1, 'un solo lock condiviso per il processo');
    gate.resolve();
    assert.deepEqual(await Promise.all(writers), [1, 2, 3]);
  });

  test('esclusivo del processo: chiude il gate ai nuovi scrittori e attende quelli in corso', async () => {
    await setState('radicale');
    const running = deferred();
    const order: string[] = [];
    let started = false;
    const writer = withCalendarWriteGate(async () => {
      started = true;
      await running.promise;
      order.push('writer');
    });
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 10));
    const exclusive = withExclusiveCalendarWriteGate(async () => {
      order.push('exclusive');
      const locks = await heldWriteLocks();
      assert.deepEqual(locks, [{ mode: 'ExclusiveLock', granted: true }]);
      // Rientranza dentro l'esclusivo: la scrittura rilegge lo stato sulla connessione dell'esclusivo.
      assert.equal(await withCalendarWriteGate(async (ctx) => ctx.state.mode), 'radicale');
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(writeGateStatus().closing, true);
    // Un nuovo scrittore non entra finché l'esclusivo è in attesa o in corso.
    await expectUnavailable(withCalendarWriteGate(async () => 'no', { timeoutMs: 100 }), 'transition');
    running.resolve();
    await writer;
    await exclusive;
    assert.deepEqual(order, ['writer', 'exclusive']);
    assert.equal(await withCalendarWriteGate(async () => 'dopo'), 'dopo');
    assert.equal(writeGateStatus().closing, false);
  });

  test('esclusivo di un\'altra sessione (transizione in un altro processo) → 503 entro il timeout', async () => {
    await setState('radicale');
    const other = await sql.reserve();
    try {
      await other`SELECT pg_advisory_lock(hashtext(${CAL_LOCKS.write}))`;
      const t0 = Date.now();
      await expectUnavailable(withCalendarWriteGate(async () => 'no', { timeoutMs: 300 }), 'transition');
      assert.ok(Date.now() - t0 < 3_000, 'il gate non attende oltre il timeout');
      await other`SELECT pg_advisory_unlock(hashtext(${CAL_LOCKS.write}))`;
    } finally {
      other.release();
    }
    assert.equal(await withCalendarWriteGate(async () => 'libero'), 'libero');
  });
});
