import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import { EditorialArticleLayout } from '@/components/layout/EditorialArticleLayout';
import { buildCanonical, buildI18nAlternates } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';
import { EAA_CONTENT, chapterEntries } from './content';

const PATH = '/european-accessibility-act-2025';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const c = EAA_CONTENT[locale];
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

export default async function EuropeanAccessibilityAct2025Page() {
  const locale = (await getLocale()) as Locale;
  const c = EAA_CONTENT[locale];

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
        <section id="cosa-e" className="mb-20 md:mb-28 scroll-mt-32">
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

        {/* Cap 02 — Obligated */}
        <section id="chi" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.obligated.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-10 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.obligated.lead}
          </p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {c.obligated.sectors.map((s) => (
              <li
                key={s.label}
                className="flex flex-col gap-3 p-6"
                style={{ border: '1px solid var(--color-line)' }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.125rem, 1.6vw, 1.375rem)',
                    fontWeight: 500,
                    lineHeight: 1.2,
                  }}
                >
                  {s.label}
                </span>
                <p className="text-sm md:text-base leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink-muted)' }}>
                  {s.detail}
                </p>
              </li>
            ))}
          </ul>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mt-8 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
            dangerouslySetInnerHTML={{ __html: c.obligated.afterNote }}
          />
        </section>

        {/* Cap 03 — Sanctions */}
        <section id="sanzioni" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.sanctions.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.sanctions.lead}
          </p>
          {c.sanctions.body.map((html, i) => (
            <p
              key={i}
              className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ))}
        </section>

        {/* Cap 04 — WCAG */}
        <section id="wcag" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.wcag.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.wcag.lead}
          </p>
          <p
            className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink)' }}
            dangerouslySetInnerHTML={{ __html: c.wcag.principlesTitle }}
          />
          <ul className="flex flex-col gap-4 mb-6 max-w-[80ch]">
            {c.wcag.principles.map((p) => (
              <li key={p.name} className="body-longform text-base md:text-lg leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
                <strong>{p.name}:</strong> {p.body}
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 05 — Violations */}
        <section id="violazioni" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.violations.kicker}</Kicker>
          <ul className="flex flex-col">
            {c.violations.items.map((v, i) => (
              <li
                key={v.n}
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
                  {v.n}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.125rem, 1.6vw, 1.375rem)',
                    fontWeight: 500,
                    lineHeight: 1.2,
                  }}
                >
                  {v.label}
                </span>
                <p className="text-base leading-relaxed whitespace-pre-line text-justify" style={{ color: 'var(--color-ink-muted)' }}>
                  {v.why}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 06 — Checklist */}
        <section id="checklist" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.checklist.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.checklist.lead}
          </p>
          <ol className="flex flex-col gap-6 list-decimal pl-6 max-w-[80ch]">
            {c.checklist.steps.map((s, i) => (
              <li
                key={i}
                className="body-longform text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
                style={{ color: 'var(--color-ink)' }}
                dangerouslySetInnerHTML={{ __html: s.body }}
              />
            ))}
          </ol>
          <p className="body-longform text-base md:text-lg leading-relaxed mt-8 max-w-[80ch] whitespace-pre-line text-justify" style={{ color: 'var(--color-ink)' }}>
            {c.checklist.outro}
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
