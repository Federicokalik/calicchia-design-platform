# Inventario calendario in produzione — 2026-10-09

Raccolto con i tool in sola lettura dell'MCP di Calicchia Design (`list_calendars`, `list_events`, `list_bookings`, `list_event_types`), che leggono dall'API di produzione. Non sono state usate query SQL dirette: i punti marcati "non disponibile" richiedono ancora l'accesso al DB o al server.

## Calendari

| slug | nome | righe | default | is_system | note |
|---|---|---|---|---|---|
| `c` | Creattivamente SRL | 7 | no | no | 2 serie ricorrenti + singoli |
| `f` | Festività e chiusure | 92 | no | **no** | 91 festività `source=system` + 1 chiusura manuale "Ferie" (27/07–09/08/2026). `is_system=false`: la migrazione 158 non è ancora in produzione |
| `lavoro` | Lavoro | 0 | sì | no | |
| `personale` | Personale | 0 | no | no | |
| `bookings` | Bookings | 1 | no | sì | 1 proiezione di prenotazione confermata |
| `scadenze` | Scadenze | 0 | no | sì | |

Tutti hanno un feed ICS attivo (URL con token, da preservare).

## Eventi del calendario `c`

- Serie `2wsjr1bwyux7g3h1` "Gestione Creattivamente": dal 10/08/2026, lun-mar-gio-ven alle 09:00 Europe/Rome, **senza fine**, luogo valorizzato, nessuna eccezione osservata (finestra 10/2026–09/2027: 209 occorrenze).
- Serie `wid8cx7g125ygr1v` "Gestione": dal 04/06/2026 al 16/06/2026 (lun-mar-gio-ven), conclusa.
- Singoli "Gestione" del 01/06, 03/06 (creato via MCP), 04/06 e 19/06/2026. Alcuni sono copie create con "Duplica" (`source=admin`, `source_id` = id dell'originale). Uno è un duplicato esatto della prima occorrenza della serie di giugno.
- Nessun evento prima di ottobre 2025.

## Prenotazioni ed event types

- 2 event types: `consulenza-gratuita-30min` (Google Meet, 30') e `sopralluogo-in-presenza` (60'), entrambi attivi e pubblici.
- 2 prenotazioni: 1 confermata (10/08/2026, con proiezione nel calendario `bookings`), 1 annullata (01/06/2026).
- La proiezione contiene email e telefono del cliente nella DESCRIPTION. Per la decisione 3 sui device andranno solo nome, telefono e link.

## Fuso orario (DST)

**La produzione espande ancora le ricorrenze in UTC.** Le 209 occorrenze della serie "Gestione Creattivamente" escono tutte alle 07:00Z, anche dopo il 25/10/2026. In inverno l'evento comparirebbe quindi alle 08:00 locali invece delle 09:00.

Il fix (commit `d046006`, espansione in ora locale Europe/Rome) è sul branch ma non in produzione. Una volta rilasciato, le occorrenze invernali passano alle 08:00Z (09:00 locali), che è il comportamento corretto. Nelle serie osservate non ci sono eccezioni da riallineare: lo script `fix-dst-exceptions` dovrebbe risultare senza modifiche (da confermare con il dry-run).

## Volumi per la migrazione

Circa 100 righe in totale: 2 serie, circa 5 singoli in `c`, 92 in `f`, 1 in `bookings`. La migrazione dei dati è piccola: il rischio sta tutto nella correttezza (ricorrenze, fusi, slug `c`/`f`, token dei feed), non nei volumi.

## Non disponibile via MCP (richiede DB o server)

- Iscrizioni ICS (`calendar_subscriptions`) e loro stato.
- App-password CalDAV (`caldav_app_passwords`) e username in uso.
- EXDATE grezzi, override cancellati, RRULE testuali, `audit_logs`.
- Server: log del container Radicale, vecchio volume `radicale_data` della Fase 0, tipo di filesystem dei volumi Docker, vhost `dav.calicchia.design`, cadenza dei backup.

Per questi punti: `pnpm --filter @calicchia/api calendar:inventory` sul database di produzione (sola lettura) e i controlli di [inventario-server.sh](inventario-server.sh).
