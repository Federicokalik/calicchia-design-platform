/**
 * PDF Generation for Quotes using Puppeteer
 * Renders HTML template → PDF via headless Chrome
 */

import puppeteer from 'puppeteer';
import crypto from 'crypto';
import { savePrivateFile, signFileUrl } from './private-files';

/**
 * Generate PDF from HTML string
 * Returns: { pdfPath, pdfUrl, pdfHash }
 */
export async function generateQuotePdf(
  html: string,
  filename: string
): Promise<{ pdfPath: string; pdfUrl: string; pdfHash: string }> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    // Use system Chrome if Puppeteer's bundled Chromium is not available
    ...(process.platform === 'win32' ? {
      executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    } : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '18mm', right: '18mm', bottom: '24mm', left: '18mm' },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div style="font-size:7.5pt;color:#999;width:100%;text-align:center;padding:0 18mm;">Calicchia Design di Federico Calicchia · P.IVA 03160480608</div>',
      footerTemplate: '<div style="font-size:7.5pt;color:#999;width:100%;display:flex;justify-content:space-between;padding:0 18mm;"><span></span><span>Pag. <span class="pageNumber"></span> di <span class="totalPages"></span></span></div>',
    });

    // Save to the private store (SEC-10) — never the public /media/* path.
    const safeName = filename.replace(/[^a-zA-Z0-9_-]/g, '_');
    const pdfFilename = `${safeName}_${Date.now()}.pdf`;
    const buffer = Buffer.from(pdfBuffer);
    await savePrivateFile('quotes', pdfFilename, buffer);

    // Hash for audit trail
    const pdfHash = crypto.createHash('sha256').update(buffer).digest('hex');

    return {
      pdfPath: `quotes/${pdfFilename}`,
      pdfUrl: signFileUrl('quotes', pdfFilename),
      pdfHash,
    };
  } finally {
    await browser.close();
  }
}
