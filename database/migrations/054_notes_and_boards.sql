-- Notes table for Second Brain / Knowledge module
CREATE TABLE IF NOT EXISTS notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL DEFAULT 'Senza titolo',
  content     JSONB,                          -- Tiptap JSON document
  raw_markdown TEXT,                           -- original markdown (from Telegram/AI)
  source      TEXT NOT NULL DEFAULT 'app',     -- 'app' | 'telegram' | 'agent'
  tags        TEXT[] DEFAULT '{}',
  linked_type TEXT,                            -- 'project' | 'customer' | null
  linked_id   UUID,
  is_pinned   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_linked ON notes(linked_type, linked_id);
CREATE INDEX IF NOT EXISTS idx_notes_tags ON notes USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_notes_source ON notes(source);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);

-- Boards table for Sketch (Excalidraw) and Mind Map (React Flow)
CREATE TABLE IF NOT EXISTS boards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL DEFAULT 'Senza titolo',
  type        TEXT NOT NULL DEFAULT 'sketch',  -- 'sketch' | 'mindmap'
  data        JSONB NOT NULL DEFAULT '{}',     -- Excalidraw elements or React Flow nodes/edges
  thumbnail   TEXT,                            -- optional SVG/base64 preview
  linked_type TEXT,
  linked_id   UUID,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boards_type ON boards(type);
CREATE INDEX IF NOT EXISTS idx_boards_linked ON boards(linked_type, linked_id);
CREATE INDEX IF NOT EXISTS idx_boards_created ON boards(created_at DESC);