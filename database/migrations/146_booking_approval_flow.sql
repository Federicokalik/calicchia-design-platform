-- 146_booking_approval_flow.sql — Flusso approvazione prenotazioni
--
-- Attiva la colonna requires_approval (esistente dalla 067 ma mai enforced):
-- le prenotazioni self-service (public_page/contact_form) su event type con
-- requires_approval=true nascono status='pending' e vanno approvate/rifiutate
-- dall'admin (POST /api/admin/calendar/bookings/:uid/approve | /reject).
--
-- 1. status CHECK: aggiunge 'pending'
-- 2. EXCLUDE no-overlap: anche i pending bloccano lo slot (una richiesta in
--    attesa non deve poter essere scavalcata da un'altra prenotazione)
-- 3. approved_at: audit di quando la richiesta è stata approvata
-- 4. reminder_type CHECK: nuovi tipi email pending_request / approved / rejected

-- 1. Status CHECK
ALTER TABLE calendar_bookings DROP CONSTRAINT IF EXISTS calendar_bookings_status_check;
ALTER TABLE calendar_bookings
  ADD CONSTRAINT calendar_bookings_status_check CHECK (status IN (
    'pending','confirmed','cancelled','rescheduled','no_show','completed'
  ));

-- 2. EXCLUDE constraint: confirmed + pending bloccano lo slot
ALTER TABLE calendar_bookings DROP CONSTRAINT IF EXISTS calendar_bookings_no_overlap;
ALTER TABLE calendar_bookings
  ADD CONSTRAINT calendar_bookings_no_overlap
  EXCLUDE USING gist (
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status IN ('confirmed', 'pending'));

-- 3. Audit approvazione
ALTER TABLE calendar_bookings ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- 4. Reminder types per le email del flusso approvazione
ALTER TABLE calendar_booking_reminders DROP CONSTRAINT IF EXISTS calendar_booking_reminders_reminder_type_check;
ALTER TABLE calendar_booking_reminders
  ADD CONSTRAINT calendar_booking_reminders_reminder_type_check CHECK (reminder_type IN (
    'confirmation','admin_notification','reminder_24h','reminder_2h',
    'cancelled','rescheduled','pending_request','approved','rejected'
  ));
