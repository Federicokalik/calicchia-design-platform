/**
 * Difesa CSRF delle route admin che scrivono (F3 contratto §10.1, estratta da
 * routes/calendar/migration.ts nella F4R3-06 per usarla anche da
 * routes/calendar/admin.ts, che ha la route distruttiva POST /events/:id/split).
 *
 * Il cookie auth_token è SameSite=Lax, che non ferma le richieste da un
 * sottodominio dello stesso sito. Per POST, PATCH, PUT e DELETE: Fetch Metadata
 * (Sec-Fetch-Site same-origin o none, cioè l'admin o uno strumento), altrimenti
 * un'Origin presente deve essere fra quelle ammesse (CORS_ORIGINS più l'origine
 * della richiesta); un corpo deve essere application/json (multipart/form-data
 * solo per i percorsi indicati in `multipartPaths`). Una richiesta "semplice" di
 * un'altra pagina (text/plain, form) non arriva mai agli handler.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';

/** Origini ammesse per le richieste che scrivono: CORS_ORIGINS (le stesse di app.ts) più l'origine della richiesta. */
export function allowedWriteOrigins(c: Context): Set<string> {
  const out = new Set((process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean));
  try {
    out.add(new URL(c.req.url).origin);
  } catch {
    // URL della richiesta non analizzabile: restano CORS_ORIGINS.
  }
  const host = c.req.header('X-Forwarded-Host')?.split(',')[0]?.trim() || c.req.header('Host')?.trim();
  if (host) {
    const proto = c.req.header('X-Forwarded-Proto')?.split(',')[0]?.trim() || new URL(c.req.url).protocol.replace(/:$/, '');
    out.add(`${proto}://${host}`);
  }
  return out;
}

export function sameOriginWrites(opts: { multipartPaths?: (path: string) => boolean; log: Logger }): MiddlewareHandler {
  const { log } = opts;
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const site = c.req.header('Sec-Fetch-Site')?.trim().toLowerCase();
    if (site && site !== 'same-origin' && site !== 'none') {
      log.warn({ method, url: c.req.path, site }, 'richiesta da un\'altra origine rifiutata');
      return c.json({ error: 'Richiesta da un\'altra origine rifiutata', code: 'CSRF_REJECTED' }, 403);
    }
    const origin = c.req.header('Origin')?.trim().replace(/\/+$/, '');
    if (origin !== undefined && origin !== '' && (origin === 'null' || !allowedWriteOrigins(c).has(origin))) {
      log.warn({ method, url: c.req.path }, 'Origin non ammessa, richiesta rifiutata');
      return c.json({ error: 'Origine della richiesta non ammessa', code: 'CSRF_REJECTED' }, 403);
    }
    // Il corpo si riconosce dalle intestazioni, non dallo stream: @hono/node-server crea sempre un body stream
    // per ogni metodo diverso da GET/HEAD, quindi una DELETE senza payload avrebbe `body !== null`.
    const length = c.req.header('Content-Length');
    const hasBody = length !== undefined ? Number(length) > 0 : c.req.header('Transfer-Encoding') !== undefined;
    if (hasBody) {
      const type = (c.req.header('Content-Type') ?? '').toLowerCase();
      const multipart = opts.multipartPaths?.(c.req.path) === true;
      const ok = multipart ? type.startsWith('multipart/form-data') : /^application\/json\s*(;|$)/.test(type);
      if (!ok) {
        return c.json({ error: multipart ? 'Corpo atteso: multipart/form-data' : 'Corpo atteso: application/json', code: 'VALIDATION_FAILED' }, 415);
      }
    }
    await next();
  };
}
