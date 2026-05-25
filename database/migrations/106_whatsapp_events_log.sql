-- Audit log per gli eventi WhatsApp NON-message ricevuti via webhook GOWA.
-- Copre: chat_presence, group.participants, group.joined, newsletter.*
-- (joined/left/message/mute), call.offer.
--
-- Per i messaggi veri (event = 'message' e family) abbiamo gia' la coppia
-- whatsapp_conversations + whatsapp_messages (mig 096). Qui salviamo invece
-- gli eventi "side-channel" con un JSONB per non perderli, senza dover
-- progettare un dominio dedicato per ognuno. Quando una di queste classi di
-- eventi acquisira' UI dedicata in admin, si potra' estrarre uno schema piu'
-- normalizzato dal payload conservato.

CREATE TABLE IF NOT EXISTS public.whatsapp_events_log (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT NOT NULL,
  device_id     TEXT,             -- GOWA v8+: device che ha ricevuto l'evento
  chat_id       TEXT,             -- estratto dal payload quando disponibile
  from_jid      TEXT,             -- mittente (group event / call / typing source)
  payload       JSONB NOT NULL,   -- evento integrale GOWA
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_events_received
  ON public.whatsapp_events_log (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_wa_events_type_received
  ON public.whatsapp_events_log (event_type, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_wa_events_chat
  ON public.whatsapp_events_log (chat_id)
  WHERE chat_id IS NOT NULL;

-- TTL applicativo: gli eventi side-channel sono utili ~30 giorni a fini
-- diagnostici, poi possono essere purgati. Implementare via cron job se la
-- tabella cresce troppo.
COMMENT ON TABLE public.whatsapp_events_log IS
  'Audit per eventi WhatsApp non-message (group/newsletter/presence/call). Purgare oltre 30 giorni.';
