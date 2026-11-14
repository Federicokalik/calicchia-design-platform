/**
 * Modello dell'indice derivato del calendario (fase F2 del passaggio a
 * Radicale; migrazioni 163 e 164, design §4-§9, contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §2).
 *
 * Tipi delle righe, costanti, chiavi dei lock e dei canali e formato delle
 * recurrence key condivisi da tutti i moduli che leggono o scrivono l'indice:
 * indicizzatore, sync, store, busy, iscrizioni, feed e salute.
 *
 * Le regole iCalendar NON stanno qui ma in @calicchia/calendar-core
 * (model.ts), unica fonte per indicizzatore, busy al volo e admin:
 * deriveProvenance (provenienza da ruolo e href, design §5),
 * classifyOccurrenceKind (kind), computeBlocks (regola blocks, design §9),
 * recurrenceKeyOf / parseRecurrenceKey (chiavi), expandObject (espansione,
 * tetto e budget) e i limiti di validate.ts. Una seconda copia qui
 * divergerebbe.
 *
 * Il modulo è puro: niente I/O, niente database, niente orologio implicito.
 * I valori degli enum coincidono con i CHECK della 163 e della 164 (test in
 * apps/api/test/calendar/index-migrations.test.ts).
 */

import type { CalendarEventSource, CalendarEventStatus } from './types';

// ─── Enum allineati ai CHECK delle migrazioni ───────────────

/** cal_occurrences.kind (design §4). */
export const OCCURRENCE_KINDS = [
  'event',
  'override',
  'orphan_override',
  'conservative',
  'booking_projection',
  'holiday_system',
  'closure',
] as const;
export type OccurrenceKind = (typeof OCCURRENCE_KINDS)[number];

/** cal_objects.health (design §6.5). */
export const OBJECT_HEALTH_STATES = ['ok', 'quarantined', 'pending_404'] as const;
export type ObjectHealth = (typeof OBJECT_HEALTH_STATES)[number];

/** cal_collection_state.health (design §6.5). */
export const COLLECTION_HEALTH_STATES = ['healthy', 'stale', 'unsyncable', 'hold'] as const;
export type CollectionHealth = (typeof COLLECTION_HEALTH_STATES)[number];

/** cal_objects.origin_store, cal_collection_state.origin_store. */
export const ORIGIN_STORES = ['radicale', 'remote'] as const;
export type OriginStore = (typeof ORIGIN_STORES)[number];

/** cal_objects.component ('UNKNOWN' = testo senza componente riconoscibile). */
export const OBJECT_COMPONENTS = ['VEVENT', 'VTODO', 'VJOURNAL', 'UNKNOWN'] as const;
export type ObjectComponent = (typeof OBJECT_COMPONENTS)[number];

/** cal_object_versions.change_kind. */
export const VERSION_CHANGE_KINDS = ['create', 'update', 'delete', 'restore'] as const;
export type VersionChangeKind = (typeof VERSION_CHANGE_KINDS)[number];

/** cal_objects.source: stessi valori di CalendarEventSource (contratto legacy). */
export const EVENT_SOURCES = ['manual', 'booking', 'admin', 'mcp', 'agent', 'ics_pull', 'system'] as const satisfies readonly CalendarEventSource[];

/** Stati legacy delle componenti e delle occorrenze. */
export const COMPONENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const satisfies readonly CalendarEventStatus[];

/** cal_booking_conflicts.detected_by. */
export const CONFLICT_DETECTORS = ['post_commit', 'auditor'] as const;
export type ConflictDetector = (typeof CONFLICT_DETECTORS)[number];

/**
 * Motivi di quarantena di un oggetto (cal_objects.health_reason). Elenco
 * aperto: il CHECK ammette qualsiasi codice `^[a-z][a-z0-9_-]{0,63}$`, questi
 * sono quelli che i moduli della F2 producono e che la salute sa spiegare.
 */
export const HEALTH_REASONS = {
  /** Il testo non si parsa come iCalendar. */
  parseError: 'parse-error',
  /** Radicale salta il file (skip_broken_item: 404 nella sync con il file su disco). */
  radicaleSkip: 'radicale-skip',
  /** Budget di 200k iterazioni esaurito prima dell'orizzonte (design §6.4). */
  expansionBudget: 'expansion-budget',
  /** RRULE non valida (anche da un feed remoto). */
  invalidRrule: 'invalid-rrule',
  /** File non leggibile dal mount o oltre la dimensione massima. */
  unreadable: 'unreadable',
  tooLarge: 'too-large',
  /** Nessun VEVENT/VTODO/VJOURNAL riconoscibile. */
  noComponent: 'no-component',
  /** Più UID diversi nella stessa risorsa (RFC 4791 §4.1). */
  mixedUids: 'mixed-uids',
} as const;
export type HealthReason = (typeof HEALTH_REASONS)[keyof typeof HEALTH_REASONS];

// ─── Limiti e tempi (design §6, §8, §16.5) ───────────────
// Tetto delle occorrenze (5000), budget di espansione (200k), stima di
// Radicale (50000) e dimensione massima (1 MB) sono di calendar-core
// (expand.ts e validate.ts): non duplicarli qui.

export const INDEX_LIMITS = Object.freeze({
  /** Href per REPORT calendar-multiget (§6.2 passo 4). */
  multigetBatch: 100,
  /** Oltre questo numero di oggetti il parse va in worker_threads (§6.2 passo 7). */
  workerThreadsThreshold: 200,
  /** Interruttore anti-cancellazione: max(50 oggetti, 20%) della collezione (§6.2 passo 6). */
  massDeleteMinObjects: 50,
  massDeleteRatio: 0.2,
  /** PUT complessive al secondo degli scrittori di sistema (§8) e dello specchio delle iscrizioni (§6.6). */
  maxSystemPutsPerSecond: 20,
  maxMirrorPutsPerSecond: 5,
  /** Oggetti per collezione oltre i quali la salute avvisa (§16.5). */
  collectionObjectsWarning: 5_000,
});

export const INDEX_TIMING = Object.freeze({
  /** Campanello: stat delle directory (§6.1). */
  watcherIntervalMs: 1_000,
  /** Canary e statfs (§6.1). */
  canaryIntervalMs: 600_000,
  /** La mtime deve cambiare via mount entro questo tempo dalla risposta della PUT del canary. */
  canaryMtimeWindowMs: 100,
  /** Remote mode: PROPFIND Depth:1 sul principal (§6.1). */
  remotePrincipalPollMs: 30_000,
  /** Remote mode: budget complessivo dei PROPFIND Depth:0 nelle decisioni (§6.1). */
  remoteDecisionBudgetMs: 2_000,
  /** Freshness dentro la sezione critica delle prenotazioni (§9). */
  freshnessBudgetMs: 2_500,
  /** dir_mtime_ns si salva solo se più vecchia di questo margine rispetto all'osservazione (§6.2 passo 10). */
  racyWindowMs: 50,
  /** Modifiche non indicizzate oltre questo tempo → collezione 'stale' (§6.5). */
  staleAfterMs: 120_000,
  /** Collezione bloccante 'unsyncable' da oltre questo tempo → 503 anche nel livello display (§6.5, §7). */
  unsyncableDisplayGraceMs: 600_000,
  /** Finestra in cui un UID sparito in A e comparso in B conserva l'id (§5). */
  moveWindowMs: 30 * 86_400_000,
  /** Retention delle versioni (§4). */
  versionsRetentionMs: 90 * 86_400_000,
});

/** Orizzonte di cal_occurrences (design §6.9): [oggi − 400 g, oggi + 800 g]. */
export const HORIZON = Object.freeze({
  pastDays: 400,
  futureDays: 800,
  /** Garanzia statica: horizon_end ≥ oggi + max(max_advance_days) + 14 g. */
  safetyDays: 14,
});

// ─── Lock, canali e nomi ─────────────────────────────────────

/**
 * Chiavi degli advisory lock del calendario, da passare a hashtext() in SQL
 * (stesso schema di 'cal-week-…' in booking.ts):
 *   SELECT pg_advisory_lock_shared(hashtext(${CAL_LOCKS.write}))
 */
export const CAL_LOCKS = Object.freeze({
  /** Gate delle scritture (§8 passo 2): shared per le scritture, exclusive per le transizioni (§13.9). */
  write: 'cal-write',
  /** Strumento di migrazione (§13.2). */
  migration: 'cal-migration',
  /** Scrittori dell'indice di una collezione (sync, rimaterializzazione, rebuild, pull di un'iscrizione). */
  collection: (calendarId: string): string => `cal-sync:${calendarId.toLowerCase()}`,
  /** Rebuild completo dell'indice (§6.7). */
  rebuild: 'cal-rebuild',
});

/** Canali di LISTEN/NOTIFY del calendario. */
export const CAL_CHANNELS = Object.freeze({
  /** 162: stato del backend o sidecar cambiati (payload {"source": "state"|"sidecar"}). */
  policy: 'calendar_policy_changed',
  /** 163: index_version di una collezione salita (payload {"calendar_id", "index_version"}). */
  index: 'calendar_index_changed',
  /** 164: job accodato. */
  jobs: 'calendar_jobs',
});

// ─── Righe delle tabelle ─────────────────────────────────────
// postgres-js restituisce timestamptz come Date e int8 come stringa.

export interface CalObjectIdRow {
  id: string;
  calendar_id: string;
  href: string;
  recurrence_key: string;
  uid: string | null;
  legacy_event_id: string | null;
  legacy_uid: string | null;
  created_at: Date;
  updated_at: Date;
  retired_at: Date | null;
}

export interface CalObjectVersionRow {
  id: string;
  object_id: string;
  calendar_id: string;
  href: string;
  etag: string | null;
  raw_ics: string | null;
  content_sha256: string | null;
  semantic_fp: string | null;
  change_kind: VersionChangeKind;
  valid: boolean;
  actor: string | null;
  created_at: Date;
}

export interface CalCollectionStateRow {
  calendar_id: string;
  origin_store: OriginStore;
  sync_token: string | null;
  /** int8 come stringa (nanosecondi). */
  dir_mtime_ns: string | null;
  last_synced_at: Date | null;
  last_full_sync_at: Date | null;
  last_attempt_at: Date | null;
  consecutive_failures: number;
  last_error: string | null;
  health: CollectionHealth;
  health_since: Date;
  dirty_since: Date | null;
  pending_deletions: string[];
  hold_reason: string | null;
  hold_since: Date | null;
  object_count: number;
  quarantined_count: number;
  /** int8 come stringa. */
  index_version: string;
  horizon_start: Date | null;
  horizon_end: Date | null;
  updated_at: Date;
}

export interface CalObjectRow {
  id: string;
  calendar_id: string;
  href: string;
  uid: string | null;
  etag: string | null;
  component: ObjectComponent;
  raw_ics: string | null;
  content_sha256: string | null;
  semantic_fp: string | null;
  origin_store: OriginStore;
  range_start: Date | null;
  range_end: Date | null;
  is_recurring: boolean;
  materialized_until: Date | null;
  health: ObjectHealth;
  health_reason: string | null;
  health_since: Date | null;
  pending_404_count: number;
  last_good_version_id: string | null;
  source: CalendarEventSource;
  source_id: string | null;
  x_source: string | null;
  x_source_id: string | null;
  size_bytes: number | null;
  first_seen_at: Date;
  changed_at: Date;
}

export interface CalComponentRow {
  id: string;
  object_id: string;
  calendar_id: string;
  recurrence_key: string;
  component: 'VEVENT' | 'VTODO' | 'VJOURNAL';
  uid: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
  status: CalendarEventStatus;
  transp: 'OPAQUE' | 'TRANSPARENT' | null;
  class: string | null;
  start_utc: Date | null;
  end_utc: Date | null;
  all_day: boolean;
  /** date come stringa YYYY-MM-DD se il chiamante la converte; postgres-js restituisce Date. */
  start_date: Date | string | null;
  end_date: Date | string | null;
  tzid: string | null;
  floating: boolean;
  rrule: string | null;
  rdates: string[];
  exdates: string[];
  recurrence_id_utc: Date | null;
  orphan: boolean;
  sequence: number | null;
  dtstamp: Date | null;
  created: Date | null;
  last_modified: Date | null;
  x_source: string | null;
  x_source_id: string | null;
  has_alarms: boolean;
  has_attendees: boolean;
}

export interface CalOccurrenceRow {
  object_id: string;
  recurrence_key: string;
  component_id: string | null;
  calendar_id: string;
  start_utc: Date;
  end_utc: Date;
  start_date: Date | string | null;
  end_date: Date | string | null;
  all_day: boolean;
  status: CalendarEventStatus;
  transp: 'OPAQUE' | 'TRANSPARENT';
  kind: OccurrenceKind;
  blocks: boolean;
  stale: boolean;
}

// ─── Chiavi di ricorrenza (design §6.4; 163) ─────────────────
// Stesso formato di recurrenceKeyOf() di @calicchia/calendar-core, che resta
// la fonte per i valori iCalendar (IcsTime). Qui solo formattazione e
// controllo, per chi lavora con istanti e date già risolti (SQL, adattatori
// legacy, busy, conflitti).

/** Chiave della risorsa intera o di un evento singolo. */
export const MASTER_RECURRENCE_KEY = '';
/** Chiave del blocco conservativo di un oggetto illeggibile (solo cal_occurrences). */
export const CONSERVATIVE_RECURRENCE_KEY = 'conservative';

/** '' | YYYYMMDD | YYYYMMDDTHHMMSSZ | YYYYMMDDTHHMMSS (stesso CHECK di cal_object_ids e cal_components). */
export const RECURRENCE_KEY_RE = /^(?:[0-9]{8}|[0-9]{8}T[0-9]{6}Z?)?$/;

export type ParsedRecurrenceKey =
  | { kind: 'master' }
  | { kind: 'conservative' }
  | { kind: 'date'; date: string }
  | { kind: 'instant'; utc: Date }
  /** Ora da muro di un'istanza floating, 'YYYY-MM-DDTHH:MM:SS' (nel fuso del calendario). */
  | { kind: 'floating'; wall: string };

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/**
 * Chiave di un'istanza timed con TZID o in UTC: istante UTC al secondo (i
 * millisecondi si troncano, come l'espansione RRULE).
 */
export function recurrenceKeyForInstant(instant: Date): string {
  const t = instant.getTime();
  if (!Number.isFinite(t)) throw new RangeError('recurrenceKeyForInstant: istante non valido');
  const d = new Date(Math.floor(t / 1000) * 1000);
  const y = d.getUTCFullYear();
  if (y < 1 || y > 9999) throw new RangeError('recurrenceKeyForInstant: anno fuori intervallo');
  return `${pad(y, 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function assertRealDate(y: number, mo: number, d: number, what: string): void {
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1000 || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new RangeError(`${what}: data inesistente`);
  }
}

/** Chiave di un'istanza all-day: la data locale (VALUE=DATE), da 'YYYY-MM-DD' o 'YYYYMMDD'. */
export function recurrenceKeyForDate(date: string): string {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`recurrenceKeyForDate: data non valida: ${JSON.stringify(date)}`);
  assertRealDate(Number(m[1]), Number(m[2]), Number(m[3]), `recurrenceKeyForDate(${JSON.stringify(date)})`);
  return `${m[1]}${m[2]}${m[3]}`;
}

/** Chiave di un'istanza floating dall'ora da muro 'YYYY-MM-DDTHH:MM:SS' (o già compatta). */
export function recurrenceKeyForFloating(wall: string): string {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})$/.exec(wall);
  if (!m) throw new RangeError(`recurrenceKeyForFloating: ora da muro non valida: ${JSON.stringify(wall)}`);
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  assertRealDate(y, mo, d, 'recurrenceKeyForFloating');
  if (h > 23 || mi > 59 || se > 59) throw new RangeError('recurrenceKeyForFloating: ora inesistente');
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}`;
}

/** Interpreta una chiave; lancia RangeError se non rispetta il formato. */
export function parseRecurrenceKey(key: string): ParsedRecurrenceKey {
  if (key === MASTER_RECURRENCE_KEY) return { kind: 'master' };
  if (key === CONSERVATIVE_RECURRENCE_KEY) return { kind: 'conservative' };
  if (/^[0-9]{8}$/.test(key)) {
    const date = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
    recurrenceKeyForDate(date);
    return { kind: 'date', date };
  }
  const m = /^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})(Z?)$/.exec(key);
  if (!m) throw new RangeError(`recurrence_key non valida: ${JSON.stringify(key)}`);
  if (m[7] !== 'Z') {
    const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    recurrenceKeyForFloating(wall);
    return { kind: 'floating', wall };
  }
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (y < 1000 || recurrenceKeyForInstant(utc) !== key) throw new RangeError(`recurrence_key inesistente: ${JSON.stringify(key)}`);
  return { kind: 'instant', utc };
}

// ─── Orizzonte (design §6.9) ─────────────────────────────────

const DAY_MS = 86_400_000;

/** Inizio del giorno UTC di `now`. */
function utcDayStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Orizzonte obiettivo per `now`: [oggi − 400 g, oggi + 800 g], allineato al giorno UTC. */
export function targetHorizon(now: Date): { start: Date; end: Date } {
  const day = utcDayStart(now);
  return { start: new Date(day - HORIZON.pastDays * DAY_MS), end: new Date(day + HORIZON.futureDays * DAY_MS) };
}

/** Fine minima dell'orizzonte per le decisioni: oggi + max(max_advance_days) + 14 g. */
export function requiredHorizonEnd(now: Date, maxAdvanceDays: number): Date {
  const days = Math.max(0, Math.ceil(Number.isFinite(maxAdvanceDays) ? maxAdvanceDays : 0));
  return new Date(now.getTime() + (days + HORIZON.safetyDays) * DAY_MS);
}

// ─── int8 di postgres-js ─────────────────────────────────────

/** int8 restituito come stringa (o null) → bigint (o null). */
export function int8(value: string | number | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? value : BigInt(value);
}
