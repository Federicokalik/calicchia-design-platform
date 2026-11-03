/**
 * Richieste in-process all'app Hono (src/app.ts), identità admin e token.
 *
 * `app.request()` esegue l'intera catena di middleware di produzione (CORS,
 * header di sicurezza, rate limit, authMiddleware, onError/notFound) senza
 * aprire porte: le risposte sono quelle che vedrebbero sito, admin e MCP.
 *
 * Rate limit: i limiter di app.ts sono in memoria e indicizzati per IP letto da
 * X-Forwarded-For (TRUST_PROXY_HEADERS=true in helpers/env.ts). Ogni richiesta
 * riceve quindi un IP diverso dal blocco 198.18.0.0/15 (RFC 2544, mai
 * instradato), così i contratti non incappano nel 429; per provare il limite
 * basta passare lo stesso `ip` a più richieste.
 *
 * Identità admin: authMiddleware accetta qualsiasi JWT HS256 firmato con
 * JWT_SECRET con `sub` e `role: 'admin'` e non legge il database; alcune route
 * però salvano `user.id` in colonne con foreign key verso profiles (es.
 * caldav_app_passwords.created_by), quindi `ensureTestAdmin()` crea anche le
 * righe users/profiles come fa il primo login (routes/auth.ts) e scripts/seed.ts.
 */

import './env';
import { createHmac, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { app } from '../../src/app';
import { sql } from '../../src/db';
import { signToken } from '../../src/lib/jwt';
import { signBookingToken } from '../../src/lib/calendar/token';
import { TEST_ENV } from './env';

export { app };

// ─── Admin di test ───────────────────────────────

/** Utente admin dei test: id fisso così compare uguale negli snapshot. */
export const TEST_ADMIN = Object.freeze({
  id: '00000000-0000-4000-8000-0000000ad001',
  email: 'admin@caldes.test',
  fullName: 'Admin dei test',
});

let adminReady: Promise<void> | null = null;

/**
 * Crea (una volta per processo, idempotente fra i run) l'admin dei test in
 * users e profiles. La password è casuale e mai nota: i test si autenticano
 * firmando il JWT, non con /api/auth/login.
 */
export function ensureTestAdmin(): Promise<void> {
  adminReady ??= (async () => {
    const passwordHash = await bcrypt.hash(randomBytes(24).toString('hex'), 4);
    await sql`
      INSERT INTO users (id, email, password_hash, full_name, role)
      VALUES (${TEST_ADMIN.id}::uuid, ${TEST_ADMIN.email}, ${passwordHash}, ${TEST_ADMIN.fullName}, 'admin')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO profiles (id, email, full_name, role)
      VALUES (${TEST_ADMIN.id}::uuid, ${TEST_ADMIN.email}, ${TEST_ADMIN.fullName}, 'admin')
      ON CONFLICT (id) DO NOTHING
    `;
  })();
  return adminReady;
}

/**
 * JWT valido per authMiddleware, firmato con lo stesso signToken del login.
 * `role` diverso da 'admin' serve per i casi 403; `authAt` nel passato oltre
 * le 12 ore produce una sessione scaduta (401).
 */
export async function signTestToken(opts: { role?: string; sub?: string; email?: string; authAt?: number } = {}): Promise<string> {
  return signToken({
    sub: opts.sub ?? TEST_ADMIN.id,
    email: opts.email ?? TEST_ADMIN.email,
    role: opts.role ?? 'admin',
    auth_at: opts.authAt,
  });
}

/** JWT admin per l'utente dei test (crea users/profiles se servono). */
export async function adminToken(): Promise<string> {
  await ensureTestAdmin();
  return signTestToken();
}

// ─── Token di gestione delle prenotazioni ───────────────────────────────

/** Token HMAC di gestione (cancel/reschedule/ics) come quello delle email. */
export function bookingManageToken(uid: string, ttlSeconds?: number): string {
  return signBookingToken(uid, ttlSeconds);
}

/** Token con firma valida ma già scaduto (exp nel passato). */
export function expiredBookingManageToken(uid: string): string {
  return signBookingToken(uid, -60);
}

/**
 * Token nel formato di lib/calendar/token.ts (base64url(payload).base64url(hmac))
 * firmato con un secret arbitrario: con un secret diverso da quello dei test
 * deve essere rifiutato come un token contraffatto.
 */
export function bookingManageTokenWithSecret(uid: string, secret: string, ttlSeconds = 3600): string {
  const b64url = (buf: Buffer): string =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = b64url(Buffer.from(JSON.stringify({ uid, exp: Math.floor(Date.now() / 1000) + ttlSeconds }), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Percorso pubblico di gestione di una prenotazione con il token in query. */
export function bookingManagePath(uid: string, token: string, action: '' | 'cancel' | 'reschedule' | 'ics' = ''): string {
  const suffix = action ? `/${action}` : '';
  return `/api/calendar/bookings/${encodeURIComponent(uid)}${suffix}?token=${encodeURIComponent(token)}`;
}

// ─── Richieste ───────────────────────────────

/** Autenticazione della richiesta. */
export type TestAuth =
  | 'admin'
  | { bearer: string }
  | { basic: { username: string; password: string } }
  | { caldavService: true };

export interface TestRequestOptions {
  /** Parametri di query (undefined viene omesso). */
  query?: Record<string, string | number | boolean | undefined>;
  /** Header aggiuntivi. */
  headers?: Record<string, string>;
  /** Corpo: oggetti serializzati in JSON; stringhe, Uint8Array e FormData passano così come sono. */
  body?: unknown;
  auth?: TestAuth;
  /** IP del client (X-Forwarded-For). Default: uno nuovo per ogni richiesta. */
  ip?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- i test leggono campi arbitrari della risposta
export interface TestResponse<T = any> {
  status: number;
  headers: Headers;
  contentType: string | null;
  /** Corpo grezzo. */
  text: string;
  /** Corpo JSON se il content-type è JSON, altrimenti undefined. */
  json: T;
}

let ipCounter = 0;

/** IP sempre diverso nel blocco 198.18.0.0/15 (benchmark, non instradato). */
export function nextClientIp(): string {
  ipCounter = (ipCounter + 1) % (2 * 256 * 256);
  const third = (ipCounter >> 8) & 0xff;
  const fourth = ipCounter & 0xff;
  return `198.${18 + (ipCounter >> 16)}.${third}.${fourth}`;
}

function buildPath(path: string, query?: TestRequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

type RequestHook = () => Promise<unknown>;
const beforeRequestHooks: RequestHook[] = [];
const afterRequestHooks: RequestHook[] = [];

function removeFrom(list: RequestHook[], hook: RequestHook): () => void {
  return () => {
    const i = list.indexOf(hook);
    if (i >= 0) list.splice(i, 1);
  };
}

/**
 * Registra un'operazione da eseguire prima di ogni richiesta. La usa la
 * matrice CALENDAR_BACKEND=radicale per riallineare l'orizzonte dell'indice
 * dopo un cambio dell'orologio fermo (helpers/calendar-backend.ts).
 * Restituisce la funzione che la toglie.
 */
export function onBeforeRequest(hook: RequestHook): () => void {
  beforeRequestHooks.push(hook);
  return removeFrom(beforeRequestHooks, hook);
}

/**
 * Registra un'operazione da eseguire dopo ogni richiesta, prima di restituire
 * la risposta al test. La usa la matrice CALENDAR_BACKEND=radicale
 * (helpers/calendar-backend.ts) per completare i job del calendario accodati
 * dalla richiesta (per esempio la proiezione di una prenotazione): in
 * produzione li esegue il worker in pochi millisecondi, nei test li si
 * esegue subito per avere effetti deterministici. Restituisce la funzione che
 * la toglie.
 */
export function onAfterRequest(hook: RequestHook): () => void {
  afterRequestHooks.push(hook);
  return removeFrom(afterRequestHooks, hook);
}

/** Esegue una richiesta in-process contro l'app reale. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vedi TestResponse
export async function request<T = any>(method: string, path: string, opts: TestRequestOptions = {}): Promise<TestResponse<T>> {
  for (const hook of beforeRequestHooks) await hook();
  const headers = new Headers(opts.headers);
  if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', opts.ip ?? nextClientIp());

  if (opts.auth === 'admin') {
    headers.set('authorization', `Bearer ${await adminToken()}`);
  } else if (opts.auth && 'bearer' in opts.auth) {
    headers.set('authorization', `Bearer ${opts.auth.bearer}`);
  } else if (opts.auth && 'basic' in opts.auth) {
    const { username, password } = opts.auth.basic;
    headers.set('authorization', `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  } else if (opts.auth && 'caldavService' in opts.auth) {
    headers.set('authorization', `Bearer ${TEST_ENV.CALDAV_SERVICE_TOKEN}`);
  }

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string' || opts.body instanceof Uint8Array || opts.body instanceof FormData) {
      body = opts.body as BodyInit;
    } else {
      body = JSON.stringify(opts.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
  }

  const res = await app.request(buildPath(path, opts.query), { method, headers, body });
  const text = await res.text();
  for (const hook of afterRequestHooks) await hook();
  const contentType = res.headers.get('content-type');
  let json: T = undefined as T;
  if (contentType?.includes('json') && text) {
    json = JSON.parse(text) as T;
  }
  return { status: res.status, headers: res.headers, contentType, text, json };
}

/** Scorciatoie per metodo. */
export const api = {
  get: <T = any>(path: string, opts?: TestRequestOptions) => request<T>('GET', path, opts), // eslint-disable-line @typescript-eslint/no-explicit-any
  post: <T = any>(path: string, opts?: TestRequestOptions) => request<T>('POST', path, opts), // eslint-disable-line @typescript-eslint/no-explicit-any
  put: <T = any>(path: string, opts?: TestRequestOptions) => request<T>('PUT', path, opts), // eslint-disable-line @typescript-eslint/no-explicit-any
  patch: <T = any>(path: string, opts?: TestRequestOptions) => request<T>('PATCH', path, opts), // eslint-disable-line @typescript-eslint/no-explicit-any
  delete: <T = any>(path: string, opts?: TestRequestOptions) => request<T>('DELETE', path, opts), // eslint-disable-line @typescript-eslint/no-explicit-any
};
