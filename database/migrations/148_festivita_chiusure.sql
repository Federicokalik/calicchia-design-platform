-- 148: il calendario di sistema "Festività" diventa "Festività e chiusure".
--
-- Oltre alle festività IT auto-gestite dal cron (source='system'), il calendario
-- ospita ora anche le chiusure manuali dal–al (ferie, ponti) inserite dall'admin
-- via route /api/admin/calendar/closures (source='admin', eventi timed 00:00→24:00
-- che bloccano gli slot di prenotazione).
--
-- Abilita inoltre il feed ICS abbonabile (telefono/altri client): genera il token
-- se mancante. L'hex md5 usa solo [0-9a-f] ⊂ [a-z0-9]{32} richiesto dalla
-- validazione della route feed.

UPDATE calendars
SET name = 'Festività e chiusure',
    description = 'Festività nazionali italiane (auto) e chiusure manuali (ferie, ponti)'
WHERE slug = 'festivita' OR lower(name) = 'festività';

UPDATE calendars
SET ics_feed_enabled = true,
    ics_feed_token = COALESCE(ics_feed_token, substr(md5(random()::text) || md5(random()::text), 1, 32))
WHERE slug = 'festivita';
