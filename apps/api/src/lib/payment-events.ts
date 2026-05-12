/**
 * Central payment-success / refund / failure dispatcher.
 *
 * Both webhooks (Stripe, PayPal) and synchronous return-URL handlers funnel
 * here so the idempotency / DB cascade / email / receipt logic lives in ONE place.
 *
 * Contracts:
 *  - `recordPaymentSuccess` is idempotent: re-calling it for an already-paid
 *    payment_link is a no-op (returns `{ alreadyProcessed: true }`).
 *  - It mutates: payment_links, payment_schedules, optionally invoices.
 *  - It emits: payment-confirmed email (best-effort), receipt PDF (best-effort
 *    once Phase 4 lands; currently no-op stub).
 */

import { sql, sqlv } from '../db';
import { sendEmail } from './email';
import { renderPaymentConfirmedEmail } from '../templates/payment-confirmed';
import { maskPII } from './webhook-sanitize';

export type PaymentProvider = 'stripe' | 'paypal' | 'revolut' | 'bank_transfer';

export interface RecordPaymentSuccessInput {
  /** Provider that completed the payment. */
  provider: PaymentProvider;
  /** Provider-side reference (Stripe checkout session id / PayPal order id). */
  providerOrderId: string;
  /** Amount captured (major units, e.g. EUR 25.00 → 25.00). */
  amount: number;
  /** ISO currency (uppercase). Default EUR. */
  currency?: string;
  /** Payer email if known. Used to update payment_links.payer_email. */
  payerEmail?: string | null;
  /** Optional explicit paid-at timestamp; defaults to NOW(). */
  paidAt?: string;
  /**
   * Fallback locator if `providerOrderId` is not found in payment_links.
   * Useful for the Stripe `checkout.session.completed` event whose
   * `session.metadata.payment_schedule_id` is the authoritative link.
   */
  scheduleIdFallback?: string | null;
}

export interface RecordPaymentSuccessResult {
  /** True if the link was already marked paid before this call. */
  alreadyProcessed: boolean;
  /** payment_link row id if matched. */
  paymentLinkId: string | null;
  /** payment_schedule row id if cascade applied. */
  paymentScheduleId: string | null;
  /** invoice row id if cascade applied. */
  invoiceId: string | null;
  /** Customer id (for downstream actions e.g. receipt PDF generation). */
  customerId: string | null;
}

interface PaymentLinkRow {
  id: string;
  payment_schedule_id: string | null;
  invoice_id: string | null;
  quote_id: string | null;
  provider: string;
  amount: number;
  currency: string;
  status: string;
  payload_json: Record<string, unknown> | null;
}

interface ScheduleRow {
  id: string;
  amount: number;
  paid_amount: number;
  invoice_id: string | null;
  quote_id: string | null;
}

/**
 * Look up the payment_links row this provider event refers to.
 * Order:
 *   1. (provider, provider_order_id) — primary, set when /links was created
 *   2. scheduleIdFallback — for Stripe sessions that carry schedule_id in metadata
 */
async function findPaymentLink(
  provider: PaymentProvider,
  providerOrderId: string,
  scheduleIdFallback?: string | null,
): Promise<PaymentLinkRow | null> {
  const [byOrder] = await sql`
    SELECT id, payment_schedule_id, invoice_id, quote_id, provider, amount, currency, status, payload_json
    FROM payment_links
    WHERE provider = ${provider} AND provider_order_id = ${providerOrderId}
    LIMIT 1
  ` as PaymentLinkRow[];

  if (byOrder) return byOrder;

  if (scheduleIdFallback) {
    const [bySchedule] = await sql`
      SELECT id, payment_schedule_id, invoice_id, quote_id, provider, amount, currency, status, payload_json
      FROM payment_links
      WHERE provider = ${provider} AND payment_schedule_id = ${scheduleIdFallback}
        AND status IN ('pending', 'active')
      ORDER BY created_at DESC
      LIMIT 1
    ` as PaymentLinkRow[];
    return bySchedule ?? null;
  }

  return null;
}

/**
 * Idempotent record-payment-success.
 * Safe to call from BOTH the webhook AND the return-URL handler.
 */
export async function recordPaymentSuccess(
  input: RecordPaymentSuccessInput,
): Promise<RecordPaymentSuccessResult> {
  const currency = (input.currency ?? 'EUR').toUpperCase();
  const paidAt = input.paidAt ?? new Date().toISOString();

  const link = await findPaymentLink(input.provider, input.providerOrderId, input.scheduleIdFallback);

  if (!link) {
    // Soft-fail: log a webhook event row so admin can inspect, but don't throw.
    await sql`
      INSERT INTO payment_webhook_events ${sql({
        provider: input.provider,
        event_type: 'orphan_payment_success',
        external_id: input.providerOrderId,
        signature_valid: null,
        payload_json: sqlv(maskPII({
          amount: input.amount,
          currency,
          payer_email: input.payerEmail ?? null,
          note: 'No matching payment_links row',
        }) as Record<string, unknown>),
        status: 'received',
      })}
    `;
    return {
      alreadyProcessed: false,
      paymentLinkId: null,
      paymentScheduleId: null,
      invoiceId: null,
      customerId: null,
    };
  }

  // ── Idempotency guard ──────────────────────────────────────
  if (link.status === 'paid' || link.status === 'refunded' || link.status === 'partially_refunded') {
    return {
      alreadyProcessed: true,
      paymentLinkId: link.id,
      paymentScheduleId: link.payment_schedule_id,
      invoiceId: link.invoice_id,
      customerId: await resolveCustomerId(link),
    };
  }

  // ── 1. Mark payment_link as paid ───────────────────────────
  await sql`
    UPDATE payment_links
    SET
      status = 'paid',
      paid_at = ${paidAt},
      payer_email = COALESCE(${input.payerEmail ?? null}, payer_email),
      updated_at = NOW()
    WHERE id = ${link.id} AND status != 'paid'
  `;

  // ── 2. Cascade onto payment_schedules ──────────────────────
  let scheduleId: string | null = null;
  let invoiceIdFromSchedule: string | null = null;
  if (link.payment_schedule_id) {
    scheduleId = link.payment_schedule_id;
    const [schedule] = await sql`
      SELECT id, amount, paid_amount, invoice_id, quote_id
      FROM payment_schedules
      WHERE id = ${link.payment_schedule_id}
      LIMIT 1
    ` as ScheduleRow[];

    if (schedule) {
      const newPaidAmount = Number(schedule.paid_amount ?? 0) + Number(input.amount);
      const fullyPaid = newPaidAmount >= Number(schedule.amount);
      await sql`
        UPDATE payment_schedules
        SET
          paid_amount = ${newPaidAmount},
          status = ${fullyPaid ? 'paid' : 'partial'},
          paid_at = ${fullyPaid ? paidAt : null},
          updated_at = NOW()
        WHERE id = ${schedule.id}
      `;
      invoiceIdFromSchedule = schedule.invoice_id ?? null;
    }
  }

  // ── 3. Cascade onto invoice ────────────────────────────────
  // Riconcilia l'invoice in 2 modi:
  // a) link diretto senza schedule → somma da payment_links direct + schedules
  // b) link via schedule → ricalcola amount_paid sommando tutte le schedule
  //    paid + i payment_links diretti paid della stessa invoice. Così resta
  //    coerente con rate multiple e link misti.
  let invoiceId: string | null = link.invoice_id ?? invoiceIdFromSchedule;
  if (invoiceId) {
    await sql`
      UPDATE invoices i
      SET
        amount_paid = COALESCE((
          SELECT SUM(ps.paid_amount)
          FROM payment_schedules ps
          WHERE ps.invoice_id = i.id
        ), 0) + COALESCE((
          SELECT SUM(pl.amount)
          FROM payment_links pl
          WHERE pl.invoice_id = i.id
            AND pl.payment_schedule_id IS NULL
            AND pl.status = 'paid'
        ), 0),
        amount_due = GREATEST(0, i.total - (
          COALESCE((SELECT SUM(ps.paid_amount) FROM payment_schedules ps WHERE ps.invoice_id = i.id), 0)
          + COALESCE((SELECT SUM(pl.amount) FROM payment_links pl WHERE pl.invoice_id = i.id AND pl.payment_schedule_id IS NULL AND pl.status = 'paid'), 0)
        )),
        status = CASE
          WHEN (
            COALESCE((SELECT SUM(ps.paid_amount) FROM payment_schedules ps WHERE ps.invoice_id = i.id), 0)
            + COALESCE((SELECT SUM(pl.amount) FROM payment_links pl WHERE pl.invoice_id = i.id AND pl.payment_schedule_id IS NULL AND pl.status = 'paid'), 0)
          ) >= i.total THEN 'paid'
          ELSE i.status
        END,
        payment_status = CASE
          WHEN (
            COALESCE((SELECT SUM(ps.paid_amount) FROM payment_schedules ps WHERE ps.invoice_id = i.id), 0)
            + COALESCE((SELECT SUM(pl.amount) FROM payment_links pl WHERE pl.invoice_id = i.id AND pl.payment_schedule_id IS NULL AND pl.status = 'paid'), 0)
          ) >= i.total THEN 'paid'
          WHEN (
            COALESCE((SELECT SUM(ps.paid_amount) FROM payment_schedules ps WHERE ps.invoice_id = i.id), 0)
            + COALESCE((SELECT SUM(pl.amount) FROM payment_links pl WHERE pl.invoice_id = i.id AND pl.payment_schedule_id IS NULL AND pl.status = 'paid'), 0)
          ) > 0 THEN 'partial'
          ELSE 'unpaid'
        END,
        paid_at = CASE
          WHEN (
            COALESCE((SELECT SUM(ps.paid_amount) FROM payment_schedules ps WHERE ps.invoice_id = i.id), 0)
            + COALESCE((SELECT SUM(pl.amount) FROM payment_links pl WHERE pl.invoice_id = i.id AND pl.payment_schedule_id IS NULL AND pl.status = 'paid'), 0)
          ) >= i.total AND i.paid_at IS NULL THEN ${paidAt}
          ELSE i.paid_at
        END,
        updated_at = NOW()
      WHERE i.id = ${invoiceId}
    `;
  }

  // ── 4. Resolve customer + generate receipt (best-effort) ─
  const customerId = await resolveCustomerId(link);
  const receipt = await maybeGenerateReceipt({
    linkId: link.id,
    scheduleId,
    invoiceId,
    customerId,
    amount: input.amount,
    currency,
    provider: input.provider,
  }).catch((err) => {
    console.error('[payment-events] receipt generation failed:', (err as Error).message);
    return null;
  });

  // ── 5. Send confirmation email (best-effort) ─
  void sendPaymentConfirmedEmail({
    linkId: link.id,
    scheduleId,
    invoiceId,
    customerId,
    amount: input.amount,
    currency,
    paidAt,
    receiptUrl: receipt?.pdf_url ?? null,
  }).catch((err) => {
    console.error('[payment-events] confirmation email failed:', (err as Error).message);
  });

  return {
    alreadyProcessed: false,
    paymentLinkId: link.id,
    paymentScheduleId: scheduleId,
    invoiceId,
    customerId,
  };
}

/**
 * Refund accounting on a payment_link.
 * Adds to refunded_amount + appends history. Does NOT call provider APIs —
 * that responsibility sits in the route handler that knows which lib to use.
 */
export interface RecordRefundInput {
  paymentLinkId: string;
  amount: number;
  currency?: string;
  providerRefundId: string;
  reason?: string | null;
  refundedBy?: string | null; // admin user id
}

export async function recordRefund(input: RecordRefundInput): Promise<{
  newRefundedAmount: number;
  fullyRefunded: boolean;
  paymentLinkStatus: 'paid' | 'refunded' | 'partially_refunded';
}> {
  const [link] = await sql`
    SELECT id, amount, refunded_amount, currency, refund_history, status
    FROM payment_links
    WHERE id = ${input.paymentLinkId}
    LIMIT 1
  ` as Array<{
    id: string;
    amount: number;
    refunded_amount: number;
    currency: string;
    refund_history: unknown;
    status: string;
  }>;

  if (!link) throw new Error(`payment_link ${input.paymentLinkId} not found`);

  const currentRefunded = Number(link.refunded_amount ?? 0);
  const newRefunded = currentRefunded + Number(input.amount);
  const linkAmount = Number(link.amount);
  const fullyRefunded = newRefunded >= linkAmount;
  const newStatus: 'paid' | 'refunded' | 'partially_refunded' = fullyRefunded
    ? 'refunded'
    : newRefunded > 0
      ? 'partially_refunded'
      : 'paid';

  const history = Array.isArray(link.refund_history) ? link.refund_history : [];
  history.push({
    at: new Date().toISOString(),
    amount: input.amount,
    currency: (input.currency ?? link.currency).toUpperCase(),
    provider_refund_id: input.providerRefundId,
    reason: input.reason ?? null,
    refunded_by: input.refundedBy ?? null,
  });

  await sql`
    UPDATE payment_links
    SET
      refunded_amount = ${newRefunded},
      refund_history = ${JSON.stringify(history)}::jsonb,
      status = ${newStatus},
      updated_at = NOW()
    WHERE id = ${link.id}
  `;

  return { newRefundedAmount: newRefunded, fullyRefunded, paymentLinkStatus: newStatus };
}

// ─────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────

async function resolveCustomerId(link: PaymentLinkRow): Promise<string | null> {
  if (link.invoice_id) {
    const [row] = await sql`
      SELECT customer_id FROM invoices WHERE id = ${link.invoice_id} LIMIT 1
    ` as Array<{ customer_id: string | null }>;
    if (row?.customer_id) return row.customer_id;
  }
  if (link.quote_id) {
    const [row] = await sql`
      SELECT customer_id FROM quotes WHERE id = ${link.quote_id} LIMIT 1
    ` as Array<{ customer_id: string | null }>;
    if (row?.customer_id) return row.customer_id;
  }
  if (link.payment_schedule_id) {
    const [row] = await sql`
      SELECT COALESCE(q.customer_id, i.customer_id) AS customer_id
      FROM payment_schedules ps
      LEFT JOIN quotes q ON q.id = ps.quote_id
      LEFT JOIN invoices i ON i.id = ps.invoice_id
      WHERE ps.id = ${link.payment_schedule_id}
      LIMIT 1
    ` as Array<{ customer_id: string | null }>;
    if (row?.customer_id) return row.customer_id;
  }
  return null;
}

interface ConfirmationContext {
  linkId: string;
  scheduleId: string | null;
  invoiceId: string | null;
  customerId: string | null;
  amount: number;
  currency: string;
  paidAt: string;
  receiptUrl?: string | null;
}

async function sendPaymentConfirmedEmail(ctx: ConfirmationContext): Promise<void> {
  if (!ctx.customerId) return;

  const [customer] = await sql`
    SELECT email, contact_name, company_name
    FROM customers WHERE id = ${ctx.customerId} LIMIT 1
  ` as Array<{ email: string | null; contact_name: string | null; company_name: string | null }>;

  if (!customer?.email) return;

  // Best-effort: pick an invoice number to mention in the email.
  let invoiceNumber = '—';
  if (ctx.invoiceId) {
    const [inv] = await sql`
      SELECT invoice_number FROM invoices WHERE id = ${ctx.invoiceId} LIMIT 1
    ` as Array<{ invoice_number: string }>;
    if (inv?.invoice_number) invoiceNumber = inv.invoice_number;
  } else if (ctx.scheduleId) {
    const [scheduleInvoice] = await sql`
      SELECT COALESCE(i.invoice_number, q.quote_number) AS ref
      FROM payment_schedules ps
      LEFT JOIN invoices i ON i.id = ps.invoice_id
      LEFT JOIN quotes q ON q.id = ps.quote_id
      WHERE ps.id = ${ctx.scheduleId}
      LIMIT 1
    ` as Array<{ ref: string | null }>;
    if (scheduleInvoice?.ref) invoiceNumber = scheduleInvoice.ref;
  }

  const amountLabel = new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: ctx.currency,
  }).format(ctx.amount);

  const paidAtLabel = new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(ctx.paidAt));

  const portalBase = process.env.PORTAL_RETURN_BASE_URL ?? process.env.PORTAL_BASE_URL ?? 'http://localhost:3000';
  const invoiceUrl = ctx.invoiceId
    ? `${portalBase}/it/clienti/fatture/${ctx.invoiceId}`
    : `${portalBase}/it/clienti/fatture`;

  const rendered = await renderPaymentConfirmedEmail({
    contactName: customer.contact_name ?? customer.company_name ?? null,
    invoiceNumber,
    amountLabel,
    paidAt: paidAtLabel,
    invoiceUrl,
    receiptUrl: ctx.receiptUrl ?? null,
    lang: 'it',
  });

  await sendEmail({
    to: customer.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    transport: 'critical',
  });
}

/**
 * Phase 4 hook: generate the PDF receipt + insert payment_receipts row.
 * Implementation lives in `lib/receipt-pdf.ts` (created in Phase 4 by Codex).
 * Until then this is a no-op stub that returns without side effects.
 */
async function maybeGenerateReceipt(ctx: {
  linkId: string;
  scheduleId: string | null;
  invoiceId: string | null;
  customerId: string | null;
  amount: number;
  currency: string;
  provider: PaymentProvider;
}): Promise<{ pdf_url: string } | null> {
  try {
    const specifier = './receipt-pdf' as string;
    const mod: unknown = await import(specifier).catch(() => null);
    if (!mod || typeof mod !== 'object') return null;
    const fn = (mod as { generateReceiptForPaymentLink?: unknown }).generateReceiptForPaymentLink;
    if (typeof fn !== 'function') return null;
    return await (fn as (input: typeof ctx & { paymentLinkId: string }) => Promise<{ pdf_url: string }>)({
      ...ctx,
      paymentLinkId: ctx.linkId,
    });
  } catch (err) {
    console.warn('[payment-events] receipt-pdf module not ready:', (err as Error).message);
    return null;
  }
}
