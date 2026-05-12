import { Hono } from 'hono';
import { sql } from '../db';

export const brain = new Hono();

// GET /api/brain/conversations
brain.get('/conversations', async (c) => {
  const search = c.req.query('search');
  const channel = c.req.query('channel');
  const limit = Math.min(parseInt(c.req.query('limit') || '30'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const searchFilter = search
    ? sql`AND (summary ILIKE ${'%' + search + '%'} OR messages::text ILIKE ${'%' + search + '%'})`
    : sql``;
  const channelFilter = channel ? sql`AND channel = ${channel}` : sql``;

  const rows = await sql`
    SELECT id, summary, channel, context, messages, tags, created_at, ended_at
    FROM brain_conversations
    WHERE 1=1 ${searchFilter} ${channelFilter}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM brain_conversations
    WHERE 1=1 ${searchFilter} ${channelFilter}
  `;

  return c.json({ conversations: rows, count });
});

// GET /api/brain/conversations/:id
brain.get('/conversations/:id', async (c) => {
  const [conv] = await sql`SELECT * FROM brain_conversations WHERE id = ${c.req.param('id')}`;
  if (!conv) return c.json({ error: 'Conversazione non trovata' }, 404);
  return c.json({ conversation: conv });
});

// GET /api/brain/facts
brain.get('/facts', async (c) => {
  const search = c.req.query('search');
  const entityType = c.req.query('entity_type');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  const searchFilter = search ? sql`AND fact ILIKE ${'%' + search + '%'}` : sql``;
  const entityFilter = entityType ? sql`AND entity_type = ${entityType}` : sql``;

  const rows = await sql`
    SELECT id, fact, entity_type, entity_id, confidence, source, source_id, created_at, updated_at
    FROM brain_facts
    WHERE 1=1 ${searchFilter} ${entityFilter}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM brain_facts
    WHERE 1=1 ${searchFilter} ${entityFilter}
  `;

  const categories = await sql`
    SELECT entity_type AS category, COUNT(*)::int AS count
    FROM brain_facts
    GROUP BY entity_type
    ORDER BY count DESC
  `;

  return c.json({ facts: rows, count, categories });
});

// PUT /api/brain/facts/:id
brain.put('/facts/:id', async (c) => {
  const body = await c.req.json();
  const [fact] = await sql`
    UPDATE brain_facts SET fact = ${body.fact}, entity_type = ${body.entity_type || null}, updated_at = now()
    WHERE id = ${c.req.param('id')} RETURNING *
  `;
  if (!fact) return c.json({ error: 'Fatto non trovato' }, 404);
  return c.json({ fact });
});

// DELETE /api/brain/facts/:id
brain.delete('/facts/:id', async (c) => {
  await sql`DELETE FROM brain_facts WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

// GET /api/brain/preferences
brain.get('/preferences', async (c) => {
  const rows = await sql`SELECT * FROM brain_preferences ORDER BY created_at DESC`;
  return c.json({ preferences: rows });
});

// GET /api/brain/overview
brain.get('/overview', async (c) => {
  const [convCount] = await sql`SELECT COUNT(*)::int AS count FROM brain_conversations`;
  const [factCount] = await sql`SELECT COUNT(*)::int AS count FROM brain_facts`;
  const [prefCount] = await sql`SELECT COUNT(*)::int AS count FROM brain_preferences`;
  const [noteCount] = await sql`SELECT COUNT(*)::int AS count FROM notes WHERE deleted_at IS NULL`;
  const [sketchCount] = await sql`SELECT COUNT(*)::int AS count FROM boards WHERE type = 'sketch' AND deleted_at IS NULL`;
  const [mindmapCount] = await sql`SELECT COUNT(*)::int AS count FROM boards WHERE type = 'mindmap' AND deleted_at IS NULL`;

  const recentFacts = await sql`
    SELECT id, fact, entity_type, source, created_at
    FROM brain_facts ORDER BY created_at DESC LIMIT 5
  `;

  const topCategories = await sql`
    SELECT entity_type AS category, COUNT(*)::int AS count
    FROM brain_facts WHERE entity_type IS NOT NULL
    GROUP BY entity_type ORDER BY count DESC LIMIT 8
  `;

  const recentConversations = await sql`
    SELECT id, summary, channel, context, created_at
    FROM brain_conversations ORDER BY created_at DESC LIMIT 5
  `;

  return c.json({
    stats: {
      conversations: convCount.count,
      facts: factCount.count,
      preferences: prefCount.count,
      notes: noteCount.count,
      sketches: sketchCount.count,
      mindmaps: mindmapCount.count,
    },
    recentFacts,
    recentConversations,
    topCategories,
  });
});
