# syntax=docker/dockerfile:1
#
# Immagine Radicale di Caldes, fase F1 del passaggio del calendario a Radicale
# (docs/calendar-radicale/design.md §3.1-§3.5, piano F1 attività 1).
#
# Radicale 3.7.8 con storage nativo multifilesystem e tre plugin, tutti in
# /app/plugins (PYTHONPATH):
#   - caldes_auth: utenti di servizio dal peer TCP, device via verify-credentials
#     dell'API con principal canonico e cache persistita;
#   - caldes_rights: policy shadow/live/frozen, heartbeat dell'API e identità
#     del volume (contratto docs/calendar-radicale/contracts/control-plane.md);
#   - caldes_vobject_fix, attivato da sitecustomize all'avvio dell'interprete:
#     fedeltà di vobject 0.9.9 (virgole, VALUE=URI, X-prop).
#
# Build context: apps/radicale (workflow build-radicale-image.yml). In
# produzione Compose non builda mai: usa ghcr.io/federicokalik/calicchia-radicale
# con il tag sha-<short> pubblicato dalla CI (deploy in due commit, design §3.5).

# Base pinnata per digest: indice multi-arch (linux/amd64, linux/arm64) del tag
# 3.7.8.0, Alpine 3.24 con Python 3.14 e /venv (radicale 3.7.8, vobject 0.9.9).
# Verificato il 2026-10-09: campo "digest" di
# https://hub.docker.com/v2/repositories/tomsquest/docker-radicale/tags/3.7.8.0
# e sha256 dell'indice scaricato dal registry (manifest amd64
# sha256:0fce6c98..., arm64 sha256:d89a1065...). Il tag documenta la versione,
# il digest la fissa: un re-push del tag non cambia questa immagine.
FROM tomsquest/docker-radicale:3.7.8.0@sha256:29a9098ef9851605ca37ef3a3d5e885594c7fe91731fb6edb3194a56cfc6c54e

LABEL org.opencontainers.image.title="calicchia-radicale" \
      org.opencontainers.image.description="Radicale 3.7.8 per Caldes: storage nativo, plugin caldes_auth, caldes_rights e fix di fedeltà vobject" \
      org.opencontainers.image.source="https://github.com/federicokalik/calicchia-design-platform" \
      org.opencontainers.image.base.name="docker.io/tomsquest/docker-radicale:3.7.8.0" \
      org.opencontainers.image.base.digest="sha256:29a9098ef9851605ca37ef3a3d5e885594c7fe91731fb6edb3194a56cfc6c54e"

# - PYTHONPATH: Radicale importa i plugin per nome (type = caldes_auth...) e
#   l'interprete carica /app/plugins/sitecustomize.py all'avvio, che applica la
#   patch di vobject prima di qualsiasi lettura o scrittura di item;
# - niente bytecode accanto ai plugin (cartella di root, in sola lettura per
#   l'utente radicale) e log non bufferizzati;
# - TAKE_FILE_OWNERSHIP=false: l'entrypoint non fa chown -R di /data a ogni
#   avvio (lento sui volumi grandi e inutile: i file li crea già l'utente
#   radicale 2999). Nessuna variabile RADICALE_CONFIG_*: l'entrypoint
#   riscriverebbe il config montato in sola lettura (design §3.1);
# - TZ=UTC come il container dell'API (design §3.5).
ENV PYTHONPATH=/app/plugins \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TAKE_FILE_OWNERSHIP=false \
    TZ=UTC

# Plugin e config. Il config è anche montato in sola lettura dal compose
# (./apps/radicale/config:/config:ro); la copia nell'immagine evita che un
# container avviato senza mount giri con il config di default di tomsquest
# (auth type = none).
COPY plugins/ /app/plugins/
COPY config/config /config/config

# Permessi:
# - plugin e config di root, leggibili da tutti e non scrivibili dall'utente
#   radicale;
# - punto di mount della cache persistita di caldes_auth (volume
#   radicale_authcache): 0700 dell'utente radicale. Docker inizializza un
#   volume nominato vuoto con proprietario e permessi della cartella
#   dell'immagine, quindi il plugin può scriverci authcache.json (0600);
# - punto di mount di caldes_control (policy.json e heartbeat.json): lo
#   scrive solo l'API, qui è montato in sola lettura.
RUN chmod -R u=rwX,go=rX /app/plugins /config \
 && mkdir -p /var/lib/caldes-auth /control \
 && chown radicale:radicale /var/lib/caldes-auth \
 && chmod 0700 /var/lib/caldes-auth \
 && chmod 0755 /control

# Self-test in build: versioni pinnate, patch di vobject attiva tramite
# sitecustomize, config, firma dei plugin (login() non ridefinito) e un
# percorso reale in memoria (identità, shadow, live, PUT/GET fedele,
# heartbeat scaduto). Se fallisce, la build fallisce.
RUN /venv/bin/python /app/plugins/caldes_selftest.py /config/config

# PROPFIND Depth:0 sulla root come caldes-probe da 127.0.0.1 (207 atteso):
# passa per auth e rights, quindi un plugin rotto rende il container
# unhealthy, e funziona anche prima dell'inizializzazione del principal.
# -I: interprete isolato (niente PYTHONPATH né sitecustomize, avvio più rapido).
# Richiede CALDES_PROBE_PASSWORD nell'ambiente del container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/venv/bin/python", "-I", "/app/plugins/caldes_healthcheck.py"]

# Entrypoint e comando dell'immagine base: docker-entrypoint.sh passa
# all'utente radicale (su-exec) e avvia /venv/bin/radicale --config /config/config.
