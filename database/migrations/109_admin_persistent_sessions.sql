-- 109_admin_persistent_sessions.sql
-- Revocable "remember this device" refresh sessions for admin users.

CREATE TABLE IF NOT EXISTS admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_id
  ON admin_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_active
  ON admin_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;
