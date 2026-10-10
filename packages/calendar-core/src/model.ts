/**
 * Modello iCalendar lossless e mappature verso il DTO dell'API.
 *
 * Tre livelli:
 * 1. Albero grezzo (IcsComponent / IcsProperty / IcsParam): ciò che parse.ts
 *    produce e serialize.ts scrive. Ogni proprietà conserva nome, parametri in
 *    ordine e valore grezzo non decodificato: proprietà, parametri e
 *    componenti sconosciuti, VALARM, ATTENDEE e X-* sopravvivono a qualsiasi
 *    modifica che non li tocca.
 * 2. Oggetto calendario (CalendarObject): una risorsa CalDAV = un VCALENDAR
 *    con il master e gli override (RECURRENCE-ID) di un solo UID, i VTIMEZONE
 *    e i componenti estranei. La chiave canonica delle occorrenze è la
 *    recurrence key (MASTER_RECURRENCE_KEY per il master).
 * 3. Viste tipizzate: decodifica dei tipi (date, durate, TEXT), vista
 *    dell'evento (readEvent) e mappatura sul DTO evento attuale dell'API
 *    (apps/api/src/lib/calendar/types.ts, CalendarEvent) in entrambe le
 *    direzioni, più la provenienza (source/source_id) derivata da collezione e
 *    href con le X-CALDES-* del design §5.
 *
 * Le funzioni che modificano l'albero (setProperty, setParam, ...) lavorano
 * in place: chi parte da un oggetto condiviso lo clona prima
 * (cloneCalendarObject, cloneComponent). Tutte le funzioni lanciano solo
 * CalendarCoreError tipizzati (IcsValueError, TimezoneError).
 */

import {
  addDays,
  allDayRangeFromIcs,
  compareDates,
  type DateString,
  dateFromParts,
  icsDateToString,
  legacyAllDayPointToDate,
  legacyAllDayToRange,
  legacyUntilToDate,
  localDateOf,
  localSecondsOfDay,
  rangeToLegacyAllDay,
  stringToIcsDate,
} from './allday';
import { IcsValueError, type IcsWarning, toCoreError } from './errors';
import { decodeParamValue, decodeText, encodeText, splitTextList } from './ics-text';
import {
  type ConvertibleZone,
  DEFAULT_TZ,
  ianaZone,
  msToWall,
  resolveZone,
  utcToZoned,
  type WallTime,
  wallToMs,
  zonedToUtc,
} from './tz-registry';

export {
  collectTzidRefs,
  decodeParamValue,
  decodeText,
  encodeParamValue,
  encodeText,
  joinTextList,
  splitTextList,
  vtimezoneTzid,
} from './ics-text';

// ============================================
// Albero grezzo
// ============================================

/** Parametro: nome in maiuscolo, valori senza virgolette e non decodificati (RFC 6868 a parte: decodeParamValue). */
export interface IcsParam {
  name: string;
  values: string[];
}

/** Proprietà: nome in maiuscolo, parametri nell'ordine del testo, valore grezzo (dopo l'unfolding, mai decodificato). */
export interface IcsProperty {
  name: string;
  params: IcsParam[];
  value: string;
}

/** Componente: nome in maiuscolo, proprietà e sottocomponenti nell'ordine del testo. */
export interface IcsComponent {
  name: string;
  properties: IcsProperty[];
  components: IcsComponent[];
}

/** Componenti che possono essere una risorsa CalDAV (RFC 4791). */
export type SchedulableComponentType = 'VEVENT' | 'VTODO' | 'VJOURNAL';

/**
 * Oggetto calendario: una risorsa CalDAV (un file .ics in una collezione di
 * Radicale). Il master può mancare (risorsa con soli override, ammessa da
 * RFC 6638 per gli inviti a singole occorrenze).
 */
export interface CalendarObject {
  uid: string;
  componentType: SchedulableComponentType;
  /** Proprietà del VCALENDAR (VERSION, PRODID, CALSCALE, METHOD, X-WR-*...) nell'ordine originale. */
  calendarProperties: IcsProperty[];
  /** Componente senza RECURRENCE-ID. */
  master: IcsComponent | null;
  /** Componenti con RECURRENCE-ID, nell'ordine originale (serialize li ordina per recurrence key). */
  overrides: IcsComponent[];
  /** VTIMEZONE presenti nell'oggetto (serialize decide quali scrivere, vedi tz-registry). */
  timezones: IcsComponent[];
  /** Altri componenti di primo livello (VFREEBUSY, VAVAILABILITY, X-...), conservati tali e quali. */
  otherComponents: IcsComponent[];
}

/** Proprietà con parametri dati come lista o come mappa nome → valore/i. */
export function createProperty(
  name: string,
  value: string,
  params: IcsParam[] | Record<string, string | readonly string[]> = [],
): IcsProperty {
  const list: IcsParam[] = Array.isArray(params)
    ? params.map((p) => ({ name: p.name.toUpperCase(), values: [...p.values] }))
    : Object.entries(params).map(([n, v]) => ({ name: n.toUpperCase(), values: typeof v === 'string' ? [v] : [...v] }));
  return { name: name.toUpperCase(), params: list, value };
}

export function createComponent(name: string, properties: IcsProperty[] = [], components: IcsComponent[] = []): IcsComponent {
  return { name: name.toUpperCase(), properties, components };
}

/** Prima proprietà con quel nome (case-insensitive), o null. */
export function getProperty(c: IcsComponent, name: string): IcsProperty | null {
  const n = name.toUpperCase();
  return c.properties.find((p) => p.name === n) ?? null;
}

/** Tutte le proprietà con quel nome, nell'ordine. */
export function getProperties(c: IcsComponent, name: string): IcsProperty[] {
  const n = name.toUpperCase();
  return c.properties.filter((p) => p.name === n);
}

export function hasProperty(c: IcsComponent, name: string): boolean {
  return getProperty(c, name) != null;
}

/**
 * Sostituisce tutte le proprietà con il nome di `props[0]` (o `name`) con
 * `props`, nella posizione della prima occorrenza (in coda se non c'era).
 * Con `props` vuoto equivale a removeProperties.
 */
export function setProperties(c: IcsComponent, name: string, props: IcsProperty[]): void {
  const n = name.toUpperCase();
  const idx = c.properties.findIndex((p) => p.name === n);
  const rest = c.properties.filter((p) => p.name !== n);
  const at = idx < 0 ? rest.length : c.properties.slice(0, idx).filter((p) => p.name !== n).length;
  rest.splice(at, 0, ...props);
  c.properties = rest;
}

/** Imposta una proprietà a occorrenza singola (sostituisce tutte quelle con lo stesso nome). */
export function setProperty(c: IcsComponent, prop: IcsProperty): void {
  setProperties(c, prop.name, [prop]);
}

/** Rimuove tutte le proprietà con quel nome; restituisce quante ne ha tolte. */
export function removeProperties(c: IcsComponent, name: string): number {
  const n = name.toUpperCase();
  const before = c.properties.length;
  c.properties = c.properties.filter((p) => p.name !== n);
  return before - c.properties.length;
}

export function getParam(p: IcsProperty, name: string): IcsParam | null {
  const n = name.toUpperCase();
  return p.params.find((x) => x.name === n) ?? null;
}

/** Primo valore del parametro, o null. */
export function getParamValue(p: IcsProperty, name: string): string | null {
  return getParam(p, name)?.values[0] ?? null;
}

/** Imposta (o con null rimuove) un parametro, mantenendone la posizione se esisteva. */
export function setParam(p: IcsProperty, name: string, values: string | readonly string[] | null): void {
  const n = name.toUpperCase();
  const idx = p.params.findIndex((x) => x.name === n);
  if (values == null) {
    if (idx >= 0) p.params.splice(idx, 1);
    return;
  }
  const param: IcsParam = { name: n, values: typeof values === 'string' ? [values] : [...values] };
  if (idx >= 0) p.params[idx] = param;
  else p.params.push(param);
}

export function getSubcomponents(c: IcsComponent, name: string): IcsComponent[] {
  const n = name.toUpperCase();
  return c.components.filter((x) => x.name === n);
}

export function cloneProperty(p: IcsProperty): IcsProperty {
  return { name: p.name, value: p.value, params: p.params.map((x) => ({ name: x.name, values: [...x.values] })) };
}

export function cloneComponent(c: IcsComponent): IcsComponent {
  return { name: c.name, properties: c.properties.map(cloneProperty), components: c.components.map(cloneComponent) };
}

/** Valore TEXT decodificato della prima proprietà, o null. */
export function getTextValue(c: IcsComponent, name: string): string | null {
  const p = getProperty(c, name);
  return p ? decodeText(p.value) : null;
}

/** Imposta una proprietà TEXT (null o stringa vuota la rimuove); conserva i parametri esistenti (LANGUAGE, ALTREP...). */
export function setTextValue(c: IcsComponent, name: string, text: string | null): void {
  if (text == null || text === '') {
    removeProperties(c, name);
    return;
  }
  const existing = getProperty(c, name);
  setProperty(c, { name: name.toUpperCase(), params: existing ? existing.params.map((x) => ({ ...x, values: [...x.values] })) : [], value: encodeText(text) });
}

// ============================================
// Oggetto calendario
// ============================================

export function createCalendarObject(init: {
  uid: string;
  componentType?: SchedulableComponentType;
  master: IcsComponent | null;
  overrides?: IcsComponent[];
  timezones?: IcsComponent[];
  calendarProperties?: IcsProperty[];
  otherComponents?: IcsComponent[];
}): CalendarObject {
  return {
    uid: init.uid,
    componentType: init.componentType ?? ((init.master?.name ?? init.overrides?.[0]?.name ?? 'VEVENT') as SchedulableComponentType),
    calendarProperties: init.calendarProperties ?? [],
    master: init.master,
    overrides: init.overrides ?? [],
    timezones: init.timezones ?? [],
    otherComponents: init.otherComponents ?? [],
  };
}

export function cloneCalendarObject(obj: CalendarObject): CalendarObject {
  return {
    uid: obj.uid,
    componentType: obj.componentType,
    calendarProperties: obj.calendarProperties.map(cloneProperty),
    master: obj.master ? cloneComponent(obj.master) : null,
    overrides: obj.overrides.map(cloneComponent),
    timezones: obj.timezones.map(cloneComponent),
    otherComponents: obj.otherComponents.map(cloneComponent),
  };
}

/** Master (se c'è) e override, nell'ordine del modello. */
export function objectComponents(obj: CalendarObject): IcsComponent[] {
  return obj.master ? [obj.master, ...obj.overrides] : [...obj.overrides];
}

/**
 * Oggetto → VCALENDAR grezzo nell'ordine del modello (proprietà del
 * calendario, VTIMEZONE, master, override, altri). Non clona. La forma
 * canonica (VERSION/PRODID, VTIMEZONE del registro, override ordinati) la
 * applica serialize.ts.
 */
export function objectToCalendar(obj: CalendarObject): IcsComponent {
  return {
    name: 'VCALENDAR',
    properties: obj.calendarProperties,
    components: [...obj.timezones, ...objectComponents(obj), ...obj.otherComponents],
  };
}

// ============================================
// Tipi temporali
// ============================================

/** Zona di un DATE-TIME: UTC (suffisso Z), floating (nessun TZID) o TZID. */
export type IcsZone = { kind: 'utc' } | { kind: 'floating' } | { kind: 'tzid'; tzid: string };

export interface IcsDate {
  type: 'date';
  year: number;
  month: number;
  day: number;
}

export interface IcsDateTime {
  type: 'date-time';
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0-60 (60 = secondo intercalare, ammesso da RFC 5545; le conversioni lo trattano come 59). */
  second: number;
  zone: IcsZone;
}

export type IcsTime = IcsDate | IcsDateTime;

/** Durata RFC 5545: settimane e giorni sono nominali, ore, minuti e secondi esatti. */
export interface IcsDuration {
  negative: boolean;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Valore PERIOD (RDATE;VALUE=PERIOD): inizio più fine o durata. */
export interface IcsPeriod {
  type: 'period';
  start: IcsDateTime;
  end: IcsDateTime | null;
  duration: IcsDuration | null;
}

export interface IcsGeo {
  lat: number;
  lon: number;
}

/** Contesto di fuso: `tz` (IANA, fuso del calendario) interpreta floating, DATE e TZID sconosciuti. */
export interface ZoneContext {
  tz: string;
  /** VTIMEZONE dell'oggetto, per i TZID non IANA. */
  timezones?: readonly IcsComponent[];
}

const DATE_VALUE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_VALUE_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i;
const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const len = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return d <= len;
}

/** 'YYYYMMDD' → IcsDate (lancia INVALID_DATE). */
export function parseDateValue(raw: string, property: string | null = null): IcsDate {
  const m = DATE_VALUE_RE.exec(raw.trim());
  if (!m || !validDate(+m[1], +m[2], +m[3])) {
    throw new IcsValueError('INVALID_DATE', `Data non valida${property ? ` in ${property}` : ''}: "${raw.slice(0, 30)}"`, { property, value: raw });
  }
  return { type: 'date', year: +m[1], month: +m[2], day: +m[3] };
}

/** 'YYYYMMDDTHHMMSS[Z]' → IcsDateTime (lancia INVALID_DATE_TIME). Con Z e TZID insieme vale la Z. */
export function parseDateTimeValue(raw: string, tzid: string | null, property: string | null = null): IcsDateTime {
  const m = DATE_TIME_VALUE_RE.exec(raw.trim());
  const bad = (): IcsValueError =>
    new IcsValueError('INVALID_DATE_TIME', `Data e ora non valide${property ? ` in ${property}` : ''}: "${raw.slice(0, 30)}"`, { property, value: raw });
  if (!m) throw bad();
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
  if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 60) throw bad();
  const zone: IcsZone = m[7] ? { kind: 'utc' } : tzid != null && tzid.trim() !== '' ? { kind: 'tzid', tzid } : { kind: 'floating' };
  return { type: 'date-time', year: y, month: mo, day: d, hour: h, minute: mi, second: s, zone };
}

/**
 * Valore DATE o DATE-TIME secondo il parametro VALUE; senza VALUE, 8 cifre
 * valgono DATE (tolleranza per i client che omettono VALUE=DATE).
 */
export function parseTimeValue(raw: string, params: { value?: string | null; tzid?: string | null } = {}, property: string | null = null): IcsTime {
  const type = (params.value ?? '').toUpperCase();
  if (type === 'DATE') return parseDateValue(raw, property);
  if (type === 'DATE-TIME') return parseDateTimeValue(raw, params.tzid ?? null, property);
  if (type !== '') {
    throw new IcsValueError('INVALID_VALUE', `VALUE=${type} non ammesso${property ? ` in ${property}` : ''}`, { property, value: raw });
  }
  return DATE_VALUE_RE.test(raw.trim()) ? parseDateValue(raw, property) : parseDateTimeValue(raw, params.tzid ?? null, property);
}

/** DATE o DATE-TIME di una proprietà (DTSTART, DTEND, DUE, RECURRENCE-ID...). */
export function readTimeProperty(p: IcsProperty): IcsTime {
  return parseTimeValue(p.value, { value: getParamValue(p, 'VALUE'), tzid: getParamValue(p, 'TZID') }, p.name);
}

/** Valore testuale di un DATE o DATE-TIME (senza parametri). */
export function formatTimeValue(t: IcsTime): string {
  const date = `${String(t.year).padStart(4, '0')}${String(t.month).padStart(2, '0')}${String(t.day).padStart(2, '0')}`;
  if (t.type === 'date') return date;
  const time = `${String(t.hour).padStart(2, '0')}${String(t.minute).padStart(2, '0')}${String(t.second).padStart(2, '0')}`;
  return `${date}T${time}${t.zone.kind === 'utc' ? 'Z' : ''}`;
}

/** Parametri che accompagnano un valore temporale: VALUE=DATE o TZID. */
export function timeParams(t: IcsTime): IcsParam[] {
  if (t.type === 'date') return [{ name: 'VALUE', values: ['DATE'] }];
  if (t.zone.kind === 'tzid') return [{ name: 'TZID', values: [t.zone.tzid] }];
  return [];
}

/** Proprietà temporale completa (VALUE=DATE o TZID più i parametri aggiuntivi dati). */
export function createTimeProperty(name: string, t: IcsTime, extraParams: IcsParam[] = []): IcsProperty {
  return { name: name.toUpperCase(), params: [...timeParams(t), ...extraParams.map((p) => ({ name: p.name.toUpperCase(), values: [...p.values] }))], value: formatTimeValue(t) };
}

function parsePeriodValue(raw: string, tzid: string | null, property: string): IcsPeriod {
  const [a, b] = raw.split('/');
  if (a == null || b == null) {
    throw new IcsValueError('INVALID_PERIOD', `PERIOD non valido in ${property}: "${raw.slice(0, 40)}"`, { property, value: raw });
  }
  const start = parseDateTimeValue(a, tzid, property);
  if (/^[+-]?P/i.test(b.trim())) return { type: 'period', start, end: null, duration: parseDurationValue(b, property) };
  return { type: 'period', start, end: parseDateTimeValue(b, tzid, property), duration: null };
}

/** Valori di una lista temporale (EXDATE, RDATE), anche PERIOD. */
export function readTimeListProperty(p: IcsProperty): Array<IcsTime | IcsPeriod> {
  const type = (getParamValue(p, 'VALUE') ?? '').toUpperCase();
  const tzid = getParamValue(p, 'TZID');
  const out: Array<IcsTime | IcsPeriod> = [];
  for (const part of p.value.split(',')) {
    const v = part.trim();
    if (!v) continue;
    out.push(type === 'PERIOD' ? parsePeriodValue(v, tzid, p.name) : parseTimeValue(v, { value: type || null, tzid }, p.name));
  }
  return out;
}

function timeSignature(v: IcsTime | IcsPeriod): string {
  if (v.type === 'period') return `period|${v.start.zone.kind === 'tzid' ? v.start.zone.tzid : v.start.zone.kind}`;
  if (v.type === 'date') return 'date';
  return `dt|${v.zone.kind === 'tzid' ? `tzid:${v.zone.tzid}` : v.zone.kind}`;
}

/**
 * Proprietà di lista (EXDATE, RDATE) per i valori dati: una proprietà per
 * gruppo di tipo e zona, nell'ordine di prima apparizione.
 */
export function createTimeListProperties(name: string, values: ReadonlyArray<IcsTime | IcsPeriod>): IcsProperty[] {
  const groups = new Map<string, Array<IcsTime | IcsPeriod>>();
  for (const v of values) {
    const sig = timeSignature(v);
    const g = groups.get(sig);
    if (g) g.push(v);
    else groups.set(sig, [v]);
  }
  const props: IcsProperty[] = [];
  for (const g of groups.values()) {
    const first = g[0];
    if (first.type === 'period') {
      const params: IcsParam[] = [{ name: 'VALUE', values: ['PERIOD'] }];
      if (first.start.zone.kind === 'tzid') params.push({ name: 'TZID', values: [first.start.zone.tzid] });
      const value = (g as IcsPeriod[])
        .map((pv) => `${formatTimeValue(pv.start)}/${pv.end ? formatTimeValue(pv.end) : formatDurationValue(pv.duration ?? zeroDuration())}`)
        .join(',');
      props.push({ name: name.toUpperCase(), params, value });
    } else {
      props.push({ name: name.toUpperCase(), params: timeParams(first), value: (g as IcsTime[]).map(formatTimeValue).join(',') });
    }
  }
  return props;
}

export function zeroDuration(): IcsDuration {
  return { negative: false, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
}

/** Durata RFC 5545 (PnW, PnDTnHnMnS, con segno) → IcsDuration (lancia INVALID_DURATION). */
export function parseDurationValue(raw: string, property: string | null = null): IcsDuration {
  const s = raw.trim();
  const m = DURATION_RE.exec(s);
  if (!m || /T$/i.test(s) || !/\d/.test(s)) {
    throw new IcsValueError('INVALID_DURATION', `Durata non valida${property ? ` in ${property}` : ''}: "${raw.slice(0, 30)}"`, { property, value: raw });
  }
  return {
    negative: m[1] === '-',
    weeks: Number(m[2] ?? 0),
    days: Number(m[3] ?? 0),
    hours: Number(m[4] ?? 0),
    minutes: Number(m[5] ?? 0),
    seconds: Number(m[6] ?? 0),
  };
}

/** Forma canonica: PnW se ci sono solo settimane, altrimenti PnDTnHnMnS senza zeri; durata nulla = PT0S. */
export function formatDurationValue(d: IcsDuration): string {
  const sign = d.negative ? '-' : '';
  const onlyWeeks = d.weeks > 0 && d.days === 0 && d.hours === 0 && d.minutes === 0 && d.seconds === 0;
  if (onlyWeeks) return `${sign}P${d.weeks}W`;
  const days = d.weeks * 7 + d.days;
  let out = `${sign}P${days > 0 ? `${days}D` : ''}`;
  if (d.hours || d.minutes || d.seconds) {
    out += `T${d.hours ? `${d.hours}H` : ''}${d.minutes ? `${d.minutes}M` : ''}${d.seconds ? `${d.seconds}S` : ''}`;
  }
  return out === `${sign}P` ? 'PT0S' : out;
}

/** Secondi nominali della durata (giorni = 86400 s): solo per stime e confronti, non per l'aritmetica sul calendario. */
export function durationToSeconds(d: IcsDuration): number {
  const total = d.weeks * 604800 + d.days * 86400 + d.hours * 3600 + d.minutes * 60 + d.seconds;
  return d.negative ? -total : total;
}

/** Durata esatta (solo parte oraria) fra due istanti, con segno. */
export function durationFromMs(ms: number): IcsDuration {
  const negative = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  return { negative, weeks: 0, days, hours, minutes, seconds: s - minutes * 60 };
}

// ============================================
// Conversioni
// ============================================

function clampWall(t: IcsDateTime): WallTime {
  return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: Math.min(t.second, 59) };
}

function zoneFor(t: IcsDateTime, ctx: ZoneContext): ConvertibleZone {
  return resolveZone(t.zone, { tz: ctx.tz || DEFAULT_TZ, timezones: ctx.timezones }).zone;
}

/** Ora da muro di un valore temporale (DATE → mezzanotte). */
export function timeToWall(t: IcsTime): WallTime {
  return t.type === 'date'
    ? { year: t.year, month: t.month, day: t.day, hour: 0, minute: 0, second: 0 }
    : clampWall(t);
}

/**
 * Istante UTC (ms) di un valore temporale: DATE → mezzanotte locale nel fuso
 * del calendario; floating → ora locale nel fuso del calendario; TZID → zona
 * risolta (tz-registry); TZID sconosciuto → fuso del calendario.
 */
export function timeToUtcMs(t: IcsTime, ctx: ZoneContext): number {
  try {
    if (t.type === 'date') return zonedToUtc(timeToWall(t), ianaZone(ctx.tz || DEFAULT_TZ));
    if (t.zone.kind === 'utc') return wallToMs(clampWall(t));
    return zonedToUtc(clampWall(t), zoneFor(t, ctx));
  } catch (err) {
    throw toCoreError(err, 'timeToUtcMs');
  }
}

/** ISO UTC (toISOString) di un valore temporale. */
export function timeToIso(t: IcsTime, ctx: ZoneContext): string {
  return new Date(timeToUtcMs(t, ctx)).toISOString();
}

/** Valore dello stesso tipo e della stessa zona di `like` con l'ora da muro data. */
export function wallToTime(w: WallTime, like: IcsTime): IcsTime {
  if (like.type === 'date') return { type: 'date', year: w.year, month: w.month, day: w.day };
  return { type: 'date-time', year: w.year, month: w.month, day: w.day, hour: w.hour, minute: w.minute, second: w.second, zone: like.zone };
}

/**
 * Istante → valore dello stesso tipo e della stessa zona di `like` (per
 * scrivere RECURRENCE-ID ed EXDATE "come il DTSTART"): DATE → data locale nel
 * fuso del calendario; UTC → Z; floating → ora locale nel fuso del
 * calendario; TZID → ora locale in quella zona.
 */
export function utcMsToTime(ms: number, like: IcsTime, ctx: ZoneContext): IcsTime {
  try {
    if (like.type === 'date') {
      const d = localDateOf(ms, ctx.tz || DEFAULT_TZ);
      return stringToIcsDate(d);
    }
    const zone: ConvertibleZone = like.zone.kind === 'utc' ? { kind: 'utc' } : zoneFor(like, ctx);
    return wallToTime(utcToZoned(ms, zone), like);
  } catch (err) {
    throw toCoreError(err, 'utcMsToTime');
  }
}

/** Confronto cronologico fra due valori temporali nel contesto dato. */
export function compareTimes(a: IcsTime, b: IcsTime, ctx: ZoneContext): number {
  return timeToUtcMs(a, ctx) - timeToUtcMs(b, ctx);
}

/** Uguaglianza strutturale (stesso tipo, stessi campi, stessa zona). */
export function timesEqual(a: IcsTime, b: IcsTime): boolean {
  return formatTimeValue(a) === formatTimeValue(b) && JSON.stringify(timeParams(a)) === JSON.stringify(timeParams(b));
}

/**
 * Somma una durata secondo RFC 5545: settimane e giorni sono nominali (stessa
 * ora da muro nel giorno di arrivo, anche a cavallo del cambio d'ora), ore,
 * minuti e secondi sono esatti. Su un DATE si sommano i giorni; una parte
 * oraria positiva arrotonda al giorno successivo (semantica di fine).
 */
export function addDurationToTime(t: IcsTime, d: IcsDuration, ctx: ZoneContext): IcsTime {
  const sign = d.negative ? -1 : 1;
  const days = sign * (d.weeks * 7 + d.days);
  const exactMs = sign * (d.hours * 3600 + d.minutes * 60 + d.seconds) * 1000;
  if (t.type === 'date') {
    const extra = exactMs > 0 ? 1 : 0;
    return stringToIcsDate(addDays(icsDateToString(t), days + extra));
  }
  const shifted = msToWall(wallToMs(clampWall(t)) + days * 86_400_000);
  const nominal: IcsDateTime = { ...t, ...shifted, second: shifted.second };
  if (exactMs === 0) return nominal;
  if (t.zone.kind === 'utc') return wallToTime(msToWall(wallToMs(shifted) + exactMs), t);
  const zone = zoneFor(t, ctx);
  const instant = zonedToUtc(shifted, zone) + exactMs;
  return wallToTime(utcToZoned(instant, zone), t);
}

// ============================================
// Recurrence key
// ============================================

/** Recurrence key del master (e degli eventi singoli) in cal_object_ids e cal_occurrences. */
export const MASTER_RECURRENCE_KEY = '';

/**
 * Chiave dell'occorrenza `conservative` di un oggetto in quarantena (budget
 * esaurito, RRULE invalida, testo illeggibile): vale solo in cal_occurrences
 * (migrazione 163), mai in cal_object_ids né come target di una modifica.
 */
export const CONSERVATIVE_RECURRENCE_KEY = 'conservative';

/**
 * Chiave canonica di un'occorrenza (design §6.4):
 * - DATE → 'YYYYMMDD' (la data);
 * - DATE-TIME UTC o con TZID → 'YYYYMMDDTHHMMSSZ' (l'istante UTC, al secondo);
 * - DATE-TIME floating → 'YYYYMMDDTHHMMSS' (l'ora locale, senza Z: stabile anche
 *   se cambia il fuso del calendario).
 */
export function recurrenceKeyOf(t: IcsTime, ctx: ZoneContext): string {
  if (t.type === 'date') return formatTimeValue(t);
  if (t.zone.kind === 'floating') return formatTimeValue({ ...t, second: Math.min(t.second, 59) });
  const w = msToWall(timeToUtcMs(t, ctx));
  return formatTimeValue({ type: 'date-time', ...w, zone: { kind: 'utc' } });
}

export type ParsedRecurrenceKey =
  | { type: 'master' }
  | { type: 'conservative' }
  | { type: 'date'; date: DateString }
  | { type: 'instant'; utcMs: number }
  | { type: 'floating'; wall: WallTime };

/** Interpreta una recurrence key (lancia INVALID_RECURRENCE_KEY). */
export function parseRecurrenceKey(key: string): ParsedRecurrenceKey {
  if (key === MASTER_RECURRENCE_KEY) return { type: 'master' };
  if (key === CONSERVATIVE_RECURRENCE_KEY) return { type: 'conservative' };
  try {
    if (DATE_VALUE_RE.test(key)) return { type: 'date', date: icsDateToString(parseDateValue(key)) };
    const t = parseDateTimeValue(key, null);
    if (key.toUpperCase().endsWith('Z')) return { type: 'instant', utcMs: wallToMs(clampWall(t)) };
    return { type: 'floating', wall: clampWall(t) };
  } catch {
    throw new IcsValueError('INVALID_RECURRENCE_KEY', `Recurrence key non valida: "${key.slice(0, 30)}"`, { value: key });
  }
}

export function isRecurrenceKey(key: string): boolean {
  try {
    parseRecurrenceKey(key);
    return true;
  } catch {
    return false;
  }
}

/** Recurrence key di un componente: quella del suo RECURRENCE-ID, o MASTER_RECURRENCE_KEY. */
export function componentRecurrenceKey(c: IcsComponent, ctx: ZoneContext): string {
  const p = getProperty(c, 'RECURRENCE-ID');
  return p ? recurrenceKeyOf(readTimeProperty(p), ctx) : MASTER_RECURRENCE_KEY;
}

/**
 * Valore temporale per una recurrence key, dello stesso tipo e della stessa
 * zona di `like` (il DTSTART del master): serve a scrivere RECURRENCE-ID ed
 * EXDATE "dello stesso tipo e TZID di DTSTART" (design §8). Una chiave DATE su
 * un master DATE-TIME prende l'ora da muro del master; una chiave istante su
 * un master DATE prende la data locale nel fuso del calendario.
 */
export function recurrenceKeyToTime(key: string, like: IcsTime, ctx: ZoneContext): IcsTime {
  const parsed = parseRecurrenceKey(key);
  if (parsed.type === 'master' || parsed.type === 'conservative') {
    throw new IcsValueError('INVALID_RECURRENCE_KEY', `La chiave "${key}" non identifica un'occorrenza`, { value: key });
  }
  if (parsed.type === 'date') {
    const d = stringToIcsDate(parsed.date);
    if (like.type === 'date') return d;
    return { ...like, year: d.year, month: d.month, day: d.day };
  }
  if (parsed.type === 'instant') return utcMsToTime(parsed.utcMs, like, ctx);
  // Floating
  if (like.type === 'date') return { type: 'date', year: parsed.wall.year, month: parsed.wall.month, day: parsed.wall.day };
  if (like.zone.kind === 'floating') return wallToTime(parsed.wall, like);
  return utcMsToTime(zonedToUtc(parsed.wall, ianaZone(ctx.tz || DEFAULT_TZ)), like, ctx);
}

// ============================================
// Vista tipizzata dell'evento
// ============================================

/** ORGANIZER o ATTENDEE: indirizzo (di solito mailto:) più parametri e CN decodificato. */
export interface IcsAddress {
  value: string;
  cn: string | null;
  params: IcsParam[];
}

/** X-CALDES-* della provenienza (design §5 e §13.5). */
export interface CaldesProps {
  source: string | null;
  sourceId: string | null;
  legacyId: string | null;
  legacyRrule: string | null;
}

/**
 * Vista decodificata di un VEVENT (o VTODO/VJOURNAL). Rimanda all'albero per
 * tutto ciò che non è tipizzato qui (proprietà sconosciute, X-* diverse dalle
 * X-CALDES-*, parametri). `end` è DTEND (DUE per i VTODO).
 */
export interface EventView {
  componentType: string;
  uid: string | null;
  recurrenceId: IcsTime | null;
  /** Parametro RANGE di RECURRENCE-ID (THISANDFUTURE) o null. */
  recurrenceIdRange: string | null;
  start: IcsTime | null;
  end: IcsTime | null;
  duration: IcsDuration | null;
  allDay: boolean;
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  /** STATUS in maiuscolo così com'è (CONFIRMED, TENTATIVE, CANCELLED o altro). */
  status: string | null;
  /** TRANSP esplicito in maiuscolo (OPAQUE, TRANSPARENT) o null se assente. */
  transp: string | null;
  /** CLASS in maiuscolo (PUBLIC, PRIVATE, CONFIDENTIAL, ...). */
  classification: string | null;
  priority: number | null;
  sequence: number | null;
  categories: string[];
  color: string | null;
  geo: IcsGeo | null;
  /** Valori grezzi delle RRULE (di norma una). */
  rrules: string[];
  rdates: Array<IcsTime | IcsPeriod>;
  exdates: IcsTime[];
  dtstamp: IcsDateTime | null;
  created: IcsDateTime | null;
  lastModified: IcsDateTime | null;
  organizer: IcsAddress | null;
  attendees: IcsAddress[];
  /** VALARM del componente (riferimenti all'albero, non copie). */
  alarms: IcsComponent[];
  relatedTo: Array<{ uid: string; relType: string }>;
  caldes: CaldesProps;
  warnings: IcsWarning[];
}

/** Proprietà che RFC 5545 ammette al più una volta in un VEVENT/VTODO. */
const SINGLE_PROPS = [
  'UID', 'DTSTART', 'DTEND', 'DUE', 'DURATION', 'RECURRENCE-ID', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL',
  'STATUS', 'TRANSP', 'CLASS', 'PRIORITY', 'SEQUENCE', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'GEO', 'ORGANIZER', 'COLOR',
];

/**
 * CN non è multi-valore: una virgola nel valore non quotato (ics.ts scrive
 * "CN=Rossi\, Mario", con l'escape TEXT che i parametri non prevedono) fa
 * parte del nome. Si riuniscono i valori e si tolgono gli escape TEXT.
 */
function readCommonName(p: IcsProperty): string | null {
  const param = getParam(p, 'CN');
  if (!param || param.values.length === 0) return null;
  return decodeParamValue(param.values.join(',')).replace(/\\([,;\\])/g, '$1');
}

function readAddress(p: IcsProperty): IcsAddress {
  return { value: p.value, cn: readCommonName(p), params: p.params };
}

/**
 * Decodifica un VEVENT/VTODO/VJOURNAL. Errori fatali (IcsValueError):
 * DTSTART assente in un VEVENT (MISSING_PROPERTY) o valori non validi in
 * DTSTART, DTEND/DUE, DURATION, RECURRENCE-ID o RDATE: senza di loro le
 * occorrenze non sono note e l'oggetto va in quarantena. Gli altri valori non
 * validi diventano null con un avviso; un EXDATE illeggibile viene ignorato
 * (scelta conservativa: più occorrenze, quindi più busy).
 */
export function readEvent(c: IcsComponent): EventView {
  const warnings: IcsWarning[] = [];
  const warn = (code: IcsWarning['code'], message: string, property?: string): void => {
    warnings.push(property ? { code, message, property } : { code, message });
  };
  for (const name of SINGLE_PROPS) {
    if (getProperties(c, name).length > 1) warn('DUPLICATE_PROPERTY', `${name} presente più volte: vale la prima`, name);
  }
  const fatalTime = (name: string): IcsTime | null => {
    const p = getProperty(c, name);
    if (!p) return null;
    const t = readTimeProperty(p);
    if (t.type === 'date-time' && t.zone.kind === 'utc' && getParamValue(p, 'TZID')) {
      warn('TZID_WITH_UTC', `${name} con TZID e suffisso Z: vale UTC`, name);
    }
    return t;
  };
  const softUtc = (name: string): IcsDateTime | null => {
    const p = getProperty(c, name);
    if (!p) return null;
    try {
      const t = readTimeProperty(p);
      if (t.type === 'date-time') return t;
    } catch {
      /* avviso sotto */
    }
    warn('INVALID_PROPERTY_VALUE', `${name} non valido, ignorato`, name);
    return null;
  };
  const softInt = (name: string): number | null => {
    const p = getProperty(c, name);
    if (!p) return null;
    const v = p.value.trim();
    if (/^[+-]?\d+$/.test(v)) return Number(v);
    warn('INVALID_PROPERTY_VALUE', `${name} non è un intero, ignorato`, name);
    return null;
  };

  const start = fatalTime('DTSTART');
  if (!start && c.name === 'VEVENT') {
    throw new IcsValueError('MISSING_PROPERTY', 'VEVENT senza DTSTART', { property: 'DTSTART' });
  }
  const endName = c.name === 'VTODO' ? 'DUE' : 'DTEND';
  const end = fatalTime(endName);
  const durationProp = getProperty(c, 'DURATION');
  const duration = durationProp ? parseDurationValue(durationProp.value, 'DURATION') : null;
  if (end && duration) warn('DTEND_AND_DURATION', `${endName} e DURATION insieme: vale ${endName}`, 'DURATION');
  if (start && end && start.type !== end.type) warn('VALUE_TYPE_MISMATCH', `DTSTART e ${endName} di tipo diverso`, endName);

  const recurrenceIdProp = getProperty(c, 'RECURRENCE-ID');
  const recurrenceId = fatalTime('RECURRENCE-ID');

  const rdates: Array<IcsTime | IcsPeriod> = [];
  for (const p of getProperties(c, 'RDATE')) rdates.push(...readTimeListProperty(p));
  const exdates: IcsTime[] = [];
  for (const p of getProperties(c, 'EXDATE')) {
    try {
      for (const v of readTimeListProperty(p)) {
        if (v.type === 'period') throw new IcsValueError('INVALID_VALUE', 'PERIOD in EXDATE', { property: 'EXDATE' });
        if (start && v.type !== start.type) warn('VALUE_TYPE_MISMATCH', 'EXDATE di tipo diverso da DTSTART', 'EXDATE');
        exdates.push(v);
      }
    } catch {
      warn('INVALID_PROPERTY_VALUE', 'EXDATE non valido, ignorato', 'EXDATE');
    }
  }

  let geo: IcsGeo | null = null;
  const geoProp = getProperty(c, 'GEO');
  if (geoProp) {
    const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*[;,]\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(geoProp.value);
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) geo = { lat: +m[1], lon: +m[2] };
    else warn('INVALID_PROPERTY_VALUE', 'GEO non valido, ignorato', 'GEO');
  }

  const upper = (name: string): string | null => {
    const p = getProperty(c, name);
    return p ? decodeText(p.value).trim().toUpperCase() : null;
  };
  const text = (name: string): string | null => getTextValue(c, name);
  const xText = (name: string): string | null => {
    const v = getTextValue(c, name);
    return v != null && v.trim() !== '' ? v.trim() : null;
  };

  const categories: string[] = [];
  for (const p of getProperties(c, 'CATEGORIES')) categories.push(...splitTextList(p.value).filter((s) => s !== ''));

  const uidText = getTextValue(c, 'UID');
  return {
    componentType: c.name,
    uid: uidText != null && uidText.trim() !== '' ? uidText.trim() : null,
    recurrenceId,
    recurrenceIdRange: recurrenceIdProp ? (getParamValue(recurrenceIdProp, 'RANGE')?.toUpperCase() ?? null) : null,
    start,
    end,
    duration,
    allDay: start?.type === 'date',
    summary: text('SUMMARY'),
    description: text('DESCRIPTION'),
    location: text('LOCATION'),
    url: getProperty(c, 'URL')?.value.trim() ?? null,
    status: upper('STATUS'),
    transp: upper('TRANSP'),
    classification: upper('CLASS'),
    priority: softInt('PRIORITY'),
    sequence: softInt('SEQUENCE'),
    categories,
    color: getProperty(c, 'COLOR')?.value.trim() ?? null,
    geo,
    rrules: getProperties(c, 'RRULE').map((p) => p.value.trim()),
    rdates,
    exdates,
    dtstamp: softUtc('DTSTAMP'),
    created: softUtc('CREATED'),
    lastModified: softUtc('LAST-MODIFIED'),
    organizer: getProperty(c, 'ORGANIZER') ? readAddress(getProperty(c, 'ORGANIZER') as IcsProperty) : null,
    attendees: getProperties(c, 'ATTENDEE').map(readAddress),
    alarms: getSubcomponents(c, 'VALARM'),
    relatedTo: getProperties(c, 'RELATED-TO').map((p) => ({
      uid: decodeText(p.value).trim(),
      relType: (getParamValue(p, 'RELTYPE') ?? 'PARENT').toUpperCase(),
    })),
    caldes: {
      source: xText(X_CALDES.SOURCE),
      sourceId: xText(X_CALDES.SOURCE_ID),
      legacyId: xText(X_CALDES.LEGACY_ID),
      legacyRrule: xText(X_CALDES.LEGACY_RRULE),
    },
    warnings,
  };
}

// ============================================
// DTO legacy dell'API (CalendarEvent)
// ============================================

export type LegacyEventStatus = 'confirmed' | 'tentative' | 'cancelled';
export type LegacyEventSource = 'manual' | 'booking' | 'admin' | 'mcp' | 'agent' | 'ics_pull' | 'system';

/** Titolo degli eventi senza SUMMARY nei JSON legacy (stessa convenzione di ics-import e della proiezione inversa). */
export const UNTITLED_SUMMARY = '(senza titolo)';

/**
 * Campi di CalendarEvent (apps/api/src/lib/calendar/types.ts) che derivano dal
 * componente iCalendar. id, calendar_id, source, source_id, created_at e
 * updated_at li aggiunge l'API (cal_object_ids, sidecar, deriveProvenance,
 * indice).
 */
export interface LegacyEventFields {
  /** UID del componente: per gli override è quello del master (differenza ammessa n. 1, RFC 5545). */
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  /** ISO UTC (toISOString). All-day: mezzanotte locale del calendario. */
  start_time: string;
  /** ISO UTC. Timed senza DTEND né DURATION: uguale a start_time (durata nulla, RFC 5545). All-day: fine esclusiva. */
  end_time: string;
  all_day: boolean;
  /** Valore grezzo della prima RRULE, senza prefisso. */
  rrule: string | null;
  /** Istanti ISO UTC delle EXDATE (DATE → mezzanotte locale). */
  exdates: string[];
  /** Istante ISO UTC del RECURRENCE-ID (DATE → mezzanotte locale), o null per il master. */
  recurrence_id: string | null;
  status: LegacyEventStatus;
}

/** STATUS iCalendar → stato legacy: CANCELLED, TENTATIVE, altrimenti confirmed (anche assente o non standard). */
export function legacyStatusOf(status: string | null | undefined): LegacyEventStatus {
  const s = (status ?? '').trim().toUpperCase();
  if (s === 'CANCELLED') return 'cancelled';
  if (s === 'TENTATIVE') return 'tentative';
  return 'confirmed';
}

export interface LegacyMappingContext extends ZoneContext {
  /** Raccoglie gli avvisi di decodifica e di conversione (UNKNOWN_TZID, END_BEFORE_START, ...). */
  onWarning?: (w: IcsWarning) => void;
}

function emptyToNull(s: string | null): string | null {
  return s == null || s === '' ? null : s;
}

/**
 * Componente → campi del DTO evento dell'API, con le convenzioni attuali:
 * istanti ISO UTC, all-day come mezzanotte locale del fuso del calendario con
 * `all_day=true` e fine esclusiva, stato in minuscolo, titolo vuoto →
 * UNTITLED_SUMMARY, stringhe vuote → null. Lancia IcsValueError se mancano
 * UID o DTSTART o se i tempi non sono validi.
 */
export function toLegacyEventFields(c: IcsComponent, ctx: LegacyMappingContext): LegacyEventFields {
  const view = readEvent(c);
  const emit = ctx.onWarning ?? (() => undefined);
  for (const w of view.warnings) emit({ ...w, uid: view.uid });
  if (!view.uid) throw new IcsValueError('MISSING_PROPERTY', `${c.name} senza UID`, { property: 'UID' });
  if (!view.start) throw new IcsValueError('MISSING_PROPERTY', `${c.name} senza DTSTART`, { property: 'DTSTART' });
  const zctx: ZoneContext = { tz: ctx.tz || DEFAULT_TZ, timezones: ctx.timezones };
  const checkZone = (t: IcsTime | null, property: string): void => {
    if (t && t.type === 'date-time' && t.zone.kind === 'tzid' && resolveZone(t.zone, zctx).fallback) {
      emit({ code: 'UNKNOWN_TZID', message: `TZID "${t.zone.tzid.slice(0, 60)}" sconosciuto: interpretato nel fuso del calendario`, property, uid: view.uid });
    }
  };
  checkZone(view.start, 'DTSTART');
  checkZone(view.end, 'DTEND');
  checkZone(view.recurrenceId, 'RECURRENCE-ID');

  let startIso: string;
  let endIso: string;
  if (view.start.type === 'date') {
    const range = allDayRangeFromIcs(view.start, view.end, view.end ? null : view.duration, zctx);
    const legacy = rangeToLegacyAllDay(range, zctx.tz);
    startIso = legacy.start_time;
    endIso = legacy.end_time;
  } else {
    const startMs = timeToUtcMs(view.start, zctx);
    let endMs = startMs;
    if (view.end) endMs = timeToUtcMs(view.end, zctx);
    else if (view.duration) endMs = timeToUtcMs(addDurationToTime(view.start, view.duration, zctx), zctx);
    if (endMs < startMs) {
      emit({ code: 'END_BEFORE_START', message: 'Fine precedente all\'inizio: durata nulla', property: 'DTEND', uid: view.uid });
      endMs = startMs;
    }
    startIso = new Date(startMs).toISOString();
    endIso = new Date(endMs).toISOString();
  }
  return {
    uid: view.uid,
    summary: view.summary != null && view.summary.trim() !== '' ? view.summary : UNTITLED_SUMMARY,
    description: emptyToNull(view.description),
    location: emptyToNull(view.location),
    url: emptyToNull(view.url),
    start_time: startIso,
    end_time: endIso,
    all_day: view.allDay,
    rrule: view.rrules[0] ?? null,
    exdates: view.exdates.map((t) => timeToIso(t, zctx)),
    recurrence_id: view.recurrenceId ? timeToIso(view.recurrenceId, zctx) : null,
    status: legacyStatusOf(view.status),
  };
}

/** Input di buildEventFromLegacy: la forma di CreateEventInput/CalendarEvent dell'API. */
export interface LegacyEventInput {
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  /** ISO. */
  start_time: string;
  /** ISO. */
  end_time: string;
  all_day?: boolean;
  /** RRULE senza prefisso, come in calendar_events.rrule. */
  rrule?: string | null;
  /** Istanti ISO, come in calendar_events.exdates. */
  exdates?: readonly string[] | null;
  /** Istante ISO dell'occorrenza sostituita: costruisce un override. */
  recurrence_id?: string | null;
  status?: LegacyEventStatus;
  /** Scritta in X-CALDES-SOURCE (informativa: la provenienza la decidono collezione e href). */
  source?: LegacyEventSource | null;
  /** Scritta in X-CALDES-SOURCE-ID. */
  source_id?: string | null;
  /** Scritta in X-CALDES-LEGACY-ID (id della riga calendar_events). */
  legacy_id?: string | null;
}

export interface LegacyBuildContext {
  /** Fuso del calendario: singoli timed (TZID) e date degli all-day. */
  tz: string;
  /**
   * Fuso delle serie timed (master con RRULE e override). Default `tz`. La
   * migrazione passa LEGACY_SERIES_TZ (Europe/Rome), il fuso in cui il codice
   * legacy espande; per i nuovi eventi dell'API vale il fuso del calendario.
   */
  seriesTz?: string;
  /** DTSTAMP (e default di CREATED/LAST-MODIFIED se `stampCreated`). */
  now: Date;
  /** DTSTART del master, per scrivere RECURRENCE-ID dello stesso tipo e fuso (design §8). */
  masterStart?: IcsTime | null;
  created?: Date | null;
  lastModified?: Date | null;
  sequence?: number | null;
}

function isoMs(value: string, what: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new IcsValueError('INVALID_ISO', `${what} non è un istante ISO valido: "${String(value).slice(0, 40)}"`, { value });
  return ms;
}

function utcStamp(d: Date): string {
  return formatTimeValue({ type: 'date-time', ...msToWall(d.getTime()), zone: { kind: 'utc' } });
}

/**
 * RRULE legacy → RRULE valida per DTSTART tipizzato (Radicale rifiuta un
 * UNTIL di tipo diverso da DTSTART), conservando la semantica del codice
 * legacy, che espande in ora locale:
 * - all-day: UNTIL istante → UNTIL DATE (legacyUntilToDate);
 * - timed: UNTIL DATE o floating → istante UTC della stessa ora locale nel
 *   fuso della serie (UNTIL=20261231 per il legacy è la mezzanotte del 31,
 *   quindi esclude le occorrenze di quel giorno: parità, la correzione di
 *   "fino al" esce dopo il cutover, design §14).
 */
export function normalizeLegacyRrule(
  rrule: string,
  opts: { allDay: boolean; tz: string; startSecondsOfDay?: number },
): string {
  const body = rrule.trim().replace(/^RRULE:/i, '');
  return body
    .split(';')
    .filter((part) => part.trim() !== '')
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0 || part.slice(0, eq).trim().toUpperCase() !== 'UNTIL') return part.trim();
      const raw = part.slice(eq + 1).trim();
      if (opts.allDay) {
        if (DATE_VALUE_RE.test(raw)) return `UNTIL=${raw}`;
        const t = parseDateTimeValue(raw, null, 'RRULE');
        const ms = t.zone.kind === 'utc' ? wallToMs(clampWall(t)) : zonedToUtc(clampWall(t), ianaZone(opts.tz));
        const date = legacyUntilToDate(ms, opts.startSecondsOfDay ?? 0, opts.tz);
        return `UNTIL=${date.replace(/-/g, '')}`;
      }
      if (/Z$/i.test(raw)) return `UNTIL=${raw.toUpperCase()}`;
      const t = DATE_VALUE_RE.test(raw)
        ? ({ ...parseDateValue(raw, 'RRULE'), type: 'date-time', hour: 0, minute: 0, second: 0, zone: { kind: 'floating' } } as IcsDateTime)
        : parseDateTimeValue(raw, null, 'RRULE');
      const ms = zonedToUtc(clampWall(t), ianaZone(opts.tz));
      return `UNTIL=${formatTimeValue({ type: 'date-time', ...msToWall(ms), zone: { kind: 'utc' } })}`;
    })
    .join(';');
}

function timedValue(ms: number, tzName: string): IcsDateTime {
  const zone = ianaZone(tzName);
  if (zone.kind === 'utc') return { type: 'date-time', ...msToWall(ms), zone: { kind: 'utc' } };
  return { type: 'date-time', ...utcToZoned(ms, zone), zone: { kind: 'tzid', tzid: tzName } };
}

/**
 * Campi del DTO legacy → VEVENT, con le convenzioni del design §5 e §13.5:
 * timed singoli con TZID del calendario, serie timed (e loro override) con
 * TZID di `seriesTz`, all-day come VALUE=DATE con DTEND esclusivo (anche per
 * EXDATE, RECURRENCE-ID e UNTIL), STATUS sempre esplicito, X-CALDES-* per la
 * provenienza informativa. Nessun TRANSP: i timed valgono OPAQUE, gli all-day
 * restano non bloccanti (decisione 6). Non applica le normalizzazioni delle
 * guardie API (trim, tagli a 500/5000 caratteri): le fa lo store prima di
 * chiamarla, come oggi createEvent.
 */
export function buildEventFromLegacy(input: LegacyEventInput, ctx: LegacyBuildContext): IcsComponent {
  try {
    const tz = ctx.tz || DEFAULT_TZ;
    const startMs = isoMs(input.start_time, 'start_time');
    isoMs(input.end_time, 'end_time');
    const isSeries = Boolean(input.rrule) || Boolean(input.recurrence_id);
    const props: IcsProperty[] = [];
    props.push({ name: 'UID', params: [], value: encodeText(input.uid) });
    props.push({ name: 'DTSTAMP', params: [], value: utcStamp(ctx.now) });
    if (ctx.created) props.push({ name: 'CREATED', params: [], value: utcStamp(ctx.created) });
    if (ctx.lastModified) props.push({ name: 'LAST-MODIFIED', params: [], value: utcStamp(ctx.lastModified) });
    if (ctx.sequence != null) props.push({ name: 'SEQUENCE', params: [], value: String(Math.max(0, Math.trunc(ctx.sequence))) });

    let like: IcsTime;
    let rrule: string | null = null;
    const exdateValues: IcsTime[] = [];
    if (input.all_day) {
      const range = legacyAllDayToRange(input.start_time, input.end_time, tz);
      const dtstart = stringToIcsDate(range.start);
      like = dtstart;
      props.push(createTimeProperty('DTSTART', dtstart));
      props.push(createTimeProperty('DTEND', stringToIcsDate(range.end)));
      if (input.rrule) {
        rrule = normalizeLegacyRrule(input.rrule, { allDay: true, tz, startSecondsOfDay: localSecondsOfDay(startMs, tz) });
      }
      for (const ex of input.exdates ?? []) exdateValues.push(stringToIcsDate(legacyAllDayPointToDate(ex, tz)));
    } else {
      const zoneName = isSeries ? ctx.seriesTz || tz : tz;
      const dtstart = timedValue(startMs, zoneName);
      like = dtstart;
      props.push(createTimeProperty('DTSTART', dtstart));
      props.push(createTimeProperty('DTEND', timedValue(isoMs(input.end_time, 'end_time'), zoneName)));
      if (input.rrule) rrule = normalizeLegacyRrule(input.rrule, { allDay: false, tz: zoneName });
      for (const ex of input.exdates ?? []) exdateValues.push(timedValue(isoMs(ex, 'exdate'), zoneName));
    }

    if (input.recurrence_id) {
      const target = ctx.masterStart ?? like;
      const rid =
        target.type === 'date'
          ? stringToIcsDate(legacyAllDayPointToDate(input.recurrence_id, tz))
          : utcMsToTime(isoMs(input.recurrence_id, 'recurrence_id'), target, { tz });
      props.push(createTimeProperty('RECURRENCE-ID', rid));
    }

    if (input.summary !== '') props.push({ name: 'SUMMARY', params: [], value: encodeText(input.summary) });
    if (input.description) props.push({ name: 'DESCRIPTION', params: [], value: encodeText(input.description) });
    if (input.location) props.push({ name: 'LOCATION', params: [], value: encodeText(input.location) });
    if (input.url) props.push({ name: 'URL', params: [], value: input.url.replace(/[\r\n]+/g, '') });
    if (rrule) props.push({ name: 'RRULE', params: [], value: rrule });
    if (exdateValues.length > 0) props.push(...createTimeListProperties('EXDATE', dedupeTimes(exdateValues)));
    props.push({ name: 'STATUS', params: [], value: (input.status ?? 'confirmed').toUpperCase() });
    if (input.source) props.push({ name: X_CALDES.SOURCE, params: [], value: encodeText(input.source) });
    if (input.source_id) props.push({ name: X_CALDES.SOURCE_ID, params: [], value: encodeText(input.source_id) });
    if (input.legacy_id) props.push({ name: X_CALDES.LEGACY_ID, params: [], value: encodeText(input.legacy_id) });
    return { name: 'VEVENT', properties: props, components: [] };
  } catch (err) {
    throw toCoreError(err, 'buildEventFromLegacy');
  }
}

function dedupeTimes(values: IcsTime[]): IcsTime[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = `${formatTimeValue(v)}|${JSON.stringify(timeParams(v))}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================
// Provenienza (design §5)
// ============================================

/** Ruolo del calendario nel sidecar (migrazione 162). */
export type CalendarRole = 'user' | 'bookings' | 'holidays' | 'deadlines' | 'subscription' | 'tasks';

/** X-prop della provenienza scritte dall'API e dalla migrazione. */
export const X_CALDES = {
  SOURCE: 'X-CALDES-SOURCE',
  SOURCE_ID: 'X-CALDES-SOURCE-ID',
  LEGACY_ID: 'X-CALDES-LEGACY-ID',
  LEGACY_RRULE: 'X-CALDES-LEGACY-RRULE',
} as const;

/** Source che un client (admin, MCP, agente) può dichiarare: mai booking, system o ics_pull. */
export const CLIENT_SOURCES = ['manual', 'admin', 'mcp', 'agent'] as const;
export type ClientSource = (typeof CLIENT_SOURCES)[number];

export function isClientSource(value: unknown): value is ClientSource {
  return typeof value === 'string' && (CLIENT_SOURCES as readonly string[]).includes(value);
}

/** Dominio degli UID degli inviti e delle proiezioni delle prenotazioni (come ics.ts). */
export const BOOKING_UID_DOMAIN = 'caldes.it';

export type ObjectHrefKind = 'booking' | 'holiday' | 'closure' | 'remote' | 'other';

export interface ObjectHrefInfo {
  /** Ultimo segmento dell'href, decodificato. */
  basename: string;
  kind: ObjectHrefKind;
  /** booking-<uid>.ics → uid della prenotazione. */
  bookingUid: string | null;
  /** it-holiday-YYYY-MM-DD.ics → data. */
  holidayDate: DateString | null;
  /** closure-<id>.ics → id. */
  closureId: string | null;
}

const BOOKING_HREF_RE = /^booking-([A-Za-z0-9_-]+)\.ics$/;
const HOLIDAY_HREF_RE = /^it-holiday-(\d{4}-\d{2}-\d{2})\.ics$/;
const CLOSURE_HREF_RE = /^closure-([A-Za-z0-9_-]+)\.ics$/;
const REMOTE_HREF_RE = /^r-[a-z2-7]{26}\.ics$/;

/** Classifica un href (percorso completo o solo nome) secondo le convenzioni del design §5. */
export function parseObjectHref(href: string): ObjectHrefInfo {
  const last = href.replace(/\/+$/, '').split('/').pop() ?? '';
  let basename = last;
  try {
    basename = decodeURIComponent(last);
  } catch {
    basename = last;
  }
  const booking = BOOKING_HREF_RE.exec(basename);
  if (booking) return { basename, kind: 'booking', bookingUid: booking[1], holidayDate: null, closureId: null };
  const holiday = HOLIDAY_HREF_RE.exec(basename);
  if (holiday) return { basename, kind: 'holiday', bookingUid: null, holidayDate: holiday[1], closureId: null };
  const closure = CLOSURE_HREF_RE.exec(basename);
  if (closure) return { basename, kind: 'closure', bookingUid: null, holidayDate: null, closureId: closure[1] };
  if (REMOTE_HREF_RE.test(basename)) return { basename, kind: 'remote', bookingUid: null, holidayDate: null, closureId: null };
  return { basename, kind: 'other', bookingUid: null, holidayDate: null, closureId: null };
}

/** Href della proiezione di una prenotazione. */
export function bookingHref(bookingUid: string): string {
  return `booking-${bookingUid}.ics`;
}

/** UID della proiezione e dell'invito di una prenotazione: `<uid>@caldes.it`. */
export function bookingProjectionUid(bookingUid: string, domain: string = BOOKING_UID_DOMAIN): string {
  return `${bookingUid}@${domain}`;
}

/** source_id legacy di una festività: it-holiday-YYYY-MM-DD. */
export function holidaySourceId(date: DateString): string {
  return `it-holiday-${date}`;
}

/** Href di una festività. */
export function holidayHref(date: DateString): string {
  return `${holidaySourceId(date)}.ics`;
}

/** UID di una festività nuova: it-holiday-YYYY-MM-DD@caldes.it. */
export function holidayUid(date: DateString, domain: string = BOOKING_UID_DOMAIN): string {
  return `${holidaySourceId(date)}@${domain}`;
}

/** Href di una chiusura. */
export function closureHref(id: string): string {
  return `closure-${id}.ics`;
}

export interface Provenance {
  source: LegacyEventSource;
  source_id: string | null;
}

/**
 * Provenienza di un item, solo da ruolo della collezione e href (design §5):
 * - bookings + booking-* → booking, uid della prenotazione;
 * - holidays + it-holiday-* → system, it-holiday-YYYY-MM-DD;
 * - subscription → ics_pull, UID remoto;
 * - holidays (altri) → X-CALDES-SOURCE ammessa, altrimenti admin;
 * - bookings (altri), user, deadlines, tasks → X-CALDES-SOURCE ammessa, altrimenti manual.
 * Una X-prop non promuove mai un evento a booking, system o ics_pull.
 *
 * Per le source di questi ultimi due casi `source_id` è X-CALDES-SOURCE-ID,
 * se presente: il legacy accetta un source_id dal client e "Duplica" scrive
 * source=admin con source_id = id dell'originale, e list_events li espone
 * (contratto MCP invariato, f2-modules §14.1). Un source_id da X-prop non ha
 * alcun effetto semantico: booking e system dipendono solo da collezione e href.
 */
export function deriveProvenance(input: {
  role: CalendarRole;
  href: string;
  component?: IcsComponent | null;
  uid?: string | null;
}): Provenance {
  const info = parseObjectHref(input.href);
  if (input.role === 'bookings' && info.kind === 'booking') return { source: 'booking', source_id: info.bookingUid };
  if (input.role === 'holidays' && info.kind === 'holiday') return { source: 'system', source_id: holidaySourceId(info.holidayDate as string) };
  if (input.role === 'subscription') {
    const uid = input.uid ?? (input.component ? getTextValue(input.component, 'UID')?.trim() ?? null : null);
    return { source: 'ics_pull', source_id: uid || null };
  }
  const declared = input.component ? getTextValue(input.component, X_CALDES.SOURCE)?.trim().toLowerCase() : undefined;
  const declaredId = input.component ? getTextValue(input.component, X_CALDES.SOURCE_ID)?.trim() : undefined;
  const sourceId = declaredId ? declaredId : null;
  if (isClientSource(declared)) return { source: declared, source_id: sourceId };
  return { source: input.role === 'holidays' ? 'admin' : 'manual', source_id: sourceId };
}

/** Scrive (o con null rimuove) le X-CALDES-* della provenienza informativa. */
export function setProvenance(c: IcsComponent, prov: { source?: string | null; sourceId?: string | null; legacyId?: string | null }): void {
  if (prov.source !== undefined) setTextValue(c, X_CALDES.SOURCE, prov.source);
  if (prov.sourceId !== undefined) setTextValue(c, X_CALDES.SOURCE_ID, prov.sourceId);
  if (prov.legacyId !== undefined) setTextValue(c, X_CALDES.LEGACY_ID, prov.legacyId);
}

// ============================================
// Occorrenze: tipo e regola "blocks" (design §4 e §9)
// ============================================

/** Valori di cal_occurrences.kind. */
export type OccurrenceKind =
  | 'event'
  | 'override'
  | 'orphan_override'
  | 'conservative'
  | 'booking_projection'
  | 'holiday_system'
  | 'closure';

/** Tipo prodotto dall'espansione, prima della classificazione per collezione e href. */
export type ExpansionKind = 'event' | 'override' | 'orphan_override' | 'conservative';

/**
 * Tipo finale di un'occorrenza: le proiezioni booking-* nella collezione
 * bookings prevalgono su tutto (non bloccano mai, design §9); conservative e
 * orphan_override restano tali (segnali di salute); nelle festività gli
 * it-holiday-* sono holiday_system e gli altri item closure.
 */
export function classifyOccurrenceKind(role: CalendarRole, href: string, kind: ExpansionKind): OccurrenceKind {
  const info = parseObjectHref(href);
  if (role === 'bookings' && info.kind === 'booking') return 'booking_projection';
  if (kind === 'conservative' || kind === 'orphan_override') return kind;
  if (role === 'holidays') return info.kind === 'holiday' ? 'holiday_system' : 'closure';
  return kind;
}

export interface BlocksInput {
  componentType: string;
  /** STATUS in maiuscolo o null. */
  status: string | null;
  /** TRANSP esplicito in maiuscolo o null. */
  transp: string | null;
  allDay: boolean;
  kind: OccurrenceKind;
}

export interface BlocksOptions {
  /**
   * Decisione 6: un all-day blocca solo con TRANSP:OPAQUE esplicito, ma la
   * regola si attiva nella release successiva alla verifica nella matrice
   * device (F3/F5). Fino ad allora (default false) gli all-day non bloccano
   * mai, come oggi (getBusyRanges esclude gli all_day).
   */
  allDayOpaqueBlocks?: boolean;
}

/**
 * Regola `blocks` dell'indicizzatore (design §9): VEVENT, STATUS CONFIRMED o
 * assente, TRANSP diverso da TRANSPARENT, timed (o all-day secondo la
 * decisione 6), kind diverso da booking_projection. Per un'occorrenza
 * `conservative` il chiamante passa le proprietà del master. I flag dei
 * calendari (blocks_availability) si applicano a query time.
 */
export function computeBlocks(input: BlocksInput, opts: BlocksOptions = {}): boolean {
  if (input.componentType.toUpperCase() !== 'VEVENT') return false;
  if (input.kind === 'booking_projection') return false;
  const status = (input.status ?? 'CONFIRMED').toUpperCase();
  if (status !== 'CONFIRMED') return false;
  const transp = input.transp?.toUpperCase() ?? null;
  if (transp === 'TRANSPARENT') return false;
  if (input.allDay) return Boolean(opts.allDayOpaqueBlocks) && transp === 'OPAQUE';
  return true;
}

// ============================================
// Utilità per le date dell'indice
// ============================================

/**
 * Data di inizio e di fine (esclusiva) di un'occorrenza all-day per le colonne
 * start_date/end_date di cal_occurrences, dalle date iCalendar.
 */
export function occurrenceDates(start: IcsDate, endExclusive: IcsDate): { start_date: DateString; end_date: DateString } {
  const s = icsDateToString(start);
  let e = icsDateToString(endExclusive);
  if (compareDates(e, s) <= 0) e = addDays(s, 1);
  return { start_date: s, end_date: e };
}

/** Data 'YYYY-MM-DD' da un IcsDate (riesportata per comodità dei consumatori del modello). */
export function dateOf(d: IcsDate): DateString {
  return dateFromParts(d.year, d.month, d.day);
}
