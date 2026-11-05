# Proforma come documento proprio (Fase 2): design

> Stato: **proposta**. Nessuna riga di questo documento è implementata: va confermata prima di procedere.
> Prerequisiti già fatti nella Fase 1: allegati email con riferimenti interni (`lib/mail/attachments.ts`), invio da casella con copia in Inviati (`lib/mail/outbound.ts`), `customers.billing_emails` con `billingRecipients()`, validazione dei domini.

## 1. Obiettivo

Un documento **proforma** distinto dalle fatture, con:

- numerazione separata `PF n/anno`, sequenza annuale, assegnazione sotto lock;
- importi in regime forfettario: niente IVA, dicitura art. 1 c. 54-89 L. 190/2014, rivalsa del bollo da 2 € sopra 77,47 €, "documento non valido ai fini fiscali";
- PDF generato server-side con il template del brand;
- conversione in fattura al pagamento;
- flusso di rinnovo dominio: dal dominio in scadenza si genera la proforma, che si invia con il PDF allegato a `billing_emails` e resta collegata al dominio. Il pagamento aggiorna la scadenza.

Fuori perimetro: incasso online della proforma (link Stripe/PayPal: si può aggiungere dopo riusando `public-pay`), invio SDI della fattura (resta il flusso XML attuale).

## 2. Modello dati (migrazione 168, reversibile con `down/168_*.down.sql`)

### 2.1 `proformas`

| Colonna | Tipo | Note |
|---|---|---|
| `id` | uuid PK | |
| `year` | int | anno di **emissione**, NULL in bozza |
| `seq` | int | progressivo nell'anno, NULL in bozza |
| `number` | text GENERATED (`'PF ' \|\| seq \|\| '/' \|\| year`) | `UNIQUE (year, seq)` |
| `status` | text | `draft` → `issued` → `sent` → `paid` → `converted`; `cancelled` da draft/issued/sent |
| `customer_id` | uuid FK customers (RESTRICT) | |
| `customer_snapshot` | jsonb | nome, ragione sociale, billing_address, P.IVA/CF, billing_emails **al momento dell'emissione**: il PDF emesso non cambia se cambia l'anagrafica |
| `issue_date`, `due_date` | date | `due_date` default `issue_date + 15` |
| `line_items` | jsonb | `[{kind: 'service'\|'domain_renewal'\|'stamp_duty', description, quantity, unit_price_cents, amount_cents, domain_id?, years?}]` |
| `subtotal_cents`, `stamp_duty_cents`, `total_cents` | int | importi in centesimi, niente float |
| `currency` | text | `EUR` |
| `regime` | text | snapshot di `freelancer.studio.vat_regime` |
| `legal_notes` | text | snapshot delle diciture (§3.2) |
| `pdf_path`, `pdf_sha256`, `pdf_generated_at` | | file nella categoria privata `proformas` |
| `sent_at`, `sent_to text[]`, `sent_message_id` | | ultimo invio |
| `paid_at`, `payment_method`, `paid_amount_cents` | | |
| `converted_invoice_id` | uuid FK invoices (SET NULL), UNIQUE | idempotenza della conversione |
| `domain_id` | uuid FK domains (SET NULL) | collegamento al rinnovo (anche in `line_items`) |
| `notes`, `metadata`, `created_at`, `updated_at` | | |

Vincoli: `CHECK ((status = 'draft') = (seq IS NULL))`, `CHECK (total_cents = subtotal_cents + stamp_duty_cents)`, indice parziale per le proforma aperte di un dominio (`domain_id WHERE status IN ('issued','sent')`) per evitarne due attive sullo stesso rinnovo.

### 2.2 Numerazione `PF n/anno` con lock

Tabella dedicata `document_sequences (kind text, year int, last_number int, PRIMARY KEY (kind, year))`. Non riuso `invoice_numbering`: ha `CHECK (type IN ('invoice','quote'))`, un formato fisso `PREFISSO-ANNO-0001` e l'anno preso da `CURRENT_DATE`, mentre qui conta l'anno della data di emissione.

```sql
-- dentro la transazione di emissione
INSERT INTO document_sequences (kind, year, last_number) VALUES ('proforma', $year, 0)
  ON CONFLICT DO NOTHING;
UPDATE document_sequences SET last_number = last_number + 1
  WHERE kind = 'proforma' AND year = $year
  RETURNING last_number;          -- lock di riga: le emissioni concorrenti si serializzano
UPDATE proformas SET year = $year, seq = $n, status = 'issued', ... WHERE id = $id AND status = 'draft';
```

- Il numero si assegna all'**emissione**, non alla creazione: le bozze scartate non bruciano numeri. Numero e cambio di stato stanno nella stessa transazione, quindi un rollback non lascia buchi.
- Una proforma annullata tiene il suo numero (stato `cancelled`) e il numero non si riusa.
- Test: 20 emissioni concorrenti (`Promise.all`) producono 1..20 senza duplicati né buchi; cambio d'anno; rollback a metà.

## 3. Importi e diciture (forfettario)

### 3.1 Calcolo (`lib/proforma/totals.ts`, funzione pura)

- `tax_rate = 0`, nessuna riga IVA.
- `subtotal = Σ amount` delle righe `service` e `domain_renewal`.
- **Bollo**: se `regime = forfettario` e `subtotal > soglia_bollo` (77,47 € da `quote.settings.soglia_bollo`, che esiste già), si aggiunge la riga `stamp_duty` di `importo_bollo` (2,00 €) come "Rivalsa imposta di bollo". La soglia è strettamente maggiore: 77,47 € esatti non lo fanno scattare. Bollo assolto in modo virtuale sulla fattura.
- `total = subtotal + stamp_duty`, tutto in centesimi.
- Test a tabella: 77,46 / 77,47 / 77,48, righe multiple, quantità decimali, arrotondamenti.

### 3.2 Diciture (snapshot in `legal_notes`)

1. `quote.settings.nota_iva` (default già presente: "Regime forfettario ai sensi dell'art. 1, commi 54–89, L. 190/2014 … Operazione senza applicazione IVA ex art. 1, comma 58 …").
2. Se c'è bollo: `quote.settings.marca_bollo_nota`.
3. Fissa: **"Documento non valido ai fini fiscali. La fattura sarà emessa al ricevimento del pagamento."**

## 4. PDF server-side

- `lib/pdf/render.ts`: estrae da `lib/quote-pdf.ts` la parte Puppeteer (`htmlToPdf(html) → Buffer`). `generateQuotePdf` la riusa, quindi i preventivi non cambiano comportamento.
- `lib/proforma/render.ts`: HTML con lo stesso layout editoriale dei preventivi (`templates/_layout.ts`, colori e logo da `quote.settings`): intestazione del fornitore, anagrafica dal `customer_snapshot`, righe, totali, IBAN da `billing.bank_accounts` (default), causale "Saldo proforma PF n/anno", diciture.
- Salvataggio in `PRIVATE_UPLOAD_DIR/proformas/` (nuova `PRIVATE_CATEGORIES`) con SHA-256. Il PDF di una proforma emessa è immutabile: rigenerarlo crea un nuovo file e aggiorna l'hash, ma solo se cambiano le note interne. Gli importi non si toccano dopo l'emissione.
- Fatture: lo stesso `htmlToPdf` darà più avanti `GET /api/invoices/:id/pdf` (oggi le fatture non hanno PDF). Lo segnalo, ma non è nel perimetro.

## 5. API

| Metodo e path | Cosa fa | Rischio MCP |
|---|---|---|
| `GET /api/proformas` | elenco con filtri (status, customer_id, domain_id, anno) | low |
| `GET /api/proformas/:id` | dettaglio con URL firmato del PDF | low |
| `POST /api/proformas` | crea la bozza (`customer_id`, `line_items`, `due_days?`, `notes?`), schema strict | medium |
| `PATCH /api/proformas/:id` | modifica, solo in `draft` | medium |
| `POST /api/proformas/:id/issue` | numera (§2.2), snapshot, PDF | medium |
| `GET /api/proformas/:id/pdf` | scarica il PDF (admin) | low |
| `POST /api/proformas/:id/send` | invio con il PDF allegato lato server (§6) | **high** (OTP) |
| `POST /api/proformas/:id/draft-email` | bozza email con il PDF allegato, da rivedere in Posta | medium |
| `POST /api/proformas/:id/mark-paid` | pagamento, conversione in fattura, rinnovo dominio (§7) | **high** (OTP) |
| `POST /api/proformas/:id/cancel` | annulla | high |
| `POST /api/domains/:id/proforma` | proforma di rinnovo da un dominio (§8) | medium |

Tool MCP: `create_domain_renewal_proforma`, `send_proforma`, `mark_proforma_paid`, `list_proformas`. Prendono id, non base64: il PDF non passa mai dalla conversazione.

## 6. Invio

- I destinatari di default sono `billingRecipients(customer)`, cioè `billing_emails` oppure `email`. Si possono sovrascrivere con `to` nel body, sempre validato.
- Oggetto e testo di default da template (`Proforma PF 3/2026 – rinnovo dominio crimatek.com`), sovrascrivibili.
- L'allegato si risolve **lato server** dal `pdf_path` della proforma: lo stesso `ResolvedAttachment` di `lib/mail/attachments.ts`, senza base64 né URL nella richiesta.
- Si usa `sendFromAccount()`, quindi la copia va in Inviati con l'allegato. Poi stato `sent`, `sent_to`, `sent_message_id`, e un link in `email_links` verso il cliente (entity `cliente`).
- Se la consegna SMTP fallisce, la proforma resta `issued` e la risposta è 502 con il motivo. Se fallisce solo la copia in Inviati, la proforma passa comunque a `sent` con un `warning`.

## 7. Pagamento e conversione in fattura

`POST /api/proformas/:id/mark-paid { paid_at, payment_method, amount? }`, in **una transazione**:

1. `SELECT … FOR UPDATE` sulla proforma. Se è già `converted` restituisce la fattura esistente (idempotente).
2. Crea la fattura: `invoice_number` da `generate_document_number('invoice')`, `line_items` copiate (la riga del bollo resta come rivalsa), `tax_rate = 0`, `source = 'proforma'`, `metadata.proforma_id`, stato `paid` con `paid_at`.
3. `converted_invoice_id` e stato `converted`.
4. Per ogni riga `domain_renewal`: `renewDomain(domain_id, years, cost, invoice_id)` (§8.2).
5. Il commit avviene dopo; fuori dalla transazione, la notifica interna.

Da verificare insieme: `lib/sdi/xml.ts` oggi **non scrive `DatiBollo`**, quindi una fattura forfettaria sopra 77,47 € esce senza `BolloVirtuale=SI / ImportoBollo=2.00`. La conversione renderebbe il caso frequente: propongo di correggerlo nella stessa fase.

## 8. Flusso rinnovo dominio

### 8.1 Dal dominio alla proforma

`POST /api/domains/:id/proforma { years = 1, unit_price?, due_days = 15, delivery: 'none' | 'draft' | 'send' }`:

- prezzo = `unit_price` oppure `domains.renewal_cost` (400 se mancano entrambi);
- riga: "Rinnovo dominio crimatek.com – 1 anno (scadenza 01/12/2026 → 01/12/2027)";
- crea ed emette la proforma, genera il PDF, `domain_id` collegato;
- `delivery = 'draft'` crea una bozza in Posta con il PDF allegato; `send` la invia subito (OTP via MCP);
- 409 se esiste già una proforma `issued`/`sent` per lo stesso dominio, con il suo numero nella risposta.

In admin, sulla riga del dominio: azione "Genera proforma rinnovo" e badge "PF 3/2026 inviata, in attesa di pagamento".

### 8.2 `/renew` e la scadenza

- `lib/domains/renew.ts` (`renewDomain`) diventa l'unica logica di rinnovo. La usano `POST /api/domains/:id/renew` (manuale) e la conversione della proforma (§7).
- Correzioni alla `/renew` attuale:
  - `years` non è validato;
  - la data è calcolata in JS con `Date` e `toISOString()`: il risultato dipende dal fuso del processo (oggi il container gira in UTC, ma basta un `TZ=Europe/Rome` per spostare la scadenza di un giorno);
  - `domain_renewals.invoice_id` non viene mai valorizzato;
  - un dominio già scaduto viene rinnovato dalla vecchia scadenza invece che da oggi. La funzione SQL `renew_domain()` della 006 gestiva il caso, ma non è usata.
  
  Il calcolo passa a SQL (`expiration_date + make_interval(years => n)`) dentro la transazione.
- Il cron `domain-alerts` non invia il promemoria al cliente se il dominio ha una proforma `sent` non pagata: c'è già una richiesta di pagamento in corso. Il digest Telegram la mostra comunque.

## 9. `tax_rate: 22.00` di default sulle fatture

### 9.1 Da dove nasce

| Origine | Dove |
|---|---|
| `invoices.tax_rate DECIMAL(5,2) DEFAULT 22.00` | `database/migrations/010_invoicing.sql:138`: è il default che vedi nelle bozze |
| `quotes.tax_rate DEFAULT 22.00` e trigger `COALESCE(NEW.tax_rate, 22)` | `010_invoicing.sql:87, 343` (preventivi v1) |
| `quotes_v2.tax_rate DEFAULT 22` | `048_quotes_v2.sql:15` |
| `billing.defaults.default_tax_rate` default `22` | `apps/api/src/lib/settings-schema.ts:65` |
| `tax_rate ?? 22` | `routes/quotes-v2.ts:273, 397`; `routes/quotes.ts:475, 496, 565` |

Percorsi che creano fatture **senza** impostare `tax_rate`, quindi con il default 22:

- `POST /api/invoices` (spread del body);
- `POST /api/client-projects/:id/…` (fattura da milestone): calcola `tax = 0` per il forfettario ma lascia `tax_rate = 22`. Il dato è incoerente, perché aliquota e imposta si contraddicono;
- `routes/stripe-webhook.ts` (fatture Stripe).

L'XML SDI usa comunque `AliquotaIVA 0.00` + `Natura N2.2` (`lib/sdi/xml.ts:175, 300`), quindi i file inviati sono corretti. Sbagliati sono il dato e quello che mostrano UI e portale.

### 9.2 Fix proposto

1. `lib/tax/default-rate.ts`: `defaultTaxRate()` letto da `freelancer.studio.vat_regime`. `forfettario`/`none` → `0`; `ordinario` → `billing.defaults.default_tax_rate`. È l'unica fonte e la usano invoices, client-projects, stripe-webhook, quotes e quotes-v2 al posto dei `?? 22`.
2. Migrazione: `ALTER TABLE invoices ALTER COLUMN tax_rate SET DEFAULT 0`, idem su `quotes_v2` e `quotes`. Il trigger della 010 passa a `COALESCE(NEW.tax_rate, 0)`. Il default di `billing.defaults.default_tax_rate` va a `0` solo se il regime è forfettario: lo schema resta 22 per l'ordinario, ma conta solo nel ramo ordinario.
3. Correzione dati, con conteggio mostrato prima di applicarla: `UPDATE invoices SET tax_rate = 0 WHERE status = 'draft' AND tax_rate = 22 AND COALESCE(tax, 0) = 0 AND COALESCE(tax_amount, 0) = 0`. **Le fatture emesse non si toccano**: per quelle propongo solo un report delle righe incoerenti.
4. Test: la fattura da progetto in forfettario ha `tax_rate = 0`, lo switch a ordinario usa 22, `POST /api/invoices` senza `tax_rate` usa il default del regime.

## 10. `vat_number` / `fiscal_code` come colonne

Propongo di promuoverli in questa fase, perché servono a proforma, fatture e SDI:

- colonne `customers.vat_number`, `fiscal_code`, `sdi_code`, `pec`, con CHECK sul formato (P.IVA IT di 11 cifre con checksum se `country = IT`, CF di 16 caratteri o 11 cifre per le persone giuridiche, SDI di 7 caratteri) e backfill da `billing_address`;
- per un periodo di transizione si leggono le colonne con fallback su `billing_address` (`invoices.ts` validazione SDI, `quotes-v2.ts` ricerca per P.IVA, vista della 010). Le scritture vanno solo sulle colonne, e il PUT accetta ancora `billing_address.vat_number` mappandolo;
- vantaggi: indice e unicità della P.IVA (oggi `ILIKE` su jsonb), validazione al salvataggio e non all'emissione SDI. Inoltre il bug 3 (chiavi perse nel jsonb) non può ripresentarsi sui dati fiscali.

## 11. Piano di implementazione (dopo conferma)

1. Migrazione 168 (`proformas`, `document_sequences`, categoria privata) con relativo down, più i test della numerazione concorrente.
2. `totals.ts` con test a tabella, poi render e PDF (`htmlToPdf` condiviso), snapshot dell'HTML.
3. Route CRUD/issue/pdf con test.
4. Send/draft-email riusando `outbound` e `drafts` (test con SMTP/IMAP finti di `test/helpers/mail-servers.ts`).
5. mark-paid → fattura → `renewDomain`: test di idempotenza e di rollback. Insieme, `DatiBollo` nell'XML SDI.
6. `POST /api/domains/:id/proforma`, cron senza doppio promemoria, UI admin (Fatturazione → Proforma, azione sul dominio), tool MCP.
7. Fix di `tax_rate` (§9) e colonne fiscali (§10), migrazioni separate e reversibili.

## 12. Decisioni da confermare

1. Numero all'emissione e non alla creazione (§2.2)?
2. Formato esatto: `PF 3/2026` o `PF 0003/2026`?
3. La rivalsa del bollo va nel totale della proforma (cioè il cliente paga 2 € in più) o resta solo una nota?
4. Al pagamento la fattura nasce direttamente `paid`, oppure `draft` da rivedere prima dell'SDI?
5. `DatiBollo` nell'XML SDI va corretto ora (§7)?
6. Promozione delle colonne fiscali (§10) in questa fase?
