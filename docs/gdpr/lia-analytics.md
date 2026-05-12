# Valutazione di Legittimo Interesse (LIA)
## Per log tecnici e sicurezza

> Art. 6(1)(f) GDPR — Ultimo aggiornamento: 19 Marzo 2026

---

## Trattamento valutato
Raccolta di log tecnici del server (IP, user-agent, timestamp, errori) per finalità di sicurezza e debug.

**Nota:** L'analytics di navigazione (pageview, referrer, ecc.) NON è basato su legittimo interesse ma su **consenso** (art. 6(1)(a)), raccolto tramite cookie banner.

---

## Test 1: Scopo (Purpose Test)

### Qual è l'interesse legittimo perseguito?
- Protezione del sito web da attacchi informatici, DDoS, tentativi di intrusione
- Rilevamento e prevenzione di abusi (brute force login, spam)
- Debug e risoluzione problemi tecnici
- Garanzia di disponibilità del servizio

### L'interesse è legittimo?
**Sì.** La sicurezza informatica e la protezione dei sistemi è riconosciuta come interesse legittimo dal Considerando 49 del GDPR: *"Il trattamento di dati personali nella misura strettamente necessaria e proporzionata alle finalità di garantire la sicurezza della rete e dell'informazione [...] costituisce un legittimo interesse del titolare"*.

---

## Test 2: Necessità (Necessity Test)

### Il trattamento è necessario per perseguire l'interesse?
**Sì.** I log di sicurezza sono indispensabili per:
- Identificare tentativi di accesso non autorizzato
- Bloccare IP malevoli
- Diagnosticare errori del server
- Rispondere a incidenti di sicurezza

### Esistono alternative meno invasive?
- **IP anonimizzato**: Applicato per analytics, ma per i log di sicurezza l'IP completo è necessario temporaneamente per bloccare attacchi in corso
- **Retention breve**: I log vengono conservati per massimo 365 giorni, poi eliminati automaticamente
- **Accesso limitato**: Solo l'admin ha accesso ai log

---

## Test 3: Bilanciamento (Balancing Test)

### Impatto sugli interessati
- **Tipo di dati**: IP e user-agent (dati tecnici, non sensibili)
- **Aspettativa ragionevole**: I visitatori possono ragionevolmente aspettarsi che un sito web registri log tecnici per la sicurezza
- **Vulnerabilità degli interessati**: Nessuna categoria vulnerabile coinvolta
- **Volume**: Limitato ai visitatori del sito

### Il legittimo interesse prevale sui diritti degli interessati?
**Sì.** L'impatto sugli interessati è minimo (solo dati tecnici, conservazione limitata, accesso ristretto), mentre l'interesse alla sicurezza è fondamentale per la protezione del sito e dei dati di tutti gli utenti.

### Misure di mitigazione adottate
- Retention massima di 365 giorni con cancellazione automatica
- Accesso ai log limitato solo all'amministratore
- Log non utilizzati per profilazione o marketing
- Informativa privacy aggiornata con menzione dei log di sicurezza
- Diritto di opposizione disponibile (art. 21 GDPR)

---

## Conclusione

Il trattamento dei log tecnici di sicurezza sulla base del legittimo interesse è **giustificato e proporzionato**. Le misure di mitigazione adottate garantiscono un adeguato bilanciamento con i diritti degli interessati.
