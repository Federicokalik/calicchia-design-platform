-- Migration 141 — capture_sessions queue table for the headful worker (Fase 3).
--
-- The worker (apps/worker) polls this table to drive a headful Chromium
-- session per project, exposed to the admin via noVNC for manual login on
-- sites behind auth. One row == one manual browser session; the worker moves
-- the row through the lifecycle by flipping `status`. Headless screenshots
-- taken this way still land in the /media/projects/<slug>/ namespace (the
-- worker writes to the shared uploads volume). See apps/worker/README.md.
--
-- Lifecycle (CHECK-enforced):
--   pending          just enqueued by POST /capture/session/start
--   open             worker launched Chromium + VNC, vnc_url set
--   snap_requested   admin wants a screenshot at the current scroll/viewport
--   snap_done        worker uploaded the webp, last_capture_url set
--   close_requested  admin closed; worker should tear down + persist profile
--   closed           worker done, profile persisted
--   error             worker hit an unrecoverable failure (last_error set)

CREATE TABLE IF NOT EXISTS capture_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status            TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','open','snap_requested','snap_done','close_requested','closed','error')),
  -- URL the worker's Chromium navigates to on open. Defaults to the
  -- project live_url at insert time (apps/api), overridable per session.
  target_url        TEXT,
  -- Absolute path of the Chrome userDataDir the worker uses for this
  -- project — persisted across sessions so the login done headfully is
  -- reusable by later headless captures (captureSiteAuthenticated).
  profile_dir       TEXT        NOT NULL,
  -- Public noVNC URL the admin embeds. Set by the worker when status→open.
  vnc_url           TEXT,
  -- Optional snap framing the admin can request with POST .../snap.
  viewport_width    INTEGER,
  viewport_height   INTEGER,
  scroll_y          INTEGER,
  -- Public URL of the uploaded webp once status='snap_done'.
  last_capture_url  TEXT,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capture_sessions_project ON capture_sessions (project_id, created_at DESC);
-- The worker polls on status; this index keeps that scan cheap even once
-- the table grows with closed historical sessions.
CREATE INDEX IF NOT EXISTS idx_capture_sessions_status   ON capture_sessions (status, updated_at);

-- Auto-maintain updated_at so the worker's stale-session janitor works
-- without every call site having to set it (reuses the base 000 trigger fn;
-- prefer update_updated_at() per the convention documented in 000_init).
CREATE TRIGGER capture_sessions_set_updated_at BEFORE UPDATE ON capture_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE capture_sessions IS
  'Headful capture session queue (apps/worker, Fase 3). Worker polls status to open/snap/close a manual Chromium session per project.';