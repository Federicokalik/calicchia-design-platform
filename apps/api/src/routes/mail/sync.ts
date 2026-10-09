import { Hono } from 'hono';
import { sql } from '../../db';
import { syncAccount } from '../../lib/mail/sync-service';
import { extractToken } from '../../middleware/auth';
import { jwtVerify } from 'jose';
import { getJwtSecret } from '../../lib/jwt';

export const mailSync = new Hono();

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

// POST /api/mail/sync/:accountId — trigger manual sync
// Body: { mode?: 'latest'|'older'|'all', limit?: number }
mailSync.post('/:accountId', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const accountId = c.req.param('accountId');
  const [acc] = await sql`
    SELECT id FROM email_accounts
    WHERE id = ${accountId} AND user_id = ${userId} AND active = true
    LIMIT 1
  `;
  if (!acc) return c.json({ error: 'Account non trovato' }, 404);

  const body = await c.req.json().catch(() => ({} as { mode?: string; limit?: number; folder?: string }));
  const mode = (body.mode === 'older' || body.mode === 'all') ? body.mode : 'latest';
  const maxMessages = Math.min(Math.max(Number(body.limit) || 100, 1), 5000);

  try {
    // "Sincronizza ora" (latest) senza cartella esplicita aggiorna In arrivo
    // + Inviati come il cron; forzare 'INBOX' lasciava Inviati indietro fino
    // al giro successivo. Gli import di storico restano su In arrivo.
    const folder = body.folder || (mode === 'latest' ? undefined : 'INBOX');
    const results = await syncAccount(accountId, { mode, maxMessages, folder });
    const failed = results.filter((r) => r.error);
    return c.json({ success: failed.length === 0, results });
  } catch (err) {
    return c.json({ error: `Sync fallita: ${(err as Error).message}` }, 502);
  }
});

// GET /api/mail/sync/:accountId/status — how many we have locally vs how many exist on server
mailSync.get('/:accountId/status', async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: 'Non autorizzato' }, 401);

  const accountId = c.req.param('accountId');
  const folder = c.req.query('folder') || 'INBOX';

  const [acc] = await sql`SELECT id FROM email_accounts WHERE id = ${accountId} AND user_id = ${userId} AND active = true`;
  if (!acc) return c.json({ error: 'Account non trovato' }, 404);

  const [{ count: cached }] = await sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM email_messages
    WHERE account_id = ${accountId} AND folder = ${folder}
  `;

  return c.json({ folder, cached });
});
