-- ============================================
-- MIGRATION 005: Stripe Customers & Subscriptions
-- Sistema gestione clienti con integrazione Stripe
-- ============================================

-- ============================================
-- 1. TABELLA CLIENTI
-- ============================================

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stripe integration
  stripe_customer_id TEXT UNIQUE,

  -- Anagrafica
  company_name TEXT,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,

  -- Indirizzo fatturazione
  billing_address JSONB DEFAULT '{}',
  -- { street, city, postal_code, province, country, vat_number, fiscal_code }

  -- Note interne
  notes TEXT,
  tags JSONB DEFAULT '[]',

  -- Stato
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),

  -- Metriche
  total_revenue DECIMAL(10,2) DEFAULT 0,
  lifetime_value DECIMAL(10,2) DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customers_email_idx ON customers(email);
CREATE INDEX IF NOT EXISTS customers_stripe_idx ON customers(stripe_customer_id);
CREATE INDEX IF NOT EXISTS customers_status_idx ON customers(status);

-- ============================================
-- 2. TABELLA SERVIZI
-- ============================================

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Info servizio
  name TEXT NOT NULL,
  description TEXT,

  -- Stripe product/price
  stripe_product_id TEXT,
  stripe_price_id TEXT,

  -- Pricing
  price DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'EUR',
  billing_interval TEXT DEFAULT 'year' CHECK (billing_interval IN ('month', 'year', 'one_time')),

  -- Categoria
  category TEXT DEFAULT 'hosting' CHECK (category IN ('hosting', 'domain', 'maintenance', 'development', 'other')),

  -- Stato
  is_active BOOLEAN DEFAULT true,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Servizi predefiniti
INSERT INTO services (name, description, price, category, billing_interval) VALUES
  ('Hosting Annuale', 'Hosting web condiviso con SSL', 120.00, 'hosting', 'year'),
  ('Dominio .it', 'Registrazione/rinnovo dominio .it', 15.00, 'domain', 'year'),
  ('Dominio .com', 'Registrazione/rinnovo dominio .com', 12.00, 'domain', 'year'),
  ('Manutenzione Base', 'Aggiornamenti e backup mensili', 30.00, 'maintenance', 'month'),
  ('Manutenzione Premium', 'Supporto prioritario + modifiche incluse', 80.00, 'maintenance', 'month')
ON CONFLICT DO NOTHING;

-- ============================================
-- 3. TABELLA ABBONAMENTI/CONTRATTI
-- ============================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relazioni
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id),

  -- Stripe
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,

  -- Dettagli
  name TEXT NOT NULL, -- es. "Hosting + Dominio example.com"
  description TEXT,

  -- Pricing
  amount DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'EUR',
  billing_interval TEXT DEFAULT 'year',

  -- Date
  start_date DATE NOT NULL,
  current_period_start DATE,
  current_period_end DATE,
  next_billing_date DATE,
  canceled_at TIMESTAMPTZ,

  -- Stato
  status TEXT DEFAULT 'active' CHECK (status IN (
    'active', 'past_due', 'canceled', 'unpaid', 'trialing', 'incomplete', 'paused'
  )),

  -- Auto-renewal
  auto_renew BOOLEAN DEFAULT true,

  -- Metadati (es. dominio specifico, server, etc.)
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscriptions_customer_idx ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions(status);
CREATE INDEX IF NOT EXISTS subscriptions_next_billing_idx ON subscriptions(next_billing_date);
CREATE INDEX IF NOT EXISTS subscriptions_stripe_idx ON subscriptions(stripe_subscription_id);

-- ============================================
-- 4. TABELLA FATTURE
-- ============================================

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relazioni
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id),

  -- Stripe
  stripe_invoice_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_hosted_invoice_url TEXT,
  stripe_invoice_pdf TEXT,

  -- Numerazione
  invoice_number TEXT,

  -- Importi
  subtotal DECIMAL(10,2) NOT NULL,
  tax DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(10,2) NOT NULL,
  amount_paid DECIMAL(10,2) DEFAULT 0,
  amount_due DECIMAL(10,2) DEFAULT 0,
  currency TEXT DEFAULT 'EUR',

  -- Stato
  status TEXT DEFAULT 'draft' CHECK (status IN (
    'draft', 'open', 'paid', 'void', 'uncollectible'
  )),

  -- Date
  issue_date DATE DEFAULT CURRENT_DATE,
  due_date DATE,
  paid_at TIMESTAMPTZ,

  -- Dettagli righe (line items)
  line_items JSONB DEFAULT '[]',
  -- [{ description, quantity, unit_price, amount }]

  -- Note
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices(status);
CREATE INDEX IF NOT EXISTS invoices_stripe_idx ON invoices(stripe_invoice_id);
CREATE INDEX IF NOT EXISTS invoices_date_idx ON invoices(issue_date DESC);

-- ============================================
-- 5. TABELLA PAGAMENTI
-- ============================================

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relazioni
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id),
  subscription_id UUID REFERENCES subscriptions(id),

  -- Stripe
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_charge_id TEXT,

  -- Importo
  amount DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'EUR',

  -- Metodo pagamento
  payment_method TEXT, -- card, bank_transfer, etc.
  payment_method_details JSONB DEFAULT '{}',
  -- { brand, last4, exp_month, exp_year }

  -- Stato
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed', 'canceled', 'refunded'
  )),

  -- Errore (se fallito)
  failure_reason TEXT,

  -- Refund
  refunded_amount DECIMAL(10,2) DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payments_customer_idx ON payments(customer_id);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status);
CREATE INDEX IF NOT EXISTS payments_stripe_idx ON payments(stripe_payment_intent_id);

-- ============================================
-- 6. TABELLA WEBHOOK LOGS (per debug)
-- ============================================

CREATE TABLE IF NOT EXISTS stripe_webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed BOOLEAN DEFAULT false,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS webhook_logs_event_idx ON stripe_webhook_logs(event_type);
CREATE INDEX IF NOT EXISTS webhook_logs_processed_idx ON stripe_webhook_logs(processed);

-- ============================================
-- 7. RLS POLICIES
-- ============================================

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_webhook_logs ENABLE ROW LEVEL SECURITY;

-- Admin full access
CREATE POLICY "Admin full access customers" ON customers
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access services" ON services
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access subscriptions" ON subscriptions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access invoices" ON invoices
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access payments" ON payments
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access webhook_logs" ON stripe_webhook_logs
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

-- ============================================
-- 8. TRIGGERS
-- ============================================

-- Update timestamps
CREATE TRIGGER customers_updated BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER services_updated BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER subscriptions_updated BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER invoices_updated BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Aggiorna total_revenue cliente dopo pagamento
CREATE OR REPLACE FUNCTION update_customer_revenue()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'succeeded' AND (OLD IS NULL OR OLD.status != 'succeeded') THEN
    UPDATE customers
    SET
      total_revenue = total_revenue + NEW.amount,
      lifetime_value = lifetime_value + NEW.amount
    WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_update_revenue
  AFTER INSERT OR UPDATE ON payments
  FOR EACH ROW
  EXECUTE FUNCTION update_customer_revenue();

-- ============================================
-- 9. VISTE UTILI
-- ============================================

-- Vista rinnovi in scadenza (prossimi 30 giorni)
CREATE OR REPLACE VIEW upcoming_renewals AS
SELECT
  s.id,
  s.name as subscription_name,
  s.amount,
  s.next_billing_date,
  s.status,
  c.id as customer_id,
  c.company_name,
  c.contact_name,
  c.email,
  (s.next_billing_date - CURRENT_DATE) as days_until_renewal
FROM subscriptions s
JOIN customers c ON c.id = s.customer_id
WHERE s.status = 'active'
  AND s.auto_renew = true
  AND s.next_billing_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
ORDER BY s.next_billing_date ASC;

-- Vista clienti con MRR/ARR
CREATE OR REPLACE VIEW customer_revenue AS
SELECT
  c.id,
  c.company_name,
  c.contact_name,
  c.email,
  c.status,
  c.total_revenue,
  COUNT(s.id) as active_subscriptions,
  COALESCE(SUM(
    CASE
      WHEN s.billing_interval = 'month' THEN s.amount
      WHEN s.billing_interval = 'year' THEN s.amount / 12
      ELSE 0
    END
  ), 0) as mrr,
  COALESCE(SUM(
    CASE
      WHEN s.billing_interval = 'year' THEN s.amount
      WHEN s.billing_interval = 'month' THEN s.amount * 12
      ELSE 0
    END
  ), 0) as arr
FROM customers c
LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.status = 'active'
GROUP BY c.id;
