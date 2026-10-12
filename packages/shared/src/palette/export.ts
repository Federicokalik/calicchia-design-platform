/**
 * Esportazione della palette: variabili CSS, tema Tailwind v4, token JSON
 * (formato DTCG) e codici da incollare in Canva.
 *
 * L'@import Google Fonts nel CSS esportato serve al sito dell'utente, non al
 * nostro: il nostro sito carica i font self-hosted.
 */

import { FONT_FAMILIES, PRESETS, type PresetKey, fontStack } from './presets';
import type { PaletteColor, PaletteLocale, PaletteRoles } from './types';

export type ExportFormat = 'css' | 'tailwind' | 'json' | 'canva';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['css', 'tailwind', 'json', 'canva'];

export interface ExportInput {
  /** Nome del settore o testo cercato, solo per l'intestazione. */
  label: string;
  palette: readonly PaletteColor[];
  roles: PaletteRoles;
  preset: PresetKey;
  locale: PaletteLocale;
}

const T = {
  it: {
    title: 'Palette di settore',
    style: 'stile',
    extracted: 'Colori estratti dalle foto',
    roles: 'Ruoli',
    styleBlock: 'Stile',
    fixed: (from: string) => `estratto ${from}, corretto per il contrasto`,
    twUsage: (bw: string) =>
      `Uso: bg-bg text-fg · bg-primary text-on-primary · rounded-card shadow-card · font-heading. Spessore bordi: ${bw}`,
    canvaColors: 'COLORI',
    canvaColorsHelp: 'Incolla un codice alla volta nel selettore colore di Canva o nel tuo Brand Kit.',
    canvaPalette: (i: number) => `Palette ${i}`,
    canvaFromLogo: ' (dal logo)',
    canvaBg: 'Sfondo',
    canvaText: 'Testo',
    canvaPrimary: 'Primario: bottoni e fasce',
    canvaOnPrimary: 'Testo sul primario',
    canvaAccent: 'Accento per i testi',
    canvaFonts: 'FONT',
    canvaFontsHelp: "Cercali per nome in Canva. Se uno non c'è, scegli il più simile.",
    canvaHeadings: 'Titoli',
    canvaBody: 'Testi',
  },
  en: {
    title: 'Industry colour palette',
    style: 'style',
    extracted: 'Colours extracted from the photos',
    roles: 'Roles',
    styleBlock: 'Style',
    fixed: (from: string) => `extracted ${from}, adjusted for contrast`,
    twUsage: (bw: string) =>
      `Usage: bg-bg text-fg · bg-primary text-on-primary · rounded-card shadow-card · font-heading. Border width: ${bw}`,
    canvaColors: 'COLOURS',
    canvaColorsHelp: 'Paste one code at a time into the Canva colour picker or your Brand Kit.',
    canvaPalette: (i: number) => `Palette ${i}`,
    canvaFromLogo: ' (from logo)',
    canvaBg: 'Background',
    canvaText: 'Text',
    canvaPrimary: 'Primary: buttons and bands',
    canvaOnPrimary: 'Text on primary',
    canvaAccent: 'Accent for text',
    canvaFonts: 'FONTS',
    canvaFontsHelp: "Search them by name in Canva. If one is missing, pick the closest.",
    canvaHeadings: 'Headings',
    canvaBody: 'Body',
  },
} as const;

const WEIGHT_NAMES: Record<number, string> = { 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold' };

function header({ label, preset, locale }: ExportInput): string {
  const t = T[locale];
  const p = PRESETS[preset];
  return `/* ${t.title} · ${label} · ${t.style} ${p.name[locale]} */\n@import url('https://fonts.googleapis.com/css2?${p.googleFontsQuery}&display=swap');`;
}

function exportCss(input: ExportInput): string {
  const { palette, roles: r, preset, locale } = input;
  const t = T[locale];
  const p = PRESETS[preset];
  const fixNote = r.primaryUsed !== r.primary ? ` /* ${t.fixed(r.primary)} */` : '';
  return [
    header(input),
    '',
    ':root {',
    `  /* ${t.extracted} */`,
    ...palette.map((c, i) => `  --palette-${i + 1}: ${c.hex};`),
    '',
    `  /* ${t.roles} */`,
    `  --color-bg: ${r.bg};`,
    `  --color-surface: ${r.surface};`,
    `  --color-text: ${r.text};`,
    `  --color-text-muted: ${r.muted};`,
    `  --color-border: ${r.border};`,
    `  --color-primary: ${r.primaryUsed};${fixNote}`,
    `  --color-on-primary: ${r.onPrimary};`,
    `  --color-accent: ${r.accent};`,
    `  --color-accent-text: ${r.accentText};`,
    '',
    `  /* ${t.styleBlock} */`,
    `  --radius: ${p.radius};`,
    `  --radius-button: ${p.buttonRadius};`,
    `  --border-width: ${p.borderWidth};`,
    `  --shadow: ${p.shadow(r.text)};`,
    `  --font-heading: ${fontStack(p.fontHeading)};`,
    `  --font-body: ${fontStack(p.fontBody)};`,
    `  --heading-weight: ${p.headingWeight};`,
    `  --heading-tracking: ${p.headingTracking};`,
    `  --heading-case: ${p.headingTransform};`,
    '}',
  ].join('\n');
}

function exportTailwind(input: ExportInput): string {
  const { palette, roles: r, preset, locale } = input;
  const t = T[locale];
  const p = PRESETS[preset];
  const fixNote = r.primaryUsed !== r.primary ? ` /* ${t.fixed(r.primary)} */` : '';
  return [
    header(input),
    '@import "tailwindcss";',
    '',
    '@theme {',
    ...palette.map((c, i) => `  --color-palette-${i + 1}: ${c.hex};`),
    '',
    `  --color-bg: ${r.bg};`,
    `  --color-surface: ${r.surface};`,
    `  --color-fg: ${r.text};`,
    `  --color-fg-muted: ${r.muted};`,
    `  --color-line: ${r.border};`,
    `  --color-primary: ${r.primaryUsed};${fixNote}`,
    `  --color-on-primary: ${r.onPrimary};`,
    `  --color-accent: ${r.accent};`,
    `  --color-accent-fg: ${r.accentText};`,
    '',
    `  --radius-card: ${p.radius};`,
    `  --radius-button: ${p.buttonRadius};`,
    `  --shadow-card: ${p.shadow(r.text)};`,
    `  --font-heading: ${fontStack(p.fontHeading)};`,
    `  --font-body: ${fontStack(p.fontBody)};`,
    '}',
    '',
    `/* ${t.twUsage(p.borderWidth)} */`,
  ].join('\n');
}

function exportJson({ palette, roles: r, preset }: ExportInput): string {
  const p = PRESETS[preset];
  const tok = (type: string, value: unknown) => ({ $type: type, $value: value });
  const family = (key: typeof p.fontHeading) => [FONT_FAMILIES[key].family, ...FONT_FAMILIES[key].fallback];
  const obj: Record<string, unknown> = {
    color: {
      palette: Object.fromEntries(palette.map((c, i) => [String(i + 1), tok('color', c.hex)])),
      bg: tok('color', r.bg),
      surface: tok('color', r.surface),
      text: tok('color', r.text),
      textMuted: tok('color', r.muted),
      border: tok('color', r.border),
      primary: tok('color', r.primaryUsed),
      onPrimary: tok('color', r.onPrimary),
      accent: tok('color', r.accent),
      accentText: tok('color', r.accentText),
    },
    radius: { card: tok('dimension', p.radius), button: tok('dimension', p.buttonRadius) },
    border: { width: tok('dimension', p.borderWidth) },
    font: {
      heading: tok('fontFamily', family(p.fontHeading)),
      body: tok('fontFamily', family(p.fontBody)),
      headingWeight: tok('fontWeight', p.headingWeight),
    },
  };
  if (p.shadowToken) obj.shadow = { card: tok('shadow', p.shadowToken(r.text)) };
  return JSON.stringify(obj, null, 2);
}

function exportCanva({ label, palette, roles: r, preset, locale }: ExportInput): string {
  const t = T[locale];
  const p = PRESETS[preset];
  return [
    `${t.title} · ${label} · ${t.style} ${p.name[locale]}`,
    '',
    t.canvaColors,
    t.canvaColorsHelp,
    '',
    ...palette.map((c, i) => `${c.hex}   ${t.canvaPalette(i + 1)}${c.fromLogo ? t.canvaFromLogo : ''}`),
    '',
    `${r.bg}   ${t.canvaBg}`,
    `${r.text}   ${t.canvaText}`,
    `${r.primaryUsed}   ${t.canvaPrimary}`,
    `${r.onPrimary}   ${t.canvaOnPrimary}`,
    `${r.accentText}   ${t.canvaAccent}`,
    '',
    t.canvaFonts,
    t.canvaFontsHelp,
    '',
    `${t.canvaHeadings}: ${FONT_FAMILIES[p.fontHeading].family} ${WEIGHT_NAMES[p.headingWeight] ?? ''}`.trim(),
    `${t.canvaBody}: ${FONT_FAMILIES[p.fontBody].family} Regular`,
  ].join('\n');
}

export function exportPalette(format: ExportFormat, input: ExportInput): string {
  switch (format) {
    case 'css':
      return exportCss(input);
    case 'tailwind':
      return exportTailwind(input);
    case 'json':
      return exportJson(input);
    case 'canva':
      return exportCanva(input);
  }
}
