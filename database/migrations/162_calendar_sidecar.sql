-- 162_calendar_sidecar.sql — Sidecar dei calendari e stato del backend (fase F1
-- del passaggio a Radicale).
--
-- Riferimenti: docs/calendar-radicale/design.md §4 (162), §3.3-§3.4, §13.1,
-- §16.2 e il contratto docs/calendar-radicale/contracts/control-plane.md, che
-- fissa il significato di ogni colonna per l'API e per i plugin di Radicale.
--
-- In F1 Postgres resta autorevole: il codice attuale non legge né scrive le
-- colonne nuove (i SELECT e gli INSERT legacy elencano le colonne), quindi i
-- percorsi del calendario non cambiano comportamento. In particolare
-- calendar_subscriptions.blocks_availability nasce a false ma il busy legacy
-- continua a usare solo calendars.blocks_availability fino alla F2.
--
-- Cosa aggiunge:
--  1. calendars: colonne del sidecar (collection_name, role, origin, lifecycle,
--     parent_calendar_id, device_visible, components, dav_props,
--     missing_since, needs_review, review_reason) con i vincoli;
--  2. calendar_subscriptions: collection_calendar_id, blocks_availability e
--     device_visible (entrambi false di default, decisione 5);
--  3. calendar_collection_name_valid(), calendar_sidecar_classify() e
--     calendar_sidecar_reconcile() (idempotente: la chiamano questa
--     migrazione, ogni import di backup e l'auditor);
--  4. trigger BEFORE INSERT su calendars: collection_name = slug, origin
--     'system' per i calendari di sistema e ruolo dalle regole storiche, così i
--     calendari creati dal codice legacy dopo la 162 (es. "Festività e
--     chiusure" ricreato dal cron) nascono già riconciliati;
--  5. calendar_backend_state (singleton): lo stato da cui policyFromState()
--     deriva la policy dei device. Il design (§4) la colloca nella 165, ma in
--     F1 servono già identità del volume, credential_epoch (revoca delle
--     app-password), restore_guard_until e rebuild_required (import dei
--     backup): qui nasce con le sole colonne di F1, la 165 aggiunge quelle di
--     shadow, cutover, rollback, finalize e orizzonte (contratto §2);
--  6. NOTIFY calendar_policy_changed quando cambia lo stato o una colonna del
--     sidecar da cui dipende la policy (readonly e hidden).
--
-- Append-only e idempotente: ogni DDL usa IF NOT EXISTS o controlla il
-- catalogo, le funzioni sono CREATE OR REPLACE e i backfill toccano solo le
-- righe ancora da riempire. Compatibile con i dati di produzione: slug 'c' e
-- 'f', calendario festività riconosciuto anche per nome (la 158 lo marca
-- is_system, ma il riconoscimento per nome non dipende da quel flag).

-- ─── 1. calendars: colonne del sidecar ──────────────────────────────────────

ALTER TABLE calendars
  ADD COLUMN IF NOT EXISTS collection_name    TEXT,
  ADD COLUMN IF NOT EXISTS role               TEXT        NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS origin             TEXT        NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS lifecycle          TEXT        NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS parent_calendar_id UUID,
  ADD COLUMN IF NOT EXISTS device_visible     BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS components         TEXT[]      NOT NULL DEFAULT '{VEVENT}',
  ADD COLUMN IF NOT EXISTS dav_props          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS missing_since      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS needs_review       BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_reason      TEXT;

COMMENT ON COLUMN calendars.collection_name IS
  'Nome della collezione Radicale sotto il principal (segmento di path). Uguale allo slug per i calendari esistenti, compreso f. NULL solo se non assegnabile (needs_review).';
COMMENT ON COLUMN calendars.role IS
  'Ruolo applicativo: user, bookings, holidays, deadlines, subscription, tasks. bookings, holidays, deadlines e subscription sono in sola lettura per i device.';
COMMENT ON COLUMN calendars.origin IS
  'Chi ha creato la riga: admin (admin/MCP/codice legacy), device (discovery), system (calendari di sistema), migration (strumento di migrazione).';
COMMENT ON COLUMN calendars.lifecycle IS
  'creating (prenota collection_name prima di MKCALENDAR), active, deleting (prima della DELETE della collezione). Solo active è visibile ai device.';
COMMENT ON COLUMN calendars.device_visible IS
  'false = collezione nascosta ai device (hidden nella policy), es. sub-* in preparazione.';
COMMENT ON COLUMN calendars.dav_props IS
  'Proprietà DAV lette dalla discovery, con chiavi in notazione Clark (es. {urn:calicchia:caldes}role) e valori stringa.';
COMMENT ON COLUMN calendars.review_reason IS
  'Codice del motivo di needs_review: device_new, missing_in_backup, collection_name_conflict, role_conflict, orphan_subscription, ...';

-- Nome di collezione ammesso: un solo segmento di path sicuro, al massimo 255
-- byte, senza '/', '\' né caratteri di controllo (C0, DEL e C1: intervalli
-- espliciti e non [:cntrl:], che dipende dal locale), che non inizia con '.'
-- (file interni di Radicale) né con '_' (riservato alle collezioni di sistema
-- come _canary, sempre nascoste ai device). Stessa regola di
-- isValidCollectionName() in apps/api/src/lib/calendar/radicale/types.ts.
CREATE OR REPLACE FUNCTION calendar_collection_name_valid(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_name IS NOT NULL
     AND octet_length(p_name) BETWEEN 1 AND 255
     AND p_name !~ '[/\\\x01-\x1f\x7f-\x9f]'
     AND left(p_name, 1) NOT IN ('.', '_')
$$;

-- Origine dei calendari di sistema già presenti (bookings, scadenze,
-- festività). Le altre righe restano 'admin': create dall'admin, da MCP o
-- seminate dalle migrazioni come calendari dell'utente.
UPDATE calendars SET origin = 'system' WHERE is_system AND origin = 'admin';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendars'::regclass AND conname = 'calendars_role_check') THEN
    ALTER TABLE calendars ADD CONSTRAINT calendars_role_check
      CHECK (role IN ('user', 'bookings', 'holidays', 'deadlines', 'subscription', 'tasks'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendars'::regclass AND conname = 'calendars_origin_check') THEN
    ALTER TABLE calendars ADD CONSTRAINT calendars_origin_check
      CHECK (origin IN ('admin', 'device', 'system', 'migration'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendars'::regclass AND conname = 'calendars_lifecycle_check') THEN
    ALTER TABLE calendars ADD CONSTRAINT calendars_lifecycle_check
      CHECK (lifecycle IN ('creating', 'active', 'deleting'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendars'::regclass AND conname = 'calendars_collection_name_check') THEN
    ALTER TABLE calendars ADD CONSTRAINT calendars_collection_name_check
      CHECK (collection_name IS NULL OR calendar_collection_name_valid(collection_name));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendars'::regclass AND conname = 'calendars_collection_name_key') THEN
    ALTER TABLE calendars ADD CONSTRAINT calendars_collection_name_key UNIQUE (collection_name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendars'::regclass AND conname = 'calendars_parent_calendar_id_fkey') THEN
    -- SET NULL e non CASCADE: un sidecar d'iscrizione rimasto senza padre
    -- resta visibile (e la riconciliazione lo segnala) invece di sparire in
    -- silenzio lasciando la collezione sub-* orfana in Radicale.
    ALTER TABLE calendars ADD CONSTRAINT calendars_parent_calendar_id_fkey
      FOREIGN KEY (parent_calendar_id) REFERENCES calendars(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendars'::regclass AND conname = 'calendars_parent_not_self_check') THEN
    ALTER TABLE calendars ADD CONSTRAINT calendars_parent_not_self_check
      CHECK (parent_calendar_id IS DISTINCT FROM id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendars'::regclass AND conname = 'calendars_components_check') THEN
    ALTER TABLE calendars ADD CONSTRAINT calendars_components_check
      CHECK (cardinality(components) >= 1 AND components <@ ARRAY['VEVENT', 'VTODO', 'VJOURNAL']::TEXT[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendars'::regclass AND conname = 'calendars_dav_props_check') THEN
    ALTER TABLE calendars ADD CONSTRAINT calendars_dav_props_check
      CHECK (jsonb_typeof(dav_props) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendars'::regclass AND conname = 'calendars_review_reason_check') THEN
    ALTER TABLE calendars ADD CONSTRAINT calendars_review_reason_check
      CHECK (review_reason IS NULL OR review_reason ~ '^[a-z][a-z0-9_]{0,63}$');
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS calendars_parent_calendar_idx
  ON calendars (parent_calendar_id) WHERE parent_calendar_id IS NOT NULL;

-- ─── 2. calendar_subscriptions ──────────────────────────────────────────────

ALTER TABLE calendar_subscriptions
  ADD COLUMN IF NOT EXISTS collection_calendar_id UUID,
  ADD COLUMN IF NOT EXISTS blocks_availability    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS device_visible         BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN calendar_subscriptions.collection_calendar_id IS
  'Sidecar (calendars, role=subscription) dell''iscrizione; calendar_id resta il calendario di destinazione.';
COMMENT ON COLUMN calendar_subscriptions.blocks_availability IS
  'L''iscrizione blocca la disponibilità solo se true E se il calendario di destinazione blocca (dalla F2; in F1 non letta).';
COMMENT ON COLUMN calendar_subscriptions.device_visible IS
  'Copia della collezione sub-* in Radicale, in sola lettura per i device (dalla F3; in F1 non letta).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendar_subscriptions'::regclass AND conname = 'calendar_subscriptions_collection_calendar_id_fkey') THEN
    ALTER TABLE calendar_subscriptions ADD CONSTRAINT calendar_subscriptions_collection_calendar_id_fkey
      FOREIGN KEY (collection_calendar_id) REFERENCES calendars(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendar_subscriptions'::regclass AND conname = 'calendar_subscriptions_collection_calendar_key') THEN
    ALTER TABLE calendar_subscriptions ADD CONSTRAINT calendar_subscriptions_collection_calendar_key
      UNIQUE (collection_calendar_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'calendar_subscriptions'::regclass AND conname = 'calendar_subscriptions_collection_not_target_check') THEN
    ALTER TABLE calendar_subscriptions ADD CONSTRAINT calendar_subscriptions_collection_not_target_check
      CHECK (collection_calendar_id IS DISTINCT FROM calendar_id);
  END IF;
END
$$;

-- ─── 3. Classificazione e riconciliazione del sidecar ───────────────────────

-- Ruolo dalle regole storiche (design §4), NULL se nessuna regola si applica:
--  - slug 'bookings' → bookings;
--  - slug 'scadenze' → deadlines;
--  - festività: nome storico esatto ('Festività', 'Festività e chiusure',
--    stessa lookup di getOrCreateFestivitaCalendar e delle migrazioni
--    148/149/158, indipendente da is_system perché in produzione 'f' è stato
--    a lungo is_system=false), oppure calendario di sistema con slug
--    'f'/'festivita' o nome che inizia con "festivit".
CREATE OR REPLACE FUNCTION calendar_sidecar_classify(p_slug TEXT, p_name TEXT, p_is_system BOOLEAN)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p_slug = 'bookings' THEN 'bookings'
    WHEN p_slug = 'scadenze' THEN 'deadlines'
    WHEN lower(btrim(coalesce(p_name, ''))) IN ('festività', 'festività e chiusure') THEN 'holidays'
    WHEN coalesce(p_is_system, false)
         AND (p_slug IN ('f', 'festivita') OR btrim(coalesce(p_name, '')) ~* '^festivit') THEN 'holidays'
    ELSE NULL
  END
$$;

-- Ruolo letto dalla dead prop {urn:calicchia:caldes}role salvata in dav_props
-- dalla discovery; NULL se assente o non è un ruolo ammesso.
CREATE OR REPLACE FUNCTION calendar_sidecar_dead_role(p_dav_props JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_dav_props -> '{urn:calicchia:caldes}role') = 'string'
     AND (p_dav_props ->> '{urn:calicchia:caldes}role')
         IN ('user', 'bookings', 'holidays', 'deadlines', 'subscription', 'tasks')
    THEN p_dav_props ->> '{urn:calicchia:caldes}role'
    ELSE NULL
  END
$$;

-- Riconciliazione idempotente del sidecar. Restituisce una riga per ogni
-- modifica fatta (una seconda chiamata consecutiva non restituisce nulla):
--  1. collection_name NULL → slug, se valido e libero; altrimenti
--     needs_review 'collection_name_conflict';
--  2. role di default ('user'): dead prop role se presente (vale anche un
--     'user' esplicito), altrimenti le regole storiche, queste ultime solo per
--     le righe nate dall'admin o dal sistema (mai per quelle dei device o
--     della migrazione, che hanno un nome scelto altrove). La dead prop conta
--     solo per origin admin, system o migration: in live un device scrive le
--     dead prop delle proprie collezioni, e con role=bookings o holidays
--     promuoverebbe i suoi item a provenienza booking o system (contratto
--     control-plane §3.3 e §8). Un ruolo diverso dal default non viene mai
--     sovrascritto: se la dead prop lo contraddice la riga va in needs_review
--     'role_conflict';
--  3. origin 'system' per i calendari is_system;
--  4. sidecar d'iscrizione (role=subscription) senza iscrizione collegata →
--     needs_review 'orphan_subscription'.
-- needs_review non sovrascrive un motivo già presente: l'admin lo vede e lo
-- chiude, poi la riconciliazione successiva può segnalare il prossimo.
CREATE OR REPLACE FUNCTION calendar_sidecar_reconcile()
RETURNS TABLE (calendar_id UUID, field TEXT, old_value TEXT, new_value TEXT)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  r              RECORD;
  v_dead_role    TEXT;
  v_role         TEXT;
  v_needs_review BOOLEAN;
BEGIN
  -- Migrazione, import di backup e auditor possono sovrapporsi: si serializzano.
  PERFORM pg_advisory_xact_lock(hashtext('calendar_sidecar_reconcile'));

  FOR r IN
    SELECT c.id, c.slug, c.name, c.is_system, c.collection_name, c.role,
           c.origin, c.dav_props, c.needs_review
    FROM calendars c
    ORDER BY c.created_at, c.id
    FOR UPDATE
  LOOP
    v_needs_review := r.needs_review;

    -- 1. Nome della collezione.
    IF r.collection_name IS NULL THEN
      IF calendar_collection_name_valid(r.slug)
         AND NOT EXISTS (SELECT 1 FROM calendars o WHERE o.collection_name = r.slug AND o.id <> r.id) THEN
        UPDATE calendars c SET collection_name = r.slug WHERE c.id = r.id;
        calendar_id := r.id; field := 'collection_name'; old_value := NULL; new_value := r.slug;
        RETURN NEXT;
      ELSIF NOT v_needs_review THEN
        UPDATE calendars c SET needs_review = true, review_reason = 'collection_name_conflict' WHERE c.id = r.id;
        v_needs_review := true;
        calendar_id := r.id; field := 'needs_review'; old_value := NULL; new_value := 'collection_name_conflict';
        RETURN NEXT;
      END IF;
    END IF;

    -- 2. Ruolo. La dead prop di una collezione nata da un device non è fidata.
    v_dead_role := CASE
      WHEN r.origin IN ('admin', 'system', 'migration') THEN calendar_sidecar_dead_role(r.dav_props)
    END;
    v_role := r.role;
    IF r.role = 'user' THEN
      v_role := COALESCE(
        v_dead_role,
        CASE WHEN r.origin IN ('admin', 'system') THEN calendar_sidecar_classify(r.slug, r.name, r.is_system) END,
        'user'
      );
      IF v_role <> 'user' THEN
        UPDATE calendars c SET role = v_role WHERE c.id = r.id;
        calendar_id := r.id; field := 'role'; old_value := 'user'; new_value := v_role;
        RETURN NEXT;
      END IF;
    ELSIF v_dead_role IS NOT NULL AND v_dead_role <> r.role AND NOT v_needs_review THEN
      UPDATE calendars c SET needs_review = true, review_reason = 'role_conflict' WHERE c.id = r.id;
      v_needs_review := true;
      calendar_id := r.id; field := 'needs_review'; old_value := NULL; new_value := 'role_conflict';
      RETURN NEXT;
    END IF;

    -- 3. Origine dei calendari di sistema.
    IF r.is_system AND r.origin = 'admin' THEN
      UPDATE calendars c SET origin = 'system' WHERE c.id = r.id;
      calendar_id := r.id; field := 'origin'; old_value := 'admin'; new_value := 'system';
      RETURN NEXT;
    END IF;

    -- 4. Sidecar d'iscrizione senza iscrizione.
    IF v_role = 'subscription'
       AND NOT v_needs_review
       AND NOT EXISTS (SELECT 1 FROM calendar_subscriptions s WHERE s.collection_calendar_id = r.id) THEN
      UPDATE calendars c SET needs_review = true, review_reason = 'orphan_subscription' WHERE c.id = r.id;
      calendar_id := r.id; field := 'needs_review'; old_value := NULL; new_value := 'orphan_subscription';
      RETURN NEXT;
    END IF;
  END LOOP;
END
$$;

COMMENT ON FUNCTION calendar_sidecar_reconcile() IS
  'Riconciliazione idempotente del sidecar dei calendari (design §4, contratto control-plane §3). Da chiamare dopo ogni import di backup e dall''auditor.';

-- ─── 4. Default del sidecar all'inserimento ─────────────────────────────────

-- Il codice legacy (createCalendar, getOrCreateFestivitaCalendar, MCP) inserisce
-- solo le colonne di oggi: il trigger completa il sidecar con le stesse regole
-- della riconciliazione, così la policy dei device vede subito il ruolo giusto
-- (es. il calendario festività ricreato dal cron è subito in sola lettura).
-- Non solleva mai: se il nome è occupato lascia collection_name NULL e la
-- riconciliazione segnalerà il conflitto.
CREATE OR REPLACE FUNCTION calendars_sidecar_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF NEW.collection_name IS NULL
     AND calendar_collection_name_valid(NEW.slug)
     AND NOT EXISTS (SELECT 1 FROM calendars c WHERE c.collection_name = NEW.slug) THEN
    NEW.collection_name := NEW.slug;
  END IF;

  IF NEW.is_system AND NEW.origin = 'admin' THEN
    NEW.origin := 'system';
  END IF;

  IF NEW.role = 'user' THEN
    v_role := COALESCE(
      CASE WHEN NEW.origin IN ('admin', 'system', 'migration') THEN calendar_sidecar_dead_role(NEW.dav_props) END,
      CASE WHEN NEW.origin IN ('admin', 'system') THEN calendar_sidecar_classify(NEW.slug, NEW.name, NEW.is_system) END
    );
    IF v_role IS NOT NULL THEN
      NEW.role := v_role;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS calendars_sidecar_defaults ON calendars;
CREATE TRIGGER calendars_sidecar_defaults
  BEFORE INSERT ON calendars
  FOR EACH ROW EXECUTE FUNCTION calendars_sidecar_defaults();

-- ─── 5. Stato del backend (singleton) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_backend_state (
  id                  BOOLEAN     PRIMARY KEY DEFAULT true,
  mode                TEXT        NOT NULL DEFAULT 'postgres',
  write_freeze        BOOLEAN     NOT NULL DEFAULT false,
  volume_id           UUID,
  epoch               INTEGER     NOT NULL DEFAULT 0,
  credential_epoch    INTEGER     NOT NULL DEFAULT 0,
  policy_version      INTEGER     NOT NULL DEFAULT 1,
  restore_guard_until TIMESTAMPTZ,
  rebuild_required    BOOLEAN     NOT NULL DEFAULT false,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calendar_backend_state_singleton_check CHECK (id),
  CONSTRAINT calendar_backend_state_mode_check
    CHECK (mode IN ('postgres', 'cutover', 'radicale', 'rollback', 'finalized')),
  CONSTRAINT calendar_backend_state_epoch_check CHECK (epoch >= 0),
  CONSTRAINT calendar_backend_state_credential_epoch_check CHECK (credential_epoch >= 0),
  CONSTRAINT calendar_backend_state_policy_version_check CHECK (policy_version >= 1),
  -- Volume inizializzato ⇔ epoch ≥ 1: epoch 0 vuol dire "nessun marker".
  CONSTRAINT calendar_backend_state_identity_check CHECK ((volume_id IS NULL) = (epoch = 0)),
  -- Fuori da 'postgres' Radicale è (stato) la fonte: serve un volume identificato.
  CONSTRAINT calendar_backend_state_mode_identity_check CHECK (mode = 'postgres' OR volume_id IS NOT NULL)
);

COMMENT ON TABLE calendar_backend_state IS
  'Stato del backend calendario (singleton, id=true). La policy dei device deriva solo da qui tramite policyFromState() (design §13.1, contratto control-plane §2). Gruppo S del backup: esportata, mai ripristinata.';
COMMENT ON COLUMN calendar_backend_state.epoch IS
  '0 = volume non inizializzato; 1 dopo "Inizializza Radicale"; +1 a ogni cutover e rollback. Deve coincidere con la dead prop epoch del principal.';
COMMENT ON COLUMN calendar_backend_state.credential_epoch IS
  'Incrementato a ogni revoca o rigenerazione di app-password: caldes_auth svuota le cache quando cambia.';
COMMENT ON COLUMN calendar_backend_state.policy_version IS
  'Gestito dal trigger: +1 a ogni modifica di una colonna da cui dipende la policy. Va nel campo version di policy.json.';

INSERT INTO calendar_backend_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- policy_version e updated_at sono gestiti qui: l'applicazione non li scrive.
CREATE OR REPLACE FUNCTION calendar_backend_state_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.id := OLD.id;
  IF (NEW.mode, NEW.write_freeze, NEW.volume_id, NEW.epoch, NEW.credential_epoch,
      NEW.restore_guard_until, NEW.rebuild_required)
     IS DISTINCT FROM
     (OLD.mode, OLD.write_freeze, OLD.volume_id, OLD.epoch, OLD.credential_epoch,
      OLD.restore_guard_until, OLD.rebuild_required) THEN
    NEW.policy_version := OLD.policy_version + 1;
  ELSE
    NEW.policy_version := OLD.policy_version;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS calendar_backend_state_touch ON calendar_backend_state;
CREATE TRIGGER calendar_backend_state_touch
  BEFORE UPDATE ON calendar_backend_state
  FOR EACH ROW EXECUTE FUNCTION calendar_backend_state_touch();

-- Il singleton non si cancella: senza riga lo stato sarebbe ignoto e i lettori
-- dovrebbero ripiegare su una policy frozen. (session_replication_role=replica
-- spegne anche questo trigger: per questo backup.ts esclude la tabella a
-- livello applicativo, gruppo S.)
CREATE OR REPLACE FUNCTION calendar_backend_state_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'calendar_backend_state è un singleton: % non ammesso', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

DROP TRIGGER IF EXISTS calendar_backend_state_no_delete ON calendar_backend_state;
CREATE TRIGGER calendar_backend_state_no_delete
  BEFORE DELETE ON calendar_backend_state
  FOR EACH ROW EXECUTE FUNCTION calendar_backend_state_guard();

DROP TRIGGER IF EXISTS calendar_backend_state_no_truncate ON calendar_backend_state;
CREATE TRIGGER calendar_backend_state_no_truncate
  BEFORE TRUNCATE ON calendar_backend_state
  FOR EACH STATEMENT EXECUTE FUNCTION calendar_backend_state_guard();

-- ─── 6. Notifica di cambio della policy ─────────────────────────────────────

-- Il writer della policy (API) ascolta calendar_policy_changed e riscrive
-- policy.json subito, oltre al giro periodico del heartbeat. Il payload è solo
-- informativo ({"source": "state"|"sidecar"}): il writer ricalcola sempre
-- tutto da policyFromState().
CREATE OR REPLACE FUNCTION calendar_policy_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'calendar_policy_changed',
    json_build_object('source', CASE WHEN TG_TABLE_NAME = 'calendar_backend_state' THEN 'state' ELSE 'sidecar' END)::text
  );
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS calendar_backend_state_notify ON calendar_backend_state;
CREATE TRIGGER calendar_backend_state_notify
  AFTER UPDATE ON calendar_backend_state
  FOR EACH ROW
  WHEN (OLD.policy_version IS DISTINCT FROM NEW.policy_version)
  EXECUTE FUNCTION calendar_policy_notify();

-- Righe aggiunte o tolte, o colonne da cui dipendono readonly e hidden.
-- A livello di statement: più righe nella stessa transazione danno una sola
-- notifica (stesso payload), e gli UPDATE legacy (nome, colore, ordine,
-- feed) non la fanno partire perché non elencano queste colonne.
DROP TRIGGER IF EXISTS calendars_policy_notify ON calendars;
CREATE TRIGGER calendars_policy_notify
  AFTER INSERT OR DELETE OR TRUNCATE OR UPDATE OF collection_name, role, lifecycle, device_visible ON calendars
  FOR EACH STATEMENT EXECUTE FUNCTION calendar_policy_notify();

-- ─── 7. Riconciliazione iniziale ────────────────────────────────────────────

-- collection_name = slug e ruoli storici per i calendari esistenti
-- (produzione: bookings → bookings, f → holidays, scadenze → deadlines).
SELECT count(*) FROM calendar_sidecar_reconcile();
