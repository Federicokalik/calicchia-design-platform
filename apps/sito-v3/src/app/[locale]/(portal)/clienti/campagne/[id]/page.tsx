import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PortalRedirect } from '@/components/portal/PortalRedirect';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { CampaignAssetReview } from '@/components/portal/CampaignAssetReview';
import {
  PortalDisplay,
  PortalH1,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getPortalCampaign,
  LegalAcceptanceRequiredError,
  PortalUnauthorizedError,
  requirePortalAccess,
} from '@/lib/portal-api';
import { getPortalCustomerLabel } from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale; id: string }>;
}

const STATUS_LABEL: Record<string, string> = {
  brief: 'Brief',
  planning: 'Pianificazione',
  creative: 'Creatività',
  review: 'Revisione',
  approved: 'Approvata',
  active: 'Attiva',
  paused: 'In pausa',
  completed: 'Completata',
  cancelled: 'Annullata',
};

export default async function CampagnaDetailPage({ params }: PageProps) {
  const { id } = await params;

  try {
    const [customer, data, t] = await Promise.all([
      requirePortalAccess(),
      getPortalCampaign(id),
      getTranslations('portal'),
    ]);

    if (!data) notFound();
    const { campaign, assets } = data;

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)} role={customer.role}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.campaigns'), href: '/clienti/campagne' },
            { label: campaign.campaign_name },
          ]}
        />

        <div className="flex flex-col gap-10 max-w-[1280px]">
          <header className="flex flex-col gap-3">
            <PortalLabel>{STATUS_LABEL[campaign.status] ?? campaign.status}</PortalLabel>
            <PortalDisplay>{campaign.campaign_name}</PortalDisplay>
            {campaign.objective && (
              <PortalBody className="text-muted-foreground max-w-[60ch]">
                {campaign.objective}
              </PortalBody>
            )}
            {campaign.project_name && (
              <PortalBody className="text-muted-foreground">{campaign.project_name}</PortalBody>
            )}
          </header>

          <section className="flex flex-col gap-5">
            <PortalH1>Asset da revisionare</PortalH1>
            <CampaignAssetReview campaignId={campaign.id} assets={assets} />
          </section>
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      return <PortalRedirect to="/clienti/login" />;
    }
    if (error instanceof LegalAcceptanceRequiredError) {
      return <PortalRedirect to="/clienti/accettazione-legale" />;
    }
    throw error;
  }
}
