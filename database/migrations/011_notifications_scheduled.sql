-- Migration: 011_notifications_scheduled.sql
-- Descrizione: Sistema Notifiche In-App + Pubblicazione Programmata
-- Data: 2026-01-20

-- =====================================================
-- TABELLA NOTIFICATIONS
-- Notifiche in-app per utenti
-- =====================================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Tipo e contenuto
  type TEXT NOT NULL CHECK (type IN (
    'info', 'success', 'warning', 'error',
    'invoice_created', 'invoice_paid', 'invoice_overdue',
    'quote_sent', 'quote_accepted', 'quote_rejected',
    'project_created', 'project_updated', 'project_completed',
    'task_assigned', 'task_completed', 'task_comment',
    'domain_expiring', 'domain_expired',
    'subscription_created', 'subscription_cancelled',
    'portal_invite', 'system'
  )),
  title TEXT NOT NULL,
  message TEXT,

  -- Link opzionale
  action_url TEXT,
  action_label TEXT,

  -- Riferimenti entità
  entity_type TEXT, -- 'invoice', 'quote', 'project', 'task', 'domain', etc.
  entity_id UUID,

  -- Stato
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,

  -- Metadata
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);

-- =====================================================
-- TABELLA NOTIFICATION_PREFERENCES
-- Preferenze notifiche per utente
-- =====================================================

CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,

  -- Canali
  email_enabled BOOLEAN DEFAULT true,
  push_enabled BOOLEAN DEFAULT false,
  in_app_enabled BOOLEAN DEFAULT true,

  -- Preferenze per tipo (JSONB per flessibilità)
  preferences JSONB DEFAULT '{
    "invoice_created": {"email": true, "in_app": true},
    "invoice_paid": {"email": true, "in_app": true},
    "invoice_overdue": {"email": true, "in_app": true},
    "quote_sent": {"email": false, "in_app": true},
    "quote_accepted": {"email": true, "in_app": true},
    "quote_rejected": {"email": true, "in_app": true},
    "project_created": {"email": false, "in_app": true},
    "project_updated": {"email": false, "in_app": true},
    "task_assigned": {"email": true, "in_app": true},
    "task_comment": {"email": false, "in_app": true},
    "domain_expiring": {"email": true, "in_app": true},
    "domain_expired": {"email": true, "in_app": true},
    "subscription_cancelled": {"email": true, "in_app": true}
  }',

  -- Digest
  digest_frequency TEXT DEFAULT 'none' CHECK (digest_frequency IN ('none', 'daily', 'weekly')),
  digest_time TIME DEFAULT '09:00',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- FUNZIONI NOTIFICHE
-- =====================================================

-- Crea notifica
CREATE OR REPLACE FUNCTION create_notification(
  p_user_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_message TEXT DEFAULT NULL,
  p_action_url TEXT DEFAULT NULL,
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
  v_notification_id UUID;
  v_prefs notification_preferences%ROWTYPE;
BEGIN
  -- Verifica preferenze utente
  SELECT * INTO v_prefs FROM notification_preferences WHERE user_id = p_user_id;

  -- Se non ci sono preferenze o in_app è abilitato, crea notifica
  IF NOT FOUND OR v_prefs.in_app_enabled THEN
    INSERT INTO notifications (
      user_id, type, title, message, action_url,
      entity_type, entity_id, metadata
    )
    VALUES (
      p_user_id, p_type, p_title, p_message, p_action_url,
      p_entity_type, p_entity_id, p_metadata
    )
    RETURNING id INTO v_notification_id;
  END IF;

  RETURN v_notification_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Segna come letta
CREATE OR REPLACE FUNCTION mark_notification_read(p_notification_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE notifications
  SET read_at = NOW()
  WHERE id = p_notification_id
    AND user_id = auth.uid()
    AND read_at IS NULL;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Segna tutte come lette
CREATE OR REPLACE FUNCTION mark_all_notifications_read()
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE notifications
  SET read_at = NOW()
  WHERE user_id = auth.uid()
    AND read_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Conta non lette
CREATE OR REPLACE FUNCTION get_unread_notification_count()
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::INTEGER
    FROM notifications
    WHERE user_id = auth.uid()
      AND read_at IS NULL
      AND archived_at IS NULL
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- =====================================================
-- SCHEDULED PUBLISHING
-- Aggiunge publish_at e status a blog_posts
-- =====================================================

-- Aggiungi colonna status (sostituisce is_published)
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';

-- Migra dati esistenti da is_published a status
UPDATE blog_posts SET status = 'published' WHERE is_published = true AND status = 'draft';
UPDATE blog_posts SET status = 'draft' WHERE is_published = false AND status = 'draft';

-- Aggiungi colonne per scheduling
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS unpublish_at TIMESTAMPTZ;

-- Constraint per status
ALTER TABLE blog_posts DROP CONSTRAINT IF EXISTS blog_posts_status_check;
ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_status_check
  CHECK (status IN ('draft', 'published', 'scheduled', 'archived'));

-- Indice per query scheduled
CREATE INDEX IF NOT EXISTS idx_blog_posts_publish_at ON blog_posts(publish_at)
  WHERE status = 'scheduled' AND publish_at IS NOT NULL;

-- Indice per status
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);

-- Funzione per pubblicare post schedulati
CREATE OR REPLACE FUNCTION publish_scheduled_posts()
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE blog_posts
  SET
    status = 'published',
    published_at = NOW()
  WHERE status = 'scheduled'
    AND publish_at <= NOW();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Funzione per archiviare post scaduti
CREATE OR REPLACE FUNCTION archive_expired_posts()
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE blog_posts
  SET status = 'archived'
  WHERE status = 'published'
    AND unpublish_at IS NOT NULL
    AND unpublish_at <= NOW();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- RLS POLICIES
-- =====================================================

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- NOTIFICATIONS: utenti vedono solo le proprie
DROP POLICY IF EXISTS "Users view own notifications" ON notifications;
CREATE POLICY "Users view own notifications" ON notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users update own notifications" ON notifications;
CREATE POLICY "Users update own notifications" ON notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Admin full access notifications" ON notifications;
CREATE POLICY "Admin full access notifications" ON notifications
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- NOTIFICATION_PREFERENCES
DROP POLICY IF EXISTS "Users manage own preferences" ON notification_preferences;
CREATE POLICY "Users manage own preferences" ON notification_preferences
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- =====================================================
-- TRIGGERS
-- =====================================================

-- Updated_at per preferences
DROP TRIGGER IF EXISTS update_notification_preferences_updated_at ON notification_preferences;
CREATE TRIGGER update_notification_preferences_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- REALTIME
-- Abilita realtime per notifiche
-- =====================================================

-- Nota: eseguire in Supabase Dashboard:
-- ALTER PUBLICATION supabase_realtime ADD TABLE notifications;

-- =====================================================
-- VISTA NOTIFICHE
-- =====================================================

CREATE OR REPLACE VIEW user_notifications AS
SELECT
  n.*,
  CASE
    WHEN n.created_at > NOW() - INTERVAL '1 minute' THEN 'just now'
    WHEN n.created_at > NOW() - INTERVAL '1 hour' THEN
      EXTRACT(MINUTE FROM NOW() - n.created_at)::TEXT || ' min ago'
    WHEN n.created_at > NOW() - INTERVAL '1 day' THEN
      EXTRACT(HOUR FROM NOW() - n.created_at)::TEXT || ' hours ago'
    ELSE TO_CHAR(n.created_at, 'DD Mon YYYY')
  END AS time_ago
FROM notifications n
WHERE n.user_id = auth.uid()
  AND n.archived_at IS NULL
ORDER BY n.created_at DESC;

GRANT SELECT ON user_notifications TO authenticated;
