# Client Portal - Architettura tecnica

> Documento di riferimento per il portale clienti e lo storage hub del monorepo.

## Obiettivo

Il client portal espone una SPA riservata ai clienti per consultare progetti, timeline, deliverable, messaggi, file, fatture, scadenze e report. Le API amministrative permettono al gestionale interno di alimentare lo stesso dominio applicativo senza accedere direttamente al database.

Il portale e' multi-cliente: ogni richiesta e' filtrata dal codice cliente o da credenziali admin server-side. Il backend resta l'unico livello autorizzato a leggere e scrivere su PostgreSQL.

## Stack

- Runtime: Node.js con pnpm.
- Backend: Hono su Node runtime.
- Frontend: React + Vite SPA.
- Database: PostgreSQL, schema SQL/Drizzle dove previsto.
- Storage upload clienti: MEGA S4, compatibile S3 Signature V4.
- Storage CDN pubblico: Cloudflare R2 per asset pubblicati.
- Notifiche: Telegram Bot API ed email transazionali via Resend.
- Routing frontend: react-router-dom.
- Icone frontend: lucide-react.
- Date: date-fns con locale `it`.

## Storage

```text
Cliente -> upload multipart presigned PUT -> MEGA S4 (bucket client-uploads)
MEGA S4 -> mirror schedulato -> storage locale di backup

Admin -> publish asset approvati -> Cloudflare R2 (bucket cdn-assets)
Cloudflare R2 -> CDN pubblico -> dominio CDN
```

MEGA S4 contiene i file caricati dai clienti e i documenti riservati. Cloudflare R2 contiene solo asset deliberatamente pubblicati, come immagini portfolio, contenuti editoriali o file statici destinati a CDN.

## Moduli applicativi

```text
apps/api
  src/index.ts
  src/routes/upload.ts
  src/routes/client.ts
  src/routes/projects.ts
  src/routes/timeline.ts
  src/routes/deliverables.ts
  src/routes/invoices.ts
  src/routes/messages.ts
  src/routes/renewals.ts
  src/routes/files.ts
  src/routes/reports.ts
  src/routes/webhook.ts
  src/lib/s3.ts
  src/lib/r2.ts
  src/lib/telegram.ts
  src/lib/email.ts
  src/lib/auth.ts
  src/middleware/rateLimit.ts
  src/middleware/clientAuth.ts

apps/web
  src/main.tsx
  src/App.tsx
  src/layouts/PortalLayout.tsx
  src/pages/Login.tsx
  src/pages/Dashboard.tsx
  src/pages/Projects.tsx
  src/pages/ProjectDetail.tsx
  src/pages/Upload.tsx
  src/pages/Files.tsx
  src/pages/Invoices.tsx
  src/pages/Reports.tsx
  src/pages/ReportDetail.tsx
  src/components/*
  src/hooks/useMultipartUpload.ts
  src/hooks/useClient.ts
  src/hooks/usePolling.ts
  src/lib/api.ts
  src/lib/formatters.ts
```

## Entita' principali

- `clients`: anagrafica cliente, codice di accesso, logo, stato attivo.
- `projects`: progetti cliente, stato, staging URL, pipeline custom e metadata.
- `timeline_events`: feed eventi per progetto e azioni richieste.
- `deliverables`: file o bozze da approvare, versioni e commenti review.
- `messages`: thread cliente/admin per progetto.
- `invoices`: fatture, stati pagamento, PDF e payment link.
- `renewals`: scadenze operative come hosting, dominio, SSL o manutenzione.
- `reports`: report mensili pubblicati al cliente.
- `uploads`: file caricati dai clienti con provider, bucket, key e metadata.
- `notifications`: log notifiche inviate.

## Upload multipart MEGA S4

Vincoli tecnici:

- Endpoint: `https://s3.eu-central-1.s4.mega.io`.
- Autenticazione presigned URL con Signature V4.
- Presigned POST non supportato: usare presigned PUT.
- Multipart supportato con `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListParts`.
- `UploadPart` puo' restituire `EntityTooSmall` prima del complete; in quel caso l'upload va abortito.
- Configurare `forcePathStyle: true` nell'S3Client.

Pattern operativo:

```text
POST /api/upload/init
  -> CreateMultipartUpload, calcolo key e totalParts

POST /api/upload/url
  -> genera URL fresco per partNumber con scadenza 600 secondi

PUT diretto frontend -> presigned URL S4
  -> se 403, richiedere nuovo URL per lo stesso partNumber e riprovare

POST /api/upload/done
  -> CompleteMultipartUpload, persistenza su PostgreSQL, evento timeline, notifica

POST /api/upload/abort
  -> AbortMultipartUpload per upload incompleti
```

Parametri consigliati:

- Chunk size: 10 MB.
- Concorrenza: massimo 3 upload paralleli.
- Retry: massimo 5 tentativi con backoff esponenziale.
- Presigned URL: 600 secondi.
- File size massimo: 500 MB.
- Tipi permessi: immagini, PDF, archivi, Office, video e file design.

## Config S3

```ts
import { S3Client } from '@aws-sdk/client-s3';

export const s4Client = new S3Client({
  region: 'eu-central-1',
  endpoint: 'https://s3.eu-central-1.s4.mega.io',
  credentials: {
    accessKeyId: process.env.S4_ACCESS_KEY!,
    secretAccessKey: process.env.S4_SECRET_KEY!,
  },
  forcePathStyle: true,
});

export const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY!,
    secretAccessKey: process.env.R2_SECRET_KEY!,
  },
});
```

## Autenticazione cliente

Il cliente accede con un codice univoco alfanumerico. Il backend verifica il codice contro `clients.code` con `active = true`, poi il frontend conserva il codice in `sessionStorage` e lo invia con `X-Client-Code`.

Il middleware `clientAuth` valida ogni richiesta, carica il cliente e applica il filtro tenant. I tentativi falliti su `/api/client/verify` devono essere rate limited.

Generazione codice: 10 caratteri da `abcdefghjkmnpqrstuvwxyz23456789`, evitando caratteri ambigui.

## API cliente

| Metodo | Path | Scopo |
|--------|------|-------|
| POST | `/api/client/verify` | Verifica codice e ritorna profilo cliente |
| GET | `/api/client/dashboard` | Statistiche e ultimi eventi |
| GET | `/api/client/files` | Storico file del cliente |
| GET | `/api/projects` | Lista progetti cliente |
| GET | `/api/projects/:id` | Dettaglio progetto |
| GET | `/api/projects/:id/timeline` | Timeline progetto |
| GET | `/api/projects/:id/deliverables` | Deliverable progetto |
| GET | `/api/projects/:id/messages` | Thread messaggi |
| POST | `/api/projects/:id/messages` | Nuovo messaggio cliente |
| POST | `/api/deliverables/:id/approve` | Approvazione deliverable |
| POST | `/api/deliverables/:id/reject` | Richiesta modifiche |
| GET | `/api/invoices` | Lista fatture |
| GET | `/api/invoices/:id/pdf` | Redirect o presigned URL PDF |
| GET | `/api/renewals` | Scadenze e rinnovi |
| GET | `/api/reports` | Lista report |
| GET | `/api/reports/:id` | Dettaglio report |

## API admin

Le route admin sono protette da `X-API-Key`, verificato contro `ADMIN_API_KEY`. Sono API pure per il gestionale interno e non implicano una UI nel portale.

| Metodo | Path | Scopo |
|--------|------|-------|
| GET | `/api/admin/clients` | Lista clienti |
| POST | `/api/admin/clients` | Crea cliente |
| PATCH | `/api/admin/clients/:id` | Aggiorna cliente |
| GET | `/api/admin/uploads` | Lista upload con filtri |
| POST | `/api/admin/publish` | Copia file da S4 a R2 |
| DELETE | `/api/admin/uploads/:id` | Marca upload cancellato |
| POST | `/api/admin/projects` | Crea progetto |
| PATCH | `/api/admin/projects/:id` | Aggiorna progetto |
| POST | `/api/admin/projects/:id/timeline` | Aggiunge evento timeline |
| POST | `/api/admin/deliverables` | Crea deliverable |
| POST | `/api/admin/invoices` | Crea fattura |
| PATCH | `/api/admin/invoices/:id` | Aggiorna fattura |
| POST | `/api/admin/renewals` | Crea rinnovo |
| POST | `/api/admin/reports` | Pubblica report |
| POST | `/api/admin/projects/:id/messages` | Messaggio admin |
| POST | `/api/admin/projects/:id/request-material` | Richiesta materiale cliente |

Ogni modifica admin visibile al cliente deve generare un evento timeline coerente.

## Frontend

La SPA usa un layout riservato con sidebar desktop e bottom navigation mobile. Le sezioni principali sono dashboard, progetti, upload, file, investimento/fatture e report.

Pattern UI:

- Tema scuro, componenti responsive mobile-first.
- Stati vuoti e loading state espliciti.
- Nessun iframe per anteprime staging: usare link esterno.
- Timeline progetto ordinata per eventi recenti.
- Deliverable pendenti con approvazione o richiesta modifiche.
- Upload automatico con progresso, annulla e retry.
- Pagina investimento con totali pagati, importi in attesa e link PDF/payment.

## Notifiche

Eventi rilevanti come upload, messaggi, approvazioni, rifiuti, fatture e report generano notifiche admin o cliente. I payload devono contenere solo dati necessari: cliente, progetto, entita', timestamp e link operativo quando disponibile.

Esempio evento upload:

```text
Nuovo file caricato
Cliente: [ragione sociale]
File: catalogo.pdf
Dimensione: 12.4 MB
Progetto: [nome progetto]
Data: 2026-03-31 15:42
```

## Environment

Tutte le variabili ambiente vivono nel file `.env` in root monorepo.

```env
DATABASE_URL=postgresql://user:password@localhost:5432/client_portal

S4_ACCESS_KEY=
S4_SECRET_KEY=
S4_BUCKET=client-uploads
S4_REGION=eu-central-1
S4_ENDPOINT=https://s3.eu-central-1.s4.mega.io

CF_ACCOUNT_ID=
R2_ACCESS_KEY=
R2_SECRET_KEY=
R2_BUCKET=cdn-assets

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

RESEND_API_KEY=
EMAIL_FROM=Area Clienti <noreply@example.com>

ADMIN_API_KEY=

PORT=3001
CORS_ORIGIN=https://clienti.example.com
NODE_ENV=development
```

## Seed e test data

I seed devono essere idempotenti. Usare clienti e progetti fittizi, evitando dati personali o riferimenti a clienti reali. I dataset minimi utili includono:

- 3 clienti demo.
- 2 progetti per il primo cliente.
- 5-8 eventi timeline per progetto.
- 2 deliverable.
- 3 fatture con stati diversi.
- 2 rinnovi.
- 1 report mensile.
- 3-4 messaggi thread.

## Note operative

- Il frontend fa upload diretto a S4 via presigned URL; il backend non proxya file.
- Il CORS del bucket S4 deve consentire `PUT` dall'origine frontend ed esporre `ETag`.
- Gli upload multipart incompleti occupano spazio: prevedere lifecycle policy o job di cleanup.
- `pipelineSteps` e' un array JSON custom per progetto.
- La sezione report puo' partire con stato vuoto se non ci sono report pubblicati.
