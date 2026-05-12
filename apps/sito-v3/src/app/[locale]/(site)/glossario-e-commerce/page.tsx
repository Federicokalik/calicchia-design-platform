import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema, definedTermListSchema } from '@/data/structured-data';
import {
  GLOSSARIO_ECOMMERCE_LETTERS,
  GLOSSARIO_ECOMMERCE_META,
  localiseEcommerceTerms,
  type EcommerceTermLocalised,
} from '@/data/glossario-e-commerce';
import { Heading } from '@/components/ui/Heading';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import {
  EditorialArticleLayout,
  type EditorialChapterEntry,
} from '@/components/layout/EditorialArticleLayout';
import { buildCanonical, buildI18nAlternates } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';

const PATH = '/glossario-e-commerce';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const m = GLOSSARIO_ECOMMERCE_META[locale];
  return {
    title: { absolute: m.metaTitle },
    description: m.description,
    alternates: buildI18nAlternates(PATH, locale),
    openGraph: {
      title: m.ogTitle,
      description: m.ogDescription,
      url: buildCanonical(PATH, locale),
    },
  };
}

export default async function GlossarioEcommercePage() {
  const locale = (await getLocale()) as Locale;
  const m = GLOSSARIO_ECOMMERCE_META[locale];
  const terms = localiseEcommerceTerms(locale);

  const termsByLetter = new Map<string, EcommerceTermLocalised[]>();
  for (const t of terms) {
    if (!termsByLetter.has(t.letter)) termsByLetter.set(t.letter, []);
    termsByLetter.get(t.letter)!.push(t);
  }

  const chapters: EditorialChapterEntry[] = GLOSSARIO_ECOMMERCE_LETTERS.map((letter) => ({
    id: `letter-${letter}`,
    number: letter,
    label: locale === 'en'
      ? `${termsByLetter.get(letter)!.length} terms`
      : `${termsByLetter.get(letter)!.length} termini`,
  }));

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: m.breadcrumbServiceName, url: '/servizi' },
    { name: m.breadcrumbGlossaryName, url: PATH },
  ];

  return (
    <>
      <StructuredData
        json={[
          definedTermListSchema(
            terms.map((t) => ({
              name: t.term,
              description: t.whatItIs,
              slug: t.slug,
            })),
            PATH,
          ),
          breadcrumbSchema(breadcrumbs),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={breadcrumbs}
        eyebrow={m.eyebrow}
        title={m.pageTitle}
        lead={<>{m.lead}</>}
        chapters={chapters}
        indexVariant="alphabet"
        readTime={m.readTime}
        updatedAt={m.updatedAt}
        showFinalCta={false}
      >
        <div className="flex flex-col">
          {GLOSSARIO_ECOMMERCE_LETTERS.map((letter) => {
            const list = termsByLetter.get(letter)!;
            return (
              <section
                key={letter}
                id={`letter-${letter}`}
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
                  {list.map((t) => (
                    <li
                      key={t.slug}
                      id={t.slug}
                      className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-10 scroll-mt-24"
                    >
                      <div className="md:col-span-4">
                        <Heading as="h3" size="card" className="mb-2">
                          {t.term}
                        </Heading>
                        {t.fullName ? <MonoLabel as="p">{t.fullName}</MonoLabel> : null}
                      </div>

                      <div className="md:col-span-8 space-y-4">
                        <div>
                          <MonoLabel as="p" tone="accent" className="mb-2">
                            {m.sectionWhatItIs}
                          </MonoLabel>
                          <p
                            className="body-longform max-w-[80ch] text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                            style={{ color: 'var(--color-text-primary)' }}
                            dangerouslySetInnerHTML={{ __html: t.whatItIs }}
                          />
                        </div>
                        <div>
                          <MonoLabel as="p" tone="accent" className="mb-2">
                            {m.sectionWhyYouCare}
                          </MonoLabel>
                          <p
                            className="body-longform max-w-[80ch] text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                            style={{ color: 'var(--color-text-secondary)' }}
                            dangerouslySetInnerHTML={{ __html: t.whyYouCare }}
                          />
                        </div>
                        <div>
                          <MonoLabel as="p" tone="accent" className="mb-2">
                            {m.sectionWhatToDemand}
                          </MonoLabel>
                          <p
                            className="body-longform max-w-[80ch] text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                            style={{ color: 'var(--color-text-secondary)' }}
                            dangerouslySetInnerHTML={{ __html: t.whatToDemand }}
                          />
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
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
            style={{ maxWidth: '52ch' }}
          >
            {m.closingTitle}
          </Heading>
          <div className="flex flex-wrap gap-6">
            <Button href="/contatti" variant="underline" size="md">
              {m.ctaPrimary}
              <span aria-hidden="true">→</span>
            </Button>
            <Button href="/servizi/e-commerce" variant="underline" size="md" className="opacity-70">
              {m.ctaSecondary}
              <span aria-hidden="true">→</span>
            </Button>
          </div>
        </div>
      </EditorialArticleLayout>
    </>
  );
}
