-- 071_calendars.sql — Caldes Calendar (sostituzione Google Calendar)
--
-- Multi-calendar self-hosted. Ogni calendario ha:
--  - colore + icona per UI admin
--  - timezone proprio (default Europe/Rome)
--  - ICS feed token per subscription read-only da iPhone/macOS Calendar/Outlook/Thunderbird
--  - is_system=true per calendari creati dal codice (es. 'bookings') — non eliminabili dall'UI

CREATE TABLE IF NOT EXISTS calendars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificazione
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,

  -- Apparenza
  color TEXT NOT NULL DEFAULT '#7c3aed',
  icon TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Rome',

  -- Flags
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_system BOOLEAN NOT NULL DEFAULT false,

  -- ICS feed (read-only subscription)
  ics_feed_token TEXT UNIQUE NOT NULL,
  ics_feed_enabled BOOLEAN NOT NULL DEFAULT true,

  -- UI
  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS calendars_slug_idx ON calendars(slug);
CREATE INDEX IF NOT EXISTS calendars_feed_token_idx ON calendars(ics_feed_token) WHERE ics_feed_enabled = true;
CREATE INDEX IF NOT EXISTS calendars_default_idx ON calendars(is_default) WHERE is_default = true;

-- Solo un calendario può essere default
CREATE UNIQUE INDEX IF NOT EXISTS calendars_one_default_idx
  ON calendars((is_default IS TRUE)) WHERE is_default = true;

DROP TRIGGER IF EXISTS calendars_updated ON calendars;
CREATE TRIGGER calendars_updated
  BEFORE UPDATE ON calendars
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- RLS
-- ============================================

ALTER TABLE calendars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin manage calendars" ON calendars;
CREATE POLICY "Admin manage calendars" ON calendars
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Service role calendars" ON calendars;
CREATE POLICY "Service role calendars" ON calendars
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- SEED 4 calendari di default
-- Token feed casuali generati con gen_random_uuid + esadecimale
-- ============================================

INSERT INTO calendars (slug, name, description, color, icon, is_default, is_system, ics_feed_token, sort_order) VALUES
  ('lavoro',    'Lavoro',     'Riunioni cliente, deep work, scadenze progetti',           '#7c3aed', 'briefcase',     true,  false, replace(gen_random_uuid()::text, '-', ''), 1),
  ('personale', 'Personale',  'Appuntamenti privati, salute, hobby',                       '#ec4899', 'heart',         false, false, replace(gen_random_uuid()::text, '-', ''), 2),
  ('bookings',  'Bookings',   'Prenotazioni clienti dal sito (auto-create da calendar_bookings)', '#0ea5e9', 'calendar-check', false, true,  replace(gen_random_uuid()::text, '-', ''), 3),
  ('scadenze',  'Scadenze',   'Domini, fatture, pagamenti, milestones progetti',           '#f97316', 'alarm',         false, true,  replace(gen_random_uuid()::text, '-', ''), 4)
ON CONFLICT (slug) DO NOTHING;
