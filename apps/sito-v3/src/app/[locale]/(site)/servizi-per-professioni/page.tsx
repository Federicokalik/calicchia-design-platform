import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import { StructuredData } from '@/components/seo/StructuredData';
import {
  breadcrumbSchema,
  collectionPageSchema,
} from '@/data/structured-data';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Button } from '@/components/ui/Button';
import { Section } from '@/components/ui/Section';
import { FinalCTA } from '@/components/home/FinalCTA';
import { SERVICES } from '@/data/services';
import {
  getAllProfessionsLocalized,
  getProfessionCategories,
} from '@/data/seo-professions';
import {
  getProfessionSlugForLocale,
  getServiceByLandingSlug,
  getServiceUrlPrefix,
} from '@/data/seo-service-matrix';
import {
  buildCanonical,
  buildI18nAlternates,
  buildOgLocale,
} from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';

// IT-canonical path. EN is translated to /services-by-profession via PATHNAMES;
// buildCanonical / buildI18nAlternates handle the rewrite automatically.
const PATH = '/servizi-per-professioni';

export async function generateMetadata(): Promise<Metadata> {
  const [locale, t] = await Promise.all([
    getLocale() as Promise<Locale>,
    getTranslations('servizi.perProfessione.metadata'),
  ]);
  return {
    title: { absolute: t('title') },
    description: t('description'),
    alternates: buildI18nAlternates(PATH, locale),
    openGraph: {
      title: t('ogTitle'),
      description: t('ogDescription'),
      url: buildCanonical(PATH, locale),
      ...buildOgLocale(locale),
    },
  };
}

export default async function ServiziPerProfessioniHubPage() {
  const [locale, t] = await Promise.all([
    getLocale() as Promise<Locale>,
    getTranslations('servizi.perProfessione'),
  ]);

  // Locale-aware professions + categories. Matrix landing pages /sito-web-per-*
  // remain IT-only (route guard), but the hub itself must follow the page
  // locale — chrome labels, headings, and category names are now translated.
  const allProfessions = getAllProfessionsLocalized(locale);
  const categories = getProfessionCategories(locale);
  const indexableProfessions = allProfessions.filter((p) => p.tier <= 2);
  const categoriesOrdered = Object.values(categories);
  const professionsByCategory = new Map(
    categoriesOrdered.map((cat) => [
      cat.id,
      indexableProfessions
        .filter((p) => p.categoryId === cat.id)
        .sort((a, b) => a.label.localeCompare(b.label, locale)),
    ]),
  );

  const homeLabel = t('breadcrumbHome');
  const currentLabel = t('breadcrumbCurrent');

  // Locale-aware matrix link builder (same logic as RelatedProfessions).
  const sitoWebService = getServiceByLandingSlug('sito-web');
  const matrixPrefix = sitoWebService
    ? getServiceUrlPrefix(sitoWebService, locale)
    : 'sito-web-per';
  const matrixHref = (profSlug: string) =>
    `/${matrixPrefix}-${getProfessionSlugForLocale(profSlug, locale)}`;

  const canonicalUrl = buildCanonical(PATH, locale);
  const collection = collectionPageSchema({
    name: t('collectionName'),
    description: t('collectionDescription'),
    url: canonicalUrl,
    items: categoriesOrdered.map((cat) => ({
      name: cat.label,
      url: `${canonicalUrl}#${cat.id}`,
    })),
  });

  return (
    <>
      <StructuredData
        json={[
          collection,
          breadcrumbSchema([
            { name: homeLabel, url: buildCanonical('/', locale) },
            { name: currentLabel, url: canonicalUrl },
          ]),
        ]}
      />

      <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-12 md:pb-16">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-9">
            <Breadcrumbs
              items={[
                { name: homeLabel, url: '/' },
                { name: currentLabel, url: PATH },
              ]}
              className="mb-8"
            />
            <Eyebrow as="p" mono className="mb-6">
              {t('eyebrowCounts', {
                categoryCount: categoriesOrdered.length,
                professionCount: indexableProfessions.length,
              })}
            </Eyebrow>
            <Heading
              as="h1"
              size="display-xl"
              className="mb-8"
              style={{ maxWidth: '20ch' }}
            >
              {t('h1')}
            </Heading>
            <p
              className="text-[length:var(--text-body-lg)] leading-relaxed"
              style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
            >
              {t('intro')}
            </p>
          </div>
        </div>
      </header>

      {/* Sezione 1 — Tabella categorie */}
      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-4">
            <MonoLabel as="p" className="mb-4">
              {t('categoriesLabel')}
            </MonoLabel>
            <Heading as="h2" size="display-md" style={{ maxWidth: '20ch' }}>
              {t('categoriesHeading')}
            </Heading>
            <p
              className="mt-4 text-base md:text-lg leading-relaxed"
              style={{ maxWidth: '50ch', color: 'var(--color-text-secondary)' }}
            >
              {t('categoriesLead')}
            </p>
          </div>

          <ul role="list" className="col-span-12 md:col-span-8 flex flex-col">
            {categoriesOrdered.map((cat, i) => {
              const count =
                professionsByCategory.get(cat.id)?.length ?? 0;
              return (
                <li
                  key={cat.id}
                  className="border-t"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <a
                    href={`#${cat.id}`}
                    className="grid grid-cols-12 gap-4 py-5 transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    <span
                      aria-hidden="true"
                      className="col-span-2 md:col-span-1 tabular-nums"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--text-mono-xs)',
                        letterSpacing: '0.05em',
                        color: 'var(--color-text-tertiary)',
                      }}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span
                      className="col-span-7 md:col-span-8"
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 'var(--text-card-title)',
                        fontWeight: 500,
                        letterSpacing: '-0.02em',
                        lineHeight: 1.1,
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {cat.label}
                    </span>
                    <span
                      aria-hidden="true"
                      className="col-span-3 md:col-span-3 self-center text-right"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--text-mono-xs)',
                        letterSpacing: '0.05em',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      {t('professionsCount', { count })}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      </Section>

      {/* Sezione 2 — 5 servizi hairline */}
      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-4">
            <MonoLabel as="p" className="mb-4">
              {t('servicesLabel')}
            </MonoLabel>
            <Heading as="h2" size="display-md" style={{ maxWidth: '20ch' }}>
              {t('servicesHeading')}
            </Heading>
            <p
              className="mt-4 text-base md:text-lg leading-relaxed"
              style={{ maxWidth: '50ch', color: 'var(--color-text-secondary)' }}
            >
              {t('servicesLead')}
            </p>
          </div>

          <ul role="list" className="col-span-12 md:col-span-8 flex flex-col">
            {SERVICES.map((s, i) => (
              <li
                key={s.slug}
                className="border-t"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <Link
                  href={`/servizi/${s.slug}`}
                  className="grid grid-cols-12 gap-4 py-5 transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <span
                    aria-hidden="true"
                    className="col-span-2 md:col-span-1 tabular-nums"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-mono-xs)',
                      letterSpacing: '0.05em',
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span
                    className="col-span-7 md:col-span-9"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'var(--text-card-title)',
                      fontWeight: 500,
                      letterSpacing: '-0.02em',
                      lineHeight: 1.1,
                      color: 'var(--color-text-primary)',
                    }}
                  >
                    {s.title}
                  </span>
                  <span
                    aria-hidden="true"
                    className="col-span-3 md:col-span-2 self-center text-right"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--text-mono-xs)',
                      letterSpacing: '0.05em',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* Sezione 3 — Per ogni categoria, lista professioni */}
      {categoriesOrdered.map((cat) => {
        const list = professionsByCategory.get(cat.id) ?? [];
        if (list.length === 0) return null;
        return (
          <Section
            key={cat.id}
            spacing="compact"
            bordered="top"
            id={cat.id}
          >
            <div className="grid grid-cols-12 gap-6 md:gap-8 scroll-mt-32">
              <div className="col-span-12 md:col-span-4">
                <MonoLabel as="p" className="mb-4">
                  {t('categoryMonoLabel', {
                    label: cat.label,
                    count: list.length,
                  })}
                </MonoLabel>
                <Heading as="h2" size="display-md" style={{ maxWidth: '20ch' }}>
                  {`${cat.label}.`}
                </Heading>
                <p
                  className="mt-4 text-base md:text-lg leading-relaxed"
                  style={{ maxWidth: '50ch', color: 'var(--color-text-secondary)' }}
                >
                  {cat.description}
                </p>
              </div>

              <ul
                role="list"
                className="col-span-12 md:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-x-6"
              >
                {list.map((p, i) => (
                  <li
                    key={p.slug}
                    className="border-t"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <Link
                      href={matrixHref(p.slug)}
                      className="grid grid-cols-12 gap-3 py-4 transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      <span
                        aria-hidden="true"
                        className="col-span-2 tabular-nums"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 'var(--text-mono-xs)',
                          letterSpacing: '0.05em',
                          color: 'var(--color-text-tertiary)',
                        }}
                      >
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span
                        className="col-span-9"
                        style={{
                          color: 'var(--color-text-primary)',
                          fontFamily: 'var(--font-sans)',
                          fontSize: '1rem',
                          lineHeight: 1.3,
                        }}
                      >
                        {p.label}
                      </span>
                      <span
                        aria-hidden="true"
                        className="col-span-1 self-center text-right"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 'var(--text-mono-xs)',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </Section>
        );
      })}

      {/* Sezione 4 — CTA */}
      <Section spacing="compact" bordered="top">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-7 md:col-start-3">
            <MonoLabel as="p" className="mb-4">
              {t('ctaLabel', { index: categoriesOrdered.length + 2 })}
            </MonoLabel>
            <Heading
              as="h2"
              size="display-md"
              className="mb-6"
              style={{ maxWidth: '24ch' }}
            >
              {t('ctaHeading')}
            </Heading>
            <p
              className="text-base md:text-lg leading-relaxed mb-6"
              style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
            >
              {t('ctaLead', { count: indexableProfessions.length })}
            </p>
            <Button href="/contatti" variant="solid" size="md">
              {t('ctaButton')}
              <span aria-hidden="true">→</span>
            </Button>
          </div>
        </div>
      </Section>

      <FinalCTA />
    </>
  );
}
