/**
 * @calicchia/calendar-core — nucleo iCalendar del calendario su Radicale.
 *
 * Documentazione dell'API pubblica: README.md del pacchetto. I sottomoduli
 * sono importabili anche singolarmente (`@calicchia/calendar-core/parse`, ...),
 * utile nel browser per non trascinare moduli che non servono.
 */

export * from './errors';
export { CRLF, FOLD_OCTETS, utf8ByteLength } from './ics-text';
export * from './model';
export * from './parse';
export * from './serialize';
export * from './tz-registry';
export * from './allday';
export * from './expand';
export * from './override-match';
export * from './recurrence-ops';
export * from './patch';
export * from './validate';
export * from './fingerprint';
export * from './feed-transform';
