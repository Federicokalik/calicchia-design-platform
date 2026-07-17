import { Hono } from 'hono';
import crypto from 'crypto';
import { resolveContractArticles, type ContractArticle } from '@calicchia/shared';
import { sql } from '../db';
import { sendEmail } from '../lib/email';
import { renderOtpCodeEmail } from '../templates/otp-code';
import { logger } from '../lib/logger';
import {
  OTP_MAX_ATTEMPTS,
  extractIpUa,
  generateOtpCode,
  hashOtp,
  otpExpiresAt,
  verifyOtpHash,
} from '../lib/signing';
import { decodeEntities, escapeHtml, quoteDisplayTitle } from '../lib/quotes/format';
import { ensureProjectForQuote } from '../lib/quotes/project';
import { readPrivateFile } from '../lib/private-files';

const log = logger.child({ scope: 'quote-sign' });

export const quotePublic = new Hono();

/**
 * Vessatorie clauses (artt. 1341-1342 c.c.) applicable to a quote: only when
 * the quote carries a contract section, resolved from the global settings
 * boilerplate + per-quote article overrides — same logic as the PDF template.
 */
async function getVessatorieForQuote(projectTemplate: unknown): Promise<ContractArticle[]> {
  let pt: Record<string, unknown> | null = null;
  try {
    const parsed = typeof projectTemplate === 'string' ? JSON.parse(projectTemplate) : projectTemplate;
    if (parsed && typeof parsed === 'object') pt = parsed as Record<string, unknown>;
  } catch { /* malformed template → no contract → no vessatorie gate */ }
  if (!pt) return [];

  // Custom HTML quotes declare their clauses explicitly at import time.
  if (Array.isArray(pt.vessatorie_custom) && pt.vessatorie_custom.length) {
    return (pt.vessatorie_custom as Array<Record<string, unknown>>).map((v, i) => ({
      numero: Number(v.numero) || i + 1,
      titolo: String(v.titolo ?? ''),
      testo: String(v.testo ?? ''),
      vessatoria: true,
    }));
  }

  const sections = Array.isArray(pt.sections) ? (pt.sections as Array<{ type?: string; data?: unknown }>) : [];
  const contratto = sections.find((s) => s?.type === 'contratto');
  if (!contratto) return [];

  const settingsRows = await sql`SELECT value FROM site_settings WHERE key = 'quote.settings'`;
  const settings = settingsRows[0]?.value || {};
  return resolveContractArticles(settings, contratto.data).filter((a) => a.vessatoria);
}

/**
 * Payment options for the sign page, normalized from the two template shapes:
 *   - custom HTML quotes: project_template.pagamento_custom = [{nome, importo}]
 *   - template quotes: sections[type=pagamento].data.modalita =
 *       [{nome, importo?, sconto_percentuale?, rate: [{percentuale, momento}]}]
 * The customer must see the payment terms (e.g. "anticipato €549") BEFORE
 * signing, not only inside the PDF.
 */
function getPagamentoForQuote(projectTemplate: unknown): Array<Record<string, unknown>> {
  let pt: Record<string, unknown> | null = null;
  try {
    const parsed = typeof projectTemplate === 'string' ? JSON.parse(projectTemplate) : projectTemplate;
    if (parsed && typeof parsed === 'object') pt = parsed as Record<string, unknown>;
  } catch { /* malformed → no payment box */ }
  if (!pt) return [];

  const normalize = (list: unknown[]): Array<Record<string, unknown>> =>
    list
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map((p) => ({
        nome: decodeEntities(String(p.nome ?? '')),
        importo: Number(p.importo) > 0 ? Number(p.importo) : null,
        sconto_percentuale: Number(p.sconto_percentuale) > 0 ? Number(p.sconto_percentuale) : null,
        rate: Array.isArray(p.rate)
          ? (p.rate as Array<Record<string, unknown>>).map((r) => ({
              percentuale: Number(r.percentuale) || 0,
              momento: decodeEntities(String(r.momento ?? '')),
            }))
          : [],
      }))
      .filter((p) => p.nome);

  if (Array.isArray(pt.pagamento_custom) && pt.pagamento_custom.length) {
    return normalize(pt.pagamento_custom as unknown[]);
  }
  const sections = Array.isArray(pt.sections) ? (pt.sections as Array<{ type?: string; data?: unknown }>) : [];
  const pagamento = sections.find((s) => s?.type === 'pagamento');
  const modalita = (pagamento?.data as { modalita?: unknown[] } | undefined)?.modalita;
  return Array.isArray(modalita) ? normalize(modalita) : [];
}

// GET /api/quote-sign/:token — view quote
quotePublic.get('/:token', async (c) => {
  const { token } = c.req.param();
  const rows = await sql`
    SELECT q.id, q.title, q.description, q.items, q.subtotal, q.tax_rate, q.tax_amount, q.total,
           q.currency, q.valid_until, q.notes, q.status, q.signed_at, q.signer_name,
           q.project_template, q.vessatorie_approved_at, q.custom_html_path,
           c.contact_name AS customer_name, c.company_name
    FROM quotes_v2 q
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.signature_token = ${token}
  `;
  if (!rows.length) return c.json({ error: 'Preventivo non trovato' }, 404);

  const quote = rows[0];
  if (quote.status === 'sent') {
    await sql`UPDATE quotes_v2 SET status = 'viewed', viewed_at = now() WHERE id = ${quote.id} AND status = 'sent'`;
    await sql`INSERT INTO signature_audit_log (quote_id, action, ip_address, user_agent) VALUES (${quote.id}, 'viewed', ${c.req.header('x-forwarded-for') || null}, ${c.req.header('user-agent') || null})`;
  }

  // Clauses requiring specific approval (artt. 1341-1342 c.c.) — the client
  // must tick a dedicated consent before the signature is accepted.
  const vessatorie = await getVessatorieForQuote(quote.project_template);
  const pagamento = getPagamentoForQuote(quote.project_template);
  const { project_template: _pt, custom_html_path, ...publicQuote } = quote;

  // items can be double-encoded depending on the write path (jsonb holding a
  // JSON *string* — e.g. the import-html route): normalize to a real array or
  // the sign page crashes on items.map. Entities in title/descriptions arrive
  // HTML-escaped from imports; React re-escapes on render, so decoding is safe.
  let rawItems: unknown = publicQuote.items;
  if (typeof rawItems === 'string') {
    try { rawItems = JSON.parse(rawItems); } catch { rawItems = []; }
  }
  const items = (Array.isArray(rawItems) ? rawItems : []).map((it) =>
    it && typeof it === 'object' && typeof (it as Record<string, unknown>).description === 'string'
      ? { ...(it as Record<string, unknown>), description: decodeEntities((it as Record<string, unknown>).description as string) }
      : it,
  );

  return c.json({
    quote: {
      ...publicQuote,
      title: decodeEntities(String(publicQuote.title || '')),
      items,
      // Boolean only — the storage path stays server-side.
      has_document: !!custom_html_path,
    },
    pagamento,
    vessatorie: vessatorie.map((a) => ({ numero: a.numero, titolo: a.titolo, testo: a.testo })),
  });
});

// GET /api/quote-sign/:token/document — full custom-HTML document, so the
// customer can READ what they sign (the stub items table is not the contract).
// Same trust level as the quote itself: possessing the signature token grants
// view access. The HTML was sanitized at import (cleanCustomQuoteHtml strips
// scripts/active content). Standard template quotes have no stored document.
quotePublic.get('/:token/document', async (c) => {
  const { token } = c.req.param();
  const rows = await sql`
    SELECT id, custom_html_path FROM quotes_v2 WHERE signature_token = ${token}
  `;
  if (!rows.length || !rows[0].custom_html_path) return c.json({ error: 'Documento non disponibile' }, 404);

  const name = String(rows[0].custom_html_path).split('/').pop() || '';
  let html: string;
  try {
    html = (await readPrivateFile('quotes', name)).toString('utf-8');
  } catch {
    return c.json({ error: 'Documento non trovato nello storage' }, 404);
  }

  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Cache-Control', 'private, no-store');
  // The sign page embeds this document in an iframe. The global security
  // headers (X-Frame-Options DENY + frame-ancestors 'none', app.ts) must be
  // relaxed HERE ONLY — same pattern as the trust-index embed in public.ts.
  // Via the admin nginx /api proxy the iframe is same-origin ('self'); the
  // direct api origin is allowed for the admin host too. The document was
  // sanitized at import (scripts/active content stripped), CSP still blocks
  // any script as defense in depth.
  const adminOrigin = (process.env.ADMIN_URL || 'http://localhost:5173').replace(/\/$/, '');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline' https:; img-src data: https:; font-src data: https:; frame-ancestors 'self' ${adminOrigin}; base-uri 'none'`,
  );
  return c.html(html);
});

// POST /api/quote-sign/:token/otp — request OTP
quotePublic.post('/:token/otp', async (c) => {
  const { token } = c.req.param();
  const rows = await sql`
    SELECT q.id, q.status, c.email AS customer_email, c.contact_name
    FROM quotes_v2 q LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.signature_token = ${token}
  `;
  if (!rows.length) return c.json({ error: 'Non trovato' }, 404);
  if (rows[0].status === 'signed') return c.json({ error: 'Già firmato' }, 400);
  if (!rows[0].customer_email) return c.json({ error: 'Email cliente non configurata' }, 400);

  const otp = generateOtpCode();
  const expiresAt = otpExpiresAt(10);

  // Store only the keyed hash; reset failure counter on new code.
  // otp_code (legacy plaintext column) is nulled so any in-flight verifier
  // routed to the old comparison path can't accept a stale code.
  await sql`
    UPDATE quotes_v2
    SET otp_code = NULL,
        otp_hash = ${hashOtp(otp)},
        otp_expires_at = ${expiresAt.toISOString()},
        otp_attempts = 0
    WHERE id = ${rows[0].id}
  `;

  const otpEmail = await renderOtpCodeEmail({ code: otp, expiresMinutes: 10 });
  await sendEmail({
    to: rows[0].customer_email,
    subject: 'Codice di verifica per firma preventivo',
    html: otpEmail.html,
    text: otpEmail.text,
    transport: 'critical',
  });

  await sql`INSERT INTO signature_audit_log (quote_id, action, ip_address, user_agent, metadata) VALUES (${rows[0].id}, 'otp_sent', ${c.req.header('x-forwarded-for') || null}, ${c.req.header('user-agent') || null}, ${JSON.stringify({ email: rows[0].customer_email })})`;

  return c.json({ success: true, email_hint: rows[0].customer_email.replace(/(.{2})(.*)(@.*)/, '$1***$3') });
});

// POST /api/quote-sign/:token/sign — verify OTP + submit signature
quotePublic.post('/:token/sign', async (c) => {
  const { token } = c.req.param();
  const { otp, signature_image, signer_name, vessatorie_approved } = await c.req.json();

  if (!otp || !signature_image) return c.json({ error: 'OTP e firma richiesti' }, 400);

  const rows = await sql`
    SELECT q.*, c.email AS customer_email
    FROM quotes_v2 q LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.signature_token = ${token}
  `;
  if (!rows.length) return c.json({ error: 'Non trovato' }, 404);

  const quote = rows[0];
  if (quote.status === 'signed') return c.json({ error: 'Già firmato' }, 400);

  // Artt. 1341-1342 c.c.: when the quote carries vessatorie clauses, the
  // general signature is not enough — a distinct explicit approval is required.
  const vessatorie = await getVessatorieForQuote(quote.project_template);
  if (vessatorie.length && vessatorie_approved !== true) {
    return c.json({ error: 'È richiesta l\'approvazione specifica delle clausole vessatorie (artt. 1341-1342 c.c.)' }, 400);
  }

  const { ip: clientIp, ua: clientUa } = extractIpUa({ header: (name) => c.req.header(name) });

  if (!verifyOtpHash(quote.otp_hash, quote.otp_expires_at, otp)) {
    const attempts = (quote.otp_attempts ?? 0) + 1;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      // Burn the code so the remaining TTL can't be used; client must request a new one.
      await sql`
        UPDATE quotes_v2
        SET otp_hash = NULL, otp_code = NULL, otp_expires_at = NULL, otp_attempts = ${attempts}
        WHERE id = ${quote.id}
      `;
      await sql`INSERT INTO signature_audit_log (quote_id, action, ip_address, user_agent, metadata) VALUES (${quote.id}, 'otp_locked', ${clientIp}, ${clientUa}, ${JSON.stringify({ attempts })})`;
      return c.json({ error: 'Troppi tentativi. Richiedi un nuovo codice OTP.' }, 429);
    }
    await sql`UPDATE quotes_v2 SET otp_attempts = ${attempts} WHERE id = ${quote.id}`;
    await sql`INSERT INTO signature_audit_log (quote_id, action, ip_address, user_agent, metadata) VALUES (${quote.id}, 'otp_failed', ${clientIp}, ${clientUa}, ${JSON.stringify({ attempts })})`;
    return c.json({ error: 'Codice OTP non valido o scaduto' }, 400);
  }

  const ip = clientIp || 'unknown';
  const ua = clientUa || 'unknown';
  const pdfHash = crypto.createHash('sha256').update(`${quote.id}-${Date.now()}`).digest('hex');

  // Freeze the approved clauses as presented at signature time — later edits
  // to quote.settings must not change what was approved (evidentiary value).
  const vessatorieSnapshot = vessatorie.length
    ? JSON.stringify(vessatorie.map((a) => ({ numero: a.numero, titolo: a.titolo })))
    : null;

  await sql`
    UPDATE quotes_v2 SET
      status = 'signed', signed_at = now(),
      signer_name = ${signer_name || null}, signer_email = ${quote.customer_email},
      signature_image = ${signature_image}, signature_ip = ${ip},
      signature_user_agent = ${ua}, pdf_hash_sha256 = ${pdfHash},
      vessatorie_approved_at = ${vessatorie.length ? sql`now()` : null},
      vessatorie_snapshot = ${vessatorieSnapshot},
      otp_code = NULL, otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0,
      updated_at = now()
    WHERE id = ${quote.id}
  `;

  if (vessatorie.length) {
    await sql`INSERT INTO signature_audit_log (quote_id, action, ip_address, user_agent, metadata) VALUES (${quote.id}, 'vessatorie_approved', ${ip}, ${ua}, ${vessatorieSnapshot})`;
  }
  await sql`INSERT INTO signature_audit_log (quote_id, action, ip_address, user_agent, metadata) VALUES (${quote.id}, 'signature_submitted', ${ip}, ${ua}, ${JSON.stringify({ signer_name, pdf_hash: pdfHash })})`;

  // Signed → the quote becomes a "lavoro": auto-create the linked project
  // (budget = quote total) so it shows up in admin outside the leads pipeline.
  // Never blocks the signature: failures are logged inside and return null.
  const project = await ensureProjectForQuote(quote);

  const displayTitle = quoteDisplayTitle(quote.title);
  const totalFmt = parseFloat(quote.total || '0').toLocaleString('it-IT');

  // Admin notification of signature (standard transport; the OTP/customer
  // confirmation goes through critical above)
  sendEmail({
    to: process.env.ADMIN_EMAIL || 'admin@calicchia.design',
    subject: `Preventivo firmato: ${displayTitle}`,
    html: `<p><strong>${escapeHtml(displayTitle)}</strong> (€${totalFmt}) firmato da ${escapeHtml(signer_name || quote.customer_email || '')}.</p>${project ? `<p>Progetto creato automaticamente: <strong>${escapeHtml(project.name)}</strong></p>` : ''}<p>IP: ${ip} — ${new Date().toLocaleString('it-IT')}</p>`,
  }).catch((err) => log.error({ err }, 'admin signature notification failed'));

  // Notify Telegram
  import('../lib/telegram').then(({ notifyTelegram }) => {
    notifyTelegram('✅ Preventivo firmato!', `${displayTitle}\nFirmato da: ${signer_name || quote.customer_email}\n€${totalFmt}${project ? `\n📁 Progetto creato: ${project.name}` : ''}`);
  }).catch((err) => log.error({ err }, 'Telegram notify failed'));
  // Fire workflow event
  import('../lib/workflow/triggers').then(({ fireEvent }) => {
    fireEvent('preventivo_firmato', { quote_id: quote.id, title: quote.title, total: quote.total, signer_name, customer_email: quote.customer_email });
  }).catch((err) => log.error({ err }, 'Workflow trigger failed'));

  return c.json({ success: true, signed_at: new Date().toISOString() });
});
