/**
 * Bug 5 — tool MCP get_domains_expiring in errore.
 *
 * Riproduzione: la query leggeva `expiry_date`, colonna che non esiste (è
 * `expiration_date`): il tool falliva SEMPRE, anche con la tabella vuota, ed
 * executeTool sostituiva l'eccezione con un generico "Errore esecuzione tool".
 * Atteso: risultato valido (anche con zero domini) e, quando un tool fallisce,
 * il messaggio reale nel payload.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sql, useTestDatabase } from '../helpers/db';
import { useFixtures } from '../helpers/fixtures';
import { useCrmFixtures } from '../helpers/crm';
import { api } from '../helpers/http';
import { executeTool, tools, type ToolDefinition } from '../../src/lib/agent/tools';

useTestDatabase();
const fx = useFixtures('crm-domains-expiring');
const crm = useCrmFixtures('crm-expiring-data');

function isoDate(daysFromToday: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

describe('get_domains_expiring', () => {
  test('nessun errore e conteggio coerente anche senza domini nella finestra', async () => {
    const result = JSON.parse(await executeTool('get_domains_expiring', { days: 1 }));
    assert.equal(result.error, undefined, `il tool non deve fallire: ${result.error}`);
    assert.ok(Array.isArray(result.domains));
    assert.equal(result.count, result.domains.length);
  });

  test('restituisce i domini in scadenza entro N giorni con i dati utili al rinnovo', async () => {
    const customer = await crm.customer({ billing_emails: [crm.email('amm'), crm.email('gmail')] });
    const soon = await crm.domain(customer.id, { expiration_date: isoDate(20), renewal_cost: 15 });
    const later = await crm.domain(customer.id, { expiration_date: isoDate(200) });

    const result = JSON.parse(await executeTool('get_domains_expiring', { days: 90 }));
    assert.equal(result.error, undefined, String(result.error));
    const ids = result.domains.map((d: { id: string }) => d.id);
    assert.ok(ids.includes(soon.id), 'il dominio che scade fra 20 giorni deve esserci');
    assert.ok(!ids.includes(later.id), 'il dominio che scade fra 200 giorni no');
    const row = result.domains.find((d: { id: string }) => d.id === soon.id);
    assert.equal(row.full_domain, `${soon.domain_name}.it`);
    assert.equal(row.days_until_expiration, 20);
    assert.equal(row.customer.id, customer.id);
    assert.deepEqual(row.customer.billing_emails, [crm.email('amm'), crm.email('gmail')]);
  });

  test('days non valido → errore di validazione esplicito', async () => {
    const result = JSON.parse(await executeTool('get_domains_expiring', { days: -5 }));
    assert.match(String(result.error), /days/);
  });

  test('via /api/mcp/execute: nessun tool_error con la tabella dei domini nella finestra vuota', async () => {
    const { token } = await fx.mcpToken({ scope: 'read' });
    const res = await api.post('/api/mcp/execute', { auth: { bearer: token }, body: { name: 'get_domains_expiring', args: { days: 90 } } });
    assert.equal(res.status, 200);
    assert.equal(res.json.isError, undefined, res.json.content?.[0]?.text);
    const payload = JSON.parse(res.json.content[0].text);
    assert.ok(Array.isArray(payload.domains));
  });
});

describe('errori dei tool', () => {
  test("executeTool riporta il messaggio reale dell'eccezione, non un testo generico", async () => {
    const probe: ToolDefinition = {
      name: 'get_probe_failure_for_tests',
      description: 'solo test',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        await sql`SELECT colonna_che_non_esiste FROM domains LIMIT 1`;
        return '{}';
      },
    };
    tools.push(probe);
    try {
      const result = JSON.parse(await executeTool(probe.name, {}));
      assert.match(String(result.error), /colonna_che_non_esiste/);
      assert.equal(result.code, '42703');

      const { token } = await fx.mcpToken({ scope: 'read' });
      const res = await api.post('/api/mcp/execute', { auth: { bearer: token }, body: { name: probe.name, args: {} } });
      assert.equal(res.json.isError, true);
      const payload = JSON.parse(res.json.content[0].text);
      assert.equal(payload.code, 'tool_error');
      assert.match(payload.error, /colonna_che_non_esiste/);
      assert.equal(payload.db_code, '42703');
    } finally {
      tools.splice(tools.indexOf(probe), 1);
    }
  });
});
