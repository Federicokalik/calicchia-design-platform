/**
 * Cattura screenshot live di pooltechpiscine.it per il case study
 * /lavori/pooltechpiscine-restyling.
 *
 * Uso: cd apps/api && node scripts/capture-pooltech.mjs
 *
 * Output (in apps/sito-v3/public/img/works/pooltech-2026/):
 *   - hero-desktop.webp        — viewport 1920x1080 above-the-fold
 *   - hero-mobile.webp         — viewport 390x844 above-the-fold
 *   - fullpage-desktop.webp    — full page desktop (height auto)
 *   - section-{1..N}.webp      — singole sezioni a salti di 1100px
 */
import puppeteer from 'puppeteer';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Asset live nel filesystem servito da apps/api su /media/. Coerente con
// architettura storage: /media/<key> -> apps/api/uploads/<key>. URL pubblica
// risultante: http://localhost:3001/media/works/pooltech-2026/hero-desktop.webp
const OUT_DIR = resolve(__dirname, '../uploads/works/pooltech-2026');
const TARGET_URL = 'https://pooltechpiscine.it/';

async function dismissCookies(page) {
  try {
    // Avada / common cookie banners — best-effort dismiss
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, a')];
      const target = buttons.find((b) =>
        /^(rifiuta|reject|ok|accetta|accept|chiudi|close)$/i.test(
          (b.textContent ?? '').trim(),
        ),
      );
      if (target) target.click();
    });
    await new Promise((r) => setTimeout(r, 600));
  } catch {
    /* noop */
  }
}

async function capture() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    // 1) Hero desktop (1920x1080) above-the-fold
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
      await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await dismissCookies(page);
      await new Promise((r) => setTimeout(r, 800));
      const heroDesktop = join(OUT_DIR, 'hero-desktop.webp');
      await page.screenshot({
        path: heroDesktop,
        type: 'webp',
        quality: 90,
        clip: { x: 0, y: 0, width: 1920, height: 1080 },
      });
      console.log(`✓ ${heroDesktop}`);
      await page.close();
    }

    // 2) Hero mobile (iPhone-ish 390x844) above-the-fold
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
      await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await dismissCookies(page);
      await new Promise((r) => setTimeout(r, 800));
      const heroMobile = join(OUT_DIR, 'hero-mobile.webp');
      await page.screenshot({
        path: heroMobile,
        type: 'webp',
        quality: 90,
        clip: { x: 0, y: 0, width: 390, height: 844 },
      });
      console.log(`✓ ${heroMobile}`);
      await page.close();
    }

    // 3) Fullpage desktop screenshot (zoom-out per panoramica)
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
      await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await dismissCookies(page);
      // Trigger lazy-load images by scrolling through
      const totalH = await page.evaluate(() => document.body.scrollHeight);
      for (let y = 0; y < totalH; y += 800) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await new Promise((r) => setTimeout(r, 250));
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 600));
      const fullpage = join(OUT_DIR, 'fullpage-desktop.webp');
      await page.screenshot({
        path: fullpage,
        type: 'webp',
        quality: 80,
        fullPage: true,
      });
      console.log(`✓ ${fullpage}`);

      // Section snapshots (1100px steps)
      const step = 1100;
      const sections = Math.min(8, Math.ceil(totalH / step));
      for (let i = 0; i < sections; i++) {
        const y = i * step;
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await new Promise((r) => setTimeout(r, 350));
        const sectionPath = join(
          OUT_DIR,
          `section-${String(i + 1).padStart(2, '0')}.webp`,
        );
        await page.screenshot({
          path: sectionPath,
          type: 'webp',
          quality: 88,
          clip: { x: 0, y: 0, width: 1440, height: 900 },
        });
        console.log(`✓ ${sectionPath}`);
      }
      await page.close();
    }

    console.log('\nDone. Asset in:');
    console.log(`  ${OUT_DIR}`);
  } finally {
    await browser.close();
  }
}

capture().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
