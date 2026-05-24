import { redirect } from '@/i18n/navigation';
import { getTranslations } from 'next-intl/server';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalTopbar } from '@/components/portal/PortalTopbar';
import { PortalDisplay, PortalBody, PortalLabel } from '@/components/portal/ui/typography';
import {
  getPortalPreferences,
  LegalAcceptanceRequiredError,
  PortalUnauthorizedError,
  requirePortalAccess,
} from '@/lib/portal-api';
import { getPortalCustomerLabel, portalLoginRedirect } from '@/lib/portal-format';
import type { Locale } from '@/lib/i18n';
import { PreferencesForm } from './preferences-form';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export default async function PreferenzePage({ params }: PageProps) {
  await params;

  try {
    const [customer, preferences, t] = await Promise.all([
      requirePortalAccess(),
      getPortalPreferences(),
      getTranslations('portal'),
    ]);

    return (
      <PortalShell userLabel={getPortalCustomerLabel(customer, t)}>
        <PortalTopbar breadcrumbs={[{ label: 'Preferenze' }]} />

        <div className="flex flex-col gap-8 max-w-[760px]">
          <header className="flex flex-col gap-3">
            <PortalLabel>Comunicazioni</PortalLabel>
            <PortalDisplay>Preferenze di comunicazione</PortalDisplay>
            <PortalBody className="text-muted-foreground max-w-[55ch]">
              Scegli come vuoi essere contattato. Le comunicazioni contrattuali (fatture,
              scadenze fiscali, avvisi di sicurezza) sono sempre attive — sono richieste dalla
              normativa.
            </PortalBody>
          </header>

          <PreferencesForm initial={preferences} />

          <section className="mt-4 border-t pt-6 text-sm text-muted-foreground space-y-2">
            <p>
              <strong className="text-foreground">Operativo:</strong> reminder appuntamenti,
              follow-up progetti, conferme di consegna.
            </p>
            <p>
              <strong className="text-foreground">Marketing:</strong> offerte, novità di servizio,
              contenuti promozionali. Richiede attivazione esplicita.
            </p>
            <p>
              In qualsiasi momento puoi rispondere &laquo;STOP&raquo; a un messaggio WhatsApp
              per disattivare tutte le comunicazioni non essenziali, oppure tornare qui per
              gestire singolarmente i canali.
            </p>
          </section>
        </div>
      </PortalShell>
    );
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect('/clienti/preferenze'));
    }
    if (error instanceof LegalAcceptanceRequiredError) {
      redirect('/clienti/accettazione-legale');
    }
    throw error;
  }
}
