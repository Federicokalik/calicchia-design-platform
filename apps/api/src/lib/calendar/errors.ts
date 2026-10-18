/**
 * Errori del dominio calendario condivisi dai due store (fase F2 del
 * passaggio a Radicale; design §8, §9, §12; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §1.4).
 *
 * Le classi storiche (EventValidationError, EventReadOnlyError,
 * CalendarValidationError, CalendarConflictError, CalendarSystemError,
 * SubscriptionValidationError) erano definite in events.ts, calendars.ts e
 * subscriptions.ts: stanno qui perché PgLegacyStore e RadicaleStore devono
 * lanciare la STESSA classe (le route e i tool MCP le riconoscono con
 * instanceof) e la facade le riesporta con gli stessi nomi. Codici e messaggi
 * sono invariati.
 *
 * Le classi nuove della F2:
 *  - CalendarUnavailableError (503 CALENDAR_UNAVAILABLE): il calendario non è
 *    verificabile o scrivibile adesso (transizione, freeze, identità del
 *    volume, collezione bloccante non sincronizzabile, Radicale irraggiungibile,
 *    store non disponibile). Mappatura: sito 503 con il testo del design §9,
 *    admin 503, MCP ramo {error} esistente senza `code`;
 *  - CalendarStoreUnavailableError: lo store selezionato dal modo non può
 *    servire la richiesta (RadicaleStore non implementato o non configurato);
 *  - CalendarRecurrenceConflictError (409 CALENDAR_CONFLICT): il target
 *    {recurrence_key} non appartiene più all'insieme corrente dell'oggetto;
 *  - CalendarFieldConflictError (409 CALENDAR_CONFLICT): CAS per campo fallito
 *    (design §8 passo 4), con {field, base, theirs, yours} per ogni campo.
 */

// ─── Errori storici (codici e messaggi invariati) ───────────

export class EventValidationError extends Error {
  code = 'EVENT_VALIDATION' as const;
  constructor(message: string) { super(message); }
}

export class EventReadOnlyError extends Error {
  code = 'EVENT_READ_ONLY' as const;
  constructor(message: string) { super(message); }
}

export class CalendarValidationError extends Error {
  code = 'CALENDAR_VALIDATION' as const;
  constructor(message: string) { super(message); }
}

export class CalendarConflictError extends Error {
  code = 'CALENDAR_CONFLICT' as const;
  constructor(message: string) { super(message); }
}

export class CalendarSystemError extends Error {
  code = 'CALENDAR_SYSTEM' as const;
  constructor(message = 'Calendario di sistema non eliminabile') { super(message); }
}

export class SubscriptionValidationError extends Error {
  code = 'SUBSCRIPTION_VALIDATION' as const;
  constructor(message: string) { super(message); }
}

// ─── Indisponibilità (503) ───────────────────────────────────

/** Testo per il sito pubblico (design §9, mappatura degli errori). */
export const CALENDAR_UNAVAILABLE_MESSAGE = 'Calendario temporaneamente non verificabile, riprova tra poco';

/**
 * Perché il calendario non è disponibile. Stabile: compare nei log, nella
 * salute e nei test; mai nella risposta del sito, che usa sempre il testo
 * generico.
 */
export const CALENDAR_UNAVAILABLE_REASONS = [
  /** Lo store selezionato dal modo non è implementato o non è configurato. */
  'store_not_available',
  /** Modo cutover o rollback: scritture calendario sospese (design §13.1). */
  'transition',
  /** write_freeze attivo (design §8 passo 2). */
  'write_freeze',
  /** Stato del backend illeggibile (DB, riga fuori contratto). */
  'state_unreadable',
  /** Identità del volume diversa o assente (design §6.3). */
  'identity_mismatch',
  /** Identità del volume non verificabile (mount assente, Radicale irraggiungibile). */
  'identity_unverified',
  /** Radicale irraggiungibile o in errore. */
  'radicale_unreachable',
  /** Collezione bloccante non sincronizzabile con modifiche pendenti (design §6.5). */
  'collection_unsyncable',
  /** Freshness oltre il budget (2,5 s) nella sezione critica (design §9). */
  'freshness_timeout',
  /** Rebuild in corso e sync forzata non riuscita entro il budget (design §6.7). */
  'rebuild_in_progress',
  /** Orizzonte dell'indice più corto della garanzia statica (design §6.9). */
  'horizon_insufficient',
  /** Remote mode: PROPFIND delle decisioni oltre il budget (design §6.1). */
  'remote_budget_exceeded',
  /** Watcher fermo o canary fallito senza remote mode utilizzabile. */
  'watcher_down',
] as const;
export type CalendarUnavailableReason = (typeof CALENDAR_UNAVAILABLE_REASONS)[number];

/**
 * Calendario non verificabile o non scrivibile adesso. `status` è sempre 503;
 * `reason` e `detail` servono a log, salute e test.
 */
export class CalendarUnavailableError extends Error {
  readonly code = 'CALENDAR_UNAVAILABLE' as const;
  readonly status = 503 as const;
  readonly reason: CalendarUnavailableReason;
  readonly detail: string | null;

  constructor(reason: CalendarUnavailableReason, detail?: string | null, options?: { cause?: unknown }) {
    super(detail ? `${CALENDAR_UNAVAILABLE_MESSAGE} (${reason}: ${detail})` : `${CALENDAR_UNAVAILABLE_MESSAGE} (${reason})`, options);
    this.name = 'CalendarUnavailableError';
    this.reason = reason;
    this.detail = detail ?? null;
  }

  /** Corpo della risposta del sito pubblico (design §9): testo generico, mai il motivo. */
  toPublicBody(): { error: string; code: 'CALENDAR_UNAVAILABLE' } {
    return { error: CALENDAR_UNAVAILABLE_MESSAGE, code: 'CALENDAR_UNAVAILABLE' };
  }
}

/** Lo store scelto dal modo non può servire l'operazione (non implementato o non configurato). */
export class CalendarStoreUnavailableError extends CalendarUnavailableError {
  readonly store: string;
  readonly operation: string;

  constructor(store: string, operation: string, detail?: string) {
    super('store_not_available', detail ?? `store '${store}' non disponibile per ${operation}`);
    this.name = 'CalendarStoreUnavailableError';
    this.store = store;
    this.operation = operation;
  }
}

// ─── Conflitti (409) ─────────────────────────────────────────

/** Il target {recurrence_key} non appartiene più all'insieme corrente dell'oggetto (design §8). */
export class CalendarRecurrenceConflictError extends CalendarConflictError {
  readonly recurrenceKey: string;

  constructor(recurrenceKey: string, message = "L'occorrenza non esiste più nella serie: ricarica l'evento e riprova") {
    super(message);
    this.name = 'CalendarRecurrenceConflictError';
    this.recurrenceKey = recurrenceKey;
  }
}

/** Un campo il cui valore di base non coincide più con quello corrente. */
export interface FieldConflict {
  field: string;
  base: unknown;
  theirs: unknown;
  yours: unknown;
}

/** CAS per campo fallito (design §8 passo 4): 409 con l'elenco dei campi in conflitto. */
export class CalendarFieldConflictError extends CalendarConflictError {
  readonly conflicts: readonly FieldConflict[];

  constructor(conflicts: FieldConflict[], message = "L'evento è stato modificato nel frattempo: verifica le modifiche e riprova") {
    super(message);
    this.name = 'CalendarFieldConflictError';
    this.conflicts = Object.freeze([...conflicts]);
  }
}

/** true se `err` è un'indisponibilità del calendario (503). */
export function isCalendarUnavailable(err: unknown): err is CalendarUnavailableError {
  return err instanceof CalendarUnavailableError;
}
