'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Banknote, CreditCard, Loader2 } from 'lucide-react';
import { Button } from '@/components/portal/ui/button';
import { PortalLabel } from '@/components/portal/ui/typography';
import { cn } from '@/lib/utils';
import { BankTransferBlock, type BankDetails } from './BankTransferBlock';
import { StripeEmbedded } from './StripeEmbedded';
import { PaypalEmbedded } from './PaypalEmbedded';

export type PaymentProvider = 'stripe' | 'paypal' | 'bank_transfer';

interface InlineCheckoutProps {
  /** Pre-rounded currency amount for the receipt copy block. */
  amount: number;
  currency: string;
  /** Subset of providers to expose. Defaults to all three. */
  availableProviders?: PaymentProvider[];
  /** Portal mode: posts {schedule_id, provider} to /api/portal/pay. */
  scheduleId?: string;
  /** Public mode: link UUID — used for /api/public-pay/:id/* endpoints. */
  linkId?: string;
  /** If true, the panel mounts a single provider directly without tabs (public mode). */
  singleProvider?: PaymentProvider;
  /** Callback when payment completes (Stripe onComplete / PayPal capture success). */
  onSuccess?: () => void;
}

interface CheckoutResponse {
  provider: PaymentProvider;
  link_id: string;
  client_secret?: string;
  order_id?: string;
  bank_details?: BankDetails;
}

interface ProviderState {
  active: PaymentProvider | null;
  loading: boolean;
  error: string | null;
  data: CheckoutResponse | null;
}

const PROVIDER_ICONS: Record<PaymentProvider, React.ComponentType<{ className?: string }>> = {
  stripe: CreditCard,
  paypal: CreditCard,
  bank_transfer: Banknote,
};

export function InlineCheckout({
  amount,
  currency,
  availableProviders = ['stripe', 'paypal', 'bank_transfer'],
  scheduleId,
  linkId,
  singleProvider,
  onSuccess,
}: InlineCheckoutProps) {
  const t = useTranslations('portal.payment');
  const [state, setState] = useState<ProviderState>({
    active: singleProvider ?? null,
    loading: false,
    error: null,
    data: null,
  });
  const [done, setDone] = useState(false);

  // In public mode (singleProvider set), auto-load checkout immediately.
  useEffect(() => {
    if (singleProvider && !state.data && !state.loading) {
      void selectProvider(singleProvider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleProvider]);

  async function selectProvider(provider: PaymentProvider) {
    if (state.loading) return;
    setState({ active: provider, loading: true, error: null, data: null });
    try {
      let res: Response;
      if (linkId) {
        // Public flow
        res = await fetch(`/api/public-pay/${linkId}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      } else if (scheduleId) {
        // Portal flow
        res = await fetch('/api/portal/pay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schedule_id: scheduleId, provider }),
        });
      } else {
        throw new Error('Missing scheduleId or linkId');
      }
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
      }
      setState({ active: provider, loading: false, error: null, data });
    } catch (err) {
      setState({
        active: provider,
        loading: false,
        error: (err as Error).message || t('errors.checkoutFailed'),
        data: null,
      });
    }
  }

  function handleSuccess() {
    setDone(true);
    onSuccess?.();
  }

  if (done) {
    return (
      <div
        role="status"
        className="rounded-sm border border-success/40 bg-success/5 p-5 text-portal-body"
      >
        <PortalLabel className="mb-1 text-success">{t('success.eyebrow')}</PortalLabel>
        <p className="text-foreground">{t('success.intro')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!singleProvider && (
        <div
          role="tablist"
          aria-label={t('chooseMethod')}
          className="flex flex-wrap gap-2"
        >
          {availableProviders.map((p) => {
            const Icon = PROVIDER_ICONS[p];
            const isActive = state.active === p;
            return (
              <Button
                key={p}
                type="button"
                role="tab"
                aria-selected={isActive}
                variant={isActive ? 'default' : 'outline'}
                onClick={() => selectProvider(p)}
                disabled={state.loading}
                className={cn(
                  'transition-colors',
                  state.loading && state.active === p && 'pointer-events-none',
                )}
              >
                {state.loading && state.active === p ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Icon aria-hidden />
                )}
                {t(`providers.${p}`)}
              </Button>
            );
          })}
        </div>
      )}

      {state.error && (
        <p role="alert" className="text-portal-body text-destructive">
          {state.error}
        </p>
      )}

      {state.data?.provider === 'stripe' && state.data.client_secret && (
        <StripeEmbedded
          clientSecret={state.data.client_secret}
          onComplete={handleSuccess}
        />
      )}

      {state.data?.provider === 'paypal' && state.data.order_id && (
        <PaypalEmbedded
          orderId={state.data.order_id}
          currency={currency}
          captureEndpoint={
            linkId
              ? `/api/public-pay/${linkId}/capture`
              : `/api/portal/paypal-capture/${state.data.link_id}`
          }
          onSuccess={handleSuccess}
        />
      )}

      {state.data?.provider === 'bank_transfer' && state.data.bank_details && (
        <BankTransferBlock details={state.data.bank_details} />
      )}

      {!state.active && !singleProvider && (
        <p className="text-portal-body text-muted-foreground">
          {t('selectProviderHint', {
            amount: new Intl.NumberFormat('it-IT', {
              style: 'currency',
              currency,
            }).format(amount),
          })}
        </p>
      )}
    </div>
  );
}
