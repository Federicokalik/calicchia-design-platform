-- ============================================
-- MIGRATION 025: Google Calendar Integration
-- Sincronizzazione bidirezionale con Google Calendar
-- ============================================

-- ============================================
-- 1. TABELLA GOOGLE_OAUTH_TOKENS
-- Singola riga per account Google connesso
-- ============================================

CREATE TABLE IF NOT EXISTS google_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expiry TIMESTAMPTZ NOT NULL,
  scope TEXT,
  calendar_id TEXT DEFAULT 'primary',
  connected_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 2. TABELLA GOOGLE_CALENDAR_EVENTS
-- Eventi sincronizzati da/verso Google Calendar
-- ============================================

CREATE TABLE IF NOT EXISTS google_calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificazione Google
  google_event_id TEXT UNIQUE NOT NULL,
  calendar_id TEXT DEFAULT 'primary',

  -- Sorgente
  source_type TEXT DEFAULT 'google' CHECK (source_type IN (
    'google', 'calcom', 'manual'
  )),
  source_id TEXT,  -- booking_uid se da calcom

  -- Dettagli evento
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  location TEXT,
  meeting_url TEXT,
  attendees JSONB DEFAULT '[]',

  -- Stato
  status TEXT DEFAULT 'confirmed' CHECK (status IN (
    'confirmed', 'tentative', 'cancelled'
  )),

  -- Tipo
  all_day BOOLEAN DEFAULT false,
  color_id TEXT,

  -- Raw data da Google
  raw_data JSONB DEFAULT '{}',

  -- Sync
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici
CREATE INDEX IF NOT EXISTS idx_gcal_events_google_event_id ON google_calendar_events(google_event_id);
CREATE INDEX IF NOT EXISTS idx_gcal_events_source_type ON google_calendar_events(source_type);
CREATE INDEX IF NOT EXISTS idx_gcal_events_source_id ON google_calendar_events(source_id);
CREATE INDEX IF NOT EXISTS idx_gcal_events_start_time ON google_calendar_events(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_gcal_events_status ON google_calendar_events(status);

-- ============================================
-- 3. TABELLA GOOGLE_SYNC_LOG
-- Log delle sincronizzazioni
-- ============================================

CREATE TABLE IF NOT EXISTS google_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_type TEXT NOT NULL CHECK (sync_type IN ('manual', 'auto', 'webhook')),
  direction TEXT NOT NULL CHECK (direction IN ('push', 'pull', 'full')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  events_pushed INTEGER DEFAULT 0,
  events_pulled INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_google_sync_log_started ON google_sync_log(started_at DESC);

-- ============================================
-- 4. TRIGGER updated_at
-- ============================================

DROP TRIGGER IF EXISTS google_oauth_tokens_updated ON google_oauth_tokens;
CREATE TRIGGER google_oauth_tokens_updated
  BEFORE UPDATE ON google_oauth_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS google_calendar_events_updated ON google_calendar_events;
CREATE TRIGGER google_calendar_events_updated
  BEFORE UPDATE ON google_calendar_events
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 5. RLS POLICIES
-- ============================================

ALTER TABLE google_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_sync_log ENABLE ROW LEVEL SECURITY;

-- Admin access
DROP POLICY IF EXISTS "Admin full access google_oauth_tokens" ON google_oauth_tokens;
CREATE POLICY "Admin full access google_oauth_tokens" ON google_oauth_tokens
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admin full access google_calendar_events" ON google_calendar_events;
CREATE POLICY "Admin full access google_calendar_events" ON google_calendar_events
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admin full access google_sync_log" ON google_sync_log;
CREATE POLICY "Admin full access google_sync_log" ON google_sync_log
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Service role bypass (per operazioni senza auth context)
DROP POLICY IF EXISTS "Service role google_oauth_tokens" ON google_oauth_tokens;
CREATE POLICY "Service role google_oauth_tokens" ON google_oauth_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role google_calendar_events" ON google_calendar_events;
CREATE POLICY "Service role google_calendar_events" ON google_calendar_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role google_sync_log" ON google_sync_log;
CREATE POLICY "Service role google_sync_log" ON google_sync_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);
