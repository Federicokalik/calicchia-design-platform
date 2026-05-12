# Technical Schema

## Strategia di evoluzione

Evoluzione incrementale sul dominio esistente, evitando refactor distruttivi.

Approccio:

1. estendere tabelle esistenti dove opportuno
2. aggiungere nuove tabelle verticali
3. introdurre API progressive e retrocompatibili
4. abilitare automazioni solo dopo stabilizzazione dominio

## Estensioni schema su `quotes`

Campi consigliati:

| Campo | Tipo | Note |
|---|---|---|
| `service_type` | text | `graphic_design`, `website`, `marketing_campaign`, `retainer`, `consulting` |
| `delivery_template_id` | uuid nullable | template operativo scelto |
| `scope_items` | jsonb | deliverable strutturati |
| `revision_policy` | jsonb | revisioni incluse / extra |
| `payment_plan` | jsonb | acconto, SAL, saldo o rate |
| `accepted_payment_methods` | jsonb | metodi pagamento ammessi |
| `bank_details_snapshot` | jsonb | snapshot IBAN e causali |
| `approval_policy` | jsonb | regole approvazione |
| `generated_project_id` | uuid nullable | progetto generato da quote |

## Estensioni schema su `invoices`

Campi consigliati:

| Campo | Tipo | Note |
|---|---|---|
| `payment_status` | text | `unpaid`, `partial`, `paid`, `failed`, `refunded` |
| `balance_due` | numeric | residuo |
| `accepted_payment_methods` | jsonb | metodi abilitati |
| `bank_details_snapshot` | jsonb | snapshot IBAN |
| `payment_instructions` | text | testo istruzioni documento |

## Nuove tabelle payments

## `payment_provider_accounts`

Config provider (PayPal, Revolut, Stripe).

Campi:

- `id`
- `provider`
- `label`
- `is_active`
- `credentials_ref`
- `settings_json`
- `created_at`
- `updated_at`

## `payment_schedules`

Piano incasso per quote/invoice/project.

Campi:

- `id`
- `quote_id`
- `invoice_id`
- `project_id`
- `schedule_type` (`deposit`, `milestone`, `balance`, `installment`)
- `title`
- `amount`
- `currency`
- `due_date`
- `status`
- `sort_order`
- `trigger_rule`
- `created_at`
- `updated_at`

## `payment_links`

Link pagamento generato dal gestionale.

Campi:

- `id`
- `quote_id`
- `invoice_id`
- `payment_schedule_id`
- `provider`
- `provider_order_id`
- `checkout_url`
- `amount`
- `currency`
- `status`
- `expires_at`
- `payload_json`
- `created_at`
- `updated_at`

## `payment_webhook_events`

Audit tecnico dei webhook.

Campi:

- `id`
- `provider`
- `event_type`
- `external_id`
- `signature_valid`
- `payload_json`
- `processed_at`
- `status`
- `error_message`
- `created_at`

## Nuove tabelle design delivery

## `project_deliverables`

Output gestibile e approvabile dal cliente.

Campi:

- `id`
- `project_id`
- `task_id`
- `deliverable_type`
- `title`
- `description`
- `status`
- `visible_to_client`
- `included_revisions`
- `used_revisions`
- `due_date`
- `approved_at`
- `approved_by_customer_id`
- `metadata`
- `created_at`
- `updated_at`

## `deliverable_versions`

Versioning file.

Campi:

- `id`
- `deliverable_id`
- `version_number`
- `label`
- `file_path`
- `preview_url`
- `uploaded_by`
- `change_notes`
- `client_visible`
- `created_at`

## `deliverable_feedback`

Commenti e annotazioni su versione.

Campi:

- `id`
- `deliverable_version_id`
- `customer_id`
- `user_id`
- `feedback_type`
- `anchor_data`
- `content`
- `status`
- `created_at`
- `resolved_at`

## Nuove tabelle website delivery

## `website_projects`

Campi:

- `project_id` (PK/FK)
- `site_type`
- `cms_type`
- `sitemap_json`
- `required_pages_count`
- `staging_url`
- `production_url`
- `repo_url`
- `hosting_provider`
- `dns_provider`
- `launch_date`
- `maintenance_plan`
- `credentials_status`
- `content_status`
- `seo_status`

## `website_pages`

Campi:

- `id`
- `project_id`
- `page_name`
- `slug`
- `page_type`
- `content_status`
- `design_status`
- `dev_status`
- `seo_status`
- `sort_order`
- `notes`

## `website_launch_checklist_items`

Campi:

- `id`
- `project_id`
- `item_key`
- `label`
- `status`
- `completed_by`
- `completed_at`
- `notes`

## Nuove tabelle marketing delivery

## `marketing_campaigns`

Campi:

- `id`
- `project_id`
- `channel`
- `objective`
- `budget_planned`
- `budget_actual`
- `start_date`
- `end_date`
- `status`
- `landing_page_url`
- `audience_json`
- `kpi_targets_json`
- `kpi_actuals_json`
- `created_at`
- `updated_at`

## `campaign_assets`

Campi:

- `id`
- `campaign_id`
- `asset_type`
- `title`
- `copy_variant`
- `creative_file_id`
- `approval_status`
- `scheduled_at`
- `published_at`
- `metadata`

## `campaign_reports`

Campi:

- `id`
- `campaign_id`
- `period_start`
- `period_end`
- `metrics_json`
- `summary`
- `created_at`

## Settings centralizzati

Usare `site_settings` con chiavi modulari:

- `business.profile`
- `billing.defaults`
- `billing.bank_accounts`
- `payments.providers`
- `quotes.templates`
- `delivery.templates`
- `design.defaults`
- `website.defaults`
- `marketing.defaults`
- `portal.settings`
- `automation.rules`

## API target

## Settings

- `GET /api/settings`
- `GET /api/settings/:key`
- `PUT /api/settings/:key`

## Quotes

- `GET /api/quotes/templates`
- `POST /api/quotes/:id/accept`
- `POST /api/quotes/:id/generate-project`
- `POST /api/quotes/:id/payment-schedule`

## Payments

- `GET /api/payments/schedules`
- `POST /api/payments/schedules`
- `POST /api/payments/links`
- `POST /api/payments/links/:id/refresh`
- `POST /api/payments/webhooks/paypal`
- `POST /api/payments/webhooks/revolut`

## Design

- `GET /api/deliverables`
- `POST /api/deliverables`
- `POST /api/deliverables/:id/versions`
- `POST /api/deliverables/:id/approve`
- `POST /api/deliverable-feedback`

## Website

- `GET /api/website-projects/:projectId`
- `PUT /api/website-projects/:projectId`
- `POST /api/website-pages`
- `PATCH /api/website-launch-checklist/:id`

## Marketing

- `GET /api/marketing-campaigns`
- `POST /api/marketing-campaigns`
- `POST /api/campaign-assets`
- `POST /api/campaign-reports`

## Automazioni minime

1. `quote.accepted` -> create project + payment schedule + milestone base.
2. `deliverable.client_review` -> notify client + due feedback date.
3. `payment_link.paid` -> update schedule + invoice residual.
4. `revisions_exceeded` -> mark `extra_scope` + notify admin.

## Regola snapshot storico

Quando si genera quote/invoice, salvare snapshot dei parametri economici e bancari.

Minimo:

- intestatario
- IBAN/BIC
- causale standard
- termini pagamento
- metodi pagamento permessi

Motivo: coerenza legale/storica anche dopo cambi setting.
