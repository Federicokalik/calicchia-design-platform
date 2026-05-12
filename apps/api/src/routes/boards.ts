import { Hono } from 'hono';
import { sql } from '../db';

export const boards = new Hono();

// GET /api/boards — list with filters
boards.get('/', async (c) => {
  const type = c.req.query('type'); // 'sketch' | 'mindmap'
  const linkedType = c.req.query('linked_type');
  const linkedId = c.req.query('linked_id');
  const search = c.req.query('search');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const typeFilter = type ? sql`AND type = ${type}` : sql``;
  const linkedFilter = linkedType && linkedId
    ? sql`AND linked_type = ${linkedType} AND linked_id = ${linkedId}`
    : sql``;
  const searchFilter = search
    ? sql`AND title ILIKE ${'%' + search + '%'}`
    : sql``;

  const trash = c.req.query('trash') === 'true';
  const deletedFilter = trash ? sql`AND deleted_at IS NOT NULL` : sql`AND deleted_at IS NULL`;

  const rows = await sql`
    SELECT id, title, type, thumbnail, linked_type, linked_id, created_at, updated_at, deleted_at
    FROM boards
    WHERE 1=1 ${deletedFilter} ${typeFilter} ${linkedFilter} ${searchFilter}
    ORDER BY updated_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM boards
    WHERE 1=1 ${deletedFilter} ${typeFilter} ${linkedFilter} ${searchFilter}
  `;

  return c.json({ boards: rows, count });
});

// GET /api/boards/:id — single board (with full data)
boards.get('/:id', async (c) => {
  const [board] = await sql`SELECT * FROM boards WHERE id = ${c.req.param('id')}`;
  if (!board) return c.json({ error: 'Board non trovata' }, 404);
  return c.json({ board });
});

// POST /api/boards — create
boards.post('/', async (c) => {
  const body = await c.req.json();
  const { title, type, data, linked_type, linked_id } = body;

  const [board] = await sql`
    INSERT INTO boards (title, type, data, linked_type, linked_id)
    VALUES (
      ${title || 'Senza titolo'},
      ${type || 'sketch'},
      ${JSON.stringify(data || {})},
      ${linked_type || null},
      ${linked_id || null}
    ) RETURNING *
  `;

  return c.json({ board }, 201);
});

// PUT /api/boards/:id — update (autosave)
boards.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.data !== undefined) updates.data = JSON.stringify(body.data);
  if (body.thumbnail !== undefined) updates.thumbnail = body.thumbnail;
  if (body.linked_type !== undefined) updates.linked_type = body.linked_type;
  if (body.linked_id !== undefined) updates.linked_id = body.linked_id;

  const [board] = await sql`UPDATE boards SET ${sql(updates)} WHERE id = ${id} RETURNING *`;
  if (!board) return c.json({ error: 'Board non trovata' }, 404);
  return c.json({ board });
});

// DELETE /api/boards/:id — soft delete
boards.delete('/:id', async (c) => {
  await sql`UPDATE boards SET deleted_at = now() WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

// PATCH /api/boards/:id/restore
boards.patch('/:id/restore', async (c) => {
  const [board] = await sql`
    UPDATE boards SET deleted_at = NULL, updated_at = now()
    WHERE id = ${c.req.param('id')} RETURNING id, title
  `;
  if (!board) return c.json({ error: 'Board non trovata' }, 404);
  return c.json({ board });
});

// DELETE /api/boards/:id/permanent — hard delete
boards.delete('/:id/permanent', async (c) => {
  await sql`DELETE FROM boards WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
