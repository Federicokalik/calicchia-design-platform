import { config } from 'dotenv';
import { existsSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql } from '../src/db';
import { generateReceiptForPaymentLink } from '../src/lib/receipt-pdf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../../.env') });

const uploadDir = process.env.UPLOAD_DIR || './uploads';

async function main() {
  const stamp = Date.now();

  const [customer] = await sql`
    INSERT INTO customers (contact_name, company_name, email)
    VALUES ('Smoke Receipt', 'Smoke Receipt', ${`receipt-smoke-${stamp}@example.test`})
    RETURNING id
  ` as Array<{ id: string }>;

  const [invoice] = await sql`
    INSERT INTO invoices (customer_id, invoice_number, subtotal, total, amount_due, amount_paid, currency, status, payment_status, line_items)
    VALUES (${customer.id}, ${`SMOKE-RECEIPT-${stamp}`}, 42.50, 42.50, 0, 42.50, 'EUR', 'paid', 'paid', ${JSON.stringify([{ description: 'Smoke receipt', quantity: 1, unit_price: 42.5, amount: 42.5 }])}::jsonb)
    RETURNING id
  ` as Array<{ id: string }>;

  const [link] = await sql`
    INSERT INTO payment_links (invoice_id, provider, provider_order_id, amount, currency, status, paid_at, payload_json)
    VALUES (${invoice.id}, 'stripe', ${`SMOKE-RECEIPT-${stamp}`}, 42.50, 'EUR', 'paid', NOW(), '{}'::jsonb)
    RETURNING id
  ` as Array<{ id: string }>;

  let pdfPath = '';
  try {
    const first = await generateReceiptForPaymentLink({ paymentLinkId: link.id });
    const second = await generateReceiptForPaymentLink({ paymentLinkId: link.id });

    if (first.id !== second.id || first.receipt_number !== second.receipt_number) {
      throw new Error('Receipt generation is not idempotent');
    }
    if (!/^R-\d{4}-\d{4}$/.test(first.receipt_number)) {
      throw new Error(`Bad receipt number: ${first.receipt_number}`);
    }

    pdfPath = path.resolve(uploadDir, first.pdf_key);
    if (!existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    const size = statSync(pdfPath).size;
    if (size <= 1024) throw new Error(`PDF too small: ${size} bytes`);

    console.log('Receipt smoke OK', {
      receipt_number: first.receipt_number,
      pdf_key: first.pdf_key,
      size,
    });
  } finally {
    await sql`DELETE FROM payment_receipts WHERE payment_link_id = ${link.id}`;
    await sql`DELETE FROM payment_links WHERE id = ${link.id}`;
    await sql`DELETE FROM invoices WHERE id = ${invoice.id}`;
    await sql`DELETE FROM customers WHERE id = ${customer.id}`;
    if (pdfPath && existsSync(pdfPath)) unlinkSync(pdfPath);
    await sql.end();
  }
}

main().catch(async (error) => {
  console.error('Receipt smoke failed:', error instanceof Error ? error.message : error);
  await sql.end();
  process.exit(1);
});
