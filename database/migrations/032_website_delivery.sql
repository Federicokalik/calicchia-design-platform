-- Migration 032: Website Delivery Tracker
-- Epic 5 - Website project tracking with pages and launch checklist

-- =====================================================
-- website_projects
-- =====================================================
CREATE TABLE IF NOT EXISTS website_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES client_projects(id) ON DELETE SET NULL,
  quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,

  website_type TEXT NOT NULL CHECK (website_type IN (
    'landing_page', 'brochure', 'ecommerce', 'blog', 'portfolio', 'webapp', 'other'
  )),
  cms_choice TEXT,
  domain TEXT,
  staging_url TEXT,
  production_url TEXT,
  hosting_provider TEXT,

  status TEXT NOT NULL DEFAULT 'discovery' CHECK (status IN (
    'discovery', 'design', 'development', 'content', 'review', 'testing', 'ready_to_launch', 'live'
  )),

  estimated_completion DATE,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================
-- website_pages
-- =====================================================
CREATE TABLE IF NOT EXISTS website_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_project_id UUID NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,

  page_name TEXT NOT NULL,
  page_slug TEXT NOT NULL,
  page_type TEXT NOT NULL DEFAULT 'standard' CHECK (page_type IN (
    'home', 'about', 'services', 'portfolio', 'blog', 'contact', 'legal', 'standard', 'custom'
  )),

  content_status TEXT NOT NULL DEFAULT 'pending' CHECK (content_status IN ('pending', 'in_progress', 'done')),
  design_status TEXT NOT NULL DEFAULT 'pending' CHECK (design_status IN ('pending', 'in_progress', 'done')),
  dev_status TEXT NOT NULL DEFAULT 'pending' CHECK (dev_status IN ('pending', 'in_progress', 'done')),
  seo_status TEXT NOT NULL DEFAULT 'pending' CHECK (seo_status IN ('pending', 'in_progress', 'done')),

  sort_order INTEGER NOT NULL DEFAULT 0,
  due_date DATE,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================
-- website_launch_checklist_items
-- =====================================================
CREATE TABLE IF NOT EXISTS website_launch_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_project_id UUID NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,

  category TEXT NOT NULL CHECK (category IN (
    'design', 'content', 'seo', 'performance', 'security', 'legal', 'testing'
  )),
  item_description TEXT NOT NULL,
  is_completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,

  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================
-- Triggers: updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS website_projects_updated_at ON website_projects;
CREATE TRIGGER website_projects_updated_at
  BEFORE UPDATE ON website_projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS website_pages_updated_at ON website_pages;
CREATE TRIGGER website_pages_updated_at
  BEFORE UPDATE ON website_pages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================
-- Indexes
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_website_projects_project_id ON website_projects(project_id);
CREATE INDEX IF NOT EXISTS idx_website_projects_status ON website_projects(status);
CREATE INDEX IF NOT EXISTS idx_website_pages_project ON website_pages(website_project_id);
CREATE INDEX IF NOT EXISTS idx_checklist_project ON website_launch_checklist_items(website_project_id);
