-- Inventario del calendario prima del passaggio a Radicale: SOLA LETTURA.
--
-- Fase F0, attività 1 del piano (docs/calendar-radicale/piano.md); anomalie
-- del design §13.4. Copia adattata di docs/calendar-radicale/inventario-produzione.sql:
--  - ogni query ha una chiave stabile e un titolo, per il report JSON/Markdown
--    di scripts/calendar-inventory.ts;
--  - le annotazioni @anomaly collegano i risultati ai codici del design;
--  - stima delle occorrenze allineata a Radicale 3.7.8 (COUNT, oppure
--    (UNTIL - DTSTART) / intervallo della FREQ) anche con UNTIL di sola data;
--  - righe in più per riconoscere la trappola etag/304 delle iscrizioni
--    (ICS_PULL_REFETCH), le app-password attive non canoniche e le
--    occorrenze oltre il limite di Radicale;
--  - controllo di BYDAY della query 09 senza il falso positivo sul ';';
--  - IP delle app-password mascherati (ultimo ottetto o ultimi gruppi IPv6):
--    per l'inventario serve sapere se un device è attivo, non da dove.
--
-- Formato (letto da scripts/calendar-inventory.ts):
--   -- @query <chiave> | <titolo>
--   -- <righe di commento: descrizione della query nel report>
--   -- @anomaly <CODICE>                  conteggio = numero di righe
--   -- @anomaly <CODICE> when=<colonna>   conteggio = righe con la colonna booleana vera
--   -- @anomaly <CODICE> sum=<colonna>    conteggio = somma della colonna
--   <una sola istruzione SELECT o WITH ... SELECT, terminata da ';'>
--   ...
--   -- @end
-- Lo script esegue ogni query in un savepoint della stessa transazione
-- REPEATABLE READ READ ONLY (una query fallita non ferma le altre) e ignora
-- tutto ciò che sta prima della prima @query e dopo @end.
--
-- Uso manuale, senza lo script:
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -P pager=off -f calendar-inventory.sql

SET default_transaction_read_only = on;
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';

-- @query 00_sessione | Sessione e database
-- Database, versione, stato di sola lettura e snapshot della transazione: lo
-- script si ferma se transaction_read_only non è 'on'.
SELECT current_database() AS database,
  current_setting('server_version') AS server_version,
  current_setting('transaction_read_only') AS transaction_read_only,
  current_setting('default_transaction_read_only') AS default_transaction_read_only,
  current_setting('transaction_isolation') AS isolamento,
  current_setting('TimeZone') AS fuso,
  now() AS snapshot_at,
  (SELECT max(version) FILTER (WHERE version ~ '^\d') FROM schema_migrations) AS ultima_migrazione,
  (SELECT count(*) FROM schema_migrations) AS migrazioni_applicate;

-- @query 01_calendari | Calendari e metadati
-- Slug reali (compreso 'f' delle festività), flag, fuso, feed ICS (solo la
-- lunghezza del token, mai il token).
SELECT id, slug, name, is_system, is_default, blocks_availability, timezone, ics_feed_enabled, sort_order,
  length(ics_feed_token) AS token_len, created_at
FROM calendars
ORDER BY sort_order, name;

-- @query 02_eventi_per_calendario | Eventi per calendario e provenienza
-- Singoli, serie, override modificati e cancellati, master cancellati, all-day
-- ricorrenti, eventi con exdates, tentative e intervallo temporale.
SELECT c.slug, e.source,
  count(*) FILTER (WHERE e.recurrence_master_id IS NULL AND e.rrule IS NULL) AS singoli,
  count(*) FILTER (WHERE e.recurrence_master_id IS NULL AND e.rrule IS NOT NULL) AS serie,
  count(*) FILTER (WHERE e.recurrence_master_id IS NOT NULL AND e.status <> 'cancelled') AS override_modificati,
  count(*) FILTER (WHERE e.recurrence_master_id IS NOT NULL AND e.status = 'cancelled') AS override_cancellati,
  count(*) FILTER (WHERE e.recurrence_master_id IS NULL AND e.status = 'cancelled') AS master_o_singoli_cancellati,
  count(*) FILTER (WHERE e.all_day AND e.rrule IS NOT NULL) AS allday_ricorrenti,
  count(*) FILTER (WHERE jsonb_array_length(e.exdates) > 0) AS con_exdates,
  count(*) FILTER (WHERE e.status = 'tentative') AS tentative,
  min(e.start_time) AS primo,
  max(e.end_time) AS ultimo
FROM calendar_events e
JOIN calendars c ON c.id = e.calendar_id
GROUP BY c.slug, e.source
ORDER BY c.slug, e.source;

-- @query 03_override_strutturali | Override in un calendario diverso dal master o con master senza RRULE
-- Orfani strutturali: in Radicale l'override vive nella risorsa del master.
-- @anomaly OVERRIDE_CALENDAR_MISMATCH
SELECT o.id, o.uid, oc.slug AS cal_override, mc.slug AS cal_master, o.recurrence_id, o.status, m.rrule
FROM calendar_events o
JOIN calendar_events m ON m.id = o.recurrence_master_id
JOIN calendars oc ON oc.id = o.calendar_id
JOIN calendars mc ON mc.id = m.calendar_id
WHERE o.calendar_id <> m.calendar_id OR m.rrule IS NULL
ORDER BY mc.slug, o.recurrence_id;

-- @query 04_override_oltre_until | Override oltre l'UNTIL del master
-- Residui di "questa e le successive": l'occorrenza non esiste più nella regola.
-- @anomaly ORPHAN_OVERRIDE_NOT_IN_RULE
SELECT o.id, m.id AS master_id, m.rrule, o.recurrence_id, o.status
FROM calendar_events o
JOIN calendar_events m ON m.id = o.recurrence_master_id
WHERE m.rrule ~ 'UNTIL=\d{8}T\d{6}Z'
  AND o.recurrence_id > to_timestamp(substring(m.rrule from 'UNTIL=(\d{8}T\d{6})Z'), 'YYYYMMDD"T"HH24MISS')
ORDER BY m.id, o.recurrence_id;

-- @query 05_until | Pattern di UNTIL
-- Mezzanotte UTC (bug "fino al" dell'editor), all-day con UNTIL DATE-TIME,
-- UNTIL prima del DTSTART (rifiutato da Radicale con 400).
-- @anomaly UNTIL_ADMIN_PATTERN when=until_mezzanotte_utc
-- @anomaly ALLDAY_UNTIL_DATETIME when=allday_until_datetime
-- @anomaly UNTIL_BEFORE_DTSTART when=until_prima_di_dtstart
WITH r AS (
  SELECT e.id, e.calendar_id, e.summary, e.all_day, e.start_time, e.rrule,
    CASE
      WHEN e.rrule ~ 'UNTIL=\d{8}T\d{6}' THEN to_timestamp(substring(e.rrule from 'UNTIL=(\d{8}T\d{6})'), 'YYYYMMDD"T"HH24MISS')
      WHEN e.rrule ~ 'UNTIL=\d{8}' THEN to_timestamp(substring(e.rrule from 'UNTIL=(\d{8})'), 'YYYYMMDD')
    END AS until_ts
  FROM calendar_events e
  WHERE e.rrule ~ 'UNTIL='
)
SELECT c.slug, r.id, r.summary, r.all_day, r.start_time, r.rrule,
  (r.rrule ~ 'UNTIL=\d{8}T000000Z') AS until_mezzanotte_utc,
  (r.all_day AND r.rrule ~ 'UNTIL=\d{8}T\d{6}') AS allday_until_datetime,
  COALESCE(r.until_ts < r.start_time, false) AS until_prima_di_dtstart
FROM r
JOIN calendars c ON c.id = r.calendar_id
ORDER BY c.slug, r.start_time;

-- @query 06_rrule_limite_radicale | Stima delle occorrenze e limite di Radicale (50000)
-- Stima come Radicale 3.7.8 (item/__init__.py): COUNT se presente, altrimenti
-- (UNTIL - DTSTART) / intervallo della FREQ (anno 365 giorni, mese 365/12),
-- ignorando INTERVAL e BY*. Le serie infinite passano la stima ma pesano
-- sull'espansione (budget dell'indice). Prime 50 per stima.
-- @anomaly RADICALE_RRULE_LIMIT when=oltre_limite_radicale
WITH r AS (
  SELECT e.id, e.calendar_id, e.rrule, e.start_time,
    substring(e.rrule from 'FREQ=([A-Z]+)') AS freq,
    substring(e.rrule from 'COUNT=(\d+)')::numeric AS count_val,
    CASE
      WHEN e.rrule ~ 'UNTIL=\d{8}T\d{6}' THEN to_timestamp(substring(e.rrule from 'UNTIL=(\d{8}T\d{6})'), 'YYYYMMDD"T"HH24MISS')
      WHEN e.rrule ~ 'UNTIL=\d{8}' THEN to_timestamp(substring(e.rrule from 'UNTIL=(\d{8})'), 'YYYYMMDD')
    END AS until_ts
  FROM calendar_events e
  WHERE e.rrule IS NOT NULL
), s AS (
  SELECT r.*,
    COALESCE(r.count_val, round(EXTRACT(EPOCH FROM (r.until_ts - r.start_time)) /
      CASE r.freq WHEN 'YEARLY' THEN 31536000 WHEN 'MONTHLY' THEN 2628000 WHEN 'WEEKLY' THEN 604800
        WHEN 'DAILY' THEN 86400 WHEN 'HOURLY' THEN 3600 WHEN 'MINUTELY' THEN 60 ELSE 1 END)) AS stima_occorrenze
  FROM r
)
SELECT c.slug, s.id, s.freq, s.rrule, s.start_time, s.stima_occorrenze,
  COALESCE(s.stima_occorrenze > 50000, false) AS oltre_limite_radicale,
  (s.count_val > 5000) AS count_alto,
  (s.count_val IS NULL AND s.until_ts IS NULL) AS infinita,
  (s.start_time < now() - interval '5 years') AS iniziata_da_oltre_5_anni
FROM s
JOIN calendars c ON c.id = s.calendar_id
ORDER BY s.stima_occorrenze DESC NULLS LAST, s.start_time
LIMIT 50;

-- @query 06b_rrule_riepilogo | Serie per FREQ
-- Distribuzione delle frequenze, serie infinite e serie iniziate da oltre 5 anni.
SELECT substring(rrule from 'FREQ=([A-Z]+)') AS freq,
  count(*) AS serie,
  count(*) FILTER (WHERE rrule !~ 'UNTIL=|COUNT=') AS infinite,
  count(*) FILTER (WHERE start_time < now() - interval '5 years') AS iniziate_da_oltre_5_anni,
  count(*) FILTER (WHERE all_day) AS all_day
FROM calendar_events
WHERE rrule IS NOT NULL AND recurrence_master_id IS NULL
GROUP BY 1
ORDER BY 2 DESC;

-- @query 07_allday_convenzioni | Convenzioni degli all-day
-- Mezzanotte UTC = import da iscrizioni ICS, mezzanotte di Roma = editor admin,
-- nessuna delle due = ambiguo.
-- @anomaly ALLDAY_AMBIGUOUS sum=ambigui
SELECT c.slug, c.timezone,
  count(*) FILTER (WHERE to_char(e.start_time AT TIME ZONE 'UTC', 'HH24:MI') = '00:00') AS mezzanotte_utc,
  count(*) FILTER (WHERE to_char(e.start_time AT TIME ZONE 'Europe/Rome', 'HH24:MI') = '00:00') AS mezzanotte_roma,
  count(*) FILTER (WHERE to_char(e.start_time AT TIME ZONE 'UTC', 'HH24:MI') <> '00:00'
    AND to_char(e.start_time AT TIME ZONE 'Europe/Rome', 'HH24:MI') <> '00:00') AS ambigui
FROM calendar_events e
JOIN calendars c ON c.id = e.calendar_id
WHERE e.all_day
GROUP BY 1, 2
ORDER BY 1;

-- @query 08_serie_fuso_non_roma | Serie in calendari con fuso diverso da Europe/Rome
-- @anomaly NON_ROME_SERIES sum=serie
SELECT c.slug, c.timezone, count(*) AS serie
FROM calendar_events e
JOIN calendars c ON c.id = e.calendar_id
WHERE e.rrule IS NOT NULL AND c.timezone <> 'Europe/Rome'
GROUP BY 1, 2
ORDER BY 1;

-- @query 09_rrule_sospette | RRULE sintatticamente sospette
-- Senza FREQ, con una parte iniziale non KEY=, o con un carattere non ammesso
-- nel valore di BYDAY. Rispetto alla query 9 di docs/ il controllo su BYDAY
-- non segnala più il ';' che separa la parte successiva (falso positivo su
-- ogni regola con BYDAY non in ultima posizione, es. FREQ=WEEKLY;BYDAY=MO;COUNT=12).
-- @anomaly INVALID_RRULE
SELECT e.id, c.slug, e.rrule
FROM calendar_events e
JOIN calendars c ON c.id = e.calendar_id
WHERE e.rrule IS NOT NULL
  AND (e.rrule !~ '^(FREQ=|[A-Z]+=)' OR e.rrule !~ 'FREQ=' OR e.rrule ~ 'BYDAY=[A-Z0-9,+-]*[^A-Z0-9,+;-]')
ORDER BY c.slug, e.id;

-- @query 10a_festivita_duplicate | Festività duplicate per data
-- @anomaly DUPLICATE_HOLIDAY
SELECT source_id, count(*) AS eventi
FROM calendar_events
WHERE source = 'system'
GROUP BY 1
HAVING count(*) > 1
ORDER BY 1;

-- @query 10b_chiusure_manuali_sistema | Eventi non di sistema nei calendari di sistema (tranne bookings)
-- Chiusure manuali create da editor o MCP nel calendario delle festività.
SELECT c.slug, e.source, count(*) AS eventi, min(e.start_time) AS primo, max(e.end_time) AS ultimo
FROM calendar_events e
JOIN calendars c ON c.id = e.calendar_id
WHERE c.is_system AND c.slug <> 'bookings' AND e.source <> 'system'
GROUP BY 1, 2
ORDER BY 1, 2;

-- @query 11a_proiezioni_copertura | Prenotazioni per stato e copertura delle proiezioni
SELECT b.status, count(*) AS prenotazioni,
  count(e.id) FILTER (WHERE e.status = 'confirmed') AS proiezione_attiva,
  count(*) FILTER (WHERE e.id IS NULL) AS senza_proiezione
FROM calendar_bookings b
LEFT JOIN calendar_events e ON e.source = 'booking' AND e.source_id = b.uid
GROUP BY b.status
ORDER BY b.status;

-- @query 11b_proiezioni_duplicate | Proiezioni duplicate per prenotazione
-- @anomaly BOOKING_DRIFT
SELECT source_id, count(*) AS proiezioni
FROM calendar_events
WHERE source = 'booking'
GROUP BY 1
HAVING count(*) > 1
ORDER BY 1;

-- @query 11c_proiezioni_orfane | Proiezioni senza prenotazione o attive per prenotazioni non confermate
-- @anomaly BOOKING_DRIFT
SELECT e.id, e.source_id, e.status, b.status AS booking_status
FROM calendar_events e
LEFT JOIN calendar_bookings b ON b.uid = e.source_id
WHERE e.source = 'booking'
  AND (b.uid IS NULL OR (b.status NOT IN ('confirmed', 'completed', 'no_show') AND e.status <> 'cancelled'))
ORDER BY e.source_id;

-- @query 11d_proiezioni_orari_divergenti | Proiezioni con orari diversi dalla prenotazione
-- @anomaly BOOKING_DRIFT
SELECT b.uid, b.start_time, b.end_time, e.start_time AS evento_start, e.end_time AS evento_end
FROM calendar_bookings b
JOIN calendar_events e ON e.source = 'booking' AND e.source_id = b.uid
WHERE e.status = 'confirmed' AND (e.start_time <> b.start_time OR e.end_time <> b.end_time)
ORDER BY b.start_time;

-- @query 11e_confermate_senza_proiezione | Prenotazioni confermate senza proiezione attiva
-- @anomaly BOOKING_DRIFT
SELECT b.uid, b.status, b.start_time
FROM calendar_bookings b
WHERE b.status = 'confirmed'
  AND NOT EXISTS (
    SELECT 1 FROM calendar_events e
    WHERE e.source = 'booking' AND e.source_id = b.uid AND e.status = 'confirmed'
  )
ORDER BY b.start_time;

-- @query 12_non_proiezioni_in_bookings | Eventi non di prenotazione nel calendario bookings
-- Restano lì dopo la migrazione (decisione 8): bloccano come oggi.
-- @anomaly NON_PROJECTION_IN_BOOKINGS sum=eventi
SELECT e.source, e.status, count(*) AS eventi, min(e.start_time) AS primo, max(e.end_time) AS ultimo
FROM calendar_events e
JOIN calendars c ON c.id = e.calendar_id
WHERE c.slug = 'bookings' AND e.source <> 'booking'
GROUP BY 1, 2
ORDER BY 1, 2;

-- @query 13_prenotazioni_future | Prenotazioni future per stato
-- Volume delle proiezioni da creare in Radicale.
SELECT status, count(*) AS prenotazioni
FROM calendar_bookings
WHERE end_time > now()
GROUP BY 1
ORDER BY 1;

-- @query 14_iscrizioni | Iscrizioni ICS: righe reali, trappola etag/304 e impatto sul busy (180 giorni)
-- Solo l'host dell'URL. trappola_304: etag o last_modified salvati ma nessuna
-- riga importata (il pull risponde 304 e non reimporta mai: design §14).
-- @anomaly ICS_PULL_REFETCH when=trappola_304
-- @anomaly SUBSCRIPTION_BLOCKING_IMPACT when=con_impatto
WITH s AS (
  SELECT s.id, s.name, s.calendar_id, s.ics_url, s.sync_enabled, s.event_count, s.last_error,
    s.etag IS NOT NULL AS has_etag, s.last_modified IS NOT NULL AS has_last_modified, s.last_synced_at, s.created_at,
    (SELECT count(*) FROM calendar_events e WHERE e.subscription_id = s.id) AS righe_reali,
    (SELECT round(COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(e.end_time, now() + interval '180 days') - GREATEST(e.start_time, now()))) / 3600), 0)::numeric, 1)
       FROM calendar_events e
       WHERE e.subscription_id = s.id AND NOT e.all_day AND e.status = 'confirmed'
         AND e.end_time > now() AND e.start_time < now() + interval '180 days') AS ore_busy_180g_oggi
  FROM calendar_subscriptions s
)
SELECT s.id, s.name, c.slug AS destinazione, c.blocks_availability, substring(s.ics_url from '^https?://[^/]+') AS host,
  s.sync_enabled, s.event_count, s.righe_reali, s.last_error, s.has_etag, s.has_last_modified, s.last_synced_at,
  s.ore_busy_180g_oggi,
  ((s.has_etag OR s.has_last_modified) AND s.righe_reali = 0) AS trappola_304,
  (s.ore_busy_180g_oggi > 0) AS con_impatto
FROM s
JOIN calendars c ON c.id = s.calendar_id
ORDER BY s.created_at;

-- @query 15_app_password | App-password CalDAV
-- Principal canonico 'federico'; gli username caldes-* sono riservati agli
-- utenti di servizio. IP mascherato.
-- @anomaly NON_CANONICAL_APP_PASSWORD when=attiva_non_canonica
SELECT username,
  (username <> 'federico') AS non_canonico,
  (username ILIKE 'caldes-%') AS riservato,
  (username <> 'federico' AND is_active AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS attiva_non_canonica,
  device_name, is_active, revoked_at IS NOT NULL AS revocata, expires_at, last_used_at,
  CASE
    WHEN last_used_ip IS NULL THEN NULL
    WHEN last_used_ip ~ '^\d{1,3}(\.\d{1,3}){3}$' THEN regexp_replace(last_used_ip, '\.\d{1,3}$', '.x')
    WHEN last_used_ip LIKE '%:%' THEN array_to_string((string_to_array(last_used_ip, ':'))[1:3], ':') || ':…'
    ELSE '(mascherato)'
  END AS last_used_ip_mascherato,
  usage_count, created_at
FROM caldav_app_passwords
ORDER BY last_used_at DESC NULLS LAST, created_at;

-- @query 16_workflow_tabelle_calendario | Workflow salvati che leggono tabelle del calendario
-- Da aggiornare nell'allowlist di tool_db_query quando calendar_events diventa una vista.
SELECT id, name, status, last_executed_at
FROM workflows
WHERE nodes::text ~* 'calendar_events|calendar_subscriptions|\mcalendars\M'
ORDER BY name;

-- @query 17_uid_e_testi | UID non sicuri come nome file e lunghezza dei testi
SELECT count(*) FILTER (WHERE uid !~ '^[A-Za-z0-9._@-]{1,200}$') AS uid_non_sicuri,
  max(length(summary)) AS max_summary,
  max(length(description)) AS max_description
FROM calendar_events;

-- @query 18_event_types_orizzonte | Tipi di prenotazione e orizzonte
-- L'orizzonte dell'indice deve coprire max_advance_days + 14 giorni.
SELECT slug, is_active, is_public, max_advance_days, min_notice_hours
FROM calendar_event_types
ORDER BY max_advance_days DESC, slug;

-- @query 19a_migrazione_158 | Applicazione della migrazione 158 (deploy del fix DST d046006)
SELECT version, applied_at
FROM schema_migrations
WHERE version LIKE '158%'
ORDER BY version;

-- @query 19b_eccezioni_dst | Eccezioni salvate prima del fix DST
-- Stessa ora UTC del DTSTART ma ora locale di Roma diversa: la firma del codice
-- precedente a d046006. Da riallineare con scripts/fix-dst-exceptions.ts.
-- @anomaly DST_SHIFTED_EXCEPTION
SELECT 'override' AS tipo, c.slug, m.id AS master_id, o.id AS eccezione_id, m.start_time AS dtstart,
  o.recurrence_id AS valore, o.created_at
FROM calendar_events o
JOIN calendar_events m ON m.id = o.recurrence_master_id
JOIN calendars c ON c.id = m.calendar_id
WHERE m.rrule IS NOT NULL AND NOT m.all_day
  AND to_char(o.recurrence_id AT TIME ZONE 'UTC', 'HH24:MI') = to_char(m.start_time AT TIME ZONE 'UTC', 'HH24:MI')
  AND to_char(o.recurrence_id AT TIME ZONE 'Europe/Rome', 'HH24:MI') <> to_char(m.start_time AT TIME ZONE 'Europe/Rome', 'HH24:MI')
UNION ALL
SELECT 'exdate', c.slug, m.id, NULL, m.start_time, x.v::timestamptz, m.updated_at
FROM calendar_events m
JOIN calendars c ON c.id = m.calendar_id,
  LATERAL jsonb_array_elements_text(m.exdates) AS x(v)
WHERE m.rrule IS NOT NULL AND NOT m.all_day
  AND to_char(x.v::timestamptz AT TIME ZONE 'UTC', 'HH24:MI') = to_char(m.start_time AT TIME ZONE 'UTC', 'HH24:MI')
  AND to_char(x.v::timestamptz AT TIME ZONE 'Europe/Rome', 'HH24:MI') <> to_char(m.start_time AT TIME ZONE 'Europe/Rome', 'HH24:MI')
ORDER BY 2, 3, 6;

-- @query 20a_audit_attivita_90g | Attività sul calendario negli ultimi 90 giorni (audit_logs)
SELECT table_name, action, count(*) AS righe, max(created_at) AS ultima
FROM audit_logs
WHERE table_name IN ('calendar_events', 'calendars', 'calendar_subscriptions')
  AND created_at > now() - interval '90 days'
GROUP BY 1, 2
ORDER BY 1, 2;

-- @query 20b_audit_proiezioni | Righe di audit con dati delle proiezioni (PII nella DESCRIPTION)
-- Da includere nell'erasure GDPR (design §16.4).
SELECT count(*) AS audit_righe_eventi_booking
FROM audit_logs
WHERE table_name = 'calendar_events'
  AND (new_data->>'source' = 'booking' OR old_data->>'source' = 'booking');

-- @query 20c_dimensioni_tabelle | Dimensioni delle tabelle del calendario
SELECT relname AS tabella, n_live_tup AS righe_stimate, pg_total_relation_size(relid) AS byte,
  pg_size_pretty(pg_total_relation_size(relid)) AS dimensione
FROM pg_stat_user_tables
WHERE relname IN ('calendars', 'calendar_events', 'calendar_subscriptions', 'calendar_bookings', 'caldav_app_passwords', 'audit_logs')
ORDER BY relname;

-- @end

ROLLBACK;
