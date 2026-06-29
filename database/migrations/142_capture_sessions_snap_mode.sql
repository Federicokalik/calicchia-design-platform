-- Migration 142 — snap_mode per capture_sessions (Fase 3, cattura WYSIWYG).
--
-- Il dialog headful ora cattura "questa vista" (esattamente ciò che l'operatore
-- vede nel noVNC) oppure la pagina intera. Il frontend non può leggere scroll/
-- viewport del browser REMOTO (vede solo il pixel-stream noVNC), quindi il
-- worker deve sapere quale inquadratura usare: lo legge da questa colonna.
--   viewport  → screenshot del viewport corrente allo scroll corrente (default)
--   fullpage  → screenshot dell'intera pagina scrollabile
--
-- Le vecchie colonne viewport_width/height/scroll_y (migration 141) restano ma
-- non sono più usate dal worker: la cattura parametrica è stata sostituita dal
-- modello WYSIWYG, più intuitivo per l'operatore.

ALTER TABLE capture_sessions
  ADD COLUMN IF NOT EXISTS snap_mode TEXT NOT NULL DEFAULT 'viewport'
    CHECK (snap_mode IN ('viewport', 'fullpage'));

COMMENT ON COLUMN capture_sessions.snap_mode IS
  'Inquadratura dello snap: viewport = WYSIWYG (vista corrente in noVNC); fullpage = intera pagina scrollabile.';
