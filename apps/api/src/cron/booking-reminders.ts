/**
 * Cron: invia reminder 24h e 2h prima del booking.
 *
 * Idempotenza: claimReminder() in lib/calendar/email.ts pre-alloca audit row PRIMA
 * del send Resend (ON CONFLICT DO NOTHING + RETURNING). Due cron run paralleli che
 * provano a inviare lo stesso reminder competono atomically: solo uno vince.
 *
 * Range temporali (con tolleranza per coprire intervalli cron mancati):
 * - reminder_24h: now+22h ≤ start ≤ now+26h
 * - reminder_2h:  now+1h30m ≤ start ≤ now+2h30m
 *
 * Performance: bulk-load di tutti gli event types in un'unica query per evitare N+1.
 */

import { sql } from '../db';
import { sendBookingReminder } from '../lib/calendar/email';
import type { Booking, EventType } from '../lib/calendar/types';

async function processReminderType(kind: '24h' | '2h') {
  const reminderTypeKey = kind === '24h' ? 'reminder_24h' : 'reminder_2h';

  // SELECT bookings da notificare
  const candidates = kind === '24h'
    ? await sql<Booking[]>`
        SELECT b.* FROM calendar_bookings b
        WHERE b.status = 'confirmed'
          AND b.start_time BETWEEN NOW() + INTERVAL '22 hours' AND NOW() + INTERVAL '26 hours'
          AND NOT EXISTS (
            SELECT 1 FROM calendar_booking_reminders r
            WHERE r.booking_id = b.id AND r.reminder_type = 'reminder_24h'
          )
      `
    : await sql<Booking[]>`
        SELECT b.* FROM calendar_bookings b
        WHERE b.status = 'confirmed'
          AND b.start_time BETWEEN NOW() + INTERVAL '90 minutes' AND NOW() + INTERVAL '150 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM calendar_booking_reminders r
            WHERE r.booking_id = b.id AND r.reminder_type = 'reminder_2h'
          )
      `;

  if (!candidates.length) return 0;

  console.log(`[booking-reminders] ${candidates.length} reminder ${reminderTypeKey} da inviare`);

  // Bulk-load event types per tutti i bookings (evita N+1 query)
  const eventTypeIds = [...new Set(candidates.map((b) => b.event_type_id))];
  const eventTypeRows = await sql<EventType[]>`
    SELECT id, slug, title, description, duration_minutes,
           buffer_before_minutes, buffer_after_minutes, slot_increment_minutes,
           min_notice_hours, max_advance_days,
           location_type, location_value, color,
           is_active, is_public, requires_approval,
           custom_questions, workflow_event_key, schedule_id, sort_order
    FROM calendar_event_types
    WHERE id = ANY(${eventTypeIds}::uuid[])
  `;
  const eventTypeById = new Map(eventTypeRows.map((et) => [et.id, et]));

  let sent = 0;
  for (const booking of candidates) {
    try {
      const eventType = eventTypeById.get(booking.event_type_id);
      if (!eventType) {
        // Surface esplicito: event type cancellato dal DB ma booking ancora confermato.
        // Notifica admin per intervento manuale (cancellare il booking o ricreare l'event type).
        console.warn(
          `[booking-reminders] Event type ${booking.event_type_id} NON TROVATO per booking ${booking.uid} ` +
          `(attendee=${booking.attendee_email}, start=${booking.start_time}). Reminder ${reminderTypeKey} non inviato. ` +
          `Cancellare il booking o ripristinare l'event type.`
        );
        continue;
      }
      // Anche se inactive, l'event type esiste: invia comunque (l'admin l'ha disattivato
      // per nuovi bookings, ma quelli esistenti devono ricevere la conferma).
      await sendBookingReminder({ booking, eventType, kind });
      sent++;
    } catch (err) {
      console.error(`[booking-reminders] errore booking ${booking.uid}:`, err);
    }
  }

  return sent;
}

export async function runBookingReminders(): Promise<void> {
  const sent24 = await processReminderType('24h');
  const sent2 = await processReminderType('2h');
  if (sent24 + sent2 > 0) {
    console.log(`[booking-reminders] Completato — ${sent24} (24h) + ${sent2} (2h) inviate`);
  }
}
