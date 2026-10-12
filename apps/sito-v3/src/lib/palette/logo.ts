/**
 * Solo browser (canvas). Logo del visitatore: scontorno dello sfondo e colori.
 *
 * Lo sfondo si toglie quando i quattro angoli sono opachi e dello stesso
 * colore (logo su tinta unita). Con un logo appoggiato su una foto non
 * funziona, e l'interfaccia lo dice. Il logo resta nel browser: non entra
 * nel link condiviso né in nessuna richiesta di rete.
 */

import {
  type Cluster,
  type Lab,
  createRng,
  deltaE,
  hashString,
  kmeansLab,
  srgb8ToLab,
  topClusters,
} from '@calicchia/shared/palette';

export interface LogoResult {
  /** PNG senza sfondo come data URL. */
  url: string;
  /** Fino a tre colori, già pesati per superficie. */
  colors: Cluster[];
  bgRemoved: boolean;
}

/** `empty`: tutto sfondo; `unreadable`: canvas fallito; `invalid`: non è un'immagine. */
export type LogoErrorCode = 'empty' | 'unreadable' | 'invalid';

export class LogoError extends Error {
  constructor(public readonly code: LogoErrorCode) {
    super(code);
  }
}

const MAX_SIDE = 480;
const MAX_SAMPLE = 20000;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new LogoError('invalid'));
    };
    img.src = url;
  });
}

export async function processLogo(file: File): Promise<LogoResult> {
  const img = await loadImage(file);
  try {
    // Gli SVG senza dimensioni intrinseche arrivano con 0×0.
    const iw = img.naturalWidth || 300;
    const ih = img.naturalHeight || 150;
    const r = Math.min(MAX_SIDE / iw, MAX_SIDE / ih, 4);
    const w = Math.max(1, Math.round(iw * r));
    const h = Math.max(1, Math.round(ih * r));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new LogoError('unreadable');
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const d = data.data;

    // Sfondo: i quattro angoli opachi e dello stesso colore.
    const corners = [0, w - 1, (h - 1) * w, h * w - 1].map((i) => i * 4).filter((i) => d[i + 3] > 200);
    let bg: Lab | null = null;
    if (corners.length === 4) {
      const labs = corners.map((i) => srgb8ToLab(d[i], d[i + 1], d[i + 2]));
      if (labs.every((l) => deltaE(l, labs[0]) < 0.04)) bg = labs[0];
    }

    const pts: Lab[] = [];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) {
        d[i + 3] = 0;
        continue;
      }
      const lab = srgb8ToLab(d[i], d[i + 1], d[i + 2]);
      if (bg) {
        const dist = deltaE(lab, bg);
        // Scontorno morbido: trasparente vicino allo sfondo, sfumato sui bordi antialias.
        if (dist < 0.12) d[i + 3] = Math.round(d[i + 3] * Math.max(0, (dist - 0.03) / 0.09));
        if (dist < 0.15) continue;
      }
      pts.push(lab);
    }
    ctx.putImageData(data, 0, 0);
    if (pts.length < 40) throw new LogoError('empty');

    const step = Math.max(1, Math.ceil(pts.length / MAX_SAMPLE));
    const sample = step > 1 ? pts.filter((_, i) => i % step === 0) : pts;
    const colors = topClusters(kmeansLab(sample, 4, createRng(hashString(file.name + file.size))), 0.08, 3);
    return { url: c.toDataURL('image/png'), colors, bgRemoved: !!bg };
  } catch (err) {
    if (err instanceof LogoError) throw err;
    throw new LogoError('unreadable');
  }
}
