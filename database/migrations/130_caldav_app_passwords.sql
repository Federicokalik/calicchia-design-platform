-- 130_caldav_app_passwords.sql — password-dispositivo per CalDAV (Radicale).
--
-- I client CalDAV (DAVx5/iOS/macOS/Thunderbird) mandano Basic auth a ogni
-- richiesta. Invece della password admin (bcrypt) usiamo "app-password"
-- dedicate: token random ad alta entropia, hashati sha256, mostrati una sola
-- volta, revocabili per-dispositivo. Mirror di 065_mcp_tokens.sql.

CREATE TABLE IF NOT EXISTS caldav_app_passwords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  token_hash TEXT NOT NULL UNIQUE,        -- sha256(app-password)
  token_prefix TEXT NOT NULL,             -- primi char per identificazione UI

  username TEXT NOT NULL,                 -- username CalDAV inviato dal device (es. "federico")
  device_name TEXT NOT NULL,              -- "iPhone", "MacBook", "DAVx5 Pixel"

  -- Tracking
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  usage_count INTEGER DEFAULT 0,

  -- Lifecycle
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,                 -- NULL = no expiry
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,

  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lookup per-richiesta: per (token_hash, username) sui soli attivi.
CREATE INDEX IF NOT EXISTS idx_caldav_app_passwords_lookup
  ON caldav_app_passwords(token_hash, username)
  WHERE is_active = true AND revoked_at IS NULL;

DROP TRIGGER IF EXISTS caldav_app_passwords_updated ON caldav_app_passwords;
CREATE TRIGGER caldav_app_passwords_updated
  BEFORE UPDATE ON caldav_app_passwords
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
