-- ============================================
-- MIGRATION 007: WooCommerce Integration
-- Sincronizzazione con shop WooCommerce
-- ============================================

-- ============================================
-- 1. TABELLA STORES WOOCOMMERCE
-- ============================================

CREATE TABLE IF NOT EXISTS woocommerce_stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificazione
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,

  -- Credenziali API (criptate a livello applicativo)
  consumer_key TEXT NOT NULL,
  consumer_secret TEXT NOT NULL,
  webhook_secret TEXT,

  -- Configurazione sync
  is_active BOOLEAN DEFAULT true,
  auto_sync BOOLEAN DEFAULT true,
  auto_create_customer BOOLEAN DEFAULT true,
  auto_create_subscription BOOLEAN DEFAULT true,
  auto_create_project BOOLEAN DEFAULT true,

  -- Mapping defaults
  default_subscription_category TEXT DEFAULT 'ecommerce',
  default_project_type TEXT DEFAULT 'ecommerce',
  default_tags JSONB DEFAULT '["woocommerce", "ecommerce"]',

  -- Statistiche
  last_sync_at TIMESTAMPTZ,
  last_webhook_at TIMESTAMPTZ,
  total_orders_synced INTEGER DEFAULT 0,
  total_customers_synced INTEGER DEFAULT 0,

  -- Metadati
  metadata JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 2. TABELLA ORDINI WOOCOMMERCE
-- ============================================

CREATE TABLE IF NOT EXISTS woocommerce_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relazione store
  store_id UUID NOT NULL REFERENCES woocommerce_stores(id) ON DELETE CASCADE,

  -- Dati WooCommerce
  wc_order_id INTEGER NOT NULL,
  wc_order_number TEXT,
  wc_order_key TEXT,

  -- Mapping CRM
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  project_id UUID, -- FK verrà aggiunta dopo creazione tabella projects

  -- Stato sync
  sync_status TEXT DEFAULT 'pending' CHECK (sync_status IN (
    'pending',      -- Da processare
    'synced',       -- Sincronizzato con CRM
    'error',        -- Errore durante sync
    'ignored',      -- Ignorato (es. ordine test)
    'manual'        -- Richiede intervento manuale
  )),
  sync_error TEXT,
  synced_at TIMESTAMPTZ,

  -- Dati ordine
  status TEXT NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(10,2),
  total_tax DECIMAL(10,2),
  shipping_total DECIMAL(10,2),
  discount_total DECIMAL(10,2),
  currency TEXT DEFAULT 'EUR',

  -- Dati cliente ordine
  billing_email TEXT,
  billing_first_name TEXT,
  billing_last_name TEXT,
  billing_company TEXT,
  billing_phone TEXT,
  billing_address JSONB,
  shipping_address JSONB,

  -- Dati prodotti
  line_items JSONB NOT NULL DEFAULT '[]',
  product_names TEXT[], -- Array nomi prodotti per ricerca

  -- Pagamento
  payment_method TEXT,
  payment_method_title TEXT,
  transaction_id TEXT,

  -- Date WooCommerce
  date_created TIMESTAMPTZ,
  date_modified TIMESTAMPTZ,
  date_completed TIMESTAMPTZ,
  date_paid TIMESTAMPTZ,

  -- Note
  customer_note TEXT,
  internal_notes JSONB DEFAULT '[]',

  -- Metadati WooCommerce
  wc_metadata JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Vincoli
  UNIQUE(store_id, wc_order_id)
);

-- Indici
CREATE INDEX IF NOT EXISTS wc_orders_store_idx ON woocommerce_orders(store_id);
CREATE INDEX IF NOT EXISTS wc_orders_customer_idx ON woocommerce_orders(customer_id);
CREATE INDEX IF NOT EXISTS wc_orders_status_idx ON woocommerce_orders(status);
CREATE INDEX IF NOT EXISTS wc_orders_sync_status_idx ON woocommerce_orders(sync_status);
CREATE INDEX IF NOT EXISTS wc_orders_billing_email_idx ON woocommerce_orders(billing_email);
CREATE INDEX IF NOT EXISTS wc_orders_date_created_idx ON woocommerce_orders(date_created DESC);

-- ============================================
-- 3. TABELLA CLIENTI WOOCOMMERCE
-- ============================================

CREATE TABLE IF NOT EXISTS woocommerce_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Relazione store
  store_id UUID NOT NULL REFERENCES woocommerce_stores(id) ON DELETE CASCADE,

  -- Dati WooCommerce
  wc_customer_id INTEGER NOT NULL,
  wc_username TEXT,

  -- Mapping CRM
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,

  -- Dati cliente
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  company TEXT,
  phone TEXT,

  billing_address JSONB,
  shipping_address JSONB,

  -- Statistiche WooCommerce
  orders_count INTEGER DEFAULT 0,
  total_spent DECIMAL(10,2) DEFAULT 0,

  -- Date
  date_created TIMESTAMPTZ,
  date_modified TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Vincoli
  UNIQUE(store_id, wc_customer_id)
);

CREATE INDEX IF NOT EXISTS wc_customers_store_idx ON woocommerce_customers(store_id);
CREATE INDEX IF NOT EXISTS wc_customers_email_idx ON woocommerce_customers(email);
CREATE INDEX IF NOT EXISTS wc_customers_crm_idx ON woocommerce_customers(customer_id);

-- ============================================
-- 4. TABELLA PRODOTTI WOOCOMMERCE (Cache)
-- ============================================

CREATE TABLE IF NOT EXISTS woocommerce_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  store_id UUID NOT NULL REFERENCES woocommerce_stores(id) ON DELETE CASCADE,

  wc_product_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT,
  type TEXT, -- simple, variable, etc
  status TEXT,
  sku TEXT,
  price DECIMAL(10,2),
  regular_price DECIMAL(10,2),
  sale_price DECIMAL(10,2),
  description TEXT,
  short_description TEXT,
  categories JSONB DEFAULT '[]',
  images JSONB DEFAULT '[]',

  -- Configurazione per auto-creazione
  auto_create_subscription BOOLEAN DEFAULT true,
  subscription_template JSONB, -- Template per creare subscription

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(store_id, wc_product_id)
);

CREATE INDEX IF NOT EXISTS wc_products_store_idx ON woocommerce_products(store_id);

-- ============================================
-- 5. TABELLA LOG WEBHOOKS
-- ============================================

CREATE TABLE IF NOT EXISTS woocommerce_webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  store_id UUID NOT NULL REFERENCES woocommerce_stores(id) ON DELETE CASCADE,

  -- Dati webhook
  topic TEXT NOT NULL, -- order.created, order.updated, customer.created, etc
  resource TEXT,       -- order, customer, product
  resource_id INTEGER,

  -- Payload
  payload JSONB NOT NULL,
  headers JSONB,

  -- Risultato
  status TEXT DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  error_message TEXT,
  processing_time_ms INTEGER,

  -- Timestamps
  received_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wc_webhooks_store_idx ON woocommerce_webhook_logs(store_id);
CREATE INDEX IF NOT EXISTS wc_webhooks_topic_idx ON woocommerce_webhook_logs(topic);
CREATE INDEX IF NOT EXISTS wc_webhooks_status_idx ON woocommerce_webhook_logs(status);
CREATE INDEX IF NOT EXISTS wc_webhooks_received_idx ON woocommerce_webhook_logs(received_at DESC);

-- ============================================
-- 6. VISTE
-- ============================================

-- Vista ordini con info CRM
CREATE OR REPLACE VIEW woocommerce_orders_view AS
SELECT
  o.id,
  o.store_id,
  s.name as store_name,
  s.slug as store_slug,
  o.wc_order_id,
  o.wc_order_number,
  o.status,
  o.total,
  o.currency,
  o.sync_status,
  o.sync_error,
  o.billing_email,
  o.billing_first_name,
  o.billing_last_name,
  o.billing_company,
  o.product_names,
  o.date_created,
  o.date_paid,
  o.customer_id,
  c.company_name as crm_company_name,
  c.contact_name as crm_contact_name,
  o.subscription_id,
  sub.name as subscription_name,
  o.created_at
FROM woocommerce_orders o
JOIN woocommerce_stores s ON s.id = o.store_id
LEFT JOIN customers c ON c.id = o.customer_id
LEFT JOIN subscriptions sub ON sub.id = o.subscription_id
ORDER BY o.date_created DESC;

-- Vista statistiche per store
CREATE OR REPLACE VIEW woocommerce_store_stats AS
SELECT
  s.id,
  s.name,
  s.slug,
  s.url,
  s.is_active,
  s.last_sync_at,
  s.last_webhook_at,
  COUNT(o.id) as total_orders,
  COUNT(o.id) FILTER (WHERE o.sync_status = 'synced') as synced_orders,
  COUNT(o.id) FILTER (WHERE o.sync_status = 'pending') as pending_orders,
  COUNT(o.id) FILTER (WHERE o.sync_status = 'error') as error_orders,
  COALESCE(SUM(o.total) FILTER (WHERE o.status IN ('completed', 'processing')), 0) as total_revenue,
  COUNT(DISTINCT o.customer_id) as unique_customers,
  MAX(o.date_created) as last_order_date
FROM woocommerce_stores s
LEFT JOIN woocommerce_orders o ON o.store_id = s.id
GROUP BY s.id, s.name, s.slug, s.url, s.is_active, s.last_sync_at, s.last_webhook_at;

-- Vista ordini da processare
CREATE OR REPLACE VIEW woocommerce_orders_pending AS
SELECT
  o.*,
  s.name as store_name,
  s.auto_create_customer,
  s.auto_create_subscription,
  s.auto_create_project,
  s.default_subscription_category,
  s.default_project_type,
  s.default_tags
FROM woocommerce_orders o
JOIN woocommerce_stores s ON s.id = o.store_id
WHERE o.sync_status = 'pending'
  AND s.is_active = true
ORDER BY o.date_created ASC;

-- ============================================
-- 7. FUNZIONI
-- ============================================

-- Funzione per trovare o creare cliente da ordine WooCommerce
CREATE OR REPLACE FUNCTION find_or_create_customer_from_wc_order(
  p_order_id UUID
)
RETURNS UUID AS $$
DECLARE
  v_order woocommerce_orders%ROWTYPE;
  v_customer_id UUID;
  v_store woocommerce_stores%ROWTYPE;
BEGIN
  -- Carica ordine
  SELECT * INTO v_order FROM woocommerce_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ordine WooCommerce non trovato';
  END IF;

  -- Se già associato, ritorna il customer_id
  IF v_order.customer_id IS NOT NULL THEN
    RETURN v_order.customer_id;
  END IF;

  -- Carica store config
  SELECT * INTO v_store FROM woocommerce_stores WHERE id = v_order.store_id;

  -- Cerca cliente per email
  SELECT id INTO v_customer_id
  FROM customers
  WHERE LOWER(email) = LOWER(v_order.billing_email)
  LIMIT 1;

  -- Se trovato, aggiorna ordine e ritorna
  IF v_customer_id IS NOT NULL THEN
    UPDATE woocommerce_orders SET customer_id = v_customer_id WHERE id = p_order_id;
    RETURN v_customer_id;
  END IF;

  -- Se auto_create_customer è attivo, crea nuovo cliente
  IF v_store.auto_create_customer THEN
    INSERT INTO customers (
      company_name,
      contact_name,
      email,
      phone,
      billing_address,
      status,
      tags,
      metadata
    ) VALUES (
      NULLIF(v_order.billing_company, ''),
      CONCAT(v_order.billing_first_name, ' ', v_order.billing_last_name),
      v_order.billing_email,
      v_order.billing_phone,
      v_order.billing_address,
      'active',
      v_store.default_tags,
      jsonb_build_object(
        'source', 'woocommerce',
        'store', v_store.slug,
        'first_order_id', v_order.wc_order_id
      )
    )
    RETURNING id INTO v_customer_id;

    -- Aggiorna ordine
    UPDATE woocommerce_orders SET customer_id = v_customer_id WHERE id = p_order_id;

    RETURN v_customer_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Funzione per creare subscription da ordine WooCommerce
CREATE OR REPLACE FUNCTION create_subscription_from_wc_order(
  p_order_id UUID
)
RETURNS UUID AS $$
DECLARE
  v_order woocommerce_orders%ROWTYPE;
  v_store woocommerce_stores%ROWTYPE;
  v_subscription_id UUID;
  v_product_name TEXT;
BEGIN
  -- Carica ordine
  SELECT * INTO v_order FROM woocommerce_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ordine WooCommerce non trovato';
  END IF;

  -- Verifica che ci sia un customer associato
  IF v_order.customer_id IS NULL THEN
    RAISE EXCEPTION 'Ordine senza cliente associato';
  END IF;

  -- Se già associato a subscription, ritorna
  IF v_order.subscription_id IS NOT NULL THEN
    RETURN v_order.subscription_id;
  END IF;

  -- Carica store config
  SELECT * INTO v_store FROM woocommerce_stores WHERE id = v_order.store_id;

  -- Nome prodotto per la subscription
  v_product_name := COALESCE(
    v_order.product_names[1],
    'Ordine WooCommerce #' || v_order.wc_order_number
  );

  -- Crea subscription one-time
  INSERT INTO subscriptions (
    customer_id,
    name,
    description,
    amount,
    currency,
    billing_interval,
    status,
    current_period_start,
    current_period_end,
    next_billing_date,
    auto_renew,
    category,
    metadata
  ) VALUES (
    v_order.customer_id,
    v_product_name,
    'Ordine WooCommerce #' || v_order.wc_order_number,
    v_order.total,
    v_order.currency,
    'one_time',
    CASE
      WHEN v_order.date_paid IS NOT NULL THEN 'active'
      ELSE 'pending'
    END,
    COALESCE(v_order.date_paid, v_order.date_created),
    COALESCE(v_order.date_paid, v_order.date_created) + INTERVAL '1 year',
    NULL,
    false,
    v_store.default_subscription_category,
    jsonb_build_object(
      'source', 'woocommerce',
      'store', v_store.slug,
      'wc_order_id', v_order.wc_order_id,
      'wc_order_number', v_order.wc_order_number
    )
  )
  RETURNING id INTO v_subscription_id;

  -- Aggiorna ordine
  UPDATE woocommerce_orders SET subscription_id = v_subscription_id WHERE id = p_order_id;

  RETURN v_subscription_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 8. TRIGGERS
-- ============================================

DROP TRIGGER IF EXISTS wc_stores_updated ON woocommerce_stores;
CREATE TRIGGER wc_stores_updated
  BEFORE UPDATE ON woocommerce_stores
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS wc_orders_updated ON woocommerce_orders;
CREATE TRIGGER wc_orders_updated
  BEFORE UPDATE ON woocommerce_orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS wc_customers_updated ON woocommerce_customers;
CREATE TRIGGER wc_customers_updated
  BEFORE UPDATE ON woocommerce_customers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 9. RLS POLICIES
-- ============================================

ALTER TABLE woocommerce_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE woocommerce_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE woocommerce_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE woocommerce_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE woocommerce_webhook_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access wc_stores" ON woocommerce_stores
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access wc_orders" ON woocommerce_orders
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access wc_customers" ON woocommerce_customers
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access wc_products" ON woocommerce_products
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

CREATE POLICY "Admin full access wc_webhook_logs" ON woocommerce_webhook_logs
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

-- ============================================
-- 10. DATI INIZIALI - STORE WOO COMMERCE
-- ============================================

-- Inserisce uno store di esempio (le credenziali verranno configurate dall'admin)
INSERT INTO woocommerce_stores (
  name,
  slug,
  url,
  consumer_key,
  consumer_secret,
  is_active,
  auto_sync,
  auto_create_customer,
  auto_create_subscription,
  auto_create_project,
  default_subscription_category,
  default_project_type,
  default_tags
) VALUES (
  'Primary Shop',
  'SHOP',
  'https://shop.example.com',
  'CONFIGURE_ME',
  'CONFIGURE_ME',
  false, -- Disattivato finché non configurato
  true,
  true,
  true,
  true,
  'ecommerce',
  'ecommerce',
  '["woocommerce", "ecommerce"]'
) ON CONFLICT (slug) DO NOTHING;
