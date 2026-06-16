import type { Metadata } from 'next';
import { LegalDocumentLayout } from '@/components/layout/LegalDocumentLayout';
import { LEGAL_CONTENT } from '@/data/legal-content';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema } from '@/data/structured-data';
import { buildCanonical, buildOgLocale } from '@/lib/canonical';
import { buildOgImage } from '@/lib/og-image';

// Pagina IT-only (route guard blocca /en/privacy-policy con 404). NON usa
// buildI18nAlternates per non emettere hreflang verso una variante EN
// inesistente. buildCanonical + og:locale 'it_IT' garantiscono consistenza
// col resto del sito (URL assoluti con metadataBase).
export const metadata: Metadata = {
  title: {
    absolute: 'Privacy Policy · Federico Calicchia',
  },
  description:
    "Informativa privacy: dati raccolti, finalità, base giuridica, diritti dell'interessato, tempi di conservazione, modalità di esercizio dei diritti GDPR.",
  alternates: { canonical: buildCanonical('/privacy-policy', 'it') },
  openGraph: {
    type: 'website',
    title: 'Privacy Policy · Federico Calicchia',
    description:
      "Informativa privacy completa, con dati raccolti, finalità e diritti dell'interessato.",
    url: buildCanonical('/privacy-policy', 'it'),
    images: buildOgImage('Privacy Policy · Federico Calicchia', 'it'),
    ...buildOgLocale('it'),
  },
};

export default function PrivacyPolicyPage() {
  const document = LEGAL_CONTENT['privacy-policy'];
  return (
    <>
      <StructuredData
        json={breadcrumbSchema([
          { name: 'Home', url: '/' },
          { name: 'Privacy Policy', url: '/privacy-policy' },
        ])}
      />
      <LegalDocumentLayout
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Privacy Policy', url: '/privacy-policy' },
        ]}
        document={document}
      />
    </>
  );
}
