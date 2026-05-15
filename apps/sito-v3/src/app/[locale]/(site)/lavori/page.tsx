import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { Breadcrumbs } from '@/components/seo/Breadcrumbs';
import { StructuredData } from '@/components/seo/StructuredData';
import { breadcrumbSchema, collectionPageSchema } from '@/data/structured-data';
import { Heading } from '@/components/ui/Heading';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { MonoLabel } from '@/components/ui/MonoLabel';
import { Button } from '@/components/ui/Button';
import { Section } from '@/components/ui/Section';
import { FinalCTA } from '@/components/home/FinalCTA';
import { fetchAllPublishedProjects } from '@/lib/projects-api';
import { adaptApiListItem } from '@/lib/projects-adapter';
import { SITE } from '@/data/site';
import type { Locale } from '@/lib/i18n';
import { buildI18nAlternates, buildCanonical, buildOgLocale } from '@/lib/canonical';

const PATH = '/lavori';
const SITE_URL = SITE.url.replace(/\/$/, '');

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('lavori.list.metadata');
  const locale = (await getLocale()) as Locale;

  return {
    title: {
      absolute: t('title'),
    },
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

export default async function LavoriIndexPage() {
  const t = await getTranslations('lavori.list');
  const locale = (await getLocale()) as Locale;
  const apiList = await fetchAllPublishedProjects();
  const projects = apiList.map((p) => adaptApiListItem(p));
  const count = projects.length;

  return (
    <>
      <StructuredData
        json={[
          collectionPageSchema({
            name: 'Portfolio · Lavori',
            description:
              'Lavori realizzati da zero — web design, e-commerce, sviluppo. Progetti pubblicati, online, misurabili.',
            url: `${SITE_URL}${PATH}`,
            items: projects.map((p) => ({
              name: p.title,
              url: `${SITE_URL}/lavori/${p.slug}`,
            })),
            locale,
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: 'Lavori', url: PATH },
          ]),
        ]}
      />

      <header className="px-6 md:px-10 lg:px-14 pt-36 md:pt-44 pb-12 md:pb-16">
        <div className="grid grid-cols-12 gap-6 md:gap-8">
          <div className="col-span-12 md:col-span-9">
            <Breadcrumbs
              items={[
                { name: 'Home', url: '/' },
                { name: 'Lavori', url: PATH },
              ]}
              className="mb-8"
            />
            <Eyebrow as="p" mono className="mb-6">
              {t('eyebrowWithCount', { count })}
            </Eyebrow>
            <Heading
              as="h1"
              size="display-xl"
              className="mb-8"
              style={{ maxWidth: '20ch' }}
            >
              {t('pageTitle')}
            </Heading>
            <p
              className="text-[length:var(--text-body-lg)] leading-relaxed"
              style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
            >
              {t('pageLead')}
            </p>
          </div>
        </div>
      </header>

      <Section spacing="default">
        {count === 0 ? (
          <div className="grid grid-cols-12 gap-6 md:gap-8">
            <div className="col-span-12 md:col-span-7 md:col-start-3">
              <MonoLabel as="p" className="mb-4">
                IN ARRIVO
              </MonoLabel>
              <Heading
                as="h2"
                size="display-md"
                className="mb-6"
                style={{ maxWidth: '20ch' }}
              >
                Nuovi case study in pubblicazione.
              </Heading>
              <p
                className="text-base md:text-lg leading-relaxed mb-6"
                style={{ maxWidth: '60ch', color: 'var(--color-text-secondary)' }}
              >
                Sto preparando il pubblicabile sui progetti recenti. Nel
                frattempo, una chiamata di 30 minuti racconta meglio di
                qualunque case study cosa posso fare per te.
              </p>
              <Button href="/contatti" variant="solid" size="md">
                Scrivimi
                <span aria-hidden="true">→</span>
              </Button>
            </div>
          </div>
        ) : (
          <ul role="list" className="flex flex-col">
            {projects.map((p, i) => {
              const cover = p.cover_image;
              return (
                <li
                  key={p.slug}
                  className="border-t"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <Link
                    href={`/lavori/${p.slug}`}
                    className="group grid grid-cols-12 gap-6 md:gap-8 py-12 md:py-16 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 hover:opacity-95"
                  >
                    {/* Numbering rail SX (Bierut metadata column). Su mobile
                        si fonde con il blocco principale. */}
                    <div
                      className="hidden md:block md:col-span-1 pt-2 tabular-nums"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--text-mono-xs)',
                        letterSpacing: '0.05em',
                        color: 'var(--color-accent-deep)',
                      }}
                      aria-hidden="true"
                    >
                      {String(i + 1).padStart(2, '0')}
                    </div>

                    <div className="col-span-12 md:col-span-6 flex flex-col gap-4">
                      {/* Mobile-only counter inline */}
                      <span
                        className="md:hidden tabular-nums"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 'var(--text-mono-xs)',
                          letterSpacing: '0.05em',
                          color: 'var(--color-accent-deep)',
                        }}
                        aria-hidden="true"
                      >
                        {String(i + 1).padStart(2, '0')}
                      </span>

                      <Heading
                        as="h2"
                        size="display-md"
                        style={{ maxWidth: '18ch' }}
                      >
                        {p.title}
                      </Heading>

                      {/* Metadata row: client / year / industries — spazi tipografici
                          ampi, niente bullet `·` compressi. Bierut-style: ogni
                          campo respira come metadata indipendente. */}
                      <dl
                        className="flex flex-wrap items-baseline gap-x-8 gap-y-2 mt-1"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 'var(--text-mono-xs)',
                          letterSpacing: '0.05em',
                          textTransform: 'uppercase',
                          color: 'var(--color-text-tertiary)',
                        }}
                      >
                        {p.client ? (
                          <div className="flex items-baseline gap-2">
                            <dt aria-hidden="true">Cliente</dt>
                            <dd style={{ color: 'var(--color-text-primary)' }}>
                              {p.client}
                            </dd>
                          </div>
                        ) : null}
                        <div className="flex items-baseline gap-2">
                          <dt aria-hidden="true">Anno</dt>
                          <dd style={{ color: 'var(--color-text-primary)' }}>
                            {p.year}
                          </dd>
                        </div>
                        {p.industries ? (
                          <div className="flex items-baseline gap-2">
                            <dt aria-hidden="true">Settore</dt>
                            <dd style={{ color: 'var(--color-text-primary)' }}>
                              {p.industries}
                            </dd>
                          </div>
                        ) : null}
                      </dl>

                      {p.description ? (
                        <p
                          className="text-base md:text-lg leading-relaxed mt-2"
                          style={{
                            maxWidth: '55ch',
                            color: 'var(--color-text-secondary)',
                          }}
                        >
                          {p.description}
                        </p>
                      ) : null}

                      {/* Tag chips hairline — separati da metadata, opzionali */}
                      {p.tags.length > 0 ? (
                        <ul
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2"
                          aria-label="Tag progetto"
                        >
                          {p.tags.slice(0, 4).map((t) => (
                            <li
                              key={t}
                              className="border px-2 py-0.5"
                              style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 'var(--text-mono-xs)',
                                letterSpacing: '0.05em',
                                textTransform: 'uppercase',
                                borderColor: 'var(--color-border)',
                                color: 'var(--color-text-secondary)',
                              }}
                            >
                              {t}
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      <span
                        className="mt-4 inline-flex items-center gap-2 transition-transform duration-200 group-hover:translate-x-1"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 'var(--text-mono-xs)',
                          letterSpacing: '0.05em',
                          textTransform: 'uppercase',
                          color: 'var(--color-accent-deep)',
                        }}
                      >
                        Apri il case study
                        <span aria-hidden="true">→</span>
                      </span>
                    </div>

                    <div className="col-span-12 md:col-span-5 md:col-start-8 self-start">
                      {cover ? (
                        <div className="relative aspect-video overflow-hidden">
                          <Image
                            src={cover}
                            alt={`${p.title} — cover`}
                            fill
                            sizes="(min-width: 768px) 40vw, 100vw"
                            className="object-cover transition-transform duration-300 ease-out"
                            style={{ viewTransitionName: `case-${p.slug}` }}
                          />
                        </div>
                      ) : (
                        <div
                          className="aspect-video flex items-center justify-center"
                          style={{
                            background:
                              'linear-gradient(135deg, var(--color-surface-elev), var(--color-border))',
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              fontFamily: 'var(--font-display)',
                              fontSize: '6rem',
                              fontWeight: 500,
                              letterSpacing: '-0.04em',
                              color: 'var(--color-text-tertiary)',
                            }}
                          >
                            {p.title.charAt(0)}
                          </span>
                        </div>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
            <li
              className="border-t"
              style={{ borderColor: 'var(--color-border)' }}
              aria-hidden="true"
            />
          </ul>
        )}
      </Section>

      <FinalCTA />
    </>
  );
}
