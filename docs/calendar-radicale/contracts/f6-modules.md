# Contratto dei moduli della F6

Versione 1.1 (la 1.0 copriva la tranche B; la 1.1 rende vincolante il §9 per la tranche C). Vincola chi implementa la fase F6 del [piano](../piano.md) ("Admin client CalDAV quasi 1:1"), divisa in due tranche: la **tranche B** (subito, due agenti paralleli **API** e **ADMIN**) e la **tranche C** (fase successiva). Riferimenti al [design](../design.md): §5 (identità e provenienza), §8 (percorso di scrittura, ricorrenze, MOVE), §11 (admin come client CalDAV), §16.2 (backup in `mode≠postgres`); [decisioni](../decisioni.md) 2, 3, 6, 7 e 9. Restano in vigore e prevalgono, salvo le eccezioni dichiarate nel §11: il [contratto del control-plane](control-plane.md), il [contratto della F2](f2-modules.md) (facade, indice, id, salute, gate, store), della [F3](f3-modules.md) (route della migrazione, difesa CSRF) e della [F4](f4-modules.md) (modi, livello API, ritocchi dell'admin).

"DEVE", "NON DEVE" e "PUÒ" hanno il significato normativo consueto. Le firme elencate sono quelle che l'altro agente importa: un agente PUÒ aggiungere funzioni ed esportazioni, NON DEVE cambiare nome, argomenti o semantica di quelle elencate senza un aggiornamento di questo contratto.

## 0. Perimetro e invarianti

1. **Rilascio dopo la F5.** Le funzioni nuove lavorano solo sullo store Radicale (mode `radicale` e `finalized`; lettura anche in `rollback`). In mode `postgres` e `cutover` l'API v2 lo dichiara nelle capacità (§2) e l'admin si comporta esattamente come oggi.
2. **Nulla dell'admin attuale cambia in mode postgres.** Le route v1 (`routes/calendar/admin.ts`), `evento-edit.tsx`, `lib/recurrence-form.ts`, le query key di react-query (`admin-calendar-events`, `admin-calendars`, `admin-bookings`, `admin-calendar-event-raw`) e il drag & drop della vista restano invariati (nella tranche C la vista cambia solo con `caps.occurrences`, §9.0). La v2 è un router nuovo montato accanto.
3. **Contratti invariati:** sito (`/api/calendar/*`), feed ICS, percorsi CalDAV dei device, 22 tool MCP, contratti F0 verdi su entrambi gli store.
4. **Tranche B senza migrazioni, variabili, cron né dipendenze nuove.** Nessuna modifica a `apps/admin/package.json`, `apps/admin/vite.config.ts`, `apps/admin/Dockerfile`, `apps/api/package.json`, `pnpm-lock.yaml`, `.github/workflows/*`. Una migrazione della tranche C, se serve, prende un numero ≥ 168 (la 167 è del finalize, piano F7). Le eccezioni della tranche C sono nel §9.0.
5. **Lossless.** Ogni scrittura v2 passa dalla pipeline del design §8 (gate `cal-write`, GET, CAS, patch di calendar-core, PUT con precondizione, write-through, audit): VALARM, ATTENDEE, X-* e parametri sconosciuti non toccati restano byte per byte dove sono; SEQUENCE+1 solo per tempi, ricorrenza, luogo o stato; DTSTAMP e LAST-MODIFIED aggiornati.
6. **Dati personali.** Nessun testo di evento nei log né in `audit_logs` (solo collezione, href, ETag prima e dopo, nomi dei campi cambiati, scope).

## 1. Decisione: calendar-core resta sul server nella tranche B

L'admin **non** importa `@calicchia/calendar-core` nella tranche B. Parsing, validazione, espansione, anteprima delle ricorrenze e riepilogo in italiano stanno nell'API; il browser lavora su JSON.

Motivi:
- **Costo minimo e nessun rischio di build.** Il Dockerfile dell'admin copia solo `packages/shared`; portare calendar-core richiede COPY in due stadi, la dipendenza `workspace:*`, la gestione di `ical.js` e `timezones-ical-library` in vite (chunk dedicato, peso dei VTIMEZONE) e un nuovo lockfile. Niente di questo serve all'editor.
- **Una sola verità.** Espansione, recurrence key, retipizzazione dei RECURRENCE-ID e validazione sono quelle dell'indice e del write path: un secondo motore nel browser potrebbe mostrare un'anteprima diversa da ciò che il server scrive.
- **Il JSON è già lossless.** Le forme di calendar-core (`IcsTime`, `IcsDuration`, `IcsProperty`, `IcsComponent`, ...) sono dati semplici: i DTO del §4 le ricopiano identiche, l'API le passa a `applyPatch` senza conversioni e l'admin le manipola con pochi helper puri (§6.2), partendo sempre dal componente grezzo ricevuto (così un VALARM o un ATTENDEE modificato conserva le proprietà e i parametri che l'editor non conosce).
- **Anteprima e validazione via `dryRun`** (§3.5): stessa pipeline della scrittura, senza PUT.

Il riepilogo RRULE in italiano è una funzione pura nuova di calendar-core (`describeRrule`, §5.5), così la tranche C la può riusare nel browser se lo decide. La scelta per la tranche C (import e editor raw) è nel §9.4.

## 2. Capacità per modo

`GET /api/admin/calendar/v2/capabilities` (§3.4) risponde sempre 200 (anche in mode postgres e con livello API insufficiente) con `CalV2Capabilities` (§4).

| mode | store | `objects.read` | `objects.write` | `objects.dry_run` | `reasons` |
|---|---|---|---|---|---|
| `postgres` | postgres | false | false | false | `STORE_POSTGRES` |
| `cutover` | postgres | false | false | false | `STORE_POSTGRES`, `WRITES_SUSPENDED` |
| `radicale` | radicale | true | true (false con `write_freeze`) | true | `WRITE_FREEZE` se attivo |
| `rollback` | radicale | true | false | true | `WRITES_SUSPENDED` |
| `finalized` | radicale | come `radicale` | | | |

In aggiunta, su qualsiasi modo: Radicale non configurato → `read` e `write` false, `RADICALE_UNCONFIGURED`; `calendarApiLevelBlocked()` → tutto false, `API_LEVEL_BLOCKED`. Il modo si legge con `readBackendStateCached()` (2 s). I flag della tranche C (`raw_edit`, `object_tools`, `history`, `trash`, `import_export`, `calendar_properties`, `health_page`, `occurrences`) sono `false` nella tranche B; ciascuno lo accende il passo che ne implementa le route (§9.7), sempre in AND con `objects.read`.

Regole per l'admin:
- capacità non leggibili (errore di rete, 404 di un'API più vecchia, 5xx) → si comporta come `read: false` (editor v1): un deploy disallineato non rompe nulla;
- `read: false` → editor v1, nessun elemento v2 visibile;
- `read: true, write: false` → editor v2 in sola lettura con un banner che spiega `reasons`;
- `read: true, write: true` → editor v2.

Le route `objects` con store postgres rispondono 409 `STORE_MODE_UNSUPPORTED` (details `{ mode, store }`), senza toccare nulla. Scritture con `write: false` per transizione o freeze → 503 `CALENDAR_UNAVAILABLE` dal gate, come v1.

## 3. API v2, tranche B

### 3.1 Montaggio, autenticazione, CSRF, errori

- Router `calendarAdminV2` in `apps/api/src/routes/calendar/admin-v2.ts`, montato in `app.ts` su `/api/admin/calendar/v2` **prima** di `/api/admin/calendar` (come la migrazione). Il JWT admin lo copre già (`protectedPaths` contiene `/api/admin/calendar`, con `app.use('/api/admin/calendar/*', authMiddleware)`): nessuna modifica all'autenticazione, ma un test DEVE verificare il 401 senza cookie.
- Difesa CSRF identica alle route della migrazione e di v1: `calendarAdminV2.use('*', sameOriginWrites({ log }))` (Sec-Fetch-Site, Origin ammesse, corpo solo `application/json`, nessun percorso multipart). `If-Match` è un header non semplice: una richiesta da un'altra origine passa comunque dal preflight CORS.
- `bodyLimit` di 2 MB sul router (oggetto ≤ 1 MB, design §8).
- Risposte JSON tranne `GET /objects/:id/ics`. Errori `{ error, code, details? }` (`CalV2ErrorBody`), con `code` in `CAL_V2_ERROR_CODES` e lo stato del §3.10. `onError` del router: `CalendarV2Error` → il suo stato; `CalendarUnavailableError` → 503 `CALENDAR_UNAVAILABLE`; `CalendarRecurrenceConflictError` e `RecurrenceTargetError` → 409 `RECURRENCE_TARGET_GONE`; `EventReadOnlyError` → 403 `READ_ONLY`; `EventValidationError` e `ValidationError` di calendar-core → 400 `VALIDATION_FAILED` con `details.issues`; il resto all'handler globale.
- Ogni scrittura riuscita (non dryRun) scrive una riga in `audit_logs` con l'helper `audit()` dello store: `table_name 'cal_objects'`, `operation` `'v2.patch' | 'v2.patch+move' | 'v2.create' | 'v2.delete'`, `{ collection, href, etag_before, etag_after, changed, scope }`, attore `'admin'` e id dell'utente del JWT se presente.

### 3.2 Identificazione

- `:id` accetta l'id della risorsa (`cal_objects.id`), l'id di un componente (override, `cal_object_ids.id`) o l'UID, risolti con `resolveEventRef` (stesse regole del resolver dello store; UID in più calendari → 409 `AMBIGUOUS_REF` con `details.candidates`).
- Il **target** è il componente su cui l'utente lavora, indicato da `recurrence_key` (formato di `recurrenceKeyOf`, `''` = master o evento singolo). In lettura si può passare in alternativa `original_start` (istante ISO dell'occorrenza, come lo dà la lista v1 `/events`): il server lo converte nella chiave tipizzata come il DTSTART del master e la restituisce in `target.recurrence_key`. Un id di override senza parametri ha come target quell'override. Un'istanza che non esiste più → 409 `RECURRENCE_TARGET_GONE`.
- Le scritture usano sempre `target.recurrence_key` (mai `original_start`).

### 3.3 ETag, base e conflitti

- `etag` è l'ETag di Radicale così com'è (con le virgolette), identico all'header `ETag` delle risposte. `GET /objects/:id` legge la risorsa **da Radicale** (testo ed ETag correnti); se Radicale non risponde usa `cal_objects.raw_ics` ed `etag` con `source: 'index'` e la nota `index_fallback` (le scritture falliranno comunque con 503).
- `PATCH` e `DELETE` richiedono `If-Match` con un ETag esatto: assente o `*` → 428 `PRECONDITION_REQUIRED`.
- **Token di base.** Ogni `CalV2ComponentView` porta `tokens`: per ogni campo tipizzato (`summary`, `start`, `alarms`, ...) e per ogni proprietà non tipizzata presente (`prop:X-FOO`, `prop:CONFERENCE`, ...) un token opaco del valore visto (sha256 del JSON canonico del valore, 16 caratteri esadecimali). Per una proprietà assente il client usa `CAL_V2_ABSENT_TOKEN`. Il client manda in `base` il token, preso da `target.tokens`, di ogni campo o proprietà che tocca. I token si calcolano sempre sul componente target come lo vede l'utente: master, override esistente o pre-immagine (copia del master materializzata all'istanza, come `preImage()` dello store).
- **Algoritmo** (dentro `writeObject`, al più 3 tentativi; un 412 di Radicale riparte dal GET):
  1. risorsa sparita → 404 `NOT_FOUND`; testo illeggibile → 403 `READ_ONLY` (`unreadable`); target sparito → 409 `RECURRENCE_TARGET_GONE`;
  2. `If-Match` uguale all'ETag corrente → si applica;
  3. diverso: per ogni chiave toccata si confronta `base[k]` con il token corrente del target. Una chiave è in conflitto se il token differisce (o manca in `base`) **e** applicare l'op al testo corrente la cambierebbe ancora (se il server ha già il valore richiesto non c'è conflitto: un nuovo invio della propria modifica già riuscita è un noop);
  4. nessun conflitto → si applica al testo corrente, `merged: true`; altrimenti 412 `PRECONDITION_FAILED` con `CalV2PreconditionFailedBody`: `current` (la versione del server, vista completa con il suo `etag` e il target ricalcolato) e `conflicts` (`{ field, theirs, yours }`, valori nel formato wire).
- `DELETE` non ha campi: ETag diverso → 412 con `current` e `conflicts: []`.
- Con `dryRun: true` la stessa logica produce gli stessi 412 senza scrivere nulla.

### 3.4 Letture

| Metodo e percorso | Risposta |
|---|---|
| `GET /capabilities` | 200 `CalV2Capabilities` |
| `GET /objects/:id?recurrence_key=` oppure `?original_start=` | 200 `CalV2ObjectView`, header `ETag`; 400 se entrambi i parametri |
| `GET /objects/:id/ics` | 200 `text/calendar; charset=utf-8`, header `ETag`, `Content-Disposition: inline; filename="<uid>.ics"` (UID sanificato) |

Per un oggetto illeggibile (`parse_error` non nullo) la vista ha `master: null`, `overrides: []`, `target: null`, `readonly_reason: 'unreadable'` e `ics` col testo così com'è.

### 3.5 `PATCH /objects/:id`

Header `If-Match`; corpo `CalV2PatchRequest`; risposta 200 `CalV2WriteResult` con header `ETag` (nuovo ETag; con `noop` quello corrente).

Validazione della richiesta (400 `VALIDATION_FAILED` o `SCOPE_INVALID`): `ops` da 1 a 50 (0 solo con `move_to_calendar_id`, che allora richiede `If-Match` esatto); un campo al più una volta; `set_property` solo con nomi `^[A-Z][A-Z0-9-]*$` fuori da `CAL_V2_RESERVED_PROPERTIES` e con `properties[i].name` uguale a `name`; valori conformi ai tipi del §4 (schema zod lato API); limiti: 20 VALARM, 200 ATTENDEE, 50 proprietà per nome, testo di un campo ≤ 64 KB; scope ammessi dal §3.8.

Effetto: applica gli op al target con la semantica dello scope (§3.8), poi la validazione di calendar-core (`validateObject` con `previous`), poi PUT. `move_to_calendar_id` (solo con scope `all`): dopo la PUT (o subito se gli op sono un noop) MOVE con `Overwrite: F` sulla destinazione, che DEVE essere attiva, non `subscription`, non archivio e con VEVENT nel component-set (altrimenti 403 `READ_ONLY` o 400); href o UID già presenti → 409 `MOVE_CONFLICT`. Se la PUT è riuscita e la MOVE no, la risposta è 409 `MOVE_CONFLICT` con `details: { patched: true, etag }`.

`dryRun: true`: GET, stessa logica e stessa validazione, **senza** gate, PUT, MOVE né audit; funziona anche con le scritture sospese. Risposta 200 con `dry_run: true`, `object` = vista del risultato (con `etag` invariato), `changed`, `orphaned_overrides`, `issues` (anche gli errori: in dryRun la validazione fallita dà `valid: false`, non 400) e `preview` aggiornata.

### 3.6 `POST /objects`

Corpo `CalV2CreateRequest`; nessun `If-Match` (PUT interna con `If-None-Match: *`). Risposta 201 `CalV2WriteResult` con header `ETag` e `Location: /api/admin/calendar/v2/objects/<id>`.

- Solo VEVENT nella tranche B. Calendario: come `eventTargetCalendar` (attivo, non `subscription`) e non archivio.
- UID: quello del corpo (`^[A-Za-z0-9@._-]{1,255}$`) o generato; href = `hrefForUid(uid)`. Risorsa già esistente → 409 `OBJECT_EXISTS` con `details.object_id` (l'admin genera l'UID all'apertura del form: un secondo invio dopo un errore di rete trova il proprio oggetto).
- Il server scrive UID, DTSTAMP, CREATED, LAST-MODIFIED, `SEQUENCE:0` e la provenienza di `createEvent` con source `admin` (design §5). `start` obbligatorio; per un timed `end` o `duration` obbligatorio; all-day senza fine → un giorno. `transp` assente per default (decisione 6: all-day libero).
- `dryRun` come nel §3.5: nessuna PUT, risposta 200 con `object.id = ''` e `etag: null`.

### 3.7 `DELETE /objects/:id?scope=&recurrence_key=&dry_run=1`

Header `If-Match`. Risposta 200 `CalV2WriteResult` (`object: null` se la risorsa è stata eliminata, altrimenti la vista aggiornata con il nuovo `ETag`).

Senza `recurrence_key` il target è il componente indicato dall'id (come nel §3.2: un id di override ha come target quell'override); `recurrence_key=` vuoto indica il master. Senza `scope` vale `all` solo se il target è il master o un evento singolo; per un'istanza lo scope va scelto (400 `VALIDATION_FAILED`, `property: scope`).

| scope | evento singolo (chiave `''`) | serie, target K ≠ `''` |
|---|---|---|
| `all` | DELETE della risorsa | DELETE della risorsa |
| `this` | 400 `SCOPE_INVALID` | `excludeOccurrence(K)` (EXDATE tipizzato + rimozione dell'override); se non resta nessuna istanza, DELETE della risorsa |
| `this_and_future` | 400 `SCOPE_INVALID` | `truncateSeries(K)`; `null` (K è la prima istanza) → DELETE della risorsa |

Guardie: proiezione `booking-*` di una prenotazione `pending/confirmed` → 403 `READ_ONLY` con `ACTIVE_BOOKING_MESSAGE` e `details.reason: 'booking_active'`; iscrizione → 403 con `ICS_READ_ONLY_MESSAGE`.

### 3.8 Semantica degli scope (modifica)

| Oggetto | target | scope | Effetto |
|---|---|---|---|
| singolo (né RRULE né RDATE) | `''` | `all` | `applyPatch` sul master; altri scope → `SCOPE_INVALID` |
| serie | `''` | `all` | ops sul master, propagate agli override (sotto) |
| serie | K | `this` | `applyPatch(obj, K, ops, { createOverride: true })`; op su `rrule`, `rdates`, `exdates` → `SCOPE_INVALID` |
| serie | K | `this_and_future` | saga `recurrence_split` (design §8): nuova serie con UID nuovo e `RELATED-TO;RELTYPE=SIBLING` che parte da K con gli op applicati, vecchio master troncato; K prima istanza → come `all` (`whole_series: true`) |
| serie | K | `all` | ops sul master: `start` ed `end` dell'istanza diventano uno spostamento Δ = nuovo start − start della pre-immagine di K (in ora da muro nella zona del nuovo valore) applicato con `shiftSeries` al DTSTART del master, e la durata nuova (nuovo end − nuovo start) va sul master come DTEND (o DURATION, se il master la usa); cambio di tipo (all-day ↔ timed) o di TZID sul master così com'è; gli altri campi come per target `''` |
| solo override (master assente) | K | `this` | come sopra; `all` e `this_and_future` → `SCOPE_INVALID` |

**Propagazione con scope `all`.** Un campo non temporale toccato si applica al master, all'override del target se esiste, e agli override il cui valore del campo coincideva con il valore precedente del master (non personalizzati); gli altri override restano. I tempi degli override li gestisce `shiftSeries` (RECURRENCE-ID, EXDATE, RDATE, UNTIL); un orfano o un DTSTART fuori regola → 409 `RECURRENCE_TARGET_GONE` o 400 come oggi. Un cambio di `rrule` passa da `changeRecurrence` e restituisce `orphaned_overrides` (in dryRun senza scrivere).

### 3.9 Sola lettura e note

`readonly_reason` (tutte le scritture rifiutate con 403 `READ_ONLY`, `details.reason`):
- `subscription`: calendario `role = 'subscription'` (testo di `ICS_READ_ONLY_MESSAGE`);
- `archive`: calendario con `origin = 'migration'` (archivio della Fase 0, decisione 7). Vale solo per la v2: le route v1 e MCP restano come sono (§11);
- `unreadable`: testo non interpretabile (oggetto in quarantena per parse); DELETE `all` resta ammessa;
- `component_unsupported`: VTODO o VJOURNAL (tranche B: solo VEVENT);
- `writes_suspended`: capacità `write: false` (informativa; il rifiuto vero è il 503 del gate).

`delete_blocked_reason`: `booking_active`. `notices` (informative, mai bloccanti): `booking_projection` (le modifiche a orario e titolo possono essere riscritte dalla prenotazione: decisione 2, parità con v1), `no_scheduling` (ci sono ATTENDEE: Radicale non implementa RFC 6638, gli invitati non ricevono nulla), `index_fallback`, `collection_hold`.

### 3.10 Codici

| Stato | `code` | Quando |
|---|---|---|
| 400 | `VALIDATION_FAILED` | corpo, op o valori non validi; validazione di calendar-core (`details.issues: CalV2Issue[]`) |
| 400 | `SCOPE_INVALID` | combinazione di scope, target e campi non ammessa dal §3.7 o dal §3.8 |
| 401 | (middleware) | JWT assente o scaduto |
| 403 | `CSRF_REJECTED` | `sameOriginWrites` (415 per il Content-Type, come v1) |
| 403 | `READ_ONLY` | §3.9, guardie di prenotazione e iscrizione |
| 404 | `NOT_FOUND` | oggetto o calendario inesistente, risorsa sparita durante la scrittura |
| 409 | `AMBIGUOUS_REF` | UID in più calendari |
| 409 | `RECURRENCE_TARGET_GONE` | istanza non più nel set corrente, orfano da spostamento |
| 409 | `OBJECT_EXISTS` | creazione su href o UID esistente |
| 409 | `MOVE_CONFLICT` | MOVE rifiutata |
| 409 | `STORE_MODE_UNSUPPORTED` | store postgres |
| 412 | `PRECONDITION_FAILED` | §3.3 |
| 428 | `PRECONDITION_REQUIRED` | `If-Match` assente o `*` |
| 503 | `CALENDAR_UNAVAILABLE` | transizione, freeze, identità del volume, Radicale irraggiungibile in scrittura, livello API |

## 4. DTO condivisi: `packages/shared/src/calendar-v2.ts`

Proprietario: agente API nella tranche B; nella tranche C il file lo scrive l'architetto **prima** dei flussi (§9.5) e nessun flusso lo modifica. Solo tipi e costanti, nessun import. Esportato da `packages/shared/src/index.ts` (`export * from './calendar-v2';`) e dalla voce `"./calendar-v2": "./src/calendar-v2.ts"` di `packages/shared/package.json`. L'admin importa da `@calicchia/shared` (già dipendenza dell'admin e già copiata nel suo Dockerfile). L'agente API scrive questo file **per primo**, identico al blocco qui sotto; un test di tipo dell'API (`admin-v2-view.test.ts`) verifica che `CalV2Time`, `CalV2Duration`, `CalV2Property`, `CalV2Component` e `CalV2FieldValues` siano assegnabili da e verso i tipi di calendar-core (`IcsTime`, ..., `PatchFieldValues`).

```ts
/**
 * DTO dell'API admin del calendario v2 (/api/admin/calendar/v2), condivisi da
 * API e admin. Contratto: docs/calendar-radicale/contracts/f6-modules.md.
 * Solo tipi e costanti. Le forme iCalendar sono identiche a quelle di
 * @calicchia/calendar-core (model.ts, patch.ts): l'API le passa senza
 * conversioni e l'admin non importa calendar-core.
 */

export const CAL_V2_API_VERSION = 2 as const;

// ─── Forme iCalendar (specchio di calendar-core) ───────────────────────────────

export interface CalV2Param { name: string; values: string[] }
export interface CalV2Property { name: string; params: CalV2Param[]; value: string }
export interface CalV2Component { name: string; properties: CalV2Property[]; components: CalV2Component[] }
export type CalV2Zone = { kind: 'utc' } | { kind: 'floating' } | { kind: 'tzid'; tzid: string };
export interface CalV2Date { type: 'date'; year: number; month: number; day: number }
export interface CalV2DateTime {
  type: 'date-time';
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  zone: CalV2Zone;
}
export type CalV2Time = CalV2Date | CalV2DateTime;
export interface CalV2Duration { negative: boolean; weeks: number; days: number; hours: number; minutes: number; seconds: number }
export interface CalV2Period { type: 'period'; start: CalV2DateTime; end: CalV2DateTime | null; duration: CalV2Duration | null }
export interface CalV2Geo { lat: number; lon: number }

// ─── Modi e capacità ───────────────────────────────

export const CAL_V2_BACKEND_MODES = ['postgres', 'cutover', 'radicale', 'rollback', 'finalized'] as const;
export type CalV2BackendMode = (typeof CAL_V2_BACKEND_MODES)[number];

export const CAL_V2_SCOPES = ['this', 'this_and_future', 'all'] as const;
export type CalV2Scope = (typeof CAL_V2_SCOPES)[number];

export const CAL_V2_CAPABILITY_REASONS = [
  'STORE_POSTGRES', 'WRITES_SUSPENDED', 'WRITE_FREEZE', 'RADICALE_UNCONFIGURED', 'API_LEVEL_BLOCKED',
] as const;
export type CalV2CapabilityReason = (typeof CAL_V2_CAPABILITY_REASONS)[number];

export interface CalV2Capabilities {
  api_version: typeof CAL_V2_API_VERSION;
  mode: CalV2BackendMode;
  store: 'postgres' | 'radicale';
  objects: { read: boolean; write: boolean; dry_run: boolean; scopes: CalV2Scope[] };
  /** Tranche C (§9.7): vero solo se la route esiste E objects.read. */
  raw_edit: boolean;
  object_tools: boolean;
  history: boolean;
  trash: boolean;
  import_export: boolean;
  calendar_properties: boolean;
  health_page: boolean;
  occurrences: boolean;
  reasons: CalV2CapabilityReason[];
}

// ─── Campi ───────────────────────────────

export const CAL_V2_FIELDS = [
  'summary', 'description', 'location', 'url', 'status', 'transp', 'class', 'priority', 'categories', 'color', 'geo',
  'start', 'end', 'duration', 'rrule', 'rdates', 'exdates', 'alarms', 'organizer', 'attendees',
] as const;
export type CalV2FieldName = (typeof CAL_V2_FIELDS)[number];

/** Campi che solo la serie intera (o la nuova serie) può cambiare: mai con scope 'this'. */
export const CAL_V2_SERIES_ONLY_FIELDS = ['rrule', 'rdates', 'exdates'] as const satisfies readonly CalV2FieldName[];

/** Valori tipizzati (identici a PatchFieldValues di calendar-core). */
export interface CalV2FieldValues {
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED' | null;
  /** null = TRANSP assente (timed occupato, all-day libero: decisione 6). */
  transp: 'OPAQUE' | 'TRANSPARENT' | null;
  class: string | null;
  /** 0-9, null = assente. */
  priority: number | null;
  categories: string[];
  color: string | null;
  geo: CalV2Geo | null;
  start: CalV2Time;
  /** DTEND; null = assente (si usa duration o la durata implicita). */
  end: CalV2Time | null;
  duration: CalV2Duration | null;
  /** RRULE grezza senza prefisso; null = nessuna ricorrenza. */
  rrule: string | null;
  rdates: Array<CalV2Time | CalV2Period>;
  exdates: CalV2Time[];
  /** VALARM completi: sostituiscono tutti quelli del componente. */
  alarms: CalV2Component[];
  organizer: CalV2Property | null;
  attendees: CalV2Property[];
}

/** Proprietà gestite dai campi o dal server: mai in 'set_property'. */
export const CAL_V2_RESERVED_PROPERTIES = [
  'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'STATUS', 'TRANSP', 'CLASS', 'PRIORITY', 'CATEGORIES', 'COLOR', 'GEO',
  'DTSTART', 'DTEND', 'DUE', 'DURATION', 'RRULE', 'RDATE', 'EXDATE', 'ORGANIZER', 'ATTENDEE',
  'UID', 'RECURRENCE-ID', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE',
] as const;

/** Token di base di una proprietà assente nel componente visto. */
export const CAL_V2_ABSENT_TOKEN = '-';

export type CalV2Op =
  | { [F in CalV2FieldName]: { op: 'set'; field: F; value: CalV2FieldValues[F] } }[CalV2FieldName]
  | {
      op: 'set_property';
      /** Proprietà non tipizzata (X-*, CONFERENCE, ATTACH, RELATED-TO, IANA sconosciute). */
      name: string;
      /** Sostituiscono tutte quelle con quel nome; [] le rimuove. */
      properties: CalV2Property[];
    };

// ─── Viste ───────────────────────────────

export const CAL_V2_READONLY_REASONS = ['subscription', 'archive', 'unreadable', 'component_unsupported', 'writes_suspended'] as const;
export type CalV2ReadonlyReason = (typeof CAL_V2_READONLY_REASONS)[number];
export const CAL_V2_DELETE_BLOCKED_REASONS = ['booking_active'] as const;
export type CalV2DeleteBlockedReason = (typeof CAL_V2_DELETE_BLOCKED_REASONS)[number];
export const CAL_V2_NOTICES = ['booking_projection', 'no_scheduling', 'index_fallback', 'collection_hold'] as const;
export type CalV2Notice = (typeof CAL_V2_NOTICES)[number];

export interface CalV2Address { value: string; cn: string | null; params: CalV2Param[] }

/** Decodifica di un VALARM (fields.alarms[index]) per la sola visualizzazione. */
export interface CalV2AlarmView {
  index: number;
  action: string | null;
  trigger:
    | { kind: 'relative'; related: 'START' | 'END'; offset: CalV2Duration }
    | { kind: 'absolute'; at: CalV2DateTime }
    | null;
  description: string | null;
  summary: string | null;
  /** Valori degli ATTENDEE del VALARM (EMAIL). */
  attendees: string[];
  repeat: number | null;
  duration: CalV2Duration | null;
  /** X-APPLE-DEFAULT-ALARM:TRUE. */
  apple_default: boolean;
  /** UID o X-WR-ALARMUID. */
  uid: string | null;
}

export interface CalV2ComponentView {
  /** '' = master o evento singolo. */
  recurrence_key: string;
  /** Id di (calendario, href, chiave) in cal_object_ids; null per un'istanza mai sovrascritta. */
  component_id: string | null;
  is_override: boolean;
  /** Per un'istanza senza override: pre-immagine (copia del master all'istanza). */
  fields: CalV2FieldValues;
  /** Token di base: chiavi = nomi dei campi e 'prop:<NOME>' delle proprietà presenti. */
  tokens: Record<string, string>;
  all_day: boolean;
  /** Istanti ISO UTC (floating e DATE nel fuso del calendario). */
  start_utc: string;
  end_utc: string;
  readonly: {
    uid: string | null;
    sequence: number | null;
    dtstamp: CalV2DateTime | null;
    created: CalV2DateTime | null;
    last_modified: CalV2DateTime | null;
    recurrence_id: CalV2Time | null;
  };
  alarms: CalV2AlarmView[];
  organizer: CalV2Address | null;
  attendees: CalV2Address[];
  /** Proprietà non tipizzate per nome, nell'ordine del testo. */
  extra_properties: Record<string, CalV2Property[]>;
  warnings: Array<{ code: string; message: string }>;
}

export interface CalV2Preview {
  /** Riepilogo in italiano (describeRrule), null se non ricorrente. */
  rrule_summary: string | null;
  /** Prossime occorrenze (al più 10) dall'istanza del target o da adesso. */
  next: Array<{ recurrence_key: string; start_utc: string; end_utc: string; all_day: boolean; is_override: boolean }>;
  instances_in_horizon: number | null;
  truncated: boolean;
}

export interface CalV2ObjectView {
  /** cal_objects.id; '' nel dryRun di una creazione. */
  id: string;
  calendar_id: string;
  href: string;
  uid: string;
  etag: string | null;
  source: 'radicale' | 'index';
  component_type: 'VEVENT' | 'VTODO' | 'VJOURNAL';
  calendar_tz: string;
  health: 'ok' | 'quarantined' | 'pending_404';
  health_reason: string | null;
  collection_health: 'healthy' | 'stale' | 'unsyncable' | 'hold';
  provenance: { source: string; source_id: string | null };
  readonly_reason: CalV2ReadonlyReason | null;
  delete_blocked_reason: CalV2DeleteBlockedReason | null;
  notices: CalV2Notice[];
  recurring: boolean;
  master: CalV2ComponentView | null;
  /** Ordinati per recurrence key. */
  overrides: CalV2ComponentView[];
  /** Componente richiesto (§3.2); master se non indicato. */
  target: CalV2ComponentView | null;
  calendar_properties: CalV2Property[];
  /** TZID dei VTIMEZONE presenti nel testo. */
  timezones: string[];
  /** Nomi degli altri componenti di primo livello conservati (VFREEBUSY, X-...). */
  other_components: string[];
  /** Solo per una serie leggibile. */
  preview: CalV2Preview | null;
  /** Testo grezzo letto (≤ 1 MB). */
  ics: string;
  parse_error: string | null;
}

// ─── Richieste e risultati ───────────────────────────────

export interface CalV2PatchRequest {
  target: { recurrence_key: string };
  scope: CalV2Scope;
  ops: CalV2Op[];
  /** Token presi da target.tokens per ogni campo o 'prop:<NOME>' toccato. */
  base: Record<string, string>;
  /** Solo scope 'all': sposta la risorsa in un altro calendario (MOVE dopo la PUT). */
  move_to_calendar_id?: string;
  dryRun?: boolean;
}

export interface CalV2CreateRequest {
  calendar_id: string;
  /** Facoltativo: generato dall'admin all'apertura del form (retry sicuro, §3.6). */
  uid?: string;
  fields: Partial<CalV2FieldValues> & { start: CalV2Time };
  /** Proprietà non tipizzate iniziali (stesse regole di 'set_property'). */
  properties?: Record<string, CalV2Property[]>;
  dryRun?: boolean;
}

export interface CalV2Issue {
  code: string;
  severity: 'error' | 'warning';
  /** In italiano, mostrabile. */
  message: string;
  property?: string;
  recurrence_key?: string;
}

export interface CalV2WriteResult {
  /** null dopo l'eliminazione della risorsa. */
  object: CalV2ObjectView | null;
  etag: string | null;
  changed: string[];
  noop: boolean;
  /** Applicata sopra una versione più nuova con campi disgiunti (§3.3). */
  merged: boolean;
  sequence_bumped: boolean;
  /** Solo 'this_and_future'. */
  tail?: CalV2ObjectView | null;
  whole_series?: boolean;
  orphaned_overrides: string[];
  dry_run: boolean;
  valid: boolean;
  issues: CalV2Issue[];
}

export interface CalV2FieldConflict {
  /** Nome del campo o 'prop:<NOME>'. */
  field: string;
  /** Valore corrente sul server (formato wire). */
  theirs: unknown;
  /** Valore richiesto (formato wire). */
  yours: unknown;
}

export const CAL_V2_ERROR_CODES = [
  'VALIDATION_FAILED', 'SCOPE_INVALID', 'CSRF_REJECTED', 'READ_ONLY', 'NOT_FOUND', 'AMBIGUOUS_REF',
  'RECURRENCE_TARGET_GONE', 'OBJECT_EXISTS', 'MOVE_CONFLICT', 'STORE_MODE_UNSUPPORTED',
  'PRECONDITION_FAILED', 'PRECONDITION_REQUIRED', 'CALENDAR_UNAVAILABLE',
  // Tranche C (§9.8).
  'PAYLOAD_TOO_LARGE', 'CONFIRMATION_REQUIRED', 'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_CONFLICT',
  'PLAN_CHANGED', 'VERSION_NOT_RESTORABLE', 'NOT_RESTORABLE', 'CALENDAR_NOT_EMPTY', 'NOT_IN_HOLD',
] as const;
export type CalV2ErrorCode = (typeof CAL_V2_ERROR_CODES)[number];

export interface CalV2ErrorBody { error: string; code: CalV2ErrorCode; details?: Record<string, unknown> }

export interface CalV2PreconditionFailedBody {
  error: string;
  code: 'PRECONDITION_FAILED';
  current: CalV2ObjectView;
  conflicts: CalV2FieldConflict[];
}
```

## 5. Moduli API (agente API)

### 5.1 `apps/api/src/lib/calendar/v2/capabilities.ts`

```ts
export function readCalendarV2Capabilities(db?: Db): Promise<CalV2Capabilities>;
/** Store non radicale → CalendarV2Error('STORE_MODE_UNSUPPORTED'); livello API bloccato → CalendarStoreUnavailableError. */
export function assertV2ObjectsAvailable(): Promise<CalendarBackendState>;
```

### 5.2 `apps/api/src/lib/calendar/v2/errors.ts`

```ts
export class CalendarV2Error extends Error {
  constructor(code: CalV2ErrorCode, status: 400 | 403 | 404 | 409 | 412 | 428, message: string, details?: Record<string, unknown>);
  readonly code: CalV2ErrorCode;
  readonly status: 400 | 403 | 404 | 409 | 412 | 428;
  readonly details?: Record<string, unknown>;
}
export class CalendarV2PreconditionError extends CalendarV2Error {
  constructor(current: CalV2ObjectView, conflicts: CalV2FieldConflict[]);
  readonly current: CalV2ObjectView;
  readonly conflicts: CalV2FieldConflict[];
  toBody(): CalV2PreconditionFailedBody;
}
```

### 5.3 `apps/api/src/lib/calendar/v2/view.ts` (puro, nessun I/O)

```ts
export interface ObjectViewContext {
  objectId: string; calendarId: string; calendarTz: string; href: string;
  etag: string | null; source: 'radicale' | 'index';
  health: CalV2ObjectView['health']; healthReason: string | null;
  collectionHealth: CalV2ObjectView['collection_health'];
  provenance: { source: string; source_id: string | null };
  readonlyReason: CalV2ReadonlyReason | null; deleteBlockedReason: CalV2DeleteBlockedReason | null;
  notices: CalV2Notice[];
  /** recurrence key → component_id noti (cal_object_ids). */
  componentIds: ReadonlyMap<string, string>;
  now: Date;
}
export function buildObjectView(raw: string, obj: CalendarObject | null, parseError: string | null, targetKey: string | null, ctx: ObjectViewContext): CalV2ObjectView;
export function buildComponentView(obj: CalendarObject, recurrenceKey: string, ctx: { tz: string; now: Date; componentId: string | null }): CalV2ComponentView | null;
/** Token di un campo o di 'prop:<NOME>' sul componente (CAL_V2_ABSENT_TOKEN per una proprietà assente). */
export function tokenFor(component: IcsComponent, key: string): string;
export function buildPreview(obj: CalendarObject, opts: { tz: string; now: Date; fromKey?: string; limit?: number }): CalV2Preview | null;
```

### 5.4 `apps/api/src/lib/calendar/v2/series.ts` (puro)

```ts
export interface ScopedPatchContext { tz: string; now: Date }
export interface ScopedPatchResult {
  object: CalendarObject; changed: string[]; noop: boolean; sequenceBumped: boolean;
  /** Chiave del target dopo la patch (cambia solo con una ritipizzazione). */
  targetKey: string;
  rekeyed: Map<string, string>; orphanedOverrides: string[];
}
/** Op wire → PatchOp di calendar-core ('set_property' → 'setProperty'); rifiuta nomi riservati. */
export function toCoreOps(ops: readonly CalV2Op[]): PatchOp[];
/** Scope 'this' o 'all' (§3.8), propagazione inclusa. Lancia CalendarV2Error('SCOPE_INVALID'), RecurrenceTargetError, IcsValueError. */
export function applyScopedPatch(obj: CalendarObject, targetKey: string, scope: 'this' | 'all', ops: readonly CalV2Op[], ctx: ScopedPatchContext): ScopedPatchResult;
/** Chiavi in conflitto secondo il §3.3 (passi 3-4) rispetto al testo corrente. */
export function conflictingKeys(current: CalendarObject, targetKey: string, scope: CalV2Scope, ops: readonly CalV2Op[], base: Readonly<Record<string, string>>, ctx: ScopedPatchContext): CalV2FieldConflict[];
/** Anteprima di 'this_and_future' (splitSeries di calendar-core, senza scrivere). */
export function planThisAndFuture(obj: CalendarObject, targetKey: string, ops: readonly CalV2Op[], ctx: ScopedPatchContext): { wholeSeries: boolean; head: CalendarObject | null; tail: CalendarObject };
/** Piano di una DELETE con scope (§3.7). */
export function planScopedDelete(obj: CalendarObject, targetKey: string, scope: CalV2Scope, ctx: ScopedPatchContext): { action: 'put'; object: CalendarObject } | { action: 'delete' };
```

### 5.5 `packages/calendar-core/src/rrule-summary.ts`

```ts
/**
 * Riepilogo in italiano di una RRULE ("Ogni 2 settimane il lunedì e il
 * giovedì, fino al 31 dicembre 2026"). Puro, senza ical.js. Parti non
 * descrivibili → "Ricorrenza personalizzata (<RRULE>)".
 */
export function describeRrule(rrule: string, dtstart: IcsTime, opts: { tz: string }): string;
```

Esportato da `src/index.ts` e da `"./rrule-summary"` in `package.json` di calendar-core.

### 5.6 `apps/api/src/lib/calendar/v2/objects.ts` (orchestrazione)

```ts
export interface AdminActor { userId: string | null }
export function readObjectV2(ref: string, target: { recurrenceKey?: string; originalStart?: string }): Promise<CalV2ObjectView>;
export function readObjectIcsV2(ref: string): Promise<{ ics: string; etag: string | null; uid: string }>;
export function patchObjectV2(ref: string, ifMatch: string, req: CalV2PatchRequest, actor: AdminActor): Promise<CalV2WriteResult>;
export function createObjectV2(req: CalV2CreateRequest, actor: AdminActor): Promise<CalV2WriteResult>;
export function deleteObjectV2(ref: string, ifMatch: string, req: { scope: CalV2Scope; recurrenceKey: string; dryRun: boolean }, actor: AdminActor): Promise<CalV2WriteResult>;
```

### 5.7 `apps/api/src/lib/calendar/radicale/store.ts` (solo aggiunte)

- Blocco di esportazioni "Primitive per admin-v2 (F6)", senza cambiare semantica né firme interne: `writeObject`, `writeThrough`, `audit`, `resolveEvent`, `sidecarById`, `eventTargetCalendar`, `isActiveBookingProjection`, `positionId`, `requireRadicale`, `fetchCurrent`, `assertEventWritable`, `componentFor`, `preImage`, e i tipi `ObjectWriteRequest`, `WritePlan`, `WriteOutcome`, `CurrentObject`, `ResolvedEvent`, `SidecarRow`. Le scritture v2 usano `maxAttempts: 3`.
- `moveObject` diventa una funzione di modulo esportata `moveObject(from, to, href, expectedEtag): Promise<string | null>`; il metodo privato della classe resta come delega.
- `SplitRecurringEventInput` acquista due campi facoltativi, alternativi a `changes`:

```ts
  /** F6: modifiche della nuova serie come op lossless (esclusivo con changes). */
  ops?: PatchOp[];
  /**
   * F6: chiamato alla prima lettura del master dentro il gate, prima di
   * qualsiasi scrittura della saga; lancia (es. CalendarV2PreconditionError)
   * per fermarla. Riceve testo, ETag e oggetto letti.
   */
  precheck?: (current: { etag: string | null; object: CalendarObject }) => void;
```

  Senza i campi nuovi il comportamento resta quello della F4 (route v1 `POST /events/:id/split` e test esistenti invariati).

### 5.8 `apps/api/src/routes/calendar/admin-v2.ts`

Esporta `calendarAdminV2` (Hono). Una riga in `app.ts`: `app.route('/api/admin/calendar/v2', calendarAdminV2);` subito prima di `app.route('/api/admin/calendar', calendarAdmin);`. Nessun'altra modifica ad `app.ts`.

## 6. Admin, tranche B (agente ADMIN)

### 6.1 Selezione dell'editor (`apps/admin/src/pages/calendario.tsx`)

Unica modifica alla pagina: legge le capacità con `useCalendarV2Capabilities()` e, dove oggi monta `EventoEditModal`, monta `EventoEditor` (v2) se `caps?.objects.read` è vero, altrimenti `EventoEditModal` con le stesse props di oggi. Le props di `EventoEditor` riprendono quelle di v1 (`initial` occorrenza della lista v1, `initialStart`, `initialEnd`, `initialAllDay`, `onClose`, `onSaved`); `onSaved` invalida le stesse query key di oggi più quella dell'oggetto v2. Nessun'altra parte della pagina cambia (vista, drag & drop, pannello laterale, duplica dal pannello).

### 6.2 Client e modello

`apps/admin/src/lib/calendar-v2-api.ts`:

```ts
export const CAL_V2_BASE = '/api/admin/calendar/v2';
export const calV2Keys = {
  capabilities: ['admin-calendar-v2-capabilities'] as const,
  object: (id: string, target: string) => ['admin-calendar-v2-object', id, target] as const,
};
export class CalV2ApiError extends Error {
  constructor(message: string, status: number, code: string | null, details: Record<string, unknown> | null);
  readonly status: number; readonly code: string | null; readonly details: Record<string, unknown> | null;
}
/** 412: porta la versione del server e i conflitti. */
export class CalV2ConflictError extends CalV2ApiError { readonly body: CalV2PreconditionFailedBody }
/** null se le capacità non sono leggibili (→ editor v1). staleTime 20 s, refetch al focus. */
export function useCalendarV2Capabilities(): { caps: CalV2Capabilities | null; isLoading: boolean };
export function getObjectV2(id: string, target: { recurrenceKey?: string; originalStart?: string }): Promise<CalV2ObjectView>;
export function patchObjectV2(id: string, etag: string, req: CalV2PatchRequest): Promise<CalV2WriteResult>;
export function createObjectV2(req: CalV2CreateRequest): Promise<CalV2WriteResult>;
export function deleteObjectV2(id: string, etag: string, q: { scope: CalV2Scope; recurrenceKey: string; dryRun?: boolean }): Promise<CalV2WriteResult>;
export function objectIcsUrl(id: string): string;
```

Trasporto come `migrationFetch` di `calendar-migration-api.ts` (credenziali, lingua, refresh su 401, redirect al login) ma con lo stato e il corpo dell'errore conservati: `apiFetch` perde il corpo del 412 e non va usato per queste route.

`apps/admin/src/lib/calendar-v2-model.ts` (puro, nessun React):

```ts
export interface EditorDraft { fields: CalV2FieldValues; extra: Record<string, CalV2Property[]> }
export function draftFromView(target: CalV2ComponentView): EditorDraft;
/** Op solo per i campi e le proprietà cambiati (confronto profondo), base da target.tokens (CAL_V2_ABSENT_TOKEN per le proprietà nuove). */
export function buildPatch(initial: EditorDraft, draft: EditorDraft, tokens: Record<string, string>): { ops: CalV2Op[]; base: Record<string, string> };
export function allowedScopes(view: CalV2ObjectView, targetKey: string, ops: readonly CalV2Op[], action: 'edit' | 'delete'): CalV2Scope[];
export function timeToForm(t: CalV2Time): { date: string; time: string | null; tzid: string | null; floating: boolean };
export function formToTime(f: { date: string; time: string | null; tzid: string | null; floating: boolean }): CalV2Time;
export function durationToMinutes(d: CalV2Duration): number;
export function minutesToDuration(minutes: number): CalV2Duration;
/** VALARM dal form partendo da `raw`: sostituisce solo ACTION, TRIGGER, DESCRIPTION, SUMMARY, ATTENDEE; il resto resta. */
export function alarmFromForm(form: AlarmForm, raw: CalV2Component | null): CalV2Component;
/** ATTENDEE/ORGANIZER dal form partendo da `raw`: sostituisce valore, CN, ROLE, PARTSTAT, RSVP; gli altri parametri restano. */
export function addressFromForm(form: AddressForm, raw: CalV2Property | null, name: 'ATTENDEE' | 'ORGANIZER'): CalV2Property;
/** Nuovo tentativo dopo un 412: op scelte dall'utente, base ed ETag dalla versione del server. */
export function rebaseAfterConflict(pending: { ops: CalV2Op[] }, body: CalV2PreconditionFailedBody, keepMine: ReadonlySet<string>): { etag: string; ops: CalV2Op[]; base: Record<string, string> };
```

`AlarmForm` e `AddressForm` sono tipi dell'agente ADMIN. Un VALARM o un ATTENDEE non modificato si rimanda identico (stesso JSON); se nessun promemoria è cambiato non si manda l'op `alarms`.

### 6.3 Editor a tab (`apps/admin/src/pages/calendario/evento/`)

`evento-editor.tsx` (modale con `components/ui/tabs`): carica la vista con `getObjectV2(id, { originalStart })` per un'occorrenza della lista v1 (o con la chiave dell'override), tiene `initial` e `draft`, salva con `buildPatch`. Flusso di salvataggio:
1. serie e op non vuoti → `ScopeDialog` con `allowedScopes` (aperto dal master: scope `all` senza chiedere);
2. `patchObjectV2` (o `createObjectV2` per un evento nuovo, con l'UID generato all'apertura e i campi del form);
3. 412 → `ConflictDialog`; 409 `RECURRENCE_TARGET_GONE`/404 → messaggio e ricarica; 503 → toast, il form resta com'è; 400 → errori di `details.issues` accanto ai campi.

Anteprima: `dryRun` con debounce di 500 ms quando cambiano tempi o ricorrenza (riepilogo, prossime occorrenze, `orphaned_overrides`, issues). `readonly_reason` → tutti i controlli disabilitati con il motivo in testa; `notices` come avvisi.

| Tab | Campi | Note |
|---|---|---|
| `tab-generale.tsx` | summary, location, description, url, calendario, status, transp ("Mostra come": occupato, libero, predefinito = assente), class, categories, color, priority | Calendario: in creazione select; in modifica cambia solo con scope `all` (`move_to_calendar_id`), disabilitato su un'istanza |
| `tab-tempo.tsx` | all-day, start, end o duration (si conserva la forma che l'evento ha), TZID con `tz-select` | Default TZID = fuso del calendario; "Fluttuante" solo se l'evento lo è già |
| `tab-ricorrenza.tsx` | rrule (`recurrence-editor`: FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYSETPOS, fine mai/COUNT/UNTIL a fine giornata locale), exdates con "ripristina occorrenza", rdates (elenco, rimozione) | Una RRULE non rappresentabile dal form si mostra come testo modificabile; nascosta su un'istanza con scope `this` |
| `tab-promemoria.tsx` | alarms (`alarms-editor`: DISPLAY, EMAIL, AUDIO; relativo a inizio o fine, assoluto) | Badge "Promemoria predefinito del dispositivo" per `apple_default`; proprietà sconosciute conservate da `alarmFromForm` |
| `tab-partecipanti.tsx` | organizer, attendees (`attendees-editor`: email, nome, ruolo, stato, RSVP) | Avviso fisso: "Radicale non invia inviti: gli invitati non ricevono nulla in automatico" |
| `tab-avanzate.tsx` | `extra_properties` (aggiungi, modifica, rimuovi X-*; CONFERENCE, ATTACH URI, RELATED-TO) | In sola lettura: UID, SEQUENCE, DTSTAMP, CREATED, LAST-MODIFIED, RECURRENCE-ID, salute, provenienza, ICS grezzo (copia, scarica da `objectIcsUrl`) |

### 6.4 Componenti (`apps/admin/src/components/calendar/`)

```ts
// scope-dialog.tsx
export interface ScopeDialogProps {
  open: boolean;
  action: 'edit' | 'delete';
  allowed: CalV2Scope[];
  onChoose: (scope: CalV2Scope) => void;
  onCancel: () => void;
}
// Etichette: "Solo questo evento", "Questo e tutti i successivi", "Tutti gli eventi della serie".

// conflict-dialog.tsx
export interface ConflictDialogProps {
  open: boolean;
  body: CalV2PreconditionFailedBody;
  pendingOps: CalV2Op[];
  /** Campi per cui rimandare il proprio valore; gli altri prendono quello del server. */
  onResolve: (keepMine: Set<string>) => void;
  /** Scarta le proprie modifiche e apre la versione del server. */
  onReload: () => void;
  onCancel: () => void;
}
```

`ConflictDialog` mostra per ogni conflitto l'etichetta italiana del campo, "Il tuo valore" e "Valore attuale" formattati (orari nel fuso dell'evento, numero e dettaglio dei promemoria, elenco degli invitati), con la scelta per campo; senza `conflicts` (DELETE o base assente) offre "Ricarica" e "Applica comunque" (nuovo invio con `current.etag`). La risoluzione usa `rebaseAfterConflict`; un nuovo 412 riapre il dialogo.

`recurrence-editor.tsx`, `alarms-editor.tsx`, `attendees-editor.tsx`, `tz-select.tsx` (fusi da `Intl.supportedValuesOf('timeZone')`, più il TZID corrente se non è IANA) sono controlli puri con `value`/`onChange` sui tipi del §4.

## 7. Divisione della tranche B fra i due agenti

Nessun file in comune. I DTO del §4 sono dell'agente API, che li scrive come primo passo; l'agente ADMIN li importa da `@calicchia/shared` e, se servono cambi, li chiede all'agente API (con l'aggiornamento di questo contratto).

| Agente | File |
|---|---|
| **API** | `packages/shared/src/calendar-v2.ts` (nuovo), `packages/shared/src/index.ts` (una riga), `packages/shared/package.json` (voce `exports`); `packages/calendar-core/src/rrule-summary.ts` (nuovo), `packages/calendar-core/src/index.ts` (una riga), `packages/calendar-core/package.json` (voce `exports`), `packages/calendar-core/test/rrule-summary.test.ts`, `packages/calendar-core/test/fixtures/davx5-android.ics` (nuovo); `apps/api/src/lib/calendar/v2/{capabilities,errors,view,series,objects}.ts` (nuovi); `apps/api/src/lib/calendar/radicale/store.ts` (solo il §5.7); `apps/api/src/routes/calendar/admin-v2.ts` (nuovo); `apps/api/src/app.ts` (una riga); `apps/api/test/calendar/{admin-v2-view,admin-v2-series,admin-v2-routes}.test.ts`; `apps/api/test/integration/admin-v2-radicale.test.ts` |
| **ADMIN** | `apps/admin/src/lib/{calendar-v2-api,calendar-v2-model}.ts` (nuovi); `apps/admin/src/pages/calendario/evento/{evento-editor,tab-generale,tab-tempo,tab-ricorrenza,tab-promemoria,tab-partecipanti,tab-avanzate}.tsx` (nuovi); `apps/admin/src/components/calendar/{scope-dialog,conflict-dialog,recurrence-editor,alarms-editor,attendees-editor,tz-select}.tsx` (nuovi); `apps/admin/src/pages/calendario.tsx` (solo il §6.1); `apps/admin/src/lib/i18n-dictionary.ts` (solo voci nuove, se servono) |

Nessuno dei due tocca: `routes/calendar/admin.ts` (v1), `evento-edit.tsx`, `lib/recurrence-form.ts`, `lib/api.ts`, `vite.config.ts`, i Dockerfile, i `package.json` delle app, il lockfile, la CI, `cron/*`, `index.ts` dell'API, le migrazioni, i contratti precedenti né questo contratto (le questioni vanno nel report).

## 8. Test e verifica della tranche B

Mirati, con le suite complete lasciate alla CI.

- **API**
  - `rrule-summary.test.ts`: DAILY, WEEKLY con più BYDAY, MONTHLY per BYMONTHDAY e per BYDAY+BYSETPOS, YEARLY, INTERVAL, COUNT, UNTIL DATE e UTC, fallback.
  - `admin-v2-view.test.ts`: viste dalle fixture Apple, Google, Thunderbird, Outlook e DAVx5; stabilità dei token; decodifica dei VALARM; `extra_properties` con le X-*; campi in sola lettura; test di tipo del §4.
  - `admin-v2-series.test.ts`: scope `this` (materializzazione, divieto dei campi di serie), `all` da master e da istanza (Δ, durata, propagazione agli override non personalizzati), `conflictingKeys` (disgiunti → nessun conflitto, valore già uguale → nessun conflitto), `planScopedDelete` e `planThisAndFuture` (prima istanza = intera serie).
  - `admin-v2-routes.test.ts`: 401 senza JWT; 403 e 415 della difesa CSRF; mode postgres → capacità `read: false` e 409 `STORE_MODE_UNSUPPORTED` su tutte le route `objects`; 428; 400 `SCOPE_INVALID`; `set_property` su un nome riservato → 400.
  - `integration/admin-v2-radicale.test.ts` (Radicale reale), il criterio di uscita in piccolo:
    - per ogni fixture una PATCH di `summary` cambia nel testo solo SUMMARY, DTSTAMP e LAST-MODIFIED; VALARM, ATTENDEE e X-* restano identici;
    - PUT concorrente di un "device" → 412 con `current` aggiornato e `conflicts`; con campi disgiunti → `merged: true`;
    - nuovo invio della propria modifica riuscita → `noop`;
    - i tre scope in modifica e in eliminazione;
    - `dryRun` non cambia l'ETag;
    - creazione 201 con `ETag`, poi 409 `OBJECT_EXISTS` con lo stesso UID;
    - 403 per prenotazione attiva e iscrizione;
    - 503 con `write_freeze`.
  - Comandi: `pnpm --filter @calicchia/calendar-core exec tsx --test test/rrule-summary.test.ts`, `pnpm --filter @calicchia/api exec tsx test/run.ts test/calendar/admin-v2-*.test.ts`, l'integrazione con lo stesso runner, poi `typecheck` di calendar-core e API.
- **ADMIN**: `pnpm --filter @calicchia/admin build` (tsc + vite) e `lint`. Prova manuale o headless facoltativa; gli e2e sono della tranche C.
- **Uscita della tranche B:** test sopra verdi; contratti v1/F0 verdi in CI; in mode postgres l'admin identico (stesso editor, nessuna chiamata v2 oltre alle capacità); in staging, un evento creato da iPhone e modificato dall'editor v2 conserva VALARM, ATTENDEE e X-*, e una modifica concorrente da un device si risolve dal `ConflictDialog`.

## 9. Tranche C (vincolante dalla v1.1)

Questa sezione vincola la tranche C come il §3-§8 vincolano la tranche B: stesse regole su firme, proprietari e "DEVE/PUÒ". Tutto ciò che il §0, il §2 e il §3 dicono della tranche B vale anche per le route nuove (montaggio, JWT, `sameOriginWrites`, errori `CalV2ErrorBody`, `STORE_MODE_UNSUPPORTED` con store postgres, gate `cal-write` e 503, lossless, nessun testo di evento in log e `audit_logs`), salvo dove il §9 dice altro.

### 9.0 Decisioni dell'orchestratore (prese all'avvio della tranche C)

1. **calendar-core resta sul server** (§9.4): nessuna modifica a `apps/admin/vite.config.ts`, `apps/admin/Dockerfile` né alle dipendenze dell'admin per calendar-core.
2. **Niente refactor della vista** (FullCalendar 6.1.21, `@fullcalendar/luxon3`, `luxon`, `pages/calendario/vista/*`): rinviato (§12.5). La vista resta `calendario.tsx` con le dipendenze attuali. Si aggiungono `GET /occurrences` e `GET /overlays`; l'admin li usa **solo** con `caps.occurrences` (che implica `objects.read`): badge orfani, quarantena, hold, conservativo, nuovo dal dispositivo; drag fra calendari = `POST /objects/:id/move`. In mode postgres (o con capacità illeggibili) la vista resta identica a oggi, su `/events` v1, senza nessuna chiamata v2 oltre alle capacità.
3. **Correzione del rilievo noto della tranche B** (passo A1): `EventEditorHost` non restituisce più `null` mentre le capacità si caricano, e `v2Fetch` ha un timeout di 5 s con `AbortController`. Finché le capacità non sono note, o se falliscono o scadono, si apre l'editor v1 (regola del §2).
4. **Widget agenda e sovrapposizioni senza troncamento:** finestra temporale invece di un limite di righe, con "mostra altri" esplicito (passi C3 e A3).
5. **E2E Playwright** in `apps/admin/e2e` con `apps/admin/playwright.config.ts` e un job CI dedicato (§9.3). Solo il passo E2E PUÒ modificare `apps/admin/package.json`, `pnpm-lock.yaml` e `.github/workflows/ci.yml`.
6. **Nessuna migrazione:** lo schema basta. `cal_object_versions` e `cal_object_ids.retired_at` (163) servono a cronologia e cestino; `cal_jobs` (164, `kind` libero) ai job `calendar_import`, `calendar_hold_apply`, `calendar_hold_rebuild`; `calendars.sort_order`, `needs_review` e `review_reason` (071, 162) a ordine e badge "nuovo dal dispositivo"; l'idempotenza usa `cal_jobs (kind, key)`. Se un passo scopre che una migrazione serve davvero, prende il numero 168 e lo scrive nel report con il motivo; nessun altro passo ne crea.
7. **Nessuna variabile d'ambiente, cron o dipendenza nuova dell'API.** I job nuovi si registrano in `apps/api/src/cron/calendar-radicale.ts` accanto agli altri (una riga per registrazione).

### 9.1 Route

#### 9.1.1 Regole comuni

- Tutte le route nuove stanno nel router `calendarAdminV2` (`routes/calendar/admin-v2.ts`) o in sotto-router montati da quel file con `calendarAdminV2.route('/', sub)` **dopo** i middleware esistenti (401, `sameOriginWrites`, `bodyLimit`), così li ereditano. Nessuna modifica a `app.ts`.
- `bodyLimit`: resta 2 MB, tranne `POST /calendars/:id/import` che ha 10 MB (il middleware globale salta quel percorso e la route applica il proprio limite). Superato → 413 `PAYLOAD_TOO_LARGE` (il passo C2 cambia anche il codice del limite globale).
- **Idempotency-Key** (solo header, mai nel corpo, `^[A-Za-z0-9_-]{8,200}$`): obbligatoria per i `commit` di import e azioni di hold (400 `IDEMPOTENCY_KEY_REQUIRED`). La chiave del job è `<calendar_id>:<Idempotency-Key>`; il payload del job porta `request_hash` (sha256 del corpo canonico). Stessa chiave e stesso hash → 202 con lo stesso `job_id` (`created: false`), qualunque sia lo stato del job; stessa chiave e hash diverso → 409 `IDEMPOTENCY_CONFLICT`.
- **Conferma digitata** (azioni di hold): `confirm` uguale a `CAL_V2_HOLD_CONFIRMATIONS[azione]` (confronto esatto, come `confirmationMatches` della migrazione), altrimenti 400 `CONFIRMATION_REQUIRED`.
- **Piano e hash:** import e azioni di hold hanno un `dry_run` che restituisce il piano con `plan_hash`; il `commit` ricalcola il piano e, se l'hash differisce, risponde 409 `PLAN_CHANGED` con `details.plan` (il piano nuovo). Il job ricalcola ogni voce prima di scriverla (una voce cambiata nel frattempo va in `failed`, non si sovrascrive).
- **Scritture:** tutte dal gate `cal-write` e con le precondizioni HTTP (`If-Match` esatto sulle risorse esistenti, `If-None-Match: *` sulle nuove), write-through e audit come il §3.1. `dryRun` come il §3.5 (nessun gate, nessuna PUT, nessun audit).
- **Audit** (`audit()` dello store, `table_name 'cal_objects'` o `'calendars'`), operazioni: `v2.raw`, `v2.move`, `v2.duplicate`, `v2.restore`, `v2.trash_restore`, `v2.import` (una riga per oggetto scritto, più una riga `v2.import.job` a fine job con i conteggi), `v2.calendar.create`, `v2.calendar.update`, `v2.calendar.delete`, `v2.calendar.order`, `v2.calendar.rotate_token`, `v2.hold.apply`, `v2.hold.rebuild`. Dettagli solo strutturali (collezione, href, ETag, nomi dei campi, conteggi, id di versione e di job).
- **Job:** `cal_jobs` con `kind` in `CAL_V2_JOB_KINDS`, priorità normale, `max_attempts` 3, avanzamento in `result.progress` aggiornato al più ogni 2 s sotto lease. A fine lavoro (done o dead) il testo ICS nel payload si elimina (`payload - 'ics'`): nessun testo di evento resta in `cal_jobs`.

#### 9.1.2 Oggetti (passo C1)

| Metodo e percorso | Corpo / query | Risposta |
|---|---|---|
| `PUT /objects/:id/ics` | `CalV2RawPutRequest`, `If-Match` esatto (428 senza) | 200 `CalV2WriteResult` + `ETag` |
| `POST /objects/:id/move` | `CalV2MoveRequest`, `If-Match` esatto | 200 `CalV2WriteResult` (`object` nel calendario di destinazione) |
| `POST /objects/:id/duplicate` | `CalV2DuplicateRequest` | 201 `CalV2WriteResult` + `ETag` + `Location`; dryRun 200 con `object.id = ''` |
| `GET /objects/:id/export.ics` | | 200 `text/calendar; charset=utf-8`, `Content-Disposition: attachment; filename="<uid>.ics"`, `ETag` |

- **Editor raw.** Il testo si valida per intero: parse di calendar-core, un solo UID uguale a quello corrente (altrimenti 400 `VALIDATION_FAILED`, `property: UID`), solo VEVENT (VTODO e VJOURNAL → 403 `READ_ONLY` `component_unsupported`), ≤ 1 MB, limiti strutturali di calendar-core, `validateObject` con `previous`. Si scrive il testo così com'è dopo la sola normalizzazione dei fine riga in CRLF: nessun aggiornamento automatico di DTSTAMP, LAST-MODIFIED o SEQUENCE (lo fa l'utente; un avviso `CalV2Issue` `sequence_not_bumped` severity warning se tempi o ricorrenza cambiano senza SEQUENCE+1). Nessuna fusione per campi: ETag diverso → 412 con `current` e `conflicts: []`. `changed: ['raw']`. Le guardie del §3.9 valgono (sola lettura, prenotazione attiva per un testo che cambia i tempi: `booking_projection` è solo una nota). Oggetto illeggibile (`unreadable`): il raw PUT è ammesso (è il modo di ripararlo) se il testo nuovo è valido.
- **Sposta.** Stessa logica e stesse guardie di `move_to_calendar_id` (§3.5): destinazione attiva, non `subscription`, non archivio, con VEVENT; MOVE con `Overwrite: F`; href o UID presenti → 409 `MOVE_CONFLICT`. Stesso calendario → 200 `noop`. L'id resta quello (ids.ts riconosce la MOVE). `changed: ['calendar_id']`.
- **Duplica.** Copia del componente target (pre-immagine per un'istanza) come oggetto nuovo: UID del corpo (stesse regole di `POST /objects`) o generato; senza RECURRENCE-ID; senza RRULE, RDATE, EXDATE né override, salvo `keep_recurrence: true` con `recurrence_key: ''` (allora si copiano tutti). Inizio = `start` o quello dell'occorrenza, durata e tipo (all-day/timed, TZID) conservati. VALARM, ATTENDEE, ORGANIZER e X-* si copiano, tranne le proprietà di provenienza e di proiezione (`X-CALDES-*`), che il server riscrive come per `createEvent` con source `admin`. SEQUENCE 0, DTSTAMP/CREATED/LAST-MODIFIED nuovi. Calendario: `calendar_id` o quello dell'originale (se non scrivibile → 403 `READ_ONLY`). Esistente → 409 `OBJECT_EXISTS` con `details.object_id`.
- **Export.** Il testo corrente dell'oggetto (da Radicale; fallback indice come il §3.3), identico a `GET /objects/:id/ics` tranne l'header `attachment`.

#### 9.1.3 Cronologia e cestino (passo C1)

| Metodo e percorso | Corpo / query | Risposta |
|---|---|---|
| `GET /objects/:id/versions` | | 200 `CalV2VersionList` |
| `GET /objects/:id/versions/:versionId` | | 200 `CalV2VersionDetail`; versione di un altro oggetto → 404 |
| `POST /objects/:id/restore` | `CalV2RestoreRequest`, `If-Match` esatto | 200 `CalV2WriteResult` + `ETag` |
| `GET /trash` | `?calendar_id=&before=&limit=` | 200 `CalV2TrashList` |
| `POST /trash/:objectId/restore` | `CalV2TrashRestoreRequest` | 201 `CalV2WriteResult` + `ETag` + `Location`; dryRun 200 |

- `:id` delle versioni è risolto con `resolveEventRef` (§3.2) e usa sempre la riga della risorsa (`recurrence_key ''`), la stessa a cui punta `cal_object_versions.object_id`. Conservazione: quella di `purgeExpiredVersions` (90 giorni), esposta in `retention_days`.
- `changed_fields`: confronto dei campi tipizzati e delle proprietà non tipizzate del master (e del numero di override) con la versione precedente nella lista; versione non valida → `[]`.
- **Ripristino di una versione** sull'oggetto vivo: la versione DEVE essere dell'oggetto, valida e non scaduta (altrimenti 409 `VERSION_NOT_RESTORABLE` con `details.reason`: `invalid`, `expired`, `other_object`). Si scrive il testo della versione con `If-Match` dell'ETag corrente (diverso da `If-Match` → 412 con `current` e `conflicts: []`), aggiornando DTSTAMP e LAST-MODIFIED e portando SEQUENCE a max(corrente, versione) + 1 (i device accettano la modifica). Il risultato crea una versione nuova (`change_kind 'restore'`, actor `admin:<id>`), come ogni scrittura.
- **Cestino:** oggetti con la riga `cal_object_ids` (`recurrence_key ''`) ritirata (`retired_at` non nullo), una versione `delete` e almeno una versione non scaduta. `restorable` falso con il motivo: `uid_exists` (lo stesso UID è attivo in un calendario), `calendar_gone` (il calendario non esiste più e il corpo non ne indica un altro), `calendar_readonly` (iscrizione o archivio), `no_valid_version`, `expired`. Elenco ordinato per `deleted_at` decrescente, paginato con cursore opaco; filtro facoltativo per calendario.
- **Ripristino dal cestino:** PUT con `If-None-Match: *` del testo della versione (default `restore_version_id`), con DTSTAMP e LAST-MODIFIED nuovi e SEQUENCE+1, sullo stesso href nel calendario originale (la riga ritirata torna attiva: **stesso id**) o nel `calendar_id` indicato (riconosciuto come MOVE da ids.ts entro 30 giorni; oltre, l'id può essere nuovo e la risposta porta quello vero). href occupato o motivo di non ripristinabilità → 409 `NOT_RESTORABLE` con `details.reason`.

#### 9.1.4 Calendari, import ed export (passo C2)

| Metodo e percorso | Corpo / query | Risposta |
|---|---|---|
| `GET /calendars` | | 200 `CalV2CalendarList` |
| `POST /calendars` | `CalV2CalendarCreateRequest` | 201 `CalV2CalendarView` |
| `PATCH /calendars/:id` | `CalV2CalendarPatchRequest` | 200 `CalV2CalendarView` |
| `PUT /calendars/order` | `CalV2CalendarOrderRequest` | 200 `CalV2CalendarList` |
| `DELETE /calendars/:id` | `?with_objects=1` | 200 `{ deleted: true }`; non vuoto senza `with_objects` → 409 `CALENDAR_NOT_EMPTY` (`details.object_count`) |
| `POST /calendars/:id/rotate-token` | `{}` | 200 `CalV2CalendarView` (nuovo `feed_url`) |
| `GET /calendars/:id/export.ics` | | 200 `text/calendar`, `attachment; filename="<slug>.ics"` |
| `POST /calendars/:id/import` | `CalV2ImportRequest` (+ `Idempotency-Key` con `commit`) | dry_run 200 `CalV2ImportPlan`; commit 202 `CalV2JobAccepted` |
| `GET /jobs/:jobId` | | 200 `CalV2JobView`; tipo non in `CAL_V2_JOB_KINDS` → 404 |

- Le route dei calendari passano dai metodi dello store (`createCalendar` con la sola MKCALENDAR esplicita, `updateCalendar` con PROPPATCH e sidecar, `deleteCalendar`, `rotateFeedToken`): nessuna MKCOL implicita. Calendari di sistema, predefinito, `bookings` e `holidays` non si eliminano (403 `READ_ONLY`, `details.reason: 'system'`); iscrizioni e archivio non si modificano se non per nome, colore e ordine (403 per il resto). `role` solo fra `CAL_V2_ASSIGNABLE_ROLES` e solo se il ruolo attuale è fra quelli (403 altrimenti). `needs_review: false` azzera anche `review_reason`.
- `PUT /calendars/order`: `ids` DEVE contenere ogni calendario esattamente una volta (400 altrimenti); `sort_order` = posizione, più PROPPATCH di `calendar-order` sulle collezioni visibili ai device (best effort: una PROPPATCH fallita non annulla l'ordine nel DB e compare nel log senza testo).
- **Export:** VCALENDAR con PRODID del sistema, un VTIMEZONE per TZID (deduplicati), ogni oggetto attivo dal testo di Radicale (fallback indice); in streaming.
- **Import:** METHOD rimosso; componenti raggruppati per UID (master e override insieme, VTIMEZONE allegati a chi li usa); ≤ 5000 gruppi; solo VEVENT (VTODO e VJOURNAL → `invalid`, `component_unsupported`); ogni gruppo validato con calendar-core. Azione per gruppo: UID nuovo → `create`; UID già nel calendario → `on_conflict` (`skip`, `replace` con `If-Match` dell'ETag corrente, `new_uid` con UID nuovo e `RELATED-TO` invariati); UID in un altro calendario → `skip` con `on_conflict: 'skip'`, altrimenti `new_uid` (motivo `uid_in_other_calendar`). Provenienza `admin` (design §5) sugli oggetti creati. Il job `calendar_import` scrive al più 20 PUT/s, aggiorna `progress` e termina con `CalV2ImportResult`; un errore su un oggetto va in `failed` e non ferma il job; 503 del gate → il job si riaccoda (attesa) senza contare come errore dell'oggetto.

#### 9.1.5 Salute (passo C3)

| Metodo e percorso | Corpo | Risposta |
|---|---|---|
| `GET /sync-state` | | 200 `CalV2SyncState` |
| `POST /collections/:id/apply-deletions` | `CalV2HoldActionRequest` (+ `Idempotency-Key` con `commit`) | dry_run 200 `CalV2HoldPlan`; commit 202 `CalV2JobAccepted` |
| `POST /collections/:id/rebuild-from-index` | come sopra | come sopra |

- `GET /sync-state` aggrega, senza scrivere: `readBackendStateCached`, `lastIdentityCheck`, heartbeat, `currentWatchMode`/`mountUntrusted`, `getIndexHealth`, `listCollectionHealth`, oggetti con `health ≠ 'ok'`, job `dead` del calendario, `cal_booking_conflicts` aperti, l'ultimo backup coordinato (`last_stack_backup`, come lo legge il preflight della migrazione; `stale` se assente o più vecchio di 12 ore). Elenchi completi.
- `:id` è il `calendar_id` della collezione. Collezione non in hold → 409 `NOT_IN_HOLD`.
- **Applica cancellazioni** (job `calendar_hold_apply`): `applyHeldDeletions(calendarId, { actor: 'admin:<id>', hrefs })`. Piano: una voce `remove_from_index` per href sospeso.
- **Ricostruisci dall'indice** (job `calendar_hold_rebuild`, design §16.3 scenario A): per ogni href sospeso con un'ultima versione valida non scaduta, PUT con `If-None-Match: *` del testo di quella versione (≤ 20 PUT/s; risorsa già presente → `skip` `present_in_radicale`); senza versione valida → `skip` `no_valid_version`. Poi sync completa della collezione; le cancellazioni sospese ricostruite escono da `pending_deletions` e l'hold cade se non ne restano (C3 PUÒ aggiungere a `radicale/sync.ts` la funzione che serve, solo come aggiunta).
- L'admin fa polling di `/sync-state` ogni 20 s e di `/jobs/:jobId` ogni 2 s.

#### 9.1.6 Vista (passo C3)

| Metodo e percorso | Query | Risposta |
|---|---|---|
| `GET /occurrences` | `from`, `to` (ISO), `calendar_id` ripetibile | 200 `CalV2OccurrenceList` |
| `GET /overlays` | `from`, `to` | 200 `CalV2OverlayList` |

- Finestra: `from < to` e `to − from ≤ CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS` (100 giorni), altrimenti 400. **Nessun troncamento per conteggio**: tutte le occorrenze che intersecano la finestra. Oltre l'orizzonte dell'indice le occorrenze si espandono al volo dai componenti indicizzati (stessa espansione dell'indicizzatore), così la risposta è completa per qualsiasi finestra valida.
- `/occurrences` senza `calendar_id`: tutti i calendari tranne `holidays` e `subscription` (quelli vanno in `/overlays`); con `calendar_id`: esattamente quelli. Archivio incluso con `readonly_reason: 'archive'`.
- Badge: `orphan` (kind `orphan_override`), `quarantined` (oggetto non `ok` o occorrenza `stale`), `hold` (collezione in hold), `conservative` (kind `conservative`), `new_from_device` (calendario con `needs_review`).
- **Parametri a finestra per le sovrapposizioni della vista e del widget** (additivi, retrocompatibili): `GET /api/project-tasks?due_from=YYYY-MM-DD&due_to=YYYY-MM-DD` (estremi inclusi, insieme a `limit`/`offset` e `count` già esistenti) e `GET /api/client-projects?overlap_from=&overlap_to=` (progetti con `start_date ≤ overlap_to` e `coalesce(target_end_date, start_date) ≥ overlap_from`). Senza i parametri nuovi il comportamento resta identico.

### 9.2 Admin

Regola generale: ogni elemento nuovo compare solo con il proprio flag di capacità (§9.7); capacità illeggibili → niente di nuovo (§2). Testi in italiano, stile dei componenti esistenti (`components/ui/*`, toast, react-query). Ogni scrittura v2 invalida le query key v1 di oggi (`admin-calendar-events`, `admin-calendars`, `admin-bookings`) e quelle v2 toccate.

#### 9.2.1 Client (`apps/admin/src/lib/calendar-v2-api.ts`, solo aggiunte)

```ts
/** A1: timeout di ogni richiesta v2 (AbortController, unito a init.signal). */
export const CAL_V2_FETCH_TIMEOUT_MS = 5_000;
// Timeout → CalV2ApiError('Il server del calendario non risponde', 0, 'TIMEOUT', null).
// calV2Keys si estende con: versions(id), trash(calendarId | null), calendars, job(jobId), syncState,
// occurrences(from, to, calendarIds), overlays(from, to).

// A1
export function putObjectIcsV2(id: string, etag: string, req: CalV2RawPutRequest): Promise<CalV2WriteResult>;
export function listVersionsV2(id: string): Promise<CalV2VersionList>;
export function getVersionV2(id: string, versionId: string): Promise<CalV2VersionDetail>;
export function restoreVersionV2(id: string, etag: string, req: CalV2RestoreRequest): Promise<CalV2WriteResult>;
export function listTrashV2(q?: { calendarId?: string; before?: string; limit?: number }): Promise<CalV2TrashList>;
export function restoreTrashV2(objectId: string, req: CalV2TrashRestoreRequest): Promise<CalV2WriteResult>;
export function objectExportUrl(id: string): string;
// A2
export function listCalendarsV2(): Promise<CalV2CalendarList>;
export function createCalendarV2(req: CalV2CalendarCreateRequest): Promise<CalV2CalendarView>;
export function patchCalendarV2(id: string, req: CalV2CalendarPatchRequest): Promise<CalV2CalendarView>;
export function reorderCalendarsV2(ids: string[]): Promise<CalV2CalendarList>;
export function deleteCalendarV2(id: string, opts?: { withObjects?: boolean }): Promise<{ deleted: true }>;
export function rotateCalendarTokenV2(id: string): Promise<CalV2CalendarView>;
export function calendarExportUrl(id: string): string;
export function importPreviewV2(calendarId: string, req: Omit<CalV2ImportRequest, 'mode' | 'plan_hash'>): Promise<CalV2ImportPlan>;
export function importCommitV2(calendarId: string, req: Omit<CalV2ImportRequest, 'mode'> & { plan_hash: string }, idempotencyKey: string): Promise<CalV2JobAccepted>;
export function getJobV2(jobId: string): Promise<CalV2JobView>;
export function getSyncStateV2(): Promise<CalV2SyncState>;
export function holdPreviewV2(calendarId: string, action: 'apply_deletions' | 'rebuild_from_index', hrefs?: string[]): Promise<CalV2HoldPlan>;
export function holdCommitV2(calendarId: string, action: 'apply_deletions' | 'rebuild_from_index', req: { confirm: string; plan_hash: string; hrefs?: string[] }, idempotencyKey: string): Promise<CalV2JobAccepted>;
// A3
export function listOccurrencesV2(q: { from: string; to: string; calendarIds?: string[] }): Promise<CalV2OccurrenceList>;
export function listOverlaysV2(q: { from: string; to: string }): Promise<CalV2OverlayList>;
export function moveObjectV2(id: string, etag: string, req: CalV2MoveRequest): Promise<CalV2WriteResult>;
export function duplicateObjectV2(id: string, req: CalV2DuplicateRequest): Promise<CalV2WriteResult>;
```

La `Idempotency-Key` si genera con `crypto.randomUUID()` all'apertura del dialogo (import, azione di hold) e resta la stessa per i nuovi tentativi dello stesso commit.

#### 9.2.2 Passo A1: correzione dell'host, editor raw, cronologia, cestino

- **`EventEditorHost` (`pages/calendario.tsx`):** la scelta dell'editor si fa all'apertura e non cambia finché il modale resta aperto: `caps?.objects.read === true` → v2; capacità in caricamento, fallite, scadute o `read: false` → v1 subito (mai `null`, mai un modale vuoto). `useCalendarV2Capabilities` resta con `retry: false` e ora eredita il timeout di `v2Fetch`.
- **Editor raw scrivibile** (`components/calendar/raw-ics-editor.tsx`, montato in `tab-avanzate.tsx` con `caps.raw_edit`): textarea monospaziata con il testo della vista, "Verifica" (`putObjectIcsV2` con `dryRun`, issues in elenco), "Salva" (stesso ETag della vista; 412 → messaggio con "Ricarica" e "Sovrascrivi" che rimanda con `current.etag`), avviso fisso che il testo si salva così com'è. Senza `raw_edit` resta la sola lettura della tranche B. Link "Esporta .ics" (`objectExportUrl`) con `caps.object_tools`.
- **Cronologia** (`components/calendar/history-drawer.tsx`, aperta dall'editor v2 con `caps.history`): elenco delle versioni (data, autore, tipo, campi cambiati, "corrente"), anteprima (`getVersionV2`: riepilogo della vista e ICS), "Ripristina" (dryRun, conferma, poi `restoreVersionV2` con l'ETag della vista corrente; 412 → ricarica e chiede di nuovo). Dopo il ripristino l'editor ricarica la vista.
- **Cestino** (`pages/calendario/cestino.tsx`, rotta `calendario/cestino`, tab in `calendar-tabs.tsx` visibile solo con `caps.trash`): elenco paginato ("mostra altri" con `next`), filtro per calendario, motivo di non ripristinabilità in chiaro, "Ripristina" (dialogo con il calendario di destinazione quando serve, dryRun e poi commit).

#### 9.2.3 Passo A2: calendari, import ed export, salute, backup

- **`pages/calendario/calendari.tsx` esteso** con `caps.calendar_properties` (senza il flag resta com'è oggi su v1): elenco da `listCalendarsV2` con ordine trascinabile (`@dnd-kit/sortable`, già dipendenza) → `reorderCalendarsV2`; modifica di nome, descrizione, colore, fuso (`tz-select`), ruolo assegnabile, `blocks_availability`, visibilità ai device, feed; URL CalDAV per i device con "copia"; `feed_url` con "rigenera" (`rotateCalendarTokenV2`, conferma); badge "Nuovo dal dispositivo" con "Segna come visto" (`needs_review: false`); salute della collezione (badge `stale`/`unsyncable`/`hold` con link alla pagina Salute); eliminazione con conferma e, se non vuoto, seconda conferma con il numero di oggetti (`withObjects`).
- **Import ed export** con `caps.import_export`: `components/calendar/import-dialog.tsx` (file `.ics` letto nel browser e inviato come JSON; scelta di `on_conflict`; anteprima `importPreviewV2` con conteggi e tabella completa degli oggetti, filtrabile, senza troncamento; "Importa" → `importCommitV2` → avanzamento con polling di `getJobV2` ogni 2 s → esito con l'elenco dei falliti); "Esporta" per calendario (`calendarExportUrl`).
- **Pagina Salute** (`pages/calendario/salute.tsx`, rotta `calendario/salute`, tab visibile solo con `caps.health_page`): modo, freeze, identità, heartbeat, canary, guardia post-ripristino, orizzonte, collezioni (con `dirty_since`, errori, cancellazioni sospese), oggetti in quarantena (link all'editor), job falliti, conflitti di prenotazione, ultimo backup coordinato. Per una collezione in hold: "Applica cancellazioni" e "Ricostruisci dall'indice", ciascuna con anteprima (`holdPreviewV2`, elenco completo), campo di conferma digitata (`CAL_V2_HOLD_CONFIRMATIONS`), commit e avanzamento del job. Polling di `getSyncStateV2` ogni 20 s.
- **Avviso della pagina Backup** (`pages/impostazioni.tsx`, solo `BackupCalendarNotice` e il suo contorno) in `mode ≠ postgres`: oltre al testo attuale, con `caps.health_page` mostra l'età dell'ultimo backup coordinato (`sync-state.backup`, avviso ambra se `stale`) e i link a "Salute del calendario" e, con `caps.trash`, al "Cestino" e al ripristino da versioni. In mode postgres nulla cambia.

#### 9.2.4 Passo A3: vista, widget agenda, sovrapposizioni

- **Vista con le occorrenze v2** (`pages/calendario.tsx`) solo con `caps.occurrences`: la sorgente degli eventi Caldes diventa `listOccurrencesV2` + `listOverlaysV2` sulla finestra visibile di FullCalendar (`datesSet`; le finestre oltre 100 giorni, come la vista anno se esistesse, si spezzano in più richieste); senza il flag la vista usa `/events` v1 esattamente come oggi. Stesse regole di colore, legenda, "coperta" delle festività (dalle overlay `holiday`/`closure`) e pannello laterale; l'editor si apre con `object_id` e `recurrence_key` (non più `original_start`). Badge sull'evento (icona e tooltip): orfano, in quarantena, collezione in hold, blocco conservativo, nuovo dal dispositivo; gli eventi con `readonly_reason` non sono trascinabili.
- **Drag & drop in modalità v2** (solo con `caps.occurrences` e `objects.write`): spostamento o ridimensionamento nel tempo → GET della vista, `patchObjectV2` di `start`/`end` con i token della vista (istanza di una serie → `ScopeDialog` con `allowedScopes`; 412 → `ConflictDialog`; errore → `revert()`); **drag fra calendari** = rilascio su una voce della legenda (`eventDragStop` con hit-test degli elementi `data-calendar-drop-id`) → conferma → `moveObjectV2` (solo serie intera o evento singolo); nel pannello laterale "Sposta in…" (`moveObjectV2`) e "Duplica" (`duplicateObjectV2`, con `caps.object_tools`, al posto della duplicazione v1).
- **Widget agenda** (`components/dashboard/widget-agenda.tsx`): finestra temporale esplicita (oggi, con "domani" e "prossimi 7 giorni" selezionabili), eventi da `/events` v1 (o `listOccurrencesV2` con `caps.occurrences`), task da `project-tasks?due_from&due_to`; nessun limite silenzioso: si mostrano i primi N elementi e un pulsante "Mostra altri (k)" con il conteggio vero (`count` dell'API o lunghezza dell'elenco), che carica le pagine successive.
- **Sovrapposizioni della vista** (task e progetti in `calendario.tsx`): caricate per la finestra visibile (`due_from/due_to`, `overlap_from/overlap_to`) e paginate fino al `count` reale invece di `limit=200`/`limit=50`; se il numero supera la soglia di sicurezza (1000 per tipo) la vista lo dice ("N task nella finestra: mostrati i primi 1000") invece di tacerlo. Il popover "+N altri" di `dayMaxEvents` resta (non è un troncamento).

#### 9.2.5 Selettori per gli e2e

Gli agenti ADMIN mettono questi `data-testid` (stabili, senza testo localizzato), così il passo E2E non modifica i componenti:

| Passo | `data-testid` |
|---|---|
| A1 | `cal-editor-v2` (radice del modale v2), `cal-tab-<generale\|tempo\|ricorrenza\|promemoria\|partecipanti\|avanzate>`, `cal-editor-save`, `cal-editor-delete`, `cal-scope-<this\|this_and_future\|all>`, `cal-conflict-dialog`, `cal-conflict-keep-<campo>`, `cal-conflict-resolve`, `cal-conflict-reload`, `cal-raw-editor`, `cal-raw-check`, `cal-raw-save`, `cal-history-open`, `cal-history-item`, `cal-history-restore`, `cal-trash-item`, `cal-trash-restore` |
| A2 | `cal-calendar-row`, `cal-calendar-edit`, `cal-calendar-review-ack`, `cal-import-open`, `cal-import-file`, `cal-import-preview`, `cal-import-commit`, `cal-import-status`, `cal-export-link`, `cal-health-collection`, `cal-hold-apply`, `cal-hold-rebuild`, `cal-hold-confirm-input`, `cal-hold-confirm`, `cal-backup-notice` |
| A3 | `cal-occ-badge-<orphan\|quarantined\|hold\|conservative\|new_from_device>`, `cal-legend-drop-<calendar_id>` (anche `data-calendar-drop-id`), `cal-panel-move`, `cal-panel-duplicate`, `cal-agenda-more`, `cal-overlay-more` |

L'editor v1 si riconosce per l'assenza di `cal-editor-v2` (il file v1 non cambia).

### 9.3 E2E (passo E2E, dopo i due flussi)

- File: `apps/admin/e2e/**` (spec, fixture ICS, `global-setup.ts`/`global-teardown.ts` o script di avvio dello stack), `apps/admin/playwright.config.ts`, `apps/admin/package.json` (devDependency `@playwright/test` **1.56.1** esatta, la versione dei browser preinstallati in `/opt/pw-browsers`; script `"e2e": "playwright test"`), `pnpm-lock.yaml`, `.github/workflows/ci.yml` (job `admin-e2e`), voci di `.gitignore` per `test-results/` e `playwright-report/`. Gli e2e non entrano in `tsc -b` dell'admin (il `tsconfig` dell'app include solo `src`).
- Stack: Postgres (servizio CI), migrazioni (`test:migrate`), Radicale 3.7.8 nel venv come il job `calendar-integration`, API avviata con mode `radicale` (stato impostato con gli helper di test dell'API), admin buildato servito con `vite preview` (il proxy `/api` è ereditato da `server.proxy`), sessione admin con `storageState`. In locale: `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` (o `launchOptions.executablePath` quando serve); in CI `pnpm --filter @calicchia/admin exec playwright install --with-deps chromium`. Un solo worker, `retries: 1` in CI, trace `on-first-retry`.
- Scenari (`apps/admin/e2e/calendar.spec.ts`, più file se serve): modifica "solo questa", "questa e successive", "tutta la serie"; elimina e ripristina dal cestino; ripristino di una versione dalla cronologia; all-day; fuso diverso; promemoria; invitati; editor raw (verifica e salva); import (anteprima, commit, avanzamento) ed export; 412 → `ConflictDialog` (modifica concorrente fatta con PUT diretta a Radicale); collezione in hold → "applica" e "ricostruisci"; badge in vista; drag fra calendari (MOVE); widget agenda con "mostra altri"; **regressione mode postgres** (stato `postgres`: editor v1, nessuna chiamata v2 oltre a `/capabilities`, verificato con `page.on('request')`); capacità lente (route di `/capabilities` ritardata oltre 5 s) → editor v1 subito.

### 9.4 calendar-core nel browser: deciso, resta sul server

Decisione della v1.1: l'admin **non** importa `@calicchia/calendar-core` nemmeno nella tranche C. L'anteprima dell'import è il `dry_run` del server, la validazione dell'editor raw è `PUT /objects/:id/ics` con `dryRun`, il riepilogo delle ricorrenze resta `preview.rrule_summary`. Nessuna modifica a `apps/admin/package.json` per calendar-core, a `vite.config.ts`, al Dockerfile dell'admin né al lockfile per questo motivo. Una validazione dal vivo nel browser, se mai servirà, è una fase futura con la misura del bundle (§12.6).

### 9.5 DTO della tranche C

Nel file `packages/shared/src/calendar-v2.ts`, sezione "Tranche C", scritta dall'architetto prima dei flussi e **non modificabile** dai flussi (una richiesta di cambio va nel report e passa da un aggiornamento di questo contratto). Il file è la fonte di verità delle forme; qui i nomi:

- capacità: `CalV2Capabilities.{raw_edit, object_tools, history, trash, import_export, calendar_properties, health_page, occurrences}`;
- oggetti: `CalV2RawPutRequest`, `CalV2MoveRequest`, `CalV2DuplicateRequest`;
- cronologia e cestino: `CAL_V2_VERSION_CHANGE_KINDS`, `CalV2VersionSummary`, `CalV2VersionList`, `CalV2VersionDetail`, `CalV2RestoreRequest`, `CAL_V2_TRASH_NOT_RESTORABLE_REASONS`, `CalV2TrashItem`, `CalV2TrashList`, `CalV2TrashRestoreRequest`;
- calendari: `CAL_V2_CALENDAR_ROLES`, `CAL_V2_ASSIGNABLE_ROLES`, `CAL_V2_COLLECTION_HEALTH`, `CalV2CalendarView`, `CalV2CalendarList`, `CalV2CalendarCreateRequest`, `CalV2CalendarPatchRequest`, `CalV2CalendarOrderRequest`;
- import e job: `CAL_V2_IMPORT_CONFLICT_MODES`, `CalV2ImportRequest`, `CalV2ImportPlanItem`, `CalV2ImportPlan`, `CAL_V2_JOB_KINDS`, `CalV2JobAccepted`, `CalV2ImportResult`, `CalV2HoldActionResult`, `CalV2JobView`;
- salute: `CalV2CollectionState`, `CalV2QuarantinedObject`, `CalV2SyncState`, `CAL_V2_HOLD_CONFIRMATIONS`, `CalV2HoldActionRequest`, `CalV2HoldPlanItem`, `CalV2HoldPlan`;
- vista: `CAL_V2_OCCURRENCE_KINDS`, `CAL_V2_OCCURRENCE_BADGES`, `CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS`, `CalV2Occurrence`, `CalV2OccurrenceList`, `CalV2OverlayItem`, `CalV2OverlayList`;
- codici: §9.8.

Le bozze di `CalV2VersionSummary`, `CalV2TrashItem`, `CalV2ImportPlan` e `CalV2Occurrence` della v1.0 sono sostituite da quelle del file.

### 9.6 Flussi, passi e file

Due flussi **paralleli fra loro**, ciascuno con tre passi **sequenziali**; nessun file in comune fra i flussi (dentro un flusso i passi successivi POSSONO toccare i file dei precedenti). Le dipendenze fra flussi sono solo di runtime e passano dai flag di capacità: un passo ADMIN può finire prima del passo API corrispondente, perché senza il flag non mostra nulla. Il passo **E2E** parte quando entrambi i flussi sono chiusi.

| Passo | File posseduti | Route | Flag acceso |
|---|---|---|---|
| **C1** | `apps/api/src/lib/calendar/v2/{raw,move,history}.ts` (nuovi); `v2/objects.ts`, `v2/errors.ts`, `v2/capabilities.ts`, `routes/calendar/admin-v2.ts` (aggiunte); `radicale/store.ts`, `radicale/versions.ts`, `radicale/ids.ts` (solo aggiunte, se servono); test `apps/api/test/calendar/admin-v2-c1.test.ts`, `apps/api/test/integration/admin-v2-c1-radicale.test.ts` | §9.1.2, §9.1.3 | `raw_edit`, `object_tools`, `history`, `trash` |
| **C2** | `v2/calendars.ts`, `v2/import-export.ts` (nuovi, con l'handler del job `calendar_import`); `routes/calendar/admin-v2.ts` (aggiunte, `bodyLimit` dell'import), `v2/capabilities.ts`, `v2/errors.ts`; `lib/calendar/jobs.ts` (voce in `CAL_JOB_KINDS`); `cron/calendar-radicale.ts` (una riga di registrazione); `radicale/store.ts` (solo aggiunte); test `admin-v2-c2.test.ts`, `integration/admin-v2-c2-radicale.test.ts` | §9.1.4 | `calendar_properties`, `import_export` |
| **C3** | `v2/sync-state.ts`, `v2/hold.ts` (con gli handler `calendar_hold_apply` e `calendar_hold_rebuild`), `v2/occurrences.ts` (nuovi); `routes/calendar/admin-v2.ts`, `v2/capabilities.ts`, `v2/errors.ts`, `lib/calendar/jobs.ts`, `cron/calendar-radicale.ts` (aggiunte); `radicale/sync.ts` (solo aggiunte); `routes/project-tasks.ts`, `routes/client-projects.ts` (solo i parametri a finestra); test `admin-v2-c3.test.ts`, `integration/admin-v2-c3-radicale.test.ts`, `apps/api/test/window-params.test.ts` | §9.1.5, §9.1.6 | `health_page`, `occurrences` |
| **A1** | `apps/admin/src/lib/calendar-v2-api.ts` (timeout e funzioni A1); `pages/calendario.tsx` (solo `EventEditorHost`); `pages/calendario/evento/{evento-editor,tab-avanzate}.tsx` e `components/calendar/{scope-dialog,conflict-dialog}.tsx` (cronologia, raw, `data-testid`); `components/calendar/{raw-ics-editor,history-drawer}.tsx`, `pages/calendario/cestino.tsx` (nuovi); `App.tsx` (rotta), `components/layout/calendar-tabs.tsx` (tab condizionale); `lib/i18n-dictionary.ts` (solo voci nuove) | — | — |
| **A2** | `lib/calendar-v2-api.ts` (funzioni A2); `pages/calendario/calendari.tsx`; `components/calendar/import-dialog.tsx`, `pages/calendario/salute.tsx` (nuovi); `pages/impostazioni.tsx` (solo l'avviso Backup); `App.tsx`, `calendar-tabs.tsx`, `i18n-dictionary.ts` (aggiunte) | — | — |
| **A3** | `lib/calendar-v2-api.ts` (funzioni A3); `pages/calendario.tsx` (vista, pannello, drag); `components/dashboard/widget-agenda.tsx`; componenti nuovi della vista in `components/calendar/` (es. `occurrence-badges.tsx`); `i18n-dictionary.ts` (aggiunte) | — | — |
| **E2E** | §9.3 | — | — |

Nessun passo tocca: questo contratto e i precedenti (le questioni vanno nel report), `packages/shared/src/calendar-v2.ts`, `routes/calendar/admin.ts` (v1), `evento-edit.tsx`, `lib/recurrence-form.ts`, `lib/api.ts`, `vite.config.ts`, i Dockerfile, `apps/api/package.json`, `apps/api/src/index.ts`, `app.ts`, le migrazioni; `apps/admin/package.json`, il lockfile e la CI solo nel passo E2E. `apps/api/src/lib/agent/.kb-metadata.json` non si committa mai.

### 9.7 Capacità della tranche C

| Flag | Passo | Vero quando |
|---|---|---|
| `raw_edit` | C1 | `objects.read` |
| `object_tools` | C1 | `objects.read` |
| `history` | C1 | `objects.read` |
| `trash` | C1 | `objects.read` |
| `calendar_properties` | C2 | `objects.read` |
| `import_export` | C2 | `objects.read` |
| `health_page` | C3 | `objects.read` |
| `occurrences` | C3 | `objects.read` |

Un flag dice che la funzione esiste ed è leggibile; scrivere richiede comunque `objects.write` (con `write: false` l'admin mostra i comandi di scrittura disabilitati con il motivo di `reasons`, e il server risponde 503 dal gate). Ogni passo aggiorna il test delle capacità di `admin-v2-routes.test.ts` (postgres: tutti false) e aggiunge l'asserzione "radicale: il proprio flag vero".

### 9.8 Codici nuovi

| Stato | `code` | Quando |
|---|---|---|
| 400 | `CONFIRMATION_REQUIRED` | conferma digitata assente o diversa (§9.1.1) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | `commit` senza `Idempotency-Key` valida, o chiave nel corpo |
| 409 | `IDEMPOTENCY_CONFLICT` | stessa chiave con una richiesta diversa |
| 409 | `PLAN_CHANGED` | `plan_hash` del commit diverso dal piano ricalcolato (`details.plan`) |
| 409 | `VERSION_NOT_RESTORABLE` | versione non valida, scaduta o di un altro oggetto |
| 409 | `NOT_RESTORABLE` | ripristino dal cestino impossibile (`details.reason` in `CAL_V2_TRASH_NOT_RESTORABLE_REASONS` o `href_taken`) |
| 409 | `CALENDAR_NOT_EMPTY` | `DELETE /calendars/:id` di un calendario con oggetti senza `with_objects=1` |
| 409 | `NOT_IN_HOLD` | azione di hold su una collezione non in hold |
| 413 | `PAYLOAD_TOO_LARGE` | corpo oltre il limite (2 MB, 10 MB per l'import); sostituisce il 413 `VALIDATION_FAILED` della tranche B |

`GET /jobs/:jobId`, versioni, cestino e calendari inesistenti → 404 `NOT_FOUND`. `CalV2ErrorStatus` dell'API si estende con 413.

### 9.9 Test e uscita della tranche C

Mirati, suite complete alla CI. Ogni passo API: unità con il runner (`pnpm --filter @calicchia/api exec tsx test/run.ts test/calendar/admin-v2-cN.test.ts`), integrazione con Radicale reale (stesso runner su `test/integration/admin-v2-cN-radicale.test.ts`, `RADICALE_BIN` del venv), `typecheck` e `typecheck:test`. Ogni passo ADMIN: `pnpm --filter @calicchia/admin build` e `lint`.

- **C1** — unità: 401, CSRF (403/415), mode postgres → 409 `STORE_MODE_UNSUPPORTED` su ogni route nuova, 428 su raw/move/restore senza `If-Match`, UID diverso nel raw → 400, VTODO nel raw → 403, flag. Integrazione: raw PUT lossless (byte per byte salvo CRLF) e 412 con device concorrente; dryRun non cambia l'ETag; move con stesso id e 409 `MOVE_CONFLICT`; duplicate di un'istanza (data dell'occorrenza, niente RRULE) e `keep_recurrence`; export identico a `/ics`; versioni dopo tre modifiche (`changed_fields`, `current`); restore con SEQUENCE+1 e nuova versione `restore`; delete → cestino → restore con **lo stesso id**; `uid_exists`; versione scaduta → 409.
- **C2** — unità: validazione dei corpi, ruoli non assegnabili → 403, ordine incompleto → 400, `CALENDAR_NOT_EMPTY`, import senza `Idempotency-Key` → 400, stessa chiave → stesso job, chiave con corpo diverso → 409, `PLAN_CHANGED`, 413 oltre 10 MB, `GET /jobs` di un tipo estraneo → 404. Integrazione: CRUD con PROPPATCH visibile via PROPFIND; ordine; rotate-token cambia il feed; export → import in un calendario vuoto con lo stesso numero di oggetti e VALARM/X-* conservati; `on_conflict` nelle tre modalità; job con progress e risultato; payload senza `ics` a fine job.
- **C3** — unità: finestra > 100 giorni → 400, badge calcolati (orfano, quarantena, hold, conservativo, nuovo dal dispositivo), esclusione di holidays/subscription da `/occurrences` e presenza in `/overlays`, conferma errata → 400, `NOT_IN_HOLD`; `window-params.test.ts`: `due_from/due_to` e `overlap_from/overlap_to` filtrano, senza parametri risposta invariata. Integrazione: occorrenze oltre l'orizzonte complete (serie giornaliera su 100 giorni: 100 occorrenze, nessun troncamento); cancellazione di massa da "device" → hold → dry_run → apply (indice ripulito, hold caduto); seconda volta → rebuild (risorse riscritte da versione, hold caduto, stessi id); `sync-state` coerente.
- **A1-A3** — build e lint verdi; in mode postgres nessuna chiamata v2 oltre a `/capabilities` (verificato poi dall'E2E).
- **E2E** — il job `admin-e2e` verde in CI con gli scenari del §9.3.
- **Uscita della tranche C:** tutto sopra verde; contratti v1/F0 verdi in CI; in mode postgres l'admin identico a oggi; in staging, con un iPhone e un Android collegati: modifica raw, ripristino dal cestino (il device rivede l'evento con lo stesso UID), import di un export di Google Calendar, hold provocato e risolto dalla pagina Salute.

## 10. Grafo delle chiamate (tranche B)

`routes/calendar/admin-v2.ts` → `v2/objects.ts` → (`v2/capabilities.ts`, `v2/view.ts`, `v2/series.ts`, `radicale/store.ts` primitive, `@calicchia/calendar-core`). `v2/view.ts` e `v2/series.ts` non importano lo store né il database. `v2/*` non importa `routes/*`. L'admin importa solo `@calicchia/shared` e i propri moduli.

Tranche C: `routes/calendar/admin-v2.ts` → `v2/{raw,move,history}.ts` (C1), `v2/{calendars,import-export}.ts` (C2), `v2/{sync-state,hold,occurrences}.ts` (C3) → (`v2/objects.ts`, `v2/view.ts`, `v2/capabilities.ts`, `radicale/{store,versions,ids,sync,health}.ts`, `lib/calendar/jobs.ts`, `@calicchia/calendar-core`). I moduli di un passo non importano quelli di un passo successivo; gli handler dei job stanno nei moduli del passo e si registrano da `cron/calendar-radicale.ts`.

## 11. Precisazioni rispetto al design

1. **412 invece di 409 per il CAS della v2.** Il design §8 passo 4 prevede 409 con `{field, base, theirs, yours}`; la v2 usa 412 `PRECONDITION_FAILED` con la versione completa del server (`current`) e `{field, theirs, yours}` (la base ce l'ha il client). v1 e MCP restano con la base implicita e il 409.
2. **Base come token opachi** per campo e per proprietà, calcolati sul componente target (pre-immagine per un'istanza), al posto dei valori: niente conversioni wire↔core nel confronto.
3. **calendar-core non va nel browser** né nella tranche B (§1) né nella C (§9.4, decisione della v1.1): il piano F6 attività 3 non si fa in questa fase. `describeRrule` sta in calendar-core.
4. **Sposta dentro la PATCH** (`move_to_calendar_id`) nella tranche B, per non perdere la funzione dell'editor v1; `POST /move` separata nella tranche C per il drag fra calendari.
5. **Archivio in sola lettura nella v2** (decisione 7). La nota del design §8 "nessuna nuova guardia di ruolo per l'API" resta vera per v1 e MCP.
6. **Propagazione dello scope `all` agli override non personalizzati** (§3.8), come i client Apple e Google: il design non la specificava.
7. **`GET /occurrences` solo nella tranche C e solo con `caps.occurrences`:** nella tranche B e in mode postgres la vista resta su `/events` v1 e il target si risolve con `original_start` (§3.2).
8. **Editor ICS raw in sola lettura nella tranche B** (visualizza, copia, scarica); `PUT /objects/:id/ics` nella tranche C, senza ritocchi automatici di DTSTAMP e SEQUENCE (§9.1.2).
9. **Niente refactor della vista nella F6** (§9.0.2): il design §11 e il piano F6 prevedevano FullCalendar con luxon, viste lista e anno in `pages/calendario/vista/*`; resta tutto in `calendario.tsx`, e il drag fra calendari si fa rilasciando sulla legenda invece che in una vista a risorse.
10. **Azioni di hold come job** (`calendar_hold_apply`, `calendar_hold_rebuild`) invece che sincrone: idempotenza con `cal_jobs (kind, key)` senza una tabella nuova, avanzamento visibile e throttling delle PUT.
11. **"Ricostruisci dall'indice" riscrive l'ultima versione valida** di ogni cancellazione sospesa con `If-None-Match: *` (design §16.3 scenario A parla di `If-Match`: per una risorsa sparita la precondizione corretta è `If-None-Match: *`).

## 12. Questioni aperte

1. **Proiezioni delle prenotazioni.** Nella v2 restano modificabili per parità (decisione 2), con la nota `booking_projection`; il job `project_booking` può riscrivere orario e titolo. Da valutare nella tranche C la sola lettura dei campi derivati da `calendar_bookings`.
2. **Propagazione dello scope `all`.** Da confermare in staging con iOS e macOS (stessa matrice della F3) che la regola del §3.8 coincida con quella dei client Apple sugli override.
3. **VTODO e VJOURNAL.** Solo lettura (`component_unsupported`) finché non si sceglie l'estensione VTODO (decisione 9, F7).
4. **Override senza master** (inviti a singole occorrenze, RFC 6638): ammessi solo con scope `this`; da verificare se un client li produce davvero in produzione.
5. **Refactor della vista** (FullCalendar 6.1.21 con `@fullcalendar/luxon3` e `luxon` 3.7.2, `timeZone="Europe/Rome"`, viste lista e anno, `pages/calendario/vista/*`, drag fra calendari in una vista a risorse): rinviato a dopo la F6 per decisione dell'orchestratore; richiederà le modifiche a `apps/admin/package.json` e al lockfile.
6. **calendar-core nel browser** (validazione dal vivo dell'editor raw e anteprima locale dell'import): solo se il `dryRun` del server si rivela lento in uso reale, con la misura del bundle e le modifiche elencate nella v1.0 del §9.4 (vite, Dockerfile, package.json, lockfile).
7. **Cestino delle istanze:** il cestino copre gli oggetti interi; un'istanza esclusa (EXDATE) si ripristina dalla cronologia dell'oggetto o dal tab Ricorrenza ("ripristina occorrenza"), non dal cestino.
