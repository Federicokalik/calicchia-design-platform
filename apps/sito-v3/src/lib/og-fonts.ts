import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let cachedFunnelDisplay: Buffer | null = null;

/**
 * Returns the Funnel Display TTF buffer for use in `next/og` ImageResponse.
 *
 * `@vercel/og` ships opentype.js which does NOT support WOFF2 (Brotli-compressed)
 * — it raises "Unsupported OpenType signature wOF2" and the ImageResponse stream
 * aborts with "failed to pipe response" (Bugsink 5 issues, ~10 events on
 * 2026-05-23..26, e.g. fda692e8 on /servizi/[slug]/opengraph-image-hty1fy).
 *
 * Asset: `public/fonts/funnel-display.ttf` (variable-axis wght, OFL, downloaded
 * from github.com/google/fonts/ofl/funneldisplay). Cached in-memory per process
 * to avoid repeated disk reads on hot OG routes hit by crawlers.
 *
 * Returns `null` if the file is unreadable — callers should omit `fonts:` so
 * ImageResponse falls back to the built-in Geist font rather than crashing.
 */
export async function getFunnelDisplay(): Promise<Buffer | null> {
  if (cachedFunnelDisplay) return cachedFunnelDisplay;
  try {
    const buf = await readFile(
      join(process.cwd(), 'public/fonts/funnel-display.ttf'),
    );
    cachedFunnelDisplay = buf;
    return buf;
  } catch {
    return null;
  }
}
