-- Full-text search on notes (Italian language)
ALTER TABLE notes ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_notes_search_vector ON notes USING GIN(search_vector);

CREATE OR REPLACE FUNCTION notes_search_vector_update() RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('italian', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('italian', COALESCE(NEW.raw_markdown, '')), 'B') ||
    setweight(to_tsvector('italian', COALESCE(array_to_string(NEW.tags, ' '), '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notes_search_vector_trigger ON notes;
CREATE TRIGGER notes_search_vector_trigger
  BEFORE INSERT OR UPDATE OF title, raw_markdown, tags ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_search_vector_update();

-- Backfill existing notes
UPDATE notes SET search_vector =
  setweight(to_tsvector('italian', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('italian', COALESCE(raw_markdown, '')), 'B') ||
  setweight(to_tsvector('italian', COALESCE(array_to_string(tags, ' '), '')), 'C');

-- Soft delete for notes and boards
ALTER TABLE notes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_boards_deleted ON boards(deleted_at) WHERE deleted_at IS NOT NULL;

-- Note links table for backlinks (Phase 2)
CREATE TABLE IF NOT EXISTS note_links (
  source_note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
  target_note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (source_note_id, target_note_id)
);
