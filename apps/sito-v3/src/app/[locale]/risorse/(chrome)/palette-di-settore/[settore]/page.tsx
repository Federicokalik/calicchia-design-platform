import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { PRESETS, encodeSharedPalette } from '@calicchia/shared/palette';
import { Link } from '@/i18n/navigation';
import { PageHero } from '@/components/layout/PageHero';
import { PaletteTool } from '@/components/risorse/palette/PaletteTool';
import { RailSection } from '@/components/risorse/palette/PageSections';
import { T, fmt2 } from '@/components/risorse/palette/strings';
import { StructuredData } from '@/components/seo/StructuredData';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import {
  getSectorContent,
  getSectorIndex,
  getSectorProfession,
  getToolSector,
  isIndexable,
  listFeaturedSlugs,
  listSectorPageSlugs,
} from '@/data/risorse/palette';
import { PAGE_COPY, TOOL_PATH } from '@/data/risorse/palette/page-copy';
import { getProfessionCategories } from '@/data/seo-professions';
import {
  getProfessionSlugForLocale,
  getServiceByLandingSlug,
  getServiceUrlPrefix,
  isProfessionValidForService,
} from '@/data/seo-service-matrix';
import { webApplicationSchema } from '@/data/structured-data';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';
import { buildPaletteOgImage } from '@/lib/og-image';
import { computeSectorPalette } from '@/lib/palette/sector-palette';
import { PALETTE_FONT_VARS, paletteFontsClassName } from '../fonts';

interface Params {
  settore: string;
}

/*
 * Allow-list: solo i settori con testi E foto. NON impostare `dynamicParams`:
 * il layout [locale] lo mette a false e questa route lo eredita, quindi uno
 * slug fuori elenco dà 404 senza chiamare la pagina. I parametri vengono da
 * dati nel codice (non dall'API), quindi sono completi già in build: non è il
 * caso descritto in prenota/[slug]/page.tsx, che deve riaprirlo.
 */
export function generateStaticParams(): Params[] {
  return listSectorPageSlugs().map((settore) => ({ settore }));
}

function sectorData(slug: string, locale: Locale) {
  const tool = getToolSector(slug, locale);
  const content = getSectorContent(slug);
  const profession = getSectorProfession(slug);
  if (!tool || !content || !profession || !tool.photos.length) return null;
  return { tool, content, profession, computed: computeSectorPalette(slug, tool.photos, content.preset) };
}

function shareQueryOf(slug: string, computed: NonNullable<ReturnType<typeof computeSectorPalette>>): string | null {
  const { palette, roles, suggestion } = computed;
  if (palette.length < 2) return null;
  return encodeSharedPalette({
    v: 1,
    sector: slug,
    preset: suggestion.key,
    colors: palette.map((p) => p.hex),
    primary: Math.max(0, palette.findIndex((p) => p.hex === roles.primary)),
  });
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { settore } = await params;
  const locale = (await getLocale()) as Locale;
  const data = sectorData(settore, locale);
  if (!data) return {};
  const c = PAGE_COPY[locale];
  const label = data.tool.label;
  const path = `${TOOL_PATH}/${settore}`;
  const title = c.sectorMetaTitle(label);
  const description = c.sectorMetaDescription(label);
  const ogTitle = c.sectorTitle(label);
  const shareQuery = data.computed ? shareQueryOf(settore, data.computed) : null;
  const images = shareQuery ? buildPaletteOgImage(shareQuery, ogTitle, locale) : undefined;
  return {
    title: { absolute: title },
    description,
    alternates: buildI18nAlternates(path, locale),
    // Tier 3 o testi non ancora rivisti: noindex (vedi isIndexable).
    ...(isIndexable(settore) ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      type: 'website',
      title,
      description,
      url: buildCanonical(path, locale),
      ...(images ? { images } : {}),
      ...buildOgLocale(locale),
    },
    twitter: {
      card: 'summary_large_image',
      creator: '@calicchiadesign',
      title,
      description,
      ...(images ? { images: images.map((i) => i.url) } : {}),
    },
  };
}

export default async function PaletteSettorePage({ params }: { params: Promise<Params> }) {
  const { settore } = await params;
  const locale = (await getLocale()) as Locale;
  const data = sectorData(settore, locale);
  if (!data) notFound();

  const { tool, content, profession, computed } = data;
  const c = PAGE_COPY[locale];
  const t = T[locale];
  const label = tool.label;
  const path = `${TOOL_PATH}/${settore}`;
  const categoryLabel = getProfessionCategories(locale)[profession.categoryId]?.label ?? profession.categoryId;

  // Settori correlati: stessa categoria, solo quelli che hanno una pagina.
  const pageSlugs = listSectorPageSlugs();
  const related = pageSlugs
    .filter((slug) => slug !== settore)
    .map((slug) => getSectorProfession(slug))
    .filter((p): p is NonNullable<typeof p> => !!p && p.categoryId === profession.categoryId)
    .slice(0, 8);

  // Landing della matrice solo se servizio × professione è una combinazione valida.
  const sitoWeb = getServiceByLandingSlug('sito-web');
  const landingHref =
    sitoWeb && isProfessionValidForService('sito-web', settore)
      ? `/${getServiceUrlPrefix(sitoWeb, locale)}-${getProfessionSlugForLocale(settore, locale)}`
      : null;

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: c.breadcrumbResources, url: '/risorse' },
    { name: c.breadcrumbTool, url: TOOL_PATH },
    { name: label, url: path },
  ];

  const suggestion = computed?.suggestion ?? null;
  const presetKey = suggestion?.key ?? content.preset;

  return (
    <>
      <StructuredData
        json={webApplicationSchema({
          name: `${c.appName} · ${label}`,
          description: c.sectorMetaDescription(label),
          url: buildCanonical(path, locale),
          category: 'DesignApplication',
          locale,
        })}
      />

      <PageHero
        breadcrumbs={breadcrumbs}
        breadcrumbsLocale={locale}
        eyebrow={c.sectorEyebrow}
        title={c.sectorTitle(label)}
        intro={content.intro[locale]}
        compact
      />

      <div className="mx-auto max-w-[1600px] px-6 md:px-10 lg:px-14">
        <PaletteTool
          locale={locale}
          sectorIndex={getSectorIndex()}
          chipSlugs={listFeaturedSlugs()}
          initialSector={tool}
          defaultLabel={label}
          fonts={{ className: paletteFontsClassName, vars: PALETTE_FONT_VARS }}
        >
          {computed && suggestion ? (
            <RailSection id="pds-perche" eyebrow={c.whyEyebrow} title={c.whyTitle(label)}>
              <p className="max-w-[70ch] text-base leading-relaxed">
                {c.whyBody({
                  label,
                  temp: t.temperature[suggestion.temperature],
                  sat: t.saturation[suggestion.saturation],
                  chroma: fmt2(suggestion.avgChroma, locale),
                  style: PRESETS[presetKey].name[locale],
                  why: PRESETS[presetKey].why[locale],
                })}
              </p>
              <ul role="list" className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-5">
                {computed.palette.map((p) => (
                  <li key={p.hex} className="grid content-start gap-1.5">
                    <span aria-hidden="true" className="block h-14 border" style={{ background: p.hex, borderColor: 'var(--color-line)' }} />
                    <span className="font-mono text-sm">{p.hex}</span>
                    <MonoLabel as="span">
                      {p.hex === computed.roles.primary ? c.whyPrimary : p.hex === computed.roles.accent ? c.whyAccent : ' '}
                    </MonoLabel>
                  </li>
                ))}
              </ul>
            </RailSection>
          ) : null}

          <RailSection id="pds-crediti" eyebrow="Unsplash" title={c.creditsTitle} lead={c.creditsLead}>
            <ul role="list" className="m-0 grid list-none grid-cols-1 gap-x-8 gap-y-2 p-0 text-sm sm:grid-cols-2">
              {tool.photos.map((p) => (
                <li key={p.id}>
                  {t.photoCredit}{' '}
                  <a href={p.authorUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                    {p.author}
                  </a>{' '}
                  {t.photoCreditOn}{' '}
                  <a href={p.photoUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                    Unsplash
                  </a>
                </li>
              ))}
            </ul>
          </RailSection>

          {related.length || landingHref ? (
            <RailSection id="pds-correlati" eyebrow={categoryLabel} title={c.relatedTitle(categoryLabel)}>
              {related.length ? (
                <ul role="list" className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0">
                  {related.map((p) => (
                    <li key={p.slug}>
                      <Link
                        href={`${TOOL_PATH}/${p.slug}`}
                        className="underline decoration-[var(--color-line-strong)] underline-offset-4 hover:decoration-current"
                      >
                        {p.label[locale]}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
              {landingHref ? (
                <div className="grid gap-3 border-t pt-4" style={{ borderColor: 'var(--color-line)' }}>
                  <h3 className="text-base font-semibold">{c.landingTitle}</h3>
                  <p className="max-w-[60ch] text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                    {c.landingBody(label)}
                  </p>
                  <div>
                    <Button href={landingHref} variant="underline" iconAfter="→">
                      {c.landingCta(label)}
                    </Button>
                  </div>
                </div>
              ) : null}
            </RailSection>
          ) : null}
        </PaletteTool>
      </div>
    </>
  );
}
