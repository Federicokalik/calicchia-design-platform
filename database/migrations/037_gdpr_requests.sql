-- GDPR data subject requests (Artt. 15-22 GDPR)

CREATE TABLE IF NOT EXISTS gdpr_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  name TEXT,
  request_type TEXT NOT NULL CHECK (request_type IN ('access', 'rectification', 'erasure', 'restriction', 'portability', 'objection')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'rejected')),
  message TEXT,           -- Optional user message
  admin_notes TEXT,       -- Internal admin notes
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gdpr_requests_email ON gdpr_requests (email);
CREATE INDEX IF NOT EXISTS idx_gdpr_requests_status ON gdpr_requests (status);
CREATE INDEX IF NOT EXISTS idx_gdpr_requests_created_at ON gdpr_requests (created_at);

-- RLS: anyone can insert (public form), only admin can read/update
ALTER TABLE gdpr_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY gdpr_requests_insert ON gdpr_requests
  FOR INSERT TO PUBLIC
  WITH CHECK (true);

CREATE POLICY gdpr_requests_admin ON gdpr_requests
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
