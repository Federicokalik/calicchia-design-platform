-- Glossario Web Design v2 — schema.
--
-- Il glossario passa da un solo template (Cos'è / Perché ti riguarda / Cosa
-- pretendere) a due, scelti da `term_type`:
--   concept    → what_it_is, why_you_care, what_to_demand
--   technology → what_it_is, what_for, when_yes, when_no, what_to_ask
--                (Cos'è / A cosa serve / Quando conviene / Quando no /
--                 Cosa chiedere al fornitore)
-- e guadagna i metadati per filtri e ricerca: categoria, livello, alias
-- (sinonimi cercabili) e correlati (slug di altre voci).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + constraint creati solo se assenti.
-- I default (level='base', term_type='concept', array vuoti) rendono valide
-- le righe esistenti senza backfill; i contenuti arrivano con la 154.

ALTER TABLE public.site_glossario
  ADD COLUMN IF NOT EXISTS category    TEXT,
  ADD COLUMN IF NOT EXISTS level       TEXT   NOT NULL DEFAULT 'base',
  ADD COLUMN IF NOT EXISTS term_type   TEXT   NOT NULL DEFAULT 'concept',
  ADD COLUMN IF NOT EXISTS aliases     TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS related     TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS what_for    TEXT,
  ADD COLUMN IF NOT EXISTS when_yes    TEXT,
  ADD COLUMN IF NOT EXISTS when_no     TEXT,
  ADD COLUMN IF NOT EXISTS what_to_ask TEXT;

-- Le voci "technology" non hanno why/demand: il vincolo per tipo sotto
-- prende il posto del NOT NULL.
ALTER TABLE public.site_glossario ALTER COLUMN why_you_care   DROP NOT NULL;
ALTER TABLE public.site_glossario ALTER COLUMN what_to_demand DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_glossario_category_check') THEN
    ALTER TABLE public.site_glossario ADD CONSTRAINT site_glossario_category_check
      CHECK (category IS NULL OR category IN (
        'seo', 'performance', 'infrastruttura', 'dominio-email', 'sviluppo',
        'piattaforme', 'sicurezza-legale', 'design-ux', 'motion-3d'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_glossario_level_check') THEN
    ALTER TABLE public.site_glossario ADD CONSTRAINT site_glossario_level_check
      CHECK (level IN ('base', 'tecnico'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_glossario_term_type_check') THEN
    ALTER TABLE public.site_glossario ADD CONSTRAINT site_glossario_term_type_check
      CHECK (term_type IN ('concept', 'technology'));
  END IF;

  -- Campi obbligatori per template. nullif(trim()) evita stringhe vuote.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_glossario_fields_by_type') THEN
    ALTER TABLE public.site_glossario ADD CONSTRAINT site_glossario_fields_by_type
      CHECK (
        (term_type = 'concept'
          AND nullif(trim(why_you_care), '') IS NOT NULL
          AND nullif(trim(what_to_demand), '') IS NOT NULL)
        OR
        (term_type = 'technology'
          AND nullif(trim(what_for), '') IS NOT NULL
          AND nullif(trim(when_yes), '') IS NOT NULL
          AND nullif(trim(when_no), '') IS NOT NULL
          AND nullif(trim(what_to_ask), '') IS NOT NULL)
      );
  END IF;
END $$;
