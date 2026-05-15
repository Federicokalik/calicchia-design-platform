import type { Metadata } from 'next';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { PrivacyRequestForm } from '@/components/forms/PrivacyRequestForm';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema } from '@/data/structured-data';
import { buildCanonical, buildOgLocale } from '@/lib/canonical';

// Pagina IT-only (route guard blocca /en/privacy-request con 404). No hreflang.
export const metadata: Metadata = {
  title: {
    absolute: 'Richiesta dati personali · GDPR',
  },
  description:
    "Esercita i tuoi diritti GDPR: accesso, cancellazione, portabilità, rettifica, opposizione, limitazione del trattamento. Risposta entro 30 giorni come previsto dall'art. 12 GDPR.",
  alternates: { canonical: buildCanonical('/privacy-request', 'it') },
  robots: { index: false, follow: true },
  openGraph: {
    title: 'Richiesta dati personali · GDPR',
    description:
      "Esercita i tuoi diritti GDPR (accesso, cancellazione, portabilità, rettifica, opposizione, limitazione).",
    url: buildCanonical('/privacy-request', 'it'),
    ...buildOgLocale('it'),
  },
};

export default function PrivacyRequestPage() {
  return (
    <>
      <StructuredData
        json={breadcrumbSchema([
          { name: 'Home', url: '/' },
          { name: 'Privacy', url: '/privacy-policy' },
          { name: 'Richiesta dati personali', url: '/privacy-request' },
        ])}
      />

      <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-10 md:pb-14">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-9">
            <Breadcrumbs
              items={[
                { name: 'Home', url: '/' },
                { name: 'Privacy', url: '/privacy-policy' },
                { name: 'Richiesta dati personali', url: '/privacy-request' },
              ]}
              className="mb-8"
            />
            <Eyebrow as="p" mono className="mb-6">
              GDPR · diritti dell'interessato (art. 15-22)
            </Eyebrow>
            <Heading
              as="h1"
              size="display-lg"
              className="mb-6"
              style={{ maxWidth: '24ch' }}
            >
              Richiesta dati personali.
            </Heading>
            <p
              className="text-[length:var(--text-body-lg)] leading-relaxed mb-6"
              style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
            >
              Hai sei diritti concreti sui tuoi dati personali. Compila il modulo
              indicando quale vuoi esercitare. Rispondo entro 30 giorni come previsto
              dall'art. 12 GDPR. Se hai bisogno di una risposta più rapida, scrivi
              direttamente a mail@calicchia.design.
            </p>
            <MonoLabel as="p">
              Modulo riservato · non indicizzato
            </MonoLabel>
          </div>
        </div>
      </header>

      <section className="px-6 md:px-10 lg:px-14 pb-24 md:pb-32">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-7 md:col-start-3">
            <PrivacyRequestForm />
          </div>
        </div>
      </section>
    </>
  );
}
