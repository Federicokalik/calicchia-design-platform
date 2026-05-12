import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import { EditorialArticleLayout } from '@/components/layout/EditorialArticleLayout';
import { buildCanonical, buildI18nAlternates } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';
import { MIGRAZIONE_GA4_CONTENT, chapterEntries } from './content';

const PATH = '/migrazione-google-analytics-4';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const c = MIGRAZIONE_GA4_CONTENT[locale];
  return {
    title: { absolute: c.metaTitle },
    description: c.metaDescription,
    alternates: buildI18nAlternates(PATH, locale),
    openGraph: {
      title: c.ogTitle,
      description: c.ogDescription,
      url: buildCanonical(PATH, locale),
    },
  };
}

export default async function MigrazioneGA4Page() {
  const locale = (await getLocale()) as Locale;
  const c = MIGRAZIONE_GA4_CONTENT[locale];

  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title: c.schemaTitle,
            description: c.schemaDescription,
            url: PATH,
            section: c.schemaSection,
            datePublished: '2026-05-08',
          }),
          breadcrumbSchema(c.breadcrumbs),
        ]}
      />

      <EditorialArticleLayout
        breadcrumbs={c.breadcrumbs}
        eyebrow={c.eyebrow}
        title={c.title}
        lead={<>{c.lead}</>}
        chapters={chapterEntries(c)}
        readTime={c.readTime}
        updatedAt={c.updatedAt}
        showFinalCta={true}
      >
        {/* Cap 01 — Intro */}
        <section id="morto-ua" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.intro.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.intro.lead}
          </p>
          {c.intro.body.map((html, i) => (
            <p
              key={i}
              className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ))}
        </section>

        {/* Cap 02 — Problemi (cards) */}
        <section id="problemi" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.problems.kicker}</Kicker>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {c.problems.items.map((p) => (
              <li
                key={p.n}
                className="flex flex-col gap-4 p-6 md:p-8"
                style={{ border: '1px solid var(--color-line)' }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    letterSpacing: '0.18em',
                    color: 'var(--color-accent-deep)',
                  }}
                >
                  {p.n} — Problema
                </span>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.5rem, 2.2vw, 2rem)',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.1,
                  }}
                >
                  {p.title}
                </h3>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {p.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 03 — Migrazione (steps list) */}
        <section id="migrazione" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.migration.kicker}</Kicker>
          <ul className="flex flex-col">
            {c.migration.items.map((s, i) => (
              <li
                key={s.n}
                className="grid grid-cols-1 md:grid-cols-[80px_1fr_2fr] gap-4 md:gap-8 py-6"
                style={{
                  borderTop: i === 0 ? '1px solid var(--color-line)' : undefined,
                  borderBottom: '1px solid var(--color-line)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    letterSpacing: '0.18em',
                    color: 'var(--color-accent-deep)',
                  }}
                >
                  {s.n}
                </span>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.125rem, 1.6vw, 1.375rem)',
                    fontWeight: 500,
                    lineHeight: 1.2,
                  }}
                >
                  {s.title}
                </h3>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {s.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 04 — Consent */}
        <section id="consent" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.consent.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.consent.lead}
          </p>
          {c.consent.body.map((html, i) => (
            <p
              key={i}
              className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ))}
        </section>

        {/* Cap 05 — Dashboard */}
        <section id="dashboard" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.dashboard.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.dashboard.lead}
          </p>
          {c.dashboard.body.map((html, i) => (
            <p
              key={i}
              className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ))}
          <ul className="flex flex-col gap-3 max-w-[80ch] list-disc pl-6 mb-6">
            {c.dashboard.bullets.map((html, i) => (
              <li
                key={i}
                className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                style={{ color: 'var(--color-ink)' }}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ))}
          </ul>
          <p
            className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
          >
            {c.dashboard.outro}
          </p>
        </section>

        {/* Cap 06 — FAQs */}
        <section id="faqs" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.faqs.kicker}</Kicker>
          <ul className="flex flex-col">
            {c.faqs.items.map((f, i) => (
              <li
                key={i}
                className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-4 md:gap-12 py-8"
                style={{
                  borderTop: i === 0 ? '1px solid var(--color-line)' : undefined,
                  borderBottom: '1px solid var(--color-line)',
                }}
              >
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.125rem, 1.6vw, 1.375rem)',
                    fontWeight: 500,
                    lineHeight: 1.2,
                  }}
                >
                  {f.q}
                </h3>
                <p
                  className="body-longform text-base md:text-lg leading-relaxed max-w-[80ch] whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {f.a}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </EditorialArticleLayout>
    </>
  );
}

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mb-6"
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--color-ink-muted)',
      }}
    >
      {children}
    </p>
  );
}
