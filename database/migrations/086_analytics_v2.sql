BEGIN;

-- Sezione 1: aggiunge i campi Analytics v2 mantenendo compatibilita' con i dati esistenti.
ALTER TABLE public.analytics
  ADD COLUMN IF NOT EXISTS website_id TEXT NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS visit_id TEXT,
  ADD COLUMN IF NOT EXISTS utm_source TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS utm_term TEXT,
  ADD COLUMN IF NOT EXISTS utm_content TEXT,
  ADD COLUMN IF NOT EXISTS referrer_domain TEXT,
  ADD COLUMN IF NOT EXISTS event_name TEXT,
  ADD COLUMN IF NOT EXISTS event_value NUMERIC,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

-- Sezione 2: rende facoltativi IP e user agent per eventi server-side o privacy-first.
ALTER TABLE public.analytics
  ALTER COLUMN ip_address DROP NOT NULL,
  ALTER COLUMN user_agent DROP NOT NULL;

-- Sezione 3: converte analytics in tabella partizionata senza perdere righe esistenti.
DO $$
DECLARE
  analytics_is_partitioned BOOLEAN;
  base_month DATE := to_char(NOW(), 'YYYY-MM-01')::date;
  min_month DATE;
  max_month DATE;
  month_cursor DATE;
  next_month DATE;
  partition_name TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'analytics'
      AND c.relkind = 'p'
  )
  INTO analytics_is_partitioned;

  IF NOT analytics_is_partitioned THEN
    EXECUTE 'DROP TABLE IF EXISTS public.analytics_partitioned';

    -- Crea il nuovo padre partizionato copiando default e identity dalla tabella attuale.
    EXECUTE 'CREATE TABLE public.analytics_partitioned (LIKE public.analytics INCLUDING DEFAULTS INCLUDING IDENTITY) PARTITION BY RANGE (created_at)';

    -- PostgreSQL richiede che la chiave primaria includa la chiave di partizionamento.
    EXECUTE 'ALTER TABLE public.analytics_partitioned ADD CONSTRAINT analytics_partitioned_pkey PRIMARY KEY (id, created_at)';

    -- Calcola l'intervallo mensile da coprire: storico presente piu' mese precedente, corrente e successivo.
    SELECT
      date_trunc('month', MIN(created_at))::date,
      date_trunc('month', MAX(created_at))::date
    INTO min_month, max_month
    FROM public.analytics;

    min_month := LEAST(COALESCE(min_month, base_month - INTERVAL '1 month'), base_month - INTERVAL '1 month')::date;
    max_month := GREATEST(COALESCE(max_month, base_month + INTERVAL '1 month'), base_month + INTERVAL '1 month')::date;
    month_cursor := min_month;

    WHILE month_cursor <= max_month LOOP
      next_month := (month_cursor + INTERVAL '1 month')::date;
      partition_name := 'analytics_y' || to_char(month_cursor, 'YYYY') || 'm' || to_char(month_cursor, 'MM');

      -- Crea le partizioni mensili con convenzione analytics_yYYYYmMM.
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.analytics_partitioned FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        month_cursor,
        next_month
      );

      month_cursor := next_month;
    END LOOP;

    -- Copia tutti i dati prima dello scambio dei nomi.
    INSERT INTO public.analytics_partitioned SELECT * FROM public.analytics;

    -- Scambia la tabella originale con il padre partizionato nella schema public.
    ALTER TABLE public.analytics RENAME TO analytics_old;
    ALTER TABLE public.analytics_partitioned RENAME TO analytics;

    -- Rimuove la tabella non partizionata solo dopo la copia completa riuscita.
    DROP TABLE public.analytics_old;
  ELSE
    -- Se analytics e' gia' partizionata, garantisce comunque le tre partizioni operative richieste.
    month_cursor := (base_month - INTERVAL '1 month')::date;

    WHILE month_cursor <= (base_month + INTERVAL '1 month')::date LOOP
      next_month := (month_cursor + INTERVAL '1 month')::date;
      partition_name := 'analytics_y' || to_char(month_cursor, 'YYYY') || 'm' || to_char(month_cursor, 'MM');

      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.analytics FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        month_cursor,
        next_month
      );

      month_cursor := next_month;
    END LOOP;
  END IF;
END;
$$;

-- Sezione 4: crea indici v2 sul padre partizionato, propagati alle partizioni.
CREATE INDEX IF NOT EXISTS idx_analytics_website_created_v2
  ON public.analytics (website_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_event_created_v2
  ON public.analytics (event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_analytics_path_created_v2
  ON public.analytics (page_path, created_at);

CREATE INDEX IF NOT EXISTS idx_analytics_session_created_v2
  ON public.analytics (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_analytics_visit_created_v2
  ON public.analytics (visit_id, created_at);

-- Sezione 5: funzione di servizio per creare la partizione del prossimo mese.
CREATE OR REPLACE FUNCTION public.analytics_create_next_partition()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  first_of_next_month DATE := (date_trunc('month', NOW()) + INTERVAL '1 month')::date;
  first_of_month_after_next DATE := (date_trunc('month', NOW()) + INTERVAL '2 months')::date;
  partition_name TEXT := 'analytics_y' || to_char((date_trunc('month', NOW()) + INTERVAL '1 month')::date, 'YYYY') || 'm' || to_char((date_trunc('month', NOW()) + INTERVAL '1 month')::date, 'MM');
BEGIN
  IF to_regclass(format('public.%I', partition_name)) IS NOT NULL THEN
    RETURN 'already_exists';
  END IF;

  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.analytics FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    first_of_next_month,
    first_of_month_after_next
  );

  RETURN partition_name;
END;
$$;

-- Sezione 6: definisce obiettivi analytics configurabili per pageview, eventi e funnel.
CREATE TABLE IF NOT EXISTS public.analytics_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('pageview', 'event', 'funnel')),
  conditions JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indice parziale per trovare rapidamente solo gli obiettivi attivi.
CREATE INDEX IF NOT EXISTS idx_analytics_goals_active
  ON public.analytics_goals (active)
  WHERE active = TRUE;

-- Sezione 7: retention per analytics partizionata, con drop delle partizioni oltre 13 mesi.
CREATE OR REPLACE FUNCTION public.purge_old_analytics()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  partition_record RECORD;
  upper_bound_text TEXT;
  upper_bound TIMESTAMPTZ;
  estimated_rows INTEGER;
  dropped_rows INTEGER := 0;
BEGIN
  FOR partition_record IN
    SELECT
      child_ns.nspname AS schema_name,
      child.relname AS table_name,
      child.reltuples AS estimated_tuples,
      pg_get_expr(child.relpartbound, child.oid) AS partition_bound
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    WHERE parent_ns.nspname = 'public'
      AND parent.relname = 'analytics'
      AND child.relkind IN ('r', 'p')
  LOOP
    -- Estrae il limite superiore da "FOR VALUES FROM (...) TO (...)" e ignora DEFAULT/MAXVALUE.
    upper_bound_text := substring(partition_record.partition_bound FROM 'TO \(''([^'']+)''\)');

    IF upper_bound_text IS NULL THEN
      CONTINUE;
    END IF;

    upper_bound := upper_bound_text::timestamptz;

    IF upper_bound < NOW() - INTERVAL '13 months' THEN
      estimated_rows := GREATEST(COALESCE(partition_record.estimated_tuples, 0), 0)::INTEGER;
      dropped_rows := dropped_rows + estimated_rows;

      -- Sgancia e rimuove la partizione obsoleta invece di cancellare riga per riga.
      EXECUTE format(
        'ALTER TABLE public.analytics DETACH PARTITION %I.%I',
        partition_record.schema_name,
        partition_record.table_name
      );

      EXECUTE format(
        'DROP TABLE %I.%I',
        partition_record.schema_name,
        partition_record.table_name
      );
    END IF;
  END LOOP;

  RETURN dropped_rows;
END;
$$;

-- Sezione 8: run_data_retention() resta invariata perche' usa ancora purge_old_analytics() RETURNS INTEGER.

COMMIT;
