import { Hono } from 'hono';
import { z } from 'zod';
import postgres from 'postgres';
import { jsonb, sql } from '../db';
import { checkAndSendReminders } from './domain-cron';
import { parseDomainInput } from '../lib/domains/parse';
import { DomainRenewError, renewDomainNow } from '../lib/domains/renew';
import { addressListSchema } from '../lib/mail/message-schema';
import { presentDraft } from '../lib/mail/drafts';
import { draftProformaEmail } from '../lib/proforma/send';
import { createDomainRenewalDraft, issueProforma, presentProforma } from '../lib/proforma/service';
import { fieldError, isoDateSchema, parseOr400 } from '../lib/validation';

export const domains = new Hono();

domains.get('/', async (c) => {
  const status = c.req.query('status');
  const customerId = c.req.query('customer_id');
  const search = c.req.query('search');
  const registrar = c.req.query('registrar');
  const expiring = c.req.query('expiring');

  const statusFilter = status && status !== 'all' ? sql`AND d.status = ${status}` : sql``;
  const customerFilter = customerId ? sql`AND d.customer_id = ${customerId}` : sql``;
  const registrarFilter = registrar && registrar !== 'all' ? sql`AND d.registrar = ${registrar}` : sql``;
  const searchFilter = search
    ? sql`AND (d.domain_name ILIKE ${'%' + search + '%'} OR d.full_domain ILIKE ${'%' + search + '%'})`
    : sql``;

  let expiringFilter = sql``;
  if (expiring && Number.isFinite(parseInt(expiring))) {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + parseInt(expiring));
    expiringFilter = sql`AND d.expiration_date <= ${futureDate.toISOString().split('T')[0]}`;
  }

  const rows = await sql`
    SELECT d.*,
      jsonb_build_object('id', c.id, 'company_name', c.company_name, 'contact_name', c.contact_name, 'email', c.email) AS customers
    FROM domains d
    LEFT JOIN customers c ON c.id = d.customer_id
    WHERE 1=1 ${statusFilter} ${customerFilter} ${registrarFilter} ${searchFilter} ${expiringFilter}
    ORDER BY d.expiration_date ASC
  `;

  const now = new Date();
  const stats = {
    total: rows.length,
    active: rows.filter((d) => d.status === 'active').length,
    expired: rows.filter((d) => d.status === 'expired').length,
    expiring_soon: rows.filter((d) => {
      if (!d.expiration_date) return false;
      const diff = (new Date(d.expiration_date as string).getTime() - now.getTime()) / 86400000;
      return diff <= 30 && diff > 0;
    }).length,
    expiring_in_30_days: rows.filter((d) => {
      if (!d.expiration_date) return false;
      const diff = (new Date(d.expiration_date as string).getTime() - now.getTime()) / 86400000;
      return diff <= 30 && diff > 0;
    }).length,
  };

  return c.json({ domains: rows, count: rows.length, stats });
});

domains.get('/:id', async (c) => {
  const id = c.req.param('id');

  const domainRows = await sql`
    SELECT d.*,
      jsonb_build_object('id', c.id, 'company_name', c.company_name, 'contact_name', c.contact_name, 'email', c.email, 'phone', c.phone) AS customers
    FROM domains d
    LEFT JOIN customers c ON c.id = d.customer_id
    WHERE d.id = ${id}
  `;

  if (!domainRows.length) return c.json({ error: 'Dominio non trovato' }, 404);

  const [renewals, alerts] = await Promise.all([
    sql`SELECT * FROM domain_renewals WHERE domain_id = ${id} ORDER BY renewal_date DESC`,
    sql`SELECT * FROM domain_alerts WHERE domain_id = ${id} ORDER BY sent_at DESC`,
  ]);

  return c.json({ domain: domainRows[0], renewals, alerts });
});

// ─── Validazione di POST/PUT ───────────────────────────────
//
// Prima il body finiva così com'era in `INSERT INTO domains ${sql(body)}`: un
// campo sconosciuto diventava una colonna inesistente (42703 → 500), un
// obbligatorio mancante un 23502 senza nome del campo, e domain_name
// "crimatek.com" + tld "com" produceva full_domain "crimatek.com.com".

const DOMAIN_STATUSES = ['active', 'expired', 'expiring_soon', 'pending_transfer', 'pending_registration', 'redemption', 'suspended'] as const;
const SSL_STATUSES = ['none', 'lets_encrypt', 'cloudflare', 'custom', 'expired'] as const;

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optionalText = z.preprocess(emptyToNull, z.string().trim().nullable());
const optionalDate = z.preprocess(emptyToNull, isoDateSchema.nullable());
const money = z.preprocess(
  emptyToNull,
  z
    .union([z.number(), z.string().trim().regex(/^\d+([.,]\d{1,2})?$/, 'importo non valido (es. 15 o 15.50)')])
    .transform((v) => (typeof v === 'number' ? v : Number(v.replace(',', '.'))))
    .refine((v) => Number.isFinite(v) && v >= 0, 'importo non valido: deve essere ≥ 0')
    .nullable(),
);

const domainFields = {
  customer_id: z.string().uuid(),
  subscription_id: z.preprocess(emptyToNull, z.string().uuid().nullable()),
  domain_name: z.string(),
  tld: z.string(),
  full_domain: z.string(),
  registrar: optionalText,
  registrar_account: optionalText,
  dns_provider: optionalText,
  nameservers: z.array(z.string().trim().min(1)).max(13),
  registration_date: isoDateSchema,
  expiration_date: isoDateSchema,
  last_renewal_date: optionalDate,
  status: z.enum(DOMAIN_STATUSES),
  auto_renew: z.boolean(),
  whois_privacy: z.boolean(),
  ssl_status: z.enum(SSL_STATUSES),
  ssl_expiration: optionalDate,
  ssl_provider: optionalText,
  hosting_server: optionalText,
  ip_address: z.preprocess(emptyToNull, z.string().ip().nullable()),
  registration_cost: money,
  renewal_cost: money,
  currency: z.string().trim().length(3).toUpperCase(),
  notes: z.string().nullable(),
  metadata: z.record(z.unknown()),
};

/**
 * Creazione: customer_id, date e auto_renew obbligatori. auto_renew non ha
 * più un default implicito: per i domini rinnovati su proforma `true` era
 * sbagliato e silenzioso (il digest li mostrava come automatici).
 */
const domainCreateSchema = z
  .object(domainFields)
  .partial()
  .required({ customer_id: true, registration_date: true, expiration_date: true, auto_renew: true })
  .strict();

const domainUpdateSchema = z.object(domainFields).partial().strict();

/** Nomi sbagliati frequenti → campo giusto (suggerimento nel 400). */
const DOMAIN_FIELD_HINTS: Readonly<Record<string, string>> = {
  renewal_price: 'renewal_cost',
  registration_price: 'registration_cost',
  price: 'renewal_cost',
  cost: 'renewal_cost',
  domain: 'full_domain',
  name: 'domain_name',
  fqdn: 'full_domain',
  expiry_date: 'expiration_date',
  expires_at: 'expiration_date',
  expiry: 'expiration_date',
  expiration: 'expiration_date',
  registered_at: 'registration_date',
  registration: 'registration_date',
  customer: 'customer_id',
  autorenew: 'auto_renew',
  auto_renewal: 'auto_renew',
};

type DomainBody = z.output<typeof domainUpdateSchema>;

/** Colonne da scrivere: nome e TLD normalizzati, full_domain mai (colonna generata). */
function domainColumns(body: DomainBody, parsed?: { domain_name: string; tld: string }): Record<string, unknown> {
  const { full_domain: _full, domain_name: _name, tld: _tld, metadata, nameservers, ...rest } = body;
  const cols: Record<string, unknown> = { ...rest };
  if (parsed) {
    cols.domain_name = parsed.domain_name;
    cols.tld = parsed.tld;
  }
  if (metadata !== undefined) cols.metadata = jsonb(metadata);
  if (nameservers !== undefined) cols.nameservers = jsonb(nameservers);
  return cols;
}

async function assertCustomerExists(customerId: string): Promise<void> {
  const [row] = await sql`SELECT 1 FROM customers WHERE id = ${customerId}`;
  if (!row) throw fieldError(['customer_id'], 'cliente inesistente');
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof postgres.PostgresError && err.code === '23505';
}

domains.post('/', async (c) => {
  const raw = await c.req.json().catch(() => {
    throw fieldError([], 'body JSON non valido');
  });
  const body = parseOr400(domainCreateSchema, raw, DOMAIN_FIELD_HINTS);
  const parsed = parseDomainInput(body);
  if (!parsed.ok) throw fieldError([parsed.field], parsed.error);
  await assertCustomerExists(body.customer_id);

  try {
    const [domain] = await sql`
      INSERT INTO domains ${sql({ ...domainColumns(body, parsed), status: body.status ?? 'active' })} RETURNING *
    `;
    return c.json({ domain }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) throw fieldError(['full_domain'], `il dominio ${parsed.domain_name}.${parsed.tld} esiste già`);
    throw err;
  }
});

domains.put('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json().catch(() => {
    throw fieldError([], 'body JSON non valido');
  });
  const body = parseOr400(domainUpdateSchema, raw, DOMAIN_FIELD_HINTS);
  if (!Object.keys(body).length) throw fieldError([], 'nessun campo da aggiornare');

  const [current] = await sql<Array<{ domain_name: string; tld: string }>>`SELECT domain_name, tld FROM domains WHERE id = ${id}`;
  if (!current) return c.json({ error: 'Dominio non trovato' }, 404);

  let parsed: { domain_name: string; tld: string } | undefined;
  if (body.full_domain !== undefined || body.domain_name !== undefined || body.tld !== undefined) {
    const input = body.full_domain !== undefined
      ? { full_domain: body.full_domain, domain_name: body.domain_name, tld: body.tld }
      : body.domain_name !== undefined
        ? { domain_name: body.domain_name, tld: body.tld ?? (body.domain_name.includes('.') ? undefined : current.tld) }
        : { domain_name: current.domain_name, tld: body.tld };
    const result = parseDomainInput(input);
    if (!result.ok) throw fieldError([result.field], result.error);
    parsed = result;
  }
  if (body.customer_id) await assertCustomerExists(body.customer_id);

  try {
    const [domain] = await sql`UPDATE domains SET ${sql(domainColumns(body, parsed))} WHERE id = ${id} RETURNING *`;
    return c.json({ domain });
  } catch (err) {
    if (isUniqueViolation(err) && parsed) throw fieldError(['full_domain'], `il dominio ${parsed.domain_name}.${parsed.tld} esiste già`);
    throw err;
  }
});

domains.delete('/:id', async (c) => {
  await sql`DELETE FROM domains WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

const renewSchema = z
  .object({
    years: z.number().int().min(1).max(10).default(1),
    cost: money,
    invoice_id: z.string().uuid().optional(),
    notes: z.string().max(500).optional(),
  })
  .partial({ cost: true })
  .strict();

// POST /api/domains/:id/renew — rinnovo manuale (lib/domains/renew.ts: scadenza
// in SQL dalla precedente, reset delle milestone degli alert, storico).
domains.post('/:id/renew', async (c) => {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw fieldError([], 'body JSON non valido');
    }
  }
  const body = parseOr400(renewSchema, raw, DOMAIN_FIELD_HINTS);
  try {
    const result = await renewDomainNow(c.req.param('id'), {
      years: body.years,
      cost: body.cost ?? null,
      invoiceId: body.invoice_id ?? null,
      notes: body.notes ?? null,
    });
    return c.json({
      domain: result.domain,
      renewal: { ...result.renewal, new_expiration: result.renewal.expiration_after },
    });
  } catch (err) {
    if (err instanceof DomainRenewError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

const domainProformaSchema = z
  .object({
    years: z.number().int().min(1).max(10).optional(),
    unit_price: z.number().positive().optional(),
    due_days: z.number().int().min(0).max(365).optional(),
    notes: z.string().max(2000).optional(),
    /** Numero indicato a mano (3, "3/2026", "PF 3/2026"); senza, il prossimo progressivo. */
    number: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
    issue_date: isoDateSchema.optional(),
    /** false = resta in bozza. Default true: numero e PDF subito. */
    issue: z.boolean().optional(),
    /** 'draft' = bozza email in Posta con il PDF allegato. L'invio vero è POST /api/proformas/:id/send (OTP via MCP). */
    delivery: z.enum(['none', 'draft']).optional(),
    account_id: z.string().uuid().optional(),
    to: addressListSchema.optional(),
    cc: addressListSchema.optional(),
    subject: z.string().max(998).optional(),
    text: z.string().max(20_000).optional(),
  })
  .strict();

// POST /api/domains/:id/proforma — proforma di rinnovo del dominio (riga
// domain_renewal collegata): al pagamento la scadenza si aggiorna da sola.
domains.post('/:id/proforma', async (c) => {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw fieldError([], 'body JSON non valido');
    }
  }
  const body = parseOr400(domainProformaSchema, raw, { price: 'unit_price', renewal_price: 'unit_price', renewal_cost: 'unit_price', send: 'delivery' });
  if (body.delivery === 'draft' && body.issue === false) throw fieldError(['delivery'], 'una bozza email richiede la proforma emessa (issue: true)');

  const draft = await createDomainRenewalDraft(c.req.param('id'), {
    years: body.years,
    unit_price: body.unit_price,
    due_days: body.due_days,
    notes: body.notes,
  });
  if (body.issue === false) return c.json({ proforma: presentProforma(draft) }, 201);

  const issued = await issueProforma(draft.id, { number: body.number, issue_date: body.issue_date });
  const response: Record<string, unknown> = { proforma: presentProforma(issued.proforma) };
  if (issued.pdf_error) response.pdf_error = issued.pdf_error;
  if (body.delivery === 'draft' && !issued.pdf_error) {
    const { draft: mailDraft } = await draftProformaEmail(draft.id, {
      account_id: body.account_id, to: body.to, cc: body.cc, subject: body.subject, text: body.text,
    });
    response.draft = presentDraft(mailDraft);
    response.open_url = `/posta?draft=${mailDraft.id}`;
  }
  return c.json(response, 201);
});

domains.post('/send-reminders', async (c) => {
  try {
    const result = await checkAndSendReminders();
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});
