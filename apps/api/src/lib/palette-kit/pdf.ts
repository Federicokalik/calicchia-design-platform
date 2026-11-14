/**
 * Brand kit: HTML → PDF con Chromium (stesse opzioni di lancio di
 * quote-pdf.ts). Il PDF non viene salvato: va allegato all'email e basta.
 */

import puppeteer from 'puppeteer';
import { brandKitFontCss } from './fonts';
import { renderBrandKitHtml, type BrandKitInput } from './document';

export type BrandKitPdfInput = Omit<BrandKitInput, 'fontCss'>;

export async function renderBrandKitPdf(input: BrandKitPdfInput): Promise<Buffer> {
  const html = renderBrandKitHtml({ ...input, fontCss: brandKitFontCss(input.palette.preset) });
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ...(process.platform === 'win32'
      ? { executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
      : {}),
  });
  try {
    const page = await browser.newPage();
    // Niente rete: tutto (font compresi) è nell'HTML.
    await page.setRequestInterception(true);
    page.on('request', (req) => (req.url().startsWith('data:') ? req.continue() : req.abort()));
    await page.setContent(html, { waitUntil: 'load' });
    // Stringa: l'API compila senza i tipi DOM.
    await page.evaluate('document.fonts.ready.then(() => true)');
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
