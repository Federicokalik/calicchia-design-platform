-- Data retention functions (GDPR compliance)
-- Schedule weekly via pg_cron or external cron calling the admin API

-- Purge analytics older than 26 months
CREATE OR REPLACE FUNCTION purge_old_analytics() RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM analytics WHERE created_at < NOW() - INTERVAL '26 months';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

-- Anonymize contacts older than 24 months (keep metadata for stats, remove PII)
CREATE OR REPLACE FUNCTION purge_old_contacts() RETURNS INTEGER AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE contacts SET
    name = 'ANONIMIZZATO',
    email = 'anonimizzato@removed.gdpr',
    phone = NULL,
    company = NULL,
    message = NULL,
    ip_address = NULL,
    user_agent = NULL
  WHERE created_at < NOW() - INTERVAL '24 months'
    AND email != 'anonimizzato@removed.gdpr';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql;

-- Purge audit logs older than 365 days
CREATE OR REPLACE FUNCTION purge_old_audit_logs() RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '365 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

-- Purge cookie consents older than 12 months
CREATE OR REPLACE FUNCTION purge_old_cookie_consents() RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM cookie_consents WHERE created_at < NOW() - INTERVAL '12 months';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

-- Master function: runs all purges and returns summary
CREATE OR REPLACE FUNCTION run_data_retention() RETURNS JSONB AS $$
DECLARE
  analytics_purged INTEGER;
  contacts_purged INTEGER;
  audit_purged INTEGER;
  consents_purged INTEGER;
BEGIN
  SELECT purge_old_analytics() INTO analytics_purged;
  SELECT purge_old_contacts() INTO contacts_purged;
  SELECT purge_old_audit_logs() INTO audit_purged;
  SELECT purge_old_cookie_consents() INTO consents_purged;

  RETURN jsonb_build_object(
    'analytics_purged', analytics_purged,
    'contacts_anonymized', contacts_purged,
    'audit_logs_purged', audit_purged,
    'cookie_consents_purged', consents_purged,
    'executed_at', NOW()
  );
END;
$$ LANGUAGE plpgsql;
