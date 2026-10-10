/**
 * Parse iCalendar (RFC 5545) → modello lossless.
 *
 * Il parser è strutturale e non decodifica i valori: ogni proprietà conserva
 * nome, parametri (in ordine, con i valori senza virgolette) e valore grezzo
 * esattamente come nel testo dopo l'unfolding. Proprietà, parametri e
 * componenti sconosciuti, VALARM, ATTENDEE, X-* e VTIMEZONE restano nel
 * modello, così una patch tocca solo ciò che cambia e il resto torna fuori
 * identico (a meno della forma canonica di serialize.ts). La decodifica dei
 * tipi (date, durate, TEXT) sta in model.ts e la semantica nei moduli sopra.
 *
 * Errori: le funzioni restituiscono `ParseResult` con un IcsParseError
 * tipizzato (riga e UID quando noti); nessuna eccezione non tipizzata. Le
 * varianti `...OrThrow` lanciano lo stesso IcsParseError.
 *
 * Input Uint8Array: l'unfolding avviene sui byte prima della decodifica UTF-8,
 * così un carattere multibyte spezzato da un folding scorretto (prodotti che
 * piegano a 75 caratteri invece che a 75 ottetti) si ricompone invece di
 * diventare due U+FFFD.
 */

import { IcsParseError, type IcsWarning, toCoreError } from './errors';
import { NAME_RE, collectTzidRefs, decodeText, vtimezoneTzid } from './ics-text';
import type { CalendarObject, IcsComponent, IcsParam, IcsProperty, SchedulableComponentType } from './model';

/** Dimensione massima predefinita dell'input: 10 MiB (un feed ICS reale ne pesa al massimo pochi). */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** Profondità massima predefinita (VCALENDAR > VEVENT > VALARM sono 3 livelli). */
export const DEFAULT_MAX_DEPTH = 16;

export interface ParseOptions {
  /** Byte UTF-8 massimi dell'input. Default DEFAULT_MAX_BYTES. */
  maxBytes?: number;
  /** Annidamento massimo dei componenti. Default DEFAULT_MAX_DEPTH. */
  maxDepth?: number;
  /**
   * Righe di contenuto malformate: 'error' (default) fa fallire tutto il parse;
   * 'skip' le salta con un avviso SKIPPED_LINE (per i feed esterni, dove una
   * riga rotta non deve far perdere l'intero calendario). Le righe BEGIN/END
   * sbilanciate restano sempre un errore.
   */
  malformedLines?: 'error' | 'skip';
  /** Più VCALENDAR nello stesso testo: 'error' (default) o 'merge' nel primo, con avviso. */
  multipleCalendars?: 'error' | 'merge';
  /** Byte non UTF-8 (solo input Uint8Array): 'error' (default) o 'replace' con U+FFFD e avviso. */
  invalidUtf8?: 'error' | 'replace';
}

export type ParseResult<T> =
  | { ok: true; value: T; warnings: IcsWarning[] }
  | { ok: false; error: IcsParseError; warnings: IcsWarning[] };

interface LogicalLine {
  text: string;
  /** Riga fisica (1-based) dove inizia la riga logica. */
  line: number;
}

const SCHEDULABLE = new Set<string>(['VEVENT', 'VTODO', 'VJOURNAL']);

// ============================================
// Righe logiche (unfolding)
// ============================================

function checkSize(input: string | Uint8Array, maxBytes: number): void {
  let bytes: number;
  if (typeof input === 'string') {
    // Misura esatta solo quando serve: ogni unità UTF-16 vale al massimo 3 ottetti.
    if (input.length * 3 <= maxBytes) return;
    bytes = new TextEncoder().encode(input).byteLength;
  } else {
    bytes = input.byteLength;
  }
  if (bytes > maxBytes) {
    throw new IcsParseError('TOO_LARGE', `Testo iCalendar di ${bytes} byte oltre il limite di ${maxBytes}`, {
      details: { bytes, maxBytes },
    });
  }
}

function linesFromString(text: string): LogicalLine[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const physical = src.split(/\r\n|\n|\r/);
  const out: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i];
    if (raw.length === 0) {
      current = null;
      continue;
    }
    if ((raw[0] === ' ' || raw[0] === '\t') && current) {
      current.text += raw.slice(1);
      continue;
    }
    current = { text: raw, line: i + 1 };
    out.push(current);
  }
  return out;
}

function linesFromBytes(bytes: Uint8Array, opts: ParseOptions, warnings: IcsWarning[]): LogicalLine[] {
  let start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  // Righe fisiche come intervalli di byte, poi raggruppate in righe logiche.
  const groups: Array<{ line: number; chunks: Uint8Array[] }> = [];
  let current: { line: number; chunks: Uint8Array[] } | null = null;
  let lineNo = 0;
  const pushPhysical = (from: number, to: number): void => {
    lineNo++;
    if (to <= from) {
      current = null;
      return;
    }
    const first = bytes[from];
    if ((first === 0x20 || first === 0x09) && current) {
      current.chunks.push(bytes.subarray(from + 1, to));
      return;
    }
    current = { line: lineNo, chunks: [bytes.subarray(from, to)] };
    groups.push(current);
  };
  for (let i = start; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0d || b === 0x0a) {
      pushPhysical(start, i);
      if (b === 0x0d && bytes[i + 1] === 0x0a) i++;
      start = i + 1;
    }
  }
  if (start < bytes.length) pushPhysical(start, bytes.length);

  const fatal = new TextDecoder('utf-8', { fatal: true });
  const lenient = new TextDecoder('utf-8');
  let replaced = false;
  const out: LogicalLine[] = [];
  for (const g of groups) {
    const buf = g.chunks.length === 1 ? g.chunks[0] : concat(g.chunks);
    let text: string;
    try {
      text = fatal.decode(buf);
    } catch {
      if (opts.invalidUtf8 !== 'replace') {
        throw new IcsParseError('INVALID_ENCODING', `Byte non UTF-8 alla riga ${g.line}`, { line: g.line });
      }
      text = lenient.decode(buf);
      replaced = true;
    }
    out.push({ text, line: g.line });
  }
  if (replaced) {
    warnings.push({ code: 'INVALID_UTF8_REPLACED', message: 'Byte non UTF-8 sostituiti con U+FFFD' });
  }
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function toLogicalLines(input: string | Uint8Array, opts: ParseOptions, warnings: IcsWarning[]): LogicalLine[] {
  checkSize(input, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  return typeof input === 'string' ? linesFromString(input) : linesFromBytes(input, opts, warnings);
}

// ============================================
// Riga di contenuto
// ============================================

function malformed(line: number | null, message: string): IcsParseError {
  return new IcsParseError('MALFORMED_LINE', line != null ? `Riga ${line}: ${message}` : message, { line });
}

function parseLine(text: string, line: number | null): IcsProperty {
  const len = text.length;
  let i = 0;
  while (i < len && text[i] !== ';' && text[i] !== ':') i++;
  const name = text.slice(0, i);
  if (!NAME_RE.test(name)) throw malformed(line, 'nome di proprietà non valido o separatore ":" mancante');
  const params: IcsParam[] = [];
  while (i < len && text[i] === ';') {
    i++;
    const nameStart = i;
    while (i < len && text[i] !== '=' && text[i] !== ';' && text[i] !== ':') i++;
    const pname = text.slice(nameStart, i);
    if (!NAME_RE.test(pname)) throw malformed(line, `nome di parametro non valido in ${name.toUpperCase()}`);
    if (text[i] !== '=') {
      // Parametro senza valore (sintassi vCard 2.1): conservato come tale.
      params.push({ name: pname.toUpperCase(), values: [] });
      continue;
    }
    i++;
    const values: string[] = [];
    for (;;) {
      if (text[i] === '"') {
        const close = text.indexOf('"', i + 1);
        if (close < 0) throw malformed(line, `virgolette non chiuse nel parametro ${pname.toUpperCase()}`);
        values.push(text.slice(i + 1, close));
        i = close + 1;
        if (i < len && text[i] !== ',' && text[i] !== ';' && text[i] !== ':') {
          throw malformed(line, `carattere inatteso dopo le virgolette nel parametro ${pname.toUpperCase()}`);
        }
      } else {
        const valueStart = i;
        while (i < len && text[i] !== ',' && text[i] !== ';' && text[i] !== ':' && text[i] !== '"') i++;
        if (text[i] === '"') throw malformed(line, `virgolette dentro un valore non quotato nel parametro ${pname.toUpperCase()}`);
        values.push(text.slice(valueStart, i));
      }
      if (text[i] === ',') {
        i++;
        continue;
      }
      break;
    }
    params.push({ name: pname.toUpperCase(), values });
  }
  if (text[i] !== ':') throw malformed(line, `separatore ":" mancante in ${name.toUpperCase()}`);
  return { name: name.toUpperCase(), params, value: text.slice(i + 1) };
}

/**
 * Interpreta una singola riga di contenuto già "unfolded" (NOME;PARAM=VAL:valore).
 * Lancia IcsParseError('MALFORMED_LINE') se la riga non è conforme.
 */
export function parsePropertyLine(line: string): IcsProperty {
  try {
    return parseLine(line, null);
  } catch (err) {
    throw toCoreError(err, 'parsePropertyLine');
  }
}

// ============================================
// Struttura dei componenti
// ============================================

function parseStructure(
  lines: LogicalLine[],
  opts: ParseOptions,
  warnings: IcsWarning[],
  requireCalendarRoot: boolean,
): IcsComponent[] {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const skip = opts.malformedLines === 'skip';
  const roots: IcsComponent[] = [];
  const stack: Array<{ comp: IcsComponent; line: number }> = [];

  for (const ll of lines) {
    let prop: IcsProperty;
    try {
      prop = parseLine(ll.text, ll.line);
    } catch (err) {
      if (skip && err instanceof IcsParseError) {
        warnings.push({ code: 'SKIPPED_LINE', message: err.message, line: ll.line });
        continue;
      }
      throw err;
    }

    if (prop.name === 'BEGIN' || prop.name === 'END') {
      const compName = prop.value.trim().toUpperCase();
      if (!NAME_RE.test(compName) || prop.params.length > 0) {
        throw malformed(ll.line, `riga ${prop.name} non valida`);
      }
      if (prop.name === 'BEGIN') {
        if (stack.length === 0 && requireCalendarRoot && compName !== 'VCALENDAR') {
          throw new IcsParseError('NOT_ICALENDAR', `Riga ${ll.line}: BEGIN:${compName} fuori da un VCALENDAR`, { line: ll.line });
        }
        if (stack.length >= maxDepth) {
          throw new IcsParseError('TOO_DEEP', `Riga ${ll.line}: annidamento oltre ${maxDepth} livelli`, { line: ll.line });
        }
        const comp: IcsComponent = { name: compName, properties: [], components: [] };
        if (stack.length === 0) roots.push(comp);
        else stack[stack.length - 1].comp.components.push(comp);
        stack.push({ comp, line: ll.line });
      } else {
        const top = stack[stack.length - 1];
        if (!top || top.comp.name !== compName) {
          throw new IcsParseError(
            'UNBALANCED_COMPONENT',
            `Riga ${ll.line}: END:${compName} ${top ? `dentro ${top.comp.name}` : 'senza BEGIN'}`,
            { line: ll.line },
          );
        }
        stack.pop();
      }
      continue;
    }

    const top = stack[stack.length - 1];
    if (!top) {
      if (skip) {
        warnings.push({ code: 'SKIPPED_LINE', message: `Riga ${ll.line}: contenuto fuori da un componente`, line: ll.line });
        continue;
      }
      throw new IcsParseError('CONTENT_OUTSIDE_VCALENDAR', `Riga ${ll.line}: contenuto fuori da un componente`, { line: ll.line });
    }
    top.comp.properties.push(prop);
  }

  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    throw new IcsParseError('UNTERMINATED_COMPONENT', `${open.comp.name} aperto alla riga ${open.line} e mai chiuso`, {
      line: open.line,
    });
  }
  return roots;
}

function hasCalendarBegin(lines: LogicalLine[]): boolean {
  return lines.some((l) => /^BEGIN:VCALENDAR\s*$/i.test(l.text));
}

function run<T>(fn: (warnings: IcsWarning[]) => T, context: string): ParseResult<T> {
  const warnings: IcsWarning[] = [];
  try {
    return { ok: true, value: fn(warnings), warnings };
  } catch (err) {
    if (err instanceof IcsParseError) return { ok: false, error: err, warnings };
    throw toCoreError(err, context);
  }
}

/**
 * Testo iCalendar → VCALENDAR (albero lossless). Errori tipizzati:
 * EMPTY_INPUT, TOO_LARGE, INVALID_ENCODING, NOT_ICALENDAR,
 * CONTENT_OUTSIDE_VCALENDAR, MALFORMED_LINE, UNBALANCED_COMPONENT,
 * UNTERMINATED_COMPONENT, TOO_DEEP, MULTIPLE_VCALENDAR.
 */
export function parseIcs(input: string | Uint8Array, opts: ParseOptions = {}): ParseResult<IcsComponent> {
  return run((warnings) => {
    const lines = toLogicalLines(input, opts, warnings);
    if (lines.every((l) => l.text.trim() === '')) throw new IcsParseError('EMPTY_INPUT', 'Testo iCalendar vuoto');
    if (!hasCalendarBegin(lines)) {
      throw new IcsParseError('NOT_ICALENDAR', 'Il contenuto non è un VCALENDAR (BEGIN:VCALENDAR mancante)');
    }
    const roots = parseStructure(lines, opts, warnings, true);
    if (roots.length === 0) throw new IcsParseError('NOT_ICALENDAR', 'Nessun VCALENDAR leggibile');
    if (roots.length > 1) {
      if (opts.multipleCalendars !== 'merge') {
        throw new IcsParseError('MULTIPLE_VCALENDAR', `Il testo contiene ${roots.length} VCALENDAR`, {
          details: { count: roots.length },
        });
      }
      const [first, ...rest] = roots;
      for (const cal of rest) first.components.push(...cal.components);
      warnings.push({ code: 'MERGED_VCALENDAR', message: `${rest.length} VCALENDAR aggiuntivi uniti nel primo` });
    }
    return roots[0];
  }, 'parseIcs');
}

/** Come parseIcs, ma lancia l'IcsParseError invece di restituirlo. */
export function parseIcsOrThrow(input: string | Uint8Array, opts: ParseOptions = {}): IcsComponent {
  const r = parseIcs(input, opts);
  if (!r.ok) throw r.error;
  return r.value;
}

/**
 * Testo con uno o più componenti di primo livello qualsiasi (es. un VTIMEZONE
 * isolato, un VEVENT incollato nell'editor raw) senza richiedere il VCALENDAR.
 */
export function parseComponents(input: string | Uint8Array, opts: ParseOptions = {}): ParseResult<IcsComponent[]> {
  return run((warnings) => {
    const lines = toLogicalLines(input, opts, warnings);
    if (lines.every((l) => l.text.trim() === '')) throw new IcsParseError('EMPTY_INPUT', 'Testo iCalendar vuoto');
    return parseStructure(lines, opts, warnings, false);
  }, 'parseComponents');
}

// ============================================
// Oggetto calendario (risorsa CalDAV)
// ============================================

function firstPropValue(comp: IcsComponent, name: string): string | null {
  const p = comp.properties.find((x) => x.name === name);
  return p ? p.value : null;
}

/** UID decodificato (TEXT) e senza spazi ai bordi, o null se assente o vuoto. */
export function componentUid(comp: IcsComponent): string | null {
  const raw = firstPropValue(comp, 'UID');
  if (raw == null) return null;
  const uid = decodeText(raw).trim();
  return uid.length > 0 ? uid : null;
}

/** Chiave grezza dell'override (TZID|valore) per riconoscere i duplicati senza contesto di fuso. */
function rawRecurrenceKey(comp: IcsComponent): string | null {
  const p = comp.properties.find((x) => x.name === 'RECURRENCE-ID');
  if (!p) return null;
  const tzid = p.params.find((x) => x.name === 'TZID')?.values[0] ?? '';
  return `${tzid}|${p.value.trim().toUpperCase()}`;
}

function isSchedulable(comp: IcsComponent): boolean {
  return SCHEDULABLE.has(comp.name);
}

function buildObject(
  uid: string,
  comps: IcsComponent[],
  calendarProperties: IcsProperty[],
  timezones: IcsComponent[],
  otherComponents: IcsComponent[],
  warnings: IcsWarning[],
  duplicateMasters: 'error' | 'keep-first',
): CalendarObject {
  const types = new Set(comps.map((c) => c.name));
  if (types.size > 1) {
    throw new IcsParseError('MIXED_COMPONENT_TYPES', `Componenti di tipo diverso (${[...types].join(', ')}) per l'UID ${uid}`, {
      uid,
    });
  }
  const masters = comps.filter((c) => !c.properties.some((p) => p.name === 'RECURRENCE-ID'));
  const overrides = comps.filter((c) => c.properties.some((p) => p.name === 'RECURRENCE-ID'));
  if (masters.length > 1) {
    if (duplicateMasters !== 'keep-first') {
      throw new IcsParseError('DUPLICATE_MASTER', `${masters.length} componenti senza RECURRENCE-ID per l'UID ${uid}`, {
        uid,
        details: { count: masters.length },
      });
    }
    warnings.push({
      code: 'DUPLICATE_MASTER_DROPPED',
      message: `${masters.length - 1} master duplicati scartati per l'UID ${uid}`,
      uid,
    });
  }
  const seen = new Set<string>();
  for (const ov of overrides) {
    const key = rawRecurrenceKey(ov);
    if (key == null) continue;
    if (seen.has(key)) {
      warnings.push({ code: 'DUPLICATE_RECURRENCE_ID', message: `RECURRENCE-ID ripetuto nell'UID ${uid}`, uid });
    }
    seen.add(key);
  }
  return {
    uid,
    componentType: [...types][0] as SchedulableComponentType,
    calendarProperties,
    master: masters[0] ?? null,
    overrides,
    timezones,
    otherComponents,
  };
}

/**
 * VCALENDAR → oggetto calendario (una risorsa CalDAV: master e override di un
 * solo UID, più VTIMEZONE e componenti estranei conservati). Non clona: il
 * risultato condivide i nodi dell'albero passato. Errori tipizzati per
 * oggetto: NOT_ICALENDAR, NO_COMPONENT, MIXED_COMPONENT_TYPES, MISSING_UID,
 * MULTIPLE_UIDS, DUPLICATE_MASTER. Override con lo stesso RECURRENCE-ID →
 * avviso DUPLICATE_RECURRENCE_ID (restano entrambi).
 */
export function calendarToObject(cal: IcsComponent): ParseResult<CalendarObject> {
  return run((warnings) => {
    if (cal.name !== 'VCALENDAR') throw new IcsParseError('NOT_ICALENDAR', `Radice ${cal.name} al posto di VCALENDAR`);
    const timezones = cal.components.filter((c) => c.name === 'VTIMEZONE');
    const comps = cal.components.filter(isSchedulable);
    const others = cal.components.filter((c) => c.name !== 'VTIMEZONE' && !isSchedulable(c));
    if (comps.length === 0) throw new IcsParseError('NO_COMPONENT', 'Nessun VEVENT, VTODO o VJOURNAL nell\'oggetto');
    const uids = new Set<string>();
    for (const c of comps) {
      const uid = componentUid(c);
      if (uid == null) throw new IcsParseError('MISSING_UID', `${c.name} senza UID`);
      uids.add(uid);
    }
    if (uids.size > 1) {
      throw new IcsParseError('MULTIPLE_UIDS', `Una risorsa con ${uids.size} UID diversi`, { details: { count: uids.size } });
    }
    const [uid] = [...uids];
    return buildObject(uid, comps, cal.properties, timezones, others, warnings, 'error');
  }, 'calendarToObject');
}

/** parseIcs + calendarToObject, con gli avvisi di entrambi. */
export function parseCalendarObject(input: string | Uint8Array, opts: ParseOptions = {}): ParseResult<CalendarObject> {
  const cal = parseIcs(input, opts);
  if (!cal.ok) return cal;
  const obj = calendarToObject(cal.value);
  return obj.ok
    ? { ok: true, value: obj.value, warnings: [...cal.warnings, ...obj.warnings] }
    : { ok: false, error: obj.error, warnings: [...cal.warnings, ...obj.warnings] };
}

/** Come parseCalendarObject, ma lancia l'IcsParseError. */
export function parseCalendarObjectOrThrow(input: string | Uint8Array, opts: ParseOptions = {}): CalendarObject {
  const r = parseCalendarObject(input, opts);
  if (!r.ok) throw r.error;
  return r.value;
}

export interface SplitOptions {
  /** Master duplicati per lo stesso UID: 'error' (default) per quell'UID, o 'keep-first' con avviso. */
  duplicateMasters?: 'error' | 'keep-first';
}

export interface SplitError {
  /** UID del gruppo fallito, o null per un componente senza UID. */
  uid: string | null;
  /** Posizione del (primo) componente fra i figli del VCALENDAR. */
  index: number;
  error: IcsParseError;
}

export interface SplitResult {
  /** Un oggetto per UID, nell'ordine di prima apparizione. */
  objects: CalendarObject[];
  /** Errori per oggetto: gli altri UID restano validi. */
  errors: SplitError[];
  warnings: IcsWarning[];
}

/**
 * Divide un VCALENDAR con molti UID (feed ICS, import) in oggetti calendario,
 * uno per UID. Ogni oggetto riceve le proprietà del calendario e solo i
 * VTIMEZONE che i suoi componenti referenziano. Gli errori sono per oggetto
 * (un UID rotto non fa perdere gli altri). I componenti non schedulabili
 * diversi da VTIMEZONE vengono ignorati con un avviso.
 */
export function splitCalendar(cal: IcsComponent, opts: SplitOptions = {}): SplitResult {
  try {
    const warnings: IcsWarning[] = [];
    const errors: SplitError[] = [];
    const objects: CalendarObject[] = [];
    if (cal.name !== 'VCALENDAR') {
      errors.push({ uid: null, index: -1, error: new IcsParseError('NOT_ICALENDAR', `Radice ${cal.name} al posto di VCALENDAR`) });
      return { objects, errors, warnings };
    }
    const timezones = cal.components.filter((c) => c.name === 'VTIMEZONE');
    const tzByTzid = new Map<string, IcsComponent>();
    for (const tz of timezones) {
      const id = vtimezoneTzid(tz);
      if (id != null && !tzByTzid.has(id)) tzByTzid.set(id, tz);
    }
    const groups = new Map<string, { index: number; comps: IcsComponent[] }>();
    cal.components.forEach((c, index) => {
      if (c.name === 'VTIMEZONE') return;
      if (!isSchedulable(c)) {
        warnings.push({ code: 'IGNORED_COMPONENT', message: `Componente ${c.name} ignorato nello split` });
        return;
      }
      const uid = componentUid(c);
      if (uid == null) {
        errors.push({ uid: null, index, error: new IcsParseError('MISSING_UID', `${c.name} senza UID (posizione ${index})`) });
        return;
      }
      const g = groups.get(uid);
      if (g) g.comps.push(c);
      else groups.set(uid, { index, comps: [c] });
    });
    for (const [uid, g] of groups) {
      try {
        const refs = collectTzidRefs(g.comps);
        const ownTz = refs.map((id) => tzByTzid.get(id)).filter((x): x is IcsComponent => x != null);
        objects.push(buildObject(uid, g.comps, [...cal.properties], ownTz, [], warnings, opts.duplicateMasters ?? 'error'));
      } catch (err) {
        if (!(err instanceof IcsParseError)) throw err;
        errors.push({ uid, index: g.index, error: err });
      }
    }
    return { objects, errors, warnings };
  } catch (err) {
    throw toCoreError(err, 'splitCalendar');
  }
}
