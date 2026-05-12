'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CreditCard, Loader2 } from 'lucide-react';
import { Button } from './ui/button';

interface PayButtonProps {
  scheduleId: string;
  /** If true, hide one provider option (e.g. Stripe-only or PayPal-only). */
  providers?: Array<'stripe' | 'paypal'>;
  disabled?: boolean;
  /** Tailwind class to control layout (e.g. 'flex-col' on mobile, 'flex-row' on desktop). */
  className?: string;
}

/**
 * Pay button — shows one or both providers (Stripe, PayPal).
 * Each click POSTs to the Next route handler which forwards to Hono API,
 * then window.location.assign() redirects to the provider's checkout page.
 *
 * Idempotency: if a payment_link 'active' already exists for (schedule, provider),
 * the API reuses it instead of creating a duplicate — safe to retry.
 */
export function PayButton({
  scheduleId,
  providers = ['stripe', 'paypal'],
  disabled,
  className = 'flex flex-col sm:flex-row gap-2',
}: PayButtonProps) {
  const t = useTranslations('portal.payment');
  const [pending, setPending] = useState<'stripe' | 'paypal' | null>(null);

  async function pay(provider: 'stripe' | 'paypal') {
    if (pending || disabled) return;
    setPending(provider);
    try {
      const res = await fetch('/api/portal/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule_id: scheduleId, provider }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { checkout_url: string };
      if (!data.checkout_url) throw new Error('Missing checkout_url');
      // Full-page redirect to provider (Stripe Checkout / PayPal Approve)
      window.location.assign(data.checkout_url);
    } catch (err) {
      setPending(null);
      console.error('[PayButton] Error:', err);
      alert((err as Error).message || 'Errore avvio pagamento');
    }
  }

  return (
    <div className={className}>
      {providers.includes('stripe') && (
        <Button
          type="button"
          variant="default"
          onClick={() => pay('stripe')}
          disabled={!!pending || disabled}
          aria-label={`${t('payWith')} ${t('stripe')}`}
        >
          {pending === 'stripe' ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <CreditCard aria-hidden />
          )}
          {pending === 'stripe' ? t('preparing') : t('stripe')}
        </Button>
      )}
      {providers.includes('paypal') && (
        <Button
          type="button"
          variant="outline"
          onClick={() => pay('paypal')}
          disabled={!!pending || disabled}
          aria-label={`${t('payWith')} ${t('paypal')}`}
        >
          {pending === 'paypal' ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <span aria-hidden className="font-semibold tracking-tight">P</span>
          )}
          {pending === 'paypal' ? t('preparing') : t('paypal')}
        </Button>
      )}
    </div>
  );
}
