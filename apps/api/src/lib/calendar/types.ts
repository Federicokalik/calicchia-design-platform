/**
 * Calendar / booking types — shared by API routes, lib internals, MCP tools.
 *
 * UID format: short nanoid (12 char) — public, exposed in URLs and emails.
 */

export type LocationType = 'google_meet' | 'custom_url' | 'in_person' | 'phone';

export type BookingStatus =
  | 'confirmed'
  | 'cancelled'
  | 'rescheduled'
  | 'no_show'
  | 'completed';

export type BookingSource = 'public_page' | 'contact_form' | 'admin_manual' | 'mcp';

export type CancelledBy = 'attendee' | 'admin' | 'system';

export interface CustomQuestion {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select';
  options?: string[];
  required?: boolean;
}

export interface EventType {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  slot_increment_minutes: number;
  min_notice_hours: number;
  max_advance_days: number;
  location_type: LocationType;
  location_value: string | null;
  color: string;
  is_active: boolean;
  is_public: boolean;
  requires_approval: boolean;
  custom_questions: CustomQuestion[];
  workflow_event_key: string | null;
  schedule_id: string | null;
  sort_order: number;
}

export interface AvailabilitySchedule {
  id: string;
  name: string;
  timezone: string;
  is_default: boolean;
}

export interface AvailabilitySlot {
  id: string;
  schedule_id: string;
  day_of_week: number; // 0=domenica, 6=sabato
  start_time: string;  // 'HH:MM:SS'
  end_time: string;    // 'HH:MM:SS'
}

export interface AvailabilityOverride {
  id: string;
  schedule_id: string;
  override_date: string; // 'YYYY-MM-DD'
  is_unavailable: boolean;
  start_time: string | null;
  end_time: string | null;
  note: string | null;
}

export interface Slot {
  /** ISO UTC start */
  start: string;
  /** ISO UTC end */
  end: string;
}

export interface Booking {
  id: string;
  uid: string;
  event_type_id: string;
  status: BookingStatus;
  attendee_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  attendee_company: string | null;
  attendee_timezone: string;
  attendee_message: string | null;
  custom_responses: Record<string, unknown>;
  start_time: string;
  end_time: string;
  location_type: LocationType;
  location_value: string | null;
  google_event_id: string | null;
  cancellation_reason: string | null;
  cancelled_at: string | null;
  cancelled_by: CancelledBy | null;
  rescheduled_from_uid: string | null;
  source: BookingSource;
  source_metadata: Record<string, unknown>;
  contact_id: string | null;
  lead_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BookingWithEventType extends Booking {
  event_type: EventType;
}

export interface CreateBookingInput {
  event_type_id?: string;
  event_type_slug?: string;
  start: string; // ISO UTC
  attendee: {
    name: string;
    email: string;
    phone?: string;
    company?: string;
    timezone: string;
    message?: string;
  };
  custom_responses?: Record<string, unknown>;
  source?: BookingSource;
  source_metadata?: Record<string, unknown>;
  contact_id?: string;
  lead_id?: string;
  /** Se true salta invio email confermail (usato dal route contacts che ha già un proprio invio). */
  skip_emails?: boolean;
}

export interface BookingTokenPayload {
  uid: string;
  exp: number; // epoch seconds
}

// ============================================
// Caldes Calendar (sostituzione Google Calendar)
// ============================================

export interface Calendar {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  timezone: string;
  is_default: boolean;
  is_system: boolean;
  ics_feed_token: string;
  ics_feed_enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type CalendarEventStatus = 'confirmed' | 'tentative' | 'cancelled';
export type CalendarEventSource = 'manual' | 'booking' | 'admin' | 'mcp' | 'agent';

export interface CalendarEvent {
  id: string;
  calendar_id: string;
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  rrule: string | null;
  exdates: string[];
  recurrence_id: string | null;
  recurrence_master_id: string | null;
  source: CalendarEventSource;
  source_id: string | null;
  status: CalendarEventStatus;
  created_at: string;
  updated_at: string;
}

/**
 * Occorrenza espansa di un evento ricorrente. Non corrisponde a una row DB
 * — è il risultato di expandRecurrences() per il rendering frontend / ICS.
 */
export interface CalendarEventOccurrence extends Omit<CalendarEvent, 'rrule' | 'exdates' | 'recurrence_master_id'> {
  /** Timestamp originale dell'occorrenza (per identificarla nel master). null se evento singolo. */
  original_start: string | null;
  /** True se questa occorrenza è un override esplicito (esiste come row separata). */
  is_override: boolean;
}

export interface CreateCalendarInput {
  slug: string;
  name: string;
  description?: string | null;
  color?: string;
  icon?: string | null;
  timezone?: string;
  is_default?: boolean;
  sort_order?: number;
}

export interface CreateEventInput {
  calendar_id: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  start_time: string;
  end_time: string;
  all_day?: boolean;
  rrule?: string | null;
  exdates?: string[];
  source?: CalendarEventSource;
  source_id?: string | null;
  status?: CalendarEventStatus;
}
