-- Migration 156 — Appunti interni sul progetto cliente.
--
-- Il tab "Note" del dettaglio progetto nell'admin si presentava come
-- "Appunti interni" ma scriveva in client_projects.client_notes, che il
-- portale clienti mostra al cliente (descrizione della card in dashboard).
-- Gli appunti interni hanno ora una colonna propria, mai selezionata dalle
-- route del portale; client_notes resta la nota visibile al cliente.
--
-- Nessuno spostamento automatico dei dati: quanto già scritto in
-- client_notes è stato finora visibile al cliente e va rivisto a mano
-- dall'admin (il tab Note ora mostra i due campi separati).

ALTER TABLE public.client_projects
  ADD COLUMN IF NOT EXISTS internal_notes TEXT DEFAULT NULL;
