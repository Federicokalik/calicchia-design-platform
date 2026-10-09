-- Inventario calendario in produzione (SOLA LETTURA). Eseguire con psql sul DB di produzione.

-- Sessione: eseguire tutto dentro una transazione in sola lettura
BEGIN READ ONLY; SET LOCAL TIME ZONE 'UTC';

-- 1) Calendari e metadati (slug reali, compreso 'f')
SELECT id, slug, name, is_system, is_default, blocks_availability, timezone, ics_feed_enabled, sort_order, length(ics_feed_token) AS token_len, created_at FROM calendars ORDER BY sort_order, name;

-- 2) Eventi per calendario e source: singoli, serie, override, cancellati, all-day ricorrenti, exdates, tentative, intervallo temporale
SELECT c.slug, e.source,
  count(*) FILTER (WHERE e.recurrence_master_id IS NULL AND e.rrule IS NULL) AS singoli,
  count(*) FILTER (WHERE e.recurrence_master_id IS NULL AND e.rrule IS NOT NULL) AS serie,
  count(*) FILTER (WHERE e.recurrence_master_id IS NOT NULL AND e.status <> 'cancelled') AS override_modificati,
  count(*) FILTER (WHERE e.recurrence_master_id IS NOT NULL AND e.status = 'cancelled') AS override_cancellati,
  count(*) FILTER (WHERE e.recurrence_master_id IS NULL AND e.status = 'cancelled') AS master_o_singoli_cancellati,
  count(*) FILTER (WHERE e.all_day AND e.rrule IS NOT NULL) AS allday_ricorrenti,
  count(*) FILTER (WHERE jsonb_array_length(e.exdates) > 0) AS con_exdates,
  count(*) FILTER (WHERE e.status = 'tentative') AS tentative,
  min(e.start_time) AS primo, max(e.end_time) AS ultimo
FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
GROUP BY c.slug, e.source ORDER BY c.slug, e.source;

-- 3) Override con calendario diverso dal master, oppure master senza RRULE (orfani strutturali)
SELECT o.id, o.uid, oc.slug AS cal_override, mc.slug AS cal_master, o.recurrence_id, o.status, m.rrule
FROM calendar_events o JOIN calendar_events m ON m.id = o.recurrence_master_id
JOIN calendars oc ON oc.id = o.calendar_id JOIN calendars mc ON mc.id = m.calendar_id
WHERE o.calendar_id <> m.calendar_id OR m.rrule IS NULL;

-- 4) Override oltre l'UNTIL del master (residui di 'questa e le successive')
SELECT o.id, m.id AS master_id, m.rrule, o.recurrence_id
FROM calendar_events o JOIN calendar_events m ON m.id = o.recurrence_master_id
WHERE m.rrule ~ 'UNTIL=\d{8}T\d{6}Z'
  AND o.recurrence_id > to_timestamp(substring(m.rrule from 'UNTIL=(\d{8}T\d{6})Z'), 'YYYYMMDD"T"HH24MISS');

-- 5) Pattern UNTIL: mezzanotte UTC (bug 'fino al'), all-day con UNTIL DATE-TIME, UNTIL prima di DTSTART (rifiutato da Radicale)
SELECT c.slug, e.id, e.summary, e.all_day, e.start_time, e.rrule,
  (e.rrule ~ 'UNTIL=\d{8}T000000Z') AS until_mezzanotte_utc,
  (e.all_day AND e.rrule ~ 'UNTIL=\d{8}T\d{6}Z') AS allday_until_datetime,
  (e.rrule ~ 'UNTIL=\d{8}T\d{6}Z' AND to_timestamp(substring(e.rrule from 'UNTIL=(\d{8}T\d{6})Z'), 'YYYYMMDD"T"HH24MISS') < e.start_time) AS until_prima_di_dtstart
FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
WHERE e.rrule ~ 'UNTIL=' ORDER BY c.slug;

-- 6) Distribuzione FREQ e rischio limite Radicale (stima come Radicale 3.7.8; limite previsto 50000) e serie iniziate molti anni fa (budget di espansione)
SELECT id, substring(rrule from 'FREQ=([A-Z]+)') AS freq, rrule, start_time,
  round(EXTRACT(EPOCH FROM (to_timestamp(substring(rrule from 'UNTIL=(\d{8}T\d{6})Z'), 'YYYYMMDD"T"HH24MISS') - start_time)) /
    CASE substring(rrule from 'FREQ=([A-Z]+)') WHEN 'YEARLY' THEN 31536000 WHEN 'MONTHLY' THEN 2628000 WHEN 'WEEKLY' THEN 604800 WHEN 'DAILY' THEN 86400 WHEN 'HOURLY' THEN 3600 WHEN 'MINUTELY' THEN 60 ELSE 1 END) AS stima_occorrenze,
  (rrule ~ 'COUNT=' AND substring(rrule from 'COUNT=(\d+)')::int > 5000) AS count_alto,
  (rrule !~ 'UNTIL=|COUNT=') AS infinita,
  (start_time < now() - interval '5 years') AS iniziata_da_oltre_5_anni
FROM calendar_events WHERE rrule IS NOT NULL ORDER BY stima_occorrenze DESC NULLS LAST LIMIT 50;

-- 7) Convenzioni all-day (mezzanotte UTC = import, mezzanotte Roma = admin, ambigui)
SELECT c.slug, c.timezone,
  count(*) FILTER (WHERE to_char(e.start_time AT TIME ZONE 'UTC', 'HH24:MI') = '00:00') AS mezzanotte_utc,
  count(*) FILTER (WHERE to_char(e.start_time AT TIME ZONE 'Europe/Rome', 'HH24:MI') = '00:00') AS mezzanotte_roma,
  count(*) FILTER (WHERE to_char(e.start_time AT TIME ZONE 'UTC', 'HH24:MI') <> '00:00' AND to_char(e.start_time AT TIME ZONE 'Europe/Rome', 'HH24:MI') <> '00:00') AS ambigui
FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE e.all_day GROUP BY 1, 2;

-- 8) Serie in calendari con fuso diverso da Europe/Rome
SELECT c.slug, c.timezone, count(*) AS serie FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
WHERE e.rrule IS NOT NULL AND c.timezone <> 'Europe/Rome' GROUP BY 1, 2;

-- 9) RRULE sintatticamente sospette
SELECT id, calendar_id, rrule FROM calendar_events
WHERE rrule IS NOT NULL AND (rrule !~ '^(FREQ=|[A-Z]+=)' OR rrule ~ 'BYDAY=[^;]*[^A-Z0-9,+-]');

-- 10) Festività: duplicati per data e chiusure manuali nel calendario di sistema (anche create da editor o MCP)
SELECT source_id, count(*) FROM calendar_events WHERE source = 'system' GROUP BY 1 HAVING count(*) > 1;
SELECT c.slug, e.source, count(*) AS eventi, min(e.start_time), max(e.end_time) FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE c.is_system AND c.slug <> 'bookings' AND e.source <> 'system' GROUP BY 1, 2;

-- 11) Proiezioni delle prenotazioni: copertura, duplicati, orfane, orari divergenti
SELECT b.status, count(*) AS prenotazioni, count(e.id) FILTER (WHERE e.status = 'confirmed') AS proiezione_attiva, count(*) FILTER (WHERE e.id IS NULL) AS senza_proiezione
FROM calendar_bookings b LEFT JOIN calendar_events e ON e.source = 'booking' AND e.source_id = b.uid GROUP BY b.status;
SELECT source_id, count(*) FROM calendar_events WHERE source = 'booking' GROUP BY 1 HAVING count(*) > 1;
SELECT e.id, e.source_id, e.status, b.status AS booking_status FROM calendar_events e LEFT JOIN calendar_bookings b ON b.uid = e.source_id
WHERE e.source = 'booking' AND (b.uid IS NULL OR (b.status NOT IN ('confirmed','completed','no_show') AND e.status <> 'cancelled'));
SELECT b.uid, b.start_time, e.start_time AS evento_start FROM calendar_bookings b JOIN calendar_events e ON e.source = 'booking' AND e.source_id = b.uid
WHERE e.status = 'confirmed' AND (e.start_time <> b.start_time OR e.end_time <> b.end_time);

-- 12) Eventi NON di prenotazione dentro il calendario bookings (anomalia NON_PROJECTION_IN_BOOKINGS)
SELECT e.source, e.status, count(*), min(e.start_time), max(e.end_time)
FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
WHERE c.slug = 'bookings' AND e.source <> 'booking' GROUP BY 1, 2;

-- 13) Prenotazioni future per stato (volume della proiezione da creare)
SELECT status, count(*) FROM calendar_bookings WHERE end_time > now() GROUP BY 1;

-- 14) Iscrizioni ICS (solo l'host dell'URL), righe reali, trappola etag/304, impatto sul busy nei prossimi 180 giorni
SELECT s.id, s.name, c.slug AS destinazione, c.blocks_availability, substring(s.ics_url from '^https?://[^/]+') AS host,
  s.sync_enabled, s.event_count, (SELECT count(*) FROM calendar_events e WHERE e.subscription_id = s.id) AS righe_reali,
  s.last_error, s.etag IS NOT NULL AS has_etag, s.last_modified IS NOT NULL AS has_last_modified, s.last_synced_at,
  (SELECT round(COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(e.end_time, now() + interval '180 days') - GREATEST(e.start_time, now()))) / 3600), 0)::numeric, 1)
     FROM calendar_events e WHERE e.subscription_id = s.id AND NOT e.all_day AND e.status = 'confirmed'
       AND e.end_time > now() AND e.start_time < now() + interval '180 days') AS ore_busy_180g_oggi
FROM calendar_subscriptions s JOIN calendars c ON c.id = s.calendar_id ORDER BY s.created_at;

-- 15) App-password: username reali (principal canonico 'federico'; i caldes-* sono riservati), uso effettivo
SELECT username, (username <> 'federico') AS non_canonico, (username ILIKE 'caldes-%') AS riservato, device_name, is_active, revoked_at IS NOT NULL AS revocata, expires_at, last_used_at, last_used_ip, usage_count, created_at
FROM caldav_app_passwords ORDER BY last_used_at DESC NULLS LAST;

-- 16) Workflow salvati che leggono tabelle calendario (allowlist di tool_db_query)
SELECT id, name, status, last_executed_at FROM workflows WHERE nodes::text ~* 'calendar_events|calendar_subscriptions|\mcalendars\M';

-- 17) UID non sicuri come nome file e testi lunghi
SELECT count(*) FILTER (WHERE uid !~ '^[A-Za-z0-9._@-]{1,200}$') AS uid_non_sicuri, max(length(summary)) AS max_summary, max(length(description)) AS max_description FROM calendar_events;

-- 18) Orizzonte: max_advance_days degli event types (garanzia horizon >= max + 14 giorni)
SELECT slug, is_active, is_public, max_advance_days, min_notice_hours FROM calendar_event_types ORDER BY max_advance_days DESC;

-- 19) Eccezioni salvate prima del fix DST (d046006): stessa ora UTC del DTSTART ma ora locale di Roma diversa. Applicazione della 158 = deploy del fix
SELECT version, applied_at FROM schema_migrations WHERE version LIKE '158%';
SELECT 'override' AS tipo, c.slug, m.id AS master_id, o.id AS eccezione_id, m.start_time AS dtstart, o.recurrence_id AS valore, o.created_at
FROM calendar_events o JOIN calendar_events m ON m.id = o.recurrence_master_id JOIN calendars c ON c.id = m.calendar_id
WHERE m.rrule IS NOT NULL AND NOT m.all_day
  AND to_char(o.recurrence_id AT TIME ZONE 'UTC', 'HH24:MI') = to_char(m.start_time AT TIME ZONE 'UTC', 'HH24:MI')
  AND to_char(o.recurrence_id AT TIME ZONE 'Europe/Rome', 'HH24:MI') <> to_char(m.start_time AT TIME ZONE 'Europe/Rome', 'HH24:MI')
UNION ALL
SELECT 'exdate', c.slug, m.id, NULL, m.start_time, x.v::timestamptz, m.updated_at
FROM calendar_events m JOIN calendars c ON c.id = m.calendar_id, LATERAL jsonb_array_elements_text(m.exdates) AS x(v)
WHERE m.rrule IS NOT NULL AND NOT m.all_day
  AND to_char(x.v::timestamptz AT TIME ZONE 'UTC', 'HH24:MI') = to_char(m.start_time AT TIME ZONE 'UTC', 'HH24:MI')
  AND to_char(x.v::timestamptz AT TIME ZONE 'Europe/Rome', 'HH24:MI') <> to_char(m.start_time AT TIME ZONE 'Europe/Rome', 'HH24:MI')
ORDER BY 2, 3;

-- 20) Attività recente sul calendario e dimensioni delle tabelle (anche audit_logs con PII nella DESCRIPTION)
SELECT table_name, action, count(*), max(created_at) FROM audit_logs WHERE table_name IN ('calendar_events','calendars','calendar_subscriptions') AND created_at > now() - interval '90 days' GROUP BY 1, 2 ORDER BY 1, 2;
SELECT count(*) AS audit_righe_eventi_booking FROM audit_logs WHERE table_name = 'calendar_events' AND (new_data->>'source' = 'booking' OR old_data->>'source' = 'booking');
SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_stat_user_tables WHERE relname IN ('calendars','calendar_events','calendar_subscriptions','calendar_bookings','caldav_app_passwords','audit_logs') ORDER BY relname;
COMMIT;

ROLLBACK;
