/**
 * Moduli SYNC della F2 contro Radicale 3.7.8 reale (piano F2, "Test": Sync;
 * contratto dei moduli docs/calendar-radicale/contracts/f2-modules.md §4 e
 * §11; design §6.1-§6.3, §6.5, §9).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea, auth
 * htpasswd con il solo caldes-svc e rights from_file con la matrice di
 * caldes-svc del contratto control-plane §8 (R sulla root, RW sul principal,
 * rwD sulle collezioni). Il volume si inizializza con initializeVolume() di F1
 * (principal, marker, collezioni del sidecar e _canary della F2); il runtime
 * della sync punta allo storage come a RADICALE_DATA_DIR (il "mount").
 *
 * Casi: prima sync e seconda invariata; single-flight e sync accodata; CAS sul
 * token; token scaduto → full resync; 60% degli item spariti → hold con busy
 * invariato e "applica cancellazioni"; collezione svuotata → hold; item rotto
 * (skip_broken_item) → quarantena radicale-skip; remote mode con 404 confermati
 * due volte; collezione sparita → hold; MOVE → stesso id; discovery in mode
 * postgres (nessuna riga) e radicale (riga device, adozione, dead prop non
 * fidate); canary (ok, fs non locale, mount fermo, _canary assente → remote
 * mode); freshness (Radicale fermo senza modifiche → ok, con directory
 * cambiata → 503, principal cambiato → discovery); lag scrittura → indice col
 * watcher; lock occupato; identità diversa → sync ferma, 503 e policy frozen.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo. Date fisse nel 2027.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { withEnv } from '../helpers/env';
import { useFixtures } from '../helpers/fixtures';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { CalendarUnavailableError } from '../../src/lib/calendar/errors';
import { CAL_LOCKS } from '../../src/lib/calendar/index-model';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar } from '../../src/lib/calendar/types';
import { runCanary } from '../../src/lib/calendar/radicale/canary';
import { collectionPath, createNodeTransport, objectPath, RadicaleClient, type RadicaleTransport } from '../../src/lib/calendar/radicale/client';
import { DAV_PROPS } from '../../src/lib/calendar/radicale/dav-xml';
import { discoverCollections } from '../../src/lib/calendar/radicale/discovery';
import { assertDisplayReady, verifyFreshness } from '../../src/lib/calendar/radicale/freshness';
import { initializeVolume, writeVolumeMarker } from '../../src/lib/calendar/radicale/identity';
import { type Db, readBackendState } from '../../src/lib/calendar/radicale/policy';
import {
  applyHeldDeletions,
  CollectionSyncError,
  configureRadicaleRuntime,
  currentWatchMode,
  invalidateIdentityCache,
  lastIdentityCheck,
  syncAllCollections,
  syncCollection,
  type SyncCollectionResult,
  updateWatchMode,
} from '../../src/lib/calendar/radicale/sync';
import { CANARY_COLLECTION, expectedRadicaleRights, policyFromState } from '../../src/lib/calendar/radicale/types';
import { getWatcherStatus, startCalendarWatcher, statCollectionDir, stopCalendarWatcher } from '../../src/lib/calendar/radicale/watcher';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(() => resetCalendarBaseline());
const fx = useFixtures('sync-rad');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f2-sync';

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Evento timed in UTC in un VCALENDAR minimo (CRLF). */
function ics(uid: string, opts: { start?: string; end?: string; summary?: string; extra?: string[] } = {}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Calicchia Design//Test sync F2//IT',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T080000Z',
    `DTSTART:${opts.start ?? '20270104T080000Z'}`,
    `DTEND:${opts.end ?? '20270104T090000Z'}`,
    `SUMMARY:${opts.summary ?? 'Evento di prova'}`,
    ...(opts.extra ?? []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** Ora UTC compatta di `base` + `hours` (per eventi distinti). */
function hourStamp(hours: number): string {
  const d = new Date(Date.UTC(2027, 0, 4, 8) + hours * 3_600_000);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000, stepMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > deadline) assert.fail(`timeout: ${what}`);
    await sleep(stepMs);
  }
}

interface ObjectRow { id: string; href: string; etag: string | null; health: string; health_reason: string | null; pending_404_count: number }

async function objectsOf(calendarId: string): Promise<ObjectRow[]> {
  return sql<ObjectRow[]>`
    SELECT id, href, etag, health, health_reason, pending_404_count FROM cal_objects
    WHERE calendar_id = ${calendarId} ORDER BY href
  `;
}

interface StateRow { health: string; hold_reason: string | null; pending_deletions: string[]; consecutive_failures: number; dirty_since: Date | null; dir_mtime_ns: string | null; sync_token: string | null }

async function stateOf(calendarId: string): Promise<StateRow> {
  const [row] = await sql<StateRow[]>`
    SELECT health, hold_reason, pending_deletions, consecutive_failures, dirty_since, dir_mtime_ns::text AS dir_mtime_ns, sync_token
    FROM cal_collection_state WHERE calendar_id = ${calendarId}
  `;
  assert.ok(row, `stato della collezione ${calendarId} assente`);
  return row;
}

async function blockingOccurrences(calendarId: string): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_occurrences WHERE calendar_id = ${calendarId} AND blocks`;
  return row.n;
}

/** Trasporto node con un contatore delle REPORT sync-collection e un hook sulla prossima. */
function countingTransport(): { transport: RadicaleTransport; reports: () => number; requests: () => number; onNextReport: (fn: () => Promise<void>) => void; close(): void } {
  const node = createNodeTransport({ maxSockets: 4 });
  let reports = 0;
  let requests = 0;
  let hook: (() => Promise<void>) | null = null;
  const transport: RadicaleTransport = async (req) => {
    requests++;
    if (req.method === 'REPORT' && req.body?.toString('utf8').includes('sync-collection')) {
      reports++;
      const h = hook;
      hook = null;
      if (h) await h();
    }
    return node(req);
  };
  return { transport, reports: () => reports, requests: () => requests, onNextReport: (fn) => { hook = fn; }, close: () => node.close() };
}

describe('moduli SYNC contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  const cal: Record<string, Calendar> = {};
  const coll = (key: string): string => cal[key].slug;
  const path = (key: string, name: string): string => objectPath(P, coll(key), name);
  const put = (key: string, name: string, body: string) => svc.put(path(key, name), body, { ifNoneMatch: '*' });
  const sync = (key: string, extra: Partial<Parameters<typeof syncCollection>[1]> = {}): Promise<SyncCollectionResult> =>
    syncCollection(cal[key].id, { reason: 'manual', ...extra });

  /** Sincronizza tutto finché ogni collezione ha la dir_mtime_ns della directory (nessuna modifica pendente). */
  async function settleAll(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      await sleep(60); // fuori dalla finestra racy di 50 ms
      const results = await syncAllCollections({ reason: 'manual' });
      for (const r of results) if (r instanceof Error) throw r;
      let settled = true;
      for (const r of results as SyncCollectionResult[]) {
        const [row] = await sql<Array<{ collection_name: string }>>`SELECT collection_name FROM calendars WHERE id = ${r.calendarId}`;
        const m = await statCollectionDir(row.collection_name);
        if (m === null || r.dirMtimeNs !== m.toString()) settled = false;
      }
      if (settled) break;
    }
    await discoverCollections();
  }

  before(async () => {
    rad = await startRadicale({
      label: 'f2-sync',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    for (const key of ['a', 'b', 'massa', 'piccola', 'rotta', 'remota', 'sparita', 'fresca']) {
      cal[key] = await fx.calendar({ key, blocks_availability: true });
    }
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    assert.equal(init.canary, 'created', 'l\'inizializzazione esplicita crea _canary');
    assert.ok(init.collections.every((c) => c.status === 'created'));
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'auto', identitySource: 'auto' });
    updateWatchMode('mount', null);
  });

  after(async () => {
    await stopCalendarWatcher();
    overrideCalendarStore(null);
    configureRadicaleRuntime(null);
    updateWatchMode('off', 'test concluso');
    svc?.close();
    await rad?.stop();
  });

  test('prima sync: oggetti e id nell\'indice, dir_mtime_ns salvata; la seconda sync è invariata', async () => {
    await put('a', 'e1.ics', ics('uid-e1'));
    await put('a', 'e2.ics', ics('uid-e2', { start: hourStamp(2), end: hourStamp(3) }));
    await sleep(60);
    const first = await sync('a');
    assert.equal(first.status, 'synced');
    assert.equal(first.full, true, 'senza token la prima sync è un listing completo');
    assert.equal(first.upserted, 2);
    assert.ok(first.syncToken);
    const objects = await objectsOf(cal.a.id);
    assert.deepEqual(objects.map((o) => [o.href, o.health]), [['e1.ics', 'ok'], ['e2.ics', 'ok']]);
    const ids = await sql<Array<{ id: string; href: string; retired_at: Date | null }>>`
      SELECT id, href, retired_at FROM cal_object_ids WHERE calendar_id = ${cal.a.id} AND recurrence_key = '' ORDER BY href
    `;
    assert.deepEqual(ids.map((r) => [r.id, r.href, r.retired_at]), objects.map((o) => [o.id, o.href, null]));
    assert.equal((await stateOf(cal.a.id)).health, 'healthy');

    await sleep(60);
    const second = await sync('a');
    assert.equal(second.status, 'unchanged');
    assert.equal(second.full, false);
    assert.equal(second.upserted, 0);
    assert.equal(second.indexVersion, first.indexVersion, 'nessun cambiamento: index_version invariata');
    const m = await statCollectionDir(coll('a'));
    assert.equal(second.dirMtimeNs, m?.toString(), 'dir_mtime_ns = mtime della directory osservata prima del REPORT');
    assert.equal((await stateOf(cal.a.id)).dir_mtime_ns, m?.toString());
  });

  test('single-flight: chi arriva prima del REPORT si unisce, chi arriva dopo riceve una sync successiva', async () => {
    const counting = countingTransport();
    const client = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0, transport: counting.transport });
    configureRadicaleRuntime({ client });
    try {
      await put('a', 'sf1.ics', ics('uid-sf1', { start: hourStamp(5), end: hourStamp(6) }));
      const [x, y] = await Promise.all([sync('a'), sync('a')]);
      assert.equal(x, y, 'stessa sync, stesso esito');
      assert.equal(counting.reports(), 1);

      // Una richiesta arrivata durante il REPORT accoda UNA sync successiva, condivisa.
      let late: Array<Promise<SyncCollectionResult>> = [];
      counting.onNextReport(async () => {
        late = [sync('a'), sync('a')];
      });
      await put('a', 'sf2.ics', ics('uid-sf2', { start: hourStamp(7), end: hourStamp(8) }));
      const first = await sync('a');
      const [l1, l2] = await Promise.all(late);
      assert.notEqual(first, l1, 'la richiesta arrivata dopo il REPORT non riceve l\'esito di quella sync');
      assert.equal(l1, l2, 'le richieste arrivate durante il REPORT condividono la sync successiva');
      assert.equal(counting.reports(), 3);
    } finally {
      configureRadicaleRuntime({ client: svc });
      client.close();
      counting.close();
    }
  });

  test('CAS: sync-token cambiato durante la sync → si riparte dal REPORT (e qui token sconosciuto → full)', async () => {
    const counting = countingTransport();
    const client = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0, transport: counting.transport });
    configureRadicaleRuntime({ client });
    try {
      await sync('b');
      await put('b', 'cas.ics', ics('uid-cas'));
      counting.onNextReport(async () => {
        await sql`UPDATE cal_collection_state SET sync_token = 'http://radicale.org/ns/sync/caldes-test-cas' WHERE calendar_id = ${cal.b.id}`;
      });
      const r = await sync('b');
      assert.equal(r.status, 'synced');
      assert.equal(r.full, true, 'il token cambiato è sconosciuto a Radicale: full resync al secondo tentativo');
      assert.equal(counting.reports(), 1 + 3, 'prima sync, tentativo fallito sul CAS, token rifiutato, listing completo');
      assert.deepEqual((await objectsOf(cal.b.id)).map((o) => o.href), ['cas.ics']);
      assert.notEqual((await stateOf(cal.b.id)).sync_token, 'http://radicale.org/ns/sync/caldes-test-cas');
    } finally {
      configureRadicaleRuntime({ client: svc });
      client.close();
      counting.close();
    }
  });

  test('token scaduto (403 valid-sync-token) → full resync con diff: nuovi e cancellati applicati', async () => {
    await put('b', 'x1.ics', ics('uid-x1', { start: hourStamp(1), end: hourStamp(2) }));
    const x2 = await put('b', 'x2.ics', ics('uid-x2', { start: hourStamp(3), end: hourStamp(4) }));
    await put('b', 'x3.ics', ics('uid-x3', { start: hourStamp(5), end: hourStamp(6) }));
    await sync('b');
    await svc.delete(path('b', 'x2.ics'), { ifMatch: x2.etag as string });
    await put('b', 'x4.ics', ics('uid-x4', { start: hourStamp(7), end: hourStamp(8) }));
    // Radicale scarta i token più vecchi di max_sync_token_age togliendo i loro file dalla cache: si simula la scadenza.
    const tokens = join(rad.fsPath(P, coll('b')), '.Radicale.cache', 'sync-token');
    for (const f of readdirSync(tokens)) rmSync(join(tokens, f), { force: true, recursive: true });

    const r = await sync('b');
    assert.equal(r.full, true);
    assert.equal(r.upserted, 1, 'solo x4 è nuovo: gli invariati non si riscaricano');
    assert.equal(r.deleted, 1);
    assert.deepEqual((await objectsOf(cal.b.id)).map((o) => o.href), ['cas.ics', 'x1.ics', 'x3.ics', 'x4.ics']);
  });

  test('interruttore: 60% degli item spariti → hold, busy invariato; "applica cancellazioni" li toglie', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `m${String(i).padStart(3, '0')}.ics`);
    for (let i = 0; i < names.length; i += 10) {
      await Promise.all(names.slice(i, i + 10).map((n, j) => put('massa', n, ics(`uid-${n}`, { start: hourStamp(i + j), end: hourStamp(i + j + 1) }))));
    }
    const initial = await sync('massa');
    assert.equal(initial.upserted, 100);
    const busyBefore = await blockingOccurrences(cal.massa.id);
    assert.equal(busyBefore, 100);

    const gone = names.slice(0, 60);
    for (let i = 0; i < gone.length; i += 10) {
      await Promise.all(gone.slice(i, i + 10).map((n) => svc.delete(path('massa', n), { ifMatch: '*' })));
    }
    const held = await sync('massa');
    assert.equal(held.status, 'held');
    assert.equal(held.deleted, 0);
    const state = await stateOf(cal.massa.id);
    assert.equal(state.health, 'hold');
    assert.equal(state.hold_reason, 'mass-delete');
    assert.deepEqual([...state.pending_deletions].sort(), gone);
    assert.equal((await objectsOf(cal.massa.id)).length, 100, 'nessuna cancellazione applicata');
    assert.equal(await blockingOccurrences(cal.massa.id), busyBefore, 'busy invariato: le occorrenze continuano a bloccare');

    // Le sync successive restano in hold finché l'admin non sceglie.
    await put('massa', 'nuovo.ics', ics('uid-massa-nuovo', { start: hourStamp(200), end: hourStamp(201) }));
    const again = await sync('massa');
    assert.equal(again.status, 'held');
    assert.equal(again.upserted, 1, 'gli upsert si applicano anche in hold (contratto §13 precisazione 3)');
    assert.equal((await stateOf(cal.massa.id)).pending_deletions.length, 60);

    const applied = await applyHeldDeletions(cal.massa.id, { actor: 'admin:test' });
    assert.equal(applied.deleted, 60);
    assert.notEqual(applied.status, 'held');
    const after = await stateOf(cal.massa.id);
    assert.equal(after.health, 'healthy');
    assert.deepEqual(after.pending_deletions, []);
    assert.equal((await objectsOf(cal.massa.id)).length, 41);
  });

  test('poche cancellazioni si applicano; la collezione svuotata (2+ oggetti) va in hold', async () => {
    await put('piccola', 'p1.ics', ics('uid-p1'));
    await put('piccola', 'p2.ics', ics('uid-p2', { start: hourStamp(1), end: hourStamp(2) }));
    await put('piccola', 'p3.ics', ics('uid-p3', { start: hourStamp(3), end: hourStamp(4) }));
    await sync('piccola');
    await svc.delete(path('piccola', 'p1.ics'), { ifMatch: '*' });
    const one = await sync('piccola');
    assert.equal(one.deleted, 1);
    assert.equal(one.status, 'synced');

    await svc.delete(path('piccola', 'p2.ics'), { ifMatch: '*' });
    await svc.delete(path('piccola', 'p3.ics'), { ifMatch: '*' });
    const emptied = await sync('piccola');
    assert.equal(emptied.status, 'held');
    const state = await stateOf(cal.piccola.id);
    assert.equal(state.hold_reason, 'collection-empty');
    assert.equal((await objectsOf(cal.piccola.id)).length, 2);
  });

  test('item rotto (skip_broken_item): quarantena radicale-skip con le occorrenze dell\'ultima versione buona', async () => {
    await put('rotta', 'buono.ics', ics('uid-buono'));
    await put('rotta', 'rotto.ics', ics('uid-rotto', { start: hourStamp(10), end: hourStamp(11) }));
    await sync('rotta');
    const [before] = (await objectsOf(cal.rotta.id)).filter((o) => o.href === 'rotto.ics');
    const occBefore = await sql<Array<{ start_utc: Date }>>`SELECT start_utc FROM cal_occurrences WHERE object_id = ${before.id}`;
    assert.equal(occBefore.length, 1);

    // File corrotto scritto direttamente sul volume: Radicale lo salta e lo riporta come 404.
    writeFileSync(rad.fsPath(P, coll('rotta'), 'rotto.ics'), 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:uid-rotto\r\nDTSTART:2027');
    const r = await sync('rotta');
    assert.equal(r.radicaleSkipped, 1);
    const [after] = (await objectsOf(cal.rotta.id)).filter((o) => o.href === 'rotto.ics');
    assert.equal(after.id, before.id, 'stesso oggetto, stesso id');
    assert.equal(after.health, 'quarantined');
    assert.equal(after.health_reason, 'radicale-skip');
    const occAfter = await sql<Array<{ start_utc: Date; blocks: boolean }>>`SELECT start_utc, blocks FROM cal_occurrences WHERE object_id = ${after.id}`;
    assert.deepEqual(occAfter.map((o) => o.start_utc.toISOString()), occBefore.map((o) => o.start_utc.toISOString()), 'busy invariato');
    assert.ok(occAfter.every((o) => o.blocks));

    // Un file rotto mai indicizzato non compare nel listing completo: lo trova il confronto con il disco.
    writeFileSync(rad.fsPath(P, coll('rotta'), 'nuovo-rotto.ics'), 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:uid-nuovo-rotto\r\nDTSTART:20270110T090000Z\r\nDTEND:20270110T100000Z\r\nGARBAGE');
    const full = await sync('rotta', { full: true });
    assert.equal(full.full, true);
    const nuovo = (await objectsOf(cal.rotta.id)).find((o) => o.href === 'nuovo-rotto.ics');
    assert.ok(nuovo, 'item rotto indicizzato in quarantena');
    assert.equal(nuovo.health, 'quarantined');
    assert.equal(nuovo.health_reason, 'radicale-skip');
  });

  test('remote mode: un 404 diventa cancellazione solo alla seconda sync consecutiva (pending_404 continua a bloccare)', async () => {
    configureRadicaleRuntime({ dataDir: join(rad.rootDir, 'mount-assente') });
    updateWatchMode('remote', 'test');
    try {
      await put('remota', 'r1.ics', ics('uid-r1'));
      await put('remota', 'r2.ics', ics('uid-r2', { start: hourStamp(1), end: hourStamp(2) }));
      const first = await sync('remota');
      assert.equal(first.dirMtimeNs, null, 'senza mount affidabile nessuna dir_mtime_ns');
      const busy = await blockingOccurrences(cal.remota.id);
      await svc.delete(path('remota', 'r2.ics'), { ifMatch: '*' });

      const one = await sync('remota');
      assert.equal(one.pending404, 1);
      assert.equal(one.deleted, 0);
      const pending = (await objectsOf(cal.remota.id)).find((o) => o.href === 'r2.ics');
      assert.equal(pending?.health, 'pending_404');
      assert.equal(await blockingOccurrences(cal.remota.id), busy, 'pending_404 continua a bloccare');

      const two = await sync('remota');
      assert.equal(two.deleted, 1);
      assert.deepEqual((await objectsOf(cal.remota.id)).map((o) => o.href), ['r1.ics']);
    } finally {
      configureRadicaleRuntime({ dataDir: rad.storageDir });
      updateWatchMode('mount', null);
    }
  });

  test('collezione sparita da Radicale → hold collection-missing, indice invariato; la discovery in mode postgres non scrive', async () => {
    await put('sparita', 's1.ics', ics('uid-s1'));
    await put('sparita', 's2.ics', ics('uid-s2', { start: hourStamp(1), end: hourStamp(2) }));
    await sync('sparita');
    rmSync(rad.fsPath(P, coll('sparita')), { recursive: true, force: true });
    const r = await sync('sparita');
    assert.equal(r.status, 'held');
    const state = await stateOf(cal.sparita.id);
    assert.equal(state.health, 'hold');
    assert.equal(state.hold_reason, 'collection-missing');
    assert.equal((await objectsOf(cal.sparita.id)).length, 2);

    const discovery = await discoverCollections();
    assert.ok(discovery.missing.includes(coll('sparita')));
    const [row] = await sql<Array<{ missing_since: Date | null }>>`SELECT missing_since FROM calendars WHERE id = ${cal.sparita.id}`;
    assert.equal(row.missing_since, null, 'mode postgres: nessuna scrittura su calendars');
  });

  test('MOVE fra collezioni: l\'oggetto mantiene lo stesso id', async () => {
    await put('a', 'mv.ics', ics('uid-move', { start: hourStamp(30), end: hourStamp(31) }));
    await sync('a');
    const [before] = (await objectsOf(cal.a.id)).filter((o) => o.href === 'mv.ics');
    await svc.move(path('a', 'mv.ics'), path('b', 'mv-spostato.ics'));
    await sync('a'); // l'origine prima: la riga si ritira
    await sync('b');
    const [moved] = (await objectsOf(cal.b.id)).filter((o) => o.href === 'mv-spostato.ics');
    assert.equal(moved.id, before.id, 'stesso id dopo il MOVE');
    const rows = await sql<Array<{ calendar_id: string; href: string; retired_at: Date | null }>>`
      SELECT calendar_id, href, retired_at FROM cal_object_ids WHERE id = ${before.id}
    `;
    assert.deepEqual(rows.map((r) => [r.calendar_id, r.href, r.retired_at]), [[cal.b.id, 'mv-spostato.ics', null]]);
  });

  test('discovery: mode postgres solo lettura; mode radicale crea la riga del device, adotta i creating, non si fida delle dead prop', async () => {
    await svc.mkcalendar(collectionPath(P, 'telefono'), { displayName: 'Telefono', color: '#FF2968FF' });
    const ro = await discoverCollections();
    assert.ok(ro.unknown.includes('telefono'));
    assert.equal((await sql`SELECT 1 FROM calendars WHERE collection_name = 'telefono'`).length, 0);

    const [bookings] = await sql<Array<{ id: string; dav_props: Record<string, string> }>>`SELECT id, dav_props FROM calendars WHERE slug = 'bookings'`;
    await svc.mkcalendar(collectionPath(P, 'finta'), {
      props: [{ ...DAV_PROPS.calendarId, value: bookings.id }, { ...DAV_PROPS.role, value: 'bookings' }],
    });
    const [creating] = await sql<Array<{ id: string }>>`
      INSERT INTO calendars (slug, name, ics_feed_token, collection_name, lifecycle, origin)
      VALUES (${fx.slug('nuova')}, ${fx.name('Nuova')}, ${randomUUID().replace(/-/g, '')}, 'nuova', 'creating', 'admin')
      RETURNING id
    `;
    fx.track('calendarIds', creating.id);
    await svc.mkcalendar(collectionPath(P, 'nuova'), { props: [{ ...DAV_PROPS.calendarId, value: creating.id }, { ...DAV_PROPS.role, value: 'user' }] });

    await sql`UPDATE calendar_backend_state SET mode = 'radicale' WHERE id = true`;
    invalidateBackendModeCache();
    try {
      const res = await discoverCollections();
      assert.ok(res.created.includes('telefono'));
      assert.ok(res.created.includes('finta'), 'calendar-id falsificato: collezione nuova del device, nessuna adozione');
      assert.ok(res.adopted.includes('nuova'));
      assert.ok(res.missing.includes(coll('sparita')));

      const [device] = await sql<Array<Record<string, unknown>>>`
        SELECT name, origin, role, lifecycle, blocks_availability, needs_review, review_reason, ics_feed_enabled, color, dav_props
        FROM calendars WHERE collection_name = 'telefono'
      `;
      assert.deepEqual(
        { ...device, dav_props: undefined },
        { name: 'Telefono', origin: 'device', role: 'user', lifecycle: 'active', blocks_availability: true, needs_review: true, review_reason: 'device_new', ics_feed_enabled: false, color: '#ff2968', dav_props: undefined },
      );
      const [finta] = await sql<Array<{ role: string; origin: string; dav_props: Record<string, string> }>>`SELECT role, origin, dav_props FROM calendars WHERE collection_name = 'finta'`;
      assert.equal(finta.role, 'user');
      assert.equal(finta.origin, 'device');
      assert.ok(Object.keys(finta.dav_props).every((k) => !k.startsWith('{urn:calicchia:caldes}')), 'dead prop dell\'applicazione mai in dav_props di una collezione del device');
      // La riga di bookings resta legata alla propria collezione: in mode radicale
      // la discovery ne rispecchia le proprietà (ruolo in sola lettura per i
      // device: le dead prop sono fidate), mai quelle della collezione falsa.
      const [bookingsAfter] = await sql<Array<{ collection_name: string; lifecycle: string; dav_props: Record<string, string> }>>`
        SELECT collection_name, lifecycle, dav_props FROM calendars WHERE id = ${bookings.id}
      `;
      assert.equal(bookingsAfter.collection_name, 'bookings', 'la riga di bookings non è stata dirottata');
      assert.equal(bookingsAfter.lifecycle, 'active');
      assert.equal(bookingsAfter.dav_props['{urn:calicchia:caldes}calendar-id'], bookings.id);
      assert.equal(bookingsAfter.dav_props['{urn:calicchia:caldes}role'], 'bookings');
      assert.equal(bookingsAfter.dav_props['{DAV:}displayname'], 'Bookings');
      assert.equal((await sql`SELECT 1 FROM calendars WHERE collection_name IN ('bookings', 'finta')`).length, 2, 'due righe distinte');
      const states = await sql`SELECT 1 FROM cal_collection_state s JOIN calendars c ON c.id = s.calendar_id WHERE c.collection_name = 'telefono'`;
      assert.equal(states.length, 1, 'riga di stato dell\'indice creata con la riga del sidecar');
      const [adopted] = await sql<Array<{ lifecycle: string }>>`SELECT lifecycle FROM calendars WHERE id = ${creating.id}`;
      assert.equal(adopted.lifecycle, 'active');
      const [missing] = await sql<Array<{ missing_since: Date | null }>>`SELECT missing_since FROM calendars WHERE id = ${cal.sparita.id}`;
      assert.ok(missing.missing_since, 'mode radicale: missing_since impostato, nessuna cancellazione');
      // La collezione del device si sincronizza come le altre.
      const [telefono] = await sql<Array<{ id: string }>>`SELECT id FROM calendars WHERE collection_name = 'telefono'`;
      await svc.put(objectPath(P, 'telefono', 'tel.ics'), ics('uid-telefono'), { ifNoneMatch: '*' });
      const r = await syncCollection(telefono.id, { reason: 'manual' });
      assert.equal(r.upserted, 1);
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = 'postgres' WHERE id = true`;
      invalidateBackendModeCache();
    }
  });

  test('canary: ok sul mount locale; fs non locale, mount fermo o _canary assente → remote mode dichiarata', async () => {
    const ok = await runCanary();
    assert.equal(ok.ok, true, ok.detail ?? '');
    assert.equal(ok.mode, 'mount');
    assert.equal(ok.fsLocal, true);
    assert.ok(ok.mtimeLagMs !== null && ok.mtimeLagMs <= 100);
    assert.equal(currentWatchMode().mode, 'mount');

    const notLocal = await withEnv({ CALDES_WATCH_FS_TYPES: 'xfs' }, () => runCanary());
    assert.equal(notLocal.reason, 'fs_not_local');
    assert.equal(currentWatchMode().mode, 'remote');
    assert.equal(currentWatchMode().reason, 'fs_not_local');

    // Copia statica dell'albero: il "mount" non vede le scritture di Radicale (come una cache degli attributi).
    const frozen = mkdtempSync(join(tmpdir(), 'caldes-mount-fermo-'));
    try {
      cpSync(rad.storageDir, frozen, { recursive: true });
      const stale = await runCanary({ dataDir: frozen });
      assert.equal(stale.reason, 'mtime_not_observed');
      assert.equal(currentWatchMode().mode, 'remote');
    } finally {
      rmSync(frozen, { recursive: true, force: true });
    }

    const canaryDir = rad.fsPath(P, CANARY_COLLECTION);
    renameSync(canaryDir, `${canaryDir}.via`);
    try {
      const missing = await runCanary();
      assert.equal(missing.reason, 'canary_missing');
    } finally {
      renameSync(`${canaryDir}.via`, canaryDir);
    }
    const back = await runCanary();
    assert.equal(back.ok, true);
    assert.equal(currentWatchMode().mode, 'mount');
  });

  test('freshness: Radicale fermo senza modifiche → ok senza HTTP; con directory cambiata → 503; principal cambiato → discovery', async () => {
    overrideCalendarStore('radicale');
    try {
      await settleAll();
      const ok = await sql.begin((tx) => verifyFreshness({ db: tx as unknown as Db }));
      assert.equal(ok.mode, 'mount');
      assert.deepEqual(ok.synced, []);
      assert.ok(ok.checked >= 8);

      // Radicale fermo (porta chiusa) e nessuna modifica pendente: nessuna richiesta, decisione ammessa.
      const counting = countingTransport();
      const dead = new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0, timeoutMs: 500, transport: async (req) => counting.transport({ ...req }) });
      configureRadicaleRuntime({ client: dead });
      try {
        const still = await sql.begin((tx) => verifyFreshness({ db: tx as unknown as Db }));
        assert.deepEqual(still.synced, []);
        assert.equal(counting.requests(), 0, 'nessuna richiesta HTTP verso Radicale');

        // Directory cambiata e Radicale non raggiungibile: 503.
        await put('fresca', 'f1.ics', ics('uid-f1'));
        await assert.rejects(
          sql.begin((tx) => verifyFreshness({ db: tx as unknown as Db })),
          (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'collection_unsyncable' && err.status === 503,
        );
        const state = await stateOf(cal.fresca.id);
        assert.equal(state.health, 'unsyncable');
        assert.ok(state.dirty_since);
      } finally {
        configureRadicaleRuntime({ client: svc });
        counting.close();
      }

      // Radicale raggiungibile: la freshness sincronizza nella sezione critica.
      await sleep(60);
      const synced = await sql.begin((tx) => verifyFreshness({ db: tx as unknown as Db }));
      assert.ok(synced.synced.includes(cal.fresca.id));
      assert.equal((await stateOf(cal.fresca.id)).health, 'healthy');
      assert.ok((await objectsOf(cal.fresca.id)).some((o) => o.href === 'f1.ics'));

      // Collezione nuova sul principal: discovery prima della decisione.
      await sleep(30);
      await svc.mkcalendar(collectionPath(P, 'nuovissima'), {});
      const disc = await sql.begin((tx) => verifyFreshness({ db: tx as unknown as Db }));
      assert.equal(disc.discovery, true);
    } finally {
      overrideCalendarStore(null);
    }
    // Mode postgres senza store forzato: le decisioni usano il busy legacy.
    const legacy = await sql.begin((tx) => verifyFreshness({ db: tx as unknown as Db }));
    assert.equal(legacy.mode, 'off');
    assert.equal(legacy.checked, 0);
  });

  test('watcher: lag fra scrittura su Radicale e indice sotto 2 s (p95); livello display pronto', async () => {
    await startCalendarWatcher({ intervalMs: 1_000 });
    try {
      await waitFor('primo giro del campanello', async () => getWatcherStatus().lastTickAt);
      assert.equal(getWatcherStatus().mode, 'mount');
      const lags: number[] = [];
      for (let i = 0; i < 10; i++) {
        const started = Date.now();
        const { etag } = await put('fresca', `lag${i}.ics`, ics(`uid-lag${i}`, { start: hourStamp(40 + i), end: hourStamp(41 + i) }));
        await waitFor(`lag${i}.ics nell'indice`, async () => {
          const [row] = await sql<Array<{ etag: string | null }>>`SELECT etag FROM cal_objects WHERE calendar_id = ${cal.fresca.id} AND href = ${`lag${i}.ics`}`;
          return row?.etag === etag;
        }, 10_000, 20);
        lags.push(Date.now() - started);
      }
      lags.sort((a, b) => a - b);
      const p95 = lags[Math.ceil(lags.length * 0.95) - 1];
      assert.ok(p95 < 2_000, `p95 del lag ${p95} ms (${lags.join(', ')})`);
      const status = getWatcherStatus();
      assert.equal(status.running, true);
      assert.equal(status.consecutiveErrors, 0);
      assert.ok(status.collections.some((c) => c.calendarId === cal.fresca.id));

      overrideCalendarStore('radicale');
      try {
        await assertDisplayReady(sql);
      } finally {
        overrideCalendarStore(null);
      }
    } finally {
      await stopCalendarWatcher();
      updateWatchMode('mount', null);
    }
  });

  test('lock della collezione occupato: lock_timeout (o timeout) senza registrare un fallimento', async () => {
    const before = await stateOf(cal.a.id);
    const holder = await sql.reserve();
    try {
      await holder`SELECT pg_advisory_lock(hashtext(${CAL_LOCKS.collection(cal.a.id)}))`;
      await assert.rejects(
        sync('a', { deadline: Date.now() + 300 }),
        (err: unknown) => err instanceof CollectionSyncError && (err.code === 'lock_timeout' || err.code === 'timeout'),
      );
      await sleep(400);
      assert.equal((await stateOf(cal.a.id)).consecutive_failures, before.consecutive_failures);
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtext(${CAL_LOCKS.collection(cal.a.id)}))`;
      holder.release();
    }
    // Il lock libero: la sync riprende.
    await sync('a');
  });

  test('identità del volume diversa: sync ferma, freshness 503 identity_mismatch, policy frozen e device senza permessi', async () => {
    const state = await readBackendState(sql);
    const before = await objectsOf(cal.a.id);
    await writeVolumeMarker(svc, P, { volume_id: randomUUID(), epoch: state.epoch });
    invalidateIdentityCache();
    try {
      await put('a', 'dopo-mismatch.ics', ics('uid-dopo-mismatch'));
      await assert.rejects(sync('a'), (err: unknown) => err instanceof CollectionSyncError && err.code === 'identity');
      assert.deepEqual((await objectsOf(cal.a.id)).map((o) => o.href), before.map((o) => o.href), 'indice invariato');

      overrideCalendarStore('radicale');
      try {
        await assert.rejects(
          sql.begin((tx) => verifyFreshness({ db: tx as unknown as Db })),
          (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'identity_mismatch',
        );
      } finally {
        overrideCalendarStore(null);
      }
      const identity = lastIdentityCheck();
      assert.equal(identity?.status, 'mismatch');
      const policy = policyFromState({ state, identity: identity!.status, collections: [], principal: P, now: new Date() });
      assert.equal(policy.mode, 'frozen');
      assert.ok(policy.reasons.includes('identity_mismatch'));
      assert.equal(expectedRadicaleRights(P, `${P}/${coll('a')}`, { principal: P, mode: 'frozen', identityOk: false, readonly: [], hidden: [] }), '');
    } finally {
      await writeVolumeMarker(svc, P, { volume_id: state.volume_id as string, epoch: state.epoch });
      invalidateIdentityCache();
    }
    const r = await sync('a');
    assert.equal(r.upserted, 1, 'identità di nuovo ok: la sync riprende');
  });
});

