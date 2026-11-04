/**
 * Smoke del gateway MCP contro un'istanza in esecuzione (dev o prod).
 *
 * Verifica, con il client ufficiale v2:
 *  - era 2026-07-28 (versionNegotiation 'auto' → 'modern') ed era 2025 (default → 'legacy');
 *  - tools/list con i tool del gateway (api_catalog, api_request) e annotations;
 *  - api_catalog e api_request GET con token read;
 *  - con token admin (opzionale): una DELETE su un id inesistente richiede OTP.
 *    Sul 2026-07-28 con elicitation arriva un input_required (il client risponde
 *    con un OTP errato e il gateway deve rifiutarlo); sul 2025 il fallback needs_otp.
 *
 * Uso:
 *   MCP_SMOKE_TOKEN=mcp_... [MCP_SMOKE_ADMIN_TOKEN=mcp_...] [MCP_SMOKE_URL=http://localhost:3002/mcp] \
 *     pnpm --filter @calicchia/mcp smoke
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const URL_ = new URL(process.env.MCP_SMOKE_URL || 'http://localhost:3002/mcp');
const TOKEN = process.env.MCP_SMOKE_TOKEN || '';
const ADMIN_TOKEN = process.env.MCP_SMOKE_ADMIN_TOKEN || '';

if (!TOKEN) {
  console.error('MCP_SMOKE_TOKEN richiesto (token mcp_ con scope read o superiore)');
  process.exit(2);
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.log(`  ✖ ${label}`, detail ?? '');
  }
}

function firstText(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

async function connect(token: string, mode: 'auto' | 'legacy', onElicit?: () => unknown) {
  const client = new Client(
    { name: 'caldes-mcp-smoke', version: '1.0.0' },
    {
      capabilities: onElicit ? { elicitation: { form: {} } } : {},
      ...(mode === 'auto' ? { versionNegotiation: { mode: 'auto' as const } } : {}),
    }
  );
  if (onElicit) client.setRequestHandler('elicitation/create', async () => onElicit() as never);
  const transport = new StreamableHTTPClientTransport(URL_, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function readChecks(mode: 'auto' | 'legacy') {
  console.log(`\n[${mode}] token read`);
  const client = await connect(TOKEN, mode);
  check(`era ${mode === 'auto' ? 'modern' : 'legacy'}`, client.getProtocolEra() === (mode === 'auto' ? 'modern' : 'legacy'), client.getProtocolEra());

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check('tools/list contiene api_catalog e api_request', names.includes('api_catalog') && names.includes('api_request'), names);
  check('tools/list ordinato per nome', names.join() === [...names].sort((a, b) => a.localeCompare(b)).join());
  check('annotations presenti', tools.every((t) => typeof t.annotations?.readOnlyHint === 'boolean'));

  const catalog = await client.callTool({ name: 'api_catalog', arguments: {} });
  check('api_catalog indice', !catalog.isError && firstText(catalog).includes('"domains"'), firstText(catalog).slice(0, 200));

  const leads = await client.callTool({ name: 'api_request', arguments: { method: 'GET', path: '/api/leads' } });
  check('api_request GET /api/leads', !leads.isError && firstText(leads).startsWith('HTTP 200'), firstText(leads).slice(0, 200));

  const prompts = await client.listPrompts();
  check('prompts/list', prompts.prompts.some((p) => p.name === 'daily_brief'));
  await client.close();
}

async function adminChecks() {
  const path = '/api/leads/00000000-0000-4000-8000-000000000000';

  console.log('\n[auto] token admin — OTP via input_required');
  let elicited = 0;
  const modern = await connect(ADMIN_TOKEN, 'auto', () => {
    elicited++;
    return { action: 'accept', content: { otp: '000000' } };
  });
  const modernRes = await modern.callTool({ name: 'api_request', arguments: { method: 'DELETE', path } });
  const modernText = firstText(modernRes);
  if (modernText.includes('telegram_delivered":false')) {
    console.log('  – Telegram non configurato sul server: OTP non consegnabile, input_required non usato');
  } else {
    check('elicitation OTP richiesta una volta', elicited === 1, elicited);
    check('OTP errato rifiutato', Boolean(modernRes.isError) && modernText.includes('invalid_otp'), modernText.slice(0, 200));
  }
  await modern.close();

  console.log('\n[legacy] token admin — fallback needs_otp');
  const legacy = await connect(ADMIN_TOKEN, 'legacy');
  const legacyRes = await legacy.callTool({ name: 'api_request', arguments: { method: 'DELETE', path } });
  check('needs_otp nel risultato', Boolean(legacyRes.isError) && firstText(legacyRes).includes('needs_otp'), firstText(legacyRes).slice(0, 200));
  await legacy.close();
}

await readChecks('auto');
await readChecks('legacy');
if (ADMIN_TOKEN) await adminChecks();
else console.log('\n(MCP_SMOKE_ADMIN_TOKEN assente: controlli OTP saltati)');

console.log(failures ? `\n${failures} controlli falliti` : '\nOK');
process.exit(failures ? 1 : 0);
