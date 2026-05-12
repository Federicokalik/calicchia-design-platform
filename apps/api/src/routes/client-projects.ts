import { Hono } from 'hono';
import { sql } from '../db';

export const clientProjects = new Hono();

clientProjects.get('/', async (c) => {
  const status = c.req.query('status');
  const customerId = c.req.query('customer_id');
  const projectType = c.req.query('type');
  const category = c.req.query('category');
  const search = c.req.query('search');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const statusFilter = status && status !== 'all' ? sql`AND status = ${status}` : sql``;
  const customerFilter = customerId ? sql`AND customer_id = ${customerId}` : sql``;
  const typeFilter = projectType && projectType !== 'all' ? sql`AND project_type = ${projectType}` : sql``;
  const categoryFilter = category && category !== 'all' ? sql`AND project_category = ${category}` : sql``;
  const searchFilter = search
    ? sql`AND (name ILIKE ${'%' + search + '%'} OR customer_name ILIKE ${'%' + search + '%'} OR customer_company ILIKE ${'%' + search + '%'})`
    : sql``;

  const [projects, allProjects] = await Promise.all([
    sql`
      SELECT *, COUNT(*) OVER() AS _total_count
      FROM client_projects_view
      WHERE 1=1 ${statusFilter} ${customerFilter} ${typeFilter} ${categoryFilter} ${searchFilter}
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql`SELECT status, is_overdue FROM client_projects_view`,
  ]);

  const count = projects[0]?._total_count ? parseInt(projects[0]._total_count as string) : 0;
  const cleaned = projects.map((p) => ({ ...p, _total_count: undefined }));

  const stats = {
    total: allProjects.length,
    in_progress: allProjects.filter((p) => p.status === 'in_progress').length,
    completed: allProjects.filter((p) => p.status === 'completed').length,
    overdue: allProjects.filter((p) => p.is_overdue).length,
  };

  return c.json({ projects: cleaned, count, stats });
});

clientProjects.get('/:id', async (c) => {
  const id = c.req.param('id');

  const projectRows = await sql`SELECT * FROM client_projects_view WHERE id = ${id}`;
  if (!projectRows.length) return c.json({ error: 'Progetto non trovato' }, 404);

  const [tasks, milestones] = await Promise.all([
    sql`
      SELECT t.*,
        p.email AS assignee_email,
        m.name AS milestone_name
      FROM project_tasks t
      LEFT JOIN profiles p ON p.id = t.assigned_to
      LEFT JOIN project_milestones m ON m.id = t.milestone_id
      WHERE t.project_id = ${id}
      ORDER BY t.sort_order ASC
    `,
    sql`SELECT * FROM project_milestones WHERE project_id = ${id} ORDER BY sort_order ASC`,
  ]);

  return c.json({ project: projectRows[0], tasks, milestones });
});

clientProjects.post('/', async (c) => {
  const body = await c.req.json();

  if (!body.name || !body.customer_id) {
    return c.json({ error: 'Nome e cliente richiesti' }, 400);
  }

  const [project] = await sql`INSERT INTO client_projects ${sql(body)} RETURNING *`;
  return c.json({ project }, 201);
});

clientProjects.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const [project] = await sql`
    UPDATE client_projects SET ${sql({ ...body, updated_at: new Date().toISOString() })}
    WHERE id = ${id} RETURNING *
  `;
  return c.json({ project });
});

clientProjects.delete('/:id', async (c) => {
  await sql`UPDATE client_projects SET status = 'cancelled' WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
