import { Hono } from 'hono';
import { sql } from '../db';

export const invoices = new Hono();

invoices.get('/', async (c) => {
  const status = c.req.query('status');
  const customerId = c.req.query('customer_id');
  const search = c.req.query('search');

  const statusFilter = status && status !== 'all' ? sql`AND i.status = ${status}` : sql``;
  const customerFilter = customerId ? sql`AND i.customer_id = ${customerId}` : sql``;
  const searchFilter = search
    ? sql`AND (i.invoice_number ILIKE ${'%' + search + '%'} OR i.notes ILIKE ${'%' + search + '%'})`
    : sql``;

  const rows = await sql`
    SELECT i.*,
      jsonb_build_object('id', c.id, 'company_name', c.company_name, 'contact_name', c.contact_name, 'email', c.email) AS customers
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE 1=1 ${statusFilter} ${customerFilter} ${searchFilter}
    ORDER BY i.issue_date DESC
  `;

  const now = new Date();
  const stats = {
    total: rows.length,
    draft: rows.filter((i) => i.status === 'draft').length,
    open: rows.filter((i) => i.status === 'open').length,
    sent: rows.filter((i) => i.status === 'open' && i.sent_at).length,
    paid: rows.filter((i) => i.status === 'paid').length,
    overdue: rows.filter((i) => i.status === 'open' && i.due_date && new Date(i.due_date as string) < now).length,
    total_amount: rows.reduce((acc, i) => acc + ((i.total as number) || (i.amount_due as number) || 0), 0),
    paid_amount: rows.reduce((acc, i) => acc + (i.status === 'paid' ? ((i.total as number) || (i.amount_due as number) || 0) : 0), 0),
  };

  return c.json({ invoices: rows, stats });
});

invoices.get('/:id', async (c) => {
  const id = c.req.param('id');

  const rows = await sql`
    SELECT i.*, to_jsonb(c.*) AS customers
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.id = ${id}
  `;

  if (!rows.length) return c.json({ error: 'Fattura non trovata' }, 404);
  return c.json({ invoice: rows[0] });
});

invoices.post('/', async (c) => {
  const body = await c.req.json();
  const { status: _s, amount_due: _ad, issue_date, ...rest } = body;

  const [invoice] = await sql`
    INSERT INTO invoices ${sql({
      ...rest,
      status: 'draft',
      amount_due: body.total,
      issue_date: issue_date || new Date().toISOString().split('T')[0],
    })}
    RETURNING *
  `;

  return c.json({ invoice }, 201);
});

invoices.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();

  const [invoice] = await sql`UPDATE invoices SET ${sql(body)} WHERE id = ${id} RETURNING *`;
  return c.json({ invoice });
});

function resolveStatus(body: Record<string, any>): { status: string; extra: Record<string, any> } {
  const actionMap: Record<string, string> = { issue: 'open', send: 'open', pay: 'paid', void: 'void' };
  const status = body.action ? (actionMap[body.action] || body.action) : body.status;
  const extra: Record<string, any> = {};

  if (body.action === 'send') extra.sent_at = new Date().toISOString();
  if (status === 'paid') {
    extra.paid_at = body.paid_at || new Date().toISOString();
    extra.amount_due = 0;
    if (body.amount) extra.amount_paid = body.amount;
  }

  return { status, extra };
}

invoices.put('/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { status, extra } = resolveStatus(body);

  const [invoice] = await sql`UPDATE invoices SET ${sql({ status, ...extra })} WHERE id = ${id} RETURNING *`;
  return c.json({ invoice });
});

invoices.post('/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { status, extra } = resolveStatus(body);

  const [invoice] = await sql`UPDATE invoices SET ${sql({ status, ...extra })} WHERE id = ${id} RETURNING *`;
  return c.json({ invoice });
});

invoices.delete('/:id', async (c) => {
  await sql`DELETE FROM invoices WHERE id = ${c.req.param('id')}`;
  return c.json({ success: true });
});
