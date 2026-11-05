import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { jsonb, sql } from '../db';
import { stripe, isStripeConfigured } from '../lib/stripe';
import { CALDES_ORIGIN_METADATA } from '../lib/stripe-customer-sync';
import { billingEmailsSchema } from '../lib/customer-recipients';
import { mergePatch } from '../lib/json-merge-patch';
import {
  dropLegacyKeys,
  fiscalSchemas,
  resolveFiscalInput,
  withFiscalInBillingAddress,
  type FiscalColumn,
} from '../lib/customers/fiscal';
import { fieldError, parseOr400 } from '../lib/validation';
import { logger } from '../lib/logger';
import { sendEmail } from '../lib/email';
import { canSendWhatsApp } from '../lib/whatsapp-policy';
import { sendWhatsAppText } from '../lib/whatsapp';

export const customers = new Hono();

/**
 * Cliente per le risposte: niente segreti del portale; P.IVA, CF, SDI e PEC
 * (colonne dalla 169) anche dentro billing_address per i client che li
 * leggevano da lì.
 */
function stripPortalSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const { portal_access_code, portal_access_code_hash, _total_count, ...safe } = row;
  return { ...withFiscalInBillingAddress(safe), has_portal_access: Boolean(portal_access_code_hash), _total_count };
}

const log = logger.child({ scope: 'customers' });

/** Valore JSON ammesso in billing_address (oggetto piatto o annidato). */
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]),
);

const optionalText = z
  .string()
  .nullable()
  .transform((v) => (typeof v === 'string' && v.trim() === '' ? null : v));

const emailOrNull = z
  .string()
  .trim()
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isValidEmail(v), 'indirizzo email non valido');

/** Nomi sbagliati frequenti → campo giusto (suggerimento nel 400). */
const CUSTOMER_FIELD_HINTS: Readonly<Record<string, string>> = {
  vat: 'vat_number',
  piva: 'vat_number',
  partita_iva: 'vat_number',
  codice_fiscale: 'fiscal_code',
  cf: 'fiscal_code',
  sdi: 'sdi_code',
  codice_destinatario: 'sdi_code',
  codice_sdi: 'sdi_code',
  pec_email: 'pec',
  address: 'billing_address',
  name: 'contact_name',
  company: 'company_name',
  billing_email: 'billing_emails',
  emails: 'billing_emails',
};

/**
 * Campi scrivibili con PUT /api/customers/:id. Un campo sconosciuto è un 400
 * che lo nomina (prima arrivava a Postgres come colonna inesistente: 500).
 * billing_address è un JSON Merge Patch (RFC 7396): le chiavi presenti
 * sostituiscono quelle salvate, una chiave a null le rimuove, le altre
 * restano. Un PUT senza billing_address non lo tocca.
 */
const customerUpdateSchema = z
  .object({
    company_name: optionalText,
    contact_name: z.string().trim().min(1),
    email: emailOrNull,
    phone: optionalText,
    billing_address: z.record(jsonValue),
    billing_emails: billingEmailsSchema,
    vat_number: fiscalSchemas.vat_number,
    fiscal_code: fiscalSchemas.fiscal_code,
    sdi_code: fiscalSchemas.sdi_code,
    pec: fiscalSchemas.pec,
    notes: z.string().nullable(),
    tags: z.array(z.string()).max(50),
    status: z.enum(['active', 'inactive', 'suspended']),
    portal_logo: optionalText,
    portal_access_code: z.string(),
    lead_id: z.string().uuid().nullable(),
    stripe_customer_id: optionalText,
  })
  .partial()
  .strict();

const customerCreateSchema = z
  .object({
    company_name: optionalText.optional(),
    contact_name: z.string().trim().min(1),
    email: emailOrNull.optional(),
    phone: optionalText.optional(),
    billing_address: z.record(jsonValue).optional(),
    billing_emails: billingEmailsSchema.optional(),
    vat_number: fiscalSchemas.vat_number.optional(),
    fiscal_code: fiscalSchemas.fiscal_code.optional(),
    sdi_code: fiscalSchemas.sdi_code.optional(),
    pec: fiscalSchemas.pec.optional(),
    notes: z.string().nullable().optional(),
    tags: z.array(z.string()).max(50).optional(),
    createOnStripe: z.boolean().optional(),
  })
  .strict();

type CustomerUpdate = z.output<typeof customerUpdateSchema>;

async function prepareCustomerUpdate(body: CustomerUpdate): Promise<Record<string, unknown>> {
  const { billing_address: _patch, portal_access_code, tags, vat_number: _v, fiscal_code: _f, sdi_code: _s, pec: _p, ...rest } = body;
  const next: Record<string, unknown> = { ...rest };

  if (tags !== undefined) next.tags = jsonb(tags);
  if (typeof portal_access_code === 'string' && portal_access_code.trim()) {
    next.portal_access_code_hash = await bcrypt.hash(portal_access_code.trim(), 12);
    next.portal_access_code_rotated_at = new Date().toISOString();
  }

  return next;
}

function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function portalBaseUrl(): string {
  return (process.env.PORTAL_URL || process.env.SITE_URL || 'https://calicchia.design').replace(/\/$/, '');
}

function buildPortalAccessMessage(opts: { name: string | null; link: string; code: string }): string {
  const greeting = opts.name?.trim() ? `Ciao ${opts.name.trim()},` : 'Ciao,';
  return [
    greeting,
    '',
    'ti ho preparato l\'accesso alla tua area clienti Calicchia Design.',
    `Link diretto: ${opts.link}`,
    `Codice accesso: ${opts.code}`,
    '',
    'Conserva questo messaggio: il link contiene il codice di accesso personale.',
  ].join('\n');
}

async function rotateCustomerPortalCode(id: string): Promise<{ id: string; code: string } | null> {
  // 128-bit entropy (audit B-010): randomBytes(16) base64url-encoded gives
  // ~22 chars vs the previous 4-byte hex (32-bit, brute-forceable with botnet).
  // 'PRJ-' kept intentionally so existing onboarding emails don't break — the
  // type-leak risk is acceptable trade-off.
  const random = randomBytes(16).toString('base64url');
  const code = 'PRJ-' + random;
  const hash = await bcrypt.hash(code, 12);
  // First 4 chars of the random part feed an indexed lookup (audit B-009 —
  // findActorByCode used to bcrypt-scan every row; now filters by prefix first).
  const prefix = random.slice(0, 4);

  // Bump session_version atomically so any cookie still authenticating with the
  // old code (typical scenario: code leaked, admin clicks "Rigenera") is
  // invalidated by the portalAuth middleware on the next request. Without this
  // the new code lived alongside the old session cookie until natural expiry
  // (audit B-007).
  const [customer] = await sql`
    UPDATE customers
    SET portal_access_code_hash = ${hash},
        portal_access_code_prefix = ${prefix},
        portal_access_code_rotated_at = NOW(),
        session_version = session_version + 1
    WHERE id = ${id}
    RETURNING id
  `;
  if (!customer) return null;
  return { id: customer.id as string, code };
}

customers.get('/', async (c) => {
  const status = c.req.query('status');
  const search = c.req.query('search');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const statusFilter = status && status !== 'all' ? sql`AND c.status = ${status}` : sql``;
  const searchFilter = search
    ? sql`AND (c.contact_name ILIKE ${'%' + search + '%'} OR c.company_name ILIKE ${'%' + search + '%'} OR c.email ILIKE ${'%' + search + '%'})`
    : sql``;

  const [customers, allStatuses] = await Promise.all([
    sql`
      SELECT c.*,
        COUNT(*) OVER() AS _total_count,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', s.id, 'name', s.name, 'status', s.status, 'amount', s.amount, 'next_billing_date', s.next_billing_date))
          FILTER (WHERE s.id IS NOT NULL), '[]'
        ) AS subscriptions,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', i.id, 'total', i.total, 'status', i.status, 'issue_date', i.issue_date))
          FILTER (WHERE i.id IS NOT NULL), '[]'
        ) AS invoices
      FROM customers c
      LEFT JOIN subscriptions s ON s.customer_id = c.id
      LEFT JOIN invoices i ON i.customer_id = c.id
      WHERE 1=1 ${statusFilter} ${searchFilter}
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql`SELECT status FROM customers`,
  ]);

  const count = customers[0]?._total_count ? parseInt(customers[0]._total_count as string) : 0;
  const cleaned = customers.map((c) => ({ ...stripPortalSecrets(c), _total_count: undefined }));

  const stats = {
    total: allStatuses.length,
    active: allStatuses.filter((c) => c.status === 'active').length,
    inactive: allStatuses.filter((c) => c.status === 'inactive').length,
    suspended: allStatuses.filter((c) => c.status === 'suspended').length,
  };

  return c.json({ customers: cleaned, count, stats });
});

customers.get('/:id', async (c) => {
  const id = c.req.param('id');

  const rows = await sql`
    SELECT c.*,
      COALESCE(json_agg(DISTINCT to_jsonb(s.*)) FILTER (WHERE s.id IS NOT NULL), '[]') AS subscriptions,
      COALESCE(json_agg(DISTINCT to_jsonb(i.*)) FILTER (WHERE i.id IS NOT NULL), '[]') AS invoices,
      COALESCE(json_agg(DISTINCT to_jsonb(d.*)) FILTER (WHERE d.id IS NOT NULL), '[]') AS domains
    FROM customers c
    LEFT JOIN subscriptions s ON s.customer_id = c.id
    LEFT JOIN invoices i ON i.customer_id = c.id
    LEFT JOIN domains d ON d.customer_id = c.id
    WHERE c.id = ${id}
    GROUP BY c.id
  `;

  if (!rows.length) return c.json({ error: 'Cliente non trovato' }, 404);
  return c.json({ customer: stripPortalSecrets(rows[0]) });
});

customers.post('/', async (c) => {
  const raw = await c.req.json().catch(() => {
    throw fieldError([], 'body JSON non valido');
  });
  const body = parseOr400(customerCreateSchema, raw, CUSTOMER_FIELD_HINTS);
  const { company_name, contact_name, billing_emails, notes, tags, createOnStripe = true } = body;
  const { addressPatch, fiscal } = resolveFiscalInput(body);
  const billing_address = addressPatch;
  const normalizedEmail = body.email ?? '';
  const normalizedPhone = body.phone?.trim() ?? '';

  if (!normalizedEmail && !normalizedPhone) {
    return c.json({ error: 'Nome e almeno un contatto tra email e telefono richiesti' }, 400);
  }

  let stripeCustomerId: string | null = null;

  if (createOnStripe && isStripeConfigured()) {
    const sc = await stripe.customers.create({
      name: company_name || contact_name,
      email: normalizedEmail || undefined,
      phone: normalizedPhone || undefined,
      address: billing_address ? {
        line1: typeof billing_address.street === 'string' ? billing_address.street : undefined,
        city: typeof billing_address.city === 'string' ? billing_address.city : undefined,
        postal_code: typeof billing_address.postal_code === 'string' ? billing_address.postal_code : undefined,
        state: typeof billing_address.province === 'string' ? billing_address.province : undefined,
        country: typeof billing_address.country === 'string' ? billing_address.country : 'IT',
      } : undefined,
      // caldes_origin: il webhook customer.created non deve inserire un
      // duplicato prima che questa POST salvi il cliente (stripe-customer-sync).
      metadata: { company_name: company_name || '', ...CALDES_ORIGIN_METADATA },
    });
    stripeCustomerId = sc.id;
  }

  const [customer] = await sql`
    INSERT INTO customers (company_name, contact_name, email, phone, billing_address, billing_emails, notes, tags, stripe_customer_id,
                           vat_number, fiscal_code, sdi_code, pec)
    VALUES (${company_name || null}, ${contact_name}, ${normalizedEmail || null}, ${normalizedPhone || null}, ${jsonb(billing_address ?? {})}, ${billing_emails ?? []}::text[], ${notes || null}, ${jsonb(tags ?? [])}, ${stripeCustomerId},
            ${fiscal.vat_number ?? null}, ${fiscal.fiscal_code ?? null}, ${fiscal.sdi_code ?? null}, ${fiscal.pec ?? null})
    RETURNING *
  `;

  return c.json({ customer: stripPortalSecrets(customer) }, 201);
});

customers.put('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json().catch(() => {
    throw fieldError([], 'body JSON non valido');
  });
  const body = parseOr400(customerUpdateSchema, raw, CUSTOMER_FIELD_HINTS);
  if (!Object.keys(body).length) throw fieldError([], 'nessun campo da aggiornare');

  const updates = await prepareCustomerUpdate(body);
  const { addressPatch, fiscal } = resolveFiscalInput(body);
  Object.assign(updates, fiscal);
  const fiscalWritten = Object.keys(fiscal) as FiscalColumn[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
  const customer = await sql.begin(async (tx: any) => {
    const [current] = await tx`SELECT billing_address FROM customers WHERE id = ${id} FOR UPDATE`;
    if (!current) return null;
    if (addressPatch !== undefined || fiscalWritten.length) {
      // Le colonne fiscali scritte tolgono l'eventuale valore legacy dal jsonb,
      // altrimenti il fallback dei lettori lo farebbe ricomparire.
      const merged = mergePatch(current.billing_address ?? {}, addressPatch ?? {}) as Record<string, unknown>;
      updates.billing_address = jsonb(dropLegacyKeys(merged, fiscalWritten));
    }
    const [row] = await tx`UPDATE customers SET ${tx(updates)} WHERE id = ${id} RETURNING *`;
    return row as Record<string, unknown>;
  });
  if (!customer) return c.json({ error: 'Cliente non trovato' }, 404);

  const warnings: string[] = [];
  const stripeFields: { name?: string; email?: string; phone?: string } = {};
  if (body.company_name || body.contact_name) stripeFields.name = (body.company_name || body.contact_name) as string;
  if (body.email) stripeFields.email = body.email;
  if (body.phone) stripeFields.phone = body.phone;
  if (customer.stripe_customer_id && isStripeConfigured() && Object.keys(stripeFields).length) {
    // Il webhook customer.updated che ne deriva applica solo i campi cambiati
    // (previous_attributes): non riscrive più billing_address né i nomi.
    try {
      await stripe.customers.update(customer.stripe_customer_id as string, stripeFields);
    } catch (err) {
      log.warn({ err, customerId: id }, 'sincronizzazione Stripe del cliente fallita');
      warnings.push(`Cliente salvato, ma l'aggiornamento su Stripe non è riuscito: ${(err as Error).message}`);
    }
  }

  return c.json({ customer: stripPortalSecrets(customer), ...(warnings.length ? { warnings } : {}) });
});

customers.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await sql`UPDATE customers SET status = 'inactive' WHERE id = ${id}`;
  return c.json({ success: true });
});

customers.post('/:id/portal', async (c) => {
  const id = c.req.param('id');
  const [customer] = await sql`SELECT stripe_customer_id FROM customers WHERE id = ${id}`;

  if (!customer?.stripe_customer_id) {
    return c.json({ error: 'Cliente non collegato a Stripe' }, 400);
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customer.stripe_customer_id as string,
    return_url: c.req.header('referer') || 'http://localhost:5173/customers',
  });
  return c.json({ url: session.url });
});

// POST /api/customers/:id/stripe-sync — link the customer to their existing
// Stripe customer and backfill subscriptions created directly on Stripe
// (e.g. historical "gestione annua" plans that predate the gestionale).
// Candidates: the stored stripe_customer_id + every Stripe customer with the
// same email. Subscriptions are upserted with the same mapping as the
// customer.subscription.* webhook, which then keeps them updated; the local
// record is repointed to the Stripe customer that owns live subscriptions so
// future webhook events resolve to this customer.
customers.post('/:id/stripe-sync', async (c) => {
  if (!isStripeConfigured()) return c.json({ error: 'Stripe non configurato' }, 503);
  const id = c.req.param('id');
  const [customer] = await sql`SELECT id, email, stripe_customer_id FROM customers WHERE id = ${id}`;
  if (!customer) return c.json({ error: 'Cliente non trovato' }, 404);

  const email = String(customer.email || '').trim().toLowerCase();
  const candidateIds = new Set<string>();
  if (customer.stripe_customer_id) candidateIds.add(String(customer.stripe_customer_id));
  if (email) {
    // Auto-paginate: don't cap at the first 20 Stripe customers for this email.
    for await (const sc of stripe.customers.list({ email, limit: 20 })) {
      candidateIds.add(sc.id);
    }
  }
  if (!candidateIds.size) {
    return c.json({ error: 'Nessun cliente Stripe trovato (email mancante o non registrata su Stripe)' }, 404);
  }

  let synced = 0;
  let linkedStripeId = customer.stripe_customer_id ? String(customer.stripe_customer_id) : null;
  // Product names resolved separately: expanding data.items.data.price.product
  // on subscriptions.list exceeds Stripe's 4-level expand limit.
  const productNames = new Map<string, string>();

  for (const stripeCustomerId of candidateIds) {
    // Auto-paginate over ALL subscriptions for this customer (not just 100).
    let hasLiveSub = false;
    for await (const subscription of stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'all',
      limit: 100,
    })) {
      const item = subscription.items.data[0];
      const rawProduct = item?.price?.product;
      const productId = typeof rawProduct === 'string'
        ? rawProduct
        : rawProduct && 'id' in rawProduct ? String(rawProduct.id) : null;
      if (productId && !productNames.has(productId)) {
        try {
          const product = await stripe.products.retrieve(productId);
          productNames.set(productId, ('name' in product && product.name) || 'Abbonamento');
        } catch {
          productNames.set(productId, 'Abbonamento');
        }
      }
      await sql`
        INSERT INTO subscriptions ${sql({
          stripe_subscription_id: subscription.id,
          customer_id: customer.id,
          provider: 'stripe',
          stripe_price_id: item?.price?.id,
          name: (productId && productNames.get(productId)) || 'Abbonamento',
          amount: (item?.price?.unit_amount || 0) / 100,
          currency: item?.price?.currency?.toUpperCase() || 'EUR',
          billing_interval: item?.price?.recurring?.interval || 'year',
          status: subscription.status,
          start_date: new Date(subscription.start_date * 1000).toISOString().split('T')[0],
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString().split('T')[0],
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString().split('T')[0],
          next_billing_date: new Date(subscription.current_period_end * 1000).toISOString().split('T')[0],
          canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000).toISOString() : null,
          auto_renew: !subscription.cancel_at_period_end,
        })}
        ON CONFLICT (stripe_subscription_id) DO UPDATE SET
          customer_id = EXCLUDED.customer_id,
          status = EXCLUDED.status,
          current_period_start = EXCLUDED.current_period_start,
          current_period_end = EXCLUDED.current_period_end,
          next_billing_date = EXCLUDED.next_billing_date,
          canceled_at = EXCLUDED.canceled_at,
          auto_renew = EXCLUDED.auto_renew
      `;
      if (['active', 'trialing', 'past_due'].includes(subscription.status)) {
        hasLiveSub = true;
      }
      synced += 1;
    }

    // The Stripe customer owning live subscriptions is the authoritative link.
    if (hasLiveSub) {
      linkedStripeId = stripeCustomerId;
    }
  }

  if (linkedStripeId && linkedStripeId !== customer.stripe_customer_id) {
    await sql`UPDATE customers SET stripe_customer_id = ${linkedStripeId}, updated_at = now() WHERE id = ${id}`;
  }

  return c.json({
    success: true,
    stripe_customer_id: linkedStripeId,
    stripe_customers_checked: candidateIds.size,
    subscriptions_synced: synced,
  });
});

customers.post('/:id/payment-link', async (c) => {
  const id = c.req.param('id');
  const { type, priceId, amount, description } = await c.req.json();
  const [customer] = await sql`SELECT stripe_customer_id, email FROM customers WHERE id = ${id}`;

  if (!customer) return c.json({ error: 'Cliente non trovato' }, 404);

  let url: string;
  if (type === 'subscription' && priceId) {
    const session = await stripe.checkout.sessions.create({
      customer: customer.stripe_customer_id || undefined,
      customer_email: customer.stripe_customer_id ? undefined : customer.email as string,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://calicchia.design/pagamento/successo',
      cancel_url: 'https://calicchia.design/pagamento/annullato',
    });
    url = session.url!;
  } else if (amount) {
    const session = await stripe.checkout.sessions.create({
      customer: customer.stripe_customer_id || undefined,
      customer_email: customer.stripe_customer_id ? undefined : customer.email as string,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: description || 'Pagamento' },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: 'https://calicchia.design/pagamento/successo',
      cancel_url: 'https://calicchia.design/pagamento/annullato',
    });
    url = session.url!;
  } else {
    return c.json({ error: 'Parametri non validi' }, 400);
  }

  return c.json({ url });
});

customers.post('/:id/generate-portal-code', async (c) => {
  const id = c.req.param('id');
  const customer = await rotateCustomerPortalCode(id);
  if (!customer) return c.json({ error: 'Cliente non trovato' }, 404);
  return c.json({ customer: { id: customer.id, portal_access_code: customer.code } });
});

customers.post('/:id/send-portal-access', async (c) => {
  const id = c.req.param('id');
  const rows = await sql`
    SELECT id, contact_name, company_name, email, phone
    FROM customers
    WHERE id = ${id}
    LIMIT 1
  ` as Array<{
    id: string;
    contact_name: string | null;
    company_name: string | null;
    email: string | null;
    phone: string | null;
  }>;
  const current = rows[0];
  if (!current) return c.json({ error: 'Cliente non trovato' }, 404);
  if (!current.email && !current.phone) {
    return c.json({ error: 'Il cliente non ha email o telefono per ricevere l\'accesso' }, 422);
  }

  const access = await rotateCustomerPortalCode(id);
  if (!access) return c.json({ error: 'Cliente non trovato' }, 404);

  const link = `${portalBaseUrl()}/clienti/p/${encodeURIComponent(access.code)}`;
  const name = current.contact_name || current.company_name;

  if (current.email) {
    const message = buildPortalAccessMessage({ name, link, code: access.code });
    const email = await sendEmail({
      to: current.email,
      subject: 'Accesso area clienti - Calicchia Design',
      html: message.replace(/\n/g, '<br />'),
      text: message,
      transport: 'critical',
    });
    if (!email.success) return c.json({ error: 'Invio email accesso portale fallito' }, 502);
    return c.json({ channel: 'email', to: current.email, portal_access_code: access.code, link });
  }

  const phone = current.phone;
  if (!phone) return c.json({ error: 'Il cliente non ha telefono per ricevere l\'accesso' }, 422);
  const policy = await canSendWhatsApp(phone, 'transactional', { customerId: current.id });
  if (!policy.allowed) {
    return c.json({ error: 'Invio WhatsApp non consentito', reason: policy.reason }, 422);
  }
  const message = buildPortalAccessMessage({ name, link, code: access.code });
  const result = await sendWhatsAppText(phone, message);
  if (!result.success) return c.json({ error: 'Invio WhatsApp accesso portale fallito' }, 502);
  return c.json({ channel: 'whatsapp', to: phone, portal_access_code: access.code, link });
});

// ── Revoke all portal sessions for a customer ─────────────
// Bumps customers.session_version → every JWT carrying the old version is
// rejected by portalAuth middleware on next request. Forces re-login.
customers.post('/:id/revoke-portal-sessions', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql`
    UPDATE customers
    SET session_version = session_version + 1
    WHERE id = ${id}
    RETURNING id, email, session_version
  ` as Array<{ id: string; email: string; session_version: number }>;

  if (!row) return c.json({ error: 'Cliente non trovato' }, 404);

  // Best-effort audit
  try {
    await sql`
      INSERT INTO portal_login_events (customer_id, email, event_type, success, ip, user_agent)
      VALUES (${row.id}, ${row.email}, 'sessions_revoked', true,
              ${c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null},
              ${c.req.header('user-agent') ?? null})
    `;
  } catch {
    /* non-blocking */
  }

  return c.json({ ok: true, session_version: row.session_version });
});

customers.post('/sync-stripe', async (c) => {
  if (!isStripeConfigured()) return c.json({ error: 'Stripe non configurato' }, 503);

  const results = { customers: { synced: 0, errors: 0 }, subscriptions: { synced: 0, errors: 0 }, invoices: { synced: 0, errors: 0 } };

  // Auto-paginate over ALL Stripe customers — a single list({limit:100}) call
  // silently dropped everyone past the first 100 while still reporting success.
  for await (const sc of stripe.customers.list({ limit: 100 })) {
    if (sc.deleted) continue;
    try {
      await sql`
        INSERT INTO customers (stripe_customer_id, contact_name, email, phone, company_name, status)
        VALUES (${sc.id}, ${sc.name || sc.email || 'Unknown'}, ${sc.email || ''}, ${sc.phone || null}, ${sc.metadata?.company_name || sc.name || null}, 'active')
        ON CONFLICT (stripe_customer_id) DO UPDATE SET
          contact_name = EXCLUDED.contact_name, email = EXCLUDED.email, phone = EXCLUDED.phone
      `;
      results.customers.synced++;
    } catch {
      results.customers.errors++;
    }
  }

  return c.json({ success: true, results });
});
