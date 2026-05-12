import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalCard } from '@/components/portal/PortalCard';
import { PortalStatBlock } from '@/components/portal/PortalStatBlock';
import { PortalTimeline } from '@/components/portal/PortalTimeline';
import { PortalEmptyState } from '@/components/portal/PortalEmptyState';
import {
  PortalDisplay,
  PortalH1,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getCustomer,
  getDashboard,
  getInvoices,
  getProjects,
  getRenewals,
  PortalUnauthorizedError,
} from '@/lib/portal-api';
import {
  formatPortalCurrency,
  formatPortalDate,
  formatPortalStatus,
  getPortalCustomerLabel,
  portalLoginRedirect,
} from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';
import { Link } from '@/i18n/navigation';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export default async function ClientiDashboardPage({ params }: PageProps) {
  await params;

  try {
    const [customer, dashboard, projects, invoices, renewals, t, locale] = await Promise.all([
      getCustomer(),
      getDashboard(),
      getProjects(),
      getInvoices(),
      getRenewals(),
      getTranslations('portal'),
      getLocale(),
    ]);

    if (!customer) redirect(portalLoginRedirect('/clienti/dashboard'));

    const activeProjects = projects.filter(
      (project) => !['completed', 'cancelled', 'on_hold', 'draft'].includes(project.status)
    );
    const nextRenewals = renewals.slice(0, 4);
    const paidTotal = invoices
      .filter((invoice) => invoice.status === 'paid' || invoice.payment_status === 'paid')
      .reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar breadcrumbs={[{ label: t('nav.items.dashboard') }]} />

        <div className="flex flex-col gap-10 max-w-[1280px]">
          <header className="flex flex-col gap-3">
            <PortalLabel>{t('dashboard.eyebrow')}</PortalLabel>
            <PortalDisplay>{t('dashboard.title')}</PortalDisplay>
            <PortalBody className="text-muted-foreground max-w-[55ch]">
              {t('dashboard.intro')}
            </PortalBody>
          </header>

          <PortalStatBlock
            eyebrow={t('dashboard.stats.label')}
            stats={[
              { label: t('dashboard.stats.activeProjects'), value: dashboard.stats.active_projects },
              { label: t('dashboard.stats.openInvoices'), value: dashboard.stats.open_invoices },
              {
                label: t('dashboard.stats.pending'),
                value: formatPortalCurrency(dashboard.stats.total_pending, locale),
              },
              { label: t('dashboard.stats.paid'), value: formatPortalCurrency(paidTotal, locale) },
            ]}
          />

          <section className="flex flex-col gap-5">
            <div className="flex items-baseline justify-between gap-3">
              <PortalH1>{t('dashboard.activeProjects.title')}</PortalH1>
              <PortalLabel
                as={Link}
                href="/clienti/progetti"
                className="hover:text-foreground transition-colors"
              >
                {t('dashboard.activeProjects.viewAll')}
              </PortalLabel>
            </div>

            {activeProjects.length === 0 ? (
              <PortalEmptyState
                eyebrow={t('dashboard.activeProjects.empty.eyebrow')}
                title={t('dashboard.activeProjects.empty.title')}
                description={t('dashboard.activeProjects.empty.description')}
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {activeProjects.slice(0, 4).map((project) => (
                  <PortalCard
                    key={project.id}
                    eyebrow={formatPortalStatus(project.status, t)}
                    title={project.name}
                    description={
                      project.client_notes ??
                      project.project_type ??
                      t('dashboard.activeProjects.fallbackDescription')
                    }
                    meta={`${project.progress_percentage ?? 0}%`}
                    href={`/clienti/progetti/${project.id}`}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-5">
            <div className="flex items-baseline justify-between gap-3">
              <PortalH1>{t('dashboard.renewals.title')}</PortalH1>
              <PortalLabel
                as={Link}
                href="/clienti/rinnovi"
                className="hover:text-foreground transition-colors"
              >
                {t('dashboard.renewals.viewAll')}
              </PortalLabel>
            </div>

            {nextRenewals.length === 0 ? (
              <PortalEmptyState
                eyebrow={t('dashboard.renewals.empty.eyebrow')}
                title={t('dashboard.renewals.empty.title')}
                description={t('dashboard.renewals.empty.description')}
              />
            ) : (
              <PortalTimeline
                items={nextRenewals.map((renewal) => ({
                  date: formatPortalDate(renewal.next_billing_date, locale, {
                    day: '2-digit',
                    month: 'short',
                  }),
                  title: renewal.name,
                  description: `${formatPortalStatus(renewal.status, t)} · ${formatPortalCurrency(
                    renewal.amount,
                    locale,
                    renewal.currency ?? 'EUR'
                  )}`,
                  status:
                    renewal.status === 'past_due' || renewal.status === 'expiring_soon'
                      ? 'urgent'
                      : 'default',
                }))}
              />
            )}
          </section>

          {dashboard.recent_activity.length > 0 && (
            <section className="flex flex-col gap-5">
              <PortalH1>{t('dashboard.activity.title')}</PortalH1>
              <PortalTimeline
                items={dashboard.recent_activity.map((event) => ({
                  date: formatPortalDate(event.created_at, locale, { day: '2-digit', month: 'short' }),
                  title: event.title,
                  description: event.project_name
                    ? `${event.project_name} · ${event.description ?? ''}`
                    : event.description,
                  status: event.action_required ? 'urgent' : event.is_read ? 'done' : 'default',
                }))}
              />
            </section>
          )}
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect('/clienti/dashboard'));
    }
    throw error;
  }
}
