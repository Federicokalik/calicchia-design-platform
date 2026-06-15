import { Hono } from 'hono';
import { sql } from '../../db';
import { fail } from '../../lib/responses';
import { portalClientAuth, type PortalEnv } from './auth';
import { logger } from '../../lib/logger';

const log = logger.child({ scope: 'portal-campaigns' });

export const campaignRoutes = new Hono<PortalEnv>();

// Assets the client is allowed to see (submitted for review or beyond — never raw drafts)
const VISIBLE_ASSET_STATUSES = sql`('review', 'approved', 'rejected', 'published')`;

// ── List campaigns for the logged customer ───────────────
campaignRoutes.get('/campaigns', portalClientAuth, async (c) => {
  const customerId = c.get('customer_id') as string;

  const rows = await sql`
    SELECT
      mc.id, mc.campaign_name, mc.campaign_type, mc.channel, mc.status,
      mc.start_date, mc.end_date, mc.objective,
      cp.name AS project_name,
      (SELECT COUNT(*)::int FROM campaign_assets a
        WHERE a.campaign_id = mc.id AND a.status IN ${VISIBLE_ASSET_STATUSES}
      ) AS asset_count,
      (SELECT COUNT(*)::int FROM campaign_assets a
        WHERE a.campaign_id = mc.id AND a.status = 'review' AND a.approval_status = 'pending'
      ) AS pending_count
    FROM marketing_campaigns mc
    LEFT JOIN client_projects cp ON cp.id = mc.project_id
    WHERE COALESCE(mc.customer_id, cp.customer_id) = ${customerId}
    ORDER BY mc.created_at DESC
  ` as Array<Record<string, unknown>>;

  return c.json({ campaigns: rows });
});

// ── Campaign detail with visible assets + feedback ───────
campaignRoutes.get('/campaigns/:id', portalClientAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const id = c.req.param('id');

  const [campaign] = await sql`
    SELECT mc.id, mc.campaign_name, mc.campaign_type, mc.channel, mc.status,
           mc.start_date, mc.end_date, mc.objective, cp.name AS project_name
    FROM marketing_campaigns mc
    LEFT JOIN client_projects cp ON cp.id = mc.project_id
    WHERE mc.id = ${id}
      AND COALESCE(mc.customer_id, cp.customer_id) = ${customerId}
    LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!campaign) fail('Campagna non trovata', 404);

  const assets = await sql`
    SELECT a.id, a.asset_type, a.asset_name, a.file_url, a.status, a.approval_status,
           a.version, a.notes, a.created_at,
           (SELECT json_agg(json_build_object(
              'id', f.id, 'author_type', f.author_type, 'author_name', f.author_name,
              'feedback_text', f.feedback_text, 'feedback_type', f.feedback_type, 'created_at', f.created_at
            ) ORDER BY f.created_at)
            FROM campaign_asset_feedback f WHERE f.asset_id = a.id) AS feedback
    FROM campaign_assets a
    WHERE a.campaign_id = ${id} AND a.status IN ${VISIBLE_ASSET_STATUSES}
    ORDER BY a.sort_order, a.created_at
  ` as Array<Record<string, unknown>>;

  return c.json({ campaign, assets });
});

/**
 * Verify an asset belongs to a campaign owned by the logged customer.
 * Returns the asset+campaign row, or null.
 */
async function loadOwnedAsset(assetId: string, customerId: string) {
  const [row] = await sql`
    SELECT ca.id, ca.asset_name, ca.status,
           mc.id AS campaign_id, mc.campaign_name, mc.project_id,
           COALESCE(mc.customer_id, cp.customer_id) AS customer_id
    FROM campaign_assets ca
    JOIN marketing_campaigns mc ON mc.id = ca.campaign_id
    LEFT JOIN client_projects cp ON cp.id = mc.project_id
    WHERE ca.id = ${assetId}
      AND ca.status = 'review'
      AND COALESCE(mc.customer_id, cp.customer_id) = ${customerId}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  return row || null;
}

async function customerName(customerId: string): Promise<string> {
  const rows = await sql`
    SELECT contact_name FROM customers WHERE id = ${customerId} LIMIT 1
  ` as Array<{ contact_name: string }>;
  return rows[0]?.contact_name || 'Cliente';
}

// ── Approve an asset ─────────────────────────────────────
campaignRoutes.post('/campaigns/assets/:id/approve', portalClientAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const assetId = c.req.param('id');
  const { comment } = await c.req.json().catch(() => ({ comment: '' }));

  const asset = await loadOwnedAsset(assetId, customerId);
  if (!asset) fail('Asset non trovato o non in revisione', 404);

  const name = await customerName(customerId);
  const projectId = asset!.project_id ? String(asset!.project_id) : null;
  const assetName = String(asset!.asset_name);
  const campaignName = String(asset!.campaign_name);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sql.begin(async (tx: any) => {
    await tx`
      UPDATE campaign_assets
      SET status = 'approved', approval_status = 'approved', updated_at = NOW()
      WHERE id = ${assetId}
    `;
    await tx`
      INSERT INTO campaign_asset_feedback (asset_id, author_type, author_name, feedback_text, feedback_type)
      VALUES (${assetId}, 'client', ${name}, ${comment || 'Approvato'}, 'approval')
    `;
    if (projectId) {
      await tx`
        INSERT INTO timeline_events (project_id, customer_id, type, title, description, actor_type)
        VALUES (${projectId}, ${customerId}, 'campaign_asset_approved', ${'Asset approvato: ' + assetName}, ${comment || null}, 'client')
      `;
    }
  });

  try {
    const { notifyTelegram } = await import('../../lib/telegram');
    await notifyTelegram(
      'Asset campagna approvato',
      `Campagna: ${campaignName}\nAsset: ${assetName}${comment ? '\nCommento: ' + comment : ''}`
    );
  } catch (err) {
    log.warn({ err, assetName }, 'telegram notify failed (campaign approval)');
  }

  return c.json({ ok: true, status: 'approved' });
});

// ── Reject an asset (request revision) ───────────────────
campaignRoutes.post('/campaigns/assets/:id/reject', portalClientAuth, async (c) => {
  const customerId = c.get('customer_id') as string;
  const assetId = c.req.param('id');
  const { comment } = await c.req.json().catch(() => ({ comment: '' }));

  if (!comment?.trim()) {
    fail('Il commento e\' obbligatorio per richiedere modifiche', 400);
  }

  const asset = await loadOwnedAsset(assetId, customerId);
  if (!asset) fail('Asset non trovato o non in revisione', 404);

  const name = await customerName(customerId);
  const projectId = asset!.project_id ? String(asset!.project_id) : null;
  const assetName = String(asset!.asset_name);
  const campaignName = String(asset!.campaign_name);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sql.begin(async (tx: any) => {
    await tx`
      UPDATE campaign_assets
      SET status = 'rejected', approval_status = 'revision_requested', updated_at = NOW()
      WHERE id = ${assetId}
    `;
    await tx`
      INSERT INTO campaign_asset_feedback (asset_id, author_type, author_name, feedback_text, feedback_type)
      VALUES (${assetId}, 'client', ${name}, ${comment}, 'revision')
    `;
    if (projectId) {
      await tx`
        INSERT INTO timeline_events (project_id, customer_id, type, title, description, actor_type)
        VALUES (${projectId}, ${customerId}, 'campaign_asset_rejected', ${'Modifiche richieste: ' + assetName}, ${comment}, 'client')
      `;
    }
  });

  try {
    const { notifyTelegram } = await import('../../lib/telegram');
    await notifyTelegram(
      'Modifiche richieste (asset campagna)',
      `Campagna: ${campaignName}\nAsset: ${assetName}\nCommento: ${comment}`
    );
  } catch (err) {
    log.warn({ err, assetName }, 'telegram notify failed (campaign revisions)');
  }

  return c.json({ ok: true, status: 'revision_requested' });
});
