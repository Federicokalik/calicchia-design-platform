/**
 * Email transazionali per booking — confirmation, admin notification, reminders, cancel, reschedule.
 *
 * Tutte le email includono `.ics` allegato (REQUEST per nuovi/conferma/reschedule, CANCEL per cancellazione).
 * Idempotenza tracciata via `calendar_booking_reminders` (UNIQUE(booking_id, reminder_type, sent_to)).
 */

import { Resend } from 'resend';
import { sql } from '../../db';
import { buildIcs } from './ics';
import { signBookingToken, isTokenSecretConfigured } from './token';
import type { Booking, EventType } from './types';

let resendClient: Resend | null = null;
function getResend(): Resend {
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const FROM = process.env.EMAIL_FROM || 'CAL <noreply@calfrancescomelis.it>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'info@calicchia.design';
const ORGANIZER_NAME = process.env.ORGANIZER_NAME || 'Federico Calicchia';
const SITE_URL = process.env.PUBLIC_SITE_URL || 'http://localhost:4321';

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function manageUrl(uid: string): string | null {
  if (!isTokenSecretConfigured()) return null;
  const token = signBookingToken(uid);
  return `${SITE_URL}/prenotazione/${uid}?token=${encodeURIComponent(token)}`;
}

function formatDateLong(iso: string, tz: string, locale = 'it-IT'): string {
  return new Date(iso).toLocaleString(locale, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: tz,
    timeZoneName: 'short',
  });
}

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit', timeZone: tz,
  });
}

function locationLabel(eventType: EventType, booking: Booking): string {
  switch (eventType.location_type) {
    case 'google_meet':
      return booking.location_value
        ? `Google Meet — <a href="${esc(booking.location_value)}" style="color:#7c3aed">${esc(booking.location_value)}</a>`
        : 'Google Meet (link nel calendario)';
    case 'custom_url':
      return booking.location_value
        ? `<a href="${esc(booking.location_value)}" style="color:#7c3aed">${esc(booking.location_value)}</a>`
        : 'Link videocall';
    case 'in_person':
      return booking.location_value ? esc(booking.location_value) : 'In presenza (luogo da concordare)';
    case 'phone':
      return booking.location_value ? `Telefono: ${esc(booking.location_value)}` : 'Telefonata';
  }
}

interface EmailFrame {
  title: string;
  preheader?: string;
  body: string;
}

function frame({ title, preheader, body }: EmailFrame): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:40px 0">
${preheader ? `<div style="display:none;font-size:1px;color:#f9fafb;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${esc(preheader)}</div>` : ''}
<div style="background:#fff;border-radius:8px;max-width:600px;margin:0 auto;box-shadow:0 1px 3px rgba(0,0,0,.1)">
  <div style="padding:32px 40px 24px;border-bottom:1px solid #e5e7eb;text-align:center">
    <p style="margin:0;font-size:14px;color:#7c3aed;font-weight:600;letter-spacing:.05em">CALICCHIA DESIGN</p>
  </div>
  <div style="padding:32px 40px">${body}</div>
  <div style="padding:24px 40px;background:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 8px 8px;text-align:center">
    <p style="color:#6b7280;font-size:12px;margin:0">Federico Calicchia · <a href="${esc(SITE_URL)}" style="color:#7c3aed">calicchia.design</a></p>
  </div>
</div>
</body>
</html>`;
}

function buildBookingDetailsBlock(booking: Booking, eventType: EventType, attendeeTz: string): string {
  return `
  <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:24px 0">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:8px 0;font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:600;width:120px">Cosa</td>
        <td style="padding:8px 0;font-size:14px;color:#374151">${esc(eventType.title)} · ${eventType.duration_minutes} minuti</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:600">Quando</td>
        <td style="padding:8px 0;font-size:14px;color:#374151">${esc(formatDateLong(booking.start_time, attendeeTz))}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:600">Dove</td>
        <td style="padding:8px 0;font-size:14px;color:#374151">${locationLabel(eventType, booking)}</td>
      </tr>
      ${booking.attendee_message ? `
      <tr>
        <td style="padding:8px 0;font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:600;vertical-align:top">Note</td>
        <td style="padding:8px 0;font-size:14px;color:#374151;white-space:pre-wrap">${esc(booking.attendee_message)}</td>
      </tr>` : ''}
    </table>
  </div>`;
}

function ctaButton(href: string, label: string, color = '#7c3aed'): string {
  return `<div style="text-align:center;margin:24px 0">
    <a href="${esc(href)}" style="background:${color};border-radius:6px;color:#fff;display:inline-block;font-size:14px;font-weight:600;padding:12px 24px;text-decoration:none">${esc(label)}</a>
  </div>`;
}

interface SendOpts {
  booking: Booking;
  eventType: EventType;
}

interface SendResult { success: boolean; messageId?: string; error?: string; }

async function sendWithIcs(opts: {
  to: string;
  subject: string;
  html: string;
  ics: string;
  icsFilename?: string;
}): Promise<SendResult> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[booking/email] RESEND_API_KEY non configurato — skip');
    return { success: false, error: 'RESEND_API_KEY missing' };
  }
  try {
    const res = await getResend().emails.send({
      from: FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      attachments: [{
        filename: opts.icsFilename || 'invito.ics',
        content: Buffer.from(opts.ics, 'utf8').toString('base64'),
      }],
    });
    if (res.error) return { success: false, error: res.error.message };
    return { success: true, messageId: res.data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[booking/email] Send error:', message);
    return { success: false, error: message };
  }
}

/**
 * Pre-alloca audit row PRIMA del send (anti race-condition).
 * Ritorna true se questa esecuzione ha vinto la race ed è autorizzata a inviare.
 * Ritorna false se un altro worker ha già preso lo slot di invio (audit row preesistente).
 */
async function claimReminder(bookingId: string, type: string, to: string): Promise<boolean> {
  try {
    const rows = await sql`
      INSERT INTO calendar_booking_reminders (booking_id, reminder_type, sent_to)
      VALUES (${bookingId}::uuid, ${type}, ${to})
      ON CONFLICT (booking_id, reminder_type, sent_to) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  } catch (err) {
    console.error('[booking/email] Errore claim reminder:', err);
    // Failsafe: se l'audit fallisce, NON inviamo (per evitare duplicati silenziosi).
    return false;
  }
}

/**
 * Marca errore Resend sull'audit row già allocata da claimReminder.
 * Non rimuove la row — l'admin può eliminarla manualmente per re-send (vedi /resend-confirmation).
 */
async function markReminderError(bookingId: string, type: string, to: string, error: string) {
  try {
    await sql`
      UPDATE calendar_booking_reminders
      SET error_message = ${error.slice(0, 500)}
      WHERE booking_id = ${bookingId}::uuid
        AND reminder_type = ${type}
        AND sent_to = ${to}
    `;
  } catch (err) {
    console.error('[booking/email] Errore mark reminder error:', err);
  }
}

// ============================================
// 1. Conferma al partecipante
// ============================================

export async function sendBookingConfirmation({ booking, eventType }: SendOpts): Promise<SendResult> {
  const tz = booking.attendee_timezone || 'Europe/Rome';
  const manage = manageUrl(booking.uid);

  // Pre-claim audit row PRIMA del send (idempotenza anti-doppio-invio)
  if (!await claimReminder(booking.id, 'confirmation', booking.attendee_email)) {
    return { success: false, error: 'already_processed' };
  }

  const ics = buildIcs({
    booking, eventType,
    organizerName: ORGANIZER_NAME,
    organizerEmail: ADMIN_EMAIL,
    manageUrl: manage || undefined,
    meetingUrl: eventType.location_type === 'google_meet' || eventType.location_type === 'custom_url'
      ? booking.location_value || null : null,
    method: 'REQUEST',
  });

  const html = frame({
    title: `Prenotazione confermata: ${eventType.title}`,
    preheader: `${formatDateLong(booking.start_time, tz)}`,
    body: `
      <h1 style="color:#111;font-size:22px;font-weight:600;margin:0 0 16px">Prenotazione confermata ✓</h1>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        Ciao ${esc(booking.attendee_name)}, ho ricevuto la tua prenotazione. Trovi qui sotto i dettagli e in allegato l'invito (.ics) da aggiungere al tuo calendario.
      </p>
      ${buildBookingDetailsBlock(booking, eventType, tz)}
      ${manage ? ctaButton(manage, 'Gestisci la prenotazione') : ''}
      <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:24px 0 0">
        Se hai imprevisti puoi cancellare o spostare la prenotazione dal link qui sopra.
      </p>`,
  });

  const result = await sendWithIcs({
    to: booking.attendee_email,
    subject: `Prenotazione confermata: ${eventType.title}`,
    html, ics,
  });
  if (!result.success && result.error) {
    await markReminderError(booking.id, 'confirmation', booking.attendee_email, result.error);
  }
  return result;
}

// ============================================
// 2. Notifica admin
// ============================================

export async function sendBookingAdminNotification({ booking, eventType }: SendOpts): Promise<SendResult> {
  const tz = 'Europe/Rome';

  if (!await claimReminder(booking.id, 'admin_notification', ADMIN_EMAIL)) {
    return { success: false, error: 'already_processed' };
  }

  const html = frame({
    title: `Nuova prenotazione: ${eventType.title}`,
    body: `
      <h1 style="color:#111;font-size:20px;font-weight:600;margin:0 0 16px">Nuova prenotazione</h1>
      <p style="color:#374151;font-size:14px;margin:0 0 8px"><strong>${esc(booking.attendee_name)}</strong> &lt;${esc(booking.attendee_email)}&gt;</p>
      ${booking.attendee_phone ? `<p style="color:#6b7280;font-size:13px;margin:0 0 8px">📞 ${esc(booking.attendee_phone)}</p>` : ''}
      ${booking.attendee_company ? `<p style="color:#6b7280;font-size:13px;margin:0 0 8px">🏢 ${esc(booking.attendee_company)}</p>` : ''}
      ${buildBookingDetailsBlock(booking, eventType, tz)}
      <p style="color:#9ca3af;font-size:12px;margin:24px 0 0">UID: <code>${booking.uid}</code> · Origine: ${esc(booking.source)}</p>`,
  });

  const ics = buildIcs({
    booking, eventType,
    organizerName: ORGANIZER_NAME,
    organizerEmail: ADMIN_EMAIL,
    method: 'REQUEST',
  });

  const result = await sendWithIcs({
    to: ADMIN_EMAIL,
    subject: `📅 Prenotazione: ${booking.attendee_name} — ${eventType.title}`,
    html, ics,
  });
  if (!result.success && result.error) {
    await markReminderError(booking.id, 'admin_notification', ADMIN_EMAIL, result.error);
  }
  return result;
}

// ============================================
// 3. Reminder 24h / 2h
// ============================================

export async function sendBookingReminder(opts: SendOpts & { kind: '24h' | '2h' }): Promise<SendResult> {
  const { booking, eventType, kind } = opts;
  const tz = booking.attendee_timezone || 'Europe/Rome';
  const manage = manageUrl(booking.uid);
  const reminderType = kind === '24h' ? 'reminder_24h' : 'reminder_2h';

  if (!await claimReminder(booking.id, reminderType, booking.attendee_email)) {
    return { success: false, error: 'already_processed' };
  }

  const html = frame({
    title: `Promemoria: ${eventType.title}`,
    body: `
      <h1 style="color:#111;font-size:20px;font-weight:600;margin:0 0 16px">${kind === '24h' ? 'Ci vediamo domani 👋' : 'Ci vediamo tra poco 👋'}</h1>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        Ciao ${esc(booking.attendee_name)}, ${kind === '24h' ? 'tra circa 24 ore' : 'tra circa 2 ore'} abbiamo:
      </p>
      ${buildBookingDetailsBlock(booking, eventType, tz)}
      ${manage ? ctaButton(manage, 'Gestisci la prenotazione', '#0ea5e9') : ''}`,
  });

  const ics = buildIcs({
    booking, eventType,
    organizerName: ORGANIZER_NAME,
    organizerEmail: ADMIN_EMAIL,
    manageUrl: manage || undefined,
    meetingUrl: eventType.location_type === 'google_meet' || eventType.location_type === 'custom_url'
      ? booking.location_value || null : null,
    method: 'REQUEST',
    sequence: 0,
  });

  const result = await sendWithIcs({
    to: booking.attendee_email,
    subject: `Promemoria ${kind === '24h' ? 'domani' : 'oggi'}: ${eventType.title} alle ${formatTime(booking.start_time, tz)}`,
    html, ics,
  });
  if (!result.success && result.error) {
    await markReminderError(booking.id, reminderType, booking.attendee_email, result.error);
  }
  return result;
}

// ============================================
// 4. Cancellazione
// ============================================

export async function sendBookingCancelled({
  booking, eventType, recipient,
}: SendOpts & { recipient: 'attendee' | 'admin' }): Promise<SendResult> {
  const tz = recipient === 'admin' ? 'Europe/Rome' : (booking.attendee_timezone || 'Europe/Rome');
  const to = recipient === 'admin' ? ADMIN_EMAIL : booking.attendee_email;

  if (!await claimReminder(booking.id, 'cancelled', to)) {
    return { success: false, error: 'already_processed' };
  }

  const html = frame({
    title: `Cancellata: ${eventType.title}`,
    body: `
      <h1 style="color:#111;font-size:20px;font-weight:600;margin:0 0 16px">Prenotazione cancellata</h1>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        ${recipient === 'admin'
          ? `${esc(booking.attendee_name)} ha cancellato la prenotazione.`
          : 'La tua prenotazione è stata cancellata.'}
      </p>
      ${buildBookingDetailsBlock(booking, eventType, tz)}
      ${booking.cancellation_reason ? `<p style="color:#6b7280;font-size:13px;margin:0 0 16px"><strong>Motivo:</strong> ${esc(booking.cancellation_reason)}</p>` : ''}
      ${recipient === 'attendee' ? `<p style="color:#6b7280;font-size:13px;line-height:1.6;margin:24px 0 0">Vuoi riprenotare? <a href="${esc(SITE_URL)}/prenota/${esc(eventType.slug)}" style="color:#7c3aed">Torna alla pagina prenotazioni</a>.</p>` : ''}`,
  });

  const ics = buildIcs({
    booking, eventType,
    organizerName: ORGANIZER_NAME,
    organizerEmail: ADMIN_EMAIL,
    method: 'CANCEL',
    sequence: 1,
  });

  const result = await sendWithIcs({
    to,
    subject: `Cancellata: ${eventType.title}`,
    html, ics,
  });
  if (!result.success && result.error) {
    await markReminderError(booking.id, 'cancelled', to, result.error);
  }
  return result;
}

// ============================================
// 5. Reschedule
// ============================================

export async function sendBookingRescheduled({
  booking, eventType, previousStart, recipient,
}: SendOpts & { previousStart: string; recipient: 'attendee' | 'admin' }): Promise<SendResult> {
  const tz = recipient === 'admin' ? 'Europe/Rome' : (booking.attendee_timezone || 'Europe/Rome');
  const to = recipient === 'admin' ? ADMIN_EMAIL : booking.attendee_email;
  const manage = manageUrl(booking.uid);

  if (!await claimReminder(booking.id, 'rescheduled', to)) {
    return { success: false, error: 'already_processed' };
  }

  const html = frame({
    title: `Spostata: ${eventType.title}`,
    body: `
      <h1 style="color:#111;font-size:20px;font-weight:600;margin:0 0 16px">Prenotazione spostata</h1>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        ${recipient === 'admin'
          ? `${esc(booking.attendee_name)} ha spostato la prenotazione.`
          : 'La tua prenotazione è stata spostata al nuovo orario qui sotto.'}
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0 0 8px;text-decoration:line-through">Era previsto: ${esc(formatDateLong(previousStart, tz))}</p>
      ${buildBookingDetailsBlock(booking, eventType, tz)}
      ${recipient === 'attendee' && manage ? ctaButton(manage, 'Gestisci la prenotazione') : ''}`,
  });

  const ics = buildIcs({
    booking, eventType,
    organizerName: ORGANIZER_NAME,
    organizerEmail: ADMIN_EMAIL,
    manageUrl: manage || undefined,
    method: 'REQUEST',
    sequence: 1,
  });

  const result = await sendWithIcs({
    to,
    subject: `Spostata: ${eventType.title} — ${formatDateLong(booking.start_time, tz)}`,
    html, ics,
  });
  if (!result.success && result.error) {
    await markReminderError(booking.id, 'rescheduled', to, result.error);
  }
  return result;
}
