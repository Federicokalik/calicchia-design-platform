import { Hono } from 'hono';
import { sql, sqlv } from '../db';

export const quotes = new Hono();

const QUOTE_SERVICE_TYPES = new Set([
  'graphic_design',
  'website',
  'marketing_campaign',
  'retainer',
  'retainer_maintenance',
  'consulting',
]);

const PAYMENT_PLAN_ITEM_TYPES = new Set(['deposit', 'milestone', 'balance', 'installment']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ServiceType = 'graphic_design' | 'website' | 'marketing_campaign' | 'retainer' | 'retainer_maintenance' | 'consulting';
type ProjectType = 'website' | 'maintenance' | 'consulting' | 'other';

type DeliveryTemplate = {
  project_type: ProjectType;
  milestones: Array<{
    name: string;
    tasks: string[];
  }>;
};

type QuoteSettingsSnapshot = {
  bankDetailsSnapshot: Record<string, unknown>;
  acceptedPaymentMethods: string[];
};

function hasOwnProperty(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeServiceType(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('service_type deve essere una stringa');

  const normalized = value.trim();
  if (!QUOTE_SERVICE_TYPES.has(normalized)) {
    throw new Error('service_type non supportato');
  }

  return normalized;
}

function normalizeScopeItems(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('scope_items deve essere un array');
  return value;
}

function normalizeRevisionPolicy(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new Error('revision_policy deve essere un oggetto');
  return value;
}

function normalizeAcceptedPaymentMethods(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('accepted_payment_methods deve essere un array di stringhe');
  }

  return value
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeBankDetailsSnapshot(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new Error('bank_details_snapshot deve essere un oggetto');
  return value;
}

function normalizeGeneratedProjectId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new Error('generated_project_id deve essere un UUID valido');
  }
  return value;
}

function normalizePaymentPlan(value: unknown, fallbackCurrency: string): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {
      version: 1,
      currency: fallbackCurrency,
      items: [],
    };
  }

  if (!isRecord(value)) throw new Error('payment_plan deve essere un oggetto');

  const currency = typeof value.currency === 'string' && value.currency.trim()
    ? value.currency.trim().toUpperCase()
    : fallbackCurrency;

  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`payment_plan.items[${index}] deve essere un oggetto`);
    }

    const type = typeof item.type === 'string' ? item.type : 'installment';
    if (!PAYMENT_PLAN_ITEM_TYPES.has(type)) {
      throw new Error(`payment_plan.items[${index}].type non supportato`);
    }

    const amount = Number(item.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`payment_plan.items[${index}].amount deve essere >= 0`);
    }

    const dueDays = Number(item.due_days_from_acceptance ?? 0);
    if (!Number.isInteger(dueDays) || dueDays < 0) {
      throw new Error(`payment_plan.items[${index}].due_days_from_acceptance deve essere un intero >= 0`);
    }

    const sortOrder = Number(item.sort_order ?? index);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      throw new Error(`payment_plan.items[${index}].sort_order deve essere un intero >= 0`);
    }

    return {
      type,
      title: typeof item.title === 'string' ? item.title : '',
      amount,
      due_days_from_acceptance: dueDays,
      sort_order: sortOrder,
    };
  });

  const versionRaw = Number(value.version ?? 1);
  const version = Number.isInteger(versionRaw) && versionRaw > 0 ? versionRaw : 1;

  return {
    ...value,
    version,
    currency,
    items,
  };
}

const DEFAULT_DELIVERY_TEMPLATES: Record<ServiceType, DeliveryTemplate> = {
  graphic_design: {
    project_type: 'other',
    milestones: [
      { name: 'Brief', tasks: ['Raccolta materiali', 'Allineamento obiettivi'] },
      { name: 'Concept', tasks: ['Proposta concept', 'Review interna'] },
      { name: 'Produzione', tasks: ['Produzione elaborati', 'Preparazione export'] },
      { name: 'Delivery', tasks: ['Consegna finale', 'Chiusura progetto'] },
    ],
  },
  website: {
    project_type: 'website',
    milestones: [
      { name: 'Onboarding', tasks: ['Kickoff', 'Raccolta accessi e contenuti'] },
      { name: 'Design', tasks: ['Wireframe', 'UI approvazione interna'] },
      { name: 'Development', tasks: ['Sviluppo pagine', 'QA tecnico'] },
      { name: 'Launch', tasks: ['Go-live checklist', 'Pubblicazione'] },
    ],
  },
  marketing_campaign: {
    project_type: 'other',
    milestones: [
      { name: 'Brief', tasks: ['Definizione obiettivi', 'Definizione audience'] },
      { name: 'Planning', tasks: ['Piano contenuti', 'Piano budget'] },
      { name: 'Execution', tasks: ['Produzione creatività', 'Pubblicazione campagne'] },
      { name: 'Reporting', tasks: ['Analisi KPI', 'Report finale'] },
    ],
  },
  retainer: {
    project_type: 'maintenance',
    milestones: [
      { name: 'Sprint Setup', tasks: ['Pianificazione attività', 'Prioritizzazione backlog'] },
      { name: 'Sprint Delivery', tasks: ['Esecuzione attività mese', 'Review con cliente'] },
    ],
  },
  retainer_maintenance: {
    project_type: 'maintenance',
    milestones: [
      { name: 'Manutenzione', tasks: ['Interventi ordinari', 'Monitoraggio e fix'] },
      { name: 'Report', tasks: ['Report mensile', 'Pianificazione mese successivo'] },
    ],
  },
  consulting: {
    project_type: 'consulting',
    milestones: [
      { name: 'Discovery', tasks: ['Analisi contesto', 'Raccolta requisiti'] },
      { name: 'Delivery', tasks: ['Sessione consulenziale', 'Consegna raccomandazioni'] },
    ],
  },
};

function resolveServiceType(value: unknown): ServiceType {
  if (typeof value === 'string' && QUOTE_SERVICE_TYPES.has(value)) {
    return value as ServiceType;
  }
  return 'consulting';
}

function resolveTemplateForService(serviceType: ServiceType): DeliveryTemplate {
  return DEFAULT_DELIVERY_TEMPLATES[serviceType] || DEFAULT_DELIVERY_TEMPLATES.consulting;
}

function normalizeQuotePaymentSchedule(rawPaymentPlan: unknown, fallbackCurrency: string) {
  const normalized = normalizePaymentPlan(rawPaymentPlan, fallbackCurrency);
  const items = Array.isArray(normalized.items) ? normalized.items as Array<Record<string, unknown>> : [];

  return items.map((item, index) => ({
    schedule_type: String(item.type || 'installment'),
    title: String(item.title || `Rata ${index + 1}`),
    amount: Number(item.amount || 0),
    currency: String(normalized.currency || fallbackCurrency),
    due_days_from_acceptance: Number(item.due_days_from_acceptance || 0),
    sort_order: Number(item.sort_order ?? index),
    status: 'pending',
  }));
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

async function buildQuoteSettingsSnapshot(): Promise<QuoteSettingsSnapshot> {
  const settingsRows = await sql`
    SELECT key, value
    FROM site_settings
    WHERE key IN ('business.profile', 'billing.defaults', 'billing.bank_accounts', 'payments.providers')
  ` as Array<{ key: string; value: unknown }>;

  const settingsMap: Record<string, unknown> = {};
  for (const row of settingsRows) settingsMap[row.key] = row.value;

  const businessProfile = isRecord(settingsMap['business.profile']) ? settingsMap['business.profile'] : {};
  const billingDefaults = isRecord(settingsMap['billing.defaults']) ? settingsMap['billing.defaults'] : {};
  const billingBankAccounts = isRecord(settingsMap['billing.bank_accounts']) ? settingsMap['billing.bank_accounts'] : {};
  const paymentsProviders = isRecord(settingsMap['payments.providers']) ? settingsMap['payments.providers'] : {};

  const accounts = Array.isArray(billingBankAccounts.accounts)
    ? billingBankAccounts.accounts.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
  const defaultAccount = accounts.find((item) => Boolean(item.is_default)) || accounts[0];

  const paypal = isRecord(paymentsProviders.paypal) ? paymentsProviders.paypal : {};
  const revolut = isRecord(paymentsProviders.revolut) ? paymentsProviders.revolut : {};
  const stripe = isRecord(paymentsProviders.stripe) ? paymentsProviders.stripe : {};

  const [invoiceFallback] = await sql`
    SELECT company_name, bank_iban, bank_bic, default_payment_terms
    FROM invoice_settings
    ORDER BY updated_at DESC
    LIMIT 1
  ` as Array<{
    company_name: string | null;
    bank_iban: string | null;
    bank_bic: string | null;
    default_payment_terms: string | null;
  }>;

  const snapshot = {
    captured_at: new Date().toISOString(),
    company_name: String(businessProfile.company_name || invoiceFallback?.company_name || ''),
    holder_name: String(defaultAccount?.holder_name || invoiceFallback?.company_name || ''),
    iban: String(defaultAccount?.iban || invoiceFallback?.bank_iban || ''),
    bic: String(defaultAccount?.bic || invoiceFallback?.bank_bic || ''),
    default_causal: String(defaultAccount?.default_causal || ''),
    payment_terms: String(
      billingDefaults.default_payment_terms || invoiceFallback?.default_payment_terms || '',
    ),
    currency: String(businessProfile.currency || billingDefaults.default_currency || 'EUR'),
  };

  const methods: string[] = [];
  const canBankTransfer = Boolean(
    paymentsProviders.allow_bank_transfer
    || snapshot.iban
    || invoiceFallback?.bank_iban,
  );
  if (canBankTransfer) methods.push('bank_transfer');
  if (Boolean(paypal.enabled)) methods.push('paypal');
  if (Boolean(revolut.enabled)) methods.push('revolut');
  if (Boolean(stripe.enabled)) methods.push('stripe');

  return {
    bankDetailsSnapshot: snapshot,
    acceptedPaymentMethods: uniqueStrings(methods),
  };
}

async function createProjectPackageFromQuote(quoteId: string) {
  const rows = await sql`
    SELECT *
    FROM quotes
    WHERE id = ${quoteId}
    LIMIT 1
  `;
  const quote = rows[0] as Record<string, unknown> | undefined;

  if (!quote) throw new Error('Preventivo non trovato');
  if (quote.generated_project_id) {
    return { project_id: String(quote.generated_project_id), created: false };
  }

  const serviceType = resolveServiceType(quote.service_type);
  const template = resolveTemplateForService(serviceType);

  const projectName = typeof quote.title === 'string' && quote.title.trim().length > 0
    ? quote.title
    : `Progetto da ${quote.quote_number || quoteId.slice(0, 8)}`;
  if (typeof quote.customer_id !== 'string') {
    throw new Error('Preventivo senza cliente valido');
  }
  const targetEndDate = typeof quote.valid_until === 'string'
    ? quote.valid_until
    : quote.valid_until instanceof Date
      ? quote.valid_until.toISOString().split('T')[0]
      : null;

  const [project] = await sql`
    INSERT INTO client_projects (
      customer_id,
      name,
      description,
      project_type,
      status,
      start_date,
      target_end_date,
      currency,
      visible_to_client,
      metadata
    )
    VALUES (
      ${quote.customer_id},
      ${projectName},
      ${typeof quote.introduction === 'string' ? quote.introduction : null},
      ${template.project_type},
      ${'in_progress'},
      ${new Date().toISOString().split('T')[0]},
      ${targetEndDate},
      ${typeof quote.currency === 'string' ? quote.currency : 'EUR'},
      ${true},
      ${sqlv({
        source: 'quote',
        quote_id: quoteId,
        service_type: serviceType,
      })}
    )
    RETURNING id
  ` as Array<{ id: string }>;

  for (let milestoneIndex = 0; milestoneIndex < template.milestones.length; milestoneIndex += 1) {
    const milestoneTemplate = template.milestones[milestoneIndex];
    const [milestone] = await sql`
      INSERT INTO project_milestones ${sql({
        project_id: project.id,
        name: milestoneTemplate.name,
        status: milestoneIndex === 0 ? 'in_progress' : 'pending',
        sort_order: milestoneIndex,
        visible_to_client: true,
      })}
      RETURNING id
    ` as Array<{ id: string }>;

    for (let taskIndex = 0; taskIndex < milestoneTemplate.tasks.length; taskIndex += 1) {
      await sql`
        INSERT INTO project_tasks ${sql({
          project_id: project.id,
          milestone_id: milestone.id,
          title: milestoneTemplate.tasks[taskIndex],
          status: 'todo',
          sort_order: taskIndex,
          visible_to_client: true,
        })}
      `;
    }
  }

  await sql`
    UPDATE quotes
    SET generated_project_id = ${project.id}
    WHERE id = ${quoteId}
  `;

  return { project_id: project.id, created: true };
}

quotes.get('/', async (c) => {
  const status = c.req.query('status');
  const customerId = c.req.query('customer_id');
  const search = c.req.query('search');
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');

  const statusFilter = status && status !== 'all' ? sql`AND q.status = ${status}` : sql``;
  const customerFilter = customerId ? sql`AND q.customer_id = ${customerId}` : sql``;
  const searchFilter = search
    ? sql`AND (q.quote_number ILIKE ${'%' + search + '%'} OR q.title ILIKE ${'%' + search + '%'})`
    : sql``;
  const fromFilter = dateFrom ? sql`AND q.issue_date >= ${dateFrom}` : sql``;
  const toFilter = dateTo ? sql`AND q.issue_date <= ${dateTo}` : sql``;

  const rows = await sql`
    SELECT q.*,
      jsonb_build_object('id', c.id, 'company_name', c.company_name, 'contact_name', c.contact_name, 'email', c.email) AS customers
    FROM quotes q
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE 1=1 ${statusFilter} ${customerFilter} ${searchFilter} ${fromFilter} ${toFilter}
    ORDER BY q.created_at DESC
  `;

  const stats = {
    total: rows.length,
    draft: rows.filter((q) => q.status === 'draft').length,
    sent: rows.filter((q) => q.status === 'sent' || q.status === 'viewed').length,
    accepted: rows.filter((q) => q.status === 'accepted').length,
    rejected: rows.filter((q) => q.status === 'rejected').length,
    expired: rows.filter((q) => q.status === 'expired').length,
    converted: rows.filter((q) => q.status === 'converted').length,
    total_value: rows.reduce((acc, q) => acc + ((q.total as number) || 0), 0),
    accepted_value: rows
      .filter((q) => q.status === 'accepted' || q.status === 'converted')
      .reduce((acc, q) => acc + ((q.total as number) || 0), 0),
  };

  return c.json({ quotes: rows, stats });
});

quotes.get('/templates', async (c) => {
  const [settingsRow] = await sql`
    SELECT value
    FROM site_settings
    WHERE key = 'quotes.templates'
    LIMIT 1
  ` as Array<{ value: Record<string, unknown> }>;

  return c.json({
    templates: DEFAULT_DELIVERY_TEMPLATES,
    defaults: settingsRow?.value || {},
    service_types: Array.from(QUOTE_SERVICE_TYPES),
  });
});

quotes.get('/:id', async (c) => {
  const id = c.req.param('id');

  const rows = await sql`
    SELECT q.*, to_jsonb(c.*) AS customers,
      jsonb_build_object('id', p.id, 'name', p.name) AS client_projects
    FROM quotes q
    LEFT JOIN customers c ON c.id = q.customer_id
    LEFT JOIN client_projects p ON p.id = q.project_id
    WHERE q.id = ${id}
  `;

  if (!rows.length) return c.json({ error: 'Preventivo non trovato' }, 404);
  return c.json({ quote: rows[0] });
});

function computeQuoteTotals(body: Record<string, unknown>) {
  const items: Array<{ quantity: number; unit_price: number }> = Array.isArray(body.line_items) ? body.line_items as Array<{ quantity: number; unit_price: number }> : [];
  const subtotal = items.reduce((sum, i) => sum + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);
  const discountAmount = Number(body.discount) || Number(body.discount_amount) || 0;
  const taxRate = Number(body.tax_rate ?? 22);
  const afterDiscount = subtotal - discountAmount;
  const taxAmount = afterDiscount * (taxRate / 100);
  const total = afterDiscount + taxAmount;
  return { subtotal, discountAmount, taxAmount, total };
}

quotes.post('/', async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const { subtotal, discountAmount, taxAmount, total } = computeQuoteTotals(body);
  const currency = typeof body.currency === 'string' && body.currency ? body.currency : 'EUR';

  const quoteData: Record<string, unknown> = {
    customer_id: body.customer_id,
    project_id: body.project_id || null,
    title: body.title,
    introduction: body.introduction || null,
    line_items: body.line_items || [],
    issue_date: body.issue_date || new Date().toISOString().split('T')[0],
    valid_until: body.valid_until || null,
    discount_amount: discountAmount,
    tax_rate: body.tax_rate ?? 22,
    subtotal,
    tax_amount: taxAmount,
    total,
    notes: body.notes || null,
    terms: body.terms || null,
    payment_terms: body.payment_terms || null,
    status: 'draft',
  };

  try {
    if (hasOwnProperty(body, 'service_type')) {
      quoteData.service_type = normalizeServiceType(body.service_type);
    }
    if (hasOwnProperty(body, 'scope_items')) {
      quoteData.scope_items = normalizeScopeItems(body.scope_items);
    }
    if (hasOwnProperty(body, 'revision_policy')) {
      quoteData.revision_policy = normalizeRevisionPolicy(body.revision_policy);
    }
    if (hasOwnProperty(body, 'payment_plan')) {
      quoteData.payment_plan = normalizePaymentPlan(body.payment_plan, currency);
    }
    if (hasOwnProperty(body, 'accepted_payment_methods')) {
      quoteData.accepted_payment_methods = normalizeAcceptedPaymentMethods(body.accepted_payment_methods);
    }
    if (hasOwnProperty(body, 'bank_details_snapshot')) {
      quoteData.bank_details_snapshot = normalizeBankDetailsSnapshot(body.bank_details_snapshot);
    }
    if (hasOwnProperty(body, 'generated_project_id')) {
      quoteData.generated_project_id = normalizeGeneratedProjectId(body.generated_project_id);
    }
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Payload non valido' }, 400);
  }

  if (!hasOwnProperty(body, 'bank_details_snapshot') || !hasOwnProperty(body, 'accepted_payment_methods')) {
    const snapshotDefaults = await buildQuoteSettingsSnapshot();
    if (!hasOwnProperty(body, 'bank_details_snapshot')) {
      quoteData.bank_details_snapshot = snapshotDefaults.bankDetailsSnapshot;
    }
    if (!hasOwnProperty(body, 'accepted_payment_methods')) {
      quoteData.accepted_payment_methods = snapshotDefaults.acceptedPaymentMethods;
    }
  }

  const [quote] = await sql`
    INSERT INTO quotes ${sql(quoteData)}
    RETURNING *
  `;

  return c.json({ quote }, 201);
});

quotes.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const { subtotal, discountAmount, taxAmount, total } = computeQuoteTotals(body);
  const currency = typeof body.currency === 'string' && body.currency ? body.currency : 'EUR';

  const quoteData: Record<string, unknown> = {
    customer_id: body.customer_id,
    project_id: body.project_id || null,
    title: body.title,
    introduction: body.introduction || null,
    line_items: body.line_items || [],
    issue_date: body.issue_date,
    valid_until: body.valid_until || null,
    discount_amount: discountAmount,
    tax_rate: body.tax_rate ?? 22,
    subtotal,
    tax_amount: taxAmount,
    total,
    notes: body.notes || null,
    terms: body.terms || null,
    payment_terms: body.payment_terms || null,
  };

  try {
    if (hasOwnProperty(body, 'service_type')) {
      quoteData.service_type = normalizeServiceType(body.service_type);
    }
    if (hasOwnProperty(body, 'scope_items')) {
      quoteData.scope_items = normalizeScopeItems(body.scope_items);
    }
    if (hasOwnProperty(body, 'revision_policy')) {
      quoteData.revision_policy = normalizeRevisionPolicy(body.revision_policy);
    }
    if (hasOwnProperty(body, 'payment_plan')) {
      quoteData.payment_plan = normalizePaymentPlan(body.payment_plan, currency);
    }
    if (hasOwnProperty(body, 'accepted_payment_methods')) {
      quoteData.accepted_payment_methods = normalizeAcceptedPaymentMethods(body.accepted_payment_methods);
    }
    if (hasOwnProperty(body, 'bank_details_snapshot')) {
      quoteData.bank_details_snapshot = normalizeBankDetailsSnapshot(body.bank_details_snapshot);
    }
    if (hasOwnProperty(body, 'generated_project_id')) {
      quoteData.generated_project_id = normalizeGeneratedProjectId(body.generated_project_id);
    }
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Payload non valido' }, 400);
  }

  const [quote] = await sql`
    UPDATE quotes SET ${sql(quoteData)}
    WHERE id = ${id} RETURNING *
  `;

  return c.json({ quote });
});

quotes.patch('/:id/status', async (c) => {
  const id = c.req.param('id');
  const { status } = await c.req.json();

  const extra: Record<string, string> = {};
  if (status === 'sent') extra.sent_at = new Date().toISOString();
  if (status === 'accepted') extra.accepted_at = new Date().toISOString();
  if (status === 'rejected') extra.rejected_at = new Date().toISOString();

  const [quote] = await sql`UPDATE quotes SET ${sql({ status, ...extra })} WHERE id = ${id} RETURNING *`;
  return c.json({ quote });
});

quotes.post('/:id/accept', async (c) => {
  const id = c.req.param('id');
  const payload = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const autoGenerateProject = payload.generate_project !== false;

  const [existing] = await sql`
    SELECT id, status, accepted_at, generated_project_id
    FROM quotes
    WHERE id = ${id}
    LIMIT 1
  ` as Array<{
    id: string;
    status: string;
    accepted_at: string | null;
    generated_project_id: string | null;
  }>;

  if (!existing) return c.json({ error: 'Preventivo non trovato' }, 404);
  if (existing.status === 'converted') {
    return c.json({ error: 'Preventivo già convertito in fattura' }, 400);
  }

  if (!['sent', 'viewed', 'accepted', 'draft'].includes(existing.status)) {
    return c.json({ error: `Transizione non valida da stato ${existing.status}` }, 400);
  }

  const [quote] = await sql`
    UPDATE quotes
    SET ${sql({
      status: 'accepted',
      accepted_at: existing.accepted_at || new Date().toISOString(),
    })}
    WHERE id = ${id}
    RETURNING *
  `;

  let generatedProject: { project_id: string; created: boolean } | null = null;
  if (autoGenerateProject) {
    generatedProject = await createProjectPackageFromQuote(id);
  }

  const paymentSchedule = normalizeQuotePaymentSchedule(quote.payment_plan, String(quote.currency || 'EUR'));

  return c.json({
    quote,
    generated_project: generatedProject,
    payment_schedule: paymentSchedule,
  });
});

quotes.post('/:id/generate-project', async (c) => {
  const id = c.req.param('id');
  const [quote] = await sql`
    SELECT id, status, generated_project_id
    FROM quotes
    WHERE id = ${id}
    LIMIT 1
  ` as Array<{ id: string; status: string; generated_project_id: string | null }>;

  if (!quote) return c.json({ error: 'Preventivo non trovato' }, 404);
  if (!['accepted', 'converted'].includes(quote.status)) {
    return c.json({ error: 'Progetto generabile solo da preventivo accettato' }, 400);
  }

  const result = await createProjectPackageFromQuote(id);
  return c.json(result, result.created ? 201 : 200);
});

quotes.post('/:id/payment-schedule', async (c) => {
  const id = c.req.param('id');
  const [quote] = await sql`
    SELECT id, currency, payment_plan
    FROM quotes
    WHERE id = ${id}
    LIMIT 1
  ` as Array<{ id: string; currency: string | null; payment_plan: unknown }>;

  if (!quote) return c.json({ error: 'Preventivo non trovato' }, 404);

  const schedule = normalizeQuotePaymentSchedule(quote.payment_plan, quote.currency || 'EUR');
  return c.json({
    quote_id: id,
    items: schedule,
  });
});

quotes.post('/:id/convert', async (c) => {
  const id = c.req.param('id');

  try {
    const [row] = await sql`SELECT convert_quote_to_invoice(${id}) AS invoice_id`;
    return c.json({ invoice_id: row.invoice_id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Errore durante la conversione';
    return c.json({ error: message }, 400);
  }
});

quotes.get('/:id/pdf', async (c) => {
  const id = c.req.param('id');
  const preview = c.req.query('preview') === 'true';

  const rows = await sql`
    SELECT q.*, to_jsonb(cu.*) AS customers
    FROM quotes q
    LEFT JOIN customers cu ON cu.id = q.customer_id
    WHERE q.id = ${id}
  `;
  if (!rows.length) return c.json({ error: 'Preventivo non trovato' }, 404);

  const q = rows[0] as Record<string, unknown>;
  const customer = (q.customers ?? {}) as Record<string, unknown>;

  const lineItems = Array.isArray(q.line_items) ? q.line_items as Array<Record<string, unknown>> : [];
  const scopeItems = Array.isArray(q.scope_items) ? q.scope_items as Array<Record<string, unknown>> : [];
  const revisionPolicy = isRecord(q.revision_policy) ? q.revision_policy : {};
  const paymentPlan = isRecord(q.payment_plan) ? q.payment_plan : {};
  const paymentPlanItems = Array.isArray(paymentPlan.items) ? paymentPlan.items as Array<Record<string, unknown>> : [];

  const isCompany = Boolean(customer.company_name);

  const offerte = lineItems.map((item, i) => ({
    id: `item_${i}`,
    nome: String(item.description || ''),
    descrizione: '',
    prezzo: (Number(item.quantity) || 1) * (Number(item.unit_price) || 0),
    consigliata: i === 0,
    include: scopeItems
      .filter((s: Record<string, unknown>) => s.title)
      .map((s: Record<string, unknown>) => `${s.title}${s.description ? ` — ${s.description}` : ''}`),
    esclude: [] as string[],
    note_extra: null as string | null,
  }));

  if (offerte.length === 1 && scopeItems.length > 0) {
    offerte[0].include = scopeItems.map((s) => `${s.title}${s.description ? ` — ${s.description}` : ''}`);
  }

  const modalita = paymentPlanItems.length > 0
    ? [{
        id: 'piano',
        nome: 'Piano di Pagamento',
        sconto_percentuale: 0,
        descrizione: '',
        rate: paymentPlanItems.map((item) => ({
          percentuale: (() => {
            const tot = Number(q.total) || 1;
            return Math.round((Number(item.amount) / tot) * 100);
          })(),
          momento: String(item.title || ''),
        })),
      }]
    : [];

  const preventivoJson = {
    meta: {
      numero_preventivo: String(q.quote_number || ''),
      data: q.issue_date ? String(q.issue_date).split('T')[0] : new Date().toISOString().split('T')[0],
      validita_giorni: q.valid_until
        ? Math.max(1, Math.round((new Date(String(q.valid_until)).getTime() - new Date(String(q.issue_date)).getTime()) / 86400000))
        : 30,
      tipo_cliente: isCompany ? 'azienda' : 'privato',
    },
    cliente: {
      ragione_sociale: String(customer.company_name || customer.contact_name || ''),
      nome_display: String(customer.company_name || customer.contact_name || ''),
      sottotitolo: customer.company_name ? String(customer.contact_name || '') : '',
      sede_legale: String(customer.address || ''),
      piva: String(customer.vat_number || ''),
      codice_fiscale: String(customer.fiscal_code || ''),
      codice_univoco_pec: String(customer.sdi_code || customer.pec || ''),
      legale_rappresentante: '',
      telefono: String(customer.phone || ''),
      email: String(customer.email || ''),
      sito_web: String(customer.website || ''),
    },
    documento: {
      titolo: String(q.title || 'Preventivo'),
      sottotitolo: 'Preventivo e Contratto di Incarico',
    },
    premessa: {
      testo: String(q.introduction || ''),
      statistiche: [],
      problemi_critici: [],
    },
    sezioni_extra: [],
    offerte,
    problemi_risolti: [],
    clausole_speciali: [] as Array<{ tipo: string; titolo: string; testo: string; lista: string[] }>,
    materiali_necessari: [] as string[],
    tempistiche: { prima_bozza: '', nota: '' },
    pagamento: { modalita },
    contratto_perimetro: {
      servizi: scopeItems.map((s) => String(s.title || '')).filter(Boolean),
      clausole: [] as string[],
    },
  };

  // Add notes/terms as clausole if present
  if (q.notes) {
    preventivoJson.clausole_speciali.push({
      tipo: 'info',
      titolo: 'Note',
      testo: String(q.notes),
      lista: [],
    });
  }
  if (q.terms) {
    preventivoJson.clausole_speciali.push({
      tipo: 'warning',
      titolo: 'Termini e Condizioni',
      testo: String(q.terms),
      lista: [],
    });
  }

  // Revision policy as clausola
  const includedRevisions = Number(revisionPolicy.included_revisions ?? 0);
  const extraFee = Number(revisionPolicy.extra_revision_fee ?? 0);
  if (includedRevisions > 0) {
    preventivoJson.clausole_speciali.push({
      tipo: 'info',
      titolo: 'Policy Revisioni',
      testo: `Il preventivo include ${includedRevisions} revision${includedRevisions === 1 ? 'e' : 'i'}. Revisioni aggiuntive: ${extraFee > 0 ? `€ ${extraFee.toFixed(2)} cadauna` : 'da concordare'}.`,
      lista: [],
    });
  }

  // Call Python generator
  const { execSync } = await import('child_process');
  const path = await import('path');

  const toolsDir = path.resolve(process.cwd(), '..', '..', 'tools', 'preventivi');
  const pythonBin = path.join(toolsDir, '.venv', 'bin', 'python3');

  try {
    if (preview) {
      const htmlResult = execSync(
        `${pythonBin} -c "import json, sys; from src.generator import render_html; from src.models import Preventivo; data = Preventivo.model_validate(json.load(sys.stdin)); print(render_html(data))"`,
        {
          input: JSON.stringify(preventivoJson),
          cwd: toolsDir,
          maxBuffer: 20 * 1024 * 1024,
          timeout: 15000,
        },
      );
      return c.html(htmlResult.toString());
    }

    const result = execSync(
      `${pythonBin} -m src from-stdin`,
      {
        input: JSON.stringify(preventivoJson),
        cwd: toolsDir,
        maxBuffer: 20 * 1024 * 1024,
        timeout: 30000,
      },
    );

    const slug = String(q.quote_number || id.slice(0, 8)).replace(/\//g, '-');
    const clientName = (String(customer.company_name || customer.contact_name || 'Cliente')).replace(/[^a-zA-Z0-9àèéìòù\s-]/g, '').replace(/\s+/g, '_');
    const filename = `Preventivo_${slug}_${clientName}.pdf`;

    return new Response(result, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(result.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Errore generazione PDF';
    console.error('PDF generation error:', message);
    return c.json({ error: 'Errore nella generazione del PDF. Assicurarsi che Python e weasyprint siano installati.' }, 500);
  }
});

quotes.delete('/:id', async (c) => {
  const id = c.req.param('id');

  const [quote] = await sql`SELECT status FROM quotes WHERE id = ${id}`;
  if (quote?.status !== 'draft') {
    return c.json({ error: 'Solo preventivi in bozza possono essere eliminati' }, 400);
  }

  await sql`DELETE FROM quotes WHERE id = ${id}`;
  return c.json({ success: true });
});
