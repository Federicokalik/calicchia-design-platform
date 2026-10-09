/**
 * Orologio fisso per i test che dipendono da "adesso" lato Node.
 *
 * Slot (min_notice_hours, max_advance_days), createBooking, feed ICS (finestra
 * -90/+365 giorni), JWT e token di gestione leggono Date.now() o new Date():
 * con date fisse nel 2027 il loro esito cambierebbe con il passare del tempo.
 * `freezeTime()` sostituisce solo Date (node:test MockTimers): setTimeout e
 * setInterval restano reali, quindi pool Postgres e timer dei middleware
 * continuano a funzionare.
 *
 * Limite noto: NOW() e CURRENT_DATE nelle query SQL usano l'orologio reale del
 * server Postgres (es. GET /closures filtra con `end_time > NOW() - 30 giorni`,
 * cancelled_at e approved_at sono NOW()). I test che ne dipendono devono
 * tenerne conto; i timestamp di sistema vanno normalizzati (helpers/normalize.ts).
 */

import { mock } from 'node:test';

let frozen = false;

/** Ferma Date all'istante indicato (ISO con fuso, es. '2027-01-04T08:00:00Z'). */
export function freezeTime(iso: string): void {
  const now = new Date(iso);
  if (Number.isNaN(now.getTime())) throw new Error(`Istante non valido per freezeTime: "${iso}"`);
  if (frozen) mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now });
  frozen = true;
}

/** Sposta in avanti l'orologio fermo di `ms` millisecondi. */
export function advanceTime(ms: number): void {
  if (!frozen) throw new Error('advanceTime richiede freezeTime');
  mock.timers.tick(ms);
}

/** Ripristina l'orologio reale. Idempotente. */
export function restoreTime(): void {
  if (!frozen) return;
  mock.timers.reset();
  frozen = false;
}

/** Esegue `fn` con l'orologio fermo e lo ripristina sempre dopo. */
export async function withFrozenTime<T>(iso: string, fn: () => T | Promise<T>): Promise<T> {
  freezeTime(iso);
  try {
    return await fn();
  } finally {
    restoreTime();
  }
}
