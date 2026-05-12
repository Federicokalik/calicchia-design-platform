import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import { EditorialArticleLayout } from '@/components/layout/EditorialArticleLayout';
import { buildCanonical, buildI18nAlternates } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';
import { WDVD_CONTENT, chapterEntries } from './content';

const PATH = '/web-designer-vs-developer';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const c = WDVD_CONTENT[locale];
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

export default async function WebDesignerVsDeveloperPage() {
  const locale = (await getLocale()) as Locale;
  const c = WDVD_CONTENT[locale];

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
        {/* Cap 01 — Tabella */}
        <section id="tabella" className="mb-20 md:mb-28 scroll-mt-32">
          <Kicker>{c.table.kicker}</Kicker>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th
                    className="text-left p-4 align-top"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      color: 'var(--color-ink-muted)',
                      borderBottom: '1px solid var(--color-line)',
                      width: '20%',
                    }}
                  >
                    {c.table.aspectHeader}
                  </th>
                  <th
                    className="text-left p-4 align-top"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1rem, 1.4vw, 1.25rem)',
                      fontWeight: 500,
                      color: 'var(--color-ink)',
                      borderBottom: '1px solid var(--color-line)',
                    }}
                  >
                    {c.table.designerHeader}
                  </th>
                  <th
                    className="text-left p-4 align-top"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1rem, 1.4vw, 1.25rem)',
                      fontWeight: 500,
                      color: 'var(--color-ink)',
                      borderBottom: '1px solid var(--color-line)',
                    }}
                  >
                    {c.table.developerHeader}
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.table.rows.map((r, i) => (
                  <tr key={i}>
                    <td
                      className="p-4 align-top"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        letterSpacing: '0.18em',
                        textTransform: 'uppercase',
                        color: 'var(--color-accent-deep)',
                        borderBottom: '1px solid var(--color-line)',
                      }}
                    >
                      {r.label}
                    </td>
                    <td
                      className="p-4 align-top text-sm md:text-base leading-relaxed whitespace-pre-line text-justify"
                      style={{ color: 'var(--color-ink)', borderBottom: '1px solid var(--color-line)' }}
                    >
                      {r.designer}
                    </td>
                    <td
                      className="p-4 align-top text-sm md:text-base leading-relaxed whitespace-pre-line text-justify"
                      style={{ color: 'var(--color-ink)', borderBottom: '1px solid var(--color-line)' }}
                    >
                      {r.developer}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Cap 02 — Origine */}
        <SectionWithLead id="origine" data={c.origin} />

        {/* Cap 03 — Designer */}
        <SectionWithLead id="designer" data={c.designer} />

        {/* Cap 04 — Developer */}
        <SectionWithLead id="developer" data={c.developer} />

        {/* Cap 05 — Unione */}
        <SectionWithLead id="unione" data={c.unione} />

        {/* Cap 06 — Separated */}
        <SectionWithLead id="quando-separati" data={c.separated} />
      </EditorialArticleLayout>
    </>
  );
}

function SectionWithLead({
  id,
  data,
}: {
  id: string;
  data: { kicker: string; lead: string; body: string[] };
}) {
  return (
    <section id={id} className="mb-20 md:mb-28 scroll-mt-32">
      <Kicker>{data.kicker}</Kicker>
      <p
        className="text-xl md:text-2xl leading-relaxed mb-6 max-w-[80ch] whitespace-pre-line text-justify"
        style={{ color: 'var(--color-ink-muted)' }}
      >
        {data.lead}
      </p>
      {data.body.map((html, i) => (
        <p
          key={i}
          className="body-longform text-base md:text-lg leading-relaxed mb-4 max-w-[80ch] whitespace-pre-line text-justify"
          style={{ color: 'var(--color-ink)' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ))}
    </section>
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
