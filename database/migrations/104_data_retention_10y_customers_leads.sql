-- Migration: 104_data_retention_10y_customers_leads.sql
-- Descrizione: H5 della checklist GDPR — workflow automatico di
--              anonimizzazione di customers e leads scaduti il limite di
--              conservazione (10 anni, allineato all'obbligo fiscale di
--              conservazione di fatture e libri ex art. 2220 c.c.).
-- Data: 2026-05-24
--
-- Ratio: i clienti non sono soggetti a obbligo di conservazione decennale
-- in se` — solo le fatture, i pagamenti e i preventivi che li referenziano
-- lo sono. Una volta che l'ultima fattura ha superato i 10 anni di vita,
-- non c'e` piu` base giuridica per conservare la PII identificativa del
-- cliente (nome, email, telefono, indirizzo, note). Il record viene
-- mantenuto con i campi tecnici (id, created_at, customer_id link nelle
-- fatture) per non rompere l'integrita` referenziale, ma la PII viene
-- sovrascritta con valori sentinella, identici allo schema di
-- /api/gdpr-requests/erase/:email (gdpr-requests.ts).
--
-- Per i leads: piu` lenient — il lead di per se` non e` soggetto a obbligo
-- fiscale. Anonimizziamo dopo 10 anni dalla creazione, MA solo se il lead
-- non e` linkato a un customer non ancora anonimizzato. Cosi` la fonte
-- attribuzionale resta integra finche` il cliente e` attivo.

-- Marker di audit. NULL = mai anonimizzato. Quando popolato, indica la
-- data del passaggio in retention sweep automatica.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
ALTER TABLE leads     ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS customers_anonymized_idx
  ON customers (anonymized_at) WHERE anonymized_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_anonymized_idx
  ON leads (anonymized_at) WHERE anonymized_at IS NULL;

-- ────────── customers ──────────
--
-- Anonimizza i clienti la cui ultima attivita` fiscale (data emissione o
-- pagamento dell'ultima fattura) e` antecedente di N anni; oppure, se non
-- esistono fatture, anonimizza dopo N anni dalla creazione del record.
--
-- I valori di sentinella ricalcano /api/gdpr-requests/erase/:email per
-- coerenza visiva nell'audit, con una nota distintiva sul motivo
-- (retention sweep automatico vs richiesta esplicita dell'interessato).
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

-- ────────── leads ──────────
--
-- Anonimizza i leads creati prima del cutoff, ma solo se non sono linkati
-- a un customer ancora attivo (non anonimizzato). Cosi` la fonte
-- attribuzionale di un cliente non viene cancellata prematuramente.
CREATE OR REPLACE FUNCTION anonymize_leads_post_retention(years_threshold INT DEFAULT 10)
RETURNS INTEGER AS $$
DECLARE
  affected INTEGER;
  cutoff   TIMESTAMPTZ := NOW() - (years_threshold || ' years')::INTERVAL;
BEGIN
  UPDATE leads l SET
    name          = 'Dato cancellato (GDPR - retention ' || years_threshold || 'y)',
    company       = NULL,
    email         = 'erased-' || l.id::text || '@deleted.invalid',
    phone         = NULL,
    notes         = NULL,
    tags          = '{}'::text[],
    anonymized_at = NOW(),
    updated_at    = NOW()
  WHERE
    l.anonymized_at IS NULL
    AND l.email NOT LIKE 'erased-%@deleted.invalid'
    AND l.created_at < cutoff
    AND NOT EXISTS (
      SELECT 1 FROM customers c
      WHERE c.lead_id = l.id
        AND c.anonymized_at IS NULL
    );
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql;

-- ────────── orchestratore ──────────
--
-- Integra le due nuove funzioni nel master runner gia` schedulato dal cron
-- `data-retention` (apps/api/src/cron/data-retention.ts, alle 5:00). Il
-- JSONB di ritorno e` allargato in modo retro-compatibile: le chiavi nuove
-- (`customers_anonymized`, `leads_anonymized`, `retention_years`) si
-- aggiungono a quelle esistenti, il consumer in TS legge per chiave.
CREATE OR REPLACE FUNCTION run_data_retention() RETURNS JSONB AS $$
DECLARE
  analytics_purged    INTEGER;
  contacts_purged     INTEGER;
  audit_purged        INTEGER;
  consents_purged     INTEGER;
  customers_anonymized INTEGER;
  leads_anonymized     INTEGER;
  retention_years      INTEGER := 10;
BEGIN
  SELECT purge_old_analytics()      INTO analytics_purged;
  SELECT purge_old_contacts()       INTO contacts_purged;
  SELECT purge_old_audit_logs()     INTO audit_purged;
  SELECT purge_old_cookie_consents() INTO consents_purged;
  SELECT anonymize_customers_post_retention(retention_years) INTO customers_anonymized;
  SELECT anonymize_leads_post_retention(retention_years)     INTO leads_anonymized;

  RETURN jsonb_build_object(
    'analytics_purged',       analytics_purged,
    'contacts_anonymized',    contacts_purged,
    'audit_logs_purged',      audit_purged,
    'cookie_consents_purged', consents_purged,
    'customers_anonymized',   customers_anonymized,
    'leads_anonymized',       leads_anonymized,
    'retention_years',        retention_years,
    'executed_at',            NOW()
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION anonymize_customers_post_retention IS
  'GDPR H5 — anonimizza customers la cui ultima attivita` fiscale supera il limite di retention (default 10 anni allineato art. 2220 c.c.).';
COMMENT ON FUNCTION anonymize_leads_post_retention IS
  'GDPR H5 — anonimizza leads non linkati a customers attivi, dopo il limite di retention.';
