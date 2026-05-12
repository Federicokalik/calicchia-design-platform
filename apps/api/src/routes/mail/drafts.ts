import { Hono } from 'hono';
import { sql } from '../../db';
import { extractToken } from '../../middleware/auth';
import { jwtVerify } from 'jose';
import { getJwtSecret } from '../../lib/jwt';

export const mailDrafts = new Hono();

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

// GET /api/mail/drafts?pending=1 — list pending drafts for user
mailDrafts.get('/', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const pendingOnly = c.req.query('pending') === '1';
  const filter = pendingOnly ? sql`AND sent_at IS NULL` : sql``;

  const drafts = await sql`
    SELECT id, account_id, to_addrs, cc_addrs, subject, body,
           in_reply_to_msgid, reply_to_message_id, source, sent_at, created_at
    FROM email_drafts
    WHERE user_id = ${userId}
    ${filter}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return c.json({ drafts });
});

// GET /api/mail/drafts/:id — single draft
mailDrafts.get('/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  const [draft] = await sql`
    SELECT id, account_id, to_addrs, cc_addrs, subject, body,
           in_reply_to_msgid, reply_to_message_id, source, sent_at, created_at
    FROM email_drafts
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!draft) return c.json({ error: 'Bozza non trovata' }, 404);
  return c.json({ draft });
});

// DELETE /api/mail/drafts/:id
mailDrafts.delete('/:id', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  const res = await sql`DELETE FROM email_drafts WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
  if (res.length === 0) return c.json({ error: 'Bozza non trovata' }, 404);
  return c.json({ success: true });
});

// POST /api/mail/drafts/:id/mark-sent — flag a draft as sent (after SMTP send)
mailDrafts.post('/:id/mark-sent', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const id = c.req.param('id');
  await sql`
    UPDATE email_drafts SET sent_at = now()
    WHERE id = ${id} AND user_id = ${userId}
  `;
  return c.json({ success: true });
});
