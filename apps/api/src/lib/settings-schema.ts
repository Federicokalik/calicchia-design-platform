import { z } from 'zod';
import { DEFAULT_CONTRACT_ARTICLES, DEFAULT_CLAUSOLE_VESSATORIE } from '@calicchia/shared';

const serviceTypeSchema = z.enum([
  'graphic_design',
  'website',
  'marketing_campaign',
  'retainer',
  'retainer_maintenance',
  'consulting',
]);

const paymentPlanItemSchema = z.object({
  type: z.enum(['deposit', 'milestone', 'balance', 'installment']).default('installment'),
  title: z.string().default(''),
  amount: z.number().nonnegative().default(0),
  due_days_from_acceptance: z.number().int().nonnegative().default(0),
  sort_order: z.number().int().nonnegative().default(0),
}).passthrough();

const paymentPlanSchema = z.object({
  version: z.number().int().positive().default(1),
  currency: z.string().default('EUR'),
  items: z.array(paymentPlanItemSchema).default([]),
}).passthrough();

const settingsSchemas = {
  'business.profile': z.object({
    company_name: z.string().default(''),
    legal_name: z.string().default(''),
    vat_number: z.string().default(''),
    fiscal_code: z.string().default(''),
    pec_email: z.string().default(''),
    sdi_code: z.string().default(''),
    email: z.string().default(''),
    phone: z.string().default(''),
    website: z.string().default(''),
    timezone: z.string().default('Europe/Rome'),
    currency: z.string().default('EUR'),
    invoice_prefix: z.string().default('FT-'),
    quote_prefix: z.string().default('PV-'),
    logo_url: z.string().default(''),
    document_primary_color: z.string().default('#000000'),
    address: z.object({
      street: z.string().default(''),
      city: z.string().default(''),
      postal_code: z.string().default(''),
      country: z.string().default('IT'),
    }).default({}),
  }).passthrough(),

  'freelancer.studio': z.object({
    max_clients_per_month: z.number().int().nonnegative().default(3),
    weekly_capacity_hours: z.number().int().nonnegative().default(40),
    default_hourly_rate_cents: z.number().int().nonnegative().default(5000),
    vat_regime: z.enum(['forfettario', 'ordinario', 'none']).default('forfettario'),
    forfettario_coefficient: z.number().min(0).max(1).default(0.78),
    inps_rate: z.number().min(0).max(1).default(0.2607),
    irpef_substitute_rate: z.number().min(0).max(1).default(0.05),
    forfettario_plafond_eur: z.number().nonnegative().default(85000),
  }).passthrough(),

  'billing.defaults': z.object({
    default_payment_terms: z.string().default('Pagamento a 30 giorni'),
    default_tax_rate: z.number().min(0).max(100).default(22),
    default_currency: z.string().default('EUR'),
    default_notes: z.string().default(''),
  }).passthrough(),

  'billing.bank_accounts': z.object({
    accounts: z.array(z.object({
      id: z.string().default(''),
      label: z.string().default(''),
      holder_name: z.string().default(''),
      iban: z.string().default(''),
      bic: z.string().default(''),
      is_default: z.boolean().default(false),
      default_causal: z.string().default(''),
    }).passthrough()).default([]),
  }).passthrough(),

  'payments.providers': z.object({
    allow_bank_transfer: z.boolean().default(true),
    paypal: z.object({
      enabled: z.boolean().default(false),
      paypal_me_url: z.string().default(''),
      client_id: z.string().default(''),
      client_secret: z.string().default(''),
      mode: z.enum(['sandbox', 'live']).default('sandbox'),
    }).default({}),
    revolut: z.object({
      enabled: z.boolean().default(false),
      revolut_pay_url: z.string().default(''),
      api_key: z.string().default(''),
      mode: z.enum(['sandbox', 'live']).default('sandbox'),
    }).default({}),
    stripe: z.object({
      enabled: z.boolean().default(false),
      secret_key: z.string().default(''),
      webhook_secret: z.string().default(''),
      checkout_mode: z.enum(['hosted', 'embedded']).default('hosted'),
    }).default({}),
  }).passthrough(),

  'quotes.templates': z.object({
    default_service_type: serviceTypeSchema.nullish(),
    default_revision_included: z.number().int().nonnegative().default(2),
    standard_clauses: z.string().default(''),
    conversion_rules: z.object({
      auto_create_project_on_accept: z.boolean().default(false),
      auto_create_payment_schedule: z.boolean().default(true),
    }).default({}),
    default_payment_plan: paymentPlanSchema.default({}),
  }).passthrough(),

  'delivery.templates': z.object({
    auto_create_project: z.boolean().default(false),
    template_by_service: z.record(z.array(z.string())).default({}),
    default_task_checklist: z.array(z.string()).default([]),
  }).passthrough(),

  'design.defaults': z.object({
    included_revisions: z.number().int().nonnegative().default(2),
    default_outputs: z.array(z.string()).default([]),
    default_channels: z.array(z.string()).default([]),
  }).passthrough(),

  'website.defaults': z.object({
    default_cms: z.string().default('WordPress'),
    default_stack: z.string().default('Astro'),
    required_pages_count: z.number().int().nonnegative().default(5),
    go_live_checklist: z.array(z.string()).default([]),
  }).passthrough(),

  'marketing.defaults': z.object({
    default_channels: z.array(z.string()).default([]),
    default_kpis: z.array(z.string()).default([]),
    default_budget: z.number().nonnegative().default(0),
  }).passthrough(),

  'portal.settings': z.object({
    enabled: z.boolean().default(false),
    modules: z.object({
      quotes: z.boolean().default(true),
      deliverables: z.boolean().default(true),
      payments: z.boolean().default(true),
      files: z.boolean().default(true),
    }).default({}),
    approval_policy: z.enum(['manual', 'auto']).default('manual'),
    allow_client_upload: z.boolean().default(true),
  }).passthrough(),

  'whatsapp': z.object({
    default_ai_mode: z.enum(['off', 'triage', 'auto_reply']).default('off'),
    // First-contact GDPR disclaimer template. Empty string falls back to the
    // hardcoded default in `apps/api/src/lib/whatsapp-disclaimer.ts`.
    first_contact_disclaimer: z.string().default(''),
    // Admin-curated quick reply snippets shown in the WhatsApp composer.
    quick_replies: z
      .array(
        z.object({
          label: z.string().min(1).max(60),
          text: z.string().min(1).max(2000),
        }),
      )
      .default([]),
    // Override of the AI triage system prompt. Empty string falls back to
    // TRIAGE_SYSTEM_PROMPT_DEFAULT in `apps/api/src/lib/ai/prompts/whatsapp.ts`.
    ai_system_prompt: z.string().default(''),
  }).passthrough(),

  'quote.settings': z.object({
    // Brand
    logo_url: z.string().default(''),
    colore_primario: z.string().default('#f57f44'),
    colore_successo: z.string().default('#16a34a'),
    colore_errore: z.string().default('#dc2626'),
    colore_info: z.string().default('#2563eb'),
    font: z.string().default('Inter, Arial, sans-serif'),

    // Fornitore — populate via admin UI ("Impostazioni / Preventivi").
    // Defaults are intentionally empty: this file ships in a public repo,
    // so personal data (address, IBAN, phone, email) must not live here.
    // Real values are stored in the `site_settings` table.
    ragione_sociale: z.string().default(''),
    indirizzo: z.string().default(''),
    piva: z.string().default(''),
    legale_rappresentante: z.string().default(''),
    telefono: z.string().default(''),
    email_fornitore: z.string().default(''),
    banca: z.string().default(''),
    iban: z.string().default(''),
    bic: z.string().default(''),
    sito_web: z.string().default(''),

    // Regime fiscale
    regime_tipo: z.string().default('forfettario'),
    nota_iva: z.string().default("Regime forfettario ai sensi dell'art. 1, commi 54–89, L. 190/2014 e successive modifiche. Operazione senza applicazione IVA ex art. 1, comma 58, L. 190/2014. Ritenuta d'acconto non applicata ai sensi dell'art. 1, comma 67, L. 190/2014."),
    marca_bollo_nota: z.string().default('Su importi superiori a € 77,47 verrà applicata marca da bollo da € 2,00 come previsto dalla normativa vigente.'),
    soglia_bollo: z.number().default(77.47),
    importo_bollo: z.number().default(2.00),

    // Contratto
    foro_competente: z.string().default('Tribunale di Frosinone'),
    durata_standard_mesi: z.number().default(12),
    clausole_vessatorie: z.array(z.number()).default(DEFAULT_CLAUSOLE_VESSATORIE),

    // Template default
    materiali_default: z.array(z.string()).default(['Logo (vettoriale)', 'Testi / Copy', 'Foto / Immagini', 'Accessi (hosting, dominio)']),
    note_default: z.string().default(''),
    termini_condizioni: z.string().default(''),
    contratto_articoli: z.array(z.string()).default(DEFAULT_CONTRACT_ARTICLES),
  }).passthrough(),

  'automation.rules': z.object({
    quote_accepted_create_project: z.boolean().default(false),
    invoice_due_reminder_days: z.number().int().nonnegative().default(3),
    notify_revisions_exceeded: z.boolean().default(true),
    payment_received_unlock_next_milestone: z.boolean().default(false),
  }).passthrough(),

  // Audit C-013/C-014: site marketing surface that the public sito-v3 reads
  // through /api/public/site-config. Lets admin edit brand/description/
  // social/geo/cal without a code change + redeploy. Contact email/phone/
  // address/vat continue to live in 'business.profile' (same row drives
  // invoice PDFs and the public footer). All strings default to empty so
  // the consumer (see apps/sito-v3/src/lib/site-config.ts) can fall back
  // to data/site.ts when nothing has been set yet.
  'site.public': z.object({
    brand: z.string().default(''),
    description: z.string().default(''),
    cal: z.string().default(''),
    social: z
      .array(
        z.object({
          label: z.string().min(1).max(60),
          url: z.string().url(),
          icon: z.string().max(60).optional(),
        }),
      )
      .default([]),
    geo: z.object({
      lat: z.number().optional(),
      lng: z.number().optional(),
      city: z.string().optional(),
      province: z.string().optional(),
      region: z.string().optional(),
      country: z.string().optional(),
      postalCode: z.string().optional(),
    }).default({}),
  }).passthrough(),
} as const;

export type SettingKey = keyof typeof settingsSchemas;
export const SETTINGS_KEYS = Object.keys(settingsSchemas) as SettingKey[];

export function isSettingKey(value: string): value is SettingKey {
  return value in settingsSchemas;
}

export function getDefaultSettingValue<T extends SettingKey>(key: T) {
  return settingsSchemas[key].parse({});
}

export function validateSettingValue<T extends SettingKey>(key: T, value: unknown) {
  return settingsSchemas[key].safeParse(value);
}
