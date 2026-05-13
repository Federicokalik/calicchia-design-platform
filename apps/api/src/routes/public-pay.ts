import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sql, sqlv } from '../db';
import { zValidator } from '../lib/z-validator';
import { stripe, isStripeConfigured } from '../lib/stripe';
import { createPaypalOrderEmbedded, isPaypalReady, capturePaypalOrder } from '../lib/paypal';
import { recordPaymentSuccess } from '../lib/payment-events';

export const publicPay = new Hono();

/**
 * Public payment link endpoints.
 *
 * Access model: the link UUID itself is the capability — same security
 * properties as a Stripe Checkout Session ID (unguessable v4 UUID, ~122 bits).
 * No portal cookie required: any party who has the URL can pay.
 *
 * Endpoints:
 *  - GET  /:id           → safe metadata for the public pay page UI
 *  - POST /:id/checkout  → mints client_secret (Stripe) / order_id (PayPal)
 *                          / returns bank_details (bonifico) for embedded UI
 *  - POST /:id/capture   → finalize PayPal payment after user approves
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const linkIdSchema = z.object({ id: z.string().uuid() });

interface LinkRow {
  id: string;
  provider: 'stripe' | 'paypal' | 'bank_transfer' | 'revolut';
  provider_order_id: string | null;
  amount: number;
  currency: string;
  status: string;
  expires_at: string | null;
  payload_json: Record<string, unknown> | null;
  payment_schedule_id: string | null;
  invoice_id: string | null;
  quote_id: string | null;
}

async function loadLink(id: string): Promise<LinkRow> {
  const [link] = await sql`
    SELECT id, provider, provider_order_id, amount, currency, status,
           expires_at, payload_json, payment_schedule_id, invoice_id, quote_id
    FROM payment_links
    WHERE id = ${id}
    LIMIT 1
  ` as LinkRow[];

  if (!link) throw new HTTPException(404, { message: 'Link non trovato' });
  if (link.status === 'cancelled') {
    throw new HTTPException(410, { message: 'Questo link è stato annullato' });
  }
  if (link.status === 'expired') {
    throw new HTTPException(410, { message: 'Questo link è scaduto' });
  }
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    throw new HTTPException(410, { message: 'Questo link è scaduto' });
  }
  return link;
}

// ── GET /api/public-pay/:id ────────────────────────────────
// Safe public metadata — never exposes secrets / customer data.
publicPay.get('/:id', zValidator('param', linkIdSchema), async (c) => {
  const { id } = (c.req as any).valid('param') as z.infer<typeof linkIdSchema>;
  const link = await loadLink(id);

  // Optional descriptive context — title from schedule / invoice / quote.
  let description: string | null = null;
  let projectName: string | null = null;
  if (link.payment_schedule_id) {
    const [row] = await sql`
      SELECT ps.title, cp.name AS project_name
      FROM payment_schedules ps
      LEFT JOIN client_projects cp ON cp.id = ps.project_id
      WHERE ps.id = ${link.payment_schedule_id}
      LIMIT 1
    ` as Array<{ title: string | null; project_name: string | null }>;
    description = row?.title ?? null;
    projectName = row?.project_name ?? null;
  } else if (link.invoice_id) {
    const [row] = await sql`
      SELECT invoice_number FROM invoices WHERE id = ${link.invoice_id} LIMIT 1
    ` as Array<{ invoice_number: string | null }>;
    description = row?.invoice_number ? `Fattura ${row.invoice_number}` : null;
  } else if (link.quote_id) {
    const [row] = await sql`
      SELECT quote_number, title FROM quotes WHERE id = ${link.quote_id} LIMIT 1
    ` as Array<{ quote_number: string | null; title: string | null }>;
    description = row?.title ?? (row?.quote_number ? `Preventivo ${row.quote_number}` : null);
  }

  return c.json({
    id: link.id,
    provider: link.provider,
    amount: Number(link.amount),
    currency: link.currency,
    status: link.status,
    expires_at: link.expires_at,
    description,
    project_name: projectName,
  });
});

// ── POST /api/public-pay/:id/checkout ──────────────────────
// Returns the embedded checkout payload for the browser SDK.
publicPay.post('/:id/checkout', zValidator('param', linkIdSchema), async (c) => {
  const { id } = (c.req as any).valid('param') as z.infer<typeof linkIdSchema>;
  const link = await loadLink(id);

  if (link.status === 'paid' || link.status === 'refunded' || link.status === 'partially_refunded') {
    throw new HTTPException(400, { message: 'Link già pagato' });
  }

  const amount = Number(link.amount);
  const currency = String(link.currency);
  const payload = isRecord(link.payload_json) ? link.payload_json : {};
  const description = typeof payload.description === 'string' && payload.description.length > 0
    ? payload.description
    : `Pagamento ${amount.toFixed(2)} ${currency}`;

  // ── Bonifico: payload already in DB, just return it ────
  if (link.provider === 'bank_transfer') {
    return c.json({
      provider: 'bank_transfer',
      link_id: link.id,
      bank_details: {
        iban: String(payload.iban ?? ''),
        bic: String(payload.bic ?? ''),
        holder_name: String(payload.holder_name ?? ''),
        causal: String(payload.causal ?? ''),
        amount,
        currency,
      },
    });
  }

  // ── Stripe: reuse client_secret if cached, else create new session ──
  if (link.provider === 'stripe') {
    if (!isStripeConfigured()) {
      throw new HTTPException(503, { message: 'Stripe non configurato' });
    }
    const cachedSecret = payload.client_secret;
    if (typeof cachedSecret === 'string' && cachedSecret.length > 0) {
      return c.json({
        provider: 'stripe',
        link_id: link.id,
        client_secret: cachedSecret,
        reused: true,
      });
    }

    const portalBase = process.env.PORTAL_RETURN_BASE_URL || 'http://localhost:3000';
    const returnUrl = `${portalBase}/it/pay/${link.id}/successo?stripe_session={CHECKOUT_SESSION_ID}`;

    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: { name: description },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      return_url: returnUrl,
      metadata: {
        payment_link_id: link.id,
        payment_schedule_id: link.payment_schedule_id ?? '',
        source: 'public_pay_embedded',
      },
    });

    if (!session.client_secret) {
      throw new HTTPException(500, { message: 'Stripe non ha restituito un client_secret' });
    }

    await sql`
      UPDATE payment_links
      SET provider_order_id = ${session.id},
          status = 'active',
          payload_json = payload_json || ${JSON.stringify({
            session_id: session.id,
            client_secret: session.client_secret,
          })}::jsonb,
          updated_at = NOW()
      WHERE id = ${link.id}
    `;

    return c.json({
      provider: 'stripe',
      link_id: link.id,
      client_secret: session.client_secret,
      reused: false,
    });
  }

  // ── PayPal: reuse order_id if active, else create new ──
  if (link.provider === 'paypal') {
    if (!(await isPaypalReady())) {
      throw new HTTPException(503, { message: 'PayPal non configurato' });
    }
    if (link.provider_order_id && link.provider_order_id !== 'PENDING') {
      return c.json({
        provider: 'paypal',
        link_id: link.id,
        order_id: link.provider_order_id,
        reused: true,
      });
    }

    const order = await createPaypalOrderEmbedded({
      amount,
      currency,
      description,
      reference_id: link.id,
    });

    await sql`
      UPDATE payment_links
      SET provider_order_id = ${order.id},
          status = 'active',
          payload_json = payload_json || ${JSON.stringify({
            order_id: order.id,
            status: order.status,
          })}::jsonb,
          updated_at = NOW()
      WHERE id = ${link.id}
    `;

    return c.json({
      provider: 'paypal',
      link_id: link.id,
      order_id: order.id,
      reused: false,
    });
  }

  throw new HTTPException(400, { message: `Provider ${link.provider} non supportato per checkout pubblico` });
});

// ── POST /api/public-pay/:id/capture (PayPal only) ────────
// Finalize after PayPal Buttons / Card Fields completes the user approval.
// Idempotent: if webhook already flipped status to 'paid', returns success.
publicPay.post('/:id/capture', zValidator('param', linkIdSchema), async (c) => {
  const { id } = (c.req as any).valid('param') as z.infer<typeof linkIdSchema>;
  const link = await loadLink(id);

  if (link.provider !== 'paypal') {
    throw new HTTPException(400, { message: 'Capture solo per PayPal' });
  }
  if (link.status === 'paid' || link.status === 'refunded' || link.status === 'partially_refunded') {
    return c.json({ captured: true, alreadyProcessed: true });
  }
  if (!link.provider_order_id || link.provider_order_id === 'PENDING') {
    throw new HTTPException(400, { message: 'PayPal order id mancante' });
  }

  try {
    const capture = await capturePaypalOrder(link.provider_order_id);
    if (capture.capture_id) {
      await sql`
        UPDATE payment_links
        SET payload_json = payload_json || ${JSON.stringify({ capture_id: capture.capture_id })}::jsonb,
            updated_at = NOW()
        WHERE id = ${link.id}
      `;
    }
    const result = await recordPaymentSuccess({
      provider: 'paypal',
      providerOrderId: link.provider_order_id,
      amount: capture.amount ?? Number(link.amount),
      currency: capture.currency ?? String(link.currency),
      payerEmail: capture.payer_email ?? null,
    });
    return c.json({ captured: true, ...result });
  } catch (err) {
    // Webhook race: re-check status
    const [fresh] = await sql`
      SELECT status FROM payment_links WHERE id = ${id} LIMIT 1
    ` as Array<{ status: string }>;
    if (fresh?.status === 'paid' || fresh?.status === 'refunded' || fresh?.status === 'partially_refunded') {
      return c.json({ captured: true, alreadyProcessed: true, viaWebhook: true });
    }
    console.error('[public-pay/capture] error:', (err as Error).message);
    throw new HTTPException(502, { message: 'Cattura PayPal non riuscita. Riprova fra qualche secondo.' });
  }
});
