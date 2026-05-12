import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalCard } from '@/components/portal/PortalCard';
import { PortalStatBlock } from '@/components/portal/PortalStatBlock';
import { PortalTimeline } from '@/components/portal/PortalTimeline';
import { PipelineSteps } from '@/components/portal/PipelineSteps';
import { MessageThread } from '@/components/portal/MessageThread';
import { DeliverableReview } from '@/components/portal/DeliverableReview';
import {
  PortalDisplay,
  PortalH1,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getCustomer,
  getMessages,
  getProject,
  PortalUnauthorizedError,
} from '@/lib/portal-api';
import {
  formatPortalDate,
  formatPortalStatus,
  getPortalCustomerLabel,
  portalLoginRedirect,
} from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale; id: string }>;
}

function daysUntil(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  const delta = new Date(value).getTime() - Date.now();
  return Math.max(0, Math.ceil(delta / 86_400_000));
}

export default async function ProgettoDetailPage({ params }: PageProps) {
  const { id } = await params;

  try {
    const [customer, project, messages, t, locale] = await Promise.all([
      getCustomer(),
      getProject(id),
      getMessages(id),
      getTranslations('portal'),
      getLocale(),
    ]);

    if (!customer) redirect(portalLoginRedirect(`/clienti/progetti/${id}`));
    if (!project) notFound();

    const milestones = project.milestones ?? [];
    const deliverables = project.deliverables ?? [];
    const pipelineSteps = Array.isArray(project.pipeline_steps) ? project.pipeline_steps : [];
    const completedMilestones = milestones.filter((milestone) => milestone.status === 'completed').length;

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.projects'), href: '/clienti/progetti' },
            { label: project.name },
          ]}
        />

        <div className="flex flex-col gap-10 max-w-[1280px]">
          <header className="flex flex-col gap-3">
            <PortalLabel>{formatPortalStatus(project.status, t)}</PortalLabel>
            <PortalDisplay>{project.name}</PortalDisplay>
            {project.description && (
              <PortalBody className="text-muted-foreground max-w-[60ch]">
                {project.description}
              </PortalBody>
            )}
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-4 pt-6 mt-2 border-t border-border">
              {[
                [t('projects.detail.metaLabels.type'), project.project_type ?? t('projects.detail.metaFallbacks.type')],
                [t('projects.detail.metaLabels.start'), formatPortalDate(project.start_date, locale)],
                [t('projects.detail.metaLabels.due'), formatPortalDate(project.target_end_date, locale)],
                [t('projects.detail.metaLabels.currentStep'), project.current_step ?? t('projects.detail.metaFallbacks.step')],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1">
                  <PortalLabel as="dt">{label}</PortalLabel>
                  <dd className="text-portal-body text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          </header>

          <PortalStatBlock
            eyebrow={t('projects.detail.stats.label')}
            stats={[
              { label: t('projects.detail.stats.progress'), value: `${project.progress_percentage ?? 0}%` },
              {
                label: t('projects.detail.stats.milestones'),
                value: `${completedMilestones}/${milestones.length}`,
              },
              { label: t('projects.detail.stats.deliverables'), value: deliverables.length },
              {
                label: t('projects.detail.stats.daysToTarget'),
                value: daysUntil(project.target_end_date, t('projects.detail.daysNotDefined')),
              },
            ]}
          />

          {pipelineSteps.length > 0 && (
            <section className="flex flex-col gap-5">
              <PortalH1>{t('projects.detail.sections.pipeline')}</PortalH1>
              <PipelineSteps steps={pipelineSteps} currentStep={project.current_step} />
            </section>
          )}

          <section className="flex flex-col gap-5">
            <PortalH1>{t('projects.detail.sections.milestones')}</PortalH1>
            {milestones.length === 0 ? (
              <PortalCard
                eyebrow={t('projects.detail.milestonesEmpty.eyebrow')}
                title={t('projects.detail.milestonesEmpty.title')}
                description={t('projects.detail.milestonesEmpty.description')}
              />
            ) : (
              <PortalTimeline
                items={milestones.map((milestone) => ({
                  date: formatPortalDate(milestone.due_date, locale, { day: '2-digit', month: 'short' }),
                  title: milestone.name,
                  description: milestone.description,
                  status:
                    milestone.status === 'completed'
                      ? 'done'
                      : milestone.status === 'overdue'
                        ? 'urgent'
                        : 'default',
                }))}
              />
            )}
          </section>

          <section className="flex flex-col gap-5">
            <div className="flex items-baseline justify-between gap-3">
              <PortalH1>{t('projects.detail.sections.deliverables')}</PortalH1>
              {project.staging_url && (
                <PortalLabel
                  as={Link}
                  href={project.staging_url}
                  className="hover:text-foreground transition-colors"
                >
                  {t('projects.detail.openStaging')}
                </PortalLabel>
              )}
            </div>
            <DeliverableReview projectId={project.id} deliverables={deliverables} />
          </section>

          <section className="flex flex-col gap-5">
            <PortalH1>{t('projects.detail.sections.messages')}</PortalH1>
            <MessageThread projectId={project.id} messages={messages} />
          </section>
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect(`/clienti/progetti/${id}`));
    }
    throw error;
  }
}
