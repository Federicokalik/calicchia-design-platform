-- Migration: 022_portal_access_codes.sql
-- Descrizione: Portal access codes per clienti + tracciamento richieste cliente
-- Data: 2026-02-13

-- 1. Codice accesso portale su customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_access_code TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_customers_portal_code
  ON customers(portal_access_code) WHERE portal_access_code IS NOT NULL;

-- 2. Tracciamento origine task (admin vs cliente)
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'admin'
  CHECK (source IN ('admin', 'client'));

-- 3. Categoria richiesta cliente
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS request_category TEXT
  CHECK (request_category IN ('bug', 'feature', 'change', 'support') OR request_category IS NULL);

-- 4. Commenti portale: user_id nullable + customer_id per commenti senza auth Supabase
ALTER TABLE project_comments ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE project_comments ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);

-- 5. Indici aggiuntivi
CREATE INDEX IF NOT EXISTS idx_tasks_source ON project_tasks(source);
CREATE INDEX IF NOT EXISTS idx_tasks_request_category ON project_tasks(request_category)
  WHERE request_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comments_customer ON project_comments(customer_id)
  WHERE customer_id IS NOT NULL;
