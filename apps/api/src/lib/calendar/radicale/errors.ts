/**
 * Errori tipizzati del client CalDAV di servizio verso Radicale (fase F1 del
 * passaggio del calendario a Radicale, piano T6; design §2, §8 e §6.2).
 *
 * Ogni risposta fuori dall'esito atteso diventa una sottoclasse di
 * RadicaleError con `code` stabile, così i chiamanti (dalla F2: RadicaleStore,
 * indicizzatore, job) decidono senza leggere gli status HTTP:
 *
 * | code                 | Quando                                                        |
 * |----------------------|---------------------------------------------------------------|
 * | precondition_failed  | 412: If-Match diverso, If-None-Match: * su risorsa esistente,  |
 * |                      | MOVE senza Overwrite su una destinazione esistente             |
 * | uid_conflict         | 409 con CALDAV:no-uid-conflict (UID già presente nella         |
 * |                      | collezione su un altro href)                                   |
 * | conflict             | altri 409: collezione già esistente (DAV:resource-must-be-null)|
 * |                      | o genitore mancante                                            |
 * | invalid_sync_token   | 403 con DAV:valid-sync-token: serve una sync completa          |
 * | forbidden            | altri 403: permessi di caldes_rights, collezione non           |
 * |                      | cancellabile, report non supportato                            |
 * | not_found            | 404                                                            |
 * | unauthorized         | 401: password di caldes-svc errata o peer fuori da             |
 * |                      | CALDES_SVC_CIDR (errore di configurazione, mai transitorio)    |
 * | bad_request          | altri 4xx (400 iCalendar rifiutato, 405, 413, 415...)          |
 * | server_error         | 5xx                                                            |
 * | timeout              | nessuna risposta completa entro il timeout                     |
 * | network              | connessione rifiutata, reset, DNS                               |
 * | protocol             | risposta inattesa: XML illeggibile, redirect, corpo oltre il   |
 * |                      | limite, status 2xx diverso da quello atteso                    |
 * | proppatch_failed     | PROPPATCH con 207 ma almeno una proprietà non applicata        |
 * | configuration        | client configurato male (URL, credenziali mancanti)            |
 *
 * `outcomeUnknown` vale true quando una richiesta che modifica lo stato
 * (PUT, DELETE, MOVE, MKCOL, MKCALENDAR, PROPPATCH) è fallita dopo essere
 * potuta arrivare al server (timeout, connessione caduta, 5xx): l'esito è
 * ignoto e il chiamante deve rileggere lo stato (ETag, PROPFIND) prima di
 * decidere. Il client non ripete mai da solo queste richieste.
 *
 * I messaggi non contengono mai credenziali né corpi iCalendar.
 */

/** Codici stabili degli errori del client. */
export const RADICALE_ERROR_CODES = [
  'precondition_failed',
  'uid_conflict',
  'conflict',
  'invalid_sync_token',
  'forbidden',
  'not_found',
  'unauthorized',
  'bad_request',
  'server_error',
  'timeout',
  'network',
  'protocol',
  'proppatch_failed',
  'configuration',
] as const;
export type RadicaleErrorCode = (typeof RADICALE_ERROR_CODES)[number];

/** Precondizione o postcondizione WebDAV/CalDAV letta da un corpo `<D:error>`. */
export interface DavCondition {
  /** Namespace (es. 'DAV:' o 'urn:ietf:params:xml:ns:caldav'). */
  ns: string;
  /** Nome locale (es. 'no-uid-conflict', 'valid-sync-token'). */
  name: string;
}

/** Contesto della richiesta fallita. */
export interface RadicaleErrorContext {
  method: string;
  /** Percorso richiesto (già codificato, senza host). */
  path: string;
  /** Status HTTP, null se non è arrivata una risposta. */
  status?: number | null;
  condition?: DavCondition | null;
  /** Tentativi fatti (1 = nessuna ripetizione). */
  attempts?: number;
  outcomeUnknown?: boolean;
  cause?: unknown;
}

/** Base di tutti gli errori del client CalDAV di servizio. */
export class RadicaleError extends Error {
  readonly code: RadicaleErrorCode;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly condition: DavCondition | null;
  readonly attempts: number;
  /** true: una richiesta di scrittura può essere stata applicata (vedi testa del file). */
  readonly outcomeUnknown: boolean;

  constructor(code: RadicaleErrorCode, message: string, ctx: RadicaleErrorContext) {
    super(message, ctx.cause === undefined ? undefined : { cause: ctx.cause });
    this.name = 'RadicaleError';
    this.code = code;
    this.method = ctx.method;
    this.path = ctx.path;
    this.status = ctx.status ?? null;
    this.condition = ctx.condition ?? null;
    this.attempts = ctx.attempts ?? 1;
    this.outcomeUnknown = ctx.outcomeUnknown ?? false;
  }

  /**
   * L'errore è transitorio (rete, timeout, 502-504): ha senso riprovare più
   * tardi la stessa operazione. Non dice se il client l'ha già ripetuta.
   */
  get transient(): boolean {
    return this.code === 'timeout' || this.code === 'network' || (this.code === 'server_error' && this.status !== null && this.status >= 502 && this.status <= 504);
  }

  /** Oggetto sicuro per i log strutturati (niente credenziali né corpi). */
  toLog(): Record<string, unknown> {
    return {
      code: this.code,
      method: this.method,
      path: this.path,
      status: this.status,
      condition: this.condition ? `{${this.condition.ns}}${this.condition.name}` : null,
      attempts: this.attempts,
      outcomeUnknown: this.outcomeUnknown,
      message: this.message,
    };
  }
}

/** 412: l'ETag non corrisponde più o la risorsa esiste già (If-None-Match: *). */
export class RadicalePreconditionFailedError extends RadicaleError {
  constructor(ctx: RadicaleErrorContext) {
    super('precondition_failed', `${ctx.method} ${ctx.path}: precondizione fallita (412)`, ctx);
    this.name = 'RadicalePreconditionFailedError';
  }
}

/** 409 CALDAV:no-uid-conflict: l'UID esiste già nella collezione con un altro href. */
export class RadicaleUidConflictError extends RadicaleError {
  constructor(ctx: RadicaleErrorContext) {
    super('uid_conflict', `${ctx.method} ${ctx.path}: UID già presente nella collezione (409 no-uid-conflict)`, ctx);
    this.name = 'RadicaleUidConflictError';
  }
}

/** Altri 409: collezione già esistente, genitore assente. */
export class RadicaleConflictError extends RadicaleError {
  constructor(ctx: RadicaleErrorContext) {
    const detail = ctx.condition ? ` (${ctx.condition.name})` : '';
    super('conflict', `${ctx.method} ${ctx.path}: conflitto (409)${detail}`, ctx);
    this.name = 'RadicaleConflictError';
  }
}

/** 403 generico: permessi negati da caldes_rights o operazione non ammessa. */
export class RadicaleForbiddenError extends RadicaleError {
  constructor(ctx: RadicaleErrorContext, code: 'forbidden' | 'invalid_sync_token' = 'forbidden') {
    const detail = ctx.condition ? ` (${ctx.condition.name})` : '';
    super(code, `${ctx.method} ${ctx.path}: accesso negato (403)${detail}`, ctx);
    this.name = 'RadicaleForbiddenError';
  }
}

/** 403 DAV:valid-sync-token: il token è scaduto o sconosciuto, serve una sync completa. */
export class RadicaleInvalidSyncTokenError extends RadicaleForbiddenError {
  constructor(ctx: RadicaleErrorContext) {
    super(ctx, 'invalid_sync_token');
    this.name = 'RadicaleInvalidSyncTokenError';
  }
}

/** 404. */
export class RadicaleNotFoundError extends RadicaleError {
  constructor(ctx: RadicaleErrorContext) {
    super('not_found', `${ctx.method} ${ctx.path}: risorsa inesistente (404)`, ctx);
    this.name = 'RadicaleNotFoundError';
  }
}

/** 401: credenziali di servizio rifiutate (password o peer di rete). */
export class RadicaleUnauthorizedError extends RadicaleError {
  constructor(ctx: RadicaleErrorContext) {
    super('unauthorized', `${ctx.method} ${ctx.path}: credenziali di servizio rifiutate (401): verificare RADICALE_SVC_PASSWORD e CALDES_SVC_CIDR`, ctx);
    this.name = 'RadicaleUnauthorizedError';
  }
}

/** Altri 4xx (400 iCalendar non valido o oltre max_vevent_rrule_occurrence, 405, 413, 415...). */
export class RadicaleBadRequestError extends RadicaleError {
  constructor(ctx: RadicaleErrorContext) {
    super('bad_request', `${ctx.method} ${ctx.path}: richiesta rifiutata (${ctx.status ?? '?'})`, ctx);
    this.name = 'RadicaleBadRequestError';
  }
}

/** 5xx. */
export class RadicaleServerError extends RadicaleError {
  constructor(ctx: RadicaleErrorContext) {
    super('server_error', `${ctx.method} ${ctx.path}: errore del server (${ctx.status ?? '?'})`, ctx);
    this.name = 'RadicaleServerError';
  }
}

/** Nessuna risposta completa entro il timeout. */
export class RadicaleTimeoutError extends RadicaleError {
  readonly timeoutMs: number;
  constructor(ctx: RadicaleErrorContext & { timeoutMs: number }) {
    super('timeout', `${ctx.method} ${ctx.path}: nessuna risposta entro ${ctx.timeoutMs} ms`, ctx);
    this.name = 'RadicaleTimeoutError';
    this.timeoutMs = ctx.timeoutMs;
  }
}

/** Errore di rete (connessione rifiutata, reset, DNS). */
export class RadicaleNetworkError extends RadicaleError {
  /** Codice di sistema (ECONNREFUSED, ECONNRESET, ENOTFOUND...), se noto. */
  readonly errno: string | null;
  constructor(ctx: RadicaleErrorContext & { errno?: string | null; detail?: string }) {
    super('network', `${ctx.method} ${ctx.path}: errore di rete (${ctx.errno ?? ctx.detail ?? 'sconosciuto'})`, ctx);
    this.name = 'RadicaleNetworkError';
    this.errno = ctx.errno ?? null;
  }
}

/** Risposta fuori protocollo (XML illeggibile, redirect, corpo troppo grande, status inatteso). */
export class RadicaleProtocolError extends RadicaleError {
  constructor(ctx: RadicaleErrorContext & { detail: string }) {
    super('protocol', `${ctx.method} ${ctx.path}: risposta inattesa: ${ctx.detail}`, ctx);
    this.name = 'RadicaleProtocolError';
  }
}

/** Una proprietà della PROPPATCH non è stata applicata. */
export interface FailedProperty {
  /** Notazione di Clark: `{ns}nome`. */
  property: string;
  status: number | null;
}

/** PROPPATCH con 207 in cui almeno una proprietà ha uno status diverso da 200. */
export class RadicalePropPatchError extends RadicaleError {
  readonly failed: readonly FailedProperty[];
  constructor(ctx: RadicaleErrorContext & { failed: FailedProperty[] }) {
    const list = ctx.failed.map((f) => `${f.property}=${f.status ?? '?'}`).join(', ');
    super('proppatch_failed', `${ctx.method} ${ctx.path}: proprietà non applicate: ${list}`, ctx);
    this.name = 'RadicalePropPatchError';
    this.failed = Object.freeze([...ctx.failed]);
  }
}

/** Configurazione del client non valida (URL, credenziali, opzioni). */
export class RadicaleConfigError extends RadicaleError {
  constructor(message: string) {
    super('configuration', message, { method: '-', path: '-' });
    this.name = 'RadicaleConfigError';
  }
}

/** true se `err` è un errore del client (eventualmente con un codice dato). */
export function isRadicaleError(err: unknown, code?: RadicaleErrorCode): err is RadicaleError {
  return err instanceof RadicaleError && (code === undefined || err.code === code);
}
