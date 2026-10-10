/**
 * Fingerprint semantico e hash del contenuto (design §6.6, §13.6, §13.7).
 *
 * Usi:
 * - iscrizioni: un feed che riscrive DTSTAMP (Google lo fa a ogni richiesta),
 *   LAST-MODIFIED o SEQUENCE senza cambiare altro non produce scritture né
 *   versioni (fingerprint invariato);
 * - migrazione: intent_fingerprint prima di ogni PUT e adozione per
 *   fingerprint dopo un crash (V2 della verifica);
 * - indice: cal_objects.semantic_fp e content_sha256.
 *
 * Il testo canonico semantico è insensibile a: DTSTAMP, LAST-MODIFIED,
 * SEQUENCE (FINGERPRINT_IGNORED_PROPERTIES), PRODID, folding e fine riga,
 * maiuscole dei nomi, quotatura dei parametri, forma degli escape TEXT
 * (decodifica e ricodifica), ordine delle proprietà dentro un componente,
 * ordine dei VALARM e degli override, ordine dei valori di EXDATE/RDATE/
 * CATEGORIES, ordine delle parti della RRULE, VTIMEZONE dei TZID IANA
 * (contano solo i riferimenti). È sensibile a tutto il resto, comprese le X-*
 * e i VTIMEZONE non IANA.
 *
 * Escludere sempre LAST-MODIFIED e SEQUENCE equivale a escluderli "quando il
 * resto è invariato": se cambia qualsiasi altra proprietà il fingerprint
 * cambia comunque.
 *
 * Normalizzazioni aggiuntive, tutte senza effetto sulla semantica:
 * - valori temporali riscritti dalla forma tipizzata (VALUE=DATE esplicito o
 *   dedotto dalle 8 cifre, VALUE=DATE-TIME omesso, TZID ignorato con la Z);
 *   i TZID che il registro risolve come IANA (maiuscole, alias, prefissi
 *   Mozilla) diventano il nome IANA, così `/mozilla.org/.../Europe/Rome` e
 *   `Europe/Rome` danno lo stesso testo;
 * - durate in forma canonica (P1W = P7D, PT60M = PT1H; giorni nominali e
 *   parte oraria esatta restano distinti: P1D ≠ PT24H);
 * - interi e GEO in forma numerica; STATUS, TRANSP, CLASS e ACTION in
 *   maiuscolo; valori dei parametri enumerati (ROLE, PARTSTAT, ...) in
 *   maiuscolo; VALUE omesso quando è il tipo di default della proprietà;
 * - RRULE con le parti ordinate, le liste BYxxx ordinate e senza duplicati,
 *   INTERVAL=1 e WKST=MO omessi (sono i default di RFC 5545);
 * - EXDATE, RDATE, CATEGORIES e RESOURCES scomposti in un valore per riga,
 *   ordinati e senza duplicati (più proprietà o una sola con le virgole
 *   sono la stessa cosa);
 * - proprietà del VCALENDAR che descrivono il calendario e non l'oggetto
 *   (FINGERPRINT_IGNORED_CALENDAR_PROPERTIES): lo split di un feed le copia in
 *   ogni oggetto e un cambio di nome del feed non deve riscrivere tutto.
 *
 * Funziona anche nel browser (admin, F6): nessun modulo Node; SHA-256 in
 * JavaScript puro, sincrono, sui byte UTF-8 (TextEncoder).
 */

import { canonicalRruleText } from './validate';
import { collectTzidRefs, decodeText, encodeText, splitTextList } from './ics-text';
import {
  type CalendarObject,
  formatDurationValue,
  formatTimeValue,
  type IcsComponent,
  type IcsDuration,
  type IcsParam,
  type IcsProperty,
  type IcsTime,
  objectComponents,
  parseDurationValue,
  parseTimeValue,
  timeParams,
} from './model';
import { findVtimezone, isIanaTzid, resolveTzid } from './tz-registry';

/** Versione dell'algoritmo: entra nel prefisso del fingerprint, così un cambio non si confonde con una modifica. */
export const FINGERPRINT_VERSION = 1;

/** Proprietà sempre escluse dal testo semantico. */
export const FINGERPRINT_IGNORED_PROPERTIES = ['DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE'] as const;

/**
 * Proprietà del VCALENDAR escluse dal testo semantico: versione e prodotto,
 * METHOD (iTIP, non ammesso nelle risorse CalDAV), CALSCALE gregoriano (il
 * default; un CALSCALE diverso resta) e le proprietà che descrivono il
 * calendario (nome, descrizione, colore, intervallo di aggiornamento, RFC
 * 7986 e X-WR-*), che lo split di un feed copia in ogni oggetto. X-WR-TIMEZONE
 * resta: alcuni client interpretano con lui gli orari floating.
 */
export const FINGERPRINT_IGNORED_CALENDAR_PROPERTIES = [
  'VERSION',
  'PRODID',
  'METHOD',
  'X-WR-CALNAME',
  'X-WR-CALDESC',
  'X-WR-RELCALID',
  'X-PUBLISHED-TTL',
  'X-APPLE-CALENDAR-COLOR',
  'NAME',
  'DESCRIPTION',
  'COLOR',
  'IMAGE',
  'URL',
  'SOURCE',
  'REFRESH-INTERVAL',
  'UID',
  'LAST-MODIFIED',
] as const;

export interface FingerprintOptions {
  /** Proprietà aggiuntive da escludere (es. X-CALDES-LEGACY-ID per confronti fra store). */
  ignoreProperties?: readonly string[];
}

/** Testo canonico semantico dell'oggetto (debug, diff della verifica V2). */
export function canonicalSemanticText(obj: CalendarObject, opts: FingerprintOptions = {}): string {
  const ignored = ignoredSet(opts);
  const calendarIgnored = new Set<string>([...FINGERPRINT_IGNORED_CALENDAR_PROPERTIES, ...ignored]);
  const calLines = sortCanonicalLines(
    obj.calendarProperties
      .filter((p) => {
        const name = p.name.toUpperCase();
        if (calendarIgnored.has(name)) return false;
        return !(name === 'CALSCALE' && p.value.trim().toUpperCase() === 'GREGORIAN');
      })
      .flatMap((p) => canonicalPropertyLines(p)),
  );

  const body = [...objectComponents(obj), ...obj.otherComponents];
  const blocks: string[] = body.map((c) => canonicalComponentText(c, ignored));
  for (const tzid of collectTzidRefs(body)) {
    // TZID IANA: conta solo il riferimento (il VTIMEZONE scritto è quello canonico).
    if (isIanaTzid(resolveTzid(tzid, obj.timezones))) continue;
    const own = findVtimezone(obj.timezones, tzid);
    if (own) blocks.push(canonicalComponentText(own, ignored));
  }
  blocks.sort(compareStrings);

  return ['BEGIN:VCALENDAR', `X-CALDES-COMPONENT-TYPE:${obj.componentType}`, ...calLines, ...blocks, 'END:VCALENDAR'].join('\n');
}

/** Fingerprint semantico: `v${FINGERPRINT_VERSION}:` + SHA-256 esadecimale del testo canonico semantico. */
export function semanticFingerprint(obj: CalendarObject, opts?: FingerprintOptions): string {
  return `v${FINGERPRINT_VERSION}:${contentSha256(canonicalSemanticText(obj, opts))}`;
}

/** SHA-256 esadecimale (minuscolo) dei byte UTF-8 di un testo: cal_objects.content_sha256 e ETag del feed. */
export function contentSha256(text: string): string {
  return toHex(sha256(new TextEncoder().encode(text)));
}

/**
 * Testo canonico semantico di un singolo componente (proprietà ordinate,
 * sottocomponenti ordinati, DTSTAMP/LAST-MODIFIED/SEQUENCE esclusi): lo usa
 * anche patch.ts per confrontare VALARM, ORGANIZER e ATTENDEE.
 */
export function canonicalComponentText(comp: IcsComponent, ignore: ReadonlySet<string> = DEFAULT_IGNORED): string {
  const name = comp.name.toUpperCase();
  const lines = sortCanonicalLines(
    comp.properties.filter((p) => !ignore.has(p.name.toUpperCase())).flatMap((p) => canonicalPropertyLines(p)),
  );
  const subs = comp.components.map((c) => canonicalComponentText(c, ignore)).sort(compareStrings);
  return [`BEGIN:${name}`, ...lines, ...subs, `END:${name}`].join('\n');
}

/** Riga canonica di una proprietà (per i confronti di patch.ts); le proprietà a valori multipli producono più righe unite da "\n". */
export function canonicalPropertyText(prop: IcsProperty): string {
  return canonicalPropertyLines(prop).join('\n');
}

// ============================================
// Righe canoniche
// ============================================

const DEFAULT_IGNORED: ReadonlySet<string> = new Set<string>(FINGERPRINT_IGNORED_PROPERTIES);

function ignoredSet(opts: FingerprintOptions): ReadonlySet<string> {
  if (!opts.ignoreProperties || opts.ignoreProperties.length === 0) return DEFAULT_IGNORED;
  return new Set<string>([...FINGERPRINT_IGNORED_PROPERTIES, ...opts.ignoreProperties.map((n) => n.toUpperCase())]);
}

/** Proprietà con valore DATE o DATE-TIME (singolo). */
const TIME_PROPS = new Set(['DTSTART', 'DTEND', 'DUE', 'RECURRENCE-ID', 'CREATED', 'COMPLETED', 'ACKNOWLEDGED', 'DTSTAMP', 'LAST-MODIFIED']);
/** Proprietà con lista di DATE, DATE-TIME o PERIOD, scomposte in un valore per riga. */
const TIME_LIST_PROPS = new Set(['EXDATE', 'RDATE']);
/** TEXT a valori multipli, scomposti in un valore per riga. */
const TEXT_LIST_PROPS = new Set(['CATEGORIES', 'RESOURCES']);
/** TEXT a valore singolo. */
const TEXT_PROPS = new Set(['SUMMARY', 'DESCRIPTION', 'LOCATION', 'COMMENT', 'CONTACT', 'UID', 'RELATED-TO', 'TZID', 'TZNAME']);
/** TEXT enumerati, case-insensitive. */
const ENUM_TEXT_PROPS = new Set(['STATUS', 'TRANSP', 'CLASS', 'ACTION']);
const INTEGER_PROPS = new Set(['PRIORITY', 'PERCENT-COMPLETE', 'REPEAT', 'SEQUENCE']);
const DURATION_PROPS = new Set(['DURATION', 'REFRESH-INTERVAL']);
const RECUR_PROPS = new Set(['RRULE', 'EXRULE']);
/** Parametri con valori enumerati (case-insensitive, RFC 5545 §3.2). */
const ENUM_PARAMS = new Set(['VALUE', 'CUTYPE', 'ROLE', 'PARTSTAT', 'RSVP', 'RELTYPE', 'RELATED', 'RANGE', 'FBTYPE', 'ENCODING']);

/** Tipo di default di una proprietà (VALUE con questo valore si omette). */
function defaultValueType(name: string): string | null {
  if (TIME_PROPS.has(name) || TIME_LIST_PROPS.has(name)) return 'DATE-TIME';
  if (DURATION_PROPS.has(name) || name === 'TRIGGER') return 'DURATION';
  if (TEXT_PROPS.has(name) || TEXT_LIST_PROPS.has(name) || ENUM_TEXT_PROPS.has(name) || name.startsWith('X-')) return 'TEXT';
  if (INTEGER_PROPS.has(name)) return 'INTEGER';
  if (RECUR_PROPS.has(name)) return 'RECUR';
  if (name === 'URL' || name === 'TZURL' || name === 'ATTACH' || name === 'CONFERENCE' || name === 'IMAGE') return 'URI';
  if (name === 'ORGANIZER' || name === 'ATTENDEE') return 'CAL-ADDRESS';
  if (name === 'GEO') return 'FLOAT';
  return null;
}

function valueParam(prop: IcsProperty): string | null {
  const p = prop.params.find((x) => x.name.toUpperCase() === 'VALUE');
  return p && p.values.length > 0 ? p.values[0].toUpperCase() : null;
}

/** Parametri canonici: nomi in maiuscolo, enumerati in maiuscolo, ordinati; `drop` esclude per nome. */
function canonicalParams(params: readonly IcsParam[], drop: ReadonlySet<string>): string {
  const out = params
    .filter((p) => !drop.has(p.name.toUpperCase()))
    .map((p) => {
      const name = p.name.toUpperCase();
      const values = ENUM_PARAMS.has(name) ? p.values.map((v) => v.toUpperCase()) : p.values;
      return values.length === 0 ? `;${name}` : `;${name}=${values.map(quoteParam).join(',')}`;
    });
  out.sort(compareStrings);
  return out.join('');
}

function quoteParam(v: string): string {
  return /[:;,]/.test(v) ? `"${v}"` : v;
}

/**
 * TZID che il registro risolve come IANA (nome esatto, maiuscole diverse,
 * alias, prefissi Mozilla) → nome IANA: indicano gli stessi istanti e il
 * VTIMEZONE scritto è comunque quello canonico. I TZID non IANA (nomi
 * Windows, VTIMEZONE personalizzati, sconosciuti) restano come sono.
 */
function canonicalZone(t: IcsTime): IcsTime {
  if (t.type !== 'date-time' || t.zone.kind !== 'tzid') return t;
  const res = resolveTzid(t.zone.tzid);
  if (res.kind !== 'iana' || !isIanaTzid(res) || res.iana === t.zone.tzid) return t;
  return { ...t, zone: { kind: 'tzid', tzid: res.iana } };
}

function timeCanonical(t: IcsTime): { params: IcsParam[]; value: string } {
  const c = canonicalZone(t);
  return { params: timeParams(c), value: formatTimeValue(c) };
}

function durationCanonical(d: IcsDuration): string {
  const nominalDays = d.weeks * 7 + d.days;
  const exact = d.hours * 3600 + d.minutes * 60 + d.seconds;
  const hours = Math.floor(exact / 3600);
  const minutes = Math.floor((exact - hours * 3600) / 60);
  const seconds = exact - hours * 3600 - minutes * 60;
  const zero = nominalDays === 0 && exact === 0;
  return formatDurationValue({ negative: d.negative && !zero, weeks: 0, days: nominalDays, hours, minutes, seconds });
}

function line(name: string, params: string, value: string): string {
  return `${name}${params}:${value}`;
}

/**
 * Righe canoniche di una proprietà. Un valore che non si riesce a
 * interpretare resta grezzo (il risultato è comunque deterministico).
 */
function canonicalPropertyLines(prop: IcsProperty): string[] {
  const name = prop.name.toUpperCase();
  const vType = valueParam(prop);
  const defType = defaultValueType(name);
  const dropValue = new Set<string>(vType != null && vType === defType ? ['VALUE'] : []);
  const raw = prop.value;

  try {
    if (TIME_PROPS.has(name)) {
      const tzid = prop.params.find((p) => p.name.toUpperCase() === 'TZID')?.values[0] ?? null;
      const t = parseTimeValue(raw, { value: vType, tzid }, name);
      const c = timeCanonical(t);
      const rest = canonicalParams(prop.params, new Set(['VALUE', 'TZID']));
      return [line(name, canonicalParams(c.params, new Set()) + rest, c.value)];
    }
    if (TIME_LIST_PROPS.has(name)) {
      const tzid = prop.params.find((p) => p.name.toUpperCase() === 'TZID')?.values[0] ?? null;
      const rest = canonicalParams(prop.params, new Set(['VALUE', 'TZID']));
      const out: string[] = [];
      for (const part of raw.split(',')) {
        const v = part.trim();
        if (!v) continue;
        if (vType === 'PERIOD') {
          const [a, b] = v.split('/');
          if (a == null || b == null) throw new Error('PERIOD');
          const start = canonicalZone(parseTimeValue(a, { value: 'DATE-TIME', tzid }, name));
          const second = /^[+-]?P/i.test(b.trim())
            ? durationCanonical(parseDurationValue(b, name))
            : formatTimeValue(parseTimeValue(b, { value: 'DATE-TIME', tzid }, name));
          const params = [{ name: 'VALUE', values: ['PERIOD'] }, ...timeParams(start).filter((p) => p.name === 'TZID')];
          out.push(line(name, canonicalParams(params, new Set()) + rest, `${formatTimeValue(start)}/${second}`));
        } else {
          const c = timeCanonical(parseTimeValue(v, { value: vType, tzid }, name));
          out.push(line(name, canonicalParams(c.params, new Set()) + rest, c.value));
        }
      }
      return out;
    }
    if (TEXT_LIST_PROPS.has(name)) {
      const params = canonicalParams(prop.params, dropValue);
      return splitTextList(raw)
        .filter((s) => s !== '')
        .map((s) => line(name, params, encodeText(s)));
    }
    if (TEXT_PROPS.has(name) || (name.startsWith('X-') && (vType == null || vType === 'TEXT'))) {
      return [line(name, canonicalParams(prop.params, dropValue), encodeText(decodeText(raw)))];
    }
    if (ENUM_TEXT_PROPS.has(name)) {
      return [line(name, canonicalParams(prop.params, dropValue), encodeText(decodeText(raw).trim().toUpperCase()))];
    }
    if (INTEGER_PROPS.has(name) && /^\s*[+-]?\d+\s*$/.test(raw)) {
      return [line(name, canonicalParams(prop.params, dropValue), String(Number(raw.trim())))];
    }
    if (DURATION_PROPS.has(name) || (name === 'TRIGGER' && vType !== 'DATE-TIME')) {
      return [line(name, canonicalParams(prop.params, dropValue), durationCanonical(parseDurationValue(raw, name)))];
    }
    if (name === 'TRIGGER' && vType === 'DATE-TIME') {
      const c = timeCanonical(parseTimeValue(raw, { value: 'DATE-TIME' }, name));
      return [line(name, canonicalParams(prop.params, new Set()), c.value)];
    }
    if (RECUR_PROPS.has(name)) {
      return [line(name, canonicalParams(prop.params, dropValue), canonicalRruleText(raw))];
    }
    if (name === 'GEO') {
      const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*[;,]\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(raw);
      if (m) return [line(name, canonicalParams(prop.params, dropValue), `${Number(m[1])};${Number(m[2])}`)];
    }
  } catch {
    // Valore non interpretabile: resta grezzo.
  }
  return [line(name, canonicalParams(prop.params, dropValue), raw)];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Righe ordinate; i duplicati si tolgono solo per le proprietà a insieme di
 * valori scomposte (EXDATE, RDATE, CATEGORIES, RESOURCES), dove non hanno
 * significato. Due ATTENDEE identici restano due righe.
 */
function sortCanonicalLines(lines: string[]): string[] {
  const sorted = [...lines].sort(compareStrings);
  return sorted.filter((l, i) => i === 0 || l !== sorted[i - 1] || !isSetValuedLine(l));
}

/** Righe delle proprietà a insieme di valori: lì un duplicato non ha significato. */
function isSetValuedLine(l: string): boolean {
  const m = /^([A-Z0-9-]+)[;:]/.exec(l);
  return m != null && (TIME_LIST_PROPS.has(m[1]) || TEXT_LIST_PROPS.has(m[1]));
}

/** Durata canonica (per patch.ts): stessa forma usata nel testo semantico (P1W = P7D, PT60M = PT1H, P1D ≠ PT24H). */
export function canonicalDurationText(d: IcsDuration): string {
  return durationCanonical(d);
}

// ============================================
// SHA-256 (FIPS 180-4), sincrono, JavaScript puro
// ============================================

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLength = data.length * 8;
  // Messaggio + 0x80 + zeri + lunghezza a 64 bit, multiplo di 64 byte.
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
