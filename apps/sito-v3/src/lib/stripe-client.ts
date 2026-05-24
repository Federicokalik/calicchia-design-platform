'use client';

import { loadStripe, type Stripe } from '@stripe/stripe-js';

/**
 * Lazy-loaded Stripe.js singleton, keyed by publishable key.
 *
 * The publishable key comes from /api/config (RuntimeConfigProvider), NOT
 * NEXT_PUBLIC_*: that way our published Docker image stays neutral and a
 * fork who pulls it doesn't inherit our Stripe merchant. Pass the key in
 * from the calling component via `useRuntimeConfig().config.stripePublishableKey`.
 */
const promises = new Map<string, Promise<Stripe | null>>();

export function getStripePromise(publishableKey: string): Promise<Stripe | null> {
  if (!publishableKey) {
    console.warn('[stripe-client] publishable key missing — Embedded Checkout disabled');
    return Promise.resolve(null);
  }
  const cached = promises.get(publishableKey);
  if (cached) return cached;
  const promise = loadStripe(publishableKey);
  promises.set(publishableKey, promise);
  return promise;
}
