/**
 * Motore delle ricorrenze (modulo interno di expand, override-match e
 * recurrence-ops; non è un sottomodulo pubblico del pacchetto).
 *
 * Tre livelli:
 * 1. parseRecurRule: RRULE (RFC 5545 §3.3.10) → regola tipizzata, con
 *    validazione stretta dei valori. Una regola non interpretabile non lancia:
 *    restituisce il motivo, e l'espansione mette l'oggetto in quarantena.
 * 2. RuleIterator: l'algoritmo di python-dateutil (rrule._iter), lo stesso di
 *    rrule.js (il motore del codice legacy, apps/api/src/lib/calendar/rrule.ts)
 *    e di Radicale (vobject → dateutil) quando risponde alle REPORT con
 *    time-range. Lavora su ore "da muro" (ms UTC usati come orologio senza
 *    fuso: il fuso lo applica la serie), periodo per periodo, con tre
 *    aggiunte:
 *    - fast-forward esatto (seek) al periodo che contiene un istante, per le
 *      regole senza COUNT: l'insieme delle istanze di un periodo dipende solo
 *      dal periodo, quindi saltare k periodi sulla griglia di INTERVAL non
 *      cambia il risultato (una DAILY dal 2010 arriva alla settimana corrente
 *      in pochi passi);
 *    - limite per periodo: next(limit) si ferma quando l'inizio del periodo
 *      supera il limite, anche se la regola non produce istanze (una regola
 *      impossibile come FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30 termina subito
 *      invece di girare fino all'anno 9999);
 *    - budget: ogni periodo costa un'iterazione, o tante quante le istanze
 *      che produce se sono di più (il buffer di un periodo non supera mai il
 *      budget), e ogni passo interno di MINUTELY/SECONDLY ne costa una
 *      (ExpansionBudget); esaurito il budget si lancia ExpansionBudgetError,
 *      che l'espansione traduce in quarantena (design §6.4).
 * 3. Series: le istanze di un master, DTSTART ∪ RRULE ∪ RDATE con UNTIL e
 *    COUNT, nell'ordine dell'ora da muro e convertite in istanti con la zona
 *    del DTSTART (tz-registry: orari inesistenti e ambigui secondo RFC 5545).
 *    Le EXDATE e gli override NON si applicano qui (servono anche a decidere
 *    se un override è orfano, design §6.4): li applica il chiamante.
 *
 * Differenze volute rispetto a dateutil/rrule.js:
 * - DTSTART è sempre la prima istanza e conta per COUNT (RFC 5545 §3.8.5.3),
 *   anche se non soddisfa la regola: dateutil e rrule.js la scartano (il
 *   legacy quindi non la mostra; differenza documentata nei test di parità,
 *   avviso DTSTART_NOT_IN_RULE);
 * - UNTIL si confronta con l'istante (UTC) delle istanze quando è in UTC,
 *   con l'ora da muro quando è floating; un UNTIL DATE su un master
 *   DATE-TIME include tutta la giornata locale (scelta conservativa per il
 *   busy, avviso UNTIL_TYPE_MISMATCH);
 * - BYSECOND=60 vale 59 (come le conversioni del pacchetto);
 * - BYDAY misto (giorni semplici e ordinali, es. FREQ=MONTHLY;BYDAY=MO,1FR)
 *   con MONTHLY/YEARLY: unione, come RFC 5545 e come ical.js, libical,
 *   Apple e Google mostrano la serie sui device. dateutil e rrule.js
 *   richiedono che il giorno soddisfi entrambe le forme e la regola non ha
 *   istanze: il busy resterebbe vuoto mentre il telefono mostra l'impegno.
 *   Senza BYSETPOS l'unione contiene l'intersezione, quindi la scelta è
 *   anche quella prudente; avviso MIXED_BYDAY (anomalia per la migrazione,
 *   perché il legacy non mostra quelle occorrenze).
 */

import { addDays, allDayRangeFromIcs, daysBetween, icsDateToString, localDateOf } from './allday';
import { CalendarCoreError } from './errors';
import {
  formatTimeValue,
  getProperties,
  getProperty,
  type IcsComponent,
  type IcsDate,
  type IcsDateTime,
  type IcsDuration,
  type IcsPeriod,
  type IcsTime,
  parseDateTimeValue,
  parseDateValue,
  parseDurationValue,
  readTimeListProperty,
  readTimeProperty,
  recurrenceKeyOf,
  recurrenceKeyToTime,
  timeToUtcMs,
  type ZoneContext,
} from './model';
import { type ConvertibleZone, ianaZone, msToWall, resolveZone, utcToZoned, type WallTime, wallToMs, zonedToUtc } from './tz-registry';

/** Budget di iterazioni predefinito (expand.EXPANSION_ITERATION_BUDGET, design §6.4). */
export const DEFAULT_ITERATION_BUDGET = 200_000;

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const MAX_YEAR = 9999;

// ============================================
// Errori interni (tipizzati: se sfuggono restano CalendarCoreError)
// ============================================

/** Regola di ricorrenza non interpretabile o con valori vietati. */
export class RecurRuleError extends CalendarCoreError {
  constructor(message: string) {
    super('INVALID_RRULE', message);
  }
}

/** Budget di iterazioni esaurito (design §6.4). */
export class ExpansionBudgetError extends CalendarCoreError {
  constructor(used: number, max: number) {
    super('EXPANSION_BUDGET', `Budget di espansione esaurito (${used} iterazioni su ${max})`, { used, max });
  }
}

/** Contatore delle iterazioni di un'espansione, condiviso fra tutte le scansioni dello stesso oggetto. */
export class ExpansionBudget {
  used = 0;
  constructor(readonly max: number) {}

  spend(n = 1): void {
    this.used += n;
    if (this.used > this.max) throw new ExpansionBudgetError(this.used, this.max);
  }

  get exhausted(): boolean {
    return this.used >= this.max;
  }
}

// ============================================
// Date civili (giorni dall'epoca, algoritmo di H. Hinnant, valido per ogni anno)
// ============================================

/** Giorni dal 1970-01-01 della data civile (mese 1-12). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Data civile dei giorni dall'epoca. */
export function civilFromDays(z: number): { year: number; month: number; day: number } {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** Giorno della settimana (0 = lunedì, come dateutil) dei giorni dall'epoca (1970-01-01 era giovedì). */
export function weekdayOfDays(z: number): number {
  return (((z + 3) % 7) + 7) % 7;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function monthLength(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function pmod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** Ora da muro → ms (orologio senza fuso). */
export function wallMsOf(w: WallTime): number {
  return daysFromCivil(w.year, w.month, w.day) * DAY_MS + (w.hour * 3600 + w.minute * 60 + Math.min(w.second, 59)) * SECOND_MS;
}

// ============================================
// Regola tipizzata
// ============================================

/** Frequenze nell'ordine delle costanti di dateutil (YEARLY = 0 ... SECONDLY = 6). */
export const FREQUENCIES = ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

const F_YEARLY = 0;
const F_MONTHLY = 1;
const F_WEEKLY = 2;
const F_DAILY = 3;
const F_HOURLY = 4;
const F_MINUTELY = 5;
const F_SECONDLY = 6;

/** Giorni della settimana iCalendar nell'ordine di dateutil (0 = MO). */
export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

export interface RecurByDay {
  /** 0 = lunedì ... 6 = domenica. */
  weekday: number;
  /** Ordinale (es. -1 per "ultimo"); 0 se assente. */
  n: number;
}

export interface RecurRule {
  freq: Frequency;
  interval: number;
  count: number | null;
  /** UNTIL letto: DATE, DATE-TIME in UTC (Z) o floating. */
  until: IcsDate | IcsDateTime | null;
  bysecond: number[] | null;
  byminute: number[] | null;
  byhour: number[] | null;
  byday: RecurByDay[] | null;
  bymonthday: number[] | null;
  byyearday: number[] | null;
  byweekno: number[] | null;
  bymonth: number[] | null;
  bysetpos: number[] | null;
  /** 0 = lunedì (default RFC 5545). */
  wkst: number;
}

export type RecurNotice =
  /** Parte X-... (o RSCALE=GREGORIAN, SKIP=OMIT) ignorata. */
  | 'PART_IGNORED'
  /** Ordinale in BYDAY con una FREQ diversa da MONTHLY/YEARLY: ignorato (come dateutil e il legacy). */
  | 'ORDINAL_IGNORED'
  /** Combinazione che RFC 5545 vieta (BYMONTHDAY con WEEKLY, BYYEARDAY con DAILY/WEEKLY/MONTHLY, BYWEEKNO fuori da YEARLY, BYSETPOS da solo): applicata come filtro, come dateutil. */
  | 'NONSTANDARD_COMBINATION'
  /** COUNT e UNTIL insieme (vietato da RFC 5545): valgono entrambi, si ferma al primo. */
  | 'COUNT_AND_UNTIL'
  /** BYSECOND=60 trattato come 59. */
  | 'LEAP_SECOND'
  /** BYDAY con giorni semplici e ordinali in MONTHLY/YEARLY: unione (RFC 5545), dateutil e il legacy non danno istanze. */
  | 'MIXED_BYDAY';

export type RecurParseResult =
  | { ok: true; rule: RecurRule; notices: RecurNotice[] }
  | { ok: false; reason: string };

const INT_RE = /^[+-]?\d{1,6}$/;
const BYDAY_RE = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/;

function intList(name: string, value: string, min: number, max: number, allowNegative: boolean): number[] {
  const out: number[] = [];
  for (const raw of value.split(',')) {
    const v = raw.trim();
    if (!INT_RE.test(v)) throw new RecurRuleError(`${name}: valore non numerico "${v.slice(0, 12)}"`);
    const n = Number(v);
    const abs = Math.abs(n);
    if ((n < 0 && !allowNegative) || abs < min || abs > max || (n === 0 && min > 0)) {
      throw new RecurRuleError(`${name}: valore fuori intervallo (${n})`);
    }
    if (!out.includes(n)) out.push(n);
  }
  if (out.length === 0) throw new RecurRuleError(`${name} vuota`);
  return out;
}

/**
 * RRULE (con o senza prefisso "RRULE:") → regola tipizzata. Validazione
 * stretta secondo RFC 5545 §3.3.10: FREQ obbligatoria, parti non ripetute,
 * valori nei loro intervalli, INTERVAL e COUNT ≥ 1. Le parti X-... vengono
 * ignorate con un avviso; le altre parti sconosciute rendono la regola non
 * valida. Non lancia mai.
 */
export function parseRecurRule(value: string): RecurParseResult {
  try {
    return { ok: true, ...parseRecurRuleOrThrow(value) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function parseRecurRuleOrThrow(value: string): { rule: RecurRule; notices: RecurNotice[] } {
  const body = value.trim().replace(/^RRULE:/i, '');
  if (!body) throw new RecurRuleError('RRULE vuota');
  if (body.length > 2000) throw new RecurRuleError('RRULE troppo lunga');
  const notices: RecurNotice[] = [];
  const seen = new Set<string>();
  const rule: RecurRule = {
    freq: 'DAILY',
    interval: 1,
    count: null,
    until: null,
    bysecond: null,
    byminute: null,
    byhour: null,
    byday: null,
    bymonthday: null,
    byyearday: null,
    byweekno: null,
    bymonth: null,
    bysetpos: null,
    wkst: 0,
  };
  let hasFreq = false;
  for (const rawPart of body.split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) throw new RecurRuleError(`parte senza "=": "${part.slice(0, 20)}"`);
    const name = part.slice(0, eq).trim().toUpperCase();
    const val = part.slice(eq + 1).trim();
    if (seen.has(name)) throw new RecurRuleError(`${name} ripetuta`);
    seen.add(name);
    if (!val) throw new RecurRuleError(`${name} senza valore`);
    switch (name) {
      case 'FREQ': {
        const f = val.toUpperCase();
        if (!(FREQUENCIES as readonly string[]).includes(f)) throw new RecurRuleError(`FREQ non valida: "${val.slice(0, 12)}"`);
        rule.freq = f as Frequency;
        hasFreq = true;
        break;
      }
      case 'INTERVAL': {
        if (!/^\d{1,6}$/.test(val) || Number(val) < 1) throw new RecurRuleError(`INTERVAL non valido: "${val.slice(0, 12)}"`);
        rule.interval = Number(val);
        break;
      }
      case 'COUNT': {
        if (!/^\d{1,9}$/.test(val) || Number(val) < 1) throw new RecurRuleError(`COUNT non valido: "${val.slice(0, 12)}"`);
        rule.count = Number(val);
        break;
      }
      case 'UNTIL': {
        if (/^\d{8}$/.test(val)) rule.until = parseDateValue(val, 'RRULE');
        else if (/^\d{8}T\d{6}Z?$/i.test(val)) rule.until = parseDateTimeValue(val.toUpperCase(), null, 'RRULE');
        else throw new RecurRuleError(`UNTIL non valido: "${val.slice(0, 20)}"`);
        break;
      }
      case 'BYSECOND': {
        const list = intList(name, val, 0, 60, false);
        if (list.includes(60)) notices.push('LEAP_SECOND');
        rule.bysecond = [...new Set(list.map((n) => Math.min(n, 59)))];
        break;
      }
      case 'BYMINUTE':
        rule.byminute = intList(name, val, 0, 59, false);
        break;
      case 'BYHOUR':
        rule.byhour = intList(name, val, 0, 23, false);
        break;
      case 'BYDAY': {
        const list: RecurByDay[] = [];
        for (const raw of val.toUpperCase().split(',')) {
          const m = BYDAY_RE.exec(raw.trim());
          if (!m) throw new RecurRuleError(`BYDAY non valido: "${raw.slice(0, 12)}"`);
          const n = m[1] ? Number(m[1]) : 0;
          if (m[1] && (n === 0 || Math.abs(n) > 53)) throw new RecurRuleError(`BYDAY: ordinale fuori intervallo (${n})`);
          const weekday = (WEEKDAY_CODES as readonly string[]).indexOf(m[2]);
          if (!list.some((d) => d.weekday === weekday && d.n === n)) list.push({ weekday, n });
        }
        rule.byday = list;
        break;
      }
      case 'BYMONTHDAY':
        rule.bymonthday = intList(name, val, 1, 31, true);
        break;
      case 'BYYEARDAY':
        rule.byyearday = intList(name, val, 1, 366, true);
        break;
      case 'BYWEEKNO':
        rule.byweekno = intList(name, val, 1, 53, true);
        break;
      case 'BYMONTH':
        rule.bymonth = intList(name, val, 1, 12, false);
        break;
      case 'BYSETPOS':
        rule.bysetpos = intList(name, val, 1, 366, true);
        break;
      case 'WKST': {
        const w = (WEEKDAY_CODES as readonly string[]).indexOf(val.toUpperCase());
        if (w < 0) throw new RecurRuleError(`WKST non valido: "${val.slice(0, 12)}"`);
        rule.wkst = w;
        break;
      }
      case 'RSCALE':
        // RFC 7529: solo il calendario gregoriano è supportato.
        if (val.toUpperCase() !== 'GREGORIAN') throw new RecurRuleError(`RSCALE non supportato: "${val.slice(0, 20)}"`);
        notices.push('PART_IGNORED');
        break;
      case 'SKIP':
        if (val.toUpperCase() !== 'OMIT') throw new RecurRuleError(`SKIP non supportato: "${val.slice(0, 20)}"`);
        notices.push('PART_IGNORED');
        break;
      default:
        if (name.startsWith('X-')) {
          notices.push('PART_IGNORED');
          break;
        }
        throw new RecurRuleError(`parte sconosciuta: "${name.slice(0, 20)}"`);
    }
  }
  if (!hasFreq) throw new RecurRuleError('FREQ mancante');
  if (rule.count != null && rule.until != null) notices.push('COUNT_AND_UNTIL');
  const f = FREQUENCIES.indexOf(rule.freq);
  if (rule.byday?.some((d) => d.n !== 0) && f > F_MONTHLY) notices.push('ORDINAL_IGNORED');
  if (f <= F_MONTHLY && rule.byday?.some((d) => d.n !== 0) && rule.byday.some((d) => d.n === 0)) notices.push('MIXED_BYDAY');
  if (
    (rule.bymonthday && f === F_WEEKLY) ||
    (rule.byyearday && (f === F_DAILY || f === F_WEEKLY || f === F_MONTHLY)) ||
    (rule.byweekno && f !== F_YEARLY) ||
    (rule.bysetpos &&
      !(rule.bysecond || rule.byminute || rule.byhour || rule.byday || rule.bymonthday || rule.byyearday || rule.byweekno || rule.bymonth))
  ) {
    notices.push('NONSTANDARD_COMBINATION');
  }
  return { rule, notices: [...new Set(notices)] };
}

/** Forma testuale di una parte della RRULE (per riscrivere UNTIL e COUNT senza toccare il resto). */
export function setRrulePart(value: string, name: string, newValue: string | null): string {
  const body = value.trim().replace(/^RRULE:/i, '');
  const upper = name.toUpperCase();
  const parts = body.split(';').filter((p) => p.trim() !== '');
  const idx = parts.findIndex((p) => p.split('=')[0].trim().toUpperCase() === upper);
  if (newValue == null) {
    if (idx >= 0) parts.splice(idx, 1);
  } else if (idx >= 0) {
    parts[idx] = `${upper}=${newValue}`;
  } else {
    parts.push(`${upper}=${newValue}`);
  }
  return parts.join(';');
}

// ============================================
// Maschere di dateutil
// ============================================

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}

const M366MASK: number[] = [
  ...Array(31).fill(1), ...Array(29).fill(2), ...Array(31).fill(3), ...Array(30).fill(4), ...Array(31).fill(5), ...Array(30).fill(6),
  ...Array(31).fill(7), ...Array(31).fill(8), ...Array(30).fill(9), ...Array(31).fill(10), ...Array(30).fill(11), ...Array(31).fill(12),
  ...Array(7).fill(1),
];
const M365MASK: number[] = [...M366MASK.slice(0, 59), ...M366MASK.slice(60)];
const D31 = range(1, 32);
const D30 = range(1, 31);
const D29 = range(1, 30);
const MDAY366MASK: number[] = [...D31, ...D29, ...D31, ...D30, ...D31, ...D30, ...D31, ...D31, ...D30, ...D31, ...D30, ...D31, ...D31.slice(0, 7)];
const MDAY365MASK: number[] = [...MDAY366MASK.slice(0, 59), ...MDAY366MASK.slice(60)];
const N31 = range(-31, 0);
const N30 = range(-30, 0);
const N29 = range(-29, 0);
const NMDAY366MASK: number[] = [...N31, ...N29, ...N31, ...N30, ...N31, ...N30, ...N31, ...N31, ...N30, ...N31, ...N30, ...N31, ...N31.slice(0, 7)];
const NMDAY365MASK: number[] = [...NMDAY366MASK.slice(0, 31), ...NMDAY366MASK.slice(32)];
const M366RANGE = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];
const M365RANGE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

// ============================================
// Regola preparata per un DTSTART (dateutil rrule.__init__)
// ============================================

/** Componenti da muro del DTSTART per il motore. */
export interface EngineStart {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface PreparedRule {
  freq: number;
  interval: number;
  wkst: number;
  bysetpos: number[] | null;
  bymonth: Set<number> | null;
  byyearday: Set<number> | null;
  byweekno: number[] | null;
  bymonthday: Set<number> | null;
  bynmonthday: Set<number> | null;
  byweekday: Set<number> | null;
  bynweekday: Array<[number, number]> | null;
  byhour: Set<number> | null;
  byminute: Set<number> | null;
  bysecond: Set<number> | null;
  /** Secondi del giorno ordinati (solo FREQ ≤ DAILY). */
  timeset: number[] | null;
  start: EngineStart;
  startMs: number;
}

function constructByset(interval: number, start: number, values: number[], base: number): Set<number> {
  const out = new Set<number>();
  const g = gcd(interval, base);
  for (const num of values) {
    if (g === 1 || pmod(num - start, g) === 0) out.add(num);
  }
  if (out.size === 0) throw new RecurRuleError('combinazione di INTERVAL e BYxxx senza istanze');
  return out;
}

function prepareRule(rule: RecurRule, start: EngineStart): PreparedRule {
  const freq = FREQUENCIES.indexOf(rule.freq);
  const interval = rule.interval;
  const startDays = daysFromCivil(start.year, start.month, start.day);
  const startWeekday = weekdayOfDays(startDays);
  let bymonth = rule.bymonth ? [...rule.bymonth] : null;
  let bymonthdayAll = rule.bymonthday ? [...rule.bymonthday] : null;
  let byday = rule.byday ? [...rule.byday] : null;
  if (!(rule.byweekno || rule.byyearday || rule.bymonthday || rule.byday)) {
    if (freq === F_YEARLY) {
      if (!bymonth) bymonth = [start.month];
      bymonthdayAll = [start.day];
    } else if (freq === F_MONTHLY) {
      bymonthdayAll = [start.day];
    } else if (freq === F_WEEKLY) {
      byday = [{ weekday: startWeekday, n: 0 }];
    }
  }
  let bymonthday: Set<number> | null = null;
  let bynmonthday: Set<number> | null = null;
  if (bymonthdayAll) {
    bymonthday = new Set(bymonthdayAll.filter((n) => n > 0));
    bynmonthday = new Set(bymonthdayAll.filter((n) => n < 0));
  }
  let byweekday: Set<number> | null = null;
  let bynweekday: Array<[number, number]> | null = null;
  if (byday) {
    const plain = new Set<number>();
    const nth: Array<[number, number]> = [];
    for (const d of byday) {
      if (!d.n || freq > F_MONTHLY) plain.add(d.weekday);
      else nth.push([d.weekday, d.n]);
    }
    byweekday = plain.size ? plain : null;
    bynweekday = nth.length ? nth : null;
  }
  let byhour: Set<number> | null;
  if (!rule.byhour) byhour = freq < F_HOURLY ? new Set([start.hour]) : null;
  else byhour = freq === F_HOURLY ? constructByset(interval, start.hour, rule.byhour, 24) : new Set(rule.byhour);
  let byminute: Set<number> | null;
  if (!rule.byminute) byminute = freq < F_MINUTELY ? new Set([start.minute]) : null;
  else byminute = freq === F_MINUTELY ? constructByset(interval, start.minute, rule.byminute, 60) : new Set(rule.byminute);
  let bysecond: Set<number> | null;
  if (!rule.bysecond) bysecond = freq < F_SECONDLY ? new Set([Math.min(start.second, 59)]) : null;
  else bysecond = freq === F_SECONDLY ? constructByset(interval, Math.min(start.second, 59), rule.bysecond, 60) : new Set(rule.bysecond);
  let timeset: number[] | null = null;
  if (freq < F_HOURLY) {
    const ts: number[] = [];
    for (const h of byhour as Set<number>) {
      for (const m of byminute as Set<number>) {
        for (const s of bysecond as Set<number>) ts.push(h * 3600 + m * 60 + s);
      }
    }
    timeset = ts.sort((a, b) => a - b);
  }
  return {
    freq,
    interval,
    wkst: rule.wkst,
    bysetpos: rule.bysetpos,
    bymonth: bymonth ? new Set(bymonth) : null,
    byyearday: rule.byyearday ? new Set(rule.byyearday) : null,
    byweekno: rule.byweekno,
    bymonthday,
    bynmonthday,
    byweekday,
    bynweekday,
    byhour,
    byminute,
    bysecond,
    timeset,
    start,
    startMs: startDays * DAY_MS + (start.hour * 3600 + start.minute * 60 + Math.min(start.second, 59)) * SECOND_MS,
  };
}

// ============================================
// IterInfo (dateutil): maschere dell'anno corrente
// ============================================

class IterInfo {
  private lastYear = Number.NaN;
  private lastMonth = Number.NaN;
  yearlen = 365;
  nextyearlen = 365;
  /** Giorni dall'epoca del 1° gennaio. */
  yearordinal = 0;
  yearweekday = 0;
  mmask: number[] = M365MASK;
  mdaymask: number[] = MDAY365MASK;
  nmdaymask: number[] = NMDAY365MASK;
  mrange: number[] = M365RANGE;
  wnomask: Uint8Array | null = null;
  nwdaymask: Uint8Array | null = null;

  constructor(private readonly r: PreparedRule) {}

  wday(i: number): number {
    return pmod(this.yearweekday + i, 7);
  }

  rebuild(year: number, month: number): void {
    const r = this.r;
    if (year !== this.lastYear) {
      this.yearlen = isLeap(year) ? 366 : 365;
      this.nextyearlen = isLeap(year + 1) ? 366 : 365;
      this.yearordinal = daysFromCivil(year, 1, 1);
      this.yearweekday = weekdayOfDays(this.yearordinal);
      if (this.yearlen === 365) {
        this.mmask = M365MASK;
        this.mdaymask = MDAY365MASK;
        this.nmdaymask = NMDAY365MASK;
        this.mrange = M365RANGE;
      } else {
        this.mmask = M366MASK;
        this.mdaymask = MDAY366MASK;
        this.nmdaymask = NMDAY366MASK;
        this.mrange = M366RANGE;
      }
      if (!r.byweekno) {
        this.wnomask = null;
      } else {
        const wn = new Uint8Array(this.yearlen + 8);
        let no1wkst = pmod(7 - this.yearweekday + r.wkst, 7);
        const firstwkst = no1wkst;
        let wyearlen: number;
        if (no1wkst >= 4) {
          no1wkst = 0;
          wyearlen = this.yearlen + pmod(this.yearweekday - r.wkst, 7);
        } else {
          wyearlen = this.yearlen - no1wkst;
        }
        const numweeks = Math.floor(wyearlen / 7) + Math.floor((wyearlen % 7) / 4);
        for (const raw of r.byweekno) {
          let n = raw;
          if (n < 0) n += numweeks + 1;
          if (!(n > 0 && n <= numweeks)) continue;
          let i: number;
          if (n > 1) {
            i = no1wkst + (n - 1) * 7;
            if (no1wkst !== firstwkst) i -= 7 - firstwkst;
          } else {
            i = no1wkst;
          }
          for (let j = 0; j < 7; j++) {
            wn[i] = 1;
            i++;
            if (this.wday(i) === r.wkst) break;
          }
        }
        if (r.byweekno.includes(1)) {
          // Settimana 1 dell'anno successivo.
          let i = no1wkst + numweeks * 7;
          if (no1wkst !== firstwkst) i -= 7 - firstwkst;
          if (i < this.yearlen) {
            for (let j = 0; j < 7; j++) {
              wn[i] = 1;
              i++;
              if (this.wday(i) === r.wkst) break;
            }
          }
        }
        if (no1wkst) {
          // Ultima settimana dell'anno precedente.
          let lnumweeks: number;
          if (!r.byweekno.includes(-1)) {
            const lyearweekday = weekdayOfDays(daysFromCivil(year - 1, 1, 1));
            let lno1wkst = pmod(7 - lyearweekday + r.wkst, 7);
            const lyearlen = isLeap(year - 1) ? 366 : 365;
            if (lno1wkst >= 4) {
              lno1wkst = 0;
              lnumweeks = 52 + Math.floor(((lyearlen + pmod(lyearweekday - r.wkst, 7)) % 7) / 4);
            } else {
              lnumweeks = 52 + Math.floor(((this.yearlen - no1wkst) % 7) / 4);
            }
          } else {
            lnumweeks = -1;
          }
          if (r.byweekno.includes(lnumweeks)) {
            for (let i = 0; i < no1wkst; i++) wn[i] = 1;
          }
        }
        this.wnomask = wn;
      }
    }
    if (r.bynweekday && (month !== this.lastMonth || year !== this.lastYear)) {
      const ranges: Array<[number, number]> = [];
      if (r.freq === F_YEARLY) {
        if (r.bymonth) {
          for (const m of [...r.bymonth].sort((a, b) => a - b)) ranges.push([this.mrange[m - 1], this.mrange[m]]);
        } else {
          ranges.push([0, this.yearlen]);
        }
      } else if (r.freq === F_MONTHLY) {
        ranges.push([this.mrange[month - 1], this.mrange[month]]);
      }
      if (ranges.length) {
        const nw = new Uint8Array(this.yearlen);
        for (const [first, end] of ranges) {
          const last = end - 1;
          for (const [wday, n] of r.bynweekday) {
            let i: number;
            if (n < 0) {
              i = last + (n + 1) * 7;
              i -= pmod(this.wday(i) - wday, 7);
            } else {
              i = first + (n - 1) * 7;
              i += pmod(7 - this.wday(i) + wday, 7);
            }
            if (first <= i && i <= last) nw[i] = 1;
          }
        }
        this.nwdaymask = nw;
      }
    }
    this.lastYear = year;
    this.lastMonth = month;
  }
}

// ============================================
// RuleIterator (dateutil rrule._iter)
// ============================================

/**
 * Istanze di una regola in ore da muro (ms dell'orologio senza fuso),
 * crescenti, tutte ≥ DTSTART. Non applica UNTIL né COUNT (li applica Series)
 * e non aggiunge DTSTART se non soddisfa la regola.
 */
export class RuleIterator {
  private readonly r: PreparedRule;
  private readonly ii: IterInfo;
  private year: number;
  private month: number;
  private day: number;
  private hour: number;
  private minute: number;
  private second: number;
  private weekday: number;
  private timeset: number[];
  private buffer: number[] = [];
  private bufferPos = 0;
  private started = false;
  /** True quando la regola non ha più istanze (fine dell'anno 9999). */
  finished = false;

  constructor(rule: RecurRule, start: EngineStart, private readonly budget: ExpansionBudget) {
    this.r = prepareRule(rule, start);
    this.ii = new IterInfo(this.r);
    this.year = start.year;
    this.month = start.month;
    this.day = start.day;
    this.hour = start.hour;
    this.minute = start.minute;
    this.second = Math.min(start.second, 59);
    this.weekday = weekdayOfDays(daysFromCivil(start.year, start.month, start.day));
    this.timeset = [];
    this.ii.rebuild(this.year, this.month);
    this.initTimeset();
  }

  private initTimeset(): void {
    const r = this.r;
    if (r.freq < F_HOURLY) {
      this.timeset = r.timeset as number[];
      return;
    }
    if (
      (r.freq >= F_HOURLY && r.byhour && !r.byhour.has(this.hour)) ||
      (r.freq >= F_MINUTELY && r.byminute && !r.byminute.has(this.minute)) ||
      (r.freq >= F_SECONDLY && r.bysecond && !r.bysecond.has(this.second))
    ) {
      this.timeset = [];
    } else {
      this.timeset = this.subDailyTimeset();
    }
  }

  private subDailyTimeset(): number[] {
    const r = this.r;
    const base = this.hour * 3600;
    if (r.freq === F_HOURLY) {
      const out: number[] = [];
      for (const m of r.byminute as Set<number>) for (const s of r.bysecond as Set<number>) out.push(base + m * 60 + s);
      return out.sort((a, b) => a - b);
    }
    if (r.freq === F_MINUTELY) {
      const out: number[] = [];
      for (const s of r.bysecond as Set<number>) out.push(base + this.minute * 60 + s);
      return out.sort((a, b) => a - b);
    }
    return [base + this.minute * 60 + this.second];
  }

  /**
   * Fast-forward esatto al periodo che contiene `targetMs` (ora da muro), o
   * al più vicino precedente sulla griglia di INTERVAL. Da chiamare prima di
   * next(); solo per regole senza COUNT (il chiamante lo garantisce). Un
   * bersaglio nel periodo di DTSTART (o prima) non sposta nulla.
   */
  seek(targetMs: number): void {
    if (this.started || targetMs <= this.r.startMs) return;
    const r = this.r;
    const s = r.start;
    const target = msToWall(targetMs);
    const targetDays = Math.floor(targetMs / DAY_MS);
    this.budget.spend(1);
    switch (r.freq) {
      case F_YEARLY: {
        const k = Math.floor((target.year - s.year) / r.interval);
        if (k <= 0) return;
        this.year = s.year + k * r.interval;
        this.month = s.month;
        this.day = s.day;
        break;
      }
      case F_MONTHLY: {
        const m0 = s.year * 12 + (s.month - 1);
        const mt = target.year * 12 + (target.month - 1);
        const k = Math.floor((mt - m0) / r.interval);
        if (k <= 0) return;
        const idx = m0 + k * r.interval;
        this.year = Math.floor(idx / 12);
        this.month = (idx % 12) + 1;
        this.day = s.day;
        break;
      }
      case F_WEEKLY: {
        const sd = daysFromCivil(s.year, s.month, s.day);
        const weekStart = sd - pmod(weekdayOfDays(sd) - r.wkst, 7);
        const k = Math.floor((targetDays - weekStart) / (7 * r.interval));
        if (k <= 0) return;
        const d = civilFromDays(weekStart + k * 7 * r.interval);
        this.year = d.year;
        this.month = d.month;
        this.day = d.day;
        this.weekday = r.wkst;
        break;
      }
      case F_DAILY: {
        const sd = daysFromCivil(s.year, s.month, s.day);
        const k = Math.floor((targetDays - sd) / r.interval);
        if (k <= 0) return;
        const d = civilFromDays(sd + k * r.interval);
        this.year = d.year;
        this.month = d.month;
        this.day = d.day;
        this.weekday = weekdayOfDays(sd + k * r.interval);
        break;
      }
      default: {
        const unit = r.freq === F_HOURLY ? HOUR_MS : r.freq === F_MINUTELY ? MINUTE_MS : SECOND_MS;
        const k = Math.floor((targetMs - r.startMs) / (unit * r.interval));
        if (k <= 0) return;
        const w = msToWall(r.startMs + k * r.interval * unit);
        this.year = w.year;
        this.month = w.month;
        this.day = w.day;
        this.hour = w.hour;
        this.minute = w.minute;
        this.second = w.second;
        this.weekday = weekdayOfDays(Math.floor((r.startMs + k * r.interval * unit) / DAY_MS));
        break;
      }
    }
    if (this.year > MAX_YEAR) {
      this.finished = true;
      return;
    }
    this.ii.rebuild(this.year, this.month);
    this.initTimeset();
  }

  /** Inizio (ora da muro) del periodo che il prossimo passo elaborerà. */
  private periodStartMs(): number {
    const r = this.r;
    switch (r.freq) {
      case F_YEARLY:
        return this.ii.yearordinal * DAY_MS;
      case F_MONTHLY:
        return (this.ii.yearordinal + this.ii.mrange[this.month - 1]) * DAY_MS;
      case F_WEEKLY:
      case F_DAILY:
        return daysFromCivil(this.year, this.month, this.day) * DAY_MS;
      case F_HOURLY:
        return daysFromCivil(this.year, this.month, this.day) * DAY_MS + this.hour * HOUR_MS;
      case F_MINUTELY:
        return daysFromCivil(this.year, this.month, this.day) * DAY_MS + this.hour * HOUR_MS + this.minute * MINUTE_MS;
      default:
        return daysFromCivil(this.year, this.month, this.day) * DAY_MS + (this.hour * 3600 + this.minute * 60 + this.second) * SECOND_MS;
    }
  }

  /**
   * Prossima istanza (ora da muro, ms) o null: con `finished` la regola è
   * finita, altrimenti il prossimo periodo inizia oltre `limitMs`.
   */
  next(limitMs: number): number | null {
    this.started = true;
    while (this.bufferPos >= this.buffer.length) {
      if (this.finished) return null;
      if (this.periodStartMs() > limitMs) return null;
      this.buffer = [];
      this.bufferPos = 0;
      this.budget.spend(1);
      this.step();
    }
    return this.buffer[this.bufferPos++];
  }

  /** Un periodo: insieme dei giorni, filtri, BYSETPOS, poi avanzamento (dateutil). */
  private step(): void {
    const r = this.r;
    const ii = this.ii;
    // Giorni candidati del periodo (indici dal 1° gennaio dell'anno corrente).
    let days: number[];
    switch (r.freq) {
      case F_YEARLY:
        days = range(0, ii.yearlen);
        break;
      case F_MONTHLY:
        days = range(ii.mrange[this.month - 1], ii.mrange[this.month]);
        break;
      case F_WEEKLY: {
        days = [];
        let i = daysFromCivil(this.year, this.month, this.day) - ii.yearordinal;
        for (let j = 0; j < 7; j++) {
          days.push(i);
          i++;
          if (ii.wday(i) === r.wkst) break;
        }
        break;
      }
      default:
        days = [daysFromCivil(this.year, this.month, this.day) - ii.yearordinal];
        break;
    }
    let filtered = false;
    const valid: number[] = [];
    const nwdaymask = r.bynweekday ? ii.nwdaymask : null;
    for (const i of days) {
      if (
        (r.bymonth && !r.bymonth.has(ii.mmask[i])) ||
        (r.byweekno && !(ii.wnomask as Uint8Array)[i]) ||
        // BYDAY: giorno semplice OPPURE ordinale (unione, RFC 5545); dateutil
        // e rrule.js richiedono entrambi e una regola mista non ha istanze.
        ((r.byweekday || nwdaymask) && !(r.byweekday?.has(ii.wday(i)) || nwdaymask?.[i])) ||
        ((r.bymonthday || r.bynmonthday) &&
          !(r.bymonthday as Set<number>).has(ii.mdaymask[i]) &&
          !(r.bynmonthday as Set<number>).has(ii.nmdaymask[i])) ||
        (r.byyearday &&
          ((i < ii.yearlen && !r.byyearday.has(i + 1) && !r.byyearday.has(-ii.yearlen + i)) ||
            (i >= ii.yearlen && !r.byyearday.has(i + 1 - ii.yearlen) && !r.byyearday.has(-ii.nextyearlen + i - ii.yearlen))))
      ) {
        filtered = true;
      } else {
        valid.push(i);
      }
    }
    const timeset = this.timeset;
    if (r.bysetpos && timeset.length) {
      const poslist: number[] = [];
      for (const pos of r.bysetpos) {
        let daypos: number;
        let timepos: number;
        if (pos < 0) {
          daypos = Math.floor(pos / timeset.length);
          timepos = pmod(pos, timeset.length);
        } else {
          daypos = Math.floor((pos - 1) / timeset.length);
          timepos = (pos - 1) % timeset.length;
        }
        const idx = daypos < 0 ? valid.length + daypos : daypos;
        if (idx < 0 || idx >= valid.length) continue;
        const res = (ii.yearordinal + valid[idx]) * DAY_MS + timeset[timepos] * SECOND_MS;
        if (!poslist.includes(res)) poslist.push(res);
      }
      poslist.sort((a, b) => a - b);
      if (poslist.length > 1) this.budget.spend(poslist.length - 1);
      for (const res of poslist) if (res >= r.startMs) this.buffer.push(res);
    } else {
      // Il periodo costa quanto le istanze che produce (almeno una iterazione,
      // già spesa da next): il buffer non supera mai il budget, anche con
      // regole come YEARLY;BYHOUR=0,...,23;BYMINUTE=0,...,59 (milioni di
      // istanze per periodo).
      const produced = valid.length * timeset.length;
      if (produced > 1) this.budget.spend(produced - 1);
      for (const i of valid) {
        const base = (ii.yearordinal + i) * DAY_MS;
        for (const t of timeset) {
          const res = base + t * SECOND_MS;
          if (res >= r.startMs) this.buffer.push(res);
        }
      }
    }
    this.advance(filtered);
  }

  private modDistance(value: number, set: Set<number>, base: number): [number, number] {
    let acc = 0;
    let v = value;
    for (let k = 1; k <= base; k++) {
      const sum = v + this.r.interval;
      const div = Math.floor(sum / base);
      v = sum - div * base;
      acc += div;
      if (set.has(v)) return [acc, v];
    }
    throw new RecurRuleError('combinazione di INTERVAL e BYxxx senza istanze');
  }

  private advance(filteredIn: boolean): void {
    const r = this.r;
    let filtered = filteredIn;
    let fixday = false;
    switch (r.freq) {
      case F_YEARLY:
        this.year += r.interval;
        if (this.year > MAX_YEAR) {
          this.finished = true;
          return;
        }
        this.ii.rebuild(this.year, this.month);
        break;
      case F_MONTHLY: {
        this.month += r.interval;
        if (this.month > 12) {
          const div = Math.floor(this.month / 12);
          this.month = this.month % 12;
          this.year += div;
          if (this.month === 0) {
            this.month = 12;
            this.year -= 1;
          }
          if (this.year > MAX_YEAR) {
            this.finished = true;
            return;
          }
        }
        this.ii.rebuild(this.year, this.month);
        break;
      }
      case F_WEEKLY:
        if (r.wkst > this.weekday) this.day += -(this.weekday + 1 + (6 - r.wkst)) + r.interval * 7;
        else this.day += -(this.weekday - r.wkst) + r.interval * 7;
        this.weekday = r.wkst;
        fixday = true;
        break;
      case F_DAILY:
        this.day += r.interval;
        fixday = true;
        break;
      case F_HOURLY: {
        if (filtered) this.hour += Math.floor((23 - this.hour) / r.interval) * r.interval;
        let ndays: number;
        if (r.byhour) {
          [ndays, this.hour] = this.modDistance(this.hour, r.byhour, 24);
        } else {
          const sum = this.hour + r.interval;
          ndays = Math.floor(sum / 24);
          this.hour = sum - ndays * 24;
        }
        if (ndays) {
          this.day += ndays;
          fixday = true;
        }
        this.timeset = this.subDailyTimeset();
        break;
      }
      case F_MINUTELY: {
        if (filtered) this.minute += Math.floor((1439 - (this.hour * 60 + this.minute)) / r.interval) * r.interval;
        let valid = false;
        const rep = 1440 / gcd(r.interval, 1440);
        for (let j = 0; j < rep; j++) {
          this.budget.spend(1);
          let nhours: number;
          if (r.byminute) {
            [nhours, this.minute] = this.modDistance(this.minute, r.byminute, 60);
          } else {
            const sum = this.minute + r.interval;
            nhours = Math.floor(sum / 60);
            this.minute = sum - nhours * 60;
          }
          const hsum = this.hour + nhours;
          const div = Math.floor(hsum / 24);
          this.hour = hsum - div * 24;
          if (div) {
            this.day += div;
            fixday = true;
            filtered = false;
          }
          if (!r.byhour || r.byhour.has(this.hour)) {
            valid = true;
            break;
          }
        }
        if (!valid) throw new RecurRuleError('combinazione di INTERVAL e BYHOUR senza istanze');
        this.timeset = this.subDailyTimeset();
        break;
      }
      default: {
        if (filtered) {
          this.second += Math.floor((86399 - (this.hour * 3600 + this.minute * 60 + this.second)) / r.interval) * r.interval;
        }
        let valid = false;
        const rep = 86400 / gcd(r.interval, 86400);
        for (let j = 0; j < rep; j++) {
          this.budget.spend(1);
          let nminutes: number;
          if (r.bysecond) {
            [nminutes, this.second] = this.modDistance(this.second, r.bysecond, 60);
          } else {
            const sum = this.second + r.interval;
            nminutes = Math.floor(sum / 60);
            this.second = sum - nminutes * 60;
          }
          const msum = this.minute + nminutes;
          let div = Math.floor(msum / 60);
          this.minute = msum - div * 60;
          if (div) {
            this.hour += div;
            div = Math.floor(this.hour / 24);
            this.hour -= div * 24;
            if (div) {
              this.day += div;
              fixday = true;
            }
          }
          if (
            (!r.byhour || r.byhour.has(this.hour)) &&
            (!r.byminute || r.byminute.has(this.minute)) &&
            (!r.bysecond || r.bysecond.has(this.second))
          ) {
            valid = true;
            break;
          }
        }
        if (!valid) throw new RecurRuleError('combinazione di INTERVAL e BYxxx senza istanze');
        this.timeset = this.subDailyTimeset();
        break;
      }
    }
    if (fixday && this.day > 28) {
      let dim = monthLength(this.year, this.month);
      if (this.day > dim) {
        while (this.day > dim) {
          this.day -= dim;
          this.month += 1;
          if (this.month === 13) {
            this.month = 1;
            this.year += 1;
            if (this.year > MAX_YEAR) {
              this.finished = true;
              return;
            }
          }
          dim = monthLength(this.year, this.month);
        }
        this.ii.rebuild(this.year, this.month);
      }
    }
  }
}

/** True se DTSTART è un'istanza della regola (non lo è se la regola non è "sincronizzata", RFC 5545). */
export function isStartInRule(rule: RecurRule, start: EngineStart, budget: ExpansionBudget): boolean {
  const it = new RuleIterator(rule, start, budget);
  const startMs = daysFromCivil(start.year, start.month, start.day) * DAY_MS + (start.hour * 3600 + start.minute * 60 + Math.min(start.second, 59)) * SECOND_MS;
  return it.next(startMs) === startMs;
}

// ============================================
// Lettura tollerante del master
// ============================================

/** Durata delle istanze del master (RFC 5545 §3.8.5.3). */
export type InstanceDuration =
  /** All-day: giorni di calendario (DTEND esclusivo o DURATION in giorni). */
  | { kind: 'days'; days: number }
  /** DTEND: la stessa durata esatta per tutte le istanze. */
  | { kind: 'exact'; ms: number }
  /** DURATION: giorni nominali (stessa ora da muro) più parte esatta. */
  | { kind: 'nominal'; days: number; ms: number };

export type MasterFailure = 'invalid-value' | 'invalid-timezone' | 'invalid-rrule';

/** Avvisi della lettura del master (codici di ExpandWarningCode). */
export interface SeriesWarning {
  code:
    | 'MULTIPLE_RRULE'
    | 'EXDATE_TYPE_MISMATCH'
    | 'UNKNOWN_TZID'
    | 'INVALID_EXDATE'
    | 'RDATE_TYPE_MISMATCH'
    | 'UNTIL_TYPE_MISMATCH'
    | 'RRULE_NONSTANDARD'
    | 'MIXED_BYDAY'
    | 'END_BEFORE_START';
  message: string;
}

/** RDATE già tipizzata come il DTSTART, con l'eventuale fine propria (PERIOD). */
export interface SeriesRdate {
  wallMs: number;
  /** Fine esatta (ms UTC) di una RDATE PERIOD; null = durata del master. */
  periodEndUtc: number | null;
}

/** Proprietà del master che servono all'espansione, lette senza eccezioni. */
export interface MasterSpec {
  component: IcsComponent;
  componentType: string;
  dtstart: IcsTime;
  allDay: boolean;
  /** Zona delle ore da muro: quella del DTSTART (DATE e floating: fuso del calendario). */
  zone: ConvertibleZone;
  dtstartWallMs: number;
  dtstartUtcMs: number;
  duration: InstanceDuration;
  /** Valore grezzo della prima RRULE, o null. */
  rruleText: string | null;
  rule: RecurRule | null;
  rdates: SeriesRdate[];
  /** EXDATE come chiavi: istanti al secondo (master DATE-TIME) e date locali 'YYYY-MM-DD'. */
  exdateSeconds: Set<number>;
  exdateDates: Set<string>;
  status: string | null;
  transp: string | null;
  warnings: SeriesWarning[];
}

export type MasterReadResult =
  | { ok: true; spec: MasterSpec }
  | {
      ok: false;
      reason: MasterFailure;
      message: string;
      /** Inizio approssimato per il busy conservativo (ms UTC), se il DTSTART è leggibile. */
      approxStartUtc: number | null;
      /** Fine nota (ms UTC): UNTIL o fine del singolo; null = aperta o ignota. */
      approxEndUtc: number | null;
      recurring: boolean;
      allDay: boolean;
      status: string | null;
      transp: string | null;
      warnings: SeriesWarning[];
    }
  /** VTODO/VJOURNAL senza DTSTART: nessuna occorrenza, non è un errore. */
  | { ok: 'no-start' };

function upperText(c: IcsComponent, name: string): string | null {
  const p = getProperty(c, name);
  if (!p) return null;
  const v = p.value.replace(/\\(.)/g, '$1').trim().toUpperCase();
  return v || null;
}

/** Converte un valore temporale nel tipo e nella zona del DTSTART del master (come recurrenceKeyToTime). */
export function typedLikeStart(t: IcsTime, dtstart: IcsTime, ctx: ZoneContext): IcsTime {
  return recurrenceKeyToTime(recurrenceKeyOf(t, ctx), dtstart, ctx);
}

/** Zona di conversione delle ore da muro di un DTSTART. */
export function zoneOfStart(dtstart: IcsTime, ctx: ZoneContext): { zone: ConvertibleZone; fallback: boolean } {
  if (dtstart.type === 'date') return { zone: ianaZone(ctx.tz), fallback: false };
  return resolveZone(dtstart.zone, { tz: ctx.tz, timezones: ctx.timezones });
}

/** Ora da muro (ms dell'orologio senza fuso) di un valore temporale (DATE: mezzanotte). */
export function wallOfTime(t: IcsTime): number {
  return t.type === 'date'
    ? daysFromCivil(t.year, t.month, t.day) * DAY_MS
    : daysFromCivil(t.year, t.month, t.day) * DAY_MS + (t.hour * 3600 + t.minute * 60 + Math.min(t.second, 59)) * SECOND_MS;
}

/**
 * Legge il master in modo tollerante. Fallimenti (quarantena dell'oggetto,
 * design §6.5): DTSTART assente o illeggibile, DTEND/DUE, DURATION o RDATE
 * illeggibili → 'invalid-value'; VTIMEZONE del DTSTART non interpretabile →
 * 'invalid-timezone'; RRULE non valida (o incompatibile con un DTSTART DATE)
 * → 'invalid-rrule'. Un EXDATE illeggibile viene ignorato con un avviso.
 */
export function readMasterSpec(master: IcsComponent, ctx: ZoneContext): MasterReadResult {
  const warnings: SeriesWarning[] = [];
  const status = upperText(master, 'STATUS');
  const transp = upperText(master, 'TRANSP');
  const rrules = getProperties(master, 'RRULE');
  const recurring = rrules.length > 0 || getProperties(master, 'RDATE').length > 0;
  const fail = (
    reason: MasterFailure,
    message: string,
    extra: { approxStartUtc?: number | null; approxEndUtc?: number | null; allDay?: boolean } = {},
  ): MasterReadResult => ({
    ok: false,
    reason,
    message,
    approxStartUtc: extra.approxStartUtc ?? null,
    approxEndUtc: extra.approxEndUtc ?? null,
    recurring,
    allDay: extra.allDay ?? false,
    status,
    transp,
    warnings,
  });

  const startProp = getProperty(master, 'DTSTART');
  if (!startProp) {
    if (master.name !== 'VEVENT') return { ok: 'no-start' };
    return fail('invalid-value', 'VEVENT senza DTSTART');
  }
  let dtstart: IcsTime;
  try {
    dtstart = readTimeProperty(startProp);
  } catch {
    return fail('invalid-value', 'DTSTART illeggibile');
  }
  const allDay = dtstart.type === 'date';

  // Zona del DTSTART: un VTIMEZONE rotto → istante approssimato nel fuso del calendario (±14 h nel conservativo).
  let zone: ConvertibleZone;
  let dtstartUtcMs: number;
  try {
    const z = zoneOfStart(dtstart, ctx);
    zone = z.zone;
    if (z.fallback && dtstart.type === 'date-time' && dtstart.zone.kind === 'tzid') {
      warnings.push({ code: 'UNKNOWN_TZID', message: `TZID "${dtstart.zone.tzid.slice(0, 60)}" sconosciuto: interpretato nel fuso del calendario` });
    }
    dtstartUtcMs = zonedToUtc(msToWall(wallOfTime(dtstart)), zone);
  } catch {
    let approx: number | null = null;
    try {
      approx = zonedToUtc(msToWall(wallOfTime(dtstart)), ianaZone(ctx.tz));
    } catch {
      approx = null;
    }
    return fail('invalid-timezone', 'VTIMEZONE del DTSTART non interpretabile', {
      approxStartUtc: approx == null ? null : approx - 14 * HOUR_MS,
      approxEndUtc: approx == null || recurring ? null : approx + DAY_MS + 14 * HOUR_MS,
      allDay,
    });
  }
  const dtstartWallMs = wallOfTime(dtstart);

  // Durata.
  const endName = master.name === 'VTODO' ? 'DUE' : 'DTEND';
  let endTime: IcsTime | null = null;
  let durationValue: IcsDuration | null = null;
  try {
    const endProp = getProperty(master, endName);
    if (endProp) endTime = readTimeProperty(endProp);
    const durProp = getProperty(master, 'DURATION');
    if (durProp && !endTime) durationValue = parseDurationValue(durProp.value, 'DURATION');
  } catch {
    return fail('invalid-value', `${endName} o DURATION illeggibili`, {
      approxStartUtc: dtstartUtcMs,
      approxEndUtc: recurring ? null : dtstartUtcMs + (allDay ? DAY_MS : HOUR_MS),
      allDay,
    });
  }
  let duration: InstanceDuration;
  try {
    if (dtstart.type === 'date') {
      const r = allDayRangeFromIcs(dtstart, endTime, durationValue, ctx);
      duration = { kind: 'days', days: Math.max(1, daysBetween(r.start, r.end)) };
    } else if (endTime) {
      let ms = timeToUtcMs(endTime, ctx) - dtstartUtcMs;
      if (ms < 0) {
        warnings.push({ code: 'END_BEFORE_START', message: `${endName} precedente a DTSTART: durata nulla` });
        ms = 0;
      }
      duration = { kind: 'exact', ms };
    } else if (durationValue) {
      const sign = durationValue.negative ? -1 : 1;
      const days = sign * (durationValue.weeks * 7 + durationValue.days);
      const ms = sign * (durationValue.hours * 3600 + durationValue.minutes * 60 + durationValue.seconds) * SECOND_MS;
      if (days < 0 || ms < 0 || (days === 0 && ms === 0 && durationValue.negative)) {
        warnings.push({ code: 'END_BEFORE_START', message: 'DURATION negativa: durata nulla' });
        duration = { kind: 'exact', ms: 0 };
      } else {
        duration = days === 0 ? { kind: 'exact', ms } : { kind: 'nominal', days, ms };
      }
    } else {
      duration = { kind: 'exact', ms: 0 };
    }
  } catch {
    return fail('invalid-timezone', `Fuso di ${endName} non interpretabile`, {
      approxStartUtc: dtstartUtcMs - 14 * HOUR_MS,
      approxEndUtc: recurring ? null : dtstartUtcMs + DAY_MS + 14 * HOUR_MS,
      allDay,
    });
  }

  // RRULE.
  let rule: RecurRule | null = null;
  let rruleText: string | null = null;
  if (rrules.length > 0) {
    rruleText = rrules[0].value.trim();
    if (rrules.length > 1) warnings.push({ code: 'MULTIPLE_RRULE', message: `${rrules.length} RRULE: vale la prima` });
    // Regola non interpretabile: il busy conservativo va dal DTSTART all'UNTIL
    // scritto nel testo (più la durata), se c'è e la serie non ha altre fonti
    // di istanze; altrimenti resta aperto (design §6.5: intervallo noto).
    const text = rruleText;
    const invalidRuleExtent = (): { approxStartUtc: number; approxEndUtc: number | null; allDay: boolean } => ({
      approxStartUtc: dtstartUtcMs,
      approxEndUtc: rrules.length === 1 && getProperties(master, 'RDATE').length === 0
        ? untilEndFromRuleText(text, { zone, allDay, dtstartUtcMs, durationMs: conservativeDurationMs(duration) })
        : null,
      allDay,
    });
    const parsed = parseRecurRule(rruleText);
    if (!parsed.ok) {
      return fail('invalid-rrule', `RRULE non valida: ${parsed.reason}`, invalidRuleExtent());
    }
    rule = parsed.rule;
    const f = FREQUENCIES.indexOf(rule.freq);
    if (allDay && (f >= F_HOURLY || rule.byhour || rule.byminute || rule.bysecond)) {
      return fail('invalid-rrule', 'RRULE oraria su un evento di tutto il giorno', invalidRuleExtent());
    }
    for (const n of parsed.notices) {
      warnings.push({ code: n === 'MIXED_BYDAY' ? 'MIXED_BYDAY' : 'RRULE_NONSTANDARD', message: RRULE_NOTICE_MESSAGES[n] });
    }
    if (rule.until) {
      const mismatch = allDay ? rule.until.type === 'date-time' : rule.until.type === 'date';
      if (mismatch) warnings.push({ code: 'UNTIL_TYPE_MISMATCH', message: allDay ? 'UNTIL con orario su un evento di tutto il giorno' : 'UNTIL senza orario: inclusa tutta la giornata' });
    }
    // Una regola che dateutil rifiuta già in costruzione (BYHOUR irraggiungibile con INTERVAL).
    try {
      prepareRule(rule, startOf(dtstart));
    } catch (err) {
      return fail('invalid-rrule', `RRULE non valida: ${err instanceof Error ? err.message : String(err)}`, invalidRuleExtent());
    }
  }

  // RDATE.
  const rdates: SeriesRdate[] = [];
  try {
    for (const p of getProperties(master, 'RDATE')) {
      for (const v of readTimeListProperty(p)) {
        if (v.type === 'period') {
          const start = typedLikeStart(v.start, dtstart, ctx);
          if (allDay) warnings.push({ code: 'RDATE_TYPE_MISMATCH', message: 'RDATE PERIOD su un evento di tutto il giorno: vale la durata del master' });
          let periodEndUtc: number | null = null;
          if (!allDay) {
            periodEndUtc = periodEnd(v, ctx);
            const s = timeToUtcMs(v.start, ctx);
            if (periodEndUtc < s) periodEndUtc = s;
          }
          rdates.push({ wallMs: wallOfTime(start), periodEndUtc });
        } else {
          if (v.type !== dtstart.type) warnings.push({ code: 'RDATE_TYPE_MISMATCH', message: 'RDATE di tipo diverso da DTSTART' });
          rdates.push({ wallMs: wallOfTime(typedLikeStart(v, dtstart, ctx)), periodEndUtc: null });
        }
      }
    }
  } catch {
    return fail('invalid-value', 'RDATE illeggibile', { approxStartUtc: dtstartUtcMs, allDay });
  }
  rdates.sort((a, b) => a.wallMs - b.wallMs);
  const dedupedRdates = rdates.filter((r, i) => i === 0 || r.wallMs !== rdates[i - 1].wallMs);

  // EXDATE (tolleranti: un valore illeggibile si ignora, quindi più busy).
  const exdateSeconds = new Set<number>();
  const exdateDates = new Set<string>();
  for (const p of getProperties(master, 'EXDATE')) {
    try {
      for (const v of readTimeListProperty(p)) {
        if (v.type === 'period') throw new RecurRuleError('PERIOD in EXDATE');
        if (allDay || v.type === 'date') {
          if (v.type !== dtstart.type) warnings.push({ code: 'EXDATE_TYPE_MISMATCH', message: 'EXDATE di tipo diverso da DTSTART: confronto sulla data locale' });
          exdateDates.add(dateKeyOf(v, ctx));
        } else {
          exdateSeconds.add(Math.floor(timeToUtcMs(v, ctx) / SECOND_MS));
        }
      }
    } catch {
      warnings.push({ code: 'INVALID_EXDATE', message: 'EXDATE illeggibile, ignorata' });
    }
  }

  return {
    ok: true,
    spec: {
      component: master,
      componentType: master.name,
      dtstart,
      allDay,
      zone,
      dtstartWallMs,
      dtstartUtcMs,
      duration,
      rruleText,
      rule,
      rdates: dedupedRdates,
      exdateSeconds,
      exdateDates,
      status,
      transp,
      warnings: dedupeWarnings(warnings),
    },
  };
}

/** Durata di un'istanza per il busy conservativo (come Series.maxDurationMs, senza RDATE PERIOD). */
function conservativeDurationMs(d: InstanceDuration): number {
  return d.kind === 'days' ? d.days * DAY_MS + 3 * HOUR_MS : d.kind === 'exact' ? d.ms : d.days * DAY_MS + d.ms + 3 * HOUR_MS;
}

/**
 * Fine (ms UTC, esclusiva) del busy conservativo di una serie con RRULE non
 * interpretabile, dall'UNTIL letto in modo tollerante nel testo della regola
 * (come conservativeRangeFromText di expand.ts per i testi che non si
 * parsano): UNTIL con 'Z' in UTC, senza nella zona del DTSTART, DATE fino alla
 * fine della giornata locale; più la durata dell'istanza, e mai prima della
 * fine dell'istanza del DTSTART. null se UNTIL manca, compare più volte o non
 * si legge: il blocco resta aperto.
 */
export function untilEndFromRuleText(
  text: string,
  opts: { zone: ConvertibleZone; allDay: boolean; dtstartUtcMs: number; durationMs: number },
): number | null {
  const parts = text.split(';').map((p) => p.trim()).filter((p) => /^UNTIL\s*=/i.test(p));
  if (parts.length !== 1) return null;
  const m = /^UNTIL\s*=\s*(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(parts[0]);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  try {
    let untilUtc: number;
    if (m[4] === undefined) {
      // DATE: inclusa tutta la giornata locale di UNTIL.
      untilUtc = zonedToUtc(msToWall((daysFromCivil(year, month, day) + 1) * DAY_MS), opts.zone);
    } else {
      const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6])];
      if (hour > 23 || minute > 59 || second > 60) return null;
      const wall = daysFromCivil(year, month, day) * DAY_MS + (hour * 3600 + minute * 60 + Math.min(second, 59)) * SECOND_MS;
      untilUtc = m[7] ? wall : zonedToUtc(msToWall(wall), opts.zone);
    }
    if (!Number.isFinite(untilUtc)) return null;
    return Math.max(untilUtc + opts.durationMs, opts.dtstartUtcMs + Math.max(opts.durationMs, SECOND_MS));
  } catch {
    return null;
  }
}

const RRULE_NOTICE_MESSAGES: Record<RecurNotice, string> = {
  PART_IGNORED: 'RRULE: parti X-, RSCALE=GREGORIAN o SKIP=OMIT ignorate',
  ORDINAL_IGNORED: 'RRULE: ordinale in BYDAY ignorato (FREQ diversa da MONTHLY e YEARLY)',
  NONSTANDARD_COMBINATION: 'RRULE: combinazione di parti vietata da RFC 5545, applicata come filtro',
  COUNT_AND_UNTIL: 'RRULE: COUNT e UNTIL insieme, valgono entrambi',
  LEAP_SECOND: 'RRULE: BYSECOND=60 trattato come 59',
  MIXED_BYDAY: 'RRULE: BYDAY con giorni semplici e ordinali, vale l\'unione (RFC 5545); il calendario legacy e dateutil non ne mostrano le occorrenze',
};

function dedupeWarnings(list: SeriesWarning[]): SeriesWarning[] {
  const seen = new Set<string>();
  return list.filter((w) => {
    const k = `${w.code}|${w.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function periodEnd(p: IcsPeriod, ctx: ZoneContext): number {
  if (p.end) return timeToUtcMs(p.end, ctx);
  const d = p.duration as IcsDuration;
  const sign = d.negative ? -1 : 1;
  const days = sign * (d.weeks * 7 + d.days);
  const exact = sign * (d.hours * 3600 + d.minutes * 60 + d.seconds) * SECOND_MS;
  const z = resolveZone(p.start.zone, { tz: ctx.tz, timezones: ctx.timezones }).zone;
  const wall = wallOfTime(p.start) + days * DAY_MS;
  return zonedToUtc(msToWall(wall), z) + exact;
}

/** Data locale 'YYYY-MM-DD' di un valore temporale per gli abbinamenti (design §6.4): DATE → la data; floating → la data da muro; altrimenti la data locale nel fuso del calendario. */
export function dateKeyOf(t: IcsTime, ctx: ZoneContext): string {
  if (t.type === 'date' || t.zone.kind === 'floating') return icsDateToString({ type: 'date', year: t.year, month: t.month, day: t.day });
  return localDateOf(timeToUtcMs(t, ctx), ctx.tz);
}

/** Componenti da muro del DTSTART per il motore (DATE: mezzanotte). */
export function startOf(dtstart: IcsTime): EngineStart {
  return dtstart.type === 'date'
    ? { year: dtstart.year, month: dtstart.month, day: dtstart.day, hour: 0, minute: 0, second: 0 }
    : { year: dtstart.year, month: dtstart.month, day: dtstart.day, hour: dtstart.hour, minute: dtstart.minute, second: Math.min(dtstart.second, 59) };
}

// ============================================
// Series: DTSTART ∪ RRULE ∪ RDATE con UNTIL e COUNT
// ============================================

/** Un'istanza della serie (prima di EXDATE e override). */
export interface SeriesInstance {
  /** Ora da muro nella zona del DTSTART (DATE: mezzanotte della data). */
  wallMs: number;
  /** Istante (DATE: mezzanotte locale nel fuso del calendario). */
  utcMs: number;
  /** Indice in spec.rdates se l'istanza viene solo da una RDATE, altrimenti -1. */
  rdate: number;
}

/** Esito di una scansione: `completed` = la serie non ha istanze oltre l'ultima restituita. */
export interface ScanState {
  completed: boolean;
}

/** Finestra (ora da muro) in cui due istanze possono coincidere per un cambio d'ora: copre anche i salti di 24 h. */
const DEDUPE_WALL_MS = 26 * HOUR_MS;

/** Margine fra ore da muro e istanti nelle scansioni (cambi d'ora, anche quelli di 24 h). */
export function scanMarginMs(spec: MasterSpec): number {
  const f = spec.rule ? FREQUENCIES.indexOf(spec.rule.freq) : F_DAILY;
  // Per le regole al minuto o al secondo un margine di due giorni costerebbe migliaia di istanze:
  // 3 ore coprono ogni cambio d'ora reale (i salti di 24 h di Samoa e Kwajalein sono storici).
  return f >= F_MINUTELY ? 3 * HOUR_MS : 2 * DAY_MS;
}

export class Series {
  readonly spec: MasterSpec;
  private readonly budget: ExpansionBudget;
  /** Fine della parte RRULE in ora da muro (inclusa), o null. */
  private readonly untilWall: number | null;
  /** UNTIL in UTC (confronto sull'istante), o null. */
  readonly untilUtc: number | null;
  /** Limite superiore (ms UTC) dell'inizio dell'ultima istanza della RRULE, o null se illimitata. */
  readonly untilUpperUtc: number | null;
  private readonly calendarZone: ConvertibleZone;
  /** Fuso del calendario (date locali delle EXDATE DATE su un master DATE-TIME). */
  readonly tz: string;

  constructor(spec: MasterSpec, ctx: ZoneContext, budget: ExpansionBudget) {
    this.spec = spec;
    this.budget = budget;
    this.tz = ctx.tz;
    this.calendarZone = ianaZone(ctx.tz);
    let untilWall: number | null = null;
    let untilUtc: number | null = null;
    let upper: number | null = null;
    const u = spec.rule?.until ?? null;
    if (u) {
      if (spec.allDay) {
        if (u.type === 'date') {
          untilWall = wallOfTime(u);
          upper = zonedToUtc(msToWall(untilWall), this.calendarZone);
        } else if (u.zone.kind === 'utc') {
          untilUtc = wallOfTime(u);
          untilWall = this.wallOf(untilUtc) + 2 * DAY_MS;
          upper = untilUtc;
        } else {
          untilWall = wallOfTime(u);
          upper = zonedToUtc(msToWall(untilWall), this.calendarZone);
        }
      } else if (u.type === 'date') {
        // Inclusa tutta la giornata locale di UNTIL.
        untilWall = wallOfTime(u) + DAY_MS - SECOND_MS;
        upper = zonedToUtc(msToWall(untilWall), spec.zone) + 3 * HOUR_MS;
      } else if (u.zone.kind === 'utc') {
        untilUtc = wallOfTime(u);
        untilWall = this.wallOf(untilUtc) + 2 * DAY_MS;
        upper = untilUtc;
      } else {
        untilWall = wallOfTime(u);
        upper = zonedToUtc(msToWall(untilWall), spec.zone) + 3 * HOUR_MS;
      }
    }
    this.untilWall = untilWall;
    this.untilUtc = untilUtc;
    this.untilUpperUtc = upper;
  }

  /** True se la RRULE consente il fast-forward (nessun COUNT). */
  get canSeek(): boolean {
    return Boolean(this.spec.rule) && this.spec.rule?.count == null;
  }

  /** True se la serie ha una fine (nessuna RRULE, oppure UNTIL o COUNT). */
  get bounded(): boolean {
    const r = this.spec.rule;
    return !r || r.count != null || r.until != null;
  }

  /** Ora da muro (ms) di un istante nella zona delle istanze. */
  wallOf(utcMs: number): number {
    const z = this.spec.allDay ? this.calendarZone : this.spec.zone;
    return wallToMs(utcToZoned(utcMs, z));
  }

  /** Istante di un'ora da muro della serie. */
  utcOf(wallMs: number): number {
    if (this.spec.allDay) return zonedToUtc(msToWall(wallMs), this.calendarZone);
    if (this.spec.zone.kind === 'utc') return wallMs;
    return zonedToUtc(msToWall(wallMs), this.spec.zone);
  }

  /** Valore temporale (tipo e zona del DTSTART) di un'ora da muro. */
  timeOf(wallMs: number): IcsTime {
    const w = msToWall(wallMs);
    const d = this.spec.dtstart;
    if (d.type === 'date') return { type: 'date', year: w.year, month: w.month, day: w.day };
    return { type: 'date-time', year: w.year, month: w.month, day: w.day, hour: w.hour, minute: w.minute, second: w.second, zone: d.zone };
  }

  /** Data 'YYYY-MM-DD' di un'ora da muro (per i master DATE è la data dell'istanza). */
  static wallDate(wallMs: number): string {
    const d = civilFromDays(Math.floor(wallMs / DAY_MS));
    return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
  }

  /** Fine esclusiva (ms UTC) di un'istanza. */
  endUtcOf(inst: SeriesInstance): number {
    if (inst.rdate >= 0) {
      const own = this.spec.rdates[inst.rdate].periodEndUtc;
      if (own != null) return own;
    }
    const d = this.spec.duration;
    if (d.kind === 'days') return this.utcOf(inst.wallMs + d.days * DAY_MS);
    if (d.kind === 'exact') return inst.utcMs + d.ms;
    return this.utcOf(inst.wallMs + d.days * DAY_MS) + d.ms;
  }

  /** Recurrence key di un'istanza (come model.recurrenceKeyOf sul valore tipizzato come il DTSTART). */
  keyOf(inst: SeriesInstance): string {
    const spec = this.spec;
    if (spec.allDay) return Series.wallDate(inst.wallMs).replace(/-/g, '');
    if (spec.dtstart.type === 'date-time' && spec.dtstart.zone.kind === 'floating') return formatTimeValue(this.timeOf(inst.wallMs));
    return formatTimeValue({ type: 'date-time', ...msToWall(Math.floor(inst.utcMs / 1000) * 1000), zone: { kind: 'utc' } });
  }

  /** Identità di un'istanza per gli abbinamenti: istante al secondo (master DATE-TIME) o data (master DATE). */
  idOf(inst: SeriesInstance): number | string {
    return this.spec.allDay ? Series.wallDate(inst.wallMs) : Math.floor(inst.utcMs / 1000);
  }

  /** True se un'EXDATE esclude l'istanza (tollerante al tipo, design §6.4). */
  isExcluded(inst: SeriesInstance): boolean {
    const spec = this.spec;
    if (spec.allDay) return spec.exdateDates.size > 0 && spec.exdateDates.has(Series.wallDate(inst.wallMs));
    if (spec.exdateSeconds.size > 0 && spec.exdateSeconds.has(Math.floor(inst.utcMs / 1000))) return true;
    return spec.exdateDates.size > 0 && spec.exdateDates.has(localDateOf(inst.utcMs, this.tz));
  }

  /** Data di fine esclusiva di un'istanza all-day. */
  endDateOf(inst: SeriesInstance): string {
    const d = this.spec.duration;
    const days = d.kind === 'days' ? d.days : 1;
    return addDays(Series.wallDate(inst.wallMs), days);
  }

  /** Durata massima delle istanze (per i margini delle scansioni). */
  maxDurationMs(): number {
    const d = this.spec.duration;
    let max = d.kind === 'days' ? d.days * DAY_MS + 3 * HOUR_MS : d.kind === 'exact' ? d.ms : d.days * DAY_MS + d.ms + 3 * HOUR_MS;
    for (const r of this.spec.rdates) {
      if (r.periodEndUtc != null) max = Math.max(max, r.periodEndUtc - this.utcOf(r.wallMs));
    }
    return max;
  }

  /** True se DTSTART soddisfa la regola (una sola iterazione del motore). */
  dtstartInRule(): boolean {
    if (!this.spec.rule) return true;
    return isStartInRule(this.spec.rule, startOf(this.spec.dtstart), this.budget);
  }

  /**
   * Istanze in ordine di ora da muro, fino a `limitWall` incluso. Con
   * `seekWall` (solo senza COUNT) la scansione parte dal periodo che contiene
   * quell'ora: tutte le istanze con ora da muro ≥ seekWall ci sono, qualcuna
   * precedente può comparire. Costi sul budget: il motore paga un'iterazione
   * per periodo (o una per istanza prodotta, se sono di più) e ogni RDATE
   * restituita ne costa una; il DTSTART è gratuito. Una HOURLY dal 2010 al
   * 2026 costa quindi circa 145k iterazioni, come stimato dal design (§6.4).
   */
  *instances(seekWall: number | null, limitWall: number, state?: ScanState): Generator<SeriesInstance> {
    const spec = this.spec;
    const rule = spec.rule;
    const count = rule?.count ?? null;
    const seeking = rule != null && count == null && seekWall != null && seekWall > spec.dtstartWallMs;
    let engine: RuleIterator | null = null;
    if (rule) {
      engine = new RuleIterator(rule, startOf(spec.dtstart), this.budget);
      if (seeking) engine.seek(seekWall as number);
    }
    let ruleDone = false;
    let dtstartGiven = false;
    let counted = 0;
    const untilWall = this.untilWall;
    const untilUtc = this.untilUtc;

    /** Prossima istanza della parte RRULE (DTSTART compreso), o null (finita o oltre il limite). */
    const nextRule = (): { wall: number; utc: number } | null => {
      if (ruleDone) return null;
      if (!dtstartGiven) {
        dtstartGiven = true;
        if (!rule || !seeking) {
          // DTSTART è sempre la prima istanza e conta per COUNT (RFC 5545).
          if (!rule) ruleDone = true;
          else counted = 1;
          return { wall: spec.dtstartWallMs, utc: spec.dtstartUtcMs };
        }
      }
      if (!engine) {
        ruleDone = true;
        return null;
      }
      for (;;) {
        if (count != null && counted >= count) {
          ruleDone = true;
          return null;
        }
        const w = engine.next(limitWall);
        if (w == null) {
          if (engine.finished) ruleDone = true;
          return null;
        }
        if (w === spec.dtstartWallMs && !seeking) continue; // già restituita come DTSTART
        if (untilWall != null && w > untilWall) {
          ruleDone = true;
          return null;
        }
        const utc = w === spec.dtstartWallMs ? spec.dtstartUtcMs : this.utcOf(w);
        if (untilUtc != null && utc > untilUtc) continue;
        counted++;
        return { wall: w, utc };
      }
    };

    let p = 0;
    if (seeking) {
      // Prima RDATE con ora da muro ≥ seekWall (ricerca binaria).
      let lo = 0;
      let hi = spec.rdates.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (spec.rdates[mid].wallMs < (seekWall as number)) lo = mid + 1;
        else hi = mid;
      }
      p = lo;
    }
    // Nel buco del passaggio all'ora legale due ore da muro diverse diventano
    // lo stesso istante (02:30 inesistente → offset precedente → come le
    // 03:30): l'insieme delle ricorrenze è un insieme di istanti (RFC 5545),
    // quindi il doppione si scarta e resta la prima. Solo per le serie con
    // chiave sull'istante (DATE-TIME con zona): gli all-day e i floating hanno
    // chiavi sull'ora da muro, già uniche.
    const dedupe = !spec.allDay && !(spec.dtstart.type === 'date-time' && spec.dtstart.zone.kind === 'floating');
    const recentWall: number[] = [];
    const recentUtc: number[] = [];
    let recentHead = 0;
    const seen = new Set<number>();
    const duplicate = (wall: number, utc: number): boolean => {
      if (!dedupe) return false;
      while (recentHead < recentWall.length && recentWall[recentHead] < wall - DEDUPE_WALL_MS) {
        seen.delete(recentUtc[recentHead]);
        recentHead++;
      }
      if (recentHead > 1024 && recentHead * 2 > recentWall.length) {
        recentWall.splice(0, recentHead);
        recentUtc.splice(0, recentHead);
        recentHead = 0;
      }
      if (seen.has(utc)) return true;
      seen.add(utc);
      recentWall.push(wall);
      recentUtc.push(utc);
      return false;
    };

    let r = nextRule();
    if (r && r.wall > limitWall) r = null;
    for (;;) {
      const rd = p < spec.rdates.length && spec.rdates[p].wallMs <= limitWall ? spec.rdates[p] : null;
      if (!r && !rd) break;
      if (rd && (!r || rd.wallMs < r.wall)) {
        this.budget.spend(1);
        const index = p;
        p++;
        const utc = this.utcOf(rd.wallMs);
        if (!duplicate(rd.wallMs, utc)) yield { wallMs: rd.wallMs, utcMs: utc, rdate: index };
        continue;
      }
      if (rd && r && rd.wallMs === r.wall) p++;
      const cur = r as { wall: number; utc: number };
      // Le istanze della regola le ha già pagate il motore (periodo o istanza prodotta).
      if (!duplicate(cur.wall, cur.utc)) yield { wallMs: cur.wall, utcMs: cur.utc, rdate: -1 };
      r = nextRule();
      if (r && r.wall > limitWall) r = null;
    }
    if (state) state.completed = ruleDone && p >= spec.rdates.length;
  }
}

/** Valore UNTIL per una RRULE riscritta (RFC 5545: DATE per i master DATE, UTC per i DATE-TIME con zona, floating per i floating). */
export function formatUntil(t: IcsTime): string {
  const date = `${String(t.year).padStart(4, '0')}${String(t.month).padStart(2, '0')}${String(t.day).padStart(2, '0')}`;
  if (t.type === 'date') return date;
  const time = `${String(t.hour).padStart(2, '0')}${String(t.minute).padStart(2, '0')}${String(Math.min(t.second, 59)).padStart(2, '0')}`;
  return `${date}T${time}${t.zone.kind === 'utc' ? 'Z' : ''}`;
}
