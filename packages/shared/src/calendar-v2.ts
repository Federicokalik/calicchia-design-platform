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
  // Flag della tranche C (contratto §2, §9): ciascuno è vero solo se la route
  // esiste in questo deploy E `objects.read` è vero. Il permesso di scrivere
  // resta quello di `objects.write` (le scritture con write=false → 503 dal gate).
  /** PUT /objects/:id/ics (C1). */
  raw_edit: boolean;
  /** POST /objects/:id/move e /duplicate, GET /objects/:id/export.ics (C1). */
  object_tools: boolean;
  /** GET /objects/:id/versions[/:versionId], POST /objects/:id/restore (C1). */
  history: boolean;
  /** GET /trash, POST /trash/:objectId/restore (C1). */
  trash: boolean;
  /** GET /calendars/:id/export.ics, POST /calendars/:id/import, GET /jobs/:jobId (C2). */
  import_export: boolean;
  /** GET/POST/PATCH/DELETE /calendars, PUT /calendars/order, POST /calendars/:id/rotate-token (C2). */
  calendar_properties: boolean;
  /** GET /sync-state, POST /collections/:id/{apply-deletions,rebuild-from-index} (C3). */
  health_page: boolean;
  /** GET /occurrences e /overlays (C3). */
  occurrences: boolean;
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
  // Tranche C (contratto §9.8).
  'PAYLOAD_TOO_LARGE', 'CONFIRMATION_REQUIRED', 'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_CONFLICT',
  'PLAN_CHANGED', 'VERSION_NOT_RESTORABLE', 'NOT_RESTORABLE', 'CALENDAR_NOT_EMPTY', 'NOT_IN_HOLD',
] as const;
export type CalV2ErrorCode = (typeof CAL_V2_ERROR_CODES)[number];

export interface CalV2ErrorBody { error: string; code: CalV2ErrorCode; details?: Record<string, unknown> }

export interface CalV2PreconditionFailedBody {
  error: string;
  code: 'PRECONDITION_FAILED';
  current: CalV2ObjectView;
  conflicts: CalV2FieldConflict[];
}

// ═══ Tranche C (contratto §9, vincolante dalla v1.1) ═══════════════════════════

// ─── Oggetti: editor raw, sposta, duplica (C1) ───────────────────────────────

/** PUT /objects/:id/ics (If-Match esatto). Testo completo dell'oggetto, stesso UID. */
export interface CalV2RawPutRequest {
  ics: string;
  dryRun?: boolean;
}

/** POST /objects/:id/move (If-Match esatto): MOVE della risorsa intera. */
export interface CalV2MoveRequest {
  calendar_id: string;
  dryRun?: boolean;
}

/** POST /objects/:id/duplicate (nessun If-Match): copia come oggetto nuovo. */
export interface CalV2DuplicateRequest {
  /** Componente da copiare ('' = master o evento singolo; default ''). */
  recurrence_key?: string;
  /** Inizio della copia; default l'inizio dell'occorrenza copiata (design §8). La durata resta. */
  start?: CalV2Time;
  /** Default: il calendario dell'originale (se scrivibile). */
  calendar_id?: string;
  /** Generato dall'admin all'apertura dell'azione (retry sicuro come POST /objects). */
  uid?: string;
  /** Solo con recurrence_key '': copia anche RRULE, RDATE, EXDATE e override. Default false (evento singolo). */
  keep_recurrence?: boolean;
  dryRun?: boolean;
}

// ─── Cronologia e cestino (C1) ───────────────────────────────

export const CAL_V2_VERSION_CHANGE_KINDS = ['create', 'update', 'delete', 'restore'] as const;
export type CalV2VersionChangeKind = (typeof CAL_V2_VERSION_CHANGE_KINDS)[number];

/** Una riga di cal_object_versions (90 giorni). */
export interface CalV2VersionSummary {
  id: string;
  object_id: string;
  etag: string | null;
  change_kind: CalV2VersionChangeKind;
  /** Si parsava ed espandeva: solo una versione valida si può ripristinare. */
  valid: boolean;
  /** cal_object_versions.actor così com'è (device, admin:<id>, mcp, agent, system, sync, rebuild, restore) o null. */
  actor: string | null;
  recorded_at: string;
  /** Byte del testo (0 se assente). */
  size_bytes: number;
  /** SUMMARY del master di quella versione (null se illeggibile o assente). */
  summary: string | null;
  /** Campi tipizzati (CalV2FieldName) e 'prop:<NOME>' cambiati rispetto alla versione precedente della lista; [] per la prima. */
  changed_fields: string[];
  /** true per la versione che corrisponde al testo corrente (stesso content_sha256). */
  current: boolean;
  /** Istante oltre il quale la versione viene eliminata (recorded_at + conservazione). */
  expires_at: string;
}

/** GET /objects/:id/versions. Ordine: dalla più recente; al più 200 righe (conservazione 90 giorni). */
export interface CalV2VersionList {
  object_id: string;
  retention_days: number;
  versions: CalV2VersionSummary[];
}

/** GET /objects/:id/versions/:versionId. */
export interface CalV2VersionDetail {
  version: CalV2VersionSummary;
  /** Testo della versione (null solo per un 'delete' senza testo). */
  ics: string | null;
  /** Vista calcolata dal testo della versione (id ed etag dell'oggetto corrente, source 'index'); null se non valida. */
  view: CalV2ObjectView | null;
}

/** POST /objects/:id/restore (If-Match esatto): ripristina una versione sull'oggetto vivo. */
export interface CalV2RestoreRequest {
  version_id: string;
  dryRun?: boolean;
}

export const CAL_V2_TRASH_NOT_RESTORABLE_REASONS = [
  'uid_exists', 'calendar_gone', 'calendar_readonly', 'no_valid_version', 'expired',
] as const;
export type CalV2TrashNotRestorableReason = (typeof CAL_V2_TRASH_NOT_RESTORABLE_REASONS)[number];

/** Oggetto eliminato (cal_object_ids.retired_at con recurrence_key '') con almeno una versione non scaduta. */
export interface CalV2TrashItem {
  object_id: string;
  calendar_id: string;
  /** null se il calendario non esiste più. */
  calendar_name: string | null;
  href: string;
  uid: string | null;
  /** Dalla versione proposta per il ripristino. */
  summary: string | null;
  start_utc: string | null;
  recurring: boolean;
  deleted_at: string;
  /** actor della versione 'delete', se nota. */
  deleted_by: string | null;
  /** Versione proposta: l'ultima valida. null se nessuna è valida. */
  restore_version_id: string | null;
  /** Scadenza della versione proposta (dopo, l'oggetto sparisce dal cestino). */
  expires_at: string;
  restorable: boolean;
  not_restorable_reason: CalV2TrashNotRestorableReason | null;
}

/** GET /trash?calendar_id=&before=&limit= (limit 1-100, default 50). Ordine: deleted_at decrescente. */
export interface CalV2TrashList {
  items: CalV2TrashItem[];
  /** Cursore opaco per `before`; null a fine elenco. */
  next: string | null;
  retention_days: number;
}

/** POST /trash/:objectId/restore. PUT con If-None-Match: * sullo stesso href (stesso id) o nel calendario indicato. */
export interface CalV2TrashRestoreRequest {
  /** Default: restore_version_id dell'item. */
  version_id?: string;
  /** Default: il calendario originale; obbligatorio se non esiste più. */
  calendar_id?: string;
  dryRun?: boolean;
}

// ─── Calendari (C2) ───────────────────────────────

export const CAL_V2_CALENDAR_ROLES = ['user', 'bookings', 'holidays', 'deadlines', 'subscription', 'tasks'] as const;
export type CalV2CalendarRole = (typeof CAL_V2_CALENDAR_ROLES)[number];
/** Ruoli che l'admin può assegnare con POST/PATCH /calendars (gli altri li gestisce il sistema). */
export const CAL_V2_ASSIGNABLE_ROLES = ['user', 'deadlines'] as const satisfies readonly CalV2CalendarRole[];
export type CalV2AssignableRole = (typeof CAL_V2_ASSIGNABLE_ROLES)[number];

export const CAL_V2_COLLECTION_HEALTH = ['healthy', 'stale', 'unsyncable', 'hold'] as const;
export type CalV2CollectionHealth = (typeof CAL_V2_COLLECTION_HEALTH)[number];

export interface CalV2CalendarView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  timezone: string;
  sort_order: number;
  is_default: boolean;
  is_system: boolean;
  role: CalV2CalendarRole;
  origin: 'admin' | 'device' | 'system' | 'migration';
  lifecycle: 'creating' | 'active' | 'deleting';
  components: Array<'VEVENT' | 'VTODO' | 'VJOURNAL'>;
  blocks_availability: boolean;
  /** Collezione Radicale (null per un'iscrizione non specchiata). */
  collection_name: string | null;
  /** URL CalDAV della collezione per i device (null se non visibile ai device). */
  device_url: string | null;
  device_visible: boolean;
  ics_feed_enabled: boolean;
  /** URL pubblico del feed ICS (contiene il token); null se il feed è spento. */
  feed_url: string | null;
  /** 'subscription' (iscrizione) o 'archive' (origin migration): §3.9. */
  readonly_reason: 'subscription' | 'archive' | null;
  /** Badge "nuovo dal dispositivo" (decisione 4): calendars.needs_review. */
  needs_review: boolean;
  review_reason: string | null;
  /** Oggetti attivi nell'indice (VEVENT, VTODO, VJOURNAL). */
  object_count: number;
  sync: {
    health: CalV2CollectionHealth;
    last_synced_at: string | null;
    dirty_since: string | null;
    pending_deletions: number;
    quarantined_count: number;
  } | null;
  /** Eliminabile dall'admin: non di sistema, non predefinito, non 'bookings'/'holidays'. */
  deletable: boolean;
}

/** GET /calendars. Ordine: sort_order, poi nome. */
export interface CalV2CalendarList {
  calendars: CalV2CalendarView[];
}

/** POST /calendars → 201 CalV2CalendarView (MKCALENDAR esplicita di createCalendar). */
export interface CalV2CalendarCreateRequest {
  name: string;
  /** Default: derivato dal nome. ^[a-z0-9][a-z0-9-]{0,62}$ */
  slug?: string;
  description?: string | null;
  /** #RRGGBB */
  color?: string;
  /** IANA; default Europe/Rome. */
  timezone?: string;
  role?: CalV2AssignableRole;
  blocks_availability?: boolean;
  device_visible?: boolean;
  ics_feed_enabled?: boolean;
}

/** PATCH /calendars/:id → 200 CalV2CalendarView (PROPPATCH più sidecar). Almeno un campo. */
export interface CalV2CalendarPatchRequest {
  name?: string;
  description?: string | null;
  color?: string;
  timezone?: string;
  role?: CalV2AssignableRole;
  blocks_availability?: boolean;
  device_visible?: boolean;
  ics_feed_enabled?: boolean;
  /** Solo false: "segna come visto" il calendario nuovo dal dispositivo. */
  needs_review?: false;
}

/** PUT /calendars/order → 200 CalV2CalendarList. Tutti gli id dei calendari, ciascuno una volta. */
export interface CalV2CalendarOrderRequest {
  ids: string[];
}

// ─── Import, export e job (C2) ───────────────────────────────

export const CAL_V2_IMPORT_CONFLICT_MODES = ['skip', 'replace', 'new_uid'] as const;
export type CalV2ImportConflictMode = (typeof CAL_V2_IMPORT_CONFLICT_MODES)[number];

/** POST /calendars/:id/import. dry_run → 200 CalV2ImportPlan; commit (+ Idempotency-Key) → 202 CalV2JobAccepted. */
export interface CalV2ImportRequest {
  /** VCALENDAR completo (≤ 10 MB, ≤ 5000 oggetti dopo il raggruppamento per UID). */
  ics: string;
  mode: 'dry_run' | 'commit';
  on_conflict: CalV2ImportConflictMode;
  /** Obbligatorio con commit: plan_hash del dry_run (piano cambiato → 409 PLAN_CHANGED). */
  plan_hash?: string;
}

export interface CalV2ImportPlanItem {
  /** Posizione dell'oggetto (gruppo per UID) nel file, da 0. */
  index: number;
  uid: string | null;
  action: 'create' | 'replace' | 'skip' | 'new_uid' | 'invalid';
  /** Motivo di skip/new_uid/invalid: 'uid_exists', 'uid_in_other_calendar', 'component_unsupported', 'parse_error', 'too_large', ... */
  reason: string | null;
  summary: string | null;
  start_utc: string | null;
  recurring: boolean;
  issues: CalV2Issue[];
}

export interface CalV2ImportPlan {
  calendar_id: string;
  total: number;
  create: number;
  replace: number;
  skip: number;
  new_uid: number;
  invalid: number;
  /** Tutti gli oggetti, nell'ordine del file (nessun troncamento: il limite è sul file). */
  items: CalV2ImportPlanItem[];
  /** Avvisi del file intero (METHOD rimosso, VTODO ignorati, VTIMEZONE mancanti, ...). In italiano. */
  warnings: string[];
  plan_hash: string;
}

export const CAL_V2_JOB_KINDS = ['calendar_import', 'calendar_hold_apply', 'calendar_hold_rebuild'] as const;
export type CalV2JobKind = (typeof CAL_V2_JOB_KINDS)[number];

/** Risposta 202 di un'azione asincrona (import, applica, ricostruisci). Stessa Idempotency-Key → stesso job. */
export interface CalV2JobAccepted {
  job_id: string;
  /** false se la chiave d'idempotenza ha restituito un job già esistente. */
  created: boolean;
}

export interface CalV2ImportResult {
  created: number;
  replaced: number;
  skipped: number;
  failed: Array<{ index: number; uid: string | null; code: string; message: string }>;
}

export interface CalV2HoldActionResult {
  /** Righe tolte dall'indice (applica) o risorse riscritte in Radicale (ricostruisci). */
  applied: number;
  skipped: number;
  failed: Array<{ href: string; code: string; message: string }>;
  /** Salute della collezione a fine lavoro. */
  collection_health: CalV2CollectionHealth;
}

/** GET /jobs/:jobId (solo i tipi di CAL_V2_JOB_KINDS; altri → 404). Polling dell'admin ogni 2 s. */
export interface CalV2JobView {
  id: string;
  kind: CalV2JobKind;
  status: 'pending' | 'running' | 'done' | 'dead' | 'superseded';
  calendar_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
  progress: { total: number; done: number; failed: number } | null;
  result: CalV2ImportResult | CalV2HoldActionResult | null;
  /** Ultimo errore (codice e messaggio senza testo di evento). */
  error: string | null;
}

// ─── Salute (C3) ───────────────────────────────

export interface CalV2CollectionState {
  calendar_id: string;
  calendar_name: string;
  collection_name: string | null;
  health: CalV2CollectionHealth;
  hold_reason: 'mass-delete' | 'collection-empty' | 'collection-missing' | 'restore-guard' | null;
  hold_since: string | null;
  pending_deletions: number;
  dirty_since: string | null;
  last_synced_at: string | null;
  last_full_sync_at: string | null;
  consecutive_failures: number;
  /** Codice o messaggio tecnico dell'ultimo errore (mai testo di evento). */
  last_error: string | null;
  object_count: number;
  quarantined_count: number;
  sync_in_flight: boolean;
}

export interface CalV2QuarantinedObject {
  object_id: string;
  calendar_id: string;
  href: string;
  uid: string | null;
  health: 'quarantined' | 'pending_404';
  health_reason: string | null;
  since: string;
  /** Esiste un'ultima versione buona (le sue occorrenze bloccano, stale). */
  has_last_good_version: boolean;
}

/** GET /sync-state. Polling dell'admin ogni 20 s. Elenchi completi (nessun troncamento). */
export interface CalV2SyncState {
  generated_at: string;
  mode: CalV2BackendMode;
  write_freeze: boolean;
  writes_suspended: boolean;
  restore_guard_until: string | null;
  identity: {
    status: 'ok' | 'mismatch' | 'unknown';
    volume_id: string | null;
    epoch: number;
    checked_at: string | null;
    reason: string | null;
  };
  heartbeat: { last_at: string | null; age_seconds: number | null; ok: boolean };
  canary: { watch_mode: 'mount' | 'remote' | 'off'; reason: string | null; mount_untrusted: boolean };
  index: { rebuild_required: boolean; horizon_end: string | null; orphan_overrides: number };
  collections: CalV2CollectionState[];
  quarantined: CalV2QuarantinedObject[];
  failed_jobs: Array<{ id: string; kind: string; attempts: number; last_error: string | null; finished_at: string | null }>;
  /** Conflitti di prenotazione aperti (cal_booking_conflicts senza resolved_at). */
  booking_conflicts: Array<{ id: string; booking_id: string; detected_at: string; detected_by: 'post_commit' | 'auditor'; booking_start: string; booking_end: string }>;
  /** Backup coordinato (DB + volume): ultima esecuzione registrata. */
  backup: { last_stack_backup_at: string | null; age_hours: number | null; stale: boolean };
}

/** Testo da digitare per confermare le azioni sulla collezione in hold (commit). */
export const CAL_V2_HOLD_CONFIRMATIONS = {
  apply_deletions: 'APPLICA CANCELLAZIONI',
  rebuild_from_index: 'RICOSTRUISCI',
} as const;

/**
 * POST /collections/:id/apply-deletions e /rebuild-from-index.
 * dry_run → 200 CalV2HoldPlan; commit (+ Idempotency-Key, confirm, plan_hash) → 202 CalV2JobAccepted.
 */
export interface CalV2HoldActionRequest {
  mode: 'dry_run' | 'commit';
  /** Solo commit: CAL_V2_HOLD_CONFIRMATIONS[azione]. */
  confirm?: string;
  /** Solo commit: plan_hash del dry_run. */
  plan_hash?: string;
  /** Sottoinsieme delle cancellazioni sospese; default tutte. */
  hrefs?: string[];
}

export interface CalV2HoldPlanItem {
  href: string;
  object_id: string | null;
  uid: string | null;
  summary: string | null;
  /** Versione che "ricostruisci" riscriverebbe (ultima valida); null se non c'è. */
  version_id: string | null;
  action: 'remove_from_index' | 'put_to_radicale' | 'skip';
  /** Motivo dello skip: 'no_valid_version', 'present_in_radicale', 'expired', ... */
  reason: string | null;
}

export interface CalV2HoldPlan {
  calendar_id: string;
  action: 'apply_deletions' | 'rebuild_from_index';
  hold_reason: CalV2CollectionState['hold_reason'];
  total: number;
  items: CalV2HoldPlanItem[];
  plan_hash: string;
}

// ─── Vista (C3) ───────────────────────────────

export const CAL_V2_OCCURRENCE_KINDS = [
  'event', 'override', 'orphan_override', 'conservative', 'booking_projection', 'holiday_system', 'closure',
] as const;
export type CalV2OccurrenceKind = (typeof CAL_V2_OCCURRENCE_KINDS)[number];

export const CAL_V2_OCCURRENCE_BADGES = ['orphan', 'quarantined', 'hold', 'conservative', 'new_from_device'] as const;
export type CalV2OccurrenceBadge = (typeof CAL_V2_OCCURRENCE_BADGES)[number];

/** Finestra massima di GET /occurrences e /overlays (to − from). */
export const CAL_V2_OCCURRENCE_MAX_WINDOW_DAYS = 100;

export interface CalV2Occurrence {
  object_id: string;
  /** Componente che produce l'istanza; null per il blocco conservativo. */
  component_id: string | null;
  /** Chiave dell'istanza ('' = evento singolo; 'conservative' per il blocco conservativo). */
  recurrence_key: string;
  calendar_id: string;
  start_utc: string;
  end_utc: string;
  all_day: boolean;
  /** Solo all-day: YYYY-MM-DD, fine esclusiva. */
  start_date: string | null;
  end_date: string | null;
  summary: string | null;
  location: string | null;
  /** COLOR dell'evento; null = colore del calendario. */
  color: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  transp: 'OPAQUE' | 'TRANSPARENT';
  blocks: boolean;
  kind: CalV2OccurrenceKind;
  recurring: boolean;
  /** Occorrenza dell'ultima versione buona di un oggetto in quarantena. */
  stale: boolean;
  readonly_reason: CalV2ReadonlyReason | null;
  /** Prenotazione proiettata (kind booking_projection), se nota. */
  booking_id: string | null;
  badges: CalV2OccurrenceBadge[];
}

/** GET /occurrences?from&to&calendar_id (calendar_id ripetibile; assente = tutti tranne holidays e subscription). */
export interface CalV2OccurrenceList {
  from: string;
  to: string;
  /** Tutte le occorrenze che intersecano [from, to), ordinate per start_utc: nessun troncamento. */
  occurrences: CalV2Occurrence[];
  /** Calendari con collezione non sana (dati forse non aggiornati). */
  stale_calendar_ids: string[];
}

export interface CalV2OverlayItem {
  source: 'holiday' | 'closure' | 'subscription';
  calendar_id: string;
  object_id: string;
  recurrence_key: string;
  start_utc: string;
  end_utc: string;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
  summary: string | null;
  color: string | null;
  blocks: boolean;
}

/** GET /overlays?from&to: festività, chiusure e iscrizioni, in sola lettura, senza troncamento. */
export interface CalV2OverlayList {
  from: string;
  to: string;
  items: CalV2OverlayItem[];
}
