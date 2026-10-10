/**
 * Auth del backend CalDAV: protegge gli endpoint interni `/api/caldav-backend/*`
 * chiamati SOLO dal plugin caldes_auth di Radicale, sulla rete interna
 * caldav-int. Due controlli, in quest'ordine:
 *
 * 1. Peer TCP (CALDAV_BACKEND_ALLOWED_PEERS, facoltativa): elenco di reti CIDR
 *    separate da virgola, in produzione il solo IP di Radicale su caldav-int
 *    (`172.31.250.3/32`). Il vhost pubblico dell'API inoltra anche questi path
 *    (dal gateway di app-net): con la variabile impostata, una richiesta da un
 *    altro peer riceve 404 come se la route non esistesse, anche con il Bearer
 *    giusto. Così verify-credentials non è un oracolo raggiungibile da
 *    internet, e X-Forwarded-For (IP del device per rate limit e
 *    last_used_ip) arriva solo da caldes_auth. Il peer si legge dal socket,
 *    mai da un header. Senza variabile (sviluppo, test in-process) il
 *    controllo è spento; con un valore non valido, o con il peer non
 *    leggibile, si nega (fail-closed).
 * 2. Bearer `CALDAV_SERVICE_TOKEN`, confronto constant-time. Un 401 di questo
 *    middleware non è mai una negazione delle credenziali per il plugin
 *    (contratto control-plane §9.4): è un errore di configurazione.
 */

import { Context, Next } from 'hono';
import { BlockList, isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'caldav-service-auth' });

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ─── Peer TCP ammessi ────────────────────────────────────────

/** Elenco di peer ammessi già interpretato, oppure il motivo per cui non è valido. */
type AllowedPeers = { list: BlockList } | { error: string };

let cachedRaw: string | undefined;
let cachedPeers: AllowedPeers | null = null;

/**
 * CALDAV_BACKEND_ALLOWED_PEERS → BlockList (null = controllo spento). Letta a
 * ogni richiesta e reinterpretata solo quando cambia.
 */
export function parseAllowedPeers(raw: string | undefined): AllowedPeers | null {
  const value = raw?.trim();
  if (!value) return null;
  const list = new BlockList();
  for (const piece of value.split(',')) {
    const text = piece.trim();
    const slash = text.indexOf('/');
    const address = slash === -1 ? text : text.slice(0, slash);
    const family = isIP(address);
    if (!text || family === 0) return { error: `rete non valida: ${JSON.stringify(text)}` };
    const maxPrefix = family === 4 ? 32 : 128;
    const rawPrefix = slash === -1 ? String(maxPrefix) : text.slice(slash + 1);
    const prefix = /^\d{1,3}$/.test(rawPrefix) ? Number(rawPrefix) : NaN;
    if (!(prefix >= 1 && prefix <= maxPrefix)) {
      return { error: `prefisso non valido in ${JSON.stringify(text)} (1-${maxPrefix}: /0 ammetterebbe qualsiasi peer)` };
    }
    list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return { list };
}

function allowedPeers(): AllowedPeers | null {
  const raw = process.env.CALDAV_BACKEND_ALLOWED_PEERS;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPeers = parseAllowedPeers(raw);
    if (cachedPeers && 'error' in cachedPeers) {
      log.error({ reason: cachedPeers.error }, 'CALDAV_BACKEND_ALLOWED_PEERS non valida: backend CalDAV chiuso');
    }
  }
  return cachedPeers;
}

/**
 * Indirizzo del peer TCP dal socket di @hono/node-server (`c.env.incoming`);
 * null se la richiesta non arriva da un socket (app.request() nei test).
 */
export function tcpPeer(c: Context): string | null {
  const env = c.env as { incoming?: IncomingMessage; server?: { incoming?: IncomingMessage } } | undefined;
  const incoming = env?.incoming ?? env?.server?.incoming;
  const address = incoming?.socket?.remoteAddress;
  return typeof address === 'string' && address ? address : null;
}

function peerAllowed(list: BlockList, peer: string): boolean {
  const family = isIP(peer);
  if (family === 0) return false;
  // BlockList riconosce anche gli IPv4 mappati (::ffff:a.b.c.d) in una rete IPv4.
  return list.check(peer, family === 4 ? 'ipv4' : 'ipv6');
}

// ─── Middleware ──────────────────────────────────────────────

export async function caldavServiceAuth(c: Context, next: Next) {
  const peers = allowedPeers();
  if (peers) {
    if ('error' in peers) {
      return c.json({ error: 'CalDAV backend non configurato (CALDAV_BACKEND_ALLOWED_PEERS non valida)' }, 503);
    }
    const peer = tcpPeer(c);
    if (!peer || !peerAllowed(peers.list, peer)) {
      return c.json({ error: 'Not Found' }, 404);
    }
  }

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
