import { Hono } from 'hono';
import { sql } from '../db';
import { verifyTurnstileToken } from '../lib/turnstile';
import { getClientIp } from '../lib/client-ip';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'public-leads' });

export const publicLeads = new Hono();

interface LeadBody {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  message?: string;
  source_token?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  turnstile_token?: string;
  /** Audit C-007: explicit GDPR consent required for partner-embedded leads. */
  gdpr_consent?: boolean;
}

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;

const cleanString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const cleanOptionalString = (value: unknown) => {
  const cleaned = cleanString(value);
  return cleaned || null;
};

// Audit C-018: utm_* and source_token are concatenated into leads.tags TEXT[].
// A partner site could submit unbounded strings (up to body limit) — bloat
// per row + ugly admin tables + GDPR-export dumps. Cap at 64 chars and reject
// anything outside a conservative slug charset. Same shape contacts.ts uses.
const TAG_CHARSET = /^[a-zA-Z0-9_\-./]+$/;
function cleanTag(value: unknown): string {
  const trimmed = cleanString(value).slice(0, 64);
  return TAG_CHARSET.test(trimmed) ? trimmed : '';
}

publicLeads.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as LeadBody;

    const name = cleanString(body.name);
    const email = cleanString(body.email).toLowerCase();
    const message = cleanString(body.message);
    const sourceToken = cleanTag(body.source_token);
    const utmSource = cleanTag(body.utm_source);
    const utmMedium = cleanTag(body.utm_medium);
    const utmCampaign = cleanTag(body.utm_campaign);
    const utmContent = cleanTag(body.utm_content);
    const utmTerm = cleanTag(body.utm_term);
    const turnstileToken = cleanString(body.turnstile_token);

    if (!name || name.length > 200 || !isValidEmail(email) || message.length > 2000) {
      return c.json({ error: 'Dati non validi' }, 400);
    }

    // Audit C-007: strict GDPR consent check (boolean true, not just truthy).
    if (body.gdpr_consent !== true) {
      return c.json({ error: 'Consenso GDPR richiesto' }, 400);
    }

    const turnstileOk = await verifyTurnstileToken(turnstileToken, {
      remoteIp: getClientIp(c) ?? undefined,
      expectedAction: 'embed_lead',
    });
    if (!turnstileOk) return c.json({ error: 'Verifica anti-bot fallita.' }, 403);

    const consentIp = getClientIp(c) ?? null;
    const consentUserAgent = c.req.header('user-agent')?.slice(0, 512) ?? null;

    const tags: string[] = [];
    if (sourceToken) tags.push(`embed:${sourceToken}`);
    if (utmSource) tags.push(`utm_source:${utmSource}`);
    if (utmMedium) tags.push(`utm_medium:${utmMedium}`);
    if (utmCampaign) tags.push(`utm_campaign:${utmCampaign}`);
    if (utmContent) tags.push(`utm_content:${utmContent}`);
    if (utmTerm) tags.push(`utm_term:${utmTerm}`);

    const [lead] = await sql`
      INSERT INTO leads (
        name, email, phone, company, source, source_id, status, notes, tags,
        gdpr_consent, consent_ip, consent_user_agent
      )
      VALUES (
        ${name},
        ${email},
        ${cleanOptionalString(body.phone)},
        ${cleanOptionalString(body.company)},
        ${'embed_form'},
        ${sourceToken || null},
        ${'new'},
        ${message || null},
        ${tags},
        true,
        ${consentIp},
        ${consentUserAgent}
      )
      RETURNING id, created_at
    `;

    return c.json({ ok: true, lead_id: lead.id }, 201);
  } catch (err) {
    log.error({ err }, 'error');
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});
