-- 082: Portal access code hash columns
-- Completa lo storage hashed per clienti e collaboratori.

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS portal_access_code_hash TEXT;

ALTER TABLE public.collaborators
  ADD COLUMN IF NOT EXISTS portal_access_code_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_portal_access_code_hash
  ON public.customers(portal_access_code_hash)
  WHERE portal_access_code_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_collaborators_portal_access_code_hash
  ON public.collaborators(portal_access_code_hash)
  WHERE portal_access_code_hash IS NOT NULL;

COMMIT;
