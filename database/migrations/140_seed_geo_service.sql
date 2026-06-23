-- 140_seed_geo_service.sql
-- Adds the public GEO service to the lightweight CMS catalog used by /servizi.

INSERT INTO public.site_services (
  locale, slug, title, lead, deliverables, icon, category, sort_order, source
)
VALUES
  (
    'it',
    'geo',
    'GEO & visibilità AI',
    E'Vuoi apparire su ChatGPT e nelle ricerche AI?\nPrima rendiamo il sito leggibile, citabile e misurabile: bot accessibili, contenuti answer-first, fonti vere, niente fuffa su llms.txt.',
    '["GEO Audit tecnico","Accesso bot e snippet review","Pagine answer-first citabili","Misurazione AI con run ripetute"]'::jsonb,
    'sparkle',
    'standalone',
    9,
    'seed'
  ),
  (
    'en',
    'geo',
    'GEO & AI Visibility',
    E'Want to appear in ChatGPT and AI search results?\nFirst we make the site readable, citable and measurable: accessible bots, answer-first content, real sources, no llms.txt fluff.',
    '["Technical GEO Audit","Bot access and snippet review","Citable answer-first pages","AI measurement with repeated runs"]'::jsonb,
    'sparkle',
    'standalone',
    9,
    'seed'
  )
ON CONFLICT (slug, locale) DO UPDATE SET
  title = EXCLUDED.title,
  lead = EXCLUDED.lead,
  deliverables = EXCLUDED.deliverables,
  icon = EXCLUDED.icon,
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  source = EXCLUDED.source,
  updated_at = NOW();
