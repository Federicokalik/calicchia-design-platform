import { Hono } from 'hono';
import { sql } from '../../db';
import { applyTranslations, getRequestLocale } from '../../lib/portal-i18n';
import { portalAuth, type PortalEnv } from './auth';

export const projectsRoutes = new Hono<PortalEnv>();

// ── List all projects for this customer ──────────────────
projectsRoutes.get('/', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const locale = getRequestLocale(c);

  const projects = (await sql`
    SELECT
      cp.id, cp.name, cp.status, cp.progress_percentage,
      cp.client_notes, cp.project_type, cp.staging_url,
      cp.pipeline_steps, cp.current_step,
      cp.start_date, cp.target_end_date,
      cu.company_name, cu.contact_name,
      (SELECT COUNT(*) FROM project_deliverables pd
       WHERE pd.project_id = cp.id AND pd.status = 'client_review') AS pending_deliverables,
      (SELECT COUNT(*) FROM project_comments pc
       WHERE pc.project_id = cp.id AND pc.is_read = false
       AND pc.customer_id IS NULL AND pc.is_internal = false) AS unread_messages
    FROM client_projects cp
    JOIN customers cu ON cu.id = cp.customer_id
    WHERE cp.customer_id = ${customerId}
      AND cp.visible_to_client = true
    ORDER BY
      CASE cp.status
        WHEN 'in_progress' THEN 1 WHEN 'review' THEN 2
        WHEN 'approved' THEN 3 WHEN 'proposal' THEN 4
        WHEN 'completed' THEN 5 ELSE 6
      END,
      cp.created_at DESC
  `) as Array<Record<string, unknown>>;

  await applyTranslations(
    projects,
    'client_projects_translations',
    'id',
    ['name', 'description', 'client_notes'],
    locale
  );

  return c.json({ projects });
});

// ── Project detail ───────────────────────────────────────
projectsRoutes.get('/:id', portalAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const id = c.req.param('id');
  const locale = getRequestLocale(c);

  const projectRows = (await sql`
    SELECT
      cp.id, cp.name, cp.description, cp.status, cp.progress_percentage,
      cp.client_notes, cp.project_type, cp.staging_url, cp.production_url,
      cp.pipeline_steps, cp.current_step,
      cp.start_date, cp.target_end_date, cp.actual_end_date,
      cu.company_name, cu.contact_name
    FROM client_projects cp
    JOIN customers cu ON cu.id = cp.customer_id
    WHERE cp.id = ${id}
      AND cp.customer_id = ${customerId}
      AND cp.visible_to_client = true
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  if (projectRows.length === 0) return c.json({ error: 'Progetto non trovato' }, 404);
  await applyTranslations(
    projectRows,
    'client_projects_translations',
    'id',
    ['name', 'description', 'client_notes'],
    locale
  );
  const [project] = projectRows;

  // Milestones
  const milestones = (await sql`
    SELECT id, name, description, status, due_date, completed_at, sort_order
    FROM project_milestones
    WHERE project_id = ${id} AND visible_to_client = true
    ORDER BY sort_order ASC, created_at ASC
  `) as Array<Record<string, unknown>>;
  await applyTranslations(
    milestones,
    'project_milestones_translations',
    'id',
    ['name', 'description'],
    locale
  );

  // Deliverables (all statuses visible to client, not just approved)
  const deliverables = (await sql`
    SELECT
      pd.id, pd.title, pd.description, pd.deliverable_type,
      pd.status, pd.revision_count, pd.revision_limit,
      pd.due_date, pd.delivered_at, pd.approved_at,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', dv.id,
            'file_url', dv.file_url,
            'file_name', dv.file_name,
            'preview_url', dv.preview_url,
            'version_number', dv.version_number,
            'is_current', dv.is_current,
            'notes', dv.notes,
            'uploaded_at', dv.uploaded_at
          ) ORDER BY dv.version_number DESC
        ) FILTER (WHERE dv.id IS NOT NULL),
        '[]'
      ) AS versions
    FROM project_deliverables pd
    LEFT JOIN deliverable_versions dv ON dv.deliverable_id = pd.id
    WHERE pd.project_id = ${id}
    GROUP BY pd.id
    ORDER BY pd.sort_order ASC, pd.created_at ASC
  `) as Array<Record<string, unknown>>;
  await applyTranslations(
    deliverables,
    'project_deliverables_translations',
    'id',
    ['title', 'description'],
    locale
  );

  return c.json({ project, milestones, deliverables });
});
