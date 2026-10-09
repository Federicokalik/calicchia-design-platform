-- Migration 159 — notifications / notification_preferences puntavano ancora
-- a auth.users (schema legacy Supabase, vuoto). Ogni INSERT falliva per FK e
-- nel cron promemoria domini l'eccezione interrompeva il ciclo dopo il primo
-- cliente. Gli utenti stanno in users (profiles.id = users.id).
--
-- NOT VALID: non verifica le righe già presenti (eventuali id legacy non
-- presenti in users), solo quelle nuove. Idempotente.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_user_id_fkey;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_user_id_fkey;
ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
