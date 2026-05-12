import { Hono } from 'hono';
import { sql } from '../db';

export const paymentTracker = new Hono();

// GET /api/payment-tracker
// Restituisce sia i pagamenti tracciati manualmente (tabella payment_tracker)
// SIA i pagamenti automatici incassati via Stripe/PayPal/Revolut (payment_links
// con status='paid'/'partially_refunded'/'refunded') — normalizzati allo stesso shape
// per essere visualizzati assieme nella tab Tracker admin.
paymentTracker.get('/', async (c) => {
  const customerId = c.req.query('customer_id');
  const projectId = c.req.query('project_id');
  const status = c.req.query('status');

  const customerFilter = customerId ? sql`AND pt.customer_id = ${customerId}` : sql``;
  const projectFilter = projectId ? sql`AND pt.project_id = ${projectId}` : sql``;
  const statusFilter = status ? sql`AND pt.status = ${status}` : sql``;

  const manual = await sql`
    SELECT pt.id, pt.description, pt.amount, pt.status, pt.due_date,
           pt.paid_date, pt.paid_amount, pt.notes, pt.external_ref,
           pt.customer_id, pt.project_id, pt.created_at,
           c.contact_name AS customer_name,
           c.company_name,
           cp.name AS project_name,
           'manual'::text AS source,
           NULL::text AS provider
    FROM payment_tracker pt
    LEFT JOIN customers c ON c.id = pt.customer_id
    LEFT JOIN client_projects cp ON cp.id = pt.project_id
    WHERE 1=1 ${customerFilter} ${projectFilter} ${statusFilter}
    ORDER BY pt.created_at DESC
  ` as Array<Record<string, unknown>>;

  // Auto payments: payment_links con status terminale + scheduled/invoice context
  const autoCustomerFilter = customerId
    ? sql`AND COALESCE(q.customer_id, i.customer_id) = ${customerId}`
    : sql``;
  const autoProjectFilter = projectId
    ? sql`AND ps.project_id = ${projectId}`
    : sql``;
  // Map portal/link status → tracker status
  const autoStatusFilter = status === 'pagata'
    ? sql`AND pl.status IN ('paid', 'partially_refunded')`
    : status === 'annullata'
      ? sql`AND pl.status IN ('cancelled', 'expired', 'refunded')`
      : status === 'parziale'
        ? sql`AND pl.status = 'partially_refunded'`
        : sql``;

  const auto = await sql`
    SELECT pl.id,
           CONCAT(
             COALESCE(ps.title, i.invoice_number, 'Pagamento'),
             ' — ',
             UPPER(pl.provider)
           ) AS description,
           pl.amount,
           CASE
             WHEN pl.status = 'paid' THEN 'pagata'
             WHEN pl.status = 'partially_refunded' THEN 'parziale'
             WHEN pl.status = 'refunded' THEN 'annullata'
             WHEN pl.status = 'expired' THEN 'scaduta'
             WHEN pl.status = 'cancelled' THEN 'annullata'
             ELSE 'emessa'
           END AS status,
           ps.due_date,
           DATE(pl.paid_at) AS paid_date,
           CASE
             WHEN pl.status = 'partially_refunded' THEN GREATEST(0, pl.amount - pl.refunded_amount)
             WHEN pl.status IN ('paid') THEN pl.amount
             ELSE 0
           END AS paid_amount,
           NULL::text AS notes,
           pl.provider_order_id AS external_ref,
           COALESCE(q.customer_id, i.customer_id, cp.customer_id) AS customer_id,
           ps.project_id,
           pl.created_at,
           c2.contact_name AS customer_name,
           c2.company_name,
           cp.name AS project_name,
           'auto'::text AS source,
           pl.provider
    FROM payment_links pl
    LEFT JOIN payment_schedules ps ON ps.id = pl.payment_schedule_id
    LEFT JOIN quotes q ON q.id = COALESCE(ps.quote_id, pl.quote_id)
    LEFT JOIN invoices i ON i.id = COALESCE(ps.invoice_id, pl.invoice_id)
    LEFT JOIN client_projects cp ON cp.id = ps.project_id
    LEFT JOIN customers c2 ON c2.id = COALESCE(q.customer_id, i.customer_id, cp.customer_id)
    WHERE pl.status IN ('paid', 'partially_refunded', 'refunded', 'expired', 'cancelled')
      ${autoCustomerFilter}
      ${autoProjectFilter}
      ${autoStatusFilter}
    ORDER BY pl.created_at DESC
  ` as Array<Record<string, unknown>>;

  const payments = [...manual, ...auto].sort((a, b) => {
    const ta = a.created_at instanceof Date ? a.created_at.getTime() : 0;
    const tb = b.created_at instanceof Date ? b.created_at.getTime() : 0;
    return tb - ta;
  });

  return c.json({ payments });
});

// POST /api/payment-tracker
paymentTracker.post('/', async (c) => {
  const { customer_id, project_id, description, amount, status, due_date, notes, external_ref } = await c.req.json();
  if (!description || !amount) return c.json({ error: 'description e amount richiesti' }, 400);

  const rows = await sql`
    INSERT INTO payment_tracker (customer_id, project_id, description, amount, status, due_date, notes, external_ref)
    VALUES (${customer_id || null}, ${project_id || null}, ${description}, ${amount}, ${status || 'emessa'}, ${due_date || null}, ${notes || null}, ${external_ref || null})
    RETURNING *
  `;

  return c.json({ payment: rows[0] }, 201);
});

// PUT /api/payment-tracker/:id
paymentTracker.put('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  const rows = await sql`
    UPDATE payment_tracker SET
      description = COALESCE(${body.description || null}, description),
      amount = COALESCE(${body.amount || null}, amount),
      status = COALESCE(${body.status || null}, status),
      due_date = ${body.due_date !== undefined ? body.due_date : null},
      paid_date = ${body.paid_date !== undefined ? body.paid_date : null},
      paid_amount = COALESCE(${body.paid_amount || null}, paid_amount),
      notes = ${body.notes !== undefined ? body.notes : null},
      external_ref = ${body.external_ref !== undefined ? body.external_ref : null},
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;

  if (!rows.length) return c.json({ error: 'Pagamento non trovato' }, 404);
  return c.json({ payment: rows[0] });
});

// DELETE /api/payment-tracker/:id
paymentTracker.delete('/:id', async (c) => {
  const { id } = c.req.param();
  await sql`DELETE FROM payment_tracker WHERE id = ${id}`;
  return c.json({ success: true });
});
