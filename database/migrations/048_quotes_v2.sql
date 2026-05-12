-- ============================================================
-- 048: Quotes v2 — Preventivi con firma digitale FEA
-- ============================================================

CREATE TABLE IF NOT EXISTS quotes_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  lead_id UUID REFERENCES leads(id),

  -- Contenuto
  title TEXT NOT NULL,
  description TEXT,
  items JSONB DEFAULT '[]',
  subtotal NUMERIC(10,2) DEFAULT 0,
  tax_rate NUMERIC(5,2) DEFAULT 22,
  tax_amount NUMERIC(10,2) DEFAULT 0,
  total NUMERIC(10,2) DEFAULT 0,
  currency TEXT DEFAULT 'EUR',
  valid_until DATE,
  notes TEXT,
  internal_notes TEXT,

  -- Stato
  status TEXT DEFAULT 'draft',

  -- PDF
  pdf_path TEXT,
  signed_pdf_path TEXT,

  -- Firma digitale (FEA)
  signature_token UUID DEFAULT gen_random_uuid(),
  otp_code TEXT,
  otp_expires_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  signer_name TEXT,
  signer_email TEXT,
  signature_image TEXT,
  signature_ip TEXT,
  signature_user_agent TEXT,
  pdf_hash_sha256 TEXT,

  -- Invio
  sent_via TEXT[] DEFAULT '{}',
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,

  -- Checklist materiali
  materials_checklist JSONB DEFAULT '[]',
  materials_complete BOOLEAN DEFAULT false,

  -- Progetto collegato
  project_id UUID REFERENCES client_projects(id),
  auto_create_project BOOLEAN DEFAULT true,
  project_template JSONB,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Audit trail firme (immutabile)
CREATE TABLE IF NOT EXISTS signature_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes_v2(id),
  action TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_quotes_v2_customer ON quotes_v2(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_v2_status ON quotes_v2(status);
CREATE INDEX IF NOT EXISTS idx_quotes_v2_token ON quotes_v2(signature_token);
CREATE INDEX IF NOT EXISTS idx_signature_audit_quote ON signature_audit_log(quote_id);
