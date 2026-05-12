import { Hono } from 'hono';
import { sql } from '../db';

export const cookieConsent = new Hono();

/**
 * POST /api/cookie-consent
 * Public endpoint — logs cookie consent for GDPR audit trail.
 * IP is anonymized (last octet zeroed) before storage.
 */
cookieConsent.post('/', async (c) => {
  const body = await c.req.json();
  const { preferences, timestamp, version } = body;

  if (!preferences || !timestamp || !version) {
    return c.json({ error: 'Dati mancanti' }, 400);
  }

  // Anonymize IP: zero last octet for IPv4, last group for IPv6
  const rawIp =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    '';
  const ipAnonymous = anonymizeIp(rawIp);

  const userAgent = (c.req.header('user-agent') || '').slice(0, 512);

  await sql`
    INSERT INTO cookie_consents (ip_anonymous, preferences, consent_version, user_agent)
    VALUES (${ipAnonymous}, ${preferences}, ${version}, ${userAgent})
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
