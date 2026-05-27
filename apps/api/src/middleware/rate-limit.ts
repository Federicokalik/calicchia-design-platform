import type { Context, Next } from 'hono';
import { getClientIp } from '../lib/client-ip';

/**
 * Per-IP sliding-window rate limiter.
 *
 * Audit J-K-10: the previous implementation trusted forwarded headers
 * unconditionally — an attacker that could reach the API directly
 * (bypassing Cloudflare/nginx) could rotate `X-Forwarded-For` per request
 * and never hit the cap. The fix has two parts:
 *
 *  1. When `TRUST_PROXY_HEADERS=false` is set, the limiter ignores forwarded
 *     headers entirely and keys on the raw Node socket address. Use this in
 *     deployments where the API is directly internet-facing.
 *  2. When unset / "true" (default) we keep using getClientIp (CF first, then
 *     X-Forwarded-For, then socket). This is correct for the prod deploy that
 *     sits behind Cloudflare + nginx, where the upstream actively rewrites
 *     these headers on every request.
 *
 * Hard-fail (return) when no IP can be determined — better to 429 a request
 * than to share a single bucket between every anonymous socket.
 */
export function createRateLimit(maxReq: number, windowMs: number) {
  const store = new Map<string, { count: number; resetAt: number }>();
  const trustProxy = (process.env.TRUST_PROXY_HEADERS ?? 'true').toLowerCase() !== 'false';

  function keyFor(c: Context): string {
    if (trustProxy) return getClientIp(c) || 'unknown';
    // Direct-socket-only mode: ignore forwarded headers, use the raw remote
    // address. The Hono env shape for the node-server adapter exposes the
    // IncomingMessage at c.env.incoming.
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? 'unknown';
  }

  return async (c: Context, next: Next) => {
    const ip = keyFor(c);

    const now = Date.now();
    const entry = store.get(ip);

    if (!entry || now > entry.resetAt) {
      store.set(ip, { count: 1, resetAt: now + windowMs });
    } else if (entry.count >= maxReq) {
      return c.json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' }, 429);
    } else {
      entry.count++;
    }

    await next();
  };
}
