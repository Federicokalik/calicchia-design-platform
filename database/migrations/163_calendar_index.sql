-- 163_calendar_index.sql — Indice derivato del calendario con salute per
-- oggetto, id persistenti e versioni (fase F2 del passaggio a Radicale).
--
-- Riferimenti: docs/calendar-radicale/design.md §4 (163), §5 (identità e
-- provenienza), §6 (sincronizzazione, salute, espansione, rebuild,
-- orizzonte), §7 (lettura), §9 (regola blocks) e il contratto dei moduli
-- docs/calendar-radicale/contracts/f2-modules.md, che fissa chi scrive cosa.
--
-- Cosa aggiunge:
--  1. cal_object_ids (persistente): (calendar_id, href, recurrence_key) → id
--     UUID stabile, con legacy_event_id e legacy_uid SENZA FK verso
--     calendar_events (il backup JSON svuota calendar_events senza CASCADE:
--     nessuna tabella del gruppo S può referenziarla, design §16.2);
--  2. cal_object_versions (persistente): testo di ogni versione indicizzata
--     di un oggetto Radicale, cancellazioni comprese, retention 90 giorni,
--     mai per le iscrizioni;
--  3. cal_collection_state (derivata): stato di sincronizzazione e salute per
--     collezione (healthy, stale, unsyncable, hold), sync-token, mtime della
--     directory, cancellazioni sospese dall'interruttore, index_version e
--     orizzonte materializzato;
--  4. cal_objects (derivata): una riga per risorsa (href) con testo, etag,
--     fingerprint, intervallo, provenienza e salute (ok, quarantined,
--     pending_404) con l'ultima versione buona;
--  5. cal_components (derivata): una riga per VEVENT (master, singolo o
--     override) con i campi parsati che servono agli adattatori legacy;
--  6. cal_occurrences (derivata): occorrenze espanse nell'orizzonte con kind e
--     blocks calcolati dall'indicizzatore e la colonna generata span
--     (tstzrange) con l'indice GiST parziale WHERE blocks per il busy;
--  7. NOTIFY calendar_index_changed quando sale l'index_version di una
--     collezione.
--
-- Le tabelle derivate (3-6) si ricostruiscono da Radicale e dai feed remoti in
-- ogni momento (rebuild, design §6.7); quelle persistenti (1-2) no: gli id e
-- le versioni sopravvivono al rebuild. Tutte appartengono al gruppo S del
-- backup JSON (apps/api/src/routes/backup.ts, STATE_TABLES): esportate, mai
-- ripristinate. Le uniche FK verso tabelle di dominio puntano a calendars, che
-- l'import aggiorna in UPSERT senza mai svuotarla.
--
-- In mode 'postgres' (produzione dopo il deploy della F2) nessun percorso
-- legacy legge queste tabelle: i contratti F0 non cambiano. calendar_events
-- non viene toccata.
--
-- Formato di recurrence_key (stesso in tutte le tabelle, contratto f2-modules
-- §2.3; è quello di recurrenceKeyOf() di @calicchia/calendar-core): '' per la
-- risorsa intera o un evento singolo; 'YYYYMMDD' per un'istanza all-day (data
-- locale); 'YYYYMMDDTHHMMSSZ' per un'istanza timed con TZID o in UTC (istante
-- UTC al secondo); 'YYYYMMDDTHHMMSS' per un'istanza floating (ora da muro,
-- stabile anche se cambia il fuso del calendario). Solo in cal_occurrences
-- vale anche 'conservative', chiave del blocco conservativo di un oggetto
-- illeggibile senza versione buona.
--
-- Append-only e idempotente: IF NOT EXISTS, controlli sul catalogo, CREATE OR
-- REPLACE per le funzioni. Nessun backfill: le tabelle nascono vuote e le
-- popola l'indicizzatore.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─── 1. Id persistenti ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_object_ids (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id     UUID        NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  href            TEXT        NOT NULL,
  recurrence_key  TEXT        NOT NULL DEFAULT '',
  -- UID dell'oggetto all'ultima indicizzazione: serve a riconoscere un MOVE
  -- (UID sparito in A e comparso in B entro 30 giorni → stesso id, design §5).
  uid             TEXT,
  -- Riga legacy da cui deriva l'id (migrazione, proiezioni): nessuna FK.
  legacy_event_id UUID,
  legacy_uid      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Oggetto (o istanza) non più presente: la riga resta per i MOVE, le
  -- versioni e il ripristino dal cestino, e torna attiva se l'href ricompare.
  retired_at      TIMESTAMPTZ,
  CONSTRAINT cal_object_ids_key UNIQUE (calendar_id, href, recurrence_key),
  CONSTRAINT cal_object_ids_href_check CHECK (octet_length(href) BETWEEN 1 AND 1024 AND href !~ '[/\\\x01-\x1f\x7f]'),
  CONSTRAINT cal_object_ids_recurrence_key_check
    CHECK (recurrence_key ~ '^([0-9]{8}|[0-9]{8}T[0-9]{6}Z?)?$')
);

COMMENT ON TABLE cal_object_ids IS
  'Id stabili degli oggetti di calendario (design §5): (calendar_id, href, recurrence_key) → id. Persistente: sopravvive al rebuild dell''indice. Gruppo S del backup JSON.';
COMMENT ON COLUMN cal_object_ids.href IS
  'Nome della risorsa nella collezione (ultimo segmento dell''href, decodificato), es. abc.ics o booking-<uid>.ics.';
COMMENT ON COLUMN cal_object_ids.recurrence_key IS
  ''''' per la risorsa (master o singolo); per un override YYYYMMDD (all-day), YYYYMMDDTHHMMSSZ (timed, istante UTC) o YYYYMMDDTHHMMSS (floating).';
COMMENT ON COLUMN cal_object_ids.legacy_event_id IS
  'calendar_events.id da cui deriva (migrazione, proiezioni delle prenotazioni). Senza FK: il backup JSON svuota calendar_events senza CASCADE.';

CREATE INDEX IF NOT EXISTS cal_object_ids_uid_idx
  ON cal_object_ids (uid) WHERE uid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cal_object_ids_legacy_event_idx
  ON cal_object_ids (legacy_event_id) WHERE legacy_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cal_object_ids_legacy_uid_idx
  ON cal_object_ids (legacy_uid) WHERE legacy_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS cal_object_ids_retired_uid_idx
  ON cal_object_ids (uid, retired_at) WHERE retired_at IS NOT NULL;

-- ─── 2. Versioni ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_object_versions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Riga persistente dell'oggetto (recurrence_key ''): la versione resta anche
  -- dopo la cancellazione dell'oggetto e dopo il rebuild dell'indice.
  object_id      UUID        NOT NULL REFERENCES cal_object_ids(id) ON DELETE CASCADE,
  calendar_id    UUID        NOT NULL,
  href           TEXT        NOT NULL,
  etag           TEXT,
  -- Testo della versione; per change_kind='delete' è l'ultimo testo noto.
  raw_ics        TEXT,
  content_sha256 TEXT,
  semantic_fp    TEXT,
  change_kind    TEXT        NOT NULL,
  -- La versione si parsava ed espandeva: utilizzabile come "ultima buona".
  valid          BOOLEAN     NOT NULL,
  -- Chi ha prodotto il cambiamento, se noto: device, admin:<id>, mcp, agent,
  -- system, sync, rebuild, restore.
  actor          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cal_object_versions_change_kind_check
    CHECK (change_kind IN ('create', 'update', 'delete', 'restore')),
  CONSTRAINT cal_object_versions_sha_check
    CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cal_object_versions_raw_check
    CHECK (raw_ics IS NOT NULL OR change_kind = 'delete')
);

COMMENT ON TABLE cal_object_versions IS
  'Versioni degli oggetti Radicale (design §1 invariante 3, §6.2 passo 9): retention 90 giorni, purge GDPR, mai per role=subscription. Persistente, gruppo S del backup JSON.';

CREATE INDEX IF NOT EXISTS cal_object_versions_object_idx
  ON cal_object_versions (object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cal_object_versions_created_idx
  ON cal_object_versions (created_at);
CREATE INDEX IF NOT EXISTS cal_object_versions_calendar_idx
  ON cal_object_versions (calendar_id, created_at DESC);

-- ─── 3. Stato per collezione ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_collection_state (
  calendar_id          UUID        PRIMARY KEY REFERENCES calendars(id) ON DELETE CASCADE,
  -- radicale: collezione con fonte in Radicale (watcher e sync-collection);
  -- remote: sidecar di un'iscrizione, alimentato dal pull del feed.
  origin_store         TEXT        NOT NULL DEFAULT 'radicale',
  sync_token           TEXT,
  -- mtime (ns) della directory osservata prima del REPORT dell'ultima sync
  -- riuscita; NULL se mai sincronizzata, se la finestra era "racy" (< 50 ms)
  -- o dopo una richiesta di rebuild: le decisioni forzano allora la sync.
  dir_mtime_ns         BIGINT,
  last_synced_at       TIMESTAMPTZ,
  last_full_sync_at    TIMESTAMPTZ,
  last_attempt_at      TIMESTAMPTZ,
  consecutive_failures INTEGER     NOT NULL DEFAULT 0,
  last_error           TEXT,
  health               TEXT        NOT NULL DEFAULT 'stale',
  health_since         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Primo istante in cui il watcher (o la freshness) ha visto la directory
  -- diversa da dir_mtime_ns senza una sync riuscita: base di 'stale' (oltre
  -- 2 minuti) e di 'unsyncable' (sync fallita con modifiche pendenti).
  dirty_since          TIMESTAMPTZ,
  -- Interruttore anti-cancellazione di massa (design §6.2 passo 6): href
  -- candidati alla cancellazione e non applicati finché l'admin non sceglie.
  pending_deletions    TEXT[]      NOT NULL DEFAULT '{}',
  hold_reason          TEXT,
  hold_since           TIMESTAMPTZ,
  object_count         INTEGER     NOT NULL DEFAULT 0,
  quarantined_count    INTEGER     NOT NULL DEFAULT 0,
  -- +1 a ogni transazione che cambia oggetti od occorrenze della collezione
  -- (chiave delle cache del feed, NOTIFY calendar_index_changed).
  index_version        BIGINT      NOT NULL DEFAULT 0,
  -- Intervallo coperto da cal_occurrences per questa collezione (design §6.9).
  horizon_start        TIMESTAMPTZ,
  horizon_end          TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cal_collection_state_origin_store_check CHECK (origin_store IN ('radicale', 'remote')),
  CONSTRAINT cal_collection_state_health_check CHECK (health IN ('healthy', 'stale', 'unsyncable', 'hold')),
  CONSTRAINT cal_collection_state_failures_check CHECK (consecutive_failures >= 0),
  CONSTRAINT cal_collection_state_counts_check CHECK (object_count >= 0 AND quarantined_count >= 0),
  CONSTRAINT cal_collection_state_index_version_check CHECK (index_version >= 0),
  CONSTRAINT cal_collection_state_hold_check CHECK ((health = 'hold') = (hold_since IS NOT NULL)),
  CONSTRAINT cal_collection_state_horizon_check
    CHECK ((horizon_start IS NULL) = (horizon_end IS NULL) AND (horizon_start IS NULL OR horizon_start < horizon_end)),
  CONSTRAINT cal_collection_state_remote_check
    CHECK (origin_store = 'radicale' OR (sync_token IS NULL AND dir_mtime_ns IS NULL))
);

COMMENT ON TABLE cal_collection_state IS
  'Stato derivato di sincronizzazione e salute per collezione (design §6.2, §6.5, §6.7, §6.9). Ricostruibile, gruppo S del backup JSON.';
COMMENT ON COLUMN cal_collection_state.health IS
  'healthy; stale (modifiche non indicizzate da oltre 2 minuti); unsyncable (sync che fallisce con modifiche pendenti: 503 nelle decisioni se bloccante); hold (cancellazioni di massa sospese, le occorrenze esistenti bloccano).';

-- ─── 4. Oggetti ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_objects (
  -- = cal_object_ids.id della risorsa (recurrence_key '').
  id                   UUID        PRIMARY KEY REFERENCES cal_object_ids(id) ON DELETE CASCADE,
  calendar_id          UUID        NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  href                 TEXT        NOT NULL,
  uid                  TEXT,
  etag                 TEXT,
  component            TEXT        NOT NULL DEFAULT 'VEVENT',
  -- Testo corrente della risorsa (anche se non si parsa: in quarantena le
  -- occorrenze restano quelle dell'ultima versione buona). NULL solo se il
  -- file non era leggibile.
  raw_ics              TEXT,
  content_sha256       TEXT,
  -- Fingerprint semantico di calendar-core (senza DTSTAMP; senza
  -- LAST-MODIFIED e SEQUENCE a contenuto invariato). NULL se non si parsa.
  semantic_fp          TEXT,
  origin_store         TEXT        NOT NULL,
  -- Intervallo complessivo (primo inizio, ultima fine; range_end NULL =
  -- ricorrenza senza fine).
  range_start          TIMESTAMPTZ,
  range_end            TIMESTAMPTZ,
  is_recurring         BOOLEAN     NOT NULL DEFAULT false,
  -- Oltre questo istante le occorrenze non sono materializzate (più di 5000
  -- nell'orizzonte, design §6.4): le decisioni espandono al volo l'oggetto.
  materialized_until   TIMESTAMPTZ,
  health               TEXT        NOT NULL DEFAULT 'ok',
  health_reason        TEXT,
  health_since         TIMESTAMPTZ,
  -- 404 osservati in sync consecutive in remote mode (cancellazione solo al
  -- secondo, design §6.1).
  pending_404_count    SMALLINT    NOT NULL DEFAULT 0,
  last_good_version_id UUID        REFERENCES cal_object_versions(id) ON DELETE SET NULL,
  -- Provenienza derivata da ruolo della collezione e href (design §5): mai
  -- promossa a booking o system da una X-prop.
  source               TEXT        NOT NULL DEFAULT 'manual',
  source_id            TEXT,
  -- X-CALDES-SOURCE e X-CALDES-SOURCE-ID così come sono nel testo.
  x_source             TEXT,
  x_source_id          TEXT,
  size_bytes           INTEGER,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cal_objects_calendar_href_key UNIQUE (calendar_id, href),
  CONSTRAINT cal_objects_component_check CHECK (component IN ('VEVENT', 'VTODO', 'VJOURNAL', 'UNKNOWN')),
  CONSTRAINT cal_objects_origin_store_check CHECK (origin_store IN ('radicale', 'remote')),
  CONSTRAINT cal_objects_health_check CHECK (health IN ('ok', 'quarantined', 'pending_404')),
  CONSTRAINT cal_objects_health_reason_check
    CHECK (health_reason IS NULL OR health_reason ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT cal_objects_health_ok_check CHECK ((health = 'ok') = (health_since IS NULL)),
  CONSTRAINT cal_objects_source_check
    CHECK (source IN ('manual', 'booking', 'admin', 'mcp', 'agent', 'ics_pull', 'system')),
  CONSTRAINT cal_objects_sha_check CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cal_objects_range_check CHECK (range_end IS NULL OR range_start IS NULL OR range_start <= range_end),
  CONSTRAINT cal_objects_pending_404_check CHECK (pending_404_count >= 0),
  CONSTRAINT cal_objects_remote_etag_check CHECK (origin_store = 'radicale' OR etag IS NULL)
);

COMMENT ON TABLE cal_objects IS
  'Oggetti indicizzati (design §4, §6.5): una riga per risorsa con testo, etag, fingerprint, provenienza e salute. Derivata e ricostruibile; gruppo S del backup JSON.';
COMMENT ON COLUMN cal_objects.health IS
  'ok; quarantined (testo non utilizzabile: restano le occorrenze dell''ultima versione buona o un blocco conservativo); pending_404 (sparito in remote mode, continua a bloccare fino al secondo 404).';

CREATE INDEX IF NOT EXISTS cal_objects_uid_idx ON cal_objects (uid);
CREATE INDEX IF NOT EXISTS cal_objects_unhealthy_idx
  ON cal_objects (calendar_id, health) WHERE health <> 'ok';
CREATE INDEX IF NOT EXISTS cal_objects_recurring_idx
  ON cal_objects (calendar_id) WHERE is_recurring OR materialized_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS cal_objects_source_idx
  ON cal_objects (source, source_id) WHERE source_id IS NOT NULL;

-- ─── 5. Componenti ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_components (
  -- = cal_object_ids.id di (calendar_id, href, recurrence_key).
  id              UUID        PRIMARY KEY REFERENCES cal_object_ids(id) ON DELETE CASCADE,
  object_id       UUID        NOT NULL REFERENCES cal_objects(id) ON DELETE CASCADE,
  calendar_id     UUID        NOT NULL,
  recurrence_key  TEXT        NOT NULL DEFAULT '',
  component       TEXT        NOT NULL DEFAULT 'VEVENT',
  uid             TEXT,
  summary         TEXT,
  description     TEXT,
  location        TEXT,
  url             TEXT,
  -- STATUS ricondotto ai tre valori legacy (assente → confirmed).
  status          TEXT        NOT NULL DEFAULT 'confirmed',
  -- TRANSP com'è nel testo; NULL = assente (vale OPAQUE).
  transp          TEXT,
  class           TEXT,
  -- Primo inizio e fine del componente: per un override quelli dell'istanza,
  -- per un master quelli della prima occorrenza (DTSTART/DTEND).
  start_utc       TIMESTAMPTZ,
  end_utc         TIMESTAMPTZ,
  all_day         BOOLEAN     NOT NULL DEFAULT false,
  start_date      DATE,
  end_date        DATE,
  tzid            TEXT,
  floating        BOOLEAN     NOT NULL DEFAULT false,
  rrule           TEXT,
  -- Elenchi in ISO UTC (timed) o YYYY-MM-DD (all-day).
  rdates          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  exdates         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  recurrence_id_utc TIMESTAMPTZ,
  -- Override il cui RECURRENCE-ID non appartiene all'insieme del master
  -- (design §6.4): diventa un'occorrenza autonoma 'orphan_override'.
  orphan          BOOLEAN     NOT NULL DEFAULT false,
  sequence        INTEGER,
  dtstamp         TIMESTAMPTZ,
  created         TIMESTAMPTZ,
  last_modified   TIMESTAMPTZ,
  x_source        TEXT,
  x_source_id     TEXT,
  has_alarms      BOOLEAN     NOT NULL DEFAULT false,
  has_attendees   BOOLEAN     NOT NULL DEFAULT false,
  CONSTRAINT cal_components_object_key UNIQUE (object_id, recurrence_key),
  CONSTRAINT cal_components_recurrence_key_check
    CHECK (recurrence_key ~ '^([0-9]{8}|[0-9]{8}T[0-9]{6}Z?)?$'),
  CONSTRAINT cal_components_component_check CHECK (component IN ('VEVENT', 'VTODO', 'VJOURNAL')),
  CONSTRAINT cal_components_status_check CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  CONSTRAINT cal_components_transp_check CHECK (transp IS NULL OR transp IN ('OPAQUE', 'TRANSPARENT')),
  CONSTRAINT cal_components_rdates_check CHECK (jsonb_typeof(rdates) = 'array'),
  CONSTRAINT cal_components_exdates_check CHECK (jsonb_typeof(exdates) = 'array'),
  CONSTRAINT cal_components_override_check CHECK ((recurrence_key = '') = (recurrence_id_utc IS NULL)),
  CONSTRAINT cal_components_orphan_check CHECK (NOT orphan OR recurrence_key <> '')
);

COMMENT ON TABLE cal_components IS
  'Un VEVENT (master, singolo o override) per riga con i campi parsati usati dagli adattatori legacy (toLegacyEvent, toLegacyOccurrence). Derivata.';

CREATE INDEX IF NOT EXISTS cal_components_calendar_idx ON cal_components (calendar_id);
CREATE INDEX IF NOT EXISTS cal_components_uid_idx ON cal_components (uid) WHERE uid IS NOT NULL;

-- ─── 6. Occorrenze ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_occurrences (
  object_id      UUID        NOT NULL REFERENCES cal_objects(id) ON DELETE CASCADE,
  recurrence_key TEXT        NOT NULL,
  -- Componente che produce l'istanza (master o override); NULL per il blocco
  -- conservativo di un oggetto illeggibile.
  component_id   UUID,
  calendar_id    UUID        NOT NULL,
  start_utc      TIMESTAMPTZ NOT NULL,
  end_utc        TIMESTAMPTZ NOT NULL,
  start_date     DATE,
  end_date       DATE,
  all_day        BOOLEAN     NOT NULL DEFAULT false,
  status         TEXT        NOT NULL DEFAULT 'confirmed',
  transp         TEXT        NOT NULL DEFAULT 'OPAQUE',
  kind           TEXT        NOT NULL,
  -- Regola del design §9 (computeBlocks di @calicchia/calendar-core),
  -- calcolata dall'indicizzatore: VEVENT, STATUS confermato o assente, TRANSP
  -- diverso da TRANSPARENT, timed (o all-day ammesso dalla decisione 6) e kind
  -- diverso da booking_projection. I flag dei calendari (blocks_availability,
  -- iscrizioni) si applicano a query time.
  blocks         BOOLEAN     NOT NULL,
  -- Occorrenza dell'ultima versione buona di un oggetto in quarantena.
  stale          BOOLEAN     NOT NULL DEFAULT false,
  span           TSTZRANGE   GENERATED ALWAYS AS (tstzrange(start_utc, end_utc, '[)')) STORED,
  CONSTRAINT cal_occurrences_pkey PRIMARY KEY (object_id, recurrence_key),
  CONSTRAINT cal_occurrences_recurrence_key_check
    CHECK (recurrence_key ~ '^(([0-9]{8}|[0-9]{8}T[0-9]{6}Z?)?|conservative)$'),
  CONSTRAINT cal_occurrences_kind_check CHECK (kind IN (
    'event', 'override', 'orphan_override', 'conservative', 'booking_projection', 'holiday_system', 'closure'
  )),
  CONSTRAINT cal_occurrences_status_check CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  CONSTRAINT cal_occurrences_transp_check CHECK (transp IN ('OPAQUE', 'TRANSPARENT')),
  CONSTRAINT cal_occurrences_range_check CHECK (start_utc <= end_utc),
  CONSTRAINT cal_occurrences_allday_check
    CHECK (NOT all_day OR (start_date IS NOT NULL AND end_date IS NOT NULL AND start_date < end_date)),
  -- La chiave 'conservative' è solo del blocco conservativo; il kind
  -- 'conservative' può invece avere anche altre chiavi (budget di espansione
  -- esaurito: l'occorrenza dell'espansione), e una proiezione illeggibile
  -- resta booking_projection (calendar-core, classifyOccurrenceKind).
  CONSTRAINT cal_occurrences_conservative_key_check
    CHECK (recurrence_key <> 'conservative' OR component_id IS NULL),
  CONSTRAINT cal_occurrences_projection_check CHECK (kind <> 'booking_projection' OR NOT blocks)
);

COMMENT ON TABLE cal_occurrences IS
  'Occorrenze espanse nell''orizzonte (design §4, §6.4, §6.9, §9) con kind e blocks dell''indicizzatore. Derivata. Il busy usa l''indice GiST parziale su span WHERE blocks.';

-- Busy (design §7): sovrapposizione sulle sole occorrenze bloccanti.
CREATE INDEX IF NOT EXISTS cal_occurrences_blocks_span_idx
  ON cal_occurrences USING gist (span) WHERE blocks;
-- Lettura per calendario e finestra (admin, MCP, agenda, feed).
CREATE INDEX IF NOT EXISTS cal_occurrences_calendar_span_idx
  ON cal_occurrences USING gist (calendar_id, span);
CREATE INDEX IF NOT EXISTS cal_occurrences_component_idx
  ON cal_occurrences (component_id) WHERE component_id IS NOT NULL;

-- ─── 7. Notifica di cambio dell'indice ──────────────────────────────────────

-- I consumatori in memoria (cache del feed, stato della salute) ascoltano
-- calendar_index_changed. La notifica parte al COMMIT della transazione che ha
-- incrementato index_version; payload {"calendar_id": "...", "index_version": N}.
CREATE OR REPLACE FUNCTION cal_collection_state_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'calendar_index_changed',
    json_build_object('calendar_id', NEW.calendar_id, 'index_version', NEW.index_version)::text
  );
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS cal_collection_state_notify ON cal_collection_state;
CREATE TRIGGER cal_collection_state_notify
  AFTER INSERT OR UPDATE OF index_version ON cal_collection_state
  FOR EACH ROW
  WHEN (NEW.index_version > 0)
  EXECUTE FUNCTION cal_collection_state_notify();

-- updated_at gestito dal database su cal_object_ids e cal_collection_state.
CREATE OR REPLACE FUNCTION cal_index_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cal_object_ids_touch ON cal_object_ids;
CREATE TRIGGER cal_object_ids_touch
  BEFORE UPDATE ON cal_object_ids
  FOR EACH ROW EXECUTE FUNCTION cal_index_touch_updated_at();

DROP TRIGGER IF EXISTS cal_collection_state_touch ON cal_collection_state;
CREATE TRIGGER cal_collection_state_touch
  BEFORE UPDATE ON cal_collection_state
  FOR EACH ROW EXECUTE FUNCTION cal_index_touch_updated_at();
