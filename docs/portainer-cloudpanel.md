# Deploy con Portainer + CloudPanel

Variante al deploy Dokploy: container orchestrati da **Portainer**, reverse
proxy + TLS gestiti da **CloudPanel** (nginx sull'host).

File compose dedicato: [`docker-compose.portainer.yml`](../docker-compose.portainer.yml).

---

## Architettura

```
Internet ─HTTPS─▶ Cloudflare ─HTTPS─▶ CloudPanel (nginx, host) ─HTTP─▶
                                          │
                                          ├─▶ 127.0.0.1:3001  (api)
                                          ├─▶ 127.0.0.1:3002  (mcp)
                                          ├─▶ 127.0.0.1:3000  (sito-v3)
                                          └─▶ 127.0.0.1:8081  (admin nginx -> :80)

Tutti i container vivono su `app-net` (bridge interno).
Postgres NON espone porte sull'host.
```

---

## 1. Prerequisiti sul nuovo VPS

- Docker installato.
- **Portainer** in esecuzione (UI per stacks/registries).
- **CloudPanel** installato (gestisce nginx + Let's Encrypt sui domini).
- DNS dei 3 sottodomini puntati all'IP del nuovo VPS (proxied o no su Cloudflare —
  CloudPanel emette il certificato indipendentemente).
- Bucket MEGA S4 `calicchiadesignwebsite/kb/` con i KB (come prima).

---

## 2. Portainer — Registry credential ghcr.io

`Settings → Registries → Add registry`:
- Provider: **Custom registry**
- URL: `ghcr.io`
- Username: `Federicokalik`
- Password: un PAT GitHub con scope **`read:packages`**

---

## 3. Portainer — Stack del progetto

`Stacks → Add stack`:
- Name: `calicchia-design-platform`
- Build method: **Repository** (consigliato — auto-update su push) o **Web editor** (incolla `docker-compose.portainer.yml`).
- Se Repository: URL del repo, branch `main`, compose path `docker-compose.portainer.yml`.
- **Environment variables**: incolla l'intero `.env.prod` (lo stesso che usavi su Dokploy).
- **Deploy the stack**.

Ordine d'avvio gestito dal compose: `postgres` (healthy) → `migrate`
(completed_successfully) → `api` → `sito-v3` + `admin`.

Verifica subito che le porte loopback rispondano sul VPS:
```sh
curl -I http://127.0.0.1:3001/api/health    # api
curl -I http://127.0.0.1:3002/health         # mcp
curl -I http://127.0.0.1:3000/              # sito
curl -I http://127.0.0.1:8081/              # admin (nginx SPA)
```

---

## 4. CloudPanel — 3 reverse proxy sites

Per ogni sottodominio crea un **Site → Reverse Proxy**, abilita Let's Encrypt.

### 4a. `api.calicchia.design` → `http://127.0.0.1:3001`

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

### 4b. `calicchia.design` (+ `www.calicchia.design`) → `http://127.0.0.1:3000`

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

### 4c. `admin.calicchia.design` → `http://127.0.0.1:8081`

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

### 4d. `mcp.calicchia.design` → `http://127.0.0.1:3002`

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

## 5. GitHub repo Variables

Stesse di prima (vedi `DEPLOY.md` §3a). Se i domini non cambiano (`api.calicchia.design`,
`calicchia.design`, `admin.calicchia.design`), **niente da modificare** — i
`NEXT_PUBLIC_*` / `VITE_*` puntano già ai sottodomini corretti.

`DOKPLOY_DEPLOY_WEBHOOK` lo puoi cancellare (`gh secret delete DOKPLOY_DEPLOY_WEBHOOK`):
con Portainer si redeploya dalla UI o tramite l'auto-update repo di Portainer.

---

## 6. Migrazione dati dal vecchio VPS (se serve)

Sul vecchio VPS Dokploy:
```sh
docker exec -t <postgres-container> pg_dump -U caldes -d caldes \
  | gzip > /tmp/calicchia-prod.sql.gz
scp /tmp/calicchia-prod.sql.gz user@new-vps:/tmp/
```
Sul nuovo VPS, dopo lo `up` dello stack (postgres in piedi e `migrate` completato):
```sh
gunzip -c /tmp/calicchia-prod.sql.gz \
  | docker exec -i <postgres-container-new> psql -U caldes -d caldes
```
Per uploads e file privati: copia i volumi `uploads_data` e `private_data` con
`docker run --rm -v <vol>:/from -v $(pwd):/to alpine tar czf /to/x.tgz -C /from .`
sul vecchio, scp, e l'inverso sul nuovo.

I knowledge base **NON** vanno migrati: vengono ri-scaricati da S4 al boot.

---

## 7. Switch DNS

Quando il nuovo VPS risponde correttamente sui 3 sottodomini:
1. Cambia gli A/AAAA record dei 3 sottodomini sul nuovo IP (Cloudflare).
2. TTL basso preventivo (5 min) ore prima dello switch per accelerare la propagazione.
3. Verifica con `dig`/`curl` e poi spegni il vecchio.

---

## 8. Verifica end-to-end

```sh
curl -s https://api.calicchia.design/api/health        # {"status":"healthy",...}
curl -s https://mcp.calicchia.design/health            # {"status":"ok",...}
curl -s https://api.calicchia.design/api/health/kb     # {"source":"s4","file_count":2,...}
curl -I https://calicchia.design                       # 200
curl -I https://admin.calicchia.design                 # 200
```

Su Portainer i 3 servizi devono essere `running (healthy)` (con il fix IPv6 di
nginx, l'admin diventa healthy entro ~30s dall'avvio).

---

## Differenze rispetto a Dokploy

| | Dokploy | Portainer + CloudPanel |
|---|---|---|
| Routing | Traefik via label / UI Domains | CloudPanel (nginx sull'host) |
| TLS | Let's Encrypt via Traefik | Let's Encrypt via CloudPanel |
| Compose | `docker-compose.prod.yml` (rete `dokploy-network` esterna) | `docker-compose.portainer.yml` (rete `app-net` bridge, `ports: 127.0.0.1:*`) |
| Webhook redeploy | non funziona (Branch Not Match) | auto-update via Portainer repo polling, oppure manuale |
| Visibilità Docker | scarsa, deduce | Portainer mostra tutto: log, exec, healthcheck output |

Tieni entrambi i compose nel repo: se un giorno torni su Dokploy o cambi ancora
host, hai i due profili pronti.
