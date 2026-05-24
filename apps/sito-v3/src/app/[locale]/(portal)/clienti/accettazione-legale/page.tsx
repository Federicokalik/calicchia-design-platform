import { redirect } from '@/i18n/navigation';
import { Link } from '@/i18n/navigation';
import { Logo } from '@/components/Logo/Logo';
import {
  getCustomer,
  getLegalStatus,
  PortalUnauthorizedError,
} from '@/lib/portal-api';
import { portalLoginRedirect } from '@/lib/portal-format';
import { LegalAcceptanceForm } from '@/components/portal/LegalAcceptanceForm';
import type { Locale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

/**
 * Gate di accettazione T&C + DPA — bloccaggio dell'accesso al portale finche`
 * il customer non ha registrato consenso esplicito per le versioni correnti.
 *
 * Flusso:
 *   1. getCustomer() — deve essere autenticato; se 401 → /clienti/login.
 *   2. getLegalStatus() — se requires_acceptance=false (perche` ha gia` accettato
 *      o e` whitelistato dal quote bypass) → redirect a dashboard. Evita di
 *      mostrare il gate a chi non lo deve vedere se atterra qui per URL diretto.
 *   3. Renderizza il form di accettazione. Layout minimal senza PortalShell —
 *      non vogliamo permettere navigazione laterale prima dell'accettazione.
 */
export default async function AccettazioneLegalePage({ params }: PageProps) {
  await params;

  let customer;
  let status;
  try {
    customer = await getCustomer();
    if (!customer) redirect(portalLoginRedirect('/clienti/accettazione-legale'));
    status = await getLegalStatus();
  } catch (error) {
    if (error instanceof PortalUnauthorizedError) {
      redirect(portalLoginRedirect('/clienti/accettazione-legale'));
    }
    throw error;
  }

  if (!status.requires_acceptance) {
    redirect('/clienti/dashboard');
  }

  return (
    <div
      className="min-h-svh"
      style={{ background: 'var(--color-bg)', color: 'var(--color-ink)' }}
    >
      <header
        className="border-b"
        style={{ borderColor: 'rgba(17,17,17,0.08)' }}
      >
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-5 md:px-8">
          <Link href="/" aria-label="Home" className="inline-flex items-center">
            <Logo className="h-5 w-auto" />
          </Link>
          <p
            className="font-mono text-[10px] uppercase tracking-[0.18em]"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Area Clienti
          </p>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-6 py-12 md:px-8 md:py-16">
        <LegalAcceptanceForm customerEmail={customer.email} />
      </main>
    </div>
  );
}
