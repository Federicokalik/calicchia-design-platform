import type { Metadata } from 'next';
import { LegalDocumentLayout } from '@/components/layout/LegalDocumentLayout';
import { LEGAL_CONTENT } from '@/data/legal-content';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema } from '@/data/structured-data';

export const metadata: Metadata = {
  title: {
    absolute: 'Privacy Policy · Caldes / Calicchia Design',
  },
  description:
    "Informativa privacy: dati raccolti, finalità, base giuridica, diritti dell'interessato, tempi di conservazione, modalità di esercizio dei diritti GDPR.",
  alternates: { canonical: '/privacy-policy' },
  openGraph: {
    title: 'Privacy Policy · Caldes / Calicchia Design',
    description:
      "Informativa privacy completa, con dati raccolti, finalità e diritti dell'interessato.",
    url: '/privacy-policy',
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
