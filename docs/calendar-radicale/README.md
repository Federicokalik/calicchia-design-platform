# Calendario su Radicale

Passaggio del calendario da Postgres a Radicale come fonte di verità, con l'admin come client CalDAV quasi 1:1.

- [design.md](design.md): architettura completa, rivista dal red-team.
- [decisioni.md](decisioni.md): decisioni prese dall'utente.
- [piano.md](piano.md): fasi F0–F7 con attività, file, test e criteri di uscita.
- [rischi.md](rischi.md): rischi aperti.
- [inventario-produzione.sql](inventario-produzione.sql) e [inventario-server.sh](inventario-server.sh): inventario da eseguire in produzione, in sola lettura, prima della migrazione (F0).

Stato attuale: la sincronizzazione CalDAV in produzione non funziona (plugin incompatibili con Radicale 3.7.3 e parser ICS che scarta i VEVENT), quindi oggi nessun device sincronizza.
