import { Hono } from 'hono';
import { sql } from '../db';

export const collaboratorsV2 = new Hono();

collaboratorsV2.get('/', async (c) => {
  const status = c.req.query('status');
  const search = c.req.query('search');
  const statusFilter = status && status !== 'all' ? sql`AND status = ${status}` : sql``;
  const searchFilter = search ? sql`AND (name ILIKE ${'%' + search + '%'} OR company ILIKE ${'%' + search + '%'} OR email ILIKE ${'%' + search + '%'})` : sql``;

  const rows = await sql`SELECT * FROM collaborators WHERE 1=1 ${statusFilter} ${searchFilter} ORDER BY updated_at DESC`;
  return c.json({ collaborators: rows });
});

collaboratorsV2.get('/:id', async (c) => {
  const [row] = await sql`SELECT * FROM collaborators WHERE id = ${c.req.param('id')}`;
  if (!row) return c.json({ error: 'Non trovato' }, 404);
  return c.json({ collaborator: row });
});

collaboratorsV2.post('/', async (c) => {
  const b = await c.req.json();
  const [row] = await sql`
    INSERT INTO collaborators (name, company, email, phone, type, specialization, commission_rate, notes)
    VALUES (${b.name}, ${b.company || null}, ${b.email || null}, ${b.phone || null}, ${b.type || 'partner'}, ${b.specialization || null}, ${b.commission_rate || null}, ${b.notes || null})
    RETURNING *
  `;
  return c.json({ collaborator: row }, 201);
});

collaboratorsV2.put('/:id', async (c) => {
  const b = await c.req.json();
  const [row] = await sql`
    UPDATE collaborators SET
      name = COALESCE(${b.name || null}, name),
      company = ${b.company !== undefined ? b.company : null},
      email = ${b.email !== undefined ? b.email : null},
      phone = ${b.phone !== undefined ? b.phone : null},
      type = COALESCE(${b.type || null}, type),
      specialization = ${b.specialization !== undefined ? b.specialization : null},
      commission_rate = ${b.commission_rate !== undefined ? b.commission_rate : null},
      notes = ${b.notes !== undefined ? b.notes : null},
      status = COALESCE(${b.status || null}, status),
      updated_at = now()
    WHERE id = ${c.req.param('id')}
    RETURNING *
  `;
  if (!row) return c.json({ error: 'Non trovato' }, 404);
  return c.json({ collaborator: row });
});

collaboratorsV2.delete('/:id', async (c) => {
  await sql`DELETE FROM collaborators WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

collaboratorsV2.get('/:id/projects', async (c) => {
  const rows = await sql`
    SELECT cp.*, c.contact_name AS customer_name
    FROM client_projects cp
    LEFT JOIN customers c ON c.id = cp.customer_id
    WHERE cp.collaborator_id = ${c.req.param('id')}
    ORDER BY cp.updated_at DESC
  `;
  return c.json({ projects: rows });
});
