-- ============================================================
-- 087: Expenses - spese deducibili con OCR ricevute
-- ============================================================

CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_on DATE NOT NULL,
  vendor TEXT,
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  vat_amount NUMERIC(10,2) DEFAULT 0 CHECK (vat_amount >= 0),
  category TEXT NOT NULL CHECK (category IN (
    'software','hardware','office','travel','meals','training',
    'marketing','professional_services','utilities','other'
  )),
  description TEXT,
  receipt_path TEXT,
  ocr_raw_json JSONB,
  linked_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  project_id UUID REFERENCES client_projects(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  deductible_percent INTEGER NOT NULL DEFAULT 100 CHECK (deductible_percent BETWEEN 0 AND 100),
  currency TEXT DEFAULT 'EUR',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses(occurred_on DESC);
CREATE INDEX IF NOT EXISTS expenses_category_idx ON expenses(category);
CREATE INDEX IF NOT EXISTS expenses_project_idx ON expenses(project_id);
CREATE INDEX IF NOT EXISTS expenses_customer_idx ON expenses(customer_id);

DROP TRIGGER IF EXISTS update_expenses_updated_at ON expenses;
CREATE TRIGGER update_expenses_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
