-- Rollback di 170_tax_rate_forfettario_default.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/migrations/down/170_tax_rate_forfettario_default.down.sql
-- Ripristina i default a 22, il trigger dei preventivi v1 e l'aliquota 22
-- sulle sole bozze corrette dalla migrazione.

ALTER TABLE invoices ALTER COLUMN tax_rate SET DEFAULT 22.00;
ALTER TABLE quotes ALTER COLUMN tax_rate SET DEFAULT 22.00;
ALTER TABLE quotes_v2 ALTER COLUMN tax_rate SET DEFAULT 22;

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

UPDATE invoices SET tax_rate = 22
WHERE id IN (SELECT invoice_id FROM migration_170_tax_rate_fixed)
  AND tax_rate = 0;

DROP TABLE IF EXISTS migration_170_tax_rate_fixed;

DELETE FROM schema_migrations WHERE version = '170_tax_rate_forfettario_default.sql';
