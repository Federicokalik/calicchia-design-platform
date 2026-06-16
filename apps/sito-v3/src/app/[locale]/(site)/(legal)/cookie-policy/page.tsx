import type { Metadata } from 'next';
import { LegalDocumentLayout } from '@/components/layout/LegalDocumentLayout';
import { LEGAL_CONTENT } from '@/data/legal-content';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema } from '@/data/structured-data';
import { buildCanonical, buildOgLocale } from '@/lib/canonical';
import { buildOgImage, buildTwitterCard } from '@/lib/og-image';

// Pagina IT-only (route guard blocca /en/cookie-policy con 404). No hreflang.
export const metadata: Metadata = {
  title: {
    absolute: 'Cookie Policy · Federico Calicchia',
  },
  description:
    'Informativa sui cookie utilizzati dal sito: cookie tecnici, di sicurezza, analitici aggregati. Come gestire il consenso e quali strumenti sono attivi.',
  alternates: { canonical: buildCanonical('/cookie-policy', 'it') },
  openGraph: {
    type: 'website',
    title: 'Cookie Policy · Federico Calicchia',
    description: 'Informativa cookie aggiornata, con elenco strumenti attivi.',
    url: buildCanonical('/cookie-policy', 'it'),
    images: buildOgImage('Cookie Policy · Federico Calicchia', 'it'),
    ...buildOgLocale('it'),
  },
  twitter: buildTwitterCard(
    'Cookie Policy · Federico Calicchia',
    'Informativa cookie aggiornata, con elenco strumenti attivi.',
    'it',
  ),
};

export default function CookiePolicyPage() {
  const document = LEGAL_CONTENT['cookie-policy'];
  return (
    <>
      <StructuredData
        json={breadcrumbSchema([
          { name: 'Home', url: '/' },
          { name: 'Cookie Policy', url: '/cookie-policy' },
        ])}
      />
      <LegalDocumentLayout
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Cookie Policy', url: '/cookie-policy' },
        ]}
        document={document}
      />
    </>
  );
}
