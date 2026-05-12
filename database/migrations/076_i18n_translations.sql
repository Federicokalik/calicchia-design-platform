-- 076: i18n translations tables per projects + blog_posts
-- Pattern: tabelle _translations (EAV-style: project_id + locale + field_name + field_value).
-- Razionale: gestione naturale di traduzioni parziali (campo per campo) senza
-- dover gestire NULL su 17 colonne legacy. L'assenza di una row è il fallback IT.
--
-- Backfill: copia i dati esistenti in row locale='it' come canonical IT.
-- Le colonne legacy in `projects` e `blog_posts` restano (no breaking change),
-- e fungono da fallback IT quando una traduzione manca.

-- ─────────────────────────────────────────────────────────
-- projects_translations
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.projects_translations (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  locale VARCHAR(5) NOT NULL,
  field_name VARCHAR(64) NOT NULL,
  field_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, locale, field_name)
);

CREATE INDEX IF NOT EXISTS idx_projects_translations_locale
  ON public.projects_translations(locale);

CREATE INDEX IF NOT EXISTS idx_projects_translations_project
  ON public.projects_translations(project_id);

-- ─────────────────────────────────────────────────────────
-- blog_posts_translations
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blog_posts_translations (
  post_id UUID NOT NULL REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  locale VARCHAR(5) NOT NULL,
  field_name VARCHAR(64) NOT NULL,
  field_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, locale, field_name)
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_translations_locale
  ON public.blog_posts_translations(locale);

CREATE INDEX IF NOT EXISTS idx_blog_posts_translations_post
  ON public.blog_posts_translations(post_id);

-- ─────────────────────────────────────────────────────────
-- Backfill IT da colonne legacy projects → projects_translations
-- ─────────────────────────────────────────────────────────
-- Idempotente via ON CONFLICT DO NOTHING. Re-run sicuro.
INSERT INTO public.projects_translations (project_id, locale, field_name, field_value)
SELECT id, 'it', 'title', title
FROM public.projects
WHERE title IS NOT NULL AND title != ''
ON CONFLICT (project_id, locale, field_name) DO NOTHING;

INSERT INTO public.projects_translations (project_id, locale, field_name, field_value)
SELECT id, 'it', 'description', description
FROM public.projects
WHERE description IS NOT NULL AND description != ''
ON CONFLICT (project_id, locale, field_name) DO NOTHING;

INSERT INTO public.projects_translations (project_id, locale, field_name, field_value)
SELECT id, 'it', 'content', content
FROM public.projects
WHERE content IS NOT NULL AND content != ''
ON CONFLICT (project_id, locale, field_name) DO NOTHING;

INSERT INTO public.projects_translations (project_id, locale, field_name, field_value)
SELECT id, 'it', 'outcome', outcome
FROM public.projects
WHERE outcome IS NOT NULL AND outcome != ''
ON CONFLICT (project_id, locale, field_name) DO NOTHING;

INSERT INTO public.projects_translations (project_id, locale, field_name, field_value)
SELECT id, 'it', 'seo_title', seo_title
FROM public.projects
WHERE seo_title IS NOT NULL AND seo_title != ''
ON CONFLICT (project_id, locale, field_name) DO NOTHING;

INSERT INTO public.projects_translations (project_id, locale, field_name, field_value)
SELECT id, 'it', 'seo_description', seo_description
FROM public.projects
WHERE seo_description IS NOT NULL AND seo_description != ''
ON CONFLICT (project_id, locale, field_name) DO NOTHING;

-- ─────────────────────────────────────────────────────────
-- Backfill IT da colonne legacy blog_posts → blog_posts_translations
-- ─────────────────────────────────────────────────────────
INSERT INTO public.blog_posts_translations (post_id, locale, field_name, field_value)
SELECT id, 'it', 'title', title
FROM public.blog_posts
WHERE title IS NOT NULL AND title != ''
ON CONFLICT (post_id, locale, field_name) DO NOTHING;

INSERT INTO public.blog_posts_translations (post_id, locale, field_name, field_value)
SELECT id, 'it', 'excerpt', excerpt
FROM public.blog_posts
WHERE excerpt IS NOT NULL AND excerpt != ''
ON CONFLICT (post_id, locale, field_name) DO NOTHING;

INSERT INTO public.blog_posts_translations (post_id, locale, field_name, field_value)
SELECT id, 'it', 'content', content
FROM public.blog_posts
WHERE content IS NOT NULL AND content != ''
ON CONFLICT (post_id, locale, field_name) DO NOTHING;

-- ─────────────────────────────────────────────────────────
-- Trigger: auto-update updated_at su modifica field_value
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_translations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_projects_translations_updated_at ON public.projects_translations;
CREATE TRIGGER trg_projects_translations_updated_at
  BEFORE UPDATE ON public.projects_translations
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_translations_updated_at();

DROP TRIGGER IF EXISTS trg_blog_posts_translations_updated_at ON public.blog_posts_translations;
CREATE TRIGGER trg_blog_posts_translations_updated_at
  BEFORE UPDATE ON public.blog_posts_translations
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_translations_updated_at();

-- ─────────────────────────────────────────────────────────
-- Verifica integrità backfill (per validation post-migration)
-- ─────────────────────────────────────────────────────────
-- SELECT
--   (SELECT COUNT(*) FROM projects WHERE title IS NOT NULL) AS projects_with_title,
--   (SELECT COUNT(*) FROM projects_translations WHERE locale = 'it' AND field_name = 'title') AS translations_title_it;
-- Atteso: i due numeri devono coincidere.

COMMENT ON TABLE public.projects_translations IS
  'i18n translations per projects (EAV-style). locale=it è il canonical fallback. Aggiungere row per locale=en per traduzioni EN.';

COMMENT ON TABLE public.blog_posts_translations IS
  'i18n translations per blog_posts (EAV-style). locale=it è il canonical fallback.';
