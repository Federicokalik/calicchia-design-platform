import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcrypt';
import { sql } from '../db';
import { getJwtSecret } from '../lib/jwt';
import { createRateLimit } from '../middleware/rate-limit';
import type { Context, Next } from 'hono';
import { setPortalCookie, clearPortalCookie } from '../lib/cookies';

type PortalEnv = { Variables: { customer_id: string; customer_email: string } };
export const portal = new Hono<PortalEnv>();

const PORTAL_JWT_EXPIRES = '30d';
const portalLoginLimit = createRateLimit(10, 15 * 60 * 1000);

// ── Portal Auth Middleware ───────────────────────────────
async function portalAuth(c: Context, next: Next) {
  const cookieHeader = c.req.header('cookie') || '';
  const match = cookieHeader.match(/portal_token=([^;]+)/);
  const token = match?.[1] ?? null;

  if (!token) {
    return c.json({ error: 'Non autorizzato' }, 401);
  }

  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (!payload.sub || payload.role !== 'client') {
      return c.json({ error: 'Token non valido' }, 401);
    }
    c.set('customer_id', payload.sub as string);
    c.set('customer_email', payload.email as string);
  } catch {
    return c.json({ error: 'Sessione scaduta' }, 401);
  }

  await next();
}

// ── Login (email + portal access code) ───────────────────
portal.post('/login', portalLoginLimit, async (c) => {
  const { email, access_code } = await c.req.json();

  if (!email || !access_code) {
    return c.json({ error: 'Email e codice di accesso richiesti' }, 400);
  }

  const [customer] = await sql`
    SELECT id, email, contact_name, company_name, portal_access_code_hash
    FROM customers
    WHERE LOWER(email) = ${email.toLowerCase().trim()}
    LIMIT 1
  ` as Array<{
    id: string;
    email: string;
    contact_name: string;
    company_name: string;
    portal_access_code_hash: string | null;
  }>;

  if (!customer?.portal_access_code_hash) {
    return c.json({ error: 'Credenziali non valide' }, 401);
  }

  const codeValid = await bcrypt.compare(String(access_code).trim(), customer.portal_access_code_hash);
  if (!codeValid) {
    return c.json({ error: 'Credenziali non valide' }, 401);
  }

  const token = await new SignJWT({
    sub: customer.id,
    email: customer.email,
    role: 'client',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(PORTAL_JWT_EXPIRES)
    .sign(getJwtSecret());

  setPortalCookie(c, token);

  const siteUrl = process.env.SITE_URL || 'https://calicchia.design';
  return c.json({
    customer: {
      id: customer.id,
      email: customer.email,
      contact_name: customer.contact_name,
      company_name: customer.company_name,
    },
    gdpr: {
      legal_basis: 'Art. 6(1)(b) GDPR — Esecuzione contrattuale',
      privacy_policy: `${siteUrl}/privacy-policy`,
      rights_request: `${siteUrl}/privacy-request`,
    },
  });
});

// ── Login by code only (simplified portal access) ───────
portal.post('/login-by-code', portalLoginLimit, async (c) => {
  const { access_code } = await c.req.json();

  if (!access_code) {
    return c.json({ error: 'Codice di accesso richiesto' }, 400);
  }

  const candidates = await sql`
    SELECT id, email, contact_name, company_name, portal_access_code_hash
    FROM customers
    WHERE portal_access_code_hash IS NOT NULL
  ` as Array<{
    id: string;
    email: string;
    contact_name: string;
    company_name: string;
    portal_access_code_hash: string;
  }>;

  let customer: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(String(access_code).trim(), candidate.portal_access_code_hash)) {
      customer = candidate;
      break;
    }
  }

  if (!customer) {
    return c.json({ error: 'Codice non valido' }, 401);
  }

  const token = await new SignJWT({
    sub: customer.id,
    email: customer.email,
    role: 'client',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(PORTAL_JWT_EXPIRES)
    .sign(getJwtSecret());

  setPortalCookie(c, token);

  return c.json({
    customer: {
      id: customer.id,
      email: customer.email,
      contact_name: customer.contact_name,
      company_name: customer.company_name,
    },
  });
});

// ── Logout ───────────────────────────────────────────────
portal.post('/logout', (c) => {
  clearPortalCookie(c);
  return c.json({ ok: true });
});

// ── Me (verify session) ─────────────────────────────────
portal.get('/me', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;

  const [customer] = await sql`
    SELECT id, email, contact_name, company_name
    FROM customers
    WHERE id = ${customerId}
    LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!customer) return c.json({ error: 'Cliente non trovato' }, 404);
  return c.json({ customer });
});

// ── Projects ─────────────────────────────────────────────
portal.get('/projects', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;

  const projects = await sql`
    SELECT
      cp.id, cp.name, cp.status, cp.progress_percentage,
      cp.client_notes, cp.project_category,
      cu.company_name, cu.contact_name
    FROM client_projects cp
    JOIN customers cu ON cu.id = cp.customer_id
    WHERE cp.customer_id = ${customerId}
      AND cp.visible_to_client = true
    ORDER BY cp.created_at DESC
  ` as Array<Record<string, unknown>>;

  return c.json({ projects });
});

portal.get('/projects/:id', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const id = c.req.param('id');

  const [project] = await sql`
    SELECT
      cp.id, cp.name, cp.status, cp.progress_percentage,
      cp.client_notes, cp.project_category,
      cu.company_name, cu.contact_name
    FROM client_projects cp
    JOIN customers cu ON cu.id = cp.customer_id
    WHERE cp.id = ${id}
      AND cp.customer_id = ${customerId}
      AND cp.visible_to_client = true
    LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!project) return c.json({ error: 'Progetto non trovato' }, 404);

  // Milestones
  const milestones = await sql`
    SELECT id, title, status, completed_at, due_date
    FROM project_milestones
    WHERE project_id = ${id}
    ORDER BY created_at ASC
  ` as Array<Record<string, unknown>>;

  // Deliverables (approved/delivered only)
  const deliverables = await sql`
    SELECT
      pd.id, pd.title, pd.status, pd.deliverable_type,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', dv.id,
            'file_url', dv.file_url,
            'file_name', dv.file_name,
            'version_number', dv.version_number,
            'is_current', dv.is_current
          )
        ) FILTER (WHERE dv.id IS NOT NULL),
        '[]'
      ) AS versions
    FROM project_deliverables pd
    LEFT JOIN deliverable_versions dv ON dv.deliverable_id = pd.id
    WHERE pd.project_id = ${id}
      AND pd.status IN ('approved', 'delivered')
    GROUP BY pd.id
    ORDER BY pd.created_at ASC
  ` as Array<Record<string, unknown>>;

  return c.json({ project, milestones, deliverables });
});

// ── Payments (for current customer's projects) ───────────
portal.get('/payments', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const projectId = c.req.query('project_id');

  const projectFilter = projectId ? sql`AND ps.project_id = ${projectId}` : sql``;

  const schedules = await sql`
    SELECT
      ps.id, ps.title, ps.schedule_type, ps.amount, ps.currency,
      ps.due_date, ps.status, ps.paid_amount, ps.paid_at,
      jsonb_build_object('id', cp.id, 'name', cp.name) AS project,
      jsonb_build_object('id', q.id, 'quote_number', q.quote_number, 'title', q.title) AS quote,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', pl.id,
            'provider', pl.provider,
            'checkout_url', pl.checkout_url,
            'status', pl.status,
            'amount', pl.amount,
            'currency', pl.currency
          )
        ) FILTER (WHERE pl.id IS NOT NULL AND pl.status = 'active'),
        '[]'
      ) AS payment_links
    FROM payment_schedules ps
    LEFT JOIN quotes q ON q.id = ps.quote_id
    LEFT JOIN client_projects cp ON cp.id = ps.project_id
    LEFT JOIN payment_links pl ON pl.payment_schedule_id = ps.id
    WHERE ps.status NOT IN ('cancelled')
      AND (
        ps.project_id IN (SELECT id FROM client_projects WHERE customer_id = ${customerId})
        OR ps.quote_id IN (SELECT id FROM quotes WHERE customer_id = ${customerId})
      )
      ${projectFilter}
    GROUP BY ps.id, cp.id, q.id
    ORDER BY ps.due_date ASC NULLS LAST
  ` as Array<Record<string, unknown>>;

  return c.json({ schedules });
});

// ── Invoices (for current customer) ─────────────────────
portal.get('/invoices', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;

  const invoices = await sql`
    SELECT id, invoice_number, status, subtotal, tax_amount, total,
           issue_date, due_date, payment_status, line_items
    FROM invoices
    WHERE customer_id = ${customerId}
    ORDER BY issue_date DESC
  ` as Array<Record<string, unknown>>;

  return c.json({ invoices });
});
