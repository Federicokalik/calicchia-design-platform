import { Hono } from 'hono';
import { sql } from '../db';

export const milestones = new Hono();

milestones.get('/by-project/:projectId', async (c) => {
  const rows = await sql`
    SELECT * FROM project_milestones
    WHERE project_id = ${c.req.param('projectId')}
    ORDER BY sort_order ASC
  `;
  return c.json({ milestones: rows });
});

milestones.post('/', async (c) => {
  const body = await c.req.json();

  if (!body.name || !body.project_id) {
    return c.json({ error: 'Nome e progetto richiesti' }, 400);
  }

  const [maxRow] = await sql`
    SELECT COALESCE(MAX(sort_order), -1) AS max_order
    FROM project_milestones WHERE project_id = ${body.project_id}
  `;
  const sortOrder = (parseInt(maxRow.max_order as string) || -1) + 1;

  const [milestone] = await sql`
    INSERT INTO project_milestones ${sql({ ...body, sort_order: sortOrder })} RETURNING *
  `;
  return c.json({ milestone }, 201);
});

milestones.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [milestone] = await sql`
    UPDATE project_milestones SET ${sql({ ...body, updated_at: new Date().toISOString() })}
    WHERE id = ${id} RETURNING *
  `;
  return c.json({ milestone });
});

milestones.delete('/:id', async (c) => {
  await sql`DELETE FROM project_milestones WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
