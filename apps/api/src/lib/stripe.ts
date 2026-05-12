import Stripe from 'stripe';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  console.warn('STRIPE_SECRET_KEY not configured');
}

export const stripe = new Stripe(stripeSecretKey || '', {
  apiVersion: '2025-02-24.acacia',
  typescript: true,
});

export function isStripeConfigured(): boolean {
  return !!stripeSecretKey;
}

// ========== CATALOG HELPERS ==========

export async function createStripeProduct(name: string, description?: string) {
  return stripe.products.create({
    name,
    description: description || undefined,
  });
}

export async function createStripePrice(
  productId: string,
  amountInCents: number,
  currency: string,
  recurring?: { interval: 'month' | 'year' }
) {
  return stripe.prices.create({
    product: productId,
    unit_amount: amountInCents,
    currency: currency.toLowerCase(),
    recurring: recurring || undefined,
  });
}

export async function createPaymentIntent(
  amountInCents: number,
  currency: string,
  metadata?: Record<string, string>
) {
  return stripe.paymentIntents.create({
    amount: amountInCents,
    currency: currency.toLowerCase(),
    metadata: metadata || {},
  });
}

// ========== SUBSCRIPTIONS ==========

export interface CreateSubscriptionCheckoutInput {
  customerEmail?: string;
  customerStripeId?: string;
  priceId: string; // Stripe price (e.g. price_…)
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}

/**
 * Create a Stripe Checkout Session in `subscription` mode.
 * Used by admin → portal subscription onboarding (POST /api/subscriptions).
 *
 * TODO (Stripe Tax IT): enable `automatic_tax: { enabled: true }` once the
 * Italian tax registration is configured in the Stripe dashboard. For now we
 * intentionally do NOT charge VAT inside Stripe — invoices stay pro-forma.
 */
export async function createStripeSubscriptionCheckoutSession(
  input: CreateSubscriptionCheckoutInput,
) {
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer: input.customerStripeId,
    customer_email: input.customerStripeId ? undefined : input.customerEmail,
    metadata: input.metadata ?? {},
    subscription_data: input.metadata ? { metadata: input.metadata } : undefined,
  });
}

export async function cancelStripeSubscription(
  subscriptionId: string,
  opts?: { atPeriodEnd?: boolean; reason?: string },
) {
  if (opts?.atPeriodEnd) {
    return stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
      cancellation_details: opts.reason ? { comment: opts.reason } : undefined,
    });
  }
  return stripe.subscriptions.cancel(subscriptionId, {
    invoice_now: false,
    prorate: false,
  });
}

// ========== REFUNDS ==========

export interface CreateStripeRefundInput {
  /** Either pass paymentIntentId OR chargeId (paymentIntentId preferred). */
  paymentIntentId?: string;
  chargeId?: string;
  /** Amount in major units (e.g. 25.00). If omitted → full refund. */
  amount?: number;
  /** Stripe's canonical reasons: duplicate | fraudulent | requested_by_customer. */
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  metadata?: Record<string, string>;
}

export async function createStripeRefund(input: CreateStripeRefundInput) {
  if (!input.paymentIntentId && !input.chargeId) {
    throw new Error('createStripeRefund: paymentIntentId or chargeId required');
  }
  return stripe.refunds.create({
    payment_intent: input.paymentIntentId,
    charge: input.chargeId,
    amount: input.amount !== undefined ? Math.round(input.amount * 100) : undefined,
    reason: input.reason,
    metadata: input.metadata ?? {},
  });
}
