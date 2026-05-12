-- ============================================
-- Blog AI Generation System
-- ============================================

-- Tabella configurazione generazione articoli
CREATE TABLE IF NOT EXISTS blog_generation_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_enabled BOOLEAN DEFAULT false,

  -- Topic settings
  topics JSONB DEFAULT '[]'::jsonb,
  excluded_topics JSONB DEFAULT '[]'::jsonb,

  -- AI Models (selezionabili da admin)
  perplexity_model TEXT DEFAULT 'llama-3.1-sonar-large-128k-online',
  openai_model TEXT DEFAULT 'gpt-4o',

  -- Cover image settings
  cover_provider TEXT DEFAULT 'none' CHECK (cover_provider IN ('none', 'dalle', 'unsplash')),
  dalle_model TEXT DEFAULT 'dall-e-3',
  unsplash_query_template TEXT DEFAULT '{topic} blog cover',

  -- Writing style
  writing_style TEXT DEFAULT 'professional' CHECK (writing_style IN ('professional', 'casual', 'technical', 'creative')),
  tone TEXT DEFAULT 'informative' CHECK (tone IN ('informative', 'educational', 'conversational', 'persuasive')),
  language TEXT DEFAULT 'it',

  -- Article parameters
  target_word_count INTEGER DEFAULT 1500,
  min_word_count INTEGER DEFAULT 800,
  max_word_count INTEGER DEFAULT 3000,

  -- Scheduling (pg_cron expression)
  cron_expression TEXT DEFAULT '0 9 * * 1', -- Default: ogni lunedi alle 9
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,

  -- Default metadata per articoli generati
  default_category TEXT,
  default_tags JSONB DEFAULT '[]'::jsonb,
  auto_publish BOOLEAN DEFAULT false,

  -- Custom prompts (nullable = usa default)
  research_prompt TEXT,
  content_prompt TEXT,
  image_prompt TEXT,

  -- Rate limits
  max_per_day INTEGER DEFAULT 1,
  max_per_week INTEGER DEFAULT 3,

  -- Stats
  total_generated INTEGER DEFAULT 0,
  total_published INTEGER DEFAULT 0,
  total_failed INTEGER DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabella log generazioni (per tracking e debug)
CREATE TABLE IF NOT EXISTS blog_generation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Riferimento al post generato (se successo)
  blog_post_id UUID REFERENCES blog_posts(id) ON DELETE SET NULL,

  -- Stato
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'researching', 'generating', 'generating_cover', 'completed', 'failed')),

  -- Input
  topic_used TEXT,
  config_snapshot JSONB, -- Snapshot della config usata

  -- Research phase
  research_query TEXT,
  research_result JSONB,
  research_model_used TEXT,
  research_tokens_used INTEGER,

  -- Generation phase
  generation_prompt TEXT,
  generation_model_used TEXT,
  generation_tokens_used INTEGER,

  -- Cover phase
  cover_provider_used TEXT,
  cover_url TEXT,

  -- Output
  generated_title TEXT,
  generated_slug TEXT,
  generated_word_count INTEGER,

  -- Error tracking
  error_message TEXT,
  error_details JSONB,
  error_phase TEXT CHECK (error_phase IN ('research', 'generation', 'cover', 'saving', 'webhook')),
  retry_count INTEGER DEFAULT 0,

  -- Timing
  started_at TIMESTAMPTZ,
  research_completed_at TIMESTAMPTZ,
  generation_completed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,

  -- Metadata
  triggered_by TEXT DEFAULT 'manual' CHECK (triggered_by IN ('manual', 'cron', 'api')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici per performance
CREATE INDEX IF NOT EXISTS idx_generation_logs_status ON blog_generation_logs(status);
CREATE INDEX IF NOT EXISTS idx_generation_logs_created ON blog_generation_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_logs_blog_post ON blog_generation_logs(blog_post_id);

-- Trigger per updated_at su config
CREATE OR REPLACE FUNCTION update_blog_generation_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blog_generation_config_updated_at ON blog_generation_config;
CREATE TRIGGER blog_generation_config_updated_at
  BEFORE UPDATE ON blog_generation_config
  FOR EACH ROW EXECUTE FUNCTION update_blog_generation_config_updated_at();

-- Inserisci configurazione default (singleton)
INSERT INTO blog_generation_config (id)
SELECT gen_random_uuid()
WHERE NOT EXISTS (SELECT 1 FROM blog_generation_config);

-- ============================================
-- Row Level Security
-- ============================================

ALTER TABLE blog_generation_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_generation_logs ENABLE ROW LEVEL SECURITY;

-- Config: solo admin puo leggere e modificare
CREATE POLICY "Admin can manage generation config"
  ON blog_generation_config
  FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

-- Logs: solo admin puo leggere
CREATE POLICY "Admin can read generation logs"
  ON blog_generation_logs
  FOR SELECT
  USING (is_admin());

-- Logs: insert permesso per API (service role)
CREATE POLICY "Service can insert generation logs"
  ON blog_generation_logs
  FOR INSERT
  WITH CHECK (true);

-- Logs: update permesso per API (service role)
CREATE POLICY "Service can update generation logs"
  ON blog_generation_logs
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- ============================================
-- pg_cron setup (opzionale - richiede estensione)
-- ============================================

-- Nota: Esegui questo manualmente se pg_cron e pg_net sono disponibili
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- CREATE EXTENSION IF NOT EXISTS pg_net;

-- Funzione per trigger HTTP (richiede pg_net)
-- CREATE OR REPLACE FUNCTION trigger_blog_generation_cron()
-- RETURNS void AS $$
-- DECLARE
--   config_row blog_generation_config%ROWTYPE;
--   cron_secret TEXT;
-- BEGIN
--   SELECT * INTO config_row FROM blog_generation_config LIMIT 1;
--
--   IF config_row.is_enabled THEN
--     -- Leggi il secret dalla config di Supabase
--     cron_secret := current_setting('app.settings.cron_secret', true);
--
--     -- Chiama l'endpoint di generazione
--     PERFORM net.http_post(
--       url := current_setting('app.settings.site_url', true) || '/api/blog/generate/scheduled',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'X-Cron-Secret', cron_secret
--       ),
--       body := jsonb_build_object('source', 'pg_cron')
--     );
--
--     -- Aggiorna last_run_at
--     UPDATE blog_generation_config
--     SET last_run_at = NOW()
--     WHERE id = config_row.id;
--   END IF;
-- END;
-- $$ LANGUAGE plpgsql SECURITY DEFINER;

-- Esempio di scheduling (da eseguire manualmente):
-- SELECT cron.schedule('blog-generation-weekly', '0 9 * * 1', 'SELECT trigger_blog_generation_cron()');

-- Per modificare lo schedule:
-- SELECT cron.alter_job(job_id, schedule := '0 9 * * 1');

-- Per disabilitare:
-- SELECT cron.unschedule('blog-generation-weekly');
