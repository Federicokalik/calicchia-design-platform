import type { Metadata } from 'next';
import { SignatureFlow } from '@/components/firma/SignatureFlow';

export const metadata: Metadata = {
  title: 'Firma documento — Calicchia Design',
  description: 'Pagina di firma elettronica avanzata.',
  robots: { index: false, follow: false },
};

interface Params {
  locale: string;
  token: string;
}

interface PageProps {
  params: Promise<Params>;
}

export default async function FirmaPage({ params }: PageProps) {
  const { token } = await params;

  return (
    <main className="min-h-[100dvh] py-16 md:py-24 px-6 md:px-10">
      <div className="max-w-3xl mx-auto">
        <SignatureFlow token={token} />
      </div>
    </main>
  );
}
