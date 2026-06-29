# Radicale CalDAV — Fase 3 (backend Postgres via API)

Radicale è il server CalDAV che permette a device iOS/macOS/DAVx5/Thunderbird
di sincronizzarsi **bidirezionalmente** con i calendari del gestionale
(Caldes Calendar). Postgres resta l'unica fonte di verità: Radicale è un
thin client che proxya le operazioni verso l'API interna
`/api/caldav-backend/*` (Bearer `CALDAV_SERVICE_TOKEN`). Nessun file storage,
nessun htpasswd — auth e storage sono plugin custom Python.

## Architettura

```
device (iPhone/Mac/DAVx5)
    │  CalDAV over HTTPS
    ▼
CloudPanel vhost: dav.calicchia.design → 127.0.0.1:3011
    │
    ▼
container radicale (ghcr.io/federicokalik/calicchia-radicale)
    │  plugin caldes_auth     → POST /api/caldav-backend/verify-credentials
    │  plugin caldes_storage  → GET/PUT/DELETE /api/caldav-backend/collections/*
    │  Bearer CALDAV_SERVICE_TOKEN
    ▼
container api (app-net, non esposto)
    │  route /api/caldav-backend/* (caldavServiceAuth middleware)
    ▼
Postgres (calendars, calendar_events, caldav_app_passwords)
```

I plugin vivono in `apps/radicale/plugins/` e vengono copiati nell'immagine
dal `Dockerfile` (base `tomsquest/docker-radicale:3.7.3.0` pinnata).

## Prerequisiti (tutti sul server — io non posso farli)

### 1. DNS
Record `dav.calicchia.design` → server (come gli altri sottodomini).

### 2. Env `CALDAV_SERVICE_TOKEN`
Genera un secret condiviso API ↔ Radicale:
```bash
openssl rand -hex 32
```
Inseriscilo nel `.env` del deployment Dokploy. Deve essere **lo stesso valore**
lato API (lo legge via `caldavServiceAuth`) e lato Radicale (env
`CALDAV_SERVICE_TOKEN` nel compose). Il compose lo passa automaticamente a
entrambi i servizi.

### 3. Vhost CloudPanel per `dav.calicchia.design`
Nuovo **Site → Reverse Proxy** verso `http://127.0.0.1:3011`, TLS Let's
Encrypt attivo. Nella config nginx del site servono le direttive CalDAV:
```nginx
server {
    client_max_body_size 100M;
    proxy_read_timeout 300s;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:3011;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # I metodi WebDAV (PROPFIND/REPORT/MKCALENDAR/MOVE…) passano col
        # proxy_pass. NON aggiungere 'limit_except' che li bloccherebbe.
    }

    # Auto-discovery Apple/Thunderbird
    location = /.well-known/caldav  { return 301 /; }
    location = /.well-known/carddav { return 301 /; }
}
```

### 4. App-password CalDAV (NO htpasswd)
A differenza della Fase 0, **non si usa htpasswd**. Le credenziali device sono
"app-password" dedicate, hashate sha256 nella tabella `caldav_app_passwords`,
revocabili per-dispositivo. Creale dall'admin via API (o futura UI admin):
```bash
# Dall'admin autenticato (sostituisci <JWT>):
curl -X POST https://api.calicchia.design/api/caldav-tokens \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"username":"federico","device_name":"iPhone Federico"}'
# → { "id":"...", "password":"<app-password>", "warning":"Salva ora..." }
```
Salva la `password` restituita: la userai sul device come "password" CalDAV
(**non** la password admin). Username = `federico` (il principal).

Liste / revoca:
```bash
curl https://api.calicchia.design/api/caldav-tokens \
  -H "Authorization: Bearer <JWT>"
curl -X DELETE https://api.calicchia.design/api/caldav-tokens/<id> \
  -H "Authorization: Bearer <JWT>"
```

## Deploy

Il compose (`docker-compose.portainer.yml`) referenzia
`ghcr.io/federicokalik/calicchia-radicale:latest`. Il workflow CI
(`.github/workflows/build-radicale-image.yml`) builda e pubblica
automaticamente su push in `main` quando `apps/radicale/**` cambia.

Dockhand fa pull + `up -d` da solo. Verifica:
```bash
docker ps | grep radicale
docker logs <radicale-container>
# Healthcheck: GET /collections tramite plugin storage
```

## Collegare i device

- **iPhone/iPad:** Impostazioni → Calendario → Account → Aggiungi account →
  Altro → **Aggiungi account CalDAV** → Server `dav.calicchia.design`,
  Utente `federico`, Password = **app-password** (non la password admin).
- **macOS:** Calendario → Aggiungi account → Altro account CalDAV →
  Tipo: Manuale → stessi dati.
- **Android (DAVx5):** Accesso con URL+credenziali →
  `https://dav.calicchia.design` → sincronizza.
- **Thunderbird:** Nuovo calendario → Sulla rete → CalDAV →
  URL `https://dav.calicchia.design/federico/<slug>` (es. `/federico/lavoro`).

## Come funziona il sync

- **Lettura device → gestionale:** PROPFIND/GET dal device → plugin
  `caldes_storage.discover` → GET `/api/caldav-backend/collections/<slug>/items`
  → elenco UID+ETag → GET singolo per ogni item → VCALENDAR con master+override.
- **Scrittura device → gestionale:** PUT dal device → plugin `upload` →
  PUT `/api/caldav-backend/collections/<slug>/items/<uid>` con body ICS →
  `parseIcs` + `createEvent`/`updateEvent` su Postgres. RRULE/EXDATE/override
  gestiti dal backend (vedi `caldav-backend.ts`).
- **Eliminazione:** DELETE dal device → plugin `delete` →
  DELETE `/api/caldav-backend/collections/<slug>/items/<uid>` → cascade.
- **Auth:** Basic auth a ogni richiesta → plugin `caldes_auth.login` →
  POST `/verify-credentials` → lookup sha256 su `caldav_app_passwords`.
  Cache LRU 60s per non floodare l'API.

I calendari (`calendars` table) sono gestiti dall'admin UI (pagina
Calendari); Radicale non crea/elimina collection — le scopre dal DB.

## Teardown (dalla vecchia Fase 0)

La Fase 0 usava il volume `radicale_data` con storage a file + htpasswd.
Dopo il primo deploy della Fase 3, il volume non è più referenziato dal
compose e può essere rimosso:
```bash
docker volume rm <stack>_radicale_data
```
I vecchi `apps/radicale/config/users` (htpasswd) non sono più usati —
possibile rimuoverli (erano già gitignored).

## Troubleshooting

- **device non connette:** `docker logs <radicale>` — cerca errori del plugin
  auth. Verifica che `CALDAV_SERVICE_TOKEN` sia identico lato API e Radicale.
  Verifica `CALDAV_BACKEND_URL=http://api:3001/api/caldav-backend` raggiungibile
  dal container (`docker exec <radicale> wget -qO- http://api:3001/health`).
- **401 Unauthorized:** app-password sbagliata o revocata. Creane una nuova
  via `/api/caldav-tokens`.
- ** calendari vuoti:** il principal deve matchare l'username dell'app-password.
  Di default `federico`. Tutti i calendari della tabella `calendars` sono
  visibili via CalDAV (il flag `ics_feed_enabled` controlla solo il feed ICS
  pubblico read-only, non il CalDAV).
- **sync ricorrenze rotte:** il backend supporta RRULE/EXDATE/RECURRENCE-ID
  (vedi `ics-feed.ts` e `caldav-backend.ts` PUT). Se un device manda
  estensioni non supportate, l'evento viene salvato come singolo.
- **debug Radicale:** decommenta `level = debug` in `apps/radicale/config/config`
  e riavvia il container.
