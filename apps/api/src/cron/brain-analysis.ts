import { sql } from '../db';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram';

export async function runBrainAnalysis() {
  if (!isTelegramConfigured()) return;

  const lines: string[] = [];

  // 1. Stale leads
  const [stale] = await sql`SELECT COUNT(*)::int AS c FROM leads WHERE status IN ('new','contacted','proposal','negotiation') AND updated_at < NOW() - INTERVAL '5 days'`;
  if (stale?.c > 0) lines.push(`📋 ${stale.c} lead fermi 5+gg`);

  // 2. Projects at risk
  const [risky] = await sql`SELECT COUNT(*)::int AS c FROM client_projects WHERE status = 'in_progress' AND target_end_date < NOW() + INTERVAL '7 days' AND progress_percentage < 80`;
  if (risky?.c > 0) lines.push(`⚠️ ${risky.c} progetti a rischio`);

  // 3. Unseen quotes
  const [unseen] = await sql`SELECT COUNT(*)::int AS c FROM quotes_v2 WHERE status = 'sent' AND sent_at < NOW() - INTERVAL '3 days'`;
  if (unseen?.c > 0) lines.push(`📄 ${unseen.c} preventivi non aperti`);

  // 4. Revenue
  const [rev] = await sql`SELECT COALESCE(SUM(amount),0)::numeric AS t FROM payment_tracker WHERE status='pagata' AND DATE_TRUNC('month',paid_date)=DATE_TRUNC('month',CURRENT_DATE)`;
  const [avg] = await sql`SELECT COALESCE(AVG(mt),0)::numeric AS a FROM (SELECT SUM(amount) AS mt FROM payment_tracker WHERE status='pagata' AND paid_date > NOW()-INTERVAL '6 months' GROUP BY DATE_TRUNC('month',paid_date)) sub`;
  const r = parseFloat(rev?.t || '0');
  const a = parseFloat(avg?.a || '0');
  if (a > 0 && r < a * 0.7) lines.push(`📉 Revenue €${r.toFixed(0)} vs media €${a.toFixed(0)}`);

  // 5. Domains
  const [domains] = await sql`SELECT COUNT(*)::int AS c FROM domains WHERE expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`;
  if (domains?.c > 0) lines.push(`🌐 ${domains.c} domini scadono entro 30gg`);

  // ─── Traffic-aware heuristics (cookieless internal analytics) ──────────────

  // 6. Pageview drop: today vs 7-day median. Only fire if we have a baseline
  //    (>= 30 pageviews/day median) to avoid noise on quiet days.
  const [pvBaseline] = await sql`
    WITH daily AS (
      SELECT DATE(created_at) AS day, COUNT(*)::int AS pv
      FROM analytics
      WHERE website_id='main' AND event_type='pageview'
        AND created_at >= NOW() - INTERVAL '8 days'
        AND created_at < DATE_TRUNC('day', NOW())
      GROUP BY DATE(created_at)
    )
    SELECT
      (SELECT COUNT(*) FROM analytics WHERE website_id='main' AND event_type='pageview' AND created_at >= DATE_TRUNC('day', NOW()))::int AS today,
      COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY pv), 0)::int AS median7d
    FROM daily
  ` as Array<{ today: number; median7d: number }>;
  if (pvBaseline && pvBaseline.median7d >= 30) {
    const ratio = pvBaseline.today / pvBaseline.median7d;
    if (ratio < 0.5) {
      const pct = Math.round((1 - ratio) * 100);
      lines.push(`📉 Traffico oggi -${pct}% vs mediana 7gg (${pvBaseline.today} vs ${pvBaseline.median7d})`);
    }
  }

  // 7. Web Vitals regression: LCP p75 > 4s su periodi recenti
  const [lcp] = await sql`
    SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY event_value)::int AS p75, COUNT(*)::int AS samples
    FROM analytics
    WHERE website_id='main' AND event_type='web_vital' AND event_name='LCP' AND event_value IS NOT NULL
      AND created_at >= NOW() - INTERVAL '24 hours'
  ` as Array<{ p75: number | null; samples: number }>;
  if (lcp && lcp.samples >= 20 && lcp.p75 && lcp.p75 > 4000) {
    lines.push(`🐌 LCP p75 ${lcp.p75}ms (>4s) ultime 24h, ${lcp.samples} sample`);
  }

  // 8. New top referrer never seen before: dominio che appare top-3 ultimi 7gg
  //    e non era presente nei 30gg precedenti.
  const newRefs = await sql`
    WITH last7 AS (
      SELECT referrer_domain, COUNT(*) AS cnt
      FROM analytics
      WHERE website_id='main' AND event_type='pageview' AND referrer_domain IS NOT NULL
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY referrer_domain
      ORDER BY cnt DESC
      LIMIT 3
    ),
    prior30 AS (
      SELECT DISTINCT referrer_domain
      FROM analytics
      WHERE website_id='main' AND event_type='pageview' AND referrer_domain IS NOT NULL
        AND created_at >= NOW() - INTERVAL '37 days'
        AND created_at < NOW() - INTERVAL '7 days'
    )
    SELECT l.referrer_domain, l.cnt
    FROM last7 l
    WHERE l.referrer_domain NOT IN (SELECT referrer_domain FROM prior30)
      AND l.cnt >= 5
  ` as Array<{ referrer_domain: string; cnt: string }>;
  if (newRefs.length > 0) {
    const names = newRefs.map((r) => r.referrer_domain).join(', ');
    lines.push(`🔗 Nuovo referrer top: ${names}`);
  }

  // 9. Active goal con zero conversioni in 48h (solo se il goal è "vivo",
  //    cioè ha avuto almeno una conversione negli ultimi 30 giorni).
  const stagnantGoals = await sql`
    SELECT g.name, g.type, g.conditions
    FROM analytics_goals g
    WHERE g.active = TRUE
  ` as Array<{ name: string; type: string; conditions: { path?: string; event_name?: string } }>;
  const stagnantNames: string[] = [];
  for (const g of stagnantGoals) {
    if (g.type === 'pageview' && g.conditions?.path) {
      const [recent] = await sql`SELECT COUNT(*)::int AS c FROM analytics WHERE website_id='main' AND event_type='pageview' AND page_path=${g.conditions.path} AND created_at >= NOW() - INTERVAL '48 hours'`;
      const [baseline] = await sql`SELECT COUNT(*)::int AS c FROM analytics WHERE website_id='main' AND event_type='pageview' AND page_path=${g.conditions.path} AND created_at >= NOW() - INTERVAL '30 days' AND created_at < NOW() - INTERVAL '48 hours'`;
      if (recent?.c === 0 && (baseline?.c ?? 0) >= 5) stagnantNames.push(g.name);
    } else if (g.type === 'event' && g.conditions?.event_name) {
      const [recent] = await sql`SELECT COUNT(*)::int AS c FROM analytics WHERE website_id='main' AND event_type='event' AND event_name=${g.conditions.event_name} AND created_at >= NOW() - INTERVAL '48 hours'`;
      const [baseline] = await sql`SELECT COUNT(*)::int AS c FROM analytics WHERE website_id='main' AND event_type='event' AND event_name=${g.conditions.event_name} AND created_at >= NOW() - INTERVAL '30 days' AND created_at < NOW() - INTERVAL '48 hours'`;
      if (recent?.c === 0 && (baseline?.c ?? 0) >= 5) stagnantNames.push(g.name);
    }
  }
  if (stagnantNames.length > 0) {
    lines.push(`🎯 Goal senza conversioni 48h: ${stagnantNames.join(', ')}`);
  }

  if (lines.length === 0) return;

  const text = `🧠 <b>Report</b>\n\n${lines.join('\n')}`;
  await sendTelegramMessage(text, undefined, { parse_mode: 'HTML' });
}
