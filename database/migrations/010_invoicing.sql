-- Migration: 010_invoicing.sql
-- Descrizione: Sistema Fatturazione Avanzata con Preventivi
-- Data: 2026-01-20

-- =====================================================
-- TABELLA INVOICE_NUMBERING
-- Numerazione progressiva documenti
-- =====================================================

CREATE TABLE IF NOT EXISTS invoice_numbering (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('invoice', 'quote')),
  year INTEGER NOT NULL,
  last_number INTEGER DEFAULT 0,
  prefix TEXT DEFAULT '',
  UNIQUE(type, year)
);

-- Inserisci record per anno corrente
INSERT INTO invoice_numbering (type, year, prefix)
VALUES
  ('invoice', EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER, 'FT-'),
  ('quote', EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER, 'PV-')
ON CONFLICT (type, year) DO NOTHING;

-- =====================================================
-- FUNZIONE GENERAZIONE NUMERO DOCUMENTO
-- =====================================================

CREATE OR REPLACE FUNCTION generate_document_number(p_type TEXT)
RETURNS TEXT AS $$
DECLARE
  v_year INTEGER := EXTRACT(YEAR FROM CURRENT_DATE);
  v_number INTEGER;
  v_prefix TEXT;
BEGIN
  -- Inserisci riga se non esiste
  INSERT INTO invoice_numbering (type, year, prefix)
  VALUES (p_type, v_year, CASE WHEN p_type = 'invoice' THEN 'FT-' ELSE 'PV-' END)
  ON CONFLICT (type, year) DO NOTHING;

  -- Incrementa e recupera
  UPDATE invoice_numbering
  SET last_number = last_number + 1
  WHERE type = p_type AND year = v_year
  RETURNING last_number, prefix INTO v_number, v_prefix;

  RETURN v_prefix || v_year || '-' || LPAD(v_number::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- TABELLA QUOTES (Preventivi)
-- =====================================================

CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  project_id UUID REFERENCES client_projects(id) ON DELETE SET NULL,

  -- Numerazione
  quote_number TEXT UNIQUE,

  -- Status
  status TEXT DEFAULT 'draft' CHECK (status IN (
    'draft',      -- Bozza, non inviato
    'sent',       -- Inviato al cliente
    'viewed',     -- Cliente ha visualizzato
    'accepted',   -- Accettato
    'rejected',   -- Rifiutato
    'expired',    -- Scaduto
    'converted'   -- Convertito in fattura
  )),

  -- Date
  issue_date DATE DEFAULT CURRENT_DATE,
  valid_until DATE,
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,

  -- Importi
  subtotal DECIMAL(10,2) DEFAULT 0,
  discount_percentage DECIMAL(5,2) DEFAULT 0,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  tax_rate DECIMAL(5,2) DEFAULT 22.00,
  tax_amount DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(10,2) DEFAULT 0,
  currency TEXT DEFAULT 'EUR',

  -- Voci
  line_items JSONB DEFAULT '[]',
  -- Formato: [{description, quantity, unit_price, tax_rate, amount}]

  -- Contenuti
  title TEXT,
  introduction TEXT,
  notes TEXT,
  terms TEXT,
  payment_terms TEXT,

  -- Token pubblico per visualizzazione
  public_token TEXT UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),

  -- Conversione
  converted_invoice_id UUID, -- FK aggiunta dopo creazione tabella invoices

  -- Metadata
  created_by UUID REFERENCES profiles(id),
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici
CREATE INDEX idx_quotes_customer ON quotes(customer_id);
CREATE INDEX idx_quotes_status ON quotes(status);
CREATE INDEX idx_quotes_number ON quotes(quote_number);
CREATE INDEX idx_quotes_public_token ON quotes(public_token);

-- =====================================================
-- MODIFICA TABELLA INVOICES ESISTENTE
-- Aggiungi campi per fatture manuali
-- =====================================================

-- Source: stripe, manual, quote
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'stripe';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quote_id UUID REFERENCES quotes(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES client_projects(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS public_token TEXT UNIQUE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_items JSONB DEFAULT '[]';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal DECIMAL(10,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_percentage DECIMAL(5,2) DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10,2) DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5,2) DEFAULT 22.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(10,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_terms TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issue_date DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date_manual DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_date DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id);

-- Genera token per fatture esistenti senza token
UPDATE invoices
SET public_token = encode(gen_random_bytes(32), 'hex')
WHERE public_token IS NULL;

-- Aggiungi FK per conversione preventivo
ALTER TABLE quotes
ADD CONSTRAINT fk_quotes_converted_invoice
FOREIGN KEY (converted_invoice_id) REFERENCES invoices(id);

-- =====================================================
-- TABELLA INVOICE_SETTINGS
-- Impostazioni fatturazione
-- =====================================================

CREATE TABLE IF NOT EXISTS invoice_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Dati aziendali
  company_name TEXT,
  company_address TEXT,
  company_city TEXT,
  company_postal_code TEXT,
  company_country TEXT DEFAULT 'Italia',
  vat_number TEXT,
  fiscal_code TEXT,
  rea_number TEXT,
  share_capital TEXT,

  -- Contatti
  company_email TEXT,
  company_phone TEXT,
  company_website TEXT,

  -- Banca
  bank_name TEXT,
  bank_iban TEXT,
  bank_bic TEXT,

  -- Default
  default_payment_terms TEXT DEFAULT 'Pagamento a 30 giorni dalla data fattura',
  default_notes TEXT,
  default_tax_rate DECIMAL(5,2) DEFAULT 22.00,
  default_currency TEXT DEFAULT 'EUR',

  -- Numerazione
  invoice_prefix TEXT DEFAULT 'FT-',
  quote_prefix TEXT DEFAULT 'PV-',

  -- Template
  logo_url TEXT,
  primary_color TEXT DEFAULT '#2563eb',
  footer_text TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Inserisci record default
INSERT INTO invoice_settings (id)
VALUES (gen_random_uuid())
ON CONFLICT DO NOTHING;

-- =====================================================
-- TABELLA PAYMENT_RECORDS
-- Registrazione pagamenti manuali
-- =====================================================

CREATE TABLE IF NOT EXISTS payment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,

  amount DECIMAL(10,2) NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method TEXT, -- bank_transfer, cash, check, paypal, stripe, other
  reference TEXT, -- Numero bonifico, etc.
  notes TEXT,

  recorded_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payment_records_invoice ON payment_records(invoice_id);

-- =====================================================
-- FUNZIONI
-- =====================================================

-- Converti preventivo in fattura
CREATE OR REPLACE FUNCTION convert_quote_to_invoice(p_quote_id UUID)
RETURNS UUID AS $$
DECLARE
  v_quote quotes%ROWTYPE;
  v_invoice_id UUID;
  v_invoice_number TEXT;
BEGIN
  -- Recupera preventivo
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Preventivo non trovato';
  END IF;

  IF v_quote.status NOT IN ('accepted') THEN
    RAISE EXCEPTION 'Il preventivo deve essere accettato per essere convertito';
  END IF;

  IF v_quote.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Preventivo già convertito';
  END IF;

  -- Genera numero fattura
  v_invoice_number := generate_document_number('invoice');

  -- Crea fattura
  INSERT INTO invoices (
    customer_id,
    project_id,
    source,
    quote_id,
    invoice_number,
    status,
    issue_date,
    line_items,
    subtotal,
    discount_percentage,
    discount_amount,
    tax_rate,
    tax_amount,
    amount_due,
    amount_paid,
    currency,
    notes,
    payment_terms,
    public_token
  )
  VALUES (
    v_quote.customer_id,
    v_quote.project_id,
    'quote',
    v_quote.id,
    v_invoice_number,
    'open',
    CURRENT_DATE,
    v_quote.line_items,
    v_quote.subtotal,
    v_quote.discount_percentage,
    v_quote.discount_amount,
    v_quote.tax_rate,
    v_quote.tax_amount,
    v_quote.total,
    0,
    v_quote.currency,
    v_quote.notes,
    v_quote.payment_terms,
    encode(gen_random_bytes(32), 'hex')
  )
  RETURNING id INTO v_invoice_id;

  -- Aggiorna preventivo
  UPDATE quotes
  SET status = 'converted',
      converted_invoice_id = v_invoice_id,
      updated_at = NOW()
  WHERE id = p_quote_id;

  RETURN v_invoice_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Calcola totali preventivo
CREATE OR REPLACE FUNCTION calculate_quote_totals()
RETURNS TRIGGER AS $$
DECLARE
  v_subtotal DECIMAL(10,2);
  v_discount DECIMAL(10,2);
  v_taxable DECIMAL(10,2);
  v_tax DECIMAL(10,2);
BEGIN
  -- Calcola subtotale dalle line_items
  SELECT COALESCE(SUM((item->>'amount')::DECIMAL), 0)
  INTO v_subtotal
  FROM jsonb_array_elements(NEW.line_items) AS item;

  NEW.subtotal := v_subtotal;

  -- Calcola sconto
  IF NEW.discount_percentage > 0 THEN
    NEW.discount_amount := ROUND(v_subtotal * NEW.discount_percentage / 100, 2);
  END IF;

  v_discount := COALESCE(NEW.discount_amount, 0);
  v_taxable := v_subtotal - v_discount;

  -- Calcola IVA
  NEW.tax_amount := ROUND(v_taxable * COALESCE(NEW.tax_rate, 22) / 100, 2);

  -- Totale
  NEW.total := v_taxable + NEW.tax_amount;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quote_calc_totals ON quotes;
CREATE TRIGGER quote_calc_totals
  BEFORE INSERT OR UPDATE OF line_items, discount_percentage, discount_amount, tax_rate ON quotes
  FOR EACH ROW
  EXECUTE FUNCTION calculate_quote_totals();

-- Auto-genera numero preventivo
CREATE OR REPLACE FUNCTION auto_quote_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.quote_number IS NULL THEN
    NEW.quote_number := generate_document_number('quote');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quote_auto_number ON quotes;
CREATE TRIGGER quote_auto_number
  BEFORE INSERT ON quotes
  FOR EACH ROW
  EXECUTE FUNCTION auto_quote_number();

-- Aggiorna status quote quando scade
CREATE OR REPLACE FUNCTION check_quote_expiration()
RETURNS void AS $$
BEGIN
  UPDATE quotes
  SET status = 'expired',
      updated_at = NOW()
  WHERE status IN ('draft', 'sent', 'viewed')
    AND valid_until < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

-- Updated_at triggers
DROP TRIGGER IF EXISTS update_quotes_updated_at ON quotes;
CREATE TRIGGER update_quotes_updated_at
  BEFORE UPDATE ON quotes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_invoice_settings_updated_at ON invoice_settings;
CREATE TRIGGER update_invoice_settings_updated_at
  BEFORE UPDATE ON invoice_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- RLS POLICIES
-- =====================================================

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_numbering ENABLE ROW LEVEL SECURITY;

-- QUOTES
DROP POLICY IF EXISTS "Admin full access quotes" ON quotes;
CREATE POLICY "Admin full access quotes" ON quotes
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Clients view own quotes" ON quotes;
CREATE POLICY "Clients view own quotes" ON quotes
  FOR SELECT TO authenticated
  USING (customer_id = ANY(get_user_customer_ids()));

-- Accesso pubblico per token
DROP POLICY IF EXISTS "Public access by token quotes" ON quotes;
CREATE POLICY "Public access by token quotes" ON quotes
  FOR SELECT TO anon
  USING (public_token IS NOT NULL);

-- INVOICE_SETTINGS (solo admin)
DROP POLICY IF EXISTS "Admin full access settings" ON invoice_settings;
CREATE POLICY "Admin full access settings" ON invoice_settings
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- PAYMENT_RECORDS (solo admin)
DROP POLICY IF EXISTS "Admin full access payments" ON payment_records;
CREATE POLICY "Admin full access payments" ON payment_records
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- INVOICE_NUMBERING (solo admin)
DROP POLICY IF EXISTS "Admin full access numbering" ON invoice_numbering;
CREATE POLICY "Admin full access numbering" ON invoice_numbering
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- =====================================================
-- VISTE
-- =====================================================

-- Vista preventivi con dettagli
CREATE OR REPLACE VIEW quotes_view AS
SELECT
  q.*,
  c.contact_name AS customer_name,
  c.company_name AS customer_company,
  c.email AS customer_email,
  cp.name AS project_name,
  p.email AS created_by_email
FROM quotes q
LEFT JOIN customers c ON c.id = q.customer_id
LEFT JOIN client_projects cp ON cp.id = q.project_id
LEFT JOIN profiles p ON p.id = q.created_by;

-- Vista fatture estesa
CREATE OR REPLACE VIEW invoices_extended AS
SELECT
  i.*,
  c.contact_name AS customer_name,
  c.company_name AS customer_company,
  c.email AS customer_email,
  c.billing_address->>'vat_number' AS customer_vat,
  c.billing_address->>'fiscal_code' AS customer_fiscal_code,
  c.billing_address->>'street' AS customer_address,
  c.billing_address->>'city' AS customer_city,
  c.billing_address->>'postal_code' AS customer_postal_code,
  c.billing_address->>'country' AS customer_country,
  q.quote_number,
  cp.name AS project_name,
  COALESCE(
    (SELECT SUM(amount) FROM payment_records WHERE invoice_id = i.id),
    0
  ) AS total_paid_manual
FROM invoices i
LEFT JOIN customers c ON c.id = i.customer_id
LEFT JOIN quotes q ON q.id = i.quote_id
LEFT JOIN client_projects cp ON cp.id = i.project_id;

-- Vista preventivi per portal
CREATE OR REPLACE VIEW portal_quotes AS
SELECT
  q.id,
  q.quote_number,
  q.title,
  q.status,
  q.issue_date,
  q.valid_until,
  q.total,
  q.currency,
  q.customer_id
FROM quotes q
WHERE q.customer_id = ANY(get_user_customer_ids())
ORDER BY q.created_at DESC;

-- Vista report fatturato mensile
CREATE OR REPLACE VIEW monthly_invoices_report AS
SELECT
  DATE_TRUNC('month', COALESCE(i.issue_date, i.created_at::DATE)) AS month,
  COUNT(*) AS invoice_count,
  SUM(i.amount_due) AS total_invoiced,
  SUM(i.amount_paid) AS total_paid,
  SUM(i.amount_due - i.amount_paid) AS total_outstanding,
  COUNT(*) FILTER (WHERE i.status = 'paid') AS paid_count,
  COUNT(*) FILTER (WHERE i.status = 'open') AS open_count
FROM invoices i
WHERE i.source IN ('manual', 'quote')
GROUP BY DATE_TRUNC('month', COALESCE(i.issue_date, i.created_at::DATE))
ORDER BY month DESC;

-- =====================================================
-- GRANTS
-- =====================================================

GRANT SELECT ON quotes_view TO authenticated;
GRANT SELECT ON invoices_extended TO authenticated;
GRANT SELECT ON portal_quotes TO authenticated;
GRANT SELECT ON monthly_invoices_report TO authenticated;
