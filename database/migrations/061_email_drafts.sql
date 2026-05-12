-- 061_email_drafts.sql — Draft emails (AI-assisted or manual)

CREATE TABLE IF NOT EXISTS email_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  to_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text,
  body text,
  -- RFC822 Message-ID of the email being replied to (for threading)
  in_reply_to_msgid text,
  -- Our internal email_messages.id (for "reply to this email" flow)
  reply_to_message_id uuid REFERENCES email_messages(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual',  -- 'manual' | 'ai' | 'reply'
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_drafts_user ON email_drafts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_drafts_pending ON email_drafts (user_id) WHERE sent_at IS NULL;
