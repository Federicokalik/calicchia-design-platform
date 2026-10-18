/**
 * Pull delle iscrizioni ICS verso l'indice (apps/api/src/lib/calendar/
 * subscriptions/pull.ts; design §6.6, §9, §14; contratto
 * docs/calendar-radicale/contracts/f2-modules.md §1.5, §2.7, §8.2), con un
 * server HTTP locale che serve i feed.
 *
 * Il server ascolta su 127.0.0.1, che assertPublicUrl (le difese SSRF del
 * pull legacy, riusate dal pull verso l'indice) rifiuta: le iscrizioni usano
 * l'IP pubblico di documentazione 203.0.113.10 (TEST-NET-3, accettato senza
 * DNS) e un mock di fetch riscrive solo quell'host verso il server locale. Il
 * resto (304, redirect, limiti, header condizionali, flussi) è HTTP vero.
 *
 * Casi: senza sidecar → skipped; sidecar solo con lo store Radicale o dallo
 * strumento di migrazione; prima indicizzazione (override nella risorsa del
 * master, provenienza ics_pull, nessuna versione); feed con DTSTAMP sempre
 * nuovo → zero scritture, zero versioni, index_version invariata, nessun job;
 * validatori propri (304 riconosciuto, ignorati se l'indice è cambiato, mai
 * quelli del legacy) e pull legacy intatto; modifiche e cancellazioni;
 * anti-wipe (vuoto, HTML, feed senza eventi salvo force); errori HTTP,
 * redirect verso IP privati e feed oltre 5 MB rifiutati con il fallimento
 * registrato senza 'unsyncable'; oggetto rotto in quarantena da solo, UID
 * rotto mai cancellato; specchio accodato nella stessa transazione solo per
 * le device_visible con modifiche; pullAll, body già scaricato, single-flight;
 * flag "blocca" dell'iscrizione nella query di busy; 5000 eventi invariati
 * sotto 2 s senza scritture.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, mock, test } from 'node:test';
import { overrideStoreKind } from '../../src/lib/calendar/backend-mode';
import { CalendarUnavailableError, SubscriptionValidationError } from '../../src/lib/calendar/errors';
import { remoteHref } from '../../src/lib/calendar/ics-split';
import { rematerializeCollection, stopIndexWorker } from '../../src/lib/calendar/radicale/indexer';
import {
  enableSubscriptionIndex,
  pullAllSubscriptionsToIndex,
  pullSubscriptionToIndex,
  resetSubscriptionPullCache,
  toLegacySyncResult,
} from '../../src/lib/calendar/subscriptions/pull';
import type { Calendar, CalendarSubscription } from '../../src/lib/calendar/types';
import { onBeforeDatabaseClose, sql } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';

const fx = useFixtures('subs-pull', { resetBaseline: true });

onBeforeDatabaseClose(async () => {
  overrideStoreKind(null);
  await stopIndexWorker();
});

// ─── Server dei feed ───────────────────────────────

const PUBLIC_HOST = '203.0.113.10';

interface FeedRequest {
  path: string;
  ifNoneMatch: string | null;
  ifModifiedSince: string | null;
  userAgent: string | null;
}

interface FeedReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

type FeedHandler = (req: FeedRequest) => FeedReply | Promise<FeedReply>;

class FeedServer {
  private server: Server | null = null;
  private readonly routes = new Map<string, FeedHandler>();
  private log: FeedRequest[] = [];
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const request: FeedRequest = {
        path: req.url ?? '/',
        ifNoneMatch: (req.headers['if-none-match'] as string | undefined) ?? null,
        ifModifiedSince: (req.headers['if-modified-since'] as string | undefined) ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      };
      this.log.push(request);
      const handler = this.routes.get(request.path.split('?')[0]);
      void Promise.resolve(handler ? handler(request) : { status: 404, body: 'non trovato' }).then((reply) => {
        res.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'text/calendar; charset=utf-8' });
        res.end(reply.body ?? '');
      }, (err: unknown) => {
        res.writeHead(500);
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  url(path: string): string {
    return `http://${PUBLIC_HOST}:${this.port}${path}`;
  }

  route(path: string, handler: FeedHandler): void {
    this.routes.set(path, handler);
  }

  take(): FeedRequest[] {
    const out = this.log;
    this.log = [];
    return out;
  }
}

const server = new FeedServer();
let restoreFetch: (() => void) | null = null;

before(async () => {
  await server.start();
  const realFetch = globalThis.fetch;
  const m = mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname === PUBLIC_HOST) url.hostname = '127.0.0.1';
    return realFetch(url, init);
  });
  restoreFetch = () => m.mock.restore();
});

after(async () => {
  restoreFetch?.();
  await server.stop();
});

// ─── Utilità ───────────────────────────────

let stampCounter = 0;
/** DTSTAMP sempre nuovo, come Google a ogni download. */
function freshStamp(): string {
  stampCounter++;
  const d = new Date(Date.UTC(2026, 9, 10, 0, 0, 0) + stampCounter * 1000);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function vcal(events: string[][]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Remoto',
    ...events.flatMap((props) => ['BEGIN:VEVENT', ...props, 'END:VEVENT']),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

interface RemoteEvent {
  uid: string;
  start: string;
  end: string;
  summary?: string;
  extra?: string[];
}

function vevent(e: RemoteEvent, stamp: string): string[] {
  return [`UID:${e.uid}`, `DTSTAMP:${stamp}`, `DTSTART:${e.start}`, `DTEND:${e.end}`, `SUMMARY:${e.summary ?? 'Evento remoto'}`, ...(e.extra ?? [])];
}

/** Serie settimanale con un override (Google li mette nello stesso feed). */
function weeklyWithOverride(uid: string, stamp: string): string[][] {
  return [
    [`UID:${uid}`, `DTSTAMP:${stamp}`, 'DTSTART;TZID=Europe/Rome:20270104T090000', 'DTEND;TZID=Europe/Rome:20270104T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,TH,FR', 'SUMMARY:Studio'],
    [`UID:${uid}`, `DTSTAMP:${stamp}`, 'RECURRENCE-ID;TZID=Europe/Rome:20270105T090000', 'DTSTART;TZID=Europe/Rome:20270105T150000', 'DTEND;TZID=Europe/Rome:20270105T160000', 'SUMMARY:Studio (spostato)'],
  ];
}

/** Feed mutabile servito su `path`: eventi correnti, DTSTAMP nuovo a ogni richiesta, ETag facoltativo. */
class RemoteFeed {
  events: RemoteEvent[] = [];
  series: string[] = [];
  etag: string | null = null;
  lastModified: string | null = null;
  constructor(readonly path: string) {
    server.route(path, (req) => this.reply(req));
  }

  body(): string {
    const stamp = freshStamp();
    return vcal([...this.series.flatMap((uid) => weeklyWithOverride(uid, stamp)), ...this.events.map((e) => vevent(e, stamp))]);
  }

  reply(req: FeedRequest): FeedReply {
    if (this.etag && req.ifNoneMatch === this.etag) return { status: 304, headers: { etag: this.etag } };
    const headers: Record<string, string> = { 'content-type': 'text/calendar; charset=utf-8' };
    if (this.etag) headers.etag = this.etag;
    if (this.lastModified) headers['last-modified'] = this.lastModified;
    return { status: 200, headers, body: this.body() };
  }

  get url(): string {
    return server.url(this.path);
  }
}

let calendar: Calendar;
const sidecars: string[] = [];

async function destination(): Promise<Calendar> {
  calendar ??= await fx.calendar({ key: 'dest', blocks_availability: true });
  return calendar;
}

async function subscription(name: string, url: string, opts: { visible?: boolean; sidecar?: boolean } = {}): Promise<{ sub: CalendarSubscription; sidecarId: string | null }> {
  const { subscription: sub } = await fx.subscription({ calendar: await destination(), name, url });
  if (opts.visible) await sql`UPDATE calendar_subscriptions SET device_visible = true WHERE id = ${sub.id}`;
  let sidecarId: string | null = null;
  if (opts.sidecar !== false) {
    sidecarId = await enableSubscriptionIndex(sub.id, { allowPostgresMode: true });
    fx.track('calendarIds', sidecarId);
    sidecars.push(sidecarId);
  }
  return { sub, sidecarId };
}

interface Snapshot {
  objects: Array<{ href: string; xmin: string }>;
  components: string[];
  occurrences: string[];
  indexVersion: string;
  versions: number;
  jobs: number;
}

async function snapshot(sidecarId: string, subscriptionId: string): Promise<Snapshot> {
  const objects = await sql<Array<{ href: string; xmin: string }>>`
    SELECT href, xmin::text AS xmin FROM cal_objects WHERE calendar_id = ${sidecarId} ORDER BY href
  `;
  const components = await sql<Array<{ x: string }>>`
    SELECT c.id::text || ':' || c.xmin::text AS x FROM cal_components c WHERE c.calendar_id = ${sidecarId} ORDER BY c.id
  `;
  const occurrences = await sql<Array<{ x: string }>>`
    SELECT o.object_id::text || o.recurrence_key || ':' || o.xmin::text AS x FROM cal_occurrences o WHERE o.calendar_id = ${sidecarId} ORDER BY 1
  `;
  const [state] = await sql<Array<{ index_version: string }>>`SELECT index_version::text AS index_version FROM cal_collection_state WHERE calendar_id = ${sidecarId}`;
  const [versions] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_object_versions WHERE calendar_id = ${sidecarId}`;
  const [jobs] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_jobs WHERE kind = 'subscription_mirror' AND key = ${subscriptionId}`;
  return {
    objects: Array.from(objects, (r) => ({ ...r })),
    components: components.map((r) => r.x),
    occurrences: occurrences.map((r) => r.x),
    indexVersion: state?.index_version ?? '0',
    versions: versions.n,
    jobs: jobs.n,
  };
}

async function objectsOf(sidecarId: string): Promise<Array<{ href: string; uid: string | null; health: string; health_reason: string | null; source: string; source_id: string | null; etag: string | null; origin_store: string }>> {
  return sql`
    SELECT href, uid, health, health_reason, source, source_id, etag, origin_store
    FROM cal_objects WHERE calendar_id = ${sidecarId} ORDER BY href
  `;
}

async function legacyRow(subscriptionId: string): Promise<Record<string, unknown>> {
  const [row] = await sql`
    SELECT etag, last_modified, last_synced_at, last_error, event_count,
           (SELECT count(*)::int FROM calendar_events e WHERE e.subscription_id = s.id) AS legacy_events
    FROM calendar_subscriptions s WHERE s.id = ${subscriptionId}
  `;
  return { ...row };
}

async function collectionState(sidecarId: string): Promise<{ health: string; consecutive_failures: number; last_error: string | null; dirty_since: Date | null; last_synced_at: Date | null; origin_store: string }> {
  const [row] = await sql<Array<{ health: string; consecutive_failures: number; last_error: string | null; dirty_since: Date | null; last_synced_at: Date | null; origin_store: string }>>`
    SELECT health, consecutive_failures, last_error, dirty_since, last_synced_at, origin_store FROM cal_collection_state WHERE calendar_id = ${sidecarId}
  `;
  assert.ok(row, 'riga di stato del sidecar assente');
  return row;
}

// ─── Sidecar ───────────────────────────────

describe('sidecar dell\'iscrizione (enableSubscriptionIndex)', () => {
  test('senza sidecar il pull è skipped; in mode postgres il sidecar si crea solo dallo strumento di migrazione', async () => {
    const feed = new RemoteFeed('/senza-sidecar.ics');
    feed.events = [{ uid: 'x@remoto', start: '20270104T080000Z', end: '20270104T090000Z' }];
    const { sub } = await subscription('Senza sidecar', feed.url, { sidecar: false });
    server.take();
    const r = await pullSubscriptionToIndex(sub.id);
    assert.deepEqual([r.status, r.calendarId, r.error], ['skipped', null, null]);
    assert.equal(server.take().length, 0, 'nessuna richiesta al feed');

    // mode postgres (baseline): listCalendars legacy mostrerebbe la riga → rifiutato.
    await assert.rejects(enableSubscriptionIndex(sub.id), (err: unknown) => err instanceof CalendarUnavailableError && err.reason === 'transition');
    const [none] = await sql<Array<{ collection_calendar_id: string | null }>>`SELECT collection_calendar_id FROM calendar_subscriptions WHERE id = ${sub.id}`;
    assert.equal(none.collection_calendar_id, null);

    // Store Radicale: ammesso, idempotente.
    overrideStoreKind('radicale');
    try {
      const id = await enableSubscriptionIndex(sub.id);
      fx.track('calendarIds', id);
      assert.equal(await enableSubscriptionIndex(sub.id), id, 'idempotente');
      const hex8 = sub.id.replace(/-/g, '').slice(0, 8);
      const [row] = await sql`
        SELECT slug, collection_name, role, origin, lifecycle, parent_calendar_id, device_visible, components,
               ics_feed_enabled, blocks_availability, is_system, timezone
        FROM calendars WHERE id = ${id}
      `;
      assert.deepEqual({ ...row }, {
        slug: `sub-${hex8}`,
        collection_name: `sub-${hex8}`,
        role: 'subscription',
        origin: 'admin',
        lifecycle: 'active',
        parent_calendar_id: calendar.id,
        device_visible: false,
        components: ['VEVENT'],
        ics_feed_enabled: false,
        blocks_availability: false,
        is_system: false,
        timezone: calendar.timezone,
      });
      const st = await collectionState(id);
      assert.equal(st.origin_store, 'remote');
      const [linked] = await sql<Array<{ collection_calendar_id: string }>>`SELECT collection_calendar_id FROM calendar_subscriptions WHERE id = ${sub.id}`;
      assert.equal(linked.collection_calendar_id, id);
      // La riconciliazione del sidecar non lo segnala come orfano.
      await sql`SELECT * FROM calendar_sidecar_reconcile()`;
      const [review] = await sql<Array<{ needs_review: boolean }>>`SELECT needs_review FROM calendars WHERE id = ${id}`;
      assert.equal(review.needs_review, false);
    } finally {
      overrideStoreKind(null);
    }
    await assert.rejects(enableSubscriptionIndex('00000000-0000-4000-8000-000000000000', { allowPostgresMode: true }), SubscriptionValidationError);
  });
});

// ─── Pull ───────────────────────────────

describe('pull verso l\'indice', () => {
  test('prima indicizzazione: override nella risorsa del master, ics_pull, nessuna versione; legacy intatto', async () => {
    const feed = new RemoteFeed('/prima.ics');
    feed.series = ['serie@google.com'];
    feed.events = [{ uid: 'singolo@google.com', start: '20270106T080000Z', end: '20270106T090000Z' }];
    const { sub, sidecarId } = await subscription('Prima', feed.url);
    const legacyBefore = await legacyRow(sub.id);
    server.take();

    const r = await pullSubscriptionToIndex(sub.id);
    assert.equal(r.status, 'applied');
    assert.deepEqual([r.calendarId, r.upserted, r.deleted, r.unchanged, r.errors, r.quarantined, r.error], [sidecarId, 2, 0, 0, 0, 0, null]);
    const reqs = server.take();
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].ifNoneMatch, null);
    assert.equal(reqs[0].userAgent, 'Caldes-Calendar-Subscriber/1.0', 'stesso User-Agent del pull legacy');

    const objects = await objectsOf(sidecarId!);
    assert.deepEqual(objects.map((o) => [o.href, o.uid, o.health, o.source, o.source_id, o.etag, o.origin_store]), [
      [remoteHref('serie@google.com'), 'serie@google.com', 'ok', 'ics_pull', 'serie@google.com', null, 'remote'],
      [remoteHref('singolo@google.com'), 'singolo@google.com', 'ok', 'ics_pull', 'singolo@google.com', null, 'remote'],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const [override] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_components WHERE calendar_id = ${sidecarId} AND recurrence_key <> ''
    `;
    assert.equal(override.n, 1, 'l\'override sta nella risorsa del master (il parser legacy lo perdeva)');
    const [moved] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_occurrences WHERE calendar_id = ${sidecarId} AND start_utc = '2027-01-05T14:00:00Z' AND kind = 'override'
    `;
    assert.equal(moved.n, 1);
    const snap = await snapshot(sidecarId!, sub.id);
    assert.equal(snap.versions, 0, 'nessuna versione per le iscrizioni');
    assert.equal(snap.jobs, 0, 'iscrizione non visibile: nessuno specchio');
    const st = await collectionState(sidecarId!);
    assert.deepEqual([st.health, st.consecutive_failures], ['healthy', 0]);
    assert.ok(st.last_synced_at);

    // Il pull legacy non è stato toccato: stessa riga dell'iscrizione, nessun evento legacy.
    assert.deepEqual(await legacyRow(sub.id), legacyBefore);
    assert.deepEqual(toLegacySyncResult(r), { notModified: false, inserted: 2, removed: 0, error: null });
  });

  test('DTSTAMP sempre nuovo: zero scritture, zero versioni, index_version invariata, nessun job (anche visibile)', async () => {
    const feed = new RemoteFeed('/dtstamp.ics');
    feed.series = ['studio@google.com'];
    feed.events = Array.from({ length: 5 }, (_, i) => ({ uid: `ev-${i}@google.com`, start: `2027011${i}T080000Z`, end: `2027011${i}T090000Z` }));
    const { sub, sidecarId } = await subscription('DTSTAMP', feed.url, { visible: true });
    const first = await pullSubscriptionToIndex(sub.id);
    assert.equal(first.status, 'applied');
    await sql`DELETE FROM cal_jobs WHERE kind = 'subscription_mirror' AND key = ${sub.id}`;
    const before = await snapshot(sidecarId!, sub.id);

    for (let i = 0; i < 3; i++) {
      const again = await pullSubscriptionToIndex(sub.id);
      assert.deepEqual([again.status, again.upserted, again.deleted, again.unchanged], ['unchanged', 0, 0, 6]);
    }
    const afterSnap = await snapshot(sidecarId!, sub.id);
    assert.deepEqual(afterSnap, before, 'nessuna riga di oggetti, componenti od occorrenze riscritta, nessuna versione né job');
  });

  test('validatori propri: 304 riconosciuto; force e indice cambiato scaricano tutto; Last-Modified', async () => {
    const feed = new RemoteFeed('/etag.ics');
    feed.etag = '"v1"';
    feed.lastModified = 'Fri, 09 Oct 2026 06:00:00 GMT';
    feed.events = [{ uid: 'a@remoto', start: '20270104T080000Z', end: '20270104T090000Z' }];
    const { sub, sidecarId } = await subscription('ETag', feed.url);
    server.take();
    assert.equal((await pullSubscriptionToIndex(sub.id)).status, 'applied');
    assert.equal(server.take()[0].ifNoneMatch, null);

    const before = await snapshot(sidecarId!, sub.id);
    const nm = await pullSubscriptionToIndex(sub.id);
    assert.equal(nm.status, 'not_modified');
    const req = server.take()[0];
    assert.deepEqual([req.ifNoneMatch, req.ifModifiedSince], ['"v1"', 'Fri, 09 Oct 2026 06:00:00 GMT']);
    assert.deepEqual(await snapshot(sidecarId!, sub.id), before);
    assert.deepEqual(toLegacySyncResult(nm), { notModified: true, inserted: 0, removed: 0, error: null });

    // force: niente header condizionali.
    assert.equal((await pullSubscriptionToIndex(sub.id, { force: true })).status, 'unchanged');
    assert.equal(server.take()[0].ifNoneMatch, null);

    // L'indice del sidecar cambia per altre vie (rimaterializzazione): i validatori non valgono più.
    await rematerializeCollection(sidecarId!, { horizon: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2028-06-01T00:00:00Z') }, reason: 'horizon' });
    assert.equal((await pullSubscriptionToIndex(sub.id)).status, 'unchanged');
    assert.equal(server.take()[0].ifNoneMatch, null, 'mai un 304 su un indice diverso da quello scritto dal pull');

    // Cambia il feed (nuovo ETag): 200 con il contenuto nuovo.
    feed.etag = '"v2"';
    feed.events.push({ uid: 'b@remoto', start: '20270105T080000Z', end: '20270105T090000Z' });
    const changed = await pullSubscriptionToIndex(sub.id);
    assert.deepEqual([changed.status, changed.upserted], ['applied', 1]);
    assert.equal(server.take()[0].ifNoneMatch, '"v1"');

    // Dopo resetSubscriptionPullCache si riscarica senza header.
    resetSubscriptionPullCache(sub.id);
    await pullSubscriptionToIndex(sub.id);
    assert.equal(server.take()[0].ifNoneMatch, null);
    // Il legacy non vede i validatori dell'indice.
    const legacy = await legacyRow(sub.id);
    assert.deepEqual([legacy.etag, legacy.last_modified], [null, null]);
  });

  test('modifiche e cancellazioni: solo gli oggetti cambiati, id stabile, cancellazione del UID sparito', async () => {
    const feed = new RemoteFeed('/modifiche.ics');
    feed.events = [
      { uid: 'resta@remoto', start: '20270104T080000Z', end: '20270104T090000Z' },
      { uid: 'cambia@remoto', start: '20270105T080000Z', end: '20270105T090000Z' },
      { uid: 'sparisce@remoto', start: '20270106T080000Z', end: '20270106T090000Z' },
    ];
    const { sub, sidecarId } = await subscription('Modifiche', feed.url);
    await pullSubscriptionToIndex(sub.id);
    const ids = new Map((await sql<Array<{ href: string; id: string }>>`SELECT href, id FROM cal_objects WHERE calendar_id = ${sidecarId}`).map((r) => [r.href, r.id]));
    const before = await snapshot(sidecarId!, sub.id);

    feed.events = [
      { uid: 'resta@remoto', start: '20270104T080000Z', end: '20270104T090000Z' },
      { uid: 'cambia@remoto', start: '20270105T100000Z', end: '20270105T110000Z', summary: 'Spostato' },
    ];
    const r = await pullSubscriptionToIndex(sub.id);
    assert.deepEqual([r.status, r.upserted, r.deleted, r.unchanged], ['applied', 1, 1, 1]);
    const objects = await sql<Array<{ href: string; id: string; xmin: string }>>`SELECT href, id, xmin::text AS xmin FROM cal_objects WHERE calendar_id = ${sidecarId} ORDER BY href`;
    assert.deepEqual(objects.map((o) => o.href).sort(), [remoteHref('cambia@remoto'), remoteHref('resta@remoto')].sort());
    for (const o of objects) assert.equal(o.id, ids.get(o.href), 'id stabile');
    const resta = objects.find((o) => o.href === remoteHref('resta@remoto'))!;
    assert.equal(resta.xmin, before.objects.find((o) => o.href === remoteHref('resta@remoto'))!.xmin, 'l\'oggetto invariato non viene riscritto');
    const [moved] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_occurrences WHERE calendar_id = ${sidecarId} AND start_utc = '2027-01-05T10:00:00Z'
    `;
    assert.equal(moved.n, 1);
    assert.ok(Number((await snapshot(sidecarId!, sub.id)).indexVersion) > Number(before.indexVersion));
  });

  test('anti-wipe: feed senza eventi rifiutato (indice intatto) salvo force; vuoto e HTML rifiutati sempre', async () => {
    const feed = new RemoteFeed('/antiwipe.ics');
    feed.events = [{ uid: 'a@remoto', start: '20270104T080000Z', end: '20270104T090000Z' }, { uid: 'b@remoto', start: '20270105T080000Z', end: '20270105T090000Z' }];
    const { sub, sidecarId } = await subscription('Anti-wipe', feed.url);
    await pullSubscriptionToIndex(sub.id);
    const before = await snapshot(sidecarId!, sub.id);

    feed.events = [];
    const rejected = await pullSubscriptionToIndex(sub.id);
    assert.equal(rejected.status, 'rejected');
    assert.match(rejected.error ?? '', /anti-wipe/);
    assert.deepEqual(await snapshot(sidecarId!, sub.id), before, 'indice intatto');
    const st = await collectionState(sidecarId!);
    assert.equal(st.consecutive_failures, 1);
    assert.notEqual(st.health, 'unsyncable', 'un\'iscrizione non porta mai a unsyncable (fuori dal set di freschezza)');
    assert.equal(st.dirty_since, null);
    assert.equal(toLegacySyncResult(rejected).error, rejected.error);

    // Corpo vuoto e pagina HTML: rifiutati anche con force.
    server.route('/antiwipe-vuoto.ics', () => ({ status: 200, body: '' }));
    server.route('/antiwipe-html.ics', () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<!DOCTYPE html><html><body>Accedi</body></html>' }));
    for (const path of ['/antiwipe-vuoto.ics', '/antiwipe-html.ics']) {
      await sql`UPDATE calendar_subscriptions SET ics_url = ${server.url(path)} WHERE id = ${sub.id}`;
      const r = await pullSubscriptionToIndex(sub.id, { force: true });
      assert.equal(r.status, 'rejected', path);
      assert.deepEqual((await snapshot(sidecarId!, sub.id)).objects, before.objects);
    }
    assert.equal((await collectionState(sidecarId!)).consecutive_failures, 3);

    // Un feed valido servito come text/html (CMS mal configurato) non è una pagina HTML.
    server.route('/antiwipe-ics-come-html.ics', (req) => ({ ...feed.reply(req), headers: { 'content-type': 'text/html; charset=utf-8' } }));
    await sql`UPDATE calendar_subscriptions SET ics_url = ${server.url('/antiwipe-ics-come-html.ics')} WHERE id = ${sub.id}`;
    feed.events = [{ uid: 'a@remoto', start: '20270104T080000Z', end: '20270104T090000Z' }, { uid: 'b@remoto', start: '20270105T080000Z', end: '20270105T090000Z' }];
    assert.equal((await pullSubscriptionToIndex(sub.id)).status, 'unchanged');
    assert.equal((await collectionState(sidecarId!)).consecutive_failures, 0);
    feed.events = [];

    // force con un feed legittimamente vuoto: svuota l'indice e azzera i fallimenti.
    await sql`UPDATE calendar_subscriptions SET ics_url = ${feed.url} WHERE id = ${sub.id}`;
    const forced = await pullSubscriptionToIndex(sub.id, { force: true });
    assert.deepEqual([forced.status, forced.deleted], ['applied', 2]);
    assert.equal((await objectsOf(sidecarId!)).length, 0);
    assert.deepEqual([(await collectionState(sidecarId!)).consecutive_failures, (await collectionState(sidecarId!)).last_error], [0, null]);
  });

  test('errori remoti: HTTP 500, redirect verso IP privato, URL locale, feed oltre 5 MB, troncato → rifiutati, indice intatto', async () => {
    const feed = new RemoteFeed('/errori.ics');
    feed.events = [{ uid: 'a@remoto', start: '20270104T080000Z', end: '20270104T090000Z' }];
    const { sub, sidecarId } = await subscription('Errori', feed.url);
    await pullSubscriptionToIndex(sub.id);
    const before = await snapshot(sidecarId!, sub.id);

    server.route('/errori-500.ics', () => ({ status: 500, body: 'errore' }));
    server.route('/errori-redirect.ics', () => ({ status: 302, headers: { location: 'http://10.0.0.5/feed.ics' } }));
    server.route('/errori-redirect-ok.ics', () => ({ status: 301, headers: { location: '/errori.ics' } }));
    server.route('/errori-grande.ics', () => ({ status: 200, body: Buffer.alloc(5 * 1024 * 1024 + 10, 'A') }));
    server.route('/errori-troncato.ics', () => ({ status: 200, body: feed.body().replace('END:VCALENDAR\r\n', '') }));
    const cases: Array<[string, RegExp]> = [
      [server.url('/errori-500.ics'), /HTTP 500/],
      [server.url('/errori-redirect.ics'), /privato/i],
      ['http://127.0.0.1/feed.ics', /privato/i],
      ['http://localhost/feed.ics', /privato/i],
      [server.url('/errori-grande.ics'), /5MB/],
      [server.url('/errori-troncato.ics'), /non valido/],
      [`http://${PUBLIC_HOST}:1/feed.ics`, /non raggiungibile/],
    ];
    let failures = 0;
    for (const [url, re] of cases) {
      await sql`UPDATE calendar_subscriptions SET ics_url = ${url} WHERE id = ${sub.id}`;
      const r = await pullSubscriptionToIndex(sub.id);
      failures++;
      assert.equal(r.status, 'rejected', url);
      assert.match(r.error ?? '', re, url);
      assert.deepEqual((await snapshot(sidecarId!, sub.id)).objects, before.objects, url);
    }
    const st = await collectionState(sidecarId!);
    assert.equal(st.consecutive_failures, failures);
    assert.notEqual(st.health, 'unsyncable');

    // Un redirect verso un host pubblico va bene (rivalidato a ogni hop).
    await sql`UPDATE calendar_subscriptions SET ics_url = ${server.url('/errori-redirect-ok.ics')} WHERE id = ${sub.id}`;
    const ok = await pullSubscriptionToIndex(sub.id);
    assert.equal(ok.status, 'unchanged');
    assert.equal((await collectionState(sidecarId!)).consecutive_failures, 0);
  });

  test('oggetto rotto in quarantena da solo; UID rotto mai cancellato; senza UID scartato', async () => {
    const feed = new RemoteFeed('/rotti.ics');
    feed.events = [
      { uid: 'buono@remoto', start: '20270104T080000Z', end: '20270104T090000Z' },
      { uid: 'rrule@remoto', start: '20270105T080000Z', end: '20270105T090000Z' },
      { uid: 'doppio@remoto', start: '20270106T080000Z', end: '20270106T090000Z' },
    ];
    const { sub, sidecarId } = await subscription('Rotti', feed.url);
    assert.equal((await pullSubscriptionToIndex(sub.id)).status, 'applied');
    const [occBefore] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM cal_occurrences o JOIN cal_objects x ON x.id = o.object_id
      WHERE x.calendar_id = ${sidecarId} AND x.href = ${remoteHref('doppio@remoto')}
    `;

    // RRULE invalida su uno, master duplicato sull'altro, un VEVENT senza UID.
    feed.events = [
      { uid: 'buono@remoto', start: '20270104T080000Z', end: '20270104T090000Z' },
      { uid: 'rrule@remoto', start: '20270105T080000Z', end: '20270105T090000Z', extra: ['RRULE:FREQ=WEEKLY;BYDAY=XX'] },
      { uid: 'doppio@remoto', start: '20270106T080000Z', end: '20270106T090000Z' },
      { uid: 'doppio@remoto', start: '20270107T080000Z', end: '20270107T090000Z', summary: 'Secondo master' },
    ];
    server.route('/rotti-senza-uid.ics', () => ({
      status: 200,
      body: feed.body().replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20270108T080000Z\r\nDTEND:20270108T090000Z\r\nSUMMARY:Senza UID\r\nEND:VEVENT\r\nEND:VCALENDAR'),
    }));
    await sql`UPDATE calendar_subscriptions SET ics_url = ${server.url('/rotti-senza-uid.ics')} WHERE id = ${sub.id}`;
    const r = await pullSubscriptionToIndex(sub.id);
    assert.equal(r.status, 'applied', 'un oggetto rotto non è mai un errore del pull');
    assert.equal(r.error, null);
    assert.equal(r.errors, 2, 'UID non componibile + componente senza UID');
    assert.equal(r.quarantined, 2);
    const objects = new Map((await objectsOf(sidecarId!)).map((o) => [o.href, o]));
    assert.equal(objects.size, 3, 'nessuna cancellazione: il UID rotto resta');
    assert.equal(objects.get(remoteHref('buono@remoto'))?.health, 'ok');
    assert.deepEqual([objects.get(remoteHref('rrule@remoto'))?.health, objects.get(remoteHref('rrule@remoto'))?.health_reason], ['quarantined', 'invalid-rrule']);
    assert.equal(objects.get(remoteHref('doppio@remoto'))?.health, 'quarantined');
    // Senza versioni restano (stale) le occorrenze già indicizzate: il busy non si svuota.
    const [occAfter] = await sql<Array<{ n: number; stale: number }>>`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE o.stale)::int AS stale FROM cal_occurrences o JOIN cal_objects x ON x.id = o.object_id
      WHERE x.calendar_id = ${sidecarId} AND x.href = ${remoteHref('doppio@remoto')}
    `;
    assert.deepEqual([occAfter.n, occAfter.stale], [occBefore.n, occBefore.n]);

    // Lo stesso feed rotto al pull successivo: nessuna riscrittura.
    const before = await snapshot(sidecarId!, sub.id);
    const again = await pullSubscriptionToIndex(sub.id);
    assert.deepEqual([again.status, again.upserted], ['unchanged', 0]);
    assert.deepEqual(await snapshot(sidecarId!, sub.id), before);
  });

  test('specchio: accodato nella transazione dell\'indice solo per le device_visible con modifiche, priorità bassa', async () => {
    const feed = new RemoteFeed('/specchio.ics');
    feed.events = [{ uid: 'a@remoto', start: '20270104T080000Z', end: '20270104T090000Z' }];
    const visible = await subscription('Visibile', feed.url, { visible: true });
    const hidden = await subscription('Nascosta', feed.url);

    const r = await pullSubscriptionToIndex(visible.sub.id);
    const [job] = await sql<Array<{ status: string; priority: number; source_version: string; payload: { indexVersion: string } }>>`
      SELECT status, priority, source_version, payload FROM cal_jobs WHERE kind = 'subscription_mirror' AND key = ${visible.sub.id}
    `;
    assert.ok(job, 'job di specchio accodato');
    assert.deepEqual([job.status, job.priority], ['pending', 200]);
    const st = await snapshot(visible.sidecarId!, visible.sub.id);
    assert.equal(job.source_version, st.indexVersion, 'source_version = index_version del sidecar');
    assert.equal(job.payload.indexVersion, st.indexVersion);
    assert.equal(r.status, 'applied');

    await pullSubscriptionToIndex(hidden.sub.id);
    assert.equal((await snapshot(hidden.sidecarId!, hidden.sub.id)).jobs, 0, 'iscrizione non visibile: nessun job');

    // Una seconda modifica si fonde nel pending (coalescenza) con la versione nuova.
    feed.events.push({ uid: 'b@remoto', start: '20270105T080000Z', end: '20270105T090000Z' });
    await pullSubscriptionToIndex(visible.sub.id);
    const jobs = await sql<Array<{ source_version: string }>>`SELECT source_version FROM cal_jobs WHERE kind = 'subscription_mirror' AND key = ${visible.sub.id}`;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].source_version, (await snapshot(visible.sidecarId!, visible.sub.id)).indexVersion);
  });

  test('pullAll, body già scaricato, single-flight, esito sulla riga solo con lo store Radicale', async () => {
    const feed = new RemoteFeed('/tutte.ics');
    feed.events = [{ uid: 'a@remoto', start: '20270104T080000Z', end: '20270104T090000Z' }];
    const enabled = await subscription('Abilitata', feed.url);
    const disabled = await subscription('Disabilitata', feed.url);
    await sql`UPDATE calendar_subscriptions SET sync_enabled = false WHERE id = ${disabled.sub.id}`;
    const noSidecar = await subscription('Senza indice', feed.url, { sidecar: false });

    const all = await pullAllSubscriptionsToIndex();
    const ids = all.map((r) => r.subscriptionId);
    assert.ok(ids.includes(enabled.sub.id));
    assert.ok(!ids.includes(disabled.sub.id), 'sync_enabled = false esclusa');
    assert.ok(!ids.includes(noSidecar.sub.id), 'senza sidecar esclusa');

    // body già scaricato (per esempio dal pull legacy): nessuna richiesta HTTP.
    server.take();
    const withBody = await pullSubscriptionToIndex(disabled.sub.id, { body: feed.body() });
    assert.equal(withBody.status, 'applied');
    assert.equal(server.take().length, 0);

    // Single-flight: due chiamate contemporanee, una sola richiesta.
    server.route('/lento.ics', async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return feed.reply(req);
    });
    await sql`UPDATE calendar_subscriptions SET ics_url = ${server.url('/lento.ics')} WHERE id = ${enabled.sub.id}`;
    server.take();
    const [x, y] = await Promise.all([pullSubscriptionToIndex(enabled.sub.id), pullSubscriptionToIndex(enabled.sub.id)]);
    assert.equal(x, y);
    assert.equal(server.take().length, 1);

    // Esito sulla riga dell'iscrizione: mai in mode postgres, sì con lo store Radicale.
    const legacyBefore = await legacyRow(enabled.sub.id);
    await pullSubscriptionToIndex(enabled.sub.id, { updateSubscriptionRow: true, force: true });
    assert.deepEqual(await legacyRow(enabled.sub.id), legacyBefore, 'mode postgres: la riga resta del pull legacy');
    overrideStoreKind('radicale');
    try {
      await pullSubscriptionToIndex(enabled.sub.id, { updateSubscriptionRow: true, force: true });
    } finally {
      overrideStoreKind(null);
    }
    const row = await legacyRow(enabled.sub.id);
    assert.deepEqual([row.event_count, row.last_error, row.etag, row.last_modified], [1, null, null, null]);
    assert.ok(row.last_synced_at);
  });

  test('flag "blocca": l\'iscrizione entra nel busy (query del design §7) solo se bloccano sia lei sia il calendario di destinazione', async () => {
    const feed = new RemoteFeed('/blocca.ics');
    feed.events = [{ uid: 'busy@remoto', start: '20270111T080000Z', end: '20270111T090000Z' }];
    const { sub, sidecarId } = await subscription('Blocca', feed.url);
    await pullSubscriptionToIndex(sub.id);
    const busy = async (): Promise<number> => {
      const [row] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM cal_occurrences o
        JOIN calendars c ON c.id = o.calendar_id
        LEFT JOIN calendars p ON p.id = c.parent_calendar_id
        LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
        WHERE o.blocks
          AND CASE WHEN c.role = 'subscription'
                   THEN COALESCE(s.blocks_availability, false) AND p.blocks_availability
                   ELSE c.blocks_availability END
          AND o.span && tstzrange('2027-01-11T00:00:00Z', '2027-01-12T00:00:00Z', '[)')
          AND o.calendar_id = ${sidecarId}
      `;
      return row.n;
    };
    assert.equal(await busy(), 0, 'default: l\'iscrizione non blocca (decisione 5)');
    await sql`UPDATE calendar_subscriptions SET blocks_availability = true WHERE id = ${sub.id}`;
    assert.equal(await busy(), 1);
    await sql`UPDATE calendars SET blocks_availability = false WHERE id = ${calendar.id}`;
    assert.equal(await busy(), 0, 'il calendario di destinazione non blocca');
    await sql`UPDATE calendars SET blocks_availability = true WHERE id = ${calendar.id}`;
  });

  test('5000 eventi invariati: pull sotto 2 s senza scritture', async () => {
    const feed = new RemoteFeed('/grande.ics');
    feed.events = Array.from({ length: 5000 }, (_, i) => {
      const start = new Date(Date.UTC(2027, 0, 4, 8) + i * 7 * 3_600_000);
      const end = new Date(start.getTime() + 3_600_000);
      const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      return { uid: `ev-${i}@google.com`, start: f(start), end: f(end), summary: `Evento ${i}` };
    });
    const { sub, sidecarId } = await subscription('Grande', feed.url);
    const first = await pullSubscriptionToIndex(sub.id);
    assert.deepEqual([first.status, first.upserted], ['applied', 5000]);
    const before = await snapshot(sidecarId!, sub.id);
    const again = await pullSubscriptionToIndex(sub.id);
    assert.deepEqual([again.status, again.upserted, again.unchanged], ['unchanged', 0, 5000]);
    assert.ok(again.durationMs < 2000, `pull invariato di 5000 eventi in ${again.durationMs} ms`);
    const afterSnap = await snapshot(sidecarId!, sub.id);
    assert.deepEqual([afterSnap.indexVersion, afterSnap.versions, afterSnap.objects.length], [before.indexVersion, 0, 5000]);
    assert.deepEqual(afterSnap.objects, before.objects);
  });
});
