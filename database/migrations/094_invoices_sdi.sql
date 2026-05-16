-- Migration 094 — track FatturaPA / SDI XML generation per invoice.
--
-- The XML is deterministic from invoices + customers + site_settings, so we
-- don't persist the bytes. We persist (a) the last time it was generated,
-- (b) the filename produced (deterministic from cedente VAT + ProgressivoInvio),
-- and (c) a lightweight lifecycle status. The actual transmission to SDI
-- happens out-of-band today (intermediario / PEC) — `sent`/`accepted`/`rejected`
-- are reserved for when that integration lands; until then only `pending`
-- (default) and `generated` are written by the API.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS sdi_xml_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sdi_xml_filename     TEXT,
  ADD COLUMN IF NOT EXISTS sdi_status           TEXT NOT NULL DEFAULT 'pending';

-- Constraint added separately (and idempotently) so the migration is safe
-- to re-run against a database that already has the columns from an earlier
-- partial apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_sdi_status_check'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_sdi_status_check
      CHECK (sdi_status IN ('pending', 'generated', 'sent', 'accepted', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS invoices_sdi_status_idx
  ON invoices(sdi_status)
  WHERE sdi_status <> 'pending';

COMMENT ON COLUMN invoices.sdi_xml_generated_at IS
  'Timestamp of the most recent FatturaPA XML generation. NULL = never generated.';
COMMENT ON COLUMN invoices.sdi_xml_filename IS
  'Last filename returned to the user (IT{vat}_{progressivo}.xml). Deterministic, not authoritative.';
COMMENT ON COLUMN invoices.sdi_status IS
  'Lifecycle: pending → generated → sent → accepted | rejected. Today only pending/generated are written automatically.';
