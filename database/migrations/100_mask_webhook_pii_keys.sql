-- Migration: 100_mask_webhook_pii_keys.sql
-- Descrizione: Estende la lista di chiavi PII mascherate da mask_webhook_pii() (GDPR-05).
-- Data: 2026-05-21
--
-- La versione in 084_webhook_retention.sql non copriva alcune chiavi ricorrenti
-- nei payload dei provider/form italiani (whatsapp, mobile, codice_fiscale,
-- notes, ecc.). Qui si ridefinisce la funzione con la lista ampliata; il corpo
-- è identico, cambia solo l'ARRAY delle chiavi redatte.

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
      'fiscal_code', 'iban',
      -- GDPR-05 additions: provider/form keys missed by the original list.
      'whatsapp', 'mobile', 'codice_fiscale', 'notes',
      'telefono', 'cellulare', 'address', 'indirizzo', 'partita_iva'
    ]) THEN
      v_result := v_result || jsonb_build_object(v_key, '[redacted]');
    ELSE
      v_result := v_result || jsonb_build_object(v_key, public.mask_webhook_pii(v_value));
    END IF;
  END LOOP;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
