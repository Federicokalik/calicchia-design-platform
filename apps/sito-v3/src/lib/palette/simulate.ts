/**
 * Solo browser (canvas). Foto simulate del tool "Palette di settore" e
 * lettura dei colori dalle immagini caricate dall'utente.
 *
 * Le foto simulate sono il ripiego quando un settore non ha foto Unsplash
 * (testo libero senza risposta dall'API, dati di settore mancanti): fasce e
 * macchie sfumate dei colori di un "mood". Le foto Unsplash invece non
 * passano mai di qui: i loro colori arrivano già estratti nei dati.
 */

import {
  type Cluster,
  type Rand,
  createRng,
  extractFromPixels,
  hashString,
  hexToLab,
  labToLch,
  oklch,
  rgba,
  shuffle,
} from '@calicchia/shared/palette';

/** Dimensione della miniatura da cui si estraggono i colori. */
const EXTRACT_W = 64;
const EXTRACT_H = 48;

const SIM_W = 320;
const SIM_H = 240;
const USER_W = 480;
const USER_H = 360;

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D non disponibile');
  return ctx;
}

/** Riduce un'immagine a 64×48 e ne estrae i colori dominanti (k-means in OKLab). */
export function extractFromImage(source: CanvasImageSource, rand: Rand): Cluster[] {
  const c = document.createElement('canvas');
  c.width = EXTRACT_W;
  c.height = EXTRACT_H;
  const ctx = context2d(c);
  ctx.drawImage(source, 0, 0, EXTRACT_W, EXTRACT_H);
  return extractFromPixels(ctx.getImageData(0, 0, EXTRACT_W, EXTRACT_H).data, rand);
}

/** Disegna una "foto" astratta con i colori del mood (porting di drawPhoto del prototipo). */
function drawPhoto(canvas: HTMLCanvasElement, mood: readonly string[], rand: Rand): void {
  const ctx = context2d(canvas);
  const W = canvas.width;
  const H = canvas.height;
  const cols = shuffle(mood, rand)
    .slice(0, 4)
    .map((hex) => {
      const [L, C, h] = labToLch(hexToLab(hex));
      return oklch(L + (rand() - 0.5) * 0.1, C * (0.8 + rand() * 0.35), h + (rand() - 0.5) * 16);
    });
  const ang = rand() * Math.PI * 2;
  const dx = Math.cos(ang) * W * 0.6;
  const dy = Math.sin(ang) * H * 0.6;
  ctx.fillStyle = cols[0];
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy);
  g.addColorStop(0, rgba(cols[1], 0));
  g.addColorStop(0.6, rgba(cols[1], 0.85));
  g.addColorStop(1, rgba(cols[1], 1));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const blobs = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < blobs; i++) {
    const c = cols[1 + Math.floor(rand() * 3)];
    const x = rand() * W;
    const y = rand() * H;
    const r = W * (0.15 + rand() * 0.4);
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, rgba(c, 1));
    rg.addColorStop(0.6, rgba(c, 0.95));
    rg.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }
  if (rand() < 0.5) {
    const y = H * (0.55 + rand() * 0.3);
    const band = ctx.createLinearGradient(0, y - H * 0.1, 0, H);
    band.addColorStop(0, rgba(cols[3], 0));
    band.addColorStop(0.3, rgba(cols[3], 0.85));
    band.addColorStop(1, rgba(cols[3], 0.95));
    ctx.fillStyle = band;
    ctx.fillRect(0, y - H * 0.1, W, H);
  }
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  // Grana leggera, come una foto vera.
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 14;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

export interface LocalPhoto {
  /** Immagine come data URL: resta nel browser. */
  dataUrl: string;
  clusters: Cluster[];
}

/** Sei foto simulate dal mood: stesso seed, stesse foto e stessi colori. */
export function simulatePhotos(mood: readonly string[], seed: number, count = 6): LocalPhoto[] {
  const rand = createRng(seed);
  const out: LocalPhoto[] = [];
  for (let i = 0; i < count; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = SIM_W;
    canvas.height = SIM_H;
    drawPhoto(canvas, mood, rand);
    const clusters = extractFromImage(canvas, rand);
    out.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.86), clusters });
  }
  return out;
}

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
      reject(new Error('Immagine non valida'));
    };
    img.src = url;
  });
}

/**
 * Foto caricata dall'utente: ritaglio 4:3 per l'anteprima e colori estratti
 * dalla miniatura 64×48. Il file non lascia mai il browser.
 */
export async function readUserPhoto(file: File): Promise<LocalPhoto> {
  const img = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = USER_W;
  canvas.height = USER_H;
  const ctx = context2d(canvas);
  const r = Math.max(USER_W / img.naturalWidth, USER_H / img.naturalHeight);
  const w = img.naturalWidth * r;
  const h = img.naturalHeight * r;
  ctx.drawImage(img, (USER_W - w) / 2, (USER_H - h) / 2, w, h);
  const clusters = extractFromImage(canvas, createRng(hashString(file.name + file.size)));
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.86), clusters };
}
