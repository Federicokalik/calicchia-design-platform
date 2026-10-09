-- Migration 161 — jsonb salvati come stringa JSON (seconda tornata, vedi 157).
--
-- Molte scritture passavano `${JSON.stringify(x)}` o `${JSON.stringify(x)}::jsonb`
-- a colonne jsonb: postgres-js ricodifica la stringa e la colonna riceve uno
-- scalare stringa. Peggio, `col || ${JSON.stringify(obj)}::jsonb` produce un
-- ARRAY [vecchio_oggetto, "stringa", ...]: su payment_links.payload_json
-- `payload_json->>'capture_id'` / `->>'payment_intent_id'` restavano NULL e i
-- webhook di rimborso PayPal/Stripe non trovavano più il link. Il codice ora
-- scrive con jsonb() (sql.json); qui si riparano i dati esistenti.
--
-- Esclusi di proposito:
--   * quotes_v2 già firmati: l'hash probatorio (pdf_hash_sha256) è calcolato
--     sui valori così come erano salvati; i lettori gestiscono entrambe le forme.
--   * audit_logs, signature_audit_log, portal_login_events: registri di audit,
--     non si riscrivono.
-- Idempotente: tocca solo righe ancora di tipo 'string' (o array da merge).

-- Scompone fino a 5 livelli di stringa JSON annidata; lascia invariate le
-- stringhe che non sono JSON valido.
CREATE OR REPLACE FUNCTION pg_temp.jsonb_unwrap(v jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  cur jsonb := v;
  i int := 0;
BEGIN
  WHILE cur IS NOT NULL AND jsonb_typeof(cur) = 'string' AND i < 5 LOOP
    BEGIN
      cur := (cur #>> '{}')::jsonb;
    EXCEPTION WHEN others THEN
      RETURN cur;
    END;
    i := i + 1;
  END LOOP;
  RETURN cur;
END $$;

-- Ricompone l'oggetto da un array prodotto da `oggetto || 'stringa'::jsonb`:
-- [ {..}, "{\"k\":1}", ... ] → {.., "k": 1, ...}. Qualsiasi altra forma resta
-- invariata (non si indovina).
CREATE OR REPLACE FUNCTION pg_temp.jsonb_fix_merge(v jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  base jsonb := pg_temp.jsonb_unwrap(v);
  acc jsonb := '{}'::jsonb;
  el jsonb;
  parsed jsonb;
BEGIN
  IF base IS NULL OR jsonb_typeof(base) <> 'array' OR jsonb_array_length(base) = 0 THEN
    RETURN base;
  END IF;
  FOR el IN SELECT value FROM jsonb_array_elements(base) LOOP
    parsed := pg_temp.jsonb_unwrap(el);
    IF jsonb_typeof(parsed) = 'array' THEN
      parsed := pg_temp.jsonb_fix_merge(parsed);
    END IF;
    IF jsonb_typeof(parsed) <> 'object' THEN
      RETURN base;
    END IF;
    acc := acc || parsed;
  END LOOP;
  RETURN acc;
END $$;

-- Pagamenti: payload_json/metadata devono essere oggetti.
UPDATE payment_links SET payload_json = pg_temp.jsonb_fix_merge(payload_json)
  WHERE jsonb_typeof(payload_json) IN ('string', 'array');
UPDATE subscriptions SET metadata = pg_temp.jsonb_fix_merge(metadata)
  WHERE jsonb_typeof(metadata) IN ('string', 'array');
UPDATE payment_links SET refund_history = pg_temp.jsonb_unwrap(refund_history)
  WHERE jsonb_typeof(refund_history) = 'string';

-- Preventivi non ancora firmati.
UPDATE quotes_v2 SET items = pg_temp.jsonb_unwrap(items)
  WHERE jsonb_typeof(items) = 'string' AND signed_at IS NULL;
UPDATE quotes_v2 SET materials_checklist = pg_temp.jsonb_unwrap(materials_checklist)
  WHERE jsonb_typeof(materials_checklist) = 'string' AND signed_at IS NULL;
UPDATE quotes_v2 SET project_template = pg_temp.jsonb_unwrap(project_template)
  WHERE jsonb_typeof(project_template) = 'string' AND signed_at IS NULL;

-- Marketing (agenzia): KPI e metriche. Le chiavi numeriche ("0", "1", …) sono
-- residui dell'editor che spalmava la stringa carattere per carattere.
UPDATE marketing_campaigns SET kpi_target = pg_temp.jsonb_unwrap(kpi_target)
  WHERE jsonb_typeof(kpi_target) = 'string';
UPDATE marketing_campaigns SET kpi_actual = pg_temp.jsonb_unwrap(kpi_actual)
  WHERE jsonb_typeof(kpi_actual) = 'string';
UPDATE marketing_campaigns
  SET kpi_target = kpi_target - ARRAY(SELECT k FROM jsonb_object_keys(kpi_target) k WHERE k ~ '^[0-9]+$')
  WHERE jsonb_typeof(kpi_target) = 'object'
    AND EXISTS (SELECT 1 FROM jsonb_object_keys(kpi_target) k WHERE k ~ '^[0-9]+$');
UPDATE marketing_campaigns
  SET kpi_actual = kpi_actual - ARRAY(SELECT k FROM jsonb_object_keys(kpi_actual) k WHERE k ~ '^[0-9]+$')
  WHERE jsonb_typeof(kpi_actual) = 'object'
    AND EXISTS (SELECT 1 FROM jsonb_object_keys(kpi_actual) k WHERE k ~ '^[0-9]+$');
UPDATE campaign_reports SET metrics_json = pg_temp.jsonb_unwrap(metrics_json)
  WHERE jsonb_typeof(metrics_json) = 'string';

-- Altre colonne scritte con JSON.stringify.
UPDATE brain_conversations SET messages = pg_temp.jsonb_unwrap(messages)
  WHERE jsonb_typeof(messages) = 'string';
UPDATE client_projects SET pipeline_steps = pg_temp.jsonb_unwrap(pipeline_steps)
  WHERE jsonb_typeof(pipeline_steps) = 'string';
UPDATE customers SET tags = pg_temp.jsonb_unwrap(tags)
  WHERE jsonb_typeof(tags) = 'string';
UPDATE email_drafts SET to_addrs = pg_temp.jsonb_unwrap(to_addrs)
  WHERE jsonb_typeof(to_addrs) = 'string';
UPDATE email_drafts SET cc_addrs = pg_temp.jsonb_unwrap(cc_addrs)
  WHERE jsonb_typeof(cc_addrs) = 'string';
UPDATE email_messages SET to_addrs = pg_temp.jsonb_unwrap(to_addrs)
  WHERE jsonb_typeof(to_addrs) = 'string';
UPDATE email_messages SET cc_addrs = pg_temp.jsonb_unwrap(cc_addrs)
  WHERE jsonb_typeof(cc_addrs) = 'string';
UPDATE portal_reports SET data = pg_temp.jsonb_unwrap(data)
  WHERE jsonb_typeof(data) = 'string';
UPDATE project_comments SET attachments = pg_temp.jsonb_unwrap(attachments)
  WHERE jsonb_typeof(attachments) = 'string';
UPDATE workflow_executions SET trigger_data = pg_temp.jsonb_unwrap(trigger_data)
  WHERE jsonb_typeof(trigger_data) = 'string';
UPDATE workflow_executions SET result = pg_temp.jsonb_unwrap(result)
  WHERE jsonb_typeof(result) = 'string';
UPDATE workflow_step_logs SET input = pg_temp.jsonb_unwrap(input)
  WHERE jsonb_typeof(input) = 'string';
UPDATE workflow_step_logs SET output = pg_temp.jsonb_unwrap(output)
  WHERE jsonb_typeof(output) = 'string';
UPDATE blog_posts SET demos = pg_temp.jsonb_unwrap(demos)
  WHERE jsonb_typeof(demos) = 'string';
