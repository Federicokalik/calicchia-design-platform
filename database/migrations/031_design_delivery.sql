-- Migration: 031_design_delivery.sql
-- Descrizione: Design delivery — deliverable, versioni, feedback
-- Data: 2026-03-08

-- =====================================================
-- PROJECT DELIVERABLES
-- =====================================================

CREATE TABLE IF NOT EXISTS project_deliverables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES client_projects(id) ON DELETE CASCADE,
  quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  deliverable_type TEXT NOT NULL DEFAULT 'design',
  -- design | logo | brand_identity | social | print | web | video | other
  status TEXT NOT NULL DEFAULT 'pending',
  -- pending | in_progress | client_review | revision_requested | approved | delivered
  revision_limit INT NOT NULL DEFAULT 2,
  revision_count INT NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  due_date DATE,
  delivered_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_deliverable_status CHECK (status IN (
    'pending','in_progress','client_review','revision_requested','approved','delivered'
  )),
  CONSTRAINT chk_deliverable_type CHECK (deliverable_type IN (
    'design','logo','brand_identity','social','print','web','video','other'
  ))
);

CREATE INDEX IF NOT EXISTS idx_project_deliverables_project ON project_deliverables(project_id);
CREATE INDEX IF NOT EXISTS idx_project_deliverables_quote ON project_deliverables(quote_id);
CREATE INDEX IF NOT EXISTS idx_project_deliverables_status ON project_deliverables(status);

-- =====================================================
-- DELIVERABLE VERSIONS
-- =====================================================

CREATE TABLE IF NOT EXISTS deliverable_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deliverable_id UUID NOT NULL REFERENCES project_deliverables(id) ON DELETE CASCADE,
  version_number INT NOT NULL DEFAULT 1,
  title TEXT,
  notes TEXT,
  file_url TEXT,
  file_name TEXT,
  file_size BIGINT,
  mime_type TEXT,
  preview_url TEXT,
  is_current BOOLEAN NOT NULL DEFAULT false,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(deliverable_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_deliverable_versions_deliverable ON deliverable_versions(deliverable_id);

-- =====================================================
-- DELIVERABLE FEEDBACK
-- =====================================================

CREATE TABLE IF NOT EXISTS deliverable_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deliverable_id UUID NOT NULL REFERENCES project_deliverables(id) ON DELETE CASCADE,
  version_id UUID REFERENCES deliverable_versions(id) ON DELETE SET NULL,
  author_type TEXT NOT NULL DEFAULT 'client',
  -- client | freelancer
  author_name TEXT,
  feedback_text TEXT NOT NULL,
  feedback_type TEXT NOT NULL DEFAULT 'revision',
  -- revision | approval | comment
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_feedback_author CHECK (author_type IN ('client','freelancer')),
  CONSTRAINT chk_feedback_type CHECK (feedback_type IN ('revision','approval','comment'))
);

CREATE INDEX IF NOT EXISTS idx_deliverable_feedback_deliverable ON deliverable_feedback(deliverable_id);
CREATE INDEX IF NOT EXISTS idx_deliverable_feedback_version ON deliverable_feedback(version_id);

-- Trigger per updated_at su project_deliverables
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_updated_at_project_deliverables'
  ) THEN
    CREATE TRIGGER set_updated_at_project_deliverables
      BEFORE UPDATE ON project_deliverables
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
