export type BookingLocationType =
  | 'google_meet'
  | 'custom_url'
  | 'in_person'
  | 'phone';

export interface BookingCustomQuestion {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select';
  options?: string[];
  required?: boolean;
}

/**
 * Public calendar event type returned by `apps/api`.
 * The backend source of truth uses `title`, not `name`.
 */
export interface BookingEventType {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  duration_minutes: number;
  location_type: BookingLocationType;
  location_value: string | null;
  color: string;
  custom_questions: BookingCustomQuestion[];
  min_notice_hours: number;
  max_advance_days: number;
}
