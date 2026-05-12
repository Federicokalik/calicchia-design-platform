/**
 * Wrapper sulla libreria `rrule` per espandere ricorrenze RFC 5545.
 *
 * Esponiamo solo le frequenze base (DAILY/WEEKLY/MONTHLY/YEARLY) + COUNT/UNTIL
 * + EXDATE, sufficienti per uso quotidiano (standup, weekly meeting, mensili).
 *
 * Per RRULE complessi (BYSETPOS, BYWEEKNO, ecc.) la libreria li gestisce ma
 * l'UI admin non li espone — l'utente avanzato può inserire la stringa raw.
 */

// rrule è CommonJS — Node 24 ESM non vede i named exports, serve default import + destructure
import rrulePkg from 'rrule';
const { rrulestr } = rrulePkg as unknown as { rrulestr: (input: string) => { between: (a: Date, b: Date, inc: boolean) => Date[]; toString: () => string } };

/** Espande un master ricorrente in una lista di ISO timestamps di occorrenze. */
export function expandRRule(opts: {
  /** RRULE string senza prefisso 'RRULE:' (es. 'FREQ=DAILY;COUNT=5') */
  rrule: string;
  /** Start ISO UTC del master event */
  masterStartIso: string;
  /** Range di espansione (UTC) — limita output per performance */
  fromIso: string;
  toIso: string;
  /** Date escluse (ISO UTC) */
  exdates?: string[];
  /** Cap massimo di occorrenze per evitare loop infiniti */
  limit?: number;
}): string[] {
  const limit = opts.limit ?? 500;
  const masterStart = new Date(opts.masterStartIso);
  const from = new Date(opts.fromIso);
  const to = new Date(opts.toIso);

  if (isNaN(masterStart.getTime()) || isNaN(from.getTime()) || isNaN(to.getTime())) {
    return [];
  }

  let rule;
  try {
    // rrulestr accetta sia 'RRULE:FREQ=...' che 'FREQ=...' (con DTSTART opzionale)
    const fullStr = opts.rrule.startsWith('DTSTART:') || opts.rrule.startsWith('RRULE:')
      ? opts.rrule
      : `DTSTART:${formatUtcCompact(masterStart)}\nRRULE:${opts.rrule}`;
    rule = rrulestr(fullStr);
  } catch (err) {
    console.error('[rrule] Parse error:', err, 'input:', opts.rrule);
    return [];
  }

  // between() ritorna le occorrenze nel range
  const occurrences = rule.between(from, to, true);

  // Filtra exdates
  const exdateSet = new Set((opts.exdates || []).map((d) => normalizeIso(d)));
  const filtered = occurrences
    .map((d) => d.toISOString())
    .filter((iso) => !exdateSet.has(normalizeIso(iso)))
    .slice(0, limit);

  return filtered;
}

/** Normalizza un ISO timestamp a una forma comparabile (rimuove ms e timezone shift) */
function normalizeIso(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Formato compatto RFC 5545 senza puntuazione: 20260426T090000Z */
function formatUtcCompact(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Valida una RRULE string. Ritorna stringa pulita se valida, altrimenti null.
 * Usata in input validation prima di salvare in DB.
 */
export function validateRRule(rrule: string, masterStartIso: string): string | null {
  try {
    const masterStart = new Date(masterStartIso);
    if (isNaN(masterStart.getTime())) return null;
    const fullStr = rrule.startsWith('DTSTART:') || rrule.startsWith('RRULE:')
      ? rrule
      : `DTSTART:${formatUtcCompact(masterStart)}\nRRULE:${rrule}`;
    const rule = rrulestr(fullStr);
    // Estrai solo la parte RRULE per storage uniforme
    const ruleStr = rule.toString();
    const match = ruleStr.match(/RRULE:(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Helper per costruire RRULE da componenti UI (admin form).
 * Esempio: { freq: 'WEEKLY', byDay: ['MO','WE','FR'], until: '2026-12-31' }
 */
export function buildRRule(opts: {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval?: number;
  byDay?: ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[];
  count?: number;
  until?: string; // ISO date
}): string {
  const parts: string[] = [`FREQ=${opts.freq}`];
  if (opts.interval && opts.interval > 1) parts.push(`INTERVAL=${opts.interval}`);
  if (opts.byDay && opts.byDay.length) parts.push(`BYDAY=${opts.byDay.join(',')}`);
  if (opts.count && opts.count > 0) parts.push(`COUNT=${opts.count}`);
  if (opts.until) {
    const d = new Date(opts.until);
    if (!isNaN(d.getTime())) parts.push(`UNTIL=${formatUtcCompact(d)}`);
  }
  return parts.join(';');
}
