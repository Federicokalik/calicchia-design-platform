#!/usr/bin/env bash
# Manutenzione del volume di Radicale — Calicchia Design Platform.
#
# Fase F3 del passaggio del calendario a Radicale (docs/calendar-radicale/
# piano.md, attività 6; contratto docs/calendar-radicale/contracts/
# f3-modules.md §12 e §14.1; design §16). Gira sull'host del VPS come root
# (legge i volumi Docker), con le convenzioni di scripts/backup-calendar-stack.sh.
#
# Regole:
#   - le uniche scritture nel volume di Radicale sono quelle di purge-cache e
#     compact-cache, solo dentro le cartelle .Radicale.cache e sotto il lock
#     ESCLUSIVO di Radicale (collections/.Radicale.lock, lo stesso flock che
#     Radicale prende per ogni richiesta: condiviso per le letture, esclusivo
#     per le scritture). Mentre le cache spariscono nessuna richiesta è in
#     corso; Radicale le ricostruisce alla prima lettura;
#   - il volume della Fase 0 (decisione 7) si legge soltanto: mai montato in
#     Radicale, mai scritto, mai cancellato;
#   - un volume si riconosce dal layout e dal marker d'identità (volume-id ed
#     epoch sul principal), mai dal solo nome: `identity` lo confronta con
#     calendar_backend_state.
#
# Uso:   ./scripts/radicale-maint.sh <sottocomando> [opzioni]
#
# Sottocomandi (report JSON su stdout, log e riepilogo su stderr):
#   status            marker d'identità, collezioni, item, dimensioni, cache,
#                     lock di Radicale e filesystem del volume (sola lettura)
#   du                dimensione e item per collezione, avviso oltre 5000 item
#   verify            verifica strutturale del volume (sola lettura): layout,
#                     marker, proprietà delle collezioni, item iCalendar (UTF-8,
#                     BEGIN/END, un solo UID, UID duplicati, dimensione), link
#                     simbolici, temporanei rimasti, proprietari. Exit 1 con errori
#   identity          marker volume-id/epoch del volume contro
#                     calendar_backend_state (serve il database). Exit 1 se
#                     l'identità non è utilizzabile (mismatch, marker illeggibile,
#                     database non inizializzato con un marker già sul volume)
#   snapshot [--label TESTO] [--no-upload]
#                     snapshot prima della migrazione: backup coordinato COMPLETO
#                     (backup-calendar-stack.sh: dump del database e tar del volume
#                     nello stesso run, last_stack_backup registrato per il
#                     controllo BACKUP_RECENT del preflight) e copia conservata in
#                     $BACKUP_DIR/calendar-stack/pinned/<id>[-<label>], fuori dalla
#                     retention locale (la copia su S4 segue la retention normale),
#                     ripristinabile con restore-calendar-stack.sh <cartella>
#   purge-cache [--dry-run]
#                     rimuove le cartelle .Radicale.cache sotto il lock esclusivo:
#                     seguito dell'erasure GDPR (la cache degli item contiene il
#                     testo degli eventi). I sync-token ripartono: device e API
#                     rifanno una sincronizzazione completa
#   compact-cache [--dry-run]
#                     compattazione della cache: rimuove le voci della cache degli
#                     item i cui item non esistono più, sotto il lock esclusivo,
#                     senza invalidare i sync-token
#   phase0-detect     cerca il volume della Fase 0 e ne riassume il contenuto
#   phase0-backup [--out DIR]
#                     tar.gz in sola lettura del volume della Fase 0, con sha256 e
#                     manifest (default $BACKUP_DIR/phase0/)
#   phase0-export [--out FILE] [--from TAR]
#                     archivio-fase0.zip da caricare nel wizard (passo 1): un'entry
#                     <collezione>__<item>.ics per item e manifest.json, al più
#                     20 MiB e 20000 item (limiti del wizard). Con --from legge il
#                     tar.gz di phase0-backup invece del volume
#                     (default $BACKUP_DIR/phase0/archivio-fase0.zip)
#
# Configurazione (env):
#   Volume di Radicale, in ordine di precedenza (come backup-calendar-stack.sh):
#     RADICALE_VOLUME_DIR  cartella del volume sull'host (quella che Radicale vede come /data)
#     RADICALE_VOLUME      nome del volume Docker (es. <progetto>_radicale_collections)
#     COMPOSE_PROJECT      → volume <progetto>_radicale_collections
#   Volume della Fase 0, in ordine di precedenza:
#     PHASE0_VOLUME_DIR    cartella del volume (prove, installazioni senza Docker)
#     PHASE0_VOLUME        nome del volume Docker
#     COMPOSE_PROJECT      → <progetto>_radicale_data, poi radicale_data
#   Database (solo identity e snapshot), come backup-calendar-stack.sh:
#     PG_CONTAINER, COMPOSE_PROJECT o DATABASE_URL; DB_USER e DB_NAME (default caldes)
#   RADICALE_PRINCIPAL  default federico
#   LOCK_TIMEOUT        secondi di attesa del lock di Radicale, default 120
#   BACKUP_DIR          default ./backups
#   TMP_AGE_HOURS       età oltre la quale un temporaneo di Radicale è considerato
#                       rimasto da una scrittura interrotta (verify), default 1
#
# Esempi sul VPS (cartella del repository, variabili del backup):
#   set -a && . /root/.caldes-backup.env && set +a
#   ./scripts/radicale-maint.sh status
#   ./scripts/radicale-maint.sh purge-cache            # dopo un'erasure GDPR
#   ./scripts/radicale-maint.sh snapshot --label pre-migrazione
#   ./scripts/radicale-maint.sh phase0-detect && ./scripts/radicale-maint.sh phase0-backup \
#     && ./scripts/radicale-maint.sh phase0-export
#
# Exit: 0 ok, 1 errore (o verifica e identità non superate), 2 uso errato,
# 3 volume della Fase 0 assente (phase0-*), 75 lock occupato (lock di Radicale
# non ottenuto in LOCK_TIMEOUT, oppure un altro backup in corso per snapshot).
set -Eeuo pipefail

SCRIPT_NAME="radicale-maint"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/radicale_maint.py"
STACK_TOOL="${SCRIPT_DIR}/calendar_stack.py"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-calendar-stack.sh"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_ms() { date +%s%3N; }
# Log su stderr: lo stdout resta il solo report JSON.
log() { printf '%s [%s] %s\n' "$(now_iso)" "$SCRIPT_NAME" "$*" >&2; }
warn() { printf '%s [%s] ATTENZIONE: %s\n' "$(now_iso)" "$SCRIPT_NAME" "$*" >&2; }
die() { printf '%s [%s] ERRORE: %s\n' "$(now_iso)" "$SCRIPT_NAME" "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -Eeuo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }
bad_usage() { echo "$* (vedi --help)" >&2; exit 2; }

# ─── Argomenti ────────────────────────────────────────────────

[ "$#" -ge 1 ] || { usage >&2; exit 2; }
CMD="$1"
shift
case "$CMD" in
  -h|--help|help) usage; exit 0 ;;
  status|du|verify|identity|snapshot|purge-cache|compact-cache|phase0-detect|phase0-backup|phase0-export) ;;
  *) bad_usage "Sottocomando sconosciuto: $CMD" ;;
esac

OPT_DRY_RUN=0
OPT_OUT=""
OPT_FROM=""
OPT_LABEL=""
OPT_NO_UPLOAD=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run)
      case "$CMD" in purge-cache|compact-cache) OPT_DRY_RUN=1 ;; *) bad_usage "--dry-run vale solo per purge-cache e compact-cache" ;; esac ;;
    --out)
      case "$CMD" in phase0-backup|phase0-export) ;; *) bad_usage "--out vale solo per phase0-backup e phase0-export" ;; esac
      [ "$#" -ge 2 ] && [ -n "$2" ] || bad_usage "--out richiede un percorso"
      OPT_OUT="$2"; shift ;;
    --from)
      [ "$CMD" = phase0-export ] || bad_usage "--from vale solo per phase0-export"
      [ "$#" -ge 2 ] && [ -n "$2" ] || bad_usage "--from richiede il tar.gz di phase0-backup"
      OPT_FROM="$2"; shift ;;
    --label)
      [ "$CMD" = snapshot ] || bad_usage "--label vale solo per snapshot"
      [ "$#" -ge 2 ] || bad_usage "--label richiede un testo"
      [[ "$2" =~ ^[a-z0-9][a-z0-9._-]{0,39}$ ]] || bad_usage "--label: minuscole, cifre, punto, trattino o trattino basso, al più 40 caratteri"
      OPT_LABEL="$2"; shift ;;
    --no-upload)
      [ "$CMD" = snapshot ] || bad_usage "--no-upload vale solo per snapshot"
      OPT_NO_UPLOAD=1 ;;
    *) bad_usage "Opzione sconosciuta per $CMD: $1" ;;
  esac
  shift
done

LOCK_TIMEOUT="${LOCK_TIMEOUT:-120}"
RADICALE_PRINCIPAL="${RADICALE_PRINCIPAL:-federico}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
TMP_AGE_HOURS="${TMP_AGE_HOURS:-1}"
DB_USER="${DB_USER:-caldes}"
DB_NAME="${DB_NAME:-caldes}"
[[ "$LOCK_TIMEOUT" =~ ^[0-9]+$ ]] || die "LOCK_TIMEOUT deve essere un intero ≥ 0: $LOCK_TIMEOUT"
[[ "$TMP_AGE_HOURS" =~ ^[0-9]+$ ]] || die "TMP_AGE_HOURS deve essere un intero ≥ 0: $TMP_AGE_HOURS"
[[ "$RADICALE_PRINCIPAL" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] && [ "${RADICALE_PRINCIPAL#caldes-}" = "$RADICALE_PRINCIPAL" ] \
  || die "RADICALE_PRINCIPAL non valido: $RADICALE_PRINCIPAL"

need() { command -v "$1" >/dev/null 2>&1 || die "comando richiesto non trovato: $1${2:+ ($2)}"; }
need python3 "per i report e l'archivio della Fase 0"
[ -f "$HELPER" ] || die "helper assente: $HELPER"
[ -f "$STACK_TOOL" ] || die "helper assente: $STACK_TOOL"

# Backup, archivi e report possono contenere dati personali: file 0600, cartelle 0700.
umask 077

# ─── Volume di Radicale ───────────────────────────────────────

VOLUME_DIR=""
VOLUME_SOURCE=""
# Mountpoint di un volume Docker, vuoto se il volume non esiste.
docker_mountpoint() { docker volume inspect --format '{{ .Mountpoint }}' "$1" 2>/dev/null || true; }
is_phase0_name() { case "$1" in radicale_data|*_radicale_data) return 0 ;; *) return 1 ;; esac; }

resolve_volume() {
  if [ -n "${RADICALE_VOLUME_DIR:-}" ]; then
    VOLUME_DIR="$RADICALE_VOLUME_DIR"
    VOLUME_SOURCE="dir:${RADICALE_VOLUME_DIR}"
  elif [ -n "${RADICALE_VOLUME:-}" ] || [ -n "${COMPOSE_PROJECT:-}" ]; then
    need docker
    local vol="${RADICALE_VOLUME:-${COMPOSE_PROJECT}_radicale_collections}"
    is_phase0_name "$vol" && die "$vol è il volume della Fase 0, non quello di Radicale (<progetto>_radicale_collections): mai usarlo al suo posto"
    VOLUME_DIR="$(docker_mountpoint "$vol")"
    [ -n "$VOLUME_DIR" ] || die "volume Docker $vol non trovato"
    VOLUME_SOURCE="volume:${vol}"
  else
    die "volume di Radicale non configurato: imposta RADICALE_VOLUME_DIR, RADICALE_VOLUME o COMPOSE_PROJECT"
  fi
  [ -d "$VOLUME_DIR" ] || die "cartella del volume assente o non leggibile: $VOLUME_DIR"
  [ ! -L "$VOLUME_DIR/collections" ] || die "$VOLUME_DIR/collections è un link simbolico: rifiutato"
  [ -d "$VOLUME_DIR/collections" ] || die "nel volume $VOLUME_DIR manca collections/ (Radicale non è mai partito su questo volume, o è il percorso sbagliato)"
  if [ -n "${PHASE0_VOLUME_DIR:-}" ] && [ -d "$PHASE0_VOLUME_DIR" ] \
      && [ "$(readlink -f "$PHASE0_VOLUME_DIR")" = "$(readlink -f "$VOLUME_DIR")" ]; then
    die "RADICALE_VOLUME_DIR e PHASE0_VOLUME_DIR sono la stessa cartella: il volume della Fase 0 non è il volume di Radicale"
  fi
}

# ─── Lock di Radicale ─────────────────────────────────────────

RADICALE_LOCKED=0
LOCK_WAITED_MS=0
# $1: -s (condiviso: le scritture attendono, le letture no) o -x (esclusivo:
# nessuna richiesta di Radicale in corso). Exit 75 se non arriva in LOCK_TIMEOUT.
lock_radicale() {
  need flock "util-linux"
  local lockfile="$VOLUME_DIR/collections/.Radicale.lock"
  local created
  created="$(python3 "$HELPER" ensure-lock "$VOLUME_DIR")" || die "lock di Radicale non utilizzabile: $lockfile"
  case "$created" in *'"created": true'*) warn "creato $lockfile (Radicale non aveva ancora servito richieste su questo volume)" ;; esac
  # In sola lettura: flock non richiede la scrittura e così il file non si tronca mai.
  exec 9<"$lockfile"
  RADICALE_LOCKED=1
  local t0
  t0="$(now_ms)"
  if ! flock "$1" -w "$LOCK_TIMEOUT" 9; then
    exec 9<&-
    RADICALE_LOCKED=0
    printf '%s [%s] lock di Radicale non ottenuto in %s s (%s): una scrittura lunga o un backup in corso, riprova\n' \
      "$(now_iso)" "$SCRIPT_NAME" "$LOCK_TIMEOUT" "$lockfile" >&2
    exit 75
  fi
  LOCK_WAITED_MS=$(( $(now_ms) - t0 ))
}
unlock_radicale() {
  if [ "$RADICALE_LOCKED" = 1 ]; then
    flock -u 9 2>/dev/null || true
    exec 9<&- || true
    RADICALE_LOCKED=0
  fi
}

PARTIALS=()
cleanup() {
  local code=$?
  unlock_radicale
  local p
  for p in "${PARTIALS[@]}"; do
    [ -n "$p" ] && [ -e "$p" ] && rm -rf -- "$p"
  done
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ─── Database (identity, snapshot) ────────────────────────────

DB_MODE=""
resolve_db() {
  if [ -n "${PG_CONTAINER:-}" ]; then
    need docker
    DB_MODE=docker
  elif [ -n "${COMPOSE_PROJECT:-}" ]; then
    need docker
    PG_CONTAINER="$(docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" --filter "label=com.docker.compose.service=postgres" | head -n1)"
    [ -n "$PG_CONTAINER" ] || die "container postgres del progetto ${COMPOSE_PROJECT} non trovato (è in esecuzione?)"
    DB_MODE=docker
  elif [ -n "${DATABASE_URL:-}" ]; then
    need psql "pacchetto postgresql-client"
    DB_MODE=url
  else
    die "nessun database configurato: imposta PG_CONTAINER, COMPOSE_PROJECT o DATABASE_URL"
  fi
}
db_query() {
  if [ "$DB_MODE" = docker ]; then
    docker exec "$PG_CONTAINER" psql -X -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "$1"
  else
    psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "$1"
  fi
}
backend_state_json() {
  local exists
  exists="$(db_query "SELECT to_regclass('public.calendar_backend_state') IS NOT NULL")" || die "database non raggiungibile"
  if [ "$exists" = "t" ]; then
    db_query "SELECT row_to_json(s) FROM (SELECT mode, write_freeze, volume_id, epoch, credential_epoch, policy_version, restore_guard_until, rebuild_required, updated_at FROM calendar_backend_state WHERE id) s"
  else
    echo "null"
  fi
}

# ─── Volume della Fase 0 ──────────────────────────────────────

P0_DIR=""
P0_SOURCE=""
P0_NAME=""
P0_MOUNTED_BY=""
phase0_absent() {
  log "volume della Fase 0 assente: $1"
  log "nel wizard (passo 1) dichiara phase0 = absent"
  python3 -c 'import json,sys; print(json.dumps({"present": False, "detail": sys.argv[1]}, ensure_ascii=False))' "$1"
  exit 3
}
resolve_phase0() {
  if [ -n "${PHASE0_VOLUME_DIR:-}" ]; then
    [ -d "$PHASE0_VOLUME_DIR" ] || phase0_absent "cartella PHASE0_VOLUME_DIR inesistente: $PHASE0_VOLUME_DIR"
    P0_DIR="$PHASE0_VOLUME_DIR"
    P0_SOURCE="dir:${PHASE0_VOLUME_DIR}"
  else
    local candidates=()
    if [ -n "${PHASE0_VOLUME:-}" ]; then
      candidates=("$PHASE0_VOLUME")
    else
      [ -n "${COMPOSE_PROJECT:-}" ] && candidates+=("${COMPOSE_PROJECT}_radicale_data")
      candidates+=("radicale_data")
    fi
    command -v docker >/dev/null 2>&1 || die "docker non disponibile: imposta PHASE0_VOLUME_DIR con la cartella del volume della Fase 0"
    local name mp
    for name in "${candidates[@]}"; do
      case "$name" in *radicale_collections) die "$name è il volume nuovo di Radicale, non quello della Fase 0" ;; esac
      mp="$(docker_mountpoint "$name")"
      if [ -n "$mp" ]; then
        P0_DIR="$mp"
        P0_NAME="$name"
        P0_SOURCE="volume:${name}"
        break
      fi
    done
    [ -n "$P0_DIR" ] || phase0_absent "nessun volume Docker fra: ${candidates[*]}"
    [ -d "$P0_DIR" ] || die "Mountpoint $P0_DIR del volume $P0_NAME non leggibile (serve root)"
    P0_MOUNTED_BY="$(docker ps -a --filter "volume=${P0_NAME}" --format '{{.Names}}' 2>/dev/null | paste -sd, - || true)"
    if [ -n "$P0_MOUNTED_BY" ]; then
      warn "il volume $P0_NAME è montato da: ${P0_MOUNTED_BY}. Non va mai montato in Radicale (decisione 7): toglilo dal compose; qui lo si legge soltanto"
    fi
  fi
  # Mai il volume corrente di Radicale (stessa cartella).
  local main=""
  if [ -n "${RADICALE_VOLUME_DIR:-}" ]; then
    main="$RADICALE_VOLUME_DIR"
  elif { [ -n "${RADICALE_VOLUME:-}" ] || [ -n "${COMPOSE_PROJECT:-}" ]; } && command -v docker >/dev/null 2>&1; then
    main="$(docker_mountpoint "${RADICALE_VOLUME:-${COMPOSE_PROJECT}_radicale_collections}")"
  fi
  if [ -n "$main" ] && [ -d "$main" ] && [ "$(readlink -f "$main")" = "$(readlink -f "$P0_DIR")" ]; then
    die "il volume della Fase 0 ($P0_SOURCE) coincide con il volume di Radicale: rifiutato"
  fi
}

# ─── Sottocomandi ─────────────────────────────────────────────

cmd_status() {
  resolve_volume
  local fs
  fs="$(stat -f -c '%T' "$VOLUME_DIR" 2>/dev/null || echo sconosciuto)"
  log "volume ${VOLUME_SOURCE}"
  python3 "$HELPER" scan "$VOLUME_DIR" --principal "$RADICALE_PRINCIPAL" --fs-type "$fs" --human
}

cmd_du() {
  resolve_volume
  python3 "$HELPER" du "$VOLUME_DIR" --principal "$RADICALE_PRINCIPAL" --human
}

cmd_verify() {
  resolve_volume
  log "verifica di ${VOLUME_SOURCE} (sola lettura, senza lock: Radicale scrive con temporaneo + rename)"
  local rc=0
  python3 "$HELPER" verify "$VOLUME_DIR" --principal "$RADICALE_PRINCIPAL" --tmp-age-hours "$TMP_AGE_HOURS" --human || rc=$?
  [ "$rc" -le 1 ] || die "verifica non eseguita (exit $rc)"
  if [ "$rc" -ne 0 ]; then
    printf '%s [%s] ERRORE: verifica non superata: errori nel report\n' "$(now_iso)" "$SCRIPT_NAME" >&2
    exit 1
  fi
  log "verifica superata"
}

cmd_identity() {
  resolve_volume
  resolve_db
  local state rc=0
  state="$(backend_state_json)" || die "stato del backend non leggibile"
  python3 "$HELPER" identity "$VOLUME_DIR" --state "$state" --principal "$RADICALE_PRINCIPAL" --human || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s [%s] ERRORE: identità del volume non utilizzabile: nessuna scrittura né migrazione finché non è riallineata dal wizard (riassegnazione confermata)\n' "$(now_iso)" "$SCRIPT_NAME" >&2
    exit 1
  fi
}

cmd_cache() {
  # $1: purge-cache | compact-cache
  resolve_volume
  local args=("$1" "$VOLUME_DIR")
  [ "$OPT_DRY_RUN" = 1 ] && args+=(--dry-run)
  local label="pulizia"
  [ "$1" = compact-cache ] && label="compattazione"
  if [ "$OPT_DRY_RUN" = 1 ]; then
    # Prova a vuoto: basta il lock condiviso (elenco coerente, nessuna scrittura).
    lock_radicale -s
  else
    lock_radicale -x
  fi
  local t0 rc=0 out
  t0="$(now_ms)"
  out="$(python3 "$HELPER" "${args[@]}")" || rc=$?
  unlock_radicale
  printf '%s\n' "$out"
  local summary
  summary="$(printf '%s' "$out" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
n = len(d.get("removed", [])) if isinstance(d.get("removed"), list) else d.get("removed", 0)
print("%s voci, %d byte%s" % (n, d.get("bytes", 0), ", %d non rimosse" % len(d["failed"]) if d.get("failed") else ""))' 2>/dev/null || true)"
  if [ "$rc" -ne 0 ]; then
    die "$label della cache non completata (${summary:-exit $rc}): ripeti il comando"
  fi
  local mode_note="lock esclusivo"
  [ "$OPT_DRY_RUN" = 1 ] && mode_note="prova a vuoto, lock condiviso"
  log "$label della cache di ${VOLUME_SOURCE}: ${summary:-fatto} (${mode_note} tenuto $(( $(now_ms) - t0 )) ms dopo un'attesa di ${LOCK_WAITED_MS} ms)"
  if [ "$1" = purge-cache ] && [ "$OPT_DRY_RUN" = 0 ]; then
    log "Radicale ricostruisce la cache alla prima lettura; i device e l'API rifaranno una sincronizzazione completa delle collezioni"
  fi
}

cmd_snapshot() {
  [ -f "$BACKUP_SCRIPT" ] || die "script di backup assente: $BACKUP_SCRIPT"
  local root="${BACKUP_DIR%/}/calendar-stack"
  local before=() id
  if [ -d "$root" ]; then
    mapfile -t before < <(find "$root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort || true)
  fi
  local args=()
  [ "$OPT_NO_UPLOAD" = 1 ] && args+=(--no-upload)
  log "snapshot prima della migrazione: backup coordinato di database e volume (backup-calendar-stack.sh)"
  local rc=0
  # Il volume è obbligatorio: senza, lo snapshot non serve a tornare indietro.
  RADICALE_BACKUP=required BACKUP_DIR="$BACKUP_DIR" bash "$BACKUP_SCRIPT" "${args[@]}" >&2 || rc=$?
  case "$rc" in
    0) ;;
    75) printf '%s [%s] un altro backup è in corso: riprova quando ha finito\n' "$(now_iso)" "$SCRIPT_NAME" >&2; exit 75 ;;
    3) die "backup INCOMPLETO (salvato solo il database): lo snapshot prima della migrazione richiede anche il volume di Radicale" ;;
    *) die "backup coordinato fallito (exit $rc)" ;;
  esac
  # Il run nuovo è il più recente fra quelli che prima non c'erano.
  id=""
  local candidate old seen
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    seen=0
    for old in "${before[@]}"; do [ "$old" = "$candidate" ] && seen=1 && break; done
    [ "$seen" = 1 ] || id="$candidate"
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort)
  [ -n "$id" ] || die "nessun run nuovo in $root dopo il backup"
  local manifest="$root/$id/manifest.json"
  [ "$(python3 "$STACK_TOOL" get --file "$manifest" --path complete --default true)" = "true" ] \
    || die "il run $id è incompleto: lo snapshot richiede database e volume"
  [ -n "$(python3 "$STACK_TOOL" get --file "$manifest" --path radicale.file --default '')" ] \
    || die "il run $id non contiene il volume di Radicale"
  local pin_root="$root/pinned"
  local name="$id${OPT_LABEL:+-$OPT_LABEL}"
  local pin="$pin_root/$name"
  mkdir -p "$pin_root"
  [ ! -e "$pin" ] || die "esiste già $pin"
  local partial="$pin_root/.partial-$name"
  PARTIALS+=("$partial")
  # Hard link (nessuna copia dei dati, file immutabili); copia vera se il filesystem non li ammette.
  cp -al -- "$root/$id" "$partial" 2>/dev/null || { rm -rf -- "$partial"; cp -a -- "$root/$id" "$partial"; }
  python3 "$STACK_TOOL" verify --dir "$partial" >/dev/null || die "verifica della copia conservata fallita"
  mv -T -- "$partial" "$pin"
  local identity sha
  identity="$(python3 "$STACK_TOOL" get --file "$pin/manifest.json" --path consistency.identity --default '')"
  sha="$(sha256sum "$pin/manifest.json" | cut -d' ' -f1)"
  log "snapshot $id conservato in $pin (identità DB ↔ volume: ${identity:-?}); ripristino: scripts/restore-calendar-stack.sh $pin"
  case "$identity" in
    mismatch|unverified) warn "identità del volume e stato del DB non coincidono ($identity): risolvila prima di migrare (radicale-maint.sh identity)" ;;
  esac
  python3 -c 'import json,sys; print(json.dumps({"id": sys.argv[1], "pinned_dir": sys.argv[2], "identity": sys.argv[3] or None, "complete": True, "manifest_sha256": sys.argv[4], "restore": "scripts/restore-calendar-stack.sh --verify-only " + sys.argv[2]}, ensure_ascii=False, indent=2))' \
    "$id" "$pin" "$identity" "$sha"
}

cmd_phase0_detect() {
  resolve_phase0
  python3 "$HELPER" phase0-scan "$P0_DIR" --source "$P0_SOURCE" --mounted-by "$P0_MOUNTED_BY" --human
  log "prossimi passi: phase0-backup (tar in sola lettura), phase0-export (zip per il wizard), poi caricamento nel passo 1 del wizard"
}

default_phase0_dir() {
  local dir="${BACKUP_DIR%/}/phase0"
  mkdir -p "$dir"
  # Dati personali: se BACKUP_DIR sta dentro un checkout del repository, git li ignora.
  [ -e "$dir/.gitignore" ] || printf '*\n' > "$dir/.gitignore"
  printf '%s' "$dir"
}

cmd_phase0_backup() {
  resolve_phase0
  need tar
  need gzip
  need sha256sum
  local out_dir
  if [ -n "$OPT_OUT" ]; then
    out_dir="$OPT_OUT"
    mkdir -p "$out_dir"
  else
    out_dir="$(default_phase0_dir)"
  fi
  local ts base archive partial manifest_partial
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  base="radicale_data-fase0-$ts"
  while [ -e "$out_dir/$base.tar.gz" ]; do sleep 1; ts="$(date -u +%Y%m%dT%H%M%SZ)"; base="radicale_data-fase0-$ts"; done
  archive="$out_dir/$base.tar.gz"
  partial="$out_dir/.partial-$base.tar.gz"
  manifest_partial="$out_dir/.partial-$base.manifest.json"
  PARTIALS+=("$partial" "$manifest_partial")
  log "tar in sola lettura di ${P0_SOURCE} → $archive"
  # Copia integrale del volume (cache comprese): è l'archivio della decisione 7.
  tar --create --gzip --file "$partial" --directory "$P0_DIR" --numeric-owner --sort=name . \
    || die "tar del volume della Fase 0 fallito"
  gzip -t "$partial" || die "gzip del tar non integro"
  python3 "$HELPER" phase0-manifest --archive "$partial" --name "$base.tar.gz" --source "$P0_SOURCE" --out "$manifest_partial" >/dev/null \
    || die "manifest del tar non scritto"
  mv -T -- "$partial" "$archive"
  mv -T -- "$manifest_partial" "$out_dir/$base.manifest.json"
  (cd "$out_dir" && sha256sum "$base.tar.gz" > "$base.tar.gz.sha256")
  local expected actual
  expected="$(python3 "$STACK_TOOL" get --file "$out_dir/$base.manifest.json" --path archive.sha256)"
  actual="$(cut -d' ' -f1 < "$out_dir/$base.tar.gz.sha256")"
  [ "$expected" = "$actual" ] || die "sha256 del tar diverso da quello del manifest"
  log "fatto: $archive ($(du -h "$archive" | cut -f1), $(python3 "$STACK_TOOL" get --file "$out_dir/$base.manifest.json" --path items) item .ics); il volume non è stato toccato"
  python3 -c 'import json,sys; print(json.dumps({"archive": sys.argv[1], "sha256": sys.argv[2], "manifest": sys.argv[3], "source": sys.argv[4]}, ensure_ascii=False, indent=2))' \
    "$archive" "$actual" "$out_dir/$base.manifest.json" "$P0_SOURCE"
}

cmd_phase0_export() {
  local src_args=()
  if [ -n "$OPT_FROM" ]; then
    [ -f "$OPT_FROM" ] || die "archivio di phase0-backup non trovato: $OPT_FROM"
    if [ -f "$OPT_FROM.sha256" ]; then
      need sha256sum
      local want got
      want="$(cut -d' ' -f1 < "$OPT_FROM.sha256")"
      got="$(sha256sum "$OPT_FROM" | cut -d' ' -f1)"
      [ "$want" = "$got" ] || die "sha256 di $OPT_FROM diverso da $OPT_FROM.sha256: archivio alterato o incompleto"
    else
      warn "nessun $OPT_FROM.sha256 accanto all'archivio: integrità non verificata"
    fi
    src_args=(--tar "$OPT_FROM" --source "tar:$(basename "$OPT_FROM")")
  else
    resolve_phase0
    src_args=(--dir "$P0_DIR" --source "$P0_SOURCE")
  fi
  local out
  if [ -n "$OPT_OUT" ]; then
    out="$OPT_OUT"
    [ -d "$(dirname "$out")" ] || mkdir -p "$(dirname "$out")"
  else
    out="$(default_phase0_dir)/archivio-fase0.zip"
  fi
  case "$out" in *.zip) ;; *) bad_usage "--out deve terminare con .zip" ;; esac
  local result
  result="$(python3 "$HELPER" phase0-export --out "$out" "${src_args[@]}")" || die "export dell'archivio della Fase 0 non riuscito"
  printf '%s\n' "$result"
  log "fatto: $out ($(printf '%s' "$result" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("%d item, %d byte, %d scartati" % (d["items"], d["bytes"], len(d["skipped"])))'))"
  log "caricalo nel wizard: Calendario → Migrazione, passo 1, \"Archivio della Fase 0\""
}

case "$CMD" in
  status) cmd_status ;;
  du) cmd_du ;;
  verify) cmd_verify ;;
  identity) cmd_identity ;;
  snapshot) cmd_snapshot ;;
  purge-cache|compact-cache) cmd_cache "$CMD" ;;
  phase0-detect) cmd_phase0_detect ;;
  phase0-backup) cmd_phase0_backup ;;
  phase0-export) cmd_phase0_export ;;
esac
