-- 072_calendar_events.sql — Eventi calendario self-hosted con supporto RRULE
--
-- Schema unico per eventi singoli e ricorrenti:
--  - Evento singolo: rrule=NULL, recurrence_master_id=NULL
--  - Master ricorrente: rrule='FREQ=...', recurrence_master_id=NULL
--  - Override singola occorrenza: recurrence_master_id=<master>, recurrence_id=<original_start_ts>
--
-- exdates JSONB array di ISO timestamps escludono occorrenze del master.

CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  uid TEXT UNIQUE NOT NULL,                       -- nanoid 16 char (UID stabile per ICS)

  -- Dettagli evento
  summary TEXT NOT NULL,
  description TEXT,
  location TEXT,
  url TEXT,                                       -- link meeting (Meet/Zoom/etc.)

  -- Tempo (UTC)
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT false,
  CHECK (start_time < end_time),

  -- Ricorrenza (RFC 5545 subset)
  rrule TEXT,
  exdates JSONB NOT NULL DEFAULT '[]'::jsonb,
  recurrence_id TIMESTAMPTZ,
  recurrence_master_id UUID REFERENCES calendar_events(id) ON DELETE CASCADE,

  -- Origine (per tracciare auto-create da bookings/agents)
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','booking','admin','mcp','agent')),
  source_id TEXT,

  -- Stato (RFC 5545: confirmed/tentative/cancelled)
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','tentative','cancelled')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraint: un override deve avere sia master_id che recurrence_id, o nessuno dei due
  CHECK (
    (recurrence_master_id IS NULL AND recurrence_id IS NULL) OR
    (recurrence_master_id IS NOT NULL AND recurrence_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS calendar_events_calendar_idx ON calendar_events(calendar_id, start_time);
CREATE INDEX IF NOT EXISTS calendar_events_start_idx ON calendar_events(start_time);
CREATE INDEX IF NOT EXISTS calendar_events_uid_idx ON calendar_events(uid);
CREATE INDEX IF NOT EXISTS calendar_events_master_idx ON calendar_events(recurrence_master_id) WHERE recurrence_master_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calendar_events_source_idx ON calendar_events(source, source_id) WHERE source != 'manual';
CREATE INDEX IF NOT EXISTS calendar_events_status_idx ON calendar_events(status, start_time) WHERE status = 'confirmed';

DROP TRIGGER IF EXISTS calendar_events_updated ON calendar_events;
CREATE TRIGGER calendar_events_updated
  BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- RLS
-- ============================================

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

-- Lettura solo via service_role (per ICS feed token-based) + admin per CRUD
DROP POLICY IF EXISTS "Admin manage events" ON calendar_events;
CREATE POLICY "Admin manage events" ON calendar_events
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Service role events" ON calendar_events;
CREATE POLICY "Service role events" ON calendar_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
