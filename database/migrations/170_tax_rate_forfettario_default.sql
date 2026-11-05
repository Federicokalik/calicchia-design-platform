-- 170_tax_rate_forfettario_default.sql — l'aliquota IVA di default non è più 22%.
--
-- Il gestionale lavora in regime forfettario (nessuna IVA), ma
-- invoices.tax_rate, quotes.tax_rate e quotes_v2.tax_rate avevano DEFAULT 22
-- (010, 048) e il trigger dei preventivi v1 usava COALESCE(tax_rate, 22):
-- ogni fattura creata senza aliquota esplicita (POST /api/invoices, fattura
-- da milestone di progetto, fatture Stripe) nasceva con tax_rate 22 e
-- imposta 0, dati che si contraddicono. L'aliquota ora la decide l'API dal
-- regime (lib/tax/default-rate.ts: forfettario/none → 0, ordinario →
-- billing.defaults.default_tax_rate); il default di colonna 0 copre gli
-- INSERT che non la indicano.
--
-- Correzione dati: SOLO le fatture in bozza con tax_rate 22 e nessuna imposta
-- calcolata passano a 0. Le fatture emesse non si toccano (documenti
-- fiscali); l'XML SDI usa comunque aliquota 0 e natura N2.2. Gli id corretti
-- restano in migration_170_tax_rate_fixed per il rollback.
--
-- Reversibile: database/migrations/down/170_tax_rate_forfettario_default.down.sql

ALTER TABLE invoices ALTER COLUMN tax_rate SET DEFAULT 0;
ALTER TABLE quotes ALTER COLUMN tax_rate SET DEFAULT 0;
ALTER TABLE quotes_v2 ALTER COLUMN tax_rate SET DEFAULT 0;

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
  NEW.tax_amount := ROUND(v_taxable * COALESCE(NEW.tax_rate, 0) / 100, 2);

  -- Totale
  NEW.total := v_taxable + NEW.tax_amount;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS migration_170_tax_rate_fixed (
  invoice_id uuid PRIMARY KEY,
  fixed_at   timestamptz NOT NULL DEFAULT now()
);

WITH fixed AS (
  UPDATE invoices SET tax_rate = 0
  WHERE status = 'draft'
    AND tax_rate = 22
    AND COALESCE(tax, 0) = 0
    AND COALESCE(tax_amount, 0) = 0
  RETURNING id
)
INSERT INTO migration_170_tax_rate_fixed (invoice_id)
SELECT id FROM fixed
ON CONFLICT DO NOTHING;
