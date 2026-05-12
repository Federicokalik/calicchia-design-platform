-- ============================================================
-- 047: Admin Redesign — Leads + Payment Tracker + AI + Dashboard
-- ============================================================

-- Pipeline Lead (sostituisce il flusso contacts → customers)
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  source TEXT DEFAULT 'manual',
  source_id TEXT,
  status TEXT DEFAULT 'new',
  estimated_value NUMERIC(10,2),
  notes TEXT,
  tags TEXT[] DEFAULT '{}',
  lost_reason TEXT,
  converted_customer_id UUID REFERENCES customers(id),
  converted_project_id UUID REFERENCES client_projects(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Payment tracker (sostituisce invoices + quotes + payments)
CREATE TABLE IF NOT EXISTS payment_tracker (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  project_id UUID REFERENCES client_projects(id),
  description TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  status TEXT DEFAULT 'emessa',
  due_date DATE,
  paid_date DATE,
  paid_amount NUMERIC(10,2) DEFAULT 0,
  external_ref TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Note cliente (log interazioni)
CREATE TABLE IF NOT EXISTS customer_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'note',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- AI conversations
CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  context_type TEXT,
  context_id TEXT,
  messages JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- AI actions log
CREATE TABLE IF NOT EXISTS ai_actions_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES ai_conversations(id),
  action_type TEXT NOT NULL,
  input JSONB,
  output JSONB,
  status TEXT DEFAULT 'completed',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Dashboard widget layout
CREATE TABLE IF NOT EXISTS dashboard_layouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  layout JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Add lead_id to customers for conversion tracking
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

-- Add tags to client_projects
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_tracker_customer ON payment_tracker(customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_tracker_status ON payment_tracker(status);
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes(customer_id);
