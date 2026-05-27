-- Audit C-013/C-014 — SEO cities CMS table (PR21)
--
-- 199 city rows from apps/sito-v3/src/data/seo-cities.ts: capoluoghi
-- italiani + comuni della Ciociaria. Used for /zone/[comune] landing
-- pages, matrix routes, sitemap, RelatedZones component, and the
-- profession × city SEO matrix.
--
-- Cities don't change often (provincial capitals, ciociaria comuni)
-- but the marketing team should still be able to:
--   - add a city without a redeploy when expanding
--   - bump a city's tier as it becomes a higher priority
--   - hide a long-tail city that's underperforming
--
-- getCityContext() — the function that builds the per-city marketing
-- copy from tier + tipo + slug — stays in code (sito-v3/src/lib/
-- seo-cities-context.ts). It's a programmatic template, not editable
-- content, so it doesn't belong in the DB.
--
-- The single-locale design (no locale CHECK) reflects that cities are
-- named the same in IT and EN; only the surrounding marketing copy is
-- translated, and that lives in /messages.

CREATE TABLE IF NOT EXISTS public.site_seo_cities (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug         TEXT NOT NULL UNIQUE,
  nome         TEXT NOT NULL,
  regione      TEXT NOT NULL,
  tipo         TEXT NOT NULL,
  tier         INT NOT NULL,
  sort_order   INT,
  is_published BOOLEAN NOT NULL DEFAULT true,
  source       TEXT NOT NULL DEFAULT 'admin',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_seo_cities_slug_format CHECK (slug ~ '^[a-z0-9-]+$'),
  CONSTRAINT site_seo_cities_tipo_check CHECK (tipo IN ('capoluogo', 'ciociaria')),
  CONSTRAINT site_seo_cities_tier_check CHECK (tier IN (1, 2, 3)),
  CONSTRAINT site_seo_cities_nome_nonempty CHECK (length(trim(nome)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_site_seo_cities_published_regione
  ON public.site_seo_cities (is_published, regione, nome);
CREATE INDEX IF NOT EXISTS idx_site_seo_cities_tier_tipo
  ON public.site_seo_cities (tier, tipo);

DO $$
BEGIN
  IF to_regprocedure('public.audit_trigger_function()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS site_seo_cities_audit_trg ON public.site_seo_cities;
    CREATE TRIGGER site_seo_cities_audit_trg
      AFTER INSERT OR UPDATE OR DELETE ON public.site_seo_cities
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();
  END IF;
END $$;

DROP TRIGGER IF EXISTS site_seo_cities_updated_at_trg ON public.site_seo_cities;
CREATE TRIGGER site_seo_cities_updated_at_trg
  BEFORE UPDATE ON public.site_seo_cities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();
