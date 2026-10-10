-- 164_calendar_jobs.sql — Coda dei lavori del calendario e conflitti delle
-- prenotazioni (fase F2 del passaggio a Radicale).
--
-- Riferimenti: docs/calendar-radicale/design.md §4 (164), §8 (scrittori di
-- sistema, saga "questa e le successive"), §9 (protocollo di decisione,
-- proiezione delle prenotazioni) e il contratto dei moduli
-- docs/calendar-radicale/contracts/f2-modules.md §3 (jobs.ts).
--
-- Cosa aggiunge:
--  1. cal_jobs: outbox e saghe del calendario (proiezione delle prenotazioni,
--     specchio delle iscrizioni visibili, saga "questa e le successive",
--     recupero delle cancellazioni di calendario...). Regole:
--     - coalescenza SOLO sui job pending: UNIQUE (kind, key) WHERE
--       status = 'pending'. Un job già in esecuzione non assorbe un nuovo
--       accodamento, che crea un nuovo pending con la propria source_version
--       (design, revisione red-team punto 17);
--     - claim con lease (locked_until, lease_token) e FOR UPDATE SKIP LOCKED;
--       un lease scaduto rimette il job in coda (o lo manda in dead letter se
--       ha esaurito i tentativi);
--     - backoff esponenziale su run_after, dead letter in status 'dead';
--     - 'superseded': job chiuso perché un pending con la stessa chiave lo
--       sostituisce (lo stato desiderato si ricalcola all'esecuzione);
--  2. cal_booking_conflicts: sovrapposizioni fra una prenotazione appena presa
--     e un evento del calendario comparso durante la decisione (controllo
--     post-commit, design §9) o trovate dall'auditor. Nessun annullamento
--     automatico: solo alert e revisione dall'admin;
--  3. NOTIFY calendar_jobs a ogni accodamento, per svegliare il worker.
--
-- Nessuna FK verso tabelle di dominio o di business: entrambe le tabelle sono
-- del gruppo S del backup JSON (apps/api/src/routes/backup.ts, STATE_TABLES)
-- e l'import svuota calendar_bookings senza CASCADE, rifiutando (409) ogni
-- tabella protetta che la referenzi. booking_id e object_id restano quindi
-- semplici UUID.
--
-- Append-only e idempotente; nessuna modifica a calendar_events né alle
-- tabelle esistenti.

-- ─── 1. Coda dei lavori ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_jobs (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Tipo di lavoro (registro in apps/api/src/lib/calendar/jobs.ts).
  kind           TEXT        NOT NULL,
  -- Chiave di coalescenza dentro il tipo, es. l'uid della prenotazione.
  key            TEXT        NOT NULL,
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Versione della sorgente all'accodamento (es. updated_at della
  -- prenotazione): l'handler la confronta con quella corrente a fine lavoro e
  -- il job si riaccoda se è cambiata.
  source_version TEXT,
  -- Più basso = prima (lo specchio delle iscrizioni gira a bassa priorità).
  priority       SMALLINT    NOT NULL DEFAULT 100,
  status         TEXT        NOT NULL DEFAULT 'pending',
  attempts       INTEGER     NOT NULL DEFAULT 0,
  max_attempts   INTEGER     NOT NULL DEFAULT 8,
  run_after      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lease del claim: solo chi presenta lease_token può completare, fallire o
  -- estendere il job; scaduto locked_until, il job torna disponibile.
  lease_token    UUID,
  locked_by      TEXT,
  locked_until   TIMESTAMPTZ,
  last_error     TEXT,
  result         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  CONSTRAINT cal_jobs_kind_check CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT cal_jobs_key_check CHECK (octet_length(key) BETWEEN 1 AND 512),
  CONSTRAINT cal_jobs_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT cal_jobs_status_check CHECK (status IN ('pending', 'running', 'done', 'dead', 'superseded')),
  CONSTRAINT cal_jobs_attempts_check CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 100),
  CONSTRAINT cal_jobs_lease_check CHECK (
    (status = 'running') = (lease_token IS NOT NULL AND locked_until IS NOT NULL)
  ),
  CONSTRAINT cal_jobs_finished_check CHECK (
    (status IN ('done', 'dead', 'superseded')) = (finished_at IS NOT NULL)
  )
);

COMMENT ON TABLE cal_jobs IS
  'Coda dei lavori del calendario (design §4, §8): coalescenza solo sui pending, lease con SKIP LOCKED, backoff, dead letter. Gruppo S del backup JSON.';
COMMENT ON COLUMN cal_jobs.status IS
  'pending (in coda), running (in lease), done, dead (tentativi esauriti o errore non ripetibile: dead letter), superseded (sostituito da un pending con la stessa chiave).';

-- Coalescenza solo sui pending (design §4).
CREATE UNIQUE INDEX IF NOT EXISTS cal_jobs_pending_key
  ON cal_jobs (kind, key) WHERE status = 'pending';
-- Claim: i pending maturi in ordine di priorità.
CREATE INDEX IF NOT EXISTS cal_jobs_claim_idx
  ON cal_jobs (priority, run_after, id) WHERE status = 'pending';
-- Recupero dei lease scaduti.
CREATE INDEX IF NOT EXISTS cal_jobs_lease_idx
  ON cal_jobs (locked_until) WHERE status = 'running';
-- Dead letter e storico per la salute e la pulizia.
CREATE INDEX IF NOT EXISTS cal_jobs_dead_idx
  ON cal_jobs (kind, finished_at) WHERE status = 'dead';
CREATE INDEX IF NOT EXISTS cal_jobs_finished_idx
  ON cal_jobs (finished_at) WHERE status IN ('done', 'superseded');
CREATE INDEX IF NOT EXISTS cal_jobs_kind_key_idx
  ON cal_jobs (kind, key, id DESC);

CREATE OR REPLACE FUNCTION cal_jobs_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cal_jobs_touch ON cal_jobs;
CREATE TRIGGER cal_jobs_touch
  BEFORE UPDATE ON cal_jobs
  FOR EACH ROW EXECUTE FUNCTION cal_jobs_touch_updated_at();

-- Sveglia del worker: una notifica per statement (gli accodamenti coalescenti
-- passano da INSERT … ON CONFLICT e la attivano comunque). Payload informativo.
CREATE OR REPLACE FUNCTION cal_jobs_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('calendar_jobs', TG_OP);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS cal_jobs_notify ON cal_jobs;
CREATE TRIGGER cal_jobs_notify
  AFTER INSERT ON cal_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION cal_jobs_notify();

-- ─── 2. Conflitti delle prenotazioni ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cal_booking_conflicts (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- calendar_bookings.id e .uid, senza FK (gruppo B, svuotato dall'import).
  booking_id     UUID        NOT NULL,
  booking_uid    TEXT        NOT NULL,
  -- Oggetto e istanza in conflitto: cal_object_ids.id (persistente) e
  -- recurrence_key dell'occorrenza, senza FK (sopravvivono al rebuild).
  calendar_id    UUID        NOT NULL,
  object_id      UUID        NOT NULL,
  recurrence_key TEXT        NOT NULL DEFAULT '',
  booking_start  TIMESTAMPTZ NOT NULL,
  booking_end    TIMESTAMPTZ NOT NULL,
  event_start    TIMESTAMPTZ NOT NULL,
  event_end      TIMESTAMPTZ NOT NULL,
  detected_by    TEXT        NOT NULL,
  detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  alerted_at     TIMESTAMPTZ,
  resolved_at    TIMESTAMPTZ,
  resolved_by    TEXT,
  resolution     TEXT,
  CONSTRAINT cal_booking_conflicts_detected_by_check CHECK (detected_by IN ('post_commit', 'auditor')),
  CONSTRAINT cal_booking_conflicts_ranges_check CHECK (booking_start < booking_end AND event_start <= event_end),
  CONSTRAINT cal_booking_conflicts_resolution_check CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

COMMENT ON TABLE cal_booking_conflicts IS
  'Prenotazioni sovrapposte a un evento comparso durante la decisione (design §9) o trovate dall''auditor: alert e revisione, mai annullamento automatico. Gruppo S del backup JSON.';

CREATE UNIQUE INDEX IF NOT EXISTS cal_booking_conflicts_open_key
  ON cal_booking_conflicts (booking_id, object_id, recurrence_key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS cal_booking_conflicts_booking_idx
  ON cal_booking_conflicts (booking_uid);
