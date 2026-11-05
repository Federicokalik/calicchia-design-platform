-- 169_customer_fiscal_columns.sql — P.IVA, codice fiscale, codice SDI e PEC come
-- colonne vere di customers (prima solo chiavi di billing_address).
--
-- Perché: servono a proforma, fatture e XML SDI; nel jsonb non avevano
-- validazione né indice e un merge sbagliato le cancellava (bug 3 della
-- Fase 1). Il gestionale le scrive solo nelle colonne; l'API continua ad
-- accettare billing_address.vat_number & co. mappandoli sulle colonne e le
-- risposte le espongono anche dentro billing_address per compatibilità.
--
-- Backfill: i valori di billing_address normalizzati (maiuscolo senza spazi;
-- "IT" + 11 cifre → 11 cifre; PEC minuscolo; pec o pec_email; sdi_code o
-- codice_destinatario) passano nelle colonne SOLO se rispettano il formato,
-- e solo allora la chiave esce da billing_address. I valori non validi
-- restano nel jsonb, dove i lettori li trovano ancora come fallback
-- (COALESCE): vanno corretti dalla scheda cliente. Il conteggio è nel NOTICE.
-- I CHECK del DB verificano il formato; P.IVA italiana e codice fiscale con
-- carattere di controllo sono verificati dall'API (lib/customers/fiscal.ts).
--
-- Durante il backfill sono sospesi i trigger webhook_customers (eviterebbe
-- un evento customers.update verso i webhook esterni per ogni cliente) e
-- customers_updated (updated_at non cambia per una migrazione di schema).
--
-- Reversibile: database/migrations/down/169_customer_fiscal_columns.down.sql

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS vat_number  text,
  ADD COLUMN IF NOT EXISTS fiscal_code text,
  ADD COLUMN IF NOT EXISTS sdi_code    text,
  ADD COLUMN IF NOT EXISTS pec         text;

ALTER TABLE customers DISABLE TRIGGER webhook_customers;
ALTER TABLE customers DISABLE TRIGGER customers_updated;

WITH norm AS (
  SELECT
    id,
    NULLIF(upper(regexp_replace(COALESCE(billing_address->>'vat_number', ''), '[[:space:]./-]', '', 'g')), '') AS vat_raw,
    NULLIF(upper(regexp_replace(COALESCE(billing_address->>'fiscal_code', ''), '[[:space:]]', '', 'g')), '') AS cf,
    NULLIF(upper(regexp_replace(COALESCE(billing_address->>'sdi_code', billing_address->>'codice_destinatario', ''), '[[:space:]]', '', 'g')), '') AS sdi,
    NULLIF(lower(btrim(COALESCE(billing_address->>'pec', billing_address->>'pec_email', ''))), '') AS pec
  FROM customers
  WHERE jsonb_typeof(billing_address) = 'object'
    AND billing_address ?| ARRAY['vat_number', 'fiscal_code', 'sdi_code', 'codice_destinatario', 'pec', 'pec_email']
), cleaned AS (
  SELECT
    id,
    CASE WHEN vat_raw ~ '^IT[0-9]{11}$' THEN substr(vat_raw, 3) ELSE vat_raw END AS vat,
    cf, sdi, pec
  FROM norm
), checked AS (
  SELECT
    id,
    CASE WHEN vat ~ '^([0-9]{11}|[A-Z]{2}[0-9A-Z]{2,28})$' THEN vat END AS vat,
    CASE WHEN cf ~ '^([A-Z0-9]{16}|[0-9]{11})$' THEN cf END AS cf,
    CASE WHEN sdi ~ '^[A-Z0-9]{6,7}$' THEN sdi END AS sdi,
    CASE WHEN pec ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN pec END AS pec
  FROM cleaned
)
UPDATE customers c SET
  vat_number  = x.vat,
  fiscal_code = x.cf,
  sdi_code    = x.sdi,
  pec         = x.pec,
  billing_address = c.billing_address - array_remove(ARRAY[
    CASE WHEN x.vat IS NOT NULL THEN 'vat_number' END,
    CASE WHEN x.cf  IS NOT NULL THEN 'fiscal_code' END,
    CASE WHEN x.sdi IS NOT NULL THEN 'sdi_code' END,
    CASE WHEN x.sdi IS NOT NULL THEN 'codice_destinatario' END,
    CASE WHEN x.pec IS NOT NULL THEN 'pec' END,
    CASE WHEN x.pec IS NOT NULL THEN 'pec_email' END
  ], NULL)
FROM checked x
WHERE x.id = c.id;

ALTER TABLE customers ENABLE TRIGGER customers_updated;
ALTER TABLE customers ENABLE TRIGGER webhook_customers;

DO $$
DECLARE leftover integer;
BEGIN
  SELECT count(*) INTO leftover FROM customers
  WHERE jsonb_typeof(billing_address) = 'object'
    AND billing_address ?| ARRAY['vat_number', 'fiscal_code', 'sdi_code', 'codice_destinatario', 'pec', 'pec_email'];
  IF leftover > 0 THEN
    RAISE NOTICE '169: % clienti hanno dati fiscali non validi rimasti in billing_address: correggerli dalla scheda cliente', leftover;
  END IF;
END $$;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_vat_number_format;
ALTER TABLE customers ADD CONSTRAINT customers_vat_number_format
  CHECK (vat_number IS NULL OR vat_number ~ '^([0-9]{11}|[A-Z]{2}[0-9A-Z]{2,28})$');
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_fiscal_code_format;
ALTER TABLE customers ADD CONSTRAINT customers_fiscal_code_format
  CHECK (fiscal_code IS NULL OR fiscal_code ~ '^([A-Z0-9]{16}|[0-9]{11})$');
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_sdi_code_format;
ALTER TABLE customers ADD CONSTRAINT customers_sdi_code_format
  CHECK (sdi_code IS NULL OR sdi_code ~ '^[A-Z0-9]{6,7}$');
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_pec_format;
ALTER TABLE customers ADD CONSTRAINT customers_pec_format
  CHECK (pec IS NULL OR (pec = lower(pec) AND pec ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));

CREATE INDEX IF NOT EXISTS customers_vat_number_idx ON customers (vat_number) WHERE vat_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_fiscal_code_idx ON customers (fiscal_code) WHERE fiscal_code IS NOT NULL;

COMMENT ON COLUMN customers.vat_number IS 'Partita IVA, maiuscolo senza spazi: IT = 11 cifre senza prefisso; estero = prefisso paese + codice (es. DE123456789).';
COMMENT ON COLUMN customers.fiscal_code IS 'Codice fiscale (16 caratteri per le persone, 11 cifre per le persone giuridiche).';
COMMENT ON COLUMN customers.sdi_code IS 'Codice destinatario SDI (7 caratteri B2B, 6 per la PA).';
COMMENT ON COLUMN customers.pec IS 'PEC per la fatturazione elettronica (minuscolo).';

-- Vista della 010: colonne con fallback sul jsonb per i valori non migrati.
-- DROP + CREATE: i.* oggi ha più colonne di quando la 010 creò la vista.
DROP VIEW IF EXISTS invoices_extended;
CREATE VIEW invoices_extended AS
SELECT
  i.*,
  c.contact_name AS customer_name,
  c.company_name AS customer_company,
  c.email AS customer_email,
  COALESCE(c.vat_number, c.billing_address->>'vat_number') AS customer_vat,
  COALESCE(c.fiscal_code, c.billing_address->>'fiscal_code') AS customer_fiscal_code,
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

-- Anonimizzazione GDPR per retention: azzera anche le colonne fiscali.
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
    vat_number              = NULL,
    fiscal_code             = NULL,
    sdi_code                = NULL,
    pec                     = NULL,
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
