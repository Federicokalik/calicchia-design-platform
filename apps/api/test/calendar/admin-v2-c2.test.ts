/**
 * Route della tranche C, passo C2, dell'API admin del calendario v2
 * (calendari, import ed export, job; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.4, §9.7, §9.9), senza
 * Radicale.
 *
 * Casi: JWT admin (401), difesa CSRF (403, 415) e mode postgres (409
 * STORE_MODE_UNSUPPORTED) su ogni route nuova; flag di capacità; validazione
 * dei corpi di creazione, modifica e ordine; ruoli non assegnabili e
 * iscrizioni/archivio → 403; ordine incompleto o con doppioni → 400;
 * CALENDAR_NOT_EMPTY e calendari che non si eliminano; rotazione del token;
 * piano di import nelle tre modalità (`skip`, `replace`, `new_uid`) con UID in
 * un altro calendario e componenti non supportati; commit senza chiave,
 * chiave non valida o nel corpo → 400, stessa chiave → stesso job, chiave con
 * corpo diverso → 409 IDEMPOTENCY_CONFLICT, PLAN_CHANGED; limiti del corpo
 * (2 MB, 10 MB per l'import) → 413 PAYLOAD_TOO_LARGE; export con VTIMEZONE
 * deduplicati; GET /jobs con un job di altro tipo → 404.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type {
  CalV2CalendarList,
  CalV2CalendarView,
  CalV2ImportPlan,
  CalV2JobAccepted,
  CalV2JobView,
} from '@calicchia/shared';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { configureRadicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import { RadicaleClient, TransportError } from '../../src/lib/calendar/radicale/client';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import { onBeforeDatabaseClose, onDatabaseReady, resetCalendarBaseline, snapshotSeedCalendars, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';

useTestDatabase({ resetBaseline: true });
// PUT /calendars/order e PATCH agiscono anche sui calendari seminati: i loro
// sort_order e colonne modificabili tornano com'erano, altrimenti i contratti F0
// dei file successivi (stesso database) vedrebbero sort_order spostati.
let restoreSeedCalendars: (() => Promise<void>) | null = null;
onDatabaseReady(async () => {
  overrideCalendarStore(null);
  restoreSeedCalendars = await snapshotSeedCalendars();
});
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  configureRadicaleRuntime(null);
  await sql`DELETE FROM cal_jobs WHERE kind IN ('calendar_import', 'calendar_hold_apply', 'project_booking')`;
  await resetCalendarBaseline();
  await restoreSeedCalendars?.();
});
const fx = useFixtures('admin-v2-c2');

const BASE = '/api/admin/calendar/v2';
const VOLUME = '3c1e2d4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ANY_ID = '5f0c2b7e-9a41-4d6c-8e3b-2a7d1c9f4e60';
const TAG = 'c2-unit';

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

/** Righe di audit scritte dalle operazioni v2 (i trigger generici su `calendars` ne scrivono altre). */
async function auditCount(): Promise<number> {
  const [row] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM audit_logs WHERE metadata->>'operation' LIKE 'v2.%'`;
  return Number(row.n);
}

const vevent = (uid: string, over: { summary?: string; start?: string; end?: string; tzid?: string; extra?: string[] } = {}): string[] => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20270101T080000Z',
  over.tzid ? `DTSTART;TZID=${over.tzid}:${over.start ?? '20280301T090000'}` : `DTSTART:${over.start ?? '20280301T080000Z'}`,
  over.tzid ? `DTEND;TZID=${over.tzid}:${over.end ?? '20280301T100000'}` : `DTEND:${over.end ?? '20280301T090000Z'}`,
  `SUMMARY:${over.summary ?? 'Evento'}`,
  ...(over.extra ?? []),
  'END:VEVENT',
];

const calendarText = (...bodies: string[][]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//C2//IT', ...bodies.flat(), 'END:VCALENDAR', ''].join('\r\n');

/** Riga d'indice minima (id, oggetto) come la lascia l'indicizzatore: basta per piano, conteggi ed export. */
async function seedObject(calendarId: string, uid: string, raw: string, etag = '"seed"'): Promise<string> {
  const href = `${uid}.ics`;
  const [ids] = await sql<Array<{ id: string }>>`
    INSERT INTO cal_object_ids (calendar_id, href, uid) VALUES (${calendarId}::uuid, ${href}, ${uid}) RETURNING id
  `;
  await sql`
    INSERT INTO cal_objects (id, calendar_id, href, uid, etag, raw_ics, origin_store)
    VALUES (${ids.id}::uuid, ${calendarId}::uuid, ${href}, ${uid}, ${etag}, ${raw}, 'radicale')
  `;
  return ids.id;
}

/** Calendario di prova: si crea con lo store del database (con Radicale offline la MKCALENDAR fallirebbe). */
async function mk(key: string) {
  overrideCalendarStore(null);
  await setState('postgres');
  const cal = await fx.calendar({ key });
  offlineRadicale();
  await setState('radicale');
  overrideCalendarStore('radicale');
  return cal;
}

const uidOf = (n: string): string => `${TAG}-${n}-${Math.random().toString(36).slice(2, 8)}@caldes.test`;

/** Tutte le route nuove del passo C2 con un corpo plausibile. */
const ROUTES: Array<{ method: 'get' | 'put' | 'post' | 'patch' | 'delete'; path: string; body?: unknown }> = [
  { method: 'get', path: `${BASE}/calendars` },
  { method: 'post', path: `${BASE}/calendars`, body: { name: 'Prova' } },
  { method: 'put', path: `${BASE}/calendars/order`, body: { ids: [ANY_ID] } },
  { method: 'patch', path: `${BASE}/calendars/${ANY_ID}`, body: { name: 'Altro' } },
  { method: 'delete', path: `${BASE}/calendars/${ANY_ID}` },
  { method: 'post', path: `${BASE}/calendars/${ANY_ID}/rotate-token`, body: {} },
  { method: 'get', path: `${BASE}/calendars/${ANY_ID}/export.ics` },
  { method: 'post', path: `${BASE}/calendars/${ANY_ID}/import`, body: { ics: calendarText(vevent('a@b.test')), mode: 'dry_run', on_conflict: 'skip' } },
  { method: 'get', path: `${BASE}/jobs/1` },
];

describe('autenticazione e CSRF', () => {
  test('senza JWT ogni route nuova risponde 401', async () => {
    for (const r of ROUTES) {
      const res = await api[r.method](r.path, r.method === 'get' || r.method === 'delete' ? {} : { body: r.body });
      assert.equal(res.status, 401, `${r.method} ${r.path}`);
    }
  });

  test('Sec-Fetch-Site e Origin estranei → 403 CSRF_REJECTED sulle scritture; le letture non sono toccate', async () => {
    await setState('postgres');
    for (const r of ROUTES.filter((x) => x.method !== 'get')) {
      const site = await api[r.method as 'put'](r.path, { auth: 'admin', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: r.body });
      assert.equal(site.status, 403, `${r.method} ${r.path} cross-site`);
      assert.equal(site.json.code, 'CSRF_REJECTED');
      const origin = await api[r.method as 'put'](r.path, { auth: 'admin', headers: { Origin: 'https://evil.example' }, body: r.body });
      assert.equal(origin.status, 403, `${r.method} ${r.path} origine estranea`);
    }
    const read = await api.get(`${BASE}/calendars`, { auth: 'admin', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(read.status, 409, 'una lettura cross-site non è un CSRF: risponde la route');
  });

  test('un corpo che non è application/json → 415', async () => {
    for (const r of ROUTES.filter((x) => x.method === 'post' || x.method === 'put' || x.method === 'patch')) {
      const res = await api[r.method as 'put'](r.path, { auth: 'admin', headers: { 'Content-Type': 'text/plain' }, body: 'testo' });
      assert.equal(res.status, 415, `${r.method} ${r.path}`);
    }
  });
});

describe('mode postgres: 409 STORE_MODE_UNSUPPORTED su ogni route nuova', () => {
  test('nessuna scrittura, nessuna riga di audit', async () => {
    await setState('postgres');
    const before = await auditCount();
    for (const r of ROUTES) {
      const res = await api[r.method](r.path, { auth: 'admin', ...(r.method === 'get' || r.method === 'delete' ? {} : { body: r.body }) });
      assert.equal(res.status, 409, `${r.method} ${r.path}: ${res.text}`);
      assert.equal(res.json.code, 'STORE_MODE_UNSUPPORTED');
    }
    assert.equal(await auditCount(), before, 'nessuna riga di audit');
  });
});

describe('capacità della tranche C, passo C2', () => {
  test('postgres: falsi; radicale: calendar_properties e import_export veri', async () => {
    await setState('postgres');
    let res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['calendar_properties', 'import_export']) assert.equal(res.json[flag], false, flag);
    offlineRadicale();
    await setState('radicale');
    res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['calendar_properties', 'import_export']) assert.equal(res.json[flag], true, flag);
    configureRadicaleRuntime(null);
    res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['calendar_properties', 'import_export']) assert.equal(res.json[flag], false, `${flag} senza Radicale`);
    await setState('postgres');
  });
});

describe('calendari con lo store Radicale', () => {
  let user: { id: string };
  let other: { id: string };
  let sub: { id: string };
  let archive: { id: string };
  let bookings: { id: string };
  let seeded = false;

  const setup = async (): Promise<void> => {
    if (seeded) return;
    seeded = true;
    user = await mk('utente');
    other = await mk('altro');
    sub = await mk('iscrizione');
    archive = await mk('archivio');
    bookings = await mk('prenotazioni');
    await sql`UPDATE calendars SET role = 'subscription' WHERE id = ${sub.id}::uuid`;
    await sql`UPDATE calendars SET origin = 'migration' WHERE id = ${archive.id}::uuid`;
    await sql`UPDATE calendars SET role = 'bookings' WHERE id = ${bookings.id}::uuid`;
    offlineRadicale();
    await setState('radicale');
    overrideCalendarStore('radicale');
  };

  after(() => {
    overrideCalendarStore(null);
  });

  const list = async (): Promise<CalV2CalendarView[]> => {
    const res = await api.get(`${BASE}/calendars`, { auth: 'admin' });
    assert.equal(res.status, 200, res.text);
    return (res.json as CalV2CalendarList).calendars;
  };

  test('GET /calendars: vista completa, ordine, conteggi, motivo di sola lettura e deletable', async () => {
    await setup();
    await seedObject(user.id, uidOf('conteggio'), calendarText(vevent('x@y.test')));
    const calendars = await list();
    const byId = new Map(calendars.map((c) => [c.id, c]));
    const u = byId.get(user.id) as CalV2CalendarView;
    assert.equal(u.role, 'user');
    assert.equal(u.readonly_reason, null);
    assert.equal(u.object_count, 1);
    assert.equal(u.deletable, true);
    assert.equal(u.lifecycle, 'active');
    assert.match(u.feed_url ?? '', /\/api\/calendar\/feed\/[a-z0-9]{32}\.ics$/);
    assert.deepEqual(u.components, ['VEVENT']);
    assert.equal(byId.get(sub.id)?.readonly_reason, 'subscription');
    assert.equal(byId.get(sub.id)?.feed_url, null);
    assert.equal(byId.get(sub.id)?.deletable, false);
    assert.equal(byId.get(archive.id)?.readonly_reason, 'archive');
    assert.equal(byId.get(archive.id)?.deletable, false);
    assert.equal(byId.get(bookings.id)?.deletable, false);
    const sorted = [...calendars].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    assert.deepEqual(calendars.map((c) => c.id), sorted.map((c) => c.id), 'ordinati per sort_order e nome');
  });

  test('POST /calendars: corpi non validi → 400 con details.issues; ruoli di sistema → 403', async () => {
    await setup();
    const before = await auditCount();
    const bad: Array<[string, unknown]> = [
      ['senza nome', {}],
      ['nome vuoto', { name: '   ' }],
      ['nome troppo lungo', { name: 'x'.repeat(201) }],
      ['colore non valido', { name: 'Prova', color: 'rosso' }],
      ['fuso non valido', { name: 'Prova', timezone: 'Marte/Olympus' }],
      ['slug non valido', { name: 'Prova', slug: 'Con Spazi' }],
      ['ruolo sconosciuto', { name: 'Prova', role: 'boh' }],
      ['campo sconosciuto', { name: 'Prova', is_default: true }],
      ['descrizione troppo lunga', { name: 'Prova', description: 'x'.repeat(1001) }],
      ['booleano non valido', { name: 'Prova', device_visible: 'si' }],
    ];
    for (const [label, body] of bad) {
      const res = await api.post(`${BASE}/calendars`, { auth: 'admin', body });
      assert.equal(res.status, 400, `${label}: ${res.text}`);
      assert.equal(res.json.code, 'VALIDATION_FAILED', label);
      assert.ok(Array.isArray(res.json.details?.issues) && res.json.details.issues.length > 0, `${label}: issues`);
    }
    for (const role of ['bookings', 'holidays', 'subscription', 'tasks']) {
      const res = await api.post(`${BASE}/calendars`, { auth: 'admin', body: { name: 'Prova', role } });
      assert.equal(res.status, 403, `ruolo ${role}`);
      assert.equal(res.json.code, 'READ_ONLY');
      assert.equal(res.json.details.reason, 'role_not_assignable');
    }
    assert.equal(await auditCount(), before, 'nessuna scrittura');
  });

  test('PATCH /calendars/:id: validazione, almeno un campo, ruoli e sola lettura', async () => {
    await setup();
    const url = (id: string) => `${BASE}/calendars/${id}`;
    const empty = await api.patch(url(user.id), { auth: 'admin', body: {} });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.code, 'VALIDATION_FAILED');
    for (const body of [{ color: 'blu' }, { timezone: 'Nowhere/Land' }, { name: '' }, { needs_review: true }, { is_system: true }, { role: 'boh' }, { ics_feed_enabled: 'no' }]) {
      const res = await api.patch(url(user.id), { auth: 'admin', body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.code, 'VALIDATION_FAILED');
    }
    // Ruolo non assegnabile → 403 (anche per un calendario normale).
    for (const role of ['bookings', 'holidays', 'subscription', 'tasks']) {
      const res = await api.patch(url(user.id), { auth: 'admin', body: { role } });
      assert.equal(res.status, 403, role);
      assert.equal(res.json.details.reason, 'role_not_assignable');
    }
    // Il ruolo attuale non è fra quelli assegnabili → 403.
    const locked = await api.patch(url(bookings.id), { auth: 'admin', body: { role: 'user' } });
    assert.equal(locked.status, 403);
    assert.equal(locked.json.details.reason, 'role_locked');
    // Iscrizione e archivio: solo nome e colore.
    for (const [id, reason] of [[sub.id, 'subscription'], [archive.id, 'archive']] as const) {
      const res = await api.patch(url(id), { auth: 'admin', body: { description: 'altro', ics_feed_enabled: false } });
      assert.equal(res.status, 403, reason);
      assert.equal(res.json.code, 'READ_ONLY');
      assert.equal(res.json.details.reason, reason);
      assert.deepEqual(res.json.details.fields, ['description', 'ics_feed_enabled']);
    }
    // Id inesistente o non UUID → 404.
    assert.equal((await api.patch(url(ANY_ID), { auth: 'admin', body: { name: 'X' } })).status, 404);
    assert.equal((await api.patch(url('non-un-uuid'), { auth: 'admin', body: { name: 'X' } })).status, 404);
  });

  test('PATCH: nome e colore di un\'iscrizione si cambiano (solo database), nome già usato → 400', async () => {
    await setup();
    const before = await auditCount();
    const res = await api.patch(`${BASE}/calendars/${sub.id}`, { auth: 'admin', body: { name: `Iscrizione ${TAG}`, color: '#112233' } });
    assert.equal(res.status, 200, res.text);
    const view = res.json as CalV2CalendarView;
    assert.equal(view.name, `Iscrizione ${TAG}`);
    assert.equal(view.color, '#112233');
    assert.equal(view.readonly_reason, 'subscription');
    assert.equal(await auditCount(), before + 1, 'una riga di audit');
    const [row] = await sql<Array<{ changed_fields: string[]; metadata: Record<string, unknown>; table_name: string }>>`
      SELECT changed_fields, metadata, table_name FROM audit_logs WHERE record_id = ${sub.id} AND metadata->>'operation' LIKE 'v2.%' ORDER BY created_at DESC, id DESC LIMIT 1
    `;
    assert.equal(row.table_name, 'calendars');
    assert.deepEqual([...row.changed_fields].sort(), ['color', 'name']);
    assert.equal(row.metadata.operation, 'v2.calendar.update');
    assert.ok(!JSON.stringify(row).includes(`Iscrizione ${TAG}`), 'il nome non finisce nell\'audit');
    const clash = await api.patch(`${BASE}/calendars/${other.id}`, { auth: 'admin', body: { name: `Iscrizione ${TAG}` } });
    assert.equal(clash.status, 400);
    assert.equal(clash.json.code, 'VALIDATION_FAILED');
    // Nessuna modifica effettiva: 200 senza altro audit.
    const noop = await api.patch(`${BASE}/calendars/${sub.id}`, { auth: 'admin', body: { name: `Iscrizione ${TAG}` } });
    assert.equal(noop.status, 200);
    assert.equal(await auditCount(), before + 1);
  });

  test('PATCH needs_review: false azzera anche review_reason', async () => {
    await setup();
    await sql`UPDATE calendars SET needs_review = true, review_reason = 'device_new' WHERE id = ${other.id}::uuid`;
    assert.equal((await list()).find((c) => c.id === other.id)?.needs_review, true);
    const res = await api.patch(`${BASE}/calendars/${other.id}`, { auth: 'admin', body: { needs_review: false } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.needs_review, false);
    assert.equal(res.json.review_reason, null);
    const [row] = await sql<Array<{ needs_review: boolean; review_reason: string | null }>>`SELECT needs_review, review_reason FROM calendars WHERE id = ${other.id}::uuid`;
    assert.deepEqual(row, { needs_review: false, review_reason: null });
  });

  test('PUT /calendars/order: corpi non validi, elenco incompleto, doppioni, id estranei → 400; elenco completo → 200', async () => {
    await setup();
    const all = (await list()).map((c) => c.id);
    for (const body of [{}, { ids: [] }, { ids: ['non-uuid'] }, { ids: all, altro: 1 }]) {
      const res = await api.put(`${BASE}/calendars/order`, { auth: 'admin', body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(res.json.code, 'VALIDATION_FAILED');
    }
    const incomplete = await api.put(`${BASE}/calendars/order`, { auth: 'admin', body: { ids: all.slice(1) } });
    assert.equal(incomplete.status, 400);
    assert.equal(incomplete.json.details.missing, 1);
    const dup = await api.put(`${BASE}/calendars/order`, { auth: 'admin', body: { ids: [...all, all[0]] } });
    assert.equal(dup.status, 400);
    const stranger = await api.put(`${BASE}/calendars/order`, { auth: 'admin', body: { ids: [...all.slice(1), ANY_ID] } });
    assert.equal(stranger.status, 400);
    assert.equal(stranger.json.details.unknown, 1);

    const reversed = [...all].reverse();
    const before = await auditCount();
    const res = await api.put(`${BASE}/calendars/order`, { auth: 'admin', body: { ids: reversed } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual((res.json as CalV2CalendarList).calendars.map((c) => c.id), reversed);
    assert.deepEqual((res.json as CalV2CalendarList).calendars.map((c) => c.sort_order), reversed.map((_, i) => i));
    assert.equal(await auditCount(), before + 1);
    // Ripristina l'ordine alfabetico originale per i test successivi.
    const restore = await api.put(`${BASE}/calendars/order`, { auth: 'admin', body: { ids: all } });
    assert.equal(restore.status, 200);
  });

  test('DELETE /calendars/:id: non vuoto senza with_objects → 409 CALENDAR_NOT_EMPTY; sistema, iscrizioni e archivio → 403', async () => {
    await setup();
    const full = await mk('pieno');
    await seedObject(full.id, uidOf('a'), calendarText(vevent('a@b.test')));
    await seedObject(full.id, uidOf('b'), calendarText(vevent('b@b.test')));
    const before = await auditCount();
    const res = await api.delete(`${BASE}/calendars/${full.id}`, { auth: 'admin' });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.code, 'CALENDAR_NOT_EMPTY');
    assert.equal(res.json.details.object_count, 2);
    assert.equal((await api.delete(`${BASE}/calendars/${full.id}`, { auth: 'admin', query: { with_objects: 0 } })).status, 409);
    for (const [id, reason] of [[sub.id, 'subscription'], [archive.id, 'archive'], [bookings.id, 'system']] as const) {
      const r = await api.delete(`${BASE}/calendars/${id}`, { auth: 'admin', query: { with_objects: 1 } });
      assert.equal(r.status, 403, reason);
      assert.equal(r.json.code, 'READ_ONLY');
      assert.equal(r.json.details.reason, reason);
    }
    const [def] = await sql<Array<{ id: string }>>`SELECT id FROM calendars WHERE is_default AND lifecycle = 'active' LIMIT 1`;
    if (def) {
      const r = await api.delete(`${BASE}/calendars/${def.id}`, { auth: 'admin', query: { with_objects: 1 } });
      assert.equal(r.status, 403);
      assert.equal(r.json.details.reason, 'system');
    }
    assert.equal((await api.delete(`${BASE}/calendars/${ANY_ID}`, { auth: 'admin' })).status, 404);
    assert.equal(await auditCount(), before, 'nessuna eliminazione, nessun audit');
    const still = (await list()).find((c) => c.id === full.id);
    assert.equal(still?.object_count, 2);
  });

  test('POST /calendars/:id/rotate-token: corpo {} obbligatorio, nuovo feed_url, iscrizione → 403', async () => {
    await setup();
    const url = `${BASE}/calendars/${user.id}/rotate-token`;
    for (const body of [{ a: 1 }, []]) {
      const res = await api.post(url, { auth: 'admin', body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const first = (await list()).find((c) => c.id === user.id) as CalV2CalendarView;
    const before = await auditCount();
    const res = await api.post(url, { auth: 'admin', body: {} });
    assert.equal(res.status, 200, res.text);
    assert.notEqual(res.json.feed_url, first.feed_url);
    assert.match(res.json.feed_url, /\/api\/calendar\/feed\/[a-z0-9]{32}\.ics$/);
    assert.equal(await auditCount(), before + 1);
    const [row] = await sql<Array<{ metadata: Record<string, unknown>; changed_fields: string[] }>>`
      SELECT metadata, changed_fields FROM audit_logs WHERE record_id = ${user.id} AND metadata->>'operation' LIKE 'v2.%' ORDER BY created_at DESC, id DESC LIMIT 1
    `;
    assert.equal(row.metadata.operation, 'v2.calendar.rotate_token');
    assert.ok(!JSON.stringify(row).includes(res.json.feed_url.split('/').pop().replace('.ics', '')), 'il token non finisce nell\'audit');
    assert.equal((await api.post(`${BASE}/calendars/${sub.id}/rotate-token`, { auth: 'admin', body: {} })).status, 403);
    assert.equal((await api.post(`${BASE}/calendars/${ANY_ID}/rotate-token`, { auth: 'admin', body: {} })).status, 404);
  });

  test('write_freeze: PATCH solo database, PUT /calendars/order e rotate-token → 503, righe di calendars invariate', async () => {
    await setup();
    const snapshot = async (): Promise<string> =>
      JSON.stringify(await sql`SELECT id, blocks_availability, device_visible, ics_feed_enabled, ics_feed_token, sort_order, needs_review FROM calendars ORDER BY id`);
    const all = (await list()).map((c) => c.id);
    await sql`UPDATE calendar_backend_state SET write_freeze = true WHERE id`;
    invalidateBackendModeCache();
    try {
      const before = await snapshot();
      const patch = await api.patch(`${BASE}/calendars/${user.id}`, { auth: 'admin', body: { blocks_availability: false } });
      assert.equal(patch.status, 503, patch.text);
      const order = await api.put(`${BASE}/calendars/order`, { auth: 'admin', body: { ids: [...all].reverse() } });
      assert.equal(order.status, 503, order.text);
      const rotate = await api.post(`${BASE}/calendars/${user.id}/rotate-token`, { auth: 'admin', body: {} });
      assert.equal(rotate.status, 503, rotate.text);
      assert.equal(await snapshot(), before, 'nessuna riga di calendars è cambiata');
    } finally {
      await setState('radicale');
    }
  });
});

describe('import: piano', () => {
  let target: { id: string };
  let elsewhere: { id: string };
  let sub: { id: string };

  const setup = async (): Promise<void> => {
    if (target) return;
    target = await mk('import');
    elsewhere = await mk('import-altro');
    sub = await mk('import-iscrizione');
    await sql`UPDATE calendars SET role = 'subscription' WHERE id = ${sub.id}::uuid`;
    offlineRadicale();
    await setState('radicale');
    overrideCalendarStore('radicale');
  };

  after(() => {
    overrideCalendarStore(null);
  });

  /** Risposta di un dry run: il piano, oppure l'errore con codice e dettagli. */
  type PlanResponse = CalV2ImportPlan & { code?: string; error?: string; details?: { reason?: string } };
  const plan = async (calendarId: string, ics: string, onConflict: 'skip' | 'replace' | 'new_uid') => {
    const res = await api.post<PlanResponse>(`${BASE}/calendars/${calendarId}/import`, {
      auth: 'admin',
      body: { ics, mode: 'dry_run', on_conflict: onConflict },
    });
    return res;
  };

  test('azioni per gruppo nelle tre modalità, UID in un altro calendario, componenti non supportati, ordine del file', async () => {
    await setup();
    const uidNew = uidOf('nuovo');
    const uidHere = uidOf('qui');
    const uidThere = uidOf('altrove');
    await seedObject(target.id, uidHere, calendarText(vevent(uidHere)), '"etag-qui"');
    await seedObject(elsewhere.id, uidThere, calendarText(vevent(uidThere)));
    const ics = calendarText(
      vevent(uidNew, { summary: 'Riunione importata' }),
      vevent(uidHere),
      vevent(uidThere),
      ['BEGIN:VTODO', `UID:${uidOf('todo')}`, 'DTSTAMP:20270101T080000Z', 'SUMMARY:Da fare', 'END:VTODO'],
      vevent(uidOf('ricorrente'), { extra: ['RRULE:FREQ=WEEKLY;COUNT=3'] }),
    );
    const skip = await plan(target.id, ics, 'skip');
    assert.equal(skip.status, 200, skip.text);
    const p = skip.json;
    assert.equal(p.calendar_id, target.id);
    assert.equal(p.total, 5);
    assert.deepEqual([p.create, p.replace, p.skip, p.new_uid, p.invalid], [2, 0, 2, 0, 1]);
    assert.deepEqual(p.items.map((i) => i.index), [0, 1, 2, 3, 4]);
    assert.deepEqual(p.items.map((i) => i.action), ['create', 'skip', 'skip', 'invalid', 'create']);
    assert.deepEqual(p.items.map((i) => i.reason), [null, 'uid_exists', 'uid_in_other_calendar', 'component_unsupported', null]);
    assert.equal(p.items[0].summary, 'Riunione importata');
    assert.equal(p.items[0].start_utc, '2028-03-01T08:00:00.000Z');
    assert.equal(p.items[0].recurring, false);
    assert.equal(p.items[4].recurring, true);
    assert.match(p.plan_hash, /^[0-9a-f]{64}$/);

    const replace = (await plan(target.id, ics, 'replace')).json;
    assert.deepEqual(replace.items.map((i) => i.action), ['create', 'replace', 'new_uid', 'invalid', 'create']);
    assert.equal(replace.items[2].reason, 'uid_in_other_calendar', 'replace non vale su un altro calendario');
    assert.deepEqual([replace.create, replace.replace, replace.skip, replace.new_uid, replace.invalid], [2, 1, 0, 1, 1]);

    const newUid = (await plan(target.id, ics, 'new_uid')).json;
    assert.deepEqual(newUid.items.map((i) => i.action), ['create', 'new_uid', 'new_uid', 'invalid', 'create']);
    assert.deepEqual(newUid.items.map((i) => i.reason), [null, 'uid_exists', 'uid_in_other_calendar', 'component_unsupported', null]);

    assert.notEqual(p.plan_hash, replace.plan_hash);
    assert.equal((await plan(target.id, ics, 'skip')).json.plan_hash, p.plan_hash, 'stesso file e stesso stato → stesso hash');
  });

  test('METHOD rimosso, righe malformate e fusi senza VTIMEZONE negli avvisi; file senza eventi', async () => {
    await setup();
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//y//IT', 'METHOD:PUBLISH', 'X-WR-CALNAME:Esportato',
      'RIGA SENZA DUE PUNTI',
      ...vevent(uidOf('tz'), { tzid: 'Zona/Inventata' }),
      'END:VCALENDAR', '',
    ].join('\r\n');
    const res = await plan(target.id, ics, 'skip');
    assert.equal(res.status, 200, res.text);
    const w = res.json.warnings.join(' | ');
    assert.match(w, /METHOD/);
    assert.match(w, /righe malformate/);
    assert.match(w, /Zona\/Inventata/);
    const empty = await plan(target.id, calendarText(), 'skip');
    assert.equal(empty.status, 200);
    assert.equal(empty.json.total, 0);
    assert.match(empty.json.warnings.join(' '), /non contiene eventi/);
  });

  test('richieste non valide → 400; calendari che non accettano import → 403; calendario inesistente → 404', async () => {
    await setup();
    const url = `${BASE}/calendars/${target.id}/import`;
    const good = calendarText(vevent(uidOf('ok')));
    const bad: Array<[string, unknown]> = [
      ['senza ics', { mode: 'dry_run', on_conflict: 'skip' }],
      ['ics vuoto', { ics: '', mode: 'dry_run', on_conflict: 'skip' }],
      ['senza mode', { ics: good, on_conflict: 'skip' }],
      ['mode sconosciuto', { ics: good, mode: 'anteprima', on_conflict: 'skip' }],
      ['senza on_conflict', { ics: good, mode: 'dry_run' }],
      ['on_conflict sconosciuto', { ics: good, mode: 'dry_run', on_conflict: 'sovrascrivi' }],
      ['campo sconosciuto', { ics: good, mode: 'dry_run', on_conflict: 'skip', extra: 1 }],
      ['plan_hash non valido', { ics: good, mode: 'commit', on_conflict: 'skip', plan_hash: 'abc' }],
      ['file che non è iCalendar', { ics: 'questo non è un calendario', mode: 'dry_run', on_conflict: 'skip' }],
    ];
    for (const [label, body] of bad) {
      const res = await api.post(url, { auth: 'admin', body });
      assert.equal(res.status, 400, `${label}: ${res.text}`);
      assert.equal(res.json.code, 'VALIDATION_FAILED', label);
    }
    const subRes = await plan(sub.id, good, 'skip');
    assert.equal(subRes.status, 403);
    assert.equal(subRes.json.details?.reason, 'subscription');
    assert.equal((await plan(ANY_ID, good, 'skip')).status, 404);
    assert.equal((await plan('non-un-uuid', good, 'skip')).status, 404);
  });

  test('un file con più di 5000 eventi → 400', async () => {
    await setup();
    const many = calendarText(...Array.from({ length: 5001 }, (_, i) => ['BEGIN:VEVENT', `UID:massa-${i}@t.test`, 'DTSTAMP:20270101T080000Z', 'DTSTART:20280301T080000Z', 'DTEND:20280301T090000Z', 'SUMMARY:x', 'END:VEVENT']));
    const res = await plan(target.id, many, 'skip');
    assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.equal(res.json.code, 'VALIDATION_FAILED');
    assert.match(res.json.error ?? '', /5000/);
  });
});

describe('import: commit, idempotenza e job', () => {
  let target: { id: string };

  const setup = async (): Promise<void> => {
    if (target) return;
    target = await mk('commit');
    offlineRadicale();
    await setState('radicale');
    overrideCalendarStore('radicale');
  };

  after(async () => {
    overrideCalendarStore(null);
    await sql`DELETE FROM cal_jobs WHERE kind = 'calendar_import'`;
  });

  const url = () => `${BASE}/calendars/${target.id}/import`;
  const dry = async (ics: string, onConflict: 'skip' | 'replace' | 'new_uid' = 'skip'): Promise<CalV2ImportPlan> => {
    const res = await api.post<CalV2ImportPlan>(url(), { auth: 'admin', body: { ics, mode: 'dry_run', on_conflict: onConflict } });
    assert.equal(res.status, 200, res.text);
    return res.json;
  };
  const commit = (ics: string, planHash: string | undefined, key: string | undefined, onConflict: 'skip' | 'replace' | 'new_uid' = 'skip') =>
    api.post(url(), {
      auth: 'admin',
      headers: key === undefined ? {} : { 'Idempotency-Key': key },
      body: { ics, mode: 'commit', on_conflict: onConflict, ...(planHash ? { plan_hash: planHash } : {}) },
    });

  test('commit senza Idempotency-Key, con chiave non valida o nel corpo → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    await setup();
    const ics = calendarText(vevent(uidOf('k')));
    const p = await dry(ics);
    for (const key of [undefined, '', 'corta', 'con spazi dentro!', 'x'.repeat(201)]) {
      const res = await commit(ics, p.plan_hash, key);
      assert.equal(res.status, 400, String(key));
      assert.equal(res.json.code, 'IDEMPOTENCY_KEY_REQUIRED');
    }
    const inBody = await api.post(url(), {
      auth: 'admin',
      headers: { 'Idempotency-Key': 'chiave-valida-1234' },
      body: { ics, mode: 'commit', on_conflict: 'skip', plan_hash: p.plan_hash, idempotency_key: 'chiave-valida-1234' },
    });
    assert.equal(inBody.status, 400);
    assert.equal(inBody.json.code, 'IDEMPOTENCY_KEY_REQUIRED');
    const noHash = await commit(ics, undefined, 'chiave-senza-hash-1');
    assert.equal(noHash.status, 400);
    assert.equal(noHash.json.code, 'VALIDATION_FAILED');
    const [{ n }] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM cal_jobs WHERE kind = 'calendar_import' AND key LIKE ${`${target.id}:%`}`;
    assert.equal(Number(n), 0, 'nessun job creato');
  });

  test('PLAN_CHANGED: l\'hash dell\'anteprima non corrisponde più → 409 con il piano nuovo', async () => {
    await setup();
    const uid = uidOf('cambio');
    const ics = calendarText(vevent(uid));
    const p = await dry(ics);
    assert.equal(p.items[0].action, 'create');
    // Nel frattempo un device crea lo stesso UID.
    await seedObject(target.id, uid, calendarText(vevent(uid)));
    const res = await commit(ics, p.plan_hash, 'chiave-plan-changed-1');
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.code, 'PLAN_CHANGED');
    assert.equal(res.json.details.plan.items[0].action, 'skip');
    assert.notEqual(res.json.details.plan.plan_hash, p.plan_hash);
    const wrong = await commit(ics, 'f'.repeat(64), 'chiave-plan-changed-2');
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.code, 'PLAN_CHANGED');
  });

  test('commit → 202; stessa chiave e stessa richiesta → stesso job (anche a job chiuso); richiesta diversa → 409; job leggibile', async () => {
    await setup();
    const ics = calendarText(vevent(uidOf('job1')), vevent(uidOf('job2')));
    const p = await dry(ics);
    const key = 'chiave-job-uno-12345';
    const first = await commit(ics, p.plan_hash, key);
    assert.equal(first.status, 202, first.text);
    const accepted = first.json as CalV2JobAccepted;
    assert.equal(accepted.created, true);
    assert.match(accepted.job_id, /^\d+$/);

    const [job] = await sql<Array<{ kind: string; key: string; status: string; max_attempts: number; priority: number; payload: Record<string, unknown> }>>`
      SELECT kind, key, status, max_attempts, priority, payload FROM cal_jobs WHERE id = ${accepted.job_id}::bigint
    `;
    assert.equal(job.kind, 'calendar_import');
    assert.equal(job.key, `${target.id}:${key}`);
    assert.equal(job.status, 'pending');
    assert.equal(job.max_attempts, 3);
    assert.equal(job.priority, 100);
    assert.equal(job.payload.calendar_id, target.id);
    assert.equal(job.payload.plan_hash, p.plan_hash);
    assert.match(String(job.payload.request_hash), /^[0-9a-f]{64}$/);
    assert.equal((job.payload.items as unknown[]).length, 2);

    const again = await commit(ics, p.plan_hash, key);
    assert.equal(again.status, 202);
    assert.deepEqual(again.json, { job_id: accepted.job_id, created: false });

    const conflictMode = await commit(ics, p.plan_hash, key, 'replace');
    assert.equal(conflictMode.status, 409);
    assert.equal(conflictMode.json.code, 'IDEMPOTENCY_CONFLICT');
    const otherIcs = calendarText(vevent(uidOf('altro')));
    const conflictBody = await commit(otherIcs, (await dry(otherIcs)).plan_hash, key);
    assert.equal(conflictBody.status, 409);
    assert.equal(conflictBody.json.code, 'IDEMPOTENCY_CONFLICT');
    const [{ n }] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM cal_jobs WHERE kind = 'calendar_import' AND key = ${`${target.id}:${key}`}`;
    assert.equal(Number(n), 1, 'un solo job per chiave');

    // A job chiuso la stessa richiesta restituisce ancora lo stesso job, senza ricalcolare il piano.
    await sql`UPDATE cal_jobs SET status = 'done', finished_at = now(), result = ${sql.json({ created: 2, replaced: 0, skipped: 0, failed: [], progress: { total: 2, done: 2, failed: 0 }, cursor: 2 })} WHERE id = ${accepted.job_id}::bigint`;
    const afterDone = await commit(ics, p.plan_hash, key);
    assert.equal(afterDone.status, 202);
    assert.deepEqual(afterDone.json, { job_id: accepted.job_id, created: false });

    const view = await api.get<CalV2JobView>(`${BASE}/jobs/${accepted.job_id}`, { auth: 'admin' });
    assert.equal(view.status, 200, view.text);
    assert.equal(view.json.id, accepted.job_id);
    assert.equal(view.json.kind, 'calendar_import');
    assert.equal(view.json.status, 'done');
    assert.equal(view.json.calendar_id, target.id);
    assert.deepEqual(view.json.progress, { total: 2, done: 2, failed: 0 });
    assert.deepEqual(view.json.result, { created: 2, replaced: 0, skipped: 0, failed: [] });
    assert.ok(view.json.finished_at);
    const [payload] = await sql<Array<{ has_ics: boolean }>>`SELECT (payload ? 'ics') AS has_ics FROM cal_jobs WHERE id = ${accepted.job_id}::bigint`;
    assert.equal(payload.has_ics, false, 'a job chiuso il testo ICS non resta nel payload');
  });

  test('chiavi diverse → job diversi; la stessa chiave su un altro calendario è un altro job', async () => {
    await setup();
    const ics = calendarText(vevent(uidOf('multi')));
    const p = await dry(ics);
    const a = await commit(ics, p.plan_hash, 'chiave-multi-aaaa-1');
    const b = await commit(ics, p.plan_hash, 'chiave-multi-bbbb-2');
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.notEqual(a.json.job_id, b.json.job_id);
  });
});

describe('limiti del corpo', () => {
  test('oltre 2 MB → 413 PAYLOAD_TOO_LARGE; l\'import arriva a 10 MB', async () => {
    const cal = await mk('limiti');
    offlineRadicale();
    await setState('radicale');
    overrideCalendarStore('radicale');
    try {
      // Come dal browser: con Content-Length il controllo avviene prima della lettura; senza (trasferimento a blocchi) durante.
      const withLength = (body: unknown): Record<string, string> => ({ 'Content-Length': String(Buffer.byteLength(JSON.stringify(body))) });
      const bigCreate = { name: 'x'.repeat(3 * 1024 * 1024) };
      const big = await api.post(`${BASE}/calendars`, { auth: 'admin', body: bigCreate, headers: withLength(bigCreate) });
      assert.equal(big.status, 413);
      assert.equal(big.json.code, 'PAYLOAD_TOO_LARGE');
      assert.deepEqual(big.json.details, { max_bytes: 2 * 1024 * 1024 });
      const chunked = await api.post(`${BASE}/calendars`, { auth: 'admin', body: bigCreate });
      assert.equal(chunked.status, 413, 'senza Content-Length');
      assert.equal(chunked.json.code, 'PAYLOAD_TOO_LARGE');
      const bigPatch = { description: 'x'.repeat(3 * 1024 * 1024) };
      const patched = await api.patch(`${BASE}/calendars/${cal.id}`, { auth: 'admin', body: bigPatch, headers: withLength(bigPatch) });
      assert.equal(patched.status, 413);
      assert.equal(patched.json.code, 'PAYLOAD_TOO_LARGE');

      // 3 MB di file ICS: sopra il limite globale ma sotto quello dell'import.
      const ics = (n: number) => calendarText(...Array.from({ length: n }, (_, i) => vevent(`grande-${i}@t.test`, { extra: [`DESCRIPTION:${'a'.repeat(50_000)}`] })));
      const midBody = { ics: ics(60), mode: 'dry_run', on_conflict: 'skip' };
      const ok = await api.post(`${BASE}/calendars/${cal.id}/import`, { auth: 'admin', body: midBody, headers: withLength(midBody) });
      assert.equal(ok.status, 200, ok.text.slice(0, 200));
      assert.equal(ok.json.total, 60);

      // Oltre 10 MB il limite globale dell'app (app.ts, anch'esso di 10 MB) scatta prima di quello della route: 413 senza il codice.
      const hugeBody = { ics: ics(220), mode: 'dry_run', on_conflict: 'skip' };
      const huge = await api.post(`${BASE}/calendars/${cal.id}/import`, { auth: 'admin', body: hugeBody, headers: withLength(hugeBody) });
      assert.equal(huge.status, 413, huge.text.slice(0, 200));
    } finally {
      overrideCalendarStore(null);
    }
  });
});

describe('export', () => {
  test('un solo VCALENDAR con PRODID del sistema, VTIMEZONE deduplicati e i componenti dal testo (indice)', async () => {
    const cal = await mk('export');
    offlineRadicale();
    await setState('radicale');
    overrideCalendarStore('radicale');
    try {
      const tz = ['BEGIN:VTIMEZONE', 'TZID:Europe/Rome', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE'];
      const withTz = (uid: string, extra: string[] = []): string => calendarText(tz, vevent(uid, { tzid: 'Europe/Rome', extra }));
      const a = uidOf('a');
      const b = uidOf('b');
      await seedObject(cal.id, a, withTz(a, ['X-ACME-CUSTOM;X-PARAM=uno:valore', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Tra poco', 'END:VALARM']));
      await seedObject(cal.id, b, withTz(b));
      const res = await api.get(`${BASE}/calendars/${cal.id}/export.ics`, { auth: 'admin' });
      assert.equal(res.status, 200, res.text);
      assert.match(res.headers.get('content-type') ?? '', /^text\/calendar; charset=utf-8/);
      assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="[A-Za-z0-9._-]+\.ics"$/);
      const text = res.text;
      assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Caldes//calendar-core//IT\r\n'));
      assert.ok(text.endsWith('END:VCALENDAR\r\n'));
      assert.equal(text.match(/BEGIN:VCALENDAR/g)?.length, 1);
      assert.equal(text.match(/BEGIN:VTIMEZONE/g)?.length, 1, 'un VTIMEZONE per TZID');
      assert.equal(text.match(/BEGIN:VEVENT/g)?.length, 2);
      assert.ok(text.indexOf('BEGIN:VTIMEZONE') < text.indexOf('BEGIN:VEVENT'), 'il VTIMEZONE precede gli eventi');
      for (const needle of ['X-ACME-CUSTOM;X-PARAM=uno:valore', 'BEGIN:VALARM', 'TRIGGER:-PT15M', a, b]) assert.ok(text.includes(needle), needle);
      assert.ok(!text.includes('PRODID:-//Test//C2//IT'), 'il PRODID del file originale non passa');
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('calendario inesistente → 404', async () => {
    overrideCalendarStore('radicale');
    try {
      offlineRadicale();
      await setState('radicale');
      assert.equal((await api.get(`${BASE}/calendars/${ANY_ID}/export.ics`, { auth: 'admin' })).status, 404);
    } finally {
      overrideCalendarStore(null);
    }
  });
});

describe('GET /jobs/:jobId', () => {
  test('job di un altro tipo, id non numerico o inesistente → 404; i tipi di CAL_V2_JOB_KINDS si leggono', async () => {
    offlineRadicale();
    await setState('radicale');
    overrideCalendarStore('radicale');
    try {
      const [other] = await sql<Array<{ id: string }>>`
        INSERT INTO cal_jobs (kind, key, payload) VALUES ('project_booking', ${`${TAG}-estraneo`}, '{}'::jsonb) RETURNING id::text AS id
      `;
      assert.equal((await api.get(`${BASE}/jobs/${other.id}`, { auth: 'admin' })).status, 404, 'tipo estraneo');
      assert.equal((await api.get(`${BASE}/jobs/99999999999`, { auth: 'admin' })).status, 404, 'inesistente');
      assert.equal((await api.get(`${BASE}/jobs/abc`, { auth: 'admin' })).status, 404, 'non numerico');
      assert.equal((await api.get(`${BASE}/jobs/-1`, { auth: 'admin' })).status, 404, 'negativo');

      const [hold] = await sql<Array<{ id: string }>>`
        INSERT INTO cal_jobs (kind, key, payload) VALUES ('calendar_hold_apply', ${`${ANY_ID}:chiave-hold-1234`}, ${sql.json({ calendar_id: ANY_ID })}) RETURNING id::text AS id
      `;
      const res = await api.get<CalV2JobView>(`${BASE}/jobs/${hold.id}`, { auth: 'admin' });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.kind, 'calendar_hold_apply');
      assert.equal(res.json.status, 'pending');
      assert.equal(res.json.calendar_id, ANY_ID);
      assert.equal(res.json.progress, null);
      assert.equal(res.json.result, null);
      assert.equal(res.json.finished_at, null);
    } finally {
      overrideCalendarStore(null);
    }
  });
});
