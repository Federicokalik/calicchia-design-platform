-- 090: Portfolio detail redesign — consolida challenge/solution/content in `brief`.
--
-- Contesto (decision 2026-05-14):
-- Il detail page `/lavori/[slug]` viene ridisegnato con un solo blocco testuale
-- (`brief`) al posto delle tre sezioni separate (Contesto, Sfida, Approccio +
-- Longform markdown). Questa migration aggiunge la colonna e migra il
-- contenuto esistente. Le colonne legacy restano DEPRECATED e verranno
-- droppate in una migration successiva (091_*) dopo verifica visiva su
-- staging — approccio in due step per evitare data loss in caso di rollback.

-- 1) Nuova colonna: testo markdown unico per il body del case study.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS brief TEXT;

-- 2) Backfill (solo dove brief e' NULL).
-- Concatena description + challenge.detail + solution.detail + content
-- separati da paragrafi vuoti. NULLIF + CONCAT_WS scarta i campi vuoti.
-- TRIM(BOTH E'\n\n') rimuove eventuali newline pendenti agli estremi.
UPDATE public.projects
SET brief = TRIM(BOTH E'\n\n' FROM CONCAT_WS(
  E'\n\n',
  NULLIF(description, ''),
  NULLIF(challenge->>'detail', ''),
  NULLIF(solution->>'detail', ''),
  NULLIF(content, '')
))
WHERE brief IS NULL;

-- 3) Marca le colonne legacy come deprecate. Lasciate in tabella finche'
-- la 091 non le droppera'. Le query del frontend / admin non le leggono
-- piu' dopo questa migration.
COMMENT ON COLUMN public.projects.challenge IS
  'DEPRECATED 2026-05-14: contenuto migrato in `brief`. Drop in migration 091.';
COMMENT ON COLUMN public.projects.challenge_images IS
  'DEPRECATED 2026-05-14: usare `gallery` (immagini case study unificate). Drop in 091.';
COMMENT ON COLUMN public.projects.solution IS
  'DEPRECATED 2026-05-14: contenuto migrato in `brief`. Drop in 091.';
COMMENT ON COLUMN public.projects.solution_image IS
  'DEPRECATED 2026-05-14: usare `gallery`. Drop in 091.';
COMMENT ON COLUMN public.projects.content IS
  'DEPRECATED 2026-05-14: longform rimosso dal detail page. Contenuto migrato in `brief`. Drop in 091.';
COMMENT ON COLUMN public.projects.excerpt IS
  'DEPRECATED 2026-05-14: usare `description` per la card index. Drop in 091.';
