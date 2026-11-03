/**
 * Input fissi per i generatori ICS attuali dell'API (apps/api/src/lib/calendar/
 * ics.ts e ics-feed.ts). Le fixture test/fixtures/legacy-*.ics sono il loro
 * output con DTSTAMP normalizzato; legacy-ics.test.ts verifica che il codice
 * attuale produca ancora gli stessi testi e che calendar-core li legga senza
 * perdite.
 *
 * Tipi locali (sottoinsiemi strutturali di quelli dell'API): il pacchetto non
 * dipende da apps/api, nemmeno nel typecheck.
 */

export interface LegacyBookingLike {
  uid: string;
  start_time: string;
  end_time: string;
  attendee_name: string;
  attendee_email: string;
  location_type: 'google_meet' | 'custom_url' | 'in_person' | 'phone';
  location_value: string | null;
  attendee_message: string | null;
}

export interface LegacyCalendarLike {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  timezone: string;
  is_default: boolean;
  is_system: boolean;
  blocks_availability: boolean;
  ics_feed_token: string;
  ics_feed_enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface LegacyEventLike {
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
  source: 'manual' | 'booking' | 'admin' | 'mcp' | 'agent' | 'ics_pull' | 'system';
  source_id: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export const BOOKING: LegacyBookingLike = {
  uid: 'bk7Hq2xLm9Pa',
  start_time: '2026-10-12T08:00:00.000Z',
  end_time: '2026-10-12T09:00:00.000Z',
  attendee_name: 'Rossi, Mario',
  attendee_email: 'mario.rossi@example.com',
  location_type: 'google_meet',
  location_value: null,
  attendee_message: 'Vorrei parlare del sito: è urgente; grazie. Più dettagli à la carte 😀 — servizio e-commerce, SEO, manutenzione.',
};

export const BOOKING_EVENT_TYPE = {
  title: 'Consulenza; prima chiamata',
  description: 'Chiamata conoscitiva di 60 minuti.\nPortare eventuali riferimenti.',
};

export const BOOKING_OPTIONS = {
  organizerName: 'Federico Calicchia',
  organizerEmail: 'info@calicchia.test',
  manageUrl: 'https://sito.caldes.test/prenota/gestisci/bk7Hq2xLm9Pa?token=abc.def',
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  sequence: 2,
  uidDomain: 'caldes.it',
};

export const FEED_CALENDAR: LegacyCalendarLike = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'lavoro',
  name: 'Lavoro, clienti',
  description: null,
  color: '#2563eb',
  icon: null,
  timezone: 'Europe/Rome',
  is_default: true,
  is_system: false,
  blocks_availability: true,
  ics_feed_token: 'a'.repeat(32),
  ics_feed_enabled: true,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const base = {
  calendar_id: FEED_CALENDAR.id,
  description: null,
  location: null,
  url: null,
  recurrence_id: null,
  recurrence_master_id: null,
  source: 'manual' as const,
  source_id: null,
  status: 'confirmed' as const,
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-01T10:00:00.000Z',
};

/** Singolo timed (UTC nel feed). */
export const EV_SINGLE: LegacyEventLike = {
  ...base,
  id: '22222222-2222-4222-8222-222222222201',
  uid: 'single0000000001',
  summary: 'Incontro con il cliente, sede di Roma',
  description: 'Ordine del giorno:\n1) preventivo\n2) tempi; consegna',
  location: 'Via del Corso 1, Roma',
  url: 'https://meet.example.com/x?y=1&z=2',
  start_time: '2026-10-14T13:30:00.000Z',
  end_time: '2026-10-14T15:00:00.000Z',
  all_day: false,
  rrule: null,
  exdates: [],
};

/** All-day di due giorni salvato come mezzanotte di Roma. */
export const EV_ALLDAY: LegacyEventLike = {
  ...base,
  id: '22222222-2222-4222-8222-222222222202',
  uid: 'allday0000000001',
  summary: 'Ferie',
  start_time: '2026-12-23T23:00:00.000Z',
  end_time: '2026-12-25T23:00:00.000Z',
  all_day: true,
  rrule: null,
  exdates: [],
};

/** Serie lun-mar-gio-ven 09:00 Europe/Rome infinita (come in produzione), con un'esclusione dopo il cambio d'ora. */
export const EV_SERIES: LegacyEventLike = {
  ...base,
  id: '22222222-2222-4222-8222-222222222203',
  uid: 'series0000000001',
  summary: 'Blocco lavoro',
  start_time: '2026-09-07T07:00:00.000Z',
  end_time: '2026-09-07T11:00:00.000Z',
  all_day: false,
  rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,TH,FR',
  exdates: ['2026-11-02T08:00:00.000Z'],
};

/** Override della serie: l'occorrenza di giovedì 15/10 spostata alle 14:00. */
export const EV_OVERRIDE: LegacyEventLike = {
  ...base,
  id: '22222222-2222-4222-8222-222222222204',
  uid: 'override00000001',
  summary: 'Blocco lavoro (pomeriggio)',
  start_time: '2026-10-15T12:00:00.000Z',
  end_time: '2026-10-15T16:00:00.000Z',
  all_day: false,
  rrule: null,
  exdates: [],
  recurrence_id: '2026-10-15T07:00:00.000Z',
  recurrence_master_id: EV_SERIES.id,
};

/** Evento cancellato: il feed lo esclude. */
export const EV_CANCELLED: LegacyEventLike = {
  ...base,
  id: '22222222-2222-4222-8222-222222222205',
  uid: 'cancel0000000001',
  summary: 'Annullato',
  start_time: '2026-10-20T09:00:00.000Z',
  end_time: '2026-10-20T10:00:00.000Z',
  all_day: false,
  rrule: null,
  exdates: [],
  status: 'cancelled',
};

export const FEED_EVENTS: LegacyEventLike[] = [EV_SINGLE, EV_ALLDAY, EV_SERIES, EV_OVERRIDE, EV_CANCELLED];
