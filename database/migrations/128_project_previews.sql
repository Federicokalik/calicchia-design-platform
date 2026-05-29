-- Project preview links for client portal website drafts.
CREATE TABLE IF NOT EXISTS project_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'custom'
    CHECK (provider IN ('netlify', 'vercel', 'wordpress', 'custom')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'approved', 'archived')),
  visible_to_client BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_previews_project
  ON project_previews(project_id, sort_order, created_at);

DROP TRIGGER IF EXISTS update_project_previews_updated_at ON project_previews;
CREATE TRIGGER update_project_previews_updated_at
  BEFORE UPDATE ON project_previews
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
