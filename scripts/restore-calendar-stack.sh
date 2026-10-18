#!/usr/bin/env bash
# Ripristino coordinato dello stack del calendario — Calicchia Design Platform.
#
# Fase F1 del passaggio del calendario a Radicale (docs/calendar-radicale/
# piano.md, attività 9; design §16.3). Ripristina un run di
# scripts/backup-calendar-stack.sh: database (pg_dump), volume di Radicale
# (tar) o entrambi, dopo aver verificato checksum, inventario e identità del
# volume, e solo con una conferma esplicita.
#
# Uso:   ./scripts/restore-calendar-stack.sh [opzioni] <run>
#   <run>   cartella di un run ($BACKUP_DIR/calendar-stack/<id>), `latest`,
#           oppure s3://<bucket>/<prefisso>/<id>/ (scaricato con la AWS CLI)
# Opzioni:
#   --only all|db|volume        cosa ripristinare (default all: DB e volume dello
#                               stesso manifest, scenario B del design §16.3;
#                               volume: scenario A, DB intatto; db: volume intatto)
#   --verify-only               verifica run, identità e servizi, stampa il piano,
#                               non modifica nulla (drill e controlli periodici)
#   --target-volume-dir DIR     cartella del volume da ripristinare (default: come
#                               il backup, da RADICALE_VOLUME_DIR, RADICALE_VOLUME o
#                               COMPOSE_PROJECT). È la cartella che Radicale vede
#                               come /data (per un volume Docker: …/<volume>/_data):
#                               deve essere vuota oppure contenere collections/ (o un
#                               collections.pre-restore-*), e con COMPOSE_PROJECT
#                               deve coincidere con il Mountpoint del volume
#                               <progetto>_radicale_collections
#   --force-target              accetta una destinazione che non rispetta le
#                               regole sopra (mai necessario per il volume vero)
#   --confirm "RIPRISTINA <id>" conferma non interattiva; senza, la frase si digita
#   --accept-identity-mismatch  procede anche se l'identità risultante non coincide,
#                               se l'epoch torna indietro o se il database non è
#                               inizializzato ma il volume ha un marker (i device
#                               resteranno negati finché l'identità non viene
#                               riallineata: procedura nel piano e nel README)
#   --no-safety-dump            niente dump di sicurezza del database corrente
#
# Configurazione: le stesse variabili di backup-calendar-stack.sh (PG_CONTAINER,
# COMPOSE_PROJECT, DATABASE_URL, DB_USER, DB_NAME, RADICALE_VOLUME_DIR,
# RADICALE_VOLUME, RADICALE_PRINCIPAL, BACKUP_DIR, S4_*). Con COMPOSE_PROJECT lo
# script verifica anche che radicale (per il volume) e api e worker (per il
# database) siano fermi; senza Docker lo dichiara e lo fa confermare.
#
# Cosa fa, in ordine:
#   1. verifica il run (manifest, dimensioni e sha256, gzip, inventario
#      dell'archivio), la cartella di destinazione del volume e l'identità che
#      risulterà dal ripristino: marker volume-id/epoch del volume contro
#      calendar_backend_state (contratto control-plane §4.3). mismatch,
#      unverified, epoch che torna indietro, oppure database non inizializzato
#      (epoch 0) con un marker valido sul volume → stop, salvo
#      --accept-identity-mismatch;
#   2. dump di sicurezza del database corrente in
#      $BACKUP_DIR/calendar-stack/pre-restore-<ts>/ (mai cancellato dallo script);
#   3. database: DROP DATABASE … WITH (FORCE), CREATE DATABASE, caricamento del
#      dump (serve un superutente: lo è POSTGRES_USER dell'immagine ufficiale);
#   4. volume, solo dopo che il database è stato caricato: collections/
#      corrente spostata in collections.pre-restore-<ts> nello stesso volume
#      (mai cancellata dallo script), estrazione con proprietari numerici,
#      inventario della cartella ripristinata confrontato con il manifest. Se
#      estrazione o confronto falliscono, l'estratto va in
#      collections.failed-restore-<ts> e la collections precedente torna al suo
#      posto;
#   5. calendar_backend_state: restore_guard_until = now() + 48 h e
#      rebuild_required = true (policy frozen finché la verifica post-ripristino
#      non è verde, design §16.2-§16.3); dopo un ripristino del database anche
#      credential_epoch = max(precedente, ripristinato) + 1 (cache delle
#      credenziali di Radicale svuotate, epoch mai decrementato) e, in
#      mode=postgres, calendar_sidecar_reconcile().
# Exit: 0 ok, 1 errore o verifica fallita, 2 uso errato, 3 annullato.
set -Eeuo pipefail

SCRIPT_NAME="restore-calendar-stack"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/calendar_stack.py"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SCRIPT_NAME" "$*"; }
warn() { printf '%s [%s] ATTENZIONE: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SCRIPT_NAME" "$*" >&2; }
die() { printf '%s [%s] ERRORE: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SCRIPT_NAME" "$*" >&2; exit 1; }

# Collections corrente spostata da parte (ASIDE) e non ancora sostituita da un
# ripristino verificato: a ogni uscita con errore torna al suo posto, e ciò che
# era stato estratto finisce in collections.failed-restore-<ts>.
ASIDE=""
VOLUME_SWAPPED=0
restore_aside() {
  if [ -z "$ASIDE" ] || [ "$VOLUME_SWAPPED" = 1 ]; then return 0; fi
  local failed="$VOLUME_DIR/collections.failed-restore-$TS"
  if [ -e "$VOLUME_DIR/collections" ]; then
    if mv -T "$VOLUME_DIR/collections" "$failed"; then
      warn "estrazione non riuscita spostata in $failed"
    else
      warn "impossibile spostare $VOLUME_DIR/collections: la collections precedente resta in $ASIDE"
      return 0
    fi
  fi
  if mv -T "$ASIDE" "$VOLUME_DIR/collections"; then
    warn "collections precedente rimessa al suo posto ($ASIDE → $VOLUME_DIR/collections)"
  else
    warn "impossibile rimettere $ASIDE al suo posto: spostala a mano in $VOLUME_DIR/collections"
  fi
}

usage() {
  sed -n '2,/^set -Eeuo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
}

# ─── Argomenti ────────────────────────────────────────────────

ONLY=all
VERIFY_ONLY=0
TARGET_VOLUME_DIR=""
CONFIRM=""
ACCEPT_MISMATCH=0
FORCE_TARGET=0
SAFETY_DUMP=1
RUN_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 || { echo "--only richiede un valore" >&2; exit 2; } ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --target-volume-dir) TARGET_VOLUME_DIR="${2:-}"; shift 2 || { echo "--target-volume-dir richiede un valore" >&2; exit 2; } ;;
    --target-volume-dir=*) TARGET_VOLUME_DIR="${1#--target-volume-dir=}"; shift ;;
    --confirm) CONFIRM="${2:-}"; shift 2 || { echo "--confirm richiede un valore" >&2; exit 2; } ;;
    --confirm=*) CONFIRM="${1#--confirm=}"; shift ;;
    --accept-identity-mismatch) ACCEPT_MISMATCH=1; shift ;;
    --force-target) FORCE_TARGET=1; shift ;;
    --no-safety-dump) SAFETY_DUMP=0; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Opzione sconosciuta: $1 (vedi --help)" >&2; exit 2 ;;
    *) [ -z "$RUN_ARG" ] || { echo "Un solo run per volta" >&2; exit 2; }; RUN_ARG="$1"; shift ;;
  esac
done
[ -n "$RUN_ARG" ] || { usage >&2; exit 2; }
case "$ONLY" in all|db|volume) ;; *) echo "--only non valida: $ONLY (all, db, volume)" >&2; exit 2 ;; esac
RESTORE_DB=0; RESTORE_VOLUME=0
[ "$ONLY" != volume ] && RESTORE_DB=1
[ "$ONLY" != db ] && RESTORE_VOLUME=1

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RADICALE_PRINCIPAL="${RADICALE_PRINCIPAL:-federico}"
DB_USER="${DB_USER:-caldes}"
DB_NAME="${DB_NAME:-caldes}"
ROOT="${BACKUP_DIR%/}/calendar-stack"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

need() { command -v "$1" >/dev/null 2>&1 || die "comando richiesto non trovato: $1${2:+ ($2)}"; }
need python3
need flock "util-linux"
need tar
need gzip
[ -f "$TOOL" ] || die "helper assente: $TOOL"
umask 077
mkdir -p "$ROOT"
# I backup contengono dati personali: se BACKUP_DIR sta dentro un checkout del
# repository (il default ./backups), git deve ignorarli.
[ -e "$ROOT/.gitignore" ] || printf '*\n' > "$ROOT/.gitignore"

# Stesso lock del backup: nessun backup da cron parte durante un ripristino
# (e nessun ripristino durante un backup).
exec 8>"$ROOT/.backup.lock"
flock -n 8 || die "un backup o un ripristino è in corso ($ROOT/.backup.lock)"

DOWNLOAD_DIR=""
cleanup() {
  local code=$?
  [ "$code" -eq 0 ] || restore_aside
  if [ -n "$DOWNLOAD_DIR" ] && [ -d "$DOWNLOAD_DIR" ]; then rm -rf -- "$DOWNLOAD_DIR"; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ─── Run da ripristinare ──────────────────────────────────────

if [ "${RUN_ARG#s3://}" != "$RUN_ARG" ]; then
  need aws "AWS CLI, per scaricare da S4"
  [ -n "${S4_ENDPOINT:-}" ] || die "S4_ENDPOINT non impostata (serve per scaricare da s3://)"
  export AWS_ACCESS_KEY_ID="${S4_ACCESS_KEY_ID:-}"
  export AWS_SECRET_ACCESS_KEY="${S4_SECRET_ACCESS_KEY:-}"
  export AWS_DEFAULT_REGION="${S4_REGION:-auto}"
  DOWNLOAD_DIR="$ROOT/.download-$TS"
  mkdir "$DOWNLOAD_DIR"
  log "download di ${RUN_ARG%/}/ in $DOWNLOAD_DIR"
  aws s3 cp --recursive "${RUN_ARG%/}/" "$DOWNLOAD_DIR/" --endpoint-url "$S4_ENDPOINT" --only-show-errors
  RUN_DIR="$DOWNLOAD_DIR"
elif [ "$RUN_ARG" = latest ]; then
  [ -L "$ROOT/latest" ] || die "nessun run 'latest' in $ROOT"
  RUN_DIR="$(readlink -f "$ROOT/latest")"
else
  RUN_DIR="$(readlink -f "$RUN_ARG")"
fi
[ -d "$RUN_DIR" ] || die "cartella del run non trovata: $RUN_ARG"

log "verifica del run in $RUN_DIR"
python3 "$TOOL" verify --dir "$RUN_DIR" >/dev/null || die "run non valido: niente da ripristinare"
MANIFEST="$RUN_DIR/manifest.json"
mget() { python3 "$TOOL" get --file "$MANIFEST" --path "$1" --default "${2:-}"; }
ID="$(mget id)"
if [ "$(mget complete true)" = false ]; then
  warn "run $ID incompleto: contiene solo il database ($(mget incomplete_reason '?'))"
fi
HAS_VOLUME=1
[ -n "$(mget radicale.file)" ] || HAS_VOLUME=0
if [ "$RESTORE_VOLUME" = 1 ] && [ "$HAS_VOLUME" = 0 ]; then
  die "il run $ID non contiene il volume di Radicale: usa --only db"
fi
MANIFEST_STATE="$(mget database.backend_state null)"
[ -n "$MANIFEST_STATE" ] || MANIFEST_STATE=null
MANIFEST_MARKER="$(mget radicale.inventory.marker '{"state":"unreadable","detail":"volume non incluso nel run"}')"
DB_PRINCIPAL="$(mget principal federico)"
[ "$DB_PRINCIPAL" = "$RADICALE_PRINCIPAL" ] || die "il run è del principal $DB_PRINCIPAL, RADICALE_PRINCIPAL è $RADICALE_PRINCIPAL"

# ─── Database ─────────────────────────────────────────────────

DB_MODE=""
if [ -n "${PG_CONTAINER:-}" ]; then
  need docker; DB_MODE=docker
elif [ -n "${COMPOSE_PROJECT:-}" ]; then
  need docker
  PG_CONTAINER="$(docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" --filter "label=com.docker.compose.service=postgres" | head -n1)"
  [ -n "$PG_CONTAINER" ] || die "container postgres del progetto ${COMPOSE_PROJECT} non in esecuzione (va avviato: serve per il ripristino)"
  DB_MODE=docker
elif [ -n "${DATABASE_URL:-}" ]; then
  need psql "pacchetto postgresql-client"
  DB_MODE=url
  URL_INFO="$(python3 "$TOOL" url-info "$DATABASE_URL")"
  DB_NAME="$(printf '%s' "$URL_INFO" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dbname"])')"
  DB_USER="$(printf '%s' "$URL_INFO" | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"])')"
  MAINT_URL="$(printf '%s' "$URL_INFO" | python3 -c 'import json,sys; print(json.load(sys.stdin)["maintenance_url"])')"
else
  die "nessun database configurato: imposta PG_CONTAINER, COMPOSE_PROJECT o DATABASE_URL"
fi

# psql sul database dell'applicazione (o su `postgres` con maint=1), script da stdin.
psql_app() {
  if [ "$DB_MODE" = docker ]; then
    docker exec -i "$PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"
  else
    psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"
  fi
}
psql_maint() {
  if [ "$DB_MODE" = docker ]; then
    docker exec -i "$PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres "$@"
  else
    psql "$MAINT_URL" -X -q -v ON_ERROR_STOP=1 "$@"
  fi
}
db_query() { psql_app -At -c "$1" </dev/null; }
db_dump() {
  if [ "$DB_MODE" = docker ]; then
    docker exec "$PG_CONTAINER" pg_dump --no-owner --no-privileges -U "$DB_USER" -d "$DB_NAME"
  else
    need pg_dump "pacchetto postgresql-client"
    pg_dump --no-owner --no-privileges "$DATABASE_URL"
  fi
}
# Stato del backend come JSON: null se la tabella non esiste (prima della 162),
# "unreadable" se il database non risponde o non esiste.
backend_state_json() {
  local exists
  if ! exists="$(db_query "SELECT to_regclass('public.calendar_backend_state') IS NOT NULL" 2>/dev/null)"; then
    echo unreadable; return 0
  fi
  if [ "$exists" = "t" ]; then
    db_query "SELECT row_to_json(s) FROM (SELECT mode, write_freeze, volume_id, epoch, credential_epoch, policy_version, restore_guard_until, rebuild_required, updated_at FROM calendar_backend_state WHERE id) s"
  else
    echo null
  fi
}
json_field() { python3 -c 'import json,sys; d=json.loads(sys.argv[1]); v=(d or {}).get(sys.argv[2]); print("" if v is None else v)' "$1" "$2"; }

# ─── Volume ───────────────────────────────────────────────────

VOLUME_DIR="$TARGET_VOLUME_DIR"
VOLUME_DIR_FROM_DOCKER=0
if [ -z "$VOLUME_DIR" ]; then
  if [ -n "${RADICALE_VOLUME_DIR:-}" ]; then
    VOLUME_DIR="$RADICALE_VOLUME_DIR"
  elif [ -n "${RADICALE_VOLUME:-}" ] || [ -n "${COMPOSE_PROJECT:-}" ]; then
    need docker
    vol="${RADICALE_VOLUME:-${COMPOSE_PROJECT}_radicale_collections}"
    VOLUME_DIR="$(docker volume inspect --format '{{ .Mountpoint }}' "$vol" 2>/dev/null || true)"
    if [ -z "$VOLUME_DIR" ] && [ "$RESTORE_VOLUME" = 1 ]; then
      die "volume Docker $vol non trovato: crealo con il primo deploy del compose (o indica --target-volume-dir)"
    fi
    VOLUME_DIR_FROM_DOCKER=1
  fi
fi
TARGET_PROBLEMS=()
if [ "$RESTORE_VOLUME" = 1 ]; then
  [ -n "$VOLUME_DIR" ] || die "volume di Radicale non configurato: imposta RADICALE_VOLUME_DIR, RADICALE_VOLUME, COMPOSE_PROJECT o --target-volume-dir"
  [ -d "$VOLUME_DIR" ] || die "cartella del volume non trovata: $VOLUME_DIR"
  VOLUME_DIR="$(readlink -f "$VOLUME_DIR")"
  # La destinazione deve essere la radice del volume di Radicale (il suo /data):
  # vuota, oppure con collections/ o una copia collections.pre-restore-*.
  # Passare /var/lib/docker/volumes/<vol> invece di …/<vol>/_data estrarrebbe lo
  # snapshot accanto a _data e il "ripristino" si verificherebbe da solo,
  # lasciando intatto il volume vero.
  if [ -n "$(find "$VOLUME_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ] \
     && [ ! -e "$VOLUME_DIR/collections" ] \
     && [ -z "$(find "$VOLUME_DIR" -mindepth 1 -maxdepth 1 -name 'collections.pre-restore-*' -print -quit)" ]; then
    TARGET_PROBLEMS+=("$VOLUME_DIR non è vuota e non contiene collections/: è davvero il /data di Radicale? Per un volume Docker serve …/_data (contenuto: $(find "$VOLUME_DIR" -mindepth 1 -maxdepth 1 -printf '%f ' | cut -c1-200))")
  fi
  # Con il progetto Compose il percorso deve essere quello del volume dello stack.
  if [ "$VOLUME_DIR_FROM_DOCKER" = 0 ] && [ -n "${COMPOSE_PROJECT:-}" ] && command -v docker >/dev/null 2>&1; then
    expected_vol="${RADICALE_VOLUME:-${COMPOSE_PROJECT}_radicale_collections}"
    expected_dir="$(docker volume inspect --format '{{ .Mountpoint }}' "$expected_vol" 2>/dev/null || true)"
    if [ -n "$expected_dir" ] && [ "$(readlink -f "$expected_dir")" != "$VOLUME_DIR" ]; then
      TARGET_PROBLEMS+=("$VOLUME_DIR non è il Mountpoint del volume $expected_vol ($expected_dir)")
    fi
  fi
  if [ "${#TARGET_PROBLEMS[@]}" -gt 0 ]; then
    if [ "$FORCE_TARGET" = 1 ]; then
      for problem in "${TARGET_PROBLEMS[@]}"; do warn "destinazione accettata con --force-target: $problem"; done
    else
      for problem in "${TARGET_PROBLEMS[@]}"; do printf '%s [%s] ERRORE: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SCRIPT_NAME" "$problem" >&2; done
      die "destinazione del volume rifiutata (--force-target solo se è voluto)"
    fi
  fi
fi

# ─── Identità risultante ──────────────────────────────────────

CURRENT_STATE="$(backend_state_json)"
if [ -n "$VOLUME_DIR" ]; then
  CURRENT_MARKER="$(python3 "$TOOL" marker-dir "$VOLUME_DIR" --principal "$RADICALE_PRINCIPAL")"
else
  CURRENT_MARKER='{"state":"unreadable","detail":"volume di Radicale non configurato"}'
fi
# Il solo volume si ripristina con il database in piedi (stato, identità e
# guardia). Con --only all o db il database può anche non esistere più
# (scenario B): lo si ricrea dal dump.
if [ "$ONLY" = volume ] && [ "$CURRENT_STATE" = unreadable ]; then
  die "database non leggibile: il ripristino del solo volume richiede il database (stato e restore_guard)"
fi

case "$ONLY" in
  all)    POST_STATE="$MANIFEST_STATE"; POST_MARKER="$MANIFEST_MARKER" ;;
  db)     POST_STATE="$MANIFEST_STATE"; POST_MARKER="$CURRENT_MARKER" ;;
  volume) POST_STATE="$CURRENT_STATE";  POST_MARKER="$MANIFEST_MARKER" ;;
esac
IDENTITY_JSON="$(python3 "$TOOL" identity --state "$POST_STATE" --marker "$POST_MARKER")"
IDENTITY="$(json_field "$IDENTITY_JSON" status)"
IDENTITY_DETAIL="$(json_field "$IDENTITY_JSON" detail)"
# Database non inizializzato (epoch 0) con un marker valido sul volume
# risultante: non è un volume vuoto né inizializzabile. caldes_rights nega
# tutto sotto il principal (policy senza volume_id) e calendar:radicale-init
# rifiuta (principal_exists): va trattato come un'identità diversa.
if [ "$IDENTITY" = uninitialized ] && [ "$(json_field "$POST_MARKER" state)" = ok ]; then
  IDENTITY=mismatch
  IDENTITY_DETAIL="database non inizializzato (epoch 0) ma il volume ha il marker volume-id $(json_field "$POST_MARKER" volume_id) epoch $(json_field "$POST_MARKER" epoch)"
fi

# Epoch che torna indietro rispetto a ciò che resta in piedi: segnalato a parte.
REGRESSION=""
if [ "$ONLY" = volume ] && [ "$CURRENT_STATE" != null ]; then
  cur="$(json_field "$CURRENT_STATE" epoch)"; new="$(json_field "$MANIFEST_MARKER" epoch)"
  if [ -n "$cur" ] && [ -n "$new" ] && [ "$new" -lt "$cur" ]; then REGRESSION="lo snapshot ha epoch $new, il database epoch $cur"; fi
fi
if [ "$ONLY" = db ] && [ "$MANIFEST_STATE" != null ]; then
  cur="$(json_field "$CURRENT_MARKER" epoch)"; new="$(json_field "$MANIFEST_STATE" epoch)"
  if [ -n "$cur" ] && [ -n "$new" ] && [ "$new" -lt "$cur" ]; then REGRESSION="il dump ha epoch $new, il volume epoch $cur"; fi
fi

# Marker attuale della destinazione (per il piano): un volume con un'altra
# identità rispetto al database si nota prima di sostituirlo.
TARGET_MARKER_TEXT=""
if [ "$RESTORE_VOLUME" = 1 ]; then
  tm_state="$(json_field "$CURRENT_MARKER" state)"
  if [ "$tm_state" = ok ]; then
    TARGET_MARKER_TEXT="volume-id $(json_field "$CURRENT_MARKER" volume_id) epoch $(json_field "$CURRENT_MARKER" epoch)"
    if [ "$CURRENT_STATE" != unreadable ]; then
      cur_check="$(python3 "$TOOL" identity --state "$CURRENT_STATE" --marker "$CURRENT_MARKER" 2>/dev/null || true)"
      if [ -n "$cur_check" ] && [ "$(json_field "$cur_check" status)" = mismatch ]; then
        TARGET_MARKER_TEXT="$TARGET_MARKER_TEXT, DIVERSO dal database corrente ($(json_field "$cur_check" detail))"
      fi
    fi
  else
    TARGET_MARKER_TEXT="${tm_state:-?} ($(json_field "$CURRENT_MARKER" detail))"
  fi
fi

# Riallineamento suggerito quando l'identità risultante non tornerà.
realign_hint() {
  cat <<'HINT'
Riallineamento dell'identità (in F1 lo strumento del wizard non c'è ancora, arriva in F3):
  - preferibile: ripristinare database e volume dallo stesso manifest (--only all),
    oppure un dump del database successivo all'inizializzazione del volume;
  - se il volume è davvero quello di questo stack e il database è in mode=postgres
    (Postgres autorevole), riallineare a mano lo stato al marker del volume:
      UPDATE calendar_backend_state SET volume_id = '<volume-id del marker>', epoch = <epoch del marker>
       WHERE id AND mode = 'postgres';
    poi controllare la policy (identità ok) prima di riaprire i device.
HINT
}

# ─── Servizi fermi ────────────────────────────────────────────

SERVICE_CHECK="non verificato (Docker o COMPOSE_PROJECT assenti): fermali a mano prima di confermare"
if [ -n "${COMPOSE_PROJECT:-}" ] && command -v docker >/dev/null 2>&1; then
  running=()
  check_service() {
    local ids
    ids="$(docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" --filter "label=com.docker.compose.service=$1")"
    [ -z "$ids" ] || running+=("$1")
  }
  [ "$RESTORE_VOLUME" = 1 ] && check_service radicale
  if [ "$RESTORE_DB" = 1 ]; then check_service api; check_service worker; fi
  if [ "${#running[@]}" -gt 0 ]; then
    die "servizi ancora in esecuzione: ${running[*]}. Sospendi l'aggiornamento automatico dello stack in Dockhand, poi: docker compose -p ${COMPOSE_PROJECT} stop ${running[*]}"
  fi
  SERVICE_CHECK="verificato: nessun servizio interessato in esecuzione"
fi

# ─── Piano ────────────────────────────────────────────────────

echo
echo "Ripristino del run $ID (creato $(mget created_at))"
echo "  sorgente:          $RUN_DIR"
echo "  da ripristinare:   $ONLY"
if [ "$RESTORE_DB" = 1 ]; then
  echo "  database:          dump del $(mget database.finished_at), ultima migrazione $(mget database.last_migration '?')"
  echo "                     → SOVRASCRIVE il database ${DB_NAME} ($DB_MODE${PG_CONTAINER:+ ${PG_CONTAINER}})"
  echo "                     stato nel dump: modalità $(json_field "$MANIFEST_STATE" mode), epoch $(json_field "$MANIFEST_STATE" epoch)"
fi
if [ "$RESTORE_VOLUME" = 1 ]; then
  echo "  volume:            snapshot del $(mget radicale.finished_at), $(mget radicale.inventory.items_total) item"
  echo "                     → SOSTITUISCE ${VOLUME_DIR}/collections (la corrente resta in collections.pre-restore-$TS)"
  echo "                     marker attuale della destinazione: ${TARGET_MARKER_TEXT}"
fi
echo "  identità dopo:     $IDENTITY — $IDENTITY_DETAIL"
[ -z "$REGRESSION" ] || echo "  epoch:             REGRESSIONE ($REGRESSION)"
echo "  servizi:           $SERVICE_CHECK"
echo "  dopo il ripristino: policy frozen (restore_guard 48 h, rebuild_required) fino alla verifica"
echo

IDENTITY_BLOCK=""
case "$IDENTITY" in
  ok|uninitialized|not_applicable) ;;
  *) IDENTITY_BLOCK="identità risultante $IDENTITY ($IDENTITY_DETAIL)" ;;
esac
# Un epoch che torna indietro blocca anche quando l'identità risultante
# sembrerebbe accettabile: il volume ha visto un'inizializzazione, un cutover o
# un rollback che il database ripristinato non conosce (o viceversa).
[ -z "$REGRESSION" ] || IDENTITY_BLOCK="${IDENTITY_BLOCK:+$IDENTITY_BLOCK; }epoch che torna indietro ($REGRESSION)"
if [ -n "$IDENTITY_BLOCK" ]; then
  realign_hint
  echo
  if [ "$ACCEPT_MISMATCH" = 1 ]; then
    warn "$IDENTITY_BLOCK: accettato con --accept-identity-mismatch, i device resteranno negati finché l'identità non viene riallineata"
  else
    die "$IDENTITY_BLOCK: ripristino rifiutato. Usa lo stesso manifest per DB e volume, oppure --accept-identity-mismatch se è voluto"
  fi
fi

if [ "$VERIFY_ONLY" = 1 ]; then
  log "solo verifica: run integro, nessuna modifica"
  exit 0
fi

PHRASE="RIPRISTINA $ID"
if [ -z "$CONFIRM" ]; then
  if [ -r /dev/tty ]; then
    printf 'Per confermare scrivi esattamente: %s\n> ' "$PHRASE" > /dev/tty
    read -r CONFIRM < /dev/tty || CONFIRM=""
  else
    die "nessun terminale per la conferma: passa --confirm \"$PHRASE\""
  fi
fi
if [ "$CONFIRM" != "$PHRASE" ]; then
  echo "Annullato (la conferma non coincide con \"$PHRASE\")." >&2
  exit 3
fi

# ─── Copie di sicurezza ───────────────────────────────────────

PRE_CRED=0
if [ "$CURRENT_STATE" != null ] && [ "$CURRENT_STATE" != unreadable ]; then
  PRE_CRED="$(json_field "$CURRENT_STATE" credential_epoch)"; PRE_CRED="${PRE_CRED:-0}"
fi
if [ "$RESTORE_DB" = 1 ] && [ "$SAFETY_DUMP" = 1 ]; then
  if [ "$CURRENT_STATE" = unreadable ]; then
    warn "database corrente non leggibile: nessun dump di sicurezza"
  else
    SAFE_DIR="$ROOT/pre-restore-$TS"
    mkdir "$SAFE_DIR"
    # Fallisce prima di qualsiasi modifica: senza copia di sicurezza non si procede.
    db_dump | gzip -6 > "$SAFE_DIR/caldes-db.sql.gz" \
      || die "dump di sicurezza fallito (nulla è stato modificato); usa --no-safety-dump solo se il database corrente non serve più"
    printf 'Dump di sicurezza del database %s prima del ripristino del run %s (%s).\n' "$DB_NAME" "$ID" "$TS" > "$SAFE_DIR/LEGGIMI.txt"
    log "dump di sicurezza: $SAFE_DIR/caldes-db.sql.gz"
  fi
fi
# ─── Database ─────────────────────────────────────────────────

if [ "$RESTORE_DB" = 1 ]; then
  log "ricreazione del database $DB_NAME"
  if ! psql_maint -v dbname="$DB_NAME" -v dbowner="$DB_USER" <<'SQL'
DROP DATABASE IF EXISTS :"dbname" WITH (FORCE);
CREATE DATABASE :"dbname" OWNER :"dbowner";
SQL
  then
    die "ricreazione del database fallita (serve un superutente o il proprietario con CREATEDB); dump di sicurezza: ${SAFE_DIR:-nessuno}"
  fi
  log "caricamento del dump"
  if ! gzip -dc "$RUN_DIR/caldes-db.sql.gz" | psql_app -o /dev/null; then
    die "caricamento del dump fallito: il database $DB_NAME è incompleto. Ripeti il ripristino dopo aver corretto la causa (dump di sicurezza: ${SAFE_DIR:-nessuno})"
  fi
  log "database ripristinato"
fi

# ─── Volume ───────────────────────────────────────────────────

if [ "$RESTORE_VOLUME" = 1 ]; then
  # La collections corrente si sposta solo ora, a database caricato: un
  # caricamento fallito non lascia mai il volume senza collections/.
  if [ -e "$VOLUME_DIR/collections" ]; then
    # Lock esclusivo di Radicale durante lo spostamento: se un processo lo usa
    # ancora, si attende la fine della sua operazione.
    if [ -f "$VOLUME_DIR/collections/.Radicale.lock" ]; then
      exec 9<"$VOLUME_DIR/collections/.Radicale.lock"
      flock -x -w 30 9 || die "il lock di Radicale è occupato: Radicale è davvero fermo?"
    fi
    mv -T "$VOLUME_DIR/collections" "$VOLUME_DIR/collections.pre-restore-$TS"
    ASIDE="$VOLUME_DIR/collections.pre-restore-$TS"
    # Senza redirezioni: `exec 9<&- 2>/dev/null` renderebbe permanente anche il
    # 2>/dev/null e ogni messaggio d'errore successivo sparirebbe.
    exec 9<&-
    log "collections corrente spostata in $ASIDE"
  fi
  log "estrazione del volume in $VOLUME_DIR"
  tar --extract --gzip --file "$RUN_DIR/radicale-collections.tar.gz" --directory "$VOLUME_DIR" \
      --numeric-owner --same-permissions \
    || die "estrazione del volume fallita (la collections precedente torna al suo posto: ${ASIDE:-nessuna})"
  owner_flag=""
  [ "$(id -u)" = 0 ] || owner_flag="--ignore-owner"
  ACTUAL="$(python3 "$TOOL" inventory-dir "$VOLUME_DIR" --principal "$RADICALE_PRINCIPAL")" \
    || die "inventario del volume ripristinato fallito (la collections precedente torna al suo posto: ${ASIDE:-nessuna})"
  if ! python3 "$TOOL" compare-inventory --expected "$(mget radicale.inventory)" --actual "$ACTUAL" $owner_flag > "$ROOT/.restore-compare-$TS.json"; then
    cat "$ROOT/.restore-compare-$TS.json" >&2
    die "il volume ripristinato non coincide con il manifest (la collections precedente torna al suo posto: ${ASIDE:-nessuna})"
  fi
  rm -f "$ROOT/.restore-compare-$TS.json"
  VOLUME_SWAPPED=1
  [ -n "$owner_flag" ] && warn "eseguito senza root: proprietari dei file non ripristinati né verificati"
  log "volume ripristinato e verificato ($(mget radicale.inventory.items_total) item)"
fi

# ─── Stato del backend dopo il ripristino ─────────────────────

if [ "$(db_query "SELECT to_regclass('public.calendar_backend_state') IS NOT NULL")" = "t" ]; then
  bump=0
  [ "$RESTORE_DB" = 1 ] && bump=1
  psql_app -v pre_cred="$PRE_CRED" -v bump="$bump" <<'SQL'
UPDATE calendar_backend_state
   SET restore_guard_until = now() + interval '48 hours',
       rebuild_required = true,
       credential_epoch = CASE WHEN :bump = 1 THEN GREATEST(credential_epoch, :pre_cred) + 1 ELSE credential_epoch END
 WHERE id;
SQL
  if [ "$bump" = 1 ]; then
    log "calendar_backend_state: restore_guard_until +48 h, rebuild_required = true, credential_epoch = max(${PRE_CRED}, ripristinato) + 1"
  else
    log "calendar_backend_state: restore_guard_until +48 h, rebuild_required = true"
  fi
  if [ "$RESTORE_DB" = 1 ] && [ "$(db_query "SELECT mode FROM calendar_backend_state WHERE id")" = postgres ] \
     && [ "$(db_query "SELECT to_regprocedure('public.calendar_sidecar_reconcile()') IS NOT NULL")" = "t" ]; then
    changes="$(db_query "SELECT count(*) FROM calendar_sidecar_reconcile()")"
    log "calendar_sidecar_reconcile(): ${changes} modifiche"
  fi
else
  log "calendar_backend_state assente (database precedente alla 162): nessuno stato da aggiornare"
fi

FINAL_STATE="$(backend_state_json)"
if [ -n "$VOLUME_DIR" ]; then
  FINAL_MARKER="$(python3 "$TOOL" marker-dir "$VOLUME_DIR" --principal "$RADICALE_PRINCIPAL")"
else
  FINAL_MARKER="$CURRENT_MARKER"
fi
FINAL="$(python3 "$TOOL" identity --state "$FINAL_STATE" --marker "$FINAL_MARKER")"
log "identità dopo il ripristino: $(json_field "$FINAL" status) — $(json_field "$FINAL" detail)"

cat <<EOF

Ripristino del run $ID completato. Passi successivi (apps/radicale/README.md, "Restore coordinato"):
  1. avvia i servizi (Dockhand: riprendi lo stack, oppure
     docker compose -p ${COMPOSE_PROJECT:-<progetto>} up -d): il servizio migrate
     applica le migrazioni più recenti del dump, l'API riscrive policy.json;
  2. controlla che la policy sia frozen con i motivi restore_guard e
     rebuild_required (docker exec <radicale> cat /control/policy.json);
  3. verifica il calendario dall'admin; poi, in F1, riapri con
     UPDATE calendar_backend_state SET restore_guard_until = NULL, rebuild_required = false WHERE id;
  4. elimina le copie di sicurezza quando non servono più:
     ${SAFE_DIR:-(nessun dump di sicurezza)}
     ${ASIDE:-(nessuna collections precedente)}
EOF
