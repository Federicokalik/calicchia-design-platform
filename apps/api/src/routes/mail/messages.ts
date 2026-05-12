import { Hono } from 'hono';
import { sql } from '../../db';
import { extractToken } from '../../middleware/auth';
import { jwtVerify } from 'jose';
import { getJwtSecret } from '../../lib/jwt';

export const mailMessages = new Hono();

async function getUserId(c: any): Promise<string | null> {
  const token = extractToken(c);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload.sub as string;
  } catch {
    return null;
  }
}

// GET /api/mail/messages — paginated list for an account/folder
// Query: account_id, folder (default INBOX), category, limit, offset, search
mailMessages.get('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'account_id richiesto' }, 400);

  // Verify ownership
  const [acc] = await sql`SELECT id FROM email_accounts WHERE id = ${accountId} AND user_id = ${userId}`;
  if (!acc) return c.json({ error: 'Account non trovato' }, 404);

  const folder = c.req.query('folder') || 'INBOX';
  const category = c.req.query('category');
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200);
  const offset = Number(c.req.query('offset') || '0');
  const search = c.req.query('search')?.trim();

  const searchFilter = search
    ? sql`AND (subject ILIKE ${'%' + search + '%'} OR from_addr ILIKE ${'%' + search + '%'} OR snippet ILIKE ${'%' + search + '%'})`
    : sql``;
  const categoryFilter = category && category !== 'all'
    ? sql`AND category = ${category}`
    : sql``;

  const rows = await sql`
    SELECT id, uid, message_id, thread_id,
           from_addr, from_name, to_addrs, subject, snippet,
           has_attachments, flags, received_at, category
    FROM email_messages
    WHERE account_id = ${accountId} AND folder = ${folder}
    ${categoryFilter}
    ${searchFilter}
    ORDER BY received_at DESC NULLS LAST, uid DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const [{ count }] = await sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count
    FROM email_messages
    WHERE account_id = ${accountId} AND folder = ${folder}
    ${categoryFilter}
    ${searchFilter}
  `;

  // Per-category counts (respect folder + search, not category filter)
  const catCounts = await sql<Array<{ category: string; count: number; unread: number }>>`
    SELECT
      category,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE NOT ('\\Seen' = ANY(flags)))::int AS unread
    FROM email_messages
    WHERE account_id = ${accountId} AND folder = ${folder}
    ${searchFilter}
    GROUP BY category
  `;
  const counts: Record<string, { count: number; unread: number }> = {};
  for (const row of catCounts) counts[row.category] = { count: row.count, unread: row.unread };

  return c.json({ messages: rows, count, counts });
});

// POST /api/mail/messages/classify-ai — LLM classification on normali/unclassified emails
// Body: { limit?: 50, only_normali?: true }
mailMessages.post('/classify-ai', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const body = await c.req.json().catch(() => ({} as { limit?: number; only_normali?: boolean }));
  const limit = Math.min(body.limit ?? 50, 200);
  const onlyNormali = body.only_normali !== false; // default true

  const catFilter = onlyNormali ? sql`AND m.category = 'normali'` : sql``;

  const rows = await sql<Array<{
    id: string; from_addr: string | null; from_name: string | null;
    subject: string | null; snippet: string | null;
  }>>`
    SELECT m.id, m.from_addr, m.from_name, m.subject, m.snippet
    FROM email_messages m
    JOIN email_accounts a ON a.id = m.account_id AND a.user_id = ${userId}
    WHERE m.folder = 'INBOX'
    ${catFilter}
    ORDER BY m.received_at DESC
    LIMIT ${limit}
  `;

  if (rows.length === 0) {
    return c.json({ scanned: 0, updated: 0, failed: 0, distribution: {} });
  }

  const { classifyEmailsWithAi } = await import('../../lib/mail/ai-classifier');
  const { results, failed } = await classifyEmailsWithAi(
    rows.map((r) => ({
      id: r.id,
      from_addr: r.from_addr,
      from_name: r.from_name,
      subject: r.subject,
      snippet: r.snippet,
    })),
  );

  const dist: Record<string, number> = {};
  let updated = 0;
  for (const r of results) {
    dist[r.category] = (dist[r.category] || 0) + 1;
    const res = await sql`
      UPDATE email_messages SET category = ${r.category}
      WHERE id = ${r.id}
        AND account_id IN (SELECT id FROM email_accounts WHERE user_id = ${userId})
        AND category <> ${r.category}
      RETURNING id
    `;
    if (res.length > 0) updated++;
  }

  return c.json({
    scanned: rows.length,
    classified: results.length,
    updated,
    failed,
    distribution: dist,
  });
});

// POST /api/mail/messages/reclassify — re-run classifier on existing rows
// Body: { account_id? } — optional; defaults to all user accounts
mailMessages.post('/reclassify', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const body = await c.req.json().catch(() => ({} as { account_id?: string }));
  const accountId = body.account_id;

  const accountFilter = accountId
    ? sql`AND a.id = ${accountId}`
    : sql``;

  const rows = await sql<Array<{ id: string; from_addr: string | null; subject: string | null; flags: string[] }>>`
    SELECT m.id, m.from_addr, m.subject, m.flags
    FROM email_messages m
    JOIN email_accounts a ON a.id = m.account_id AND a.user_id = ${userId}
    WHERE 1=1 ${accountFilter}
  `;

  const { classifyMail } = await import('../../lib/mail/classifier');
  let changed = 0;
  for (const row of rows) {
    const cat = classifyMail({
      fromAddr: row.from_addr,
      subject: row.subject,
      flags: row.flags,
    });
    const res = await sql`
      UPDATE email_messages SET category = ${cat}
      WHERE id = ${row.id} AND category <> ${cat}
      RETURNING id
    `;
    if (res.length > 0) changed++;
  }

  return c.json({ scanned: rows.length, updated: changed });
});

// GET /api/mail/messages/:id — full message (body_html + attachments)
mailMessages.get('/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  const [msg] = await sql`
    SELECT m.*,
      (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', a.id, 'filename', a.filename, 'content_type', a.content_type, 'size_bytes', a.size_bytes
        )), '[]'::jsonb)
        FROM email_attachments a WHERE a.message_id = m.id
      ) AS attachments,
      (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', l.id, 'entity_type', l.entity_type, 'entity_id', l.entity_id, 'auto', l.auto
        )), '[]'::jsonb)
        FROM email_links l WHERE l.message_id = m.id
      ) AS links
    FROM email_messages m
    JOIN email_accounts a ON a.id = m.account_id AND a.user_id = ${userId}
    WHERE m.id = ${id}
    LIMIT 1
  `;
  if (!msg) return c.json({ error: 'Messaggio non trovato' }, 404);
  return c.json({ message: msg });
});

// PATCH /api/mail/messages/:id/flags — update flags (mark read/starred)
// Body: { add?: string[], remove?: string[] }
// NOTE: v1 updates only the local cache. Real IMAP flag sync is a v2 feature.
mailMessages.patch('/:id/flags', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  const { add = [], remove = [] } = await c.req.json() as { add?: string[]; remove?: string[] };

  const [current] = await sql<Array<{ flags: string[] }>>`
    SELECT m.flags FROM email_messages m
    JOIN email_accounts a ON a.id = m.account_id AND a.user_id = ${userId}
    WHERE m.id = ${id}
    LIMIT 1
  `;
  if (!current) return c.json({ error: 'Messaggio non trovato' }, 404);

  const next = new Set(current.flags);
  for (const f of add) next.add(f);
  for (const f of remove) next.delete(f);
  const nextArr = Array.from(next);

  await sql`
    UPDATE email_messages SET flags = ${nextArr}
    WHERE id = ${id}
  `;
  return c.json({ flags: nextArr });
});

// DELETE /api/mail/messages/:id — remove local cache entry (IMAP-side delete in v2)
mailMessages.delete('/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  const res = await sql`
    DELETE FROM email_messages
    WHERE id = ${id}
      AND account_id IN (SELECT id FROM email_accounts WHERE user_id = ${userId})
    RETURNING id
  `;
  if (res.length === 0) return c.json({ error: 'Messaggio non trovato' }, 404);
  return c.json({ success: true });
});
