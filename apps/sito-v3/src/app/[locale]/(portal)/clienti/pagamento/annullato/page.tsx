'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { XCircle } from 'lucide-react';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import {
  PortalDisplay,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import { Button } from '@/components/portal/ui/button';

/**
 * Return page when the user cancels Stripe Checkout or denies PayPal approval.
 * No DB mutation needed — the payment_link stays `active` so a retry just re-uses it.
 */
export default function PaymentCancelledPage() {
  const t = useTranslations('portal');
  const tCancel = useTranslations('portal.payment.cancelled');

  return (
    <PortalShell userLabel={undefined}>
      <PortalTopbar
        breadcrumbs={[
          { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
          { label: t('nav.items.invoices'), href: '/clienti/fatture' },
          { label: tCancel('title') },
        ]}
      />

      <div className="flex flex-col gap-8 max-w-[640px]">
        <header className="flex flex-col gap-3">
          <XCircle className="h-10 w-10 text-muted-foreground" aria-hidden />
          <PortalLabel>{tCancel('eyebrow')}</PortalLabel>
          <PortalDisplay>{tCancel('title')}</PortalDisplay>
          <PortalBody className="text-muted-foreground">{tCancel('intro')}</PortalBody>
        </header>

        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/clienti/fatture">{tCancel('tryAgain')}</Link>
          </Button>
        </div>
      </div>
    </PortalShell>
  );
}
