/**
 * Specchio delle iscrizioni su Radicale 3.7.8 reale (apps/api/src/lib/
 * calendar/subscriptions/mirror.ts; design §6.6; decisione 5; contratto
 * docs/calendar-radicale/contracts/f2-modules.md §3 e §8.3).
 *
 * Un Radicale con storage multifilesystem in una directory temporanea, auth
 * htpasswd con il solo caldes-svc e rights from_file con la matrice di
 * caldes-svc del contratto control-plane §8. I sidecar delle iscrizioni
 * nascono prima dell'inizializzazione esplicita del volume
 * (initializeVolume di F1, il passo del wizard), che crea le collezioni
 * `sub-<id8>`; il runtime punta allo storage come a RADICALE_DATA_DIR, così
 * l'identità del volume è verificata come in produzione. Il pull riceve il
 * corpo del feed già pronto (`body`): la parte HTTP è in
 * test/calendar/subscriptions-pull.test.ts.
 *
 * Casi: iscrizione visibile → job accodato dal pull, PUT dei soli oggetti
 * 'ok' con If-None-Match: *, contenuto uguale per fingerprint; DTSTAMP nuovo →
 * nessun job e nessuna PUT, anche rileggendo tutta la collezione senza il
 * registro (round-trip di Radicale); modifica, cancellazione e oggetto
 * riparato → PUT con If-Match e DELETE con If-Match; iscrizione non visibile →
 * nessuna richiesta a Radicale; collezione sub-* assente → dead letter e
 * avviso, mai MKCALENDAR; cutover → 503 'transition' e nuovo tentativo; al
 * massimo 5 scritture al secondo.
 *
 * Senza RADICALE_BIN la suite è saltata con il motivo. Date fisse nel 2027.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { parseCalendarObject, semanticFingerprint } from '@calicchia/calendar-core';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { remoteHref } from '../../src/lib/calendar/ics-split';
import { runCalendarJobsOnce, unregisterCalendarJobHandler } from '../../src/lib/calendar/jobs';
import { collectionPath, createNodeTransport, RadicaleClient, type RadicaleTransport } from '../../src/lib/calendar/radicale/client';
import { DAV_PROPS } from '../../src/lib/calendar/radicale/dav-xml';
import { initializeVolume } from '../../src/lib/calendar/radicale/identity';
import { stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import { configureRadicaleRuntime, invalidateIdentityCache } from '../../src/lib/calendar/radicale/sync';
import { mirrorSubscription, registerSubscriptionMirrorJob, resetSubscriptionMirrorLedger } from '../../src/lib/calendar/subscriptions/mirror';
import { enableSubscriptionIndex, pullSubscriptionToIndex } from '../../src/lib/calendar/subscriptions/pull';
import type { Calendar, CalendarSubscription } from '../../src/lib/calendar/types';
import { onBeforeDatabaseClose, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { RADICALE_PLUGINS_DIR, radicaleAvailability, type RadicaleServer, startRadicale, TEST_PRINCIPAL } from '../helpers/radicale';

useTestDatabase({ resetBaseline: true });
onBeforeDatabaseClose(async () => {
  unregisterCalendarJobHandler('subscription_mirror');
  configureRadicaleRuntime(null);
  await stopIndexWorker();
  await resetCalendarBaseline();
});
const fx = useFixtures('subs-mirror');

const radicale = radicaleAvailability();
const P = TEST_PRINCIPAL;
const SVC_PASSWORD = 'test-only-svc-password-f2-subs';

/** Matrice di caldes-svc del contratto control-plane §8 (R root, RW principal, rwD collezioni). */
const SVC_RIGHTS_RULES = [
  '[root]', 'user: .+', 'collection:', 'permissions: R', '',
  '[svc-principal]', 'user: caldes-svc', `collection: ${P}`, 'permissions: RW', '',
  '[svc-collections]', 'user: caldes-svc', `collection: ${P}/[^/]+`, 'permissions: rwD', '',
].join('\n');

interface Recorded {
  method: string;
  path: string;
  ifMatch: string | null;
  ifNoneMatch: string | null;
}

/** Trasporto node che registra metodo, percorso e precondizioni di ogni richiesta. */
function recordingTransport(): { transport: RadicaleTransport; take(): Recorded[]; close(): void } {
  const node = createNodeTransport({ maxSockets: 4 });
  let log: Recorded[] = [];
  const transport: RadicaleTransport = async (req) => {
    log.push({ method: req.method, path: decodeURIComponent(req.url.pathname), ifMatch: req.headers['If-Match'] ?? null, ifNoneMatch: req.headers['If-None-Match'] ?? null });
    return node(req);
  };
  return {
    transport,
    take: () => {
      const out = log;
      log = [];
      return out;
    },
    close: () => node.close(),
  };
}

let stamp = 0;
function nextStamp(): string {
  stamp++;
  return new Date(Date.UTC(2026, 9, 10) + stamp * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

interface FeedSpec {
  series?: boolean;
  single?: string;
  broken?: boolean;
  fixed?: boolean;
}

/** Feed con (facoltativi) una serie con override, un singolo e un evento con RRULE rotta (o riparata). */
function feedBody(spec: FeedSpec): string {
  const s = nextStamp();
  const events: string[][] = [];
  if (spec.series) {
    events.push(['UID:serie@remoto', `DTSTAMP:${s}`, 'DTSTART;TZID=Europe/Rome:20270104T090000', 'DTEND;TZID=Europe/Rome:20270104T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'SUMMARY:Studio']);
    events.push(['UID:serie@remoto', `DTSTAMP:${s}`, 'RECURRENCE-ID;TZID=Europe/Rome:20270105T090000', 'DTSTART;TZID=Europe/Rome:20270105T150000', 'DTEND;TZID=Europe/Rome:20270105T160000', 'SUMMARY:Studio (spostato)']);
  }
  if (spec.single !== undefined) {
    events.push(['UID:singolo@remoto', `DTSTAMP:${s}`, 'DTSTART:20270106T080000Z', 'DTEND:20270106T090000Z', `SUMMARY:${spec.single}`, 'DESCRIPTION:Riga lunga, con virgole\\, punti e virgola\\; e un a capo\\nper vedere il round-trip di Radicale']);
  }
  if (spec.broken || spec.fixed) {
    events.push(['UID:rotto@remoto', `DTSTAMP:${s}`, 'DTSTART:20270107T080000Z', 'DTEND:20270107T090000Z', `RRULE:${spec.fixed ? 'FREQ=WEEKLY;COUNT=3' : 'FREQ=WEEKLY;BYDAY=XX'}`, 'SUMMARY:Rotto']);
  }
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Remoto',
    ...events.flatMap((p) => ['BEGIN:VEVENT', ...p, 'END:VEVENT']),
    'END:VCALENDAR', '',
  ].join('\r\n');
}

function fingerprintOf(text: string | null): string | null {
  if (!text) return null;
  const parsed = parseCalendarObject(text);
  return parsed.ok ? semanticFingerprint(parsed.value) : null;
}

describe('specchio delle iscrizioni contro Radicale reale', { skip: radicale.skip }, () => {
  let rad: RadicaleServer;
  let svc: RadicaleClient;
  let recorder: ReturnType<typeof recordingTransport>;
  let mirrorClient: RadicaleClient;
  let dest: Calendar;
  const subs: Record<string, { sub: CalendarSubscription; sidecarId: string; collection: string }> = {};

  async function makeSubscription(key: string, visible: boolean): Promise<void> {
    const { subscription: sub } = await fx.subscription({ calendar: dest, name: key, url: `https://feeds.caldes.test/${key}.ics` });
    await sql`UPDATE calendar_subscriptions SET device_visible = ${visible} WHERE id = ${sub.id}`;
    const sidecarId = await enableSubscriptionIndex(sub.id, { allowPostgresMode: true });
    fx.track('calendarIds', sidecarId);
    const [row] = await sql<Array<{ collection_name: string }>>`SELECT collection_name FROM calendars WHERE id = ${sidecarId}`;
    subs[key] = { sub, sidecarId, collection: row.collection_name };
  }

  /** Contenuto della collezione su Radicale: nome → testo. */
  async function radicaleContent(key: string): Promise<Map<string, string>> {
    const path = collectionPath(P, subs[key].collection);
    const ms = await svc.propfind(path, { props: [DAV_PROPS.getetag], depth: 1 });
    const hrefs = ms.responses.map((r) => r.href).filter((h) => decodeURIComponent(h).replace(/\/+$/, '') !== decodeURIComponent(path).replace(/\/+$/, ''));
    if (hrefs.length === 0) return new Map();
    const got = await svc.calendarMultiget(path, hrefs);
    return new Map(got.objects.map((o) => [o.name, o.data ?? '']));
  }

  /** Oggetti 'ok' dell'indice del sidecar: href → fingerprint. */
  async function indexOk(key: string): Promise<Map<string, string | null>> {
    const rows = await sql<Array<{ href: string; semantic_fp: string | null }>>`
      SELECT href, semantic_fp FROM cal_objects WHERE calendar_id = ${subs[key].sidecarId} AND health = 'ok' ORDER BY href
    `;
    return new Map(rows.map((r) => [r.href, r.semantic_fp]));
  }

  async function mirrorJob(key: string): Promise<{ status: string; last_error: string | null; attempts: number } | undefined> {
    const [row] = await sql<Array<{ status: string; last_error: string | null; attempts: number }>>`
      SELECT status, last_error, attempts FROM cal_jobs WHERE kind = 'subscription_mirror' AND key = ${subs[key].sub.id}
      ORDER BY id DESC LIMIT 1
    `;
    return row;
  }

  before(async () => {
    rad = await startRadicale({
      label: 'f2-subs',
      auth: { type: 'htpasswd', users: { 'caldes-svc': SVC_PASSWORD } },
      rights: { type: 'from_file', rules: SVC_RIGHTS_RULES },
      // sitecustomize dell'immagine: la patch di fedeltà di vobject attiva come in produzione.
      pythonPath: [RADICALE_PLUGINS_DIR],
    });
    svc = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0 });
    dest = await fx.calendar({ key: 'dest', blocks_availability: true });
    await makeSubscription('visibile', true);
    await makeSubscription('nascosta', false);
    // Il passo esplicito del wizard crea anche le collezioni sub-* dei sidecar.
    const init = await initializeVolume({ db: sql, client: svc, principal: P });
    for (const key of ['visibile', 'nascosta']) {
      assert.ok(init.collections.some((c) => c.collectionName === subs[key].collection && c.status === 'created'), `collezione ${subs[key].collection} creata`);
    }
    recorder = recordingTransport();
    mirrorClient = new RadicaleClient({ baseUrl: rad.url, password: SVC_PASSWORD, retries: 0, transport: recorder.transport });
    configureRadicaleRuntime({ client: mirrorClient, dataDir: rad.storageDir, principal: P, watch: 'off', identitySource: 'auto' });
    invalidateIdentityCache();
    registerSubscriptionMirrorJob();
  });

  after(async () => {
    configureRadicaleRuntime(null);
    recorder?.close();
    svc?.close();
    await rad?.stop();
  });

  test('iscrizione visibile: il pull accoda lo specchio, PUT dei soli oggetti ok con If-None-Match, contenuto uguale per fingerprint', async () => {
    const pulled = await pullSubscriptionToIndex(subs.visibile.sub.id, { body: feedBody({ series: true, single: 'Riunione', broken: true }) });
    assert.deepEqual([pulled.status, pulled.upserted, pulled.quarantined], ['applied', 3, 1]);
    assert.equal((await mirrorJob('visibile'))?.status, 'pending');
    recorder.take();

    const t0 = Date.now();
    const run = await runCalendarJobsOnce({ limit: 5 });
    const elapsed = Date.now() - t0;
    assert.equal(run.done, 1);
    assert.equal((await mirrorJob('visibile'))?.status, 'done');
    const requests = recorder.take();
    const puts = requests.filter((r) => r.method === 'PUT');
    assert.equal(puts.length, 2, 'solo gli oggetti ok: quello in quarantena non va ai device');
    assert.ok(puts.every((r) => r.ifNoneMatch === '*' && r.ifMatch === null), 'risorse nuove con If-None-Match: *');
    assert.ok(!requests.some((r) => r.method === 'MKCALENDAR' || r.method === 'MKCOL'));
    assert.ok(elapsed >= 180, `al massimo 5 scritture al secondo (2 PUT in ${elapsed} ms)`);

    const content = await radicaleContent('visibile');
    const index = await indexOk('visibile');
    assert.deepEqual([...content.keys()].sort(), [...index.keys()].sort());
    assert.deepEqual([...content.keys()].sort(), [remoteHref('serie@remoto'), remoteHref('singolo@remoto')].sort());
    for (const [name, text] of content) assert.equal(fingerprintOf(text), index.get(name), `fingerprint di ${name} dopo il round-trip di Radicale`);
    assert.equal((content.get(remoteHref('serie@remoto'))!.match(/BEGIN:VEVENT/g) ?? []).length, 2, 'override nella risorsa del master');
  });

  test('DTSTAMP nuovo: nessun job e nessuna PUT, anche rileggendo tutta la collezione senza il registro', async () => {
    const pulled = await pullSubscriptionToIndex(subs.visibile.sub.id, { body: feedBody({ series: true, single: 'Riunione', broken: true }) });
    assert.equal(pulled.status, 'unchanged');
    assert.equal((await mirrorJob('visibile'))?.status, 'done', 'nessun nuovo job');

    recorder.take();
    const res = await mirrorSubscription(subs.visibile.sub.id, { signal: new AbortController().signal });
    assert.deepEqual([res.put, res.deleted, res.unchanged, res.failed, res.skipped], [0, 0, 2, 0, null]);
    assert.ok(!recorder.take().some((r) => r.method === 'REPORT'), 'con il registro nessun multiget');

    resetSubscriptionMirrorLedger();
    const cold = await mirrorSubscription(subs.visibile.sub.id, { signal: new AbortController().signal });
    assert.deepEqual([cold.put, cold.deleted, cold.unchanged], [0, 0, 2], 'il testo riletto da Radicale ha lo stesso fingerprint');
    const requests = recorder.take();
    assert.ok(requests.some((r) => r.method === 'REPORT'), 'senza registro si rilegge con il multiget');
    assert.ok(!requests.some((r) => r.method === 'PUT' || r.method === 'DELETE'));
  });

  test('modifica, cancellazione e oggetto riparato: PUT con If-Match, DELETE con If-Match', async () => {
    const pulled = await pullSubscriptionToIndex(subs.visibile.sub.id, { body: feedBody({ single: 'Riunione spostata', fixed: true }) });
    assert.deepEqual([pulled.status, pulled.upserted, pulled.deleted], ['applied', 2, 1]);
    recorder.take();
    const run = await runCalendarJobsOnce({ limit: 5 });
    assert.equal(run.done, 1);
    const requests = recorder.take();
    const puts = requests.filter((r) => r.method === 'PUT');
    const deletes = requests.filter((r) => r.method === 'DELETE');
    assert.equal(puts.length, 2);
    const byName = new Map(puts.map((r) => [r.path.split('/').pop(), r]));
    assert.ok(byName.get(remoteHref('singolo@remoto'))?.ifMatch, 'risorsa esistente: If-Match');
    assert.equal(byName.get(remoteHref('rotto@remoto'))?.ifNoneMatch, '*', 'riparata, mai specchiata prima: If-None-Match');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].path.split('/').pop(), remoteHref('serie@remoto'));
    assert.ok(deletes[0].ifMatch, 'DELETE con If-Match');

    const content = await radicaleContent('visibile');
    const index = await indexOk('visibile');
    assert.deepEqual([...content.keys()].sort(), [remoteHref('rotto@remoto'), remoteHref('singolo@remoto')].sort());
    for (const [name, text] of content) assert.equal(fingerprintOf(text), index.get(name));
    assert.match(content.get(remoteHref('singolo@remoto'))!, /SUMMARY:Riunione spostata/);
  });

  test('iscrizione non visibile: nessun job e nessuna richiesta a Radicale, nemmeno un PROPFIND', async () => {
    const pulled = await pullSubscriptionToIndex(subs.nascosta.sub.id, { body: feedBody({ series: true, single: 'Privato' }) });
    assert.equal(pulled.status, 'applied');
    assert.equal(await mirrorJob('nascosta'), undefined, 'nessun job per un\'iscrizione non visibile');
    recorder.take();
    const res = await mirrorSubscription(subs.nascosta.sub.id, { signal: new AbortController().signal });
    assert.deepEqual([res.put, res.deleted, res.unchanged, res.skipped], [0, 0, 0, 'iscrizione non visibile ai device']);
    assert.deepEqual(recorder.take(), [], 'nessuna richiesta');
    assert.equal((await radicaleContent('nascosta')).size, 0);
  });

  test('collezione sub-* assente: dead letter con avviso, mai MKCALENDAR', async () => {
    await makeSubscription('senza-collezione', true);
    const pulled = await pullSubscriptionToIndex(subs['senza-collezione'].sub.id, { body: feedBody({ single: 'Uno' }) });
    assert.equal(pulled.status, 'applied');
    recorder.take();
    await runCalendarJobsOnce({ limit: 5 });
    const job = await mirrorJob('senza-collezione');
    assert.equal(job?.status, 'dead');
    assert.match(job?.last_error ?? '', /assente/);
    const requests = recorder.take();
    assert.ok(requests.length > 0 && requests.every((r) => r.method === 'PROPFIND'), 'solo la lettura, nessuna creazione');
    assert.equal(await svc.readProps(collectionPath(P, subs['senza-collezione'].collection), [DAV_PROPS.resourcetype]), null);
  });

  test('cutover: 503 transition e nuovo tentativo; tornato il modo, lo specchio si completa', async () => {
    const pulled = await pullSubscriptionToIndex(subs.visibile.sub.id, { body: feedBody({ single: 'Durante il cutover', fixed: true }) });
    assert.equal(pulled.status, 'applied');
    await sql`UPDATE calendar_backend_state SET mode = 'cutover' WHERE id = true`;
    invalidateBackendModeCache();
    try {
      recorder.take();
      await runCalendarJobsOnce({ limit: 1 });
      const job = await mirrorJob('visibile');
      assert.equal(job?.status, 'pending', 'ripetibile: torna in coda con il backoff');
      assert.match(job?.last_error ?? '', /cutover|sospese/);
      assert.ok(!recorder.take().some((r) => r.method === 'PUT'), 'nessuna PUT durante la transizione');
    } finally {
      await sql`UPDATE calendar_backend_state SET mode = 'postgres' WHERE id = true`;
      invalidateBackendModeCache();
    }
    await sql`UPDATE cal_jobs SET run_after = now() WHERE kind = 'subscription_mirror' AND status = 'pending'`;
    await runCalendarJobsOnce({ limit: 5 });
    assert.equal((await mirrorJob('visibile'))?.status, 'done');
    assert.match((await radicaleContent('visibile')).get(remoteHref('singolo@remoto'))!, /SUMMARY:Durante il cutover/);
  });
});
