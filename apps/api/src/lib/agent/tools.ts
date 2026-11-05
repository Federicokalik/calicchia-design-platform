/**
 * Agent Tool Definitions
 *
 * Each tool has: name, description, parameters (JSON Schema), execute function.
 * The LLM sees name+description+parameters and decides which tool to call.
 * The execute function runs the actual logic with DB access.
 *
 * GUARDRAILS:
 * - Tools marked requiresConfirmation cannot execute from admin/telegram chat
 *   unless the user explicitly confirmed (handled by agent core)
 * - SQL queries are whitelisted (no DELETE/DROP/ALTER/TRUNCATE)
 * - Rate limited: max 20 tool calls per minute per channel
 */

import { fromZonedTime } from 'date-fns-tz';
import { z, type ZodTypeAny } from 'zod';
import { sql, jsonb } from '../../db';
import { logger } from '../logger';
import { billingEmailsSchema, billingRecipients } from '../customer-recipients';
import { mergePatch } from '../json-merge-patch';
import { itErrorMap, RequestValidationError, validationMessage, zodDetails, type ValidationDetail } from '../validation';
import { ATTACHMENT_FIELD_HINTS, attachmentInputSchema, describeAttachment, MAX_ATTACHMENTS, resolveAttachments } from '../mail/attachments';
import { addressListSchema, formatAddress, MESSAGE_FIELD_HINTS } from '../mail/message-schema';

const log = logger.child({ scope: 'tools' });

/** Argomenti di un tool non validi: executeTool li restituisce come errore leggibile, senza log di errore. */
export class ToolInputError extends Error {
  constructor(message: string, readonly details: ValidationDetail[] = []) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * Valida gli argomenti di un tool. Gli oggetti sono `strict`: un argomento
 * sconosciuto (es. "allegati" al posto di "attachments") è un errore che lo
 * nomina, invece di essere ignorato. Uno schema con .refine() non è più uno
 * ZodObject: va reso `.strict()` PRIMA del refine.
 */
export function parseToolArgs<S extends ZodTypeAny>(
  toolName: string,
  args: unknown,
  schema: S,
  hints: Readonly<Record<string, string>> = {},
): z.output<S> {
  const strict = schema instanceof z.ZodObject ? schema.strict() : schema;
  const result = strict.safeParse(args ?? {}, { errorMap: itErrorMap });
  if (!result.success) {
    const details = zodDetails(result.error, hints);
    throw new ToolInputError(validationMessage(details, `Argomenti non validi per ${toolName}`), details);
  }
  return result.data;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskLevel?: 'low' | 'medium' | 'high';
  /** Display name for MCP clients (tools/list `title`). */
  title?: string;
  requiresConfirmation?: boolean; // If true, agent must ask user before executing
  confirmLabel?: string; // Human-readable label for the confirmation button (admin AI bar)
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/** Parametro `attachments` dei tool email (stesso schema di POST /api/mail/send). */
const ATTACHMENTS_PARAM = {
  type: 'array',
  maxItems: MAX_ATTACHMENTS,
  description:
    'Allegati: max 10 MB ciascuno e 20 MB in totale; tipi pdf, png, jpg, webp, zip, docx, xlsx, txt, csv. ' +
    'Usa preferibilmente media_id (key di un file della libreria /api/media, caricato per esempio con api_request ' +
    'multipart su /api/media/upload) oppure url interno (/media/<key> o URL firmato /api/files/...). ' +
    'Il base64 inline in content costa molti token: solo per file piccoli (< ~50 KB).',
  items: {
    type: 'object',
    properties: {
      media_id: { type: 'string', description: 'key del file nella libreria media, es. "uploads/1730000000000-ab12cd-proforma.pdf"' },
      url: { type: 'string', description: 'URL interno: /media/<key> oppure URL firmato /api/files/<categoria>/<nome>?exp=..&sig=..' },
      filename: { type: 'string', description: 'Nome mostrato al destinatario, es. "Proforma PF 3-2026.pdf" (obbligatorio con content)' },
      contentType: { type: 'string', description: 'MIME type, facoltativo (ricavato dall\'estensione)' },
      content: { type: 'string', description: 'Contenuto in base64, solo per file piccoli' },
      encoding: { type: 'string', enum: ['base64'] },
    },
    additionalProperties: false,
  },
};

const TOOL_EMAIL_HINTS = { ...ATTACHMENT_FIELD_HINTS, ...MESSAGE_FIELD_HINTS, body: 'body (HTML), html o text' };

// === GUARDRAILS ===

// SQL safety: block dangerous queries
const BLOCKED_SQL = /\b(DELETE|DROP|TRUNCATE|ALTER|UPDATE\s+users|INSERT\s+INTO\s+users)\b/i;

export function isSqlSafe(query: string): boolean {
  return !BLOCKED_SQL.test(query);
}

// Rate limiting: track calls per channel
const callCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_CALLS_PER_MINUTE = 20;

export function checkRateLimit(channel: string, maxPerMinute: number = MAX_CALLS_PER_MINUTE): boolean {
  const now = Date.now();
  const entry = callCounts.get(channel);
  if (!entry || now > entry.resetAt) {
    callCounts.set(channel, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= maxPerMinute) return false;
  entry.count++;
  return true;
}

// Budget cap: check monthly spend
let budgetCapEur = 20; // default €20/month
export function setBudgetCap(cap: number) { budgetCapEur = cap; }

export async function checkBudgetCap(): Promise<boolean> {
  try {
    const [result] = await sql`
      SELECT COALESCE(SUM(cost_eur), 0)::numeric AS total
      FROM ai_usage_logs
      WHERE created_at > DATE_TRUNC('month', CURRENT_DATE)
    `;
    return parseFloat(result?.total || '0') < budgetCapEur;
  } catch { return true; }
}

// === CALENDAR HELPERS + SHARED EXECUTORS ===
// Gli executor sono condivisi tra i tool canonici (create_booking, …) e gli
// alias legacy (create_cal_booking, …) che un tempo scrivevano sulla tabella
// morta cal_bookings: entrambi ora operano SOLO sul motore live.

const ROME_TZ = 'Europe/Rome';

/** Finestra [fromIso, toIso) del giorno corrente in Europe/Rome (DST-safe). */
function romeDayWindow(): { date: string; fromIso: string; toIso: string } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: ROME_TZ }).format(new Date());
  const [y, m, d] = date.split('-').map(Number);
  const nextDate = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return {
    date,
    fromIso: fromZonedTime(`${date}T00:00:00`, ROME_TZ).toISOString(),
    toIso: fromZonedTime(`${nextDate}T00:00:00`, ROME_TZ).toISOString(),
  };
}

/** Luogo/link scelto per la singola prenotazione (vince sul tipo evento, resta nelle riprogrammazioni). */
const BOOKING_LOCATION_PROPS = {
  meeting_url: {
    type: 'string',
    description: 'Link https della videocall per questa prenotazione (MEGA, Zoom, Google Meet, Teams...), es. https://mega.nz/... Sostituisce il link del tipo evento.',
  },
  location_type: {
    type: 'string',
    enum: ['custom_url', 'google_meet', 'in_person', 'phone'],
    description: 'In alternativa a meeting_url: tipo di luogo (in_person = indirizzo, phone = telefono)',
  },
  location_value: { type: 'string', description: 'Valore del luogo per location_type (indirizzo, numero o link)' },
};

const CREATE_BOOKING_PARAMS = {
  type: 'object',
  properties: {
    event_type_slug: { type: 'string', description: 'Slug dell\'event type (es. consulenza-gratuita-30min); vedi list_event_types' },
    start: { type: 'string', description: 'ISO UTC datetime (es. 2026-04-26T09:00:00Z)' },
    attendee_name: { type: 'string' },
    attendee_email: { type: 'string' },
    attendee_phone: { type: 'string' },
    attendee_company: { type: 'string' },
    attendee_message: { type: 'string' },
    allow_buffer_override: { type: 'boolean', description: 'Consenti lo slot anche se viola i buffer dell\'event type (default false)' },
    ...BOOKING_LOCATION_PROPS,
  },
  required: ['event_type_slug', 'start', 'attendee_name', 'attendee_email'],
};

const executeCreateBooking = async (args: Record<string, unknown>): Promise<string> => {
  const { createBooking, BookingConflictError, BookingValidationError } = await import('../calendar/booking');
  const { sendBookingConfirmation, sendBookingAdminNotification } = await import('../calendar/email');
  const { parseLocationInput } = await import('../calendar/meeting-url');
  const parsedLocation = parseLocationInput(args);
  if ('error' in parsedLocation) return JSON.stringify({ error: parsedLocation.error, code: 'VALIDATION' });
  try {
    const { booking, eventType } = await createBooking({
      event_type_slug: args.event_type_slug as string,
      start: args.start as string,
      attendee: {
        name: args.attendee_name as string,
        email: args.attendee_email as string,
        phone: args.attendee_phone as string | undefined,
        company: args.attendee_company as string | undefined,
        timezone: ROME_TZ,
        message: args.attendee_message as string | undefined,
      },
      source: 'mcp',
      source_metadata: { created_via: 'mcp_tool' },
      allow_buffer_override: args.allow_buffer_override === true,
      location: parsedLocation.location,
    });
    Promise.allSettled([
      sendBookingConfirmation({ booking, eventType }),
      sendBookingAdminNotification({ booking, eventType }),
    ]).catch(() => {});
    return JSON.stringify({
      success: true,
      uid: booking.uid,
      status: booking.status,
      start_time: booking.start_time,
      end_time: booking.end_time,
    });
  } catch (err) {
    if (err instanceof BookingConflictError) return JSON.stringify({ error: err.message, code: 'CONFLICT' });
    if (err instanceof BookingValidationError) return JSON.stringify({ error: err.message, code: 'VALIDATION' });
    return JSON.stringify({ error: err instanceof Error ? err.message : 'Errore sconosciuto' });
  }
};

const executeCancelBooking = async (args: Record<string, unknown>): Promise<string> => {
  const { cancelBooking } = await import('../calendar/booking');
  const { sendBookingCancelled } = await import('../calendar/email');
  // Gli alias legacy passavano booking_id: accettalo come sinonimo di uid.
  const uid = (args.uid ?? args.booking_id) as string;
  if (!uid) return JSON.stringify({ error: 'uid richiesto' });
  const result = await cancelBooking(uid, {
    cancelled_by: 'admin',
    reason: args.reason as string | undefined,
  });
  if (!result) return JSON.stringify({ error: 'Booking non trovato' });
  Promise.allSettled([
    sendBookingCancelled({ ...result, recipient: 'attendee' }),
  ]).catch(() => {});
  return JSON.stringify({ success: true, uid });
};

const executeRescheduleBooking = async (args: Record<string, unknown>): Promise<string> => {
  const { rescheduleBooking, BookingConflictError, BookingValidationError } = await import('../calendar/booking');
  const { sendBookingRescheduled } = await import('../calendar/email');
  const { parseLocationInput } = await import('../calendar/meeting-url');
  const uid = (args.uid ?? args.booking_id) as string;
  const start = args.start as string;
  if (!uid || !start) return JSON.stringify({ error: 'uid e start richiesti' });
  const parsedLocation = parseLocationInput(args);
  if ('error' in parsedLocation) return JSON.stringify({ error: parsedLocation.error, code: 'VALIDATION' });
  const previous = await sql<{ start_time: string }[]>`
    SELECT start_time FROM calendar_bookings WHERE uid = ${uid} LIMIT 1
  `;
  if (!previous[0]) return JSON.stringify({ error: 'Booking non trovato' });
  try {
    const result = await rescheduleBooking(uid, start, {
      by: 'admin',
      reason: args.reason as string | undefined,
      allow_buffer_override: args.allow_buffer_override === true,
      location: parsedLocation.location,
    });
    if (args.notify !== false) {
      Promise.allSettled([
        sendBookingRescheduled({
          booking: result.booking, eventType: result.eventType,
          previousStart: previous[0].start_time, recipient: 'attendee',
        }),
      ]).catch(() => {});
    }
    return JSON.stringify({
      success: true,
      uid: result.booking.uid,
      previous_uid: result.previousUid,
      start_time: result.booking.start_time,
      end_time: result.booking.end_time,
      ...(parsedLocation.location || args.notify === false
        ? { location_type: result.booking.location_type, location_value: result.booking.location_value, notified: args.notify !== false }
        : {}),
    });
  } catch (err) {
    if (err instanceof BookingConflictError) return JSON.stringify({ error: err.message, code: 'CONFLICT' });
    if (err instanceof BookingValidationError) return JSON.stringify({ error: err.message, code: 'VALIDATION' });
    return JSON.stringify({ error: err instanceof Error ? err.message : 'Errore sconosciuto' });
  }
};

const executeUpdateBookingLocation = async (args: Record<string, unknown>): Promise<string> => {
  const { updateBookingLocation } = await import('../calendar/booking');
  const { parseLocationInput } = await import('../calendar/meeting-url');
  const { sendBookingConfirmation } = await import('../calendar/email');
  const uid = (args.uid ?? args.booking_id) as string;
  if (!uid) return JSON.stringify({ error: 'uid richiesto' });
  const parsed = parseLocationInput(args);
  if ('error' in parsed) return JSON.stringify({ error: parsed.error, code: 'VALIDATION' });
  if (!parsed.location) return JSON.stringify({ error: 'meeting_url oppure location_type richiesto', code: 'VALIDATION' });
  const result = await updateBookingLocation(uid, parsed.location);
  if (!result) return JSON.stringify({ error: 'Booking non trovato o non attivo' });
  if (args.notify === true) {
    // Come POST /bookings/:uid/resend-confirmation: rimuove l'audit della conferma e la reinvia.
    await sql`
      DELETE FROM calendar_booking_reminders
      WHERE booking_id = ${result.booking.id}::uuid AND reminder_type = 'confirmation'
    `;
    Promise.allSettled([sendBookingConfirmation(result)]).catch(() => {});
  }
  return JSON.stringify({
    success: true,
    uid: result.booking.uid,
    location_type: result.booking.location_type,
    location_value: result.booking.location_value,
    notified: args.notify === true,
  });
};

const executeListBookings = async (args: Record<string, unknown>): Promise<string> => {
  const status = (args.status as string) || 'confirmed';
  const limit = Math.max(1, Math.min((args.limit as number) || 50, 200));
  const statusFilter = status === 'all' ? sql`` : sql`AND b.status = ${status}`;
  const fromFilter = args.from_date ? sql`AND b.start_time >= ${(args.from_date as string) + 'T00:00:00Z'}` : sql``;
  const toFilter = args.to_date ? sql`AND b.start_time < ${(args.to_date as string) + 'T23:59:59Z'}` : sql``;
  const rows = await sql`
    SELECT b.uid, b.status, b.attendee_name, b.attendee_email,
           b.start_time, b.end_time, b.location_value,
           et.title AS event_type_title, et.slug AS event_type_slug
    FROM calendar_bookings b
    JOIN calendar_event_types et ON et.id = b.event_type_id
    WHERE 1=1 ${statusFilter} ${fromFilter} ${toFilter}
    ORDER BY b.start_time DESC
    LIMIT ${limit}
  `;
  return JSON.stringify({ count: rows.length, bookings: rows });
};

export const tools: ToolDefinition[] = [
  // === READ TOOLS ===
  {
    name: 'get_leads',
    description: 'Ottieni la lista dei lead nella pipeline, opzionalmente filtrati per stato',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filtra per stato: new, contacted, proposal, negotiation, won, lost', enum: ['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost'] },
        limit: { type: 'number', description: 'Numero max risultati (default 10)' },
      },
    },
    execute: async (args) => {
      const limit = (args.limit as number) || 10;
      const statusFilter = args.status ? sql`AND status = ${args.status as string}` : sql``;
      const rows = await sql`SELECT name, email, company, status, estimated_value, created_at FROM leads WHERE 1=1 ${statusFilter} ORDER BY created_at DESC LIMIT ${limit}`;
      return JSON.stringify({ leads: rows, count: rows.length });
    },
  },
  {
    name: 'get_customers',
    description: 'Cerca clienti per nome, azienda o email',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Termine di ricerca' },
        limit: { type: 'number', description: 'Numero max risultati (default 10)' },
      },
    },
    execute: async (args) => {
      const limit = (args.limit as number) || 10;
      const search = args.search as string;
      const searchFilter = search
        ? sql`AND (contact_name ILIKE ${'%' + search + '%'} OR company_name ILIKE ${'%' + search + '%'} OR email ILIKE ${'%' + search + '%'})`
        : sql``;
      const rows = await sql`SELECT contact_name, company_name, email, phone, status, total_revenue FROM customers WHERE 1=1 ${searchFilter} ORDER BY updated_at DESC LIMIT ${limit}`;
      return JSON.stringify({ customers: rows, count: rows.length });
    },
  },
  {
    name: 'get_projects',
    description: 'Ottieni la lista dei progetti, opzionalmente filtrati per stato',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filtra: draft, in_progress, review, completed, on_hold' },
        limit: { type: 'number' },
      },
    },
    execute: async (args) => {
      const limit = (args.limit as number) || 10;
      const statusFilter = args.status ? sql`AND status = ${args.status as string}` : sql``;
      const rows = await sql`SELECT name, status, progress_percentage, customer_name FROM client_projects_view WHERE 1=1 ${statusFilter} ORDER BY updated_at DESC LIMIT ${limit}`;
      return JSON.stringify({ projects: rows, count: rows.length });
    },
  },
  {
    name: 'get_calendar_today',
    description: 'Ottieni prenotazioni ed eventi di oggi dal calendario live (timezone Europe/Rome)',
    parameters: { type: 'object', properties: {} },
    riskLevel: 'low',
    execute: async () => {
      const { date, fromIso, toIso } = romeDayWindow();
      const bookings = await sql<{
        title: string; start_time: string; end_time: string;
        attendee_name: string | null; status: string;
      }[]>`
        SELECT et.title AS title, b.start_time, b.end_time, b.attendee_name, b.status
        FROM calendar_bookings b
        JOIN calendar_event_types et ON et.id = b.event_type_id
        WHERE b.status IN ('confirmed', 'pending')
          AND b.start_time >= ${fromIso} AND b.start_time < ${toIso}
        ORDER BY b.start_time
      `;
      const { listOccurrences } = await import('../calendar/events');
      const occurrences = await listOccurrences({ fromIso, toIso });
      const events = [
        ...bookings.map((b) => ({ ...b, kind: 'booking' })),
        // Escludi le proiezioni dei booking (source='booking') per non duplicare
        ...occurrences
          .filter((e) => e.source !== 'booking' && e.status !== 'cancelled')
          .map((e) => ({
            title: e.summary,
            start_time: e.start_time,
            end_time: e.end_time,
            attendee_name: null,
            status: e.status,
            kind: 'event',
          })),
      ].sort((a, b) => new Date(a.start_time as string).getTime() - new Date(b.start_time as string).getTime());
      return JSON.stringify({ events, date, count: events.length });
    },
  },
  {
    name: 'get_revenue_summary',
    description: 'Ottieni il riepilogo revenue (mese corrente e precedente)',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const currentMonth = await sql`SELECT COALESCE(SUM(amount), 0) as total FROM payment_tracker WHERE status = 'pagata' AND DATE_TRUNC('month', paid_date) = DATE_TRUNC('month', CURRENT_DATE)`;
      const prevMonth = await sql`SELECT COALESCE(SUM(amount), 0) as total FROM payment_tracker WHERE status = 'pagata' AND DATE_TRUNC('month', paid_date) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')`;
      const pending = await sql`SELECT COALESCE(SUM(amount), 0) as total FROM payment_tracker WHERE status = 'emessa'`;
      return JSON.stringify({
        current_month: parseFloat(currentMonth[0]?.total || '0'),
        previous_month: parseFloat(prevMonth[0]?.total || '0'),
        pending: parseFloat(pending[0]?.total || '0'),
      });
    },
  },
  {
    name: 'get_domains_expiring',
    description:
      'Domini dei clienti in scadenza nei prossimi N giorni (default 30), con costo di rinnovo, auto_renew e ' +
      'destinatari amministrativi del cliente (billing_emails, altrimenti email). Con include_expired=true ' +
      'include anche quelli già scaduti. Restituisce count=0 e domains=[] se non ce ne sono.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Finestra in giorni da oggi (default 30)' },
        include_expired: { type: 'boolean', description: 'Includi i domini già scaduti (default false)' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const { days, include_expired: includeExpired } = parseToolArgs('get_domains_expiring', args, z.object({
        // coerce: i client MCP/LLM passano a volte "90" come stringa.
        days: z.coerce.number().int().min(1).max(3650).default(30),
        include_expired: z.boolean().default(false),
      }));
      // Colonna reale: expiration_date (la query leggeva expiry_date, inesistente:
      // il tool falliva sempre, anche con la tabella vuota).
      const lowerBound = includeExpired ? sql`` : sql`AND d.expiration_date >= CURRENT_DATE`;
      const rows = await sql<Array<{
        id: string; full_domain: string; domain_name: string; tld: string; expiration_date: string;
        days_until_expiration: number; auto_renew: boolean | null; status: string | null;
        renewal_cost: string | null; currency: string | null; registrar: string | null;
        customer_id: string | null; company_name: string | null; contact_name: string | null;
        customer_email: string | null; billing_emails: string[] | null;
      }>>`
        SELECT d.id, d.full_domain, d.domain_name, d.tld, d.expiration_date::text AS expiration_date,
               (d.expiration_date - CURRENT_DATE)::int AS days_until_expiration,
               d.auto_renew, d.status, d.renewal_cost, d.currency, d.registrar,
               c.id AS customer_id, c.company_name, c.contact_name, c.email AS customer_email, c.billing_emails
        FROM domains d
        LEFT JOIN customers c ON c.id = d.customer_id
        WHERE d.expiration_date <= CURRENT_DATE + ${days}::int
          ${lowerBound}
        ORDER BY d.expiration_date ASC, d.full_domain ASC
      `;
      const domains = rows.map((r) => ({
        id: r.id,
        full_domain: r.full_domain,
        expiration_date: r.expiration_date,
        days_until_expiration: r.days_until_expiration,
        auto_renew: r.auto_renew,
        status: r.status,
        renewal_cost: r.renewal_cost === null ? null : Number(r.renewal_cost),
        currency: r.currency,
        registrar: r.registrar,
        customer: r.customer_id
          ? {
              id: r.customer_id,
              name: r.company_name || r.contact_name,
              email: r.customer_email,
              billing_emails: r.billing_emails ?? [],
              recipients: billingRecipients({ email: r.customer_email, billing_emails: r.billing_emails }),
            }
          : null,
      }));
      return JSON.stringify({ days, include_expired: includeExpired, count: domains.length, domains });
    },
  },
  {
    name: 'get_quotes',
    description: 'Ottieni lista preventivi con filtro opzionale per stato',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'sent', 'viewed', 'signed', 'rejected', 'expired'] },
      },
    },
    execute: async (args) => {
      const statusFilter = args.status ? sql`AND status = ${args.status as string}` : sql``;
      const rows = await sql`SELECT title, status, total, valid_until, created_at FROM quotes_v2 WHERE 1=1 ${statusFilter} ORDER BY created_at DESC LIMIT 10`;
      return JSON.stringify({ quotes: rows, count: rows.length });
    },
  },
  {
    name: 'search_everything',
    description: 'Ricerca globale in clienti, lead, progetti e preventivi',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Termine di ricerca' } },
      required: ['query'],
    },
    execute: async (args) => {
      const q = args.query as string;
      const like = `%${q}%`;
      const [customers, leads, projects, quotes] = await Promise.all([
        sql`SELECT 'cliente' as type, id, contact_name as name, email FROM customers WHERE contact_name ILIKE ${like} OR company_name ILIKE ${like} OR email ILIKE ${like} LIMIT 5`,
        sql`SELECT 'lead' as type, id, name, email FROM leads WHERE name ILIKE ${like} OR email ILIKE ${like} OR company ILIKE ${like} LIMIT 5`,
        sql`SELECT 'progetto' as type, id, name, status FROM client_projects WHERE name ILIKE ${like} LIMIT 5`,
        sql`SELECT 'preventivo' as type, id, title as name, status FROM quotes_v2 WHERE title ILIKE ${like} LIMIT 5`,
      ]);
      return JSON.stringify({ results: [...customers, ...leads, ...projects, ...quotes] });
    },
  },

  // === CUSTOMER / PROJECT READ ===
  {
    name: 'find_customer',
    description: 'Cerca un cliente per nome, email, azienda. Usa prima di create_customer per evitare duplicati.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare in contact_name, company_name, email' },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const q = `%${(args.query as string).trim()}%`;
      const rows = await sql`
        SELECT id, contact_name, company_name, email, phone, status, created_at
        FROM customers
        WHERE deleted_at IS NULL
          AND (contact_name ILIKE ${q} OR company_name ILIKE ${q} OR email ILIKE ${q})
        ORDER BY updated_at DESC LIMIT 10
      `;
      return JSON.stringify({ count: rows.length, customers: rows });
    },
  },

  // === WRITE TOOLS ===
  {
    name: 'create_customer',
    description: 'Crea un nuovo cliente. RICHIEDE CONFERMA UTENTE. Prima usa find_customer per evitare duplicati.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        contact_name: { type: 'string', description: 'Nome del referente/contatto' },
        email: { type: 'string' },
        company_name: { type: 'string', description: 'Nome azienda (opzionale, distinto dal referente)' },
        phone: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        billing_emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Destinatari amministrativi (fatture, rinnovi, solleciti), es. ["amministrazione@azienda.it", "titolare@gmail.com"]. Se vuoto si usa email. Sostituisce l\'elenco intero; [] lo svuota.',
        },
        billing_address: {
          type: 'object',
          description: 'Dati di fatturazione: street, postal_code, city, province, country, vat_number, fiscal_code, sdi_code, pec.',
          additionalProperties: true,
        },
      },
      required: ['contact_name', 'email'],
    },
    execute: async (args) => {
      const email = (args.email as string).toLowerCase().trim();
      const billingEmails = args.billing_emails === undefined ? [] : parseToolArgs('create_customer', { billing_emails: args.billing_emails }, z.object({ billing_emails: billingEmailsSchema })).billing_emails;
      const billingAddress = args.billing_address === undefined ? {} : parseToolArgs('create_customer', { billing_address: args.billing_address }, z.object({ billing_address: z.record(z.unknown()) })).billing_address;
      const existing = await sql`SELECT id, contact_name FROM customers WHERE email = ${email} AND deleted_at IS NULL LIMIT 1`;
      if (existing.length > 0) {
        return JSON.stringify({ error: 'Cliente con questa email già esistente', existing: existing[0] });
      }
      const [row] = await sql`
        INSERT INTO customers (contact_name, email, company_name, phone, notes, tags, billing_emails, billing_address)
        VALUES (
          ${args.contact_name as string},
          ${email},
          ${(args.company_name as string) || null},
          ${(args.phone as string) || null},
          ${(args.notes as string) || null},
          ${jsonb((args.tags as string[]) || [])}::jsonb,
          ${billingEmails}::text[],
          ${jsonb(billingAddress)}::jsonb
        )
        RETURNING id, contact_name, company_name, email, billing_emails
      `;
      return JSON.stringify({ created: row });
    },
  },
  {
    name: 'create_project',
    description: 'Crea un progetto per un cliente. RICHIEDE CONFERMA. Passa customer_id dal find_customer/create_customer, oppure customer_email per resolve automatico.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'UUID cliente (preferito)' },
        customer_email: { type: 'string', description: 'Alternativa: email cliente da cui risalire all\'id' },
        name: { type: 'string', description: 'Nome del progetto' },
        description: { type: 'string' },
        project_type: { type: 'string', enum: ['website', 'landing_page', 'ecommerce', 'maintenance', 'website_template', 'consulting', 'other'] },
        project_category: { type: 'string', enum: ['grafica', 'web', 'ecommerce', 'webapp', 'marketing', 'consulenza'] },
        status: { type: 'string', enum: ['draft', 'proposal', 'approved', 'in_progress', 'review', 'completed', 'on_hold', 'cancelled'] },
        budget_amount: { type: 'number', description: 'Budget in euro' },
        estimated_hours: { type: 'number' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        target_end_date: { type: 'string', description: 'YYYY-MM-DD' },
        pipeline_steps: {
          type: 'array', items: { type: 'string' },
          description: 'Fasi del progetto visibili nel portale cliente (es. ["Brief", "Design", "Sviluppo", "Revisione", "Consegna"])',
        },
      },
      required: ['name'],
    },
    execute: async (args) => {
      let customerId = args.customer_id as string | undefined;
      if (!customerId && args.customer_email) {
        const [c] = await sql`SELECT id FROM customers WHERE email = ${(args.customer_email as string).toLowerCase().trim()} AND deleted_at IS NULL LIMIT 1`;
        if (!c) return JSON.stringify({ error: 'Cliente non trovato per email; crealo prima con create_customer' });
        customerId = c.id as string;
      }
      if (!customerId) return JSON.stringify({ error: 'customer_id o customer_email richiesto' });

      const [row] = await sql`
        INSERT INTO client_projects (
          customer_id, name, description, project_type, project_category, status,
          budget_amount, estimated_hours, start_date, target_end_date, pipeline_steps
        ) VALUES (
          ${customerId},
          ${args.name as string},
          ${(args.description as string) || null},
          ${(args.project_type as string) || 'other'}::project_type,
          ${(args.project_category as string) || null},
          ${(args.status as string) || 'draft'}::project_status,
          ${(args.budget_amount as number) || null},
          ${(args.estimated_hours as number) || null},
          ${(args.start_date as string) || null},
          ${(args.target_end_date as string) || null},
          ${jsonb((args.pipeline_steps as string[]) || [])}::jsonb
        )
        RETURNING id, name, status, customer_id
      `;
      return JSON.stringify({ created: row });
    },
  },
  {
    name: 'create_task',
    description: 'Crea un task in un progetto esistente. RICHIEDE CONFERMA. Passa project_id dal create_project o cerca per project_name.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID progetto (preferito)' },
        project_name: { type: 'string', description: 'Alternativa: nome del progetto' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done', 'blocked'] },
        priority: { type: 'number', description: '1 (urgente) a 5 (nessuna)' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        estimated_hours: { type: 'number' },
      },
      required: ['title'],
    },
    execute: async (args) => {
      let projectId = args.project_id as string | undefined;
      if (!projectId && args.project_name) {
        const [p] = await sql`SELECT id FROM client_projects WHERE name ILIKE ${'%' + (args.project_name as string) + '%'} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`;
        if (!p) return JSON.stringify({ error: 'Progetto non trovato per nome' });
        projectId = p.id as string;
      }
      if (!projectId) return JSON.stringify({ error: 'project_id o project_name richiesto' });

      const [row] = await sql`
        INSERT INTO project_tasks (project_id, title, description, status, priority, due_date, estimated_hours)
        VALUES (
          ${projectId},
          ${args.title as string},
          ${(args.description as string) || null},
          ${(args.status as string) || 'todo'}::task_status,
          ${(args.priority as number) || 5},
          ${(args.due_date as string) || null},
          ${(args.estimated_hours as number) || null}
        )
        RETURNING id, title, status, project_id
      `;
      return JSON.stringify({ created: row });
    },
  },
  {
    name: 'link_emails_to_customer',
    description: 'Collega tutte le email archiviate contenenti un dato indirizzo (from o to) a un cliente CRM, così compaiono nella sua scheda. Utile dopo create_customer per agganciare lo storico.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'UUID cliente' },
        customer_email: { type: 'string', description: 'Alternativa: email cliente' },
        match_emails: {
          type: 'array', items: { type: 'string' },
          description: 'Indirizzi email da matchare (se vuoto usa customer_email)',
        },
      },
    },
    execute: async (args) => {
      let customerId = args.customer_id as string | undefined;
      let customerEmail = (args.customer_email as string | undefined)?.toLowerCase().trim();
      if (!customerId && customerEmail) {
        const [c] = await sql`SELECT id FROM customers WHERE email = ${customerEmail} AND deleted_at IS NULL LIMIT 1`;
        if (!c) return JSON.stringify({ error: 'Cliente non trovato per email' });
        customerId = c.id as string;
      }
      if (!customerId) return JSON.stringify({ error: 'customer_id o customer_email richiesto' });

      if (!customerEmail) {
        const [c] = await sql`SELECT email FROM customers WHERE id = ${customerId} LIMIT 1`;
        customerEmail = (c?.email as string | undefined)?.toLowerCase().trim();
      }

      const matchList = ((args.match_emails as string[] | undefined) || [])
        .map((e) => e.toLowerCase().trim())
        .filter(Boolean);
      if (customerEmail) matchList.push(customerEmail);
      if (matchList.length === 0) return JSON.stringify({ error: 'Nessuna email da matchare' });

      const messages = await sql<Array<{ id: string }>>`
        SELECT id FROM email_messages
        WHERE LOWER(from_addr) = ANY(${matchList})
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(to_addrs) AS t
             WHERE LOWER(t->>'address') = ANY(${matchList})
           )
      `;
      let linked = 0;
      for (const m of messages) {
        const res = await sql`
          INSERT INTO email_links (message_id, entity_type, entity_id, auto)
          VALUES (${m.id}, 'cliente', ${customerId}, false)
          ON CONFLICT (message_id, entity_type, entity_id) DO NOTHING
          RETURNING id
        `;
        if (res.length > 0) linked++;
      }
      return JSON.stringify({ scanned: messages.length, linked });
    },
  },
  {
    name: 'create_lead',
    description: 'Crea un nuovo lead nella pipeline. RICHIEDE CONFERMA UTENTE.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome completo' },
        email: { type: 'string' },
        phone: { type: 'string' },
        company: { type: 'string' },
        estimated_value: { type: 'number', description: 'Valore stimato in euro' },
        source: { type: 'string', enum: ['manual', 'website_form', 'calcom', 'referral'] },
      },
      required: ['name'],
    },
    execute: async (args) => {
      const rows = await sql`INSERT INTO leads (name, email, phone, company, estimated_value, source) VALUES (${args.name as string}, ${(args.email as string) || null}, ${(args.phone as string) || null}, ${(args.company as string) || null}, ${(args.estimated_value as number) || null}, ${(args.source as string) || 'manual'}) RETURNING id, name, status`;
      return JSON.stringify({ created: rows[0] });
    },
  },
  {
    name: 'update_lead_status',
    description: 'Aggiorna lo stato di un lead nella pipeline',
    parameters: {
      type: 'object',
      properties: {
        lead_name: { type: 'string', description: 'Nome del lead da cercare' },
        status: { type: 'string', enum: ['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost'] },
      },
      required: ['lead_name', 'status'],
    },
    execute: async (args) => {
      const rows = await sql`UPDATE leads SET status = ${args.status as string}, updated_at = now() WHERE name ILIKE ${'%' + (args.lead_name as string) + '%'} RETURNING id, name, status`;
      if (!rows.length) return JSON.stringify({ error: 'Lead non trovato' });
      return JSON.stringify({ updated: rows[0] });
    },
  },
  {
    name: 'send_whatsapp',
    description: 'Invia un messaggio WhatsApp a un numero di telefono. Rispetta automaticamente le preferenze di opt-out del destinatario (categoria operational di default). RICHIEDE CONFERMA UTENTE.',
    riskLevel: 'high',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Numero telefono (con o senza prefisso, es +39... oppure 39...)' },
        message: { type: 'string', description: 'Testo del messaggio' },
        category: {
          type: 'string',
          enum: ['transactional', 'operational', 'marketing'],
          description: 'transactional = sempre consentito (fatture/scadenze/sicurezza). operational = default (reminder, follow-up). marketing = solo se il cliente ha dato opt-in esplicito.',
        },
      },
      required: ['phone', 'message'],
    },
    execute: async (args) => {
      try {
        const { sendWhatsAppText } = await import('../whatsapp');
        const { canSendWhatsApp } = await import('../whatsapp-policy');
        const category = (args.category as 'transactional' | 'operational' | 'marketing') || 'operational';
        const policy = await canSendWhatsApp(args.phone as string, category);
        if (!policy.allowed) {
          return JSON.stringify({ sent: false, blocked: true, reason: policy.reason });
        }
        const result = await sendWhatsAppText(args.phone as string, args.message as string);
        return JSON.stringify({ sent: true, externalId: result.externalId, category });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message || 'Errore invio WhatsApp' });
      }
    },
  },
  {
    name: 'list_whatsapp_conversations',
    description: 'Lista delle conversazioni WhatsApp recenti del gestionale, opzionalmente filtrate per non lette o per ricerca testo.',
    riskLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        only_unread: { type: 'boolean', description: 'Se true ritorna solo conversazioni con messaggi non letti' },
        search: { type: 'string', description: 'Ricerca su nome contatto, numero o anteprima ultimo messaggio' },
        limit: { type: 'number', description: 'Max risultati (default 20, max 50)' },
      },
    },
    execute: async (args) => {
      const limit = Math.min((args.limit as number) || 20, 50);
      const unreadFilter = args.only_unread ? sql`AND unread_count > 0` : sql``;
      const search = args.search as string | undefined;
      const searchFilter = search
        ? sql`AND (contact_name ILIKE ${'%' + search + '%'} OR phone ILIKE ${'%' + search + '%'} OR last_message_preview ILIKE ${'%' + search + '%'})`
        : sql``;
      const rows = await sql`
        SELECT id, chat_id, phone, contact_name, ai_mode, unread_count,
               last_message_at, last_message_preview, customer_id, lead_id
        FROM whatsapp_conversations
        WHERE archived = FALSE ${unreadFilter} ${searchFilter}
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT ${limit}
      `;
      return JSON.stringify({ conversations: rows, count: rows.length });
    },
  },
  {
    name: 'read_whatsapp_conversation',
    description: 'Mostra gli ultimi N messaggi di una specifica conversazione WhatsApp.',
    riskLevel: 'low',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'UUID della conversazione' },
        limit: { type: 'number', description: 'Numero messaggi (default 20)' },
      },
      required: ['conversation_id'],
    },
    execute: async (args) => {
      const limit = Math.min((args.limit as number) || 20, 100);
      const rows = await sql`
        SELECT direction, type, body, sender_kind, ai_draft, created_at
        FROM whatsapp_messages
        WHERE conversation_id = ${args.conversation_id as string}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ messages: rows.reverse(), count: rows.length });
    },
  },
  {
    name: 'set_whatsapp_ai_mode',
    description: 'Cambia la modalità AI di una conversazione WhatsApp (off/triage/auto_reply). triage = AI prepara bozza per approvazione admin; auto_reply = AI risponde automaticamente. RICHIEDE CONFERMA UTENTE.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        mode: { type: 'string', enum: ['off', 'triage', 'auto_reply'] },
      },
      required: ['conversation_id', 'mode'],
    },
    execute: async (args) => {
      const updated = await sql`
        UPDATE whatsapp_conversations
        SET ai_mode = ${args.mode as string}, updated_at = now()
        WHERE id = ${args.conversation_id as string}
        RETURNING id, ai_mode
      `;
      if (!updated.length) return JSON.stringify({ error: 'Conversazione non trovata' });
      return JSON.stringify({ updated: updated[0] });
    },
  },
  {
    name: 'send_email',
    description:
      "Invia un'email, anche con allegati (attachments: preferisci media_id). RICHIEDE CONFERMA UTENTE. " +
      'Se esiste una casella collegata (Posta) parte da lì e la copia finisce in Inviati; altrimenti usa il ' +
      'trasporto di sistema. Per le comunicazioni amministrative a un cliente usa i suoi billing_emails ' +
      '(get_domains_expiring / find_customer li restituiscono).',
    riskLevel: 'high',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        to: {
          description: 'Destinatari: stringa con indirizzi separati da virgola oppure array',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        cc: { description: 'CC (stringa o array)', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        bcc: { description: 'CCN (stringa o array)', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Corpo email in HTML' },
        text: { type: 'string', description: 'Corpo in testo semplice (in alternativa o in aggiunta a body)' },
        account_id: { type: 'string', description: 'UUID della casella mittente (default: la prima casella attiva)' },
        attachments: ATTACHMENTS_PARAM,
      },
      required: ['to', 'subject'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const input = parseToolArgs('send_email', args, z.object({
        to: addressListSchema.refine((l) => l.length > 0, 'almeno un destinatario'),
        cc: addressListSchema.optional(),
        bcc: addressListSchema.optional(),
        subject: z.string().trim().min(1),
        body: z.string().optional(),
        text: z.string().optional(),
        account_id: z.string().uuid().optional(),
        attachments: z.array(attachmentInputSchema).optional(),
      }).strict().refine((m) => Boolean(m.body?.trim() || m.text?.trim()), { path: ['body'], message: 'serve body (HTML) o text' }), TOOL_EMAIL_HINTS);
      const attachments = await resolveAttachments(input.attachments ?? []);

      const { loadOutboundAccount, sendFromAccount, MailDeliveryError } = await import('../mail/outbound');
      const account = await loadOutboundAccount(null, input.account_id);
      if (input.account_id && !account) return JSON.stringify({ error: 'Casella email (account_id) non trovata o non attiva' });

      if (account) {
        try {
          const result = await sendFromAccount(account, {
            to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject,
            html: input.body, text: input.text, attachments,
          });
          return JSON.stringify({
            sent: true,
            via: 'mailbox',
            from: account.email,
            message_id: result.messageId,
            accepted: result.accepted,
            rejected: result.rejected,
            attachments: attachments.map(describeAttachment),
            sent_copy: result.sentCopy,
          });
        } catch (err) {
          if (err instanceof MailDeliveryError) return JSON.stringify({ error: `Email non inviata: ${err.message}` });
          throw err;
        }
      }

      // Nessuna casella collegata: trasporto di sistema (SMTP/Resend), senza copia in Inviati.
      if (input.cc?.length || input.bcc?.length) {
        return JSON.stringify({ error: 'cc e bcc richiedono una casella email collegata (Posta): il trasporto di sistema invia solo a "to"' });
      }
      const { sendEmail } = await import('../email');
      const result = await sendEmail({
        to: input.to.map(formatAddress),
        subject: input.subject,
        html: input.body ?? `<pre style="font-family:inherit;white-space:pre-wrap">${(input.text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`,
        text: input.text,
        attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
      if (!result.success) return JSON.stringify({ error: `Email non inviata: ${result.error || 'errore sconosciuto'}` });
      return JSON.stringify({ sent: true, via: result.via ?? 'system', message_id: result.messageId, attachments: attachments.map(describeAttachment) });
    },
  },
  {
    name: 'generate_email',
    description: 'Genera il testo di un\'email professionale. NON la invia, restituisce solo il testo.',
    riskLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', description: 'Tipo: follow_up, proposta, ringraziamento, sollecito', enum: ['follow_up', 'proposta', 'ringraziamento', 'sollecito'] },
        destinatario: { type: 'string', description: 'Nome del destinatario' },
        contesto: { type: 'string', description: 'Contesto aggiuntivo (progetto, servizio, ecc.)' },
      },
      required: ['tipo', 'destinatario'],
    },
    execute: async (args) => {
      // This will be handled by the LLM itself, not a DB tool
      return JSON.stringify({
        note: 'Genera il testo email basandoti su tipo, destinatario e contesto forniti. Scrivi in italiano, tono professionale ma cordiale.',
        tipo: args.tipo,
        destinatario: args.destinatario,
        contesto: args.contesto || '',
      });
    },
  },
  {
    name: 'create_project_from_quote',
    description: 'Crea un progetto completo con task a partire da un preventivo. L\'AI analizza le voci del preventivo e genera task dettagliati con stime di ore per ognuno.',
    riskLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        quote_id: { type: 'string', description: 'ID del preventivo da cui creare il progetto' },
      },
      required: ['quote_id'],
    },
    execute: async (args) => {
      const { generateText } = await import('./llm-router');

      // Get quote data
      const quotes = await sql`
        SELECT q.*, c.contact_name, c.company_name, c.id as cust_id
        FROM quotes_v2 q LEFT JOIN customers c ON c.id = q.customer_id
        WHERE q.id = ${args.quote_id as string}
      `;
      if (!quotes.length) return JSON.stringify({ error: 'Preventivo non trovato' });

      const quote = quotes[0];
      const items = typeof quote.items === 'string' ? JSON.parse(quote.items) : (quote.items || []);

      // AI generates tasks from quote items
      const prompt = `Analizza questo preventivo e genera una lista di task dettagliati per completare il progetto.

Preventivo: ${quote.title}
Cliente: ${quote.contact_name} (${quote.company_name || ''})
Voci:
${items.map((i: any) => `- ${i.description}: €${i.total}`).join('\n')}

Per ogni task genera JSON con questa struttura (rispondi SOLO con JSON array, niente altro):
[{"title":"Nome task","description":"Breve desc","estimated_hours":4,"priority":5,"sort_order":1}]

Genera 5-12 task specifici e concreti. Le ore stimate devono essere realistiche per un web designer freelance.`;

      const result = await generateText('task_breakdown', [
        { role: 'system', content: 'Rispondi SOLO con JSON array valido.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.4 });

      let tasks: any[] = [];
      try {
        const match = result.match(/\[[\s\S]*\]/);
        tasks = match ? JSON.parse(match[0]) : [];
      } catch { tasks = []; }

      if (!tasks.length) return JSON.stringify({ error: 'AI non ha generato task validi', raw: result.slice(0, 300) });

      // Calculate total hours and timeline
      const totalHours = tasks.reduce((s: number, t: any) => s + (t.estimated_hours || 0), 0);
      const workDays = Math.ceil(totalHours / 6); // 6 ore/giorno produttive
      const startDate = new Date();
      const endDate = new Date(startDate.getTime() + workDays * 24 * 60 * 60 * 1000);

      // Create project
      const [project] = await sql`
        INSERT INTO client_projects (customer_id, name, project_type, status, priority, start_date, target_end_date, estimated_hours, budget_amount)
        VALUES (
          ${quote.cust_id || null},
          ${quote.title},
          'website',
          'draft',
          5,
          ${startDate.toISOString().split('T')[0]},
          ${endDate.toISOString().split('T')[0]},
          ${totalHours},
          ${quote.total || null}
        )
        RETURNING id, name
      `;

      // Create tasks
      for (const task of tasks) {
        await sql`
          INSERT INTO project_tasks (project_id, title, description, status, priority, estimated_hours, sort_order)
          VALUES (${project.id}, ${task.title}, ${task.description || null}, 'todo', ${task.priority || 5}, ${task.estimated_hours || 0}, ${task.sort_order || 0})
        `;
      }

      // Link quote to project
      await sql`UPDATE quotes_v2 SET project_id = ${project.id} WHERE id = ${args.quote_id as string}`;

      return JSON.stringify({
        created: true,
        project_id: project.id,
        project_name: project.name,
        tasks_count: tasks.length,
        total_hours: totalHours,
        estimated_days: workDays,
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        message: `Progetto "${project.name}" creato con ${tasks.length} task (${totalHours}h stimate, ~${workDays} giorni lavorativi).`,
      });
    },
  },
  {
    name: 'generate_quote',
    description: 'Genera un preventivo completo con AI. Crea le voci, i prezzi, la premessa personalizzata e lo salva come bozza nel gestionale. RICHIEDE CONFERMA UTENTE.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Nome del cliente' },
        company: { type: 'string', description: 'Nome azienda' },
        services: { type: 'string', description: 'Servizi richiesti (es. sito web, e-commerce, logo)' },
        budget: { type: 'string', description: 'Budget indicativo (es. 2000-3000€)' },
        website: { type: 'string', description: 'Sito web attuale del cliente (opzionale, per ricerca)' },
        notes: { type: 'string', description: 'Note aggiuntive, report, info sul cliente' },
      },
      required: ['client_name', 'services'],
    },
    execute: async (args) => {
      const { generateQuoteDraft } = await import('../quotes/generate');
      // Client identity (name, company, website) is kept as internal metadata
      // and never passed to the LLM prompt. Only services / budget / notes
      // (free-text, user's responsibility) reach the model.
      const internalMetadata: Record<string, string> = {};
      if (typeof args.client_name === 'string' && args.client_name) internalMetadata.client_name = args.client_name;
      if (typeof args.company === 'string' && args.company) internalMetadata.company = args.company;
      if (typeof args.website === 'string' && args.website) internalMetadata.website = args.website;

      const draft = await generateQuoteDraft({
        services: args.services as string,
        budget: args.budget as string | undefined,
        notes: args.notes as string | undefined,
        internal_metadata: Object.keys(internalMetadata).length ? internalMetadata : undefined,
      });

      return JSON.stringify({
        created: true,
        quote_id: draft.quote_id,
        title: draft.title,
        total: draft.total,
        subtotal: draft.subtotal,
        stamp_duty: draft.stamp_duty,
        items_count: draft.items.length,
        message: `Preventivo "${draft.title}" creato come bozza (€${draft.total}). Vai su /preventivi/${draft.quote_id} per revisione.`,
      });
    },
  },
  {
    name: 'summarize_week',
    description: 'Ottieni un riepilogo dell\'attività della settimana corrente',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
      const ws = weekStart.toISOString().split('T')[0];

      const [newLeads, signedQuotes, completedTasks, revenue] = await Promise.all([
        sql`SELECT COUNT(*)::int as count FROM leads WHERE created_at >= ${ws}`,
        sql`SELECT COUNT(*)::int as count FROM quotes_v2 WHERE signed_at >= ${ws}`,
        sql`SELECT COUNT(*)::int as count FROM project_tasks WHERE completed_at >= ${ws}`,
        sql`SELECT COALESCE(SUM(amount), 0) as total FROM payment_tracker WHERE status = 'pagata' AND paid_date >= ${ws}`,
      ]);

      return JSON.stringify({
        week_start: ws,
        new_leads: newLeads[0]?.count || 0,
        signed_quotes: signedQuotes[0]?.count || 0,
        completed_tasks: completedTasks[0]?.count || 0,
        revenue: parseFloat(revenue[0]?.total || '0'),
      });
    },
  },

  // ── Knowledge: Note ──
  {
    name: 'create_note',
    description: "Crea una nota nel Knowledge Base / Second Brain. Usalo quando l'utente vuole annotare qualcosa, salvare un'idea, registrare info, o prendere appunti.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titolo della nota' },
        content: { type: 'string', description: 'Contenuto in testo/markdown' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag opzionali' },
        linked_type: { type: 'string', enum: ['project', 'customer'], description: 'Tipo entità collegata (opzionale)' },
        linked_id: { type: 'string', description: 'ID entità collegata (opzionale)' },
      },
      required: ['title', 'content'],
    },
    execute: async (args: Record<string, unknown>) => {
      const [note] = await sql`
        INSERT INTO notes (title, raw_markdown, source, tags, linked_type, linked_id)
        VALUES (
          ${args.title as string},
          ${args.content as string},
          'agent',
          ${(args.tags as string[]) || []},
          ${(args.linked_type as string) || null},
          ${(args.linked_id as string) || null}
        ) RETURNING id, title
      `;
      return JSON.stringify({ created: true, note_id: note.id, title: note.title });
    },
  },
  {
    name: 'search_notes',
    description: 'Cerca tra le note del Knowledge Base per parola chiave o tag.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare' },
        tag: { type: 'string', description: 'Filtra per tag' },
      },
      required: [],
    },
    execute: async (args: Record<string, unknown>) => {
      const searchFilter = args.query
        ? sql`AND (title ILIKE ${'%' + args.query + '%'} OR raw_markdown ILIKE ${'%' + args.query + '%'})`
        : sql``;
      const tagFilter = args.tag ? sql`AND ${args.tag as string} = ANY(tags)` : sql``;
      const notes = await sql`
        SELECT id, title, LEFT(raw_markdown, 200) AS preview, tags, source, created_at
        FROM notes WHERE 1=1 ${searchFilter} ${tagFilter}
        ORDER BY updated_at DESC LIMIT 10
      `;
      return JSON.stringify({ count: notes.length, notes });
    },
  },

  // === EMAIL TOOLS ===
  {
    name: 'list_recent_emails',
    description: 'Elenca le email più recenti. Per default: sia ricevute (INBOX) sia inviate (Sent). Usa direction="received" per solo ricevute, "sent" per solo inviate.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Giorni indietro (default 3)' },
        limit: { type: 'number', description: 'Max risultati (default 15, max 50)' },
        direction: {
          type: 'string',
          enum: ['received', 'sent', 'both'],
          description: 'Filtra per direzione. Default: both (ricevute + inviate)',
        },
      },
    },
    execute: async (args) => {
      const days = Math.max(1, Math.min((args.days as number) || 3, 60));
      const limit = Math.max(1, Math.min((args.limit as number) || 15, 50));
      const direction = (args.direction as string) || 'both';

      let folderFilter;
      if (direction === 'received') {
        folderFilter = sql`AND m.folder = 'INBOX'`;
      } else if (direction === 'sent') {
        folderFilter = sql`AND m.folder = COALESCE(a.sent_folder, 'Sent')`;
      } else {
        folderFilter = sql`AND (m.folder = 'INBOX' OR m.folder = COALESCE(a.sent_folder, 'Sent'))`;
      }

      const rows = await sql`
        SELECT m.id, m.from_addr, m.from_name, m.subject, m.snippet, m.received_at,
               m.has_attachments, m.flags, m.folder, a.email AS account_email,
               CASE WHEN m.folder = 'INBOX' THEN 'received' ELSE 'sent' END AS direction
        FROM email_messages m
        JOIN email_accounts a ON a.id = m.account_id
        WHERE m.received_at > now() - (${days} || ' days')::interval
        ${folderFilter}
        ORDER BY m.received_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ count: rows.length, days, direction, emails: rows });
    },
  },
  {
    name: 'search_emails',
    description: 'Cerca nelle email per testo (oggetto, mittente, anteprima). Usa per "email da mario", "email su progetto X", ecc.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Testo da cercare in subject, from, snippet, body_text' },
        days: { type: 'number', description: 'Limite temporale in giorni (default 90)' },
        limit: { type: 'number', description: 'Max risultati (default 15)' },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const q = (args.query as string).trim();
      if (!q) return JSON.stringify({ error: 'query vuota' });
      const days = Math.max(1, Math.min((args.days as number) || 90, 365));
      const limit = Math.max(1, Math.min((args.limit as number) || 15, 30));
      const like = `%${q}%`;
      const rows = await sql`
        SELECT m.id, m.from_addr, m.from_name, m.subject, m.snippet, m.received_at, m.folder,
               a.email AS account_email
        FROM email_messages m
        JOIN email_accounts a ON a.id = m.account_id
        WHERE m.received_at > now() - (${days} || ' days')::interval
          AND (
            m.subject ILIKE ${like}
            OR m.from_addr ILIKE ${like}
            OR m.from_name ILIKE ${like}
            OR m.snippet ILIKE ${like}
            OR m.body_text ILIKE ${like}
          )
        ORDER BY m.received_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ count: rows.length, query: q, emails: rows });
    },
  },
  {
    name: 'read_email',
    description: 'Leggi il contenuto completo (testo + mittente + data) di una email specifica. Passa id email restituito da list_recent_emails o search_emails.',
    parameters: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'UUID email (id dalla lista)' },
      },
      required: ['email_id'],
    },
    execute: async (args) => {
      const id = args.email_id as string;
      const [msg] = await sql`
        SELECT m.id, m.from_addr, m.from_name, m.to_addrs, m.subject, m.received_at,
               m.body_text, m.has_attachments,
               a.email AS account_email,
               (
                 SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'filename', at.filename, 'content_type', at.content_type, 'size_bytes', at.size_bytes
                 )), '[]'::jsonb)
                 FROM email_attachments at WHERE at.message_id = m.id
               ) AS attachments
        FROM email_messages m
        JOIN email_accounts a ON a.id = m.account_id
        WHERE m.id = ${id}
        LIMIT 1
      `;
      if (!msg) return JSON.stringify({ error: 'Email non trovata' });
      // Truncate body to keep token usage sane
      const body = (msg.body_text as string | null) || '';
      return JSON.stringify({
        ...msg,
        body_text: body.slice(0, 4000),
        body_truncated: body.length > 4000,
      });
    },
  },
  {
    name: 'draft_email',
    description:
      'Crea una BOZZA email pronta da rivedere e inviare, anche con allegati (attachments: preferisci media_id). ' +
      'NON invia direttamente: restituisce un link che apre la finestra di invio pre-compilata con gli allegati. ' +
      'Usa SEMPRE questo tool quando l\'utente chiede di "scrivere/rispondere/inviare" una email. Se è una risposta, ' +
      'passa reply_to_email_id per mantenere il thread.',
    riskLevel: 'medium',
    parameters: {
      type: 'object',
      properties: {
        to: {
          description: 'Destinatari: stringa con indirizzi separati da virgola oppure array',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        cc: { description: 'CC opzionale (stringa o array)', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        subject: { type: 'string', description: 'Oggetto dell\'email.' },
        body: { type: 'string', description: 'Corpo del messaggio in testo semplice. Includi saluto e firma.' },
        reply_to_email_id: { type: 'string', description: 'Opzionale: UUID di una email esistente cui si sta rispondendo (per mantenere il thread).' },
        account_id: { type: 'string', description: 'UUID della casella mittente (default: la prima casella attiva)' },
        attachments: ATTACHMENTS_PARAM,
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const input = parseToolArgs('draft_email', args, z.object({
        to: addressListSchema.refine((l) => l.length > 0, 'almeno un destinatario'),
        cc: addressListSchema.optional(),
        subject: z.string().trim().min(1),
        body: z.string(),
        reply_to_email_id: z.string().uuid().optional(),
        account_id: z.string().uuid().optional(),
        attachments: z.array(attachmentInputSchema).optional(),
      }), TOOL_EMAIL_HINTS);
      // Allegati validati PRIMA di creare la bozza: un riferimento sbagliato non lascia bozze a metà.
      const attachments = await resolveAttachments(input.attachments ?? []);

      const { loadOutboundAccount } = await import('../mail/outbound');
      const { createDraft, resolveReplyTarget } = await import('../mail/drafts');
      // Single-user: la casella indicata o la prima attiva.
      const acc = await loadOutboundAccount(null, input.account_id);
      if (!acc) return JSON.stringify({ error: 'Nessun account email configurato. Configura prima la casella in /posta.' });

      const reply = await resolveReplyTarget(acc.user_id, input.reply_to_email_id);
      const draft = await createDraft({
        userId: acc.user_id,
        accountId: acc.id,
        to: input.to,
        cc: input.cc ?? [],
        subject: input.subject,
        body: input.body,
        ...reply,
        source: 'ai',
        attachments,
      });

      return JSON.stringify({
        status: 'drafted',
        draft_id: draft.id,
        open_url: `/posta?draft=${draft.id}`,
        attachments: attachments.map(describeAttachment),
        message: `Bozza creata${attachments.length ? ` con ${attachments.length} allegat${attachments.length === 1 ? 'o' : 'i'}` : ''}. Apri [questa bozza](/posta?draft=${draft.id}) per revisionare e inviare.`,
      });
    },
  },
  {
    name: 'emails_for_entity',
    description: 'Trova tutte le email linkate a un cliente/lead/progetto (match automatico per email o link manuale). Usa per "che email ho scambiato con Rossi", "email del progetto X".',
    parameters: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['cliente', 'lead', 'preventivo', 'progetto', 'collaboratore'] },
        entity_id: { type: 'string', description: 'UUID dell\'entità' },
        limit: { type: 'number', description: 'Max risultati (default 20)' },
      },
      required: ['entity_type', 'entity_id'],
    },
    execute: async (args) => {
      const entityType = args.entity_type as string;
      const entityId = args.entity_id as string;
      const limit = Math.max(1, Math.min((args.limit as number) || 20, 50));
      const rows = await sql`
        SELECT m.id, m.from_addr, m.from_name, m.subject, m.snippet, m.received_at,
               l.auto AS link_auto
        FROM email_links l
        JOIN email_messages m ON m.id = l.message_id
        WHERE l.entity_type = ${entityType} AND l.entity_id = ${entityId}
        ORDER BY m.received_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ count: rows.length, entity_type: entityType, emails: rows });
    },
  },

  // === CRM UPDATE TOOLS ===
  {
    name: 'update_customer',
    description: 'Aggiorna un cliente esistente (status, contatti, note, tag). RICHIEDE CONFERMA. Passa customer_id oppure customer_email.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'UUID cliente (preferito)' },
        customer_email: { type: 'string', description: 'Alternativa: email cliente' },
        contact_name: { type: 'string' },
        company_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        status: { type: 'string', description: 'Stato cliente (es: active, vip, churned, prospect)' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        billing_emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Destinatari amministrativi (fatture, rinnovi, solleciti), es. ["amministrazione@azienda.it", "titolare@gmail.com"]. Se vuoto si usa email. Sostituisce l\'elenco intero; [] lo svuota.',
        },
        billing_address: {
          type: 'object',
          description: 'Merge con i dati salvati (chiave a null = rimuovi):  street, postal_code, city, province, country, vat_number, fiscal_code, sdi_code, pec.',
          additionalProperties: true,
        },
      },
    },
    execute: async (args) => {
      let customerId = args.customer_id as string | undefined;
      if (!customerId && args.customer_email) {
        const [c] = await sql`SELECT id FROM customers WHERE email = ${(args.customer_email as string).toLowerCase().trim()} AND deleted_at IS NULL LIMIT 1`;
        if (!c) return JSON.stringify({ error: 'Cliente non trovato per email' });
        customerId = c.id as string;
      }
      if (!customerId) return JSON.stringify({ error: 'customer_id o customer_email richiesto' });

      const updates: Record<string, unknown> = {};
      if (args.contact_name !== undefined) updates.contact_name = args.contact_name;
      if (args.company_name !== undefined) updates.company_name = args.company_name;
      if (args.email !== undefined) updates.email = (args.email as string).toLowerCase().trim();
      if (args.phone !== undefined) updates.phone = args.phone;
      if (args.status !== undefined) updates.status = args.status;
      if (args.notes !== undefined) updates.notes = args.notes;
      // jsonb(): JSON.stringify produceva uno scalare stringa nella colonna jsonb.
      if (args.tags !== undefined) updates.tags = jsonb(args.tags as string[]);
      if (args.billing_emails !== undefined) {
        updates.billing_emails = parseToolArgs('update_customer', { billing_emails: args.billing_emails }, z.object({ billing_emails: billingEmailsSchema })).billing_emails;
      }
      const addressPatch = args.billing_address === undefined
        ? undefined
        : parseToolArgs('update_customer', { billing_address: args.billing_address }, z.object({ billing_address: z.record(z.unknown()) })).billing_address;
      updates.updated_at = new Date().toISOString();
      if (Object.keys(updates).length === 1 && addressPatch === undefined) return JSON.stringify({ error: 'Nessun campo da aggiornare' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx di postgres-js
      const row = await sql.begin(async (tx: any) => {
        if (addressPatch !== undefined) {
          const [current] = await tx`SELECT billing_address FROM customers WHERE id = ${customerId} AND deleted_at IS NULL FOR UPDATE`;
          if (!current) return null;
          // Merge (RFC 7396), come PUT /api/customers/:id: le chiavi non passate restano.
          updates.billing_address = jsonb(mergePatch(current.billing_address ?? {}, addressPatch));
        }
        const [updated] = await tx`UPDATE customers SET ${tx(updates)} WHERE id = ${customerId} AND deleted_at IS NULL RETURNING id, contact_name, company_name, email, billing_emails, billing_address, status`;
        return updated ?? null;
      });
      if (!row) return JSON.stringify({ error: 'Aggiornamento fallito' });
      return JSON.stringify({ updated: row });
    },
  },
  {
    name: 'update_project',
    description: 'Aggiorna un progetto cliente (status, titolo, date, budget, descrizione). RICHIEDE CONFERMA. Passa project_id oppure project_name per risolvere.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        project_name: { type: 'string', description: 'Alternativa: nome progetto' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'proposal', 'approved', 'in_progress', 'review', 'completed', 'on_hold', 'cancelled'] },
        priority: { type: 'number', description: '1 (urgente) - 5 (bassa)' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        target_end_date: { type: 'string', description: 'YYYY-MM-DD' },
        budget_amount: { type: 'number' },
        estimated_hours: { type: 'number' },
      },
    },
    execute: async (args) => {
      let projectId = args.project_id as string | undefined;
      if (!projectId && args.project_name) {
        const [p] = await sql`SELECT id FROM client_projects WHERE name ILIKE ${'%' + (args.project_name as string) + '%'} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`;
        if (!p) return JSON.stringify({ error: 'Progetto non trovato per nome' });
        projectId = p.id as string;
      }
      if (!projectId) return JSON.stringify({ error: 'project_id o project_name richiesto' });

      const updates: Record<string, unknown> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.description !== undefined) updates.description = args.description;
      if (args.status !== undefined) updates.status = args.status;
      if (args.priority !== undefined) updates.priority = args.priority;
      if (args.start_date !== undefined) updates.start_date = args.start_date;
      if (args.target_end_date !== undefined) updates.target_end_date = args.target_end_date;
      if (args.budget_amount !== undefined) updates.budget_amount = args.budget_amount;
      if (args.estimated_hours !== undefined) updates.estimated_hours = args.estimated_hours;
      updates.updated_at = new Date().toISOString();
      if (Object.keys(updates).length === 1) return JSON.stringify({ error: 'Nessun campo da aggiornare' });

      const [row] = await sql`UPDATE client_projects SET ${sql(updates)} WHERE id = ${projectId} AND deleted_at IS NULL RETURNING id, name, status`;
      if (!row) return JSON.stringify({ error: 'Aggiornamento fallito' });
      return JSON.stringify({ updated: row });
    },
  },
  {
    name: 'update_task',
    description: 'Aggiorna un task (status, titolo, scadenza, priorità). RICHIEDE CONFERMA. Passa task_id oppure task_title per risolvere.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        task_title: { type: 'string', description: 'Alternativa: titolo task (match ILIKE)' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done', 'blocked'] },
        priority: { type: 'number' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        estimated_hours: { type: 'number' },
      },
    },
    execute: async (args) => {
      let taskId = args.task_id as string | undefined;
      if (!taskId && args.task_title) {
        const [t] = await sql`SELECT id FROM project_tasks WHERE title ILIKE ${'%' + (args.task_title as string) + '%'} ORDER BY updated_at DESC LIMIT 1`;
        if (!t) return JSON.stringify({ error: 'Task non trovato per titolo' });
        taskId = t.id as string;
      }
      if (!taskId) return JSON.stringify({ error: 'task_id o task_title richiesto' });

      const updates: Record<string, unknown> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.status !== undefined) {
        updates.status = args.status;
        if (args.status === 'done') updates.completed_at = new Date().toISOString();
      }
      if (args.priority !== undefined) updates.priority = args.priority;
      if (args.due_date !== undefined) updates.due_date = args.due_date;
      if (args.estimated_hours !== undefined) updates.estimated_hours = args.estimated_hours;
      updates.updated_at = new Date().toISOString();
      if (Object.keys(updates).length === 1) return JSON.stringify({ error: 'Nessun campo da aggiornare' });

      const [row] = await sql`UPDATE project_tasks SET ${sql(updates)} WHERE id = ${taskId} RETURNING id, title, status`;
      if (!row) return JSON.stringify({ error: 'Aggiornamento fallito' });
      return JSON.stringify({ updated: row });
    },
  },

  // === APPUNTAMENTI — alias legacy sul motore live ===
  // Storicamente questi tool scrivevano sulla tabella morta cal_bookings
  // (Cal.com, read-only da migr. 069): i booking creati lì non generavano
  // eventi, email né promemoria. Ora sono alias 1:1 dei tool canonici
  // create_booking / reschedule_booking / cancel_booking / list_bookings.
  {
    name: 'create_cal_booking',
    description: 'Alias di create_booking: crea una prenotazione sul calendario live. Usa quando l\'utente dice "prendi appuntamento", "crea meeting", "fissa call". Invia email di conferma. RICHIEDE CONFERMA.',
    parameters: CREATE_BOOKING_PARAMS,
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: executeCreateBooking,
  },
  {
    name: 'update_cal_booking',
    description: 'Alias di reschedule_booking: sposta una prenotazione esistente a un nuovo orario (il vecchio slot viene liberato). Notifica il partecipante. RICHIEDE CONFERMA.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'UID pubblico del booking (accettato anche come booking_id)' },
        booking_id: { type: 'string', description: 'Sinonimo legacy di uid' },
        start: { type: 'string', description: 'Nuovo inizio ISO UTC (es. 2026-04-26T09:00:00Z)' },
        reason: { type: 'string', description: 'Motivo (opzionale)' },
        ...BOOKING_LOCATION_PROPS,
        notify: { type: 'boolean', description: 'Invia l\'email di spostamento al partecipante (default true)' },
      },
      required: ['start'],
    },
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: executeRescheduleBooking,
  },
  {
    name: 'cancel_cal_booking',
    description: 'Alias di cancel_booking: cancella una prenotazione per UID. Notifica il partecipante via email. RICHIEDE CONFERMA.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'UID pubblico del booking (accettato anche come booking_id)' },
        booking_id: { type: 'string', description: 'Sinonimo legacy di uid' },
        reason: { type: 'string', description: 'Motivo cancellazione (opzionale)' },
      },
    },
    riskLevel: 'high',
    requiresConfirmation: true,
    execute: executeCancelBooking,
  },
  {
    name: 'list_cal_bookings',
    description: 'Alias di list_bookings: elenca le prenotazioni del calendario live con filtri per stato e date.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['confirmed', 'pending', 'cancelled', 'completed', 'no_show', 'all'], description: 'Filtra per stato (default: confirmed)' },
        from_date: { type: 'string', description: 'YYYY-MM-DD: solo bookings con start >= questa data' },
        to_date: { type: 'string', description: 'YYYY-MM-DD: solo bookings con start <= questa data' },
        limit: { type: 'number' },
      },
    },
    riskLevel: 'low',
    execute: executeListBookings,
  },

  // === IDEE (wrapper su notes con tag='idea') ===
  {
    name: 'create_idea',
    description: "Salva un'idea nel Knowledge Base (tag 'idea'). Usa quando l'utente dice \"segna un'idea\", \"crea idea\", \"appunta: ...\". RICHIEDE CONFERMA.",
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "Titolo breve dell'idea" },
        content: { type: 'string', description: 'Descrizione / contenuto markdown' },
        extra_tags: { type: 'array', items: { type: 'string' }, description: "Tag aggiuntivi oltre 'idea'" },
        linked_type: { type: 'string', enum: ['project', 'customer'] },
        linked_id: { type: 'string' },
      },
      required: ['title', 'content'],
    },
    execute: async (args) => {
      const tags = ['idea', ...(((args.extra_tags as string[]) || []).filter((t) => t && t !== 'idea'))];
      const [note] = await sql`
        INSERT INTO notes (title, raw_markdown, source, tags, linked_type, linked_id)
        VALUES (
          ${args.title as string},
          ${args.content as string},
          'agent',
          ${tags},
          ${(args.linked_type as string) || null},
          ${(args.linked_id as string) || null}
        ) RETURNING id, title, tags
      `;
      return JSON.stringify({ created: true, note_id: note.id, title: note.title, tags: note.tags });
    },
  },
  {
    name: 'list_ideas',
    description: "Elenca le idee salvate (note con tag 'idea'). Filtra opzionalmente per parola chiave.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filtro di testo su titolo/contenuto' },
        limit: { type: 'number' },
      },
    },
    execute: async (args) => {
      const limit = Math.max(1, Math.min((args.limit as number) || 20, 50));
      const searchFilter = args.query
        ? sql`AND (title ILIKE ${'%' + (args.query as string) + '%'} OR raw_markdown ILIKE ${'%' + (args.query as string) + '%'})`
        : sql``;
      const rows = await sql`
        SELECT id, title, LEFT(raw_markdown, 200) AS preview, tags, linked_type, linked_id, created_at
        FROM notes
        WHERE 'idea' = ANY(tags) ${searchFilter}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ count: rows.length, ideas: rows });
    },
  },

  // ============================================
  // CALENDAR / BOOKING (cal.diy self-hosted)
  // ============================================
  {
    name: 'list_event_types',
    description: 'Lista delle tipologie di prenotazione disponibili (consulenza, sopralluogo, ecc.)',
    parameters: { type: 'object', properties: {} },
    riskLevel: 'low',
    execute: async () => {
      const rows = await sql`
        SELECT slug, title, description, duration_minutes, location_type, color, is_active, is_public
        FROM calendar_event_types
        ORDER BY sort_order ASC, title ASC
      `;
      return JSON.stringify({ count: rows.length, event_types: rows });
    },
  },
  {
    name: 'get_calendar_availability',
    description: 'Calcola gli slot disponibili per un event type in un range di date (date locali Europe/Rome)',
    parameters: {
      type: 'object',
      properties: {
        event_type_slug: { type: 'string', description: 'Slug dell\'event type (es. consulenza-gratuita-30min)' },
        from_date: { type: 'string', description: 'Data inizio YYYY-MM-DD' },
        to_date: { type: 'string', description: 'Data fine YYYY-MM-DD (max 60 giorni dopo from_date)' },
      },
      required: ['event_type_slug', 'from_date', 'to_date'],
    },
    riskLevel: 'low',
    execute: async (args) => {
      const { computeAvailableSlots } = await import('../calendar/slots');
      const result = await computeAvailableSlots({
        eventTypeIdOrSlug: args.event_type_slug as string,
        fromDateLocal: args.from_date as string,
        toDateLocal: args.to_date as string,
        onlyPublic: false,
      });
      if (!result) return JSON.stringify({ error: 'Event type non trovato' });
      return JSON.stringify({
        timezone: result.timezone,
        duration_minutes: result.eventType.duration_minutes,
        slots_count: result.slots.length,
        slots_by_date: result.slotsByDate,
      });
    },
  },
  {
    name: 'list_bookings',
    description: 'Lista delle prenotazioni con filtri opzionali per stato e date',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['confirmed', 'pending', 'cancelled', 'completed', 'no_show', 'all'], description: 'Filtra per stato (default: confirmed)' },
        from_date: { type: 'string', description: 'YYYY-MM-DD: solo bookings con start >= questa data' },
        to_date: { type: 'string', description: 'YYYY-MM-DD: solo bookings con start <= questa data' },
        limit: { type: 'number' },
      },
    },
    riskLevel: 'low',
    execute: executeListBookings,
  },
  {
    name: 'create_booking',
    description: 'Crea una nuova prenotazione manuale per conto di un partecipante. Invia email di conferma.',
    parameters: CREATE_BOOKING_PARAMS,
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: executeCreateBooking,
  },
  {
    name: 'reschedule_booking',
    description: 'Sposta una prenotazione esistente a un nuovo orario (il vecchio slot viene liberato). Notifica il partecipante via email. Il link della videocall scelto per la prenotazione (es. MEGA) viene mantenuto; passa meeting_url per cambiarlo nello stesso passaggio, così l\'email contiene già il link giusto.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'UID pubblico del booking' },
        start: { type: 'string', description: 'Nuovo inizio ISO UTC (es. 2026-04-26T09:00:00Z)' },
        reason: { type: 'string', description: 'Motivo (opzionale, mostrato al partecipante)' },
        ...BOOKING_LOCATION_PROPS,
        notify: { type: 'boolean', description: 'Invia l\'email di spostamento al partecipante (default true)' },
      },
      required: ['uid', 'start'],
    },
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: executeRescheduleBooking,
  },
  {
    name: 'update_booking_location',
    description: 'Cambia il link della videocall (MEGA, Zoom, Google Meet, Teams...) o il luogo di una prenotazione senza spostarla. Il nuovo link vale anche per email, calendario e riprogrammazioni future. Di default non invia email: notify=true reinvia al partecipante la conferma con il nuovo link.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'UID pubblico del booking' },
        ...BOOKING_LOCATION_PROPS,
        notify: { type: 'boolean', description: 'Reinvia la conferma al partecipante con il nuovo link (default false)' },
      },
      required: ['uid'],
    },
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: executeUpdateBookingLocation,
  },
  {
    name: 'cancel_booking',
    description: 'Cancella una prenotazione esistente per UID. Notifica il partecipante via email.',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'UID pubblico del booking' },
        reason: { type: 'string', description: 'Motivo (opzionale, mostrato al partecipante)' },
      },
      required: ['uid'],
    },
    riskLevel: 'high',
    requiresConfirmation: true,
    execute: executeCancelBooking,
  },

  // ============================================
  // CALDES CALENDAR — eventi multi-calendario
  // ============================================
  {
    name: 'list_calendars',
    description: 'Lista tutti i calendari self-hosted (Lavoro, Personale, Bookings, Scadenze, ecc.) con colore, conteggio eventi, ICS feed URL.',
    parameters: { type: 'object', properties: {} },
    riskLevel: 'low',
    execute: async () => {
      const { listCalendars, buildFeedUrl, countEventsByCalendar } = await import('../calendar/calendars');
      const calendars = await listCalendars();
      // event_count con la semantica legacy (non cancellati, override compresi) dallo store del calendario.
      const countMap = await countEventsByCalendar();
      return JSON.stringify({
        count: calendars.length,
        calendars: calendars.map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          color: c.color,
          timezone: c.timezone,
          is_default: c.is_default,
          is_system: c.is_system,
          event_count: countMap.get(c.id) || 0,
          ics_feed_url: c.ics_feed_enabled ? buildFeedUrl(c) : null,
        })),
      });
    },
  },
  {
    name: 'list_events',
    description: 'Lista eventi calendario in un range di date, con espansione automatica delle ricorrenze. Filtra opzionalmente per calendario specifico (slug o id).',
    parameters: {
      type: 'object',
      properties: {
        calendar: { type: 'string', description: 'Slug o id calendario (es. "lavoro"). Omettere per tutti i calendari.' },
        from: { type: 'string', description: 'ISO datetime inizio (es. 2026-04-26T00:00:00Z)' },
        to: { type: 'string', description: 'ISO datetime fine. Max 366 giorni dopo from.' },
      },
      required: ['from', 'to'],
    },
    riskLevel: 'low',
    execute: async (args) => {
      const { listOccurrences } = await import('../calendar/events');
      const { getCalendar } = await import('../calendar/calendars');
      let calendarId: string | undefined;
      if (args.calendar) {
        const cal = await getCalendar(args.calendar as string);
        if (!cal) return JSON.stringify({ error: 'Calendario non trovato' });
        calendarId = cal.id;
      }
      const occurrences = await listOccurrences({
        calendarId,
        fromIso: args.from as string,
        toIso: args.to as string,
      });
      // Store Radicale: descrizione delle proiezioni ricomposta da calendar_bookings (stesso testo di oggi).
      const { withProjectionDescriptions } = await import('../calendar/projection-descriptions');
      const events = await withProjectionDescriptions(occurrences);
      return JSON.stringify({ count: events.length, events });
    },
  },
  {
    name: 'get_events_for_today',
    description: 'Helper rapido: ritorna gli eventi del giorno corrente per un calendario (o tutti). Usa il timezone Europe/Rome per "today".',
    parameters: {
      type: 'object',
      properties: {
        calendar: { type: 'string', description: 'Slug calendario (opzionale)' },
      },
    },
    riskLevel: 'low',
    execute: async (args) => {
      const { listOccurrences } = await import('../calendar/events');
      const { getCalendar } = await import('../calendar/calendars');
      const { date, fromIso, toIso } = romeDayWindow();
      let calendarId: string | undefined;
      if (args.calendar) {
        const cal = await getCalendar(args.calendar as string);
        if (cal) calendarId = cal.id;
      }
      const occ = await listOccurrences({ calendarId, fromIso, toIso });
      return JSON.stringify({
        date,
        count: occ.length,
        events: occ.map((e) => ({
          summary: e.summary,
          start: e.start_time,
          end: e.end_time,
          location: e.location,
          url: e.url,
        })),
      });
    },
  },
  {
    name: 'find_free_slots',
    description: 'Trova finestre libere (no eventi confermati) in un calendario tra due date di durata minima specificata. Utile per proporre orari per nuovi appuntamenti.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime inizio finestra di ricerca' },
        to: { type: 'string', description: 'ISO datetime fine' },
        duration_minutes: { type: 'number', description: 'Durata minima slot libero in minuti' },
        working_hours_start: { type: 'string', description: 'Ora inizio giornata lavorativa (HH:MM, default 09:00)' },
        working_hours_end: { type: 'string', description: 'Ora fine giornata lavorativa (HH:MM, default 18:00)' },
      },
      required: ['from', 'to', 'duration_minutes'],
    },
    riskLevel: 'low',
    execute: async (args) => {
      const { getBusyRanges } = await import('../calendar/events');
      const fromIso = args.from as string;
      const toIso = args.to as string;
      const durationMs = (args.duration_minutes as number) * 60_000;
      const whStart = (args.working_hours_start as string) || '09:00';
      const whEnd = (args.working_hours_end as string) || '18:00';
      const [whSh, whSm] = whStart.split(':').map(Number);
      const [whEh, whEm] = whEnd.split(':').map(Number);

      const busy = await getBusyRanges(fromIso, toIso);
      const busyMs = busy.map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
        .sort((a, b) => a.start - b.start);

      // Genera giornate lavorative nel range
      const free: { start: string; end: string }[] = [];
      const cursor = new Date(fromIso);
      const end = new Date(toIso);
      while (cursor < end) {
        // Skip weekend
        if (cursor.getDay() === 0 || cursor.getDay() === 6) {
          cursor.setDate(cursor.getDate() + 1);
          cursor.setHours(0, 0, 0, 0);
          continue;
        }
        const dayStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), whSh, whSm).getTime();
        const dayEnd = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), whEh, whEm).getTime();

        let t = Math.max(dayStart, new Date(fromIso).getTime());
        for (const b of busyMs) {
          if (b.end <= t || b.start >= dayEnd) continue;
          if (b.start - t >= durationMs) {
            free.push({ start: new Date(t).toISOString(), end: new Date(b.start).toISOString() });
          }
          t = Math.max(t, b.end);
        }
        if (dayEnd - t >= durationMs) {
          free.push({ start: new Date(t).toISOString(), end: new Date(dayEnd).toISOString() });
        }

        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(0, 0, 0, 0);
      }

      return JSON.stringify({ count: free.length, free_slots: free.slice(0, 50) });
    },
  },
  {
    name: 'create_event',
    description: 'Crea un nuovo evento calendario. Supporta ricorrenze RRULE (es. FREQ=WEEKLY;BYDAY=MO,WE per lun/mer settimanali).',
    parameters: {
      type: 'object',
      properties: {
        calendar: { type: 'string', description: 'Slug o id calendario destinazione (es. "lavoro")' },
        summary: { type: 'string', description: 'Titolo evento' },
        description: { type: 'string' },
        location: { type: 'string' },
        url: { type: 'string', description: 'Link meeting (Meet/Zoom)' },
        start: { type: 'string', description: 'ISO datetime inizio (es. 2026-04-26T09:00:00Z)' },
        end: { type: 'string', description: 'ISO datetime fine' },
        all_day: { type: 'boolean' },
        rrule: { type: 'string', description: 'RFC 5545 RRULE senza prefisso (es. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10")' },
      },
      required: ['calendar', 'summary', 'start', 'end'],
    },
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: async (args) => {
      const { createEvent, EventValidationError } = await import('../calendar/events');
      const { getCalendar, listCalendars } = await import('../calendar/calendars');
      try {
        // Risolvi il calendario per slug/id e, in fallback, per NOME (esatto o
        // contenuto, case-insensitive). Prima accettava solo slug/id: passando
        // il nome (es. "Creattivamente SRL") falliva in silenzio e la chat lo
        // riportava come successo. Ora l'errore è esplicito e lista le opzioni.
        const needle = String(args.calendar || '').trim().toLowerCase();
        let cal = await getCalendar(args.calendar as string);
        if (!cal && needle) {
          const all = await listCalendars();
          cal = all.find((c) => c.name.toLowerCase() === needle)
            || all.find((c) => c.name.toLowerCase().includes(needle))
            || null;
        }
        if (!cal) {
          const opts = (await listCalendars()).map((c) => `${c.name} (slug: ${c.slug})`).join(', ');
          return JSON.stringify({ error: `ERRORE: calendario "${args.calendar}" non trovato — evento NON creato. Calendari disponibili: ${opts}` });
        }
        const ev = await createEvent({
          calendar_id: cal.id,
          summary: args.summary as string,
          description: (args.description as string) || null,
          location: (args.location as string) || null,
          url: (args.url as string) || null,
          start_time: args.start as string,
          end_time: args.end as string,
          all_day: !!args.all_day,
          rrule: (args.rrule as string) || null,
          source: 'mcp',
        });
        return JSON.stringify({ success: true, event: { uid: ev.uid, id: ev.id, summary: ev.summary, start: ev.start_time, end: ev.end_time } });
      } catch (err) {
        if (err instanceof EventValidationError) return JSON.stringify({ error: err.message });
        return JSON.stringify({ error: err instanceof Error ? err.message : 'Errore creazione evento' });
      }
    },
  },
  {
    name: 'create_calendar',
    description: 'Crea un nuovo calendario. Imposta blocks_availability=true se gli eventi del calendario devono bloccare la disponibilità per le prenotazioni (es. festività, ferie).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome del calendario (es. "Festività")' },
        slug: { type: 'string', description: 'Slug opzionale (a-z, 0-9, -). Se assente viene derivato dal nome.' },
        color: { type: 'string', description: 'Colore hex (es. #ef4444). Default viola.' },
        blocks_availability: { type: 'boolean', description: 'Se true gli eventi bloccano le prenotazioni. Default true.' },
        timezone: { type: 'string', description: 'IANA timezone. Default Europe/Rome.' },
      },
      required: ['name'],
    },
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: async (args) => {
      const { createCalendar, CalendarValidationError, CalendarConflictError } = await import('../calendar/calendars');
      const name = String(args.name || '').trim();
      if (!name) return JSON.stringify({ error: 'ERRORE: nome richiesto — calendario NON creato.' });
      const slug = (String(args.slug || name).toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)) || 'calendario';
      try {
        const cal = await createCalendar({
          slug,
          name,
          color: typeof args.color === 'string' && /^#[0-9a-f]{6}$/i.test(args.color) ? args.color : '#7c3aed',
          timezone: (args.timezone as string) || 'Europe/Rome',
          blocks_availability: args.blocks_availability !== false,
        });
        return JSON.stringify({ success: true, calendar: { id: cal.id, slug: cal.slug, name: cal.name } });
      } catch (err) {
        if (err instanceof CalendarValidationError || err instanceof CalendarConflictError) {
          return JSON.stringify({ error: `ERRORE: ${err.message} — calendario NON creato.` });
        }
        if ((err as { code?: string }).code === '23505') {
          return JSON.stringify({ error: `ERRORE: slug "${slug}" già in uso — calendario NON creato. Scegli un nome/slug diverso.` });
        }
        return JSON.stringify({ error: `ERRORE: ${err instanceof Error ? err.message : 'creazione fallita'} — calendario NON creato.` });
      }
    },
  },
  {
    name: 'update_event',
    description: 'Sposta o modifica un evento esistente (per id o uid). Per ricorrenti: questa modifica si applica al MASTER e quindi a tutte le occorrenze future. Per modificare singola occorrenza usa "create_event_exception".',
    parameters: {
      type: 'object',
      properties: {
        id_or_uid: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        url: { type: 'string' },
        start: { type: 'string', description: 'ISO datetime nuovo inizio' },
        end: { type: 'string', description: 'ISO datetime nuova fine' },
        rrule: { type: 'string', description: 'Nuova RRULE (vuota = rimuove ricorrenza)' },
        status: { type: 'string', enum: ['confirmed', 'tentative', 'cancelled'] },
      },
      required: ['id_or_uid'],
    },
    riskLevel: 'medium',
    requiresConfirmation: true,
    execute: async (args) => {
      const { updateEvent, getEvent, EventValidationError } = await import('../calendar/events');
      try {
        const existing = await getEvent(args.id_or_uid as string);
        if (!existing) return JSON.stringify({ error: 'Evento non trovato' });
        const updated = await updateEvent(existing.id, {
          summary: args.summary as string | undefined,
          description: args.description as string | null | undefined,
          location: args.location as string | null | undefined,
          url: args.url as string | null | undefined,
          start_time: args.start as string | undefined,
          end_time: args.end as string | undefined,
          rrule: args.rrule === undefined ? undefined : (args.rrule as string | null),
          status: args.status as 'confirmed' | 'tentative' | 'cancelled' | undefined,
        });
        // Proiezioni con lo store Radicale: descrizione ricomposta, salvo che la chiamata ne abbia scritta una.
        const { withProjectionDescription } = await import('../calendar/projection-descriptions');
        const ev = args.description === undefined ? await withProjectionDescription(updated) : updated;
        return JSON.stringify({ success: true, event: ev });
      } catch (err) {
        if (err instanceof EventValidationError) return JSON.stringify({ error: err.message });
        return JSON.stringify({ error: err instanceof Error ? err.message : 'Errore' });
      }
    },
  },
  {
    name: 'delete_event',
    description: 'Cancella un evento. Per ricorrenti, cancella tutta la serie. Per cancellare singola occorrenza usa "create_event_exception" con status=cancelled.',
    parameters: {
      type: 'object',
      properties: {
        id_or_uid: { type: 'string' },
      },
      required: ['id_or_uid'],
    },
    riskLevel: 'high',
    requiresConfirmation: true,
    execute: async (args) => {
      const { deleteEvent, getEvent, EventReadOnlyError } = await import('../calendar/events');
      const existing = await getEvent(args.id_or_uid as string);
      if (!existing) return JSON.stringify({ error: 'Evento non trovato' });
      try {
        const ok = await deleteEvent(existing.id);
        return JSON.stringify({ success: ok });
      } catch (err) {
        if (err instanceof EventReadOnlyError) return JSON.stringify({ error: err.message });
        throw err;
      }
    },
  },

  // ─── ANALYTICS (cookieless internal tracker) ────────────────────────────────

  {
    name: 'get_traffic_summary',
    description: 'KPI overview del traffico del sito: pageviews, visitatori unici, sessioni, bounce rate, durata media. Periodo: 24h | 7d | 30d | 90d | 12m (default 30d).',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const [row] = await sql`
        WITH base AS (
          SELECT session_id, visit_id, event_type, duration_ms
          FROM analytics
          WHERE website_id = 'main' AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
        ),
        visits AS (
          SELECT visit_id, COUNT(*) FILTER (WHERE event_type='pageview') AS pv, SUM(duration_ms) AS dur
          FROM base WHERE visit_id IS NOT NULL GROUP BY visit_id
        )
        SELECT
          (SELECT COUNT(*) FROM base WHERE event_type='pageview')::int AS pageviews,
          (SELECT COUNT(DISTINCT session_id) FROM base WHERE session_id IS NOT NULL)::int AS visitors,
          (SELECT COUNT(*) FROM visits)::int AS sessions,
          COALESCE(ROUND(100.0*(SELECT COUNT(*) FROM visits WHERE pv<=1)/NULLIF((SELECT COUNT(*) FROM visits),0),1),0)::float AS bounce_rate,
          COALESCE(ROUND(AVG(dur) FILTER (WHERE dur>0)),0)::int AS avg_duration_ms
        FROM visits
      `;
      return JSON.stringify({ period: args.period || '30d', ...(row || { pageviews: 0, visitors: 0, sessions: 0, bounce_rate: 0, avg_duration_ms: 0 }) });
    },
  },

  {
    name: 'get_top_pages',
    description: 'Top pagine per pageviews. Restituisce path, pageviews, visitatori unici, sessioni.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
        limit: { type: 'number', description: 'Default 10, max 50' },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);
      const rows = await sql`
        SELECT page_path AS path,
          COUNT(*)::int AS pageviews,
          COUNT(DISTINCT session_id)::int AS visitors,
          COUNT(DISTINCT visit_id)::int AS sessions
        FROM analytics
        WHERE website_id = 'main'
          AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
          AND event_type = 'pageview'
          AND page_path IS NOT NULL
        GROUP BY page_path
        ORDER BY pageviews DESC
        LIMIT ${limit}
      `;
      return JSON.stringify({ period: args.period || '30d', pages: rows });
    },
  },

  {
    name: 'get_traffic_sources',
    description: 'Sorgenti di traffico: referrer domain, UTM source, UTM medium o UTM campaign. Specifica `kind` per scegliere.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
        kind: { type: 'string', enum: ['referrer', 'utm_source', 'utm_medium', 'utm_campaign'], description: 'Dimensione (default referrer)' },
        limit: { type: 'number' },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const kindMap: Record<string, string> = {
        referrer: 'referrer_domain',
        utm_source: 'utm_source',
        utm_medium: 'utm_medium',
        utm_campaign: 'utm_campaign',
      };
      const col = kindMap[(args.kind as string) || 'referrer'] || 'referrer_domain';
      const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);
      const rows = await sql`
        SELECT ${sql(col)} AS source,
          COUNT(*)::int AS pageviews,
          COUNT(DISTINCT session_id)::int AS visitors
        FROM analytics
        WHERE website_id = 'main'
          AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
          AND event_type = 'pageview'
        GROUP BY ${sql(col)}
        ORDER BY pageviews DESC NULLS LAST
        LIMIT ${limit}
      `;
      return JSON.stringify({ period: args.period || '30d', kind: args.kind || 'referrer', sources: rows });
    },
  },

  {
    name: 'get_realtime_visitors',
    description: 'Visitatori attivi sul sito negli ultimi 5 minuti + top 5 pagine attive + ultimi eventi.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const [visitors] = await sql`SELECT COUNT(DISTINCT visit_id)::int AS c FROM analytics WHERE website_id='main' AND created_at >= NOW() - INTERVAL '5 minutes' AND visit_id IS NOT NULL`;
      const topPages = await sql`
        SELECT page_path AS path, COUNT(DISTINCT visit_id)::int AS visitors
        FROM analytics
        WHERE website_id='main' AND event_type='pageview'
          AND created_at >= NOW() - INTERVAL '5 minutes' AND page_path IS NOT NULL
        GROUP BY page_path ORDER BY visitors DESC LIMIT 5
      `;
      const recentEvents = await sql`
        SELECT event_type AS type, event_name, page_path AS page, country, created_at
        FROM analytics
        WHERE website_id='main' AND created_at >= NOW() - INTERVAL '5 minutes'
        ORDER BY created_at DESC LIMIT 10
      `;
      return JSON.stringify({ visitorsNow: visitors?.c ?? 0, topPages, recentEvents });
    },
  },

  {
    name: 'get_web_vitals',
    description: 'Core Web Vitals (LCP, CLS, INP, FCP, TTFB) p75 e p95 dal browser dei visitatori, con rating.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
        page: { type: 'string', description: 'Path opzionale per filtrare a una pagina specifica' },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const pageFilter = args.page ? sql`AND page_path = ${args.page as string}` : sql``;
      const rows = await sql`
        SELECT event_name AS metric, COUNT(*)::int AS count,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY event_value) AS p75,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY event_value) AS p95
        FROM analytics
        WHERE website_id='main' AND event_type='web_vital' AND event_value IS NOT NULL
          AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
          ${pageFilter}
        GROUP BY event_name ORDER BY metric
      ` as Array<{ metric: string; count: number; p75: number; p95: number }>;
      const thresholds: Record<string, { good: number; poor: number }> = {
        LCP: { good: 2500, poor: 4000 }, INP: { good: 200, poor: 500 },
        CLS: { good: 0.1, poor: 0.25 }, FCP: { good: 1800, poor: 3000 },
        TTFB: { good: 800, poor: 1800 },
      };
      const enriched = rows.map((m) => {
        const t = thresholds[m.metric];
        const rating = t ? (m.p75 <= t.good ? 'good' : m.p75 <= t.poor ? 'needs_improvement' : 'poor') : 'unknown';
        return { ...m, rating };
      });
      return JSON.stringify({ period: args.period || '30d', metrics: enriched });
    },
  },

  {
    name: 'get_goal_conversions',
    description: 'Lista i goal di analytics con il numero di conversioni nel periodo richiesto.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const goals = await sql`SELECT id, name, type, conditions, active FROM analytics_goals WHERE active = TRUE ORDER BY created_at DESC` as Array<{
        id: string; name: string; type: string; conditions: { path?: string; event_name?: string }; active: boolean;
      }>;
      const out = await Promise.all(goals.map(async (g) => {
        let count = 0;
        if (g.type === 'pageview' && g.conditions?.path) {
          const [r] = await sql`SELECT COUNT(DISTINCT session_id)::int AS c FROM analytics WHERE website_id='main' AND event_type='pageview' AND page_path=${g.conditions.path} AND created_at >= NOW() - CAST(${interval} AS INTERVAL)`;
          count = r?.c ?? 0;
        } else if (g.type === 'event' && g.conditions?.event_name) {
          const [r] = await sql`SELECT COUNT(DISTINCT session_id)::int AS c FROM analytics WHERE website_id='main' AND event_type='event' AND event_name=${g.conditions.event_name} AND created_at >= NOW() - CAST(${interval} AS INTERVAL)`;
          count = r?.c ?? 0;
        }
        return { name: g.name, type: g.type, conversions: count };
      }));
      return JSON.stringify({ period: args.period || '30d', goals: out });
    },
  },

  {
    name: 'get_traffic_geo',
    description: 'Breakdown geografico del traffico: top paesi con pageviews e visitatori unici.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['24h', '7d', '30d', '90d', '12m'] },
        limit: { type: 'number' },
      },
    },
    execute: async (args) => {
      const periodMap: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '1 year' };
      const interval = periodMap[(args.period as string) || '30d'] || '30 days';
      const limit = Math.min(Math.max((args.limit as number) || 15, 1), 50);
      const rows = await sql`
        SELECT country, COUNT(*)::int AS pageviews, COUNT(DISTINCT session_id)::int AS visitors
        FROM analytics
        WHERE website_id='main' AND event_type='pageview' AND country IS NOT NULL
          AND created_at >= NOW() - CAST(${interval} AS INTERVAL)
        GROUP BY country ORDER BY pageviews DESC LIMIT ${limit}
      `;
      return JSON.stringify({ period: args.period || '30d', countries: rows });
    },
  },

  // === LAVORI ESTERNI + LEDGER INCASSI/SPESE NON TRACCIATI ===
  {
    name: 'create_external_project',
    description: 'Crea un lavoro esterno (senza preventivo), già in stato "in_progress". Per progetti off-platform, referral o pagamenti diretti. Passa customer_id oppure customer_email, oppure ometti entrambi per progetti senza cliente in CRM.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'UUID cliente (opzionale)' },
        customer_email: { type: 'string', description: 'Alternativa: email cliente da cui risalire all\'id' },
        name: { type: 'string', description: 'Nome del progetto' },
        description: { type: 'string' },
        project_type: {
          type: 'string',
          enum: ['website', 'landing_page', 'ecommerce', 'maintenance', 'website_template', 'consulting', 'other'],
          description: 'Default: other',
        },
        budget_amount: { type: 'number', description: 'Budget atteso in euro (opzionale)' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        target_end_date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['name'],
    },
    execute: async (args) => {
      let customerId = args.customer_id as string | undefined;
      if (!customerId && args.customer_email) {
        const [c] = await sql`SELECT id FROM customers WHERE email = ${(args.customer_email as string).toLowerCase().trim()} AND deleted_at IS NULL LIMIT 1`;
        if (c) customerId = c.id as string;
      }
      const [row] = await sql`
        INSERT INTO client_projects (
          customer_id, name, description, project_type, status,
          budget_amount, start_date, target_end_date
        ) VALUES (
          ${customerId || null},
          ${args.name as string},
          ${(args.description as string) || null},
          ${(args.project_type as string) || 'other'}::project_type,
          'in_progress'::project_status,
          ${(args.budget_amount as number) || null},
          ${(args.start_date as string) || null},
          ${(args.target_end_date as string) || null}
        )
        RETURNING id, name, status, customer_id
      `;
      return JSON.stringify({ created: row, external: true });
    },
  },
  {
    name: 'log_untracked_income',
    description: 'Registra un incasso non tracciato (PayPal manuale, contanti, bonifico fuori-flusso). Confluisce nel widget revenue. Specifica project_id (preferito) o customer_id; descrivi il pagamento.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID progetto (opzionale)' },
        customer_id: { type: 'string', description: 'UUID cliente (opzionale)' },
        customer_email: { type: 'string', description: 'Alternativa per risolvere customer_id' },
        amount: { type: 'number', description: 'Importo in euro (>0)' },
        payment_method: {
          type: 'string',
          enum: ['bank_transfer', 'cash', 'check', 'paypal', 'stripe', 'revolut', 'other'],
          description: 'Metodo: bonifico, contanti, assegno, paypal, stripe, revolut, altro',
        },
        description: { type: 'string', description: 'Es. "Acconto lavoro X"' },
        paid_date: { type: 'string', description: 'YYYY-MM-DD (default: oggi)' },
        external_ref: { type: 'string', description: 'Riferimento (txn ID PayPal, n. bonifico, ecc.)' },
        notes: { type: 'string' },
      },
      required: ['amount', 'description'],
    },
    execute: async (args) => {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return JSON.stringify({ error: 'amount non valido (>0 richiesto)' });
      }
      let customerId = args.customer_id as string | undefined;
      if (!customerId && args.customer_email) {
        const [c] = await sql`SELECT id FROM customers WHERE email = ${(args.customer_email as string).toLowerCase().trim()} AND deleted_at IS NULL LIMIT 1`;
        if (c) customerId = c.id as string;
      }
      const paidDate = (args.paid_date as string) || new Date().toISOString().slice(0, 10);
      const status = 'pagata';
      const [row] = await sql`
        INSERT INTO payment_tracker (
          customer_id, project_id, description, amount, status,
          paid_date, paid_amount, payment_method, external_ref, notes
        ) VALUES (
          ${customerId || null},
          ${(args.project_id as string) || null},
          ${args.description as string},
          ${amount},
          ${status},
          ${paidDate},
          ${amount},
          ${(args.payment_method as string) || null},
          ${(args.external_ref as string) || null},
          ${(args.notes as string) || null}
        )
        RETURNING id, description, amount, payment_method, paid_date, status
      `;
      return JSON.stringify({ logged: row });
    },
  },
  {
    name: 'log_untracked_expense',
    description: 'Registra una spesa relativa a un progetto (contanti, PayPal, bonifico). Confluisce nel widget spese e nelle deduzioni fiscali.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID progetto (opzionale)' },
        customer_id: { type: 'string', description: 'UUID cliente (opzionale)' },
        amount: { type: 'number', description: 'Importo in euro (>=0)' },
        vat_amount: { type: 'number', description: 'IVA in euro (default 0)' },
        category: {
          type: 'string',
          enum: ['software', 'hardware', 'office', 'travel', 'meals', 'training', 'marketing', 'professional_services', 'utilities', 'other'],
        },
        payment_method: {
          type: 'string',
          enum: ['bank_transfer', 'cash', 'check', 'paypal', 'stripe', 'revolut', 'other'],
        },
        vendor: { type: 'string', description: 'Fornitore' },
        occurred_on: { type: 'string', description: 'YYYY-MM-DD (default: oggi)' },
        description: { type: 'string' },
        notes: { type: 'string' },
        deductible_percent: { type: 'number', description: '0-100, default 100' },
      },
      required: ['amount', 'category'],
    },
    execute: async (args) => {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        return JSON.stringify({ error: 'amount non valido (>=0 richiesto)' });
      }
      const occurredOn = (args.occurred_on as string) || new Date().toISOString().slice(0, 10);
      const [row] = await sql`
        INSERT INTO expenses (
          occurred_on, vendor, amount, vat_amount, category, description, notes,
          project_id, customer_id, payment_method, deductible_percent
        ) VALUES (
          ${occurredOn},
          ${(args.vendor as string) || null},
          ${amount},
          ${(args.vat_amount as number) || 0},
          ${args.category as string},
          ${(args.description as string) || null},
          ${(args.notes as string) || null},
          ${(args.project_id as string) || null},
          ${(args.customer_id as string) || null},
          ${(args.payment_method as string) || null},
          ${(args.deductible_percent as number) ?? 100}
        )
        RETURNING id, vendor, amount, category, payment_method, occurred_on
      `;
      return JSON.stringify({ logged: row });
    },
  },
];

/**
 * Get tool definitions formatted for OpenAI function calling
 */
export function getToolsForLLM() {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Execute a tool by name with given arguments
 */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return JSON.stringify({ error: `Tool "${name}" non trovato` });
  try {
    return await tool.execute(args);
  } catch (err) {
    if (err instanceof ToolInputError) {
      return JSON.stringify({ error: err.message, code: 'invalid_arguments', details: err.details });
    }
    // Validazioni condivise con le route (allegati, riferimenti): stesso messaggio del 400.
    if (err instanceof RequestValidationError) {
      return JSON.stringify({ error: err.message, code: 'invalid_arguments', details: err.details });
    }
    log.error({ err }, `Tool ${name} error`);
    // Il messaggio reale (e lo SQLSTATE per gli errori del database) arriva al
    // chiamante: i tool sono usati solo da admin (chat AI, Telegram, MCP con
    // token) e un testo generico rendeva impossibile capire cosa correggere.
    const message = err instanceof Error ? err.message : String(err);
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : undefined;
    return JSON.stringify({ error: `Errore esecuzione tool "${name}": ${message}`, ...(code ? { code } : {}) });
  }
}
