/**
 * Cron — watchdog della sessione WhatsApp (GOWA).
 *
 * GOWA gira su un host separato: quando va giù lo si scopriva solo al primo
 * invio fallito (es. invio preventivi). Questo job controlla la sessione a
 * intervalli brevi e notifica su Telegram le TRANSIZIONI di stato (down ↔ up),
 * mai lo stato stazionario — niente spam.
 *
 * Anti-flap: servono 2 check falliti consecutivi prima dell'alert "down"
 * (un blip di rete non deve svegliare nessuno).
 */

import { isWhatsAppConfigured, getWhatsAppStatus } from '../lib/whatsapp';
import { notifyTelegram } from '../lib/telegram';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'whatsapp-watchdog' });

const FAILURES_BEFORE_ALERT = 2;

// null = primo giro dopo il boot: registra lo stato senza notificare.
let lastKnownUp: boolean | null = null;
let consecutiveFailures = 0;

export async function runWhatsAppWatchdog(): Promise<void> {
  if (!isWhatsAppConfigured()) return;

  let up = false;
  let detail = '';
  try {
    const status = await getWhatsAppStatus();
    up = Boolean(status.connected);
    if (!up) detail = 'sessione non collegata (dispositivo assente)';
  } catch (err) {
    up = false;
    detail = `endpoint non raggiungibile: ${(err as Error).message?.slice(0, 120)}`;
  }

  if (up) {
    consecutiveFailures = 0;
    if (lastKnownUp === false) {
      log.info('GOWA back up');
      notifyTelegram('🟢 WhatsApp (GOWA) di nuovo operativo', 'La sessione è tornata connessa. Gli invii riprendono a funzionare.')
        .catch((err) => log.error({ err }, 'telegram notify failed'));
    }
    lastKnownUp = true;
    return;
  }

  consecutiveFailures++;
  log.warn({ consecutiveFailures, detail }, 'GOWA check failed');

  if (consecutiveFailures === FAILURES_BEFORE_ALERT && lastKnownUp !== false) {
    notifyTelegram('🔴 WhatsApp (GOWA) DOWN', `${detail || 'sessione non disponibile'}\nGli invii WhatsApp (preventivi, chat, marketing) falliranno finché non torna su.`)
      .catch((err) => log.error({ err }, 'telegram notify failed'));
    lastKnownUp = false;
  }
}
