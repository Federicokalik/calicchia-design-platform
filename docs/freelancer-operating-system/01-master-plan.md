# Master Plan

## Visione

Trasformare l'admin in un operating system unico per vendita, delivery e incasso servizi freelance.

Principi:

- `quote-driven`: il preventivo governa il lavoro operativo.
- `service-aware`: grafica, siti web e marketing hanno flussi distinti.
- `payment-aware`: ogni documento deve poter incassare con metodi coerenti.
- `auditabile`: ogni step chiave deve lasciare traccia.

## Stato attuale (sintesi)

Fondazioni gia presenti:

- CRM clienti/collaboratori.
- Progetti con task, milestone, board e time tracking.
- Preventivi e fatture.
- Dashboard, calendario, audit log, analytics.
- `invoice_settings` gia compatibile con IBAN.

Gap principali:

- Impostazioni ancora parzialmente placeholder.
- Preventivo non ancora usato come motore automatico di delivery.
- Assenza di verticali complete per grafica, web e marketing.
- Payment links non ancora strutturati come dominio.

## Obiettivi di prodotto

## O1 - Preventivo come fonte di verita

Il preventivo deve definire:

- tipo servizio
- deliverable
- revision policy
- payment plan
- metodi pagamento ammessi
- regole post-accettazione

## O2 - Verticali delivery separate

Supporto nativo a:

- `graphic_design`
- `website`
- `marketing_campaign`
- `retainer_maintenance`
- `consulting`

## O3 - Pagamenti integrati documento-centrici

Per quote e invoices:

- bonifico con IBAN e causale
- link PayPal
- link Revolut Pay
- eventuale Stripe checkout
- gestione acconto/saldo/rate

## O4 - Tracciamento operativo completo

Per ogni commessa:

- materiali ricevuti
- versioni deliverable
- feedback cliente
- stato revisioni incluse/extrate
- avanzamento e tempo
- stato economico

## Fasi roadmap

## Fase 0 - Settings modulari

Deliverable:

- API settings centralizzata
- UI settings modulare
- persistenza effettiva dei parametri

Exit criteria:

- nessuna card impostazioni rimane scollegata
- tutti i moduli leggono configurazioni persistite

## Fase 1 - Quote Engine evoluto

Deliverable:

- preventivo con `service_type`
- payment plan strutturato
- conversione quote -> project package

Exit criteria:

- quote `accepted` genera progetto + milestone + task base + payment schedule

## Fase 2 - Delivery verticale

Deliverable:

- modulo lavori grafici
- modulo siti web
- modulo campagne marketing

Exit criteria:

- ogni verticale ha stati, viste e checklist dedicate

## Fase 3 - Payments Hub

Deliverable:

- payment links
- payment schedule
- webhook log provider
- riconciliazione pagamenti

Exit criteria:

- preventivo/fattura possono incassare con metodi configurati
- saldo residuo sempre coerente

## Fase 4 - Portale cliente

Deliverable:

- approvazione preventivi
- approvazione deliverable
- feedback e upload materiali
- visibilita pagamenti/documenti

Exit criteria:

- cliente puo collaborare senza accesso admin

## Fase 5 - Automazioni e reporting

Deliverable:

- regole trigger-action
- alert operativi/economici
- report marginalita e performance

Exit criteria:

- eventi chiave non richiedono gestione manuale ripetitiva

## Priorita consigliata

| Priorita | Modulo | Motivo |
|---|---|---|
| P0 | Settings modulari | Base per tutto il resto |
| P0 | Quote engine | Origine del ciclo operativo |
| P1 | Payments hub | Impatto diretto su cashflow |
| P1 | Design delivery | Copertura lavoro grafico |
| P1 | Website delivery | Copertura delivery web |
| P2 | Marketing delivery | Utile dopo le fondazioni |
| P2 | Portale cliente avanzato | Alto valore ma dipendente dai moduli core |
| P3 | Automazioni estese | Da fare a dominio stabile |

## KPI di riuscita

- Riduzione tempo da quote accepted a kickoff operativo.
- Riduzione task manuali duplicati tra commerciale e delivery.
- Riduzione ritardi pagamenti su saldo.
- Maggiore visibilita su revisioni extra scope.
- Stato progetto e stato economico leggibili in una vista unica.
