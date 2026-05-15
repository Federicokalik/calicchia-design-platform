import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalTable } from '@/components/portal/PortalTable';
import { PortalEmptyState } from '@/components/portal/PortalEmptyState';
import { Badge } from '@/components/portal/ui/badge';
import {
  PortalDisplay,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getCustomer,
  getSubscriptions,
  PortalUnauthorizedError,
  type PortalSubscription,
} from '@/lib/portal-api';
import {
  formatPortalCurrency,
  formatPortalDate,
  formatPortalStatus,
  getPortalCustomerLabel,
  portalLoginRedirect,
} from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

function subStatusVariant(s: PortalSubscription): 'default' | 'success' | 'destructive' | 'muted' {
  const status = s.status.toLowerCase();
  if (status === 'active' || status === 'trialing') return 'success';
  if (status === 'past_due' || status === 'unpaid') return 'destructive';
  if (status === 'canceled' || status === 'cancelled' || status === 'incomplete_expired') return 'muted';
  return 'default';
}

export default async function AbbonamentiPage({ params }: PageProps) {
  await params;

  try {
    const [customer, subs, t, locale] = await Promise.all([
      getCustomer(),
      getSubscriptions(),
      getTranslations('portal'),
      getLocale(),
    ]);
    if (!customer) redirect(portalLoginRedirect('/clienti/abbonamenti'));

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.subscriptions') },
          ]}
        />

        <div className="flex flex-col gap-8 max-w-[1280px]">
          <header className="flex flex-col gap-2">
            <PortalLabel>{t('subscriptions.eyebrow')}</PortalLabel>
            <PortalDisplay>{t('subscriptions.title')}</PortalDisplay>
            <PortalBody className="text-muted-foreground max-w-[55ch]">
              {t('subscriptions.intro')}
            </PortalBody>
          </header>

          <PortalTable<PortalSubscription>
            rows={subs}
            columns={[
              {
                key: 'name',
                header: t('subscriptions.columns.name'),
                render: (s) => (
                  <span className="text-portal-body text-foreground font-medium">{s.name}</span>
                ),
              },
              {
                key: 'provider',
                header: t('subscriptions.columns.provider'),
                width: 'w-28',
                render: (s) => (
                  <Badge variant="muted">{s.provider === 'stripe' ? 'Stripe' : 'PayPal'}</Badge>
                ),
              },
              {
                key: 'amount',
                header: t('subscriptions.columns.amount'),
                width: 'w-32',
                align: 'right',
                render: (s) => (
                  <span className="text-portal-body text-foreground tabular-nums">
                    {formatPortalCurrency(Number(s.amount), locale, s.currency)}
                  </span>
                ),
              },
              {
                key: 'interval',
                header: t('subscriptions.columns.interval'),
                width: 'w-32',
                render: (s) => (
                  <span className="text-portal-body text-muted-foreground">
                    {s.billing_interval === 'month'
                      ? t('subscriptions.interval.month')
                      : s.billing_interval === 'year'
                        ? t('subscriptions.interval.year')
                        : s.billing_interval}
                  </span>
                ),
              },
              {
                key: 'next',
                header: t('subscriptions.columns.next'),
                width: 'w-32',
                render: (s) => (
                  <span className="text-portal-body text-muted-foreground tabular-nums">
                    {formatPortalDate(s.next_billing_date, locale)}
                  </span>
                ),
              },
              {
                key: 'status',
                header: t('subscriptions.columns.status'),
                width: 'w-36',
                render: (s) => (
                  <div className="flex flex-col gap-1">
                    <Badge variant={subStatusVariant(s)}>{formatPortalStatus(s.status, t)}</Badge>
                    {!s.auto_renew && (
                      <span className="text-portal-label uppercase tracking-wider text-muted-foreground">
                        {t('subscriptions.noAutoRenew')}
                      </span>
                    )}
                  </div>
                ),
              },
            ]}
            emptyState={
              <PortalEmptyState
                eyebrow={t('subscriptions.empty.eyebrow')}
                title={t('subscriptions.empty.title')}
                description={t('subscriptions.empty.description')}
              />
            }
          />

          {subs.length > 0 && (
            <PortalBody className="text-muted-foreground text-portal-caption max-w-[60ch]">
              {t('subscriptions.manageHint')}
            </PortalBody>
          )}
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect('/clienti/abbonamenti'));
    }
    throw error;
  }
}
