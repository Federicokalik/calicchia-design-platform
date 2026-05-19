-- Migration 096 — WhatsApp integration (GOWA self-hosted) + communication preferences.
--
-- Contesto (decision 2026-05-19):
-- Integrazione di GOWA (go-whatsapp-web-multidevice) su gowa.calicchia.design come
-- gateway WhatsApp self-hosted. La feature precedente Evolution API viene
-- decommissionata. Salviamo la cronologia messaggi nel nostro Postgres (non solo
-- in GOWA) per: GDPR control, inbox admin con search/AI, retention granulare
-- per categoria, audit completo degli outbound.
--
-- Tre tabelle nuove:
--   - whatsapp_sessions          (1 riga: sessione GOWA attiva — già pronto per
--                                 multi-device futuro senza migration distruttiva)
--   - whatsapp_conversations     (1 per chat_id, con link opzionale a customer/lead)
--   - whatsapp_messages          (inbound + outbound, con sender_kind per audit
--                                 e ai_draft per il flusso triage)
--
-- E una tabella nuova trasversale ai canali:
--   - communication_preferences  (opt-in/opt-out per categoria: transactional,
--                                 operational, marketing — allineato GDPR-COMPLIANCE.md)
--
-- Base giuridica per categoria (vedi GDPR-COMPLIANCE.md):
--   transactional → Art. 6(1)(b) GDPR — contrattuale (fatture, scadenze, sicurezza).
--                   Sempre attivo, non disattivabile dal cliente.
--   operational   → Art. 6(1)(f) — legittimo interesse (reminder appuntamenti,
--                   follow-up progetti). Opt-out (default ON, disattivabile).
--   marketing     → Art. 6(1)(a) — consenso (offerte, newsletter WA).
--                   Opt-in (default OFF, richiede attivazione esplicita).

-- =====================================================
-- 1) Sessione GOWA
-- =====================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       TEXT UNIQUE NOT NULL,                  -- jid GOWA (es. 39...@s.whatsapp.net)
  display_name    TEXT,
  phone           TEXT,                                  -- numero owner della sessione
  status          TEXT NOT NULL DEFAULT 'disconnected'
                  CHECK (status IN ('disconnected','connecting','qr','connected','error')),
  last_seen_at    TIMESTAMPTZ,
  last_error      TEXT,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.whatsapp_sessions IS
  'Stato delle sessioni GOWA. Fase 1: single-device, una sola riga "primary".';

-- =====================================================
-- 2) Conversazioni
-- =====================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id               TEXT NOT NULL,                   -- es. 39123456789@c.us
  phone                 TEXT NOT NULL,                   -- normalizzato E.164 senza +
  contact_name          TEXT,                            -- pushname WhatsApp
  is_group              BOOLEAN NOT NULL DEFAULT FALSE,
  customer_id           UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  lead_id               UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  ai_mode               TEXT NOT NULL DEFAULT 'off'
                        CHECK (ai_mode IN ('off','triage','auto_reply')),
  last_message_at       TIMESTAMPTZ,
  last_message_preview  TEXT,
  unread_count          INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  archived              BOOLEAN NOT NULL DEFAULT FALSE,
  meta                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_conv_phone
  ON public.whatsapp_conversations (phone);
CREATE INDEX IF NOT EXISTS idx_wa_conv_customer
  ON public.whatsapp_conversations (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_conv_lead
  ON public.whatsapp_conversations (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_conv_unread
  ON public.whatsapp_conversations (unread_count) WHERE unread_count > 0;
CREATE INDEX IF NOT EXISTS idx_wa_conv_last_msg
  ON public.whatsapp_conversations (last_message_at DESC NULLS LAST);

COMMENT ON COLUMN public.whatsapp_conversations.ai_mode IS
  'off = nessun intervento AI. triage = AI prepara una bozza salvata come '
  'ai_draft=true, admin approva e invia. auto_reply = AI invia direttamente.';

-- =====================================================
-- 3) Messaggi
-- =====================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id        UUID NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  external_id            TEXT,                           -- GOWA message id (opzionale per bozze)
  direction              TEXT NOT NULL
                         CHECK (direction IN ('inbound','outbound')),
  category               TEXT NOT NULL DEFAULT 'operational'
                         CHECK (category IN ('transactional','operational','marketing','inbound')),
  type                   TEXT NOT NULL DEFAULT 'text'
                         CHECK (type IN ('text','image','document','audio','video','sticker','location','contact','reaction','system')),
  body                   TEXT,
  media_path             TEXT,                           -- relativo a UPLOAD_DIR (es. whatsapp/<uuid>.<ext>)
  media_mime             TEXT,
  media_size             INTEGER,
  reply_to_external_id   TEXT,
  ack_status             TEXT,                           -- sent/delivered/read (da webhook message.ack)
  sender_kind            TEXT NOT NULL DEFAULT 'user'
                         CHECK (sender_kind IN ('user','admin','ai','workflow','system')),
  sender_user_id         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ai_draft               BOOLEAN NOT NULL DEFAULT FALSE,
  ai_draft_approved_at   TIMESTAMPTZ,
  ai_draft_approved_by   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  meta                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- external_id unico ma nullable (bozze AI non lo hanno finché non inviate).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_msg_external_id
  ON public.whatsapp_messages (external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wa_msg_conv_created
  ON public.whatsapp_messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_msg_ai_draft
  ON public.whatsapp_messages (conversation_id, ai_draft) WHERE ai_draft = TRUE;
CREATE INDEX IF NOT EXISTS idx_wa_msg_media_pending
  ON public.whatsapp_messages (id)
  WHERE media_path IS NULL AND type IN ('image','document','audio','video','sticker');

COMMENT ON COLUMN public.whatsapp_messages.category IS
  'transactional|operational|marketing per outbound (enforcement opt-out). '
  'inbound usato per messaggi entranti dal cliente — non soggetti a opt-out.';

-- =====================================================
-- 4) Preferenze di comunicazione (multi-canale, multi-categoria)
-- =====================================================
CREATE TABLE IF NOT EXISTS public.communication_preferences (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id              UUID UNIQUE REFERENCES public.customers(id) ON DELETE CASCADE,
  lead_id                  UUID UNIQUE REFERENCES public.leads(id) ON DELETE CASCADE,
  -- Identificatori per soggetti non ancora customer/lead (lookup da phone/email).
  email                    TEXT,
  phone                    TEXT,                          -- normalizzato E.164 senza +
  -- WhatsApp: transactional sempre TRUE (base contrattuale, non disattivabile);
  -- operational default ON (opt-out); marketing default OFF (opt-in).
  whatsapp_transactional   BOOLEAN NOT NULL DEFAULT TRUE,
  whatsapp_operational     BOOLEAN NOT NULL DEFAULT TRUE,
  whatsapp_marketing       BOOLEAN NOT NULL DEFAULT FALSE,
  -- Email: transactional implicito (non lo trackiamo qui per ora — viene gestito
  -- da invoices/quotes), operational e marketing toggleable.
  email_operational        BOOLEAN NOT NULL DEFAULT TRUE,
  email_marketing          BOOLEAN NOT NULL DEFAULT FALSE,
  -- SMS: solo transactional (2FA, conferme), opt-in esplicito.
  sms_transactional        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Token per link "modifica preferenze" via WA/email (no login richiesto).
  preferences_token        TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  updated_via              TEXT,                          -- 'portal'|'admin'|'wa-stop'|'email-link'|'public-token'
  updated_by               UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    customer_id IS NOT NULL
    OR lead_id IS NOT NULL
    OR email IS NOT NULL
    OR phone IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_comm_prefs_phone
  ON public.communication_preferences (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comm_prefs_email
  ON public.communication_preferences (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comm_prefs_token
  ON public.communication_preferences (preferences_token);

COMMENT ON TABLE public.communication_preferences IS
  'Preferenze multi-canale per categoria. Lookup gerarchico: customer_id > lead_id '
  '> phone > email. Transactional WhatsApp NON disattivabile (Art. 6(1)(b) GDPR).';

-- =====================================================
-- 5) Trigger updated_at standard (definita in 001_initial_schema.sql)
-- =====================================================
DROP TRIGGER IF EXISTS trg_wa_sessions_updated ON public.whatsapp_sessions;
CREATE TRIGGER trg_wa_sessions_updated
  BEFORE UPDATE ON public.whatsapp_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_wa_conv_updated ON public.whatsapp_conversations;
CREATE TRIGGER trg_wa_conv_updated
  BEFORE UPDATE ON public.whatsapp_conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_comm_prefs_updated ON public.communication_preferences;
CREATE TRIGGER trg_comm_prefs_updated
  BEFORE UPDATE ON public.communication_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
