-- Migration: 009_client_projects.sql
-- Descrizione: Sistema Gestione Progetti Cliente con Task e Time Tracking
-- Data: 2026-01-20

-- =====================================================
-- ENUM TYPES
-- =====================================================

DO $$ BEGIN
  CREATE TYPE project_type AS ENUM (
    'website', 'landing_page', 'ecommerce', 'maintenance', 'website_template', 'consulting', 'other'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE project_status AS ENUM (
    'draft', 'proposal', 'approved', 'in_progress', 'review',
    'completed', 'on_hold', 'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM (
    'todo', 'in_progress', 'review', 'done', 'blocked'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================
-- TABELLA CLIENT_PROJECTS
-- Progetti cliente (distinti da portfolio projects)
-- =====================================================

CREATE TABLE IF NOT EXISTS client_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES profiles(id),
  woocommerce_order_id UUID REFERENCES woocommerce_orders(id),
  subscription_id UUID REFERENCES subscriptions(id),

  -- Info base
  name TEXT NOT NULL,
  description TEXT,
  project_type project_type DEFAULT 'website',
  status project_status DEFAULT 'draft',
  priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),

  -- Date
  start_date DATE,
  target_end_date DATE,
  actual_end_date DATE,

  -- Budget e ore
  budget_amount DECIMAL(10,2),
  estimated_hours DECIMAL(8,2),
  actual_hours DECIMAL(8,2) DEFAULT 0,
  hourly_rate DECIMAL(10,2),
  currency TEXT DEFAULT 'EUR',

  -- URLs
  staging_url TEXT,
  production_url TEXT,
  repo_url TEXT,
  figma_url TEXT,

  -- Progress
  progress_percentage INTEGER DEFAULT 0 CHECK (progress_percentage >= 0 AND progress_percentage <= 100),

  -- Visibilità
  visible_to_client BOOLEAN DEFAULT true,
  client_notes TEXT, -- Note visibili al cliente

  -- Metadata
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici
CREATE INDEX idx_client_projects_customer ON client_projects(customer_id);
CREATE INDEX idx_client_projects_status ON client_projects(status);
CREATE INDEX idx_client_projects_assigned ON client_projects(assigned_to);
CREATE INDEX idx_client_projects_wc_order ON client_projects(woocommerce_order_id);

-- =====================================================
-- TABELLA PROJECT_MILESTONES
-- Milestone/fasi del progetto
-- =====================================================

CREATE TABLE IF NOT EXISTS project_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  completed_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
  sort_order INTEGER DEFAULT 0,
  visible_to_client BOOLEAN DEFAULT true,
  deliverables JSONB DEFAULT '[]', -- Lista deliverable

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_milestones_project ON project_milestones(project_id);

-- =====================================================
-- TABELLA PROJECT_TASKS
-- Task del progetto
-- =====================================================

CREATE TABLE IF NOT EXISTS project_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  milestone_id UUID REFERENCES project_milestones(id) ON DELETE SET NULL,
  parent_task_id UUID REFERENCES project_tasks(id) ON DELETE CASCADE,

  title TEXT NOT NULL,
  description TEXT,
  status task_status DEFAULT 'todo',
  priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),

  assigned_to UUID REFERENCES profiles(id),
  due_date DATE,

  estimated_hours DECIMAL(6,2),
  actual_hours DECIMAL(6,2) DEFAULT 0,

  -- Checklist items
  checklist JSONB DEFAULT '[]', -- [{id, text, done}]

  visible_to_client BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  tags TEXT[] DEFAULT '{}',

  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tasks_project ON project_tasks(project_id);
CREATE INDEX idx_tasks_milestone ON project_tasks(milestone_id);
CREATE INDEX idx_tasks_parent ON project_tasks(parent_task_id);
CREATE INDEX idx_tasks_assigned ON project_tasks(assigned_to);
CREATE INDEX idx_tasks_status ON project_tasks(status);

-- =====================================================
-- TABELLA TIME_ENTRIES
-- Registrazione tempo lavorato
-- =====================================================

CREATE TABLE IF NOT EXISTS time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES project_tasks(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES profiles(id),

  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  duration_minutes INTEGER, -- Calcolato o inserito manualmente

  description TEXT,
  is_billable BOOLEAN DEFAULT true,
  is_billed BOOLEAN DEFAULT false,
  invoice_id UUID REFERENCES invoices(id),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_time_entries_project ON time_entries(project_id);
CREATE INDEX idx_time_entries_task ON time_entries(task_id);
CREATE INDEX idx_time_entries_user ON time_entries(user_id);
CREATE INDEX idx_time_entries_date ON time_entries(start_time);

-- =====================================================
-- TABELLA PROJECT_COMMENTS
-- Commenti su progetti e task
-- =====================================================

CREATE TABLE IF NOT EXISTS project_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES project_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id),

  content TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT false, -- Se true, non visibile ai clienti
  attachments JSONB DEFAULT '[]', -- [{url, name, type, size}]

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_comments_project ON project_comments(project_id);
CREATE INDEX idx_comments_task ON project_comments(task_id);

-- =====================================================
-- TABELLA PROJECT_FILES
-- File allegati al progetto
-- =====================================================

CREATE TABLE IF NOT EXISTS project_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES project_tasks(id) ON DELETE SET NULL,
  uploaded_by UUID REFERENCES profiles(id),

  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  category TEXT DEFAULT 'general', -- design, document, asset, deliverable
  visible_to_client BOOLEAN DEFAULT true,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_project_files_project ON project_files(project_id);

-- =====================================================
-- FUNZIONI E TRIGGERS
-- =====================================================

-- Calcola durata time entry
CREATE OR REPLACE FUNCTION calculate_time_entry_duration()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.end_time IS NOT NULL AND NEW.start_time IS NOT NULL THEN
    NEW.duration_minutes := EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) / 60;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS time_entry_calc_duration ON time_entries;
CREATE TRIGGER time_entry_calc_duration
  BEFORE INSERT OR UPDATE ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION calculate_time_entry_duration();

-- Aggiorna ore progetto quando cambia time_entries
CREATE OR REPLACE FUNCTION update_project_actual_hours()
RETURNS TRIGGER AS $$
DECLARE
  v_project_id UUID;
BEGIN
  v_project_id := COALESCE(NEW.project_id, OLD.project_id);

  UPDATE client_projects
  SET actual_hours = (
    SELECT COALESCE(SUM(duration_minutes) / 60.0, 0)
    FROM time_entries
    WHERE project_id = v_project_id
  ),
  updated_at = NOW()
  WHERE id = v_project_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS time_entry_update_project_hours ON time_entries;
CREATE TRIGGER time_entry_update_project_hours
  AFTER INSERT OR UPDATE OR DELETE ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION update_project_actual_hours();

-- Aggiorna ore task quando cambia time_entries
CREATE OR REPLACE FUNCTION update_task_actual_hours()
RETURNS TRIGGER AS $$
DECLARE
  v_task_id UUID;
BEGIN
  v_task_id := COALESCE(NEW.task_id, OLD.task_id);

  IF v_task_id IS NOT NULL THEN
    UPDATE project_tasks
    SET actual_hours = (
      SELECT COALESCE(SUM(duration_minutes) / 60.0, 0)
      FROM time_entries
      WHERE task_id = v_task_id
    ),
    updated_at = NOW()
    WHERE id = v_task_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS time_entry_update_task_hours ON time_entries;
CREATE TRIGGER time_entry_update_task_hours
  AFTER INSERT OR UPDATE OR DELETE ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION update_task_actual_hours();

-- Aggiorna progress progetto basato su task completati
CREATE OR REPLACE FUNCTION update_project_progress()
RETURNS TRIGGER AS $$
DECLARE
  v_project_id UUID;
  v_total INTEGER;
  v_done INTEGER;
BEGIN
  v_project_id := COALESCE(NEW.project_id, OLD.project_id);

  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'done')
  INTO v_total, v_done
  FROM project_tasks
  WHERE project_id = v_project_id
    AND parent_task_id IS NULL; -- Solo task principali

  IF v_total > 0 THEN
    UPDATE client_projects
    SET progress_percentage = (v_done * 100 / v_total),
        updated_at = NOW()
    WHERE id = v_project_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_update_project_progress ON project_tasks;
CREATE TRIGGER task_update_project_progress
  AFTER INSERT OR UPDATE OF status OR DELETE ON project_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_project_progress();

-- Set completed_at quando task va a done
CREATE OR REPLACE FUNCTION set_task_completed_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'done' AND (OLD.status IS NULL OR OLD.status != 'done') THEN
    NEW.completed_at := NOW();
  ELSIF NEW.status != 'done' THEN
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_set_completed_at ON project_tasks;
CREATE TRIGGER task_set_completed_at
  BEFORE UPDATE ON project_tasks
  FOR EACH ROW
  EXECUTE FUNCTION set_task_completed_at();

-- Updated_at triggers
DROP TRIGGER IF EXISTS update_client_projects_updated_at ON client_projects;
CREATE TRIGGER update_client_projects_updated_at
  BEFORE UPDATE ON client_projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_milestones_updated_at ON project_milestones;
CREATE TRIGGER update_milestones_updated_at
  BEFORE UPDATE ON project_milestones
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_tasks_updated_at ON project_tasks;
CREATE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON project_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_time_entries_updated_at ON time_entries;
CREATE TRIGGER update_time_entries_updated_at
  BEFORE UPDATE ON time_entries
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- RLS POLICIES
-- =====================================================

ALTER TABLE client_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_files ENABLE ROW LEVEL SECURITY;

-- CLIENT_PROJECTS
DROP POLICY IF EXISTS "Admin full access client_projects" ON client_projects;
CREATE POLICY "Admin full access client_projects" ON client_projects
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Clients view own projects" ON client_projects;
CREATE POLICY "Clients view own projects" ON client_projects
  FOR SELECT TO authenticated
  USING (
    customer_id = ANY(get_user_customer_ids())
    AND visible_to_client = true
  );

-- MILESTONES
DROP POLICY IF EXISTS "Admin full access milestones" ON project_milestones;
CREATE POLICY "Admin full access milestones" ON project_milestones
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Clients view own milestones" ON project_milestones;
CREATE POLICY "Clients view own milestones" ON project_milestones
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT id FROM client_projects
      WHERE customer_id = ANY(get_user_customer_ids())
        AND visible_to_client = true
    )
    AND visible_to_client = true
  );

-- TASKS
DROP POLICY IF EXISTS "Admin full access tasks" ON project_tasks;
CREATE POLICY "Admin full access tasks" ON project_tasks
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Clients view own tasks" ON project_tasks;
CREATE POLICY "Clients view own tasks" ON project_tasks
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT id FROM client_projects
      WHERE customer_id = ANY(get_user_customer_ids())
        AND visible_to_client = true
    )
    AND visible_to_client = true
  );

-- TIME_ENTRIES (solo admin)
DROP POLICY IF EXISTS "Admin full access time_entries" ON time_entries;
CREATE POLICY "Admin full access time_entries" ON time_entries
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- COMMENTS
DROP POLICY IF EXISTS "Admin full access comments" ON project_comments;
CREATE POLICY "Admin full access comments" ON project_comments
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Clients view non-internal comments" ON project_comments;
CREATE POLICY "Clients view non-internal comments" ON project_comments
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT id FROM client_projects
      WHERE customer_id = ANY(get_user_customer_ids())
    )
    AND is_internal = false
  );

DROP POLICY IF EXISTS "Clients insert comments" ON project_comments;
CREATE POLICY "Clients insert comments" ON project_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT id FROM client_projects
      WHERE customer_id = ANY(get_user_customer_ids())
    )
    AND is_internal = false
    AND user_id = auth.uid()
  );

-- FILES
DROP POLICY IF EXISTS "Admin full access files" ON project_files;
CREATE POLICY "Admin full access files" ON project_files
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Clients view own files" ON project_files;
CREATE POLICY "Clients view own files" ON project_files
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT id FROM client_projects
      WHERE customer_id = ANY(get_user_customer_ids())
    )
    AND visible_to_client = true
  );

-- =====================================================
-- VISTE
-- =====================================================

-- Vista progetti con statistiche
CREATE OR REPLACE VIEW client_projects_view AS
SELECT
  cp.*,
  c.contact_name AS customer_name,
  c.company_name AS customer_company,
  c.email AS customer_email,
  p.email AS assignee_email,
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
LEFT JOIN profiles p ON p.id = cp.assigned_to;

-- Vista time entries con dettagli
CREATE OR REPLACE VIEW time_entries_view AS
SELECT
  te.*,
  cp.name AS project_name,
  pt.title AS task_title,
  p.email AS user_email,
  c.contact_name AS customer_name
FROM time_entries te
JOIN client_projects cp ON cp.id = te.project_id
LEFT JOIN project_tasks pt ON pt.id = te.task_id
JOIN profiles p ON p.id = te.user_id
JOIN customers c ON c.id = cp.customer_id;

-- Vista report ore per progetto
CREATE OR REPLACE VIEW project_hours_report AS
SELECT
  cp.id AS project_id,
  cp.name AS project_name,
  c.contact_name AS customer_name,
  cp.estimated_hours,
  cp.actual_hours,
  cp.budget_amount,
  cp.hourly_rate,
  CASE
    WHEN cp.hourly_rate > 0 THEN cp.actual_hours * cp.hourly_rate
    ELSE 0
  END AS actual_cost,
  CASE
    WHEN cp.estimated_hours > 0 THEN
      ROUND((cp.actual_hours / cp.estimated_hours * 100)::numeric, 1)
    ELSE 0
  END AS hours_percentage,
  (SELECT SUM(duration_minutes) FILTER (WHERE is_billable AND NOT is_billed)
   FROM time_entries WHERE project_id = cp.id) AS unbilled_minutes
FROM client_projects cp
JOIN customers c ON c.id = cp.customer_id;

-- Vista progetti per portal cliente
CREATE OR REPLACE VIEW portal_projects AS
SELECT
  cp.id,
  cp.name,
  cp.description,
  cp.project_type,
  cp.status,
  cp.start_date,
  cp.target_end_date,
  cp.progress_percentage,
  cp.staging_url,
  cp.production_url,
  cp.client_notes,
  cp.customer_id,
  (SELECT COUNT(*) FROM project_tasks WHERE project_id = cp.id AND visible_to_client = true) AS visible_tasks,
  (SELECT COUNT(*) FROM project_tasks WHERE project_id = cp.id AND visible_to_client = true AND status = 'done') AS completed_visible_tasks,
  (SELECT COUNT(*) FROM project_milestones WHERE project_id = cp.id AND visible_to_client = true) AS visible_milestones
FROM client_projects cp
WHERE cp.customer_id = ANY(get_user_customer_ids())
  AND cp.visible_to_client = true
ORDER BY cp.created_at DESC;

-- =====================================================
-- GRANTS
-- =====================================================

GRANT SELECT ON client_projects_view TO authenticated;
GRANT SELECT ON time_entries_view TO authenticated;
GRANT SELECT ON project_hours_report TO authenticated;
GRANT SELECT ON portal_projects TO authenticated;
