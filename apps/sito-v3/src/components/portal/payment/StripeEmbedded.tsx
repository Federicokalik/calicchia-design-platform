'use client';

import { useMemo } from 'react';
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from '@stripe/react-stripe-js';
import { getStripePromise } from '@/lib/stripe-client';
import { useRuntimeConfig } from '@/lib/runtime-config';

interface StripeEmbeddedProps {
  clientSecret: string;
  onComplete?: () => void;
}

export function StripeEmbedded({ clientSecret, onComplete }: StripeEmbeddedProps) {
  const { config, ready } = useRuntimeConfig();
  const publishableKey = config.stripePublishableKey;
  const stripePromise = useMemo(
    () => (publishableKey ? getStripePromise(publishableKey) : null),
    [publishableKey],
  );

  if (!clientSecret) return null;
  if (!ready || !stripePromise) {
    // Wait for /api/config to resolve. The portal payment flow already shows
    // its own loading state above this component while the checkout is being
    // created; nothing to render here.
    return null;
  }

  return (
    <div className="rounded-sm border border-border bg-background overflow-hidden">
      <EmbeddedCheckoutProvider
        stripe={stripePromise}
        options={{ clientSecret, onComplete }}
      >
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
