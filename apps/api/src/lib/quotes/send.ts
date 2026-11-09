/**
 * Quote sending — shared by the immediate route (POST /api/quotes-v2/:id/send)
 * and the scheduled-send cron. Honest per-channel reporting: nothing is
 * marked "sent" unless at least one channel actually went out.
 *
 * The customer must be able to READ what they sign: before every send the PDF
 * is regenerated from the current content, attached to the email and exposed
 * on the sign page (GET /api/quote-sign/:token/document).
 */

import { sql } from '../../db';
import { sendEmail, type EmailAttachment } from '../email';
import { sendWhatsAppText, isWhatsAppConfigured } from '../whatsapp';
import { logger } from '../logger';
import { readPrivateFile } from '../private-files';
import { escapeHtml, quoteAmountSummary, quoteDisplayTitle, quoteSignUrl } from './format';
import { quotePdfName, renderAndStoreQuotePdf } from './pdf';

const log = logger.child({ scope: 'quote-send' });

/** Above this size the PDF is not attached (the sign page still shows it). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface QuoteSendResult {
  ok: boolean;
  sentVia: string[];
  failed: Record<string, string>;
  signUrl?: string;
  error?: string;
}

export async function sendQuote(quoteId: string, channels: string[]): Promise<QuoteSendResult> {
  const rows = await sql`
    SELECT q.*, c.contact_name, c.email AS customer_email, c.phone AS customer_phone, c.company_name
    FROM quotes_v2 q
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.id = ${quoteId}
  `;
  if (!rows.length) return { ok: false, sentVia: [], failed: {}, error: 'Preventivo non trovato' };

  const quote = rows[0];
  if (quote.status === 'signed') {
    return { ok: false, sentVia: [], failed: {}, error: 'Preventivo già firmato' };
  }

  const signUrl = quoteSignUrl(quote.signature_token);
  const sentVia: string[] = [];
  const failed: Record<string, string> = {};

  if (channels?.includes('email') && !quote.customer_email) {
    failed.email = 'Email cliente mancante in anagrafica';
  }
  if (channels?.includes('whatsapp') && !quote.customer_phone) {
    failed.whatsapp = 'Telefono cliente mancante in anagrafica';
  } else if (channels?.includes('whatsapp') && !isWhatsAppConfigured()) {
    failed.whatsapp = 'WhatsApp (GOWA) non configurato';
  }

  const willEmail = channels?.includes('email') && !!quote.customer_email;
  const willWhatsApp = channels?.includes('whatsapp') && !!quote.customer_phone && isWhatsAppConfigured();

  // Template quotes: the sign page's items table is only a summary — the
  // document is the PDF. Render it fresh from the current content; if that
  // fails, do NOT send a link to a page where the customer can't read the
  // document they would sign. Custom-HTML quotes already expose their document.
  let pdfAttachment: EmailAttachment | null = null;
  if ((willEmail || willWhatsApp) && !quote.custom_html_path) {
    try {
      const pdf = await renderAndStoreQuotePdf(quoteId);
      const name = quotePdfName(pdf.pdfPath);
      if (willEmail && name) {
        const buffer = await readPrivateFile('quotes', name);
        if (buffer.length <= MAX_ATTACHMENT_BYTES) {
          pdfAttachment = {
            filename: `${safeFilename(`Preventivo ${quoteDisplayTitle(quote.title)}`)}.pdf`,
            content: buffer,
            contentType: 'application/pdf',
          };
        } else {
          log.warn({ quoteId, bytes: buffer.length }, 'Quote PDF too large to attach — link only');
        }
      }
    } catch (err) {
      log.error({ err, quoteId }, 'Quote PDF generation failed before send');
      return {
        ok: false,
        sentVia,
        failed,
        signUrl,
        error: 'Generazione del PDF non riuscita: preventivo non inviato (il cliente non potrebbe leggere il documento da firmare)',
      };
    }
  }

  const displayTitle = quoteDisplayTitle(quote.title);
  const contactName = String(quote.contact_name || '').trim();
  const amount = quoteAmountSummary(quote);
  const validUntil = quote.valid_until ? new Date(quote.valid_until).toLocaleDateString('it-IT') : 'revoca';

  if (willEmail) {
    try {
      const attachedLine = pdfAttachment
        ? 'In allegato trovi il documento completo in PDF: è lo stesso che firmerai online.'
        : 'Al link trovi anche il documento completo da leggere prima della firma.';
      // sendEmail non lancia: restituisce { success: false } su errore o senza trasporto.
      const result = await sendEmail({
        to: quote.customer_email,
        subject: `Preventivo: ${displayTitle}`,
        html: `
          <p style="margin:0 0 16px;font-size:12px;color:#999;">Messaggio automatico inviato dal gestionale di Calicchia Design. Puoi rispondere direttamente a questa email per qualsiasi domanda.</p>
          <p>Ciao${contactName ? ' ' + escapeHtml(contactName) : ''},</p>
          <p>Ti invio il preventivo <strong>${escapeHtml(displayTitle)}</strong>.<br>Importo: <strong>${escapeHtml(amount)}</strong>.</p>
          <p>${attachedLine}</p>
          <p>Puoi visionarlo e firmarlo digitalmente al seguente link:</p>
          <p><a href="${signUrl}" style="display:inline-block;padding:12px 24px;background:#f97316;color:white;border-radius:8px;text-decoration:none;font-weight:bold;">Visualizza e Firma</a></p>
          <p>Il preventivo è valido fino al ${validUntil}.</p>
          <br>
          <p>Federico Calicchia<br>Web Designer</p>
        `,
        text: [
          'Messaggio automatico inviato dal gestionale di Calicchia Design.',
          '',
          `Ciao${contactName ? ' ' + contactName : ''},`,
          `ti invio il preventivo "${displayTitle}". Importo: ${amount}.`,
          attachedLine,
          `Puoi visionarlo e firmarlo qui: ${signUrl}`,
          `Il preventivo è valido fino al ${validUntil}.`,
          '',
          'Federico Calicchia',
        ].join('\n'),
        attachments: pdfAttachment ? [pdfAttachment] : undefined,
      });
      if (!result.success) throw new Error(result.error || 'Invio email fallito');
      sentVia.push('email');
    } catch (err) {
      log.error({ err }, 'Error sending quote email');
      failed.email = 'Invio email fallito';
    }
  }

  if (willWhatsApp) {
    try {
      const docLine = quote.custom_html_path || !willEmail
        ? 'Al link trovi il documento completo da leggere prima della firma.'
        : 'Al link trovi il documento completo; te l\'ho inviato anche in PDF via email.';
      const message = `_Messaggio automatico inviato dal gestionale di Calicchia Design — puoi rispondere direttamente qui._\n\nCiao${contactName ? ' ' + contactName : ''}! 👋\n\nTi invio il preventivo *${displayTitle}*.\nImporto: *${amount}*\n\n${docLine}\n\nPuoi visionarlo e firmarlo qui:\n${signUrl}\n\nPer qualsiasi domanda sono a disposizione!`;
      await sendWhatsAppText(quote.customer_phone, message);
      sentVia.push('whatsapp');
    } catch (err) {
      log.error({ err }, 'Error sending quote WhatsApp');
      failed.whatsapp = /400/.test(String((err as Error).message))
        ? 'WhatsApp ha rifiutato il numero (verifica che sia un numero WhatsApp valido)'
        : 'Invio WhatsApp fallito';
    }
  }

  if (!sentVia.length) {
    const reasons = Object.values(failed).join(' · ') || 'motivo sconosciuto';
    return { ok: false, sentVia, failed, signUrl, error: `Invio fallito: ${reasons}` };
  }

  await sql`
    UPDATE quotes_v2 SET
      status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
      sent_via = ${sentVia},
      sent_at = now(),
      scheduled_send_at = NULL,
      scheduled_send_channels = NULL,
      scheduled_send_attempts = 0,
      updated_at = now()
    WHERE id = ${quoteId}
  `;

  return { ok: true, sentVia, failed, signUrl };
}

/** Filename safe for mail clients: no path/reserved chars, bounded length. */
function safeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Preventivo';
}
