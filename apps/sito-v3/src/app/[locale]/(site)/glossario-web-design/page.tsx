import type { Metadata } from 'next';
import { StructuredData } from '@/components/seo/StructuredData';
import {
  breadcrumbSchema,
  definedTermListSchema,
} from '@/data/structured-data';
import { GLOSSARIO, GLOSSARIO_LETTERS } from '@/data/glossario';
import { Heading } from '@/components/ui/Heading';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import {
  EditorialArticleLayout,
  type EditorialChapterEntry,
} from '@/components/layout/EditorialArticleLayout';

export const metadata: Metadata = {
  title: {
    absolute:
      'Glossario Web Design · I 30 termini che le agenzie sperano tu non capisca | Federico Calicchia',
  },
  description:
    "LCP, CLS, CMS, SEO, SSL, schema markup, hreflang… 30 termini tecnici spiegati semplici. Per ogni termine: cos'è, perché ti riguarda, cosa pretendere dal fornitore.",
  alternates: { canonical: '/glossario-web-design' },
  openGraph: {
    title:
      'Glossario Web Design · I 30 termini che le agenzie sperano tu non capisca',
    description:
      "30 termini tecnici spiegati semplici. Cos'è, perché ti riguarda, cosa pretendere.",
    url: '/glossario-web-design',
  },
};

export default function GlossarioPage() {
  // Group terms by letter for A-Z layout
  const termsByLetter = new Map<string, typeof GLOSSARIO>();
  for (const t of GLOSSARIO) {
    if (!termsByLetter.has(t.letter)) termsByLetter.set(t.letter, []);
    termsByLetter.get(t.letter)!.push(t);
  }

  const chapters: EditorialChapterEntry[] = GLOSSARIO_LETTERS.map((letter) => ({
    id: `letter-${letter}`,
    number: letter,
    label: `${termsByLetter.get(letter)!.length} termini`,
  }));

  return (
    <>
      <StructuredData
        json={[
          definedTermListSchema(
            GLOSSARIO.map((t) => ({
              name: t.term,
              description: t.whatItIs,
              slug: t.slug,
            })),
            '/glossario-web-design'
          ),
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Web Designer Freelance', url: '/web-design-freelance' },
            { name: 'Glossario', url: '/glossario-web-design' },
          ]),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={[
          { name: 'Home', url: '/' },
          { name: 'Web Designer Freelance', url: '/web-design-freelance' },
          { name: 'Glossario', url: '/glossario-web-design' },
        ]}
        eyebrow={`Glossario — ${GLOSSARIO.length} termini · ordine A-Z`}
        title="Glossario Web Design · I 30 termini che le agenzie sperano tu non capisca."
        lead={
          <>
            Il modo più veloce per farti vendere fumo è usare termini tecnici che non
            capisci. Eccoli, spiegati per quello che sono — e perché ti riguardano.
            Per ogni termine: cos'è, perché ti riguarda, cosa pretendere dal
            fornitore.
          </>
        }
        chapters={chapters}
        indexVariant="alphabet"
        readTime="lettura libera"
        updatedAt="5 maggio 2026"
        showFinalCta={false}
      >
        <div className="flex flex-col">
          {GLOSSARIO_LETTERS.map((letter) => {
            const terms = termsByLetter.get(letter)!;
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
                  {terms.map((t) => (
                    <li
                      key={t.slug}
                      id={t.slug}
                      className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-10 scroll-mt-24"
                    >
                      <div className="md:col-span-4">
                        <Heading as="h3" size="card" className="mb-2">
                          {t.term}
                        </Heading>
                        {t.fullName ? (
                          <MonoLabel as="p">{t.fullName}</MonoLabel>
                        ) : null}
                      </div>

                      <div className="md:col-span-8 space-y-4">
                        <div>
                          <MonoLabel as="p" tone="accent" className="mb-2">
                            Cos&apos;è
                          </MonoLabel>
                          <p
                            className="body-longform max-w-[80ch] text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                            style={{ color: 'var(--color-text-primary)' }}
                          >
                            {t.whatItIs}
                          </p>
                        </div>
                        <div>
                          <MonoLabel as="p" tone="accent" className="mb-2">
                            Perché ti riguarda
                          </MonoLabel>
                          <p
                            className="body-longform max-w-[80ch] text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                            style={{ color: 'var(--color-text-secondary)' }}
                          >
                            {t.whyYouCare}
                          </p>
                        </div>
                        <div>
                          <MonoLabel as="p" tone="accent" className="mb-2">
                            Cosa pretendere
                          </MonoLabel>
                          <p
                            className="body-longform max-w-[80ch] text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                            style={{ color: 'var(--color-text-secondary)' }}
                          >
                            {t.whatToDemand}
                          </p>
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
            style={{ maxWidth: '42ch' }}
          >
            Adesso quando un fornitore ti dice "non preoccuparti del CLS, è normale
            che sia rosso", sai cosa rispondere.
          </Heading>
          <div className="flex flex-wrap gap-6">
            <Button href="/contatti" variant="underline" size="md">
              Parlane con uno che capisce
              <span aria-hidden="true">→</span>
            </Button>
            <Button
              href="/web-design-freelance"
              variant="underline"
              size="md"
              className="opacity-70"
            >
              Guida completa al web design freelance
              <span aria-hidden="true">→</span>
            </Button>
          </div>
        </div>
      </EditorialArticleLayout>
    </>
  );
}
