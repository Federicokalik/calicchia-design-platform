import type { Metadata } from 'next';
import { getLocale } from 'next-intl/server';
import { StructuredData } from '@/components/seo/StructuredData';
import { articleSchema, breadcrumbSchema } from '@/data/structured-data';
import { buildCanonical, buildI18nAlternates, buildOgLocale } from '@/lib/canonical';
import { buildOgImage } from '@/lib/og-image';
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

// Indice navigabile (rail sticky sx). Gli id corrispondono alle <section> nel body.
const TOC: Array<{ id: string; it: string; en: string }> = [
  { id: 'intro', it: '00 · Introduzione', en: '00 · Introduction' },
  { id: 'tldr', it: 'In breve', en: 'In brief' },
  { id: 's1', it: '01 · Evoluzione SEO→GEO', en: '01 · SEO→GEO evolution' },
  { id: 's2', it: '02 · Meccanica dei motori', en: '02 · Engine mechanics' },
  { id: 's3', it: '03 · Citabilità', en: '03 · Citability' },
  { id: 's4', it: '04 · Mercato IT/UE', en: '04 · IT/EU market' },
  { id: 's4bis', it: '04·B · Misurazione', en: '04·B · Measurement' },
  { id: 's4ter', it: '05 · Diritto UE/Italia', en: '05 · EU/Italy law' },
  { id: 's5', it: '06 · Pratica', en: '06 · Practice' },
  { id: 's6', it: '07 · Anti-hype', en: '07 · Anti-hype' },
];

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale;
  const m = META[locale];
  return {
    title: { absolute: m.title },
    description: m.description,
    alternates: {
      ...buildI18nAlternates(PATH, locale),
      // Variante markdown estesa servita via mirror (.md).
      types: { 'text/markdown': `${PATH}.md` },
    },
    openGraph: {
      type: 'article',
      title: m.title,
      description: m.description,
      url: buildCanonical(PATH, locale),
      images: buildOgImage(m.title, locale),
      ...buildOgLocale(locale),
    },
  };
}

export default async function GeoWhitepaperPage() {
  const locale = (await getLocale()) as Locale;
  const m = META[locale];
  const body = GEO_WP_BODY[locale] && GEO_WP_BODY[locale].length > 0 ? GEO_WP_BODY[locale] : GEO_WP_BODY.it;

  // Split masthead (hero) / contenuto sezioni / footer (bibliografia) per
  // inserire la TOC sticky come colonna sinistra accanto alle sole sezioni.
  // Estraggo il CONTENUTO interno di <main> (senza il tag) per non annidare un
  // secondo <main> dentro quello del layout (chrome).
  const mainOpen = body.indexOf('<main>');
  const mainClose = body.indexOf('</main>');
  const head = mainOpen >= 0 ? body.slice(0, mainOpen) : '';
  const main = mainOpen >= 0 ? body.slice(mainOpen + '<main>'.length, mainClose) : body;
  const foot = mainClose >= 0 ? body.slice(mainClose + '</main>'.length) : '';

  // Fix di layout per l'integrazione nel chrome del sito:
  // - padding-top per scendere sotto l'header fisso (pointer-events-none) e non
  //   accavallarsi col logo (come fa PageHero con pt-32/pt-40);
  // - footer del documento a filo con il SiteFooter (azzera il suo mt-16, solo
  //   qui, via :has — lo <style> è iniettato solo su questa pagina).
  const layoutFix = `
.geo-wp{padding-top:7rem}
@media(min-width:768px){.geo-wp{padding-top:8.5rem}}
main:has(.geo-wp) + footer{margin-top:0}
`;
  // EN override per l'etichetta CSS-baked della demo 04.
  const css = `${GEO_WP_CSS}${
    locale === 'en' ? '\n.geo-wp .se-true::after{content:"true value 50%"}' : ''
  }\n${layoutFix}`;

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

      <div className="geo-wp">
        {/* Hero / masthead — full width */}
        {head ? <div dangerouslySetInnerHTML={{ __html: head }} /> : null}

        {/* Corpo: TOC sticky sx + sezioni (full-width restante) */}
        <div className="geo-wp-wrap mx-auto w-full px-6 md:px-10 lg:px-14">
          <div className="grid grid-cols-1 md:grid-cols-12 md:gap-x-10">
            <aside className="hidden md:block md:col-span-2 md:col-start-1 md:sticky md:top-32 md:self-start">
              <nav aria-label={locale === 'en' ? 'Contents' : 'Indice'} className="geo-toc">
                <p
                  className="mb-3 text-[11px] font-bold uppercase"
                  style={{ letterSpacing: '0.14em', color: 'var(--ink-3, #6f6f6f)', fontFamily: 'var(--font-sans)' }}
                >
                  {locale === 'en' ? 'Contents' : 'Indice'}
                </p>
                <ul className="flex flex-col">
                  {TOC.map((t) => (
                    <li key={t.id}>
                      <a
                        href={`#${t.id}`}
                        className="block py-1.5 text-[12.5px] no-underline hover:opacity-60"
                        style={{ color: 'var(--ink, #111)', fontWeight: 600, fontFamily: 'var(--font-sans)' }}
                      >
                        {locale === 'en' ? t.en : t.it}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </aside>

            <div className="md:col-span-10 md:col-start-3">
              {/* eslint-disable-next-line react/no-danger */}
              <div dangerouslySetInnerHTML={{ __html: main }} />
            </div>
          </div>
        </div>

        {/* Bibliografia / footer del documento — full width */}
        {foot ? <div dangerouslySetInnerHTML={{ __html: foot }} /> : null}
      </div>

      <GeoWhitepaperClient locale={locale} />
    </>
  );
}
