-- Migration 158 — Il calendario "Festività e chiusure" è di sistema.
--
-- getOrCreateFestivitaCalendar() lo creava con is_system=false (createCalendar
-- forzava false): la pagina Calendari mostrava il cestino e l'eliminazione
-- cancellava in cascata tutti gli eventi, comprese le chiusure manuali
-- (ferie, ponti) che il cron delle festività non ricrea. Stessa lookup del
-- codice (slug o nome storico). Idempotente.

UPDATE calendars SET is_system = true
WHERE (slug = 'festivita' OR lower(name) IN ('festività', 'festività e chiusure'))
  AND is_system = false;
