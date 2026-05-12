import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sql, sqlv } from '../../db';
import { zValidator } from '../../lib/z-validator';
import { portalAuth, type PortalEnv } from './auth';
import { stripe, isStripeConfigured } from '../../lib/stripe';
import { createPaypalOrder, isPaypalReady, capturePaypalOrder } from '../../lib/paypal';
import { recordPaymentSuccess } from '../../lib/payment-events';

export const invoicesRoutes = new Hono<PortalEnv>();

// ── List invoices for this customer ──────────────────────
invoicesRoutes.get('/', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;

  const invoices = await sql`
    SELECT id, invoice_number, status, subtotal, tax_amount, total,
           amount_paid, amount_due, currency,
           issue_date, due_date, paid_at, payment_status, line_items, notes,
           stripe_hosted_invoice_url, stripe_invoice_pdf
    FROM invoices
    WHERE customer_id = ${customerId}
    ORDER BY issue_date DESC
  ` as Array<Record<string, unknown>>;

  const [totals] = await sql`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END), 0) AS total_paid,
      COALESCE(SUM(CASE WHEN status = 'open' THEN total ELSE 0 END), 0) AS total_pending
    FROM invoices
    WHERE customer_id = ${customerId}
  ` as Array<{ total_paid: string; total_pending: string }>;

  return c.json({
    invoices,
    totals: {
      total_paid: Number(totals?.total_paid || 0),
      total_pending: Number(totals?.total_pending || 0),
    },
  });
});

// ── Payments (schedules with payment links) ──────────────
// NOTE: deve venire PRIMA di `/:id` per non essere catturato come id.
invoicesRoutes.get('/payments', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const projectId = c.req.query('project_id');

  const projectFilter = projectId ? sql`AND ps.project_id = ${projectId}` : sql``;

  const schedules = await sql`
    SELECT
      ps.id, ps.title, ps.schedule_type, ps.amount, ps.currency,
      ps.due_date, ps.status, ps.paid_amount, ps.paid_at,
      jsonb_build_object('id', cp.id, 'name', cp.name) AS project,
      jsonb_build_object('id', q.id, 'quote_number', q.quote_number, 'title', q.title) AS quote,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', pl.id, 'provider', pl.provider,
            'checkout_url', pl.checkout_url, 'status', pl.status,
            'amount', pl.amount, 'currency', pl.currency
          )
        ) FILTER (WHERE pl.id IS NOT NULL AND pl.status = 'active'),
        '[]'
      ) AS payment_links
    FROM payment_schedules ps
    LEFT JOIN quotes q ON q.id = ps.quote_id
    LEFT JOIN client_projects cp ON cp.id = ps.project_id
    LEFT JOIN payment_links pl ON pl.payment_schedule_id = ps.id
    WHERE ps.status NOT IN ('cancelled')
      AND (
        ps.project_id IN (SELECT id FROM client_projects WHERE customer_id = ${customerId})
        OR ps.quote_id IN (SELECT id FROM quotes WHERE customer_id = ${customerId})
      )
      ${projectFilter}
    GROUP BY ps.id, cp.id, q.id
    ORDER BY ps.due_date ASC NULLS LAST
  ` as Array<Record<string, unknown>>;

  return c.json({ schedules });
});

// ── Subscriptions for this customer ─────────────────────
// Statica → prima di /:id.
invoicesRoutes.get('/subscriptions', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const rows = await sql`
    SELECT id, provider, stripe_subscription_id, paypal_subscription_id,
           name, amount, currency, billing_interval, status,
           start_date, current_period_end, next_billing_date,
           canceled_at, auto_renew
    FROM subscriptions
    WHERE customer_id = ${customerId}
    ORDER BY (status = 'active') DESC, next_billing_date ASC NULLS LAST
  ` as Array<Record<string, unknown>>;
  return c.json({ subscriptions: rows });
});

// ── Pay schedule: create payment_link e ritorna checkout_url ─
// Cliente clicca "Paga" su /clienti/fatture → questa route
// crea il payment_link con provider scelto e ritorna il checkout_url.
// Idempotency: se esiste già un payment_link 'active' per (schedule, provider),
// riusa quello invece di creare un duplicato.
const paySchema = z.object({
  schedule_id: z.string().uuid('schedule_id deve essere un UUID'),
  provider: z.enum(['stripe', 'paypal']),
});

invoicesRoutes.post('/pay', portalAuth, zValidator('json', paySchema), async (c) => {
  const customerId = c.get('customer_id') as string;
  const { schedule_id, provider } = (c.req as any).valid('json') as z.infer<typeof paySchema>;

  // 1. Verifica che lo schedule appartenga a questo customer (via project o quote)
  const [schedule] = await sql`
    SELECT ps.id, ps.amount, ps.currency, ps.title, ps.status, ps.paid_amount,
           COALESCE(q.customer_id, i.customer_id) AS schedule_customer_id
    FROM payment_schedules ps
    LEFT JOIN quotes q ON q.id = ps.quote_id
    LEFT JOIN invoices i ON i.id = ps.invoice_id
    LEFT JOIN client_projects cp ON cp.id = ps.project_id
    WHERE ps.id = ${schedule_id}
      AND (
        COALESCE(q.customer_id, i.customer_id) = ${customerId}
        OR cp.customer_id = ${customerId}
      )
    LIMIT 1
  ` as Array<{
    id: string;
    amount: number;
    currency: string;
    title: string;
    status: string;
    paid_amount: number;
    schedule_customer_id: string | null;
  }>;

  if (!schedule) throw new HTTPException(404, { message: 'Rata non trovata' });
  if (schedule.status === 'paid') {
    throw new HTTPException(400, { message: 'Questa rata è già stata pagata' });
  }
  if (schedule.status === 'cancelled') {
    throw new HTTPException(400, { message: 'Questa rata è stata annullata' });
  }

  // 2. Idempotency: riusa link attivo se esiste già
  const remaining = Number(schedule.amount) - Number(schedule.paid_amount ?? 0);
  const [existingLink] = await sql`
    SELECT id, checkout_url, provider_order_id
    FROM payment_links
    WHERE payment_schedule_id = ${schedule_id}
      AND provider = ${provider}
      AND status = 'active'
      AND checkout_url IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  ` as Array<{ id: string; checkout_url: string; provider_order_id: string | null }>;

  if (existingLink) {
    return c.json({ checkout_url: existingLink.checkout_url, link_id: existingLink.id, reused: true });
  }

  // 3. Crea sul provider — generiamo l'ID del link prima così lo embed nei return URLs
  const portalBase = process.env.PORTAL_RETURN_BASE_URL || 'http://localhost:3000';
  const description = schedule.title || 'Pagamento progetto';

  let checkoutUrl: string;
  let providerOrderId: string;
  let payload: Record<string, unknown>;

  // 3a. Pre-insert link row con placeholder so we know its ID for return URLs
  const [pendingLink] = await sql`
    INSERT INTO payment_links ${sql({
      payment_schedule_id: schedule_id,
      provider,
      provider_order_id: 'PENDING',
      checkout_url: null,
      amount: remaining,
      currency: String(schedule.currency),
      status: 'pending',
      payload_json: sqlv({ type: provider }),
    })}
    RETURNING id
  ` as Array<{ id: string }>;
  const linkId = pendingLink.id;

  const successUrl = `${portalBase}/it/clienti/pagamento/successo?provider=${provider}&linkId=${linkId}`;
  const cancelUrl = `${portalBase}/it/clienti/pagamento/annullato?provider=${provider}&linkId=${linkId}`;

  if (provider === 'stripe') {
    if (!isStripeConfigured()) {
      // Roll back the pending row
      await sql`DELETE FROM payment_links WHERE id = ${linkId}`;
      throw new HTTPException(503, { message: 'Stripe non configurato' });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: String(schedule.currency).toLowerCase(),
            product_data: { name: description },
            unit_amount: Math.round(remaining * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `${successUrl}&stripe_session={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: {
        payment_schedule_id: schedule_id,
        payment_link_id: linkId,
        customer_id: customerId,
        source: 'portal_pay',
      },
    });
    if (!session.url) {
      await sql`DELETE FROM payment_links WHERE id = ${linkId}`;
      throw new HTTPException(500, { message: 'Stripe non ha restituito un checkout URL' });
    }
    checkoutUrl = session.url;
    providerOrderId = session.id;
    payload = { type: 'stripe', session_id: session.id };
  } else {
    if (!(await isPaypalReady())) {
      await sql`DELETE FROM payment_links WHERE id = ${linkId}`;
      throw new HTTPException(503, { message: 'PayPal non configurato' });
    }
    const order = await createPaypalOrder({
      amount: remaining,
      currency: String(schedule.currency),
      description,
      return_url: successUrl,
      cancel_url: cancelUrl,
      reference_id: linkId,
    });
    checkoutUrl = order.checkout_url;
    providerOrderId = order.id;
    payload = { type: 'paypal', order_id: order.id, status: order.status };
  }

  // 3b. Finalizza link row con provider_order_id + checkout_url
  await sql`
    UPDATE payment_links
    SET provider_order_id = ${providerOrderId},
        checkout_url = ${checkoutUrl},
        status = 'active',
        payload_json = ${sqlv(payload)},
        updated_at = NOW()
    WHERE id = ${linkId}
  `;

  return c.json({ checkout_url: checkoutUrl, link_id: linkId, reused: false }, 201);
});

// ── PayPal capture after return URL ──────────────────────
// Cliente torna da PayPal con ?token=ORDER_ID&PayerID=…
// Il portal chiama questa route per chiudere il pagamento sincronamente.
// Idempotente: se webhook è già arrivato (status=paid) → no-op success.
invoicesRoutes.post('/paypal-capture/:linkId', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const linkId = c.req.param('linkId');

  const [link] = await sql`
    SELECT pl.id, pl.provider, pl.provider_order_id, pl.amount, pl.currency, pl.status,
           pl.payment_schedule_id,
           COALESCE(q.customer_id, i.customer_id) AS owner_customer_id
    FROM payment_links pl
    LEFT JOIN payment_schedules ps ON ps.id = pl.payment_schedule_id
    LEFT JOIN quotes q ON q.id = ps.quote_id
    LEFT JOIN invoices i ON i.id = ps.invoice_id
    LEFT JOIN client_projects cp ON cp.id = ps.project_id
    WHERE pl.id = ${linkId}
      AND (
        COALESCE(q.customer_id, i.customer_id) = ${customerId}
        OR cp.customer_id = ${customerId}
      )
    LIMIT 1
  ` as Array<{
    id: string;
    provider: string;
    provider_order_id: string | null;
    amount: number;
    currency: string;
    status: string;
    payment_schedule_id: string | null;
    owner_customer_id: string | null;
  }>;

  if (!link) throw new HTTPException(404, { message: 'Link non trovato' });
  if (link.provider !== 'paypal') {
    throw new HTTPException(400, { message: 'Capture endpoint solo per PayPal' });
  }
  if (link.status === 'paid') {
    return c.json({ captured: true, alreadyProcessed: true });
  }
  if (!link.provider_order_id) {
    throw new HTTPException(400, { message: 'Order ID PayPal mancante' });
  }

  // Try synchronous capture, but tolerate failures if the webhook already
  // processed the order (status flips to 'paid' between request start and the
  // capture call). This avoids spurious 500s when the client lost the race.
  try {
    const captureResult = await capturePaypalOrder(link.provider_order_id);
    const result = await recordPaymentSuccess({
      provider: 'paypal',
      providerOrderId: link.provider_order_id,
      amount: Number(link.amount),
      currency: String(link.currency),
      payerEmail: captureResult.payer_email ?? null,
    });
    return c.json({ captured: true, ...result });
  } catch (err) {
    // Re-read the link — if the webhook already marked it paid we're fine.
    const [fresh] = await sql`
      SELECT status FROM payment_links WHERE id = ${linkId} LIMIT 1
    ` as Array<{ status: string }>;
    if (fresh?.status === 'paid' || fresh?.status === 'refunded' || fresh?.status === 'partially_refunded') {
      return c.json({ captured: true, alreadyProcessed: true, viaWebhook: true });
    }
    console.error('[portal/paypal-capture] capture failed:', (err as Error).message);
    throw new HTTPException(502, {
      message: 'Cattura PayPal non riuscita. Riprova fra qualche secondo.',
    });
  }
});

// ── GET single invoice ───────────────────────────────────
// Catch-all dinamico — DEVE essere l'ultima route per non catturare static paths.
invoicesRoutes.get('/:id', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const id = c.req.param('id');

  const [invoice] = await sql`
    SELECT id, customer_id, invoice_number, status, subtotal, tax_rate, tax_amount, total,
           amount_paid, amount_due, currency, issue_date, due_date, paid_at,
           payment_status, line_items, notes,
           stripe_hosted_invoice_url, stripe_invoice_pdf
    FROM invoices
    WHERE id = ${id} AND customer_id = ${customerId}
    LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!invoice) throw new HTTPException(404, { message: 'Fattura non trovata' });

  return c.json({ invoice });
});
