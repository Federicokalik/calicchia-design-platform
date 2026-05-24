import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';

const API_URL = (process.env.API_URL || 'http://localhost:3001').replace(/\/$/, '');

interface ApiTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ProxyOptions = {
  defaultToken?: string;
};

type PromptDefinition = {
  name: string;
  title: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
  build: (args: Record<string, unknown>) => string;
};

const PROMPTS: PromptDefinition[] = [
  {
    name: 'daily_brief',
    title: 'Daily Brief',
    description: 'Prepara un riepilogo operativo giornaliero usando calendario, pipeline, email e task.',
    build: () =>
      [
        'Prepara un daily brief operativo per oggi.',
        'Usa i tool disponibili per controllare calendario, lead, progetti, preventivi, task, email recenti e analytics se pertinenti.',
        'Rispondi in italiano con: priorita del giorno, appuntamenti, follow-up, rischi, e prossime azioni concrete.',
        "Non inviare email, WhatsApp o modificare dati senza una richiesta esplicita dell'utente.",
      ].join('\n'),
  },
  {
    name: 'client_context',
    title: 'Client Context',
    description: 'Ricostruisce il contesto di un cliente o lead prima di proporre o compiere azioni.',
    arguments: [{ name: 'query', description: 'Nome, azienda o email del cliente/lead', required: true }],
    build: (args) =>
      [
        `Ricostruisci il contesto operativo per: ${String(args.query || '').trim()}.`,
        'Cerca cliente, lead, progetti, preventivi, note, task, calendario ed email collegate.',
        'Evidenzia stato attuale, storico rilevante, cose aperte, rischi e prossima azione consigliata.',
        'Se devi modificare qualcosa, proponi prima il piano e usa tool write solo dopo richiesta esplicita.',
      ].join('\n'),
  },
  {
    name: 'pipeline_review',
    title: 'Pipeline Review',
    description: 'Analizza pipeline commerciale e delivery per trovare blocchi e prossime azioni.',
    build: () =>
      [
        'Esegui una review della pipeline commerciale e delivery.',
        'Controlla lead, preventivi, progetti attivi, task bloccati/scaduti e pagamenti se disponibili.',
        'Ordina le azioni per impatto e urgenza.',
        'Rispondi in italiano con sezioni brevi: opportunita, blocchi, follow-up, azioni consigliate.',
      ].join('\n'),
  },
];

function tokenFromExtra(extra: RequestHandlerExtra<any, any>, fallback?: string): string {
  const token = extra.authInfo?.token || fallback || '';
  if (!token) throw new Error('missing_token: token MCP assente');
  if (!token.startsWith('mcp_')) throw new Error('invalid_token: token MCP non valido');
  return token;
}

async function fetchTools(token: string): Promise<ApiTool[]> {
  const res = await fetch(`${API_URL}/api/mcp/tools`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /api/mcp/tools -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { tools: ApiTool[] };
  return data.tools || [];
}

async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<{
  text: string;
  isError?: boolean;
}> {
  const res = await fetch(`${API_URL}/api/mcp/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name, args }),
  });
  const text = await res.text();

  if (res.status === 401) {
    try {
      const body = JSON.parse(text) as {
        code?: string;
        needs_otp?: boolean;
        action_id?: string;
        expires_in_seconds?: number;
        telegram_delivered?: boolean;
        error?: string;
      };
      if (body.needs_otp) {
        return {
          text: JSON.stringify({
            code: body.code || 'otp_required',
            needs_otp: true,
            action_id: body.action_id,
            expires_in_seconds: body.expires_in_seconds,
            telegram_delivered: body.telegram_delivered ?? false,
            requested_tool: name,
            instructions:
              body.telegram_delivered === false
                ? "Telegram non configurato sul server: l'OTP non puo essere consegnato. Avvisa l'utente."
                : `Conferma richiesta. Un OTP e stato inviato via Telegram. Chiedi all'utente il codice (6 cifre), poi chiama il tool 'mcp_unlock' con quel codice. Dopo lo sblocco, ripeti la chiamata a '${name}' con gli stessi argomenti.`,
          }),
          isError: true,
        };
      }
    } catch {
      /* fall through */
    }
  }

  if (!res.ok) {
    return {
      text: text || JSON.stringify({ code: 'tool_error', error: `HTTP ${res.status}` }),
      isError: true,
    };
  }

  try {
    const parsed = JSON.parse(text) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const first = parsed.content?.[0];
    if (first && first.type === 'text' && typeof first.text === 'string') {
      return { text: first.text, isError: parsed.isError };
    }
    return { text, isError: parsed.isError };
  } catch {
    return { text };
  }
}

export function createProxyServer(options: ProxyOptions = {}) {
  const server = new Server(
    { name: 'caldes-gestionale', version: '1.1.0' },
    { capabilities: { tools: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
    try {
      const token = tokenFromExtra(extra, options.defaultToken);
      const tools = await fetchTools(token);
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

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    try {
      const token = tokenFromExtra(extra, options.defaultToken);
      const result = await callTool(token, name, (args ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ code: 'tool_error', error: message }) }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = PROMPTS.find((p) => p.name === req.params.name);
    if (!prompt) {
      throw new Error(`Prompt "${req.params.name}" non trovato`);
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    return {
      description: prompt.description,
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: prompt.build(args) },
        },
      ],
    };
  });

  return server;
}
