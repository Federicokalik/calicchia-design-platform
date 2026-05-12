-- ============================================
-- Blog Generation Pipeline V2 + Scheduling
-- ============================================
--
-- NUOVO FLOW DI GENERAZIONE ARTICOLI:
-- ┌─────────────────────────────────────────────────────────────┐
-- │  1. RESEARCH (Perplexity sonar/sonar-pro)                   │
-- │     → Ricerca online sul topic                              │
-- │     → Output: summary, keyPoints, sections, sources         │
-- ├─────────────────────────────────────────────────────────────┤
-- │  2. WRITE (OpenAI GPT-4o)                                   │
-- │     → Scrive articolo basato sulla ricerca                  │
-- │     → Inserisce placeholder [IMAGE:descrizione]             │
-- │     → Output: title, slug, content, tags                    │
-- ├─────────────────────────────────────────────────────────────┤
-- │  3. COVER IMAGE (DALL-E / Z-Image / Unsplash)               │
-- │     → Genera immagine di copertina                          │
-- │     → Salva su S3                                           │
-- ├─────────────────────────────────────────────────────────────┤
-- │  4. INLINE IMAGES (DALL-E / Z-Image / Unsplash)             │
-- │     → Genera immagini per ogni placeholder                  │
-- │     → Sostituisce [IMAGE:...] con ![alt](url)               │
-- │     → Salva su S3                                           │
-- ├─────────────────────────────────────────────────────────────┤
-- │  5. SAVE TO DATABASE                                        │
-- │     → Salva articolo in blog_posts                          │
-- │     → Status: draft o published (se auto_publish)           │
-- └─────────────────────────────────────────────────────────────┘
--
-- SCHEDULING:
-- - Frequenza: daily, every_2_days, every_3_days, weekly, biweekly, monthly
-- - Orario: HH:MM in timezone specificato
-- - Giorni: array di giorni (0=Dom, 1=Lun, ..., 6=Sab)
-- - Auto-publish: pubblica subito o dopo N ore
--
-- ============================================

-- Aggiungi colonne per il nuovo scheduling
ALTER TABLE blog_generation_config
  ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS schedule_frequency TEXT DEFAULT 'weekly'
    CHECK (schedule_frequency IN ('daily', 'every_2_days', 'every_3_days', 'weekly', 'biweekly', 'monthly')),
  ADD COLUMN IF NOT EXISTS schedule_time TIME DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS schedule_timezone TEXT DEFAULT 'Europe/Rome',
  ADD COLUMN IF NOT EXISTS schedule_days INTEGER[] DEFAULT ARRAY[1, 3, 5], -- 0=Dom, 1=Lun, ..., 6=Sab
  ADD COLUMN IF NOT EXISTS schedule_auto_publish BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS schedule_publish_delay_hours INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS schedule_last_run TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS schedule_next_run TIMESTAMPTZ;

-- Aggiungi colonne per il nuovo pipeline v2
ALTER TABLE blog_generation_config
  ADD COLUMN IF NOT EXISTS zimage_model TEXT DEFAULT 'z-image-turbo',
  ADD COLUMN IF NOT EXISTS include_inline_images BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_inline_images INTEGER DEFAULT 3,
  ADD COLUMN IF NOT EXISTS research_depth TEXT DEFAULT 'detailed'
    CHECK (research_depth IN ('basic', 'detailed', 'comprehensive'));

-- Aggiorna il check constraint per cover_provider (aggiungi zimage)
ALTER TABLE blog_generation_config
  DROP CONSTRAINT IF EXISTS blog_generation_config_cover_provider_check;

ALTER TABLE blog_generation_config
  ADD CONSTRAINT blog_generation_config_cover_provider_check
  CHECK (cover_provider IN ('none', 'dalle', 'unsplash', 'zimage'));

-- Aggiorna perplexity_model default
UPDATE blog_generation_config
SET perplexity_model = 'sonar-pro'
WHERE perplexity_model = 'llama-3.1-sonar-large-128k-online';

-- Aggiungi nuove colonne ai logs per inline images
ALTER TABLE blog_generation_logs
  ADD COLUMN IF NOT EXISTS inline_images_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inline_images_urls TEXT[];

-- Aggiungi status per generazione immagini inline
ALTER TABLE blog_generation_logs
  DROP CONSTRAINT IF EXISTS blog_generation_logs_status_check;

ALTER TABLE blog_generation_logs
  ADD CONSTRAINT blog_generation_logs_status_check
  CHECK (status IN ('pending', 'researching', 'generating', 'generating_cover', 'generating_images', 'completed', 'failed'));

-- Aggiungi triggered_by = 'scheduled'
ALTER TABLE blog_generation_logs
  DROP CONSTRAINT IF EXISTS blog_generation_logs_triggered_by_check;

ALTER TABLE blog_generation_logs
  ADD CONSTRAINT blog_generation_logs_triggered_by_check
  CHECK (triggered_by IN ('manual', 'cron', 'api', 'scheduled'));

-- ============================================
-- Funzione per calcolare il prossimo run
-- ============================================

CREATE OR REPLACE FUNCTION calculate_next_blog_run(
  p_frequency TEXT,
  p_time TIME,
  p_timezone TEXT,
  p_days INTEGER[],
  p_from_date TIMESTAMPTZ DEFAULT NOW()
) RETURNS TIMESTAMPTZ AS $$
DECLARE
  next_run TIMESTAMPTZ;
  local_time TIMESTAMPTZ;
  day_of_week INTEGER;
BEGIN
  -- Converti l'orario locale
  local_time := (p_from_date AT TIME ZONE p_timezone)::DATE + p_time;
  next_run := local_time AT TIME ZONE p_timezone;

  -- Se l'orario è già passato oggi, parti da domani
  IF next_run <= p_from_date THEN
    next_run := next_run + INTERVAL '1 day';
  END IF;

  CASE p_frequency
    WHEN 'daily' THEN
      -- Già impostato
      NULL;
    WHEN 'every_2_days' THEN
      next_run := next_run + INTERVAL '1 day';
    WHEN 'every_3_days' THEN
      next_run := next_run + INTERVAL '2 days';
    WHEN 'weekly' THEN
      -- Trova il prossimo giorno nella lista
      IF p_days IS NOT NULL AND array_length(p_days, 1) > 0 THEN
        day_of_week := EXTRACT(DOW FROM next_run)::INTEGER;
        WHILE NOT (day_of_week = ANY(p_days)) LOOP
          next_run := next_run + INTERVAL '1 day';
          day_of_week := EXTRACT(DOW FROM next_run)::INTEGER;
        END LOOP;
      END IF;
    WHEN 'biweekly' THEN
      next_run := next_run + INTERVAL '14 days';
    WHEN 'monthly' THEN
      next_run := date_trunc('month', next_run) + INTERVAL '1 month';
  END CASE;

  RETURN next_run;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================
-- Trigger per aggiornare next_run quando cambia la config
-- ============================================

CREATE OR REPLACE FUNCTION update_blog_schedule_next_run()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.schedule_enabled AND (
    NEW.schedule_frequency IS DISTINCT FROM OLD.schedule_frequency OR
    NEW.schedule_time IS DISTINCT FROM OLD.schedule_time OR
    NEW.schedule_days IS DISTINCT FROM OLD.schedule_days OR
    NEW.schedule_timezone IS DISTINCT FROM OLD.schedule_timezone OR
    NEW.schedule_enabled IS DISTINCT FROM OLD.schedule_enabled
  ) THEN
    NEW.schedule_next_run := calculate_next_blog_run(
      NEW.schedule_frequency,
      NEW.schedule_time,
      NEW.schedule_timezone,
      NEW.schedule_days
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blog_config_update_next_run ON blog_generation_config;
CREATE TRIGGER blog_config_update_next_run
  BEFORE UPDATE ON blog_generation_config
  FOR EACH ROW EXECUTE FUNCTION update_blog_schedule_next_run();

-- ============================================
-- Vista per monitoraggio scheduling
-- ============================================

CREATE OR REPLACE VIEW blog_schedule_status AS
SELECT
  id,
  schedule_enabled,
  schedule_frequency,
  schedule_time::TEXT,
  schedule_timezone,
  schedule_days,
  schedule_auto_publish,
  schedule_publish_delay_hours,
  schedule_last_run,
  schedule_next_run,
  CASE
    WHEN schedule_next_run IS NULL THEN 'not_scheduled'
    WHEN schedule_next_run <= NOW() THEN 'due'
    ELSE 'scheduled'
  END AS status,
  CASE
    WHEN schedule_next_run IS NOT NULL
    THEN schedule_next_run - NOW()
  END AS time_until_next,
  jsonb_array_length(COALESCE(topics, '[]'::jsonb)) AS topics_count,
  total_generated,
  total_published,
  total_failed
FROM blog_generation_config;

-- Commento: per visualizzare lo stato
-- SELECT * FROM blog_schedule_status;
