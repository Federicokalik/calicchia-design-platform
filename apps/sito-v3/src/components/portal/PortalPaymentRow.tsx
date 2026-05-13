'use client';

import { InlineCheckout } from './payment/InlineCheckout';

interface PortalPaymentRowProps {
  scheduleId: string;
  amount: number;
  currency: string;
}

/**
 * Inline payment block under a schedule row. Wraps InlineCheckout in portal mode
 * so the parent (server component) doesn't need 'use client'.
 *
 * Replaces the legacy PayButton + redirect flow with embedded Stripe / PayPal +
 * bonifico — all inline, no redirect.
 */
export function PortalPaymentRow({ scheduleId, amount, currency }: PortalPaymentRowProps) {
  return (
    <InlineCheckout
      scheduleId={scheduleId}
      amount={amount}
      currency={currency}
      availableProviders={['stripe', 'paypal', 'bank_transfer']}
    />
  );
}
