import { Hono } from 'hono';
import { sql } from '../db';

export const importRoutes = new Hono();

function parseCSV(csvText: string): Record<string, string>[] {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g) || [];
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      let value = values[index] || '';
      value = value.trim().replace(/^"|"$/g, '').replace(/""/g, '"');
      row[header] = value;
    });
    rows.push(row);
  }

  return rows;
}

importRoutes.post('/customers', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  const mode = (formData.get('mode') as string) || 'create';

  if (!file) return c.json({ error: 'No file provided' }, 400);

  const rows = parseCSV(await file.text());
  if (rows.length === 0) return c.json({ error: 'No data found in CSV' }, 400);

  const results = { created: 0, updated: 0, errors: [] as string[] };

  for (const row of rows) {
    try {
      const data = {
        contact_name: row.contact_name || row.name || row.Name,
        email: row.email || row.Email,
        company_name: row.company_name || row.company || row.Company || null,
        phone: row.phone || row.Phone || null,
        billing_address: {
          street: row.address || row.Address || null,
          city: row.city || row.City || null,
          postal_code: row.postal_code || row.PostalCode || null,
          country: row.country || row.Country || 'IT',
          vat_number: row.vat_number || row.VAT || null,
        },
      };

      if (!data.email) { results.errors.push(`Missing email: ${JSON.stringify(row)}`); continue; }

      if (mode === 'upsert') {
        await sql`INSERT INTO customers ${sql(data)} ON CONFLICT (email) DO UPDATE SET ${sql(data)}`;
        results.created++;
      } else if (mode === 'update') {
        await sql`UPDATE customers SET ${sql(data)} WHERE email = ${data.email}`;
        results.updated++;
      } else {
        await sql`INSERT INTO customers ${sql(data)}`;
        results.created++;
      }
    } catch (err) {
      results.errors.push(`Error importing ${row.email}: ${(err as Error).message}`);
    }
  }

  return c.json({ success: true, results, total: rows.length });
});

importRoutes.post('/newsletter', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;

  if (!file) return c.json({ error: 'No file provided' }, 400);

  const rows = parseCSV(await file.text());
  if (rows.length === 0) return c.json({ error: 'No data found in CSV' }, 400);

  const results = { created: 0, skipped: 0, errors: [] as string[] };

  for (const row of rows) {
    try {
      const email = row.email || row.Email;
      const name = row.name || row.Name || null;

      if (!email) { results.errors.push(`Missing email: ${JSON.stringify(row)}`); continue; }

      const [existing] = await sql`SELECT id FROM newsletter_subscribers WHERE email = ${email}`;
      if (existing) { results.skipped++; continue; }

      await sql`INSERT INTO newsletter_subscribers ${sql({ email, name, status: 'active' })}`;
      results.created++;
    } catch (err) {
      results.errors.push(`Error importing ${row.email}: ${(err as Error).message}`);
    }
  }

  return c.json({ success: true, results, total: rows.length });
});

importRoutes.post('/collaborators', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  const mode = (formData.get('mode') as string) || 'create';

  if (!file) return c.json({ error: 'No file provided' }, 400);

  const rows = parseCSV(await file.text());
  if (rows.length === 0) return c.json({ error: 'No data found in CSV' }, 400);

  const results = { created: 0, updated: 0, errors: [] as string[] };

  for (const row of rows) {
    try {
      const data = {
        contact_name: row.contact_name || row.name || row.Name,
        email: row.email || row.Email,
        company_name: row.company_name || row.company || row.Company || null,
        phone: row.phone || row.Phone || null,
        billing_address: {
          street: row.address || row.Address || null,
          city: row.city || row.City || null,
          postal_code: row.postal_code || row.PostalCode || null,
          country: row.country || row.Country || 'IT',
          vat_number: row.vat_number || row.VAT || null,
        },
      };

      if (!data.email) { results.errors.push(`Missing email: ${JSON.stringify(row)}`); continue; }

      if (mode === 'upsert') {
        await sql`INSERT INTO collaborators ${sql(data)} ON CONFLICT (email) DO UPDATE SET ${sql(data)}`;
        results.created++;
      } else if (mode === 'update') {
        await sql`UPDATE collaborators SET ${sql(data)} WHERE email = ${data.email}`;
        results.updated++;
      } else {
        await sql`INSERT INTO collaborators ${sql(data)}`;
        results.created++;
      }
    } catch (err) {
      results.errors.push(`Error importing ${row.email}: ${(err as Error).message}`);
    }
  }

  return c.json({ success: true, results, total: rows.length });
});

importRoutes.post('/domains', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;

  if (!file) return c.json({ error: 'No file provided' }, 400);

  const rows = parseCSV(await file.text());
  if (rows.length === 0) return c.json({ error: 'No data found in CSV' }, 400);

  const results = { created: 0, errors: [] as string[] };

  for (const row of rows) {
    try {
      const domain = row.domain || row.Domain;
      if (!domain) { results.errors.push(`Missing domain: ${JSON.stringify(row)}`); continue; }

      let customerId = row.customer_id || null;
      if (!customerId && (row.customer_name || row.customer_email)) {
        const [customer] = await sql`
          SELECT id FROM customers
          WHERE contact_name = ${row.customer_name || ''} OR email = ${row.customer_email || ''}
          LIMIT 1
        `;
        if (customer) customerId = customer.id;
      }

      const domainParts = domain.split('.');
      const tld = domainParts.pop() || '';
      const domainName = domainParts.join('.');

      await sql`
        INSERT INTO domains ${sql({
          domain_name: domainName,
          tld,
          customer_id: customerId,
          registrar: row.registrar || null,
          status: row.status || 'active',
          registration_date: row.registration_date || row.registered_at || new Date().toISOString().split('T')[0],
          expiration_date: row.expiration_date || row.expires_at || null,
        })}
      `;
      results.created++;
    } catch (err) {
      results.errors.push(`Error importing ${row.domain}: ${(err as Error).message}`);
    }
  }

  return c.json({ success: true, results, total: rows.length });
});
