import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import { EditorialArticleLayout } from '@/components/layout/EditorialArticleLayout';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';
import { FREELANCE_VS_AGENZIA_CONTENT, chapterEntries } from './content';

const PATH = '/freelance-vs-agenzia-2026';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const c = FREELANCE_VS_AGENZIA_CONTENT[locale];
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

export default async function FreelanceVsAgenzia2026Page() {
  const locale = (await getLocale()) as Locale;
  const c = FREELANCE_VS_AGENZIA_CONTENT[locale];

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
        <section id="cosa-cambia" className="mb-20 md:mb-28 scroll-mt-32">
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

        {/* Cap 02 — Dimensioni */}
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
                  {d.body.split('\n\n').map((para, pi) => (
                    <p
                      key={pi}
                      className="body-longform text-base md:text-lg leading-relaxed mb-4 last:mb-0 max-w-[80ch] whitespace-pre-line text-justify"
                      style={{ color: 'var(--color-ink-muted)' }}
                    >
                      {para}
                    </p>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Cap 03 — Freelance flags */}
        <section id="freelance-rosso" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.freelanceFlags.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.freelanceFlags.lead}
          </p>
          <FlagList items={c.freelanceFlags.items} />
        </section>

        {/* Cap 04 — Agency flags */}
        <section id="agenzia-rosso" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.agencyFlags.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.agencyFlags.lead}
          </p>
          <FlagList items={c.agencyFlags.items} />
        </section>

        {/* Cap 05 — Decision matrix */}
        <section id="matrix" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.matrix.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.matrix.lead}
          </p>
          <ul className="flex flex-col gap-8">
            {c.matrix.items.map((m, i) => (
              <li
                key={i}
                className="grid grid-cols-1 md:grid-cols-[1fr_180px_2fr] gap-4 md:gap-8 border-t pt-6"
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

        {/* Cap 06 — Outro */}
        <section id="realta" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.outro.kicker}</Kicker>
          <p
            className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            {c.outro.lead}
          </p>
          {c.outro.body.map((html, i) => (
            <p
              key={i}
              className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink)' }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ))}
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

function FlagList({ items }: { items: { n: string; flag: string; body: string }[] }) {
  return (
    <ul className="flex flex-col gap-12">
      {items.map((f) => (
        <li
          key={f.n}
          className="grid grid-cols-1 md:grid-cols-[80px_1fr] gap-4 md:gap-12 border-t pt-6"
          style={{ borderColor: 'var(--color-hairline)' }}
        >
          <NumberLabel>{f.n}</NumberLabel>
          <div>
            <h3
              className="mb-3"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(1.125rem, 1.6vw, 1.5rem)',
                fontWeight: 600,
                letterSpacing: '-0.02em',
                lineHeight: 1.25,
                color: 'var(--color-ink)',
              }}
            >
              {f.flag}
            </h3>
            <p
              className="text-base md:text-lg leading-relaxed whitespace-pre-line text-justify"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {f.body}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
