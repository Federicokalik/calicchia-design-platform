import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import type { Locale } from '@/lib/i18n';
import { GEO_WP_CSS, GEO_WP_BODY } from '@/data/risorse/geo-whitepaper';
import { GeoWhitepaperClient } from './GeoWhitepaperClient';

const PATH = '/risorse/dalla-seo-alla-geo';

const META: Record<Locale, { title: string; description: string }> = {
  it: {
    title: 'Dalla SEO alla GEO — White Paper',
    description:
      'Come funzionano davvero i motori generativi (retrieval, embeddings, chunking, fan-out), cosa rende un contenuto citabile e il quadro normativo UE/Italia. Analisi tecnica con fonti primarie e demo interattive.',
  },
  en: {
    title: 'From SEO to GEO — White Paper',
    description:
      'How generative engines actually work (retrieval, embeddings, chunking, fan-out), what makes content citable, and the EU/Italy legal frame. A technical analysis with primary sources and interactive demos.',
  },
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const m = META[locale];
  return {
    title: { absolute: m.title },
    description: m.description,
    alternates: buildI18nAlternates(PATH, locale),
    openGraph: {
      type: 'article',
      title: m.title,
      description: m.description,
      url: buildCanonical(PATH, locale),
      ...buildOgLocale(locale),
    },
  };
}

export default async function GeoWhitepaperPage() {
  const locale = (await getLocale()) as Locale;
  const m = META[locale];
  // EN body falls back to IT until the translation lands.
  const body = GEO_WP_BODY[locale] && GEO_WP_BODY[locale].length > 0 ? GEO_WP_BODY[locale] : GEO_WP_BODY.it;

  // EN override for the CSS-baked Italian label inside demo 04.
  const css =
    locale === 'en' ? `${GEO_WP_CSS}\n.geo-wp .se-true::after{content:"true value 50%"}` : GEO_WP_CSS;

  return (
    <>
      <StructuredData
        json={[
          articleSchema({
            title: m.title,
            description: m.description,
            url: PATH,
            datePublished: '2026-06-16',
            dateModified: '2026-06-16',
            section: locale === 'en' ? 'Resources' : 'Risorse',
            locale,
          }),
          breadcrumbSchema([
            { name: 'Home', url: '/' },
            { name: locale === 'en' ? 'Resources' : 'Risorse', url: '/risorse' },
            { name: m.title, url: PATH },
          ]),
        ]}
      />
      {/* eslint-disable-next-line react/no-danger */}
      <style dangerouslySetInnerHTML={{ __html: css }} />
      {/* Bespoke Swiss document — its markup is injected verbatim; demos are
          re-attached by GeoWhitepaperClient below. */}
      {/* eslint-disable-next-line react/no-danger */}
      <div className="geo-wp" dangerouslySetInnerHTML={{ __html: body }} />
      <GeoWhitepaperClient locale={locale} />
    </>
  );
}
