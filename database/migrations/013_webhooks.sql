-- Migration: 013_webhooks.sql
-- Descrizione: Sistema Webhook per integrazioni esterne
-- Data: 2026-01-20

-- =====================================================
-- TABELLA WEBHOOKS
-- Configurazione endpoint webhook
-- =====================================================

CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Info base
  name TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,

  -- Sicurezza
  secret TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  headers JSONB DEFAULT '{}', -- Header custom da inviare

  -- Eventi sottoscritti
  events TEXT[] NOT NULL DEFAULT '{}',

  -- Stato
  is_active BOOLEAN DEFAULT true,
  last_triggered_at TIMESTAMPTZ,
  failure_count INTEGER DEFAULT 0,
  disabled_at TIMESTAMPTZ, -- Se disabilitato per troppi errori

  -- Retry config
  max_retries INTEGER DEFAULT 3,
  retry_delay_seconds INTEGER DEFAULT 60,

  -- Metadata
  created_by UUID REFERENCES profiles(id),
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici
CREATE INDEX idx_webhooks_active ON webhooks(is_active) WHERE is_active = true;
CREATE INDEX idx_webhooks_events ON webhooks USING GIN(events);

-- =====================================================
-- EVENTI DISPONIBILI
-- =====================================================

COMMENT ON TABLE webhooks IS 'Eventi disponibili:
- customer.created, customer.updated, customer.deleted
- invoice.created, invoice.paid, invoice.overdue
- quote.created, quote.sent, quote.accepted, quote.rejected
- project.created, project.updated, project.completed
- task.created, task.completed
- domain.created, domain.expiring, domain.expired
- subscription.created, subscription.cancelled
- form.submitted
';

-- =====================================================
-- TABELLA WEBHOOK_DELIVERIES
-- Log consegne webhook
-- =====================================================

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,

  -- Evento
  event_type TEXT NOT NULL,
  event_id UUID, -- ID dell'evento originale
  payload JSONB NOT NULL,

  -- Request
  request_url TEXT NOT NULL,
  request_headers JSONB,

  -- Response
  response_status INTEGER,
  response_body TEXT,
  response_headers JSONB,

  -- Timing
  duration_ms INTEGER,

  -- Status
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending', 'success', 'failed', 'retrying'
  )),
  attempt_count INTEGER DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  error_message TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Indici
CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at)
  WHERE status = 'retrying';
CREATE INDEX idx_webhook_deliveries_created ON webhook_deliveries(created_at DESC);

-- =====================================================
-- TABELLA WEBHOOK_EVENTS
-- Coda eventi da processare
-- =====================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  payload JSONB NOT NULL,

  -- Processing
  processed_at TIMESTAMPTZ,
  error_message TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_webhook_events_pending ON webhook_events(created_at)
  WHERE processed_at IS NULL;

-- =====================================================
-- FUNZIONI
-- =====================================================

-- Crea evento webhook
CREATE OR REPLACE FUNCTION create_webhook_event(
  p_event_type TEXT,
  p_entity_type TEXT,
  p_entity_id UUID,
  p_payload JSONB
)
RETURNS UUID AS $$
DECLARE
  v_event_id UUID;
BEGIN
  INSERT INTO webhook_events (event_type, entity_type, entity_id, payload)
  VALUES (p_event_type, p_entity_type, p_entity_id, p_payload)
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recupera webhook per evento
CREATE OR REPLACE FUNCTION get_webhooks_for_event(p_event_type TEXT)
RETURNS TABLE (
  id UUID,
  url TEXT,
  secret TEXT,
  headers JSONB,
  max_retries INTEGER,
  retry_delay_seconds INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    w.id,
    w.url,
    w.secret,
    w.headers,
    w.max_retries,
    w.retry_delay_seconds
  FROM webhooks w
  WHERE w.is_active = true
    AND w.disabled_at IS NULL
    AND p_event_type = ANY(w.events);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Registra tentativo di delivery
CREATE OR REPLACE FUNCTION record_webhook_delivery(
  p_webhook_id UUID,
  p_event_type TEXT,
  p_event_id UUID,
  p_payload JSONB,
  p_url TEXT,
  p_request_headers JSONB,
  p_response_status INTEGER,
  p_response_body TEXT,
  p_response_headers JSONB,
  p_duration_ms INTEGER,
  p_error_message TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_delivery_id UUID;
  v_webhook webhooks%ROWTYPE;
  v_status TEXT;
BEGIN
  -- Determina status
  IF p_response_status IS NOT NULL AND p_response_status >= 200 AND p_response_status < 300 THEN
    v_status := 'success';
  ELSE
    v_status := 'failed';
  END IF;

  -- Inserisci delivery
  INSERT INTO webhook_deliveries (
    webhook_id, event_type, event_id, payload,
    request_url, request_headers,
    response_status, response_body, response_headers,
    duration_ms, status, attempt_count, error_message, completed_at
  )
  VALUES (
    p_webhook_id, p_event_type, p_event_id, p_payload,
    p_url, p_request_headers,
    p_response_status, p_response_body, p_response_headers,
    p_duration_ms, v_status, 1, p_error_message,
    CASE WHEN v_status = 'success' THEN NOW() ELSE NULL END
  )
  RETURNING id INTO v_delivery_id;

  -- Aggiorna webhook
  SELECT * INTO v_webhook FROM webhooks WHERE id = p_webhook_id;

  IF v_status = 'success' THEN
    UPDATE webhooks
    SET
      last_triggered_at = NOW(),
      failure_count = 0,
      updated_at = NOW()
    WHERE id = p_webhook_id;
  ELSE
    UPDATE webhooks
    SET
      failure_count = failure_count + 1,
      disabled_at = CASE WHEN failure_count >= 10 THEN NOW() ELSE NULL END,
      updated_at = NOW()
    WHERE id = p_webhook_id;

    -- Schedula retry se non ha superato max tentativi
    IF v_webhook.failure_count < v_webhook.max_retries THEN
      UPDATE webhook_deliveries
      SET
        status = 'retrying',
        next_retry_at = NOW() + (v_webhook.retry_delay_seconds * (2 ^ (v_webhook.failure_count)) || ' seconds')::INTERVAL
      WHERE id = v_delivery_id;
    END IF;
  END IF;

  RETURN v_delivery_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Riattiva webhook disabilitato
CREATE OR REPLACE FUNCTION reactivate_webhook(p_webhook_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE webhooks
  SET
    is_active = true,
    disabled_at = NULL,
    failure_count = 0,
    updated_at = NOW()
  WHERE id = p_webhook_id
    AND is_admin();

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Test webhook (invia evento di test)
CREATE OR REPLACE FUNCTION test_webhook(p_webhook_id UUID)
RETURNS UUID AS $$
DECLARE
  v_event_id UUID;
BEGIN
  v_event_id := create_webhook_event(
    'webhook.test',
    'webhook',
    p_webhook_id,
    jsonb_build_object(
      'message', 'This is a test webhook event',
      'timestamp', NOW(),
      'webhook_id', p_webhook_id
    )
  );

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- TRIGGERS PER EVENTI AUTOMATICI
-- =====================================================

-- Trigger generico per creare eventi
CREATE OR REPLACE FUNCTION webhook_event_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_event_type TEXT;
  v_payload JSONB;
BEGIN
  -- Determina tipo evento
  v_event_type := TG_TABLE_NAME || '.' || LOWER(TG_OP);

  -- Crea payload
  IF TG_OP = 'DELETE' THEN
    v_payload := jsonb_build_object(
      'event', v_event_type,
      'data', to_jsonb(OLD),
      'timestamp', NOW()
    );
  ELSE
    v_payload := jsonb_build_object(
      'event', v_event_type,
      'data', to_jsonb(NEW),
      'previous', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
      'timestamp', NOW()
    );
  END IF;

  -- Crea evento (sarà processato da edge function o worker)
  PERFORM create_webhook_event(
    v_event_type,
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    v_payload
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Applica trigger per eventi customer
DROP TRIGGER IF EXISTS webhook_customers ON customers;
CREATE TRIGGER webhook_customers
  AFTER INSERT OR UPDATE OR DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION webhook_event_trigger();

-- Applica trigger per eventi invoice
DROP TRIGGER IF EXISTS webhook_invoices ON invoices;
CREATE TRIGGER webhook_invoices
  AFTER INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION webhook_event_trigger();

-- Applica trigger per eventi quote
DROP TRIGGER IF EXISTS webhook_quotes ON quotes;
CREATE TRIGGER webhook_quotes
  AFTER INSERT OR UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION webhook_event_trigger();

-- Trigger specifico per quote accepted/rejected
CREATE OR REPLACE FUNCTION webhook_quote_status_change()
RETURNS TRIGGER AS $$
DECLARE
  v_event_type TEXT;
BEGIN
  IF NEW.status != OLD.status THEN
    IF NEW.status = 'accepted' THEN
      v_event_type := 'quote.accepted';
    ELSIF NEW.status = 'rejected' THEN
      v_event_type := 'quote.rejected';
    ELSIF NEW.status = 'sent' THEN
      v_event_type := 'quote.sent';
    ELSE
      RETURN NEW;
    END IF;

    PERFORM create_webhook_event(
      v_event_type,
      'quotes',
      NEW.id,
      jsonb_build_object(
        'event', v_event_type,
        'data', to_jsonb(NEW),
        'timestamp', NOW()
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS webhook_quote_status ON quotes;
CREATE TRIGGER webhook_quote_status
  AFTER UPDATE OF status ON quotes
  FOR EACH ROW EXECUTE FUNCTION webhook_quote_status_change();

-- Trigger per invoice paid
CREATE OR REPLACE FUNCTION webhook_invoice_paid()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'paid' AND (OLD.status IS NULL OR OLD.status != 'paid') THEN
    PERFORM create_webhook_event(
      'invoice.paid',
      'invoices',
      NEW.id,
      jsonb_build_object(
        'event', 'invoice.paid',
        'data', to_jsonb(NEW),
        'timestamp', NOW()
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS webhook_invoice_paid ON invoices;
CREATE TRIGGER webhook_invoice_paid
  AFTER UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION webhook_invoice_paid();

-- =====================================================
-- RLS POLICIES
-- =====================================================

ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

-- Solo admin può gestire webhooks
DROP POLICY IF EXISTS "Admin full access webhooks" ON webhooks;
CREATE POLICY "Admin full access webhooks" ON webhooks
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admin full access deliveries" ON webhook_deliveries;
CREATE POLICY "Admin full access deliveries" ON webhook_deliveries
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admin full access events" ON webhook_events;
CREATE POLICY "Admin full access events" ON webhook_events
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- =====================================================
-- TRIGGERS UPDATED_AT
-- =====================================================

DROP TRIGGER IF EXISTS update_webhooks_updated_at ON webhooks;
CREATE TRIGGER update_webhooks_updated_at
  BEFORE UPDATE ON webhooks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- VISTE
-- =====================================================

-- Vista webhooks con statistiche
CREATE OR REPLACE VIEW webhooks_view AS
SELECT
  w.*,
  (SELECT COUNT(*) FROM webhook_deliveries WHERE webhook_id = w.id) AS total_deliveries,
  (SELECT COUNT(*) FROM webhook_deliveries WHERE webhook_id = w.id AND status = 'success') AS successful_deliveries,
  (SELECT COUNT(*) FROM webhook_deliveries WHERE webhook_id = w.id AND status = 'failed') AS failed_deliveries,
  (SELECT MAX(created_at) FROM webhook_deliveries WHERE webhook_id = w.id) AS last_delivery_at
FROM webhooks w;

-- Vista deliveries recenti
CREATE OR REPLACE VIEW recent_webhook_deliveries AS
SELECT
  wd.*,
  w.name AS webhook_name,
  w.url AS webhook_url
FROM webhook_deliveries wd
JOIN webhooks w ON w.id = wd.webhook_id
ORDER BY wd.created_at DESC
LIMIT 100;

GRANT SELECT ON webhooks_view TO authenticated;
GRANT SELECT ON recent_webhook_deliveries TO authenticated;

-- =====================================================
-- PULIZIA
-- =====================================================

-- Funzione pulizia vecchi log
CREATE OR REPLACE FUNCTION cleanup_old_webhook_data(
  p_deliveries_days INTEGER DEFAULT 30,
  p_events_days INTEGER DEFAULT 7
)
RETURNS TABLE (deleted_deliveries INTEGER, deleted_events INTEGER) AS $$
DECLARE
  v_deliveries INTEGER;
  v_events INTEGER;
BEGIN
  -- Pulisci deliveries vecchie
  DELETE FROM webhook_deliveries
  WHERE created_at < NOW() - (p_deliveries_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_deliveries = ROW_COUNT;

  -- Pulisci eventi processati
  DELETE FROM webhook_events
  WHERE processed_at IS NOT NULL
    AND created_at < NOW() - (p_events_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  RETURN QUERY SELECT v_deliveries, v_events;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
