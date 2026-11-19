# Servizio `backup` dello stack

Il servizio esegue il backup coordinato di database e calendario dall'interno dello stack, senza cron sull'host. Salva insieme il dump del database e lo snapshot del volume di Radicale, con la stessa identità. Gira ogni 6 ore e quando l'admin lo chiede da **Impostazioni → Backup → Esegui backup ora**.

Il backup vero lo fa lo script di sempre, [`scripts/backup-calendar-stack.sh`](../../scripts/backup-calendar-stack.sh). Lo script gestisce:
- il lock condiviso di Radicale;
- il manifest con i checksum;
- la verifica dell'identità tra database e volume;
- la retention;
- la copia su MEGA S4;
- l'alert Telegram;
- la registrazione in `calendar_backend_state.last_stack_backup`.

Il servizio aggiunge solo la pianificazione e il collegamento con l'admin, nel file [`runner.sh`](runner.sh).

## Come funziona

```
admin ── POST /api/backup/stack/run ──▶ API ── INSERT ──▶ stack_backup_runs (queued)
                                                              │
backup (runner.sh, ogni 30 s) ── heartbeat ──▶ stack_backup_agent
                               ── prende il run in coda ──▶ backup-calendar-stack.sh
                               ── esito, id, copia S4, log ──▶ stack_backup_runs
```

- **L'API non esegue mai il backup.** Mette in coda la richiesta e legge lo stato. Se l'API è ferma o riparte di continuo, i backup pianificati girano lo stesso.
- **Un run alla volta.** L'indice unico parziale della migrazione 173 rifiuta una seconda richiesta con `409 BACKUP_ALREADY_ACTIVE`.
- **Servizio fermo.** Se il heartbeat ha più di 3 minuti, l'API rifiuta la richiesta con `409 BACKUP_AGENT_OFFLINE`, invece di lasciarla in coda senza che nessuno la esegua.
- **Pianificazione.** Il prossimo run parte dall'ultimo run pianificato più `BACKUP_INTERVAL_HOURS`. Se l'ultimo è fallito o incompleto, parte dopo `BACKUP_RETRY_HOURS`. Al primo avvio il run parte subito. La pianificazione sta nel database, quindi sopravvive ai riavvii del container, per esempio dopo il git-sync.
- **Run interrotti.** Un run rimasto "in corso", per esempio perché il container è stato fermato a metà, viene chiuso come fallito al riavvio.

### Privilegi

- **Database:** il servizio raggiunge il database con `DATABASE_URL` (modalità url dello script). `pg_dump` e `psql` vengono dall'immagine `postgres:17-alpine`, con la stessa versione maggiore del server. Non serve il socket Docker, quindi il container non ha accesso root all'host.
- **Volume di Radicale:** è montato **in sola lettura**. Lo script apre `collections/.Radicale.lock` in lettura e prende il lock condiviso con `flock -s`, che funziona anche da un altro container.
- **Capability:** il container gira con `cap_drop: ALL` più `DAC_READ_SEARCH`, che serve per leggere i file di Radicale di un altro utente. Ha anche `no-new-privileges`.

## Configurazione

| Variabile | Default | Note |
|---|---|---|
| `DATABASE_URL` | obbligatoria | Stessa dell'API |
| `RADICALE_VOLUME_DIR` | | `/radicale-data` (mount `:ro` di `radicale_collections`) |
| `BACKUP_DIR` | `/backups` | Volume `stack_backups` |
| `RETENTION_DAYS` | 30 | Retention locale e su S4 |
| `BACKUP_INTERVAL_HOURS` | 6 | Da 1 a 168 |
| `BACKUP_RETRY_HOURS` | 1 | Attesa dopo un run pianificato fallito o incompleto |
| `BACKUP_POLL_SECONDS` | 30 | Durata di un giro del ciclo |
| `BACKUP_RUN_TIMEOUT_SECONDS` | 3600 | Durata massima di un run |
| `S4_ENDPOINT`, `S4_REGION`, `S4_BUCKET`, `S4_ACCESS_KEY_ID`, `S4_SECRET_ACCESS_KEY` | | Senza endpoint e bucket il backup resta solo locale |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (o `ALERT_TELEGRAM_*`) | | Alert dei run falliti o incompleti |
| `CALDES_BACKUP_VERSION` | `unversioned` | Tag dell'immagine, mostrato nell'admin |

L'admin vede solo se S4 e gli alert sono configurati, mai i valori.

## Deploy in due commit

L'immagine ha solo il tag `sha-<short>`, come Radicale, quindi il deploy avviene in due commit.

1. **Commit 1** (codice, migrazione 173, immagine): unito su main, `build-backup-image` pubblica `ghcr.io/federicokalik/calicchia-backup:sha-<short>`. Anche `build-api-image` pubblica la nuova immagine dell'API, che contiene la migrazione e le route.
2. **Commit 2** (compose): in `docker-compose.portainer.yml` va aggiunto il servizio sotto, con il tag del commit 1, e va aggiunto `stack_backups:` fra i volumi. Va anche aggiornato il pin dell'API (`api`, `migrate` e `CALDES_API_VERSION`) allo stesso sha. Poi in Dockhand si lancia "Git deploy".

```yaml
  # Backup coordinato (database e volume di Radicale) ogni 6 h e su richiesta
  # dall'admin (Impostazioni → Backup). apps/backup/README.md.
  backup:
    image: ghcr.io/federicokalik/calicchia-backup:sha-<short>
    restart: always
    init: true
    cap_drop: [ALL]
    cap_add: [DAC_READ_SEARCH]
    security_opt:
      - no-new-privileges:true
    environment:
      DATABASE_URL: postgresql://${DB_USER}:${DB_PASSWORD}@postgres:5432/${DB_NAME}
      CALDES_BACKUP_VERSION: sha-<short>
      RADICALE_VOLUME_DIR: /radicale-data
      BACKUP_DIR: /backups
      RETENTION_DAYS: 30
      BACKUP_INTERVAL_HOURS: 6
      S4_ENDPOINT: ${S4_ENDPOINT}
      S4_REGION: ${S4_REGION}
      S4_BUCKET: ${S4_BUCKET}
      S4_ACCESS_KEY_ID: ${S4_ACCESS_KEY_ID}
      S4_SECRET_ACCESS_KEY: ${S4_SECRET_ACCESS_KEY}
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID}
      TZ: UTC
    volumes:
      - radicale_collections:/radicale-data:ro
      - stack_backups:/backups
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    networks:
      - app-net
```

Dopo il deploy:

- In Impostazioni → Backup il servizio risulta attivo e il primo run pianificato parte subito.
- Con un run completo, va tolto il cron dell'host (`crontab -e`, riga di `backup-calendar-stack.sh`), altrimenti i backup diventano doppi. Va tolto anche `/root/.caldes-backup.env`, perché contiene le chiavi S4.

## Ripristino

Il ripristino resta manuale, dal terminale dell'host. È voluto: è un'operazione rara e distruttiva. I backup del servizio stanno nel volume `stack_backups` (`docker volume inspect <progetto>_stack_backups` per il percorso) e su S4 in `calendar-stack/<id>/`. Si ripristinano con [`scripts/restore-calendar-stack.sh`](../../scripts/restore-calendar-stack.sh), come quelli del cron (vedi `docs/portainer-cloudpanel.md` §10).
