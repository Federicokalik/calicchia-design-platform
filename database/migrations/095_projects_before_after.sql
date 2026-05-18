-- Migration 095 — Before/After section for website-restyle case studies.
--
-- Contesto (decision 2026-05-18):
-- Per i progetti di restyling il detail page deve mostrare un confronto
-- visivo prima/dopo. Aggiungiamo due colonne additive:
--   - `is_restyling`  flag esplicito che abilita la sezione (toggle senza
--                     dover svuotare i dati — permette draft + preview)
--   - `before_after`  JSONB con la struttura { pairs: [...] } documentata
--                     sotto. Una coppia per "schermata" del sito ridisegnato.
--
-- Rendering condizionale lato sito-v3: la sezione esce SOLO se
-- `is_restyling = true AND jsonb_array_length(before_after->'pairs') > 0`.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS is_restyling BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS before_after JSONB DEFAULT NULL;

-- Struttura `before_after`:
-- {
--   "pairs": [
--     {
--       "label":    "Homepage",          // opzionale, IT canonical
--       "label_en": "Homepage",          // opzionale, override EN
--       "before":   { "src": "/media/...", "alt": "...",
--                     "w": 2400, "h": 1500 },
--       "after":    { "src": "/media/...", "alt": "...",
--                     "w": 2400, "h": 1500 },
--       "note":     "max 1 riga, contesto"   // opzionale
--     }
--   ]
-- }
-- src: path relativo /media/... oppure URL assoluto (resolveImageUrl gestisce
-- entrambi). alt obbligatorio lato editor admin (a11y + SEO).

COMMENT ON COLUMN public.projects.is_restyling IS
  'Toggle esplicito: abilita la sezione before/after sul detail page. '
  'Disaccoppia visibilita'' da dati (permette di nascondere la sezione '
  'senza svuotare le coppie).';

COMMENT ON COLUMN public.projects.before_after IS
  'Restyle pairs: { pairs: [{label?, label_en?, before:{src,alt,w,h}, '
  'after:{src,alt,w,h}, note?}] }. NULL o pairs vuoto = sezione nascosta.';
