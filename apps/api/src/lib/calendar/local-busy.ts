/**
 * Sostituisce `google-busy.ts` (rimosso): legge busy times dagli eventi interni
 * (tutti i calendari, non solo Lavoro) per il calcolo slot disponibili.
 *
 * Restituisce stessa shape di `BusyRange` per compatibilità con slots.ts.
 */

import { getBusyRanges } from './events';
import { captureException } from '../bugsink';
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
    // Best-effort: un errore qui NON deve rompere il calcolo slot (ritorniamo
    // []), ma va comunque segnalato — questo catch silenzioso ha nascosto metà
    // dell'incident calendario, che si manifestava solo come 500 altrove.
    log.error({ err }, 'Errore caricamento eventi');
    captureException(err instanceof Error ? err : new Error(String(err)), {
      scope: 'calendar-local-busy',
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
    });
    return [];
  }
}
