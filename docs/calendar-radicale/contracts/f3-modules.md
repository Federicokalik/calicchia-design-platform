# Contratto dei moduli della F3

Versione 1.2 (v1 della fondazione più gli aggiornamenti dell'integrazione del §19, punti 1-10 nella v1.1 e 11-15 nella v1.2). Vincola i sei gruppi che implementano in parallelo la fase F3 del [piano](../piano.md) ("Strumento di migrazione, shadow mirror e prova sui device") dopo la fondazione: **INIT**, **SERIALIZE**, **APPLY**, **SHADOW**, **ROUTES**, **OPS**. Riferimenti al [design](../design.md): §1 (invarianti), §4 (165), §5 (identità e provenienza), §10 (condivisione invariata), §13.1-§13.9 e §13.13 (strumento di migrazione, tranne cutover, proiezione inversa, rollback e finalize, che sono F4/F7), §16.2 (backup JSON), §16.4 (GDPR), §16.6 (versione minima); [decisioni](../decisioni.md) (tutte, in particolare 3, 5, 7 e 8 e i requisiti espliciti); [inventario di produzione](../inventario-produzione-2026-10-09.md). Restano in vigore e prevalgono su questo documento: il [contratto del control-plane](control-plane.md) per policy, heartbeat, identità e permessi, e il [contratto della F2](f2-modules.md) per facade, indice, job, lock e store, salvo le eccezioni dichiarate qui come aggiornamento di quei contratti (filtro di PgLegacyStore del §1.3, colonne della 165 nel control-plane §2).

"DEVE", "NON DEVE" e "PUÒ" hanno il significato normativo consueto. Le firme di questo documento sono quelle che gli altri gruppi importano: un gruppo PUÒ aggiungere funzioni ed esportazioni, NON DEVE cambiare nome, argomenti o semantica di quelle elencate senza aggiornare prima questo contratto. I tipi condivisi (run, righe, ledger, codici, opzioni, DTO REST, wizard, errori) sono nel codice della fondazione, `apps/api/src/lib/calendar/migration/types.ts`, e questo documento li cita per nome: è la fonte unica dei valori ammessi, allineata ai CHECK della migrazione 165 (test `migration-165.test.ts`).

## 0. Mappa dei file e proprietari

Ogni file ha un solo proprietario. Un gruppo che ha bisogno di un file diverso da come lo trova NON lo modifica: lo chiede al proprietario o lo segnala nelle questioni aperte del proprio report.

| Gruppo | File | Note |
|---|---|---|
| Fondazione (fatto) | `database/migrations/165_calendar_migration.sql`; `apps/api/src/lib/calendar/migration/types.ts`; `apps/api/test/calendar/migration-165.test.ts`; `apps/api/src/routes/backup.ts` (gruppo S e rivalidazione del ledger dopo l'import); `apps/api/test/calendar/backup-partition.test.ts`; `apps/api/test/helpers/db.ts` (baseline delle tabelle 165); questo contratto; [control-plane](control-plane.md) §2 | Dopo la fondazione si cambiano solo con un aggiornamento di questo contratto |
| INIT | `apps/api/src/lib/calendar/migration/{preflight,init,inventory}.ts` | PUÒ aggiungere funzioni a `radicale/identity.ts` (mai cambiare quelle esistenti) per le collezioni `sub-*`, l'archivio e la riassegnazione `pg_to_volume` |
| SERIALIZE | `apps/api/src/lib/calendar/migration/{serialize,plan}.ts` | PUÒ esportare da `apps/api/scripts/fix-dst-exceptions.ts` la funzione pura di riallineamento DST, senza cambiarne il comportamento |
| APPLY | `apps/api/src/lib/calendar/migration/{apply,verify,report}.ts` | Unico scrittore di `cal_migration_ledger` (lo shadow usa le sue primitive) |
| SHADOW | `apps/api/src/lib/calendar/migration/shadow.ts`; `apps/api/src/lib/calendar/radicale/booking-projection.ts` (spostamento di `lib/calendar/booking-projection.ts`, che diventa un `export *` di compatibilità); `apps/api/src/lib/calendar/gdpr.ts`; `apps/api/src/routes/gdpr-requests.ts` (solo l'aggancio di `calendarErase`); `apps/api/src/cron/{data-retention,italian-holidays,ics-pull}.ts`; `apps/api/src/lib/calendar/store.ts` (solo il filtro di PgLegacyStore del §1.3) | Eccezione dichiarata su `store.ts` (file della fondazione F2) |
| ROUTES | `apps/api/src/lib/calendar/migration/runs.ts`; `apps/api/src/routes/calendar/migration.ts`; `apps/api/src/app.ts` (solo il montaggio); `apps/admin/src/pages/calendario/migrazione.tsx`; `apps/admin/src/components/calendar/migration/{preflight-step,preview-step,apply-step,verify-step,shadow-step,cutover-step}.tsx`; `apps/admin/src/lib/calendar-migration-api.ts`; `apps/admin/src/components/layout/calendar-tabs.tsx`; `apps/admin/src/App.tsx`; `apps/admin/src/lib/i18n-dictionary.ts` (solo la voce `nav.calendar.migration`) | |
| OPS | `scripts/radicale-maint.sh`; `docs/calendar-radicale/matrice-device.md`; `scripts/backup-calendar-stack.sh` e `scripts/calendar_stack.py` (solo la registrazione di `last_stack_backup`, §14.3) | |

Nessun gruppo modifica `apps/api/package.json`, `apps/admin/package.json`, `pnpm-lock.yaml`, `.github/workflows/*`, `apps/api/src/cron/index.ts`, `apps/api/src/index.ts` né `apps/api/src/cron/calendar-radicale.ts`: ogni gruppo esporta funzioni `register*`/`run*` e le elenca nel report (registrazioni di cron e bootstrap, §15); le collega l'integrazione finale. ROUTES tocca `src/app.ts` solo per montare il router (§10.1).

## 1. Perimetro della F3 e invarianti

### 1.1 Postgres resta autorevole

- `calendar_backend_state.mode` resta `postgres` per tutta la F3. Nessun modulo della F3 scrive `mode`, `write_freeze`, `cutover_at`, `cutover_by`, `rollback_until`, `finalized_at` o `api_min_version`, né incrementa `epoch` oltre il passaggio 0 → 1 dell'inizializzazione (§2).
- La facade usa PgLegacyStore come oggi: i contratti F0 restano verdi su entrambi gli store (`CALENDAR_BACKEND=postgres|radicale`), con le sole differenze già in `apps/api/test/contracts/allowed-diffs.json`. Nessuna differenza nuova in mode postgres.
- Le decisioni di prenotazione, il busy, il feed e l'agenda in mode postgres non leggono mai il ledger, i run né Radicale.
- Endpoint di condivisione invariati (requisito esplicito delle decisioni): lo strumento non tocca mai `calendars.ics_feed_token`, `ics_feed_enabled` né `slug`; le collezioni nascono con il nome esatto di `collection_name` (= slug per i calendari esistenti, compresi `c` e `f`), quindi i percorsi `dav.calicchia.design/federico/<slug>/` dei device e le app-password restano quelli di oggi.

### 1.2 Cosa scrive lo strumento

| Dove | Cosa | Chi |
|---|---|---|
| Radicale (come `caldes-svc`) | Principal, marker e collezioni (solo inizializzazione e riassegnazione d'identità) | INIT (`init.ts`) |
| Radicale | Oggetti delle collezioni del piano, con riga d'intento prima di ogni PUT o DELETE | APPLY (`apply.ts`), anche per conto dello shadow |
| Radicale | Item dell'archivio della Fase 0 (`If-None-Match: *`) | INIT (`init.ts`) |
| `cal_migration_runs`, `cal_migration_items` | Run e righe | ROUTES (`runs.ts`) tramite il contesto del run; APPLY (`report.ts`) per l'accettazione |
| `cal_migration_ledger` | Ledger | APPLY (`apply.ts`); SHADOW e INIT solo attraverso le primitive di `apply.ts`; GDPR (`gdpr.ts`) per la redazione; `backup.ts` per la rivalidazione |
| `calendar_backend_state` | `volume_id`, `epoch` (0 → 1 o riassegnazione) | INIT |
| `calendar_backend_state` | `shadow_enabled`, `shadow_since` | SHADOW (`setShadowEnabled`) |
| `calendar_backend_state` | `migration_declarations` | ROUTES (`writeDeclaration`); INIT per `phase0` dopo un archivio riuscito |
| `calendar_backend_state` | `last_stack_backup` | OPS (script di backup) |
| `calendars` | Solo i sidecar delle iscrizioni (`role='subscription'`, tramite `enableSubscriptionIndex(…, { allowPostgresMode: true })`) e la riga dell'archivio (`origin='migration'`) | SHADOW, INIT |
| `calendar_subscriptions` | Solo `blocks_availability`, `device_visible`, `collection_calendar_id` | SHADOW |
| `calendar_events`, `calendar_events_legacy` | Mai, tranne la redazione dell'erasure GDPR (§13) | SHADOW (`gdpr.ts`) |
| `calendar_bookings` | Mai, tranne l'anonimizzazione dell'erasure GDPR (§13) | SHADOW (`gdpr.ts`) |

Lo strumento NON DEVE scrivere `policy.json` o `heartbeat.json` direttamente: la policy la riscrive il control-plane al NOTIFY dello stato (contratto control-plane §5.2).

### 1.3 Righe dello strumento invisibili al legacy

In mode postgres il codice legacy elenca tutte le righe di `calendars` (`legacy/calendars-pg.listCalendars` non filtra): un sidecar `sub-<id8>` o la riga dell'archivio comparirebbero nell'admin e in `list_calendars` come calendari vuoti, e `create_event` potrebbe scriverci righe legacy. SHADOW aggiunge in `store.ts` un filtro di PgLegacyStore (unica eccezione alla regola "nessuna logica propria" di f2-modules §1.1):

- `listCalendars`, `getCalendar`, `getCalendarByFeedToken`, `getDefaultCalendar` e `countEventsByCalendar` escludono le righe con `role = 'subscription'` o `origin = 'migration'` (le stesse che RadicaleStore esclude da `listCalendars`, più l'archivio);
- su dati senza queste righe (produzione prima della F3, test dei contratti) il risultato è identico a oggi: i contratti F0 non cambiano;
- il filtro legge gli id da escludere con una query a parte (`SELECT id FROM calendars WHERE role = 'subscription' OR origin = 'migration'`), senza toccare `legacy/*`.

### 1.4 Regole di sicurezza

1. **Mai collezioni fuori dall'inizializzazione.** MKCOL e MKCALENDAR stanno solo in `init.ts` (che usa `radicale/identity.ts`). Apply, shadow, specchio delle iscrizioni e archivio non creano mai una collezione: una collezione del piano che manca produce il conflitto `COLLECTION_MISSING` e il wizard propone "Crea collezioni mancanti" (`POST /init`, `action: 'create_missing'`). Un test di INIT verifica con una ricerca nei sorgenti che `mkcol`/`mkcalendar` compaiano solo in `init.ts`, `radicale/identity.ts`, `radicale/store.ts` (creazione di un calendario in mode radicale, F2) e negli script e test già esistenti.
2. **Mai un volume senza identità.** Ogni run che scrive (init `create_missing`, archive, apply) e ogni job shadow verifica l'identità all'avvio con `assertMigrationWritable()` (§6.1), che legge il marker da Radicale (sorgente `remote`, mai dalla cache del campanello), e la riverifica prima di ogni collezione e almeno ogni 60 secondi. Identità diversa da `ok` → run `failed` con `IDENTITY_NOT_OK`/`IDENTITY_CHANGED`, job shadow in attesa (§9.2).
3. **Idempotenza e crash.** Ogni run è ripetibile dall'inizio con lo stesso esito (le scritture passano dal ledger con le righe d'intento; l'inizializzazione ha il proprio journal, §6.1); una ripresa dopo un riavvio (lease scaduto del job, §5.2) non duplica nulla.
4. **Un solo run alla volta.** Indice unico parziale `cal_migration_runs_single_active` più `pg_advisory_lock('cal-migration')` dell'esecutore; i job shadow prendono lo stesso lock con `pg_try_advisory_lock` (§5.3).
5. **Nessun dato personale** in `cal_migration_runs.params/summary/error`, in `cal_migration_items.detail`, nei log e nei messaggi d'errore: niente email, telefoni, messaggi, aziende né descrizioni o titoli delle proiezioni delle prenotazioni (§5.4). Il ledger contiene lo snapshot delle proiezioni (nome e telefono, decisione 3) e la erasure lo redige (§13).

## 2. Macchina a stati in F3 (design §13.1, §13.9)

### 2.1 Stato del backend

| Colonna | Valori in F3 | Transizioni ammesse in F3 | Chi |
|---|---|---|---|
| `mode` | `postgres` | nessuna | — |
| `write_freeze` | `false` | nessuna | — |
| `volume_id`, `epoch` | `NULL`/`0` oppure UUID/`1` | `NULL,0 → uuid,1` (inizializzazione, `UPDATE … WHERE mode = 'postgres' AND epoch = 0`); riassegnazione confermata (§6.1) senza mai far tornare indietro `epoch` | INIT |
| `shadow_enabled`, `shadow_since` | `false,NULL` o `true,istante` | spento → acceso con le precondizioni del §9.5; acceso → spento sempre | SHADOW |
| `cutover_at`, `cutover_by`, `rollback_until`, `finalized_at`, `api_min_version` | `NULL`, `0` | nessuna (F4) | — |
| `migration_declarations`, `last_stack_backup` | oggetti JSON | scritture puntuali | ROUTES, INIT, OPS |

La policy dei device resta quella derivata da `policyFromState()`: `shadow` (sola lettura) in mode postgres, `frozen` con guardia post-ripristino, rebuild richiesto o identità non verificata. Lo shadow e le colonne della 165 non entrano nella policy e non incrementano `policy_version`.

### 2.2 Avanzamento del wizard

Lo stato del wizard è derivato (§11.2), mai salvato a sé:

```
NON INIZIALIZZATO ──init──► INIZIALIZZATO ──inventory+plan──► ANTEPRIMA ──apply──► APPLICATO
      ▲  (volume vuoto, epoch 0)      (collezioni e _canary)          │                  │
      └── identità diversa: blocco, diff, riassegnazione confermata    │            verify│
                                                                       ▼                  ▼
                                           (rigenera l'anteprima) ◄── ANTEPRIMA ◄── VERIFICATO (verde, o giallo accettato)
                                                                                          │ shadow on
                                                                                          ▼
                                                                SHADOW (≥ 7 giorni di parità verde, matrice device)
                                                                                          │
                                                                                          ▼
                                                                PRONTO PER IL CUTOVER ── F4 (passo 6 disabilitato)
```

### 2.3 Transizioni della F4

`POST /cutover`, `POST /rollback/preview`, `POST /rollback` e `POST /finalize` esistono e rispondono `409 PHASE_NOT_AVAILABLE`. I tipi di run `cutover`, `rollback_preview`, `rollback`, `rebaseline` e `finalize` sono ammessi dal CHECK della 165 ma in F3 nessuno li crea. Regole che la F4 eredita: ogni transizione è un run e tiene `cal-migration` (quindi esclude apply e shadow), poi prende `cal-write` in modo esclusivo (ordine `cal-migration → cal-write`, mai il contrario); prima lo stato, poi la policy (design §13.9).

## 3. Migrazione 165

Append-only, idempotente, compatibile con i dati di produzione (nessun backfill). Commenti di colonna e vincoli nel file SQL; qui la semantica.

### 3.1 `calendar_backend_state` (colonne aggiunte)

Tabella completa nel [contratto del control-plane §2](control-plane.md). In breve: `shadow_enabled` + `shadow_since` (`CHECK shadow_enabled = (shadow_since IS NOT NULL)`), `cutover_at` + `cutover_by` (insieme), `rollback_until`, `finalized_at`, `api_min_version INTEGER ≥ 0` (livello minimo del protocollo calendario, `CALENDAR_API_LEVEL` di `types.ts` = 3 in F3; 0 = nessun vincolo; il cutover lo alza e l'avvio lo controlla dalla F4), `last_stack_backup JSONB` (`LastStackBackup`), `migration_declarations JSONB` (`MigrationDeclarations`, §11.4). NON aggiunge `horizon_start/end` (orizzonte per collezione, 163). Lettura: `SELECT` delle colonne `MIGRATION_STATE_COLUMNS` e `normalizeMigrationState()`; scritture e decisioni la rileggono senza cache.

### 3.2 `cal_migration_runs`

| Colonna | Significato |
|---|---|
| `id` | UUID del run |
| `kind` | `MIGRATION_RUN_KINDS` (§5.1) |
| `status` | `queued` → `running` → `succeeded`, `failed`, `cancelled` o `interrupted` (`queued → cancelled` per un annullamento prima dell'avvio) |
| `trigger` | `admin`, `schedule`, `shadow`, `restore`, `system` |
| `requested_by` | `admin:<id utente>`, `system:shadow`, … (attore di audit e ledger) |
| `idempotency_key`, `request_hash` | Chiave del client (unica) e sha256 del corpo della richiesta (§10.3) |
| `params` | Parametri per tipo (`PreflightParams`, `InitParams`, `ArchiveParams`, `IdentityParams`, `InventoryParams`, `PlanParams`, `ApplyParams`, `VerifyParams`) |
| `plan_run_id`, `plan_hash` | Apply e verifica: anteprima di riferimento (`ON DELETE SET NULL`) e hash del piano visto dall'utente |
| `progress` | `MigrationProgress` (fase, fatti, totale, messaggio) |
| `summary` | Riassunto per tipo (`MigrationRunSummaryByKind`) |
| `error`, `error_code` | Messaggio in italiano senza dati personali e `MigrationRunErrorCode` |
| `attempts`, `job_id`, `heartbeat_at`, `cancel_requested_at` | Esecuzione (§5.2) |

Vincoli: un solo run `queued` o `running` (`cal_migration_runs_single_active`); `idempotency_key` unica; `finished_at` valorizzato ⇔ stato terminale; `started_at` per `running` e `succeeded`.

### 3.3 `cal_migration_items`

Una riga per controllo, anomalia, oggetto, collezione, differenza o degrado di un run (`item_type`), in ordine (`seq`), con `ON DELETE CASCADE` dal run. `action` (`PLAN_ACTIONS`) e `outcome` (`APPLY_OUTCOMES`) solo per `object`; `level` (`V1`…`V5`) ed `expected` solo per `diff`; `accepted_at`/`accepted_by` solo per le differenze attese; `forced` solo per `object`; `code` nel formato `^[A-Z][A-Z0-9_]{0,63}$`. `calendar_id`, `href` e `legacy_key` sono riferimenti senza FK.

### 3.4 `cal_migration_ledger`

Una riga per href (semantica nel §4):

| Gruppo di colonne | Colonne |
|---|---|
| Destinazione | `calendar_id`, `collection_name`, `href` (`UNIQUE (calendar_id, href)`), `uid` |
| Sorgente | `kind`, `legacy_key`, `legacy_event_id`, `legacy_snapshot`, `legacy_hash` |
| Ultima scrittura | `written_etag`, `written_fingerprint`, `written_at` |
| Riga d'intento | `intent_op`, `intent_fingerprint`, `intent_legacy_hash`, `intent_snapshot`, `intent_etag`, `intent_at`, `intent_run_id` |
| Stato | `adopted`, `derived`, `revalidate_reason`, `revalidate_since`, `deleted_at`, `last_run_id` |

Vincoli: al più una riga viva per `(calendar_id, legacy_key)` e per `(calendar_id, uid)`; `legacy_key` con il prefisso del `kind`; hash nel formato `s<versione>:<sha256>`; intento coerente (operazione, istante; fingerprint e hash per `create`/`update`; tutti nulli senza intento); una riga ritirata (`deleted_at`) non ha scritture né intento; `derived` solo per `event` e `detached`. Nessuna FK: il ledger sopravvive alla cancellazione del calendario (la collezione resta in Radicale e V1 la segnala) e agli import che svuotano il dominio.

### 3.5 Coda dello shadow mirror

Nessuna tabella nuova: la coda è `cal_jobs` (164) con il tipo riservato `shadow_mirror` (`SHADOW_MIRROR_JOB_KIND`). I trigger della 165 accodano nella **stessa transazione** della scrittura legacy (outbox: il job esiste solo dopo la COMMIT):

| Trigger | Evento | Chiave |
|---|---|---|
| `calendar_events_shadow_enqueue` | `AFTER INSERT OR UPDATE … WHEN (NEW.source <> 'ics_pull')` | `cal_shadow_event_key()`: `booking:<source_id>` per le proiezioni, altrimenti `event:<recurrence_master_id o id>` |
| `calendar_events_shadow_enqueue_delete` | `AFTER DELETE … WHEN (OLD.source <> 'ics_pull')` | come sopra |
| `calendar_bookings_shadow_enqueue` | `AFTER INSERT OR DELETE OR UPDATE OF status, start_time, end_time, attendee_name, attendee_email, attendee_phone, location_type, location_value, event_type_id` | `booking:<uid>` |

Condizioni (funzione `cal_shadow_mirror_enqueue()`): `mode = 'postgres'`, `shadow_enabled`, `volume_id` non nullo, GUC `caldes.reverse_sync` diverso da `'on'` (scritture della proiezione inversa della F4). Un UPDATE accoda la chiave della riga prima e dopo la modifica (coincidono, salvo un cambio di `source`, `source_id` o master). Coalescenza come `enqueueCalendarJob` (solo sui pending: un job in esecuzione non assorbe la modifica, che produce un pending nuovo), `priority` 100, `run_after = now() + 2 s` (debounce), `source_version = txid_current()` (informativa: l'handler NON restituisce `currentSourceVersion`, §9.2), payload `{legacy_key, table, op}`. L'import del backup JSON spegne i trigger (`session_replication_role = replica`): ci pensa la rivalidazione (§4.5).

### 3.6 Backup JSON e GDPR delle tabelle 165

- Tutte nel gruppo S (`STATE_TABLES` esplicito più il prefisso `cal_migration_`): esportate, mai ripristinate, mai toccate dall'import tranne l'UPDATE di rivalidazione del ledger (§4.5). Il test della partizione le protegge con trappole ENABLE ALWAYS.
- Retention: run e righe oltre 30 giorni cancellati (tranne l'ultimo run riuscito di ogni tipo), file caricati per l'archivio cancellati a fine run e comunque dopo 24 ore (`purgeMigrationArtifacts`, §13.2).
- Erasure: righe che citano la persona cancellate, snapshot del ledger redatti (§13.1).

## 4. Ledger: semantica (design §13.6)

### 4.1 Chiavi e href

| `kind` | `legacy_key` | Collezione | `href` | `uid` |
|---|---|---|---|---|
| `event` | `event:<uuid del master>` (singoli compresi) | quella del calendario del master (o quella scelta per gli spostamenti della decisione 8) | quello noto (riga viva del ledger nella stessa collezione, poi `cal_object_ids` per `legacy_event_id`); altrimenti `it-holiday-YYYY-MM-DD.ics` per le festività `source='system'`, `closure-<uuid>.ics` per gli altri eventi di una collezione `holidays`, `<uid>.ics` se l'UID è un nome sicuro (`isValidObjectName`), altrimenti `<sha256(uid)[0..32]>.ics` | UID legacy del master |
| `detached` | `detached:<uuid dell'override orfano>` | quella del master | `<uid del master>-det-<epoch in secondi del RECURRENCE-ID>.ics` | uguale al nome senza `.ics` (Radicale rifiuta due risorse con lo stesso UID nella collezione) |
| `booking` | `booking:<uid della prenotazione>` | `role='bookings'` | `booking-<uid>.ics` | `<uid>@caldes.it` |
| `archive` | `archive:<nome originale>` | `archivio-fase0` | nome originale ripulito | UID dell'item |

Il serializer riusa SEMPRE l'href già noto: un oggetto non cambia mai nome fra due esecuzioni, né dopo un rollback (F4).

### 4.2 `legacy_snapshot` e `legacy_hash`

- `legacy_snapshot` è l'ingresso canonico del serializer per l'oggetto (`LegacySnapshot` di `types.ts`): righe legacy del master e dei suoi override (o la riga dell'override staccato), calendario (id, nome della collezione, fuso, ruolo), opzioni dell'anteprima che hanno cambiato l'uscita; per le proiezioni i soli dati della decisione 3 (titolo, nome, telefono, orari, luogo e link, stato) più il flag `minimized`.
- `legacy_hash = 's' + SERIALIZER_VERSION + ':' + sha256(canonicalJson(snapshot))`. Cambia quando cambiano le righe legacy, la prenotazione, le opzioni che toccano l'oggetto, la versione del serializer o lo stato di minimizzazione (24 mesi dalla fine): quest'ultimo caso produce un solo update, il giorno in cui scatta.
- Lo snapshot è anche la base del diff per campo dello shadow (`opsFromLegacyDiff` fra snapshot e righe correnti, design §13.8).
- `legacy_hash = NULL` su una riga scritta significa "sorgente da riscrivere" (erasure GDPR): il piano lo tratta come un hash cambiato.

### 4.3 Riga d'intento (protocollo di ogni scrittura)

Ogni create, update o delete di `apply.ts` segue questi passi, con transazioni brevi sul pool principale e mai una transazione aperta attorno all'HTTP:

1. **Intento** (transazione 1, COMMIT prima della richiesta): `SELECT … FOR UPDATE` della riga (o `INSERT` di una riga nuova senza scritture), poi `intent_op`, `intent_fingerprint` (fingerprint semantico del testo da scrivere), `intent_legacy_hash`, `intent_snapshot`, `intent_etag` (l'If-Match usato, per update e delete), `intent_at = now()`, `intent_run_id`. Nella stessa transazione, per create e update, `reserveObjectId()` (f2-modules §4.6) per la risorsa e per ogni override con gli id legacy e `legacy_uid`.
2. **Richiesta**: PUT con `If-None-Match: *` (create) o `If-Match: <etag>` (update), DELETE con `If-Match`.
3. **Esito** (transazione 2): `written_etag` (dalla risposta, altrimenti da un PROPFIND `getetag`), `written_fingerprint = intent_fingerprint`, `written_at`, `legacy_hash`/`legacy_snapshot` dell'intento, intento azzerato, `revalidate_*` azzerati, `last_run_id`; per una delete la riga si ritira (`deleted_at`, scritture e hash a NULL).
4. **Fallimenti**: 412 → intento azzerato ed esito `conflict` (il giro successivo ripianifica); 409 `no-uid-conflict` → intento azzerato, lettura dell'UID nella collezione e adozione o `UID_AT_OTHER_HREF` (§7.2); errore di rete o esito sconosciuto (`outcomeUnknown`) → l'intento RESTA pendente ed esito `failed`: lo risolve il giro successivo.

Un intento pendente al giro successivo (anche dopo un kill fra la PUT e la transazione 2) porta a un GET della destinazione: fingerprint uguale all'intento → **adozione** (si completa la transazione 2 senza scrivere: esito `adopted`, e se l'hash corrente è quello dell'intento il giro dopo è `noop`); fingerprint uguale all'ultima scrittura, o destinazione assente per una create → intento mai applicato, si azzera e si ripianifica; altro contenuto → `conflict:UNTRACKED_TARGET`. Per una delete pendente: destinazione assente → adozione (ritiro); stessa etag dell'intento → si azzera e si ripianifica; altro → `conflict:TARGET_NEWER`.

### 4.4 `adopted` e `derived`

- `adopted = true` quando la destinazione esisteva già con il contenuto voluto (adozione per fingerprint, `no-uid-conflict` con lo stesso contenuto, adozione di un intento) e dalla ri-baseline della F4. Gli update di una riga adottata passano dalla patch per campo sull'oggetto corrente (VALARM, ATTENDEE e X-* restano), mai dalla riscrittura completa.
- `adopted = true` anche dopo una scrittura il cui contenuto è la patch per campo dell'oggetto corrente e ha un fingerprint diverso dall'oggetto voluto dal piano (proprietà della destinazione fuori dal piano conservate, per esempio il VALARM di un device patchato dallo shadow): V2 confronta poi solo i campi del piano e gli update successivi, anche dell'apply, restano patch (v1.2, §19).
- `derived = true` è della F4 (righe derivate dalla proiezione inversa); in F3 resta `false`. Il codice `DERIVED_EDITED` è già nei conflitti.

### 4.5 Rivalidazione

`cal_migration_ledger_require_revalidation(reason)` marca le righe vive senza motivo (`revalidate_reason`, `revalidate_since`) e restituisce quante. La chiamano l'import del backup JSON nella sua transazione (`'backup-import'`, già fatto dalla fondazione: risposta `calendar.ledger_revalidation` e avviso) e la riassegnazione d'identità (`'identity-reassign'`). Finché una riga è marcata, ogni azione di scrittura che il piano calcola su di essa diventa `conflict:REVALIDATION_REQUIRED` (mai una sovrascrittura o una cancellazione: un evento creato dopo il backup e assente dal ripristino non sparisce dal volume senza conferma); un `noop` o un'adozione la smarcano (transazione 2 senza richiesta). Si risolve con "forza" (per item o per codice, §10.2).

### 4.6 Id, `legacy_uid` e feed

Il serializer valorizza `object_ids` per ogni oggetto migrato e l'apply li preassegna con `reserveObjectId()`: `id` = UUID legacy del master o dell'override (le proiezioni prendono l'id della riga legacy `source='booking' AND source_id=<uid>`), `legacy_event_id` uguale, `legacy_uid` = UID legacy della riga (anche con '@'). Così gli id restituiti oggi da `list_events` restano validi dopo il cutover e il feed pubblica gli stessi UID (`legacy_uid@CAL_FEED_UID_DOMAIN`, design §10). In più ogni componente porta `X-CALDES-LEGACY-ID` (allocazione per X-prop del rebuild senza `cal_object_ids`).

## 5. Run, lock ed esecuzione

### 5.1 Tipi di run

| `kind` | Modulo (funzione) | Scrive | Conferma | Chiave d'idempotenza | Righe |
|---|---|---|---|---|---|
| `preflight` | INIT `runPreflight` | no (solo la PUT del probe su `_canary`, che deve ricevere 403) | — | facoltativa | `check` |
| `init` | INIT `runInit` | Radicale (MKCOL, PROPPATCH, MKCALENDAR), stato (0 → 1) | `INIZIALIZZA RADICALE` o `CREA COLLEZIONI` | obbligatoria | `collection` |
| `archive` | INIT `runArchiveImport` | Radicale (MKCALENDAR di `archivio-fase0`, PUT), `calendars`, ledger | `IMPORTA ARCHIVIO` | obbligatoria | `object`, `anomaly` |
| `identity` | INIT `runIdentityReassign` | Radicale (PROPPATCH ed eventuale MKCOL), stato, ledger (rivalidazione) | `RIASSEGNA IDENTITÀ` | obbligatoria | `check` |
| `inventory` | INIT `runInventory` | no | — | facoltativa | `anomaly` |
| `plan` | SERIALIZE `runPlan` | no | — | facoltativa | `object`, `anomaly` |
| `apply` | APPLY `runApply` | Radicale, ledger | `APPLICA` (+ `FORZA` con item forzati) | obbligatoria | `object` |
| `verify` | APPLY `runVerify` | no (solo l'accettazione riportata, §8.4) | — | facoltativa | `diff` |

### 5.2 Esecuzione (`runs.ts`, ROUTES)

1. **Creazione** (`createMigrationRun`), in una transazione: `INSERT` del run `queued` (unicità del run attivo e della chiave → `MIGRATION_BUSY` con il run in corso, o replay/`IDEMPOTENCY_KEY_REUSED`, §10.3) più `enqueueCalendarJob(MIGRATION_RUN_JOB_KIND, <run id>, {}, { db: tx, maxAttempts: MIGRATION_LIMITS.runJobMaxAttempts })`.
2. **Handler** del job (`registerMigrationRunJob`): prende il lock `cal-migration` (connessione riservata del pool principale, attesa fino al lease), porta il run a `running` (`started_at` alla prima esecuzione, `attempts + 1`), costruisce il `MigrationRunContext` e chiama la funzione del tipo (tabella §5.1); un timer ogni `heartbeatIntervalMs` aggiorna `heartbeat_at` ed estende il lease del job.
3. **Esito**: `succeeded` con `summary`; `failed` con `error_code` (`MigrationError.code` se è un `MigrationRunErrorCode`, altrimenti `INTERNAL`) e messaggio senza dati personali; `cancelled` se `cancel_requested_at` (il segnale del contesto si accende e la funzione lancia `MigrationError('CANCELLED')` al primo punto sicuro, mai fra intento ed esito di una scrittura). Lock rilasciato sempre. Per un apply con `follow_up_verify` l'esecutore crea il run di verifica nella stessa transazione che chiude l'apply.
4. **Ripresa**: un riavvio o un crash lasciano il job in lease; allo scadere torna pending e l'handler riprende lo stesso run (`attempt > 1`). Le funzioni DEVONO essere idempotenti (§1.4). `reapInterruptedRuns()` (avvio e ogni 5 minuti) porta a `interrupted` un run `running` senza battito da `staleHeartbeatMs` il cui job è morto o assente, e a `failed` un run `queued` senza job.
5. **Radicale non configurato** (`radicaleRuntime().client === null`): il worker dei job è spento (f2-modules §12), quindi la route crea e chiude subito un run `preflight` con il controllo `RADICALE_CONFIGURED` fallito (`preflightWithoutRadicale`), e rifiuta gli altri tipi con `503 RADICALE_NOT_CONFIGURED`.

### 5.3 Lock

| Lock | Tipo | Chi | Note |
|---|---|---|---|
| `cal-migration` (`MIGRATION_LOCK_KEY`) | `pg_advisory_lock` di sessione su una connessione riservata del pool principale `sql` (mai di `calSql`) | esecutore dei run | per tutta la durata del run |
| `cal-migration` | `pg_try_advisory_lock` (stessa connessione riservata) | job `shadow_mirror` | occupato → `CalendarUnavailableError('transition')`, errore d'attesa: il job si riaccoda (f2-modules §3) |
| `cal_migration_runs_single_active` | indice unico parziale | database | difesa anche fra processi senza lock |
| riga del ledger | `SELECT … FOR UPDATE` in transazioni brevi | `apply.ts` | solo per intento ed esito, mai attorno all'HTTP |
| `cal-sync:<id>` | f2-modules §1.3 | sync | lo strumento non lo prende; ordine `cal-migration → cal-sync:*` ammesso (il campanello indicizza dopo le PUT) |
| `cal-write` | f2-modules §1.3 | — | in F3 lo strumento non lo prende (mode postgres); la F4 lo prende dopo `cal-migration` |

### 5.4 Righe e dettagli

- `addItems()` del contesto assegna `seq` in ordine; una funzione aggiunge righe a blocchi (al più 500 per chiamata).
- `detail` è JSON senza dati personali: id, UID (non quelli delle proiezioni, che contengono solo l'uid della prenotazione), date, etag, fingerprint, conteggi, codici; `summary` (titolo) solo per gli eventi non di prenotazione. Per le righe `object` la forma è `ObjectItemDetail`, per le `diff` `VerifyDiffDetail`, per le `check` i campi di `PreflightCheck`.
- Le differenze accettate restano sul run in cui sono state accettate e si riportano sui run successivi per firma (§8.4).

## 6. Moduli: firme

Tutti i tipi citati sono di `migration/types.ts` salvo dove indicato. `Db` è quello di `radicale/policy.ts`, `RadicaleClient` quello di `radicale/client.ts`.

### 6.1 INIT

`migration/preflight.ts`:

```ts
/** Controlli del design §13.3 (codici PREFLIGHT_CHECK_CODES, §6.1.1). In sola lettura salvo la PUT del probe su _canary. */
export function runPreflight(ctx: MigrationRunContext<PreflightParams>): Promise<PreflightSummary>;
/** Preflight senza Radicale configurato: RADICALE_CONFIGURED fallito, gli altri controlli di database sì. */
export function preflightWithoutRadicale(db: Db): Promise<PreflightSummary>;
/**
 * Guardia di ogni scrittura dello strumento: stato riletto senza cache (mode postgres), identità 'ok' letta
 * da Radicale (remoteIdentitySource, mai dalla cache del campanello), opzionalmente shadow acceso.
 * Lancia MigrationError('PRECONDITION_FAILED', …, { reasons: ['MODE_NOT_POSTGRES' | 'IDENTITY_NOT_OK'] }).
 */
export function assertMigrationWritable(opts: { db: Db; client: RadicaleClient; principal: string; requireShadow?: boolean }): Promise<MigrationBackendState>;
```

#### 6.1.1 Controlli

| Codice | Esito |
|---|---|
| `MODE_POSTGRES` | `fail` se `mode ≠ postgres` |
| `RESTORE_GUARD` | `warn` con guardia post-ripristino o `rebuild_required` (le scritture passano per la rivalidazione, §4.5) |
| `RADICALE_CONFIGURED` | `fail` senza `RADICALE_URL` o credenziali di `caldes-svc` |
| `RADICALE_REACHABLE` | `fail` se PROPFIND della root come `caldes-svc` non riesce |
| `RADICALE_VERSION` | `warn` se la versione non è 3.7.8 o non si può leggere (header `Server` o proprietà di Radicale; mai un `fail`) |
| `SERVICE_LOGIN` | `fail` se `caldes-svc` non si autentica sulla rete interna |
| `IDENTITY` | `pass` con `ok`; `pass` con `can_initialize` se `epoch = 0` e principal assente; `fail` con `mismatch`/`unverified` (dettaglio: `IdentityDiffView` ridotta) |
| `COLLECTIONS` | `warn` con l'elenco delle collezioni del piano (e `sub-*` delle iscrizioni visibili) mancanti: azione "Crea collezioni mancanti"; `skip` prima dell'inizializzazione |
| `CANARY_COLLECTION` | `warn` se `_canary` manca (la crea l'init) |
| `PROBE_READONLY` | `fail` se `caldes-probe` può scrivere una collezione utente in shadow (PROPFIND `current-user-privilege-set`) |
| `PROBE_CANARY_FORBIDDEN` | `fail` se la PUT del probe su `_canary` non risponde 403 |
| `VOLUME_WATCH` | `pass` con il campanello in `mount` e canary/statfs superati; altrimenti `confirm` con la dichiarazione `remote_mode_accepted` |
| `CONTROL_PLANE` | `fail` se policy o heartbeat non si scrivono (`getCalendarControlPlane()?.status()`) |
| `SERVICE_PUBLIC_401` | login di `caldes-svc` e `caldes-probe` su `RADICALE_PUBLIC_URL`: 401 → `pass`; altro → `fail`; URL assente o non raggiungibile dal container (hairpin) → `confirm` con `remedy` = comando `curl` da lanciare sull'host e dichiarazione `public_401_verified` |
| `RESERVED_APP_PASSWORDS` | `fail` con app-password attive dallo username `caldes-*` (revoca dall'admin) |
| `NON_CANONICAL_APP_PASSWORDS` | `pass` informativo con il numero di username diversi dal principal (mappati) |
| `BACKUP_RECENT` | `pass` se `last_stack_backup` è completo, di meno di 24 ore e con l'identità del volume corrente (o volume non ancora inizializzato); altrimenti `confirm` con `backup_verified` (valida 24 ore) |
| `SUBSCRIPTION_SYNC_IDLE` | `warn` se un pull delle iscrizioni è in corso |
| `PHASE0_VOLUME` | `confirm` finché manca la dichiarazione `phase0` (decisione 7, §12) |
| `DST_EXCEPTIONS` | `warn` con il numero di eccezioni `DST_SHIFTED_EXCEPTION` ancora in PG (le riallinea il serializer; in PG con `calendar:fix-dst`) |

`ready = blocking.length === 0` (bloccano `fail` e `confirm`).

`migration/init.ts` (unico punto di MKCOL e MKCALENDAR):

```ts
export const ARCHIVE_COLLECTION_NAME = 'archivio-fase0';
/**
 * action 'initialize': precondizioni del contratto control-plane §4.4 (mode postgres, epoch 0, principal assente),
 * journal crash-resistente (InitParams.volume_id scritto nei params del run PRIMA della MKCOL; una ripresa che trova
 * sul volume il proprio marker prosegue dall'UPDATE dello stato), poi collezioni del piano, sub-* visibili, archivio
 * se c'è la riga, _canary. action 'create_missing': identità 'ok', solo le collezioni mancanti.
 * Collezione presente con un'altra calendar-id → 'conflict' (mai toccata). Mai su un volume non vuoto senza marker.
 */
export function runInit(ctx: MigrationRunContext<InitParams>): Promise<InitSummary>;
/** Collezioni che l'init creerebbe o verifica adesso (preflight, wizard). */
export function plannedCollections(db: Db): Promise<PlannedCollection[]>;
/** Archivio della Fase 0 (§12). */
export function runArchiveImport(ctx: MigrationRunContext<ArchiveParams>): Promise<ArchiveSummary>;
/** GET /identity: PG contro marker e collezioni del volume, azioni ammesse. Sola lettura. */
export function readIdentityDiff(db: Db): Promise<IdentityDiffView>;
/**
 * Riassegnazione confermata (design §13.2, §16.3), solo in mode postgres e solo se il diff è ancora quello visto
 * (IdentityParams.expected, altrimenti PRECONDITION_FAILED IDENTITY_DIFF_CHANGED):
 *  - volume_to_pg: PG epoch 0 e marker valido sul volume (PG ripristinato a prima dell'inizializzazione, o crash
 *    fra marker e UPDATE): volume_id/epoch di PG := marker;
 *  - pg_to_volume: PG epoch ≥ 1 e marker assente o diverso (volume sostituito o ripristinato): MKCOL del principal se
 *    manca, PROPPATCH del marker di PG.
 * Mai un epoch che torna indietro. Poi rivalidazione del ledger ('identity-reassign'); la policy la riscrive il NOTIFY.
 */
export function runIdentityReassign(ctx: MigrationRunContext<IdentityParams>): Promise<IdentityReassignSummary>;
```

`migration/inventory.ts`:

```ts
/** Conteggi e anomalie per calendario (design §13.4), impatto delle iscrizioni, app-password, stima della durata. */
export function runInventory(ctx: MigrationRunContext<InventoryParams>): Promise<InventorySummary>;
/**
 * Calendari visti dallo strumento con l'esclusione dal piano: sidecar d'iscrizione (subscription_sidecar), archivio
 * (archive), collection_name nullo o non valido (collection_name_invalid), lifecycle ≠ active (not_active).
 * Usata da serialize, plan, verify, preflight e init.
 */
export function loadMigrationCalendars(db: Db, scope?: MigrationScope): Promise<MigrationCalendar[]>;
/** SUBSCRIPTION_BLOCKING_IMPACT: ore occupate e slot pubblici persi a settimana sulle prossime `weeks` (default 4). */
export function computeSubscriptionImpacts(db: Db, opts: { now: Date; weeks?: number }): Promise<SubscriptionImpact[]>;
/** App-password attive: totale, username diversi dal principal (informativo), username riservati (bloccante). */
export function inventoryAppPasswords(db: Db, principal: string): Promise<{ active: number; non_canonical: Array<{ id: string; username: string }>; reserved: Array<{ id: string; username: string }> }>;
```

L'inventario usa `serializeLegacy()` in sola analisi (stesse anomalie dell'anteprima, una sola implementazione) più i controlli che il serializer non vede (app-password, impatto delle iscrizioni, `BOOKING_DRIFT`, `POSSIBLE_DUPLICATE`). Stima: `ceil(oggetti / maxPutsPerSecond) + 1` secondi più il tempo misurato di lettura.

### 6.2 SERIALIZE

`migration/serialize.ts`:

```ts
export const SERIALIZER_VERSION = 1;
/** Sorgente letta in una sola istantanea (transazione REPEATABLE READ READ ONLY sul pool principale). */
export interface LegacySource {
  read_at: Date;
  calendars: MigrationCalendar[];
  /** Righe di calendar_events dei calendari inclusi, tranne source='ics_pull'. */
  events: Array<LegacyEventRowSnapshot & { created_at: string; updated_at: string }>;
  /** Prenotazioni con il titolo del tipo e il link della riunione già risolti (resolveLocationForBooking senza Google). */
  bookings: Array<{ uid: string; status: string; start_time: string; end_time: string; title: string; attendee_name: string; attendee_phone: string | null; location: string | null; meeting_url: string | null; created_at: string; anonymized: boolean }>;
  /** cal_object_ids per legacy_event_id (riuso degli href e degli id). */
  objectIds: ReadonlyMap<string, { calendar_id: string; href: string; recurrence_key: string; id: string; legacy_uid: string | null }>;
  /** Righe vive del ledger (riuso degli href). */
  ledger: readonly LedgerRow[];
}
export function loadLegacySource(db: Db, opts?: { scope?: MigrationScope; legacyKeys?: readonly LegacyKey[]; now?: Date }): Promise<LegacySource>;
/** Pura e deterministica: stesso ingresso, stesse opzioni e stesso `now` (solo per la minimizzazione) → stessi oggetti e hash. */
export function serializeLegacy(source: LegacySource, options: MigrationOptions, ctx: { now: Date }): SerializationResult;
export function canonicalJson(value: unknown): string;
export function legacyHash(snapshot: LegacySnapshot): string;
/**
 * Shadow e update delle righe adottate: applica all'oggetto corrente della destinazione solo i campi cambiati fra
 * lo snapshot precedente e quello nuovo (opsFromLegacyDiff per master e override; materializeOverride ed
 * excludeOccurrence per override aggiunti o tolti; per le proiezioni SUMMARY, DESCRIPTION, LOCATION, URL, DTSTART,
 * DTEND e STATUS), con CAS dei soli campi toccati (checkBase con la base dello snapshot precedente).
 */
export function patchFromLegacyDiff(target: CalendarObject, previous: LegacySnapshot, current: LegacySnapshot, ctx: { tz: string; now: Date }):
  { object: CalendarObject; changed: boolean; fields: string[]; conflicts: FieldConflict[] };
```

(`CalendarObject` e `FieldConflict` di `@calicchia/calendar-core`.) Regole del serializer (design §13.5): un oggetto per master con i suoi override; override cancellati → EXDATE; orfani → `detached` (opzione `convert`) o salto `ORPHAN_DISCARDED`; serie timed in `TZID=Europe/Rome` (`LEGACY_SERIES_TZ`), singoli con il fuso del calendario, all-day `VALUE=DATE` con la data calcolata con +12 h; RRULE non valida → evento singolo con `X-CALDES-LEGACY-RRULE`; UNTIL < DTSTART → salto; X-prop `X-CALDES-SOURCE`, `-SOURCE-ID`, `-LEGACY-ID` (`buildEventFromLegacy` di calendar-core); proiezioni rigenerate da `calendar_bookings` con `buildBookingProjectionIcs` di `radicale/booking-projection.ts` (stesso testo del job `project_booking`, una sola implementazione), solo per gli stati proiettati (`PROJECTED_BOOKING_STATUSES`), altrimenti salto `BOOKING_NOT_PROJECTED`; festività e chiusure con href deterministici e UID legacy; iscrizioni mai copiate; `validateObject` su ogni oggetto (errore → salto `INVALID_OBJECT` più anomalia); master cancellato → salto `CANCELLED_MASTER`; spostamenti della decisione 8 solo per gli id di `bookings_move_event_ids` (motivo atteso `NON_PROJECTION_MOVED`).

`migration/plan.ts`:

```ts
export interface TargetCollection { calendar_id: string; collection_name: string; exists: boolean; objects: ReadonlyMap<string, TargetObject> }
export interface TargetSnapshot { read_at: Date; collections: ReadonlyMap<string, TargetCollection> }
export interface PlanInput {
  mode: PlanMode;
  serialization: SerializationResult;
  /** Righe vive del ledger delle collezioni nell'ambito (e, per lo shadow, delle chiavi dell'ambito). */
  ledger: readonly LedgerRow[];
  target: TargetSnapshot;
  /** Le cancellazioni (fonte sparita) si calcolano solo dentro l'ambito. */
  scope: { calendarIds: ReadonlySet<string>; legacyKeys: ReadonlySet<LegacyKey> | null };
  force: { itemKeys: ReadonlySet<string>; codes: ReadonlySet<ConflictCode> };
}
/** Pura: tabella del §7.2. */
export function computePlan(input: PlanInput): PlanItem[];
/** PROPFIND getetag (Depth:1) per collezione; multiget solo degli href per cui needContent è vero. */
export function readTargetSnapshot(client: RadicaleClient, principal: string, collections: ReadonlyArray<{ calendar_id: string; collection_name: string }>, opts: { needContent: (calendarId: string, href: string, etag: string | null) => boolean; signal?: AbortSignal }): Promise<TargetSnapshot>;
/** sha256 del JSON canonico delle tuple (calendar_id, href, legacy_key, action, code, legacy_hash, fingerprint voluto, etag della destinazione), ordinate. */
export function planHash(items: readonly PlanItem[]): string;
/** Chiave stabile di un item fra anteprima e apply ("forza"): `${calendar_id}/${href}#${legacy_key}`. */
export function planItemKey(item: Pick<PlanItem, 'calendar_id' | 'href' | 'legacy_key'>): string;
/** Sorgente, ledger e destinazione letti, piano calcolato: usata da runPlan, runApply e dallo shadow. */
export function buildPlan(opts: { db: Db; client: RadicaleClient; principal: string; mode: PlanMode; scope: MigrationScope; options: MigrationOptions; legacyKeys?: readonly LegacyKey[]; force?: PlanInput['force']; now: Date; signal?: AbortSignal }):
  Promise<{ items: PlanItem[]; serialization: SerializationResult; hash: string; target: TargetSnapshot }>;
/** Run d'anteprima: righe 'object' (una per item, ObjectItemDetail) e 'anomaly', PlanSummary con plan_hash. */
export function runPlan(ctx: MigrationRunContext<PlanParams>): Promise<PlanSummary & { preview: PlanPreview }>;
```

Per lo shadow (`legacyKeys`), la chiave `event:<master>` comprende le righe vive `detached` di quel master (`legacy_snapshot->>'master_id'`), così un orfano che smette di esserlo viene tolto.

### 6.3 APPLY

`migration/apply.ts`:

```ts
/** Ricalcola il piano con le opzioni e l'ambito del run d'anteprima, ferma se expected_plan_hash differisce (PLAN_CHANGED, prima di qualsiasi scrittura), poi esegue. */
export function runApply(ctx: MigrationRunContext<ApplyParams>): Promise<ApplySummary>;
export interface ExecuteContext { db: Db; client: RadicaleClient; principal: string; runId: string | null; actor: string; mode: PlanMode; forced: boolean; signal?: AbortSignal; throttle: () => Promise<void>; now: () => Date }
export interface ExecutedItem { outcome: ApplyOutcome; code: ConflictCode | SkipCode | null; etag_after: string | null; http_status: number | null; error: string | null; fields: string[] }
/** Un item del piano con il protocollo del §4.3 (usata da runApply e dallo shadow). */
export function executePlanItem(item: PlanItem, ctx: ExecuteContext): Promise<ExecutedItem>;
/** Limitatore di processo condiviso da apply, shadow e archivio (MIGRATION_LIMITS.maxPutsPerSecond). */
export function migrationThrottle(): () => Promise<void>;
// Primitive del ledger (unico scrittore; transazioni brevi):
export function readLedger(db: Db, filter: { calendarIds?: readonly string[]; legacyKeys?: readonly LegacyKey[]; includeDeleted?: boolean }): Promise<LedgerRow[]>;
export function recordIntent(db: Db, input: { ledgerId: string | null; calendar_id: string; collection_name: string; href: string; kind: LedgerKind; legacy_key: LegacyKey; legacy_event_id: string | null; uid: string | null; op: LedgerIntentOp; fingerprint: string | null; legacy_hash: string | null; snapshot: LegacySnapshot | null; if_match: string | null; runId: string | null; objectIds: readonly ReservedObjectId[]; legacy_uid: string | null }): Promise<LedgerRow>;
export function completeIntent(db: Db, ledgerId: string, result: { etag: string | null; runId: string | null; adopted?: boolean }): Promise<LedgerRow>;
export function clearIntent(db: Db, ledgerId: string): Promise<void>;
export function adoptTarget(db: Db, input: { item: PlanItem; target: TargetObject; runId: string | null }): Promise<LedgerRow>;
export function retireLedgerRow(db: Db, ledgerId: string, runId: string | null): Promise<void>;
```

Ordine dell'apply: per collezione, prima le adozioni, poi create e update, per ultime le delete (uno spostamento crea nella nuova collezione prima di cancellare nella vecchia); al più `maxPutsPerSecond` richieste al secondo; riverifica dell'identità prima di ogni collezione e almeno ogni 60 s; avanzamento a ogni item; segnale controllato fra un item e l'altro, mai a metà del protocollo.

`migration/verify.ts`:

```ts
/** V1-V5 sui calendari dell'ambito (§8); righe 'diff' con la firma; riporto delle accettazioni. */
export function runVerify(ctx: MigrationRunContext<VerifyParams>): Promise<VerifySummary>;
/** Finestre di al più `maxDays` giorni su [from, to) (V3; design §13.7). Pura. */
export function v3Windows(from: Date, to: Date, maxDays?: number): Array<{ from: Date; to: Date }>;
/** Firma di una differenza (VerifyDiffDetail.signature). Pura. */
export function diffSignature(diff: Omit<VerifyDiff, 'detail'> & { detail: Omit<VerifyDiffDetail, 'signature'> }): string;
```

`migration/report.ts`:

```ts
/** Verdetti per calendario di un run di verifica, con le accettazioni. */
export function calendarVerdicts(db: Db, verifyRunId: string): Promise<CalendarVerdict[]>;
/** Accettazione esplicita delle sole differenze attese (le rosse → MigrationError NOT_ACCEPTABLE). */
export function acceptDiffs(db: Db, input: { runId: string; itemIds?: readonly string[]; calendarId?: string; allExpected?: boolean; actor: string }): Promise<AcceptDiffsResponse>;
/** Copia sulle differenze del run le accettazioni di differenze con la stessa firma nei run di verifica precedenti. */
export function carryOverAcceptances(db: Db, verifyRunId: string): Promise<number>;
/** Ultima verifica riuscita e suoi verdetti (wizard, shadow, criteri del cutover). */
export function latestVerifyVerdicts(db: Db): Promise<{ runId: string | null; verdicts: CalendarVerdict[]; acceptable: boolean; finished_at: Date | null }>;
/** Download di un run, generato al volo (niente file su disco): JSON con run e righe, oppure CSV delle righe. */
export function buildRunReport(db: Db, runId: string, format: 'json' | 'csv'): Promise<{ filename: string; contentType: string; body: string }>;
/** Conteggi di un piano (pura). */
export function summarizePlanItems(items: readonly PlanItem[]): Pick<PlanSummary, 'totals' | 'writes' | 'conflicts' | 'skips' | 'calendars'>;
```

### 6.4 SHADOW

`migration/shadow.ts`:

```ts
export function registerShadowMirrorJob(): void;
/** Handler del job shadow_mirror (§9.2). */
export function handleShadowMirror(job: CalendarJob, ctx: { signal: AbortSignal; extendLease(ms?: number): Promise<boolean>; log: Logger }): Promise<{ result?: unknown } | void>;
/** POST /shadow: precondizioni del §9.5, stato, apply di recupero (trigger 'shadow'). */
export function setShadowEnabled(input: { enabled: boolean; actor: string }): Promise<ShadowStateResponse>;
export function getParity(db: Db, now?: Date): Promise<ParityView>;
/**
 * Cron notturno: apply completo (trigger 'schedule', plan_run_id e opzioni dell'ultima anteprima riuscita, expected_plan_hash
 * null) con follow_up_verify V1-V5. Salta (con un log) se lo shadow è spento, il mode non è postgres o c'è un run attivo.
 */
export function runShadowNightly(): Promise<void>;
/** Cron orario: verifica V4 sui prossimi 14 giorni. */
export function runShadowHourlyParity(): Promise<void>;
/** Flag per singola iscrizione (decisione 5): sidecar, pull forzato verso l'indice, device_visible del sidecar. */
export function setSubscriptionMigrationFlags(subscriptionId: string, flags: SubscriptionFlagsRequest, actor: string): Promise<SubscriptionFlagsResponse>;
export function listSubscriptionsForMigration(db: Db): Promise<SubscriptionMigrationView[]>;
/** Riconciliazione in sola lettura (piano F3, attività 3): proiezioni orfane e prenotazioni senza proiezione, mai cancellazioni. */
export function reconcileProjectionsReadOnly(db: Db): Promise<{ missing: string[]; orphan: string[]; drift: string[] }>;
```

`radicale/booking-projection.ts` (spostamento del file della F2 con le stesse esportazioni; `lib/calendar/booking-projection.ts` resta come `export * from './radicale/booking-projection'`):

- `buildBookingProjectionIcs` costruisce il contenuto con `bookingProjectionContent` di calendar-core (una sola implementazione del testo della decisione 3, anche per il feed e per il serializer);
- `syncBookingProjection` confronta la risorsa esistente con il contenuto voluto sui soli campi della decisione 3 (SUMMARY, DESCRIPTION, LOCATION, URL) e la riscrive con `If-Match` quando la minimizzazione cambia lo stato (oltre 24 mesi dalla fine, prenotazione anonimizzata o sparita); le altre differenze restano come oggi (le modifiche fatte dall'API non si annullano, `BOOKING_DRIFT` per gli orari);
- una prenotazione è anonimizzata quando `attendee_email` ha la forma `erased-<…>@deleted.invalid` (§13.1).

`lib/calendar/gdpr.ts`:

```ts
export interface CalendarErasureReport {
  bookings: number; projections_legacy: number; events_redacted: number; audit_logs_redacted: number;
  ledger_redacted: number; migration_items_deleted: number; versions_purged: number; jobs_enqueued: number;
  manual_followup: string[];
}
export function calendarErase(email: string, opts: { actor: string; db?: Db }): Promise<CalendarErasureReport>;
/** Retention: run e righe oltre 30 giorni (tranne l'ultimo riuscito per tipo), upload dell'archivio oltre 24 ore. */
export function purgeMigrationArtifacts(opts?: { now?: Date }): Promise<{ runs: number; uploads: number }>;
/** Proiezioni appena oltre i 24 mesi: project_booking (store Radicale) o shadow_mirror (mode postgres con lo shadow acceso). */
export function enqueueExpiredProjectionRewrites(opts?: { now?: Date }): Promise<number>;
```

Cron (SHADOW):

- `data-retention.ts`: dopo le funzioni di oggi, `purgeMigrationArtifacts()` ed `enqueueExpiredProjectionRewrites()`, ognuna isolata (un errore si registra, non ferma le altre).
- `italian-holidays.ts`: in mode postgres invariato. Con lo store Radicale, PUT di `it-holiday-YYYY-MM-DD.ics` con UID `it-holiday-YYYY-MM-DD@caldes.it`, timed 00:00-24:00 Europe/Rome, nella collezione `role='holidays'`, con `If-None-Match: *` (412 = esiste già, anche per le festività migrate con l'UID legacy e lo stesso href), dentro `withCalendarWriteGate` e con write-through; mai MKCALENDAR (collezione assente → avviso e nessuna scrittura). Il cron non passa dalla facade (RadicaleStore accetta `source='system'` solo nel calendario `holidays`, ma con href e UID propri): PUT diretta con href e UID deterministici.
- `ics-pull.ts`: con lo store postgres, dopo il pull legacy, `pullAllSubscriptionsToIndex()` per le iscrizioni con sidecar (sostituisce il cron `calendar-subscriptions-index`, che l'integrazione toglie); con lo store Radicale invariato.

### 6.5 ROUTES

`migration/runs.ts`:

```ts
export interface CreateRunInput { kind: MigrationRunKind; trigger: MigrationRunTrigger; requestedBy: string; params: object; idempotencyKey?: string | null; requestHash?: string | null; planRunId?: string | null; planHash?: string | null }
/** MigrationError MIGRATION_BUSY (details.active_run), IDEMPOTENCY_KEY_REUSED; replay → replayed=true. */
export function createMigrationRun(input: CreateRunInput, opts?: { db?: Db }): Promise<RunCreatedResponse>;
export function registerMigrationRunJob(): void;
export function getMigrationRun(id: string, db?: Db): Promise<MigrationRunView | null>;
export function listMigrationRuns(filter: { kind?: MigrationRunKind; status?: MigrationRunStatus; limit?: number; cursor?: string | null }, db?: Db): Promise<RunsListResponse>;
export function listRunItems(runId: string, filter: { item_type?: MigrationItemType; code?: string; calendar_id?: string; action?: PlanAction; level?: VerifyLevel; expected?: boolean; severity?: ItemSeverity; cursor?: string | null; limit?: number }, db?: Db): Promise<RunItemsResponse>;
export function requestRunCancel(id: string, actor: string): Promise<MigrationRunView>;
export function activeMigrationRun(db?: Db): Promise<MigrationRunView | null>;
export function reapInterruptedRuns(opts?: { now?: Date }): Promise<number>;
export function readMigrationState(db?: Db): Promise<MigrationBackendState>;
export function writeDeclaration<K extends DeclarationKey>(key: K, value: DeclarationValues[K], actor: string): Promise<MigrationDeclarations>;
export function buildMigrationStateView(): Promise<MigrationStateView>;
/** Lock cal-migration su una connessione riservata del pool principale: wait=true per l'esecutore, false (try) per lo shadow. */
export function withMigrationLock<T>(fn: () => Promise<T>, opts: { wait: boolean; timeoutMs?: number }): Promise<T>;
```

`routes/calendar/migration.ts`: `export const calendarMigration: Hono` (§10).

Admin: pagina `/calendario/migrazione` (voce "Migrazione" nelle tab del calendario, chiave `nav.calendar.migration`), un componente per passo, client tipizzato in `apps/admin/src/lib/calendar-migration-api.ts` con i DTO copiati da `types.ts` (il contratto è il JSON). Polling: `GET /state` ogni 5 s, `GET /runs/:id` ogni 2 s durante un run.

### 6.6 OPS

`scripts/radicale-maint.sh` e `docs/calendar-radicale/matrice-device.md` (§14).

## 7. Anomalie, esiti del piano e conflitti

### 7.1 Anomalie (design §13.4)

Codici, gravità, opzione e descrizione in `ANOMALY_DEFINITIONS` di `types.ts`. Effetti sul serializer e sulla verifica:

| Codice | Effetto | Differenza attesa (V) |
|---|---|---|
| `ORPHAN_OVERRIDE_NOT_IN_RULE` | `detached` o salto (opzione `orphans`) | `ORPHAN_CONVERTED` (V3, V5) |
| `OVERRIDE_CALENDAR_MISMATCH` | override nell'oggetto del master | — |
| `UNTIL_ADMIN_PATTERN` | UNTIL a fine giornata locale (opzione, ON) | `UNTIL_REALIGNED` (V3, V4) |
| `ALLDAY_UNTIL_DATETIME`, `ALLDAY_EXDATE_DATETIME` | scritti come DATE | — |
| `ALLDAY_AMBIGUOUS` | regola +12 h | `ALLDAY_NORMALIZED` (V3) |
| `INVALID_RRULE` | evento singolo con `X-CALDES-LEGACY-RRULE` | `INVALID_RRULE_SINGLE` (V3, V4) |
| `UNTIL_BEFORE_DTSTART` | salto | — (V3: nessuna occorrenza anche nel legacy) |
| `RADICALE_RRULE_LIMIT` | salto `INVALID_OBJECT` | rossa finché non è corretta in PG |
| `NON_ROME_SERIES` | serie in Europe/Rome come la espande il legacy | — |
| `CANCELLED_MASTER` | salto (e delete di un oggetto già scritto) | `CANCELLED_MASTER_SKIPPED` (V3, V5) |
| `DST_SHIFTED_EXCEPTION` | EXDATE e RECURRENCE-ID riallineati (opzione, ON) | `DST_REALIGNED` (V3, V4, V5) |
| `MIXED_BYDAY` | nessuna modifica; dettaglio con le due espansioni | `MIXED_BYDAY` (V3, V4) |
| `DUPLICATE_HOLIDAY` | si migra la prima per data | `DUPLICATE_HOLIDAY_SKIPPED` (V3, V5) |
| `POSSIBLE_DUPLICATE` | informativa (copie di "Duplica", evento uguale a un'occorrenza) | — |
| `BOOKING_DRIFT` (`detail.kind`: `missing_projection`, `orphan_projection`, `time_mismatch`) | proiezione rigenerata dalla prenotazione; le orfane non si migrano | `BOOKING_DRIFT`, `BOOKING_REGENERATED` |
| `NON_PROJECTION_IN_BOOKINGS` | resta in `bookings` (default) o si sposta (decisione 8, per evento) | `NON_PROJECTION_MOVED` (V3, V5) |
| `ICS_PULL_REFETCH` | informativa (validatori azzerati al cutover, F4) | — |
| `SUBSCRIPTION_BLOCKING_IMPACT` | informativa, con l'impatto per iscrizione | `SUBSCRIPTION_BLOCKING_IMPACT` (V4 con le iscrizioni) |
| `NON_CANONICAL_APP_PASSWORD` | informativa | — |
| `RESERVED_APP_PASSWORD` | blocca (preflight e apply) | — |
| `EVENTS_IN_EXCLUDED_CALENDAR` | righe non migrate | — |
| `COLLECTION_NAME_INVALID` | calendario escluso, blocca | — |
| `INVALID_OBJECT` | salto | rossa |

Un'anomalia `blocking` impedisce l'apply (`PRECONDITION_FAILED` con `PREFLIGHT_BLOCKING`) finché non è risolta in PG.

### 7.2 Esiti del piano (decisione per chiave)

Ingressi per ogni chiave legacy K dell'ambito: oggetto voluto S (o salto, o fonte sparita), righe vive del ledger L di K, destinazione T all'href. H = `S.legacy_hash`.

| # | Situazione | `apply` | `shadow` |
|---|---|---|---|
| 1 | L con intento pendente | GET di T: fingerprint = intento → `adopt`; = ultima scrittura (o T assente per una create) → intento azzerato, si prosegue dalle righe sotto; altrimenti `conflict:UNTRACKED_TARGET` (delete: §4.3) | uguale |
| 2 | Collezione di S assente | `conflict:COLLECTION_MISSING` (mai forzabile) | uguale |
| 3 | Nessuna L in quella collezione, T assente, UID di S assente dalla collezione | `create` (`If-None-Match: *`) | uguale |
| 4 | Nessuna L, T presente e non tracciata | fingerprint = S → `adopt`; altrimenti `conflict:UNTRACKED_TARGET` | uguale |
| 5 | Nessuna L, T assente, UID di S a un altro href non tracciato | fingerprint = S → `adopt` di quell'href; altrimenti `conflict:UID_AT_OTHER_HREF` | uguale |
| 6 | L, H = `legacy_hash`, etag(T) = `written_etag` | `noop` | `noop` |
| 7 | L, H ≠ `legacy_hash` (o hash NULL), etag(T) = `written_etag` | `update` (`If-Match`; patch per campo se `adopted` o `derived`) | `update` con patch per campo |
| 8 | L, etag(T) ≠ `written_etag` ma fingerprint(T) = `written_fingerprint` | come 6 o 7 con l'etag aggiornato (`adopt` se H invariato) | uguale |
| 9 | L, H invariato, T cambiata | `conflict:TARGET_NEWER` | `noop` (lo shadow non insegue le derive della destinazione; le segnalano l'apply notturno e V1) |
| 10 | L, H cambiato, T cambiata | `conflict:BOTH_CHANGED` | `update` con patch per campo; `conflict:BOTH_CHANGED` (con i campi) solo se un campo toccato è cambiato anche nella destinazione |
| 11 | L scritta, T assente | `conflict:DELETED_IN_TARGET` | uguale |
| 12 | Fonte sparita o salto, L viva, etag(T) = `written_etag` (o fingerprint uguale) | `delete` (`If-Match`) | uguale |
| 13 | Fonte sparita, L viva, T assente | `adopt` (ritiro della riga) | uguale |
| 14 | Fonte sparita, L viva, T cambiata | `conflict:TARGET_NEWER` | uguale |
| 15 | L viva di K in un'altra collezione (spostamento) | `delete` lì, dopo la `create` nella nuova | uguale |
| 16 | Salto (`SKIP_CODES`) senza L | `skip` | uguale |
| 17 | L con `revalidate_reason` e azione di scrittura (3, 7, 10, 12, 15) | `conflict:REVALIDATION_REQUIRED`; `noop`/`adopt` smarcano | uguale |

Gli oggetti della destinazione non tracciati e non voluti da nessuna S non sono item del piano: li riporta V1 (`TARGET_UNTRACKED`) e il piano non li cancella mai.

**Forza** (`FORCEABLE_CONFLICTS`, per item con `force_item_ids` o per codice con `force_codes`): `TARGET_NEWER`, `BOTH_CHANGED`, `UNTRACKED_TARGET` → scrittura del contenuto del piano con `If-Match` dell'etag corrente; `DELETED_IN_TARGET` → `create`; `UID_AT_OTHER_HREF` → scrittura all'href trovato e ledger su quell'href; `REVALIDATION_REQUIRED` → l'azione calcolata. Esito `forced`, riga `forced = true`. `COLLECTION_MISSING` non si forza: serve l'init.

**Seconda esecuzione**: dopo un apply senza conflitti, un nuovo piano ha solo `noop` e `skip` (`ApplySummary.zero_writes`), anche dopo un kill a metà (righe 1 e 8).

## 8. Verifica per calendario (design §13.7)

### 8.1 Livelli

| Livello | Confronta | Codici | Attese ammesse |
|---|---|---|---|
| V1 strutturale | righe vive del ledger della collezione contro PROPFIND `getetag` | `LEDGER_ETAG_MISMATCH`, `LEDGER_TARGET_MISSING`, `TARGET_UNTRACKED`, `LEDGER_INTENT_PENDING`, `COLLECTION_MISSING` | nessuna |
| V2 contenuto | multiget e fingerprint semantico contro il piano corrente (S); per le righe `adopted`/`derived` solo i campi del piano (`readFieldValues`), le proprietà in più sono informative | `CONTENT_MISMATCH`, `TARGET_UNPARSABLE`, `PLAN_TARGET_MISSING` | nessuna |
| V3 occorrenze | `listOccurrences` legacy (codice congelato, PgLegacyStore) contro `expandObject` di calendar-core sul contenuto della destinazione, su [oggi − 365, oggi + 730] a finestre di al più 60 giorni (`v3Windows`), per calendario | `OCCURRENCE_MISSING`, `OCCURRENCE_EXTRA`, `OCCURRENCE_TIME_DIFF`, `OCCURRENCE_STATUS_DIFF`, `OCCURRENCE_ALLDAY_DIFF` | i motivi di `S.expected_reasons` dell'oggetto e `BOOKING_*`, `CANCELLED_MASTER_SKIPPED`, `DUPLICATE_HOLIDAY_SKIPPED`, `NON_PROJECTION_MOVED` |
| V4 busy | busy legacy (semantica di `legacy/events-pg.getBusyRanges`: calendari bloccanti, confermati, timed, proiezioni escluse) contro il busy della destinazione (`computeBlocks` più `blocks_availability`), intervalli fusi, su [oggi, oggi + 180] (14 giorni nel giro orario). Due varianti: **senza iscrizioni** (righe `ics_pull` e collezioni `sub-*` escluse) e **con le iscrizioni** (legacy con le righe `ics_pull` dei calendari bloccanti; destinazione con l'indice delle iscrizioni come se tutte bloccassero) | `BUSY_MISSING`, `BUSY_EXTRA` | senza iscrizioni: solo i motivi degli oggetti sovrapposti (`DST_REALIGNED`, `UNTIL_REALIGNED`, `INVALID_RRULE_SINGLE`, `MIXED_BYDAY`, `BOOKING_DRIFT`); con le iscrizioni: anche `SUBSCRIPTION_RESYNCED`, `SUBSCRIPTION_BLOCKING_IMPACT` (informativa, non rossa) |
| V5 feed | per i calendari con feed attivo: insieme di (UID pubblicato, istanze nella finestra del feed) del feed legacy (`buildCalendarFeed` di PgLegacyStore) contro `buildFeed` di calendar-core sugli oggetti della destinazione con `legacyUid` | `FEED_UID_MISSING`, `FEED_UID_EXTRA`, `FEED_INSTANCES_DIFF` | `FEED_INSTANCES_DIFF`: `OVERRIDE_UID_MASTER`, `CANCELLED_OVERRIDE_SUPPRESSED`, `DST_REALIGNED`, `ORPHAN_CONVERTED`, `CANCELLED_MASTER_SKIPPED`, `NON_PROJECTION_MOVED`, `DUPLICATE_HOLIDAY_SKIPPED`, `BOOKING_REGENERATED`, `BOOKING_DRIFT`, `UNTIL_REALIGNED`, `MIXED_BYDAY`, `INVALID_RRULE_SINGLE`, `ALLDAY_NORMALIZED` (`LEVEL_EXPECTED_REASONS.V5` di verify.ts); `FEED_UID_MISSING`/`FEED_UID_EXTRA`: solo i motivi che spiegano la presenza dell'UID (`CANCELLED_MASTER_SKIPPED`, `DUPLICATE_HOLIDAY_SKIPPED`, `NON_PROJECTION_MOVED`, `BOOKING_DRIFT`, `ORPHAN_CONVERTED`, `OVERRIDE_UID_MASTER`, `BOOKING_REGENERATED`); un UID di un oggetto migrato diverso dal legacy è sempre rosso (gli abbonati vedrebbero un doppione) |

V3 verifica anche la verifica stessa: un test con la serie di produzione lun-mar-gio-ven senza fine (più di 500 occorrenze sull'intervallo, oltre il limite di espansione del legacy) non produce rossi.

### 8.2 Colori

- **verde**: nessuna differenza; **giallo**: solo differenze attese (motivo in `EXPECTED_DIFF_REASONS`); **rosso**: almeno una inattesa (`verifyColorOf`, `worstColor`).
- Un calendario è **accettabile** (`verdictAcceptable`) se verde, o giallo con tutte le differenze accettate esplicitamente. Le rosse non si accettano (`NOT_ACCEPTABLE`): si correggono (nuovo apply, forza, correzione in PG).
- V4 è globale: la variante senza iscrizioni entra nel colore di ogni calendario con oggetti sovrapposti alla differenza e in `VerifySummary.v4`. Le differenze della variante con le iscrizioni sono righe `diff` V4 con `expected = true`, `severity = 'info'` e `detail.variant = 'with_subscriptions'`: compaiono in `VerifySummary.v4.with_subscriptions` e nell'impatto delle iscrizioni, ma non entrano nel colore dei calendari né nell'accettazione.

### 8.3 Ingressi coerenti

La verifica gira sotto `cal-migration` (nessuno shadow nel frattempo), legge sorgente e destinazione una volta per calendario e usa lo stesso `now` per tutte le finestre.

### 8.4 Accettazioni

Ogni differenza ha `detail.signature` (`diffSignature`). Alla fine di `runVerify`, `carryOverAcceptances` riporta sul run l'accettazione (stesso `accepted_by`, `accepted_at = now()`) delle differenze con la stessa firma già accettate in un run di verifica precedente: il giro notturno dello shadow non richiede di riaccettare ogni notte le stesse differenze attese. Una differenza nuova o cambiata va accettata di nuovo.

## 9. Shadow mirror (design §13.8)

### 9.1 Cosa scrive e quando

| Quando | Cosa | Modo |
|---|---|---|
| Ogni scrittura legacy di `calendar_events` (non `ics_pull`) e ogni modifica rilevante di `calendar_bookings`, con lo shadow acceso | job `shadow_mirror(<chiave>)` dal trigger della 165, eseguito dopo il debounce | `shadow` (patch per campo) |
| All'attivazione | apply completo di recupero (trigger `shadow`) | `apply` |
| Ogni notte (`runShadowNightly`) | apply completo con le opzioni dell'ultima anteprima riuscita, più verifica V1-V5 (`follow_up_verify`) | `apply` |
| Ogni ora (`runShadowHourlyParity`) | verifica V4 sui prossimi 14 giorni | — |
| Erasure GDPR, retention delle proiezioni | job `shadow_mirror` con `payload.erasure = true` (eseguiti anche con lo shadow spento, §13.1) | `shadow` |

### 9.2 Handler del job

1. Stato riletto: `mode ≠ postgres`, o shadow spento senza `payload.erasure` → job chiuso senza azione.
2. `withMigrationLock(…, { wait: false })`: lock occupato da un run → `CalendarUnavailableError('transition')` (errore d'attesa: riaccodato con la pausa di `computeCalendarJobWaitMs`).
3. `assertMigrationWritable()`: identità non `ok` → errore d'attesa (dead letter dopo 48 h, f2-modules §3).
4. `buildPlan({ mode: 'shadow', legacyKeys: [chiave] })` con le opzioni dell'ultima anteprima riuscita (o quelle di default), poi `executePlanItem` per ogni item con `migrationThrottle()`.
5. Esito in `cal_jobs.result`: `{ items: [{ legacy_key, href, action, outcome, code, fields }] }`. Un conflitto alza l'avviso `shadow-conflict` (`raiseIndexAlert`) e conta in `ParityView.open_conflicts` finché un job o un apply successivo della stessa chiave non lo risolve.
6. L'handler NON restituisce `currentSourceVersion`: una scrittura legacy arrivata durante il job crea un nuovo pending (coalescenza solo sui pending) che girerà dopo.

### 9.3 Patch per campo

Oggetto assente in destinazione → scrittura completa dal piano (sicura: i device sono in sola lettura). Oggetto già presente → `patchFromLegacyDiff` fra `legacy_snapshot` e lo snapshot corrente applicato all'oggetto corrente letto da Radicale, PUT con `If-Match` dell'etag appena letto: VALARM, ATTENDEE e X-* aggiunti dopo restano (test: VALARM preservato dopo una modifica legacy). Su 412 si rilegge e si riprova una volta, poi conflitto.

### 9.4 Proiezioni e iscrizioni

- Le proiezioni vanno nello shadow (decisione 3 presa): chiave `booking:<uid>`, contenuto da `calendar_bookings` con `buildBookingProjectionIcs`, patch sui campi della decisione 3.
- Iscrizioni: mai copiate dallo shadow. I flag per singola iscrizione (`blocks_availability`, `device_visible`) si impostano con `PATCH /subscriptions/:id` (decisione 5: default nascosta e non bloccante, impatto mostrato prima); la prima impostazione crea il sidecar (`enableSubscriptionIndex(…, { allowPostgresMode: true })`, invisibile al legacy per il §1.3) e forza un pull verso l'indice; `device_visible` richiede la collezione `sub-<id8>` (creata dall'init `create_missing`) e lo specchio (`subscriptions/mirror.ts`, F2) la popola. In mode postgres i flag non cambiano il busy legacy.

### 9.5 Attivazione e parità

- Accensione (`ATTIVA SHADOW`): mode postgres, identità `ok`, ultimo apply riuscito senza conflitti né fallimenti, ultima verifica successiva accettabile, nessuna riga da rivalidare. Altrimenti `PRECONDITION_FAILED` con i motivi (`APPLY_REQUIRED`, `APPLY_CONFLICTS`, `VERIFY_REQUIRED`, `VERIFY_RED`, `REVALIDATION_PENDING`, `IDENTITY_NOT_OK`). `shadow_since = now()`; apply di recupero accodato (se un run è attivo, `catch_up_run = null` e ci pensa il giro notturno).
- Spegnimento: sempre ammesso, nessuna conferma; i job pending si chiudono senza azione.
- Parità (`getParity`): un giro programmato è verde quando la verifica è accettabile (V4 senza iscrizioni non rossa per il giro orario). `green_since` è la fine del primo giro verde dopo l'ultimo non verde (o `shadow_since`); `satisfied` richiede almeno `parityDaysRequired` (7) giorni e un giro notturno verde per ognuno di quei giorni.

## 10. API REST `/api/admin/calendar/migration`

### 10.1 Montaggio e regole comuni

- Router `calendarMigration` montato in `src/app.ts` con `app.route('/api/admin/calendar/migration', calendarMigration)` PRIMA di `app.route('/api/admin/calendar', calendarAdmin)`; protetto dal JWT come il resto di `/api/admin/calendar/*` (già in `protectedPaths`).
- Corpo JSON, risposte JSON (tranne il download). Errori `MigrationErrorBody` `{ error, code, details? }` con lo stato di `MIGRATION_ERROR_STATUS`; `CalendarUnavailableError` → 503 `CALENDAR_UNAVAILABLE`.
- Ogni POST/PATCH che cambia qualcosa scrive una riga in `audit_logs` (`table_name = 'calendar_migration'`, `action` = azione, `record_id` = run se c'è, `metadata` senza dati personali).

### 10.2 Endpoint

| Metodo e percorso | Corpo | Risposta | Note |
|---|---|---|---|
| `GET /state` | — | `MigrationStateView` | wizard, stato, run attivo e ultimi run |
| `POST /preflight` | `PreflightRequest` | 202/200 `RunCreatedResponse` | senza Radicale: run chiuso subito (§5.2) |
| `POST /init` | `InitRequest` | 202/200 `RunCreatedResponse` | conferma `INIZIALIZZA RADICALE` (`initialize`) o `CREA COLLEZIONI` (`create_missing`); chiave obbligatoria |
| `GET /identity` | — | `IdentityDiffView` | sola lettura |
| `POST /identity/reassign` | `IdentityReassignRequest` | 202/200 `RunCreatedResponse` | conferma `RIASSEGNA IDENTITÀ`; chiave obbligatoria |
| `POST /phase0/archive` | multipart: `file` (.zip di phase0-export, .tar/.tar.gz/.tgz di phase0-backup o .ics, ≤ 20 MB), `confirm` | 202/200 `RunCreatedResponse` | conferma `IMPORTA ARCHIVIO`; chiave obbligatoria; 413 oltre il limite |
| `POST /declarations` | `DeclarationRequest` | 200 `{ declarations: MigrationDeclarations }` | conferma `CONFERMO` per le dichiarazioni che tolgono un controllo (`WAIVER_DECLARATIONS`) |
| `POST /inventory` | `InventoryRequest` | 202/200 `RunCreatedResponse` | |
| `POST /plan` | `PlanRequest` | 202/200 `RunCreatedResponse` | opzioni con `resolveMigrationOptions` |
| `POST /apply` | `ApplyRequest` | 202/200 `RunCreatedResponse` | conferma `APPLICA`, più `confirm_force: 'FORZA'` con item o codici forzati; chiave obbligatoria; l'anteprima deve essere un run `plan` riuscito |
| `POST /verify` | `VerifyRequest` | 202/200 `RunCreatedResponse` | |
| `POST /runs/:id/accept` | `AcceptDiffsRequest` | 200 `AcceptDiffsResponse` | conferma `ACCETTA`; solo run `verify` (`PRECONDITION_FAILED RUN_KIND_NOT_VERIFY`), solo differenze attese |
| `POST /shadow` | `ShadowRequest` | 200 `ShadowStateResponse` | conferma `ATTIVA SHADOW` per accendere |
| `GET /parity` | — | `ParityView` | |
| `GET /subscriptions` | — | `{ subscriptions: SubscriptionMigrationView[] }` | |
| `PATCH /subscriptions/:id` | `SubscriptionFlagsRequest` | 200 `SubscriptionFlagsResponse` | |
| `GET /runs` | query `kind`, `status`, `limit` (≤ 100), `cursor` | `RunsListResponse` | ordine dal più recente |
| `GET /runs/:id` | — | `MigrationRunView` | 404 `RUN_NOT_FOUND` |
| `GET /runs/:id/items` | query `item_type`, `code`, `calendar_id`, `action`, `level`, `expected`, `severity`, `cursor`, `limit` (≤ 500) | `RunItemsResponse` | `cursor` = id dell'ultima riga |
| `GET /runs/:id/report` | query `format` (`json` o `csv`) | file (`Content-Disposition: attachment`) | generato al volo |
| `POST /runs/:id/cancel` | — | 200 `{ run }` | `RUN_NOT_ACTIVE` su un run concluso |
| `POST /cutover`, `POST /rollback/preview`, `POST /rollback`, `POST /finalize` | — | 409 `PHASE_NOT_AVAILABLE` | F4 |

### 10.3 Idempotenza e conferme

- Chiave nell'header `Idempotency-Key` (oppure nel campo `idempotency_key` del corpo), 8-200 caratteri `[A-Za-z0-9._:-]`, obbligatoria per i run di `WRITING_RUN_KINDS` (`400 IDEMPOTENCY_KEY_REQUIRED`). `request_hash` = sha256 del JSON canonico di `{ path, body }`. Stessa chiave e stesso hash → `200` con il run esistente e `replayed: true`; stessa chiave e hash diverso → `409 IDEMPOTENCY_KEY_REUSED`.
- Conferme: frase esatta di `MIGRATION_CONFIRMATIONS` (`confirmationMatches`), altrimenti `400 CONFIRMATION_REQUIRED` con `details.expected`. Le azioni che non scrivono non chiedono conferme.
- Precondizioni (`409 PRECONDITION_FAILED`, `details.reasons` di `PRECONDITION_REASONS`): `init initialize` solo con identità `uninitialized` e principal assente; `init create_missing` solo con identità `ok`; `plan` dopo un preflight riuscito senza blocchi; `apply` dopo un `plan` riuscito, nessuna anomalia bloccante, identità `ok`; `shadow` §9.5.
- Run attivo: `409 MIGRATION_BUSY` con `details.active_run` (`MigrationRunView`).

### 10.4 Esempi

Richiesta di apply dopo un'anteprima (header `Idempotency-Key: 0b7c6f0e-2c1d-4b8e-9a51-6d3f2e1a9c44`):

```json
{
  "plan_run_id": "5f1d2c3b-8a9e-4f70-b1c2-d3e4f5a6b7c8",
  "expect_plan_hash": "9c1e…(64 cifre esadecimali)…",
  "force_item_ids": [],
  "force_codes": [],
  "confirm": "APPLICA"
}
```

Risposta `202`:

```json
{
  "replayed": false,
  "run": {
    "id": "a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d",
    "kind": "apply",
    "status": "queued",
    "trigger": "admin",
    "requested_by": "admin:7f9a…",
    "created_at": "2026-10-12T20:15:03.120Z",
    "started_at": null,
    "finished_at": null,
    "heartbeat_at": null,
    "progress": {},
    "summary": null,
    "error": null,
    "plan_run_id": "5f1d2c3b-8a9e-4f70-b1c2-d3e4f5a6b7c8",
    "plan_hash": "9c1e…",
    "attempts": 0,
    "cancel_requested": false
  }
}
```

Durante l'esecuzione `GET /runs/:id` restituisce per esempio `"status": "running", "progress": { "phase": "write", "done": 41, "total": 100, "calendar_id": "…", "message": "Scrittura in f" }`; alla fine `"status": "succeeded"` con `summary` di tipo `ApplySummary`. Run già attivo:

```json
{ "error": "È già in corso un run di migrazione (verify).", "code": "MIGRATION_BUSY", "details": { "active_run": { "id": "…", "kind": "verify", "status": "running" } } }
```

## 11. Wizard a 6 passi (design §13.13)

### 11.1 Passi

| # | Id | Titolo | Azioni |
|---|---|---|---|
| 1 | `prerequisiti` | Prerequisiti e inizializzazione | `preflight`, `initialize`, `create_collections`, `archive`, `declare`, `identity_reassign` |
| 2 | `anteprima` | Anteprima e opzioni | `inventory`, `plan` (opzioni del §13.4, iscrizioni con impatto e flag) |
| 3 | `applica` | Applica | `apply` (avanzamento live, ripeti, forza per item) |
| 4 | `verifica` | Verifica | `verify`, `accept` (semafori per calendario e livello, drill-down sulle righe, download) |
| 5 | `shadow` | Shadow e prova sui device | `shadow_on`, `shadow_off`, `declare` (matrice device); parità e coda |
| 6 | `passaggio` | Passaggio | `cutover` sempre disabilitata in F3, con i criteri |

### 11.2 Stato dei passi (`buildMigrationStateView`)

1. `prerequisiti`: `done` con l'ultimo preflight riuscito e `ready`, identità `ok`, nessuna collezione mancante, `_canary` presente e dichiarazione `phase0`; `attention` con avvisi; `blocked` con controlli falliti; `running` con un run `preflight`, `init`, `archive` o `identity` attivo.
2. `anteprima`: `locked` finché il passo 1 non è `done`; `done` con un `plan` riuscito dopo l'ultimo preflight; `attention` se l'anteprima ha più di `planMaxAgeHours` ore, conflitti o anomalie bloccanti.
3. `applica`: `locked` senza anteprima; `done` con l'ultimo apply riuscito, senza conflitti né fallimenti; `attention` con conflitti, fallimenti o se non c'è ancora un apply successivo con `zero_writes` (messaggio "Ripeti per verificare zero scritture").
4. `verifica`: `locked` senza apply; `done` con l'ultima verifica successiva all'ultimo apply accettabile; `attention` con gialli da accettare; `blocked` con rossi.
5. `shadow`: `locked` finché il passo 4 non è `done`; `running` con lo shadow acceso e la parità non ancora soddisfatta; `done` con parità soddisfatta e dichiarazione `device_matrix` con esito `passed`; `attention` con giri non verdi o conflitti aperti.
6. `passaggio`: sempre `disabled` in F3; `CutoverAvailability` con `available: false`, `phase: 'F4'` e i criteri (`verify_acceptable`, `shadow_parity`, `device_matrix`, `backup_recent`, `no_open_conflicts`) valutati come informazione.

`current_step` = il primo passo non `done`. Ogni azione ha `enabled`, `reason` (in italiano) e `confirm` (frase da digitare).

### 11.3 Dopo il cutover

Le viste della F4 (giorni residui, proiezione inversa, anteprima del rollback, "Torna a Postgres", "Chiudi finestra") non esistono in F3; il componente `cutover-step` mostra solo criteri e frase di conferma disabilitata.

### 11.4 Dichiarazioni

`migration_declarations` (`MigrationDeclarations`), scritte da `POST /declarations` (`writeDeclaration`) con `at` e `by`:

| Chiave | Valore | Sblocca |
|---|---|---|
| `phase0` | `{ status, note?, archive_run_id? }` con `status` fra `absent`, `archived` e `present_not_imported` (`archived` la scrive anche l'archivio riuscito) | `PHASE0_VOLUME` |
| `remote_mode_accepted` | `{ reason }` | `VOLUME_WATCH` |
| `public_401_verified` | `{ method, note? }` | `SERVICE_PUBLIC_401` |
| `backup_verified` | `{ note? }`, valida 24 ore | `BACKUP_RECENT` |
| `device_matrix` | `{ result, strict_preconditions, allday_transp_rule, devices, notes? }` | passo 5 (e criterio del cutover) |

## 12. Archivio della Fase 0 (decisione 7)

1. **Sull'host** (OPS): `radicale-maint.sh phase0-detect` cerca il vecchio volume `radicale_data` (mai montato al posto di quello nuovo); `phase0-backup` ne fa il tar (sola lettura) con sha256 e manifest; `phase0-export` produce `archivio-fase0.zip` con gli item `.ics` (nome `<collezione>__<item>.ics`) e il manifest.
2. **Nel wizard** (passo 1): dichiarazione `phase0` (`absent` se il volume non c'è) oppure caricamento dello zip (`POST /phase0/archive`). Il file va in `CAL_MIGRATION_UPLOAD_DIR` (`0600`, cartella `0700`) e si cancella a fine run.
3. **Run `archive`** (INIT): crea, se manca, la riga `archivio-fase0` (`origin='migration'`, `role='user'`, `blocks_availability=false`, `ics_feed_enabled=false`, `is_system=false`, nome "Archivio Fase 0") e la collezione (MKCALENDAR in `init.ts`, con le dead prop); per ogni item valido (parse di calendar-core, `validateObject`) PUT con `If-None-Match: *` (412 = già importato) e riga del ledger `archive`; UID duplicati nell'archivio → si tiene il primo (anomalia); item non validi → righe `anomaly` e niente scrittura. Idempotente: una seconda esecuzione è tutta `unchanged`. Alla fine `phase0 = archived`.
4. **Effetti**: l'archivio è escluso da piano, verifica e shadow; non blocca mai (non è nel busy); è invisibile al legacy (§1.3). In F3 è in sola lettura per i device come tutto il resto (policy `shadow`). La sola lettura dopo il cutover richiede un ruolo dei device in sola lettura (questione aperta 1).

## 13. GDPR (design §16.4)

### 13.1 `calendarErase(email)`

Aggancio: `DELETE /api/gdpr-requests/erase/:email` chiama `calendarErase` e aggiunge `calendar: CalendarErasureReport` alla risposta e il seguito manuale. Passi:

1. Prenotazioni con `lower(attendee_email) = email`: anonimizzate (`attendee_name = 'Dato cancellato (GDPR)'`, `attendee_email = 'erased-<id>@deleted.invalid'`, telefono, azienda, messaggio, risposte e consenso a NULL o vuoti); la riga resta (storico e vincolo EXCLUDE).
2. Righe legacy delle proiezioni (`source='booking'` e `source_id` fra quelle prenotazioni): titolo "Prenotazione", descrizione, luogo e link a NULL. Le altre righe di `calendar_events` (e `calendar_events_legacy` dopo il finalize) che contengono l'email in titolo, descrizione o luogo: l'email sostituita da `[dato rimosso]`. In mode postgres senza GUC (così lo shadow propaga); con `mode ≠ postgres` dentro `SET LOCAL caldes.reverse_sync = 'on'` (trigger 166 della F4).
3. `audit_logs` di `calendar_events` e `calendar_bookings` delle righe toccate (o che contengono l'email): `old_data`/`new_data` redatti (campi personali sostituiti).
4. Ledger: righe delle chiavi toccate con `legacy_snapshot`, `intent_snapshot` e `legacy_hash` a NULL (il piano successivo riscrive la destinazione); righe dei run che citano le chiavi o l'email cancellate.
5. Destinazione: in mode postgres con il volume inizializzato, job `shadow_mirror` con `payload.erasure = true` per le chiavi toccate (eseguiti anche con lo shadow spento: patch dei campi redatti, proiezioni minimizzate); con lo store Radicale, `project_booking` per le prenotazioni e update dalla facade per gli altri eventi.
6. Indice: `purgeVersionsForErasure` (f2-modules §5.6) degli oggetti toccati; `raw_ics` si aggiorna con la sync dopo la riscrittura.
7. `cal_jobs` conclusi o morti delle chiavi toccate: cancellati.
8. Seguito manuale nella risposta: `scripts/radicale-maint.sh purge-cache` sul server (cache degli item di Radicale); i backup scadono da soli (30 giorni).

### 13.2 Retention

Versioni 90 giorni (F2); backup 30 giorni (script); proiezioni concluse minimizzate dopo 24 mesi (`enqueueExpiredProjectionRewrites`, nel cron di retention); run e righe della migrazione dopo 30 giorni e upload dopo 24 ore (`purgeMigrationArtifacts`); `calendar_events_legacy` 12 mesi dopo il finalize (F7).

## 14. Operatività (OPS)

### 14.1 `scripts/radicale-maint.sh`

Stesse convenzioni di `backup-calendar-stack.sh` (variabili `RADICALE_VOLUME_DIR`, `RADICALE_VOLUME`, `COMPOSE_PROJECT`, `RADICALE_PRINCIPAL`, `LOCK_TIMEOUT`; log con prefisso; `set -Eeuo pipefail`). Sottocomandi:

| Sottocomando | Cosa fa | Scrive |
|---|---|---|
| `status` | marker d'identità, collezioni, item, dimensione, presenza di `.Radicale.lock` | no |
| `du` | dimensione e item per collezione, avviso oltre 5000 item | no |
| `phase0-detect` | cerca il volume della Fase 0 (`PHASE0_VOLUME`, `<progetto>_radicale_data`, `radicale_data`) | no |
| `phase0-backup [--out DIR]` | tar.gz in sola lettura del volume della Fase 0, sha256, manifest | file locali |
| `phase0-export [--out FILE]` | zip degli item `.ics` per il wizard (al più 20 MB e 20000 item) | file locale |
| `purge-cache` | rimuove le cartelle `.Radicale.cache` sotto `flock -x` di `.Radicale.lock` (erasure GDPR); Radicale le ricostruisce | volume |

Exit: 0 ok, 1 errore, 2 uso errato, 3 volume della Fase 0 assente (`phase0-*`), 75 lock occupato. Mai montare il volume della Fase 0 in Radicale; mai toccare file fuori dalle cache in `purge-cache`.

### 14.2 Matrice device (`docs/calendar-radicale/matrice-device.md`)

Protocollo e tabella dei risultati per iOS, macOS, DAVx5 e Thunderbird, in staging (stack di prova con la policy `live` temporanea, come l'end-to-end della F1, mai in produzione in F3): login con un'app-password esistente anche con username diverso da `federico`; sola lettura in shadow (PUT → 403) e nessuna password invalidata su 403 e su 500 (backend giù senza cache); collezioni protette (`bookings`, `f`, `scadenze`) in sola lettura e `_canary` assente dall'elenco; `If-Match` con `strict_preconditions = True` (quali client mandano If-Match, cosa succede senza); X-prop e VALARM preservati in andata e ritorno; TRANSP degli all-day ("Mostra come: occupato/libero", decisione 6); fusi orari. L'esito e le due decisioni (`strict_preconditions`, `allday_transp_rule`) vanno nella dichiarazione `device_matrix`.

### 14.3 Backup registrato

`backup-calendar-stack.sh` (con `calendar_stack.py`), a fine run (completo o incompleto), aggiorna `calendar_backend_state.last_stack_backup` (`{id, at, complete, volume_id, epoch, manifest_sha256}`) con un `UPDATE` via psql in best effort: un errore si registra e non cambia l'exit del backup.

## 15. Cron, bootstrap e variabili (per l'integrazione)

| Avvio | Funzione | Proprietario |
|---|---|---|
| boot, prima di `startCalendarJobWorker()` | `registerMigrationRunJob()`, `registerShadowMirrorJob()` | ROUTES, SHADOW |
| boot, dopo il worker (solo con Radicale configurato) | `reapInterruptedRuns()` | ROUTES |
| cron 5 min (`calendar-migration-reaper`) | `reapInterruptedRuns()` | ROUTES |
| cron giornaliero (`calendar-shadow-nightly`, ore 3) | `runShadowNightly()` | SHADOW |
| cron orario (`calendar-shadow-parity`) | `runShadowHourlyParity()` | SHADOW |
| cron 15 min `ics-pull` (esistente) | `runIcsPull()` con il pull verso l'indice; togliere `calendar-subscriptions-index` | SHADOW |
| cron giornaliero `data-retention` (esistente) | `runDataRetention()` con retention della migrazione e delle proiezioni | SHADOW |
| mount | `app.route('/api/admin/calendar/migration', calendarMigration)` prima di `/api/admin/calendar` | ROUTES |

| Variabile | Default | Significato |
|---|---|---|
| `RADICALE_PUBLIC_URL` | — | Origin pubblica di Radicale (es. `https://dav.calicchia.design`) per `SERVICE_PUBLIC_401` |
| `CAL_MIGRATION_UPLOAD_DIR` | `${PRIVATE_UPLOAD_DIR}/calendar-migration` | File caricati per l'archivio della Fase 0 (`0700`). Mai sotto `UPLOAD_DIR`, che l'API serve in pubblico su `/media/*` |
| `RADICALE_PROBE_PASSWORD` | — | Già del control-plane (§1.3): password di `caldes-probe` per i controlli `PROBE_READONLY` e `PROBE_CANARY_FORBIDDEN` (ripiego: `CALDES_PROBE_PASSWORD`) |

## 16. Test minimi per gruppo

Ogni gruppo scrive i propri test in `apps/api/test/calendar/<modulo>.test.ts` (senza Radicale) e `apps/api/test/integration/<modulo>.test.ts` (Radicale reale con `useRadicale()`, saltati senza `RADICALE_BIN`), con etichette proprie (`useFixtures('<gruppo>-…')`) e senza `before()` di primo livello che usi il database (README dei test).

- **SERIALIZE**: serializer sulle fixture con le anomalie (eccezioni DST spostate, eventi non-proiezione in bookings, orfani, override in altro calendario, RRULE non valida, UNTIL < DTSTART, all-day ambigui, festività duplicate, dati di produzione: serie infinita lun-mar-gio-ven 09:00 Roma, serie conclusa, copie di "Duplica", 91 festività più "Ferie", proiezione confermata e prenotazione annullata); determinismo dell'hash; riuso degli href; proiezioni legate alle righe legacy (`legacy_event_id`, `legacy_uid`); ogni riga della tabella del §7.2 in `computePlan`, in entrambi i modi.
- **APPLY** (Radicale reale): (a) update; (b) `TARGET_NEWER`; (c) `BOTH_CHANGED`; (d) delete con If-Match; (e) seconda esecuzione al 100% noop; (f) kill fra PUT e ledger → adozione come noop; (g) UID a un altro href → adozione o `UID_AT_OTHER_HREF`; rivalidazione → `REVALIDATION_REQUIRED` e forza; verifica: serie lun-ven con più di 500 occorrenze senza rossi, differenze attese gialle e accettabili (riporto per firma), V4 identico senza iscrizioni.
- **INIT**: rifiuto di un volume non vuoto con identità diversa; ripresa dell'inizializzazione dopo un crash fra MKCOL e UPDATE (journal); nessuna MKCALENDAR fuori dall'init (ricerca nei sorgenti); controlli del preflight (probe in sola lettura, 403 su `_canary`, app-password riservate); archivio idempotente; riassegnazione nei due versi; inventario con i dati di forma produttiva.
- **SHADOW**: modifica legacy su un oggetto con VALARM in Radicale → VALARM preservato; trigger → job → handler da capo a fondo; shadow spento → nessuna scrittura; erasure GDPR completa, `audit_logs` compresi; riscrittura della proiezione oltre i 24 mesi con If-Match; festività con lo store Radicale (`If-None-Match`, 412); filtro di PgLegacyStore con i contratti F0 invariati su entrambi gli store.
- **ROUTES**: conferme, chiave d'idempotenza (replay e riuso), `MIGRATION_BUSY`, `PHASE_NOT_AVAILABLE`, ciclo di vita del run con ripresa dopo il lease scaduto e `interrupted`, paginazione delle righe, download, stato del wizard per ogni passo; build dell'admin (`pnpm --filter @calicchia/admin build`).
- **OPS**: `bash -n`, test con cartelle temporanee (come `integration/calendar-stack-backup.test.ts`), `purge-cache` sotto lock, export dello zip della Fase 0.

**Criterio di uscita della F3** (piano): su una copia di produzione e poi in produzione tutti i calendari verdi o gialli accettati; seconda esecuzione a zero scritture anche dopo un kill a metà; shadow con parità verde per almeno 7 giorni; matrice device superata e decisioni documentate.

## 17. Precisazioni rispetto al design

1. Lo shadow si aggancia a `calendar_events` (e `calendar_bookings`) con i trigger della 165 invece che dentro PgLegacyStore (design §13.8): l'accodamento sta nella stessa transazione della scrittura (outbox) e copre ogni scrittore legacy, anche quelli che non passano dalla facade; la chiave è per oggetto (`event:<master>`, `booking:<uid>`).
2. La coda dello shadow è `cal_jobs` (tipo riservato `shadow_mirror`), senza una tabella propria.
3. Lo strumento non scrive mai `calendar_events`: "sposta in lavoro" (decisione 8) vale solo per la destinazione Radicale, con la differenza attesa `NON_PROJECTION_MOVED`.
4. MKCALENDAR solo nell'inizializzazione, anche in mode postgres: l'apply non crea collezioni (il design §13.6 la ammetteva per le collezioni del piano) e una collezione mancante è il conflitto `COLLECTION_MISSING`.
5. I run girano come job `migration_run` di `cal_jobs`: lease e ripresa dopo un riavvio senza un secondo meccanismo.
6. L'accettazione delle differenze gialle si riporta fra i run per firma (necessario per la parità notturna).
7. Lo shadow ha la semantica per campo del design §13.8 (CAS dei soli campi toccati), l'apply quella della tabella del §13.6: lo stesso piano li calcola con `PlanMode`.
8. La rivalidazione del ledger dopo un import di backup è un flag per riga con il conflitto `REVALIDATION_REQUIRED` (design §16.2: "le differenze diventano conflitti, mai sovrascritture").
9. L'archivio della Fase 0 in F3 è `role='user'`, `origin='migration'`, non bloccante, in sola lettura per i device grazie alla policy `shadow`; il ruolo in sola lettura per il live è della F4 (questione aperta 1).
10. `calendar_backend_state` non ha `horizon_start/end` (orizzonte per collezione, 163) e `api_min_version` è un livello intero (`CALENDAR_API_LEVEL`), non una stringa di versione.
11. Le righe di `calendars` create dallo strumento sono invisibili ai percorsi legacy (§1.3).
12. Un master cancellato già scritto, o una proiezione di una prenotazione non più proiettata, si cancella dalla destinazione con If-Match (il design dice solo "non migrati").
13. Gli override staccati hanno un UID proprio (`<uid>-det-<epoch>`): Radicale non ammette due risorse con lo stesso UID nella collezione.
14. Il backup coordinato registra `last_stack_backup` nello stato, così il preflight lo verifica senza leggere il manifest sull'host.
15. Tipi di run aggiuntivi rispetto alle route del design: `identity` (riassegnazione) e `archive` (Fase 0); anomalia aggiuntiva `RESERVED_APP_PASSWORD` (bloccante), più `MIXED_BYDAY`, `POSSIBLE_DUPLICATE`, `EVENTS_IN_EXCLUDED_CALENDAR`, `COLLECTION_NAME_INVALID`, `INVALID_OBJECT`.

## 18. Questioni aperte

1. **Archivio in sola lettura dopo il cutover** (F4): serve un ruolo dei device in sola lettura e non bloccante (proposta: `archive` in `CALENDAR_ROLES` e `DEVICE_READONLY_ROLES` di `radicale/types.ts`, in `CalendarRole` di calendar-core e nel CHECK di `calendars.role` con la 166), oppure `device_visible = false`. Il preflight del cutover deve rifiutare un archivio senza una delle due.
2. **Controllo di `api_min_version` all'avvio** (F4, con il cutover che lo alza).
3. **Versione di Radicale** (INIT): Radicale 3.7.8 potrebbe non esporre la versione né come proprietà né nell'header; in quel caso `RADICALE_VERSION` resta `warn` ("non verificabile") e la versione è garantita dall'immagine pinnata per digest.
4. **Proprietà delle collezioni nello shadow** (nome, colore, descrizione, ordine): non richieste dal design; PUÒ farle il giro notturno con PROPPATCH (SHADOW), mai creando collezioni.
5. **Validatori del pull legacy** (`ICS_PULL_REFETCH`): l'azzeramento di etag e last-modified delle iscrizioni avviene al cutover (F4); in F3 solo l'anomalia informativa.

## 19. Aggiornamenti dell'integrazione (v1.1 e v1.2)

Registrati dall'integrazione della F3 dopo i report dei sei gruppi; prevalgono sulle sezioni precedenti dove le precisano.

1. **Anteprima nel riassunto del piano.** `PlanSummary.preview?: PlanPreview` (tipo in `plan.ts`, importato come solo tipo da `types.ts`): `runPlan` lo salva sempre, i piani dello shadow e dell'apply no. `PlanPreviewAnomaly.severity` è un `ItemSeverity`. Il client dell'admin ne tiene una copia (`calendar-migration-api.ts`), come degli altri DTO: va riallineata a ogni modifica dei tipi (l'integrazione l'ha verificata con un controllo di assegnabilità dei JSON dell'API verso i tipi del client).
2. **Esportazioni in più di SERIALIZE** (firme libere, non vincolanti per gli altri gruppi): `effectivePlanScope` (in un ambito parziale Prenotazioni e le destinazioni degli spostamenti entrano sempre insieme; `buildPlan` lo applica da sé), opzione `only` di `readTargetSnapshot` (multiget dei soli href delle chiavi, per lo shadow), `resolveMoveTarget`, `buildObjectFromSnapshot`, `loadLedgerRows`, `planCounts` (usata anche da `report.summarizePlanItems`), `buildPlanPreview`. Riga 1 del §7.2: un intento `update` pendente con la destinazione assente si tratta come mai applicato e prosegue alla riga 11 (`DELETED_IN_TARGET`, forzabile con una create).
3. **Anomalie con due rilevatori.** `POSSIBLE_DUPLICATE`, `BOOKING_DRIFT`, `NON_PROJECTION_IN_BOOKINGS`, `COLLECTION_NAME_INVALID` ed `EVENTS_IN_EXCLUDED_CALENDAR` li emettono sia il serializer sia l'inventario: l'inventario li deduplica per (codice, calendario, chiave legacy) unendo i dettagli. Restano solo dell'inventario le app-password, l'impatto delle iscrizioni e `ICS_PULL_REFETCH`.
4. **Motivo `SHADOW_DISABLED`** in `PRECONDITION_REASONS` (`assertMigrationWritable({ requireShadow: true })` con lo shadow spento).
5. **Verifica.** Motivi attesi di V5 come nel §8.1 aggiornato; con `orphans = discard` la verifica usa `ORPHAN_CONVERTED` (giallo accettabile). `latestVerifyVerdicts` considera solo le verifiche complete (V1-V5, senza ambito): il giro orario V4 e le verifiche di un solo calendario non contano per il passo 4 del wizard né per i criteri del cutover.
6. **Route.** L'apply rifiuta un'anteprima più vecchia di 24 ore (`PLAN_STALE`); opzioni e ambito dell'apply vengono sempre dall'anteprima e `expect_plan_hash` vale per default l'hash dell'anteprima. `audit_logs.action` ammette solo INSERT/UPDATE/DELETE/EXPORT/IMPORT: le route scrivono INSERT per i run creati e UPDATE per le altre azioni, con l'azione del §10.1 in `metadata.operation`. `src/app.ts` mette `/api/admin/calendar/migration/phase0/archive` fra i percorsi con il corpo grande (il router applica il proprio limite di 20 MB più l'involucro multipart). Rotta dell'admin `/calendario/migrazione` (in inglese `/calendar/migration`, coppia in `admin-routes.ts`).
7. **Esecuzione dei run.** I run `migration_run` girano nel worker dei job del calendario, che è sequenziale: durante un run gli altri job attendono (lo shadow attenderebbe comunque il lock). Un lock `cal-migration` occupato oltre 30 s non chiude il run: `CalendarUnavailableError('transition')`, il job si riaccoda senza consumare tentativi. Per la F4 valutare un worker dedicato.
8. **Cablaggio (§15) fatto**: `registerMigrationRunJob()` e `registerShadowMirrorJob()` con gli altri handler in `cron/calendar-radicale.ts`; `reapInterruptedRuns()` all'avvio dopo il worker e nel cron `calendar-migration-reaper` (5 minuti) tramite `runCalendarMigrationReaper()`, entrambi solo con Radicale configurato; `calendar-shadow-nightly` (24 h, ore 3) e `calendar-shadow-parity` (orario) in `cron/index.ts`; cron `calendar-subscriptions-index` e `runSubscriptionIndexPull` tolti (il pull verso l'indice è in `runIcsPull`).
9. **Variabili.** `RADICALE_PUBLIC_URL` nel compose dell'API (`docs/calendar-radicale/deploy/f1-compose.patch`) e in `.env.example`; la password del probe arriva all'API come `RADICALE_PROBE_PASSWORD` (nome del control-plane), che il preflight legge prima di `CALDES_PROBE_PASSWORD`. La cartella dei caricamenti di default è sotto `PRIVATE_UPLOAD_DIR` (§15).
10. **Festività con lo store Radicale.** Correzione del §6.4: RadicaleStore accetta `source='system'` nel calendario `holidays`; il cron resta comunque fuori dalla facade, con PUT diretta.
11. **Ripresa dell'apply (v1.2).** Alla ripresa dello stesso run (`attempt > 1`, §5.2 punto 4) il piano differisce dall'anteprima per le scritture del tentativo precedente (create fatte → `noop`, intenti pendenti → adozione): se il ledger ha già righe di quel run (`last_run_id` o `intent_run_id`), `runApply` non riconfronta `expected_plan_hash` (il primo tentativo l'ha superato prima di scrivere) e prosegue. Senza scritture precedenti il controllo vale come sempre (`PLAN_CHANGED`). Prima della correzione un apply ripreso dopo un kill falliva sempre con `PLAN_CHANGED`.
12. **`adopted` dopo una patch che conserva la destinazione (v1.2).** Una scrittura il cui contenuto è la patch per campo dell'oggetto corrente con un fingerprint diverso dall'oggetto voluto (per esempio lo shadow che aggiorna un evento a cui un device ha aggiunto un VALARM) chiude l'intento con `adopted = true` (§4.4): V2 confronta poi solo i campi del piano (prima era `CONTENT_MISMATCH` rosso e la parità non diventava mai verde) e gli update successivi, anche dell'apply notturno, restano patch.
13. **Erasure GDPR sulla destinazione (v1.2).** Con `legacy_snapshot` redatto a NULL la patch è senza base (`patchTowardSnapshot` di `serialize.ts`, esportata): la base è l'oggetto corrente, i campi del piano prendono il valore del legacy, VALARM, ATTENDEE e X-* restano ("patch dei campi redatti" del §13; §4.4: mai la riscrittura completa di una riga adottata). Si applica nello shadow (anche con la destinazione cambiata da un device: senza base non ci sono conflitti da rilevare e la cancellazione è dovuta) e nell'apply per le righe `adopted`/`derived`; le altre righe dell'apply restano riscrittura completa dal piano. Prima la cancellazione toglieva anche il VALARM del device, e con la destinazione cambiata dopo l'ultima scrittura finiva in `BOTH_CHANGED` lasciando l'email su Radicale.
14. **Parità nel wizard (v1.2).** `ParityView.last_nightly.green` (`boolean | null`, null finché la verifica del giro non è conclusa) è la regola della parità (`verifyRunGreen`: verifica accettabile). Il passo 5 va in `attention` solo per un giro notturno non verde secondo quella regola (un giallo con le differenze accettate è verde) e, con un messaggio a parte, per un giro orario V4 rosso. Prima un giallo accettato teneva il passo in `attention` per sempre. Il client dell'admin ha il campo nella sua copia del DTO e mostra "Giallo (accettato)".
15. **Criterio di uscita in un test (v1.2).** `apps/api/test/integration/migration-f3-e2e.test.ts` percorre il wizard dalle route su una copia sintetica della produzione: inventario, preflight, init, anteprima, apply, zero scritture, verifica, kill a metà apply con ripresa dal lease scaduto, shadow con VALARM del device e parità, flag dell'iscrizione con `create_missing`, feed ICS identici fra i due store, erasure GDPR completa.
