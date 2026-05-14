# {{Brand}} — Pricing Knowledge Base (Privato)

> Template versionato. La copia reale `pricing_knowledge_base.md` è gitignored
> e contiene il listino prezzi reale usato dall'agente LLM di preventivazione.
> NON committare la copia reale.
>
> Carica questo template come `pricing_knowledge_base.md` (stessa cartella) e
> compila le sezioni con i prezzi reali. L'app rifiuta di avviarsi se il file
> reale manca.

---

## 1. Listino Prezzi — <Categoria principale>

### <Prodotto / servizio 1>
- **Prezzo base**: <prezzo>
- **Include**: <inclusioni>
- **Escluso**: <esclusioni>
- **Tempi**: <range giorni>
- **Stack**: <stack tecnologico>

### <Prodotto / servizio 2>
- **Prezzo base**: <prezzo>
- ...

---

## 2. Servizi Aggiuntivi

| Servizio | Prezzo | Note |
|----------|--------|------|
| <Servizio 1> | <prezzo> | <note> |
| <Servizio 2> | <prezzo> | <note> |

---

## 3. Hosting & Manutenzione (Canoni Annuali)

| Piano | Specifiche | Prezzo/anno | Costo reale | Margine |
|-------|-----------|-------------|-------------|---------|
| <Nome piano> | <specs> | <prezzo> | <costo interno> | <margine %> |

Note:
- <Regola su dominio>
- <Regola su rinnovo>

---

## 4. Canoni Mensili — Servizi Ricorrenti

### Struttura costi
| Voce | Costo reale | Al cliente |
|------|------------|------------|
| <Componente infra 1> | <costo> | — |
| <Componente infra 2> | <costo> | — |
| **Totale infrastruttura** | <totale> | — |
| Margine gestione | <margine> | — |
| **Canone al cliente** | — | <prezzo canone> |

### Clausole contrattuali canone
- Durata minima: <N mesi>
- Penale disdetta anticipata: <regola>
- <Altre clausole specifiche>

---

## 5. Grafica — Brochure, Flyer, Logo

### <Tipo prodotto>
- **Prezzo listino**: <prezzo cad.>
- **Prezzo pacchetto** (N+ pezzi): <regola sconto pacchetto>

### Clausole grafica
- <Numero revisioni incluse + costo extra>
- <Regole consegna file>
- <Modalità pagamento (es. solo a consegna)>

---

## 6. Politiche Commerciali

### Sconto pagamento anticipato
- **<percentuale>%** su <ambito> con <condizione>
- Eccezioni: <elencare>

### Sconti speciali
| Livello | Sconto su prezzo base | Esempio |
|---------|----------------------|---------|
| <Livello 1> | <%> | <esempio> |

### Regole di pricing
- <Soglie minime sotto cui non scendere>
- <Strategie di ancoraggio>
- <Servizi "gratuiti" strategici>

### Modalità pagamento standard
1. <Modalità 1>
2. <Modalità 2>

---

## 7. Storico Preventivi Emessi

<Questa sezione vive SOLO nel file reale gitignored — contiene riferimenti
a clienti reali con prezzi e clausole personalizzate.
Non versionata per ragioni di privacy clienti.>

---

## 8. Struttura Standard Preventivo PDF

### Sezioni obbligatorie
1. Copertina
2. Indice
3. Premessa
4. Preventivo dettagliato
5. Opzione consigliata
6. Materiali necessari
7. Modulo selezione + firma
8. Contratto

### Sezioni opzionali
- <Sezioni opzionali tipiche>

### Design PDF
- Generato con: <engine PDF>
- Font: <font>
- Accent color: <#hex>
- Header / footer: <descrizione>

### Contratto standard — N articoli
- Art. 1: Oggetto
- Art. 2: Compenso e modalità pagamento
- Art. 3: Durata
- <...>
- Art. N: Foro competente

---

## 9. Tipi di Preventivo Predefiniti

### <Tipo 1>
Sezioni: <elenco sezioni nel PDF>

### <Tipo 2>
Sezioni: <elenco sezioni nel PDF>

---

## 10. Stack Tecnologico di Riferimento

| Tipo progetto | Stack |
|---------------|-------|
| <Tipologia 1> | <stack> |

---

## 11. Costi Infrastruttura Reali (Riferimento Interno)

<Tabelle dei costi reali sostenuti dal fornitore per VPS, hosting cloud, CDN,
storage, ecc. Utile all'agente LLM per stimare margini e proporre upgrade.>
