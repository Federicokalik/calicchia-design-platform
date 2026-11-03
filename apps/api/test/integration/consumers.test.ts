/**
 * Consumatori della F2 contro Radicale 3.7.8 reale (piano F2, "Test": Feed;
 * contratto dei moduli docs/calendar-radicale/contracts/f2-modules.md §9 e
 * §11; design §6.5, §7, §10, §16.5).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea, auth
 * htpasswd con il solo caldes-svc e rights from_file con la matrice di
 * caldes-svc del contratto control-plane §8; il volume si inizializza con
 * initializeVolume() e il runtime della sync punta allo storage come al mount.
 * Le risorse le scrive caldes-svc come le scriverebbe un device.
 *
 * Casi:
 *  - feed: dall'indice di Radicale con lo store Radicale, STATUS:CANCELLED
 *    scritto dal "device" escluso, override cancellato come EXDATE, ETag che
 *    cambia dopo una PUT e 304 su If-None-Match, feed servito anche con
 *    Radicale non raggiungibile (l'indice basta);
 *  - agenda del device dalle occorrenze dell'indice (ricorrenze espanse);
 *  - salute con lo store Radicale: campanello vivo e identità ok → mai
 *    'down'; un item rotto sul volume → quarantena e 'degraded', mai 'down'.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { clearIndexFeedCache } from '../../src/lib/calendar/feed-builder';
import { objectPath, RadicaleClient } from '../../src/lib/calendar/radicale/client';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import {
  configureRadicaleRuntime,
  syncAllCollections,
  syncCollection,
  updateWatchMode,
  verifyVolumeIdentity,
} from '../../src/lib/calendar/radicale/sync';
import { getWatcherStatus, startCalendarWatcher, stopCalendarWatcher } from '../../src/lib/calendar/radicale/watcher';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import type { Calendar } from '../../src/lib/calendar/types';
import { resetCalendarHealthCache } from '../../src/routes/calendar/health';
import { icsEvents, icsProp } from '../contracts/_http-contract';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { api } from '../helpers/http';
import { romeIso, useFixtures } from '../helpers/fixtures';
import { radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  await stopIndexWorker();
  await resetCalendarBaseline();
});
const fx = useFixtures('cons-rad');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f2-consumers';

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ics(...components: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calicchia Design//Test consumatori F2//IT', ...components, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(lines: string[]): string {
  return ['BEGIN:VEVENT', 'DTSTAMP:20261001T080000Z', ...lines, 'END:VEVENT'].join('\r\n');
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

describe('consumatori contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  const cal: Record<string, Calendar> = {};
  const put = (key: string, name: string, body: string) => svc.put(objectPath(P, cal[key].slug, name), body, { ifNoneMatch: '*' });
  const sync = async (key: string) => {
    await sleep(60); // fuori dalla finestra racy di 50 ms
    return syncCollection(cal[key].id, { reason: 'manual' });
  };

  before(async () => {
    rad = await startRadicale({
      label: 'f2-consumers',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    cal.feed = await fx.calendar({ key: 'feed', name: 'Feed', blocks_availability: false });
    cal.salute = await fx.calendar({ key: 'salute', name: 'Salute', blocks_availability: true });
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    assert.ok(init.collections.every((c) => c.status === 'created'));
    configureRadicaleRuntime({ client: svc, dataDir: rad.storageDir, principal: P, watch: 'auto', identitySource: 'auto' });
    updateWatchMode('mount', null);
    clearIndexFeedCache();
  });

  after(async () => {
    await stopCalendarWatcher();
    overrideCalendarStore(null);
    configureRadicaleRuntime(null);
    updateWatchMode('off', 'test concluso');
    svc?.close();
    await rad?.stop();
  });

  test('feed dall\'indice di Radicale: CANCELLED del device escluso, EXDATE, ETag dopo una PUT, 304, Radicale non raggiungibile', async () => {
    await put('feed', 'riunione.ics', ics(vevent(['UID:riunione-rad@test.invalid', 'DTSTART:20270104T120000Z', 'DTEND:20270104T130000Z', 'SUMMARY:Riunione'])));
    await put('feed', 'annullato.ics', ics(vevent(['UID:annullato-rad@test.invalid', 'DTSTART:20270105T120000Z', 'DTEND:20270105T130000Z', 'SUMMARY:Annullato dal telefono', 'STATUS:CANCELLED'])));
    await put('feed', 'serie.ics', ics(
      vevent(['UID:serie-rad@test.invalid', 'DTSTART;TZID=Europe/Rome:20270104T090000', 'DTEND;TZID=Europe/Rome:20270104T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'SUMMARY:Studio']),
      vevent(['UID:serie-rad@test.invalid', 'RECURRENCE-ID;TZID=Europe/Rome:20270105T090000', 'DTSTART;TZID=Europe/Rome:20270105T090000', 'DTEND;TZID=Europe/Rome:20270105T100000', 'SUMMARY:Studio', 'STATUS:CANCELLED']),
    ));
    const first = await sync('feed');
    assert.equal(first.upserted, 3);

    overrideCalendarStore('radicale');
    try {
      const path = `/api/calendar/feed/${cal.feed.ics_feed_token}.ics`;
      const res = await api.get(path);
      assert.equal(res.status, 200, res.text);
      const etag = res.headers.get('etag');
      assert.match(etag ?? '', /^"[0-9a-f]{64}"$/);
      const events = icsEvents(res.text);
      assert.deepEqual(events.map((e) => icsProp(e, 'SUMMARY')).sort(), ['Riunione', 'Studio']);
      const master = events.find((e) => icsProp(e, 'UID') === 'serie-rad@test.invalid') as string[];
      assert.ok(master.includes('EXDATE;TZID=Europe/Rome:20270105T090000'), master.join(' | '));
      assert.equal((await api.get(path, { headers: { 'If-None-Match': etag as string } })).status, 304);

      await put('feed', 'nuovo.ics', ics(vevent(['UID:nuovo-rad@test.invalid', 'DTSTART:20270107T120000Z', 'DTEND:20270107T130000Z', 'SUMMARY:Nuovo dal telefono'])));
      await sync('feed');
      const changed = await api.get(path, { headers: { 'If-None-Match': etag as string } });
      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers.get('etag'), etag);
      assert.ok(icsEvents(changed.text).some((e) => icsProp(e, 'SUMMARY') === 'Nuovo dal telefono'));

      // Radicale non raggiungibile: il feed nasce dall'indice e risponde lo stesso.
      const dead = new RadicaleClient({ baseUrl: 'http://127.0.0.1:9', password: 'x', retries: 0, timeoutMs: 500 });
      configureRadicaleRuntime({ client: dead });
      try {
        const offline = await api.get(path);
        assert.equal(offline.status, 200);
        assert.equal(offline.headers.get('etag'), changed.headers.get('etag'));
      } finally {
        configureRadicaleRuntime({ client: svc });
        dead.close();
      }
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('agenda del device dalle occorrenze dell\'indice (serie espansa, cancellata esclusa)', async () => {
    const device = await fx.deviceToken();
    overrideCalendarStore('radicale');
    try {
      const day = async (date: string) => {
        const res = await api.get('/api/device/agenda', { auth: { bearer: device.token }, query: { date } });
        assert.equal(res.status, 200, res.text);
        return res.json.events.map((e: { summary: string; start_time: string }) => [e.summary, e.start_time]);
      };
      assert.deepEqual(await day('2027-01-04'), [['Studio', romeIso('2027-01-04', '09:00')], ['Riunione', '2027-01-04T12:00:00.000Z']]);
      // Martedì 5: occorrenza della serie cancellata dall'override, singolo annullato dal telefono.
      assert.deepEqual(await day('2027-01-05'), []);
      assert.deepEqual(await day('2027-01-07'), [['Studio', romeIso('2027-01-07', '09:00')], ['Nuovo dal telefono', '2027-01-07T12:00:00.000Z']]);
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('salute con lo store Radicale: campanello e identità ok → mai down; item rotto → quarantena e degraded', async () => {
    await sql`UPDATE calendar_backend_state SET mode = 'radicale' WHERE id = true`;
    invalidateBackendModeCache();
    try {
      const identity = await verifyVolumeIdentity({ force: true });
      assert.equal(identity.check.status, 'ok', identity.check.detail ?? '');
      await put('salute', 'rotto.ics', ics(vevent(['UID:rotto-salute@test.invalid', 'DTSTART:20270110T090000Z', 'DTEND:20270110T100000Z', 'SUMMARY:Diventerà illeggibile'])));
      await sleep(60);
      for (const r of await syncAllCollections({ reason: 'manual' })) if (r instanceof Error) throw r;
      await startCalendarWatcher({ intervalMs: 1_000 });
      await waitFor('primo giro del campanello', async () => getWatcherStatus().lastTickAt);

      const health = async (auth?: 'admin') => {
        resetCalendarHealthCache();
        return api.get('/api/health/calendar', auth ? { auth } : {});
      };
      const clean = await health('admin');
      assert.equal(clean.status, 200, JSON.stringify(clean.json.reasons));
      assert.notEqual(clean.json.status, 'down', JSON.stringify(clean.json.reasons));
      assert.equal(clean.json.mode.store, 'radicale');
      assert.equal(clean.json.radicale.status, 'configured');
      assert.equal(clean.json.identity.status, 'ok');
      assert.equal(clean.json.watcher.alive, true);
      assert.equal(clean.json.watcher.mode, 'mount');

      // File corrotto scritto direttamente sul volume (la mtime della directory non cambia, quindi la sync
      // si chiede a mano come farebbe l'auditor): Radicale lo salta, l'indice lo mette in quarantena con
      // le occorrenze dell'ultima versione buona.
      writeFileSync(rad.fsPath(P, cal.salute.slug, 'rotto.ics'), 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:rotto-salute@test.invalid\r\nDTSTART:2027');
      const broken = await sync('salute');
      assert.equal(broken.radicaleSkipped, 1);
      const [row] = await sql<Array<{ health: string; health_reason: string | null }>>`
        SELECT health, health_reason FROM cal_objects WHERE calendar_id = ${cal.salute.id} AND href = 'rotto.ics'
      `;
      assert.deepEqual(row, { health: 'quarantined', health_reason: 'radicale-skip' });
      const degraded = await health('admin');
      assert.equal(degraded.status, 200, 'un singolo oggetto rotto non porta mai a down');
      assert.equal(degraded.json.status, 'degraded', JSON.stringify(degraded.json.reasons));
      assert.ok(degraded.json.reasons.some((r: { code: string }) => r.code === 'objects_quarantined'));
      assert.ok(degraded.json.reasons.every((r: { severity: string }) => r.severity !== 'down'));
      const pub = await health();
      assert.deepEqual(pub.json, { status: 'degraded' });
    } finally {
      await stopCalendarWatcher();
      updateWatchMode('mount', null);
      await sql`UPDATE calendar_backend_state SET mode = 'postgres' WHERE id = true`;
      invalidateBackendModeCache();
    }
  });
});
