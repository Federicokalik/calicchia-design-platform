# Piano di implementazione (fasi F0–F7)

Riferimento: [design.md](design.md). Decisioni: [decisioni.md](decisioni.md).

## F0 - Inventario di produzione, contratti, harness e correzione DST in PG

**Obiettivo.** Conoscere i dati reali, congelare il comportamento attuale come baseline automatica e chiudere in PG il difetto delle eccezioni precedenti al fix DST, prima di toccare lo storage.

**Attività**

1. Eseguire in produzione, in sola lettura, le query di inventario (comprese quelle nuove: eccezioni DST, eventi non-proiezione in bookings, impatto delle iscrizioni, username delle app-password, data di applicazione della 158) e i controlli sul server: log di radicale, vhost dav, volume della Fase 0, tipo di filesystem dei volumi Docker, subnet già in uso per scegliere caldav-int. Produrre il report.
2. Script fix-dst-exceptions.ts con dry-run e apply: riallinea EXDATE e recurrence_id che hanno la stessa ora UTC del DTSTART ma un'ora locale di Roma diversa. Report e audit_logs. L'utente lo esegue dopo aver visto il dry-run.
3. Generare automaticamente il contratto MCP: lista vincolante dei tool calendario e snapshot di input e output su fixture, compresi i casi con eventi in bookings e in 'f'.
4. Test di contratto sulla baseline PgLegacyStore: API pubblica del sito, admin v1, feed, agenda device, capacity-week, cal-slots.
5. Portare i casi di verify-calendar.ts e verify-calendar-schema.ts in test node:test parametrici.
6. Harness: Radicale reale (container o venv 3.7.8), mock di verify-credentials, rete con subnet fissa per i test del peer, job CI calendar-integration.

**File**

- `apps/api/scripts/sql/calendar-inventory.sql`
- `apps/api/scripts/calendar-inventory.ts`
- `apps/api/scripts/fix-dst-exceptions.ts`
- `apps/api/scripts/mcp-contract-snapshot.ts`
- `apps/api/test/helpers/{db,radicale,fixtures}.ts`
- `apps/api/test/helpers/mock_verify.py`
- `apps/api/test/contracts/{public-calendar,admin-calendar-v1,mcp-calendar-tools,feed,device-agenda,capacity-and-slots}.contract.test.ts`
- `apps/api/test/contracts/allowed-diffs.json`
- `apps/api/test/calendar/legacy-cases.test.ts`
- `apps/api/test/calendar/dst-fix.test.ts`
- `apps/api/package.json`
- `.github/workflows/ci.yml`

**Test**

- Snapshot dei tool MCP verdi sul codice attuale
- Contratto del sito: event-types, slots, POST bookings (200, 400, 403, 404, 409), manage con token, reschedule, ics
- fix-dst-exceptions: una serie creata a settembre con eccezione salvata a novembre alle 07:00Z viene riallineata alle 08:00Z; idempotente; nessun effetto sulle eccezioni create dopo il fix
- Casi di verify-calendar*.ts tutti verdi su PgLegacyStore

**Criterio di uscita.** Report di inventario con i numeri reali approvato dall'utente. Correzione DST applicata in produzione, con dry-run e audit. Baseline dei contratti verde in CI. Lista dei tool vincolanti congelata. Decisioni dell'utente prese.

## F1 - Radicale nativo in shadow, identità, heartbeat e backup integrati

**Obiettivo.** Sostituire il proxy rotto con Radicale 3.7.8 su storage nativo con un gate fail-closed (policy, identità del volume, heartbeat, peer di servizio), rendere sicuro il backup JSON prima che Radicale contenga dati autorevoli. Postgres resta autorevole.

**Attività**

1. Immagine pinnata per digest con selftest. Healthcheck PROPFIND sulla root come probe da 127.0.0.1.
2. caldes_auth: utenti caldes-* riconosciuti dal peer (CALDES_SVC_CIDR, 127.0.0.1 solo per il probe), username riservati mai nel ramo device, principal canonico per ogni app-password, cache di 60 s più cache persistita HMAC di 24 h (stale-if-error), backend giù senza cache → eccezione (500), timeout di 1 s, credential_epoch.
3. caldes_rights: policy più heartbeat (stale oltre 10 minuti → frozen) più identità del volume (dead prop volume-id ed epoch sul principal); nessun W su altri principal; _canary; readonly e hidden dai ruoli.
4. caldes_vobject_fix con sitecustomize. Eliminare caldes_storage.py. Config come al §3.2.
5. Compose: rete caldav-int interna con subnet fissa e alias, volumi radicale_collections, caldes_control e radicale_authcache, niente build: per radicale, tag sha pinnati, nessun depends_on rigido. Runbook del deploy in due commit. CloudPanel: X-Remote-Addr e client_max_body_size.
6. Migrazione 162: sidecar con lifecycle, calendar_sidecar_reconcile(), colonne delle iscrizioni (blocks_availability e device_visible a false), calendar_backend_state con le colonne di F1. Writer di policy e heartbeat tramite policyFromState(). Formati e semantica nel [contratto del control-plane](contracts/control-plane.md).
7. caldav-backend e caldav-tokens: verify-credentials con principal canonico, X-Forwarded-For, rate limit per (IP, username); username riservati rifiutati; UI con username fisso 'federico'; route /collections* rimosse.
8. backup.ts: partizione S/D/B (§16.2); S mai ripristinate; D solo in mode postgres; calendars in UPSERT; reconcile, rebuild_required e restore_guard dopo l'import; avviso nella UI.
9. Script unico backup-calendar-stack.sh (pg_dump più tar del volume sotto flock, ogni 6 h, manifest unico, S4); runbook di restore; drill.

**File**

- `apps/radicale/Dockerfile`
- `apps/radicale/config/config`
- `apps/radicale/plugins/{caldes_auth,caldes_rights,caldes_vobject_fix,sitecustomize,caldes_healthcheck,caldes_selftest}.py`
- `apps/radicale/plugins/caldes_storage.py (eliminato)`
- `apps/radicale/tests/{test_auth,test_rights,test_fidelity,test_layout_contract,test_identity,test_image,test_stack}.py`, `caldes_harness.py`
- `apps/api/test/helpers/mock_verify.py` (mock di verify-credentials del harness F0, condiviso con i test dei plugin)
- `apps/radicale/README.md`
- `.github/workflows/build-radicale-image.yml`
- `docker-compose.portainer.yml` (invariato nel commit 1: le modifiche sono in `docs/calendar-radicale/deploy/f1-compose.patch`, applicata nel commit 2 con il tag sha pubblicato)
- `docker-compose.prod.yml (nota di deprecazione)`
- `docs/portainer-cloudpanel.md`
- `.env.example`
- `.env.prod.example`
- `database/migrations/162_calendar_sidecar.sql`
- `apps/api/src/routes/calendar/caldav-backend.ts`
- `apps/api/src/routes/caldav-tokens.ts`
- `apps/api/src/lib/calendar/caldav-passwords.ts`
- `apps/admin/src/pages/impostazioni/caldav-tokens-section.tsx`
- `apps/api/src/lib/calendar/radicale/{types,client,errors,dav-xml,policy,heartbeat,identity}.ts`
- `apps/api/scripts/radicale-init.ts` (inizializzazione manuale del volume in F1: `pnpm --filter @calicchia/api calendar:radicale-init`)
- `docs/calendar-radicale/contracts/` (contratto del control-plane, schemi JSON, casi condivisi)
- `apps/api/src/routes/backup.ts`
- `apps/admin/src/pages/impostazioni.tsx` (avviso nella sezione Backup)
- `scripts/backup-calendar-stack.sh`
- `scripts/restore-calendar-stack.sh`
- `scripts/calendar_stack.py` (manifest, identità e inventario del volume per i due script)
- `scripts/backup-db.sh (delega allo script unico)`

**Test**

- pytest auth: svc dal peer interno accettato, dal gateway rifiutato; 'caldes-svc' come app-password dal gateway → 401, mai il ramo device; 'iphone' → utente federico; backend giù senza cache → 500 senza delay; cache persistita usata solo su errore; revoca tramite credential_epoch
- pytest rights: shadow, live e frozen; policy corrotta → sola lettura; heartbeat assente o scaduto → frozen; marker assente o diverso → 403 e nessuna directory creata; nessun W su /iphone/ né su /caldes-svc/; DELETE della collezione negato
- pytest fedeltà e contratto del layout (mtime, .Radicale.props)
- backup.ts: import di un backup v1 precedente alla 162 in mode postgres → ruoli preservati, nessun TRUNCATE su calendars; stato e tabelle cal_* mai toccati
- Contratti F0 ancora verdi
- End-to-end del criterio di uscita (`apps/api/test/integration/radicale-f1-e2e.test.ts`): config e plugin reali del repository, policy e heartbeat dal control-plane dell'API, verify-credentials dall'API vera

**Criterio di uscita.** Un device reale si autentica con un'app-password esistente, anche con username diverso da federico, e vede /federico/ in sola lettura dopo l'inizializzazione. Su un volume vuoto riceve 403 e non si crea nulla. Il login del servizio da internet dà 401. CI dell'immagine verde. Drill di backup e restore riuscito. Nessuna regressione nei contratti.

## F2 - Core: calendar-core, indice derivato con salute per oggetto, facade a due store, busy fail-closed circoscritto

**Obiettivo.** Rendere Radicale leggibile e scrivibile dall'API con fedeltà completa e percorsi caldi in SQL, contratti intatti su entrambi gli store e senza punti di fallimento globali.

**Attività**

1. @calicchia/calendar-core: parse e serialize, model, patch lossless, recurrence-ops, expand con abbinamento proprio degli override (tollerante al tipo, orfani autonomi), tetto contato nell'orizzonte con budget di 200k iterazioni, registro dei fusi, validate, fingerprint semantico (senza DTSTAMP, e senza LAST-MODIFIED e SEQUENCE a contenuto invariato), feed-transform.
2. Migrazioni 163 (indice con health, kind e blocks; cal_object_ids senza FK verso calendar_events; versioni) e 164 (cal_jobs con coalescenza solo sui pending e source_version).
3. radicale/: watcher a stat, canary più statfs, remote mode con budget e 404 confermati due volte, syncCollection (pool dedicato, single-flight, try-lock, interruttore anti-cancellazione, worker_threads, CAS), discovery con adozione per dead prop, identità, health, rebuild atomico per collezione, auditor, horizon, resolver degli id con gestione dei MOVE.
4. Facade: codice attuale spostato in lib/calendar/legacy/ senza modifiche. RadicaleStore con le guardie API identiche a oggi, gate cal-write, CAS per campo, patch, If-Match, write-through, 409 per recurrence_key sparito, lifecycle creating/deleting dei calendari.
5. busy.ts al posto di local-busy.ts (fail-closed per oggetto e collezione). blocks esclude le proiezioni booking-*. Capacity in una SQL con le esclusioni di oggi (source booking/system, role holidays, all-day). booking.ts: freshness nel lock, db: tx nella riprogrammazione, proiezione via job, resolveLocationForBooking.
6. Iscrizioni: pull verso l'indice (solo-cache, nessuna versione) in parallelo al legacy; job di specchio per le device_visible; flag di blocco per iscrizione nella query di busy.
7. Consumatori su store: agenda device, feed (ETag dal corpo, filtro CANCELLED, UID legacy, DTSTAMP stabile), /closures (holidays tranne it-holiday-*), event_count, tools.ts con le descrizioni delle proiezioni ricomposte da calendar_bookings, mappatura degli errori MCP sul ramo {error} esistente.
8. /api/health/calendar. Cron: watcher, canary, worker dei job, auditor, horizon.

**File**

- `packages/calendar-core/package.json`
- `packages/calendar-core/src/{parse,serialize,model,patch,recurrence-ops,expand,override-match,tz-registry,validate,fingerprint,feed-transform,allday,index}.ts`
- `apps/api/Dockerfile`
- `apps/api/package.json`
- `apps/api/src/db/index.ts (pool calendario dedicato)`
- `database/migrations/163_calendar_index.sql`
- `database/migrations/164_calendar_jobs.sql`
- `apps/api/src/lib/calendar/store.ts`
- `apps/api/src/lib/calendar/legacy/{events-pg,calendars-pg,subscriptions-pg,rrule-legacy}.ts`
- `apps/api/src/lib/calendar/radicale/{store,watcher,canary,sync,discovery,identity,health,rebuild,freshness,auditor,horizon,ids,versions,write-gate}.ts`
- `apps/api/src/lib/calendar/subscriptions/{pull,mirror}.ts`
- `apps/api/src/lib/calendar/jobs.ts`
- `apps/api/src/lib/calendar/busy.ts`
- `apps/api/src/lib/calendar/local-busy.ts (eliminato)`
- `apps/api/src/lib/calendar/{events,calendars,subscriptions,capacity,slots,booking,feed-builder,ics-split,adapters}.ts`
- `apps/api/src/routes/calendar/{feed,admin,health}.ts`
- `apps/api/src/routes/device.ts`
- `apps/api/src/lib/agent/tools.ts`
- `apps/api/src/cron/index.ts`

**Test**

- Contratti di F0 su entrambi gli store contro Radicale reale; differenze solo quelle di allowed-diffs.json
- Espansione: all-day con EXDATE e override, UNTIL inclusivo, DST, RDATE, fuso diverso, floating; override DATE-TIME su master DATE abbinato; override fuori regola → occorrenza autonoma; DAILY dal 2010 → occorrenze nella settimana corrente; HOURLY infinita → materialized_until senza 503
- Salute: RRULE invalida in una collezione bloccante → /slots 200 e busy conservativo; file corrotto → quarantena con ultima versione buona
- Sync: token scaduto → full resync; 60% degli item spariti → hold, busy invariato; volume con identità diversa → 503 e device 403; canary fallito → remote mode dichiarata
- Prenotazioni: riprogrammazione sovrapposta all'originale accettata; Radicale fermo con directory cambiata → 503; Radicale fermo senza modifiche → accettata; MCP create_booking indisponibile → {error} senza code
- Iscrizioni: feed con DTSTAMP sempre nuovo → zero scritture e zero versioni; iscrizione non visibile → nessuna PUT su Radicale
- Rebuild: decisioni durante il rebuild → sync forzata o 503, mai busy vuoto; id identici dopo il rebuild
- Feed: ETag diverso al cambio di data; STATUS:CANCELLED escluso; UID legacy delle proiezioni
- Prestazioni: busy su 60 giorni sotto 20 ms; /slots p95 sotto 200 ms con 5000 oggetti

**Criterio di uscita.** Contratti verdi su entrambi gli store. Fail-closed dimostrato e circoscritto: nessun singolo item porta /slots in 503. Indice ricostruito da zero con gli stessi id. Lag fra scrittura del device e indice sotto 2 s (p95). Agenda device espansa con la stessa forma.

## F3 - Strumento di migrazione, shadow mirror e prova sui device

**Obiettivo.** Dare all'utente in admin inizializzazione, anteprima, apply idempotente e resistente ai crash, verifica per calendario e shadow con parità osservata, senza togliere autorità a Postgres.

**Attività**

1. Migrazione 165 (colonne di calendar_backend_state non ancora presenti, fra cui api_min_version: la tabella nasce nella 162, vedi [contratto del control-plane §2](contracts/control-plane.md); ledger con legacy_snapshot, righe d'intento, adopted e derived; runs; items).
2. migration/: preflight (identità, gate, canary, test negativo del servizio, app-password riservate), init (unico punto di MKCOL e MKCALENDAR, marker volume-id/epoch, _canary), inventory con le anomalie nuove (DST_SHIFTED_EXCEPTION, NON_PROJECTION_IN_BOOKINGS, SUBSCRIPTION_BLOCKING_IMPACT, NON_CANONICAL_APP_PASSWORD), serializer che riusa gli href e lega le proiezioni alle righe legacy, apply con righe d'intento, adozione per fingerprint e gestione di no-uid-conflict, verify V1-V5 con V3 a finestre di 60 giorni e V4 con e senza iscrizioni, shadow con patch per campo sugli oggetti esistenti.
3. Proiezione delle prenotazioni (solo dopo la decisione 3) e riconciliazione in sola lettura per le orfane. Sidecar delle iscrizioni con flag per singola iscrizione.
4. Route /api/admin/calendar/migration e wizard a 6 passi, con l'inizializzazione nel passo 1.
5. GDPR: calendarErase esteso (indice, versioni, bookings, audit_logs, calendar_events, artefatti della migrazione); retention delle proiezioni concluse.
6. Matrice device in staging: iOS, macOS, DAVx5, Thunderbird. If-Match con strict_preconditions=True, X-prop, collezioni protette e hidden, TRANSP degli all-day (per la decisione 8), comportamento su 403 e 500 (nessuna password invalidata).

**File**

- `database/migrations/165_calendar_migration.sql`
- `apps/api/src/lib/calendar/migration/{preflight,init,inventory,serialize,plan,apply,verify,shadow,report}.ts`
- `apps/api/src/lib/calendar/radicale/booking-projection.ts`
- `apps/api/src/cron/italian-holidays.ts`
- `apps/api/src/cron/ics-pull.ts`
- `apps/api/src/routes/calendar/migration.ts`
- `apps/api/src/app.ts`
- `apps/api/src/lib/calendar/gdpr.ts`
- `apps/api/src/routes/gdpr-requests.ts`
- `apps/api/src/cron/data-retention.ts`
- `apps/admin/src/pages/calendario/migrazione.tsx`
- `apps/admin/src/components/calendar/migration/{preflight-step,preview-step,apply-step,verify-step,shadow-step,cutover-step}.tsx`
- `apps/admin/src/components/layout/calendar-tabs.tsx`
- `apps/admin/src/App.tsx`
- `scripts/radicale-maint.sh`

**Test**

- Serializer sulle fixture con le anomalie, comprese le eccezioni DST spostate e gli eventi non-proiezione in bookings
- Apply: (a) update; (b) TARGET_NEWER; (c) BOTH_CHANGED; (d) delete con If-Match; (e) seconda esecuzione al 100% noop; (f) kill fra PUT e ledger → adozione come noop; (g) UID a un altro href → adozione o UID_AT_OTHER_HREF
- Init: rifiuta un volume non vuoto con identità diversa; nessuna MKCALENDAR fuori dall'init
- Verify: serie lun-ven con più di 500 occorrenze senza rossi; differenze attese gialle; V4 identico senza iscrizioni
- Shadow: modifica legacy su un oggetto con VALARM in Radicale → VALARM preservato (patch per campo)
- Erasure GDPR completa, audit_logs compresi

**Criterio di uscita.** Su una copia di produzione e poi in produzione: tutti i calendari verdi, o gialli con differenze accettate. Seconda esecuzione a zero scritture, anche dopo un kill a metà. Shadow con parità verde per almeno 7 giorni. Matrice device superata e decisioni documentate (strict_preconditions, TRANSP degli all-day).

## F4 - Cutover, rollback, proiezione inversa totale e prova generale in staging

**Obiettivo.** Rendere il passaggio reversibile senza perdita di semantica e ripetibile: transizioni con gate e quiescenza, proiettore inverso totale, ri-baseline del ledger, integrazione con i backup. Tutto provato in staging prima della produzione.

**Attività**

1. Migrazione 166: trigger di guardia guidato dallo stato su INSERT, UPDATE e DELETE, più le colonne caldes_object_id e caldes_derived.
2. migration/transition.ts: stato prima, policy derivata, lock esclusivo cal-write, quiescenza con la PUT del probe su _canary (403 atteso) e stat stabile; journal con ripresa dopo un crash.
3. migration/cutover.ts: passi del §13.10 con il cambio di epoch (PROPPATCH più tx) e gli smoke in tx sempre annullata.
4. migration/reverse-projector.ts: mappatura totale (espansione di RDATE, TZID diversi da Roma e orfani; sanificazione di uid, summary e durata; proiezioni legate alle righe legacy; classi di degrado; REVERSE_FAILED in anteprima).
5. migration/rollback.ts e rebaseline.ts: ri-baseline del ledger con href reale, legacy_snapshot, etag corrente, adopted e derived; finalize.ts.
6. backup.ts: mappatura calendar_events → calendar_events_legacy quando calendar_events è una vista; export v2 (zip .ics per collezione più manifest).
7. Ritocchi minimi alla UI attuale: saga per 'questa e le successive', selezione degli all-day, timeZone Europe/Rome, UNTIL a fine giornata locale.
8. Prova generale in staging: cutover, uso misto con i casi A/B/C del red-team, rollback, nuovo cutover, kill durante cutover e rollback, rollback d'immagine API simulato.

**File**

- `database/migrations/166_calendar_events_guard.sql`
- `apps/api/src/lib/calendar/migration/{transition,cutover,rollback,rebaseline,reverse-projector,finalize,smoke}.ts`
- `apps/api/src/lib/calendar/store.ts`
- `apps/api/src/routes/backup.ts`
- `apps/admin/package.json`
- `apps/admin/src/pages/calendario.tsx`
- `apps/admin/src/pages/calendario/evento-edit.tsx`
- `apps/admin/src/lib/timezone.ts`

**Test**

- Trigger: in mode radicale una scrittura diretta su calendar_events fallisce; con il GUC passa; la delete di un calendario completa le cascate
- Transizione: un riavvio dell'API fra il passo 2 e il 3 del rollback non riporta la policy a live; dopo il passo 2 la PUT del device risponde 403; job e MCP attendono il gate
- Proiezione inversa: RDATE e serie New York → busy legacy identico a Radicale dopo il rollback; UID dell'invito duplicato in lavoro, durata zero, evento senza SUMMARY e override con l'UID del master → righe sanificate e classificate, nessun job failed
- Nuovo cutover dopo il rollback: oggetto creato da iPhone con href proprio → noop; oggetti toccati da admin o MCP nella finestra → noop dopo la ri-baseline
- Prenotazione pre-cutover annullata nella finestra → riga legacy cancelled, slot libero dopo il rollback
- Smoke: nessuna prenotazione, job, email o workflow residuo
- Backup: import di un backup precedente al finalize con calendar_events dopo la creazione della vista
- Heartbeat: immagine API senza heartbeat → device frozen entro 10 minuti; scritture legacy bloccate dal trigger

**Criterio di uscita.** Prova generale in staging riuscita due volte, compresi i kill durante cutover e rollback con ripresa corretta. Rollback con busy identico e degradi pari a quelli dell'anteprima. Secondo cutover a zero scritture per gli oggetti non toccati. Contratti verdi in mode radicale.

## F5 - Cutover in produzione e finestra di rollback

**Obiettivo.** Passare la produzione a Radicale in una finestra notturna e presidiare 30 giorni con rollback possibile.

**Attività**

1. Backup unico (DB più volume) di meno di 2 ore; preflight; ultima verifica; cutover dal wizard con conferma digitata; tag dell'immagine API pinnato a sha.
2. Prova dei device in scrittura: creazione e modifica da iPhone e Mac, VALARM e X-prop preservati nei due sensi, collezioni protette in sola lettura, app-password con username non canonico.
3. Presidio con alert su lag, job, conflitti, quarantene, hold, identità, heartbeat, canary e coerenza della policy; contratti giornalieri in produzione.
4. Release R+1 annunciata: find_free_slots in Europe/Rome, limite di 366 giorni, eventuale avviso conflitti, eventuale regola TRANSP degli all-day, abilitazione delle iscrizioni bloccanti scelte.

**File**

- `docs/calendar-radicale/runbook-cutover.md`
- `docs/calendar-radicale/runbook-restore.md`
- `docs/calendar-radicale/runbook-deploy.md`
- `docker-compose.portainer.yml (tag API pinnato)`

**Test**

- Smoke automatici post-cutover verdi
- Contratti giornalieri verdi in produzione
- Auditor senza derive non spiegate; nessuna collezione in hold non risolta

**Criterio di uscita.** 30 giorni (minimo 14) in mode radicale senza rollback. Nessuna prenotazione su slot occupati. Zero job failed e zero REVERSE_FAILED non risolti. UID del feed invariati per gli abbonati, proiezioni comprese.

## F6 - Admin client CalDAV quasi 1:1 (parallelo da F2, rilascio dopo F5)

**Obiettivo.** Portare l'admin alla copertura iCalendar completa con ETag fino in fondo, conflitti gestiti, import/export, proprietà dei calendari e strumenti di salute e recupero.

**Attività**

1. Route admin-v2: objects (ops, scope, base, dryRun), ics raw, move, duplicate, versions e restore, trash, export; calendars con dav_props, ordine e import; occurrences; overlays; sync-state; apply-deletions e rebuild-from-index; timezones.
2. Admin: refactor di calendario.tsx, editor a tab, ConflictDialog, cronologia e cestino, import/export, calendari.tsx esteso, badge per orfani e quarantena, pagina 'Salute del calendario'.
3. @calicchia/calendar-core nel browser per anteprima RRULE, riepilogo in italiano, parsing degli import e validazione del raw.
4. Correzioni UI: widget agenda e overlay senza troncamento.

**File**

- `apps/api/src/routes/calendar/admin-v2.ts`
- `apps/admin/package.json`
- `apps/admin/vite.config.ts`
- `apps/admin/src/pages/calendario.tsx`
- `apps/admin/src/pages/calendario/vista/*.tsx`
- `apps/admin/src/pages/calendario/evento/{evento-editor,tab-generale,tab-tempo,tab-ricorrenza,tab-promemoria,tab-partecipanti,tab-avanzate}.tsx`
- `apps/admin/src/components/calendar/{scope-dialog,conflict-dialog,recurrence-editor,alarms-editor,attendees-editor,tz-select,raw-ics-editor,history-drawer,import-dialog}.tsx`
- `apps/admin/src/pages/calendario/calendari.tsx`
- `apps/admin/src/pages/calendario/salute.tsx`
- `apps/admin/src/components/dashboard/widget-agenda.tsx`
- `apps/admin/e2e/calendar.spec.ts`

**Test**

- Round-trip delle fixture di Apple, Google, Thunderbird, DAVx5 e Outlook: cambiano solo le proprietà toccate
- E2E: solo questa, questa e le successive, tutta la serie; elimina e ripristina; all-day; fuso diverso; allarmi; invitati; import ed export; 412 → ConflictDialog; collezione in hold → scelta applica o ricostruisci
- Contratti v1 ancora verdi

**Criterio di uscita.** In staging un evento creato da iPhone e modificato dall'admin conserva VALARM, ATTENDEE e X-*. Un conflitto concorrente con un device si risolve dall'interfaccia. E2E verdi.

## F7 - Finalize, correzioni rinviate ed estensioni opzionali

**Obiettivo.** Chiudere la finestra di rollback, rimuovere il codice legacy e attivare solo le estensioni scelte.

**Attività**

1. Finalize: stop della proiezione inversa e calendar_finalize_legacy() (migrazione 167).
2. Release successiva: rimozione di PgLegacyStore, rrule.ts, parseIcs, buildIcsResource e dei residui di caldav-backend. Allowlist di tool_db_query aggiornata (calendar_events come vista, cal_occurrences).
3. Retention: eliminazione di calendar_events_legacy 12 mesi dopo il finalize (dichiarata nel ROPA).
4. Estensioni scelte: scadenze, VTODO, iMIP. Upgrade a Radicale 3.8.x solo dopo almeno 4 settimane e con la suite CI verde.
5. ROPA, README di Radicale e runbook aggiornati.

**File**

- `database/migrations/167_calendar_finalize_fn.sql`
- `apps/api/src/lib/calendar/legacy/* (eliminati)`
- `apps/api/src/lib/calendar/rrule.ts (eliminato)`
- `apps/api/src/lib/calendar/ics-import.ts`
- `apps/api/src/lib/calendar/ics-feed.ts`
- `apps/api/src/lib/workflow/nodes.ts`
- `apps/api/scripts/verify-calendar.ts (eliminato)`
- `apps/api/scripts/verify-calendar-schema.ts (eliminato)`
- `docs/gdpr/ropa.md`
- `apps/radicale/README.md`

**Test**

- Import di un backup v1 storico riuscito
- Nessun riferimento runtime a calendar_events oltre la vista (grep in CI)
- Contratti e fedeltà verdi dopo l'eventuale upgrade di Radicale

**Criterio di uscita.** Codice legacy assente dai percorsi runtime. CI verde. Restore reale provato in staging. Documentazione operativa e GDPR aggiornata.
