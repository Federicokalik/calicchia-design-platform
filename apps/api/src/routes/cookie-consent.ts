import { Hono } from 'hono';
import { z } from 'zod';
import { sql, sqlv } from '../db';
import { zValidator } from '../lib/z-validator';

export const cookieConsent = new Hono();

// Strict schema. preferences must be a closed object — accepting arbitrary keys
// would let an attacker bloat the JSONB row and pollute the GDPR audit trail
// (audit J-03 + E-007 + E-017). version accepts the two shapes already in use
// in the codebase: YYYY-MM-DD date string (current — see sito-v3
// CONSENT_VERSION) or short semver-ish; timestamp is epoch ms (client uses
// Date.now()) or ISO-8601. Anything else → 400, no insert.
const cookieConsentSchema = z.object({
  preferences: z.object({
    necessary: z.boolean(),
    analytics: z.boolean(),
    marketing: z.boolean(),
  }).strict(),
  version: z.string().max(32).regex(
    /^(\d{4}-\d{2}-\d{2}|\d{1,3}(\.\d{1,3}){0,3})$/,
    'version must be YYYY-MM-DD or semver-ish',
  ),
  timestamp: z.union([
    z.number().int().positive(),
    z.string().datetime({ offset: true }),
  ]),
});

type CookieConsentPayload = z.infer<typeof cookieConsentSchema>;

/**
 * POST /api/cookie-consent
 * Public endpoint — logs cookie consent for GDPR audit trail.
 * IP is anonymized (last octet zeroed) before storage.
 *
 * Rate-limited externally (app.ts) to 10 req / 60s per IP — the previous
 * unbounded surface could be used to bloat cookie_consents indefinitely.
 */
cookieConsent.post('/', zValidator('json', cookieConsentSchema), async (c) => {
  const { preferences, version } = (c.req as any).valid('json') as CookieConsentPayload;

  // Anonymize IP: zero last octet for IPv4, last group for IPv6
  const rawIp =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    '';
  const ipAnonymous = anonymizeIp(rawIp);

  const userAgent = (c.req.header('user-agent') || '').slice(0, 512);

  await sql`
    INSERT INTO cookie_consents (ip_anonymous, preferences, consent_version, user_agent)
    VALUES (${ipAnonymous}, ${sqlv(preferences)}, ${version}, ${userAgent})
  `;

  return c.json({ success: true });
});

function anonymizeIp(ip: string): string {
  if (!ip) return '';
  // IPv4: 192.168.1.42 → 192.168.1.0
  if (ip.includes('.') && !ip.includes(':')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      parts[3] = '0';
      return parts.join('.');
    }
  }
  // IPv6: zero last group
  if (ip.includes(':')) {
    const parts = ip.split(':');
    if (parts.length > 1) {
      parts[parts.length - 1] = '0';
      return parts.join(':');
    }
  }
  return '';
}
