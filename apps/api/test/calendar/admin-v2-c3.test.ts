/**
 * Route della tranche C, passo C3, dell'API admin del calendario v2 (salute e
 * vista; contratto docs/calendar-radicale/contracts/f6-modules.md §9.1.5,
 * §9.1.6, §9.7, §9.9), senza Radicale.
 *
 * Casi: JWT admin (401), difesa CSRF (403, 415) e mode postgres (409
 * STORE_MODE_UNSUPPORTED) su ogni route nuova; flag di capacità; finestra di
 * /occurrences e /overlays (mancante, invertita, oltre 100 giorni → 400; 100
 * giorni esatti → 200); badge (orfano, quarantena, hold, conservativo, nuovo
 * dal dispositivo); festività, chiusure e iscrizioni solo in /overlays (e in
 * /occurrences solo con calendar_id esplicito); azioni di hold: NOT_IN_HOLD,
 * conferma errata, Idempotency-Key (mancante, nel corpo, stessa chiave → stesso
 * job, corpo diverso → 409), plan_hash mancante o diverso → PLAN_CHANGED;
 * /sync-state con collezioni, quarantena, job morti, conflitti e backup.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
  CAL_V2_HOLD_CONFIRMATIONS,
  CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS,
  type CalV2HoldPlan,
  type CalV2JobAccepted,
  type CalV2JobView,
  type CalV2OccurrenceList,
  type CalV2OverlayList,
  type CalV2SyncState,
} from '@calicchia/shared';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { RadicaleClient, TransportError } from '../../src/lib/calendar/radicale/client';
import { configureRadicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import { onBeforeDatabaseClose, onDatabaseReady, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';

useTestDatabase({ resetBaseline: true });

async function cleanupSeeds(): Promise<void> {
  await sql`DELETE FROM cal_jobs WHERE kind IN ('calendar_hold_apply', 'calendar_hold_rebuild') OR key LIKE 'c3-unit-%'`;
  await sql`DELETE FROM cal_booking_conflicts WHERE booking_uid LIKE 'c3-unit-%'`;
}
onDatabaseReady(async () => {
  overrideCalendarStore(null);
  await cleanupSeeds();
});
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  configureRadicaleRuntime(null);
  await cleanupSeeds();
  await sql`UPDATE calendar_backend_state SET last_stack_backup = NULL WHERE id`;
  await resetCalendarBaseline();
});
const fx = useFixtures('admin-v2-c3');

const BASE = '/api/admin/calendar/v2';
const VOLUME = '3c1e2d4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ANY_ID = '5f0c2b7e-9a41-4d6c-8e3b-2a7d1c9f4e60';
/** Finestra lontana da ogni altro dato del database. */
const WIN = { from: '2032-03-01T00:00:00Z', to: '2032-03-31T00:00:00Z' };

async function setState(mode: string): Promise<void> {
  await sql`
    UPDATE calendar_backend_state
    SET mode = ${mode}, write_freeze = false,
        volume_id = ${mode === 'postgres' ? null : VOLUME}, epoch = ${mode === 'postgres' ? 0 : 1}
    WHERE id
  `;
  invalidateBackendModeCache();
}

function offlineRadicale(): void {
  const client = new RadicaleClient({
    baseUrl: 'http://127.0.0.1:9',
    password: 'test-only-offline',
    retries: 0,
    timeoutMs: 1_000,
    transport: async () => {
      throw new TransportError('network', 'Radicale non raggiungibile (test senza rete)', false, 'ECONNREFUSED');
    },
  });
  configureRadicaleRuntime({ client, principal: 'federico', watch: 'off', identitySource: 'remote' });
}

async function auditCount(): Promise<number> {
  const [row] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM audit_logs WHERE metadata->>'operation' LIKE 'v2.%'`;
  return Number(row.n);
}

/** Calendario di prova: si crea con lo store del database (con Radicale offline la MKCALENDAR fallirebbe). */
async function mk(key: string, patch: { role?: string; needsReview?: boolean } = {}): Promise<{ id: string }> {
  overrideCalendarStore(null);
  await setState('postgres');
  const cal = await fx.calendar({ key });
  if (patch.role) await sql`UPDATE calendars SET role = ${patch.role} WHERE id = ${cal.id}::uuid`;
  if (patch.needsReview) await sql`UPDATE calendars SET needs_review = true, review_reason = 'new_collection' WHERE id = ${cal.id}::uuid`;
  return cal;
}

async function toRadicale(): Promise<void> {
  offlineRadicale();
  await setState('radicale');
  overrideCalendarStore('radicale');
}

interface SeedOpts {
  summary?: string;
  start: string;
  end: string;
  kind?: string;
  status?: string;
  health?: 'ok' | 'quarantined';
  stale?: boolean;
  /** Chiave dell'istanza (default ''). */
  key?: string;
  orphan?: boolean;
  blocks?: boolean;
  recurring?: boolean;
  raw?: string;
  href?: string;
  allDay?: boolean;
  startDate?: string;
  endDate?: string;
  /** Oggetto senza occorrenze materializzate (oltre l'orizzonte): le espande al volo la route. */
  noOccurrence?: boolean;
}

/** Riga d'indice minima (id, oggetto, componente, occorrenza) come la lascia l'indicizzatore. */
async function seed(calendarId: string, uid: string, o: SeedOpts): Promise<string> {
  const href = o.href ?? `${uid}.ics`;
  const key = o.key ?? '';
  const [obj] = await sql<Array<{ id: string }>>`
    INSERT INTO cal_object_ids (calendar_id, href, uid) VALUES (${calendarId}::uuid, ${href}, ${uid})
    ON CONFLICT (calendar_id, href, recurrence_key) DO UPDATE SET uid = EXCLUDED.uid RETURNING id
  `;
  const health = o.health ?? 'ok';
  await sql`
    INSERT INTO cal_objects (id, calendar_id, href, uid, etag, raw_ics, origin_store, health, health_reason, health_since, is_recurring, range_start, range_end)
    VALUES (${obj.id}::uuid, ${calendarId}::uuid, ${href}, ${uid}, '"seed"', ${o.raw ?? null}, 'radicale', ${health},
            ${health === 'ok' ? null : 'parse-error'}, ${health === 'ok' ? null : sql`now()`}, ${o.recurring ?? false},
            ${o.start}::timestamptz, ${o.end}::timestamptz)
    ON CONFLICT (id) DO NOTHING
  `;
  let componentId: string | null = obj.id;
  if (key !== '' && key !== 'conservative') {
    const [cid] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_object_ids (calendar_id, href, recurrence_key, uid) VALUES (${calendarId}::uuid, ${href}, ${key}, ${uid}) RETURNING id
    `;
    componentId = cid.id;
  }
  if (key !== 'conservative') {
    await sql`
      INSERT INTO cal_components (id, object_id, calendar_id, recurrence_key, uid, summary, status, start_utc, end_utc, recurrence_id_utc, orphan)
      VALUES (${componentId}::uuid, ${obj.id}::uuid, ${calendarId}::uuid, ${key}, ${uid}, ${o.summary ?? 'Evento'}, ${o.status ?? 'confirmed'},
              ${o.start}::timestamptz, ${o.end}::timestamptz, ${key === '' ? null : sql`${o.start}::timestamptz`}, ${o.orphan ?? false})
    `;
  } else {
    componentId = null;
  }
  if (o.noOccurrence) return obj.id;
  await sql`
    INSERT INTO cal_occurrences (object_id, recurrence_key, component_id, calendar_id, start_utc, end_utc, all_day, start_date, end_date, status, kind, blocks, stale)
    VALUES (${obj.id}::uuid, ${key}, ${componentId}, ${calendarId}::uuid, ${o.start}::timestamptz, ${o.end}::timestamptz, ${o.allDay ?? false},
            ${o.startDate ?? null}::date, ${o.endDate ?? null}::date, ${o.status ?? 'confirmed'}, ${o.kind ?? 'event'}, ${o.blocks ?? true}, ${o.stale ?? false})
  `;
  return obj.id;
}

async function setHold(calendarId: string, pending: string[], reason = 'mass-delete'): Promise<void> {
  await sql`
    INSERT INTO cal_collection_state (calendar_id, health, hold_reason, hold_since, pending_deletions, last_synced_at, horizon_start, horizon_end)
    VALUES (${calendarId}::uuid, 'hold', ${reason}, now(), ${pending}::text[], now(), now() - interval '30 days', now() + interval '10 years')
    ON CONFLICT (calendar_id) DO UPDATE SET health = 'hold', hold_reason = ${reason}, hold_since = now(), pending_deletions = ${pending}::text[]
  `;
}

async function setHealthy(calendarId: string): Promise<void> {
  await sql`
    INSERT INTO cal_collection_state (calendar_id, health, last_synced_at, horizon_start, horizon_end)
    VALUES (${calendarId}::uuid, 'healthy', now(), now() - interval '30 days', now() + interval '10 years')
    ON CONFLICT (calendar_id) DO UPDATE SET health = 'healthy', hold_reason = NULL, hold_since = NULL, pending_deletions = '{}', last_synced_at = now(),
      horizon_start = now() - interval '30 days', horizon_end = now() + interval '10 years'
  `;
}

const uidOf = (n: string): string => `c3-unit-${n}-${Math.random().toString(36).slice(2, 8)}@caldes.test`;
const windowQuery = (extra = ''): string => `from=${encodeURIComponent(WIN.from)}&to=${encodeURIComponent(WIN.to)}${extra}`;

const holdBody = (mode: 'dry_run' | 'commit', extra: Record<string, unknown> = {}) => ({ mode, ...extra });

/** Tutte le route nuove del passo C3 con un corpo plausibile. */
const ROUTES: Array<{ method: 'get' | 'post'; path: string; body?: unknown }> = [
  { method: 'get', path: `${BASE}/sync-state` },
  { method: 'get', path: `${BASE}/occurrences?${windowQuery()}` },
  { method: 'get', path: `${BASE}/overlays?${windowQuery()}` },
  { method: 'post', path: `${BASE}/collections/${ANY_ID}/apply-deletions`, body: holdBody('dry_run') },
  { method: 'post', path: `${BASE}/collections/${ANY_ID}/rebuild-from-index`, body: holdBody('dry_run') },
];

describe('autenticazione e CSRF', () => {
  test('senza JWT ogni route nuova risponde 401', async () => {
    for (const r of ROUTES) {
      const res = await api[r.method](r.path, r.method === 'get' ? {} : { body: r.body });
      assert.equal(res.status, 401, `${r.method} ${r.path}`);
    }
  });

  test('Sec-Fetch-Site e Origin estranei → 403 CSRF_REJECTED sulle scritture; corpo non JSON → 415', async () => {
    await setState('postgres');
    for (const r of ROUTES.filter((x) => x.method === 'post')) {
      const site = await api.post(r.path, { auth: 'admin', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: r.body });
      assert.equal(site.status, 403, `${r.path} cross-site`);
      assert.equal(site.json.code, 'CSRF_REJECTED');
      const origin = await api.post(r.path, { auth: 'admin', headers: { Origin: 'https://evil.example' }, body: r.body });
      assert.equal(origin.status, 403, `${r.path} origine estranea`);
      const text = await api.post(r.path, { auth: 'admin', headers: { 'Content-Type': 'text/plain' }, body: 'testo' });
      assert.equal(text.status, 415, `${r.path} text/plain`);
    }
  });
});

describe('mode postgres: 409 STORE_MODE_UNSUPPORTED su ogni route nuova', () => {
  test('nessuna scrittura, nessuna riga di audit', async () => {
    await setState('postgres');
    const before = await auditCount();
    for (const r of ROUTES) {
      const res = await api[r.method](r.path, { auth: 'admin', ...(r.method === 'get' ? {} : { body: r.body }) });
      assert.equal(res.status, 409, `${r.method} ${r.path}: ${res.text}`);
      assert.equal(res.json.code, 'STORE_MODE_UNSUPPORTED');
    }
    assert.equal(await auditCount(), before);
  });
});

describe('capacità della tranche C, passo C3', () => {
  test('postgres: falsi; radicale: health_page e occurrences veri; senza Radicale di nuovo falsi', async () => {
    await setState('postgres');
    let res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['health_page', 'occurrences']) assert.equal(res.json[flag], false, flag);
    offlineRadicale();
    await setState('radicale');
    res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['health_page', 'occurrences']) assert.equal(res.json[flag], true, flag);
    configureRadicaleRuntime(null);
    res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['health_page', 'occurrences']) assert.equal(res.json[flag], false, `${flag} senza Radicale`);
    await setState('postgres');
  });
});

describe('finestra di /occurrences e /overlays', () => {
  const get = (path: string) => api.get(`${BASE}${path}`, { auth: 'admin' });

  test('mancante, invertita, non ISO, oltre 100 giorni → 400; 100 giorni esatti → 200', async () => {
    await toRadicale();
    for (const base of ['/occurrences', '/overlays']) {
      for (const [label, q] of [
        ['senza from e to', ''],
        ['senza to', 'from=2032-03-01'],
        ['from uguale a to', 'from=2032-03-01&to=2032-03-01'],
        ['invertita', 'from=2032-03-10&to=2032-03-01'],
        ['non ISO', 'from=domani&to=dopodomani'],
        ['101 giorni', 'from=2032-01-01&to=2032-04-11'],
        ['mese 13', 'from=2032-13-01&to=2032-13-20'],
      ] as const) {
        const res = await get(`${base}?${q}`);
        assert.equal(res.status, 400, `${base} ${label}: ${res.text}`);
        assert.equal(res.json.code, 'VALIDATION_FAILED');
      }
      const exact = await get(`${base}?from=2032-01-01T00:00:00Z&to=${encodeURIComponent(new Date(Date.parse('2032-01-01T00:00:00Z') + CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS * 86_400_000).toISOString())}`);
      assert.equal(exact.status, 200, `${base} 100 giorni esatti: ${exact.text}`);
    }
    const badId = await get(`/occurrences?${windowQuery('&calendar_id=non-un-uuid')}`);
    assert.equal(badId.status, 400);
  });
});

describe('occorrenze, badge e overlays', () => {
  let user: { id: string };
  let draft: { id: string };
  let held: { id: string };
  let holidays: { id: string };
  let subscription: { id: string };
  let archive: { id: string };
  const ids: Record<string, string> = {};
  let seeded = false;

  const setup = async (): Promise<void> => {
    if (seeded) return;
    seeded = true;
    user = await mk('utente');
    draft = await mk('dal-device', { needsReview: true });
    held = await mk('in-hold');
    holidays = await mk('festivita', { role: 'holidays' });
    subscription = await mk('iscrizione', { role: 'subscription' });
    archive = await mk('archivio');
    await sql`UPDATE calendars SET origin = 'migration' WHERE id = ${archive.id}::uuid`;
    for (const c of [user, draft, holidays, subscription, archive]) await setHealthy(c.id);
    await setHold(held.id, [`${uidOf('sospeso')}.ics`]);

    ids.plain = await seed(user.id, uidOf('semplice'), { summary: 'Riunione', start: '2032-03-05T09:00:00Z', end: '2032-03-05T10:00:00Z' });
    ids.coloured = await seed(user.id, uidOf('colorato'), {
      summary: 'Con colore',
      start: '2032-03-06T09:00:00Z',
      end: '2032-03-06T10:00:00Z',
      raw: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//T//C3//IT', 'BEGIN:VEVENT', 'UID:x@y.test', 'DTSTAMP:20320101T000000Z', 'DTSTART:20320306T090000Z', 'DTEND:20320306T100000Z', 'COLOR:#ff8800', 'SUMMARY:Con colore', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'),
    });
    ids.quarantined = await seed(user.id, uidOf('quarantena'), { summary: 'Ultima buona', start: '2032-03-07T09:00:00Z', end: '2032-03-07T10:00:00Z', health: 'quarantined', stale: true });
    const orphanUid = uidOf('orfano');
    ids.orphan = await seed(user.id, orphanUid, { summary: 'Orfano', start: '2032-03-08T09:00:00Z', end: '2032-03-08T10:00:00Z', key: '20320308T090000Z', kind: 'orphan_override', recurring: true });
    ids.conservative = await seed(user.id, uidOf('conservativo'), { start: '2032-03-09T00:00:00Z', end: '2032-03-10T00:00:00Z', health: 'quarantined', kind: 'conservative', key: 'conservative' });
    ids.allDay = await seed(user.id, uidOf('giornata'), { summary: 'Tutto il giorno', start: '2032-03-11T23:00:00Z', end: '2032-03-12T23:00:00Z', allDay: true, startDate: '2032-03-12', endDate: '2032-03-13', blocks: false });
    ids.cancelled = await seed(user.id, uidOf('annullato'), { summary: 'Annullato', start: '2032-03-13T09:00:00Z', end: '2032-03-13T10:00:00Z', status: 'cancelled', blocks: false });
    ids.draft = await seed(draft.id, uidOf('nuovo'), { summary: 'Dal telefono', start: '2032-03-14T09:00:00Z', end: '2032-03-14T10:00:00Z' });
    ids.held = await seed(held.id, uidOf('in-hold'), { summary: 'Calendario in hold', start: '2032-03-15T09:00:00Z', end: '2032-03-15T10:00:00Z' });
    ids.holiday = await seed(holidays.id, uidOf('festa'), { summary: 'Festa', start: '2032-03-16T00:00:00Z', end: '2032-03-17T00:00:00Z', allDay: true, startDate: '2032-03-16', endDate: '2032-03-17', kind: 'holiday_system', href: 'it-holiday-2032-03-16.ics', blocks: false });
    ids.closure = await seed(holidays.id, uidOf('chiusura'), { summary: 'Ferie', start: '2032-03-18T00:00:00Z', end: '2032-03-20T00:00:00Z', allDay: true, startDate: '2032-03-18', endDate: '2032-03-20', kind: 'closure', href: 'closure-ferie.ics', blocks: false });
    ids.sub = await seed(subscription.id, uidOf('remoto'), { summary: 'Evento remoto', start: '2032-03-21T09:00:00Z', end: '2032-03-21T10:00:00Z', href: 'r-aaaaaaaaaaaaaaaaaaaaaaaaaa.ics' });
    ids.archive = await seed(archive.id, uidOf('archiviato'), { summary: 'Archiviato', start: '2032-03-22T09:00:00Z', end: '2032-03-22T10:00:00Z' });
    await toRadicale();
  };

  after(() => {
    overrideCalendarStore(null);
  });

  const occurrences = async (extra = ''): Promise<CalV2OccurrenceList> => {
    const res = await api.get(`${BASE}/occurrences?${windowQuery(extra)}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return res.json as CalV2OccurrenceList;
  };

  test('senza calendar_id: tutti i calendari tranne festività e iscrizioni, ordinati e senza troncamento', async () => {
    await setup();
    const list = await occurrences();
    const mine = list.occurrences.filter((o) => Object.values(ids).includes(o.object_id));
    const seen = new Set(mine.map((o) => o.object_id));
    for (const key of ['plain', 'coloured', 'quarantined', 'orphan', 'conservative', 'allDay', 'cancelled', 'draft', 'held']) assert.ok(seen.has(ids[key]), `${key} presente`);
    for (const key of ['holiday', 'closure', 'sub']) assert.ok(!seen.has(ids[key]), `${key} solo in /overlays`);
    assert.ok(seen.has(ids.archive), 'l\'archivio compare, in sola lettura');
    const starts = list.occurrences.map((o) => Date.parse(o.start_utc));
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'ordinate per inizio');
    assert.equal(list.from, new Date(WIN.from).toISOString());
  });

  test('con calendar_id: esattamente quei calendari, anche festività e iscrizioni', async () => {
    await setup();
    const only = await occurrences(`&calendar_id=${holidays.id}&calendar_id=${subscription.id}`);
    const objs = new Set(only.occurrences.map((o) => o.object_id));
    assert.ok(objs.has(ids.holiday) && objs.has(ids.closure) && objs.has(ids.sub));
    assert.ok(!objs.has(ids.plain), 'nessun altro calendario');
    const one = await occurrences(`&calendar_id=${user.id}`);
    assert.ok(one.occurrences.every((o) => o.calendar_id === user.id));
  });

  test('badge: orphan, quarantined, hold, conservative, new_from_device; sola lettura e colore', async () => {
    await setup();
    const list = await occurrences();
    const by = (key: string) => list.occurrences.find((o) => o.object_id === ids[key]);
    assert.deepEqual(by('plain')?.badges, []);
    assert.equal(by('plain')?.summary, 'Riunione');
    assert.equal(by('plain')?.readonly_reason, null);
    assert.equal(by('plain')?.color, null);
    assert.equal(by('coloured')?.color, '#ff8800');
    assert.deepEqual(by('orphan')?.badges, ['orphan']);
    assert.deepEqual(by('orphan')?.recurrence_key, '20320308T090000Z');
    assert.deepEqual(by('quarantined')?.badges, ['quarantined']);
    assert.equal(by('quarantined')?.stale, true);
    assert.equal(by('quarantined')?.readonly_reason, 'unreadable');
    assert.deepEqual(by('conservative')?.badges, ['quarantined', 'conservative']);
    assert.equal(by('conservative')?.component_id, null);
    assert.equal(by('conservative')?.summary, null);
    assert.deepEqual(by('draft')?.badges, ['new_from_device']);
    assert.deepEqual(by('held')?.badges, ['hold']);
    assert.equal(by('archive')?.readonly_reason, 'archive');
    assert.equal(by('cancelled')?.status, 'cancelled');
    assert.equal(by('allDay')?.all_day, true);
    assert.equal(by('allDay')?.start_date, '2032-03-12');
    assert.equal(by('allDay')?.end_date, '2032-03-13');
    assert.equal(by('plain')?.start_date, null);
    assert.ok(list.stale_calendar_ids.includes(held.id), 'la collezione in hold non è sana');
    assert.ok(!list.stale_calendar_ids.includes(user.id));
  });

  test('le scritture sospese rendono le occorrenze di sola lettura (writes_suspended)', async () => {
    await setup();
    await sql`UPDATE calendar_backend_state SET write_freeze = true WHERE id`;
    invalidateBackendModeCache();
    try {
      const list = await occurrences();
      assert.equal(list.occurrences.find((o) => o.object_id === ids.plain)?.readonly_reason, 'writes_suspended');
    } finally {
      await sql`UPDATE calendar_backend_state SET write_freeze = false WHERE id`;
      invalidateBackendModeCache();
    }
  });

  test('/overlays: festività, chiusure e iscrizioni; mai gli eventi dei calendari normali; annullati esclusi', async () => {
    await setup();
    const res = await api.get(`${BASE}/overlays?${windowQuery()}`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    const list = res.json as CalV2OverlayList;
    const by = new Map(list.items.map((i) => [i.object_id, i]));
    assert.equal(by.get(ids.holiday)?.source, 'holiday');
    assert.equal(by.get(ids.closure)?.source, 'closure');
    assert.equal(by.get(ids.sub)?.source, 'subscription');
    assert.equal(by.get(ids.holiday)?.start_date, '2032-03-16');
    assert.equal(by.get(ids.holiday)?.summary, 'Festa');
    assert.ok(!by.has(ids.plain) && !by.has(ids.archive), 'solo festività e iscrizioni');
    assert.deepEqual(list.items.map((i) => Date.parse(i.start_utc)), list.items.map((i) => Date.parse(i.start_utc)).sort((a, b) => a - b));
  });

  test('oltre l\'orizzonte le occorrenze si espandono al volo dal testo, con titolo, ricorrenza e colore', async () => {
    await setup();
    await sql`DELETE FROM cal_collection_state WHERE calendar_id = ${draft.id}::uuid`;
    const raw = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//T//C3//IT', 'BEGIN:VEVENT', 'UID:serie@c3.test', 'DTSTAMP:20320101T000000Z',
      'DTSTART:20320301T090000Z', 'DTEND:20320301T100000Z', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Serie lontana', 'COLOR:#00aa55', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    const objectId = await seed(draft.id, 'serie@c3.test', { summary: 'Serie lontana', start: '2032-03-01T09:00:00Z', end: '2032-03-05T10:00:00Z', raw, recurring: true, noOccurrence: true, href: 'serie-lontana.ics' });
    const list = await occurrences(`&calendar_id=${draft.id}`);
    const mine = list.occurrences.filter((o) => o.object_id === objectId);
    assert.equal(mine.length, 5, JSON.stringify(mine.map((o) => o.start_utc)));
    assert.deepEqual(mine.map((o) => o.start_utc.slice(0, 10)), ['2032-03-01', '2032-03-02', '2032-03-03', '2032-03-04', '2032-03-05']);
    assert.equal(new Set(mine.map((o) => o.recurrence_key)).size, 5);
    assert.ok(mine.every((o) => o.summary === 'Serie lontana' && o.recurring && o.kind === 'event' && o.color === '#00aa55' && o.component_id === objectId));
    assert.ok(mine.every((o) => o.end_utc.slice(11, 16) === '10:00' && !o.all_day && o.start_date === null));
  });

  test('una finestra senza eventi risponde con elenchi vuoti', async () => {
    await setup();
    const res = await api.get(`${BASE}/occurrences?from=2040-01-01&to=2040-01-10&calendar_id=${user.id}`, { auth: 'admin' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.occurrences, []);
  });
});

describe('azioni di hold', () => {
  let cal: { id: string };
  let plain: { id: string };
  const hrefs: string[] = [];
  let seeded = false;
  const KEY = 'c3-unit-key-0001';
  const action = (name: 'apply-deletions' | 'rebuild-from-index', id = cal?.id) => `${BASE}/collections/${id}/${name}`;
  const post = (name: 'apply-deletions' | 'rebuild-from-index', body: unknown, headers: Record<string, string> = {}, id?: string) =>
    api.post(action(name, id), { auth: 'admin', body, headers });

  const setup = async (): Promise<void> => {
    if (seeded) return;
    seeded = true;
    cal = await mk('hold-azioni');
    plain = await mk('senza-hold');
    await setHealthy(plain.id);
    for (const n of ['a', 'b', 'c']) {
      const uid = uidOf(n);
      hrefs.push(`${uid}.ics`);
      await seed(cal.id, uid, { summary: `Titolo ${n}`, start: '2032-03-05T09:00:00Z', end: '2032-03-05T10:00:00Z' });
    }
    hrefs.sort();
    await setHold(cal.id, hrefs, 'collection-empty');
    await toRadicale();
  };

  after(() => {
    overrideCalendarStore(null);
  });

  test('NOT_IN_HOLD: collezione senza cancellazioni sospese → 409 (anteprima e commit)', async () => {
    await setup();
    for (const name of ['apply-deletions', 'rebuild-from-index'] as const) {
      const dry = await post(name, holdBody('dry_run'), {}, plain.id);
      assert.equal(dry.status, 409, dry.text);
      assert.equal(dry.json.code, 'NOT_IN_HOLD');
      const commit = await post(name, holdBody('commit', { confirm: CAL_V2_HOLD_CONFIRMATIONS[name === 'apply-deletions' ? 'apply_deletions' : 'rebuild_from_index'], plan_hash: 'a'.repeat(64) }), { 'Idempotency-Key': 'c3-unit-key-nohold' }, plain.id);
      assert.equal(commit.status, 409, commit.text);
      assert.equal(commit.json.code, 'NOT_IN_HOLD');
    }
  });

  test('calendario inesistente, non UUID o iscrizione → 404', async () => {
    await setup();
    assert.equal((await post('apply-deletions', holdBody('dry_run'), {}, ANY_ID)).status, 404);
    assert.equal((await post('apply-deletions', holdBody('dry_run'), {}, 'non-un-uuid')).status, 404);
    const sub = await mk('iscrizione-hold', { role: 'subscription' });
    await toRadicale();
    assert.equal((await post('rebuild-from-index', holdBody('dry_run'), {}, sub.id)).status, 404);
  });

  test('corpo non valido → 400; chiave d\'idempotenza nel corpo → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    await setup();
    for (const body of [{}, { mode: 'altro' }, { mode: 'dry_run', extra: 1 }, { mode: 'dry_run', hrefs: 'x' }, { mode: 'commit', plan_hash: 'corto' }]) {
      const res = await post('apply-deletions', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.code, 'VALIDATION_FAILED');
    }
    const inBody = await post('apply-deletions', { ...holdBody('commit'), idempotency_key: KEY });
    assert.equal(inBody.status, 400);
    assert.equal(inBody.json.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  test('dry_run: piano con una voce per href sospeso e plan_hash stabile; hrefs sceglie un sottoinsieme', async () => {
    await setup();
    const res = await post('apply-deletions', holdBody('dry_run'));
    assert.equal(res.status, 200, res.text);
    const plan = res.json as CalV2HoldPlan;
    assert.equal(plan.calendar_id, cal.id);
    assert.equal(plan.action, 'apply_deletions');
    assert.equal(plan.hold_reason, 'collection-empty');
    assert.equal(plan.total, 3);
    assert.deepEqual(plan.items.map((i) => i.href), hrefs);
    assert.ok(plan.items.every((i) => i.action === 'remove_from_index' && i.object_id && i.version_id === null && i.reason === null));
    assert.match(plan.items[0].summary ?? '', /^Titolo [abc]$/);
    assert.match(plan.plan_hash, /^[0-9a-f]{64}$/);
    const again = await post('apply-deletions', holdBody('dry_run'));
    assert.equal((again.json as CalV2HoldPlan).plan_hash, plan.plan_hash);

    const subset = await post('apply-deletions', holdBody('dry_run', { hrefs: [hrefs[0], 'non-sospeso.ics'] }));
    assert.equal((subset.json as CalV2HoldPlan).total, 1);
    assert.notEqual((subset.json as CalV2HoldPlan).plan_hash, plan.plan_hash);
  });

  test('rebuild dry_run: senza versione valida la voce è skip no_valid_version', async () => {
    await setup();
    const res = await post('rebuild-from-index', holdBody('dry_run'));
    assert.equal(res.status, 200, res.text);
    const plan = res.json as CalV2HoldPlan;
    assert.equal(plan.action, 'rebuild_from_index');
    assert.ok(plan.items.every((i) => i.action === 'skip' && i.reason === 'no_valid_version'));
  });

  test('commit: conferma assente o errata → 400 CONFIRMATION_REQUIRED, nessun job', async () => {
    await setup();
    const plan = (await post('apply-deletions', holdBody('dry_run'))).json as CalV2HoldPlan;
    const before = await sql`SELECT count(*)::int AS n FROM cal_jobs WHERE kind = 'calendar_hold_apply'`;
    for (const confirm of [undefined, '', 'applica cancellazioni', 'RICOSTRUISCI', 'APPLICA CANCELLAZIONI ']) {
      const res = await post('apply-deletions', holdBody('commit', { confirm, plan_hash: plan.plan_hash }), { 'Idempotency-Key': KEY });
      assert.equal(res.status, 400, String(confirm));
      assert.equal(res.json.code, 'CONFIRMATION_REQUIRED');
    }
    const wrongAction = await post('rebuild-from-index', holdBody('commit', { confirm: CAL_V2_HOLD_CONFIRMATIONS.apply_deletions, plan_hash: plan.plan_hash }), { 'Idempotency-Key': KEY });
    assert.equal(wrongAction.json.code, 'CONFIRMATION_REQUIRED', 'ogni azione ha il proprio testo');
    const after = await sql`SELECT count(*)::int AS n FROM cal_jobs WHERE kind = 'calendar_hold_apply'`;
    assert.equal(after[0].n, before[0].n);
  });

  test('commit senza Idempotency-Key valida → 400; senza plan_hash → 400; plan_hash diverso → 409 PLAN_CHANGED con il piano nuovo', async () => {
    await setup();
    const plan = (await post('apply-deletions', holdBody('dry_run'))).json as CalV2HoldPlan;
    const confirm = CAL_V2_HOLD_CONFIRMATIONS.apply_deletions;
    for (const key of [undefined, 'corta', 'con spazi non validi']) {
      const res = await post('apply-deletions', holdBody('commit', { confirm, plan_hash: plan.plan_hash }), key ? { 'Idempotency-Key': key } : {});
      assert.equal(res.status, 400, String(key));
      assert.equal(res.json.code, 'IDEMPOTENCY_KEY_REQUIRED');
    }
    const noHash = await post('apply-deletions', holdBody('commit', { confirm }), { 'Idempotency-Key': KEY });
    assert.equal(noHash.status, 400);
    const stale = await post('apply-deletions', holdBody('commit', { confirm, plan_hash: 'b'.repeat(64) }), { 'Idempotency-Key': KEY });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.json.code, 'PLAN_CHANGED');
    assert.equal(stale.json.details.plan.plan_hash, plan.plan_hash);
    assert.equal(stale.json.details.plan.total, 3);
  });

  test('commit: 202 con il job; stessa chiave → stesso job; corpo diverso → 409 IDEMPOTENCY_CONFLICT; il job è leggibile', async () => {
    await setup();
    const plan = (await post('apply-deletions', holdBody('dry_run'))).json as CalV2HoldPlan;
    const confirm = CAL_V2_HOLD_CONFIRMATIONS.apply_deletions;
    const body = holdBody('commit', { confirm, plan_hash: plan.plan_hash });
    const before = await auditCount();
    const first = await post('apply-deletions', body, { 'Idempotency-Key': KEY });
    assert.equal(first.status, 202, first.text);
    const accepted = first.json as CalV2JobAccepted;
    assert.equal(accepted.created, true);
    assert.match(accepted.job_id, /^\d+$/);

    const second = await post('apply-deletions', body, { 'Idempotency-Key': KEY });
    assert.equal(second.status, 202);
    assert.deepEqual(second.json, { job_id: accepted.job_id, created: false });

    const other = await post('apply-deletions', holdBody('commit', { confirm, plan_hash: plan.plan_hash, hrefs: [hrefs[0]] }), { 'Idempotency-Key': KEY });
    assert.equal(other.status, 409, other.text);
    assert.equal(other.json.code, 'IDEMPOTENCY_CONFLICT');

    const job = await api.get(`${BASE}/jobs/${accepted.job_id}`, { auth: 'admin' });
    assert.equal(job.status, 200, job.text);
    const view = job.json as CalV2JobView;
    assert.equal(view.kind, 'calendar_hold_apply');
    assert.equal(view.calendar_id, cal.id);
    assert.equal(view.status, 'pending');

    const [row] = await sql<Array<{ payload: Record<string, unknown> }>>`SELECT payload FROM cal_jobs WHERE id = ${accepted.job_id}::bigint`;
    assert.equal(row.payload.plan_hash, plan.plan_hash);
    assert.ok(!JSON.stringify(row.payload).includes('Titolo'), 'nessun titolo di evento nel payload');
    assert.equal(await auditCount(), before, 'accodare il job non scrive audit: lo scrive il job');

    // Stessa chiave, ma la chiave è di un'altra azione: un job a parte.
    const rebuildPlan = (await post('rebuild-from-index', holdBody('dry_run'))).json as CalV2HoldPlan;
    const rebuild = await post('rebuild-from-index', holdBody('commit', { confirm: CAL_V2_HOLD_CONFIRMATIONS.rebuild_from_index, plan_hash: rebuildPlan.plan_hash }), { 'Idempotency-Key': KEY });
    assert.equal(rebuild.status, 202, rebuild.text);
    assert.notEqual((rebuild.json as CalV2JobAccepted).job_id, accepted.job_id);
  });

  test('stessa chiave dopo che l\'hold è caduto: risponde ancora il job di prima, non NOT_IN_HOLD', async () => {
    await setup();
    const plan = (await post('apply-deletions', holdBody('dry_run'))).json as CalV2HoldPlan;
    const body = holdBody('commit', { confirm: CAL_V2_HOLD_CONFIRMATIONS.apply_deletions, plan_hash: plan.plan_hash });
    const first = await post('apply-deletions', body, { 'Idempotency-Key': KEY });
    await setHealthy(cal.id);
    const replay = await post('apply-deletions', body, { 'Idempotency-Key': KEY });
    assert.equal(replay.status, 202, replay.text);
    assert.equal((replay.json as CalV2JobAccepted).job_id, (first.json as CalV2JobAccepted).job_id);
    const fresh = await post('apply-deletions', body, { 'Idempotency-Key': 'c3-unit-key-0002' });
    assert.equal(fresh.status, 409);
    assert.equal(fresh.json.code, 'NOT_IN_HOLD');
  });
});

describe('GET /sync-state', () => {
  test('aggrega modo, identità, collezioni, quarantena, job morti, conflitti e backup', async () => {
    const held = await mk('stato-hold');
    const healthy = await mk('stato-sano');
    await setHealthy(healthy.id);
    const pending = [`${uidOf('s1')}.ics`, `${uidOf('s2')}.ics`];
    await setHold(held.id, pending, 'mass-delete');
    const quarantinedId = await seed(healthy.id, uidOf('quarantena'), { start: '2032-04-01T09:00:00Z', end: '2032-04-01T10:00:00Z', health: 'quarantined' });
    const [job] = await sql<Array<{ id: string }>>`
      INSERT INTO cal_jobs (kind, key, status, attempts, max_attempts, last_error, finished_at)
      VALUES ('project_booking', ${`c3-unit-${Math.random().toString(36).slice(2, 8)}`}, 'dead', 8, 8, 'radicale_unreachable', now()) RETURNING id::text AS id
    `;
    await sql`
      INSERT INTO cal_booking_conflicts (booking_id, booking_uid, calendar_id, object_id, booking_start, booking_end, event_start, event_end, detected_by)
      VALUES (gen_random_uuid(), ${`c3-unit-${Math.random().toString(36).slice(2, 8)}`}, ${healthy.id}::uuid, ${quarantinedId}::uuid,
              '2032-04-01T09:00:00Z', '2032-04-01T09:30:00Z', '2032-04-01T09:00:00Z', '2032-04-01T10:00:00Z', 'auditor')
    `;
    await sql`UPDATE calendar_backend_state SET last_stack_backup = ${sql.json({ id: 'b1', at: new Date(Date.now() - 20 * 3_600_000).toISOString(), complete: true })} WHERE id`;
    await toRadicale();

    const res = await api.get(`${BASE}/sync-state`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    const state = res.json as CalV2SyncState;
    assert.equal(state.mode, 'radicale');
    assert.equal(state.write_freeze, false);
    assert.equal(state.writes_suspended, false);
    assert.equal(state.restore_guard_until, null);
    assert.equal(state.identity.volume_id, VOLUME);
    assert.equal(state.identity.epoch, 1);
    assert.ok(['ok', 'mismatch', 'unknown'].includes(state.identity.status));
    assert.equal(state.heartbeat.ok, false, 'nessun control-plane in questo test');
    assert.equal(state.heartbeat.last_at, null);
    assert.ok(['mount', 'remote', 'off'].includes(state.canary.watch_mode));
    assert.equal(typeof state.canary.mount_untrusted, 'boolean');
    assert.equal(typeof state.index.rebuild_required, 'boolean');

    const h = state.collections.find((c) => c.calendar_id === held.id);
    assert.ok(h, 'collezione in hold presente');
    assert.equal(h.health, 'hold');
    assert.equal(h.hold_reason, 'mass-delete');
    assert.ok(h.hold_since);
    assert.equal(h.pending_deletions, 2);
    assert.match(h.calendar_name, /stato-hold/);
    assert.equal(h.sync_in_flight, false);
    const ok = state.collections.find((c) => c.calendar_id === healthy.id);
    assert.equal(ok?.health, 'healthy');
    assert.equal(ok?.hold_reason, null);
    assert.equal(ok?.hold_since, null);

    const q = state.quarantined.find((x) => x.object_id === quarantinedId);
    assert.ok(q);
    assert.equal(q.health, 'quarantined');
    assert.equal(q.calendar_id, healthy.id);
    assert.equal(q.health_reason, 'parse-error');

    const dead = state.failed_jobs.find((j) => j.id === job.id);
    assert.deepEqual([dead?.kind, dead?.attempts, dead?.last_error], ['project_booking', 8, 'radicale_unreachable']);
    assert.ok(state.booking_conflicts.some((c) => c.detected_by === 'auditor' && c.booking_start === '2032-04-01T09:00:00.000Z'));

    assert.equal(state.backup.stale, true, 'backup di 20 ore fa: da rifare');
    assert.ok((state.backup.age_hours ?? 0) >= 19.9);

    await sql`UPDATE calendar_backend_state SET last_stack_backup = ${sql.json({ id: 'b2', at: new Date(Date.now() - 3_600_000).toISOString(), complete: true })} WHERE id`;
    const fresh = (await api.get(`${BASE}/sync-state`, { auth: 'admin' })).json as CalV2SyncState;
    assert.equal(fresh.backup.stale, false);
    await sql`UPDATE calendar_backend_state SET last_stack_backup = NULL WHERE id`;
    const none = (await api.get(`${BASE}/sync-state`, { auth: 'admin' })).json as CalV2SyncState;
    assert.deepEqual(none.backup, { last_stack_backup_at: null, age_hours: null, stale: true });
    overrideCalendarStore(null);
  });
});
