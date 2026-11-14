/**
 * Validazioni pure dei calendari condivise dai due store (fase F2 del
 * passaggio a Radicale): PgLegacyStore (legacy/calendars-pg.ts) e
 * RadicaleStore devono accettare e rifiutare gli stessi valori con gli
 * stessi messaggi (design §8, guardie API identiche a oggi). Codice spostato
 * da calendars.ts senza modifiche di comportamento.
 */

/** Slug di un calendario: a-z, 0-9 e '-', da 1 a 81 caratteri (anche backup.ts usa questo limite). */
export const CALENDAR_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * Timezone IANA riconosciuta dal runtime. Un refuso (es. 'Europe/Rom') veniva
 * salvato e poi rompeva con 500 il calcolo degli slot pubblici e admin.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
