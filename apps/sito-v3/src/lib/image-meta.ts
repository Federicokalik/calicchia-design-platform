/**
 * Intrinsic pixel dimensions of an image URL, read from the file header only —
 * no full decode, no sharp dependency.
 *
 * Why: blog covers are uploaded as MASTER (admin process-image keeps the file
 * byte-for-byte up to 2560px) but the public API exposes just the URL, no
 * dimensions. The case-study components get explicit width/height from the DB;
 * here we derive the same hint from the file itself so a cover keeps its
 * NATURAL aspect ratio (no forced 16:9 crop) and the Next optimizer can be
 * asked for the native width — with `withoutEnlargement` the served image keeps
 * the source pixels, so up to 2500px nothing is downscaled during the
 * WebP/AVIF conversion.
 *
 * Supported: PNG, JPEG, WebP (VP8 / VP8L / VP8X), GIF. AVIF header parsing is
 * omitted (rare as a blog cover); unknown formats return null and callers fall
 * back to a fixed frame.
 *
 * Results are cached in-process (module map) so the header fetch happens once
 * per cover, not on every render.
 */

const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_HEADER_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 8000;

const sizeCache = new Map<string, { w: number; h: number; ts: number }>();

function pngSize(buf: Buffer): [number, number] | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function gifSize(buf: Buffer): [number, number] | null {
  if (buf.length < 10) return null;
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
}

function webpSize(buf: Buffer): [number, number] | null {
  if (buf.length < 30) return null;
  if (
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  }
  if (chunk === 'VP8 ') {
    return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  return null;
}

function jpegSize(buf: Buffer): [number, number] | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    // SOF0–SOF15 (esclusi DHT/JPG/DAC) portano altezza+larghezza.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function parseHeader(buf: Buffer): [number, number] | null {
  return pngSize(buf) ?? webpSize(buf) ?? gifSize(buf) ?? jpegSize(buf) ?? null;
}

/** Download fino all'header che porta le dimensioni, poi interrompe. */
async function readHeaderBytes(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok || !res.body) return null;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        const buf = Buffer.concat(chunks, total);
        if (parseHeader(buf)) {
          await reader.cancel();
          break;
        }
        if (total >= MAX_HEADER_BYTES) break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function getImageSize(
  url: string | null | undefined,
): Promise<{ width: number; height: number } | null> {
  if (!url) return null;

  const hit = sizeCache.get(url);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return { width: hit.w, height: hit.h };
  }

  try {
    const buf = await readHeaderBytes(url);
    if (!buf) return null;
    const size = parseHeader(buf);
    if (!size) return null;
    sizeCache.set(url, { w: size[0], h: size[1], ts: Date.now() });
    return { width: size[0], height: size[1] };
  } catch {
    return null;
  }
}