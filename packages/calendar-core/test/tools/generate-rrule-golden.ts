/**
 * Rigenera test/fixtures/rrule-golden.json: casi del generatore deterministico
 * con le istanze calcolate da python-dateutil (test/tools/dateutil-oracle.py).
 * Da rilanciare solo se cambia il generatore (i test non invocano mai python):
 *
 *   tsx test/tools/generate-rrule-golden.ts   (python3 con dateutil nel PATH, o CALDES_PYTHON)
 *
 * Per ogni caso: `minutes` = istanze di dateutil così com'è. Per le regole con
 * BYDAY misto (giorni semplici e ordinali, MONTHLY/YEARLY) il motore applica
 * l'unione di RFC 5545 invece dell'intersezione di dateutil (src/recur.ts,
 * "Differenze volute"): il valore atteso `rfc` si ricava sempre da dateutil,
 * come unione delle istanze delle due varianti (solo giorni semplici, solo
 * ordinali) e, se c'è BYSETPOS, applicando le posizioni periodo per periodo
 * sull'unione delle varianti senza BYSETPOS fatte partire dall'inizio del
 * primo periodo. Il motore non entra mai nel calcolo dell'atteso.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIXTURES_DIR, TEST_DIR } from '../helpers';
import { generateCases, type OracleCase } from '../rrule-cases';

export const GOLDEN_SEED = 20261009;
export const GOLDEN_COUNT = 400;

const DAY_MS = 86_400_000;
const python = process.env.CALDES_PYTHON || 'python3';

function oracle(cases: OracleCase[]): Array<number[] | string> {
  return JSON.parse(
    execFileSync(python, [resolve(TEST_DIR, 'tools/dateutil-oracle.py')], { input: JSON.stringify(cases), maxBuffer: 1 << 28 }).toString(),
  ) as Array<number[] | string>;
}

function startMsOf(s: OracleCase['start']): number {
  return Date.UTC(s.year, s.month - 1, s.day, s.hour, s.minute, s.second);
}

interface Parts {
  freq: string;
  byday: string[];
  setpos: number[] | null;
  rest: string[];
}

function splitRule(rule: string): Parts {
  const out: Parts = { freq: '', byday: [], setpos: null, rest: [] };
  for (const part of rule.split(';')) {
    const [k, v] = part.split('=');
    if (k === 'FREQ') out.freq = v;
    if (k === 'BYDAY') out.byday = v.split(',');
    else if (k === 'BYSETPOS') out.setpos = v.split(',').map(Number);
    else out.rest.push(part);
  }
  return out;
}

/** BYDAY con giorni semplici e ordinali in MONTHLY/YEARLY. */
function isMixed(p: Parts): boolean {
  if (p.freq !== 'MONTHLY' && p.freq !== 'YEARLY') return false;
  const ord = p.byday.filter((d) => /^[+-]?\d/.test(d));
  return ord.length > 0 && ord.length < p.byday.length;
}

/** Varianti della regola con soli giorni semplici e soli ordinali, senza BYSETPOS. */
function variants(p: Parts): [string, string] {
  const plain = p.byday.filter((d) => !/^[+-]?\d/.test(d));
  const ord = p.byday.filter((d) => /^[+-]?\d/.test(d));
  const withDays = (days: string[]): string => [...p.rest.filter((x) => !x.startsWith('BYDAY=')), `BYDAY=${days.join(',')}`].join(';');
  return [withDays(plain), withDays(ord)];
}

function sortedUnion(lists: number[][]): number[] {
  return [...new Set(lists.flat())].sort((a, b) => a - b);
}

const cases = generateCases(GOLDEN_SEED, GOLDEN_COUNT);
const results = oracle(cases);

// Casi misti: interrogazioni aggiuntive a dateutil per le varianti.
interface MixedPlan {
  index: number;
  parts: Parts;
  queries: OracleCase[];
}
const plans: MixedPlan[] = [];
cases.forEach((c, index) => {
  const parts = splitRule(c.rule);
  if (!isMixed(parts)) return;
  const [plain, ord] = variants(parts);
  if (!parts.setpos) {
    plans.push({ index, parts, queries: [{ ...c, rule: plain }, { ...c, rule: ord }] });
    return;
  }
  // BYSETPOS: insieme completo dei periodi, dal primo (stessa ora del DTSTART,
  // quindi stesso timeset e stessa griglia di INTERVAL) a oltre il limite.
  const start = { ...c.start, day: 1, month: parts.freq === 'YEARLY' ? 1 : c.start.month };
  const limit = c.limit + 400 * DAY_MS;
  plans.push({ index, parts, queries: [{ rule: plain, start, limit, max: 1_000_000 }, { rule: ord, start, limit, max: 1_000_000 }] });
});
const extra = oracle(plans.flatMap((p) => p.queries));
const rfc = new Map<number, number[] | string>();
let k = 0;
for (const plan of plans) {
  const a = extra[k++];
  const b = extra[k++];
  const c = cases[plan.index];
  if (typeof a === 'string' || typeof b === 'string') {
    rfc.set(plan.index, typeof a === 'string' ? a : (b as string));
    continue;
  }
  let all = sortedUnion([a, b]);
  if (plan.parts.setpos) {
    const byPeriod = new Map<string, number[]>();
    for (const ms of all) {
      const d = new Date(ms);
      const key = plan.parts.freq === 'YEARLY' ? `${d.getUTCFullYear()}` : `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      const list = byPeriod.get(key);
      if (list) list.push(ms);
      else byPeriod.set(key, [ms]);
    }
    const picked: number[] = [];
    for (const list of byPeriod.values()) {
      for (const pos of plan.parts.setpos) {
        const v = pos > 0 ? list[pos - 1] : list[list.length + pos];
        if (v !== undefined) picked.push(v);
      }
    }
    all = sortedUnion([picked]);
  }
  const startMs = startMsOf(c.start);
  rfc.set(plan.index, all.filter((ms) => ms >= startMs && ms <= c.limit).slice(0, c.max));
}

// Forma compatta: istanze come minuti dal DTSTART della regola.
const golden = cases.map((c, i) => {
  const startMs = startMsOf(c.start);
  const toMinutes = (r: number[] | string): number[] | string => (typeof r === 'string' ? r : r.map((ms) => (ms - startMs) / 60000));
  const entry: Record<string, unknown> = { rule: c.rule, start: c.start, limit: c.limit, max: c.max, minutes: toMinutes(results[i]) };
  const expected = rfc.get(i);
  if (expected !== undefined) entry.rfc = toMinutes(expected);
  return entry;
});
writeFileSync(
  resolve(FIXTURES_DIR, 'rrule-golden.json'),
  `${JSON.stringify({ source: 'python-dateutil 2.9', seed: GOLDEN_SEED, mixedByday: 'rfc = unione (RFC 5545) ricavata da dateutil', cases: golden }, null, 0)}\n`,
);
console.log(`scritti ${golden.length} casi, ${rfc.size} con BYDAY misto`);
