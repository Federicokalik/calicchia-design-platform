-- 084: Webhook payload retention
-- Retention target: 30 giorni per code/log webhook che possono contenere payload provider.

CREATE OR REPLACE FUNCTION public.mask_webhook_pii(p_payload JSONB)
RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
  v_key TEXT;
  v_value JSONB;
BEGIN
  IF p_payload IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_payload) = 'array' THEN
    SELECT COALESCE(jsonb_agg(public.mask_webhook_pii(value)), '[]'::jsonb)
    INTO v_result
    FROM jsonb_array_elements(p_payload);
    RETURN v_result;
  END IF;

  IF jsonb_typeof(p_payload) <> 'object' THEN
    RETURN p_payload;
  END IF;

  v_result := '{}'::jsonb;
  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(p_payload)
  LOOP
    IF lower(v_key) = ANY (ARRAY[
      'email', 'phone', 'name', 'first_name', 'last_name',
      'billing_address', 'shipping_address', 'tax_id', 'vat_id',
      'fiscal_code', 'iban'
    ]) THEN
      v_result := v_result || jsonb_build_object(v_key, '[redacted]');
    ELSE
      v_result := v_result || jsonb_build_object(v_key, public.mask_webhook_pii(v_value));
    END IF;
  END LOOP;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.sanitize_webhook_headers(p_headers JSONB)
RETURNS JSONB AS $$
DECLARE
  v_result JSONB := '{}'::jsonb;
  v_key TEXT;
  v_value JSONB;
BEGIN
  IF p_headers IS NULL OR jsonb_typeof(p_headers) <> 'object' THEN
    RETURN p_headers;
  END IF;

  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(p_headers)
  LOOP
    IF lower(v_key) <> ALL (ARRAY[
      'authorization', 'cookie', 'x-api-key', 'stripe-signature',
      'paypal-transmission-sig', 'x-webhook-secret',
      'x-hub-signature', 'x-hub-signature-256'
    ]) THEN
      v_result := v_result || jsonb_build_object(v_key, v_value);
    END IF;
  END LOOP;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

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
  VALUES (p_event_type, p_entity_type, p_entity_id, public.mask_webhook_pii(p_payload))
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
  IF p_response_status IS NOT NULL AND p_response_status >= 200 AND p_response_status < 300 THEN
    v_status := 'success';
  ELSE
    v_status := 'failed';
  END IF;

  INSERT INTO webhook_deliveries (
    webhook_id, event_type, event_id, payload,
    request_url, request_headers,
    response_status, response_body, response_headers,
    duration_ms, status, attempt_count, error_message, completed_at
  )
  VALUES (
    p_webhook_id, p_event_type, p_event_id, public.mask_webhook_pii(p_payload),
    p_url, public.sanitize_webhook_headers(p_request_headers),
    p_response_status, p_response_body, public.sanitize_webhook_headers(p_response_headers),
    p_duration_ms, v_status, 1, p_error_message,
    CASE WHEN v_status = 'success' THEN NOW() ELSE NULL END
  )
  RETURNING id INTO v_delivery_id;

  SELECT * INTO v_webhook FROM webhooks WHERE id = p_webhook_id;

  IF v_status = 'success' THEN
    UPDATE webhooks
    SET last_triggered_at = NOW(), failure_count = 0, updated_at = NOW()
    WHERE id = p_webhook_id;
  ELSE
    UPDATE webhooks
    SET
      failure_count = failure_count + 1,
      disabled_at = CASE WHEN failure_count >= 10 THEN NOW() ELSE NULL END,
      updated_at = NOW()
    WHERE id = p_webhook_id;

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

CREATE OR REPLACE FUNCTION public.cleanup_webhook_security_retention()
RETURNS TABLE (
  deleted_webhook_events INTEGER,
  deleted_webhook_deliveries INTEGER,
  deleted_stripe_logs INTEGER,
  deleted_paypal_logs INTEGER,
  deleted_payment_logs INTEGER
) AS $$
DECLARE
  v_webhook_events INTEGER := 0;
  v_webhook_deliveries INTEGER := 0;
  v_stripe_logs INTEGER := 0;
  v_paypal_logs INTEGER := 0;
  v_payment_logs INTEGER := 0;
BEGIN
  DELETE FROM public.webhook_events
  WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS v_webhook_events = ROW_COUNT;

  DELETE FROM public.webhook_deliveries
  WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS v_webhook_deliveries = ROW_COUNT;

  DELETE FROM public.stripe_webhook_logs
  WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS v_stripe_logs = ROW_COUNT;

  DELETE FROM public.paypal_webhook_logs
  WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS v_paypal_logs = ROW_COUNT;

  DELETE FROM public.payment_webhook_events
  WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS v_payment_logs = ROW_COUNT;

  RETURN QUERY SELECT
    v_webhook_events,
    v_webhook_deliveries,
    v_stripe_logs,
    v_paypal_logs,
    v_payment_logs;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'cleanup-webhook-security-retention',
      '17 3 * * *',
      'SELECT public.cleanup_webhook_security_retention();'
    )
    WHERE NOT EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'cleanup-webhook-security-retention'
    );
  END IF;
END $$;

COMMENT ON FUNCTION public.cleanup_webhook_security_retention() IS
  'Retention webhook 30 giorni. Se pg_cron non e'' installato, schedulare esternamente: SELECT public.cleanup_webhook_security_retention();';
