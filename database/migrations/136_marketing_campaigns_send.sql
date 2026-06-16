-- Migration 136: Email/WhatsApp marketing — campaigns + send queue + tracking
--
-- The send engine: a campaign resolves an audience (list or segment) into a
-- per-recipient queue (mkt_messages), drained in throttled batches by a cron.
-- Idempotency is structural: UNIQUE(campaign_id, contact_id) + ON CONFLICT DO
-- NOTHING means re-clicking Send / a cron overlap / a mid-batch restart can
-- never double-deliver. Tracking (opens/clicks/bounces) flows into mkt_events
-- with the convenience rollup living on mkt_messages + mkt_campaigns.

-- =====================================================
-- mkt_campaigns
-- =====================================================
CREATE TABLE IF NOT EXISTS mkt_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',      -- email | whatsapp
  subject TEXT,                               -- email only
  preheader TEXT,                             -- inbox preview text (email)

  -- Content: source (one of three modes) + the compiled output actually sent.
  content_mode TEXT NOT NULL DEFAULT 'blocks',-- blocks | html | ai
  content_blocks JSONB,                       -- block tree (blocks/ai modes)
  content_html TEXT,                          -- raw source html (html mode)
  compiled_html TEXT,                         -- rendered, email-safe output
  wa_body TEXT,                               -- whatsapp text (channel=whatsapp)

  from_identity_id UUID REFERENCES mkt_sender_identities(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  -- draft | scheduled | queued | sending | sent | paused | failed | cancelled

  audience_kind TEXT,                         -- list | segment
  list_id UUID REFERENCES mkt_lists(id) ON DELETE SET NULL,
  segment_id UUID REFERENCES mkt_segments(id) ON DELETE SET NULL,

  scheduled_at TIMESTAMPTZ,
  throttle_per_min INT NOT NULL DEFAULT 60,   -- batch size per cron tick
  track_opens BOOLEAN NOT NULL DEFAULT true,
  track_clicks BOOLEAN NOT NULL DEFAULT true,

  -- Denormalized rollup (kept fresh by tracking + the send drainer).
  total_recipients INT NOT NULL DEFAULT 0,
  total_sent INT NOT NULL DEFAULT 0,
  total_delivered INT NOT NULL DEFAULT 0,
  total_opened INT NOT NULL DEFAULT 0,
  total_clicked INT NOT NULL DEFAULT 0,
  total_bounced INT NOT NULL DEFAULT 0,
  total_unsub INT NOT NULL DEFAULT 0,
  total_skipped INT NOT NULL DEFAULT 0,

  sent_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_mkt_campaigns_channel CHECK (channel IN ('email','whatsapp')),
  CONSTRAINT chk_mkt_campaigns_mode CHECK (content_mode IN ('blocks','html','ai')),
  CONSTRAINT chk_mkt_campaigns_status
    CHECK (status IN ('draft','scheduled','queued','sending','sent','paused','failed','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_campaigns_status ON mkt_campaigns (status);

-- =====================================================
-- mkt_messages — per-recipient queue + idempotency ledger + tracking row
-- =====================================================
CREATE TABLE IF NOT EXISTS mkt_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES mkt_campaigns(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES mkt_contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'email',
  to_email TEXT,                              -- snapshotted at enqueue
  to_phone TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  -- queued | sending | sent | delivered | bounced | failed | skipped | opened | clicked
  skip_reason TEXT,                           -- unsubscribed | no_consent | cold_no_legal_basis | suppressed | invalid
  provider_message_id TEXT,                   -- Resend id / GOWA message id
  error TEXT,
  unsubscribe_token UUID NOT NULL DEFAULT gen_random_uuid(),
  attempts INT NOT NULL DEFAULT 0,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  CONSTRAINT uq_mkt_messages_campaign_contact UNIQUE (campaign_id, contact_id)
);
-- Drainer hot path: pull queued rows for a campaign.
CREATE INDEX IF NOT EXISTS idx_mkt_messages_queued
  ON mkt_messages (campaign_id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_mkt_messages_provider ON mkt_messages (provider_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mkt_messages_unsub_token ON mkt_messages (unsubscribe_token);

-- =====================================================
-- mkt_links — click-tracking link registry (rewrite target)
-- =====================================================
CREATE TABLE IF NOT EXISTS mkt_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES mkt_campaigns(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_links_campaign ON mkt_links (campaign_id);

-- =====================================================
-- mkt_events — append-only raw tracking events (open/click/bounce/complaint)
-- IP is minimized to a /24 (v4) or /48 (v6) subnet; documented legitimate
-- interest (art. 6(1)(f)). The mkt_messages columns are the rolled-up copy.
-- =====================================================
CREATE TABLE IF NOT EXISTS mkt_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES mkt_messages(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES mkt_campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES mkt_contacts(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                         -- open | click | bounce | complaint | unsubscribe | delivered
  url TEXT,                                   -- for clicks
  ip_trunc TEXT,                              -- minimized subnet, never the full IP
  user_agent TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT chk_mkt_events_type
    CHECK (type IN ('open','click','bounce','complaint','unsubscribe','delivered'))
);
CREATE INDEX IF NOT EXISTS idx_mkt_events_campaign ON mkt_events (campaign_id);
CREATE INDEX IF NOT EXISTS idx_mkt_events_message ON mkt_events (message_id);
