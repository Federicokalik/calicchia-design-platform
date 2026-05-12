import { Hono } from 'hono';
import { sql } from '../../db';
import { applyTranslations, getRequestLocale } from '../../lib/portal-i18n';
import { portalAuth, type PortalEnv } from './auth';

export const reportsRoutes = new Hono<PortalEnv>();

// ── List published reports ───────────────────────────────
reportsRoutes.get('/', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const locale = getRequestLocale(c);

  try {
    const reports = (await sql`
      SELECT pr.id, pr.title, pr.month, pr.year, pr.summary, pr.pdf_url, pr.published_at,
             pr.project_id, cp.name AS project_name
      FROM portal_reports pr
      LEFT JOIN client_projects cp ON cp.id = pr.project_id
      WHERE pr.customer_id = ${customerId}
        AND pr.published_at IS NOT NULL
      ORDER BY pr.year DESC, pr.month DESC
    `) as Array<Record<string, unknown>>;

    await applyTranslations(
      reports,
      'portal_reports_translations',
      'id',
      ['title', 'summary'],
      locale
    );

    return c.json({ reports });
  } catch (err: unknown) {
    console.error('Portal reports error:', err);
    return c.json({ error: 'Errore recupero report' }, 500);
  }
});

// ── Report detail with chart data ────────────────────────
reportsRoutes.get('/:id', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const reportId = c.req.param('id');
  const locale = getRequestLocale(c);

  const reports = (await sql`
    SELECT pr.id, pr.title, pr.month, pr.year, pr.summary, pr.data,
           pr.pdf_url, pr.published_at, pr.project_id,
           cp.name AS project_name
    FROM portal_reports pr
    LEFT JOIN client_projects cp ON cp.id = pr.project_id
    WHERE pr.id = ${reportId}
      AND pr.customer_id = ${customerId}
      AND pr.published_at IS NOT NULL
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  if (reports.length === 0) return c.json({ error: 'Report non trovato' }, 404);

  await applyTranslations(
    reports,
    'portal_reports_translations',
    'id',
    ['title', 'summary'],
    locale
  );

  return c.json({ report: reports[0] });
});
