import type { Metadata } from 'next';
import { LegalDocumentLayout } from '@/components/layout/LegalDocumentLayout';
import { LEGAL_CONTENT } from '@/data/legal-content';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema } from '@/data/structured-data';
import { buildCanonical, buildOgLocale } from '@/lib/canonical';

// Pagina IT-only (route guard blocca /en/dpa-clienti con 404). No hreflang.
export const metadata: Metadata = {
  title: {
    absolute: 'Data Processing Agreement (DPA) · Caldes / Calicchia Design',
  },
  description:
    "Accordo standard sul trattamento dei dati personali ai sensi dell'art. 28 GDPR. Parte integrante dei Termini e Condizioni, si applica automaticamente ai servizi che comportano trattamento per conto del cliente.",
  alternates: { canonical: buildCanonical('/dpa-clienti', 'it') },
  openGraph: {
    title: 'Data Processing Agreement (DPA) · Caldes / Calicchia Design',
    description:
      "Accordo standard art. 28 GDPR per i servizi che comportano trattamento dati per conto del cliente.",
    url: buildCanonical('/dpa-clienti', 'it'),
    ...buildOgLocale('it'),
  },
  // DPA non e` un documento "marketing": robots normale, ma di solito non ha
  // valore di ranking. Lasciamo indicizzabile per trasparenza.
};

export default function DpaClientiPage() {
  const document = LEGAL_CONTENT['dpa-clienti'];
  return (
    <>
      <StructuredData
        json={breadcrumbSchema([
          { name: 'Home', url: '/' },
          { name: 'Data Processing Agreement', url: '/dpa-clienti' },
        ])}
      />
      <LegalDocumentLayout
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Data Processing Agreement', url: '/dpa-clienti' },
        ]}
        document={document}
      />
    </>
  );
}
