import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sql, sqlv } from '../db';
import { stripe, isStripeConfigured, createStripeRefund } from '../lib/stripe';
import { createPaypalOrder, capturePaypalOrder, getPaypalOrder, isPaypalConfigured, isPaypalReady, refundPaypalCapture } from '../lib/paypal';
import { createRevolutOrder, getRevolutOrder, cancelRevolutOrder, isRevolutConfigured, isRevolutReady } from '../lib/revolut';
import { zValidator } from '../lib/z-validator';
import { recordPaymentSuccess, recordRefund } from '../lib/payment-events';
import { generateReceiptForPaymentLink } from '../lib/receipt-pdf';
import { maskPII } from '../lib/webhook-sanitize';

export const payments = new Hono();

const SCHEDULE_TYPES = new Set(['deposit', 'milestone', 'balance', 'installment']);
const SCHEDULE_STATUSES = new Set(['pending', 'due', 'paid', 'partial', 'overdue', 'cancelled']);
const LINK_PROVIDERS = new Set(['bank_transfer', 'paypal', 'revolut', 'stripe']);

const idParamSchema = z.object({ id: z.string().uuid() });
const createPaymentLinkSchema = z.object({
  provider: z.enum(['bank_transfer', 'paypal', 'revolut', 'stripe']),
  amount: z.number().positive(),
  currency: z.string().length(3).default('EUR'),
  description: z.string().optional(),
  quote_id: z.string().uuid().optional().nullable(),
  invoice_id: z.string().uuid().optional().nullable(),
  payment_schedule_id: z.string().uuid().optional().nullable(),
  return_base_url: z.string().url().optional(),
  expires_in_days: z.number().int().positive().optional(),
  causal: z.string().optional(),
});
const refundSchema = z.object({
  amount: z.number().positive().optional(),
  reason: z.string().optional(),
});

type ScheduleRow = {
  id: string;
  status: string;
  amount: number;
  paid_amount: number;
};

type LinkRow = {
  id: string;
  status: string;
};

type QuoteRow = {
  id: string;
  accepted_at: string | null;
  currency: string;
  payment_plan: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// =====================================================
// PAYMENT SCHEDULES
// =====================================================

payments.get('/schedules', async (c) => {
  const quoteId = c.req.query('quote_id');
  const invoiceId = c.req.query('invoice_id');
  const projectId = c.req.query('project_id');
  const status = c.req.query('status');
  const overdue = c.req.query('overdue');

  const quoteFilter = quoteId ? sql`AND ps.quote_id = ${quoteId}` : sql``;
  const invoiceFilter = invoiceId ? sql`AND ps.invoice_id = ${invoiceId}` : sql``;
  const projectFilter = projectId ? sql`AND ps.project_id = ${projectId}` : sql``;
  const statusFilter = status && status !== 'all' ? sql`AND ps.status = ${status}` : sql``;
  const overdueFilter = overdue === 'true'
    ? sql`AND ps.due_date < CURRENT_DATE AND ps.status NOT IN ('paid', 'cancelled')`
    : sql``;

  const rows = await sql`
    SELECT
      ps.*,
      jsonb_build_object(
        'id', q.id, 'quote_number', q.quote_number, 'title', q.title
      ) AS quote,
      jsonb_build_object(
        'id', i.id, 'invoice_number', i.invoice_number
      ) AS invoice,
      jsonb_build_object(
        'id', cp.id, 'name', cp.name
      ) AS project,
      jsonb_build_object(
        'id', cu.id,
        'company_name', cu.company_name,
        'contact_name', cu.contact_name
      ) AS customer
    FROM payment_schedules ps
    LEFT JOIN quotes q ON q.id = ps.quote_id
    LEFT JOIN invoices i ON i.id = ps.invoice_id
    LEFT JOIN client_projects cp ON cp.id = ps.project_id
    LEFT JOIN customers cu ON cu.id = COALESCE(q.customer_id, i.customer_id)
    WHERE 1=1
      ${quoteFilter}
      ${invoiceFilter}
      ${projectFilter}
      ${statusFilter}
      ${overdueFilter}
    ORDER BY ps.due_date ASC NULLS LAST, ps.sort_order ASC
  ` as Array<Record<string, unknown>>;

  const stats = {
    total: rows.length,
    pending: rows.filter((r) => ['pending', 'due'].includes(String(r.status ?? ''))).length,
    overdue: rows.filter((r) => r.status === 'overdue').length,
    paid: rows.filter((r) => r.status === 'paid').length,
    total_amount: rows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    paid_amount: rows.reduce((s, r) => s + Number(r.paid_amount ?? 0), 0),
    pending_amount: rows
      .filter((r) => !['paid', 'cancelled'].includes(String(r.status ?? '')))
      .reduce((s, r) => s + Number(r.amount ?? 0) - Number(r.paid_amount ?? 0), 0),
  };

  return c.json({ schedules: rows, stats });
});

// NOTE: static /schedules/from-quote/:id must be declared before dynamic /schedules/:id
payments.post('/schedules/from-quote/:quoteId', async (c) => {
  const quoteId = c.req.param('quoteId');

  const [quote] = await sql`
    SELECT id, accepted_at, currency, payment_plan
    FROM quotes
    WHERE id = ${quoteId}
    LIMIT 1
  ` as QuoteRow[];

  if (!quote) return c.json({ error: 'Preventivo non trovato' }, 404);

  const existing = await sql`
    SELECT id FROM payment_schedules WHERE quote_id = ${quoteId} LIMIT 1
  ` as Array<{ id: string }>;

  if (existing.length > 0) {
    return c.json({
      error: 'Piano pagamenti già generato per questo preventivo',
      existing: true,
    }, 409);
  }

  const paymentPlan = isRecord(quote.payment_plan) ? quote.payment_plan : {};
  const items = Array.isArray(paymentPlan.items)
    ? paymentPlan.items as Array<Record<string, unknown>>
    : [];
  const currency = String(
    (paymentPlan.currency as string | undefined) ?? quote.currency ?? 'EUR',
  );

  if (items.length === 0) {
    return c.json({ error: 'Il preventivo non ha rate nel piano pagamenti' }, 400);
  }

  const acceptedDate = quote.accepted_at ? new Date(quote.accepted_at) : new Date();
  const created: Array<Record<string, unknown>> = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const dueDays = Number(item.due_days_from_acceptance ?? 0);
    const dueDate = new Date(acceptedDate);
    dueDate.setDate(dueDate.getDate() + dueDays);

    const insertData: Record<string, unknown> = {
      quote_id: quoteId,
      schedule_type: String(item.type ?? 'installment'),
      title: String(item.title ?? `Rata ${i + 1}`),
      amount: Number(item.amount ?? 0),
      currency,
      due_date: dueDate.toISOString().split('T')[0],
      due_days_from_acceptance: dueDays,
      status: 'pending',
      paid_amount: 0,
      sort_order: Number(item.sort_order ?? i),
    };

    const [row] = await sql`
      INSERT INTO payment_schedules ${sql(insertData)}
      RETURNING *
    ` as Array<Record<string, unknown>>;

    created.push(row);
  }

  return c.json({ schedules: created, count: created.length }, 201);
});

payments.get('/schedules/:id', async (c) => {
  const id = c.req.param('id');

  const [row] = await sql`
    SELECT
      ps.*,
      jsonb_build_object(
        'id', q.id, 'quote_number', q.quote_number, 'title', q.title
      ) AS quote,
      jsonb_build_object(
        'id', i.id, 'invoice_number', i.invoice_number
      ) AS invoice,
      jsonb_build_object(
        'id', cp.id, 'name', cp.name
      ) AS project,
      COALESCE(
        jsonb_agg(pl.*) FILTER (WHERE pl.id IS NOT NULL),
        '[]'
      ) AS payment_links
    FROM payment_schedules ps
    LEFT JOIN quotes q ON q.id = ps.quote_id
    LEFT JOIN invoices i ON i.id = ps.invoice_id
    LEFT JOIN client_projects cp ON cp.id = ps.project_id
    LEFT JOIN payment_links pl ON pl.payment_schedule_id = ps.id
    WHERE ps.id = ${id}
    GROUP BY ps.id, q.id, i.id, cp.id
  ` as Array<Record<string, unknown>>;

  if (!row) return c.json({ error: 'Piano pagamento non trovato' }, 404);
  return c.json({ schedule: row });
});

payments.post('/schedules', async (c) => {
  const body = await c.req.json() as Record<string, unknown>;

  const scheduleType = String(body.schedule_type ?? 'installment');
  if (!SCHEDULE_TYPES.has(scheduleType)) {
    return c.json({
      error: `schedule_type non valido. Validi: ${[...SCHEDULE_TYPES].join(', ')}`,
    }, 400);
  }

  const amount = Number(body.amount ?? 0);
  if (!Number.isFinite(amount) || amount < 0) {
    return c.json({ error: 'amount deve essere >= 0' }, 400);
  }

  const insertData: Record<string, unknown> = {
    quote_id: body.quote_id ?? null,
    invoice_id: body.invoice_id ?? null,
    project_id: body.project_id ?? null,
    schedule_type: scheduleType,
    title: String(body.title ?? ''),
    amount,
    currency: String(body.currency ?? 'EUR'),
    due_date: body.due_date ?? null,
    due_days_from_acceptance: body.due_days_from_acceptance != null
      ? Number(body.due_days_from_acceptance)
      : null,
    status: 'pending',
    paid_amount: 0,
    sort_order: Number(body.sort_order ?? 0),
    notes: body.notes ?? null,
  };

  const [row] = await sql`
    INSERT INTO payment_schedules ${sql(insertData)}
    RETURNING *
  ` as Array<Record<string, unknown>>;

  return c.json({ schedule: row }, 201);
});

payments.patch('/schedules/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;

  const [existing] = await sql`
    SELECT id, status, amount FROM payment_schedules WHERE id = ${id} LIMIT 1
  ` as ScheduleRow[];

  if (!existing) return c.json({ error: 'Piano pagamento non trovato' }, 404);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.status !== undefined) {
    const newStatus = String(body.status);
    if (!SCHEDULE_STATUSES.has(newStatus)) {
      return c.json({
        error: `Stato non valido. Validi: ${[...SCHEDULE_STATUSES].join(', ')}`,
      }, 400);
    }
    updates.status = newStatus;
    if (newStatus === 'paid' && updates.paid_at === undefined) {
      updates.paid_at = new Date().toISOString();
      updates.paid_amount = existing.amount;
    }
  }

  if (body.paid_amount !== undefined) {
    const paidAmount = Number(body.paid_amount);
    if (!Number.isFinite(paidAmount) || paidAmount < 0) {
      return c.json({ error: 'paid_amount non valido' }, 400);
    }
    updates.paid_amount = paidAmount;
    if (paidAmount >= Number(existing.amount)) {
      updates.status = 'paid';
      if (updates.paid_at === undefined) updates.paid_at = new Date().toISOString();
    } else if (paidAmount > 0) {
      updates.status = 'partial';
    }
  }

  if (body.due_date !== undefined) updates.due_date = body.due_date ?? null;
  if (body.notes !== undefined) updates.notes = body.notes ?? null;
  if (body.title !== undefined) updates.title = String(body.title);

  const [row] = await sql`
    UPDATE payment_schedules SET ${sql(updates)} WHERE id = ${id} RETURNING *
  ` as Array<Record<string, unknown>>;

  return c.json({ schedule: row });
});

payments.delete('/schedules/:id', async (c) => {
  const id = c.req.param('id');

  const [existing] = await sql`
    SELECT status FROM payment_schedules WHERE id = ${id} LIMIT 1
  ` as Array<{ status: string }>;

  if (!existing) return c.json({ error: 'Non trovato' }, 404);
  if (existing.status !== 'pending') {
    return c.json({ error: 'Solo piani in stato pending possono essere eliminati' }, 400);
  }

  await sql`DELETE FROM payment_schedules WHERE id = ${id}`;
  return c.json({ success: true });
});

// =====================================================
// PAYMENT LINKS
// =====================================================

payments.get('/links', async (c) => {
  const scheduleId = c.req.query('schedule_id');
  const quoteId = c.req.query('quote_id');
  const invoiceId = c.req.query('invoice_id');
  const provider = c.req.query('provider');
  const status = c.req.query('status');

  const scheduleFilter = scheduleId ? sql`AND pl.payment_schedule_id = ${scheduleId}` : sql``;
  const quoteFilter = quoteId ? sql`AND pl.quote_id = ${quoteId}` : sql``;
  const invoiceFilter = invoiceId ? sql`AND pl.invoice_id = ${invoiceId}` : sql``;
  const providerFilter = provider ? sql`AND pl.provider = ${provider}` : sql``;
  const statusFilter = status && status !== 'all' ? sql`AND pl.status = ${status}` : sql``;

  const rows = await sql`
    SELECT pl.*
    FROM payment_links pl
    WHERE 1=1
      ${scheduleFilter}
      ${quoteFilter}
      ${invoiceFilter}
      ${providerFilter}
      ${statusFilter}
    ORDER BY pl.created_at DESC
  ` as Array<Record<string, unknown>>;

  return c.json({ links: rows });
});

// GET available providers (for UI)
payments.get('/providers', async (c) => {
  const [settingsRow] = await sql`
    SELECT value FROM site_settings WHERE key = 'payments.providers' LIMIT 1
  ` as Array<{ value: unknown }>;

  const providers = isRecord(settingsRow?.value) ? settingsRow.value : {};

  const paypalObj = isRecord(providers.paypal) ? providers.paypal : {};
  const revolutObj = isRecord(providers.revolut) ? providers.revolut : {};
  const stripeObj = isRecord(providers.stripe) ? providers.stripe : {};

  // Check if APIs are configured (env or DB keys)
  const paypalReady = isPaypalConfigured() || !!(paypalObj.client_id && paypalObj.client_secret);
  const revolutReady = isRevolutConfigured() || !!revolutObj.api_key;
  const stripeReady = isStripeConfigured() || !!stripeObj.secret_key;

  return c.json({
    providers: {
      stripe: {
        enabled: stripeReady && Boolean(stripeObj.enabled),
        configured: stripeReady,
        label: 'Stripe',
      },
      paypal: {
        enabled: paypalReady && Boolean(paypalObj.enabled),
        configured: paypalReady,
        label: 'PayPal',
      },
      revolut: {
        enabled: revolutReady && Boolean(revolutObj.enabled),
        configured: revolutReady,
        label: 'Revolut',
      },
      bank_transfer: {
        enabled: Boolean(providers.allow_bank_transfer),
        configured: true,
        label: 'Bonifico Bancario',
      },
    },
  });
});

payments.post('/links', zValidator('json', createPaymentLinkSchema), async (c) => {
  const body = (c.req as any).valid('json') as z.infer<typeof createPaymentLinkSchema>;

  const provider = String(body.provider ?? '');
  if (!LINK_PROVIDERS.has(provider)) {
    return c.json({
      error: `Provider non supportato. Validi: ${[...LINK_PROVIDERS].join(', ')}`,
    }, 400);
  }

  const amount = Number(body.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: 'amount deve essere > 0' }, 400);
  }

  const currency = String(body.currency ?? 'EUR');
  // `description` può arrivare come '' dal form admin se il campo è vuoto.
  // `??` non scatta su stringa vuota → trim+|| per fallback sensato.
  const description = String(body.description ?? '').trim()
    || `Pagamento ${amount.toFixed(2)} ${currency}`;
  let checkoutUrl: string | null = null;
  let providerOrderId: string | null = null;
  let linkPayload: Record<string, unknown> = {};

  // ── Bank Transfer (no external API) ────────────────────
  if (provider === 'bank_transfer') {
    const [settingsRow] = await sql`
      SELECT value FROM site_settings WHERE key = 'billing.bank_accounts' LIMIT 1
    ` as Array<{ value: unknown }>;

    const settingsValue = isRecord(settingsRow?.value) ? settingsRow.value : {};
    const accounts = Array.isArray(settingsValue.accounts)
      ? settingsValue.accounts as Array<Record<string, unknown>>
      : [];
    const defaultAccount = accounts.find((a) => Boolean(a.is_default)) ?? accounts[0];

    linkPayload = {
      type: 'bank_transfer',
      iban: String(defaultAccount?.iban ?? ''),
      bic: String(defaultAccount?.bic ?? ''),
      holder_name: String(defaultAccount?.holder_name ?? ''),
      causal: String(body.causal ?? defaultAccount?.default_causal ?? ''),
      amount,
      currency,
    };

    const insertData: Record<string, unknown> = {
      quote_id: body.quote_id ?? null,
      invoice_id: body.invoice_id ?? null,
      payment_schedule_id: body.payment_schedule_id ?? null,
      provider,
      checkout_url: null,
      amount,
      currency,
      status: 'active',
      payload_json: sqlv(linkPayload),
    };

    const [row] = await sql`
      INSERT INTO payment_links ${sql(insertData)}
      RETURNING *
    ` as Array<Record<string, unknown>>;

    return c.json({ link: row, bank_details: linkPayload }, 201);
  }

  // Base URL for return/cancel (portal or admin)
  const returnBaseUrl = String(body.return_base_url || process.env.ADMIN_URL || 'http://localhost:5173');

  // ── Stripe Checkout Session ────────────────────────────
  if (provider === 'stripe') {
    if (!isStripeConfigured()) {
      return c.json({ error: 'Stripe non configurato. Aggiungi STRIPE_SECRET_KEY.' }, 400);
    }

    const session = await stripe.checkout.sessions.create({
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
      success_url: `${returnBaseUrl}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnBaseUrl}?stripe=cancelled`,
      metadata: {
        payment_schedule_id: String(body.payment_schedule_id ?? ''),
        source: 'payment_link',
      },
    });

    checkoutUrl = session.url;
    providerOrderId = session.id;
    linkPayload = { type: 'stripe', session_id: session.id };
  }

  // ── PayPal Orders API ──────────────────────────────────
  if (provider === 'paypal') {
    if (!(await isPaypalReady())) {
      return c.json({ error: 'PayPal non configurato. Aggiungi le credenziali API nelle impostazioni.' }, 400);
    }

    const order = await createPaypalOrder({
      amount,
      currency,
      description,
      return_url: process.env.PAYPAL_RETURN_URL || `${returnBaseUrl}?paypal=success`,
      cancel_url: process.env.PAYPAL_CANCEL_URL || `${returnBaseUrl}?paypal=cancelled`,
      reference_id: String(body.payment_schedule_id ?? ''),
    });

    checkoutUrl = order.checkout_url;
    providerOrderId = order.id;
    linkPayload = { type: 'paypal', order_id: order.id, status: order.status };
  }

  // ── Revolut Merchant API ───────────────────────────────
  if (provider === 'revolut') {
    if (!(await isRevolutReady())) {
      return c.json({ error: 'Revolut non configurato. Aggiungi la API key nelle impostazioni.' }, 400);
    }

    // Fetch customer email if available
    let customerEmail: string | undefined;
    if (body.payment_schedule_id) {
      const [schedule] = await sql`
        SELECT cu.email
        FROM payment_schedules ps
        LEFT JOIN quotes q ON q.id = ps.quote_id
        LEFT JOIN invoices i ON i.id = ps.invoice_id
        LEFT JOIN customers cu ON cu.id = COALESCE(q.customer_id, i.customer_id)
        WHERE ps.id = ${String(body.payment_schedule_id)}
        LIMIT 1
      ` as Array<{ email?: string }>;
      customerEmail = schedule?.email || undefined;
    }

    const order = await createRevolutOrder({
      amount,
      currency,
      description,
      merchant_order_ext_ref: String(body.payment_schedule_id ?? ''),
      customer_email: customerEmail,
    });

    checkoutUrl = order.checkout_url;
    providerOrderId = order.id;
    linkPayload = { type: 'revolut', order_id: order.id, state: order.state };
  }

  const expiresAt = body.expires_in_days
    ? new Date(Date.now() + Number(body.expires_in_days) * 86_400_000).toISOString()
    : null;

  const insertData: Record<string, unknown> = {
    quote_id: body.quote_id ?? null,
    invoice_id: body.invoice_id ?? null,
    payment_schedule_id: body.payment_schedule_id ?? null,
    provider,
    provider_order_id: providerOrderId,
    checkout_url: checkoutUrl,
    amount,
    currency,
    status: 'active',
    expires_at: expiresAt,
    payload_json: sqlv(linkPayload),
  };

  const [row] = await sql`
    INSERT INTO payment_links ${sql(insertData)}
    RETURNING *
  ` as Array<Record<string, unknown>>;

  return c.json({ link: row }, 201);
});

payments.post('/links/:id/capture', zValidator('param', idParamSchema), async (c) => {
  const { id } = (c.req as any).valid('param') as z.infer<typeof idParamSchema>;

  const [link] = await sql`
    SELECT * FROM payment_links WHERE id = ${id} LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!link) throw new HTTPException(404, { message: 'Link non trovato' });
  if (link.provider !== 'paypal') {
    throw new HTTPException(400, { message: 'Capture disponibile solo per PayPal' });
  }
  if (link.status === 'paid' || link.status === 'refunded' || link.status === 'partially_refunded') {
    return c.json({ link, alreadyProcessed: true });
  }

  const orderId = String(link.provider_order_id ?? '');
  if (!orderId) throw new HTTPException(400, { message: 'PayPal order id mancante' });

  const capture = await capturePaypalOrder(orderId);
  if (capture.capture_id) {
    await sql`
      UPDATE payment_links
      SET payload_json = payload_json || ${JSON.stringify({ capture_id: capture.capture_id })}::jsonb,
          updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  const result = await recordPaymentSuccess({
    provider: 'paypal',
    providerOrderId: orderId,
    amount: capture.amount ?? Number(link.amount),
    currency: capture.currency ?? String(link.currency ?? 'EUR'),
    payerEmail: capture.payer_email ?? null,
  });

  const [updated] = await sql`
    SELECT * FROM payment_links WHERE id = ${id} LIMIT 1
  ` as Array<Record<string, unknown>>;

  return c.json({ link: updated, capture, result });
});

payments.post(
  '/links/:id/refund',
  zValidator('param', idParamSchema),
  zValidator('json', refundSchema),
  async (c) => {
    const { id } = (c.req as any).valid('param') as z.infer<typeof idParamSchema>;
    const body = (c.req as any).valid('json') as z.infer<typeof refundSchema>;

    const [link] = await sql`
      SELECT * FROM payment_links WHERE id = ${id} LIMIT 1
    ` as Array<Record<string, unknown>>;

    if (!link) throw new HTTPException(404, { message: 'Link non trovato' });
    if (!['paid', 'partially_refunded'].includes(String(link.status))) {
      throw new HTTPException(400, { message: 'Puoi rimborsare solo link pagati' });
    }

    const alreadyRefunded = Number(link.refunded_amount ?? 0);
    const linkAmount = Number(link.amount);
    const amount = body.amount ?? (linkAmount - alreadyRefunded);
    if (amount <= 0 || alreadyRefunded + amount > linkAmount) {
      throw new HTTPException(400, { message: 'Importo rimborso non valido' });
    }

    const provider = String(link.provider);
    let providerRefundId: string;

    if (provider === 'stripe') {
      if (!isStripeConfigured()) throw new HTTPException(503, { message: 'Stripe non configurato' });
      const providerOrderId = String(link.provider_order_id ?? '');
      const payload = isRecord(link.payload_json) ? link.payload_json : {};
      let paymentIntentId = String(payload.payment_intent_id ?? '');
      let chargeId = String(payload.charge_id ?? '');

      if (!paymentIntentId && providerOrderId.startsWith('cs_')) {
        const session = await stripe.checkout.sessions.retrieve(providerOrderId);
        paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : '';
      } else if (!paymentIntentId && providerOrderId.startsWith('pi_')) {
        paymentIntentId = providerOrderId;
      } else if (!chargeId && providerOrderId.startsWith('ch_')) {
        chargeId = providerOrderId;
      }

      if (!paymentIntentId && !chargeId) {
        throw new HTTPException(400, { message: 'PaymentIntent Stripe non trovato per questo link' });
      }

      const refund = await createStripeRefund({
        paymentIntentId: paymentIntentId || undefined,
        chargeId: chargeId || undefined,
        amount,
        reason: 'requested_by_customer',
        metadata: { payment_link_id: id },
      });
      providerRefundId = refund.id;
    } else if (provider === 'paypal') {
      const payload = isRecord(link.payload_json) ? link.payload_json : {};
      const captureId = String(payload.capture_id ?? '');
      if (!captureId) throw new HTTPException(400, { message: 'PayPal capture_id mancante' });
      const refund = await refundPaypalCapture(captureId, amount, String(link.currency ?? 'EUR'));
      providerRefundId = refund.id;
    } else {
      throw new HTTPException(400, { message: `Refund non supportato per provider ${provider}` });
    }

    const refundResult = await recordRefund({
      paymentLinkId: id,
      amount,
      currency: String(link.currency ?? 'EUR'),
      providerRefundId,
      reason: body.reason ?? null,
      refundedBy: ((c as any).get('user') as { id?: string } | undefined)?.id ?? null,
    });

    const [updated] = await sql`
      SELECT * FROM payment_links WHERE id = ${id} LIMIT 1
    ` as Array<Record<string, unknown>>;

    return c.json({ link: updated, refund: refundResult, provider_refund_id: providerRefundId });
  },
);

payments.post('/links/:id/receipt', zValidator('param', idParamSchema), async (c) => {
  const { id } = (c.req as any).valid('param') as z.infer<typeof idParamSchema>;
  const receipt = await generateReceiptForPaymentLink({ paymentLinkId: id });
  return c.json({ receipt });
});

// Check / refresh link status from provider
payments.post('/links/:id/refresh', async (c) => {
  const id = c.req.param('id');

  const [link] = await sql`
    SELECT * FROM payment_links WHERE id = ${id} LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!link) return c.json({ error: 'Link non trovato' }, 404);

  const provider = String(link.provider);
  const providerOrderId = String(link.provider_order_id ?? '');
  let newStatus = String(link.status);
  let payload = isRecord(link.payload_json) ? link.payload_json : {};

  if (provider === 'stripe' && providerOrderId && isStripeConfigured()) {
    const session = await stripe.checkout.sessions.retrieve(providerOrderId);
    if (session.payment_status === 'paid') {
      newStatus = 'paid';
    } else if (session.status === 'expired') {
      newStatus = 'expired';
    }
    payload = { ...payload, stripe_status: session.status, payment_status: session.payment_status };
  }

  if (provider === 'paypal' && providerOrderId && isPaypalConfigured()) {
    const order = await getPaypalOrder(providerOrderId);
    if (order.status === 'COMPLETED') {
      newStatus = 'paid';
    } else if (order.status === 'VOIDED') {
      newStatus = 'cancelled';
    }
    payload = { ...payload, paypal_status: order.status };
  }

  if (provider === 'revolut' && providerOrderId && isRevolutConfigured()) {
    const order = await getRevolutOrder(providerOrderId);
    if (order.state === 'completed') {
      newStatus = 'paid';
    } else if (order.state === 'cancelled') {
      newStatus = 'cancelled';
    }
    payload = { ...payload, revolut_state: order.state };
  }

  const [updated] = await sql`
    UPDATE payment_links
    SET status = ${newStatus}, payload_json = ${sqlv(payload)}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  ` as Array<Record<string, unknown>>;

  // If paid, also update the schedule
  if (newStatus === 'paid' && link.payment_schedule_id) {
    await sql`
      UPDATE payment_schedules
      SET status = 'paid', paid_at = NOW(), paid_amount = amount, updated_at = NOW()
      WHERE id = ${String(link.payment_schedule_id)} AND status != 'paid'
    `;
  }

  return c.json({ link: updated, status_changed: newStatus !== String(link.status) });
});

payments.post('/links/:id/void', async (c) => {
  const id = c.req.param('id');

  const [existing] = await sql`
    SELECT * FROM payment_links WHERE id = ${id} LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!existing) return c.json({ error: 'Link non trovato' }, 404);
  if (existing.status === 'paid') {
    return c.json({ error: 'Non puoi annullare un link già pagato' }, 400);
  }

  // Try to cancel on provider side
  const provider = String(existing.provider);
  const providerOrderId = String(existing.provider_order_id ?? '');

  try {
    if (provider === 'stripe' && providerOrderId && isStripeConfigured()) {
      await stripe.checkout.sessions.expire(providerOrderId);
    }
    if (provider === 'revolut' && providerOrderId && isRevolutConfigured()) {
      await cancelRevolutOrder(providerOrderId);
    }
    // PayPal orders auto-expire, no cancel endpoint for CREATED orders
  } catch (err) {
    console.warn(`Failed to cancel ${provider} order ${providerOrderId}:`, err);
  }

  const [row] = await sql`
    UPDATE payment_links
    SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  ` as Array<Record<string, unknown>>;

  return c.json({ link: row });
});

// =====================================================
// WEBHOOK EVENTS (log + stub)
// =====================================================

payments.post('/webhooks/:provider', async (c) => {
  const provider = c.req.param('provider');
  const body = await c.req.text().catch(() => '{}');

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    payload = { raw: body };
  }

  const eventType = String(
    (payload.event_type as string | undefined)
    ?? (payload.type as string | undefined)
    ?? 'unknown',
  );
  const externalId = String(
    (payload.id as string | undefined)
    ?? ((payload.resource as Record<string, unknown> | undefined)?.id as string | undefined)
    ?? '',
  ) || null;

  const webhookData: Record<string, unknown> = {
    provider,
    event_type: eventType,
    external_id: externalId,
    signature_valid: null,
    payload_json: sqlv(maskPII(payload) as Record<string, unknown>),
    status: 'received',
  };

  await sql`INSERT INTO payment_webhook_events ${sql(webhookData)}`;

  return c.json({ received: true });
});
