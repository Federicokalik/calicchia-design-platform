/**
 * Gateway API generico dell'MCP (tool api_catalog / api_request):
 *  - policy pura (lib/mcp/api-policy.ts): path ammessi, denylist, rischio, scope;
 *  - catalogo da app.routes senza endpoint della denylist;
 *  - esecuzione in-process via /api/mcp/execute con i tre scope, OTP per il
 *    rischio alto e una scrittura reale (lead) fatta con l'identità admin.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { onDatabaseReady, sql, useTestDatabase } from './helpers/db';
import { useFixtures } from './helpers/fixtures';
import { api, ensureTestAdmin } from './helpers/http';
import { buildCatalog, getAdminPrefixes } from '../src/lib/mcp/api-gateway';
import { checkPath, classifyRisk, isDeniedPath, scopeAllows } from '../src/lib/mcp/api-policy';

useTestDatabase();
const fx = useFixtures('mcp-api-gateway');

onDatabaseReady(() => ensureTestAdmin());

const PREFIXES = ['/api/customers', '/api/leads', '/api/quotes-v2', '/api/mcp-tokens', '/api/email-marketing'];

describe('api-policy', () => {
  test('checkPath: denylist, traversal, query nel path, fuori admin', () => {
    assert.deepEqual(checkPath('/api/customers/abc', PREFIXES), { ok: true, pathname: '/api/customers/abc' });
    assert.equal(checkPath('/api/customers/', PREFIXES).ok, true);
    for (const denied of ['/api/mcp-tokens', '/api/mcp/execute', '/api/auth/login', '/api/backup/export', '/api/keys', '/api/caldav-tokens/x', '/api/device/pair']) {
      const r = checkPath(denied, [...PREFIXES, '/api/auth', '/api/backup', '/api/keys', '/api/caldav-tokens', '/api/device']);
      assert.equal(r.ok, false, denied);
      assert.equal(!r.ok && r.code, 'path_denied', denied);
    }
    for (const bad of ['customers', '/api/customers/../mcp-tokens', '/api/customers/%2e%2e/mcp-tokens', '/api/customers?x=1', '/api//customers']) {
      const r = checkPath(bad, PREFIXES);
      assert.equal(r.ok, false, bad);
    }
    const outside = checkPath('/api/public-leads', PREFIXES);
    assert.equal(!outside.ok && outside.code, 'not_admin_route');
    assert.equal(isDeniedPath('/api/mcp-tokens/123'), true);
    assert.equal(isDeniedPath('/api/customers'), false);
  });

  test('classifyRisk: GET low, scritture medium, DELETE ed esterne high', () => {
    assert.equal(classifyRisk('GET', '/api/quotes-v2/1/send'), 'low');
    assert.equal(classifyRisk('POST', '/api/leads'), 'medium');
    assert.equal(classifyRisk('PUT', '/api/customers/1'), 'medium');
    assert.equal(classifyRisk('DELETE', '/api/leads/1'), 'high');
    for (const path of [
      '/api/quotes-v2/1/send',
      '/api/quotes-v2/1/schedule-send',
      '/api/signables/1/send',
      '/api/customers/1/send-portal-access',
      '/api/mail/send',
      '/api/email-marketing/campaigns/1/send',
      '/api/email-marketing/campaigns/1/test',
      '/api/whatsapp-admin/conversations/1/messages',
      '/api/whatsapp-admin/send-to-phone',
      '/api/projects/1/publish',
      '/api/blog/scheduled/publish',
      '/api/payments/schedules',
      '/api/customers/1/payment-link',
      '/api/services/1/sync-stripe',
      '/api/email-marketing/import/commit',
      '/api/settings/site',
      '/api/workflows/1/execute',
    ]) {
      assert.equal(classifyRisk('POST', path), 'high', path);
    }
    assert.equal(classifyRisk('POST', '/api/email-marketing/import/preview'), 'medium');
    assert.equal(classifyRisk('PATCH', '/api/email-marketing/campaigns/1'), 'medium');
  });

  test('scopeAllows', () => {
    assert.deepEqual(
      (['read', 'write', 'admin'] as const).map((s) => [scopeAllows(s, 'low'), scopeAllows(s, 'medium'), scopeAllows(s, 'high')]),
      [
        [true, false, false],
        [true, true, false],
        [true, true, true],
      ]
    );
  });
});

describe('catalogo', () => {
  test('copre le route admin ed esclude la denylist', () => {
    const catalog = buildCatalog();
    const domains = catalog.map((d) => d.domain);
    for (const expected of ['customers', 'invoices', 'quotes-v2', 'blog', 'cms', 'email-marketing', 'mail', 'whatsapp-admin', 'admin/calendar', 'contacts']) {
      assert.ok(domains.includes(expected), `dominio ${expected} mancante`);
    }
    for (const domain of catalog) {
      for (const e of domain.endpoints) {
        assert.equal(isDeniedPath(e.path), false, `${e.method} ${e.path} non deve stare nel catalogo`);
        assert.ok(getAdminPrefixes().some((p) => e.path === p || e.path.startsWith(`${p}/`)), e.path);
      }
    }
  });
});

describe('/api/mcp/execute', () => {
  const exec = (token: string, name: string, args: Record<string, unknown>) =>
    api.post('/api/mcp/execute', { auth: { bearer: token }, body: { name, args } });

  test('i tool del gateway sono elencati per ogni scope, con title e annotations', async () => {
    for (const scope of ['read', 'write', 'admin'] as const) {
      const { token } = await fx.mcpToken({ scope });
      const res = await api.get('/api/mcp/tools', { auth: { bearer: token } });
      assert.equal(res.status, 200);
      const names = res.json.tools.map((t: { name: string }) => t.name);
      assert.ok(names.includes('api_catalog') && names.includes('api_request'), scope);
      for (const t of res.json.tools) {
        assert.equal(typeof t.title, 'string', `${t.name} senza title`);
        assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name} senza annotations`);
      }
    }
  });

  test('api_catalog: indice e dominio', async () => {
    const { token } = await fx.mcpToken({ scope: 'read' });
    const index = await exec(token, 'api_catalog', {});
    assert.equal(index.status, 200);
    const indexBody = JSON.parse(index.json.content[0].text);
    assert.ok(indexBody.domains.some((d: { domain: string }) => d.domain === 'leads'));

    const leads = await exec(token, 'api_catalog', { domain: 'leads' });
    const leadsBody = JSON.parse(leads.json.content[0].text);
    assert.ok(leadsBody.domains[0].endpoints.some((e: { method: string; path: string }) => e.method === 'POST' && e.path === '/api/leads'));
  });

  test('api_request: scope, denylist, OTP e scrittura reale', async () => {
    const read = (await fx.mcpToken({ scope: 'read' })).token;
    const write = (await fx.mcpToken({ scope: 'write' })).token;
    const admin = (await fx.mcpToken({ scope: 'admin' })).token;

    const list = await exec(read, 'api_request', { method: 'GET', path: '/api/leads', query: { limit: 5 } });
    assert.equal(list.status, 200);
    assert.equal('isError' in list.json, false);
    assert.match(list.json.content[0].text, /^HTTP 200 GET \/api\/leads\n/);

    const readWrite = await exec(read, 'api_request', { method: 'POST', path: '/api/leads', body: { name: fx.name('mai') } });
    assert.equal(readWrite.status, 403);
    assert.equal(readWrite.json.code, 'scope_denied');

    const created = await exec(write, 'api_request', { method: 'POST', path: '/api/leads', body: { name: fx.name('Lead MCP') } });
    assert.equal(created.status, 200);
    const [, json] = created.json.content[0].text.split('\n');
    const lead = JSON.parse(json).lead;
    fx.track('leadIds', lead.id);
    assert.equal(lead.name, fx.name('Lead MCP'));
    const [row] = await sql<Array<{ id: string }>>`SELECT id FROM leads WHERE id = ${lead.id}`;
    assert.ok(row);

    const validation = await exec(write, 'api_request', { method: 'POST', path: '/api/leads', body: {} });
    assert.equal(validation.status, 200);
    assert.equal(validation.json.isError, true);
    assert.match(validation.json.content[0].text, /^HTTP 400/);

    const writeDelete = await exec(write, 'api_request', { method: 'DELETE', path: `/api/leads/${lead.id}` });
    assert.equal(writeDelete.status, 403);

    // Telegram non configurato nei test: OTP richiesto ma non consegnabile.
    const adminDelete = await exec(admin, 'api_request', { method: 'DELETE', path: `/api/leads/${lead.id}` });
    assert.equal(adminDelete.status, 401);
    assert.equal(adminDelete.json.needs_otp, true);
    const [still] = await sql<Array<{ id: string }>>`SELECT id FROM leads WHERE id = ${lead.id}`;
    assert.ok(still, 'il lead non deve essere cancellato senza OTP');

    const denied = await exec(admin, 'api_request', { method: 'GET', path: '/api/mcp-tokens' });
    assert.equal(denied.json.isError, true);
    assert.equal(JSON.parse(denied.json.content[0].text).code, 'path_denied');

    const outside = await exec(admin, 'api_request', { method: 'POST', path: '/api/public-leads', body: {} });
    assert.equal(JSON.parse(outside.json.content[0].text).code, 'not_admin_route');

    const getBody = await exec(read, 'api_request', { method: 'GET', path: '/api/leads', body: { x: 1 } });
    assert.equal(JSON.parse(getBody.json.content[0].text).code, 'invalid_request');
  });
});
