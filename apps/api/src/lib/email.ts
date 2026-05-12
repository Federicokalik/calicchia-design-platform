import { Resend } from 'resend';
import nodemailer, { type Transporter } from 'nodemailer';

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Hybrid email transport:
 *   - `critical` → Resend (magic link, OTP, payment confirm, contract signed).
 *     High deliverability, <500ms send, analytics. Free tier 3k/month.
 *   - `standard` (default) → Vhosting SMTP via nodemailer. Tutto il resto
 *     (preventivi, notifiche admin, contact form, scadenze, GDPR, nurture).
 *     0€ extra perché usiamo la casella mail già pagata col hosting.
 *
 * Fallback: se il transport selezionato non è configurato, si tenta l'altro
 * con log warning. Se nessuno è configurato, `success: false` ma no throw.
 */
export type EmailTransport = 'critical' | 'standard';

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  /** Plain-text fallback. Best practice deliverability (Gmail, anti-spam). */
  text?: string;
  /** Default: `'standard'` (SMTP). Use `'critical'` for auth/payments. */
  transport?: EmailTransport;
  /** Override Reply-To header. Default: EMAIL_REPLY_TO env or sender. */
  replyTo?: string;
  attachments?: EmailAttachment[];
}

interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /** Which transport actually sent the email (may differ from request on fallback). */
  via?: EmailTransport;
}

// ── Resend client (singleton) ─────────────────────────────
let resendClient: Resend | null = null;
function getResend(): Resend {
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}
function hasResend(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

// ── SMTP transporter (singleton) ──────────────────────────
let smtpTransporter: Transporter | null = null;
function getSmtp(): Transporter {
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return smtpTransporter;
}
function hasSmtp(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function fromForCritical(): string {
  return (
    process.env.EMAIL_FROM_CRITICAL ||
    process.env.EMAIL_FROM ||
    'Calicchia Design <noreply@calicchia.design>'
  );
}
function fromForStandard(): string {
  return process.env.EMAIL_FROM || 'Calicchia Design <hi@calicchia.design>';
}
function defaultReplyTo(): string | undefined {
  return process.env.EMAIL_REPLY_TO || undefined;
}

async function sendViaResend(opts: EmailOptions): Promise<SendResult> {
  const to = Array.isArray(opts.to) ? opts.to : [opts.to];
  try {
    const resend = getResend();
    const result = await resend.emails.send({
      from: fromForCritical(),
      to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: opts.replyTo ?? defaultReplyTo(),
      attachments: opts.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.isBuffer(attachment.content)
          ? attachment.content.toString('base64')
          : attachment.content,
        contentType: attachment.contentType,
      })),
    });
    if (result.error) return { success: false, error: result.error.message, via: 'critical' };
    return { success: true, messageId: result.data?.id, via: 'critical' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[email] Resend send error:', message);
    return { success: false, error: message, via: 'critical' };
  }
}

async function sendViaSmtp(opts: EmailOptions): Promise<SendResult> {
  const to = Array.isArray(opts.to) ? opts.to.join(', ') : opts.to;
  try {
    const transporter = getSmtp();
    const info = await transporter.sendMail({
      from: fromForStandard(),
      to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: opts.replyTo ?? defaultReplyTo(),
      attachments: opts.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.isBuffer(attachment.content)
          ? attachment.content
          : Buffer.from(attachment.content, 'base64'),
        contentType: attachment.contentType,
      })),
    });
    return { success: true, messageId: info.messageId, via: 'standard' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[email] SMTP send error:', message);
    return { success: false, error: message, via: 'standard' };
  }
}

export async function sendEmail(options: EmailOptions): Promise<SendResult> {
  const requested: EmailTransport = options.transport ?? 'standard';

  // Primary path
  if (requested === 'critical' && hasResend()) return sendViaResend(options);
  if (requested === 'standard' && hasSmtp()) return sendViaSmtp(options);

  // Fallback path
  if (requested === 'critical' && hasSmtp()) {
    console.warn('[email] Resend not configured — falling back to SMTP for critical email');
    return sendViaSmtp(options);
  }
  if (requested === 'standard' && hasResend()) {
    console.warn('[email] SMTP not configured — falling back to Resend for standard email');
    return sendViaResend(options);
  }

  console.warn('[email] No transport configured (RESEND_API_KEY + SMTP_* both missing) — skipping');
  return { success: false, error: 'No email transport configured' };
}

// ============================================
// Domain Expiry Email
// ============================================

interface DomainForEmail {
  name: string;
  expirationDate: string;
  daysUntilExpiry: number;
}

function getUrgencyStyle(days: number): { bg: string; text: string; label: string } {
  if (days <= 7) return { bg: '#fee2e2', text: '#991b1b', label: 'Urgente' };
  if (days <= 14) return { bg: '#fef3c7', text: '#92400e', label: 'Importante' };
  return { bg: '#fef9c3', text: '#854d0e', label: 'Avviso' };
}

function buildDomainExpiryHtml(customerName: string, domains: DomainForEmail[], renewUrl: string): string {
  const mostUrgent = Math.min(...domains.map((d) => d.daysUntilExpiry));
  const urgency = getUrgencyStyle(mostUrgent);

  const domainRows = domains.map((d) => {
    const u = getUrgencyStyle(d.daysUntilExpiry);
    const daysLabel = d.daysUntilExpiry <= 0 ? 'Scaduto' : `${d.daysUntilExpiry}g`;
    return `
      <tr>
        <td style="padding:12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151">
          <strong>${esc(d.name)}</strong>
        </td>
        <td style="padding:12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;text-align:center">
          ${d.expirationDate}
        </td>
        <td style="padding:12px;border-bottom:1px solid #e5e7eb;font-size:14px;text-align:right">
          <span style="display:inline-block;padding:4px 8px;border-radius:4px;font-size:12px;font-weight:500;background-color:${u.bg};color:${u.text}">
            ${daysLabel}
          </span>
        </td>
      </tr>`;
  }).join('');

  const introText = domains.length === 1
    ? 'Il tuo dominio sta per scadere. Rinnovalo al più presto per evitare interruzioni del servizio.'
    : `${domains.length} dei tuoi domini stanno per scadere. Rinnoveli al più presto per evitare interruzioni del servizio.`;

  const urgencyText = mostUrgent <= 0 ? 'Dominio scaduto!' : `${mostUrgent} giorni alla scadenza`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Ubuntu,sans-serif;margin:0;padding:40px 0">
  <div style="background-color:#ffffff;border-radius:8px;max-width:600px;margin:0 auto;box-shadow:0 1px 3px 0 rgba(0,0,0,0.1)">
    <!-- Header -->
    <div style="padding:32px 40px 24px;border-bottom:1px solid #e5e7eb;text-align:center">
      <img src="https://calfrancescomelis.it/logo.png" alt="CAL" width="120" height="40" style="margin:0 auto;display:block" />
    </div>

    <!-- Content -->
    <div style="padding:32px 40px">
      <h1 style="color:#374151;font-size:24px;font-weight:600;margin:0 0 16px">Domini in scadenza</h1>

      <p style="color:#374151;font-size:14px;line-height:24px;margin:0 0 16px">Ciao ${esc(customerName)},</p>
      <p style="color:#374151;font-size:14px;line-height:24px;margin:0 0 16px">${introText}</p>

      <!-- Warning Box -->
      <div style="background-color:${urgency.bg};border-radius:8px;padding:16px 24px;margin:24px 0;border-left:4px solid ${urgency.text}">
        <p style="margin:0;font-size:14px;color:${urgency.text};font-weight:600">${urgency.label}: ${urgencyText}</p>
      </div>

      <!-- Domains Table -->
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <thead>
          <tr>
            <th style="background-color:#f9fafb;border-bottom:1px solid #e5e7eb;padding:12px;text-align:left;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase">Dominio</th>
            <th style="background-color:#f9fafb;border-bottom:1px solid #e5e7eb;padding:12px;text-align:center;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase">Scadenza</th>
            <th style="background-color:#f9fafb;border-bottom:1px solid #e5e7eb;padding:12px;text-align:right;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase">Giorni</th>
          </tr>
        </thead>
        <tbody>
          ${domainRows}
        </tbody>
      </table>

      <hr style="border-color:#e5e7eb;margin:24px 0" />

      <!-- CTA -->
      <div style="text-align:center;margin:32px 0">
        <a href="${renewUrl}" style="background-color:#2563eb;border-radius:6px;color:#ffffff;display:inline-block;font-size:14px;font-weight:600;padding:12px 24px;text-decoration:none;text-align:center">Contattaci per il rinnovo</a>
      </div>

      <!-- Info Box -->
      <div style="background-color:#f9fafb;border-radius:8px;padding:20px;margin:24px 0">
        <p style="margin:0;font-size:14px;color:#374151;font-weight:600">Perché è importante rinnovare?</p>
        <ul style="padding-left:20px;margin:12px 0 0;color:#6b7280;font-size:13px;line-height:22px">
          <li>Evita che il sito web diventi inaccessibile</li>
          <li>Proteggi il tuo brand e la tua identità online</li>
          <li>Previeni che altri registrino il tuo dominio</li>
          <li>Mantieni attive le email associate al dominio</li>
        </ul>
      </div>

      <hr style="border-color:#e5e7eb;margin:24px 0" />

      <p style="color:#6b7280;font-size:12px;line-height:24px;margin:0 0 16px">
        Hai bisogno di aiuto con il rinnovo? Contattaci a
        <a href="mailto:info@calfrancescomelis.it" style="color:#2563eb">info@calfrancescomelis.it</a>
        e ci occuperemo di tutto noi.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding:24px 40px;background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 8px 8px">
      <p style="color:#6b7280;font-size:12px;text-align:center;margin:0 0 8px">CAL - Federico Calicchia</p>
      <p style="color:#6b7280;font-size:12px;text-align:center;margin:0">
        <a href="https://calicchia.design" style="color:#2563eb">calicchia.design</a>
        &nbsp;|&nbsp;
        <a href="mailto:info@calicchia.design" style="color:#2563eb">info@calicchia.design</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ============================================
// Contact Form Notification Email
// ============================================

interface ContactForEmail {
  name: string;
  email: string;
  company?: string | null;
  phone?: string | null;
  message?: string | null;
  services?: string[] | null;
  sectors?: string[] | null;
  wants_call?: boolean;
  wants_meet?: boolean;
  source_page?: string | null;
  source_service?: string | null;
  source_profession?: string | null;
}

function buildContactNotificationHtml(contact: ContactForEmail): string {
  const servicesList = contact.services?.length
    ? contact.services.map(s => `<li style="padding:4px 0;color:#374151;font-size:14px">${esc(s)}</li>`).join('')
    : '<li style="padding:4px 0;color:#9ca3af;font-size:14px">Nessuno specificato</li>';

  const sectorsList = contact.sectors?.length
    ? contact.sectors.map(s => `<li style="padding:4px 0;color:#374151;font-size:14px">${esc(s)}</li>`).join('')
    : '';

  const sectorsSection = contact.sectors?.length ? `
      <div style="margin:16px 0">
        <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase">Settori</p>
        <ul style="padding-left:20px;margin:0">${sectorsList}</ul>
      </div>` : '';

  const meetBadge = contact.wants_meet
    ? '<span style="display:inline-block;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:600;background-color:#dcfce7;color:#166534">Vuole fissare una call</span>'
    : '<span style="display:inline-block;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:600;background-color:#f3f4f6;color:#6b7280">No call richiesta</span>';

  const sourceInfo = [
    contact.source_page ? `Pagina: ${esc(contact.source_page)}` : null,
    contact.source_service ? `Servizio: ${esc(contact.source_service)}` : null,
    contact.source_profession ? `Professione: ${esc(contact.source_profession)}` : null,
  ].filter(Boolean).join(' | ');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Ubuntu,sans-serif;margin:0;padding:40px 0">
  <div style="background-color:#ffffff;border-radius:8px;max-width:600px;margin:0 auto;box-shadow:0 1px 3px 0 rgba(0,0,0,0.1)">
    <div style="padding:32px 40px 24px;border-bottom:1px solid #e5e7eb">
      <h1 style="color:#374151;font-size:20px;font-weight:600;margin:0">Nuovo contatto dal sito</h1>
      <p style="color:#9ca3af;font-size:13px;margin:8px 0 0">${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}</p>
    </div>

    <div style="padding:32px 40px">
      ${meetBadge}

      <div style="margin:24px 0;padding:20px;background-color:#f9fafb;border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:8px 0;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;width:100px;vertical-align:top">Nome</td>
            <td style="padding:8px 0;font-size:14px;color:#374151">${esc(contact.name)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;vertical-align:top">Email</td>
            <td style="padding:8px 0;font-size:14px"><a href="mailto:${esc(contact.email)}" style="color:#2563eb">${esc(contact.email)}</a></td>
          </tr>
          ${contact.company ? `<tr>
            <td style="padding:8px 0;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;vertical-align:top">Azienda</td>
            <td style="padding:8px 0;font-size:14px;color:#374151">${esc(contact.company)}</td>
          </tr>` : ''}
          ${contact.phone ? `<tr>
            <td style="padding:8px 0;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;vertical-align:top">Telefono</td>
            <td style="padding:8px 0;font-size:14px"><a href="tel:${esc(contact.phone)}" style="color:#2563eb">${esc(contact.phone)}</a></td>
          </tr>` : ''}
        </table>
      </div>

      <div style="margin:16px 0">
        <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase">Servizi richiesti</p>
        <ul style="padding-left:20px;margin:0">${servicesList}</ul>
      </div>

      ${sectorsSection}

      ${contact.message ? `
      <div style="margin:16px 0">
        <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase">Messaggio</p>
        <div style="padding:16px;background-color:#f9fafb;border-radius:8px;border-left:3px solid #2563eb">
          <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;white-space:pre-wrap">${esc(contact.message)}</p>
        </div>
      </div>` : ''}

      ${sourceInfo ? `
      <div style="margin:24px 0;padding:12px 16px;background-color:#eff6ff;border-radius:6px">
        <p style="margin:0;font-size:12px;color:#3b82f6">${sourceInfo}</p>
      </div>` : ''}
    </div>

    <div style="padding:16px 40px;background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 8px 8px">
      <p style="color:#9ca3af;font-size:11px;text-align:center;margin:0">Calicchia Design - Form contatto</p>
    </div>
  </div>
</body>
</html>`;
}

export async function sendContactNotification(contact: ContactForEmail): Promise<SendResult> {
  const { renderContactFormEmail } = await import('../templates/contact-form');
  const adminEmail = process.env.ADMIN_EMAIL || 'federico@calicchia.design';
  const sourceParts = [contact.source_page, contact.source_service, contact.source_profession]
    .filter(Boolean)
    .join(' · ');
  const { subject, html, text } = await renderContactFormEmail({
    name: contact.name,
    email: contact.email,
    phone: contact.phone ?? null,
    company: contact.company ?? null,
    message: contact.message ?? '',
    wantsMeet: !!contact.wants_meet,
    source: sourceParts || null,
  });
  return sendEmail({ to: adminEmail, subject, html, text });
}

// ============================================
// Newsletter Email with Unsubscribe Link (GDPR)
// ============================================

const SITE_URL = process.env.SITE_URL || 'https://calicchia.design';
const API_URL = process.env.API_URL || 'http://localhost:3001';

export async function sendNewsletterEmail(data: {
  to: string;
  subject: string;
  htmlContent: string;
  unsubscribeToken: string;
}): Promise<SendResult> {
  const unsubscribeUrl = `${API_URL}/api/newsletter/unsubscribe?token=${data.unsubscribeToken}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Ubuntu,sans-serif;margin:0;padding:40px 0">
  <div style="background-color:#ffffff;border-radius:8px;max-width:600px;margin:0 auto;box-shadow:0 1px 3px 0 rgba(0,0,0,0.1)">
    <div style="padding:32px 40px">
      ${data.htmlContent}
    </div>
    <div style="padding:24px 40px;background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 8px 8px">
      <p style="color:#9ca3af;font-size:11px;text-align:center;margin:0 0 8px">
        Calicchia Design — <a href="${SITE_URL}" style="color:#6b7280">${SITE_URL}</a>
      </p>
      <p style="color:#9ca3af;font-size:11px;text-align:center;margin:0">
        Non vuoi più ricevere queste email? <a href="${unsubscribeUrl}" style="color:#2563eb;text-decoration:underline">Disiscriviti</a>
        &nbsp;|&nbsp;
        <a href="${SITE_URL}/privacy-policy" style="color:#6b7280">Privacy Policy</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  return sendEmail({
    to: data.to,
    subject: data.subject,
    html,
  });
}

export async function sendDomainExpiringEmail(data: {
  to: string;
  customerName: string;
  domains: DomainForEmail[];
  renewUrl: string;
}): Promise<SendResult> {
  const { renderDomainExpiringEmail } = await import('../templates/domain-expiring');
  const { subject, html, text } = await renderDomainExpiringEmail({
    contactName: data.customerName,
    domains: data.domains,
    renewUrl: data.renewUrl,
  });
  return sendEmail({ to: data.to, subject, html, text });
}
