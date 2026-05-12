'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import {
  PortalDisplay,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import { Button } from '@/components/portal/ui/button';

type State =
  | { kind: 'idle' }
  | { kind: 'paypal_capturing' }
  | { kind: 'stripe_processing' }
  | { kind: 'success' }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

/**
 * Return page from Stripe Checkout / PayPal approve.
 *
 * Stripe: webhook is authoritative — we briefly wait then mark optimistic success.
 * PayPal: we explicitly call /api/portal/paypal-capture/{linkId} to capture
 * (idempotent — webhook may also fire and would no-op).
 *
 * Query params:
 *  - provider=stripe → ?stripe_session=cs_test_… & linkId=<uuid>
 *  - provider=paypal → ?token=ORDER_ID&PayerID=…  & linkId=<uuid>
 */
export default function PaymentSuccessPage() {
  const t = useTranslations('portal');
  const tPayment = useTranslations('portal.payment.success');
  const params = useSearchParams();
  const provider = params.get('provider');
  const linkId = params.get('linkId');
  const stripeSession = params.get('stripe_session');
  const paypalToken = params.get('token');

  const [state, setState] = useState<State>({ kind: 'idle' });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (provider === 'paypal' && linkId && paypalToken) {
      void capturePaypal(linkId, setState);
      return;
    }
    if (provider === 'stripe' && stripeSession) {
      void waitForStripe(setState);
      return;
    }
    // Unknown shape — webhook is authoritative, show optimistic success.
    setState({ kind: 'success' });
  }, [provider, linkId, stripeSession, paypalToken]);

  const headline = (() => {
    switch (state.kind) {
      case 'paypal_capturing':
        return tPayment('paypalCapturing');
      case 'stripe_processing':
        return tPayment('stripeProcessing');
      case 'timeout':
        return tPayment('stripeTimeout');
      case 'error':
        return tPayment('paypalError');
      case 'success':
      case 'idle':
      default:
        return tPayment('title');
    }
  })();

  const body = state.kind === 'stripe_processing'
    ? tPayment('stripeProcessingHint')
    : tPayment('intro');

  return (
    <PortalShell userLabel={undefined}>
      <PortalTopbar
        breadcrumbs={[
          { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
          { label: t('nav.items.invoices'), href: '/clienti/fatture' },
          { label: tPayment('title') },
        ]}
      />

      <div className="flex flex-col gap-8 max-w-[640px]">
        <header className="flex flex-col gap-3">
          {state.kind === 'success' && <CheckCircle2 className="h-10 w-10 text-foreground" aria-hidden />}
          {(state.kind === 'paypal_capturing' || state.kind === 'stripe_processing') && (
            <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" aria-hidden />
          )}
          {(state.kind === 'timeout' || state.kind === 'error') && (
            <AlertCircle className="h-10 w-10 text-destructive" aria-hidden />
          )}
          <PortalLabel>{tPayment('eyebrow')}</PortalLabel>
          <PortalDisplay>{headline}</PortalDisplay>
          <PortalBody className="text-muted-foreground">{body}</PortalBody>
        </header>

        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/clienti/fatture">{tPayment('viewInvoices')}</Link>
          </Button>
        </div>
      </div>
    </PortalShell>
  );
}

async function capturePaypal(linkId: string, setState: (s: State) => void): Promise<void> {
  setState({ kind: 'paypal_capturing' });
  try {
    const res = await fetch(`/api/portal/paypal-capture/${encodeURIComponent(linkId)}`, {
      method: 'POST',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    setState({ kind: 'success' });
  } catch (err) {
    setState({ kind: 'error', message: (err as Error).message });
  }
}

async function waitForStripe(setState: (s: State) => void): Promise<void> {
  // Stripe webhook is authoritative; show a brief processing spinner then optimistic success.
  // Polling endpoint not implemented in v1 — webhook + page refresh on /clienti/fatture
  // surface the final state.
  setState({ kind: 'stripe_processing' });
  await new Promise((r) => setTimeout(r, 3500));
  setState({ kind: 'success' });
}
