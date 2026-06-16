-- Migration 133: Email/WhatsApp marketing — unified audience layer (mkt_contacts)
--
-- This is the foundation of the self-hosted marketing platform (Brevo replacement).
-- `mkt_contacts` is a MARKETING PROJECTION: a unified, addressable audience that
-- can optionally link back (non-destructively) to the CRM systems-of-record
-- (newsletter_subscribers / leads / customers) without duplicating their logic.
--
-- Naming: prefix `mkt_` is deliberate to avoid colliding with the pre-existing
-- `marketing_*` tables (migration 033/132) which model AGENCY DELIVERABLES done
-- FOR clients — a different concept from sending marketing to our OWN audience.
--
-- GDPR: cold/imported contacts carry an explicit `email_legal_basis`
-- (legitimate_interest_b2b vs consent). The send engine (later migrations) hard-
-- filters on it; every message carries a one-click unsubscribe token.

-- =====================================================
-- mkt_contacts — the unified audience entity
-- =====================================================
CREATE TABLE IF NOT EXISTS mkt_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity / addressability. email nullable → WhatsApp-only contacts allowed.
  email TEXT,
  -- Normalized, generated column → stable dedup key (no citext extension needed).
  email_norm TEXT GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  phone TEXT,                       -- E.164-normalized at write time (formatPhone)
  first_name TEXT,
  last_name TEXT,

  -- B2B enrichment (Apify import standard).
  company TEXT,
  role TEXT,
  website TEXT,
  industry TEXT,
  city TEXT,
  country TEXT,

  -- Consent / legal basis.
  email_consent TEXT NOT NULL DEFAULT 'unconfirmed',
  -- unconfirmed | confirmed | unsubscribed | bounced | complained
  email_legal_basis TEXT NOT NULL DEFAULT 'consent',
  -- consent | legitimate_interest_b2b | soft_optin
  wa_consent TEXT NOT NULL DEFAULT 'none',
  -- none | opted_in | opted_out  (mirror of communication_preferences)
  audience_type TEXT NOT NULL DEFAULT 'warm',
  -- warm | cold  (cold = scraped/imported, never explicitly consented)

  -- Consent proof (art. 7 GDPR).
  consent_source TEXT,              -- e.g. 'apify-maps', 'website', 'import:<file>'
  consent_collected_at TIMESTAMPTZ,
  consent_ip TEXT,
  consent_user_agent TEXT,

  -- Per-contact tokens (double opt-in + one-click unsubscribe).
  double_optin_token UUID NOT NULL DEFAULT gen_random_uuid(),
  unsubscribe_token UUID NOT NULL DEFAULT gen_random_uuid(),

  -- Non-destructive links to the CRM systems-of-record.
  subscriber_id UUID REFERENCES newsletter_subscribers(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',   -- arbitrary extra CSV columns preserved here

  status TEXT NOT NULL DEFAULT 'active',  -- active | archived
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_mkt_contacts_email_consent
    CHECK (email_consent IN ('unconfirmed','confirmed','unsubscribed','bounced','complained')),
  CONSTRAINT chk_mkt_contacts_email_legal_basis
    CHECK (email_legal_basis IN ('consent','legitimate_interest_b2b','soft_optin')),
  CONSTRAINT chk_mkt_contacts_wa_consent
    CHECK (wa_consent IN ('none','opted_in','opted_out')),
  CONSTRAINT chk_mkt_contacts_audience_type
    CHECK (audience_type IN ('warm','cold')),
  CONSTRAINT chk_mkt_contacts_status
    CHECK (status IN ('active','archived')),
  -- A contact must be reachable on at least one channel.
  CONSTRAINT chk_mkt_contacts_reachable
    CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- Dedup key: one row per email (when present). Phone-only contacts are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mkt_contacts_email_norm
  ON mkt_contacts (email_norm) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mkt_contacts_unsubscribe_token
  ON mkt_contacts (unsubscribe_token);
CREATE INDEX IF NOT EXISTS idx_mkt_contacts_phone ON mkt_contacts (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_contacts_subscriber ON mkt_contacts (subscriber_id);
CREATE INDEX IF NOT EXISTS idx_mkt_contacts_lead ON mkt_contacts (lead_id);
CREATE INDEX IF NOT EXISTS idx_mkt_contacts_customer ON mkt_contacts (customer_id);
CREATE INDEX IF NOT EXISTS idx_mkt_contacts_tags ON mkt_contacts USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_mkt_contacts_metadata ON mkt_contacts USING GIN (metadata);
-- Send-eligibility scans filter on (audience_type, email_consent, legal_basis).
CREATE INDEX IF NOT EXISTS idx_mkt_contacts_eligibility
  ON mkt_contacts (audience_type, email_consent, email_legal_basis);

-- =====================================================
-- mkt_suppression — global do-not-send (hard bounce / complaint / global unsub)
-- Checked at enqueue time across ALL campaigns. Survives contact deletion.
-- =====================================================
CREATE TABLE IF NOT EXISTS mkt_suppression (
  email_norm TEXT PRIMARY KEY,
  reason TEXT NOT NULL,             -- unsubscribed | bounced | complained | manual
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mkt_suppression_reason
    CHECK (reason IN ('unsubscribed','bounced','complained','manual'))
);
