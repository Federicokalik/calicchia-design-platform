# Deploy con Dockhand + CloudPanel

> Filename storico (`portainer-cloudpanel.md`) mantenuto per non rompere link
> esterni e cronologia git. L'orchestratore attuale è **Dockhand**
> ([Finsys/dockhand](https://github.com/Finsys/dockhand)).
> Variante al deploy Dokploy: container orchestrati da **Dockhand**, reverse
> proxy + TLS gestiti da **CloudPanel** (nginx sull'host).

File compose dello stack app: [`docker-compose.portainer.yml`](../docker-compose.portainer.yml).
File compose della UI Dockhand: [`docker-compose.dockhand.yml`](../docker-compose.dockhand.yml).

---

## Architettura

```
Internet ─HTTPS─▶ Cloudflare ─HTTPS─▶ CloudPanel (nginx, host) ─HTTP─▶
                                          │
                                          ├─▶ 127.0.0.1:3001  (api)
                                          ├─▶ 127.0.0.1:3002  (mcp)
                                          ├─▶ 127.0.0.1:3000  (sito-v3)
                                          ├─▶ 127.0.0.1:8081  (admin nginx -> :80)
                                          └─▶ 127.0.0.1:9000  (dockhand UI, restricted)

Tutti i container app vivono su `app-net` (bridge interno).
Postgres NON espone porte sull'host.
Dockhand gira su un suo stack a parte, parla col Docker daemon via socket.
```

---

## 1. Prerequisiti sul VPS

- Docker + docker compose installati.
- **Dockhand** in esecuzione (UI per stacks/containers) — installato sotto.
- **CloudPanel** installato (gestisce nginx + Let's Encrypt sui domini).
- DNS dei 3 sottodomini puntati all'IP del VPS (proxied o no su Cloudflare —
  CloudPanel emette il certificato indipendentemente).
- Sottodominio dedicato per la UI Dockhand (es. `dockhand.calicchia.design`),
  consigliato dietro Cloudflare Access o IP allowlist.
- Bucket MEGA S4 `calicchiadesignwebsite/kb/` con i KB.

---

## 2. ghcr.io — login sull'host Docker

Dockhand NON gestisce credenziali registry come faceva Portainer: delega il
pull al Docker daemon dell'host. Quindi serve `docker login` una sola volta
come root (o utente nel gruppo `docker`):

```sh
echo "<GHCR_PAT>" | docker login ghcr.io -u Federicokalik --password-stdin
```

Il PAT GitHub serve scope `read:packages` (e `repo` se il repo del codice è
privato, vedi §3). Le credenziali finiscono in `~/.docker/config.json`; tutti
i container del compose tireranno l'immagine corretta dal pull seguente.

---

## 3. Install Dockhand sul VPS

Crea una cartella host per il compose della UI (separato dall'app):

```sh
mkdir -p /opt/dockhand && cd /opt/dockhand
# scarica solo il compose dedicato dal repo
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/docker-compose.dockhand.yml \
  -o docker-compose.yml
docker compose up -d
docker compose ps
```

La UI risponde su `http://127.0.0.1:9000/`. Crea l'admin user al primo login.

### CloudPanel vhost per la UI Dockhand

`Site → Reverse Proxy`, dominio (es. `dockhand.calicchia.design`),
target `http://127.0.0.1:9000`:

```nginx
client_max_body_size 25m;
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

# Dockhand usa WebSocket per stream log/exec
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_read_timeout 300s;
```

Abilita Let's Encrypt e — fortemente consigliato — proteggi l'accesso con
Cloudflare Access (Zero Trust) o `allow <tuoIP>; deny all;`.

---

## 4. Dockhand — Stack del progetto (Git polling)

Dalla UI Dockhand:

1. `Stacks → New stack from Git`.
2. Repository: URL del repo (HTTPS).
3. Auth: se il repo è privato, incolla un PAT GitHub con scope `repo`.
4. Branch: `main`.
5. Compose path: `docker-compose.portainer.yml` (il nome è storico, il file
   è il compose dell'app stack — vedi header commento).
6. Polling interval: `60s` (o quanto preferisci — più basso = più traffico).
7. **Environment variables**: incolla l'intero `.env.prod` (lo stesso che
   usavi su Dokploy/Portainer).
8. **Deploy**.

Ordine d'avvio dal compose: `postgres` (healthy) → `migrate`
(completed_successfully) → `api` → `sito-v3` + `admin` + `mcp`.

A ogni push su `main`, Dockhand rileva il nuovo commit (o solo un nuovo tag
sulle immagini ghcr.io se imposti la modalità "image polling"), fa
`docker compose pull && docker compose up -d` → redeploy automatico.

Verifica subito sui loopback:

```sh
curl -I http://127.0.0.1:3001/api/health    # api
curl -I http://127.0.0.1:3002/health         # mcp
curl -I http://127.0.0.1:3000/              # sito
curl -I http://127.0.0.1:8081/              # admin (nginx SPA)
```

---

## 5. CloudPanel — 3 reverse proxy sites (invariati)

Per ogni sottodominio crea un **Site → Reverse Proxy**, abilita Let's Encrypt.

### 5a. `api.calicchia.design` → `http://127.0.0.1:3001`

Vhost / extra nginx config (importante: l'api genera PDF Puppeteer e accetta upload):
```nginx
client_max_body_size 50m;
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;

# Timeout lunghi per Puppeteer (PDF preventivi/ricevute possono prendere 20-30s)
proxy_connect_timeout 30s;
proxy_send_timeout    120s;
proxy_read_timeout    120s;
send_timeout          120s;
```

### 5b. `calicchia.design` (+ `www.calicchia.design`) → `http://127.0.0.1:3000`

Vhost Next.js (SSR + ISR + streaming):
```nginx
client_max_body_size 25m;
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;

# Niente buffering: Next.js usa streaming per le pagine SSR/RSC
proxy_buffering off;
proxy_request_buffering off;

# Upgrade / Connection: utile per eventuali WebSocket (es. tools dev futuri)
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection $connection_upgrade;

proxy_read_timeout 60s;
```
(la mappa `$connection_upgrade` viene gestita automaticamente da CloudPanel; se ti
chiede di definirla a livello `http {}`, è il blocco
`map $http_upgrade $connection_upgrade { default upgrade; '' close; }`.)

### 5c. `admin.calicchia.design` → `http://127.0.0.1:8081`

Vhost SPA (Vite + react-router v7 — il fallback `/index.html` lo fa già la nginx
interna del container):
```nginx
client_max_body_size 25m;
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 60s;
```

> Promemoria: `admin` NON ha bisogno di mount sull'host. La SPA è statica
> dentro l'immagine. Il fix IPv6 di `apps/admin/nginx.conf` (`listen [::]:80;`)
> resta valido — quel nginx **dentro** il container.

### 5d. `mcp.calicchia.design` → `http://127.0.0.1:3002`

Vhost MCP Streamable HTTP:
```nginx
client_max_body_size 10m;
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Authorization     $http_authorization;
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 300s;
```

---

## 6. GitHub repo Variables / Secrets

Stesse variabili di prima (vedi `DEPLOY.md` §3a). I `NEXT_PUBLIC_*` / `VITE_*`
sono già inlinati a build time nei workflow.

**Pulizia secrets ormai non usati** (Dockhand fa polling, non riceve webhook):

```sh
gh secret delete PORTAINER_DEPLOY_WEBHOOK
gh secret delete DOKPLOY_DEPLOY_WEBHOOK   # se ancora presente
```

I 4 workflow `.github/workflows/build-*-image.yml` non hanno più lo step
"Notifica … per il redeploy": l'unico effetto del push su `main` è pubblicare
le immagini su ghcr.io. Dockhand le tirerà al prossimo poll.

---

## 7. Migrazione da Portainer (situazione attuale)

Lo stack app gira già su questo VPS con Portainer come UI. I container sono
indipendenti dall'UI: spegnere Portainer non ferma postgres/api/sito/admin/mcp.

```sh
# 0. (Opzionale) backup volumi Portainer per rollback
docker run --rm -v portainer_data:/from -v /root:/to alpine \
  tar czf /to/portainer-data-backup-$(date +%F).tgz -C /from .

# 1. Login ghcr come root sull'host (vedi §2)
echo "<GHCR_PAT>" | docker login ghcr.io -u Federicokalik --password-stdin

# 2. Installa Dockhand in /opt/dockhand
mkdir -p /opt/dockhand && cd /opt/dockhand
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/docker-compose.dockhand.yml \
  -o docker-compose.yml
docker compose up -d
docker compose ps        # dockhand running, 127.0.0.1:9000

# 3. CloudPanel: cambia il vhost (sottodominio dockhand) da port 9000 di
#    Portainer a 9000 di Dockhand (è la stessa porta, ma cambia target di
#    routing solo se cambi sottodominio; se riusi `dockhand.calicchia.design`
#    al posto di `portainer.calicchia.design`, aggiorna DNS e crea nuovo Site).

# 4. Apri la UI Dockhand, configura admin user, importa lo stack come §4
#    (Git polling). Dockhand riconoscerà i container esistenti e li adotta
#    se il project_name coincide. Se preferisci, fai prima un down/up dello
#    stack via Dockhand per essere sicuro:
#       Stacks → calicchia-design-platform → Redeploy

# 5. Smoke test (curl §4 + verifica frontend pubblici)

# 6. Spegni e rimuovi Portainer
docker stop portainer && docker rm portainer
docker volume rm portainer_data   # SOLO se §0 backup OK
docker image rm portainer/portainer-ce:latest   # opzionale

# 7. CloudPanel: cancella il vecchio vhost di Portainer se esiste come Site
#    separato e non riusato per Dockhand.

# 8. GitHub secrets cleanup (vedi §6).
```

I knowledge base **NON** vanno migrati: vengono ri-scaricati da S4 al boot.

---

## 8. Verifica end-to-end

```sh
curl -s https://api.calicchia.design/api/health        # {"status":"healthy",...}
curl -s https://mcp.calicchia.design/health            # {"status":"ok",...}
curl -s https://api.calicchia.design/api/health/kb     # {"source":"s4","file_count":2,...}
curl -I https://calicchia.design                       # 200
curl -I https://admin.calicchia.design                 # 200
```

In Dockhand i 5 servizi dello stack (postgres, api, mcp, sito-v3, admin)
devono essere `running` (postgres anche `healthy`). `migrate` deve essere
`exited 0` (one-shot).

---

## Differenze rispetto a Dokploy

| | Dokploy | Dockhand + CloudPanel |
|---|---|---|
| Routing | Traefik via label / UI Domains | CloudPanel (nginx sull'host) |
| TLS | Let's Encrypt via Traefik | Let's Encrypt via CloudPanel |
| Compose | `docker-compose.prod.yml` (rete `dokploy-network` esterna) | `docker-compose.portainer.yml` (rete `app-net` bridge, `ports: 127.0.0.1:*`) |
| Auto redeploy | non funziona (Branch Not Match) | **Git polling Dockhand** — pulla `main` e fa `compose pull && up -d` |
| Visibilità Docker | scarsa, deduce | Dockhand UI: log, exec, healthcheck, stack editor |
| Registry credentials | gestite da Dokploy UI | `docker login` sull'host una volta |

Tieni entrambi i compose nel repo: se un giorno torni su Dokploy o cambi
ancora orchestratore (Portainer di nuovo, Komodo, Watchtower puro…), parti
dal `docker-compose.portainer.yml` che è già adatto a qualunque tool
compose-aware con port loopback + CloudPanel davanti.
