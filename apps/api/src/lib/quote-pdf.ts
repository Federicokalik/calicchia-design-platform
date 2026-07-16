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

    // The shared Swiss-editorial template renders fixed 210×297mm pages with
    // their own in-page header/footer chrome (incl. computed "Pag. X di Y"),
    // so Chrome must print edge-to-edge with no native header/footer.
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
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
