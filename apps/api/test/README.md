# Test dell'API

Test automatici di `@calicchia/api` con `node:test` eseguito da `tsx` (nessun framework aggiuntivo). Girano in-process contro l'app Hono reale (`src/app.ts`) e un Postgres locale dedicato; i test di integrazione avviano anche un Radicale reale. Nella fase F0 del passaggio a Radicale servono a congelare il comportamento attuale (contratti di sito, admin, MCP, feed e agenda) prima di toccare lo storage. Vedi [piano](../../../docs/calendar-radicale/piano.md) e [design §15](../../../docs/calendar-radicale/design.md).

## Requisiti

- Node 22.12 o successivo (`.nvmrc`) e dipendenze installate (`pnpm install`).
- Un Postgres locale con un database **dedicato ai test**, indicato in `TEST_DATABASE_URL`.
- Solo per `test/integration`: `python3` 3.9 o successivo (mock di verify-credentials) e, facoltativo, Radicale 3.7.8 in `RADICALE_BIN` (vedi [Radicale](#radicale-helpersradicalets)).

```sh
export TEST_DATABASE_URL=postgresql://caldes:caldes@localhost:5432/caldes_test
```

`TEST_DATABASE_URL` è obbligatoria e non viene mai letta da `.env`. I test si rifiutano di partire se l'host non è `localhost`, `127.0.0.1` o `::1`, oppure se il nome del database non contiene `test` o `caldes_f0`. `DATABASE_URL` viene sempre sovrascritta con `TEST_DATABASE_URL`, anche se è già impostata nella shell.

## Comandi

Da `apps/api`, oppure dalla radice con `pnpm --filter @calicchia/api <script>`:

| Script | Cosa fa |
|---|---|
| `pnpm test:migrate` | Applica le migrazioni al database dei test, con lo stesso runner del boot dell'API e senza `.env`. |
| `pnpm test` | Esegue tutte le suite (`test/**/*.test.ts`). |
| `pnpm test:smoke` | Esegue lo smoke dell'infrastruttura (`test/smoke`). |
| `pnpm test:contracts` | Esegue i test di contratto (`test/contracts`). |
| `pnpm test:calendar` | Esegue i casi del calendario (`test/calendar`). |
| `pnpm test:integration` | Esegue i test di integrazione (`test/integration`): Radicale reale, mock di verify-credentials, inventario. |
| `pnpm typecheck:test` | Typecheck di `src`, `test` e degli script F0 (`tsconfig.test.json`). |

Script della fase F0 collegati ai test (stessa cartella):

| Script | Cosa fa |
|---|---|
| `pnpm calendar:inventory -- --out <dir>` | Inventario del calendario in sola lettura contro `DATABASE_URL` (nessun `.env` letto), report JSON e Markdown. |
| `pnpm calendar:fix-dst` | Dry-run della correzione delle eccezioni DST; `-- --apply --expect-plan <hash>` applica il piano visto. Legge `../../.env` se esiste. |
| `pnpm contract:mcp-snapshot` | Rigenera la lista vincolante dei tool MCP di calendario (`__snapshots__/mcp-calendar-tools.schema.json`). |
| `pnpm contract:mcp-check` | Verifica la lista senza database (exit 1 se diversa). |

Le migrazioni vengono applicate anche all'avvio di ogni file di test: `test:migrate` serve a separare un eventuale errore di schema dagli errori dei test, ad esempio in CI.

Gli script passano da `test/run.ts`, che mette le opzioni di `node --test` prima dei pattern. Se le opzioni venissero dopo il glob, node le tratterebbe come argomenti dello script e le ignorerebbe senza avvisare.

```sh
pnpm test -- --test-update-snapshots           # rigenera gli snapshot
pnpm test -- --test-name-pattern=feed          # solo i test con "feed" nel nome
pnpm test test/smoke/infra.test.ts             # un file
pnpm test contracts calendar                   # più suite
```

`pnpm test` comprende anche `test/integration`: senza Radicale le suite che lo richiedono vengono saltate con il motivo, mentre il mock di verify-credentials e l'inventario girano comunque.

Il runner usa sempre `--test-concurrency=1`, quindi i file girano in sequenza sullo stesso database. Aggiunge `--experimental-test-snapshots` (su Node 22.12 `t.assert.snapshot` esiste solo con questo flag, dalle 22.13 è un no-op) e silenzia gli `ExperimentalWarning`.

## Struttura

```
test/
  run.ts                 runner (suite, opzioni, flag dipendenti dalla versione di Node)
  helpers/
    preload.mjs          --import: carica env.ts nel thread principale prima di src/
    env.ts               ambiente di test e protezione del database
    db.ts                migrazioni, prefissi, pulizia, audit, baseline, chiusura del pool
    http.ts              richieste in-process, JWT admin, token di gestione prenotazione
    fixtures.ts          dati del dominio calendario
    normalize.ts         normalizzazione per gli snapshot
    clock.ts             orologio fisso (Date)
    radicale.ts          Radicale reale su porta effimera e mock di verify-credentials
    caldav.ts            client CalDAV minimale, parser XML e utilità iCalendar
    mock_verify.py       mock di POST /api/caldav-backend/verify-credentials (stdlib)
  smoke/infra.test.ts    prova che tutti i pezzi funzionano insieme
  contracts/             contratti F0 (sito, admin v1, MCP, feed, agenda, capacity/slot)
    _json-contract.ts    store JSON degli snapshot di contratto e differenze ammesse
    _http-contract.ts    voci di snapshot per i contratti HTTP
    _admin-v1.ts         alias, effetti sul DB e server ICS simulato del contratto admin
    _mcp-scenario.ts     scenario e alias del contratto MCP
    allowed-diffs.json   differenze ammesse fra la baseline F0 e gli store successivi
    __snapshots__/       snapshot JSON committati, uno per contratto
  calendar/              casi del calendario (verify-calendar*, correzione DST)
  integration/           Radicale reale, plugin di autenticazione di prova, inventario
```

## Ambiente (`helpers/env.ts`)

Molti moduli leggono `process.env` al momento dell'import: `src/db/index.ts` crea il pool, `src/app.ts` controlla `CORS_ORIGINS` e crea `UPLOAD_DIR`, `lib/calendar/token.ts` fissa il secret dei token di gestione, captcha e logger leggono la loro configurazione. Per questo `env.ts` viene valutato prima di qualsiasi modulo di `src/`. Il runner lo precarica con `--import ./test/helpers/preload.mjs` e ogni helper lo importa per primo.

- **Valori fissi**: `NODE_ENV=test`, secret noti (`JWT_SECRET`, `BOOKING_TOKEN_SECRET`, `WEBHOOK_ENCRYPTION_KEY`, `CALDAV_SERVICE_TOKEN`), URL pubblici su domini `.test` (`https://api.caldes.test`, `https://sito.caldes.test`, `https://admin.caldes.test`, `https://portale.caldes.test`) e directory di upload temporanee. Sono esportati come `TEST_ENV`.
- **Determinismo**: `TZ=UTC` nel processo e `TimeZone=UTC` nella sessione Postgres, come il container di produzione.
- **Ambiente ermetico**: vengono rimosse le variabili dei servizi esterni (Resend/SMTP, Telegram, captcha, Stripe/PayPal/Revolut, AI, S4, WhatsApp…). Nessun test manda email o chiama API esterne, e il captcha viene saltato come in sviluppo.
- **Log**: pino è impostato a `silent` e il logger HTTP di Hono è filtrato. Per indagare: `TEST_LOG_LEVEL=debug` e `TEST_HTTP_LOG=1`.
- **`withEnv(overrides, fn)`**: cambia alcune variabili solo per `fn` e poi le ripristina. Vale solo per le variabili lette al momento della chiamata, ad esempio `NODE_ENV=production` per far rifiutare il captcha non configurato con un 403.

## Database (`helpers/db.ts`)

- **`useTestDatabase({ resetBaseline? })`**: va chiamata in cima al file ed è idempotente. Applica le migrazioni prima del primo test e chiude il pool dopo l'ultimo; senza la chiusura il processo resterebbe appeso. Con `resetBaseline: true` riporta prima il dominio calendario alla baseline.
- **`onDatabaseReady(task)` / `onBeforeDatabaseClose(task)`**: eseguono `task` dentro il `before` di `useTestDatabase` (dopo migrazioni, baseline e pre-pulizia delle fixture) e nel suo `after` (prima della chiusura del pool). Lo scenario condiviso di un file va costruito qui e **non** con un `before()` di primo livello: con `node --test` i `before()` di primo livello partono subito e in parallelo fra loro, quindi la creazione dei dati finirebbe in gara con migrazioni e `resetCalendarBaseline()` (fino al deadlock). Gli `after()` di primo livello vanno bene per ciò che non usa il database (orologio, flush degli snapshot).
- **`resetCalendarBaseline()`**: porta il dominio calendario allo stato di un database appena migrato. Restano solo i calendari seminati (`lavoro`, `personale`, `bookings`, `scadenze`), nessun evento, prenotazione, iscrizione o app-password, e lo schedule di default con lun-ven 09-13 e 14-18. Rimuove anche i residui di run interrotti e i dati del template, ad esempio il calendario `festivita` con le festività create dal cron. È distruttiva, quindi è ammessa solo sul database dei test. Le righe seminate non vanno modificate: per ogni scenario si creano dati propri.
- **`testPrefix(label)`**: genera un prefisso `tst-<etichetta>`, deterministico e quindi stabile negli snapshot. Con `{ random: true }` aggiunge un suffisso casuale. Rifiuta un prefisso che ne contiene un altro già usato nel processo, o che è contenuto in uno già usato.
- **`cleanupTestData(prefix, tracked)`**: cancella in ordine di foreign key tutto ciò che porta il prefisso (slug, nomi, titoli, email, label) o è registrato per id. Copre prenotazioni con proiezioni e lead, tipi di prenotazione, schedule, calendari con le cascate, eventi, iscrizioni, app-password, token MCP e device, e le righe di `audit_logs` scritte dai trigger.
- **`databaseNow()` / `cleanupCalendarAudit({ since, prefixes, ids })`**: per le righe di `audit_logs` che la pulizia per prefisso non riconosce (eventi cancellati dalle route o dal sync delle iscrizioni, aggiornamenti dei calendari seminati). `since` si legge con `databaseNow()` in `onDatabaseReady`, perché i trigger usano `NOW()` del server e non l'orologio fermo.

## Fixture (`helpers/fixtures.ts`)

`useFixtures('nome-gruppo', { resetBaseline? })` crea un gruppo con il proprio prefisso, registra il database e pulisce sia prima del primo test (residui di un run interrotto) sia dopo l'ultimo. Le fixture usano le funzioni di `src/lib/calendar` dove esistono, così i dati hanno la stessa forma di quelli di produzione.

| Metodo | Come crea il dato |
|---|---|
| `calendar({ key, name, ... })` | `createCalendar` con slug e nome prefissati |
| `holidayCalendar()` | calendario con lo slug di produzione `f`, stesso nome e flag di `getOrCreateFestivitaCalendar` (che lo ritrova per nome); richiede la baseline |
| `holidays(cal, { year, only? })` | stessa logica del cron (`date-holidays`, timed 00:00→24:00 Roma, `source='system'`, `it-holiday-YYYY-MM-DD`) |
| `closure(cal, { from, to })` | stesso calcolo di `POST /closures` |
| `event(...)`, `allDayEvent(...)` | `createEvent`; per gli all-day si sceglie l'ancora `rome` (editor admin) o `utc` (iscrizioni ICS) |
| `series({ rrule, exdates, overrides })` | master con `createEvent` e override modificati o cancellati con `createOccurrenceOverride` |
| `schedule({ slots, overrides })`, `eventType({ ... })` | INSERT con colonne e default delle route admin; lo schedule ha `is_default=false`, il tipo `min_notice_hours=0` |
| `booking({ eventType, start, status })` | INSERT con la stessa riga di `createBooking` e la proiezione di `projectBookingEvent` nel calendario `bookings`, senza vincoli legati ad "adesso" |
| `bookingViaLib({ eventType, start })` | flusso reale `createBooking` (capacità, buffer, lock, proiezione); da usare con `freezeTime()` |
| `appPassword({ username })` | `createAppPassword` (default `federico`) |
| `subscription({ calendar, events \| ics })` | `createSubscription`, poi `replaceSubscriptionEvents` senza rete |
| `mcpToken({ scope })`, `deviceToken()` | stesso formato di `POST /api/mcp-tokens` e `POST /api/device/pair` |

Utility esportate: `romeIso('2027-03-15', '09:30')`, `utcMidnightIso`, `addDays`, `addMinutes`, `OFFICE_HOURS`. `fx.email('cliente')` e `fx.name('Titolo')` producono valori che la pulizia riconosce. `fx.track(kind, id)` registra le righe create via HTTP che non portano il prefisso.

## HTTP (`helpers/http.ts`)

- **`api.get/post/put/patch/delete(path, { query, body, headers, auth, ip })`**: esegue `app.request()` con l'intera catena di middleware. La risposta contiene `status`, `headers`, `contentType`, `text` e `json`.
- **`auth`**:
  - `'admin'` usa un JWT firmato con lo stesso `signToken` del login, per un admin di test creato in `users` e `profiles` con id fisso (`TEST_ADMIN`);
  - `{ bearer }` invia un token MCP, device o un JWT costruito con `signTestToken({ role, authAt })`, utile per i casi 401 e 403;
  - `{ caldavService: true }` usa il token di servizio del backend CalDAV.
- **Rate limit**: ogni richiesta riceve un IP diverso in `X-Forwarded-For` (blocco 198.18.0.0/15), quindi i limiter in memoria non scattano. Per provarli si passa lo stesso `ip` a più richieste.
- **Token di gestione**:
  - `bookingManageToken(uid)` genera il token delle email;
  - `expiredBookingManageToken(uid)` genera un token scaduto;
  - `bookingManageTokenWithSecret(uid, secret)` genera un token contraffatto;
  - `bookingManagePath(uid, token, 'cancel' | 'reschedule' | 'ics')` costruisce il percorso.

## Orologio (`helpers/clock.ts`)

`freezeTime('2027-01-04T07:00:00Z')` / `restoreTime()` / `withFrozenTime()` fermano `Date` (MockTimers di node:test). `setTimeout` e `setInterval` restano reali. Servono per slot (min_notice e max_advance), `createBooking`, la finestra del feed ICS e i token. Usare date fisse nel futuro, ad esempio nel 2027, e fermare l'orologio a un istante precedente.

Limite: `NOW()` nelle query SQL usa l'orologio reale di Postgres. Ad esempio `GET /closures` filtra con `end_time > NOW() - 30 giorni`, e `cancelled_at` e `approved_at` sono `NOW()`.

## Snapshot

### Contratti (`contracts/_json-contract.ts`)

I contratti F0 salvano un file JSON leggibile per contratto in `contracts/__snapshots__/` (`<contratto>.contract.json`, oppure `mcp-calendar-tools.{schema,outputs}.json`), con una voce per caso (`"<gruppo>/<caso>": { request, status, headers, body | ics, effects }`). Il confronto ignora l'ordine delle chiavi ma non quello degli array, e fallisce con il percorso JSON e i due valori.

```sh
UPDATE_SNAPSHOTS=1 pnpm test test/contracts/feed.contract.test.ts   # riscrive i casi eseguiti
pnpm test -- --test-update-snapshots                                # equivalente
```

In un run filtrato (`--test-name-pattern`) gli altri casi del file restano invariati; in un run completo i casi non più eseguiti vengono rimossi, e il test di copertura di ogni contratto fallisce se nello snapshot ne restano. Prima di rigenerare va verificato che il cambiamento sia voluto.

`contracts/allowed-diffs.json` elenca le differenze ammesse fra la baseline F0 e gli store successivi (`diffs`, filtrate per `contract`, glob sull'id del caso, JSON Pointer con `*` e `**` e `stores`, scelto con `CALENDAR_BACKEND`). Oggi `diffs` è vuoto; `planned` documenta quelle previste dal design §12, da spostare in `diffs` quando esiste il codice che le produce.

### Normalizzazione (`helpers/normalize.ts`)

```ts
const n = createNormalizer().alias(cal.id, 'cal:f');
t.assert.snapshot(n.normalize(res.json));
t.assert.snapshot(n.normalizeIcs(res.text));
```

Il normalizzatore sostituisce con segnaposto numerati per prima apparizione e condivisi fra le chiamate:

- gli UUID diventano `<id:N>`, anche dentro testi e URL;
- gli uid generati diventano `<uid:N>`;
- token e password diventano `<token:N>`;
- i timestamp di sistema (`created_at`, `updated_at`, `cancelled_at`…) diventano `<timestamp>`;
- negli ICS, DTSTAMP, CREATED e LAST-MODIFIED vengono fissati, dopo l'unfold delle righe.

Ordine degli elementi, ordine delle chiavi e campi semantici (`start_time`, `end_time`, `recurrence_id`, `exdates`, `status`, `source`…) restano invariati. Per casi semplici fuori dai contratti si può usare `t.assert.snapshot`: gli snapshot nativi (`*.test.ts.snapshot`) stanno accanto al file di test e vanno committati.

## Radicale (`helpers/radicale.ts`)

- **`radicaleAvailability()`**: prova sincrona (`<bin> --version`), utilizzabile nelle opzioni `skip` di `describe`. Il binario è `RADICALE_BIN` oppure `radicale` nel `PATH`. Senza binario le suite vengono saltate con il motivo; con `RADICALE_BIN` impostata oppure `RADICALE_REQUIRED=1` l'assenza è un errore.
- **`useRadicale(options)` / `startRadicale(options)`**: un Radicale reale con config generata (default del design §3.2: storage multifilesystem, limiti, permessi sulle collezioni), utenti htpasswd oppure un plugin di autenticazione o dei rights, porta scelta dal sistema e directory temporanea rimossa allo stop.
- **`useMockVerify(options)` / `startMockVerify(options)`**: il mock di verify-credentials (`mock_verify.py`, solo libreria standard) con principal canonico, modalità di guasto (`deny`, `error`, `unavailable`, `rate_limited`, `slow`, `garbage`, `drop`) e registro delle chiamate (password mai in chiaro).
- **`CalDavClient`** (da `helpers/caldav.ts`): PUT/GET/DELETE con precondizioni, PROPFIND, PROPPATCH, MKCALENDAR, calendar-query, calendar-multiget e sync-collection. Con `fromAddress('127.0.0.2')` la connessione parte da un altro indirizzo di loopback, per i test del peer TCP di F1 senza reti Docker.

Debug: `TEST_RADICALE_LOG=1` inoltra i log di Radicale e del mock su stderr, `TEST_RADICALE_KEEP=1` conserva la directory temporanea, `RADICALE_PYTHON` sceglie l'interprete del mock (default: il python del venv di `RADICALE_BIN`).

```sh
export RADICALE_BIN=/percorso/del/venv/bin/radicale   # pip install 'radicale==3.7.8' 'vobject==0.9.9'
pnpm test:integration
```

## Scrivere un test

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../helpers/http';
import { romeIso, useFixtures } from '../helpers/fixtures';

const fx = useFixtures('admin-eventi', { resetBaseline: true });

test('GET /events espande la serie', async () => {
  const cal = await fx.calendar({ key: 'lavoro' });
  await fx.series({
    calendar: cal, summary: 'Standup', rrule: 'FREQ=DAILY;COUNT=3',
    start_time: romeIso('2027-01-04', '08:00'), end_time: romeIso('2027-01-04', '08:30'),
  });
  const res = await api.get('/api/admin/calendar/events', {
    auth: 'admin', query: { calendar_id: cal.id, from: '2027-01-04T00:00:00Z', to: '2027-01-08T00:00:00Z' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.events.length, 3);
});
```

Regole:

- Date fisse nel futuro. Fermare l'orologio con `freezeTime` quando il codice confronta con "adesso".
- Un'etichetta diversa per ogni file. I dati creati via HTTP portano il prefisso (`fx.name()`, `fx.email()`, `fx.slug()`) oppure vengono registrati con `fx.track()`.
- Nella fase F0 non si modifica il codice in `src/`. Se un test rivela un bug, si documenta con `test.todo` oppure con un'asserzione del comportamento attuale e un commento, e si segnala.

## Comportamenti attuali congelati

In F0 i bug non si correggono in `src/`: i test asseriscono il comportamento attuale con un commento, oppure lo descrivono con `test.todo`. I principali, utili da sapere quando si scrivono nuovi test:

- `parseIcs` scarta tutti i VEVENT di un VCALENDAR: `BEGIN:VCALENDAR` incrementa il contatore dei blocchi da saltare (design §14). La fixture `subscription({ ics })` produce quindi zero eventi, ed è asserito nello smoke. Per avere eventi importati si usa `subscription({ events })`. Con eventi già importati il sync si annulla per la protezione anti-wipe (contratto admin, `subscriptions/*`).
- `fetchIcs` tratta il 304 come redirect: ogni sync condizionale fallisce con "Redirect 304 senza Location" (`subscriptions/sync-condizionale-304`).
- Un EXDATE o un `recurrence_id` salvato con l'ora UTC del DTSTART prima del fix DST non combacia più dopo il cambio dell'ora e l'occorrenza ricompare (design §13.4, `DST_SHIFTED_EXCEPTION`): asserito in `calendar/dst-fix.test.ts` prima della correzione, nel contratto admin e in quello MCP.
- `expandRRule.between` perde le occorrenze di una serie già iniziate prima di `from`; un UID con la forma di un UUID viene cercato come id; dopo una riprogrammazione la proiezione ha `url` null.
- Feed ICS: le occorrenze cancellate con override ricompaiono, gli override hanno un UID proprio, DTSTAMP cambia a ogni lettura (casi `test.todo` per F2 in `feed.contract.test.ts`).
- Agenda device: serie non espanse e giorno UTC invece che di Roma; capacity: confini delle settimane in UTC e timer in corso contato fino a fine settimana.
- Il plugin `apps/radicale/plugins/caldes_auth.py` con Radicale 3.7.8 risponde 500 a ogni richiesta autenticata (`Auth.login()` con la firma vecchia): congelato in `integration/radicale-smoke.test.ts`, da sostituire in F1.

## CI

Due job di `.github/workflows/ci.yml` girano su ogni PR verso `main`, entrambi con un Postgres 17 come service (database `caldes_test`) e Node 22.12:

- `api-tests`: `contract:mcp-check` (senza database), `test:migrate`, `typecheck:test` e `test`. Le suite che richiedono Radicale vengono saltate.
- `calendar-integration`: installa Radicale 3.7.8 e vobject 0.9.9 in un venv, imposta `RADICALE_BIN` e `RADICALE_REQUIRED=1`, poi esegue `test:migrate`, `typecheck:test` e `test:integration`. In F2 diventerà la matrice `CALENDAR_BACKEND=postgres|radicale` del design §15.
