import puppeteer from 'puppeteer';
import { sql } from '../db';
import { uploadFile } from './s3';
import { renderReceiptHtml, type ReceiptLineItem } from '../templates/receipt-html';

interface GenerateReceiptInput {
  paymentLinkId: string;
}

export interface ReceiptSummary {
  id: string;
  payment_link_id: string;
  receipt_number: string;
  pdf_key: string;
  pdf_url: string;
  amount: number;
  currency: string;
  issued_at: string;
}

type PaymentLinkReceiptRow = {
  id: string;
  payment_schedule_id: string | null;
  invoice_id: string | null;
  quote_id: string | null;
  provider: string;
  provider_order_id: string | null;
  amount: number;
  currency: string;
  status: string;
  paid_at: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  billing_address: Record<string, unknown> | null;
  invoice_number: string | null;
  invoice_line_items: unknown;
  quote_line_items: unknown;
};

function lineItemsFrom(value: unknown): ReceiptLineItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      description: String(item.description ?? item.name ?? 'Servizio'),
      quantity: item.quantity != null ? Number(item.quantity) : 1,
      unit_price: item.unit_price != null ? Number(item.unit_price) : undefined,
      amount: Number(item.amount ?? item.total ?? item.unit_price ?? 0),
    }))
    .filter((item) => Number.isFinite(item.amount));
}

function formatAddress(value: Record<string, unknown> | null): string | null {
  if (!value) return null;
  const parts = [
    value.street,
    [value.postal_code, value.city].filter(Boolean).join(' '),
    value.province,
    value.country,
  ].filter(Boolean);
  return parts.length > 0 ? parts.map(String).join(', ') : null;
}

async function renderPdf(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ...(process.platform === 'win32' ? {
      executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    } : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '18mm', right: '18mm', bottom: '22mm', left: '18mm' },
      printBackground: true,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

export async function generateReceiptForPaymentLink(
  input: GenerateReceiptInput,
): Promise<ReceiptSummary> {
  const [existing] = await sql`
    SELECT id, payment_link_id, receipt_number, pdf_key, pdf_url, amount, currency, issued_at
    FROM payment_receipts
    WHERE payment_link_id = ${input.paymentLinkId}
    LIMIT 1
  ` as ReceiptSummary[];

  if (existing) return existing;

  const [link] = await sql`
    SELECT
      pl.id,
      pl.payment_schedule_id,
      pl.invoice_id,
      pl.quote_id,
      pl.provider,
      pl.provider_order_id,
      pl.amount,
      pl.currency,
      pl.status,
      pl.paid_at,
      COALESCE(i.customer_id, q.customer_id, si.customer_id, sq.customer_id) AS customer_id,
      COALESCE(c.company_name, c.contact_name) AS customer_name,
      c.email AS customer_email,
      c.billing_address,
      COALESCE(i.invoice_number, si.invoice_number, q.quote_number, sq.quote_number) AS invoice_number,
      COALESCE(i.line_items, si.line_items) AS invoice_line_items,
      COALESCE(q.line_items, sq.line_items) AS quote_line_items
    FROM payment_links pl
    LEFT JOIN invoices i ON i.id = pl.invoice_id
    LEFT JOIN quotes q ON q.id = pl.quote_id
    LEFT JOIN payment_schedules ps ON ps.id = pl.payment_schedule_id
    LEFT JOIN invoices si ON si.id = ps.invoice_id
    LEFT JOIN quotes sq ON sq.id = ps.quote_id
    LEFT JOIN customers c ON c.id = COALESCE(i.customer_id, q.customer_id, si.customer_id, sq.customer_id)
    WHERE pl.id = ${input.paymentLinkId}
    LIMIT 1
  ` as PaymentLinkReceiptRow[];

  if (!link) throw new Error(`Payment link ${input.paymentLinkId} not found`);
  if (!['paid', 'refunded', 'partially_refunded'].includes(link.status)) {
    throw new Error(`Payment link ${input.paymentLinkId} is not paid`);
  }

  const issuedAt = new Date();
  const year = issuedAt.getFullYear();
  const [counter] = await sql`
    INSERT INTO payment_receipt_counter (year, last_value)
    VALUES (${year}, 1)
    ON CONFLICT (year) DO UPDATE
      SET last_value = payment_receipt_counter.last_value + 1
    RETURNING last_value
  ` as Array<{ last_value: number }>;

  const receiptNumber = `R-${year}-${String(counter.last_value).padStart(4, '0')}`;
  const lineItems = lineItemsFrom(link.invoice_line_items);
  const fallbackLineItems = lineItems.length > 0 ? lineItems : lineItemsFrom(link.quote_line_items);
  const html = renderReceiptHtml({
    receipt_number: receiptNumber,
    issued_at: issuedAt.toISOString(),
    customer_name: link.customer_name ?? 'Cliente',
    customer_email: link.customer_email,
    customer_address: formatAddress(link.billing_address),
    amount: Number(link.amount),
    currency: link.currency,
    paid_at: link.paid_at,
    provider: link.provider,
    provider_reference: link.provider_order_id,
    invoice_number: link.invoice_number,
    line_items: fallbackLineItems,
  });

  const pdf = await renderPdf(html);
  const key = `receipts/${link.id}.pdf`;
  const uploaded = await uploadFile(pdf, key, 'application/pdf', {
    receipt_number: receiptNumber,
    payment_link_id: link.id,
  });

  const [inserted] = await sql`
    INSERT INTO payment_receipts ${sql({
      payment_link_id: link.id,
      customer_id: link.customer_id,
      invoice_id: link.invoice_id,
      schedule_id: link.payment_schedule_id,
      pdf_key: uploaded.key,
      pdf_url: uploaded.url,
      receipt_number: receiptNumber,
      amount: Number(link.amount),
      currency: link.currency,
      provider: link.provider,
      issued_at: issuedAt.toISOString(),
    })}
    ON CONFLICT (payment_link_id) DO NOTHING
    RETURNING id, payment_link_id, receipt_number, pdf_key, pdf_url, amount, currency, issued_at
  ` as ReceiptSummary[];

  if (inserted) return inserted;

  const [afterConflict] = await sql`
    SELECT id, payment_link_id, receipt_number, pdf_key, pdf_url, amount, currency, issued_at
    FROM payment_receipts
    WHERE payment_link_id = ${input.paymentLinkId}
    LIMIT 1
  ` as ReceiptSummary[];

  if (!afterConflict) throw new Error('Receipt insert conflict without existing row');
  return afterConflict;
}
