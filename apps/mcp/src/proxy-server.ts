import { createHash, randomBytes } from 'node:crypto';
import * as z from 'zod';
import {
  Server,
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type ListToolsResult,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';

const API_URL = (process.env.API_URL || 'http://localhost:3001').replace(/\/$/, '');
const SERVER_INFO = { name: 'caldes-gestionale', version: '2.0.0' };

/** Tool shape returned by apps/api GET /api/mcp/tools. */
interface ApiTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Tool['annotations'];
}

type ContentBlock = CallToolResult['content'][number];

export type ProxyOptions = {
  /** Token for stdio mode (HTTP mode reads it per request from authInfo). */
  defaultToken?: string;
  /**
   * Whether an `input_required` result can be delivered to this client.
   * True on 2026-07-28 requests and on stdio (persistent connection, where the
   * SDK legacy shim issues a real elicitation request). False for 2025-era
   * stateless HTTP, where a server→client request has no way back.
   */
  canRoundTrip?: boolean;
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
        'Cerca cliente, lead, progetti, preventivi, fatture, note, task, calendario ed email collegate.',
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
  {
    name: 'invoice_followup',
    title: 'Invoice Follow-up',
    description: 'Trova fatture e pagamenti scaduti o in scadenza e prepara i solleciti.',
    build: () =>
      [
        'Analizza fatture e pagamenti: usa api_catalog (domini invoices, payments, payment-tracker) e api_request in sola lettura.',
        'Elenca fatture scadute e in scadenza nei prossimi 14 giorni, con cliente, importo e giorni di ritardo.',
        'Per ognuna proponi una bozza di sollecito breve e cortese in italiano.',
        "Non inviare nulla: chiedi conferma esplicita all'utente prima di qualsiasi invio.",
      ].join('\n'),
  },
  {
    name: 'content_publish',
    title: 'Content Publish',
    description: 'Prepara o aggiorna contenuti del sito (blog, CMS, portfolio) passo per passo.',
    arguments: [{ name: 'topic', description: 'Argomento o contenuto da preparare', required: true }],
    build: (args) =>
      [
        `Prepara il contenuto: ${String(args.topic || '').trim()}.`,
        'Usa api_catalog (domini blog, cms, media) per trovare gli endpoint, poi leggi un contenuto esistente con api_request GET per conoscerne la struttura.',
        'Crea il contenuto come bozza. Pubblica solo dopo conferma esplicita.',
      ].join('\n'),
  },
  {
    name: 'campaign_review',
    title: 'Campaign Review',
    description: 'Analizza le campagne email marketing e propone ottimizzazioni.',
    build: () =>
      [
        'Analizza le campagne email marketing recenti: usa api_catalog (dominio email-marketing) e api_request in sola lettura.',
        'Riporta per ognuna: invii, aperture, click, disiscrizioni, e confronto con la media.',
        'Proponi 3 ottimizzazioni concrete (oggetto, segmento, orario, contenuto).',
        "Non inviare o programmare campagne senza conferma esplicita dell'utente.",
      ].join('\n'),
  },
];

// ─── requestState (MRTR) ──────────────────────────────────────────────────────

type OtpState = { tool: string; argsHash: string };

function stateKey(): string | Uint8Array {
  const secret = process.env.MCP_REQUEST_STATE_SECRET;
  if (secret && Buffer.byteLength(secret, 'utf8') >= 32) return secret;
  if (secret) console.error('[caldes-mcp] MCP_REQUEST_STATE_SECRET < 32 byte: uso chiave effimera di processo');
  // Single-process gateway: a per-process key is enough (every round of a
  // flow hits the same process). A shared secret is needed only with replicas.
  return new Uint8Array(randomBytes(32));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const otpStateCodec = createRequestStateCodec<OtpState>({
  key: stateKey(),
  ttlSeconds: 120,
  // Bind the state to method + caller token, so a state minted for one token
  // cannot be replayed by another. The bind value is stored only as an HMAC tag.
  bind: (ctx) => `${ctx.mcpReq.method}\0${sha256(ctx.http?.authInfo?.token ?? '')}`,
});

const OTP_SCHEMA = z.object({
  otp: z.string().meta({ title: 'Codice OTP', description: 'Codice di 6 cifre ricevuto su Telegram' }),
});

// ─── API calls ────────────────────────────────────────────────────────────────

function resolveToken(ctx: ServerContext, fallback?: string): string {
  const token = ctx.http?.authInfo?.token || fallback || '';
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

type OtpRequired = {
  code?: string;
  needs_otp: true;
  action_id?: string;
  expires_in_seconds?: number;
  telegram_delivered?: boolean;
  error?: string;
};

type ApiCallResult =
  | { kind: 'ok'; content: ContentBlock[]; isError?: boolean }
  | { kind: 'otp'; otp: OtpRequired };

function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'text' || type === 'image' || type === 'audio' || type === 'resource' || type === 'resource_link';
}

async function executeApiTool(token: string, name: string, args: Record<string, unknown>): Promise<ApiCallResult> {
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
      const body = JSON.parse(text) as Partial<OtpRequired>;
      if (body.needs_otp) return { kind: 'otp', otp: body as OtpRequired };
    } catch {
      /* fall through */
    }
  }

  if (!res.ok) {
    return {
      kind: 'ok',
      content: [{ type: 'text', text: text || JSON.stringify({ code: 'tool_error', error: `HTTP ${res.status}` }) }],
      isError: true,
    };
  }

  try {
    const parsed = JSON.parse(text) as { content?: unknown[]; isError?: boolean };
    const blocks = Array.isArray(parsed.content) ? parsed.content.filter(isContentBlock) : [];
    if (blocks.length > 0) return { kind: 'ok', content: blocks, isError: parsed.isError };
    return { kind: 'ok', content: [{ type: 'text', text }], isError: parsed.isError };
  } catch {
    return { kind: 'ok', content: [{ type: 'text', text }] };
  }
}

function otpFallbackResult(name: string, otp: OtpRequired): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          code: otp.code || 'otp_required',
          needs_otp: true,
          action_id: otp.action_id,
          expires_in_seconds: otp.expires_in_seconds,
          telegram_delivered: otp.telegram_delivered ?? false,
          requested_tool: name,
          instructions:
            otp.telegram_delivered === false
              ? "Telegram non configurato sul server: l'OTP non puo essere consegnato. Avvisa l'utente."
              : `Conferma richiesta. Un OTP e stato inviato via Telegram. Chiedi all'utente il codice (6 cifre), poi chiama il tool 'mcp_unlock' con quel codice. Dopo lo sblocco, ripeti la chiamata a '${name}' con gli stessi argomenti.`,
        }),
      },
    ],
    isError: true,
  };
}

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ code: 'tool_error', error: message }) }],
    isError: true,
  };
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function createProxyServer(options: ProxyOptions = {}) {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, prompts: {} },
    requestState: { verify: otpStateCodec.verify },
    cacheHints: {
      'tools/list': { ttlMs: 60_000, cacheScope: 'private' },
      'prompts/list': { ttlMs: 3_600_000, cacheScope: 'private' },
    },
  });

  const clientCanElicit = () => {
    if (!options.canRoundTrip) return false;
    // Backfilled per request from the envelope on 2026-07-28; from initialize on stdio.
    return Boolean(server.getClientCapabilities()?.elicitation);
  };

  server.setRequestHandler('tools/list', async (_req, ctx): Promise<ListToolsResult> => {
    try {
      const token = resolveToken(ctx, options.defaultToken);
      const tools = await fetchTools(token);
      return {
        tools: tools
          .map(
            (t): Tool => ({
              name: t.name,
              ...(t.title ? { title: t.title } : {}),
              description: t.description,
              inputSchema: {
                ...((t.inputSchema as Record<string, unknown>) ?? {}),
                type: 'object' as const,
              },
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })
          )
          // Deterministic order: stable client-side and prompt caches.
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    } catch (err) {
      console.error('[caldes-mcp] fetchTools error:', err);
      return { tools: [] };
    }
  });

  server.setRequestHandler('tools/call', async (req, ctx): Promise<CallToolResult | InputRequiredResult> => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const token = resolveToken(ctx, options.defaultToken);
      const argsHash = sha256(JSON.stringify(args));

      // Re-entry after an OTP elicitation round: unlock first, then re-run.
      const state = ctx.mcpReq.requestState<OtpState>();
      if (state) {
        if (state.tool !== name || state.argsHash !== argsHash) {
          return toolError('requestState non corrisponde alla chiamata originale');
        }
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'otp', OTP_SCHEMA);
        if (!answer) return toolError('OTP non fornito: operazione annullata');
        const unlock = await executeApiTool(token, 'mcp_unlock', { otp: answer.otp.trim() });
        if (unlock.kind === 'ok' && unlock.isError) return { content: unlock.content, isError: true };
      }

      const result = await executeApiTool(token, name, args);
      if (result.kind === 'ok') return { content: result.content, isError: result.isError };

      // High-risk tool without an active unlock window.
      if (!state && result.otp.telegram_delivered !== false && clientCanElicit()) {
        return inputRequired({
          inputRequests: {
            otp: inputRequired.elicit({
              message: `Conferma "${name}": inserisci il codice OTP inviato su Telegram (valido ${result.otp.expires_in_seconds ?? 60}s).`,
              requestedSchema: OTP_SCHEMA,
            }),
          },
          requestState: await otpStateCodec.mint({ tool: name, argsHash }, ctx),
        });
      }
      return otpFallbackResult(name, result.otp);
    } catch (err) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  });

  server.setRequestHandler('prompts/list', async () => ({
    prompts: PROMPTS.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  }));

  server.setRequestHandler('prompts/get', async (req) => {
    const prompt = PROMPTS.find((p) => p.name === req.params.name);
    if (!prompt) {
      throw new Error(`Prompt "${req.params.name}" non trovato`);
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    return {
      description: prompt.description,
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: prompt.build(args) },
        },
      ],
    };
  });

  return server;
}
