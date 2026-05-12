-- 080: Payments extension — hardening per Stripe + PayPal completo
--
-- - payment_links: refund tracking, paid_at, payer_email
-- - subscriptions: provider Stripe|PayPal, paypal_subscription_id, paypal_plan_id
-- - services: paypal_product_id, paypal_plan_id (sync con PayPal Catalog/Plans)
-- - paypal_webhook_logs: idempotency speculare a stripe_webhook_logs
-- - payment_receipts: PDF generati sul payment success
-- - stripe_webhook_logs: aggiungi UNIQUE su event_id (idempotency reale via ON CONFLICT)

-- ─────────────────────────────────────────────────────────
-- payment_links: refund tracking + paid metadata
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.payment_links
  ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0
    CHECK (refunded_amount >= 0);

ALTER TABLE public.payment_links
  ADD COLUMN IF NOT EXISTS refund_history JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.payment_links
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL;

ALTER TABLE public.payment_links
  ADD COLUMN IF NOT EXISTS payer_email TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_links_refund_history_array'
  ) THEN
    ALTER TABLE public.payment_links ADD CONSTRAINT chk_payment_links_refund_history_array
      CHECK (jsonb_typeof(refund_history) = 'array');
  END IF;
END $$;

-- Allow 'refunded' / 'partially_refunded' statuses on payment_links.
-- Existing CHECK includes ('pending','active','paid','expired','cancelled');
-- drop & recreate to add refund-related states.
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.payment_links'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%status%paid%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.payment_links DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.payment_links
  ADD CONSTRAINT chk_payment_links_status_v2 CHECK (
    status IN ('pending','active','paid','expired','cancelled','refunded','partially_refunded')
  );

CREATE INDEX IF NOT EXISTS idx_payment_links_paid_at
  ON public.payment_links(paid_at DESC) WHERE paid_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────
-- subscriptions: provider + PayPal IDs
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'stripe'
    CHECK (provider IN ('stripe','paypal'));

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS paypal_subscription_id TEXT NULL;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS paypal_plan_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_subscriptions_paypal_subscription_id'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT uq_subscriptions_paypal_subscription_id UNIQUE (paypal_subscription_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_subscriptions_provider
  ON public.subscriptions(provider, status);

-- ─────────────────────────────────────────────────────────
-- services: PayPal Catalog/Plans IDs
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS paypal_product_id TEXT NULL;

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS paypal_plan_id TEXT NULL;

-- ─────────────────────────────────────────────────────────
-- stripe_webhook_logs: harden idempotency con UNIQUE su event_id
-- (table esistente in 005 senza UNIQUE — bug latente)
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_stripe_webhook_logs_event_id'
  ) THEN
    -- Dedupe before adding UNIQUE
    DELETE FROM public.stripe_webhook_logs a
    USING public.stripe_webhook_logs b
    WHERE a.id > b.id AND a.event_id = b.event_id;

    ALTER TABLE public.stripe_webhook_logs
      ADD CONSTRAINT uq_stripe_webhook_logs_event_id UNIQUE (event_id);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────
-- paypal_webhook_logs — speculare a stripe_webhook_logs
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.paypal_webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  signature_valid BOOLEAN NULL,
  processed BOOLEAN NOT NULL DEFAULT false,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paypal_webhook_logs_event_type
  ON public.paypal_webhook_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_paypal_webhook_logs_unprocessed
  ON public.paypal_webhook_logs(created_at DESC) WHERE processed = false;

-- ─────────────────────────────────────────────────────────
-- payment_receipts — PDF ricevuta generata sul payment success
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_link_id UUID NOT NULL REFERENCES public.payment_links(id) ON DELETE CASCADE,
  customer_id UUID NULL REFERENCES public.customers(id) ON DELETE SET NULL,
  invoice_id UUID NULL REFERENCES public.invoices(id) ON DELETE SET NULL,
  schedule_id UUID NULL REFERENCES public.payment_schedules(id) ON DELETE SET NULL,
  pdf_key TEXT NOT NULL,             -- filesystem key in uploads/ (es. receipts/<uuid>.pdf)
  pdf_url TEXT NOT NULL,             -- URL pubblico assoluto
  receipt_number TEXT NOT NULL,      -- es. R-2026-0001 (umano)
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal','revolut','bank_transfer')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_receipts_link
  ON public.payment_receipts(payment_link_id);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_customer
  ON public.payment_receipts(customer_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_number
  ON public.payment_receipts(receipt_number);

-- Sequence per receipt_number umano (R-YYYY-NNNN gestito in app layer leggendo il counter)
CREATE TABLE IF NOT EXISTS public.payment_receipt_counter (
  year INT PRIMARY KEY,
  last_value INT NOT NULL DEFAULT 0
);
