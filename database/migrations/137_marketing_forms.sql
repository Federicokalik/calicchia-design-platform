-- Migration 137: Email/WhatsApp marketing — embeddable signup forms
--
-- A form definition rendered by a self-contained JS snippet (GET /:slug/embed.js)
-- that can be dropped on ANY external landing page. Submissions create/upsert a
-- mkt_contact and (when double_optin) trigger the existing confirm-email flow.
-- Per-form origin allowlist + captcha guard abuse.

CREATE TABLE IF NOT EXISTS mkt_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  fields JSONB NOT NULL DEFAULT '[]',          -- [{name,label,type,required}]
  success_message TEXT NOT NULL DEFAULT 'Iscrizione ricevuta. Controlla la tua email.',
  submit_label TEXT NOT NULL DEFAULT 'Iscriviti',
  target_list_id UUID REFERENCES mkt_lists(id) ON DELETE SET NULL,
  default_legal_basis TEXT NOT NULL DEFAULT 'consent',
  audience_type TEXT NOT NULL DEFAULT 'warm',
  double_optin BOOLEAN NOT NULL DEFAULT true,
  allowed_origins TEXT[] NOT NULL DEFAULT '{}', -- empty = allow any origin
  captcha_site_key_id TEXT,                     -- Turnstile siteKeyId (optional)
  tags TEXT[] NOT NULL DEFAULT '{}',
  style JSONB NOT NULL DEFAULT '{}',            -- {accent, radius, font}
  status TEXT NOT NULL DEFAULT 'active',        -- active | disabled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mkt_forms_status CHECK (status IN ('active','disabled')),
  CONSTRAINT chk_mkt_forms_legal_basis CHECK (default_legal_basis IN ('consent','legitimate_interest_b2b','soft_optin')),
  CONSTRAINT chk_mkt_forms_audience CHECK (audience_type IN ('warm','cold'))
);

CREATE TABLE IF NOT EXISTS mkt_form_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id UUID NOT NULL REFERENCES mkt_forms(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES mkt_contacts(id) ON DELETE SET NULL,
  data JSONB NOT NULL DEFAULT '{}',
  consent_ip TEXT,                              -- art. 7 GDPR proof
  consent_user_agent TEXT,
  origin TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_form_submissions_form ON mkt_form_submissions (form_id);
