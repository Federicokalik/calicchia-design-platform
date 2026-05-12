# Delivery Tracker

Documento operativo da aggiornare durante implementazione.

## Regole

- Stato consentito: `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`.
- Non segnare `DONE` senza verifica minima.
- Annotare data e owner quando cambia stato.

## Stato macro

| Area | Stato | Owner | Ultimo update | Note |
|---|---|---|---|---|
| Settings modulari | DONE | Claude Sonnet 4.6 | 2026-03-08 | API+UI verificate da code review, tsc EXIT 0 su api+admin |
| Quote engine | DONE | Claude Sonnet 4.6 | 2026-03-08 | Tutti endpoint+UI verificati, migration 029 OK, tsc EXIT 0; verifica e2e pending |
| Payments hub | DONE | Claude Sonnet 4.6 | 2026-03-08 | Migration 030, API, UI globale + tab incassi su quote/invoice completate |
| Design delivery | DONE | Claude Sonnet 4.6 | 2026-03-08 | Migration 031, API CRUD+versioni+feedback, UI lista+dettaglio completate |
| Website delivery | TODO |  |  |  |
| Marketing delivery | TODO |  |  |  |
| Client portal | TODO |  |  |  |
| Automazioni | TODO |  |  |  |

## Epic 1 - Settings modulari

### Backend

- [x] Definire chiavi settings supportate.
- [x] Implementare `GET /api/settings`.
- [x] Implementare `GET /api/settings/:key`.
- [x] Implementare `PUT /api/settings/:key`.
- [x] Validare schema payload per chiave.
- [x] Tracciare modifiche su audit log.

### Admin UI

- [x] Rifare pagina impostazioni con sezioni reali.
- [x] Sezione Business.
- [x] Sezione Preventivi.
- [x] Sezione Pagamenti.
- [x] Sezione Delivery.
- [x] Sezione Grafica.
- [x] Sezione Siti Web.
- [x] Sezione Marketing.
- [x] Sezione Portale Cliente.

### Verifica

- [ ] Ogni sezione salva e ricarica dati corretti. *(code review OK; e2e test pending runtime)*
- [x] Nessun campo placeholder rimasto.

## Epic 2 - Quote engine service-aware

### Data model

- [x] Aggiungere `service_type` su quotes.
- [x] Aggiungere `scope_items`.
- [x] Aggiungere `revision_policy`.
- [x] Aggiungere `payment_plan`.
- [x] Aggiungere `accepted_payment_methods`.
- [x] Aggiungere `bank_details_snapshot`.
- [x] Aggiungere `generated_project_id`.

### Backend

- [x] Accettazione preventivo con transizione robusta.
- [x] Generazione progetto da preventivo accettato.
- [x] Generazione milestone/task iniziali per template.
- [x] Generazione payment schedule.

### UI

- [x] Form quote con tipo servizio.
- [x] Form quote con payment plan.
- [x] Form quote con revision policy.
- [x] Form quote con deliverable strutturati.

### Verifica

- [ ] Quote accepted crea progetto coerente. *(code review OK: `createProjectPackageFromQuote` idempotente; e2e pending)*
- [ ] Snapshot economico resta invariato dopo cambio settings. *(code review OK: snapshot catturato in `buildQuoteSettingsSnapshot()` alla creazione; e2e pending)*

## Epic 3 - Payments hub

### Data model

- [x] Creare `payment_provider_accounts`.
- [x] Creare `payment_schedules`.
- [x] Creare `payment_links`.
- [x] Creare `payment_webhook_events`.
- [x] Estendere `invoices` con payment_status, balance_due, accepted_payment_methods, bank_details_snapshot, payment_instructions.

### Backend

- [x] CRUD payment schedules (`GET/POST/PATCH/DELETE /api/payments/schedules`).
- [x] Generazione piano da preventivo (`POST /api/payments/schedules/from-quote/:id`).
- [x] Creazione payment link bonifico (restituisce IBAN+BIC+causale).
- [x] Creazione payment link PayPal (genera URL paypal.me/amount).
- [x] Creazione payment link Revolut (restituisce URL).
- [x] Void link (`POST /api/payments/links/:id/void`).
- [x] Gestione webhook provider (log su `payment_webhook_events`).
- [x] Gestione pagamento parziale (PATCH con paid_amount auto-calcola stato).

### UI

- [x] Tab pagamenti su preventivo (card "Incassi Registrati" con genera piano + mark paid).
- [x] Tab pagamenti su fattura (sezione incassi con mark paid).
- [x] Vista globale pagamenti (`/payments` — stats + lista schedule + mark paid + genera da quote).
- [x] Filtri per stato scadenza/provider.

### Verifica

- [ ] Documento bonifico mostra IBAN e causale. *(code review OK; e2e pending)*
- [ ] Documento checkout salva URL e stato. *(code review OK; e2e pending)*
- [ ] Saldo residuo aggiornato in tempo reale. *(code review OK; e2e pending)*

## Epic 4 - Design delivery

### Data model

- [x] Creare `project_deliverables`.
- [x] Creare `deliverable_versions`.
- [x] Creare `deliverable_feedback`.

### Backend

- [x] CRUD deliverable.
- [x] Upload versioni.
- [x] Feedback su versione.
- [x] Approvazione deliverable (feedback_type=approval auto-setta status=approved).
- [x] Conteggio revisioni incluse/usate (revision_count auto-incrementato al caricamento).

### UI

- [x] Pagina Lavori Grafici (`/deliverables` — lista con stats, filtro status, card grid).
- [x] Timeline versioni (pagina dettaglio `/deliverables/:id`).
- [x] Review panel (feedback con tipo revisione/approvazione/commento, risolvi feedback).
- [x] Stato revisioni ed extra scope (contatore revision_count/revision_limit in UI).

### Verifica

- [ ] Workflow versione -> feedback -> approvazione tracciato end-to-end. *(code review OK; e2e pending)*

## Epic 5 - Website delivery

### Data model

- [ ] Creare `website_projects`.
- [ ] Creare `website_pages`.
- [ ] Creare `website_launch_checklist_items`.

### Backend

- [ ] CRUD dati progetto web.
- [ ] CRUD pagine sitemap.
- [ ] Checklist go-live.

### UI

- [ ] Pagina Siti Web.
- [ ] Stato per pagina (content/design/dev/seo).
- [ ] Checklist readiness go-live.

### Verifica

- [ ] Readiness go-live calcolabile dal pannello.

## Epic 6 - Marketing delivery

### Data model

- [ ] Creare `marketing_campaigns`.
- [ ] Creare `campaign_assets`.
- [ ] Creare `campaign_reports`.

### Backend

- [ ] CRUD campagne.
- [ ] CRUD asset campagna.
- [ ] KPI target/reali.
- [ ] Report periodici.

### UI

- [ ] Pagina Campagne Marketing.
- [ ] Stato creativita e approvazioni.
- [ ] Tracking budget planned/actual.

### Verifica

- [ ] Campagna gestibile end-to-end nel gestionale.

## Epic 7 - Client portal

### Backend

- [ ] Visualizzazione e approvazione preventivi.
- [ ] Visualizzazione e approvazione deliverable.
- [ ] Upload materiali cliente.
- [ ] Sezione pagamenti cliente.

### UI

- [ ] Area preventivi.
- [ ] Area delivery.
- [ ] Area pagamenti.
- [ ] Area feedback.

### Verifica

- [ ] Cliente lavora sul flusso senza accesso admin.

## Epic 8 - Automazioni

### Backend

- [ ] Engine regole trigger-action.
- [ ] Execution log automazioni.
- [ ] Retry e gestione errori.

### Prime regole

- [ ] quote accepted -> create project package.
- [ ] deliverable in client_review -> notify client.
- [ ] payment due soon -> reminder.
- [ ] payment received -> update financial state.

### Verifica

- [ ] Ogni automazione produce traccia auditabile.

## Dipendenze critiche

| Da | A | Motivo |
|---|---|---|
| Settings modulari | Quote engine | template e default dipendono dai settings |
| Quote engine | Payments hub | payment plan nasce dal preventivo |
| Quote engine | Delivery verticale | progetto e workflow nascono dal preventivo |
| Payments hub | Client portal | portale mostra stato e link pagamento |
| Verticali delivery | Automazioni | regole dipendono dagli stati verticali |

## Decision log

| Data | Decisione | Motivo | Owner |
|---|---|---|---|
|  | Quote come fonte di verita | evitare duplicazioni operative |  |
|  | Snapshot dati pagamento su documenti | coerenza storica |  |
|  | Verticali separate grafica/web/marketing | workflow diversi |  |
|  | Payment hub centralizzato | governance economica unica |  |
| 2026-03-08 | `service_type` accetta sia `retainer` che `retainer_maintenance` | documentazione non allineata, scelta retrocompatibile | Codex (GPT-5) |
| 2026-03-08 | Audit `site_settings` via insert applicativo su `audit_logs` | trigger esistente richiede colonna `id`, `site_settings` usa `key` come PK | Codex (GPT-5) |
| 2026-03-08 | `POST /api/quotes/:id/accept` genera package idempotente | evitare duplicazioni progetto su retry/ri-click | Codex (GPT-5) |
| 2026-03-08 | Snapshot bancario/economico auto in creazione quote | preservare coerenza storica anche dopo cambio settings | Codex (GPT-5) |
| 2026-03-08 | Aggiunto smoke test e2e `Quote Engine` | validare flusso base quote->accept->project package | Codex (GPT-5) |
| 2026-03-08 | Code review completa Fase 0+1 (Claude Sonnet 4.6) | verificare implementazione precedente prima di procedere con Fase 2 | Claude Sonnet 4.6 |
