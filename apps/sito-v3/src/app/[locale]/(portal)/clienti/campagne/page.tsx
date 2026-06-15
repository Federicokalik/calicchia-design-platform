import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { PortalRedirect } from '@/components/portal/PortalRedirect';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import {
  PortalDisplay,
  PortalBody,
  PortalLabel,
} from '@/components/portal/ui/typography';
import {
  getPortalCampaigns,
  LegalAcceptanceRequiredError,
  PortalUnauthorizedError,
  requirePortalAccess,
} from '@/lib/portal-api';
import { getPortalCustomerLabel } from '@/lib/portal-format';

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

export default async function CampagnePage() {
  try {
    const [customer, campaigns, t] = await Promise.all([
      requirePortalAccess(),
      getPortalCampaigns(),
      getTranslations('portal'),
    ]);

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)} role={customer.role}>
        <PortalTopbar
          breadcrumbs={[
            { label: t('nav.items.dashboard'), href: '/clienti/dashboard' },
            { label: t('nav.items.campaigns') },
          ]}
        />

        <div className="flex flex-col gap-8 max-w-[1280px]">
          <header className="flex flex-col gap-3">
            <PortalLabel>{t('nav.items.campaigns')}</PortalLabel>
            <PortalDisplay>Campagne</PortalDisplay>
            <PortalBody className="text-muted-foreground max-w-[60ch]">
              Rivedi e approva le creatività delle tue campagne marketing.
            </PortalBody>
          </header>

          {campaigns.length === 0 ? (
            <PortalBody className="text-muted-foreground">Nessuna campagna disponibile al momento.</PortalBody>
          ) : (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {campaigns.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/clienti/campagne/${c.id}`}
                    className="flex flex-col gap-2 rounded-sm border p-5 transition-colors hover:bg-muted/40"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <PortalLabel>{STATUS_LABEL[c.status] ?? c.status}</PortalLabel>
                      {c.pending_count > 0 && (
                        <span
                          className="rounded-full px-2 py-0.5 text-xs"
                          style={{ background: 'var(--color-accent-soft, rgba(0,0,0,0.06))', color: 'var(--color-text-primary)' }}
                        >
                          {c.pending_count} da approvare
                        </span>
                      )}
                    </div>
                    <h3
                      className="font-[family-name:var(--font-display)] text-lg"
                      style={{ fontWeight: 500, letterSpacing: '-0.015em' }}
                    >
                      {c.campaign_name}
                    </h3>
                    <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                      {c.project_name ? `${c.project_name} · ` : ''}{c.asset_count} asset
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
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
