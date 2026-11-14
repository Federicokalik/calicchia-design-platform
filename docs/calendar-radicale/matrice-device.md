# Matrice device (F3)

Prova sui device veri prevista dal [piano](piano.md) (F3, attività 6) e dal [contratto dei moduli della F3](contracts/f3-modules.md) §14.2: iPhone/iPad (iOS), Mac (macOS Calendario), Android con DAVx5 e Thunderbird, contro Radicale 3.7.8 con il config e i plugin del repository. L'esito, insieme a due decisioni ancora aperte, va dichiarato nel wizard (passo 5, dichiarazione `device_matrix`) ed è un criterio di uscita della F3 e del cutover.

Le due decisioni aperte, con la raccomandazione, sono in [decisioni.md](decisioni.md#da-confermare-dallutente-matrice-device-f3):

- `strict_preconditions` di Radicale (`[storage]` di `apps/radicale/config/config`): oggi `False`, proposta `True`;
- regola TRANSP degli all-day creati dai device (decisione 6): `opaque_blocks` (blocca solo "Mostra come: occupato") oppure `never_block`.

## 1. Perimetro e regole

- **Solo in staging.** In F3 Postgres resta autorevole e in produzione i device restano in sola lettura (policy `shadow`). Le prove di scrittura richiedono una policy `live` temporanea, che in F3 si ottiene solo sullo stack di prova, come nell'end-to-end della F1 (`integration/radicale-f1-e2e.test.ts`). Mai in produzione.
- **Dati di forma produttiva.** Lo stack di prova parte da una copia della produzione (calendari `c`, `f`, `lavoro`, `personale`, `bookings`, `scadenze`; serie lun-mar-gio-ven delle 09:00; 91 festività più "Ferie"; una proiezione di prenotazione) migrata con il wizard: inizializzazione, anteprima, applica, verifica.
- **Gli stessi percorsi della produzione.** Principal `federico`, collezioni con lo slug esatto (`/federico/c/`, `/federico/f/`, ...), app-password come in produzione, anche con username diversi da `federico` (per esempio `iphone`).
- **Nessuna notifica.** Lo stack di prova gira senza chiavi di invio (Resend/SMTP, Telegram, WhatsApp): le prenotazioni di prova non devono avvisare nessuno.
- **Gli esiti automatici prima.** `apps/api/test/integration/device-emulation.test.ts` riproduce lato server il traffico tipico di questi client (sezione 7). Se un caso automatico fallisce, la prova sui device non ha senso finché non è corretto. Un esito diverso sul device, con il test verde, dipende dal client.

## 2. Preparazione dello stack di prova

1. **Stack.** Un secondo progetto Compose (per esempio `caldes-staging`) con la stessa immagine dell'API e di Radicale della produzione, volumi propri (`caldes-staging_radicale_collections`, `caldes-staging_caldes_control`, `caldes-staging_radicale_authcache`), database proprio e reti con subnet diverse da quelle della produzione.
2. **HTTPS per i device.** Un vhost CloudPanel di prova (per esempio `dav-staging.calicchia.design` verso `127.0.0.1:3012`) con le stesse direttive del vhost di produzione ([apps/radicale/README.md](../../apps/radicale/README.md), "CloudPanel"): `X-Remote-Addr`, `client_max_body_size 20m`, timeout. iOS e macOS vanno provati come in produzione: HTTPS con un certificato valido.
3. **Config di Radicale per la prova.** In produzione il config sta nell'immagine e cambia solo con un tag nuovo. Per lo stack di prova si costruisce un'immagine locale da un branch con queste sole modifiche ad `apps/radicale/config/config` (mai pubblicata, mai nel compose di produzione):

   ```ini
   [storage]
   strict_preconditions = True
   [logging]
   level = debug
   request_header_on_debug = True
   ```

   ```sh
   docker build -t calicchia-radicale:matrice apps/radicale
   ```

   Con `level = debug` e `request_header_on_debug = True` il log di Radicale riporta gli header di ogni richiesta (`If-Match`, `If-None-Match`, `User-Agent`; l'`Authorization` è oscurata). I log di debug contengono dati personali: solo sullo stack di prova, e da cancellare alla fine.
4. **Copia della produzione.** Si carica nel database dello stack di prova il dump dell'ultimo backup coordinato, come nel drill di [apps/radicale/README.md](../../apps/radicale/README.md) ("Drill"), con `DB_NAME` e `PG_CONTAINER` dello stack di prova. Poi, **solo sul database dello stack di prova**, stato a volume non inizializzato (il volume di prova è vuoto) e nessuna traccia della migrazione della produzione (ledger, run, shadow e dichiarazioni si riferiscono al volume di produzione):

   ```sql
   UPDATE calendar_backend_state
   SET volume_id = NULL, epoch = 0, restore_guard_until = NULL, rebuild_required = false,
       shadow_enabled = false, shadow_since = NULL, last_stack_backup = NULL, migration_declarations = '{}'::jsonb
   WHERE id;
   DELETE FROM cal_migration_ledger;
   DELETE FROM cal_migration_runs;
   ```

5. **Migrazione con il wizard** (`https://<admin di prova>/calendario/migrazione`): passo 1 (prerequisiti e inizializzazione), passo 2 (anteprima), passo 3 (applica), passo 4 (verifica verde o gialli accettati). Si accende lo shadow (passo 5) per avere le modifiche dell'admin propagate.
6. **App-password.** Una per device, create in admin (Impostazioni → CalDAV) con username diversi: `iphone`, `mac` (oppure `federico`), `android`, `thunderbird`. Si annotano le password: servono anche dopo la revoca di prova (M15).
7. **Policy live temporanea**, solo per i casi marcati "live", dopo i casi in shadow:

   ```sh
   docker compose -p caldes-staging exec -T postgres psql -U caldes -d caldes -c "UPDATE calendar_backend_state SET mode = 'radicale' WHERE id"
   docker compose -p caldes-staging exec api cat /run/caldes-control/policy.json   # "mode": "live"
   ```

   È una scorciatoia di prova, non il cutover della F4 (che ha il suo run, il gate delle scritture e la quiescenza). Alla fine si torna a `postgres` (sezione 6).

Comandi utili durante la prova:

```sh
# Richieste di un client, con gli header (User-Agent del device)
docker compose -p caldes-staging logs radicale --since 10m | grep -E 'request for|If-Match|If-None-Match'
# PUT senza If-Match rifiutate da strict_preconditions
docker compose -p caldes-staging logs radicale | grep 'no If-Match header, strict mode enabled'
# Conflitti di ETag
docker compose -p caldes-staging logs radicale | grep 'Precondition failed'
# Oggetto come l'ha scritto il device (TRANSP, X-prop, VALARM), dal volume di prova
docker compose -p caldes-staging exec radicale sh -c 'cat /data/collections/collection-root/federico/lavoro/<item>.ics'
```

## 3. Collegare i device

Server di prova: `dav-staging.calicchia.design` (in produzione `dav.calicchia.design`).

| Device | Procedura |
|---|---|
| iOS (iPhone, iPad) | Impostazioni → Calendario → Account → Aggiungi account → Altro → Aggiungi account CalDAV. Server `dav-staging.calicchia.design`, Nome utente `iphone`, Password = app-password, Descrizione "Caldes prova". Dopo il salvataggio: Avanzate → "Usa SSL" attivo, porta 443 |
| macOS (Calendario) | Calendario → Impostazioni → Account → + → Altro account CalDAV → Tipo di account "Manuale". Nome utente `mac`, password, indirizzo server `https://dav-staging.calicchia.design/` |
| Android (DAVx5) | DAVx5 → + → "Accedi con URL e nome utente". URL `https://dav-staging.calicchia.design`, utente `android`, password; poi spuntare tutti i calendari nella scheda CalDAV dell'account. Si guardano con l'app Calendario di Android (Google Calendar o quella del produttore): annotare quale |
| Thunderbird | Calendario → Nuovo calendario → Sulla rete → Nome utente `thunderbird`, Posizione `https://dav-staging.calicchia.design/federico/lavoro/` (una collezione per volta: ripetere per `c`, `f`, `bookings`) → "Trova calendari". In alternativa Posizione `https://dav-staging.calicchia.design/` per la scoperta automatica |

## 4. Casi di prova

Ogni caso indica la modalità (shadow o live), i passi e il risultato atteso lato server, che `device-emulation.test.ts` verifica già in automatico dove indicato. Sul device si annota il comportamento reale nella tabella della sezione 5. "Nessuna richiesta di password" vuol dire che il client non apre la finestra delle credenziali e l'account resta utilizzabile senza reinserirle.

### M01. Login e scoperta (shadow)

1. Aggiungere l'account con l'app-password (username diverso da `federico` dove possibile).
2. Attendere la prima sincronizzazione.

Atteso: login riuscito con qualsiasi username dell'app-password, principal `/federico/` (`current-user-principal`), home `/federico/`, nessun 401. Automatico: "discovery di ogni client".

### M02. Elenco dei calendari e collezioni nascoste (shadow)

Atteso: compaiono `c`, `f` (Festività e chiusure), `lavoro`, `personale`, `bookings`, `scadenze` con i nomi dell'admin; `_canary` non compare mai. In shadow tutti in sola lettura (`current-user-privilege-set` = `read`): iOS e macOS mostrano il lucchetto o non offrono la modifica, Thunderbird segna il calendario in sola lettura, DAVx5 lo sincronizza come "sola lettura". Automatico: "discovery di ogni client".

### M03. Sola lettura in shadow: 403 senza invalidare la password (shadow)

1. Provare a creare un evento in `lavoro`, a modificarne uno di `c`, a cancellarne uno.
2. Provare a creare un calendario dal device.

Atteso lato server: ogni scrittura risponde 403, senza header `WWW-Authenticate`; la richiesta successiva con la stessa password risponde 207. Sul device: errore o rifiuto della modifica (iOS può mostrare "Impossibile salvare l'evento" o ripristinare l'evento al successivo aggiornamento), **nessuna richiesta di password**, l'account continua a sincronizzare. Automatico: "shadow: ogni scrittura dei device → 403".

### M04. Backend di autenticazione giù: 500, mai 401 (shadow)

1. Con i device già sincronizzati, fermare l'API dello stack di prova per 2-3 minuti: `docker compose -p caldes-staging stop api`.
2. Forzare un aggiornamento su ogni device (iOS: trascinare in basso nell'elenco dei calendari; macOS: Vista → Aggiorna calendari; DAVx5: "Sincronizza ora"; Thunderbird: Sincronizza).
3. Aggiungere un account nuovo da un device mai collegato (per esempio un iPad).
4. Riavviare l'API: `docker compose -p caldes-staging start api`.

Atteso lato server: i device già visti continuano a leggere (credenziale nella cache persistita di `caldes_auth`, stale-if-error fino a 24 h); il device nuovo riceve 500 subito, senza `WWW-Authenticate` e senza il ritardo del login fallito. Sul device: per i già collegati nessun effetto; per il nuovo un errore di connessione temporaneo, **nessuna password scartata** né richiesta di reinserimento; dopo il riavvio dell'API il login riesce con la stessa password. Automatico: "backend di autenticazione giù".

### M05. Sincronizzazione incrementale e cambio dell'ora (shadow)

1. In admin modificare un evento di `c`, crearne uno e cancellarne uno (lo shadow li porta su Radicale).
2. Aggiornare i device.
3. Controllare la serie "Gestione Creattivamente" a cavallo del 25 ottobre (ultima domenica di ottobre).

Atteso: i device vedono esattamente le tre modifiche (sync-collection o ctag), senza riscaricare tutto; la serie resta alle 09:00 ora di Roma anche dopo il cambio dell'ora. Automatico: "sincronizzazione" e "fusi orari: calendar-query con expand".

### M06. Quali precondizioni manda ogni client (live)

1. Creare un evento in `lavoro`, modificarlo (titolo, orario), spostarlo con il trascinamento, cancellarlo.
2. Dal log di debug di Radicale annotare, per ogni operazione, `If-None-Match` (creazione) e `If-Match` (modifica, cancellazione).

Atteso: tutti i client mandano `If-Match` con l'ETag corrente su modifica e cancellazione; con `strict_preconditions = True` nessun `Precondition failed ... no If-Match header` nel log durante l'uso normale. Automatico: "If-Match con strict_preconditions = True" (dal lato server: ETag corrente 204, ETag vecchio 412, PUT senza If-Match su un oggetto esistente 412).

### M07. Conflitto fra due device (live)

1. Mettere due device offline (modalità aereo), modificare lo stesso evento su entrambi.
2. Riconnettere prima il primo, poi il secondo.

Atteso lato server: la seconda PUT, con l'ETag ormai vecchio, riceve 412 (nessuna sovrascrittura cieca). Sul device da annotare: rilegge e mostra la versione del server, chiede quale tenere, o perde la propria modifica in silenzio. Nessun client deve entrare in un ciclo di errori.

### M08. Uso normale con `strict_preconditions = True` (live)

Sequenza su ogni device: creare un evento singolo, una serie settimanale, modificare "solo questo evento" e "questo e tutti i futuri", cancellare un'occorrenza, spostare un evento fra `lavoro` e `personale`, aggiungere e togliere un allarme, rispondere a un invito se il client lo offre.

Atteso: nessun errore inatteso, nessun 412 nel log fuori da M07. Un client che fa PUT senza `If-Match` su un oggetto esistente compare nel log ("no If-Match header, strict mode enabled") e decide la raccomandazione su `strict_preconditions` (decisioni.md).

### M09. X-prop, VALARM e campi ricchi in andata e ritorno (live)

1. In admin (o con la migrazione) un evento con allarme, luogo e le X-prop dell'applicazione (`X-CALDES-*`).
2. Sul device cambiare solo il titolo.
3. Viceversa: sul device un evento con allarme, posizione strutturata (iOS e macOS) o videochiamata, testo con virgole ("Pranzo, poi riunione"), invitati.

Atteso lato server: Radicale conserva tutto ciò che riceve (patch di vobject: virgole, `geo:`, CONFERENCE, X-prop, VALARM). Da annotare sul device: quali proprietà il client stesso toglie quando riscrive l'evento (le `X-CALDES-*` possono sparire: l'effetto si limita ai badge e ai bucket della capacity, rischi.md). Automatico: "andata e ritorno" e "sincronizzazione" (X-prop della migrazione).

### M10. Collezioni protette anche in live (live)

1. Provare a modificare o cancellare una festività in `f`, la proiezione in `bookings`, un evento di `scadenze`.
2. Provare a modificare un evento manuale (non di prenotazione) nel calendario `bookings`.
3. Provare a rinominare o cancellare un calendario.

Atteso lato server: 403 su tutto, senza `WWW-Authenticate`; gli eventi restano leggibili. Decisione 8: gli eventi non di prenotazione restano in `bookings`, in sola lettura sui device e modificabili da admin e MCP. Sul device: lucchetto o errore, **nessuna richiesta di password**. Automatico: "collezioni protette anche in live".

### M11. Calendario creato dal telefono, badge della decisione 4 (live)

1. Da iOS, macOS o DAVx5 creare un calendario "Palestra" e un evento al suo interno (Thunderbird non crea calendari remoti).
2. In admin, sezione Calendari: dopo la discovery (entro qualche secondo) il calendario compare con il badge "nuovo dal dispositivo".
3. Verificare che blocchi gli slot: un evento nell'orario di una disponibilità pubblica la toglie da `/slots`.

Atteso: MKCALENDAR 201 con il nome scelto dal client (iOS usa un UUID come nome della collezione), riga del sidecar con `origin = device`, `blocks_availability = true`, `needs_review` con motivo `device_new`, feed disattivato; il ruolo non si prende mai da dead prop scritte dal device. Automatico: "MKCALENDAR dal telefono ... badge" (con la discovery dell'API in mode radicale).

### M12. TRANSP degli all-day (decisione 6) (live)

1. Sul device creare tre all-day: "Mostra come: occupato" (iOS/macOS: Mostra come → Occupato; Android: Disponibilità → Occupato; Thunderbird: Mostra come → Occupato), "libero", e uno lasciando il valore predefinito.
2. Leggere dal volume come li ha scritti il client (`TRANSP:OPAQUE`, `TRANSP:TRANSPARENT` o nessun `TRANSP`).
3. Modificare dal device il titolo di un all-day migrato (per esempio "Ferie" in `f` non si può: usarne uno in `lavoro`) e controllare se il client aggiunge `TRANSP`.
4. Con `CAL_ALLDAY_OPAQUE_BLOCKS=on` nell'API di prova, verificare gli slot nei tre giorni.

Atteso lato server: Radicale conserva il `TRANSP` scritto dal client; con la regola `opaque_blocks` blocca solo l'all-day con `TRANSP:OPAQUE` esplicito, con `never_block` nessuno; gli all-day migrati (senza `TRANSP`) non bloccano mai, compresi quelli non di prenotazione rimasti nel calendario `bookings` per la decisione 8 (in sola lettura sui device, quindi il loro `TRANSP` lo cambia solo l'admin). Il piano cita questo caso come "TRANSP degli all-day (per la decisione 8)": la regola del TRANSP è la decisione 6 di [decisioni.md](decisioni.md), la 8 riguarda gli eventi non di prenotazione in `bookings` (M10). Da annotare: il `TRANSP` predefinito di ogni client per gli all-day e se una modifica di un all-day migrato aggiunge `TRANSP:OPAQUE` (lo renderebbe bloccante senza che l'utente lo abbia scelto). Automatico: "TRANSP degli all-day creati dal device".

### M13. Fusi orari dai device (live)

1. Sul device creare un evento con un fuso diverso (iOS/macOS: "Fuso orario" attivo in Impostazioni → Calendario; per esempio Londra 10:00).
2. Creare una serie settimanale che attraversa il cambio dell'ora.
3. Da Outlook, se disponibile, un invito con TZID in stile Windows ("W. Europe Standard Time").

Atteso: orari corretti in admin e sugli altri device; nessuno spostamento di un'ora dopo il cambio dell'ora. Automatico: "fusi orari dai device: TZID in stile Outlook".

### M14. Revoca di un'app-password (shadow o live)

1. In admin revocare l'app-password di un device.
2. Aggiornare quel device e un altro.

Atteso: il device revocato riceve 401 con `WWW-Authenticate` e chiede la password (è l'unico caso in cui deve chiederla); gli altri continuano. Il caso è già nell'end-to-end della F1 (`credential_epoch`).

### M15. API ferma oltre 10 minuti in live (live)

1. Fermare l'API per 11 minuti.
2. Provare una modifica e una lettura dal device.

Atteso: l'heartbeat scade, i rights passano a `frozen`: scritture 403, letture 200, **nessuna richiesta di password**; dopo il riavvio dell'API le scritture tornano possibili. È nell'end-to-end della F1 (heartbeat scaduto).

## 5. Tabella degli esiti da compilare

Valori: `OK` (come atteso), `KO` (diverso: descrivere in Note), `n.a.` (il client non offre l'operazione). Versioni esatte nella prima riga.

| Caso | iOS | macOS | DAVx5 | Thunderbird | Note |
|---|---|---|---|---|---|
| Versione del client e del sistema | | | | | |
| M01 login e scoperta | | | | | |
| M02 elenco, `_canary` assente, sola lettura visibile | | | | | |
| M03 403 in shadow senza richiesta di password | | | | | |
| M04 backend giù: già collegato legge, nuovo 500 senza password scartata | | | | | |
| M05 sincronizzazione incrementale e cambio dell'ora | | | | | |
| M06 If-Match su modifica e cancellazione | | | | | |
| M07 comportamento su 412 (conflitto) | | | | | |
| M08 uso normale con `strict_preconditions = True` | | | | | |
| M09 X-prop e VALARM conservati (e cosa toglie il client) | | | | | |
| M10 collezioni protette in live, nessuna richiesta di password | | | | | |
| M11 calendario dal device con badge e bloccante | | | n.a. | n.a. | |
| M12 TRANSP degli all-day | | | | | |
| M13 fusi orari | | | | | |
| M14 revoca: 401 e richiesta di password | | | | | |
| M15 API ferma: frozen senza richiesta di password | | | | | |

Precondizioni e TRANSP osservati nel log e sul volume:

| Client | If-None-Match su creazione | If-Match su modifica | If-Match su cancellazione | PUT senza If-Match su oggetti esistenti | Reazione al 412 | TRANSP predefinito degli all-day | Modifica di un all-day migrato aggiunge TRANSP |
|---|---|---|---|---|---|---|---|
| iOS | | | | | | | |
| macOS | | | | | | | |
| DAVx5 (e app del calendario) | | | | | | | |
| Thunderbird | | | | | | | |

## 6. Esito, dichiarazione e pulizia

**Superata** se: nessun `KO` su M01-M05, M10, M14, M15 (sicurezza e disponibilità); M03, M04, M10 e M15 senza alcuna richiesta di password; nessun ciclo di errori su M07 e M08. Gli altri `KO` si documentano nelle note e decidono le due scelte aperte.

Dichiarazione nel wizard (passo 5 "Shadow e prova sui device", pulsante "Registra matrice device"), equivalente a `POST /api/admin/calendar/migration/declarations`:

```json
{
  "key": "device_matrix",
  "value": {
    "result": "passed",
    "strict_preconditions": true,
    "allday_transp_rule": "opaque_blocks",
    "devices": ["ios", "macos", "davx5", "thunderbird"],
    "notes": "iOS 18.0, macOS 15.0, DAVx5 4.4.3, Thunderbird 128.3: If-Match sempre su modifica e cancellazione; all-day predefiniti TRANSPARENT."
  }
}
```

Applicazione delle scelte (dopo la dichiarazione, mai durante la F3 in produzione):

- `strict_preconditions = true`: modifica di `apps/radicale/config/config` (`strict_preconditions = True`) con il deploy in due commit di [apps/radicale/README.md](../../apps/radicale/README.md) (immagine nuova, poi tag nel compose).
- `allday_transp_rule = opaque_blocks`: `CAL_ALLDAY_OPAQUE_BLOCKS=on` nell'ambiente dell'API, nella release successiva alla verifica (decisione 6); poi rebuild dell'indice, perché il valore di `blocks` delle occorrenze già indicizzate cambia solo alla reindicizzazione. Con `never_block` non si cambia nulla.

Pulizia dello stack di prova:

```sh
docker compose -p caldes-staging exec -T postgres psql -U caldes -d caldes -c "UPDATE calendar_backend_state SET mode = 'postgres' WHERE id"
docker compose -p caldes-staging down          # poi rimuovere i volumi di prova e l'immagine calicchia-radicale:matrice
```

Revocare le app-password di prova (o tutte quelle copiate dalla produzione, se lo stack resta), rimuovere i log di debug e gli account "Caldes prova" dai device.

## 7. Copertura automatica (`device-emulation.test.ts`)

`apps/api/test/integration/device-emulation.test.ts` gira con Radicale 3.7.8 reale (`RADICALE_BIN`), il config di produzione con i soli percorsi sostituiti e `strict_preconditions = True`, i plugin del repository (`caldes_auth`, `caldes_rights`, `caldes_vobject_fix`), policy e heartbeat scritti dal control-plane dell'API dallo stato in Postgres, il volume inizializzato da `initializeVolume()` e verify-credentials simulato per i guasti. Ogni client è emulato con il proprio User-Agent, l'IP in `X-Remote-Addr` dal gateway della porta pubblicata e le richieste tipiche (PROPFIND con le proprietà di iOS e macOS, di DAVx5, di Thunderbird sulla collezione).

| Test automatico | Casi della matrice |
|---|---|
| il config è quello di produzione con `strict_preconditions = True` | premessa di M06-M08 |
| policy shadow dal control-plane (`readonly` bookings, f, scadenze; `hidden` _canary) | M02, M10 |
| discovery di ogni client (`/.well-known/caldav` → `/`, principal canonico, home, elenco, privilegi) | M01, M02 |
| sincronizzazione (sync-collection iniziale e incrementale, multiget, ctag, X-prop) | M05, M09 |
| fusi orari: expand attraverso il cambio dell'ora | M05, M13 |
| shadow: 403 senza `WWW-Authenticate`, password valida anche con il backend giù | M03 |
| backend di autenticazione giù: 500 subito e senza challenge, cache accettata, 401 solo per la password sbagliata | M04, M14 |
| privilegi in live | M02, M10 |
| If-Match con `strict_preconditions = True` (per ogni client: 201, 412 sulla creazione ripetuta, 204, 412 con l'ETag vecchio, 412 senza If-Match, rilettura e nuovo tentativo, DELETE con l'ETag vecchio 412) | M06, M07, M08 |
| collezioni protette anche in live (PUT, DELETE, PROPPATCH, DELETE della collezione) | M10 |
| MKCALENDAR dal telefono (corpo di iOS) e discovery dell'API: origin device, bloccante, `device_new` | M11 |
| andata e ritorno di X-prop, VALARM, ATTENDEE, CONFERENCE e testi con virgole | M09 |
| TRANSP degli all-day con le regole `never_block` e `opaque_blocks` (regola `computeBlocks` dell'indicizzatore) | M12 |
| fusi orari dai device (TZID in stile Outlook) | M13 |
| confronto `strict_preconditions` True/False per un client senza If-Match | decisione su `strict_preconditions` |

Restano solo per i device veri: cosa manda davvero ogni client (header, `TRANSP` predefinito, proprietà che il client toglie riscrivendo), come reagisce a 403, 412 e 500 (messaggi, cicli, richiesta di password) e la resa nell'interfaccia (lucchetto, badge in admin, orari).
