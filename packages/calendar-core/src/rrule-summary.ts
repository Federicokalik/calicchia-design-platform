/**
 * Riepilogo in italiano di una RRULE (F6, contratto f6-modules.md §5.5):
 * "Ogni 2 settimane il lunedì e il giovedì, fino al 31 dicembre 2026".
 *
 * Funzione pura e senza ical.js: legge la regola con il parser del motore
 * (recur.ts) e la descrive. Una regola non interpretabile, o con parti che il
 * riepilogo non sa descrivere (BYHOUR, BYYEARDAY, BYWEEKNO, combinazioni
 * insolite di BYSETPOS...), diventa "Ricorrenza personalizzata (<RRULE>)":
 * mai un riepilogo sbagliato. Il riepilogo serve all'anteprima dell'editor e
 * non sostituisce la regola, che resta quella del testo.
 */

import { localDateOf } from './allday';
import type { IcsTime } from './model';
import { daysFromCivil, type RecurByDay, type RecurRule, parseRecurRule, weekdayOfDays } from './recur';
import { DEFAULT_TZ } from './tz-registry';

const MONTHS = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
] as const;

/** 0 = lunedì (come il motore). */
const WEEKDAYS = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'] as const;
const WEEKDAYS_PLURAL = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabati', 'domeniche'] as const;
const SUNDAY = 6;

/** Ordinali maschili e femminili (la domenica è femminile). */
const ORDINALS_M: Readonly<Record<number, string>> = { 1: 'primo', 2: 'secondo', 3: 'terzo', 4: 'quarto', 5: 'quinto', [-1]: 'ultimo', [-2]: 'penultimo' };
const ORDINALS_F: Readonly<Record<number, string>> = { 1: 'prima', 2: 'seconda', 3: 'terza', 4: 'quarta', 5: 'quinta', [-1]: 'ultima', [-2]: 'penultima' };

/** Segnala una regola che il riepilogo non sa descrivere. */
class Undescribable extends Error {}

function fail(): never {
  throw new Undescribable();
}

/** Elenco in italiano: "a", "a e b", "a, b e c". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

/** "il lunedì" / "la domenica". */
function weekdayWithArticle(weekday: number): string {
  return `${weekday === SUNDAY ? 'la' : 'il'} ${WEEKDAYS[weekday]}`;
}

/** "1°" per il primo del mese nelle date complete, altrimenti il numero. */
function dayNumber(day: number): string {
  return day === 1 ? '1°' : String(day);
}

function formatDate(year: number, month: number, day: number): string {
  return `${dayNumber(day)} ${MONTHS[month - 1]} ${year}`;
}

/** Giorni della settimana ordinati e senza duplicati, dai BYDAY (ordinali ignorati). */
function plainWeekdays(byday: readonly RecurByDay[]): number[] {
  return [...new Set(byday.map((d) => d.weekday))].sort((a, b) => a - b);
}

/** "dal lunedì al venerdì" per una sequenza di 3 o più giorni consecutivi, altrimenti l'elenco. */
function weekdaysPhrase(days: readonly number[]): string {
  if (days.length >= 3 && days.every((d, i) => i === 0 || d === days[i - 1] + 1)) {
    return `dal ${WEEKDAYS[days[0]]} al ${WEEKDAYS[days[days.length - 1]]}`;
  }
  return joinList(days.map(weekdayWithArticle));
}

function isWorkdays(days: readonly number[]): boolean {
  return days.length === 5 && days.every((d, i) => d === i);
}

/** "il primo lunedì", "l'ultima domenica". */
function ordinalWeekday(n: number, weekday: number): string {
  const feminine = weekday === SUNDAY;
  const ordinal = (feminine ? ORDINALS_F : ORDINALS_M)[n];
  if (!ordinal) fail();
  const article = n === -1 ? "l'" : feminine ? 'la ' : 'il ';
  return `${article}${ordinal} ${WEEKDAYS[weekday]}`;
}

/** Giorno del mese come ordinale ("il giorno 15", "l'ultimo giorno del mese"). */
function monthDaysPhrase(days: readonly number[]): string {
  const sorted = [...days].sort((a, b) => (a < 0 ? 1 : 0) - (b < 0 ? 1 : 0) || Math.abs(a) - Math.abs(b));
  const parts: string[] = [];
  const positive = sorted.filter((d) => d > 0);
  if (positive.length) parts.push(`il giorno ${joinList(positive.map(String))}`);
  for (const d of sorted.filter((v) => v < 0)) {
    if (d === -1) parts.push("l'ultimo giorno del mese");
    else if (d === -2) parts.push('il penultimo giorno del mese');
    else fail();
  }
  return joinList(parts);
}

/** BYDAY ordinali di MONTHLY e YEARLY ("il primo lunedì e il terzo venerdì"). */
function ordinalDaysPhrase(rule: RecurRule): string | null {
  const byday = rule.byday;
  if (!byday?.length) return null;
  if (byday.every((d) => d.n !== 0)) {
    return joinList(byday.map((d) => ordinalWeekday(d.n, d.weekday)));
  }
  if (byday.some((d) => d.n !== 0)) fail();
  const setpos = rule.bysetpos;
  if (!setpos) return null;
  if (setpos.length !== 1) fail();
  const days = plainWeekdays(byday);
  if (days.length === 1) return ordinalWeekday(setpos[0], days[0]);
  if (isWorkdays(days)) {
    const ordinal = ORDINALS_M[setpos[0]];
    if (!ordinal) fail();
    return `${setpos[0] === -1 ? "l'" : 'il '}${ordinal} giorno feriale`;
  }
  return fail();
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `Ogni ${one}` : `Ogni ${n} ${many}`;
}

/** Parti BY che il riepilogo non descrive mai. */
function assertNoUnsupportedParts(rule: RecurRule, allowed: ReadonlySet<keyof RecurRule>): void {
  const parts: Array<keyof RecurRule> = ['bysecond', 'byminute', 'byhour', 'byday', 'bymonthday', 'byyearday', 'byweekno', 'bymonth', 'bysetpos'];
  for (const p of parts) if (rule[p] != null && !allowed.has(p)) fail();
}

function dtstartWeekday(dtstart: IcsTime): number {
  return weekdayOfDays(daysFromCivil(dtstart.year, dtstart.month, dtstart.day));
}

function describeFrequency(rule: RecurRule, dtstart: IcsTime): string {
  const interval = rule.interval;
  switch (rule.freq) {
    case 'DAILY': {
      assertNoUnsupportedParts(rule, new Set(['byday']));
      if (rule.byday) {
        const days = plainWeekdays(rule.byday);
        if (interval === 1 && isWorkdays(days)) return 'Ogni giorno feriale';
        return `${plural(interval, 'giorno', 'giorni')}, ${weekdaysPhrase(days)}`;
      }
      return plural(interval, 'giorno', 'giorni');
    }
    case 'WEEKLY': {
      assertNoUnsupportedParts(rule, new Set(['byday']));
      const days = rule.byday ? plainWeekdays(rule.byday) : [dtstartWeekday(dtstart)];
      if (days.length === 7) return interval === 1 ? 'Ogni giorno' : `${plural(interval, 'settimana', 'settimane')}, tutti i giorni`;
      if (interval === 1 && isWorkdays(days)) return 'Ogni giorno feriale';
      return `${plural(interval, 'settimana', 'settimane')} ${weekdaysPhrase(days)}`;
    }
    case 'MONTHLY': {
      assertNoUnsupportedParts(rule, new Set(['byday', 'bymonthday', 'bysetpos']));
      const base = plural(interval, 'mese', 'mesi');
      if (rule.bymonthday) {
        if (rule.byday) fail();
        return `${base} ${monthDaysPhrase(rule.bymonthday)}`;
      }
      const ordinal = ordinalDaysPhrase(rule);
      if (ordinal) return `${base} ${ordinal}`;
      if (rule.byday) {
        const days = plainWeekdays(rule.byday);
        return `${base}, tutti ${days.length === 1 && days[0] === SUNDAY ? 'le' : 'i'} ${joinList(days.map((d) => WEEKDAYS_PLURAL[d]))}`;
      }
      if (rule.bysetpos) fail();
      return `${base} il giorno ${dtstart.day}`;
    }
    case 'YEARLY': {
      assertNoUnsupportedParts(rule, new Set(['byday', 'bymonthday', 'bymonth', 'bysetpos']));
      const base = plural(interval, 'anno', 'anni');
      const months = rule.bymonth ? [...rule.bymonth].sort((a, b) => a - b) : [dtstart.month];
      const monthNames = months.map((m) => MONTHS[m - 1]);
      if (rule.byday) {
        if (rule.bymonthday || !rule.bymonth) fail();
        const ordinal = ordinalDaysPhrase(rule);
        if (!ordinal) fail();
        return `${base} ${ordinal} di ${joinList(monthNames)}`;
      }
      if (rule.bysetpos) fail();
      const monthDays = rule.bymonthday ?? [dtstart.day];
      if (monthDays.some((d) => d < 1)) fail();
      const days = [...monthDays].sort((a, b) => a - b);
      if (months.length === 1) return `${base} ${joinList(days.map((d) => `il ${dayNumber(d)} ${monthNames[0]}`))}`;
      return `${base} ${joinList(days.map((d) => `il ${dayNumber(d)}`))} di ${joinList(monthNames)}`;
    }
    case 'HOURLY': {
      assertNoUnsupportedParts(rule, new Set());
      return plural(interval, 'ora', 'ore');
    }
    case 'MINUTELY': {
      assertNoUnsupportedParts(rule, new Set());
      return plural(interval, 'minuto', 'minuti');
    }
    default:
      return fail();
  }
}

/** Data dell'UNTIL nel fuso dell'evento (UTC → data locale; DATE e floating così come sono). */
function untilDate(rule: RecurRule, tz: string): string | null {
  const u = rule.until;
  if (!u) return null;
  if (u.type === 'date') return formatDate(u.year, u.month, u.day);
  if (u.zone.kind === 'utc') {
    const ms = Date.UTC(u.year, u.month - 1, u.day, u.hour, u.minute, Math.min(u.second, 59));
    const [y, m, d] = localDateOf(ms, tz).split('-').map(Number);
    return formatDate(y, m, d);
  }
  return formatDate(u.year, u.month, u.day);
}

function describeEnd(rule: RecurRule, tz: string): string {
  const parts: string[] = [];
  if (rule.count != null) parts.push(rule.count === 1 ? 'una volta sola' : `per ${rule.count} volte`);
  const until = untilDate(rule, tz);
  if (until) parts.push(`fino al ${until}`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

/**
 * Riepilogo in italiano di una RRULE ("Ogni 2 settimane il lunedì e il
 * giovedì, fino al 31 dicembre 2026"). `dtstart` completa le regole che
 * rimandano all'inizio (giorno della settimana, del mese, mese). `opts.tz` è il
 * fuso con cui si legge un UNTIL in UTC. Parti non descrivibili →
 * "Ricorrenza personalizzata (<RRULE>)".
 */
export function describeRrule(rrule: string, dtstart: IcsTime, opts: { tz: string }): string {
  const body = rrule.trim().replace(/^RRULE:/i, '');
  const custom = `Ricorrenza personalizzata (${body})`;
  const parsed = parseRecurRule(body);
  if (!parsed.ok) return custom;
  try {
    const tz = opts.tz || DEFAULT_TZ;
    return `${describeFrequency(parsed.rule, dtstart)}${describeEnd(parsed.rule, tz)}`;
  } catch (err) {
    if (err instanceof Undescribable) return custom;
    throw err;
  }
}
