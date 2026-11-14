/**
 * HTML → PDF A4 con Chrome headless (Puppeteer), condiviso da preventivi e
 * proforma. Il percorso dell'eseguibile si legge a ogni chiamata:
 * PUPPETEER_EXECUTABLE_PATH (container: /usr/bin/chromium-browser, vedi
 * apps/api/Dockerfile), CHROME_PATH su Windows, altrimenti il Chrome di
 * Puppeteer. I template impaginano pagine fisse 210×297 mm con header e
 * footer propri: niente margini né header/footer nativi.
 */
import puppeteer from 'puppeteer';

function executablePath(): string | undefined {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.platform === 'win32') {
    return process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  return undefined;
}

export async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: executablePath(),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
