import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { definedTermListSchema } from '@/data/structured-data';
import {
  GLOSSARIO_WEB_DESIGN_PATH as PATH,
  glossarioTermAnchor,
  glossarioWebDesignCopy,
  normalizeSearch,
  type GlossarioEntry,
} from '@/data/glossario';
// Glossario DB-backed via getGlossario() (site_glossario, mig 121/153/154).
// Fallback per lingua su data/glossario-fallback.ts se l'API non risponde.
import { getGlossario } from '@/lib/cms';
import type { Locale } from '@/lib/i18n';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import { buildOgImage, buildTwitterCard } from '@/lib/og-image';
import { Heading } from '@/components/ui/Heading';
import { Button } from '@/components/ui/Button';
import {
  EditorialArticleLayout,
  type EditorialChapterEntry,
} from '@/components/layout/EditorialArticleLayout';
import { GlossarioFilters, type GlossarioIndexItem } from '@/components/risorse/GlossarioFilters';
import { GlossarioTermItem } from '@/components/risorse/GlossarioTermItem';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const { entries } = await getGlossario(locale);
  const copy = glossarioWebDesignCopy(locale, entries.length);
  return {
    title: { absolute: copy.metaTitle },
    description: copy.description,
    alternates: buildI18nAlternates(PATH, locale),
    openGraph: {
      type: 'website',
      title: copy.ogTitle,
      description: copy.ogDescription,
      url: buildCanonical(PATH, locale),
      images: buildOgImage(copy.ogTitle, locale),
      ...buildOgLocale(locale),
    },
    twitter: buildTwitterCard(copy.ogTitle, copy.ogDescription, locale),
  };
}

function formatUpdatedAt(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Rome',
  }).format(date);
}

export default async function GlossarioPage() {
  const locale = (await getLocale()) as Locale;
  const { entries, letters, updatedAt } = await getGlossario(locale);
  const copy = glossarioWebDesignCopy(locale, entries.length);

  const termsByLetter = new Map<string, GlossarioEntry[]>();
  for (const t of entries) {
    if (!termsByLetter.has(t.letter)) termsByLetter.set(t.letter, []);
    termsByLetter.get(t.letter)!.push(t);
  }

  // Correlati risolti sulle sole voci pubblicate in questa lingua.
  const bySlug = new Map(entries.map((e) => [e.slug, e]));
  const relatedOf = (e: GlossarioEntry) =>
    e.related
      .map((slug) => bySlug.get(slug))
      .filter((r): r is GlossarioEntry => !!r && r.slug !== e.slug)
      .map((r) => ({ slug: r.slug, term: r.term }));

  const searchIndex: GlossarioIndexItem[] = entries.map((e) => ({
    slug: e.slug,
    letter: e.letter,
    category: e.category,
    level: e.level,
    haystack: normalizeSearch([e.term, e.fullName ?? '', ...e.aliases].join(' ')),
  }));

  const chapters: EditorialChapterEntry[] = letters.map((letter) => ({
    id: `letter-${letter}`,
    number: letter,
    label: copy.letterTerms(termsByLetter.get(letter)!.length),
  }));

  // Breadcrumbs emette già lo schema BreadcrumbList: qui solo il DefinedTermSet.
  const breadcrumbs = [
    { name: 'Home', url: '/' },
    copy.breadcrumbParent,
    { name: copy.breadcrumbGlossary, url: PATH },
  ];

  return (
    <>
      <StructuredData
        json={definedTermListSchema(
          entries.map((t) => ({
            name: t.term,
            description: t.whatItIs,
            slug: t.slug,
            anchor: glossarioTermAnchor(t.slug),
            alternateName: t.aliases,
          })),
          buildCanonical(PATH, locale),
          { name: copy.jsonLdName, inLanguage: locale },
        )}
      />

      <EditorialArticleLayout
        breadcrumbs={breadcrumbs}
        eyebrow={copy.eyebrow}
        title={copy.pageTitle}
        lead={<>{copy.lead}</>}
        chapters={chapters}
        indexVariant="alphabet"
        readTime={copy.readTime}
        updatedAt={formatUpdatedAt(updatedAt, locale)}
        showFinalCta={false}
      >
        <GlossarioFilters locale={locale} index={searchIndex} />

        <div className="flex flex-col">
          {letters.map((letter) => (
            <section
              key={letter}
              id={`letter-${letter}`}
              data-glossario-letter={letter}
              className="py-12 md:py-16 scroll-mt-32"
              style={{ borderTop: '1px solid var(--color-border)' }}
            >
              <Heading
                as="h2"
                size="display-lg"
                className="mb-10"
                style={{ color: 'var(--color-accent-deep)' }}
              >
                {letter}
              </Heading>

              <ul role="list" className="flex flex-col gap-12 md:gap-16">
                {termsByLetter.get(letter)!.map((t) => (
                  <GlossarioTermItem key={t.slug} entry={t} locale={locale} related={relatedOf(t)} />
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div
          className="py-12 my-16"
          style={{
            borderTop: '1px solid var(--color-border)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <Heading
            as="p"
            size="display-sm"
            className="mb-6"
            style={{ maxWidth: '42ch' }}
          >
            {copy.closingTitle}
          </Heading>
          <div className="flex flex-wrap gap-6">
            <Button href="/contatti" variant="underline" size="md">
              {copy.ctaPrimary}
              <span aria-hidden="true">→</span>
            </Button>
            <Button
              href={copy.ctaSecondary.href}
              variant="underline"
              size="md"
              className="opacity-70"
            >
              {copy.ctaSecondary.label}
              <span aria-hidden="true">→</span>
            </Button>
          </div>
        </div>
      </EditorialArticleLayout>
    </>
  );
}
