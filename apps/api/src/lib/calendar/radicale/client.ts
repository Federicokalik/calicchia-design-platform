/**
 * Client CalDAV di servizio verso Radicale (fase F1 del passaggio del
 * calendario a Radicale, piano T6; design §2, §3.5, §6.2, §8).
 *
 * L'API parla con Radicale solo come `caldes-svc`, sulla rete interna
 * `caldav-int` (`RADICALE_URL=http://radicale-int:5232`): caldes_auth accetta
 * quell'utente solo dal peer TCP di CALDES_SVC_CIDR, quindi da internet la
 * credenziale non serve a nulla (design §3.3). Metodi: PROPFIND, PROPPATCH,
 * MKCOL, MKCALENDAR, PUT con If-Match/If-None-Match obbligatori, GET, DELETE
 * con If-Match, MOVE, REPORT calendar-query, calendar-multiget e
 * sync-collection. Ogni esito fuori da quello atteso diventa un errore
 * tipizzato di errors.ts (412, 409 no-uid-conflict, 403, 404, 5xx, timeout...).
 *
 * Perché node:http e non tsdav (2.4.0) o fetch:
 *  - servono le precondizioni esatte (If-Match con l'ETag verbatim,
 *    If-None-Match: *, Overwrite: F), le condizioni dei corpi `<D:error>`
 *    (no-uid-conflict, valid-sync-token) e le dead prop nel namespace
 *    urn:calicchia:caldes: tsdav è pensato per la discovery lato client, non
 *    espone errori tipizzati né timeout e retry per metodo, e porterebbe
 *    cross-fetch, xml-js e debug come dipendenze nuove;
 *  - Radicale ha `max_connections = 16` condivise con i device: un Agent con
 *    `maxSockets` (default 6) impedisce a un picco dell'API (indicizzatore,
 *    job) di occupare tutte le connessioni. Il fetch globale (undici) non ha
 *    un limite per origine configurabile senza la dipendenza `undici`;
 *  - `localAddress` permette ai test di integrazione di presentarsi dal peer
 *    della rete di servizio (127.0.0.2) senza reti Docker;
 *  - timeout per tentativo, limite sulla dimensione della risposta e decoding
 *    UTF-8 rigoroso, senza dipendenze.
 * Radicale (server wsgiref, HTTP/1.0) chiude la connessione dopo ogni
 * risposta: il keep-alive non servirebbe, l'Agent lo tiene spento.
 *
 * Retry: solo per i metodi sicuri (GET, HEAD, OPTIONS, PROPFIND, REPORT), su
 * errori di rete, timeout e 502/503/504, con backoff esponenziale e jitter. Le
 * richieste che modificano lo stato (PUT, DELETE, MOVE, MKCOL, MKCALENDAR,
 * PROPPATCH) non vengono mai ripetute dopo che la connessione è stata
 * stabilita: con un If-Match la ripetizione di una PUT riuscita
 * risponderebbe 412 e una MKCALENDAR 409, cioè un esito falso. Con un timeout
 * o un 5xx su una scrittura l'errore porta `outcomeUnknown = true` e decide il
 * chiamante rileggendo lo stato. Una scrittura si ripete solo se la
 * connessione non è mai stata stabilita (ECONNREFUSED, DNS): la richiesta non
 * è partita, quindi la ripetizione è sicura.
 *
 * Nessuna creazione implicita: il client esegue solo ciò che il chiamante
 * chiede. MKCOL e MKCALENDAR li usa soltanto l'inizializzazione esplicita
 * (identity.ts, contratto control-plane §4.4).
 */

import { Agent as HttpAgent, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import {
  DAV_PROPS,
  type DavPropName,
  type DavPropValue,
  escapeXml,
  Multistatus,
  NS,
  parseDavErrorCondition,
  propElement,
  XML_DECL,
  XmlParseError,
} from './dav-xml';
import {
  type DavCondition,
  RadicaleBadRequestError,
  RadicaleConfigError,
  RadicaleConflictError,
  type RadicaleError,
  type RadicaleErrorContext,
  RadicaleForbiddenError,
  RadicaleInvalidSyncTokenError,
  RadicaleNetworkError,
  RadicaleNotFoundError,
  RadicalePreconditionFailedError,
  RadicalePropPatchError,
  RadicaleProtocolError,
  RadicaleServerError,
  RadicaleTimeoutError,
  RadicaleUidConflictError,
  RadicaleUnauthorizedError,
} from './errors';
import { isValidPathSegment, isValidPrincipal, SERVICE_USER } from './types';

// ─── Costanti ───────────────────────────────

/** Timeout di default di un tentativo (connessione, invio e risposta completa). */
export const RADICALE_DEFAULT_TIMEOUT_MS = 10_000;
/** Ripetizioni di default dei metodi sicuri (3 tentativi in tutto). */
export const RADICALE_DEFAULT_RETRIES = 2;
/** Connessioni contemporanee massime verso Radicale (che ne ha 16 in tutto). */
export const RADICALE_DEFAULT_MAX_SOCKETS = 6;
/** Limite della risposta: oltre, errore di protocollo (5000 item con calendar-data stanno largamente sotto). */
export const RADICALE_DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Ritardo base del backoff fra due tentativi. */
export const RADICALE_DEFAULT_RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 2_000;

/** Metodi che non modificano lo stato: ripetibili su errori transitori. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT']);
/** Status ripetibili per i metodi sicuri. */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
/** Errori di sistema che indicano una connessione mai stabilita. */
const NOT_SENT_ERRNOS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';
const ICS_CONTENT_TYPE = 'text/calendar; charset=utf-8';

// ─── Percorsi ───────────────────────────────

/**
 * Nome di un oggetto (ultimo segmento dell'href) dentro una collezione: stesse
 * regole dei segmenti del contratto (1-255 byte, niente '/', '\' né
 * controlli, non inizia con '.', quindi mai '.' o '..' né i file interni di
 * Radicale).
 */
export function isValidObjectName(name: unknown): name is string {
  return isValidPathSegment(name);
}

/** `/federico/` */
export function principalPath(principal: string): string {
  if (!isValidPrincipal(principal)) throw new TypeError(`principal non valido: ${JSON.stringify(principal)}`);
  return `/${encodeURIComponent(principal)}/`;
}

/** `/federico/<collezione>/` (ammesse anche le collezioni di sistema come `_canary`). */
export function collectionPath(principal: string, collection: string): string {
  if (!isValidPathSegment(collection)) throw new TypeError(`nome di collezione non valido: ${JSON.stringify(collection)}`);
  return `${principalPath(principal)}${encodeURIComponent(collection)}/`;
}

/** `/federico/<collezione>/<oggetto>` (l'href dell'oggetto, es. `booking-abc.ics`). */
export function objectPath(principal: string, collection: string, name: string): string {
  if (!isValidObjectName(name)) throw new TypeError(`nome di oggetto non valido: ${JSON.stringify(name)}`);
  return `${collectionPath(principal, collection)}${encodeURIComponent(name)}`;
}

/**
 * Percorso accettato dal client: assoluto, già codificato (come gli href dei
 * multistatus), senza query, frammento, spazi o controlli, e senza segmenti
 * '.'/'..' (anche codificati).
 */
export function assertRequestPath(path: string): void {
  // eslint-disable-next-line no-control-regex
  if (typeof path !== 'string' || !path.startsWith('/') || /[\s?#\u0000-\u001f\u007f]/.test(path)) {
    throw new TypeError(`percorso CalDAV non valido: ${JSON.stringify(path)}`);
  }
  for (const segment of path.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new TypeError(`percorso CalDAV con codifica non valida: ${JSON.stringify(path)}`);
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/')) {
      throw new TypeError(`percorso CalDAV non valido: ${JSON.stringify(path)}`);
    }
  }
}

/** Data in formato CalDAV UTC (20270104T080000Z) per time-range ed expand. */
export function toCalDavUtc(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError(`data non valida: ${String(value)}`);
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// ─── Trasporto ───────────────────────────────

/** Richiesta al livello di trasporto. */
export interface TransportRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  maxResponseBytes: number;
}

/** Risposta completa (corpo già decodificato in UTF-8). */
export interface TransportResponse {
  status: number;
  /** Header con nomi minuscoli; i valori multipli uniti con ', '. */
  headers: Record<string, string>;
  body: string;
}

/** Errore del trasporto, convertito dal client nell'errore tipizzato. */
export class TransportError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'too_large' | 'encoding',
    message: string,
    /** La connessione è stata stabilita: la richiesta può essere arrivata al server. */
    readonly connected: boolean,
    readonly errno: string | null = null,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export type RadicaleTransport = (req: TransportRequest) => Promise<TransportResponse>;

function flattenHeaders(raw: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/**
 * Trasporto node:http(s) con Agent dedicato: timeout per tentativo (dalla
 * richiesta all'ultimo byte della risposta), limite di dimensione e UTF-8
 * rigoroso. `close()` distrugge l'Agent.
 */
export function createNodeTransport(opts: { maxSockets: number; localAddress?: string }): RadicaleTransport & { close(): void } {
  const httpAgent = new HttpAgent({ keepAlive: false, maxSockets: opts.maxSockets });
  const httpsAgent = new HttpsAgent({ keepAlive: false, maxSockets: opts.maxSockets });

  const transport = (req: TransportRequest): Promise<TransportResponse> =>
    new Promise<TransportResponse>((resolve, reject) => {
      const isHttps = req.url.protocol === 'https:';
      let connected = false;
      let settled = false;
      const finish = (err: TransportError | null, res?: TransportResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(res as TransportResponse);
      };

      const headers: Record<string, string> = { ...req.headers };
      if (req.body) headers['Content-Length'] = String(req.body.length);
      const request = (isHttps ? httpsRequest : httpRequest)(
        {
          protocol: req.url.protocol,
          hostname: req.url.hostname.replace(/^\[|\]$/g, ''),
          port: req.url.port || (isHttps ? 443 : 80),
          path: `${req.url.pathname}${req.url.search}`,
          method: req.method,
          headers,
          agent: isHttps ? httpsAgent : httpAgent,
          localAddress: opts.localAddress,
        },
        (res) => {
          connected = true;
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > req.maxResponseBytes) {
              res.destroy();
              request.destroy();
              finish(new TransportError('too_large', `risposta oltre ${req.maxResponseBytes} byte`, true));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            let body: string;
            try {
              body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            } catch {
              finish(new TransportError('encoding', 'corpo della risposta non in UTF-8', true));
              return;
            }
            finish(null, { status: res.statusCode ?? 0, headers: flattenHeaders(res.headers), body });
          });
          res.on('error', (err: NodeJS.ErrnoException) => {
            finish(new TransportError('network', err.message, true, err.code ?? null));
          });
          // Connessione chiusa prima della fine del corpo ('end' arriva sempre prima di 'close').
          res.on('close', () => {
            if (!res.complete) finish(new TransportError('network', 'risposta interrotta', true, 'ECONNRESET'));
          });
        },
      );
      request.on('socket', (socket) => {
        if (!socket.connecting) connected = true;
        else socket.once('connect', () => { connected = true; });
      });
      request.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        const notSent = !connected || (err.code !== undefined && NOT_SENT_ERRNOS.has(err.code));
        finish(new TransportError('network', err.message, !notSent, err.code ?? null));
      });
      const timer = setTimeout(() => {
        finish(new TransportError('timeout', `timeout di ${req.timeoutMs} ms`, connected));
        request.destroy();
      }, req.timeoutMs);
      request.end(req.body);
    });

  return Object.assign(transport, {
    close(): void {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  });
}

// ─── Client ───────────────────────────────

export interface RadicaleClientOptions {
  /** URL di Radicale senza percorso, es. http://radicale-int:5232 (RADICALE_URL). */
  baseUrl: string;
  /** Utente di servizio (RADICALE_SVC_USER, default caldes-svc). */
  username?: string;
  /** Password di caldes-svc (RADICALE_SVC_PASSWORD). */
  password: string;
  timeoutMs?: number;
  /** Ripetizioni dei metodi sicuri (0 = nessuna). */
  retries?: number;
  retryBaseDelayMs?: number;
  maxSockets?: number;
  maxResponseBytes?: number;
  /** User-Agent (default caldes-api). */
  userAgent?: string;
  /** Indirizzo sorgente della connessione TCP (solo test: simula il peer di caldav-int). */
  localAddress?: string;
  /** Trasporto alternativo (test). Senza, node:http con Agent dedicato. */
  transport?: RadicaleTransport;
}

/** Opzioni comuni delle singole chiamate. */
export interface CallOptions {
  /** Timeout di questo tentativo (default quello del client). */
  timeoutMs?: number;
}

/** Precondizione obbligatoria di una PUT (invariante 3 del design: mai scritture cieche). */
export type PutPrecondition =
  /** Aggiorna solo se l'ETag corrisponde (verbatim, con le virgolette). */
  | { ifMatch: string }
  /** Crea solo se la risorsa non esiste. */
  | { ifNoneMatch: '*' };

export interface PutResult {
  /** ETag della versione scritta (null se il server non lo restituisce). */
  etag: string | null;
  /** true per 201 (creata), false per 204/200 (sostituita). */
  created: boolean;
}

export interface GetResult {
  etag: string | null;
  contentType: string | null;
  body: string;
}

/** Oggetto di calendario letto con calendar-query o calendar-multiget. */
export interface CalendarObject {
  /** href restituito dal server (percorso assoluto, codificato). */
  href: string;
  /** Ultimo segmento dell'href, decodificato. */
  name: string;
  etag: string | null;
  /** calendar-data (null se non richiesto o non restituito). */
  data: string | null;
}

export interface CalendarQueryOptions extends CallOptions {
  /** Inizio e fine del time-range (UTC); senza, nessun filtro temporale. */
  start?: Date | string;
  end?: Date | string;
  /** Componente filtrato (default VEVENT). */
  component?: 'VEVENT' | 'VTODO' | 'VJOURNAL';
  /** Espansione lato server nell'intervallo dato. */
  expand?: { start: Date | string; end: Date | string };
}

export interface MultigetResult {
  objects: CalendarObject[];
  /** href richiesti e non trovati (404 nel multistatus). */
  missing: string[];
}

export interface SyncCollectionOptions extends CallOptions {
  /** Token della sync precedente; null o '' per la sync iniziale. */
  syncToken?: string | null;
  /** Chiede anche calendar-data degli oggetti cambiati. */
  withData?: boolean;
}

export interface SyncChange {
  href: string;
  name: string;
  etag: string | null;
  data: string | null;
}

export interface SyncCollectionResult {
  /** Nuovo token da salvare per la sync successiva. */
  syncToken: string;
  changed: SyncChange[];
  /**
   * href eliminati (404 nel multistatus). Nella sync iniziale Radicale
   * riporta anche le cancellazioni passate (tombstone della history).
   */
  removed: string[];
}

export interface MkcalendarOptions extends CallOptions {
  displayName?: string;
  color?: string;
  description?: string;
  /** VCALENDAR con il VTIMEZONE del calendario (calendar-timezone). */
  timezone?: string;
  /** Componenti ammessi (supported-calendar-component-set), default VEVENT. */
  components?: readonly string[];
  order?: number;
  /** Altre proprietà, comprese le dead prop {urn:calicchia:caldes}calendar-id e role. */
  props?: DavPropValue[];
}

interface RequestSpec extends CallOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
  depth?: '0' | '1' | 'infinity';
  /** Status di successo: gli altri diventano errori tipizzati. */
  expect: readonly number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const COMPONENT_RE = /^(VEVENT|VTODO|VJOURNAL)$/;

/**
 * Client CalDAV di servizio. Un'istanza per processo è sufficiente
 * (radicaleClientFromEnv): l'Agent limita le connessioni contemporanee.
 */
export class RadicaleClient {
  readonly baseUrl: string;
  readonly username: string;
  private readonly authorization: string;
  private readonly origin: URL;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly userAgent: string;
  private readonly transport: RadicaleTransport;
  private readonly ownedTransport: (RadicaleTransport & { close(): void }) | null;

  constructor(opts: RadicaleClientOptions) {
    let url: URL;
    try {
      url = new URL(opts.baseUrl);
    } catch {
      throw new RadicaleConfigError(`RADICALE_URL non valido: ${JSON.stringify(opts.baseUrl)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new RadicaleConfigError('RADICALE_URL deve essere http:// o https://');
    }
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
      throw new RadicaleConfigError('RADICALE_URL non deve avere percorso, query né credenziali (Radicale è servito alla radice)');
    }
    const username = opts.username ?? SERVICE_USER;
    // eslint-disable-next-line no-control-regex
    if (!username || username.includes(':') || /[\u0000-\u001f\u007f]/.test(username)) {
      throw new RadicaleConfigError('utente di servizio non valido');
    }
    if (!opts.password) throw new RadicaleConfigError('password dell\'utente di servizio assente (RADICALE_SVC_PASSWORD)');
    const positive = (value: number | undefined, fallback: number, name: string, min = 1): number => {
      if (value === undefined) return fallback;
      if (!Number.isInteger(value) || value < min) throw new RadicaleConfigError(`${name} non valido: ${value}`);
      return value;
    };

    this.origin = new URL(url.origin);
    this.baseUrl = url.origin;
    this.username = username;
    this.authorization = `Basic ${Buffer.from(`${username}:${opts.password}`, 'utf8').toString('base64')}`;
    this.timeoutMs = positive(opts.timeoutMs, RADICALE_DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.retries = positive(opts.retries, RADICALE_DEFAULT_RETRIES, 'retries', 0);
    this.retryBaseDelayMs = positive(opts.retryBaseDelayMs, RADICALE_DEFAULT_RETRY_BASE_DELAY_MS, 'retryBaseDelayMs', 0);
    this.maxResponseBytes = positive(opts.maxResponseBytes, RADICALE_DEFAULT_MAX_RESPONSE_BYTES, 'maxResponseBytes');
    this.userAgent = opts.userAgent ?? 'caldes-api';
    if (opts.transport) {
      this.transport = opts.transport;
      this.ownedTransport = null;
    } else {
      const maxSockets = positive(opts.maxSockets, RADICALE_DEFAULT_MAX_SOCKETS, 'maxSockets');
      this.ownedTransport = createNodeTransport({ maxSockets, localAddress: opts.localAddress });
      this.transport = this.ownedTransport;
    }
  }

  /** Chiude le connessioni del trasporto interno. Il client non va più usato dopo. */
  close(): void {
    this.ownedTransport?.close();
  }

  // ── Richiesta generica ──

  /**
   * Esegue la richiesta con timeout e retry secondo la politica in testa al
   * file. Restituisce la risposta se lo status è fra quelli attesi,
   * altrimenti lancia l'errore tipizzato.
   */
  private async request(spec: RequestSpec): Promise<TransportResponse> {
    assertRequestPath(spec.path);
    const method = spec.method.toUpperCase();
    const safe = SAFE_METHODS.has(method);
    const timeoutMs = spec.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      'User-Agent': this.userAgent,
      Accept: '*/*',
      ...(spec.headers ?? {}),
    };
    if (spec.depth !== undefined) headers.Depth = spec.depth;
    const body = spec.body !== undefined ? Buffer.from(spec.body, 'utf8') : undefined;
    if (body) headers['Content-Type'] = spec.contentType ?? XML_CONTENT_TYPE;
    const url = new URL(spec.path, this.origin);

    const maxAttempts = 1 + this.retries;
    for (let attempt = 1; ; attempt++) {
      const ctx = (extra: Partial<RadicaleErrorContext> = {}): RadicaleErrorContext => ({ method, path: spec.path, attempts: attempt, ...extra });
      let res: TransportResponse;
      try {
        res = await this.transport({ method, url, headers, body, timeoutMs, maxResponseBytes: this.maxResponseBytes });
      } catch (err) {
        const error = this.transportError(err, ctx, safe, timeoutMs);
        const retry = attempt < maxAttempts && (error.code === 'timeout' || error.code === 'network') && (safe || !error.outcomeUnknown);
        if (!retry) throw error;
        await sleep(this.backoff(attempt));
        continue;
      }

      if (spec.expect.includes(res.status)) return res;
      const error = this.statusError(res, ctx, safe);
      if (attempt < maxAttempts && safe && RETRYABLE_STATUSES.has(res.status)) {
        await sleep(this.backoff(attempt));
        continue;
      }
      throw error;
    }
  }

  private backoff(attempt: number): number {
    const base = this.retryBaseDelayMs * 2 ** (attempt - 1);
    return Math.min(RETRY_MAX_DELAY_MS, base + Math.floor(Math.random() * (this.retryBaseDelayMs + 1)));
  }

  private transportError(
    err: unknown,
    ctx: (extra?: Partial<RadicaleErrorContext>) => RadicaleErrorContext,
    safe: boolean,
    timeoutMs: number,
  ): RadicaleError {
    if (!(err instanceof TransportError)) {
      return new RadicaleNetworkError({ ...ctx({ cause: err, outcomeUnknown: !safe }), detail: (err as Error)?.message ?? String(err) });
    }
    // Una scrittura il cui esito non si conosce: connessione stabilita, poi niente risposta completa.
    const outcomeUnknown = !safe && err.connected;
    if (err.kind === 'timeout') return new RadicaleTimeoutError({ ...ctx({ cause: err, outcomeUnknown }), timeoutMs });
    if (err.kind === 'network') return new RadicaleNetworkError({ ...ctx({ cause: err, outcomeUnknown }), errno: err.errno, detail: err.message });
    return new RadicaleProtocolError({ ...ctx({ cause: err, outcomeUnknown }), detail: err.message });
  }

  private statusError(res: TransportResponse, ctx: (extra?: Partial<RadicaleErrorContext>) => RadicaleErrorContext, safe: boolean): RadicaleError {
    const status = res.status;
    const condition: DavCondition | null = status >= 400 && status < 500 ? parseDavErrorCondition(res.body) : null;
    const base = ctx({ status, condition });
    switch (status) {
      case 401:
        return new RadicaleUnauthorizedError(base);
      case 403:
        return condition?.ns === NS.DAV && condition.name === 'valid-sync-token'
          ? new RadicaleInvalidSyncTokenError(base)
          : new RadicaleForbiddenError(base);
      case 404:
        return new RadicaleNotFoundError(base);
      case 409:
        return condition?.name === 'no-uid-conflict' ? new RadicaleUidConflictError(base) : new RadicaleConflictError(base);
      case 412:
        return new RadicalePreconditionFailedError(base);
      default:
        break;
    }
    if (status >= 500) return new RadicaleServerError(ctx({ status, outcomeUnknown: !safe }));
    if (status >= 400) return new RadicaleBadRequestError(base);
    return new RadicaleProtocolError({ ...ctx({ status }), detail: `status ${status} inatteso` });
  }

  private multistatus(res: TransportResponse, method: string, path: string): Multistatus {
    try {
      return Multistatus.parse(res.body);
    } catch (err) {
      const detail = err instanceof XmlParseError ? err.message : String(err);
      throw new RadicaleProtocolError({ method, path, status: res.status, detail: `multistatus illeggibile: ${detail}`, cause: err });
    }
  }

  // ── WebDAV ──

  /** PROPFIND con le proprietà indicate (o allprop) e Depth 0/1. Lancia RadicaleNotFoundError se il percorso non esiste. */
  async propfind(path: string, opts: { props?: readonly DavPropName[] | 'allprop'; depth?: 0 | 1 } & CallOptions = {}): Promise<Multistatus> {
    const props = opts.props ?? 'allprop';
    const inner = props === 'allprop' ? '<allprop/>' : `<prop>${props.map((p) => propElement(p)).join('')}</prop>`;
    const res = await this.request({
      method: 'PROPFIND',
      path,
      depth: String(opts.depth ?? 0) as '0' | '1',
      body: `${XML_DECL}<propfind xmlns="DAV:">${inner}</propfind>`,
      expect: [207],
      timeoutMs: opts.timeoutMs,
    });
    return this.multistatus(res, 'PROPFIND', path);
  }

  /**
   * Proprietà testuali (con status 200) di una sola risorsa, come record
   * `{ns}nome` → testo; null se la risorsa non esiste (404). Le proprietà
   * richieste e assenti non compaiono nel record.
   */
  async readProps(path: string, props: readonly DavPropName[], opts: CallOptions = {}): Promise<Record<string, string> | null> {
    let ms: Multistatus;
    try {
      ms = await this.propfind(path, { props, depth: 0, timeoutMs: opts.timeoutMs });
    } catch (err) {
      if ((err as RadicaleError).code === 'not_found') return null;
      throw err;
    }
    const entry = ms.find(path) ?? ms.responses[0];
    if (!entry) throw new RadicaleProtocolError({ method: 'PROPFIND', path, status: 207, detail: 'multistatus senza response' });
    if (entry.status === 404) return null;
    return entry.textProps();
  }

  /** Utente autenticato secondo Radicale (DAV:current-user-principal della root): prova di connettività e credenziali. */
  async currentUserPrincipal(opts: CallOptions = {}): Promise<string | null> {
    const ms = await this.propfind('/', { props: [DAV_PROPS.currentUserPrincipal], depth: 0, timeoutMs: opts.timeoutMs });
    const el = ms.responses[0]?.element(DAV_PROPS.currentUserPrincipal);
    const href = el?.children.find((c) => c.ns === NS.DAV && c.name === 'href');
    return href ? href.text.trim() : null;
  }

  /**
   * PROPPATCH: imposta e rimuove proprietà (anche dead prop). Lancia
   * RadicalePropPatchError se una proprietà non viene applicata.
   */
  async proppatch(path: string, opts: { set?: readonly DavPropValue[]; remove?: readonly DavPropName[] } & CallOptions): Promise<void> {
    const set = opts.set?.length ? `<set><prop>${opts.set.map((p) => propElement(p, true)).join('')}</prop></set>` : '';
    const remove = opts.remove?.length ? `<remove><prop>${opts.remove.map((p) => propElement(p)).join('')}</prop></remove>` : '';
    if (!set && !remove) throw new TypeError('PROPPATCH senza proprietà');
    await this.proppatchRaw(path, `${XML_DECL}<propertyupdate xmlns="DAV:">${set}${remove}</propertyupdate>`, opts);
  }

  /** PROPPATCH con un corpo già costruito (es. volumeMarkerProppatchBody() di types.ts). */
  async proppatchRaw(path: string, body: string, opts: CallOptions = {}): Promise<void> {
    const res = await this.request({ method: 'PROPPATCH', path, body, expect: [207], timeoutMs: opts.timeoutMs });
    const ms = this.multistatus(res, 'PROPPATCH', path);
    if (ms.responses.length === 0) {
      throw new RadicaleProtocolError({ method: 'PROPPATCH', path, status: 207, detail: 'multistatus senza response' });
    }
    const failed = ms.responses.flatMap((r) =>
      r.propstats.filter((ps) => ps.status !== 200).flatMap((ps) => ps.props.map((p) => ({ property: `{${p.ns}}${p.name}`, status: ps.status }))),
    );
    if (failed.length) throw new RadicalePropPatchError({ method: 'PROPPATCH', path, status: 207, failed });
  }

  /** MKCOL (anche esteso, RFC 5689, con le proprietà della collezione). Il genitore deve esistere. */
  async mkcol(path: string, opts: { props?: readonly DavPropValue[] } & CallOptions = {}): Promise<void> {
    const body = opts.props?.length
      ? `${XML_DECL}<D:mkcol xmlns:D="DAV:"><D:set><D:prop><D:resourcetype><D:collection/></D:resourcetype>${opts.props.map((p) => propElement(p, true)).join('')}</D:prop></D:set></D:mkcol>`
      : undefined;
    await this.request({ method: 'MKCOL', path, body, expect: [201], timeoutMs: opts.timeoutMs });
  }

  /**
   * MKCALENDAR con nome, colore, descrizione, fuso, componenti, ordine e
   * proprietà aggiuntive. Collezione esistente → RadicaleConflictError
   * (DAV:resource-must-be-null).
   */
  async mkcalendar(path: string, opts: MkcalendarOptions = {}): Promise<void> {
    const props: DavPropValue[] = [];
    if (opts.displayName !== undefined) props.push({ ...DAV_PROPS.displayname, value: opts.displayName });
    if (opts.color !== undefined) props.push({ ...DAV_PROPS.calendarColor, value: opts.color });
    if (opts.description !== undefined) props.push({ ...DAV_PROPS.calendarDescription, value: opts.description });
    if (opts.timezone !== undefined) props.push({ ...DAV_PROPS.calendarTimezone, value: opts.timezone });
    if (opts.order !== undefined) props.push({ ...DAV_PROPS.calendarOrder, value: String(opts.order) });
    const components = opts.components ?? ['VEVENT'];
    if (!components.length || components.some((c) => !COMPONENT_RE.test(c))) {
      throw new TypeError(`componenti non validi: ${JSON.stringify(components)}`);
    }
    props.push({
      ...DAV_PROPS.supportedComponents,
      xml: components.map((c) => `<comp xmlns="${NS.CALDAV}" name="${c}"/>`).join(''),
    });
    props.push(...(opts.props ?? []));
    const body = `${XML_DECL}<C:mkcalendar xmlns:C="${NS.CALDAV}" xmlns:D="DAV:"><D:set><D:prop>${props.map((p) => propElement(p, true)).join('')}</D:prop></D:set></C:mkcalendar>`;
    await this.request({ method: 'MKCALENDAR', path, body, expect: [201], timeoutMs: opts.timeoutMs });
  }

  // ── Oggetti ──

  /**
   * PUT di un oggetto iCalendar con precondizione obbligatoria:
   * `{ ifNoneMatch: '*' }` crea solo se assente, `{ ifMatch: etag }` aggiorna
   * solo la versione letta. 412 → RadicalePreconditionFailedError, UID già
   * presente su un altro href → RadicaleUidConflictError.
   */
  async put(path: string, ics: string, precondition: PutPrecondition, opts: CallOptions = {}): Promise<PutResult> {
    const headers: Record<string, string> = {};
    if ('ifMatch' in precondition) {
      if (!precondition.ifMatch || /[\r\n]/.test(precondition.ifMatch)) throw new TypeError('If-Match non valido');
      headers['If-Match'] = precondition.ifMatch;
    } else if (precondition.ifNoneMatch === '*') {
      headers['If-None-Match'] = '*';
    } else {
      throw new TypeError('PUT senza precondizione: serve If-Match o If-None-Match: *');
    }
    const res = await this.request({
      method: 'PUT',
      path,
      headers,
      body: ics,
      contentType: ICS_CONTENT_TYPE,
      expect: [200, 201, 204],
      timeoutMs: opts.timeoutMs,
    });
    return { etag: res.headers.etag ?? null, created: res.status === 201 };
  }

  /** GET di un oggetto. 404 → RadicaleNotFoundError. */
  async get(path: string, opts: CallOptions = {}): Promise<GetResult> {
    const res = await this.request({ method: 'GET', path, headers: { Accept: 'text/calendar' }, expect: [200], timeoutMs: opts.timeoutMs });
    return { etag: res.headers.etag ?? null, contentType: res.headers['content-type'] ?? null, body: res.body };
  }

  /**
   * DELETE di un oggetto (o di una collezione, che solo caldes-svc può
   * cancellare) con If-Match obbligatorio: l'ETag letto, oppure '*' per "deve
   * esistere". 412 se l'ETag non corrisponde, 404 se è già sparito.
   */
  async delete(path: string, precondition: { ifMatch: string }, opts: CallOptions = {}): Promise<void> {
    if (!precondition?.ifMatch || /[\r\n]/.test(precondition.ifMatch)) throw new TypeError('DELETE senza If-Match valido');
    await this.request({ method: 'DELETE', path, headers: { 'If-Match': precondition.ifMatch }, expect: [200, 204], timeoutMs: opts.timeoutMs });
  }

  /**
   * MOVE di un oggetto (Radicale non sposta collezioni). Con `overwrite`
   * false (default) una destinazione esistente → 412; UID già presente nella
   * collezione di destinazione → RadicaleUidConflictError. Radicale non
   * valuta If-Match sulla MOVE: il chiamante verifica l'ETag prima.
   */
  async move(from: string, to: string, opts: { overwrite?: boolean } & CallOptions = {}): Promise<{ created: boolean }> {
    assertRequestPath(to);
    const res = await this.request({
      method: 'MOVE',
      path: from,
      headers: { Destination: new URL(to, this.origin).toString(), Overwrite: opts.overwrite ? 'T' : 'F' },
      expect: [201, 204],
      timeoutMs: opts.timeoutMs,
    });
    return { created: res.status === 201 };
  }

  // ── REPORT ──

  private objectsOf(ms: Multistatus): CalendarObject[] {
    return ms.responses
      .filter((r) => r.status === null || r.status === 200)
      .map((r) => ({ href: r.href, name: r.name, etag: r.text(DAV_PROPS.getetag), data: r.text(DAV_PROPS.calendarData) }));
  }

  /** REPORT calendar-query (Depth 1) con time-range ed expand opzionali. */
  async calendarQuery(path: string, opts: CalendarQueryOptions = {}): Promise<CalendarObject[]> {
    const range = opts.start || opts.end
      ? `<C:time-range${opts.start ? ` start="${toCalDavUtc(opts.start)}"` : ''}${opts.end ? ` end="${toCalDavUtc(opts.end)}"` : ''}/>`
      : '';
    const expand = opts.expand ? `<C:expand start="${toCalDavUtc(opts.expand.start)}" end="${toCalDavUtc(opts.expand.end)}"/>` : '';
    const component = opts.component ?? 'VEVENT';
    if (!COMPONENT_RE.test(component)) throw new TypeError(`componente non valido: ${JSON.stringify(component)}`);
    const body = `${XML_DECL}<C:calendar-query xmlns:D="DAV:" xmlns:C="${NS.CALDAV}">`
      + `<D:prop><D:getetag/><C:calendar-data>${expand}</C:calendar-data></D:prop>`
      + `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="${component}">${range}</C:comp-filter></C:comp-filter></C:filter>`
      + '</C:calendar-query>';
    const res = await this.request({ method: 'REPORT', path, depth: '1', body, expect: [207], timeoutMs: opts.timeoutMs });
    return this.objectsOf(this.multistatus(res, 'REPORT', path));
  }

  /** REPORT calendar-multiget per href (percorsi assoluti codificati). */
  async calendarMultiget(path: string, hrefs: readonly string[], opts: CallOptions = {}): Promise<MultigetResult> {
    if (!hrefs.length) return { objects: [], missing: [] };
    for (const href of hrefs) assertRequestPath(href);
    const body = `${XML_DECL}<C:calendar-multiget xmlns:D="DAV:" xmlns:C="${NS.CALDAV}">`
      + '<D:prop><D:getetag/><C:calendar-data/></D:prop>'
      + hrefs.map((h) => `<D:href>${escapeXml(h)}</D:href>`).join('')
      + '</C:calendar-multiget>';
    const res = await this.request({ method: 'REPORT', path, depth: '1', body, expect: [207], timeoutMs: opts.timeoutMs });
    const ms = this.multistatus(res, 'REPORT', path);
    return {
      objects: this.objectsOf(ms),
      missing: ms.responses.filter((r) => r.status === 404).map((r) => r.href),
    };
  }

  /**
   * REPORT sync-collection (RFC 6578). Token scaduto o sconosciuto →
   * RadicaleInvalidSyncTokenError (serve una sync completa).
   */
  async syncCollection(path: string, opts: SyncCollectionOptions = {}): Promise<SyncCollectionResult> {
    const props = [propElement(DAV_PROPS.getetag), ...(opts.withData ? [propElement(DAV_PROPS.calendarData)] : [])].join('');
    const body = `${XML_DECL}<D:sync-collection xmlns:D="DAV:">`
      + `<D:sync-token>${escapeXml(opts.syncToken ?? '')}</D:sync-token><D:sync-level>1</D:sync-level>`
      + `<D:prop>${props}</D:prop></D:sync-collection>`;
    const res = await this.request({ method: 'REPORT', path, body, expect: [207], timeoutMs: opts.timeoutMs });
    const ms = this.multistatus(res, 'REPORT', path);
    if (!ms.syncToken) throw new RadicaleProtocolError({ method: 'REPORT', path, status: 207, detail: 'sync-collection senza sync-token' });
    const changed: SyncChange[] = [];
    const removed: string[] = [];
    for (const r of ms.responses) {
      if (r.status === 404) removed.push(r.href);
      else changed.push({ href: r.href, name: r.name, etag: r.text(DAV_PROPS.getetag), data: opts.withData ? r.text(DAV_PROPS.calendarData) : null });
    }
    return { syncToken: ms.syncToken, changed, removed };
  }
}

// ─── Configurazione da ambiente ───────────────────────────────

/** Variabili d'ambiente del client (contratto control-plane §1.3, design §3.5). */
export interface RadicaleClientEnv {
  RADICALE_URL?: string;
  RADICALE_SVC_USER?: string;
  RADICALE_SVC_PASSWORD?: string;
  RADICALE_TIMEOUT_MS?: string;
  [key: string]: string | undefined;
}

/**
 * Client dalle variabili d'ambiente: null se RADICALE_URL non è impostata
 * (Radicale non ancora installato in questo ambiente). Lancia
 * RadicaleConfigError se l'URL c'è ma il resto è incompleto o invalido.
 */
export function radicaleClientFromEnv(env: RadicaleClientEnv = process.env, extra: Partial<RadicaleClientOptions> = {}): RadicaleClient | null {
  const baseUrl = env.RADICALE_URL?.trim();
  if (!baseUrl) return null;
  const password = env.RADICALE_SVC_PASSWORD ?? '';
  if (!password) throw new RadicaleConfigError('RADICALE_URL impostata ma RADICALE_SVC_PASSWORD assente');
  const rawTimeout = env.RADICALE_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : undefined;
  if (rawTimeout && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1)) {
    throw new RadicaleConfigError(`RADICALE_TIMEOUT_MS non valido: ${JSON.stringify(rawTimeout)}`);
  }
  return new RadicaleClient({
    baseUrl,
    username: env.RADICALE_SVC_USER?.trim() || SERVICE_USER,
    password,
    timeoutMs,
    ...extra,
  });
}
