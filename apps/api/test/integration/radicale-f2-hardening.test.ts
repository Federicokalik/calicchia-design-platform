/**
 * Correzioni della revisione F2 (area B) contro Radicale 3.7.8 reale: ogni
 * caso fallisce senza la correzione corrispondente. I casi senza Radicale
 * stanno in test/calendar/f2-hardening.test.ts.
 *
 *  - sync-01: guardia post-ripristino (scenario A del design §16.3): snapshot
 *    vecchio della collezione → cancellazioni in hold 'restore-guard' (le
 *    occorrenze continuano a bloccare), quelle fatte dall'API si applicano;
 *    "applica cancellazioni" è l'unica uscita;
 *  - sync-02: interruttore cumulativo: un client che cancella una risorsa per
 *    volta (lotti di 10 con una sync dopo ciascuno) va in hold al superamento
 *    di max(50, 20%) nella finestra di 15 minuti;
 *  - sync-03: una PUT legittima fra il REPORT e la readdir non diventa una
 *    quarantena radicale-skip;
 *  - sync-04: con il canary fallito per mtime_not_observed il mount (copia
 *    stantia) non decide nulla: 404 a due passi e identità da Radicale;
 *  - K5: un file rotto mai indicizzato va in quarantena radicale-skip alla
 *    prima sync incrementale, non solo alla sync completa o all'auditor;
 *  - health-01: una modifica segnata dopo il REPORT resta pendente, e la sync
 *    fallita dopo porta la collezione a 'unsyncable';
 *  - fresh-01: la marcatura delle modifiche nella freshness rispetta il budget
 *    anche con la riga di stato bloccata;
 *  - f2r4-05: saga "questa e le successive" con taglio e compensazione falliti
 *    → fase 'compensate', il job toglie la nuova serie;
 *  - K2: "elimina questa" ripetuta su un'istanza già esclusa è un successo
 *    idempotente (deleteEvent e eccezione con status cancelled);
 *  - K4: attesa delle sync senza interromperle (waitForSyncsIdle) e campanello
 *    vivo dopo un salto dell'ora di sistema (orologio monotono).
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo. Date fisse nel 2027.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { calSql } from '../../src/db';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { createEvent, createOccurrenceOverride, deleteEvent } from '../../src/lib/calendar/events';
import type { CalendarJob } from '../../src/lib/calendar/jobs';
import {
  collectionPath,
  createNodeTransport,
  objectPath,
  RadicaleClient,
  type RadicaleTransport,
  type TransportRequest,
  type TransportResponse,
} from '../../src/lib/calendar/radicale/client';
import { discoverCollections } from '../../src/lib/calendar/radicale/discovery';
import { verifyFreshness } from '../../src/lib/calendar/radicale/freshness';
import { listCollectionHealth, markCollectionDirty } from '../../src/lib/calendar/radicale/health';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { runRecurrenceSplitJob, splitRecurringEvent } from '../../src/lib/calendar/radicale/store';
import {
  applyHeldDeletions,
  configureRadicaleRuntime,
  expectCollectionDeletion,
  lastIdentityCheck,
  syncCollection,
  type SyncCollectionResult,
  updateWatchMode,
  waitForSyncsIdle,
} from '../../src/lib/calendar/radicale/sync';
import { getWatcherStatus, startCalendarWatcher, stopCalendarWatcher, watcherAlive } from '../../src/lib/calendar/radicale/watcher';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar } from '../../src/lib/calendar/types';
import { freezeTime, restoreTime } from '../helpers/clock';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  await stopIndexWorker();
  await resetCalendarBaseline();
});
const fx = useFixtures('rad-hard');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f2-hardening';

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ics(uid: string, opts: { start?: string; end?: string; summary?: string } = {}): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calicchia Design//Test hardening F2//IT', 'BEGIN:VEVENT',
    `UID:${uid}`, 'DTSTAMP:20261001T080000Z', `DTSTART:${opts.start ?? '20270104T080000Z'}`, `DTEND:${opts.end ?? '20270104T090000Z'}`,
    `SUMMARY:${opts.summary ?? 'Evento di prova'}`, 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

/** Ora UTC compatta di 2027-01-04T08:00Z + `hours`. */
function hourStamp(hours: number): string {
  const d = new Date(Date.UTC(2027, 0, 4, 8) + hours * 3_600_000);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > deadline) assert.fail(`timeout: ${what}`);
    await sleep(25);
  }
}

interface ObjectRow { href: string; health: string; health_reason: string | null }

async function objectsOf(calendarId: string): Promise<ObjectRow[]> {
  return sql<ObjectRow[]>`SELECT href, health, health_reason FROM cal_objects WHERE calendar_id = ${calendarId} ORDER BY href`;
}

async function stateOf(calendarId: string) {
  const [row] = await sql<Array<{ health: string; hold_reason: string | null; pending_deletions: string[]; dirty_since: Date | null; consecutive_failures: number }>>`
    SELECT health, hold_reason, pending_deletions, dirty_since, consecutive_failures FROM cal_collection_state WHERE calendar_id = ${calendarId}
  `;
  assert.ok(row, 'stato della collezione assente');
  return row;
}

async function blockingOccurrences(calendarId: string): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_occurrences WHERE calendar_id = ${calendarId} AND blocks`;
  return row.n;
}

function unfold(text: string): string {
  return text.replace(/\r\n[ \t]/g, '');
}

/**
 * Trasporto node con due ganci: `afterNextReport` gira DOPO la risposta del
 * prossimo REPORT sync-collection (prima che la sync prosegua), `intercept`
 * può rispondere al posto di Radicale, `reportDelayMs` ritarda i REPORT.
 */
interface HookedTransport {
  transport: RadicaleTransport;
  afterNextReport(fn: () => Promise<void>): void;
  intercept: ((req: TransportRequest) => TransportResponse | null) | null;
  reportDelayMs: number;
  close(): void;
}

function hookedTransport(): HookedTransport {
  const node = createNodeTransport({ maxSockets: 8 });
  let afterReport: (() => Promise<void>) | null = null;
  const hooked: HookedTransport = {
    intercept: null,
    reportDelayMs: 0,
    transport: async (req) => {
      const forced = hooked.intercept?.(req) ?? null;
      if (forced) return forced;
      const isSync = req.method === 'REPORT' && (req.body?.toString('utf8').includes('sync-collection') ?? false);
      if (isSync && hooked.reportDelayMs > 0) await sleep(hooked.reportDelayMs);
      const res = await node(req);
      if (isSync && afterReport) {
        const fn = afterReport;
        afterReport = null;
        await fn();
      }
      return res;
    },
    afterNextReport: (fn) => {
      afterReport = fn;
    },
    close: () => node.close(),
  };
  return hooked;
}

describe('correzioni F2 (area B) contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let hooked: HookedTransport;
  let client: RadicaleClient;
  let tmp: string;
  const cal: Record<string, Calendar> = {};
  const coll = (key: string): string => cal[key].slug;
  const path = (key: string, name: string): string => objectPath(P, coll(key), name);
  const put = (key: string, name: string, body: string) => svc.put(path(key, name), body, { ifNoneMatch: '*' });
  const sync = (key: string, extra: Partial<Parameters<typeof syncCollection>[1]> = {}): Promise<SyncCollectionResult> =>
    syncCollection(cal[key].id, { reason: 'manual', ...extra });

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'caldes-f2-hard-'));
    rad = await startRadicale({
      label: 'f2-hardening',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    for (const key of ['guardia', 'cumulativa', 'readdir', 'copia', 'rotta', 'sporca', 'lock', 'saga', 'k2', 'lenta']) {
      cal[key] = await fx.calendar({ key, blocks_availability: true });
    }
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    assert.ok(init.collections.every((c) => c.status === 'created'));
    hooked = hookedTransport();
    client = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0, transport: hooked.transport });
    configureRadicaleRuntime({ client, dataDir: rad.storageDir, principal: P, watch: 'auto', identitySource: 'auto' });
    updateWatchMode('mount', null);
  });

  after(async () => {
    await stopCalendarWatcher();
    overrideCalendarStore(null);
    restoreTime();
    configureRadicaleRuntime(null);
    updateWatchMode('off', 'test concluso');
    client?.close();
    hooked?.close();
    svc?.close();
    await rad?.stop();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test('sync-01: volume ripristinato da uno snapshot più vecchio durante la guardia → hold restore-guard; l\'API cancella, l\'admin decide', async () => {
    const key = 'guardia';
    for (let i = 0; i < 9; i++) await put(key, `g${i}.ics`, ics(`uid-g${i}`, { start: hourStamp(i * 2), end: hourStamp(i * 2 + 1) }));
    await sleep(60);
    await sync(key);
    const dir = rad.fsPath(P, coll(key));
    const snapshot = join(tmp, 'snapshot-guardia');
    // Come il backup dello stack: la cache di Radicale (token compresi) resta fuori.
    cpSync(dir, snapshot, { recursive: true, preserveTimestamps: true, filter: (src) => !src.split('/').includes('.Radicale.cache') });
    for (let i = 9; i < 12; i++) await put(key, `g${i}.ics`, ics(`uid-g${i}`, { start: hourStamp(i * 2), end: hourStamp(i * 2 + 1) }));
    await sleep(60);
    await sync(key);
    assert.equal((await objectsOf(cal[key].id)).length, 12);

    await sql`UPDATE calendar_backend_state SET restore_guard_until = now() + interval '48 hours' WHERE id = true`;
    try {
      rmSync(dir, { recursive: true, force: true });
      cpSync(snapshot, dir, { recursive: true, preserveTimestamps: true });
      await sleep(60);
      const held = await sync(key);
      assert.equal(held.full, true, 'token sconosciuto al volume ripristinato: listing completo');
      assert.equal(held.status, 'held');
      assert.equal(held.deleted, 0);
      const state = await stateOf(cal[key].id);
      assert.equal(state.health, 'hold');
      assert.equal(state.hold_reason, 'restore-guard');
      assert.deepEqual([...state.pending_deletions].sort(), ['g10.ics', 'g11.ics', 'g9.ics']);
      assert.equal(await blockingOccurrences(cal[key].id), 12, 'gli eventi della finestra RPO continuano a bloccare');

      // Una cancellazione fatta dall'API durante la guardia si applica (annunciata alla sync).
      expectCollectionDeletion(cal[key].id, 'g0.ics');
      await svc.delete(path(key, 'g0.ics'), { ifMatch: '*' });
      await sleep(60);
      const apiDelete = await sync(key);
      assert.equal(apiDelete.deleted, 1);
      assert.equal(apiDelete.status, 'held', 'l\'hold resta per le cancellazioni osservate');
      const [version] = await sql<Array<{ actor: string }>>`
        SELECT actor FROM cal_object_versions WHERE calendar_id = ${cal[key].id} AND href = 'g0.ics' AND change_kind = 'delete'
      `;
      assert.equal(version.actor, 'write-through:api');

      // "Applica cancellazioni": l'unica uscita.
      const applied = await applyHeldDeletions(cal[key].id, { actor: 'admin:test' });
      assert.equal(applied.deleted, 3);
      assert.equal((await stateOf(cal[key].id)).health, 'healthy');
      assert.equal((await objectsOf(cal[key].id)).length, 8);
    } finally {
      await sql`UPDATE calendar_backend_state SET restore_guard_until = NULL WHERE id = true`;
    }
  });

  test('sync-02: un client che cancella una risorsa per volta va in hold al superamento della soglia cumulativa', async () => {
    const key = 'cumulativa';
    const names = Array.from({ length: 100 }, (_, i) => `c${String(i).padStart(3, '0')}.ics`);
    for (let i = 0; i < names.length; i += 10) {
      await Promise.all(names.slice(i, i + 10).map((n, j) => put(key, n, ics(`uid-${n}`, { start: hourStamp(i + j), end: hourStamp(i + j + 1) }))));
    }
    await sleep(60);
    assert.equal((await sync(key)).upserted, 100);
    const trace: Array<[string, number]> = [];
    for (let batch = 0; batch < 6; batch++) {
      for (const n of names.slice(batch * 10, batch * 10 + 10)) await svc.delete(path(key, n), { ifMatch: '*' });
      const r = await sync(key);
      trace.push([r.status, r.deleted]);
    }
    // 5 lotti da 10 = 50 (non oltre max(50, 20%)), il sesto porta il totale a 60: hold con le sole 10 nuove.
    assert.deepEqual(trace, [['synced', 10], ['synced', 10], ['synced', 10], ['synced', 10], ['synced', 10], ['held', 0]]);
    const state = await stateOf(cal[key].id);
    assert.equal(state.hold_reason, 'mass-delete');
    assert.deepEqual([...state.pending_deletions].sort(), names.slice(50, 60));
    assert.equal((await objectsOf(cal[key].id)).length, 50);
  });

  test('sync-03: una PUT fra il REPORT e la readdir di una sync completa non è un item saltato da Radicale', async () => {
    const key = 'readdir';
    await put(key, 'a.ics', ics('uid-readdir-a'));
    await sleep(60);
    await sync(key);
    hooked.afterNextReport(async () => {
      await put(key, 'dopo-report.ics', ics('uid-dopo-report', { start: hourStamp(3), end: hourStamp(4) }));
    });
    const full = await sync(key, { full: true });
    assert.equal(full.radicaleSkipped, 0, 'nessuna quarantena radicale-skip per la PUT legittima');
    assert.ok(!(await objectsOf(cal[key].id)).some((o) => o.health_reason === 'radicale-skip'));
    await sleep(60);
    await sync(key);
    assert.deepEqual((await objectsOf(cal[key].id)).map((o) => [o.href, o.health]), [['a.ics', 'ok'], ['dopo-report.ics', 'ok']]);
  });

  test('sync-04: mount smentito dal canary (copia stantia): 404 a due passi, nessuna quarantena, identità da Radicale', async () => {
    const key = 'copia';
    await put(key, 'c1.ics', ics('uid-copia-1'));
    await put(key, 'c2.ics', ics('uid-copia-2', { start: hourStamp(2), end: hourStamp(3) }));
    await sleep(60);
    await sync(key);
    const copy = join(tmp, 'copia-storage');
    cpSync(rad.storageDir, copy, { recursive: true });
    configureRadicaleRuntime({ dataDir: copy });
    updateWatchMode('remote', 'mtime_not_observed');
    try {
      await svc.delete(path(key, 'c2.ics'), { ifMatch: '*' });
      const first = await sync(key);
      assert.equal(first.radicaleSkipped, 0, 'il file nella copia stantia non è un item saltato');
      assert.equal(first.pending404, 1);
      assert.equal(lastIdentityCheck()?.source, 'remote', 'identità letta dal volume vivo');
      const second = await sync(key);
      assert.equal(second.deleted, 1);
      assert.deepEqual((await objectsOf(cal[key].id)).map((o) => o.href), ['c1.ics']);
    } finally {
      configureRadicaleRuntime({ dataDir: rad.storageDir });
      updateWatchMode('mount', null);
    }
  });

  test('K5: un file rotto mai indicizzato va in quarantena radicale-skip alla prima sync incrementale', async () => {
    const key = 'rotta';
    await put(key, 'buono.ics', ics('uid-rotta-buono'));
    await sleep(60);
    await sync(key);
    writeFileSync(rad.fsPath(P, coll(key), 'nuovo-rotto.ics'), 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:uid-nuovo-rotto\r\nDTSTART:20270110T090000Z\r\nDTEND:20270110T100000Z\r\nGARBAGE');
    await sleep(60);
    const r = await sync(key);
    assert.equal(r.full, false, 'sync incrementale (campanello), non completa');
    assert.equal(r.radicaleSkipped, 1);
    const row = (await objectsOf(cal[key].id)).find((o) => o.href === 'nuovo-rotto.ics');
    assert.equal(row?.health, 'quarantined');
    assert.equal(row?.health_reason, 'radicale-skip');
    const [occ] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_occurrences x JOIN cal_objects o ON o.id = x.object_id
      WHERE o.calendar_id = ${cal[key].id} AND o.href = 'nuovo-rotto.ics' AND x.blocks
    `;
    assert.ok(occ.n > 0, 'blocco conservativo dal testo');
    await sleep(60);
    assert.equal((await sync(key)).radicaleSkipped, 0, 'già in quarantena: nessun nuovo controllo');
  });

  test('health-01: modifica segnata dopo il REPORT resta pendente; la sync fallita dopo porta a unsyncable', async () => {
    const key = 'sporca';
    await put(key, 'a.ics', ics('uid-sporca-a'));
    await sleep(60);
    await sync(key);
    await put(key, 'c.ics', ics('uid-sporca-c', { start: hourStamp(4), end: hourStamp(5) }));
    hooked.afterNextReport(async () => {
      await put(key, 'b.ics', ics('uid-sporca-b', { start: hourStamp(2), end: hourStamp(3) }));
      // Il campanello vede la directory cambiata mentre la sync è in volo.
      await markCollectionDirty(calSql, cal[key].id, new Date());
    });
    await sleep(60);
    await sync(key);
    assert.ok((await stateOf(cal[key].id)).dirty_since, 'la modifica arrivata dopo il REPORT resta pendente');

    const dead = new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: SVC_PASSWORD, retries: 0, timeoutMs: 500 });
    configureRadicaleRuntime({ client: dead });
    try {
      await assert.rejects(sync(key));
    } finally {
      configureRadicaleRuntime({ client });
      dead.close();
    }
    const [view] = await listCollectionHealth(sql, { calendarIds: [cal[key].id] });
    assert.equal(view.health, 'unsyncable', 'fallimento con modifiche pendenti');
    await sleep(60);
    await sync(key);
    assert.equal((await stateOf(cal[key].id)).consecutive_failures, 0);
  });

  test('fresh-01: con la riga di stato bloccata la freshness risponde entro il budget', async () => {
    const key = 'lock';
    await put(key, 'x.ics', ics('uid-lock-x'));
    await sleep(60);
    await sync(key);
    await discoverCollections();
    await put(key, 'y.ics', ics('uid-lock-y', { start: hourStamp(2), end: hourStamp(3) }));
    const conn = await calSql.reserve();
    await conn`BEGIN`;
    await conn`SELECT 1 FROM cal_collection_state WHERE calendar_id = ${cal[key].id} FOR UPDATE`;
    const released = sleep(4_000).then(async () => {
      await conn`ROLLBACK`;
      conn.release();
    });
    overrideCalendarStore('radicale');
    try {
      const started = performance.now();
      await assert.rejects(
        verifyFreshness({ db: sql, budgetMs: 500 }),
        (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'freshness_timeout',
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 2_000, `freshness oltre il budget: ${Math.round(elapsed)} ms`);
    } finally {
      overrideCalendarStore(null);
      await released;
    }
    await waitForSyncsIdle(30_000);
  });

  test('f2r4-05: taglio e compensazione falliti → fase compensate; il job toglie la nuova serie', async () => {
    overrideCalendarStore('radicale');
    try {
      const master = await createEvent({
        calendar_id: cal.saga.id, summary: 'Serie saga', start_time: '2027-06-07T08:00:00Z', end_time: '2027-06-07T09:00:00Z',
        rrule: 'FREQ=DAILY;COUNT=10',
      });
      const masterPath = objectPath(P, cal.saga.slug, `${master.uid}.ics`);
      const collectionPrefix = collectionPath(P, cal.saga.slug);
      const before = await svc.get(masterPath);
      hooked.intercept = (req) => {
        // (b) PUT del vecchio master rifiutata in modo definitivo, DELETE compensativa in errore.
        if (req.method === 'PUT' && req.url.pathname === masterPath) return { status: 403, headers: {}, body: '' };
        if (req.method === 'DELETE' && req.url.pathname.startsWith(collectionPrefix)) return { status: 500, headers: {}, body: '' };
        return null;
      };
      try {
        await assert.rejects(splitRecurringEvent({ masterEventId: master.id, originalStartIso: '2027-06-10T08:00:00.000Z', changes: { summary: 'Coda' } }));
      } finally {
        hooked.intercept = null;
      }
      const [job] = await sql<Array<{ id: string; payload: Record<string, unknown> }>>`
        SELECT id::text AS id, payload FROM cal_jobs WHERE kind = 'recurrence_split' AND key = ${master.uid} AND status = 'pending'
      `;
      assert.equal(job.payload.phase, 'compensate', 'mai "done" con la nuova serie ancora presente');
      assert.ok(job.payload.tailEtag);
      const tailPath = objectPath(P, cal.saga.slug, String(job.payload.newHref));
      assert.ok((await svc.get(tailPath)).body.includes('Coda'), 'la nuova serie è rimasta su Radicale');

      const res = await runRecurrenceSplitJob({ id: job.id, kind: 'recurrence_split', key: master.uid, payload: job.payload } as CalendarJob);
      assert.deepEqual(res, { result: 'compensated' });
      await assert.rejects(svc.get(tailPath), (err: unknown) => (err as { code?: string }).code === 'not_found');
      assert.equal((await svc.get(masterPath)).etag, before.etag, 'serie originale intatta');
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('K2: "elimina questa" ripetuta su un\'istanza già esclusa è un successo idempotente', async () => {
    overrideCalendarStore('radicale');
    try {
      const master = await createEvent({
        calendar_id: cal.k2.id, summary: 'Serie K2', start_time: '2027-07-05T08:00:00Z', end_time: '2027-07-05T09:00:00Z',
        rrule: 'FREQ=DAILY;COUNT=5',
      });
      const override = await createOccurrenceOverride({ masterEventId: master.id, originalStartIso: '2027-07-06T08:00:00.000Z', newSummary: 'Spostata' });
      // Un device (o un "elimina questa" concorrente) ha già escluso l'istanza: override tolto, EXDATE aggiunta; indice non ancora sincronizzato.
      const p = objectPath(P, cal.k2.slug, `${master.uid}.ics`);
      const cur = await svc.get(p);
      const text = unfold(cur.body);
      const rid = /^RECURRENCE-ID([^:\r\n]*):([^\r\n]+)$/m.exec(text);
      assert.ok(rid, 'override presente nella risorsa');
      const excluded = text
        .replace(/BEGIN:VEVENT\r\n(?:(?!END:VEVENT)[\s\S])*?RECURRENCE-ID[\s\S]*?END:VEVENT\r\n/, '')
        .replace(/^(RRULE:[^\r\n]*)\r\n/m, `$1\r\nEXDATE${rid[1]}:${rid[2]}\r\n`);
      assert.doesNotMatch(excluded, /RECURRENCE-ID/);
      await svc.put(p, excluded, { ifMatch: cur.etag as string });

      assert.equal(await deleteEvent(override.id), true, 'nessun 409 RECURRENCE_TARGET_GONE');
      const etag = (await svc.get(p)).etag;
      const cancelled = await createOccurrenceOverride({ masterEventId: master.id, originalStartIso: '2027-07-06T08:00:00.000Z', status: 'cancelled' });
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.recurrence_id, '2027-07-06T08:00:00.000Z');
      assert.equal(cancelled.recurrence_master_id, master.id);
      assert.equal((await svc.get(p)).etag, etag, 'nessuna scrittura: lo stato voluto c\'era già');
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('K4: attesa delle sync senza interromperle; la prima sync lenta completa lo stato e l\'orizzonte', async () => {
    const key = 'lenta';
    await put(key, 'l.ics', ics('uid-lenta'));
    hooked.reportDelayMs = 6_000;
    try {
      const running = syncCollection(cal[key].id, { reason: 'watcher' });
      await sleep(100);
      assert.equal(await waitForSyncsIdle(30_000), true);
      const r = await running;
      assert.equal(r.status, 'synced');
    } finally {
      hooked.reportDelayMs = 0;
    }
    const [st] = await sql<Array<{ horizon_end: Date | null; sync_token: string | null }>>`
      SELECT horizon_end, sync_token FROM cal_collection_state WHERE calendar_id = ${cal[key].id}
    `;
    assert.ok(st.horizon_end, 'prima sync completata: orizzonte materializzato');
    assert.ok(st.sync_token);
  });

  test('K4: il campanello resta vivo dopo un salto in avanti dell\'ora di sistema (orologio monotono)', async () => {
    await startCalendarWatcher({ intervalMs: 60_000 });
    try {
      await waitFor('primo giro del campanello', async () => getWatcherStatus().lastTickAt !== null);
      freezeTime(new Date(Date.now() + 2 * 86_400_000).toISOString());
      assert.equal(watcherAlive(), true, 'l\'ora di sistema avanzata di due giorni non ferma il livello display');
    } finally {
      restoreTime();
      await stopCalendarWatcher();
      updateWatchMode('mount', null);
    }
  });
});
