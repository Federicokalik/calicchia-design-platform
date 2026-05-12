-- Migration: 016_quote_client_fields.sql
-- Descrizione: Campi aggiuntivi per interazione cliente sui preventivi
-- Data: 2026-01-20

-- =====================================================
-- CAMPI AGGIUNTIVI QUOTES
-- =====================================================

-- Selezioni del cliente (quali voci ha scelto)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS selected_items JSONB DEFAULT '[]';

-- Firma del cliente (base64 o URL)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS client_signature TEXT;

-- Note del cliente
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS client_notes TEXT;

-- Numero revisione
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS revision_number INTEGER DEFAULT 1;

-- ID preventivo originale (per tracciare revisioni)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS parent_quote_id UUID REFERENCES quotes(id);

-- =====================================================
-- FUNZIONE CREA REVISIONE PREVENTIVO
-- =====================================================

CREATE OR REPLACE FUNCTION create_quote_revision(p_quote_id UUID)
RETURNS UUID AS $$
DECLARE
  v_old_quote quotes%ROWTYPE;
  v_new_quote_id UUID;
  v_new_number INTEGER;
BEGIN
  -- Recupera preventivo originale
  SELECT * INTO v_old_quote FROM quotes WHERE id = p_quote_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Preventivo non trovato';
  END IF;

  -- Calcola numero revisione
  SELECT COALESCE(MAX(revision_number), 0) + 1
  INTO v_new_number
  FROM quotes
  WHERE parent_quote_id = p_quote_id OR id = p_quote_id;

  -- Crea copia con nuovo ID
  INSERT INTO quotes (
    customer_id,
    project_id,
    status,
    issue_date,
    valid_until,
    subtotal,
    discount_percentage,
    discount_amount,
    tax_rate,
    tax_amount,
    total,
    currency,
    line_items,
    title,
    introduction,
    notes,
    terms,
    payment_terms,
    created_by,
    metadata,
    revision_number,
    parent_quote_id
  )
  VALUES (
    v_old_quote.customer_id,
    v_old_quote.project_id,
    'draft',
    CURRENT_DATE,
    v_old_quote.valid_until,
    v_old_quote.subtotal,
    v_old_quote.discount_percentage,
    v_old_quote.discount_amount,
    v_old_quote.tax_rate,
    v_old_quote.tax_amount,
    v_old_quote.total,
    v_old_quote.currency,
    v_old_quote.line_items,
    v_old_quote.title,
    v_old_quote.introduction,
    v_old_quote.notes,
    v_old_quote.terms,
    v_old_quote.payment_terms,
    v_old_quote.created_by,
    jsonb_build_object('revision_of', p_quote_id),
    v_new_number,
    COALESCE(v_old_quote.parent_quote_id, p_quote_id)
  )
  RETURNING id INTO v_new_quote_id;

  RETURN v_new_quote_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- VISTA STORICO REVISIONI
-- =====================================================

CREATE OR REPLACE VIEW quote_revisions AS
SELECT
  q.id,
  q.quote_number,
  q.revision_number,
  q.status,
  q.issue_date,
  q.total,
  q.parent_quote_id,
  COALESCE(q.parent_quote_id, q.id) AS original_quote_id,
  q.created_at
FROM quotes q
ORDER BY COALESCE(q.parent_quote_id, q.id), q.revision_number;

GRANT SELECT ON quote_revisions TO authenticated;
