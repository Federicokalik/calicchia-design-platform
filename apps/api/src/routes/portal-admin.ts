/**
 * Portal Admin routes — consumed by the admin gestionale.
 * Protected by authMiddleware (admin JWT).
 * Manages timeline events, reports, and material requests.
 */

import { Hono } from 'hono';
import { sql } from '../db';
import { fail } from '../lib/responses';

export const portalAdmin = new Hono();

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Branded dark email wrapper for portal notifications
function portalEmailHtml(body: string): string {
  const siteUrl = process.env.SITE_URL || 'https://calicchia.design';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#111;font-family:system-ui,-apple-system,sans-serif;margin:0;padding:40px 16px;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="padding:24px 32px;text-align:center;">
      <img src="${siteUrl}/img/brand/logo-white.png" alt="Calicchia Design" height="28" style="display:inline-block;" />
    </div>
    <div style="background:#0a0a1a;color:#e5e5e5;padding:40px 32px;border-radius:16px;border:1px solid #1a1a2e;">
      ${body}
    </div>
    <div style="padding:24px 32px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#555;">
        <a href="${siteUrl}" style="color:#666;text-decoration:none;">calicchia.design</a>
        &nbsp;·&nbsp;
        <a href="${siteUrl}/privacy-policy" style="color:#666;text-decoration:none;">Privacy Policy</a>
      </p>
    </div>
  </div>
</body></html>`;
}

// Preview aggregated customer portal data for admin
portalAdmin.get('/preview/:customer_id', async (c) => {
  const customerId = c.req.param('customer_id');
  if (!/^[a-f0-9-]{36}$/i.test(customerId)) {
    return c.json({ error: 'customer_id non valido' }, 400);
  }

  const [customer] = await sql`
    SELECT id, email, contact_name, company_name, status, created_at
    FROM customers
    WHERE id = ${customerId}
    LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!customer) return c.json({ error: 'Cliente non trovato' }, 404);

  const projectRows = await sql`
    SELECT
      cp.id, cp.name, cp.status, cp.progress_percentage,
      cp.client_notes, cp.project_category, cp.visible_to_client,
      cp.created_at
    FROM client_projects cp
    WHERE cp.customer_id = ${customerId}
    ORDER BY cp.created_at DESC
  ` as Array<Record<string, unknown>>;

  const scheduleRows = await sql`
    SELECT
      ps.id, ps.title, ps.schedule_type, ps.amount, ps.currency,
      ps.due_date, ps.status, ps.paid_amount, ps.paid_at,
      jsonb_build_object('id', cp.id, 'name', cp.name) AS project,
      jsonb_build_object('id', q.id, 'quote_number', q.quote_number, 'title', q.title) AS quote,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', pl.id, 'provider', pl.provider,
            'checkout_url', pl.checkout_url, 'status', pl.status,
            'amount', pl.amount, 'currency', pl.currency
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
    GROUP BY ps.id, cp.id, q.id
    ORDER BY ps.due_date ASC NULLS LAST
  ` as Array<Record<string, unknown>>;

  const invoiceRows = await sql`
    SELECT id, invoice_number, status, subtotal, tax_amount, total,
           issue_date, due_date, payment_status, line_items, created_at,
           sdi_status, sdi_xml_generated_at, sdi_xml_filename
    FROM invoices
    WHERE customer_id = ${customerId}
    ORDER BY issue_date DESC NULLS LAST
  ` as Array<Record<string, unknown>>;

  const numberOrNull = (value: unknown): number | null => (
    value === null || value === undefined ? null : Number(value)
  );

  const projects = projectRows.map((project) => ({
    ...project,
    progress_percentage: numberOrNull(project.progress_percentage),
  }));

  const schedules = scheduleRows.map((schedule) => ({
    ...schedule,
    amount: numberOrNull(schedule.amount),
    paid_amount: numberOrNull(schedule.paid_amount),
    payment_links: Array.isArray(schedule.payment_links)
      ? schedule.payment_links.map((link) => {
        const paymentLink = link as Record<string, unknown>;
        return {
          ...paymentLink,
          amount: numberOrNull(paymentLink.amount),
        };
      })
      : [],
  }));

  const invoices = invoiceRows.map((invoice) => ({
    ...invoice,
    subtotal: numberOrNull(invoice.subtotal),
    tax_amount: numberOrNull(invoice.tax_amount),
    total: numberOrNull(invoice.total),
  }));

  const summary = {
    projects_total: projects.length,
    projects_visible: projects.filter((p: Record<string, unknown>) => p.visible_to_client).length,
    schedules_total: schedules.length,
    schedules_paid: schedules.filter((s: Record<string, unknown>) => s.status === 'paid').length,
    invoices_total: invoices.length,
    invoices_total_amount: invoices.reduce((sum: number, i: Record<string, unknown>) => sum + Number(i.total || 0), 0),
  };

  return c.json({
    customer,
    projects,
    schedules,
    invoices,
    summary,
  });
});

// ── Create timeline event manually ───────────────────────
portalAdmin.post('/timeline-event', async (c) => {
  const { project_id, customer_id, type, title, description, action_required, action_type, action_target_id } = await c.req.json();

  if (!project_id || !customer_id || !type || !title) {
    fail('project_id, customer_id, type e title richiesti', 400);
  }

  const validTypes = [
    'status_change', 'deliverable_added', 'deliverable_approved', 'deliverable_rejected',
    'file_uploaded', 'file_requested', 'message', 'invoice_sent', 'invoice_paid', 'note',
  ];
  if (!validTypes.includes(type)) fail('Tipo evento non valido', 400);

  const [event] = await sql`
    INSERT INTO timeline_events (project_id, customer_id, type, title, description, action_required, action_type, action_target_id, actor_type)
    VALUES (${project_id}, ${customer_id}, ${type}, ${title}, ${description || null}, ${action_required || false}, ${action_type || null}, ${action_target_id || null}, 'admin')
    RETURNING id, type, title, created_at
  ` as Array<Record<string, unknown>>;

  return c.json({ event }, 201);
});

// ── Request material from client ─────────────────────────
portalAdmin.post('/request-material/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const { title, description } = await c.req.json();

  const [project] = await sql`
    SELECT cp.id, cp.customer_id, cp.name, cu.contact_name, cu.email, cu.company_name
    FROM client_projects cp
    JOIN customers cu ON cu.id = cp.customer_id
    WHERE cp.id = ${projectId}
    LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!project) fail('Progetto non trovato', 404);

  const custId = String(project.customer_id);
  const reqTitle = title || 'Materiale richiesto';

  const [event] = await sql`
    INSERT INTO timeline_events (project_id, customer_id, type, title, description, action_required, action_type, actor_type)
    VALUES (${projectId}, ${custId}, 'file_requested', ${reqTitle}, ${description || null}, true, 'upload', 'admin')
    RETURNING id, type, title, created_at
  ` as Array<Record<string, unknown>>;

  // Send email notification (standard transport — SMTP)
  try {
    const { sendEmail } = await import('../lib/email');
    const { renderMaterialRequestEmail } = await import('../templates/material-request');
    if (project.email) {
      const portalUrl = process.env.PORTAL_URL || process.env.SITE_URL || 'https://calicchia.design';
      const { subject, html, text } = await renderMaterialRequestEmail({
        contactName: project.contact_name as string,
        projectName: project.name as string,
        title: title || 'Materiale richiesto',
        description: description ?? null,
        uploadUrl: `${portalUrl}/clienti/upload`,
      });
      await sendEmail({ to: project.email as string, subject, html, text });
    }
  } catch { /* non-blocking */ }

  return c.json({ event }, 201);
});

// ── Publish a monthly report ─────────────────────────────
portalAdmin.post('/reports', async (c) => {
  const { customer_id, project_id, month, year, title, summary, data, pdf_url } = await c.req.json();

  if (!customer_id || !month || !year || !title) {
    fail('customer_id, month, year e title richiesti', 400);
  }

  const [report] = await sql`
    INSERT INTO portal_reports (customer_id, project_id, month, year, title, summary, data, pdf_url, published_at)
    VALUES (${customer_id}, ${project_id || null}, ${month}, ${year}, ${title}, ${summary || null}, ${JSON.stringify(data || {})}, ${pdf_url || null}, NOW())
    ON CONFLICT (customer_id, year, month) DO UPDATE SET
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      data = EXCLUDED.data,
      pdf_url = EXCLUDED.pdf_url,
      published_at = NOW()
    RETURNING id, title, published_at
  ` as Array<Record<string, unknown>>;

  // Create timeline event for each project of this customer (or generic)
  if (project_id) {
    await sql`
      INSERT INTO timeline_events (project_id, customer_id, type, title, description, actor_type)
      VALUES (${project_id}, ${customer_id}, 'note', ${'Report pubblicato: ' + title}, ${summary || null}, 'admin')
    `;
  }

  // Send email notification (standard transport — SMTP)
  try {
    const [customer] = await sql`SELECT email, contact_name FROM customers WHERE id = ${customer_id} LIMIT 1` as Array<{ email: string; contact_name: string }>;
    if (customer?.email) {
      const { sendEmail } = await import('../lib/email');
      const { renderReportPublishedEmail } = await import('../templates/report-published');
      const portalUrl = process.env.PORTAL_URL || process.env.SITE_URL || 'https://calicchia.design';
      const period = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' })
        .format(new Date(Number(year), Number(month) - 1, 1));
      const { subject, html, text } = await renderReportPublishedEmail({
        contactName: customer.contact_name,
        reportTitle: title,
        period,
        summary: summary ?? null,
        reportUrl: `${portalUrl}/clienti/report/${report.id}`,
      });
      await sendEmail({ to: customer.email, subject, html, text });
    }
  } catch { /* non-blocking */ }

  return c.json({ report }, 201);
});

// ── List timeline events for a project (admin view) ──────
portalAdmin.get('/timeline/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const limit = Math.min(100, Number(c.req.query('limit') || '50'));

  const events = await sql`
    SELECT id, type, title, description, action_required, action_type,
           action_target_id, is_read, actor_type, created_at
    FROM timeline_events
    WHERE project_id = ${projectId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  ` as Array<Record<string, unknown>>;

  return c.json({ events });
});

// ── List reports for a customer (admin view) ─────────────
portalAdmin.get('/reports/:customerId', async (c) => {
  const customerId = c.req.param('customerId');

  const reports = await sql`
    SELECT id, title, month, year, summary, pdf_url, published_at, project_id
    FROM portal_reports
    WHERE customer_id = ${customerId}
    ORDER BY year DESC, month DESC
  ` as Array<Record<string, unknown>>;

  return c.json({ reports });
});

// ── Translations CRUD (bilingual portal content) ─────────
// Maps entity table → (translation sidecar table, primary-key column,
// allowed field names). Keep in sync with migration 078.
const TRANSLATION_TABLES = {
  client_projects: {
    sidecar: 'client_projects_translations',
    pk: 'project_id',
    fields: new Set(['name', 'description', 'client_notes']),
  },
  timeline_events: {
    sidecar: 'timeline_events_translations',
    pk: 'event_id',
    fields: new Set(['title', 'description']),
  },
  project_milestones: {
    sidecar: 'project_milestones_translations',
    pk: 'milestone_id',
    fields: new Set(['name', 'description']),
  },
  project_deliverables: {
    sidecar: 'project_deliverables_translations',
    pk: 'deliverable_id',
    fields: new Set(['title', 'description']),
  },
  portal_reports: {
    sidecar: 'portal_reports_translations',
    pk: 'report_id',
    fields: new Set(['title', 'summary']),
  },
  subscriptions: {
    sidecar: 'subscriptions_translations',
    pk: 'subscription_id',
    fields: new Set(['name', 'description']),
  },
} as const;

type TranslationEntity = keyof typeof TRANSLATION_TABLES;
const SUPPORTED_LOCALES = new Set(['it', 'en']);

// GET /api/portal-admin/translations/:entity/:id
// Returns: { it: {field: value, ...}, en: {field: value, ...} }
portalAdmin.get('/translations/:entity/:id', async (c) => {
  const entity = c.req.param('entity') as TranslationEntity;
  const id = c.req.param('id');
  const config = TRANSLATION_TABLES[entity];
  if (!config) fail('Entity non supportata', 400);

  const rows = (await sql`
    SELECT locale, field_name, field_value
    FROM ${sql(config.sidecar)}
    WHERE ${sql(config.pk)} = ${id}
  `) as Array<{ locale: string; field_name: string; field_value: string }>;

  const result: Record<string, Record<string, string>> = { it: {}, en: {} };
  for (const r of rows) {
    if (!result[r.locale]) result[r.locale] = {};
    result[r.locale][r.field_name] = r.field_value;
  }
  return c.json(result);
});

// PUT /api/portal-admin/translations/:entity/:id
// Body: { locale: 'it' | 'en', fields: { fieldName: value, ... } }
// Upserts the given fields. Empty/null values delete the row.
portalAdmin.put('/translations/:entity/:id', async (c) => {
  const entity = c.req.param('entity') as TranslationEntity;
  const id = c.req.param('id');
  const body = (await c.req.json()) as {
    locale?: string;
    fields?: Record<string, string | null>;
  };

  const config = TRANSLATION_TABLES[entity];
  if (!config) fail('Entity non supportata', 400);
  if (!body.locale || !SUPPORTED_LOCALES.has(body.locale)) fail('locale richiesto (it|en)', 400);
  if (!body.fields || typeof body.fields !== 'object') fail('fields object richiesto', 400);

  const locale = body.locale;
  const upserts: Array<{ field: string; value: string }> = [];
  const deletes: string[] = [];

  for (const [field, value] of Object.entries(body.fields)) {
    if (!config.fields.has(field)) continue; // silently drop unknown fields
    if (value === null || value === undefined || value === '') {
      deletes.push(field);
    } else {
      upserts.push({ field, value });
    }
  }

  // Run upserts and deletes in sequence (small N, no need for batch).
  for (const { field, value } of upserts) {
    await sql`
      INSERT INTO ${sql(config.sidecar)} (${sql(config.pk)}, locale, field_name, field_value, updated_at)
      VALUES (${id}, ${locale}, ${field}, ${value}, NOW())
      ON CONFLICT (${sql(config.pk)}, locale, field_name)
      DO UPDATE SET field_value = EXCLUDED.field_value, updated_at = NOW()
    `;
  }
  if (deletes.length > 0) {
    await sql`
      DELETE FROM ${sql(config.sidecar)}
      WHERE ${sql(config.pk)} = ${id}
        AND locale = ${locale}
        AND field_name = ANY(${deletes}::text[])
    `;
  }

  return c.json({ ok: true, upserted: upserts.length, deleted: deletes.length });
});
