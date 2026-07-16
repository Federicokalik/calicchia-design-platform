/**
 * Cron — invii programmati dei preventivi.
 *
 * L'admin imposta scheduled_send_at + canali dal dialog di invio; questo job
 * (ogni minuto) esegue gli invii scaduti tramite la stessa sendQuote() della
 * route immediata. Retry: fino a 3 tentativi (uno per tick); al terzo
 * fallimento la programmazione viene azzerata e parte un alert Telegram —
 * mai invii fantasma che restano in coda per sempre.
 */

import { sql } from '../db';
import { sendQuote } from '../lib/quotes/send';
import { notifyTelegram } from '../lib/telegram';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'quote-scheduled-send' });

const MAX_ATTEMPTS = 3;
const BATCH = 10;

export async function runQuoteScheduledSend(): Promise<void> {
  const due = await sql`
    SELECT id, title, scheduled_send_channels, scheduled_send_attempts
    FROM quotes_v2
    WHERE scheduled_send_at IS NOT NULL
      AND scheduled_send_at <= now()
      AND status <> 'signed'
    ORDER BY scheduled_send_at ASC
    LIMIT ${BATCH}
  `;

  for (const quote of due) {
    const channels = Array.isArray(quote.scheduled_send_channels) ? quote.scheduled_send_channels : [];
    try {
      const result = await sendQuote(quote.id, channels);
      if (result.ok) {
        // sendQuote clears the schedule columns on success.
        log.info({ quoteId: quote.id, sentVia: result.sentVia }, 'scheduled quote sent');
        notifyTelegram('📤 Preventivo inviato (programmato)', `"${quote.title}" inviato via ${result.sentVia.join(' + ')}.`)
          .catch((err) => log.error({ err }, 'telegram notify failed'));
        continue;
      }
      throw new Error(result.error || 'invio fallito');
    } catch (err) {
      const attempts = Number(quote.scheduled_send_attempts || 0) + 1;
      log.error({ quoteId: quote.id, attempts, err }, 'scheduled quote send failed');
      if (attempts >= MAX_ATTEMPTS) {
        await sql`
          UPDATE quotes_v2 SET
            scheduled_send_at = NULL,
            scheduled_send_channels = NULL,
            scheduled_send_attempts = ${attempts},
            updated_at = now()
          WHERE id = ${quote.id}
        `;
        notifyTelegram('⚠️ Invio programmato FALLITO', `Preventivo "${quote.title}": ${(err as Error).message?.slice(0, 200)}\nProgrammazione annullata dopo ${attempts} tentativi — invialo manualmente.`)
          .catch((e) => log.error({ err: e }, 'telegram notify failed'));
      } else {
        await sql`
          UPDATE quotes_v2 SET scheduled_send_attempts = ${attempts}, updated_at = now()
          WHERE id = ${quote.id}
        `;
      }
    }
  }
}
