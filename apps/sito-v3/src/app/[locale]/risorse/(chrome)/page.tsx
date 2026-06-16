import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { PageHero } from '@/components/layout/PageHero';
import { StructuredData } from '@/components/seo/StructuredData';
import { collectionPageSchema, breadcrumbSchema } from '@/data/structured-data';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import { buildOgImage, buildTwitterCard } from '@/lib/og-image';
import type { Locale } from '@/lib/i18n';
import { listResources } from '@/data/risorse';

const PATH = '/risorse';

const META: Record<Locale, { title: string; description: string; eyebrow: string; lead: string }> = {
  it: {
    title: 'Risorse — Calicchia Design',
    description:
      'Risorse curate su web design, SEO, GEO ed e-commerce: white paper e glossari pensati per chi commissiona un progetto e vuole capire cosa sta comprando.',
    eyebrow: 'Risorse',
    lead: 'White paper e glossari curati: contenuti evergreen per capire web design, SEO, GEO ed e-commerce senza gergo da vendere.',
  },
  en: {
    title: 'Resources — Calicchia Design',
    description:
      'Curated resources on web design, SEO, GEO and e-commerce: white papers and glossaries for whoever commissions a project and wants to understand what they are buying.',
    eyebrow: 'Resources',
    lead: 'Curated white papers and glossaries: evergreen content to understand web design, SEO, GEO and e-commerce without the sales jargon.',
  },
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const m = META[locale];
  return {
    title: { absolute: m.title },
    description: m.description,
    alternates: buildI18nAlternates(PATH, locale),
    openGraph: {
      type: 'website',
      title: m.title,
      description: m.description,
      url: buildCanonical(PATH, locale),
      images: buildOgImage(m.title, locale),
      ...buildOgLocale(locale),
    },
    twitter: buildTwitterCard(m.title, m.description, locale),
  };
}

export default async function RisorseHubPage() {
  const locale = (await getLocale()) as Locale;
  const m = META[locale];
  const resources = listResources();

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: m.eyebrow, url: PATH },
  ];

  return (
    <>
      <StructuredData
        json={[
          collectionPageSchema({
            name: m.eyebrow,
            description: m.lead,
            url: buildCanonical(PATH, locale),
            items: resources.map((r) => ({ name: r.title[locale], url: r.path })),
            locale,
          }),
          breadcrumbSchema(breadcrumbs),
        ]}
      />

      <PageHero breadcrumbs={breadcrumbs} eyebrow={m.eyebrow} title={m.eyebrow} intro={m.lead} />

      <section className="px-6 md:px-10 lg:px-14 pb-32 max-w-[1400px] mx-auto">
        <ul role="list" className="grid grid-cols-1 md:grid-cols-2 gap-px" style={{ background: 'var(--color-line)' }}>
          {resources.map((r) => (
            <li key={r.key} style={{ background: 'var(--color-bg)' }}>
              <Link
                href={r.path}
                className="group flex h-full flex-col gap-4 p-8 md:p-10 transition-colors hover:bg-[var(--color-surface)]"
              >
                <span
                  className="font-mono text-[11px] uppercase tracking-[0.2em]"
                  style={{ color: 'var(--color-accent)' }}
                >
                  {r.meta[locale]}
                </span>
                <h2
                  className="font-[family-name:var(--font-display)] text-3xl md:text-4xl"
                  style={{ fontWeight: 600, letterSpacing: '-0.02em' }}
                >
                  {r.title[locale]}
                </h2>
                <p
                  className="text-base leading-relaxed max-w-[52ch]"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {r.description[locale]}
                </p>
                <span
                  className="mt-auto inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] group-hover:gap-3 transition-all"
                  style={{ color: 'var(--color-ink)' }}
                >
                  {locale === 'en' ? 'Open' : 'Apri'}
                  <span aria-hidden>→</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
