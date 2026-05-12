import { Context, Hono } from 'hono';
import { sql } from '../db';
import { tools, executeTool, checkRateLimit, type ToolDefinition } from '../lib/agent/tools';
import { generateOtp, hashOtp } from '../lib/mcp/tokens';
import { writeMcpAudit, summarizeArgs } from '../lib/mcp/audit';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram';
import type { McpTokenContext } from '../middleware/mcp-auth';

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

function isReadTool(name: string): boolean {
  if (READ_EXACT.has(name)) return true;
  return READ_PREFIXES.some((p) => name.startsWith(p));
}

function getRisk(tool: ToolDefinition): 'low' | 'medium' | 'high' {
  return tool.riskLevel ?? 'low';
}

function checkScope(scope: 'read' | 'write' | 'admin', risk: 'low' | 'medium' | 'high', isRead: boolean): boolean {
  if (scope === 'admin') return true;
  if (scope === 'write') return risk !== 'high';
  if (scope === 'read') return isRead;
  return false;
}

const MCP_UNLOCK_TOOL_DEF = {
  name: 'mcp_unlock',
  description:
    "Sblocca i tool ad alto rischio (send_email, send_whatsapp) inserendo l'OTP ricevuto via Telegram. Usa SOLO quando un tool restituisce needs_otp=true. Lo sblocco dura 5 minuti — dopo lo sblocco devi RIPETERE la chiamata al tool originale con gli stessi argomenti.",
  inputSchema: {
    type: 'object',
    properties: { otp: { type: 'string', description: 'Codice 6 cifre ricevuto via Telegram' } },
    required: ['otp'],
  },
};

mcp.get('/tools', (c) => {
  const apiTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
  return c.json({ tools: [...apiTools, MCP_UNLOCK_TOOL_DEF] });
});

mcp.post('/execute', async (c) => {
  const startedAt = Date.now();

  let body: { name?: string; args?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body JSON richiesto' }, 400);
  }

  const name = body.name;
  const args = body.args ?? {};
  if (!name || typeof name !== 'string') {
    return c.json({ error: 'Campo "name" richiesto' }, 400);
  }

  if (!checkRateLimit('mcp')) {
    return c.json({ error: 'Rate limit raggiunto (20 chiamate/minuto)' }, 429);
  }

  const tokenCtx = c.get('mcpToken');
  if (!tokenCtx) {
    return c.json({ error: 'Token context mancante' }, 500);
  }
  const ip = c.get('mcpClientIp') ?? 'unknown';
  const userAgent = c.req.header('user-agent') ?? 'unknown';

  if (name === 'mcp_unlock') {
    return handleUnlock(c, tokenCtx, args, ip, userAgent, startedAt);
  }

  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return c.json({ error: `Tool "${name}" non trovato` }, 404);
  }

  const risk = getRisk(tool);
  const isRead = isReadTool(name);
  const argsSummary = summarizeArgs(args);

  if (!checkScope(tokenCtx.scope, risk, isRead)) {
    await writeMcpAudit({
      tokenId: tokenCtx.id,
      tokenLabel: tokenCtx.label,
      ip,
      userAgent,
      tool: name,
      argsSummary,
      risk,
      otpRequired: false,
      success: false,
      error: `scope_denied:${tokenCtx.scope}`,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: `Scope '${tokenCtx.scope}' non permette tool '${name}'` }, 403);
  }

  if (risk === 'high') {
    const unlockedUntilTs = tokenCtx.high_risk_unlocked_until
      ? new Date(tokenCtx.high_risk_unlocked_until).getTime()
      : 0;
    if (unlockedUntilTs < Date.now()) {
      const { code, hash } = generateOtp();
      const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();
      const [otpRow] = await sql<Array<{ id: string }>>`
        INSERT INTO mcp_otp_codes (token_id, code_hash, triggered_tool, triggered_args_summary, expires_at)
        VALUES (${tokenCtx.id}, ${hash}, ${name}, ${argsSummary}, ${expiresAt})
        RETURNING id
      `;

      const tgConfigured = isTelegramConfigured();
      if (tgConfigured) {
        const message = `🔐 <b>OTP MCP</b>: <code>${code}</code>\nAzione: <b>${escapeHtml(name)}</b>\nDevice: <b>${escapeHtml(tokenCtx.label)}</b>\n${escapeHtml(argsSummary.slice(0, 200))}\n\n⏱ Valido ${OTP_TTL_SECONDS}s`;
        sendTelegramMessage(message, undefined, { parse_mode: 'HTML' }).catch((err) =>
          console.error('[mcp] Telegram OTP delivery failed:', err)
        );
      } else {
        console.error(
          '[mcp] HIGH_RISK call ricevuta ma Telegram non configurato — OTP non consegnabile'
        );
      }

      await writeMcpAudit({
        tokenId: tokenCtx.id,
        tokenLabel: tokenCtx.label,
        ip,
        userAgent,
        tool: name,
        argsSummary,
        risk,
        otpRequired: true,
        success: false,
        error: 'otp_required',
        durationMs: Date.now() - startedAt,
      });

      return c.json(
        {
          needs_otp: true,
          action_id: otpRow.id,
          expires_in_seconds: OTP_TTL_SECONDS,
          telegram_delivered: tgConfigured,
          message: tgConfigured
            ? "Conferma OTP richiesta. Codice inviato via Telegram. Chiedi all'utente il codice e poi chiama il tool 'mcp_unlock'."
            : 'Telegram non configurato sul server: impossibile consegnare OTP. Configura TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID o usa scope=write per evitare HIGH_RISK.',
        },
        401
      );
    }
  }

  const result = await executeTool(name, args);
  let parsed: unknown = result;
  try {
    parsed = JSON.parse(result);
  } catch {
    /* mantiene grezzo */
  }

  await writeMcpAudit({
    tokenId: tokenCtx.id,
    tokenLabel: tokenCtx.label,
    ip,
    userAgent,
    tool: name,
    argsSummary,
    risk,
    otpRequired: false,
    success: true,
    durationMs: Date.now() - startedAt,
  });

  return c.json({
    content: [{ type: 'text', text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) }],
  });
});

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
          text: JSON.stringify({ unlocked: false, error: 'OTP deve essere 6 cifre numeriche' }),
        },
      ],
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
          text: JSON.stringify({
            unlocked: false,
            error:
              "OTP non valido o scaduto. Per generare un nuovo OTP, ripeti la chiamata al tool ad alto rischio originale.",
          }),
        },
      ],
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
