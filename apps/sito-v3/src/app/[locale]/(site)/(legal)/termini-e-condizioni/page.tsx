import type { Metadata } from 'next';
import { LegalDocumentLayout } from '@/components/layout/LegalDocumentLayout';
import { LEGAL_CONTENT } from '@/data/legal-content';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema } from '@/data/structured-data';
import { buildCanonical, buildOgLocale } from '@/lib/canonical';

// Pagina IT-only (route guard blocca /en/termini-e-condizioni con 404). No hreflang.
export const metadata: Metadata = {
  title: {
    absolute: 'Termini e Condizioni · Caldes / Calicchia Design',
  },
  description:
    "Termini e condizioni d'uso del sito e dei rapporti contrattuali per i servizi professionali: preventivi, pagamenti, tempistiche, proprietà intellettuale, recesso, foro competente.",
  alternates: { canonical: buildCanonical('/termini-e-condizioni', 'it') },
  openGraph: {
    title: 'Termini e Condizioni · Caldes / Calicchia Design',
    description:
      "Condizioni generali per uso sito e rapporti contrattuali con il prestatore.",
    url: buildCanonical('/termini-e-condizioni', 'it'),
    ...buildOgLocale('it'),
  },
};

export default function TerminiECondizioniPage() {
  const document = LEGAL_CONTENT['termini-e-condizioni'];
  return (
    <>
      <StructuredData
        json={breadcrumbSchema([
          { name: 'Home', url: '/' },
          { name: 'Termini e Condizioni', url: '/termini-e-condizioni' },
        ])}
      />
      <LegalDocumentLayout
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Termini e Condizioni', url: '/termini-e-condizioni' },
        ]}
        document={document}
      />
    </>
  );
}
