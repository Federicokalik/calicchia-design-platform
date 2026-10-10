# Contratto del control-plane (F1)

Versione 1 del contratto fra l'API (TypeScript), i plugin di Radicale (`caldes_auth`, `caldes_rights`, Python) e il database (migrazione 162). Vincola la fase F1 del [piano](../piano.md) e le successive finché non viene aggiornato. Riferimenti al [design](../design.md): §1 (invarianti 6 e 7), §3.3 (plugin), §3.4 (matrice dei permessi), §3.5 (compose), §4 (162), §6.3 (identità), §13.1 (policy derivata), §16.2 (backup).

"DEVE", "NON DEVE" e "PUÒ" hanno il significato normativo consueto. Dove il contratto precisa o corregge il design lo dice esplicitamente (§13).

| Artefatto | Ruolo |
|---|---|
| [policy.schema.json](policy.schema.json) | `policy.json`: formato che il writer DEVE produrre |
| [heartbeat.schema.json](heartbeat.schema.json) | `heartbeat.json`: formato che il writer DEVE produrre |
| [volume-identity.schema.json](volume-identity.schema.json) | dead prop dell'identità sul principal e delle collezioni |
| [authcache.schema.json](authcache.schema.json) | cache persistita di `caldes_auth` |
| [verify-credentials.schema.json](verify-credentials.schema.json) | richiesta e risposte di `POST /api/caldav-backend/verify-credentials` |
| [fixtures/effective-mode.cases.json](fixtures/effective-mode.cases.json) | casi di conformità della modalità effettiva (§7.3), condivisi da TS e Python |
| [fixtures/rights-matrix.cases.json](fixtures/rights-matrix.cases.json) | casi di conformità dei permessi (§8), condivisi da TS e Python |
| `database/migrations/162_calendar_sidecar.sql` | sidecar, riconciliazione, stato del backend |
| `apps/api/src/lib/calendar/radicale/types.ts` | tipi, costanti e funzioni pure del contratto (`policyFromState`, `parsePolicy`, `effectiveDeviceMode`, `expectedRadicaleRights`...) |

## 1. Componenti, volumi e variabili

### 1.1 Volumi e percorsi

| Volume | Radicale | API | Contenuto |
|---|---|---|---|
| `radicale_collections` | `/data` (rw) | `/radicale-data` (ro) | `collections/collection-root/<principal>/…` (`filesystem_folder = /data/collections`), `.Radicale.lock`, cache degli item |
| `caldes_control` | `/control` (ro) | `/run/caldes-control` (rw) | `policy.json`, `heartbeat.json` e i loro file temporanei |
| `radicale_authcache` | `/var/lib/caldes-auth` (rw) | — | `authcache.json` |

- I file di `caldes_control` li scrive solo l'API (che nel container gira come root) con permessi `0644` in una cartella `0755`: Radicale (uid/gid 2999) li legge e non può modificarli. È l'unica garanzia d'integrità di policy e heartbeat, che quindi non sono firmati.
- `authcache.json` è `0600` dell'utente radicale, in una cartella `0700`.
- Le props del principal stanno in `<collections>/collection-root/<principal>/.Radicale.props`: per Radicale `/data/collections/collection-root/federico/.Radicale.props`, per l'API `${RADICALE_DATA_DIR}/collection-root/federico/.Radicale.props` con `RADICALE_DATA_DIR=/radicale-data/collections`.

### 1.2 Variabili e opzioni di Radicale

| Nome | Dove | Obbligatoria | Significato |
|---|---|---|---|
| `RADICALE_PRINCIPAL` | env | sì | Principal canonico (`federico`): `^[a-z0-9][a-z0-9_-]{0,63}$`, mai con prefisso `caldes-` |
| `CALDAV_BACKEND_URL` | env | sì | Base di caldav-backend sulla rete interna, es. `http://api-int:3001/api/caldav-backend` |
| `CALDAV_SERVICE_TOKEN` | env | sì | Bearer verso caldav-backend |
| `CALDES_SVC_CIDR` | env | sì | Una o più reti (separate da virgola, `ipaddress.ip_network(strict=True)`) della rete `caldav-int`, es. `172.31.250.0/29` |
| `CALDES_SVC_PASSWORD_SHA256` | env | sì | sha256 esadecimale minuscolo della password di `caldes-svc` |
| `CALDES_PROBE_PASSWORD_SHA256` | env | sì | sha256 esadecimale minuscolo della password di `caldes-probe` |
| `CALDES_PROBE_PASSWORD` | env | solo healthcheck | Password in chiaro letta da `caldes_healthcheck.py` |
| `CALDES_AUTHCACHE_KEY` | env | sì | Chiave HMAC della cache persistita, almeno 32 caratteri |
| `CALDES_AUTHCACHE_DIR` | env | no | Default `/var/lib/caldes-auth` |
| `CALDES_POLICY_FILE` | env | no | Policy letta da `caldes_auth` per `credential_epoch`. Default `/control/policy.json` |
| `CALDES_XRA_PEER_CIDR` | env | no | Reti (come `CALDES_SVC_CIDR`, loopback ammesso) del peer TCP da cui `X-Remote-Addr` è affidabile: in produzione il gateway della rete `dav-pub` della porta pubblicata. Da un altro peer l'header vale come assente (§9.4). Assente: qualsiasi peer, come prima |
| `[rights] caldes_policy_file` | config | no | Default `/control/policy.json` |
| `[rights] caldes_heartbeat_file` | config | no | Default `/control/heartbeat.json` |
| `[rights] caldes_reload_interval` | config | no | Secondi fra due controlli di policy, heartbeat e props (default `1`, ammessi 0..60). Solo per i test (`0`): in produzione resta il default |
| `TAKE_FILE_OWNERSHIP=false`, `TZ=UTC` | env | sì | Avvertenze dell'immagine tomsquest (design §3.1) |

- Una variabile obbligatoria assente o malformata DEVE far fallire il caricamento del plugin (Radicale non parte, il container resta unhealthy). Un plugin che parte "a metà" nasconderebbe l'errore.
- Radicale 3.7.8 accetta opzioni sconosciute nelle sezioni dei plugin, ma `Configuration.get()` non ha `fallback=`: un'opzione assente solleva `KeyError`, che il plugin DEVE intercettare per applicare il default.
- `[rights] caldes_policy_file` e `CALDES_POLICY_FILE` DEVONO puntare allo stesso file.

### 1.3 Variabili dell'API

| Nome | Default | Significato |
|---|---|---|
| `RADICALE_PRINCIPAL` | `federico` | Principal canonico, stesso valore di Radicale |
| `CALDES_POLICY_FILE` | `/run/caldes-control/policy.json` | Policy scritta dall'API |
| `CALDES_HEARTBEAT_FILE` | `/run/caldes-control/heartbeat.json` | Heartbeat scritto dall'API |
| `RADICALE_DATA_DIR` | `/radicale-data/collections` | Collezioni montate in sola lettura (identità, campanello) |
| `RADICALE_URL`, `RADICALE_SVC_USER`, `RADICALE_SVC_PASSWORD`, `RADICALE_PROBE_PASSWORD` | — | Client CalDAV di servizio e probe (design §3.5). `RADICALE_URL` è una origin senza percorso; `RADICALE_SVC_USER` vale `caldes-svc` se assente |
| `RADICALE_TIMEOUT_MS` | `10000` | Timeout di una richiesta del client di servizio |
| `CALDES_CONTROL_PLANE` | `auto` | `auto`: il writer di policy e heartbeat parte solo se la cartella di `CALDES_POLICY_FILE` esiste (volume montato); `on`: parte sempre e una cartella assente è un errore nei log; `off`: spento |
| `CALDES_IDENTITY_SOURCE` | `auto` | Sorgente dell'identità del volume (§4.3): `file` (mount di `RADICALE_DATA_DIR`), `remote` (PROPFIND come `caldes-svc`), `auto` (il mount se esiste, altrimenti `remote` se c'è `RADICALE_URL`, altrimenti nessuna sorgente: identità `unverified`) |
| `CALDES_API_VERSION` | `GIT_COMMIT_SHA`/`GIT_SHA`/`SOURCE_COMMIT` come `sha-<7>`, altrimenti `unversioned` | `api_version` del heartbeat |
| `CALDAV_SERVICE_TOKEN` | — | Bearer atteso su caldav-backend |
| `CALDAV_BACKEND_ALLOWED_PEERS` | — | Reti CIDR (separate da virgola, prefisso ≥ 1) dei peer TCP ammessi su `/api/caldav-backend/*`, controllate prima del Bearer: in produzione `172.31.250.3/32`, Radicale su `caldav-int`. Da un altro peer (il vhost pubblico dell'API) la risposta è 404 anche con il Bearer giusto; un valore non valido chiude il backend con 503. Assente: nessun controllo (sviluppo e test in-process) |

`api_version` del heartbeat è un identificativo della build (es. `sha-1a2b3c4`), ASCII stampabile senza spazi, al massimo 64 caratteri.

## 2. Stato del backend: `calendar_backend_state`

Riga singleton (`id = true`) creata dalla 162. La policy dei device DEVE derivare solo da questa riga e dal sidecar (§6); non esiste un'impostazione della policy a sé.

**Anticipata rispetto al design.** Il §4 del design colloca la tabella nella 165. In F1 servono però già l'identità del volume (§4), `credential_epoch` (revoca delle app-password, §9.6), `restore_guard_until` e `rebuild_required` (import dei backup, §16.2): la 162 crea la tabella con le sole colonne di F1. La 165 NON la ricrea: aggiunge con `ALTER TABLE … ADD COLUMN IF NOT EXISTS` le colonne `shadow_enabled`, `cutover_at`, `cutover_by`, `rollback_until`, `finalized_at`, `api_min_version`, `horizon_start`, `horizon_end`, e le tabelle della migrazione (`cal_migration_runs`, `_ledger`, `_items`).

| Colonna | Tipo | Default | Significato e scrittori |
|---|---|---|---|
| `id` | boolean | `true` | Singleton (`CHECK (id)`), immutabile |
| `mode` | text | `postgres` | `postgres`, `cutover`, `radicale`, `rollback`, `finalized` (§13.1 del design). In F1 resta sempre `postgres` |
| `write_freeze` | boolean | `false` | Freeze delle scritture; nella policy conta solo quando la base è `live` |
| `volume_id` | uuid | `NULL` | Identità del volume; `NULL` ⇔ `epoch = 0`. La scrive solo l'inizializzazione (§4.4) o la riassegnazione confermata |
| `epoch` | integer | `0` | `0` = non inizializzato, `1` dopo l'inizializzazione, `+1` a ogni cutover e rollback |
| `credential_epoch` | integer | `0` | `+1` nella stessa transazione di ogni revoca o rigenerazione di app-password (§9.6). Monotono, mai decrementato |
| `policy_version` | integer | `1` | Gestito dal trigger: `+1` a ogni modifica di `mode`, `write_freeze`, `volume_id`, `epoch`, `credential_epoch`, `restore_guard_until`, `rebuild_required`. Un valore scritto dall'applicazione viene ignorato |
| `restore_guard_until` | timestamptz | `NULL` | Dopo un import di backup: `now() + 48 h` (§16.2). Finché è nel futuro la policy è frozen |
| `rebuild_required` | boolean | `false` | Dopo un import di backup: `true` finché indice e verifica non sono verdi (in F1 non c'è indice: lo azzera la verifica post-ripristino o l'admin) |
| `updated_at` | timestamptz | `now()` | Gestito dal trigger |

Vincoli: `mode` fuori da `postgres` richiede `volume_id`; `(volume_id IS NULL) = (epoch = 0)`; DELETE e TRUNCATE della riga sono vietati da trigger.

Regole d'accesso:
- Scritture e decisioni rileggono la riga senza cache. Le letture per la sola visualizzazione possono usare una cache di 2 s (design §12).
- Se la riga non si legge (DB giù, riga assente, valori fuori contratto: `normalizeBackendState()` lancia), l'API NON DEVE scrivere una policy nuova e NON DEVE scrivere il heartbeat in quel giro. La policy già scritta resta; dopo 10 minuti senza heartbeat i device vanno in frozen da soli (§7).
- Ogni UPDATE che cambia `policy_version` emette `NOTIFY calendar_policy_changed` con payload `{"source":"state"}`.
- Nel backup JSON la tabella è del gruppo S: esportata, mai ripristinata (§16.2 del design). `session_replication_role=replica` spegne i trigger, quindi l'esclusione DEVE stare nel codice di `backup.ts`.

## 3. Sidecar dei calendari (162)

### 3.1 Colonne di `calendars`

| Colonna | Default | Significato |
|---|---|---|
| `collection_name` | `NULL`, poi = `slug` | Segmento di path della collezione sotto il principal; `UNIQUE`. Per i calendari esistenti è lo slug, compresi `c` e `f` |
| `role` | `user` | `user`, `bookings`, `holidays`, `deadlines`, `subscription`, `tasks` |
| `origin` | `admin` | `admin` (admin, MCP, codice legacy), `device` (discovery), `system` (calendari `is_system`), `migration` (strumento di migrazione, es. `archivio-fase0`) |
| `lifecycle` | `active` | `creating` (prenota il nome prima della MKCALENDAR), `active`, `deleting` (prima della DELETE della collezione) |
| `parent_calendar_id` | `NULL` | Per i sidecar delle iscrizioni: il calendario di destinazione. FK `ON DELETE SET NULL` |
| `device_visible` | `true` | `false` = collezione nascosta ai device |
| `components` | `{VEVENT}` | Sottoinsieme non vuoto di `VEVENT`, `VTODO`, `VJOURNAL` |
| `dav_props` | `{}` | Proprietà lette dalla discovery: chiavi in notazione Clark, valori stringa (es. `{"{urn:calicchia:caldes}role": "holidays"}`) |
| `missing_since` | `NULL` | Collezione sparita da Radicale (discovery, F2) |
| `needs_review`, `review_reason` | `false`, `NULL` | Segnalazione per l'admin. Codici: `device_new`, `missing_in_backup`, `collection_name_conflict`, `role_conflict`, `orphan_subscription` (`^[a-z][a-z0-9_]{0,63}$`) |

**Nomi di collezione.** Un nome valido (`calendar_collection_name_valid()` in SQL, `isValidCollectionName()` in TS) ha da 1 a 255 byte UTF-8, non contiene `/`, `\` né caratteri di controllo (U+0001–U+001F, U+007F–U+009F) e non inizia con `.` né con `_`. Il prefisso `_` è riservato alle collezioni di sistema (oggi solo `_canary`), che non hanno una riga nel sidecar e sono sempre nascoste ai device.

**Sola lettura per i device** (non per l'API, che mantiene le guardie di oggi, design §8): ruoli `bookings`, `holidays`, `deadlines`, `subscription`.

### 3.2 Colonne di `calendar_subscriptions`

| Colonna | Default | Significato |
|---|---|---|
| `collection_calendar_id` | `NULL` | Sidecar dell'iscrizione (`role=subscription`), `UNIQUE`, FK `ON DELETE SET NULL`. `calendar_id` resta il calendario di destinazione |
| `blocks_availability` | `false` | Blocca solo se anche il calendario di destinazione blocca (dalla F2) |
| `device_visible` | `false` | Copia nella collezione `sub-*`, in sola lettura per i device (dalla F3) |

In F1 il codice legacy non legge queste colonne: il busy continua a usare solo `calendars.blocks_availability`.

### 3.3 Classificazione e riconciliazione

`calendar_sidecar_classify(slug, name, is_system)` restituisce il ruolo dalle regole storiche o `NULL`:
1. `slug = 'bookings'` → `bookings`;
2. `slug = 'scadenze'` → `deadlines`;
3. nome storico esatto (`lower(btrim(name))` ∈ {`festività`, `festività e chiusure`}) → `holidays`, indipendentemente da `is_system` (in produzione `f` è stato a lungo `is_system=false`);
4. `is_system` con slug `f`/`festivita` o nome che inizia con "festivit" → `holidays`.

`calendar_sidecar_reconcile()` è idempotente (una seconda chiamata consecutiva non restituisce righe) e restituisce `(calendar_id, field, old_value, new_value)` per ogni modifica. La chiamano la 162, ogni import di backup (in `mode=postgres`, dopo l'UPSERT di `calendars`) e l'auditor. Per ogni riga:
1. `collection_name` NULL → `slug` se valido e libero, altrimenti `needs_review = collection_name_conflict`;
2. `role` di default (`user`) → dead prop `role` da `dav_props` se presente e ammessa (vale anche un `user` esplicito), altrimenti le regole storiche, queste solo per `origin` ∈ {`admin`, `system`}. La dead prop conta solo per `origin` ∈ {`admin`, `system`, `migration`}: una collezione nata da un device (`origin = device`) la ignora sempre, perché in live il device scrive le dead prop delle proprie collezioni (§8) e potrebbe promuoversi a `bookings` o `holidays` (provenienza `booking` o `system` dei suoi item, invariante 4 del design). Un ruolo diverso dal default NON viene mai sovrascritto: se la dead prop lo contraddice, `needs_review = role_conflict`;
3. `is_system` con `origin = admin` → `origin = system`;
4. `role = subscription` senza un'iscrizione che la referenzi → `needs_review = orphan_subscription`.

`needs_review` non sovrascrive un motivo già presente.

Il trigger `BEFORE INSERT` su `calendars` applica le stesse regole 1-3 alla riga nuova (senza mai sollevare): il codice legacy che crea "Festività e chiusure" dopo la 162 produce subito una riga `holidays`, quindi in sola lettura per i device.

Ogni INSERT, DELETE e TRUNCATE di `calendars`, e ogni UPDATE che elenca `collection_name`, `role`, `lifecycle` o `device_visible`, emette `NOTIFY calendar_policy_changed` con payload `{"source":"sidecar"}`.

## 4. Identità del volume

### 4.1 Marker sul principal

Il principal (`/<principal>/`, una collezione semplice, non un calendario) porta due dead prop nel namespace `urn:calicchia:caldes`. Radicale non abbrevia i namespace sconosciuti, quindi in `.Radicale.props` le chiavi sono in notazione Clark e i valori sono stringhe (verificato su 3.7.8):

```json
{"{urn:calicchia:caldes}epoch": "1", "{urn:calicchia:caldes}volume-id": "3f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60"}
```

| Chiave | Formato |
|---|---|
| `{urn:calicchia:caldes}volume-id` | UUID; il writer lo scrive minuscolo, i lettori confrontano senza distinguere maiuscole e minuscole |
| `{urn:calicchia:caldes}epoch` | intero decimale ≥ 1, `^[1-9][0-9]{0,9}$`, senza spazi né zeri iniziali |

Un marker è valido solo se entrambe le chiavi ci sono e rispettano il formato; altrimenti vale come assente. Le altre chiavi del file sono ignorate.

### 4.2 Chi lo scrive

Solo `caldes-svc`, con PROPPATCH sul principal (corpo da `volumeMarkerProppatchBody()`):

```xml
<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:K="urn:calicchia:caldes"><D:set><D:prop><K:volume-id>3f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60</K:volume-id><K:epoch>1</K:epoch></D:prop></D:set></D:propertyupdate>
```

Nessun componente modifica `.Radicale.props` direttamente su disco. Il marker cambia solo con l'inizializzazione (§4.4), il cutover e il rollback (epoch + 1, prima su Radicale e poi in PG nella stessa sequenza del design §13.10 e §13.12) e la riassegnazione d'identità confermata dal wizard.

### 4.3 Chi lo legge

- **`caldes_rights`**: legge il file dal proprio volume, al massimo una volta al secondo (ricarica se cambiano mtime, dimensione o inode), e confronta con `volume_id` ed `epoch` della policy. `identity_ok` vale solo se la policy ha `volume_id` non nullo ed `epoch ≥ 1`, il marker è valido, `volume-id` coincide (senza distinguere maiuscole e minuscole) ed `epoch` coincide. File assente, illeggibile o non JSON → `identity_ok = false`.
- **API** (`identity.ts`): legge lo stesso file dal mount `ro` (`principalPropsPath(RADICALE_DATA_DIR, principal)`), oppure, in remote mode, con PROPFIND Depth:0 sul principal come `caldes-svc` delle due prop. Confronta con `calendar_backend_state` tramite `identityStatus()`:

| Condizione | `IdentityStatus` |
|---|---|
| `epoch = 0` in PG | `uninitialized` (qualunque cosa ci sia sul volume) |
| lettura non riuscita (mount assente, errore di I/O, Radicale irraggiungibile, controllo non ancora eseguito) | `unverified` |
| marker assente o malformato | `mismatch` |
| marker diverso da PG | `mismatch` |
| marker uguale a PG | `ok` |

### 4.4 Inizializzazione

Unico punto che crea collezioni (design §6.3 e §13.3). In F1 si esegue a mano o dai test di integrazione con la stessa sequenza; dalla F3 la esegue il wizard:
1. precondizioni: `mode = 'postgres'`, `epoch = 0` in PG, principal assente su Radicale (PROPFIND 404);
2. `MKCOL /<principal>/` come `caldes-svc`;
3. PROPPATCH del marker con un UUID v4 nuovo ed `epoch = 1`;
4. in una transazione: `UPDATE calendar_backend_state SET volume_id = $uuid, epoch = 1 WHERE mode = 'postgres' AND epoch = 0` (0 righe = abort);
5. MKCALENDAR delle collezioni con `collection_name` (compreso `f`) e le dead prop `{urn:calicchia:caldes}calendar-id` (= `calendars.id`, minuscolo) e `{urn:calicchia:caldes}role`, poi `_canary` (F3);
6. riscrittura immediata della policy (il NOTIFY del passo 4 la provoca comunque).

Un volume non vuoto senza marker, o con un marker diverso, NON viene mai inizializzato né "adottato" in automatico.

### 4.5 Dead prop delle collezioni

| Chiave | Valore |
|---|---|
| `{urn:calicchia:caldes}calendar-id` | `calendars.id`, UUID minuscolo: la discovery adotta la riga per questa prop |
| `{urn:calicchia:caldes}role` | `calendars.role`: dopo un ripristino la riconciliazione la usa per le righe con ruolo di default e `origin` diversa da `device` (§3.3) |

La discovery le copia, con le altre proprietà DAV, in `calendars.dav_props`. Le scrive `caldes-svc` (inizializzazione e creazione dall'API), ma in live un device può riscriverle sulle collezioni che può scrivere (§8), quindi la discovery (F2) le tratta come dati non fidati:
- adotta una riga del sidecar per `calendar-id` solo se anche il nome della collezione coincide con il suo `collection_name`, e mai per una collezione nata da un device: una MKCALENDAR con il `calendar-id` di `bookings` non dirotta la riga di `bookings`;
- non copia in `dav_props` le dead prop `urn:calicchia:caldes` di una collezione scrivibile dai device (ruolo non `readonly` nel sidecar, o `origin = device`): per quelle vale solo PG, e una `role` falsificata su `c` non arriva mai alla riconciliazione.

## 5. `policy.json`

### 5.1 Formato

Definito da [policy.schema.json](policy.schema.json). Esempio (produzione in F1 dopo l'inizializzazione):

```json
{
  "schema": 1,
  "version": 3,
  "generated_at": "2026-10-09T18:00:00.000Z",
  "backend_mode": "postgres",
  "mode": "shadow",
  "reasons": [],
  "principal": "federico",
  "volume_id": "3f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60",
  "epoch": 1,
  "credential_epoch": 0,
  "readonly": ["bookings", "f", "scadenze"],
  "hidden": ["_canary"]
}
```

| Campo | Significato | Usato da |
|---|---|---|
| `schema` | Formato, sempre `1` | tutti |
| `version` | `calendar_backend_state.policy_version` | auditor, salute |
| `generated_at` | Istante di generazione (informativo) | salute |
| `backend_mode` | Modalità del backend da cui deriva | salute, coerenza |
| `mode` | `shadow`, `live`, `frozen` | rights |
| `reasons` | Condizioni che hanno forzato `frozen` (§6.2) | salute |
| `principal` | Principal canonico; DEVE coincidere con `RADICALE_PRINCIPAL` di Radicale | rights, auth |
| `volume_id`, `epoch` | Identità registrata in PG (`null`/`0` se non inizializzato) | rights |
| `credential_epoch` | Epoch delle credenziali | auth |
| `readonly`, `hidden` | Collezioni in sola lettura e senza permessi per i device, ordinate e senza duplicati | rights |

### 5.2 Scrittura (API)

- Si scrive SOLO il risultato di `policyFromState()` serializzato con `serializeControlFile()` (JSON indentato, chiavi nell'ordine dello schema, a capo finale, al massimo 64 KiB).
- Scrittura atomica: file temporaneo `.<nome>.<pid>.<casuale>.tmp` nella stessa cartella, permessi `0644`, `fsync`, `rename` sopra il file definitivo, `fsync` della cartella (best effort). Mai scritture in place. I lettori aprono solo i nomi definitivi.
- Momenti: all'avvio (dopo la lettura dello stato; se l'identità non è ancora verificata vale `unverified`), a ogni `NOTIFY calendar_policy_changed`, dopo ogni transizione fatta dal processo, e a ogni giro del heartbeat (riconciliazione). Si riscrive solo se il contenuto a meno di `generated_at` cambia (`samePolicyContent()`) o se il file manca o è invalido.
- Ordine nelle transizioni che riducono i permessi (design §13.9): prima lo stato in PG, poi la policy.
- Un errore di scrittura (volume assente, disco pieno) si registra e compare nella salute; non ferma l'API.

### 5.3 Lettura (`caldes_rights`, `caldes_auth`)

- Si ricontrolla il file al massimo una volta al secondo e lo si rilegge se cambiano mtime, dimensione o inode.
- File oltre 64 KiB, non UTF-8, non JSON o non conforme a §5.4 → policy invalida.
- Policy assente o invalida → `caldes_rights` usa `mode = shadow` con identità, `readonly` e `hidden` dell'**ultima policy valida vista dal processo** (solo in memoria, mai su disco). Se il processo non ne ha mai vista una, non c'è identità di riferimento: nessun permesso per i device sotto il principal (403). Il test "policy corrotta → sola lettura" del piano parte quindi da una policy valida che poi si corrompe.
- Policy assente o invalida → `caldes_auth` considera `credential_epoch` sconosciuto: nessuna voce di cache (in memoria o persistita) è utilizzabile, ma le cache non vengono cancellate (§9.6).
- Ogni passaggio fra valido e invalido si registra una volta, a livello WARNING, con il motivo.

### 5.4 Regole di validazione dei lettori

Le applicano `parsePolicy()` in TS e i plugin in Python:
- oggetto JSON con `schema === 1`;
- `version` intero ≥ 1; `generated_at` timestamp del contratto (sotto);
- `backend_mode` ∈ modalità del backend; `mode` ∈ {`shadow`, `live`, `frozen`};
- `reasons` array di stringhe (i codici sconosciuti si ignorano);
- `principal` valido e uguale al principal configurato;
- `volume_id` null o UUID (normalizzato in minuscolo); `epoch` intero 0..2147483647; `volume_id` null ⇔ `epoch` 0; `mode = live` richiede `volume_id`;
- `credential_epoch` intero 0..2147483647;
- `readonly` e `hidden` array di segmenti di path validi (1-255 byte UTF-8, niente `/`, `\` né controlli, non iniziano con `.`; `_` ammesso);
- i campi sconosciuti si ignorano. Un campo nuovo con semantica di sicurezza richiede `schema: 2` e un deploy coordinato (prima l'immagine di Radicale che accetta entrambi).

**Timestamp del contratto** (`generated_at`, `ts`): `YYYY-MM-DDTHH:MM:SS[.f]` seguito da `Z` o `±HH:MM`, con da 1 a 9 cifre decimali, data e ora reali (niente 31 settembre, `24:00` o secondi `60`). I writer producono sempre la forma di `Date.prototype.toISOString()` (millisecondi e `Z`). In Python non basta `datetime.fromisoformat`, che accetta anche orari senza fuso: serve la stessa espressione regolare più la costruzione della data.

## 6. `policyFromState()`

Funzione pura in `types.ts`, unica fonte della policy per writer, riconciliatore al boot e auditor (design §13.1).

### 6.1 Modalità base

| `backend_mode` | Base |
|---|---|
| `postgres` | `shadow` |
| `cutover` | `frozen` |
| `radicale` | `live` |
| `rollback` | `frozen` |
| `finalized` | `live` |

### 6.2 Condizioni di blocco

La policy è `frozen`, qualunque sia la base, se vale almeno una di queste condizioni. In `reasons` compaiono in quest'ordine fisso:

| Codice | Condizione |
|---|---|
| `write_freeze` | `write_freeze` e base `live` (con base `shadow` o `frozen` non cambia nulla e non compare) |
| `restore_guard` | `restore_guard_until > now` |
| `rebuild_required` | `rebuild_required` |
| `identity_uninitialized` | `epoch = 0` e `mode ≠ postgres` (impossibile per i CHECK della 162; difesa in profondità) |
| `identity_mismatch` | identità `mismatch` |
| `identity_unverified` | identità `unverified`, o `uninitialized` passato con `epoch ≥ 1` in PG (incoerenza: fail-closed) |

Con `epoch = 0` l'identità vale sempre `uninitialized`, qualunque esito passi il chiamante. In `mode = postgres` un volume non inizializzato non blocca: la policy resta `shadow` con `volume_id: null`, e i rights negano comunque ai device tutto ciò che sta sotto il principal.

### 6.3 Collezioni

- `hidden` = `{_canary}` ∪ collezioni con `lifecycle ≠ active` o `device_visible = false`;
- `readonly` = collezioni attive e visibili con ruolo ∈ {`bookings`, `holidays`, `deadlines`, `subscription`}, tolte quelle in `hidden`;
- le righe con `collection_name` NULL o non valido si saltano;
- entrambe le liste sono ordinate (`Array.prototype.sort`) e senza duplicati.

Con i dati di produzione: `readonly = ["bookings", "f", "scadenze"]`, `hidden = ["_canary"]`; `c`, `lavoro` e `personale` seguono la modalità (sola lettura in shadow, scrittura in live).

## 7. `heartbeat.json`

### 7.1 Formato e scrittura

Definito da [heartbeat.schema.json](heartbeat.schema.json):

```json
{"schema": 1, "api_version": "sha-1a2b3c4", "mode": "postgres", "epoch": 1, "ts": "2026-10-09T18:00:30.123Z"}
```

- L'API lo riscrive ogni 30 s (`HEARTBEAT_INTERVAL_MS`) con `heartbeatFromState()`, con la stessa scrittura atomica della policy, solo dopo aver letto lo stato con successo in quello stesso giro (§2) e solo se `policy.json` è allineata a quello stato (invariata o appena scritta). Se la policy non si scrive (volume assente, disco pieno) il heartbeat si ferma e dopo 10 minuti i device vanno in frozen: un heartbeat fresco garantisce sempre una policy aggiornata. `mode` ed `epoch` sono quelli dello stato letto.
- Nessuna firma né HMAC: il design non la prevede e il volume è scrivibile solo dall'API. Un'immagine API vecchia, che non conosce il heartbeat, smette semplicemente di aggiornarlo (design §16.6).

### 7.2 Validazione dei lettori

`parseHeartbeat()` in TS e lo stesso controllo in Python: oggetto con `schema === 1`, `api_version` ASCII stampabile senza spazi (1-64), `mode` ∈ modalità del backend, `epoch` intero ≥ 0, `ts` timestamp del contratto (§5.4); campi sconosciuti ignorati; file oltre 64 KiB o non JSON → invalido.

### 7.3 Modalità effettiva dei device

`caldes_rights` la calcola a ogni chiamata di `authorization()` (l'età del heartbeat si misura con l'orologio corrente, non al momento del reload). `effectiveDeviceMode()` in TS ne è lo specchio, usato dalla salute e dai test di conformità:

```
rif   = policy valida ?? ultima policy valida del processo ?? nessuna
base  = policy valida ? policy.mode : 'shadow'
frozen se uno di questi vale:
  heartbeat assente                                  heartbeat_missing
  heartbeat invalido                                 heartbeat_invalid
  now - ts > 600 s                                   heartbeat_stale
  ts - now > 60 s                                    heartbeat_future
  nessun rif, oppure heartbeat.epoch ≠ rif.epoch     heartbeat_epoch_mismatch
  base = live e heartbeat.mode ∉ {radicale, finalized}  heartbeat_mode_mismatch
altrimenti la modalità effettiva è base.
identità di riferimento = (rif.volume_id, rif.epoch); liste = rif.readonly, rif.hidden ∪ {_canary}
```

`policy_missing` e `policy_invalid` compaiono fra i motivi ma da soli lasciano `shadow`. Shadow e frozen danno ai device gli stessi permessi (§8); cambia solo il motivo esposto dalla salute. I casi condivisi sono in [fixtures/effective-mode.cases.json](fixtures/effective-mode.cases.json): i test TS li eseguono su `effectiveDeviceMode()`, i test Python su `caldes_rights`.

## 8. Permessi (`caldes_rights`)

`authorization(user, path)` riceve l'utente restituito da `caldes_auth` (§9) e il path già ripulito da Radicale (`federico/f`, senza barre iniziali e finali; la root è `''`). Restituisce le lettere di Radicale 3.7.8: `R`/`W` sulle collezioni semplici (root e principal), `r`/`w` sui calendari e, tramite il genitore, sui loro item; `D` permette la DELETE di una collezione con `permit_delete_collection = False`. Per gli item (profondità ≥ 3) restituisce `''`: Radicale li valuta con i permessi della collezione.

Contesto: principal `P`, modalità effettiva `M` (§7.3), `identity_ok` (§4.3), `readonly` e `hidden` dell'identità di riferimento.

```
caldes-svc:
  ''                   → R
  P                    → RW
  P/<qualsiasi>        → rwD          (nessun controllo di modalità o identità: serve all'inizializzazione)
  altro                → ''
P (qualsiasi device) e caldes-probe:
  ''                   → R
  altro principal      → ''           (/iphone/, /caldes-svc/: nessuna auto-creazione)
  identity_ok falso    → ''           (sotto P: 403 e nessuna directory creata)
  P                    → R            (anche in live: il marker d'identità lo scrive solo caldes-svc, §4.2)
  P/_canary            → rw se utente = caldes-probe e M = live, altrimenti ''
  P/<'_'…> o hidden    → ''           (non elencata)
  P/<readonly>         → r
  P/<altra>            → rw se M = live, altrimenti r
  profondità ≥ 3       → ''
qualsiasi altro utente → ''
```

Conseguenze verificabili (Radicale 3.7.8):
- MKCALENDAR di `P/<nuova>` richiede `w` sul path nuovo, non la `W` del principal: ammessa solo in `live`. MKCOL del principal richiede `W` su `P`, che i device non hanno mai: il principal non si auto-crea mai al login di un device.
- PROPPATCH del principal da un device (togliere o falsificare `volume-id`/`epoch`): 403 in ogni modalità. Con `W` in live un'app-password valida (telefono rubato, client difettoso) poteva rendere l'identità diversa per tutti (nessun permesso ai device, facade in sola lettura, decisioni in 503).
- In live un device scrive le dead prop delle collezioni che può scrivere, anche `{urn:calicchia:caldes}role` e `calendar-id` (Radicale non distingue PROPPATCH da PUT). I rights non lo impediscono: per questo quelle dead prop non sono mai fidate da sole (§3.3, §4.5).
- DELETE di una collezione: `permit_delete_collection = False` e nessuna `D` per i device → 403.
- Il principal e le collezioni nascoste non compaiono nei PROPFIND Depth:1 dei device.

| Soggetto | Path | shadow / frozen | live |
|---|---|---|---|
| caldes-svc | `''` | R | R |
| caldes-svc | `federico` | RW | RW |
| caldes-svc | `federico/<qualsiasi>` | rwD | rwD |
| caldes-svc | altri principal | — | — |
| device o probe | `''` | R | R |
| device o probe | `federico` | R | R |
| device o probe | `federico/<readonly>` | r | r |
| device o probe | `federico/<hidden>`, `federico/_*` | — | — |
| caldes-probe | `federico/_canary` | — | rw |
| device o probe | `federico/<altra>` | r | rw |
| device o probe | qualsiasi cosa sotto `federico`, identità assente o diversa | — | — |
| device o probe | altri principal | — | — |

I casi condivisi sono in [fixtures/rights-matrix.cases.json](fixtures/rights-matrix.cases.json): i test TS li eseguono su `expectedRadicaleRights()`, i test Python su `caldes_rights`.

## 9. Autenticazione (`caldes_auth`)

Implementa `_login_ext(login, password, context)` (`BaseAuth.login` è `@final` in 3.7.8). `context.remote_addr` è il peer TCP (`REMOTE_ADDR`), `context.x_remote_addr` l'header `X-Remote-Addr` messo da CloudPanel. Restituisce l'utente Radicale, `''` per credenziali non valide (Radicale risponde 401 dopo il proprio delay) oppure solleva un'eccezione (Radicale risponde 500, senza delay).

### 9.1 Username riservati

Ogni login con prefisso `caldes-` (senza distinguere maiuscole e minuscole) è riservato e NON entra MAI nel ramo device, nemmeno se il backend è giù:

| Login (esatto) | Peer ammesso | Password | Esito |
|---|---|---|---|
| `caldes-svc` | in `CALDES_SVC_CIDR` | sha256 = `CALDES_SVC_PASSWORD_SHA256` (confronto constant-time) | `caldes-svc` |
| `caldes-probe` | in `CALDES_SVC_CIDR`, oppure `127.0.0.1` / `::ffff:127.0.0.1` | sha256 = `CALDES_PROBE_PASSWORD_SHA256` | `caldes-probe` |
| `caldes-svc`/`caldes-probe` da un altro peer, o con password errata | — | — | `''` (401) |
| qualsiasi altro `caldes-*` | — | — | `''` (401) |

- Il peer si legge SOLO da `context.remote_addr`, mai da un header. Il traffico pubblicato su 127.0.0.1:3011 arriva dal gateway di `app-net`, che non è mai in `CALDES_SVC_CIDR`.
- `127.0.0.1` vale solo per il probe (healthcheck dentro il container).
- Un login riservato rifiutato si registra (evento `reserved_denied`, §9.7).

### 9.2 Device: principal canonico

Ogni altro login è un device. Con credenziali valide il plugin restituisce SEMPRE `RADICALE_PRINCIPAL`, qualunque sia lo username dell'app-password (`iphone`, `mac`...): lo username resta solo per audit e rate limit. Il campo `principal` della risposta del backend è informativo (una differenza si registra, non cambia l'esito). Login vuoti, più lunghi di 255 byte o con caratteri di controllo → `''` senza chiamare il backend.

### 9.3 Sequenza del ramo device

```
eph = credential_epoch della policy (None se la policy è assente o invalida)
k   = chiave di cache (§9.5) calcolata con eph (se eph è None non c'è chiave)
1. k in cache in memoria, validata da ≤ 60 s con lo stesso eph      → P
2. POST verify-credentials (timeout complessivo 1 s)
   200 con ok === true                     → salva in memoria e su disco (solo se eph è noto), → P
   401 con corpo JSON {ok: false}           → rimuove k da entrambe le cache, → ''
   429 (qualsiasi corpo)                    → '' senza toccare le cache e senza consultare
                                              la cache persistita (evento rate_limited)
   qualsiasi altra risposta o errore        → errore del backend:
3.   k nella cache persistita, exp > now, stesso eph  → P (evento stale_if_error)
4.   altrimenti                                       → eccezione (500, evento backend_error)
```

Il 429 è una negazione temporanea, non un errore del backend. L'API lo restituisce solo per un tentativo fallito oltre il limite (§9.4): una password corretta non lo riceve mai. Se aprisse lo stale-if-error, chiunque potrebbe esaurire il proprio bucket con password sbagliate e ottenere dal plugin un confronto senza ritardo né limite contro la cache persistita, che può contenere credenziali non più valide nel database. Con `''` Radicale risponde 401 dopo il proprio `[auth] delay`.

Il plugin non usa la cache dei login di Radicale (`cache_logins` vale solo per i tipi interni).

### 9.4 Contratto di verify-credentials

Definito da [verify-credentials.schema.json](verify-credentials.schema.json).

Richiesta: `POST ${CALDAV_BACKEND_URL}/verify-credentials` con `Authorization: Bearer ${CALDAV_SERVICE_TOKEN}`, `Content-Type: application/json`, corpo `{"username", "password"}`, `X-Forwarded-For: <IP>` solo se `X-Remote-Addr` è presente, è un IP valido e, con `CALDES_XRA_PEER_CIDR`, arriva dal peer TCP atteso (il gateway della porta pubblicata). Altrimenti il plugin registra l'evento `missing_x_remote_addr` (motivo `absent`, `invalid` o `untrusted_peer`, al massimo una volta al minuto) e non manda l'header.

| Risposta | Significato | Per il plugin |
|---|---|---|
| `200 {"ok": true, "principal": "federico", "expires_at": "…" \| null}` | credenziali valide | successo; `expires_at` limita il TTL della cache persistita |
| `401 {"ok": false}` | credenziali non valide, revocate, scadute, o username riservato | negazione esplicita |
| `401 {"error": "Unauthorized"}` | Bearer assente o errato (configurazione) | errore del backend, MAI negazione |
| `429 {"error": "…"}` | tentativo fallito oltre il limite per (IP del device, username) | negazione temporanea: `''` senza stale-if-error (§9.3) |
| `503`, altri 5xx, timeout, connessione rifiutata, corpo non JSON, `200` senza `ok: true` | backend indisponibile o fuori contratto | errore del backend |

Lato API (F1): `principal` sempre `RADICALE_PRINCIPAL`; gli username riservati rispondono `401 {"ok": false}` senza cercare nel DB; `X-Forwarded-For` si accetta solo dietro il Bearer valido e, con `CALDAV_BACKEND_ALLOWED_PEERS`, solo dal peer di Radicale su `caldav-int` (§1.3); `last_used_ip` e il rate limit usano quell'IP; `expires_at` è la scadenza dell'app-password o `null`. Il rate limit conta solo i tentativi falliti (30 al minuto per IP e username, senza distinguere maiuscole): le credenziali si verificano sempre prima del limite, quindi una password corretta risponde sempre 200 e non consuma il bucket, e chi esaurisce il bucket di uno username (anche quello comune senza `X-Remote-Addr`) non blocca il device legittimo. Oltre il limite un tentativo fallito risponde 429 invece di 401.

### 9.5 Cache

| | In memoria | Persistita (`authcache.json`) |
|---|---|---|
| Contenuto | solo esiti positivi | solo esiti positivi |
| Chiave | `k` | `k` |
| Durata | 60 s dall'ultima conferma del backend | 24 h dall'ultima conferma, ridotte a `expires_at` se più vicina |
| Uso | prima del backend | solo dopo un errore del backend (stale-if-error) |
| Limite | 1024 voci | 256 voci, si scartano quelle con `refreshed` più vecchio |

- `k = hex(HMAC-SHA256(CALDES_AUTHCACHE_KEY, "caldes-authcache/v1\0" + str(credential_epoch) + "\0" + username + "\0" + password))`, tutto in UTF-8. L'epoch dentro l'HMAC lega ogni voce all'epoch in cui è stata validata: anche un file non ripulito non sopravvive a una revoca.
- `key_id = hex(HMAC-SHA256(CALDES_AUTHCACHE_KEY, "caldes-authcache/key-id"))[:16]`: un file con `key_id` diverso (chiave ruotata) vale come vuoto.
- Formato del file in [authcache.schema.json](authcache.schema.json). Si legge all'avvio; illeggibile, di schema diverso o con `key_id` diverso → cache vuota (riscritta al primo successo). Si scrive in modo atomico (temporaneo `0600`, `fsync`, `rename`) solo quando cambia qualcosa: voce nuova, voce confermata con `refreshed` più vecchio di 1 h, voce rimossa da un 401 esplicito, cambio di epoch.
- Nessuna password in chiaro, né su disco né nei log; su disco nemmeno gli username (solo `k`). Nei log compare lo username (`login`, troncato a 255 caratteri) degli eventi del §9.7, come nella riga "Successful login" di Radicale: serve per audit e rate limit, e non è un segreto.

### 9.6 Revoca: `credential_epoch`

- L'API incrementa `calendar_backend_state.credential_epoch` nella stessa transazione di ogni revoca, rigenerazione o cancellazione di app-password, poi riscrive subito la policy (il NOTIFY della 162 la provoca comunque). La creazione di un'app-password nuova non lo cambia.
- I ripristini seguono la stessa regola. L'import del backup JSON (`backup.ts`) svuota e reinserisce `caldav_app_passwords` (gruppo B), ma nella stessa transazione rimette le revoche del database corrente sulle righe che il backup riporta attive (stesso id o stesso hash, con data e motivo originali): una revoca non si annulla mai con un ripristino. Se dopo l'import una credenziale valida prima non lo è più (creata dopo il backup, svuotata per chiusura FK), incrementa `credential_epoch` nella stessa UPDATE della guardia post-ripristino e lo segnala negli avvisi. Il ripristino coordinato (`restore-calendar-stack.sh`) lo incrementa sempre.
- Il plugin rilegge `credential_epoch` dalla policy al massimo una volta al secondo. Quando cambia (anche all'indietro), svuota la cache in memoria e riscrive `authcache.json` vuoto con il nuovo epoch, prima di rispondere alla richiesta in corso.
- Policy assente o invalida: epoch sconosciuto, quindi nessuna voce è utilizzabile (§5.3), ma le cache non si toccano: se la policy torna con lo stesso epoch, tornano utilizzabili.
- Scadenza naturale di un'app-password: il backend la rifiuta subito; la cache persistita la copre al massimo fino a `expires_at`.

### 9.7 Eventi di log

Una riga per evento a livello WARNING (ERROR per `backend_error` e `config_error`), con prefisso `caldes_event` seguito da un oggetto JSON con almeno `event`, `plugin` (`caldes_auth` o `caldes_rights`: entrambi registrano `policy_invalid`/`policy_valid`) e i campi indicati; mai password, mai `k`. I campi in più sono informativi. L'API li riporterà in Telegram e Bugsink (design §16.5).

Gli eventi che un client può provocare a piacere hanno un limite, così nessuno allaga log e alert: `missing_x_remote_addr` al massimo uno al minuto; `reserved_denied`, `backend_error`, `stale_if_error` e `rate_limited` al massimo 10 al minuto per nome. Quelli oltre il limite si contano, e il primo evento scritto dopo porta il campo `suppressed` con il loro numero.

| `event` | Campi |
|---|---|
| `reserved_denied` | `login`, `peer` |
| `missing_x_remote_addr` | `peer`, `reason` |
| `backend_error` | `login`, `status` o `error` |
| `stale_if_error` | `login` |
| `rate_limited` | `login`, `status` |
| `credential_epoch_changed` | `old`, `new` |
| `policy_invalid` / `policy_valid` | `reason` |
| `effective_mode_changed` | `mode`, `reasons` |
| `principal_mismatch` | `login`, `backend_principal` |
| `config_error` | `option`, `reason` |

## 10. Codici di risposta attesi

| Scenario | Risposta di Radicale |
|---|---|
| Device con app-password valida (anche username ≠ `federico`), volume inizializzato, shadow: PROPFIND `/federico/` | 207 (sola lettura) |
| Idem, PUT o DELETE di un item, MKCALENDAR | 403 |
| Device, volume vuoto o identità assente/diversa: PROPFIND `/federico/` | 403, nessuna directory creata |
| Device, PROPFIND Depth:0 sulla root `/` | 207 |
| Device, `/iphone/` o `/caldes-svc/` | 403, nessuna directory creata |
| Device, collezione `hidden` o `_canary` | 403, e assente dal listing del principal |
| Device in live, PUT in `bookings`, `f`, `scadenze`, `sub-*` | 403 |
| Device in live, DELETE di una collezione | 403 |
| Device in live, PUT in `c` o MKCALENDAR di una collezione nuova | 201/204 |
| Credenziali rifiutate dal backend (`401 {ok:false}`) | 401 dopo il delay |
| Troppi tentativi falliti (`429`), anche con una voce nella cache persistita | 401 dopo il delay |
| Backend giù, timeout, 5xx o Bearer errato, credenziali in cache valida | come con il backend su |
| Idem senza cache valida (o policy illeggibile) | 500 senza delay |
| `caldes-svc` o `caldes-probe` da un peer non ammesso, anche con la password giusta | 401 |
| Qualsiasi altro `caldes-*` | 401 |
| Healthcheck: PROPFIND Depth:0 `/` come `caldes-probe` da 127.0.0.1 | 207 (anche su un volume vuoto) |
| `caldes-probe`, PUT su `_canary` in shadow o frozen | 403 |
| `caldes-probe`, PUT su `_canary` in live con identità valida | 201/204 |

## 11. Healthcheck

`caldes_healthcheck.py` fa una PROPFIND Depth:0 sulla root `/` di `http://127.0.0.1:5232/` come `caldes-probe` (password da `CALDES_PROBE_PASSWORD`) e considera sano solo un 207. La richiesta passa per auth e rights, quindi un plugin rotto rende il container unhealthy; funziona anche prima dell'inizializzazione, perché la root non dipende dall'identità.

## 12. Versionamento

- `policy.json` e `heartbeat.json` hanno `schema: 1`. Un lettore che trova uno schema diverso tratta il file come invalido (§5.3, §7.3): fail-closed.
- Aggiungere un campo informativo non richiede un nuovo schema (i lettori ignorano i campi sconosciuti), ma va aggiunto allo schema JSON, ai tipi TS e ai casi condivisi nello stesso commit.
- Cambiare il significato di un campo, aggiungere un campo con effetto sui permessi o cambiare la chiave HMAC della cache richiede uno schema nuovo e il deploy in due tempi: prima i lettori che accettano entrambi, poi il writer.

## 13. Precisazioni rispetto al design

1. `calendar_backend_state` nasce nella 162 con le colonne di F1, non nella 165 (§2).
2. La policy ha i campi informativi `schema`, `generated_at`, `backend_mode` e `reasons` oltre a quelli del §3.3 del design; `version` è `policy_version` dello stato.
3. Il heartbeat non è firmato (il design non lo prevede); con policy `live` il suo `mode` deve essere `radicale` o `finalized`, controllo di coerenza in più.
4. Con policy invalida i rights usano l'identità dell'ultima policy valida vista dal processo; all'avvio senza alcuna policy valida i device non hanno permessi sotto il principal.
5. Le collezioni con prefisso `_` sono tutte nascoste ai device, non solo `_canary`; il sidecar non ammette nomi con quel prefisso.
6. Le regole storiche dei ruoli si applicano solo alle righe con `origin` admin o system: un calendario creato da un device e chiamato "Festività" resta `user`.
7. Un 401 di verify-credentials è una negazione solo con corpo `{ok: false}`; quello del middleware del Bearer è un errore di configurazione.
8. La chiave HMAC della cache include `credential_epoch` e il file porta un `key_id`.
9. `verify-credentials` restituisce anche `expires_at`, che limita la cache persistita.
10. Il heartbeat si scrive solo con la policy allineata allo stato (§7.1): un errore di scrittura della policy porta i device in frozen dopo 10 minuti invece di lasciarli su una policy vecchia.
11. Backup JSON (design §16.2): nel gruppo S c'è anche `schema_migrations`; S è un elenco esplicito più il prefisso `cal_migration_` (le tabelle Cal.com `cal_bookings`, `cal_sync_log`, `cal_webhook_logs` sono business); una tabella protetta che referenzia una tabella da svuotare blocca l'import con 409. L'import non annulla mai una revoca di app-password e incrementa `credential_epoch` se toglie credenziali valide (§9.6).
12. Il 429 di verify-credentials è una negazione temporanea, non un errore del backend (design §3.3 diceva "5xx o 429"): l'API conta solo i tentativi falliti e non limita mai una password corretta, il plugin risponde `''` senza consultare la cache persistita (§9.3-§9.4).
13. I device hanno sempre e solo `R` sul principal, anche in `live` (design §3.4 diceva `RW`): il marker d'identità è scrivibile solo da `caldes-svc` (§4.2, §8).
14. `X-Remote-Addr` vale solo dal peer della porta pubblicata (`CALDES_XRA_PEER_CIDR`) e `/api/caldav-backend/*` risponde solo al peer di Radicale (`CALDAV_BACKEND_ALLOWED_PEERS`); Radicale è su una rete `dav-pub` dedicata invece che su `app-net` (design §3.5).
