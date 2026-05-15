import { redirect } from '@/i18n/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalTable } from '@/components/portal/PortalTable';
import { PortalEmptyState } from '@/components/portal/PortalEmptyState';
import { Badge } from '@/components/portal/ui/badge';
import {
  PortalDisplay,
  PortalH3,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getCustomer,
  getProjects,
  PortalUnauthorizedError,
  type PortalProject,
} from '@/lib/portal-api';
import {
  formatPortalDate,
  formatPortalStatus,
  getPortalCustomerLabel,
  portalLoginRedirect,
} from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

function statusVariant(status: string): 'default' | 'success' | 'muted' {
  if (status === 'in_progress' || status === 'review') return 'default';
  if (status === 'completed' || status === 'approved') return 'success';
  return 'muted';
}

export default async function ProgettiListPage({ params }: PageProps) {
  await params;

  try {
    const [customer, projects, t, locale] = await Promise.all([
      getCustomer(),
      getProjects(),
      getTranslations('portal'),
      getLocale(),
    ]);
    if (!customer) redirect(portalLoginRedirect('/clienti/progetti'));

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.projects') },
          ]}
        />

        <div className="flex flex-col gap-8 max-w-[1280px]">
          <header className="flex flex-col gap-2">
            <PortalLabel>{t('projects.list.eyebrow')}</PortalLabel>
            <PortalDisplay>{t('projects.list.title')}</PortalDisplay>
          </header>

          <PortalTable<PortalProject>
            rows={projects}
            rowHref={(project) => `/clienti/progetti/${project.id}`}
            columns={[
              {
                key: 'name',
                header: t('projects.list.columns.project'),
                width: 'flex-[2]',
                render: (project) => (
                  <PortalH3 className="font-[family-name:var(--font-display)] tracking-tight">
                    {project.name}
                  </PortalH3>
                ),
              },
              {
                key: 'status',
                header: t('projects.list.columns.status'),
                width: 'flex-1',
                render: (project) => (
                  <Badge variant={statusVariant(project.status)}>
                    {formatPortalStatus(project.status, t)}
                  </Badge>
                ),
              },
              {
                key: 'target_end_date',
                header: t('projects.list.columns.dueDate'),
                width: 'flex-1',
                render: (project) => (
                  <span className="text-portal-body text-muted-foreground">
                    {formatPortalDate(project.target_end_date, locale)}
                  </span>
                ),
              },
              {
                key: 'unread_messages',
                header: t('projects.list.columns.messages'),
                width: 'w-24',
                align: 'right',
                render: (project) =>
                  project.unread_messages ? (
                    <Badge variant="default">{project.unread_messages}</Badge>
                  ) : (
                    <span className="text-portal-body text-muted-foreground tabular-nums">0</span>
                  ),
              },
              {
                key: 'progress_percentage',
                header: t('projects.list.columns.progress'),
                width: 'w-24',
                align: 'right',
                render: (project) => (
                  <span className="text-portal-body text-foreground font-medium tabular-nums">
                    {project.progress_percentage ?? 0}%
                  </span>
                ),
              },
            ]}
            emptyState={
              <PortalEmptyState
                eyebrow={t('projects.list.empty.eyebrow')}
                title={t('projects.list.empty.title')}
                description={t('projects.list.empty.description')}
              />
            }
          />
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect('/clienti/progetti'));
    }
    throw error;
  }
}
