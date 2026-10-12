-- Migration 166 — tool "Palette di settore" (/risorse/palette-di-settore).
--
-- 1. brand_palette su contacts e leads: la palette che il visitatore porta nel
--    modulo contatti dal link "condividi" (forma: brandPaletteSchema di
--    @calicchia/shared/palette). routes/contacts.ts scrive entrambe le tabelle
--    con l'helper jsonb(), mai con JSON.stringify (vedi migrazioni 157/161).
-- 2. palette_searches: registro anonimo delle ricerche libere del tool
--    (GET /api/palette/search). Solo il testo normalizzato: niente IP, niente
--    user agent, niente legame con un visitatore.
-- 3. Obiettivi di analytics per gli eventi del tool, inseriti una sola volta
--    (analytics_goals non ha un vincolo unico sul nome: l'idempotenza è nel
--    NOT EXISTS).

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS brand_palette JSONB;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS brand_palette JSONB;

CREATE TABLE IF NOT EXISTS palette_searches (
  -- normalizeQuery(q): minuscolo, senza accenti, spazi compattati.
  query_norm TEXT PRIMARY KEY,
  -- Query inviata a Unsplash (traduzione IT→EN o testo originale).
  query_en TEXT,
  locale TEXT NOT NULL DEFAULT 'it' CHECK (locale IN ('it', 'en')),
  hits INTEGER NOT NULL DEFAULT 1,
  -- Foto restituite dall'ultima ricerca.
  results INTEGER NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_palette_searches_last_seen ON palette_searches (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_palette_searches_hits ON palette_searches (hits DESC);

INSERT INTO analytics_goals (name, type, conditions, active)
SELECT g.name, 'event', jsonb_build_object('type', 'event', 'event_name', g.event_name), TRUE
FROM (VALUES
  ('Palette: settore scelto', 'palette_sector'),
  ('Palette: ricerca libera', 'palette_search'),
  ('Palette: export', 'palette_export'),
  ('Palette: link condiviso', 'palette_share'),
  ('Palette: contatto', 'palette_contact')
) AS g(name, event_name)
WHERE NOT EXISTS (
  SELECT 1 FROM analytics_goals a
  WHERE a.type = 'event' AND a.conditions->>'event_name' = g.event_name
);
