-- 068_calendar_availability.sql — Schedule settimanale ricorrente + override per data
--
-- Mono-utente: per ora una sola riga "default". Schema permette futuro multi-host.

CREATE TABLE IF NOT EXISTS calendar_availability_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'default',
  timezone TEXT NOT NULL DEFAULT 'Europe/Rome',
  is_default BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS calendar_schedules_updated ON calendar_availability_schedules;
CREATE TRIGGER calendar_schedules_updated
  BEFORE UPDATE ON calendar_availability_schedules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Slot ricorrenti per giorno della settimana (0=domenica, 6=sabato — coerente con JS Date.getDay())
CREATE TABLE IF NOT EXISTS calendar_availability_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES calendar_availability_schedules(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  CHECK (start_time < end_time)
);

CREATE INDEX IF NOT EXISTS calendar_avail_slots_schedule_idx
  ON calendar_availability_slots(schedule_id, day_of_week);

-- Override per data specifica: ferie (is_unavailable=true) o orari speciali
CREATE TABLE IF NOT EXISTS calendar_availability_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES calendar_availability_schedules(id) ON DELETE CASCADE,
  override_date DATE NOT NULL,
  is_unavailable BOOLEAN NOT NULL DEFAULT false,
  start_time TIME,
  end_time TIME,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (schedule_id, override_date),
  CHECK (
    (is_unavailable = true) OR
    (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)
  )
);

CREATE INDEX IF NOT EXISTS calendar_avail_overrides_date_idx
  ON calendar_availability_overrides(schedule_id, override_date);

-- ============================================
-- Link event_type → schedule
-- ============================================

ALTER TABLE calendar_event_types
  ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES calendar_availability_schedules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS calendar_event_types_schedule_idx
  ON calendar_event_types(schedule_id);

-- ============================================
-- RLS
-- ============================================

ALTER TABLE calendar_availability_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_availability_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_availability_overrides ENABLE ROW LEVEL SECURITY;

-- Lettura pubblica delle disponibilità (necessaria per slot computation lato pubblico tramite service_role,
-- ma esponiamo SELECT a anon per supportare il calcolo lato client se mai servisse)
DROP POLICY IF EXISTS "Public read schedules" ON calendar_availability_schedules;
CREATE POLICY "Public read schedules" ON calendar_availability_schedules
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public read schedule slots" ON calendar_availability_slots;
CREATE POLICY "Public read schedule slots" ON calendar_availability_slots
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public read overrides" ON calendar_availability_overrides;
CREATE POLICY "Public read overrides" ON calendar_availability_overrides
  FOR SELECT TO anon, authenticated USING (true);

-- Admin gestione
DROP POLICY IF EXISTS "Admin manage schedules" ON calendar_availability_schedules;
CREATE POLICY "Admin manage schedules" ON calendar_availability_schedules
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admin manage schedule slots" ON calendar_availability_slots;
CREATE POLICY "Admin manage schedule slots" ON calendar_availability_slots
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admin manage overrides" ON calendar_availability_overrides;
CREATE POLICY "Admin manage overrides" ON calendar_availability_overrides
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- Service role bypass
DROP POLICY IF EXISTS "Service role schedules" ON calendar_availability_schedules;
CREATE POLICY "Service role schedules" ON calendar_availability_schedules
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role schedule slots" ON calendar_availability_slots;
CREATE POLICY "Service role schedule slots" ON calendar_availability_slots
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role overrides" ON calendar_availability_overrides;
CREATE POLICY "Service role overrides" ON calendar_availability_overrides
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- SEED: schedule default lun-ven 09:00-13:00 + 14:00-18:00
-- ============================================

DO $$
DECLARE
  default_schedule_id UUID;
BEGIN
  SELECT id INTO default_schedule_id FROM calendar_availability_schedules WHERE name = 'default' LIMIT 1;

  IF default_schedule_id IS NULL THEN
    INSERT INTO calendar_availability_schedules (name, timezone, is_default)
    VALUES ('default', 'Europe/Rome', true)
    RETURNING id INTO default_schedule_id;

    -- Lun-Ven 09:00-13:00 e 14:00-18:00
    INSERT INTO calendar_availability_slots (schedule_id, day_of_week, start_time, end_time)
    SELECT default_schedule_id, dow, t.start_time, t.end_time
    FROM generate_series(1, 5) AS dow,
         (VALUES ('09:00'::time, '13:00'::time), ('14:00'::time, '18:00'::time)) AS t(start_time, end_time);
  END IF;

  -- Collega gli event types esistenti al default schedule (se non già collegati)
  UPDATE calendar_event_types
  SET schedule_id = default_schedule_id
  WHERE schedule_id IS NULL;
END $$;
