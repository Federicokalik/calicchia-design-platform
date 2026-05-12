import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sql } from '../db';
import { zValidator } from '../lib/z-validator';
import { createStripeSubscriptionCheckoutSession, cancelStripeSubscription, isStripeConfigured } from '../lib/stripe';
import { createPaypalSubscription, cancelPaypalSubscription, isPaypalReady } from '../lib/paypal';

export const subscriptions = new Hono();

const idParamSchema = z.object({ id: z.string().uuid() });
const createSubscriptionSchema = z.object({
  customer_id: z.string().uuid(),
  service_id: z.string().uuid(),
  provider: z.enum(['stripe', 'paypal']),
  return_base_url: z.string().url().optional(),
});
const cancelSubscriptionSchema = z.object({
  reason: z.string().optional(),
  at_period_end: z.boolean().optional(),
});

subscriptions.get('/', async (c) => {
  const customerId = c.req.query('customer_id');
  const upcoming = c.req.query('upcoming');

  const customerFilter = customerId ? sql`AND s.customer_id = ${customerId}` : sql``;

  let upcomingFilter = sql``;
  if (upcoming) {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + parseInt(upcoming));
    const futureDateStr = futureDate.toISOString().split('T')[0];
    upcomingFilter = sql`AND s.status = 'active' AND s.next_billing_date <= ${futureDateStr}`;
  }

  const rows = await sql`
    SELECT s.*,
      jsonb_build_object('id', c.id, 'company_name', c.company_name, 'contact_name', c.contact_name, 'email', c.email) AS customers
    FROM subscriptions s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE 1=1 ${customerFilter} ${upcomingFilter}
    ORDER BY s.next_billing_date ASC
  `;

  return c.json({ subscriptions: rows });
});

subscriptions.get('/:id', async (c) => {
  const id = c.req.param('id');

  const rows = await sql`
    SELECT s.*, to_jsonb(c.*) AS customers
    FROM subscriptions s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.id = ${id}
  `;

  if (!rows.length) return c.json({ error: 'Abbonamento non trovato' }, 404);
  return c.json({ subscription: rows[0] });
});

subscriptions.post('/', zValidator('json', createSubscriptionSchema), async (c) => {
  const body = (c.req as any).valid('json') as z.infer<typeof createSubscriptionSchema>;

  const [customer] = await sql`
    SELECT id, email, contact_name, company_name, stripe_customer_id
    FROM customers
    WHERE id = ${body.customer_id}
    LIMIT 1
  ` as Array<{
    id: string;
    email: string;
    contact_name: string | null;
    company_name: string | null;
    stripe_customer_id: string | null;
  }>;
  if (!customer) throw new HTTPException(404, { message: 'Cliente non trovato' });

  const [service] = await sql`
    SELECT id, name, description, price, currency, billing_interval,
           stripe_price_id, paypal_plan_id
    FROM services
    WHERE id = ${body.service_id} AND is_active = true
    LIMIT 1
  ` as Array<{
    id: string;
    name: string;
    description: string | null;
    price: number;
    currency: string;
    billing_interval: string;
    stripe_price_id: string | null;
    paypal_plan_id: string | null;
  }>;
  if (!service) throw new HTTPException(404, { message: 'Servizio non trovato' });
  if (service.billing_interval === 'one_time') {
    throw new HTTPException(400, { message: 'Il servizio non e ricorrente' });
  }

  const today = new Date().toISOString().split('T')[0];
  const [subscription] = await sql`
    INSERT INTO subscriptions ${sql({
      customer_id: customer.id,
      service_id: service.id,
      provider: body.provider,
      name: service.name,
      description: service.description,
      amount: Number(service.price),
      currency: String(service.currency ?? 'EUR').toUpperCase(),
      billing_interval: service.billing_interval,
      start_date: today,
      status: 'incomplete',
      auto_renew: true,
      stripe_price_id: body.provider === 'stripe' ? service.stripe_price_id : null,
      paypal_plan_id: body.provider === 'paypal' ? service.paypal_plan_id : null,
      metadata: { approval_status: 'pending_approval' },
    })}
    RETURNING *
  ` as Array<Record<string, unknown>>;

  const returnBaseUrl = body.return_base_url
    ?? process.env.PORTAL_RETURN_BASE_URL
    ?? process.env.ADMIN_URL
    ?? 'http://localhost:3000/it/clienti/abbonamenti';

  if (body.provider === 'stripe') {
    if (!isStripeConfigured()) throw new HTTPException(503, { message: 'Stripe non configurato' });
    if (!service.stripe_price_id) {
      throw new HTTPException(400, { message: 'Servizio non sincronizzato con Stripe' });
    }

    const session = await createStripeSubscriptionCheckoutSession({
      customerEmail: customer.email,
      customerStripeId: customer.stripe_customer_id ?? undefined,
      priceId: service.stripe_price_id,
      successUrl: `${returnBaseUrl}?stripe=subscription_success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${returnBaseUrl}?stripe=subscription_cancelled`,
      metadata: {
        subscription_id: String(subscription.id),
        customer_id: customer.id,
        service_id: service.id,
      },
    });

    await sql`
      UPDATE subscriptions
      SET metadata = metadata || ${JSON.stringify({ checkout_session_id: session.id, approval_url: session.url })}::jsonb,
          updated_at = NOW()
      WHERE id = ${String(subscription.id)}
    `;

    return c.json({ subscription: { ...subscription, checkout_url: session.url }, checkout_url: session.url }, 201);
  }

  if (!(await isPaypalReady())) throw new HTTPException(503, { message: 'PayPal non configurato' });
  if (!service.paypal_plan_id) {
    throw new HTTPException(400, { message: 'Servizio non sincronizzato con PayPal' });
  }

  const paypal = await createPaypalSubscription({
    plan_id: service.paypal_plan_id,
    return_url: `${returnBaseUrl}?paypal=subscription_success`,
    cancel_url: `${returnBaseUrl}?paypal=subscription_cancelled`,
    custom_id: String(subscription.id),
  });

  await sql`
    UPDATE subscriptions
    SET paypal_subscription_id = ${paypal.id},
        metadata = metadata || ${JSON.stringify({ paypal_status: paypal.status, approval_url: paypal.approve_url })}::jsonb,
        updated_at = NOW()
    WHERE id = ${String(subscription.id)}
  `;

  return c.json({
    subscription: { ...subscription, paypal_subscription_id: paypal.id, checkout_url: paypal.approve_url },
    checkout_url: paypal.approve_url,
  }, 201);
});

subscriptions.post(
  '/:id/cancel',
  zValidator('param', idParamSchema),
  zValidator('json', cancelSubscriptionSchema),
  async (c) => {
    const { id } = (c.req as any).valid('param') as z.infer<typeof idParamSchema>;
    const body = (c.req as any).valid('json') as z.infer<typeof cancelSubscriptionSchema>;

    const [subscription] = await sql`
      SELECT * FROM subscriptions WHERE id = ${id} LIMIT 1
    ` as Array<Record<string, unknown>>;

    if (!subscription) throw new HTTPException(404, { message: 'Abbonamento non trovato' });
    if (subscription.status === 'canceled') {
      return c.json({ subscription, alreadyProcessed: true });
    }

    const provider = String(subscription.provider ?? 'stripe');
    if (provider === 'stripe') {
      const stripeId = String(subscription.stripe_subscription_id ?? '');
      if (!stripeId) throw new HTTPException(400, { message: 'Stripe subscription id mancante' });
      await cancelStripeSubscription(stripeId, {
        atPeriodEnd: body.at_period_end ?? false,
        reason: body.reason,
      });
    } else if (provider === 'paypal') {
      const paypalId = String(subscription.paypal_subscription_id ?? '');
      if (!paypalId) throw new HTTPException(400, { message: 'PayPal subscription id mancante' });
      await cancelPaypalSubscription(paypalId, body.reason ?? 'Canceled by admin');
    } else {
      throw new HTTPException(400, { message: `Provider non supportato: ${provider}` });
    }

    const [updated] = await sql`
      UPDATE subscriptions
      SET status = 'canceled', canceled_at = NOW(), auto_renew = false, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    ` as Array<Record<string, unknown>>;

    return c.json({ subscription: updated });
  },
);
