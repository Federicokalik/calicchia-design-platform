# Procedura Notifica Data Breach
## Art. 33-34 GDPR

> Ultimo aggiornamento: 19 Marzo 2026

---

## 1. Definizione

Una violazione dei dati personali ("data breach") è una violazione della sicurezza che comporta accidentalmente o in modo illecito la distruzione, la perdita, la modifica, la divulgazione non autorizzata o l'accesso ai dati personali.

## 2. Rilevamento

### Fonti di rilevamento:
- Alert di sicurezza del server/hosting
- Segnalazioni da utenti o clienti
- Log di audit anomali
- Notifiche da sub-responsabili (Cloudflare, Resend, Stripe, ecc.)
- Controlli di routine

### Indicatori di violazione:
- Accessi non autorizzati ai database
- Leak di credenziali
- Malware/ransomware
- Perdita di backup
- Invio email non autorizzato
- Esposizione di dati personali su canali pubblici

## 3. Workflow di gestione

### Fase 1: Contenimento (immediate, entro 1 ora)
- [ ] Identificare la natura e l'ambito della violazione
- [ ] Isolare i sistemi compromessi
- [ ] Cambiare credenziali compromesse
- [ ] Preservare le evidenze (log, screenshot, timestamp)

### Fase 2: Valutazione del rischio (entro 12 ore)
- [ ] Quali dati sono coinvolti? (categoria e volume)
- [ ] Quanti interessati sono coinvolti?
- [ ] La violazione è probabile che presenti un rischio per i diritti e le libertà?
- [ ] I dati erano cifrati o pseudonimizzati?
- [ ] Qual è la gravità potenziale delle conseguenze?

### Matrice di rischio:

| Tipo di dati | Volume | Cifratura | Rischio |
|-------------|--------|-----------|---------|
| Email + nome | < 100 | No | Medio |
| Email + nome | > 100 | No | Alto |
| Dati fatturazione | Qualsiasi | No | Alto |
| Dati anonimizzati | Qualsiasi | - | Basso |
| Password (hashed) | Qualsiasi | bcrypt | Basso |

### Fase 3: Notifica al Garante (entro 72 ore dalla scoperta)
**Se il rischio è medio o alto:**
- [ ] Compilare il modulo di notifica del Garante
- [ ] Inviare tramite PEC: protocollo@pec.gpdp.it
- [ ] Oppure tramite il portale: https://servizi.gpdp.it/databreach/

**Contenuto della notifica (art. 33(3)):**
1. Natura della violazione, categorie e numero di interessati e registrazioni coinvolte
2. Nome e contatti del titolare
3. Conseguenze probabili della violazione
4. Misure adottate o proposte per porvi rimedio

### Fase 4: Notifica agli interessati (se rischio elevato, art. 34)
**Se il rischio è elevato per i diritti e le libertà:**
- [ ] Comunicare la violazione agli interessati coinvolti
- [ ] Descrivere in linguaggio chiaro la natura della violazione
- [ ] Indicare le misure adottate e i consigli per proteggersi
- [ ] Fornire i contatti per ulteriori informazioni

**Non è necessaria la notifica agli interessati se:**
- I dati erano cifrati e la chiave non è stata compromessa
- Sono state adottate misure che rendono improbabile il rischio elevato
- La comunicazione richiederebbe sforzi sproporzionati (in tal caso: comunicazione pubblica)

### Fase 5: Documentazione (entro 7 giorni)
- [ ] Registrare la violazione nel Registro Violazioni
- [ ] Documentare: fatti, effetti, misure correttive
- [ ] Aggiornare le misure di sicurezza se necessario
- [ ] Lezione appresa e azioni preventive

## 4. Registro Violazioni

Ogni violazione, anche se non notificata, deve essere registrata. Utilizzare la tabella seguente:

| Data | Descrizione | Dati coinvolti | N. interessati | Rischio | Notifica Garante | Notifica interessati | Misure adottate |
|------|------------|---------------|---------------|---------|-----------------|---------------------|----------------|
| | | | | | Sì/No | Sì/No | |

## 5. Contatti utili

- **Garante per la Protezione dei Dati Personali**
  - PEC: protocollo@pec.gpdp.it
  - Email: protocollo@gpdp.it
  - Tel: 06 696771
  - Portale breach: https://servizi.gpdp.it/databreach/

- **Titolare del trattamento**
  - Federico Calicchia — federico@calicchia.design — +39 351 777 3467
