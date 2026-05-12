CREATE TABLE IF NOT EXISTS mcp_otp_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  token_id UUID NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,                -- sha256("482917")

  -- Triggering action (per audit / debug, non eseguita automaticamente - l'utente deve
  -- comunque ri-chiamare il tool dopo unlock)
  triggered_tool TEXT,
  triggered_args_summary TEXT,            -- es. "send_email to=user@example.com"

  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  expires_at TIMESTAMPTZ NOT NULL,        -- now() + 60s
  used_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mcp_otp_codes_token ON mcp_otp_codes(token_id, used_at) WHERE used_at IS NULL;

-- Cleanup automatico (opzionale): cron settimanale che cancella OTP scaduti
