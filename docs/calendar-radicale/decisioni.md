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
