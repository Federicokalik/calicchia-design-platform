import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import { EditorialArticleLayout } from '@/components/layout/EditorialArticleLayout';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';
import { WORDPRESS_VS_HEADLESS_CONTENT, chapterEntries } from './content';

const PATH = '/wordpress-vs-headless';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const c = WORDPRESS_VS_HEADLESS_CONTENT[locale];
  return {
    title: { absolute: c.metaTitle },
    description: c.metaDescription,
    alternates: buildI18nAlternates(PATH, locale),
    openGraph: {
      title: c.ogTitle,
      description: c.ogDescription,
      url: buildCanonical(PATH, locale),
      ...buildOgLocale(locale),
    },
  };
}

export default async function WordPressVsHeadlessPage() {
  const locale = (await getLocale()) as Locale;
  const c = WORDPRESS_VS_HEADLESS_CONTENT[locale];

  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title: c.schemaTitle,
            description: c.schemaDescription,
            url: PATH,
            section: c.schemaSection,
            datePublished: '2026-05-09',
            locale,
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
        <section id="cosa-significa" className="mb-20 md:mb-28 scroll-mt-32">
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

        {/* Cap 02 — Archetipi */}
        <section id="archetipi" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.archetypes.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.archetypes.lead}
          </p>
          <ul className="flex flex-col gap-12">
            {c.archetypes.items.map((a) => (
              <li
                key={a.n}
                className="grid grid-cols-1 md:grid-cols-[80px_1fr] gap-4 md:gap-12 border-t pt-6"
                style={{ borderColor: 'var(--color-hairline)' }}
              >
                <NumberLabel>{a.n}</NumberLabel>
                <div>
                  <h3
                    className="mb-3"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1.25rem, 2vw, 1.75rem)',
                      fontWeight: 600,
                      letterSpacing: '-0.02em',
                      lineHeight: 1.2,
                      color: 'var(--color-ink)',
                    }}
                  >
                    {a.name}
                  </h3>
                  <p
                    className="text-base md:text-lg leading-relaxed mb-3 whitespace-pre-line text-justify"
                    style={{ color: 'var(--color-ink)' }}
                  >
                    <strong>Cos&apos;è.</strong> {a.what}
                  </p>
                  <p
                    className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    <strong>Trade-off.</strong> {a.tradeoff}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 03 — Dimensioni */}
        <section id="dimensioni" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.dimensions.kicker}</Kicker>
          <ul className="flex flex-col gap-12">
            {c.dimensions.items.map((d) => (
              <li
                key={d.n}
                className="grid grid-cols-1 md:grid-cols-[80px_1fr] gap-4 md:gap-12"
              >
                <NumberLabel>{d.n}</NumberLabel>
                <div>
                  <h3
                    className="mb-3"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1.25rem, 2vw, 1.75rem)',
                      fontWeight: 600,
                      letterSpacing: '-0.02em',
                      lineHeight: 1.2,
                      color: 'var(--color-ink)',
                    }}
                  >
                    {d.name}
                  </h3>
                  <p
                    className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    {d.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 04 — Quando WP */}
        <section id="quando-wp" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.whenWp.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.whenWp.lead}
          </p>
          {c.whenWp.body.map((html, i) => (
            <p
              key={i}
              className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ))}
        </section>

        {/* Cap 05 — Quando headless */}
        <section id="quando-headless" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.whenHeadless.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.whenHeadless.lead}
          </p>
          {c.whenHeadless.body.map((html, i) => (
            <p
              key={i}
              className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ))}
        </section>

        {/* Cap 06 — Decision matrix */}
        <section id="matrix" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.matrix.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[65ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.matrix.lead}
          </p>
          <ul className="flex flex-col gap-8">
            {c.matrix.items.map((m, i) => (
              <li
                key={i}
                className="grid grid-cols-1 md:grid-cols-[1fr_220px_2fr] gap-4 md:gap-8 border-t pt-6"
                style={{ borderColor: 'var(--color-hairline)' }}
              >
                <p
                  className="text-base md:text-lg"
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 600,
                    letterSpacing: '-0.02em',
                    color: 'var(--color-ink)',
                  }}
                >
                  {m.profile}
                </p>
                <p
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: 'var(--color-accent-deep)',
                  }}
                >
                  {m.suggestion}
                </p>
                <p
                  className="text-base leading-relaxed whitespace-pre-line text-justify"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {m.reason}
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

function NumberLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--color-accent-deep)',
      }}
    >
      {children}
    </span>
  );
}
