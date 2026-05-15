/**
 * Cron job: rinfresca tutte le ICS subscription abilitate.
 *
 * Frequenza: ogni 15 minuti. Le origini più comuni (Google Calendar) rigenerano
 * l'ICS pubblico ogni 4-12h, quindi un poll quartorario è abbondante e non spreca
 * fetch — l'ETag/If-Modified-Since assicurano che 304 non costino nulla lato DB.
 */

import { syncAllSubscriptions } from '../lib/calendar/subscriptions';

export async function runIcsPull(): Promise<void> {
  const { total, ok, failed, notModified } = await syncAllSubscriptions();
  if (total > 0) {
    console.log(`[ics-pull] synced ${ok}/${total} subscriptions (${notModified} unchanged, ${failed} failed)`);
  }
}
