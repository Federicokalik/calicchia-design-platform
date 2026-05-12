-- Migration: 018_api_keys.sql
-- Descrizione: Sistema gestione API Keys
-- Data: 2026-01-20

-- =====================================================
-- TABELLA API_KEYS
-- =====================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Chiave (hash)
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL, -- Primi 8 caratteri per identificazione

  -- Info
  name TEXT NOT NULL,
  description TEXT,

  -- Owner
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

  -- Permessi
  scopes TEXT[] DEFAULT '{}', -- ['read:posts', 'write:contacts', etc.]

  -- Rate limiting
  rate_limit_per_minute INTEGER DEFAULT 60,
  rate_limit_per_day INTEGER DEFAULT 10000,

  -- Stats
  last_used_at TIMESTAMPTZ,
  usage_count INTEGER DEFAULT 0,

  -- Restrictions
  allowed_ips TEXT[],        -- IP whitelist (null = any)
  allowed_origins TEXT[],    -- CORS origins (null = any)
  allowed_endpoints TEXT[],  -- Endpoint patterns (null = any)

  -- Status
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,

  -- Audit
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_api_keys_customer ON api_keys(customer_id);
CREATE INDEX idx_api_keys_active ON api_keys(is_active) WHERE is_active = true;

-- =====================================================
-- TABELLA API_KEY_USAGE
-- Log utilizzo API keys
-- =====================================================

CREATE TABLE IF NOT EXISTS api_key_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,

  -- Request info
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER,
  response_time_ms INTEGER,

  -- Client info
  ip_address TEXT,
  user_agent TEXT,
  origin TEXT,

  -- Metadata
  request_id TEXT,
  error_message TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indice per cleanup e analytics
CREATE INDEX idx_api_key_usage_key ON api_key_usage(api_key_id);
CREATE INDEX idx_api_key_usage_date ON api_key_usage(created_at);

-- Partitioning per data (opzionale, per performance)
-- CREATE INDEX idx_api_key_usage_key_date ON api_key_usage(api_key_id, created_at);

-- =====================================================
-- SCOPES DISPONIBILI
-- =====================================================

-- Reference per scopes validi
COMMENT ON TABLE api_keys IS 'Available scopes:
  - read:posts - Leggi blog posts pubblici
  - read:projects - Leggi progetti pubblici
  - read:contacts - Leggi contatti (admin)
  - write:contacts - Crea contatti (form)
  - read:customers - Leggi clienti (admin)
  - write:customers - Gestisci clienti (admin)
  - read:domains - Leggi domini (admin)
  - write:domains - Gestisci domini (admin)
  - read:invoices - Leggi fatture (admin/customer)
  - read:subscriptions - Leggi abbonamenti
  - webhook:* - Accesso webhook
  - admin:* - Full admin access
';

-- =====================================================
-- FUNZIONI
-- =====================================================

-- Genera API key sicura
CREATE OR REPLACE FUNCTION generate_api_key()
RETURNS TEXT AS $$
DECLARE
  v_key TEXT;
BEGIN
  -- Formato: ck_live_xxxxxxxxxxxxxxxxxxxx (32 caratteri random)
  v_key := 'ck_live_' || encode(gen_random_bytes(24), 'hex');
  RETURN v_key;
END;
$$ LANGUAGE plpgsql;

-- Crea API key con hash
CREATE OR REPLACE FUNCTION create_api_key(
  p_name TEXT,
  p_scopes TEXT[] DEFAULT '{}',
  p_rate_limit_per_minute INTEGER DEFAULT 60,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_customer_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  key TEXT,
  key_prefix TEXT
) AS $$
DECLARE
  v_key TEXT;
  v_hash TEXT;
  v_prefix TEXT;
  v_id UUID;
BEGIN
  -- Solo admin può creare API keys
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Solo admin può creare API keys';
  END IF;

  -- Genera chiave
  v_key := generate_api_key();
  v_prefix := substring(v_key from 1 for 12);
  v_hash := encode(sha256(v_key::bytea), 'hex');

  -- Inserisci
  INSERT INTO api_keys (
    key_hash,
    key_prefix,
    name,
    description,
    scopes,
    rate_limit_per_minute,
    expires_at,
    customer_id,
    created_by,
    user_id
  )
  VALUES (
    v_hash,
    v_prefix,
    p_name,
    p_description,
    p_scopes,
    p_rate_limit_per_minute,
    p_expires_at,
    p_customer_id,
    auth.uid(),
    auth.uid()
  )
  RETURNING api_keys.id INTO v_id;

  -- Ritorna chiave (visibile solo ora!)
  RETURN QUERY SELECT v_id, v_key, v_prefix;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Valida API key
CREATE OR REPLACE FUNCTION validate_api_key(
  p_key TEXT,
  p_endpoint TEXT DEFAULT NULL,
  p_required_scope TEXT DEFAULT NULL
)
RETURNS TABLE (
  valid BOOLEAN,
  api_key_id UUID,
  scopes TEXT[],
  rate_limit_per_minute INTEGER,
  error_message TEXT
) AS $$
DECLARE
  v_hash TEXT;
  v_api_key api_keys%ROWTYPE;
BEGIN
  -- Hash della chiave fornita
  v_hash := encode(sha256(p_key::bytea), 'hex');

  -- Trova API key
  SELECT * INTO v_api_key
  FROM api_keys
  WHERE key_hash = v_hash;

  -- Non trovata
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, NULL::TEXT[], 0, 'API key non valida';
    RETURN;
  END IF;

  -- Disattivata
  IF NOT v_api_key.is_active THEN
    RETURN QUERY SELECT false, v_api_key.id, v_api_key.scopes, 0, 'API key disattivata';
    RETURN;
  END IF;

  -- Scaduta
  IF v_api_key.expires_at IS NOT NULL AND v_api_key.expires_at < NOW() THEN
    RETURN QUERY SELECT false, v_api_key.id, v_api_key.scopes, 0, 'API key scaduta';
    RETURN;
  END IF;

  -- Verifica scope richiesto
  IF p_required_scope IS NOT NULL THEN
    IF NOT (
      'admin:*' = ANY(v_api_key.scopes) OR
      p_required_scope = ANY(v_api_key.scopes) OR
      split_part(p_required_scope, ':', 1) || ':*' = ANY(v_api_key.scopes)
    ) THEN
      RETURN QUERY SELECT false, v_api_key.id, v_api_key.scopes, 0,
        'Scope non autorizzato: ' || p_required_scope;
      RETURN;
    END IF;
  END IF;

  -- Verifica endpoint consentito
  IF v_api_key.allowed_endpoints IS NOT NULL AND array_length(v_api_key.allowed_endpoints, 1) > 0 THEN
    IF p_endpoint IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM unnest(v_api_key.allowed_endpoints) AS pattern
        WHERE p_endpoint LIKE pattern
      ) THEN
        RETURN QUERY SELECT false, v_api_key.id, v_api_key.scopes, 0,
          'Endpoint non consentito';
        RETURN;
      END IF;
    END IF;
  END IF;

  -- Aggiorna last_used e usage_count
  UPDATE api_keys SET
    last_used_at = NOW(),
    usage_count = usage_count + 1
  WHERE id = v_api_key.id;

  -- Valido!
  RETURN QUERY SELECT true, v_api_key.id, v_api_key.scopes,
    v_api_key.rate_limit_per_minute, NULL::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Revoca API key
CREATE OR REPLACE FUNCTION revoke_api_key(p_key_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Solo admin può revocare API keys';
  END IF;

  UPDATE api_keys
  SET is_active = false, updated_at = NOW()
  WHERE id = p_key_id;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup vecchi log (> 30 giorni)
CREATE OR REPLACE FUNCTION cleanup_api_key_usage()
RETURNS INTEGER AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM api_key_usage
  WHERE created_at < NOW() - INTERVAL '30 days';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VISTE
-- =====================================================

CREATE OR REPLACE VIEW api_keys_view AS
SELECT
  ak.id,
  ak.key_prefix,
  ak.name,
  ak.description,
  ak.scopes,
  ak.rate_limit_per_minute,
  ak.rate_limit_per_day,
  ak.last_used_at,
  ak.usage_count,
  ak.is_active,
  ak.expires_at,
  ak.allowed_ips,
  ak.allowed_origins,
  ak.created_at,
  p.email AS created_by_email,
  COALESCE(c.company_name, c.contact_name) AS customer_name
FROM api_keys ak
LEFT JOIN profiles p ON p.id = ak.created_by
LEFT JOIN customers c ON c.id = ak.customer_id
ORDER BY ak.created_at DESC;

CREATE OR REPLACE VIEW api_key_stats AS
SELECT
  ak.id,
  ak.name,
  ak.key_prefix,
  ak.usage_count AS total_requests,
  COUNT(aku.id) FILTER (WHERE aku.created_at > NOW() - INTERVAL '24 hours') AS requests_24h,
  COUNT(aku.id) FILTER (WHERE aku.created_at > NOW() - INTERVAL '1 hour') AS requests_1h,
  COUNT(aku.id) FILTER (WHERE aku.status_code >= 400) AS error_count,
  AVG(aku.response_time_ms)::INTEGER AS avg_response_time_ms,
  ak.last_used_at
FROM api_keys ak
LEFT JOIN api_key_usage aku ON aku.api_key_id = ak.id
  AND aku.created_at > NOW() - INTERVAL '7 days'
GROUP BY ak.id, ak.name, ak.key_prefix, ak.usage_count, ak.last_used_at;

-- =====================================================
-- RLS
-- =====================================================

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_usage ENABLE ROW LEVEL SECURITY;

-- Solo admin
DROP POLICY IF EXISTS "Admin full access api_keys" ON api_keys;
CREATE POLICY "Admin full access api_keys" ON api_keys
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admin full access api_key_usage" ON api_key_usage;
CREATE POLICY "Admin full access api_key_usage" ON api_key_usage
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- =====================================================
-- GRANTS
-- =====================================================

GRANT SELECT ON api_keys_view TO authenticated;
GRANT SELECT ON api_key_stats TO authenticated;

-- =====================================================
-- TRIGGER UPDATED_AT
-- =====================================================

DROP TRIGGER IF EXISTS update_api_keys_updated_at ON api_keys;
CREATE TRIGGER update_api_keys_updated_at
  BEFORE UPDATE ON api_keys
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
