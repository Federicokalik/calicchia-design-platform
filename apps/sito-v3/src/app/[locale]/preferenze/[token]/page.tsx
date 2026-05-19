import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { PublicPreferencesForm, type PublicPreferences } from './public-form';

interface PageProps {
  params: Promise<{ locale: string; token: string }>;
}

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');

export const metadata: Metadata = {
  title: 'Preferenze di comunicazione',
  robots: { index: false, follow: false },
};

async function loadPreferences(token: string): Promise<PublicPreferences | null> {
  if (!/^[a-f0-9]{48}$/i.test(token)) return null;
  const res = await fetch(`${API_BASE}/api/preferences/${encodeURIComponent(token)}`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { preferences: PublicPreferences };
  return data?.preferences ?? null;
}

export default async function PublicPreferencesPage({ params }: PageProps) {
  const { token } = await params;
  const prefs = await loadPreferences(token);
  if (!prefs) notFound();

  return (
    <main className="min-h-screen bg-background py-16 px-4">
      <div className="max-w-xl mx-auto space-y-8">
        <header className="space-y-2 text-center">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            Calicchia Design
          </p>
          <h1 className="text-2xl font-semibold">Preferenze di comunicazione</h1>
          <p className="text-sm text-muted-foreground max-w-prose mx-auto">
            Stai accedendo da un link diretto. Le modifiche vengono salvate
            automaticamente. Le comunicazioni contrattuali (fatture, scadenze fiscali,
            avvisi di sicurezza) sono sempre attive e richieste dalla normativa.
          </p>
        </header>
        <PublicPreferencesForm token={token} initial={prefs} />
      </div>
    </main>
  );
}
