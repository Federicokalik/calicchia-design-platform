-- 079: Portal auth hardening
--   - Magic link flow: portal_login_tokens (token_hash, expires_at, used_at)
--   - Audit trail: portal_login_events
--   - Session revocation: customers.session_version (incrementing → invalida JWT)
--   - At-rest hashing: customers.portal_access_code_hash (bcrypt)
--
-- Strategy: nuove colonne nullable con rimozione della colonna legacy in migration dedicata.
-- Backfill bcrypt via script tsx separato (apps/api/scripts/backfill-portal-codes.ts).
-- Colonna legacy rimossa dopo backfill.

-- ─────────────────────────────────────────────────────────
-- portal_login_tokens — magic link single-use tokens
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.portal_login_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ NULL,
  requested_ip INET NULL,
  requested_ua TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_login_tokens_hash
  ON public.portal_login_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_portal_login_tokens_customer_unused
  ON public.portal_login_tokens(customer_id)
  WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_portal_login_tokens_expires
  ON public.portal_login_tokens(expires_at)
  WHERE used_at IS NULL;

-- ─────────────────────────────────────────────────────────
-- portal_login_events — audit trail
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.portal_login_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NULL REFERENCES public.customers(id) ON DELETE SET NULL,
  email TEXT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'link_requested',
    'link_consumed',
    'link_invalid',
    'link_expired',
    'code_login_success',
    'code_login_failed',
    'logout',
    'sessions_revoked'
  )),
  success BOOLEAN NOT NULL DEFAULT false,
  ip INET NULL,
  user_agent TEXT NULL,
  error_code TEXT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_login_events_customer
  ON public.portal_login_events(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_login_events_type
  ON public.portal_login_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_login_events_email
  ON public.portal_login_events(email)
  WHERE email IS NOT NULL;

-- ─────────────────────────────────────────────────────────
-- customers: hardening columns
-- ─────────────────────────────────────────────────────────

-- Session version — incrementato dall'admin per invalidare TUTTI i JWT esistenti.
-- Embedded nel JWT payload; portalAuth middleware ricompara ad ogni request.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 0;

-- Bcrypt hash del portal_access_code. Colonna nuova per la migrazione
-- dalla colonna legacy verso storage hashed.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS portal_access_code_hash TEXT NULL;

-- Timestamp ultima rotazione del codice — per rotazione forzata 90gg (futura).
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS portal_access_code_rotated_at TIMESTAMPTZ NULL;
