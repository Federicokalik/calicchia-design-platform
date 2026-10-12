import { type PalettePhoto, isHex } from '@calicchia/shared/palette';

/** Immagini solo dalla CDN di Unsplash, link solo verso unsplash.com (mai `javascript:` o altri host). */
function isUrlOf(value: unknown, host: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === host;
  } catch {
    return false;
  }
}

/**
 * Tiene solo le foto con la forma attesa (JSON pre-calcolati, risposta di
 * `/api/palette/search`): un cluster con hex non valido romperebbe la
 * conversione in OKLab. Niente DOM: la usano server e browser.
 */
export function sanitizePhotos(value: unknown): PalettePhoto[] {
  if (!Array.isArray(value)) return [];
  const out: PalettePhoto[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Partial<PalettePhoto>;
    if (
      typeof p.id !== 'string' ||
      !isUrlOf(p.small, 'images.unsplash.com') ||
      !isUrlOf(p.regular, 'images.unsplash.com') ||
      typeof p.author !== 'string' ||
      !isUrlOf(p.authorUrl, 'unsplash.com') ||
      !isUrlOf(p.photoUrl, 'unsplash.com') ||
      !Array.isArray(p.clusters)
    ) {
      continue;
    }
    const clusters = p.clusters.filter(
      (c): c is { hex: string; w: number } =>
        !!c && typeof c.hex === 'string' && isHex(c.hex) && typeof c.w === 'number' && Number.isFinite(c.w),
    );
    if (!clusters.length) continue;
    out.push({
      id: p.id,
      small: p.small,
      regular: p.regular,
      width: typeof p.width === 'number' ? p.width : 1080,
      height: typeof p.height === 'number' ? p.height : 720,
      blurHash: typeof p.blurHash === 'string' ? p.blurHash : null,
      color: typeof p.color === 'string' && isHex(p.color) ? p.color : null,
      alt: typeof p.alt === 'string' ? p.alt : null,
      author: p.author,
      authorUrl: p.authorUrl,
      photoUrl: p.photoUrl,
      clusters: clusters.map((c) => ({ hex: c.hex.toUpperCase(), w: c.w })),
    });
  }
  return out;
}
