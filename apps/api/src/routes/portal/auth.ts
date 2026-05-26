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
import { verifyTurnstileToken } from '../../lib/turnstile';
import { getClientIp } from '../../lib/client-ip';
import { sendEmail } from '../../lib/email';
import { renderMagicLinkEmail } from '../../templates/magic-link';
import { logger } from '../../lib/logger';

const log = logger.child({ scope: 'portal-auth' });

export type PortalRole = 'client' | 'collaborator';

export type PortalEnv = {
  Variables: {
    actor_id: string;
    actor_role: PortalRole;
    customer_id?: string;
    customer_email?: string;
    collaborator_id?: string;
    session_version: number;
  };
};

type ClientActor = {
  role: 'client';
  id: string;
  email: string | null;
  contact_name: string | null;
  company_name: string | null;
  portal_logo: string | null;
  portal_access_code_hash: string;
  session_version: number;
};

type CollaboratorActor = {
  role: 'collaborator';
  id: string;
  email: string | null;
  name: string | null;
  company: string | null;
  portal_access_code_hash: string;
  session_version: number;
};

type PortalActor = ClientActor | CollaboratorActor;

const PORTAL_JWT_EXPIRES = '30d';
const portalLoginLimit = createRateLimit(10, 15 * 60 * 1000);
const magicLinkRequestLimit = createRateLimit(5, 10 * 60 * 1000);

function getSiteUrl(): string {
  return process.env.PORTAL_URL || process.env.SITE_URL || 'https://calicchia.design';
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function actorPayload(actor: PortalActor) {
  if (actor.role === 'collaborator') {
    return {
      id: actor.id,
      role: 'collaborator',
      email: actor.email,
      contact_name: actor.name,
      company_name: actor.company,
      portal_logo: null,
    };
  }

  return {
    id: actor.id,
    role: 'client',
    email: actor.email,
    contact_name: actor.contact_name,
    company_name: actor.company_name,
    portal_logo: actor.portal_logo,
  };
}

async function findActorByCode(accessCode: string, normalizedEmail?: string): Promise<PortalActor | null> {
  const provided = accessCode.trim();
  if (!provided) return null;

  const customerRows = (await sql`
    SELECT id, email, contact_name, company_name, portal_access_code_hash, portal_logo, session_version
    FROM customers
    WHERE portal_access_code_hash IS NOT NULL
      ${normalizedEmail ? sql`AND LOWER(email) = ${normalizedEmail}` : sql``}
  `) as Array<Omit<ClientActor, 'role'>>;

  for (const row of customerRows) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(provided, row.portal_access_code_hash)) {
      return { role: 'client', ...row };
    }
  }

  const collaboratorRows = (await sql`
    SELECT id, email, name, company, portal_access_code_hash, session_version
    FROM collaborators
    WHERE portal_access_code_hash IS NOT NULL
      ${normalizedEmail ? sql`AND LOWER(email) = ${normalizedEmail}` : sql``}
  `) as Array<Omit<CollaboratorActor, 'role'>>;

  for (const row of collaboratorRows) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(provided, row.portal_access_code_hash)) {
      return { role: 'collaborator', ...row };
    }
  }

  return null;
}

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
    if (!payload.sub || (payload.role !== 'client' && payload.role !== 'collaborator')) {
      return c.json({ error: 'Token non valido' }, 401);
    }
  } catch {
    return c.json({ error: 'Sessione scaduta' }, 401);
  }

  const sv = Number(payload.sv ?? 0);
  const actorId = String(payload.sub);
  const role = payload.role as PortalRole;
  const rows = role === 'client'
    ? (await sql`
        SELECT session_version FROM customers WHERE id = ${actorId} LIMIT 1
      `) as Array<{ session_version: number }>
    : (await sql`
        SELECT session_version FROM collaborators WHERE id = ${actorId} LIMIT 1
      `) as Array<{ session_version: number }>;
  const row = rows[0];

  if (!row) return c.json({ error: role === 'client' ? 'Cliente non trovato' : 'Collaboratore non trovato' }, 401);
  if (Number(row.session_version) !== sv) {
    return c.json({ error: 'Sessione revocata' }, 401);
  }

  c.set('actor_id', actorId);
  c.set('actor_role', role);
  c.set('session_version', sv);
  if (role === 'client') {
    c.set('customer_id', actorId);
    c.set('customer_email', String(payload.email ?? ''));
  } else {
    c.set('collaborator_id', actorId);
  }

  await next();
}

export async function portalClientAuth(c: Context, next: Next) {
  const authResult = await portalAuth(c, async () => {});
  if (authResult) return authResult;
  if (c.get('actor_role') !== 'client' || !c.get('customer_id')) {
    return c.json({ error: 'Area riservata ai clienti' }, 403);
  }
  await next();
}

async function signPortalJwt(actor: {
  id: string;
  email?: string | null;
  role: PortalRole;
  session_version: number;
}): Promise<string> {
  return new SignJWT({
    sub: actor.id,
    email: actor.email ?? '',
    role: actor.role,
    sv: actor.session_version,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(PORTAL_JWT_EXPIRES)
    .sign(getJwtSecret());
}

export const authRoutes = new Hono<PortalEnv>();

authRoutes.post('/request-link', magicLinkRequestLimit, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    turnstile_token?: string;
  };
  const email = String(body.email ?? '').toLowerCase().trim();

  if (!email || !isEmail(email)) {
    return c.json({ error: 'Email non valida' }, 400);
  }

  if (
    !(await verifyTurnstileToken(body.turnstile_token ?? '', {
      remoteIp: getClientIp(c) ?? undefined,
      expectedAction: 'portal_login',
    }))
  ) {
    return c.json({ error: 'Verifica anti-bot fallita. Ricarica la pagina e riprova.' }, 403);
  }

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
    log.error({ err }, 'request-link failed');
    await auditPortalEvent(c, 'link_requested', {
      customer_id: customer.id,
      email,
      success: false,
      error_code: 'send_failed',
    });
  }

  return c.json({ ok: true });
});

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
    email: string | null;
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
    role: 'client',
    session_version: Number(customer.session_version),
  });
  setPortalCookie(c, jwt);

  await auditPortalEvent(c, 'link_consumed', {
    customer_id: customer.id,
    email: customer.email ?? '',
    success: true,
  });

  return c.json({
    customer: actorPayload({
      role: 'client',
      id: customer.id,
      email: customer.email,
      contact_name: customer.contact_name,
      company_name: customer.company_name,
      portal_access_code_hash: '',
      portal_logo: customer.portal_logo,
      session_version: customer.session_version,
    }),
  });
});

authRoutes.post('/login', portalLoginLimit, async (c) => {
  const { email, access_code, turnstile_token } = (await c.req.json()) as {
    email?: string;
    access_code?: string;
    turnstile_token?: string;
  };

  if (!access_code) {
    return c.json({ error: 'Codice di accesso richiesto' }, 400);
  }

  if (
    !(await verifyTurnstileToken(turnstile_token ?? '', {
      remoteIp: getClientIp(c) ?? undefined,
      expectedAction: 'portal_login',
    }))
  ) {
    return c.json({ error: 'Verifica anti-bot fallita. Ricarica la pagina e riprova.' }, 403);
  }

  const normalizedEmail = String(email ?? '').toLowerCase().trim();
  if (normalizedEmail && !isEmail(normalizedEmail)) {
    return c.json({ error: 'Email non valida' }, 400);
  }

  const actor = await findActorByCode(String(access_code), normalizedEmail || undefined);
  if (!actor) {
    await auditPortalEvent(c, 'code_login_failed', {
      email: normalizedEmail,
      success: false,
      error_code: 'bad_code',
    });
    return c.json({ error: 'Credenziali non valide' }, 401);
  }

  const jwt = await signPortalJwt({
    id: actor.id,
    email: actor.email,
    role: actor.role,
    session_version: Number(actor.session_version),
  });
  setPortalCookie(c, jwt);

  await auditPortalEvent(c, 'code_login_success', {
    customer_id: actor.role === 'client' ? actor.id : undefined,
    email: actor.email ?? normalizedEmail,
    success: true,
    metadata: { with_email: Boolean(normalizedEmail), role: actor.role },
  });

  const siteUrl = getSiteUrl();
  return c.json({
    customer: actorPayload(actor),
    gdpr: actor.role === 'client'
      ? {
          legal_basis: 'Art. 6(1)(b) GDPR - Esecuzione contrattuale',
          privacy_policy: `${siteUrl}/privacy-policy`,
          rights_request: `${siteUrl}/privacy-request`,
        }
      : undefined,
  });
});

authRoutes.post('/login-by-code', portalLoginLimit, async (c) => {
  const { access_code } = (await c.req.json()) as { access_code?: string };

  if (!access_code) {
    return c.json({ error: 'Codice di accesso richiesto' }, 400);
  }

  const actor = await findActorByCode(String(access_code));
  if (!actor) {
    await auditPortalEvent(c, 'code_login_failed', {
      success: false,
      error_code: 'no_match',
      metadata: { with_email: false },
    });
    return c.json({ error: 'Codice non valido' }, 401);
  }

  const jwt = await signPortalJwt({
    id: actor.id,
    email: actor.email,
    role: actor.role,
    session_version: Number(actor.session_version),
  });
  setPortalCookie(c, jwt);

  await auditPortalEvent(c, 'code_login_success', {
    customer_id: actor.role === 'client' ? actor.id : undefined,
    email: actor.email ?? '',
    success: true,
    metadata: { with_email: false, role: actor.role },
  });

  return c.json({ customer: actorPayload(actor) });
});

authRoutes.post('/logout', async (c) => {
  let customerId: string | null = null;
  try {
    const cookieHeader = c.req.header('cookie') || '';
    const match = cookieHeader.match(/portal_token=([^;]+)/);
    if (match) {
      const { payload } = await jwtVerify(match[1], getJwtSecret());
      if (payload.role === 'client' && payload.sub) customerId = String(payload.sub);
    }
  } catch {
    /* logout always succeeds client-side */
  }

  clearPortalCookie(c);
  await auditPortalEvent(c, 'logout', { customer_id: customerId, success: true });
  return c.json({ ok: true });
});

authRoutes.get('/me', portalAuth, async (c) => {
  const role = c.get('actor_role');
  const actorId = c.get('actor_id');

  if (role === 'collaborator') {
    const [collaborator] = (await sql`
      SELECT id, email, name, company
      FROM collaborators
      WHERE id = ${actorId}
      LIMIT 1
    `) as Array<{ id: string; email: string | null; name: string | null; company: string | null }>;
    if (!collaborator) return c.json({ error: 'Collaboratore non trovato' }, 404);
    return c.json({
      customer: {
        id: collaborator.id,
        role: 'collaborator',
        email: collaborator.email,
        contact_name: collaborator.name,
        company_name: collaborator.company,
        portal_logo: null,
      },
    });
  }

  const [customer] = (await sql`
    SELECT id, email, contact_name, company_name, portal_logo
    FROM customers
    WHERE id = ${actorId}
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  if (!customer) return c.json({ error: 'Cliente non trovato' }, 404);
  return c.json({ customer: { ...customer, role: 'client' } });
});
