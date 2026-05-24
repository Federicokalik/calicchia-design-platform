import { Hono } from 'hono';
import { sql } from '../db';
import { authMiddleware } from '../middleware/auth';
import { verifyTurnstileToken } from '../lib/turnstile';
import { getClientIp } from '../lib/client-ip';

export const newsletter = new Hono();

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;

newsletter.post('/subscribe', async (c) => {
  const { email, name, turnstile_token } = await c.req.json();

  const clientIp = getClientIp(c);
  // Truncate user-agent to a reasonable length to avoid unbounded text storage
  // if a client sends an abusive header.
  const userAgent = (c.req.header('user-agent') ?? '').slice(0, 512) || null;

  // Turnstile verification (action binds token to the newsletter signup form)
  const turnstileOk = await verifyTurnstileToken(turnstile_token || '', {
    remoteIp: clientIp ?? undefined,
    expectedAction: 'newsletter_subscribe',
  });
  if (!turnstileOk) {
    return c.json({ error: 'Verifica anti-bot fallita. Ricarica la pagina e riprova.' }, 403);
  }

  if (!email) {
    return c.json({ error: 'Email richiesta' }, 400);
  }
  if (!isValidEmail(email)) {
    return c.json({ error: 'Email non valida' }, 400);
  }

  // Persist consent proof (art. 7 GDPR + Decisione Garante 330/2025): IP +
  // user-agent at subscribe time, alongside the existing timestamp. The
  // double-opt-in confirmation later captures `confirmed_ip` to prove that
  // the click came from someone with mailbox access.
  await sql`
    INSERT INTO newsletter_subscribers (email, name, status, consent_ip, consent_user_agent)
    VALUES (${email}, ${name || null}, 'pending', ${clientIp}, ${userAgent})
    ON CONFLICT (email) DO UPDATE SET
      name               = EXCLUDED.name,
      status             = 'pending',
      consent_ip         = EXCLUDED.consent_ip,
      consent_user_agent = EXCLUDED.consent_user_agent,
      updated_at         = NOW()
  `;

  return c.json({ success: true, message: 'Iscrizione ricevuta. Controlla la tua email.' });
});

newsletter.get('/confirm', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'Token mancante' }, 400);

  const confirmIp = getClientIp(c);

  const [updated] = await sql`
    UPDATE newsletter_subscribers
    SET status       = 'confirmed',
        confirmed_at = NOW(),
        confirmed_ip = ${confirmIp}
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
