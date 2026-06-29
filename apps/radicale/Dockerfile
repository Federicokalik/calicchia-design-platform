# Immagine custom Radicale per Caldes Calendar — FASE 3.
# Basata su tomsquest/docker-radicale:3.7.3.0 (pinnata) con i plugin caldes_*
# (storage + auth) che parlano con il backend API `/api/caldav-backend/*`.
# Postgres resta l'unica fonte di verità; nessuno storage file lato Radicale.
#
# Build context: apps/radicale (vedi docker-compose.portainer.yml + workflow CI).
# Tag: ghcr.io/federicokalik/calicchia-radicale:<pin>

FROM tomsquest/docker-radicale:3.7.3.0

# I plugin vivono in /data/plugins così Radicale li carica via PYTHONPATH
# (config storage.type = caldes_storage, auth.type = caldes_auth). La dir
# /data è già il volume persistente dell'immagine base — ma i plugin sono
# read-only e non devono sopravvivere ai redeploy, li copiamo in /app/plugins
# e aggiungiamo a PYTHONPATH.
COPY plugins/ /app/plugins/

# Nessuna dipendenza extra: i plugin usano solo stdlib (urllib, json, email.utils)
# + vobject già installato nell'immagine base.

ENV PYTHONPATH=/app/plugins

# Healthcheck: verify() del plugin storage chiama GET /collections.
# L'immagine base espone Radicale su 5232; usiamo un PROPFIND minimal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request,sys; \
    r=urllib.request.urlopen('http://127.0.0.1:5232/', timeout=3); \
    sys.exit(0 if r.status in (200,207) else 1)" || exit 1
