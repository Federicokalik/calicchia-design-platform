-- ============================================
-- MIGRATION 006: Domains Management System
-- Gestione completa domini con alert scadenze
-- ============================================

-- ============================================
-- 1. TABELLA DOMINI
-- ============================================

CREATE TABLE IF NOT EXISTS domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relazioni
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,

  -- Informazioni dominio
  domain_name TEXT NOT NULL,
  tld TEXT NOT NULL,
  full_domain TEXT GENERATED ALWAYS AS (domain_name || '.' || tld) STORED,

  -- Registrar e Provider
  registrar TEXT DEFAULT 'altro',
  registrar_account TEXT,
  dns_provider TEXT,
  nameservers JSONB DEFAULT '[]',

  -- Date
  registration_date DATE NOT NULL,
  expiration_date DATE NOT NULL,
  last_renewal_date DATE,

  -- Stato e configurazione
  status TEXT DEFAULT 'active' CHECK (status IN (
    'active',
    'expired',
    'expiring_soon',
    'pending_transfer',
    'pending_registration',
    'redemption',
    'suspended'
  )),

  auto_renew BOOLEAN DEFAULT true,
  whois_privacy BOOLEAN DEFAULT true,

  -- SSL
  ssl_status TEXT DEFAULT 'none' CHECK (ssl_status IN (
    'none', 'lets_encrypt', 'cloudflare', 'custom', 'expired'
  )),
  ssl_expiration DATE,
  ssl_provider TEXT,

  -- Hosting collegato
  hosting_server TEXT,
  ip_address INET,

  -- Costi
  registration_cost DECIMAL(10,2),
  renewal_cost DECIMAL(10,2),
  currency TEXT DEFAULT 'EUR',

  -- Note e metadati
  notes TEXT,
  metadata JSONB DEFAULT '{}',

  -- Tracking alert
  alert_sent_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Vincoli
  UNIQUE(domain_name, tld)
);

-- Indici per performance
CREATE INDEX IF NOT EXISTS domains_customer_idx ON domains(customer_id);
CREATE INDEX IF NOT EXISTS domains_expiration_idx ON domains(expiration_date);
CREATE INDEX IF NOT EXISTS domains_status_idx ON domains(status);
CREATE INDEX IF NOT EXISTS domains_full_domain_idx ON domains(full_domain);
CREATE INDEX IF NOT EXISTS domains_registrar_idx ON domains(registrar);
CREATE INDEX IF NOT EXISTS domains_ssl_expiration_idx ON domains(ssl_expiration);

-- ============================================
-- 2. TABELLA STORICO RINNOVI DOMINI
-- ============================================

CREATE TABLE IF NOT EXISTS domain_renewals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,

  renewal_date DATE NOT NULL,
  expiration_before DATE NOT NULL,
  expiration_after DATE NOT NULL,

  cost DECIMAL(10,2),
  currency TEXT DEFAULT 'EUR',

  invoice_id UUID REFERENCES invoices(id),

  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS domain_renewals_domain_idx ON domain_renewals(domain_id);

-- ============================================
-- 3. TABELLA ALERT DOMINI
-- ============================================

CREATE TABLE IF NOT EXISTS domain_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,

  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'expiring_30_days',
    'expiring_14_days',
    'expiring_7_days',
    'expiring_3_days',
    'expiring_1_day',
    'expired',
    'ssl_expiring',
    'ssl_expired'
  )),

  sent_via TEXT DEFAULT 'email',
  sent_to TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),

  acknowledged BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMPTZ,

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS domain_alerts_domain_idx ON domain_alerts(domain_id);
CREATE INDEX IF NOT EXISTS domain_alerts_type_idx ON domain_alerts(alert_type);

-- ============================================
-- 4. TABELLA TLD PRICING
-- ============================================

CREATE TABLE IF NOT EXISTS tld_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tld TEXT UNIQUE NOT NULL,
  registration_cost DECIMAL(10,2),
  renewal_cost DECIMAL(10,2),
  transfer_cost DECIMAL(10,2),
  currency TEXT DEFAULT 'EUR',
  is_active BOOLEAN DEFAULT true
);

INSERT INTO tld_pricing (tld, registration_cost, renewal_cost, transfer_cost) VALUES
  ('it', 15.00, 15.00, 15.00),
  ('com', 12.00, 12.00, 12.00),
  ('eu', 10.00, 10.00, 10.00),
  ('net', 14.00, 14.00, 14.00),
  ('org', 14.00, 14.00, 14.00),
  ('info', 10.00, 10.00, 10.00),
  ('dev', 18.00, 18.00, 18.00),
  ('io', 45.00, 45.00, 45.00),
  ('design', 40.00, 40.00, 40.00),
  ('co', 30.00, 30.00, 30.00),
  ('me', 20.00, 20.00, 20.00)
ON CONFLICT (tld) DO NOTHING;

-- ============================================
-- 5. VISTE
-- ============================================

-- Vista domini in scadenza
CREATE OR REPLACE VIEW expiring_domains AS
SELECT
  d.id,
  d.full_domain,
  d.domain_name,
  d.tld,
  d.expiration_date,
  d.auto_renew,
  d.renewal_cost,
  d.status,
  d.registrar,
  d.ssl_status,
  d.ssl_expiration,
  c.id as customer_id,
  c.company_name,
  c.contact_name,
  c.email as customer_email,
  (d.expiration_date - CURRENT_DATE) as days_until_expiration,
  CASE
    WHEN d.expiration_date < CURRENT_DATE THEN 'expired'
    WHEN d.expiration_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'critical'
    WHEN d.expiration_date <= CURRENT_DATE + INTERVAL '14 days' THEN 'warning'
    WHEN d.expiration_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'upcoming'
    ELSE 'ok'
  END as urgency_level
FROM domains d
JOIN customers c ON c.id = d.customer_id
WHERE d.status NOT IN ('suspended', 'pending_transfer')
ORDER BY d.expiration_date ASC;

-- Vista SSL in scadenza
CREATE OR REPLACE VIEW expiring_ssl AS
SELECT
  d.id,
  d.full_domain,
  d.ssl_status,
  d.ssl_expiration,
  d.ssl_provider,
  c.company_name,
  c.contact_name,
  c.email,
  (d.ssl_expiration - CURRENT_DATE) as days_until_expiration
FROM domains d
JOIN customers c ON c.id = d.customer_id
WHERE d.ssl_status NOT IN ('none', 'expired')
  AND d.ssl_expiration IS NOT NULL
  AND d.ssl_expiration <= CURRENT_DATE + INTERVAL '30 days'
ORDER BY d.ssl_expiration ASC;

-- Vista riepilogo domini per cliente
CREATE OR REPLACE VIEW customer_domains_summary AS
SELECT
  c.id as customer_id,
  c.company_name,
  c.contact_name,
  COUNT(d.id) as total_domains,
  COUNT(d.id) FILTER (WHERE d.status = 'active') as active_domains,
  COUNT(d.id) FILTER (WHERE d.expiration_date <= CURRENT_DATE + INTERVAL '30 days' AND d.expiration_date > CURRENT_DATE) as expiring_soon,
  COUNT(d.id) FILTER (WHERE d.status = 'expired') as expired_domains,
  COALESCE(SUM(d.renewal_cost), 0) as total_annual_cost,
  MIN(d.expiration_date) FILTER (WHERE d.status = 'active') as next_expiration
FROM customers c
LEFT JOIN domains d ON d.customer_id = c.id
GROUP BY c.id, c.company_name, c.contact_name;

-- ============================================
-- 6. FUNZIONI
-- ============================================

-- Funzione per aggiornare status domini automaticamente
CREATE OR REPLACE FUNCTION update_domain_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.expiration_date < CURRENT_DATE THEN
    NEW.status := 'expired';
  ELSIF NEW.expiration_date <= CURRENT_DATE + INTERVAL '30 days' AND NEW.status = 'active' THEN
    NEW.status := 'expiring_soon';
  ELSIF NEW.expiration_date > CURRENT_DATE + INTERVAL '30 days' AND NEW.status IN ('expired', 'expiring_soon') THEN
    NEW.status := 'active';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Funzione per rinnovare dominio
CREATE OR REPLACE FUNCTION renew_domain(
  p_domain_id UUID,
  p_years INTEGER DEFAULT 1,
  p_cost DECIMAL DEFAULT NULL,
  p_invoice_id UUID DEFAULT NULL
)
RETURNS domains AS $$
DECLARE
  v_domain domains;
  v_old_expiration DATE;
BEGIN
  SELECT * INTO v_domain FROM domains WHERE id = p_domain_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dominio non trovato';
  END IF;

  v_old_expiration := v_domain.expiration_date;

  -- Aggiorna dominio
  UPDATE domains SET
    expiration_date = CASE
      WHEN expiration_date < CURRENT_DATE THEN CURRENT_DATE + (p_years * INTERVAL '1 year')
      ELSE expiration_date + (p_years * INTERVAL '1 year')
    END,
    last_renewal_date = CURRENT_DATE,
    status = 'active',
    alert_sent_at = NULL,
    updated_at = NOW()
  WHERE id = p_domain_id
  RETURNING * INTO v_domain;

  -- Registra nel log rinnovi
  INSERT INTO domain_renewals (
    domain_id, renewal_date, expiration_before, expiration_after,
    cost, invoice_id
  ) VALUES (
    p_domain_id, CURRENT_DATE, v_old_expiration, v_domain.expiration_date,
    COALESCE(p_cost, v_domain.renewal_cost), p_invoice_id
  );

  RETURN v_domain;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 7. TRIGGERS
-- ============================================

DROP TRIGGER IF EXISTS domains_updated ON domains;
CREATE TRIGGER domains_updated
  BEFORE UPDATE ON domains
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS domains_status_check ON domains;
CREATE TRIGGER domains_status_check
  BEFORE INSERT OR UPDATE OF expiration_date ON domains
  FOR EACH ROW
  EXECUTE FUNCTION update_domain_status();

-- ============================================
-- 8. RLS POLICIES
-- ============================================

ALTER TABLE domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tld_pricing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access domains" ON domains
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access domain_renewals" ON domain_renewals
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access domain_alerts" ON domain_alerts
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Anyone can read tld_pricing" ON tld_pricing
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Admin full access tld_pricing" ON tld_pricing
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
