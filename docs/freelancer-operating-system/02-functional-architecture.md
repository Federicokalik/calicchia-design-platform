# Functional Architecture

## Obiettivo

Organizzare il pannello admin per flusso di lavoro reale freelancer, non solo per CRUD.

## Menu target

## Dashboard

- Overview
- Agenda operativa
- Scadenze e pagamenti
- Alert e red flags

## CRM

- Lead
- Clienti
- Collaboratori
- Opportunita
- Contatti
- Domini

## Commerciale

- Preventivi
- Fatture
- Pagamenti
- Abbonamenti
- Listino e template

## Delivery

- Progetti
- Board globale
- Lavori grafici
- Siti web
- Campagne marketing
- Calendario delivery

## Contenuti e asset

- Media
- Libreria asset cliente
- Brand kit
- Portfolio
- Blog

## Marketing

- Content calendar
- Campaign planner
- Analytics
- Newsletter
- UTM builder

## Sistema

- Impostazioni
- Automazioni
- API keys
- Audit log
- Webhook log

## Portale cliente

- Preventivi da approvare
- Deliverable da approvare
- File condivisi
- Pagamenti
- Richieste e feedback

## Verticale: Lavori grafici

Workflow:

`brief -> references -> concept -> production -> client_review -> approval -> export -> delivery`

Stati:

- `brief_pending`
- `references_pending`
- `concept`
- `production`
- `internal_review`
- `client_review`
- `approved`
- `export_ready`
- `delivered`

Campi funzionali minimi:

- tipo elaborato
- formato / dimensioni
- canale destinazione
- varianti richieste
- revisioni incluse
- output richiesti
- deadline

## Verticale: Siti web

Workflow:

`onboarding -> sitemap -> content_collection -> design -> development -> qa -> staging_review -> launch -> maintenance`

Stati:

- `onboarding`
- `contents_pending`
- `ux_ui`
- `development`
- `qa`
- `staging_review`
- `launch_ready`
- `live`
- `maintenance`

Campi funzionali minimi:

- tipologia sito
- pagine previste
- stack/CMS
- dominio e DNS
- hosting
- staging url
- production url
- checklist go-live

## Verticale: Campagne marketing

Workflow:

`brief -> planning -> creative_production -> approval -> scheduled -> live -> optimizing -> reporting`

Stati:

- `brief_pending`
- `planning`
- `creative_production`
- `approval`
- `scheduled`
- `live`
- `optimizing`
- `reporting`
- `closed`

Campi funzionali minimi:

- canale
- obiettivo
- budget planned/actual
- periodo
- audience
- KPI target
- KPI reali

## Regola chiave quote-driven

Quando un preventivo passa ad `accepted`, il sistema deve:

1. creare il progetto collegato
2. applicare template delivery coerente con `service_type`
3. generare milestone e task iniziali
4. generare payment schedule
5. predisporre area portale cliente

## Impostazioni da potenziare

## Business

- anagrafica azienda
- branding documento
- timezone, valuta, numerazioni

## Preventivi

- template per servizio
- clausole standard
- policy revisioni
- regole conversione in progetto

## Pagamenti

- IBAN, BIC, intestatario
- metodi attivi
- provider checkout
- reminder insoluti
- causali automatiche

## Delivery

- template milestone per servizio
- template board
- checklist consegna
- regole priorita/capacity

## Portale cliente

- permessi visibilita
- moduli attivi
- policy approvazione
- upload lato cliente

## Automazioni minime

- quote accepted -> create project package
- deliverable client_review -> notify client
- invoice near due -> reminder
- payment received -> update payment status + unlock next milestone
