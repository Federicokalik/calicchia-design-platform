import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Download, ExternalLink } from 'lucide-react';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PayButton } from '@/components/portal/PayButton';
import { Badge } from '@/components/portal/ui/badge';
import { Button } from '@/components/portal/ui/button';
import { Separator } from '@/components/portal/ui/separator';
import {
  PortalDisplay,
  PortalH1,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getCustomer,
  getInvoice,
  getPaymentSchedules,
  PortalUnauthorizedError,
  type PortalInvoiceLineItem,
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
  params: Promise<{ locale: Locale; id: string }>;
}

function isLineItemArray(value: unknown): value is PortalInvoiceLineItem[] {
  return Array.isArray(value);
}

export default async function FatturaDetailPage({ params }: PageProps) {
  const { id } = await params;

  try {
    const [customer, invoice, allSchedules, t, locale] = await Promise.all([
      getCustomer(),
      getInvoice(id),
      getPaymentSchedules(),
      getTranslations('portal'),
      getLocale(),
    ]);
    if (!customer) redirect(portalLoginRedirect(`/clienti/fatture/${id}`));
    if (!invoice) notFound();

    const schedules: PortalPaymentSchedule[] = allSchedules.filter((s) => {
      // Show schedules tied to this invoice OR linked via quote
      // (we don't have invoice_id on schedule list response — so showing all schedules
      // is OK in v1; admin scopes them per project anyway)
      return s.status !== 'cancelled';
    });

    const lineItems = isLineItemArray(invoice.line_items) ? invoice.line_items : [];
    const currency = invoice.currency ?? 'EUR';
    const status = invoice.payment_status ?? invoice.status;
    const isPaid = status === 'paid';

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.invoices'), href: '/clienti/fatture' },
            { label: invoice.invoice_number },
          ]}
        />

        <div className="flex flex-col gap-8 max-w-[1280px]">
          <header className="flex flex-col gap-3">
            <Link
              href="/clienti/fatture"
              className="text-portal-body text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1"
            >
              {t('invoices.detail.back')}
            </Link>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
              <div>
                <PortalLabel>
                  {formatPortalDate(invoice.issue_date, locale)}
                </PortalLabel>
                <PortalDisplay>{invoice.invoice_number}</PortalDisplay>
              </div>
              <Badge variant={isPaid ? 'success' : status === 'overdue' ? 'destructive' : 'default'}>
                {formatPortalStatus(status, t)}
              </Badge>
            </div>
          </header>

          {/* Line items */}
          {lineItems.length > 0 && (
            <section className="flex flex-col gap-3">
              <PortalH1>{t('invoices.detail.lineItems')}</PortalH1>
              <div className="overflow-x-auto rounded-sm border border-border">
                <table className="w-full text-portal-body">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left">
                      <th className="px-4 py-3 font-medium text-muted-foreground">
                        {t('invoices.detail.lineItemColumns.description')}
                      </th>
                      <th className="px-4 py-3 font-medium text-muted-foreground text-right w-20">
                        {t('invoices.detail.lineItemColumns.quantity')}
                      </th>
                      <th className="px-4 py-3 font-medium text-muted-foreground text-right w-32">
                        {t('invoices.detail.lineItemColumns.unitPrice')}
                      </th>
                      <th className="px-4 py-3 font-medium text-muted-foreground text-right w-32">
                        {t('invoices.detail.lineItemColumns.total')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((item, idx) => (
                      <tr key={idx} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 text-foreground">{item.description ?? '—'}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                          {item.quantity ?? 1}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                          {item.unit_price != null
                            ? formatPortalCurrency(Number(item.unit_price), locale, currency)
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium text-foreground">
                          {item.total != null
                            ? formatPortalCurrency(Number(item.total), locale, currency)
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Totals */}
          <section className="flex flex-col gap-2 max-w-md ml-auto w-full text-portal-body">
            <div className="flex justify-between text-muted-foreground">
              <span>{t('invoices.detail.totals.subtotal')}</span>
              <span className="tabular-nums">{formatPortalCurrency(invoice.subtotal, locale, currency)}</span>
            </div>
            {Number(invoice.tax_amount ?? 0) > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>{t('invoices.detail.totals.tax')}</span>
                <span className="tabular-nums">{formatPortalCurrency(invoice.tax_amount, locale, currency)}</span>
              </div>
            )}
            <Separator className="my-1" />
            <div className="flex justify-between text-foreground font-medium">
              <span>{t('invoices.detail.totals.total')}</span>
              <span className="tabular-nums">{formatPortalCurrency(invoice.total, locale, currency)}</span>
            </div>
            {Number(invoice.amount_paid ?? 0) > 0 && (
              <>
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('invoices.detail.totals.paid')}</span>
                  <span className="tabular-nums">{formatPortalCurrency(invoice.amount_paid ?? 0, locale, currency)}</span>
                </div>
                <div className="flex justify-between text-foreground font-medium">
                  <span>{t('invoices.detail.totals.due')}</span>
                  <span className="tabular-nums">{formatPortalCurrency(invoice.amount_due ?? 0, locale, currency)}</span>
                </div>
              </>
            )}
          </section>

          {/* Payment schedules (rate da pagare) */}
          {schedules.filter((s) => s.status !== 'paid').length > 0 && !isPaid && (
            <section className="flex flex-col gap-5">
              <PortalH1>{t('invoices.detail.paymentPlan')}</PortalH1>
              <ul className="flex flex-col gap-3">
                {schedules
                  .filter((s) => s.status !== 'paid')
                  .map((s) => {
                    const remaining = Number(s.amount) - Number(s.paid_amount ?? 0);
                    return (
                      <li
                        key={s.id}
                        className="flex flex-col gap-3 rounded-sm border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex flex-col gap-1">
                          <PortalLabel>{t(`payment.scheduleType.${s.schedule_type}`)}</PortalLabel>
                          <span className="text-foreground font-medium tabular-nums">
                            {formatPortalCurrency(remaining, locale, s.currency)}
                          </span>
                          {s.due_date && (
                            <span className="text-portal-body text-muted-foreground">
                              {t('payment.due', { date: formatPortalDate(s.due_date, locale) })}
                            </span>
                          )}
                        </div>
                        <PayButton scheduleId={s.id} />
                      </li>
                    );
                  })}
              </ul>
            </section>
          )}

          {/* Stripe-issued PDF / hosted invoice */}
          {(invoice.stripe_hosted_invoice_url || invoice.stripe_invoice_pdf) && (
            <section className="flex flex-wrap gap-3">
              {invoice.stripe_hosted_invoice_url && (
                <Button asChild variant="outline" size="sm">
                  <a href={invoice.stripe_hosted_invoice_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden />
                    {t('invoices.detail.stripeInvoice')}
                  </a>
                </Button>
              )}
              {invoice.stripe_invoice_pdf && (
                <Button asChild variant="outline" size="sm">
                  <a href={invoice.stripe_invoice_pdf} target="_blank" rel="noopener noreferrer">
                    <Download aria-hidden />
                    {t('invoices.detail.stripePdf')}
                  </a>
                </Button>
              )}
            </section>
          )}
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect(`/clienti/fatture/${id}`));
    }
    throw error;
  }
}
