-- Migration: 030_payments_hub.sql
-- Descrizione: Payments hub — tabelle piano incasso, link pagamento, provider, webhook
-- Data: 2026-03-08

-- =====================================================
-- ESTENSIONI TABELLA INVOICES
-- =====================================================

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS balance_due NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accepted_payment_methods JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bank_details_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_instructions TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_payment_status_fos'
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT chk_invoices_payment_status_fos
      CHECK (payment_status IS NULL OR payment_status IN (
        'unpaid', 'partial', 'paid', 'failed', 'refunded'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_accepted_payment_methods_array'
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT chk_invoices_accepted_payment_methods_array
      CHECK (jsonb_typeof(accepted_payment_methods) = 'array');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_bank_details_snapshot_object'
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT chk_invoices_bank_details_snapshot_object
      CHECK (jsonb_typeof(bank_details_snapshot) = 'object');
  END IF;
END $$;

-- =====================================================
-- TABELLA: payment_schedules
-- =====================================================

CREATE TABLE IF NOT EXISTS payment_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  project_id UUID REFERENCES client_projects(id) ON DELETE SET NULL,
  schedule_type TEXT NOT NULL DEFAULT 'installment'
    CHECK (schedule_type IN ('deposit', 'milestone', 'balance', 'installment')),
  title TEXT NOT NULL DEFAULT '',
  amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR',
  due_date DATE,
  due_days_from_acceptance INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'due', 'paid', 'partial', 'overdue', 'cancelled')),
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  paid_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0,
  trigger_rule JSONB NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_schedules_quote_id ON payment_schedules(quote_id);
CREATE INDEX IF NOT EXISTS idx_payment_schedules_invoice_id ON payment_schedules(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_schedules_project_id ON payment_schedules(project_id);
CREATE INDEX IF NOT EXISTS idx_payment_schedules_status ON payment_schedules(status);
CREATE INDEX IF NOT EXISTS idx_payment_schedules_due_date ON payment_schedules(due_date);

-- =====================================================
-- TABELLA: payment_links
-- =====================================================

CREATE TABLE IF NOT EXISTS payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  payment_schedule_id UUID REFERENCES payment_schedules(id) ON DELETE SET NULL,
  provider TEXT NOT NULL
    CHECK (provider IN ('bank_transfer', 'paypal', 'revolut', 'stripe')),
  provider_order_id TEXT,
  checkout_url TEXT,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'paid', 'expired', 'cancelled')),
  expires_at TIMESTAMPTZ,
  payload_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_links_schedule_id ON payment_links(payment_schedule_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_quote_id ON payment_links(quote_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_invoice_id ON payment_links(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_status ON payment_links(status);

-- =====================================================
-- TABELLA: payment_provider_accounts
-- =====================================================

CREATE TABLE IF NOT EXISTS payment_provider_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL
    CHECK (provider IN ('bank_transfer', 'paypal', 'revolut', 'stripe')),
  label TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  credentials_ref TEXT,
  settings_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_provider_accounts_provider ON payment_provider_accounts(provider);

-- =====================================================
-- TABELLA: payment_webhook_events
-- =====================================================

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  external_id TEXT,
  signature_valid BOOLEAN,
  payload_json JSONB NOT NULL DEFAULT '{}',
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_provider
  ON payment_webhook_events(provider, event_type);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_status
  ON payment_webhook_events(status) WHERE status IN ('received', 'failed');
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_external_id
  ON payment_webhook_events(external_id) WHERE external_id IS NOT NULL;
