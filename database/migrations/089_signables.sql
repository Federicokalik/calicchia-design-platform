-- ============================================================
-- 089: Signables - documenti firmabili generici (NDA, contratti, SOW)
-- Riusa pattern OTP+signature pad di quotes_v2 ma indipendente.
-- ============================================================

CREATE TABLE IF NOT EXISTS signable_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('nda','contract','sow','other')),
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,

  -- Cliente firmatario (opzionale: si puo' inviare anche a contatto extra-anagrafica)
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  signer_name TEXT,
  signer_email TEXT,
  signer_phone TEXT,

  -- Canale firma + OTP
  signature_method TEXT NOT NULL DEFAULT 'email_otp' CHECK (signature_method IN ('email_otp','sms_otp')),
  sign_token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  otp_code TEXT,
  otp_expires_at TIMESTAMPTZ,

  -- Stato
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','viewed','signed','expired','cancelled')),
  expires_at TIMESTAMPTZ,

  -- Risultato firma
  signed_at TIMESTAMPTZ,
  signature_image TEXT,
  signer_ip TEXT,
  signer_user_agent TEXT,
  pdf_hash_sha256 TEXT,

  -- Tracking invio
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,

  -- Metadata libero (es. variables del template usato)
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signable_documents_status_idx ON signable_documents(status);
CREATE INDEX IF NOT EXISTS signable_documents_customer_idx ON signable_documents(customer_id);
CREATE INDEX IF NOT EXISTS signable_documents_token_idx ON signable_documents(sign_token);
CREATE INDEX IF NOT EXISTS signable_documents_type_idx ON signable_documents(type);

-- Audit immutabile (struttura parallela a signature_audit_log per quotes_v2)
CREATE TABLE IF NOT EXISTS signable_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signable_id UUID NOT NULL REFERENCES signable_documents(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signable_audit_log_signable_idx ON signable_audit_log(signable_id);

-- updated_at trigger se la funzione esiste
DROP TRIGGER IF EXISTS signable_documents_updated ON signable_documents;
CREATE TRIGGER signable_documents_updated
  BEFORE UPDATE ON signable_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
