import { Hono } from 'hono';
import { sql } from '../../db';
import { applyTranslations, getRequestLocale } from '../../lib/portal-i18n';
import { portalAuth, type PortalEnv } from './auth';

export const dashboardRoutes = new Hono<PortalEnv>();

dashboardRoutes.get('/', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const locale = getRequestLocale(c);

  // Stats: active projects, pending amount, open invoices
  const [stats] = await sql`
    SELECT
      (SELECT COUNT(*) FROM client_projects
       WHERE customer_id = ${customerId} AND visible_to_client = true
       AND status NOT IN ('completed', 'cancelled', 'on_hold', 'draft')) AS active_projects,
      (SELECT COALESCE(SUM(ps.amount - COALESCE(ps.paid_amount, 0)), 0)
       FROM payment_schedules ps
       WHERE ps.status IN ('pending', 'due', 'overdue')
       AND (ps.project_id IN (SELECT id FROM client_projects WHERE customer_id = ${customerId})
            OR ps.quote_id IN (SELECT id FROM quotes WHERE customer_id = ${customerId}))
      ) AS total_pending,
      (SELECT COUNT(*) FROM invoices
       WHERE customer_id = ${customerId} AND status = 'open') AS open_invoices
  ` as Array<Record<string, unknown>>;

  // Pending actions: timeline events requiring client action
  const pendingActions = (await sql`
    SELECT te.id, te.type, te.title, te.description, te.action_type,
           te.action_target_id, te.project_id, te.created_at,
           cp.name AS project_name
    FROM timeline_events te
    LEFT JOIN client_projects cp ON cp.id = te.project_id
    WHERE te.customer_id = ${customerId}
      AND te.action_required = true
      AND te.is_read = false
    ORDER BY te.created_at DESC
    LIMIT 10
  `) as Array<Record<string, unknown>>;
  await applyTranslations(
    pendingActions,
    'timeline_events_translations',
    'id',
    ['title', 'description'],
    locale
  );

  // Recent activity: last 10 timeline events across all projects
  const recentActivity = (await sql`
    SELECT te.id, te.type, te.title, te.description, te.actor_type,
           te.action_required, te.action_type, te.is_read, te.created_at,
           te.project_id, cp.name AS project_name
    FROM timeline_events te
    LEFT JOIN client_projects cp ON cp.id = te.project_id
    WHERE te.customer_id = ${customerId}
    ORDER BY te.created_at DESC
    LIMIT 10
  `) as Array<Record<string, unknown>>;
  await applyTranslations(
    recentActivity,
    'timeline_events_translations',
    'id',
    ['title', 'description'],
    locale
  );

  return c.json({
    stats: {
      active_projects: Number(stats?.active_projects || 0),
      total_pending: Number(stats?.total_pending || 0),
      open_invoices: Number(stats?.open_invoices || 0),
    },
    pending_actions: pendingActions,
    recent_activity: recentActivity,
  });
});
