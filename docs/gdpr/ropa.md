# Registro dei Trattamenti (ROPA)
## Art. 30 GDPR — Titolare: Federico Calicchia

> Ultimo aggiornamento: 19 Marzo 2026

### Titolare del trattamento
- **Nome**: Federico Calicchia
- **Indirizzo**: Via Scifelli 74, Ceccano 03023 FR
- **P.IVA**: 03160480608
- **Email**: federico@calicchia.design
- **Tel**: +39 351 777 3467

---

| # | Attività di trattamento | Finalità | Base giuridica | Categorie interessati | Categorie dati | Destinatari | Trasferimenti extra-UE | Termine conservazione |
|---|------------------------|----------|----------------|----------------------|---------------|-------------|----------------------|---------------------|
| 1 | Gestione richieste contatto | Rispondere a richieste di informazioni/preventivi | Art. 6(1)(b) — Misure precontrattuali | Potenziali clienti | Nome, email, telefono (opt.), azienda (opt.), messaggio | Resend (email notifica) | USA (SCCs) | 24 mesi |
| 2 | Newsletter | Invio comunicazioni periodiche | Art. 6(1)(a) — Consenso | Iscritti newsletter | Email, nome (opt.) | Resend (invio email) | USA (SCCs) | Fino a disiscrizione |
| 3 | Analytics sito web | Analisi statistiche navigazione | Art. 6(1)(a) — Consenso | Visitatori sito | IP anonimizzato, pagine, browser, referrer | Nessuno (self-hosted) | Nessuno | 26 mesi |
| 4 | Gestione clienti e fatturazione | Erogazione servizi e adempimenti fiscali | Art. 6(1)(b) — Contratto + Art. 6(1)(c) — Obbligo legale | Clienti | Ragione sociale, nome, email, telefono, indirizzo, dati fatturazione | Stripe, PayPal (pagamenti); Consulente fiscale | USA (Stripe SCCs, PayPal DPF) | 10 anni (obbligo fiscale) |
| 5 | Area clienti (portale) | Gestione progetti e deliverable | Art. 6(1)(b) — Contratto | Clienti | Dati progetto, file, comunicazioni | Nessuno (self-hosted) | Nessuno | Durata rapporto + 10 anni |
| 6 | Prenotazione appuntamenti | Gestione calendario appuntamenti | Art. 6(1)(b) — Misure precontrattuali | Potenziali clienti | Nome, email, fascia oraria | Cal.com | USA (SCCs) | 12 mesi |
| 7 | Sicurezza sito (anti-bot) | Protezione form da spam/bot | Art. 6(1)(f) — Interesse legittimo | Visitatori sito | Dati interazione Turnstile | Cloudflare | USA (DPF) | Sessione |
| 8 | Log di sicurezza e audit | Tracciamento accessi e modifiche | Art. 6(1)(f) — Interesse legittimo | Admin, operatori | IP, user-agent, azioni, timestamp | Nessuno (self-hosted) | Nessuno | 365 giorni |
| 9 | Consensi cookie | Registro audit consensi | Art. 6(1)(c) — Obbligo legale | Visitatori sito | IP anonimizzato, preferenze, timestamp | Nessuno (self-hosted) | Nessuno | 12 mesi |
| 10 | Richieste GDPR | Gestione diritti interessati | Art. 6(1)(c) — Obbligo legale | Interessati richiedenti | Nome, email, tipo richiesta | Nessuno | Nessuno | 36 mesi |

---

### Misure di sicurezza (Art. 32 GDPR)

- Cifratura in transito (HTTPS/TLS su tutti gli endpoint)
- Hashing password (bcrypt, 12 rounds)
- Cookie HttpOnly + SameSite=Strict per autenticazione
- Rate limiting su login (5 tentativi / 15 min) e form pubblici
- Protezione anti-bot (Cloudflare Turnstile)
- Row Level Security (RLS) su database
- Audit trail automatico su tabelle sensibili
- Anonimizzazione IP prima dello storage
- Backup periodici con cifratura
- Accesso admin con credenziali individuali

### Sub-responsabili del trattamento

| Fornitore | Servizio | Sede | DPA | Garanzie extra-UE |
|-----------|----------|------|-----|-------------------|
| Cloudflare, Inc. | CDN, DDoS protection, Turnstile | USA | DPA standard Cloudflare | EU-US DPF |
| Resend, Inc. | Email transazionali | USA | Da sottoscrivere | SCCs |
| Stripe, Inc. | Pagamenti | USA | DPA incluso nei ToS | EU-US DPF + SCCs |
| Cal.com, Inc. | Booking appuntamenti | USA | Da sottoscrivere | SCCs |
| PayPal (Europe) S.à r.l. | Pagamenti alternativi | LUX/USA | DPA nei ToS | EU-US DPF |
| Google LLC | Google Maps (footer) | USA | DPA standard Google | EU-US DPF |
