import { PortalRedirect } from '@/components/portal/PortalRedirect';
import { getLocale, getTranslations } from 'next-intl/server';
import { PenLine, ArrowUpRight } from 'lucide-react';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalStatBlock } from '@/components/portal/PortalStatBlock';
import { PortalTable } from '@/components/portal/PortalTable';
import { PortalEmptyState } from '@/components/portal/PortalEmptyState';
import { Badge } from '@/components/portal/ui/badge';
import {
  PortalDisplay,
  PortalH1,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getQuotes,
  LegalAcceptanceRequiredError,
  PortalUnauthorizedError,
  PortalForbiddenError,
  requirePortalAccess,
  type PortalQuote,
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

function quoteStatusVariant(q: PortalQuote): 'default' | 'success' | 'destructive' | 'muted' {
  if (q.status === 'signed') return 'success';
  if (q.status === 'sent' || q.status === 'viewed') return 'default';
  return 'muted';
}

export default async function PreventiviPage({ params }: PageProps) {
  await params;

  try {
    const [customer, quotes, t, locale] = await Promise.all([
      requirePortalAccess(),
      getQuotes(),
      getTranslations('portal'),
      getLocale(),
    ]);

    const toSign = quotes.filter((q) => q.status !== 'signed');
    const signed = quotes.filter((q) => q.status === 'signed');

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)} role={customer.role}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.quotes') },
          ]}
        />

        <div className="flex flex-col gap-8 max-w-[1280px]">
          <header className="flex flex-col gap-2">
            <PortalLabel>{t('quotes.eyebrow')}</PortalLabel>
            <PortalDisplay>{t('quotes.title')}</PortalDisplay>
            <PortalBody className="text-muted-foreground max-w-[55ch]">
              {t('quotes.intro')}
            </PortalBody>
          </header>

          <PortalStatBlock
            eyebrow={t('quotes.stats.label')}
            stats={[
              { label: t('quotes.stats.toSign'), value: toSign.length },
              { label: t('quotes.stats.signed'), value: signed.length },
              {
                label: t('quotes.stats.signedValue'),
                value: formatPortalCurrency(
                  signed.reduce((sum, q) => sum + Number(q.total || 0), 0),
                  locale,
                ),
              },
            ]}
          />

          {toSign.length > 0 && (
            <section className="flex flex-col gap-5">
              <PortalH1>{t('quotes.signNow')}</PortalH1>
              <ul className="flex flex-col gap-3">
                {toSign.map((q) => (
                  <li
                    key={q.id}
                    className="flex flex-col gap-3 rounded-sm border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex flex-col gap-1">
                      <span className="text-portal-label uppercase tracking-wider text-muted-foreground">
                        {q.quote_number || t('quotes.eyebrow')}
                      </span>
                      <span className="text-portal-body font-medium text-foreground">{q.title}</span>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-portal-body text-muted-foreground">
                        <span className="text-foreground font-medium tabular-nums">
                          {formatPortalCurrency(q.total, locale, q.currency)}
                        </span>
                        {q.valid_until && (
                          <span>{t('quotes.validUntil', { date: formatPortalDate(q.valid_until, locale) })}</span>
                        )}
                        <Badge variant={quoteStatusVariant(q)}>{formatPortalStatus(q.status, t)}</Badge>
                      </div>
                    </div>
                    {/* External admin-hosted sign page (OTP flow) — plain <a>,
                        not next-intl Link: different origin, full page load. */}
                    <a
                      href={q.sign_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-2 rounded-sm border border-primary bg-primary px-5 py-2.5 text-portal-body font-medium text-primary-foreground transition-opacity hover:opacity-90"
                    >
                      <PenLine className="h-4 w-4" aria-hidden />
                      {t('quotes.table.sign')}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-5">
            <PortalH1>{t('quotes.history')}</PortalH1>
            <PortalTable<PortalQuote>
              rows={quotes}
              columns={[
                {
                  key: 'quote_number',
                  header: t('quotes.columns.number'),
                  width: 'w-36',
                  render: (q) => (
                    <span className="text-portal-body text-foreground font-mono font-medium">
                      {q.quote_number || '—'}
                    </span>
                  ),
                },
                {
                  key: 'title',
                  header: t('quotes.columns.title'),
                  render: (q) => (
                    <span className="text-portal-body text-foreground">{q.title}</span>
                  ),
                },
                {
                  key: 'sent_at',
                  header: t('quotes.columns.sentDate'),
                  width: 'w-32',
                  render: (q) => (
                    <span className="text-portal-body text-muted-foreground tabular-nums">
                      {formatPortalDate(q.sent_at ?? q.created_at, locale)}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: t('quotes.columns.status'),
                  width: 'w-32',
                  render: (q) => (
                    <Badge variant={quoteStatusVariant(q)}>{formatPortalStatus(q.status, t)}</Badge>
                  ),
                },
                {
                  key: 'total',
                  header: t('quotes.columns.total'),
                  width: 'w-36',
                  align: 'right',
                  render: (q) => (
                    <span className="text-portal-body text-foreground font-medium tabular-nums">
                      {formatPortalCurrency(q.total, locale, q.currency)}
                    </span>
                  ),
                },
                {
                  key: 'action',
                  header: '',
                  width: 'w-10',
                  align: 'right',
                  render: (q) => (
                    <a
                      href={q.sign_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={q.status === 'signed' ? t('quotes.table.view') : t('quotes.table.sign')}
                    >
                      <ArrowUpRight className="h-4 w-4" />
                    </a>
                  ),
                },
              ]}
              emptyState={
                <PortalEmptyState
                  eyebrow={t('quotes.empty.eyebrow')}
                  title={t('quotes.empty.title')}
                  description={t('quotes.empty.description')}
                />
              }
            />
          </section>
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      return <PortalRedirect to="/clienti/login" />;
    }
    if (error instanceof PortalForbiddenError) {
      return <PortalRedirect to="/clienti/progetti" />;
    }
    if (error instanceof LegalAcceptanceRequiredError) {
      return <PortalRedirect to="/clienti/accettazione-legale" />;
    }
    throw error;
  }
}
