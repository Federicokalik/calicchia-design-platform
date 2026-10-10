/**
 * Generatore deterministico di regole RRULE per il confronto del motore
 * (src/recur.ts) con python-dateutil. Solo regole che hanno sempre istanze:
 * dateutil (come rrule.js) non ha un limite per periodo e su una regola
 * impossibile girerebbe fino all'anno 9999.
 */

import { DAY_MS, daysFromCivil, type EngineStart } from '../src/recur';

export interface OracleCase {
  rule: string;
  start: EngineStart;
  /** Limite (ms dell'orologio senza fuso, incluso). */
  limit: number;
  /** Istanze massime da confrontare. */
  max: number;
}

/** Generatore pseudo-casuale lineare congruenziale (riproducibile su ogni piattaforma). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export function generateCases(seed: number, count: number, max = 40): OracleCase[] {
  const rnd = lcg(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const cases: OracleCase[] = [];
  for (let k = 0; k < count; k++) {
    const f = pick(['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY'] as const);
    const parts = [`FREQ=${f}`];
    if (rnd() < 0.4) parts.push(`INTERVAL=${1 + Math.floor(rnd() * 4)}`);
    if (rnd() < 0.3) parts.push(`BYMONTH=${1 + Math.floor(rnd() * 12)},${1 + Math.floor(rnd() * 12)}`);
    if (rnd() < 0.4) {
      const n = 1 + Math.floor(rnd() * 3);
      const list = new Set<string>();
      for (let i = 0; i < n; i++) {
        const ord = (f === 'MONTHLY' || f === 'YEARLY') && rnd() < 0.4 ? pick(['1', '2', '-1', '-2', '3', '+1']) : '';
        list.add(ord + pick(WEEKDAYS));
      }
      parts.push(`BYDAY=${[...list].join(',')}`);
    }
    if (rnd() < 0.3) parts.push(`BYMONTHDAY=${pick([1, 2, 15, 28, 29, 30, 31, -1, -2])},${pick([3, 10, -3])}`);
    if (f === 'YEARLY' && rnd() < 0.2) parts.push(`BYYEARDAY=${pick([1, 100, 200, -1, 366, -366, 60])}`);
    if (f === 'YEARLY' && rnd() < 0.25) parts.push(`BYWEEKNO=${pick([1, 2, 20, 52, 53, -1, -2])}`);
    if (rnd() < 0.25 && f !== 'HOURLY' && f !== 'MINUTELY') parts.push(`BYHOUR=${pick([9, 10, 18])},${pick([0, 23, 12])}`);
    if (rnd() < 0.15 && f === 'HOURLY') parts.push(`BYHOUR=${pick([9, 10, 18])},${pick([0, 23, 12])}`);
    if (rnd() < 0.15) parts.push(`BYMINUTE=${pick([0, 15, 30])},${pick([45, 59])}`);
    if (rnd() < 0.3 && (f === 'YEARLY' || f === 'MONTHLY' || f === 'WEEKLY')) parts.push(`BYSETPOS=${pick([1, -1])}`);
    if (rnd() < 0.2) parts.push(`WKST=${pick(WEEKDAYS)}`);
    const start: EngineStart = {
      year: 2018 + Math.floor(rnd() * 8),
      month: 1 + Math.floor(rnd() * 12),
      day: 1 + Math.floor(rnd() * 28),
      hour: Math.floor(rnd() * 24),
      minute: pick([0, 15, 30, 45]),
      second: 0,
    };
    const startMs = daysFromCivil(start.year, start.month, start.day) * DAY_MS + (start.hour * 3600 + start.minute * 60) * 1000;
    const spanDays = f === 'MINUTELY' ? 1 : f === 'HOURLY' ? 20 : 365 * 3;
    cases.push({ rule: parts.join(';'), start, limit: startMs + spanDays * DAY_MS, max });
  }
  return cases;
}
