/**
 * White paper "Dalla SEO alla GEO" — assembla CSS + body IT/EN.
 *
 * - `geo-whitepaper.css.ts`  → CSS Swiss SCOPATO sotto `.geo-wp` + full-width
 *   (generato da scripts/gen-geo-whitepaper.mjs).
 * - `geo-whitepaper.it.ts`   → body IT (markup Swiss + 4 demo), allineato al
 *   markdown esteso (src/content/risorse/geo-whitepaper-esteso.it.md).
 * - `geo-whitepaper.en.ts`   → body EN (mirror 1:1 della struttura IT).
 *
 * Iniettato via dangerouslySetInnerHTML dentro un contenitore `.geo-wp` nella
 * pagina /risorse/dalla-seo-alla-geo (integrata nel chrome del sito). Le 4 demo
 * sono ri-attaccate da GeoWhitepaperClient.tsx.
 */
import { GEO_WP_CSS } from './geo-whitepaper.css';
import { GEO_WP_BODY_IT } from './geo-whitepaper.it';
import { GEO_WP_BODY_EN } from './geo-whitepaper.en';

export type GeoWpLocale = 'it' | 'en';

export { GEO_WP_CSS };

export const GEO_WP_BODY: Record<GeoWpLocale, string> = {
  it: GEO_WP_BODY_IT,
  en: GEO_WP_BODY_EN,
};
