import { z } from 'zod';

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

  'quote.settings': z.object({
    // Brand
    logo_url: z.string().default(''),
    colore_primario: z.string().default('#f57f44'),
    colore_successo: z.string().default('#16a34a'),
    colore_errore: z.string().default('#dc2626'),
    colore_info: z.string().default('#2563eb'),
    font: z.string().default('Inter, Arial, sans-serif'),

    // Fornitore
    ragione_sociale: z.string().default('Calicchia Design di Federico Calicchia'),
    indirizzo: z.string().default('Via Scifelli 74, 03023 Ceccano (FR)'),
    piva: z.string().default('03160480608'),
    legale_rappresentante: z.string().default('Federico Calicchia'),
    telefono: z.string().default('351 777 3467'),
    email_fornitore: z.string().default('info@calicchia.design'),
    banca: z.string().default('Revolut Bank UAB — Via Dante 7, 20123 Milano (MI)'),
    iban: z.string().default('IT79 Z036 6901 6009 8955 1082 080'),
    bic: z.string().default('REVOITM2'),

    // Regime fiscale
    regime_tipo: z.string().default('forfettario'),
    nota_iva: z.string().default("Regime forfettario ai sensi dell'art. 1, commi 54–89, L. 190/2014 e successive modifiche. Operazione senza applicazione IVA ex art. 1, comma 58, L. 190/2014. Ritenuta d'acconto non applicata ai sensi dell'art. 1, comma 67, L. 190/2014."),
    marca_bollo_nota: z.string().default('Su importi superiori a € 77,47 verrà applicata marca da bollo da € 2,00 come previsto dalla normativa vigente.'),
    soglia_bollo: z.number().default(77.47),
    importo_bollo: z.number().default(2.00),

    // Contratto
    foro_competente: z.string().default('Tribunale di Frosinone'),
    durata_standard_mesi: z.number().default(12),
    clausole_vessatorie: z.array(z.number()).default([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),

    // Template default
    materiali_default: z.array(z.string()).default(['Logo (vettoriale)', 'Testi / Copy', 'Foto / Immagini', 'Accessi (hosting, dominio)']),
    note_default: z.string().default(''),
    termini_condizioni: z.string().default(''),
    contratto_articoli: z.array(z.string()).default([
      'Art. 1 — OGGETTO: Il Fornitore si impegna a realizzare per il Cliente i servizi descritti nel presente preventivo.',
      'Art. 2 — COMPENSO: Il compenso per i servizi è quello indicato nell\'offerta economica accettata.',
      'Art. 3 — DURATA: Il presente contratto ha durata di 12 mesi dalla data di sottoscrizione.',
      'Art. 4 — MODALITÀ DI PAGAMENTO: Il pagamento dovrà avvenire secondo le modalità indicate nel preventivo.',
      'Art. 5 — RITARDO NEI PAGAMENTI: In caso di ritardo, il Fornitore si riserva di sospendere i servizi.',
      'Art. 6 — PROPRIETÀ INTELLETTUALE: I diritti di proprietà intellettuale restano del Fornitore fino al saldo completo.',
      'Art. 7 — RISERVATEZZA: Le parti si impegnano a mantenere riservate le informazioni scambiate.',
      'Art. 8 — RECESSO: Ciascuna parte può recedere con preavviso scritto di 30 giorni.',
      'Art. 9 — FORZA MAGGIORE: Nessuna parte sarà responsabile per inadempimenti dovuti a causa di forza maggiore.',
      'Art. 10 — LIMITAZIONE DI RESPONSABILITÀ: La responsabilità del Fornitore è limitata al compenso ricevuto.',
      'Art. 11 — GARANZIA: Il Fornitore garantisce la conformità dei servizi alle specifiche concordate.',
      'Art. 12 — MODIFICHE AL CONTRATTO: Eventuali modifiche devono essere concordate per iscritto.',
      'Art. 13 — CESSIONE: Il contratto non può essere ceduto a terzi senza consenso scritto.',
      'Art. 14 — COMUNICAZIONI: Le comunicazioni ufficiali devono avvenire via PEC o raccomandata.',
      'Art. 15 — FORO COMPETENTE: Per ogni controversia sarà competente il Tribunale indicato nelle impostazioni.',
    ]),
  }).passthrough(),

  'automation.rules': z.object({
    quote_accepted_create_project: z.boolean().default(false),
    invoice_due_reminder_days: z.number().int().nonnegative().default(3),
    notify_revisions_exceeded: z.boolean().default(true),
    payment_received_unlock_next_milestone: z.boolean().default(false),
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
