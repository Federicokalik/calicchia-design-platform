/**
 * Ricorrenza del form dell'evento (pages/calendario/evento-edit.tsx): parsing e
 * costruzione della RRULE per le serie che il form sa rappresentare senza
 * perdite. Estratto in un modulo senza dipendenze da React per poterlo
 * verificare con uno script (l'admin non ha un test runner).
 */
import { isoToZonedDate, zonedEndOfDayIso } from './timezone';

export type RecurrenceType = 'none' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

/**
 * UNTIL della RRULE → giorno Europe/Rome mostrato nel form. Una data
 * (YYYYMMDD) resta quella; un istante UTC (YYYYMMDDTHHMMSSZ) diventa il giorno
 * di Roma che lo contiene (23:59:59 di Roma è ancora lo stesso giorno in UTC).
 */
export function parseUntil(value?: string): string | undefined {
  if (!value) return undefined;
  const instant = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i);
  if (instant) return isoToZonedDate(`${instant[1]}-${instant[2]}-${instant[3]}T${instant[4]}:${instant[5]}:${instant[6]}Z`);
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T?/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : isoToZonedDate(d.toISOString());
}

/** UNTIL "fino al giorno X": l'istante UTC delle 23:59:59 di Roma di quel giorno (comprende l'ultima occorrenza del mattino). */
export function untilForDay(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return zonedEndOfDayIso(day).replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface RecurrenceState {
  type: RecurrenceType;
  count?: number;
  until?: string;
  /**
   * UNTIL com'era nella RRULE e giorno di Roma che il form ne ha ricavato: se
   * l'utente non cambia il giorno, buildRRule riscrive l'UNTIL originale
   * (un UNTIL istantaneo, come cutoff − 60 s delle teste tagliate con "questa
   * e le successive", o uno salvato dal vecchio form a mezzanotte UTC, non
   * diventa le 23:59:59 di quel giorno: la serie non acquista un'occorrenza).
   */
  untilRaw?: string;
  untilDayOriginal?: string;
  byDay?: string[];
  raw?: string;
  useRaw?: boolean;
  /** Solo MONTHLY: 'monthday' = stesso giorno del mese; 'weekday' = per posizione (es. 2° martedì). */
  monthlyMode?: 'monthday' | 'weekday';
  setpos?: number;   // 1..4 oppure -1 (ultimo)
  setposDay?: string; // MO..SU
}

// Chiavi RRULE che il form sa rappresentare e ricostruire senza perdite.
// Qualsiasi altra chiave (INTERVAL, BYMONTHDAY, BYMONTH, WKST, …) forza la
// modalità raw: si parte dalla stringa completa, mai da una versione lossy.
const FORM_RRULE_KEYS = new Set(['FREQ', 'COUNT', 'UNTIL', 'BYDAY', 'BYSETPOS']);

export function parseRRule(rrule: string | null): RecurrenceState {
  if (!rrule) return { type: 'none', raw: '' };
  const parts = Object.fromEntries(rrule.split(';').map((p) => p.split('=')));
  const freq = parts.FREQ as RecurrenceType;
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return { type: 'none', raw: rrule, useRaw: true };
  if (Object.keys(parts).some((k) => !FORM_RRULE_KEYS.has(k.toUpperCase()))) {
    return { type: freq, raw: rrule, useRaw: true };
  }
  const state: RecurrenceState = {
    type: freq,
    count: parts.COUNT ? parseInt(parts.COUNT) : undefined,
    until: parseUntil(parts.UNTIL),
    untilRaw: parts.UNTIL,
    untilDayOriginal: parseUntil(parts.UNTIL),
    raw: rrule,
    useRaw: false,
  };
  if (freq === 'MONTHLY' && parts.BYDAY && parts.BYSETPOS) {
    state.monthlyMode = 'weekday';
    state.setposDay = parts.BYDAY.split(',')[0];
    state.setpos = parseInt(parts.BYSETPOS);
  } else if (freq === 'MONTHLY') {
    state.monthlyMode = 'monthday';
  } else if (parts.BYDAY) {
    state.byDay = parts.BYDAY.split(',');
  }
  return state;
}

export function buildRRule(opts: RecurrenceState): string | null {
  if (opts.useRaw) return opts.raw?.trim() || null;
  if (opts.type === 'none') return null;
  const parts: string[] = [`FREQ=${opts.type}`];
  if (opts.type === 'WEEKLY' && opts.byDay && opts.byDay.length) parts.push(`BYDAY=${opts.byDay.join(',')}`);
  if (opts.type === 'MONTHLY' && opts.monthlyMode === 'weekday' && opts.setposDay && opts.setpos) {
    parts.push(`BYDAY=${opts.setposDay}`);
    parts.push(`BYSETPOS=${opts.setpos}`);
  }
  if (opts.count) parts.push(`COUNT=${opts.count}`);
  if (opts.until) {
    const day = opts.until.slice(0, 10);
    // Giorno non cambiato rispetto a quello ricavato dall'UNTIL salvato: si riscrive l'UNTIL originale.
    const until = opts.untilRaw && day === opts.untilDayOriginal ? opts.untilRaw : untilForDay(day);
    if (until) parts.push(`UNTIL=${until}`);
  }
  return parts.join(';');
}
