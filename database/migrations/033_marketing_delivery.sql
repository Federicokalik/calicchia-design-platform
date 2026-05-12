-- Migration 033: Marketing Delivery Tracker
-- Epic 6 - Marketing campaign tracking with assets and reports

-- =====================================================
-- marketing_campaigns
-- =====================================================
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES client_projects(id) ON DELETE SET NULL,
  quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,

  campaign_name TEXT NOT NULL,
  campaign_type TEXT NOT NULL CHECK (campaign_type IN (
    'brand_identity', 'social_media', 'email_marketing', 'seo_sem', 'content_marketing',
    'video', 'print', 'event', 'other'
  )),
  channel TEXT NOT NULL CHECK (channel IN (
    'instagram', 'facebook', 'linkedin', 'tiktok', 'google', 'email', 'youtube',
    'print', 'multi', 'other'
  )),

  status TEXT NOT NULL DEFAULT 'brief' CHECK (status IN (
    'brief', 'planning', 'creative', 'review', 'approved', 'active', 'paused', 'completed', 'cancelled'
  )),

  budget_planned NUMERIC(12,2),
  budget_actual NUMERIC(12,2),
  currency TEXT NOT NULL DEFAULT 'EUR',

  kpi_target JSONB DEFAULT '{}',
  kpi_actual JSONB DEFAULT '{}',

  start_date DATE,
  end_date DATE,
  notes TEXT,
  objective TEXT,
  target_audience TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================
-- campaign_assets
-- =====================================================
CREATE TABLE IF NOT EXISTS campaign_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,

  asset_type TEXT NOT NULL CHECK (asset_type IN (
    'image', 'video', 'copy', 'graphic', 'document', 'audio', 'other'
  )),
  asset_name TEXT NOT NULL,
  file_url TEXT,

  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'in_progress', 'review', 'approved', 'rejected', 'published'
  )),
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN (
    'pending', 'approved', 'rejected', 'revision_requested'
  )),

  version INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================
-- campaign_reports
-- =====================================================
CREATE TABLE IF NOT EXISTS campaign_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,

  report_date DATE NOT NULL,
  report_period TEXT NOT NULL CHECK (report_period IN (
    'daily', 'weekly', 'monthly', 'quarterly', 'final'
  )),

  metrics_json JSONB DEFAULT '{}',
  summary TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (campaign_id, report_date, report_period)
);

-- =====================================================
-- Triggers: updated_at
-- =====================================================
DROP TRIGGER IF EXISTS marketing_campaigns_updated_at ON marketing_campaigns;
CREATE TRIGGER marketing_campaigns_updated_at
  BEFORE UPDATE ON marketing_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS campaign_assets_updated_at ON campaign_assets;
CREATE TRIGGER campaign_assets_updated_at
  BEFORE UPDATE ON campaign_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================
-- Indexes
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_project_id ON marketing_campaigns(project_id);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_status ON marketing_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_channel ON marketing_campaigns(channel);
CREATE INDEX IF NOT EXISTS idx_campaign_assets_campaign ON campaign_assets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_reports_campaign ON campaign_reports(campaign_id);
