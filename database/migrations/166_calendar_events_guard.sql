-- 166_calendar_events_guard.sql — Guardia di calendar_events guidata dallo
-- stato, journal delle transizioni e stato della proiezione inversa (fase F4
-- del passaggio del calendario a Radicale: cutover, rollback, proiezione
-- inversa totale).
--
-- Riferimenti: docs/calendar-radicale/design.md §4 (166), §13.9-§13.13,
-- §16.2 e il contratto dei moduli docs/calendar-radicale/contracts/
-- f4-modules.md, che fissa chi scrive cosa e come si leggono queste tabelle.
--
-- Cosa aggiunge:
--  1. calendar_events: colonne caldes_object_id e caldes_derived, ignorate dal
--     codice legacy (che seleziona sempre colonne esplicite). Le valorizza
--     solo la proiezione inversa (F4): caldes_object_id è l'id persistente
--     (cal_object_ids, recurrence_key '') della risorsa Radicale da cui la
--     riga deriva, caldes_derived marca le occorrenze espanse (RDATE, fusi
--     diversi da Europe/Rome, orfani, regole che il legacy non espande come
--     calendar-core: design §13.11);
--  2. guardia su calendar_events (trigger calendar_events_guard), SEMPRE
--     attiva e senza DDL al cutover: fuori da mode 'postgres' ogni INSERT,
--     UPDATE, DELETE e TRUNCATE fallisce con SQLSTATE CD166, salvo:
--      - le scritture della transazione che ha impostato
--        set_config('caldes.reverse_sync', txid_current()::text, true)
--        (proiezione inversa, erasure GDPR, cancellazione di un calendario da
--        RadicaleStore): un valore 'on' o rimasto nella sessione non conta;
--      - le DELETE in cascata di una riga padre già cancellata nella stessa
--        transazione: il calendario (calendars), l'iscrizione
--        (calendar_subscriptions) o il master della ricorrenza. Così la
--        delete di un calendario completa le cascate anche senza il GUC;
--     In mode 'postgres' la guardia è inerte: le scritture passano come
--     prima. La lettura dello stato avviene con FOR SHARE sulla riga
--     singleton: è la barriera delle transizioni (design §13.9). La
--     transazione che cambia mode (UPDATE della riga) attende la fine delle
--     transazioni che hanno già scritto calendar_events, e una scrittura
--     successiva legge il mode nuovo e fallisce; in REPEATABLE READ una
--     scrittura con una fotografia precedente al cambio fallisce con 40001.
--     session_replication_role = replica spegne il trigger: per questo
--     backup.ts esclude il dominio a livello applicativo (design §16.2);
--  3. cal_migration_transitions e cal_migration_journal: journal delle
--     transizioni di stato (cutover, rollback, finalize). Una sola
--     transizione attiva alla volta; ogni passo è registrato (iniziato,
--     concluso, saltato, fallito) e una ripresa dopo un crash riparte dal
--     primo passo non concluso, con lo stato del backend già scritto
--     (migration/transition.ts);
--  4. cal_migration_reverse_state: stato della proiezione inversa per risorsa
--     Radicale (righe legacy scritte, degradi per classe, REVERSE_FAILED),
--     base dell'anteprima del rollback, della salute nel wizard e della
--     ri-baseline del ledger (migration/reverse-projector.ts, rebaseline.ts).
--
-- Le tabelle nuove hanno il prefisso cal_migration_: gruppo S del backup JSON
-- (apps/api/src/routes/backup.ts, STATE_TABLE_PREFIXES), esportate e mai
-- ripristinate. Nessuna FK verso calendar_events (il backup JSON la svuota
-- senza CASCADE).
--
-- Append-only e idempotente: IF NOT EXISTS, controlli sul catalogo, CREATE OR
-- REPLACE per le funzioni, DROP/CREATE dei trigger. Compatibile con i dati di
-- produzione (mode 'postgres'): nessun backfill, le colonne nuove nascono
-- NULL/false e le tabelle vuote.

-- ─── 1. calendar_events: colonne della proiezione inversa ──────────────────

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS caldes_object_id UUID,
  ADD COLUMN IF NOT EXISTS caldes_derived   BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN calendar_events.caldes_object_id IS
  'Proiezione inversa (F4): id persistente (cal_object_ids.id con recurrence_key '''') della risorsa Radicale da cui deriva la riga. NULL per le righe scritte dal codice legacy. Ignorata dal codice legacy; senza FK (cal_object_ids è del gruppo S del backup).';
COMMENT ON COLUMN calendar_events.caldes_derived IS
  'Proiezione inversa (F4): riga derivata per espansione (occorrenza singola di una risorsa che il legacy non rappresenta: RDATE, fuso diverso da Europe/Rome, orfani, regole espanse diversamente). Una riga derivata modificata in PG dopo un rollback diventa il conflitto DERIVED_EDITED al cutover successivo.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'calendar_events'::regclass AND conname = 'calendar_events_caldes_derived_check'
  ) THEN
    ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_caldes_derived_check
      CHECK (NOT caldes_derived OR caldes_object_id IS NOT NULL);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS calendar_events_caldes_object_idx
  ON calendar_events (caldes_object_id) WHERE caldes_object_id IS NOT NULL;

-- ─── 2. Guardia guidata dallo stato ─────────────────────────────────────────

-- Codice d'errore CD166 (classe non usata da Postgres): l'API lo riconosce
-- (isCalendarEventsGuardError in migration/transition.ts) e lo traduce in
-- indisponibilità per transizione invece che in un errore interno.
CREATE OR REPLACE FUNCTION calendar_events_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_mode TEXT;
BEGIN
  -- Scrittori privilegiati: proiezione inversa, erasure GDPR, cancellazione
  -- di un calendario da RadicaleStore. Coordinati fra loro dal lock
  -- cal-migration e dal gate cal-write, non da questa barriera.
  -- Il GUC vale solo se contiene l'id della transazione corrente: un 'on' o un valore
  -- rimasto nella sessione (set_config(..., false) da un percorso applicativo) non passa.
  IF current_setting('caldes.reverse_sync', true) = txid_current()::text THEN
    IF TG_LEVEL = 'STATEMENT' THEN
      RETURN NULL;
    ELSIF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- Barriera delle transizioni: FOR SHARE sulla riga singleton. Un UPDATE
  -- dello stato in corso fa attendere la scrittura, che poi legge il mode
  -- nuovo (READ COMMITTED) o fallisce con 40001 (REPEATABLE READ). Il lock
  -- resta fino alla fine della transazione: la transizione attende chi ha
  -- già scritto.
  SELECT s.mode INTO v_mode
  FROM calendar_backend_state s
  WHERE s.id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'calendar_events non scrivibile: stato del backend calendario assente'
      USING ERRCODE = 'CD166',
            DETAIL = format('operazione %s su calendar_events senza la riga di calendar_backend_state', TG_OP),
            HINT = 'La riga singleton nasce con la migrazione 162: ripristina lo stato prima di scrivere.';
  END IF;

  IF v_mode = 'postgres' THEN
    IF TG_LEVEL = 'STATEMENT' THEN
      RETURN NULL;
    ELSIF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- Cascate di una riga padre già cancellata in questa transazione: il
  -- vincolo ON DELETE CASCADE esegue la DELETE dopo aver tolto il padre, che
  -- qui non è più visibile. Una DELETE diretta di una riga con il padre
  -- presente non passa.
  -- Solo con mode radicale/finalized: in cutover e rollback una DELETE di padri
  -- senza il GUC è una scrittura legacy fuori dal delta e fallisce.
  IF TG_LEVEL = 'ROW' AND TG_OP = 'DELETE' AND v_mode IN ('radicale', 'finalized') THEN
    IF NOT EXISTS (SELECT 1 FROM calendars c WHERE c.id = OLD.calendar_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.subscription_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM calendar_subscriptions cs WHERE cs.id = OLD.subscription_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.recurrence_master_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM calendar_events e WHERE e.id = OLD.recurrence_master_id) THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'calendar_events è in sola lettura con mode %: gli eventi stanno in Radicale e Postgres riceve solo la proiezione inversa', v_mode
    USING ERRCODE = 'CD166',
          DETAIL = format('operazione %s su calendar_events rifiutata dalla guardia 166 (mode=%s)', TG_OP, v_mode),
          HINT = 'Scrivi dallo store Radicale. Solo la proiezione inversa, l''erasure GDPR e la cancellazione di un calendario impostano caldes.reverse_sync all''id della transazione: SELECT set_config(''caldes.reverse_sync'', txid_current()::text, true).';
END
$$;

COMMENT ON FUNCTION calendar_events_guard() IS
  'Guardia 166 (design §4, §13.9): fuori da mode=postgres ogni scrittura su calendar_events fallisce con SQLSTATE CD166, salvo caldes.reverse_sync uguale a txid_current() (impostato con is_local) e, con mode radicale o finalized, le cascate di una riga padre già cancellata (calendario, iscrizione, master). Legge lo stato con FOR SHARE: barriera delle transizioni.';

-- Prima degli altri trigger BEFORE (ordine alfabetico: calendar_events_guard
-- precede calendar_events_updated): una scrittura rifiutata non tocca nulla.
DROP TRIGGER IF EXISTS calendar_events_guard ON calendar_events;
CREATE TRIGGER calendar_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION calendar_events_guard();

-- TRUNCATE salta i trigger di riga: la stessa guardia a livello di statement.
DROP TRIGGER IF EXISTS calendar_events_guard_truncate ON calendar_events;
CREATE TRIGGER calendar_events_guard_truncate
  BEFORE TRUNCATE ON calendar_events
  FOR EACH STATEMENT EXECUTE FUNCTION calendar_events_guard();

-- ─── 3. Journal delle transizioni ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_migration_transitions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- cutover (postgres → radicale), rollback (radicale → postgres), finalize
  -- (radicale → finalized). Contratto f4-modules §2.
  kind          TEXT        NOT NULL,
  -- active (in corso o da riprendere), completed, aborted (tornata al mode
  -- di partenza prima del passo d'epoch, per esempio verifica rossa nel
  -- cutover o anteprima cambiata nel rollback).
  status        TEXT        NOT NULL DEFAULT 'active',
  from_mode     TEXT        NOT NULL,
  target_mode   TEXT        NOT NULL,
  -- Run che la sta eseguendo, o l'ultimo che l'ha eseguita (una ripresa con
  -- un run nuovo lo sostituisce). Senza FK, come nel journal: i run hanno
  -- una retention di 30 giorni, la transizione resta come storico.
  run_id        UUID,
  epoch_before  INTEGER     NOT NULL,
  -- Epoch scritto dal passo d'epoch (epoch_before + 1); NULL prima.
  epoch_after   INTEGER,
  started_by    TEXT        NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  -- Esito di una transizione conclusa o annullata: codice e testo in
  -- italiano, mai dati personali.
  outcome_code  TEXT,
  outcome       TEXT,
  -- Parametri e risultati fra i passi (anteprima attesa, finestra di
  -- rollback, criteri): mai dati personali.
  data          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cal_migration_transitions_kind_check CHECK (kind IN ('cutover', 'rollback', 'finalize')),
  CONSTRAINT cal_migration_transitions_status_check CHECK (status IN ('active', 'completed', 'aborted')),
  CONSTRAINT cal_migration_transitions_mode_check CHECK (
    from_mode IN ('postgres', 'cutover', 'radicale', 'rollback', 'finalized')
    AND target_mode IN ('postgres', 'cutover', 'radicale', 'rollback', 'finalized')
    AND from_mode <> target_mode
  ),
  CONSTRAINT cal_migration_transitions_epoch_check CHECK (
    epoch_before >= 0 AND (epoch_after IS NULL OR epoch_after = epoch_before + 1)
  ),
  CONSTRAINT cal_migration_transitions_started_by_check CHECK (octet_length(started_by) BETWEEN 1 AND 200),
  CONSTRAINT cal_migration_transitions_finished_check CHECK ((status = 'active') = (finished_at IS NULL)),
  CONSTRAINT cal_migration_transitions_outcome_code_check
    CHECK (outcome_code IS NULL OR outcome_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT cal_migration_transitions_data_check CHECK (jsonb_typeof(data) = 'object')
);

COMMENT ON TABLE cal_migration_transitions IS
  'Transizioni di stato del calendario (design §13.9-§13.13): cutover, rollback e finalize, una sola attiva alla volta. Il journal dei passi è in cal_migration_journal. Gruppo S del backup JSON.';

-- Una sola transizione attiva (in corso o da riprendere) in tutto il database.
CREATE UNIQUE INDEX IF NOT EXISTS cal_migration_transitions_single_active
  ON cal_migration_transitions ((true)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS cal_migration_transitions_kind_idx
  ON cal_migration_transitions (kind, started_at DESC);

CREATE TABLE IF NOT EXISTS cal_migration_journal (
  transition_id UUID        NOT NULL REFERENCES cal_migration_transitions(id) ON DELETE CASCADE,
  -- Nome del passo (CUTOVER_STEPS, ROLLBACK_STEPS, FINALIZE_STEPS di
  -- migration/types.ts).
  step          TEXT        NOT NULL,
  -- Ordine di esecuzione del passo (prima volta che è iniziato).
  seq           INTEGER     NOT NULL,
  -- started (in corso o interrotto da un crash), done, skipped, failed
  -- (l'ultimo tentativo è fallito: la ripresa lo ripete).
  status        TEXT        NOT NULL DEFAULT 'started',
  attempts      INTEGER     NOT NULL DEFAULT 1,
  -- Run che ha eseguito l'ultimo tentativo (senza FK: i run hanno una
  -- retention di 30 giorni, il journal resta con la transizione).
  run_id        UUID,
  -- Esito del passo (report della quiescenza, conteggi, hash): mai dati
  -- personali.
  data          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error_code    TEXT,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cal_migration_journal_pkey PRIMARY KEY (transition_id, step),
  CONSTRAINT cal_migration_journal_seq_key UNIQUE (transition_id, seq),
  CONSTRAINT cal_migration_journal_step_check CHECK (step ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT cal_migration_journal_seq_check CHECK (seq >= 0),
  CONSTRAINT cal_migration_journal_status_check CHECK (status IN ('started', 'done', 'skipped', 'failed')),
  CONSTRAINT cal_migration_journal_attempts_check CHECK (attempts >= 1),
  CONSTRAINT cal_migration_journal_finished_check CHECK ((status = 'started') = (finished_at IS NULL)),
  CONSTRAINT cal_migration_journal_error_code_check
    CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT cal_migration_journal_error_check CHECK ((error_code IS NULL AND error IS NULL) OR status = 'failed'),
  CONSTRAINT cal_migration_journal_data_check CHECK (jsonb_typeof(data) = 'object')
);

COMMENT ON TABLE cal_migration_journal IS
  'Journal dei passi di una transizione (design §13.9: "ogni passo è journalizzato: un crash fa ripartire dal passo successivo con lo stato già scritto"). I passi che cambiano lo stato del backend scrivono la riga done nella stessa transazione dell''UPDATE di calendar_backend_state. Gruppo S del backup JSON.';

-- ─── 4. Stato della proiezione inversa ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_migration_reverse_state (
  -- Risorsa Radicale: id persistente con recurrence_key '' (cal_object_ids).
  -- Senza FK: nessuna tabella referenzia l'indice della F2 (163-164), che
  -- resta ricostruibile da sé; le righe di risorse ritirate le chiude il
  -- proiettore (status removed), quelle dei calendari cancellati la cascata
  -- su calendars.
  object_id     UUID        PRIMARY KEY,
  calendar_id   UUID        NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  href          TEXT        NOT NULL,
  -- Versione della risorsa proiettata (etag e sha256 del testo): una nuova
  -- passata con gli stessi valori non riscrive nulla.
  source_etag   TEXT,
  source_sha256 TEXT,
  -- projected: righe legacy allineate senza degradi; degraded: allineate con
  -- degradi (VALARM, ATTENDEE, espansione, sanificazioni); failed: upsert non
  -- riuscito (REVERSE_FAILED, visibile nell'anteprima del rollback); removed:
  -- risorsa sparita da Radicale e righe legacy cancellate.
  status        TEXT        NOT NULL,
  -- Righe di calendar_events scritte per la risorsa:
  -- [{"id": uuid, "recurrence_key": text, "role": "master"|"override"|"derived"|"projection"}].
  rows          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Degradi per classe: [{"class": "REPR_LOSS_VALARM"|..., "recurrence_key"?: text, "detail"?: object}],
  -- mai dati personali (niente titoli delle proiezioni, email, telefoni).
  degradations  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  error_code    TEXT,
  error         TEXT,
  attempts      INTEGER     NOT NULL DEFAULT 0,
  -- Fine dell'orizzonte delle righe derivate materializzate (NULL senza righe derivate).
  horizon_until TIMESTAMPTZ,
  projected_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cal_migration_reverse_state_href_check
    CHECK (octet_length(href) BETWEEN 1 AND 1024 AND href !~ '[/\\\x01-\x1f\x7f]'),
  CONSTRAINT cal_migration_reverse_state_status_check
    CHECK (status IN ('projected', 'degraded', 'failed', 'removed')),
  CONSTRAINT cal_migration_reverse_state_sha_check
    CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cal_migration_reverse_state_json_check
    CHECK (jsonb_typeof(rows) = 'array' AND jsonb_typeof(degradations) = 'array'),
  CONSTRAINT cal_migration_reverse_state_error_check
    CHECK ((status = 'failed') = (error_code IS NOT NULL)
           AND (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')),
  CONSTRAINT cal_migration_reverse_state_attempts_check CHECK (attempts >= 0)
);

COMMENT ON TABLE cal_migration_reverse_state IS
  'Proiezione inversa per risorsa Radicale (design §13.11): righe di calendar_events scritte, degradi per classe e REVERSE_FAILED. Base dell''anteprima del rollback, della salute nel wizard e della ri-baseline del ledger. Gruppo S del backup JSON.';

CREATE INDEX IF NOT EXISTS cal_migration_reverse_state_calendar_idx
  ON cal_migration_reverse_state (calendar_id);
CREATE INDEX IF NOT EXISTS cal_migration_reverse_state_failed_idx
  ON cal_migration_reverse_state (updated_at) WHERE status = 'failed';

-- updated_at gestito dal database (funzione della 165).
DROP TRIGGER IF EXISTS cal_migration_transitions_touch ON cal_migration_transitions;
CREATE TRIGGER cal_migration_transitions_touch
  BEFORE UPDATE ON cal_migration_transitions
  FOR EACH ROW EXECUTE FUNCTION cal_migration_touch_updated_at();

DROP TRIGGER IF EXISTS cal_migration_journal_touch ON cal_migration_journal;
CREATE TRIGGER cal_migration_journal_touch
  BEFORE UPDATE ON cal_migration_journal
  FOR EACH ROW EXECUTE FUNCTION cal_migration_touch_updated_at();

DROP TRIGGER IF EXISTS cal_migration_reverse_state_touch ON cal_migration_reverse_state;
CREATE TRIGGER cal_migration_reverse_state_touch
  BEFORE UPDATE ON cal_migration_reverse_state
  FOR EACH ROW EXECUTE FUNCTION cal_migration_touch_updated_at();

-- ─── 6. Shadow mirror: righe derivate (F4R-ROLL-02) ─────────────────────────

-- Le righe caldes_derived (occorrenze espanse dalla proiezione inversa) non
-- appartengono a un master di PG: il serializer le raggruppa nella sorgente
-- derived event:<caldes_object_id>. La chiave del job segue la stessa regola,
-- altrimenti una modifica in PG dopo un rollback accoda event:<id della riga>,
-- che nessun oggetto del ledger conosce.
CREATE OR REPLACE FUNCTION cal_shadow_event_key(
  p_id UUID, p_master_id UUID, p_source TEXT, p_source_id TEXT,
  p_derived BOOLEAN, p_object_id UUID
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_source = 'ics_pull' THEN NULL
    WHEN p_source = 'booking' AND nullif(btrim(p_source_id), '') IS NOT NULL
      THEN 'booking:' || btrim(p_source_id)
    WHEN COALESCE(p_derived, false) AND p_object_id IS NOT NULL
      THEN 'event:' || p_object_id::text
    ELSE 'event:' || COALESCE(p_master_id, p_id)::text
  END
$$;

-- Trigger dello shadow (165) con la chiave a sei argomenti. Il GUC della
-- proiezione inversa vale solo se uguale a txid_current() (come nella guardia).
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
  IF current_setting('caldes.reverse_sync', true) = txid_current()::text THEN
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
      v_keys := v_keys || cal_shadow_event_key(NEW.id, NEW.recurrence_master_id, NEW.source, NEW.source_id, NEW.caldes_derived, NEW.caldes_object_id);
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      v_keys := v_keys || cal_shadow_event_key(OLD.id, OLD.recurrence_master_id, OLD.source, OLD.source_id, OLD.caldes_derived, OLD.caldes_object_id);
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
  'Shadow mirror (design §13.8): accoda shadow_mirror(legacy_key) in cal_jobs nella transazione della scrittura legacy, solo con mode=postgres, shadow_enabled e volume registrato; mai per le iscrizioni né per le scritture con caldes.reverse_sync = txid_current(). Le righe derivate (F4) hanno la chiave event:<caldes_object_id>.';
