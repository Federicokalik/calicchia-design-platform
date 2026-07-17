import { Hono } from 'hono';
import { sql } from '../../db';
import { portalClientAuth, type PortalEnv } from './auth';
import { quoteDisplayTitle, quoteSignUrl } from '../../lib/quotes/format';

export const quotesRoutes = new Hono<PortalEnv>();

// ── List quotes for this customer ─────────────────────────
// Drafts are admin-internal and never exposed; everything from 'sent' onwards
// is visible so the client can find and sign the preventivo from the portal.
// sign_url is the same tokenized OTP sign page linked in the email/WhatsApp
// send — one signing flow, reachable both from the message and from here.
quotesRoutes.get('/', portalClientAuth, async (c) => {
  const customerId = c.get('customer_id') as string;

  const rows = await sql`
    SELECT id, quote_number, title, status, total, currency, valid_until,
           sent_at, viewed_at, signed_at, signer_name, created_at, signature_token
    FROM quotes_v2
    WHERE customer_id = ${customerId} AND status <> 'draft'
    ORDER BY created_at DESC
  ` as Array<Record<string, unknown>>;

  return c.json({
    quotes: rows.map((q) => ({
      id: q.id,
      quote_number: q.quote_number,
      title: quoteDisplayTitle(q.title),
      status: q.status,
      total: Number(q.total || 0),
      currency: (q.currency as string) || 'EUR',
      valid_until: q.valid_until,
      sent_at: q.sent_at,
      viewed_at: q.viewed_at,
      signed_at: q.signed_at,
      signer_name: q.signer_name,
      created_at: q.created_at,
      sign_url: quoteSignUrl(String(q.signature_token)),
    })),
  });
});
