/**
 * Moduli SYNC della F2 senza Radicale (radicale/{sync,watcher,canary,
 * discovery,freshness}.ts; contratto dei moduli f2-modules.md §1.6 e §4).
 *
 * L'API deve partire e restare corretta con Radicale non configurato o
 * irraggiungibile: componenti spenti e dichiarati, nessuna creazione
 * implicita, nessuna operazione sull'indice con l'identità del volume diversa
 * da `ok`, e in mode postgres nessun effetto sulle decisioni. L'identità si
 * legge da un "mount" finto (cartella temporanea con `.Radicale.props` del
 * principal); il client punta a una porta chiusa, così ogni richiesta HTTP
 * fallisce e si vede.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { onBeforeDatabaseClose, onDatabaseReady, resetCalendarBaseline, sql } from '../helpers/db';
import { withEnv } from '../helpers/env';
import { useFixtures } from '../helpers/fixtures';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar } from '../../src/lib/calendar/types';
import { lastCanaryResult, runCanary } from '../../src/lib/calendar/radicale/canary';
import { RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { deriveSlug, discoverCollections, normalizeColor } from '../../src/lib/calendar/radicale/discovery';
import { assertDisplayReady, decisionFreshnessSet, verifyFreshness } from '../../src/lib/calendar/radicale/freshness';
import type { Db } from '../../src/lib/calendar/radicale/policy';
import {
  acceptedFsTypes,
  CollectionSyncError,
  configureRadicaleRuntime,
  currentWatchMode,
  describeFsType,
  inFlightSyncs,
  invalidateIdentityCache,
  onSyncSettled,
  type SyncSettledEvent,
  syncCollection,
  updateWatchMode,
  verifyVolumeIdentity,
} from '../../src/lib/calendar/radicale/sync';
import { DEAD_PROP } from '../../src/lib/calendar/radicale/types';
import { getWatcherStatus, setWatchMode, startCalendarWatcher, stopCalendarWatcher } from '../../src/lib/calendar/radicale/watcher';

const fx = useFixtures('sync-runtime', { resetBaseline: true });
onBeforeDatabaseClose(() => resetCalendarBaseline());
const cal: Record<string, Calendar> = {};
const VOLUME = randomUUID();
const mount = mkdtempSync(join(tmpdir(), 'caldes-sync-runtime-'));

/** Client verso una porta chiusa: ogni richiesta fallisce con ECONNREFUSED. */
const deadClient = new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0, timeoutMs: 300 });

function writeMarker(volumeId: string, epoch: number): void {
  const dir = join(mount, 'collection-root', 'federico');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.Radicale.props'), JSON.stringify({ [DEAD_PROP.volumeId]: volumeId, [DEAD_PROP.epoch]: String(epoch) }));
  invalidateIdentityCache();
}

function inTx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
  return sql.begin((tx: any) => fn(tx)) as Promise<T>;
}

onDatabaseReady(async () => {
  cal.a = await fx.calendar({ key: 'a', blocks_availability: true });
  cal.libero = await fx.calendar({ key: 'libero', blocks_availability: false });
  cal.sub = await fx.calendar({ key: 'sub', blocks_availability: true });
  await sql`UPDATE calendars SET role = 'subscription' WHERE id = ${cal.sub.id}`;
  await sql`UPDATE calendar_backend_state SET volume_id = ${VOLUME}, epoch = 1 WHERE id = true`;
});

after(() => {
  overrideCalendarStore(null);
  configureRadicaleRuntime(null);
  updateWatchMode('off', 'test concluso');
  deadClient.close();
  rmSync(mount, { recursive: true, force: true });
});

test('statfs: filesystem locali ammessi e sostituzione solo con CALDES_WATCH_FS_TYPES', () => {
  assert.deepEqual([...acceptedFsTypes({})].sort(), [0xef53, 0x58465342, 0x9123683e].sort());
  assert.deepEqual([...acceptedFsTypes({ CALDES_WATCH_FS_TYPES: 'tmpfs, 0x9123683e, sconosciuto' })].sort(), [0x01021994, 0x9123683e].sort());
  assert.equal(describeFsType(0xef53), 'ext4 (0xef53)');
  assert.equal(describeFsType(0x6969), 'nfs (0x6969)');
});

test('discovery: colori Apple normalizzati e slug derivati univoci', () => {
  assert.equal(normalizeColor('#FF2968FF'), '#ff2968');
  assert.equal(normalizeColor('#1A2B3C'), '#1a2b3c');
  assert.equal(normalizeColor('#abc'), null);
  assert.equal(normalizeColor(null), null);
  assert.equal(deriveSlug('Lavoro Già', new Set()), 'lavoro-gia');
  assert.equal(deriveSlug('Lavoro Già', new Set(['lavoro-gia', 'lavoro-gia-2'])), 'lavoro-gia-3');
  assert.equal(deriveSlug('---', new Set()), 'dispositivo');
  assert.match(deriveSlug('x'.repeat(200), new Set()), /^x{60}$/);
});

test('Radicale non configurato: sync, discovery, watcher e canary spenti e dichiarati; nessun errore all\'avvio', async () => {
  configureRadicaleRuntime({ client: null, dataDir: mount });
  await assert.rejects(syncCollection(cal.a.id, { reason: 'manual' }), (err: unknown) => err instanceof CollectionSyncError && err.code === 'not_configured');
  await assert.rejects(discoverCollections(), (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'radicale_unreachable');

  await startCalendarWatcher();
  const status = getWatcherStatus();
  assert.equal(status.running, false);
  assert.equal(status.mode, 'off');
  assert.ok(status.reason);
  await stopCalendarWatcher();

  const canary = await runCanary();
  assert.equal(canary.reason, 'not_configured');
  assert.equal(canary.mode, 'off');
  assert.equal(lastCanaryResult(), canary);
  assert.equal(currentWatchMode().mode, 'off');
});

test('syncCollection: id non valido o calendario inesistente → collection_missing; iscrizione → skipped senza richieste', async () => {
  configureRadicaleRuntime({ client: deadClient, dataDir: mount });
  writeMarker(VOLUME, 1);
  await assert.rejects(syncCollection('non-un-uuid', { reason: 'manual' }), (err: unknown) => err instanceof CollectionSyncError && err.code === 'collection_missing');
  await assert.rejects(syncCollection(randomUUID(), { reason: 'manual' }), (err: unknown) => err instanceof CollectionSyncError && err.code === 'collection_missing');
  const skipped = await syncCollection(cal.sub.id, { reason: 'manual' });
  assert.equal(skipped.status, 'skipped', 'la fonte delle iscrizioni è il feed remoto');
  assert.deepEqual(inFlightSyncs(), []);
});

test('identità diversa dal mount: sync ferma prima di qualsiasi richiesta, indice e salute invariati', async () => {
  configureRadicaleRuntime({ client: deadClient, dataDir: mount });
  writeMarker(randomUUID(), 1);
  const { check } = await verifyVolumeIdentity();
  assert.equal(check.status, 'mismatch');
  assert.equal(check.source, 'file');
  await assert.rejects(syncCollection(cal.a.id, { reason: 'manual' }), (err: unknown) => err instanceof CollectionSyncError && err.code === 'identity');
  const states = await sql`SELECT 1 FROM cal_collection_state WHERE calendar_id = ${cal.a.id}`;
  assert.equal(states.length, 0, 'nessuna scrittura sull\'indice né sulla salute');

  // Epoch diverso (snapshot di prima di un cutover): ancora mismatch.
  writeMarker(VOLUME, 2);
  assert.equal((await verifyVolumeIdentity()).check.status, 'mismatch');
});

test('identità ok e Radicale irraggiungibile: guasto del canale registrato (unsyncable con dir_mtime_ns NULL)', async () => {
  configureRadicaleRuntime({ client: deadClient, dataDir: mount });
  writeMarker(VOLUME, 1);
  updateWatchMode('remote', 'test');
  await assert.rejects(syncCollection(cal.a.id, { reason: 'manual' }), (err: unknown) => err instanceof CollectionSyncError && err.code === 'radicale');
  const [state] = await sql<Array<{ health: string; consecutive_failures: number; dirty_since: Date | null }>>`
    SELECT health, consecutive_failures, dirty_since FROM cal_collection_state WHERE calendar_id = ${cal.a.id}
  `;
  assert.equal(state.consecutive_failures, 1);
  assert.equal(state.health, 'unsyncable', 'senza una dir_mtime_ns verificata non si può escludere che ci siano modifiche pendenti');
  assert.ok(state.dirty_since);
});

test('freshness: set di decisione, no-op in mode postgres, 503 senza Radicale e con identità diversa', async () => {
  const set = await decisionFreshnessSet(sql);
  assert.ok(set.calendarIds.includes(cal.a.id));
  assert.ok(!set.calendarIds.includes(cal.libero.id), 'collezioni non bloccanti fuori dal set');
  assert.ok(!set.calendarIds.includes(cal.sub.id), 'iscrizioni mai nel set di freschezza');
  const [bookings] = await sql<Array<{ id: string }>>`SELECT id FROM calendars WHERE slug = 'bookings'`;
  assert.ok(set.calendarIds.includes(bookings.id));

  // Mode postgres: le decisioni usano il busy legacy, la freshness non fa nulla (nemmeno con Radicale giù).
  configureRadicaleRuntime({ client: deadClient, dataDir: mount });
  const legacy = await inTx((tx) => verifyFreshness({ db: tx }));
  assert.deepEqual({ mode: legacy.mode, checked: legacy.checked, synced: legacy.synced }, { mode: 'off', checked: 0, synced: [] });
  await assertDisplayReady(sql);

  overrideCalendarStore('radicale');
  try {
    configureRadicaleRuntime({ client: null, dataDir: mount });
    await assert.rejects(inTx((tx) => verifyFreshness({ db: tx })), (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'radicale_unreachable');

    configureRadicaleRuntime({ client: deadClient, dataDir: mount });
    writeMarker(randomUUID(), 1);
    await assert.rejects(inTx((tx) => verifyFreshness({ db: tx })), (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'identity_mismatch' && err.status === 503);

    // Livello display: senza campanello vivo → 503 (mai un busy calcolato su un indice non sorvegliato).
    writeMarker(VOLUME, 1);
    await assert.rejects(assertDisplayReady(sql), (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'watcher_down');
  } finally {
    overrideCalendarStore(null);
  }
});

test('canary: mount assente, filesystem non locale e identità non ok', async () => {
  configureRadicaleRuntime({ client: deadClient, dataDir: join(mount, 'non-esiste'), watch: 'auto' });
  updateWatchMode('mount', null);
  const missing = await runCanary();
  assert.equal(missing.reason, 'mount_missing');
  assert.equal(currentWatchMode().mode, 'remote');
  assert.equal(currentWatchMode().reason, 'mount_missing');

  configureRadicaleRuntime({ dataDir: mount });
  const notLocal = await withEnv({ CALDES_WATCH_FS_TYPES: 'xfs' }, () => runCanary());
  assert.equal(notLocal.reason, 'fs_not_local');
  assert.equal(notLocal.fsLocal, false);
  assert.ok(notLocal.fsType);

  // Identità diversa: nessuna scrittura sul volume; la modalità non cambia (il watcher è già in pausa).
  writeMarker(randomUUID(), 1);
  updateWatchMode('remote', 'prima');
  const identity = await runCanary();
  assert.equal(identity.reason, 'identity_not_ok');
  assert.deepEqual({ mode: currentWatchMode().mode, reason: currentWatchMode().reason }, { mode: 'remote', reason: 'prima' });

  // Identità ok ma Radicale irraggiungibile: _canary non verificabile → remote.
  writeMarker(VOLUME, 1);
  const unreachable = await runCanary();
  assert.equal(unreachable.reason, 'radicale_unreachable');
  assert.equal(currentWatchMode().mode, 'remote');
});

test('watcher sul mount: collezione sparita e Radicale fermo → la sync fallita si ripete con la pausa crescente; il ciclo non lancia', async () => {
  configureRadicaleRuntime({ client: deadClient, dataDir: mount, watch: 'auto' });
  writeMarker(VOLUME, 1);
  // Il mount finto ha il principal ma non le directory delle collezioni: per il campanello sono sparite.
  updateWatchMode('mount', null);
  const events: Array<SyncSettledEvent & { at: number }> = [];
  const unsubscribe = onSyncSettled((e) => {
    if (e.calendarId === cal.a.id) events.push({ ...e, at: Date.now() });
  });
  try {
    await startCalendarWatcher({ intervalMs: 50 });
    const deadline = Date.now() + 5_000;
    while (events.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok(events.length >= 2, `tentativi visti: ${events.length}`);
    assert.ok(events.every((e) => e.error?.code === 'radicale' && e.result === null));
    assert.ok(events[1].at - events[0].at >= 800, `pausa fra i tentativi (${events[1].at - events[0].at} ms), non un tentativo a ogni giro da 50 ms`);
    const status = getWatcherStatus();
    assert.equal(status.running, true);
    assert.equal(status.mode, 'mount');
    assert.equal(status.consecutiveErrors, 0, 'i guasti delle sync non sono errori del ciclo');
    assert.ok(status.collections.some((c) => c.calendarId === cal.a.id && c.dirMtimeNs === null));
    assert.ok(!status.collections.some((c) => c.calendarId === cal.sub.id), 'le iscrizioni non si sorvegliano');
  } finally {
    unsubscribe();
    await stopCalendarWatcher();
  }
  assert.equal(getWatcherStatus().running, false);
  assert.equal(currentWatchMode().mode, 'off');
});

test('modalità: CALDES_WATCH=remote impedisce il mount, CALDES_WATCH=off spegne tutto', async () => {
  configureRadicaleRuntime({ client: deadClient, dataDir: mount, watch: 'remote' });
  setWatchMode('mount', null);
  assert.deepEqual({ mode: currentWatchMode().mode, reason: currentWatchMode().reason }, { mode: 'remote', reason: 'CALDES_WATCH=remote' });

  configureRadicaleRuntime({ watch: 'off' });
  setWatchMode('mount', null);
  assert.equal(currentWatchMode().mode, 'off');
  await startCalendarWatcher();
  assert.equal(getWatcherStatus().running, false);
  configureRadicaleRuntime({ watch: 'auto' });
});
