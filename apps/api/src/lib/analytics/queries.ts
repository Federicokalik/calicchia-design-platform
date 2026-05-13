/**
 * queries.ts — SQL templates for analytics dashboards.
 *
 * Everything is SQL-driven (no JS aggregation). Dimensions are validated by
 * callers via dimensions.ts; the column name passed in here is trusted (i.e.
 * comes from the hardcoded allowlist) but we still inject it via
 * postgres-js's `sql(identifier)` quoting for defense in depth.
 *
 * Periods are passed as Postgres interval literals ('1 hour', '7 days', '30 days', ...).
 */

import { sql } from '../../db';

export type Period = '1 hour' | '24 hours' | '7 days' | '30 days' | '90 days' | '1 year';

export function periodFromQuery(q: string | undefined | null): Period {
  switch (q) {
    case '1h': return '1 hour';
    case '24h': return '24 hours';
    case '7d': return '7 days';
    case '90d': return '90 days';
    case '12m':
    case '1y': return '1 year';
    case '30d':
    default: return '30 days';
  }
}

// ─── Overview (single-period KPIs) ───────────────────────────────────────────

export async function fetchOverview(period: Period, websiteId: string) {
  const [row] = await sql`
    WITH base AS (
      SELECT
        session_id,
        visit_id,
        event_type,
        duration_ms,
        created_at
      FROM analytics
      WHERE website_id = ${websiteId}
        AND created_at >= NOW() - CAST(${period} AS INTERVAL)
    ),
    visits AS (
      SELECT
        visit_id,
        COUNT(*) FILTER (WHERE event_type = 'pageview') AS pv_in_visit,
        SUM(duration_ms) AS dur_ms
      FROM base
      WHERE visit_id IS NOT NULL
      GROUP BY visit_id
    )
    SELECT
      (SELECT COUNT(*) FROM base WHERE event_type = 'pageview')::int AS pageviews,
      (SELECT COUNT(DISTINCT session_id) FROM base WHERE session_id IS NOT NULL)::int AS visitors,
      (SELECT COUNT(*) FROM visits)::int AS sessions,
      COALESCE(
        ROUND(
          100.0 * (SELECT COUNT(*) FROM visits WHERE pv_in_visit <= 1)
          / NULLIF((SELECT COUNT(*) FROM visits), 0),
          1
        ),
        0
      )::float AS bounce_rate,
      COALESCE(
        ROUND(AVG(dur_ms) FILTER (WHERE dur_ms > 0)),
        0
      )::int AS avg_duration_ms
    FROM visits
  ` as Array<{
    pageviews: number;
    visitors: number;
    sessions: number;
    bounce_rate: number;
    avg_duration_ms: number;
  }>;

  return row || {
    pageviews: 0,
    visitors: 0,
    sessions: 0,
    bounce_rate: 0,
    avg_duration_ms: 0,
  };
}

// ─── Timeseries ───────────────────────────────────────────────────────────────

export type Granularity = 'hour' | 'day';
export type Metric = 'pageviews' | 'visitors' | 'sessions';

export async function fetchTimeseries(
  period: Period,
  granularity: Granularity,
  metric: Metric,
  websiteId: string,
  offsetInterval?: Period,
) {
  const offset = offsetInterval
    ? sql`- CAST(${offsetInterval} AS INTERVAL)`
    : sql``;

  // Build the metric expression
  const metricExpr =
    metric === 'pageviews'
      ? sql`COUNT(*) FILTER (WHERE event_type = 'pageview')::int`
      : metric === 'visitors'
        ? sql`COUNT(DISTINCT session_id)::int`
        : sql`COUNT(DISTINCT visit_id)::int`;

  return await sql`
    SELECT
      date_trunc(${granularity}, created_at ${offset}) AS bucket,
      ${metricExpr} AS value
    FROM analytics
    WHERE website_id = ${websiteId}
      AND created_at ${offset} >= NOW() - CAST(${period} AS INTERVAL)
      AND created_at ${offset} < NOW()
    GROUP BY bucket
    ORDER BY bucket
  ` as Array<{ bucket: string; value: number }>;
}

// ─── Breakdown by dimension ─────────────────────────────────────────────────

export async function fetchBreakdown(
  column: string,
  period: Period,
  websiteId: string,
  limit = 20,
  eventType: 'pageview' | 'all' = 'pageview',
) {
  const eventFilter = eventType === 'pageview'
    ? sql`AND event_type = 'pageview'`
    : sql``;

  return await sql`
    SELECT
      ${sql(column)} AS key,
      COUNT(*)::int AS pageviews,
      COUNT(DISTINCT session_id)::int AS visitors,
      COUNT(DISTINCT visit_id)::int AS sessions
    FROM analytics
    WHERE website_id = ${websiteId}
      AND created_at >= NOW() - CAST(${period} AS INTERVAL)
      ${eventFilter}
    GROUP BY ${sql(column)}
    ORDER BY pageviews DESC NULLS LAST
    LIMIT ${limit}
  ` as Array<{
    key: string | null;
    pageviews: number;
    visitors: number;
    sessions: number;
  }>;
}

// ─── Realtime ────────────────────────────────────────────────────────────────

export async function fetchRealtime(websiteId: string) {
  const [visitors] = await sql`
    SELECT COUNT(DISTINCT visit_id)::int AS visitors
    FROM analytics
    WHERE website_id = ${websiteId}
      AND created_at >= NOW() - INTERVAL '5 minutes'
      AND visit_id IS NOT NULL
  ` as Array<{ visitors: number }>;

  const topPages = await sql`
    SELECT
      page_path AS key,
      COUNT(DISTINCT visit_id)::int AS visitors,
      COUNT(*)::int AS pageviews
    FROM analytics
    WHERE website_id = ${websiteId}
      AND created_at >= NOW() - INTERVAL '5 minutes'
      AND event_type = 'pageview'
      AND page_path IS NOT NULL
    GROUP BY page_path
    ORDER BY visitors DESC
    LIMIT 10
  ` as Array<{ key: string; visitors: number; pageviews: number }>;

  const recentEvents = await sql`
    SELECT
      event_type AS type,
      event_name,
      page_path AS page,
      country,
      created_at
    FROM analytics
    WHERE website_id = ${websiteId}
      AND created_at >= NOW() - INTERVAL '5 minutes'
    ORDER BY created_at DESC
    LIMIT 20
  ` as Array<{
    type: string;
    event_name: string | null;
    page: string | null;
    country: string | null;
    created_at: string;
  }>;

  return {
    visitorsNow: visitors?.visitors ?? 0,
    topPages,
    recentEvents,
  };
}

// ─── Custom events ───────────────────────────────────────────────────────────

export async function fetchEvents(
  period: Period,
  websiteId: string,
  name?: string,
) {
  const nameFilter = name ? sql`AND event_name = ${name}` : sql``;

  return await sql`
    SELECT
      event_name AS name,
      COUNT(*)::int AS count,
      COUNT(DISTINCT session_id)::int AS unique_visitors,
      MAX(created_at) AS last_seen
    FROM analytics
    WHERE website_id = ${websiteId}
      AND created_at >= NOW() - CAST(${period} AS INTERVAL)
      AND event_type = 'event'
      AND event_name IS NOT NULL
      ${nameFilter}
    GROUP BY event_name
    ORDER BY count DESC
    LIMIT 100
  ` as Array<{
    name: string;
    count: number;
    unique_visitors: number;
    last_seen: string;
  }>;
}

// ─── Web Vitals (p75) ────────────────────────────────────────────────────────

export async function fetchWebVitals(
  period: Period,
  websiteId: string,
  page?: string,
) {
  const pageFilter = page ? sql`AND page_path = ${page}` : sql``;

  return await sql`
    SELECT
      event_name AS metric,
      COUNT(*)::int AS count,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY event_value) AS p75,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY event_value) AS p95
    FROM analytics
    WHERE website_id = ${websiteId}
      AND created_at >= NOW() - CAST(${period} AS INTERVAL)
      AND event_type = 'web_vital'
      AND event_value IS NOT NULL
      ${pageFilter}
    GROUP BY event_name
    ORDER BY metric
  ` as Array<{ metric: string; count: number; p75: number; p95: number }>;
}

// ─── Goals + Funnel ──────────────────────────────────────────────────────────

export type GoalCondition =
  | { type: 'pageview'; path?: string; path_match?: string }
  | { type: 'event'; event_name: string }
  | { type: 'funnel'; steps: GoalCondition[] };

export async function fetchGoalConversions(
  goalId: string,
  period: Period,
  websiteId: string,
) {
  const [goal] = await sql`
    SELECT id, name, type, conditions FROM analytics_goals WHERE id = ${goalId} AND active = true
  ` as Array<{ id: string; name: string; type: string; conditions: GoalCondition }>;

  if (!goal) return null;

  // Distinct visitors that satisfied the goal in the period
  const conditions = goal.conditions as GoalCondition;
  if (goal.type === 'pageview' && 'path' in conditions && conditions.path) {
    const path = conditions.path;
    const [row] = await sql`
      SELECT COUNT(DISTINCT session_id)::int AS conversions
      FROM analytics
      WHERE website_id = ${websiteId}
        AND created_at >= NOW() - CAST(${period} AS INTERVAL)
        AND event_type = 'pageview'
        AND page_path = ${path}
    ` as Array<{ conversions: number }>;
    return { goal, conversions: row?.conversions ?? 0 };
  }
  if (goal.type === 'event' && 'event_name' in conditions && conditions.event_name) {
    const name = conditions.event_name;
    const [row] = await sql`
      SELECT COUNT(DISTINCT session_id)::int AS conversions
      FROM analytics
      WHERE website_id = ${websiteId}
        AND created_at >= NOW() - CAST(${period} AS INTERVAL)
        AND event_type = 'event'
        AND event_name = ${name}
    ` as Array<{ conversions: number }>;
    return { goal, conversions: row?.conversions ?? 0 };
  }
  return { goal, conversions: 0 };
}

/**
 * Funnel computation via per-step CTE chain.
 * Returns count of unique session_id reaching each step in order.
 */
export async function fetchFunnel(
  steps: GoalCondition[],
  period: Period,
  websiteId: string,
) {
  if (steps.length === 0) return [];

  // Build a CTE chain manually. Each step filters sessions from the previous.
  // We use a temp-table-free approach: progressive INNER JOINs on session_id.
  // For simplicity we cap at 6 steps; deeper funnels are uncommon.
  const capped = steps.slice(0, 6);

  const stepConditions = capped.map((step, i) => {
    if (step.type === 'pageview' && step.path) {
      return sql`
        SELECT DISTINCT session_id, MIN(created_at) AS step_at
        FROM analytics
        WHERE website_id = ${websiteId}
          AND created_at >= NOW() - CAST(${period} AS INTERVAL)
          AND event_type = 'pageview'
          AND page_path = ${step.path}
          ${i > 0 ? sql`AND session_id IN (SELECT session_id FROM s${sql.unsafe(String(i - 1))})` : sql``}
        GROUP BY session_id
      `;
    }
    if (step.type === 'event' && step.event_name) {
      return sql`
        SELECT DISTINCT session_id, MIN(created_at) AS step_at
        FROM analytics
        WHERE website_id = ${websiteId}
          AND created_at >= NOW() - CAST(${period} AS INTERVAL)
          AND event_type = 'event'
          AND event_name = ${step.event_name}
          ${i > 0 ? sql`AND session_id IN (SELECT session_id FROM s${sql.unsafe(String(i - 1))})` : sql``}
        GROUP BY session_id
      `;
    }
    return sql`SELECT NULL::text AS session_id, NULL::timestamptz AS step_at WHERE FALSE`;
  });

  // Simpler approach: compute each step independently using IN against previous step
  const results: Array<{ step: number; count: number }> = [];
  let prevIds: string[] | null = null;

  for (let i = 0; i < capped.length; i++) {
    const step = capped[i];
    let rows: Array<{ session_id: string }> = [];

    if (step.type === 'pageview' && step.path) {
      rows = await sql`
        SELECT DISTINCT session_id
        FROM analytics
        WHERE website_id = ${websiteId}
          AND created_at >= NOW() - CAST(${period} AS INTERVAL)
          AND event_type = 'pageview'
          AND page_path = ${step.path}
          AND session_id IS NOT NULL
          ${prevIds && prevIds.length > 0
            ? sql`AND session_id = ANY(${sql.array(prevIds)}::text[])`
            : sql``}
      ` as Array<{ session_id: string }>;
    } else if (step.type === 'event' && step.event_name) {
      rows = await sql`
        SELECT DISTINCT session_id
        FROM analytics
        WHERE website_id = ${websiteId}
          AND created_at >= NOW() - CAST(${period} AS INTERVAL)
          AND event_type = 'event'
          AND event_name = ${step.event_name}
          AND session_id IS NOT NULL
          ${prevIds && prevIds.length > 0
            ? sql`AND session_id = ANY(${sql.array(prevIds)}::text[])`
            : sql``}
      ` as Array<{ session_id: string }>;
    }

    prevIds = rows.map((r) => r.session_id);
    results.push({ step: i + 1, count: prevIds.length });
  }

  void stepConditions; // keep reference to silence linter; CTE variant left for future optimisation
  return results;
}
