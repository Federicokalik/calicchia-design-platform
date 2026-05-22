/**
 * Cron job: rinfresca tutte le ICS subscription abilitate.
 *
 * Frequenza: ogni 15 minuti. Le origini più comuni (Google Calendar) rigenerano
 * l'ICS pubblico ogni 4-12h, quindi un poll quartorario è abbondante e non spreca
 * fetch — l'ETag/If-Modified-Since assicurano che 304 non costino nulla lato DB.
 */

import { syncAllSubscriptions } from '../lib/calendar/subscriptions';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'ics-pull' });

export async function runIcsPull(): Promise<void> {
  const { total, ok, failed, notModified } = await syncAllSubscriptions();
  if (total > 0) {
    log.info(`synced ${ok}/${total} subscriptions (${notModified} unchanged, ${failed} failed)`);
  }
}
