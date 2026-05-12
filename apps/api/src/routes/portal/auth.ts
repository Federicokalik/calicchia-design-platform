import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcrypt';
import { sql } from '../../db';
import { getJwtSecret } from '../../lib/jwt';
import { createRateLimit } from '../../middleware/rate-limit';
import { setPortalCookie, clearPortalCookie } from '../../lib/cookies';
import { auditPortalEvent } from '../../lib/portal-audit';
import { issueMagicLink, consumeMagicLink } from '../../lib/portal-tokens';
import { sendEmail } from '../../lib/email';
import { renderMagicLinkEmail } from '../../templates/magic-link';

export type PortalEnv = {
  Variables: {
    customer_id: string;
    customer_email: string;
    session_version: number;
  };
};

const PORTAL_JWT_EXPIRES = '7d';
const portalLoginLimit = createRateLimit(10, 15 * 60 * 1000);
const magicLinkRequestLimit = createRateLimit(5, 10 * 60 * 1000);

function getSiteUrl(): string {
  return process.env.PORTAL_URL || process.env.SITE_URL || 'https://calicchia.design';
}

function getClientIp(c: Context): string | null {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    null
  );
}

// ── Portal Auth Middleware (exported for other portal sub-routes) ──
export async function portalAuth(c: Context, next: Next) {
  const cookieHeader = c.req.header('cookie') || '';
  const match = cookieHeader.match(/portal_token=([^;]+)/);
  const token = match?.[1] ?? null;

  if (!token) {
    return c.json({ error: 'Non autorizzato' }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, getJwtSecret());
    payload = verified.payload as Record<string, unknown>;
    if (!payload.sub || payload.role !== 'client') {
      return c.json({ error: 'Token non valido' }, 401);
    }
  } catch {
    return c.json({ error: 'Sessione scaduta' }, 401);
  }

  // Session version check — admin can revoke all JWTs by incrementing
  // customers.session_version. JWT-embedded version must match current.
  const sv = Number(payload.sv ?? 0);
  const customerId = payload.sub as string;
  const [row] = (await sql`
    SELECT session_version FROM customers WHERE id = ${customerId} LIMIT 1
  `) as Array<{ session_version: number }>;
  if (!row) return c.json({ error: 'Cliente non trovato' }, 401);
  if (Number(row.session_version) !== sv) {
    return c.json({ error: 'Sessione revocata' }, 401);
  }

  c.set('customer_id', customerId);
  c.set('customer_email', String(payload.email ?? ''));
  c.set('session_version', sv);

  await next();
}

/** Sign a fresh portal JWT carrying the customer's current session_version. */
async function signPortalJwt(customer: {
  id: string;
  email: string;
  session_version: number;
}): Promise<string> {
  return new SignJWT({
    sub: customer.id,
    email: customer.email,
    role: 'client',
    sv: customer.session_version,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(PORTAL_JWT_EXPIRES)
    .sign(getJwtSecret());
}

/** Build the magic-link HTML email body. */
function magicLinkEmailHtml(opts: {
  greeting: string;
  bodyIntro: string;
  ctaLabel: string;
  link: string;
  expiryNote: string;
  fallback: string;
}): string {
  const siteUrl = getSiteUrl();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#FAFAF7;font-family:system-ui,-apple-system,sans-serif;margin:0;padding:40px 16px;color:#111;">
  <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E6E4DC;border-radius:2px;">
    <div style="padding:32px;">
      <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:500;margin:0 0 16px;letter-spacing:-0.01em;">${opts.greeting}</h1>
      <p style="font-size:14px;line-height:1.55;color:#5C5C58;margin:0 0 24px;">${opts.bodyIntro}</p>
      <a href="${opts.link}" style="display:inline-block;background:#F57F44;color:#FFFFFF;padding:12px 24px;border-radius:2px;text-decoration:none;font-size:14px;font-weight:500;">${opts.ctaLabel}</a>
      <p style="font-size:12px;line-height:1.5;color:#8C8C86;margin:24px 0 0;">${opts.expiryNote}</p>
      <hr style="border:0;border-top:1px solid #E6E4DC;margin:24px 0;" />
      <p style="font-size:11px;line-height:1.5;color:#8C8C86;margin:0;word-break:break-all;">${opts.fallback}<br/><span style="color:#5C5C58;">${opts.link}</span></p>
    </div>
    <div style="padding:16px 32px;border-top:1px solid #E6E4DC;text-align:center;">
      <p style="margin:0;font-size:11px;color:#8C8C86;letter-spacing:0.05em;">
        <a href="${siteUrl}" style="color:#8C8C86;text-decoration:none;">calicchia.design</a>
      </p>
    </div>
  </div>
</body></html>`;
}

export const authRoutes = new Hono<PortalEnv>();

// ── Request magic link (email-only flow, primary auth) ───
authRoutes.post('/request-link', magicLinkRequestLimit, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string };
  const email = String(body.email ?? '').toLowerCase().trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Email non valida' }, 400);
  }

  // ALWAYS respond 200 to prevent user enumeration. If customer doesn't
  // exist we still pretend success.
  const [customer] = (await sql`
    SELECT id, email, contact_name FROM customers
    WHERE LOWER(email) = ${email}
    LIMIT 1
  `) as Array<{ id: string; email: string; contact_name: string | null }>;

  if (!customer) {
    await auditPortalEvent(c, 'link_requested', { email, success: false, error_code: 'no_user' });
    return c.json({ ok: true });
  }

  try {
    const { plaintext, expires_at } = await issueMagicLink(
      customer.id,
      getClientIp(c),
      c.req.header('user-agent') ?? null
    );
    const link = `${getSiteUrl()}/clienti/auth/verify?token=${encodeURIComponent(plaintext)}`;
    const minutes = Math.round((expires_at.getTime() - Date.now()) / 60000);

    const { subject, html, text } = await renderMagicLinkEmail({
      contactName: customer.contact_name,
      link,
      expiresMinutes: minutes,
    });
    await sendEmail({
      to: customer.email,
      subject,
      html,
      text,
      transport: 'critical',
    });

    await auditPortalEvent(c, 'link_requested', {
      customer_id: customer.id,
      email: customer.email,
      success: true,
    });
  } catch (err) {
    console.error('[portal/request-link] failed:', (err as Error).message);
    await auditPortalEvent(c, 'link_requested', {
      customer_id: customer.id,
      email,
      success: false,
      error_code: 'send_failed',
    });
  }

  return c.json({ ok: true });
});

// ── Exchange magic link token for a session ──────────────
authRoutes.post('/exchange-token', portalLoginLimit, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  const token = String(body.token ?? '').trim();

  const result = await consumeMagicLink(token);
  if (!result.ok) {
    const evt =
      result.reason === 'expired' ? 'link_expired' :
      result.reason === 'used' ? 'link_invalid' :
      'link_invalid';
    await auditPortalEvent(c, evt, { success: false, error_code: result.reason });
    return c.json({ error: 'Link non valido o scaduto' }, 401);
  }

  const [customer] = (await sql`
    SELECT id, email, contact_name, company_name, portal_logo, session_version
    FROM customers
    WHERE id = ${result.customer_id}
    LIMIT 1
  `) as Array<{
    id: string;
    email: string;
    contact_name: string | null;
    company_name: string | null;
    portal_logo: string | null;
    session_version: number;
  }>;

  if (!customer) {
    await auditPortalEvent(c, 'link_invalid', { success: false, error_code: 'no_user' });
    return c.json({ error: 'Cliente non trovato' }, 404);
  }

  const jwt = await signPortalJwt({
    id: customer.id,
    email: customer.email,
    session_version: Number(customer.session_version),
  });
  setPortalCookie(c, jwt);

  await auditPortalEvent(c, 'link_consumed', {
    customer_id: customer.id,
    email: customer.email,
    success: true,
  });

  return c.json({
    customer: {
      id: customer.id,
      email: customer.email,
      contact_name: customer.contact_name,
      company_name: customer.company_name,
      portal_logo: customer.portal_logo,
    },
  });
});

// ── Login (email + portal access code) ───────────────────
// Kept for the "emergency code" fallback. Email REQUIRED here.
authRoutes.post('/login', portalLoginLimit, async (c) => {
  const { email, access_code } = (await c.req.json()) as { email?: string; access_code?: string };

  if (!email || !access_code) {
    return c.json({ error: 'Email e codice di accesso richiesti' }, 400);
  }

  const normalizedEmail = email.toLowerCase().trim();
  const [customer] = (await sql`
    SELECT id, email, contact_name, company_name, portal_access_code_hash, portal_logo, session_version
    FROM customers
    WHERE LOWER(email) = ${normalizedEmail}
    LIMIT 1
  `) as Array<{
    id: string;
    email: string;
    contact_name: string;
    company_name: string;
    portal_access_code_hash: string | null;
    portal_logo: string | null;
    session_version: number;
  }>;

  if (!customer?.portal_access_code_hash) {
    await auditPortalEvent(c, 'code_login_failed', {
      email: normalizedEmail,
      success: false,
      error_code: 'no_user',
    });
    return c.json({ error: 'Credenziali non valide' }, 401);
  }

  const provided = String(access_code).trim();
  const valid = await bcrypt.compare(provided, customer.portal_access_code_hash);

  if (!valid) {
    await auditPortalEvent(c, 'code_login_failed', {
      customer_id: customer.id,
      email: customer.email,
      success: false,
      error_code: 'bad_code',
    });
    return c.json({ error: 'Credenziali non valide' }, 401);
  }

  const jwt = await signPortalJwt({
    id: customer.id,
    email: customer.email,
    session_version: Number(customer.session_version),
  });
  setPortalCookie(c, jwt);

  await auditPortalEvent(c, 'code_login_success', {
    customer_id: customer.id,
    email: customer.email,
    success: true,
    metadata: { with_email: true },
  });

  const siteUrl = getSiteUrl();
  return c.json({
    customer: {
      id: customer.id,
      email: customer.email,
      contact_name: customer.contact_name,
      company_name: customer.company_name,
      portal_logo: customer.portal_logo,
    },
    gdpr: {
      legal_basis: 'Art. 6(1)(b) GDPR — Esecuzione contrattuale',
      privacy_policy: `${siteUrl}/privacy-policy`,
      rights_request: `${siteUrl}/privacy-request`,
    },
  });
});

// ── Login by code only (deep-link convenience, /clienti/p/[code]) ──
authRoutes.post('/login-by-code', portalLoginLimit, async (c) => {
  const { access_code } = (await c.req.json()) as { access_code?: string };

  if (!access_code) {
    return c.json({ error: 'Codice di accesso richiesto' }, 400);
  }

  const provided = String(access_code).trim();

  // Need to check against ALL customers with a hash.
  // Scope is small (few customers); we accept O(N) bcrypt compares.
  const candidates = (await sql`
    SELECT id, email, contact_name, company_name,
           portal_access_code_hash, portal_logo, session_version
    FROM customers
    WHERE portal_access_code_hash IS NOT NULL
  `) as Array<{
    id: string;
    email: string;
    contact_name: string;
    company_name: string;
    portal_access_code_hash: string;
    portal_logo: string | null;
    session_version: number;
  }>;

  let matched: (typeof candidates)[number] | null = null;
  for (const cand of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(provided, cand.portal_access_code_hash)) {
      matched = cand;
      break;
    }
  }

  if (!matched) {
    await auditPortalEvent(c, 'code_login_failed', {
      success: false,
      error_code: 'no_match',
      metadata: { with_email: false },
    });
    return c.json({ error: 'Codice non valido' }, 401);
  }

  const jwt = await signPortalJwt({
    id: matched.id,
    email: matched.email,
    session_version: Number(matched.session_version),
  });
  setPortalCookie(c, jwt);

  await auditPortalEvent(c, 'code_login_success', {
    customer_id: matched.id,
    email: matched.email,
    success: true,
    metadata: { with_email: false },
  });

  return c.json({
    customer: {
      id: matched.id,
      email: matched.email,
      contact_name: matched.contact_name,
      company_name: matched.company_name,
      portal_logo: matched.portal_logo,
    },
  });
});

// ── Logout ───────────────────────────────────────────────
authRoutes.post('/logout', async (c) => {
  // Try to read the customer_id from JWT for audit, but don't require it.
  let customerId: string | null = null;
  try {
    const cookieHeader = c.req.header('cookie') || '';
    const match = cookieHeader.match(/portal_token=([^;]+)/);
    if (match) {
      const { payload } = await jwtVerify(match[1], getJwtSecret());
      if (payload.sub) customerId = String(payload.sub);
    }
  } catch {
    /* ignore — logout always succeeds client-side */
  }

  clearPortalCookie(c);
  await auditPortalEvent(c, 'logout', { customer_id: customerId, success: true });
  return c.json({ ok: true });
});

// ── Me (verify session) ─────────────────────────────────
authRoutes.get('/me', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;

  const [customer] = (await sql`
    SELECT id, email, contact_name, company_name, portal_logo
    FROM customers
    WHERE id = ${customerId}
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  if (!customer) return c.json({ error: 'Cliente non trovato' }, 404);
  return c.json({ customer });
});
