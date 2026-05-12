-- 069_calendar_bookings.sql — Bookings interni con anti-overlap atomico
--
-- EXCLUDE constraint con tstzrange impedisce double-booking a livello DB.
-- Storico Cal.com resta in cal_bookings (read-only legacy).

-- Estensione necessaria per EXCLUDE USING gist su tstzrange
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS calendar_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid TEXT UNIQUE NOT NULL,                                 -- nanoid pubblico, esposto in URL
  event_type_id UUID NOT NULL REFERENCES calendar_event_types(id) ON DELETE RESTRICT,

  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN (
    'confirmed','cancelled','rescheduled','no_show','completed'
  )),

  -- Partecipante
  attendee_name TEXT NOT NULL,
  attendee_email TEXT NOT NULL,
  attendee_phone TEXT,
  attendee_company TEXT,
  attendee_timezone TEXT NOT NULL DEFAULT 'Europe/Rome',
  attendee_message TEXT,
  custom_responses JSONB NOT NULL DEFAULT '{}',

  -- Slot temporale (UTC)
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  CHECK (start_time < end_time),

  -- Location materializzata (snapshot dall'event_type al momento della prenotazione)
  location_type TEXT NOT NULL CHECK (location_type IN ('google_meet','custom_url','in_person','phone')),
  location_value TEXT,

  -- Sync esterno
  google_event_id TEXT,

  -- Cancellazione / reschedule
  cancellation_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT CHECK (cancelled_by IN ('attendee','admin','system')),
  rescheduled_from_uid TEXT,                                -- uid del booking precedente

  -- Origine
  source TEXT NOT NULL DEFAULT 'public_page' CHECK (source IN (
    'public_page','contact_form','admin_manual','mcp'
  )),
  source_metadata JSONB NOT NULL DEFAULT '{}',
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS calendar_bookings_start_idx ON calendar_bookings(start_time);
CREATE INDEX IF NOT EXISTS calendar_bookings_event_start_idx ON calendar_bookings(event_type_id, start_time);
CREATE INDEX IF NOT EXISTS calendar_bookings_email_idx ON calendar_bookings(attendee_email);
CREATE INDEX IF NOT EXISTS calendar_bookings_status_start_idx ON calendar_bookings(status, start_time);
CREATE INDEX IF NOT EXISTS calendar_bookings_uid_idx ON calendar_bookings(uid);

-- Anti double-booking: nessun overlap tra bookings attivi.
-- Buffer NON inclusi qui (li gestiamo nel calcolo slots) per non bloccare
-- bookings adiacenti deliberatamente fittati.
ALTER TABLE calendar_bookings
  DROP CONSTRAINT IF EXISTS calendar_bookings_no_overlap;
ALTER TABLE calendar_bookings
  ADD CONSTRAINT calendar_bookings_no_overlap
  EXCLUDE USING gist (
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status IN ('confirmed','rescheduled'));

DROP TRIGGER IF EXISTS calendar_bookings_updated ON calendar_bookings;
CREATE TRIGGER calendar_bookings_updated
  BEFORE UPDATE ON calendar_bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- Reminders / audit email inviate (idempotenza cron)
-- ============================================

CREATE TABLE IF NOT EXISTS calendar_booking_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES calendar_bookings(id) ON DELETE CASCADE,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN (
    'confirmation','admin_notification','reminder_24h','reminder_2h','cancelled','rescheduled'
  )),
  sent_to TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_message TEXT,
  UNIQUE (booking_id, reminder_type, sent_to)
);

CREATE INDEX IF NOT EXISTS calendar_booking_reminders_booking_idx
  ON calendar_booking_reminders(booking_id);

-- ============================================
-- RLS
-- ============================================

ALTER TABLE calendar_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_booking_reminders ENABLE ROW LEVEL SECURITY;

-- Lettura pubblica solo via service_role (uid+token verificati lato API)
-- Niente policy SELECT pubbliche per evitare enumerazione email/dati attendee.

DROP POLICY IF EXISTS "Admin manage bookings" ON calendar_bookings;
CREATE POLICY "Admin manage bookings" ON calendar_bookings
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Service role bookings" ON calendar_bookings;
CREATE POLICY "Service role bookings" ON calendar_bookings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Admin read reminders" ON calendar_booking_reminders;
CREATE POLICY "Admin read reminders" ON calendar_booking_reminders
  FOR SELECT TO authenticated USING (is_admin());

DROP POLICY IF EXISTS "Service role reminders" ON calendar_booking_reminders;
CREATE POLICY "Service role reminders" ON calendar_booking_reminders
  FOR ALL TO service_role USING (true) WITH CHECK (true);
