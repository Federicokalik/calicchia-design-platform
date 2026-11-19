# syntax=docker/dockerfile:1
# Servizio `backup` dello stack (apps/backup/README.md): backup coordinato
# del database e del volume di Radicale, pianificato e comandabile dall'admin.
# Build context = radice del repository (copia gli script da scripts/).
#
# Base postgres:17-alpine, la stessa immagine del servizio postgres dello
# stack: pg_dump e psql hanno la stessa versione maggiore del server, come
# chiede lo script (un pg_dump più vecchio del server rifiuta il dump).
# Strumenti GNU (bash, coreutils, findutils, tar) perché lo script li usa
# (find -printf, tar --anchored, timeout --kill-after); flock da util-linux
# per il lock condiviso di Radicale; aws-cli per la copia su MEGA S4.

FROM postgres:17-alpine

RUN apk add --no-cache \
      bash coreutils findutils tar gzip util-linux \
      python3 aws-cli curl ca-certificates

WORKDIR /app
COPY scripts/backup-calendar-stack.sh scripts/calendar_stack.py /app/scripts/
COPY apps/backup/runner.sh /app/runner.sh
RUN chmod 0755 /app/runner.sh /app/scripts/backup-calendar-stack.sh

# Self-test in build: una dipendenza mancante o di versione sbagliata fa
# fallire la build (in CI anche sulle pull request), non il primo backup.
RUN set -eux; \
    pg_dump --version | grep -Eq 'PostgreSQL\) 17\.'; \
    psql --version; \
    for cmd in bash python3 flock tar gzip sha256sum timeout find curl aws; do command -v "$cmd"; done; \
    tar --version | head -n 1 | grep -q 'GNU tar'; \
    find --version | head -n 1 | grep -q 'GNU findutils'; \
    timeout --version | head -n 1 | grep -q 'GNU coreutils'; \
    aws --version; \
    bash -n /app/runner.sh; \
    bash -n /app/scripts/backup-calendar-stack.sh; \
    python3 -I -c "import ast, pathlib; ast.parse(pathlib.Path('/app/scripts/calendar_stack.py').read_text())"; \
    /app/scripts/backup-calendar-stack.sh --help >/dev/null

# I backup contengono dati personali: lo script lavora con umask 077.
ENV BACKUP_DIR=/backups
VOLUME ["/backups"]

ENTRYPOINT ["/app/runner.sh"]
