-- Migration: 098_collaborators_reconcile.sql
-- Descrizione: Riconcilia la collisione sulla tabella `collaborators` (MG-01 / DB-02).
-- Data: 2026-05-21
--
-- Root cause: due migrazioni storiche creano la stessa tabella con CREATE TABLE
-- IF NOT EXISTS. Su un DB creato da zero vince la prima nell'ordine:
--   * 024_collaborators.sql  -> colonne: contact_name, company_name, billing_address,
--     tags, total_revenue, lifetime_value, stripe_customer_id, portal_access_code, ...
--   * 051_collaborators.sql  -> CREATE TABLE diventa un no-op; restano solo i suoi
--     ALTER su client_projects (collaborator_id, referred_by) e l'indice di status.
-- Risultato: la tabella live ha la forma "024", ma la route /api/collaborators-v2
-- e la UI admin (pagina Collaboratori) si aspettano la forma "051"
--   (name, company, type, specialization, commission_rate, total_projects)
-- -> ogni chiamata a /api/collaborators-v2 fallisce con "column ... does not exist".
--
-- Fix: questa migrazione canonica porta la tabella all'UNIONE delle due forme,
-- così funzionano sia la route v1 (collaborators.ts) sia la v2 (collaborators-v2.ts).
-- È puramente additiva (ADD COLUMN) + rilassa due NOT NULL: nessuna perdita di dati.

-- 1. Colonne attese da collaborators-v2.ts (forma "051").
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS name            TEXT;
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS company         TEXT;
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS type            TEXT DEFAULT 'partner';
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS specialization  TEXT;
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2);
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS total_projects  INTEGER DEFAULT 0;

-- 2. Backfill: popola le colonne v2 dai dati eventualmente già presenti nella
--    forma v1 (idempotente — riscrive solo dove la colonna v2 è ancora NULL).
UPDATE collaborators SET name    = contact_name WHERE name    IS NULL AND contact_name IS NOT NULL;
UPDATE collaborators SET company = company_name WHERE company IS NULL AND company_name IS NOT NULL;

-- 3. Rilassa i NOT NULL sulle colonne presenti solo nella forma v1: la route v2
--    inserisce (name, company, email, ...) senza valorizzare contact_name, e può
--    inserire email NULL. Allineato alla forma "051" dove email è nullable.
ALTER TABLE collaborators ALTER COLUMN contact_name DROP NOT NULL;
ALTER TABLE collaborators ALTER COLUMN email        DROP NOT NULL;
