import type { Context } from 'hono';

/**
 * Extract the real client IP from the request, in priority order:
 *
 *   1. `CF-Connecting-IP` — canonical, set by Cloudflare on every request and
 *      signed by their edge. Trustworthy when the site sits behind Cloudflare.
 *   2. `X-Forwarded-For` — first hop. Lower trust because it can be spoofed if
 *      no proxy strips/normalizes it; CloudPanel nginx does set it.
 *   3. `X-Real-IP` — single-value variant from nginx.
 *   4. Node socket fallback — direct connection, no proxy (local dev).
 *
 * Returns null only if everything failed (unlikely in practice).
 */
export function getClientIp(c: Context): string | null {
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf;

  const xf = c.req.header('x-forwarded-for');
  if (xf) return xf.split(',')[0]?.trim() || null;

  const xr = c.req.header('x-real-ip');
  if (xr) return xr;

  // Node IncomingMessage fallback for direct connections (local dev).
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const sock = env?.incoming?.socket?.remoteAddress;
  return sock ?? null;
}
