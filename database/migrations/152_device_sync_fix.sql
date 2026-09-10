-- 152_device_sync_fix.sql — fix-forward di 151: il trigger atteso la colonna
-- updated_at (mancante) e usava il nome funzione sbagliato. Allineato al
-- pattern di 065_mcp_tokens.

ALTER TABLE device_tokens
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

DROP TRIGGER IF EXISTS device_tokens_updated ON device_tokens;
CREATE TRIGGER device_tokens_updated
  BEFORE UPDATE ON device_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
