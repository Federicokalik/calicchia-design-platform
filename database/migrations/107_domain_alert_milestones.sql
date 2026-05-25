-- Tracking delle "milestone" di alert già emesse per ogni dominio.
-- Il cron domain-alerts gira ogni ~16h e per ogni dominio in scadenza
-- entro 30 giorni emette `fireEvent('dominio_scadenza', ...)` quando
-- entra in una milestone (30, 14, 7, 1 giorno). last_alert_milestone
-- memorizza la milestone più piccola gia' notificata, in modo che il
-- cron non emetta lo stesso alert ogni run.
--
-- Esempio: dominio a 25gg → milestone 30 (gia' < 30) emessa, salvato 30.
-- 8 giorni dopo (17gg) → 17 <= 14, milestone 14 (< 30), emette + salva 14.
-- E cosi' via fino a 1gg.

ALTER TABLE public.domains
  ADD COLUMN IF NOT EXISTS last_alert_milestone INTEGER;

COMMENT ON COLUMN public.domains.last_alert_milestone IS
  'Minima milestone (30/14/7/1) gia notificata via fireEvent. NULL = mai notificato.';
