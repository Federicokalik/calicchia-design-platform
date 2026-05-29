import { Hono } from 'hono';
import { sql } from '../../db';
import { applyTranslations, getRequestLocale } from '../../lib/portal-i18n';
import { portalAuth, type PortalEnv } from './auth';

export const projectsRoutes = new Hono<PortalEnv>();

function legacyPreviewProvider(value: unknown): 'netlify' | 'vercel' | 'wordpress' | 'custom' {
  if (typeof value !== 'string') return 'custom';
  let host = '';
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return 'custom';
  }
  if (host.endsWith('.netlify.app') || host.includes('netlify')) return 'netlify';
  if (host.endsWith('.vercel.app') || host.includes('vercel')) return 'vercel';
  if (host.endsWith('.wordpress.com') || host.includes('wpengine') || host.includes('wordpress')) return 'wordpress';
  return 'custom';
}

function legacyPreview(project: Record<string, unknown>) {
  const stagingUrl = typeof project.staging_url === 'string' ? project.staging_url : '';
  if (!stagingUrl.startsWith('https://')) return null;
  return {
    id: `legacy-staging-${project.id}`,
    project_id: project.id,
    title: 'Staging',
    url: stagingUrl,
    provider: legacyPreviewProvider(stagingUrl),
    status: 'review',
    visible_to_client: true,
    sort_order: 0,
    notes: null,
    created_at: null,
    updated_at: null,
    is_legacy: true,
  };
}

// ── List all projects for this customer ──────────────────
projectsRoutes.get('/', portalAuth, async (c) => {
  const role = c.get('actor_role');
  const actorId = c.get('actor_id');
  const locale = getRequestLocale(c);
  const accessFilter = role === 'collaborator'
    ? sql`cp.collaborator_id = ${actorId}`
    : sql`cp.customer_id = ${c.get('customer_id') as string} AND cp.visible_to_client = true`;

  // client_notes are the customer's PRIVATE annotations to their own project —
  // a collaborator working on the project does not need (and should not see)
  // them. Audit B-015: NULL for collab via CASE so the column shape stays the
  // same and downstream code/translations don't need branching.
  const clientNotesExpr = role === 'collaborator'
    ? sql`NULL::text AS client_notes`
    : sql`cp.client_notes`;

  const projects = (await sql`
    SELECT
      cp.id, cp.name, cp.status, cp.progress_percentage,
      ${clientNotesExpr}, cp.project_type, cp.staging_url,
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
    WHERE ${accessFilter}
    ORDER BY
      CASE cp.status
        WHEN 'in_progress' THEN 1 WHEN 'review' THEN 2
        WHEN 'approved' THEN 3 WHEN 'proposal' THEN 4
        WHEN 'completed' THEN 5 ELSE 6
      END,
      cp.created_at DESC
  `) as Array<Record<string, unknown>>;

  // Exclude client_notes from the translation overlay for collab — otherwise
  // the EN translation row would re-populate the field we just NULL'd above.
  const translatableFields: Array<'name' | 'description' | 'client_notes'> =
    role === 'collaborator'
      ? ['name', 'description']
      : ['name', 'description', 'client_notes'];
  await applyTranslations(
    projects,
    'client_projects_translations',
    'id',
    translatableFields,
    locale
  );

  return c.json({ projects });
});

// ── Project detail ───────────────────────────────────────
projectsRoutes.get('/:id', portalAuth, async (c) => {
  const role = c.get('actor_role');
  const actorId = c.get('actor_id');
  const id = c.req.param('id');
  const locale = getRequestLocale(c);
  const accessFilter = role === 'collaborator'
    ? sql`cp.id = ${id} AND cp.collaborator_id = ${actorId}`
    : sql`cp.id = ${id} AND cp.customer_id = ${c.get('customer_id') as string} AND cp.visible_to_client = true`;

  // Same B-015 gate as in the list endpoint — NULL client_notes for collab.
  const clientNotesExpr = role === 'collaborator'
    ? sql`NULL::text AS client_notes`
    : sql`cp.client_notes`;

  const projectRows = (await sql`
    SELECT
      cp.id, cp.name, cp.description, cp.status, cp.progress_percentage,
      ${clientNotesExpr}, cp.project_type, cp.staging_url, cp.production_url,
      cp.pipeline_steps, cp.current_step,
      cp.start_date, cp.target_end_date, cp.actual_end_date,
      cu.company_name, cu.contact_name
    FROM client_projects cp
    JOIN customers cu ON cu.id = cp.customer_id
    WHERE ${accessFilter}
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  if (projectRows.length === 0) return c.json({ error: 'Progetto non trovato' }, 404);
  const translatableFields: Array<'name' | 'description' | 'client_notes'> =
    role === 'collaborator'
      ? ['name', 'description']
      : ['name', 'description', 'client_notes'];
  await applyTranslations(
    projectRows,
    'client_projects_translations',
    'id',
    translatableFields,
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

  let previews = (await sql`
    SELECT id, project_id, title, url, provider, status, visible_to_client,
           sort_order, notes, created_at, updated_at, false AS is_legacy
    FROM project_previews
    WHERE project_id = ${id} AND visible_to_client = true
    ORDER BY sort_order ASC, created_at ASC
  `) as Array<Record<string, unknown>>;
  if (previews.length === 0) {
    const fallback = legacyPreview(project);
    if (fallback) previews = [fallback];
  }

  return c.json({ project, milestones, deliverables, previews });
});
