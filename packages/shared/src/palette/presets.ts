/**
 * I quattro stili del tool: forme, ombre e coppie di font.
 *
 * I font sono indicati per chiave: il sito li carica self-hosted e li mappa
 * sulle sue CSS var, l'esportazione usa il nome della famiglia (il sito
 * dell'utente li prenderà da dove preferisce).
 */

import { rgba } from './color';
import type { PaletteLocale } from './types';

export type FontKey =
  | 'nunito'
  | 'nunito-sans'
  | 'schibsted-grotesk'
  | 'albert-sans'
  | 'fraunces'
  | 'instrument-sans'
  | 'ibm-plex-sans-condensed'
  | 'ibm-plex-sans'
  | 'ibm-plex-mono';

export const FONT_FAMILIES: Record<FontKey, { family: string; fallback: string[] }> = {
  nunito: { family: 'Nunito', fallback: ['ui-rounded', 'system-ui', 'sans-serif'] },
  'nunito-sans': { family: 'Nunito Sans', fallback: ['system-ui', 'sans-serif'] },
  'schibsted-grotesk': { family: 'Schibsted Grotesk', fallback: ['system-ui', 'sans-serif'] },
  'albert-sans': { family: 'Albert Sans', fallback: ['system-ui', 'sans-serif'] },
  fraunces: { family: 'Fraunces', fallback: ['Georgia', 'serif'] },
  'instrument-sans': { family: 'Instrument Sans', fallback: ['system-ui', 'sans-serif'] },
  'ibm-plex-sans-condensed': { family: 'IBM Plex Sans Condensed', fallback: ['Arial Narrow', 'sans-serif'] },
  'ibm-plex-sans': { family: 'IBM Plex Sans', fallback: ['system-ui', 'sans-serif'] },
  'ibm-plex-mono': { family: 'IBM Plex Mono', fallback: ['ui-monospace', 'monospace'] },
};

/** Stack CSS di una famiglia: i nomi con spazi vanno tra apici. */
export function fontStack(key: FontKey): string {
  const { family, fallback } = FONT_FAMILIES[key];
  return [family, ...fallback].map((f) => (/\s/.test(f) && !f.startsWith('ui-') ? `'${f}'` : f)).join(', ');
}

export const PRESET_KEYS = ['morbido', 'netto', 'editoriale', 'tecnico'] as const;

export type PresetKey = (typeof PRESET_KEYS)[number];

export interface ShadowToken {
  color: string;
  offsetX: string;
  offsetY: string;
  blur: string;
  spread: string;
}

export interface Preset {
  key: PresetKey;
  name: Record<PaletteLocale, string>;
  description: Record<PaletteLocale, string>;
  /** Motivazione mostrata quando lo stile è suggerito. */
  why: Record<PaletteLocale, string>;
  radius: string;
  buttonRadius: string;
  imageRadius: string;
  borderWidth: string;
  /** Ombra delle card dato il colore del testo. */
  shadow: (textHex: string) => string;
  /** Stessa ombra come token DTCG; null se lo stile non ha ombre. */
  shadowToken: ((textHex: string) => ShadowToken) | null;
  /** Ombra del campione nella scelta dello stile. */
  sampleShadow: string;
  fontHeading: FontKey;
  fontBody: FontKey;
  /** Font extra usato da dettagli dello stile (solo "tecnico"). */
  fontAccent?: FontKey;
  headingWeight: number;
  headingTracking: string;
  headingTransform: 'none' | 'uppercase';
  /** Parametri family= per l'@import Google Fonts dell'esportazione. */
  googleFontsQuery: string;
}

export const PRESETS: Record<PresetKey, Preset> = {
  morbido: {
    key: 'morbido',
    name: { it: 'Morbido', en: 'Soft' },
    description: {
      it: 'Angoli tondi, ombre leggere, sans arrotondato.',
      en: 'Rounded corners, light shadows, a rounded sans.',
    },
    why: {
      it: 'Angoli tondi e un sans arrotondato accompagnano colori pieni senza appesantirli.',
      en: 'Rounded corners and a rounded sans carry full colours without weighing them down.',
    },
    radius: '18px',
    buttonRadius: '999px',
    imageRadius: '22px',
    borderWidth: '0px',
    shadow: (t) => `0 12px 32px -14px ${rgba(t, 0.35)}`,
    shadowToken: (t) => ({ color: `${t}59`, offsetX: '0px', offsetY: '12px', blur: '32px', spread: '-14px' }),
    sampleShadow: '0 6px 14px -6px currentColor',
    fontHeading: 'nunito',
    fontBody: 'nunito-sans',
    headingWeight: 800,
    headingTracking: '-0.01em',
    headingTransform: 'none',
    googleFontsQuery: 'family=Nunito:wght@800&family=Nunito+Sans:wght@400;600',
  },
  netto: {
    key: 'netto',
    name: { it: 'Netto', en: 'Clean' },
    description: {
      it: 'Angoli appena smussati, bordi sottili, grotesk pulito.',
      en: 'Slightly softened corners, thin borders, a clean grotesk.',
    },
    why: {
      it: 'Bordi sottili e un grotesk pulito danno ordine e un tono affidabile.',
      en: 'Thin borders and a clean grotesk give order and a reliable tone.',
    },
    radius: '8px',
    buttonRadius: '8px',
    imageRadius: '8px',
    borderWidth: '1px',
    shadow: () => 'none',
    shadowToken: null,
    sampleShadow: 'none',
    fontHeading: 'schibsted-grotesk',
    fontBody: 'albert-sans',
    headingWeight: 700,
    headingTracking: '-0.02em',
    headingTransform: 'none',
    googleFontsQuery: 'family=Schibsted+Grotesk:wght@700&family=Albert+Sans:wght@400;600',
  },
  editoriale: {
    key: 'editoriale',
    name: { it: 'Editoriale', en: 'Editorial' },
    description: {
      it: 'Spigoli vivi, filetti sottili, serif nei titoli.',
      en: 'Sharp corners, hairline rules, a serif for headings.',
    },
    why: {
      it: 'Spigoli vivi e un serif nei titoli danno un tono autorevole e misurato.',
      en: 'Sharp corners and a serif for headings give an authoritative, measured tone.',
    },
    radius: '0px',
    buttonRadius: '0px',
    imageRadius: '0px',
    borderWidth: '1px',
    shadow: () => 'none',
    shadowToken: null,
    sampleShadow: 'none',
    fontHeading: 'fraunces',
    fontBody: 'instrument-sans',
    headingWeight: 500,
    headingTracking: '-0.015em',
    headingTransform: 'none',
    googleFontsQuery: 'family=Fraunces:opsz,wght@9..144,500&family=Instrument+Sans:wght@400;600',
  },
  tecnico: {
    key: 'tecnico',
    name: { it: 'Tecnico', en: 'Technical' },
    description: {
      it: 'Bordi spessi, ombre piene, titoli condensati.',
      en: 'Thick borders, solid shadows, condensed headings.',
    },
    why: {
      it: 'Bordi spessi e titoli condensati reggono contrasti forti e un tono energico.',
      en: 'Thick borders and condensed headings hold strong contrasts and an energetic tone.',
    },
    radius: '3px',
    buttonRadius: '3px',
    imageRadius: '3px',
    borderWidth: '2px',
    shadow: (t) => `4px 4px 0 ${t}`,
    shadowToken: (t) => ({ color: t, offsetX: '4px', offsetY: '4px', blur: '0px', spread: '0px' }),
    sampleShadow: '3px 3px 0 currentColor',
    fontHeading: 'ibm-plex-sans-condensed',
    fontBody: 'ibm-plex-sans',
    fontAccent: 'ibm-plex-mono',
    headingWeight: 700,
    headingTracking: '0',
    headingTransform: 'uppercase',
    googleFontsQuery:
      'family=IBM+Plex+Sans+Condensed:wght@700&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@500',
  },
};

export const isPresetKey = (value: unknown): value is PresetKey =>
  typeof value === 'string' && (PRESET_KEYS as readonly string[]).includes(value);
