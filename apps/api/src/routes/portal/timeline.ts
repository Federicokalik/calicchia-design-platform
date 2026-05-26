import { Hono } from 'hono';
import { sql } from '../../db';
import { applyTranslations, getRequestLocale } from '../../lib/portal-i18n';
import { portalAuth, type PortalEnv } from './auth';

export const timelineRoutes = new Hono<PortalEnv>();

// ── Timeline events for a project (paginated) ────────────
timelineRoutes.get('/projects/:id/timeline', portalAuth, async (c) => {
  const role = c.get('actor_role');
  const actorId = c.get('actor_id');
  const customerId = c.get('customer_id') as string | undefined;
  const projectId = c.req.param('id');
  const page = Math.max(1, Number(c.req.query('page') || '1'));
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') || '20')));
  const offset = (page - 1) * limit;

  const accessFilter = role === 'collaborator'
    ? sql`id = ${projectId} AND collaborator_id = ${actorId}`
    : sql`id = ${projectId} AND customer_id = ${customerId as string} AND visible_to_client = true`;

  const [project] = await sql`
    SELECT id, customer_id FROM client_projects
    WHERE ${accessFilter}
    LIMIT 1
  ` as Array<{ id: string; customer_id: string }>;

  if (!project) return c.json({ error: 'Progetto non trovato' }, 404);

  const events = (await sql`
    SELECT id, type, title, description, action_required, action_type,
           action_target_id, is_read, actor_type, created_at
    FROM timeline_events
    WHERE project_id = ${projectId} AND customer_id = ${project.customer_id}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as Array<Record<string, unknown>>;

  await applyTranslations(
    events,
    'timeline_events_translations',
    'id',
    ['title', 'description'],
    getRequestLocale(c)
  );

  const [countResult] = await sql`
    SELECT COUNT(*) AS total FROM timeline_events
    WHERE project_id = ${projectId} AND customer_id = ${project.customer_id}
  ` as Array<{ total: string }>;

  const total = Number(countResult?.total || 0);

  return c.json({
    events,
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  });
});

// ── Mark timeline events as read ─────────────────────────
timelineRoutes.post('/timeline/read', portalAuth, async (c) => {
  if (c.get('actor_role') !== 'client') return c.json({ error: 'Area riservata ai clienti' }, 403);
  const customerId = c.get('customer_id') as string;
  const { event_ids } = await c.req.json() as { event_ids?: string[] };

  if (!event_ids?.length) {
    return c.json({ error: 'event_ids richiesti' }, 400);
  }

  await sql`
    UPDATE timeline_events SET is_read = true
    WHERE id = ANY(${event_ids}) AND customer_id = ${customerId}
  `;

  return c.json({ ok: true });
});
