/**
 * DTO dell'API admin del calendario v2 (/api/admin/calendar/v2), condivisi da
 * API e admin. Contratto: docs/calendar-radicale/contracts/f6-modules.md.
 * Solo tipi e costanti. Le forme iCalendar sono identiche a quelle di
 * @calicchia/calendar-core (model.ts, patch.ts): l'API le passa senza
 * conversioni e l'admin non importa calendar-core.
 */

export const CAL_V2_API_VERSION = 2 as const;

// ─── Forme iCalendar (specchio di calendar-core) ───────────────────────────────

export interface CalV2Param { name: string; values: string[] }
export interface CalV2Property { name: string; params: CalV2Param[]; value: string }
export interface CalV2Component { name: string; properties: CalV2Property[]; components: CalV2Component[] }
export type CalV2Zone = { kind: 'utc' } | { kind: 'floating' } | { kind: 'tzid'; tzid: string };
export interface CalV2Date { type: 'date'; year: number; month: number; day: number }
export interface CalV2DateTime {
  type: 'date-time';
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  zone: CalV2Zone;
}
export type CalV2Time = CalV2Date | CalV2DateTime;
export interface CalV2Duration { negative: boolean; weeks: number; days: number; hours: number; minutes: number; seconds: number }
export interface CalV2Period { type: 'period'; start: CalV2DateTime; end: CalV2DateTime | null; duration: CalV2Duration | null }
export interface CalV2Geo { lat: number; lon: number }

// ─── Modi e capacità ───────────────────────────────

export const CAL_V2_BACKEND_MODES = ['postgres', 'cutover', 'radicale', 'rollback', 'finalized'] as const;
export type CalV2BackendMode = (typeof CAL_V2_BACKEND_MODES)[number];

export const CAL_V2_SCOPES = ['this', 'this_and_future', 'all'] as const;
export type CalV2Scope = (typeof CAL_V2_SCOPES)[number];

export const CAL_V2_CAPABILITY_REASONS = [
  'STORE_POSTGRES', 'WRITES_SUSPENDED', 'WRITE_FREEZE', 'RADICALE_UNCONFIGURED', 'API_LEVEL_BLOCKED',
] as const;
export type CalV2CapabilityReason = (typeof CAL_V2_CAPABILITY_REASONS)[number];

export interface CalV2Capabilities {
  api_version: typeof CAL_V2_API_VERSION;
  mode: CalV2BackendMode;
  store: 'postgres' | 'radicale';
  objects: { read: boolean; write: boolean; dry_run: boolean; scopes: CalV2Scope[] };
  /** Tranche C: false finché non esistono. */
  history: boolean;
  trash: boolean;
  import_export: boolean;
  calendar_properties: boolean;
  health_page: boolean;
  reasons: CalV2CapabilityReason[];
}

// ─── Campi ───────────────────────────────

export const CAL_V2_FIELDS = [
  'summary', 'description', 'location', 'url', 'status', 'transp', 'class', 'priority', 'categories', 'color', 'geo',
  'start', 'end', 'duration', 'rrule', 'rdates', 'exdates', 'alarms', 'organizer', 'attendees',
] as const;
export type CalV2FieldName = (typeof CAL_V2_FIELDS)[number];

/** Campi che solo la serie intera (o la nuova serie) può cambiare: mai con scope 'this'. */
export const CAL_V2_SERIES_ONLY_FIELDS = ['rrule', 'rdates', 'exdates'] as const satisfies readonly CalV2FieldName[];

/** Valori tipizzati (identici a PatchFieldValues di calendar-core). */
export interface CalV2FieldValues {
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED' | null;
  /** null = TRANSP assente (timed occupato, all-day libero: decisione 6). */
  transp: 'OPAQUE' | 'TRANSPARENT' | null;
  class: string | null;
  /** 0-9, null = assente. */
  priority: number | null;
  categories: string[];
  color: string | null;
  geo: CalV2Geo | null;
  start: CalV2Time;
  /** DTEND; null = assente (si usa duration o la durata implicita). */
  end: CalV2Time | null;
  duration: CalV2Duration | null;
  /** RRULE grezza senza prefisso; null = nessuna ricorrenza. */
  rrule: string | null;
  rdates: Array<CalV2Time | CalV2Period>;
  exdates: CalV2Time[];
  /** VALARM completi: sostituiscono tutti quelli del componente. */
  alarms: CalV2Component[];
  organizer: CalV2Property | null;
  attendees: CalV2Property[];
}

/** Proprietà gestite dai campi o dal server: mai in 'set_property'. */
export const CAL_V2_RESERVED_PROPERTIES = [
  'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL', 'STATUS', 'TRANSP', 'CLASS', 'PRIORITY', 'CATEGORIES', 'COLOR', 'GEO',
  'DTSTART', 'DTEND', 'DUE', 'DURATION', 'RRULE', 'RDATE', 'EXDATE', 'ORGANIZER', 'ATTENDEE',
  'UID', 'RECURRENCE-ID', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE',
] as const;

/** Token di base di una proprietà assente nel componente visto. */
export const CAL_V2_ABSENT_TOKEN = '-';

export type CalV2Op =
  | { [F in CalV2FieldName]: { op: 'set'; field: F; value: CalV2FieldValues[F] } }[CalV2FieldName]
  | {
      op: 'set_property';
      /** Proprietà non tipizzata (X-*, CONFERENCE, ATTACH, RELATED-TO, IANA sconosciute). */
      name: string;
      /** Sostituiscono tutte quelle con quel nome; [] le rimuove. */
      properties: CalV2Property[];
    };

// ─── Viste ───────────────────────────────

export const CAL_V2_READONLY_REASONS = ['subscription', 'archive', 'unreadable', 'component_unsupported', 'writes_suspended'] as const;
export type CalV2ReadonlyReason = (typeof CAL_V2_READONLY_REASONS)[number];
export const CAL_V2_DELETE_BLOCKED_REASONS = ['booking_active'] as const;
export type CalV2DeleteBlockedReason = (typeof CAL_V2_DELETE_BLOCKED_REASONS)[number];
export const CAL_V2_NOTICES = ['booking_projection', 'no_scheduling', 'index_fallback', 'collection_hold'] as const;
export type CalV2Notice = (typeof CAL_V2_NOTICES)[number];

export interface CalV2Address { value: string; cn: string | null; params: CalV2Param[] }

/** Decodifica di un VALARM (fields.alarms[index]) per la sola visualizzazione. */
export interface CalV2AlarmView {
  index: number;
  action: string | null;
  trigger:
    | { kind: 'relative'; related: 'START' | 'END'; offset: CalV2Duration }
    | { kind: 'absolute'; at: CalV2DateTime }
    | null;
  description: string | null;
  summary: string | null;
  /** Valori degli ATTENDEE del VALARM (EMAIL). */
  attendees: string[];
  repeat: number | null;
  duration: CalV2Duration | null;
  /** X-APPLE-DEFAULT-ALARM:TRUE. */
  apple_default: boolean;
  /** UID o X-WR-ALARMUID. */
  uid: string | null;
}

export interface CalV2ComponentView {
  /** '' = master o evento singolo. */
  recurrence_key: string;
  /** Id di (calendario, href, chiave) in cal_object_ids; null per un'istanza mai sovrascritta. */
  component_id: string | null;
  is_override: boolean;
  /** Per un'istanza senza override: pre-immagine (copia del master all'istanza). */
  fields: CalV2FieldValues;
  /** Token di base: chiavi = nomi dei campi e 'prop:<NOME>' delle proprietà presenti. */
  tokens: Record<string, string>;
  all_day: boolean;
  /** Istanti ISO UTC (floating e DATE nel fuso del calendario). */
  start_utc: string;
  end_utc: string;
  readonly: {
    uid: string | null;
    sequence: number | null;
    dtstamp: CalV2DateTime | null;
    created: CalV2DateTime | null;
    last_modified: CalV2DateTime | null;
    recurrence_id: CalV2Time | null;
  };
  alarms: CalV2AlarmView[];
  organizer: CalV2Address | null;
  attendees: CalV2Address[];
  /** Proprietà non tipizzate per nome, nell'ordine del testo. */
  extra_properties: Record<string, CalV2Property[]>;
  warnings: Array<{ code: string; message: string }>;
}

export interface CalV2Preview {
  /** Riepilogo in italiano (describeRrule), null se non ricorrente. */
  rrule_summary: string | null;
  /** Prossime occorrenze (al più 10) dall'istanza del target o da adesso. */
  next: Array<{ recurrence_key: string; start_utc: string; end_utc: string; all_day: boolean; is_override: boolean }>;
  instances_in_horizon: number | null;
  truncated: boolean;
}

export interface CalV2ObjectView {
  /** cal_objects.id; '' nel dryRun di una creazione. */
  id: string;
  calendar_id: string;
  href: string;
  uid: string;
  etag: string | null;
  source: 'radicale' | 'index';
  component_type: 'VEVENT' | 'VTODO' | 'VJOURNAL';
  calendar_tz: string;
  health: 'ok' | 'quarantined' | 'pending_404';
  health_reason: string | null;
  collection_health: 'healthy' | 'stale' | 'unsyncable' | 'hold';
  provenance: { source: string; source_id: string | null };
  readonly_reason: CalV2ReadonlyReason | null;
  delete_blocked_reason: CalV2DeleteBlockedReason | null;
  notices: CalV2Notice[];
  recurring: boolean;
  master: CalV2ComponentView | null;
  /** Ordinati per recurrence key. */
  overrides: CalV2ComponentView[];
  /** Componente richiesto (§3.2); master se non indicato. */
  target: CalV2ComponentView | null;
  calendar_properties: CalV2Property[];
  /** TZID dei VTIMEZONE presenti nel testo. */
  timezones: string[];
  /** Nomi degli altri componenti di primo livello conservati (VFREEBUSY, X-...). */
  other_components: string[];
  /** Solo per una serie leggibile. */
  preview: CalV2Preview | null;
  /** Testo grezzo letto (≤ 1 MB). */
  ics: string;
  parse_error: string | null;
}

// ─── Richieste e risultati ───────────────────────────────

export interface CalV2PatchRequest {
  target: { recurrence_key: string };
  scope: CalV2Scope;
  ops: CalV2Op[];
  /** Token presi da target.tokens per ogni campo o 'prop:<NOME>' toccato. */
  base: Record<string, string>;
  /** Solo scope 'all': sposta la risorsa in un altro calendario (MOVE dopo la PUT). */
  move_to_calendar_id?: string;
  dryRun?: boolean;
}

export interface CalV2CreateRequest {
  calendar_id: string;
  /** Facoltativo: generato dall'admin all'apertura del form (retry sicuro, §3.6). */
  uid?: string;
  fields: Partial<CalV2FieldValues> & { start: CalV2Time };
  /** Proprietà non tipizzate iniziali (stesse regole di 'set_property'). */
  properties?: Record<string, CalV2Property[]>;
  dryRun?: boolean;
}

export interface CalV2Issue {
  code: string;
  severity: 'error' | 'warning';
  /** In italiano, mostrabile. */
  message: string;
  property?: string;
  recurrence_key?: string;
}

export interface CalV2WriteResult {
  /** null dopo l'eliminazione della risorsa. */
  object: CalV2ObjectView | null;
  etag: string | null;
  changed: string[];
  noop: boolean;
  /** Applicata sopra una versione più nuova con campi disgiunti (§3.3). */
  merged: boolean;
  sequence_bumped: boolean;
  /** Solo 'this_and_future'. */
  tail?: CalV2ObjectView | null;
  whole_series?: boolean;
  orphaned_overrides: string[];
  dry_run: boolean;
  valid: boolean;
  issues: CalV2Issue[];
}

export interface CalV2FieldConflict {
  /** Nome del campo o 'prop:<NOME>'. */
  field: string;
  /** Valore corrente sul server (formato wire). */
  theirs: unknown;
  /** Valore richiesto (formato wire). */
  yours: unknown;
}

export const CAL_V2_ERROR_CODES = [
  'VALIDATION_FAILED', 'SCOPE_INVALID', 'CSRF_REJECTED', 'READ_ONLY', 'NOT_FOUND', 'AMBIGUOUS_REF',
  'RECURRENCE_TARGET_GONE', 'OBJECT_EXISTS', 'MOVE_CONFLICT', 'STORE_MODE_UNSUPPORTED',
  'PRECONDITION_FAILED', 'PRECONDITION_REQUIRED', 'CALENDAR_UNAVAILABLE',
] as const;
export type CalV2ErrorCode = (typeof CAL_V2_ERROR_CODES)[number];

export interface CalV2ErrorBody { error: string; code: CalV2ErrorCode; details?: Record<string, unknown> }

export interface CalV2PreconditionFailedBody {
  error: string;
  code: 'PRECONDITION_FAILED';
  current: CalV2ObjectView;
  conflicts: CalV2FieldConflict[];
}
