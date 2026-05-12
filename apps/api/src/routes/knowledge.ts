import { Hono } from 'hono';
import { sql } from '../db';

export const knowledge = new Hono();

// GET /api/knowledge/recent — recent notes + boards combined
knowledge.get('/recent', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 30);

  const notes = await sql`
    SELECT id, title, 'note' AS type, source, updated_at
    FROM notes WHERE deleted_at IS NULL
    ORDER BY updated_at DESC LIMIT ${limit}
  `;

  const boards = await sql`
    SELECT id, title, type, updated_at
    FROM boards WHERE deleted_at IS NULL
    ORDER BY updated_at DESC LIMIT ${limit}
  `;

  // Merge and sort
  const items = [
    ...notes.map((n: any) => ({ id: n.id, title: n.title, kind: 'note', source: n.source, updated_at: n.updated_at })),
    ...boards.map((b: any) => ({ id: b.id, title: b.title, kind: b.type, updated_at: b.updated_at })),
  ].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
   .slice(0, limit);

  return c.json({ items });
});

// GET /api/knowledge/stats
knowledge.get('/stats', async (c) => {
  const [noteCount] = await sql`SELECT COUNT(*)::int AS count FROM notes WHERE deleted_at IS NULL`;
  const [sketchCount] = await sql`SELECT COUNT(*)::int AS count FROM boards WHERE type = 'sketch' AND deleted_at IS NULL`;
  const [mindmapCount] = await sql`SELECT COUNT(*)::int AS count FROM boards WHERE type = 'mindmap' AND deleted_at IS NULL`;

  return c.json({
    notes: noteCount.count,
    sketches: sketchCount.count,
    mindmaps: mindmapCount.count,
    total: noteCount.count + sketchCount.count + mindmapCount.count,
  });
});
