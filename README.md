# Caldes 2026

> ⚠️ **Alpha** — Progetto ancora in fase alpha. Non production-ready: API instabili, breaking change attesi, copertura test parziale, documentazione in evoluzione.
> ⚠️ **Alpha** — Project is still in alpha. Not production-ready: APIs unstable, breaking changes expected, partial test coverage, docs are a moving target.

> Portfolio + gestionale di Federico Calicchia — sito pubblico, area clienti e backoffice in un unico monorepo.
> Federico Calicchia's portfolio + business platform — public site, client area and back-office in a single monorepo.

**🇮🇹 Italiano** · [🇬🇧 English](#-english)

![Home sito-v3](docs/screenshots/sito-home.png)

---

## 🇮🇹 Italiano

### Cos'è

**Caldes 2026** è la piattaforma su cui girerà [calicchia.design](https://calicchia.design): un monorepo che mette insieme quattro applicazioni interdipendenti.
(attualmente calicchia.design è un esperimento realizzato con [bolt.new](https://bolt.new/~/sb1-qxnunhjf) e questa piattaforma non è ancora attiva)

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
| Analytics | GA4 + Mouseflow (consent-gated) + Bugsink per error tracking |
| i18n | `next-intl` 4.11 — IT default sui path root, EN su `/en/...` con slug tradotti (`/lavori` ↔ `/en/works`) |

### Struttura monorepo

| App | Porta dev | Package |
|-----|-----------|---------|
| `apps/sito-v3` | **3000** | `@caldes/sito-v3` |
| `apps/api` | **3001** | `@caldes/api` |
| `apps/admin` | **5173** | `@caldes/admin` |
| `apps/mcp` | — | `@caldes/mcp` |

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
cd Sito-Gestionale-public-clean
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
pnpm --filter @caldes/api migrate
```

Le migration vivono in `database/migrations/` numerate progressivamente.

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
- Lo stato d'implementazione è tracciato nei vari `*.md` in root e `docs/`.

### Build & deploy

```bash
pnpm build                              # build tutti i workspace
pnpm --filter @caldes/sito-v3 build     # solo sito
pnpm --filter @caldes/api build         # solo api (tsc)
pnpm --filter @caldes/admin build       # solo admin
```

Il sito-v3 va su un Node host (SSR), l'admin come SPA statica, l'api dietro un reverse proxy.

### Licenza

MIT — vedi [LICENSE](LICENSE).

---

## 🇬🇧 English

### What it is

**Caldes 2026** is the platform that will power [calicchia.design](https://calicchia.design): a monorepo bundling four interlocking apps.
(At the moment, calicchia.design is an experiment built with [bolt.new](https://bolt.new/~/sb1-qxnunhjf) and this platform is not yet active.)

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
| Analytics | GA4 + Mouseflow (consent-gated) + Bugsink error tracking |
| i18n | `next-intl` 4.11 — IT default on root paths, EN under `/en/...` with translated slugs (`/lavori` ↔ `/en/works`) |

### Monorepo layout

| App | Dev port | Package |
|-----|----------|---------|
| `apps/sito-v3` | **3000** | `@caldes/sito-v3` |
| `apps/api` | **3001** | `@caldes/api` |
| `apps/admin` | **5173** | `@caldes/admin` |
| `apps/mcp` | — | `@caldes/mcp` |

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
cd Sito-Gestionale-public-clean
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
pnpm --filter @caldes/api migrate
```

Migrations live in `database/migrations/`, numbered sequentially.

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
- Implementation notes are tracked in the various `*.md` files at the repo root and in `docs/`.

### Build & deploy

```bash
pnpm build                              # build every workspace
pnpm --filter @caldes/sito-v3 build     # site only
pnpm --filter @caldes/api build         # api only (tsc)
pnpm --filter @caldes/admin build       # admin only
```

sito-v3 ships to a Node host (SSR), the admin as a static SPA, the api behind a reverse proxy.

### License

GPLv3 — see [LICENSE](LICENSE).

---

Built with Next.js 16, React 19, Hono, Postgres and a stubborn preference for owning the stack.
