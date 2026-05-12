-- Migration: 021_fix_versioning_trigger_fk.sql
-- Descrizione: Fix FK constraint su blog_post_revisions e project_revisions
--              per compatibilità con trigger BEFORE INSERT
-- Data: 2026-02-22
-- Root cause: Il trigger blog_post_versioning_trigger è BEFORE INSERT, quindi
--             tenta di inserire in blog_post_revisions prima che il blog_post
--             esista nella tabella. Il vincolo FK blocca questa operazione.
-- Fix: Rendere il FK DEFERRABLE INITIALLY DEFERRED così viene verificato
--      solo al commit della transazione (quando il blog_post esiste già).

-- Fix blog_post_revisions FK
ALTER TABLE blog_post_revisions
  DROP CONSTRAINT IF EXISTS blog_post_revisions_post_id_fkey;

ALTER TABLE blog_post_revisions
  ADD CONSTRAINT blog_post_revisions_post_id_fkey
    FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

-- Fix project_revisions FK (stesso problema)
ALTER TABLE project_revisions
  DROP CONSTRAINT IF EXISTS project_revisions_project_id_fkey;

ALTER TABLE project_revisions
  ADD CONSTRAINT project_revisions_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;
