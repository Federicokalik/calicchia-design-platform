import { Hono } from 'hono';
import { sql } from '../db';
import { authMiddleware } from '../middleware/auth';
import { verifyTurnstileToken } from '../lib/turnstile';

export const newsletter = new Hono();

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;

newsletter.post('/subscribe', async (c) => {
  const { email, name, turnstile_token } = await c.req.json();

  // Turnstile verification
  const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined;
  const turnstileOk = await verifyTurnstileToken(turnstile_token || '', clientIp);
  if (!turnstileOk) {
    return c.json({ error: 'Verifica anti-bot fallita. Ricarica la pagina e riprova.' }, 403);
  }

  if (!email) {
    return c.json({ error: 'Email richiesta' }, 400);
  }
  if (!isValidEmail(email)) {
    return c.json({ error: 'Email non valida' }, 400);
  }

  await sql`
    INSERT INTO newsletter_subscribers (email, name, status)
    VALUES (${email}, ${name || null}, 'pending')
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, status = 'pending'
  `;

  return c.json({ success: true, message: 'Iscrizione ricevuta. Controlla la tua email.' });
});

newsletter.get('/confirm', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'Token mancante' }, 400);

  const [updated] = await sql`
    UPDATE newsletter_subscribers
    SET status = 'confirmed', confirmed_at = NOW()
    WHERE confirmation_token = ${token}::uuid
    RETURNING id
  `;
  if (!updated) return c.json({ error: 'Token non valido o gia utilizzato' }, 404);
  return c.json({ success: true, message: 'Email confermata!' });
});

newsletter.get('/unsubscribe', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'Token mancante' }, 400);

  const [updated] = await sql`
    UPDATE newsletter_subscribers
    SET status = 'unsubscribed'
    WHERE unsubscribe_token = ${token}::uuid
    RETURNING id
  `;
  if (!updated) return c.json({ error: 'Token non valido o gia utilizzato' }, 404);
  return c.json({ success: true, message: 'Disiscrizione completata.' });
});

newsletter.get('/', authMiddleware, async (c) => {
  const status = c.req.query('status');
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);

  const statusFilter = status && status !== 'all' ? sql`AND status = ${status}` : sql``;

  const [subscribers, allSubs] = await Promise.all([
    sql`
      SELECT * FROM newsletter_subscribers
      WHERE 1=1 ${statusFilter}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `,
    sql`SELECT status FROM newsletter_subscribers`,
  ]);

  const stats = {
    total: allSubs.length,
    confirmed: allSubs.filter((s) => s.status === 'confirmed').length,
    pending: allSubs.filter((s) => s.status === 'pending').length,
    unsubscribed: allSubs.filter((s) => s.status === 'unsubscribed').length,
  };

  return c.json({ subscribers, stats });
});

newsletter.put('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const [subscriber] = await sql`
    UPDATE newsletter_subscribers SET ${sql(body)} WHERE id = ${id} RETURNING *
  `;
  return c.json({ subscriber });
});

newsletter.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  await sql`DELETE FROM newsletter_subscribers WHERE id = ${id}`;
  return c.json({ success: true });
});
