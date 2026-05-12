import { Hono } from 'hono';
import { sql } from '../db';

export const marketing = new Hono();

type Row = Record<string, unknown>;

const CAMPAIGN_TYPES = new Set([
  'brand_identity', 'social_media', 'email_marketing', 'seo_sem', 'content_marketing',
  'video', 'print', 'event', 'other',
]);
const CHANNELS = new Set([
  'instagram', 'facebook', 'linkedin', 'tiktok', 'google', 'email', 'youtube',
  'print', 'multi', 'other',
]);
const STATUSES = new Set([
  'brief', 'planning', 'creative', 'review', 'approved', 'active', 'paused', 'completed', 'cancelled',
]);
const ASSET_TYPES = new Set(['image', 'video', 'copy', 'graphic', 'document', 'audio', 'other']);
const ASSET_STATUSES = new Set(['draft', 'in_progress', 'review', 'approved', 'rejected', 'published']);
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'revision_requested']);
const REPORT_PERIODS = new Set(['daily', 'weekly', 'monthly', 'quarterly', 'final']);

// =====================================================
// GET /api/marketing/campaigns
// =====================================================
marketing.get('/campaigns', async (c) => {
  const { project_id, status, channel } = c.req.query();

  const projectFilter = project_id ? sql`AND mc.project_id = ${project_id}` : sql``;
  const statusFilter = status ? sql`AND mc.status = ${status}` : sql``;
  const channelFilter = channel ? sql`AND mc.channel = ${channel}` : sql``;

  const rows = await sql`
    SELECT
      mc.*,
      cp.name AS project_name,
      cu.id AS customer_id,
      cu.contact_name AS customer_name,
      cu.company_name AS customer_company,
      (SELECT COUNT(*)::int FROM campaign_assets a WHERE a.campaign_id = mc.id) AS asset_count,
      (SELECT json_build_object('report_date', r.report_date, 'metrics_json', r.metrics_json, 'summary', r.summary)
       FROM campaign_reports r WHERE r.campaign_id = mc.id ORDER BY r.report_date DESC LIMIT 1) AS last_report
    FROM marketing_campaigns mc
    LEFT JOIN client_projects cp ON cp.id = mc.project_id
    LEFT JOIN customers cu ON cu.id = cp.customer_id
    WHERE 1=1
      ${projectFilter}
      ${statusFilter}
      ${channelFilter}
    ORDER BY mc.created_at DESC
  ` as Row[];

  return c.json({ campaigns: rows });
});

// =====================================================
// POST /api/marketing/campaigns
// =====================================================
marketing.post('/campaigns', async (c) => {
  const body = await c.req.json();
  const {
    project_id, quote_id, campaign_name, campaign_type, channel,
    status = 'brief', budget_planned, budget_actual, currency = 'EUR',
    kpi_target = {}, kpi_actual = {},
    start_date, end_date, notes, objective, target_audience,
  } = body;

  if (!campaign_name) return c.json({ error: 'campaign_name obbligatorio' }, 400);
  if (!campaign_type || !CAMPAIGN_TYPES.has(campaign_type)) return c.json({ error: 'campaign_type non valido' }, 400);
  if (!channel || !CHANNELS.has(channel)) return c.json({ error: 'channel non valido' }, 400);

  const rows = await sql`
    INSERT INTO marketing_campaigns
      (project_id, quote_id, campaign_name, campaign_type, channel, status,
       budget_planned, budget_actual, currency, kpi_target, kpi_actual,
       start_date, end_date, notes, objective, target_audience)
    VALUES
      (${project_id || null}, ${quote_id || null}, ${campaign_name}, ${campaign_type}, ${channel}, ${status},
       ${budget_planned || null}, ${budget_actual || null}, ${currency},
       ${JSON.stringify(kpi_target)}, ${JSON.stringify(kpi_actual)},
       ${start_date || null}, ${end_date || null}, ${notes || null},
       ${objective || null}, ${target_audience || null})
    RETURNING *
  ` as Row[];

  return c.json({ campaign: rows[0] }, 201);
});

// =====================================================
// GET /api/marketing/campaigns/:id
// =====================================================
marketing.get('/campaigns/:id', async (c) => {
  const { id } = c.req.param();

  const rows = await sql`
    SELECT
      mc.*,
      cp.name AS project_name,
      cu.id AS customer_id,
      cu.contact_name AS customer_name,
      cu.company_name AS customer_company,
      (SELECT json_agg(a ORDER BY a.sort_order) FROM campaign_assets a WHERE a.campaign_id = mc.id) AS assets,
      (SELECT json_build_object('report_date', r.report_date, 'metrics_json', r.metrics_json, 'summary', r.summary)
       FROM campaign_reports r WHERE r.campaign_id = mc.id ORDER BY r.report_date DESC LIMIT 1) AS last_report
    FROM marketing_campaigns mc
    LEFT JOIN client_projects cp ON cp.id = mc.project_id
    LEFT JOIN customers cu ON cu.id = cp.customer_id
    WHERE mc.id = ${id}
  ` as Row[];

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ campaign: rows[0] });
});

// =====================================================
// PATCH /api/marketing/campaigns/:id
// =====================================================
marketing.patch('/campaigns/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  if (body.status && !STATUSES.has(body.status)) return c.json({ error: 'status non valido' }, 400);
  if (body.channel && !CHANNELS.has(body.channel)) return c.json({ error: 'channel non valido' }, 400);

  const rows = await sql`
    UPDATE marketing_campaigns SET
      campaign_name = COALESCE(${body.campaign_name ?? null}, campaign_name),
      campaign_type = COALESCE(${body.campaign_type ?? null}, campaign_type),
      channel = COALESCE(${body.channel ?? null}, channel),
      status = COALESCE(${body.status ?? null}, status),
      budget_planned = COALESCE(${body.budget_planned ?? null}, budget_planned),
      budget_actual = COALESCE(${body.budget_actual ?? null}, budget_actual),
      kpi_target = COALESCE(${body.kpi_target ? JSON.stringify(body.kpi_target) : null}::jsonb, kpi_target),
      kpi_actual = COALESCE(${body.kpi_actual ? JSON.stringify(body.kpi_actual) : null}::jsonb, kpi_actual),
      start_date = COALESCE(${body.start_date ?? null}, start_date),
      end_date = COALESCE(${body.end_date ?? null}, end_date),
      notes = COALESCE(${body.notes ?? null}, notes),
      objective = COALESCE(${body.objective ?? null}, objective),
      target_audience = COALESCE(${body.target_audience ?? null}, target_audience)
    WHERE id = ${id}
    RETURNING *
  ` as Row[];

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ campaign: rows[0] });
});

// =====================================================
// DELETE /api/marketing/campaigns/:id
// =====================================================
marketing.delete('/campaigns/:id', async (c) => {
  const { id } = c.req.param();
  await sql`DELETE FROM marketing_campaigns WHERE id = ${id}`;
  return c.json({ success: true });
});

// =====================================================
// POST /api/marketing/campaigns/:id/assets
// =====================================================
marketing.post('/campaigns/:id/assets', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const {
    asset_type, asset_name, file_url,
    status = 'draft', version = 1, sort_order = 0, notes,
  } = body;

  if (!asset_name) return c.json({ error: 'asset_name obbligatorio' }, 400);
  if (!asset_type || !ASSET_TYPES.has(asset_type)) return c.json({ error: 'asset_type non valido' }, 400);

  const rows = await sql`
    INSERT INTO campaign_assets (campaign_id, asset_type, asset_name, file_url, status, version, sort_order, notes)
    VALUES (${id}, ${asset_type}, ${asset_name}, ${file_url || null}, ${status}, ${version}, ${sort_order}, ${notes || null})
    RETURNING *
  ` as Row[];

  return c.json({ asset: rows[0] }, 201);
});

// =====================================================
// PATCH /api/marketing/campaigns/:id/assets/:assetId
// =====================================================
marketing.patch('/campaigns/:id/assets/:assetId', async (c) => {
  const { assetId } = c.req.param();
  const body = await c.req.json();

  if (body.status && !ASSET_STATUSES.has(body.status)) return c.json({ error: 'status non valido' }, 400);
  if (body.approval_status && !APPROVAL_STATUSES.has(body.approval_status)) {
    return c.json({ error: 'approval_status non valido' }, 400);
  }

  const rows = await sql`
    UPDATE campaign_assets SET
      asset_name = COALESCE(${body.asset_name ?? null}, asset_name),
      file_url = COALESCE(${body.file_url ?? null}, file_url),
      status = COALESCE(${body.status ?? null}, status),
      approval_status = COALESCE(${body.approval_status ?? null}, approval_status),
      version = COALESCE(${body.version ?? null}, version),
      notes = COALESCE(${body.notes ?? null}, notes)
    WHERE id = ${assetId}
    RETURNING *
  ` as Row[];

  if (!rows.length) return c.json({ error: 'Not found' }, 404);
  return c.json({ asset: rows[0] });
});

// =====================================================
// DELETE /api/marketing/campaigns/:id/assets/:assetId
// =====================================================
marketing.delete('/campaigns/:id/assets/:assetId', async (c) => {
  const { assetId } = c.req.param();
  await sql`DELETE FROM campaign_assets WHERE id = ${assetId}`;
  return c.json({ success: true });
});

// =====================================================
// GET /api/marketing/campaigns/:id/reports
// =====================================================
marketing.get('/campaigns/:id/reports', async (c) => {
  const { id } = c.req.param();
  const rows = await sql`
    SELECT * FROM campaign_reports WHERE campaign_id = ${id} ORDER BY report_date DESC
  ` as Row[];
  return c.json({ reports: rows });
});

// =====================================================
// POST /api/marketing/campaigns/:id/reports
// =====================================================
marketing.post('/campaigns/:id/reports', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { report_date, report_period = 'weekly', metrics_json = {}, summary } = body;

  if (!report_date) return c.json({ error: 'report_date obbligatorio' }, 400);
  if (!REPORT_PERIODS.has(report_period)) return c.json({ error: 'report_period non valido' }, 400);

  const rows = await sql`
    INSERT INTO campaign_reports (campaign_id, report_date, report_period, metrics_json, summary)
    VALUES (${id}, ${report_date}, ${report_period}, ${JSON.stringify(metrics_json)}, ${summary || null})
    ON CONFLICT (campaign_id, report_date, report_period) DO UPDATE SET
      metrics_json = EXCLUDED.metrics_json,
      summary = EXCLUDED.summary
    RETURNING *
  ` as Row[];

  return c.json({ report: rows[0] }, 201);
});
