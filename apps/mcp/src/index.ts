#!/usr/bin/env node
/**
 * @caldes/mcp — MCP stdio server per il gestionale.
 *
 * Espone i tool registrati in apps/api/src/lib/agent/tools.ts a un client MCP
 * (Claude Desktop, Claude Code, ecc.) traducendo le chiamate tools/list e
 * tools/call in richieste HTTP autenticate verso apps/api.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_URL = (process.env.API_URL || 'http://localhost:3001').replace(/\/$/, '');
const TOKEN = process.env.MCP_SERVICE_TOKEN || '';

if (!TOKEN) {
  console.error('[caldes-mcp] MCP_SERVICE_TOKEN mancante — configura il token nell\'env del server MCP.');
  process.exit(1);
}

interface ApiTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

async function fetchTools(): Promise<ApiTool[]> {
  const res = await fetch(`${API_URL}/api/mcp/tools`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`GET /api/mcp/tools → ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { tools: ApiTool[] };
  return data.tools || [];
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${API_URL}/api/mcp/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ name, args }),
  });
  const text = await res.text();

  // 401 + needs_otp: il server chiede step-up via Telegram.
  // Trasforma in tool result strutturato che istruisce Claude a chiamare mcp_unlock.
  if (res.status === 401) {
    try {
      const body = JSON.parse(text) as {
        needs_otp?: boolean;
        action_id?: string;
        expires_in_seconds?: number;
        telegram_delivered?: boolean;
        message?: string;
      };
      if (body.needs_otp) {
        return JSON.stringify({
          needs_otp: true,
          action_id: body.action_id,
          expires_in_seconds: body.expires_in_seconds,
          telegram_delivered: body.telegram_delivered ?? false,
          requested_tool: name,
          instructions:
            body.telegram_delivered === false
              ? "Telegram non configurato sul server: l'OTP non può essere consegnato. Avvisa l'utente."
              : `Conferma richiesta. Un OTP è stato inviato via Telegram. Chiedi all'utente il codice (6 cifre), poi chiama il tool 'mcp_unlock' con quel codice. Dopo lo sblocco, RIPETI questa stessa chiamata a '${name}' con gli stessi argomenti — i tool ad alto rischio resteranno sbloccati per 5 minuti.`,
        });
      }
    } catch {
      /* fallthrough a errore generico */
    }
  }

  if (!res.ok) {
    throw new Error(`POST /api/mcp/execute (${name}) → ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    const parsed = JSON.parse(text) as { content?: Array<{ type: string; text?: string }> };
    const first = parsed.content?.[0];
    if (first && first.type === 'text' && typeof first.text === 'string') return first.text;
    return text;
  } catch {
    return text;
  }
}

const server = new Server(
  { name: 'caldes-gestionale', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const tools = await fetchTools();
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as { type?: string; properties?: unknown }) ?? {
          type: 'object',
          properties: {},
        },
      })),
    };
  } catch (err) {
    console.error('[caldes-mcp] fetchTools error:', err);
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const text = await callTool(name, (args ?? {}) as Record<string, unknown>);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[caldes-mcp] server avviato, API_URL=${API_URL}`);
