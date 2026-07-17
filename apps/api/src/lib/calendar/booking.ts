/**
 * Booking creation / cancel / reschedule / approval.
 *
 * Garanzie:
 * - No-overlap: EXCLUDE constraint `calendar_bookings_no_overlap` (23P01 →
 *   BookingConflictError) su status confirmed+pending (migr. 146).
 * - Capacità settimanale + buffer: verificati PRE-insert dentro una
 *   transazione serializzata da pg_advisory_xact_lock per settimana ISO —
 *   chiude il TOCTOU tra check e insert concorrenti.
 * - Reschedule atomico: cancel-old + create-new in un'unica transazione; se il
 *   nuovo slot confligge il rollback ripristina automaticamente l'originale.
 * - Workflow events centralizzati: booking_creato / booking_cancellato /
 *   booking_riprogrammato / booking_approvato partono da QUI per ogni percorso
 *   (public, admin, MCP, contact form). Le email restano nelle route.
 * - requires_approval: prenotazioni self-service (public_page/contact_form) su
 *   event type con requires_approval → status 'pending': lo slot è bloccato
 *   dalla EXCLUDE constraint ma la proiezione calendar_event avviene solo
 *   all'approvazione.
 */

import { customAlphabet } from 'nanoid';
import { sql } from '../../db';
import { getEventType } from './availability';
import { resolveLocationForBooking, deleteGoogleEvent } from './meeting-url';
import { getBookingsCalendar } from './calendars';
import { hasWeeklyCapacityForBooking } from './capacity';
import { createEvent, getEventBySource, updateEvent } from './events';
import type {
  Booking,
  BookingWithEventType,
  CancelledBy,
  CreateBookingInput,
  CustomQuestion,
  EventType,
} from './types';
import { logger } from '../logger';

const log = logger.child({ scope: 'calendar-booking' });

// Alphabet URL-safe, 12 char (~62^12 = abbastanza per uso commerciale)
const generateBookingUid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

export class BookingConflictError extends Error {
  code = 'BOOKING_CONFLICT' as const;
  constructor(message = 'Lo slot selezionato non è più disponibile') { super(message); }
}

export class BookingValidationError extends Error {
  code = 'BOOKING_VALIDATION' as const;
  constructor(message: string) { super(message); }
}

interface CreateBookingResult {
  booking: Booking;
  eventType: EventType;
}

/**
 * Valida le custom_responses contro le custom_questions dell'event type:
 * required presenti e non vuote, select dentro le options, cap 2000 char,
 * chiavi sconosciute scartate. Ritorna l'oggetto sanificato.
 * Lancia BookingValidationError alla prima violazione.
 */
export function validateCustomResponses(
  questions: CustomQuestion[],
  responses: unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  const src = responses && typeof responses === 'object' && !Array.isArray(responses)
    ? (responses as Record<string, unknown>)
    : {};
  for (const q of questions || []) {
    const raw = src[q.key];
    const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
    if (!value) {
      if (q.required) throw new BookingValidationError(`Risposta obbligatoria mancante: ${q.label}`);
      continue;
    }
    if (value.length > 2000) {
      throw new BookingValidationError(`Risposta troppo lunga per: ${q.label} (max 2000 caratteri)`);
    }
    if (q.type === 'select' && q.options?.length && !q.options.includes(value)) {
      throw new BookingValidationError(`Valore non valido per: ${q.label}`);
    }
    out[q.key] = value;
  }
  return out;
}

/**
 * Fire di un workflow event legato a un booking (best-effort, dynamic import
 * per non caricare l'engine sui percorsi che non lo usano).
 */
function fireBookingWorkflow(
  eventKey: string,
  booking: Booking,
  eventType: EventType,
  extra: Record<string, unknown> = {},
): void {
  import('../workflow/triggers')
    .then(({ fireEvent }) => fireEvent(eventKey, {
      booking_uid: booking.uid,
      event_type_slug: eventType.slug,
      attendee_name: booking.attendee_name,
      attendee_email: booking.attendee_email,
      start_time: booking.start_time,
      status: booking.status,
      source: booking.source,
      ...extra,
    }))
    .catch((err) => log.error({ err }, `Workflow fireEvent ${eventKey} FAILED for booking ${booking.uid}`));
}

/**
 * Proietta un booking confermato come calendar_event nel calendario 'bookings'
 * (best-effort: non blocca il chiamante). Così il booking appare nel
 * calendario admin, nel feed ICS e via CalDAV.
 */
async function projectBookingEvent(
  booking: Booking,
  eventType: EventType,
  meetingUrl: string | null,
): Promise<void> {
  try {
    const bookingsCal = await getBookingsCalendar();
    if (!bookingsCal) return;
    await createEvent({
      calendar_id: bookingsCal.id,
      summary: `${eventType.title} – ${booking.attendee_name}`,
      description: [
        `Cliente: ${booking.attendee_name} <${booking.attendee_email}>`,
        booking.attendee_phone ? `Tel: ${booking.attendee_phone}` : null,
        booking.attendee_company ? `Azienda: ${booking.attendee_company}` : null,
        booking.attendee_message ? `\nNote:\n${booking.attendee_message}` : null,
        `\nUID prenotazione: ${booking.uid}`,
      ].filter(Boolean).join('\n'),
      location: booking.location_value,
      url: meetingUrl,
      start_time: booking.start_time,
      end_time: booking.end_time,
      source: 'booking',
      source_id: booking.uid,
      status: 'confirmed',
    });
  } catch (eventErr) {
    log.error({ err: eventErr, bookingUid: booking.uid }, 'Auto-create calendar_event FAILED for booking');
  }
}

interface CreateBookingOptions {
  /** Transazione esterna (reschedule): usa questo handle invece di aprirne una. */
  db?: unknown;
  /** True quando il chiamante fa parte di un flusso che spara un proprio evento (reschedule). */
  suppressWorkflowEvents?: boolean;
}

/**
 * Crea un booking. Lancia:
 * - BookingConflictError se lo slot è occupato (EXCLUDE constraint, buffer o capacità)
 * - BookingValidationError se start non è valido / fuori range
 *
 * Con event type `requires_approval` e source self-service
 * (public_page/contact_form) il booking nasce `pending`.
 *
 * NB: il chiamante è responsabile di inviare le email.
 */
export async function createBooking(
  input: CreateBookingInput,
  opts: CreateBookingOptions = {},
): Promise<CreateBookingResult> {
  if (!input.event_type_id && !input.event_type_slug) {
    throw new BookingValidationError('event_type_id o event_type_slug richiesto');
  }
  if (!input.attendee?.name || !input.attendee?.email || !input.start) {
    throw new BookingValidationError('Dati mancanti: nome, email, slot');
  }

  const eventType = await getEventType(
    input.event_type_id || input.event_type_slug!,
    { onlyPublic: false }
  );
  if (!eventType) throw new BookingValidationError('Event type non trovato');

  // Calcola end
  const startDate = new Date(input.start);
  if (isNaN(startDate.getTime())) {
    throw new BookingValidationError('Data inizio non valida');
  }
  const endDate = new Date(startDate.getTime() + eventType.duration_minutes * 60_000);

  // Vincoli temporali
  const now = new Date();
  const minStart = new Date(now.getTime() + eventType.min_notice_hours * 60 * 60 * 1000);
  const maxStart = new Date(now.getTime() + eventType.max_advance_days * 24 * 60 * 60 * 1000);
  if (startDate < minStart) {
    throw new BookingValidationError(`Devi prenotare con almeno ${eventType.min_notice_hours} ore di anticipo`);
  }
  if (startDate > maxStart) {
    throw new BookingValidationError(`Puoi prenotare al massimo ${eventType.max_advance_days} giorni in anticipo`);
  }

  const uid = generateBookingUid();
  const startIso = startDate.toISOString();
  const endIso = endDate.toISOString();
  const source = input.source || 'public_page';
  const requiresApproval = eventType.requires_approval
    && (source === 'public_page' || source === 'contact_form');

  // Pre-risolvi location PRIMA dell'INSERT (best-effort; Google rimosso → stub).
  const resolved = await resolveLocationForBooking({
    eventType,
    booking: {
      uid,
      start_time: startIso,
      end_time: endIso,
      attendee_name: input.attendee.name.trim().slice(0, 200),
      attendee_email: input.attendee.email.trim().toLowerCase().slice(0, 255),
    },
    pushToGoogle: true,
  });

  const insertRow = {
    uid,
    event_type_id: eventType.id,
    status: requiresApproval ? 'pending' : 'confirmed',
    attendee_name: input.attendee.name.trim().slice(0, 200),
    attendee_email: input.attendee.email.trim().toLowerCase().slice(0, 255),
    attendee_phone: input.attendee.phone?.trim().slice(0, 50) || null,
    attendee_company: input.attendee.company?.trim().slice(0, 200) || null,
    attendee_timezone: input.attendee.timezone || 'Europe/Rome',
    attendee_message: input.attendee.message?.trim().slice(0, 2000) || null,
    custom_responses: input.custom_responses || {},
    start_time: startIso,
    end_time: endIso,
    location_type: eventType.location_type,
    location_value: resolved.locationValue || null,
    google_event_id: resolved.googleEventId,
    source,
    source_metadata: input.source_metadata || {},
    contact_id: input.contact_id || null,
    lead_id: input.lead_id || null,
    consent_ip: input.consent_ip ?? null,
    consent_user_agent: input.consent_user_agent ?? null,
  };

  // Sezione critica: advisory lock per settimana ISO → capacità e buffer
  // vengono verificati e l'INSERT eseguito senza races (il competitor attende
  // il lock e al suo turno vede il booking già committato).
  // NB: hasWeeklyCapacityForBooking legge dal pool globale mentre la tx tiene
  // una connessione: servono 2 connessioni per booking concorrente. Con pool
  // max 10 e il rate-limit pubblico 3/10min il rischio di esaurimento è
  // teorico; se mai si scalasse, threadare il tx dentro capacity.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const criticalSection = async (tx: any): Promise<Booking> => {
    await tx`
      SELECT pg_advisory_xact_lock(hashtext(
        'cal-week-' || to_char(date_trunc('week', ${startIso}::timestamptz AT TIME ZONE 'Europe/Rome'), 'IYYY-IW')
      ))
    `;

    const hasCapacity = await hasWeeklyCapacityForBooking(startIso, eventType.duration_minutes);
    if (!hasCapacity) {
      throw new BookingConflictError('Capacita settimanale esaurita: scegli un altro slot');
    }

    // Buffer re-check per prenotazioni manuali (admin/MCP): gli slot pubblici
    // arrivano già buffer-aware da computeAvailableSlots. Un booking esistente
    // blocca [start - buffer_after, end + buffer_before] del nuovo slot.
    const bufBefore = eventType.buffer_before_minutes;
    const bufAfter = eventType.buffer_after_minutes;
    if (source !== 'public_page' && !input.allow_buffer_override && (bufBefore > 0 || bufAfter > 0)) {
      const clash = await tx`
        SELECT uid FROM calendar_bookings
        WHERE status IN ('confirmed', 'pending')
          AND start_time - ${bufAfter} * INTERVAL '1 minute' < ${endIso}::timestamptz
          AND end_time + ${bufBefore} * INTERVAL '1 minute' > ${startIso}::timestamptz
        LIMIT 1
      `;
      if (clash.length) {
        throw new BookingConflictError(
          `Lo slot viola i buffer dell'event type (${bufBefore}min prima / ${bufAfter}min dopo). Usa allow_buffer_override per forzare.`
        );
      }
    }

    const rows = await tx`
      INSERT INTO calendar_bookings ${tx(insertRow)}
      RETURNING *
    `;
    return rows[0] as Booking;
  };

  let inserted: Booking;
  try {
    inserted = opts.db
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? await criticalSection(opts.db as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : await sql.begin(criticalSection) as any;
  } catch (err: unknown) {
    // Cleanup evento Google orfano se l'INSERT fallisce (no-op dopo rimozione Google)
    if (resolved.googleEventId) {
      deleteGoogleEvent(resolved.googleEventId).catch((cleanupErr) => {
        log.error({ err: cleanupErr }, 'Orphan Google event cleanup failed');
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('calendar_bookings_no_overlap') || (err as { code?: string })?.code === '23P01') {
      throw new BookingConflictError();
    }
    throw err;
  }

  // Side effects POST-commit — solo quando questa funzione possiede la
  // transazione. Con opts.db (reschedule) è il chiamante a occuparsene dopo
  // il commit, altrimenti proietteremmo eventi per una tx che può abortire.
  if (!opts.db) {
    if (inserted.status === 'confirmed') {
      await projectBookingEvent(inserted, eventType, resolved.meetingUrl ?? null);
    }
    if (!opts.suppressWorkflowEvents) {
      fireBookingWorkflow(eventType.workflow_event_key || 'booking_creato', inserted, eventType);
    }
  }

  return { booking: inserted, eventType };
}

export async function cancelBooking(uid: string, opts: {
  cancelled_by: CancelledBy;
  reason?: string;
}): Promise<{ booking: Booking; eventType: EventType } | null> {
  const rows = await sql<Booking[]>`
    SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1
  `;
  const booking = rows[0];
  if (!booking) return null;
  if (booking.status === 'cancelled') {
    const et = await getEventType(booking.event_type_id);
    if (!et) return null;
    return { booking, eventType: et };
  }

  const updated = await sql<Booking[]>`
    UPDATE calendar_bookings SET
      status = 'cancelled',
      cancelled_at = NOW(),
      cancelled_by = ${opts.cancelled_by},
      cancellation_reason = ${opts.reason?.slice(0, 1000) || null}
    WHERE id = ${booking.id}::uuid
    RETURNING *
  `;

  // Cleanup Google event (no-op dopo rimozione Google)
  await deleteGoogleEvent(booking.google_event_id);

  // Marca anche l'evento calendario corrispondente come cancellato
  // (cosi sparisce dal calendario admin + ICS feed iPhone)
  try {
    const linkedEvent = await getEventBySource('booking', booking.uid);
    if (linkedEvent) {
      await updateEvent(linkedEvent.id, { status: 'cancelled' });
    }
  } catch (err) {
    log.error({ err, bookingUid: booking.uid }, 'Sync cancel calendar_event FAILED for booking');
  }

  const eventType = await getEventType(booking.event_type_id);
  if (!eventType) return null;
  fireBookingWorkflow('booking_cancellato', updated[0], eventType, {
    reason: opts.reason || null,
    cancelled_by: opts.cancelled_by,
  });
  return { booking: updated[0], eventType };
}

export async function rescheduleBooking(uid: string, newStartIso: string, opts: {
  by: CancelledBy;
  reason?: string;
  /** Admin/MCP: consente il nuovo slot anche se viola i buffer dell'event type. */
  allow_buffer_override?: boolean;
}): Promise<{ booking: Booking; eventType: EventType; previousUid: string }> {
  // Cancel-old + create-new in un'unica transazione: se il nuovo INSERT
  // fallisce (EXCLUDE/capacità/buffer) il rollback ripristina automaticamente
  // l'originale — nessuna finestra in cui la prenotazione resta cancellata.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txResult = await sql.begin(async (tx: any) => {
    const rows = await tx`
      SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1 FOR UPDATE
    `;
    const original = rows[0] as Booking | undefined;
    if (!original) throw new BookingValidationError('Prenotazione non trovata');
    if (original.status === 'cancelled') {
      throw new BookingValidationError('Prenotazione già cancellata');
    }

    await tx`
      UPDATE calendar_bookings SET
        status = 'cancelled',
        cancelled_at = NOW(),
        cancelled_by = ${opts.by},
        cancellation_reason = ${`Rescheduled${opts.reason ? ': ' + opts.reason.slice(0, 950) : ''}`}
      WHERE id = ${original.id}::uuid
    `;

    const created = await createBooking({
      event_type_id: original.event_type_id,
      start: newStartIso,
      attendee: {
        name: original.attendee_name,
        email: original.attendee_email,
        phone: original.attendee_phone || undefined,
        company: original.attendee_company || undefined,
        timezone: original.attendee_timezone,
        message: original.attendee_message || undefined,
      },
      custom_responses: original.custom_responses,
      source: original.source,
      source_metadata: { ...original.source_metadata, rescheduled_from: uid },
      contact_id: original.contact_id || undefined,
      lead_id: original.lead_id || undefined,
      allow_buffer_override: opts.allow_buffer_override,
    }, { db: tx, suppressWorkflowEvents: true });

    const linked = await tx`
      UPDATE calendar_bookings SET rescheduled_from_uid = ${uid}
      WHERE id = ${created.booking.id}::uuid
      RETURNING *
    `;

    return { original, booking: linked[0] as Booking, eventType: created.eventType };
  });

  // Side effects post-commit (best-effort)
  await deleteGoogleEvent(txResult.original.google_event_id);
  try {
    const linkedEvent = await getEventBySource('booking', uid);
    if (linkedEvent) {
      await updateEvent(linkedEvent.id, { status: 'cancelled' });
    }
  } catch (err) {
    log.error({ err, bookingUid: uid }, 'Sync cancel calendar_event (reschedule) FAILED for booking');
  }
  if (txResult.booking.status === 'confirmed') {
    await projectBookingEvent(txResult.booking, txResult.eventType, null);
  }
  fireBookingWorkflow('booking_riprogrammato', txResult.booking, txResult.eventType, {
    previous_uid: uid,
    previous_start: txResult.original.start_time,
  });

  return { booking: txResult.booking, eventType: txResult.eventType, previousUid: uid };
}

/**
 * Approva una richiesta pending → confirmed: proietta il calendar_event e
 * spara `booking_approvato`. Ritorna null se il booking non esiste; lancia
 * BookingValidationError se non è pending.
 */
export async function approveBooking(uid: string): Promise<{ booking: Booking; eventType: EventType } | null> {
  const rows = await sql<Booking[]>`
    SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1
  `;
  const booking = rows[0];
  if (!booking) return null;
  if (booking.status !== 'pending') {
    throw new BookingValidationError('La prenotazione non è in attesa di approvazione');
  }

  const updated = await sql<Booking[]>`
    UPDATE calendar_bookings SET
      status = 'confirmed',
      approved_at = NOW()
    WHERE id = ${booking.id}::uuid AND status = 'pending'
    RETURNING *
  `;
  if (!updated[0]) {
    throw new BookingValidationError('La prenotazione non è in attesa di approvazione');
  }

  const eventType = await getEventType(booking.event_type_id);
  if (!eventType) return null;

  await projectBookingEvent(updated[0], eventType, null);
  fireBookingWorkflow('booking_approvato', updated[0], eventType);
  return { booking: updated[0], eventType };
}

/**
 * Rifiuta una richiesta pending → cancelled (nessun calendar_event da pulire:
 * per i pending non viene mai proiettato). Ritorna null se il booking non
 * esiste; lancia BookingValidationError se non è pending.
 */
export async function rejectBooking(
  uid: string,
  reason?: string,
): Promise<{ booking: Booking; eventType: EventType } | null> {
  const rows = await sql<Booking[]>`
    SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1
  `;
  const booking = rows[0];
  if (!booking) return null;
  if (booking.status !== 'pending') {
    throw new BookingValidationError('La prenotazione non è in attesa di approvazione');
  }

  const updated = await sql<Booking[]>`
    UPDATE calendar_bookings SET
      status = 'cancelled',
      cancelled_at = NOW(),
      cancelled_by = 'admin',
      cancellation_reason = ${reason ? `Rifiutata: ${reason.slice(0, 950)}` : 'Rifiutata'}
    WHERE id = ${booking.id}::uuid AND status = 'pending'
    RETURNING *
  `;
  if (!updated[0]) {
    throw new BookingValidationError('La prenotazione non è in attesa di approvazione');
  }

  const eventType = await getEventType(booking.event_type_id);
  if (!eventType) return null;
  fireBookingWorkflow('booking_cancellato', updated[0], eventType, {
    reason: reason || null,
    cancelled_by: 'admin',
    rejected: true,
  });
  return { booking: updated[0], eventType };
}

export async function getBookingByUid(uid: string): Promise<BookingWithEventType | null> {
  const rows = await sql<Booking[]>`
    SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1
  `;
  if (!rows[0]) return null;
  const eventType = await getEventType(rows[0].event_type_id);
  if (!eventType) return null;
  return { ...rows[0], event_type: eventType };
}
