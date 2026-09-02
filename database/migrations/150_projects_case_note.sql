-- Migration 150 — Nota editoriale opzionale sul case study.
--
-- Contesto (richiesta 2026-09-02): alcuni progetti hanno una limitazione da
-- comunicare esplicitamente sul detail page — es. un gestionale che tratta
-- dati reali (pazienti) di cui non si possono mostrare altri screenshot, con
-- il rimando a cosa resta comunque visitabile pubblicamente.
--
-- Colonna additiva TEXT. Traducibile via `projects_translations`
-- (field_name = 'case_note') — vedi TRANSLATABLE_PROJECT_FIELDS in
-- apps/api/src/routes/projects.ts.
--
-- Rendering lato sito-v3: <CaseNote> esce SOLO se `case_note` è valorizzato,
-- come riquadro hairline dopo la sezione Risultati.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS case_note TEXT DEFAULT NULL;
