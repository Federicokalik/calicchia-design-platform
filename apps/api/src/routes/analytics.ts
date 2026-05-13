/**
 * analytics.ts — Admin-only analytics dashboard endpoints.
 *
 * Mounted at /api/analytics (in protectedPaths). All endpoints assume an
 * authenticated admin user. No cookies are SET here. No cookies are required
 * by sito-v3's tracker — the ingestion lives in analytics-track.ts at /api/track.
 *
 * Queries are SQL-driven via lib/analytics/queries.ts. Dimensions for breakdowns
 * are validated against the allowlist in lib/analytics/dimensions.ts.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sql, sqlv } from '../db';
import {
  periodFromQuery,
  fetchOverview,
  fetchTimeseries,
  fetchBreakdown,
  fetchRealtime,
  fetchEvents,
  fetchWebVitals,
  fetchGoalConversions,
  fetchFunnel,
  type Granularity,
  type Metric,
  type GoalCondition,
} from '../lib/analytics/queries';
import { resolveDimension, listDimensions } from '../lib/analytics/dimensions';
import { subscribe } from '../lib/analytics/realtime-broadcaster';

export const analytics = new Hono();

const DEFAULT_WEBSITE = 'main';

function getWebsite(c: import('hono').Context): string {
  return c.req.query('site') || DEFAULT_WEBSITE;
}

// ─── Overview (with optional compare to previous period) ─────────────────────

analytics.get('/overview', async (c) => {
  const period = periodFromQuery(c.req.query('period'));
  const compare = c.req.query('compare') === 'true';
  const websiteId = getWebsite(c);

  const current = await fetchOverview(period, websiteId);
  let previous = null as Awaited<ReturnType<typeof fetchOverview>> | null;
  let delta: Record<string, number | null> | null = null;

  if (compare) {
    // Re-query against the previous period of equal length.
    const [prev] = await sql`
      WITH base AS (
        SELECT session_id, visit_id, event_type, duration_ms
        FROM analytics
        WHERE website_id = ${websiteId}
          AND created_at >= NOW() - CAST(${period} AS INTERVAL) - CAST(${period} AS INTERVAL)
          AND created_at <  NOW() - CAST(${period} AS INTERVAL)
      ),
      visits AS (
        SELECT visit_id, COUNT(*) FILTER (WHERE event_type='pageview') AS pv, SUM(duration_ms) AS dur
        FROM base WHERE visit_id IS NOT NULL GROUP BY visit_id
      )
      SELECT
        (SELECT COUNT(*) FROM base WHERE event_type='pageview')::int AS pageviews,
        (SELECT COUNT(DISTINCT session_id) FROM base WHERE session_id IS NOT NULL)::int AS visitors,
        (SELECT COUNT(*) FROM visits)::int AS sessions,
        COALESCE(ROUND(100.0*(SELECT COUNT(*) FROM visits WHERE pv<=1)/NULLIF((SELECT COUNT(*) FROM visits),0),1),0)::float AS bounce_rate,
        COALESCE(ROUND(AVG(dur) FILTER (WHERE dur>0)),0)::int AS avg_duration_ms
      FROM visits
    ` as Array<typeof current>;
    previous = prev || { pageviews: 0, visitors: 0, sessions: 0, bounce_rate: 0, avg_duration_ms: 0 };

    const pct = (cur: number, prev: number) => {
      if (prev === 0) return cur === 0 ? 0 : null; // undefined direction when prev is zero
      return Math.round(((cur - prev) / prev) * 1000) / 10;
    };
    delta = {
      pageviews: pct(current.pageviews, previous.pageviews),
      visitors: pct(current.visitors, previous.visitors),
      sessions: pct(current.sessions, previous.sessions),
      bounce_rate: pct(current.bounce_rate, previous.bounce_rate),
      avg_duration_ms: pct(current.avg_duration_ms, previous.avg_duration_ms),
    };
  }

  return c.json({ current, previous, delta });
});

// ─── Timeseries ──────────────────────────────────────────────────────────────

analytics.get('/timeseries', async (c) => {
  const period = periodFromQuery(c.req.query('period'));
  const granularity = (c.req.query('granularity') === 'hour' ? 'hour' : 'day') as Granularity;
  const metric = (['pageviews', 'visitors', 'sessions'] as Metric[]).includes(
    c.req.query('metric') as Metric,
  )
    ? (c.req.query('metric') as Metric)
    : 'pageviews';
  const compare = c.req.query('compare') === 'true';
  const websiteId = getWebsite(c);

  const series = await fetchTimeseries(period, granularity, metric, websiteId);
  let seriesPrev: Array<{ bucket: string; value: number }> | null = null;
  if (compare) {
    seriesPrev = await fetchTimeseries(period, granularity, metric, websiteId, period);
  }

  return c.json({ series, seriesPrev, period, granularity, metric });
});

// ─── Breakdown ──────────────────────────────────────────────────────────────

analytics.get('/breakdown', async (c) => {
  const dim = resolveDimension(c.req.query('dimension'));
  if (!dim) {
    return c.json(
      { error: 'invalid dimension', allowed: listDimensions().map((d) => d.key) },
      400,
    );
  }
  const period = periodFromQuery(c.req.query('period'));
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10) || 20, 1), 100);
  const eventType = c.req.query('event_type') === 'all' ? 'all' : 'pageview';
  const websiteId = getWebsite(c);

  const rows = await fetchBreakdown(dim.column, period, websiteId, limit, eventType);

  return c.json({
    dimension: c.req.query('dimension'),
    label: dim.label,
    rows: rows.map((r) => ({
      key: r.key,
      label: r.key ?? dim.nullPlaceholder ?? '—',
      pageviews: r.pageviews,
      visitors: r.visitors,
      sessions: r.sessions,
    })),
  });
});

analytics.get('/dimensions', async (c) => {
  return c.json({ dimensions: listDimensions() });
});

// ─── Realtime: polling fallback + SSE stream ────────────────────────────────

analytics.get('/realtime', async (c) => {
  const websiteId = getWebsite(c);
  const data = await fetchRealtime(websiteId);
  return c.json(data);
});

analytics.get('/realtime/stream', async (c) => {
  const websiteId = getWebsite(c);

  // Streaming SSE response. No credentials needed; admin auth has already
  // passed via cookie before reaching this handler.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { /* closed */ }
      };

      // Initial snapshot
      fetchRealtime(websiteId).then((snap) => send('tick', snap)).catch(() => {});

      // Periodic snapshot every 5s
      const interval = setInterval(() => {
        fetchRealtime(websiteId).then((snap) => send('tick', snap)).catch(() => {});
      }, 5000);

      // Live event fan-out (server publishes from /track)
      const unsubscribe = subscribe((evt) => send('event', evt));

      // Heartbeat comment every 30s to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch { /* closed */ }
      }, 30_000);

      // Abort handling
      c.req.raw.signal?.addEventListener('abort', () => {
        clearInterval(interval);
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// ─── Custom events ───────────────────────────────────────────────────────────

analytics.get('/events', async (c) => {
  const period = periodFromQuery(c.req.query('period'));
  const name = c.req.query('name') || undefined;
  const events = await fetchEvents(period, getWebsite(c), name);
  return c.json({ events });
});

// ─── Web Vitals ─────────────────────────────────────────────────────────────

analytics.get('/web-vitals', async (c) => {
  const period = periodFromQuery(c.req.query('period'));
  const page = c.req.query('page') || undefined;
  const metrics = await fetchWebVitals(period, getWebsite(c), page);

  // Annotate with rating thresholds (Core Web Vitals 2024).
  const thresholds: Record<string, { good: number; poor: number }> = {
    LCP: { good: 2500, poor: 4000 },
    INP: { good: 200, poor: 500 },
    CLS: { good: 0.1, poor: 0.25 },
    FCP: { good: 1800, poor: 3000 },
    TTFB: { good: 800, poor: 1800 },
  };
  const enriched = metrics.map((m) => {
    const t = thresholds[m.metric];
    let rating: 'good' | 'needs_improvement' | 'poor' | 'unknown' = 'unknown';
    if (t) {
      rating = m.p75 <= t.good ? 'good' : m.p75 <= t.poor ? 'needs_improvement' : 'poor';
    }
    return { ...m, rating };
  });

  return c.json({ metrics: enriched });
});

// ─── Goals CRUD ──────────────────────────────────────────────────────────────

const goalSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['pageview', 'event', 'funnel']),
  conditions: z.unknown(),
  active: z.boolean().optional(),
});

analytics.get('/goals', async (c) => {
  const period = periodFromQuery(c.req.query('period'));
  const websiteId = getWebsite(c);
  const goals = await sql`
    SELECT id, name, type, conditions, active, created_at
    FROM analytics_goals
    ORDER BY created_at DESC
  ` as Array<{ id: string; name: string; type: string; conditions: unknown; active: boolean; created_at: string }>;

  // Hydrate each with current-period conversions
  const withConv = await Promise.all(
    goals.map(async (g) => {
      const conv = g.active ? await fetchGoalConversions(g.id, period, websiteId) : null;
      return { ...g, conversions: conv?.conversions ?? 0 };
    }),
  );

  return c.json({ goals: withConv });
});

analytics.post('/goals', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = goalSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);

  const [row] = await sql`
    INSERT INTO analytics_goals (name, type, conditions, active)
    VALUES (${parsed.data.name}, ${parsed.data.type}, ${sqlv((parsed.data.conditions || {}) as Record<string, unknown>)}, ${parsed.data.active ?? true})
    RETURNING id, name, type, conditions, active, created_at
  ` as Array<{ id: string }>;
  return c.json({ goal: row });
});

analytics.put('/goals/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = goalSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  const [row] = await sql`
    UPDATE analytics_goals
    SET name = COALESCE(${parsed.data.name ?? null}, name),
        type = COALESCE(${parsed.data.type ?? null}, type),
        conditions = COALESCE(${parsed.data.conditions !== undefined ? sqlv(parsed.data.conditions as Record<string, unknown>) : null}, conditions),
        active = COALESCE(${parsed.data.active ?? null}, active),
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, name, type, conditions, active, created_at
  ` as Array<{ id: string }>;
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ goal: row });
});

analytics.delete('/goals/:id', async (c) => {
  const id = c.req.param('id');
  await sql`DELETE FROM analytics_goals WHERE id = ${id}`;
  return c.json({ success: true });
});

analytics.get('/goals/:id/funnel', async (c) => {
  const id = c.req.param('id');
  const period = periodFromQuery(c.req.query('period'));
  const websiteId = getWebsite(c);

  const [goal] = await sql`
    SELECT id, name, type, conditions FROM analytics_goals WHERE id = ${id}
  ` as Array<{ id: string; name: string; type: string; conditions: { steps?: GoalCondition[] } }>;
  if (!goal) return c.json({ error: 'not found' }, 404);
  if (goal.type !== 'funnel' || !goal.conditions?.steps) {
    return c.json({ error: 'goal is not a funnel' }, 400);
  }

  const steps = await fetchFunnel(goal.conditions.steps as GoalCondition[], period, websiteId);
  return c.json({ goal, steps });
});

// ─── Export (JSON / CSV) ─────────────────────────────────────────────────────

analytics.get('/export', async (c) => {
  const period = periodFromQuery(c.req.query('period'));
  const format = c.req.query('format') === 'csv' ? 'csv' : 'json';
  const websiteId = getWebsite(c);

  const rows = await sql`
    SELECT created_at, event_type, event_name, page_path, referrer_domain,
           utm_source, utm_medium, utm_campaign, browser, os, device_type,
           country, city, session_id, visit_id, event_value, duration_ms
    FROM analytics
    WHERE website_id = ${websiteId}
      AND created_at >= NOW() - CAST(${period} AS INTERVAL)
    ORDER BY created_at DESC
    LIMIT 50000
  ` as Array<Record<string, unknown>>;

  if (format === 'json') {
    return c.json({ rows, count: rows.length });
  }

  // CSV
  const headers = Object.keys(rows[0] || {
    created_at: '', event_type: '', event_name: '', page_path: '', referrer_domain: '',
    utm_source: '', utm_medium: '', utm_campaign: '', browser: '', os: '', device_type: '',
    country: '', city: '', session_id: '', visit_id: '', event_value: '', duration_ms: '',
  });
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'string' ? v : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\n');

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="analytics-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});

// ─── Legacy / GDPR retention endpoints (kept) ───────────────────────────────

analytics.delete('/purge', async (c) => {
  const result = await sql`SELECT purge_old_analytics() AS count` as Array<{ count: number }>;
  return c.json({ deleted: result[0]?.count ?? 0 });
});

analytics.post('/data-retention', async (c) => {
  const [result] = await sql`SELECT run_data_retention() AS summary`;
  return c.json({ retention: (result as { summary: unknown })?.summary ?? {} });
});

// ─── Legacy index endpoint for back-compat with the current admin page ───────
// (will be removed when the admin analytics page rewrite ships)

analytics.get('/', async (c) => {
  const period = periodFromQuery(c.req.query('period'));
  const overview = await fetchOverview(period, DEFAULT_WEBSITE);
  return c.json({
    period: c.req.query('period') || '30d',
    overview: {
      pageViews: overview.pageviews,
      uniqueVisitors: overview.visitors,
      contacts: 0,
      avgPagesPerVisitor: overview.sessions
        ? (overview.pageviews / overview.sessions).toFixed(1)
        : '0',
    },
    blog: { totalPosts: 0, publishedPosts: 0, totalViews: 0 },
    newsletter: { total: 0, confirmed: 0, pending: 0, unsubscribed: 0 },
    topPages: [],
    topReferrers: [],
    devices: { desktop: 0, mobile: 0, tablet: 0 },
  });
});
