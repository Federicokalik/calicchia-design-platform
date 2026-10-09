# Calendario "full backended da Radicale": design finale (revisione red-team)

## 0. Sintesi

**Proposta di partenza.** La base è la proposta 1: Radicale fonte di verità, indice derivato verificato, guardie a strati. Nella media dei tre giudici è la più forte (circa 7,7, contro 7,3 della proposta 2 e 6,4 della proposta 3) e nessun giudice le ha trovato difetti fatali.

**Le critiche alla proposta 1**
- Troppe parti mobili per un freelance.
- PROPFIND sync-token O(n) dentro la sezione critica delle prenotazioni.
- DDL a runtime al cutover.
- Correzioni che cambiano i valori dei contratti, rilasciate insieme alla migrazione.

Le risolvo innestando le idee migliori delle altre proposte e del laboratorio "mig".

**Cosa cambia rispetto alla proposta 1**

| Tema | Scelta finale | Origine |
|---|---|---|
| Rilevazione delle modifiche | Nessun plugin di storage, hook o doorbell. L'API monta il volume di Radicale in sola lettura e fa `stat` delle directory ogni secondo; un canary e `statfs` verificano che il meccanismo funzioni davvero. Il canale dati resta sync-collection + multiget. | P3 (campanello), P1 (canale), red-team (canary) |
| Freschezza nella sezione critica | `stat` delle directory delle collezioni bloccanti e del principal dentro l'advisory lock, con sync single-flight. Senza mount si ripiega su PROPFIND sync-token, con disponibilità ridotta e dichiarata. | P3 + P1 |
| Immagine | `tomsquest/docker-radicale:3.7.8.0` pinnata per digest. Solo interfacce di plugin supportate: auth, rights e la fix di vobject via sitecustomize. | P2 |
| Gate dei device | Plugin rights a policy JSON (shadow/live/frozen), più identità del volume e heartbeat dell'API. Policy mancante o corrotta, volume sconosciuto o API assente lasciano i device in sola lettura o senza accesso. | lab mig + P1 + red-team |
| Fedeltà | Patch vobject combinata: `_RawBehavior` per le proprietà sconosciute più la gestione corretta delle virgole nelle TEXT e di VALUE=URI. | P1 + P2 |
| Parità | Le correzioni che cambiano valori di contratto escono nella release successiva al cutover. Shadow mirror continuo PG→Radicale per almeno 7 giorni. | P2 |
| Cutover | Nessun DDL a runtime: un trigger di guardia legge lo stato. Rename e vista solo al finalize. | P2 |
| Apply della migrazione | Ledger a tre vie (`legacy_hash`, `written_etag`), righe d'intento prima di ogni PUT, conflitti classificati. | lab mig + red-team |
| Conflitti in admin | CAS per campo invece di un merge a tre vie basato sulle versioni. | P3 + P2 |
| Iscrizioni ICS | Fonte = feed remoto. In PG vive un indice solo-cache; Radicale ne riceve una copia solo se l'iscrizione è visibile ai device. `calendar_id` nei DTO resta il calendario di destinazione. | P1 + P3 + red-team |
| Rollback | Prima la transizione di stato, poi la policy che ne deriva, poi una quiescenza verificata. Proiezione inversa totale che preserva la semantica, ledger ri-baselinato. | P1 + red-team |

**Revisione red-team: cosa cambia in questa versione**

| # | Problema (gravità) | Correzione | Dove |
|---|---|---|---|
| 1 | Ripristino del backup JSON dall'admin dopo il cutover: trigger spento, CASCADE sull'indice e sugli id, ruoli persi, stato riportato indietro (H) | Il dominio calendario si ripristina solo in `mode=postgres`. Stato, indice, id, versioni e ledger non vengono mai ripristinati dal JSON. `calendars` passa in UPSERT. Dopo l'import: `calendar_sidecar_reconcile()` con la dead prop `role`, rebuild e policy frozen. La mappatura calendar_events→_legacy è anticipata a F4. | §4, §16.2 |
| 2 | Tempesta di PUT delle iscrizioni ogni 15 minuti (H) | Iscrizioni solo-indice. Fingerprint semantico che ignora DTSTAMP, LAST-MODIFIED e SEQUENCE. Niente versioni. Specchio su Radicale solo per le device_visible, a bassa priorità. Fuori dal set di freschezza. | §6.6, §9 |
| 3 | Volume vuoto, sbagliato o vecchio trattato come verità (H) | Identità del volume: dead prop `volume-id` + `epoch` sul principal, verificata da rights e API. Mai MKCOL/MKCALENDAR fuori dal wizard. Interruttore anti-cancellazione di massa. Ricostruzione da indice e versioni. | §3.3, §6.2, §6.3, §16.3 |
| 4 | Rollback lossy nella semantica (RDATE, TZID, durata zero, UID duplicati) (H) | Proiettore inverso totale: espande ciò che il legacy non rappresenta, sanifica uid/summary/durata, classifica ogni violazione. | §13.11 |
| 5 | Rollback non garantito e secondo cutover non ripetibile (H) | Ledger ri-baselinato al rollback con l'href reale. Il serializer riusa gli href esistenti. Le proiezioni sono legate alle righe legacy. Gli esiti 409 no-uid-conflict sono classificati. | §13.6, §13.11, §13.12 |
| 6 | Un solo oggetto degradato spegne gli slot pubblici (H) | Salute per oggetto: quarantena più busy conservativo sull'intervallo noto. Il 503 resta solo per le collezioni non sincronizzabili con modifiche pendenti. | §6.5, §7 |
| 7 | Ordine dei passi di rollback e cutover con policy derivata e cache (M) | Prima lo stato, poi la policy che ne deriva. Gate di scrittura `cal-write`. Quiescenza verificata con il probe. | §13.9 |
| 8 | Eccezioni salvate prima del fix DST di d046006 (M) | Anomalia `DST_SHIFTED_EXCEPTION`, riallineamento attivo di default e correzione anche in PG già in F0. | §13.4, F0 |
| 9 | Override orfani scritti dai device spariscono dal busy (M) | Diventano occorrenze autonome bloccanti, con alert. Abbinamento tollerante al tipo. 409 se il target non esiste più. | §6.4, §8 |
| 10 | Tetto di espansione contato da DTSTART (M) | Le 5000 occorrenze si contano nell'orizzonte, con un budget separato di 200k iterazioni per raggiungerlo. | §6.4 |
| 11 | La riprogrammazione resta bloccata dalla vecchia proiezione (M) | Le proiezioni `booking-*` escono dal busy: le prenotazioni sono già coperte da `calendar_bookings`. | §9 |
| 12 | App-password con username diverso da `federico` (M) | Principal canonico per qualsiasi app-password valida. Nessun W su altri principal. Username riservati. | §3.3, §10 |
| 13 | Trigger 166 e cascate ON DELETE (M) | La delete del sidecar gira con stato `deleting` e con il GUC. | §4, §8 |
| 14 | V3 segna rossi falsi per il limite legacy di 500 occorrenze (M) | Finestre di 60 giorni, più un test sulla verifica stessa. | §13.7 |
| 15 | Il campanello a stat poggia su presupposti non verificati (M) | Canary e `statfs`. Remote mode con budget e 404 confermati due volte. Rischio riformulato. | §6.1 |
| 16 | Dipendenza circolare al deploy: 401 e thread saturi (M) | Backend irraggiungibile senza cache → 500, non 401. Cache persistita 24 h con epoch di revoca. Timeout di 1 s. Parse in worker_threads. | §3.3, §6.2 |
| 17 | Coalescenza anche sui job già in esecuzione (M) | Solo sui pending, con la versione della sorgente nel job. | §4, §8 |
| 18 | Rebuild dell'indice non atomico (M) | `dir_mtime` azzerata in una sola tx e ricostruzione atomica collezione per collezione. | §6.7 |
| 19 | Un all-day "Occupato" creato da device non blocca (M) | Decisione per l'utente. | decisione 8 |
| 20 | Le iscrizioni tolgono slot il giorno del cutover (M) | Flag "blocca" per singola iscrizione, falso di default, con anteprima dell'impatto. | §9, §13.4 |
| 21 | Feed: ETag con finestra mobile, CANCELLED, UID delle proiezioni (M+L) | ETag calcolato sul corpo, filtro CANCELLED come oggi, UID legacy per le proiezioni migrate. | §10 |
| 22 | GDPR incompleto (M) | ATTENDEE/ORGANIZER solo con l'opzione "Tutti". Erasure estesa ad audit_logs, tabella legacy e artefatti della migrazione. Retention dichiarata. | §9, §16.4 |
| 23 | Regole di scrittura dell'API su bookings, holidays e deadlines (M) | Guardie API identiche a oggi; la sola lettura vale solo per i device. Provenienza booking solo per `booking-*`. Anomalia `NON_PROJECTION_IN_BOOKINGS`. `/closures` = holidays tranne `it-holiday-*`. | §5, §7, §8 |
| 24 | Gate fragile degli utenti di servizio (M+L) | Riconoscimento dal peer TCP su una rete interna dedicata. Username riservati. Test negativo. | §3.3, §3.5 |
| 25 | Il restore coordinato cancella le tracce delle prenotazioni perse (M) | Dump del DB e tar del volume nello stesso script ogni 6 h. Riconciliazione in sola lettura, nessuna cancellazione automatica di proiezioni orfane. | §9, §16.1, §16.3 |
| 26 | Rollback dell'immagine API dopo il cutover (M) | Heartbeat dell'API letto dai rights, versione minima, runbook. | §3.3, §16.6 |
| 27 | Crash durante l'apply (L) | Riga d'intento prima della PUT e adozione per fingerprint. | §13.6 |
| 28 | Corsa fra discovery e creazione di un calendario (L) | Sidecar `creating` prima di MKCALENDAR, adozione per dead prop. | §6.3, §8 |
| 29 | Lo smoke del cutover ha effetti collaterali (L) | `createBooking` dentro una tx sempre annullata. | §13.10 |
| 30 | Budget di connessioni al DB (L) | Pool dedicato e sync single-flight. | §6.2 |
| 31 | Cambi di comportamento dei tool MCP (L) | Livello "decision" anche per mcp e admin, forma `{error}` già esistente, id delle proiezioni stabili. | §12 |
| 32 | Deploy con Dockhand (L) | Niente `build:` in produzione, flusso in due commit, healthcheck sulla root. | §3.1, §3.5 |

**Difetti eliminati dalle proposte**
- **Proposta 3:** mancavano la fix di vobject e un gate a runtime. Aggiunti entrambi.
- **Proposta 2:**
  - il rollback lasciava i device scrivibili: corretto l'ordine dei passi;
  - con `skip_broken_item` un item rotto spariva dall'indice: l'indicizzatore ora verifica il file su disco;
  - le collezioni create da device non bloccavano: ora bloccano di default (decisione 4).
- **Proposta 1:**
  - PROPFIND O(n) nella sezione critica: sostituito da `stat`;
  - DDL a runtime: sostituito da un trigger guidato dallo stato;
  - `max_vevent_rrule_occurrence` era nella sezione sbagliata: va in `[server]`.

## 1. Invarianti
1. **Una sola fonte di verità per ogni dato iCalendar.**
   - Dopo il cutover la fonte è Radicale per tutto ciò che scrivono utente, device, admin, MCP e sistema: eventi, festività, chiusure, proiezioni delle prenotazioni.
   - Le iscrizioni esterne hanno come fonte il feed remoto. PG ne tiene una cache indicizzata; Radicale ne riceve una copia solo se l'iscrizione è visibile ai device.
   - In PG restano i dati di business, il sidecar dei metadati applicativi e un indice derivato, ricostruibile in ogni momento.
2. **Le decisioni di prenotazione si prendono solo su stato verificato, e il fallimento è circoscritto.**
   - Un oggetto illeggibile degrada solo sé stesso e conta come busy conservativo sul proprio intervallo.
   - Una collezione bloccante non sincronizzabile con modifiche pendenti produce 503.
   - Un singolo item non provoca mai un 503 globale. Il vincolo EXCLUDE resta l'ultima difesa.
3. **Nessuna perdita di dati iCalendar.**
   - Read-modify-write sull'oggetto completo, con If-Match.
   - La patch di vobject è attiva prima di qualsiasi scrittura dei device.
   - Versioni consultabili per 90 giorni.
   - Nessuna cancellazione di massa applicata in automatico.
4. **La semantica dipende da collezione e href/UID deterministici, mai solo dalle X-prop.**
5. **Contratti esterni invariati:** feed, path CalDAV, app-password, contratto pubblico del sito, i 22 tool MCP. Le correzioni che cambiano valori escono in release separate e annunciate; le differenze ammesse sono elencate in `allowed-diffs.json`.
6. **Postgres resta autorevole fino al cutover confermato.** Per 30 giorni dopo il cutover si può tornare indietro. Il rollback preserva sempre la semantica del busy, anche quando perde parte della rappresentazione (allarmi, invitati).
7. **Identità verificata.** API e rights lavorano solo su un volume la cui identità (`volume-id` ed `epoch`) coincide con quella registrata in PG. Nessun componente crea collezioni in modo implicito.

## 2. Architettura
```
 iPhone/Mac/DAVx5/Thunderbird                                   abbonati webcal
   https://dav.calicchia.design/federico/<slug>/                 https://<api>/api/calendar/feed/<token>.ics
        | TLS CloudPanel (X-Remote-Addr: solo per IP/rate limit)          |
   127.0.0.1:3011 -> app-net (gateway del bridge)                         |
 +------v--------------------------------------------------------+       |
 | radicale  tomsquest/docker-radicale:3.7.8.0@sha256:29a9...    |       |
 |  caldes_auth   device -> POST api-int/verify-credentials      |       |
 |                (utente = principal canonico 'federico')       |       |
 |                caldes-* -> hash locale, solo da peer caldav-int|      |
 |                cache 60 s + cache persistita 24 h (authcache) |       |
 |  caldes_rights policy.json + heartbeat.json + volume-id/epoch |       |
 |  caldes_vobject_fix (sitecustomize)                           |       |
 |  volume radicale_collections:/data   <== FONTE DI VERITA'     |       |
 +------^------------------------------+--------------------------+      |
        | CalDAV come caldes-svc       | stat + statfs (mount :ro)        |
        | su rete interna caldav-int   | props del principal (identità)   |
        | (If-Match, sync-collection,  |                                  |
        |  multiget, MKCALENDAR, MOVE) |  caldes_control (rw API, ro Rad.):|
        |                              |   policy.json, heartbeat.json    |
 +------+------------------------------v----------------------------------v----+
 | API Hono - facade lib/calendar (firme invariate)                            |
 |   store = PgLegacyStore (postgres/rollback)  |  RadicaleStore               |
 |   radicale/{client, watcher, canary, sync, discovery, identity, freshness,  |
 |             health, auditor, horizon, ids, policy, write-gate}              |
 |   @calicchia/calendar-core (ical.js 2.2.1 + VTIMEZONE canonici)             |
 |   subscriptions/{pull -> indice, mirror -> Radicale se device_visible}      |
 |   jobs (outbox/saghe)  busy (fail-closed per oggetto/collezione)  feed      |
 |   migration/{preflight, init, inventory, serialize, apply, verify, shadow,  |
 |              cutover, rollback, reverse-projector, rebaseline, finalize}    |
 |   pool SQL principale  +  pool calendario dedicato (indicizzatore, job)     |
 +-----+-----------------------------+-----------------------------+-----------+
       | SQL                         | /api/admin/calendar         | /api/calendar, /api/mcp
       v                             v (+ /v2, /migration)         v
 Postgres: business invariati       Admin React 19                sito-v3, MCP, workflow
 + sidecar calendars                FullCalendar 6.1.21 + luxon3
 + indice cal_* + versioni + jobs + stato migrazione (volume_id, epoch)
 + calendar_events (congelata dopo il cutover, alimentata dalla proiezione inversa)
```

## 3. Radicale

### 3.1 Versione e immagine
**Versione:** pin a `radicale 3.7.8` con `vobject 0.9.9`.

**Fix incluse nella 3.7.5-3.7.8:**
- EXDATE/RDATE allineati al tipo di DTSTART;
- TZID Microsoft con spazi;
- DURATION di giorni interi nel time-range;
- RDATE rimasta nelle istanze di expand;
- `max_vevent_rrule_occurrence`.

**Perché non la 3.8.x:** la 3.8.2 e la 3.8.3 sono uscite l'8 ottobre, troppo recenti. Le loro novità (gruppi, sharing, free-busy) qui non servono.

**Immagine `apps/radicale/Dockerfile`**
- `FROM tomsquest/docker-radicale:3.7.8.0@sha256:29a9098ef9851605ca37ef3a3d5e885594c7fe91731fb6edb3194a56cfc6c54e`: indice multi-arch, verificato su Docker Hub il 2026-10-09.
- `COPY plugins/ /app/plugins/`, `ENV PYTHONPATH=/app/plugins`.
- `RUN /venv/bin/python /app/plugins/caldes_selftest.py`: asserisce versioni e round-trip di fedeltà. Se la patch non funziona, la build fallisce.
- `HEALTHCHECK` (`caldes_healthcheck.py`): PROPFIND Depth:0 sulla root `/` come `caldes-probe` da 127.0.0.1, 207 atteso.
  - Passa per auth e rights, quindi un plugin rotto rende il container unhealthy.
  - Funziona anche prima dell'inizializzazione del principal: un healthcheck su `/federico/` resterebbe a 404 al primo deploy.

**Avvertenze sull'immagine tomsquest**
- `TAKE_FILE_OWNERSHIP=false` e nessuna variabile `RADICALE_CONFIG_*`: l'entrypoint riscriverebbe il config montato in sola lettura.
- Utente radicale con uid/gid 2999; `/data` ha permessi 770.

### 3.2 Configurazione (`apps/radicale/config/config`)

Estratto delle chiavi che contano (il file reale, commentato, è la fonte). Radicale legge il config con `RawConfigParser`, che non conosce i commenti in fondo alla riga: ogni commento sta su una riga propria, altrimenti finisce nel valore.

```
[server]
hosts = 0.0.0.0:5232
max_connections = 16
max_content_length = 20000000
max_resource_size = 10000000
timeout = 30
# 500 senza ritardo (contratto control-plane §10): il default di Radicale è 1 s
delay_on_error = 0
# vale anche IN LETTURA (cache miss): mai abbassarlo dopo che ci sono dati
max_vevent_rrule_occurrence = 50000
[auth]
type = caldes_auth
delay = 1
[rights]
type = caldes_rights
caldes_policy_file = /control/policy.json
caldes_heartbeat_file = /control/heartbeat.json
permit_delete_collection = False
permit_overwrite_collection = False
[storage]
type = multifilesystem
filesystem_folder = /data/collections
use_mtime_and_size_for_item_cache = True
max_sync_token_age = 5184000
skip_broken_item = True
# True dopo la matrice device di F3
strict_preconditions = False
predefined_collections = {}
[hook]
type = none
[sharing]
type = none
[web]
type = none
[logging]
level = info
mask_passwords = True
bad_put_request_content = False
```

Le scelte, motivate in laboratorio (`design-lab/final/*.py`, Radicale 3.7.8):

**`max_vevent_rrule_occurrence`**
- Radicale stima le occorrenze come (UNTIL − DTSTART) / intervallo della FREQ, ignorando INTERVAL e BY*.
- Con il default 10000:
  - una serie giornaliera fino al 2056 viene rifiutata (400);
  - una settimanale passa, e passa anche una MINUTELY infinita (201);
  - una serie con UNTIL < DTSTART viene rifiutata (400).
- Portato a 50000 e replicato identico nel validatore dell'API e nella migrazione.

**`skip_broken_item`**
- Con `True` un file rotto compare come 404 nella sync-collection pur esistendo su disco.
- L'indicizzatore distingue questo caso da una cancellazione vera controllando il file (§6.2).

**`strict_preconditions`**
- Passa a `True` solo se iOS, macOS, DAVx5 e Thunderbird superano la matrice di prova.
- L'API manda comunque sempre If-Match o If-None-Match.

**`[hook]`**
- Non si usa.
- Se un giorno servisse, `enabled` deve essere una property che restituisce True. Altrimenti la PUT risponde 500 dopo aver già salvato.

### 3.3 Plugin

**`caldes_auth.py`** usa `_login_ext(login, password, context)`; la configurazione arriva solo da env.

*Utenti di servizio:* `caldes-svc`, `caldes-probe` e ogni username con prefisso `caldes-`, che è riservato.
- Si riconoscono dal peer TCP (`context.remote_addr`), mai da un header:
  - `caldes-svc` è accettato solo da `CALDES_SVC_CIDR`, la subnet della rete interna `caldav-int` (`internal: true`, senza porte pubblicate);
  - `caldes-probe` anche da 127.0.0.1, per l'healthcheck dentro il container.
- Il traffico pubblicato su 127.0.0.1:3011 arriva dal gateway di `app-net`, che non sta mai in `CALDES_SVC_CIDR`. Una credenziale di servizio trapelata resta quindi inutilizzabile da internet, anche se CloudPanel perde l'header `X-Remote-Addr`.
- Confronto constant-time dello sha256 con l'hash in env.
- Uno username riservato da un peer non ammesso viene negato. Non ricade mai nel ramo device.
- Alert (log strutturato, poi Telegram via API) se arrivano richieste device senza `X-Remote-Addr`.

*Device:*
- POST a `CALDAV_BACKEND_URL/verify-credentials` (sulla rete `caldav-int`) con il Bearer `CALDAV_SERVICE_TOKEN`, `X-Forwarded-For` uguale a `X-Remote-Addr` e timeout di 1 s.
- L'utente Radicale restituito è sempre `RADICALE_PRINCIPAL` (`federico`), qualunque sia lo username dell'app-password. Lo username resta per audit e rate limit. Così un'app-password esistente creata come `iphone` continua a funzionare e vede `/federico/`.
- Cache positiva di 60 s in memoria. Un 401 esplicito dal backend svuota la voce.
- Cache persistita sul volume `radicale_authcache`: HMAC-SHA256 di `username:password` con chiave da env, TTL 24 h. Si usa solo come stale-if-error.
- Backend irraggiungibile, 5xx o 429:
  - credenziali in cache, anche persistita → accettate;
  - altrimenti il plugin solleva un'eccezione e Radicale risponde 500 senza delay. Il client riprova senza invalidare la password, e non si occupano thread con il delay del login fallito.
- Revoca: la policy contiene `credential_epoch`. Ogni revoca o rigenerazione lo incrementa e il plugin svuota entrambe le cache. Senza questo meccanismo la cache persistita prolungherebbe la vita di una password revocata.

**`caldes_rights.py`** (non `from_file`, che legge le regole solo all'avvio).

*Policy* `{version, mode, principal, volume_id, epoch, credential_epoch, readonly[], hidden[]}`:
- ricaricata a ogni cambio di mtime, al massimo una volta al secondo;
- se è assente o invalida vale `shadow`, cioè device in sola lettura;
- la scrive l'API in modo atomico (temporaneo + rename) sul volume `caldes_control`, che l'API monta in scrittura e Radicale in sola lettura;
- la policy è sempre una funzione dello stato in PG (§13.1), mai un'impostazione a sé.

*Heartbeat* `{schema, api_version, mode, epoch, ts}`:
- lo scrive l'API ogni 30 s;
- se manca, è più vecchio di 10 minuti, ha uno schema sconosciuto o un epoch diverso da quello della policy, la modalità effettiva diventa `frozen`;
- copre il caso di un'immagine API vecchia rimessa in produzione (§16.6) e i down lunghi dell'API.

*Identità del volume:*
- il plugin legge `collection-root/<principal>/.Radicale.props` e confronta le dead prop `{urn:calicchia:caldes}volume-id` ed `epoch` con la policy;
- se mancano o differiscono, i device non hanno alcun permesso sotto il principal (resta solo R sulla root);
- senza W Radicale non auto-crea il principal al login. Verificato su 3.7.8 in `design-lab/marker`: con il marker assente PROPFIND risponde 403 e non nasce nessuna directory; dopo MKCOL e PROPPATCH del marker da parte del servizio risponde 207.

*Regole strutturali:*
- nessun W su principal diversi da quello canonico, `caldes-svc` compreso: niente auto-creazione di `/caldes-svc/` o `/iphone/`;
- `_canary` è hidden per i device e scrivibile per il probe solo in `live`.

**`caldes_vobject_fix.py`** più `sitecustomize.py`. Codice verificato in `design-lab/final/plugins/caldes_vobject_fix.py`.

*Cosa fa la patch:*
- le proprietà sconosciute (X-*, CONFERENCE...) passano a `_RawBehavior` verbatim;
- in `TextBehavior.decode`, VALUE=URI resta verbatim e le virgole non escapate restano letterali, poi riserializzate come `\,`.

*Senza patch:*
- "SUMMARY:Pranzo, cena" diventa "Pranzo";
- la LOCATION viene troncata alla prima virgola;
- `X-FOO:a,b,c` diventa `a`;
- `geo:41.639,13.342` perde la longitudine;
- CONFERENCE e la DESCRIPTION dei VALARM vengono troncate.

*Con patch:* tutto preservato e riserializzazione idempotente, anche sul percorso PUT reale.

### 3.4 Matrice dei permessi (verificata nei lab P1, mig e marker)

| Soggetto | Path | shadow / frozen | live |
|---|---|---|---|
| caldes-svc (solo peer caldav-int) | root `''` | R | R |
| caldes-svc | `federico` | RW | RW |
| caldes-svc | `federico/<qualsiasi>` | rwD | rwD |
| caldes-svc | altri principal | nessuno | nessuno |
| caldes-probe (caldav-int o 127.0.0.1) | come il device | come il device | come il device, più rw su `_canary` |
| device (qualsiasi app-password valida → utente `federico`) | root `''` | R | R |
| device | `federico` (principal) | R | RW: MKCALENDAR ammesso |
| device | `federico/<readonly>` (bookings, f, scadenze, sub-*) | r | r |
| device | `federico/<hidden>` (`_canary`, sub-* in preparazione) | nessuno, non elencata | nessuno |
| device | altre collezioni | r | rw (DELETE della collezione vietato) |
| device | tutto sotto il principal, con identità del volume diversa o assente | nessuno | nessuno |
| device | tutto, con heartbeat scaduto o di versione sconosciuta | come frozen | come frozen |

- La lista `readonly` deriva dai ruoli del sidecar, non è cablata: lo slug di produzione `f` entra perché ha `role=holidays`. Il ruolo è salvato anche come dead prop `{urn:calicchia:caldes}role` sulla collezione, per poterlo riconciliare dopo un ripristino.
- Oggi ogni username vede tutto sotto il proprio principal: con il principal canonico quel comportamento sparisce.

### 3.5 Compose, CloudPanel e deploy

**Reti.** Nuova rete `caldav-int` (`internal: true`, subnet fissa scelta in F0 senza sovrapposizioni, per esempio `172.31.250.0/29`). Vi sono collegati solo `api` (alias `api-int`) e `radicale` (alias `radicale-int`). `app-net` resta per la porta pubblicata.

**Servizio radicale**
- `image: ghcr.io/federicokalik/calicchia-radicale:sha-<short>`, senza `build:`: in produzione Compose non deve mai buildare sul VPS saltando i test della CI.
- Volumi:
  - `radicale_collections:/data`: nome nuovo, per non rimontare il vecchio `radicale_data` della Fase 0;
  - `./apps/radicale/config:/config:ro`;
  - `caldes_control:/control:ro`;
  - `radicale_authcache:/var/lib/caldes-auth`.
- Env: `CALDAV_BACKEND_URL=http://api-int:3001/api/caldav-backend`, `CALDAV_SERVICE_TOKEN`, `CALDES_SVC_PASSWORD_SHA256`, `CALDES_PROBE_PASSWORD_SHA256`, `CALDES_PROBE_PASSWORD`, `CALDES_SVC_CIDR`, `CALDES_AUTHCACHE_KEY`, `RADICALE_PRINCIPAL=federico`, `TAKE_FILE_OWNERSHIP=false`, `TZ=UTC`.

**Servizio api**
- Volumi: `radicale_collections:/radicale-data:ro`, `caldes_control:/run/caldes-control`.
- `group_add: ["2999"]` per leggere `/data`, che ha permessi 770.
- Env: `RADICALE_URL=http://radicale-int:5232`, `RADICALE_SVC_USER`, `RADICALE_SVC_PASSWORD`, `RADICALE_PROBE_PASSWORD`, `RADICALE_PRINCIPAL=federico`, `RADICALE_DATA_DIR=/radicale-data/collections`, `CALDES_POLICY_FILE`, `CALDES_HEARTBEAT_FILE`, `CAL_FEED_UID_DOMAIN` (valore congelato), `CAL_DB_POOL_MAX=4`, `TZ=UTC`.
- Durante i 30 giorni di finestra il tag dell'immagine API è pinnato a `sha-<short>` invece di `latest` (§16.6).

**Dipendenze fra servizi.** Nessun `depends_on` rigido in nessuna direzione:
- l'API parte anche con Radicale giù;
- Radicale parte anche con l'API giù, e la cache persistita la copre.

**CloudPanel, vhost `dav.calicchia.design`**
- `proxy_set_header X-Remote-Addr $remote_addr;`: ora serve solo per IP e rate limit, non per la sicurezza;
- `client_max_body_size 20m`.

**Deploy in due commit**, documentato nel runbook:
1. il commit con le modifiche ad `apps/radicale/**` fa pubblicare alla CI l'immagine `sha-X`;
2. un secondo commit aggiorna il tag nel compose.

Ordine complessivo:
1. Radicale e volumi, con policy shadow e marker assente: i device sono comunque negati e oggi CalDAV è già rotto;
2. API con le migrazioni;
3. inizializzazione dal wizard (§13.3).

`docker-compose.prod.yml` (Dokploy) va dichiarato deprecato nel README.

## 4. Modello dati Postgres (migrazioni append-only 162-167; l'ultima applicata oggi è la 161)

**162 Sidecar.** `ALTER TABLE calendars ADD`:
- `collection_name TEXT UNIQUE` (uguale allo slug per i calendari esistenti, compreso `f`);
- `role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','bookings','holidays','deadlines','subscription','tasks'))`;
- `origin` (`admin`, `device`, `system`, `migration`);
- `lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('creating','active','deleting'))`;
- `parent_calendar_id`, `device_visible`, `components TEXT[] DEFAULT '{VEVENT}'`, `dav_props JSONB`, `missing_since`, `needs_review`.

Funzione idempotente `calendar_sidecar_reconcile()`:
- la chiamano la migrazione, ogni import di backup e l'auditor;
- per le righe con `role` di default usa la dead prop `role` della collezione, se l'indice la conosce;
- altrimenti applica le regole storiche:
  - slug `bookings` → bookings;
  - is_system con slug `f`/`festivita` oppure nome `^festivit` → holidays;
  - slug `scadenze` → deadlines.
- non sovrascrive mai un ruolo diverso dal default.

`calendar_subscriptions ADD`:
- `collection_calendar_id`: sidecar dell'iscrizione;
- `blocks_availability BOOLEAN NOT NULL DEFAULT false`;
- `device_visible BOOLEAN NOT NULL DEFAULT false`.

`calendar_id` resta il calendario di destinazione.

**163 Indice derivato**, ricostruibile.
- `cal_collection_state`: calendar_id, sync_token, dir_mtime_ns, last_synced_at, last_full_sync_at, consecutive_failures, last_error, health (`healthy|stale|unsyncable|hold`), pending_deletions, index_version.
- `cal_objects`: id, calendar_id, href, uid, etag, component, raw_ics, content_sha256, semantic_fp, origin_store (`radicale|remote`), range_start, range_end, is_recurring, materialized_until, health (`ok|quarantined|pending_404`), health_reason, last_good_version_id, x_source, x_source_id, first_seen_at, changed_at.
  - Vincoli: `UNIQUE(calendar_id, href)`, `INDEX(uid)`.
- `cal_components`: una riga per VEVENT (master, singolo o override) con i campi parsati.
- `cal_occurrences`: object_id, recurrence_key, component_id, calendar_id, start_utc, end_utc, start_date, end_date, all_day, status, transp, kind, blocks, `span tstzrange` generata.
  - `kind` ∈ event, override, orphan_override, conservative, booking_projection, holiday_system, closure.
  - `blocks` lo calcola l'indicizzatore (§9). I flag dei calendari si applicano a query time.
  - Indice GiST parziale su `span WHERE blocks`.

Tabelle persistenti, incluse nel backup SQL completo ma mai nel ripristino JSON:
- `cal_object_ids`: (calendar_id, href, recurrence_key) → id UUID, con legacy_event_id e legacy_uid (senza FK verso calendar_events) e retired_at;
- `cal_object_versions`: retention di 90 giorni, purge GDPR, nessuna versione per role=subscription.

**164 Lavori.**
- `cal_jobs`: kind, key, payload, source_version, status, attempts, run_after, last_error. La coalescenza vale solo sui job `pending` (`UNIQUE(kind,key) WHERE status='pending'`). Un job in esecuzione che a fine lavoro trova una `source_version` diversa si riaccoda.
- `cal_booking_conflicts`.

**165 Migrazione.**
- `calendar_backend_state` (singleton; creata già dalla 162 con le colonne che servono in F1, la 165 aggiunge le altre: vedi [contratto del control-plane §2](contracts/control-plane.md)): mode (`postgres|cutover|radicale|rollback|finalized`), shadow_enabled, write_freeze, volume_id, epoch, cutover_at/by, rollback_until, finalized_at, policy_version, credential_epoch, api_min_version, restore_guard_until, rebuild_required, horizon_start/end.
- `cal_migration_runs`.
- `cal_migration_ledger` (per href): legacy_key, legacy_snapshot JSONB, legacy_hash, intent_fingerprint, intent_at, written_etag, written_at, adopted, derived.
- `cal_migration_items`.

**166 Guardia** su `calendar_events`, sempre attiva e senza DDL al cutover.
- `ADD caldes_object_id UUID NULL, caldes_derived BOOLEAN NOT NULL DEFAULT false`: colonne ignorate dal codice legacy.
- Il trigger solleva un'eccezione su INSERT, UPDATE e DELETE se `mode IN ('cutover','radicale','rollback')` e `current_setting('caldes.reverse_sync', true)` è diverso da `'on'`.
- La delete di un calendario imposta il GUC (§8), così le cascate passano.
- `backup.ts` non si affida al trigger, che `session_replication_role=replica` spegne: esclude il dominio a livello applicativo (§16.2).

**167 Rilasciata dopo il finalize.** Funzione idempotente `calendar_finalize_legacy()`: rename in `calendar_events_legacy` più vista di compatibilità `calendar_events`.

## 5. Identità, provenienza e convenzioni iCalendar

**UID e href**

| Categoria | Collezione | UID | href |
|---|---|---|---|
| Eventi migrati | slug invariato | uid legacy verbatim | quello già noto (ledger o `cal_object_ids`), altrimenti `<uid>.ics` (sha256 se il nome non è sicuro) |
| Override migrati | stesso oggetto del master | UID del master | — |
| Festività migrate | `f` | uid legacy | `it-holiday-YYYY-MM-DD.ics` |
| Festività nuove | `f` | `it-holiday-YYYY-MM-DD@caldes.it` | come sopra; idempotenza con `If-None-Match: *` |
| Chiusure | holidays | uid legacy o nanoid | `closure-<id>.ics` |
| Proiezioni prenotazioni | bookings | `<booking.uid>@caldes.it` (come l'invito `ics.ts`) | `booking-<uid>.ics`, legata alla riga legacy della proiezione |
| Iscrizioni visibili | `sub-<id8>` | UID remoto | `r-<base32(sha256(UID))[0..26]>.ics` |
| Nuovi da admin/MCP | — | nanoid(16) | `<uid>.ics` |
| Da device | — | scelto dal client | scelto dal client, sempre riusato |

**Gli id**
- `id` = `cal_object_ids.id`. Per i dati migrati è l'UUID legacy del master o dell'override.
- Le proiezioni migrate prendono `legacy_event_id` dalla riga con `source='booking' AND source_id=<uid>`: gli id restituiti oggi da `list_events` restano validi.
- Per gli oggetti nuovi si usa UUID v4. Il fallback deterministico è uuidv5(UID|recurrence_key).
- Un MOVE (UID sparito in A e comparso in B entro 30 giorni) ri-chiava l'id, che resta stabile.

**`getEvent(id_or_uid)`**:
1. `cal_object_ids.id`;
2. UID esatto, preferendo le collezioni scrivibili; se ambiguo, errore con i candidati;
3. `legacy_uid`;
4. UID con o senza `@dominio`.

**Provenienza**, solo da collezione e href:

| role | Item | source | source_id |
|---|---|---|---|
| bookings | href `booking-*` | booking | booking.uid |
| bookings | altri item | `X-CALDES-SOURCE` se ∈ {manual, admin, mcp, agent}, altrimenti `manual` | — |
| holidays | href `it-holiday-*` | system | it-holiday-YYYY-MM-DD |
| holidays | altri | `admin` (o `X-CALDES-SOURCE` ammessa) | — |
| subscription | — | ics_pull | UID remoto |
| user, deadlines, tasks | — | `X-CALDES-SOURCE` ammessa, altrimenti `manual` | — |

Una X-prop non può mai promuovere un evento a booking o system. Gli item non-proiezione della collezione bookings restano manual/admin: `get_calendar_today` e la capacity, che filtrano per `source='booking'`, li trattano come oggi.

**All-day**
- In Radicale sono sempre VALUE=DATE: DTSTART, DTEND esclusivo, EXDATE, RDATE, RECURRENCE-ID e UNTIL come DATE.
- Nei JSON legacy e MCP: mezzanotte Europe/Rome in ISO UTC più `all_day=true`. Le API v2 aggiungono `start_date`/`end_date`.

**Fusi**
- TZID per evento preservato. I timed creati dall'API usano il fuso del calendario; un orario floating si interpreta nel fuso del calendario.
- Registro canonico (timezones-ical-library 2.3.2): per un TZID IANA si usa il VTIMEZONE canonico; per un TZID non IANA, quello dell'oggetto più la mappa dei nomi Windows.

## 6. Sincronizzazione e coerenza

### 6.1 Campanello (`radicale/watcher.ts`, `canary.ts`)

**Il campanello**
- Ogni secondo fa `stat` della directory del principal, del file props del principal (per l'identità) e di ogni collezione Radicale-backed (le `sub-*` sono escluse, §6.6).
- Verificato su 3.7.8: la mtime della directory cambia con MKCALENDAR, PUT, PROPPATCH, MOVE e DELETE; non cambia con GET, PROPFIND e REPORT.
- Principal cambiato → discovery. Collezione cambiata → `syncCollection`. Props del principal cambiate → controllo d'identità (§6.3).

**Canary e statfs**, all'avvio e ogni 10 minuti:
- `caldes-svc` fa una PUT con If-Match su `_canary/beat.ics` e verifica che la mtime cambi via mount entro 100 ms dalla risposta;
- `fs.statfs` sul mount deve restituire un filesystem locale (ext4, xfs, btrfs). NFS, CIFS e driver di rete hanno cache degli attributi che renderebbero il campanello cieco.

**Remote mode**, quando il mount manca o un controllo fallisce. È una modalità a disponibilità ridotta, dichiarata con banner e alert, e non soltanto più lenta:
- ogni 30 s un PROPFIND Depth:1 sul principal con i sync-token;
- nelle decisioni, PROPFIND Depth:0 per collezione con un budget calcolato dalle dimensioni (circa 0,6 s a caldo ogni 5000 item): se la somma supera 2 s, le decisioni rispondono 503;
- un 404 conta come cancellazione solo dopo due sync consecutive (stato `pending_404`); nel frattempo l'oggetto resta e continua a bloccare.

### 6.2 `syncCollection(c)`: unico canale dati
- **Pool dedicato** (`CAL_DB_POOL_MAX=4`), separato dal pool principale.
- **Single-flight in memoria per collezione**, più `pg_try_advisory_lock('cal-sync:<id>')` per la sicurezza fra processi. Chi trova una sync in corso ne attende l'esito senza tenere connessioni.

Passi:
1. Controllo d'identità (props del principal in cache, aggiornate a ogni cambio di mtime). Se l'identità non coincide, stop e `CalendarUnavailableError`.
2. Si annotano la mtime m0 e l'istante di osservazione prima del REPORT.
3. REPORT sync-collection dal token salvato. Un 403 valid-sync-token porta al full resync (PROPFIND getetag e diff).
4. Multiget a blocchi di 100 href.
5. Per ogni 404:
   - file ancora presente su disco → item saltato da Radicale: l'oggetto resta, va in quarantena con `health_reason='radicale-skip'` e parte un alert;
   - file assente → cancellazione candidata.
6. **Interruttore anti-cancellazione di massa.**
   - Scatta se le cancellazioni candidate superano max(50 oggetti, 20%) della collezione, oppure se la collezione intera risulta sparita o vuota.
   - In quel caso non si applica nulla: la collezione passa in `hold`, le occorrenze esistenti continuano a bloccare e parte un alert.
   - Nella pagina sync-state l'admin sceglie fra "applica cancellazioni" e "ricostruisci in Radicale dall'indice" (§16.3).
7. Parse ed espansione con ical.js fuori dalla transazione. Oltre i 200 oggetti si usano `worker_threads`, per non bloccare l'event loop che serve `verify-credentials`.
8. `BEGIN … SELECT sync_token FOR UPDATE`; se il token non è più quello di partenza, rollback (CAS).
9. Upsert, versioni (testo delle cancellazioni compreso), rigenerazione delle occorrenze.
10. Aggiornamento di `sync_token` e `dir_mtime_ns = m0`. m0 si salva solo se è più vecchio di 50 ms rispetto all'osservazione, altrimenti NULL (finestra "racy").
11. `index_version++`, COMMIT, `NOTIFY calendar_index_changed`.

### 6.3 Discovery, creazione e identità
**Discovery**
- PROPFIND Depth:1 sul principal: displayname, color, order, description, timezone, component-set, resourcetype, sync-token, dead prop `calendar-id` e `role`.
- Collezione con dead prop `calendar-id` nota → adozione della riga esistente, anche se in stato `creating`.
- Collezione nuova senza dead prop → riga sidecar con origin=device, role=user (tasks se è solo VTODO), blocks_availability secondo la decisione 4, `needs_review`, feed disattivato.
- Collezione sparita → `missing_since` e alert, mai una cancellazione automatica. L'indice tiene le occorrenze finché l'admin non conferma.

**Creazione esplicita.** Nessun componente fa MKCOL o MKCALENDAR in automatico: né al boot, né nell'apply in `mode=radicale`, né la discovery. Il principal e le collezioni iniziali nascono solo dal passo "Inizializza Radicale" del wizard (§13.3).

**Identità**
- Ad ogni cambio delle props del principal si confrontano `volume-id` ed `epoch` con `calendar_backend_state`.
- Se non coincidono:
  - facade in sola lettura e decisioni in 503;
  - policy frozen (che i rights già applicano da soli per mismatch);
  - alert e wizard in "verifica identità".
- Un volume vuoto, di un altro stack, della Fase 0 o ripristinato da uno snapshot precedente all'ultimo cambio di epoch non viene mai trattato come verità.

### 6.4 Espansione (`@calicchia/calendar-core/expand`)
**Abbinamento degli override**
- Abbinamento proprio, non quello implicito di ical.js. La chiave è l'istante UTC per un DATE-TIME con TZID e la data locale per un DATE.
- DATE e DATE-TIME si confrontano sulla data locale nel fuso del calendario.

**Override non abbinati**
- Diventano occorrenze autonome (`kind='orphan_override'`), bloccanti secondo le proprie proprietà, con badge in admin e alert.
- Non spariscono più dal busy, come invece accadeva con ical.js.

**Tetto**
- Al massimo 5000 occorrenze per oggetto, contate solo dentro l'orizzonte.
- Per raggiungere l'orizzonte c'è un budget separato di 200k iterazioni: una DAILY dal 2010 ne richiede circa 6000, una HOURLY dal 2010 circa 145k.
- Budget esaurito:
  - l'oggetto va in quarantena (`expansion-budget`);
  - riceve un'occorrenza `conservative` su [max(DTSTART, inizio orizzonte), min(UNTIL, fine orizzonte)), bloccante solo se il master bloccherebbe;
  - parte un alert.
- Oltre le 5000 occorrenze nell'orizzonte: `materialized_until`. Le decisioni oltre quella data espandono al volo solo quell'oggetto, su finestra; se fallisce, blocco conservativo della sola finestra richiesta per quel solo oggetto.

### 6.5 Salute per oggetto e per collezione

| Stato | Effetto sulle decisioni |
|---|---|
| Oggetto `ok` | Normale |
| Oggetto in quarantena con ultima versione buona | Restano le occorrenze di quella versione (marcate stale); alert e badge |
| Oggetto in quarantena senza versione buona | Busy conservativo sull'intervallo estratto in modo tollerante (DTSTART..UNTIL/DTEND con regex sul testo). Senza alcun intervallo estraibile: escluso dal busy, alert e badge "illeggibile" (rischio residuo: nessun client lo vedrebbe comunque come evento) |
| Oggetto `pending_404` | Continua a bloccare |
| Collezione `healthy` | Normale |
| Collezione `stale` (modifiche non indicizzate da più di 2 minuti) | Banner in admin; le decisioni forzano la sync |
| Collezione `hold` (cancellazioni di massa sospese) | Le occorrenze esistenti bloccano; nessun 503 |
| Collezione `unsyncable` (sync che fallisce con modifiche pendenti) | Se è bloccante: 503 nelle decisioni subito, e nel livello display dopo 10 minuti |

Un feed esterno con una RRULE invalida, o una serie MINUTELY creata da device, lascia `/slots` a 200: è un test di contratto.

### 6.6 Iscrizioni
- **Pull** (ogni 15 minuti come oggi), con etag e last-modified azzerati alla migrazione per evitare la trappola del 304:
  - `ics-split` (ical.js);
  - fingerprint semantico per UID remoto: serializzazione canonica senza DTSTAMP, e senza LAST-MODIFIED e SEQUENCE se il resto è invariato;
  - diff con l'indice e un'unica transazione di upsert e delete sugli oggetti `origin_store='remote'` del sidecar dell'iscrizione, con `index_version++`;
  - nessuna versione;
  - anti-wipe come oggi (body vuoto o HTML rifiutato, force esplicito).
- Nelle decisioni le iscrizioni usano l'indice dell'ultimo pull completato: non stanno nel set di freschezza e la loro sync non interferisce con le prenotazioni.
- **Specchio** su Radicale solo per `device_visible`: job a bassa priorità, PUT solo per i fingerprint cambiati (ledger per href), al massimo 5 PUT/s. La collezione `sub-<id8>` è in sola lettura per i device e il watcher la ignora, perché Radicale non è la sua fonte.
- **Prima del cutover:** il pull legacy verso `calendar_events` resta invariato, compreso il sottoinsieme bacato (parità). Da F3 il nuovo pull popola l'indice in parallelo, in shadow.

### 6.7 Ricostruzione dell'indice
1. In una sola tx: `rebuild_required=true`, `dir_mtime_ns=NULL` e `sync_token=NULL` per tutte le collezioni.
2. Ogni collezione si ricostruisce in una propria tx atomica (delete, insert e stato insieme).
3. A fine giro `rebuild_required=false`.

Durante il rebuild le decisioni trovano `dir_mtime` NULL e forzano la sync completa della collezione entro il budget, altrimenti 503. Non si decide mai su righe vecchie che sembrano fresche. Gli id restano in `cal_object_ids`, quindi si ripresentano identici.

### 6.8 Auditor notturno
- (href, etag) di Radicale contro l'indice per ogni collezione: una differenza produce full resync, passando per l'interruttore, più un alert.
- File `.ics` su disco assenti dal listing: sono item rotti, e il controllo sostituisce `--verify-storage`.
- Prenotazioni contro collezione bookings, in sola lettura (§9).
- Coerenza fra identità, epoch, heartbeat e policy derivata dallo stato. `calendar_sidecar_reconcile()`.
- Orizzonte, oggetti in quarantena, collezioni in hold.

### 6.9 Orizzonte
- `cal_occurrences` copre [oggi − 400 g, oggi + 800 g].
- Garanzia statica: `horizon_end ≥ oggi + max(max_advance_days) + 14 g`. Se non regge, le decisioni falliscono chiuse.
- Fuori orizzonte (admin nel 2030, export) l'espansione avviene al volo da `cal_objects`.

## 7. Percorso di lettura

| Consumatore | Fonte | Garanzia |
|---|---|---|
| Admin `GET /events` (v1), widget agenda | `cal_occurrences` ⋈ `cal_components` ⋈ `calendars` | Visualizzazione con header `X-Calendar-Index-As-Of`; forma `CalendarEventOccurrence` invariata; query per sovrapposizione |
| Editor (`GET /events/:id`, `/v2/objects/:id`) | GET diretto su Radicale | Con Radicale giù, fallback sull'indice in sola lettura |
| `/slots`, `/api/contacts/cal-slots`, `find_free_slots`, `get_calendar_availability` | Busy dall'indice, livello display | Watcher vivo, identità ok, nessuna collezione bloccante `unsyncable` da più di 10 minuti; altrimenti 503. I singoli oggetti in quarantena non causano mai 503 |
| `createBooking`, reschedule | Busy livello decision (§9) | Freshness verificata dentro l'advisory lock |
| Capacity (dashboard e sezione critica) | Una sola aggregazione SQL per settimana ISO Europe/Rome | Esclusioni identiche a oggi: proiezioni (`source='booking'`), `source='system'`, calendario role=holidays, all-day, eventi non CONFIRMED. Bucket per source come oggi |
| Tool MCP e `/api/device/agenda` | `store.listOccurrences` con `romeDayWindow` | L'agenda espande finalmente le ricorrenze |
| Feed | Indice della collezione | Funziona anche con Radicale giù (§10) |
| `/closures` | Collezione holidays: tutti gli item tranne `it-holiday-*`, con fine > oggi − 30 g | Comprende gli eventi creati in `f` dall'editor o da MCP, come oggi (source ≠ system). Niente più creazione del calendario come effetto collaterale |
| `list_calendars`, `GET /calendars` | Sidecar + `dav_props` + conteggi | `event_count` con la semantica legacy: VEVENT non CANCELLED, override compresi, sommando le iscrizioni con quel parent. Le `sub-*` non compaiono in elenco |
| Workflow `tool_db_query` | Fino al finalize `calendar_events`, alimentata dalla proiezione inversa; dopo, la vista | — |

Query di busy:
```sql
SELECT o.start_utc, o.end_utc FROM cal_occurrences o
JOIN calendars c ON c.id = o.calendar_id
LEFT JOIN calendars p ON p.id = c.parent_calendar_id
LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
WHERE o.blocks
  AND CASE WHEN c.role = 'subscription'
           THEN COALESCE(s.blocks_availability, false) AND p.blocks_availability
           ELSE c.blocks_availability END
  AND o.span && tstzrange($1, $2, '[)');
```

## 8. Percorso di scrittura (RadicaleStore)

**Pipeline**
1. **Guardie applicative per l'API, identiche a oggi** (stessi errori e messaggi):
   - evento di un'iscrizione → `EventReadOnlyError` con il testo attuale di `assertWritable`;
   - delete dell'evento di una prenotazione `pending/confirmed` (href `booking-*`) → `EventReadOnlyError('Evento di una prenotazione attiva: annullala da Calendario → Prenotazioni.')`;
   - calendario `is_system` non eliminabile → come oggi;
   - `source` dal client ammessa solo in {admin, manual, mcp, agent}.
   
   Nessuna nuova guardia di ruolo per l'API: create e update su bookings, `f` e scadenze restano permessi come oggi. La sola lettura di quelle collezioni vale per i device, tramite la policy.
   
   Validatori aggiuntivi:
   - `validate.ts`: component-set, niente RRULE SECONDLY o MINUTELY, al massimo 5000 istanze nell'orizzonte, stima Radicale ≤ 50000, UNTIL ≥ DTSTART, tipi coerenti, DTEND > DTSTART, dimensione massima 1 MB;
   - un target `{recurrence_key}` che non appartiene più al set corrente dell'oggetto → 409 `CALENDAR_CONFLICT` (niente nuovi orfani).
2. **Gate di scrittura.** `pg_advisory_lock_shared('cal-write')` sul pool calendario, più la rilettura senza cache di `mode` e `write_freeze`. Con il freeze attivo: 503 `CALENDAR_UNAVAILABLE` in admin, `{error}` in MCP. Le transizioni di stato prendono il lock in modo esclusivo (§13.9).
3. GET dell'oggetto: testo ed ETag.
4. **CAS per campo.** Se l'If-Match non coincide, si confrontano i valori `base` dei campi toccati. Se sono uguali si applica la patch al corrente, altrimenti 409 con `{field, base, theirs, yours}`.
5. **Patch con ical.js** sui soli campi toccati. VALARM, ATTENDEE, X-* e parametri sconosciuti restano dove sono. SEQUENCE+1 se cambiano orari, ricorrenza, luogo o stato; LAST-MODIFIED e DTSTAMP aggiornati.
6. PUT con `If-Match`; in creazione con `If-None-Match: *`. Su 412 si torna al passo 3, al massimo 3 volte.
7. **Write-through:** `syncCollection` sincrona (single-flight), così il chiamante riceve il nuovo ETag dall'indice.
8. Riga in `audit_logs` con attore, href ed ETag prima e dopo.

Per MCP e admin v1 la `base` è implicita (i valori letti al passo 3), con un solo retry: è la semantica di oggi.

**Ricorrenze**, tutte lato server:
- **Solo questa:** override con RECURRENCE-ID dello stesso tipo e TZID di DTSTART.
- **Elimina questa:** EXDATE tipizzato più la rimozione dell'eventuale override.
- **Tutta la serie:**
  - uno spostamento di Δ si applica anche a RECURRENCE-ID ed EXDATE;
  - un cambio di RRULE con `dryRun` restituisce `orphanedOverrides`.
- **Questa e le successive:** saga in `cal_jobs`.
  - (a) nuova serie con UID nuovo, `RELATED-TO;RELTYPE=SIBLING`, gli override ed EXDATE successivi al taglio e il COUNT residuo;
  - (b) vecchio master con UNTIL al giorno precedente (DATE) oppure all'istante di taglio − 1 s;
  - compensazione con DELETE della nuova serie; recovery all'avvio e ogni minuto;
  - un taglio sulla prima istanza equivale a "tutta la serie".
- **Sposta:** MOVE con `Overwrite: F` dopo il controllo dell'ETag.
- **Duplica:** la copia nasce alla data dell'occorrenza.

**Calendari**
- **Crea:**
  1. riga sidecar con `lifecycle='creating'`, che prenota `collection_name`;
  2. MKCALENDAR con displayname, colore, descrizione, ordine, calendar-timezone, component-set e dead prop `calendar-id` e `role`;
  3. `lifecycle='active'`.
  
  Se la MKCALENDAR fallisce, la riga viene eliminata. La discovery adotta per dead prop, quindi non nasce mai una riga orfana. 409/405 danno lo stesso messaggio di oggi.
- **Modifica:** PROPPATCH (anche della dead prop `role`) più aggiornamento dello specchio.
- **Elimina:**
  1. guardie;
  2. `lifecycle='deleting'`;
  3. DELETE della collezione (solo `caldes-svc` ha D);
  4. delete della riga in una tx con `SET LOCAL caldes.reverse_sync='on'`, così le cascate su `calendar_events` passano il trigger 166.
  
  Un crash fra il passo 3 e il 4 lascia la riga in `deleting`; il recovery la completa.

**Scrittori di sistema** (`cal_jobs`, convergenti e idempotenti; coalescenza solo sui pending con ricontrollo della `source_version`)
- `project_booking`: lo stato desiderato si calcola da `calendar_bookings` al momento dell'esecuzione.
- Festività: `If-None-Match`; un 412 significa "esiste già".
- Specchio delle iscrizioni visibili, shadow mirror, proiezione inversa.

Limiti: al massimo 20 PUT/s complessive; mai un PUT dell'intera collezione.

## 9. Prenotazioni e busy

**Regola `blocks`**, calcolata dall'indicizzatore. Un'occorrenza blocca se valgono tutte le condizioni:
- è un VEVENT;
- STATUS è CONFIRMED o assente;
- TRANSP non è TRANSPARENT;
- è timed, oppure è all-day e lo consente la regola della decisione 8;
- `kind` è diverso da `booking_projection`.

**Regole a livello di calendario**
- Bloccano solo i calendari con `blocks_availability`.
- Le iscrizioni bloccano solo se lo prevedono sia il flag dell'iscrizione (default false) sia quello del calendario di destinazione.

**Proiezioni fuori dal busy**
- Le proiezioni `booking-*` non entrano nel busy: le prenotazioni bloccano già tramite `calendar_bookings`, con buffer ed EXCLUDE.
- Così la riprogrammazione su uno slot sovrapposto all'originale funziona davvero: la tx annulla l'originale e niente resta nell'indice ad aspettare il job.
- Gli item non-proiezione della collezione bookings bloccano come oggi.

**Altro**
- Festività e chiusure restano timed 00:00→24:00 Europe/Rome.
- Le pending bloccano tramite EXCLUDE.
- Gli eventi migrati non hanno TRANSP e valgono OPAQUE: parità.

**Protocollo di decisione** (`createBooking`, `rescheduleBooking`, con qualsiasi source compresi mcp e admin_manual, perché la capacity nella sezione critica legge gli eventi)
```
tx: pg_advisory_xact_lock(settimana ISO Europe/Rome)                 -- invariato
    stato (letto nella tx, senza cache): identità ok, epoch ok, nessun freeze bloccante
    freshness.verify(set = collezioni Radicale bloccanti + bookings + principal; escluse le iscrizioni, 2,5 s):
      stat(dir) == dir_mtime_ns (non NULL, non racy)  -> ok, nessun HTTP
      principal cambiato -> discovery
      dir cambiata o NULL -> syncCollection single-flight (pool dedicato; se già in corso se ne attende l'esito)
      remote mode -> PROPFIND Depth:0 sync-token entro il budget
      timeout, errore, collezione bloccante unsyncable, identità diversa -> CalendarUnavailableError (503)
    require_available_slot / busy / capacity: SQL sull'indice con db: tx
    INSERT calendar_bookings (EXCLUDE)  +  INSERT cal_jobs('project_booking', source_version)
commit
post: nuovo stat; se qualcosa è cambiato -> sync + controllo sovrapposizione
      -> cal_booking_conflicts + alert (nessun annullamento automatico)
```

Con Radicale giù e nessuna modifica pendente la mtime non cambia, quindi le prenotazioni proseguono. `local-busy.ts` fail-open viene eliminato e `busy.ts` solleva sempre l'errore, anche sullo store legacy.

**Mappatura degli errori**
- **Sito:** `503 {error:'Calendario temporaneamente non verificabile, riprova tra poco', code:'CALENDAR_UNAVAILABLE'}`. Il client tratta già ogni stato diverso da 400/403/409 come errore generico.
- **MCP:** `create_booking` e `reschedule_booking` restituiscono il ramo catch-all già esistente `{error: <messaggio>}`, senza `code`. Gli executor non cambiano forma.
- **`find_free_slots` e `get_calendar_availability`:** l'indisponibilità si propaga come oggi qualsiasi errore interno (per esempio un DB giù). Nessuna forma nuova.

**Proiezione delle prenotazioni**
- Collezione `bookings`, in sola lettura per i device. Proiettata per gli stati confirmed, completed e no_show; le pending no (parità).
- Contenuto del VEVENT:
  - UID `<uid>@caldes.it`, lo stesso dell'invito;
  - SUMMARY «${title} – ${attendee_name}»;
  - LOCATION, URL, STATUS:CONFIRMED;
  - DESCRIPTION secondo la decisione 3;
  - ORGANIZER e ATTENDEE (che contiene l'email `mailto:`) solo con l'opzione "Tutti".
- Cancellazione e riprogrammazione: DELETE della vecchia risorsa e PUT della nuova. Per le proiezioni migrate, update della risorsa legata alla riga legacy.
- **Riconciliazione notturna in sola lettura per le cancellazioni:**
  - crea le proiezioni mancanti;
  - le proiezioni senza prenotazione (orfane) non vengono mai cancellate in automatico: si marcano, parte un alert e compaiono nell'elenco "prenotazioni da recuperare" (§16.3);
  - le modifiche di campo fatte dall'API sulle proiezioni (consentite oggi) non vengono annullate: le derive d'orario producono `BOOKING_DRIFT` in alert.
- Retention: le proiezioni concluse da più di N mesi (decisione 3) vengono ridotte a SUMMARY "Prenotazione", senza DESCRIPTION.

## 10. Condivisione invariata

**Feed `GET /api/calendar/feed/:token.ics`:** stesso router e stesso montaggio (app.ts:292).
- Token di 32 caratteri in `calendars.ics_feed_token`: stessi valori, che la migrazione non tocca.
- 404 se disabilitato; restano toggle, rotate-token e `buildFeedUrl`.
- Header invariati: `text/calendar`, `Cache-Control: private, max-age=300`, CORS `*`.

Generazione:
- Dall'indice della collezione, con la finestra di oggi: serie sempre, singoli da −90 a +365 giorni.
- Filtri identici a oggi: niente iscrizioni (mai nel feed) e niente master o singoli con STATUS:CANCELLED, compresi quelli scritti dai device.
- Override nella risorsa del master con lo stesso UID; occorrenze cancellate come EXDATE; VTIMEZONE deduplicati.
- **UID:**
  - per le proiezioni migrate si pubblica `legacy_uid@CAL_FEED_UID_DOMAIN`, preso da `cal_object_ids`, cioè l'UID che gli abbonati vedono oggi;
  - gli altri UID senza `@` ricevono il suffisso `@CAL_FEED_UID_DOMAIN` (valore congelato);
  - gli UID con `@` passano invariati.
- DTSTAMP stabile, preso da LAST-MODIFIED o da `first_seen_at`.
- **ETag** = sha256 del corpo generato, con cache in memoria per (index_version della collezione, versione del sidecar, versione della trasformazione, data Europe/Rome), e 304 su If-None-Match. Quando la finestra scorre il corpo cambia, e con lui l'ETag: la festività che entra a +365 giorni arriva agli abbonati di `f`.

Privacy per costruzione, con una whitelist di proprietà:
- passano UID, DTSTAMP, DTSTART, DTEND/DURATION, RRULE, RDATE, EXDATE, RECURRENCE-ID, SUMMARY, DESCRIPTION, LOCATION, URL, STATUS, TRANSP, SEQUENCE, CREATED, LAST-MODIFIED;
- niente VALARM, ATTENDEE, ORGANIZER né X-*;
- `CLASS:PRIVATE/CONFIDENTIAL` → SUMMARY "Occupato", senza DESCRIPTION, LOCATION e URL.

**CalDAV**
- Path invariati: `https://dav.calicchia.design/federico/<slug>/`, stesso vhost, stessa porta 127.0.0.1:3011. Collezioni con il nome esatto di `calendars.slug`, compresi `f` e `creattivamente-srl`.
- Lo sharing a token di Radicale non viene usato.

**App-password**, invariate: tabella `caldav_app_passwords`, `lib/calendar/caldav-passwords.ts`, route `/api/caldav-tokens`, UI `apps/admin/src/pages/impostazioni/caldav-tokens-section.tsx`.

`POST /api/caldav-backend/verify-credentials` mantiene la stessa forma, con queste differenze:
- restituisce sempre `principal = RADICALE_PRINCIPAL`;
- accetta `X-Forwarded-For` (solo con il service token valido);
- applica il rate limit per (IP del device, username) e registra `last_used_ip` reale.

Username riservati (`caldes-*`):
- rifiutati con 400 in `/api/caldav-tokens`;
- rifiutati con 401 in `verify-credentials`;
- rifiutati anche nel plugin.

La UI propone `federico`, in sola lettura. Le app-password esistenti con altri username continuano a funzionare, mappate sul principal canonico; il preflight le elenca. Dalle route di caldav-backend si tolgono solo `/collections*`.

## 11. Admin come client CalDAV quasi 1:1

**Architettura**
- API a comandi lossless, con ETag e If-Match dal browser fino a Radicale.
- Niente CalDAV nel browser.
- Package condiviso `packages/calendar-core` (`@calicchia/calendar-core`, ical.js) per API e admin: anteprima RRULE, riepilogo in italiano, validazione, parsing degli import, editor raw.

**Endpoint `/api/admin/calendar/v2`**
- *Oggetti:*
  - `GET /occurrences`, `GET /objects/:id` ({etag, ics, model, overrides, readonly_reason, health}), `POST /objects`;
  - `PATCH /objects/:id` (`If-Match`, `{target, scope, ops[], base{}, dryRun?}`), `PUT /objects/:id/ics`, `DELETE /objects/:id?scope&recurrence_key`;
  - `POST /objects/:id/move`, `POST /objects/:id/duplicate`;
  - `GET /objects/:id/versions`, `POST /objects/:id/restore`, `GET /objects/:id/export.ics`, `GET /trash`.
- *Calendari:* `GET|POST|PATCH|DELETE /calendars`, `PUT /calendars/order`, `POST /calendars/:id/rotate-token`, `GET /calendars/:id/export.ics`, `POST /calendars/:id/import` (dry_run, poi commit a lotti).
- *Salute e recupero:*
  - `GET /sync-state`: collezioni, oggetti in quarantena, hold, identità, heartbeat, canary;
  - `POST /collections/:id/apply-deletions`, `POST /collections/:id/rebuild-from-index`.
- *Altro:* `GET /overlays`, `GET /timezones`, `GET /todos` (se si sceglie VTODO).

**Copertura del modello**
- Campi: SUMMARY, DESCRIPTION, LOCATION, URL, STATUS, TRANSP ("Mostra come"), CLASS, PRIORITY, CATEGORIES, COLOR, GEO.
- Tempi: DTSTART, DTEND o DURATION, con TZID per evento, floating e all-day veri.
- Ricorrenza: RRULE completa, RDATE, EXDATE con "ripristina occorrenza", override completi.
- VALARM: DISPLAY, EMAIL, AUDIO, preservando X-APPLE-DEFAULT-ALARM.
- ORGANIZER e ATTENDEE; CONFERENCE, ATTACH (URI), RELATED-TO.
- X-* modificabili; editor ICS raw.
- In sola lettura: UID, SEQUENCE, DTSTAMP, CREATED, LAST-MODIFIED.
- Avviso visibile: Radicale non implementa RFC 6638, quindi gli invitati non ricevono nulla in automatico.

**UI**
- *Vista:* FullCalendar 6.1.21 con `@fullcalendar/luxon3` 6.1.21, `luxon` 3.7.2 e `timeZone="Europe/Rome"`; viste lista e anno.
- *Interazioni:* ScopeDialog per qualsiasi modifica di una ricorrenza; drag fra calendari = MOVE; festività per `role`; badge per orfani e quarantena; polling di `/sync-state` ogni 20 s.
- *Editor e strumenti:* editor a tab (Generale, Tempo, Ricorrenza, Promemoria, Partecipanti, Avanzate), ConflictDialog, cronologia con ripristino, cestino, import ed export.
- *Calendari:* `calendari.tsx` esteso (proprietà CalDAV, URL, ruolo, badge "nuovo dal dispositivo", stato della sincronizzazione).
- *Pagina "Salute del calendario":* quarantene, hold con scelta fra "applica" e "ricostruisci", identità, canary.
- *Pagina Backup:* avviso esplicito in `mode≠postgres` (§16.2).

**Compatibilità**
- Le route v1 restano, mappate sulle stesse operazioni lossless.
- Il cutover non dipende dal nuovo editor. Prima del cutover la UI attuale riceve solo questi ritocchi:
  - saga lato server per "questa e le successive";
  - selezione degli all-day;
  - `timeZone` di FullCalendar;
  - UNTIL a fine giornata locale.
- Le query key di react-query restano.

## 12. Contratti del sito e MCP
- **Facade.** `lib/calendar/events.ts`, `calendars.ts` e `subscriptions.ts` mantengono nomi e firme e delegano a `store()`. Il mode si legge con una cache di 2 s più LISTEN solo per le letture; scritture e decisioni lo rileggono senza cache (§8, §9).
- **Contratto pubblico del sito.** Restano in Postgres prenotazioni, event types, disponibilità, token HMAC, EXCLUDE e advisory lock. Cambia solo la sorgente del busy.
- **MCP** (`apps/mcp` è un proxy puro, quindi il contratto è l'array `tools` di `tools.ts`):
  - **Adattatori.** `toLegacyOccurrence`, `toLegacyCalendar` e `toLegacyEvent` producono esattamente le chiavi di oggi.
  - **Proiezioni.** Per `kind=booking_projection` la `description` si ricompone dai dati di `calendar_bookings` con il template attuale di `booking.ts`. MCP e admin vedono lo stesso testo di oggi qualunque sia la decisione 3 sui dati che vanno ai device.
  - **Id.** Gli id delle proiezioni migrate restano quelli legacy (§5).
  - **Snapshot.** Nel codice ci sono 19 nomi letterali di tool calendario. Lo snapshot generato in F0 diventa la lista vincolante dei "22" e gira su entrambi gli store.
  - **Errori.** Mappatura descritta al §9, senza forme nuove. Il sostituto di 23505 in `create_calendar` produce lo stesso testo.
  - **Differenze ammesse** in `allowed-diffs.json`, ciascuna motivata:
    1. gli override espongono l'UID del master (RFC 5545);
    2. gli all-day delle iscrizioni passano dalla mezzanotte UTC alla mezzanotte di Roma;
    3. le iscrizioni mostrano l'insieme completo di eventi (fix di `parseIcs`) invece del sottoinsieme bacato;
    4. la descrizione delle proiezioni si ricompone dai dati correnti della prenotazione;
    5. le occorrenze di eccezioni riallineate da `DST_SHIFTED_EXCEPTION` (già corrette in PG in F0).
- **Parità prima.** Escono in una release R+1 annunciata:
  - `find_free_slots` in Europe/Rome;
  - limite di 366 giorni;
  - eventuale controllo dei conflitti per admin e MCP (decisione 2).
  
  Le descrizioni che citano il tool inesistente `create_event_exception` si correggono quando si vuole.
- **Agenda device.** Ricorrenze espanse e giorno Europe/Rome già in F2, su entrambi gli store, con la stessa forma JSON.

## 13. Strumento di migrazione (admin, `/calendario/migrazione`)

### 13.1 Macchina a stati e policy derivata

| mode | Facade | Policy device (derivata) | Mirror |
|---|---|---|---|
| postgres | PG | shadow (sola lettura) | PG→Radicale se `shadow_enabled` |
| cutover | PG, scritture calendario in 503 | frozen | — |
| radicale | Radicale + indice | live (frozen se `write_freeze`) | proiezione inversa fino a `rollback_until` |
| rollback | Radicale, scritture in 503 | frozen | ultimo passaggio della proiezione inversa |
| finalized | Radicale | live (frozen se `write_freeze`) | — |

Regole valide in ogni modalità:
- `restore_guard_until` attivo, identità diversa o `rebuild_required` → policy frozen;
- il writer della policy, il riconciliatore al boot e l'auditor usano la stessa funzione `policyFromState()`, quindi nessuno può riscrivere `live` mentre lo stato dice altro.

### 13.2 Route
`/api/admin/calendar/migration/*`, protette da JWT. I job girano in background sotto `pg_advisory_lock('cal-migration')` e riprendono dopo un riavvio.
- `GET /state`
- `POST /preflight`, `POST /init` (solo volume vuoto e `mode=postgres`), `POST /inventory`, `POST /plan`
- `POST /apply`, `POST /verify`
- `POST /shadow {enabled}`, `GET /parity`
- `POST /cutover {confirm:'PASSA A RADICALE'}`
- `POST /rollback/preview`, `POST /rollback {confirm:'TORNA A POSTGRES'}`
- `POST /finalize {confirm}`
- `POST /identity/reassign {confirm}`, solo con spiegazione e diff
- `GET /runs/:id`, `GET /runs/:id/items`

### 13.3 Preflight e inizializzazione

**Controlli del preflight**
- **Radicale:**
  - raggiungibile;
  - versione via PROPFIND `RADICALE:version`;
  - login di servizio sulla rete interna.
- **Identità:**
  - principal assente → si propone "Inizializza Radicale";
  - principal presente con `volume-id` uguale a quello in PG → ok;
  - `volume-id` diverso o assente su un volume non vuoto → blocco con spiegazione (volume di un altro stack, della Fase 0 o ripristinato) e diff.
- **Gate:**
  - `caldes-probe` vede solo `read` sulle collezioni utente in shadow;
  - una PUT del probe su `_canary` risponde 403.
- **Volume:** canary e `statfs` superati, oppure remote mode accettata esplicitamente. Policy e heartbeat scrivibili.
- **Gate del servizio:**
  - il login di `caldes-svc` e `caldes-probe` sull'URL pubblico deve dare 401;
  - se dal container l'URL pubblico non è raggiungibile (hairpin), il wizard mostra il comando `curl` da lanciare sull'host e chiede una conferma esplicita.
- **App-password:**
  - attive con username riservato → blocco (revoca dall'admin);
  - username diversi da `federico` → solo informazione, perché vengono mappati.
- **Backup:** backup unico (§16.1) di meno di 24 ore, letto dal manifest.
- **Altro:** nessuna sync delle iscrizioni in corso; dichiarazione sul vecchio volume della Fase 0.

**"Inizializza Radicale"**, unico punto che crea collezioni:
1. MKCOL del principal;
2. PROPPATCH di `volume-id` (UUID generato e salvato in PG) ed `epoch=1`;
3. MKCALENDAR delle collezioni con gli slug esatti, compreso `f`, e con le dead prop `calendar-id` e `role`;
4. creazione di `_canary`.

### 13.4 Anteprima, anomalie e opzioni
**Conteggi per calendario:** singoli (timed e all-day), serie, override modificati, override cancellati che diventeranno EXDATE, exdates.

**Anomalie classificate**
- **Override:** `ORPHAN_OVERRIDE_NOT_IN_RULE`, `OVERRIDE_CALENDAR_MISMATCH`.
- **UNTIL e all-day:** `UNTIL_ADMIN_PATTERN`, `ALLDAY_UNTIL_DATETIME`, `ALLDAY_EXDATE_DATETIME`, `ALLDAY_AMBIGUOUS`.
- **Ricorrenze:** `INVALID_RRULE`, `UNTIL_BEFORE_DTSTART`, `RADICALE_RRULE_LIMIT`, `NON_ROME_SERIES`, `CANCELLED_MASTER`.
- **`DST_SHIFTED_EXCEPTION`:** EXDATE o RECURRENCE-ID con la stessa ora UTC del DTSTART ma un'ora locale di Roma diversa. È la firma del codice precedente a d046006, che ripeteva l'ora UTC: dopo quel fix l'eccezione non combacia più, l'occorrenza ricompare e l'override diventa orfano. Normalmente sono già a zero, grazie alla correzione in PG di F0.
- **Festività:** `DUPLICATE_HOLIDAY`.
- **Prenotazioni:**
  - `BOOKING_DRIFT`: confermate senza proiezione, proiezioni senza prenotazione, orari divergenti;
  - `NON_PROJECTION_IN_BOOKINGS`: eventi manual/admin/mcp nel calendario bookings.
- **Iscrizioni:**
  - `ICS_PULL_REFETCH`;
  - `SUBSCRIPTION_BLOCKING_IMPACT`: ore di busy e slot persi per settimana se si abilitasse "blocca".
- **App-password:** `NON_CANONICAL_APP_PASSWORD` (informativa).

Viene mostrata anche la stima della durata dell'apply.

**Opzioni**
- Correggi UNTIL "fino al": ON di default.
- Riallinea le eccezioni DST: ON di default.
- Orfani: convertiti in eventi singoli (default) oppure scartati.
- Master cancellati: non migrati.
- Eventi non-proiezione nel calendario bookings: "mantieni" (default, parità totale perché la provenienza resta manual/admin) oppure "sposta in lavoro".
- Iscrizioni: "blocca disponibilità" per singola iscrizione, OFF di default, con accanto l'impatto calcolato; "visibile sui device" per singola iscrizione, OFF di default.

### 13.5 Serializer
Dedicato, deterministico e versionato nel `legacy_hash`.
- Un oggetto per master con i suoi override.
- **Href:** riusa sempre quello già noto (ledger o `cal_object_ids`). `<uid>.ics` solo per gli oggetti mai visti.
- **Fusi:**
  - timed ricorrenti in `TZID=Europe/Rome`;
  - singoli con il TZID del calendario;
  - all-day come VALUE=DATE, con la data calcolata con +12 h.
- **Override:** quelli cancellati → EXDATE; quelli orfani → `<uid>-det-<epoch>.ics`.
- **RRULE invalide** → evento singolo con `X-CALDES-LEGACY-RRULE`. UNTIL < DTSTART → non migrata, e finisce nel report.
- **X-prop:** `X-CALDES-SOURCE`, `-SOURCE-ID`, `-LEGACY-ID`.
- **Prenotazioni:** proiezioni rigenerate da `calendar_bookings`, legate alla riga legacy della proiezione (id e `legacy_uid` in `cal_object_ids`). Le proiezioni per le prenotazioni annullate non si migrano: le righe legacy restano come sono.
- **Festività e chiusure:** href deterministici e UID legacy.
- **Iscrizioni:** non copiate. Si creano i sidecar, si azzerano etag e last_modified e si forza un pull nell'indice (§6.6).

### 13.6 Apply
Idempotente, ripetibile e ripreso dopo un crash.
- **Prima di ogni PUT** si scrive una riga d'intento (`intent_fingerprint` semantico, `intent_at`).
- **Al giro successivo**, un intento senza `written_etag` porta a un GET della destinazione:
  - se il fingerprint coincide con l'intento, l'item viene adottato come `noop`;
  - altrimenti diventa `conflict:UNTRACKED_TARGET`.

Stato della sorgente (`legacy_hash`) contro stato della destinazione (`written_etag`):
- assente e mai scritto → `create` (`If-None-Match: *`);
- hash ed etag uguali → `noop`;
- hash cambiato, etag uguale → `update` (`If-Match`);
- hash uguale, etag diverso → `conflict:TARGET_NEWER`;
- entrambi cambiati → `conflict:BOTH_CHANGED`;
- presente e non tracciato → `conflict:UNTRACKED_TARGET`;
- scritto e poi sparito → `conflict:DELETED_IN_TARGET`;
- `409 <C:no-uid-conflict/>` (l'UID vive a un altro href) → si legge l'oggetto a quell'href:
  - fingerprint uguale al piano → l'href viene adottato nel ledger;
  - altrimenti `conflict:UID_AT_OTHER_HREF`;
- fuori dal piano con etag uguale → `delete` (`If-Match`).

I conflitti non vengono mai sovrascritti, salvo "forza" esplicito sul singolo item. MKCALENDAR solo in `mode=postgres` e solo per le collezioni del piano, mai implicita in `radicale`.

Criterio di uscita: una seconda esecuzione consecutiva risulta al 100% `noop`.

### 13.7 Verifica per calendario
Semaforo per calendario e diff scaricabile.

| Livello | Cosa confronta |
|---|---|
| V1 strutturale | Ledger contro PROPFIND getetag |
| V2 contenuto | Multiget più fingerprint semantico contro il piano |
| V3 occorrenze | `listOccurrences` legacy (codice congelato) contro l'espansione di calendar-core, su [oggi − 365, oggi + 730] |
| V4 busy | Busy identico su [oggi, +180]. Si calcola senza le iscrizioni e, separatamente, con le iscrizioni abilitate |
| V5 feed | Insieme di (UID, istanze) |

V3 lavora a finestre di al massimo 60 giorni. Il legacy espande al massimo 500 occorrenze per master, e una serie lun-ven ne produce 782 sull'intervallo completo: senza finestre comparirebbero rossi falsi. Un test verifica la verifica stessa su quel caso.

Classificazione delle differenze:
- **attese (gialle, da accettare esplicitamente):** orfani convertiti, UNTIL e DST riallineati, override cancellati soppressi nel feed, UID degli override, prenotazioni rigenerate, `BOOKING_DRIFT`, iscrizioni risincronizzate;
- **inattese (rosse):** bloccano il cutover.

### 13.8 Shadow
- Ogni scrittura legacy accoda `shadow_mirror(master_id, source_version)`, agganciata in PgLegacyStore.
- **Oggetto assente in destinazione:** scrittura completa dal piano. È sicura perché i device sono in sola lettura.
- **Oggetto già presente (dopo un rollback, o adottato):** il mirror calcola il diff fra `legacy_snapshot` e la riga corrente, poi applica ops per campo con ical.js sull'oggetto Radicale corrente, con If-Match. Così VALARM, ATTENDEE e X-* restano.
- **Righe derivate dalla proiezione inversa** (`caldes_derived`) modificate in PG → `conflict:DERIVED_EDITED`.
- Le proiezioni delle prenotazioni vanno nello shadow solo dopo la decisione 3.
- **Cadenza:** ogni notte apply completo più V3-V5; ogni ora V4 sui prossimi 14 giorni.
- Prova reale sui device in sola lettura. Almeno 7 giorni di parità verde prima del cutover.

### 13.9 Transizioni: stato, gate e quiescenza
Ogni transizione che riduce i permessi dei device (cutover passo 2, rollback passo 2) segue questo schema:
1. **Prima lo stato.** In una tx si scrivono `mode` e `write_freeze`. La policy viene poi scritta da `policyFromState()`, e nessun riavvio o riconciliatore può riportarla a `live`.
2. **Gate di scrittura dell'API.** Lock esclusivo `pg_advisory_lock('cal-write')`: attende le scritture di RadicaleStore e dei job in corso e blocca le nuove.
3. **Quiescenza dei device:**
   - attesa di almeno 2 s, oltre l'intervallo di reload della policy;
   - la PUT del probe su `_canary` deve dare 403, con fino a 10 tentativi;
   - `stat` di tutte le collezioni ripetuto finché due letture consecutive a 1 s di distanza coincidono.
4. Solo a questo punto si scatta la fotografia (sync finale o apply delta).

Ogni passo è journalizzato: un crash fa ripartire dal passo successivo con lo stato già scritto.

### 13.10 Cutover
Notturno, come run journalizzato e ripreso dopo un crash.
1. Preflight; ultima verifica verde, o gialla accettata; backup unico di meno di 2 ore.
2. Transizione (§13.9): `mode='cutover'`, `write_freeze=true`, policy frozen e quiescenza. Le prenotazioni continuano sul busy legacy, che resta coerente perché PG è congelato e i device sono in sola lettura.
3. Apply delta e verifica V1, V2 e V4. Se c'è un rosso, si torna a `mode='postgres'` con policy shadow, senza aver toccato nulla.
4. PROPPATCH `epoch=E+1` sul principal. Poi, in una tx: `mode='radicale'`, `epoch=E+1`, `rollback_until = now() + 30 g`. Fra i due passi il mismatch d'epoch tiene i device chiusi. Il trigger 166 comincia a bloccare.
5. Policy live derivata dallo stato e heartbeat con il nuovo epoch: i device scrivono entro 1 s. Rilascio del gate.
6. Sync completo dell'indice, avvio della proiezione inversa, esecuzione dei job, fine del freeze.
7. **Smoke automatici**, senza effetti collaterali:
   - slots;
   - `createBooking` su un event type nascosto e su uno slot fuori dalle finestre pubbliche, dentro una tx sempre annullata (`db: tx`, quindi nessun effetto post-commit, nessun job, nessun workflow, nessuna email);
   - feed per token;
   - tool MCP in lettura.
   
   Se falliscono, si propone il rollback.

### 13.11 Proiezione inversa (finestra di rollback)
Una mappatura totale e testata dall'indice allo schema legacy, scritta con `SET LOCAL caldes.reverse_sync='on'`.
- **Rappresentabili:** master, override ed exdates, con gli id di `cal_object_ids` (`legacy_event_id` dove esiste).
- **La semantica si preserva per espansione.** RDATE, serie con TZID diverso da Europe/Rome, override orfani, RRULE che il legacy non espande come calendar-core e all-day con override timed diventano occorrenze espanse nell'orizzonte, come eventi singoli con `caldes_derived=true` e `caldes_object_id`. Il busy legacy dopo il rollback coincide con quello di Radicale: verificato con `rollback-test.mjs`, dove senza espansione il 15/10 (RDATE) mancava e il 27/10 slittava di un'ora.
- **Sanificazione** per i vincoli legacy:
  - `uid`: `legacy_uid` se esiste; altrimenti l'UID, se è libero; per gli override `<UID>#<recurrence_key>`; per i duplicati fra collezioni `<UID>@<collection_name>`;
  - `summary` vuoto → '(senza titolo)';
  - DTEND assente o uguale a DTSTART → +1 minuto (timed) o +1 giorno (all-day). Il CHECK legacy non si rilassa;
  - STATUS fuori dai tre valori → il più vicino.
- **Ogni degrado** finisce in `cal_migration_items` con una classe: `REPR_LOSS_VALARM`, `REPR_LOSS_ATTENDEE`, `SEMANTIC_EXPANDED`, `SANITIZED_UID`, `SANITIZED_DURATION`, `SANITIZED_SUMMARY`. Un upsert che fallisce comunque diventa `REVERSE_FAILED`, visibile nell'anteprima del rollback: mai un job failed silenzioso.
- **Proiezioni delle prenotazioni:**
  - aggiornano la riga legacy legata;
  - una prenotazione annullata nella finestra porta la riga legacy a `cancelled`;
  - le righe legacy superate da una riprogrammazione vengono annullate.
- Effetto utile: `tool_db_query` continua a vedere dati freschi.

### 13.12 Rollback
1. **Anteprima:** cambiamenti dal cutover, degradi per classe, righe derivate, `REVERSE_FAILED`.
2. **Transizione (§13.9):** in tx `mode='rollback'` e `write_freeze=true`, policy frozen derivata, gate esclusivo e quiescenza verificata. I device sono in sola lettura prima della fotografia finale.
3. **Fotografia:** sync finale dell'indice e ultimo passaggio della proiezione inversa. La parità al contrario è informativa e non blocca un rollback di emergenza.
4. **Ri-baseline del ledger** per ogni oggetto:
   - href reale da `cal_object_ids`;
   - `legacy_snapshot` e `legacy_hash` delle righe proiettate;
   - `written_etag` = etag corrente;
   - `adopted=true` e `derived` dove serve.
   
   Così un nuovo cutover risulta `noop` per tutto ciò che nessuno tocca, e gli oggetti dei device mantengono il proprio href.
5. **Ritorno a Postgres:** PROPPATCH `epoch+1`; tx con `mode='postgres'`, `epoch+1`, `write_freeze=false`; policy shadow.
6. **Archivio:** il volume Radicale resta intatto. Lo shadow mirror riparte in modalità patch (§13.8).

### 13.13 Finalize e wizard
**Finalize**
- Possibile dopo almeno 14 giorni (default della finestra: 30), con salute verde, nessun job failed e nessun `REVERSE_FAILED` aperto.
- Ferma la proiezione inversa e chiama `calendar_finalize_legacy()`.
- Il codice legacy si rimuove nella release successiva. La mappatura dei backup `calendar_events` → `calendar_events_legacy` esiste già da F4 (§16.2).

**Wizard**, in 6 passi:
1. Prerequisiti e inizializzazione
2. Anteprima e opzioni
3. Applica, con avanzamento live e possibilità di ripetere
4. Verifica, con semafori e drill-down
5. Shadow e prova sui device
6. Passaggio, con conferma digitata

Dopo il cutover mostra:
- i giorni residui della finestra;
- la salute della proiezione inversa e i degradi per classe;
- l'anteprima del rollback e "Torna a Postgres";
- "Chiudi finestra".

## 14. Bug esistenti: come vengono corretti

| Bug | Correzione |
|---|---|
| Feed: override cancellati che ricompaiono, UID degli override diversi | Override nella risorsa del master; cancellazioni come EXDATE |
| ETag CalDAV calcolato solo sul master | ETag nativo di Radicale per risorsa |
| All-day con EXDATE/RECURRENCE-ID in DATE-TIME | VALUE=DATE imposto da validatore e serializer; abbinamento tollerante al tipo |
| UNTIL di "fino al" esclude l'ultimo giorno | Fine giornata locale in admin; correzione dei dati in migrazione |
| Eccezioni salvate prima del fix DST (d046006), ora fuori griglia | Script di riallineamento in PG (F0) più anomalia `DST_SHIFTED_EXCEPTION` |
| Agenda device senza espansione e con giorno UTC | `store.listOccurrences` con finestra Roma, già in F2 |
| Override orfani | Δ su RECURRENCE-ID ed EXDATE; dryRun; orfani come eventi singoli in migrazione e come occorrenze autonome nell'indice |
| `getEvent` scambia un UID con forma di UUID per un id | Resolver in quattro passi |
| `expandRRule.between` perde gli eventi in corso | Query per sovrapposizione su `span` |
| `local-busy` fail-open | `busy.ts` fail-closed, circoscritto a oggetto o collezione |
| RRULE delle iscrizioni non validate | Quarantena dell'oggetto, mai un 503 globale |
| `parseIcs` rotto e trappola del 304 | `ics-split` con ical.js; reset di etag e last_modified |
| POST con `source` arbitraria | Whitelist |
| Riprogrammazione che legge fuori dalla transazione e resta bloccata dalla vecchia proiezione | `db: tx` più proiezioni fuori dal busy |
| `meetingUrl` null in riprogrammazione e approvazione | Ricalcolo sempre |
| UID dell'invito diverso da quello della proiezione | `<uid>@caldes.it` per entrambi (il feed conserva l'UID legacy per le migrate) |
| "Questa e le successive" non atomica, COUNT perso | Saga lato server |
| La copia di un'occorrenza finisce alla data del master | Copia alla data dell'occorrenza |
| FullCalendar nel fuso del browser | `timeZone` Europe/Rome |
| Festività riconosciuta per nome (anche nella capacity) | `role` |
| GET `/closures` crea il calendario | Rimosso |
| `caldes_auth` con firma sbagliata; healthcheck finto | Riscritti |
| Rate limit condiviso per IP del container | Rate limit per (IP del device, username) |
| Ogni username vede un proprio principal | Principal canonico e rights a policy |
| Lista vuota sugli errori del backend | Storage nativo |
| `find_free_slots` nel fuso del server, limite di 366 giorni | Release R+1 |
| Overlay troncati, agenda con tutto etichettato "booking" | Admin v2 |

## 15. Test e harness
- **Framework:** `node:test` con `tsx --test`; matrice CI `calendar-integration` su `CALENDAR_BACKEND=postgres|radicale`.
- **Radicale reale in CI:** immagine buildata dal commit, config e policy di test, dati in bind mount, mock di verify-credentials, Postgres effimero, rete compose con subnet fissa per i test del peer.
- **Immagine** (`build-radicale-image.yml`, pytest):
  - **auth:** svc e probe accettati solo dal peer interno e rifiutati dal gateway; username riservato dal gateway mai nel ramo device; ogni app-password → `federico`; cache di 60 s; cache persistita; backend giù senza cache → 500 senza delay; `credential_epoch` che svuota le cache;
  - **rights:** shadow, live e frozen; policy corrotta; heartbeat scaduto → frozen; marker assente o diverso → 403 e nessuna auto-creazione; readonly e hidden; nessun W su altri principal; DELETE della collezione negato;
  - **fedeltà:** round-trip;
  - **healthcheck:** 207 sulla root;
  - **contratto del layout:** mtime, `.Radicale.props`, cache.
- **Porting di `verify-calendar*.ts`:** tutti i casi diventano test parametrici sullo store.
- **Casi nuovi della revisione:**
  - **Backup:** import di un backup v1 precedente alla 162 in `mode=radicale` → dominio saltato, ruoli intatti, stato invariato; import in `mode=postgres` con shadow attivo → UPSERT di `calendars`, `calendar_sidecar_reconcile()`, ledger rivalidato; import dopo il finalize con `calendar_events` nel backup.
  - **Volume:** volume vuoto o di un altro stack → device 403, decisioni in 503, nessuna MKCOL; snapshot vecchio → mismatch d'epoch; cancellazione di massa → hold senza perdita di busy.
  - **Iscrizioni:** feed Google con DTSTAMP sempre nuovo → zero scritture; iscrizione non visibile → nessuna PUT su Radicale; flag "blocca" falso → nessun effetto su slot e capacity.
  - **Salute:** oggetto con RRULE invalida in una collezione bloccante → `/slots` 200, busy conservativo; serie MINUTELY da device → 200; DAILY dal 2010 → occorrenze presenti nella settimana corrente.
  - **Orfani:** override da device con RECURRENCE-ID fuori regola → occorrenza autonoma bloccante; target `recurrence_key` sparito → 409.
  - **Prenotazioni:** riprogrammazione 30 minuti più avanti, sovrapposta all'originale → accettata.
  - **Trigger:** delete di un calendario in `mode=radicale` → sidecar e righe legacy rimossi, nessuna eccezione.
  - **V3:** serie lun-ven con più di 500 occorrenze → nessun rosso.
  - **Campanello:** canary su un mount tmpfs con cache simulata, e `statfs` non locale → remote mode dichiarata.
  - **Job:** project_booking in corso e annullamento concorrente → proiezione rimossa.
  - **Rebuild:** decisioni durante il rebuild → sync forzata o 503, mai busy vuoto.
  - **All-day:** `TRANSP:OPAQUE` secondo la decisione 8.
  - **Feed:** ETag che cambia al cambio di data; STATUS:CANCELLED escluso; UID legacy delle proiezioni.
  - **GDPR:** dopo l'erasure, nessuna traccia dell'email in indice, versioni, collezione bookings, audit_logs, `calendar_events(_legacy)` e artefatti della migrazione.
  - **Heartbeat:** immagine API vecchia (heartbeat assente) → device frozen entro 10 minuti.
  - **Smoke:** nessuna riga, job o email residua.
  - **Prova generale F4:** casi A (UID dell'invito aggiunto da iPhone, durata zero, evento senza titolo, override con UID del master), B (secondo cutover con href scelto dal client e oggetti toccati da admin/MCP → noop) e C (prenotazione pre-cutover annullata nella finestra → riga legacy `cancelled`, nessuno slot bloccato dopo il rollback).
- **Snapshot di contratto:** sito (8 endpoint e codici), admin v1, tool MCP (nomi, schemi e output, compresi bookings e `f`), feed, agenda, capacity-week, cal-slots.
- **Fedeltà:** fixture di Apple, Google, Thunderbird, DAVx5 e Outlook.
- **Prestazioni:**
  - busy su 60 giorni sotto 20 ms;
  - `/slots` p95 sotto 200 ms con 5000 oggetti;
  - rebuild misurato;
  - pull di un'iscrizione da 5000 eventi invariata sotto 2 s, senza scritture.

## 16. Operatività

### 16.1 Backup
**Script unico** `scripts/backup-calendar-stack.sh`, sostituisce l'uso separato di `backup-db.sh`:
- ogni 6 ore, nello stesso run:
  - `pg_dump` completo;
  - tar del volume con `flock -s /data/collections/.Radicale.lock`, esclusa `.Radicale.cache`;
- un solo `manifest.json` con ora del dump, ora dello snapshot, sync-token, `volume_id` ed `epoch`;
- copia off-site S4 giornaliera, retention 30 giorni.

RPO di 6 ore sia per il DB sia per il volume. Il dump completo include sidecar, `cal_object_ids`, versioni, job e stato.

### 16.2 Backup JSON dell'admin (`/api/backup`)
Il formato v1 resta (è un contratto).

**Partizione delle tabelle**

| Gruppo | Tabelle | Export | Import |
|---|---|---|---|
| S: stato e derivati | `schema_migrations`, `calendar_backend_state`, `cal_migration_*`, `cal_jobs`, `cal_collection_state`, `cal_objects`, `cal_components`, `cal_occurrences`, `cal_booking_conflicts`, `cal_object_ids`, `cal_object_versions` | sì | mai, in nessuna modalità (saltate e riportate nel report) |
| D: dominio iCalendar | `calendars`, `calendar_events` (o `_legacy`), `calendar_subscriptions` | sì | solo in `mode=postgres`; altrimenti saltate, con l'avviso "usa il ripristino coordinato o il ripristino da versioni" |
| B: business | prenotazioni, event types, disponibilità, app-password, reminders | sì | come oggi |

Precisazioni dell'implementazione (F1, `apps/api/src/routes/backup.ts`):
- S è un elenco esplicito più il prefisso `cal_migration_`, non una regola `cal_*`: `cal_bookings`, `cal_sync_log` e `cal_webhook_logs` (Cal.com, migrazione 023) sono business. Le migrazioni 163-165 devono usare esattamente questi nomi.
- `schema_migrations` sta in S: il ripristino non cambia lo schema, quindi il ledger delle migrazioni non torna mai indietro (da un backup precedente alla 162 toglierebbe la riga della 162).
- Le tabelle B si svuotano senza CASCADE, su un insieme chiuso rispetto alle FK: se una tabella protetta (S, `calendars`, D fuori da `mode=postgres`) referenzia una tabella da svuotare, l'import risponde 409 prima di toccare i dati.

**Regole dell'import di D in `mode=postgres`**
- `calendars` in UPSERT per id sulle sole colonne presenti nel backup. Niente TRUNCATE: il CASCADE svuoterebbe indice e id. Le colonne del sidecar restano; le righe assenti dal backup vanno in `needs_review` (`missing_in_backup`) e non vengono cancellate. Se una riga mantenuta occupa uno slug, un token del feed, un `collection_name` o il default che servono a una riga del backup, li cede (slug → `<slug>-<prime 8 cifre dell'id>`, token rigenerato, `collection_name` riassegnato dalla riconciliazione): è il caso del ripristino su un database nuovo, con gli stessi slug e id diversi.
- Dopo il caricamento si verificano le FK che toccano le tabelle D ripristinate: una riga orfana annulla l'import.
- `calendar_events` e `calendar_subscriptions`: TRUNCATE senza CASCADE. L'insieme è chiuso rispetto alle FK, perché le tabelle nuove non hanno FK verso `calendar_events`.

**Dopo ogni import**
- `calendar_sidecar_reconcile()`;
- `rebuild_required=true`;
- `restore_guard_until = now() + 48 h`: nessuna cancellazione automatica e policy frozen finché la verifica post-ripristino (riconciliazione, rebuild, auditor) non è verde;
- con lo shadow attivo, ledger rivalidato con un plan dry-run: le differenze diventano conflitti, mai sovrascritture;
- un ripristino di `calendar_bookings` avvia la riconciliazione delle proiezioni in sola lettura.

**Trigger e tabella legacy**
- `session_replication_role=replica` disattiva il trigger 166: per questo l'esclusione di D sta nel codice di `backup.ts`, non nel trigger.
- Da F4, `calendar_events` nel backup viene mappata su `calendar_events_legacy` quando `calendar_events` è una vista, così i backup storici restano importabili dopo il finalize.

**Export in `mode≠postgres`**
- La UI avverte che gli eventi stanno nel volume Radicale.
- Da F4 offre l'export v2: zip con un .ics per collezione più manifest.

### 16.3 Restore coordinato e recupero
**Scenario A: volume perso o corrotto, DB intatto**
1. Fermare radicale e ripristinare lo snapshot.
2. All'avvio l'identità coincide ma l'indice è più recente: il full resync incontra l'interruttore anti-cancellazione e mette le collezioni in hold.
3. "Ricostruisci Radicale dall'indice" rigioca le versioni più recenti dello snapshot (diff per href, If-Match, anteprima).
4. Si riaprono i device.

**Scenario B: DB perso**
1. Ripristinare dump e snapshot dello stesso manifest.
2. Rebuild.
3. Riconciliazione delle proiezioni in sola lettura: le proiezioni senza prenotazione producono l'elenco "prenotazioni da recuperare", con nome, orario e contatti, da reimportare o archiviare su conferma. Nelle 48 ore successive nessuna cancellazione automatica.
4. Policy frozen fino alla conferma dal wizard.

**In entrambi gli scenari:** la policy viene riscritta dallo stato in PG, e un mismatch d'identità o d'epoch blocca finché il wizard non conferma "riassegna identità", con diff. Drill trimestrale.

### 16.4 GDPR
**`calendarErase(email)`**
- proiezioni rimosse o riscritte;
- purge di versioni e `raw_ics` nell'indice;
- `calendar_events` e `calendar_events_legacy` ripulite con il GUC `caldes.reverse_sync`;
- redazione di `old_data`/`new_data` in `audit_logs` per `calendar_events` e `calendar_bookings`, perché il trigger 118 salva `to_jsonb` della riga, DESCRIPTION compresa;
- pulizia di `cal_migration_items` e dei piani zip;
- cache item di Radicale ripulita via script host.

**Retention**
- versioni: 90 giorni;
- backup: 30 giorni;
- proiezioni concluse: ridotte dopo N mesi (decisione 3);
- piani di migrazione: cancellati dopo 30 giorni;
- `calendar_events_legacy`: eliminata 12 mesi dopo il finalize.

**ATTENDEE e ORGANIZER** nella proiezione solo con l'opzione "Tutti". Il ROPA va aggiornato.

### 16.5 Monitoraggio
`/api/health/calendar`, con alert su Telegram/Bugsink:
- Radicale raggiungibile e versione; watcher, canary e `statfs`; identità ed epoch; heartbeat;
- lag per collezione; collezioni `unsyncable` e `hold`; oggetti in quarantena e orfani; orizzonte;
- backlog e fallimenti dei job; conflitti di prenotazione; proiezioni orfane;
- richieste device senza `X-Remote-Addr`; coerenza fra policy e stato;
- dimensione del volume; item per collezione oltre 5000.

### 16.6 Deploy e rollback d'immagine
- `calendar_backend_state.api_min_version` viene verificata all'avvio: un'API più vecchia della release F2 non conosce lo stato e non va avviata dopo il cutover.
- Se succede comunque (rollback su Dockhand, revert ricompilato come `latest`):
  - il vecchio codice non scrive l'heartbeat;
  - entro 10 minuti i rights portano i device in frozen;
  - le scritture legacy falliscono sul trigger 166, quindi non si crea uno split-brain silenzioso.
- Runbook: dopo il cutover niente rollback d'immagine sotto la release F2. Si usa il rollback del wizard; tag dell'API pinnato durante la finestra.

## 17. Stima
Per uno sviluppatore senior, in giorni-persona.

| Fase | Giorni |
|---|---|
| F0 | 5-7 |
| F1 | 6-8 |
| F2 | 17-22 |
| F3 | 10-13 |
| F4 | 9-12 |
| F5 | 2, più 30 giorni di presidio |
| F6 | 12-16 |
| F7 | 3-5 |

Totale: circa 64-85 giorni-persona, cioè 13-17 settimane per una persona sola. Con F6 affidata a una seconda persona in parallelo da F2, il calendario scende a circa 10-12 settimane.

La revisione red-team aggiunge circa 11-13 giorni, concentrati in F1 (identità, heartbeat, peer, cache persistita), F2 (salute per oggetto, iscrizioni solo-indice, rebuild, interruttore) e F4 (proiettore inverso totale, ri-baseline, gate, `backup.ts`).

Le voci più incerte sono l'inventario di produzione, la matrice dei device e la UX dei conflitti.
