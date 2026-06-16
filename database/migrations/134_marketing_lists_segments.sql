-- Migration 134: Email/WhatsApp marketing — lists (static) + segments (saved filters)
--
-- Builds on mkt_contacts (migration 133). A campaign targets EITHER a static
-- list (explicit membership) OR a segment (a saved filter compiled to a
-- parameterized WHERE at send time). Keeping both lets the user pin a curated
-- audience (list) or target dynamically (segment: e.g. "cold B2B in 'design'").

-- =====================================================
-- mkt_lists — static, curated audiences
-- =====================================================
CREATE TABLE IF NOT EXISTS mkt_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'static',          -- static | imported
  default_legal_basis TEXT NOT NULL DEFAULT 'consent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mkt_lists_kind CHECK (kind IN ('static','imported')),
  CONSTRAINT chk_mkt_lists_legal_basis
    CHECK (default_legal_basis IN ('consent','legitimate_interest_b2b','soft_optin'))
);

-- =====================================================
-- mkt_list_members — list ↔ contact membership
-- =====================================================
CREATE TABLE IF NOT EXISTS mkt_list_members (
  list_id UUID NOT NULL REFERENCES mkt_lists(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  source TEXT,                                  -- import | manual | form | automation
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_mkt_list_members_contact ON mkt_list_members (contact_id);

-- =====================================================
-- mkt_segments — saved, re-evaluable filters
-- `definition` is a small JSON DSL compiled to SQL in the route layer:
--   { "audience_type": "cold", "tags_any": ["design"],
--     "email_consent": ["confirmed"], "industry": "..." }
-- =====================================================
CREATE TABLE IF NOT EXISTS mkt_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  definition JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
