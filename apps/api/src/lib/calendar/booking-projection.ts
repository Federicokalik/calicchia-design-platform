/**
 * Proiezione delle prenotazioni su Radicale: modulo di compatibilità.
 *
 * Nella fase F3 il codice si è spostato in radicale/booking-projection.ts
 * (contratto docs/calendar-radicale/contracts/f3-modules.md §0 e §6.4), con le
 * stesse esportazioni; questo file le ripubblica così gli import esistenti
 * (booking.ts, radicale/store.ts, migration/*, test) restano invariati.
 */

export * from './radicale/booking-projection';
