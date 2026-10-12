/**
 * Colore: sRGB, OKLab, OKLCH e contrasto WCAG 2.2.
 *
 * Porting del prototipo "Palette di settore". Tutte le funzioni sono pure e
 * senza DOM: le usano il sito (browser), l'API (estrazione lato server) e lo
 * script di pre-calcolo delle palette.
 *
 * Convenzioni: Lab = [L, a, b] in OKLab (L 0..1); Lch = [L, C, h] con h in
 * gradi 0..360; gli hex sono sempre in forma #RRGGBB maiuscola.
 */

export type Lab = [number, number, number];
export type Lch = [number, number, number];
export type Rgb = [number, number, number];

/** sRGB 8 bit → lineare. */
export const SRGB_TO_LINEAR: Float32Array = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

const toGamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function linearToLab(r: number, g: number, b: number): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function labToLinear(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Pixel sRGB 8 bit → OKLab. */
export function srgb8ToLab(r: number, g: number, b: number): Lab {
  return linearToLab(SRGB_TO_LINEAR[r], SRGB_TO_LINEAR[g], SRGB_TO_LINEAR[b]);
}

const inGamut = (v: Rgb): boolean => v.every((x) => x >= -0.0005 && x <= 1.0005);

export function lchToLab(L: number, C: number, h: number): Lab {
  const r = (h * Math.PI) / 180;
  return [L, C * Math.cos(r), C * Math.sin(r)];
}

export function labToLch([L, a, b]: Lab): Lch {
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, Math.hypot(a, b), h];
}

/** OKLCH → sRGB 8 bit, riducendo la croma finché il colore entra nel gamut. */
export function lchToRgb(L: number, C: number, h: number): Rgb {
  const l = Math.min(1, Math.max(0, L));
  const c = Math.max(0, C);
  let lin = labToLinear(...lchToLab(l, c, h));
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(labToLinear(...lchToLab(l, mid, h)))) lo = mid;
      else hi = mid;
    }
    lin = labToLinear(...lchToLab(l, lo, h));
  }
  return lin.map((v) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255)) as Rgb;
}

export const rgbToHex = (rgb: Rgb): string =>
  '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

export const hexToRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

export const isHex = (value: string): boolean => /^#[0-9A-F]{6}$/i.test(value);

/** Normalizza in #RRGGBB maiuscolo; accetta anche il valore senza #. Null se non valido. */
export function normalizeHex(value: string): string | null {
  const v = value.trim().replace(/^#?/, '#').toUpperCase();
  return isHex(v) ? v : null;
}

export function hexToLab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex);
  return srgb8ToLab(r, g, b);
}

export function labToHex(lab: Lab): string {
  const [L, C, h] = labToLch(lab);
  return rgbToHex(lchToRgb(L, C, h));
}

/** Colore OKLCH come hex sRGB. */
export const oklch = (L: number, C: number, h: number): string => rgbToHex(lchToRgb(L, C, h));

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Distanza euclidea in OKLab (ΔE OK). */
export const deltaE = (a: Lab, b: Lab): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Luminanza relativa WCAG. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * SRGB_TO_LINEAR[r] + 0.7152 * SRGB_TO_LINEAR[g] + 0.0722 * SRGB_TO_LINEAR[b];
}

/** Rapporto di contrasto WCAG 2.2 tra due hex (1..21). */
export function contrast(x: string, y: string): number {
  const a = luminance(x);
  const b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export type ContrastKind = 'text' | 'ui';
export type ContrastGrade = 'AAA' | 'AA' | 'large-only' | 'ui-pass' | 'fail';

/** Esito WCAG: testo normale (4,5 / 7) oppure componenti grafici (3). */
export function contrastGrade(ratio: number, kind: ContrastKind): { grade: ContrastGrade; pass: boolean } {
  if (kind === 'ui') return ratio >= 3 ? { grade: 'ui-pass', pass: true } : { grade: 'fail', pass: false };
  if (ratio >= 7) return { grade: 'AAA', pass: true };
  if (ratio >= 4.5) return { grade: 'AA', pass: true };
  if (ratio >= 3) return { grade: 'large-only', pass: false };
  return { grade: 'fail', pass: false };
}
