# Decisioni dell'utente

Prese il 2026-10-09. Valgono per tutte le fasi del [piano](piano.md); i riferimenti di sezione sono al [design](design.md).

| # | Tema | Scelta | Note |
|---|---|---|---|
| 0 | Portata | **Design completo e robusto** (F0–F7) | Scelto al posto della variante snella. |
| 1 | Prenotazioni con calendario non verificabile | **Fail-closed + interruttore "modalità degradata"** di durata massima 2 ore | Interruttore spento di default. Ogni prenotazione presa in modalità degradata viene registrata e genera un alert. Un singolo oggetto rotto non porta mai `/slots` in 503 (§6.5). |
| 2 | Prenotazioni da admin/MCP sopra eventi del calendario | **Parità con oggi** nella release della migrazione | Eventuale avviso in admin solo in una release successiva; contratto MCP invariato. |
| 3 | Dati del cliente nell'evento della prenotazione sui device | **Intermedio**: titolo con nome, telefono, link alla prenotazione in admin | Niente email, azienda, messaggio né ATTENDEE sui device. Le proiezioni concluse da più di 24 mesi diventano "Prenotazione". Admin e MCP vedono la descrizione completa ricomposta da `calendar_bookings`. |
| 4 | Calendari creati dal telefono | **Bloccano di default**, con badge "nuovo dal dispositivo" in admin | |
| 5 | Iscrizioni ICS esterne | **Per singola iscrizione**, default nascosta ai device e non bloccante | Il wizard mostra l'impatto sugli slot prima di attivarle. |
| 6 | All-day creati dal telefono | **Bloccano solo con `TRANSP:OPAQUE` esplicito** ("Mostra come: occupato") | Gli all-day migrati restano non bloccanti. Rilascio dopo la verifica nella matrice device. Default dell'editor admin: libero. |
| 7 | Vecchio volume `radicale_data` della Fase 0 (se esiste) | **Backup tar e import in una collezione `archivio-fase0`** in sola lettura e non bloccante | Mai montato al posto del volume nuovo. |
| 8 | Eventi non di prenotazione nel calendario Prenotazioni | **Restano lì** (sola lettura per i device, modificabili da admin e MCP) | Spostamento possibile per singolo evento dal wizard. |
| 9 | Estensioni oltre il perimetro "quasi 1:1" | **Nessuna nel rilascio principale** | In F7, eventualmente, prima la proiezione "scadenze". VTODO e iMIP solo su richiesta. |

## Requisiti espliciti

- Strumento di migrazione avviabile dall'admin: anteprima, esecuzione idempotente, verifica per calendario, conferma del passaggio (cutover) e rollback. Postgres resta autorevole fino alla conferma.
- Endpoint di condivisione invariati:
  - feed ICS pubblici `GET /api/calendar/feed/<token>.ics` con gli stessi token, il toggle e la rigenerazione;
  - percorsi CalDAV dei device `dav.calicchia.design/federico/<slug>/` con le app-password esistenti, compresi gli slug di produzione (per esempio `f` per Festività).
- Contratti invariati per il sito (`/api/calendar/*`) e per i 22 tool calendario dell'assistente/MCP.

## Da confermare dall'utente (matrice device, F3)

Due scelte restano aperte fino alla [matrice device](matrice-device.md) in staging: le raccomandazioni qui sotto sono **da confermare dall'utente** con l'esito della prova e si registrano nel wizard (passo 5, dichiarazione `device_matrix`: `strict_preconditions` e `allday_transp_rule`). In F3 non cambia nulla in produzione: config di Radicale e regola dell'indice si applicano dopo la dichiarazione.

| Tema | Oggi | Raccomandazione (da confermare dall'utente) | Condizione dalla matrice | Se la condizione non tiene |
|---|---|---|---|---|
| `strict_preconditions` di Radicale (`[storage]` di `apps/radicale/config/config`) | `False` | **`True`**: una PUT senza `If-Match` su un oggetto esistente riceve 412 invece di sovrascrivere | iOS, macOS, DAVx5 e Thunderbird mandano `If-Match` su ogni modifica (M06) e l'uso normale non produce 412 (M08); il log di prova non ha `no If-Match header, strict mode enabled` | Resta `False`, con il rischio di lost update fra device documentato in [rischi.md](rischi.md) |
| TRANSP degli all-day creati dai device (decisione 6) | Nessun all-day blocca (`CAL_ALLDAY_OPAQUE_BLOCKS` spento, regola della F2) | **`opaque_blocks`**: blocca solo l'all-day con `TRANSP:OPAQUE` esplicito ("Mostra come: occupato"), come scelto nella decisione 6; attivazione con `CAL_ALLDAY_OPAQUE_BLOCKS=on` nella release successiva alla matrice, poi rebuild dell'indice | Nessun client scrive `TRANSP:OPAQUE` sugli all-day per default e nessuno lo aggiunge modificando un all-day migrato (M12) | `never_block` per tutti, finché il client che lo scrive di default non è corretto o sostituito |

Motivi:

- **`strict_preconditions = True`.** L'API manda già sempre `If-Match` o `If-None-Match` (design §3.2), quindi l'opzione cambia solo il comportamento dei client che non li mandano: con `False` la loro PUT sovrascrive in silenzio la modifica di un altro device (lost update, provato in `integration/device-emulation.test.ts`, "strict_preconditions: cosa cambia"), con `True` ricevono 412, rileggono e riprovano. Un `If-Match` vecchio dà 412 in entrambi i casi: la protezione dei client corretti non dipende dall'opzione. Creazioni su un href nuovo e cancellazioni senza `If-Match` restano ammesse.
- **`opaque_blocks`.** È la decisione 6 già presa ("bloccano solo con `TRANSP:OPAQUE` esplicito"), finora non attiva perché richiede la verifica sui device. Gli all-day migrati restano non bloccanti in ogni caso: il serializer della migrazione non scrive `TRANSP`, e un all-day senza `TRANSP` non blocca con nessuna delle due regole. Il rischio da escludere con la matrice è un client che salva gli all-day come "occupato" di default, che renderebbe bloccanti giornate che l'utente non ha mai segnato così.
