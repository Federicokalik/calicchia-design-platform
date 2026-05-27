import { notFound } from 'next/navigation';
import { getLocale } from 'next-intl/server';

/**
 * Gate EN per le pagine legali. I 6 documenti (privacy-policy, cookie-policy,
 * termini-e-condizioni, dpa-clienti, faq, privacy-request) sono testi in italiano
 * dichiarati IT-only nei commenti delle page.tsx; senza questo gate `/en/<x>`
 * tornava 200 con HTML italiano + canonical/og che dichiaravano `it`, esponendo
 * agli utenti EN un form GDPR contestualmente in lingua sbagliata (audit
 * J-02 + R-001 confermato runtime).
 *
 * Layout group → un solo check per tutto il gruppo (vs. 6 patch alle page.tsx).
 */
export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  if (locale === 'en') notFound();
  return <>{children}</>;
}
