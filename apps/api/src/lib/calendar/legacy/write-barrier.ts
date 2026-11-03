/**
 * Barriera delle transizioni per le scritture legacy su calendars e
 * calendar_subscriptions (F4R-TR-4).
 *
 * La guardia 166 copre solo calendar_events. Le scritture di PgLegacyStore
 * su calendars e calendar_subscriptions non prendevano né il FOR SHARE dello
 * stato né il gate cal-write: la quiescenza di una transizione non le
 * attendeva, e una delete (o una create) che aveva letto mode=postgres poco
 * prima del freeze poteva fare commit dopo il piano del delta, lasciando
 * Postgres e Radicale divergenti oltre il punto di non ritorno.
 *
 * `withLegacyWriteBarrier` esegue la scrittura in una transazione che legge
 * lo stato con FOR SHARE (lo stesso lock della guardia 166): un UPDATE dello
 * stato in corso la fa attendere, e poi vede il mode nuovo; la transizione
 * attende chi ha già scritto. Fuori da mode=postgres → indisponibilità per
 * transizione (503), come per calendar_events.
 */

import { sql } from '../../../db';
import { CalendarUnavailableError } from '../errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tipo tx di postgres-js (stesso pattern di src/)
export type LegacyTx = any;

export async function withLegacyWriteBarrier<T>(fn: (tx: LegacyTx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx: LegacyTx) => {
    const [state] = await tx`SELECT mode FROM calendar_backend_state WHERE id FOR SHARE`;
    if (state?.mode !== 'postgres') {
      throw new CalendarUnavailableError('store_not_available', 'transizione del calendario in corso');
    }
    return fn(tx);
  })) as T;
}
