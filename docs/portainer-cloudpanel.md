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
                                          ├─▶ 127.0.0.1:3011  (radicale, CalDAV dei device: dav.calicchia.design)
                                          └─▶ 127.0.0.1:9000  (dockhand UI, restricted)

Tutti i container app vivono su `app-net` (bridge interno).
api e radicale sono anche sulla rete interna `caldav-int` (172.31.250.0/29,
internal: true): api-int 172.31.250.2, radicale-int 172.31.250.3. Solo da lì
l'API parla con Radicale come utente di servizio (§9).
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
(completed_successfully) → `api` → `sito-v3` + `admin` + `mcp`. `radicale` non
dipende da nessuno, e nessuno dipende da lui (§9): parte anche con l'API giù e
viceversa.

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

## 5. CloudPanel — reverse proxy sites

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

### 5e. `dav.calicchia.design` → `http://127.0.0.1:3011`

CalDAV dei device (Radicale, §9). Direttive del sito:
```nginx
# Corpo massimo: allineato a max_content_length = 20000000 del config di Radicale.
client_max_body_size 20m;
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-Proto $scheme;
# IP del device per rate limit e audit di verify-credentials. Sostituisce sempre
# l'header del client. Non è un controllo di sicurezza: gli utenti di servizio si
# riconoscono dal peer TCP sulla rete caldav-int.
proxy_set_header X-Remote-Addr     $remote_addr;
proxy_connect_timeout 10s;
proxy_send_timeout    120s;
proxy_read_timeout    120s;
send_timeout          120s;
client_body_timeout   60s;
# Buffering del corpo attivo (default): un upload lento non occupa un thread di Radicale.
```
- I metodi WebDAV (PROPFIND, REPORT, MKCALENDAR, PROPPATCH, MOVE) passano con il `proxy_pass`: niente `limit_except`.
- `/.well-known/caldav` lo gestisce Radicale da solo, con un 301 verso `/`.
- Dietro il proxy di Cloudflare `$remote_addr` diventa l'IP di Cloudflare, a meno che nginx non usi `real_ip`: per `dav` meglio un record in DNS only.
- Dal vhost della vecchia Fase 3 vanno tolte `client_max_body_size 100M` e `proxy_request_buffering off`.

---

## 6. GitHub repo Variables / Secrets

Stesse variabili di prima (vedi `DEPLOY.md` §3a). I `NEXT_PUBLIC_*` / `VITE_*`
sono già inlinati a build time nei workflow.

**Pulizia secrets ormai non usati** (Dockhand fa polling, non riceve webhook):

```sh
gh secret delete PORTAINER_DEPLOY_WEBHOOK
gh secret delete DOKPLOY_DEPLOY_WEBHOOK   # se ancora presente
```

I workflow `.github/workflows/build-*-image.yml` non hanno più lo step
"Notifica … per il redeploy": l'unico effetto del push su `main` è pubblicare
le immagini su ghcr.io. Dockhand le tirerà al prossimo poll.

Eccezione: `build-radicale-image.yml` esegue prima i test dei plugin (pytest con
Radicale 3.7.8 e selftest) e pubblica **solo** `sha-<short>`, senza `latest`. Il
compose punta a un tag sha pinnato, che cambia solo con un commit del compose
(§9).

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

In Dockhand i servizi dello stack (postgres, api, mcp, sito-v3, admin,
radicale, valkey, cap, worker) devono essere `running` (postgres e radicale
anche `healthy`). `migrate` deve essere `exited 0` (one-shot). Per il CalDAV
vedi i controlli di §9.

---

## 9. Calendario su Radicale: deploy in due commit

Fase F1 del [passaggio del calendario a Radicale](calendar-radicale/README.md): Radicale 3.7.8 con storage nativo, gate dei device (policy, heartbeat, identità del volume) e Postgres ancora autorevole. Dettagli operativi (inizializzazione, device, restore, troubleshooting) in [apps/radicale/README.md](../apps/radicale/README.md).

Il compose di produzione non builda mai e il servizio `radicale` usa un tag `sha-<short>` pinnato. Il deploy è quindi sempre in due commit: prima si pubblica l'immagine, poi un commit del compose la mette in produzione. Così l'immagine che gira è sempre quella testata dalla CI, e il tag cambia solo con un commit.

### 9.1 Prima del primo deploy (una volta, sul server)

```sh
# a) La subnet di caldav-int deve essere libera (nessun output):
docker network ls -q | xargs docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' | grep '172\.31\.250\.'
# Se è occupata: scegliere un'altra /29 e cambiarla nel compose in quattro punti
# (subnet, gateway, ipv4_address di api e radicale) più CALDES_SVC_CIDR.

# b) Filesystem locale dei volumi (ext2/ext3 = ext4, xfs, btrfs; NON nfs/cifs):
stat -f -c '%T' /var/lib/docker/volumes

# c) Vecchio volume della Fase 0: backup tar, NON cancellarlo (decisione 7)
docker volume ls --format '{{.Name}}' | grep radicale_data && \
  docker run --rm -v <progetto>_radicale_data:/v:ro -v /root:/out alpine tar czf /out/radicale_data-fase0-$(date +%F).tgz -C /v .
```

Poi:
- **d) Segreti.** Generarli (comandi in apps/radicale/README.md, "Variabili e segreti") e aggiungerli all'env dello stack in Dockhand: `RADICALE_SVC_PASSWORD`, `CALDES_SVC_PASSWORD_SHA256`, `CALDES_PROBE_PASSWORD`, `CALDES_PROBE_PASSWORD_SHA256`, `CALDES_AUTHCACHE_KEY`. `CALDAV_SERVICE_TOKEN` c'è già.
- **e) CloudPanel.** Aggiornare il vhost `dav.calicchia.design` con le direttive del §5e (`X-Remote-Addr $remote_addr`, `client_max_body_size 20m`, timeout).

### 9.2 Commit 1: l'immagine

Il commit contiene le modifiche ad `apps/radicale/**` e il resto della fase (API, migrazione 162, workflow). **Non** contiene il servizio `radicale` nuovo di `docker-compose.portainer.yml`.

1. Push su `main`. `build-radicale-image` esegue compilazione, selftest e pytest dei plugin, builda l'immagine (il Dockerfile riesegue il selftest) e pubblica `ghcr.io/federicokalik/calicchia-radicale:sha-<short>`. Il tag compare nel riepilogo del job, alla voce "Tag per docker-compose.portainer.yml".
2. Dockhand rileva il commit e fa `pull` e `up -d`:
   - `migrate` applica la 162;
   - l'API riparte con il codice nuovo. Senza il volume `caldes_control` il control-plane resta spento (CALDES_CONTROL_PLANE=auto: la cartella manca);
   - il Radicale vecchio continua a girare: il compose punta ancora alla vecchia immagine, e il workflow non pubblica più `latest`.
3. Il CalDAV di produzione resta rotto come oggi. Se il container vecchio si riavvia fra i due commit legge il config nuovo (montato dal repository) e non parte: nessun impatto sui device, che oggi non sincronizzano.

### 9.3 Commit 2: il compose

1. In `docker-compose.portainer.yml` sostituire `sha-SEGNAPOSTO` con il tag del passo 9.2 (servizio `radicale`) e committare il compose (rete `caldav-int`, volumi `radicale_collections`, `caldes_control`, `radicale_authcache`, variabili di `api` e `radicale`).
2. Dockhand fa `pull` (fallisce se il tag non esiste: in quel caso non cambia nulla) e `up -d`:
   - crea rete e volumi e ricrea `radicale` e `api`;
   - Radicale parte su un volume vuoto senza policy: i device ricevono 403 sotto `/federico/`;
   - l'API scrive subito `policy.json` (shadow, `volume_id: null`) e poi `heartbeat.json` ogni 30 s.
3. Nessun `depends_on` fra `api` e `radicale`. Radicale con l'API giù usa la cache persistita, o risponde 500 a un device mai visto; l'API con Radicale giù funziona come oggi.

### 9.4 Verifica

```sh
P=<progetto>   # docker compose ls
docker compose -p $P ps radicale                                   # running (healthy)
docker compose -p $P exec api cat /run/caldes-control/policy.json  # backend_mode postgres, mode shadow, volume_id null
docker compose -p $P exec api cat /run/caldes-control/heartbeat.json
docker compose -p $P logs --since 10m radicale | grep caldes_event
curl -s -o /dev/null -w '%{http_code}\n' -u 'caldes-svc:<password>' -X PROPFIND -H 'Depth: 0' https://dav.calicchia.design/              # 401
curl -s -o /dev/null -w '%{http_code}\n' -u 'federico:<app-password>' -X PROPFIND -H 'Depth: 0' https://dav.calicchia.design/            # 207
curl -s -o /dev/null -w '%{http_code}\n' -u 'federico:<app-password>' -X PROPFIND -H 'Depth: 1' https://dav.calicchia.design/federico/   # 403 (volume vuoto)
```

L'inizializzazione del volume (facoltativa in F1, poi nel wizard della F3) e la prova con un device reale sono in apps/radicale/README.md, "Inizializzazione del volume". Dopo l'inizializzazione `/federico/` risponde 207 in sola lettura e una PUT 403.

### 9.5 Aggiornamenti successivi dell'immagine e rollback

- **Ogni modifica ad `apps/radicale/**`** segue lo stesso flusso: commit 1, attesa del tag, commit 2 con il tag nuovo. Il config `apps/radicale/config/config` è montato dal repository e si rilegge solo all'avvio: va cambiato solo insieme a un'immagine nuova, e il riavvio lo fa il commit 2.
- **Rollback dell'immagine Radicale:** un commit del compose con il tag sha precedente. I tag sha restano su ghcr.io.
- **Rollback della F1 intera:** revert dei due commit. In F1 Postgres è autorevole: nessun dato da recuperare. I volumi nuovi restano (non cancellarli: dal cutover in poi contengono la fonte di verità), e l'API senza il volume `caldes_control` spegne da sola il control-plane.

---

## 10. Backup coordinato (DB e volume di Radicale)

`scripts/backup-calendar-stack.sh` sostituisce l'uso separato di `backup-db.sh`, che resta per compatibilità e gli delega il lavoro. Ogni 6 h, come root sull'host, da una copia del repository (per esempio `/opt/calicchia-design-platform`):

```sh
# /root/.caldes-backup.env (0600)
COMPOSE_PROJECT=<progetto>
BACKUP_DIR=/var/backups/caldes
RETENTION_DAYS=30
S4_ENDPOINT=...
S4_BUCKET=...
S4_ACCESS_KEY_ID=...
S4_SECRET_ACCESS_KEY=...

# crontab -e (root)
17 */6 * * * cd /opt/calicchia-design-platform && set -a && . /root/.caldes-backup.env && set +a && ./scripts/backup-calendar-stack.sh >> /var/log/caldes-backup.log 2>&1
```

In ogni run:
1. `pg_dump` con il `pg_dump` del container postgres (stessa versione del server);
2. tar del volume `radicale_collections` sotto il lock condiviso di Radicale;
3. un solo `manifest.json` con checksum, stato del backend e identità del volume;
4. retention e copia su S4 in `s3://$S4_BUCKET/calendar-stack/<id>/`.

Richiede `python3`, `flock` e, per S4, la AWS CLI. Il restore coordinato (`scripts/restore-calendar-stack.sh`, con verifica dell'identità e conferma esplicita) e il drill trimestrale sono in apps/radicale/README.md, "Backup e restore". Durante un restore va sospeso l'aggiornamento automatico dello stack in Dockhand.

---

## Differenze rispetto a Dokploy

| | Dokploy | Dockhand + CloudPanel |
|---|---|---|
| Routing | Traefik via label / UI Domains | CloudPanel (nginx sull'host) |
| TLS | Let's Encrypt via Traefik | Let's Encrypt via CloudPanel |
| Compose | `docker-compose.prod.yml` (rete `dokploy-network` esterna), **deprecato**: senza lo stack del calendario su Radicale | `docker-compose.portainer.yml` (rete `app-net` bridge, `ports: 127.0.0.1:*`, rete interna `caldav-int`) |
| Auto redeploy | non funziona (Branch Not Match) | **Git polling Dockhand** — pulla `main` e fa `compose pull && up -d` |
| Visibilità Docker | scarsa, deduce | Dockhand UI: log, exec, healthcheck, stack editor |
| Registry credentials | gestite da Dokploy UI | `docker login` sull'host una volta |

Tieni entrambi i compose nel repo: se un giorno torni su Dokploy o cambi
ancora orchestratore (Portainer di nuovo, Komodo, Watchtower puro…), parti
dal `docker-compose.portainer.yml` che è già adatto a qualunque tool
compose-aware con port loopback + CloudPanel davanti.
