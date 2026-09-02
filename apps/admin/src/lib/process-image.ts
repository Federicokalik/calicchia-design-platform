/**
 * Client-side image normalization for portfolio media (cover, gallery,
 * before/after). Runs in the browser before the upload leaves the admin:
 *
 *   - decodes the file, caps the LONGEST edge at MAX_LONG_EDGE (never upscales)
 *   - re-encodes to WebP at WEBP_QUALITY (near-lossless; next/image re-optimizes
 *     again for delivery, so the stored file only needs to be a clean master)
 *   - returns the final pixel dimensions so callers can persist width/height
 *     (kills layout shift on the public case-study page)
 *   - flags images whose shortest edge is below MIN_SHORT_EDGE — a portfolio
 *     quality floor, surfaced as a toast, not a hard block
 *
 * Doing this client-side keeps the API image free of a native dependency
 * (sharp/libvips) and moves the CPU cost off the server. Non-raster inputs
 * (GIF, video, PDF) and any failure path return the original file untouched.
 */

const MAX_LONG_EDGE = 2560;
const MIN_SHORT_EDGE = 1200;
const WEBP_QUALITY = 0.92;

// GIF is excluded on purpose: canvas re-encoding would drop the animation.
const PROCESSABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface ProcessedImage {
  /** WebP File when processed, otherwise the original File. */
  file: File;
  width?: number;
  height?: number;
  /** Non-fatal quality note (short edge below MIN_SHORT_EDGE). */
  warning?: string;
}

function canvasToWebp(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/webp', WEBP_QUALITY);
  });
}

export async function processPortfolioImage(input: File): Promise<ProcessedImage> {
  if (!PROCESSABLE.has(input.type)) return { file: input };

  try {
    const bitmap = await createImageBitmap(input);
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    if (!srcW || !srcH) {
      bitmap.close();
      return { file: input };
    }

    const longEdge = Math.max(srcW, srcH);
    const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
    const outW = Math.round(srcW * scale);
    const outH = Math.round(srcH * scale);

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { file: input };
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    bitmap.close();

    const blob = await canvasToWebp(canvas);
    if (!blob || blob.type !== 'image/webp') return { file: input };

    const name = input.name.replace(/\.[^./]+$/, '') + '.webp';
    const file = new File([blob], name, { type: 'image/webp', lastModified: Date.now() });

    const shortEdge = Math.min(outW, outH);
    const warning =
      shortEdge < MIN_SHORT_EDGE
        ? `${input.name}: ${outW}×${outH}px — il lato corto (${shortEdge}px) è sotto i ${MIN_SHORT_EDGE}px consigliati per il portfolio.`
        : undefined;

    return { file, width: outW, height: outH, warning };
  } catch {
    // Corrupt file, unsupported decode, OOM on a huge canvas — upload as-is.
    return { file: input };
  }
}
