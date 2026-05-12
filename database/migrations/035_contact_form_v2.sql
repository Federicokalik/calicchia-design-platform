-- 035: Contact Form V2 - Multi-step context-aware form
-- Adds new columns for enriched contact submissions

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS services TEXT[];
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sectors TEXT[];
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wants_call BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wants_meet BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS gdpr_consent BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_page TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_service TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_profession TEXT;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS meet_slot TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS cal_booking_uid TEXT;

-- Make message optional (multi-step form may not always have a message)
ALTER TABLE contacts ALTER COLUMN message DROP NOT NULL;
