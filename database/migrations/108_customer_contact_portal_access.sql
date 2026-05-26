-- 108_customer_contact_portal_access.sql
-- Customers can be managed with WhatsApp/phone as primary contact.
-- Portal access also supports collaborators as first-class portal actors.

ALTER TABLE customers ALTER COLUMN email DROP NOT NULL;

UPDATE customers
SET email = NULL
WHERE email IS NOT NULL AND btrim(email) = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'customers_email_unique_nonempty_idx'
  ) THEN
    IF NOT EXISTS (
      SELECT lower(email)
      FROM customers
      WHERE email IS NOT NULL AND btrim(email) <> ''
      GROUP BY lower(email)
      HAVING COUNT(*) > 1
    ) THEN
      CREATE UNIQUE INDEX customers_email_unique_nonempty_idx
        ON customers (lower(email))
        WHERE email IS NOT NULL AND btrim(email) <> '';
    ELSE
      RAISE NOTICE 'customers_email_unique_nonempty_idx not created: duplicate non-empty customer emails exist';
    END IF;
  END IF;
END $$;

ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS portal_access_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS portal_access_code_rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 0;

UPDATE collaborators
SET email = NULL
WHERE email IS NOT NULL AND btrim(email) = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'collaborators_email_unique_nonempty_idx'
  ) THEN
    IF NOT EXISTS (
      SELECT lower(email)
      FROM collaborators
      WHERE email IS NOT NULL AND btrim(email) <> ''
      GROUP BY lower(email)
      HAVING COUNT(*) > 1
    ) THEN
      CREATE UNIQUE INDEX collaborators_email_unique_nonempty_idx
        ON collaborators (lower(email))
        WHERE email IS NOT NULL AND btrim(email) <> '';
    ELSE
      RAISE NOTICE 'collaborators_email_unique_nonempty_idx not created: duplicate non-empty collaborator emails exist';
    END IF;
  END IF;
END $$;
