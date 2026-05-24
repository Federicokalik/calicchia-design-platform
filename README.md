# Calicchia Design Platform

> 🟡 **Pre-launch** — infrastruttura deployata su Portainer+CloudPanel da maggio 2026, ma [calicchia.design](https://calicchia.design) serve ancora un esperimento bolt.new in attesa dello switch del dominio. Single-tenant per design: piattaforma ottimizzata per un solo freelancer (il sottoscritto), non un SaaS multi-tenant. In rifinitura: breaking change interni possibili, copertura test parziale, documentazione in aggiornamento.
> 🟡 **Pre-launch** — infrastructure deployed on Portainer+CloudPanel since May 2026, but [calicchia.design](https://calicchia.design) still serves a bolt.new experiment pending the DNS cutover. Single-tenant by design: tuned for a single freelancer (myself), not a multi-tenant SaaS. Still being polished: internal breaking changes possible, partial test coverage, docs in flux.

> Portfolio + gestionale di Federico Calicchia — sito pubblico, area clienti e backoffice in un unico monorepo.
> Federico Calicchia's portfolio + business platform — public site, client area and back-office in a single monorepo.

**🇮🇹 Italiano** · [🇬🇧 English](#-english)

![Home sito-v3](docs/screenshots/sito-home.png)

---

## 🇮🇹 Italiano

### Cos'è

**Calicchia Design Platform** è la piattaforma destinata a [calicchia.design](https://calicchia.design): un monorepo che mette insieme quattro applicazioni interdipendenti. L'infrastruttura è già deployata in produzione (Portainer+CloudPanel) da maggio 2026; il dominio pubblico serve ancora un esperimento [bolt.new](https://bolt.new/~/sb1-qxnunhjf) in attesa del cutover DNS.

| Cosa | A cosa serve |
|------|--------------|
| **Sito pubblico** (`apps/sito-v3`) | Portfolio, servizi, blog, landing SEO, area clienti, checkout pagamenti. È la faccia rivolta al mondo. |
| **API backend** (`apps/api`) | Cervello headless: autenticazione, database, pagamenti, email, storage media, generazione fatture e ricevute. Parlato sia dal sito sia dall'admin. |
| **Admin** (`apps/admin`) | Backoffice privato per gestire clienti, progetti, preventivi, fatture, blog, domini, calendario, email transazionali e tutta la roba che non vede il pubblico. |
| **MCP** (`apps/mcp`) | Server Model Context Protocol per esporre dati e operazioni del gestionale ai modelli AI (Claude, ecc.). |

### A cosa serve (concretamente)

- **Acquisire lead** dalle landing SEO e dal modulo contatti (i18n IT/EN, con Turnstile e doppio canale email).
- **Gestire clienti e progetti** lungo tutto il ciclo: preventivo → accettazione → progetto → fatture → ricevute → archivio.
- **Pagamenti inline** via Stripe Elements (carte, Apple/Google Pay) e PayPal, con link pubblici `/pay/[linkId]` e portale clienti.
- **Pubblicare contenuti** (case study + pillar SEO + blog) bilingue, con admin dedicato e schema.org generato lato server.
- **Automatizzare il routine work**: rinnovi domini, scadenze, notifiche scheduled, log audit, webhook idempotenti.

### Stack

| Layer | Tecnologia |
|-------|------------|
| Sito pubblico | Next.js 16 (App Router, View Transitions API) + React 19 + Tailwind v4 + GSAP 3.14 + Lenis |
| API | Hono + Node 22 + JWT (cookie httpOnly) + Postgres self-hosted |
| Admin | React + Vite + Tailwind v4 + Radix + shadcn/ui |
| MCP | Server Model Context Protocol per integrazione AI |
| Database | PostgreSQL (Docker in dev, self-hosted in prod) |
| Pagamenti | Stripe (inline Elements) + PayPal (sandbox/live) |
| Email | Resend (transazionale critica) + SMTP Vhosting (standard) + MJML template |
| Storage | Filesystem locale `./uploads/` servito su `/media/` (drop-in S3-style) |
| Analytics | GA4 + Mouseflow (consent-gated) + Bugsink self-hosted per error tracking (PII filtrate client-side) |
| Messaging | WhatsApp via gateway GOWA self-hosted con disclaimer GDPR auto-appeso al primo contatto |
| i18n | `next-intl` 4.11 — IT default sui path root, EN su `/en/...` con slug tradotti (`/lavori` ↔ `/en/works`) |

### Struttura monorepo

| App | Porta dev | Package |
|-----|-----------|---------|
| `apps/sito-v3` | **3000** | `@calicchia/sito-v3` |
| `apps/api` | **3001** | `@calicchia/api` |
| `apps/admin` | **5173** | `@calicchia/admin` |
| `apps/mcp` | — | `@calicchia/mcp` |

### Anteprime

| Sito pubblico | Portale clienti | Admin |
|---|---|---|
| ![Home](docs/screenshots/sito-home.png) | ![Portal login](docs/screenshots/portal-login.png) | ![Admin login](docs/screenshots/admin-login.png) |
| ![Lavori](docs/screenshots/sito-lavori.png) | ![Servizi](docs/screenshots/sito-servizi.png) | ![Contatti](docs/screenshots/sito-contatti.png) |

> Gli screenshot vengono rigenerati con `node scripts/readme-screenshots.mjs` mentre i tre dev server sono attivi.

### Setup

#### Prerequisiti

- **Node.js 22.12+** (vedi `engines` in `package.json`)
- **pnpm**
- **Docker** per Postgres locale (oppure un'istanza Postgres già pronta)

#### 1. Clone + install

```bash
git clone <repo-url>
cd calicchia-design-platform
pnpm install
```

#### 2. Configura `.env`

**Un solo file `.env` nella root del monorepo** (mai file `.env` per-app). Copia il template e compila i campi:

```bash
cp .env.example .env
```

Minimi indispensabili per partire in dev:

```env
DATABASE_URL=postgresql://caldes:caldes@localhost:5432/caldes
JWT_SECRET=<openssl rand -base64 32>
API_URL=http://localhost:3001
SITE_URL=http://localhost:3000
```

Opzionali ma comuni: `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `PAYPAL_CLIENT_ID`, `PUBLIC_TURNSTILE_SITE_KEY`, `PUBLIC_GOOGLE_MAPS_KEY`, `GA_MEASUREMENT_ID`, `BUGSINK_DSN`.

#### 3. Database

Avvia Postgres in Docker (porta 5432, utente `caldes`, db `caldes`) e applica le migration:

```bash
pnpm --filter @calicchia/api migrate
```

Le migration vivono in `database/migrations/` numerate progressivamente. Il runner è idempotente (ledger `schema_migrations`) e in produzione gira automaticamente a ogni deploy come container one-shot `migrate` (vedi `docker-compose.prod.yml`) prima dell'avvio dell'api.

#### 4. Avvia i dev server

**Tutto in un colpo solo:**

```bash
pnpm dev:all           # macOS/Linux (dev.sh)
# oppure su Windows:
./dev.bat
```

Oppure singolarmente:

```bash
pnpm dev               # sito-v3   http://localhost:3000
pnpm dev:api           # api       http://localhost:3001
pnpm dev:admin         # admin     http://localhost:5173
```

### Convenzioni

- **Lingua UI**: italiano. **Lingua codice/identificatori**: inglese.
- **Sito-v3 è server-component-first**: `'use client'` solo dove serve interattività, hook o GSAP.
- **Mai Barba/Swup su Next 16** — le transizioni di pagina usano Native View Transitions API + un overlay GSAP coordinato.
- **Design tokens da CSS variables**: niente colori/pesi/opacità hardcoded.
- Lo stato d'implementazione è tracciato in `GDPR-COMPLIANCE.md` e nei file in `docs/`.

### Privacy & compliance

| Area | Cosa fa |
|------|---------|
| **Cookie consent** | Banner con Accept/Reject equipollenti (Garante 2021 §6), vendor disclosure granulare, finestra di silenzio 6 mesi sul rifiuto |
| **PII scrubber** | Hook `beforeSend` Sentry condiviso client/server/edge: email, telefono IT, IBAN, codice fiscale, IP, Bearer token rimossi prima dell'invio a Bugsink (legitimate interest art. 6(1)(f)) |
| **Newsletter** | Double opt-in con timestamp + IP + user-agent come prova del consenso (art. 7 GDPR, Decisione Garante 330/2025) |
| **Data retention** | Anonimizzazione automatica di customers/leads post-10-anni dall'ultima attività fiscale (cron daily, allineato art. 2220 c.c.) |
| **Portale clienti** | Gate di accettazione T&C + DPA prima del primo accesso, con scroll-to-bottom obbligatorio e audit trail IP/UA. Bypass per chi ha già preventivi accettati |
| **WhatsApp** | Disclaimer GDPR auto-appeso al primo contatto outbound (gestione preferenze + opt-out "STOP") |
| **Documenti legali** | Privacy Policy, Cookie Policy, T&C (18 sezioni con diritti consumatore + ODR EU), DPA standard art. 28 GDPR su `/dpa-clienti` |

Checklist completa in [`GDPR-COMPLIANCE.md`](./GDPR-COMPLIANCE.md).

### Build & deploy

```bash
pnpm build                              # build tutti i workspace
pnpm --filter @calicchia/sito-v3 build     # solo sito
pnpm --filter @calicchia/api build         # solo api (tsc)
pnpm --filter @calicchia/admin build       # solo admin
```

Il sito-v3 va su un Node host (SSR), l'admin come SPA statica, l'api dietro un reverse proxy.

**Deploy in produzione:** ogni push su `main` builda l'immagine Docker dell'app interessata e la pubblica su `ghcr.io/federicokalik/calicchia-{api,sito,admin}` (workflow `.github/workflows/build-*-image.yml`). **Portainer** (stack `docker-compose.portainer.yml`) ridistribuisce dietro un reverse proxy **CloudPanel** che termina TLS via Let's Encrypt. Le migration sono applicate da un container one-shot `migrate` che gira prima dell'api a ogni redeploy (`service_completed_successfully`). La knowledge base AI dell'api non è dentro l'immagine: arriva a runtime da MEGA S4.

### Licenza

AGPL-3.0-or-later — vedi [LICENSE](LICENSE).

---

## 🇬🇧 English

### What it is

**Calicchia Design Platform** is the platform meant for [calicchia.design](https://calicchia.design): a monorepo bundling four interlocking apps. The infrastructure has been deployed in production (Portainer+CloudPanel) since May 2026; the public domain still serves a [bolt.new](https://bolt.new/~/sb1-qxnunhjf) experiment pending the DNS cutover.

| What | What it does |
|------|--------------|
| **Public site** (`apps/sito-v3`) | Portfolio, services, blog, SEO landing pages, client area, payment checkout. The public-facing surface. |
| **Backend API** (`apps/api`) | Headless brain: auth, database, payments, email, media storage, invoice/receipt generation. Used by both the site and the admin. |
| **Admin** (`apps/admin`) | Private back-office to manage customers, projects, quotes, invoices, blog, domains, calendar, transactional email and everything else not user-facing. |
| **MCP** (`apps/mcp`) | Model Context Protocol server that exposes back-office data and operations to AI models (Claude, etc.). |

### What it's for

- **Capture leads** via SEO landings and the contact form (i18n IT/EN, Turnstile, dual email channel).
- **Manage customers & projects** through the full lifecycle: quote → acceptance → project → invoices → receipts → archive.
- **Inline payments** via Stripe Elements (cards, Apple/Google Pay) and PayPal, with public `/pay/[linkId]` links and a client portal.
- **Publish content** (case studies + SEO pillars + blog) bilingual, with a dedicated admin and server-side schema.org.
- **Automate routine work**: domain renewals, deadlines, scheduled notifications, audit logs, idempotent webhooks.

### Stack

| Layer | Technology |
|-------|------------|
| Public site | Next.js 16 (App Router, View Transitions API) + React 19 + Tailwind v4 + GSAP 3.14 + Lenis |
| API | Hono + Node 22 + JWT (httpOnly cookie) + self-hosted Postgres |
| Admin | React + Vite + Tailwind v4 + Radix + shadcn/ui |
| MCP | Model Context Protocol server for AI integration |
| Database | PostgreSQL (Docker in dev, self-hosted in prod) |
| Payments | Stripe (inline Elements) + PayPal (sandbox/live) |
| Email | Resend (critical transactional) + SMTP Vhosting (standard) + MJML templates |
| Storage | Local filesystem `./uploads/` served on `/media/` (S3-style drop-in) |
| Analytics | GA4 + Mouseflow (consent-gated) + self-hosted Bugsink error tracking (PII scrubbed client-side) |
| Messaging | WhatsApp via self-hosted GOWA gateway, with GDPR disclaimer auto-appended on first outbound |
| i18n | `next-intl` 4.11 — IT default on root paths, EN under `/en/...` with translated slugs (`/lavori` ↔ `/en/works`) |

### Monorepo layout

| App | Dev port | Package |
|-----|----------|---------|
| `apps/sito-v3` | **3000** | `@calicchia/sito-v3` |
| `apps/api` | **3001** | `@calicchia/api` |
| `apps/admin` | **5173** | `@calicchia/admin` |
| `apps/mcp` | — | `@calicchia/mcp` |

### Previews

| Public site | Client portal | Admin |
|---|---|---|
| ![Home](docs/screenshots/sito-home-en.png) | ![Portal login](docs/screenshots/portal-login.png) | ![Admin login](docs/screenshots/admin-login.png) |
| ![Works](docs/screenshots/sito-lavori.png) | ![Services](docs/screenshots/sito-servizi.png) | ![Contact](docs/screenshots/sito-contatti.png) |

> Regenerate with `node scripts/readme-screenshots.mjs` while all three dev servers are up.

### Setup

#### Prerequisites

- **Node.js 22.12+** (see `engines` in `package.json`)
- **pnpm**
- **Docker** for local Postgres (or an already-running Postgres instance)

#### 1. Clone & install

```bash
git clone <repo-url>
cd calicchia-design-platform
pnpm install
```

#### 2. Configure `.env`

**A single `.env` file at the monorepo root** (never per-app `.env` files). Copy the template and fill in the values:

```bash
cp .env.example .env
```

Bare minimum to boot in dev:

```env
DATABASE_URL=postgresql://caldes:caldes@localhost:5432/caldes
JWT_SECRET=<openssl rand -base64 32>
API_URL=http://localhost:3001
SITE_URL=http://localhost:3000
```

Optional but common: `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `PAYPAL_CLIENT_ID`, `PUBLIC_TURNSTILE_SITE_KEY`, `PUBLIC_GOOGLE_MAPS_KEY`, `GA_MEASUREMENT_ID`, `BUGSINK_DSN`.

#### 3. Database

Start Postgres in Docker (port 5432, user `caldes`, db `caldes`) and apply migrations:

```bash
pnpm --filter @calicchia/api migrate
```

Migrations live in `database/migrations/`, numbered sequentially. The runner is idempotent (ledger `schema_migrations`) and in production it auto-runs at every deploy via a one-shot `migrate` container that completes before the api starts (see `docker-compose.prod.yml`).

#### 4. Run dev servers

**All at once:**

```bash
pnpm dev:all           # macOS/Linux (dev.sh)
# or on Windows:
./dev.bat
```

Or individually:

```bash
pnpm dev               # sito-v3   http://localhost:3000
pnpm dev:api           # api       http://localhost:3001
pnpm dev:admin         # admin     http://localhost:5173
```

### Conventions

- **UI language**: Italian. **Code/identifiers**: English.
- **sito-v3 is server-component-first**: `'use client'` only when you need interactivity, hooks or GSAP.
- **Never Barba/Swup on Next 16** — page transitions use the native View Transitions API + a coordinated GSAP overlay.
- **Design tokens via CSS variables**: never hardcode colors, weights or opacity.
- Implementation status is tracked in `GDPR-COMPLIANCE.md` and the files under `docs/`.

### Privacy & compliance

| Area | What it does |
|------|--------------|
| **Cookie consent** | Banner with equally-weighted Accept/Reject (Garante Italia 2021 §6), granular vendor disclosure, 6-month silence window on reject |
| **PII scrubber** | Shared Sentry `beforeSend` hook (client / server / edge): emails, IT phones, IBAN, fiscal codes, IPs, Bearer tokens stripped before reaching Bugsink (legitimate interest, GDPR art. 6(1)(f)) |
| **Newsletter** | Double opt-in with timestamp + IP + user-agent as consent proof (GDPR art. 7, Garante decision 330/2025) |
| **Data retention** | Automatic anonymisation of customers/leads after 10 years from last fiscal activity (daily cron, aligned with art. 2220 Italian civil code) |
| **Client portal** | T&C + DPA acceptance gate on first login, with scroll-to-bottom requirement and IP/UA audit trail. Whitelisted for customers with already-accepted quotes |
| **WhatsApp** | GDPR disclaimer auto-appended to the first outbound message to any new phone (preferences URL + "STOP" opt-out) |
| **Legal documents** | Privacy Policy, Cookie Policy, T&C (18 sections including consumer rights + EU ODR), GDPR art. 28 standard DPA at `/dpa-clienti` |

Full checklist in [`GDPR-COMPLIANCE.md`](./GDPR-COMPLIANCE.md).

### Build & deploy

```bash
pnpm build                              # build every workspace
pnpm --filter @calicchia/sito-v3 build     # site only
pnpm --filter @calicchia/api build         # api only (tsc)
pnpm --filter @calicchia/admin build       # admin only
```

sito-v3 ships to a Node host (SSR), the admin as a static SPA, the api behind a reverse proxy.

**Production deploy:** every push to `main` builds the Docker image of the affected app and publishes it to `ghcr.io/federicokalik/calicchia-{api,sito,admin}` (workflows `.github/workflows/build-*-image.yml`). **Portainer** redeploys the stack (`docker-compose.portainer.yml`) behind a **CloudPanel** reverse proxy that terminates TLS via Let's Encrypt. Database migrations are applied by a one-shot `migrate` container that runs before the api on every redeploy (`service_completed_successfully`). The api's AI knowledge base is not baked into the image: it is fetched at runtime from MEGA S4.

### License

AGPL-3.0-or-later — see [LICENSE](LICENSE).

---

Built with Next.js 16, React 19, Hono, Postgres and a stubborn preference for owning the stack.
