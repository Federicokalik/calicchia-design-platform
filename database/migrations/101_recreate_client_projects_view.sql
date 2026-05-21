-- Migration: 101_recreate_client_projects_view.sql
-- Descrizione: Ricrea la vista client_projects_view, distrutta da una CASCADE.
-- Data: 2026-05-21
--
-- Root cause: 081_drop_woocommerce.sql esegue
--   ALTER TABLE client_projects DROP COLUMN woocommerce_order_id CASCADE;
-- La vista client_projects_view (definita in 034) seleziona `cp.*`, quindi
-- dipende da OGNI colonna di client_projects — inclusa woocommerce_order_id.
-- Il DROP COLUMN ... CASCADE ha perciò eliminato anche la vista, e nessuna
-- migrazione successiva la ricreava: su un DB migrato per intero la vista
-- non esiste e /api/client-projects/* + il dettaglio collaboratori vanno in 500.
--
-- Questa migrazione (l'ultima della sequenza) la ricrea con la definizione
-- canonica di 034. È idempotente.

DROP VIEW IF EXISTS client_projects_view CASCADE;

CREATE VIEW client_projects_view AS
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

GRANT SELECT ON client_projects_view TO authenticated;
