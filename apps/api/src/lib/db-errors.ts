/**
 * Database error boundary (DBX-04).
 *
 * Maps `postgres` driver errors to clean, client-safe API responses. Without
 * this, the ~60% of routes that run `sql` without a try/catch let raw driver
 * errors bubble to the global onError handler and surface as opaque 500s — a
 * unique-violation, a foreign-key conflict and a dropped connection were all
 * indistinguishable to the caller.
 *
 * Used centrally by `app.onError` (see app.ts): it runs AFTER the HTTPException
 * branch, so any route that already catches the error and re-throws via
 * `fail()` keeps full control — this is purely the fallback for unhandled
 * driver errors. Messages are intentionally generic (Italian, UI language):
 * they never leak table, column or constraint names.
 */
import postgres from 'postgres';

export interface MappedDbError {
  /** HTTP status to return. */
  status: 400 | 409 | 422 | 503;
  /** Client-safe Italian message. Never contains schema details. */
  message: string;
  /**
   * true  → caused by the request (4xx): log at warn, do not report.
   * false → infrastructure failure (5xx): log at error, report to Bugsink.
   */
  client: boolean;
}

/**
 * Connection-level failure codes from the `postgres` driver (ConnectionError)
 * plus the Node socket errors thrown when the initial connect fails.
 */
const CONNECTION_CODES = new Set([
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

const UNAVAILABLE = 'Servizio temporaneamente non disponibile, riprova tra poco.';

/**
 * Map a thrown error to a clean API response. Returns `null` when the error is
 * not a recognised database driver error — the caller should then fall back to
 * its generic 500 handling.
 */
export function mapDbError(err: unknown): MappedDbError | null {
  const code =
    typeof (err as { code?: unknown })?.code === 'string'
      ? (err as { code: string }).code
      : null;

  // Availability failures: the request never reached Postgres, or the server
  // cancelled the statement (timeout). Retryable — surface as 503.
  if (code && CONNECTION_CODES.has(code)) {
    return { status: 503, message: UNAVAILABLE, client: false };
  }
  if (code === '57014') {
    // query_canceled — almost always a statement_timeout firing.
    return { status: 503, message: "L'operazione ha superato il tempo massimo, riprova.", client: false };
  }

  if (!(err instanceof postgres.PostgresError)) return null;

  switch (err.code) {
    case '23505': // unique_violation
      return { status: 409, message: 'Esiste già un record con questi dati.', client: true };
    case '23503': // foreign_key_violation
      return { status: 409, message: 'Operazione non consentita: i dati sono collegati ad altri record.', client: true };
    case '23502': // not_null_violation
      return { status: 400, message: 'Dati incompleti: manca un campo obbligatorio.', client: true };
    case '23514': // check_violation
      return { status: 400, message: 'Dati non validi: un valore non rispetta i vincoli richiesti.', client: true };
    case '23P01': // exclusion_violation
      return { status: 409, message: 'Conflitto con un record esistente.', client: true };
    case '22P02': // invalid_text_representation (malformed uuid/int/enum cast)
    case '22003': // numeric_value_out_of_range
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
    case '22001': // string_data_right_truncation
      return { status: 400, message: 'Dati non validi: formato o valore non corretto.', client: true };
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return { status: 409, message: 'Conflitto temporaneo tra operazioni, riprova.', client: true };
    case '53300': // too_many_connections
    case '53400': // configuration_limit_exceeded
    case '57P03': // cannot_connect_now
      return { status: 503, message: 'Servizio temporaneamente sovraccarico, riprova tra poco.', client: false };
  }

  // SQLSTATE class fallbacks for codes not enumerated above.
  switch (err.code?.slice(0, 2)) {
    case '08': // connection_exception
      return { status: 503, message: UNAVAILABLE, client: false };
    case '53': // insufficient_resources
      return { status: 503, message: 'Servizio temporaneamente sovraccarico, riprova tra poco.', client: false };
    case '23': // integrity_constraint_violation
      return { status: 409, message: 'L\'operazione viola un vincolo sui dati.', client: true };
    case '22': // data_exception
      return { status: 400, message: 'Dati non validi.', client: true };
    case '54': // program_limit_exceeded
      return { status: 400, message: 'Richiesta troppo grande o complessa.', client: true };
  }

  // Any other PostgresError (syntax_error, undefined_table/column, …) is a
  // server-side bug. Return null so the caller emits a generic 500 and reports.
  return null;
}
