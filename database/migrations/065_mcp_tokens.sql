CREATE TABLE IF NOT EXISTS mcp_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  token_hash TEXT NOT NULL UNIQUE,        -- sha256(token)
  token_prefix TEXT NOT NULL,             -- primi 12 char per identificazione UI ("mcp_abc123de")

  label TEXT NOT NULL,                    -- "MacBook personale", "iPhone", ecc.
  scope TEXT NOT NULL DEFAULT 'write'
    CHECK (scope IN ('read', 'write', 'admin')),

  -- Step-up cache: dopo OTP HIGH_RISK valido, sblocca per 5 min
  high_risk_unlocked_until TIMESTAMPTZ,

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

CREATE INDEX idx_mcp_tokens_hash ON mcp_tokens(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_mcp_tokens_active ON mcp_tokens(is_active) WHERE is_active = true AND revoked_at IS NULL;

DROP TRIGGER IF EXISTS mcp_tokens_updated ON mcp_tokens;
CREATE TRIGGER mcp_tokens_updated
  BEFORE UPDATE ON mcp_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
