-- Migration 156 — Appunti interni sul progetto cliente.
--
-- Il tab "Note" del dettaglio progetto nell'admin si presentava come
-- "Appunti interni" ma scriveva in client_projects.client_notes, che il
-- portale clienti mostra al cliente (descrizione della card in dashboard).
-- Gli appunti interni hanno ora una colonna propria, mai selezionata dalle
-- route del portale; client_notes resta la nota visibile al cliente.
--
-- Nessuno spostamento automatico dei dati: quanto già scritto in
-- client_notes è stato finora visibile al cliente e va rivisto a mano
-- dall'admin (il tab Note ora mostra i due campi separati).

ALTER TABLE public.client_projects
  ADD COLUMN IF NOT EXISTS internal_notes TEXT DEFAULT NULL;

-- client_projects_view seleziona `cp.*`, che Postgres espande alla creazione:
-- senza ricrearla la nuova colonna non arriva a GET /api/client-projects/:id.
-- Stessa definizione canonica di 101_recreate_client_projects_view.sql.
-- Nessun'altra vista dipende da client_projects_view.

DROP VIEW IF EXISTS client_projects_view;

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
