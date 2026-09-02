/**
 * Client-side guard for portfolio media (cover, gallery, before/after).
 *
 * Philosophy: the stored file is the MASTER. next/image re-encodes it to
 * AVIF/WebP at display size for delivery anyway, so the admin must not
 * degrade it. A pristine PNG screenshot — crisp text, a soft alpha shadow —
 * is uploaded byte-for-byte untouched.
 *
 * The only transform is a safety downscale when the longest edge exceeds
 * MAX_LONG_EDGE, and even then the source format is preserved (PNG stays
 * lossless PNG with its transparency; JPEG re-encodes at 0.95). Everything
 * else — dimensions for width/height hints, the sub-1200px quality warning —
 * is read-only.
 *
 * Non-decodable inputs (GIF, video, PDF) and any failure path return the
 * original file.
 */

const MAX_LONG_EDGE = 2560;
const MIN_SHORT_EDGE = 1200;

const DECODABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

export interface ProcessedImage {
  /** Original File unless a downscale was required. */
  file: File;
  width?: number;
  height?: number;
  /** Non-fatal quality note (short edge below MIN_SHORT_EDGE). */
  warning?: string;
}

function warnIfSmall(name: string, w: number, h: number): string | undefined {
  const shortEdge = Math.min(w, h);
  if (!shortEdge || shortEdge >= MIN_SHORT_EDGE) return undefined;
  return `${name}: ${w}×${h}px — il lato corto (${shortEdge}px) è sotto i ${MIN_SHORT_EDGE}px consigliati per il portfolio.`;
}

export async function processPortfolioImage(input: File): Promise<ProcessedImage> {
  if (!DECODABLE.has(input.type)) return { file: input };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(input);
  } catch {
    return { file: input };
  }

  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const longEdge = Math.max(srcW, srcH);

  // Within the cap → upload the original bytes, untouched. No canvas, no
  // re-encode: the master stays exactly as exported.
  if (!longEdge || longEdge <= MAX_LONG_EDGE) {
    bitmap.close();
    return {
      file: input,
      width: srcW || undefined,
      height: srcH || undefined,
      warning: srcW && srcH ? warnIfSmall(input.name, srcW, srcH) : undefined,
    };
  }

  // Oversized → downscale, keeping the source format (PNG lossless + alpha,
  // JPEG at 0.95). WebP/AVIF sources fall back to PNG to stay lossless.
  try {
    const scale = MAX_LONG_EDGE / longEdge;
    const outW = Math.round(srcW * scale);
    const outH = Math.round(srcH * scale);

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { file: input, width: srcW, height: srcH, warning: warnIfSmall(input.name, srcW, srcH) };
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    bitmap.close();

    const outType = input.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const quality = outType === 'image/jpeg' ? 0.95 : undefined;
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), outType, quality);
    });
    if (!blob) {
      return { file: input, width: srcW, height: srcH, warning: warnIfSmall(input.name, srcW, srcH) };
    }

    const ext = outType === 'image/jpeg' ? '.jpg' : '.png';
    const name = input.name.replace(/\.[^./]+$/, '') + ext;
    const file = new File([blob], name, { type: outType, lastModified: Date.now() });
    return { file, width: outW, height: outH, warning: warnIfSmall(input.name, outW, outH) };
  } catch {
    return { file: input, width: srcW, height: srcH, warning: warnIfSmall(input.name, srcW, srcH) };
  }
}
