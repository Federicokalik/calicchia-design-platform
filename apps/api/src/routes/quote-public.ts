import { Hono } from 'hono';
import crypto from 'crypto';
import { sql } from '../db';
import { sendEmail } from '../lib/email';
import { renderOtpCodeEmail } from '../templates/otp-code';

export const quotePublic = new Hono();

// GET /api/quote-sign/:token — view quote
quotePublic.get('/:token', async (c) => {
  const { token } = c.req.param();
  const rows = await sql`
    SELECT q.id, q.title, q.description, q.items, q.subtotal, q.tax_rate, q.tax_amount, q.total,
           q.currency, q.valid_until, q.notes, q.status, q.signed_at, q.signer_name,
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

  return c.json({ quote });
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

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await sql`UPDATE quotes_v2 SET otp_code = ${otp}, otp_expires_at = ${expiresAt.toISOString()} WHERE id = ${rows[0].id}`;

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
  const { otp, signature_image, signer_name } = await c.req.json();

  if (!otp || !signature_image) return c.json({ error: 'OTP e firma richiesti' }, 400);

  const rows = await sql`
    SELECT q.*, c.email AS customer_email
    FROM quotes_v2 q LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.signature_token = ${token}
  `;
  if (!rows.length) return c.json({ error: 'Non trovato' }, 404);

  const quote = rows[0];
  if (quote.status === 'signed') return c.json({ error: 'Già firmato' }, 400);
  if (quote.otp_code !== otp) return c.json({ error: 'Codice OTP non valido' }, 400);
  if (new Date(quote.otp_expires_at) < new Date()) return c.json({ error: 'Codice OTP scaduto' }, 400);

  const ip = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'unknown';
  const ua = c.req.header('user-agent') || 'unknown';
  const pdfHash = crypto.createHash('sha256').update(`${quote.id}-${Date.now()}`).digest('hex');

  await sql`
    UPDATE quotes_v2 SET
      status = 'signed', signed_at = now(),
      signer_name = ${signer_name || null}, signer_email = ${quote.customer_email},
      signature_image = ${signature_image}, signature_ip = ${ip},
      signature_user_agent = ${ua}, pdf_hash_sha256 = ${pdfHash},
      otp_code = NULL, otp_expires_at = NULL, updated_at = now()
    WHERE id = ${quote.id}
  `;

  await sql`INSERT INTO signature_audit_log (quote_id, action, ip_address, user_agent, metadata) VALUES (${quote.id}, 'signature_submitted', ${ip}, ${ua}, ${JSON.stringify({ signer_name, pdf_hash: pdfHash })})`;

  // Admin notification of signature (standard transport; the OTP/customer
  // confirmation goes through critical above)
  sendEmail({
    to: process.env.ADMIN_EMAIL || 'admin@calicchia.design',
    subject: `Preventivo firmato: ${quote.title}`,
    html: `<p><strong>${quote.title}</strong> firmato da ${signer_name || quote.customer_email}.</p><p>IP: ${ip} — ${new Date().toLocaleString('it-IT')}</p>`,
  }).catch(console.error);

  // Notify Telegram
  import('../lib/telegram').then(({ notifyTelegram }) => {
    notifyTelegram('✅ Preventivo firmato!', `${quote.title}\nFirmato da: ${signer_name || quote.customer_email}\n€${parseFloat(quote.total || '0').toLocaleString('it-IT')}`);
  }).catch((err) => console.error('[quote-sign] Telegram notify failed:', err));
  // Fire workflow event
  import('../lib/workflow/triggers').then(({ fireEvent }) => {
    fireEvent('preventivo_firmato', { quote_id: quote.id, title: quote.title, total: quote.total, signer_name, customer_email: quote.customer_email });
  }).catch((err) => console.error('[quote-sign] Workflow trigger failed:', err));

  return c.json({ success: true, signed_at: new Date().toISOString() });
});
