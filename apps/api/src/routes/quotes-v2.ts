import { Hono } from 'hono';
import crypto from 'crypto';
import { sql } from '../db';
import { sendEmail } from '../lib/email';
import { sendWhatsAppText, sendWhatsAppMedia, isWhatsAppConfigured } from '../lib/whatsapp';
import { renderQuoteHtml } from '../lib/quote-renderer';
import { generateQuotePdf } from '../lib/quote-pdf';

export const quotesV2 = new Hono();

const QUOTE_PUBLIC_URL = process.env.QUOTE_PUBLIC_URL || 'http://localhost:5173/preventivo';

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

// POST /api/quotes-v2 — create quote
quotesV2.post('/', async (c) => {
  const body = await c.req.json();
  const { customer_id, lead_id, title, description, items, tax_rate, valid_until, notes, internal_notes, materials_checklist, project_template } = body;

  if (!title) return c.json({ error: 'Titolo richiesto' }, 400);

  // Calculate totals
  const parsedItems = items || [];
  const subtotal = parsedItems.reduce((sum: number, item: any) => sum + (parseFloat(item.total) || 0), 0);
  const rate = tax_rate ?? 22;
  const taxAmount = subtotal * (rate / 100);
  const total = subtotal + taxAmount;

  const rows = await sql`
    INSERT INTO quotes_v2 (
      customer_id, lead_id, title, description, items,
      subtotal, tax_rate, tax_amount, total,
      valid_until, notes, internal_notes,
      materials_checklist, project_template
    )
    VALUES (
      ${customer_id || null}, ${lead_id || null}, ${title}, ${description || null}, ${JSON.stringify(parsedItems)},
      ${subtotal}, ${rate}, ${taxAmount}, ${total},
      ${valid_until || null}, ${notes || null}, ${internal_notes || null},
      ${JSON.stringify(materials_checklist || [])}, ${JSON.stringify(project_template || null)}
    )
    RETURNING *
  `;

  return c.json({ quote: rows[0] }, 201);
});

// PUT /api/quotes-v2/:id — update quote
quotesV2.put('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  // Recalculate totals if items changed
  let subtotal = body.subtotal;
  let taxAmount = body.tax_amount;
  let total = body.total;

  if (body.items) {
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
      notes = ${body.notes !== undefined ? body.notes : null},
      internal_notes = ${body.internal_notes !== undefined ? body.internal_notes : null},
      materials_checklist = COALESCE(${body.materials_checklist ? JSON.stringify(body.materials_checklist) : null}, materials_checklist),
      project_template = ${body.project_template !== undefined ? JSON.stringify(body.project_template) : null},
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

// POST /api/quotes-v2/:id/send — send via email/whatsapp
quotesV2.post('/:id/send', async (c) => {
  const { id } = c.req.param();
  const { channels } = await c.req.json(); // ['email', 'whatsapp']

  const rows = await sql`
    SELECT q.*, c.contact_name, c.email AS customer_email, c.phone AS customer_phone, c.company_name
    FROM quotes_v2 q
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.id = ${id}
  `;
  if (!rows.length) return c.json({ error: 'Non trovato' }, 404);

  const quote = rows[0];
  const signUrl = `${QUOTE_PUBLIC_URL}/${quote.signature_token}`;
  const sentVia: string[] = [];

  // Send email
  if (channels?.includes('email') && quote.customer_email) {
    try {
      await sendEmail({
        to: quote.customer_email,
        subject: `Preventivo: ${quote.title}`,
        html: `
          <p>Ciao ${quote.contact_name || ''},</p>
          <p>Ti invio il preventivo <strong>${quote.title}</strong> per un totale di <strong>€${parseFloat(quote.total).toLocaleString('it-IT')}</strong>.</p>
          <p>Puoi visionarlo e firmarlo digitalmente al seguente link:</p>
          <p><a href="${signUrl}" style="display:inline-block;padding:12px 24px;background:#f97316;color:white;border-radius:8px;text-decoration:none;font-weight:bold;">Visualizza e Firma</a></p>
          <p>Il preventivo è valido fino al ${quote.valid_until ? new Date(quote.valid_until).toLocaleDateString('it-IT') : 'revoca'}.</p>
          <br>
          <p>Federico Calicchia<br>Web Designer</p>
        `,
      });
      sentVia.push('email');
    } catch (err) {
      console.error('Error sending quote email:', err);
    }
  }

  // Send WhatsApp
  if (channels?.includes('whatsapp') && quote.customer_phone && isWhatsAppConfigured()) {
    try {
      const message = `Ciao ${quote.contact_name || ''}! 👋\n\nTi invio il preventivo *${quote.title}* per un totale di *€${parseFloat(quote.total).toLocaleString('it-IT')}*.\n\nPuoi visionarlo e firmarlo qui:\n${signUrl}\n\nPer qualsiasi domanda sono a disposizione!`;
      await sendWhatsAppText(quote.customer_phone, message);
      sentVia.push('whatsapp');
    } catch (err) {
      console.error('Error sending quote WhatsApp:', err);
    }
  }

  // Update quote status
  await sql`
    UPDATE quotes_v2 SET
      status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
      sent_via = ${sentVia},
      sent_at = now(),
      updated_at = now()
    WHERE id = ${id}
  `;

  return c.json({ success: true, sent_via: sentVia, sign_url: signUrl });
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

  // Get settings for PDF styling
  const settingsRows = await sql`SELECT value FROM site_settings WHERE key = 'quote.settings'`;
  const settings = settingsRows[0]?.value || {};

  // Render HTML (quote row has all required QuoteData fields from the JOIN)
  const html = renderQuoteHtml(quote as Parameters<typeof renderQuoteHtml>[0], settings);

  // Generate PDF
  const result = await generateQuotePdf(html, `Preventivo_${quote.title}`);

  // Update quote with PDF path + hash
  await sql`
    UPDATE quotes_v2 SET
      pdf_path = ${result.pdfPath},
      pdf_hash_sha256 = ${result.pdfHash},
      updated_at = now()
    WHERE id = ${id}
  `;

  return c.json({
    pdf_url: result.pdfUrl,
    pdf_hash: result.pdfHash,
  });
});

// Public endpoints are in quote-public.ts (mounted without auth)
