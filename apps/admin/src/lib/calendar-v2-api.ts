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
  CalV2Scope,
  CalV2WriteResult,
} from '@calicchia/shared';
import { API_BASE, refreshAdminSession, sessionState } from './api';
import { getStoredAdminLocale, toIntlLocale } from './i18n-storage';

export const CAL_V2_BASE = '/api/admin/calendar/v2';

export const calV2Keys = {
  capabilities: ['admin-calendar-v2-capabilities'] as const,
  object: (id: string, target: string) => ['admin-calendar-v2-object', id, target] as const,
  /** Anteprima (dryRun) con debounce: la chiave porta il corpo serializzato della richiesta. */
  preview: (id: string, payload: string) => ['admin-calendar-v2-preview', id, payload] as const,
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

async function v2Fetch(path: string, init: RequestInit = {}, retryAuth = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  const locale = getStoredAdminLocale();
  headers.set('Accept-Language', toIntlLocale(locale));
  headers.set('X-Admin-Locale', locale);
  const res = await fetch(`${API_BASE}${CAL_V2_BASE}${path}`, { ...init, headers, credentials: 'include' });
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

async function sendJson<T>(method: 'POST' | 'PATCH', path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
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
