import { Hono } from 'hono';
import type Stripe from 'stripe';
import { stripe, isStripeConfigured } from '../lib/stripe';
import { sql, sqlv } from '../db';
import { recordPaymentSuccess, recordRefund } from '../lib/payment-events';
import { maskPII } from '../lib/webhook-sanitize';

export const stripeWebhook = new Hono();

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

stripeWebhook.post('/', async (c) => {
  if (!isStripeConfigured() || !STRIPE_WEBHOOK_SECRET) {
    return c.json({ error: 'Stripe non configurato' }, 503);
  }

  const body = await c.req.text();
  const signature = c.req.header('stripe-signature');

  if (!signature) return c.json({ error: 'Signature mancante' }, 400);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Errore verifica webhook:', err);
    return c.json({ error: 'Webhook signature non valida' }, 400);
  }

  const logRow: Record<string, unknown> = {
    event_id: event.id,
    event_type: event.type,
    payload: sqlv(maskPII(event.data.object) as unknown as Record<string, unknown>),
  };
  const inserted = await sql`
    INSERT INTO stripe_webhook_logs ${sql(logRow)}
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id
  ` as Array<{ id: string }>;

  if (inserted.length === 0) {
    return c.json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'customer.created':
      case 'customer.updated': {
        const customer = event.data.object as Stripe.Customer;
        if (!customer.deleted) {
          await sql`
            INSERT INTO customers ${sql({
              stripe_customer_id: customer.id,
              email: customer.email || '',
              contact_name: customer.name || '',
              company_name: customer.metadata?.company_name || customer.name || '',
              phone: customer.phone || null,
              billing_address: customer.address ? {
                street: customer.address.line1,
                city: customer.address.city,
                postal_code: customer.address.postal_code,
                province: customer.address.state,
                country: customer.address.country,
              } : null,
            })}
            ON CONFLICT (stripe_customer_id) DO UPDATE SET
              email = EXCLUDED.email,
              contact_name = EXCLUDED.contact_name,
              company_name = EXCLUDED.company_name,
              phone = EXCLUDED.phone,
              billing_address = EXCLUDED.billing_address
          `;
        }
        break;
      }

      case 'customer.deleted': {
        const customer = event.data.object as Stripe.Customer;
        await sql`UPDATE customers SET status = 'inactive' WHERE stripe_customer_id = ${customer.id}`;
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeCustomerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;

        const [customer] = await sql`SELECT id FROM customers WHERE stripe_customer_id = ${stripeCustomerId}`;
        if (customer) {
          const item = subscription.items.data[0];
          await sql`
            INSERT INTO subscriptions ${sql({
              stripe_subscription_id: subscription.id,
              customer_id: customer.id,
              stripe_price_id: item?.price?.id,
              name: (item?.price?.product as Stripe.Product)?.name || 'Abbonamento',
              amount: (item?.price?.unit_amount || 0) / 100,
              currency: item?.price?.currency?.toUpperCase() || 'EUR',
              billing_interval: item?.price?.recurring?.interval || 'year',
              status: subscription.status,
              start_date: new Date(subscription.start_date * 1000).toISOString().split('T')[0],
              current_period_start: new Date(subscription.current_period_start * 1000).toISOString().split('T')[0],
              current_period_end: new Date(subscription.current_period_end * 1000).toISOString().split('T')[0],
              next_billing_date: new Date(subscription.current_period_end * 1000).toISOString().split('T')[0],
              canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000).toISOString() : null,
              auto_renew: !subscription.cancel_at_period_end,
            })}
            ON CONFLICT (stripe_subscription_id) DO UPDATE SET
              status = EXCLUDED.status,
              current_period_start = EXCLUDED.current_period_start,
              current_period_end = EXCLUDED.current_period_end,
              next_billing_date = EXCLUDED.next_billing_date,
              canceled_at = EXCLUDED.canceled_at,
              auto_renew = EXCLUDED.auto_renew
          `;
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await sql`UPDATE subscriptions SET status = 'canceled', canceled_at = NOW() WHERE stripe_subscription_id = ${subscription.id}`;
        break;
      }

      case 'invoice.created':
      case 'invoice.updated':
      case 'invoice.finalized':
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;

        const [customer] = await sql`SELECT id FROM customers WHERE stripe_customer_id = ${stripeCustomerId}`;
        if (customer) {
          let subscriptionId = null;
          if (invoice.subscription) {
            const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id;
            const [sub] = await sql`SELECT id FROM subscriptions WHERE stripe_subscription_id = ${subId}`;
            subscriptionId = sub?.id;
          }

          const status = invoice.status === 'paid' ? 'paid' : invoice.status === 'open' ? 'open' : invoice.status === 'void' ? 'void' : 'draft';

          await sql`
            INSERT INTO invoices ${sql({
              stripe_invoice_id: invoice.id,
              customer_id: customer.id,
              subscription_id: subscriptionId,
              invoice_number: invoice.number || `INV-${Date.now()}`,
              status,
              total: (invoice.total || 0) / 100,
              amount_paid: (invoice.amount_paid || 0) / 100,
              amount_due: (invoice.amount_due || 0) / 100,
              currency: invoice.currency?.toUpperCase() || 'EUR',
              issue_date: invoice.created ? new Date(invoice.created * 1000).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
              due_date: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().split('T')[0] : null,
              paid_at: invoice.status === 'paid' && invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : null,
              stripe_hosted_invoice_url: invoice.hosted_invoice_url,
              stripe_pdf_url: invoice.invoice_pdf,
            })}
            ON CONFLICT (stripe_invoice_id) DO UPDATE SET
              status = EXCLUDED.status,
              amount_paid = EXCLUDED.amount_paid,
              amount_due = EXCLUDED.amount_due,
              paid_at = EXCLUDED.paid_at
          `;
        }
        break;
      }

      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;

        if (paymentIntent.customer) {
          const stripeCustomerId = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : paymentIntent.customer.id;
          const [customer] = await sql`SELECT id FROM customers WHERE stripe_customer_id = ${stripeCustomerId}`;

          if (customer) {
            const [inv] = await sql`SELECT id FROM invoices WHERE stripe_payment_intent_id = ${paymentIntent.id} LIMIT 1`;
            await sql`
              INSERT INTO payments ${sql({
                stripe_payment_intent_id: paymentIntent.id,
                customer_id: customer.id,
                invoice_id: inv?.id || null,
                amount: paymentIntent.amount / 100,
                currency: paymentIntent.currency.toUpperCase(),
                status: paymentIntent.status,
                payment_method: paymentIntent.payment_method_types?.[0] || 'card',
              })}
              ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = EXCLUDED.status
            `;
          }
        }
        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
        if (paymentIntentId) {
          await sql`
            UPDATE payment_links
            SET payload_json = payload_json || ${JSON.stringify({ payment_intent_id: paymentIntentId })}::jsonb,
                updated_at = NOW()
            WHERE provider = 'stripe' AND provider_order_id = ${session.id}
          `;
        }
        await recordPaymentSuccess({
          provider: 'stripe',
          providerOrderId: session.id,
          amount: Number(session.amount_total ?? 0) / 100,
          currency: session.currency?.toUpperCase() ?? 'EUR',
          payerEmail: session.customer_details?.email ?? null,
          scheduleIdFallback: session.metadata?.payment_schedule_id ?? null,
        });
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        await sql`
          UPDATE payment_links
          SET status = 'expired', updated_at = NOW()
          WHERE provider = 'stripe'
            AND provider_order_id = ${session.id}
            AND status IN ('pending', 'active')
        `;
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
        const [link] = await sql`
          SELECT id
          FROM payment_links
          WHERE provider = 'stripe'
            AND (
              provider_order_id = ${paymentIntentId}
              OR payload_json->>'payment_intent_id' = ${paymentIntentId}
              OR payload_json->>'charge_id' = ${charge.id}
            )
          ORDER BY created_at DESC
          LIMIT 1
        ` as Array<{ id: string }>;

        const refund = charge.refunds?.data?.[0];
        if (link && refund) {
          await recordRefund({
            paymentLinkId: link.id,
            amount: Number(refund.amount ?? 0) / 100,
            currency: refund.currency?.toUpperCase() ?? charge.currency?.toUpperCase() ?? 'EUR',
            providerRefundId: refund.id,
            reason: refund.reason ?? null,
          });
        }
        break;
      }

      default:
        console.log(`Evento non gestito: ${event.type}`);
    }

    await sql`UPDATE stripe_webhook_logs SET processed = true WHERE event_id = ${event.id}`;
    return c.json({ received: true });

  } catch (error) {
    await sql`
      UPDATE stripe_webhook_logs SET ${sql({
        processed: false,
        error_message: error instanceof Error ? error.message : 'Unknown error',
      })}
      WHERE event_id = ${event.id}
    `;
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});
