// Generate favicon variants from the brand circular logo.
// Sources: apps/sito-v3/public/img/calicchia-design-logo.webp (1000x1000 WebP, alpha)
// Outputs: PNG variants + multi-resolution .ico, written to apps/sito-v3/public/
// and apps/admin/public/.
//
// Run with:  node scripts/generate-favicons.mjs
// Requires `sharp` resolvable from the repo root (installed as a transitive
// dependency via Next.js or installed explicitly via `pnpm add -w sharp`).

import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_LOGO = join(ROOT, 'apps/sito-v3/public/img/calicchia-design-logo.webp');

const OUT_DIRS = [
  join(ROOT, 'apps/sito-v3/public'),
  join(ROOT, 'apps/admin/public'),
];

// PNG variants we want browsers and PWAs to find.
const PNG_VARIANTS = [
  { name: 'favicon-16.png',         size: 16 },
  { name: 'favicon-32.png',         size: 32 },
  { name: 'favicon-96.png',         size: 96 },
  { name: 'apple-touch-icon.png',   size: 180 },
  { name: 'icon-192.png',           size: 192 },
  { name: 'icon-512.png',           size: 512 },
];

// Sizes embedded in the multi-resolution .ico.
const ICO_SIZES = [16, 32, 48];

// Build a Windows-style .ico file containing multiple PNG-encoded images.
// Modern browsers (and IE 11+) read PNG-embedded ICO entries fine.
function buildIco(images) {
  const HEADER = 6;
  const ENTRY  = 16;
  const total  = HEADER + ENTRY * images.length + images.reduce((s, im) => s + im.length, 0);
  const buf    = Buffer.alloc(total);

  // ICONDIR
  buf.writeUInt16LE(0, 0);                 // reserved
  buf.writeUInt16LE(1, 2);                 // type 1 = .ICO
  buf.writeUInt16LE(images.length, 4);     // image count

  let dataOffset = HEADER + ENTRY * images.length;
  for (let i = 0; i < images.length; i++) {
    const im = images[i];
    const dirOff = HEADER + i * ENTRY;
    buf.writeUInt8(im.size === 256 ? 0 : im.size, dirOff + 0);  // width
    buf.writeUInt8(im.size === 256 ? 0 : im.size, dirOff + 1);  // height
    buf.writeUInt8(0,           dirOff + 2);    // color palette
    buf.writeUInt8(0,           dirOff + 3);    // reserved
    buf.writeUInt16LE(1,        dirOff + 4);    // color planes
    buf.writeUInt16LE(32,       dirOff + 6);    // bits per pixel
    buf.writeUInt32LE(im.length, dirOff + 8);   // bytes
    buf.writeUInt32LE(dataOffset, dirOff + 12); // offset

    im.copy(buf, dataOffset);
    dataOffset += im.length;
  }

  return buf;
}

async function main() {
  console.log(`Source: ${SRC_LOGO}`);

  // Generate PNG variants once, then write to every destination.
  const pngs = {};
  for (const v of PNG_VARIANTS) {
    pngs[v.name] = await sharp(SRC_LOGO)
      .resize(v.size, v.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  // Build the .ico from the small sizes (Sharp re-encodes for crisper small renders).
  const icoSizes = await Promise.all(
    ICO_SIZES.map(async (s) => {
      const b = await sharp(SRC_LOGO)
        .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer();
      return Object.assign(b, { size: s });
    })
  );
  const icoBuffer = buildIco(icoSizes);

  for (const dir of OUT_DIRS) {
    mkdirSync(dir, { recursive: true });
    for (const [name, buf] of Object.entries(pngs)) {
      const out = join(dir, name);
      writeFileSync(out, buf);
      console.log(`  ✓ ${out} (${buf.length} bytes)`);
    }
    const icoPath = join(dir, 'favicon.ico');
    writeFileSync(icoPath, icoBuffer);
    console.log(`  ✓ ${icoPath} (${icoBuffer.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
