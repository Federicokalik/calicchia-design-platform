/**
 * Route dell'API admin del calendario v2 (routes/calendar/admin-v2.ts;
 * contratto docs/calendar-radicale/contracts/f6-modules.md §2, §3.1, §3.5,
 * §3.10, §8), senza Radicale.
 *
 * Casi: JWT admin obbligatorio (401, 403 per un altro ruolo); difesa CSRF
 * (403 per Sec-Fetch-Site e Origin estranei, 415 per un corpo non JSON);
 * capacità per modo (postgres, cutover, rollback, radicale, write_freeze,
 * Radicale non configurato); mode postgres → 409 STORE_MODE_UNSUPPORTED su
 * tutte le route `objects` senza toccare nulla; con lo store Radicale: 428
 * senza If-Match o con `*`, 400 SCOPE_INVALID, nomi riservati e valori non
 * validi → 400 VALIDATION_FAILED con details.issues, GET con entrambi i
 * parametri di target → 400, corpo oltre 2 MB rifiutato.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { invalidateBackendModeCache } from '../../src/lib/calendar/backend-mode';
import { configureRadicaleRuntime } from '../../src/lib/calendar/radicale/sync';
import { RadicaleClient, TransportError } from '../../src/lib/calendar/radicale/client';
import { overrideCalendarStore } from '../../src/lib/calendar/store';
import { onBeforeDatabaseClose, onDatabaseReady, resetCalendarBaseline, sql, useTestDatabase } from '../helpers/db';
import { api, signTestToken } from '../helpers/http';

useTestDatabase({ resetBaseline: true });
onDatabaseReady(async () => {
  overrideCalendarStore(null);
});
onBeforeDatabaseClose(async () => {
  overrideCalendarStore(null);
  configureRadicaleRuntime(null);
  await resetCalendarBaseline();
});

const BASE = '/api/admin/calendar/v2';
const VOLUME = '3c1e2d4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ANY_ID = '5f0c2b7e-9a41-4d6c-8e3b-2a7d1c9f4e60';
const START = { type: 'date-time', year: 2027, month: 4, day: 5, hour: 9, minute: 0, second: 0, zone: { kind: 'tzid', tzid: 'Europe/Rome' } } as const;

async function setState(mode: string, opts: { freeze?: boolean } = {}): Promise<void> {
  await sql`
    UPDATE calendar_backend_state
    SET mode = ${mode}, write_freeze = ${opts.freeze ?? false},
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

const patchBody = (extra: Record<string, unknown> = {}) => ({
  target: { recurrence_key: '' },
  scope: 'all',
  ops: [{ op: 'set', field: 'summary', value: 'Nuovo titolo' }],
  base: { summary: '0123456789abcdef' },
  ...extra,
});

async function auditCount(): Promise<number> {
  const [row] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM audit_logs WHERE table_name = 'cal_objects'`;
  return Number(row.n);
}

describe('autenticazione', () => {
  test('senza JWT 401, con un JWT non admin 403', async () => {
    const anon = await api.get(`${BASE}/capabilities`);
    assert.equal(anon.status, 401);
    const anonWrite = await api.post(`${BASE}/objects`, { body: { calendar_id: ANY_ID, fields: { start: START } } });
    assert.equal(anonWrite.status, 401);
    const client = await api.get(`${BASE}/capabilities`, { auth: { bearer: await signTestToken({ role: 'client' }) } });
    assert.equal(client.status, 403);
    const admin = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    assert.equal(admin.status, 200);
  });
});

describe('difesa CSRF', () => {
  test('Sec-Fetch-Site e Origin estranei → 403 CSRF_REJECTED su POST, PATCH e DELETE', async () => {
    await setState('postgres');
    for (const [method, path] of [['post', `${BASE}/objects`], ['patch', `${BASE}/objects/${ANY_ID}`], ['delete', `${BASE}/objects/${ANY_ID}`]] as const) {
      const site = await api[method](path, { auth: 'admin', headers: { 'Sec-Fetch-Site': 'cross-site', 'If-Match': '"x"' }, body: {} });
      assert.equal(site.status, 403, `${method} cross-site`);
      assert.equal(site.json.code, 'CSRF_REJECTED');
      const origin = await api[method](path, { auth: 'admin', headers: { Origin: 'https://evil.example', 'If-Match': '"x"' }, body: {} });
      assert.equal(origin.status, 403, `${method} origine estranea`);
      assert.equal(origin.json.code, 'CSRF_REJECTED');
    }
  });

  test('un corpo che non è application/json → 415', async () => {
    const plain = await api.post(`${BASE}/objects`, { auth: 'admin', headers: { 'Content-Type': 'text/plain' }, body: '{"calendar_id":"x"}' });
    assert.equal(plain.status, 415);
    const form = await api.patch(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'If-Match': '"x"' }, body: 'a=b' });
    assert.equal(form.status, 415);
  });

  test('le letture non richiedono Sec-Fetch-Site', async () => {
    const res = await api.get(`${BASE}/capabilities`, { auth: 'admin', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(res.status, 200);
  });
});

describe('capacità per modo (§2)', () => {
  test('postgres: nessuna operazione sugli oggetti, flag della tranche C false', async () => {
    await setState('postgres');
    const res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      api_version: 2,
      mode: 'postgres',
      store: 'postgres',
      objects: { read: false, write: false, dry_run: false, scopes: [] },
      history: false,
      trash: false,
      import_export: false,
      calendar_properties: false,
      health_page: false,
      reasons: ['STORE_POSTGRES'],
    });
  });

  test('cutover: STORE_POSTGRES e WRITES_SUSPENDED', async () => {
    await setState('cutover');
    const res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    assert.equal(res.json.objects.read, false);
    assert.deepEqual(res.json.reasons, ['STORE_POSTGRES', 'WRITES_SUSPENDED']);
    await setState('postgres');
  });

  test('radicale: lettura e scrittura, con write_freeze solo lettura; rollback: sola lettura', async () => {
    offlineRadicale();
    await setState('radicale');
    let res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    assert.equal(res.json.store, 'radicale');
    assert.deepEqual(res.json.objects, { read: true, write: true, dry_run: true, scopes: ['this', 'this_and_future', 'all'] });
    assert.deepEqual(res.json.reasons, []);

    await setState('radicale', { freeze: true });
    res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    assert.deepEqual([res.json.objects.read, res.json.objects.write, res.json.objects.dry_run], [true, false, true]);
    assert.deepEqual(res.json.reasons, ['WRITE_FREEZE']);

    await setState('rollback');
    res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    assert.deepEqual([res.json.objects.read, res.json.objects.write, res.json.objects.dry_run], [true, false, true]);
    assert.deepEqual(res.json.reasons, ['WRITES_SUSPENDED']);

    await setState('finalized');
    res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    assert.deepEqual([res.json.objects.read, res.json.objects.write], [true, true]);
    await setState('postgres');
  });

  test('Radicale non configurato: niente lettura né scrittura', async () => {
    configureRadicaleRuntime(null);
    await setState('radicale');
    const res = await api.get(`${BASE}/capabilities`, { auth: 'admin' });
    assert.deepEqual([res.json.objects.read, res.json.objects.write, res.json.objects.dry_run], [false, false, false]);
    assert.deepEqual(res.json.reasons, ['RADICALE_UNCONFIGURED']);
    await setState('postgres');
  });
});

describe('mode postgres: le route objects rispondono 409 STORE_MODE_UNSUPPORTED', () => {
  test('tutte le route, senza toccare nulla', async () => {
    await setState('postgres');
    const before = await auditCount();
    const calls = [
      await api.get(`${BASE}/objects/${ANY_ID}`, { auth: 'admin' }),
      await api.get(`${BASE}/objects/${ANY_ID}/ics`, { auth: 'admin' }),
      await api.patch(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', headers: { 'If-Match': '"x"' }, body: patchBody() }),
      await api.patch(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', body: {} }),
      await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: ANY_ID, fields: { start: START } } }),
      await api.delete(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', headers: { 'If-Match': '"x"' }, query: { scope: 'all' } }),
    ];
    for (const res of calls) {
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.code, 'STORE_MODE_UNSUPPORTED');
      assert.deepEqual(res.json.details, { mode: 'postgres', store: 'postgres' });
    }
    assert.equal(await auditCount(), before, 'nessuna riga di audit');
  });
});

describe('validazione delle richieste con lo store Radicale', () => {
  const headers = { 'If-Match': '"abc"' };

  test('PATCH e DELETE senza If-Match, o con `*` → 428 PRECONDITION_REQUIRED', async () => {
    overrideCalendarStore('radicale');
    try {
      for (const ifMatch of [undefined, '*', '']) {
        const h: Record<string, string> = ifMatch === undefined ? {} : { 'If-Match': ifMatch };
        const patch = await api.patch(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', headers: h, body: patchBody() });
        assert.equal(patch.status, 428, `PATCH If-Match=${String(ifMatch)}`);
        assert.equal(patch.json.code, 'PRECONDITION_REQUIRED');
        const del = await api.delete(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', headers: h, query: { scope: 'all' } });
        assert.equal(del.status, 428, `DELETE If-Match=${String(ifMatch)}`);
      }
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('SCOPE_INVALID: scope sconosciuto, spostamento con scope diverso da all, DELETE con scope sconosciuto', async () => {
    overrideCalendarStore('radicale');
    try {
      const bad = await api.patch(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', headers, body: patchBody({ scope: 'tutto' }) });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.code, 'SCOPE_INVALID');
      const move = await api.patch(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', headers, body: patchBody({ scope: 'this', target: { recurrence_key: '20270406T080000Z' }, move_to_calendar_id: ANY_ID }) });
      assert.equal(move.status, 400);
      assert.equal(move.json.code, 'SCOPE_INVALID');
      const del = await api.delete(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', headers, query: { scope: 'sempre' } });
      assert.equal(del.status, 400);
      assert.equal(del.json.code, 'SCOPE_INVALID');
      // La DELETE di un'istanza senza scope dipende dal componente indicato dall'id (un id di override ha come
      // target l'override): richiede l'oggetto risolto ed è coperta in integration/admin-v2-radicale.test.ts.
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('set_property su un nome riservato, non valido o con proprietà di un altro nome → 400 VALIDATION_FAILED', async () => {
    overrideCalendarStore('radicale');
    try {
      for (const name of ['SUMMARY', 'DTSTART', 'RRULE', 'ATTENDEE', 'UID', 'SEQUENCE', 'CREATED', 'LAST-MODIFIED', 'DTSTAMP']) {
        const res = await api.patch(`${BASE}/objects/${ANY_ID}`, {
          auth: 'admin',
          headers,
          body: patchBody({ ops: [{ op: 'set_property', name, properties: [{ name, params: [], value: 'x' }] }] }),
        });
        assert.equal(res.status, 400, name);
        assert.equal(res.json.code, 'VALIDATION_FAILED');
        assert.ok(Array.isArray(res.json.details.issues) && res.json.details.issues.length > 0, 'details.issues');
      }
      const lower = await api.patch(`${BASE}/objects/${ANY_ID}`, {
        auth: 'admin',
        headers,
        body: patchBody({ ops: [{ op: 'set_property', name: 'x-foo', properties: [] }] }),
      });
      assert.equal(lower.status, 400);
      const mismatch = await api.patch(`${BASE}/objects/${ANY_ID}`, {
        auth: 'admin',
        headers,
        body: patchBody({ ops: [{ op: 'set_property', name: 'X-FOO', properties: [{ name: 'X-BAR', params: [], value: 'x' }] }] }),
      });
      assert.equal(mismatch.status, 400);
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('ops: da 1 a 50, un campo una sola volta, valori conformi ai tipi', async () => {
    overrideCalendarStore('radicale');
    try {
      const cases: Array<[string, unknown[]]> = [
        ['nessuna op', []],
        ['campo ripetuto', [{ op: 'set', field: 'summary', value: 'a' }, { op: 'set', field: 'summary', value: 'b' }]],
        ['tipo sbagliato', [{ op: 'set', field: 'priority', value: 12 }]],
        ['campo sconosciuto', [{ op: 'set', field: 'colore', value: 'rosso' }]],
        ['testo oltre 64 KB', [{ op: 'set', field: 'description', value: 'x'.repeat(70_000) }]],
        ['troppi promemoria', [{ op: 'set', field: 'alarms', value: Array.from({ length: 21 }, () => ({ name: 'VALARM', properties: [], components: [] })) }]],
        ['tempo non valido', [{ op: 'set', field: 'start', value: { type: 'date', year: 2027, month: 13, day: 1 } }]],
      ];
      for (const [label, ops] of cases) {
        const res = await api.patch(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', headers, body: patchBody({ ops }) });
        assert.equal(res.status, 400, label);
        assert.equal(res.json.code, 'VALIDATION_FAILED', label);
      }
      const many = Array.from({ length: 51 }, (_, i) => ({ op: 'set_property', name: `X-P${i}`, properties: [] }));
      const res = await api.patch(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', headers, body: patchBody({ ops: many }) });
      assert.equal(res.status, 400);
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('POST: corpo non valido → 400; GET con recurrence_key e original_start → 400', async () => {
    overrideCalendarStore('radicale');
    try {
      const noStart = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: ANY_ID, fields: {} } });
      assert.equal(noStart.status, 400);
      assert.equal(noStart.json.code, 'VALIDATION_FAILED');
      const badUid = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: ANY_ID, uid: 'con spazi', fields: { start: START } } });
      assert.equal(badUid.status, 400);
      const unknown = await api.post(`${BASE}/objects`, { auth: 'admin', body: { calendar_id: ANY_ID, fields: { start: START, colore: 'rosso' } } });
      assert.equal(unknown.status, 400);
      const badJson = await api.post(`${BASE}/objects`, { auth: 'admin', headers: { 'Content-Type': 'application/json' }, body: '{non json' });
      assert.equal(badJson.status, 400);
      const both = await api.get(`${BASE}/objects/${ANY_ID}`, { auth: 'admin', query: { recurrence_key: '', original_start: '2027-04-05T07:00:00Z' } });
      assert.equal(both.status, 400);
      assert.equal(both.json.code, 'VALIDATION_FAILED');
    } finally {
      overrideCalendarStore(null);
    }
  });

  test('un corpo oltre 2 MB è rifiutato', async () => {
    overrideCalendarStore('radicale');
    try {
      const big = JSON.stringify({ calendar_id: ANY_ID, fields: { start: START, description: 'x'.repeat(2 * 1024 * 1024 + 10) } });
      const res = await api.post(`${BASE}/objects`, { auth: 'admin', body: big, headers: { 'Content-Type': 'application/json' } });
      assert.equal(res.status, 413);
    } finally {
      overrideCalendarStore(null);
    }
  });
});
