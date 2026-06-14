-- Migration 131 — WhatsApp: classificazione canali (kind) + correzione attribuzione mittente.
--
-- Contesto (bug GOWA v6+):
-- Il webhook handler leggeva i campi della VECCHIA forma di payload (Evolution
-- API / Baileys) invece di quella reale di GOWA go-whatsapp-web-multidevice v6+.
-- In particolare il flag "inviato da me" reale e' `is_from_me` (non `from_me`):
-- il vecchio check non scattava mai, quindi i messaggi inviati DAL TELEFONO
-- (fuori dal gestionale) venivano salvati come `direction='inbound',
-- sender_kind='user'` => apparivano inviati dal CLIENTE.
--
-- Questa migration:
--   1) Aggiunge `kind` a whatsapp_conversations per separare nell'inbox
--      chat / gruppi / broadcast / status / newsletter (oggi solo `is_group`).
--   2) Riclassifica lo storico mal attribuito sfruttando il payload integrale
--      conservato in whatsapp_messages.meta.raw (campo `is_from_me`).

-- =====================================================
-- 1) Colonna kind + backfill
-- =====================================================
ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'chat'
  CHECK (kind IN ('chat','group','broadcast','status','newsletter'));

-- Backfill da chat_id (piu' specifico) e da is_group come fallback.
UPDATE public.whatsapp_conversations
SET kind = CASE
  WHEN chat_id = 'status@broadcast'        THEN 'status'
  WHEN chat_id LIKE '%@broadcast'          THEN 'broadcast'
  WHEN chat_id LIKE '%@newsletter'         THEN 'newsletter'
  WHEN chat_id LIKE '%@g.us' OR is_group   THEN 'group'
  ELSE 'chat'
END;

CREATE INDEX IF NOT EXISTS idx_wa_conv_kind
  ON public.whatsapp_conversations (kind);

COMMENT ON COLUMN public.whatsapp_conversations.kind IS
  'Tipo di conversazione per la separazione in inbox: chat (1:1), group (@g.us), '
  'broadcast (liste @broadcast), status (status@broadcast), newsletter (@newsletter). '
  'is_group resta valorizzato per retrocompat (kind=group).';

-- =====================================================
-- 2) Correzione storico: messaggi miei (dal telefono) salvati come inbound.
-- =====================================================
-- I messaggi inseriti via webhook conservano il payload GOWA in meta.raw
-- (vedi stripBig in routes/whatsapp.ts), che include is_from_me. Le righe
-- inserite PRIMA che il payload venisse conservato non sono recuperabili
-- (meta.raw assente) e restano invariate: e' accettabile.
UPDATE public.whatsapp_messages
SET direction   = 'outbound',
    sender_kind = 'admin',
    category    = 'operational',
    meta        = meta || '{"via":"phone"}'::jsonb
WHERE direction = 'inbound'
  AND (meta -> 'raw' ->> 'is_from_me') = 'true';
