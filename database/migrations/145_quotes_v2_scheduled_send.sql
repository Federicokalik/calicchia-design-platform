-- 145: Scheduled quote sending — the admin picks date/time + channels and the
-- cron (quote-scheduled-send, every minute) performs the real send.

ALTER TABLE quotes_v2
  ADD COLUMN IF NOT EXISTS scheduled_send_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_send_channels TEXT[],
  ADD COLUMN IF NOT EXISTS scheduled_send_attempts INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN quotes_v2.scheduled_send_at IS 'When set, the cron sends the quote at/after this instant (cleared after send or 3 failed attempts)';
COMMENT ON COLUMN quotes_v2.scheduled_send_channels IS 'Channels for the scheduled send: email / whatsapp';
