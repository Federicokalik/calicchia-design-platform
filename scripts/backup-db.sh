#!/usr/bin/env bash
# Backup del database Postgres — Calicchia Design Platform.
#
# Uso:   ./scripts/backup-db.sh
# Legge DATABASE_URL dall'ambiente (o da un .env passato via `set -a; . .env; set +a`).
# Richiede `pg_dump` (pacchetto postgresql-client) sulla macchina che lo esegue.
#
# Cron consigliato sul VPS (backup giornaliero alle 03:00):
#   0 3 * * * cd /path/al/repo && DATABASE_URL=... ./scripts/backup-db.sh >> /var/log/caldes-backup.log 2>&1
#
# In alternativa, dentro la rete Docker:
#   docker exec <postgres-container> pg_dump -U <user> <db> | gzip > backup.sql.gz
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERRORE: DATABASE_URL non impostata." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
OUT="${BACKUP_DIR}/caldes-${TIMESTAMP}.sql.gz"

echo "[backup] dump in corso → ${OUT}"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$OUT"
echo "[backup] completato: ${OUT} ($(du -h "$OUT" | cut -f1))"

# Retention: elimina i backup più vecchi di RETENTION_DAYS giorni.
DELETED="$(find "$BACKUP_DIR" -name 'caldes-*.sql.gz' -type f -mtime +"${RETENTION_DAYS}" -print -delete | wc -l)"
echo "[backup] retention: rimossi ${DELETED} backup oltre i ${RETENTION_DAYS} giorni"

# --- Copia off-site su MEGA S4 (object storage S3-compatible) ---------
# Richiede la AWS CLI sull'host. Configurato via le env S4_* (.env.prod.example).
# Senza questa copia il backup vive solo sul VPS: se il VPS muore, muore con lui.
if [ -n "${S4_BUCKET:-}" ] && [ -n "${S4_ENDPOINT:-}" ]; then
  export AWS_ACCESS_KEY_ID="${S4_ACCESS_KEY_ID:-}"
  export AWS_SECRET_ACCESS_KEY="${S4_SECRET_ACCESS_KEY:-}"
  export AWS_DEFAULT_REGION="${S4_REGION:-auto}"

  echo "[backup] upload dump → s3://${S4_BUCKET}/db/"
  aws s3 cp "$OUT" "s3://${S4_BUCKET}/db/" --endpoint-url "$S4_ENDPOINT"

  # Backup delle immagini/upload, se la dir è accessibile da questo host
  # (vedi DEPLOY.md per il caso volume Docker).
  if [ -n "${UPLOAD_DIR:-}" ] && [ -d "${UPLOAD_DIR}" ]; then
    echo "[backup] sync immagini ${UPLOAD_DIR} → s3://${S4_BUCKET}/uploads/"
    aws s3 sync "${UPLOAD_DIR}" "s3://${S4_BUCKET}/uploads/" --endpoint-url "$S4_ENDPOINT"
  else
    echo "[backup] UPLOAD_DIR non impostata o non accessibile — sync immagini saltato"
  fi
  echo "[backup] copia off-site su S4 completata"
else
  echo "[backup] S4 non configurato (S4_BUCKET/S4_ENDPOINT) — backup solo locale"
fi
