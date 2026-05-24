# GDPR Compliance Checklist — Calicchia Design Platform

> Ultimo aggiornamento: 2026-05-19
> Riferimenti normativi: GDPR (EU 2016/679), Codice Privacy (D.Lgs. 196/2003 mod. D.Lgs. 101/2018), Linee Guida Garante Cookie (luglio 2021), Decisione Garante 330/2025 (double opt-in)

Legenda: ✅ Conforme | ⚠️ Parziale | ❌ Mancante | 🔧 In corso

---

## A. COOKIE & CONSENSO (ePrivacy + GDPR)

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| A1 | Cookie banner con "Accetta" e "Rifiuta" ugualmente visibili | ✅ | CookieBanner.astro — 3 pulsanti equipollenti |
| A2 | Opzioni granulari per categoria (necessari, analitici, marketing) | ✅ | Pannello "Personalizza" con toggle |
| A3 | Blocco tecnico cookie non essenziali prima del consenso | ✅ | Analytics, Google Maps, Trustindex, Cal.com condizionati a consenso. Turnstile è essenziale. Google Fonts self-hosted (nessuna connessione a Google). |
| A4 | Chiusura banner (X) = nessun consenso dato | ✅ | X = solo cookie tecnici |
| A5 | No cookie wall (contenuto accessibile senza consenso) | ✅ | Nessun contenuto bloccato |
| A6 | Re-prompt non prima di 6 mesi dalla scelta | ✅ | Cookie 6 mesi + check timestamp |
| A7 | Revoca consenso facile quanto il conferimento | ✅ | "Gestisci cookie" nel footer |
| A8 | Registro consensi cookie (audit trail) | ✅ | Tabella cookie_consents + endpoint API |
| A9 | Link a cookie policy nel banner | ✅ | Link presente nel banner |
| A10 | Cookie policy con elenco completo cookie | ✅ | Tabelle dettagliate per categoria + terze parti (Google Maps, Trustindex, Cal.com) |

## B. PRIVACY POLICY (Artt. 13-14 GDPR)

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| B1 | Identità e contatti del titolare | ✅ | [nome titolare] + [VAT] + [email titolare] + [telefono titolare] |
| B2 | Finalità e basi giuridiche per ogni trattamento | ✅ | Tabella completa nella sezione 3 |
| B3 | Categorie di dati raccolti | ✅ | Sezione 2 dettagliata |
| B4 | Destinatari / categorie destinatari | ✅ | Sezione 7 + tabella sub-responsabili |
| B5 | Trasferimenti extra-UE e garanzie | ✅ | Sezione 9 — DPF + SCCs |
| B6 | Periodi di conservazione per ogni categoria | ✅ | Tabella nella sezione 6 |
| B7 | Diritti dell'interessato (artt. 15-22) | ✅ | Sezione 11 dettagliata |
| B8 | Diritto di revoca consenso | ✅ | Sezione 11 |
| B9 | Diritto di reclamo al Garante con contatti | ✅ | Sezione 12 con indirizzo/email/PEC/sito |
| B10 | Se il conferimento dati è obbligatorio/volontario | ✅ | Sezione 4 |
| B11 | Decisioni automatizzate / profilazione | ✅ | Sezione 10 — dichiarazione assenza |
| B12 | Accessibile da ogni pagina del sito | ✅ | Link nel footer |
| B13 | In lingua italiana | ✅ | |
| B14 | Aggiornamento con tutti i sub-responsabili attuali | ✅ | Cloudflare, Resend, Stripe, Cal.com, PayPal, Google, Trustindex |

## C. FORM DI CONTATTO (Art. 6(1)(b) GDPR)

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| C1 | Informativa breve visibile al punto di raccolta | ✅ | Testo inline con base giuridica e retention |
| C2 | Checkbox GDPR obbligatoria (non pre-selezionata) | ✅ | Implementata in tutti e 3 i form |
| C3 | Link alla privacy policy | ✅ | Link a /privacy-policy |
| C4 | Minimizzazione dati (solo campi necessari) | ✅ | Telefono/azienda opzionali, IP non salvato |
| C5 | Periodo conservazione definito e implementato | ✅ | 24 mesi, funzione purge_old_contacts() |
| C6 | Possibilità di cancellazione su richiesta | ✅ | Endpoint /gdpr-requests/erase + pagina pubblica |

## D. NEWSLETTER (Consenso esplicito + Decisione Garante 330/2025)

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| D1 | Double opt-in | ✅ | Implementato con confirmation_token |
| D2 | Consenso separato (non accorpato ad altri consensi) | ✅ | Form dedicato |
| D3 | Link unsubscribe in ogni email | ✅ | sendNewsletterEmail() con footer unsubscribe |
| D4 | Prova del consenso (timestamp, IP, versione policy) | ✅ | Timestamp + IP + user-agent al subscribe e al confirm (migration 103, 2026-05-24) |
| D5 | Informativa al punto di iscrizione | ✅ | Testo sotto SubscribeForm |
| D6 | Link privacy policy sul form di iscrizione | ✅ | Link a /privacy-policy |

## E. ANALYTICS & TRACCIAMENTO

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| E1 | Consenso preventivo per analytics non essenziali | ✅ | Condizionato a cookie_consent.analytics |
| E2 | IP anonimizzato o pseudonimizzato | ✅ | Ultimo ottetto azzerato (anonymizeIp) |
| E3 | Periodo di conservazione definito e implementato | ✅ | 26 mesi, purge_old_analytics() |
| E4 | Informativa privacy copre analytics self-hosted | ✅ | Sezione 3 e cookie policy sezione 2.3 |
| E5 | Nessun tracking cross-site | ✅ | Analytics solo first-party |

## F. ADMIN PANEL & SICUREZZA

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| F1 | Account individuali (no credenziali condivise) | ✅ | JWT per utente |
| F2 | Hashing password robusto | ✅ | bcrypt 12 rounds |
| F3 | Cookie HttpOnly + SameSite | ✅ | auth_token HttpOnly SameSite=Strict |
| F4 | Rate limiting login | ✅ | 5 tentativi / 15 min |
| F5 | Audit trail accessi e modifiche dati | ✅ | Migration 012 audit_logging |
| F6 | MFA / 2FA | ⚠️ | Non implementato (raccomandato per futuro) |
| F7 | Timeout sessione per inattività | ✅ | 30 min timeout via last_activity check |
| F8 | HTTPS obbligatorio | ✅ | HSTS header in produzione |
| F9 | Principio del minimo privilegio | ⚠️ | Solo ruolo admin, no granularità (accettabile per freelancer) |
| F10 | Security headers | ✅ | X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy |

## G. DIRITTI DELL'INTERESSATO (Artt. 15-22)

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| G1 | Meccanismo per richieste (email/form dedicato) | ✅ | Pagina /privacy-request + endpoint API |
| G2 | Risposta entro 30 giorni | ✅ | Email notifica admin con reminder |
| G3 | Diritto di accesso (export dati personali) | ✅ | Endpoint /gdpr-requests/export/:email |
| G4 | Diritto di rettifica | ✅ | Via form o email + gestione admin |
| G5 | Diritto di cancellazione (oblio) | ✅ | Endpoint /gdpr-requests/erase/:email — elimina contacts/newsletter/preferenze/WhatsApp/portal_login_events e **anonimizza** customers/leads (fatture e pagamenti collegati restano per obbligo fiscale 10 anni) |
| G6 | Diritto alla portabilità (CSV/JSON) | ✅ | Export in JSON + export admin CSV |
| G7 | Diritto di opposizione | ✅ | Via form privacy-request |
| G8 | Diritto di limitazione del trattamento | ✅ | Via form privacy-request |

## H. AREA CLIENTI / FREELANCER OS

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| H1 | Base giuridica contrattuale documentata | ✅ | gdpr.legal_basis in risposta login portale |
| H2 | DPA con clienti (se si trattano dati per conto loro) | ⚠️ | Template DPA disponibile in docs/gdpr/ |
| H3 | Accesso limitato ai propri dati | ✅ | JWT portalAuth + query filtrate per customer_id |
| H4 | Conservazione dati definita | ✅ | 10 anni (obbligo fiscale) documentato in privacy policy |
| H5 | Cancellazione post-termine rapporto | ⚠️ | Da implementare workflow (dopo 10 anni) |

## I. TERZE PARTI & DPA

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| I1 | DPA con hosting provider | ⚠️ | Da sottoscrivere (vedi docs/gdpr/dpa-template.md) |
| I2 | DPA con Supabase | ⚠️ | Self-hosted — DPA non necessario se gestito internamente |
| I3 | DPA con Cloudflare | ⚠️ | DPA standard disponibile, da accettare su dashboard |
| I4 | DPA con Resend (email) | ⚠️ | Da sottoscrivere |
| I5 | DPA con Stripe | ✅ | Incluso nei ToS |
| I6 | DPA con Cal.com | ⚠️ | Da sottoscrivere |
| I7 | DPA con PayPal | ✅ | Incluso nei ToS |
| I8 | Documentazione trasferimenti extra-UE | ✅ | Privacy policy sezione 9 |
| I9 | Elenco sub-responsabili aggiornato | ✅ | Privacy policy sezione 8 + ROPA |

## J. DOCUMENTAZIONE & PROCESSI

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| J1 | Registro dei trattamenti (ROPA) | ✅ | docs/gdpr/ropa.md |
| J2 | Procedura notifica data breach (72h) | ✅ | docs/gdpr/data-breach-procedure.md |
| J3 | Registro interno violazioni | ✅ | Template in data-breach-procedure.md |
| J4 | Valutazione legittimo interesse (LIA) per log | ✅ | docs/gdpr/lia-analytics.md |
| J5 | DPIA per trattamenti ad alto rischio | ✅ | Non necessaria per freelancer (confermato) |
| J6 | Policy di retention dati con job automatici | ✅ | Funzioni DB (migrazioni 038/084) eseguite dal cron `data-retention` (giornaliero, ore 5) — `run_data_retention()` + `cleanup_webhook_security_retention()` |
| J7 | Procedura gestione richieste interessati | ✅ | Endpoint API + pagina pubblica + notifica admin |

## L. WHATSAPP (GOWA gateway) — Canale comunicazione (introdotto 2026-05-19)

Tre categorie con basi giuridiche distinte, gestite via tabella `communication_preferences`
(migration 096). Ogni outbound passa per `canSendWhatsApp()` in `apps/api/src/lib/whatsapp-policy.ts`.

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| L1 | Categoria **Transazionale** — base Art. 6(1)(b) | ✅ | Fatture, scadenze fiscali, avvisi di sicurezza. NON disattivabile dal cliente. |
| L2 | Categoria **Operativa** — base Art. 6(1)(f) | ✅ | Reminder appuntamenti, follow-up progetti. Default ON con **opt-out** granulare lato portale (`/clienti/preferenze`). |
| L3 | Categoria **Marketing** — base Art. 6(1)(a) | ✅ | Default OFF, richiede **opt-in esplicito** dall'area clienti o token link. |
| L4 | Opt-out via portale autenticato | ✅ | Pagina `/clienti/preferenze` (PATCH `/api/portal/preferences`). Transazionale read-only. |
| L5 | Opt-out via token pubblico (no login) | ✅ | `/preferenze/<token>` con `preferences_token` 24-byte HMAC-rotabile, rate-limited 20 req/min. |
| L6 | Opt-out via reply "STOP" | ✅ | Webhook GOWA intercetta "STOP" / "STOP MARKETING" e aggiorna preferences con `updated_via='wa-stop'`. Auto-reply di conferma. |
| L7 | Cifratura comunicazione GOWA ↔ api | ✅ | HTTPS + HMAC SHA256 (`x-hmac-signature`) sul webhook con `GOWA_WEBHOOK_SECRET`, constant-time compare. |
| L8 | Audit trail outbound | ✅ | Tabella `whatsapp_messages` con `sender_kind` + `sender_user_id`. Cambi di `ai_mode` loggati. |
| L9 | Retention messaggi | ✅ | Transactional: 10 anni (allineato obblighi fiscali). Operational: cancellabili a opt-out + GDPR erasure. Marketing: cancellabili a opt-out. |
| L10 | Export GDPR include WhatsApp | ✅ | `/api/gdpr-requests/export/:email` ritorna `whatsapp_conversations`, `whatsapp_messages`, `communication_preferences`. |
| L11 | Erasure GDPR include WhatsApp | ✅ | `/api/gdpr-requests/erase/:email` cancella in cascata conversazioni + messaggi + preferences linkate al customer/lead. |
| L12 | AI inbound (auto-reply/triage) trasparenza | ✅ | Messaggi inviati da AI loggati con `sender_kind='ai'`. Modalità per conversazione (`ai_mode`) modificabile dall'admin. Triage richiede approvazione umana esplicita. |
| L13 | Base giuridica AI processing | ✅ | Art. 6(1)(f) per triage interno. Nessuna decisione automatizzata che produce effetti giuridici (Art. 22 non applicabile — solo bozze di risposta). |
| L14 | Sub-responsabile WhatsApp | ✅ | Meta Platforms Ireland Ltd. / WhatsApp LLC aggiunti alla privacy policy sez. 2 (dati), 3 (basi giuridiche per categoria), 6 (retention), 8 (destinatari), 9 (extra-UE/DPF). Commit 2026-05-24. |
| L15 | DPA con GOWA | ✅ | Self-hosted su VPS proprio (gowa.calicchia.design) — nessun sub-responsabile esterno per il gateway. |
| L16 | Informativa al primo contatto WA | 🔧 | Da aggiungere al primo template "first contact" outbound: indicazione su come gestire preferenze e diritto di opt-out. |

## K. PORTALE / SEZIONE PUBBLICA

| # | Requisito | Stato | Note |
|---|-----------|-------|------|
| K1 | Pagina termini e condizioni | ✅ | 18 sezioni — uso del sito, preventivi, prezzi, IP, hosting, privacy ref, garanzia, recesso, diritti consumatore (14gg + ODR EU), foro. Commit 2026-05-24. |
| K2 | Pagina cookie policy | ✅ | Aggiornata e completa |
| K3 | Pagina privacy policy | ✅ | Aggiornata e completa |
| K4 | Footer con link legali su tutte le pagine | ✅ | Privacy, Cookie Policy, Gestisci Cookie |
| K5 | Informativa breve su ogni form | ✅ | Contatto, newsletter, richieste privacy |

---

## Riepilogo

| Categoria | ✅ | ⚠️ | ❌ | Totale |
|-----------|----|----|----|----|
| A. Cookie & Consenso | 10 | 0 | 0 | 10 |
| B. Privacy Policy | 14 | 0 | 0 | 14 |
| C. Form di Contatto | 6 | 0 | 0 | 6 |
| D. Newsletter | 6 | 0 | 0 | 6 |
| E. Analytics | 5 | 0 | 0 | 5 |
| F. Admin & Sicurezza | 8 | 2 | 0 | 10 |
| G. Diritti Interessato | 8 | 0 | 0 | 8 |
| H. Area Clienti | 3 | 2 | 0 | 5 |
| I. Terze Parti & DPA | 4 | 5 | 0 | 9 |
| J. Documentazione | 7 | 0 | 0 | 7 |
| K. Portale Pubblico | 5 | 0 | 0 | 5 |
| L. WhatsApp (GOWA) | 15 | 0 | 0 | 15 (L16 🔧 in corso, conteggio nei ✅ una volta committato) |
| **TOTALE** | **91** | **10** | **0** | **101** |

**Conformità: ~90% (91/101 pienamente conformi)**
**Nessun requisito mancante (❌ = 0)**

### Elementi ⚠️ rimanenti (azioni manuali richieste):
1. **F6**: Implementare MFA (raccomandato, non obbligatorio) — schema in migration 102, codice/UI da implementare
2. **F9**: Granularità ruoli (accettabile per freelancer)
3. **H2/H5**: DPA clienti e workflow cancellazione post-10-anni
4. **I1/I3/I4/I6**: Sottoscrivere DPA con hosting, Cloudflare, Resend, Cal.com
5. **L16**: Creare template "first contact" WA con disclaimer preferenze (in corso)

### Chiusi nella sessione 2026-05-24:
- **D4**: log IP/UA subscribe + confirm newsletter (migration 103)
- **L14**: Meta/WhatsApp in privacy policy sez. 2/3/6/8/9
- **K1**: T&C completi a 18 sezioni con diritti consumatore + ODR EU

---

## Procedura — verifica identità per richieste di accesso/cancellazione (GDPR-04)

Gli endpoint `GET /api/gdpr-requests/export/:email` e `DELETE /api/gdpr-requests/erase/:email`
operano **per indirizzo email** e sono protetti da `authMiddleware` — solo un admin
autenticato può invocarli. Non eseguono di per sé alcuna verifica dell'identità
dell'interessato: spetta all'admin verificarla **prima** di eseguire export o erase.

Procedura obbligatoria prima di evadere una richiesta (art. 12(6) GDPR — in caso di
dubbio ragionevole sull'identità si possono chiedere informazioni aggiuntive):

1. **Match del canale.** La richiesta deve arrivare dall'indirizzo email oggetto
   della richiesta stessa, oppure da un canale già associato a quell'interessato
   (es. email del cliente già nel gestionale).
2. **In caso di dubbio**, rispondere all'indirizzo email *registrato* (non a quello
   indicato nella richiesta) chiedendo conferma — così la conferma arriva solo a
   chi controlla davvero la casella.
3. **Per richieste ad alto impatto** (erasure di un cliente con storico), richiedere
   un elemento di riscontro non pubblico (es. numero di un preventivo/fattura,
   ultimo progetto) prima di procedere.
4. **Tracciare** la richiesta e la verifica effettuata nel record `gdpr_requests`
   (campo `admin_notes`) prima di impostare lo stato `completed`.
5. Solo dopo la verifica, eseguire export/erase dall'area admin.

Termine di risposta: 30 giorni (art. 12(3)).
