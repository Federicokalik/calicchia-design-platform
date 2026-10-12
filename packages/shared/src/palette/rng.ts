/**
 * Casualità deterministica: stesso seed, stessa palette. Serve perché una
 * pagina settore, il link condiviso e il pre-calcolo devono dare lo stesso
 * risultato in browser e su server.
 */

export type Rand = () => number;

/** mulberry32: generatore a 32 bit, valori in [0, 1). */
export function createRng(seed: number): Rand {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash FNV-1a a 32 bit di una stringa. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Seed successivo per "Rigenera" (LCG). */
export const nextSeed = (seed: number): number => (Math.imul(seed, 1664525) + 1013904223) >>> 0;

/** Fisher-Yates su una copia. */
export function shuffle<T>(arr: readonly T[], rand: Rand): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Sottoinsieme deterministico di n elementi, nell'ordine originale. */
export function pickSubset<T>(arr: readonly T[], n: number, seed: number): T[] {
  if (arr.length <= n) return arr.slice();
  const picked = new Set(shuffle(arr.map((_, i) => i), createRng(seed)).slice(0, n));
  return arr.filter((_, i) => picked.has(i));
}
