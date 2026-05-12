import { Hono } from 'hono';
import { sql } from '../db';

export const timeEntries = new Hono();

timeEntries.get('/', async (c) => {
  const projectId = c.req.query('project_id');
  const taskId = c.req.query('task_id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const projectFilter = projectId ? sql`AND project_id = ${projectId}` : sql``;
  const taskFilter = taskId ? sql`AND task_id = ${taskId}` : sql``;

  const entries = await sql`
    SELECT *, COUNT(*) OVER() AS _total_count
    FROM time_entries_view
    WHERE 1=1 ${projectFilter} ${taskFilter}
    ORDER BY start_time DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const count = entries[0]?._total_count ? parseInt(entries[0]._total_count as string) : 0;
  const totalMinutes = entries.reduce((sum, e) => sum + ((e.duration_minutes as number) || 0), 0);
  const billableMinutes = entries.reduce((sum, e) => sum + (e.is_billable ? ((e.duration_minutes as number) || 0) : 0), 0);
  const cleaned = entries.map((e) => ({ ...e, _total_count: undefined }));

  return c.json({ entries: cleaned, count, totalMinutes, billableMinutes });
});

timeEntries.get('/timer/active', async (c) => {
  const userId = c.req.query('user_id');
  if (!userId) return c.json({ error: 'user_id richiesto' }, 400);

  const rows = await sql`
    SELECT t.*, p.name AS project_name, pt.title AS task_title
    FROM time_entries t
    LEFT JOIN client_projects p ON p.id = t.project_id
    LEFT JOIN project_tasks pt ON pt.id = t.task_id
    WHERE t.user_id = ${userId} AND t.end_time IS NULL
    ORDER BY t.start_time DESC
    LIMIT 1
  `;

  return c.json({ entry: rows[0] || null });
});

timeEntries.post('/', async (c) => {
  const body = await c.req.json();

  if (!body.project_id || !body.user_id || !body.start_time) {
    return c.json({ error: 'project_id, user_id e start_time richiesti' }, 400);
  }

  const [entry] = await sql`INSERT INTO time_entries ${sql(body)} RETURNING *`;
  return c.json({ entry }, 201);
});

timeEntries.post('/timer/start', async (c) => {
  const { project_id, task_id, user_id, description } = await c.req.json();

  if (!project_id || !user_id) {
    return c.json({ error: 'project_id e user_id richiesti' }, 400);
  }

  const [running] = await sql`
    SELECT id FROM time_entries WHERE user_id = ${user_id} AND end_time IS NULL LIMIT 1
  `;
  if (running) {
    return c.json({ error: 'Timer già in corso. Fermalo prima di avviarne uno nuovo.' }, 409);
  }

  const [entry] = await sql`
    INSERT INTO time_entries ${sql({
      project_id,
      task_id: task_id || null,
      user_id,
      start_time: new Date().toISOString(),
      description: description || null,
      is_billable: true,
    })} RETURNING *
  `;
  return c.json({ entry }, 201);
});

timeEntries.post('/timer/stop', async (c) => {
  const { user_id } = await c.req.json();
  if (!user_id) return c.json({ error: 'user_id richiesto' }, 400);

  const [running] = await sql`
    SELECT id FROM time_entries
    WHERE user_id = ${user_id} AND end_time IS NULL
    ORDER BY start_time DESC LIMIT 1
  `;
  if (!running) return c.json({ error: 'Nessun timer in corso' }, 404);

  const [entry] = await sql`
    UPDATE time_entries SET end_time = NOW() WHERE id = ${running.id} RETURNING *
  `;
  return c.json({ entry });
});

timeEntries.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [entry] = await sql`UPDATE time_entries SET ${sql(body)} WHERE id = ${id} RETURNING *`;
  return c.json({ entry });
});

timeEntries.delete('/:id', async (c) => {
  await sql`DELETE FROM time_entries WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
