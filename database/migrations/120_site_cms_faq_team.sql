-- Audit C-013/C-014 — CMS layer for FAQ + Team
--
-- Until now, /faq and the team carousel were hardcoded in
-- apps/sito-v3/src/data/faqs.ts + team.ts. Moves both to DB-backed tables
-- so the admin can edit copy / add entries / reorder without redeploy.
--
-- Pattern (will be reused for glossario/seo-cities/zone/services in
-- subsequent migrations):
--   - sort_order INT for stable ordering (NULL last)
--   - locale TEXT for i18n (IT canonical, EN as overlay rows)
--   - is_published BOOL so admin can stage entries before they go live
--   - source TEXT NOT NULL DEFAULT 'admin' so seed/import scripts can mark
--     their origin and survive a "delete all admin rows" cleanup
--   - audit_logs triggered via the existing audit_trigger_function (mig 012)
--
-- The corresponding api endpoint (GET /api/public/cms/faqs?locale=...) reads
-- WHERE is_published=true ORDER BY sort_order NULLS LAST, id ASC. The site
-- helper falls back to data/faqs.ts when the table is empty so a fresh
-- install (or a temporarily unreachable api) doesn't render an empty page.

-- ── FAQ ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.site_faqs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  locale       TEXT NOT NULL DEFAULT 'it',
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL,
  sort_order   INT,
  is_published BOOLEAN NOT NULL DEFAULT true,
  source       TEXT NOT NULL DEFAULT 'admin',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_faqs_locale_check CHECK (locale IN ('it', 'en')),
  CONSTRAINT site_faqs_question_nonempty CHECK (length(trim(question)) > 0),
  CONSTRAINT site_faqs_answer_nonempty CHECK (length(trim(answer)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_site_faqs_published_sort
  ON public.site_faqs (locale, is_published, sort_order NULLS LAST, id);

-- Audit trigger (audit_trigger_function defined in mig 012).
DO $$
BEGIN
  IF to_regprocedure('public.audit_trigger_function()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS site_faqs_audit_trg ON public.site_faqs;
    CREATE TRIGGER site_faqs_audit_trg
      AFTER INSERT OR UPDATE OR DELETE ON public.site_faqs
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();
  END IF;
END $$;

-- ── TEAM ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.site_team (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  locale       TEXT NOT NULL DEFAULT 'it',
  name         TEXT NOT NULL,
  role         TEXT NOT NULL,
  bio          TEXT,
  avatar_url   TEXT,
  email        TEXT,
  socials      JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order   INT,
  is_published BOOLEAN NOT NULL DEFAULT true,
  source       TEXT NOT NULL DEFAULT 'admin',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_team_locale_check CHECK (locale IN ('it', 'en')),
  CONSTRAINT site_team_name_nonempty CHECK (length(trim(name)) > 0),
  CONSTRAINT site_team_role_nonempty CHECK (length(trim(role)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_site_team_published_sort
  ON public.site_team (locale, is_published, sort_order NULLS LAST, id);

DO $$
BEGIN
  IF to_regprocedure('public.audit_trigger_function()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS site_team_audit_trg ON public.site_team;
    CREATE TRIGGER site_team_audit_trg
      AFTER INSERT OR UPDATE OR DELETE ON public.site_team
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();
  END IF;
END $$;

-- updated_at trigger so the row tracks editor activity without the api
-- having to set it explicitly on every PATCH.
CREATE OR REPLACE FUNCTION public.set_updated_at_now() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS site_faqs_updated_at_trg ON public.site_faqs;
CREATE TRIGGER site_faqs_updated_at_trg
  BEFORE UPDATE ON public.site_faqs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();

DROP TRIGGER IF EXISTS site_team_updated_at_trg ON public.site_team;
CREATE TRIGGER site_team_updated_at_trg
  BEFORE UPDATE ON public.site_team
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();
