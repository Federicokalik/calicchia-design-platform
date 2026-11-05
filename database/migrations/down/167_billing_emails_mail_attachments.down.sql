-- Rollback di 167_billing_emails_mail_attachments.sql.
--
-- Il runner (src/lib/db-migrate.ts) applica solo i file in avanti: questo si
-- esegue a mano, nella stessa transazione della rimozione dal ledger:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f database/migrations/down/167_billing_emails_mail_attachments.down.sql
-- ATTENZIONE: elimina i dati di customers.billing_emails, email_drafts.attachments
-- (i file in PRIVATE_UPLOAD_DIR/mail restano: rimuoverli a mano) e
-- email_accounts.sent_copy_mode. Prima del rollback va ripristinato il codice
-- precedente, che non legge queste colonne.

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

ALTER TABLE domains ALTER COLUMN auto_renew SET DEFAULT true;

ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_sent_copy_mode_check;
ALTER TABLE email_accounts DROP COLUMN IF EXISTS sent_copy_mode;

ALTER TABLE email_drafts DROP COLUMN IF EXISTS attachments;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_billing_emails_check;
ALTER TABLE customers DROP COLUMN IF EXISTS billing_emails;

DELETE FROM schema_migrations WHERE version = '167_billing_emails_mail_attachments.sql';
