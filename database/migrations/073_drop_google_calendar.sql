-- 073_drop_google_calendar.sql - Rimuove integrazione Google Calendar legacy
--
-- Google Workspace dismesso. Token OAuth invalidati e storico Google rimosso.

DROP TABLE IF EXISTS google_oauth_tokens CASCADE;
DROP TABLE IF EXISTS google_calendar_events CASCADE;
DROP TABLE IF EXISTS google_sync_log CASCADE;

-- Sanity: assicura rimozione completa anche in DB legacy parzialmente aggiornati
DROP TABLE IF EXISTS legacy_google_calendar_events CASCADE;
DROP TABLE IF EXISTS legacy_google_sync_log CASCADE;
DROP TABLE IF EXISTS google_calendar_tokens CASCADE;
DROP TABLE IF EXISTS google_calendar_credentials CASCADE;
