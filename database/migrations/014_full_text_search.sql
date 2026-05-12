-- Migration: 014_full_text_search.sql
-- Descrizione: Full-Text Search con PostgreSQL tsvector
-- Data: 2026-01-20

-- =====================================================
-- CONFIGURAZIONE ITALIAN TEXT SEARCH
-- =====================================================

-- Verifica se la configurazione italiana esiste
DO $$
BEGIN
  -- PostgreSQL ha già 'italian' come configurazione di default
  -- Verifichiamo che esista
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config WHERE cfgname = 'italian'
  ) THEN
    RAISE NOTICE 'Italian text search config not found, using simple';
  END IF;
END $$;

-- =====================================================
-- COLONNA TSVECTOR PER POSTS
-- =====================================================

-- Aggiungi colonna search_vector
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Indice GIN per ricerche veloci
CREATE INDEX IF NOT EXISTS idx_blog_posts_search_vector ON blog_posts USING GIN(search_vector);

-- Funzione per generare search_vector
CREATE OR REPLACE FUNCTION posts_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  -- content è TEXT, usato direttamente
  NEW.search_vector :=
    setweight(to_tsvector('italian', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('italian', COALESCE(NEW.excerpt, '')), 'B') ||
    setweight(to_tsvector('italian', COALESCE(NEW.content, '')), 'C') ||
    setweight(to_tsvector('italian', COALESCE(array_to_string(NEW.tags, ' '), '')), 'D');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger per aggiornamento automatico
DROP TRIGGER IF EXISTS blog_posts_search_vector_trigger ON blog_posts;
CREATE TRIGGER blog_posts_search_vector_trigger
  BEFORE INSERT OR UPDATE OF title, excerpt, content, tags ON blog_posts
  FOR EACH ROW
  EXECUTE FUNCTION posts_search_vector_update();

-- Aggiorna search_vector per post esistenti
UPDATE blog_posts SET search_vector = (
  setweight(to_tsvector('italian', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('italian', COALESCE(excerpt, '')), 'B') ||
  setweight(to_tsvector('italian', COALESCE(array_to_string(tags, ' '), '')), 'D')
);

-- =====================================================
-- COLONNA TSVECTOR PER PROJECTS (Portfolio)
-- =====================================================

ALTER TABLE projects ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_projects_search_vector ON projects USING GIN(search_vector);

CREATE OR REPLACE FUNCTION projects_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('italian', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('italian', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('italian', COALESCE(NEW.excerpt, '')), 'C') ||
    setweight(to_tsvector('italian', COALESCE(array_to_string(NEW.technologies, ' '), '')), 'D');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_search_vector_trigger ON projects;
CREATE TRIGGER projects_search_vector_trigger
  BEFORE INSERT OR UPDATE OF title, description, excerpt, technologies ON projects
  FOR EACH ROW
  EXECUTE FUNCTION projects_search_vector_update();

-- Aggiorna search_vector per progetti esistenti
UPDATE projects SET search_vector = (
  setweight(to_tsvector('italian', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('italian', COALESCE(description, '')), 'B') ||
  setweight(to_tsvector('italian', COALESCE(excerpt, '')), 'C') ||
  setweight(to_tsvector('italian', COALESCE(array_to_string(technologies, ' '), '')), 'D')
);

-- =====================================================
-- COLONNA TSVECTOR PER CUSTOMERS
-- =====================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_customers_search_vector ON customers USING GIN(search_vector);

CREATE OR REPLACE FUNCTION customers_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', COALESCE(NEW.contact_name, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.company_name, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.email, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(NEW.phone, '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(NEW.billing_address->>'city', '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(NEW.notes, '')), 'D');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_search_vector_trigger ON customers;
CREATE TRIGGER customers_search_vector_trigger
  BEFORE INSERT OR UPDATE OF contact_name, company_name, email, phone, billing_address, notes ON customers
  FOR EACH ROW
  EXECUTE FUNCTION customers_search_vector_update();

-- Aggiorna per clienti esistenti
UPDATE customers SET search_vector = (
  setweight(to_tsvector('simple', COALESCE(contact_name, '')), 'A') ||
  setweight(to_tsvector('simple', COALESCE(company_name, '')), 'A') ||
  setweight(to_tsvector('simple', COALESCE(email, '')), 'B')
);

-- =====================================================
-- FUNZIONI DI RICERCA
-- =====================================================

-- Ricerca blog posts
CREATE OR REPLACE FUNCTION search_posts(
  p_query TEXT,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0,
  p_status TEXT DEFAULT 'published'
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  slug TEXT,
  excerpt TEXT,
  cover_image TEXT,
  published_at TIMESTAMPTZ,
  tags TEXT[],
  rank REAL,
  headline TEXT
) AS $$
DECLARE
  v_tsquery tsquery;
BEGIN
  -- Converti query in tsquery con gestione errori
  BEGIN
    v_tsquery := websearch_to_tsquery('italian', p_query);
  EXCEPTION WHEN OTHERS THEN
    v_tsquery := plainto_tsquery('italian', p_query);
  END;

  RETURN QUERY
  SELECT
    p.id,
    p.title,
    p.slug,
    p.excerpt,
    p.cover_image,
    p.published_at,
    p.tags,
    ts_rank_cd(p.search_vector, v_tsquery) AS rank,
    ts_headline('italian', COALESCE(p.title, '') || ' ' || COALESCE(p.excerpt, ''),
      v_tsquery, 'StartSel=<mark>, StopSel=</mark>, MaxWords=50') AS headline
  FROM blog_posts p
  WHERE p.search_vector @@ v_tsquery
    AND (p_status IS NULL OR p.status = p_status)
  ORDER BY rank DESC, p.published_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$ LANGUAGE plpgsql STABLE;

-- Ricerca progetti
CREATE OR REPLACE FUNCTION search_projects(
  p_query TEXT,
  p_limit INTEGER DEFAULT 20,
  p_featured_only BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  slug TEXT,
  description TEXT,
  excerpt TEXT,
  cover_image TEXT,
  technologies TEXT[],
  rank REAL
) AS $$
DECLARE
  v_tsquery tsquery;
BEGIN
  BEGIN
    v_tsquery := websearch_to_tsquery('italian', p_query);
  EXCEPTION WHEN OTHERS THEN
    v_tsquery := plainto_tsquery('italian', p_query);
  END;

  RETURN QUERY
  SELECT
    pr.id,
    pr.title,
    pr.slug,
    pr.description,
    pr.excerpt,
    pr.cover_image,
    pr.technologies,
    ts_rank_cd(pr.search_vector, v_tsquery) AS rank
  FROM projects pr
  WHERE pr.search_vector @@ v_tsquery
    AND (NOT p_featured_only OR pr.is_featured = true)
  ORDER BY rank DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- Ricerca clienti (solo admin)
CREATE OR REPLACE FUNCTION search_customers(
  p_query TEXT,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  contact_name TEXT,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  city TEXT,
  rank REAL
) AS $$
DECLARE
  v_tsquery tsquery;
BEGIN
  -- Solo admin può cercare clienti
  IF NOT is_admin() THEN
    RETURN;
  END IF;

  BEGIN
    v_tsquery := websearch_to_tsquery('simple', p_query);
  EXCEPTION WHEN OTHERS THEN
    v_tsquery := plainto_tsquery('simple', p_query);
  END;

  RETURN QUERY
  SELECT
    c.id,
    c.contact_name,
    c.company_name,
    c.email,
    c.phone,
    c.billing_address->>'city' AS city,
    ts_rank_cd(c.search_vector, v_tsquery) AS rank
  FROM customers c
  WHERE c.search_vector @@ v_tsquery
  ORDER BY rank DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Ricerca globale (posts + projects)
CREATE OR REPLACE FUNCTION search_global(
  p_query TEXT,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  type TEXT,
  id UUID,
  title TEXT,
  slug TEXT,
  excerpt TEXT,
  image TEXT,
  rank REAL
) AS $$
DECLARE
  v_tsquery tsquery;
BEGIN
  BEGIN
    v_tsquery := websearch_to_tsquery('italian', p_query);
  EXCEPTION WHEN OTHERS THEN
    v_tsquery := plainto_tsquery('italian', p_query);
  END;

  RETURN QUERY
  (
    SELECT
      'post'::TEXT AS type,
      p.id,
      p.title,
      p.slug,
      p.excerpt,
      p.cover_image AS image,
      ts_rank_cd(p.search_vector, v_tsquery) AS rank
    FROM blog_posts p
    WHERE p.search_vector @@ v_tsquery
      AND p.status = 'published'
    ORDER BY rank DESC
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT
      'project'::TEXT AS type,
      pr.id,
      pr.title,
      pr.slug,
      pr.description AS excerpt,
      pr.cover_image AS image,
      ts_rank_cd(pr.search_vector, v_tsquery) AS rank
    FROM projects pr
    WHERE pr.search_vector @@ v_tsquery
    ORDER BY rank DESC
    LIMIT p_limit
  )
  ORDER BY rank DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;

-- =====================================================
-- SUGGERIMENTI AUTOCOMPLETE
-- =====================================================

CREATE OR REPLACE FUNCTION search_suggestions(
  p_query TEXT,
  p_limit INTEGER DEFAULT 5
)
RETURNS TABLE (
  suggestion TEXT,
  type TEXT
) AS $$
BEGIN
  RETURN QUERY
  (
    -- Titoli post che iniziano con query
    SELECT DISTINCT
      p.title AS suggestion,
      'post'::TEXT AS type
    FROM blog_posts p
    WHERE p.title ILIKE p_query || '%'
      AND p.status = 'published'
    LIMIT p_limit
  )
  UNION
  (
    -- Titoli progetti
    SELECT DISTINCT
      pr.title AS suggestion,
      'project'::TEXT AS type
    FROM projects pr
    WHERE pr.title ILIKE p_query || '%'
    LIMIT p_limit
  )
  UNION
  (
    -- Tags
    SELECT DISTINCT
      unnest(p.tags) AS suggestion,
      'tag'::TEXT AS type
    FROM blog_posts p
    WHERE EXISTS (
      SELECT 1 FROM unnest(p.tags) t WHERE t ILIKE p_query || '%'
    )
    LIMIT p_limit
  );
END;
$$ LANGUAGE plpgsql STABLE;
