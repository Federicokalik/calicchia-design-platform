'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  PayPalScriptProvider,
  PayPalButtons,
  PayPalCardFieldsProvider,
  PayPalNumberField,
  PayPalExpiryField,
  PayPalCVVField,
  usePayPalCardFields,
} from '@paypal/react-paypal-js';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/portal/ui/button';
import { PortalLabel } from '@/components/portal/ui/typography';

interface PaypalEmbeddedProps {
  orderId: string;
  /** Endpoint that captures the PayPal order — receives `{order_id}` in URL. */
  captureEndpoint: string;
  onSuccess: () => void;
  currency?: string;
}

const PAYPAL_CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;

function CardFieldsSubmit({
  onSubmitStart,
  onError,
  pending,
}: {
  onSubmitStart: () => void;
  onError: (msg: string) => void;
  pending: boolean;
}) {
  const t = useTranslations('portal.payment.paypal');
  const { cardFieldsForm } = usePayPalCardFields();

  async function handleClick() {
    if (!cardFieldsForm) return;
    try {
      const formState = await cardFieldsForm.getState();
      if (!formState.isFormValid) {
        onError(t('cardError.invalid'));
        return;
      }
      onSubmitStart();
      await cardFieldsForm.submit();
      // onApprove on PayPalCardFieldsProvider handles the rest.
    } catch (err) {
      onError(t('cardError.generic'));
      console.error('[PaypalEmbedded] cardFields.submit error:', err);
    }
  }

  return (
    <Button
      type="button"
      onClick={handleClick}
      disabled={pending || !cardFieldsForm}
      className="w-full"
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {pending ? t('cardSubmitting') : t('cardSubmit')}
    </Button>
  );
}

export function PaypalEmbedded({
  orderId,
  captureEndpoint,
  onSuccess,
  currency = 'EUR',
}: PaypalEmbeddedProps) {
  const t = useTranslations('portal.payment.paypal');
  const [clientToken, setClientToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/paypal/client-token', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (typeof data.client_token === 'string') {
          setClientToken(data.client_token);
        } else {
          setTokenError(t('initError'));
        }
      })
      .catch(() => {
        if (!cancelled) setTokenError(t('initError'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (!PAYPAL_CLIENT_ID) {
    return (
      <p className="text-portal-body text-destructive">
        {t('configMissing')}
      </p>
    );
  }

  if (tokenError) {
    return <p className="text-portal-body text-destructive">{tokenError}</p>;
  }

  if (!clientToken) {
    return (
      <div className="flex items-center gap-2 text-portal-body text-muted-foreground">
        <Loader2 className="animate-spin" aria-hidden />
        <span>{t('initializing')}</span>
      </div>
    );
  }

  async function capture() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(captureEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
      }
      onSuccess();
    } catch (err) {
      setError((err as Error).message || t('captureError'));
    } finally {
      setPending(false);
    }
  }

  return (
    <PayPalScriptProvider
      options={{
        clientId: PAYPAL_CLIENT_ID,
        currency,
        intent: 'capture',
        components: 'buttons,card-fields',
        dataClientToken: clientToken,
      }}
    >
      <div className="flex flex-col gap-5 rounded-sm border border-border bg-background p-5">
        <div className="flex flex-col gap-2">
          <PortalLabel>{t('buttonsLabel')}</PortalLabel>
          <PayPalButtons
            style={{ layout: 'vertical', shape: 'rect', label: 'pay' }}
            createOrder={() => Promise.resolve(orderId)}
            onApprove={async () => {
              await capture();
            }}
            onError={(err) => {
              console.error('[PayPalButtons] error:', err);
              setError(t('captureError'));
            }}
            disabled={pending}
          />
        </div>

        <CardFieldsSection
          orderId={orderId}
          pending={pending}
          error={error}
          onError={setError}
          onSubmitStart={() => setPending(true)}
          onCapture={capture}
        />

        {error && (
          <p
            role="alert"
            className="text-portal-body text-destructive"
          >
            {error}
          </p>
        )}
      </div>
    </PayPalScriptProvider>
  );
}

/**
 * Card Fields with graceful fallback when ACDC is not enabled on the merchant.
 * Wrapped in its own component so PayPalCardFieldsProvider can throw/fail
 * silently without taking down the PayPalButtons rendering above.
 */
function CardFieldsSection({
  orderId,
  pending,
  onSubmitStart,
  onError,
  onCapture,
  error: _error,
}: {
  orderId: string;
  pending: boolean;
  onSubmitStart: () => void;
  onError: (msg: string) => void;
  onCapture: () => Promise<void>;
  error: string | null;
}) {
  const t = useTranslations('portal.payment.paypal');
  const [eligible, setEligible] = useState<boolean | null>(null);

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-border" aria-hidden />
        <PortalLabel className="text-muted-foreground">{t('cardDivider')}</PortalLabel>
        <div className="h-px flex-1 bg-border" aria-hidden />
      </div>

      <PayPalCardFieldsProvider
        createOrder={() => Promise.resolve(orderId)}
        onApprove={async () => {
          await onCapture();
        }}
        onError={(err) => {
          console.error('[PayPalCardFields] error:', err);
          onError(t('cardError.generic'));
        }}
      >
        <EligibilityProbe onResult={setEligible} />
        {eligible !== false && (
          <div className="flex flex-col gap-3">
            <div className="rounded-sm border border-border bg-background px-3 py-2.5">
              <PortalLabel className="text-muted-foreground mb-1.5">
                {t('cardNumber')}
              </PortalLabel>
              <PayPalNumberField />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-sm border border-border bg-background px-3 py-2.5">
                <PortalLabel className="text-muted-foreground mb-1.5">
                  {t('cardExpiry')}
                </PortalLabel>
                <PayPalExpiryField />
              </div>
              <div className="rounded-sm border border-border bg-background px-3 py-2.5">
                <PortalLabel className="text-muted-foreground mb-1.5">
                  {t('cardCvv')}
                </PortalLabel>
                <PayPalCVVField />
              </div>
            </div>
            <CardFieldsSubmit
              pending={pending}
              onSubmitStart={onSubmitStart}
              onError={onError}
            />
          </div>
        )}
        {eligible === false && (
          <p className="text-portal-body text-muted-foreground">
            {t('cardUnavailable')}
          </p>
        )}
      </PayPalCardFieldsProvider>
    </div>
  );
}

/**
 * Tiny child of PayPalCardFieldsProvider that probes `cardFieldsForm.isEligible()`
 * and reports up. When ACDC isn't enabled on the account, the SDK returns false
 * and we hide the form. When the form itself isn't ready yet, we wait.
 */
function EligibilityProbe({ onResult }: { onResult: (eligible: boolean) => void }) {
  const { cardFieldsForm } = usePayPalCardFields();
  useEffect(() => {
    if (!cardFieldsForm) return;
    try {
      const eligible = cardFieldsForm.isEligible();
      onResult(eligible);
    } catch (err) {
      console.warn('[PaypalEmbedded] isEligible probe failed:', err);
      onResult(false);
    }
  }, [cardFieldsForm, onResult]);
  return null;
}
