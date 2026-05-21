# Deploy — Caldes 2026 (VPS + Dokploy)

Guida operativa creata nella **Wave 7** dell'audit go-live. Target: VPS con **Dokploy**
(Traefik + Let's Encrypt integrati).

## Artefatti creati in Wave 7

| File | Scopo |
|------|-------|
| `apps/api/Dockerfile` | Immagine API (Node 22, multi-stage, KB markdown + Chromium per i PDF) |
| `apps/sito-v3/Dockerfile` | Immagine sito (Next.js 16 standalone) |
| `apps/admin/Dockerfile` + `apps/admin/nginx.conf` | Immagine admin (SPA Vite servita da nginx, proxy `/api`→api) |
| `.dockerignore` | Riduce il build context |
| `docker-compose.prod.yml` | Stack di produzione Dokploy-compatibile (Traefik labels, volumi) |
| `.github/workflows/ci.yml` | CI: typecheck + lint + build di tutti i workspace + smoke e2e API |
| `scripts/backup-db.sh` / `restore-db.sh` | Backup/restore Postgres con retention |
| `.env.prod.example` | Template env di produzione |
| `apps/sito-v3/next.config.ts` | Patch: aggiunto `output: 'standalone'` |

## Procedura di deploy su Dokploy

1. **Rete:** Dokploy fornisce la rete esterna `dokploy-network` — già referenziata dal compose.
2. **Progetto:** crea un progetto Dokploy → servizio tipo **Compose** → punta a
   `docker-compose.prod.yml`.
3. **Env:** copia `.env.prod.example` nel campo Environment del progetto Dokploy e compila i
   valori. Genera i segreti con `openssl rand -hex 32`.
4. **DNS:** punta i record A di `SITE_DOMAIN`, `ADMIN_DOMAIN`, `API_DOMAIN` all'IP del VPS.
5. **Deploy:** Dokploy builda le 3 immagini e avvia lo stack; Traefik emette i certificati
   TLS automaticamente (entrypoint `websecure`, resolver `letsencrypt`).
6. **Knowledge base AI:** `pricing_knowledge_base.md` e `profile_knowledge_base.md`
   sono gitignored (dati reali) → NON sono nel build context. Caricali una volta sul
   bucket MEGA S4 in `kb/` (vedi sezione *Object storage* sotto): l'API li scarica al
   boot. Senza, `assertKBsValid()` blocca l'avvio.
7. **Migrazioni:** al primo avvio esegui le migrazioni —
   `docker compose exec api node --import tsx scripts/migrate.ts` oppure, da host con
   `DATABASE_URL` impostata, `pnpm --filter @caldes/api migrate`.
8. **Backup:** aggiungi un cron sul VPS — `0 3 * * * cd /repo && ./scripts/backup-db.sh`.
   Con le env `S4_*` impostate il backup viene anche copiato off-site su MEGA S4.

## Object storage (MEGA S4)

Provider S3-compatible unico del progetto. Configurato via le env `S4_*`
(`.env.prod.example`). Tre usi:

- **Consegna knowledge base.** Carica i file gitignored su `s3://$S4_BUCKET/kb/`
  (`aws s3 cp pricing_knowledge_base.md s3://$S4_BUCKET/kb/ --endpoint-url $S4_ENDPOINT`).
  Al boot `kb-bootstrap.ts` li scarica in `/data/kb` (`KB_DIR`) prima di
  `assertKBsValid()`. Senza `S4_*` l'API legge i KB da disco (solo dev).
- **Backup DB off-site.** `backup-db.sh`, con `S4_*` impostate, carica il dump su
  `s3://$S4_BUCKET/db/`. Restore: `./scripts/restore-db.sh s3://$S4_BUCKET/db/<file>`.
- **Backup immagini off-site.** `backup-db.sh` sincronizza `UPLOAD_DIR` su
  `s3://$S4_BUCKET/uploads/`. Poiché in produzione gli upload sono nel volume Docker
  `uploads_data`, lo script di backup deve poter leggere quei file: o si esegue da un
  container che monta `uploads_data`, oppure si imposta `UPLOAD_DIR` sul path host del
  volume (`/var/lib/docker/volumes/<progetto>_uploads_data/_data`).

Serve la **AWS CLI** sull'host per il job di backup; l'API container usa invece
`@aws-sdk/client-s3` (già in dipendenze) — nessuna CLI nell'immagine.

## CI/CD

`.github/workflows/ci.yml` gira su PR e push a `main`: typecheck, lint, build di tutti i
workspace, smoke e2e API contro un Postgres effimero. Il job `deploy` notifica Dokploy su
push a `main` (dopo `quality` + `api-e2e`): imposta il secret GitHub
`DOKPLOY_DEPLOY_WEBHOOK` con l'URL del webhook di deploy del progetto Dokploy — se il
secret non è impostato lo step viene saltato senza far fallire la CI.

## Caveat noti (da chiudere — vedi i report di audit)

- **Admin build (AD-01):** `apps/admin/Dockerfile` e il job `build` della CI **falliscono**
  finché non si rimuove l'import inutilizzato `X` in `apps/admin/src/pages/spese/index.tsx:5`.
  È il finding BLOCKER B1: la CI lo intercetta correttamente. Fix = 1 riga.
- **Puppeteer/Chromium:** l'immagine API include Chromium di sistema
  (`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser`) perché pnpm salta il download del
  browser bundlato; serve per la generazione PDF di preventivi/ricevute.
- **Cron in-process:** i 14 cron job girano dentro il processo API. **Non scalare l'API oltre
  1 replica** senza prima introdurre un lock (finding BK-10/DP-09), altrimenti i job si
  duplicano.
- **Upload su volume:** i media sono serviti dal volume Docker `uploads_data`; MEGA S4
  ne tiene solo la copia di backup (vedi sezione *Object storage*). Con più repliche il
  filesystem non è condiviso → servire i media da S4 (finding DP-04, post-launch).
- **`CORS_ORIGINS` obbligatorio:** l'API rifiuta il boot in produzione se vuoto.
- **Retention GDPR:** non gira automaticamente (finding GDPR-02) — va schedulata nel cron
  engine prima di trattare dati reali.

## Verifica build (eseguita in Wave 7)

Vedi `TRACKING.md` § Wave 7 per l'esito delle build Docker effettuate durante l'audit.
