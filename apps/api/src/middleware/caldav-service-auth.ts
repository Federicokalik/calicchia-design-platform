/**
 * Auth del backend CalDAV: protegge gli endpoint interni `/api/caldav-backend/*`
 * chiamati SOLO dal plugin caldes_auth di Radicale, sulla rete interna
 * caldav-int. Secret singolo condiviso (`CALDAV_SERVICE_TOKEN`) in Bearer,
 * confronto constant-time. Il vhost pubblico dell'API inoltra anche questi
 * path: il Bearer è l'unica protezione, e un 401 di questo middleware non è
 * mai una negazione delle credenziali per il plugin (contratto control-plane
 * §9.4).
 */

import { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function caldavServiceAuth(c: Context, next: Next) {
  const expected = process.env.CALDAV_SERVICE_TOKEN;
  if (!expected) {
    return c.json({ error: 'CalDAV backend non configurato (CALDAV_SERVICE_TOKEN mancante)' }, 503);
  }
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token || !safeEqual(token, expected)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
}
