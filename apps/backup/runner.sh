#!/usr/bin/env bash
#
# Servizio `backup` dello stack (apps/backup/README.md).
#
# Ciclo continuo, un giro ogni BACKUP_POLL_SECONDS:
#   1. heartbeat in stack_backup_agent (servizio attivo, prossimo run);
#   2. se il run pianificato è dovuto, mette in coda un run 'schedule';
#   3. prende il run più vecchio in coda (anche quelli chiesti dall'admin) e
#      lancia scripts/backup-calendar-stack.sh, poi ne registra l'esito.
#
# Il backup vero lo fa lo script di sempre (lock di Radicale, manifest,
# verifica dell'identità, retention, copia su S4, alert Telegram): qui c'è solo
# la pianificazione e il collegamento con l'admin.
#
# Configurazione (env):
#   DATABASE_URL                  obbligatoria (anche per lo script, modalità url)
#   BACKUP_INTERVAL_HOURS         ore fra due run pianificati, default 6 (1-168)
#   BACKUP_RETRY_HOURS            dopo un run pianificato fallito o incompleto, default 1
#   BACKUP_POLL_SECONDS           secondi fra due giri, default 30
#   BACKUP_RUN_TIMEOUT_SECONDS    durata massima di un run, default 3600
#   BACKUP_SCRIPT                 script del backup, default /app/scripts/backup-calendar-stack.sh
#   BACKUP_RUNNER_ONCE=1          un solo giro e uscita (test)
#   CALDES_BACKUP_VERSION         versione dell'immagine nel heartbeat (sha-<short>)
#   più tutte le variabili dello script (RADICALE_VOLUME_DIR, BACKUP_DIR, S4_*,
#   ALERT_TELEGRAM_* o TELEGRAM_*), che passano invariate.

set -Eeuo pipefail

SCRIPT="${BACKUP_SCRIPT:-/app/scripts/backup-calendar-stack.sh}"
INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-6}"
RETRY_HOURS="${BACKUP_RETRY_HOURS:-1}"
POLL_SECONDS="${BACKUP_POLL_SECONDS:-30}"
RUN_TIMEOUT="${BACKUP_RUN_TIMEOUT_SECONDS:-3600}"
VERSION="${CALDES_BACKUP_VERSION:-unversioned}"
ONCE="${BACKUP_RUNNER_ONCE:-0}"
LOG_TAIL_LINES=40

log() { printf '%s [backup-runner] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { printf '%s [backup-runner] ATTENZIONE: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
fatal() { printf '%s [backup-runner] ERRORE: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

int_between() { [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -ge "$3" ] && [ "$2" -le "$4" ] || fatal "$1 non valida: $2 (intero fra $3 e $4)"; }
int_between BACKUP_INTERVAL_HOURS "$INTERVAL_HOURS" 1 168
int_between BACKUP_RETRY_HOURS "$RETRY_HOURS" 1 168
int_between BACKUP_POLL_SECONDS "$POLL_SECONDS" 5 3600
int_between BACKUP_RUN_TIMEOUT_SECONDS "$RUN_TIMEOUT" 60 86400
[ -n "${DATABASE_URL:-}" ] || fatal "DATABASE_URL non impostata"
[ -x "$SCRIPT" ] || fatal "script del backup assente o non eseguibile: $SCRIPT"

RUN_LOG="$(mktemp -t stack-backup-run.XXXXXX)"
trap 'rm -f "$RUN_LOG"' EXIT

S4_CONFIGURED=false
if [ -n "${S4_BUCKET:-}" ] && [ -n "${S4_ENDPOINT:-}" ]; then S4_CONFIGURED=true; fi
ALERTS_CONFIGURED=false
if [ -n "${ALERT_TELEGRAM_BOT_TOKEN:-${TELEGRAM_BOT_TOKEN:-}}" ] && [ -n "${ALERT_TELEGRAM_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}" ]; then ALERTS_CONFIGURED=true; fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# SQL da stdin con le variabili di psql (:'nome', quotate da psql): nessun
# valore entra mai nel testo SQL. Una riga per risultato, campi separati da |.
db() { psql "$DATABASE_URL" -X -At -q -v ON_ERROR_STOP=1 "$@" -f -; }

# Prossimo run pianificato: dall'ultimo run 'schedule' più l'intervallo
# (l'intervallo di ripresa se è fallito o incompleto); nessun run pianificato
# finora → subito. Espressione condivisa da heartbeat e messa in coda.
NEXT_RUN_SQL="(SELECT r.requested_at + make_interval(hours => CASE WHEN r.status IN ('failed', 'incomplete') THEN LEAST(:'retry'::int, :'interval'::int) ELSE :'interval'::int END)
  FROM stack_backup_runs r WHERE r.trigger = 'schedule' ORDER BY r.requested_at DESC LIMIT 1)"

heartbeat() {
  db -v started="$STARTED_AT" -v version="$VERSION" -v interval="$INTERVAL_HOURS" -v retry="$RETRY_HOURS" \
     -v s4="$S4_CONFIGURED" -v alerts="$ALERTS_CONFIGURED" >/dev/null <<SQL
INSERT INTO stack_backup_agent (id, seen_at, started_at, version, interval_hours, next_run_at, s4_configured, alerts_configured)
VALUES (true, now(), :'started'::timestamptz, :'version', :'interval'::int, COALESCE($NEXT_RUN_SQL, now()), :'s4'::boolean, :'alerts'::boolean)
ON CONFLICT (id) DO UPDATE SET
  seen_at = EXCLUDED.seen_at, started_at = EXCLUDED.started_at, version = EXCLUDED.version,
  interval_hours = EXCLUDED.interval_hours, next_run_at = EXCLUDED.next_run_at,
  s4_configured = EXCLUDED.s4_configured, alerts_configured = EXCLUDED.alerts_configured;
SQL
}

# Run pianificato dovuto → in coda. Con un altro run già in coda o in corso
# l'indice unico parziale fa saltare l'INSERT: il giro dopo riprova.
enqueue_schedule() {
  local queued
  queued="$(db -v interval="$INTERVAL_HOURS" -v retry="$RETRY_HOURS" <<SQL
INSERT INTO stack_backup_runs (trigger, requested_by)
SELECT 'schedule', 'system:backup'
WHERE COALESCE($NEXT_RUN_SQL, now()) <= now()
ON CONFLICT DO NOTHING
RETURNING id;
SQL
)"
  if [ -n "$queued" ]; then log "run pianificato in coda: $queued"; fi
}

# Run in coda più vecchio → running. Stampa "id|trigger" o niente.
claim() {
  db <<'SQL'
UPDATE stack_backup_runs SET status = 'running', started_at = now()
WHERE id = (
  SELECT id FROM stack_backup_runs WHERE status = 'queued'
  ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED
)
RETURNING id::text || '|' || trigger;
SQL
}

# Run rimasti 'running' da un processo precedente (container fermato a metà):
# all'avvio c'è un solo servizio, quindi nessuno li sta più eseguendo.
close_interrupted() {
  local n
  n="$(db <<'SQL'
WITH closed AS (
  UPDATE stack_backup_runs
  SET status = 'failed', finished_at = now(),
      message = 'Run interrotto: il servizio di backup è ripartito mentre era in corso'
  WHERE status = 'running'
  RETURNING 1
)
SELECT count(*) FROM closed;
SQL
)"
  if [ "${n:-0}" != "0" ]; then warn "$n run interrotti chiusi come falliti"; fi
}

run_one() {
  local id="$1" trigger="$2" code status backup_id offsite message tail_text
  log "run $id ($trigger): avvio di $(basename "$SCRIPT")"
  set +e
  timeout --signal=TERM --kill-after=60 "$RUN_TIMEOUT" "$SCRIPT" 2>&1 | tee "$RUN_LOG"
  code=${PIPESTATUS[0]}
  set -e

  case "$code" in
    0) status=succeeded ;;
    3) status=incomplete ;;
    75) status=skipped ;;
    *) status=failed ;;
  esac
  backup_id="$(sed -n 's/.*\] run \([0-9]\{8\}T[0-9]\{6\}Z\): .*/\1/p' "$RUN_LOG" | head -n 1)"
  if grep -q 'copia off-site completata' "$RUN_LOG"; then offsite=true
  elif [ "$status" = succeeded ] || [ "$status" = incomplete ]; then offsite=false
  else offsite=''
  fi
  message="$(grep -E 'ERRORE|ATTENZIONE' "$RUN_LOG" | tail -n 1 || true)"
  [ -n "$message" ] || message="$(tail -n 1 "$RUN_LOG")"
  if [ "$code" = 124 ]; then message="Run interrotto dopo ${RUN_TIMEOUT} s (BACKUP_RUN_TIMEOUT_SECONDS)"; fi
  tail_text="$(tail -n "$LOG_TAIL_LINES" "$RUN_LOG")"

  db -v id="$id" -v status="$status" -v code="$code" -v backup_id="$backup_id" -v offsite="$offsite" \
     -v message="$message" -v tail_text="$tail_text" >/dev/null <<'SQL' || warn "esito del run $id non registrato"
UPDATE stack_backup_runs SET
  status = :'status', finished_at = now(), exit_code = :'code'::int,
  backup_id = NULLIF(:'backup_id', ''), offsite = NULLIF(:'offsite', '')::boolean,
  message = NULLIF(:'message', ''), log_tail = NULLIF(:'tail_text', '')
WHERE id = :'id'::uuid;
SQL
  log "run $id: $status (exit $code${backup_id:+, backup $backup_id})"
}

tick() {
  heartbeat || { warn "heartbeat non scritto (database non raggiungibile?)"; return 0; }
  enqueue_schedule || warn "controllo del run pianificato fallito"
  local claimed
  claimed="$(claim)" || { warn "lettura della coda fallita"; return 0; }
  if [ -n "$claimed" ]; then
    run_one "${claimed%%|*}" "${claimed##*|}"
    heartbeat || true
  fi
}

trap 'log "arresto richiesto"; exit 0' TERM INT

log "avvio: versione $VERSION, ogni ${INTERVAL_HOURS} h, S4 $([ "$S4_CONFIGURED" = true ] && echo configurato || echo 'non configurato'), alert $([ "$ALERTS_CONFIGURED" = true ] && echo configurati || echo 'non configurati')"
close_interrupted || warn "chiusura dei run interrotti fallita"

if [ "$ONCE" = 1 ]; then
  tick
  exit 0
fi
while true; do
  tick
  # sleep in background + wait: il TERM di docker stop interrompe subito l'attesa.
  sleep "$POLL_SECONDS" &
  wait $! || true
done
