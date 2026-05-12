-- ============================================
-- MIGRATION 023: Cal.com Bookings Integration
-- Sincronizzazione appuntamenti da Cal.com
-- ============================================

-- ============================================
-- 1. TABELLA CAL_BOOKINGS
-- ============================================

CREATE TABLE IF NOT EXISTS cal_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificazione Cal.com
  booking_uid TEXT UNIQUE NOT NULL,
  cal_event_type_id INTEGER,
  cal_event_type_slug TEXT,

  -- Stato
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN (
    'upcoming', 'past', 'cancelled', 'unconfirmed', 'recurring'
  )),

  -- Partecipante
  attendee_name TEXT,
  attendee_email TEXT,
  attendee_timezone TEXT,
  attendee_locale TEXT,

  -- Dettagli evento
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER,

  -- Meeting
  meeting_url TEXT,
  location TEXT,

  -- Organizzatore
  organizer_name TEXT,
  organizer_email TEXT,

  -- Metadati
  responses JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',

  -- Cancellazione
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,

  -- Sync
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici
CREATE INDEX IF NOT EXISTS cal_bookings_status_idx ON cal_bookings(status);
CREATE INDEX IF NOT EXISTS cal_bookings_attendee_email_idx ON cal_bookings(attendee_email);
CREATE INDEX IF NOT EXISTS cal_bookings_start_time_idx ON cal_bookings(start_time DESC);
CREATE INDEX IF NOT EXISTS cal_bookings_booking_uid_idx ON cal_bookings(booking_uid);

-- ============================================
-- 2. TABELLA SYNC LOG
-- ============================================

CREATE TABLE IF NOT EXISTS cal_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_type TEXT NOT NULL CHECK (sync_type IN ('manual', 'webhook')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  bookings_synced INTEGER DEFAULT 0,
  bookings_errors INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS cal_sync_log_started_idx ON cal_sync_log(started_at DESC);

-- ============================================
-- 3. TABELLA WEBHOOK LOG
-- ============================================

CREATE TABLE IF NOT EXISTS cal_webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  booking_uid TEXT,
  payload JSONB NOT NULL,
  processed BOOLEAN DEFAULT false,
  error_message TEXT,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS cal_webhook_logs_event_idx ON cal_webhook_logs(event_type);
CREATE INDEX IF NOT EXISTS cal_webhook_logs_received_idx ON cal_webhook_logs(received_at DESC);

-- ============================================
-- 4. TRIGGER updated_at
-- ============================================

DROP TRIGGER IF EXISTS cal_bookings_updated ON cal_bookings;
CREATE TRIGGER cal_bookings_updated
  BEFORE UPDATE ON cal_bookings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 5. RLS POLICIES
-- ============================================

ALTER TABLE cal_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cal_sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE cal_webhook_logs ENABLE ROW LEVEL SECURITY;

-- Admin access
DROP POLICY IF EXISTS "Admin full access cal_bookings" ON cal_bookings;
CREATE POLICY "Admin full access cal_bookings" ON cal_bookings
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admin full access cal_sync_log" ON cal_sync_log;
CREATE POLICY "Admin full access cal_sync_log" ON cal_sync_log
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admin full access cal_webhook_logs" ON cal_webhook_logs;
CREATE POLICY "Admin full access cal_webhook_logs" ON cal_webhook_logs
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Service role bypass (per webhook senza auth context)
DROP POLICY IF EXISTS "Service role cal_bookings" ON cal_bookings;
CREATE POLICY "Service role cal_bookings" ON cal_bookings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role cal_sync_log" ON cal_sync_log;
CREATE POLICY "Service role cal_sync_log" ON cal_sync_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role cal_webhook_logs" ON cal_webhook_logs;
CREATE POLICY "Service role cal_webhook_logs" ON cal_webhook_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
