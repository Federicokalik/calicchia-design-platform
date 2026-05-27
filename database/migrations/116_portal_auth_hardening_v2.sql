-- 116_portal_auth_hardening_v2.sql
-- Audit B-009 + B-010 + B-011.
--
-- B-009: findActorByCode currently scans every row with portal_access_code_hash
-- and runs bcrypt.compare on each — O(N) per login attempt. Add a 4-char
-- indexed prefix derived from the code so the WHERE filter reduces the
-- bcrypt loop to ~1 candidate. Prefix is stored at code-rotation time; old
-- rows without a prefix still work (the lookup falls back to the full scan
-- only when no prefix matches).
--
-- B-010 (partial): the codes themselves are bumped to 128-bit entropy in the
-- rotate* helpers in routes/customers.ts + routes/collaborators-v2.ts. The
-- visible PRJ-/COL- prefix is intentionally kept to avoid invalidating every
-- emailed onboarding link; the type-leak via prefix is acceptable trade-off.
--
-- B-011: portal_login_events.customer_id is FK on customers, so collaborator
-- logins are inserted with customer_id NULL and we can't tell who logged in.
-- Add actor_id + actor_role columns alongside the existing customer_id (kept
-- for back-compat with existing analytics) and drop the FK (the actor may
-- now be a collaborator, and the row should survive the deletion of either
-- parent anyway — soft pointer, not a referential integrity guarantee).

-- B-009: lookup prefix
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS portal_access_code_prefix TEXT;
CREATE INDEX IF NOT EXISTS idx_customers_portal_code_prefix
  ON customers (portal_access_code_prefix)
  WHERE portal_access_code_prefix IS NOT NULL;

ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS portal_access_code_prefix TEXT;
CREATE INDEX IF NOT EXISTS idx_collaborators_portal_code_prefix
  ON collaborators (portal_access_code_prefix)
  WHERE portal_access_code_prefix IS NOT NULL;

-- B-011: actor_id + actor_role, drop the customer_id FK so a collaborator
-- audit row doesn't violate the FK at insert time.
ALTER TABLE portal_login_events
  ADD COLUMN IF NOT EXISTS actor_id UUID,
  ADD COLUMN IF NOT EXISTS actor_role TEXT
    CHECK (actor_role IS NULL OR actor_role IN ('client', 'collaborator'));

ALTER TABLE portal_login_events
  DROP CONSTRAINT IF EXISTS portal_login_events_customer_id_fkey;

CREATE INDEX IF NOT EXISTS idx_portal_login_events_actor
  ON portal_login_events (actor_role, actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;
