import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let cachedFunnelDisplay: ArrayBuffer | null = null;

/**
 * Returns the Funnel Display TTF buffer for use in `next/og` ImageResponse.
 *
 * `@vercel/og` ships opentype.js which does NOT support WOFF2 (Brotli-compressed)
 * — it raises "Unsupported OpenType signature wOF2" and the ImageResponse stream
 * aborts with "failed to pipe response" (Bugsink 5 issues, ~10 events on
 * 2026-05-23..26, e.g. fda692e8 on /servizi/[slug]/opengraph-image-hty1fy).
 *
 * Asset: `public/fonts/funnel-display-700.ttf` — a STATIC wght=700 instance of
 * the Funnel Display variable font, generated with fontTools.varLib.instancer
 * from `funnel-display.ttf`. Satori cannot parse the variable font (it has an
 * `fvar` table and crashes with "Cannot read properties of undefined (reading
 * '256')"); a static single-weight instance parses cleanly. Cached in-memory
 * per process to avoid repeated disk reads on hot OG routes hit by crawlers.
 *
 * Returns `null` if the file is unreadable — callers should omit `fonts:` so
 * ImageResponse falls back to the built-in font rather than crashing.
 *
 * IMPORTANT: we return a standalone `ArrayBuffer` copy, not the Node `Buffer`.
 * `readFile` hands back a Buffer that is a *view* into Node's shared buffer pool
 * (non-zero `byteOffset`); Satori reads the whole underlying `ArrayBuffer` and
 * ignores the offset, so passing the raw Buffer feeds it pooled garbage and the
 * font parser crashes ("Cannot read properties of undefined (reading '256')").
 * Slicing to an exact-length ArrayBuffer gives Satori a clean, owned buffer.
 */
export async function getFunnelDisplay(): Promise<ArrayBuffer | null> {
  if (cachedFunnelDisplay) return cachedFunnelDisplay;
  try {
    const buf = await readFile(
      join(process.cwd(), 'public/fonts/funnel-display-700.ttf'),
    );
    cachedFunnelDisplay = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
    return cachedFunnelDisplay;
  } catch {
    return null;
  }
}
