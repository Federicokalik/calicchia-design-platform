import { Hono } from 'hono';
import { sql } from '../db';
import { verifyTurnstileToken } from '../lib/turnstile';

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
}

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;

const cleanString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const cleanOptionalString = (value: unknown) => {
  const cleaned = cleanString(value);
  return cleaned || null;
};

publicLeads.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as LeadBody;

    const name = cleanString(body.name);
    const email = cleanString(body.email).toLowerCase();
    const message = cleanString(body.message);
    const sourceToken = cleanString(body.source_token);
    const utmSource = cleanString(body.utm_source);
    const utmMedium = cleanString(body.utm_medium);
    const utmCampaign = cleanString(body.utm_campaign);
    const utmContent = cleanString(body.utm_content);
    const utmTerm = cleanString(body.utm_term);
    const turnstileToken = cleanString(body.turnstile_token);

    if (!name || name.length > 200 || !isValidEmail(email) || message.length > 2000) {
      return c.json({ error: 'Dati non validi' }, 400);
    }

    const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined;
    const turnstileOk = await verifyTurnstileToken(turnstileToken, clientIp);
    if (!turnstileOk) return c.json({ error: 'Verifica anti-bot fallita.' }, 403);

    const tags: string[] = [];
    if (sourceToken) tags.push(`embed:${sourceToken}`);
    if (utmSource) tags.push(`utm_source:${utmSource}`);
    if (utmMedium) tags.push(`utm_medium:${utmMedium}`);
    if (utmCampaign) tags.push(`utm_campaign:${utmCampaign}`);
    if (utmContent) tags.push(`utm_content:${utmContent}`);
    if (utmTerm) tags.push(`utm_term:${utmTerm}`);

    const [lead] = await sql`
      INSERT INTO leads (name, email, phone, company, source, source_id, status, notes, tags)
      VALUES (
        ${name},
        ${email},
        ${cleanOptionalString(body.phone)},
        ${cleanOptionalString(body.company)},
        ${'embed_form'},
        ${sourceToken || null},
        ${'new'},
        ${message || null},
        ${tags}
      )
      RETURNING id, created_at
    `;

    return c.json({ ok: true, lead_id: lead.id }, 201);
  } catch (err) {
    console.error('[public-leads] error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});
