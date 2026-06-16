/**
 * Marketing tracking — PUBLIC endpoints (must NOT be in protectedPaths).
 *   GET /o/:msgId          → open pixel (1x1 gif)
 *   GET /c/:token?m=:msgId → click redirect (to a registered URL only)
 *   GET /u/:token          → one-click unsubscribe (unified across channels)
 *
 * IP is minimized to a /24 (v4) or /48 (v6) subnet — never stored in full.
 * Counters on mkt_campaigns are incremented only on the FIRST open/click per
 * message (idempotent via the COALESCE-guarded conditional UPDATE).
 */
import { Hono } from 'hono';
import { sql } from '../db';
import { getClientIp } from '../lib/client-ip';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'mkt-track' });
export const mktTrack = new Hono();

// 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function truncIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::/48';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : null;
}

function uaTrunc(c: { req: { header: (k: string) => string | undefined } }): string | null {
  return (c.req.header('user-agent') ?? '').slice(0, 256) || null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

mktTrack.get('/o/:msgId', async (c) => {
  const msgId = c.req.param('msgId').replace(/\.gif$/i, '');
  if (UUID_RE.test(msgId)) {
    try {
      const [m] = await sql`
        UPDATE mkt_messages
        SET opened_at = now(),
            status = CASE WHEN status IN ('sent','delivered') THEN 'opened' ELSE status END
        WHERE id = ${msgId} AND opened_at IS NULL
        RETURNING campaign_id, contact_id`;
      if (m) {
        await sql`UPDATE mkt_campaigns SET total_opened = total_opened + 1 WHERE id = ${m.campaign_id}`;
        await sql`INSERT INTO mkt_events (message_id, campaign_id, contact_id, type, ip_trunc, user_agent)
                  VALUES (${msgId}, ${m.campaign_id}, ${m.contact_id}, 'open', ${truncIp(getClientIp(c))}, ${uaTrunc(c)})`;
      }
    } catch (err) { log.warn({ err, msgId }, 'open track failed'); }
  }
  c.header('Content-Type', 'image/gif');
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  return c.body(PIXEL);
});

mktTrack.get('/c/:token', async (c) => {
  const token = c.req.param('token');
  const msgId = c.req.query('m');
  const [link] = await sql`SELECT original_url, campaign_id FROM mkt_links WHERE token = ${token}`;
  if (!link) return c.json({ error: 'Not Found' }, 404);

  if (msgId && UUID_RE.test(msgId)) {
    try {
      const [m] = await sql`
        UPDATE mkt_messages
        SET clicked_at = COALESCE(clicked_at, now()),
            status = CASE WHEN status IN ('sent','delivered','opened') THEN 'clicked' ELSE status END
        WHERE id = ${msgId} AND clicked_at IS NULL
        RETURNING campaign_id, contact_id`;
      if (m) await sql`UPDATE mkt_campaigns SET total_clicked = total_clicked + 1 WHERE id = ${m.campaign_id}`;
      // Always log the click event (even repeat clicks), for analytics.
      await sql`INSERT INTO mkt_events (message_id, campaign_id, contact_id, type, url, ip_trunc, user_agent)
                VALUES (${msgId}, ${link.campaign_id}, ${m?.contact_id ?? null}, 'click', ${link.original_url}, ${truncIp(getClientIp(c))}, ${uaTrunc(c)})`;
    } catch (err) { log.warn({ err, msgId }, 'click track failed'); }
  }
  // Only ever redirect to a URL we ourselves registered → no open-redirect.
  return c.redirect(link.original_url, 302);
});

// Resolve an unsubscribe token to a contact. Tokens come either from a campaign
// message (mkt_messages.unsubscribe_token) or, for automation/transactional
// marketing sends, directly from the contact (mkt_contacts.unsubscribe_token).
async function resolveUnsubToken(token: string): Promise<{ contactId: string; emailNorm: string | null; campaignId: string | null; messageId: string | null } | null> {
  const [m] = await sql`
    SELECT mm.id AS message_id, mm.campaign_id, mm.contact_id, mc.email_norm
    FROM mkt_messages mm JOIN mkt_contacts mc ON mc.id = mm.contact_id
    WHERE mm.unsubscribe_token = ${token}`;
  if (m) return { contactId: m.contact_id, emailNorm: m.email_norm, campaignId: m.campaign_id, messageId: m.message_id };
  const [ct] = await sql`SELECT id, email_norm FROM mkt_contacts WHERE unsubscribe_token = ${token}`;
  if (ct) return { contactId: ct.id, emailNorm: ct.email_norm, campaignId: null, messageId: null };
  return null;
}

async function applyUnsub(r: { contactId: string; emailNorm: string | null; campaignId: string | null; messageId: string | null }, ip: string | null, ua: string | null): Promise<void> {
  await sql`UPDATE mkt_contacts SET email_consent = 'unsubscribed', updated_at = now() WHERE id = ${r.contactId}`;
  if (r.emailNorm) {
    await sql`INSERT INTO mkt_suppression (email_norm, reason) VALUES (${r.emailNorm}, 'unsubscribed')
              ON CONFLICT (email_norm) DO NOTHING`;
  }
  if (r.campaignId) await sql`UPDATE mkt_campaigns SET total_unsub = total_unsub + 1 WHERE id = ${r.campaignId}`;
  await sql`INSERT INTO mkt_events (message_id, campaign_id, contact_id, type, ip_trunc, user_agent)
            VALUES (${r.messageId}, ${r.campaignId}, ${r.contactId}, 'unsubscribe', ${ip}, ${ua})`;
}

mktTrack.get('/u/:token', async (c) => {
  const token = c.req.param('token');
  if (!UUID_RE.test(token)) return c.html(unsubPage(false), 404);
  try {
    const r = await resolveUnsubToken(token);
    if (!r) return c.html(unsubPage(false), 404);
    await applyUnsub(r, truncIp(getClientIp(c)), uaTrunc(c));
    return c.html(unsubPage(true));
  } catch (err) {
    log.warn({ err }, 'unsubscribe failed');
    return c.html(unsubPage(false), 500);
  }
});

// One-click unsubscribe POST (List-Unsubscribe-Post / RFC 8058).
mktTrack.post('/u/:token', async (c) => {
  const token = c.req.param('token');
  if (!UUID_RE.test(token)) return c.body(null, 404);
  try {
    const r = await resolveUnsubToken(token);
    if (r) await applyUnsub(r, null, null);
  } catch (err) { log.warn({ err }, 'one-click unsubscribe failed'); }
  return c.body(null, 200);
});

function unsubPage(ok: boolean): string {
  const title = ok ? 'Disiscrizione completata' : 'Link non valido';
  const msg = ok
    ? 'Non riceverai più email marketing da Calicchia Design. Puoi reiscriverti quando vuoi dal nostro sito.'
    : 'Il link di disiscrizione non è valido o è già stato usato.';
  return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<div style="background:#fff;border-radius:12px;padding:40px;max-width:440px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.1)">
<h1 style="font-size:20px;color:#111827;margin:0 0 12px">${title}</h1>
<p style="font-size:14px;color:#6b7280;line-height:1.6;margin:0">${msg}</p>
</div></body></html>`;
}
