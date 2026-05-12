import { Hono } from 'hono';
import { sql } from '../db';

export const health = new Hono();

health.get('/', async (c) => {
  try {
    await sql`SELECT 1`;
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      checks: { database: 'ok', api: 'ok' },
    });
  } catch (error) {
    return c.json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 503);
  }
});

health.get('/readyz', (c) => {
  return c.json({ ready: true });
});
