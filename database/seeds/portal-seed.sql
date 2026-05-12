-- Portal Seed Data
-- Run: docker exec -i caldes2026-db-export-postgres-1 psql -U caldes -d caldes < database/seeds/portal-seed.sql

-- Set portal access codes on existing customers (first 3)
UPDATE customers SET portal_access_code = 'TESTPORTAL'
WHERE id = (SELECT id FROM customers ORDER BY created_at ASC LIMIT 1)
  AND portal_access_code IS NULL;

-- Add pipeline_steps to first project
UPDATE client_projects
SET pipeline_steps = '["Analisi", "Design", "Sviluppo", "Test", "Go Live"]'::jsonb,
    current_step = 2
WHERE id = (SELECT id FROM client_projects ORDER BY created_at ASC LIMIT 1);

-- Insert sample timeline events for first project/customer pair
DO $$
DECLARE
  v_project_id UUID;
  v_customer_id UUID;
BEGIN
  SELECT cp.id, cp.customer_id INTO v_project_id, v_customer_id
  FROM client_projects cp
  ORDER BY cp.created_at ASC LIMIT 1;

  IF v_project_id IS NULL THEN
    RAISE NOTICE 'No projects found, skipping timeline seed';
    RETURN;
  END IF;

  -- Insert timeline events
  INSERT INTO timeline_events (project_id, customer_id, type, title, description, actor_type, created_at)
  VALUES
    (v_project_id, v_customer_id, 'status_change', 'Progetto avviato', 'Lo sviluppo del tuo progetto e'' iniziato!', 'admin', NOW() - INTERVAL '14 days'),
    (v_project_id, v_customer_id, 'deliverable_added', 'Mockup Homepage caricato', 'La prima bozza della homepage e'' pronta per la revisione.', 'admin', NOW() - INTERVAL '10 days'),
    (v_project_id, v_customer_id, 'deliverable_approved', 'Mockup Homepage approvato', 'Grazie per il feedback!', 'client', NOW() - INTERVAL '8 days'),
    (v_project_id, v_customer_id, 'status_change', 'Fase Sviluppo iniziata', 'Passiamo alla fase di sviluppo.', 'admin', NOW() - INTERVAL '7 days'),
    (v_project_id, v_customer_id, 'file_requested', 'Materiale richiesto: Logo in formato vettoriale', 'Abbiamo bisogno del logo in formato SVG o AI per procedere.', 'admin', NOW() - INTERVAL '5 days'),
    (v_project_id, v_customer_id, 'file_uploaded', 'File caricato: logo-aziendale.svg', 'Dimensione: 245 KB', 'client', NOW() - INTERVAL '4 days'),
    (v_project_id, v_customer_id, 'message', 'Messaggio da Federico', 'Ho integrato il logo nel design. Procedo con le pagine interne.', 'admin', NOW() - INTERVAL '3 days'),
    (v_project_id, v_customer_id, 'note', 'Aggiornamento settimanale', 'Sviluppo al 60%. Prevista consegna bozza completa entro venerdi''.', 'admin', NOW() - INTERVAL '1 day')
  ON CONFLICT DO NOTHING;

  -- Insert a pending action
  INSERT INTO timeline_events (project_id, customer_id, type, title, description, action_required, action_type, actor_type)
  VALUES (v_project_id, v_customer_id, 'deliverable_added', 'Bozza pagine interne pronta', 'Abbiamo caricato la bozza delle pagine Chi Siamo e Contatti. Approvale o richiedi modifiche.', true, 'approve', 'admin')
  ON CONFLICT DO NOTHING;

  -- Insert sample report
  INSERT INTO portal_reports (customer_id, project_id, month, year, title, summary, data, published_at)
  VALUES (
    v_customer_id, v_project_id, 3, 2026,
    'Report Marzo 2026',
    'Attivita'' svolte nel mese di Marzo: completamento design, inizio sviluppo, configurazione hosting.',
    '{
      "visits": [
        {"month": "Gen", "value": 120},
        {"month": "Feb", "value": 185},
        {"month": "Mar", "value": 310}
      ],
      "keywords": [
        {"keyword": "web design professionale", "position": 5},
        {"keyword": "agenzia web", "position": 12},
        {"keyword": "sito web aziendale", "position": 3}
      ],
      "uptime": 99.8,
      "activities": [
        "Completamento mockup homepage e pagine interne",
        "Configurazione hosting e dominio",
        "Inizio sviluppo frontend con Astro",
        "Ottimizzazione SEO on-page",
        "Setup analytics e tracciamento"
      ]
    }'::jsonb,
    NOW()
  )
  ON CONFLICT (customer_id, year, month) DO NOTHING;
END $$;
