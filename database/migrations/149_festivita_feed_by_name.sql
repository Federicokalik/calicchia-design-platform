-- 149: correzione della 148 — in produzione il calendario festività esiste con
-- slug abbreviato ('f', creato a mano prima del cron), quindi il secondo UPDATE
-- della 148 (abilitazione feed ICS) filtrato su slug='festivita' non lo colpiva.
-- Ripetiamo l'abilitazione con il match per nome (il rename della 148 per nome
-- funzionava già). Idempotente.

UPDATE calendars
SET ics_feed_enabled = true,
    ics_feed_token = COALESCE(ics_feed_token, substr(md5(random()::text) || md5(random()::text), 1, 32))
WHERE slug = 'festivita' OR lower(name) IN ('festività', 'festività e chiusure');
