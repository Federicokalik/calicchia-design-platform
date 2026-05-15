import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Download } from 'lucide-react';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalStatBlock } from '@/components/portal/PortalStatBlock';
import { ReportChart } from '@/components/portal/ReportChart';
import { Button } from '@/components/portal/ui/button';
import {
  PortalDisplay,
  PortalH1,
  PortalH2,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getCustomer,
  getReport,
  PortalUnauthorizedError,
} from '@/lib/portal-api';
import {
  formatPortalMonth,
  getPortalCustomerLabel,
  portalLoginRedirect,
} from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale; id: string }>;
}

export default async function ReportDetailPage({ params }: PageProps) {
  const { id } = await params;

  try {
    const [customer, report, t, locale] = await Promise.all([
      getCustomer(),
      getReport(id),
      getTranslations('portal'),
      getLocale(),
    ]);
    if (!customer) redirect(portalLoginRedirect(`/clienti/report/${id}`));
    if (!report) notFound();

    const period = formatPortalMonth(report.month, report.year, locale);
    const metrics = report.data?.metrics ?? [];
    const sections = report.data?.sections ?? [];

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.reports'), href: '/clienti/report' },
            { label: period },
          ]}
          right={
            report.pdf_url ? (
              <Button asChild variant="outline" size="sm">
                <a href={report.pdf_url} target="_blank" rel="noopener noreferrer">
                  <Download className="h-3.5 w-3.5" />
                  {t('reports.detail.downloadPdf')}
                </a>
              </Button>
            ) : null
          }
        />

        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-8 max-w-[1280px]">
          <aside className="self-start">
            <PortalLabel>{t('reports.detail.summary')}</PortalLabel>
            <ol className="mt-3 flex flex-col border-t border-border">
              {[t('reports.detail.data'), ...sections.map((section) => section.title)].map(
                (title, index) => (
                  <li key={`${title}-${index}`} className="border-b border-border">
                    <a
                      href={`#section-${index}`}
                      className="flex items-baseline gap-3 py-2.5 text-portal-body text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <span className="font-mono text-portal-caption tabular-nums text-muted-foreground/70">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      {title}
                    </a>
                  </li>
                )
              )}
            </ol>
          </aside>

          <article className="flex flex-col gap-10">
            <header className="flex flex-col gap-2">
              <PortalLabel>{period}</PortalLabel>
              <PortalDisplay>{report.title}</PortalDisplay>
              {report.summary && (
                <PortalBody className="text-muted-foreground max-w-[60ch] leading-relaxed">
                  {report.summary}
                </PortalBody>
              )}
            </header>

            {metrics.length > 0 && (
              <PortalStatBlock
                eyebrow={t('reports.detail.kpi')}
                stats={metrics.slice(0, 4).map((metric) => ({
                  label: metric.label,
                  value: metric.value,
                  trend: metric.delta ?? metric.previous ?? undefined,
                }))}
              />
            )}

            <section id="section-0" className="flex flex-col gap-4 scroll-mt-32">
              <PortalH1>{t('reports.detail.data')}</PortalH1>
              <ReportChart data={report.data} />
            </section>

            {sections.map((section, index) => (
              <section
                key={`${section.title}-${index}`}
                id={`section-${index + 1}`}
                className="flex flex-col gap-3 scroll-mt-32"
              >
                <PortalLabel className="font-mono">
                  {String(index + 2).padStart(2, '0')}
                </PortalLabel>
                <PortalH2>{section.title}</PortalH2>
                {section.body && (
                  <PortalBody className="text-muted-foreground max-w-[60ch] leading-relaxed">
                    {section.body}
                  </PortalBody>
                )}
                {section.rows && <ReportChart data={{ rows: section.rows }} />}
              </section>
            ))}
          </article>
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect(`/clienti/report/${id}`));
    }
    throw error;
  }
}
