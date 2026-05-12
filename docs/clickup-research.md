# ClickUp — Ricerca UI/UX per il pannello admin

Ispezione diretta di `app.clickup.com` (workspace "Calicchia Design") effettuata con Claude in Chrome il 2026-04-23. Raccolta feature, struttura, toolbar e flussi per decidere cosa "rubare" nel nostro admin.

Questo file è un dump di scoperta. Il passo successivo è la scrematura (vedi sezione finale).

---

## 1. Mappa mentale di ClickUp

### 1.1 Gerarchia dati
```
Workspace (es. "Calicchia Design")
└── Space (es. "Team Space", "Project 1", "Project 2")
    └── Folder (opzionale, con Subfolders beta fino a 7 livelli)
        └── List
            └── Task
                └── Subtask (annidati fino a 7 livelli)
```
Ogni livello può avere **viste multiple** (List / Board / Calendar / Gantt / Table / Timeline / Mappa / Attività) riutilizzabili con filtri indipendenti.

### 1.2 Chrome dell'applicazione (sempre presente)

**Topbar (top: ~0-50px)**
- Workspace switcher (avatar + nome workspace)
- Ricerca globale (Ctrl+K)
- "Chiedi all'IA" (pulsante diretto sull'IA)
- `+ Crea attività` (quick-add task)
- "Registra una clip" (screen recording integrato)
- Avatar utente + notifiche

**Sidebar sinistra — rail icone + pannello**
Sezione 1 — Rail icone verticale (in alto):
- Home (landing personale "Le mie attività")
- Planner (con badge numerico, es. "23")
- IA (ClickUp Brain)
- Team (Team Hub)
- Altro (overflow con Dashboards / Docs / Goals / Whiteboards / Forms / Timesheets)

Sezione 2 — Pannello notifiche:
- In arrivo
- Risposte
- Commenti assegnati
- Le mie attività
- Altro

Sezione 3 — Workspace tree:
- Preferiti (Pin manuale)
- Spazi → Folder → Lists (tree espandibile)
- Canali (chat Slack-style: #Generale, #Welcome, ecc.)
- Messaggi diretti

### 1.3 URL pattern osservati
- Lista: `/{workspaceId}/v/l/{viewId}`
- Bacheca: `/{workspaceId}/v/b/{viewId}`
- Calendario: `/{workspaceId}/v/c/{viewId}`
- Gantt: `/{workspaceId}/v/g/{viewId}`
- Grafico/Table: `/{workspaceId}/v/gr/{viewId}`
- Doc embedded: `/{workspaceId}/v/dc/{viewId}`
- Canale chat: `/{workspaceId}/v/cn/…` o `/chat/r/…`
- Task singolo: `/t/{taskId}` (short ID globale, es. `/t/86d14z2mz`)
- Space: `/{workspaceId}/v/s/{spaceId}/1`
- Home: `/{workspaceId}/my-work`
- Inbox: `/{workspaceId}/inbox?tab=primary`
- Planner: `/{workspaceId}/calendar`
- IA: `/{workspaceId}/ai/brain`
- Team Hub: `/{workspaceId}/teams-pulse/teams`

> Insight: ogni vista è una **entità persistente** con ID. Non è un query string. Gli utenti salvano viste con filtri diversi come "bookmark" nella gerarchia.

---

## 2. Vista principale (es. "List" / Bacheca / Gantt)

### 2.1 Toolbar universale (identica in tutte le viste)
Osservata in List, Board e Gantt, con sottili differenze:

| Controllo | Funzione |
|---|---|
| **Gruppo** (dropdown) | Group by: Status, Priority, Assegnatario, Date, Tag, Custom Field |
| **Sottoattività** | Collassa/espandi/mostra inline |
| **Colonne** | Toggle visibilità colonne (solo List/Table) |
| **Ordinamento** | Sort asc/desc per qualsiasi campo |
| **Filtro** | Builder AND/OR multi-condizione |
| **Chiuso** (toggle) | Mostra/nascondi task completate |
| **Assegnatari** | Filter rapido per persona (chip multipli) |
| **Cerca…** | Filter testuale inline |
| `+ Crea attività` | Quick-add nella vista corrente |
| "Chiedi all'IA su questo elenco" | AI contestuale ancorata alla vista |
| "Aggiungi ai preferiti" | Pin nella sidebar |
| "Condividi" | Link pubblico o permessi |
| "Personalizza" | Density, comfort, colonne, colori |

### 2.2 Switcher viste (tab secondaria, sotto topbar)
Tab orizzontali con icone:
`List | Board | Calendar | Gantt | Table` (+ `+ Aggiungi vista` per crearne di nuove)

> Insight: lo switcher è **per-Lista**. Nostro admin ha pagine separate (`/pipeline`, `/calendario`, `/progetti`). ClickUp le fonde per contenitore.

### 2.3 Descrittori della List (sotto lo switcher)
Header inline sopra la vista:
- Nome lista + "Aggiungi descrizione"
- "Aggiungi assegnatario elenco"
- "Aggiungi priorità elenco"
- "Aggiungi date elenco"
- "Aggiungi canale" (lega chat alla lista)

> Insight: anche la List stessa ha metadata (owner, priority, date) — non solo i task.

---

## 3. Task Detail Panel — il cuore di ClickUp

Apribile come:
- Drawer laterale (click su riga)
- Pagina full (`/t/{taskId}`)
- Modal overlay

### 3.1 Header task
- Breadcrumb (Space > List > Task)
- Stato (pill colorato, editabile inline)
- Menu: "Aggiungi copertina", "Aggiungi a un altro elenco" (**multi-list**), "Sposta attività"
- Pulsanti: "Chiedi all'IA", "Pianifica per un secondo momento" (snooze)
- Short ID visibile (es. `86d14z2mz`)

### 3.2 Campi standard (sempre presenti nel pannello laterale)
1. **Stato** — dropdown con stati della lista
2. **Assegnatari** — multi-user picker con avatar
3. **Date** — start + due + ricorrenza
4. **Priorità** — Urgent / High / Normal / Low (bandierina colorata)
5. **Durata stimata** — ore/minuti
6. **Monitora il tempo** — timer live start/stop, log entries con nota
7. **Tag** — multi-select free-form
8. **Relazioni** — link "blocca / bloccata da / duplicata / riferimento"
9. **Attività secondarie** — subtask inline
10. **Liste di controllo** — checklist annidate con assegnatari per item
11. **Allegati** — drag&drop file / link
12. **Azioni** — automations live (es. "quando stato = Done → sposta in…")

### 3.3 Custom Fields
Pulsante `+ Aggiungi campi` sotto i campi standard. Tipi visti in ClickUp:
- Testo breve, Testo lungo
- Numero, Valuta, Percentuale
- Data
- Select singolo, Select multiplo
- Checkbox, Rating (stelle)
- Email, Telefono, URL
- Persona, Task relation (punta a un'altra task)
- Formula (calcolata)
- File
- **Campo IA** (prompt che si auto-compila con LLM)

### 3.4 Corpo task
- Descrizione rich-text con slash commands (`/` → heading, list, code, embed, task, doc, divider…)
- Sezione commenti (thread + @mention + reazioni + azioni → "crea task da commento")
- Tab "Attività" con timeline di tutte le modifiche

---

## 4. Home ("Le mie attività" — /my-work)

Landing dopo login. Mission-control personale:
- "Buonasera, Federico" (saluto)
- Widget "Porta a termine il lavoro" (task assegnate a me)
- Widget "Non perderti mai un messaggio" (commenti nuovi, @mention)
- Widget "Personalizza in base alle tue esigenze" (configurazione)
- Bucket temporali: Oggi / Questa settimana / Prossima
- Reminder, LineUp (priorità manuali), Attività recenti

> Distinta dalla "Dashboard" che è invece per metriche team.

---

## 5. Planner (/calendar)

Calendar 2.0, attualmente non connesso nel mio workspace:
- Connette Google Calendar / Outlook
- Time-blocking: drag task sul calendario → diventano slot di lavoro
- **Meeting notes con IA**: unisce eventi calendar a note automatiche, action items estratti dall'audio della riunione
- Badge nel rail = eventi/task odierni

---

## 6. IA — ClickUp Brain (/ai/brain)

- **Chiedi** (chat conversazionale sul workspace: cerca task, riassume, scrive)
- **Super Agenti / Autopilot**: agenti autonomi con trigger ("Quando arriva nuovo lead → valuta → rispondi → crea task")
- **Appunti IA** (meeting notes)
- **Campi IA** (custom field auto-compilato con LLM)
- Crediti mostrati in header (`0% Crediti utilizzati`)

---

## 7. Inbox (/inbox)

Tab orizzontali:
1. **Principali** — notifiche prioritarie
2. **Altro** — low priority
3. **Più tardi** — snooze
4. **Cancellate** — archive

Toolbar:
- Filtro per tipo
- "Cancella tutto"

Sorgenti aggregate: In arrivo / Risposte / Commenti assegnati / Le mie attività.

> Differenza vs Home: Home è "cosa devo fare", Inbox è "cosa mi hanno scritto/notificato".

---

## 8. Team Hub (/teams-pulse)

- Panoramica di tutti i team e membri
- "A cosa sta lavorando ogni persona" (real-time)
- "Viste capacità team" → workload + timeline + progress
- Feed azioni in tempo reale (stream di eventi)

Per un freelance singolo: inutile come team, ma il concetto di **feed azioni live** si traduce in "Activity log del mio workspace".

---

## 9. Sidebar workspace (tree)

### 9.1 Elementi osservati
- **Preferiti** — pin manuale di List/Doc/Task/View
- **Spazi** — tree espandibile Space → Folder → List
- **Canali** — chat rooms (simil Slack), Generale, Welcome, + "Aggiungi canale"
- **Messaggi diretti** — chat 1:1 tra membri
- "Aggiungi alla barra laterale" — scorciatoia rapid-pin

### 9.2 Icone e interazioni
- Tree con `treeitem` ARIA
- Ogni riga: caret espandi, nome cliccabile, menu `…` on-hover
- Drag&drop per riordinare
- Bottone + su ogni livello per creare figli

---

## 10. Feature menzionate nel marketing `/features`

Extra non ancora viste in-app ma attivabili:
- **Sprints** (agile)
- **Goals** (obiettivi con target numerico)
- **Milestones** (tappe chiave)
- **Task templates**
- **Custom task types** (Bug, Lead, Invoice ecc.)
- **Sprint points / Epics**
- **Task tray** (minimizza task come chat bubble in basso)
- **Forms** (lead capture → task)
- **Dashboards** (widget builder)
- **Whiteboards** (Excalidraw-like)
- **Docs** (Notion-like wiki)
- **Mind maps**
- **Proofing** (review immagini/PDF con markup)
- **Clip** (screen recording nativo)
- **Automations** (regole if-then per-lista)
- **Workload view**
- **Timesheets** (time tracking aggregato)
- **Recurring tasks**

---

## 11. Pattern UI/UX ricorrenti

### 11.1 Principi di design riconoscibili
1. **Command density + progressive disclosure**: toolbar sempre identica, menu contestuali nascondono il 90% delle feature.
2. **Entità prima, vista dopo**: crei una List (dati), poi aggiungi N viste sopra.
3. **IA ancorata al contesto**: non un chatbot globale ma "chiedi all'IA su *questa* cosa".
4. **Multi-home**: una task può vivere in più liste senza duplicarsi.
5. **Tutto è assegnabile/commentabile**: anche descrizioni, checklist item, colonne, doc.
6. **Short ID globale** per ogni task (facilita copia/paste e link diretti).

### 11.2 Micro-interazioni notevoli
- Keyboard shortcuts onnipresenti (Ctrl+K ricerca, `+` crea task, stati numerici)
- Inline edit su ogni campo (click → edit, no modal)
- Drag&drop ovunque (task tra colonne, date in gantt, tree reorder)
- Auto-save con indicatore discreto
- Cover image per task (Notion-like)
- Quick actions row: hover su riga rivela `assegna | stato | priorità | data | tag`

### 11.3 Scheletri visivi ripetuti
- Pannello laterale destro che scorre la riga (anche su desktop largo)
- Row collassabile per gruppo (Status "To Do: 3 task")
- Pill colorati per ogni stato/priorità
- Avatar cluster "+2" per overflow
- Badge numerico su rail sidebar (Planner "23")

---

## 12. Confronto con il nostro admin (`apps/admin`)

### 12.1 Cosa abbiamo già
| Area | Stato nostro | Equivalente ClickUp |
|---|---|---|
| Dashboard widgets | `pages/dashboard.tsx` + `widget-*.tsx` | Dashboards |
| Kanban | `components/kanban/` + `pages/pipeline.tsx` | Board view |
| Gantt | `components/projects/gantt-chart.tsx` | Gantt view |
| Calendario | `pages/calendario.tsx` (FullCalendar) | Calendar view |
| Task detail | `components/kanban/task-detail-panel.tsx` | Task detail |
| Time tracker | `components/kanban/time-tracker.tsx` | Track time |
| Commenti | `components/kanban/comments-thread.tsx` | Commenti task |
| Milestones | `components/kanban/milestones-timeline.tsx` | Milestones |
| Notes rich-text | `components/notes/tiptap-editor.tsx` | Docs |
| Sketch | `pages/boards/sketch.tsx` (Excalidraw) | Whiteboards |
| Mindmap | `pages/boards/mindmap.tsx` (xyflow) | Mind maps |
| Workflow | `pages/workflows/editor.tsx` (xyflow) | Automations (avanzato) |
| AI sidebar | `components/ai/ai-sidebar.tsx` | Brain global |
| Command palette | `hooks/use-command-palette.ts` | Ctrl+K search |
| Preventivi | `pages/preventivi/*` | Forms + Docs firmabili |
| Clienti / Pipeline / Collaboratori | pagine dedicate | Custom task types |
| Portfolio / Blog | pagine dedicate | Docs hub |
| Fatturazione / Domini / Analytics | strumenti | — |

### 12.2 Gap principali
1. **No view switcher per-progetto** — Kanban/Gantt/Calendario sono pagine scollegate, non tab della stessa entità.
2. **No custom fields / custom entity types** — ogni dominio (cliente, lead, preventivo) ha schema hardcoded.
3. **No multi-list / task relationships** — task vivono in un solo progetto, niente dependencies.
4. **No Home "My Work"** — la Dashboard è metrica, manca la landing operativa personale.
5. **No Inbox unificata** — notifiche sparse, nessun centro notifiche.
6. **No templates** — ogni nuovo progetto si costruisce da zero.
7. **No AI contestuale** — `ai-sidebar.tsx` è globale, non ancorata all'oggetto corrente.
8. **No short-ID task globali** — niente URL tipo `/t/abc123` raggiungibili da qualsiasi punto.
9. **No preferiti / pin sidebar** — la sidebar è statica.
10. **No clip / screen recording** — non presente.
11. **No sottostati/multi-status per stage** — status è probabilmente singolo enum.
12. **No group-by dinamico** nelle pagine lista.
13. **No filter builder AND/OR** multi-condizione.
14. **No quick-actions on hover** sulle righe.
15. **No descrizione/metadata su Lista/Progetto** (owner list, priority list, date list).
16. **No feed attività live** globale tipo Team Hub.
17. **No cover image** sulle entità (cliente, progetto, preventivo).

### 12.3 Feature ClickUp che non ci servono
- Chat/canali Slack-style (overkill per single-operator)
- Messaggi diretti (idem)
- Sprint / Sprint points / Epics (stack agile dev)
- Teams Pulse / Workload team (noi siamo freelance singolo)
- 7 livelli di gerarchia (3 bastano)
- Standup IA / Personal priorities broadcast

---

## 13. Possibili feature da "rubare" — proposta ordinata per ROI

### Tier 1 — impatto alto, sforzo medio (refactor strutturali)
1. **Motore Entità + View Switcher riutilizzabile**
   Componente `<EntityView>` che prende una raccolta e renderizza Kanban/List/Calendar/Gantt/Table con toolbar condivisa (group, sort, filter, search). Da usare per pipeline, progetti, preventivi, clienti, domini.
2. **Task Detail Panel unificato modulare**
   Un solo drawer/pagina che serve task di progetto, lead CRM, voce preventivo, attività cliente. Sezioni collassabili, bottone "Aggiungi campo".
3. **Custom Fields + Custom Entity Types**
   Schema dinamico dei campi per entità. Trasforma "clienti/preventivi/progetti/domini" in istanze di "custom type" dello stesso motore.

### Tier 2 — impatto alto, sforzo basso (quick wins)
4. **Inbox unificata** in topbar: lead nuovi, commenti assegnati, deadline oggi, preventivi firmati, fatture scadute. Già abbiamo `widget-feed.tsx`.
5. **AI contestuale** "Chiedi all'IA su questo [lead / progetto / preventivo]" — il command palette e l'AI sidebar esistono già, serve solo pre-caricare il contesto.
6. **Preferiti / Pin in sidebar** — drag&drop per fissare progetti/clienti attivi.
7. **Short ID globale** per task e entità — routing tipo `/t/{id}` o `/e/{id}` con lookup cross-entity.
8. **Home "My Work"** distinta dalla Dashboard CRM — bucket Oggi / Settimana / Overdue.
9. **Quick actions on hover** sulle righe di lista (assegna, stato, priorità, data).
10. **Filter builder AND/OR** multi-condizione (sostituisce i filtri hardcoded).

### Tier 3 — impatto medio, sforzo medio
11. **Task relationships** (blocca / bloccata da / riferimento)
12. **Multi-list** (una task/cliente appartiene a più raccolte)
13. **Templates di progetto/preventivo** ("Nuovo sito e-commerce" = 20 task precompilate)
14. **Feed attività live** globale (activity log)
15. **Cover image** su entità principali
16. **Descrizione/metadata sulla List stessa** (owner, priority, date)

### Tier 4 — nice to have
17. **Clip / screen recording** integrato
18. **Campi IA** (custom field auto-compilato via LLM)
19. **Proofing** per revisione grafiche/PDF (potrebbe servire per mockup preventivi)
20. **Keyboard shortcuts estesi** (N = new task, T = assign, ecc.)

---

## 14. Screenshot mentali — pattern visivi da replicare

- Rail icone stretto a sinistra con 5-6 voci (Home, Planner, IA, Inbox, Preferiti, Altro)
- Secondo livello sidebar espandibile con tree Space/Folder/List
- Topbar sottile con: workspace switcher, ricerca globale, "Chiedi IA", `+ Crea`, avatar
- Toolbar vista: Gruppo, Ordina, Filtro, Assegnatari, Stato, Cerca, Personalizza
- Task row con: checkbox → status pill → titolo → assegnatari → data → priorità → tag → `…` menu
- Task detail: breadcrumb in alto, metadata destra (stile Notion), body al centro con commenti sotto

---

## 15. Prossimi passi (scrematura)

Questo file è un catalogo. Il passaggio successivo è:

1. **Scremare** (con l'utente) ogni voce dei Tier 1-4 → ✅ tenere / ❌ scartare / ⏸ rimandare.
2. **Prioritizzare** le scelte in una roadmap a 3-4 milestone.
3. **Disegnare** lo schema dati per Entity/CustomField prima di toccare codice.
4. **Refactor incrementale**: iniziare dal componente `<EntityView>` come fondamento, poi task-detail unificato, poi custom fields.

Nessuna azione di implementazione da questo documento finché non si passa alla scrematura.
