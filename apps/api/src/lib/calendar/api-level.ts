/**
 * Livello del protocollo calendario dell'immagine dell'API (fase F4 del
 * passaggio a Radicale; design §16.6; contratto docs/calendar-radicale/
 * contracts/f4-modules.md §3.4 e §5.2).
 *
 * `calendar_backend_state.api_min_version` (165) è il livello minimo che
 * un'immagine deve avere per servire il calendario: il cutover lo porta a
 * CALENDAR_API_LEVEL (4) insieme al cambio di mode, perché dopo il cutover
 * valgono la guardia 166, la proiezione inversa e le righe derivate, che le
 * immagini precedenti non conoscono. Un'immagine con un livello più basso
 * (rollback d'immagine su Dockhand, revert ricompilato come `latest`) NON
 * deve servire il calendario: lo stato dice a quale store credere e quel
 * codice non sa leggerlo.
 *
 * - All'avvio l'integrazione chiama enforceCalendarApiLevelAtBoot() prima del
 *   control-plane del calendario: livello insufficiente → log d'errore e
 *   blocco del processo (calendarApiLevelBlocked()), che store.ts traduce in
 *   CalendarStoreUnavailableError ('store_not_available', 503) per ogni
 *   lettura e scrittura della facade. Il resto dell'API (sito, admin, CRM)
 *   continua a funzionare.
 * - Le immagini più vecchie della F4 (F1-F3) NON sono fermate da questo
 *   controllo, che non esiste nel loro codice: scrivono heartbeat e policy
 *   live, e in mode radicale servono RadicaleStore senza proiezione inversa,
 *   con l'archivio della Fase 0 scrivibile dai device. Per questo il runbook
 *   F5 fissa l'API su `sha-<short>` prima del cutover e vieta il rollback
 *   d'immagine sotto la release F4 finché la finestra è aperta, e il cutover
 *   rifiuta di partire in produzione con un'immagine senza versione
 *   (API_IMAGE_UNVERSIONED).
 * - Il blocco copre l'intero calendario del processo: oltre alla facade
 *   (calendarStore, calendarStoreForWrite), le prenotazioni (beginDecision),
 *   slot, busy e capacità, lo split dell'admin e i job del cron
 *   (ics-pull, italian-holidays, sweep della proiezione inversa, shadow); e
 *   control-plane e background del calendario non partono (index.ts), così i
 *   device vanno in frozen per heartbeat assente. Il controllo gira prima di
 *   serve() e di startCronEngine().
 * - In mode postgres con api_min_version = 0 (la produzione prima del
 *   cutover) il controllo passa sempre e non cambia nulla.
 *
 * Lo stato non si ricontrolla dopo l'avvio: il livello richiesto sale solo
 * con un cutover, che gira nello stesso processo (che ha già il livello
 * giusto), e scende solo a mano.
 */

import type { Logger } from 'pino';
import { sql } from '../../db';
import { logger as rootLogger } from '../logger';
import { CalendarStoreUnavailableError } from './errors';
import { CALENDAR_API_LEVEL } from './migration/types';
import type { Db } from './radicale/policy';

const log: Logger = rootLogger.child({ scope: 'calendar-api-level' });

/** Esito del confronto fra il livello richiesto dal database e quello dell'immagine. */
export interface CalendarApiLevelCheck {
  ok: boolean;
  /** calendar_backend_state.api_min_version. */
  required: number;
  /** Livello di questa immagine (CALENDAR_API_LEVEL). */
  current: typeof CALENDAR_API_LEVEL;
}

let blocked = false;

/**
 * Legge api_min_version e lo confronta con CALENDAR_API_LEVEL. Non cambia lo
 * stato del processo. Lancia se la riga di stato non si legge (il chiamante
 * decide: all'avvio vale come blocco, vedi enforceCalendarApiLevelAtBoot).
 */
export async function checkCalendarApiLevel(db: Db = sql): Promise<CalendarApiLevelCheck> {
  const rows: Array<{ api_min_version: number | string | null }> = await db`
    SELECT api_min_version FROM calendar_backend_state WHERE id = true
  `;
  if (rows.length !== 1) throw new Error('calendar_backend_state: riga singleton assente');
  const raw = rows[0].api_min_version;
  const required = typeof raw === 'number' ? raw : Number(raw ?? 0);
  if (!Number.isInteger(required) || required < 0) {
    throw new Error(`calendar_backend_state.api_min_version non valido: ${JSON.stringify(raw)}`);
  }
  return { ok: required <= CALENDAR_API_LEVEL, required, current: CALENDAR_API_LEVEL };
}

/**
 * Controllo d'avvio (integrazione, prima del control-plane del calendario):
 * livello insufficiente → calendario non servito da questo processo, log
 * d'errore con i due livelli; true se il livello è sufficiente. Uno stato
 * illeggibile all'avvio non blocca: senza la riga (database appena creato,
 * migrazioni in corso) nessun cutover è avvenuto, e le letture della facade
 * falliscono comunque con 'state_unreadable' finché lo stato non si legge.
 */
export async function enforceCalendarApiLevelAtBoot(db: Db = sql): Promise<boolean> {
  let check: CalendarApiLevelCheck;
  try {
    check = await checkCalendarApiLevel(db);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'livello dell\'API del calendario non verificabile all\'avvio: nessun blocco');
    return true;
  }
  if (check.ok) {
    if (blocked) log.info({ required: check.required, current: check.current }, 'livello dell\'API del calendario di nuovo sufficiente');
    blocked = false;
    return true;
  }
  blocked = true;
  log.error(
    { required: check.required, current: check.current },
    'immagine dell\'API più vecchia del livello richiesto dal database (api_min_version): il calendario non viene servito da questo processo. '
      + 'Dopo il cutover non si torna a un\'immagine precedente: usa il rollback del wizard (runbook F5).',
  );
  return false;
}

/** true dopo un controllo d'avvio fallito: la facade risponde CalendarStoreUnavailableError. */
export function calendarApiLevelBlocked(): boolean {
  return blocked;
}

/**
 * Ingresso pubblico del calendario che non passa dalla facade store.ts
 * (prenotazioni, slot, busy, capacità, split dell'admin): con l'immagine sotto
 * api_min_version lancia CalendarStoreUnavailableError ('store_not_available', 503).
 */
export function assertCalendarApiLevel(): void {
  if (blocked) throw new CalendarStoreUnavailableError('api', 'level');
}

/** Azzera il blocco (solo test). Vietato con NODE_ENV=production. */
export function resetCalendarApiLevelForTests(): void {
  if (process.env.NODE_ENV === 'production') throw new Error('resetCalendarApiLevelForTests: vietato in produzione');
  blocked = false;
}
