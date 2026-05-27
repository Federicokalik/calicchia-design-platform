-- Audit C-013/C-014 — Glossario CMS table (PR20)
--
-- Originally apps/sito-v3/src/data/glossario.ts: 30 terms with the
-- triplet "whatItIs / whyYouCare / whatToDemand". DB-backed so the admin
-- can edit copy / add terms / reorder by letter without redeploy.
--
-- (slug, locale) is unique so the same anchor can have IT + EN variants.

CREATE TABLE IF NOT EXISTS public.site_glossario (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  locale          TEXT NOT NULL DEFAULT 'it',
  slug            TEXT NOT NULL,
  term            TEXT NOT NULL,
  full_name       TEXT,
  letter          TEXT NOT NULL,
  what_it_is      TEXT NOT NULL,
  why_you_care    TEXT NOT NULL,
  what_to_demand  TEXT NOT NULL,
  sort_order      INT,
  is_published    BOOLEAN NOT NULL DEFAULT true,
  source          TEXT NOT NULL DEFAULT 'admin',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_glossario_locale_check CHECK (locale IN ('it', 'en')),
  CONSTRAINT site_glossario_slug_format CHECK (slug ~ '^[a-z0-9-]+$'),
  CONSTRAINT site_glossario_letter_format CHECK (letter ~ '^[A-Z0-9]$'),
  CONSTRAINT site_glossario_term_nonempty CHECK (length(trim(term)) > 0),
  CONSTRAINT site_glossario_unique_slug_locale UNIQUE (slug, locale)
);

CREATE INDEX IF NOT EXISTS idx_site_glossario_published_letter
  ON public.site_glossario (locale, is_published, letter, sort_order NULLS LAST, term);

-- Audit trigger (function from mig 012) + updated_at (function from mig 120).
DO $$
BEGIN
  IF to_regprocedure('public.audit_trigger_function()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS site_glossario_audit_trg ON public.site_glossario;
    CREATE TRIGGER site_glossario_audit_trg
      AFTER INSERT OR UPDATE OR DELETE ON public.site_glossario
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();
  END IF;
END $$;

DROP TRIGGER IF EXISTS site_glossario_updated_at_trg ON public.site_glossario;
CREATE TRIGGER site_glossario_updated_at_trg
  BEFORE UPDATE ON public.site_glossario
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();
