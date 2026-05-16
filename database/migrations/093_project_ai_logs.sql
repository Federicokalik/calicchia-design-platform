-- Migration 093 — persistence-only audit log for AI calls invoked on portfolio
-- projects (translate IT→EN, SEO generation). No admin UI in this pass —
-- the table exists so we can answer cost / volume / failure-rate questions
-- later via psql or by building a view on top.
--
-- Modeled lightly after blog_generation_logs but slimmer: this is opt-in
-- per-action telemetry, not a full async pipeline.

CREATE TABLE IF NOT EXISTS project_ai_logs (
  id           BIGSERIAL PRIMARY KEY,
  project_id   UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Which AI feature ran. Free-form text constrained by CHECK so the
  -- table can grow with future features (e.g. 'cover-gen') without a
  -- new migration just for the enum.
  kind         TEXT        NOT NULL CHECK (kind IN ('translate', 'seo')),
  model        TEXT        NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('ok', 'error')),
  error_message TEXT,
  duration_ms  INTEGER,
  input_chars  INTEGER,
  output_chars INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_ai_logs_project ON project_ai_logs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_ai_logs_kind    ON project_ai_logs (kind, created_at DESC);

COMMENT ON TABLE project_ai_logs IS
  'Audit log of AI feature invocations on portfolio projects. Insert-only; pruned manually if needed.';
