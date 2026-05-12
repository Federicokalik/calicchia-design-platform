import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql } from '../src/db';
import { recordPaymentSuccess } from '../src/lib/payment-events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../../.env') });

async function main() {
  const stamp = Date.now();
  const orderId = `PAYPAL-SMOKE-${stamp}`;

  const [customer] = await sql`
    INSERT INTO customers (contact_name, company_name, email)
    VALUES ('Smoke PayPal', 'Smoke PayPal', ${`paypal-smoke-${stamp}@example.test`})
    RETURNING id
  ` as Array<{ id: string }>;

  const [invoice] = await sql`
    INSERT INTO invoices (customer_id, invoice_number, subtotal, total, amount_due, amount_paid, currency, status, payment_status, line_items)
    VALUES (${customer.id}, ${`SMOKE-PAYPAL-${stamp}`}, 12.34, 12.34, 12.34, 0, 'EUR', 'open', 'unpaid', ${JSON.stringify([{ description: 'Smoke PayPal', quantity: 1, unit_price: 12.34, amount: 12.34 }])}::jsonb)
    RETURNING id
  ` as Array<{ id: string }>;

  const [schedule] = await sql`
    INSERT INTO payment_schedules (invoice_id, title, amount, currency, status, paid_amount)
    VALUES (${invoice.id}, 'Smoke PayPal', 12.34, 'EUR', 'pending', 0)
    RETURNING id
  ` as Array<{ id: string }>;

  const [link] = await sql`
    INSERT INTO payment_links (invoice_id, payment_schedule_id, provider, provider_order_id, amount, currency, status, payload_json)
    VALUES (${invoice.id}, ${schedule.id}, 'paypal', ${orderId}, 12.34, 'EUR', 'active', '{}'::jsonb)
    RETURNING id
  ` as Array<{ id: string }>;

  try {
    const result = await recordPaymentSuccess({
      provider: 'paypal',
      providerOrderId: orderId,
      amount: 12.34,
      currency: 'EUR',
      payerEmail: `payer-${stamp}@example.test`,
    });

    const [paid] = await sql`
      SELECT pl.status, ps.status AS schedule_status, pr.receipt_number
      FROM payment_links pl
      JOIN payment_schedules ps ON ps.id = pl.payment_schedule_id
      LEFT JOIN payment_receipts pr ON pr.payment_link_id = pl.id
      WHERE pl.id = ${link.id}
      LIMIT 1
    ` as Array<{ status: string; schedule_status: string; receipt_number: string | null }>;

    if (!paid || paid.status !== 'paid' || paid.schedule_status !== 'paid') {
      throw new Error(`Expected paid link/schedule, got ${JSON.stringify(paid)}`);
    }
    if (!paid.receipt_number) {
      throw new Error('Expected generated receipt');
    }

    console.log('PayPal smoke OK', { result, receipt_number: paid.receipt_number });
  } finally {
    await sql`DELETE FROM payment_receipts WHERE payment_link_id = ${link.id}`;
    await sql`DELETE FROM payment_links WHERE id = ${link.id}`;
    await sql`DELETE FROM payment_schedules WHERE id = ${schedule.id}`;
    await sql`DELETE FROM invoices WHERE id = ${invoice.id}`;
    await sql`DELETE FROM customers WHERE id = ${customer.id}`;
    await sql.end();
  }
}

main().catch(async (error) => {
  console.error('PayPal smoke failed:', error instanceof Error ? error.message : error);
  await sql.end();
  process.exit(1);
});
