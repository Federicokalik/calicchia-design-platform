import { Hono } from 'hono';
import { sql } from '../db';

export const leads = new Hono();

// GET /api/leads — list all leads
leads.get('/', async (c) => {
  const status = c.req.query('status');

  let rows;
  if (status) {
    rows = await sql`
      SELECT * FROM leads
      WHERE status = ${status}
      ORDER BY created_at DESC
    `;
  } else {
    rows = await sql`
      SELECT * FROM leads
      ORDER BY
        CASE status
          WHEN 'new' THEN 0
          WHEN 'contacted' THEN 1
          WHEN 'proposal' THEN 2
          WHEN 'negotiation' THEN 3
          WHEN 'won' THEN 4
          WHEN 'lost' THEN 5
        END,
        created_at DESC
    `;
  }

  return c.json({ leads: rows });
});

// GET /api/leads/:id — get single lead
leads.get('/:id', async (c) => {
  const { id } = c.req.param();
  const rows = await sql`SELECT * FROM leads WHERE id = ${id}`;
  if (!rows.length) return c.json({ error: 'Lead non trovato' }, 404);
  return c.json({ lead: rows[0] });
});

// POST /api/leads — create lead
leads.post('/', async (c) => {
  const body = await c.req.json();
  const { name, email, phone, company, source, status, estimated_value, notes, tags } = body;

  if (!name) return c.json({ error: 'Nome richiesto' }, 400);

  const rows = await sql`
    INSERT INTO leads (name, email, phone, company, source, status, estimated_value, notes, tags)
    VALUES (
      ${name},
      ${email || null},
      ${phone || null},
      ${company || null},
      ${source || 'manual'},
      ${status || 'new'},
      ${estimated_value || null},
      ${notes || null},
      ${tags || []}
    )
    RETURNING *
  `;

  return c.json({ lead: rows[0] }, 201);
});

// PUT /api/leads/:id — update lead
leads.put('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { name, email, phone, company, source, status, estimated_value, notes, tags, lost_reason } = body;

  const rows = await sql`
    UPDATE leads SET
      name = COALESCE(${name || null}, name),
      email = ${email !== undefined ? email : null},
      phone = ${phone !== undefined ? phone : null},
      company = ${company !== undefined ? company : null},
      source = COALESCE(${source || null}, source),
      status = COALESCE(${status || null}, status),
      estimated_value = ${estimated_value !== undefined ? estimated_value : null},
      notes = ${notes !== undefined ? notes : null},
      tags = COALESCE(${tags || null}, tags),
      lost_reason = ${lost_reason !== undefined ? lost_reason : null},
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;

  if (!rows.length) return c.json({ error: 'Lead non trovato' }, 404);
  return c.json({ lead: rows[0] });
});

// PATCH /api/leads/:id/status — quick status change (drag & drop)
leads.patch('/:id/status', async (c) => {
  const { id } = c.req.param();
  const { status } = await c.req.json();

  const validStatuses = ['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost'];
  if (!validStatuses.includes(status)) {
    return c.json({ error: 'Stato non valido' }, 400);
  }

  const rows = await sql`
    UPDATE leads SET status = ${status}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;

  if (!rows.length) return c.json({ error: 'Lead non trovato' }, 404);
  return c.json({ lead: rows[0] });
});

// DELETE /api/leads/:id — delete lead
leads.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const rows = await sql`DELETE FROM leads WHERE id = ${id} RETURNING id`;
  if (!rows.length) return c.json({ error: 'Lead non trovato' }, 404);
  return c.json({ success: true });
});

// POST /api/leads/:id/convert — convert lead to customer + project
leads.post('/:id/convert', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { project_name, project_type } = body;

  const leadRows = await sql`SELECT * FROM leads WHERE id = ${id}`;
  if (!leadRows.length) return c.json({ error: 'Lead non trovato' }, 404);

  const lead = leadRows[0];

  // Create customer
  const customerRows = await sql`
    INSERT INTO customers (name, email, phone, company, lead_id, status)
    VALUES (${lead.name}, ${lead.email}, ${lead.phone}, ${lead.company}, ${id}, 'active')
    RETURNING *
  `;
  const customer = customerRows[0];

  // Optionally create project
  let project = null;
  if (project_name) {
    const projectRows = await sql`
      INSERT INTO client_projects (customer_id, name, project_type, status, priority)
      VALUES (${customer.id}, ${project_name}, ${project_type || 'website'}, 'draft', 5)
      RETURNING *
    `;
    project = projectRows[0];
  }

  // Update lead
  await sql`
    UPDATE leads SET
      status = 'won',
      converted_customer_id = ${customer.id},
      converted_project_id = ${project?.id || null},
      updated_at = now()
    WHERE id = ${id}
  `;

  return c.json({ customer, project });
});

leads.post('/:id/convert-to-quote', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));

  const result = await sql.begin(async (txSql: any) => {
    const [lead] = await txSql`SELECT * FROM leads WHERE id = ${id}`;
    if (!lead) return { __error: 'Lead non trovato', __status: 404 };

    let customer;
    if (lead.converted_customer_id) {
      const [existingCustomer] = await txSql`
        SELECT * FROM customers WHERE id = ${lead.converted_customer_id}
      `;
      customer = existingCustomer;
    } else {
      const [createdCustomer] = await txSql`
        INSERT INTO customers (name, email, phone, company, lead_id, status)
        VALUES (${lead.name}, ${lead.email}, ${lead.phone}, ${lead.company}, ${lead.id}, 'active')
        RETURNING *
      `;
      customer = createdCustomer;
    }

    const [quote] = await txSql`
      INSERT INTO quotes_v2 (customer_id, lead_id, title, items, valid_until, status)
      VALUES (
        ${customer.id},
        ${lead.id},
        ${body.title ?? 'Preventivo per ' + lead.name},
        ${body.items ?? []},
        ${body.valid_until ?? null},
        'draft'
      )
      RETURNING *
    `;

    await txSql`
      UPDATE leads
      SET status = 'quoted',
          converted_customer_id = ${customer.id},
          updated_at = now()
      WHERE id = ${lead.id}
    `;

    return { customer, quote };
  });

  if (result.__error) return c.json({ error: result.__error }, 404);
  return c.json(result, 201);
});
