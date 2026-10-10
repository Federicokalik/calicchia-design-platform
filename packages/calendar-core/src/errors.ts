/**
 * Errori e avvisi tipizzati di @calicchia/calendar-core.
 *
 * Regola del pacchetto: nessuna funzione pubblica lascia uscire un'eccezione
 * non tipizzata. Le funzioni di parse restituiscono un risultato discriminato
 * (`ok: true | false`) con l'errore tipizzato; le altre lanciano solo
 * sottoclassi di `CalendarCoreError`, ognuna con un `code` stabile che l'API
 * usa per decidere la salute dell'oggetto (quarantena, busy conservativo) o il
 * codice HTTP. I messaggi sono in italiano e non contengono mai il testo
 * completo dell'oggetto (possono finire nei log): al massimo un estratto breve.
 */

/** Errore base del pacchetto. `code` è stabile e documentato; `details` è serializzabile in JSON. */
export class CalendarCoreError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

// ============================================
// Parse (struttura del testo iCalendar)
// ============================================

export type IcsParseErrorCode =
  /** Input vuoto o di soli spazi. */
  | 'EMPTY_INPUT'
  /** Input oltre `maxBytes`, o un oggetto oltre i limiti strutturali (parse.ObjectLimits). */
  | 'TOO_LARGE'
  /** Byte non UTF-8 validi (solo con input Uint8Array e `invalidUtf8: 'error'`). */
  | 'INVALID_ENCODING'
  /** Nessun BEGIN:VCALENDAR (pagina HTML, body di errore, vCard...). */
  | 'NOT_ICALENDAR'
  /** Righe di contenuto prima di BEGIN:VCALENDAR o dopo END:VCALENDAR. */
  | 'CONTENT_OUTSIDE_VCALENDAR'
  /** Riga di contenuto non conforme (manca ':', nome non valido, virgolette non chiuse). */
  | 'MALFORMED_LINE'
  /** END senza BEGIN corrispondente, o con un nome diverso. */
  | 'UNBALANCED_COMPONENT'
  /** Fine del testo con componenti ancora aperti. */
  | 'UNTERMINATED_COMPONENT'
  /** Annidamento oltre `maxDepth`. */
  | 'TOO_DEEP'
  /** Più VCALENDAR con `multipleCalendars: 'error'`. */
  | 'MULTIPLE_VCALENDAR'
  /** Oggetto senza VEVENT, VTODO o VJOURNAL. */
  | 'NO_COMPONENT'
  /** Componente schedulabile senza UID. */
  | 'MISSING_UID'
  /** Una risorsa CalDAV con più UID (RFC 4791 §4.1). */
  | 'MULTIPLE_UIDS'
  /** VEVENT e VTODO (o VJOURNAL) nella stessa risorsa. */
  | 'MIXED_COMPONENT_TYPES'
  /** Due componenti senza RECURRENCE-ID con lo stesso UID. */
  | 'DUPLICATE_MASTER';

/** Errore strutturale di parse. `line` è la riga fisica (1-based) dove inizia la riga logica colpevole. */
export class IcsParseError extends CalendarCoreError {
  declare readonly code: IcsParseErrorCode;
  readonly line: number | null;
  readonly uid: string | null;

  constructor(
    code: IcsParseErrorCode,
    message: string,
    opts: { line?: number | null; uid?: string | null; details?: Record<string, unknown> } = {},
  ) {
    super(code, message, { ...(opts.details ?? {}), line: opts.line ?? null, uid: opts.uid ?? null });
    this.line = opts.line ?? null;
    this.uid = opts.uid ?? null;
  }
}

// ============================================
// Valori (decodifica dei tipi iCalendar e del DTO legacy)
// ============================================

export type IcsValueErrorCode =
  | 'INVALID_DATE'
  | 'INVALID_DATE_TIME'
  | 'INVALID_DURATION'
  | 'INVALID_PERIOD'
  | 'INVALID_INTEGER'
  | 'INVALID_GEO'
  | 'INVALID_UTC_OFFSET'
  | 'INVALID_RECURRENCE_KEY'
  /** Istante ISO del DTO legacy non interpretabile. */
  | 'INVALID_ISO'
  /** Data 'YYYY-MM-DD' non valida. */
  | 'INVALID_DATE_STRING'
  /** Proprietà obbligatoria assente (es. DTSTART di un VEVENT, UID). */
  | 'MISSING_PROPERTY'
  /** Valore incoerente con il contesto (es. tipi misti in un EXDATE). */
  | 'INVALID_VALUE';

export class IcsValueError extends CalendarCoreError {
  declare readonly code: IcsValueErrorCode;
  readonly property: string | null;

  constructor(code: IcsValueErrorCode, message: string, opts: { property?: string | null; value?: string | null } = {}) {
    super(code, message, { property: opts.property ?? null, value: excerpt(opts.value ?? null) });
    this.property = opts.property ?? null;
  }
}

// ============================================
// Serializzazione
// ============================================

export type SerializeErrorCode =
  /** Nome di proprietà, parametro o componente non valido. */
  | 'INVALID_NAME'
  /** Valore grezzo con CR o LF (romperebbe il formato). */
  | 'INVALID_VALUE'
  /** Valore di parametro con virgolette o caratteri di controllo (usare encodeParamValue, RFC 6868). */
  | 'INVALID_PARAMETER'
  /** Oggetto incoerente (es. senza componenti). */
  | 'INVALID_OBJECT';

export class SerializeError extends CalendarCoreError {
  declare readonly code: SerializeErrorCode;
  constructor(code: SerializeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}

// ============================================
// Fusi orari
// ============================================

export type TimezoneErrorCode =
  /** Fuso non risolvibile (né IANA, né alias, né VTIMEZONE dell'oggetto). */
  | 'UNKNOWN_TIMEZONE'
  /** VTIMEZONE non interpretabile da ical.js. */
  | 'INVALID_VTIMEZONE'
  /** Conversione richiesta su un orario floating senza fuso di riferimento. */
  | 'FLOATING_WITHOUT_ZONE';

export class TimezoneError extends CalendarCoreError {
  declare readonly code: TimezoneErrorCode;
  constructor(code: TimezoneErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}

// ============================================
// Avvisi (non bloccanti)
// ============================================

export type IcsWarningCode =
  /** Riga malformata saltata (`malformedLines: 'skip'`). */
  | 'SKIPPED_LINE'
  /** Più VCALENDAR uniti nel primo (`multipleCalendars: 'merge'`). */
  | 'MERGED_VCALENDAR'
  /** Byte non UTF-8 sostituiti con U+FFFD (`invalidUtf8: 'replace'`). */
  | 'INVALID_UTF8_REPLACED'
  /** Due override con lo stesso RECURRENCE-ID: restano entrambi, l'espansione ne usa uno. */
  | 'DUPLICATE_RECURRENCE_ID'
  /** Componente di primo livello non schedulabile ignorato nello split (VFREEBUSY, X-...). */
  | 'IGNORED_COMPONENT'
  /** Master duplicato scartato nello split di un feed (`duplicateMasters: 'keep-first'`). */
  | 'DUPLICATE_MASTER_DROPPED'
  /** Proprietà con valore non interpretabile, ignorata nella vista tipizzata (resta nel modello). */
  | 'INVALID_PROPERTY_VALUE'
  /** Proprietà che RFC 5545 ammette una sola volta, presente più volte: vale la prima. */
  | 'DUPLICATE_PROPERTY'
  /** DTEND e DURATION insieme: vale DTEND. */
  | 'DTEND_AND_DURATION'
  /** DTSTART e DTEND (o EXDATE, RECURRENCE-ID) di tipo diverso (DATE contro DATE-TIME). */
  | 'VALUE_TYPE_MISMATCH'
  /** DTEND precedente a DTSTART: la vista usa una durata nulla. */
  | 'END_BEFORE_START'
  /** TZID non risolvibile e senza VTIMEZONE: l'orario si interpreta nel fuso del calendario. */
  | 'UNKNOWN_TZID'
  /** Valore con suffisso Z e parametro TZID insieme: vale la Z (UTC). */
  | 'TZID_WITH_UTC';

export interface IcsWarning {
  code: IcsWarningCode;
  message: string;
  line?: number;
  uid?: string | null;
  property?: string;
}

// ============================================
// Utilità
// ============================================

export function isCalendarCoreError(err: unknown): err is CalendarCoreError {
  return err instanceof CalendarCoreError;
}

/** Riduce un valore a un estratto breve e sicuro per log e dettagli degli errori. */
export function excerpt(value: string | null, max = 80): string | null {
  if (value == null) return null;
  const clean = value.replace(/[\r\n\t]+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Converte qualsiasi eccezione imprevista in un CalendarCoreError('INTERNAL').
 * Le eccezioni già tipizzate passano invariate.
 */
export function toCoreError(err: unknown, context: string): CalendarCoreError {
  if (err instanceof CalendarCoreError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CalendarCoreError('INTERNAL', `${context}: ${message}`, { context });
}
