'use client';

import { useMemo } from 'react';
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from '@stripe/react-stripe-js';
import { getStripePromise } from '@/lib/stripe-client';

interface StripeEmbeddedProps {
  clientSecret: string;
  onComplete?: () => void;
}

export function StripeEmbedded({ clientSecret, onComplete }: StripeEmbeddedProps) {
  const stripePromise = useMemo(() => getStripePromise(), []);

  if (!clientSecret) return null;

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
