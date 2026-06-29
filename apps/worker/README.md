# apps/worker — Headful capture worker (Fase 3)

> **Stato:** implementato. Traccia architetturale della funzione di
> screenshot del portfolio con browser headful per siti dietro login.

## Contesto

Fase 1 (video in galleria) e Fase 2 (capture headless live + web.archive.org)
sono completate e vivono in `apps/api`:

- `apps/api/src/lib/capture.ts` — libreria puppeteer headless
- `POST /api/projects/:id/capture` — endpoint admin
- `apps/admin/src/components/portfolio/capture-dialog.tsx` — UI

La Fase 2 copre il **90% dei casi**: siti pubblici, screenshot di pagina
singola, restyling via Wayback Machine. Non copre:

- Siti dietro login (area clienti, amministrazioni, e-commerce con account)
- Siti che richiedono interazione (accettare cookie specifici, chiudere
  modal, navigare fino a una certa pagina prima di catturare)

Per questi casi serve un browser **headful** (con UI visibile) che l'utente
può pilotare manualmente per fare login e navigare, poi catturare.

## Perché un worker separato

L'API `apps/api` gira in container Docker su Linux senza display. Lanciare
`puppeteer.launch({ headless: false })` lì dentro richiede:

1. **xvfb** (X virtual framebuffer) per fornire un display ai processi
   che ne richiedono uno
2. **Font e librerie UI** già installate nel Dockerfile dell'API (pesanti,
   ~400MB extra)
3. **Stato di lunga durata** — una sessione browser aperta per minuti,
   non millisecondi come le richieste HTTP

Mettere tutto questo nell'API principale è sbagliato: aumenta la superficie
di attacco, la dimensione dell'immagine, e il ciclo di vita di un browser
non si adatta al modello request/response di Hono.

Un worker dedicato risolve tutto:

- Dockerfile suo, con Chromium + xvfb + font
- Comunicazione via coda (Redis o Postgres LISTEN/NOTIFY) o via HTTP
  interno (polling su un endpoint `/session/:id/status`)
- `userDataDir` per progetto, profilo Chrome persistente → i cookie di
  login sopravvivono tra sessioni

## Architettura proposta

```
┌──────────────┐  POST /api/projects/:id/capture/session/start
│  apps/admin  │ ─────────────────────────────────────────────┐
│  (capture-   │                                              │
│   dialog)    │  ┌────────────────┐   enqueue    ┌──────────┴──────┐
└──────────────┘  │   apps/api     │ ──────────▶  │   apps/worker   │
                  │  (Hono router) │              │  (Node + xvfb)  │
                  │                │  ◀──────────  │  puppeteer      │
                  │                │   result      │  headful        │
                  └────────────────┘              │  userDataDir    │
                                                  │  per progetto    │
                                                  └─────────────────┘
```

### Flow

1. Admin clicca "Apri browser remoto (login)" in `capture-dialog.tsx`
   (pulsante da aggiungere quando `source === 'live'` e feature flag on).
2. `POST /api/projects/:id/capture/session/start` → API scrive un record
   in `capture_sessions` (tabella nuova) con stato `pending` + ritorna
   `{ sessionId, wsUrl? }`.
3. Worker polling su `capture_sessions` (o LISTEN/NOTIFY), picka il
   record, lancia `puppeteer.launch({ headless: false, userDataDir:
   .profiles/<projectId> })` dentro xvfb (`xvfb-run -a`).
4. Worker espone il browser via **noVNC** sul host:port configurato
   (es. `6080`), ritorna URL al admin: `https://worker.local:6080/vnc.html`.
5. Admin apre l'URL in un iframe/new tab, fa login, naviga.
6. Admin clicca "Cattura qui" nel dialog →
   `POST /api/projects/:id/capture/session/:sessionId/snap` →
   API aggiorna la row con `{ status: 'snap_requested', scrollY, viewport }`.
7. Worker picka, fa lo screenshot alla viewport + scroll corrente, salva
   via `uploadFile` (stesso path della Fase 2), aggiorna la row con
   `status: 'snap_done'` + l'URL del webp.
8. Admin polling o SSE sull'endpoint di stato → ottiene l'URL → chiude.
9. `POST /api/projects/:id/capture/session/:sessionId/close` →
   worker chiude browser, persiste `userDataDir`, status `closed`.

### Profilo persistente

Il trick chiave: `userDataDir: path.join(PROFILES_DIR, projectId)`. I
cookie/sessionStorage/localStorage di Chrome sopravvivono tra sessioni.
Quindi dopo il primo login manuale, anche **capture headless successivi**
possono riutilizzare lo stesso `userDataDir` e navigare le pagine
autenticate senza UI. Estensione naturale di `capture.ts`:

```ts
// in apps/api/src/lib/capture.ts, estensione Fase 3
export async function captureSiteAuthenticated(
  opts: CaptureOptions & { profileDir: string }
): Promise<CaptureResult[]> {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: opts.profileDir, // ← riusa il login fatto in headful
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  // ... stesso resto di captureSite
}
```

## Dockerfile (abbozzo)

```dockerfile
FROM node:22-bookworm-slim

# Chromium + xvfb + font per rendering fedele
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV DISPLAY=:99

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY dist ./dist

# xvfb in background, poi il worker
CMD Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &\
    sleep 1 && node dist/index.js
```

## Endpoint API da aggiungere (Fase 3)

In `apps/api/src/routes/projects.ts`:

```ts
projects.post('/:id/capture/session/start', ...)      // crea capture_session
projects.get('/:id/capture/session/:sid', ...)         // stato (per polling admin)
projects.post('/:id/capture/session/:sid/snap', ...)   // richiesta snap a worker
projects.post('/:id/capture/session/:sid/close', ...)  // chiudi + persisti profilo
```

Tabella DB (migration `14X_capture_sessions.sql`):

```sql
CREATE TABLE IF NOT EXISTS capture_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','open','snap_requested','snap_done','closed','error')),
  target_url TEXT,
  profile_dir TEXT NOT NULL,
  vnc_url TEXT,
  last_capture_url TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_capture_sessions_project ON capture_sessions(project_id, created_at DESC);
```

## UI admin da aggiungere (Fase 3)

In `apps/admin/src/components/portfolio/capture-dialog.tsx`:

- Nuova `source: 'live'` → mostra pulsante secondario "Apri browser remoto (login)"
  quando il feature flag `NEXT_PUBLIC_CAPTURE_HEADFUL_ENABLED` è on.
- Dialog secondario "Browser remoto aperto" con:
  - link noVNC (`vnc_url`) apribile in nuova scheda
  - campo "viewport" e "scroll Y" opzionali per lo snap
  - pulsante "Cattura qui" → POST `/session/:sid/snap`
  - stato polling che mostra l'URL del webp quando pronto
  - pulsante "Chiudi sessione"

## Feature flag

```
CAPTURE_HEADFUL_ENABLED=false   # default off in prod
CAPTURE_WORKER_URL=http://worker:3002
CAPTURE_PROFILES_DIR=/data/profiles
CAPTURE_VNC_BASE_URL=https://worker.local:6080
```

## Quando implementare

Quando ti capita un cliente con sito dietro login che vuoi mettere in
portfolio (es. area riservata, dashboard admin, e-commerce con account).
Per tutti i siti pubblici la Fase 2 basta.
