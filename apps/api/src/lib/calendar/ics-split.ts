/**
 * Split di un feed ICS remoto in oggetti calendario, uno per UID (fase F2 del
 * passaggio a Radicale; design §5 "UID e href", §6.6, §14 "parseIcs rotto";
 * contratto dei moduli docs/calendar-radicale/contracts/f2-modules.md §8.1).
 *
 * Sostituisce, per il solo pull verso l'indice (subscriptions/pull.ts), il
 * parser legacy di ics-import.ts, che resta invariato per il pull legacy
 * (parità prima del cutover, compreso il sottoinsieme bacato). Qui si usa
 * @calicchia/calendar-core:
 *  - parseIcs tollerante (righe malformate saltate, più VCALENDAR uniti nel
 *    primo): una riga rotta non fa perdere l'intero calendario;
 *  - splitCalendar: un oggetto per UID con master e override insieme e i soli
 *    VTIMEZONE che referenzia; un UID rotto (due master, tipi misti) non fa
 *    perdere gli altri;
 *  - testo canonico della risorsa (serializeObject) con i VTIMEZONE canonici
 *    del registro: è il testo che va nell'indice (cal_objects.raw_ics) e nello
 *    specchio su Radicale (subscriptions/mirror.ts);
 *  - fingerprint semantico (semanticFingerprint) calcolato sullo stesso
 *    modello che si serializza: insensibile a DTSTAMP, LAST-MODIFIED, SEQUENCE
 *    e alle proprietà descrittive del VCALENDAR (X-WR-CALNAME...), quindi un
 *    feed che riscrive DTSTAMP a ogni download non produce scritture.
 *
 * Un UID che lo split non riesce a comporre in un oggetto valido NON sparisce:
 * finisce in `errors` con il suo href e il testo grezzo dei suoi componenti,
 * così il pull lo passa all'indicizzatore, che lo mette in quarantena (busy
 * conservativo sull'intervallo estraibile, o le occorrenze già indicizzate)
 * invece di trattarlo come cancellato (invariante 2 del design). I componenti
 * senza UID non hanno un href stabile: si scartano (come il parser legacy).
 *
 * Solo VEVENT: il sidecar di un'iscrizione ha components {VEVENT} e il parser
 * legacy importava solo VEVENT; VTODO e VJOURNAL di un feed vengono ignorati
 * (contati negli avvisi).
 *
 * Modulo puro: niente database, rete od orologio.
 */

import { createHash } from 'node:crypto';
import {
  type CalendarObject,
  canonicalComponentText,
  canonicalTimezonesFor,
  componentUid,
  contentSha256,
  type IcsComponent,
  type IcsProperty,
  objectComponents,
  parseIcs,
  semanticFingerprint,
  serializeCalendar,
  serializeObject,
  splitCalendar,
} from '@calicchia/calendar-core';

/** Un oggetto del feed pronto per l'indice (e per lo specchio). */
export interface SplitFeedObject {
  uid: string;
  /** `r-<base32(sha256(UID))[0..26]>.ics` (design §5). */
  href: string;
  /** Testo canonico della risorsa (VCALENDAR con un solo UID). */
  raw: string;
  /** Fingerprint semantico (calendar-core) del modello serializzato in `raw`. */
  semanticFp: string;
}

/**
 * Un UID (o un componente senza UID) che lo split non ha potuto comporre.
 * `href` e `raw` sono valorizzati quando l'UID è noto: il pull passa la
 * risorsa all'indicizzatore, che la mette in quarantena (raw null =
 * illeggibile).
 */
export interface SplitFeedError {
  uid: string | null;
  message: string;
  /** Codice dell'errore di calendar-core (es. DUPLICATE_MASTER, MISSING_UID). */
  code: string;
  /** href della risorsa per un UID noto, null per un componente senza UID. */
  href: string | null;
  /** Testo grezzo dei componenti dell'UID, se serializzabile. */
  raw: string | null;
  /**
   * Fingerprint tollerante di `raw` (tolerantFingerprint): il testo di un UID
   * rotto non si compone in un oggetto, quindi non ha un fingerprint
   * semantico; questo permette al pull di riconoscere lo stesso UID rotto al
   * download successivo (DTSTAMP nuovo) senza riscriverlo.
   */
  fingerprint: string | null;
}

export interface SplitFeedResult {
  objects: SplitFeedObject[];
  errors: SplitFeedError[];
  /** Avvisi del parse e dello split (righe saltate, componenti ignorati, master duplicati...). */
  warnings: number;
}

/** Errore del feed nel suo complesso (vuoto, non iCalendar, troncato, troppo grande): nessun oggetto utilizzabile. */
export class IcsFeedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IcsFeedError';
    this.code = code;
  }
}

// ─── href ───────────────────────────────

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/** Caratteri base32 dell'href: 26 × 5 = 130 bit dello SHA-256 dell'UID. */
const HREF_HASH_CHARS = 26;

/** Base32 RFC 4648 (alfabeto minuscolo, senza padding). */
function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * href della risorsa di un UID remoto (design §5, iscrizioni visibili):
 * `r-<base32(sha256(UID))[0..26]>.ics`, con lo SHA-256 dei byte UTF-8
 * dell'UID e l'alfabeto base32 minuscolo. Deterministico: lo stesso UID ha lo
 * stesso href nell'indice e nella collezione `sub-<id8>` di Radicale, e un
 * UID qualsiasi (anche con `/`, spazi o caratteri non ASCII) dà un nome sicuro.
 */
export function remoteHref(uid: string): string {
  const digest = createHash('sha256').update(uid, 'utf8').digest();
  return `r-${base32(digest).slice(0, HREF_HASH_CHARS)}.ics`;
}

/** Stessa forma di remoteHref (per riconoscere le risorse dello specchio). */
export const REMOTE_HREF_RE = /^r-[a-z2-7]{26}\.ics$/;

// ─── Split ───────────────────────────────

/**
 * Proprietà del VCALENDAR del feed da non copiare nelle risorse: METHOD (iTIP)
 * non è ammesso in una risorsa CalDAV (RFC 4791 §4.1). VERSION e PRODID le
 * riscrive il serializer.
 */
const DROPPED_CALENDAR_PROPERTIES = new Set(['METHOD']);

function resourceCalendarProperties(props: readonly IcsProperty[]): IcsProperty[] {
  return props.filter((p) => !DROPPED_CALENDAR_PROPERTIES.has(p.name.toUpperCase()));
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'INVALID';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Testo canonico e fingerprint di un oggetto dello split. I VTIMEZONE canonici
 * entrano nel modello PRIMA di serializzare e calcolare il fingerprint: il
 * fingerprint del testo salvato, riletto dall'indicizzatore (oggetti in
 * quarantena) o dallo specchio (confronto con Radicale), è lo stesso.
 */
function canonicalResource(obj: CalendarObject): { raw: string; semanticFp: string } {
  const resource: CalendarObject = {
    ...obj,
    calendarProperties: resourceCalendarProperties(obj.calendarProperties),
    timezones: canonicalTimezonesFor([...objectComponents(obj), ...obj.otherComponents], obj.timezones),
  };
  return {
    raw: serializeObject(resource, { timezones: 'preserve' }),
    semanticFp: semanticFingerprint(resource),
  };
}

/**
 * Fingerprint di un testo iCalendar che non si compone in un oggetto (UID
 * rotto): i componenti in forma canonica semantica (calendar-core
 * canonicalComponentText: proprietà ordinate, DTSTAMP, LAST-MODIFIED e
 * SEQUENCE esclusi), ordinati. Insensibile alle proprietà del VCALENDAR come
 * il fingerprint semantico. null se il testo non si legge nemmeno come
 * VCALENDAR.
 */
export function tolerantFingerprint(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = parseIcs(raw, { malformedLines: 'skip', multipleCalendars: 'merge' });
  if (!parsed.ok) return null;
  try {
    const blocks = parsed.value.components.map((c) => canonicalComponentText(c)).sort();
    return `t1:${contentSha256(blocks.join('\n'))}`;
  } catch {
    return null;
  }
}

/** Testo grezzo dei componenti di un UID rotto (per la quarantena), o null se non serializzabile. */
function brokenResourceText(cal: IcsComponent, uid: string): string | null {
  try {
    const comps = cal.components.filter((c) => c.name.toUpperCase() !== 'VTIMEZONE' && componentUid(c) === uid);
    if (comps.length === 0) return null;
    const timezones = cal.components.filter((c) => c.name.toUpperCase() === 'VTIMEZONE');
    return serializeCalendar({
      name: 'VCALENDAR',
      properties: resourceCalendarProperties(cal.properties),
      components: [...timezones, ...comps],
    });
  } catch {
    return null;
  }
}

/**
 * Divide un feed ICS in oggetti (uno per UID) con href, testo canonico e
 * fingerprint semantico. Lancia IcsFeedError solo se il feed nel suo insieme
 * non è utilizzabile (vuoto, non iCalendar, BEGIN/END sbilanciati o troncato,
 * oltre 10 MiB): in quel caso il pull lo rifiuta senza toccare l'indice. Gli
 * errori dei singoli UID vanno in `errors` e non fermano gli altri.
 */
export function splitIcsFeed(body: string): SplitFeedResult {
  const parsed = parseIcs(body, { malformedLines: 'skip', multipleCalendars: 'merge' });
  if (!parsed.ok) throw new IcsFeedError(parsed.error.code, parsed.error.message);
  const cal = parsed.value;
  let warnings = parsed.warnings.length;

  const split = splitCalendar(cal, { duplicateMasters: 'error' });
  warnings += split.warnings.length;

  const objects: SplitFeedObject[] = [];
  const errors: SplitFeedError[] = [];
  const seenHrefs = new Set<string>();

  for (const obj of split.objects) {
    if (obj.componentType !== 'VEVENT') {
      warnings++;
      continue;
    }
    const href = remoteHref(obj.uid);
    if (seenHrefs.has(href)) continue; // lo split dà un oggetto per UID: non succede
    seenHrefs.add(href);
    try {
      const { raw, semanticFp } = canonicalResource(obj);
      objects.push({ uid: obj.uid, href, raw, semanticFp });
    } catch (err) {
      // Valore non serializzabile: la risorsa resta, illeggibile (quarantena).
      errors.push({ uid: obj.uid, message: errorMessage(err), code: errorCode(err), href, raw: null, fingerprint: null });
    }
  }

  for (const e of split.errors) {
    if (e.uid === null) {
      errors.push({ uid: null, message: e.error.message, code: e.error.code, href: null, raw: null, fingerprint: null });
      continue;
    }
    // Tipi misti con un VTODO/VJOURNAL: se l'UID non ha VEVENT non è un evento del feed.
    const comps = cal.components.filter((c) => componentUid(c) === e.uid);
    if (!comps.some((c) => c.name.toUpperCase() === 'VEVENT')) {
      warnings++;
      continue;
    }
    const href = remoteHref(e.uid);
    if (seenHrefs.has(href)) continue;
    seenHrefs.add(href);
    const raw = brokenResourceText(cal, e.uid);
    errors.push({ uid: e.uid, message: e.error.message, code: e.error.code, href, raw, fingerprint: tolerantFingerprint(raw) });
  }

  return { objects, errors, warnings };
}
