-- 091_calendar_subscriptions.sql — Read-only ICS subscriptions (Google Calendar import without OAuth)
--
-- Pattern: l'utente incolla l'URL "secret iCal" da Google Calendar (o qualsiasi altro
-- feed ICS pubblico) e i suoi VEVENT vengono importati periodicamente in un calendar Caldes
-- come eventi con source='ics_pull'. Questi entrano in getBusyRanges → bloccano gli slot
-- pubblici di booking esattamente come un evento manuale.
--
-- Note privacy / loop:
--  * I VEVENT importati NON vengono ripubblicati dall'ICS feed in uscita (filtro in ics-feed.ts).
--    Altrimenti chiunque abbia il token feed Caldes vedrebbe il calendario Google sottostante.
--  * Eliminare una subscription cancella in cascata i suoi eventi (subscription_id FK).

CREATE TABLE IF NOT EXISTS calendar_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Calendario destinazione (gli eventi importati appaiono qui)
  calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,

  -- Identificazione
  name TEXT NOT NULL,
  ics_url TEXT NOT NULL,
  CHECK (ics_url ~* '^https?://'),

  -- Sync
  sync_enabled BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  etag TEXT,
  last_modified TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS calendar_subscriptions_calendar_idx ON calendar_subscriptions(calendar_id);
CREATE INDEX IF NOT EXISTS calendar_subscriptions_enabled_idx ON calendar_subscriptions(sync_enabled) WHERE sync_enabled = true;

DROP TRIGGER IF EXISTS calendar_subscriptions_updated ON calendar_subscriptions;
CREATE TRIGGER calendar_subscriptions_updated
  BEFORE UPDATE ON calendar_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE calendar_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin manage subscriptions" ON calendar_subscriptions;
CREATE POLICY "Admin manage subscriptions" ON calendar_subscriptions
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Service role subscriptions" ON calendar_subscriptions;
CREATE POLICY "Service role subscriptions" ON calendar_subscriptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Extend calendar_events: aggiungi 'ics_pull' al CHECK + FK opzionale a subscription
-- ============================================

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_source_check;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_source_check
  CHECK (source IN ('manual','booking','admin','mcp','agent','ics_pull'));

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS subscription_id UUID
  REFERENCES calendar_subscriptions(id) ON DELETE CASCADE;

-- Index per il refresh delta (sync rimpiazza tutti gli eventi di una subscription)
CREATE INDEX IF NOT EXISTS calendar_events_subscription_idx
  ON calendar_events(subscription_id) WHERE subscription_id IS NOT NULL;
