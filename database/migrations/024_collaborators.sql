-- Migration: 024_collaborators.sql
-- Descrizione: Sistema collaboratori (agenzie/freelancer esterni) con Stripe + portale
-- Data: 2026-02-13

-- ============================================
-- 1. TABELLA COLLABORATORS
-- Specchio di customers per collaboratori esterni
-- ============================================

CREATE TABLE IF NOT EXISTS collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stripe integration
  stripe_customer_id TEXT UNIQUE,

  -- Anagrafica
  company_name TEXT,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,

  -- Indirizzo fatturazione
  billing_address JSONB DEFAULT '{}',
  -- { street, city, postal_code, province, country, vat_number, fiscal_code }

  -- Note interne
  notes TEXT,
  tags JSONB DEFAULT '[]',

  -- Stato
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),

  -- Metriche
  total_revenue DECIMAL(10,2) DEFAULT 0,
  lifetime_value DECIMAL(10,2) DEFAULT 0,

  -- Portale
  portal_access_code TEXT UNIQUE,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS collaborators_email_idx ON collaborators(email);
CREATE INDEX IF NOT EXISTS collaborators_stripe_idx ON collaborators(stripe_customer_id);
CREATE INDEX IF NOT EXISTS collaborators_status_idx ON collaborators(status);
CREATE INDEX IF NOT EXISTS idx_collaborators_portal_code
  ON collaborators(portal_access_code) WHERE portal_access_code IS NOT NULL;

-- ============================================
-- 2. COLONNA collaborator_id SU client_projects
-- ============================================

ALTER TABLE client_projects
  ADD COLUMN IF NOT EXISTS collaborator_id UUID REFERENCES collaborators(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_client_projects_collaborator ON client_projects(collaborator_id);

-- ============================================
-- 3. AGGIORNA VISTA client_projects_view
-- ============================================

DROP VIEW IF EXISTS client_projects_view CASCADE;

CREATE OR REPLACE VIEW client_projects_view AS
SELECT
  cp.*,
  c.contact_name AS customer_name,
  c.company_name AS customer_company,
  c.email AS customer_email,
  p.email AS assignee_email,
  co.contact_name AS collaborator_name,
  co.company_name AS collaborator_company,
  co.email AS collaborator_email,
  (SELECT COUNT(*) FROM project_tasks WHERE project_id = cp.id) AS total_tasks,
  (SELECT COUNT(*) FROM project_tasks WHERE project_id = cp.id AND status = 'done') AS completed_tasks,
  (SELECT COUNT(*) FROM project_milestones WHERE project_id = cp.id) AS total_milestones,
  (SELECT COUNT(*) FROM project_milestones WHERE project_id = cp.id AND status = 'completed') AS completed_milestones,
  CASE
    WHEN cp.target_end_date < CURRENT_DATE AND cp.status NOT IN ('completed', 'cancelled') THEN true
    ELSE false
  END AS is_overdue
FROM client_projects cp
LEFT JOIN customers c ON c.id = cp.customer_id
LEFT JOIN profiles p ON p.id = cp.assigned_to
LEFT JOIN collaborators co ON co.id = cp.collaborator_id;

-- Re-grant access
GRANT SELECT ON client_projects_view TO authenticated;

-- ============================================
-- 4. RLS POLICIES
-- ============================================

ALTER TABLE collaborators ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access collaborators" ON collaborators;
CREATE POLICY "Admin full access collaborators" ON collaborators
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

-- ============================================
-- 5. TRIGGERS
-- ============================================

DROP TRIGGER IF EXISTS collaborators_updated ON collaborators;
CREATE TRIGGER collaborators_updated BEFORE UPDATE ON collaborators
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
