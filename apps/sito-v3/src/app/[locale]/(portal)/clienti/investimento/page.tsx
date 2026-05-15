import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalStatBlock } from '@/components/portal/PortalStatBlock';
import { PortalTable } from '@/components/portal/PortalTable';
import { PortalEmptyState } from '@/components/portal/PortalEmptyState';
import { Badge } from '@/components/portal/ui/badge';
import {
  PortalDisplay,
  PortalH1,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getCustomer,
  getInvoices,
  PortalUnauthorizedError,
  type PortalInvoice,
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

export default async function InvestmentPage({ params }: PageProps) {
  await params;

  try {
    const [customer, invoices, t, locale] = await Promise.all([
      getCustomer(),
      getInvoices(),
      getTranslations('portal'),
      getLocale(),
    ]);
    if (!customer) redirect(portalLoginRedirect('/clienti/investimento'));

    const total = invoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);
    const paid = invoices
      .filter((invoice) => invoice.status === 'paid' || invoice.payment_status === 'paid')
      .reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);
    const pending = invoices
      .filter((invoice) => invoice.status === 'open' || invoice.payment_status === 'pending')
      .reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.billing') },
          ]}
        />

        <div className="flex flex-col gap-8 max-w-[1280px]">
          <header className="flex flex-col gap-2">
            <PortalLabel>{t('billing.eyebrow')}</PortalLabel>
            <PortalDisplay>{t('billing.title')}</PortalDisplay>
          </header>

          <PortalStatBlock
            eyebrow={t('billing.stats.label')}
            stats={[
              { label: t('billing.stats.total'), value: formatPortalCurrency(total, locale) },
              { label: t('billing.stats.paid'), value: formatPortalCurrency(paid, locale) },
              { label: t('billing.stats.pending'), value: formatPortalCurrency(pending, locale) },
              { label: t('billing.stats.invoices'), value: invoices.length },
            ]}
          />

          <section className="flex flex-col gap-5">
            <PortalH1>{t('billing.history')}</PortalH1>
            <PortalTable<PortalInvoice>
              rows={invoices}
              columns={[
                {
                  key: 'invoice_number',
                  header: t('billing.columns.number'),
                  width: 'w-32',
                  render: (invoice) => (
                    <span className="text-portal-body text-foreground font-mono font-medium">
                      {invoice.invoice_number}
                    </span>
                  ),
                },
                {
                  key: 'issue_date',
                  header: t('billing.columns.issueDate'),
                  width: 'w-32',
                  render: (invoice) => (
                    <span className="text-portal-body text-muted-foreground tabular-nums">
                      {formatPortalDate(invoice.issue_date, locale)}
                    </span>
                  ),
                },
                {
                  key: 'due_date',
                  header: t('billing.columns.dueDate'),
                  width: 'w-32',
                  render: (invoice) => (
                    <span className="text-portal-body text-muted-foreground tabular-nums">
                      {formatPortalDate(invoice.due_date, locale)}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: t('billing.columns.status'),
                  width: 'w-28',
                  render: (invoice) => (
                    <Badge variant={invoiceStatusVariant(invoice)}>
                      {formatPortalStatus(invoice.payment_status ?? invoice.status, t)}
                    </Badge>
                  ),
                },
                {
                  key: 'total',
                  header: t('billing.columns.total'),
                  width: 'w-32',
                  align: 'right',
                  render: (invoice) => (
                    <span className="text-portal-body text-foreground font-medium tabular-nums">
                      {formatPortalCurrency(invoice.total, locale)}
                    </span>
                  ),
                },
              ]}
              emptyState={
                <PortalEmptyState
                  eyebrow={t('billing.empty.eyebrow')}
                  title={t('billing.empty.title')}
                  description={t('billing.empty.description')}
                />
              }
            />
          </section>
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect('/clienti/investimento'));
    }
    throw error;
  }
}
