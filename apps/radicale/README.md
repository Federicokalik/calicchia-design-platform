# Radicale CalDAV — calendario su Radicale (fase F1)

Radicale è il server CalDAV dei device (iPhone, Mac, DAVx5, Thunderbird). Dalla fase F1 del [passaggio del calendario a Radicale](../../docs/calendar-radicale/README.md) gira con **storage nativo** sul volume `radicale_collections`. Il vecchio proxy della "Fase 3", che con il plugin `caldes_storage` girava ogni richiesta a `/api/caldav-backend/collections/*`, non esiste più.

**Stato in F1: Postgres resta la fonte di verità.** Radicale è in modalità shadow. La policy scritta dall'API tiene i device in sola lettura, oppure senza accesso finché il volume non è inizializzato. Gli eventi arrivano su Radicale solo con lo strumento di migrazione della F3; il passaggio a Radicale autorevole avviene in F4-F5.

Riferimenti:
- [design](../../docs/calendar-radicale/design.md), §3 (Radicale), §6.3 (identità), §13.1 (policy derivata) e §16 (backup);
- [piano](../../docs/calendar-radicale/piano.md), F1;
- [contratto del control-plane](../../docs/calendar-radicale/contracts/control-plane.md): policy, heartbeat, identità, utenti di servizio, cache e permessi.

## Architettura

```
 device (iPhone/Mac/DAVx5/Thunderbird)
   https://dav.calicchia.design/federico/<slug>/
        │ TLS CloudPanel, X-Remote-Addr: $remote_addr (solo per IP e rate limit)
        ▼
 127.0.0.1:3011 ──► app-net ──► radicale :5232   (peer = gateway di app-net)
                                 │ caldes_auth    device → POST api-int:3001/api/caldav-backend/verify-credentials
                                 │                caldes-svc / caldes-probe → sha256 in env, solo dal peer giusto
                                 │                cache 60 s + cache persistita 24 h (radicale_authcache)
                                 │ caldes_rights  policy.json + heartbeat.json (caldes_control, :ro)
                                 │                + identità del volume (dead prop volume-id/epoch sul principal)
                                 │ caldes_vobject_fix (sitecustomize): virgole, VALUE=URI, X-prop
                                 │ volume radicale_collections:/data
                                 ▲
 rete interna caldav-int 172.31.250.0/29 (internal: true, nessuna porta pubblicata)
   api  172.31.250.2 (alias api-int)   ── CalDAV come caldes-svc ──►  radicale 172.31.250.3 (alias radicale-int)
   │ scrive policy.json e heartbeat.json su caldes_control (rw), legge radicale_collections (:ro)
   ▼
 Postgres: calendar_backend_state (mode, volume_id, epoch, credential_epoch…) + sidecar dei calendari (162)
```

- **Device.** Qualsiasi app-password valida diventa il principal canonico `federico`, anche se è stata creata con un altro username (per esempio `iphone`). Lo username resta solo per audit e rate limit.
- **Utenti di servizio.** `caldes-svc` vale solo dal peer TCP dell'API su `caldav-int` (`CALDES_SVC_CIDR=172.31.250.2/32`). `caldes-probe` vale anche da `127.0.0.1`, per l'healthcheck. Tutto il traffico pubblicato arriva invece dal gateway di `app-net`. Una password di servizio trapelata resta quindi inutilizzabile da internet: risponde 401, e uno username `caldes-*` non entra mai nel ramo device.
- **Modalità** (`policyFromState()`, design §13.1):
  - in `mode=postgres` la policy è `shadow`: i device sono in sola lettura;
  - `frozen` vale quando c'è un restore guard, un rebuild richiesto, un'identità diversa o non verificata, oppure quando l'heartbeat dell'API manca o ha più di 10 minuti;
  - senza un'identità valida i device non hanno alcun permesso sotto `/federico/`: ricevono 403 e non si crea nessuna directory.
- **API giù.** Le credenziali già viste restano valide per 24 h grazie alla cache persistita. Un device mai visto riceve 500, non 401, quindi non invalida la password. Dopo 10 minuti senza heartbeat i device passano in sola lettura.

## Contenuto della cartella

| Percorso | Cosa contiene |
|---|---|
| `Dockerfile` | `tomsquest/docker-radicale:3.7.8.0` pinnata per digest, plugin in `/app/plugins`, config in `/config/config`, selftest in build, healthcheck (PROPFIND sulla root come `caldes-probe`) |
| `config/config` | config di produzione (design §3.2): `caldes_auth`, `caldes_rights`, `multifilesystem` su `/data/collections`, `max_vevent_rrule_occurrence = 50000`, `delay_on_error = 0` |
| `plugins/caldes_auth.py` | autenticazione: utenti di servizio dal peer, device via `verify-credentials`, cache, revoca con `credential_epoch` |
| `plugins/caldes_rights.py` | permessi: policy, heartbeat, identità del volume, matrice del contratto §8 |
| `plugins/caldes_vobject_fix.py`, `plugins/sitecustomize.py` | patch di fedeltà di vobject 0.9.9, attiva all'avvio dell'interprete |
| `plugins/caldes_healthcheck.py`, `plugins/caldes_selftest.py` | healthcheck del container; self-test eseguito in build e in CI |
| `tests/` | suite pytest contro Radicale 3.7.8 reale (auth, rights, fedeltà, layout, identità, immagine, stack completo) |

La CI ([build-radicale-image.yml](../../.github/workflows/build-radicale-image.yml)) parte a ogni modifica di `apps/radicale/**`, dei casi del contratto o del mock di verify-credentials. Esegue la compilazione, il selftest e pytest con Radicale 3.7.8 su Python 3.14, poi builda l'immagine. Fuori dalle pull request pubblica **solo** il tag `ghcr.io/federicokalik/calicchia-radicale:sha-<short>`: nessun `latest`. Il riepilogo del job mostra il tag da scrivere nel compose.

## Variabili e segreti

Nel `.env` dello stack Dockhand (modello: [.env.prod.example](../../.env.prod.example)); il compose le passa ai servizi.

| Variabile | Servizio | Contenuto |
|---|---|---|
| `CALDAV_SERVICE_TOKEN` | api, radicale | Bearer di `verify-credentials` (`openssl rand -hex 32`) |
| `RADICALE_SVC_PASSWORD` | api | password in chiaro di `caldes-svc` |
| `CALDES_SVC_PASSWORD_SHA256` | radicale | sha256 esadecimale minuscolo di `RADICALE_SVC_PASSWORD` |
| `CALDES_PROBE_PASSWORD` | radicale (healthcheck), api | password in chiaro di `caldes-probe` |
| `CALDES_PROBE_PASSWORD_SHA256` | radicale | sha256 di `CALDES_PROBE_PASSWORD` |
| `CALDES_AUTHCACHE_KEY` | radicale | chiave HMAC della cache persistita, almeno 32 caratteri |

Fisse nel compose: `RADICALE_PRINCIPAL=federico`, `CALDES_SVC_CIDR=172.31.250.2/32`, `CALDAV_BACKEND_URL=http://api-int:3001/api/caldav-backend`, `RADICALE_URL=http://radicale-int:5232`, `CALDES_CONTROL_PLANE=on`, i percorsi di policy e heartbeat. Generazione, una volta sola:

```sh
p=$(openssl rand -hex 32); echo "RADICALE_SVC_PASSWORD=$p"; echo "CALDES_SVC_PASSWORD_SHA256=$(printf %s "$p" | sha256sum | cut -d' ' -f1)"
p=$(openssl rand -hex 32); echo "CALDES_PROBE_PASSWORD=$p"; echo "CALDES_PROBE_PASSWORD_SHA256=$(printf %s "$p" | sha256sum | cut -d' ' -f1)"
echo "CALDES_AUTHCACHE_KEY=$(openssl rand -hex 32)"
```

Una variabile obbligatoria assente o malformata fa fallire il caricamento del plugin. In quel caso Radicale non parte e il container resta unhealthy: è voluto, un plugin "a metà" nasconderebbe l'errore.

## Deploy in due commit

Il runbook completo, con i comandi per Dockhand e CloudPanel, è in [docs/portainer-cloudpanel.md §9](../../docs/portainer-cloudpanel.md#9-calendario-su-radicale-deploy-in-due-commit). In sintesi:

1. **Prima del primo deploy, sul server:**
   - verificare che la subnet `172.31.250.0/29` sia libera;
   - verificare che il filesystem dei volumi sia ext4, xfs o btrfs;
   - salvare in un tar il vecchio volume `radicale_data` della Fase 0, se esiste (decisione 7: non va cancellato);
   - aggiungere all'env dello stack le variabili della tabella sopra;
   - aggiornare il vhost `dav.calicchia.design` in CloudPanel (sezione sotto).
2. **Commit 1, l'immagine.** Contiene le modifiche ad `apps/radicale/**` (e il resto del lavoro della fase, migrazione 162 compresa), ma non `docker-compose.portainer.yml`.
   - La CI esegue i test e pubblica `sha-<short>`.
   - Il Radicale in produzione non cambia, perché il compose punta ancora alla vecchia immagine e non c'è più un `latest` che si muove.
   - L'API riparte con il codice nuovo. Il control-plane resta spento finché manca il volume `caldes_control`.
3. **Commit 2, il compose.** Porta in `docker-compose.portainer.yml` il tag `sha-<short>` al posto di `sha-SEGNAPOSTO`, la rete `caldav-int`, i volumi e le variabili. Dockhand ricrea radicale e api:
   - Radicale parte con il volume vuoto e nessuna policy: i device ricevono 403;
   - l'API scrive `policy.json` (shadow, `volume_id: null`) e `heartbeat.json`.
4. **Verifica e inizializzazione** (sezioni sotto).

Una modifica a `config/config` entra in vigore al primo avvio del container, perché il file è montato dal repository. Per questo va fatta solo insieme a un'immagine nuova, con lo stesso flusso in due commit. Il mount è comunque necessario: l'immagine base dichiara `VOLUME /config`, e senza mount Compose riuserebbe a ogni ricreazione il config del primo avvio.

## CloudPanel: vhost `dav.calicchia.design`

Il sito è di tipo **Reverse Proxy** verso `http://127.0.0.1:3011`, con Let's Encrypt. Nelle direttive nginx del sito servono:

```nginx
# Corpo massimo: allineato a max_content_length = 20000000 del config di Radicale.
client_max_body_size 20m;
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-Proto $scheme;
# L'IP del device per il rate limit di verify-credentials e per l'audit. Sostituisce
# sempre un eventuale header mandato dal client. Non è un controllo di sicurezza:
# gli utenti di servizio si riconoscono dal peer TCP, mai da un header.
proxy_set_header X-Remote-Addr     $remote_addr;
# Timeout: Radicale chiude un socket inattivo dopo 30 s; una sincronizzazione completa
# di una collezione grande o una REPORT con expand può durare qualche secondo.
proxy_connect_timeout 10s;
proxy_send_timeout    120s;
proxy_read_timeout    120s;
send_timeout          120s;
client_body_timeout   60s;
# Lasciare il buffering del corpo attivo (default): nginx riceve tutto l'upload prima
# di passarlo a Radicale, così un client lento non occupa uno dei 16 thread.
```

- **Metodi WebDAV.** PROPFIND, REPORT, MKCALENDAR, PROPPATCH e MOVE passano con il `proxy_pass` del sito. Non va aggiunto `limit_except`.
- **`/.well-known/caldav`.** Lo gestisce Radicale da solo (301 verso `/`): non serve nessuna `location`.
- **Cloudflare.** Se il record `dav` passa dal proxy di Cloudflare, `$remote_addr` è l'IP di Cloudflare, a meno che nginx non usi `real_ip` con gli intervalli di Cloudflare. In quel caso il rate limit varrebbe per nodo di Cloudflare e non per device. La scelta più semplice è un record in DNS only (nuvola grigia).
- **Vecchio vhost della Fase 3.** Le righe `client_max_body_size 100M` e `proxy_request_buffering off` vanno tolte.

## Verifica dopo il deploy

`<P>` è il progetto Compose dello stack (`docker compose ls`). `<app-password>` è un'app-password esistente, anche con username diverso da `federico`.

```sh
docker compose -p <P> ps radicale                          # running (healthy)
docker compose -p <P> exec api cat /run/caldes-control/policy.json
#   "backend_mode": "postgres", "mode": "shadow", "volume_id": null, "epoch": 0
docker compose -p <P> exec api cat /run/caldes-control/heartbeat.json   # ts aggiornato ogni 30 s
docker compose -p <P> logs radicale | grep caldes_event | tail

# Da internet:
curl -s -o /dev/null -w '%{http_code}\n' -X PROPFIND -H 'Depth: 0' https://dav.calicchia.design/                          # 401
curl -s -o /dev/null -w '%{http_code}\n' -u 'caldes-svc:<password>' -X PROPFIND -H 'Depth: 0' https://dav.calicchia.design/  # 401: mai da internet
curl -s -o /dev/null -w '%{http_code}\n' -u 'iphone:<app-password>' -X PROPFIND -H 'Depth: 0' https://dav.calicchia.design/  # 207: la root
curl -s -o /dev/null -w '%{http_code}\n' -u 'iphone:<app-password>' -X PROPFIND -H 'Depth: 1' https://dav.calicchia.design/federico/  # 403: volume vuoto
```

Sul volume, dopo questi controlli, non deve esserci nessuna directory del principal:

```sh
ls "$(docker volume inspect -f '{{ .Mountpoint }}' <P>_radicale_collections)/collections/collection-root/"
```

L'elenco deve risultare vuoto.

## Inizializzazione del volume (F1, a mano)

L'unico punto che crea collezioni è l'inizializzazione (contratto §4.4). Nessun componente fa MKCOL o MKCALENDAR in automatico. Dalla F3 la esegue il wizard (`/calendario/migrazione`, passo 1); in F1 si esegue a mano, dentro il container dell'API, con lo script `calendar:radicale-init` (`apps/api/scripts/radicale-init.ts`), che chiama la stessa `initializeVolume()` che userà il wizard.

Prima di eseguirla:
- è facoltativa in F1: serve per il criterio di uscita della fase (un device reale vede `/federico/` in sola lettura);
- crea collezioni **vuote**, una per ogni calendario del sidecar (`c`, `f`, `lavoro`, `personale`, `bookings`, `scadenze`) con le dead prop `calendar-id` e `role`: gli eventi arrivano solo con la F3;
- rifiuta un volume che contiene già il principal e uno stato diverso da `mode=postgres, epoch=0`.

```sh
# Prova a vuoto: stato in PG, principal su Radicale, identità, collezioni che creerebbe
docker compose -p <P> exec api pnpm calendar:radicale-init
# Esecuzione
docker compose -p <P> exec api pnpm calendar:radicale-init -- --apply
```

Lo script stampa un report JSON su stdout e un riepilogo su stderr; exit code 0 (fatto, o prova a vuoto eseguibile), 3 (rifiutato dalle precondizioni, nessuna modifica), 2 (variabili mancanti), 1 (errore). Rieseguito su un volume già inizializzato con identità `ok` crea solo le collezioni che mancano (per esempio un calendario aggiunto dall'admin dopo).

Con `--apply` il report ha `result.volume_id`, `result.epoch: 1` e le collezioni con `status: created` (stesso percorso provato end-to-end da `apps/api/test/integration/radicale-f1-e2e.test.ts`). Il NOTIFY dello stato fa riscrivere subito la policy, con `volume_id` e `epoch: 1`. Poi:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -u 'iphone:<app-password>' -X PROPFIND -H 'Depth: 1' https://dav.calicchia.design/federico/   # 207
curl -s -o /dev/null -w '%{http_code}\n' -u 'iphone:<app-password>' -X PUT -H 'Content-Type: text/calendar' \
  --data-binary @evento.ics https://dav.calicchia.design/federico/lavoro/prova.ics                                     # 403: shadow
```

## Collegare i device

Le credenziali sono le **app-password** (Impostazioni → CalDAV nell'admin), mai la password admin. L'username è `federico`; funzionano anche le app-password create in passato con un altro username.

- **iPhone/iPad:** Impostazioni → Calendario → Account → Aggiungi account → Altro → Aggiungi account CalDAV. Server `dav.calicchia.design`, utente `federico`, password = app-password.
- **macOS:** Calendario → Aggiungi account → Altro account CalDAV → Manuale, con gli stessi dati.
- **Android (DAVx5):** accesso con URL e credenziali, `https://dav.calicchia.design`.
- **Thunderbird:** Nuovo calendario → Sulla rete → CalDAV, URL `https://dav.calicchia.design/federico/<slug>/`, per esempio `/federico/lavoro/`.

In F1 i calendari sono in sola lettura per tutti i device. `bookings`, `f` e `scadenze` restano in sola lettura anche dopo il cutover; le collezioni con prefisso `_` (per esempio `_canary`) non compaiono mai.

## Backup e restore

Un solo script per DB e volume ([scripts/backup-calendar-stack.sh](../../scripts/backup-calendar-stack.sh), design §16.1), da cron sull'host come root ogni 6 h. `scripts/backup-db.sh` resta per compatibilità e delega a questo script.

In ogni run:
1. `pg_dump` completo, con lo stato del backend letto prima e dopo (se modalità o identità cambiano durante il dump il run fallisce);
2. tar del volume `radicale_collections` sotto un lock **condiviso** su `collections/.Radicale.lock`. È il lock di Radicale stesso: durante il tar le scritture dei device attendono e le letture continuano. Sono esclusi `.Radicale.cache`, i temporanei e il lock;
3. un solo `manifest.json` con:
   - ore di dump e snapshot;
   - sha256 e dimensioni dei file;
   - stato del backend;
   - inventario del volume: collezioni, item, token di contenuto, marker `volume-id`/`epoch`;
   - confronto d'identità DB ↔ volume;
4. verifica del run, retention locale (sempre almeno l'ultimo run), copia su MEGA S4 (prima i file, il manifest per ultimo) e retention su S4.

Il dump viene prima dello snapshot, quindi il volume non è mai più vecchio del database. RPO: 6 ore per entrambi.

```sh
# /root/.caldes-backup.env (0600): COMPOSE_PROJECT, BACKUP_DIR, RETENTION_DAYS, S4_*
17 */6 * * * cd /opt/calicchia-design-platform && set -a && . /root/.caldes-backup.env && set +a && ./scripts/backup-calendar-stack.sh >> /var/log/caldes-backup.log 2>&1
```

Le variabili sono descritte in testa allo script e in `.env.prod.example`. `COMPOSE_PROJECT` basta a trovare il container postgres (per `pg_dump` con `docker exec`, alla stessa versione del server) e il volume `<progetto>_radicale_collections`. Serve una copia del repository sull'host (per esempio `git clone` in `/opt/calicchia-design-platform`), con `python3`, `flock` (util-linux) e, per S4, la AWS CLI.

### Restore coordinato

[scripts/restore-calendar-stack.sh](../../scripts/restore-calendar-stack.sh) (design §16.3) prima di modificare qualcosa:
- verifica checksum, gzip e inventario dell'archivio;
- calcola l'identità che risulterà dal ripristino: marker del volume contro `calendar_backend_state`;
- si rifiuta se l'identità sarà `mismatch` (anche per un epoch tornato indietro) o `unverified`, salvo `--accept-identity-mismatch`;
- vuole la conferma esplicita `RIPRISTINA <id>`.

Copie di sicurezza: un dump del database corrente in `pre-restore-<ts>/` e la `collections` corrente spostata in `collections.pre-restore-<ts>`, mai cancellate dallo script.

Dopo il ripristino:
- `restore_guard_until` va a `now() + 48 h` e `rebuild_required` a `true`, quindi la policy è frozen;
- dopo un ripristino del database, `credential_epoch` diventa `max(precedente, ripristinato) + 1`: le cache delle credenziali di Radicale si svuotano e l'epoch non torna mai indietro;
- in `mode=postgres` gira `calendar_sidecar_reconcile()`.

Il ripristino del database ricrea il database (DROP e CREATE). Serve un superutente: con l'immagine ufficiale di Postgres lo è `POSTGRES_USER`.

Procedura:
1. In Dockhand sospendere l'aggiornamento automatico dello stack: un poll potrebbe riavviare i servizi a metà ripristino.
2. Fermare i servizi interessati: `docker compose -p <P> stop radicale api worker`. Con `COMPOSE_PROJECT` lo script verifica che siano fermi.
3. Verificare il run: `./scripts/restore-calendar-stack.sh --verify-only latest` (oppure `s3://<bucket>/calendar-stack/<id>/`).
4. Ripristinare secondo lo scenario:
   - **A, volume perso o corrotto, DB intatto:** `--only volume <run>`;
   - **B, DB perso:** `--only all <run>`, cioè DB e volume dallo stesso manifest;
   - **solo DB, volume intatto:** `--only db <run>`, con l'identità controllata contro il volume corrente.
5. Riavviare i servizi (riprendere lo stack in Dockhand, o `docker compose -p <P> up -d`). Il servizio `migrate` applica le migrazioni più recenti del dump.
6. Controllare la policy: `docker compose -p <P> exec api cat /run/caldes-control/policy.json` deve avere `"mode": "frozen"` con `restore_guard` e `rebuild_required`.
7. Verificare il calendario dall'admin, poi riaprire. In F1, senza indice, lo fa l'admin:
   `docker compose -p <P> exec -T postgres psql -U caldes -d caldes -c "UPDATE calendar_backend_state SET restore_guard_until = NULL, rebuild_required = false WHERE id"`.
8. Eliminare le copie di sicurezza quando non servono più.

Gli eventi creati dai device dopo lo snapshot non ci sono più (RPO). La cache esclusa dal tar si ricostruisce, e i sync-token vecchi non valgono più: i device rifanno una sincronizzazione completa.

### Drill (trimestrale)

Senza toccare la produzione: database di prova nello stesso container postgres e volume in una cartella temporanea.

```sh
cd /opt/calicchia-design-platform && set -a && . /root/.caldes-backup.env && set +a
./scripts/restore-calendar-stack.sh --verify-only latest                                    # copia locale
./scripts/restore-calendar-stack.sh --verify-only "s3://$S4_BUCKET/calendar-stack/<id>/"   # copia off-site
mkdir -p /var/tmp/caldes-drill-vol
env -u COMPOSE_PROJECT PG_CONTAINER="$(docker compose -p "$COMPOSE_PROJECT" ps -q postgres)" DB_NAME=caldes_drill \
  ./scripts/restore-calendar-stack.sh --target-volume-dir /var/tmp/caldes-drill-vol --confirm "RIPRISTINA <id>" latest
# Controlli: lo script confronta già l'inventario del volume con il manifest e stampa l'identità.
docker compose -p "$COMPOSE_PROJECT" exec -T postgres psql -U caldes -d caldes_drill -Atc "SELECT count(*) FROM calendar_events; SELECT mode, epoch FROM calendar_backend_state"
# Pulizia
docker compose -p "$COMPOSE_PROJECT" exec -T postgres psql -U caldes -d postgres -c "DROP DATABASE caldes_drill WITH (FORCE)"
rm -rf /var/tmp/caldes-drill-vol
```

**Esito del drill del 2026-10-09**, in locale: Radicale 3.7.8 nel venv, Postgres 16, database `caldes_f1_ops`, volumi in cartelle temporanee.

| Prova | Esito |
|---|---|
| Lock condiviso tenuto 3 s su un Radicale in esecuzione | GET 200 in 2 ms e PROPFIND 207 in 18 ms durante il lock; la PUT attende 2,7 s e risponde 201 dopo il rilascio |
| Backup durante 121 PUT concorrenti | snapshot coerente di 101 item, `verify` ok, attesa del lock 3 ms |
| Lock esclusivo tenuto (scrittura lunga simulata), `LOCK_TIMEOUT=2` | run fallito dopo 2 s con il motivo, nessuna cartella parziale |
| `initializeVolume()` (la funzione di `calendar:radicale-init -- --apply`), poi backup | marker e 4 collezioni creati, identità DB ↔ volume `ok` nel manifest |
| Scenario A: `collections` cancellata, `--only volume` | 5 collezioni con le dead prop servite di nuovo; l'evento precedente al backup risponde 200, quello successivo 404 (RPO); guardia e rebuild attivi |
| Scenario B: `--only all` dallo stesso manifest, anche con il database cancellato (DROP DATABASE prima del ripristino) | database ricreato e caricato, identità `ok`, `credential_epoch` +1, `calendar_sidecar_reconcile()` senza modifiche; con il database assente nessun dump di sicurezza, con un avviso |
| Snapshot servito da un nuovo processo Radicale | 101 item in PROPFIND, sync-token ricalcolato (cache esclusa ricostruita) |
| Archivio manomesso, identità diversa, epoch più vecchio | ripristino rifiutato (sha256 diverso, `mismatch`, `REGRESSIONE`) |
| Copia su S4 con AWS CLI simulata | ordine file → manifest, retention locale e remota, `S4_UPLOAD=daily` |

Restano da provare sul server, al primo drill reale: la modalità `docker exec` (`COMPOSE_PROJECT`), S4 vero e il volume Docker di produzione. I casi principali sono anche in `apps/api/test/integration/calendar-stack-backup.test.ts`.

## Vecchio volume `radicale_data` della Fase 0

Il compose non lo monta più. Il volume nuovo si chiama `radicale_collections`, apposta per non rimontare quello vecchio. Per la decisione 7 il vecchio volume **non va cancellato**: va salvato in un tar e importato dal wizard della F3 nella collezione `archivio-fase0`, in sola lettura e non bloccante.

```sh
docker volume ls --format '{{.Name}}' | grep radicale_data
docker run --rm -v <P>_radicale_data:/v:ro -v /root:/out alpine \
  tar czf /out/radicale_data-fase0-$(date +%F).tgz -C /v .
```

## Troubleshooting

| Sintomo | Cause e controlli |
|---|---|
| Container unhealthy appena avviato | `docker compose -p <P> logs radicale`: un `caldes_event` con `config_error` indica una variabile mancante o malformata (sha256 non esadecimale minuscolo, `CALDES_AUTHCACHE_KEY` troppo corta, `CALDES_SVC_CIDR` che contiene il loopback) |
| 500 a ogni login di un device | l'API non risponde e la credenziale non è in cache (`backend_error` nei log). Controllare l'API e la rete: `docker compose -p <P> exec radicale wget -qO- http://api-int:3001/api/health` |
| 401 con un'app-password giusta | app-password revocata o scaduta (l'API risponde `401 {ok:false}`), oppure username `caldes-*`; 401 anche per `caldes-svc` da un peer diverso dall'API |
| 403 su `/federico/` | volume non inizializzato, identità diversa da PG (`effective_mode_changed` con `marker` nei log), o policy mai letta dall'avvio di Radicale |
| Device in sola lettura in live | heartbeat assente o vecchio (`heartbeat_stale`): l'API è giù da oltre 10 minuti o non ha il volume `caldes_control`; oppure restore guard o rebuild attivi |
| Lo stack non si aggiorna dopo il commit 2 | il pull fallisce: tag rimasto `sha-SEGNAPOSTO` o non ancora pubblicato; subnet di `caldav-int` sovrapposta (`Pool overlaps`) |
| Diagnosi della discovery di un device | i log `info` hanno già una riga per richiesta. Per il livello `debug`, temporaneamente, nel servizio `radicale` del compose: `command: ["/venv/bin/radicale", "--config", "/config/config", "--logging-level", "debug"]` (un commit, da togliere subito dopo: i log di debug contengono dati personali) |

## Sviluppo e test

```sh
# Radicale 3.7.8 in un venv (come la CI)
python3 -m venv .venv-radicale && .venv-radicale/bin/pip install 'radicale==3.7.8' 'vobject==0.9.9' 'pytest==9.1.1'
PYTHONPATH=apps/radicale/plugins .venv-radicale/bin/python apps/radicale/plugins/caldes_selftest.py apps/radicale/config/config
PYTHONPATH=apps/radicale/plugins .venv-radicale/bin/pytest -p no:cacheprovider apps/radicale/tests
# Integrazione lato API (harness F0)
RADICALE_BIN=$PWD/.venv-radicale/bin/radicale pnpm --filter @calicchia/api test:integration
```

In locale `docker compose build` non serve, e il compose di produzione non ha più `build:`. Per provare l'immagine: `docker build -t calicchia-radicale:dev apps/radicale`. Il selftest gira in build.
