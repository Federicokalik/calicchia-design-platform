/**
 * Espansione RRULE legacy (libreria `rrule`), riesportata per gli script che
 * la importano da qui (scripts/fix-dst-exceptions.ts, verifiche F0).
 *
 * Dalla fase F2 del passaggio a Radicale il codice vive in
 * legacy/rrule-legacy.ts e lo usa solo PgLegacyStore: RadicaleStore espande
 * con @calicchia/calendar-core. Questo modulo si elimina in F7 insieme al
 * codice legacy (piano F7, attività 2).
 */

export { buildRRule, expandRRule, validateRRule } from './legacy/rrule-legacy';
