import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { PRESETS, type SharedPalette, decodeSharedPalette, encodeSharedPalette, hydrateClusters } from '@calicchia/shared/palette';
import { PageHero } from '@/components/layout/PageHero';
import { ContactButton, contactQuery } from '@/components/risorse/palette/ContactButton';
import { PreviewFrame, SamplePreview } from '@/components/risorse/palette/SamplePreview';
import { previewVars } from '@/components/risorse/palette/preview-vars';
import type { ToolPhoto } from '@/components/risorse/palette/state';
import { T, genericCopy } from '@/components/risorse/palette/strings';
import { Button } from '@/components/ui/Button';
import { MonoLabel } from '@/components/ui/MonoLabel';
import {
  getSectorProfession,
  getToolSector,
  isKnownSector,
  listSectorPageSlugs,
} from '@/data/risorse/palette';
import { PAGE_COPY, TOOL_PATH } from '@/data/risorse/palette/page-copy';
import { buildCanonical, buildOgLocale } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';
import { buildOgImage, buildPaletteOgImage } from '@/lib/og-image';
import { paletteFromShared } from '@/lib/palette/sector-palette';
import { PALETTE_FONT_VARS, paletteFontsClassName } from '../fonts';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Pagina del link condiviso: legge la palette dalla querystring validata
 * (`decodeSharedPalette`), noindex, canonical al tool. Il settore entra solo
 * se è uno di quelli pronti: un testo libero non arriva mai qui.
 */

function readShared(sp: SearchParams): SharedPalette | null {
  return decodeSharedPalette(sp, isKnownSector);
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const c = PAGE_COPY[locale];
  const shared = readShared(await searchParams);
  const sectorLabel = shared?.sector ? getSectorProfession(shared.sector)?.label[locale] : undefined;
  const title = sectorLabel ? c.shareTitleSector(sectorLabel) : c.shareTitle;
  const images = shared ? buildPaletteOgImage(encodeSharedPalette(shared), title, locale) : buildOgImage(c.ogTitle, locale);
  return {
    title: { absolute: c.shareMetaTitle },
    description: c.shareMetaDescription,
    robots: { index: false, follow: true },
    alternates: { canonical: buildCanonical(TOOL_PATH, locale) },
    openGraph: {
      type: 'website',
      title,
      description: c.shareMetaDescription,
      url: buildCanonical(TOOL_PATH, locale),
      images,
      ...buildOgLocale(locale),
    },
    twitter: {
      card: 'summary_large_image',
      creator: '@calicchiadesign',
      title,
      description: c.shareMetaDescription,
      images: images.map((i) => i.url),
    },
  };
}

export default async function PaletteCondivisaPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const locale = (await getLocale()) as Locale;
  const c = PAGE_COPY[locale];
  const t = T[locale];
  const shared = readShared(await searchParams);

  const breadcrumbs = [
    { name: 'Home', url: '/' },
    { name: c.breadcrumbResources, url: '/risorse' },
    { name: c.breadcrumbTool, url: TOOL_PATH },
  ];

  if (!shared) {
    return (
      <PageHero breadcrumbs={breadcrumbs} breadcrumbsLocale={locale} eyebrow={c.shareEyebrow} title={c.shareInvalidTitle} intro={c.shareInvalidBody}>
        <Button href={TOOL_PATH} variant="solid" iconAfter="→">
          {c.shareOpenTool}
        </Button>
      </PageHero>
    );
  }

  const sector = shared.sector ? getToolSector(shared.sector, locale) : null;
  const hasPage = !!shared.sector && listSectorPageSlugs().includes(shared.sector);
  const { palette, roles } = paletteFromShared(shared);
  const preset = PRESETS[shared.preset];
  const copy = sector?.copy ?? genericCopy(sector?.label ?? c.appName, locale);
  const firstPhoto = sector?.photos[0];
  const hero: ToolPhoto | null = firstPhoto
    ? { kind: 'unsplash', id: firstPhoto.id, photo: firstPhoto, clusters: hydrateClusters(firstPhoto.clusters) }
    : null;
  const contact = contactQuery(shared.sector, encodeSharedPalette(shared));

  return (
    <>
      <PageHero
        breadcrumbs={breadcrumbs}
        breadcrumbsLocale={locale}
        eyebrow={c.shareEyebrow}
        title={sector ? c.shareTitleSector(sector.label) : c.shareTitle}
        intro={c.shareLead}
        compact
      >
        <div className="flex flex-wrap gap-4">
          <Button href={hasPage ? `${TOOL_PATH}/${shared.sector}` : TOOL_PATH} variant="ghost" iconAfter="→">
            {hasPage && sector ? c.shareOpenSector(sector.label) : c.shareOpenTool}
          </Button>
          <ContactButton query={contact} size="md">
            {c.shareContact}
          </ContactButton>
        </div>
      </PageHero>

      <div className={`mx-auto grid max-w-[1600px] gap-10 px-6 pb-24 md:px-10 lg:px-14 ${paletteFontsClassName}`}>
        <section aria-labelledby="pds-share-colors" className="grid gap-4 border-t pt-6" style={{ borderColor: 'var(--color-ink)' }}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="pds-share-colors" className="text-base font-semibold">
              {c.shareColors}
            </h2>
            <MonoLabel as="span">{c.shareStyle(preset.name[locale])}</MonoLabel>
          </div>
          <ul role="list" className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4 lg:grid-cols-8">
            {palette.map((p, i) => (
              <li key={p.hex} className="grid content-start gap-1.5">
                <span aria-hidden="true" className="block aspect-[4/5] border" style={{ background: p.hex, borderColor: 'var(--color-line)' }} />
                <span className="font-mono text-sm">{p.hex}</span>
                <MonoLabel as="span">{i === shared.primary ? c.sharePrimary : ' '}</MonoLabel>
              </li>
            ))}
          </ul>
        </section>

        <PreviewFrame t={t} presetName={preset.name[locale]}>
          <SamplePreview
            t={t}
            copy={copy}
            preset={shared.preset}
            vars={previewVars(roles, shared.preset, PALETTE_FONT_VARS)}
            hero={hero}
            logoUrl={null}
            fallbackColors={shared.colors}
          />
        </PreviewFrame>
      </div>
    </>
  );
}
