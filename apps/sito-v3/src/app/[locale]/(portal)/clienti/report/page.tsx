import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalTable } from '@/components/portal/PortalTable';
import { PortalEmptyState } from '@/components/portal/PortalEmptyState';
import {
  PortalDisplay,
  PortalH3,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getCustomer,
  getReports,
  PortalUnauthorizedError,
  type PortalReport,
} from '@/lib/portal-api';
import {
  formatPortalDate,
  formatPortalMonth,
  getPortalCustomerLabel,
  portalLoginRedirect,
} from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export default async function ReportListPage({ params }: PageProps) {
  await params;

  try {
    const [customer, reports, t, locale] = await Promise.all([
      getCustomer(),
      getReports(),
      getTranslations('portal'),
      getLocale(),
    ]);
    if (!customer) redirect(portalLoginRedirect('/clienti/report'));

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.reports') },
          ]}
        />

        <div className="flex flex-col gap-8 max-w-[1280px]">
          <header className="flex flex-col gap-2">
            <PortalLabel>{t('reports.list.eyebrow')}</PortalLabel>
            <PortalDisplay>{t('reports.list.title')}</PortalDisplay>
            <PortalBody className="text-muted-foreground max-w-[55ch]">
              {t('reports.list.intro')}
            </PortalBody>
          </header>

          <PortalTable<PortalReport>
            rows={reports}
            rowHref={(report) => `/clienti/report/${report.id}`}
            columns={[
              {
                key: 'title',
                header: t('reports.list.columns.report'),
                width: 'flex-[2]',
                render: (report) => (
                  <PortalH3 className="font-[family-name:var(--font-display)] tracking-tight">
                    {report.title}
                  </PortalH3>
                ),
              },
              {
                key: 'period',
                header: t('reports.list.columns.period'),
                width: 'flex-1',
                render: (report) => (
                  <span className="text-portal-body text-muted-foreground">
                    {formatPortalMonth(report.month, report.year, locale)}
                  </span>
                ),
              },
              {
                key: 'project_name',
                header: t('reports.list.columns.project'),
                width: 'flex-1',
                render: (report) => (
                  <span className="text-portal-body text-muted-foreground">
                    {report.project_name ?? t('reports.list.fallbackProject')}
                  </span>
                ),
              },
              {
                key: 'published_at',
                header: t('reports.list.columns.publishedAt'),
                width: 'w-32',
                align: 'right',
                render: (report) => (
                  <span className="text-portal-caption text-muted-foreground tabular-nums">
                    {formatPortalDate(report.published_at, locale)}
                  </span>
                ),
              },
            ]}
            emptyState={
              <PortalEmptyState
                eyebrow={t('reports.list.empty.eyebrow')}
                title={t('reports.list.empty.title')}
                description={t('reports.list.empty.description')}
              />
            }
          />
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect('/clienti/report'));
    }
    throw error;
  }
}
