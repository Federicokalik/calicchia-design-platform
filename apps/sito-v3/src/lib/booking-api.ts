import type {
  BookingEventType,
  BookingLocationType,
} from '@/data/booking-types';

const API_BASE_RAW =
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PORTAL_API_URL ??
  'http://localhost:3001';
const API_BASE = API_BASE_RAW.replace(/\/$/, '');
const PUBLIC_PREFIX = `${API_BASE}/api/calendar/public`;
const IS_LOCAL_API = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(API_BASE);
const IS_PRODUCTION_BUILD =
  process.env.NEXT_PHASE === 'phase-production-build' ||
  process.env.npm_lifecycle_event === 'build';

export type BookingStatus =
  | 'confirmed'
  | 'cancelled'
  | 'rescheduled'
  | 'no_show'
  | 'completed';

export interface BookingSlot {
  start: string;
  end: string;
}

export interface SlotsByDate {
  [yyyymmdd: string]: BookingSlot[];
}

export interface BookingDetail {
  uid: string;
  status: BookingStatus;
  attendee_name: string;
  attendee_email: string;
  attendee_timezone: string;
  start_time: string;
  end_time: string;
  location_type: BookingLocationType;
  location_value: string | null;
  cancelled_at: string | null;
  event_type: BookingEventType;
}

export interface CreateBookingInput {
  eventTypeSlug: string;
  startISO: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  notes?: string;
  turnstileToken: string;
  gdprConsent: true;
  timezone?: string;
  customResponses?: Record<string, unknown>;
  sourcePage?: string;
}

export interface BookingActionOptions {
  token?: string;
  reason?: string;
  turnstileToken?: string;
}

interface EventTypesResponse {
  event_types: BookingEventType[];
}

interface EventTypeResponse {
  event_type: BookingEventType;
}

interface SlotsResponse {
  timezone: string;
  duration_minutes: number;
  slots_by_date: SlotsByDate;
  slots: BookingSlot[];
}

interface CreateBookingResponse {
  success: boolean;
  booking?: {
    uid: string;
    start_time: string;
    end_time: string;
    location_type: BookingLocationType;
    location_value: string | null;
  };
  error?: string;
  code?: string;
}

interface BookingResponse {
  booking: Omit<BookingDetail, 'event_type'>;
  event_type: BookingEventType;
}

function warn(context: string, detail: unknown): void {
  if (process.env.NODE_ENV === 'production') return;
  console.warn(`[booking-api] ${context}`, detail);
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === 'string' && data.error.trim().length > 0
      ? data.error
      : `Errore calendario (${res.status})`;
  } catch {
    return `Errore calendario (${res.status})`;
  }
}

function bookingUrl(uid: string, token?: string, suffix = ''): string {
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  const query = params.toString();
  return `${PUBLIC_PREFIX}/bookings/${encodeURIComponent(uid)}${suffix}${query ? `?${query}` : ''}`;
}

function normalizeActionOptions(
  value?: string | BookingActionOptions,
): BookingActionOptions {
  if (!value) return {};
  if (typeof value === 'string') return { reason: value };
  return value;
}

/** Lista event types disponibili. Fallback: array vuoto se API irraggiungibile. */
export async function fetchEventTypes(): Promise<BookingEventType[]> {
  if (IS_LOCAL_API && IS_PRODUCTION_BUILD) return [];

  try {
    const res = await fetch(`${PUBLIC_PREFIX}/event-types`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      warn('fetchEventTypes failed', { status: res.status });
      return [];
    }

    const data = (await res.json()) as EventTypesResponse;
    return Array.isArray(data.event_types) ? data.event_types : [];
  } catch (error) {
    warn('fetchEventTypes threw', error);
    return [];
  }
}

/** Single event type by slug. */
export async function fetchEventType(
  slug: string,
): Promise<BookingEventType | null> {
  if (IS_LOCAL_API && IS_PRODUCTION_BUILD) return null;

  try {
    const res = await fetch(
      `${PUBLIC_PREFIX}/event-types/${encodeURIComponent(slug)}`,
      { next: { revalidate: 300 } },
    );
    if (!res.ok) {
      warn('fetchEventType failed', { slug, status: res.status });
      return null;
    }

    const data = (await res.json()) as EventTypeResponse;
    return data.event_type ?? null;
  } catch (error) {
    warn('fetchEventType threw', { slug, error });
    return null;
  }
}

/** Slot disponibili nel range [from, to]. */
export async function fetchAvailableSlots(
  eventTypeSlug: string,
  from: string,
  to: string,
): Promise<SlotsByDate> {
  const params = new URLSearchParams({ from, to });

  try {
    const res = await fetch(
      `${PUBLIC_PREFIX}/event-types/${encodeURIComponent(eventTypeSlug)}/slots?${params.toString()}`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) {
      warn('fetchAvailableSlots failed', {
        eventTypeSlug,
        from,
        to,
        status: res.status,
      });
      return {};
    }

    const data = (await res.json()) as SlotsResponse;
    return data.slots_by_date ?? {};
  } catch (error) {
    warn('fetchAvailableSlots threw', { eventTypeSlug, from, to, error });
    return {};
  }
}

/** Crea booking, ritorna { uid }. Throws on validation/conflict/server errors. */
export async function createBooking(
  input: CreateBookingInput,
): Promise<{ uid: string }> {
  try {
    const res = await fetch(`${PUBLIC_PREFIX}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type_slug: input.eventTypeSlug,
        start: input.startISO,
        turnstile_token: input.turnstileToken,
        gdpr_consent: input.gdprConsent,
        attendee: {
          name: input.name,
          email: input.email,
          phone: input.phone,
          company: input.company,
          timezone: input.timezone ?? 'Europe/Rome',
          message: input.notes,
        },
        custom_responses: input.customResponses ?? {},
        source_page: input.sourcePage,
      }),
    });

    if (!res.ok) {
      const backendMessage = await readErrorMessage(res);
      warn('createBooking failed', { status: res.status, backendMessage });

      if (res.status === 409) {
        throw new Error(
          'Lo slot selezionato non e piu disponibile. Scegli un altro orario.',
        );
      }
      if (res.status === 400) {
        throw new Error(backendMessage || 'Controlla i dati inseriti.');
      }
      if (res.status === 403) {
        throw new Error(
          'Verifica anti-bot fallita. Ricarica la pagina e riprova.',
        );
      }
      throw new Error('Non sono riuscito a creare la prenotazione. Riprova.');
    }

    const data = (await res.json()) as CreateBookingResponse;
    const uid = data.booking?.uid;
    if (!uid) {
      warn('createBooking missing uid in response', data);
      throw new Error('Prenotazione creata, ma conferma non leggibile.');
    }

    return { uid };
  } catch (error) {
    if (error instanceof Error) throw error;
    warn('createBooking threw non-error', error);
    throw new Error('Non sono riuscito a creare la prenotazione. Riprova.');
  }
}

export async function fetchBooking(
  uid: string,
): Promise<BookingDetail | null>;
export async function fetchBooking(
  uid: string,
  token: string,
): Promise<BookingDetail | null>;
/** Booking detail by UID. Returns null if not found or token is invalid. */
export async function fetchBooking(
  uid: string,
  token?: string,
): Promise<BookingDetail | null> {
  try {
    const res = await fetch(bookingUrl(uid, token), { cache: 'no-store' });
    if (!res.ok) {
      warn('fetchBooking failed', { uid, status: res.status });
      return null;
    }

    const data = (await res.json()) as BookingResponse;
    return {
      ...data.booking,
      event_type: data.event_type,
    };
  } catch (error) {
    warn('fetchBooking threw', { uid, error });
    return null;
  }
}

export async function cancelBooking(
  uid: string,
  reason?: string,
): Promise<void>;
export async function cancelBooking(
  uid: string,
  options?: BookingActionOptions,
): Promise<void>;
/** Cancel booking. Requires the booking HMAC token for the public backend. */
export async function cancelBooking(
  uid: string,
  reasonOrOptions?: string | BookingActionOptions,
): Promise<void> {
  const options = normalizeActionOptions(reasonOrOptions);

  try {
    const res = await fetch(bookingUrl(uid, options.token, '/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: options.reason }),
    });

    if (!res.ok) {
      const message = await readErrorMessage(res);
      warn('cancelBooking failed', { uid, status: res.status, message });
      throw new Error(message || 'Non sono riuscito a cancellare la prenotazione.');
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    warn('cancelBooking threw non-error', { uid, error });
    throw new Error('Non sono riuscito a cancellare la prenotazione.');
  }
}

export async function rescheduleBooking(
  uid: string,
  newStartISO: string,
  turnstileToken?: string,
): Promise<void>;
export async function rescheduleBooking(
  uid: string,
  newStartISO: string,
  options?: BookingActionOptions,
): Promise<void>;
/** Reschedule booking. Requires the booking HMAC token for the public backend. */
export async function rescheduleBooking(
  uid: string,
  newStartISO: string,
  turnstileTokenOrOptions?: string | BookingActionOptions,
): Promise<void> {
  const options =
    typeof turnstileTokenOrOptions === 'string'
      ? { turnstileToken: turnstileTokenOrOptions }
      : (turnstileTokenOrOptions ?? {});

  try {
    const res = await fetch(bookingUrl(uid, options.token, '/reschedule'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: newStartISO,
        reason: options.reason,
        turnstile_token: options.turnstileToken,
      }),
    });

    if (!res.ok) {
      const backendMessage = await readErrorMessage(res);
      warn('rescheduleBooking failed', {
        uid,
        status: res.status,
        backendMessage,
      });

      if (res.status === 409) {
        throw new Error(
          'Lo slot selezionato non e piu disponibile. Scegli un altro orario.',
        );
      }
      if (res.status === 400) {
        throw new Error(backendMessage || 'Controlla il nuovo orario.');
      }
      throw new Error('Non sono riuscito a riprogrammare la prenotazione.');
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    warn('rescheduleBooking threw non-error', { uid, error });
    throw new Error('Non sono riuscito a riprogrammare la prenotazione.');
  }
}

/** Get .ics download URL for client invite. */
export function getIcsUrl(uid: string, token?: string): string {
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  const query = params.toString();
  return `${PUBLIC_PREFIX}/bookings/${encodeURIComponent(uid)}/ics${query ? `?${query}` : ''}`;
}
