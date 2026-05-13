import type { Metadata } from 'next';
import { EmbedLeadForm } from '@/components/embed/EmbedLeadForm';

export const metadata: Metadata = {
  title: 'Lead form',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Embed form per lead capture su siti partner.
 *
 * Uso: <iframe src="https://calicchia.design/it/embed/lead?source=site-xyz&utm_source=google">
 * Layout minimale (no chrome del sito), postMessage al parent per altezza e successo.
 *
 * NB: la pagina sta fuori dal route group (site), quindi NON eredita header/footer.
 */
export default async function EmbedLeadPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const single = (k: string): string | undefined => {
    const v = params[k];
    if (Array.isArray(v)) return v[0];
    return v;
  };

  return (
    <main className="min-h-screen p-4 bg-white">
      <EmbedLeadForm
        sourceToken={single('source')}
        utm={{
          utm_source: single('utm_source'),
          utm_medium: single('utm_medium'),
          utm_campaign: single('utm_campaign'),
          utm_content: single('utm_content'),
          utm_term: single('utm_term'),
        }}
      />
    </main>
  );
}
