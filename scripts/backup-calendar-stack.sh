#!/usr/bin/env bash
# Backup coordinato dello stack del calendario — Calicchia Design Platform.
#
# Fase F1 del passaggio del calendario a Radicale (docs/calendar-radicale/
# piano.md, attività 9; design §16.1). In un solo run, nell'ordine:
#   1. pg_dump completo del database (plain SQL, gzip), con lo stato del
#      backend calendario (calendar_backend_state: modalità, volume_id, epoch)
#      letto prima e dopo il dump;
#   2. tar del volume di Radicale (radicale_collections) sotto un lock
#      CONDIVISO su collections/.Radicale.lock: è il lock di Radicale stesso
#      (flock, esclusivo per ogni scrittura), quindi durante il tar nessuna
#      PUT, DELETE, MKCALENDAR o PROPPATCH può cambiare i file, mentre le
#      letture dei device continuano. Esclusi .Radicale.cache (ricostruibile),
#      i temporanei e il file di lock;
#   3. un solo manifest.json con ore di dump e snapshot, checksum e
#      dimensioni dei file, stato del backend, inventario del volume
#      (collezioni, item, token di contenuto, marker volume-id/epoch) e
#      l'esito del confronto d'identità DB ↔ volume;
#   4. retention locale, copia off-site su MEGA S4 (come scripts/backup-db.sh)
#      e retention su S4.
# Il dump viene PRIMA dello snapshot: il volume non è mai più vecchio del
# database, quindi dopo un ripristino coordinato l'indice si riallinea solo per
# aggiunte (e le proiezioni di prenotazioni successive al dump compaiono come
# orfane da recuperare, mai cancellate). RPO: la cadenza del cron (6 h).
#
# Uso:   ./scripts/backup-calendar-stack.sh [--db-only] [--no-upload]
# Cron consigliato sul VPS, come root (legge il volume Docker e usa docker exec):
#   17 */6 * * * cd /opt/calicchia-design-platform && set -a && . ./.env.backup && set +a && ./scripts/backup-calendar-stack.sh >> /var/log/caldes-backup.log 2>&1
#
# Configurazione (env):
#   Database, in ordine di precedenza:
#     PG_CONTAINER       container postgres (nome o id): pg_dump/psql con docker exec,
#                        utente DB_USER (default caldes) e database DB_NAME (default caldes)
#     COMPOSE_PROJECT    progetto Compose dello stack (es. calicchia-design-platform):
#                        trova da solo il container postgres e il volume di Radicale
#     DATABASE_URL       postgresql://… con pg_dump/psql locali (versione ≥ quella del server)
#   Volume di Radicale, in ordine di precedenza:
#     RADICALE_VOLUME_DIR  cartella del volume sull'host (quella che Radicale vede come /data)
#     RADICALE_VOLUME      nome del volume Docker (es. <progetto>_radicale_collections)
#     COMPOSE_PROJECT      → volume <progetto>_radicale_collections
#   RADICALE_BACKUP     required (default) | auto (senza volume configurato: solo DB,
#                       con un avviso) | skip (solo DB, come --db-only). Con required
#                       un volume assente, senza collections/ o non leggibile (lock,
#                       tar) NON ferma il dump: il run si chiude con il solo database,
#                       marcato incompleto nel manifest, e lo script esce con 3
#   ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID
#                       alert Telegram per ogni run fallito o incompleto (exit ≠ 0,
#                       tranne 75); in mancanza si usano TELEGRAM_BOT_TOKEN e
#                       TELEGRAM_CHAT_ID dell'API. Senza nessuno dei due, solo il log
#   ALERT_TELEGRAM_API_URL  default https://api.telegram.org (solo per i test)
#   RADICALE_PRINCIPAL  default federico (marker d'identità e inventario)
#   LOCK_TIMEOUT        secondi di attesa del lock di Radicale, default 120
#   BACKUP_DIR          default ./backups → i run in $BACKUP_DIR/calendar-stack/<id>/
#   RETENTION_DAYS      retention locale in giorni, default 30 (si tiene sempre l'ultimo run)
#   S4_ENDPOINT, S4_BUCKET, S4_ACCESS_KEY_ID, S4_SECRET_ACCESS_KEY, S4_REGION
#                       copia off-site (AWS CLI); senza S4_BUCKET/S4_ENDPOINT solo locale
#   S4_PREFIX           default calendar-stack → s3://$S4_BUCKET/$S4_PREFIX/<id>/
#   S4_UPLOAD           every (default: ogni run) | daily (il primo run di ogni giorno UTC) | never
#   S4_RETENTION_DAYS   default = RETENTION_DAYS
#   UPLOAD_DIR          se impostata e leggibile, sync delle immagini su s3://$S4_BUCKET/uploads/
#                       (comportamento storico di backup-db.sh)
#
# Ripristino: scripts/restore-calendar-stack.sh <cartella del run | s3://… | latest>.
# Exit: 0 ok, 1 errore, 2 uso errato, 3 run incompleto (database salvato, volume di
# Radicale no, con RADICALE_BACKUP=required), 75 un altro backup è già in corso.
set -Eeuo pipefail

SCRIPT_NAME="backup-calendar-stack"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/calendar_stack.py"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SCRIPT_NAME" "$*"; }
warn() { printf '%s [%s] ATTENZIONE: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SCRIPT_NAME" "$*" >&2; }
LAST_ERROR=""
die() {
  LAST_ERROR="$*"
  printf '%s [%s] ERRORE: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SCRIPT_NAME" "$*" >&2
  exit 1
}
# Riga dell'ultimo comando fallito con set -e (senza testo del comando: potrebbe
# contenere un DATABASE_URL con la password).
trap 'LAST_ERROR="${LAST_ERROR:-comando fallito alla riga $LINENO}"' ERR

# Alert di un run fallito o incompleto: il cron scrive solo in un file di log,
# quindi senza alert un backup fermo da giorni passerebbe inosservato. Mai
# bloccante: un errore dell'alert si registra e basta. Il token non finisce né
# nella riga di comando di curl (config da stdin) né nei log.
notify_failure() {
  local code="$1" detail="$2"
  local token="${ALERT_TELEGRAM_BOT_TOKEN:-${TELEGRAM_BOT_TOKEN:-}}"
  local chat="${ALERT_TELEGRAM_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"
  local api="${ALERT_TELEGRAM_API_URL:-https://api.telegram.org}"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl assente: alert Telegram non inviato"
    return 0
  fi
  local text
  text="$(printf 'Backup del calendario su %s: %s (exit %s).\n%s\nLog: /var/log/caldes-backup.log' \
    "$(hostname 2>/dev/null || echo host)" "$([ "$code" = 3 ] && echo 'run INCOMPLETO, salvato solo il database' || echo 'run FALLITO')" \
    "$code" "$detail")"
  if ! printf 'url = "%s/bot%s/sendMessage"\n' "${api%/}" "$token" \
      | curl -sS --max-time 10 --fail -o /dev/null -K - \
          --data-urlencode "chat_id=${chat}" --data-urlencode "text=${text}" 2>/dev/null; then
    warn "invio dell'alert Telegram non riuscito"
  fi
}
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_ms() { date +%s%3N; }

usage() {
  sed -n '2,/^set -Eeuo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
}

# ─── Argomenti e configurazione ───────────────────────────────

DB_ONLY=0
NO_UPLOAD=0
for arg in "$@"; do
  case "$arg" in
    --db-only) DB_ONLY=1 ;;
    --no-upload) NO_UPLOAD=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opzione sconosciuta: $arg (vedi --help)" >&2; exit 2 ;;
  esac
done

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
S4_RETENTION_DAYS="${S4_RETENTION_DAYS:-$RETENTION_DAYS}"
S4_PREFIX="${S4_PREFIX:-calendar-stack}"
S4_UPLOAD="${S4_UPLOAD:-every}"
LOCK_TIMEOUT="${LOCK_TIMEOUT:-120}"
RADICALE_PRINCIPAL="${RADICALE_PRINCIPAL:-federico}"
RADICALE_BACKUP="${RADICALE_BACKUP:-required}"
DB_USER="${DB_USER:-caldes}"
DB_NAME="${DB_NAME:-caldes}"
[ "$DB_ONLY" = 1 ] && RADICALE_BACKUP=skip

case "$RADICALE_BACKUP" in required|auto|skip) ;; *) die "RADICALE_BACKUP non valida: $RADICALE_BACKUP (required, auto, skip)" ;; esac
case "$S4_UPLOAD" in every|daily|never) ;; *) die "S4_UPLOAD non valida: $S4_UPLOAD (every, daily, never)" ;; esac
for n in RETENTION_DAYS S4_RETENTION_DAYS LOCK_TIMEOUT; do
  [[ "${!n}" =~ ^[0-9]+$ ]] || die "$n deve essere un intero ≥ 0: ${!n}"
done
[[ "$S4_PREFIX" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || die "S4_PREFIX non valido: $S4_PREFIX"

need() { command -v "$1" >/dev/null 2>&1 || die "comando richiesto non trovato: $1${2:+ ($2)}"; }
need python3 "per manifest e inventario"
need flock "util-linux"
need tar
need gzip
need sha256sum
[ -f "$TOOL" ] || die "helper assente: $TOOL"

# I backup contengono dati personali (prenotazioni, eventi, app-password
# hashate): file 0600 e cartelle 0700.
umask 077

# ─── Sorgente del database ────────────────────────────────────

DB_MODE=""
if [ -n "${PG_CONTAINER:-}" ]; then
  DB_MODE=docker
elif [ -n "${COMPOSE_PROJECT:-}" ]; then
  need docker
  PG_CONTAINER="$(docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" --filter "label=com.docker.compose.service=postgres" | head -n1)"
  [ -n "$PG_CONTAINER" ] || die "container postgres del progetto ${COMPOSE_PROJECT} non trovato (è in esecuzione?)"
  DB_MODE=docker
elif [ -n "${DATABASE_URL:-}" ]; then
  DB_MODE=url
  need pg_dump "pacchetto postgresql-client"
  need psql "pacchetto postgresql-client"
else
  die "nessun database configurato: imposta PG_CONTAINER, COMPOSE_PROJECT o DATABASE_URL"
fi
[ "$DB_MODE" = docker ] && need docker

# psql in sola lettura, una riga per risultato, nessun file di avvio.
db_query() {
  if [ "$DB_MODE" = docker ]; then
    docker exec "$PG_CONTAINER" psql -X -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "$1"
  else
    psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "$1"
  fi
}
db_dump() {
  if [ "$DB_MODE" = docker ]; then
    docker exec "$PG_CONTAINER" pg_dump --no-owner --no-privileges -U "$DB_USER" -d "$DB_NAME"
  else
    pg_dump --no-owner --no-privileges "$DATABASE_URL"
  fi
}
pg_dump_version() {
  if [ "$DB_MODE" = docker ]; then
    docker exec "$PG_CONTAINER" pg_dump --version
  else
    pg_dump --version
  fi
}
# Stato del backend come JSON (null prima della migrazione 162).
backend_state_json() {
  local exists
  exists="$(db_query "SELECT to_regclass('public.calendar_backend_state') IS NOT NULL")"
  if [ "$exists" = "t" ]; then
    db_query "SELECT row_to_json(s) FROM (SELECT mode, write_freeze, volume_id, epoch, credential_epoch, policy_version, restore_guard_until, rebuild_required, updated_at FROM calendar_backend_state WHERE id) s"
  else
    echo "null"
  fi
}
# Solo i campi d'identità, per confrontare lo stato prima e dopo il dump.
identity_of() {
  python3 -c 'import json,sys; s=json.loads(sys.argv[1]); print("null" if s is None else "%s|%s|%s" % (s.get("mode"), s.get("volume_id"), s.get("epoch")))' "$1"
}

# ─── Sorgente del volume ──────────────────────────────────────

# Con RADICALE_BACKUP=required un problema del volume NON ferma il run prima
# del dump: il database (tutta la piattaforma, non solo il calendario) si salva
# comunque, il run si chiude come "solo database" marcato incompleto nel
# manifest e lo script esce con 3 (alert compreso). VOLUME_PROBLEM ne tiene il
# motivo.
VOLUME_DIR=""
VOLUME_SOURCE=""
VOLUME_PROBLEM=""
volume_unavailable() {
  if [ "$RADICALE_BACKUP" = required ]; then
    VOLUME_PROBLEM="$1"
    warn "$1: salvo comunque il database, il run sarà INCOMPLETO (exit 3)"
  else
    warn "$1: backup SOLO del database (non è un backup coordinato del calendario)"
  fi
  VOLUME_DIR=""
  VOLUME_SOURCE=""
}
if [ "$RADICALE_BACKUP" != skip ]; then
  if [ -n "${RADICALE_VOLUME_DIR:-}" ]; then
    VOLUME_DIR="$RADICALE_VOLUME_DIR"
    VOLUME_SOURCE="dir:${RADICALE_VOLUME_DIR}"
  elif [ -n "${RADICALE_VOLUME:-}" ] || [ -n "${COMPOSE_PROJECT:-}" ]; then
    need docker
    vol="${RADICALE_VOLUME:-${COMPOSE_PROJECT}_radicale_collections}"
    VOLUME_DIR="$(docker volume inspect --format '{{ .Mountpoint }}' "$vol" 2>/dev/null || true)"
    VOLUME_SOURCE="volume:${vol}"
    [ -n "$VOLUME_DIR" ] || volume_unavailable "volume Docker $vol non trovato"
  else
    volume_unavailable "volume di Radicale non configurato (RADICALE_VOLUME_DIR, RADICALE_VOLUME o COMPOSE_PROJECT; per il solo database --db-only)"
  fi
  if [ -n "$VOLUME_DIR" ] && [ ! -d "$VOLUME_DIR/collections" ]; then
    volume_unavailable "nel volume $VOLUME_DIR manca collections/ (Radicale non è mai partito su questo volume, o è il percorso sbagliato)"
  fi
fi

# ─── Run: lock dello script, cartella temporanea, pulizia ─────

ROOT="${BACKUP_DIR%/}/calendar-stack"
mkdir -p "$ROOT"
# I backup contengono dati personali: se BACKUP_DIR sta dentro un checkout del
# repository (il default ./backups), git deve ignorarli.
[ -e "$ROOT/.gitignore" ] || printf '*\n' > "$ROOT/.gitignore"
exec 8>"$ROOT/.backup.lock"
if ! flock -n 8; then
  echo "$(now_iso) [$SCRIPT_NAME] un altro backup è già in corso ($ROOT/.backup.lock): esco" >&2
  exit 75
fi

ID="$(date -u +%Y%m%dT%H%M%SZ)"
CREATED_AT="$(now_iso)"
while [ -e "$ROOT/$ID" ]; do sleep 1; ID="$(date -u +%Y%m%dT%H%M%SZ)"; done
WORK="$ROOT/.partial-$ID"
mkdir "$WORK"

RADICALE_LOCKED=0
cleanup() {
  local code=$?
  if [ "$RADICALE_LOCKED" = 1 ]; then flock -u 9 2>/dev/null || true; exec 9<&- || true; fi
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    rm -rf -- "$WORK"
    [ "$code" -ne 0 ] && echo "$(now_iso) [$SCRIPT_NAME] run $ID fallito: cartella parziale rimossa" >&2
  fi
  if [ "$code" -ne 0 ] && [ "$code" -ne 75 ]; then
    notify_failure "$code" "${LAST_ERROR:-uscita con codice $code}"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "run $ID: database ($DB_MODE), volume ${VOLUME_SOURCE:-non incluso} → $ROOT/$ID"

# ─── 1. Database ──────────────────────────────────────────────

SERVER_VERSION_NUM="$(db_query "SHOW server_version_num")" || die "database non raggiungibile"
SERVER_VERSION="$(db_query "SHOW server_version")"
PG_DUMP_VERSION="$(pg_dump_version | head -n1)"
dump_major="$(printf '%s' "$PG_DUMP_VERSION" | sed -nE 's/^pg_dump \(PostgreSQL\) ([0-9]+).*/\1/p')"
server_major=$((SERVER_VERSION_NUM / 10000))
if [ -n "$dump_major" ] && [ "$dump_major" -lt "$server_major" ]; then
  die "pg_dump $dump_major è più vecchio del server $server_major: usa PG_CONTAINER o COMPOSE_PROJECT (pg_dump del container)"
fi
LAST_MIGRATION=""
if [ "$(db_query "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" = "t" ]; then
  LAST_MIGRATION="$(db_query "SELECT coalesce(max(version), '') FROM schema_migrations WHERE version ~ '^[0-9]'")"
fi
STATE_BEFORE="$(backend_state_json)"

DB_STARTED_AT="$(now_iso)"
db_dump | gzip -6 > "$WORK/caldes-db.sql.gz"
DB_FINISHED_AT="$(now_iso)"
STATE_AFTER="$(backend_state_json)"
if [ "$(identity_of "$STATE_BEFORE")" != "$(identity_of "$STATE_AFTER")" ]; then
  die "modalità o identità del backend cambiate durante il dump ($(identity_of "$STATE_BEFORE") → $(identity_of "$STATE_AFTER")): transizione in corso, riprova a transizione conclusa"
fi
log "dump completato: $(du -h "$WORK/caldes-db.sql.gz" | cut -f1) (ultima migrazione ${LAST_MIGRATION:-?})"

# ─── 2. Volume di Radicale sotto lock condiviso ───────────────

VOL_STARTED_AT=""
VOL_FINISHED_AT=""
LOCK_WAITED_MS=0
if [ -n "$VOLUME_DIR" ]; then
  LOCKFILE="$VOLUME_DIR/collections/.Radicale.lock"
  # Il lock lo crea Radicale alla prima richiesta (l'healthcheck ne fa una ogni
  # 30 s). Se manca lo si crea con il proprietario di collections/ (utente
  # radicale): un file di root renderebbe il lock inapribile per Radicale.
  if [ ! -e "$LOCKFILE" ]; then
    python3 - "$LOCKFILE" <<'PY'
import os, sys
path = sys.argv[1]
st = os.stat(os.path.dirname(path))
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
except FileExistsError:
    sys.exit(0)
try:
    if os.geteuid() == 0:
        os.fchown(fd, st.st_uid, st.st_gid)
    os.fchmod(fd, 0o644)
finally:
    os.close(fd)
PY
    warn "creato $LOCKFILE (Radicale non aveva ancora servito richieste su questo volume)"
  fi
  # Aperto in sola lettura (flock non richiede la scrittura e così non lo si
  # crea né tronca mai); lock condiviso: le scritture di Radicale (LOCK_EX)
  # attendono la fine del tar, le letture no.
  exec 9<"$LOCKFILE"
  RADICALE_LOCKED=1
  t0="$(now_ms)"
  if ! flock -s -w "$LOCK_TIMEOUT" 9; then
    volume_failure="lock di Radicale non ottenuto in ${LOCK_TIMEOUT} s ($LOCKFILE): una scrittura molto lunga in corso?"
  else
    LOCK_WAITED_MS=$(( $(now_ms) - t0 ))
    VOL_STARTED_AT="$(now_iso)"
    if tar --create --gzip --file "$WORK/radicale-collections.tar.gz" \
        --directory "$VOLUME_DIR" --numeric-owner --sort=name \
        --exclude='.Radicale.cache' --exclude='.Radicale.tmp-*' \
        --anchored --exclude='collections/.Radicale.lock' \
        collections; then
      VOL_FINISHED_AT="$(now_iso)"
      volume_failure=""
    else
      volume_failure="tar del volume $VOLUME_DIR fallito"
    fi
    flock -u 9
  fi
  exec 9<&-
  RADICALE_LOCKED=0
  if [ -n "$volume_failure" ]; then
    # Il dump è già fatto e resta: il run si chiude con il solo database.
    rm -f -- "$WORK/radicale-collections.tar.gz"
    VOL_STARTED_AT=""
    VOLUME_PROBLEM="$volume_failure"
    VOLUME_SOURCE=""
    warn "$volume_failure: salvo comunque il database, il run sarà INCOMPLETO (exit 3)"
  else
    log "snapshot del volume completato: $(du -h "$WORK/radicale-collections.tar.gz" | cut -f1) (attesa del lock ${LOCK_WAITED_MS} ms)"
  fi
fi

# ─── 3. Manifest ──────────────────────────────────────────────

if [ "$DB_MODE" = docker ]; then DB_SOURCE="docker:${PG_CONTAINER}/${DB_NAME}"; else
  DB_SOURCE="url:$(python3 "$TOOL" url-info "$DATABASE_URL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dbname"])')"
fi
RESULT="$(CS_ID="$ID" CS_CREATED_AT="$CREATED_AT" CS_HOST="$(hostname 2>/dev/null || echo unknown)" \
  CS_SCRIPT="scripts/backup-calendar-stack.sh" CS_PRINCIPAL="$RADICALE_PRINCIPAL" \
  CS_DB_STATE="$STATE_BEFORE" CS_DB_STARTED_AT="$DB_STARTED_AT" CS_DB_FINISHED_AT="$DB_FINISHED_AT" \
  CS_DB_SOURCE="$DB_SOURCE" CS_DB_SERVER_VERSION="$SERVER_VERSION" CS_PG_DUMP_VERSION="$PG_DUMP_VERSION" \
  CS_DB_LAST_MIGRATION="$LAST_MIGRATION" CS_VOLUME_SOURCE="$VOLUME_SOURCE" CS_VOLUME_LOCK="shared" \
  CS_VOLUME_LOCK_WAITED_MS="$LOCK_WAITED_MS" CS_VOLUME_STARTED_AT="$VOL_STARTED_AT" CS_VOLUME_FINISHED_AT="$VOL_FINISHED_AT" \
  CS_INCOMPLETE="$VOLUME_PROBLEM" \
  python3 "$TOOL" write-manifest --dir "$WORK")"
IDENTITY="$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["identity"])')"
# Il run si verifica come lo verificherà il ripristino, prima di pubblicarlo.
python3 "$TOOL" verify --dir "$WORK" >/dev/null || die "verifica del run fallita"

mv -T "$WORK" "$ROOT/$ID"
WORK=""
ln -sfn "$ID" "$ROOT/.latest.tmp" && mv -T "$ROOT/.latest.tmp" "$ROOT/latest"
if [ -n "$VOLUME_PROBLEM" ]; then
  log "run $ID INCOMPLETO, verificato: solo database (volume: $VOLUME_PROBLEM)"
else
  log "run $ID completo e verificato (identità DB ↔ volume: $IDENTITY)"
fi
case "$IDENTITY" in
  mismatch|unverified)
    mode="$(python3 "$TOOL" get --file "$ROOT/$ID/manifest.json" --path database.backend_state.mode --default '')"
    warn "identità del volume e stato del DB non coincidono ($IDENTITY, modalità ${mode:-?}): con Radicale autorevole questo snapshot NON è ripristinabile così com'è (vedi apps/radicale/README.md)" ;;
  uninitialized)
    if [ "$(python3 "$TOOL" get --file "$ROOT/$ID/manifest.json" --path radicale.inventory.marker.state --default '')" = ok ]; then
      warn "database non inizializzato (epoch 0) ma il volume ha un marker d'identità: dopo un ripristino i device resterebbero negati (vedi apps/radicale/README.md, riallineamento)"
    fi ;;
esac

# ─── 4. Retention locale ──────────────────────────────────────

mapfile -t local_ids < <(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E '^[0-9]{8}T[0-9]{6}Z$' || true)
if [ "${#local_ids[@]}" -gt 0 ]; then
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -rf -- "${ROOT:?}/$old"
    log "retention: rimosso il run $old (oltre ${RETENTION_DAYS} giorni)"
  done < <(python3 "$TOOL" prune-ids --days "$RETENTION_DAYS" --keep 1 "${local_ids[@]}")
fi
# Parziali di run interrotti con kill -9 (la trap non è girata), oltre 1 giorno.
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mtime +0 -exec rm -rf -- {} + 2>/dev/null || true
# Dump del vecchio backup-db.sh (caldes-*.sql.gz in BACKUP_DIR): stessa retention.
legacy_deleted="$(find "${BACKUP_DIR%/}" -maxdepth 1 -name 'caldes-*.sql.gz' -type f -mtime +"${RETENTION_DAYS}" -print -delete | wc -l)"
[ "$legacy_deleted" -gt 0 ] && log "retention: rimossi ${legacy_deleted} dump del vecchio backup-db.sh"

# ─── 5. Copia off-site su MEGA S4 ─────────────────────────────

if [ "$NO_UPLOAD" = 1 ] || [ "$S4_UPLOAD" = never ]; then
  log "copia su S4 disattivata (--no-upload o S4_UPLOAD=never)"
elif [ -n "${S4_BUCKET:-}" ] && [ -n "${S4_ENDPOINT:-}" ]; then
  need aws "AWS CLI, per la copia su S4"
  export AWS_ACCESS_KEY_ID="${S4_ACCESS_KEY_ID:-}"
  export AWS_SECRET_ACCESS_KEY="${S4_SECRET_ACCESS_KEY:-}"
  export AWS_DEFAULT_REGION="${S4_REGION:-auto}"
  s3() { aws s3 "$@" --endpoint-url "$S4_ENDPOINT" --only-show-errors; }
  stamp="$ROOT/.s4-last-upload-day"
  today="$(date -u +%Y%m%d)"
  if [ "$S4_UPLOAD" = daily ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$today" ]; then
    log "copia su S4 già fatta oggi (S4_UPLOAD=daily): saltata"
  else
    dest="s3://${S4_BUCKET}/${S4_PREFIX}/${ID}"
    # Prima i file, il manifest per ultimo: un manifest remoto implica un run completo.
    s3 cp "$ROOT/$ID/caldes-db.sql.gz" "$dest/caldes-db.sql.gz"
    [ -f "$ROOT/$ID/radicale-collections.tar.gz" ] && s3 cp "$ROOT/$ID/radicale-collections.tar.gz" "$dest/radicale-collections.tar.gz"
    s3 cp "$ROOT/$ID/manifest.json" "$dest/manifest.json"
    printf '%s\n' "$today" > "$stamp"
    log "copia off-site completata: $dest/"
    # Retention su S4: solo cartelle con il formato degli id, sempre l'ultima tenuta.
    mapfile -t remote_ids < <(aws s3 ls "s3://${S4_BUCKET}/${S4_PREFIX}/" --endpoint-url "$S4_ENDPOINT" | python3 "$TOOL" s3-ls-ids)
    if [ "${#remote_ids[@]}" -gt 0 ]; then
      while IFS= read -r old; do
        [ -n "$old" ] || continue
        s3 rm --recursive "s3://${S4_BUCKET}/${S4_PREFIX}/${old}/"
        log "retention S4: rimosso $old"
      done < <(python3 "$TOOL" prune-ids --days "$S4_RETENTION_DAYS" --keep 1 "${remote_ids[@]}")
    fi
  fi
  # Immagini e upload, come il vecchio backup-db.sh.
  if [ -n "${UPLOAD_DIR:-}" ] && [ -d "${UPLOAD_DIR}" ]; then
    log "sync immagini ${UPLOAD_DIR} → s3://${S4_BUCKET}/uploads/"
    s3 sync "${UPLOAD_DIR}" "s3://${S4_BUCKET}/uploads/"
  fi
else
  log "S4 non configurato (S4_BUCKET/S4_ENDPOINT): backup solo locale"
fi

if [ -n "$VOLUME_PROBLEM" ]; then
  LAST_ERROR="run $ID con il solo database: $VOLUME_PROBLEM"
  printf '%s [%s] ERRORE: %s\n' "$(now_iso)" "$SCRIPT_NAME" "$LAST_ERROR" >&2
  exit 3
fi
log "fatto: $ROOT/$ID"
