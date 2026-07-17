-- 147_calendar_events_system_source.sql — source 'system' per eventi auto-gestiti
--
-- Il cron italian-holidays scriveva source='admin' come ripiego semantico
-- (il CHECK non prevedeva un valore per eventi generati dal sistema). Si
-- aggiunge 'system' al CHECK e si ri-classificano le festività esistenti
-- (riconoscibili dal source_id stabile 'it-holiday-YYYY-MM-DD').

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_source_check;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_source_check
  CHECK (source IN ('manual','booking','admin','mcp','agent','ics_pull','system'));

UPDATE calendar_events
SET source = 'system'
WHERE source = 'admin' AND source_id LIKE 'it-holiday-%';
