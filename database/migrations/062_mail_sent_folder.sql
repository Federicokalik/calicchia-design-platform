-- 062_mail_sent_folder.sql — Cache the auto-detected Sent folder name per account

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS sent_folder text;
