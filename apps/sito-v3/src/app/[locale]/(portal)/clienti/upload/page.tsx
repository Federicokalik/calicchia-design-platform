import { redirect } from '@/i18n/navigation';
import { getTranslations } from 'next-intl/server';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { UploadZone } from '@/components/portal/UploadZone';
import {
  PortalDisplay,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getProjects,
  LegalAcceptanceRequiredError,
  PortalUnauthorizedError,
  requirePortalAccess,
} from '@/lib/portal-api';
import { getPortalCustomerLabel, portalLoginRedirect } from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export default async function UploadPage({ params }: PageProps) {
  await params;

  try {
    const [customer, projects, t] = await Promise.all([
      requirePortalAccess(),
      getProjects(),
      getTranslations('portal'),
    ]);

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.files'), href: '/clienti/file' },
            { label: t('nav.items.upload') },
          ]}
        />

        <div className="flex flex-col gap-8 max-w-[960px]">
          <header className="flex flex-col gap-2">
            <PortalLabel>{t('upload.eyebrow')}</PortalLabel>
            <PortalDisplay>{t('upload.title')}</PortalDisplay>
            <PortalBody className="text-muted-foreground max-w-[55ch]">
              {t('upload.intro')}
            </PortalBody>
          </header>

          <UploadZone projects={projects} />

          <aside className="flex flex-col gap-2 p-5 border border-border bg-card rounded-sm">
            <PortalLabel>{t('upload.noteLabel')}</PortalLabel>
            <PortalBody className="text-muted-foreground">{t('upload.noteText')}</PortalBody>
          </aside>
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect('/clienti/upload'));
    }
    if (error instanceof LegalAcceptanceRequiredError) {
      redirect('/clienti/accettazione-legale');
    }
    throw error;
  }
}
