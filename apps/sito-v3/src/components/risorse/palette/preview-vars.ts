import type { CSSProperties } from 'react';
import { FONT_FAMILIES, PRESETS, type FontKey, type PaletteRoles, type PresetKey } from '@calicchia/shared/palette';

/**
 * Variabili --p-* dell'anteprima (vedi PaletteTool.module.css). Senza DOM:
 * le usa il tool nel browser e la pagina `condividi` sul server.
 */

/** Stack CSS di un font: la variabile self-hosted, poi i fallback del motore. */
export function fontStackVar(vars: Record<FontKey, string>, key: FontKey): string {
  const fallback = FONT_FAMILIES[key].fallback.map((f) => (/\s/.test(f) && !f.startsWith('ui-') ? `'${f}'` : f));
  return [`var(${vars[key]})`, ...fallback].join(', ');
}

export function previewVars(roles: PaletteRoles, preset: PresetKey, fontVars: Record<FontKey, string>): CSSProperties {
  const p = PRESETS[preset];
  return {
    '--p-bg': roles.bg,
    '--p-surface': roles.surface,
    '--p-text': roles.text,
    '--p-muted': roles.muted,
    '--p-border': roles.border,
    '--p-primary': roles.primaryUsed,
    '--p-on-primary': roles.onPrimary,
    '--p-accent': roles.accent,
    '--p-accent-text': roles.accentText,
    '--p-radius': p.radius,
    '--p-btn-radius': p.buttonRadius,
    '--p-img-radius': p.imageRadius,
    '--p-bw': p.borderWidth,
    '--p-shadow': p.shadow(roles.text),
    '--p-font-h': fontStackVar(fontVars, p.fontHeading),
    '--p-font-b': fontStackVar(fontVars, p.fontBody),
    '--p-font-a': fontStackVar(fontVars, p.fontAccent ?? 'ibm-plex-mono'),
    '--p-h-weight': String(p.headingWeight),
    '--p-h-track': p.headingTracking,
    '--p-h-transform': p.headingTransform,
  } as CSSProperties;
}
