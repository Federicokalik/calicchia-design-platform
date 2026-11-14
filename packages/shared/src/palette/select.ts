/**
 * Dalla somma dei cluster delle foto alla palette finale, poi ai ruoli
 * (sfondo, testo, primario, accento) con la correzione dei contrasti.
 */

import { type Lab, contrast, deltaE, hexToLab, hueDistance, labToHex, labToLch, oklch } from './color';
import type { Cluster } from './extract';
import { type PresetKey } from './presets';
import { hashString } from './rng';
import type { PaletteColor, PaletteRoles, PhotoInput, RoleFix } from './types';

export const PALETTE_SIZE = 5;

export interface SelectOptions {
  photos: readonly PhotoInput[];
  /** Colori del logo: entrano per primi e restano fissi. */
  logoColors?: readonly Cluster[];
  /** Colori bloccati dall'utente. */
  locked?: readonly { hex: string; lab: Lab }[];
  size?: number;
}

/**
 * Raggruppa i cluster di tutte le foto, li ordina per rappresentatività
 * (peso × croma × numero di foto in cui compaiono) e sceglie i colori più
 * distanti tra loro, allentando la distanza minima finché non bastano.
 * Risultato ordinato dal più chiaro al più scuro.
 */
export function selectPalette({ photos, logoColors = [], locked = [], size = PALETTE_SIZE }: SelectOptions): PaletteColor[] {
  const candidates: { lab: Lab; w: number; pid: string }[] = [];
  for (const p of photos) for (const c of p.clusters) candidates.push({ lab: c.lab, w: c.w * p.weight, pid: p.id });
  candidates.sort((a, b) => b.w - a.w);

  const groups: { lab: Lab; w: number; pids: Set<string>; score: number }[] = [];
  for (const c of candidates) {
    const g = groups.find((gr) => deltaE(gr.lab, c.lab) < 0.05);
    if (g) {
      const tw = g.w + c.w;
      g.lab = g.lab.map((v, i) => (v * g.w + c.lab[i] * c.w) / tw) as Lab;
      g.w = tw;
      g.pids.add(c.pid);
    } else {
      groups.push({ lab: [...c.lab] as Lab, w: c.w, pids: new Set([c.pid]), score: 0 });
    }
  }
  for (const g of groups) {
    const C = Math.hypot(g.lab[1], g.lab[2]);
    g.score = g.w * (1 + 3 * C) * (1 + 0.15 * (g.pids.size - 1)) * (C < 0.03 ? 0.6 : 1);
  }
  groups.sort((a, b) => b.score - a.score);

  const chosen: PaletteColor[] = logoColors.map((c) => ({ hex: c.hex, lab: c.lab, locked: true, fromLogo: true, w: c.w }));
  for (const l of locked) {
    if (!chosen.some((c) => c.hex === l.hex)) chosen.push({ hex: l.hex, lab: l.lab, locked: true });
  }
  for (const minD of [0.09, 0.07, 0.05, 0.03]) {
    for (const g of groups) {
      if (chosen.length >= size) break;
      if (chosen.every((c) => deltaE(c.lab, g.lab) >= minD)) {
        const hex = labToHex(g.lab);
        if (!chosen.some((c) => c.hex === hex)) chosen.push({ hex, lab: hexToLab(hex), locked: false });
      }
    }
    if (chosen.length >= size) break;
  }
  return chosen.sort((a, b) => b.lab[0] - a.lab[0]);
}

export interface RolesOptions {
  /** Correggi la luminosità di primario e accento per i contrasti (default true). */
  autofix?: boolean;
  /** Primario scelto dall'utente, se ancora in palette. */
  primaryHex?: string | null;
}

const WHITE = '#FFFFFF';

/**
 * Ruoli della palette. Neutri derivati (non estratti) dalla tinta del colore
 * più chiaro e di quello più scuro; primario = colore saturo di luminosità
 * media (o quello del logo); accento = il più saturo e lontano di tinta.
 * Con autofix il primario arriva a 4,5:1 col testo del bottone e l'accento a
 * 4,5:1 sullo sfondo cambiando solo la luminosità OKLCH.
 */
export function deriveRoles(palette: readonly PaletteColor[], { autofix = true, primaryHex = null }: RolesOptions = {}): PaletteRoles {
  if (!palette.length) throw new Error('deriveRoles: palette vuota');
  const byL = [...palette].sort((a, b) => b.lab[0] - a.lab[0]);
  const [, Cl, hl] = labToLch(byL[0].lab);
  const [, Cd, hd] = labToLch(byL[byL.length - 1].lab);
  const bg = oklch(0.975, Math.min(Cl * 0.3, 0.018), hl);
  const surface = oklch(0.993, Math.min(Cl * 0.12, 0.006), hl);
  const text = oklch(0.22, Math.min(Cd * 0.5, 0.035), hd);
  const muted = oklch(0.46, Math.min(Cd * 0.4, 0.03), hd);
  const border = oklch(0.885, Math.min(Cl * 0.3, 0.02), hl);

  const primaryScore = (p: PaletteColor): number => {
    const [L, C] = labToLch(p.lab);
    return C * (L >= 0.3 && L <= 0.82 ? 1 : 0.35);
  };
  const logoPrimary = palette
    .filter((p) => p.fromLogo && labToLch(p.lab)[1] > 0.04)
    .sort((a, b) => (b.w ?? 0) - (a.w ?? 0))[0];
  const primary =
    palette.find((p) => p.hex === primaryHex) ?? logoPrimary ?? [...palette].sort((a, b) => primaryScore(b) - primaryScore(a))[0];
  const [Lp, Cp, hp] = labToLch(primary.lab);

  const others = palette.filter((p) => p !== primary);
  const accentScore = (p: PaletteColor): number => {
    const [L, C, h] = labToLch(p.lab);
    return C * (0.4 + hueDistance(h, hp) / 180) * (L > 0.25 && L < 0.85 ? 1 : 0.5);
  };
  const accent =
    others.filter((p) => labToLch(p.lab)[1] > 0.04).sort((a, b) => accentScore(b) - accentScore(a))[0] ??
    [...others].sort((a, b) => labToLch(b.lab)[1] - labToLch(a.lab)[1])[0] ??
    primary;

  const fixes: RoleFix[] = [];
  const bestOn = (hex: string): { on: string; ratio: number } => {
    const w = contrast(hex, WHITE);
    const t = contrast(hex, text);
    return w >= t ? { on: WHITE, ratio: w } : { on: text, ratio: t };
  };

  let primaryUsed = primary.hex;
  let on = bestOn(primaryUsed);
  if (autofix && on.ratio < 4.5) {
    for (let i = 1; i <= 60; i++) {
      const d = i / 100;
      if (Lp - d >= 0.15) {
        const c = oklch(Lp - d, Cp, hp);
        const o = bestOn(c);
        if (o.ratio >= 4.5) {
          primaryUsed = c;
          on = o;
          break;
        }
      }
      if (Lp + d <= 0.95) {
        const c = oklch(Lp + d, Cp, hp);
        const o = bestOn(c);
        if (o.ratio >= 4.5) {
          primaryUsed = c;
          on = o;
          break;
        }
      }
    }
    if (primaryUsed !== primary.hex) fixes.push({ kind: 'primary', from: primary.hex, to: primaryUsed, ratio: on.ratio, on: on.on });
  }

  let accentText = accent.hex;
  if (autofix && contrast(accentText, bg) < 4.5) {
    const [La, Ca, ha] = labToLch(accent.lab);
    for (let i = 1; i <= 80; i++) {
      const L = La - i / 100;
      if (L < 0.08) break;
      const c = oklch(L, Ca, ha);
      if (contrast(c, bg) >= 4.5) {
        accentText = c;
        break;
      }
    }
    if (accentText !== accent.hex) fixes.push({ kind: 'accentText', from: accent.hex, to: accentText, ratio: contrast(accentText, bg) });
  }

  return { bg, surface, text, muted, border, primary: primary.hex, primaryUsed, onPrimary: on.on, accent: accent.hex, accentText, fixes };
}

export type PaletteTemperature = 'warm' | 'cool' | 'mixed';
export type PaletteSaturation = 'saturated' | 'soft' | 'muted';

export interface PresetSuggestion {
  key: PresetKey;
  temperature: PaletteTemperature;
  saturation: PaletteSaturation;
  /** Croma media della palette. */
  avgChroma: number;
  /** True se lo stile viene dal settore, false se dedotto dai colori. */
  fromSector: boolean;
}

/** Stile suggerito: quello del settore se c'è, altrimenti dedotto da croma, temperatura e luminosità. */
export function suggestPreset(palette: readonly PaletteColor[], sectorPreset: PresetKey | null): PresetSuggestion {
  const lch = palette.map((p) => labToLch(p.lab));
  const chromatic = lch.filter(([, C]) => C > 0.04);
  const avgChroma = lch.reduce((s, [, C]) => s + C, 0) / (lch.length || 1);
  const avgL = lch.reduce((s, [L]) => s + L, 0) / (lch.length || 1);
  const warmShare = chromatic.length ? chromatic.filter(([, , h]) => h >= 15 && h <= 110).length / chromatic.length : 0;
  const temperature: PaletteTemperature = warmShare >= 0.6 ? 'warm' : warmShare <= 0.3 ? 'cool' : 'mixed';
  const saturation: PaletteSaturation = avgChroma > 0.11 ? 'saturated' : avgChroma > 0.06 ? 'soft' : 'muted';
  let key = sectorPreset;
  if (!key) {
    key =
      avgChroma > 0.12 && temperature === 'warm' ? 'morbido' : avgChroma < 0.07 ? 'editoriale' : avgL < 0.5 ? 'tecnico' : 'netto';
  }
  return { key, temperature, saturation, avgChroma, fromSector: !!sectorPreset };
}

/** Normalizza un testo di ricerca: minuscolo, senza accenti, spazi compattati. Chiave di cache e matching. */
export function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sei colori "di settore" generici ricavati dall'hash del testo: base delle
 * foto simulate quando un settore non è curato e l'API non risponde.
 */
export function fallbackMood(text: string): string[] {
  const h0 = hashString(normalizeQuery(text)) % 360;
  return [
    oklch(0.3, 0.05, h0),
    oklch(0.62, 0.14, h0 + 25),
    oklch(0.93, 0.03, h0 + 10),
    oklch(0.55, 0.11, h0 + 170),
    oklch(0.76, 0.1, h0 - 35),
    oklch(0.45, 0.08, h0 + 60),
  ];
}
