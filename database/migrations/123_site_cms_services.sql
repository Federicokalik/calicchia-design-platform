-- Audit C-013/C-014 — Services catalog CMS table (PR22, final dataset)
--
-- Lightweight catalog only — the SHORT shape from data/services.ts:
--   slug, title, lead, deliverables[], icon, category, locale
--
-- ServiceDetail (long-form awareness/process/storyline/faq/features in
-- data/services-detail.ts + services-content/<slug>.ts) stays file-based
-- intentionally: the schema is too rich and voice-tuned to be edited
-- safely from a generic admin form. Migrating it would require a
-- structured per-section editor (Tiptap for the prose blocks, JSON for
-- arrays). Tracked as future work; not in this PR.
--
-- (slug, locale) unique so the same matrix service has IT + EN cards.

CREATE TABLE IF NOT EXISTS public.site_services (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  locale        TEXT NOT NULL DEFAULT 'it',
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  lead          TEXT NOT NULL,
  deliverables  JSONB NOT NULL DEFAULT '[]'::jsonb,
  icon          TEXT NOT NULL DEFAULT 'globe',
  category      TEXT NOT NULL,
  sort_order    INT,
  is_published  BOOLEAN NOT NULL DEFAULT true,
  source        TEXT NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_services_locale_check CHECK (locale IN ('it', 'en')),
  CONSTRAINT site_services_category_check CHECK (category IN ('matrix', 'standalone')),
  CONSTRAINT site_services_slug_format CHECK (slug ~ '^[a-z0-9-]+$'),
  CONSTRAINT site_services_title_nonempty CHECK (length(trim(title)) > 0),
  CONSTRAINT site_services_unique_slug_locale UNIQUE (slug, locale)
);

CREATE INDEX IF NOT EXISTS idx_site_services_published
  ON public.site_services (locale, is_published, category, sort_order NULLS LAST, title);

DO $$
BEGIN
  IF to_regprocedure('public.audit_trigger_function()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS site_services_audit_trg ON public.site_services;
    CREATE TRIGGER site_services_audit_trg
      AFTER INSERT OR UPDATE OR DELETE ON public.site_services
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();
  END IF;
END $$;

DROP TRIGGER IF EXISTS site_services_updated_at_trg ON public.site_services;
CREATE TRIGGER site_services_updated_at_trg
  BEFORE UPDATE ON public.site_services
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();
