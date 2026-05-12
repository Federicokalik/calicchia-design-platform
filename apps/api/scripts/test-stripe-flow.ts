import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql } from '../src/db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../../.env') });

const apiUrl = process.env.API_URL || 'http://localhost:3001';

async function getToken(): Promise<string> {
  if (process.env.TEST_AUTH_TOKEN) return process.env.TEST_AUTH_TOKEN;

  const email = process.env.TEST_EMAIL || process.env.ADMIN_EMAIL;
  const password = process.env.TEST_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Set TEST_AUTH_TOKEN or TEST_EMAIL/TEST_PASSWORD to call protected /api/payments');
  }

  const res = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json() as { token?: string; error?: string };
  if (!res.ok || !data.token) {
    throw new Error(`Login failed: ${res.status} ${data.error ?? ''}`);
  }
  return data.token;
}

async function main() {
  const stamp = Date.now();
  const token = await getToken();

  const [customer] = await sql`
    INSERT INTO customers (contact_name, company_name, email)
    VALUES ('Smoke Stripe', 'Smoke Stripe', ${`stripe-smoke-${stamp}@example.test`})
    RETURNING id
  ` as Array<{ id: string }>;

  const [invoice] = await sql`
    INSERT INTO invoices (customer_id, invoice_number, subtotal, total, amount_due, amount_paid, currency, status, payment_status, line_items)
    VALUES (${customer.id}, ${`SMOKE-STRIPE-${stamp}`}, 9.99, 9.99, 9.99, 0, 'EUR', 'open', 'unpaid', ${JSON.stringify([{ description: 'Smoke Stripe', quantity: 1, unit_price: 9.99, amount: 9.99 }])}::jsonb)
    RETURNING id
  ` as Array<{ id: string }>;

  const [schedule] = await sql`
    INSERT INTO payment_schedules (invoice_id, title, amount, currency, status, paid_amount)
    VALUES (${invoice.id}, 'Smoke Stripe', 9.99, 'EUR', 'pending', 0)
    RETURNING id
  ` as Array<{ id: string }>;

  let linkId = '';
  try {
    const res = await fetch(`${apiUrl}/api/payments/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        provider: 'stripe',
        amount: 9.99,
        currency: 'EUR',
        description: 'Smoke Stripe',
        invoice_id: invoice.id,
        payment_schedule_id: schedule.id,
        return_base_url: `${apiUrl}/stripe-smoke`,
      }),
    });
    const data = await res.json() as { link?: { id: string; provider_order_id?: string }; error?: string };
    if (!res.ok || !data.link) throw new Error(`Create payment link failed: ${res.status} ${data.error ?? ''}`);
    linkId = data.link.id;

    console.log('Stripe payment link created:', data.link);
    console.log('Trigger with Stripe CLI, then leave this script polling:');
    console.log(`stripe trigger checkout.session.completed --add checkout_session:metadata.payment_schedule_id=${schedule.id}`);
    console.log(`Expected session/provider_order_id in DB: ${data.link.provider_order_id ?? '(created by Stripe)'}`);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const [row] = await sql`
        SELECT status FROM payment_links WHERE id = ${linkId} LIMIT 1
      ` as Array<{ status: string }>;
      if (row?.status === 'paid') {
        console.log('Stripe smoke OK: link marked paid');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    console.log('Stripe smoke timed out after 30s waiting for paid status');
  } finally {
    if (linkId) await sql`DELETE FROM payment_receipts WHERE payment_link_id = ${linkId}`;
    if (linkId) await sql`DELETE FROM payment_links WHERE id = ${linkId}`;
    await sql`DELETE FROM payment_schedules WHERE id = ${schedule.id}`;
    await sql`DELETE FROM invoices WHERE id = ${invoice.id}`;
    await sql`DELETE FROM customers WHERE id = ${customer.id}`;
    await sql.end();
  }
}

main().catch(async (error) => {
  console.error('Stripe smoke failed:', error instanceof Error ? error.message : error);
  await sql.end();
  process.exit(1);
});
