/**
 * Cron job: rinfresca tutte le ICS subscription abilitate.
 *
 * Frequenza: ogni 15 minuti. Le origini più comuni (Google Calendar) rigenerano
 * l'ICS pubblico ogni 4-12h, quindi un poll quartorario è abbondante e non spreca
 * fetch — l'ETag/If-Modified-Since assicurano che 304 non costino nulla lato DB.
 *
 * Calendario su Radicale (design §6.6, §13.5, §13.8; contratto
 * docs/calendar-radicale/contracts/f3-modules.md §6.4 e §9.4):
 *  - con lo store postgres (mode postgres, anche con lo shadow acceso) il pull
 *    legacy resta la fonte del busy e dell'agenda; subito dopo, le iscrizioni
 *    con un sidecar (create dal wizard della F3 con i flag per singola
 *    iscrizione) si scaricano anche verso l'indice, che alimenta l'impatto
 *    mostrato nel wizard e lo specchio `sub-<id8>` delle iscrizioni visibili.
 *    Le righe ics_pull non passano mai dallo shadow mirror (le iscrizioni non
 *    si copiano). Sostituisce il cron calendar-subscriptions-index della F2;
 *  - con lo store Radicale la facade (syncAllSubscriptions → pull verso
 *    l'indice) fa già tutto: invariato.
 */

import { readStoreKind } from '../lib/calendar/backend-mode';
import { syncAllSubscriptions } from '../lib/calendar/subscriptions';
import { pullAllSubscriptionsToIndex } from '../lib/calendar/subscriptions/pull';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'ics-pull' });

export async function runIcsPull(): Promise<void> {
  const { total, ok, failed, notModified } = await syncAllSubscriptions();
  if (total > 0) {
    log.info(`synced ${ok}/${total} subscriptions (${notModified} unchanged, ${failed} failed)`);
  }

  // Store postgres: pull verso l'indice delle iscrizioni con sidecar (con lo store Radicale lo ha già fatto la facade).
  if ((await readStoreKind()) !== 'postgres') return;
  try {
    await pullAllSubscriptionsToIndex();
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'pull delle iscrizioni verso l\'indice non riuscito');
  }
}
