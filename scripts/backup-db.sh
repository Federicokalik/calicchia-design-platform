#!/usr/bin/env bash
# Backup del database Postgres — Calicchia Design Platform.
#
# Compatibilità: dalla fase F1 del passaggio del calendario a Radicale il
# backup è unico e coordinato (scripts/backup-calendar-stack.sh, design §16.1):
# pg_dump più snapshot del volume di Radicale sotto lock, un solo manifest,
# retention e copia su MEGA S4. Questo script resta per i cron e le abitudini
# esistenti e delega a quello unico con le stesse variabili di prima:
#   DATABASE_URL (oppure PG_CONTAINER / COMPOSE_PROJECT), BACKUP_DIR,
#   RETENTION_DAYS, S4_ENDPOINT, S4_BUCKET, S4_ACCESS_KEY_ID,
#   S4_SECRET_ACCESS_KEY, S4_REGION, UPLOAD_DIR.
#
# Differenze rispetto al vecchio script:
#   - il dump sta in $BACKUP_DIR/calendar-stack/<id>/caldes-db.sql.gz (stesso
#     formato: SQL plain compresso, quindi scripts/restore-db.sh lo accetta
#     ancora) accanto a manifest.json, e su S4 in s3://$S4_BUCKET/calendar-stack/<id>/;
#   - se è configurato anche il volume di Radicale (RADICALE_VOLUME_DIR,
#     RADICALE_VOLUME o COMPOSE_PROJECT) il run lo include; altrimenti fa il solo
#     dump con un avviso (RADICALE_BACKUP=auto). Per il calendario su Radicale
#     usa direttamente backup-calendar-stack.sh, che senza volume fallisce;
#   - i vecchi caldes-*.sql.gz in $BACKUP_DIR seguono la stessa retention.
#
# Uso:   ./scripts/backup-db.sh            (opzioni: vedi backup-calendar-stack.sh --help)
# Cron storico (ora va bene ogni 6 h):
#   17 */6 * * * cd /path/al/repo && DATABASE_URL=... ./scripts/backup-db.sh >> /var/log/caldes-backup.log 2>&1
set -euo pipefail

export RADICALE_BACKUP="${RADICALE_BACKUP:-auto}"
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-calendar-stack.sh" "$@"
