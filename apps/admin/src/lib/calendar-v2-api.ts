/**
 * Client tipizzato dell'API admin del calendario v2 (`/api/admin/calendar/v2`,
 * tranche B della F6; contratto docs/calendar-radicale/contracts/f6-modules.md
 * §3 e §6.2). I DTO stanno in `@calicchia/shared` (packages/shared/src/calendar-v2.ts).
 *
 * Trasporto come `migrationFetch` di calendar-migration-api.ts (credenziali,
 * lingua, refresh su 401, redirect al login) ma con stato e corpo dell'errore
 * conservati: `apiFetch` perde il corpo del 412 (versione del server e
 * conflitti per campo) e non va usato per queste route.
 */

import { useQuery } from '@tanstack/react-query';
import type {
  CalV2Capabilities,
  CalV2CreateRequest,
  CalV2ObjectView,
  CalV2PatchRequest,
  CalV2PreconditionFailedBody,
  CalV2RawPutRequest,
  CalV2RestoreRequest,
  CalV2Scope,
  CalV2TrashList,
  CalV2TrashRestoreRequest,
  CalV2VersionDetail,
  CalV2VersionList,
  CalV2WriteResult,
} from '@calicchia/shared';
import { API_BASE, refreshAdminSession, sessionState } from './api';
import { getStoredAdminLocale, toIntlLocale } from './i18n-storage';

export const CAL_V2_BASE = '/api/admin/calendar/v2';

/** Timeout di ogni richiesta v2 (§9.2.1): oltre, `CalV2ApiError` con stato 0 e codice `TIMEOUT`. */
export const CAL_V2_FETCH_TIMEOUT_MS = 5_000;

export const calV2Keys = {
  capabilities: ['admin-calendar-v2-capabilities'] as const,
  object: (id: string, target: string) => ['admin-calendar-v2-object', id, target] as const,
  /** Anteprima (dryRun) con debounce: la chiave porta il corpo serializzato della richiesta. */
  preview: (id: string, payload: string) => ['admin-calendar-v2-preview', id, payload] as const,
  /** Cronologia di un oggetto (A1). */
  versions: (id: string) => ['admin-calendar-v2-versions', id] as const,
  /** Cestino, filtrato per calendario (`null` = tutti) (A1). */
  trash: (calendarId: string | null) => ['admin-calendar-v2-trash', calendarId] as const,
};

// ─── Errori ───────────────────────────────

/** Errore dell'API v2 (`{ error, code, details? }`) con stato HTTP, codice e dettagli. */
export class CalV2ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'CalV2ApiError';
  }
}

/** 412: porta la versione del server (`current`) e i conflitti per campo. */
export class CalV2ConflictError extends CalV2ApiError {
  constructor(message: string, details: Record<string, unknown> | null, readonly body: CalV2PreconditionFailedBody) {
    super(message, 412, 'PRECONDITION_FAILED', details);
    this.name = 'CalV2ConflictError';
  }
}

/** Messaggio leggibile di un errore qualsiasi. */
export function calV2ErrorMessage(err: unknown): string {
  if (err instanceof CalV2ApiError) return err.message;
  if (err instanceof TypeError) return 'Errore di rete: riprova tra un momento';
  return err instanceof Error ? err.message : 'Errore inatteso';
}

// ─── Trasporto ───────────────────────────────

function isAuthRedirectExempt(): boolean {
  const path = window.location.pathname;
  return path === '/login' || path === '/setup' || path.startsWith('/firma/');
}

function isPreconditionBody(body: unknown): body is CalV2PreconditionFailedBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as { code?: unknown; current?: unknown; conflicts?: unknown };
  return b.code === 'PRECONDITION_FAILED' && !!b.current && typeof b.current === 'object' && Array.isArray(b.conflicts);
}

/**
 * `fetch` con timeout (`CAL_V2_FETCH_TIMEOUT_MS`): un `AbortController` interno
 * si unisce a `init.signal`. Se scatta il timeout lancia `CalV2ApiError`
 * (stato 0, codice `TIMEOUT`); un abort del chiamante resta l'`AbortError`
 * originale. Il timer copre l'attesa delle intestazioni della risposta.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const outer = init.signal;
  let timedOut = false;
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CAL_V2_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new CalV2ApiError('Il server del calendario non risponde', 0, 'TIMEOUT', null);
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

async function v2Fetch(path: string, init: RequestInit = {}, retryAuth = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  const locale = getStoredAdminLocale();
  headers.set('Accept-Language', toIntlLocale(locale));
  headers.set('X-Admin-Locale', locale);
  const res = await fetchWithTimeout(`${API_BASE}${CAL_V2_BASE}${path}`, { ...init, headers, credentials: 'include' });
  if (res.ok) {
    sessionState.lastActivity = Date.now();
    return res;
  }
  if (res.status === 401 && retryAuth && !isAuthRedirectExempt()) {
    if (await refreshAdminSession()) return v2Fetch(path, init, false);
  }
  if (res.status === 401 && !isAuthRedirectExempt()) {
    const back = window.location.pathname + window.location.search;
    window.location.assign(`/login?next=${encodeURIComponent(back)}`);
  }
  let body: { error?: unknown; code?: unknown; details?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    /* corpo non JSON (es. 413 o 502 del proxy) */
  }
  const message = typeof body.error === 'string' && body.error
    ? body.error
    : res.status === 413 ? 'Richiesta troppo grande' : `Errore HTTP ${res.status}`;
  const details = body.details && typeof body.details === 'object' && !Array.isArray(body.details)
    ? (body.details as Record<string, unknown>)
    : null;
  if (res.status === 412 && isPreconditionBody(body)) throw new CalV2ConflictError(message, details, body);
  throw new CalV2ApiError(message, res.status, typeof body.code === 'string' ? body.code : null, details);
}

async function getJson<T>(path: string): Promise<T> {
  return (await v2Fetch(path)).json() as Promise<T>;
}

async function sendJson<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  return (await v2Fetch(path, { method, body: JSON.stringify(body ?? {}), headers })).json() as Promise<T>;
}

// ─── Capacità ───────────────────────────────

/**
 * Capacità dell'API v2 (§2). `caps` è `null` finché non sono lette e se non sono
 * leggibili (errore di rete, 404 di un'API più vecchia, 5xx): l'admin si
 * comporta come con `objects.read = false` e usa l'editor v1, così un deploy
 * disallineato non rompe nulla. In mode postgres la risposta è 200 con
 * `read: false` (nessun'altra chiamata v2).
 */
export function useCalendarV2Capabilities(): { caps: CalV2Capabilities | null; isLoading: boolean } {
  const { data, isLoading, isError } = useQuery({
    queryKey: calV2Keys.capabilities,
    queryFn: () => getJson<CalV2Capabilities>('/capabilities'),
    staleTime: 20_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return { caps: isError ? null : data ?? null, isLoading };
}

// ─── Oggetti ───────────────────────────────

/**
 * Vista di un oggetto (letta da Radicale). `target`: chiave di ricorrenza
 * (`''` = master) oppure, per un'occorrenza della lista v1, l'istante
 * `original_start`; senza nessuno dei due il target è il master (o l'override
 * se `id` è quello di un override). I due parametri sono alternativi.
 */
export function getObjectV2(id: string, target: { recurrenceKey?: string; originalStart?: string } = {}): Promise<CalV2ObjectView> {
  const q = new URLSearchParams();
  if (target.recurrenceKey !== undefined) q.set('recurrence_key', target.recurrenceKey);
  else if (target.originalStart) q.set('original_start', target.originalStart);
  const qs = q.toString();
  return getJson<CalV2ObjectView>(`/objects/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`);
}

/** Modifica con `If-Match` (ETag esatto della versione vista). Con `req.dryRun` non scrive. */
export function patchObjectV2(id: string, etag: string, req: CalV2PatchRequest): Promise<CalV2WriteResult> {
  return sendJson<CalV2WriteResult>('PATCH', `/objects/${encodeURIComponent(id)}`, req, { 'If-Match': etag });
}

/** Creazione (201); con `req.dryRun` solo validazione e anteprima. */
export function createObjectV2(req: CalV2CreateRequest): Promise<CalV2WriteResult> {
  return sendJson<CalV2WriteResult>('POST', '/objects', req);
}

/** Eliminazione con scope; `dryRun` valuta senza scrivere. */
export async function deleteObjectV2(
  id: string,
  etag: string,
  q: { scope: CalV2Scope; recurrenceKey: string; dryRun?: boolean },
): Promise<CalV2WriteResult> {
  const params = new URLSearchParams({ scope: q.scope, recurrence_key: q.recurrenceKey });
  if (q.dryRun) params.set('dry_run', '1');
  return (await v2Fetch(`/objects/${encodeURIComponent(id)}?${params.toString()}`, {
    method: 'DELETE',
    headers: { 'If-Match': etag },
  })).json() as Promise<CalV2WriteResult>;
}

/** URL dell'ICS grezzo dell'oggetto (`text/calendar`, stessa autenticazione dei cookie). */
export function objectIcsUrl(id: string): string {
  return `${API_BASE}${CAL_V2_BASE}/objects/${encodeURIComponent(id)}/ics`;
}

/** Salva il testo ICS completo dell'oggetto (`If-Match` esatto): nessuna fusione per campi, 412 con la versione corrente. Con `req.dryRun` solo validazione. */
export function putObjectIcsV2(id: string, etag: string, req: CalV2RawPutRequest): Promise<CalV2WriteResult> {
  return sendJson<CalV2WriteResult>('PUT', `/objects/${encodeURIComponent(id)}/ics`, req, { 'If-Match': etag });
}

/** URL dell'export `.ics` dell'oggetto (`Content-Disposition: attachment`). */
export function objectExportUrl(id: string): string {
  return `${API_BASE}${CAL_V2_BASE}/objects/${encodeURIComponent(id)}/export.ics`;
}

// ─── Cronologia e cestino ───────────────────────────────

/** Versioni dell'oggetto (dalla più recente, conservazione di `retention_days`). */
export function listVersionsV2(id: string): Promise<CalV2VersionList> {
  return getJson<CalV2VersionList>(`/objects/${encodeURIComponent(id)}/versions`);
}

/** Una versione con il suo testo ICS e la vista calcolata. */
export function getVersionV2(id: string, versionId: string): Promise<CalV2VersionDetail> {
  return getJson<CalV2VersionDetail>(`/objects/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`);
}

/** Ripristina una versione sull'oggetto vivo (`If-Match` esatto). Con `req.dryRun` solo valutazione. */
export function restoreVersionV2(id: string, etag: string, req: CalV2RestoreRequest): Promise<CalV2WriteResult> {
  return sendJson<CalV2WriteResult>('POST', `/objects/${encodeURIComponent(id)}/restore`, req, { 'If-Match': etag });
}

/** Oggetti eliminati ripristinabili, dal più recente; `before` è il cursore `next` della pagina precedente. */
export function listTrashV2(q: { calendarId?: string; before?: string; limit?: number } = {}): Promise<CalV2TrashList> {
  const params = new URLSearchParams();
  if (q.calendarId) params.set('calendar_id', q.calendarId);
  if (q.before) params.set('before', q.before);
  if (q.limit) params.set('limit', String(q.limit));
  const qs = params.toString();
  return getJson<CalV2TrashList>(`/trash${qs ? `?${qs}` : ''}`);
}

/** Ripristina un oggetto eliminato (201). Con `req.dryRun` solo valutazione. */
export function restoreTrashV2(objectId: string, req: CalV2TrashRestoreRequest): Promise<CalV2WriteResult> {
  return sendJson<CalV2WriteResult>('POST', `/trash/${encodeURIComponent(objectId)}/restore`, req);
}
