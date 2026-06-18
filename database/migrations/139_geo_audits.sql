-- 139_geo_audits.sql
-- GEO Audit tool: stores each public site scan + (once unlocked with an email)
-- the AI-generated action plan, linked to the contact/lead it generated.
--
-- Flow:
--   1. POST /api/geo-audit/scan  → insert row (email NULL, ai_actions NULL), return teaser.
--   2. POST /api/geo-audit/unlock → fill email/contact_id/lead_id + ai_actions, return full report.
-- The admin pipeline reads the row via lead_id to show score + actions in the lead detail.

CREATE TABLE IF NOT EXISTS geo_audits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url                TEXT NOT NULL,
  score              SMALLINT NOT NULL,
  breakdown          JSONB NOT NULL,            -- array of checks {id,label,passed,weight,detail,anchor}
  ai_actions         JSONB,                     -- {userSummary, adminActions:[{title,priority,why,how}]} (NULL until unlocked)
  email              TEXT,
  contact_id         UUID REFERENCES contacts(id) ON DELETE SET NULL,
  lead_id            UUID REFERENCES leads(id) ON DELETE SET NULL,
  wants_intervention BOOLEAN,                   -- NULL = not yet chosen, true = wants help, false = DIY
  locale             TEXT NOT NULL DEFAULT 'it',
  ip                 INET,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geo_audits_lead ON geo_audits(lead_id);
CREATE INDEX IF NOT EXISTS idx_geo_audits_created ON geo_audits(created_at DESC);
