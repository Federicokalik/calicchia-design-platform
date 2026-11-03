# Calendario su Radicale

Passaggio del calendario da Postgres a Radicale come fonte di verità, con l'admin come client CalDAV quasi 1:1.

- [design.md](design.md): architettura completa, rivista dal red-team.
- [decisioni.md](decisioni.md): decisioni prese dall'utente.
- [piano.md](piano.md): fasi F0–F7 con attività, file, test e criteri di uscita.
- [rischi.md](rischi.md): rischi aperti.
- [contracts/f2-modules.md](contracts/f2-modules.md): contratto dei moduli della F2 (facade a due store, indice derivato 163, coda dei lavori 164, pool e lock, firme di sync, indicizzatore, store, busy, iscrizioni e consumatori).
- [contracts/control-plane.md](contracts/control-plane.md): contratto fra API, plugin di Radicale e database (policy, heartbeat, identità del volume, utenti di servizio, cache delle credenziali, permessi), con gli schemi JSON e i casi di conformità condivisi.
- [inventario-produzione-2026-10-09.md](inventario-produzione-2026-10-09.md): inventario raccolto via MCP in sola lettura (calendari, eventi, prenotazioni, stato DST).
- Inventario completo del database, in sola lettura e senza testo libero: `apps/api/scripts/sql/calendar-inventory.sql`, eseguito con `pnpm --filter @calicchia/api calendar:inventory -- --out <cartella>` (istruzioni per la produzione nell'intestazione di `apps/api/scripts/calendar-inventory.ts`).
- [inventario-server.sh](inventario-server.sh): controlli da fare a mano sul server (log di Radicale, volume della Fase 0, filesystem dei volumi, vhost `dav`, backup).

Stato attuale: la sincronizzazione CalDAV in produzione non funziona (plugin incompatibili con Radicale 3.7.3 e parser ICS che scarta i VEVENT), quindi oggi nessun device sincronizza.
