# Contratto dei moduli della F4

Versione 1.1 (integrazione: le aggiunte dei gruppi e le correzioni della prova generale sono nel §14). Vincola i quattro gruppi che implementano in parallelo la fase F4 del [piano](../piano.md) ("Cutover, rollback, proiezione inversa totale e prova generale in staging") dopo la fondazione: **CUTOVER**, **REVERSE**, **ROLLBACK**, **UI**. Riferimenti al [design](../design.md): §1 (invarianti 5-7), §4 (166), §5 (identità e provenienza), §8 (scritture, delete di un calendario), §9 (prenotazioni), §10 (condivisione invariata), §12 (contratti del sito e MCP), §13.1 e §13.9-§13.13 (macchina a stati, transizioni, cutover, proiezione inversa, rollback, finalize e wizard), §16.2-§16.3 (backup JSON, restore coordinato), §16.6 (rollback d'immagine); [decisioni](../decisioni.md) (requisiti espliciti: conferma del passaggio e rollback dall'admin, Postgres autorevole fino alla conferma, endpoint di condivisione e contratti invariati). Restano in vigore e prevalgono su questo documento, salvo le eccezioni dichiarate qui come aggiornamento: il [contratto del control-plane](control-plane.md) (policy, heartbeat, identità, permessi), il [contratto della F2](f2-modules.md) (facade, indice, job, lock, store) e il [contratto della F3](f3-modules.md) (strumento di migrazione, ledger, run, wizard).

"DEVE", "NON DEVE" e "PUÒ" hanno il significato normativo consueto. Le firme di questo documento sono quelle che gli altri gruppi importano: un gruppo PUÒ aggiungere funzioni ed esportazioni, NON DEVE cambiare nome, argomenti o semantica di quelle elencate senza aggiornare prima questo contratto. I tipi condivisi della F4 (passi, codici, parametri, riassunti, DTO) sono nella sezione "F4" di `apps/api/src/lib/calendar/migration/types.ts`, scritta dalla fondazione: è la fonte unica dei valori ammessi, allineata ai CHECK della migrazione 166 (test `migration-166.test.ts`).

## 0. Mappa dei file e proprietari

Ogni file ha un solo proprietario. Un gruppo che ha bisogno di un file diverso da come lo trova NON lo modifica: lo chiede al proprietario o lo segnala nelle questioni aperte del proprio report.

| Gruppo | File | Note |
|---|---|---|
| Fondazione (fatto) | `database/migrations/166_calendar_events_guard.sql`; `apps/api/src/lib/calendar/migration/transition.ts`; sezione F4 e codici F4 di `apps/api/src/lib/calendar/migration/types.ts` (con `CALENDAR_API_LEVEL = 4`); `apps/api/test/calendar/{migration-166,migration-transition}.test.ts`; `apps/api/test/integration/migration-transition.test.ts`; `apps/api/test/helpers/db.ts` (baseline e pulizia con la guardia 166); `apps/api/test/calendar/migration-165.test.ts` (due asserzioni adattate alla 166); questo contratto | Dopo la fondazione si cambiano solo con un aggiornamento di questo contratto |
| CUTOVER | `apps/api/src/lib/calendar/migration/{cutover,smoke}.ts`; `apps/api/src/lib/calendar/api-level.ts` (nuovo); `apps/api/src/lib/calendar/store.ts` (solo il controllo del livello, §3.4); `apps/api/src/lib/calendar/radicale/types.ts` e `radicale/policy.ts` (solo l'archivio in sola lettura, §3.5, con il contratto del control-plane §6.3 aggiornato nello stesso commit) | |
| REVERSE | `apps/api/src/lib/calendar/migration/reverse-projector.ts` | Unico scrittore di `calendar_events` fuori da mode postgres (con il GUC) e di `cal_migration_reverse_state` |
| ROLLBACK | `apps/api/src/lib/calendar/migration/{rollback,rebaseline,finalize}.ts`; `apps/api/src/routes/backup.ts` (mappatura della vista ed export v2, §5.5); `apps/api/src/lib/calendar/migration/{serialize,plan}.ts` (solo le righe derivate e `DERIVED_EDITED`, §5.6); in `types.ts` solo l'aggiunta di `LegacyDerivedSnapshot` all'unione `LegacySnapshot` | Le primitive del ledger restano di `apply.ts` (F3): ROLLBACK PUÒ aggiungervi funzioni (`rebaselineLedgerRow`, `untrackLedgerRow`), mai cambiare quelle esistenti |
| UI | `apps/api/src/routes/calendar/migration.ts`; `apps/api/src/lib/calendar/migration/runs.ts` (handler dei run F4, stato del wizard, `MIGRATION_PHASE`); in `types.ts` solo `MIGRATION_PHASE` (→ `'F4'`); `apps/admin/src/pages/calendario/migrazione.tsx`; `apps/admin/src/components/calendar/migration/*` (passo 6 e componenti nuovi); `apps/admin/src/lib/calendar-migration-api.ts`; ritocchi del §6.4: `apps/api/src/routes/calendar/admin.ts` (solo la route della saga), `apps/admin/src/pages/calendario.tsx`, `apps/admin/src/pages/calendario/evento-edit.tsx`, `apps/admin/src/lib/timezone.ts` | `apps/admin/package.json` solo se il §6.4 non si fa senza dipendenze nuove (preferito: senza) |
| Integrazione (dopo i gruppi) | `apps/api/src/cron/calendar-radicale.ts`, `apps/api/src/cron/index.ts`, CI, README dei test, `design.md`/`piano.md` se servono note | Collega le funzioni `register*`/`start*`/`run*` del §10 |

Nessun gruppo modifica `apps/api/package.json`, `pnpm-lock.yaml`, `.github/workflows/*`, `apps/api/src/cron/index.ts`, `apps/api/src/cron/calendar-radicale.ts`, `apps/api/src/index.ts` né `apps/api/src/app.ts`: ogni gruppo esporta funzioni e le elenca nel report (§10).

## 1. Perimetro e invarianti della F4

### 1.1 Postgres autorevole fino alla conferma

- Finché l'utente non esegue il cutover dal wizard con la conferma digitata (`PASSA A RADICALE`), `calendar_backend_state.mode` resta `postgres` e il comportamento è quello della F3: stessa facade (PgLegacyStore), stesso busy, stesse proiezioni legacy, stessi contratti F0 su entrambi gli store, nessuna differenza nuova in `allowed-diffs.json`.
- Cosa cambia in mode postgres con il deploy della F4 (tutto inerte): la guardia 166 su `calendar_events` (legge lo stato con `FOR SHARE` e lascia passare ogni scrittura), le due colonne `caldes_*` (ignorate dal codice legacy, che seleziona colonne esplicite: verificato nel test della 166), le tre tabelle nuove vuote, `CALENDAR_API_LEVEL = 4` (nessun effetto finché `api_min_version` è 0).
- Le route F4 esistono dal deploy, ma ogni azione che scrive richiede la conferma digitata, la chiave d'idempotenza e i criteri del §3.2.

### 1.2 Transizioni

Ogni cambio di `mode` (e di `epoch`) della F4 passa SOLO dalle funzioni di `transition.ts` (§2), dentro un run dello strumento (`cal-migration`):

1. prima lo stato (con il journal nella stessa transazione), poi la policy che ne deriva (`policyFromState()`, nessun riavvio la riporta a live);
2. gate `cal-write` esclusivo, preso dopo `cal-migration` (ordine `cal-migration → cal-write`, mai il contrario);
3. quiescenza dei device verificata (probe su `_canary` con 403, stat stabile);
4. ogni passo nel journal: un crash fa ripartire dal primo passo non concluso, con lo stato già scritto.

### 1.3 Condivisione e contratti invariati

- Feed ICS: stessi token (`calendars.ics_feed_token`), stesso toggle e rotazione; nessun modulo della F4 tocca `ics_feed_token`, `ics_feed_enabled` né `slug`. Gli UID pubblicati restano quelli legacy (feed dall'indice con `legacy_uid`, F2-F3) in ogni stato; dopo un rollback il feed legacy pubblica gli UID delle righe proiettate (§4.2: UID legacy riusati, sanificazione solo per i nuovi oggetti in conflitto).
- CalDAV: stesse collezioni (`dav.calicchia.design/federico/<slug>/`, `c` e `f` comprese), stesse app-password; il cutover cambia solo `epoch` (marker sul principal), mai i percorsi; le collezioni non si creano né si cancellano in nessuna transizione.
- `/api/calendar/*` del sito e i 22 tool MCP: stesse forme in ogni stato; durante una transizione le scritture rispondono con l'indisponibilità che esiste già (sito `503 {error, code: 'CALENDAR_UNAVAILABLE'}`, admin `503 {error, code}`, MCP ramo `{error}` senza codice).

### 1.4 Rollback senza perdita di semantica

Il busy legacy dopo il rollback coincide con quello di Radicale sull'orizzonte (design §13.11, verificato dall'anteprima, `busy_identical`); la rappresentazione persa (VALARM, ATTENDEE, X-*, RDATE come regola, fusi diversi da Roma) resta nel volume ed è quantificata per classe nell'anteprima; il rollback si annulla da solo se i degradi o gli oggetti dopo la quiescenza non sono quelli dell'anteprima confermata (salvo rollback di emergenza, §5.1).

### 1.5 Dati personali

Mai email, telefoni, messaggi, aziende né titoli o descrizioni delle proiezioni delle prenotazioni in `cal_migration_transitions.data`, `cal_migration_journal.data/error`, `cal_migration_reverse_state.degradations/error`, `cal_migration_items.detail`, nei riassunti dei run, nei log e nei messaggi d'errore. I titoli degli eventi non di prenotazione sono ammessi solo in `cal_migration_items.detail.summary` (come in F3).

## 2. Fondazione: transizioni (`migration/transition.ts`, migrazione 166)

### 2.1 Macchina a stati completa

```
                       cutover (run, PASSA A RADICALE)
  ┌──────────┐ freeze ┌──────────┐ epoch E→E+1 ┌──────────────────────┐ unfreeze ┌──────────────┐
  │ postgres │───────►│ cutover  │────────────►│ radicale, freeze on  │─────────►│ radicale     │
  │ shadow   │        │ frozen   │  (punto di  │ frozen               │          │ live         │
  └──────────┘        └──────────┘  non        └──────────────────────┘          └──────────────┘
       ▲  ▲ abort (verifica rossa,    ritorno)                                     │      │
       │  └─ conflitti, admin) ◄────────┘                                          │      │ finalize
       │                                                                           │      │ (CHIUDI LA
       │   epoch E'→E'+1  ┌──────────┐  freeze   rollback (run, TORNA A POSTGRES)  │      │  FINESTRA)
       └──────────────────│ rollback │◄─────────────────────────────────────────────┘      ▼
                          │ frozen   │──abort (anteprima cambiata, admin)──► radicale  ┌──────────┐
                          └──────────┘                                        live      │finalized │
                                                                                        │ live     │
                                                                                        └──────────┘
```

| mode | write_freeze | Facade (letture / scritture) | Policy dei device (derivata) | Proiezione inversa | Shadow mirror |
|---|---|---|---|---|---|
| `postgres` | — | PG / PG | shadow (sola lettura) | — | se `shadow_enabled` (patch dopo un rollback) |
| `cutover` | true | PG / 503 `transition` | frozen | — | — (i trigger della 165 sono inerti fuori da postgres) |
| `radicale` | true (passi 6-10 del cutover) | Radicale + indice / 503 `write_freeze` | frozen (`write_freeze`) | passata iniziale del cutover | — |
| `radicale` | false | Radicale + indice / Radicale | live | job per collezione finché `rollback_until > now()` | — |
| `rollback` | true | Radicale + indice / 503 `transition` | frozen | passata finale del rollback | — |
| `finalized` | false | Radicale + indice / Radicale | live | ferma | — |

Le condizioni di blocco del control-plane (§6.2: `restore_guard`, `rebuild_required`, identità) valgono in ogni riga. Fra la PROPPATCH del marker e la transazione del passo d'epoch il mismatch d'epoch tiene i device chiusi (`identity_mismatch`).

| Transizione | Passi nell'ordine (`types.ts`) | Annullabile | Esiti |
|---|---|---|---|
| cutover | `CUTOVER_STEPS`: preflight, freeze, quiesce, delta_apply, delta_verify, **epoch**, control_plane, index_sync, reverse_start, bookings_reconcile, unfreeze, smoke | fino a `delta_verify` compreso (`abort` → postgres) | `completed` (mode radicale, live), `aborted` (mode postgres, shadow) |
| rollback | `ROLLBACK_STEPS`: preflight, freeze, quiesce, index_sync, reverse_final, rebaseline, **epoch**, control_plane, cleanup | fino a `rebaseline` compreso (`abort` → radicale con il freeze di prima) | `completed` (mode postgres, shadow), `aborted` (mode radicale) |
| finalize | `FINALIZE_STEPS`: preflight, stop_reverse, state, legacy_finalize | no (nessun cambio di permessi) | `completed` (mode finalized) |

Una sola transizione attiva alla volta (`cal_migration_transitions_single_active`); mentre è attiva (anche ferma dopo un crash) ogni altra transizione riceve `409 TRANSITION_IN_PROGRESS` e i run F3 che scrivono sono già esclusi da `assertMigrationWritable()` (mode diverso da postgres) o, prima del freeze, dal lock `cal-migration`.

### 2.2 Migrazione 166

| Oggetto | Semantica |
|---|---|
| `calendar_events.caldes_object_id UUID NULL` | `cal_object_ids.id` (recurrence_key `''`) della risorsa Radicale da cui la riga deriva. Valorizzata dalla proiezione inversa su OGNI riga che scrive (master, override, derivate, proiezioni): una riga con `caldes_object_id` è "posseduta" dal proiettore. Senza FK |
| `calendar_events.caldes_derived BOOLEAN NOT NULL DEFAULT false` | Riga derivata per espansione (`SEMANTIC_EXPANDED`). `CHECK (NOT caldes_derived OR caldes_object_id IS NOT NULL)` |
| `calendar_events_guard()` + trigger `calendar_events_guard` (BEFORE INSERT/UPDATE/DELETE, riga) e `calendar_events_guard_truncate` (BEFORE TRUNCATE) | Fuori da mode `postgres` ogni scrittura fallisce con SQLSTATE **`CD166`**, salvo `current_setting('caldes.reverse_sync', true) = 'on'` e le DELETE in cascata di una riga padre già cancellata nella transazione (calendario, iscrizione, master). Vale anche in `finalized` (precisazione 1). Legge lo stato con `SELECT … FOR SHARE`: barriera delle transizioni (§2.4). Uno statement senza righe non fallisce |
| `cal_migration_transitions` | Una riga per transizione: `kind`, `status` (`active`, `completed`, `aborted`), `from_mode`, `target_mode`, `run_id` (senza FK), `epoch_before`, `epoch_after` (= `epoch_before + 1` dopo il passo d'epoch), `started_by`, `started_at`, `finished_at` (⇔ non attiva), `outcome_code`, `outcome`, `data` (oggetto senza dati personali) |
| `cal_migration_journal` | Una riga per passo: PK `(transition_id, step)`, `seq` unico nella transizione, `status` (`started`, `done`, `skipped`, `failed`), `attempts`, `run_id`, `data`, `error_code` ed `error` (solo `failed`), `started_at`, `finished_at` (⇔ non `started`). Cascata dalla transizione |
| `cal_migration_reverse_state` | Una riga per risorsa Radicale proiettata: PK `object_id` (id di `cal_object_ids`, senza FK: l'indice F2 non è referenziato da nessuna tabella), `calendar_id` (FK `calendars` ON DELETE CASCADE), `href`, `source_etag`, `source_sha256`, `status` (`projected`, `degraded`, `failed`, `removed`), `rows` (array di `ReverseRowRef`), `degradations` (array di `DegradationRecord`), `error_code`/`error` (⇔ `failed`), `attempts`, `horizon_until`, `projected_at` |

Le tabelle nuove sono del gruppo S del backup JSON (prefisso `cal_migration_`): esportate, mai ripristinate.

### 2.3 Firme

```ts
export class TransitionError extends MigrationError {
  constructor(code: MigrationErrorCode, message: string,
    opts?: { runErrorCode?: MigrationRunErrorCode; reasons?: PreconditionReason[]; details?: Record<string, unknown> });
}
/** SQLSTATE CD166 (anche nella catena di cause). */
export function isCalendarEventsGuardError(err: unknown): boolean;

export interface TransitionContext { readonly db: Db; readonly runId: string | null; readonly actor: string; readonly log: Logger; readonly signal?: AbortSignal; readonly now?: () => Date }
export function transitionContextFromRun(ctx: MigrationRunContext<unknown>): TransitionContext;
export interface TransitionRecord { id; kind: TransitionKind; status: TransitionStatus; from_mode: BackendMode; target_mode: BackendMode; run_id: string | null; epoch_before: number; epoch_after: number | null; started_by: string; started_at: Date; finished_at: Date | null; outcome_code: string | null; outcome: string | null; data: Record<string, unknown> }
export interface JournalStepRecord { transition_id; step; seq; status: JournalStepStatus; attempts; run_id: string | null; data: Record<string, unknown>; error_code: string | null; error: string | null; started_at: Date; finished_at: Date | null }
export interface TransitionHandle { readonly ctx: TransitionContext; record: TransitionRecord }

// Lettura e viste
export function stepsOf(kind: TransitionKind): readonly string[];
export function readTransitionState(db?: Db): Promise<MigrationBackendState>;             // senza cache
export function getActiveTransition(db?: Db): Promise<TransitionRecord | null>;
export function getTransition(db: Db, id: string): Promise<TransitionRecord | null>;
export function getLatestTransition(db?: Db, kind?: TransitionKind): Promise<TransitionRecord | null>;
export function readJournal(db: Db, transitionId: string): Promise<JournalStepRecord[]>;
export function nextPendingStep(kind: TransitionKind, journal: readonly JournalStepRecord[]): string | null;
export function pastPointOfNoReturn(journal: readonly JournalStepRecord[]): boolean;
export function buildTransitionView(record: TransitionRecord, journal: readonly JournalStepRecord[], opts: { runActive: boolean }): TransitionView;
export function readTransitionView(db?: Db, opts?: { runActive?: boolean }): Promise<TransitionView | null>;

// Apertura, journal, chiusura
export function beginTransition(opts: { ctx: TransitionContext; kind: TransitionKind; data?: Record<string, unknown>; resume?: boolean }): Promise<{ handle: TransitionHandle; resumed: boolean }>;
export function refreshTransition(handle: TransitionHandle): Promise<TransitionRecord>;
export function mergeTransitionData(handle: TransitionHandle, patch: Record<string, unknown>): Promise<void>;
export function completedStep(handle: TransitionHandle, step: string): Promise<JournalStepRecord | null>;
export function runStep<T extends Record<string, unknown>>(handle: TransitionHandle, step: string, fn: (info: { attempt: number }) => Promise<T>): Promise<T>;
export function skipStep(handle: TransitionHandle, step: string, reason: string): Promise<void>;
export function completeTransition(handle: TransitionHandle, opts?: { outcome?: string }): Promise<TransitionRecord>;
export function abortTransition(handle: TransitionHandle, opts: { code: MigrationRunErrorCode | string; reason: string }): Promise<Record<string, unknown>>;

// Passi di stato
export interface StateFieldUpdates { write_freeze?: boolean; rollback_until?: Date | null; cutover_at?: Date | null; cutover_by?: string | null; finalized_at?: Date | null; api_min_version?: number }
export function freezeStep(handle: TransitionHandle): Promise<Record<string, unknown>>;
export function stateStep(handle: TransitionHandle, step: string, opts: { expectMode: BackendMode; mode?: BackendMode; set?: StateFieldUpdates; data?: Record<string, unknown> }): Promise<Record<string, unknown>>;
export interface EpochDeps { client: RadicaleClient; principal: string; sleep?: (ms: number) => Promise<void> }
export function epochStep(handle: TransitionHandle, deps: EpochDeps, opts?: { set?: StateFieldUpdates }): Promise<Record<string, unknown>>;

// Gate e quiescenza
export function withTransitionGate<T>(fn: (info: { drained_ms: number }) => Promise<T>, opts?: { timeoutMs?: number }): Promise<{ result: T; drained_ms: number }>;
export interface QuiescenceDeps { probe: RadicaleClient | null; svc: RadicaleClient; principal: string; collections: () => Promise<string[]>; statSource: 'mount' | 'remote'; statCollection(name: string): Promise<bigint | null>; statPrincipal(): Promise<bigint | null>; syncControlPlane: (() => Promise<ControlPlaneTick | null>) | null; sleep(ms: number): Promise<void>; now(): Date; limits?: Partial<Record<'quiescencePolicyGraceMs' | 'quiescenceProbeAttempts' | 'quiescenceProbeIntervalMs' | 'quiescenceStatIntervalMs' | 'quiescenceStatMaxRounds', number>> }
export function defaultQuiescenceDeps(env?: NodeJS.ProcessEnv): QuiescenceDeps;
export function awaitDeviceQuiescence(deps: QuiescenceDeps, opts?: { expectPolicyMode?: 'frozen' | 'shadow'; signal?: AbortSignal; drainedMs?: number }): Promise<QuiescenceReport>;
export function quiesceStep(handle: TransitionHandle, deps?: QuiescenceDeps): Promise<QuiescenceReport>;

// Utilità e test
export function transitionNow(handle: TransitionHandle): Date;
export function journalViews(handle: TransitionHandle): Promise<JournalStepView[]>;
export interface TransitionTestHooks { beforeStep?(kind, step): void | Promise<void>; afterStep?(kind, step): void | Promise<void>; insideGate?(kind): void | Promise<void> }
export function setTransitionTestHooks(hooks: TransitionTestHooks | null): void;   // vietata in produzione
```

### 2.4 Semantica

**Apertura e ripresa** (`beginTransition`). Un'altra transizione attiva → `TRANSITION_IN_PROGRESS` (409, `details.transition`, run `TRANSITION_CONFLICT`). Quella dello stesso tipo → ripresa: `run_id` aggiornato, `resumed: true` (un run nuovo con `action: 'resume'` o lo stesso run dopo il lease scaduto). Nessuna con `resume` → `PRECONDITION_FAILED NO_ACTIVE_TRANSITION`. Nuova: mode di partenza di `TRANSITION_MODES[kind].from` (`MODE_NOT_POSTGRES`/`MODE_NOT_RADICALE`) e volume inizializzato (`IDENTITY_NOT_OK`), riga con `epoch_before` = epoch corrente. Non cambia lo stato.

**Journal** (`runStep`, `skipStep`). Passo già `done` o `skipped` → dati registrati, nessuna esecuzione. Altrimenti `started` (attempts + 1, `run_id`), esecuzione, `done` con i dati (JSON senza dati personali). Errore → `failed` con `error_code` (codice del run del `MigrationError`, `RADICALE_UNREACHABLE` per Radicale, `CALENDAR_UNAVAILABLE`, altrimenti `INTERNAL`) ed `error` (solo testi dei moduli; un errore grezzo diventa "Errore interno del passo: dettagli nei log del server"), poi l'errore si propaga e la ripresa ripete il passo. `runStep` NON DEVE cambiare lo stato del backend: per quello ci sono i passi di stato. Un passo il cui effetto non è idempotente (una PUT, una scrittura su PG) DEVE esserlo per costruzione (ledger con righe d'intento, upsert per id, GUC in una transazione con il proprio stato).

**Passi di stato.** `freezeStep`, `stateStep`, `epochStep` e `abortTransition` aprono una transazione con `SELECT … FROM calendar_backend_state FOR UPDATE` e la riga del journal: lo stato e `done` si scrivono insieme (una ripresa trova il passo concluso solo se lo stato è stato scritto). La `FOR UPDATE` è la barriera delle scritture legacy: attende le transazioni che hanno già scritto `calendar_events` (che tengono `FOR SHARE` dalla guardia 166); dopo il commit ogni nuova scrittura legacy legge il mode nuovo e fallisce con `CD166` (in REPEATABLE READ con `40001`). Dopo il commit: cache del modo e dell'identità invalidate (`invalidateBackendModeCache`, `invalidateIdentityCache`) e giro del control-plane (`requestControlPlaneSync`; il NOTIFY della 162 lo provoca comunque).

- `freezeStep`: mode intermedio (`cutover` o `rollback`) e `write_freeze = true`; lo stato deve essere quello di partenza (o già il mode intermedio) con `epoch = epoch_before`. Dati: `mode_before`, `write_freeze_before` (ripristinato da un annullamento), `mode_after`, `write_freeze_after`, `policy_version`.
- `stateStep`: aggiorna i soli campi di `StateFieldUpdates` nel mode atteso; il mode cambia solo nel finalize (`radicale → finalized`).
- `epochStep` (punto di non ritorno): riga `started` committata; lettura del marker come `caldes-svc` (`readVolumeMarkerRemote`): volume-id diverso, marker assente o epoch diverso da E ed E + 1 → `EPOCH_CONFLICT` senza toccare nulla; epoch E → PROPPATCH di E + 1 (errori transitori ritentati fino a `F4_LIMITS.epochRetryAttempts`, poi `RADICALE_UNREACHABLE` con lo stato ancora congelato); epoch E + 1 → già scritto (ripresa dopo un crash fra PROPPATCH e transazione). Poi la transazione: stato ancora nel mode intermedio con epoch E → mode d'arrivo, epoch E + 1 e i campi di `set`; `epoch_after` della transizione; journal `done` (dati: `epoch_before`, `epoch_after`, `mode`, `write_freeze`, `policy_version`, `marker: 'written' | 'already'`).
- `abortTransition`: solo prima del passo d'epoch concluso (`TRANSITION_NOT_ABORTABLE`); stato nel mode intermedio → mode di partenza (`TRANSITION_MODES[kind].abort_to`) con il `write_freeze` di prima del freeze; stato già nel mode di partenza → nulla da ripristinare; transizione `aborted` con `outcome_code` e `outcome`; passo `abort` nel journal. Idempotente.
- `completeTransition`: tutti i passi del tipo `done` o `skipped`, altrimenti `INTERNAL`.

**Gate** (`withTransitionGate`): `withExclusiveCalendarWriteGate` (f2 §6.1) con attesa `F4_LIMITS.exclusiveGateTimeoutMs`; non ottenuto → `CALENDAR_UNAVAILABLE` con run `GATE_TIMEOUT`. Chi entra nel gate condiviso dopo la richiesta dell'esclusivo attende e poi rilegge lo stato (già cambiato dal freeze) ricevendo `CalendarUnavailableError('transition' | 'write_freeze')`: è il "job e MCP attendono il gate" del piano. La rientranza del gate vale solo nello stesso flusso asincrono: dentro la callback dell'esclusivo NON si lanciano scritture del calendario (scriverebbero nel gate esclusivo). Dentro la callback nessuna chiamata usa il pool calendario `calSql` (regola 1 contro lo stallo): collezioni dal pool principale, quiescenza solo HTTP e stat.

**Quiescenza** (`awaitDeviceQuiescence`, design §13.9 punto 3), con `F4_LIMITS`:

1. senza probe (`RADICALE_PROBE_PASSWORD`, ripiego `CALDES_PROBE_PASSWORD`) → `PRECONDITION_FAILED PROBE_UNAVAILABLE`; senza control-plane nel processo → `CONTROL_PLANE_UNAVAILABLE`;
2. giro del control-plane: policy dello stato corrente uguale a `expectPolicyMode` (frozen), fino a 3 tentativi, altrimenti `CONTROL_PLANE_UNAVAILABLE`;
3. attesa di `quiescencePolicyGraceMs` (2 s, oltre il ricontrollo di 1 s dei plugin);
4. PUT del probe (`caldes-probe`, dal loopback o da `caldav-int`) su `_canary/quiesce-<uuid>.ics` con `If-None-Match: *`: 403 atteso; a gate aperto la risorsa si rimuove subito come `caldes-svc`; fino a `quiescenceProbeAttempts` (10) a `quiescenceProbeIntervalMs` (1 s), poi `QUIESCENCE_TIMEOUT`;
5. stat delle collezioni Radicale del sidecar (`radicaleCollections(sql)`, senza `_*`): mount → mtime delle directory e del principal; senza mount → PROPFIND di `getctag` e `sync-token` come `caldes-svc`; ripetuta a `quiescenceStatIntervalMs` (1 s) finché due letture coincidono, al più `quiescenceStatMaxRounds` (30) giri, poi `QUIESCENCE_TIMEOUT`.

Report nel journal del passo `quiesce` (`QuiescenceReport`). Nel cutover da mode postgres la policy era già shadow (il probe riceve 403 al primo tentativo): la quiescenza serve allora a fotografare un volume fermo; nel rollback da live è la prova che i device non scrivono più.

## 3. CUTOVER (`migration/cutover.ts`, `migration/smoke.ts`, `api-level.ts`)

### 3.1 Passi

```ts
export function runCutover(ctx: MigrationRunContext<CutoverParams>): Promise<CutoverSummary>;
```

| Passo | Cosa fa | Funzione della fondazione | Errore → |
|---|---|---|---|
| `preflight` | `assertCutoverReady()` (§3.2) con lo stato riletto; dati: criteri | `runStep` | run `failed` `PRECONDITION_FAILED`, transizione aperta e annullabile (nessuno stato toccato: la UI propone "Annulla") |
| `freeze` | `mode = 'cutover'`, `write_freeze = true` | `freezeStep` | run `failed`, ripresa |
| `quiesce` | gate + quiescenza | `quiesceStep` | run `failed` (`QUIESCENCE_TIMEOUT`/`GATE_TIMEOUT`), ripresa o annullamento |
| `delta_apply` | apply completo (modo `apply`, opzioni e ambito dell'ultima anteprima riuscita, `expected_plan_hash: null`, nessun item forzato) con `buildPlan` ed `executePlanItem` di F3; dati: `ApplySummary` | `runStep` | conflitti o fallimenti → passo `done` con i conteggi e poi `abort` (`CUTOVER_ABORTED`) |
| `delta_verify` | verifica V1, V2 e V4 (V4 senza iscrizioni, 180 giorni) su tutti i calendari, come `runVerify` ma senza run proprio (le righe `diff` vanno nel run del cutover); accettabilità con le accettazioni riportate per firma | `runStep` | rosso → `abortTransition({ code: 'VERIFY_RED' })`, run `failed` `CUTOVER_ABORTED` con il riassunto |
| `epoch` | PROPPATCH E+1, poi mode `radicale`, `rollback_until = now() + rollback_window_days`, `cutover_at = now()`, `cutover_by = actor`, `api_min_version = CALENDAR_API_LEVEL`; `write_freeze` resta true | `epochStep` | ripresa (stato congelato) |
| `control_plane` | giro del control-plane: policy frozen (`write_freeze`) con il nuovo epoch, heartbeat `radicale` con E+1; identità `ok` (`verifyVolumeIdentity({ force: true })`) | `runStep` | ripresa |
| `index_sync` | validatori di `calendar_subscriptions` azzerati (§3.6), poi `syncAllCollections({ reason: 'manual' })`: indice allineato con il nuovo epoch; ogni errore → passo fallito | `runStep` | ripresa |
| `reverse_start` | prima passata completa della proiezione inversa (`runReverseProjection`, §4), sincrona | `runStep` | ripresa (REVERSE_FAILED non blocca: compare nella salute) |
| `bookings_reconcile` | `reconcileBookingsAfterCutover(db, transition.started_at − bookingsReconcileMarginMs)`: `project_booking` per le prenotazioni create o cambiate a cavallo del freeze (una prenotazione committata dopo la fotografia del delta non resta senza proiezione) | `runStep` | ripresa |
| `unfreeze` | `write_freeze = false` → policy live, i device scrivono entro 1 s | `stateStep({ expectMode: 'radicale', set: { write_freeze: false } })` | ripresa |
| `smoke` | `runCutoverSmoke()` (§3.3); un fallimento NON annulla il cutover: `CutoverSummary.smoke.ok = false` e il wizard propone il rollback | `runStep` | — |

Poi `completeTransition`. Azioni del run: `start` (`beginTransition`), `resume` (`beginTransition({ resume: true })`, prosegue dal primo passo non concluso), `abort` (solo prima di `epoch`: `abortTransition({ code: 'CUTOVER_ABORTED', reason: 'annullato dall\'admin' })`). I passi già conclusi non si ripetono; i job (`project_booking`, `reverse_projection`) accodati durante il run girano dopo, perché il worker dei job è sequenziale (f3 §19.7): nessun passo li attende.

### 3.2 Criteri e precondizioni

```ts
export function cutoverCriteria(db: Db, opts?: { now?: Date; verifyRunId?: string | null }): Promise<CutoverCriterion[]>;
/** PRECONDITION_FAILED con details.reasons (PreconditionReason) se un criterio non è soddisfatto. */
export function assertCutoverReady(db: Db, opts?: { now?: Date; verifyRunId?: string | null }): Promise<CutoverCriterion[]>;
export function reconcileBookingsAfterCutover(db: Db, since: Date): Promise<number>;
```

| Criterio (`CutoverCriterion.id`) | Condizione | Motivo |
|---|---|---|
| `no_active_transition` | nessuna transizione attiva (o quella che si sta riprendendo) | `TRANSITION_ACTIVE` |
| `identity_ok` | mode postgres, identità `ok` letta da Radicale (`assertMigrationWritable`) | `MODE_NOT_POSTGRES`, `IDENTITY_NOT_OK` |
| `verify_acceptable` | ultima verifica completa (`latestVerifyVerdicts`) accettabile e successiva all'ultimo apply | `VERIFY_REQUIRED`, `VERIFY_RED` |
| `shadow_parity` | `getParity().satisfied` (7 giorni); per un nuovo cutover dopo un rollback: una verifica completa accettabile conclusa dopo il rollback (la parità era già stata osservata prima del primo cutover e la ri-baseline rende esatto il ledger; precisazione 6) | `SHADOW_PARITY_REQUIRED` |
| `device_matrix` | dichiarazione `device_matrix` con `result: 'passed'` | `DEVICE_MATRIX_REQUIRED` |
| `backup_fresh` | `last_stack_backup` completo, con l'identità corrente, di meno di `cutoverBackupMaxAgeMinutes` (2 h); nessuna dichiarazione lo sostituisce | `BACKUP_TOO_OLD` |
| `no_open_conflicts` | `ParityView.open_conflicts = 0`, nessun intento pendente nel ledger | `OPEN_CONFLICTS` |
| `no_revalidation` | nessuna riga del ledger da rivalidare | `REVALIDATION_PENDING` |
| `control_plane` | control-plane attivo nel processo e ultimo giro riuscito | `CONTROL_PLANE_UNAVAILABLE` |
| `probe` | password di `caldes-probe` disponibile | `PROBE_UNAVAILABLE` |
| `archive_readonly` | nessun archivio della Fase 0, oppure archivio in sola lettura per i device (§3.5) o nascosto | `ARCHIVE_DEVICE_WRITABLE` |

`backup_recent` (24 h, F3) resta nell'elenco come informazione: per il cutover vale `backup_fresh`.

### 3.3 Smoke (`smoke.ts`)

```ts
export function runCutoverSmoke(opts: { db?: Db; now?: Date; signal?: AbortSignal }): Promise<SmokeReport>;
```

Senza effetti collaterali (design §13.10 passo 7): `SLOTS` (`computeAvailableSlots` di un event type pubblico sui prossimi 14 giorni, livello display, nessun 503); `BOOKING_ROLLBACK` (`createBooking` su un event type NON pubblico, o con una durata fuori dalle finestre pubbliche, dentro `sql.begin` sempre annullata con `db: tx`: nessun effetto post-commit, nessun job, nessuna email, nessun workflow; esito atteso: decisione presa, riga inserita nella tx e poi sparita); `FEED` (`buildCalendarFeed` per ogni calendario con feed attivo, 200 con un corpo VCALENDAR, nessun token nei log); `MCP_READ` (`executeTool` di `list_calendars`, `list_events`, `get_calendar_availability` senza `{error}`); `NO_SIDE_EFFECTS` (nessuna riga nuova in `calendar_bookings`, `cal_jobs`, coda email e `workflow_runs` rispetto all'inizio dello smoke). Ogni controllo con `ms` e `detail` senza dati personali.

### 3.4 Selezione dello store dopo il cutover e livello dell'API

- `backend-mode.ts` già seleziona lo store per mode (f2 §1.2): `radicale`, `rollback` e `finalized` → RadicaleStore; `postgres` e `cutover` → PgLegacyStore. Il cutover non cambia questa tabella.
- `api-level.ts` (nuovo, CUTOVER):

```ts
export function checkCalendarApiLevel(db?: Db): Promise<{ ok: boolean; required: number; current: typeof CALENDAR_API_LEVEL }>;
/** Avvio (integrazione): livello insufficiente → calendario non servito e log d'errore; true se ok. */
export function enforceCalendarApiLevelAtBoot(db?: Db): Promise<boolean>;
/** true dopo un controllo fallito: store.ts risponde CalendarStoreUnavailableError ('store_not_available'). */
export function calendarApiLevelBlocked(): boolean;
```

- `store.ts` (solo questo): `calendarStore()` e `calendarStoreForWrite()` lanciano `CalendarStoreUnavailableError('api', 'level')` (motivo `store_not_available`) se `calendarApiLevelBlocked()`; nessun altro cambiamento. In mode postgres con `api_min_version = 0` non cambia nulla. Un'immagine più vecchia della F4 non ha questo controllo: la protegge il heartbeat (design §16.6) e la guardia 166, che fa fallire le sue scritture legacy.

### 3.5 Archivio della Fase 0 in sola lettura (questione aperta 1 della F3)

Soluzione (CUTOVER): `policyFromState()` mette in `readonly` anche le collezioni del sidecar con `origin = 'migration'` (archivio), oltre ai ruoli di `DEVICE_READONLY_ROLES`; `readSidecarCollections()` legge `origin`; `SidecarCollection` acquista `origin`. Nessuna migrazione e nessun cambio ai plugin (i plugin leggono la lista `readonly`, non i ruoli). In mode postgres la policy cambia solo nel contenuto di `readonly` (l'archivio è già in sola lettura per la base shadow). Il contratto del control-plane §6.3 e i casi di `policy-from-state.test.ts` si aggiornano nello stesso commit. Il criterio `archive_readonly` verifica la policy derivata.

### 3.6 Iscrizioni ICS

Subito dopo il passo `epoch` del cutover, come prima operazione del passo `index_sync` (un `runStep` idempotente: rieseguito, azzera di nuovo e costa solo un nuovo download), CUTOVER azzera `etag` e `last_modified` di `calendar_subscriptions` (anomalia `ICS_PULL_REFETCH` della F3): il pull verso l'indice rilegge tutto. Il ROLLBACK li azzera di nuovo nel passo `cleanup` (§5.1): il pull legacy, ripartito in mode postgres, riscarica i feed invece di fidarsi di validatori del periodo radicale.

## 4. REVERSE (`migration/reverse-projector.ts`)

### 4.1 Quando gira

| Momento | Come | Chi |
|---|---|---|
| Passo `reverse_start` del cutover | passata completa sincrona (`runReverseProjection`) | run del cutover (tiene `cal-migration`) |
| `radicale` con `rollback_until > now()` | job `reverse_projection` per collezione (chiave = `calendar_id`), accodato dal NOTIFY `calendar_index_changed` (163) con debounce di 2 s, coalescenza sui pending | `startReverseProjectionTrigger()` (integrazione, al boot) |
| Ogni 15 minuti in mode radicale | `runReverseProjectionSweep()`: accoda le collezioni con oggetti cambiati dopo `projected_at` o con righe `failed` (backstop del NOTIFY perso) | cron (integrazione) |
| Anteprima del rollback | `computeReversePlan` senza scrivere | run `rollback_preview` (ROLLBACK) |
| Passo `reverse_final` del rollback | passata completa sincrona dopo la sync finale | run del rollback |
| `finalized`, `postgres`, `cutover`, `rollback`, finestra scaduta | il job si chiude senza azione | — |

Il job prende `cal-migration` con `withMigrationLock(…, { wait: false })` (come lo shadow): lock occupato da un run → `CalendarUnavailableError('transition')`, errore d'attesa. Rilegge lo stato dentro il lock: mode `radicale` e finestra aperta, altrimenti nessuna azione. Non usa il gate `cal-write` (scrive solo PG, con il GUC) né il pool calendario dentro transazioni.

### 4.2 Mappatura (design §13.11)

Ambito: risorse indicizzate (`cal_objects` con salute `ok`, o l'ultima versione buona per le quarantene) delle collezioni con `role <> 'subscription'`, `origin <> 'migration'` (archivio) e `lifecycle = 'active'`. Mai le righe `ics_pull` né le collezioni `sub-*`.

- **Rappresentabili** (una riga master, override ed EXDATE): VEVENT singolo o serie con DTSTART in `Europe/Rome`, UTC o all-day `VALUE=DATE`, RRULE che `legacy/rrule-legacy` espande come calendar-core sull'orizzonte (confronto delle istanze), nessuna RDATE, override abbinati, nessun override timed su un master all-day.
- **Espansi** (`SEMANTIC_EXPANDED`, righe singole `caldes_derived = true` con `caldes_object_id`): tutto il resto (RDATE, TZID diversi da Roma, floating con un fuso del calendario diverso da Roma, override orfani, regole espanse diversamente, all-day con override timed), dalle occorrenze di `cal_occurrences` sull'orizzonte materializzato della collezione (`horizon_until` registrato).
- **Id**: master = `cal_object_ids.id` della risorsa (che per i migrati è l'UUID legacy); override = `cal_object_ids.id` della `recurrence_key`; derivate = uuidv5 deterministico di `<object_id>|<recurrence_key>` nel namespace `CALDES_REVERSE_NAMESPACE` (costante del modulo, congelata).
- **UID** (`calendar_events.uid` è UNIQUE): master = `cal_object_ids.legacy_uid` se esiste, altrimenti l'UID iCalendar se è libero, altrimenti `<UID>@<collection_name>` (`SANITIZED_UID`); override e derivate = `<UID>#<recurrence_key>`.
- **Sanificazione**: SUMMARY vuoto → `(senza titolo)` (`SANITIZED_SUMMARY`); DTEND assente o non successivo → +1 minuto timed / +1 giorno all-day (`SANITIZED_DURATION`, il CHECK legacy non si rilassa); STATUS fuori da confirmed/tentative/cancelled → il più vicino (`SANITIZED_STATUS`); `TRANSP:TRANSPARENT` → `status = 'tentative'` (`SEMANTIC_TRANSP`: non blocca nemmeno nel legacy, busy identico).
- **Rappresentazione persa**: VALARM → `REPR_LOSS_VALARM`; ATTENDEE/ORGANIZER → `REPR_LOSS_ATTENDEE`; X-* (tranne `X-CALDES-*`), CATEGORIES, CLASS, PRIORITY, GEO, ATTACH, CONFERENCE → `REPR_LOSS_PROPERTY`. Il volume conserva tutto.
- **Provenienza** (design §5): `source`/`source_id` come la provenienza dell'indice (`booking`+uid solo per `booking-*` della collezione bookings, `system`+`it-holiday-…` solo per `it-holiday-*` della collezione holidays, `X-CALDES-SOURCE` ammessa altrimenti `manual`).
- **Proiezioni delle prenotazioni** (`booking-<uid>.ics`): aggiornano la riga legacy legata (`source = 'booking' AND source_id = <uid>`, id da `cal_object_ids.legacy_event_id`) con orari e stato da `calendar_bookings` (una prenotazione annullata nella finestra porta la riga a `cancelled`; le righe di proiezioni superate da una riprogrammazione si annullano); il testo resta quello della decisione 3 ricomposto dalla prenotazione (`bookingProjectionContent`), mai i dati del device; una proiezione nuova (prenotazione della finestra) crea la riga come `createLegacyProjection` di `booking.ts` (stesso testo).
- **Cancellazioni**: risorsa sparita dall'indice (o ritirata in `cal_object_ids`) → DELETE delle righe possedute (`caldes_object_id = object_id` più gli id di `rows`), stato `removed`. Righe legacy MAI possedute (mai migrate: CANCELLED_MASTER, UNTIL_BEFORE_DTSTART, DUPLICATE_HOLIDAY, orfani scartati, INVALID_OBJECT) non si toccano: restano congelate.
- Ogni scrittura in transazioni brevi per risorsa (o per lotti di risorse) con `SET LOCAL caldes.reverse_sync = 'on'`, upsert per id; righe derivate in eccesso (orizzonte cambiato) cancellate.

### 4.3 Degradi e REVERSE_FAILED

Ogni risorsa ha i propri degradi in `cal_migration_reverse_state.degradations` (classi di `DEGRADATION_CLASSES`, `recurrence_key` e `detail` senza dati personali). Un upsert che fallisce comunque (vincolo, UID irrisolvibile, errore del database) → stato `failed`, `error_code = 'REVERSE_FAILED'`, nessuna eccezione propagata al job (mai un job fallito in silenzio): compare nella salute, nell'anteprima del rollback e blocca il finalize. Una passata successiva lo riprova.

### 4.4 Firme

```ts
export const REVERSE_PROJECTION_JOB_KIND = 'reverse_projection';   // = CAL_JOB_KINDS.reverseProjection
/** Riga di calendar_events come la scrive il proiettore (colonne legacy più caldes_*). */
export interface LegacyReverseRow {
  id: string; calendar_id: string; uid: string; summary: string; description: string | null; location: string | null; url: string | null;
  start_time: string; end_time: string; all_day: boolean; rrule: string | null; exdates: string[]; recurrence_id: string | null;
  recurrence_master_id: string | null; source: string; source_id: string | null; status: 'confirmed' | 'tentative' | 'cancelled';
  caldes_object_id: string; caldes_derived: boolean;
}
export interface ReverseObjectPlan {
  object_id: string; calendar_id: string; collection_name: string; href: string; source_etag: string | null; source_sha256: string | null;
  status: ReverseStateStatus; rows: Array<ReverseRowRef & { row: LegacyReverseRow }>; degradations: DegradationRecord[];
  /** Righe possedute da cancellare (risorsa sparita, derivate in eccesso). */
  delete_row_ids: string[]; error: { code: 'REVERSE_FAILED'; message: string } | null; unchanged: boolean;
}
export interface ReversePlan { generated_at: string; horizon: { from: string; to: string }; objects: ReverseObjectPlan[]; hash: string; summary: ReverseApplySummary }
/** Pura e deterministica: risorsa indicizzata → righe legacy, degradi. */
export function projectObject(input: { object: { id: string; calendar_id: string; collection_name: string; href: string; etag: string | null; raw_ics: string; content_sha256: string | null };
  calendar: { id: string; collection_name: string; role: CalendarRole; timezone: string };
  ids: { master: { id: string; legacy_uid: string | null }; byRecurrenceKey: ReadonlyMap<string, string> };
  occurrences: ReadonlyArray<{ recurrence_key: string; start_utc: string; end_utc: string; all_day: boolean; status: string; transp: string | null }>;
  usedUids: ReadonlySet<string>; booking: BookingProjectionInput | null; horizon: { from: Date; to: Date } }): ReverseObjectPlan;
export function computeReversePlan(db: Db, opts: { calendarIds?: readonly string[]; now: Date; signal?: AbortSignal }): Promise<ReversePlan>;
export function applyReversePlan(db: Db, plan: ReversePlan, opts: { actor: string; runId?: string | null; signal?: AbortSignal }): Promise<ReverseApplySummary>;
export function runReverseProjection(opts: { db?: Db; calendarIds?: readonly string[]; actor: string; runId?: string | null; now?: Date; signal?: AbortSignal }): Promise<ReverseApplySummary & { hash: string }>;
/** sha256 del JSON canonico (oggetti con righe previste, degradi per oggetto, REVERSE_FAILED), ordinato: preview_hash del rollback. */
export function reversePlanHash(plan: Pick<ReversePlan, 'objects'>): string;
export function reverseProjectionActive(state: Pick<MigrationBackendState, 'mode' | 'rollback_until'>, now: Date): boolean;
export function readReverseProjectionHealth(db: Db, now?: Date): Promise<ReverseProjectionHealthView>;
export function registerReverseProjectionJob(): void;
export function enqueueReverseProjection(calendarId: string, opts?: { db?: Db; delayMs?: number }): Promise<void>;
/** LISTEN calendar_index_changed → enqueueReverseProjection; restituisce la funzione che smette. */
export function startReverseProjectionTrigger(): Promise<() => Promise<void>>;
export function runReverseProjectionSweep(opts?: { now?: Date }): Promise<{ enqueued: number }>;
```

`BookingProjectionInput` è il tipo dei dati della prenotazione usato da `buildBookingProjectionIcs` (`radicale/booking-projection.ts`). `projectObject` NON legge il database né l'orologio: tutto entra dagli argomenti (test unitari sulle fixture di RDATE, New York, UID duplicati, durata zero, SUMMARY assente, override con l'UID del master).

## 5. ROLLBACK (`rollback.ts`, `rebaseline.ts`, `finalize.ts`, `routes/backup.ts`)

### 5.1 Rollback

```ts
export function runRollbackPreview(ctx: MigrationRunContext<RollbackPreviewParams>): Promise<RollbackPreviewSummary>;
export function runRollback(ctx: MigrationRunContext<RollbackParams>): Promise<RollbackSummary>;
```

| Passo | Cosa fa | Funzione | Errore → |
|---|---|---|---|
| `preflight` | mode radicale, `rollback_until > now()` (`ROLLBACK_WINDOW_EXPIRED`), anteprima: run `rollback_preview` riuscito di meno di `rollbackPreviewMaxAgeMinutes` con `preview_hash = expect_preview_hash` (`PREVIEW_REQUIRED`, `PREVIEW_STALE`), identità `ok`, control-plane e probe | `runStep` | run `failed`, transizione annullabile senza effetti |
| `freeze` | mode `rollback`, `write_freeze = true` | `freezeStep` | ripresa |
| `quiesce` | gate + quiescenza (qui il probe passa da 2xx a 403) | `quiesceStep` | ripresa o annullamento |
| `index_sync` | sync finale di tutte le collezioni; un errore senza emergenza → passo fallito (ripresa); con emergenza → passo `done` con gli errori (l'indice è la miglior conoscenza) | `runStep` | — |
| `reverse_final` | `computeReversePlan` su tutto; `reversePlanHash` diverso da `expect_preview_hash` senza emergenza → `abortTransition({ code: 'PREVIEW_CHANGED' })` (mode radicale, live) e run `failed` `ROLLBACK_ABORTED` con la nuova anteprima nel riassunto; altrimenti `applyReversePlan` | `runStep` | — |
| `rebaseline` | `runRebaseline` (§5.3) | `runStep` | ripresa |
| `epoch` | PROPPATCH E+1, poi mode `postgres`, `write_freeze = false`, `rollback_until`, `cutover_at`, `cutover_by` a NULL; `api_min_version` resta (le righe derivate richiedono la F4) | `epochStep` | ripresa |
| `control_plane` | policy shadow con il nuovo epoch, heartbeat `postgres` | `runStep` | ripresa |
| `cleanup` | validatori di `calendar_subscriptions` azzerati (§3.6), job `reverse_projection` pending chiusi, `project_booking` pending lasciati (in mode postgres convergono la proiezione legacy, f2 §3); lo shadow mirror, se `shadow_enabled`, riprende da solo in patch (righe `adopted`) | `runStep` | ripresa |

Azioni: `start`, `resume`, `abort` (solo prima di `epoch`). Il volume Radicale resta intatto (archivio, design §13.12 passo 6).

**Anteprima** (`runRollbackPreview`, run `rollback_preview`, nessuna scrittura tranne le righe del run): cambiamenti dal cutover (`cal_object_versions` dopo `cutover_at`, per attore), `computeReversePlan` completo, degradi per classe e per calendario, righe derivate, REVERSE_FAILED, `busy_identical` (busy legacy simulato sulle righe previste contro `computeBlocks` dell'indice, 180 giorni, intervalli fusi), `preview_hash = reversePlanHash(plan)`. Righe `degradation` (una per degrado, `code` = classe, `detail` senza dati personali) e `object` per i REVERSE_FAILED.

### 5.2 Rollback d'immagine API

Fuori dal wizard (design §16.6): un'immagine più vecchia non scrive il heartbeat (device frozen entro 10 minuti) e le sue scritture legacy falliscono sulla guardia 166; un'immagine F4 con `api_min_version` più alto del proprio livello non serve il calendario (§3.4). Il runbook della F5 lo documenta.

### 5.3 Ri-baseline del ledger (`rebaseline.ts`)

```ts
export function runRebaseline(opts: { db: Db; actor: string; runId: string | null; options: MigrationOptions; signal?: AbortSignal }): Promise<RebaselineSummary>;
/** Run 'rebaseline' di riparazione dal wizard (solo mode postgres, conferma APPLICA). */
export function runRebaselineRun(ctx: MigrationRunContext<RebaselineParams>): Promise<RebaselineSummary>;
```

Dopo `reverse_final`, per ogni risorsa Radicale delle collezioni del piano (design §13.12 passo 4), con le opzioni dell'ultima anteprima riuscita: lo snapshot e l'hash si calcolano con il serializer (`loadLegacySource` + `serializeLegacy`, mai a mano), così il cutover successivo li ritrova identici.

| Categoria | Ledger dopo la ri-baseline |
|---|---|
| A. Risorsa rappresentata 1:1 (righe master/override) | riga `event:<id del master>` all'href reale (`cal_object_ids`), `legacy_snapshot`/`legacy_hash` del serializer sulle righe correnti, `written_etag` = etag corrente, `written_fingerprint` = fingerprint della risorsa corrente, `adopted = true`, intento azzerato, `revalidate_*` azzerati |
| B. Risorsa espansa (righe derivate) | riga `event:<object_id>` con `derived = true`, snapshot `LegacyDerivedSnapshot` delle righe derivate (§5.6), etag e fingerprint correnti, `adopted = true` |
| C. Proiezione `booking-<uid>` | riga `booking:<uid>` all'href reale con lo snapshot del serializer (da `calendar_bookings`) |
| D. REVERSE_FAILED (nessuna riga legacy) | riga tolta dal ledger (`untrackLedgerRow`): l'oggetto resta nel volume, V1 lo riporta come `TARGET_UNTRACKED`, il piano non lo cancella mai |
| E. Oggetto creato nella finestra (device, admin, MCP) | riga nuova come A o B; `cal_object_ids.legacy_event_id`/`legacy_uid` della risorsa valorizzati con l'id e l'UID delle righe proiettate (riuso degli id e degli UID al cutover successivo) |
| F. Risorsa sparita (righe legacy cancellate) | riga ritirata (`deleted_at`) |
| G. Collezioni escluse (iscrizioni, archivio) | invariate |

Criterio (piano F4): un nuovo cutover dopo il rollback è `noop` per gli oggetti non toccati, anche per quelli creati da un iPhone con un href proprio e per quelli toccati da admin o MCP nella finestra.

### 5.4 Finalize (`finalize.ts`)

```ts
export function finalizeBlockers(db: Db, now?: Date): Promise<PreconditionReason[]>;
export function runFinalize(ctx: MigrationRunContext<FinalizeParams>): Promise<FinalizeSummary>;
```

| Passo | Cosa fa |
|---|---|
| `preflight` | mode radicale, `cutover_at ≤ now() − finalizeMinDays` (`FINALIZE_TOO_EARLY`), salute del calendario `ok` (`HEALTH_NOT_GREEN`), nessun job morto (`DEAD_JOBS`), nessun REVERSE_FAILED (`REVERSE_FAILED_OPEN`), conferma `CHIUDI LA FINESTRA` |
| `stop_reverse` | job `reverse_projection` pending chiusi (il run tiene `cal-migration`: nessuno in corso) |
| `state` | `stateStep({ expectMode: 'radicale', mode: 'finalized', set: { finalized_at: now, rollback_until: null } })`; la policy resta live, nessun cambio d'epoch |
| `legacy_finalize` | `calendar_finalize_legacy()` se esiste (migrazione 167, F7): rename in `calendar_events_legacy` più vista; altrimenti passo `skipped` con la nota "si applica con la release F7" |

### 5.5 Backup JSON (`routes/backup.ts`)

- **Vista** (design §16.2): se `calendar_events` è una vista (`information_schema.tables.table_type = 'VIEW'`, dopo la 167) le righe del backup di `calendar_events` si importano in `calendar_events_legacy` (stesse colonne; quelle assenti nel backup prendono i default) e l'export esporta `calendar_events_legacy` con il nome storico; un backup storico precedente al finalize resta importabile. Prima del finalize nulla cambia.
- **Import in mode ≠ postgres**: invariato dalla F1 (gruppo D saltato, avviso). In mode postgres dopo un rollback le colonne `caldes_object_id`/`caldes_derived` del backup si importano come sono (un backup precedente alla 166 le lascia ai default).
- **Export v2** (`GET /api/backup/export?format=calendar-v2`, stessa route e quindi stesso rate limit e JWT dell'export v1): zip (scritto senza dipendenze nuove, entry stored o deflate con `node:zlib`) con `manifest.json` (`CalendarExportManifest`) e `collections/<collection_name>.ics` per ogni collezione Radicale del sidecar (oggetti dall'indice, `raw_ics` dell'ultima versione buona, VTIMEZONE deduplicati, nessun dato delle iscrizioni non visibili); in mode postgres l'export v2 risponde 409 con l'indicazione di usare v1. La UI dell'admin offre v2 in mode ≠ postgres.

### 5.6 Serializer e piano: righe derivate

- `loadLegacySource` raggruppa le righe con `caldes_derived = true` per `caldes_object_id` in una sorgente `derived` (`LegacyDerivedSnapshot`, aggiunto all'unione `LegacySnapshot`); le righe non derivate restano come in F3 (anche quelle con `caldes_object_id`, che il serializer ignora).
- Piano (`computePlan`, nuova riga della tabella f3 §7.2): sorgente `derived` con una riga viva `derived = true` → hash uguale → `noop`; hash diverso → `conflict:DERIVED_EDITED` in `apply` e in `shadow` (mai una riscrittura: le righe derivate non ricostruiscono la regola); senza riga del ledger → anche qui `conflict:DERIVED_EDITED`, mai `skip` (la risorsa d'origine esiste ancora nel volume e le righe derivate non bastano a ricostruirla).
- `DERIVED_EDITED` entra in `FORCEABLE_CONFLICTS` con la semantica "mantieni la risorsa di Radicale": nessuna scrittura, ledger riallineato allo snapshot corrente (la modifica in PG si perde al cutover, mostrato nell'anteprima). È l'unica forzatura senza scrittura.
- Verifica: V2 e V3 trattano le risorse `derived` confrontando le occorrenze (non il contenuto), con le differenze attese `ORPHAN_CONVERTED`-like già esistenti; nessuna nuova differenza attesa in F4.

## 6. UI (route, esecutore, wizard, ritocchi)

### 6.1 Route (`routes/calendar/migration.ts`)

| Metodo e percorso | Corpo | Run | Conferma |
|---|---|---|---|
| `POST /cutover` | `CutoverRequest` | `cutover` `{ action: 'start', rollback_window_days, verify_run_id }` | `PASSA A RADICALE`; chiave obbligatoria; criteri del §3.2 valutati anche dalla route (409 `PRECONDITION_FAILED` con i motivi) |
| `POST /cutover/abort` | `CutoverAbortRequest` | `cutover` `{ action: 'abort' }` | `ANNULLA IL PASSAGGIO` |
| `POST /transition/resume` | `TransitionResumeRequest` | tipo della transizione attiva, `{ action: 'resume' }` | la frase della transizione (`PASSA A RADICALE`, `TORNA A POSTGRES`, `CHIUDI LA FINESTRA`) |
| `GET /transition` | — | — | `TransitionView \| null` |
| `POST /rollback/preview` | `RollbackPreviewRequest` | `rollback_preview` | — |
| `POST /rollback` | `RollbackRequest` | `rollback` `{ action: 'start', preview_run_id, expect_preview_hash, emergency }` | `TORNA A POSTGRES` (+ `ROLLBACK DI EMERGENZA` con `emergency`) |
| `POST /rollback/abort` | `CutoverAbortRequest` | `rollback` `{ action: 'abort' }` | `ANNULLA IL PASSAGGIO` |
| `POST /finalize` | `FinalizeRequest` | `finalize` `{ action: 'start' }` | `CHIUDI LA FINESTRA` |
| `POST /rebaseline` | `RebaselineRequest` | `rebaseline` `{ reason: 'manual' }` | `APPLICA` (solo mode postgres) |
| `GET /reverse` | — | — | `ReverseProjectionHealthView` |

Regole comuni della F3 (§10.1-§10.3): audit in `audit_logs`, `MigrationErrorBody`, idempotenza, `MIGRATION_BUSY`; in più `409 TRANSITION_IN_PROGRESS` con `details.transition`. `F4_WRITING_RUN_KINDS` richiedono chiave e conferma.

### 6.2 Esecutore (`runs.ts`)

- `RUN_HANDLERS`: `cutover: runCutover`, `rollback_preview: runRollbackPreview`, `rollback: runRollback`, `rebaseline: runRebaselineRun`, `finalize: runFinalize`; `normalizeRunInput` ammette `F3_RUN_KINDS ∪ F4_RUN_KINDS`; `MIGRATION_PHASE = 'F4'`.
- `reapInterruptedRuns()` NON chiude come `interrupted` un run di una transizione attiva il cui job è pending o in lease (come oggi); quando lo chiude (job morto), la transizione resta `active` e la vista la mostra `resumable`.
- `buildMigrationStateView()`: valorizza `transition` (`readTransitionView` con `runActive`), `rollback_window` (§6.3) e `reverse_projection` (`readReverseProjectionHealth`).

### 6.3 Wizard

- Passo 6 `passaggio`: `cutover.available` con i criteri del §3.2; azione `cutover` abilitata solo con tutti i criteri e mode postgres; durante la transizione avanzamento per passo (journal) con `transition_resume` e `cutover_abort` quando ammessi.
- Dopo il cutover (mode radicale/finalized) il passo mostra: giorni residui (`rollback_window.days_left`), salute della proiezione inversa e degradi per classe, anteprima del rollback (`rollback_preview`) con `busy_identical` e REVERSE_FAILED, "Torna a Postgres" (`rollback`, conferma digitata, emergenza separata), "Chiudi finestra" (`finalize`, abilitata da `finalize_ready`, motivi da `finalize_blockers`), export v2 (`export_v2`).
- I passi 1-5 restano quelli della F3; in mode ≠ postgres le loro azioni che scrivono sono disabilitate con il motivo "Postgres non è più autorevole".

### 6.4 Ritocchi dell'admin (piano F4 attività 7)

1. **Saga "questa e le successive"**: route `POST /api/admin/calendar/events/:id/split` (`{ original_start, start_time?, end_time?, delete?: boolean }`): con lo store Radicale `splitRecurringEvent` (saga `recurrence_split`, f2 §3); con PgLegacyStore le stesse due operazioni che l'admin fa oggi dal browser (UNTIL del master a `cutoff − 60 s` e nuova serie da `original_start`) in una sola transazione, stessi valori. `calendario.tsx` usa la route invece delle due chiamate.
2. **Selezione degli all-day**: una selezione `allDay` di FullCalendar crea un evento `all_day: true` con inizio e fine a mezzanotte Europe/Rome (fine esclusiva), mai un timed 00:00-00:00 UTC.
3. **`timeZone` Europe/Rome**: FullCalendar mostra e restituisce gli orari di Roma a prescindere dal fuso del browser. Preferita la soluzione senza dipendenze (`timeZone: 'UTC'` con gli istanti convertiti in wall-time di Roma da `lib/timezone.ts` all'ingresso e riconvertiti con `zonedInputToIso` in uscita da select, drop e resize); `@fullcalendar/luxon3` solo se l'integrazione autorizza `apps/admin/package.json`.
4. **UNTIL a fine giornata locale**: `evento-edit.tsx` scrive `UNTIL` come l'istante UTC di 23:59:59 Europe/Rome del giorno scelto (non la mezzanotte UTC, che escludeva l'ultima occorrenza mattutina).

Nessun ritocco cambia le route v1 né le query key di react-query.

## 7. Cosa vede ciascun consumatore

| Consumatore | postgres | cutover | radicale (freeze) | radicale | rollback | finalized |
|---|---|---|---|---|---|---|
| Sito: slot, prenotazioni, gestione, ICS d'invito | busy legacy; proiezione legacy sincrona | busy legacy (PG congelato, device in sola lettura: coerente); proiezione `project_booking` in coda (gira dopo) | busy dall'indice (freshness); proiezione in coda | busy dall'indice; job `project_booking` | busy dall'indice (Radicale congelato); proiezione in coda, converge in legacy dopo il rollback | come radicale |
| Admin v1 letture | PG | PG | indice | indice | indice | indice |
| Admin v1 scritture | PG | 503 `transition` | 503 `write_freeze` | Radicale | 503 `transition` | Radicale |
| MCP (22 tool) | come oggi | letture ok; scritture `{error}` | letture ok; scritture `{error}` | come oggi sullo store Radicale | letture ok; scritture `{error}` | come radicale |
| Feed ICS | legacy | legacy | indice (UID legacy) | indice | indice | indice |
| Agenda device (`/api/device/agenda`) | legacy | legacy | indice | indice | indice | indice |
| Device CalDAV | sola lettura (shadow) | sola lettura (frozen) | sola lettura (frozen) | scrittura (live) | sola lettura (frozen) | scrittura |
| Job `project_booking`, `subscription_mirror`, saga, lifecycle | legacy/converge, specchio | attesa (`transition`) | attesa (`write_freeze`) | attivi | attesa (`transition`) | attivi |
| Job `shadow_mirror` | attivo se acceso | chiuso senza azione | chiuso | chiuso | chiuso | chiuso |
| Job `reverse_projection` | chiuso | chiuso | chiuso | attivo (finestra aperta) | chiuso (passata finale nel run) | chiuso |
| Cron festività, ics-pull | legacy | 503 → riprova al giro dopo | 503 | Radicale/indice | 503 | Radicale/indice |
| `tool_db_query` (workflow) | `calendar_events` | congelata | proiettata | proiettata | proiettata (passata finale) | congelata (vista dopo F7) |

"Attesa" = errore d'attesa del job (`isCalendarJobWaitError`): il job torna in coda senza consumare tentativi e riparte da solo a transizione finita.

## 8. Lock e ordine

| Lock | Chi | Note |
|---|---|---|
| `cal-migration` (sessione, pool principale) | run di cutover, rollback, finalize, anteprima, ri-baseline (esecutore); job `shadow_mirror` e `reverse_projection` con `pg_try_advisory_lock` | per tutta la durata del run |
| `cal-write` esclusivo | `withTransitionGate` (passo `quiesce`) | sempre dopo `cal-migration`, solo per il drenaggio e la quiescenza |
| riga di `calendar_backend_state` FOR UPDATE | passi di stato | barriera delle scritture legacy (FOR SHARE della guardia 166) |
| riga del journal FOR UPDATE | passi di stato | nella stessa transazione dello stato |
| `cal-sync:*` | sync del cutover e del rollback | mai dentro il gate esclusivo |

Ordine ammesso: `cal-migration → cal-write`, `cal-migration → riga di stato`, `cal-migration → cal-sync:*`. Mai `cal-write` attorno a una sync o a un job.

## 9. Codici

### 9.1 SQLSTATE

`CD166` (`CALENDAR_EVENTS_GUARD_SQLSTATE`): scrittura su `calendar_events` fuori da mode postgres senza il GUC. Un percorso che la incontra (`isCalendarEventsGuardError`) la traduce in `CalendarUnavailableError('transition')`; in pratica la facade risponde prima con 503 (`resolveWriteStoreKind`).

### 9.2 Errori REST e motivi

- `MIGRATION_ERROR_STATUS` aggiunge `TRANSITION_IN_PROGRESS: 409`.
- `PRECONDITION_REASONS` aggiunge: `MODE_NOT_RADICALE`, `TRANSITION_ACTIVE`, `NO_ACTIVE_TRANSITION`, `TRANSITION_NOT_ABORTABLE`, `ROLLBACK_WINDOW_EXPIRED`, `FINALIZE_TOO_EARLY`, `SHADOW_PARITY_REQUIRED`, `DEVICE_MATRIX_REQUIRED`, `BACKUP_TOO_OLD`, `OPEN_CONFLICTS`, `REVERSE_FAILED_OPEN`, `DEAD_JOBS`, `HEALTH_NOT_GREEN`, `PREVIEW_REQUIRED`, `PREVIEW_STALE`, `PROBE_UNAVAILABLE`, `CONTROL_PLANE_UNAVAILABLE`, `ARCHIVE_DEVICE_WRITABLE`.
- `MIGRATION_CONFIRMATIONS` aggiunge `finalize: 'CHIUDI LA FINESTRA'`, `cutoverAbort: 'ANNULLA IL PASSAGGIO'`, `rollbackEmergency: 'ROLLBACK DI EMERGENZA'` (`cutover` e `rollback` c'erano già).

### 9.3 Codici dei run (`MIGRATION_RUN_ERROR_CODES`)

Aggiunti: `TRANSITION_CONFLICT`, `GATE_TIMEOUT`, `QUIESCENCE_TIMEOUT`, `PROBE_UNAVAILABLE`, `CONTROL_PLANE_UNAVAILABLE`, `EPOCH_CONFLICT`, `CUTOVER_ABORTED`, `ROLLBACK_ABORTED`, `PREVIEW_CHANGED`, `VERIFY_RED`, `REVERSE_FAILED`. Si usano come `details.run_error_code` di un `TransitionError` (l'esecutore li registra in `error_code`) e come `outcome_code` di una transizione annullata.

### 9.4 Journal e proiezione inversa

Passi: `CUTOVER_STEPS`, `ROLLBACK_STEPS`, `FINALIZE_STEPS`, `abort`; stati `JOURNAL_STEP_STATUSES`. Degradi: `DEGRADATION_CLASSES`. Smoke: `SMOKE_CHECK_CODES`.

## 10. Cron, bootstrap e variabili (per l'integrazione)

| Avvio | Funzione | Proprietario |
|---|---|---|
| boot, prima del control-plane del calendario | `enforceCalendarApiLevelAtBoot()` | CUTOVER |
| boot, con gli altri handler | `registerReverseProjectionJob()` | REVERSE |
| boot, dopo il worker (solo con Radicale configurato) | `startReverseProjectionTrigger()`; log della transizione attiva (`readTransitionView`) | REVERSE, fondazione |
| shutdown | funzione restituita da `startReverseProjectionTrigger()` | REVERSE |
| cron 15 min (`calendar-reverse-sweep`) | `runReverseProjectionSweep()` (solo mode radicale) | REVERSE |
| route | `calendarMigration` già montato (F3) | UI |

| Variabile | Default | Significato |
|---|---|---|
| `RADICALE_PROBE_PASSWORD` | — (già F3) | password di `caldes-probe`: obbligatoria per le transizioni (quiescenza) |
| `CAL_ROLLBACK_WINDOW_DAYS` | 30 | default della finestra proposta dal wizard (`F4_LIMITS.rollbackWindowDays`), entro 14..90 |

## 11. Test minimi per gruppo

Ogni gruppo scrive i propri test in `apps/api/test/calendar/<modulo>.test.ts` (senza Radicale) e `apps/api/test/integration/<modulo>.test.ts` (Radicale reale con `useRadicale()`, saltati senza `RADICALE_BIN`), con etichette proprie (`useFixtures('<gruppo>-…')`). La fondazione ha già: guardia, barriera, cascate e journal (`migration-166`), transizioni senza Radicale (`calendar/migration-transition`: ripresa, riavvio senza policy live, gate con scritture, job e MCP, quiescenza finta, epoch e annullamento) e con Radicale (`integration/migration-transition`: MCP in attesa sul gate, PUT del device 403 dopo il freeze, riavvio, epoch reale).

- **CUTOVER**: cutover completo su una copia sintetica della produzione (stato, epoch, policy live, contratti F0 sullo store Radicale, smoke senza residui); verifica rossa → annullamento con mode postgres e policy shadow; kill a ogni passo (hook `beforeStep`) con ripresa corretta; prenotazione committata a cavallo del freeze con la proiezione; criteri del §3.2 uno per uno; livello dell'API; archivio in sola lettura.
- **REVERSE**: `projectObject` sulle fixture (RDATE e serie New York → busy legacy identico a Radicale; UID dell'invito duplicato in lavoro, durata zero, evento senza SUMMARY, override con l'UID del master → righe sanificate e classificate, nessun job failed); proiezioni (annullata nella finestra → riga `cancelled`; riprogrammata → vecchia riga annullata); cancellazioni solo delle righe possedute; job con il lock e fuori finestra; GUC e guardia.
- **ROLLBACK**: anteprima con degradi e `busy_identical`; rollback completo (policy frozen prima della fotografia, PUT del device 403, epoch, shadow); anteprima cambiata → annullamento; emergenza; kill a ogni passo; ri-baseline per categoria (A-G) e nuovo cutover a zero scritture (oggetto dell'iPhone con href proprio, oggetti toccati da admin e MCP); `DERIVED_EDITED`; finalize con i blocchi; backup con `calendar_events` vista (simulata nel test) ed export v2 (zip leggibile, manifest).
- **UI**: route (conferme, chiavi, `TRANSITION_IN_PROGRESS`, `PHASE_NOT_AVAILABLE` sparito), stato del wizard per ogni mode, build dell'admin; ritocchi (route della saga sui due store, all-day, fuso, UNTIL).

**Criterio di uscita della F4** (piano): prova generale in staging riuscita due volte, compresi i kill durante cutover e rollback con ripresa corretta; rollback con busy identico e degradi pari a quelli dell'anteprima; secondo cutover a zero scritture per gli oggetti non toccati; contratti verdi in mode radicale.

## 12. Precisazioni rispetto al design

1. La guardia 166 blocca anche in mode `finalized` (il design elenca cutover, radicale e rollback): dopo il finalize nessuno deve scrivere la tabella legacy, e la 167 (F7) la rinomina con il trigger.
2. Le DELETE in cascata di un calendario, di un'iscrizione o di un master già cancellati passano la guardia anche senza GUC (il design affida le cascate al GUC della delete del calendario, che resta): RadicaleStore cancella anche iscrizioni e sidecar, e una cascata non è mai una scrittura diretta.
3. La guardia legge lo stato con `FOR SHARE`: la transazione che cambia mode attende le scritture legacy già fatte e ogni scrittura successiva fallisce. Nessun gate `cal-write` per PgLegacyStore (f2 precisazione 6 la rimandava alla F4): la barriera nel database copre ogni scrittore di `calendar_events`, anche fuori dalla facade, senza attese sul pool calendario in mode postgres.
4. Il gate `cal-write` esclusivo si tiene per il drenaggio e la quiescenza, non fino al rilascio del freeze (design §13.10 passo 5): dopo, le scritture restano bloccate dallo stato (mode di transizione o `write_freeze`), che ogni scrittore rilegge dentro il gate, e il gate non resta attorno a sync o job (regola 1 contro lo stallo).
5. `write_freeze` resta attivo dal freeze del cutover fino al passo `unfreeze`, dopo sync, prima passata della proiezione inversa e riconciliazione delle prenotazioni: i device scrivono solo con l'indice e PG allineati (il design dice "fine del freeze" al passo 6 e "i device scrivono entro 1 s" al passo 5).
6. Un nuovo cutover dopo un rollback non richiede altri 7 giorni di parità: basta una verifica completa accettabile dopo il rollback (la prova generale della F4 fa cutover, rollback e nuovo cutover nella stessa sessione).
7. Il rollback si annulla da solo se l'anteprima ricalcolata dopo la quiescenza differisce da quella confermata (garanzia "degradi pari a quelli dell'anteprima"), salvo emergenza con la seconda conferma.
8. Il journal delle transizioni sta in tabelle proprie (`cal_migration_transitions`, `cal_migration_journal`) invece che nei params del run (come l'inizializzazione della F3): una transizione sopravvive al run che la esegue e si riprende con un run nuovo.
9. La proiezione inversa ha uno stato per risorsa (`cal_migration_reverse_state`) e marca con `caldes_object_id` ogni riga che scrive, non solo le derivate: possesso esplicito, incrementalità per etag, REVERSE_FAILED tracciati.
10. `TRANSP:TRANSPARENT` diventa `status = 'tentative'` nel legacy (classe `SEMANTIC_TRANSP`), altrimenti il busy dopo il rollback bloccherebbe ciò che Radicale non blocca; `SANITIZED_STATUS` e `REPR_LOSS_PROPERTY` si aggiungono alle classi del design.
11. `DERIVED_EDITED` è forzabile con la semantica "mantieni la risorsa di Radicale" (nessuna scrittura, ledger riallineato): il design dice "da risolvere a mano", e la forzatura è la decisione manuale esplicita.
12. Rollback: `cutover_at`, `cutover_by` e `rollback_until` tornano NULL in mode postgres (la storia è nel journal); `api_min_version` resta 4 perché le righe derivate richiedono il codice della F4.
13. L'archivio della Fase 0 è in sola lettura per i device tramite la policy (`origin = 'migration'` in `readonly`) invece di un ruolo nuovo (questione aperta 1 della F3): nessun CHECK da allargare né cambio ai plugin.

## 13. Questioni aperte

1. **Worker dedicato ai run** (f3 §19.7): i run di transizione girano nel worker sequenziale dei job; nessun passo attende un job, ma durante un cutover lungo gli altri job attendono. Valutare in F5 un worker separato per `migration_run`.
2. **Proiezione inversa delle iscrizioni**: non proiettate (le righe `ics_pull` legacy restano congelate e il pull legacy le riscarica dopo il rollback grazie ai validatori azzerati); un'iscrizione creata nella finestra esiste solo come sidecar e riga di `calendar_subscriptions`, che il legacy vede al ritorno.
3. **Calendari creati o cancellati dai device nella finestra**: un calendario nuovo del device ha già la riga del sidecar (discovery, `origin = device`) e la proiezione inversa ne scrive le righe; uno cancellato dal device (DELETE della collezione negata dai permessi) non può accadere. Una collezione creata dall'admin nella finestra segue la stessa strada.
4. **Retention di `cal_migration_transitions`**: nessuna (poche righe, storico delle transizioni); il journal segue la transizione.
5. **UID pubblicati di oggetti nati nella finestra** (dalla prova generale, aperta): il feed dell'indice pubblica invariati gli UID con '@' degli oggetti senza `legacy_uid`, mentre il feed legacy aggiunge sempre `@<dominio>`. Dopo un rollback cambiano quindi, per gli abbonati, gli UID di: prenotazioni prese nella finestra (`<uid>@caldes.it` → `<uid>@caldes.it@<dominio>`), oggetti dei device con UID contenente '@' e oggetti con UID sanificato (SANITIZED_UID). Istanze e orari restano identici (il busy è identico), ma l'app dell'abbonato può mostrare un duplicato fino alla scomparsa del vecchio UID. Proposta per la F5: pubblicare nel feed dell'indice `<uid>@<dominio>` anche per le proiezioni delle prenotazioni non migrate e per gli UID con '@' degli oggetti nati da Radicale (con l'aggiornamento della voce di `allowed-diffs.json` del feed), oppure proiettare in PG un UID che il feed legacy ripubblica uguale.

## 14. Aggiornamenti dell'integrazione (v1.1)

1. **File fuori dalla mappa del §0**, confermati dall'integrazione: `apps/api/src/lib/calendar/migration/verify.ts` (CUTOVER: `runVerifyWithGuard(ctx, guard)` per la verifica del delta con il mode di transizione; ROLLBACK: V2 salta le sorgenti derived, V3 e V5 riconducono le righe derivate all'oggetto d'origine; integrazione: i punti 4 e 5 qui sotto); `apps/api/src/lib/calendar/export-v2.ts` (ROLLBACK: zip e manifest dell'export v2, usato da `routes/backup.ts`); `apps/api/test/calendar/migration-routes.test.ts` (UI: passo 6 `locked`, fase F4, niente PHASE_NOT_AVAILABLE).
2. **Esportazioni aggiunte** (compatibili, nessuna firma del contratto cambiata): REVERSE `legacyBusyAfterPlan`, `closePendingReverseProjectionJobs`, `withReverseMigrationLock`, `handleReverseProjectionJob`, `simulateLegacyOccurrences`, `legacyBusyFromRows`, `ReverseLockBusyError`, `BookingProjectionInput` (definito in `reverse-projector.ts`), `ProjectObjectInput.existingUids` e `ReverseObjectPlan.horizon_until` opzionali; ROLLBACK `rollbackBlockers`, `computeRollbackPreview`, `summarizeReversePlan`, `mergeBusy`, `sameBusy`, `finalizeBlockersDetailed`, `decideRebaseline`, `isDerivedObject`, `LegacyDerivedGroup`, `LegacySource.derived` e un parametro `deps` facoltativo su `runRebaseline`, `runRollbackPreview`, `runFinalize`, `runRebaselineRun`; UI `currentTransitionView`, `rollbackPreviewValidity`, `finalizeBlockersOf`, `TRANSITION_RESUME_CONFIRMATIONS`; CUTOVER `cutoverCriteria`, `reconcileBookingsAfterCutover`, `defaultRollbackWindowDays`.
3. **Proiezione inversa, SANITIZED_UID stabile**: una riga master già proiettata con l'UID sanificato (`<UID>@<collezione>`) lo riusa nelle passate successive e registra di nuovo il degrado SANITIZED_UID. Prima il degrado compariva solo alla prima passata: l'anteprima del rollback (che è sempre una passata successiva) non lo mostrava e lo stato per risorsa lo perdeva. Un UID ereditato come `legacy_uid` dopo una ri-baseline resta senza degrado (è l'identità legacy).
4. **Verifica dopo il rollback, V2**: una riga del ledger con `adopted`, `last_run_id` di un run `rollback` o `rebaseline`, `written_etag` uguale all'etag su Radicale e `legacy_hash` uguale a quello della sorgente non si confronta per campi: la riga legacy è la proiezione della risorsa (oggetto del device con DTSTART in UTC, senza STATUS né X-CALDES-*), non la sua sorgente. Senza questa regola la verifica dopo un rollback con oggetti dei device era rossa e bloccava il nuovo cutover (precisazione 6 del §12).
5. **Verifica dopo il rollback, V3 e V5**: nuovo motivo atteso `REVERSE_DEGRADED` (giallo da accettare) per le differenze di occorrenze e di feed di un oggetto con un degrado della proiezione inversa che cambia le occorrenze (SANITIZED_DURATION, SEMANTIC_TRANSP, SANITIZED_STATUS in `cal_migration_reverse_state.degradations`) e riga del ledger ri-allineata e non più toccata (stessa condizione del punto 4). Sono le differenze già mostrate dall'anteprima del rollback.
6. **Wizard**: l'azione `cutover_abort` del passo 6 vale anche per il rollback in corso; il client chiama `/cutover/abort` o `/rollback/abort` secondo `transition.kind`.
7. **Cablaggio (§10) fatto**: `enforceCalendarApiLevelAtBoot()` in `src/index.ts` prima del control-plane; `registerReverseProjectionJob()` con gli altri handler e, dopo il worker con Radicale configurato, log della transizione rimasta attiva (`readTransitionView`) e `startReverseProjectionTrigger()` in `cron/calendar-radicale.ts`, con l'arresto nel `stopCalendarBackground`; cron `calendar-reverse-sweep` (15 minuti, `runCalendarReverseSweep`) in `cron/index.ts`; `CAL_ROLLBACK_WINDOW_DAYS` in `.env.example`; job `calendar-integration` della CI con il passaggio F4 e timeout di 45 minuti.
8. **Prova generale** (`apps/api/test/integration/migration-f4-rehearsal.test.ts`): migrazione F3 dalle route fino allo shadow verde (parità di 7 giorni emulata con giri notturni retrodatati), cutover con un kill prima e uno dopo il punto di non ritorno e ripresa dal wizard, uso misto con i casi A e C, rollback con un kill prima e uno dopo l'epoch, busy identico e anteprima ricalcolata uguale a quella confermata, nuovo cutover a zero scritture (caso B), rollback d'immagine simulato; feed con gli stessi token e le stesse istanze in ogni stato, salvo le differenze del §13.5.
