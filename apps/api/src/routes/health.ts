import { Hono } from 'hono';
import { sql } from '../db';
import { readKbMetadata } from '../lib/agent/kb-bootstrap';

export const health = new Hono();

/** A knowledge base older than this is reported as stale (degraded). */
const KB_STALE_DAYS = 30;
const DAY_MS = 86_400_000;

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

/**
 * Knowledge-base freshness probe. The KB is delivered out-of-band (MEGA S4 in
 * production, on-disk in dev), so it can silently go stale relative to the
 * running image. Reports `degraded` when the KB is empty or older than
 * KB_STALE_DAYS — always HTTP 200, so it never triggers a container restart.
 */
health.get('/kb', (c) => {
  const meta = readKbMetadata();
  const ageDays =
    meta.latest_modified === null
      ? null
      : Math.floor((Date.now() - new Date(meta.latest_modified).getTime()) / DAY_MS);
  const stale = ageDays !== null && ageDays > KB_STALE_DAYS;
  const empty = meta.file_count === 0;

  return c.json({
    status: stale || empty ? 'degraded' : 'healthy',
    source: meta.source,
    file_count: meta.file_count,
    latest_modified: meta.latest_modified,
    age_days: ageDays,
    stale,
    stale_threshold_days: KB_STALE_DAYS,
    loaded_at: meta.loaded_at ?? null,
    timestamp: new Date().toISOString(),
  });
});
