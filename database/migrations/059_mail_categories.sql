-- 059_mail_categories.sql — Gmail-style inbox categories
-- Values: importanti | normali | aggiornamenti | marketing | spam

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'normali';

CREATE INDEX IF NOT EXISTS idx_email_messages_category
  ON email_messages (account_id, folder, category, received_at DESC);
