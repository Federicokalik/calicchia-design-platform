-- CMS layer per le 3 entità editoriali rimaste hardcoded in data/*.ts:
--   - curiosita.ts → site_curiosita  (carosello fun facts /perche-scegliere-me)
--   - approach.ts  → site_approach   (5 pillar metodologici /perche-scegliere-me)
--   - clients.ts   → site_clients    (logo TrustBento + backlink case-study)
--
-- Stesso pattern di mig 120/121/123: UUID PK, locale (dove serve), sort_order,
-- is_published, source, audit + updated_at triggers, indice ordinato.
-- site_clients è single-locale: i nomi azienda non si traducono.

-- ── CURIOSITA ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.site_curiosita (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  locale       TEXT NOT NULL DEFAULT 'it',
  label        TEXT NOT NULL,
  body         TEXT NOT NULL,
  sort_order   INT,
  is_published BOOLEAN NOT NULL DEFAULT true,
  source       TEXT NOT NULL DEFAULT 'admin',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_curiosita_locale_check CHECK (locale IN ('it', 'en')),
  CONSTRAINT site_curiosita_label_nonempty CHECK (length(trim(label)) > 0),
  CONSTRAINT site_curiosita_body_nonempty CHECK (length(trim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_site_curiosita_published_sort
  ON public.site_curiosita (locale, is_published, sort_order NULLS LAST, id);

DO $$
BEGIN
  IF to_regprocedure('public.audit_trigger_function()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS site_curiosita_audit_trg ON public.site_curiosita;
    CREATE TRIGGER site_curiosita_audit_trg
      AFTER INSERT OR UPDATE OR DELETE ON public.site_curiosita
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();
  END IF;
END $$;

DROP TRIGGER IF EXISTS site_curiosita_updated_at_trg ON public.site_curiosita;
CREATE TRIGGER site_curiosita_updated_at_trg
  BEFORE UPDATE ON public.site_curiosita
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();

-- ── APPROACH ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.site_approach (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  locale        TEXT NOT NULL DEFAULT 'it',
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  phosphor_icon TEXT NOT NULL DEFAULT 'ph-circle',
  sort_order    INT,
  is_published  BOOLEAN NOT NULL DEFAULT true,
  source        TEXT NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_approach_locale_check CHECK (locale IN ('it', 'en')),
  CONSTRAINT site_approach_title_nonempty CHECK (length(trim(title)) > 0),
  CONSTRAINT site_approach_description_nonempty CHECK (length(trim(description)) > 0),
  CONSTRAINT site_approach_phosphor_icon_format CHECK (phosphor_icon ~ '^ph-[a-z0-9-]+$')
);

CREATE INDEX IF NOT EXISTS idx_site_approach_published_sort
  ON public.site_approach (locale, is_published, sort_order NULLS LAST, id);

DO $$
BEGIN
  IF to_regprocedure('public.audit_trigger_function()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS site_approach_audit_trg ON public.site_approach;
    CREATE TRIGGER site_approach_audit_trg
      AFTER INSERT OR UPDATE OR DELETE ON public.site_approach
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();
  END IF;
END $$;

DROP TRIGGER IF EXISTS site_approach_updated_at_trg ON public.site_approach;
CREATE TRIGGER site_approach_updated_at_trg
  BEFORE UPDATE ON public.site_approach
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();

-- ── CLIENTS ──────────────────────────────────────────────────────
-- No locale: i nomi clienti sono universali (vedi pattern site_seo_cities).
CREATE TABLE IF NOT EXISTS public.site_clients (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         TEXT NOT NULL,
  url          TEXT NOT NULL DEFAULT '#',
  industry     TEXT,
  logo_url     TEXT,
  sort_order   INT,
  is_published BOOLEAN NOT NULL DEFAULT true,
  source       TEXT NOT NULL DEFAULT 'admin',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_clients_name_nonempty CHECK (length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_site_clients_published_sort
  ON public.site_clients (is_published, sort_order NULLS LAST, name);

DO $$
BEGIN
  IF to_regprocedure('public.audit_trigger_function()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS site_clients_audit_trg ON public.site_clients;
    CREATE TRIGGER site_clients_audit_trg
      AFTER INSERT OR UPDATE OR DELETE ON public.site_clients
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();
  END IF;
END $$;

DROP TRIGGER IF EXISTS site_clients_updated_at_trg ON public.site_clients;
CREATE TRIGGER site_clients_updated_at_trg
  BEFORE UPDATE ON public.site_clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();
