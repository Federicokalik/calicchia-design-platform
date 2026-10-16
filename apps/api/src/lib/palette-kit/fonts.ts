/**
 * Font del brand kit in PDF, inline come data URI (Chromium non scarica nulla).
 *
 * - Funnel Display / Sans per la struttura del documento (stessi file del
 *   preventivo, in assets/fonts).
 * - I font dello stile scelto (assets/fonts/palette, copie dei woff2 OFL del
 *   sito): solo quelli del preset, per tenere il PDF leggero.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_FAMILIES, PRESETS, type FontKey, type PresetKey } from '@calicchia/shared/palette';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = resolve(__dirname, '../../../assets/fonts');

/** File per famiglia: stessi pesi che usa il tool. */
const PRESET_FONT_FILES: Record<FontKey, Array<{ file: string; weight: number }>> = {
  nunito: [{ file: 'nunito-800.woff2', weight: 800 }],
  'nunito-sans': [
    { file: 'nunito-sans-400.woff2', weight: 400 },
    { file: 'nunito-sans-600.woff2', weight: 600 },
  ],
  'schibsted-grotesk': [{ file: 'schibsted-grotesk-700.woff2', weight: 700 }],
  'albert-sans': [
    { file: 'albert-sans-400.woff2', weight: 400 },
    { file: 'albert-sans-600.woff2', weight: 600 },
  ],
  fraunces: [{ file: 'fraunces-opsz-500.woff2', weight: 500 }],
  'instrument-sans': [
    { file: 'instrument-sans-400.woff2', weight: 400 },
    { file: 'instrument-sans-600.woff2', weight: 600 },
  ],
  'ibm-plex-sans-condensed': [{ file: 'ibm-plex-sans-condensed-700.woff2', weight: 700 }],
  'ibm-plex-sans': [
    { file: 'ibm-plex-sans-400.woff2', weight: 400 },
    { file: 'ibm-plex-sans-600.woff2', weight: 600 },
  ],
  'ibm-plex-mono': [{ file: 'ibm-plex-mono-500.woff2', weight: 500 }],
};

// Stessi intervalli di quote-renderer.ts: i file Funnel sono divisi in latin e latin-ext.
const LATIN_RANGE = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT_RANGE = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';

const cache = new Map<string, string>();

function fontFace(family: string, file: string, weight: string, range?: string): string {
  const key = `${family}|${file}`;
  let b64 = cache.get(key);
  if (b64 === undefined) {
    try {
      b64 = readFileSync(resolve(FONTS_DIR, file)).toString('base64');
    } catch {
      // File mancante: resta lo stack di ripiego dichiarato nel documento.
      b64 = '';
    }
    cache.set(key, b64);
  }
  if (!b64) return '';
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url("data:font/woff2;base64,${b64}") format('woff2');${range ? `unicode-range:${range};` : ''}}`;
}

/** @font-face del documento: Funnel più i font dello stile. */
export function brandKitFontCss(preset: PresetKey): string {
  const p = PRESETS[preset];
  const keys = new Set<FontKey>([p.fontHeading, p.fontBody, ...(p.fontAccent ? [p.fontAccent] : [])]);
  const blocks = [
    fontFace('Funnel Display', 'funnel-display-latin.woff2', '300 800', LATIN_RANGE),
    fontFace('Funnel Display', 'funnel-display-latin-ext.woff2', '300 800', LATIN_EXT_RANGE),
    fontFace('Funnel Sans', 'funnel-sans-normal-latin.woff2', '300 800', LATIN_RANGE),
    fontFace('Funnel Sans', 'funnel-sans-normal-latin-ext.woff2', '300 800', LATIN_EXT_RANGE),
  ];
  for (const key of keys) {
    for (const f of PRESET_FONT_FILES[key]) {
      blocks.push(fontFace(FONT_FAMILIES[key].family, `palette/${f.file}`, String(f.weight)));
    }
  }
  return blocks.filter(Boolean).join('\n');
}
