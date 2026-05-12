-- 058_mail.sql — Webmail integration (IMAP + SMTP)
--
-- Four tables:
--  email_accounts     – one IMAP/SMTP account per user (credentials encrypted)
--  email_messages     – local cache of received messages (body_text + body_html)
--  email_links        – email ↔ CRM entity links (automatic by email match, or manual)
--  email_attachments  – metadata of attachments (blob stays on disk under uploads/mail/)

CREATE TABLE IF NOT EXISTS email_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text,
  imap_host text NOT NULL,
  imap_port integer NOT NULL DEFAULT 993,
  imap_secure boolean NOT NULL DEFAULT true,
  smtp_host text NOT NULL,
  smtp_port integer NOT NULL DEFAULT 465,
  smtp_secure boolean NOT NULL DEFAULT true,
  username text NOT NULL,
  password_enc bytea NOT NULL,
  password_iv bytea NOT NULL,
  password_tag bytea NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);

CREATE TABLE IF NOT EXISTS email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  folder text NOT NULL,
  uid integer NOT NULL,
  uidvalidity bigint NOT NULL,
  message_id text,
  thread_id text,
  in_reply_to text,
  from_addr text,
  from_name text,
  to_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text,
  snippet text,
  body_text text,
  body_html text,
  has_attachments boolean NOT NULL DEFAULT false,
  flags text[] NOT NULL DEFAULT '{}',
  received_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, folder, uid, uidvalidity)
);

CREATE INDEX IF NOT EXISTS idx_email_messages_account_folder_received
  ON email_messages (account_id, folder, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages (thread_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_from_addr ON email_messages (from_addr);

CREATE TABLE IF NOT EXISTS email_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('cliente','lead','preventivo','progetto','collaboratore')),
  entity_id uuid NOT NULL,
  auto boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_email_links_entity ON email_links (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS email_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text,
  size_bytes integer,
  storage_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_attachments_message ON email_attachments (message_id);
