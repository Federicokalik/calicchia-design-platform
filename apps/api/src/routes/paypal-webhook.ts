import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sql, sqlv } from '../db';
import { capturePaypalOrder } from '../lib/paypal';
import { extractPaypalSignatureHeaders, verifyPaypalSignature } from '../lib/paypal-webhook';
import { recordPaymentSuccess, recordRefund } from '../lib/payment-events';
import { maskPII } from '../lib/webhook-sanitize';

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

paypalWebhook.post('/', async (c) => {
  const rawBody = await c.req.text();

  let event: PaypalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PaypalWebhookEvent;
  } catch {
    throw new HTTPException(400, { message: 'Payload PayPal non valido' });
  }

  const eventId = event.id ?? '';
  const eventType = event.event_type ?? 'unknown';
  if (!eventId) throw new HTTPException(400, { message: 'PayPal event_id mancante' });

  const logRow: Record<string, unknown> = {
    event_id: eventId,
    event_type: eventType,
    payload: sqlv(maskPII(event) as Record<string, unknown>),
  };
  const inserted = await sql`
    INSERT INTO paypal_webhook_logs ${sql(logRow)}
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id
  ` as Array<{ id: string }>;

  if (inserted.length === 0) {
    return c.json({ received: true, duplicate: true });
  }

  const signatureHeaders = extractPaypalSignatureHeaders((name) => c.req.header(name));
  const signatureValid = await verifyPaypalSignature(signatureHeaders, event);

  await sql`
    UPDATE paypal_webhook_logs
    SET signature_valid = ${signatureValid}
    WHERE event_id = ${eventId}
  `;

  if (!signatureValid) {
    await sql`
      UPDATE paypal_webhook_logs
      SET processed = false, error_message = 'Signature PayPal non valida'
      WHERE event_id = ${eventId}
    `;
    throw new HTTPException(400, { message: 'Signature PayPal non valida' });
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
        console.warn('[paypal-webhook] subscription payment failed', resource.id ?? eventId);
        break;
      }

      default:
        console.log(`[paypal-webhook] Evento non gestito: ${eventType}`);
    }

    await sql`UPDATE paypal_webhook_logs SET processed = true WHERE event_id = ${eventId}`;
    return c.json({ received: true });
  } catch (error) {
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
