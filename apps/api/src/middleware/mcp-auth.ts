import { Context, Next } from 'hono';
import { sql } from '../db';
import { hashMcpToken } from '../lib/mcp/tokens';

export interface McpTokenContext {
  id: string;
  label: string;
  scope: 'read' | 'write' | 'admin';
  high_risk_unlocked_until: string | null;
  expires_at: string | null;
}

export async function mcpAuthMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token || !token.startsWith('mcp_')) {
    return c.json({ error: 'Token MCP richiesto' }, 401);
  }

  const tokenHash = hashMcpToken(token);
  const rows = await sql<McpTokenContext[]>`
    SELECT id, label, scope, high_risk_unlocked_until, expires_at
    FROM mcp_tokens
    WHERE token_hash = ${tokenHash}
      AND is_active = true
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return c.json({ error: 'Token non valido o revocato' }, 401);

  const ip = (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim()
    || c.req.header('x-real-ip')
    || 'unknown';

  sql`
    UPDATE mcp_tokens
    SET last_used_at = now(), last_used_ip = ${ip}, usage_count = usage_count + 1
    WHERE id = ${row.id}
  `.catch(() => {});

  c.set('mcpToken', row);
  c.set('mcpClientIp', ip);
  c.set('user', { id: 'mcp', email: `mcp:${row.label}`, role: 'admin' });
  await next();
}
