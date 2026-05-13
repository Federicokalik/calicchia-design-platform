-- 083: Drop plaintext portal access code columns
-- Eseguire SOLO dopo aver verificato che migrate-portal-codes.ts ha completato in tutti gli ambienti.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.customers
    WHERE portal_access_code IS NOT NULL
      AND portal_access_code != ''
      AND portal_access_code_hash IS NULL
  ) THEN
    RAISE EXCEPTION 'customers.portal_access_code contiene valori non migrati';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.collaborators
    WHERE portal_access_code IS NOT NULL
      AND portal_access_code != ''
      AND portal_access_code_hash IS NULL
  ) THEN
    RAISE EXCEPTION 'collaborators.portal_access_code contiene valori non migrati';
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_customers_portal_code;
DROP INDEX IF EXISTS public.idx_collaborators_portal_code;

ALTER TABLE public.customers
  DROP COLUMN IF EXISTS portal_access_code CASCADE;

ALTER TABLE public.collaborators
  DROP COLUMN IF EXISTS portal_access_code CASCADE;

COMMIT;
