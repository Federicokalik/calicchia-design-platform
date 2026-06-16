-- Migration 135: Email/WhatsApp marketing — sender identities
--
-- Decouples the marketing "from" address from code/env. The dedicated marketing
-- subdomain (e.g. send.calicchia.design on Resend) is a row, not a hardcoded
-- env read — so the user can manage senders in the UI. The Resend API key still
-- lives in env (RESEND_MARKETING_API_KEY); only the from-address is data.

CREATE TABLE IF NOT EXISTS mkt_sender_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL DEFAULT 'email',     -- email | whatsapp
  from_name TEXT NOT NULL,
  from_email TEXT,                           -- email channel: e.g. news@send.calicchia.design
  reply_to TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,   -- DNS/DKIM verified on the provider
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mkt_sender_channel CHECK (channel IN ('email','whatsapp'))
);

-- At most one default per channel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mkt_sender_default
  ON mkt_sender_identities (channel) WHERE is_default;
