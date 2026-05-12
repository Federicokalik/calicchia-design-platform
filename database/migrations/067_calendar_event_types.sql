-- 067_calendar_event_types.sql — Self-hosted booking system (cal.diy-style)
--
-- Sostituisce Cal.com con event types interni configurabili dall'admin.
-- Mono-utente. schedule_id viene aggiunto in 068 dopo creazione tabella schedules.

CREATE TABLE IF NOT EXISTS calendar_event_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificazione pubblica
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,                                 -- markdown supportato

  -- Durata e granularità
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 480),
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  slot_increment_minutes INTEGER NOT NULL DEFAULT 30 CHECK (slot_increment_minutes > 0),

  -- Vincoli temporali
  min_notice_hours INTEGER NOT NULL DEFAULT 12 CHECK (min_notice_hours >= 0),
  max_advance_days INTEGER NOT NULL DEFAULT 60 CHECK (max_advance_days > 0),

  -- Location
  location_type TEXT NOT NULL CHECK (location_type IN ('google_meet','custom_url','in_person','phone')),
  location_value TEXT,                              -- URL custom, indirizzo, telefono

  -- Apparenza & visibilità
  color TEXT NOT NULL DEFAULT '#7c3aed',
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_public BOOLEAN NOT NULL DEFAULT true,
  requires_approval BOOLEAN NOT NULL DEFAULT false, -- futuro

  -- Domande personalizzate: [{key,label,type:'text'|'textarea'|'select',options?,required}]
  custom_questions JSONB NOT NULL DEFAULT '[]',

  -- Workflow trigger override (se NULL usa 'booking_creato' generico)
  workflow_event_key TEXT,

  -- Sort per UI
  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS calendar_event_types_active_idx
  ON calendar_event_types(is_active, is_public) WHERE is_active = true AND is_public = true;
CREATE INDEX IF NOT EXISTS calendar_event_types_slug_idx
  ON calendar_event_types(slug);

DROP TRIGGER IF EXISTS calendar_event_types_updated ON calendar_event_types;
CREATE TRIGGER calendar_event_types_updated
  BEFORE UPDATE ON calendar_event_types
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- RLS
-- ============================================

ALTER TABLE calendar_event_types ENABLE ROW LEVEL SECURITY;

-- Lettura pubblica solo righe attive+pubbliche
DROP POLICY IF EXISTS "Public read active event types" ON calendar_event_types;
CREATE POLICY "Public read active event types" ON calendar_event_types
  FOR SELECT TO anon, authenticated
  USING (is_active = true AND is_public = true);

-- Admin pieno accesso
DROP POLICY IF EXISTS "Admin manage event types" ON calendar_event_types;
CREATE POLICY "Admin manage event types" ON calendar_event_types
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Service role bypass
DROP POLICY IF EXISTS "Service role event types" ON calendar_event_types;
CREATE POLICY "Service role event types" ON calendar_event_types
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- SEED iniziali (i due event types richiesti dall'utente)
-- ============================================

INSERT INTO calendar_event_types (
  slug, title, description, duration_minutes, slot_increment_minutes,
  buffer_after_minutes, min_notice_hours, location_type, color, sort_order
) VALUES
(
  'consulenza-gratuita-30min',
  'Consulenza Gratuita',
  'Una videochiamata di 30 minuti per conoscerci e capire come posso aiutarti col tuo progetto.',
  30, 30, 15, 12, 'google_meet', '#7c3aed', 1
),
(
  'sopralluogo-in-presenza',
  'Sopralluogo in presenza',
  'Incontro di persona presso la tua sede per discutere il progetto dal vivo. Concordiamo il luogo via email dopo la prenotazione.',
  60, 30, 30, 48, 'in_person', '#0ea5e9', 2
)
ON CONFLICT (slug) DO NOTHING;
