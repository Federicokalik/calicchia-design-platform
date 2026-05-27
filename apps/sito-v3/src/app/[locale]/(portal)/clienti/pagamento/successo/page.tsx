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
    if (provider === 'stripe' && linkId) {
      void waitForStripe(linkId, setState);
      return;
    }
    // No linkId we can poll → fall back to "elaborazione in corso" rather than
    // fabricated success (audit B-005). The user is redirected to /clienti/fatture
    // which will reflect the webhook-authoritative state.
    setState({ kind: 'timeout' });
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

async function waitForStripe(linkId: string, setState: (s: State) => void): Promise<void> {
  // Stripe webhook is authoritative; we poll the link status with backoff until
  // it flips to 'paid' or we time out, then route the user accordingly. Audit
  // B-005: the previous version always showed 'success' after 3.5s regardless,
  // which meant a crafted URL could fake a paid state to the user.
  setState({ kind: 'stripe_processing' });
  const delays = [1000, 2000, 2000, 4000, 4000]; // ~13s cumulative
  for (const ms of delays) {
    try {
      const res = await fetch(
        `/api/portal/invoices/payment-links/${encodeURIComponent(linkId)}/status`,
        { cache: 'no-store' },
      );
      if (res.ok) {
        const data = (await res.json()) as { status?: string };
        if (data.status === 'paid') {
          setState({ kind: 'success' });
          return;
        }
        if (data.status === 'expired' || data.status === 'cancelled') {
          setState({ kind: 'error', message: 'Il link di pagamento non è più valido.' });
          return;
        }
      }
    } catch {
      // network blip — keep polling within budget
    }
    await new Promise((r) => setTimeout(r, ms));
  }
  // No confirmation arrived in time → leave the user with "elaborazione in
  // corso" and a link to invoices, NEVER a fake success.
  setState({ kind: 'timeout' });
}
