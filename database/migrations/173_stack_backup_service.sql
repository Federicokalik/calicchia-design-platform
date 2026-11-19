-- Migration 173 — servizio `backup` dello stack (apps/backup).
--
-- Il backup coordinato (dump del database più snapshot del volume di
-- Radicale, scripts/backup-calendar-stack.sh) gira nel container `backup`
-- dello stack invece che dal cron dell'host. L'API non esegue mai il backup:
-- registra le richieste dell'admin e legge lo stato; il servizio le raccoglie.
--
-- 1. stack_backup_runs: un run per riga, pianificato (trigger 'schedule') o
--    chiesto dall'admin ('admin'). Al massimo un run in coda o in corso
--    (indice unico parziale): una seconda richiesta riceve 409.
--    backup_id è l'id del run dello script (es. 20261119T153428Z), la stessa
--    cartella locale e su S4; offsite dice se la copia su S4 è riuscita.
--    log_tail: ultime righe dell'output dello script (lo script non scrive
--    segreti nei log).
-- 2. stack_backup_agent: una sola riga, scritta dal servizio a ogni giro
--    (heartbeat). L'admin la usa per dire se il servizio è attivo e quando
--    parte il prossimo run pianificato. Contiene solo booleani sulla
--    configurazione di S4 e degli alert, mai i valori.
--
-- Entrambe sono stato, non dati: il ripristino del backup JSON non le tocca
-- (gruppo S in routes/backup.ts).

CREATE TABLE IF NOT EXISTS stack_backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'admin')),
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'incomplete', 'failed', 'skipped')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  exit_code INT,
  backup_id TEXT,
  offsite BOOLEAN,
  message TEXT,
  log_tail TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS stack_backup_runs_one_active
  ON stack_backup_runs ((true))
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS stack_backup_runs_requested_at
  ON stack_backup_runs (requested_at DESC);

CREATE INDEX IF NOT EXISTS stack_backup_runs_schedule
  ON stack_backup_runs (requested_at DESC)
  WHERE trigger = 'schedule';

CREATE TABLE IF NOT EXISTS stack_backup_agent (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  seen_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  version TEXT,
  interval_hours INT NOT NULL CHECK (interval_hours BETWEEN 1 AND 168),
  next_run_at TIMESTAMPTZ,
  s4_configured BOOLEAN NOT NULL,
  alerts_configured BOOLEAN NOT NULL
);
