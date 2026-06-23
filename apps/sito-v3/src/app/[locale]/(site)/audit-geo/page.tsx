import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import { buildOgImage, buildTwitterCard } from '@/lib/og-image';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Heading } from '@/components/ui/Heading';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/lib/i18n';
import { GeoAuditTool } from '@/components/tools/GeoAuditTool';

const PATH = '/audit-geo';

const COPY = {
  it: {
    metaTitle: 'GEO Audit — analizza la visibilità del tuo sito nei motori AI',
    metaDescription:
      'Inserisci l’URL del tuo sito e scopri quanto è leggibile e citabile dai motori AI. Score tecnico gratuito basato sul white paper GEO.',
    eyebrow: 'Strumento gratuito',
    title: 'Il tuo sito è pronto per i motori AI?',
    lead: 'Analizziamo la tua pagina secondo i fattori verificabili della GEO (Generative Engine Optimization) e ti diamo uno score tecnico immediato. Non misura una quota garantita di citazioni: misura cosa i motori AI riescono a leggere, estrarre e usare.',
    whitepaperLabel: 'Basato sul white paper',
    whitepaperCta: 'Dalla SEO alla GEO →',
  },
  en: {
    metaTitle: 'GEO Audit — check your site’s visibility in AI engines',
    metaDescription:
      'Enter your site URL and find out how readable and citable it is for AI engines. Free technical score based on the GEO white paper.',
    eyebrow: 'Free tool',
    title: 'Is your site ready for AI engines?',
    lead: 'We analyze your page against the verifiable factors of GEO (Generative Engine Optimization) and give you an instant technical score. It does not measure guaranteed citation share: it measures what AI engines can read, extract and use.',
    whitepaperLabel: 'Based on the white paper',
    whitepaperCta: 'From SEO to GEO →',
  },
} as const;

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const c = COPY[locale];
  return {
    title: { absolute: c.metaTitle },
    description: c.metaDescription,
    alternates: buildI18nAlternates(PATH, locale),
    openGraph: {
      type: 'website',
      title: c.metaTitle,
      description: c.metaDescription,
      url: buildCanonical(PATH, locale),
      images: buildOgImage(c.title, locale),
      ...buildOgLocale(locale),
    },
    twitter: buildTwitterCard(c.title, c.metaDescription, locale),
  };
}

export default async function AuditGeoPage() {
  const locale = (await getLocale()) as Locale;
  const c = COPY[locale];

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-20 md:py-28">
      <header className="mb-12">
        <Eyebrow>{c.eyebrow}</Eyebrow>
        <Heading as="h1" className="mt-4">
          {c.title}
        </Heading>
        <p
          className="mt-6 text-lg md:text-xl leading-relaxed"
          style={{ color: 'var(--color-text-secondary)', maxWidth: '70ch' }}
        >
          {c.lead}
        </p>
        <p className="mt-4 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          {c.whitepaperLabel}:{' '}
          <Link
            href="/risorse/dalla-seo-alla-geo"
            className="underline"
            style={{ color: 'var(--color-accent-deep)' }}
          >
            {c.whitepaperCta}
          </Link>
        </p>
      </header>

      <GeoAuditTool locale={locale} />
    </div>
  );
}
