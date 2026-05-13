'use client';

import { loadStripe, type Stripe } from '@stripe/stripe-js';

/**
 * Lazy-loaded Stripe.js singleton.
 *
 * Embedded Checkout (and Elements in general) needs the publishable key
 * exposed to the browser. Read from NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.
 * In dev: copy the value of STRIPE_PUBLISHABLE_KEY (pk_test_…) from the
 * monorepo root .env into the NEXT_PUBLIC_ variant.
 */
let stripePromise: Promise<Stripe | null> | null = null;

export function getStripePromise(): Promise<Stripe | null> {
  if (stripePromise) return stripePromise;
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) {
    console.warn(
      '[stripe-client] NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY missing — Embedded Checkout disabled',
    );
    return Promise.resolve(null);
  }
  stripePromise = loadStripe(key);
  return stripePromise;
}
