-- Migration: 017_content_versioning.sql
-- Descrizione: Content Versioning per Blog Posts e Projects
-- Data: 2026-01-20

-- =====================================================
-- TABELLA BLOG POST REVISIONS
-- =====================================================

CREATE TABLE IF NOT EXISTS blog_post_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,

  -- Revision info
  revision_number INTEGER NOT NULL,
  is_current BOOLEAN DEFAULT false,

  -- Content snapshot
  title TEXT,
  slug TEXT,
  excerpt TEXT,
  content TEXT,
  cover_image TEXT,
  tags TEXT[],
  category TEXT,
  status TEXT,

  -- Metadata
  changed_fields TEXT[], -- Lista campi modificati
  change_summary TEXT,   -- Descrizione modifiche
  created_by UUID REFERENCES profiles(id),

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici
CREATE INDEX idx_blog_post_revisions_post ON blog_post_revisions(post_id);
CREATE INDEX idx_blog_post_revisions_current ON blog_post_revisions(post_id, is_current) WHERE is_current = true;
CREATE UNIQUE INDEX idx_blog_post_revisions_number ON blog_post_revisions(post_id, revision_number);

-- =====================================================
-- TABELLA PROJECT REVISIONS
-- =====================================================

CREATE TABLE IF NOT EXISTS project_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Revision info
  revision_number INTEGER NOT NULL,
  is_current BOOLEAN DEFAULT false,

  -- Content snapshot (matching projects table columns)
  title TEXT,
  slug TEXT,
  description TEXT,
  content TEXT,
  excerpt TEXT,
  cover_image TEXT,
  gallery JSONB,
  technologies TEXT[],
  live_url TEXT,
  repo_url TEXT,
  is_featured BOOLEAN,
  is_published BOOLEAN,
  display_order INTEGER,

  -- Metadata
  changed_fields TEXT[],
  change_summary TEXT,
  created_by UUID REFERENCES profiles(id),

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici
CREATE INDEX idx_project_revisions_project ON project_revisions(project_id);
CREATE INDEX idx_project_revisions_current ON project_revisions(project_id, is_current) WHERE is_current = true;
CREATE UNIQUE INDEX idx_project_revisions_number ON project_revisions(project_id, revision_number);

-- =====================================================
-- COLONNE VERSIONING SU BLOG_POSTS E PROJECTS
-- =====================================================

ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS current_revision_id UUID;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS revision_count INTEGER DEFAULT 1;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_revision_id UUID;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS revision_count INTEGER DEFAULT 1;

-- =====================================================
-- FUNZIONE: Crea revisione blog post
-- =====================================================

CREATE OR REPLACE FUNCTION create_blog_post_revision()
RETURNS TRIGGER AS $$
DECLARE
  v_revision_number INTEGER;
  v_changed_fields TEXT[];
  v_revision_id UUID;
BEGIN
  -- Solo se ci sono modifiche ai contenuti
  IF TG_OP = 'UPDATE' THEN
    -- Controlla quali campi sono cambiati
    v_changed_fields := ARRAY[]::TEXT[];

    IF OLD.title IS DISTINCT FROM NEW.title THEN
      v_changed_fields := array_append(v_changed_fields, 'title');
    END IF;
    IF OLD.excerpt IS DISTINCT FROM NEW.excerpt THEN
      v_changed_fields := array_append(v_changed_fields, 'excerpt');
    END IF;
    IF OLD.content IS DISTINCT FROM NEW.content THEN
      v_changed_fields := array_append(v_changed_fields, 'content');
    END IF;
    IF OLD.cover_image IS DISTINCT FROM NEW.cover_image THEN
      v_changed_fields := array_append(v_changed_fields, 'cover_image');
    END IF;
    IF OLD.tags IS DISTINCT FROM NEW.tags THEN
      v_changed_fields := array_append(v_changed_fields, 'tags');
    END IF;
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      v_changed_fields := array_append(v_changed_fields, 'status');
    END IF;

    -- Se nessun campo contenuto è cambiato, skip
    IF array_length(v_changed_fields, 1) IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    -- INSERT: tutti i campi sono "nuovi"
    v_changed_fields := ARRAY['title', 'content', 'status'];
  END IF;

  -- Calcola numero revisione
  SELECT COALESCE(MAX(revision_number), 0) + 1
  INTO v_revision_number
  FROM blog_post_revisions
  WHERE post_id = NEW.id;

  -- Disattiva revisione precedente
  UPDATE blog_post_revisions
  SET is_current = false
  WHERE post_id = NEW.id AND is_current = true;

  -- Crea nuova revisione
  INSERT INTO blog_post_revisions (
    post_id,
    revision_number,
    is_current,
    title,
    slug,
    excerpt,
    content,
    cover_image,
    tags,
    category,
    status,
    changed_fields,
    created_by
  )
  VALUES (
    NEW.id,
    v_revision_number,
    true,
    NEW.title,
    NEW.slug,
    NEW.excerpt,
    NEW.content,
    NEW.cover_image,
    NEW.tags,
    NEW.category,
    NEW.status,
    v_changed_fields,
    auth.uid()
  )
  RETURNING id INTO v_revision_id;

  -- Aggiorna contatore e riferimento
  NEW.current_revision_id := v_revision_id;
  NEW.revision_count := v_revision_number;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- FUNZIONE: Crea revisione project
-- =====================================================

CREATE OR REPLACE FUNCTION create_project_revision()
RETURNS TRIGGER AS $$
DECLARE
  v_revision_number INTEGER;
  v_changed_fields TEXT[];
  v_revision_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_changed_fields := ARRAY[]::TEXT[];

    IF OLD.title IS DISTINCT FROM NEW.title THEN
      v_changed_fields := array_append(v_changed_fields, 'title');
    END IF;
    IF OLD.description IS DISTINCT FROM NEW.description THEN
      v_changed_fields := array_append(v_changed_fields, 'description');
    END IF;
    IF OLD.content IS DISTINCT FROM NEW.content THEN
      v_changed_fields := array_append(v_changed_fields, 'content');
    END IF;
    IF OLD.technologies IS DISTINCT FROM NEW.technologies THEN
      v_changed_fields := array_append(v_changed_fields, 'technologies');
    END IF;
    IF OLD.cover_image IS DISTINCT FROM NEW.cover_image THEN
      v_changed_fields := array_append(v_changed_fields, 'cover_image');
    END IF;
    IF OLD.gallery IS DISTINCT FROM NEW.gallery THEN
      v_changed_fields := array_append(v_changed_fields, 'gallery');
    END IF;

    IF array_length(v_changed_fields, 1) IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    v_changed_fields := ARRAY['title', 'description'];
  END IF;

  SELECT COALESCE(MAX(revision_number), 0) + 1
  INTO v_revision_number
  FROM project_revisions
  WHERE project_id = NEW.id;

  UPDATE project_revisions
  SET is_current = false
  WHERE project_id = NEW.id AND is_current = true;

  INSERT INTO project_revisions (
    project_id,
    revision_number,
    is_current,
    title,
    slug,
    description,
    content,
    excerpt,
    cover_image,
    gallery,
    technologies,
    live_url,
    repo_url,
    is_featured,
    is_published,
    display_order,
    changed_fields,
    created_by
  )
  VALUES (
    NEW.id,
    v_revision_number,
    true,
    NEW.title,
    NEW.slug,
    NEW.description,
    NEW.content,
    NEW.excerpt,
    NEW.cover_image,
    NEW.gallery,
    NEW.technologies,
    NEW.live_url,
    NEW.repo_url,
    NEW.is_featured,
    NEW.is_published,
    NEW.display_order,
    v_changed_fields,
    auth.uid()
  )
  RETURNING id INTO v_revision_id;

  NEW.current_revision_id := v_revision_id;
  NEW.revision_count := v_revision_number;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- TRIGGERS
-- =====================================================

DROP TRIGGER IF EXISTS blog_post_versioning_trigger ON blog_posts;
CREATE TRIGGER blog_post_versioning_trigger
  BEFORE INSERT OR UPDATE ON blog_posts
  FOR EACH ROW
  EXECUTE FUNCTION create_blog_post_revision();

DROP TRIGGER IF EXISTS project_versioning_trigger ON projects;
CREATE TRIGGER project_versioning_trigger
  BEFORE INSERT OR UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION create_project_revision();

-- =====================================================
-- FUNZIONE: Ripristina revisione blog post
-- =====================================================

CREATE OR REPLACE FUNCTION restore_blog_post_revision(
  p_post_id UUID,
  p_revision_id UUID
)
RETURNS UUID AS $$
DECLARE
  v_revision blog_post_revisions%ROWTYPE;
BEGIN
  -- Recupera la revisione
  SELECT * INTO v_revision
  FROM blog_post_revisions
  WHERE id = p_revision_id AND post_id = p_post_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Revisione non trovata';
  END IF;

  -- Aggiorna il post (il trigger creerà una nuova revisione)
  UPDATE blog_posts SET
    title = v_revision.title,
    excerpt = v_revision.excerpt,
    content = v_revision.content,
    cover_image = v_revision.cover_image,
    tags = v_revision.tags,
    category = v_revision.category,
    updated_at = NOW()
  WHERE id = p_post_id;

  -- Aggiorna il change_summary della nuova revisione
  UPDATE blog_post_revisions
  SET change_summary = 'Ripristinato da revisione #' || v_revision.revision_number
  WHERE post_id = p_post_id AND is_current = true;

  RETURN p_post_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- FUNZIONE: Ripristina revisione project
-- =====================================================

CREATE OR REPLACE FUNCTION restore_project_revision(
  p_project_id UUID,
  p_revision_id UUID
)
RETURNS UUID AS $$
DECLARE
  v_revision project_revisions%ROWTYPE;
BEGIN
  SELECT * INTO v_revision
  FROM project_revisions
  WHERE id = p_revision_id AND project_id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Revisione non trovata';
  END IF;

  UPDATE projects SET
    title = v_revision.title,
    description = v_revision.description,
    content = v_revision.content,
    excerpt = v_revision.excerpt,
    technologies = v_revision.technologies,
    cover_image = v_revision.cover_image,
    gallery = v_revision.gallery,
    live_url = v_revision.live_url,
    repo_url = v_revision.repo_url,
    is_featured = v_revision.is_featured,
    is_published = v_revision.is_published,
    display_order = v_revision.display_order,
    updated_at = NOW()
  WHERE id = p_project_id;

  UPDATE project_revisions
  SET change_summary = 'Ripristinato da revisione #' || v_revision.revision_number
  WHERE project_id = p_project_id AND is_current = true;

  RETURN p_project_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- FUNZIONE: Confronta revisioni
-- =====================================================

CREATE OR REPLACE FUNCTION compare_blog_post_revisions(
  p_revision_1_id UUID,
  p_revision_2_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_rev1 blog_post_revisions%ROWTYPE;
  v_rev2 blog_post_revisions%ROWTYPE;
  v_diff JSONB;
BEGIN
  SELECT * INTO v_rev1 FROM blog_post_revisions WHERE id = p_revision_1_id;
  SELECT * INTO v_rev2 FROM blog_post_revisions WHERE id = p_revision_2_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Revisione non trovata';
  END IF;

  v_diff := jsonb_build_object(
    'revision_1', v_rev1.revision_number,
    'revision_2', v_rev2.revision_number,
    'changes', jsonb_build_object(
      'title', CASE WHEN v_rev1.title != v_rev2.title
        THEN jsonb_build_object('old', v_rev1.title, 'new', v_rev2.title)
        ELSE NULL END,
      'excerpt', CASE WHEN v_rev1.excerpt != v_rev2.excerpt
        THEN jsonb_build_object('old', v_rev1.excerpt, 'new', v_rev2.excerpt)
        ELSE NULL END,
      'content', CASE WHEN v_rev1.content != v_rev2.content
        THEN true
        ELSE NULL END,
      'status', CASE WHEN v_rev1.status != v_rev2.status
        THEN jsonb_build_object('old', v_rev1.status, 'new', v_rev2.status)
        ELSE NULL END,
      'tags', CASE WHEN v_rev1.tags != v_rev2.tags
        THEN jsonb_build_object('old', to_jsonb(v_rev1.tags), 'new', to_jsonb(v_rev2.tags))
        ELSE NULL END
    )
  );

  RETURN v_diff;
END;
$$ LANGUAGE plpgsql STABLE;

-- =====================================================
-- VISTE
-- =====================================================

CREATE OR REPLACE VIEW blog_post_revision_history AS
SELECT
  pr.id,
  pr.post_id,
  pr.revision_number,
  pr.is_current,
  pr.title,
  pr.status,
  pr.changed_fields,
  pr.change_summary,
  pr.created_at,
  p.email AS created_by_email,
  p.full_name AS created_by_name
FROM blog_post_revisions pr
LEFT JOIN profiles p ON p.id = pr.created_by
ORDER BY pr.post_id, pr.revision_number DESC;

CREATE OR REPLACE VIEW project_revision_history AS
SELECT
  pr.id,
  pr.project_id,
  pr.revision_number,
  pr.is_current,
  pr.title,
  pr.changed_fields,
  pr.change_summary,
  pr.created_at,
  p.email AS created_by_email,
  p.full_name AS created_by_name
FROM project_revisions pr
LEFT JOIN profiles p ON p.id = pr.created_by
ORDER BY pr.project_id, pr.revision_number DESC;

-- =====================================================
-- RLS
-- =====================================================

ALTER TABLE blog_post_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_revisions ENABLE ROW LEVEL SECURITY;

-- Admin full access
DROP POLICY IF EXISTS "Admin full access blog_post_revisions" ON blog_post_revisions;
CREATE POLICY "Admin full access blog_post_revisions" ON blog_post_revisions
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "Admin full access project_revisions" ON project_revisions;
CREATE POLICY "Admin full access project_revisions" ON project_revisions
  FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- =====================================================
-- GRANTS
-- =====================================================

GRANT SELECT ON blog_post_revision_history TO authenticated;
GRANT SELECT ON project_revision_history TO authenticated;
