/**
 * Gateway API generico dell'MCP: esegue in-process qualunque route admin del
 * gestionale (stessi middleware e validazioni della UI) con l'identità
 * dell'admin reale. Usato dai tool MCP `api_catalog` e `api_request`
 * (routes/mcp.ts); la policy di accesso è in ./api-policy.ts.
 *
 * L'app Hono viene registrata da app.ts dopo i mount (setGatewayApp) per non
 * creare un import circolare app.ts ↔ routes/mcp.ts.
 */

import type { Hono } from 'hono';
import { sql } from '../../db';
import { signToken } from '../jwt';
import { logger } from '../logger';
import { DOMAIN_NOTES } from './api-catalog-notes';
import { HTTP_METHODS, INLINE_ADMIN_PREFIXES, classifyRisk, isDeniedPath, type HttpMethod, type Risk } from './api-policy';

const log = logger.child({ scope: 'mcp-api-gateway' });

/** Oltre questa soglia la risposta testuale viene troncata. */
const MAX_TEXT_CHARS = 50_000;
/** Oltre questa soglia un binario non viene inlinato (solo metadati). */
const MAX_BINARY_BYTES = 5 * 1024 * 1024;
const ACTOR_CACHE_MS = 5 * 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHono = Hono<any, any, any>;

let gatewayApp: AnyHono | null = null;
let adminPrefixes: readonly string[] = [];

export function setGatewayApp(app: AnyHono, protectedPrefixes: readonly string[]): void {
  gatewayApp = app;
  adminPrefixes = [...new Set([...protectedPrefixes, ...INLINE_ADMIN_PREFIXES])].sort();
}

export function getAdminPrefixes(): readonly string[] {
  return adminPrefixes;
}

// ─── Catalogo ─────────────────────────────────────────────────────────────────

export interface CatalogEndpoint {
  method: HttpMethod;
  path: string;
  risk: Risk;
}

export interface CatalogDomain {
  domain: string;
  prefix: string;
  notes?: string;
  endpoints: CatalogEndpoint[];
}

let catalogCache: CatalogDomain[] | null = null;

function prefixFor(path: string): string | undefined {
  // Il prefisso più specifico vince (es. /api/admin/calendar vs /api/admin/kb).
  let best: string | undefined;
  for (const p of adminPrefixes) {
    if ((path === p || path.startsWith(`${p}/`)) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

export function buildCatalog(): CatalogDomain[] {
  if (catalogCache) return catalogCache;
  if (!gatewayApp) throw new Error('Gateway API non inizializzato');

  const byPrefix = new Map<string, Map<string, CatalogEndpoint>>();
  for (const route of gatewayApp.routes) {
    const method = route.method.toUpperCase() as HttpMethod;
    if (!HTTP_METHODS.includes(method)) continue; // ALL = middleware app.use()
    const path = route.path.length > 1 ? route.path.replace(/\/+$/, '') : route.path;
    if (path.includes('*') || isDeniedPath(path)) continue;
    const prefix = prefixFor(path);
    if (!prefix) continue;
    const endpoints = byPrefix.get(prefix) ?? new Map<string, CatalogEndpoint>();
    endpoints.set(`${method} ${path}`, { method, path, risk: classifyRisk(method, path) });
    byPrefix.set(prefix, endpoints);
  }

  catalogCache = [...byPrefix.entries()]
    .map(([prefix, endpoints]) => ({
      domain: prefix.replace(/^\/api\//, ''),
      prefix,
      notes: DOMAIN_NOTES[prefix],
      endpoints: [...endpoints.values()].sort((a, b) =>
        a.path === b.path ? HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method) : a.path.localeCompare(b.path)
      ),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
  return catalogCache;
}

/** Vista del catalogo per il tool: senza filtri solo l'indice dei domini. */
export function queryCatalog(opts: { domain?: string; search?: string }): unknown {
  const catalog = buildCatalog();
  const domain = opts.domain?.trim().toLowerCase().replace(/^\/?(api\/)?/, '');
  const search = opts.search?.trim().toLowerCase();

  if (!domain && !search) {
    return {
      hint: 'Passa "domain" per gli endpoint di un dominio, o "search" per cercare nei path. Poi usa api_request.',
      domains: catalog.map((d) => ({ domain: d.domain, notes: d.notes, endpoints: d.endpoints.length })),
    };
  }

  const domains = catalog
    .filter((d) => !domain || d.domain === domain || d.domain.startsWith(`${domain}/`))
    .map((d) => ({
      ...d,
      endpoints: search
        ? d.endpoints.filter((e) => e.path.toLowerCase().includes(search) || d.domain.includes(search))
        : d.endpoints,
    }))
    .filter((d) => d.endpoints.length > 0);

  return { domains, total_endpoints: domains.reduce((n, d) => n + d.endpoints.length, 0) };
}

// ─── Identità ─────────────────────────────────────────────────────────────────

let actorCache: { id: string; email: string; at: number } | null = null;

async function actingAdmin(): Promise<{ id: string; email: string }> {
  if (actorCache && Date.now() - actorCache.at < ACTOR_CACHE_MS) return actorCache;
  const preferred = process.env.MCP_ACTING_USER_EMAIL?.trim().toLowerCase();
  const rows = preferred
    ? await sql<Array<{ id: string; email: string }>>`
        SELECT id, email FROM users WHERE email = ${preferred} AND role = 'admin' LIMIT 1
      `
    : await sql<Array<{ id: string; email: string }>>`
        SELECT id, email FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1
      `;
  const row = rows[0];
  if (!row) {
    throw new Error(
      preferred ? `MCP_ACTING_USER_EMAIL=${preferred} non corrisponde a un admin` : 'Nessun utente admin trovato'
    );
  }
  actorCache = { id: row.id, email: row.email, at: Date.now() };
  return actorCache;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export type QueryValue = string | number | boolean | null | Array<string | number | boolean>;

export interface MultipartFile {
  field: string;
  filename: string;
  contentType?: string;
  base64: string;
}

export interface GatewayRequest {
  method: HttpMethod;
  pathname: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  multipart?: { fields?: Record<string, string | number | boolean>; files?: MultipartFile[] };
  mcpTokenId: string;
}

export type GatewayBody =
  | { kind: 'text'; text: string; truncated: boolean; json: boolean }
  | { kind: 'binary'; mimeType: string; base64: string; bytes: number }
  | { kind: 'binary-too-large'; mimeType: string; bytes: number }
  | { kind: 'empty' };

export interface GatewayResponse {
  status: number;
  contentType: string;
  filename?: string;
  body: GatewayBody;
}

function buildQuery(query: GatewayRequest['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function buildMultipart(multipart: NonNullable<GatewayRequest['multipart']>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(multipart.fields ?? {})) form.append(key, String(value));
  for (const file of multipart.files ?? []) {
    const bytes = Buffer.from(file.base64, 'base64');
    form.append(
      file.field,
      new Blob([bytes], { type: file.contentType || 'application/octet-stream' }),
      file.filename
    );
  }
  return form;
}

function isTextual(contentType: string): boolean {
  return (
    contentType === '' ||
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml') ||
    contentType.includes('javascript') ||
    contentType.includes('x-www-form-urlencoded')
  );
}

export async function dispatch(req: GatewayRequest): Promise<GatewayResponse> {
  if (!gatewayApp) throw new Error('Gateway API non inizializzato');
  const actor = await actingAdmin();
  const jwt = await signToken({ sub: actor.id, email: actor.email, role: 'admin' });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/json, */*;q=0.8',
    'X-MCP-Token-Id': req.mcpTokenId,
    'User-Agent': 'caldes-mcp-gateway',
  };

  let body: BodyInit | undefined;
  if (req.method !== 'GET') {
    if (req.multipart) {
      body = buildMultipart(req.multipart); // fetch imposta il boundary
    } else if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
  }

  const url = `${req.pathname}${buildQuery(req.query)}`;
  const res = await gatewayApp.request(url, { method: req.method, headers, body });

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const disposition = res.headers.get('content-disposition') || '';
  const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];

  if (res.status === 204 || res.status === 304) {
    return { status: res.status, contentType, filename, body: { kind: 'empty' } };
  }

  if (isTextual(contentType)) {
    let text = await res.text();
    let json = contentType.includes('json');
    if (json) {
      try {
        text = JSON.stringify(JSON.parse(text)); // compatta l'output di prettyJSON
      } catch {
        json = false;
      }
    }
    const truncated = text.length > MAX_TEXT_CHARS;
    return {
      status: res.status,
      contentType,
      filename,
      body: { kind: 'text', text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated, json },
    };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BINARY_BYTES) {
    return { status: res.status, contentType, filename, body: { kind: 'binary-too-large', mimeType: contentType, bytes: buffer.byteLength } };
  }
  return {
    status: res.status,
    contentType,
    filename,
    body: { kind: 'binary', mimeType: contentType || 'application/octet-stream', base64: buffer.toString('base64'), bytes: buffer.byteLength },
  };
}

/** Per i test: azzera cache di catalogo e identità. */
export function resetGatewayCaches(): void {
  catalogCache = null;
  actorCache = null;
  log.debug('gateway caches reset');
}
