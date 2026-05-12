import { Hono } from 'hono';
import { sql } from '../db';

export const projectComments = new Hono();

projectComments.get('/', async (c) => {
  const projectId = c.req.query('project_id');
  const taskId = c.req.query('task_id');

  let filter;
  if (taskId) {
    filter = sql`WHERE pc.task_id = ${taskId}`;
  } else if (projectId) {
    filter = sql`WHERE pc.project_id = ${projectId} AND pc.task_id IS NULL`;
  } else {
    filter = sql`WHERE 1=1`;
  }

  const rows = await sql`
    SELECT pc.*, p.email AS user_email
    FROM project_comments pc
    LEFT JOIN profiles p ON p.id = pc.user_id
    ${filter}
    ORDER BY pc.created_at ASC
  `;

  return c.json({ comments: rows });
});

projectComments.post('/', async (c) => {
  const body = await c.req.json();

  if (!body.project_id || !body.user_id || !body.content) {
    return c.json({ error: 'project_id, user_id e content richiesti' }, 400);
  }

  const rows = await sql`
    INSERT INTO project_comments ${sql(body)}
    RETURNING *, (SELECT email FROM profiles WHERE id = ${body.user_id}) AS user_email
  `;

  return c.json({ comment: rows[0] }, 201);
});

projectComments.put('/:id', async (c) => {
  const id = c.req.param('id');
  const { content } = await c.req.json();
  const [comment] = await sql`
    UPDATE project_comments SET content = ${content}, updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;
  return c.json({ comment });
});

projectComments.delete('/:id', async (c) => {
  await sql`DELETE FROM project_comments WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
