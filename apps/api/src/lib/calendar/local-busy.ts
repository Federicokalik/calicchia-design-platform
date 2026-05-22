/**
 * Sostituisce `google-busy.ts` (rimosso): legge busy times dagli eventi interni
 * (tutti i calendari, non solo Lavoro) per il calcolo slot disponibili.
 *
 * Restituisce stessa shape di `BusyRange` per compatibilità con slots.ts.
 */

import { getBusyRanges } from './events';
import { logger } from '../logger';

const log = logger.child({ scope: 'calendar-local-busy' });

export interface BusyRange {
  start: string;
  end: string;
}

export async function getLocalBusyRanges(timeMinIso: string, timeMaxIso: string): Promise<BusyRange[]> {
  try {
    return await getBusyRanges(timeMinIso, timeMaxIso);
  } catch (err) {
    log.error({ err }, 'Errore caricamento eventi');
    return [];
  }
}
