-- Cookie consent audit trail (GDPR + Garante 229/2021)
-- Stores anonymized consent records for compliance auditing

CREATE TABLE IF NOT EXISTS cookie_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_anonymous TEXT,                  -- Last octet zeroed (e.g., 192.168.1.0)
  preferences JSONB NOT NULL,        -- { necessary: true, analytics: false, marketing: false }
  consent_version TEXT NOT NULL,      -- Policy version at time of consent
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cleanup jobs (retention: 12 months)
CREATE INDEX IF NOT EXISTS idx_cookie_consents_created_at ON cookie_consents (created_at);

-- RLS: anyone can insert (public form), only admin can read
ALTER TABLE cookie_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY cookie_consents_insert ON cookie_consents
  FOR INSERT TO PUBLIC
  WITH CHECK (true);

CREATE POLICY cookie_consents_admin_select ON cookie_consents
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
