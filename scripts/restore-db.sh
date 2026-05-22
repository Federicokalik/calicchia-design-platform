#!/usr/bin/env bash
# Restore del database Postgres — Calicchia Design Platform.
#
# Uso:   ./scripts/restore-db.sh <file.sql.gz>
#        ./scripts/restore-db.sh s3://<bucket>/db/caldes-YYYYMMDD-HHMMSS.sql.gz
# Legge DATABASE_URL dall'ambiente. Richiede `psql` (postgresql-client).
# Per il restore da S4 serve anche la AWS CLI e le env S4_*.
#
# ATTENZIONE: operazione distruttiva — sovrascrive i dati del database target.
# Eseguire SEMPRE un backup fresco prima del restore.
set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ]; then
  echo "Uso: ./scripts/restore-db.sh <file.sql.gz | s3://bucket/path.sql.gz>" >&2
  exit 1
fi

# Se il file è un URI s3://, scaricalo da MEGA S4 in un file temporaneo.
if [ "${FILE#s3://}" != "$FILE" ]; then
  if [ -z "${S4_ENDPOINT:-}" ]; then
    echo "ERRORE: S4_ENDPOINT non impostata (necessaria per scaricare da s3://)." >&2
    exit 1
  fi
  export AWS_ACCESS_KEY_ID="${S4_ACCESS_KEY_ID:-}"
  export AWS_SECRET_ACCESS_KEY="${S4_SECRET_ACCESS_KEY:-}"
  export AWS_DEFAULT_REGION="${S4_REGION:-auto}"
  TMP="$(mktemp -t caldes-restore-XXXXXX.sql.gz)"
  trap 'rm -f "$TMP"' EXIT
  echo "[restore] download da ${FILE} ..."
  aws s3 cp "$FILE" "$TMP" --endpoint-url "$S4_ENDPOINT"
  FILE="$TMP"
fi

if [ ! -f "$FILE" ]; then
  echo "ERRORE: file non trovato: $FILE" >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERRORE: DATABASE_URL non impostata." >&2
  exit 1
fi

echo "ATTENZIONE: il database target verrà SOVRASCRITTO con il contenuto di:"
echo "  $FILE"
printf "Scrivi 'RESTORE' per confermare: "
read -r CONFIRM
if [ "$CONFIRM" != "RESTORE" ]; then
  echo "Annullato."
  exit 1
fi

echo "[restore] ripristino in corso…"
gunzip -c "$FILE" | psql --set ON_ERROR_STOP=on "$DATABASE_URL"
echo "[restore] completato da $FILE"
