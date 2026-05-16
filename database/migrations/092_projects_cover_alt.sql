-- Migration 092 — add cover_alt for accessibility/SEO.
-- The gallery alt text lives inline in the gallery JSONB array (see admin
-- GalleryEditor); cover_alt is separate because cover_image is a plain
-- string column, not JSONB.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS cover_alt TEXT;

COMMENT ON COLUMN projects.cover_alt IS
  'Alt text for cover_image. Falls back to project title at render time when null.';
