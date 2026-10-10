# Contratto dei moduli della F2

Versione 2 (precisazioni 8-10 e questioni aperte aggiornate dall'integrazione della F2). Vincola i sei gruppi che implementano in parallelo la fase F2 del [piano](../piano.md) ("Core: calendar-core, indice derivato con salute per oggetto, facade a due store, busy fail-closed circoscritto") dopo la fondazione: **SYNC**, **INDEX**, **STORE**, **BUSY**, **SUBS**, **CONSUMERS**. Riferimenti al [design](../design.md): §1 (invarianti), §2, §4 (163, 164), §5, §6, §7, §8, §9, §10, §12, §14, §15; [decisioni](../decisioni.md); [contratto del control-plane](control-plane.md), che resta in vigore e prevale su questo documento per policy, heartbeat, identità e permessi.

"DEVE", "NON DEVE" e "PUÒ" hanno il significato normativo consueto. Le firme di questo documento sono quelle che gli altri gruppi importano: un gruppo PUÒ aggiungere funzioni ed esportazioni, NON DEVE cambiare nome, argomenti o semantica di quelle elencate senza aggiornare prima questo contratto. Le firme della fondazione sono nel codice (già presente); quelle di `@calicchia/calendar-core` sono in `packages/calendar-core/src/index.ts` (gruppo CORE, in parallelo) e questo documento le cita per nome.

## 0. Mappa dei file e proprietari

Ogni file ha un solo proprietario. Un gruppo che ha bisogno di un file diverso da come lo trova NON lo modifica: lo chiede al proprietario (o lo segnala nelle questioni aperte del proprio report). Le eccezioni sono elencate nella colonna "Note".

| Gruppo | File | Note |
|---|---|---|
| Fondazione (fatto) | `database/migrations/163_calendar_index.sql`, `164_calendar_jobs.sql`; `apps/api/src/db/index.ts` (`calSql`); `lib/calendar/{store,backend-mode,errors,validation,index-model,jobs}.ts`; facade `lib/calendar/{events,calendars,subscriptions,rrule}.ts`; `lib/calendar/legacy/{events-pg,calendars-pg,subscriptions-pg,rrule-legacy}.ts`; tipi aggiunti in `lib/calendar/types.ts`; test `test/calendar/{index-migrations,index-model,jobs,store-facade}.test.ts` | Dopo la F2 i file della fondazione si cambiano solo con un aggiornamento di questo contratto |
| SYNC | `lib/calendar/radicale/{watcher,canary,sync,discovery,freshness,ids}.ts` | PUÒ estendere `radicale/identity.ts` e `scripts/radicale-init.ts` solo per creare `_canary` nell'inizializzazione esplicita (§4.2) |
| INDEX | `lib/calendar/radicale/{indexer,index-worker,health,rebuild,auditor,horizon,versions}.ts` | Unico scrittore di `cal_objects`, `cal_components`, `cal_occurrences` |
| STORE | `lib/calendar/radicale/{store,write-gate}.ts`, `lib/calendar/adapters.ts` | `radicale/store.ts` oggi è lo stub della fondazione: lo sostituisce mantenendo `getRadicaleStore()` |
| BUSY | `lib/calendar/{busy,capacity,slots,booking}.ts`; elimina `lib/calendar/local-busy.ts` | |
| SUBS | `lib/calendar/subscriptions/{pull,mirror}.ts`, `lib/calendar/ics-split.ts` | Il pull legacy (`legacy/subscriptions-pg.ts`) resta invariato |
| CONSUMERS | `lib/calendar/feed-builder.ts`, `routes/calendar/{feed,admin,health}.ts`, `routes/device.ts`, `lib/agent/tools.ts` | PUÒ aggiungere in `src/app.ts` solo il montaggio di `/api/health/calendar` |

Nessun gruppo modifica `apps/api/package.json`, `pnpm-lock.yaml`, il Dockerfile, `.github/workflows/*`, `src/index.ts` e `src/cron/index.ts`: ogni gruppo esporta funzioni `start*/stop*/run*` e le elenca nel report (registrazioni di cron e bootstrap, §12); le collega l'integrazione finale, in `src/cron/calendar-radicale.ts` (§12).

## 1. Fondazione: facade, modo, pool, errori (già implementata)

### 1.1 `CalendarStore` e facade (`store.ts`)

```ts
export type CalendarStoreKind = 'postgres' | 'radicale';

export interface CalendarStore {
  readonly kind: CalendarStoreKind;
  // events.ts
  getEvent(idOrUid: string): Promise<CalendarEvent | null>;
  getEventBySource(source: string, sourceId: string): Promise<CalendarEvent | null>;
  createEvent(input: CreateEventInput): Promise<CalendarEvent>;
  updateEvent(id: string, input: UpdateEventInput): Promise<CalendarEvent | null>;
  deleteEvent(id: string): Promise<boolean>;
  createOccurrenceOverride(opts: CreateOccurrenceOverrideInput): Promise<CalendarEvent>;
  listOccurrences(opts: ListEventsOptions): Promise<CalendarEventOccurrence[]>;
  getBusyRanges(fromIso: string, toIso: string): Promise<BusyRange[]>;
  listEventsForCollection(calendarId: string): Promise<CalendarEvent[]>;
  getEventOverrides(masterId: string): Promise<CalendarEvent[]>;
  buildCalendarFeed(calendar: Calendar, opts: CalendarFeedOptions): Promise<CalendarFeedResult>;
  // calendars.ts
  listCalendars(): Promise<Calendar[]>;
  getCalendar(idOrSlug: string): Promise<Calendar | null>;
  getCalendarByFeedToken(token: string): Promise<Calendar | null>;
  getDefaultCalendar(): Promise<Calendar | null>;
  getBookingsCalendar(): Promise<Calendar | null>;
  getOrCreateFestivitaCalendar(): Promise<Calendar>;
  createCalendar(input: CreateCalendarInput): Promise<Calendar>;
  updateCalendar(id: string, input: UpdateCalendarInput): Promise<Calendar | null>;
  deleteCalendar(id: string): Promise<void>;
  rotateFeedToken(id: string): Promise<Calendar | null>;
  countEventsByCalendar(): Promise<Map<string, number>>;
  listClosures(): Promise<ClosuresView>;
  // subscriptions.ts
  listSubscriptions(): Promise<CalendarSubscription[]>;
  getSubscription(id: string): Promise<CalendarSubscription | null>;
  createSubscription(input: CreateSubscriptionInput): Promise<CalendarSubscription>;
  updateSubscription(id: string, input: UpdateSubscriptionInput): Promise<CalendarSubscription | null>;
  deleteSubscription(id: string): Promise<boolean>;
  syncSubscription(id: string, opts?: { force?: boolean }): Promise<SyncResult>;
  replaceSubscriptionEvents(subscriptionId: string, calendarId: string, parsed: ParsedEvent[], opts?: { allowEmpty?: boolean }): Promise<{ inserted: number; removed: number }>;
  syncAllSubscriptions(): Promise<{ total: number; ok: number; failed: number; notModified: number }>;
}

export class PgLegacyStore implements CalendarStore { /* delega a legacy/*, nessuna logica propria */ }
export function getPgLegacyStore(): PgLegacyStore;
export function calendarStore(): Promise<CalendarStore>;          // letture: modo in cache 2 s
export function calendarStoreForWrite(): Promise<CalendarStore>;  // scritture: modo riletto, 503 in transizione
export function overrideCalendarStore(value: CalendarStoreKind | CalendarStore | null): void; // solo test
export const CALENDAR_STORE_OPERATIONS: readonly CalendarStoreOperation[];
export const CALENDAR_STORE_WRITE_OPERATIONS: ReadonlySet<CalendarStoreOperation>;
```

Tipi in `types.ts` (spostati da events/calendars/subscriptions senza modifiche): `UpdateEventInput`, `CreateOccurrenceOverrideInput`, `ListEventsOptions`, `BusyRange`, `UpdateCalendarInput`, `CalendarSubscription`, `CreateSubscriptionInput`, `UpdateSubscriptionInput`, `SyncResult`; nuovi: `ClosureRow`, `ClosuresView`, `CalendarFeedOptions { now: Date; uidDomain: string }`, `CalendarFeedResult { body: string; etag: string | null }`.

Regole:

1. Le facade `events.ts`, `calendars.ts` e `subscriptions.ts` esportano gli stessi nomi di prima (funzioni, classi d'errore, tipi), più `countEventsByCalendar`, `listClosures` (calendars) e `buildCalendarFeed` (events). Ogni funzione della facade chiama l'operazione omonima dello store con gli stessi argomenti (test `store-facade.test.ts`). Restano pure, fuori dallo store: `isValidTimeZone` (da `validation.ts`), `buildFeedUrl`, `caldavEtag` (legacy).
2. `PgLegacyStore` delega al codice di prima, spostato in `legacy/` senza modifiche (cambiano solo i percorsi degli import). I moduli legacy si chiamano fra loro direttamente, mai attraverso la facade. Le tre letture nuove riproducono le query inline delle route di oggi (`countEventsByCalendar`: `GET /calendars` e `list_calendars`; `listClosures`: `GET /closures`, che crea ancora il calendario festività se manca; `buildCalendarFeed`: `routes/calendar/feed.ts`, con `etag: null`). Il test `store-facade.test.ts` verifica che diano le stesse risposte delle route.
3. `radicale/store.ts` (STORE) esporta `getRadicaleStore(): CalendarStore`. Importa da `../store` solo tipi (`import type`): `store.ts` importa questo modulo. La costruzione non fa I/O (l'API parte con Radicale giù o non configurato).
4. Chi non è `store.ts` NON importa `legacy/*`. Unica eccezione: `busy.ts` usa `legacy/events-pg.getBusyRanges` per il ramo postgres (§7.1), per non creare il ciclo `busy → store → radicale/store → busy`.
5. Classificazione delle operazioni (`CALENDAR_STORE_WRITE_OPERATIONS`): create/update/delete di eventi, override, calendari, iscrizioni, `rotateFeedToken`, `getOrCreateFestivitaCalendar` (può creare), le sync delle iscrizioni e `replaceSubscriptionEvents`. Le altre sono letture.

### 1.2 Modo del backend (`backend-mode.ts`)

| mode (`calendar_backend_state`) | store | scritture calendario |
|---|---|---|
| `postgres` | `postgres` (PgLegacyStore) | ammesse, come oggi (write_freeze non conta: contratto control-plane §6.2) |
| `cutover` | `postgres` | 503 `CalendarUnavailableError('transition')` |
| `radicale` | `radicale` | ammesse; 503 `'write_freeze'` con write_freeze |
| `rollback` | `radicale` | 503 `'transition'` |
| `finalized` | `radicale` | ammesse; 503 `'write_freeze'` con write_freeze |

```ts
export const BACKEND_MODE_CACHE_MS = 2_000;
export function storeKindForMode(mode: BackendMode): CalendarStoreKind;
export function writesSuspendedInMode(mode: BackendMode): boolean;
export function readBackendStateCached(db?: Db): Promise<CalendarBackendState>; // visualizzazione: cache 2 s, ultimo stato noto se il DB fallisce
export function readBackendStateFresh(db?: Db): Promise<CalendarBackendState>;  // scritture e decisioni: senza cache; 503 'state_unreadable'
export function readStoreKind(db?: Db): Promise<CalendarStoreKind>;
export function resolveWriteStoreKind(db?: Db): Promise<CalendarStoreKind>;
export function invalidateBackendModeCache(): void;
export function peekBackendState(): { state: CalendarBackendState; ageMs: number } | null;
export function startBackendModeListener(db?: Db): Promise<() => Promise<void>>; // LISTEN calendar_policy_changed
export function overrideStoreKind(kind: CalendarStoreKind | null): void;         // solo test
```

- La cache usa l'orologio monotono (`performance.now()`), non `Date`: i test fermano `Date` con `freezeTime`.
- Le decisioni di prenotazione (BUSY) leggono lo stato con `readBackendStateFresh(tx)` dentro la propria transazione (design §9). Le transizioni del processo (F3/F4) chiamano `invalidateBackendModeCache()`.
- `startBackendModeListener()` la avvia il bootstrap (§12); senza, la cache scade comunque in 2 s.

### 1.3 Pool calendario, connessioni e lock

`apps/api/src/db/index.ts` esporta `calSql` (pool dedicato, `CAL_DB_POOL_MAX`, default 4, `application_name = caldes-api-calendar`), `CAL_DB_POOL_MAX` e `closeCalendarPool()`. Il pool principale `sql` non cambia.

**Budget per processo del pool calendario** (4 connessioni):

| Uso | Connessioni | Proprietario |
|---|---|---|
| Scrittori dell'indice di una collezione (sync, rimaterializzazione, rebuild, pull di un'iscrizione) | al massimo 2 contemporanei (semaforo `CAL_SYNC_CONCURRENCY`, default 2), ognuno 1 connessione riservata dal lock alla COMMIT | INDEX (`withCollectionWriteLock`) |
| Gate delle scritture `cal-write` (lock condiviso) | 1 connessione riservata per processo, condivisa da tutte le scritture in corso (conteggio di riferimento) | STORE (`write-gate.ts`) |
| Claim/complete/fail dei job, comandi brevi | 1 | jobs.ts |

- Le letture per route, salute, busy e adattatori usano il pool principale `sql` (o la transazione del chiamante).
- `LISTEN` di postgres-js apre una connessione dedicata fuori dal pool: ammesso.
- `calSql.reserve()` NON ha `begin()` (verificato su postgres-js 3.4.8): sulle connessioni riservate la transazione si fa con `BEGIN`/`COMMIT`/`ROLLBACK` espliciti (ammessi dalla libreria su una connessione riservata).

**Regole contro lo stallo** (con 4 connessioni un'attesa annidata blocca tutto):

1. Nessun codice tiene una connessione del pool calendario mentre attende un'altra connessione del pool calendario.
2. Il gate delle scritture si rilascia DOPO la PUT e PRIMA del write-through (`syncCollection`) e dell'audit (design §8 passi 6-8).
3. Un handler di job non apre transazioni su `calSql` che comprendano chiamate a sync o gate.
4. La transazione della prenotazione (pool principale, `cal-week`) PUÒ attendere una sync (freshness): la sync non attende mai il pool principale né `cal-week`.
5. Le transazioni delle decisioni girano in READ COMMITTED (il default): la query di busy successiva alla freshness deve vedere la COMMIT della sync appena fatta. Mai REPEATABLE READ o SERIALIZABLE nella sezione critica.

**Advisory lock** (`index-model.ts`, `CAL_LOCKS`, sempre con `hashtext()`):

| Chiave | Tipo | Chi | Note |
|---|---|---|---|
| `cal-week-IYYY-IW` | `pg_advisory_xact_lock` | booking.ts (invariato) | Sezione critica delle prenotazioni |
| `cal-write` | `pg_advisory_lock_shared` (scritture), `pg_advisory_lock` (transizioni F4) | write-gate.ts | Dopo il lock si rilegge il modo senza cache |
| `cal-sync:<calendar_id>` | `pg_try_advisory_lock` su connessione riservata, con attesa fino al deadline | indexer.ts | Tutti gli scrittori dell'indice di quella collezione |
| `cal-rebuild` | `pg_try_advisory_lock` | rebuild.ts | Un solo rebuild completo alla volta |
| `cal-migration` | `pg_advisory_lock` | F3 | Riservato |

Ordine ammesso: `cal-week` → `cal-sync:*`; `cal-write` e `cal-sync:*` mai annidati fra loro nello stesso flusso.

### 1.4 Errori (`errors.ts`) e mappatura per canale

Classi storiche (stesse istanze per facade, legacy e RadicaleStore): `EventValidationError` (400), `EventReadOnlyError` (403), `CalendarValidationError` (400), `CalendarConflictError` (409), `CalendarSystemError` (422), `SubscriptionValidationError` (400/404). Nuove:

```ts
export class CalendarUnavailableError extends Error {   // 503, code 'CALENDAR_UNAVAILABLE'
  readonly reason: CalendarUnavailableReason; readonly detail: string | null;
  toPublicBody(): { error: string; code: 'CALENDAR_UNAVAILABLE' };
}
export class CalendarStoreUnavailableError extends CalendarUnavailableError { readonly store: string; readonly operation: string } // 'store_not_available'
export class CalendarRecurrenceConflictError extends CalendarConflictError { readonly recurrenceKey: string } // 409
export class CalendarFieldConflictError extends CalendarConflictError { readonly conflicts: readonly FieldConflict[] } // 409 {field, base, theirs, yours}
export function isCalendarUnavailable(err: unknown): err is CalendarUnavailableError;
```

Motivi (`CALENDAR_UNAVAILABLE_REASONS`): `store_not_available`, `transition`, `write_freeze`, `state_unreadable`, `identity_mismatch`, `identity_unverified`, `radicale_unreachable`, `collection_unsyncable`, `freshness_timeout`, `rebuild_in_progress`, `horizon_insufficient`, `remote_budget_exceeded`, `watcher_down`. Un modulo che ne serve un altro aggiorna prima questo contratto.

| Errore | Sito pubblico | Admin | MCP | Cron e job |
|---|---|---|---|---|
| `CalendarUnavailableError` | `503 err.toPublicBody()` (testo del design §9, mai il motivo) | `503 {error, code}` | ramo catch-all esistente `{error: message}`, senza `code` | job: ripetibile (backoff); cron: log, nessun crash |
| `CalendarRecurrenceConflictError`, `CalendarFieldConflictError` | — | `409 {error, code, conflicts?}` | `{error}` | job: non ripetibile (`CalendarJobPermanentError`) se il conflitto è definitivo |
| `RadicaleError` (client F1) | mai esposto: lo store lo converte | idem | idem | job: ripetibile se `transient`, altrimenti dead letter |

### 1.5 Mode postgres (produzione dopo il deploy della F2)

- La facade usa PgLegacyStore: stesse query, stessi errori, stessi risultati. I contratti F0 restano verdi; ogni differenza va in `apps/api/test/contracts/allowed-diffs.json` con motivazione, e sono ammesse solo quelle previste dal design (§12, più l'agenda device del §12 e il busy fail-closed del §9).
- L'indice PUÒ essere popolato in shadow (watcher e sync con Radicale configurato e identità `ok`; pull delle iscrizioni solo per quelle con un sidecar), ma nessun percorso di contratto lo legge in mode postgres.
- In mode postgres nessun modulo crea, modifica o cancella righe di `calendars` o `calendar_subscriptions` per conto dell'indice (discovery e pull delle iscrizioni compresi): `listCalendars` legacy le mostrerebbe.
- Nessun job viene accodato dai percorsi legacy (la proiezione delle prenotazioni resta sincrona e legacy).

### 1.6 Radicale assente, giù o non configurato

- `RADICALE_URL` assente → `radicaleClientFromEnv()` restituisce null: watcher, canary, sync, discovery e specchio restano spenti e la salute li dichiara `not_configured`. L'API parte e la facade in mode postgres funziona come oggi.
- Mount `RADICALE_DATA_DIR` assente → niente campanello a stat: remote mode (design §6.1), dichiarata.
- Mai MKCOL o MKCALENDAR fuori dall'inizializzazione esplicita (contratto control-plane §4.4). Mai un'operazione sull'indice con l'identità del volume diversa da `ok` (`identity.ts`, `checkVolumeIdentity`): con `mismatch` o `unverified` la sync si ferma con `CalendarUnavailableError('identity_mismatch' | 'identity_unverified')` e l'indice esistente resta com'è.
- Fail-closed circoscritto (invariante 2): un oggetto rotto degrada solo sé stesso (quarantena, busy conservativo); una collezione rotta produce 503 solo se è bloccante e `unsyncable` con modifiche pendenti; mai un busy vuoto per errore.

## 2. Indice derivato (migrazione 163)

### 2.1 Tabelle, scrittori, lettori

| Tabella | Persistente | Scrive | Legge |
|---|---|---|---|
| `cal_object_ids` | sì (sopravvive al rebuild) | `ids.ts` (SYNC), solo dentro la transazione dell'indicizzatore; F3 per le preassegnazioni (`reserveObjectId`) | STORE (resolver), adattatori, feed, conflitti |
| `cal_object_versions` | sì, 90 giorni | `versions.ts` (INDEX) dentro la transazione dell'indicizzatore; purge dell'auditor | STORE (cronologia, ripristino in F6), salute |
| `cal_collection_state` | no | `indexer.ts` (apply), `health.ts` (fallimenti, dirty), `rebuild.ts` (azzeramento), `indexer.ensureCollectionState` (creazione della riga) | freshness, busy, salute, feed |
| `cal_objects`, `cal_components`, `cal_occurrences` | no | SOLO `indexer.ts` | tutti, in sola lettura |
| `cal_jobs` | — | `jobs.ts` | salute |
| `cal_booking_conflicts` | — | `booking.ts` (post-commit), `auditor.ts` | salute, admin |

Tutte stanno nel gruppo S del backup JSON (`routes/backup.ts`, `STATE_TABLES`): esportate, mai ripristinate. Le FK puntano solo a `calendars` (mai a `calendar_events`, `calendar_subscriptions` o `calendar_bookings`, che l'import svuota senza CASCADE). La delete di un calendario cancella in cascata stato, id, versioni, oggetti, componenti e occorrenze della collezione.

Colonne, vincoli e commenti: `database/migrations/163_calendar_index.sql`. Tipi delle righe: `index-model.ts` (`CalObjectIdRow`, `CalObjectVersionRow`, `CalCollectionStateRow`, `CalObjectRow`, `CalComponentRow`, `CalOccurrenceRow`; int8 come stringa, timestamptz come `Date`).

### 2.2 Id persistenti (`ids.ts`, SYNC)

- `cal_objects.id` = `cal_object_ids.id` della risorsa (`recurrence_key = ''`); `cal_components.id` = id di (calendario, href, chiave) del componente; le occorrenze di un master hanno l'id del master (come oggi), quelle di un override l'id dell'override.
- Allocazione, nell'ordine: (1) riga esistente per (calendar_id, href, recurrence_key), riattivata se `retired_at`; (2) MOVE: riga ritirata da meno di 30 giorni con lo stesso UID in un'altra collezione → ri-chiavata (`calendar_id`, `href`), stesso id; (3) `X-CALDES-LEGACY-ID` del componente se è un UUID non usato → id = quello, `legacy_event_id` = quello (oggetti migrati, ripristino dopo la perdita del DB); (4) UUID v4. Con `idStrategy: 'deterministic'` (rebuild con `cal_object_ids` vuota, scenario B del design §16.3) il passo 4 usa uuidv5(UID|recurrence_key).
- Limite noto: se la sync della collezione di arrivo di un MOVE precede quella di partenza, l'oggetto riceve un id nuovo (la riga di partenza non è ancora ritirata). Le MOVE dell'API sincronizzano prima l'origine e poi la destinazione.
- Le proiezioni migrate prendono `legacy_event_id` dalla riga legacy `source='booking' AND source_id=<uid>` (F3); `legacy_uid` serve al feed (§10 del design).

### 2.3 `recurrence_key`

Stesso formato in `cal_object_ids`, `cal_components` e `cal_occurrences`, ed è quello di `recurrenceKeyOf()` di calendar-core:

| Istanza | Chiave |
|---|---|
| risorsa intera, evento singolo | `''` |
| all-day (VALUE=DATE) | `YYYYMMDD` (data locale) |
| timed con TZID o UTC | `YYYYMMDDTHHMMSSZ` (istante UTC al secondo) |
| timed floating | `YYYYMMDDTHHMMSS` (ora da muro) |
| blocco conservativo di un oggetto illeggibile o con il budget d'espansione esaurito (solo `cal_occurrences`) | `conservative` (`CONSERVATIVE_RECURRENCE_KEY`) |

Gli helper di `index-model.ts` (`recurrenceKeyForInstant`, `recurrenceKeyForDate`, `recurrenceKeyForFloating`, `parseRecurrenceKey`, `RECURRENCE_KEY_RE`) servono a chi lavora con istanti già risolti (SQL, adattatori legacy, conflitti); sui valori iCalendar si usa calendar-core.

### 2.4 Provenienza, kind e blocks

Unica fonte: calendar-core (`model.ts`): `deriveProvenance({ role, href, component, uid })`, `classifyOccurrenceKind(role, href, expansionKind)`, `computeBlocks(input, { allDayOpaqueBlocks })`, `parseObjectHref`. L'indicizzatore salva `source` e `source_id` in `cal_objects` e `kind` e `blocks` in `cal_occurrences`; il busy al volo (oltre `materialized_until`) usa le stesse funzioni. Nessun gruppo ne scrive una seconda copia.

- `allDayOpaqueBlocks` (decisione 6) resta `false` in F2 (parità: nessun all-day blocca); si attiva con la variabile `CAL_ALLDAY_OPAQUE_BLOCKS=on` nella release successiva alla matrice dei device.
- Cambio di ruolo, di fuso o della regola → `rematerializeCollection(calendarId, { reason })` (§5.1).

### 2.5 Salute

**Oggetto** (`cal_objects.health`):

| Evento | Effetto |
|---|---|
| testo valido | `ok`; occorrenze rigenerate; versione `valid=true` (se le versioni valgono per la collezione) |
| testo non valido, oggetto già indicizzato | `quarantined` (motivo in `health_reason`); restano le occorrenze precedenti con `stale=true`; `raw_ics`, `etag` e `content_sha256` diventano quelli correnti, `semantic_fp` NULL; versione `valid=false`; `last_good_version_id` invariato |
| testo non valido, oggetto nuovo | `quarantined`; occorrenza `kind='conservative'`, chiave `conservative`, `component_id` NULL, `blocks=true` sull'intervallo di `conservativeRangeFromText()` (fine aperta → fine dell'orizzonte); senza intervallo nessuna occorrenza e motivo `unreadable` (rischio residuo dichiarato dal design §6.5) |
| budget di espansione esaurito | `quarantined`, `expansion-budget`; l'occorrenza `conservative` prodotta da `expandObject` (blocca solo se il master bloccherebbe) |
| oltre 5000 occorrenze nell'orizzonte | `ok`, `materialized_until` = valore di `expandObject` |
| 404 con file su disco (skip_broken_item) | `quarantined`, `radicale-skip`, occorrenze invariate, alert |
| remote mode, primo 404 | `pending_404`, `pending_404_count=1`, continua a bloccare |
| remote mode, secondo 404 consecutivo | cancellazione candidata (passa dall'interruttore) |

**Collezione** (`cal_collection_state.health`, funzioni di `health.ts`):

| Stato | Quando | Decisioni |
|---|---|---|
| `healthy` | ultima sync riuscita, nessuna modifica pendente da oltre 2 minuti | normali |
| `stale` | `dirty_since` più vecchio di 2 minuti senza fallimenti (anche mai sincronizzata) | la freshness forza la sync |
| `unsyncable` | sync fallita (`consecutive_failures > 0`) con `dirty_since` non nullo | se bloccante: 503 nelle decisioni subito, nel livello display dopo 10 minuti (`health_since`) |
| `hold` | interruttore anti-cancellazione scattato | le occorrenze esistenti bloccano; nessun 503; l'admin sceglie "applica" o "ricostruisci" |

`dirty_since` lo imposta chi osserva la directory diversa da `dir_mtime_ns` (watcher, freshness) e lo azzera la sync riuscita che salva una `dir_mtime_ns` non racy.

### 2.6 Orizzonte

- Obiettivo: `targetHorizon(now)` = [oggi − 400 g, oggi + 800 g] al giorno UTC (`index-model.ts`). Garanzia statica: `horizon_end ≥ requiredHorizonEnd(now, max(max_advance_days))` (oggi + max_advance_days + 14 g), altrimenti le decisioni falliscono chiuse (`'horizon_insufficient'`).
- L'orizzonte materializzato è per collezione (`cal_collection_state.horizon_start/horizon_end`), aggiornato nella stessa transazione delle occorrenze. Le colonne globali `horizon_start/end` di `calendar_backend_state` previste dal design per la 165 non servono all'indice (§13 di questo documento).
- Fuori dall'orizzonte (admin nel 2030, export) e oltre `materialized_until` si espande al volo da `cal_objects.raw_ics` (`expandIndexedObject`, §5.1).

### 2.7 `index_version` e notifiche

- Ogni transazione dell'indicizzatore che cambia oggetti od occorrenze di una collezione incrementa `index_version` (anche di più collezioni insieme). Il trigger della 163 emette `NOTIFY calendar_index_changed {"calendar_id","index_version"}` alla COMMIT.
- Cache del feed e della salute: chiave per collezione (`index_version`) più `calendars.updated_at` (versione del sidecar).
- "Zero scritture": un oggetto con stesso etag e stesso `content_sha256` (Radicale) o stesso `semantic_fp` (iscrizioni) non produce update, versioni né incremento di `index_version`.

## 3. Coda dei lavori (migrazione 164, `jobs.ts`)

```ts
export const CAL_JOB_KINDS: { projectBooking: 'project_booking'; bookingConflictCheck: 'booking_conflict_check'; subscriptionMirror: 'subscription_mirror'; recurrenceSplit: 'recurrence_split'; calendarLifecycle: 'calendar_lifecycle'; indexRebuild: 'index_rebuild'; shadowMirror: 'shadow_mirror'; reverseProjection: 'reverse_projection' };
export const CAL_JOB_PRIORITY: { high: 10; normal: 100; low: 200 };
export class CalendarJobPermanentError extends Error {}             // dead letter subito
export interface CalendarJob<P = Record<string, unknown>> { id; kind; key; payload: P; sourceVersion: string | null; priority; attempts; maxAttempts; runAfter: Date; leaseToken; lockedBy; lockedUntil: Date; lastError; createdAt: Date }
export function enqueueCalendarJob(kind: string, key: string, payload?: object, opts?: { sourceVersion?: string | null; runAfter?: Date; delayMs?: number; priority?: number; maxAttempts?: number; db?: Db }): Promise<{ id: string; coalesced: boolean }>;
export function claimCalendarJobs(opts?: { kinds?: readonly string[]; limit?: number; leaseMs?: number; workerId?: string; db?: Db }): Promise<CalendarJob[]>;
export function completeCalendarJob(job, opts?: { result?: unknown; currentSourceVersion?: string | null; db?: Db }): Promise<'done' | 'requeued' | 'superseded' | 'lost'>;
export function failCalendarJob(job, error: unknown, opts?: { retryable?: boolean; retryAfterMs?: number; db?: Db }): Promise<'requeued' | 'superseded' | 'dead' | 'lost'>;
export function extendCalendarJobLease(job, leaseMs: number, db?: Db): Promise<boolean>;
export function recoverExpiredCalendarJobLeases(db?: Db, limit?: number): Promise<{ requeued: number; superseded: number; dead: number }>;
export function retryDeadCalendarJob(id: string, db?: Db): Promise<boolean>;
export function purgeFinishedCalendarJobs(opts?): Promise<number>;
export function calendarJobStats(db?: Db): Promise<CalendarJobStats>;
export function registerCalendarJobHandler(kind: string, handler: (job: CalendarJob, ctx: { signal: AbortSignal; extendLease(ms?: number): Promise<boolean>; log: Logger }) => Promise<{ result?: unknown; currentSourceVersion?: string | null } | void>, opts?: { leaseMs?: number }): void;
export function runCalendarJobsOnce(opts?): Promise<RunCalendarJobsSummary>;
export function startCalendarJobWorker(opts?: { intervalMs?: number; workerId?: string; db?: Db }): Promise<void>; // giro ogni 5 s + NOTIFY calendar_jobs
export function stopCalendarJobWorker(): Promise<void>;
```

Semantica (test `jobs.test.ts`): coalescenza solo sui pending (payload e `source_version` nuovi, `run_after` e priorità più urgenti, `attempts = 0`); un job running con la stessa chiave non assorbe il nuovo accodamento; accodato nella transazione del chiamante esiste solo dopo la COMMIT (outbox); claim con `FOR UPDATE SKIP LOCKED` e lease (`lease_token`); `completeCalendarJob` con una `currentSourceVersion` diversa da quella del job lo riaccoda subito (o `superseded` se c'è già un pending con la stessa chiave); `failCalendarJob`: backoff esponenziale 5 s → 1 h con jitter ±20%, dead letter a tentativi finiti (default 8) o con `CalendarJobPermanentError`; lease scaduto → di nuovo pending (il tentativo conta), `superseded` o `dead`. Un tipo senza handler registrato resta pending.

| Tipo | Proprietario dell'handler | Chiave | `source_version` | Quando |
|---|---|---|---|---|
| `project_booking` | BUSY (`booking.ts`) | uid della prenotazione | `calendar_bookings.updated_at` ISO | solo store Radicale, nella tx della prenotazione, cancellazione, riprogrammazione, approvazione |
| `booking_conflict_check` | BUSY | uid della prenotazione | `index_version` max delle collezioni bloccanti | facoltativo: se il controllo post-commit non riesce in linea |
| `subscription_mirror` | SUBS (`mirror.ts`) | id dell'iscrizione | `index_version` del sidecar | dopo un pull con cambi, solo `device_visible`; priorità `low` |
| `recurrence_split` | STORE | uid della serie | etag del master | saga "questa e le successive" |
| `calendar_lifecycle` | STORE | calendar_id | `lifecycle` | recupero di `creating`/`deleting` rimasti a metà |
| `index_rebuild` | INDEX (`rebuild.ts`) | `all` o calendar_id | — | dopo `requestIndexRebuild` |
| `shadow_mirror`, `reverse_projection` | F3, F4 | — | — | riservati |

Regole per gli handler: convergenti e idempotenti, stato desiderato calcolato all'esecuzione (mai solo dal payload); rispettano `ctx.signal`; restituiscono `currentSourceVersion` quando la sorgente può essere cambiata durante il lavoro; non tengono transazioni su `calSql` attorno a sync o gate (§1.3); al massimo 20 PUT/s complessive degli scrittori di sistema (`INDEX_LIMITS.maxSystemPutsPerSecond`). La registrazione degli handler avviene con `register*Job()` esportate da ogni proprietario e chiamate dal bootstrap (§12), prima di `startCalendarJobWorker()`.

## 4. SYNC: watcher, canary, sync, discovery, freshness, id

### 4.1 `radicale/watcher.ts`

Responsabilità (design §6.1): ogni secondo `stat` della directory del principal, di `.Radicale.props` del principal e di ogni collezione Radicale-backed (ruolo diverso da `subscription`, `lifecycle='active'`, `collection_name` valido, mai `_*`); principal cambiato → `discoverCollections()`; props cambiate → controllo d'identità (`checkVolumeIdentity` di F1, poi `requestControlPlaneSync()`); collezione cambiata → `markCollectionDirty` (INDEX) e `syncCollection(id, { reason: 'watcher' })` senza attenderla. In remote mode: ogni 30 s PROPFIND Depth:1 del principal con i sync-token e sync delle collezioni con token cambiato.

```ts
export type WatchMode = 'mount' | 'remote' | 'off';
export interface WatcherStatus {
  mode: WatchMode; running: boolean; reason: string | null;
  lastTickAt: Date | null; lastChangeAt: Date | null; consecutiveErrors: number;
  collections: Array<{ calendarId: string; name: string; dirMtimeNs: string | null; dirtySince: Date | null }>;
}
export function startCalendarWatcher(opts?: { intervalMs?: number; dataDir?: string; client?: RadicaleClient | null }): Promise<void>; // idempotente
export function stopCalendarWatcher(): Promise<void>;
export function getWatcherStatus(): WatcherStatus;
export function setWatchMode(mode: WatchMode, reason: string | null): void;       // la usa canary.ts
export function statCollectionDir(collectionName: string): Promise<bigint | null>; // mtime in ns via mount; null se assente o senza mount
export function statPrincipal(): Promise<{ dirMtimeNs: bigint | null; propsMtimeNs: bigint | null }>;
```

Errori: mai lanciati dal ciclo (registrati, contati in `consecutiveErrors`, alert al primo di una serie). Lock: nessuno proprio (le sync prendono il lock della collezione). Mode postgres: attivo se Radicale è configurato e l'identità è `ok` (indice in shadow); `off` con `CALDES_WATCH=off`, senza `RADICALE_URL` o con identità diversa da `ok` (riprova a ogni cambio delle props).

### 4.2 `radicale/canary.ts`

Responsabilità: all'avvio e ogni 10 minuti `caldes-svc` fa una PUT con If-Match (o `If-None-Match: *` se `beat.ics` manca) su `_canary/beat.ics` e verifica via mount che la mtime della directory cambi entro 100 ms dalla risposta; `fs.statfs` sul mount deve dare un filesystem locale (ext4 `0xEF53`, xfs `0x58465342`, btrfs `0x9123683E`; elenco sostituibile solo nei test con `CALDES_WATCH_FS_TYPES`). Esito negativo → `setWatchMode('remote', motivo)` con alert; positivo → `mount`.

```ts
export type CanaryFailure = 'not_configured' | 'mount_missing' | 'fs_not_local' | 'canary_missing' | 'put_failed' | 'mtime_not_observed' | 'radicale_unreachable' | 'identity_not_ok';
export interface CanaryResult { ok: boolean; mode: WatchMode; reason: CanaryFailure | null; fsType: string | null; fsLocal: boolean | null; mtimeLagMs: number | null; checkedAt: Date }
export function runCanary(opts?: { client?: RadicaleClient | null; dataDir?: string; signal?: AbortSignal }): Promise<CanaryResult>;
export function lastCanaryResult(): CanaryResult | null;
export function startCanarySchedule(): void; export function stopCanarySchedule(): void; // ogni 10 minuti
```

`_canary` nasce solo dall'inizializzazione esplicita (contratto control-plane §4.4 passo 5). Il volume di produzione inizializzato in F1 non ce l'ha: senza `_canary` l'esito è `canary_missing` e il watcher resta in remote mode (dichiarata). SYNC PUÒ estendere `initializeVolume`/`createMissingCollections` di `identity.ts` e `scripts/radicale-init.ts` per creare `_canary` con MKCALENDAR come `caldes-svc` (resta un passo esplicito, `-- --apply`). Mai crearla dal canary.

### 4.3 `radicale/sync.ts`

Responsabilità: unico canale dati Radicale → indice (design §6.2). Passi: identità `ok` (altrimenti errore e stop) → m0 e istante di osservazione → `REPORT sync-collection` dal token salvato (403 `valid-sync-token` → full resync con PROPFIND `getetag` e diff) → multiget a blocchi di 100 → classificazione dei 404 (file su disco → `radicaleSkipped`; assente → cancellazione candidata; remote mode → `pending404` al primo, cancellazione al secondo) → interruttore anti-cancellazione (max(50, 20%) della collezione, o collezione sparita/vuota → `hold`) → `indexer.applyCollectionChanges()` con CAS sul token → `dir_mtime_ns = m0` solo se più vecchia di 50 ms.

```ts
export type SyncReason = 'watcher' | 'freshness' | 'write-through' | 'remote-poll' | 'auditor' | 'rebuild' | 'manual' | 'startup';
export interface SyncCollectionOptions { reason: SyncReason; full?: boolean; actor?: string; deadline?: number /* ms epoch */; signal?: AbortSignal; idStrategy?: 'random' | 'deterministic' }
export interface SyncCollectionResult {
  calendarId: string; status: 'synced' | 'unchanged' | 'held' | 'skipped';
  full: boolean; indexVersion: string; syncToken: string | null; dirMtimeNs: string | null;
  upserted: number; deleted: number; quarantined: number; radicaleSkipped: number; pending404: number; durationMs: number;
}
export type CollectionSyncErrorCode = 'identity' | 'not_configured' | 'radicale' | 'cas_exhausted' | 'lock_timeout' | 'timeout' | 'collection_missing' | 'aborted';
export class CollectionSyncError extends Error { readonly calendarId: string; readonly code: CollectionSyncErrorCode }

export function syncCollection(calendarId: string, opts: SyncCollectionOptions): Promise<SyncCollectionResult>; // single-flight per collezione
export function syncAllCollections(opts: Omit<SyncCollectionOptions, 'full'> & { full?: boolean }): Promise<Array<SyncCollectionResult | CollectionSyncError>>;
export function applyHeldDeletions(calendarId: string, opts: { actor: string; hrefs?: string[] }): Promise<SyncCollectionResult>; // "applica cancellazioni" dell'admin
export function inFlightSyncs(): string[];
```

- Single-flight in memoria per `calendarId`: chi arriva durante una sync in corso ne riceve l'esito (senza tenere connessioni); una richiesta con `full: true` arrivata durante una sync incrementale ne accoda una completa.
- Lock: `withCollectionWriteLock` (INDEX) dal REPORT alla COMMIT. CAS: se il token in DB non è più quello di partenza (`CollectionCasError`), si riparte dal REPORT, al massimo 3 volte (`cas_exhausted`).
- Parse ed espansione fuori dalla transazione (`prepareCollectionChanges`, worker_threads oltre 200 oggetti).
- Fallimento: `health.recordSyncFailure()` (INDEX) e rilancio di `CollectionSyncError`; la freshness la converte in `CalendarUnavailableError`.
- Il ruolo `subscription` restituisce `status: 'skipped'` (fonte remota, §8).
- Mode postgres: ammessa con identità `ok` (indice in shadow, letto solo da salute e test).

### 4.4 `radicale/discovery.ts`

Responsabilità (design §6.3, contratto control-plane §4.5): PROPFIND Depth:1 sul principal (displayname, colore, ordine, descrizione, calendar-timezone, component-set, resourcetype, sync-token, dead prop `calendar-id` e `role`).

```ts
export interface DiscoveredCollection { name: string; href: string; isCalendar: boolean; displayName: string | null; color: string | null; order: number | null; description: string | null; timezone: string | null; components: string[]; syncToken: string | null; davProps: Record<string, string> }
export interface DiscoveryResult { identity: IdentityStatus; collections: DiscoveredCollection[]; adopted: string[]; created: string[]; updated: string[]; missing: string[]; reappeared: string[]; unknown: string[] }
export function listRadicaleCollections(client: RadicaleClient, principal: string): Promise<DiscoveredCollection[]>; // solo PROPFIND
export function discoverCollections(opts?: { db?: Db; client?: RadicaleClient | null; signal?: AbortSignal }): Promise<DiscoveryResult>; // single-flight
```

Regole: adozione di una riga per dead prop `calendar-id` solo se coincide anche `collection_name` e mai per una collezione nata da un device (anche in `lifecycle='creating'`); collezione nuova senza dead prop (solo in mode `radicale`/`finalized`) → riga del sidecar `origin='device'`, `role='user'` (`tasks` se solo VTODO), `blocks_availability=true` (decisione 4), `needs_review` con `device_new`, `ics_feed_enabled=false`, `collection_name` = nome esatto, slug derivato e univoco, più `ensureCollectionState(…, 'radicale')`; collezione sparita → `missing_since` e alert, mai una cancellazione; ricomparsa → `missing_since = NULL`; le dead prop `urn:calicchia:caldes` di una collezione scrivibile dai device non vanno mai in `dav_props`; `_*` ignorate. In mode `postgres` e `cutover` la discovery non inserisce né cancella righe di `calendars`: le collezioni senza riga finiscono in `unknown` (salute). Discovery con identità diversa da `ok` → nessuna scrittura.

### 4.5 `radicale/freshness.ts`

Responsabilità: freschezza dell'indice per le decisioni (design §9) e prontezza per il livello display (§7).

```ts
export interface FreshnessReport { mode: WatchMode; checked: number; synced: string[]; discovery: boolean; durationMs: number }
/** Collezioni del set: Radicale-backed bloccanti + bookings + principal; mai le iscrizioni. */
export function decisionFreshnessSet(db: Db): Promise<{ calendarIds: string[]; includePrincipal: true }>;
/** Livello decision: dentro la sezione critica della prenotazione; lancia CalendarUnavailableError. */
export function verifyFreshness(opts: { db: Db; budgetMs?: number /* 2500 */; signal?: AbortSignal }): Promise<FreshnessReport>;
/** Livello display: watcher vivo, identità ok, orizzonte sufficiente, nessuna bloccante unsyncable da oltre 10 minuti. */
export function assertDisplayReady(db: Db): Promise<void>;
```

`verifyFreshness`: per ogni collezione del set `stat(dir) == dir_mtime_ns` (non NULL, non racy) → ok senza HTTP; principal cambiato → discovery; directory cambiata o `dir_mtime_ns` NULL (rebuild) → `syncCollection(id, { reason: 'freshness', deadline })` (se già in corso se ne attende l'esito); remote mode → PROPFIND Depth:0 con budget (`INDEX_TIMING.remoteDecisionBudgetMs`); timeout, errore, collezione bloccante `unsyncable`, identità diversa → `CalendarUnavailableError` con il motivo corrispondente. Legge lo stato con il `db` del chiamante (la tx della prenotazione). Mode postgres: non chiamata (le decisioni usano il busy legacy).

### 4.6 `radicale/ids.ts`

```ts
export interface ObjectIdRequest { href: string; uid: string | null; overrideKeys: readonly string[]; legacyId?: string | null }
export interface AllocatedIds { objectId: string; componentIds: ReadonlyMap<string, string>; movedFrom: { calendarId: string; href: string } | null }
/** Solo dentro la transazione dell'indicizzatore (§2.2). */
export function allocateObjectIds(tx: Db, calendarId: string, items: readonly ObjectIdRequest[], opts: { now: Date; idStrategy?: 'random' | 'deterministic' }): Promise<Map<string, AllocatedIds>>; // chiave: href
export function retireObjectIds(tx: Db, calendarId: string, hrefs: readonly string[], now: Date): Promise<void>;
export function retireOverrideIds(tx: Db, calendarId: string, href: string, keepKeys: readonly string[], now: Date): Promise<void>;
export function reserveObjectId(tx: Db, input: { calendarId: string; href: string; recurrenceKey?: string; id?: string; uid?: string | null; legacyEventId?: string | null; legacyUid?: string | null }): Promise<string>; // F3, proiezioni
export function deterministicObjectId(uid: string, recurrenceKey: string): string; // uuidv5
export type EventRefResolution =
  | { kind: 'found'; id: string; objectId: string; calendarId: string; href: string; recurrenceKey: string }
  | { kind: 'ambiguous'; candidates: Array<{ id: string; calendarId: string; collectionName: string; href: string }> }
  | { kind: 'not_found' };
/** getEvent (design §5): id, UID esatto (preferendo collezioni scrivibili), legacy_uid, UID con o senza @dominio. */
export function resolveEventRef(db: Db, idOrUid: string): Promise<EventRefResolution>;
```

## 5. INDEX: indicizzatore, salute, rebuild, auditor, orizzonte, versioni

### 5.1 `radicale/indexer.ts`: API usata da SYNC, STORE e SUBS

```ts
export interface CollectionContext {
  calendarId: string; collectionName: string; role: CalendarRole; timezone: string;
  originStore: OriginStore; versions: boolean;              // false per role=subscription
  blockRules: { allDayOpaqueBlocks: boolean };
}
export function loadCollectionContext(db: Db, calendarId: string): Promise<CollectionContext>;
export function ensureCollectionState(tx: Db, calendarId: string, originStore: OriginStore): Promise<void>;

export interface RawItem {
  href: string;                 // nome della risorsa, decodificato
  etag: string | null;          // null per origin_store 'remote'
  raw: string | null;           // testo; null = illeggibile
  semanticFp?: string | null;   // remote: già calcolato da ics-split
}
export interface ChangeSetInput {
  context: CollectionContext;
  upserts: RawItem[];
  deletes: string[];            // cancellazioni confermate (passate dall'interruttore)
  radicaleSkipped: RawItem[];   // 404 con file su disco (raw letto dal mount se possibile)
  pending404: string[];         // remote mode, primo 404
  full: boolean;                // upserts ∪ radicaleSkipped = collezione intera
  horizon: { start: Date; end: Date };
  actor: string;                // 'sync' | 'write-through:<actor>' | 'rebuild' | 'subscription-pull' | ...
  idStrategy?: 'random' | 'deterministic';
}
export interface PreparedChangeSet { readonly input: ChangeSetInput; readonly items: readonly PreparedItem[]; readonly preparedAt: Date }
/** Solo CPU (calendar-core: parseCalendarObject, expandObject, semanticFingerprint, deriveProvenance, classifyOccurrenceKind, computeBlocks); worker_threads oltre 200 item; nessun I/O. */
export function prepareCollectionChanges(input: ChangeSetInput, opts?: { worker?: boolean | 'auto' }): Promise<PreparedChangeSet>;

export interface ApplyOptions {
  expectedSyncToken?: string | null;   // CAS (§6.2 passo 8); undefined = nessun CAS
  newSyncToken?: string | null;
  dirMtimeNs?: bigint | null;          // già filtrata dalla finestra racy; undefined = invariata
  hold?: { reason: string; pendingDeletions: string[] } | null;
  replaceAll?: boolean;                // rebuild: delete e insert della collezione nella stessa tx
  syncedAt: Date;
}
export interface ApplyResult { indexVersion: string; upserted: number; unchanged: number; deleted: number; quarantined: number; held: boolean; objectIds: ReadonlyMap<string, string> }
export class CollectionCasError extends Error {}
export class CollectionLockTimeoutError extends Error {}

/** La sola scrittura di cal_objects/cal_components/cal_occurrences: una transazione, dentro withCollectionWriteLock. */
export function applyPreparedChanges(lock: CollectionLock, prepared: PreparedChangeSet, opts: ApplyOptions): Promise<ApplyResult>;
/** prepare + lock + apply (comodità per SYNC, SUBS e i test). */
export function applyCollectionChanges(input: ChangeSetInput, opts: ApplyOptions & { deadline?: number; signal?: AbortSignal }): Promise<ApplyResult>;
export function removeIndexedObjects(calendarId: string, hrefs: readonly string[], opts: { actor: string; deadline?: number }): Promise<ApplyResult>;
export function quarantineIndexedObject(calendarId: string, href: string, reason: string, opts: { actor: string; raw?: string | null; deadline?: number }): Promise<ApplyResult>;
/** Rigenera le occorrenze da cal_objects.raw_ics (orizzonte, ruolo, fuso, regola blocks). Nessun I/O verso Radicale. */
export function rematerializeCollection(calendarId: string, opts: { horizon: { start: Date; end: Date }; reason: 'horizon' | 'role' | 'timezone' | 'rules'; deadline?: number }): Promise<ApplyResult>;

export interface CollectionLock { readonly calendarId: string; readonly conn: ReservedSql; transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> }
/** Semaforo di processo (CAL_SYNC_CONCURRENCY, default 2) + connessione riservata di calSql + pg_try_advisory_lock(hashtext(CAL_LOCKS.collection(id))) con attesa fino al deadline. */
export function withCollectionWriteLock<T>(calendarId: string, fn: (lock: CollectionLock) => Promise<T>, opts?: { deadline?: number; signal?: AbortSignal }): Promise<T>;

/** Espansione al volo di un oggetto indicizzato su una finestra (busy oltre materialized_until, admin fuori orizzonte). Non lancia: fallimento → blocco conservativo della finestra. */
export function expandIndexedObject(row: Pick<CalObjectRow, 'id' | 'calendar_id' | 'href' | 'raw_ics' | 'health'>, context: CollectionContext, window: { from: Date; to: Date }):
  { occurrences: Array<{ recurrenceKey: string; start: Date; end: Date; allDay: boolean; kind: OccurrenceKind; blocks: boolean }>; conservative: boolean };
```

Regole dell'apply (tutte nella stessa transazione): `ensureCollectionState`; CAS con `SELECT … FOR UPDATE` su `cal_collection_state`; id con `ids.allocateObjectIds`/`retire*`; upsert degli oggetti cambiati (stesso etag e sha → `unchanged`, nessuna scrittura); componenti e occorrenze sostituiti per oggetto; quarantena come §2.5; versioni con `versions.recordVersion` (create, update, delete col testo cancellato) solo se `context.versions`; cancellazioni non applicate con `hold` (vanno in `pending_deletions`, `health='hold'`; un href in `pending_deletions` che ricompare ne esce); `object_count`, `quarantined_count`, `horizon_start/end`, `last_synced_at`, `last_full_sync_at` (se `full`), `consecutive_failures=0`, `health` (`healthy` salvo hold), `dirty_since` azzerato solo con una `dir_mtime_ns` non NULL; `index_version + 1` se è cambiato qualcosa. Errori di parse non fanno mai fallire la transazione: fanno quarantena.

Mode postgres: chiamato solo dalle sync in shadow e dal pull delle iscrizioni con sidecar.

### 5.2 `radicale/health.ts`

```ts
export interface CollectionHealthView {
  calendarId: string; collectionName: string | null; role: CalendarRole; originStore: OriginStore; blocking: boolean;
  health: CollectionHealth; healthSince: Date; dirtySince: Date | null; lastSyncedAt: Date | null;
  consecutiveFailures: number; lastError: string | null; holdReason: string | null; pendingDeletions: number;
  objectCount: number; quarantined: number; indexVersion: string; horizon: { start: Date; end: Date } | null;
}
export interface IndexHealthSummary {
  collections: CollectionHealthView[];
  quarantined: Array<{ objectId: string; calendarId: string; href: string; reason: string | null; since: Date; hasLastGood: boolean }>;
  orphanOverrides: number; unreadable: number; materializedLimited: number; generatedAt: Date;
}
export function getIndexHealth(db?: Db): Promise<IndexHealthSummary>;
export function deriveCollectionHealth(state: Pick<CalCollectionStateRow, 'health' | 'consecutive_failures' | 'dirty_since' | 'hold_since'>, now: Date): CollectionHealth; // pura
/** 503? (design §6.5, §7): decisione subito se bloccante unsyncable; display dopo 10 minuti. */
export function blocksDecisions(view: CollectionHealthView, level: 'display' | 'decision', now: Date): boolean;
export function markCollectionDirty(db: Db, calendarId: string, observedAt: Date): Promise<void>;
export function recordSyncFailure(db: Db, calendarId: string, error: unknown, at: Date): Promise<CollectionHealth>;
```

### 5.3 `radicale/rebuild.ts`

```ts
export function requestIndexRebuild(db: Db, opts: { reason: string; actor: string }): Promise<void>; // una tx: rebuild_required=true, dir_mtime_ns=NULL e sync_token=NULL per tutte; accoda index_rebuild
export interface RebuildReport { startedAt: Date; finishedAt: Date; collections: Array<{ calendarId: string; ok: boolean; error?: string }>; cleared: boolean }
export function runIndexRebuild(opts?: { signal?: AbortSignal; extendLease?: () => Promise<boolean> }): Promise<RebuildReport>;
export function registerIndexRebuildJob(): void;
```

Ogni collezione si ricostruisce con `syncCollection(id, { reason: 'rebuild', full: true })` e `replaceAll` (delete e insert atomici); gli id restano (`cal_object_ids`). `rebuild_required=false` solo se tutte le collezioni Radicale-backed sono riuscite con identità `ok`; con `epoch = 0` (volume non inizializzato, mode postgres) non c'è nulla da ricostruire e si azzera subito; senza Radicale raggiungibile resta `true` (policy frozen: in mode postgres stessi permessi di shadow). Durante il rebuild le decisioni trovano `dir_mtime_ns` NULL e forzano la sync, altrimenti 503 (`rebuild_in_progress`): mai busy su righe vecchie che sembrano fresche.

### 5.4 `radicale/auditor.ts`

```ts
export interface AuditReport {
  startedAt: Date; finishedAt: Date; identity: IdentityStatus; policyCoherent: boolean; reconciled: number;
  collections: Array<{ calendarId: string; etagMismatches: number; resynced: boolean; brokenFiles: string[] }>;
  bookings: { missingProjections: string[]; orphanProjections: string[]; drift: string[] } | null; // null in mode postgres
  horizonOk: boolean; quarantined: number; held: string[]; versionsPurged: number; jobsPurged: number; alerts: string[];
}
export function runCalendarAudit(opts?: { signal?: AbortSignal; now?: Date }): Promise<AuditReport>; // notturno
```

(href, etag) di Radicale contro l'indice (differenza → `syncCollection(full)` attraverso l'interruttore, alert); file `.ics` su disco assenti dal listing (item rotti); prenotazioni contro collezione bookings in sola lettura (solo store Radicale: proiezioni mancanti → `enqueueCalendarJob('project_booking')`, orfane marcate e mai cancellate, `BOOKING_DRIFT`); coerenza fra identità, epoch, heartbeat e policy (`policyFromState`); `calendar_sidecar_reconcile()`; orizzonte; `versions.purgeExpiredVersions()`; `purgeFinishedCalendarJobs()`; conflitti aperti.

### 5.5 `radicale/horizon.ts`

```ts
export function ensureHorizon(opts?: { now?: Date; signal?: AbortSignal }): Promise<{ extended: string[]; failed: string[] }>; // giornaliero
export function maxAdvanceDays(db: Db): Promise<number>;                      // max(calendar_event_types.max_advance_days) degli attivi
export function assertHorizonCovers(db: Db, until: Date, calendarIds?: string[]): Promise<void>; // CalendarUnavailableError('horizon_insufficient')
```

Per ogni collezione con `horizon_end` più vicino di un giorno all'obiettivo (o `horizon_start` da avanzare): `rematerializeCollection(id, { reason: 'horizon', horizon: targetHorizon(now) })`.

### 5.6 `radicale/versions.ts`

```ts
export function recordVersion(tx: Db, v: { objectId: string; calendarId: string; href: string; etag: string | null; raw: string | null; sha256: string | null; semanticFp: string | null; changeKind: VersionChangeKind; valid: boolean; actor: string | null }): Promise<string>;
export function listObjectVersions(db: Db, objectId: string, opts?: { limit?: number }): Promise<CalObjectVersionRow[]>;
export function getObjectVersion(db: Db, versionId: string): Promise<CalObjectVersionRow | null>;
export function lastValidVersion(db: Db, objectId: string): Promise<CalObjectVersionRow | null>;
export function purgeExpiredVersions(db: Db, now?: Date): Promise<number>; // 90 giorni; mai l'ultima buona di un oggetto in quarantena
export function purgeVersionsForErasure(db: Db, match: { objectIds?: string[]; calendarIds?: string[] }): Promise<number>; // GDPR (F3)
```

## 6. STORE: RadicaleStore, gate delle scritture, adattatori

### 6.1 `radicale/write-gate.ts`

```ts
export interface WriteGateContext { readonly state: CalendarBackendState }
/** Gate cal-write (design §8 passo 2): lock condiviso, rilettura senza cache, 503 se il modo non ammette scritture Radicale. Rientrante. */
export function withCalendarWriteGate<T>(fn: (ctx: WriteGateContext) => Promise<T>, opts?: { expect?: 'radicale'; timeoutMs?: number }): Promise<T>;
/** Transizioni (F4): lock esclusivo; chiude il gate ai nuovi scrittori del processo finché fn non finisce. */
export function withExclusiveCalendarWriteGate<T>(fn: () => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>;
export function writeGateStatus(): { holders: number; closing: boolean; reservedConnection: boolean };
```

Una sola connessione riservata di `calSql` per processo tiene il lock condiviso finché c'è almeno una scrittura in corso (conteggio di riferimento); la rientranza usa `AsyncLocalStorage` (una scrittura annidata non riprende il lock: con un esclusivo in attesa si bloccherebbe dietro di lui). Dopo il lock: `readBackendStateFresh(conn)`, poi `mode ∈ {radicale, finalized}` e `!write_freeze`, altrimenti `CalendarUnavailableError('transition' | 'write_freeze')`. In F2 PgLegacyStore non passa dal gate (nessun cambio in mode postgres); il gate delle scritture legacy arriva con le transizioni della F4.

### 6.2 `radicale/store.ts` (RadicaleStore)

Sostituisce lo stub con la stessa esportazione `getRadicaleStore(): CalendarStore`.

- **Letture** dall'indice (pool principale): `listOccurrences` per sovrapposizione su `span` (`cal_occurrences ⋈ cal_components ⋈ calendars`), `blockingOnly` con i flag dei calendari come la query di busy, cancellati esclusi salvo `includeCancelled`, iscrizioni con il calendario di destinazione come `calendar_id` nei DTO (design §1); finestre oltre l'orizzonte con `expandIndexedObject`; `getEvent` con `ids.resolveEventRef` più GET diretto su Radicale (fallback sull'indice in sola lettura con Radicale giù; `ambiguous` → `EventValidationError` con i candidati); `listCalendars` dal sidecar senza le `sub-*` e senza `lifecycle ≠ active`; `countEventsByCalendar` con la semantica legacy (VEVENT non CANCELLED, override compresi, sommando le iscrizioni con quel padre); `listClosures` dalla collezione `role='holidays'` tranne `it-holiday-*` con fine > oggi − 30 g, senza creare il calendario; `getBusyRanges` = `busy.indexBusyRanges` (BUSY); `buildCalendarFeed` = `feedBuilder.buildIndexFeed` (CONSUMERS); `listEventsForCollection`/`getEventOverrides` dall'indice (solo compatibilità).
- **Scritture** (pipeline del design §8): guardie API identiche a oggi (stessi errori e messaggi: iscrizione → testo di `assertWritable`; proiezione `booking-*` di una prenotazione pending/confirmed → `EventReadOnlyError('Evento di una prenotazione attiva: annullala da Calendario → Prenotazioni.')`; calendario `is_system` non eliminabile; `source` dal client solo in {admin, manual, mcp, agent}); `validateObject` di calendar-core; `withCalendarWriteGate` → GET (testo ed ETag) → CAS per campo (`checkBase`; per admin v1 e MCP la base è implicita, un solo retry) → patch (`opsFromLegacyUpdate`/`applyPatch`) → PUT con `If-Match` (creazione `If-None-Match: *`; su 412 da capo, al massimo 3 volte) → rilascio del gate → write-through `syncCollection(id, { reason: 'write-through' })` → `audit_logs` (`table_name='cal_objects'`, `record_id` = id, `old_data`/`new_data` = `{collection, href, etag}`, mai il testo). Se il write-through fallisce dopo una PUT riuscita, la scrittura resta valida: il DTO si costruisce dal testo scritto e il watcher indicizzerà.
- Target `{recurrence_key}` non più nell'insieme corrente → `CalendarRecurrenceConflictError` (409). "Solo questa", "elimina questa", "tutta la serie", MOVE, duplica: `recurrence-ops` di calendar-core. "Questa e le successive": saga `recurrence_split` (§3).
- **Calendari**: crea (riga `lifecycle='creating'` che prenota `collection_name` → MKCALENDAR con dead prop `calendar-id` e `role` → `active`; MKCALENDAR fallita → riga cancellata; 409/405 → stesso messaggio di oggi), modifica (PROPPATCH più sidecar), elimina (guardie → `deleting` → DELETE della collezione → delete della riga in una tx con `SET LOCAL caldes.reverse_sync='on'`); recupero dei `creating`/`deleting` con il job `calendar_lifecycle`.
- **Iscrizioni**: CRUD su `calendar_subscriptions` come oggi; `syncSubscription`/`syncAllSubscriptions` → `subscriptions/pull.ts` (SUBS); `replaceSubscriptionEvents` → `CalendarStoreUnavailableError` (solo legacy).
- Radicale non configurato o irraggiungibile: letture dall'indice; scritture → `CalendarUnavailableError('radicale_unreachable')`.

### 6.3 `lib/calendar/adapters.ts`

```ts
export function toLegacyEvent(component: CalComponentRow, object: Pick<CalObjectRow, 'id' | 'calendar_id' | 'source' | 'source_id' | 'first_seen_at' | 'changed_at'>, ctx: { masterId: string | null; timezone: string }): CalendarEvent;
export function toLegacyOccurrence(occ: CalOccurrenceRow, component: CalComponentRow, object: Pick<CalObjectRow, 'source' | 'source_id'>, ctx: { timezone: string; displayCalendarId?: string }): CalendarEventOccurrence;
export function toLegacyCalendar(row: Record<string, unknown>): Calendar;
/** Descrizione delle proiezioni ricomposta da calendar_bookings con il template attuale di booking.ts (design §12, allowed-diffs "descrizione-proiezioni-ricomposta"). */
export function projectionDescription(booking: Pick<Booking, 'uid' | 'attendee_name' | 'attendee_email' | 'attendee_phone' | 'attendee_company' | 'attendee_message'>): string;
```

Producono esattamente le chiavi dei DTO di oggi (`types.ts`); all-day come mezzanotte del fuso del calendario in ISO UTC con `all_day=true` (calendar-core `toLegacyEventFields`); override con l'UID del master (differenza ammessa 1).

## 7. BUSY: busy, capacity, slots, booking

### 7.1 `lib/calendar/busy.ts` (sostituisce `local-busy.ts`, che si elimina)

```ts
export type BusyLevel = 'display' | 'decision';
/** Drop-in di getLocalBusyRanges (slots.ts), ma fail-closed: mai [] per errore. */
export function getBusyRanges(fromIso: string, toIso: string, opts?: { level?: BusyLevel; db?: Db }): Promise<BusyRange[]>;
/** Query di busy del design §7 sull'indice (+ espansione al volo oltre materialized_until); usata anche da RadicaleStore.getBusyRanges. */
export function indexBusyRanges(db: Db, fromIso: string, toIso: string): Promise<BusyRange[]>;
```

- Mode postgres (`readStoreKind`, o `readBackendStateFresh(db)` a livello decision): stesso insieme di oggi (`legacy/events-pg.getBusyRanges`: occorrenze confermate, timed, dei calendari bloccanti) ma l'errore si propaga (design §9: local-busy fail-open eliminato, "busy.ts solleva sempre l'errore, anche sullo store legacy"). Le proiezioni `booking-*` escono dal busy (design §9) se BUSY applica il filtro `source='booking'` anche al ramo legacy: differenza da motivare in `allowed-diffs.json` se un contratto la vede (riprogrammazione sovrapposta, test.todo del contratto pubblico).
- Store Radicale, livello display: `assertDisplayReady(db)` poi `indexBusyRanges`; livello decision: il chiamante ha già fatto `verifyFreshness` nella stessa tx, qui solo `assertHorizonCovers` e la query con `db: tx`.
- Fail-closed circoscritto: oggetti in quarantena contano col loro intervallo (occorrenze stale o conservative già nell'indice); oltre `materialized_until` si espande al volo il solo oggetto sulla finestra, e se fallisce lo si blocca in modo conservativo sulla finestra; mai un 503 per un singolo oggetto.

### 7.2 `lib/calendar/capacity.ts`

Stesse esportazioni e firme di oggi, con `opts?: { db?: Db }` in coda a `getCapacityWeeks`, `hasWeeklyCapacityForBooking`, `filterSlotsByWeeklyCapacity` (dentro la sezione critica si usa la tx: chiude la doppia connessione segnalata nel commento di booking.ts). Mode postgres: algoritmo di oggi (listOccurrences legacy, festività riconosciuta come oggi). Store Radicale: una sola aggregazione SQL per settimana ISO Europe/Rome sull'indice con le esclusioni di oggi (`source` booking e system, calendario `role='holidays'`, all-day, eventi non CONFIRMED) e bucket per source (design §7).

### 7.3 `lib/calendar/slots.ts`

`computeAvailableSlots(input, opts?: { level?: BusyLevel; db?: Db })`: firma di oggi più le opzioni; usa `busy.getBusyRanges` (display per le route pubbliche e MCP, decision dentro `createBooking`) e `capacity` con lo stesso `db`.

### 7.4 `lib/calendar/booking.ts`

Esportazioni invariate. Protocollo di decisione (design §9) per `createBooking` e `rescheduleBooking`, con qualsiasi source:

```
tx (pool principale): pg_advisory_xact_lock(cal-week)                          -- invariato
  state = readBackendStateFresh(tx)
  store Radicale: identità ok ed epoch (verifica di F1), nessun freeze; verifyFreshness({ db: tx })
  require_available_slot → computeAvailableSlots(..., { level: 'decision', db: tx })
  capacity e buffer con db: tx
  INSERT calendar_bookings (EXCLUDE)
  store Radicale: enqueueCalendarJob('project_booking', uid, {}, { db: tx, sourceVersion })
commit
post (store Radicale): nuovo stat delle collezioni del set; se cambiate → sync e controllo di sovrapposizione
     → cal_booking_conflicts (detected_by 'post_commit') + alert; nessun annullamento
post (mode postgres): projectBookingEvent legacy, sincrono, come oggi
```

- Riprogrammazione: tutto con `db: tx` (oggi `computeAvailableSlots` legge fuori dalla tx); con le proiezioni fuori dal busy uno slot sovrapposto all'originale si accetta.
- `meetingUrl`: `resolveLocationForBooking` ricalcolato sempre (riprogrammazione e approvazione), design §14.
- Handler `project_booking` (`registerBookingJobs()`): stato desiderato da `calendar_bookings` all'esecuzione (confirmed, completed, no_show → proiezione; altrimenti DELETE della risorsa), PUT con `If-None-Match: *`/`If-Match` nella collezione bookings, contenuto secondo la decisione 3 (titolo con nome, telefono, link all'admin; niente email), UID `<uid>@caldes.it`, href `booking-<uid>.ics`; restituisce `currentSourceVersion` = `updated_at` riletto.
- Errori: `CalendarUnavailableError` → sito 503 (`toPublicBody()`), MCP `{error}` (ramo esistente), admin 503.

## 8. SUBS: pull verso l'indice, specchio, split

### 8.1 `lib/calendar/ics-split.ts`

```ts
export interface SplitFeedObject { uid: string; href: string /* r-<base32(sha256(UID))[0..26]>.ics */; raw: string; semanticFp: string }
export interface SplitFeedResult { objects: SplitFeedObject[]; errors: Array<{ uid: string | null; message: string }>; warnings: number }
export function splitIcsFeed(body: string): SplitFeedResult; // parseIcs + splitCalendar + serialize + semanticFingerprint di calendar-core; malformedLines 'skip'
export function remoteHref(uid: string): string;
```

### 8.2 `lib/calendar/subscriptions/pull.ts`

```ts
export interface SubscriptionPullResult { subscriptionId: string; calendarId: string | null; status: 'not_modified' | 'unchanged' | 'applied' | 'rejected' | 'skipped'; upserted: number; deleted: number; unchanged: number; errors: number; durationMs: number; error: string | null }
export function pullSubscriptionToIndex(subscriptionId: string, opts?: { force?: boolean; body?: string; signal?: AbortSignal }): Promise<SubscriptionPullResult>;
export function pullAllSubscriptionsToIndex(opts?: { signal?: AbortSignal }): Promise<SubscriptionPullResult[]>;
export function enableSubscriptionIndex(subscriptionId: string): Promise<string>; // crea il sidecar role=subscription (solo store Radicale o F3)
```

- Solo le iscrizioni con un sidecar (`collection_calendar_id`); senza → `skipped`. In mode postgres non crea sidecar (§1.5): in produzione il pull verso l'indice resta inerte fino alla F3, i test creano il sidecar esplicitamente.
- Fetch con etag e last-modified propri dell'indice (mai quelli del pull legacy, che restano invariati: la trappola del 304 è del legacy); `body` già scaricato PUÒ essere passato per non scaricare due volte. Anti-wipe come oggi (body vuoto o HTML rifiutato; `force` esplicito).
- `splitIcsFeed` → diff per `semanticFp` con gli oggetti `origin_store='remote'` del sidecar → `indexer.applyCollectionChanges` con `context.versions=false`, senza CAS né sync-token: zero scritture e zero versioni se nulla è cambiato (anche con DTSTAMP sempre nuovo).
- Oggetto rotto → quarantena del solo oggetto (RRULE invalida inclusa), mai un errore del pull; nelle decisioni le iscrizioni usano l'ultimo pull completato (fuori dal set di freschezza).

### 8.3 `lib/calendar/subscriptions/mirror.ts`

```ts
export function registerSubscriptionMirrorJob(): void;
export function enqueueSubscriptionMirror(subscriptionId: string, opts: { indexVersion: string; db?: Db }): Promise<void>;
export interface MirrorResult { put: number; deleted: number; unchanged: number }
export function mirrorSubscription(subscriptionId: string, ctx: { signal: AbortSignal }): Promise<MirrorResult>;
```

Solo `device_visible = true` (iscrizione non visibile → nessuna PUT, nemmeno un PROPFIND); collezione `sub-<id8>` esistente (creata dal wizard F3): se manca, `CalendarJobPermanentError` e alert, mai MKCALENDAR; confronto per fingerprint con il contenuto corrente della collezione (multiget), PUT solo dei cambiati con `If-Match`/`If-None-Match: *`, DELETE con `If-Match` dei rimossi, al massimo 5 PUT/s, priorità `low`. Il watcher ignora le `sub-*`.

## 9. CONSUMERS: feed, agenda, chiusure, conteggi, MCP, salute

- **`lib/calendar/feed-builder.ts`**: `buildIndexFeed(db: Db, calendar: Calendar, opts: CalendarFeedOptions): Promise<CalendarFeedResult>` (lo chiama `RadicaleStore.buildCalendarFeed`). Dall'indice della collezione: serie sempre, singoli da −90 a +365 giorni, niente iscrizioni né CANCELLED (anche scritti dai device), override nella risorsa del master, cancellazioni come EXDATE, VTIMEZONE deduplicati, whitelist delle proprietà e `CLASS:PRIVATE/CONFIDENTIAL` → "Occupato" (feed-transform di calendar-core), UID legacy per le proiezioni migrate (`legacy_uid@CAL_FEED_UID_DOMAIN`), suffisso per gli UID senza `@`, DTSTAMP stabile (LAST-MODIFIED o `first_seen_at`), ETag = sha256 del corpo con cache in memoria per (index_version, `calendars.updated_at`, versione della trasformazione, data Europe/Rome). `CAL_FEED_UID_DOMAIN` (valore congelato) ha come default l'host di `publicApiUrl()`, cioè il dominio del feed legacy.
- **`routes/calendar/feed.ts`**: `buildCalendarFeed(calendar, { now: new Date(), uidDomain })` dalla facade; header di oggi; `ETag` e 304 su `If-None-Match` solo se `etag` non è null (in mode postgres gli header restano quelli di oggi).
- **`routes/calendar/admin.ts`**: `event_count` da `countEventsByCalendar()`; `GET /closures` da `listClosures()`; 503 `{error, code}` per `CalendarUnavailableError`, 409 per i conflitti nuovi.
- **`routes/device.ts`**: agenda da `listOccurrences` con la finestra del giorno Europe/Rome (design §12 e §14: ricorrenze espanse e giorno di Roma già in F2, su entrambi gli store, stessa forma JSON); la differenza sui contratti `device-agenda` va in `allowed-diffs.json` (motivata dal design §12).
- **`lib/agent/tools.ts`**: `list_calendars` con `countEventsByCalendar()`; descrizione delle proiezioni (`kind=booking_projection`, solo store Radicale) ricomposta con `adapters.projectionDescription`; errori sul ramo `{error}` esistente; nessun nome di tool, schema o forma nuovi (contratto `mcp-calendar-tools`).
- **`routes/calendar/health.ts`**: `GET /api/health/calendar`. Senza JWT admin: `{ status: 'ok' | 'degraded' | 'down' }` (200, oppure 503 se `down`). Con JWT admin, il dettaglio: modo e store, control-plane (`getCalendarControlPlane()?.status()`), identità, watcher, canary, collezioni (`getIndexHealth`), quarantene, hold, orizzonte, job (`calendarJobStats`), conflitti aperti, rebuild. Componenti Radicale non configurati → `not_configured`, mai un errore. Montaggio in `src/app.ts` (unica riga ammessa).

## 10. Grafo delle chiamate e regole d'import

```
routes/admin, routes/feed, routes/device, tools.ts ──► facade (events/calendars/subscriptions) ──► store.ts
                                                                                    ├─► PgLegacyStore ─► legacy/*
                                                                                    └─► radicale/store.ts (STORE)
radicale/store.ts ─► write-gate, sync.syncCollection, ids.resolveEventRef, indexer.expandIndexedObject,
                     busy.indexBusyRanges, feed-builder.buildIndexFeed, adapters, subscriptions/pull, jobs, calendar-core, client (F1)
booking.ts ─► backend-mode, freshness.verifyFreshness, slots, capacity, busy, jobs, facade (solo ramo postgres)
slots.ts ─► busy, capacity        busy.ts ─► backend-mode, freshness, horizon, indexer.expandIndexedObject, legacy/events-pg (ramo postgres)
watcher ─► sync, discovery, health, identity (F1)     canary ─► watcher.setWatchMode, client (F1)
freshness ─► sync, discovery, health, watcher.statCollectionDir/statPrincipal, horizon
sync ─► indexer, health, ids, identity (F1), client (F1)      discovery ─► indexer.ensureCollectionState, client (F1)
indexer ─► ids, versions, health, calendar-core              rebuild/auditor/horizon ─► sync, indexer, versions, jobs
subscriptions/pull ─► ics-split, indexer, jobs (mirror)       subscriptions/mirror ─► jobs, client (F1), calendar-core
```

Divieti: nessun modulo `radicale/*`, `busy.ts`, `subscriptions/*` importa la facade o `store.ts` come valore (solo `backend-mode.ts` per il modo); `radicale/store.ts` importa da `../store` solo tipi; nessuno importa `legacy/*` tranne `store.ts` e il ramo postgres di `busy.ts`; `index-model.ts`, `errors.ts`, `validation.ts` e `backend-mode.ts` restano moduli foglia.

## 11. Test

- Ogni gruppo scrive i propri test in `apps/api/test/calendar/<modulo>.test.ts` (senza Radicale) e `apps/api/test/integration/<modulo>.test.ts` (Radicale reale, `useRadicale()` di `helpers/radicale.ts`, saltati senza `RADICALE_BIN`). Etichette e prefissi propri (`useFixtures('<gruppo>-…')`).
- I test che popolano l'indice partono da `resetCalendarBaseline()` (svuota indice, id, versioni, job e conflitti) o puliscono i propri calendari (le righe dell'indice spariscono in cascata).
- Store forzato: `overrideCalendarStore('radicale')` (vale anche per `backend-mode.ts` e quindi per il busy), sempre tolto in `onBeforeDatabaseClose`; mai un `after()` di primo livello che usi il database.
- Matrice del design §15 (`CALENDAR_BACKEND=postgres|radicale`): i contratti F0 girano su entrambi gli store con lo stesso snapshot; le differenze solo da `allowed-diffs.json` (spostando da `planned` a `diffs` quelle che il codice produce). Il preparatore della matrice radicale (Radicale reale, inizializzazione, indice) è dell'integrazione finale.
- Casi minimi per gruppo (piano F2, "Test"): SYNC token scaduto → full resync, 60% spariti → hold con busy invariato, identità diversa → 503, canary fallito → remote mode; INDEX RRULE invalida → `/slots` 200 con busy conservativo, file corrotto → quarantena con ultima versione buona, rebuild con id identici, HOURLY infinita → `materialized_until` senza 503; STORE guardie e messaggi identici, 412 e CAS, 409 per recurrence_key sparita, lifecycle; BUSY riprogrammazione sovrapposta accettata, Radicale fermo con directory cambiata → 503, fermo senza modifiche → accettata, MCP create_booking indisponibile → `{error}` senza code; SUBS DTSTAMP sempre nuovo → zero scritture e zero versioni, iscrizione non visibile → nessuna PUT; CONSUMERS ETag diverso al cambio di data, CANCELLED escluso, UID legacy delle proiezioni, agenda espansa.

## 12. Bootstrap, cron e variabili

Collegati dall'integrazione in `apps/api/src/cron/calendar-radicale.ts`: `startCalendarBackground()` al boot (dopo il control-plane) e `stopCalendarBackground()` nello shutdown (prima di `sql.end()`), richiamati da `src/index.ts`; i cron sono registrati in `src/cron/index.ts`. Guardie: senza Radicale configurato (`radicaleRuntime().client === null`, cioè `RADICALE_URL` assente o credenziali non valide) worker dei job, campanello, canary, auditor e orizzonte restano spenti e la salute lo dichiara; il listener del modo e la registrazione degli handler (solo in memoria) partono sempre; il pull delle iscrizioni verso l'indice gira solo con lo store postgres (con lo store Radicale lo fa già `ics-pull` attraverso la facade). L'arresto ferma canary, campanello (con le sync in corso), worker dei job e dell'indicizzatore e listener del modo, e per ultimo chiude il pool calendario.

| Avvio | Funzione | Proprietario |
|---|---|---|
| boot | `startBackendModeListener()` | fondazione |
| boot | `registerBookingJobs()`, `registerSubscriptionMirrorJob()`, `registerIndexRebuildJob()`, `registerStoreJobs()` (`recurrence_split`, `calendar_lifecycle`), poi `startCalendarJobWorker()` | BUSY, SUBS, INDEX, STORE, fondazione |
| boot | `startCalendarWatcher()`, `startCanarySchedule()` (solo con Radicale configurato) | SYNC |
| shutdown | `stopCanarySchedule()`, `stopCalendarWatcher()`, `stopCalendarJobWorker()`, `stopIndexWorker()`, unlisten del modo, `closeCalendarPool()` | SYNC, INDEX, fondazione |
| cron 15 min (`calendar-subscriptions-index`) | `pullAllSubscriptionsToIndex()` accanto a `runIcsPull`, solo con lo store postgres | SUBS |
| cron giornaliero (`calendar-horizon`, ore 1) | `ensureHorizon()` | INDEX |
| cron notturno (`calendar-audit`, ore 4) | `runCalendarAudit()` | INDEX |

| Variabile | Default | Proprietario | Significato |
|---|---|---|---|
| `CAL_DB_POOL_MAX` | 4 | fondazione | Connessioni del pool calendario |
| `CAL_SYNC_CONCURRENCY` | 2 | INDEX | Scrittori dell'indice contemporanei (≤ `CAL_DB_POOL_MAX` − 2) |
| `CALDES_WATCH` | `auto` | SYNC | `auto` (mount se c'è, altrimenti remote con `RADICALE_URL`), `mount`, `remote`, `off` |
| `CALDES_WATCH_FS_TYPES` | — | SYNC | Solo test: tipi di filesystem accettati da statfs |
| `CAL_ALLDAY_OPAQUE_BLOCKS` | `off` | INDEX | Decisione 6 (release successiva) |
| `CAL_FEED_UID_DOMAIN` | host di `publicApiUrl()` | CONSUMERS | Dominio degli UID del feed (congelato) |

## 13. Precisazioni rispetto al design

1. Orizzonte materializzato per collezione (`cal_collection_state.horizon_start/end`) invece delle colonne globali di `calendar_backend_state` (§4, 165): ogni collezione si rimaterializza in una propria transazione, come il rebuild. La 165 PUÒ non aggiungere `horizon_start/end`.
2. `recurrence_key` ammette anche il formato floating `YYYYMMDDTHHMMSS` (quello di calendar-core) e `conservative` per il blocco conservativo; un'occorrenza `kind='conservative'` da budget esaurito può avere la chiave dell'espansione.
3. Con l'interruttore anti-cancellazione gli upsert si applicano e solo le cancellazioni restano sospese (`pending_deletions`): il design dice "non si applica nulla", ma un oggetto nuovo o modificato aggiunge solo busy (conservativo) e lasciarlo fuori nasconderebbe un evento vero.
4. `cal_jobs` ha anche gli stati `dead` (dead letter) e `superseded`, e `lease_token` per il claim.
5. Tre letture dei consumatori entrano nello store (`countEventsByCalendar`, `listClosures`, `buildCalendarFeed`): in mode postgres sono le query di oggi spostate.
6. Il gate `cal-write` vale in F2 solo per RadicaleStore; PgLegacyStore lo prende dalla F4 (transizioni da postgres).
7. In mode postgres né la discovery né il pull delle iscrizioni creano righe di `calendars`.
8. Espansione con il motore RRULE proprio di calendar-core (`src/recur.ts`, port dell'algoritmo di dateutil, interno al pacchetto) invece dell'iteratore di ical.js citato dal design (§2, §6.2 passo 7, §6.4): avanzamento diretto al periodo della finestra per le regole senza COUNT, budget contato dentro l'iteratore, nessuna eccezione per dati sbagliati (quarantena), stesse istanze del legacy (rrule.js) e di Radicale (vobject → dateutil). ical.js resta per i VTIMEZONE non IANA. Unica differenza voluta da dateutil: BYDAY misto in MONTHLY/YEARLY (es. `BYDAY=MO,1FR`) con l'unione di RFC 5545 che mostrano i device (avviso `MIXED_BYDAY`). `validate.ts` conta le istanze nell'orizzonte con lo stesso `expandObject` dell'indice.
9. Il blocco conservativo da budget d'espansione esaurito usa sempre la chiave `conservative` (`CONSERVATIVE_RECURRENCE_KEY`), come quello degli oggetti illeggibili: la versione 1 di questo contratto ammetteva anche la chiave dell'espansione.
10. `RadicaleStore`: con Radicale non configurato o irraggiungibile le letture vengono dal sidecar e dall'indice e le scritture rispondono `CalendarUnavailableError('radicale_unreachable')` dopo le guardie di oggi (lo stub `store_not_available` della fondazione non esiste più).

## 14. Questioni aperte

1. ~~**Provenienza e `source_id`** (CORE)~~ **Chiusa**: `deriveProvenance` restituisce `X-CALDES-SOURCE-ID` come `source_id` per le source non di sistema (mai per booking, system, ics_pull); le copie fatte con "Duplica" conservano il `source_id`.
2. **`_canary`** (SYNC, §4.2): il volume inizializzato in F1 non ha `_canary`, quindi fino alla sua creazione il campanello resta in remote mode. `calendar:radicale-init -- --apply` la crea anche sui volumi F1 già inizializzati: va eseguito una volta dopo il deploy della F2.
3. ~~**Shutdown** (integrazione)~~ **Chiusa**: bootstrap e shutdown collegati in `src/cron/calendar-radicale.ts` (§12).
4. **Contratto del control-plane §2**: elenca `horizon_start/end` fra le colonne della 165; da allineare alla precisazione 1 quando si scrive la 165.
5. **Matrice `CALENDAR_BACKEND=radicale` dei contratti F0** (§11): da preparare (Radicale reale inizializzato, worker dei job per le proiezioni, fixture delle iscrizioni senza `replaceSubscriptionEvents`, che RadicaleStore non espone). Oggi i contratti girano su PgLegacyStore e RadicaleStore è coperto dai test di modulo e d'integrazione.
6. **INTERVAL=0 in Radicale** (F1, `apps/radicale`): una PUT con `FREQ=DAILY;INTERVAL=0` viene accettata e una REPORT calendar-query con time-range su quella collezione resta appesa (dateutil). Lato API nessun rischio (calendar-core rifiuta la regola, l'indice mette l'oggetto in quarantena); il plugin `caldes_vobject_fix` dovrebbe rifiutare alla PUT le RRULE con `INTERVAL<1` e le altre combinazioni vietate dalla RFC che dateutil accetta.
