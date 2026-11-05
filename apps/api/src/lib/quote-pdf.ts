/**
 * PDF dei preventivi: HTML → PDF (lib/pdf/render.ts) nello storage privato.
 */

import crypto from 'crypto';
import { savePrivateFile, signFileUrl } from './private-files';
import { htmlToPdf } from './pdf/render';

/**
 * Generate PDF from HTML string
 * Returns: { pdfPath, pdfUrl, pdfHash }
 */
export async function generateQuotePdf(
  html: string,
  filename: string
): Promise<{ pdfPath: string; pdfUrl: string; pdfHash: string }> {
  const buffer = await htmlToPdf(html);

  // Save to the private store (SEC-10) — never the public /media/* path.
  const safeName = filename.replace(/[^a-zA-Z0-9_-]/g, '_');
  const pdfFilename = `${safeName}_${Date.now()}.pdf`;
  await savePrivateFile('quotes', pdfFilename, buffer);

  // Hash for audit trail
  const pdfHash = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    pdfPath: `quotes/${pdfFilename}`,
    pdfUrl: signFileUrl('quotes', pdfFilename),
    pdfHash,
  };
}
