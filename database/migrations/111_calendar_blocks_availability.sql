-- 111_calendar_blocks_availability.sql
-- Calendari bloccanti per disponibilita booking e capacity settimanale.

ALTER TABLE calendars
  ADD COLUMN IF NOT EXISTS blocks_availability BOOLEAN NOT NULL DEFAULT true;

-- Scadenze e' informativo: domini, fatture, milestone non devono togliere slot.
UPDATE calendars
SET blocks_availability = false
WHERE slug = 'scadenze';

-- Calendari che devono bloccare slot e capacity per default.
UPDATE calendars
SET blocks_availability = true
WHERE slug IN ('lavoro', 'personale', 'bookings')
   OR lower(name) = 'creattivamente srl'
   OR slug = 'creattivamente-srl';
