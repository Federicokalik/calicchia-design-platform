import { Hono } from 'hono';
import { sql } from '../db';

export const customerNotes = new Hono();

// GET /api/customer-notes?customer_id=xxx
customerNotes.get('/', async (c) => {
  const customerId = c.req.query('customer_id');
  if (!customerId) return c.json({ error: 'customer_id richiesto' }, 400);

  const notes = await sql`
    SELECT * FROM customer_notes
    WHERE customer_id = ${customerId}
    ORDER BY created_at DESC
  `;

  return c.json({ notes });
});

// POST /api/customer-notes
customerNotes.post('/', async (c) => {
  const { customer_id, content, type } = await c.req.json();
  if (!customer_id || !content) return c.json({ error: 'customer_id e content richiesti' }, 400);

  const rows = await sql`
    INSERT INTO customer_notes (customer_id, content, type)
    VALUES (${customer_id}, ${content}, ${type || 'note'})
    RETURNING *
  `;

  return c.json({ note: rows[0] }, 201);
});

// DELETE /api/customer-notes/:id
customerNotes.delete('/:id', async (c) => {
  const { id } = c.req.param();
  await sql`DELETE FROM customer_notes WHERE id = ${id}`;
  return c.json({ success: true });
});
