import { Hono } from 'hono';
import { sql } from '../db';

export const exportRoutes = new Hono();

function toCsv(rows: Record<string, unknown>[], headers: string[]): string {
  const csvRows = [headers.join(',')];
  for (const row of rows) {
    csvRows.push(headers.map((h) => {
      const value = row[h];
      if (value === null || value === undefined) return '';
      return `"${String(value).replace(/"/g, '""')}"`;
    }).join(','));
  }
  return csvRows.join('\n');
}

exportRoutes.get('/customers', async (c) => {
  const format = c.req.query('format') || 'csv';
  const customers = await sql`SELECT * FROM customers ORDER BY created_at DESC`;

  if (format === 'json') return c.json({ customers });

  const headers = ['id', 'contact_name', 'email', 'company_name', 'phone', 'status', 'total_revenue', 'created_at'];
  return new Response(toCsv(customers as Record<string, unknown>[], headers), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="customers-${Date.now()}.csv"` },
  });
});

exportRoutes.get('/invoices', async (c) => {
  const format = c.req.query('format') || 'csv';
  const status = c.req.query('status');
  const statusFilter = status ? sql`AND i.status = ${status}` : sql``;

  const invoices = await sql`
    SELECT i.*, c.contact_name AS customer_name, c.email AS customer_email
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE 1=1 ${statusFilter}
    ORDER BY i.created_at DESC
  `;

  if (format === 'json') return c.json({ invoices });

  const headers = ['id', 'invoice_number', 'customer_name', 'customer_email', 'amount_due', 'status', 'due_date', 'paid_at', 'created_at'];
  return new Response(toCsv(invoices as Record<string, unknown>[], headers), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="invoices-${Date.now()}.csv"` },
  });
});

exportRoutes.get('/domains', async (c) => {
  const format = c.req.query('format') || 'csv';

  const domains = await sql`
    SELECT d.*, c.contact_name AS customer_name
    FROM domains d
    LEFT JOIN customers c ON c.id = d.customer_id
    ORDER BY d.expiration_date ASC
  `;

  if (format === 'json') return c.json({ domains });

  const headers = ['id', 'domain_name', 'customer_name', 'registrar', 'status', 'registration_date', 'expiration_date'];
  return new Response(toCsv(domains as Record<string, unknown>[], headers), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="domains-${Date.now()}.csv"` },
  });
});

exportRoutes.get('/collaborators', async (c) => {
  const format = c.req.query('format') || 'csv';
  const collaborators = await sql`SELECT * FROM collaborators ORDER BY created_at DESC`;

  if (format === 'json') return c.json({ collaborators });

  const headers = ['id', 'contact_name', 'email', 'company_name', 'phone', 'status', 'total_revenue', 'created_at'];
  return new Response(toCsv(collaborators as Record<string, unknown>[], headers), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="collaborators-${Date.now()}.csv"` },
  });
});

exportRoutes.get('/newsletter', async (c) => {
  const format = c.req.query('format') || 'csv';
  const subscribers = await sql`SELECT * FROM newsletter_subscribers ORDER BY created_at DESC`;

  if (format === 'json') return c.json({ subscribers });

  const headers = ['id', 'email', 'name', 'status', 'created_at'];
  return new Response(toCsv(subscribers as Record<string, unknown>[], headers), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="newsletter-${Date.now()}.csv"` },
  });
});
