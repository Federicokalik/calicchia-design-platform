import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { sql } from '../db';
import { stripe, isStripeConfigured } from '../lib/stripe';

export const collaborators = new Hono();

function stripPortalSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const { portal_access_code, portal_access_code_hash, _total_count, ...safe } = row;
  return { ...safe, _total_count };
}

async function prepareCollaboratorUpdate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const next = { ...body };
  delete next.portal_access_code_hash;

  if (typeof next.portal_access_code === 'string' && next.portal_access_code.trim()) {
    next.portal_access_code_hash = await bcrypt.hash(next.portal_access_code.trim(), 12);
  }
  delete next.portal_access_code;

  return next;
}

collaborators.get('/', async (c) => {
  const status = c.req.query('status');
  const search = c.req.query('search');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const statusFilter = status && status !== 'all' ? sql`AND c.status = ${status}` : sql``;
  const searchFilter = search
    ? sql`AND (c.contact_name ILIKE ${'%' + search + '%'} OR c.company_name ILIKE ${'%' + search + '%'} OR c.email ILIKE ${'%' + search + '%'})`
    : sql``;

  const [collaboratorRows, allStatuses] = await Promise.all([
    sql`
      SELECT c.*, COUNT(*) OVER() AS _total_count,
        COUNT(p.id) FILTER (WHERE p.collaborator_id IS NOT NULL) AS project_count
      FROM collaborators c
      LEFT JOIN client_projects p ON p.collaborator_id = c.id
      WHERE 1=1 ${statusFilter} ${searchFilter}
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql`SELECT status FROM collaborators`,
  ]);

  const count = collaboratorRows[0]?._total_count ? parseInt(collaboratorRows[0]._total_count as string) : 0;
  const cleaned = collaboratorRows.map((c) => ({ ...stripPortalSecrets(c), _total_count: undefined }));

  const stats = {
    total: allStatuses.length,
    active: allStatuses.filter((c) => c.status === 'active').length,
    inactive: allStatuses.filter((c) => c.status === 'inactive').length,
    suspended: allStatuses.filter((c) => c.status === 'suspended').length,
  };

  return c.json({ collaborators: cleaned, count, stats });
});

collaborators.get('/:id', async (c) => {
  const id = c.req.param('id');

  const [collaborator] = await sql`SELECT * FROM collaborators WHERE id = ${id}`;
  if (!collaborator) return c.json({ error: 'Collaboratore non trovato' }, 404);

  const projects = await sql`SELECT * FROM client_projects_view WHERE collaborator_id = ${id} ORDER BY created_at DESC`;

  return c.json({ collaborator: stripPortalSecrets(collaborator), projects });
});

collaborators.post('/', async (c) => {
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
      metadata: { company_name: company_name || '', type: 'collaborator' },
    });
    stripeCustomerId = sc.id;
  }

  const [collaborator] = await sql`
    INSERT INTO collaborators ${sql({ company_name, contact_name, email, phone, billing_address, notes, tags, stripe_customer_id: stripeCustomerId })}
    RETURNING *
  `;

  return c.json({ collaborator }, 201);
});

collaborators.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const updates = await prepareCollaboratorUpdate(body);
  const [collaborator] = await sql`UPDATE collaborators SET ${sql(updates)} WHERE id = ${id} RETURNING *`;

  if (collaborator?.stripe_customer_id && isStripeConfigured()) {
    await stripe.customers.update(collaborator.stripe_customer_id as string, {
      name: body.company_name || body.contact_name,
      email: body.email,
      phone: body.phone || undefined,
    });
  }

  return c.json({ collaborator: stripPortalSecrets(collaborator) });
});

collaborators.delete('/:id', async (c) => {
  await sql`UPDATE collaborators SET status = 'inactive' WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});

collaborators.post('/:id/portal', async (c) => {
  const id = c.req.param('id');
  const [collaborator] = await sql`SELECT stripe_customer_id FROM collaborators WHERE id = ${id}`;

  if (!collaborator?.stripe_customer_id) {
    return c.json({ error: 'Collaboratore non collegato a Stripe' }, 400);
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: collaborator.stripe_customer_id as string,
    return_url: c.req.header('referer') || 'http://localhost:5173/collaborators',
  });

  return c.json({ url: session.url });
});

collaborators.post('/:id/payment-link', async (c) => {
  const id = c.req.param('id');
  const { type, priceId, amount, description } = await c.req.json();
  const [collaborator] = await sql`SELECT stripe_customer_id, email FROM collaborators WHERE id = ${id}`;

  if (!collaborator) return c.json({ error: 'Collaboratore non trovato' }, 404);

  let url: string;

  if (type === 'subscription' && priceId) {
    const session = await stripe.checkout.sessions.create({
      customer: collaborator.stripe_customer_id || undefined,
      customer_email: collaborator.stripe_customer_id ? undefined : collaborator.email as string,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://calicchia.design/pagamento/successo',
      cancel_url: 'https://calicchia.design/pagamento/annullato',
    });
    url = session.url!;
  } else if (amount) {
    const session = await stripe.checkout.sessions.create({
      customer: collaborator.stripe_customer_id || undefined,
      customer_email: collaborator.stripe_customer_id ? undefined : collaborator.email as string,
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

collaborators.post('/:id/generate-portal-code', async (c) => {
  const id = c.req.param('id');
  const code = 'COL-' + randomBytes(4).toString('hex').toUpperCase();
  const hash = await bcrypt.hash(code, 12);

  try {
    const [collaborator] = await sql`
      UPDATE collaborators SET portal_access_code_hash = ${hash}
      WHERE id = ${id}
      RETURNING id
    `;
    if (!collaborator) return c.json({ error: 'Collaboratore non trovato' }, 404);
    return c.json({ collaborator: { ...collaborator, portal_access_code: code } });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'Codice duplicato, riprova' }, 409);
    }
    throw err;
  }
});

collaborators.post('/sync-stripe', async (c) => {
  if (!isStripeConfigured()) return c.json({ error: 'Stripe non configurato' }, 503);

  const results = { synced: 0, errors: 0 };
  const stripeCustomers = await stripe.customers.list({ limit: 100 });

  for (const sc of stripeCustomers.data) {
    try {
      if (sc.deleted) continue;
      if (sc.metadata?.type !== 'collaborator') continue;

      await sql`
        INSERT INTO collaborators (stripe_customer_id, contact_name, email, phone, company_name, status)
        VALUES (${sc.id}, ${sc.name || sc.email || 'Unknown'}, ${sc.email || ''}, ${sc.phone || null}, ${sc.metadata?.company_name || sc.name || null}, 'active')
        ON CONFLICT (stripe_customer_id) DO UPDATE SET
          contact_name = EXCLUDED.contact_name, email = EXCLUDED.email, phone = EXCLUDED.phone
      `;
      results.synced++;
    } catch { results.errors++; }
  }

  return c.json({ success: true, results, message: `Sincronizzati: ${results.synced} collaboratori` });
});
