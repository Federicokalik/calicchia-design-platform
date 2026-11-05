/**
 * Proforma (design: docs/proforma/design.md; logica in lib/proforma/*).
 *
 *   GET    /api/proformas                 elenco (status, customer_id, domain_id, year)
 *   GET    /api/proformas/:id             dettaglio con URL firmato del PDF
 *   POST   /api/proformas                 bozza { customer_id, lines[], due_days?, notes? }
 *   PATCH  /api/proformas/:id             modifica della bozza
 *   DELETE /api/proformas/:id             elimina una bozza (le emesse si annullano)
 *   POST   /api/proformas/:id/issue       emissione { issue_date?, number? } → numero PF n/anno + PDF
 *   GET    /api/proformas/:id/pdf         PDF (generato se manca)
 *   POST   /api/proformas/:id/pdf         rigenera il PDF
 *   POST   /api/proformas/:id/send        invio email con il PDF allegato (casella collegata)
 *   POST   /api/proformas/:id/draft-email bozza in Posta con il PDF allegato
 *   POST   /api/proformas/:id/mark-paid   pagamento → fattura (bozza, salvo invoice_status "paid") + rinnovo domini
 *   POST   /api/proformas/:id/cancel      annulla
 *
 * ProformaError (4xx con messaggio) e MailDeliveryError (502) sono mappati
 * da app.onError.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from '../db';
import { addressListSchema } from '../lib/mail/message-schema';
import { draftProformaEmail, sendProforma } from '../lib/proforma/send';
import {
  cancelProforma,
  createProformaDraft,
  generateProformaPdf,
  getProforma,
  issueProforma,
  listProformas,
  markProformaPaid,
  presentProforma,
  proformaPdf,
  updateProformaDraft,
} from '../lib/proforma/service';
import { presentDraft } from '../lib/mail/drafts';
import { eurosToCents, type ProformaLineInput } from '../lib/proforma/totals';
import { fieldError, isoDateSchema, parseOr400 } from '../lib/validation';

export const proformas = new Hono();

const euroAmount = z
  .union([z.number(), z.string().trim().regex(/^\d+([.,]\d{1,2})?$/, 'importo non valido (es. 15 o 15,50)')])
  .transform((v) => eurosToCents(v))
  .refine((c) => Number.isFinite(c) && c >= 0 && c <= 100_000_000, 'importo non valido');

const lineSchema = z
  .object({
    kind: z.enum(['service', 'domain_renewal']).optional(),
    description: z.string().trim().min(1).max(500),
    quantity: z.number().positive().max(10_000).refine((q) => Math.round(q * 1000) === q * 1000, 'al massimo 3 decimali').default(1),
    unit_price: euroAmount,
    domain_id: z.string().uuid().optional(),
    years: z.number().int().min(1).max(10).optional(),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (l.kind === 'domain_renewal' && !l.domain_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domain_id'], message: 'obbligatorio per kind = domain_renewal' });
    }
  });

const LINE_HINTS: Readonly<Record<string, string>> = {
  price: 'unit_price', prezzo: 'unit_price', amount: 'unit_price (prezzo unitario in euro)', unit_price_cents: 'unit_price (in euro)',
  qty: 'quantity', quantita: 'quantity', descrizione: 'description', items: 'lines', line_items: 'lines', righe: 'lines',
  customer: 'customer_id', due_date: 'due_days', scadenza: 'due_days', numero: 'number',
};

const createSchema = z
  .object({
    customer_id: z.string().uuid(),
    lines: z.array(lineSchema).min(1).max(50),
    due_days: z.number().int().min(0).max(365).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

const patchSchema = createSchema.partial().strict();

const issueSchema = z
  .object({
    issue_date: isoDateSchema.optional(),
    number: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
  })
  .strict();

const mailSchema = z
  .object({
    account_id: z.string().uuid().optional(),
    to: addressListSchema.optional(),
    cc: addressListSchema.optional(),
    subject: z.string().max(998).optional(),
    text: z.string().max(20_000).optional(),
  })
  .strict();

const markPaidSchema = z
  .object({
    paid_at: z.union([isoDateSchema, z.string().datetime({ offset: true })]).optional(),
    payment_method: z.string().trim().max(100).optional(),
    amount: z.number().positive().optional(),
    invoice_status: z.enum(['draft', 'paid']).optional(),
    invoice_number: z.string().trim().min(1).max(50).optional(),
  })
  .strict();

const cancelSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

function toLineInputs(lines: z.output<typeof lineSchema>[]): ProformaLineInput[] {
  return lines.map((l) => ({
    kind: l.kind,
    description: l.description,
    quantity: l.quantity,
    unit_price_cents: l.unit_price,
    ...(l.domain_id ? { domain_id: l.domain_id } : {}),
    ...(l.years ? { years: l.years } : {}),
  }));
}

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => {
    throw fieldError([], 'JSON non valido');
  });
}

/** Body facoltativo (POST senza body = {}). */
async function optionalJsonBody(c: { req: { header: (n: string) => string | undefined; text: () => Promise<string> } }): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw fieldError([], 'JSON non valido');
  }
}

proformas.get('/', async (c) => {
  const q = parseOr400(
    z.object({
      status: z.enum(['draft', 'issued', 'sent', 'converted', 'cancelled']).optional(),
      customer_id: z.string().uuid().optional(),
      domain_id: z.string().uuid().optional(),
      year: z.coerce.number().int().min(2000).max(2999).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).strict(),
    c.req.query(),
  );
  const rows = await listProformas(q);
  return c.json({ proformas: rows.map(presentProforma), count: rows.length });
});

proformas.get('/:id', async (c) => {
  const row = await getProforma(c.req.param('id'));
  if (!row) return c.json({ error: 'Proforma non trovata' }, 404);
  return c.json({ proforma: presentProforma(row) });
});

proformas.post('/', async (c) => {
  const body = parseOr400(createSchema, await jsonBody(c), LINE_HINTS);
  const row = await createProformaDraft({ ...body, lines: toLineInputs(body.lines) });
  return c.json({ proforma: presentProforma(row) }, 201);
});

proformas.patch('/:id', async (c) => {
  const body = parseOr400(patchSchema, await jsonBody(c), LINE_HINTS);
  if (!Object.keys(body).length) throw fieldError([], 'nessun campo da aggiornare');
  const row = await updateProformaDraft(c.req.param('id'), { ...body, lines: body.lines ? toLineInputs(body.lines) : undefined });
  return c.json({ proforma: presentProforma(row) });
});

proformas.delete('/:id', async (c) => {
  const [row] = await sql`DELETE FROM proformas WHERE id = ${c.req.param('id')} AND status = 'draft' RETURNING id`;
  if (row) return c.json({ success: true });
  const existing = await getProforma(c.req.param('id'));
  if (!existing) return c.json({ error: 'Proforma non trovata' }, 404);
  return c.json({ error: `Solo le bozze si eliminano: questa è ${existing.number} (${existing.status}), usa /cancel` }, 409);
});

proformas.post('/:id/issue', async (c) => {
  const body = parseOr400(issueSchema, await optionalJsonBody(c), LINE_HINTS);
  const result = await issueProforma(c.req.param('id'), body);
  return c.json({ proforma: presentProforma(result.proforma), ...(result.pdf_error ? { pdf_error: result.pdf_error } : {}) });
});

proformas.get('/:id/pdf', async (c) => {
  const { buffer, filename } = await proformaPdf(c.req.param('id'));
  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});

proformas.post('/:id/pdf', async (c) => {
  const row = await generateProformaPdf(c.req.param('id'));
  return c.json({ proforma: presentProforma(row) });
});

proformas.post('/:id/send', async (c) => {
  const body = parseOr400(mailSchema, await optionalJsonBody(c));
  const result = await sendProforma(c.req.param('id'), body);
  return c.json({
    proforma: presentProforma(result.proforma),
    to: result.to,
    message_id: result.delivery.messageId,
    sent_copy: result.delivery.sentCopy,
  });
});

proformas.post('/:id/draft-email', async (c) => {
  const body = parseOr400(mailSchema, await optionalJsonBody(c));
  const result = await draftProformaEmail(c.req.param('id'), body);
  return c.json({ proforma: presentProforma(result.proforma), draft: presentDraft(result.draft), open_url: `/posta?draft=${result.draft.id}` }, 201);
});

proformas.post('/:id/mark-paid', async (c) => {
  const body = parseOr400(markPaidSchema, await optionalJsonBody(c));
  const result = await markProformaPaid(c.req.param('id'), body);
  return c.json({
    proforma: presentProforma(result.proforma),
    invoice: result.invoice,
    renewals: result.renewals,
    already_converted: result.already_converted,
    ...(result.warnings.length ? { warnings: result.warnings } : {}),
  });
});

proformas.post('/:id/cancel', async (c) => {
  const body = parseOr400(cancelSchema, await optionalJsonBody(c));
  const row = await cancelProforma(c.req.param('id'), body.reason);
  return c.json({ proforma: presentProforma(row) });
});
