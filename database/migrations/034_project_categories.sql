-- 034: Add project_category to client_projects
-- Replaces the old project_type enum with a broader category system

DO $$ BEGIN
  CREATE TYPE project_category AS ENUM (
    'grafica', 'web', 'ecommerce', 'webapp', 'marketing', 'consulenza'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Add new column
ALTER TABLE client_projects
  ADD COLUMN IF NOT EXISTS project_category project_category;

-- Migrate existing project_type values to project_category
UPDATE client_projects SET project_category = 'web'
  WHERE project_type IN ('website', 'landing_page') AND project_category IS NULL;
UPDATE client_projects SET project_category = 'ecommerce'
  WHERE project_type = 'ecommerce' AND project_category IS NULL;
UPDATE client_projects SET project_category = 'consulenza'
  WHERE project_type IN ('consulting', 'maintenance') AND project_category IS NULL;
UPDATE client_projects SET project_category = 'grafica'
  WHERE project_type = 'other' AND project_category IS NULL;
UPDATE client_projects SET project_category = 'web'
  WHERE project_type = 'website_template' AND project_category IS NULL;

-- Default remaining NULLs
UPDATE client_projects SET project_category = 'consulenza'
  WHERE project_category IS NULL;

-- Refresh the view to include new column
CREATE OR REPLACE VIEW client_projects_view AS
SELECT
  cp.*,
  cu.contact_name AS customer_name,
  cu.company_name AS customer_company,
  cu.email AS customer_email,
  p.email AS assignee_email,
  co.contact_name AS collaborator_name,
  co.company_name AS collaborator_company,
  co.email AS collaborator_email,
  COALESCE(ts.total_tasks, 0)::int AS total_tasks,
  COALESCE(ts.completed_tasks, 0)::int AS completed_tasks,
  COALESCE(ms.total_milestones, 0)::int AS total_milestones,
  COALESCE(ms.completed_milestones, 0)::int AS completed_milestones,
  CASE
    WHEN cp.target_end_date IS NOT NULL
      AND cp.target_end_date < CURRENT_DATE
      AND cp.status NOT IN ('completed', 'cancelled')
    THEN true ELSE false
  END AS is_overdue
FROM client_projects cp
LEFT JOIN customers cu ON cu.id = cp.customer_id
LEFT JOIN profiles p ON p.id = cp.assigned_to
LEFT JOIN collaborators co ON co.id = cp.collaborator_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::int AS total_tasks,
    COUNT(*) FILTER (WHERE status = 'done')::int AS completed_tasks
  FROM project_tasks WHERE project_id = cp.id
) ts ON true
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::int AS total_milestones,
    COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_milestones
  FROM project_milestones WHERE project_id = cp.id
) ms ON true;
