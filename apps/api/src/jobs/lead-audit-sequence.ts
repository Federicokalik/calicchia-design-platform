import { sql } from '../db';
import { sendEmail } from '../lib/email';
import { renderAuditEmail1 } from '../templates/audit-email-1';
import { renderAuditEmail2 } from '../templates/audit-email-2';
import { renderAuditEmail3 } from '../templates/audit-email-3';

const SEQUENCE_TYPE = 'audit-onboarding';
const DEFAULT_EVENT_TYPE_SLUG = process.env.CONTACT_FORM_EVENT_TYPE || 'consulenza-gratuita-30min';
const SITE_URL = process.env.PUBLIC_SITE_URL || process.env.SITE_URL || 'https://calicchia.design';
const BOOKING_URL =
  process.env.AUDIT_BOOKING_URL || `${SITE_URL.replace(/\/$/, '')}/prenota/${DEFAULT_EVENT_TYPE_SLUG}`;

const SERVICE_LABELS: Record<string, string> = {
  'web-design': 'web design',
  'e-commerce': 'e-commerce',
  'sviluppo-web': 'sviluppo web',
  seo: 'SEO',
  branding: 'branding',
  'manutenzione-siti': 'manutenzione siti',
  'assistenza-wordpress': 'assistenza WordPress',
  'wordpress-migrazione': 'migrazione e hosting WordPress',
};

interface AuditSequenceRow {
  id: number;
  contact_id: string;
  step: number;
  name: string;
  email: string;
  company: string | null;
  message: string | null;
  services: string[] | null;
  source_service: string | null;
  lead_source: string | null;
  cal_booking_uid: string | null;
  contact_created_at: string;
}

export function isAuditLeadSource(source: string | null | undefined): source is string {
  return typeof source === 'string' && source.startsWith('audit-');
}

export async function scheduleAuditOnboardingSequence(
  contactId: string,
  leadSource: string | null | undefined
): Promise<void> {
  if (!isAuditLeadSource(leadSource)) return;

  await sql`
    INSERT INTO email_sequences (contact_id, sequence_type, step, scheduled_at)
    VALUES (${contactId}::uuid, ${SEQUENCE_TYPE}, 1, NOW())
    ON CONFLICT (contact_id, sequence_type, step) DO NOTHING
  `;
}

function getServiceSlug(row: AuditSequenceRow): string | null {
  if (isAuditLeadSource(row.lead_source)) {
    return row.lead_source.slice('audit-'.length) || null;
  }

  if (row.source_service) return row.source_service;
  return row.services?.[0] ?? null;
}

function getServiceLabel(row: AuditSequenceRow): string {
  const slug = getServiceSlug(row);
  if (!slug) return 'il sito';
  return SERVICE_LABELS[slug] ?? slug.replace(/-/g, ' ');
}

function extractWebsiteUrl(message: string | null): string {
  const match = message?.match(/https?:\/\/[^\s)]+/i);
  return match?.[0] ?? 'il sito indicato';
}

function getIndustrySimilar(row: AuditSequenceRow): string {
  const service = getServiceLabel(row);
  return row.company ? `${row.company}` : service;
}

function getMicroCase(row: AuditSequenceRow): string {
  const service = getServiceLabel(row);
  return `In un progetto ${service}, il problema non era "rifare il sito": era togliere attrito nei primi 30 secondi. Abbiamo chiarito la promessa, accorciato il percorso verso il contatto e reso misurabile ogni richiesta. Meno rumore, più richieste buone.`;
}

async function hasClientRespondedOrBooked(row: AuditSequenceRow): Promise<boolean> {
  if (row.cal_booking_uid) return true;

  const [booking] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM calendar_bookings
      WHERE LOWER(attendee_email) = LOWER(${row.email})
        AND created_at >= ${row.contact_created_at}::timestamptz
        AND status IN ('confirmed', 'rescheduled', 'completed')
    ) AS exists
  `;
  if (booking?.exists) return true;

  const [reply] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM email_messages
      WHERE LOWER(from_addr) = LOWER(${row.email})
        AND COALESCE(received_at, synced_at) >= ${row.contact_created_at}::timestamptz
    ) AS exists
  `;

  return Boolean(reply?.exists);
}

function renderStep(row: AuditSequenceRow): { subject: string; html: string } {
  if (row.step === 1) {
    return renderAuditEmail1({
      name: row.name,
      service: getServiceLabel(row),
      bookingUrl: BOOKING_URL,
      siteUrl: SITE_URL,
    });
  }

  if (row.step === 2) {
    return renderAuditEmail2({
      name: row.name,
      siteUrl: extractWebsiteUrl(row.message),
      bookingUrl: BOOKING_URL,
    });
  }

  return renderAuditEmail3({
    name: row.name,
    industrySimilar: getIndustrySimilar(row),
    microCase: getMicroCase(row),
    bookingUrl: BOOKING_URL,
  });
}

async function scheduleNextStep(row: AuditSequenceRow): Promise<void> {
  if (row.step >= 3) return;

  const nextStep = row.step + 1;
  const delay = row.step === 1 ? sql`INTERVAL '48 hours'` : sql`INTERVAL '72 hours'`;

  await sql`
    INSERT INTO email_sequences (contact_id, sequence_type, step, scheduled_at)
    VALUES (${row.contact_id}::uuid, ${SEQUENCE_TYPE}, ${nextStep}, NOW() + ${delay})
    ON CONFLICT (contact_id, sequence_type, step) DO NOTHING
  `;
}

async function closePendingRow(rowId: number): Promise<void> {
  await sql`
    UPDATE email_sequences
    SET sent_at = NOW()
    WHERE id = ${rowId}
      AND sent_at IS NULL
  `;
}

async function processSequenceRow(row: AuditSequenceRow): Promise<void> {
  if (row.step > 1 && await hasClientRespondedOrBooked(row)) {
    await closePendingRow(row.id);
    return;
  }

  const rendered = renderStep(row);
  const result = await sendEmail({
    to: row.email,
    subject: rendered.subject,
    html: rendered.html,
  });

  if (!result.success) {
    console.warn('[lead-audit-sequence] email not sent:', {
      contactId: row.contact_id,
      step: row.step,
      error: result.error,
    });
    return;
  }

  await closePendingRow(row.id);

  if (!await hasClientRespondedOrBooked(row)) {
    await scheduleNextStep(row);
  }
}

export async function runLeadAuditSequence(): Promise<void> {
  const pending = await sql<AuditSequenceRow[]>`
    SELECT
      es.id,
      es.contact_id,
      es.step,
      c.name,
      c.email,
      c.company,
      c.message,
      c.services,
      c.source_service,
      c.lead_source,
      c.cal_booking_uid,
      c.created_at AS contact_created_at
    FROM email_sequences es
    JOIN contacts c ON c.id = es.contact_id
    WHERE es.sequence_type = ${SEQUENCE_TYPE}
      AND es.scheduled_at <= NOW()
      AND es.sent_at IS NULL
    ORDER BY es.scheduled_at ASC
    LIMIT 25
  `;

  if (!pending.length) return;

  console.log(`[lead-audit-sequence] ${pending.length} email pending`);

  for (const row of pending) {
    try {
      await processSequenceRow(row);
    } catch (err) {
      console.error('[lead-audit-sequence] row error:', {
        id: row.id,
        contactId: row.contact_id,
        step: row.step,
        err,
      });
    }
  }
}
