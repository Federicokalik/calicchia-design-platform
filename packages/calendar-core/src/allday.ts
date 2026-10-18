/**
 * All-day: date di calendario, DTEND esclusivo e conversioni con le
 * convenzioni attuali dell'API.
 *
 * In Radicale un all-day è sempre VALUE=DATE: DTSTART, DTEND esclusivo,
 * EXDATE, RDATE, RECURRENCE-ID e UNTIL come DATE (design §5).
 *
 * Nel DTO legacy (calendar_events, admin v1, MCP) un all-day è un intervallo
 * di istanti con `all_day=true`. Le forme che esistono oggi nel database:
 * - mezzanotte locale del calendario (Europe/Rome) per inizio e fine:
 *   editor admin con orari 00:00, MCP, migrazione delle festività manuali;
 * - mezzanotte UTC: iscrizioni ICS (ics-import.ts scrive "YYYY-MM-DDT00:00Z");
 * - orari qualsiasi con `all_day=true`: l'editor admin conserva gli orari del
 *   datetime-local quando si spunta "Tutto il giorno" (ALLDAY_AMBIGUOUS).
 *
 * Il feed legacy (ics-feed.ts) prende la data locale di start_time e di
 * end_time nel fuso del calendario, e FullCalendar mostra l'evento sulla data
 * locale dell'inizio. Qui si fa lo stesso per l'inizio e si corregge la fine:
 * una fine non a mezzanotte cade dentro un giorno, che quindi è coperto (fine
 * esclusiva = giorno dopo). Per i valori a mezzanotte, locale o UTC, il
 * risultato coincide con la regola "+12 h" del serializer di migrazione
 * (design §13.5), che però sbaglierebbe giorno per gli orari pomeridiani dei
 * casi ambigui.
 *
 * Verso il DTO si produce sempre la mezzanotte locale del calendario in ISO
 * UTC (`rangeToLegacyAllDay`): per le iscrizioni è la differenza ammessa n. 2
 * (mezzanotte UTC → mezzanotte di Roma, allowed-diffs.json).
 */

import { IcsValueError } from './errors';
import type { IcsComponent, IcsDate, IcsDuration, IcsTime } from './model';
import { type ConvertibleZone, type WallTime, ianaZone, msToWall, resolveZone, utcToZoned, wallToMs, zonedToUtc } from './tz-registry';

/** Data di calendario 'YYYY-MM-DD'. */
export type DateString = string;

/** Intervallo all-day: `end` è esclusiva (RFC 5545), sempre > `start`. */
export interface AllDayRange {
  start: DateString;
  end: DateString;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function monthLength(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** True se `s` è una data 'YYYY-MM-DD' esistente. */
export function isDateString(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= monthLength(y, mo);
}

function assertDate(s: string): void {
  if (!isDateString(s)) throw new IcsValueError('INVALID_DATE_STRING', `Data non valida: "${String(s).slice(0, 20)}"`, { value: String(s) });
}

/** Componenti di una data 'YYYY-MM-DD'. */
export function dateParts(date: DateString): { year: number; month: number; day: number } {
  assertDate(date);
  const [y, m, d] = date.split('-').map(Number);
  return { year: y, month: m, day: d };
}

/** Data 'YYYY-MM-DD' da anno, mese (1-12) e giorno, normalizzando i fuori scala (32 gennaio → 1 febbraio). */
export function dateFromParts(year: number, month: number, day: number): DateString {
  const w = msToWall(wallToMs({ year, month, day, hour: 12, minute: 0, second: 0 }));
  return `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** Somma `n` giorni (anche negativi) a una data. */
export function addDays(date: DateString, n: number): DateString {
  const p = dateParts(date);
  return dateFromParts(p.year, p.month, p.day + n);
}

/** Giorni da `a` a `b` (b − a). */
export function daysBetween(a: DateString, b: DateString): number {
  const pa = dateParts(a);
  const pb = dateParts(b);
  const ma = wallToMs({ ...pa, hour: 12, minute: 0, second: 0 });
  const mb = wallToMs({ ...pb, hour: 12, minute: 0, second: 0 });
  return Math.round((mb - ma) / 86_400_000);
}

/** Confronto lessicografico (= cronologico) fra date. */
export function compareDates(a: DateString, b: DateString): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** IcsDate → 'YYYY-MM-DD'. */
export function icsDateToString(d: IcsDate): DateString {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' → IcsDate. */
export function stringToIcsDate(s: DateString): IcsDate {
  const p = dateParts(s);
  return { type: 'date', year: p.year, month: p.month, day: p.day };
}

function zoneOf(tz: string | ConvertibleZone): ConvertibleZone {
  return typeof tz === 'string' ? ianaZone(tz) : tz;
}

/** Data locale (nel fuso) di un istante. */
export function localDateOf(ms: number, tz: string | ConvertibleZone): DateString {
  const w = utcToZoned(ms, zoneOf(tz));
  return dateFromParts(w.year, w.month, w.day);
}

/** Istante della mezzanotte locale di una data (regole RFC per una mezzanotte inesistente). */
export function localMidnightUtcMs(date: DateString, tz: string | ConvertibleZone): number {
  const p = dateParts(date);
  return zonedToUtc({ ...p, hour: 0, minute: 0, second: 0 }, zoneOf(tz));
}

/** ISO UTC della mezzanotte locale di una data: la forma degli all-day nei JSON legacy e MCP. */
export function dateToLegacyIso(date: DateString, tz: string | ConvertibleZone): string {
  return new Date(localMidnightUtcMs(date, tz)).toISOString();
}

/** True se l'istante è la mezzanotte locale nel fuso. */
export function isLocalMidnight(ms: number, tz: string | ConvertibleZone): boolean {
  const w = utcToZoned(ms, zoneOf(tz));
  return w.hour === 0 && w.minute === 0 && w.second === 0;
}

/** True se l'istante è la mezzanotte UTC. */
export function isUtcMidnight(ms: number): boolean {
  return ((ms % 86_400_000) + 86_400_000) % 86_400_000 === 0;
}

function toMs(value: string | Date, what: string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new IcsValueError('INVALID_ISO', `${what} non è un istante ISO valido: "${String(value).slice(0, 40)}"`, { value: String(value) });
  }
  return ms;
}

type Anchor = 'local-midnight' | 'utc-midnight' | 'none';

function anchorOf(ms: number, zone: ConvertibleZone): Anchor {
  if (isLocalMidnight(ms, zone)) return 'local-midnight';
  if (isUtcMidnight(ms)) return 'utc-midnight';
  return 'none';
}

function utcDateOf(ms: number): DateString {
  const w = msToWall(ms);
  return dateFromParts(w.year, w.month, w.day);
}

/** Come sono ancorati gli istanti di un all-day legacy. */
export type LegacyAllDayConvention =
  /** Mezzanotte locale del calendario per inizio e fine (forma attesa). */
  | 'local-midnight'
  /** Mezzanotte UTC per inizio e fine (iscrizioni ICS legacy). */
  | 'utc-midnight'
  /** Una mezzanotte locale e una UTC. */
  | 'mixed'
  /** Almeno un estremo non a mezzanotte (ALLDAY_AMBIGUOUS). */
  | 'non-midnight';

export interface LegacyAllDayConversion extends AllDayRange {
  convention: LegacyAllDayConvention;
  /** True se la fine è stata dedotta o corretta (estremo non a mezzanotte, o intervallo vuoto). */
  adjusted: boolean;
}

/**
 * Data di un istante "puntuale" di un all-day legacy (inizio, EXDATE,
 * RECURRENCE-ID): mezzanotte locale → data locale; mezzanotte UTC → data UTC;
 * altrimenti la data locale del giorno in cui cade.
 */
export function legacyAllDayPointToDate(value: string | Date, tz: string | ConvertibleZone): DateString {
  const zone = zoneOf(tz);
  const ms = toMs(value, 'Istante all-day');
  return anchorOf(ms, zone) === 'utc-midnight' ? utcDateOf(ms) : localDateOf(ms, zone);
}

/**
 * Intervallo all-day del DTO legacy (start_time, end_time, all_day=true) →
 * date con fine esclusiva. Una fine non a mezzanotte copre il proprio giorno;
 * un intervallo vuoto diventa di un giorno.
 */
export function legacyAllDayToRange(startIso: string | Date, endIso: string | Date, tz: string | ConvertibleZone): LegacyAllDayConversion {
  const zone = zoneOf(tz);
  const s = toMs(startIso, 'start_time');
  const e = toMs(endIso, 'end_time');
  const sa = anchorOf(s, zone);
  const ea = anchorOf(e, zone);
  const start = sa === 'utc-midnight' ? utcDateOf(s) : localDateOf(s, zone);
  let end = ea === 'utc-midnight' ? utcDateOf(e) : ea === 'local-midnight' ? localDateOf(e, zone) : addDays(localDateOf(e, zone), 1);
  let adjusted = sa === 'none' || ea === 'none';
  if (compareDates(end, start) <= 0) {
    end = addDays(start, 1);
    adjusted = true;
  }
  const convention: LegacyAllDayConvention =
    sa === 'none' || ea === 'none' ? 'non-midnight' : sa === ea ? sa : 'mixed';
  return { start, end, convention, adjusted };
}

/** Date all-day → istanti del DTO legacy (mezzanotte locale in ISO UTC). */
export function rangeToLegacyAllDay(range: AllDayRange, tz: string | ConvertibleZone): { start_time: string; end_time: string } {
  return { start_time: dateToLegacyIso(range.start, tz), end_time: dateToLegacyIso(range.end, tz) };
}

/** Contesto per interpretare un DTEND DATE-TIME accanto a un DTSTART DATE. */
export interface AllDayContext {
  tz: string;
  timezones?: readonly IcsComponent[];
}

function timeToMs(t: IcsTime, ctx: AllDayContext): number {
  if (t.type === 'date') return localMidnightUtcMs(icsDateToString(t), ctx.tz);
  const wall: WallTime = { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: Math.min(t.second, 59) };
  return zonedToUtc(wall, resolveZone(t.zone, ctx).zone);
}

/**
 * Intervallo di un VEVENT all-day (DTSTART DATE) con DTEND esclusivo:
 * - DTEND DATE → quella data;
 * - DTEND DATE-TIME (tipi misti, vietati da RFC 5545 ma scritti da alcuni
 *   client) → data locale nel fuso del calendario, +1 se non a mezzanotte;
 * - DURATION → giorni e settimane; una parte oraria positiva copre il giorno
 *   in cui finisce;
 * - né DTEND né DURATION → un giorno (RFC 5545 §3.6.1).
 * Una fine non successiva all'inizio diventa inizio + 1 giorno (`adjusted`).
 */
export function allDayRangeFromIcs(
  dtstart: IcsDate,
  end: IcsTime | null,
  duration: IcsDuration | null,
  ctx: AllDayContext,
): AllDayRange & { adjusted: boolean } {
  const start = icsDateToString(dtstart);
  let endDate: DateString;
  let adjusted = false;
  if (end) {
    if (end.type === 'date') {
      endDate = icsDateToString(end);
    } else {
      const ms = timeToMs(end, ctx);
      endDate = isLocalMidnight(ms, ctx.tz) ? localDateOf(ms, ctx.tz) : addDays(localDateOf(ms, ctx.tz), 1);
      adjusted = true;
    }
  } else if (duration) {
    const sign = duration.negative ? -1 : 1;
    const days = duration.weeks * 7 + duration.days;
    const hasTime = duration.hours > 0 || duration.minutes > 0 || duration.seconds > 0;
    endDate = addDays(start, sign * (days + (hasTime && !duration.negative ? 1 : 0)));
    if (hasTime) adjusted = true;
  } else {
    endDate = addDays(start, 1);
  }
  if (compareDates(endDate, start) <= 0) {
    endDate = addDays(start, 1);
    adjusted = true;
  }
  return { start, end: endDate, adjusted };
}

/**
 * UNTIL di una serie all-day legacy (istante UTC) → UNTIL DATE. Il codice
 * legacy confronta le occorrenze in ora locale: l'occorrenza del giorno D
 * (all'ora locale dell'inizio della serie) è compresa se UNTIL, in ora locale,
 * non è precedente. Con le serie a mezzanotte la data è quella locale di UNTIL.
 */
export function legacyUntilToDate(untilMs: number, startSecondsOfDay: number, tz: string | ConvertibleZone): DateString {
  const zone = zoneOf(tz);
  const w = utcToZoned(untilMs, zone);
  const date = dateFromParts(w.year, w.month, w.day);
  const secs = w.hour * 3600 + w.minute * 60 + w.second;
  return secs >= startSecondsOfDay ? date : addDays(date, -1);
}

/** Secondi dall'inizio del giorno locale per un istante (per legacyUntilToDate). */
export function localSecondsOfDay(ms: number, tz: string | ConvertibleZone): number {
  const w = utcToZoned(ms, zoneOf(tz));
  return w.hour * 3600 + w.minute * 60 + w.second;
}
