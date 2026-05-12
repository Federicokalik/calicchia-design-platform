-- ============================================
-- MIGRATION 004: Search, Newsletter, Versioning
-- ============================================

-- ============================================
-- 0. UTILITY FUNCTIONS
-- ============================================

-- Funzione per aggiornare updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 1. FULL-TEXT SEARCH
-- ============================================

-- Aggiungi colonna tsvector per ricerca full-text su blog_posts
ALTER TABLE blog_posts
ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Funzione per aggiornare il vettore di ricerca
CREATE OR REPLACE FUNCTION update_blog_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('italian', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('italian', COALESCE(NEW.excerpt, '')), 'B') ||
    setweight(to_tsvector('italian', COALESCE(
      regexp_replace(NEW.content, '<[^>]*>', '', 'g'), ''
    )), 'C') ||
    setweight(to_tsvector('italian', COALESCE(array_to_string(NEW.tags, ' '), '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger per aggiornare automaticamente
DROP TRIGGER IF EXISTS blog_posts_search_update ON blog_posts;
CREATE TRIGGER blog_posts_search_update
  BEFORE INSERT OR UPDATE OF title, excerpt, content, tags
  ON blog_posts
  FOR EACH ROW
  EXECUTE FUNCTION update_blog_search_vector();

-- Aggiorna i post esistenti
UPDATE blog_posts SET search_vector =
  setweight(to_tsvector('italian', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('italian', COALESCE(excerpt, '')), 'B') ||
  setweight(to_tsvector('italian', COALESCE(
    regexp_replace(content, '<[^>]*>', '', 'g'), ''
  )), 'C') ||
  setweight(to_tsvector('italian', COALESCE(array_to_string(tags, ' '), '')), 'B');

-- Indice GIN per ricerche veloci
CREATE INDEX IF NOT EXISTS blog_posts_search_idx ON blog_posts USING GIN(search_vector);

-- Stessa cosa per projects
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION update_project_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('italian', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('italian', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('italian', COALESCE(
      regexp_replace(NEW.content, '<[^>]*>', '', 'g'), ''
    )), 'C') ||
    setweight(to_tsvector('italian', COALESCE(array_to_string(NEW.technologies, ' '), '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_search_update ON projects;
CREATE TRIGGER projects_search_update
  BEFORE INSERT OR UPDATE OF title, description, content, technologies
  ON projects
  FOR EACH ROW
  EXECUTE FUNCTION update_project_search_vector();

UPDATE projects SET search_vector =
  setweight(to_tsvector('italian', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('italian', COALESCE(description, '')), 'B') ||
  setweight(to_tsvector('italian', COALESCE(
    regexp_replace(content, '<[^>]*>', '', 'g'), ''
  )), 'C') ||
  setweight(to_tsvector('italian', COALESCE(array_to_string(technologies, ' '), '')), 'B');

CREATE INDEX IF NOT EXISTS projects_search_idx ON projects USING GIN(search_vector);

-- ============================================
-- 2. NEWSLETTER SUBSCRIBERS
-- ============================================

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  confirmation_token UUID DEFAULT gen_random_uuid(),
  confirmed_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  source TEXT DEFAULT 'website', -- website, import, api
  tags JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici
CREATE INDEX IF NOT EXISTS newsletter_email_idx ON newsletter_subscribers(email);
CREATE INDEX IF NOT EXISTS newsletter_status_idx ON newsletter_subscribers(status);
CREATE INDEX IF NOT EXISTS newsletter_token_idx ON newsletter_subscribers(confirmation_token);

-- RLS
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can subscribe" ON newsletter_subscribers
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Admin full access newsletter" ON newsletter_subscribers
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

-- Trigger updated_at
CREATE TRIGGER newsletter_subscribers_updated
  BEFORE UPDATE ON newsletter_subscribers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 3. NEWSLETTER CAMPAIGNS (per invii)
-- ============================================

CREATE TABLE IF NOT EXISTS newsletter_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  preview_text TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  total_recipients INTEGER DEFAULT 0,
  total_sent INTEGER DEFAULT 0,
  total_opened INTEGER DEFAULT 0,
  total_clicked INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE newsletter_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access campaigns" ON newsletter_campaigns
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

-- ============================================
-- 4. VERSION HISTORY (per articoli)
-- ============================================

CREATE TABLE IF NOT EXISTS content_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL, -- 'blog_post', 'project', 'page'
  content_id UUID NOT NULL,
  version_number INTEGER NOT NULL,
  title TEXT,
  content TEXT,
  metadata JSONB DEFAULT '{}', -- altri campi come excerpt, tags, etc.
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(content_type, content_id, version_number)
);

CREATE INDEX IF NOT EXISTS content_versions_lookup_idx
  ON content_versions(content_type, content_id, version_number DESC);

ALTER TABLE content_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access versions" ON content_versions
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

-- Funzione per creare una versione automaticamente
CREATE OR REPLACE FUNCTION create_content_version()
RETURNS TRIGGER AS $$
DECLARE
  next_version INTEGER;
  content_type_val TEXT;
BEGIN
  -- Determina il tipo di contenuto
  content_type_val := TG_ARGV[0];

  -- Calcola il prossimo numero di versione
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO next_version
  FROM content_versions
  WHERE content_type = content_type_val AND content_id = OLD.id;

  -- Salva la versione precedente
  INSERT INTO content_versions (content_type, content_id, version_number, title, content, metadata)
  VALUES (
    content_type_val,
    OLD.id,
    next_version,
    OLD.title,
    OLD.content,
    jsonb_build_object(
      'excerpt', OLD.excerpt,
      'tags', OLD.tags,
      'is_published', OLD.is_published
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger per blog_posts
DROP TRIGGER IF EXISTS blog_posts_version_trigger ON blog_posts;
CREATE TRIGGER blog_posts_version_trigger
  BEFORE UPDATE OF title, content, excerpt, tags
  ON blog_posts
  FOR EACH ROW
  WHEN (OLD.content IS DISTINCT FROM NEW.content OR OLD.title IS DISTINCT FROM NEW.title)
  EXECUTE FUNCTION create_content_version('blog_post');

-- ============================================
-- 5. READING STATS (tempo lettura, progresso)
-- ============================================

-- Aggiungi colonna reading_time a blog_posts
ALTER TABLE blog_posts
ADD COLUMN IF NOT EXISTS reading_time_minutes INTEGER;

-- Funzione per calcolare tempo lettura
CREATE OR REPLACE FUNCTION calculate_reading_time()
RETURNS TRIGGER AS $$
DECLARE
  word_count INTEGER;
  words_per_minute INTEGER := 200; -- velocità media lettura italiano
BEGIN
  -- Conta parole (rimuovi HTML e conta)
  word_count := array_length(
    regexp_split_to_array(
      regexp_replace(COALESCE(NEW.content, ''), '<[^>]*>', '', 'g'),
      '\s+'
    ),
    1
  );

  NEW.reading_time_minutes := GREATEST(1, CEIL(word_count::float / words_per_minute));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blog_posts_reading_time ON blog_posts;
CREATE TRIGGER blog_posts_reading_time
  BEFORE INSERT OR UPDATE OF content
  ON blog_posts
  FOR EACH ROW
  EXECUTE FUNCTION calculate_reading_time();

-- Aggiorna post esistenti
UPDATE blog_posts SET reading_time_minutes = GREATEST(1, CEIL(
  array_length(
    regexp_split_to_array(
      regexp_replace(COALESCE(content, ''), '<[^>]*>', '', 'g'),
      '\s+'
    ),
    1
  )::float / 200
));

-- Tabella per tracciare progresso lettura
CREATE TABLE IF NOT EXISTS reading_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES blog_posts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, -- cookie/localStorage ID
  max_scroll_percent INTEGER DEFAULT 0,
  time_spent_seconds INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(post_id, session_id)
);

CREATE INDEX IF NOT EXISTS reading_progress_post_idx ON reading_progress(post_id);

ALTER TABLE reading_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can track reading" ON reading_progress
  FOR ALL TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 6. RELATED POSTS CACHE
-- ============================================

CREATE TABLE IF NOT EXISTS related_posts_cache (
  post_id UUID REFERENCES blog_posts(id) ON DELETE CASCADE,
  related_post_id UUID REFERENCES blog_posts(id) ON DELETE CASCADE,
  similarity_score FLOAT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (post_id, related_post_id)
);

CREATE INDEX IF NOT EXISTS related_posts_score_idx
  ON related_posts_cache(post_id, similarity_score DESC);

ALTER TABLE related_posts_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read related posts" ON related_posts_cache
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Admin manage related posts" ON related_posts_cache
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

-- ============================================
-- 7. SEO METADATA TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS seo_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL, -- 'blog_post', 'project', 'page'
  content_id UUID,
  path TEXT, -- per pagine statiche
  meta_title TEXT,
  meta_description TEXT,
  og_title TEXT,
  og_description TEXT,
  og_image TEXT,
  twitter_card TEXT DEFAULT 'summary_large_image',
  canonical_url TEXT,
  no_index BOOLEAN DEFAULT false,
  structured_data JSONB, -- JSON-LD
  keywords TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(content_type, content_id),
  UNIQUE(path)
);

ALTER TABLE seo_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read SEO" ON seo_metadata
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Admin manage SEO" ON seo_metadata
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

-- ============================================
-- 8. API RATE LIMITING
-- ============================================

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  hit_count INTEGER DEFAULT 1,
  window_start TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rate_limit_lookup_idx
  ON rate_limit_hits(ip_address, endpoint, window_start);

-- Funzione per pulire vecchi record
CREATE OR REPLACE FUNCTION cleanup_rate_limits()
RETURNS void AS $$
BEGIN
  DELETE FROM rate_limit_hits WHERE window_start < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 9. ANALYTICS ENHANCED
-- ============================================

-- Aggiungi colonne per analytics più dettagliate
ALTER TABLE analytics ADD COLUMN IF NOT EXISTS scroll_depth INTEGER;
ALTER TABLE analytics ADD COLUMN IF NOT EXISTS time_on_page INTEGER;
ALTER TABLE analytics ADD COLUMN IF NOT EXISTS is_bounce BOOLEAN;
ALTER TABLE analytics ADD COLUMN IF NOT EXISTS exit_page BOOLEAN;
ALTER TABLE analytics ADD COLUMN IF NOT EXISTS click_data JSONB;

-- Tabella per aggregazioni giornaliere (performance)
CREATE TABLE IF NOT EXISTS analytics_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  page_path TEXT NOT NULL,
  page_views INTEGER DEFAULT 0,
  unique_visitors INTEGER DEFAULT 0,
  avg_time_on_page INTEGER DEFAULT 0,
  avg_scroll_depth INTEGER DEFAULT 0,
  bounce_rate FLOAT DEFAULT 0,

  UNIQUE(date, page_path)
);

CREATE INDEX IF NOT EXISTS analytics_daily_date_idx ON analytics_daily(date DESC);

ALTER TABLE analytics_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin read analytics_daily" ON analytics_daily
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin')
  );

-- ============================================
-- 10. AGGIORNA TIPI DATABASE.TS
-- ============================================
-- Ricordati di rigenerare i tipi TypeScript!
