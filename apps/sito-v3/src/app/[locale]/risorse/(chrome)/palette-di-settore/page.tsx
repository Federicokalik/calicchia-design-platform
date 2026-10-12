import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { PageHero } from '@/components/layout/PageHero';
import { PaletteTool } from '@/components/risorse/palette/PaletteTool';
import { FaqList, MethodList, ProfessionIndex, RailSection, type IndexGroup } from '@/components/risorse/palette/PageSections';
import { StructuredData } from '@/components/seo/StructuredData';
import { MonoLabel } from '@/components/ui/MonoLabel';
import {
  getSectorIndex,
  getToolSector,
  listFeaturedSlugs,
  listProfessionsByCategory,
  listSectorPageSlugs,
} from '@/data/risorse/palette';
import { PAGE_COPY, TOOL_PATH } from '@/data/risorse/palette/page-copy';
import { getProfessionCategories } from '@/data/seo-professions';
import { faqPageSchema, webApplicationSchema } from '@/data/structured-data';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';
import { buildOgImage, buildTwitterCard } from '@/lib/og-image';
import { PALETTE_FONT_VARS, paletteFontsClassName } from './fonts';

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const c = PAGE_COPY[locale];
  return {
    title: { absolute: c.metaTitle },
    description: c.metaDescription,
    alternates: buildI18nAlternates(TOOL_PATH, locale),
    openGraph: {
      type: 'website',
      title: c.metaTitle,
      description: c.metaDescription,
      url: buildCanonical(TOOL_PATH, locale),
      images: buildOgImage(c.ogTitle, locale),
      ...buildOgLocale(locale),
    },
    twitter: buildTwitterCard(c.ogTitle, c.metaDescription, locale),
  };
}

export default async function PaletteDiSettorePage() {
  const locale = (await getLocale()) as Locale;
  const c = PAGE_COPY[locale];

  const pageSlugs = new Set(listSectorPageSlugs());
  const chipSlugs = listFeaturedSlugs();
  // Primo settore pilota con foto: la pagina parte da una palette vera.
  const initialSlug = chipSlugs.find((slug) => pageSlugs.has(slug)) ?? null;
  const initialSector = initialSlug ? getToolSector(initialSlug, locale) : null;

  const categories = getProfessionCategories(locale);
  const groups: IndexGroup[] = listProfessionsByCategory().map((g) => ({
    categoryId: g.categoryId,
    label: categories[g.categoryId]?.label ?? g.categoryId,
    items: g.professions.map((p) => ({
      slug: p.slug,
      label: p.label[locale],
      href: pageSlugs.has(p.slug) ? `${TOOL_PATH}/${p.slug}` : null,
    })),
  }));

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: c.breadcrumbResources, url: '/risorse' },
    { name: c.breadcrumbTool, url: TOOL_PATH },
  ];

  return (
    <>
      <StructuredData
        json={[
          webApplicationSchema({
            name: c.appName,
            description: c.metaDescription,
            url: buildCanonical(TOOL_PATH, locale),
            category: 'DesignApplication',
            features: c.appFeatures,
            locale,
          }),
          faqPageSchema(c.faqs),
        ]}
      />

      <PageHero
        breadcrumbs={breadcrumbs}
        breadcrumbsLocale={locale}
        eyebrow={c.eyebrow}
        title={c.title}
        intro={c.lead}
        compact
      >
        <MonoLabel as="p" style={{ lineHeight: 1.4 }}>
          {c.facts}
        </MonoLabel>
      </PageHero>

      <div className="mx-auto max-w-[1600px] px-6 md:px-10 lg:px-14">
        <PaletteTool
          locale={locale}
          sectorIndex={getSectorIndex()}
          chipSlugs={chipSlugs}
          initialSector={initialSector}
          defaultLabel={c.defaultLabel}
          fonts={{ className: paletteFontsClassName, vars: PALETTE_FONT_VARS }}
        >
          <RailSection id="pds-metodo" eyebrow={c.methodEyebrow} title={c.methodTitle}>
            <MethodList steps={c.methodSteps} />
          </RailSection>
          <RailSection id="pds-faq" eyebrow="FAQ" title={c.faqTitle}>
            <FaqList faqs={c.faqs} />
          </RailSection>
          <RailSection id="pds-indice" eyebrow={c.indexEyebrow} title={c.indexTitle} lead={c.indexLead}>
            <ProfessionIndex groups={groups} soonLabel={c.indexSoon} />
          </RailSection>
        </PaletteTool>
      </div>
    </>
  );
}
