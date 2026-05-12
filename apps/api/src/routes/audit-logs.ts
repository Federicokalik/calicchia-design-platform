import { Hono } from 'hono';
import { sql } from '../db';

export const auditLogs = new Hono();

auditLogs.get('/', async (c) => {
  const tableName = c.req.query('table_name');
  const action = c.req.query('action');
  const search = c.req.query('search');
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const tableFilter = tableName && tableName !== 'all' ? sql`AND table_name = ${tableName}` : sql``;
  const actionFilter = action && action !== 'all' ? sql`AND action = ${action}` : sql``;
  const searchFilter = search ? sql`AND user_email ILIKE ${'%' + search + '%'}` : sql``;
  const fromFilter = dateFrom ? sql`AND created_at >= ${dateFrom}` : sql``;
  const toFilter = dateTo ? sql`AND created_at <= ${dateTo + 'T23:59:59Z'}` : sql``;

  const logs = await sql`
    SELECT *, COUNT(*) OVER() AS _total_count
    FROM audit_logs
    WHERE 1=1 ${tableFilter} ${actionFilter} ${searchFilter} ${fromFilter} ${toFilter}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const count = logs[0]?._total_count ? parseInt(logs[0]._total_count as string) : 0;
  const cleaned = logs.map((l) => ({ ...l, _total_count: undefined }));

  return c.json({ logs: cleaned, count, limit, offset });
});

auditLogs.get('/stats', async (c) => {
  const days = parseInt(c.req.query('days') || '30');

  const stats = await sql`SELECT * FROM get_audit_stats(${days})`;
  return c.json({ stats: stats || [] });
});
