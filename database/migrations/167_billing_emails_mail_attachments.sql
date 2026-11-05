-- 167_billing_emails_mail_attachments.sql
--
-- 1. customers.billing_emails: destinatari delle comunicazioni amministrative
--    (fatture, rinnovi, solleciti). Se l'array è vuoto si usa customers.email
--    (lib/customer-recipients.ts). Scelta: text[] invece di una tabella
--    customer_contacts perché serve solo un elenco di indirizzi per gli invii
--    automatici, senza nomi, ruoli o accessi per contatto; una tabella
--    aggiungerebbe join in ogni invio e un CRUD dedicato senza un caso d'uso.
--    La validazione del formato (email valida, minuscolo, senza duplicati, max
--    10) è applicativa (routes/customers.ts); il DB garantisce solo l'assenza
--    di NULL e un tetto alla cardinalità.
-- 2. email_drafts.attachments: allegati delle bozze, come snapshot dei file
--    salvati nello storage privato (categoria 'mail'):
--    [{id, filename, content_type, size, sha256, storage}].
-- 3. email_accounts.sent_copy_mode: copia del messaggio inviato in Inviati
--    via IMAP APPEND. 'auto' = APPEND salvo provider che salvano da soli
--    (Gmail, Microsoft 365: lib/mail/outbound.ts), 'append' = sempre,
--    'skip' = mai.
-- 4. domains.auto_renew: default false. I domini rinnovati su proforma non si
--    rinnovano da soli; con true il digest Telegram li mostrava come
--    automatici. L'API richiede comunque il campo in creazione.
-- 5. anonymize_customers_post_retention: azzera anche billing_emails (GDPR,
--    stessa logica della 104).
--
-- Reversibile: database/migrations/down/167_billing_emails_mail_attachments.down.sql

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS billing_emails text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_billing_emails_check;
ALTER TABLE customers
  ADD CONSTRAINT customers_billing_emails_check
  CHECK (cardinality(billing_emails) <= 20 AND array_position(billing_emails, NULL) IS NULL);

COMMENT ON COLUMN customers.billing_emails IS
  'Destinatari delle comunicazioni amministrative (fatture, rinnovi, solleciti). Vuoto = customers.email.';

ALTER TABLE email_drafts
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN email_drafts.attachments IS
  'Allegati della bozza: [{id, filename, content_type, size, sha256, storage}], file in PRIVATE_UPLOAD_DIR/mail.';

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS sent_copy_mode text NOT NULL DEFAULT 'auto';

ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_sent_copy_mode_check;
ALTER TABLE email_accounts
  ADD CONSTRAINT email_accounts_sent_copy_mode_check
  CHECK (sent_copy_mode IN ('auto', 'append', 'skip'));

COMMENT ON COLUMN email_accounts.sent_copy_mode IS
  'Copia in Inviati via IMAP APPEND: auto (salvo provider che salvano da soli), append, skip.';

ALTER TABLE domains ALTER COLUMN auto_renew SET DEFAULT false;

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
