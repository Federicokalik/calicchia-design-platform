import { Hono } from 'hono';
import { sql } from '../db';
import { authMiddleware } from '../middleware/auth';

export const analytics = new Hono();

/** Anonymize IP: zero last octet (IPv4) or last group (IPv6) */
function anonymizeIp(ip: string): string {
  if (!ip) return '';
  if (ip.includes('.') && !ip.includes(':')) {
    const parts = ip.split('.');
    if (parts.length === 4) { parts[3] = '0'; return parts.join('.'); }
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    if (parts.length > 1) { parts[parts.length - 1] = '0'; return parts.join(':'); }
  }
  return '';
}

analytics.get('/', async (c) => {
  const period = c.req.query('period') || '30d';

  let daysAgo = 30;
  if (period === '24h') daysAgo = 1;
  if (period === '7d') daysAgo = 7;
  if (period === '90d') daysAgo = 90;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysAgo);
  const startISO = startDate.toISOString();

  const [analyticsData, blogPosts, subscribers] = await Promise.all([
    sql`SELECT * FROM analytics WHERE created_at >= ${startISO}`,
    sql`SELECT id, is_published, views_count FROM blog_posts`,
    sql`SELECT status FROM newsletter_subscribers`,
  ]);

  const pageviews = analyticsData.filter((a) => a.event_type === 'pageview');
  const contactEvents = analyticsData.filter((a) => a.event_type === 'contact');

  const uniqueVisitors = new Set(pageviews.map((p) => p.session_id || p.id)).size;
  const avgPagesPerVisitor = uniqueVisitors > 0 ? (pageviews.length / uniqueVisitors).toFixed(1) : '0';

  const publishedPosts = blogPosts.filter((p) => p.is_published);
  const totalBlogViews = publishedPosts.reduce((sum, p) => sum + (p.views_count || 0), 0);

  const confirmed = subscribers.filter((s) => s.status === 'confirmed').length;
  const pending = subscribers.filter((s) => s.status === 'pending').length;
  const unsubscribed = subscribers.filter((s) => s.status === 'unsubscribed').length;

  const pageCounts: Record<string, number> = {};
  pageviews.forEach((p) => {
    const path = (p.page_path as string) || '/';
    pageCounts[path] = (pageCounts[path] || 0) + 1;
  });
  const topPages = Object.entries(pageCounts)
    .map(([path, views]) => ({ path, views }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 10);

  const referrerCounts: Record<string, number> = {};
  pageviews.forEach((p) => {
    if (p.referrer) {
      try {
        const domain = new URL(p.referrer as string).hostname;
        referrerCounts[domain] = (referrerCounts[domain] || 0) + 1;
      } catch { /* skip */ }
    }
  });
  const topReferrers = Object.entries(referrerCounts)
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const devices: Record<string, number> = { desktop: 0, mobile: 0, tablet: 0 };
  pageviews.forEach((p) => {
    const ua = ((p.user_agent as string) || '').toLowerCase();
    if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) devices.mobile++;
    else if (ua.includes('tablet') || ua.includes('ipad')) devices.tablet++;
    else devices.desktop++;
  });

  return c.json({
    period,
    overview: {
      pageViews: pageviews.length,
      uniqueVisitors,
      contacts: contactEvents.length,
      avgPagesPerVisitor,
    },
    blog: {
      totalPosts: blogPosts.length,
      publishedPosts: publishedPosts.length,
      totalViews: totalBlogViews,
    },
    newsletter: {
      total: subscribers.length,
      confirmed,
      pending,
      unsubscribed,
    },
    topPages,
    topReferrers,
    devices,
  });
});

analytics.get('/timeseries', async (c) => {
  const period = c.req.query('period') || '30d';

  const periodMap: Record<string, string> = {
    '7d': '7 days',
    '30d': '30 days',
    '90d': '90 days',
  };
  const interval = periodMap[period] || '30 days';

  const rows = await sql`
    SELECT DATE(created_at) AS date, COUNT(*)::int AS views, COUNT(DISTINCT session_id)::int AS visitors
    FROM analytics
    WHERE event_type = 'pageview' AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
    GROUP BY DATE(created_at)
    ORDER BY date
  ` as Array<{ date: string; views: number; visitors: number }>;

  return c.json({ timeseries: rows });
});

analytics.post('/track', async (c) => {
  const body = await c.req.json();
  const { type, page, event, data } = body;

  // Anonymize IP before storage (GDPR)
  const rawIp =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    '';
  const ipAnon = anonymizeIp(rawIp);

  await sql`
    INSERT INTO analytics (event_type, page_path, referrer, user_agent, ip_address, metadata)
    VALUES (
      ${type === 'pageview' ? 'pageview' : event},
      ${page || null},
      ${c.req.header('referer') || null},
      ${c.req.header('user-agent') || null},
      ${ipAnon || null},
      ${data || {}}
    )
  `;

  return c.json({ success: true });
});

/** Admin: purge analytics older than 26 months (GDPR retention) */
analytics.delete('/purge', authMiddleware, async (c) => {
  const result = await sql`
    DELETE FROM analytics
    WHERE created_at < NOW() - INTERVAL '26 months'
    RETURNING id
  `;
  return c.json({ deleted: result.length });
});

/** Admin: run all data retention (GDPR) — calls DB function */
analytics.post('/data-retention', authMiddleware, async (c) => {
  const [result] = await sql`SELECT run_data_retention() AS summary`;
  return c.json({ retention: result?.summary || {} });
});
