import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { sql } from '../db';
import { stripe, isStripeConfigured } from '../lib/stripe';

export const customers = new Hono();

function stripPortalSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const { portal_access_code, portal_access_code_hash, _total_count, ...safe } = row;
  return { ...safe, _total_count };
}

async function prepareCustomerUpdate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const next = { ...body };
  delete next.portal_access_code_hash;

  if (typeof next.portal_access_code === 'string' && next.portal_access_code.trim()) {
    next.portal_access_code_hash = await bcrypt.hash(next.portal_access_code.trim(), 12);
    next.portal_access_code_rotated_at = new Date().toISOString();
  }
  delete next.portal_access_code;

  return next;
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
  const body = await c.req.json();
  const { company_name, contact_name, email, phone, billing_address, notes, tags, createOnStripe = true } = body;

  if (!contact_name || !email) {
    return c.json({ error: 'Nome e email richiesti' }, 400);
  }

  let stripeCustomerId: string | null = null;

  if (createOnStripe && isStripeConfigured()) {
    const sc = await stripe.customers.create({
      name: company_name || contact_name,
      email,
      phone: phone || undefined,
      address: billing_address ? {
        line1: billing_address.street,
        city: billing_address.city,
        postal_code: billing_address.postal_code,
        state: billing_address.province,
        country: billing_address.country || 'IT',
      } : undefined,
      metadata: { company_name: company_name || '' },
    });
    stripeCustomerId = sc.id;
  }

  const [customer] = await sql`
    INSERT INTO customers (company_name, contact_name, email, phone, billing_address, notes, tags, stripe_customer_id)
    VALUES (${company_name || null}, ${contact_name}, ${email}, ${phone || null}, ${billing_address || {}}, ${notes || null}, ${tags || []}, ${stripeCustomerId})
    RETURNING *
  `;

  return c.json({ customer }, 201);
});

customers.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const updates = await prepareCustomerUpdate(body);
  const [customer] = await sql`UPDATE customers SET ${sql(updates)} WHERE id = ${id} RETURNING *`;

  if (customer?.stripe_customer_id && isStripeConfigured()) {
    await stripe.customers.update(customer.stripe_customer_id as string, {
      name: body.company_name || body.contact_name,
      email: body.email,
      phone: body.phone || undefined,
    });
  }

  return c.json({ customer: stripPortalSecrets(customer) });
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
  const code = 'PRJ-' + randomBytes(4).toString('hex').toUpperCase();
  const hash = await bcrypt.hash(code, 12);

  const [customer] = await sql`
    UPDATE customers
    SET portal_access_code_hash = ${hash},
        portal_access_code_rotated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `;
  if (!customer) return c.json({ error: 'Cliente non trovato' }, 404);
  return c.json({ customer: { ...customer, portal_access_code: code } });
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

  const stripeCustomers = await stripe.customers.list({ limit: 100 });
  const syncResults = await Promise.allSettled(
    stripeCustomers.data
      .filter((sc) => !sc.deleted)
      .map((sc) =>
        sql`
          INSERT INTO customers (stripe_customer_id, contact_name, email, phone, company_name, status)
          VALUES (${sc.id}, ${sc.name || sc.email || 'Unknown'}, ${sc.email || ''}, ${sc.phone || null}, ${sc.metadata?.company_name || sc.name || null}, 'active')
          ON CONFLICT (stripe_customer_id) DO UPDATE SET
            contact_name = EXCLUDED.contact_name, email = EXCLUDED.email, phone = EXCLUDED.phone
        `
      )
  );
  for (const r of syncResults) {
    if (r.status === 'fulfilled') results.customers.synced++;
    else results.customers.errors++;
  }

  return c.json({ success: true, results });
});
