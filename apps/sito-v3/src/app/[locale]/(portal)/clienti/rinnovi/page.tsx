import { PortalRedirect } from '@/components/portal/PortalRedirect';
import { getLocale, getTranslations } from 'next-intl/server';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalTimeline } from '@/components/portal/PortalTimeline';
import { PortalEmptyState } from '@/components/portal/PortalEmptyState';
import {
  PortalDisplay,
  PortalH1,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getRenewals,
  LegalAcceptanceRequiredError,
  PortalUnauthorizedError,
  requirePortalAccess,
} from '@/lib/portal-api';
import {
  formatPortalCurrency,
  formatPortalDate,
  formatPortalStatus,
  getPortalCustomerLabel,
} from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export default async function RenewalsPage({ params }: PageProps) {
  await params;

  try {
    const [customer, renewals, t, locale] = await Promise.all([
      requirePortalAccess(),
      getRenewals(),
      getTranslations('portal'),
      getLocale(),
    ]);

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)} role={customer.role}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.renewals') },
          ]}
        />

        <div className="flex flex-col gap-8 max-w-[1280px]">
          <header className="flex flex-col gap-2">
            <PortalLabel>{t('renewals.eyebrow')}</PortalLabel>
            <PortalDisplay>{t('renewals.title')}</PortalDisplay>
            <PortalBody className="text-muted-foreground max-w-[55ch]">
              {t('renewals.intro')}
            </PortalBody>
          </header>

          <section className="flex flex-col gap-5">
            <PortalH1>{t('renewals.calendar')}</PortalH1>
            {renewals.length === 0 ? (
              <PortalEmptyState
                eyebrow={t('renewals.empty.eyebrow')}
                title={t('renewals.empty.title')}
                description={t('renewals.empty.description')}
              />
            ) : (
              <PortalTimeline
                items={renewals.map((renewal) => ({
                  date: formatPortalDate(renewal.next_billing_date, locale, {
                    day: '2-digit',
                    month: 'short',
                  }),
                  title: renewal.name,
                  description: [
                    renewal.description,
                    formatPortalStatus(renewal.status, t),
                    formatPortalCurrency(renewal.amount, locale, renewal.currency ?? 'EUR'),
                    renewal.auto_renew ? t('renewals.auto') : t('renewals.manual'),
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  status:
                    renewal.status === 'past_due' || renewal.status === 'expiring_soon'
                      ? 'urgent'
                      : 'default',
                }))}
              />
            )}
          </section>
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      return <PortalRedirect to="/clienti/login" />;
    }
    if (error instanceof LegalAcceptanceRequiredError) {
      return <PortalRedirect to="/clienti/accettazione-legale" />;
    }
    throw error;
  }
}
