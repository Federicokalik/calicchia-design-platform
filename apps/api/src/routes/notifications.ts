import { Hono } from 'hono';
import { sql } from '../db';

type Env = { Variables: { user: { id: string; email?: string } } };

export const notifications = new Hono<Env>();

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'adesso';
  if (minutes < 60) return `${minutes} min fa`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h fa`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}g fa`;
  return new Date(dateStr).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

notifications.get('/', async (c) => {
  const user = c.get('user') as { id: string };
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50);
  const offset = parseInt(c.req.query('offset') || '0');
  const unreadOnly = c.req.query('unread_only') === 'true';
  const type = c.req.query('type');

  const unreadFilter = unreadOnly ? sql`AND read_at IS NULL` : sql``;
  const typeFilter = type && type !== 'all' ? sql`AND type = ${type}` : sql``;

  const items = await sql`
    SELECT *, COUNT(*) OVER() AS _total_count
    FROM notifications
    WHERE user_id = ${user.id} AND archived_at IS NULL
    ${unreadFilter} ${typeFilter}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const count = items[0]?._total_count ? parseInt(items[0]._total_count as string) : 0;
  const enriched = items.map((n) => ({ ...n, _total_count: undefined, time_ago: timeAgo(n.created_at as string) }));

  return c.json({ notifications: enriched, count, has_more: (offset + limit) < count });
});

notifications.get('/unread-count', async (c) => {
  const user = c.get('user') as { id: string };

  const [row] = await sql`
    SELECT COUNT(*) AS count FROM notifications
    WHERE user_id = ${user.id} AND read_at IS NULL AND archived_at IS NULL
  `;
  return c.json({ count: parseInt(row.count as string) || 0 });
});

notifications.patch('/:id/read', async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');

  await sql`
    UPDATE notifications SET read_at = NOW()
    WHERE id = ${id} AND user_id = ${user.id} AND read_at IS NULL
  `;
  return c.json({ success: true });
});

notifications.post('/read-all', async (c) => {
  const user = c.get('user') as { id: string };

  await sql`
    UPDATE notifications SET read_at = NOW()
    WHERE user_id = ${user.id} AND read_at IS NULL
  `;
  return c.json({ success: true });
});
