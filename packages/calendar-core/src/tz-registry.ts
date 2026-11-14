/**
 * Registro dei fusi: VTIMEZONE canonici, risoluzione dei TZID e conversioni
 * fra ora locale e istante UTC.
 *
 * Regole (design §5, "Fusi"):
 * - TZID IANA (anche in minuscolo, alias come US/Eastern, o con i prefissi
 *   legacy di Mozilla/Lightning come "/mozilla.org/20050126_1/Europe/Rome"):
 *   la semantica viene da Intl (tzdata dell'ICU, con la storia completa) e in
 *   serializzazione si usa il VTIMEZONE canonico del registro
 *   (timezones-ical-library 2.3.2, pinnato), mai quello scritto dal client.
 * - TZID non IANA (nomi Windows di Outlook/Exchange, nomi visualizzati come
 *   "(UTC+01:00) Amsterdam, Berlin, ...", etichette "GMT+01:00"): la mappa
 *   CLDR windowsZones porta all'equivalente IANA per la semantica, mentre in
 *   serializzazione resta il VTIMEZONE dell'oggetto (se c'è).
 * - TZID sconosciuto con VTIMEZONE nell'oggetto: semantica dal VTIMEZONE
 *   tramite ical.js (`kind: 'custom'`).
 * - TZID sconosciuto senza VTIMEZONE: `kind: 'unknown'`; i chiamanti lo
 *   interpretano nel fuso del calendario e lo segnalano (UNKNOWN_TZID).
 * - Floating (nessun TZID, nessuna Z): si interpreta nel fuso del calendario.
 *
 * Ora locale inesistente o ambigua (RFC 5545 §3.3.5): un orario nel buco del
 * passaggio all'ora legale usa l'offset precedente al buco (02:30 del 29/03
 * a Roma → 03:30 CEST); un orario ripetuto al ritorno all'ora solare indica la
 * prima occorrenza (02:30 del 25/10 → 02:30 CEST). ical.js fa il contrario in
 * entrambi i casi, quindi le conversioni non passano da ical.js tranne che per
 * leggere gli offset dei VTIMEZONE non IANA.
 */

import ICAL from 'ical.js';
import { tzlib_get_ical_block, tzlib_get_timezones } from 'timezones-ical-library';
import { TimezoneError, toCoreError } from './errors';
import { componentLines, CRLF, vtimezoneTzid } from './ics-text';
import type { IcsComponent, IcsZone } from './model';
import { parseComponents } from './parse';

/** Fuso predefinito del calendario (calendars.timezone di default) e dei JSON legacy/MCP. */
export const DEFAULT_TZ = 'Europe/Rome';

/**
 * Fuso in cui il codice legacy espande le serie (rrule.ts lo usa sempre, a
 * prescindere da calendars.timezone): i master timed migrati vanno scritti con
 * TZID=Europe/Rome (design §13.5).
 */
export const LEGACY_SERIES_TZ = 'Europe/Rome';

/** Origine dei VTIMEZONE canonici: cambia solo con un aggiornamento esplicito della dipendenza. */
export const CANONICAL_TZ_SOURCE = 'timezones-ical-library@2.3.2';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Ora "da muro" in un fuso (mese 1-12). */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Fuso utilizzabile per le conversioni. */
export type ConvertibleZone =
  | { kind: 'utc' }
  | { kind: 'iana'; iana: string }
  | { kind: 'custom'; tzid: string; vtimezone: IcsComponent };

/** Come un TZID è stato ricondotto a una zona IANA. */
export type TzidSource =
  /** Nome IANA esatto (o alias che Intl accetta con lo stesso nome). */
  | 'exact'
  /** Nome IANA con maiuscole diverse ("europe/rome"). */
  | 'case-insensitive'
  /** Alias IANA (US/Eastern → America/New_York). */
  | 'alias'
  /** Prefisso legacy rimosso ("/mozilla.org/20050126_1/Europe/Rome"). */
  | 'prefix'
  /** Nome Windows ("W. Europe Standard Time"). */
  | 'windows'
  /** Nome visualizzato di Outlook ("(UTC+01:00) Amsterdam, Berlin, ..."). */
  | 'windows-display'
  /** Etichetta di offset fisso ("GMT+01:00", "UTC-5"). */
  | 'offset';

export type TzResolution =
  | {
      kind: 'iana';
      /** TZID così come è scritto nell'oggetto. */
      tzid: string;
      /** Nome IANA usato con Intl. */
      iana: string;
      via: TzidSource;
      /** VTIMEZONE dell'oggetto con lo stesso TZID, se presente. */
      vtimezone: IcsComponent | null;
    }
  | { kind: 'custom'; tzid: string; vtimezone: IcsComponent }
  | { kind: 'unknown'; tzid: string };

/** True se la risoluzione è un nome IANA "vero" (il VTIMEZONE canonico sostituisce quello dell'oggetto). */
export function isIanaTzid(res: TzResolution): boolean {
  return res.kind === 'iana' && (res.via === 'exact' || res.via === 'case-insensitive' || res.via === 'alias' || res.via === 'prefix');
}

// ============================================
// Nomi Windows (CLDR windowsZones, territorio 001)
// ============================================

const WINDOWS_TO_IANA: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Aleutian Standard Time': 'America/Adak',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Marquesas Standard Time': 'Pacific/Marquesas',
  'Alaskan Standard Time': 'America/Anchorage',
  'UTC-09': 'Etc/GMT+9',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'UTC-08': 'Etc/GMT+8',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Mazatlan',
  'Mountain Standard Time': 'America/Denver',
  'Yukon Standard Time': 'America/Whitehorse',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago',
  'Easter Island Standard Time': 'Pacific/Easter',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Mexico Standard Time': 'America/Mexico_City',
  'Mexico Standard Time 2': 'America/Chihuahua',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Eastern Standard Time': 'America/New_York',
  'Haiti Standard Time': 'America/Port-au-Prince',
  'Cuba Standard Time': 'America/Havana',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Turks And Caicos Standard Time': 'America/Grand_Turk',
  'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax',
  'Venezuela Standard Time': 'America/Caracas',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Tocantins Standard Time': 'America/Araguaina',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Greenland Standard Time': 'America/Nuuk',
  'Montevideo Standard Time': 'America/Montevideo',
  'Magallanes Standard Time': 'America/Punta_Arenas',
  'Saint Pierre Standard Time': 'America/Miquelon',
  'Bahia Standard Time': 'America/Bahia',
  'UTC-02': 'Etc/GMT+2',
  'Mid-Atlantic Standard Time': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  UTC: 'Etc/UTC',
  'Coordinated Universal Time': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Sao Tome Standard Time': 'Africa/Sao_Tome',
  'Morocco Standard Time': 'Africa/Casablanca',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Jordan Standard Time': 'Asia/Amman',
  'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Syria Standard Time': 'Asia/Damascus',
  'West Bank Standard Time': 'Asia/Hebron',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Sudan Standard Time': 'Africa/Juba',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Sudan Standard Time': 'Africa/Khartoum',
  'Libya Standard Time': 'Africa/Tripoli',
  'Namibia Standard Time': 'Africa/Windhoek',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk',
  'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Volgograd Standard Time': 'Europe/Volgograd',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Russia Time Zone 3': 'Europe/Samara',
  'Mauritius Standard Time': 'Indian/Mauritius',
  'Saratov Standard Time': 'Europe/Saratov',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Armenian Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Pakistan Standard Time': 'Asia/Karachi',
  'Qyzylorda Standard Time': 'Asia/Qyzylorda',
  'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Omsk Standard Time': 'Asia/Omsk',
  'Myanmar Standard Time': 'Asia/Yangon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Altai Standard Time': 'Asia/Barnaul',
  'W. Mongolia Standard Time': 'Asia/Hovd',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'Tomsk Standard Time': 'Asia/Tomsk',
  'China Standard Time': 'Asia/Shanghai',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Aus Central W. Standard Time': 'Australia/Eucla',
  'Transbaikal Standard Time': 'Asia/Chita',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'North Korea Standard Time': 'Asia/Pyongyang',
  'Korea Standard Time': 'Asia/Seoul',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Lord Howe Standard Time': 'Australia/Lord_Howe',
  'Bougainville Standard Time': 'Pacific/Bougainville',
  'Russia Time Zone 10': 'Asia/Srednekolymsk',
  'Magadan Standard Time': 'Asia/Magadan',
  'Norfolk Standard Time': 'Pacific/Norfolk',
  'Sakhalin Standard Time': 'Asia/Sakhalin',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'Kamchatka Standard Time': 'Asia/Kamchatka',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC+12': 'Etc/GMT-12',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Chatham Islands Standard Time': 'Pacific/Chatham',
  'UTC+13': 'Etc/GMT-13',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia',
  'Line Islands Standard Time': 'Pacific/Kiritimati',
};

/**
 * Nomi visualizzati di Outlook (vecchie versioni li scrivono come TZID),
 * normalizzati da normalizeDisplayName, verso il nome Windows. Copre i fusi
 * europei e nordamericani più comuni; gli altri ricadono sul VTIMEZONE
 * dell'oggetto, che resta comunque la fonte della semantica.
 */
const DISPLAY_TO_WINDOWS: Record<string, string> = {
  'amsterdam,berlin,bern,rome,stockholm,vienna': 'W. Europe Standard Time',
  'belgrade,bratislava,budapest,ljubljana,prague': 'Central Europe Standard Time',
  'brussels,copenhagen,madrid,paris': 'Romance Standard Time',
  'sarajevo,skopje,warsaw,zagreb': 'Central European Standard Time',
  'dublin,edinburgh,lisbon,london': 'GMT Standard Time',
  'greenwich mean time:dublin,edinburgh,lisbon,london': 'GMT Standard Time',
  'monrovia,reykjavik': 'Greenwich Standard Time',
  'athens,bucharest': 'GTB Standard Time',
  'athens,bucharest,istanbul': 'GTB Standard Time',
  'helsinki,kyiv,riga,sofia,tallinn,vilnius': 'FLE Standard Time',
  'helsinki,kiev,riga,sofia,tallinn,vilnius': 'FLE Standard Time',
  'moscow,st petersburg': 'Russian Standard Time',
  'moscow,st petersburg,volgograd': 'Russian Standard Time',
  'eastern time (us & canada)': 'Eastern Standard Time',
  'central time (us & canada)': 'Central Standard Time',
  'mountain time (us & canada)': 'Mountain Standard Time',
  'pacific time (us & canada)': 'Pacific Standard Time',
  'coordinated universal time': 'UTC',
  'jerusalem': 'Israel Standard Time',
  'cairo': 'Egypt Standard Time',
  'istanbul': 'Turkey Standard Time',
};

function normalizeDisplayName(tzid: string): string | null {
  const m = /^\s*\((?:UTC|GMT)\s*(?:[+-]\s*\d{1,2}(?:[:.]\d{2})?)?\)\s*(.+)$/i.exec(tzid);
  if (!m) return null;
  return m[1]
    .split(/\s*[,/]\s*/)
    .map((s) => s.trim().toLowerCase().replace(/\./g, ''))
    .filter(Boolean)
    .join(',');
}

/**
 * Valore di una tabella letterale solo per le chiavi proprie: le chiavi
 * arrivano da TZID scritti da device e feed, e 'constructor', 'toString' o
 * '__proto__' restituirebbero funzioni e oggetti del prototype.
 */
function ownValue(table: Record<string, string>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
  const value = table[key];
  return typeof value === 'string' ? value : null;
}

/** Nome IANA equivalente a un nome Windows (case-insensitive), o null. */
export function windowsToIana(name: string): string | null {
  if (typeof name !== 'string') return null;
  const key = name.trim();
  const direct = ownValue(WINDOWS_TO_IANA, key);
  if (direct) return direct;
  const lower = key.toLowerCase();
  for (const [win, iana] of Object.entries(WINDOWS_TO_IANA)) {
    if (win.toLowerCase() === lower) return iana;
  }
  return null;
}

// ============================================
// Nomi IANA (Intl)
// ============================================

const IANA_SHAPE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
/** Le chiavi arrivano anche da TZID scritti da device e feed esterni: cache limitata. */
const CACHE_MAX = 5000;
const ianaCache = new Map<string, string | null>();

/**
 * Nome IANA accettato da Intl (con la forma che Intl usa), o null. Le stringhe
 * di offset ("+01:00") che i motori recenti accettano non sono nomi IANA e
 * vengono rifiutate.
 */
export function ianaName(name: string): string | null {
  if (typeof name !== 'string') return null;
  const key = name.trim();
  const cached = ianaCache.get(key);
  if (cached !== undefined) return cached;
  let resolved: string | null = null;
  if (IANA_SHAPE_RE.test(key)) {
    try {
      resolved = new Intl.DateTimeFormat('en-US', { timeZone: key }).resolvedOptions().timeZone;
    } catch {
      resolved = null;
    }
  }
  if (ianaCache.size >= CACHE_MAX) ianaCache.clear();
  ianaCache.set(key, resolved);
  return resolved;
}

/** True se `name` è un fuso IANA valido per Intl. */
export function isValidIanaZone(name: string): boolean {
  return ianaName(name) != null;
}

function offsetLabelToIana(tzid: string): string | null {
  const m = /^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(tzid.trim());
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = m[3] ? Number(m[3]) : 0;
  if (minutes !== 0 || hours > 14) return null;
  if (hours === 0) return 'Etc/UTC';
  // Etc/GMT ha il segno invertito: UTC+1 è Etc/GMT-1.
  return `Etc/GMT${m[1] === '+' ? '-' : '+'}${hours}`;
}

/**
 * Indice TZID → VTIMEZONE per elenco (il primo per TZID), costruito alla prima
 * ricerca: resolveTzid gira a ogni conversione e una ricerca lineare costava
 * O(riferimenti × VTIMEZONE). Gli elenchi del modello non si modificano sul
 * posto (si sostituiscono): la lunghezza è il controllo di coerenza.
 */
const vtimezoneIndex = new WeakMap<readonly IcsComponent[], { length: number; byTzid: Map<string, IcsComponent> }>();

/** VTIMEZONE di `timezones` con il TZID dato (confronto esatto, spazi esclusi). */
export function findVtimezone(timezones: readonly IcsComponent[] | undefined, tzid: string): IcsComponent | null {
  if (!timezones || timezones.length === 0) return null;
  const want = tzid.trim();
  if (timezones.length <= 4) return timezones.find((tz) => vtimezoneTzid(tz) === want) ?? null;
  let index = vtimezoneIndex.get(timezones);
  if (!index || index.length !== timezones.length) {
    const byTzid = new Map<string, IcsComponent>();
    for (const tz of timezones) {
      const id = vtimezoneTzid(tz);
      if (id != null && !byTzid.has(id)) byTzid.set(id, tz);
    }
    index = { length: timezones.length, byTzid };
    vtimezoneIndex.set(timezones, index);
  }
  const hit = index.byTzid.get(want) ?? null;
  // Un VTIMEZONE il cui TZID è cambiato dopo l'indicizzazione: ricerca lineare.
  if (hit && vtimezoneTzid(hit) !== want) return timezones.find((tz) => vtimezoneTzid(tz) === want) ?? null;
  return hit;
}

/**
 * Risolve un TZID nel contesto dell'oggetto (i suoi VTIMEZONE). Ordine:
 * nome IANA (esatto, maiuscole, alias) → prefisso legacy → nome Windows →
 * nome visualizzato di Outlook → etichetta di offset → VTIMEZONE dell'oggetto
 * → sconosciuto.
 */
export function resolveTzid(tzid: string, timezones?: readonly IcsComponent[]): TzResolution {
  const t = tzid.trim();
  const own = findVtimezone(timezones, t);
  if (!t) return own ? { kind: 'custom', tzid, vtimezone: own } : { kind: 'unknown', tzid };

  const direct = ianaName(t);
  if (direct) {
    const via: TzidSource = direct === t ? 'exact' : direct.toLowerCase() === t.toLowerCase() ? 'case-insensitive' : 'alias';
    return { kind: 'iana', tzid, iana: direct, via, vtimezone: own };
  }
  if (t.includes('/')) {
    const segments = t.split('/').filter(Boolean);
    for (let k = Math.min(3, segments.length); k >= 1; k--) {
      const candidate = segments.slice(-k).join('/');
      if (k === 1 && !/^(UTC|GMT|[A-Z]{3,4}\d?[A-Z]{0,3})$/.test(candidate)) continue;
      const resolved = ianaName(candidate);
      if (resolved) return { kind: 'iana', tzid, iana: resolved, via: 'prefix', vtimezone: own };
    }
  }
  const win = windowsToIana(t);
  if (win && ianaName(win)) return { kind: 'iana', tzid, iana: ianaName(win) as string, via: 'windows', vtimezone: own };
  const display = normalizeDisplayName(t);
  if (display) {
    const winName = ownValue(DISPLAY_TO_WINDOWS, display);
    const iana = winName ? windowsToIana(winName) : null;
    if (iana && ianaName(iana)) return { kind: 'iana', tzid, iana: ianaName(iana) as string, via: 'windows-display', vtimezone: own };
  }
  const fixed = offsetLabelToIana(t);
  if (fixed && ianaName(fixed)) return { kind: 'iana', tzid, iana: ianaName(fixed) as string, via: 'offset', vtimezone: own };
  if (own) return { kind: 'custom', tzid, vtimezone: own };
  return { kind: 'unknown', tzid };
}

/** Zona di conversione per un fuso IANA (lancia UNKNOWN_TIMEZONE se Intl non lo conosce). */
export function ianaZone(name: string): ConvertibleZone {
  const resolved = ianaName(name);
  if (!resolved) throw new TimezoneError('UNKNOWN_TIMEZONE', `Fuso orario sconosciuto: "${name.slice(0, 60)}"`, { tz: name.slice(0, 60) });
  return isUtcName(resolved) ? { kind: 'utc' } : { kind: 'iana', iana: resolved };
}

function isUtcName(iana: string): boolean {
  return /^(?:Etc\/)?(?:UTC|UCT|GMT|Universal|Zulu|Greenwich|GMT[+-]0|GMT0)$/i.test(iana);
}

export interface ZoneResolutionContext {
  /** Fuso IANA del calendario: interpreta floating, DATE e TZID sconosciuti. */
  tz: string;
  /** VTIMEZONE dell'oggetto. */
  timezones?: readonly IcsComponent[];
}

/**
 * Zona di conversione per la zona di un valore DATE-TIME: Z → UTC; floating →
 * fuso del calendario; TZID → resolveTzid. `fallback: true` quando un TZID
 * sconosciuto (né IANA, né mappato, né definito) ricade sul fuso del
 * calendario: chi legge deve segnalarlo (avviso UNKNOWN_TZID).
 */
export function resolveZone(zone: IcsZone, ctx: ZoneResolutionContext): { zone: ConvertibleZone; fallback: boolean } {
  if (zone.kind === 'utc') return { zone: { kind: 'utc' }, fallback: false };
  if (zone.kind === 'floating') return { zone: ianaZone(ctx.tz), fallback: false };
  const res = resolveTzid(zone.tzid, ctx.timezones);
  if (res.kind === 'iana') return { zone: isUtcName(res.iana) ? { kind: 'utc' } : { kind: 'iana', iana: res.iana }, fallback: false };
  if (res.kind === 'custom') return { zone: { kind: 'custom', tzid: res.tzid, vtimezone: res.vtimezone }, fallback: false };
  return { zone: ianaZone(ctx.tz), fallback: true };
}

// ============================================
// VTIMEZONE canonici (timezones-ical-library)
// ============================================

let tzlibIndex: Map<string, string> | null = null;
const canonicalCache = new Map<string, IcsComponent | null>();

function tzlibNames(): Map<string, string> {
  if (!tzlibIndex) {
    const list = tzlib_get_timezones();
    const names = Array.isArray(list) ? list : (JSON.parse(list) as string[]);
    tzlibIndex = new Map(names.map((n) => [n.toLowerCase(), n]));
  }
  return tzlibIndex;
}

/** Nomi IANA per cui il registro ha un VTIMEZONE canonico (alias compresi). */
export function listCanonicalTimezones(): string[] {
  return [...tzlibNames().values()];
}

function cloneTree(c: IcsComponent): IcsComponent {
  return {
    name: c.name,
    properties: c.properties.map((p) => ({ name: p.name, value: p.value, params: p.params.map((x) => ({ name: x.name, values: [...x.values] })) })),
    components: c.components.map(cloneTree),
  };
}

/**
 * VTIMEZONE canonico per un fuso IANA, con la proprietà TZID impostata a
 * `tzid` (default: il nome del registro), così i riferimenti dell'oggetto
 * restano quelli scritti dal client. LAST-MODIFIED viene tolto: il testo
 * canonico dipende solo dalle regole, non dalla data di build della libreria.
 * Restituisce una copia (modificabile) o null se il registro non ha il fuso.
 */
export function canonicalVtimezone(iana: string, tzid?: string): IcsComponent | null {
  const names = tzlibNames();
  const key = names.get(iana.trim().toLowerCase()) ?? names.get((ianaName(iana) ?? '').toLowerCase());
  if (!key) return null;
  let base = canonicalCache.get(key);
  if (base === undefined) {
    base = null;
    try {
      const block = tzlib_get_ical_block(key);
      const text = Array.isArray(block) ? block[0] : '';
      if (text) {
        const parsed = parseComponents(text);
        const vtz = parsed.ok ? parsed.value.find((c) => c.name === 'VTIMEZONE') : undefined;
        if (vtz) {
          vtz.properties = vtz.properties.filter((p) => p.name !== 'LAST-MODIFIED');
          base = vtz;
        }
      }
    } catch {
      base = null;
    }
    canonicalCache.set(key, base);
  }
  if (!base) return null;
  const copy = cloneTree(base);
  const id = (tzid ?? key).trim();
  const tzidProp = copy.properties.find((p) => p.name === 'TZID');
  if (tzidProp) tzidProp.value = id;
  else copy.properties.unshift({ name: 'TZID', params: [], value: id });
  return copy;
}

// ============================================
// Offset e conversioni
// ============================================

/** Istante (ms) di un'ora da muro letta come UTC. Gestisce gli anni 0-99 che Date.UTC sposterebbe al 1900. */
export function wallToMs(w: WallTime): number {
  const d = new Date(Date.UTC(2000, 0, 1, w.hour, w.minute, w.second));
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  return d.getTime();
}

/** Ora da muro UTC di un istante. */
export function msToWall(ms: number): WallTime {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(iana: string): Intl.DateTimeFormat {
  let f = formatterCache.get(iana);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: iana,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatterCache.set(iana, f);
  }
  return f;
}

/** Offset (ms) del fuso IANA all'istante dato, letto da Intl, alla precisione del secondo. */
function intlOffset(iana: string, ms: number): number {
  const t = Math.floor(ms / 1000) * 1000;
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let bc = false;
  for (const part of formatter(iana).formatToParts(new Date(t))) {
    switch (part.type) {
      case 'year': year = Number(part.value); break;
      case 'month': month = Number(part.value); break;
      case 'day': day = Number(part.value); break;
      case 'hour': hour = Number(part.value) % 24; break;
      case 'minute': minute = Number(part.value); break;
      case 'second': second = Number(part.value); break;
      case 'era': bc = /^B/i.test(part.value); break;
      default: break;
    }
  }
  if (bc) year = 1 - year;
  return wallToMs({ year, month, day, hour, minute, second }) - t;
}

interface DayOffsets {
  start: number;
  end: number;
  /** Primo istante (al secondo) con l'offset di fine giornata, se cambia nel giorno. */
  transition: number | null;
}

const DAY_CACHE_MAX = 200_000;
const dayCache = new Map<string, DayOffsets>();

/**
 * Offset IANA con cache per giorno UTC: due letture Intl agli estremi del
 * giorno e, solo se differiscono, una ricerca binaria al secondo
 * dell'istante di transizione. Presuppone al più una transizione per giorno
 * UTC, vero per tutta la tzdata moderna.
 */
function ianaOffset(iana: string, ms: number): number {
  const dayIndex = Math.floor(ms / DAY_MS);
  const key = `${iana}|${dayIndex}`;
  let info = dayCache.get(key);
  if (!info) {
    const t0 = dayIndex * DAY_MS;
    const t1 = t0 + DAY_MS;
    const o0 = intlOffset(iana, t0);
    const o1 = intlOffset(iana, t1);
    let transition: number | null = null;
    if (o0 !== o1) {
      let lo = t0;
      let hi = t1;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (intlOffset(iana, mid) === o0) lo = mid;
        else hi = mid;
      }
      transition = hi;
    }
    info = { start: o0, end: o1, transition };
    if (dayCache.size >= DAY_CACHE_MAX) dayCache.clear();
    dayCache.set(key, info);
  }
  if (info.transition === null) return info.start;
  return ms < info.transition ? info.start : info.end;
}

interface CustomZoneState {
  tz: InstanceType<typeof ICAL.Timezone>;
  /** Transizioni ordinate: istante UTC (ms) e offset (ms) da quell'istante in poi. */
  changes: Array<{ at: number; offset: number; prev: number }>;
  coveredYear: number;
}

const customCache = new Map<string, CustomZoneState>();

// ─── Limiti dei VTIMEZONE non IANA ───
//
// ical.js espande le regole di ogni STANDARD/DAYLIGHT dal suo DTSTART fino
// all'anno richiesto, senza budget: un VTIMEZONE di 340 byte con
// RRULE:FREQ=DAILY o HOURLY (o DTSTART nel 9999) bloccava la CPU per minuti
// nel thread dell'API. Si accettano solo VTIMEZONE di forma reale (regole
// annuali come quelle di Outlook, Apple, Thunderbird e del registro) con un
// costo stimato limitato, e la copertura si ferma a COVERAGE_YEARS_AHEAD anni da
// oggi: oltre, l'offset si legge nell'anno equivalente (stesso giorno della
// settimana del 1° gennaio e stessa bisestilità) dentro la copertura.

/** Sottocomponenti massime di un VTIMEZONE. */
export const VTIMEZONE_MAX_SUBCOMPONENTS = 64;
/** Proprietà massime di un VTIMEZONE, sottocomponenti comprese. */
export const VTIMEZONE_MAX_PROPERTIES = 1000;
/** Valori di RDATE massimi in tutto il VTIMEZONE. */
export const VTIMEZONE_MAX_RDATE_VALUES = 500;
/** Costo massimo stimato delle regole (somma su sottocomponenti di anni da espandere × transizioni per anno). */
export const VTIMEZONE_MAX_RULE_COST = 6_000;
/** Anni di copertura oltre l'anno corrente. */
export const COVERAGE_YEARS_AHEAD = 50;

/** Parti di RRULE vietate nei VTIMEZONE accettati (nessuna regola reale le usa). */
const VTZ_FORBIDDEN_PARTS = new Set(['BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS']);
/** Valori massimi per parte (BYMONTHDAY fino a 7: la forma "domenica dopo l'8"). */
const VTZ_MAX_VALUES: Readonly<Record<string, number>> = { BYMONTH: 2, BYDAY: 7, BYMONTHDAY: 7 };

function coverageCapYear(): number {
  return new Date().getUTCFullYear() + COVERAGE_YEARS_AHEAD;
}

function invalidVtimezone(tzid: string, reason: string): TimezoneError {
  return new TimezoneError('INVALID_VTIMEZONE', `VTIMEZONE "${tzid.slice(0, 60)}" non accettato: ${reason}`, { tzid: tzid.slice(0, 60) });
}

/** Anno (4 cifre iniziali) di un valore DATE/DATE-TIME, o null. */
function yearOfValue(value: string): number | null {
  const m = /^\s*(\d{4})\d{4}/.exec(value);
  return m ? Number(m[1]) : null;
}

/**
 * Verifica la forma di un VTIMEZONE prima di darlo a ical.js (testa della
 * sezione). Lancia TimezoneError('INVALID_VTIMEZONE'): l'indice mette
 * l'oggetto in quarantena 'invalid-timezone' con il blocco conservativo.
 */
export function checkVtimezoneShape(vtz: IcsComponent, tzid: string): void {
  const subs = vtz.components;
  if (subs.length > VTIMEZONE_MAX_SUBCOMPONENTS) throw invalidVtimezone(tzid, `più di ${VTIMEZONE_MAX_SUBCOMPONENTS} sottocomponenti`);
  let properties = vtz.properties.length;
  let rdates = 0;
  let cost = 0;
  const capYear = coverageCapYear() + 6;
  for (const sub of subs) {
    properties += sub.properties.length;
    if (sub.components.length > 0) throw invalidVtimezone(tzid, 'sottocomponenti annidate');
    let rrule: string | null = null;
    let startYear: number | null = null;
    for (const p of sub.properties) {
      const name = p.name.toUpperCase();
      if (name === 'RDATE') rdates += p.value.split(',').length;
      else if (name === 'DTSTART') startYear = yearOfValue(p.value);
      else if (name === 'RRULE') {
        if (rrule != null) throw invalidVtimezone(tzid, 'più RRULE nella stessa sottocomponente');
        rrule = p.value;
      }
    }
    if (rrule == null) continue;
    const parts = new Map<string, string>();
    for (const raw of rrule.replace(/^RRULE:/i, '').split(';')) {
      const part = raw.trim();
      if (!part) continue;
      const eq = part.indexOf('=');
      const name = (eq < 0 ? part : part.slice(0, eq)).trim().toUpperCase();
      parts.set(name, eq < 0 ? '' : part.slice(eq + 1).trim());
    }
    if ((parts.get('FREQ') ?? '').toUpperCase() !== 'YEARLY') throw invalidVtimezone(tzid, 'RRULE non annuale');
    const interval = parts.get('INTERVAL');
    if (interval !== undefined && !/^0*1$/.test(interval)) throw invalidVtimezone(tzid, 'RRULE con INTERVAL diverso da 1');
    let perYear = 1;
    for (const [name, value] of parts) {
      if (VTZ_FORBIDDEN_PARTS.has(name)) throw invalidVtimezone(tzid, `RRULE con ${name}`);
      const max = VTZ_MAX_VALUES[name];
      if (max === undefined) continue;
      const n = value.split(',').length;
      if (n > max) throw invalidVtimezone(tzid, `RRULE con più di ${max} valori in ${name}`);
    }
    const months = parts.has('BYMONTH') ? (parts.get('BYMONTH') as string).split(',').length : 1;
    const days = parts.has('BYMONTHDAY')
      ? (parts.get('BYMONTHDAY') as string).split(',').length
      : parts.has('BYDAY')
        ? (parts.get('BYDAY') as string).split(',').reduce((sum, d) => sum + (/\d/.test(d) ? 1 : 5), 0)
        : 1;
    perYear = months * days;
    let endYear = capYear;
    const until = parts.get('UNTIL');
    const untilYear = until ? yearOfValue(until) : null;
    if (untilYear != null) endYear = Math.min(endYear, untilYear);
    const count = parts.get('COUNT');
    if (count && /^\d{1,9}$/.test(count)) endYear = Math.min(endYear, (startYear ?? capYear) + Number(count));
    cost += Math.max(0, endYear - (startYear ?? capYear) + 1) * perYear;
  }
  if (properties > VTIMEZONE_MAX_PROPERTIES) throw invalidVtimezone(tzid, `più di ${VTIMEZONE_MAX_PROPERTIES} proprietà`);
  if (rdates > VTIMEZONE_MAX_RDATE_VALUES) throw invalidVtimezone(tzid, `più di ${VTIMEZONE_MAX_RDATE_VALUES} valori di RDATE`);
  if (cost > VTIMEZONE_MAX_RULE_COST) throw invalidVtimezone(tzid, 'regole troppo costose da espandere');
}

/** Testo del VTIMEZONE (righe non piegate): ical.js non ha bisogno del folding. */
function vtimezoneText(vtz: IcsComponent): string {
  return componentLines(vtz, []).join(CRLF);
}

function customState(zone: { tzid: string; vtimezone: IcsComponent }): CustomZoneState {
  const text = vtimezoneText(zone.vtimezone);
  const key = `${zone.tzid}\u0000${text}`;
  let state = customCache.get(key);
  if (!state) {
    checkVtimezoneShape(zone.vtimezone, zone.tzid);
    try {
      const comp = new ICAL.Component(ICAL.parse(text) as unknown[]);
      const tz = new ICAL.Timezone({ component: comp, tzid: zone.tzid });
      state = { tz, changes: [], coveredYear: -Infinity };
    } catch (err) {
      throw new TimezoneError('INVALID_VTIMEZONE', `VTIMEZONE "${zone.tzid.slice(0, 60)}" non interpretabile: ${err instanceof Error ? err.message : String(err)}`, {
        tzid: zone.tzid.slice(0, 60),
      });
    }
    if (customCache.size > 500) customCache.clear();
    customCache.set(key, state);
  }
  return state;
}

type IcalChange = { year: number; month: number; day: number; hour: number; minute: number; second: number; utcOffset: number; prevUtcOffset: number };

function ensureCustomCoverage(state: CustomZoneState, year: number): void {
  if (year <= state.coveredYear) return;
  const target = Math.min(Math.max(year, new Date().getUTCFullYear()) + 1, coverageCapYear() + 1);
  if (target <= state.coveredYear) return;
  try {
    // API interna di ical.js 2.2.1 (versione pinnata esatta): le transizioni
    // calcolate dal VTIMEZONE, in UTC, con offset di arrivo e di partenza.
    const tz = state.tz as unknown as { _ensureCoverage(y: number): void; changes: IcalChange[] };
    tz._ensureCoverage(target);
    const seen = new Set<number>();
    const changes: CustomZoneState['changes'] = [];
    for (const c of tz.changes) {
      const at = wallToMs({ year: c.year, month: c.month, day: c.day, hour: c.hour, minute: c.minute, second: c.second });
      if (seen.has(at)) continue;
      seen.add(at);
      changes.push({ at, offset: c.utcOffset * 1000, prev: c.prevUtcOffset * 1000 });
    }
    changes.sort((a, b) => a.at - b.at);
    state.changes = changes;
    state.coveredYear = target;
  } catch (err) {
    throw new TimezoneError('INVALID_VTIMEZONE', `VTIMEZONE non interpretabile: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Giorno della settimana del 1° gennaio (0 = domenica). */
function jan1Weekday(y: number): number {
  return new Date(wallToMs({ year: y, month: 1, day: 1, hour: 0, minute: 0, second: 0 })).getUTCDay();
}

/**
 * Istante con la stessa ora da muro UTC in un anno equivalente (stessa
 * bisestilità e stesso giorno della settimana del 1° gennaio) non oltre
 * `capYear`: le regole annuali dei VTIMEZONE ("ultima domenica di marzo")
 * danno lo stesso offset. Senza un anno equivalente vicino resta l'istante dato.
 */
function equivalentInstant(ms: number, capYear: number): number {
  const w = msToWall(ms);
  const leap = isLeapYear(w.year);
  const weekday = jan1Weekday(w.year);
  for (let y = capYear; y > capYear - 400; y--) {
    if (isLeapYear(y) === leap && jan1Weekday(y) === weekday) return wallToMs({ ...w, year: y });
  }
  return ms;
}

function customOffset(zone: { tzid: string; vtimezone: IcsComponent }, ms: number): number {
  const state = customState(zone);
  const capYear = coverageCapYear();
  const year = new Date(ms).getUTCFullYear();
  if (year > capYear) ms = equivalentInstant(ms, capYear);
  ensureCustomCoverage(state, Math.min(year, capYear));
  const changes = state.changes;
  if (changes.length === 0) return 0;
  if (ms < changes[0].at) return changes[0].prev;
  let lo = 0;
  let hi = changes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (changes[mid].at <= ms) lo = mid;
    else hi = mid - 1;
  }
  return changes[lo].offset;
}

function toZone(zone: ConvertibleZone | string): ConvertibleZone {
  return typeof zone === 'string' ? ianaZone(zone) : zone;
}

/** Offset (ms, positivo a est di Greenwich) della zona all'istante UTC dato. */
export function offsetAt(ms: number, zone: ConvertibleZone | string): number {
  try {
    const z = toZone(zone);
    if (z.kind === 'utc') return 0;
    if (z.kind === 'iana') return ianaOffset(z.iana, ms);
    return customOffset(z, ms);
  } catch (err) {
    throw toCoreError(err, 'offsetAt');
  }
}

/**
 * Ora da muro → istante UTC (ms) con le regole di RFC 5545 §3.3.5 per gli
 * orari inesistenti (offset precedente al buco) e ambigui (prima occorrenza).
 */
export function zonedToUtc(wall: WallTime, zone: ConvertibleZone | string): number {
  try {
    const z = toZone(zone);
    const local = wallToMs(wall);
    if (z.kind === 'utc') return local;
    const off = (ms: number): number => (z.kind === 'iana' ? ianaOffset(z.iana, ms) : customOffset(z, ms));
    // Gli offset reali stanno in [-14h, +14h]: l'istante cercato è in [local-14h, local+14h].
    const early = off(local - 14 * HOUR_MS);
    const late = off(local + 14 * HOUR_MS);
    const tEarly = local - early;
    const tLate = local - late;
    const earlyOk = off(tEarly) === early;
    const lateOk = off(tLate) === late;
    if (earlyOk && lateOk) return Math.min(tEarly, tLate);
    if (earlyOk) return tEarly;
    if (lateOk) return tLate;
    return tEarly;
  } catch (err) {
    throw toCoreError(err, 'zonedToUtc');
  }
}

/** Istante UTC (ms) → ora da muro nella zona. */
export function utcToZoned(ms: number, zone: ConvertibleZone | string): WallTime {
  try {
    const z = toZone(zone);
    if (z.kind === 'utc') return msToWall(ms);
    return msToWall(ms + offsetAt(ms, z));
  } catch (err) {
    throw toCoreError(err, 'utcToZoned');
  }
}

// ============================================
// ical.js
// ============================================

const icalTzCache = new Map<string, InstanceType<typeof ICAL.Timezone>>();

/**
 * ICAL.Timezone per i moduli che espandono con ical.js (expand.ts): per un
 * fuso IANA viene costruito dal VTIMEZONE canonico (con TZID = `tzid`), per un
 * VTIMEZONE dell'oggetto da quello. Le conversioni ora↔istante del pacchetto
 * passano invece da zonedToUtc/utcToZoned (regole RFC su buchi e ambiguità).
 */
export function getIcalTimezone(zone: ConvertibleZone | string, tzid?: string): InstanceType<typeof ICAL.Timezone> {
  const z = toZone(zone);
  if (z.kind === 'utc') return ICAL.Timezone.utcTimezone;
  if (z.kind === 'custom') return customState(z).tz;
  const id = tzid ?? z.iana;
  const key = `${z.iana}\u0000${id}`;
  let tz = icalTzCache.get(key);
  if (!tz) {
    const vtz = canonicalVtimezone(z.iana, id);
    if (!vtz) throw new TimezoneError('UNKNOWN_TIMEZONE', `Nessun VTIMEZONE canonico per "${z.iana}"`, { tz: z.iana });
    tz = customState({ tzid: id, vtimezone: vtz }).tz;
    if (icalTzCache.size >= CACHE_MAX) icalTzCache.clear();
    icalTzCache.set(key, tz);
  }
  return tz;
}
