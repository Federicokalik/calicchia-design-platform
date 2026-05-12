import { Hono } from 'hono';
import { sql } from '../db';

export const projectTasks = new Hono();

projectTasks.get('/', async (c) => {
  const status = c.req.query('status');
  const projectId = c.req.query('project_id');
  const customerId = c.req.query('customer_id');
  const assignedTo = c.req.query('assigned_to');
  const search = c.req.query('search');
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const statusFilter = status && status !== 'all' ? sql`AND t.status = ${status}` : sql``;
  const projectFilter = projectId ? sql`AND t.project_id = ${projectId}` : sql``;
  const customerFilter = customerId ? sql`AND p.customer_id = ${customerId}` : sql``;
  const assignedFilter = assignedTo ? sql`AND t.assigned_to = ${assignedTo}` : sql``;
  const searchFilter = search ? sql`AND t.title ILIKE ${'%' + search + '%'}` : sql``;

  const tasks = await sql`
    SELECT t.*, COUNT(*) OVER() AS _total_count,
      p.name AS project_name,
      COALESCE(c.contact_name, c.company_name) AS customer_name,
      pr.email AS assignee_email,
      m.name AS milestone_name
    FROM project_tasks t
    JOIN client_projects p ON p.id = t.project_id
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN profiles pr ON pr.id = t.assigned_to
    LEFT JOIN project_milestones m ON m.id = t.milestone_id
    WHERE 1=1 ${statusFilter} ${projectFilter} ${customerFilter} ${assignedFilter} ${searchFilter}
    ORDER BY t.sort_order ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const count = tasks[0]?._total_count ? parseInt(tasks[0]._total_count as string) : 0;
  const cleaned = tasks.map((t) => ({ ...t, _total_count: undefined }));

  return c.json({ tasks: cleaned, count });
});

projectTasks.get('/by-project/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const milestoneId = c.req.query('milestone_id');

  const milestoneFilter = milestoneId ? sql`AND t.milestone_id = ${milestoneId}` : sql``;

  const tasks = await sql`
    SELECT t.*,
      pr.email AS assignee_email,
      m.name AS milestone_name
    FROM project_tasks t
    LEFT JOIN profiles pr ON pr.id = t.assigned_to
    LEFT JOIN project_milestones m ON m.id = t.milestone_id
    WHERE t.project_id = ${projectId} ${milestoneFilter}
    ORDER BY t.sort_order ASC
  `;

  const grouped: Record<string, Record<string, unknown>[]> = { todo: [], in_progress: [], review: [], done: [], blocked: [] };
  for (const task of tasks) {
    const s = task.status as string;
    if (grouped[s]) grouped[s].push(task);
  }

  return c.json({ tasks, grouped });
});

projectTasks.post('/', async (c) => {
  const body = await c.req.json();

  if (!body.title || !body.project_id) {
    return c.json({ error: 'Titolo e progetto richiesti' }, 400);
  }

  const [maxRow] = await sql`
    SELECT COALESCE(MAX(sort_order), -1) AS max_order
    FROM project_tasks
    WHERE project_id = ${body.project_id} AND status = ${body.status || 'todo'}
  `;
  const sortOrder = (parseInt(maxRow.max_order as string) || -1) + 1;

  const [task] = await sql`INSERT INTO project_tasks ${sql({ ...body, sort_order: sortOrder })} RETURNING *`;
  return c.json({ task }, 201);
});

projectTasks.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [task] = await sql`
    UPDATE project_tasks SET ${sql({ ...body, updated_at: new Date().toISOString() })}
    WHERE id = ${id} RETURNING *
  `;
  return c.json({ task });
});

projectTasks.patch('/reorder', async (c) => {
  const { tasks } = await c.req.json() as { tasks: { id: string; sort_order: number; status?: string }[] };

  if (!tasks?.length) return c.json({ error: 'Tasks richiesti' }, 400);

  const errors: string[] = [];
  for (const t of tasks) {
    const update: Record<string, unknown> = { sort_order: t.sort_order };
    if (t.status) update.status = t.status;
    try {
      await sql`UPDATE project_tasks SET ${sql(update)} WHERE id = ${t.id}`;
    } catch {
      errors.push(t.id);
    }
  }

  if (errors.length) return c.json({ success: false, errors }, 500);
  return c.json({ success: true });
});

projectTasks.patch('/:id/status', async (c) => {
  const id = c.req.param('id');
  const { status, sort_order } = await c.req.json();

  if (!status) return c.json({ error: 'Status richiesto' }, 400);

  const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (sort_order !== undefined) update.sort_order = sort_order;

  const [task] = await sql`UPDATE project_tasks SET ${sql(update)} WHERE id = ${id} RETURNING *`;
  return c.json({ task });
});

projectTasks.delete('/:id', async (c) => {
  await sql`DELETE FROM project_tasks WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
