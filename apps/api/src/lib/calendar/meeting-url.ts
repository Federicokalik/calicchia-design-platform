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

import type { Booking, EventType, LocationType } from './types';

/**
 * Chiave di `calendar_bookings.source_metadata` che marca un luogo/link scelto
 * per la singola prenotazione (es. un link MEGA o Zoom al posto del Meet del
 * tipo evento). Quando è presente, il luogo della prenotazione vince su quello
 * del tipo evento in email, .ics, proiezioni e riprogrammazioni.
 */
export const LOCATION_OVERRIDE_META_KEY = 'location_override';

export interface BookingLocationOverride {
  type: LocationType;
  value: string | null;
}

type OverrideCarrier = {
  location_type?: LocationType | null;
  location_value?: string | null;
  source_metadata?: Record<string, unknown> | null;
};

export function hasLocationOverride(booking: OverrideCarrier | null | undefined): boolean {
  return booking?.source_metadata?.[LOCATION_OVERRIDE_META_KEY] === true;
}

/** Luogo della prenotazione se scelto per la singola prenotazione, altrimenti null. */
export function bookingLocationOverride(booking: OverrideCarrier | null | undefined): BookingLocationOverride | null {
  if (!booking || !hasLocationOverride(booking) || !booking.location_type) return null;
  return { type: booking.location_type, value: booking.location_value ?? null };
}

/** Risolve un luogo esplicito (override) come farebbe il tipo evento. */
export function resolveExplicitLocation(location: BookingLocationOverride): ResolvedLocation {
  const value = location.value?.trim() || null;
  return {
    locationValue: value ?? '',
    googleEventId: null,
    meetingUrl: location.type === 'custom_url' || location.type === 'google_meet' ? (value && /^https?:\/\//i.test(value) ? value : null) : null,
  };
}

/**
 * Valida un link di videocall (Meet, MEGA, Zoom, Teams, Jitsi, Whereby, ...):
 * solo https, host presente, niente credenziali nell'URL. Ritorna l'URL
 * normalizzato o null se non valido.
 */
export function normalizeMeetingUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 500) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    // MEGA usa il frammento (#chiave): va conservato così com'è.
    return url.toString();
  } catch {
    return null;
  }
}

/** Nome leggibile del servizio di videocall, per email e calendario. */
export function meetingProviderLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (is('meet.google.com')) return 'Google Meet';
  if (is('mega.nz') || is('mega.io') || is('mega.co.nz')) return 'MEGA';
  if (is('zoom.us') || is('zoom.com')) return 'Zoom';
  if (is('teams.microsoft.com') || is('teams.live.com')) return 'Microsoft Teams';
  if (is('meet.jit.si') || host.includes('jitsi')) return 'Jitsi';
  if (is('whereby.com')) return 'Whereby';
  if (is('webex.com')) return 'Webex';
  return null;
}

/**
 * URL della riunione da mettere in email e .ics: il link scelto per la
 * prenotazione se c'è, altrimenti quello del tipo evento (comportamento storico).
 */
export function bookingMeetingUrl(
  booking: Pick<Booking, 'location_type' | 'location_value' | 'source_metadata'>,
  eventType: Pick<EventType, 'location_type'>,
): string | null {
  const override = bookingLocationOverride(booking);
  if (override) return resolveExplicitLocation(override).meetingUrl;
  return eventType.location_type === 'google_meet' || eventType.location_type === 'custom_url'
    ? booking.location_value || null
    : null;
}

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
  booking: Pick<Booking, 'uid' | 'start_time' | 'end_time' | 'attendee_name' | 'attendee_email'> & OverrideCarrier;
  /** Mantenuto per retro-compat ma ignorato (Google rimosso) */
  pushToGoogle?: boolean;
}): Promise<ResolvedLocation> {
  const { eventType } = opts;

  // Luogo scelto per la singola prenotazione (es. link MEGA): vince sul tipo evento.
  const override = bookingLocationOverride(opts.booking);
  if (override) return resolveExplicitLocation(override);

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

const LOCATION_TYPES: readonly LocationType[] = ['google_meet', 'custom_url', 'in_person', 'phone'];

/**
 * Legge un luogo esplicito dall'input di admin/MCP. Accetta:
 *  - `meeting_url`: link di videocall https (Meet, MEGA, Zoom, Teams, ...) → custom_url;
 *  - `location_type` + `location_value`: luogo generico (in_person, phone, custom_url, google_meet).
 * Ritorna `{ location: undefined }` se l'input non chiede alcun cambio di luogo.
 */
export function parseLocationInput(input: Record<string, unknown>):
  | { location: BookingLocationOverride | undefined }
  | { error: string } {
  if (input.meeting_url !== undefined && input.meeting_url !== null && input.meeting_url !== '') {
    const url = normalizeMeetingUrl(input.meeting_url);
    if (!url) return { error: 'meeting_url deve essere un link https valido (es. https://mega.nz/... o https://meet.google.com/...)' };
    return { location: { type: 'custom_url', value: url } };
  }
  if (input.location_type === undefined || input.location_type === null || input.location_type === '') {
    return { location: undefined };
  }
  const type = input.location_type as LocationType;
  if (!LOCATION_TYPES.includes(type)) return { error: `location_type deve essere uno di ${LOCATION_TYPES.join(', ')}` };
  const rawValue = typeof input.location_value === 'string' ? input.location_value.trim() : '';
  if (type === 'custom_url' || type === 'google_meet') {
    if (!rawValue) return { location: { type, value: null } };
    const url = normalizeMeetingUrl(rawValue);
    if (!url) return { error: 'location_value deve essere un link https valido per una videocall' };
    return { location: { type, value: url } };
  }
  return { location: { type, value: rawValue ? rawValue.slice(0, 500) : null } };
}
