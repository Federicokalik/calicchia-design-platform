# Admin Redesign — Piano di implementazione

Branch: `feature/admin-redesign`
Fonte ispirazione: `docs/clickup-research.md`
Stato: **DRAFT — in attesa di approvazione prima di toccare codice**

Feature da implementare:
- **#1** View Switcher per-progetto (motore `<EntityView>`)
- **#2** Task Detail Panel unificato modulare
- **#4** Inbox unificata in topbar
- **#5** AI contestuale ancorata all'entità corrente
- **#8** Home "My Work"
- **#9** Quick actions on hover
- **#WM** Webmail integrata SMTP + IMAP (nuova, su richiesta)

---

## Decisioni architetturali globali

Da validare prima di partire:

1. **Nessun meta-schema dinamico**. Niente Custom Fields runtime. Gli schemi restano espliciti nel codice, i componenti condivisi ma tipizzati per entità.
2. **`<EntityView>` è il componente capostipite**. Tutto il resto (toolbar, quick actions, detail panel) vive come slot/prop di questo.
3. **State condiviso in URL**. `?view=board&group=status&filter=...` così i bookmark funzionano.
4. **Task Detail Panel = drawer laterale**. No modali. Drawer 480-560px a destra sopra la vista, con pagina full `/entity/:type/:id` come fallback.
5. **Inbox e AI contestuale vivono nel layout globale** (`app-layout.tsx`), non dentro le pagine.
6. **Webmail separato in Milestone 4** — non blocca le prime tre milestone.
7. **Pilota su `Progetti`**, poi estensione. Le altre pagine restano invariate finché non tocca il loro turno.
8. **Nessun breaking change ai dati esistenti**. Tutto additivo: nuove tabelle, viste, endpoint, ma gli schemi attuali di clienti/progetti/ecc. non cambiano in M1-M3.

Se uno di questi punti non ti torna, fermiamoci prima di scrivere codice.

---

## Milestone 1 — Fondamenta (3-4 giorni)

### Obiettivo
Rendere la pagina **Progetti** il prototipo di una UI riusabile: un contenitore che mostra la stessa collezione come List / Board / Calendar / Gantt, con toolbar condivisa, quick actions on hover, e un Task Detail Panel modulare.

### File nuovi
```
apps/admin/src/components/entity-view/
├── entity-view.tsx              # componente capostipite
├── entity-view.types.ts         # tipi: EntitySchema, ViewConfig, FilterSpec
├── toolbar.tsx                  # Gruppo | Ordina | Filtro | Cerca | Assegnatari | + Nuovo
├── view-switcher.tsx            # tab List / Board / Calendar / Gantt
├── views/
│   ├── list-view.tsx            # tabella densa con quick actions
│   ├── board-view.tsx           # riusa logica di kanban/ esistente
│   ├── calendar-view.tsx        # FullCalendar
│   └── gantt-view.tsx           # riusa gantt-chart.tsx esistente
├── quick-actions.tsx            # popover stato/assegna/data/priorità
├── group-by-dropdown.tsx
├── filter-panel.tsx             # filtri semplici (non AND/OR)
└── row-hover-actions.tsx

apps/admin/src/components/detail-panel/
├── detail-panel.tsx             # drawer laterale
├── detail-panel.types.ts        # SectionSpec, FieldRenderer
├── sections/
│   ├── section-status.tsx
│   ├── section-assignees.tsx
│   ├── section-dates.tsx
│   ├── section-priority.tsx
│   ├── section-time-tracker.tsx   # wrap di time-tracker.tsx esistente
│   ├── section-tags.tsx
│   ├── section-checklist.tsx
│   ├── section-attachments.tsx
│   ├── section-subtasks.tsx
│   ├── section-comments.tsx       # wrap di comments-thread.tsx esistente
│   └── section-description.tsx    # TipTap
└── detail-panel-header.tsx

apps/admin/src/hooks/
├── use-entity-view-state.ts     # URL sync: view, group, sort, filter, search
└── use-detail-panel.ts          # drawer aperto/chiuso + entità corrente
```

### File modificati
```
apps/admin/src/pages/progetti/detail.tsx   # passa a usare <EntityView> per i task del progetto
apps/admin/src/App.tsx                     # aggiunge rotta /progetti/:id?task=:taskId per deep-link al drawer
apps/admin/src/components/kanban/task-detail-panel.tsx  # deprecato, logica migrata in sections/
```

### Step
1. **Tipi e contratti** (`entity-view.types.ts`, `detail-panel.types.ts`). Definire `EntitySchema<T>` con campi, group-by possibili, sort possibili, view supportate. Non runtime, solo type-level.
2. **`<EntityView>` scheletro**: layout header + toolbar + body + drawer, senza logica. Render degli slot.
3. **URL state hook** (`use-entity-view-state.ts`): leggi/scrivi `view, group, sort, filter, search, assignees` da `URLSearchParams`. Test: manuale via browser back/forward.
4. **Toolbar base**: view switcher + group-by + search + "Crea Task". Le altre voci (filtro, assegnatari) arrivano dopo.
5. **List view**: tabella densa con righe virtualizzate (se > 100). Riga con checkbox, status pill, titolo, assegnatari, data, priorità, tag. Click riga → apre drawer. Hover → row-hover-actions.
6. **Board view**: migrazione di `kanban-board.tsx` dietro l'interfaccia `<EntityView>`. Stesse task, stesso state.
7. **Calendar view**: FullCalendar su start/due dei task. Drag&drop per riprogrammare.
8. **Gantt view**: wrap di `gantt-chart.tsx` esistente.
9. **Quick actions**: popover su hover riga → cambia stato / assegna / data / priorità senza aprire drawer. Ottimistico update + revert su errore.
10. **Detail Panel drawer**: header + sezioni collassabili. Ciascuna sezione è un componente con `{ entity, onUpdate }`. Nessun "God component": il drawer è solo un orchestratore.
11. **Migrazione pagina Progetti dettaglio**: `/progetti/:id` usa `<EntityView entityType="task" query={useProjectTasks(id)} />`. Gantt esistente sparisce come pagina dedicata.
12. **Deep-link drawer**: `/progetti/:id?task=86xyz` apre direttamente il drawer. Chiudere rimuove il query param.

### Acceptance criteria
- [ ] Stessa collezione di task visibile in 4 viste senza ricaricare.
- [ ] `?view=`, `?group=`, `?search=` sopravvivono refresh/share.
- [ ] Hover su riga rivela azioni rapide; click riga apre drawer.
- [ ] Drawer ha 6+ sezioni collassabili, ciascuna indipendente.
- [ ] Nessuna regressione su time-tracker e commenti (wrappati).
- [ ] Pagina Progetti carica in <500ms su 100 task.

### Stima: 3-4 giorni

---

## Milestone 2 — Quick wins (1-2 giorni)

### #4 Inbox unificata in topbar

**Obiettivo**: dropdown globale con aggregazione notifiche: deadline oggi, preventivi in attesa firma, fatture scadute, lead nuovi, commenti assegnati a te.

**File nuovi**
```
apps/admin/src/components/layout/inbox-dropdown.tsx
apps/admin/src/hooks/use-inbox.ts
apps/api/src/routes/inbox.ts        # GET /api/inbox?since=...
```

**File modificati**
```
apps/admin/src/components/layout/topbar.tsx   # aggiunge bell icon con counter
```

**Step**
1. Endpoint `/api/inbox` che aggrega:
   - `deadline_oggi`: task con `due_date <= today AND status != done`
   - `preventivi_firma_pending`: preventivi con `sent_at NOT NULL AND signed_at IS NULL`
   - `fatture_scadute`: invoice con `due_date < today AND paid_at IS NULL`
   - `lead_nuovi`: lead con `created_at > lastRead AND status = 'nuovo'`
   - `commenti_assegnati`: comment con `@mention = currentUser AND read = false`
2. Hook `use-inbox` con polling ogni 60s.
3. Dropdown con tab Principali / Altro, contatore a campanella nella topbar.
4. Click su item → naviga alla pagina relativa.
5. "Segna tutto come letto" → marca last_read_at su user.

**Acceptance**: bell icon in topbar mostra numero esatto di item; click apre dropdown con 5 categorie; counter si azzera dopo "segna letto".

### #5 AI contestuale

**Obiettivo**: quando apro un Lead / Preventivo / Progetto / Cliente, l'AI sidebar può rispondere a domande su *quello specifico oggetto*, non sul workspace generico.

**File modificati**
```
apps/admin/src/components/ai/ai-sidebar.tsx      # accetta prop `context: EntityContext`
apps/admin/src/hooks/use-ai-panel.ts              # store per context corrente
apps/admin/src/components/layout/app-layout.tsx   # legge route, deriva context
apps/api/src/routes/ai.ts                         # arricchisce prompt con context
```

**Step**
1. Tipo `EntityContext = { kind: 'lead'|'preventivo'|'progetto'|'cliente', id: string, summary: string }`.
2. Ogni pagina detail espone un `useEffect(() => setAiContext({...}), [])`.
3. AI sidebar mostra pill "Contesto: Preventivo #123" con X per rimuovere.
4. Backend ai.ts: se context presente, carica l'entità e la iniettano nel system prompt come JSON.

**Acceptance**: su `/preventivi/:id` la sidebar AI capisce "quanti giorni ho per consegnare?" senza spiegazioni; rimozione context ripristina chat globale.

### #7 Bonus gratis — "Copia link"

**File modificato**
```
apps/admin/src/components/shared/page-header.tsx  # aggiunge bottone icona Link
```

Clipboard write dell'URL corrente. 2 ore.

### Stima Milestone 2: 1-2 giorni

---

## Milestone 3 — Home "My Work" (#8) (1-2 giorni)

### Obiettivo
Una route `/oggi` (o tab in `/`) distinta dalla Dashboard CRM. Landing operativa focalizzata sul "cosa faccio oggi".

### File nuovi
```
apps/admin/src/pages/oggi.tsx
apps/admin/src/components/oggi/
├── bucket-today.tsx
├── bucket-week.tsx
├── bucket-overdue.tsx
├── bucket-recontact.tsx
└── reminder-widget.tsx
apps/api/src/routes/my-work.ts    # GET /api/my-work
```

### File modificati
```
apps/admin/src/App.tsx                           # aggiunge rotta /oggi
apps/admin/src/components/layout/sidebar-nav.tsx # aggiunge voce "Oggi" in alto
```

### Step
1. Endpoint `/api/my-work` che restituisce:
   - `today`: task/preventivo/cliente con azione prevista oggi
   - `week`: stesso per settimana in corso
   - `overdue`: in ritardo
   - `recontact`: lead da ricontattare (follow_up_at)
   - `reminders`: lista reminder utente
2. Pagina con 4 bucket. Ogni item è cliccabile → deep-link al detail con drawer aperto (riusa #1).
3. Drag&drop tra bucket per rischedulare (update `due_date` / `follow_up_at`).
4. Voce "Oggi" aggiunta alla sidebar come PRIMA entry (sopra Dashboard).

### Acceptance
- [ ] `/oggi` carica in <300ms.
- [ ] I bucket sono indipendenti e ciascuno ha conteggio.
- [ ] Drag item da "Overdue" a "Today" aggiorna il DB.
- [ ] La voce "Oggi" è evidenziata nella sidebar.

### Stima: 1-2 giorni

---

## Milestone 4 — Webmail integrata (IMAP + SMTP) (5-7 giorni)

### Obiettivo
Permetterti di collegare la tua casella email (via IMAP per ricezione, SMTP per invio) al pannello admin, leggere/scrivere email, e linkare automaticamente i thread ai clienti/lead.

### ⚠ Warning di sicurezza — leggi prima di approvare
1. **Le credenziali vanno cifrate a riposo**. Useremo AES-256-GCM con master key `MAIL_ENC_KEY` (32 byte hex) nel `.env`. Mai in chiaro in DB.
2. **App-specific password** fortemente consigliata rispetto alla password principale (obbligatoria con Gmail/Outlook 2FA).
3. **Mai esporre la password al frontend**. Il decrypt avviene solo nel backend Hono al momento della connessione IMAP/SMTP.
4. **HTML sanitization** dei body (XSS-safe iframe sandbox) prima del render.
5. **Rate limit** sulla sync IMAP per evitare ban dal provider.
6. **Backup `.env`**: se perdi `MAIL_ENC_KEY` i dati in DB diventano inutilizzabili. Documentalo.

### Stack
- `imapflow` (MIT, modern IMAP client con IDLE support)
- `nodemailer` (già standard per SMTP)
- `mailparser` (RFC822 → struttura)
- `sanitize-html` (body sicuro)
- `@isaacs/ttlcache` opzionale per cache body

### Schema DB (nuove tabelle)

```sql
-- Account email configurato
CREATE TABLE email_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text,
  imap_host text NOT NULL,
  imap_port int NOT NULL DEFAULT 993,
  imap_secure boolean NOT NULL DEFAULT true,
  smtp_host text NOT NULL,
  smtp_port int NOT NULL DEFAULT 465,
  smtp_secure boolean NOT NULL DEFAULT true,
  username text NOT NULL,
  password_enc bytea NOT NULL,     -- AES-256-GCM encrypted
  password_iv bytea NOT NULL,
  password_tag bytea NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Cache locale dei messaggi per velocità
CREATE TABLE email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  folder text NOT NULL,           -- INBOX, Sent, Drafts, Trash, [Gmail]/All
  uid int NOT NULL,               -- UID IMAP nella folder
  uidvalidity bigint NOT NULL,
  message_id text,
  thread_id text,
  in_reply_to text,
  from_addr text,
  from_name text,
  to_addrs jsonb,
  cc_addrs jsonb,
  subject text,
  snippet text,
  body_text text,
  body_html text,
  has_attachments boolean DEFAULT false,
  flags text[],                   -- Seen, Flagged, Answered, Draft
  received_at timestamptz,
  synced_at timestamptz DEFAULT now(),
  UNIQUE (account_id, folder, uid)
);

CREATE INDEX ON email_messages (account_id, folder, received_at DESC);
CREATE INDEX ON email_messages (thread_id);
CREATE INDEX ON email_messages USING gin (to_tsvector('italian', coalesce(subject,'') || ' ' || coalesce(snippet,'')));

-- Link email ↔ CRM
CREATE TABLE email_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  entity_type text NOT NULL,     -- 'cliente' | 'lead' | 'preventivo' | 'progetto'
  entity_id uuid NOT NULL,
  auto boolean NOT NULL,          -- true = match automatico by email, false = manuale
  created_at timestamptz DEFAULT now()
);

CREATE INDEX ON email_links (entity_type, entity_id);

-- Allegati (metadata; blob restano su S3/disk)
CREATE TABLE email_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text,
  size_bytes int,
  storage_key text                -- chiave in apps/api storage /media
);
```

### File nuovi — backend (`apps/api`)

```
apps/api/src/routes/mail/
├── accounts.ts           # CRUD account, encrypt/decrypt
├── folders.ts            # GET /api/mail/folders
├── messages.ts           # GET /api/mail/messages, GET /:id, DELETE, PATCH flags
├── send.ts               # POST /api/mail/send
├── sync.ts               # POST /api/mail/sync (manual), cron job sync
└── links.ts              # POST /api/mail/link (email ↔ entity)

apps/api/src/lib/mail/
├── crypto.ts             # AES-256-GCM encrypt/decrypt credentials
├── imap-client.ts        # thin wrapper attorno a imapflow con connection pool
├── smtp-client.ts        # nodemailer wrapper
├── mail-parser.ts        # parse body, extract attachments, sanitize HTML
├── auto-link.ts          # match sender/recipient email → cliente/lead
└── sync-service.ts       # sync incrementale con UIDVALIDITY + UIDNEXT
```

### File nuovi — frontend (`apps/admin`)

```
apps/admin/src/pages/posta/
├── index.tsx                 # 3-pane layout
├── message-list.tsx          # virtualized list
├── message-reader.tsx        # HTML body in iframe sandboxed
├── compose-dialog.tsx        # nuovo messaggio / rispondi / inoltra
├── folder-nav.tsx            # INBOX, Sent, Drafts, Trash + custom
└── account-setup.tsx         # wizard aggiungi account (step IMAP, SMTP, test, salva)

apps/admin/src/pages/impostazioni.tsx   # tab "Posta" già esistente, espansa
apps/admin/src/hooks/use-mail.ts
apps/admin/src/lib/sanitize-email-html.ts
```

### Step di implementazione

**A. Backend foundations (giorno 1-2)**
1. Installa `imapflow`, `nodemailer`, `mailparser`, `sanitize-html`.
2. `lib/mail/crypto.ts`: AES-256-GCM con master key da env. Test con vettori noti.
3. Migration SQL delle 4 tabelle. Run su Supabase self-hosted.
4. `routes/mail/accounts.ts`:
   - `POST /api/mail/account` → valida IMAP+SMTP con test connect, poi salva cifrato.
   - `GET /api/mail/accounts` → ritorna tutto tranne `password_enc` e campi derivati.
   - `DELETE /api/mail/account/:id`.

**B. IMAP sync (giorno 2-3)**
5. `sync-service.ts`: usa `imapflow` per:
   - Lista folder → salva in memoria (non serve tabella).
   - Per folder INBOX: fetch UID list, confronta con `email_messages`, scarica i mancanti.
   - Gestisci `UIDVALIDITY` change → re-sync folder.
   - Parse con `mailparser`, sanitize HTML, salva body_text + body_html.
   - Estrai allegati → salva in `/uploads/mail/<account_id>/<message_id>/<filename>`.
6. `auto-link.ts`: per ogni nuovo messaggio, cerca email `from` e `to` in tabelle `clienti.email` e `leads.email`, crea entry in `email_links` con `auto=true`.
7. `POST /api/mail/sync` endpoint manuale.
8. Cron job (node-cron o BullMQ): sync ogni 5 min per account attivi.

**C. SMTP send (giorno 3-4)**
9. `smtp-client.ts`: `sendMail({ to, cc, bcc, subject, text, html, attachments, replyTo, inReplyTo })`.
10. `POST /api/mail/send`: valida input, decritta password in-memory, invia, salva copia in Sent locale.
11. Supporto "rispondi" con header `In-Reply-To` e `References` per thread corretto.

**D. UI webmail (giorno 4-6)**
12. Wizard setup account in `/impostazioni/posta`: step host/port/tls IMAP → test → step SMTP → test → nickname → salva.
13. Pagina `/posta` con 3-pane:
   - Left: folder list (reads `/api/mail/folders`), contatore unread per folder.
   - Center: virtualized list dei messaggi della folder corrente, ordinata per data DESC. Hover row → quick actions (mark read, star, delete).
   - Right: message reader con iframe sandbox `sandbox="allow-same-origin"` per rendere HTML sicuro. Allegati cliccabili.
14. Compose dialog: TO/CC/BCC autocompletati da clienti/lead, subject, body (plain textarea MVP; TipTap v2).
15. "Rispondi", "Rispondi a tutti", "Inoltra" precompilano i campi giusti.
16. Pulsante "Sincronizza ora" in cima alla lista.

**E. Integrazione CRM (giorno 6-7)**
17. Nel detail page `/clienti/:id` aggiungi tab "Email" che elenca tutti i messaggi linkati al cliente (via `email_links`).
18. Nel detail page `/lead/:id` idem.
19. "Convert email → Lead/Task": bottone nella message-reader che apre un form precompilato.
20. "Rispondi da qui" dal detail cliente/lead: apre compose con `to` precompilato e link automatico.

### Acceptance criteria
- [ ] Wizard setup rifiuta credenziali invalide con messaggio chiaro.
- [ ] Sync iniziale di INBOX (500 msg) completa in <30s.
- [ ] Invio email arriva con header corretti (thread mantenuto).
- [ ] Password mai visibile in response API, mai loggata.
- [ ] HTML email renderizza senza eseguire script o caricare immagini remote di default.
- [ ] Pagina `/clienti/:id` mostra thread email automatico se match.
- [ ] Test con Gmail (app-password), Libero, Aruba, Outlook.

### Stima Milestone 4: 5-7 giorni (la più grossa)

### Scope NON incluso (v2)
- OAuth2 Gmail/M365 (ora solo password)
- IMAP IDLE real-time (ora polling 5 min)
- Firma HTML nel compose
- Regole di filtro in arrivo ("se from = x → etichetta y")
- Template email riutilizzabili
- Mail merge

---

## Rollout order consigliato

```
M1 (3-4 gg) ──┬── M2 (1-2 gg) ──── M3 (1-2 gg) ────────── M4 (5-7 gg)
              │                                              │
              └── Pilota su "Progetti"                       └── Richiede M1 done per integrare in /clienti
```

Parallelismi possibili:
- M2 e M3 possono partire appena M1 ha consolidato il layout globale.
- M4 (backend) può partire in parallelo a M1 se preferisci avanzare su due fronti.

Totale stimato: **10-15 giorni uomo** a seconda di quanto ti incastri.

---

## Rischi e domande aperte

1. **Auth multi-utente?** Il piano assume singolo utente (tu). Se vuoi far usare l'admin a collaboratori con account separati, M4 diventa più complesso (sync per-user).
2. **Dove gira il cron sync IMAP?** Opzioni: (a) `apps/api` con `node-cron`, (b) worker separato, (c) funzione Supabase Edge scheduled. Consiglio (a) per semplicità.
3. **Gantt esistente**: in M1 viene wrappato o riscritto? Consiglio wrap per non perdere nulla.
4. **View Kanban attuale (`components/kanban/`)**: resta a servizio di `/pipeline` dopo M1, o tutto passa a `<EntityView>`? Consiglio: M1 migra Progetti, la Pipeline aspetta M4+ (estensione).
5. **AI contestuale con quale modello?** Usi l'AI sidebar esistente — qual è il provider? Claude, OpenAI, locale? La context injection varia.
6. **Webmail: quanti provider supportare?** MVP = solo IMAP/SMTP standard. Gmail/M365 OAuth in v2.
7. **Backup encryption key**: dove lo tieni? `.env` in produzione + copia offline? Da decidere prima di M4.

---

## Ordine delle tue decisioni

Prima di scrivere una sola riga di codice mi serve il tuo ✅ su:
1. Architettura globale (8 punti sopra) — OK o da cambiare?
2. Rollout order — partire da M1 su Progetti va bene?
3. M4 (webmail) — procedere? Se sì, quale provider usi tu (Gmail/Aruba/Libero/…) così testo subito contro quello reale.
4. Backup `.env` — come vuoi gestire la chiave di cifratura (la generiamo e la salvi tu offline)?
5. Tempi — 10-15 giorni totali ti vanno bene o vuoi tagliare?

Dimmi cosa tieni, cosa cambi, cosa togli. Poi entriamo in implementazione Milestone per Milestone.
