-- 074: Lead magnet audit sequence
-- Adds contact lead source tracking and the scheduled email sequence queue.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lead_source TEXT;

CREATE TABLE IF NOT EXISTS email_sequences (
  id SERIAL PRIMARY KEY,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sequence_type TEXT NOT NULL,
  step SMALLINT NOT NULL DEFAULT 1,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contact_id, sequence_type, step)
);

CREATE INDEX IF NOT EXISTS email_sequences_pending_idx
  ON email_sequences (scheduled_at)
  WHERE sent_at IS NULL;
