-- Migration: 012_audit_logging.sql
-- Descrizione: Sistema Audit Logging completo
-- Data: 2026-01-20

-- =====================================================
-- TABELLA AUDIT_LOGS
-- Log di tutte le modifiche su tabelle critiche
-- =====================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Chi
  user_id UUID REFERENCES auth.users(id),
  user_email TEXT,
  user_role TEXT,

  -- Cosa
  action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  table_name TEXT NOT NULL,
  record_id TEXT, -- UUID o altro ID primario come text

  -- Dati
  old_data JSONB,
  new_data JSONB,
  changed_fields TEXT[], -- Lista campi modificati

  -- Contesto
  ip_address INET,
  user_agent TEXT,
  request_id TEXT, -- Per correlazione con logs applicativi

  -- Metadata
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici per query comuni
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_table ON audit_logs(table_name);
CREATE INDEX idx_audit_logs_record ON audit_logs(table_name, record_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_created_table ON audit_logs(created_at DESC, table_name);

-- Partitioning per performance (opzionale, per volumi alti)
-- In futuro: partizionare per mese

-- =====================================================
-- FUNZIONE AUDIT TRIGGER
-- Trigger generico per audit logging
-- =====================================================

CREATE OR REPLACE FUNCTION audit_trigger_function()
RETURNS TRIGGER AS $$
DECLARE
  v_old_data JSONB;
  v_new_data JSONB;
  v_changed_fields TEXT[];
  v_user_id UUID;
  v_user_email TEXT;
  v_user_role TEXT;
  v_record_id TEXT;
  key TEXT;
BEGIN
  -- Recupera info utente corrente
  v_user_id := auth.uid();

  IF v_user_id IS NOT NULL THEN
    SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;
    SELECT role INTO v_user_role FROM profiles WHERE id = v_user_id;
  END IF;

  -- Determina record_id
  IF TG_OP = 'DELETE' THEN
    v_record_id := OLD.id::TEXT;
    v_old_data := to_jsonb(OLD);
    v_new_data := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_record_id := NEW.id::TEXT;
    v_old_data := NULL;
    v_new_data := to_jsonb(NEW);
  ELSE -- UPDATE
    v_record_id := NEW.id::TEXT;
    v_old_data := to_jsonb(OLD);
    v_new_data := to_jsonb(NEW);

    -- Trova campi modificati
    v_changed_fields := ARRAY[]::TEXT[];
    FOR key IN SELECT jsonb_object_keys(v_new_data)
    LOOP
      IF v_old_data->key IS DISTINCT FROM v_new_data->key THEN
        v_changed_fields := array_append(v_changed_fields, key);
      END IF;
    END LOOP;

    -- Non loggare se non ci sono modifiche effettive (escludi updated_at)
    IF array_length(v_changed_fields, 1) = 1 AND v_changed_fields[1] = 'updated_at' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  END IF;

  -- Inserisci log
  INSERT INTO audit_logs (
    user_id, user_email, user_role,
    action, table_name, record_id,
    old_data, new_data, changed_fields
  )
  VALUES (
    v_user_id, v_user_email, v_user_role,
    TG_OP, TG_TABLE_NAME, v_record_id,
    v_old_data, v_new_data, v_changed_fields
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- APPLICA TRIGGER ALLE TABELLE CRITICHE
-- =====================================================

-- CUSTOMERS
DROP TRIGGER IF EXISTS audit_customers ON customers;
CREATE TRIGGER audit_customers
  AFTER INSERT OR UPDATE OR DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- INVOICES
DROP TRIGGER IF EXISTS audit_invoices ON invoices;
CREATE TRIGGER audit_invoices
  AFTER INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- QUOTES
DROP TRIGGER IF EXISTS audit_quotes ON quotes;
CREATE TRIGGER audit_quotes
  AFTER INSERT OR UPDATE OR DELETE ON quotes
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- CLIENT_PROJECTS
DROP TRIGGER IF EXISTS audit_client_projects ON client_projects;
CREATE TRIGGER audit_client_projects
  AFTER INSERT OR UPDATE OR DELETE ON client_projects
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- DOMAINS
DROP TRIGGER IF EXISTS audit_domains ON domains;
CREATE TRIGGER audit_domains
  AFTER INSERT OR UPDATE OR DELETE ON domains
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- SUBSCRIPTIONS
DROP TRIGGER IF EXISTS audit_subscriptions ON subscriptions;
CREATE TRIGGER audit_subscriptions
  AFTER INSERT OR UPDATE OR DELETE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- PROFILES (per modifiche ruoli, etc)
DROP TRIGGER IF EXISTS audit_profiles ON profiles;
CREATE TRIGGER audit_profiles
  AFTER INSERT OR UPDATE OR DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- CUSTOMER_USERS (accessi portal)
DROP TRIGGER IF EXISTS audit_customer_users ON customer_users;
CREATE TRIGGER audit_customer_users
  AFTER INSERT OR UPDATE OR DELETE ON customer_users
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- INVOICE_SETTINGS
DROP TRIGGER IF EXISTS audit_invoice_settings ON invoice_settings;
CREATE TRIGGER audit_invoice_settings
  AFTER INSERT OR UPDATE OR DELETE ON invoice_settings
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- =====================================================
-- FUNZIONI HELPER
-- =====================================================

-- Recupera cronologia modifiche per un record
CREATE OR REPLACE FUNCTION get_record_history(
  p_table_name TEXT,
  p_record_id TEXT,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  action TEXT,
  user_email TEXT,
  changed_fields TEXT[],
  old_data JSONB,
  new_data JSONB,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    al.id,
    al.action,
    al.user_email,
    al.changed_fields,
    al.old_data,
    al.new_data,
    al.created_at
  FROM audit_logs al
  WHERE al.table_name = p_table_name
    AND al.record_id = p_record_id
  ORDER BY al.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Recupera attività recente per utente
CREATE OR REPLACE FUNCTION get_user_activity(
  p_user_id UUID,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  action TEXT,
  table_name TEXT,
  record_id TEXT,
  changed_fields TEXT[],
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    al.id,
    al.action,
    al.table_name,
    al.record_id,
    al.changed_fields,
    al.created_at
  FROM audit_logs al
  WHERE al.user_id = p_user_id
  ORDER BY al.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Statistiche audit per dashboard
CREATE OR REPLACE FUNCTION get_audit_stats(
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  table_name TEXT,
  insert_count BIGINT,
  update_count BIGINT,
  delete_count BIGINT,
  total_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    al.table_name,
    COUNT(*) FILTER (WHERE al.action = 'INSERT'),
    COUNT(*) FILTER (WHERE al.action = 'UPDATE'),
    COUNT(*) FILTER (WHERE al.action = 'DELETE'),
    COUNT(*)
  FROM audit_logs al
  WHERE al.created_at >= NOW() - (p_days || ' days')::INTERVAL
  GROUP BY al.table_name
  ORDER BY COUNT(*) DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- =====================================================
-- PULIZIA AUTOMATICA
-- Funzione per pulire log vecchi
-- =====================================================

CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(
  p_retention_days INTEGER DEFAULT 365
)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM audit_logs
  WHERE created_at < NOW() - (p_retention_days || ' days')::INTERVAL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- RLS POLICIES
-- =====================================================

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Solo admin può vedere audit logs
DROP POLICY IF EXISTS "Admin full access audit_logs" ON audit_logs;
CREATE POLICY "Admin full access audit_logs" ON audit_logs
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- =====================================================
-- VISTE
-- =====================================================

-- Vista attività recente
CREATE OR REPLACE VIEW recent_activity AS
SELECT
  al.id,
  al.user_email,
  al.action,
  al.table_name,
  al.record_id,
  al.changed_fields,
  CASE
    WHEN al.created_at > NOW() - INTERVAL '1 minute' THEN 'just now'
    WHEN al.created_at > NOW() - INTERVAL '1 hour' THEN
      EXTRACT(MINUTE FROM NOW() - al.created_at)::TEXT || ' min ago'
    WHEN al.created_at > NOW() - INTERVAL '1 day' THEN
      EXTRACT(HOUR FROM NOW() - al.created_at)::TEXT || ' hours ago'
    ELSE TO_CHAR(al.created_at, 'DD Mon YYYY HH24:MI')
  END AS time_ago,
  al.created_at
FROM audit_logs al
WHERE is_admin()
ORDER BY al.created_at DESC
LIMIT 100;

-- Vista modifiche per tabella
CREATE OR REPLACE VIEW audit_by_table AS
SELECT
  table_name,
  COUNT(*) AS total_changes,
  COUNT(*) FILTER (WHERE action = 'INSERT') AS inserts,
  COUNT(*) FILTER (WHERE action = 'UPDATE') AS updates,
  COUNT(*) FILTER (WHERE action = 'DELETE') AS deletes,
  MAX(created_at) AS last_change
FROM audit_logs
WHERE is_admin()
GROUP BY table_name
ORDER BY total_changes DESC;

GRANT SELECT ON recent_activity TO authenticated;
GRANT SELECT ON audit_by_table TO authenticated;
