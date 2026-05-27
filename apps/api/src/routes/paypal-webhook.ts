import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sql, sqlv } from '../db';
import { capturePaypalOrder } from '../lib/paypal';
import { extractPaypalSignatureHeaders, verifyPaypalSignature } from '../lib/paypal-webhook';
import { recordPaymentSuccess, recordRefund } from '../lib/payment-events';
import { maskPII } from '../lib/webhook-sanitize';
import { captureException } from '../lib/bugsink';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'paypal-webhook' });

export const paypalWebhook = new Hono();

type PaypalWebhookEvent = {
  id?: string;
  event_type?: string;
  resource?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readAmount(resource: Record<string, unknown>): { amount: number; currency: string } {
  const amount = asRecord(resource.amount);
  return {
    amount: Number(amount.value ?? 0),
    currency: String(amount.currency_code ?? 'EUR').toUpperCase(),
  };
}

function readOrderId(resource: Record<string, unknown>): string | null {
  const related = asRecord(asRecord(resource.supplementary_data).related_ids);
  return String(related.order_id ?? resource.id ?? '') || null;
}

function readCaptureIdFromRefund(resource: Record<string, unknown>): string | null {
  const links = Array.isArray(resource.links) ? resource.links as Array<Record<string, unknown>> : [];
  for (const link of links) {
    const href = String(link.href ?? '');
    const match = href.match(/\/v2\/payments\/captures\/([^/]+)\//);
    if (match?.[1]) return match[1];
  }
  return null;
}

// Audit J-K-09: generic body, accurate status, structured logs. PayPal
// retries on 4xx with backoff just like Stripe, so we keep the status code
// but stop differentiating rejection reasons in the response body.
const PAYPAL_GENERIC_REJECT = { error: 'Invalid request' } as const;

paypalWebhook.post('/', async (c) => {
  // Block early if PayPal isn't configured at all. Mirrors stripe-webhook
  // which returns 503 (Service Unavailable) rather than a generic 400.
  if (!process.env.PAYPAL_WEBHOOK_ID) {
    log.warn('paypal-webhook hit but PAYPAL_WEBHOOK_ID not configured');
    return c.json(PAYPAL_GENERIC_REJECT, 503);
  }

  const rawBody = await c.req.text();

  let event: PaypalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PaypalWebhookEvent;
  } catch (err) {
    log.warn({ err }, 'paypal-webhook payload not valid JSON');
    throw new HTTPException(400, { message: 'Invalid request' });
  }

  const eventId = event.id ?? '';
  const eventType = event.event_type ?? 'unknown';
  if (!eventId) {
    log.warn({ eventType }, 'paypal-webhook missing event_id');
    throw new HTTPException(400, { message: 'Invalid request' });
  }

  // Signature verification BEFORE touching the DB. Otherwise an attacker can
  // flood `paypal_webhook_logs` with bogus rows and use the duplicate-vs-new
  // response shape as an oracle for which event_ids we've already seen.
  // Mirrors Stripe webhook ordering (constructEvent -> insert log).
  const signatureHeaders = extractPaypalSignatureHeaders((name) => c.req.header(name));
  const signatureValid = await verifyPaypalSignature(signatureHeaders, event);
  if (!signatureValid) {
    log.warn({ eventId, eventType }, 'PayPal webhook signature rejected');
    throw new HTTPException(400, { message: 'Invalid request' });
  }

  const logRow: Record<string, unknown> = {
    event_id: eventId,
    event_type: eventType,
    payload: sqlv(maskPII(event) as Record<string, unknown>),
    signature_valid: true,
  };
  const inserted = await sql`
    INSERT INTO paypal_webhook_logs ${sql(logRow)}
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id
  ` as Array<{ id: string }>;

  if (inserted.length === 0) {
    return c.json({ received: true, duplicate: true });
  }

  try {
    const resource = asRecord(event.resource);

    switch (eventType) {
      case 'CHECKOUT.ORDER.APPROVED': {
        const orderId = String(resource.id ?? '');
        if (!orderId) throw new Error('PayPal order id mancante');
        const capture = await capturePaypalOrder(orderId);
        if (capture.capture_id) {
          await sql`
            UPDATE payment_links
            SET payload_json = payload_json || ${JSON.stringify({ capture_id: capture.capture_id })}::jsonb,
                updated_at = NOW()
            WHERE provider = 'paypal' AND provider_order_id = ${orderId}
          `;
        }
        await recordPaymentSuccess({
          provider: 'paypal',
          providerOrderId: orderId,
          amount: capture.amount ?? Number(asRecord(asRecord(resource.purchase_units).amount).value ?? 0),
          currency: capture.currency ?? 'EUR',
          payerEmail: capture.payer_email ?? null,
        });
        break;
      }

      case 'PAYMENT.CAPTURE.COMPLETED': {
        const orderId = readOrderId(resource);
        const captureId = String(resource.id ?? '');
        const amount = readAmount(resource);
        if (orderId && captureId) {
          await sql`
            UPDATE payment_links
            SET payload_json = payload_json || ${JSON.stringify({ capture_id: captureId })}::jsonb,
                updated_at = NOW()
            WHERE provider = 'paypal' AND provider_order_id = ${orderId}
          `;
        }
        await recordPaymentSuccess({
          provider: 'paypal',
          providerOrderId: orderId ?? captureId,
          amount: amount.amount,
          currency: amount.currency,
          payerEmail: String(asRecord(resource.payee).email_address ?? '') || null,
        });
        break;
      }

      case 'PAYMENT.CAPTURE.DENIED': {
        const orderId = readOrderId(resource);
        if (orderId) {
          await sql`
            UPDATE payment_links
            SET status = 'cancelled', updated_at = NOW()
            WHERE provider = 'paypal'
              AND provider_order_id = ${orderId}
              AND status IN ('pending', 'active')
          `;
        }
        break;
      }

      case 'PAYMENT.CAPTURE.REFUNDED': {
        const refundId = String(resource.id ?? '');
        const captureId = readCaptureIdFromRefund(resource);
        const amount = readAmount(resource);
        if (refundId && captureId) {
          const [link] = await sql`
            SELECT id
            FROM payment_links
            WHERE provider = 'paypal' AND payload_json->>'capture_id' = ${captureId}
            ORDER BY created_at DESC
            LIMIT 1
          ` as Array<{ id: string }>;
          if (link) {
            await recordRefund({
              paymentLinkId: link.id,
              amount: amount.amount,
              currency: amount.currency,
              providerRefundId: refundId,
            });
          }
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.ACTIVATED': {
        const paypalSubscriptionId = String(resource.id ?? '');
        const customId = String(resource.custom_id ?? '');
        const planId = String(resource.plan_id ?? '');
        const nextBillingTime = String(asRecord(resource.billing_info).next_billing_time ?? '');
        const startTime = String(resource.start_time ?? new Date().toISOString());

        if (customId) {
          await sql`
            UPDATE subscriptions
            SET provider = 'paypal',
                paypal_subscription_id = ${paypalSubscriptionId},
                paypal_plan_id = ${planId || null},
                status = 'active',
                start_date = ${startTime.split('T')[0]},
                next_billing_date = ${nextBillingTime ? nextBillingTime.split('T')[0] : null},
                current_period_start = ${startTime.split('T')[0]},
                current_period_end = ${nextBillingTime ? nextBillingTime.split('T')[0] : null},
                updated_at = NOW()
            WHERE id = ${customId} OR paypal_subscription_id = ${paypalSubscriptionId}
          `;
        } else if (paypalSubscriptionId) {
          await sql`
            UPDATE subscriptions
            SET status = 'active',
                next_billing_date = ${nextBillingTime ? nextBillingTime.split('T')[0] : null},
                updated_at = NOW()
            WHERE paypal_subscription_id = ${paypalSubscriptionId}
          `;
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.CANCELLED': {
        const paypalSubscriptionId = String(resource.id ?? '');
        if (paypalSubscriptionId) {
          await sql`
            UPDATE subscriptions
            SET status = 'canceled', canceled_at = NOW(), auto_renew = false, updated_at = NOW()
            WHERE paypal_subscription_id = ${paypalSubscriptionId}
          `;
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
        log.warn({ resourceId: resource.id ?? eventId }, 'subscription payment failed');
        break;
      }

      default:
        log.info(`Evento non gestito: ${eventType}`);
    }

    await sql`UPDATE paypal_webhook_logs SET processed = true WHERE event_id = ${eventId}`;
    return c.json({ received: true });
  } catch (error) {
    captureException(error instanceof Error ? error : new Error(String(error)), {
      source: 'paypal-webhook', event_id: eventId, event_type: eventType,
    });
    await sql`
      UPDATE paypal_webhook_logs SET ${sql({
        processed: false,
        error_message: error instanceof Error ? error.message : 'Unknown error',
      })}
      WHERE event_id = ${eventId}
    `;
    throw error;
  }
});
