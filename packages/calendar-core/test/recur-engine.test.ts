/**
 * Motore delle ricorrenze (src/recur.ts): validazione delle RRULE, algoritmo
 * di python-dateutil (lo stesso di rrule.js nel codice legacy e di Radicale),
 * fast-forward esatto, limite per periodo e budget.
 *
 * Il confronto con dateutil gira sulla fixture test/fixtures/rrule-golden.json
 * (400 regole generate in modo deterministico, istanze precalcolate da
 * python-dateutil 2.9 con test/tools/generate-rrule-golden.ts): nessun
 * processo python durante i test. Per le regole con BYDAY misto il valore
 * atteso è l'unione di RFC 5545 ricavata da dateutil (campo `rfc`, vedi il
 * generatore). Un lotto nuovo generato al momento contro dateutil dal vivo
 * gira solo su richiesta, perché dateutil su una regola senza istanze itera
 * fino all'anno 9999 (decine di secondi):
 *
 *   RRULE_ORACLE_LIVE=1 [RRULE_SEED=123] [CALDES_PYTHON=...] pnpm --filter @calicchia/calendar-core test
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  civilFromDays,
  DAY_MS,
  daysFromCivil,
  type EngineStart,
  ExpansionBudget,
  ExpansionBudgetError,
  isStartInRule,
  parseRecurRule,
  type RecurRule,
  RuleIterator,
  setRrulePart,
  weekdayOfDays,
} from '../src/recur';
import { fixture, TEST_DIR } from './helpers';
import { generateCases, lcg, type OracleCase } from './rrule-cases';

function rule(text: string): RecurRule {
  const r = parseRecurRule(text);
  assert.ok(r.ok, `regola rifiutata: ${text} (${r.ok ? '' : r.reason})`);
  return r.rule;
}

function startMs(s: EngineStart): number {
  return daysFromCivil(s.year, s.month, s.day) * DAY_MS + (s.hour * 3600 + s.minute * 60 + s.second) * 1000;
}

/** Istanze del motore fino a `limit` (incluso), al più `max`; 'ERR' se la regola è rifiutata durante l'iterazione. */
function engine(c: Pick<OracleCase, 'rule' | 'start' | 'limit' | 'max'>, opts: { seek?: number; budget?: number } = {}): number[] | 'ERR' {
  const r = parseRecurRule(c.rule);
  if (!r.ok) return 'ERR';
  try {
    const it = new RuleIterator(r.rule, c.start, new ExpansionBudget(opts.budget ?? 50_000_000));
    if (opts.seek != null) it.seek(opts.seek);
    const out: number[] = [];
    for (;;) {
      const v = it.next(c.limit);
      if (v == null || v > c.limit) break;
      out.push(v);
      if (out.length >= c.max) break;
    }
    return out;
  } catch (err) {
    if (err instanceof ExpansionBudgetError) throw err;
    return 'ERR';
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe('date civili', () => {
  test('giorni dall\'epoca e ritorno, anche prima del 1970 e negli anni bisestili secolari', () => {
    for (const [y, m, d] of [[1970, 1, 1], [1969, 12, 31], [2000, 2, 29], [1900, 3, 1], [2026, 10, 25], [1, 1, 1], [9999, 12, 31]]) {
      const z = daysFromCivil(y, m, d);
      assert.deepEqual(civilFromDays(z), { year: y, month: m, day: d });
      assert.equal(z * DAY_MS, Date.UTC(2000, 0, 1) + (new Date(Date.UTC(2000, 0, 1)).setUTCFullYear(y, m - 1, d) - Date.UTC(2000, 0, 1)));
    }
    assert.equal(weekdayOfDays(daysFromCivil(2026, 10, 9)), 4, '9 ottobre 2026 è venerdì (0 = lunedì)');
  });
});

describe('parseRecurRule', () => {
  test('regole valide, con prefisso, minuscole e parti X- ignorate', () => {
    const r = parseRecurRule('RRULE:freq=weekly;byday=mo,tu,th,fr;X-FOO=1;WKST=SU');
    assert.ok(r.ok);
    assert.equal(r.rule.freq, 'WEEKLY');
    assert.deepEqual(r.rule.byday, [{ weekday: 0, n: 0 }, { weekday: 1, n: 0 }, { weekday: 3, n: 0 }, { weekday: 4, n: 0 }]);
    assert.equal(r.rule.wkst, 6);
    assert.deepEqual(r.notices, ['PART_IGNORED']);
    const u = parseRecurRule('FREQ=DAILY;UNTIL=20261231T225959Z');
    assert.ok(u.ok && u.rule.until?.type === 'date-time' && u.rule.until.zone.kind === 'utc');
    const d = parseRecurRule('FREQ=YEARLY;UNTIL=20301231');
    assert.ok(d.ok && d.rule.until?.type === 'date');
  });

  test('valori vietati e parti sconosciute → non valida, mai un\'eccezione', () => {
    for (const text of [
      '',
      'INTERVAL=2',
      'FREQ=SOMETIMES',
      'FREQ=DAILY;INTERVAL=0',
      'FREQ=DAILY;COUNT=0',
      'FREQ=DAILY;COUNT=-1',
      'FREQ=DAILY;BYHOUR=24',
      'FREQ=DAILY;BYMINUTE=60',
      'FREQ=MONTHLY;BYMONTHDAY=0',
      'FREQ=MONTHLY;BYMONTHDAY=32',
      'FREQ=YEARLY;BYMONTH=13',
      'FREQ=YEARLY;BYYEARDAY=367',
      'FREQ=YEARLY;BYWEEKNO=54',
      'FREQ=MONTHLY;BYDAY=0MO',
      'FREQ=MONTHLY;BYDAY=54MO',
      'FREQ=WEEKLY;BYDAY=XX',
      'FREQ=DAILY;FREQ=WEEKLY',
      'FREQ=DAILY;UNTIL=2026-12-31',
      'FREQ=DAILY;FOO=1',
      'FREQ=DAILY;RSCALE=CHINESE',
      'FREQ=DAILY;SKIP=FORWARD',
      'FREQ=DAILY;BYSETPOS=0',
      'FREQ=DAILY;WKST=XX',
    ]) {
      const r = parseRecurRule(text);
      assert.equal(r.ok, false, `doveva essere rifiutata: "${text}"`);
    }
  });

  test('combinazioni vietate da RFC 5545 applicate come filtro (come dateutil), con avviso', () => {
    const r = parseRecurRule('FREQ=WEEKLY;BYMONTHDAY=1;COUNT=3;UNTIL=20270101');
    assert.ok(r.ok);
    assert.ok(r.notices.includes('NONSTANDARD_COMBINATION'));
    assert.ok(r.notices.includes('COUNT_AND_UNTIL'));
    const o = parseRecurRule('FREQ=WEEKLY;BYDAY=1MO');
    assert.ok(o.ok && o.notices.includes('ORDINAL_IGNORED'));
    const s = parseRecurRule('FREQ=MINUTELY;BYSECOND=60');
    assert.ok(s.ok && s.notices.includes('LEAP_SECOND'));
    assert.deepEqual(s.ok && s.rule.bysecond, [59]);
  });

  test('setRrulePart riscrive solo la parte indicata', () => {
    assert.equal(setRrulePart('FREQ=DAILY;COUNT=10;BYHOUR=9', 'COUNT', '4'), 'FREQ=DAILY;COUNT=4;BYHOUR=9');
    assert.equal(setRrulePart('RRULE:FREQ=DAILY;COUNT=10', 'COUNT', null), 'FREQ=DAILY');
    assert.equal(setRrulePart('FREQ=DAILY', 'UNTIL', '20261231T225959Z'), 'FREQ=DAILY;UNTIL=20261231T225959Z');
  });
});

describe('RuleIterator contro python-dateutil', () => {
  const golden = JSON.parse(fixture('rrule-golden.json')) as {
    seed: number;
    cases: Array<{ rule: string; start: EngineStart; limit: number; max: number; minutes: number[] | string; rfc?: number[] | string }>;
  };

  test(`fixture: ${golden.cases.length} regole identiche a dateutil (seed ${golden.seed}), BYDAY misto come RFC 5545`, () => {
    assert.ok(golden.cases.length >= 300);
    let errors = 0;
    let mixed = 0;
    let mixedDifferent = 0;
    for (const c of golden.cases) {
      const ours = engine(c);
      const parsed = parseRecurRule(c.rule);
      const isMixed = parsed.ok && parsed.notices.includes('MIXED_BYDAY');
      // Il campo rfc c'è esattamente per le regole con BYDAY misto.
      assert.equal(c.rfc !== undefined, isMixed, `${c.rule}: campo rfc incoerente con MIXED_BYDAY`);
      const expected = c.rfc ?? c.minutes;
      if (isMixed) {
        mixed++;
        if (JSON.stringify(c.rfc) !== JSON.stringify(c.minutes)) mixedDifferent++;
      }
      if (typeof expected === 'string') {
        // dateutil rifiuta la regola (INTERVAL e BYxxx senza istanze): anche il motore.
        assert.equal(ours, 'ERR', `${c.rule}: dateutil ${expected}, motore ${JSON.stringify(ours).slice(0, 80)}`);
        errors++;
        continue;
      }
      const base = startMs(c.start);
      assert.deepEqual(ours, expected.map((m) => base + m * 60000), `${c.rule} da ${JSON.stringify(c.start)}`);
    }
    assert.ok(errors < golden.cases.length / 10);
    // La fixture deve esercitare davvero la differenza voluta.
    assert.ok(mixed >= 10 && mixedDifferent >= 10, `casi misti ${mixed}, diversi da dateutil ${mixedDifferent}`);
  });

  const python = process.env.CALDES_PYTHON || 'python3';
  let liveSkip: string | false = false;
  if (process.env.RRULE_ORACLE_LIVE !== '1') {
    liveSkip = 'solo con RRULE_ORACLE_LIVE=1 (dateutil dal vivo, lento)';
  } else {
    try {
      execFileSync(python, ['-c', 'import dateutil.rrule'], { stdio: 'ignore' });
    } catch {
      liveSkip = `${python} con python-dateutil non disponibile`;
    }
  }
  test('dal vivo: 1500 regole nuove identiche a dateutil (BYDAY misto escluso)', { skip: liveSkip }, () => {
    const seed = Number(process.env.RRULE_SEED || Date.now() % 100000);
    const cases = generateCases(seed, 1500, 200).filter((c) => {
      const p = parseRecurRule(c.rule);
      return !(p.ok && p.notices.includes('MIXED_BYDAY'));
    });
    const theirs = JSON.parse(
      execFileSync(python, [resolve(TEST_DIR, 'tools/dateutil-oracle.py')], { input: JSON.stringify(cases), maxBuffer: 1 << 28 }).toString(),
    ) as Array<number[] | string>;
    for (let i = 0; i < cases.length; i++) {
      const ours = engine(cases[i]);
      const t = theirs[i];
      if (typeof t === 'string') assert.equal(ours, 'ERR', `seed ${seed}: ${cases[i].rule}`);
      else assert.deepEqual(ours, t, `seed ${seed}: ${cases[i].rule} da ${JSON.stringify(cases[i].start)}`);
    }
  });
});

describe('BYDAY misto (differenza voluta da dateutil)', () => {
  const at = (y: number, m: number, d: number, h = 9): number => Date.UTC(y, m - 1, d, h);
  const run = (text: string, start: EngineStart, limit: number): number[] => {
    const out = engine({ rule: text, start, limit, max: 1000 });
    assert.notEqual(out, 'ERR');
    return out as number[];
  };
  const start: EngineStart = { year: 2026, month: 10, day: 1, hour: 9, minute: 0, second: 0 };

  test('MONTHLY;BYDAY=MO,1FR: tutti i lunedì più il primo venerdì (dateutil e il legacy: nessuna istanza)', () => {
    const r = parseRecurRule('FREQ=MONTHLY;BYDAY=MO,1FR');
    assert.ok(r.ok && r.notices.includes('MIXED_BYDAY'));
    assert.deepEqual(run('FREQ=MONTHLY;BYDAY=MO,1FR', start, at(2026, 11, 30, 23)).map(iso), [
      at(2026, 10, 2), at(2026, 10, 5), at(2026, 10, 12), at(2026, 10, 19), at(2026, 10, 26),
      at(2026, 11, 2), at(2026, 11, 6), at(2026, 11, 9), at(2026, 11, 16), at(2026, 11, 23), at(2026, 11, 30),
    ].map(iso));
  });

  test('stesso giorno semplice e ordinale: l\'unione è il giorno semplice; con BYSETPOS le posizioni valgono sull\'unione', () => {
    assert.deepEqual(run('FREQ=MONTHLY;BYDAY=MO,1MO', start, at(2026, 10, 31, 23)).map(iso), [at(2026, 10, 5), at(2026, 10, 12), at(2026, 10, 19), at(2026, 10, 26)].map(iso));
    assert.deepEqual(run('FREQ=MONTHLY;BYDAY=MO,1MO;BYSETPOS=-1', start, at(2026, 11, 30, 23)).map(iso), [at(2026, 10, 26), at(2026, 11, 30)].map(iso));
    // YEARLY con BYMONTH: ordinale nel mese, unione con i giorni semplici.
    assert.deepEqual(
      run('FREQ=YEARLY;BYMONTH=10;BYDAY=SU,-1SA', start, at(2026, 12, 31)).map(iso),
      [at(2026, 10, 4), at(2026, 10, 11), at(2026, 10, 18), at(2026, 10, 25), at(2026, 10, 31)].map(iso),
    );
  });

  test('solo ordinali o solo semplici: invariato rispetto a dateutil, nessun avviso', () => {
    for (const text of ['FREQ=MONTHLY;BYDAY=1FR,-1MO', 'FREQ=MONTHLY;BYDAY=MO,FR', 'FREQ=WEEKLY;BYDAY=MO,1FR']) {
      const r = parseRecurRule(text);
      assert.ok(r.ok && !r.notices.includes('MIXED_BYDAY'), text);
    }
    assert.deepEqual(run('FREQ=MONTHLY;BYDAY=1FR,-1MO', start, at(2026, 10, 31, 23)).map(iso), [at(2026, 10, 2), at(2026, 10, 26)].map(iso));
  });
});

describe('fast-forward (seek)', () => {
  test('stesse istanze della scansione completa da qualsiasi punto, per ogni frequenza', () => {
    const rnd = lcg(4242);
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
    const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
    let checked = 0;
    for (let k = 0; k < 600; k++) {
      const f = pick(['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY'] as const);
      const parts = [`FREQ=${f}`, `INTERVAL=${1 + Math.floor(rnd() * 5)}`];
      if (rnd() < 0.5) parts.push(`BYDAY=${pick(days)},${pick(days)}`);
      if (rnd() < 0.3 && f !== 'SECONDLY') parts.push(`BYHOUR=${pick([9, 10])},${pick([14, 18])}`);
      if (rnd() < 0.3) parts.push(`BYMONTH=${pick([1, 3, 10])},${pick([6, 12])}`);
      if (rnd() < 0.2) parts.push(`BYMONTHDAY=${pick([1, 15, -1])}`);
      if (rnd() < 0.2 && (f === 'YEARLY' || f === 'MONTHLY' || f === 'WEEKLY')) parts.push(`BYSETPOS=${pick([1, -1])}`);
      if (rnd() < 0.3) parts.push(`WKST=${pick(days)}`);
      const start: EngineStart = {
        year: 2010 + Math.floor(rnd() * 5),
        month: 1 + Math.floor(rnd() * 12),
        day: 1 + Math.floor(rnd() * 28),
        hour: Math.floor(rnd() * 24),
        minute: pick([0, 30]),
        second: pick([0, 20]),
      };
      const unit = f === 'SECONDLY' ? 3_600_000 : f === 'MINUTELY' ? 36_000_000 : f === 'HOURLY' ? 3_600_000 * 300 : DAY_MS * 2000;
      const seek = startMs(start) + Math.floor(rnd() * unit * 3);
      const c = { rule: parts.join(';'), start, limit: seek + unit, max: 1_000_000 };
      const full = engine(c);
      if (full === 'ERR') continue;
      const fast = engine(c, { seek });
      assert.notEqual(fast, 'ERR');
      assert.deepEqual((fast as number[]).filter((v) => v >= seek), full.filter((v) => v >= seek), `${c.rule} da ${JSON.stringify(start)}, seek ${iso(seek)}`);
      checked++;
    }
    assert.ok(checked > 400);
  });

  test('DAILY dal 2010: la settimana corrente in poche iterazioni', () => {
    const budget = new ExpansionBudget(1000);
    const it = new RuleIterator(rule('FREQ=DAILY'), { year: 2010, month: 1, day: 1, hour: 9, minute: 0, second: 0 }, budget);
    const from = Date.UTC(2026, 9, 5);
    it.seek(from);
    const out: number[] = [];
    for (;;) {
      const v = it.next(Date.UTC(2026, 9, 12));
      if (v == null || v > Date.UTC(2026, 9, 12)) break;
      if (v >= from) out.push(v);
    }
    assert.equal(out.length, 7);
    assert.equal(iso(out[0]), '2026-10-05T09:00:00.000Z');
    assert.ok(budget.used < 20, `iterazioni: ${budget.used}`);
  });
});

describe('limite per periodo e budget', () => {
  test('una regola impossibile termina al limite invece di girare fino all\'anno 9999', () => {
    const budget = new ExpansionBudget(10_000);
    const it = new RuleIterator(rule('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'), { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, budget);
    assert.equal(it.next(Date.UTC(2027, 0, 1)), null);
    assert.equal(it.finished, false);
    assert.ok(budget.used <= 367);
  });

  test('YEARLY impossibile (31 febbraio) finisce all\'anno 9999 senza istanze', () => {
    const it = new RuleIterator(rule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31'), { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, new ExpansionBudget(20_000));
    assert.equal(it.next(Number.POSITIVE_INFINITY), null);
    assert.equal(it.finished, true);
  });

  test('un periodo costa quanto le istanze che produce: buffer mai oltre il budget', () => {
    // YEARLY con 86400 orari al giorno: 31 milioni di istanze in un solo periodo.
    const text = `FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=${Array.from({ length: 24 }, (_, i) => i).join(',')};BYMINUTE=${Array.from({ length: 60 }, (_, i) => i).join(',')};BYSECOND=${Array.from({ length: 60 }, (_, i) => i).join(',')}`;
    const t0 = performance.now();
    const it = new RuleIterator(rule(text), { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, new ExpansionBudget(200_000));
    assert.throws(() => it.next(Number.POSITIVE_INFINITY), ExpansionBudgetError);
    assert.ok(performance.now() - t0 < 1000, 'il budget deve fermare il periodo prima di costruire il buffer');
    // Una istanza per periodo costa un'iterazione: HOURLY per un anno ≈ 8760.
    const budget = new ExpansionBudget(200_000);
    const h = new RuleIterator(rule('FREQ=HOURLY'), { year: 2025, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, budget);
    let n = 0;
    for (;;) {
      const v = h.next(Date.UTC(2025, 11, 31, 23));
      if (v == null) break;
      n++;
    }
    assert.equal(n, 8760);
    assert.ok(budget.used <= 8762, `iterazioni: ${budget.used}`);
  });

  test('budget esaurito → ExpansionBudgetError (anche nei passi interni di MINUTELY)', () => {
    const it = new RuleIterator(rule('FREQ=HOURLY'), { year: 2010, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, new ExpansionBudget(100));
    assert.throws(() => {
      for (;;) if (it.next(Number.POSITIVE_INFINITY) == null) break;
    }, ExpansionBudgetError);
    const m = new RuleIterator(rule('FREQ=MINUTELY;BYHOUR=9'), { year: 2026, month: 1, day: 1, hour: 10, minute: 0, second: 0 }, new ExpansionBudget(500));
    assert.throws(() => m.next(Number.POSITIVE_INFINITY), ExpansionBudgetError);
  });

  test('DTSTART dentro o fuori dalla regola', () => {
    const b = new ExpansionBudget(100);
    assert.equal(isStartInRule(rule('FREQ=WEEKLY;BYDAY=MO,TU,TH,FR'), { year: 2026, month: 1, day: 5, hour: 9, minute: 0, second: 0 }, b), true);
    assert.equal(isStartInRule(rule('FREQ=WEEKLY;BYDAY=MO,TU,TH,FR'), { year: 2026, month: 1, day: 7, hour: 9, minute: 0, second: 0 }, b), false);
    assert.equal(isStartInRule(rule('FREQ=MONTHLY;BYMONTHDAY=31'), { year: 2026, month: 2, day: 28, hour: 9, minute: 0, second: 0 }, b), false);
  });
});
