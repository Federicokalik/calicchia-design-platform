/**
 * Estrazione dei colori dominanti: k-means++ nello spazio OKLab.
 *
 * Lavora su buffer RGBA (canvas nel browser, JPEG decodificato su server),
 * quindi lo stesso codice gira ovunque e dà gli stessi cluster a parità di
 * seed.
 */

import { type Lab, deltaE, hexToLab, labToHex, srgb8ToLab } from './color';
import type { Rand } from './rng';

export interface WeightedLab {
  lab: Lab;
  /** Quota di pixel del cluster, 0..1. */
  w: number;
}

export interface Cluster {
  hex: string;
  lab: Lab;
  w: number;
}

/**
 * k-means++ su punti OKLab. Restituisce i cluster ordinati per peso; il
 * colore di ciascuno è la media con la croma portata al 70° percentile,
 * perché la media pura esce smorta.
 */
export function kmeansLab(points: readonly Lab[], k: number, rand: Rand): WeightedLab[] {
  const n = points.length;
  if (!n) return [];
  const K = Math.min(k, n);
  const P = new Float32Array(n * 3);
  points.forEach((p, i) => {
    P[i * 3] = p[0];
    P[i * 3 + 1] = p[1];
    P[i * 3 + 2] = p[2];
  });
  const C = new Float32Array(K * 3);
  const d2 = (i: number, c: number): number => {
    const a = P[i * 3] - C[c * 3];
    const b = P[i * 3 + 1] - C[c * 3 + 1];
    const e = P[i * 3 + 2] - C[c * 3 + 2];
    return a * a + b * b + e * e;
  };

  const first = Math.floor(rand() * n);
  C[0] = P[first * 3];
  C[1] = P[first * 3 + 1];
  C[2] = P[first * 3 + 2];
  const D = new Float32Array(n);
  for (let c = 1; c < K; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let j = 0; j < c; j++) {
        const v = d2(i, j);
        if (v < m) m = v;
      }
      D[i] = m;
      sum += m;
    }
    let r = rand() * sum;
    let idx = n - 1;
    for (let i = 0; i < n; i++) {
      r -= D[i];
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    C[c * 3] = P[idx * 3];
    C[c * 3 + 1] = P[idx * 3 + 1];
    C[c * 3 + 2] = P[idx * 3 + 2];
  }

  const A = new Uint8Array(n);
  for (let it = 0; it < 14; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bm = Infinity;
      for (let c = 0; c < K; c++) {
        const v = d2(i, c);
        if (v < bm) {
          bm = v;
          best = c;
        }
      }
      if (A[i] !== best) {
        A[i] = best;
        moved = true;
      }
    }
    const S = new Float64Array(K * 3);
    const cnt = new Uint32Array(K);
    for (let i = 0; i < n; i++) {
      const c = A[i];
      S[c * 3] += P[i * 3];
      S[c * 3 + 1] += P[i * 3 + 1];
      S[c * 3 + 2] += P[i * 3 + 2];
      cnt[c]++;
    }
    for (let c = 0; c < K; c++) {
      if (cnt[c]) {
        C[c * 3] = S[c * 3] / cnt[c];
        C[c * 3 + 1] = S[c * 3 + 1] / cnt[c];
        C[c * 3 + 2] = S[c * 3 + 2] / cnt[c];
      }
    }
    if (!moved && it > 0) break;
  }

  const out: WeightedLab[] = [];
  for (let c = 0; c < K; c++) {
    const chromas: number[] = [];
    for (let i = 0; i < n; i++) if (A[i] === c) chromas.push(Math.hypot(P[i * 3 + 1], P[i * 3 + 2]));
    if (!chromas.length) continue;
    const L = C[c * 3];
    const a = C[c * 3 + 1];
    const b = C[c * 3 + 2];
    const mc = Math.hypot(a, b);
    let lab: Lab = [L, a, b];
    if (mc >= 0.025) {
      chromas.sort((x, y) => x - y);
      const target = Math.min(chromas[Math.floor(chromas.length * 0.7)], mc * 1.35);
      lab = [L, (a / mc) * target, (b / mc) * target];
    }
    out.push({ lab, w: chromas.length / n });
  }
  return out.sort((x, y) => y.w - x.w);
}

/** Unisce i cluster percettivamente uguali (ΔE < 0,05), tiene i più pesanti e rinormalizza i pesi. */
export function topClusters(clusters: readonly WeightedLab[], minWeight: number, max: number): Cluster[] {
  const merged: WeightedLab[] = [];
  for (const c of clusters) {
    const m = merged.find((x) => deltaE(x.lab, c.lab) < 0.05);
    if (m) {
      const tw = m.w + c.w;
      m.lab = m.lab.map((v, i) => (v * m.w + c.lab[i] * c.w) / tw) as Lab;
      m.w = tw;
    } else {
      merged.push({ lab: [...c.lab] as Lab, w: c.w });
    }
  }
  merged.sort((x, y) => y.w - x.w);
  const top = merged.filter((o) => o.w >= minWeight).slice(0, max);
  const total = top.reduce((s, o) => s + o.w, 0) || 1;
  return top.map((o) => {
    const hex = labToHex(o.lab);
    return { hex, lab: hexToLab(hex), w: o.w / total };
  });
}

export interface ExtractOptions {
  /** Numero di cluster del k-means (default 4). */
  k?: number;
  /** Peso minimo di un cluster per entrare (default 0,05). */
  minWeight?: number;
  /** Cluster massimi restituiti (default 3). */
  max?: number;
}

/**
 * Colori dominanti di un'immagine già ridotta (es. 64×48). I pixel con alpha
 * sotto 128 vengono ignorati.
 */
export function extractFromPixels(rgba: ArrayLike<number>, rand: Rand, opts: ExtractOptions = {}): Cluster[] {
  const points: Lab[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    points.push(srgb8ToLab(rgba[i], rgba[i + 1], rgba[i + 2]));
  }
  return topClusters(kmeansLab(points, opts.k ?? 4, rand), opts.minWeight ?? 0.05, opts.max ?? 3);
}

/** Cluster serializzati (JSON di pre-calcolo, risposta API) → cluster completi. */
export function hydrateClusters(stored: readonly { hex: string; w: number }[]): Cluster[] {
  return stored.map((c) => ({ hex: c.hex, lab: hexToLab(c.hex), w: c.w }));
}
