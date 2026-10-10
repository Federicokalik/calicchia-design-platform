/**
 * Righe di contenuto iCalendar (RFC 5545 §3.1): nomi, parametri, folding.
 *
 * Modulo interno senza dipendenze di runtime dal resto del pacchetto, usato da
 * serialize.ts (testo canonico) e da tz-registry.ts (VTIMEZONE verso ical.js).
 * Il parsing delle righe sta in parse.ts.
 */

import { SerializeError } from './errors';
import type { IcsComponent, IcsParam, IcsProperty } from './model';

export const CRLF = '\r\n';

/**
 * Accoda gli elementi di `items` a `target` con un ciclo: `push(...items)`
 * passa ogni elemento come argomento e oltre circa 120k elementi lancia un
 * RangeError non tipizzato (liste EXDATE/RDATE o componenti di input grandi).
 */
export function appendAll<T>(target: T[], items: Iterable<T>): T[] {
  for (const item of items) target.push(item);
  return target;
}

/** Lunghezza massima di una riga fisica in ottetti, CRLF escluso (RFC 5545 §3.1). */
export const FOLD_OCTETS = 75;

/**
 * Nomi di proprietà, parametri e componenti accettati. RFC 5545 ammette solo
 * ALPHA, DIGIT e '-' (iana-token, x-name); '_' e '.' sono tollerati perché
 * compaiono in prodotti reali e vanno conservati, non scartati.
 */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Caratteri che impongono le virgolette in un valore di parametro (RFC 5545 SAFE-CHAR). */
const NEEDS_QUOTES_RE = /[:;,]/;

/** Caratteri vietati anche fra virgolette (QSAFE-CHAR esclude DQUOTE e i CTL, tranne HTAB). */
// eslint-disable-next-line no-control-regex
const INVALID_PARAM_CHAR_RE = /["\u0000-\u0008\u000a-\u001f\u007f]/;

/** Ottetti UTF-8 di un code point. I surrogati isolati diventano U+FFFD (3 ottetti) in codifica. */
function codePointOctets(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** Lunghezza in ottetti UTF-8 di una stringa, senza allocare. */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (const ch of s) n += codePointOctets(ch.codePointAt(0) ?? 0);
  return n;
}

/**
 * Spazi bianchi secondo `str.isspace` di Python. vobject (Radicale) chiude la
 * riga logica su ogni riga fisica con `line.rstrip() == ''`, e Radicale
 * cancella prima le righe di soli spazi e tab: una continuazione fatta solo di
 * questi caratteri perde dati in silenzio (spazi) o rende l'oggetto illeggibile
 * (NBSP, U+3000: la continuazione successiva diventa una riga senza nome).
 */
const PY_WHITESPACE_RE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;

function isPyWhitespace(ch: string): boolean {
  return PY_WHITESPACE_RE.test(ch);
}

/**
 * Folding RFC 5545 §3.1: righe fisiche di al massimo 75 ottetti UTF-8 (CRLF
 * escluso); le continuazioni iniziano con uno spazio, che conta nei 75. Non
 * spezza mai un code point (accentate da 2 ottetti, emoji da 4). Una
 * continuazione non è mai fatta di soli spazi bianchi (isPyWhitespace): se il
 * tratto lo sarebbe, si allunga fino al primo carattere che non lo è (una
 * riga oltre i 75 ottetti, che vobject e gli altri parser leggono), e un
 * tratto finale di soli spazi resta sulla riga precedente. Restituisce le
 * righe unite da CRLF, senza CRLF finale.
 */
export function foldLine(line: string): string {
  // Ogni unità UTF-16 vale al massimo 3 ottetti: le righe corte non vanno misurate.
  if (line.length * 3 <= FOLD_OCTETS || utf8ByteLength(line) <= FOLD_OCTETS) return line;
  const out: string[] = [];
  let buf = '';
  let bufOctets = 0;
  /** True se `buf` (una continuazione) è fatto di soli spazi bianchi. */
  let bufBlank = false;
  let limit = FOLD_OCTETS;
  for (const ch of line) {
    const octets = codePointOctets(ch.codePointAt(0) ?? 0);
    if (bufOctets + octets > limit && !(out.length > 0 && bufBlank)) {
      out.push(out.length === 0 ? buf : ` ${buf}`);
      buf = ch;
      bufOctets = octets;
      bufBlank = isPyWhitespace(ch);
      limit = FOLD_OCTETS - 1;
    } else {
      buf += ch;
      bufOctets += octets;
      bufBlank = bufBlank && isPyWhitespace(ch);
    }
  }
  if (buf.length > 0 || out.length === 0) {
    if (out.length > 0 && bufBlank) out[out.length - 1] += buf;
    else out.push(out.length === 0 ? buf : ` ${buf}`);
  }
  return out.join(CRLF);
}

/** Valida un nome (proprietà, parametro, componente) e lo porta in maiuscolo. */
export function canonicalName(name: string, what: string): string {
  if (!NAME_RE.test(name)) {
    throw new SerializeError('INVALID_NAME', `Nome di ${what} non valido: "${name.slice(0, 40)}"`, { name: name.slice(0, 40) });
  }
  return name.toUpperCase();
}

/**
 * Valore di parametro pronto per la riga: fra virgolette se contiene ':', ';'
 * o ','. Le virgolette e i caratteri di controllo non sono rappresentabili
 * (vanno codificati con encodeParamValue, RFC 6868) e producono un errore.
 */
export function formatParamValue(value: string, paramName: string): string {
  if (INVALID_PARAM_CHAR_RE.test(value)) {
    throw new SerializeError(
      'INVALID_PARAMETER',
      `Valore del parametro ${paramName} con virgolette o caratteri di controllo (usare encodeParamValue)`,
      { param: paramName },
    );
  }
  return NEEDS_QUOTES_RE.test(value) ? `"${value}"` : value;
}

function formatParam(param: IcsParam): string {
  const name = canonicalName(param.name, 'parametro');
  // Un parametro senza '=' (sintassi vCard 2.1 tollerata dal parse) resta tale.
  if (param.values.length === 0) return `;${name}`;
  const values = param.values.map((v) => formatParamValue(name === 'VALUE' ? v.toUpperCase() : v, name));
  return `;${name}=${values.join(',')}`;
}

/** Riga di contenuto non piegata: NOME;PARAM=VAL:valore. */
export function contentLine(prop: IcsProperty): string {
  const name = canonicalName(prop.name, 'proprietà');
  if (/[\r\n]/.test(prop.value)) {
    throw new SerializeError('INVALID_VALUE', `Valore della proprietà ${name} con un a capo non codificato`, { property: name });
  }
  let line = name;
  for (const p of prop.params) line += formatParam(p);
  return `${line}:${prop.value}`;
}

/** Righe non piegate di un componente (BEGIN ... END), aggiunte a `out`. */
export function componentLines(comp: IcsComponent, out: string[]): string[] {
  const name = canonicalName(comp.name, 'componente');
  out.push(`BEGIN:${name}`);
  for (const p of comp.properties) out.push(contentLine(p));
  for (const c of comp.components) componentLines(c, out);
  out.push(`END:${name}`);
  return out;
}

// ============================================
// TEXT (RFC 5545 §3.3.11) e valori di parametro (RFC 6868)
// ============================================

/**
 * Decodifica un valore TEXT: \\ → \, \; → ;, \, → ,, \n e \N → a capo.
 * Una sequenza di escape non prevista (es. "\:") resta letterale, così un
 * prodotto che non fa l'escape dei backslash non perde caratteri.
 */
export function decodeText(raw: string): string {
  if (!raw.includes('\\')) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\' || i === raw.length - 1) {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === '\\' || next === ';' || next === ',') out += next;
    else out += `\\${next}`;
    i++;
  }
  return out;
}

/** Codifica un testo come valore TEXT: backslash, ';', ',' e a capo (CRLF, LF, CR → \n). */
export function encodeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Divide un valore TEXT multiplo (CATEGORIES, RESOURCES) sulle virgole non precedute da escape e decodifica ogni parte. */
export function splitTextList(raw: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i < raw.length - 1) {
      cur += ch + raw[i + 1];
      i++;
    } else if (ch === ',') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map(decodeText);
}

/** Inverso di splitTextList. */
export function joinTextList(values: readonly string[]): string {
  return values.map(encodeText).join(',');
}

/** Decodifica RFC 6868 di un valore di parametro: ^n → a capo, ^' → ", ^^ → ^. */
export function decodeParamValue(value: string): string {
  if (!value.includes('^')) return value;
  return value.replace(/\^(n|N|'|\^)/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c === "'" ? '"' : '^'));
}

/** Codifica RFC 6868 di un valore di parametro (inverso di decodeParamValue). */
export function encodeParamValue(value: string): string {
  return value.replace(/\^/g, '^^').replace(/\r\n|\r|\n/g, '^n').replace(/"/g, "^'");
}

// ============================================
// Riferimenti ai fusi
// ============================================

/**
 * TZID referenziati dalle proprietà dei componenti (ricorsivamente, VALARM
 * compresi), esclusi i VTIMEZONE stessi. Ordinati e senza duplicati.
 */
export function collectTzidRefs(components: readonly IcsComponent[]): string[] {
  const refs = new Set<string>();
  const walk = (c: IcsComponent): void => {
    if (c.name.toUpperCase() === 'VTIMEZONE') return;
    for (const p of c.properties) {
      for (const param of p.params) {
        if (param.name.toUpperCase() === 'TZID' && param.values.length > 0) refs.add(param.values[0]);
      }
    }
    for (const sub of c.components) walk(sub);
  };
  for (const c of components) walk(c);
  return [...refs].sort();
}

/** TZID dichiarato da un VTIMEZONE (proprietà TZID), o null. */
export function vtimezoneTzid(vtz: IcsComponent): string | null {
  const p = vtz.properties.find((x) => x.name.toUpperCase() === 'TZID');
  return p ? p.value.trim() : null;
}
