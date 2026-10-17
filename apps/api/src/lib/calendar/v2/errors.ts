/**
 * Errori dell'API admin del calendario v2 (F6, contratto
 * docs/calendar-radicale/contracts/f6-modules.md §3.10, §5.2).
 *
 * `CalendarV2Error` porta il codice del §3.10 e lo stato HTTP; il router
 * (routes/calendar/admin-v2.ts) lo serializza come `CalV2ErrorBody`.
 * `CalendarV2PreconditionError` è il 412 `PRECONDITION_FAILED` con la versione
 * del server (`current`) e i conflitti per campo (§3.3).
 *
 * `v2ErrorFrom` converte gli errori del dominio che le funzioni di scrittura
 * del core e dello store lanciano in `CalendarV2Error`, così il router ha un
 * solo punto di mappatura (onError del §3.1).
 */

import { IcsValueError, RecurrenceTargetError, ValidationError, type ValidationIssue } from '@calicchia/calendar-core';
import type {
  CalV2ErrorBody,
  CalV2ErrorCode,
  CalV2FieldConflict,
  CalV2Issue,
  CalV2ObjectView,
  CalV2PreconditionFailedBody,
} from '@calicchia/shared';
import { CalendarRecurrenceConflictError, EventReadOnlyError, EventValidationError } from '../errors';

export type CalV2ErrorStatus = 400 | 403 | 404 | 409 | 412 | 428;

export class CalendarV2Error extends Error {
  readonly code: CalV2ErrorCode;
  readonly status: CalV2ErrorStatus;
  readonly details?: Record<string, unknown>;

  constructor(code: CalV2ErrorCode, status: CalV2ErrorStatus, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CalendarV2Error';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }

  /** Corpo della risposta JSON (`CalV2ErrorBody`). */
  toBody(): CalV2ErrorBody {
    return this.details !== undefined
      ? { error: this.message, code: this.code, details: this.details }
      : { error: this.message, code: this.code };
  }
}

/** 412: la risorsa è cambiata e le modifiche non si fondono (o non sono fondibili: DELETE). */
export class CalendarV2PreconditionError extends CalendarV2Error {
  readonly current: CalV2ObjectView;
  readonly conflicts: CalV2FieldConflict[];

  constructor(current: CalV2ObjectView, conflicts: CalV2FieldConflict[]) {
    super(
      'PRECONDITION_FAILED',
      412,
      conflicts.length
        ? 'L\'evento è stato modificato nel frattempo: verifica i campi in conflitto'
        : 'L\'evento è stato modificato nel frattempo: ricarica e riprova',
    );
    this.name = 'CalendarV2PreconditionError';
    this.current = current;
    this.conflicts = conflicts;
  }

  toBody(): CalV2PreconditionFailedBody {
    return { error: this.message, code: 'PRECONDITION_FAILED', current: this.current, conflicts: this.conflicts };
  }
}

// ─── Issue di validazione ───────────────────────────────

/** ValidationIssue di calendar-core → CalV2Issue (stessa forma, `recurrenceKey` → `recurrence_key`). */
export function toV2Issue(issue: ValidationIssue): CalV2Issue {
  const out: CalV2Issue = { code: issue.code, severity: issue.severity, message: issue.message };
  if (issue.property !== undefined) out.property = issue.property;
  if (issue.recurrenceKey !== undefined) out.recurrence_key = issue.recurrenceKey;
  return out;
}

/** 400 VALIDATION_FAILED con l'elenco delle issue in `details.issues`. */
export function validationFailed(message: string, issues: readonly CalV2Issue[]): CalendarV2Error {
  return new CalendarV2Error('VALIDATION_FAILED', 400, message, { issues });
}

/** 400 VALIDATION_FAILED con una sola issue di errore. */
export function invalidValue(message: string, property?: string): CalendarV2Error {
  return validationFailed(message, [property ? { code: 'INVALID_VALUE', severity: 'error', message, property } : { code: 'INVALID_VALUE', severity: 'error', message }]);
}

/** 403 READ_ONLY con il motivo in `details.reason`. */
export function readOnly(message: string, reason: string, extra?: Record<string, unknown>): CalendarV2Error {
  return new CalendarV2Error('READ_ONLY', 403, message, { reason, ...(extra ?? {}) });
}

// ─── Cronologia e cestino (tranche C, contratto §9.8) ───────────────────────────────

/** Motivi di 409 VERSION_NOT_RESTORABLE (`details.reason`). */
export type VersionNotRestorableReason = 'invalid' | 'expired' | 'other_object';

const VERSION_NOT_RESTORABLE_MESSAGES: Record<VersionNotRestorableReason, string> = {
  invalid: 'Questa versione non si può ripristinare: il testo non era valido',
  expired: 'Questa versione è scaduta: la cronologia conserva 90 giorni',
  other_object: 'Questa versione appartiene a un altro evento',
};

/** 409 VERSION_NOT_RESTORABLE con il motivo in `details.reason`. */
export function versionNotRestorable(reason: VersionNotRestorableReason): CalendarV2Error {
  return new CalendarV2Error('VERSION_NOT_RESTORABLE', 409, VERSION_NOT_RESTORABLE_MESSAGES[reason], { reason });
}

/** Motivi di 409 NOT_RESTORABLE (`details.reason`): quelli del cestino più `href_taken`. */
export type NotRestorableReason = 'uid_exists' | 'calendar_gone' | 'calendar_readonly' | 'no_valid_version' | 'expired' | 'href_taken';

const NOT_RESTORABLE_MESSAGES: Record<NotRestorableReason, string> = {
  uid_exists: 'Esiste già un evento con lo stesso UID: non si può ripristinare un duplicato',
  calendar_gone: 'Il calendario originale non esiste più: scegli un altro calendario',
  calendar_readonly: 'Il calendario di destinazione è in sola lettura: scegli un altro calendario',
  no_valid_version: 'Non c\'è nessuna versione valida da ripristinare',
  expired: 'L\'ultima versione valida è scaduta: la cronologia conserva 90 giorni',
  href_taken: 'Nel calendario di destinazione c\'è già un evento con lo stesso nome',
};

/** 409 NOT_RESTORABLE con il motivo in `details.reason`. */
export function notRestorable(reason: NotRestorableReason, extra?: Record<string, unknown>): CalendarV2Error {
  return new CalendarV2Error('NOT_RESTORABLE', 409, NOT_RESTORABLE_MESSAGES[reason], { reason, ...(extra ?? {}) });
}

// ─── Mappatura degli errori del dominio ───────────────────────────────

/**
 * Errori di calendar-core e dello store → CalendarV2Error (onError del §3.1):
 *  - CalendarV2Error: così com'è;
 *  - CalendarRecurrenceConflictError e RecurrenceTargetError → 409
 *    RECURRENCE_TARGET_GONE;
 *  - EventReadOnlyError → 403 READ_ONLY;
 *  - ValidationError (calendar-core) → 400 VALIDATION_FAILED con `details.issues`;
 *  - IcsValueError e EventValidationError → 400 VALIDATION_FAILED con una issue.
 * Il resto (database, difetti, CalendarUnavailableError) → null: lo gestisce
 * il chiamante o l'handler globale.
 */
export function v2ErrorFrom(err: unknown): CalendarV2Error | null {
  if (err instanceof CalendarV2Error) return err;
  if (err instanceof CalendarRecurrenceConflictError) {
    return new CalendarV2Error('RECURRENCE_TARGET_GONE', 409, err.message, { recurrence_key: err.recurrenceKey });
  }
  if (err instanceof RecurrenceTargetError) {
    return new CalendarV2Error('RECURRENCE_TARGET_GONE', 409, err.message, { recurrence_key: err.recurrenceKey });
  }
  if (err instanceof EventReadOnlyError) return new CalendarV2Error('READ_ONLY', 403, err.message);
  if (err instanceof ValidationError) {
    const errors = err.issues.filter((i) => i.severity === 'error');
    return validationFailed(errors[0]?.message ?? 'Evento non valido', err.issues.map(toV2Issue));
  }
  if (err instanceof IcsValueError) return invalidValue(err.message, err.property ?? undefined);
  if (err instanceof EventValidationError) return invalidValue(err.message);
  return null;
}
