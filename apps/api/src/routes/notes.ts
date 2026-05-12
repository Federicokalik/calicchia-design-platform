import { Hono } from 'hono';
import { sql } from '../db';

export const notes = new Hono();

// GET /api/notes — list with filters (tsvector full-text search)
notes.get('/', async (c) => {
  const tag = c.req.query('tag');
  const source = c.req.query('source');
  const linkedType = c.req.query('linked_type');
  const linkedId = c.req.query('linked_id');
  const search = c.req.query('search');
  const trash = c.req.query('trash') === 'true';
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const tagFilter = tag ? sql`AND ${tag} = ANY(tags)` : sql``;
  const sourceFilter = source ? sql`AND source = ${source}` : sql``;
  const linkedFilter = linkedType && linkedId
    ? sql`AND linked_type = ${linkedType} AND linked_id = ${linkedId}`
    : sql``;
  const deletedFilter = trash
    ? sql`AND deleted_at IS NOT NULL`
    : sql`AND deleted_at IS NULL`;

  // Use tsvector search if available, fallback to ILIKE
  const searchFilter = search
    ? sql`AND search_vector @@ websearch_to_tsquery('italian', ${search})`
    : sql``;
  const searchRank = search
    ? sql`, ts_rank(search_vector, websearch_to_tsquery('italian', ${search})) AS rank`
    : sql``;
  const orderBy = search
    ? sql`ORDER BY rank DESC, updated_at DESC`
    : sql`ORDER BY is_pinned DESC, updated_at DESC`;

  const rows = await sql`
    SELECT id, title, raw_markdown, source, tags, linked_type, linked_id, is_pinned,
           created_at, updated_at, deleted_at,
           LEFT(raw_markdown, 200) AS preview
           ${searchRank}
    FROM notes
    WHERE 1=1 ${deletedFilter} ${tagFilter} ${sourceFilter} ${linkedFilter} ${searchFilter}
    ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM notes
    WHERE 1=1 ${deletedFilter} ${tagFilter} ${sourceFilter} ${linkedFilter} ${searchFilter}
  `;

  return c.json({ notes: rows, count });
});

// GET /api/notes/:id — single note (with full content)
notes.get('/:id', async (c) => {
  const [note] = await sql`SELECT * FROM notes WHERE id = ${c.req.param('id')}`;
  if (!note) return c.json({ error: 'Nota non trovata' }, 404);
  return c.json({ note });
});

// POST /api/notes — create
notes.post('/', async (c) => {
  const body = await c.req.json();
  const { title, content, raw_markdown, source, tags, linked_type, linked_id } = body;

  const [note] = await sql`
    INSERT INTO notes (title, content, raw_markdown, source, tags, linked_type, linked_id)
    VALUES (
      ${title || 'Senza titolo'},
      ${content ? JSON.stringify(content) : null},
      ${raw_markdown || null},
      ${source || 'app'},
      ${tags || []},
      ${linked_type || null},
      ${linked_id || null}
    ) RETURNING *
  `;

  return c.json({ note }, 201);
});

// PUT /api/notes/:id — update (autosave)
notes.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.content !== undefined) updates.content = JSON.stringify(body.content);
  if (body.raw_markdown !== undefined) updates.raw_markdown = body.raw_markdown;
  if (body.tags !== undefined) updates.tags = body.tags;
  if (body.linked_type !== undefined) updates.linked_type = body.linked_type;
  if (body.linked_id !== undefined) updates.linked_id = body.linked_id;
  if (body.is_pinned !== undefined) updates.is_pinned = body.is_pinned;

  const [note] = await sql`UPDATE notes SET ${sql(updates)} WHERE id = ${id} RETURNING *`;
  if (!note) return c.json({ error: 'Nota non trovata' }, 404);
  return c.json({ note });
});

// PATCH /api/notes/:id/pin — toggle pin
notes.patch('/:id/pin', async (c) => {
  const [note] = await sql`
    UPDATE notes SET is_pinned = NOT is_pinned, updated_at = now()
    WHERE id = ${c.req.param('id')} RETURNING id, is_pinned
  `;
  if (!note) return c.json({ error: 'Nota non trovata' }, 404);
  return c.json({ note });
});

// DELETE /api/notes/:id — soft delete
notes.delete('/:id', async (c) => {
  await sql`UPDATE notes SET deleted_at = now() WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

// PATCH /api/notes/:id/restore — restore from trash
notes.patch('/:id/restore', async (c) => {
  const [note] = await sql`
    UPDATE notes SET deleted_at = NULL, updated_at = now()
    WHERE id = ${c.req.param('id')} RETURNING id, title
  `;
  if (!note) return c.json({ error: 'Nota non trovata' }, 404);
  return c.json({ note });
});

// DELETE /api/notes/:id/permanent — hard delete
notes.delete('/:id/permanent', async (c) => {
  await sql`DELETE FROM notes WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
