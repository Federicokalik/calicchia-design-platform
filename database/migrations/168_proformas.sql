-- 168_proformas.sql — Proforma come documento proprio (design: docs/proforma/design.md).
--
-- 1. document_sequences: progressivi annuali per tipo di documento. La
--    proforma prende il numero all'EMISSIONE (le bozze non bruciano numeri)
--    con UPDATE ... RETURNING sulla riga (kind, year): il lock di riga
--    serializza le emissioni concorrenti e numero + cambio di stato stanno
--    nella stessa transazione, quindi un rollback non lascia buchi. Un numero
--    indicato a mano porta last_number a GREATEST(last_number, n).
-- 2. proformas: documento non fiscale in regime forfettario. Importi in
--    centesimi; customer_snapshot e legal_notes congelano anagrafica e
--    diciture all'emissione. Stati: draft → issued → sent → converted
--    (pagata e convertita in fattura); cancelled da draft/issued/sent.
--    Numero "PF 3/2026" (colonna generata da seq e year).
-- 3. Al massimo una proforma aperta (draft/issued/sent) per dominio.
--
-- Reversibile: database/migrations/down/168_proformas.down.sql

CREATE TABLE IF NOT EXISTS document_sequences (
  kind        text    NOT NULL CHECK (kind IN ('proforma')),
  year        integer NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (kind, year)
);

COMMENT ON TABLE document_sequences IS
  'Progressivi annuali dei documenti non fiscali (proforma). Incremento con UPDATE ... RETURNING nella transazione di emissione.';

CREATE TABLE IF NOT EXISTS proformas (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year                 integer,
  seq                  integer CHECK (seq IS NULL OR seq > 0),
  number               text GENERATED ALWAYS AS (
                         CASE WHEN seq IS NULL THEN NULL ELSE 'PF ' || seq::text || '/' || year::text END
                       ) STORED,
  status               text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'issued', 'sent', 'converted', 'cancelled')),
  customer_id          uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  customer_snapshot    jsonb,
  issue_date           date,
  due_date             date,
  line_items           jsonb   NOT NULL DEFAULT '[]'::jsonb,
  subtotal_cents       integer NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  stamp_duty_cents     integer NOT NULL DEFAULT 0 CHECK (stamp_duty_cents >= 0),
  total_cents          integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  currency             text    NOT NULL DEFAULT 'EUR',
  regime               text,
  legal_notes          text,
  pdf_path             text,
  pdf_sha256           text,
  pdf_generated_at     timestamptz,
  sent_at              timestamptz,
  sent_to              text[]  NOT NULL DEFAULT '{}'::text[],
  sent_message_id      text,
  paid_at              timestamptz,
  payment_method       text,
  paid_amount_cents    integer CHECK (paid_amount_cents IS NULL OR paid_amount_cents >= 0),
  converted_invoice_id uuid UNIQUE REFERENCES invoices(id) ON DELETE SET NULL,
  domain_id            uuid REFERENCES domains(id) ON DELETE SET NULL,
  cancelled_at         timestamptz,
  cancel_reason        text,
  notes                text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proformas_number_unique UNIQUE (year, seq),
  CONSTRAINT proformas_year_seq_together CHECK ((year IS NULL) = (seq IS NULL)),
  CONSTRAINT proformas_number_by_status CHECK (
    (status = 'draft' AND seq IS NULL)
    OR (status IN ('issued', 'sent', 'converted') AND seq IS NOT NULL AND issue_date IS NOT NULL)
    OR status = 'cancelled'
  ),
  CONSTRAINT proformas_total_check CHECK (total_cents = subtotal_cents + stamp_duty_cents),
  CONSTRAINT proformas_converted_check CHECK (status <> 'converted' OR paid_at IS NOT NULL)
);

COMMENT ON TABLE proformas IS
  'Proforma (documento non fiscale, regime forfettario). Numero PF n/anno assegnato all''emissione; convertita in fattura (bozza) al pagamento.';

CREATE INDEX IF NOT EXISTS proformas_customer_idx ON proformas (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS proformas_status_idx ON proformas (status);
CREATE UNIQUE INDEX IF NOT EXISTS proformas_open_per_domain_idx
  ON proformas (domain_id)
  WHERE domain_id IS NOT NULL AND status IN ('draft', 'issued', 'sent');

DROP TRIGGER IF EXISTS proformas_updated ON proformas;
CREATE TRIGGER proformas_updated
  BEFORE UPDATE ON proformas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
