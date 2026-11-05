import { Context, Hono } from 'hono';
import { sql } from '../db';
import { tools, executeTool, checkRateLimit, type ToolDefinition } from '../lib/agent/tools';
import { generateOtp, hashOtp } from '../lib/mcp/tokens';
import { writeMcpAudit, summarizeArgs } from '../lib/mcp/audit';
import { dispatch, getAdminPrefixes, queryCatalog, type GatewayResponse } from '../lib/mcp/api-gateway';
import { HTTP_METHODS, checkPath, classifyRisk, scopeAllows, type HttpMethod } from '../lib/mcp/api-policy';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram';
import type { McpTokenContext } from '../middleware/mcp-auth';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'mcp' });

type McpEnv = {
  Variables: {
    mcpToken: McpTokenContext;
    mcpClientIp: string;
  };
};

export const mcp = new Hono<McpEnv>();

const READ_PREFIXES = ['get_', 'list_', 'search_', 'read_', 'find_', 'summarize_'];
const READ_EXACT = new Set(['emails_for_entity']);
const HIGH_UNLOCK_MINUTES = 5;
const OTP_TTL_SECONDS = 60;
/** Per token: lascia margine a sequenze catalogo → GET → scrittura. */
const MCP_CALLS_PER_MINUTE = 60;

type Risk = 'low' | 'medium' | 'high';
type Scope = McpTokenContext['scope'];

interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

function isReadTool(name: string): boolean {
  if (READ_EXACT.has(name)) return true;
  return READ_PREFIXES.some((p) => name.startsWith(p));
}

function getRisk(tool: ToolDefinition): Risk {
  return tool.riskLevel ?? 'low';
}

function checkScope(scope: Scope, risk: Risk, isRead: boolean): boolean {
  if (scope === 'admin') return true;
  if (scope === 'write') return risk !== 'high';
  if (scope === 'read') return isRead;
  return false;
}

function canUseTool(scope: Scope, tool: ToolDefinition): boolean {
  return checkScope(scope, getRisk(tool), isReadTool(tool.name));
}

/** Hint di comportamento per i client MCP, derivati da nome e rischio del tool. */
function deriveAnnotations(tool: ToolDefinition): ToolAnnotations {
  const readOnly = isReadTool(tool.name);
  const outward = /^(send_|generate_email|draft_email)|whatsapp|email/.test(tool.name) && !readOnly;
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && (getRisk(tool) === 'high' || /^(delete_|cancel_)/.test(tool.name)),
    idempotentHint: readOnly || /^update_/.test(tool.name),
    openWorldHint: outward || /^get_(traffic|top_pages|realtime|web_vitals|goal)/.test(tool.name),
  };
}

function humanTitle(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function errorPayload(code: string, error: string, details?: Record<string, unknown>) {
  return { code, error, ...(details ?? {}) };
}

/**
 * Campi diagnostici di un errore di tool da inoltrare al client MCP oltre al
 * messaggio: lo SQLSTATE (`db_code`) o il codice del tool (`tool_code`, es.
 * invalid_arguments) e i dettagli per campo. Il `code` del payload resta
 * 'tool_error' per compatibilità con i client esistenti.
 */
function toolErrorExtras(tool: string, parsed: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = { tool };
  if (typeof parsed.code === 'string') {
    if (/^[0-9A-Z]{5}$/.test(parsed.code)) extras.db_code = parsed.code;
    else extras.tool_code = parsed.code;
  }
  if (Array.isArray(parsed.details) && parsed.details.length) extras.details = parsed.details;
  return extras;
}

// ─── Tool MCP-only (non nel registry dell'agente) ─────────────────────────────

const MCP_UNLOCK_TOOL_DEF = {
  name: 'mcp_unlock',
  title: 'Sblocca operazioni ad alto rischio',
  description:
    "Sblocca i tool e le richieste ad alto rischio (invii email/WhatsApp, cancellazioni, pagamenti, pubblicazioni) inserendo l'OTP ricevuto via Telegram. Usa SOLO quando un tool restituisce needs_otp=true. Lo sblocco dura 5 minuti — dopo lo sblocco devi RIPETERE la chiamata al tool originale con gli stessi argomenti.",
  inputSchema: {
    type: 'object',
    properties: { otp: { type: 'string', description: 'Codice 6 cifre ricevuto via Telegram' } },
    required: ['otp'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

const API_CATALOG_TOOL_DEF = {
  name: 'api_catalog',
  title: 'Catalogo API del gestionale',
  description:
    "Elenca gli endpoint dell'API admin del gestionale: tutto ciò che si può fare dalla UI admin (clienti, lead, preventivi, fatture, spese, pagamenti, progetti, blog, CMS, media, email marketing, posta, WhatsApp, calendario, portale, impostazioni...). Senza argomenti restituisce l'indice dei domini; con \"domain\" gli endpoint di quel dominio (metodo, path, rischio); con \"search\" cerca nei path. Usalo prima di api_request per trovare l'endpoint giusto.",
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Dominio, es. "invoices", "quotes-v2", "email-marketing", "admin/calendar"' },
      search: { type: 'string', description: 'Testo da cercare nei path, es. "send", "translations"' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const API_REQUEST_TOOL_DEF = {
  name: 'api_request',
  title: 'Richiesta API del gestionale',
  description:
    "Esegue un endpoint dell'API admin del gestionale con gli stessi permessi della UI admin (trovalo con api_catalog). " +
    'Prima di modificare una risorsa fai GET per conoscerne la struttura e riusa gli stessi campi nel body. ' +
    'Path con parametri reali (es. /api/invoices/123), parametri di query in "query", JSON in "body". ' +
    'Upload file (es. /api/media): usa "multipart" con file in base64. ' +
    'Scope read: solo GET. Scope write: GET/POST/PUT/PATCH. Cancellazioni e azioni verso l\'esterno (invii, pubblicazioni, pagamenti, import, impostazioni) richiedono scope admin e OTP (needs_otp → mcp_unlock). ' +
    'Non accessibili: token MCP, autenticazione, backup, chiavi API.',
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: [...HTTP_METHODS], description: 'Metodo HTTP' },
      path: { type: 'string', description: 'Path assoluto, es. /api/customers o /api/quotes-v2/<id>/send' },
      query: {
        type: 'object',
        description: 'Parametri di query (valori stringa, numero, booleano o array)',
        additionalProperties: true,
      },
      body: { description: 'Body JSON per POST/PUT/PATCH/DELETE' },
      multipart: {
        type: 'object',
        description: 'Body multipart/form-data al posto di "body" (upload)',
        properties: {
          fields: { type: 'object', additionalProperties: true, description: 'Campi testuali' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string', description: 'Nome del campo, es. "file"' },
                filename: { type: 'string' },
                contentType: { type: 'string', description: 'MIME type, es. image/webp' },
                base64: { type: 'string', description: 'Contenuto del file in base64' },
              },
              required: ['field', 'filename', 'base64'],
            },
          },
        },
      },
    },
    required: ['method', 'path'],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

mcp.get('/tools', (c) => {
  const tokenCtx = c.get('mcpToken');
  if (!tokenCtx) {
    return c.json(errorPayload('invalid_token', 'Token context mancante'), 500);
  }

  const apiTools = tools.filter((t) => canUseTool(tokenCtx.scope, t)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
    title: t.title ?? humanTitle(t.name),
    annotations: deriveAnnotations(t),
  }));
  const gatewayTools = [API_CATALOG_TOOL_DEF, API_REQUEST_TOOL_DEF];
  return c.json({
    tools: [...apiTools, ...gatewayTools, ...(tokenCtx.scope === 'admin' ? [MCP_UNLOCK_TOOL_DEF] : [])],
    scope: tokenCtx.scope,
  });
});

mcp.post('/execute', async (c) => {
  const startedAt = Date.now();

  let body: { name?: string; args?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errorPayload('invalid_request', 'Body JSON richiesto'), 400);
  }

  const name = body.name;
  const args = body.args ?? {};
  if (!name || typeof name !== 'string') {
    return c.json(errorPayload('invalid_request', 'Campo "name" richiesto'), 400);
  }

  const tokenCtx = c.get('mcpToken');
  if (!tokenCtx) {
    return c.json(errorPayload('invalid_token', 'Token context mancante'), 500);
  }

  if (!checkRateLimit(`mcp:${tokenCtx.id}`, MCP_CALLS_PER_MINUTE)) {
    return c.json(errorPayload('rate_limited', `Rate limit raggiunto (${MCP_CALLS_PER_MINUTE} chiamate/minuto)`), 429);
  }

  const ip = c.get('mcpClientIp') ?? 'unknown';
  const userAgent = c.req.header('user-agent') ?? 'unknown';
  const audit = (entry: { tool: string; argsSummary: string; risk: Risk; otpRequired?: boolean; success: boolean; error?: string }) =>
    writeMcpAudit({
      tokenId: tokenCtx.id,
      tokenLabel: tokenCtx.label,
      ip,
      userAgent,
      otpRequired: false,
      durationMs: Date.now() - startedAt,
      ...entry,
    });

  if (name === 'mcp_unlock') {
    return handleUnlock(c, tokenCtx, args, ip, userAgent, startedAt);
  }

  if (name === 'api_catalog') {
    try {
      const result = queryCatalog({
        domain: typeof args.domain === 'string' ? args.domain : undefined,
        search: typeof args.search === 'string' ? args.search : undefined,
      });
      return c.json({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (err) {
      log.error({ err }, 'api_catalog failed');
      return c.json({
        content: [{ type: 'text', text: JSON.stringify(errorPayload('tool_error', 'Catalogo API non disponibile', { tool: name })) }],
        isError: true,
      });
    }
  }

  if (name === 'api_request') {
    return handleApiRequest(c, tokenCtx, args, audit);
  }

  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return c.json(errorPayload('tool_not_found', `Tool "${name}" non trovato`, { tool: name }), 404);
  }

  const risk = getRisk(tool);
  const isRead = isReadTool(name);
  const argsSummary = summarizeArgs(args);

  if (!checkScope(tokenCtx.scope, risk, isRead)) {
    await audit({ tool: name, argsSummary, risk, success: false, error: `scope_denied:${tokenCtx.scope}` });
    return c.json(
      errorPayload('scope_denied', `Scope '${tokenCtx.scope}' non permette tool '${name}'`, {
        scope: tokenCtx.scope,
        tool: name,
        risk,
      }),
      403
    );
  }

  if (risk === 'high') {
    const otpResponse = await requireHighRiskUnlock(c, tokenCtx, name, argsSummary, audit);
    if (otpResponse) return otpResponse;
  }

  const result = await executeTool(name, args);
  let parsed: unknown = result;
  try {
    parsed = JSON.parse(result);
  } catch {
    /* mantiene grezzo */
  }
  const toolError = typeof parsed === 'object' && parsed !== null && 'error' in parsed;

  await audit({ tool: name, argsSummary, risk, success: !toolError, error: toolError ? 'tool_error' : undefined });

  return c.json({
    content: [
      {
        type: 'text',
        text: toolError
          ? JSON.stringify(errorPayload('tool_error', String((parsed as { error: unknown }).error), toolErrorExtras(name, parsed as Record<string, unknown>)))
          : typeof parsed === 'string'
            ? parsed
            : JSON.stringify(parsed),
      },
    ],
    isError: toolError || undefined,
  });
});

type AuditFn = (entry: {
  tool: string;
  argsSummary: string;
  risk: Risk;
  otpRequired?: boolean;
  success: boolean;
  error?: string;
}) => Promise<void>;

/**
 * Step-up OTP per il rischio alto. Ritorna null se la finestra di sblocco del
 * token è attiva, altrimenti genera e consegna l'OTP e ritorna la risposta 401
 * `needs_otp` da inoltrare al client.
 */
async function requireHighRiskUnlock(
  c: Context,
  tokenCtx: McpTokenContext,
  action: string,
  argsSummary: string,
  audit: AuditFn
): Promise<Response | null> {
  const unlockedUntilTs = tokenCtx.high_risk_unlocked_until
    ? new Date(tokenCtx.high_risk_unlocked_until).getTime()
    : 0;
  if (unlockedUntilTs >= Date.now()) return null;

  const { code, hash } = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();
  const [otpRow] = await sql<Array<{ id: string }>>`
    INSERT INTO mcp_otp_codes (token_id, code_hash, triggered_tool, triggered_args_summary, expires_at)
    VALUES (${tokenCtx.id}, ${hash}, ${action.slice(0, 200)}, ${argsSummary}, ${expiresAt})
    RETURNING id
  `;

  const tgConfigured = isTelegramConfigured();
  if (tgConfigured) {
    const message = `🔐 <b>OTP MCP</b>: <code>${code}</code>\nAzione: <b>${escapeHtml(action)}</b>\nDevice: <b>${escapeHtml(tokenCtx.label)}</b>\n${escapeHtml(argsSummary.slice(0, 200))}\n\n⏱ Valido ${OTP_TTL_SECONDS}s`;
    sendTelegramMessage(message, undefined, { parse_mode: 'HTML' }).catch((err) =>
      log.error({ err }, 'Telegram OTP delivery failed')
    );
  } else {
    log.error('HIGH_RISK call ricevuta ma Telegram non configurato — OTP non consegnabile');
  }

  await audit({ tool: action, argsSummary, risk: 'high', otpRequired: true, success: false, error: 'otp_required' });

  return c.json(
    {
      needs_otp: true,
      code: 'otp_required',
      action_id: otpRow.id,
      expires_in_seconds: OTP_TTL_SECONDS,
      telegram_delivered: tgConfigured,
      error: tgConfigured
        ? "Conferma OTP richiesta. Codice inviato via Telegram. Chiedi all'utente il codice e poi chiama il tool 'mcp_unlock'."
        : 'Telegram non configurato sul server: impossibile consegnare OTP. Configura TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID o usa scope=write per evitare HIGH_RISK.',
    },
    401
  );
}

// ─── api_request ──────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gatewayContent(method: HttpMethod, pathname: string, res: GatewayResponse) {
  const head = `HTTP ${res.status} ${method} ${pathname}`;
  const body = res.body;
  switch (body.kind) {
    case 'empty':
      return [{ type: 'text', text: head }];
    case 'text':
      return [
        {
          type: 'text',
          text: body.truncated
            ? `${head}\n[risposta troncata a ${body.text.length} caratteri: usa paginazione o filtri]\n${body.text}`
            : `${head}\n${body.text}`,
        },
      ];
    case 'binary-too-large':
      return [
        {
          type: 'text',
          text: `${head}\nFile binario ${body.mimeType} di ${body.bytes} byte${res.filename ? ` (${res.filename})` : ''}: troppo grande per essere restituito.`,
        },
      ];
    case 'binary':
      if (body.mimeType.startsWith('image/')) {
        return [
          { type: 'text', text: `${head}\n${body.mimeType}, ${body.bytes} byte${res.filename ? `, ${res.filename}` : ''}` },
          { type: 'image', data: body.base64, mimeType: body.mimeType },
        ];
      }
      return [
        { type: 'text', text: `${head}\n${body.mimeType}, ${body.bytes} byte${res.filename ? `, ${res.filename}` : ''}` },
        {
          type: 'resource',
          resource: {
            uri: `caldes-api:${pathname}${res.filename ? `#${encodeURIComponent(res.filename)}` : ''}`,
            mimeType: body.mimeType,
            blob: body.base64,
          },
        },
      ];
  }
}

async function handleApiRequest(
  c: Context,
  tokenCtx: McpTokenContext,
  args: Record<string, unknown>,
  audit: AuditFn
) {
  const toolResult = (code: string, error: string, extra?: Record<string, unknown>) =>
    c.json({ content: [{ type: 'text', text: JSON.stringify(errorPayload(code, error, { tool: 'api_request', ...extra })) }], isError: true });

  const method = typeof args.method === 'string' ? (args.method.toUpperCase() as HttpMethod) : undefined;
  if (!method || !HTTP_METHODS.includes(method)) {
    return toolResult('invalid_request', `"method" deve essere uno di ${HTTP_METHODS.join(', ')}`);
  }
  const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
  const pathCheck = checkPath(rawPath, getAdminPrefixes());
  const action = `api_request:${method} ${rawPath.slice(0, 160)}`;
  const argsSummary = summarizeArgs({ query: args.query, body: args.body, files: Array.isArray((args.multipart as { files?: unknown[] })?.files) ? (args.multipart as { files: unknown[] }).files.length : undefined });

  if (!pathCheck.ok) {
    await audit({ tool: action, argsSummary, risk: 'high', success: false, error: pathCheck.code });
    return toolResult(pathCheck.code, pathCheck.error, { path: rawPath });
  }
  if (args.query !== undefined && !isPlainObject(args.query)) {
    return toolResult('invalid_request', '"query" deve essere un oggetto');
  }
  if (args.multipart !== undefined && (!isPlainObject(args.multipart) || args.body !== undefined)) {
    return toolResult('invalid_request', '"multipart" deve essere un oggetto e non può essere usato insieme a "body"');
  }
  if (method === 'GET' && (args.body !== undefined || args.multipart !== undefined)) {
    return toolResult('invalid_request', 'GET non accetta body: usa "query"');
  }

  const risk = classifyRisk(method, pathCheck.pathname);
  if (!scopeAllows(tokenCtx.scope, risk)) {
    await audit({ tool: action, argsSummary, risk, success: false, error: `scope_denied:${tokenCtx.scope}` });
    return c.json(
      errorPayload('scope_denied', `Scope '${tokenCtx.scope}' non permette ${method} ${pathCheck.pathname} (rischio ${risk})`, {
        scope: tokenCtx.scope,
        tool: 'api_request',
        risk,
      }),
      403
    );
  }

  if (risk === 'high') {
    const otpResponse = await requireHighRiskUnlock(c, tokenCtx, action, argsSummary, audit);
    if (otpResponse) return otpResponse;
  }

  try {
    const res = await dispatch({
      method,
      pathname: pathCheck.pathname,
      query: args.query as Record<string, never> | undefined,
      body: args.body,
      multipart: args.multipart as Parameters<typeof dispatch>[0]['multipart'],
      mcpTokenId: tokenCtx.id,
    });
    const failed = res.status >= 400;
    await audit({ tool: action, argsSummary, risk, success: !failed, error: failed ? `http_${res.status}` : undefined });
    return c.json({ content: gatewayContent(method, pathCheck.pathname, res), isError: failed || undefined });
  } catch (err) {
    log.error({ err, method, path: pathCheck.pathname }, 'api_request dispatch failed');
    await audit({ tool: action, argsSummary, risk, success: false, error: 'dispatch_error' });
    return toolResult('tool_error', err instanceof Error ? err.message : 'Errore esecuzione richiesta');
  }
}

async function handleUnlock(
  c: Context,
  tokenCtx: McpTokenContext,
  args: Record<string, unknown>,
  ip: string,
  userAgent: string,
  startedAt: number
) {
  const otp = typeof args.otp === 'string' ? args.otp.trim() : '';
  if (!otp || !/^\d{6}$/.test(otp)) {
    await writeMcpAudit({
      tokenId: tokenCtx.id,
      tokenLabel: tokenCtx.label,
      ip,
      userAgent,
      tool: 'mcp_unlock',
      argsSummary: 'invalid_format',
      risk: 'high',
      otpRequired: false,
      success: false,
      error: 'invalid_otp_format',
      durationMs: Date.now() - startedAt,
    });
    return c.json({
      content: [
        {
          type: 'text',
          text: JSON.stringify(errorPayload('invalid_otp', 'OTP deve essere 6 cifre numeriche', { unlocked: false })),
        },
      ],
      isError: true,
    });
  }

  const codeHash = hashOtp(otp);
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM mcp_otp_codes
    WHERE token_id = ${tokenCtx.id}
      AND code_hash = ${codeHash}
      AND used_at IS NULL
      AND expires_at > now()
      AND attempts < max_attempts
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = rows[0];

  if (!row) {
    await sql`
      UPDATE mcp_otp_codes
      SET attempts = attempts + 1
      WHERE token_id = ${tokenCtx.id} AND used_at IS NULL AND expires_at > now()
    `;
    await writeMcpAudit({
      tokenId: tokenCtx.id,
      tokenLabel: tokenCtx.label,
      ip,
      userAgent,
      tool: 'mcp_unlock',
      argsSummary: 'otp_mismatch',
      risk: 'high',
      otpRequired: false,
      success: false,
      error: 'invalid_or_expired_otp',
      durationMs: Date.now() - startedAt,
    });
    return c.json({
      content: [
        {
          type: 'text',
          text: JSON.stringify(errorPayload('invalid_otp', "OTP non valido o scaduto. Per generare un nuovo OTP, ripeti la chiamata al tool ad alto rischio originale.", {
            unlocked: false,
          })),
        },
      ],
      isError: true,
    });
  }

  const unlockUntil = new Date(Date.now() + HIGH_UNLOCK_MINUTES * 60_000).toISOString();
  await sql`UPDATE mcp_otp_codes SET used_at = now() WHERE id = ${row.id}`;
  await sql`UPDATE mcp_tokens SET high_risk_unlocked_until = ${unlockUntil} WHERE id = ${tokenCtx.id}`;

  await writeMcpAudit({
    tokenId: tokenCtx.id,
    tokenLabel: tokenCtx.label,
    ip,
    userAgent,
    tool: 'mcp_unlock',
    argsSummary: 'success',
    risk: 'high',
    otpRequired: false,
    success: true,
    durationMs: Date.now() - startedAt,
  });

  return c.json({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          unlocked: true,
          valid_until: unlockUntil,
          valid_for_minutes: HIGH_UNLOCK_MINUTES,
          message: `Tool ad alto rischio sbloccati per ${HIGH_UNLOCK_MINUTES} minuti. Ora ripeti la chiamata al tool originale con gli stessi argomenti.`,
        }),
      },
    ],
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
