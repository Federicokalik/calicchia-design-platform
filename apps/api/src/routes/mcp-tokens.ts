import { Hono } from 'hono';
import { sql } from '../db';
import { generateMcpToken } from '../lib/mcp/tokens';

type McpScope = 'read' | 'write' | 'admin';

type McpTokenListRow = {
  id: string;
  label: string;
  scope: McpScope;
  token_prefix: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  usage_count: number | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

type CreateTokenBody = {
  label?: unknown;
  scope?: unknown;
  expires_at?: unknown;
};

const VALID_SCOPES: ReadonlyArray<McpScope> = ['read', 'write', 'admin'];

export const mcpTokens = new Hono();

mcpTokens.get('/', async (c) => {
  const active = await sql<Array<McpTokenListRow>>`
    SELECT
      id,
      label,
      scope,
      token_prefix,
      last_used_at,
      last_used_ip,
      usage_count,
      expires_at,
      created_at,
      revoked_at
    FROM mcp_tokens
    WHERE is_active = true
      AND revoked_at IS NULL
    ORDER BY created_at DESC
  `;

  const revoked = await sql<Array<McpTokenListRow>>`
    SELECT
      id,
      label,
      scope,
      token_prefix,
      last_used_at,
      last_used_ip,
      usage_count,
      expires_at,
      created_at,
      revoked_at
    FROM mcp_tokens
    WHERE revoked_at IS NOT NULL
    ORDER BY revoked_at DESC
    LIMIT 10
  `;

  return c.json({ active, revoked });
});

mcpTokens.post('/', async (c) => {
  let body: CreateTokenBody;
  try {
    body = await c.req.json<CreateTokenBody>();
  } catch {
    return c.json({ error: 'Body JSON richiesto' }, 400);
  }

  const labelValue = typeof body.label === 'string' ? body.label.trim() : '';
  if (!labelValue || labelValue.length > 100) {
    return c.json({ error: 'label obbligatoria (max 100 caratteri)' }, 400);
  }

  if (typeof body.scope !== 'string' || !VALID_SCOPES.includes(body.scope as McpScope)) {
    return c.json({ error: "scope deve essere uno tra: 'read', 'write', 'admin'" }, 400);
  }
  const scope = body.scope as McpScope;

  let expiresAt: string | null = null;
  if (body.expires_at !== undefined) {
    if (typeof body.expires_at !== 'string') {
      return c.json({ error: 'expires_at deve essere una stringa ISO valida' }, 400);
    }
    const parsed = new Date(body.expires_at);
    if (Number.isNaN(parsed.getTime())) {
      return c.json({ error: 'expires_at deve essere una data ISO valida' }, 400);
    }
    expiresAt = parsed.toISOString();
  }

  const { token, hash, prefix } = generateMcpToken();

  const [created] = await sql<Array<{ id: string }>>`
    INSERT INTO mcp_tokens (token_hash, token_prefix, label, scope, expires_at)
    VALUES (${hash}, ${prefix}, ${labelValue}, ${scope}, ${expiresAt})
    RETURNING id
  `;

  return c.json(
    {
      id: created.id,
      token,
      label: labelValue,
      scope,
      prefix,
      warning: 'Salva il token ora — non sarà più visibile',
    },
    201
  );
});

mcpTokens.delete('/:id', async (c) => {
  const id = c.req.param('id');

  const [row] = await sql<Array<{ id: string }>>`
    UPDATE mcp_tokens
    SET revoked_at = now(), is_active = false, revoked_reason = 'manual'
    WHERE id = ${id}
    RETURNING id
  `;

  if (!row) {
    return c.json({ error: 'Token non trovato' }, 404);
  }

  return c.json({ revoked: true });
});
