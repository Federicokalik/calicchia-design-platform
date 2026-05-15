import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import { EditorialArticleLayout } from '@/components/layout/EditorialArticleLayout';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';
import { CWV_CONTENT, chapterEntries } from './content';

const PATH = '/core-web-vitals-audit';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const c = CWV_CONTENT[locale];
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

export default async function CoreWebVitalsAuditPage() {
  const locale = (await getLocale()) as Locale;
  const c = CWV_CONTENT[locale];

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
        <section id="cosa-sono" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.intro.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
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

        {/* Cap 02 — Ranking */}
        <section id="perche" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.ranking.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.ranking.lead}
          </p>
          {c.ranking.body.map((html, i) => (
            <p
              key={i}
              className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ))}
        </section>

        {/* Cap 03 — Metrics */}
        <section id="metriche" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.metrics.kicker}</Kicker>
          <ul className="flex flex-col gap-12">
            {c.metrics.items.map((m) => (
              <li key={m.metric} className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-4 md:gap-12">
                <div>
                  <span
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(2rem, 4vw, 3.5rem)',
                      fontWeight: 700,
                      letterSpacing: '-0.03em',
                      lineHeight: 1,
                      color: 'var(--color-ink)',
                      display: 'block',
                    }}
                  >
                    {m.metric}
                  </span>
                  <span
                    className="mt-3 block"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      color: 'var(--color-accent-deep)',
                    }}
                  >
                    {m.threshold}
                  </span>
                </div>
                <div>
                  <p
                    className="mb-2"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      color: 'var(--color-ink-muted)',
                    }}
                  >
                    {m.fullname}
                  </p>
                  <p
                    className="text-base md:text-lg leading-relaxed mb-4 whitespace-pre-line text-justify"
                    style={{ color: 'var(--color-ink)' }}
                  >
                    {m.what}
                  </p>
                  <p
                    className="mb-2"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      color: 'var(--color-ink-muted)',
                    }}
                  >
                    {m.fixesLabel}
                  </p>
                  <ul className="flex flex-col gap-2 list-disc pl-6">
                    {m.fixes.map((f, i) => (
                      <li key={i} className="text-sm md:text-base leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink-muted)' }}>
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 04 — Tools */}
        <section id="tool" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.tools.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-10 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.tools.lead}
          </p>
          <ul className="flex flex-col">
            {c.tools.items.map((t, i) => (
              <li
                key={t.n}
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
                  {t.n}
                </span>
                <div>
                  <p
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1.125rem, 1.6vw, 1.375rem)',
                      fontWeight: 500,
                      lineHeight: 1.2,
                    }}
                  >
                    {t.name}
                  </p>
                  <p
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      letterSpacing: '0.18em',
                      color: 'var(--color-ink-muted)',
                      marginTop: 4,
                    }}
                  >
                    {t.url}
                  </p>
                </div>
                <p className="text-base leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink-muted)' }}>
                  {t.use}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 05 — Audit */}
        <section id="audit" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.audit.kicker}</Kicker>
          <ol className="flex flex-col gap-6 list-decimal pl-6 max-w-[80ch]">
            {c.audit.steps.map((html, i) => (
              <li
                key={i}
                className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                style={{ color: 'var(--color-ink)' }}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ))}
          </ol>
        </section>

        {/* Cap 06 — Fixes */}
        <section id="fix" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.fixes.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.fixes.lead}
          </p>
          <ol className="flex flex-col gap-6 list-decimal pl-6 max-w-[80ch]">
            {c.fixes.steps.map((html, i) => (
              <li
                key={i}
                className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                style={{ color: 'var(--color-ink)' }}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ))}
          </ol>
          <p className="body-longform text-base md:text-lg leading-relaxed mt-8 max-w-[80ch] whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
            {c.fixes.outro}
          </p>
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
