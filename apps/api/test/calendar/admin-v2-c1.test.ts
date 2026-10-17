/**
 * Route della tranche C, passo C1, dell'API admin del calendario v2 (editor
 * raw, sposta, duplica, export, cronologia, cestino; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.2, §9.1.3, §9.7, §9.9),
 * senza Radicale.
 *
 * Casi: JWT admin (401) e difesa CSRF (403, 415) su ogni route nuova; mode
 * postgres → 409 STORE_MODE_UNSUPPORTED senza toccare nulla; con lo store
 * Radicale 428 senza If-Match (o con `*`) su raw, sposta e ripristino; testo
 * raw con UID diverso → 400 VALIDATION_FAILED (property UID), VTODO → 403
 * READ_ONLY (component_unsupported), testo non iCalendar → 400; corpi e query
 * non validi → 400; i flag di capacità C1 veri con lo store Radicale.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { configureRadicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import { RadicaleClient, TransportError } from '../../src/lib/calendar/radicale/client';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import { onBeforeDatabaseClose, onDatabaseReady, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { api } from '../helpers/http';

useTestDatabase({ resetBaseline: true });
onDatabaseReady(async () => {
  overrideCalendarStore(null);
});
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});
const fx = useFixtures('admin-v2-c1');

const BASE = '/api/admin/calendar/v2';
const VOLUME = '3c1e2d4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ANY_ID = '5f0c2b7e-9a41-4d6c-8e3b-2a7d1c9f4e60';
const UID = 'c1-unit-uid@caldes.test';

const ics = (component: 'VEVENT' | 'VTODO', uid: string): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//c1//IT',
    `BEGIN:${component}`,
    `UID:${uid}`,
    'DTSTAMP:20270101T000000Z',
    ...(component === 'VEVENT' ? ['DTSTART:20270405T070000Z', 'DTEND:20270405T080000Z'] : []),
    'SUMMARY:Prova',
    `END:${component}`,
    'END:VCALENDAR',
    '',
  ].join('\r\n');

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
  const [row] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM audit_logs WHERE table_name = 'cal_objects'`;
  return Number(row.n);
}

/** Tutte le route nuove del passo C1 con un corpo plausibile. */
const ROUTES: Array<{ method: 'get' | 'put' | 'post'; path: string; body?: unknown; ifMatch?: boolean }> = [
  { method: 'put', path: `${BASE}/objects/${ANY_ID}/ics`, body: { ics: ics('VEVENT', UID) }, ifMatch: true },
  { method: 'post', path: `${BASE}/objects/${ANY_ID}/move`, body: { calendar_id: ANY_ID }, ifMatch: true },
  { method: 'post', path: `${BASE}/objects/${ANY_ID}/duplicate`, body: {} },
  { method: 'get', path: `${BASE}/objects/${ANY_ID}/export.ics` },
  { method: 'get', path: `${BASE}/objects/${ANY_ID}/versions` },
  { method: 'get', path: `${BASE}/objects/${ANY_ID}/versions/${ANY_ID}` },
  { method: 'post', path: `${BASE}/objects/${ANY_ID}/restore`, body: { version_id: ANY_ID }, ifMatch: true },
  { method: 'get', path: `${BASE}/trash` },
  { method: 'post', path: `${BASE}/trash/${ANY_ID}/restore`, body: {} },
];

describe('autenticazione e CSRF', () => {
  test('senza JWT ogni route nuova risponde 401', async () => {
    for (const r of ROUTES) {
      const res = await api[r.method](r.path, r.method === 'get' ? {} : { body: r.body });
      assert.equal(res.status, 401, `${r.method} ${r.path}`);
    }
  });

  test('Sec-Fetch-Site e Origin estranei → 403 CSRF_REJECTED sulle scritture; le letture non sono toccate', async () => {
    await setState('postgres');
    for (const r of ROUTES.filter((x) => x.method !== 'get')) {
      const site = await api[r.method as 'put' | 'post'](r.path, { auth: 'admin', headers: { 'Sec-Fetch-Site': 'cross-site', 'If-Match': '"x"' }, body: r.body });
      assert.equal(site.status, 403, `${r.method} ${r.path} cross-site`);
      assert.equal(site.json.code, 'CSRF_REJECTED');
      const origin = await api[r.method as 'put' | 'post'](r.path, { auth: 'admin', headers: { Origin: 'https://evil.example', 'If-Match': '"x"' }, body: r.body });
      assert.equal(origin.status, 403, `${r.method} ${r.path} origine estranea`);
      assert.equal(origin.json.code, 'CSRF_REJECTED');
    }
    const read = await api.get(`${BASE}/trash`, { auth: 'admin', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(read.status, 409, 'una lettura cross-site non è un CSRF: risponde la route');
  });

  test('un corpo che non è application/json → 415', async () => {
    for (const r of ROUTES.filter((x) => x.method !== 'get')) {
      const res = await api[r.method as 'put' | 'post'](r.path, { auth: 'admin', headers: { 'Content-Type': 'text/plain', 'If-Match': '"x"' }, body: 'testo' });
      assert.equal(res.status, 415, `${r.method} ${r.path}`);
    }
  });
});

describe('mode postgres: 409 STORE_MODE_UNSUPPORTED su ogni route nuova', () => {
  test('nessuna scrittura, nessuna riga di audit', async () => {
    await setState('postgres');
    const before = await auditCount();
    for (const r of ROUTES) {
      const res = await api[r.method](r.path, {
        auth: 'admin',
        ...(r.method === 'get' ? {} : { body: r.body, headers: r.ifMatch ? { 'If-Match': '"x"' } : {} }),
      });
      assert.equal(res.status, 409, `${r.method} ${r.path}: ${res.text}`);
      assert.equal(res.json.code, 'STORE_MODE_UNSUPPORTED');
      assert.deepEqual(res.json.details, { mode: 'postgres', store: 'postgres' });
    }
    assert.equal(await auditCount(), before, 'nessuna riga di audit');
  });
});

describe('capacità della tranche C, passo C1', () => {
  test('postgres: tutti falsi; radicale: raw_edit, object_tools, history e trash veri, health_page e occurrences ancora falsi', async () => {
    await setState('postgres');
    let res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['raw_edit', 'object_tools', 'history', 'trash']) assert.equal(res.json[flag], false, flag);
    offlineRadicale();
    await setState('radicale');
    res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['raw_edit', 'object_tools', 'history', 'trash']) assert.equal(res.json[flag], true, flag);
    for (const flag of ['health_page', 'occurrences']) assert.equal(res.json[flag], false, flag);
    // Rollback: lettura sì (i flag dicono che la funzione esiste), scrittura no.
    await setState('rollback');
    res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    assert.equal(res.json.trash, true);
    assert.equal(res.json.objects.write, false);
    // Radicale non configurato: niente lettura, quindi nessun flag.
    configureRadicaleRuntime(null);
    await setState('radicale');
    res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    for (const flag of ['raw_edit', 'object_tools', 'history', 'trash']) assert.equal(res.json[flag], false, flag);
    await setState('postgres');
  });
});

describe('validazione con lo store Radicale', () => {
  const headers = { 'If-Match': '"abc"' };

  test('raw, sposta e ripristino senza If-Match, o con `*`, → 428 PRECONDITION_REQUIRED', async () => {
    overrideCalendarStore('radicale');
    try {
      for (const r of ROUTES.filter((x) => x.ifMatch)) {
        for (const ifMatch of [undefined, '*', '']) {
          const h: Record<string, string> = ifMatch === undefined ? {} : { 'If-Match': ifMatch };
          const res = await api[r.method as 'put' | 'post'](r.path, { auth: 'admin', headers: h, body: r.body });
          assert.equal(res.status, 428, `${r.method} ${r.path} If-Match=${String(ifMatch)}`);
          assert.equal(res.json.code, 'PRECONDITION_REQUIRED');
        }
      }
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('corpi non validi → 400 VALIDATION_FAILED con details.issues', async () => {
    overrideCalendarStore('radicale');
    try {
      const cases: Array<[string, 'put' | 'post', string, unknown, boolean]> = [
        ['raw senza ics', 'put', `${BASE}/objects/${ANY_ID}/ics`, {}, true],
        ['raw con ics vuoto', 'put', `${BASE}/objects/${ANY_ID}/ics`, { ics: '' }, true],
        ['raw con campo sconosciuto', 'put', `${BASE}/objects/${ANY_ID}/ics`, { ics: ics('VEVENT', UID), altro: 1 }, true],
        ['raw oltre 1 MB', 'put', `${BASE}/objects/${ANY_ID}/ics`, { ics: 'x'.repeat(1024 * 1024 + 1) }, true],
        ['sposta senza calendar_id', 'post', `${BASE}/objects/${ANY_ID}/move`, {}, true],
        ['duplica con uid non valido', 'post', `${BASE}/objects/${ANY_ID}/duplicate`, { uid: 'con spazi' }, false],
        ['duplica con start non valido', 'post', `${BASE}/objects/${ANY_ID}/duplicate`, { start: { type: 'date', year: 2027, month: 13, day: 1 } }, false],
        ['duplica con recurrence_key non valida', 'post', `${BASE}/objects/${ANY_ID}/duplicate`, { recurrence_key: 'domani' }, false],
        ['duplica keep_recurrence su un\'istanza', 'post', `${BASE}/objects/${ANY_ID}/duplicate`, { recurrence_key: '20270406T080000Z', keep_recurrence: true }, false],
        ['ripristino senza version_id', 'post', `${BASE}/objects/${ANY_ID}/restore`, {}, true],
        ['ripristino con version_id non UUID', 'post', `${BASE}/objects/${ANY_ID}/restore`, { version_id: 'ieri' }, true],
        ['cestino con calendar_id non UUID', 'post', `${BASE}/trash/${ANY_ID}/restore`, { calendar_id: 123 }, false],
      ];
      for (const [label, method, path, body, needsIfMatch] of cases) {
        const res = await api[method](path, { auth: 'admin', headers: needsIfMatch ? headers : {}, body });
        assert.equal(res.status, 400, `${label}: ${res.text}`);
        assert.equal(res.json.code, 'VALIDATION_FAILED', label);
        assert.ok(Array.isArray(res.json.details?.issues) && res.json.details.issues.length > 0, `${label}: details.issues`);
      }
      const badLimit = await api.get(`${BASE}/trash`, { auth: 'admin', query: { limit: '0' } });
      assert.equal(badLimit.status, 400);
      const bigLimit = await api.get(`${BASE}/trash`, { auth: 'admin', query: { limit: '101' } });
      assert.equal(bigLimit.status, 400);
      const badBefore = await api.get(`${BASE}/trash`, { auth: 'admin', query: { before: 'non-un-cursore' } });
      assert.equal(badBefore.status, 400);
      const badCal = await api.get(`${BASE}/trash`, { auth: 'admin', query: { calendar_id: 'x' } });
      assert.equal(badCal.status, 400);
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('oggetto, versione o elemento del cestino inesistenti → 404 NOT_FOUND', async () => {
    overrideCalendarStore('radicale');
    try {
      const raw = await api.put(`${BASE}/objects/${ANY_ID}/ics`, { auth: 'admin', headers, body: { ics: ics('VEVENT', UID) } });
      assert.equal(raw.status, 404);
      assert.equal(raw.json.code, 'NOT_FOUND');
      const versions = await api.get(`${BASE}/objects/${ANY_ID}/versions`, { auth: 'admin' });
      assert.equal(versions.status, 404);
      const trash = await api.post(`${BASE}/trash/${ANY_ID}/restore`, { auth: 'admin', body: {} });
      assert.equal(trash.status, 404);
      assert.equal(trash.json.code, 'NOT_FOUND');
      const listed = await api.get(`${BASE}/trash`, { auth: 'admin' });
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.json, { items: [], next: null, retention_days: 90 });
    } finally {
      overrideCalendarStore(null);
    }
  });
});

describe('editor raw: controlli sul testo prima di contattare Radicale', () => {
  test('UID diverso → 400 (property UID); VTODO → 403 component_unsupported; non iCalendar → 400', async () => {
    const cal = await fx.calendar({ key: 'raw' });
    overrideCalendarStore('radicale');
    try {
      const href = 'c1-unit.ics';
      const [row] = await sql<Array<{ id: string }>>`
        INSERT INTO cal_object_ids (calendar_id, href, recurrence_key, uid) VALUES (${cal.id}::uuid, ${href}, '', ${UID}) RETURNING id
      `;
      const headers = { 'If-Match': '"abc"' };
      const path = `${BASE}/objects/${row.id}/ics`;
      const before = await auditCount();

      const otherUid = await api.put(path, { auth: 'admin', headers, body: { ics: ics('VEVENT', 'altro-uid@caldes.test') } });
      assert.equal(otherUid.status, 400, otherUid.text);
      assert.equal(otherUid.json.code, 'VALIDATION_FAILED');
      assert.ok(otherUid.json.details.issues.some((i: { property?: string }) => i.property === 'UID'), 'issue sulla property UID');

      const todo = await api.put(path, { auth: 'admin', headers, body: { ics: ics('VTODO', UID) } });
      assert.equal(todo.status, 403, todo.text);
      assert.equal(todo.json.code, 'READ_ONLY');
      assert.equal(todo.json.details.reason, 'component_unsupported');

      const notIcs = await api.put(path, { auth: 'admin', headers, body: { ics: 'questo non è un calendario' } });
      assert.equal(notIcs.status, 400, notIcs.text);
      assert.equal(notIcs.json.code, 'VALIDATION_FAILED');

      const twoUids = ics('VEVENT', UID).replace('END:VCALENDAR', `${ics('VEVENT', 'secondo@caldes.test').split('BEGIN:VEVENT')[1].split('END:VCALENDAR')[0].replace(/^/, 'BEGIN:VEVENT')}END:VCALENDAR`);
      const multi = await api.put(path, { auth: 'admin', headers, body: { ics: twoUids } });
      assert.equal(multi.status, 400, multi.text);
      assert.ok(multi.json.details.issues.some((i: { property?: string }) => i.property === 'UID'), 'più UID: issue sulla property UID');

      assert.equal(await auditCount(), before, 'nessuna riga di audit');
    } finally {
      overrideCalendarStore(null);
    }
  });
});
