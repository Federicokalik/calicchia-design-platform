/**
 * Risolve la URL di meeting per un booking in base al location_type dell'event type.
 *
 * NOTA: dopo rimozione Google Workspace, `google_meet` non è più auto-generabile.
 * Federico deve creare il meeting manualmente su meet.google.com (o equivalente)
 * e incollare l'URL custom nell'admin event-type config (location_type='custom_url')
 * oppure inserire il link nel campo `location_value` del singolo booking.
 *
 * - google_meet: ritorna placeholder e niente meeting URL — l'admin contatta il
 *   cliente con il link via email/chat.
 * - custom_url:  URL diretto dal location_value dell'event type
 * - in_person:   indirizzo testuale
 * - phone:       numero di telefono
 */

import type { Booking, EventType } from './types';

export interface ResolvedLocation {
  /** Stringa human-readable salvata in calendar_bookings.location_value */
  locationValue: string;
  /** Sempre null dopo rimozione Google integration */
  googleEventId: null;
  /** Pure URL del meeting per template email/.ics (se applicabile) */
  meetingUrl: string | null;
}

export async function resolveLocationForBooking(opts: {
  eventType: EventType;
  booking: Pick<Booking, 'uid' | 'start_time' | 'end_time' | 'attendee_name' | 'attendee_email'>;
  /** Mantenuto per retro-compat ma ignorato (Google rimosso) */
  pushToGoogle?: boolean;
}): Promise<ResolvedLocation> {
  const { eventType } = opts;

  switch (eventType.location_type) {
    case 'custom_url':
      return {
        locationValue: eventType.location_value || '',
        googleEventId: null,
        meetingUrl: eventType.location_value || null,
      };

    case 'in_person':
      return {
        locationValue: eventType.location_value || 'Da concordare via email',
        googleEventId: null,
        meetingUrl: null,
      };

    case 'phone':
      return {
        locationValue: eventType.location_value || 'Telefonata',
        googleEventId: null,
        meetingUrl: null,
      };

    case 'google_meet':
      // Google Workspace disdetto: niente auto-create.
      // L'admin riceve email notifica con UID e crea il meeting manualmente,
      // poi può aggiornare manualmente il booking.location_value via admin UI.
      return {
        locationValue: 'Google Meet (link inviato a parte)',
        googleEventId: null,
        meetingUrl: null,
      };
  }
}

/**
 * Stub per backward-compat: dopo rimozione Google integration non c'è nulla da cancellare.
 * Mantenuto come no-op per non rompere code path che lo chiamano (es. cancelBooking).
 */
export async function deleteGoogleEvent(_googleEventId: string | null): Promise<void> {
  // No-op dopo rimozione Google Workspace
}
