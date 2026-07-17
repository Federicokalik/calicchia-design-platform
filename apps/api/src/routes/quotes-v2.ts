import { Hono } from 'hono';
import crypto from 'crypto';
import { sql } from '../db';
import { sanitizeBlogHtml } from '../lib/html-sanitize';

// Sanitize Tiptap-authored HTML inside line items before persist (audit D-002).
// Items are rendered raw on the public quote-sign page; an admin compromise or
// a hand-rolled POST could otherwise inject <script> into the signing surface.
function sanitizeItems(items: unknown): unknown[] {
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    if (!it || typeof it !== 'object') return it;
    const item = it as Record<string, unknown>;
    if (typeof item.description === 'string') {
      return { ...item, description: sanitizeBlogHtml(item.description) };
    }
    return item;
  });
}
import { sendEmail } from '../lib/email';
import { sendWhatsAppText, sendWhatsAppMedia, isWhatsAppConfigured } from '../lib/whatsapp';
import { renderQuoteHtml, injectSignatureIntoCustomHtml } from '../lib/quote-renderer';
import { generateQuotePdf } from '../lib/quote-pdf';
import { savePrivateFile, readPrivateFile } from '../lib/private-files';
import { unbundleArtifactHtml, cleanCustomQuoteHtml } from '../lib/artifact-unbundle';
import {
  generateQuoteDraft,
  generateQuoteFromMarkdown,
  GenerateQuoteInputSchema,
  GenerateFromMarkdownInputSchema,
} from '../lib/quotes/generate';
import { sendQuote } from '../lib/quotes/send';
import { logger } from '../lib/logger';

const log = logger.child({ scope: 'quotes-v2' });

export const quotesV2 = new Hono();

// GET /api/quotes-v2 — list all quotes
quotesV2.get('/', async (c) => {
  const status = c.req.query('status');
  const customerId = c.req.query('customer_id');

  const statusFilter = status && status !== 'all' ? sql`AND q.status = ${status}` : sql``;
  const customerFilter = customerId ? sql`AND q.customer_id = ${customerId}` : sql``;

  const rows = await sql`
    SELECT q.*,
      c.contact_name AS customer_name,
      c.company_name,
      c.email AS customer_email,
      c.phone AS customer_phone
    FROM quotes_v2 q
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE 1=1 ${statusFilter} ${customerFilter}
    ORDER BY q.created_at DESC
  `;

  const stats = {
    total: rows.length,
    draft: rows.filter((r) => r.status === 'draft').length,
    sent: rows.filter((r) => r.status === 'sent').length,
    signed: rows.filter((r) => r.status === 'signed').length,
    totalValue: rows.reduce((sum, r) => sum + parseFloat(r.total || '0'), 0),
  };

  return c.json({ quotes: rows, stats });
});

// GET /api/quotes-v2/:id — single quote
quotesV2.get('/:id', async (c) => {
  const { id } = c.req.param();
  const rows = await sql`
    SELECT q.*,
      c.contact_name AS customer_name,
      c.company_name,
      c.email AS customer_email,
      c.phone AS customer_phone
    FROM quotes_v2 q
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.id = ${id}
  `;
  if (!rows.length) return c.json({ error: 'Preventivo non trovato' }, 404);

  // Fetch audit log
  const audit = await sql`
    SELECT * FROM signature_audit_log WHERE quote_id = ${id} ORDER BY created_at ASC
  `;

  return c.json({ quote: rows[0], audit });
});

// POST /api/quotes-v2/generate — AI-assisted quote generation
// Auth: admin only (enforced by middleware on /api/quotes-v2 in app.ts).
// Privacy invariant: only services/budget/notes reach the LLM. Client identity
// (customer_id, names) is stored as metadata and never sent to the model.
// Idempotency: optional Idempotency-Key header, in-memory 10 min TTL.
quotesV2.post('/generate', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key') || undefined;
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Body JSON non valido' }, 400);
  }
  const parseResult = GenerateQuoteInputSchema.safeParse(rawBody);
  if (!parseResult.success) {
    return c.json({ error: 'Input non valido', details: parseResult.error.flatten() }, 400);
  }
  try {
    const draft = await generateQuoteDraft(parseResult.data, { idempotencyKey });
    return c.json(draft, 201);
  } catch (err) {
    log.error({ err }, 'quotes-v2 generate error');
    return c.json(
      { error: 'Generazione preventivo fallita', detail: (err as Error).message },
      502,
    );
  }
});

// POST /api/quotes-v2/generate-from-markdown — AI quote draft from a Markdown
// brief (YAML frontmatter + prose). Auth: admin only (middleware in app.ts).
// The draft is inserted as `draft` and never auto-sent. The customer is never
// auto-linked: the response carries non-binding `suggested_customers` matches
// (by name / VAT from the frontmatter) for the admin to confirm in the editor.
quotesV2.post('/generate-from-markdown', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key') || undefined;
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Body JSON non valido' }, 400);
  }
  const parseResult = GenerateFromMarkdownInputSchema.safeParse(rawBody);
  if (!parseResult.success) {
    return c.json({ error: 'Input non valido', details: parseResult.error.flatten() }, 400);
  }

  try {
    const { draft, frontmatter } = await generateQuoteFromMarkdown(parseResult.data, { idempotencyKey });

    // Best-effort customer suggestions from the frontmatter — never binding.
    const nameHint = String(frontmatter.cliente || '').trim() || String(frontmatter.referente || '').trim();
    const pivaHint = String(frontmatter.cliente_piva || frontmatter.piva_cliente || '').replace(/\s+/g, '');
    let suggested: readonly object[] = [];
    if (nameHint || pivaHint) {
      try {
        suggested = await sql`
          SELECT id, contact_name, company_name, email,
                 billing_address->>'vat_number' AS vat_number
          FROM customers
          WHERE (${nameHint} <> '' AND (contact_name ILIKE ${'%' + nameHint + '%'} OR company_name ILIKE ${'%' + nameHint + '%'}))
             OR (${pivaHint} <> '' AND billing_address->>'vat_number' ILIKE ${'%' + pivaHint + '%'})
          LIMIT 5
        `;
      } catch (err) {
        log.warn({ err }, 'customer suggestion lookup failed');
      }
    }

    // Client identity from the frontmatter — used by the editor banner to
    // offer "create & link" when no existing customer matches. Never binding.
    const clientHint = (nameHint || pivaHint)
      ? {
          nome: nameHint,
          piva: pivaHint,
          referente: String(frontmatter.referente || '').trim(),
        }
      : null;

    return c.json({ ...draft, suggested_customers: suggested, client_hint: clientHint }, 201);
  } catch (err) {
    log.error({ err }, 'quotes-v2 generate-from-markdown error');
    return c.json(
      { error: 'Generazione preventivo da Markdown fallita', detail: (err as Error).message },
      502,
    );
  }
});

// POST /api/quotes-v2/import-html — hand-crafted quote document (custom HTML).
// The admin uploads a finished HTML design; the system wraps it with the
// machinery only (totals, PDF, send, OTP sign, vessatorie gate). The HTML is
// stored in the private file store and rendered to PDF as-is — the shared
// template is bypassed. Financial data can't be parsed from arbitrary HTML,
// so totale/pagamento/vessatorie arrive as explicit fields.
quotesV2.post('/import-html', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body JSON non valido' }, 400);
  }

  let html = typeof body.html === 'string' ? body.html : '';
  if (html.length < 200 || html.length > 8 * 1024 * 1024 || !html.includes('<')) {
    return c.json({ error: 'File HTML mancante o non valido (min 200 byte, max 8MB)' }, 400);
  }

  // claude.ai artifact exports arrive "bundled" (assets in __bundler scripts,
  // unpacked by JS at runtime) — unpack server-side so Puppeteer prints the
  // real document deterministically. Plain HTML passes through untouched.
  const unbundled = unbundleArtifactHtml(html);
  if (unbundled) html = unbundled;

  // Cleaner: strip active content and screen-only UI — the stored document is
  // a static print artifact (also keeps scripts out of server-side Chrome).
  const cleaned = cleanCustomQuoteHtml(html);
  html = cleaned.html;

  const totale = Number(body.totale);
  if (!Number.isFinite(totale) || totale < 0) {
    return c.json({ error: 'Totale mancante o non valido' }, 400);
  }

  const title = (typeof body.title === 'string' && body.title.trim())
    || /<title>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim()
    || 'Preventivo su misura';

  const pagamento = Array.isArray(body.pagamento)
    ? body.pagamento
        .filter((p: unknown) => p && typeof p === 'object')
        .map((p: Record<string, unknown>) => ({ nome: String(p.nome ?? '').slice(0, 200), importo: Number(p.importo) || 0 }))
        .filter((p: { nome: string }) => p.nome)
    : [];

  const vessatorie = Array.isArray(body.vessatorie)
    ? body.vessatorie
        .filter((v: unknown) => v && typeof v === 'object')
        .map((v: Record<string, unknown>) => ({ numero: Number(v.numero) || 0, titolo: String(v.titolo ?? '').slice(0, 200) }))
        .filter((v: { titolo: string }) => v.titolo)
    : [];

  const htmlName = `custom_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.html`;
  await savePrivateFile('quotes', htmlName, Buffer.from(html, 'utf-8'));

  const items = [{ description: title, quantity: 1, unit_price: totale, total: totale }];

  const rows = await sql`
    INSERT INTO quotes_v2 (
      customer_id, title, description, items,
      subtotal, tax_rate, tax_amount, total,
      valid_until, internal_notes,
      custom_html_path, project_template
    ) VALUES (
      ${typeof body.customer_id === 'string' && body.customer_id ? body.customer_id : null},
      ${title},
      ${'Documento su misura'},
      ${JSON.stringify(items)},
      ${totale}, ${0}, ${0}, ${totale},
      ${typeof body.valid_until === 'string' && body.valid_until ? body.valid_until : null},
      ${'Importato da HTML su misura.'},
      ${`quotes/${htmlName}`},
      ${JSON.stringify({ custom_html: true, pagamento_custom: pagamento, vessatorie_custom: vessatorie })}
    )
    RETURNING id, title
  `;

  return c.json({ quote_id: rows[0].id, title: rows[0].title, cleaned: cleaned.report }, 201);
});

// POST /api/quotes-v2 — create quote
quotesV2.post('/', async (c) => {
  const body = await c.req.json();
  const { customer_id, lead_id, title, description, items, tax_rate, valid_until, notes, internal_notes, materials_checklist, project_template, auto_create_project } = body;

  if (!title) return c.json({ error: 'Titolo richiesto' }, 400);

  // Calculate totals
  const parsedItems = sanitizeItems(items || []);
  const subtotal = parsedItems.reduce((sum: number, item: any) => sum + (parseFloat(item.total) || 0), 0);
  const rate = tax_rate ?? 22;
  const taxAmount = subtotal * (rate / 100);
  const total = subtotal + taxAmount;

  const rows = await sql`
    INSERT INTO quotes_v2 (
      customer_id, lead_id, title, description, items,
      subtotal, tax_rate, tax_amount, total,
      valid_until, notes, internal_notes,
      materials_checklist, project_template, auto_create_project
    )
    VALUES (
      ${customer_id || null}, ${lead_id || null}, ${title}, ${description || null}, ${JSON.stringify(parsedItems)},
      ${subtotal}, ${rate}, ${taxAmount}, ${total},
      ${valid_until || null}, ${notes || null}, ${internal_notes || null},
      ${JSON.stringify(materials_checklist || [])}, ${JSON.stringify(project_template || null)}, ${auto_create_project ?? true}
    )
    RETURNING *
  `;

  return c.json({ quote: rows[0] }, 201);
});

// POST /api/quotes-v2/:id/convert-to-project — convert quote to project
quotesV2.post('/:id/convert-to-project', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));

  const result = await sql.begin(async (txSql: any) => {
    const [quote] = await txSql`SELECT * FROM quotes_v2 WHERE id = ${id}`;
    if (!quote) return { __error: 'Preventivo non trovato', __status: 404 };

    if (!['signed', 'accepted', 'sent'].includes(quote.status)) {
      return {
        __error: 'Preventivo non in stato convertibile',
        __status: 409,
        current_status: quote.status,
      };
    }

    if (!quote.customer_id) {
      return { __error: 'Preventivo senza cliente associato', __status: 422 };
    }

    if (quote.project_id) {
      return {
        __error: 'Preventivo già convertito',
        __status: 409,
        project_id: quote.project_id,
      };
    }

    const [project] = await txSql`
      INSERT INTO client_projects (
        customer_id, name, description, project_type,
        status, budget_amount, currency
      )
      VALUES (
        ${quote.customer_id},
        ${body.name ?? quote.title},
        ${quote.description},
        ${body.project_type ?? 'website'},
        'approved',
        ${quote.total},
        ${quote.currency}
      )
      RETURNING *
    `;

    await txSql`
      UPDATE quotes_v2
      SET project_id = ${project.id}, updated_at = now()
      WHERE id = ${quote.id}
    `;

    if (quote.lead_id) {
      await txSql`
        UPDATE leads
        SET status = 'won',
            converted_project_id = ${project.id},
            updated_at = now()
        WHERE id = ${quote.lead_id}
      `;
    }

    return { project, quote: { ...quote, project_id: project.id } };
  });

  if (result.__error) {
    if (result.current_status) {
      return c.json({ error: result.__error, current_status: result.current_status }, 409);
    }
    if (result.project_id) {
      return c.json({ error: result.__error, project_id: result.project_id }, 409);
    }
    if (result.__status === 422) return c.json({ error: result.__error }, 422);
    return c.json({ error: result.__error }, 404);
  }

  return c.json(result, 201);
});

// PUT /api/quotes-v2/:id — update quote
quotesV2.put('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  // A signed quote is a binding contract — its content must not change after
  // signature (would desync the "✓ Firmato digitalmente" PDF from what was
  // approved). The editor is reachable by URL even for signed quotes.
  const [existing] = await sql`SELECT status FROM quotes_v2 WHERE id = ${id}`;
  if (!existing) return c.json({ error: 'Preventivo non trovato' }, 404);
  if (existing.status === 'signed') {
    return c.json({ error: 'Preventivo già firmato: non modificabile' }, 409);
  }

  // Recalculate totals if items changed
  let subtotal = body.subtotal;
  let taxAmount = body.tax_amount;
  let total = body.total;

  if (body.items) {
    body.items = sanitizeItems(body.items);
    subtotal = body.items.reduce((sum: number, item: any) => sum + (parseFloat(item.total) || 0), 0);
    const rate = body.tax_rate ?? 22;
    taxAmount = subtotal * (rate / 100);
    total = subtotal + taxAmount;
  }

  const rows = await sql`
    UPDATE quotes_v2 SET
      customer_id = COALESCE(${body.customer_id || null}, customer_id),
      title = COALESCE(${body.title || null}, title),
      description = ${body.description !== undefined ? body.description : null},
      items = COALESCE(${body.items ? JSON.stringify(body.items) : null}, items),
      subtotal = COALESCE(${subtotal}, subtotal),
      tax_rate = COALESCE(${body.tax_rate}, tax_rate),
      tax_amount = COALESCE(${taxAmount}, tax_amount),
      total = COALESCE(${total}, total),
      valid_until = ${body.valid_until !== undefined ? body.valid_until : null},
      notes = ${body.notes !== undefined ? body.notes : sql`notes`},
      internal_notes = ${body.internal_notes !== undefined ? body.internal_notes : null},
      materials_checklist = COALESCE(${body.materials_checklist ? JSON.stringify(body.materials_checklist) : null}, materials_checklist),
      project_template = ${body.project_template !== undefined ? JSON.stringify(body.project_template) : null},
      auto_create_project = ${body.auto_create_project !== undefined ? body.auto_create_project : sql`auto_create_project`},
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;

  if (!rows.length) return c.json({ error: 'Preventivo non trovato' }, 404);
  return c.json({ quote: rows[0] });
});

// DELETE /api/quotes-v2/:id
quotesV2.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const rows = await sql`SELECT status FROM quotes_v2 WHERE id = ${id}`;
  if (!rows.length) return c.json({ error: 'Non trovato' }, 404);
  if (rows[0].status === 'signed') return c.json({ error: 'Non puoi eliminare un preventivo firmato' }, 400);

  await sql`DELETE FROM signature_audit_log WHERE quote_id = ${id}`;
  await sql`DELETE FROM quotes_v2 WHERE id = ${id}`;
  return c.json({ success: true });
});

// POST /api/quotes-v2/:id/send — send via email/whatsapp (immediate)
quotesV2.post('/:id/send', async (c) => {
  const { id } = c.req.param();
  const { channels } = await c.req.json(); // ['email', 'whatsapp']

  const result = await sendQuote(id, Array.isArray(channels) ? channels : []);
  if (!result.ok) {
    const status = result.error === 'Preventivo non trovato' ? 404 : 502;
    return c.json({ error: result.error, failed: result.failed }, status);
  }
  return c.json({
    success: true,
    sent_via: result.sentVia,
    failed: Object.keys(result.failed).length ? result.failed : undefined,
    sign_url: result.signUrl,
  });
});

// POST /api/quotes-v2/:id/schedule-send — schedule the send for later.
// Body: { send_at: ISO string (future), channels: ['email'|'whatsapp'] }
quotesV2.post('/:id/schedule-send', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  const sendAt = new Date(String(body.send_at || ''));
  if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
    return c.json({ error: 'Data di invio non valida (deve essere nel futuro)' }, 400);
  }
  const channels = Array.isArray(body.channels)
    ? body.channels.filter((ch: unknown) => ch === 'email' || ch === 'whatsapp')
    : [];
  if (!channels.length) return c.json({ error: 'Seleziona almeno un canale' }, 400);

  const rows = await sql`
    UPDATE quotes_v2 SET
      scheduled_send_at = ${sendAt.toISOString()},
      scheduled_send_channels = ${channels},
      scheduled_send_attempts = 0,
      updated_at = now()
    WHERE id = ${id} AND status <> 'signed'
    RETURNING id, scheduled_send_at
  `;
  if (!rows.length) return c.json({ error: 'Preventivo non trovato o già firmato' }, 404);

  return c.json({ success: true, scheduled_send_at: rows[0].scheduled_send_at, channels });
});

// DELETE /api/quotes-v2/:id/schedule-send — cancel a scheduled send
quotesV2.delete('/:id/schedule-send', async (c) => {
  const { id } = c.req.param();
  const rows = await sql`
    UPDATE quotes_v2 SET
      scheduled_send_at = NULL,
      scheduled_send_channels = NULL,
      scheduled_send_attempts = 0,
      updated_at = now()
    WHERE id = ${id}
    RETURNING id
  `;
  if (!rows.length) return c.json({ error: 'Non trovato' }, 404);
  return c.json({ success: true });
});

// POST /api/quotes-v2/:id/materials — update materials checklist
quotesV2.post('/:id/materials', async (c) => {
  const { id } = c.req.param();
  const { materials_checklist } = await c.req.json();

  const allComplete = materials_checklist.every((m: any) => m.received);

  const rows = await sql`
    UPDATE quotes_v2 SET
      materials_checklist = ${JSON.stringify(materials_checklist)},
      materials_complete = ${allComplete},
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;

  // If all materials received and auto_create_project, create project
  if (allComplete && rows[0]?.auto_create_project && !rows[0]?.project_id && rows[0]?.customer_id) {
    const template = rows[0].project_template || {};
    const projectRows = await sql`
      INSERT INTO client_projects (customer_id, name, project_type, status, priority)
      VALUES (
        ${rows[0].customer_id},
        ${template.name || rows[0].title},
        ${template.type || 'website'},
        'in_progress',
        5
      )
      RETURNING *
    `;
    if (projectRows.length) {
      await sql`UPDATE quotes_v2 SET project_id = ${projectRows[0].id} WHERE id = ${id}`;
    }
  }

  return c.json({ quote: rows[0], materials_complete: allComplete });
});

// POST /api/quotes-v2/:id/generate-pdf — generate PDF
quotesV2.post('/:id/generate-pdf', async (c) => {
  const { id } = c.req.param();

  const rows = await sql`
    SELECT q.*, c.contact_name AS customer_name, c.company_name
    FROM quotes_v2 q
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.id = ${id}
  `;
  if (!rows.length) return c.json({ error: 'Non trovato' }, 404);

  const quote = rows[0];

  // Custom HTML quotes render the hand-crafted document as-is (signature
  // injected into its data-sign placeholders once signed); everything else
  // goes through the shared Swiss-editorial template.
  let html: string;
  if (quote.custom_html_path) {
    const name = String(quote.custom_html_path).split('/').pop() || '';
    try {
      html = (await readPrivateFile('quotes', name)).toString('utf-8');
    } catch {
      return c.json({ error: 'Documento HTML non trovato nello storage' }, 404);
    }
    html = injectSignatureIntoCustomHtml(html, quote);
  } else {
    // Get settings for PDF styling
    const settingsRows = await sql`SELECT value FROM site_settings WHERE key = 'quote.settings'`;
    const settings = settingsRows[0]?.value || {};
    // Render HTML (quote row has all required QuoteData fields from the JOIN)
    html = renderQuoteHtml(quote as Parameters<typeof renderQuoteHtml>[0], settings);
  }

  // Generate PDF
  const result = await generateQuotePdf(html, `Preventivo_${quote.title}`);

  // Update quote with PDF path + hash. NEVER overwrite the hash once signed —
  // for a signed quote pdf_hash_sha256 is the evidentiary signature hash, and
  // regenerating the PDF would otherwise destroy the link to the approved content.
  await sql`
    UPDATE quotes_v2 SET
      pdf_path = ${result.pdfPath},
      pdf_hash_sha256 = CASE WHEN status = 'signed' THEN pdf_hash_sha256 ELSE ${result.pdfHash} END,
      updated_at = now()
    WHERE id = ${id}
  `;

  return c.json({
    pdf_url: result.pdfUrl,
    pdf_hash: result.pdfHash,
  });
});

// Public endpoints are in quote-public.ts (mounted without auth)
