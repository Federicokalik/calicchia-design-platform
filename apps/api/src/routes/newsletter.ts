import { Hono } from 'hono';
import { sql } from '../db';
import { authMiddleware } from '../middleware/auth';
import { captcha } from '../lib/captcha';
import { getClientIp } from '../lib/client-ip';
import { sendNewsletterConfirmEmail } from '../lib/email';
import { syncSubscriberConfirmed } from '../lib/marketing/audience-sync';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'newsletter' });

export const newsletter = new Hono();

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;

newsletter.post('/subscribe', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Dati non validi' }, 400);
  const { email: rawEmail, name, turnstile_token } = body;
  // Normalize case so a later GDPR erase/export (which matches lowercased) can
  // find the row, and so 'User@x.com' / 'user@x.com' don't create two records.
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

  const clientIp = getClientIp(c);
  // Truncate user-agent to a reasonable length to avoid unbounded text storage
  // if a client sends an abusive header.
  const userAgent = (c.req.header('user-agent') ?? '').slice(0, 512) || null;

  // Captcha verification (siteKeyId binds token to the newsletter signup form)
  const captchaResult = await captcha.verify(turnstile_token || '', {
    remoteIp: clientIp ?? undefined,
    siteKeyId: 'newsletter_subscribe',
  });
  if (!captchaResult.ok) {
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
  // Audit A-010: must read confirmation_token back from the row so we can
  // mail the double-opt-in link. ON CONFLICT path keeps the existing token
  // (a re-subscribe must not invalidate an in-flight pending click) but
  // still RETURNs it so we can re-send the confirm mail.
  const [subscriber] = await sql`
    INSERT INTO newsletter_subscribers (email, name, status, consent_ip, consent_user_agent)
    VALUES (${email}, ${name || null}, 'pending', ${clientIp}, ${userAgent})
    ON CONFLICT (email) DO UPDATE SET
      name               = EXCLUDED.name,
      -- A re-subscribe must NOT downgrade an already-confirmed subscriber back
      -- to 'pending' (which would silently drop them from sends until they
      -- re-click), nor overwrite their original consent proof with the
      -- re-submitter's IP/UA. Preserve both when already confirmed.
      status             = CASE WHEN newsletter_subscribers.status = 'confirmed' THEN 'confirmed' ELSE 'pending' END,
      consent_ip         = CASE WHEN newsletter_subscribers.status = 'confirmed' THEN newsletter_subscribers.consent_ip ELSE EXCLUDED.consent_ip END,
      consent_user_agent = CASE WHEN newsletter_subscribers.status = 'confirmed' THEN newsletter_subscribers.consent_user_agent ELSE EXCLUDED.consent_user_agent END,
      updated_at         = NOW()
    RETURNING confirmation_token, status
  ` as Array<{ confirmation_token: string; status: string }>;

  // Fire-and-forget the confirm mail: we never block the response on it nor
  // surface the transport result to the caller. Mail failures (Resend rate-
  // limit, SMTP outage) must not leak to the public form — UX-wise the user
  // already saw "controlla la tua email" and a retry is one /subscribe away.
  if (subscriber?.confirmation_token && subscriber.status !== 'confirmed') {
    sendNewsletterConfirmEmail({
      to: email,
      confirmationToken: subscriber.confirmation_token,
      name: name || null,
    })
      .then((res) => {
        if (!res.success) {
          log.warn({ email, err: res.error, via: res.via }, 'newsletter confirm email send failed');
        }
      })
      .catch((err) => log.warn({ email, err }, 'newsletter confirm email threw'));
  } else {
    log.error({ email }, 'subscribe INSERT did not return confirmation_token');
  }

  return c.json({ success: true, message: 'Iscrizione ricevuta. Controlla la tua email.' });
});

newsletter.get('/confirm', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'Token mancante' }, 400);

  const confirmIp = getClientIp(c);

  // Only a still-pending row may be confirmed, and the token is burned (rotated)
  // on success. Without `AND status='pending'` an already-unsubscribed user (or
  // a link-scanner re-visiting an old email) would be silently re-confirmed —
  // processing after opt-out. Token rotation makes the link single-use.
  const [updated] = await sql`
    UPDATE newsletter_subscribers
    SET status             = 'confirmed',
        confirmed_at       = NOW(),
        confirmed_ip       = ${confirmIp},
        confirmation_token = gen_random_uuid()
    WHERE confirmation_token = ${token}::uuid AND status = 'pending'
    RETURNING id
  `;
  if (!updated) return c.json({ error: 'Token non valido o gia utilizzato' }, 404);

  // Project the new consent into the marketing audience immediately (don't wait
  // for the daily cron). Fire-and-forget — failures must not break confirmation.
  syncSubscriberConfirmed(updated.id).catch((err) =>
    log.warn({ err, subscriberId: updated.id }, 'inline audience sync threw'));

  return c.json({ success: true, message: 'Email confermata!' });
});

newsletter.get('/unsubscribe', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'Token mancante' }, 400);

  const [updated] = await sql`
    UPDATE newsletter_subscribers
    SET status = 'unsubscribed', unsubscribed_at = NOW()
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
