import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { ArrowRight, FileText } from 'lucide-react';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalStatBlock } from '@/components/portal/PortalStatBlock';
import { PortalTable } from '@/components/portal/PortalTable';
import { PortalEmptyState } from '@/components/portal/PortalEmptyState';
import { PayButton } from '@/components/portal/PayButton';
import { Badge } from '@/components/portal/ui/badge';
import {
  PortalDisplay,
  PortalH1,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getCustomer,
  getInvoices,
  getPaymentSchedules,
  PortalUnauthorizedError,
  type PortalInvoice,
  type PortalPaymentSchedule,
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

function invoiceStatusVariant(invoice: PortalInvoice): 'default' | 'success' | 'destructive' | 'muted' {
  const status = invoice.payment_status ?? invoice.status;
  if (status === 'paid') return 'success';
  if (status === 'overdue') return 'destructive';
  if (status === 'pending' || status === 'open') return 'default';
  return 'muted';
}

function scheduleStatusVariant(s: PortalPaymentSchedule): 'default' | 'success' | 'destructive' | 'muted' {
  if (s.status === 'paid') return 'success';
  if (s.status === 'overdue') return 'destructive';
  if (s.status === 'pending' || s.status === 'due' || s.status === 'partial') return 'default';
  return 'muted';
}

export default async function FatturePage({ params }: PageProps) {
  await params;

  try {
    const [customer, invoices, schedules, t, locale] = await Promise.all([
      getCustomer(),
      getInvoices(),
      getPaymentSchedules(),
      getTranslations('portal'),
      getLocale(),
    ]);
    if (!customer) redirect(portalLoginRedirect('/clienti/fatture'));

    const paid = invoices
      .filter((i) => i.status === 'paid' || i.payment_status === 'paid')
      .reduce((sum, i) => sum + Number(i.total || 0), 0);
    const outstanding = schedules
      .filter((s) => s.status !== 'paid' && s.status !== 'cancelled')
      .reduce((sum, s) => sum + (Number(s.amount) - Number(s.paid_amount ?? 0)), 0);

    const payableSchedules = schedules.filter(
      (s) => s.status !== 'paid' && s.status !== 'cancelled',
    );

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.invoices') },
          ]}
        />

        <div className="flex flex-col gap-8 max-w-[1280px]">
          <header className="flex flex-col gap-2">
            <PortalLabel>{t('invoices.eyebrow')}</PortalLabel>
            <PortalDisplay>{t('invoices.title')}</PortalDisplay>
            <PortalBody className="text-muted-foreground max-w-[55ch]">
              {t('invoices.intro')}
            </PortalBody>
          </header>

          <PortalStatBlock
            eyebrow={t('invoices.stats.label')}
            stats={[
              { label: t('invoices.stats.outstanding'), value: formatPortalCurrency(outstanding, locale) },
              { label: t('invoices.stats.paid'), value: formatPortalCurrency(paid, locale) },
              { label: t('invoices.stats.count'), value: invoices.length },
            ]}
          />

          {payableSchedules.length > 0 && (
            <section className="flex flex-col gap-5">
              <PortalH1>{t('payment.payNow')}</PortalH1>
              <ul className="flex flex-col gap-3">
                {payableSchedules.map((s) => {
                  const remaining = Number(s.amount) - Number(s.paid_amount ?? 0);
                  const hasStripe = s.payment_links.some((l) => l.provider === 'stripe' && l.status === 'active');
                  const hasPaypal = s.payment_links.some((l) => l.provider === 'paypal' && l.status === 'active');
                  return (
                    <li
                      key={s.id}
                      className="flex flex-col gap-3 rounded-sm border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex flex-col gap-1">
                        <span className="text-portal-label uppercase tracking-wider text-muted-foreground">
                          {t(`payment.scheduleType.${s.schedule_type}`)}
                        </span>
                        <span className="text-portal-body font-medium text-foreground">
                          {s.title || s.project?.name || '—'}
                        </span>
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-portal-body text-muted-foreground">
                          <span className="text-foreground font-medium tabular-nums">
                            {formatPortalCurrency(remaining, locale, s.currency)}
                          </span>
                          {s.due_date && (
                            <span>{t('payment.due', { date: formatPortalDate(s.due_date, locale) })}</span>
                          )}
                          <Badge variant={scheduleStatusVariant(s)}>
                            {formatPortalStatus(s.status, t)}
                          </Badge>
                        </div>
                      </div>
                      <PayButton
                        scheduleId={s.id}
                        providers={[
                          ...(hasStripe || !hasPaypal ? ['stripe' as const] : []),
                          ...(hasPaypal || !hasStripe ? ['paypal' as const] : []),
                        ]}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-5">
            <PortalH1>{t('billing.history')}</PortalH1>
            <PortalTable<PortalInvoice>
              rows={invoices}
              columns={[
                {
                  key: 'invoice_number',
                  header: t('invoices.columns.number'),
                  width: 'w-32',
                  render: (invoice) => (
                    <Link
                      href={`/clienti/fatture/${invoice.id}`}
                      className="text-portal-body text-foreground font-mono font-medium hover:underline"
                    >
                      {invoice.invoice_number}
                    </Link>
                  ),
                },
                {
                  key: 'issue_date',
                  header: t('invoices.columns.issueDate'),
                  width: 'w-32',
                  render: (invoice) => (
                    <span className="text-portal-body text-muted-foreground tabular-nums">
                      {formatPortalDate(invoice.issue_date, locale)}
                    </span>
                  ),
                },
                {
                  key: 'due_date',
                  header: t('invoices.columns.dueDate'),
                  width: 'w-32',
                  render: (invoice) => (
                    <span className="text-portal-body text-muted-foreground tabular-nums">
                      {formatPortalDate(invoice.due_date, locale)}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: t('invoices.columns.status'),
                  width: 'w-32',
                  render: (invoice) => (
                    <Badge variant={invoiceStatusVariant(invoice)}>
                      {formatPortalStatus(invoice.payment_status ?? invoice.status, t)}
                    </Badge>
                  ),
                },
                {
                  key: 'total',
                  header: t('invoices.columns.total'),
                  width: 'w-40',
                  align: 'right',
                  render: (invoice) => {
                    const total = Number(invoice.total ?? 0);
                    const paid = Number(invoice.amount_paid ?? 0);
                    const currency = invoice.currency ?? 'EUR';
                    const isPartial = paid > 0 && paid < total;
                    if (isPartial) {
                      return (
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="text-portal-body text-foreground font-medium tabular-nums">
                            {formatPortalCurrency(paid, locale, currency)} <span className="text-muted-foreground"> / </span>
                            <span className="text-muted-foreground">{formatPortalCurrency(total, locale, currency)}</span>
                          </span>
                          <span className="text-portal-label uppercase tracking-wider text-muted-foreground">
                            {Math.round((paid / total) * 100)}% saldato
                          </span>
                        </div>
                      );
                    }
                    return (
                      <span className="text-portal-body text-foreground font-medium tabular-nums">
                        {formatPortalCurrency(total, locale, currency)}
                      </span>
                    );
                  },
                },
                {
                  key: 'action',
                  header: '',
                  width: 'w-10',
                  align: 'right',
                  render: (invoice) => (
                    <Link
                      href={`/clienti/fatture/${invoice.id}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={t('invoices.table.open')}
                    >
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  ),
                },
              ]}
              emptyState={
                <PortalEmptyState
                  eyebrow={t('invoices.empty.eyebrow')}
                  title={t('invoices.empty.title')}
                  description={t('invoices.empty.description')}
                />
              }
            />
          </section>
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect('/clienti/fatture'));
    }
    throw error;
  }
}
