-- 070_calendar_bookings_no_overlap_fix.sql — Fix capacity leak su reschedule
--
-- BUG: il booking riprogrammato veniva marcato status='rescheduled' ed era
-- ancora considerato occupato sia da slots.ts (WHERE status IN ('confirmed','rescheduled'))
-- che dal constraint EXCLUDE (WHERE status IN ('confirmed','rescheduled')).
-- Effetto: ogni riprogrammazione "bruciava" lo slot vecchio definitivamente.
--
-- FIX: il vecchio booking viene ora marcato 'cancelled' (con cancellation_reason
-- = 'Rescheduled to <new_uid>'). Lo stato 'rescheduled' resta nell'enum CHECK
-- per backward-compat ma non viene più usato dal nuovo codice.

-- 1. Sostituisci EXCLUDE constraint per considerare solo bookings 'confirmed'
ALTER TABLE calendar_bookings DROP CONSTRAINT IF EXISTS calendar_bookings_no_overlap;

ALTER TABLE calendar_bookings
  ADD CONSTRAINT calendar_bookings_no_overlap
  EXCLUDE USING gist (
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status = 'confirmed');

-- 2. Migra row esistenti con status='rescheduled' → 'cancelled'
UPDATE calendar_bookings
SET status = 'cancelled',
    cancellation_reason = COALESCE(
      NULLIF(cancellation_reason, ''),
      'Rescheduled (migrated by 070)'
    ),
    cancelled_at = COALESCE(cancelled_at, NOW()),
    cancelled_by = COALESCE(cancelled_by, 'system')
WHERE status = 'rescheduled';
