-- Rollback di 169_customer_fiscal_columns.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/migrations/down/169_customer_fiscal_columns.down.sql
-- Riporta i valori delle colonne dentro billing_address (vat_number,
-- fiscal_code, sdi_code, pec e pec_email, letto dal codice SDI precedente),
-- ripristina vista e funzione di retention della 167 e rimuove le colonne.
-- Prima del rollback va ripristinato il codice precedente.

ALTER TABLE customers DISABLE TRIGGER webhook_customers;
ALTER TABLE customers DISABLE TRIGGER customers_updated;

UPDATE customers SET billing_address = COALESCE(billing_address, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
  'vat_number', vat_number,
  'fiscal_code', fiscal_code,
  'sdi_code', sdi_code,
  'pec', pec,
  'pec_email', pec
))
WHERE vat_number IS NOT NULL OR fiscal_code IS NOT NULL OR sdi_code IS NOT NULL OR pec IS NOT NULL;

ALTER TABLE customers ENABLE TRIGGER customers_updated;
ALTER TABLE customers ENABLE TRIGGER webhook_customers;

-- DROP + CREATE: i.* oggi ha più colonne di quando la 010 creò la vista.
DROP VIEW IF EXISTS invoices_extended;
CREATE VIEW invoices_extended AS
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

CREATE OR REPLACE FUNCTION anonymize_customers_post_retention(years_threshold INT DEFAULT 10)
RETURNS INTEGER AS $$
DECLARE
  affected INTEGER;
  cutoff   TIMESTAMPTZ := NOW() - (years_threshold || ' years')::INTERVAL;
BEGIN
  UPDATE customers c SET
    contact_name            = 'Dato cancellato (GDPR - retention ' || years_threshold || 'y)',
    company_name            = NULL,
    email                   = 'erased-' || c.id::text || '@deleted.invalid',
    phone                   = NULL,
    billing_address         = '{}'::jsonb,
    billing_emails          = '{}'::text[],
    notes                   = NULL,
    tags                    = '[]'::jsonb,
    portal_access_code_hash = NULL,
    anonymized_at           = NOW(),
    updated_at              = NOW()
  WHERE
    c.anonymized_at IS NULL
    AND c.email NOT LIKE 'erased-%@deleted.invalid'
    AND (
      -- Caso 1: nessuna fattura mai emessa, basta che il record sia vecchio.
      (
        NOT EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id)
        AND c.created_at < cutoff
      )
      OR
      -- Caso 2: ultima attivita` fiscale supera il limite di retention.
      -- Se non ci sono fatture, MAX() restituisce NULL e il confronto
      -- `< cutoff` rimane NULL (falsy), quindi il ramo 2 non scatta da solo.
      (
        SELECT MAX(COALESCE(i.paid_at, i.issue_date::timestamptz, i.created_at))
        FROM   invoices i
        WHERE  i.customer_id = c.id
      ) < cutoff
    );
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS customers_vat_number_idx;
DROP INDEX IF EXISTS customers_fiscal_code_idx;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_vat_number_format;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_fiscal_code_format;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_sdi_code_format;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_pec_format;
ALTER TABLE customers
  DROP COLUMN IF EXISTS vat_number,
  DROP COLUMN IF EXISTS fiscal_code,
  DROP COLUMN IF EXISTS sdi_code,
  DROP COLUMN IF EXISTS pec;

DELETE FROM schema_migrations WHERE version = '169_customer_fiscal_columns.sql';
