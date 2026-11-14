/**
 * Quote PDF lifecycle — single place that renders a quote to PDF, stores it in
 * the private store and records pdf_path/hash on the row. Shared by:
 *   - POST /api/quotes-v2/:id/generate-pdf (admin "Genera PDF")
 *   - sendQuote() (lib/quotes/send.ts), which regenerates the PDF before every
 *     send so the customer always receives the current content
 *   - the public sign page (routes/quote-public.ts), which serves pdf_path as
 *     the document the customer reads before signing.
 */

import { sql } from '../../db';
import { generateQuotePdf } from '../quote-pdf';
import { renderQuoteHtml, injectSignatureIntoCustomHtml } from '../quote-renderer';
import { privateFileExists, readPrivateFile } from '../private-files';

export interface StoredQuotePdf {
  pdfPath: string;
  pdfUrl: string;
  pdfHash: string;
}

export class QuotePdfError extends Error {
  constructor(message: string, readonly status: 404 | 500 = 500) {
    super(message);
    this.name = 'QuotePdfError';
  }
}

/** Storage name ("<file>.pdf") from a stored "quotes/<file>.pdf" path. */
export function quotePdfName(pdfPath: unknown): string | null {
  if (typeof pdfPath !== 'string' || !pdfPath) return null;
  const name = pdfPath.split('/').pop() || '';
  return name.toLowerCase().endsWith('.pdf') ? name : null;
}

/** True when the row points at a PDF that actually exists in the private store. */
export function quotePdfAvailable(pdfPath: unknown): boolean {
  const name = quotePdfName(pdfPath);
  return !!name && privateFileExists('quotes', name);
}

/**
 * Render the quote (custom HTML document or the shared template), store the
 * PDF and update pdf_path/pdf_hash_sha256. Once signed the hash is never
 * overwritten: for a signed quote it is the evidentiary signature hash.
 */
export async function renderAndStoreQuotePdf(quoteId: string): Promise<StoredQuotePdf> {
  const rows = await sql`
    SELECT q.*, c.contact_name AS customer_name, c.company_name
    FROM quotes_v2 q
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.id = ${quoteId}
  `;
  if (!rows.length) throw new QuotePdfError('Non trovato', 404);
  const quote = rows[0];

  // Custom HTML quotes render the hand-crafted document as-is (signature
  // injected into its data-sign placeholders once signed); everything else
  // goes through the shared Swiss-editorial template.
  let html: string;
  if (quote.custom_html_path) {
    const name = String(quote.custom_html_path).split('/').pop() || '';
    try {
      html = (await readPrivateFile('quotes', name)).toString('utf-8');
    } catch {
      throw new QuotePdfError('Documento HTML non trovato nello storage', 404);
    }
    html = injectSignatureIntoCustomHtml(html, quote);
  } else {
    const settingsRows = await sql`SELECT value FROM site_settings WHERE key = 'quote.settings'`;
    const settings = settingsRows[0]?.value || {};
    html = renderQuoteHtml(quote as Parameters<typeof renderQuoteHtml>[0], settings);
  }

  const result = await generateQuotePdf(html, `Preventivo_${quote.title}`);

  await sql`
    UPDATE quotes_v2 SET
      pdf_path = ${result.pdfPath},
      pdf_hash_sha256 = CASE WHEN status = 'signed' THEN pdf_hash_sha256 ELSE ${result.pdfHash} END,
      updated_at = now()
    WHERE id = ${quoteId}
  `;

  return result;
}
