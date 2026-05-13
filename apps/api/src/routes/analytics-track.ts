/**
 * analytics-track.ts — Cookieless tracking ingestion endpoint.
 *
 * Mounted PUBLIC at /api/track. Rate-limited at the app level.
 *
 * NEVER reads or writes cookies. CORS without credentials. Returns 204.
 * Identity (session_id / visit_id) derived server-side via HMAC.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sql, sqlv } from '../db';
import { sessionId, visitId, visitIdYesterday } from '../lib/analytics/hash';
import { parseUA, isBotUA } from '../lib/analytics/ua';
import { resolveGeo } from '../lib/analytics/geo';
import { publish } from '../lib/analytics/realtime-broadcaster';

export const analyticsTrack = new Hono();

// Body schema — payload is intentionally minimal. Anything extra goes into metadata.
const trackSchema = z.object({
  type: z.enum(['pageview', 'event', 'web_vital', 'outbound']),
  website: z.string().min(1).max(64).optional(),
  page: z.string().max(2048).nullable().optional(),
  referrer: z.string().max(2048).nullable().optional(),
  event_name: z.string().max(128).nullable().optional(),
  event_value: z.number().finite().nullable().optional(),
  duration_ms: z.number().int().min(0).max(60_000_000).nullable().optional(),
  utm: z
    .object({
      source: z.string().max(128).nullable().optional(),
      medium: z.string().max(128).nullable().optional(),
      campaign: z.string().max(128).nullable().optional(),
      term: z.string().max(128).nullable().optional(),
      content: z.string().max(128).nullable().optional(),
    })
    .partial()
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function getClientIp(c: import('hono').Context): string | null {
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf;
  const xf = c.req.header('x-forwarded-for');
  if (xf) return xf.split(',')[0].trim();
  const xr = c.req.header('x-real-ip');
  if (xr) return xr;
  // Node.js fallback: read the socket remote address directly from the underlying
  // IncomingMessage. Critical for dev without a reverse proxy.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const sock = env?.incoming?.socket?.remoteAddress;
  if (sock) return sock;
  return null;
}

function sanitizeReferrer(raw: string | null | undefined): { full: string | null; domain: string | null } {
  if (!raw) return { full: null, domain: null };
  try {
    const u = new URL(raw);
    return {
      full: `${u.origin}${u.pathname}`,
      domain: u.hostname || null,
    };
  } catch {
    return { full: null, domain: null };
  }
}

analyticsTrack.post('/', async (c) => {
  // Parse JSON body. sendBeacon sends Blob/text; accept both.
  let raw: unknown = {};
  try {
    const ct = c.req.header('content-type') || '';
    if (ct.includes('application/json') || ct.includes('text/plain')) {
      const text = await c.req.text();
      raw = text ? JSON.parse(text) : {};
    } else {
      raw = await c.req.json().catch(() => ({}));
    }
  } catch {
    return c.body(null, 204);
  }

  const parsed = trackSchema.safeParse(raw);
  if (!parsed.success) return c.body(null, 204);

  const body = parsed.data;
  const userAgent = c.req.header('user-agent') || '';
  if (isBotUA(userAgent)) return c.body(null, 204);

  const ip = getClientIp(c);
  if (!ip) return c.body(null, 204); // can't hash without IP

  const websiteId = body.website || 'main';
  const now = new Date();

  // Identity (cookieless, HMAC, never persisted to disk in raw form)
  const sId = sessionId(websiteId, ip, userAgent, now);
  let vId = visitId(websiteId, ip, userAgent, now);

  // Bridge cross-midnight: in the first 30 minutes after midnight UTC, check
  // whether this visitor had a visit_id at 23:00 yesterday with a recent event.
  if (now.getUTCHours() === 0 && now.getUTCMinutes() < 30) {
    const vIdYesterday = visitIdYesterday(websiteId, ip, userAgent, now);
    const [bridge] = await sql`
      SELECT 1 FROM analytics
      WHERE visit_id = ${vIdYesterday}
        AND website_id = ${websiteId}
        AND created_at >= NOW() - INTERVAL '30 minutes'
      LIMIT 1
    ` as Array<{ '?column?': number }>;
    if (bridge) vId = vIdYesterday;
  }

  // Parse UA (cheap, in-memory only)
  const ua = parseUA(userAgent);

  // Geo (CF headers first, MaxMind fallback)
  const geo = await resolveGeo(c, ip);

  // Sanitize referrer
  const { full: refFull, domain: refDomain } = sanitizeReferrer(body.referrer);

  await sql`
    INSERT INTO analytics (
      website_id, event_type, page_path, referrer, referrer_domain,
      session_id, visit_id,
      browser, os, device_type,
      country, city,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      event_name, event_value, duration_ms,
      metadata,
      ip_address, user_agent
    ) VALUES (
      ${websiteId}, ${body.type}, ${body.page ?? null}, ${refFull}, ${refDomain},
      ${sId}, ${vId},
      ${ua.browser}, ${ua.os}, ${ua.device_type},
      ${geo.country}, ${geo.city},
      ${body.utm?.source ?? null}, ${body.utm?.medium ?? null}, ${body.utm?.campaign ?? null},
      ${body.utm?.term ?? null}, ${body.utm?.content ?? null},
      ${body.event_name ?? null}, ${body.event_value ?? null}, ${body.duration_ms ?? null},
      ${sqlv(body.metadata || {})},
      ${null}, ${null}
    )
  `;

  // Fan-out to SSE subscribers (best-effort, never throws)
  try {
    publish({
      type: body.type,
      page: body.page ?? null,
      event_name: body.event_name ?? null,
      country: geo.country,
      at: now.toISOString(),
    });
  } catch { /* swallow */ }

  return c.body(null, 204);
});
