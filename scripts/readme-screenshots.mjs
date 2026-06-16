#!/usr/bin/env node
/**
 * Genera gli screenshot del README in docs/screenshots/.
 * Tutte e sole superfici pubbliche o pagine di login (no PII).
 *
 *   node scripts/readme-screenshots.mjs                       # dev locale (default)
 *   SITE_BASE=https://calicchia.design \
 *   ADMIN_BASE=https://admin.calicchia.design \
 *     node scripts/readme-screenshots.mjs                     # live di produzione
 *
 * Prerequisiti (modalità locale): sito-v3 su :3000 e admin su :5173 attivi (dev.bat).
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from '../node_modules/.pnpm/puppeteer@24.42.0_typescript@5.7.3/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };

const SITE_BASE = (process.env.SITE_BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_BASE = (process.env.ADMIN_BASE ?? 'http://localhost:5173').replace(/\/$/, '');

const shots = [
  { name: 'sito-home.png', url: `${SITE_BASE}/`, wait: 2000 },
  { name: 'sito-home-en.png', url: `${SITE_BASE}/en`, wait: 2000 },
  { name: 'sito-lavori.png', url: `${SITE_BASE}/lavori`, wait: 2500 },
  { name: 'sito-servizi.png', url: `${SITE_BASE}/servizi`, wait: 2000 },
  { name: 'sito-contatti.png', url: `${SITE_BASE}/contatti`, wait: 1500 },
  { name: 'portal-login.png', url: `${SITE_BASE}/clienti`, wait: 1500 },
  { name: 'admin-login.png', url: `${ADMIN_BASE}/`, wait: 1500 },
];

// Pre-set a reject-all consent record so the cookie banner never overlays the
// shot (and no analytics fires). Mirrors apps/sito-v3/src/lib/cookie-consent.ts.
const CONSENT_VERSION = '2026-03-19';
const consentCookieValue = encodeURIComponent(
  JSON.stringify({
    preferences: { necessary: true, analytics: false, marketing: false },
    timestamp: Date.now(),
    version: CONSENT_VERSION,
  }),
);

const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: VIEWPORT,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  for (const shot of shots) {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    process.stdout.write(`→ ${shot.url} ... `);
    try {
      if (shot.url.startsWith(SITE_BASE)) {
        await page.setCookie({ name: 'cookie_consent', value: consentCookieValue, url: shot.url });
      }
      await page.goto(shot.url, { waitUntil: 'networkidle2', timeout: 30_000 });
      if (shot.wait) await new Promise((r) => setTimeout(r, shot.wait));
      const out = resolve(outDir, shot.name);
      await page.screenshot({ path: out, fullPage: false, type: 'png' });
      console.log(`saved ${shot.name}`);
    } catch (err) {
      console.log(`SKIP (${err.message})`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log(`\nDone. Output: ${outDir}`);
