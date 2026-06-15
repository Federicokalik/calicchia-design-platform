-- Migration 132: Marketing campaigns — direct customer link + asset approval feedback
-- Exposes the (previously unused) marketing_campaigns module in admin + client portal.
-- - Campaigns may link to a project AND/OR directly to a customer (at least one for portal visibility).
-- - Campaign asset approval reuses the deliverable-feedback pattern (see migration 031).

-- =====================================================
-- marketing_campaigns: optional direct customer link
-- (project_id already exists; customer can also be derived from project->customer)
-- =====================================================
ALTER TABLE marketing_campaigns
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_customer_id ON marketing_campaigns(customer_id);

-- =====================================================
-- campaign_asset_feedback (mirrors deliverable_feedback)
-- =====================================================
CREATE TABLE IF NOT EXISTS campaign_asset_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES campaign_assets(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL DEFAULT 'client',
  -- client | freelancer
  author_name TEXT,
  feedback_text TEXT NOT NULL,
  feedback_type TEXT NOT NULL DEFAULT 'revision',
  -- revision | approval | comment
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_campaign_feedback_author CHECK (author_type IN ('client','freelancer')),
  CONSTRAINT chk_campaign_feedback_type CHECK (feedback_type IN ('revision','approval','comment'))
);

CREATE INDEX IF NOT EXISTS idx_campaign_asset_feedback_asset ON campaign_asset_feedback(asset_id);
