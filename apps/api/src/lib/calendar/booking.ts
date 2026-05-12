/**
 * Booking creation / cancel / reschedule.
 *
 * Atomic via:
 * - PostgreSQL EXCLUDE constraint (calendar_bookings_no_overlap) → 23P01 in caso di conflict
 * - Re-check pre-insert con buffer applicato (per filtrare slot non allineati a buffer)
 *
 * In caso di conflict ritorna { conflict: true, error } senza throw.
 */

import { customAlphabet } from 'nanoid';
import { sql, sqlv } from '../../db';
import { getEventType } from './availability';
import { resolveLocationForBooking, deleteGoogleEvent } from './meeting-url';
import { getBookingsCalendar } from './calendars';
import { createEvent, getEventBySource, updateEvent } from './events';
import type {
  Booking,
  BookingWithEventType,
  CancelledBy,
  CreateBookingInput,
  EventType,
} from './types';

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
 * Crea un booking. Lancia:
 * - BookingConflictError se lo slot è già occupato (anche per buffer)
 * - BookingValidationError se start non è dentro la disponibilità o oltre il range
 *
 * NB: il chiamante è responsabile di inviare le email (via createBookingAndNotify).
 */
export async function createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
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

  // 1. Pre-risolvi location PRIMA dell'INSERT per evitare ghost booking.
  //    resolveLocationForBooking è best-effort (try/catch interno per Google):
  //    se Google fallisce, ritorna placeholder + null googleEventId — il booking
  //    risultante è coerente fin dal primo write (nessun INSERT+UPDATE separati).
  const uid = generateBookingUid();
  const startIso = startDate.toISOString();
  const endIso = endDate.toISOString();

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

  // 2. Single INSERT atomico (la EXCLUDE constraint blocca double-booking).
  //    Se la insert fallisce, lo stato DB resta invariato e dobbiamo cleanup
  //    l'eventuale evento Google appena creato per non lasciare orfani.
  let inserted: Booking;
  try {
    const rows = await sql<Booking[]>`
      INSERT INTO calendar_bookings ${sqlv({
        uid,
        event_type_id: eventType.id,
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
        source: input.source || 'public_page',
        source_metadata: input.source_metadata || {},
        contact_id: input.contact_id || null,
        lead_id: input.lead_id || null,
      })}
      RETURNING *
    `;
    inserted = rows[0];
  } catch (err: unknown) {
    // Cleanup evento Google orfano se l'INSERT fallisce (no-op dopo rimozione Google)
    if (resolved.googleEventId) {
      deleteGoogleEvent(resolved.googleEventId).catch((cleanupErr) => {
        console.error('[booking] Orphan Google event cleanup failed:', cleanupErr);
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('calendar_bookings_no_overlap') || (err as { code?: string })?.code === '23P01') {
      throw new BookingConflictError();
    }
    throw err;
  }

  // Auto-crea calendar_event nel calendario 'bookings' (best-effort, non blocca booking)
  // Questo permette al booking di apparire nel calendario admin + ICS feed iPhone.
  try {
    const bookingsCal = await getBookingsCalendar();
    if (bookingsCal) {
      await createEvent({
        calendar_id: bookingsCal.id,
        summary: `${eventType.title} – ${inserted.attendee_name}`,
        description: [
          `Cliente: ${inserted.attendee_name} <${inserted.attendee_email}>`,
          inserted.attendee_phone ? `Tel: ${inserted.attendee_phone}` : null,
          inserted.attendee_company ? `Azienda: ${inserted.attendee_company}` : null,
          inserted.attendee_message ? `\nNote:\n${inserted.attendee_message}` : null,
          `\nUID prenotazione: ${inserted.uid}`,
        ].filter(Boolean).join('\n'),
        location: inserted.location_value,
        url: resolved.meetingUrl,
        start_time: inserted.start_time,
        end_time: inserted.end_time,
        source: 'booking',
        source_id: inserted.uid,
        status: 'confirmed',
      });
    }
  } catch (eventErr) {
    // Non bloccare il booking se la creazione dell'evento fallisce — log per recovery
    console.error(`[booking] Auto-create calendar_event FAILED for booking ${inserted.uid}:`, eventErr);
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
    console.error(`[booking] Sync cancel calendar_event FAILED for booking ${booking.uid}:`, err);
  }

  const eventType = await getEventType(booking.event_type_id);
  if (!eventType) return null;
  return { booking: updated[0], eventType };
}

export async function rescheduleBooking(uid: string, newStartIso: string, opts: {
  by: CancelledBy;
  reason?: string;
}): Promise<{ booking: Booking; eventType: EventType; previousUid: string }> {
  const rows = await sql<Booking[]>`
    SELECT * FROM calendar_bookings WHERE uid = ${uid} LIMIT 1
  `;
  const original = rows[0];
  if (!original) throw new BookingValidationError('Prenotazione non trovata');
  if (original.status === 'cancelled') {
    throw new BookingValidationError('Prenotazione già cancellata');
  }

  // Cancella il vecchio booking (status='cancelled' libera lo slot per altri,
  // l'audit del reschedule rimane in cancellation_reason + nuovo.rescheduled_from_uid)
  await sql`
    UPDATE calendar_bookings SET
      status = 'cancelled',
      cancelled_at = NOW(),
      cancelled_by = ${opts.by},
      cancellation_reason = ${`Rescheduled${opts.reason ? ': ' + opts.reason.slice(0, 950) : ''}`}
    WHERE id = ${original.id}::uuid
  `;
  // Cleanup Google evento vecchio (no-op dopo rimozione Google)
  await deleteGoogleEvent(original.google_event_id);

  // Marca l'evento calendario vecchio come cancellato (il nuovo booking creerà
  // automaticamente un evento nuovo via createBooking → createEvent)
  try {
    const linkedEvent = await getEventBySource('booking', uid);
    if (linkedEvent) {
      await updateEvent(linkedEvent.id, { status: 'cancelled' });
    }
  } catch (err) {
    console.error(`[booking] Sync cancel calendar_event (reschedule) FAILED for booking ${uid}:`, err);
  }

  let result: CreateBookingResult;
  try {
    result = await createBooking({
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
    });
  } catch (err) {
    // Rollback: ripristina il booking originale se la creazione del nuovo fallisce.
    // Possibile fallimento dell'UPDATE: se nel frattempo qualcun altro ha occupato
    // lo slot originale (status='confirmed'), l'EXCLUDE constraint blocca il restore.
    // In quel caso il booking originale resta cancellato — comunicalo all'errore.
    try {
      await sql`
        UPDATE calendar_bookings SET
          status = 'confirmed',
          cancelled_at = NULL,
          cancelled_by = NULL,
          cancellation_reason = NULL
        WHERE id = ${original.id}::uuid
      `;
    } catch (rollbackErr) {
      console.error('[booking] Rollback reschedule fallito (slot occupato da altri):', rollbackErr);
    }
    throw err;
  }

  // Link al precedente
  await sql`
    UPDATE calendar_bookings SET rescheduled_from_uid = ${uid}
    WHERE id = ${result.booking.id}::uuid
  `;

  const refreshed = await sql<Booking[]>`SELECT * FROM calendar_bookings WHERE id = ${result.booking.id}::uuid`;

  return { booking: refreshed[0], eventType: result.eventType, previousUid: uid };
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
