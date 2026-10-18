-- 165_calendar_migration.sql — Strumento di migrazione, ledger a tre vie e
-- coda dello shadow mirror (fase F3 del passaggio a Radicale).
--
-- Riferimenti: docs/calendar-radicale/design.md §4 (165), §13.1-§13.8,
-- §16.2, §16.4, §16.6 e il contratto dei moduli
-- docs/calendar-radicale/contracts/f3-modules.md, che fissa chi scrive cosa.
--
-- In F3 Postgres resta AUTOREVOLE: mode resta 'postgres', nessun percorso
-- legacy legge queste colonne o tabelle e i contratti F0 non cambiano. Lo
-- strumento scrive solo su Radicale (come caldes-svc), sul proprio ledger e
-- sui propri run.
--
-- Cosa aggiunge:
--  1. calendar_backend_state (nata nella 162 con le colonne di F1): le colonne
--     di shadow, cutover, rollback, finalize, versione minima dell'API, ultimo
--     backup coordinato registrato e dichiarazioni del wizard. NON aggiunge
--     horizon_start/horizon_end: l'orizzonte è per collezione in
--     cal_collection_state (163; contratto f2-modules §13.1). Nessuna di
--     queste colonne entra nella policy dei device: il trigger della 162 non
--     incrementa policy_version quando cambiano;
--  2. cal_migration_runs: un run per azione del wizard (preflight,
--     inizializzazione, inventario, anteprima, apply, verifica...), eseguito
--     in background con avanzamento interrogabile. UN SOLO run attivo alla
--     volta (indice unico parziale su queued/running, oltre al
--     pg_advisory_lock('cal-migration') dell'esecutore) e chiave
--     d'idempotenza unica;
--  3. cal_migration_items: righe dei run (controlli del preflight, anomalie,
--     esiti per oggetto del piano e dell'apply, differenze della verifica con
--     la loro accettazione esplicita, degradi del rollback in F4);
--  4. cal_migration_ledger: ledger a tre vie per href (stato della sorgente
--     legacy_hash e legacy_snapshot, stato della destinazione written_etag e
--     written_fingerprint, riga d'intento scritta PRIMA di ogni PUT o
--     DELETE), con adopted e derived (F4) e la rivalidazione richiesta dopo un
--     import di backup (cal_migration_ledger_require_revalidation());
--  5. coda dello shadow mirror: nessuna tabella nuova, si usa cal_jobs (164)
--     con il tipo riservato 'shadow_mirror'. I trigger su calendar_events e
--     calendar_bookings accodano il job nella STESSA transazione della
--     scrittura legacy (outbox), solo con mode = 'postgres', shadow_enabled e
--     un volume registrato, e mai per le righe delle iscrizioni (ics_pull) né
--     per le scritture della proiezione inversa della F4 (GUC
--     caldes.reverse_sync = 'on'). Con lo shadow spento i trigger non
--     scrivono nulla: in produzione dopo il deploy restano inerti finché
--     l'utente non lo attiva dal wizard.
--
-- Nessuna FK verso calendar_events, calendar_subscriptions, calendar_bookings
-- o calendars dalle tabelle nuove (tranne le FK interne fra run e item): sono
-- del gruppo S del backup JSON (apps/api/src/routes/backup.ts, prefisso
-- cal_migration_), che l'import non tocca mai; il ledger sopravvive alla
-- cancellazione di un calendario (la collezione resta in Radicale e la
-- verifica la segnala) e agli import che svuotano le tabelle del dominio.
--
-- Append-only e idempotente: IF NOT EXISTS, controlli sul catalogo, CREATE OR
-- REPLACE per le funzioni, DROP/CREATE dei trigger. Compatibile con i dati di
-- produzione (6 calendari, circa 100 righe): nessun backfill, le tabelle
-- nascono vuote e lo shadow nasce spento.

-- ─── 1. calendar_backend_state: colonne della F3 (e riservate alla F4) ──────

ALTER TABLE calendar_backend_state
  ADD COLUMN IF NOT EXISTS shadow_enabled         BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shadow_since           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cutover_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cutover_by             TEXT,
  ADD COLUMN IF NOT EXISTS rollback_until         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS api_min_version        INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_stack_backup      JSONB,
  ADD COLUMN IF NOT EXISTS migration_declarations JSONB       NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN calendar_backend_state.shadow_enabled IS
  'Shadow mirror PG→Radicale attivo (design §13.8): con mode=postgres ogni scrittura legacy accoda un job shadow_mirror (trigger della 165). Non entra nella policy dei device.';
COMMENT ON COLUMN calendar_backend_state.shadow_since IS
  'Istante dell''ultima attivazione dello shadow (NULL se spento): base dei 7 giorni di parità verde richiesti prima del cutover.';
COMMENT ON COLUMN calendar_backend_state.cutover_at IS
  'Istante del cutover confermato (F4, design §13.10). In F3 sempre NULL.';
COMMENT ON COLUMN calendar_backend_state.cutover_by IS
  'Attore del cutover (admin:<id>), insieme a cutover_at (F4).';
COMMENT ON COLUMN calendar_backend_state.rollback_until IS
  'Fine della finestra di rollback (cutover + 30 giorni, F4).';
COMMENT ON COLUMN calendar_backend_state.finalized_at IS
  'Istante del finalize (F4/F7): fine della proiezione inversa.';
COMMENT ON COLUMN calendar_backend_state.api_min_version IS
  'Livello minimo del protocollo calendario dell''API (CALENDAR_API_LEVEL nel codice) che può partire su questo database (design §16.6). 0 = nessun vincolo; lo alza il cutover (F4) e lo verifica l''avvio.';
COMMENT ON COLUMN calendar_backend_state.last_stack_backup IS
  'Ultimo backup coordinato (DB + volume) registrato da scripts/backup-calendar-stack.sh: {id, at, complete, volume_id, epoch, manifest_sha256}. Il preflight lo usa per il controllo "backup di meno di 24 ore".';
COMMENT ON COLUMN calendar_backend_state.migration_declarations IS
  'Dichiarazioni esplicite del wizard ({chiave: {value, at, by}}): volume della Fase 0, remote mode accettata, 401 pubblico verificato a mano, backup verificato, matrice device. Contratto f3-modules §8.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendar_backend_state'::regclass AND conname = 'calendar_backend_state_shadow_check') THEN
    ALTER TABLE calendar_backend_state ADD CONSTRAINT calendar_backend_state_shadow_check
      CHECK (shadow_enabled = (shadow_since IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendar_backend_state'::regclass AND conname = 'calendar_backend_state_cutover_check') THEN
    ALTER TABLE calendar_backend_state ADD CONSTRAINT calendar_backend_state_cutover_check
      CHECK ((cutover_at IS NULL) = (cutover_by IS NULL)
             AND (cutover_by IS NULL OR octet_length(cutover_by) BETWEEN 1 AND 200));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendar_backend_state'::regclass AND conname = 'calendar_backend_state_api_min_version_check') THEN
    ALTER TABLE calendar_backend_state ADD CONSTRAINT calendar_backend_state_api_min_version_check
      CHECK (api_min_version >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendar_backend_state'::regclass AND conname = 'calendar_backend_state_last_backup_check') THEN
    ALTER TABLE calendar_backend_state ADD CONSTRAINT calendar_backend_state_last_backup_check
      CHECK (last_stack_backup IS NULL OR jsonb_typeof(last_stack_backup) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendar_backend_state'::regclass AND conname = 'calendar_backend_state_declarations_check') THEN
    ALTER TABLE calendar_backend_state ADD CONSTRAINT calendar_backend_state_declarations_check
      CHECK (jsonb_typeof(migration_declarations) = 'object');
  END IF;
END
$$;

-- ─── 2. Run dello strumento di migrazione ───────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_migration_runs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Azione eseguita (contratto f3-modules §5.1). I tipi della F4 (cutover,
  -- rollback_preview, rollback, rebaseline, finalize) sono già ammessi dal
  -- CHECK ma in F3 nessuno li crea.
  kind                TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'queued',
  -- Chi l'ha avviato: admin (wizard), schedule (cadenza dello shadow), shadow
  -- (catch-up all'attivazione), restore (dopo un import di backup), system.
  trigger             TEXT        NOT NULL DEFAULT 'admin',
  -- admin:<id utente>, system:shadow, ...
  requested_by        TEXT        NOT NULL,
  -- Chiave d'idempotenza del client (header Idempotency-Key): la stessa
  -- richiesta ripetuta restituisce lo stesso run; con un corpo diverso 409.
  idempotency_key     TEXT,
  -- sha256 del corpo normalizzato della richiesta che ha creato il run.
  request_hash        TEXT,
  -- Parametri del run (opzioni dell'anteprima, ambito, item forzati, ...):
  -- mai dati personali.
  params              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Apply e verifica: il run d'anteprima di riferimento e l'hash del piano
  -- visto dall'utente (l'apply lo ricalcola e si ferma se è cambiato).
  plan_run_id         UUID        REFERENCES cal_migration_runs(id) ON DELETE SET NULL,
  plan_hash           TEXT,
  -- Avanzamento interrogabile: {phase, done, total, calendar_id?, message?}.
  progress            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Riassunto dell'esito, per tipo (types.ts del contratto).
  summary             JSONB,
  error               TEXT,
  error_code          TEXT,
  -- Riprese dopo un riavvio o un lease scaduto del job che lo esegue.
  attempts            INTEGER     NOT NULL DEFAULT 0,
  -- cal_jobs.id del job 'migration_run' che lo esegue (senza FK: la coda si
  -- ripulisce da sola).
  job_id              BIGINT,
  -- Battito dell'esecutore: un run 'running' con battito vecchio e lock
  -- libero è stato interrotto (crash) e si riprende.
  heartbeat_at        TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cal_migration_runs_kind_check CHECK (kind IN (
    'preflight', 'init', 'archive', 'identity', 'inventory', 'plan', 'apply', 'verify',
    'cutover', 'rollback_preview', 'rollback', 'rebaseline', 'finalize'
  )),
  CONSTRAINT cal_migration_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  CONSTRAINT cal_migration_runs_trigger_check
    CHECK (trigger IN ('admin', 'schedule', 'shadow', 'restore', 'system')),
  CONSTRAINT cal_migration_runs_requested_by_check CHECK (octet_length(requested_by) BETWEEN 1 AND 200),
  CONSTRAINT cal_migration_runs_idempotency_key_check
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
  CONSTRAINT cal_migration_runs_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cal_migration_runs_plan_hash_check
    CHECK (plan_hash IS NULL OR plan_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cal_migration_runs_error_code_check
    CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT cal_migration_runs_json_check CHECK (
    jsonb_typeof(params) = 'object' AND jsonb_typeof(progress) = 'object'
    AND (summary IS NULL OR jsonb_typeof(summary) = 'object')
  ),
  CONSTRAINT cal_migration_runs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT cal_migration_runs_finished_check
    CHECK ((status IN ('succeeded', 'failed', 'cancelled', 'interrupted')) = (finished_at IS NOT NULL)),
  CONSTRAINT cal_migration_runs_started_check
    CHECK (status NOT IN ('running', 'succeeded') OR started_at IS NOT NULL),
  CONSTRAINT cal_migration_runs_not_self_check CHECK (plan_run_id IS DISTINCT FROM id)
);

COMMENT ON TABLE cal_migration_runs IS
  'Run dello strumento di migrazione (design §13.2): uno per azione del wizard, eseguito in background sotto pg_advisory_lock(''cal-migration'') e ripreso dopo un riavvio. Un solo run attivo alla volta. Gruppo S del backup JSON; retention 30 giorni (design §16.4).';
COMMENT ON COLUMN cal_migration_runs.status IS
  'queued (in attesa dell''esecutore), running, succeeded, failed, cancelled (annullato su richiesta), interrupted (esecutore sparito senza ripresa possibile).';

-- Un solo run attivo (queued o running) in tutto il database: la seconda
-- richiesta riceve 409 MIGRATION_BUSY con il run in corso.
CREATE UNIQUE INDEX IF NOT EXISTS cal_migration_runs_single_active
  ON cal_migration_runs ((true)) WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS cal_migration_runs_idempotency_key
  ON cal_migration_runs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS cal_migration_runs_kind_idx
  ON cal_migration_runs (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS cal_migration_runs_finished_idx
  ON cal_migration_runs (finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS cal_migration_runs_plan_idx
  ON cal_migration_runs (plan_run_id) WHERE plan_run_id IS NOT NULL;

-- ─── 3. Righe dei run ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_migration_items (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          UUID        NOT NULL REFERENCES cal_migration_runs(id) ON DELETE CASCADE,
  -- Ordine dentro il run (stabile negli export e nella paginazione).
  seq             INTEGER     NOT NULL,
  -- check: controllo del preflight; anomaly: anomalia dell'inventario o del
  -- piano; object: esito per oggetto del piano o dell'apply; collection:
  -- esito per collezione dell'inizializzazione; diff: differenza della
  -- verifica (V1-V5); degradation: degrado del rollback (F4).
  item_type       TEXT        NOT NULL,
  -- Riferimenti senza FK: il run resta leggibile anche dopo la cancellazione
  -- del calendario o della riga legacy.
  calendar_id     UUID,
  collection_name TEXT,
  href            TEXT,
  legacy_key      TEXT,
  -- Solo per item_type='object': azione del piano...
  action          TEXT,
  -- ...ed esito dell'apply.
  outcome         TEXT,
  -- Codice del controllo, dell'anomalia, del conflitto o della differenza.
  code            TEXT,
  -- Solo per item_type='diff': livello della verifica.
  level           TEXT,
  severity        TEXT        NOT NULL DEFAULT 'info',
  -- Solo per item_type='diff': differenza attesa (gialla, da accettare) o
  -- inattesa (rossa, blocca il cutover).
  expected        BOOLEAN,
  -- Dettaglio strutturato (contratto f3-modules §5.4): mai email, telefoni,
  -- messaggi o descrizioni delle prenotazioni.
  detail          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Conflitto sovrascritto su richiesta esplicita ("forza").
  forced          BOOLEAN     NOT NULL DEFAULT false,
  -- Accettazione esplicita di una differenza attesa.
  accepted_at     TIMESTAMPTZ,
  accepted_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cal_migration_items_run_seq_key UNIQUE (run_id, seq),
  CONSTRAINT cal_migration_items_seq_check CHECK (seq >= 0),
  CONSTRAINT cal_migration_items_type_check
    CHECK (item_type IN ('check', 'anomaly', 'object', 'collection', 'diff', 'degradation')),
  CONSTRAINT cal_migration_items_action_check CHECK (
    action IS NULL OR (item_type = 'object'
      AND action IN ('create', 'update', 'delete', 'noop', 'adopt', 'skip', 'conflict'))
  ),
  CONSTRAINT cal_migration_items_outcome_check CHECK (
    outcome IS NULL OR (item_type = 'object'
      AND outcome IN ('done', 'adopted', 'noop', 'skipped', 'conflict', 'failed', 'forced'))
  ),
  CONSTRAINT cal_migration_items_code_check CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT cal_migration_items_level_check CHECK (
    (item_type <> 'diff' AND level IS NULL)
    OR (item_type = 'diff' AND level IS NOT NULL AND level IN ('V1', 'V2', 'V3', 'V4', 'V5'))
  ),
  CONSTRAINT cal_migration_items_expected_check CHECK ((expected IS NULL) = (item_type <> 'diff')),
  CONSTRAINT cal_migration_items_severity_check CHECK (severity IN ('info', 'warning', 'error')),
  CONSTRAINT cal_migration_items_detail_check CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT cal_migration_items_accepted_check CHECK (
    (accepted_at IS NULL) = (accepted_by IS NULL)
    AND (accepted_at IS NULL OR (item_type = 'diff' AND expected))
  ),
  CONSTRAINT cal_migration_items_forced_check CHECK (NOT forced OR item_type = 'object'),
  CONSTRAINT cal_migration_items_href_check
    CHECK (href IS NULL OR (octet_length(href) BETWEEN 1 AND 1024 AND href !~ '[/\\\x01-\x1f\x7f]'))
);

COMMENT ON TABLE cal_migration_items IS
  'Righe dei run dello strumento di migrazione: controlli, anomalie, esiti per oggetto, differenze V1-V5 con l''accettazione esplicita, degradi (F4). Gruppo S del backup JSON; ripulite dall''erasure GDPR e con la retention dei run.';

CREATE INDEX IF NOT EXISTS cal_migration_items_run_type_idx
  ON cal_migration_items (run_id, item_type, seq);
CREATE INDEX IF NOT EXISTS cal_migration_items_run_code_idx
  ON cal_migration_items (run_id, code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS cal_migration_items_legacy_key_idx
  ON cal_migration_items (legacy_key) WHERE legacy_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS cal_migration_items_calendar_idx
  ON cal_migration_items (calendar_id) WHERE calendar_id IS NOT NULL;

-- ─── 4. Ledger a tre vie ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_migration_ledger (
  id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Collezione di destinazione: calendars.id e collection_name al momento
  -- della scrittura, senza FK (il ledger sopravvive alla cancellazione del
  -- calendario: la collezione resta in Radicale finché l'admin non decide).
  calendar_id         UUID        NOT NULL,
  collection_name     TEXT        NOT NULL,
  -- Nome della risorsa nella collezione (ultimo segmento, decodificato).
  href                TEXT        NOT NULL,
  -- event: master legacy con i suoi override; detached: override orfano
  -- convertito in evento singolo; booking: proiezione di una prenotazione
  -- rigenerata da calendar_bookings; archive: item del volume della Fase 0
  -- (decisione 7).
  kind                TEXT        NOT NULL,
  -- event:<uuid del master>, detached:<uuid dell'override>,
  -- booking:<uid della prenotazione>, archive:<nome originale>.
  legacy_key          TEXT        NOT NULL,
  -- Riga legacy da cui deriva l'id dell'oggetto (master, override staccato o
  -- riga della proiezione), senza FK.
  legacy_event_id     UUID,
  -- UID scritto nella risorsa.
  uid                 TEXT,
  -- Ingresso canonico del serializer che ha prodotto l'ultima scrittura
  -- (righe legacy, prenotazione, opzioni): base del diff per campo dello
  -- shadow mirror (design §13.8). NULL se mai scritto o dopo un'erasure.
  legacy_snapshot     JSONB,
  -- s<versione del serializer>:<sha256 dello snapshot canonico>. NULL su una
  -- riga scritta = sorgente da riscrivere (erasure GDPR).
  legacy_hash         TEXT,
  -- Stato della destinazione dopo l'ultima scrittura (o adozione).
  written_etag        TEXT,
  written_fingerprint TEXT,
  written_at          TIMESTAMPTZ,
  -- Riga d'intento (design §13.6): scritta e committata PRIMA della PUT o
  -- della DELETE, azzerata insieme all'aggiornamento di written_* dopo
  -- l'esito. Un intento pendente al giro successivo porta a un GET della
  -- destinazione e all'adozione (fingerprint uguale) o al conflitto.
  intent_op           TEXT,
  intent_fingerprint  TEXT,
  intent_legacy_hash  TEXT,
  intent_snapshot     JSONB,
  -- ETag usato come If-Match dall'intento (update e delete).
  intent_etag         TEXT,
  intent_at           TIMESTAMPTZ,
  intent_run_id       UUID,
  -- La destinazione esisteva già con lo stesso contenuto (adozione per
  -- fingerprint, no-uid-conflict con lo stesso contenuto, ri-baseline F4):
  -- gli update passano dalla patch per campo sull'oggetto corrente.
  adopted             BOOLEAN     NOT NULL DEFAULT false,
  -- Oggetto legato a righe derivate dalla proiezione inversa (F4).
  derived             BOOLEAN     NOT NULL DEFAULT false,
  -- Rivalidazione richiesta (import di un backup, riassegnazione
  -- d'identità): finché è valorizzata, ogni azione diversa da noop/adopt su
  -- questa riga diventa conflitto REVALIDATION_REQUIRED (design §16.2).
  revalidate_reason   TEXT,
  revalidate_since    TIMESTAMPTZ,
  -- Risorsa rimossa dalla destinazione con successo (riga ritirata,
  -- riutilizzata se lo stesso href torna nel piano).
  deleted_at          TIMESTAMPTZ,
  last_run_id         UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cal_migration_ledger_href_key UNIQUE (calendar_id, href),
  CONSTRAINT cal_migration_ledger_kind_check CHECK (kind IN ('event', 'detached', 'booking', 'archive')),
  CONSTRAINT cal_migration_ledger_legacy_key_check
    CHECK (octet_length(legacy_key) BETWEEN 3 AND 512 AND split_part(legacy_key, ':', 1) = kind
           AND length(legacy_key) > length(kind) + 1),
  CONSTRAINT cal_migration_ledger_collection_check CHECK (calendar_collection_name_valid(collection_name)),
  CONSTRAINT cal_migration_ledger_href_check
    CHECK (octet_length(href) BETWEEN 1 AND 1024 AND href !~ '[/\\\x01-\x1f\x7f]'),
  CONSTRAINT cal_migration_ledger_hash_check CHECK (
    (legacy_hash IS NULL OR legacy_hash ~ '^s[0-9]{1,6}:[0-9a-f]{64}$')
    AND (intent_legacy_hash IS NULL OR intent_legacy_hash ~ '^s[0-9]{1,6}:[0-9a-f]{64}$')
  ),
  CONSTRAINT cal_migration_ledger_snapshot_check CHECK (
    (legacy_snapshot IS NULL OR jsonb_typeof(legacy_snapshot) = 'object')
    AND (intent_snapshot IS NULL OR jsonb_typeof(intent_snapshot) = 'object')
  ),
  CONSTRAINT cal_migration_ledger_written_check CHECK ((written_at IS NULL) = (written_fingerprint IS NULL)),
  CONSTRAINT cal_migration_ledger_intent_check CHECK (
    (intent_op IS NULL OR intent_op IN ('create', 'update', 'delete'))
    AND (intent_op IS NULL) = (intent_at IS NULL)
    AND (intent_op IS NULL OR intent_op = 'delete'
         OR (intent_fingerprint IS NOT NULL AND intent_legacy_hash IS NOT NULL))
    AND (intent_op IS NOT NULL OR (intent_fingerprint IS NULL AND intent_legacy_hash IS NULL
                                   AND intent_snapshot IS NULL AND intent_etag IS NULL AND intent_run_id IS NULL))
  ),
  CONSTRAINT cal_migration_ledger_deleted_check
    CHECK (deleted_at IS NULL OR (written_etag IS NULL AND written_at IS NULL AND intent_op IS NULL)),
  CONSTRAINT cal_migration_ledger_revalidate_check CHECK (
    (revalidate_reason IS NULL) = (revalidate_since IS NULL)
    AND (revalidate_reason IS NULL OR revalidate_reason ~ '^[a-z][a-z0-9_-]{0,63}$')
  ),
  CONSTRAINT cal_migration_ledger_derived_check CHECK (NOT derived OR kind IN ('event', 'detached'))
);

COMMENT ON TABLE cal_migration_ledger IS
  'Ledger a tre vie della migrazione, una riga per href (design §4, §13.6): sorgente (legacy_hash, legacy_snapshot), destinazione (written_etag, written_fingerprint), riga d''intento prima di ogni PUT/DELETE, adopted e derived. Persistente, gruppo S del backup JSON.';
COMMENT ON COLUMN cal_migration_ledger.legacy_key IS
  'Chiave della sorgente: event:<uuid del master>, detached:<uuid dell''override orfano>, booking:<uid della prenotazione>, archive:<nome originale>. Al più una riga viva per (collezione, chiave).';
COMMENT ON COLUMN cal_migration_ledger.intent_op IS
  'Riga d''intento: create, update o delete in corso. Pendente al giro successivo → GET della destinazione: fingerprint uguale all''intento → adozione (noop), uguale allo scritto → intento mai applicato, altrimenti conflict:UNTRACKED_TARGET.';

-- Al più una riga viva per chiave in una collezione: durante lo spostamento
-- di un evento fra calendari la chiave vive per un attimo in due collezioni
-- (prima la creazione nella nuova, poi la DELETE nella vecchia).
CREATE UNIQUE INDEX IF NOT EXISTS cal_migration_ledger_live_key
  ON cal_migration_ledger (calendar_id, legacy_key) WHERE deleted_at IS NULL;
-- Radicale rifiuta due risorse con lo stesso UID nella stessa collezione
-- (409 no-uid-conflict): il ledger lo riflette.
CREATE UNIQUE INDEX IF NOT EXISTS cal_migration_ledger_live_uid
  ON cal_migration_ledger (calendar_id, uid) WHERE deleted_at IS NULL AND uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS cal_migration_ledger_key_idx
  ON cal_migration_ledger (legacy_key);
CREATE INDEX IF NOT EXISTS cal_migration_ledger_legacy_event_idx
  ON cal_migration_ledger (legacy_event_id) WHERE legacy_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cal_migration_ledger_intent_idx
  ON cal_migration_ledger (intent_at) WHERE intent_op IS NOT NULL;
CREATE INDEX IF NOT EXISTS cal_migration_ledger_revalidate_idx
  ON cal_migration_ledger (calendar_id) WHERE revalidate_reason IS NOT NULL;

-- Rivalidazione del ledger (design §16.2: "con lo shadow attivo, ledger
-- rivalidato con un plan dry-run: le differenze diventano conflitti, mai
-- sovrascritture"). La chiama l'import del backup JSON nella sua transazione
-- (e la riassegnazione d'identità): marca le righe vive che non sono già da
-- rivalidare e restituisce quante. Idempotente: una seconda chiamata con
-- righe già marcate non cambia nulla e restituisce 0.
CREATE OR REPLACE FUNCTION cal_migration_ledger_require_revalidation(p_reason TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_-]{0,63}$' THEN
    RAISE EXCEPTION 'motivo di rivalidazione non valido: %', p_reason
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE cal_migration_ledger
  SET revalidate_reason = p_reason, revalidate_since = now()
  WHERE deleted_at IS NULL AND revalidate_reason IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

COMMENT ON FUNCTION cal_migration_ledger_require_revalidation(TEXT) IS
  'Marca da rivalidare le righe vive del ledger (dopo un import di backup o una riassegnazione d''identità): ogni scrittura necessaria su quelle righe diventa conflitto REVALIDATION_REQUIRED finché non è forzata o il piano la trova già allineata.';

-- updated_at gestito dal database.
CREATE OR REPLACE FUNCTION cal_migration_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cal_migration_runs_touch ON cal_migration_runs;
CREATE TRIGGER cal_migration_runs_touch
  BEFORE UPDATE ON cal_migration_runs
  FOR EACH ROW EXECUTE FUNCTION cal_migration_touch_updated_at();

DROP TRIGGER IF EXISTS cal_migration_ledger_touch ON cal_migration_ledger;
CREATE TRIGGER cal_migration_ledger_touch
  BEFORE UPDATE ON cal_migration_ledger
  FOR EACH ROW EXECUTE FUNCTION cal_migration_touch_updated_at();

-- ─── 5. Shadow mirror: accodamento nella transazione legacy ─────────────────

-- Chiave del job shadow_mirror per una riga di calendar_events (contratto
-- f3-modules §6.2): le proiezioni delle prenotazioni (source booking con
-- source_id) si rigenerano da calendar_bookings → booking:<uid>; ogni altra
-- riga appartiene all'oggetto del proprio master → event:<uuid del master>
-- (gli override del master e quelli orfani, che il serializer stacca, si
-- rielaborano insieme). Le righe delle iscrizioni non arrivano qui (WHEN dei
-- trigger).
CREATE OR REPLACE FUNCTION cal_shadow_event_key(
  p_id UUID, p_master_id UUID, p_source TEXT, p_source_id TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_source = 'ics_pull' THEN NULL
    WHEN p_source = 'booking' AND nullif(btrim(p_source_id), '') IS NOT NULL
      THEN 'booking:' || btrim(p_source_id)
    ELSE 'event:' || COALESCE(p_master_id, p_id)::text
  END
$$;

-- Accoda shadow_mirror (cal_jobs, 164) per le chiavi toccate dalla riga, con
-- la stessa coalescenza di enqueueCalendarJob (solo sui pending: un job già
-- in esecuzione non assorbe la modifica, che produce un pending nuovo).
-- Debounce di 2 s per raccogliere le scritture di una stessa operazione
-- (master più override, cascata della cancellazione). Nessun effetto se:
--  - la scrittura è della proiezione inversa (GUC caldes.reverse_sync='on');
--  - mode ≠ 'postgres', shadow spento o volume non registrato.
CREATE OR REPLACE FUNCTION cal_shadow_mirror_enqueue()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_mode    TEXT;
  v_enabled BOOLEAN;
  v_volume  UUID;
  v_keys    TEXT[] := ARRAY[]::TEXT[];
  v_key     TEXT;
BEGIN
  IF current_setting('caldes.reverse_sync', true) = 'on' THEN
    RETURN NULL;
  END IF;

  SELECT s.mode, s.shadow_enabled, s.volume_id
    INTO v_mode, v_enabled, v_volume
  FROM calendar_backend_state s
  WHERE s.id;
  IF NOT FOUND OR v_mode <> 'postgres' OR NOT v_enabled OR v_volume IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'calendar_events' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      v_keys := v_keys || cal_shadow_event_key(NEW.id, NEW.recurrence_master_id, NEW.source, NEW.source_id);
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      v_keys := v_keys || cal_shadow_event_key(OLD.id, OLD.recurrence_master_id, OLD.source, OLD.source_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'calendar_bookings' THEN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      v_keys := v_keys || ('booking:' || NEW.uid);
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      v_keys := v_keys || ('booking:' || OLD.uid);
    END IF;
  END IF;

  FOR v_key IN SELECT DISTINCT k FROM unnest(v_keys) AS k WHERE k IS NOT NULL LOOP
    INSERT INTO cal_jobs (kind, key, payload, source_version, priority, run_after)
    VALUES (
      'shadow_mirror',
      v_key,
      jsonb_build_object('legacy_key', v_key, 'table', TG_TABLE_NAME, 'op', TG_OP),
      txid_current()::text,
      100,
      now() + INTERVAL '2 seconds'
    )
    ON CONFLICT (kind, key) WHERE status = 'pending' DO UPDATE SET
      payload        = EXCLUDED.payload,
      source_version = EXCLUDED.source_version,
      priority       = LEAST(cal_jobs.priority, EXCLUDED.priority),
      run_after      = LEAST(cal_jobs.run_after, EXCLUDED.run_after),
      attempts       = 0;
  END LOOP;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION cal_shadow_mirror_enqueue() IS
  'Shadow mirror (design §13.8): accoda shadow_mirror(legacy_key) in cal_jobs nella transazione della scrittura legacy, solo con mode=postgres, shadow_enabled e volume registrato; mai per le iscrizioni né con caldes.reverse_sync=on.';

-- calendar_events: tutte le righe tranne quelle delle iscrizioni.
DROP TRIGGER IF EXISTS calendar_events_shadow_enqueue ON calendar_events;
CREATE TRIGGER calendar_events_shadow_enqueue
  AFTER INSERT OR UPDATE ON calendar_events
  FOR EACH ROW
  WHEN (NEW.source <> 'ics_pull')
  EXECUTE FUNCTION cal_shadow_mirror_enqueue();

DROP TRIGGER IF EXISTS calendar_events_shadow_enqueue_delete ON calendar_events;
CREATE TRIGGER calendar_events_shadow_enqueue_delete
  AFTER DELETE ON calendar_events
  FOR EACH ROW
  WHEN (OLD.source <> 'ics_pull')
  EXECUTE FUNCTION cal_shadow_mirror_enqueue();

-- calendar_bookings: le colonne da cui dipende il contenuto della proiezione
-- (decisione 3) e il suo stato desiderato. Gli UPDATE che toccano altro
-- (promemoria, consenso, metadati) non accodano nulla.
DROP TRIGGER IF EXISTS calendar_bookings_shadow_enqueue ON calendar_bookings;
CREATE TRIGGER calendar_bookings_shadow_enqueue
  AFTER INSERT OR DELETE OR UPDATE OF
    status, start_time, end_time, attendee_name, attendee_email, attendee_phone,
    location_type, location_value, event_type_id
  ON calendar_bookings
  FOR EACH ROW
  EXECUTE FUNCTION cal_shadow_mirror_enqueue();
