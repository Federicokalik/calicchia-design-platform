import { Hono } from 'hono';
import { sql } from '../db';
import { checkAndSendReminders } from './domain-cron';

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
  if (expiring) {
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

domains.post('/', async (c) => {
  const body = await c.req.json();
  const [domain] = await sql`
    INSERT INTO domains ${sql({ ...body, status: body.status || 'active' })} RETURNING *
  `;
  return c.json({ domain }, 201);
});

domains.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [domain] = await sql`UPDATE domains SET ${sql(body)} WHERE id = ${id} RETURNING *`;
  return c.json({ domain });
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
