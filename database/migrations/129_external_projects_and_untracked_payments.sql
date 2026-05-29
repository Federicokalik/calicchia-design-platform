-- ============================================================
-- 129: External projects support + untracked income/expense methods
--
-- - Add payment_method to payment_tracker (manual income ledger)
-- - Add payment_method to expenses (manual outflow ledger)
-- - Vocabulary aligned with payment_records.payment_method (mig 010)
--   plus 'revolut' for parity with payment_links providers (mig 030).
-- - Both columns are nullable to preserve existing rows.
-- ============================================================

ALTER TABLE payment_tracker
  ADD COLUMN IF NOT EXISTS payment_method TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_tracker_payment_method'
  ) THEN
    ALTER TABLE payment_tracker
      ADD CONSTRAINT chk_payment_tracker_payment_method
      CHECK (payment_method IS NULL OR payment_method IN
        ('bank_transfer','cash','check','paypal','stripe','revolut','other'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payment_tracker_method_idx
  ON payment_tracker(payment_method)
  WHERE payment_method IS NOT NULL;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS payment_method TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_expenses_payment_method'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT chk_expenses_payment_method
      CHECK (payment_method IS NULL OR payment_method IN
        ('bank_transfer','cash','check','paypal','stripe','revolut','other'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS expenses_method_idx
  ON expenses(payment_method)
  WHERE payment_method IS NOT NULL;
