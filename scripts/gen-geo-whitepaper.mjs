import { readFileSync, writeFileSync } from 'node:fs';

// Source whitepaper (bespoke Swiss HTML). One-shot extraction → TS data module.
const SRC = 'C:/Users/calicchiadesign/Downloads/geo-whitepaper-swiss.html';
const OUT = 'apps/sito-v3/src/data/risorse/geo-whitepaper.ts';

const src = readFileSync(SRC, 'utf8');

// 1) CSS = first <style> block.
let css = src.match(/<style>([\s\S]*?)<\/style>/)[1];

// 2) BODY = from <body> up to the first <script>, minus the progress bar and the
//    floating TOC (replaced by the (doc) layout's minimal top bar).
const body0 = src.slice(src.indexOf('<body>') + 6, src.indexOf('<script>'));
let body = body0
  .replace(/<div class="progress" id="progress"><\/div>\s*/, '')
  .replace(/<button class="toc-toggle"[\s\S]*?<\/button>\s*/, '')
  .replace(/<nav class="toc"[\s\S]*?<\/nav>\s*/, '')
  .trim();

// 3) Drop the Google Fonts @import (we use the site's self-hosted Funnel via
//    CSS variables) and map the family-names to those variables.
css = css
  .replace(/\s*@import url\([^)]*\);\s*/, '\n  ')
  .replace(/(["'])Funnel Display\1/g, 'var(--font-display)')
  .replace(/(["'])Funnel Sans\1/g, 'var(--font-sans)');

const ts = `/**
 * White paper "Dalla SEO alla GEO" - contenuto statico estratto da
 * geo-whitepaper-swiss.html (design Swiss autonomo). NON modificare a mano:
 * rigenerato da scripts/gen-geo-whitepaper.mjs. CSS e body iniettati via
 * dangerouslySetInnerHTML nella route standalone /risorse/dalla-seo-alla-geo.
 * Font Funnel mappati alle variabili self-hosted del sito (--font-display /
 * --font-sans): nessuna richiesta a Google Fonts.
 *
 * Le 4 demo interattive sono ri-attaccate client-side da GeoWhitepaperClient.tsx
 * (gli id #ds-*, #chunk-*, #fo-*, #se-* sono presenti nel body qui sotto).
 */
import { GEO_WP_BODY_EN } from './geo-whitepaper.en';

export type GeoWpLocale = 'it' | 'en';

export const GEO_WP_CSS = ${JSON.stringify(css)};

export const GEO_WP_BODY: Record<GeoWpLocale, string> = {
  it: ${JSON.stringify(body)},
  en: GEO_WP_BODY_EN,
};
`;

writeFileSync(OUT, ts);
console.log('written', OUT);
console.log('css chars', css.length, '| body chars', body.length);
console.log('@import gone?', !/@import/.test(css));
console.log('font-family Funnel left?', /font-family:[^;]*Funnel/.test(css));
console.log('demos present?', ['demo-ds', 'demo-chunk', 'demo-fanout', 'demo-se'].every((d) => body.includes(d)));
