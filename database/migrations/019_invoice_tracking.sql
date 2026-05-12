-- ============================================
-- INVOICE TRACKING ENHANCEMENTS
-- Aggiunge campi per tracking semplice fatture
-- ============================================

-- Aggiunge sent_at per tracciare quando la fattura è stata inviata
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- Aggiunge description per note veloci
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS description TEXT;

-- Indice per fatture inviate
CREATE INDEX IF NOT EXISTS invoices_sent_idx ON invoices(sent_at) WHERE sent_at IS NOT NULL;

-- Vista riepilogativa fatture
CREATE OR REPLACE VIEW invoices_summary AS
SELECT
  i.id,
  i.invoice_number,
  i.description,
  i.customer_id,
  c.company_name,
  c.contact_name,
  c.email as customer_email,
  i.total,
  i.currency,
  i.status,
  i.issue_date,
  i.due_date,
  i.sent_at,
  i.paid_at,
  -- Stati derivati per UI
  CASE WHEN i.status = 'draft' THEN false ELSE true END as is_issued,
  CASE WHEN i.sent_at IS NOT NULL THEN true ELSE false END as is_sent,
  CASE WHEN i.status = 'paid' THEN true ELSE false END as is_paid,
  -- Giorni scadenza
  CASE
    WHEN i.status = 'paid' THEN NULL
    WHEN i.due_date IS NULL THEN NULL
    ELSE i.due_date - CURRENT_DATE
  END as days_until_due
FROM invoices i
LEFT JOIN customers c ON i.customer_id = c.id;

-- Funzione per aggiornare stato fattura
CREATE OR REPLACE FUNCTION update_invoice_status(
  p_invoice_id UUID,
  p_action TEXT -- 'issue', 'send', 'pay', 'void'
)
RETURNS invoices AS $$
DECLARE
  v_invoice invoices;
BEGIN
  CASE p_action
    WHEN 'issue' THEN
      UPDATE invoices
      SET status = 'open', updated_at = NOW()
      WHERE id = p_invoice_id AND status = 'draft'
      RETURNING * INTO v_invoice;

    WHEN 'send' THEN
      UPDATE invoices
      SET sent_at = NOW(), updated_at = NOW()
      WHERE id = p_invoice_id AND sent_at IS NULL
      RETURNING * INTO v_invoice;

    WHEN 'pay' THEN
      UPDATE invoices
      SET status = 'paid', paid_at = NOW(), amount_paid = total, amount_due = 0, updated_at = NOW()
      WHERE id = p_invoice_id AND status IN ('open', 'draft')
      RETURNING * INTO v_invoice;

    WHEN 'void' THEN
      UPDATE invoices
      SET status = 'void', updated_at = NOW()
      WHERE id = p_invoice_id AND status != 'paid'
      RETURNING * INTO v_invoice;

    ELSE
      RAISE EXCEPTION 'Azione non valida: %', p_action;
  END CASE;

  RETURN v_invoice;
END;
$$ LANGUAGE plpgsql;
