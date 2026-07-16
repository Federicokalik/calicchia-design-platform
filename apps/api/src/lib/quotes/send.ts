/**
 * Quote sending — shared by the immediate route (POST /api/quotes-v2/:id/send)
 * and the scheduled-send cron. Honest per-channel reporting: nothing is
 * marked "sent" unless at least one channel actually went out.
 */

import { sql } from '../../db';
import { sendEmail } from '../email';
import { sendWhatsAppText, isWhatsAppConfigured } from '../whatsapp';
import { logger } from '../logger';

const log = logger.child({ scope: 'quote-send' });

const QUOTE_PUBLIC_URL = process.env.QUOTE_PUBLIC_URL || 'http://localhost:5173/preventivo';

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

  const signUrl = `${QUOTE_PUBLIC_URL}/${quote.signature_token}`;
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

  if (channels?.includes('email') && quote.customer_email) {
    try {
      await sendEmail({
        to: quote.customer_email,
        subject: `Preventivo: ${quote.title}`,
        html: `
          <p>Ciao ${quote.contact_name || ''},</p>
          <p>Ti invio il preventivo <strong>${quote.title}</strong> per un totale di <strong>€${parseFloat(quote.total).toLocaleString('it-IT')}</strong>.</p>
          <p>Puoi visionarlo e firmarlo digitalmente al seguente link:</p>
          <p><a href="${signUrl}" style="display:inline-block;padding:12px 24px;background:#f97316;color:white;border-radius:8px;text-decoration:none;font-weight:bold;">Visualizza e Firma</a></p>
          <p>Il preventivo è valido fino al ${quote.valid_until ? new Date(quote.valid_until).toLocaleDateString('it-IT') : 'revoca'}.</p>
          <br>
          <p>Federico Calicchia<br>Web Designer</p>
          <p style="margin-top:16px;font-size:12px;color:#999;">Questo è un messaggio automatico inviato dal gestionale di Calicchia Design. Puoi rispondere direttamente a questa email per qualsiasi domanda.</p>
        `,
      });
      sentVia.push('email');
    } catch (err) {
      log.error({ err }, 'Error sending quote email');
      failed.email = 'Invio email fallito';
    }
  }

  if (channels?.includes('whatsapp') && quote.customer_phone && isWhatsAppConfigured()) {
    try {
      const message = `Ciao ${quote.contact_name || ''}! 👋\n\nTi invio il preventivo *${quote.title}* per un totale di *€${parseFloat(quote.total).toLocaleString('it-IT')}*.\n\nPuoi visionarlo e firmarlo qui:\n${signUrl}\n\nPer qualsiasi domanda sono a disposizione!\n\n_Messaggio automatico inviato dal gestionale di Calicchia Design — puoi rispondere direttamente qui._`;
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
