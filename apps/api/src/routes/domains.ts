import { Hono } from 'hono';
import { z } from 'zod';
import postgres from 'postgres';
import { jsonb, sql } from '../db';
import { checkAndSendReminders } from './domain-cron';
import { parseDomainInput } from '../lib/domains/parse';
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

domains.post('/:id/renew', async (c) => {
  const id = c.req.param('id');
  const { years = 1, cost } = await c.req.json();

  const [domain] = await sql`SELECT expiration_date, renewal_cost FROM domains WHERE id = ${id}`;
  if (!domain) return c.json({ error: 'Dominio non trovato' }, 404);

  const newExpiration = new Date(domain.expiration_date as string || new Date());
  newExpiration.setFullYear(newExpiration.getFullYear() + years);
  const newExpirationStr = newExpiration.toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];

  const [updated] = await sql`
    UPDATE domains SET
      expiration_date = ${newExpirationStr},
      last_renewal_date = ${today},
      status = 'active'
    WHERE id = ${id} RETURNING *
  `;

  await sql`
    INSERT INTO domain_renewals ${sql({
      domain_id: id,
      renewal_date: today,
      expiration_before: domain.expiration_date,
      expiration_after: newExpirationStr,
      cost: cost || domain.renewal_cost,
    })}
  `;

  return c.json({ domain: updated, renewal: { new_expiration: newExpirationStr } });
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
