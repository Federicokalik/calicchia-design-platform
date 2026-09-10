-- 151_device_sync.sql — Sync ePaper device (Waveshare 3.97 companion firmware)
--
-- device_tokens: pairing tokens per il firmware sull'ePaper. Stesso schema
-- dei mcp_tokens: token mai salvato in chiaro (sha256), prefix visibile in UI.
--
-- device_notes: una riga per ogni cattura vocale inviata dal dispositivo.
-- Il vocab tag riprende il vocabolario folloup: 'idea' | 'todo' | 'note'.
-- La trascrizione gira lato server (worker) e la nota finisce nella tabella
-- `notes` (migr. 054) con source='device'.
-- I file audio sono dati personali: salvati in PRIVATE_UPLOAD_DIR/device/ —
-- MAI esposti su /media (vedi private-files.ts per la stessa scelta).

CREATE TABLE IF NOT EXISTS device_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT 'ePaper device',
  is_active    BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  usage_count  INTEGER NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS device_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id     UUID NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  audio_path   TEXT NOT NULL,          -- rel. a PRIVATE_UPLOAD_DIR: device/<uuid>.wav
  audio_bytes  INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER,
  tag          TEXT NOT NULL DEFAULT 'note' CHECK (tag IN ('idea', 'todo', 'note')),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'transcribing', 'done', 'failed')),
  transcript   TEXT,
  note_id      UUID REFERENCES notes(id) ON DELETE SET NULL,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_device_notes_token ON device_notes(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_notes_status ON device_notes(status) WHERE status = 'pending';

CREATE TRIGGER device_tokens_updated
  BEFORE UPDATE ON device_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
