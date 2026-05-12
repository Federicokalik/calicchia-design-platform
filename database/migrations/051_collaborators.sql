-- 051: Collaborators

CREATE TABLE IF NOT EXISTS collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  type TEXT DEFAULT 'partner',
  specialization TEXT,
  commission_rate NUMERIC(5,2),
  notes TEXT,
  status TEXT DEFAULT 'active',
  total_projects INT DEFAULT 0,
  total_revenue NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS collaborator_id UUID REFERENCES collaborators(id);
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS referred_by TEXT;

CREATE INDEX IF NOT EXISTS idx_collaborators_status ON collaborators(status);
