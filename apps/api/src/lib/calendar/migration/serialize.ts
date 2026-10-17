/**
 * Serializer della migrazione a Radicale (fase F3 del piano; design §5,
 * §10, §13.4-§13.5; contratto docs/calendar-radicale/contracts/f3-modules.md
 * §4 e §6.2).
 *
 * Trasforma le righe legacy di calendar_events e le prenotazioni di
 * calendar_bookings in oggetti iCalendar per le collezioni di Radicale,
 * con @calicchia/calendar-core. È l'unica implementazione della
 * trasformazione: la usano l'anteprima (plan.ts), l'apply, lo shadow mirror,
 * la verifica e l'inventario.
 *
 * Proprietà fondamentali:
 *  - DETERMINISMO. `serializeLegacy` è pura: stesso ingresso, stesse opzioni
 *    e stesso `now` (che vale solo per DTSTAMP, la minimizzazione delle
 *    proiezioni dopo 24 mesi e l'orizzonte della validazione) → stessi
 *    oggetti, stessi fingerprint e stessi hash;
 *  - SNAPSHOT CANONICO. Ogni oggetto porta il proprio `legacy_snapshot`
 *    (righe legacy del master e dei suoi override, o dell'override staccato,
 *    o i soli dati della decisione 3 per le proiezioni, più il calendario e le
 *    opzioni che hanno cambiato l'uscita): `buildObjectFromSnapshot` ricostruisce
 *    dallo snapshot lo stesso contenuto semantico. `legacy_hash` =
 *    `s<SERIALIZER_VERSION>:<sha256(canonicalJson(snapshot))>`: cambia solo
 *    quando cambia ciò che entra nell'oggetto;
 *  - IDENTITÀ STABILE. Gli href già noti (riga viva del ledger, poi
 *    cal_object_ids) si riusano sempre; gli UID legacy restano quelli di oggi;
 *    `object_ids` preassegna in cal_object_ids l'id legacy di ogni risorsa e
 *    override e `legacy_uid` per OGNI oggetto migrato, così il feed pubblica
 *    gli stessi UID (anche con '@') e gli id di list_events restano validi;
 *  - NESSUNA SCRITTURA. Il serializer non scrive nulla (`loadLegacySource`
 *    legge in una transazione REPEATABLE READ READ ONLY).
 *
 * Regole (design §13.5, contratto §6.2):
 *  - un oggetto per master con i suoi override; override cancellati → EXDATE;
 *  - override orfani (RECURRENCE-ID fuori dalla regola, master singolo o con
 *    RRULE non valida, RECURRENCE-ID duplicati) → evento singolo staccato
 *    `<uid>-det-<epoch>` (opzione `orphans: convert`) o salto ORPHAN_DISCARDED;
 *  - serie timed in TZID=Europe/Rome (LEGACY_SERIES_TZ), singoli nel fuso del
 *    calendario, all-day come VALUE=DATE con la data calcolata con +12 h;
 *  - RRULE non valida → evento singolo con X-CALDES-LEGACY-RRULE; UNTIL
 *    precedente al DTSTART → salto; serie oltre i limiti di Radicale → salto
 *    INVALID_OBJECT con l'anomalia RADICALE_RRULE_LIMIT;
 *  - UNTIL "fino al" salvato a mezzanotte UTC → fine della giornata di Roma
 *    (opzione, ON); eccezioni con la firma del codice precedente al fix DST →
 *    riallineate con lo stesso criterio di scripts/fix-dst-exceptions.ts
 *    (opzione, ON), sulla griglia di calendar-core (quella dei device);
 *  - provenienza X-CALDES-SOURCE, -SOURCE-ID (copie di "Duplica"), -LEGACY-ID;
 *  - festività `source='system'` → `it-holiday-YYYY-MM-DD.ics`, altre righe di
 *    una collezione holidays → `closure-<uuid>.ics`, entrambe con l'UID legacy;
 *    festività duplicate per data → si migra la prima;
 *  - proiezioni rigenerate da calendar_bookings con buildBookingProjectionIcs
 *    (stesso testo del job project_booking, decisione 3), legate alla riga
 *    legacy `source='booking'` (id e legacy_uid), solo per gli stati
 *    proiettati; minimizzate oltre 24 mesi dalla fine o se anonimizzate;
 *  - eventi non-proiezione del calendario Prenotazioni: restano lì
 *    (decisione 8), salvo gli id di `bookings_move_event_ids`, spostati solo
 *    nella destinazione Radicale (lo strumento non scrive mai calendar_events);
 *  - master cancellato → salto CANCELLED_MASTER; validateObject su ogni oggetto.
 *
 * Nessun dato personale nei dettagli delle anomalie: id, UID, date, codici e
 * titoli dei soli eventi non di prenotazione (contratto §1.4 regola 5).
 */

import { createHash } from 'node:crypto';
import {
  applyPatch,
  bookingHref,
  bookingProjectionContent,
  bookingProjectionUid,
  buildEventFromLegacy,
  checkBase,
  closureHref,
  cloneCalendarObject,
  componentRecurrenceKey,
  createCalendarObject,
  createProperty,
  DEFAULT_TZ,
  diffFieldValues,
  encodeText,
  expandObject,
  type CalendarObject,
  type FieldConflict,
  findOrphanOverrides,
  getProperties,
  getProperty,
  getTextValue,
  holidayHref,
  ianaZone,
  type IcsComponent,
  type IcsProperty,
  type IcsTime,
  isBookingProjectionExpired,
  isValidIanaZone,
  LEGACY_SERIES_TZ,
  legacyAllDayToRange,
  localDateOf,
  type LegacyEventFields,
  type LegacyEventSource,
  MASTER_RECURRENCE_KEY,
  materializeOverride,
  offsetAt,
  opsFromLegacyDiff,
  parseCalendarObject,
  parseObjectHref,
  type PatchFieldName,
  type PatchOp,
  readFieldValues,
  readTimeProperty,
  removeProperties,
  semanticFingerprint,
  serializeObject,
  setTextValue,
  toLegacyEventFields,
  validateObject,
  X_CALDES,
  zonedToUtc,
} from '@calicchia/calendar-core';
import { bookingProjectionContentFor, buildBookingProjectionIcs, PROJECTED_BOOKING_STATUSES, RETAINED_PROJECTION_SUMMARY } from '../booking-projection';
import { expandRRule, validateRRule } from '../legacy/rrule-legacy';
import { resolveLocationForBooking } from '../meeting-url';
import { isValidObjectName } from '../radicale/client';
import { deterministicObjectId } from '../radicale/ids';
import type { Db } from '../radicale/policy';
import type { BookingStatus, EventType } from '../types';
import { loadMigrationCalendars } from './inventory';
import {
  type AnomalyCode,
  type AnomalyRecord,
  ANOMALY_DEFINITIONS,
  type CalendarSnapshot,
  type ExpectedDiffReason,
  type LedgerKind,
  type LedgerRow,
  type LegacyBookingSnapshot,
  type LegacyDetachedSnapshot,
  type LegacyEventRowSnapshot,
  type LegacyEventSnapshot,
  type LegacyKey,
  legacyKey,
  type MigrationCalendar,
  type MigrationOptions,
  type MigrationScope,
  parseLegacyKey,
  type ReservedObjectId,
  type SerializationResult,
  type SerializedObject,
  type SkipCode,
  type SkippedSource,
  type SnapshotOptions,
  type LegacySnapshot,
} from './types';

// ─── Versione e tipi ───────────────────────────────

/**
 * Versione del serializer: entra in ogni legacy_hash. Si alza quando cambia
 * il testo prodotto per lo stesso snapshot (il piano successivo propone gli
 * update; quelli con lo stesso fingerprint diventano adozioni senza scrittura).
 */
export const SERIALIZER_VERSION = 1;

/** Sorgente letta in una sola istantanea (transazione REPEATABLE READ READ ONLY sul pool principale). */
export interface LegacySource {
  read_at: Date;
  calendars: MigrationCalendar[];
  /** Righe di calendar_events dei calendari inclusi, tranne source='ics_pull'. */
  events: Array<LegacyEventRowSnapshot & { created_at: string; updated_at: string }>;
  /** Prenotazioni con il titolo del tipo e il link della riunione già risolti (resolveLocationForBooking senza Google). */
  bookings: Array<{ uid: string; status: string; start_time: string; end_time: string; title: string; attendee_name: string; attendee_phone: string | null; location: string | null; meeting_url: string | null; created_at: string; anonymized: boolean }>;
  /** cal_object_ids per legacy_event_id (riuso degli href e degli id). */
  objectIds: ReadonlyMap<string, { calendar_id: string; href: string; recurrence_key: string; id: string; legacy_uid: string | null }>;
  /** Righe vive del ledger (riuso degli href). */
  ledger: readonly LedgerRow[];
}

type SourceEventRow = LegacySource['events'][number];
type SourceBookingRow = LegacySource['bookings'][number];

/** Oggetto costruito da uno snapshot: albero, testo canonico e fingerprint semantico del testo. */
export interface BuiltObject {
  object: CalendarObject;
  ics: string;
  fingerprint: string;
}

/** CREATED e LAST-MODIFIED delle righe (non entrano nel diff per campo, solo nel testo). */
export interface BuildStamps {
  created?: Date | null;
  lastModified?: Date | null;
}

export type StampLookup = (rowId: string) => BuildStamps | undefined;

/** Fuso in cui il legacy espande (rrule.ts): la griglia delle eccezioni DST. */
const ROME = LEGACY_SERIES_TZ;

/** Codici di validateObject che rendono la RRULE non valida (evento singolo con X-CALDES-LEGACY-RRULE). */
const RULE_INVALID_CODES: ReadonlySet<string> = new Set(['RRULE_INVALID', 'RRULE_FREQ_NOT_ALLOWED', 'RRULE_COUNT_AND_UNTIL', 'UNTIL_TYPE_MISMATCH']);

/** Codici di validateObject dei limiti di Radicale e dell'indice (serie non migrata, anomalia RADICALE_RRULE_LIMIT). */
const RULE_LIMIT_CODES: ReadonlySet<string> = new Set(['RADICALE_LIMIT', 'TOO_MANY_INSTANCES']);

/** UNTIL dell'editor admin: mezzanotte UTC del giorno "fino al" (buildRRule con until 'YYYY-MM-DD'). */
const UNTIL_UTC_MIDNIGHT_RE = /(^|;)UNTIL=(\d{4})(\d{2})(\d{2})T000000Z(?=;|$)/i;

/** UID legacy usabile come nome di risorsa (stessa regola di RadicaleStore.hrefForUid). */
const SAFE_UID_HREF_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,200}$/;

/** UUID (id legacy delle righe di calendar_events). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** source_id delle festività di sistema. */
const HOLIDAY_SOURCE_ID_RE = /^it-holiday-(\d{4}-\d{2}-\d{2})$/;

/** Istante di contenuto che non fa mai scattare la scadenza dei 24 mesi (ricostruzione di uno snapshot non minimizzato). */
const RETENTION_NEUTRAL_NOW = new Date(0);

/** Massimo di elementi negli elenchi dei dettagli delle anomalie. */
const DETAIL_LIST_MAX = 20;

/** Campi della patch che lo strumento possiede sugli override (shadow e update delle righe adottate). */
const OVERRIDE_FIELDS: readonly PatchFieldName[] = ['summary', 'description', 'location', 'url', 'status', 'start', 'end'];

/** Campi della decisione 3 di una proiezione (contratto §6.2). */
const PROJECTION_FIELDS: readonly PatchFieldName[] = ['summary', 'description', 'location', 'url', 'start', 'end', 'status'];

/** X-prop della provenienza confrontate dallo shadow (le altre X-* dei device restano). */
const PROVENANCE_XPROPS: readonly string[] = [X_CALDES.SOURCE, X_CALDES.SOURCE_ID, X_CALDES.LEGACY_ID, X_CALDES.LEGACY_RRULE];

// ─── Utilità pure ───────────────────────────────

/**
 * JSON canonico: chiavi ordinate a ogni livello, `undefined` omessi negli
 * oggetti e null negli array, Date come ISO. Base di legacy_hash e degli hash
 * del piano.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: numero non finito');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  return JSON.stringify(value);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `s<SERIALIZER_VERSION>:<sha256 del JSON canonico dello snapshot>`. */
export function legacyHash(snapshot: LegacySnapshot): string {
  return `s${SERIALIZER_VERSION}:${sha256Hex(canonicalJson(snapshot))}`;
}

function isoOf(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(d.getTime())) throw new TypeError(`istante non valido: ${String(value).slice(0, 40)}`);
  return d.toISOString();
}

function msOf(value: string): number {
  return Date.parse(value);
}

const secondKey = (ms: number): number => Math.floor(ms / 1000);

/** Fuso IANA valido o DEFAULT_TZ (come l'espansione con un fuso sconosciuto). */
function safeTz(tz: string | null | undefined): string {
  return tz && isValidIanaZone(tz) ? tz : DEFAULT_TZ;
}

function calendarSnapshot(cal: MigrationCalendar): CalendarSnapshot {
  return { id: cal.id, collection_name: cal.collection_name ?? '', timezone: safeTz(cal.timezone), role: cal.role };
}

/** exdates legacy (JSONB) → elenco ordinato e senza duplicati, ISO per i valori leggibili (gli altri restano: non escludono nulla). */
export function normalizeLegacyExdates(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string' || v.trim() === '') continue;
    const ms = Date.parse(v);
    out.add(Number.isFinite(ms) ? new Date(ms).toISOString() : v);
  }
  return [...out].sort();
}

function validIsoList(values: readonly string[]): string[] {
  return values.filter((v) => Number.isFinite(Date.parse(v)));
}

/** Insieme ordinato di istanti ISO unici al secondo (come il confronto legacy di exdates). */
function uniqueBySecond(values: readonly string[]): string[] {
  const seen = new Map<number, string>();
  for (const v of values) {
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) continue;
    const key = secondKey(ms);
    if (!seen.has(key)) seen.set(key, new Date(key * 1000).toISOString());
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, iso]) => iso);
}

function formatUtcCompact(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function capped<T>(list: readonly T[]): T[] {
  return list.slice(0, DETAIL_LIST_MAX);
}

function legacySourceOf(source: string): LegacyEventSource {
  return source as LegacyEventSource;
}

/** Il dettaglio del calendario di destinazione di un evento migrato. */
function rowSnapshot(row: SourceEventRow | LegacyEventRowSnapshot): LegacyEventRowSnapshot {
  return {
    id: row.id,
    uid: row.uid,
    calendar_id: row.calendar_id,
    summary: row.summary,
    description: row.description,
    location: row.location,
    url: row.url,
    start_time: row.start_time,
    end_time: row.end_time,
    all_day: row.all_day,
    rrule: row.rrule,
    exdates: [...row.exdates],
    recurrence_id: row.recurrence_id,
    recurrence_master_id: row.recurrence_master_id,
    source: row.source,
    source_id: row.source_id,
    status: row.status,
  };
}

function byRecurrenceThenId(a: LegacyEventRowSnapshot, b: LegacyEventRowSnapshot): number {
  return (a.recurrence_id ?? '').localeCompare(b.recurrence_id ?? '') || a.id.localeCompare(b.id);
}

/**
 * Href di una risorsa nuova dall'UID (design §5): `<uid>.ics` se l'UID è un
 * nome sicuro e non imita i prefissi che decidono la provenienza
 * (booking-*, it-holiday-*, closure-*, r-*), altrimenti
 * `<sha256(uid)[0..32]>.ics`.
 */
export function eventHrefForUid(uid: string): string {
  const candidate = `${uid}.ics`;
  if (SAFE_UID_HREF_RE.test(uid) && isValidObjectName(candidate) && parseObjectHref(candidate).kind === 'other') return candidate;
  return `${sha256Hex(uid).slice(0, 32)}.ics`;
}

/** UID di un override orfano staccato: `<uid del master>-det-<epoch in secondi del RECURRENCE-ID>`. */
export function detachedUid(masterUid: string, recurrenceIdIso: string): string {
  return `${masterUid}-det-${secondKey(msOf(recurrenceIdIso))}`;
}

/** Href di ripiego legato alla chiave legacy (unico per costruzione). */
function keyHref(key: LegacyKey): string {
  return `${sha256Hex(key).slice(0, 32)}.ics`;
}

// ─── Lettura della sorgente ───────────────────────────────

const EVENT_COLUMNS = `
  id::text AS id, uid, calendar_id::text AS calendar_id, summary, description, location, url,
  start_time, end_time, all_day, rrule, exdates, recurrence_id, recurrence_master_id::text AS recurrence_master_id,
  source, source_id, status, created_at, updated_at
`;

/** Colonne del ledger nell'ordine di LedgerRow (int8 come testo). */
export const LEDGER_SELECT = `
  id::text AS id, calendar_id::text AS calendar_id, collection_name, href, kind, legacy_key,
  legacy_event_id::text AS legacy_event_id, uid, legacy_snapshot, legacy_hash,
  written_etag, written_fingerprint, written_at,
  intent_op, intent_fingerprint, intent_legacy_hash, intent_snapshot, intent_etag, intent_at, intent_run_id::text AS intent_run_id,
  adopted, derived, revalidate_reason, revalidate_since, deleted_at, last_run_id::text AS last_run_id, created_at, updated_at
`;

function dateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Riga di cal_migration_ledger (SELECT di LEDGER_SELECT) → LedgerRow. */
export function ledgerRowFromDb(r: Record<string, unknown>): LedgerRow {
  return {
    id: String(r.id),
    calendar_id: String(r.calendar_id),
    collection_name: String(r.collection_name),
    href: String(r.href),
    kind: r.kind as LedgerKind,
    legacy_key: r.legacy_key as LegacyKey,
    legacy_event_id: strOrNull(r.legacy_event_id),
    uid: strOrNull(r.uid),
    legacy_snapshot: (r.legacy_snapshot ?? null) as LegacySnapshot | null,
    legacy_hash: strOrNull(r.legacy_hash),
    written_etag: strOrNull(r.written_etag),
    written_fingerprint: strOrNull(r.written_fingerprint),
    written_at: dateOrNull(r.written_at),
    intent_op: (r.intent_op ?? null) as LedgerRow['intent_op'],
    intent_fingerprint: strOrNull(r.intent_fingerprint),
    intent_legacy_hash: strOrNull(r.intent_legacy_hash),
    intent_snapshot: (r.intent_snapshot ?? null) as LegacySnapshot | null,
    intent_etag: strOrNull(r.intent_etag),
    intent_at: dateOrNull(r.intent_at),
    intent_run_id: strOrNull(r.intent_run_id),
    adopted: r.adopted === true,
    derived: r.derived === true,
    revalidate_reason: strOrNull(r.revalidate_reason),
    revalidate_since: dateOrNull(r.revalidate_since),
    deleted_at: dateOrNull(r.deleted_at),
    last_run_id: strOrNull(r.last_run_id),
    created_at: dateOrNull(r.created_at) ?? new Date(0),
    updated_at: dateOrNull(r.updated_at) ?? new Date(0),
  };
}

/**
 * Righe vive del ledger in sola lettura (anteprima, shadow): quelle dei
 * calendari indicati, quelle delle chiavi indicate e le righe `detached` dei
 * master indicati (legacy_snapshot->>'master_id'). L'unico scrittore del
 * ledger resta apply.ts.
 */
export async function loadLedgerRows(
  db: Db,
  filter: { calendarIds?: readonly string[]; legacyKeys?: readonly string[]; detachedOfMasters?: readonly string[] },
): Promise<LedgerRow[]> {
  const calendarIds = [...new Set(filter.calendarIds ?? [])];
  const keys = [...new Set(filter.legacyKeys ?? [])];
  const masters = [...new Set(filter.detachedOfMasters ?? [])];
  if (calendarIds.length === 0 && keys.length === 0 && masters.length === 0) return [];
  const rows = await db<Array<Record<string, unknown>>>`
    SELECT ${db.unsafe(LEDGER_SELECT)} FROM cal_migration_ledger
    WHERE deleted_at IS NULL
      AND (calendar_id = ANY(${calendarIds}::uuid[]) OR legacy_key = ANY(${keys}::text[])
           OR (kind = 'detached' AND legacy_snapshot->>'master_id' = ANY(${masters}::text[])))
    ORDER BY calendar_id, href, id
  `;
  return rows.map(ledgerRowFromDb);
}

function eventRowFromDb(r: Record<string, unknown>): SourceEventRow {
  return {
    id: String(r.id),
    uid: String(r.uid),
    calendar_id: String(r.calendar_id),
    summary: String(r.summary ?? ''),
    description: strOrNull(r.description),
    location: strOrNull(r.location),
    url: strOrNull(r.url),
    start_time: isoOf(r.start_time),
    end_time: isoOf(r.end_time),
    all_day: r.all_day === true,
    rrule: r.rrule === null || r.rrule === undefined || String(r.rrule).trim() === '' ? null : String(r.rrule),
    exdates: normalizeLegacyExdates(r.exdates),
    recurrence_id: r.recurrence_id === null || r.recurrence_id === undefined ? null : isoOf(r.recurrence_id),
    recurrence_master_id: strOrNull(r.recurrence_master_id),
    source: String(r.source),
    source_id: strOrNull(r.source_id),
    status: (r.status === 'cancelled' || r.status === 'tentative' ? r.status : 'confirmed') as LegacyEventRowSnapshot['status'],
    created_at: isoOf(r.created_at),
    updated_at: isoOf(r.updated_at),
  };
}

/** Esegue `fn` in una transazione REPEATABLE READ READ ONLY (o direttamente, se `db` è già una transazione). */
async function readOnlySnapshot<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const begin = (db as unknown as { begin?: unknown }).begin;
  if (typeof begin !== 'function') return fn(db);
  return (await db.begin('isolation level repeatable read read only', async (trx) => fn(trx as unknown as Db))) as T;
}

/**
 * Legge la sorgente del serializer in una sola istantanea coerente:
 * calendari (loadMigrationCalendars, con l'esclusione dal piano), righe di
 * calendar_events (tranne ics_pull) dei calendari dell'ambito più gli override
 * dei loro master in altri calendari, prenotazioni proiettabili o citate da
 * una riga di proiezione (con il titolo del tipo e il link della riunione),
 * cal_object_ids per legacy_event_id e righe vive del ledger dell'ambito.
 *
 * Con `legacyKeys` (shadow) legge solo le righe di quelle chiavi: per
 * `event:<master>` il master e i suoi override (più le altre festività di
 * sistema dello stesso calendario, per le duplicate), per `booking:<uid>` la
 * prenotazione e le sue righe di proiezione.
 */
export async function loadLegacySource(
  db: Db,
  opts: { scope?: MigrationScope; legacyKeys?: readonly LegacyKey[]; now?: Date } = {},
): Promise<LegacySource> {
  const readAt = opts.now ?? new Date();
  const keyMode = opts.legacyKeys !== undefined;
  const masterKeys: string[] = [];
  const detachedKeys: string[] = [];
  const bookingKeys: string[] = [];
  for (const key of opts.legacyKeys ?? []) {
    const parsed = parseLegacyKey(key);
    if (!parsed) continue;
    if (parsed.kind === 'event' && UUID_RE.test(parsed.id)) masterKeys.push(parsed.id.toLowerCase());
    else if (parsed.kind === 'detached' && UUID_RE.test(parsed.id)) detachedKeys.push(parsed.id.toLowerCase());
    else if (parsed.kind === 'booking') bookingKeys.push(parsed.id);
  }

  return readOnlySnapshot(db, async (tx) => {
    const calendars = await loadMigrationCalendars(tx, keyMode ? undefined : opts.scope);
    const scopeIds = calendars.map((c) => c.id);
    const includedIds = calendars.filter((c) => c.included).map((c) => c.id);
    const bookingsCalendar = calendars.find((c) => c.included && c.role === 'bookings') ?? null;
    const columns = tx.unsafe(EVENT_COLUMNS);

    let eventRows: Array<Record<string, unknown>>;
    if (keyMode) {
      // Un override staccato appartiene al gruppo del suo master: si risale al master.
      const owners = detachedKeys.length
        ? await tx<Array<{ m: string }>>`
          SELECT recurrence_master_id::text AS m FROM calendar_events
          WHERE id = ANY(${detachedKeys}::uuid[]) AND recurrence_master_id IS NOT NULL
        `
        : [];
      const masterIds = [...new Set([...masterKeys, ...owners.map((r) => r.m)])];
      eventRows = [...await tx<Array<Record<string, unknown>>>`
        SELECT ${columns} FROM calendar_events
        WHERE source <> 'ics_pull'
          AND (id = ANY(${masterIds}::uuid[]) OR recurrence_master_id = ANY(${masterIds}::uuid[])
               OR (source = 'booking' AND source_id = ANY(${bookingKeys}::text[])))
        ORDER BY id
      `];
      // Festività di sistema dello stesso calendario: servono per decidere la prima per data.
      const holidayCalendars = [...new Set(eventRows
        .filter((r) => r.source === 'system' && (r.recurrence_master_id === null || r.recurrence_master_id === undefined))
        .map((r) => String(r.calendar_id))
        .filter((id) => calendars.some((c) => c.id === id && c.role === 'holidays')))];
      if (holidayCalendars.length) {
        const siblings = await tx<Array<Record<string, unknown>>>`
          SELECT ${columns} FROM calendar_events
          WHERE source = 'system' AND recurrence_master_id IS NULL AND calendar_id = ANY(${holidayCalendars}::uuid[])
          ORDER BY id
        `;
        const seen = new Set(eventRows.map((r) => String(r.id)));
        for (const row of siblings) if (!seen.has(String(row.id))) eventRows.push(row);
      }
    } else {
      eventRows = [...await tx<Array<Record<string, unknown>>>`
        SELECT ${columns} FROM calendar_events e
        WHERE e.source <> 'ics_pull'
          AND (e.calendar_id = ANY(${scopeIds}::uuid[])
               OR e.recurrence_master_id IN (
                 SELECT m.id FROM calendar_events m
                 WHERE m.calendar_id = ANY(${scopeIds}::uuid[]) AND m.recurrence_master_id IS NULL
               ))
        ORDER BY e.id
      `];
    }
    const events = eventRows.map(eventRowFromDb);

    // Prenotazioni: solo se il calendario Prenotazioni è nell'ambito (o per le chiavi richieste).
    const projectionUids = [...new Set(events
      .filter((e) => e.source === 'booking' && e.source_id && e.recurrence_master_id === null)
      .map((e) => e.source_id as string))];
    let bookingRows: Array<Record<string, unknown>> = [];
    if (keyMode ? bookingKeys.length > 0 : bookingsCalendar !== null) {
      const filter = keyMode
        ? tx`uid = ANY(${bookingKeys}::text[])`
        : tx`(status = ANY(${[...PROJECTED_BOOKING_STATUSES]}::text[]) OR uid = ANY(${projectionUids}::text[]))`;
      bookingRows = [...await tx<Array<Record<string, unknown>>>`
        SELECT uid, status, event_type_id::text AS event_type_id, start_time, end_time, attendee_name, attendee_phone,
               location_value, created_at,
               (lower(attendee_email) LIKE 'erased-%@deleted.invalid') AS anonymized
        FROM calendar_bookings
        WHERE ${filter}
        ORDER BY uid
      `];
    }
    const typeIds = [...new Set(bookingRows.map((b) => String(b.event_type_id)))];
    const types: EventType[] = typeIds.length
      ? [...await tx<EventType[]>`
        SELECT id::text AS id, slug, title, description, duration_minutes,
               buffer_before_minutes, buffer_after_minutes, slot_increment_minutes,
               min_notice_hours, max_advance_days, location_type, location_value, color,
               is_active, is_public, requires_approval, custom_questions, workflow_event_key,
               schedule_id::text AS schedule_id, sort_order
        FROM calendar_event_types WHERE id = ANY(${typeIds}::uuid[])
      `]
      : [];
    const typeById = new Map(types.map((t) => [t.id, t]));
    const bookings: LegacySource['bookings'] = [];
    for (const b of bookingRows) {
      const eventType = typeById.get(String(b.event_type_id)) ?? null;
      const startIso = isoOf(b.start_time);
      const endIso = isoOf(b.end_time);
      const resolved = eventType
        ? await resolveLocationForBooking({
          eventType,
          booking: { uid: String(b.uid), start_time: startIso, end_time: endIso, attendee_name: String(b.attendee_name ?? ''), attendee_email: '' },
          pushToGoogle: false,
        })
        : null;
      bookings.push({
        uid: String(b.uid),
        status: String(b.status),
        start_time: startIso,
        end_time: endIso,
        title: eventType?.title ?? RETAINED_PROJECTION_SUMMARY,
        attendee_name: String(b.attendee_name ?? ''),
        attendee_phone: strOrNull(b.attendee_phone),
        location: strOrNull(b.location_value),
        meeting_url: resolved?.meetingUrl ?? null,
        created_at: isoOf(b.created_at),
        anonymized: b.anonymized === true,
      });
    }

    // cal_object_ids per legacy_event_id: prima le righe attive, poi le più recenti.
    const legacyIds = events.map((e) => e.id);
    const objectIds = new Map<string, { calendar_id: string; href: string; recurrence_key: string; id: string; legacy_uid: string | null }>();
    if (legacyIds.length) {
      const idRows = await tx<Array<{ legacy_event_id: string; calendar_id: string; href: string; recurrence_key: string; id: string; legacy_uid: string | null }>>`
        SELECT legacy_event_id::text AS legacy_event_id, calendar_id::text AS calendar_id, href, recurrence_key, id::text AS id, legacy_uid
        FROM cal_object_ids WHERE legacy_event_id = ANY(${legacyIds}::uuid[])
        ORDER BY (retired_at IS NULL) DESC, updated_at DESC, id
      `;
      for (const r of idRows) {
        if (!objectIds.has(r.legacy_event_id)) {
          objectIds.set(r.legacy_event_id, { calendar_id: r.calendar_id, href: r.href, recurrence_key: r.recurrence_key, id: r.id, legacy_uid: r.legacy_uid });
        }
      }
    }

    // Ledger: calendari inclusi dell'ambito, chiavi della sorgente (spostamenti) e orfani staccati dei master,
    // compresi quelli dei master richiesti per chiave e ormai cancellati (contratto §6.2: la chiave
    // event:<master> comprende le righe detached di quel master, così un orfano rimasto si toglie).
    const masterIds = [...new Set([
      ...events.filter((e) => e.recurrence_master_id === null && !(e.source === 'booking' && e.source_id)).map((e) => e.id),
      ...masterKeys,
    ])];
    const keys = new Set<string>();
    for (const e of events) {
      if (e.recurrence_master_id === null) {
        if (e.source === 'booking' && e.source_id) keys.add(legacyKey('booking', e.source_id));
        else keys.add(legacyKey('event', e.id));
      } else {
        keys.add(legacyKey('detached', e.id));
      }
    }
    for (const b of bookings) keys.add(legacyKey('booking', b.uid));
    for (const k of opts.legacyKeys ?? []) keys.add(k);
    const ledger = await loadLedgerRows(tx, {
      calendarIds: keyMode ? [] : includedIds,
      legacyKeys: [...keys],
      detachedOfMasters: masterIds,
    });

    return { read_at: readAt, calendars, events, bookings, objectIds, ledger };
  });
}

// ─── Ricorrenze: regola, UNTIL "fino al", eccezioni DST ───────────────────────────────

type RuleStatus = 'none' | 'ok' | 'invalid' | 'until_before_dtstart' | 'limit';

interface RuleAnalysis {
  status: RuleStatus;
  /** RRULE legacy grezza (senza prefisso), se c'è. */
  raw: string | null;
  /** RRULE effettiva (dopo la correzione di UNTIL, se applicata). */
  text: string | null;
  /** UNTIL dell'editor admin che la correzione cambierebbe: valori UNTIL prima e dopo. */
  adminPattern: { from: string; to: string } | null;
  /** True se la correzione di UNTIL è stata applicata. */
  fixed: boolean;
  /**
   * DTSTART fuori dalla regola (semantica legacy: la prima occorrenza di
   * rrule.js dal DTSTART in avanti non è il DTSTART): istante originale e
   * prima occorrenza legacy, solo con il riallineamento richiesto.
   */
  dtstart: { from: string; to: string } | null;
  /** Codici di validazione che hanno deciso lo stato (anomalie). */
  codes: string[];
}

/** Finestre di ricerca della prima occorrenza legacy (giorni dal DTSTART): la regola annuale più rada (29 febbraio) sta entro 8 anni. */
const LEGACY_FIRST_SEARCH_DAYS: readonly number[] = [400, 11 * 366];

/**
 * Prima occorrenza della serie secondo il legacy (rrule.js in ora flottante
 * di Roma, come listOccurrences): rrule.js non conta il DTSTART che non
 * soddisfa la regola, né lo conta in COUNT. Le EXDATE non contano (escludono
 * un'occorrenza, non spostano l'inizio della serie). null se il legacy non ha
 * nessuna occorrenza (UNTIL prima del primo giorno valido).
 */
function legacyFirstOccurrence(master: LegacyEventRowSnapshot, rule: string): string | null {
  const start = msOf(master.start_time);
  // Un giorno prima: rrule.js non produce mai istanze prima del DTSTART, e il DTSTART troncato al secondo non resta fuori.
  const fromIso = new Date(start - 86_400_000).toISOString();
  for (const days of LEGACY_FIRST_SEARCH_DAYS) {
    const found = expandRRule({ rrule: rule, masterStartIso: master.start_time, fromIso, toIso: new Date(start + days * 86_400_000).toISOString(), limit: 1 });
    if (found.length) return found[0];
  }
  return null;
}

/** Riga del master con DTSTART spostato a `startIso` e la stessa durata. */
function shiftedMaster(master: LegacyEventRowSnapshot, startIso: string): LegacyEventRowSnapshot {
  const duration = msOf(master.end_time) - msOf(master.start_time);
  const start = msOf(startIso);
  return { ...master, start_time: new Date(start).toISOString(), end_time: new Date(start + duration).toISOString() };
}

function legacyInput(row: LegacyEventRowSnapshot, overrides: Partial<Parameters<typeof buildEventFromLegacy>[0]> = {}): Parameters<typeof buildEventFromLegacy>[0] {
  return {
    uid: row.uid,
    summary: row.summary,
    description: row.description,
    location: row.location,
    url: row.url,
    start_time: row.start_time,
    end_time: row.end_time,
    all_day: row.all_day,
    rrule: row.rrule,
    exdates: validIsoList(row.exdates),
    recurrence_id: null,
    status: row.status,
    source: legacySourceOf(row.source),
    source_id: row.source_id,
    legacy_id: row.id,
    ...overrides,
  };
}

/** Master di sola regola (niente EXDATE né override) per le verifiche di appartenenza. */
function trialMaster(cal: CalendarSnapshot, master: LegacyEventRowSnapshot, rule: string | null, now: Date): CalendarObject {
  const comp = buildEventFromLegacy(legacyInput(master, { rrule: rule, exdates: [] }), { tz: cal.timezone, seriesTz: ROME, now, sequence: 0 });
  return createCalendarObject({ uid: master.uid, componentType: 'VEVENT', master: comp });
}

function checkRule(cal: CalendarSnapshot, master: LegacyEventRowSnapshot, rule: string, now: Date): { status: RuleStatus; codes: string[] } {
  // Il legacy non espande una RRULE che rrule.js non interpreta: nessuna occorrenza.
  if (validateRRule(rule, master.start_time) === null) return { status: 'invalid', codes: ['LEGACY_RRULE_UNREADABLE'] };
  let obj: CalendarObject;
  try {
    obj = trialMaster(cal, master, rule, now);
  } catch {
    return { status: 'invalid', codes: ['RRULE_INVALID'] };
  }
  const errors = validateObject(obj, { tz: cal.timezone, allowedComponents: ['VEVENT'], now }).issues
    .filter((i) => i.severity === 'error')
    .map((i) => i.code as string);
  if (errors.includes('UNTIL_BEFORE_DTSTART')) return { status: 'until_before_dtstart', codes: ['UNTIL_BEFORE_DTSTART'] };
  const invalid = errors.filter((c) => RULE_INVALID_CODES.has(c));
  if (invalid.length) return { status: 'invalid', codes: invalid };
  const limit = errors.filter((c) => RULE_LIMIT_CODES.has(c));
  if (limit.length) return { status: 'limit', codes: limit };
  return { status: 'ok', codes: [] };
}

/**
 * UNTIL salvato dall'editor admin a mezzanotte UTC del giorno "fino al" su una
 * serie timed: il legacy (e Radicale con la stessa regola) esclude le
 * occorrenze di quel giorno. Correzione: fine della giornata di Roma. Si
 * segnala solo se la correzione aggiunge davvero almeno un'occorrenza.
 */
function untilAdminPattern(cal: CalendarSnapshot, master: LegacyEventRowSnapshot, rule: string, now: Date): { from: string; to: string } | null {
  if (master.all_day) return null;
  const m = UNTIL_UTC_MIDNIGHT_RE.exec(rule);
  if (!m) return null;
  const [, , y, mo, d] = m;
  const oldMs = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  const newMs = zonedToUtc({ year: Number(y), month: Number(mo), day: Number(d), hour: 23, minute: 59, second: 59 }, ianaZone(ROME));
  if (!(newMs > oldMs)) return null;
  const to = formatUtcCompact(newMs);
  const fixedRule = replaceUntil(rule, to);
  try {
    const obj = trialMaster(cal, master, fixedRule, now);
    const exp = expandObject(obj, { from: oldMs + 1000, to: newMs + 1000, tz: cal.timezone, computeRangeEnd: false });
    if (!exp.occurrences.some((o) => o.startUtc > oldMs && o.startUtc <= newMs)) return null;
  } catch {
    return null;
  }
  return { from: `${y}${mo}${d}T000000Z`, to };
}

function replaceUntil(rule: string, until: string): string {
  return rule.replace(UNTIL_UTC_MIDNIGHT_RE, (_all, sep: string) => `${sep}UNTIL=${until}`);
}

function analyzeRule(cal: CalendarSnapshot, master: LegacyEventRowSnapshot, fixUntil: boolean, realignDtstart: boolean, now: Date): RuleAnalysis {
  const raw = master.rrule ? master.rrule.trim().replace(/^RRULE:/i, '') : '';
  if (!raw) return { status: 'none', raw: null, text: null, adminPattern: null, fixed: false, dtstart: null, codes: [] };
  const check = checkRule(cal, master, raw, now);
  if (check.status !== 'ok') return { status: check.status, raw, text: raw, adminPattern: null, fixed: false, dtstart: null, codes: check.codes };
  const adminPattern = untilAdminPattern(cal, master, raw, now);
  const fixed = fixUntil && adminPattern !== null;
  const text = fixed && adminPattern ? replaceUntil(raw, adminPattern.to) : raw;
  let dtstart: RuleAnalysis['dtstart'] = null;
  // BYDAY misto (MIXED_BYDAY): le due semantiche divergono per costruzione (unione RFC contro intersezione
  // del legacy, anche vuota) e il design tiene l'unione dei device con le differenze attese: niente riallineamento.
  if (realignDtstart && !isMixedByday(text)) {
    // Semantica legacy (rrule.js, e dateutil di Radicale): il DTSTART fuori dalla regola non è un'occorrenza.
    // RFC 5545 (calendar-core, device, feed) lo conterebbe: si parte dalla prima occorrenza legacy.
    const first = legacyFirstOccurrence(master, text);
    if (first === null) {
      return { status: 'until_before_dtstart', raw, text, adminPattern, fixed, dtstart: null, codes: ['NO_LEGACY_OCCURRENCE'] };
    }
    if (secondKey(msOf(first)) !== secondKey(msOf(master.start_time))) dtstart = { from: master.start_time, to: new Date(msOf(first)).toISOString() };
  }
  return { status: 'ok', raw, text, adminPattern, fixed, dtstart, codes: [] };
}

type DstSkipReason = 'NON_ROME_CALENDAR' | 'NO_MATCHING_OCCURRENCE' | 'OVERRIDE_CONFLICT';

interface DstChangeInfo {
  kind: 'override' | 'exdate';
  event_id: string;
  from: string;
  to: string;
  action: 'realign' | 'drop-duplicate';
}

interface DstSkipInfo {
  kind: 'override' | 'exdate';
  event_id: string;
  from: string;
  reason: DstSkipReason;
}

interface DstResult {
  changes: DstChangeInfo[];
  skipped: DstSkipInfo[];
  /** id dell'override → recurrence_id riallineato. */
  ridMap: Map<string, string>;
  /** exdates del master dopo il riallineamento (elementi spostati o tolti se il valore corretto c'era già). */
  exdates: string[];
}

/**
 * Eccezioni DST (design §13.4, stesso criterio di scripts/fix-dst-exceptions.ts):
 *  1. un'eccezione che è già un'occorrenza della serie non si tocca;
 *  2. firma: stessa ora UTC del DTSTART ma offset di Roma diverso;
 *  3. valore corretto = eccezione + (offset del DTSTART − offset dell'eccezione),
 *     usato solo se è un'occorrenza della serie (griglia di calendar-core);
 *  4. non si riallinea in un calendario con fuso diverso da Europe/Rome, né un
 *     override sull'occorrenza di un altro override; un elemento di exdates il
 *     cui valore corretto c'è già si toglie.
 */
function planDst(
  cal: CalendarSnapshot,
  master: LegacyEventRowSnapshot,
  trial: CalendarObject,
  overrides: readonly LegacyEventRowSnapshot[],
  masterExdates: readonly string[],
): DstResult {
  const result: DstResult = { changes: [], skipped: [], ridMap: new Map(), exdates: [...masterExdates] };
  const masterMs = msOf(master.start_time);
  const masterOffset = offsetAt(masterMs, ROME);
  const utcSecondOfDay = (ms: number): number => ((secondKey(ms) % 86_400) + 86_400) % 86_400;
  const isOccurrence = (ms: number): boolean => {
    const s = secondKey(ms);
    try {
      const exp = expandObject(trial, { from: s * 1000, to: s * 1000 + 1000, tz: cal.timezone, computeRangeEnd: false });
      return exp.occurrences.some((o) => o.kind === 'event' && secondKey(o.startUtc) === s);
    } catch {
      return false;
    }
  };
  type Verdict = { status: 'aligned' | 'other' } | { status: 'candidate'; to: number | null };
  const evaluate = (ms: number): Verdict => {
    if (isOccurrence(ms)) return { status: 'aligned' };
    const offset = offsetAt(ms, ROME);
    if (utcSecondOfDay(ms) !== utcSecondOfDay(masterMs) || offset === masterOffset) return { status: 'other' };
    const corrected = ms + (masterOffset - offset);
    return { status: 'candidate', to: isOccurrence(corrected) ? corrected : null };
  };
  const nonRome = cal.timezone !== ROME;

  const overrideCount = new Map<number, number>();
  for (const ov of overrides) {
    if (!ov.recurrence_id) continue;
    const k = secondKey(msOf(ov.recurrence_id));
    overrideCount.set(k, (overrideCount.get(k) ?? 0) + 1);
  }
  const plannedOverrideTargets = new Set<number>();
  for (const ov of overrides) {
    if (!ov.recurrence_id) continue;
    const ms = msOf(ov.recurrence_id);
    const v = evaluate(ms);
    if (v.status !== 'candidate') continue;
    const from = new Date(ms).toISOString();
    if (nonRome) { result.skipped.push({ kind: 'override', event_id: ov.id, from, reason: 'NON_ROME_CALENDAR' }); continue; }
    if (v.to === null) { result.skipped.push({ kind: 'override', event_id: ov.id, from, reason: 'NO_MATCHING_OCCURRENCE' }); continue; }
    const target = secondKey(v.to);
    if (overrideCount.has(target) || plannedOverrideTargets.has(target)) {
      result.skipped.push({ kind: 'override', event_id: ov.id, from, reason: 'OVERRIDE_CONFLICT' });
      continue;
    }
    plannedOverrideTargets.add(target);
    const to = new Date(v.to).toISOString();
    result.ridMap.set(ov.id, to);
    result.changes.push({ kind: 'override', event_id: ov.id, from, to, action: 'realign' });
  }

  const exdateKeys = new Set(validIsoList(masterExdates).map((v) => secondKey(msOf(v))));
  const plannedExdateTargets = new Set<number>();
  const rewritten: string[] = [];
  for (const raw of masterExdates) {
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) { rewritten.push(raw); continue; }
    const v = evaluate(ms);
    if (v.status !== 'candidate') { rewritten.push(raw); continue; }
    const from = new Date(ms).toISOString();
    if (nonRome) { result.skipped.push({ kind: 'exdate', event_id: master.id, from, reason: 'NON_ROME_CALENDAR' }); rewritten.push(raw); continue; }
    if (v.to === null) { result.skipped.push({ kind: 'exdate', event_id: master.id, from, reason: 'NO_MATCHING_OCCURRENCE' }); rewritten.push(raw); continue; }
    const target = secondKey(v.to);
    const duplicate = exdateKeys.has(target) || plannedExdateTargets.has(target);
    plannedExdateTargets.add(target);
    const to = new Date(v.to).toISOString();
    result.changes.push({ kind: 'exdate', event_id: master.id, from, to, action: duplicate ? 'drop-duplicate' : 'realign' });
    if (!duplicate) rewritten.push(to);
  }
  result.exdates = rewritten;
  return result;
}

// ─── Modello effettivo di un evento ───────────────────────────────

interface EventFlags {
  fixUntil: boolean;
  realignDst: boolean;
  /** DTSTART fuori dalla regola spostato sulla prima occorrenza legacy (sempre nel serializer, dallo snapshot per la ricostruzione). */
  realignDtstart: boolean;
}

interface EffectiveEvent {
  rule: RuleAnalysis;
  /** Riga del master con il DTSTART effettivo (spostato se rule.dtstart; altrimenti quella legacy). */
  master: LegacyEventRowSnapshot;
  dst: DstResult | null;
  /** EXDATE effettive del master (exdates riallineate più override cancellati), solo con una regola valida. */
  exdates: string[];
  /** Override modificati con il RECURRENCE-ID effettivo, solo con una regola valida. */
  overrides: Array<{ row: LegacyEventRowSnapshot; rid: string }>;
  cancelled: LegacyEventRowSnapshot[];
}

function effectiveEvent(
  cal: CalendarSnapshot,
  master: LegacyEventRowSnapshot,
  overrides: readonly LegacyEventRowSnapshot[],
  flags: EventFlags,
  now: Date,
): EffectiveEvent {
  const rule = analyzeRule(cal, master, flags.fixUntil, flags.realignDtstart, now);
  const cancelled = overrides.filter((o) => o.status === 'cancelled' && o.recurrence_id);
  const modified = overrides.filter((o) => o.status !== 'cancelled' && o.recurrence_id);
  if (rule.status !== 'ok' || !rule.text) return { rule, master, dst: null, exdates: [], overrides: [], cancelled };
  const masterExdates = [...master.exdates];
  // Griglia delle occorrenze: quella del DTSTART effettivo (la stessa del legacy). La firma delle
  // eccezioni DST resta quella del DTSTART salvato, con cui il codice precedente al fix le scriveva.
  const effMaster = rule.dtstart ? shiftedMaster(master, rule.dtstart.to) : master;
  const trial = trialMaster(cal, effMaster, rule.text, now);
  const dst = planDst(cal, master, trial, [...modified, ...cancelled], masterExdates);
  const ridOf = (row: LegacyEventRowSnapshot): string => (flags.realignDst ? dst.ridMap.get(row.id) : undefined) ?? (row.recurrence_id as string);
  const exdates = uniqueBySecond([
    ...validIsoList(flags.realignDst ? dst.exdates : masterExdates),
    ...cancelled.map(ridOf),
  ]);
  return {
    rule,
    master: effMaster,
    dst,
    exdates,
    overrides: modified.map((row) => ({ row, rid: ridOf(row) })),
    cancelled,
  };
}

/** Costruisce l'oggetto di un evento dal modello effettivo (master più override). */
function assembleEvent(
  cal: CalendarSnapshot,
  eff: EffectiveEvent,
  now: Date,
  stamps?: StampLookup,
): CalendarObject {
  const master = eff.master;
  const ok = eff.rule.status === 'ok';
  const ms = stamps?.(master.id);
  const masterComp = buildEventFromLegacy(
    legacyInput(master, { rrule: ok ? eff.rule.text : null, exdates: ok ? eff.exdates : [] }),
    { tz: cal.timezone, seriesTz: ROME, now, created: ms?.created ?? null, lastModified: ms?.lastModified ?? null, sequence: 0 },
  );
  if (eff.rule.status === 'invalid' && eff.rule.raw) {
    masterComp.properties.push(createProperty(X_CALDES.LEGACY_RRULE, encodeText(eff.rule.raw)));
  }
  const startProp = getProperty(masterComp, 'DTSTART');
  const masterStart: IcsTime | null = startProp ? readTimeProperty(startProp) : null;
  const overrides: IcsComponent[] = ok
    ? eff.overrides.map(({ row, rid }) => {
      const os = stamps?.(row.id);
      return buildEventFromLegacy(
        legacyInput(row, { uid: master.uid, recurrence_id: rid, rrule: null, exdates: [] }),
        { tz: cal.timezone, seriesTz: ROME, now, masterStart, created: os?.created ?? null, lastModified: os?.lastModified ?? null, sequence: 0 },
      );
    })
    : [];
  return createCalendarObject({ uid: master.uid, componentType: 'VEVENT', master: masterComp, overrides });
}

function finishObject(object: CalendarObject, opts: { prodid?: 'preserve' } = {}): BuiltObject {
  const ics = serializeObject(object, opts.prodid ? { prodid: 'preserve' } : {});
  const parsed = parseCalendarObject(ics);
  if (!parsed.ok) throw new TypeError(`oggetto non rileggibile dopo la serializzazione: ${parsed.error.message}`);
  return { object: parsed.value, ics, fingerprint: semanticFingerprint(parsed.value) };
}

function buildEventObject(snapshot: LegacyEventSnapshot, now: Date, stamps?: StampLookup): { built: BuiltObject; eff: EffectiveEvent } {
  const flags: EventFlags = {
    fixUntil: snapshot.options.fix_until_admin_pattern === true,
    realignDst: snapshot.options.realign_dst_exceptions === true,
    realignDtstart: snapshot.options.realign_dtstart === true,
  };
  const eff = effectiveEvent(snapshot.calendar, snapshot.master, snapshot.overrides, flags, now);
  return { built: finishObject(assembleEvent(snapshot.calendar, eff, now, stamps)), eff };
}

function buildDetachedObject(snapshot: LegacyDetachedSnapshot, now: Date, stamps?: StampLookup): BuiltObject {
  const ov = snapshot.override;
  const uid = detachedUid(snapshot.master_uid, ov.recurrence_id as string);
  const st = stamps?.(ov.id);
  const comp = buildEventFromLegacy(
    legacyInput(ov, { uid, rrule: null, exdates: [], recurrence_id: null }),
    { tz: snapshot.calendar.timezone, now, created: st?.created ?? null, lastModified: st?.lastModified ?? null, sequence: 0 },
  );
  return finishObject(createCalendarObject({ uid, componentType: 'VEVENT', master: comp }));
}

/**
 * Proiezione di una prenotazione: il testo del job project_booking
 * (buildBookingProjectionIcs, decisione 3); minimizzata ("Prenotazione", senza
 * descrizione, luogo e link) se lo snapshot lo dice; X-CALDES-LEGACY-ID con la
 * riga legacy della proiezione, se esiste.
 */
function buildBookingObject(snapshot: LegacyBookingSnapshot, now: Date): BuiltObject {
  const b = snapshot.booking;
  if (!b) throw new TypeError(`proiezione senza prenotazione nello snapshot (${snapshot.legacy_event_id ?? '-'})`);
  const input = {
    booking: {
      uid: b.uid,
      attendee_name: b.attendee_name,
      attendee_phone: b.attendee_phone,
      start_time: b.start_time,
      end_time: b.end_time,
      location_value: b.location,
      created_at: b.created_at ?? b.start_time,
    },
    eventTitle: b.title || RETAINED_PROJECTION_SUMMARY,
    meetingUrl: b.meeting_url,
    now,
  };
  const raw = buildBookingProjectionIcs(input);
  const parsed = parseCalendarObject(raw);
  if (!parsed.ok || !parsed.value.master) throw new TypeError('proiezione non rileggibile');
  const obj = parsed.value;
  const master = obj.master as IcsComponent;
  // La minimizzazione la decide SOLO lo snapshot (decisione 3: serializeLegacy la calcola con lo stesso
  // `now`), mai il tempo trascorso: uno snapshot precedente alla soglia dei 24 mesi, ricostruito dopo
  // (base della patch per campo dello shadow e dell'update delle righe adottate), deve restare con nome e
  // telefono, altrimenti il diff verso lo snapshot minimizzato risulterebbe vuoto e la risorsa non si
  // riscriverebbe mai. `now` resta per DTSTAMP e LAST-MODIFIED.
  const content = snapshot.minimized
    ? bookingProjectionContent(null, { now })
    : isBookingProjectionExpired(b.end_time, now)
      ? bookingProjectionContentFor({ ...input, now: RETENTION_NEUTRAL_NOW })
      : null;
  if (content) {
    setTextValue(master, 'SUMMARY', content.summary);
    setTextValue(master, 'DESCRIPTION', content.description);
    setTextValue(master, 'LOCATION', content.location);
    removeProperties(master, 'URL');
    if (content.url) master.properties.push(createProperty('URL', content.url));
  }
  if (snapshot.legacy_event_id) setTextValue(master, X_CALDES.LEGACY_ID, snapshot.legacy_event_id);
  return finishObject(obj, { prodid: 'preserve' });
}

/**
 * Ricostruisce l'oggetto voluto da uno snapshot (stesso contenuto semantico
 * dell'uscita di serializeLegacy, a meno di CREATED e LAST-MODIFIED, che
 * vengono dalle righe). Base del diff per campo dello shadow e utile alla
 * verifica. Gli snapshot `archive` non si ricostruiscono (TypeError).
 */
export function buildObjectFromSnapshot(snapshot: LegacySnapshot, ctx: { now: Date; stamps?: StampLookup }): BuiltObject {
  switch (snapshot.kind) {
    case 'event':
      return buildEventObject(snapshot, ctx.now, ctx.stamps).built;
    case 'detached':
      return buildDetachedObject(snapshot, ctx.now, ctx.stamps);
    case 'booking':
      return buildBookingObject(snapshot, ctx.now);
    default:
      throw new TypeError('gli item dell\'archivio della Fase 0 non hanno una sorgente legacy da ricostruire');
  }
}

// ─── Ambito dei motivi attesi (verifica) ───────────────────────────────

/**
 * Istanti (secondi UTC dell'inizio) e giorni (YYYY-MM-DD nel fuso della serie)
 * che un motivo atteso spiega. Un motivo senza ambito vale per tutto
 * l'oggetto.
 */
export interface ReasonScope {
  seconds: ReadonlySet<number>;
  dates: ReadonlySet<string>;
}

function scopeOf(seconds: Iterable<number>, dates: Iterable<string> = []): ReasonScope {
  return { seconds: new Set(seconds), dates: new Set(dates) };
}

/**
 * Ambito dei motivi "di occorrenza" di un oggetto voluto, ricostruito dallo
 * snapshot (stessa logica del serializer, pura): la verifica rende gialla una
 * differenza solo se il motivo spiega proprio quell'istanza, non ogni
 * differenza dell'oggetto.
 *  - DST_REALIGNED: istanti prima e dopo il riallineamento delle eccezioni;
 *  - UNTIL_REALIGNED: il giorno "fino al" (le sue occorrenze, escluse dal legacy);
 *  - OVERRIDE_UID_MASTER: istanza originale e nuova di ogni override modificato;
 *  - CANCELLED_OVERRIDE_SUPPRESSED: istanze degli override cancellati (salvata e riallineata);
 *  - DTSTART_REALIGNED: il DTSTART salvato e, con COUNT, l'ultima occorrenza del legacy
 *    (il feed legacy espanso secondo RFC 5545 conta il DTSTART e ne perde una alla fine).
 * Gli altri motivi (o un errore di ricostruzione) non hanno ambito.
 */
export function expectedReasonScopes(snapshot: LegacySnapshot, now: Date): Map<ExpectedDiffReason, ReasonScope> {
  const out = new Map<ExpectedDiffReason, ReasonScope>();
  if (snapshot.kind !== 'event') return out;
  let eff: EffectiveEvent;
  try {
    eff = effectiveEvent(snapshot.calendar, snapshot.master, snapshot.overrides, {
      fixUntil: snapshot.options.fix_until_admin_pattern === true,
      realignDst: snapshot.options.realign_dst_exceptions === true,
      realignDtstart: snapshot.options.realign_dtstart === true,
    }, now);
  } catch {
    return out;
  }
  const sec = (iso: string | null | undefined): number[] => {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? [secondKey(ms)] : [];
  };
  if (eff.dst && snapshot.options.realign_dst_exceptions) {
    out.set('DST_REALIGNED', scopeOf(eff.dst.changes.flatMap((c) => [...sec(c.from), ...sec(c.to)])));
  }
  if (eff.rule.fixed && eff.rule.adminPattern) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(eff.rule.adminPattern.from);
    if (m) out.set('UNTIL_REALIGNED', scopeOf([], [`${m[1]}-${m[2]}-${m[3]}`]));
  }
  const modified = eff.overrides;
  if (modified.length) {
    out.set('OVERRIDE_UID_MASTER', scopeOf(modified.flatMap(({ row, rid }) => [...sec(row.recurrence_id), ...sec(rid), ...sec(row.start_time)])));
  }
  const cancelled = snapshot.overrides.filter((o) => o.status === 'cancelled');
  if (cancelled.length) {
    const ridOf = (row: LegacyEventRowSnapshot): string | undefined => eff.dst?.ridMap.get(row.id);
    out.set('CANCELLED_OVERRIDE_SUPPRESSED', scopeOf(cancelled.flatMap((row) => [...sec(row.recurrence_id), ...sec(ridOf(row))])));
  }
  if (eff.rule.dtstart && eff.rule.text) {
    const instants = [eff.rule.dtstart.from];
    const count = /(^|;)COUNT=(\d+)(;|$)/i.exec(eff.rule.text);
    if (count) {
      const n = Number(count[2]);
      const start = msOf(snapshot.master.start_time);
      const occ = expandRRule({ rrule: eff.rule.text, masterStartIso: snapshot.master.start_time, fromIso: new Date(start - 86_400_000).toISOString(), toIso: new Date(start + LEGACY_FIRST_SEARCH_DAYS[LEGACY_FIRST_SEARCH_DAYS.length - 1] * 86_400_000).toISOString(), limit: n });
      if (occ.length === n) instants.push(occ[n - 1]);
    }
    // Serie tutto il giorno: le istanze del feed e delle occorrenze sono date locali (mai secondi), quindi
    // l'ambito sono i giorni; per le serie con orario solo gli istanti (un giorno spiegherebbe troppo).
    const dates = snapshot.master.all_day ? instants.map((iso) => localDateOf(msOf(iso), snapshot.calendar.timezone)) : [];
    out.set('DTSTART_REALIGNED', scopeOf(snapshot.master.all_day ? [] : instants.flatMap((iso) => sec(iso)), dates));
  }
  return out;
}

// ─── Serializer ───────────────────────────────

interface ValidationOutcome {
  ok: boolean;
  skip: SkipCode | null;
  anomaly: AnomalyCode | null;
  codes: string[];
  properties: string[];
}

function validateBuilt(built: BuiltObject, tz: string, now: Date): ValidationOutcome {
  const res = validateObject(built.object, {
    tz,
    allowedComponents: ['VEVENT'],
    serializedBytes: Buffer.byteLength(built.ics, 'utf8'),
    now,
  });
  const errors = res.issues.filter((i) => i.severity === 'error');
  if (errors.length === 0) return { ok: true, skip: null, anomaly: null, codes: [], properties: [] };
  const codes = [...new Set(errors.map((i) => i.code as string))].sort();
  const properties = [...new Set(errors.map((i) => i.property).filter((p): p is string => Boolean(p)))].sort();
  if (codes.includes('UNTIL_BEFORE_DTSTART')) return { ok: false, skip: 'UNTIL_BEFORE_DTSTART', anomaly: 'UNTIL_BEFORE_DTSTART', codes, properties };
  if (codes.some((c) => RULE_LIMIT_CODES.has(c))) return { ok: false, skip: 'INVALID_OBJECT', anomaly: 'RADICALE_RRULE_LIMIT', codes, properties };
  return { ok: false, skip: 'INVALID_OBJECT', anomaly: 'INVALID_OBJECT', codes, properties };
}

/** Oggetto costruito in attesa dell'href (che dipende dagli altri oggetti della stessa collezione). */
interface PendingObject {
  legacy_key: LegacyKey;
  kind: LedgerKind;
  calendar_id: string;
  collection_name: string;
  /** href deterministico (festività, chiusure, proiezioni, UID). */
  preferredHref: string;
  uid: string;
  built: BuiltObject;
  legacy_snapshot: LegacySnapshot;
  legacy_event_id: string | null;
  legacy_uid: string | null;
  /** Id da preassegnare per gli override (la risorsa si aggiunge con l'href). */
  overrideIds: ReservedObjectId[];
  resourceId: string;
  anomalies: Set<AnomalyCode>;
  expected: Set<ExpectedDiffReason>;
  summary: string | null;
  tz: string;
}

class Accumulator {
  readonly pending: PendingObject[] = [];
  readonly skipped: SkippedSource[] = [];
  readonly anomalies: AnomalyRecord[] = [];

  anomaly(code: AnomalyCode, calendarId: string | null, key: string | null, detail: Record<string, unknown>, severity = ANOMALY_DEFINITIONS[code].severity): void {
    this.anomalies.push({ code, calendar_id: calendarId, legacy_key: key, severity, detail });
  }

  skip(entry: SkippedSource): void {
    this.skipped.push(entry);
  }
}

interface SerializerContext {
  source: LegacySource;
  options: MigrationOptions;
  now: Date;
  acc: Accumulator;
  calById: Map<string, MigrationCalendar>;
  stamps: StampLookup;
  moveTarget: MigrationCalendar | null;
  moveIds: ReadonlySet<string>;
}

/**
 * Pura e deterministica: stesso ingresso, stesse opzioni e stesso `now`
 * (solo per DTSTAMP, la minimizzazione e l'orizzonte della validazione) →
 * stessi oggetti e hash.
 */
export function serializeLegacy(source: LegacySource, options: MigrationOptions, ctx: { now: Date }): SerializationResult {
  const acc = new Accumulator();
  const calById = new Map(source.calendars.map((c) => [c.id, c]));
  const rowStamps = new Map<string, BuildStamps>();
  for (const e of source.events) rowStamps.set(e.id, { created: new Date(e.created_at), lastModified: new Date(e.updated_at) });
  const sctx: SerializerContext = {
    source,
    options,
    now: ctx.now,
    acc,
    calById,
    stamps: (id) => rowStamps.get(id),
    moveTarget: resolveMoveTarget(source.calendars, options),
    moveIds: new Set(options.bookings_move_event_ids.map((id) => id.toLowerCase())),
  };

  // Calendari esclusi dal piano: blocco per i nomi di collezione non validi.
  const sortedCalendars = [...source.calendars].sort((a, b) => (a.collection_name ?? a.slug).localeCompare(b.collection_name ?? b.slug) || a.id.localeCompare(b.id));
  for (const cal of sortedCalendars) {
    if (cal.excluded_reason === 'collection_name_invalid') {
      acc.anomaly('COLLECTION_NAME_INVALID', cal.id, null, { calendar_id: cal.id, slug: cal.slug, name: cal.name, collection_name: cal.collection_name });
    }
  }

  // Raggruppamento: master (singoli e serie), override per master, righe di proiezione per prenotazione.
  const masters: SourceEventRow[] = [];
  const overridesByMaster = new Map<string, SourceEventRow[]>();
  const projectionRows = new Map<string, SourceEventRow[]>();
  for (const row of source.events) {
    if (row.source === 'ics_pull') continue;
    if (row.recurrence_master_id) {
      const list = overridesByMaster.get(row.recurrence_master_id) ?? [];
      list.push(row);
      overridesByMaster.set(row.recurrence_master_id, list);
    } else if (row.source === 'booking' && row.source_id) {
      const list = projectionRows.get(row.source_id) ?? [];
      list.push(row);
      projectionRows.set(row.source_id, list);
    } else {
      masters.push(row);
    }
  }
  masters.sort((a, b) => a.calendar_id.localeCompare(b.calendar_id) || a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));

  // Festività di sistema: la prima per (calendario, data) per created_at e id.
  const holidayWinner = new Map<string, string>();
  const holidayDateOf = new Map<string, string>();
  const holidayCandidates = masters
    .filter((m) => m.source === 'system' && m.status !== 'cancelled' && calById.get(m.calendar_id)?.role === 'holidays')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const m of holidayCandidates) {
    const cal = calById.get(m.calendar_id) as MigrationCalendar;
    const date = holidayDate(m, safeTz(cal.timezone));
    holidayDateOf.set(m.id, date);
    const k = `${m.calendar_id}|${date}`;
    if (!holidayWinner.has(k)) holidayWinner.set(k, m.id);
  }

  const excludedCounts = new Map<string, number>();
  for (const master of masters) {
    const cal = calById.get(master.calendar_id);
    if (!cal) continue;
    const overrides = (overridesByMaster.get(master.id) ?? []).slice().sort((a, b) => byRecurrenceThenId(a, b));
    if (!cal.included || !cal.collection_name) {
      excludedCounts.set(cal.id, (excludedCounts.get(cal.id) ?? 0) + 1 + overrides.length);
      acc.skip({
        legacy_key: legacyKey('event', master.id),
        kind: 'event',
        calendar_id: cal.id,
        collection_name: cal.collection_name,
        code: 'EXCLUDED_CALENDAR',
        legacy_event_id: master.id,
        summary: master.summary,
      });
      continue;
    }
    serializeEventGroup(sctx, cal, master, overrides, holidayWinner, holidayDateOf);
  }
  for (const [calendarId, count] of [...excludedCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cal = calById.get(calendarId) as MigrationCalendar;
    acc.anomaly('EVENTS_IN_EXCLUDED_CALENDAR', calendarId, null, { calendar_id: calendarId, slug: cal.slug, excluded_reason: cal.excluded_reason, rows: count });
  }

  serializeBookings(sctx, projectionRows);
  flagPossibleDuplicates(sctx, masters);

  return finalize(sctx);
}

/** Data della festività: dal source_id it-holiday-YYYY-MM-DD, altrimenti la data locale dell'inizio. */
function holidayDate(row: LegacyEventRowSnapshot, tz: string): string {
  const m = HOLIDAY_SOURCE_ID_RE.exec(row.source_id ?? '');
  if (m) return m[1];
  const w = new Date(msOf(row.start_time) + offsetAt(msOf(row.start_time), tz));
  return w.toISOString().slice(0, 10);
}

/**
 * Calendario di destinazione degli spostamenti della decisione 8 (scelto, poi
 * quello di default, poi 'lavoro'): solo un calendario incluso di ruolo user.
 * null se nessuno è utilizzabile (lo spostamento non avviene e l'anomalia lo dice).
 */
export function resolveMoveTarget(calendars: readonly MigrationCalendar[], options: MigrationOptions): MigrationCalendar | null {
  const usable = (c: MigrationCalendar | undefined): c is MigrationCalendar => Boolean(c && c.included && c.collection_name && c.role === 'user');
  if (options.bookings_move_target_calendar_id) {
    const chosen = calendars.find((c) => c.id === options.bookings_move_target_calendar_id);
    return usable(chosen) ? chosen : null;
  }
  const byDefault = calendars.find((c) => c.is_default);
  if (usable(byDefault)) return byDefault;
  const lavoro = calendars.find((c) => c.slug === 'lavoro');
  return usable(lavoro) ? lavoro : null;
}

function isMixedByday(rule: string): boolean {
  const parts = new Map(rule.split(';').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim().toUpperCase(), p.slice(i + 1).trim().toUpperCase()] as const;
  }));
  const freq = parts.get('FREQ');
  if (freq !== 'MONTHLY' && freq !== 'YEARLY') return false;
  const days = (parts.get('BYDAY') ?? '').split(',').filter(Boolean);
  return days.some((d) => /^[+-]?\d/.test(d)) && days.some((d) => /^[A-Z]{2}$/.test(d));
}

/** Prime occorrenze delle due espansioni (legacy: intersezione di rrule.js; calendar-core: unione RFC 5545). */
function mixedBydayExpansions(cal: CalendarSnapshot, master: LegacyEventRowSnapshot, rule: string, now: Date): { legacy: string[]; core: string[] } {
  const from = msOf(master.start_time);
  const to = from + 2 * 366 * 86_400_000;
  const legacy = expandRRule({ rrule: rule, masterStartIso: master.start_time, fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString(), limit: 8 });
  let core: string[] = [];
  try {
    const exp = expandObject(trialMaster(cal, master, rule, now), { from, to, tz: cal.timezone, maxOccurrences: 8, computeRangeEnd: false });
    core = exp.occurrences.slice(0, 8).map((o) => new Date(o.startUtc).toISOString());
  } catch {
    core = [];
  }
  return { legacy, core };
}

/**
 * Dettaglio di DTSTART_NOT_IN_RULE: le prime occorrenze del legacy (quelle
 * dell'oggetto migrato) e quelle che RFC 5545 ricava dal DTSTART salvato (come
 * le vedono oggi gli iscritti al feed e come le vedrebbero i device senza il
 * riallineamento).
 */
function dtstartExpansions(cal: CalendarSnapshot, master: LegacyEventRowSnapshot, rule: string, now: Date): { legacy: string[]; rfc_from_saved_dtstart: string[] } {
  const from = msOf(master.start_time);
  const to = from + 400 * 86_400_000;
  const legacy = expandRRule({ rrule: rule, masterStartIso: master.start_time, fromIso: new Date(from - 86_400_000).toISOString(), toIso: new Date(to).toISOString(), limit: 5 });
  let rfc: string[] = [];
  try {
    const exp = expandObject(trialMaster(cal, master, rule, now), { from, to, tz: cal.timezone, maxOccurrences: 5, computeRangeEnd: false });
    rfc = exp.occurrences.slice(0, 5).map((o) => new Date(o.startUtc).toISOString());
  } catch {
    rfc = [];
  }
  return { legacy, rfc_from_saved_dtstart: rfc };
}

function serializeEventGroup(
  sctx: SerializerContext,
  sourceCal: MigrationCalendar,
  master: SourceEventRow,
  overrideRows: SourceEventRow[],
  holidayWinner: ReadonlyMap<string, string>,
  holidayDateOf: ReadonlyMap<string, string>,
): void {
  const { acc, options, now } = sctx;
  const key = legacyKey('event', master.id);

  // Decisione 8: eventi non-proiezione del calendario Prenotazioni.
  let targetCal = sourceCal;
  let movedTo: string | null = null;
  if (sourceCal.role === 'bookings') {
    const wantsMove = sctx.moveIds.has(master.id.toLowerCase());
    const target = wantsMove ? sctx.moveTarget : null;
    if (target) {
      targetCal = target;
      movedTo = target.id;
    }
    acc.anomaly('NON_PROJECTION_IN_BOOKINGS', sourceCal.id, key, {
      event_id: master.id,
      summary: master.summary,
      source: master.source,
      moved: movedTo !== null,
      move_requested: wantsMove,
      target_calendar_id: movedTo,
      ...(wantsMove && !target ? { move_target_invalid: true } : {}),
    });
  }
  const cal = calendarSnapshot(targetCal);
  const masterSnap = rowSnapshot(master);

  if (master.status === 'cancelled') {
    acc.anomaly('CANCELLED_MASTER', targetCal.id, key, { event_id: master.id, summary: master.summary, overrides: overrideRows.length });
    acc.skip({ legacy_key: key, kind: 'event', calendar_id: targetCal.id, collection_name: cal.collection_name, code: 'CANCELLED_MASTER', legacy_event_id: master.id, summary: master.summary });
    return;
  }

  // Festività duplicate: si migra la prima per data.
  let preferredHref: string | null = null;
  const isSystemHoliday = cal.role === 'holidays' && master.source === 'system';
  if (isSystemHoliday) {
    const date = holidayDateOf.get(master.id) ?? holidayDate(master, cal.timezone);
    const winner = holidayWinner.get(`${master.calendar_id}|${date}`);
    if (winner && winner !== master.id && targetCal.id === sourceCal.id) {
      acc.anomaly('DUPLICATE_HOLIDAY', targetCal.id, key, { event_id: master.id, date, kept_event_id: winner, summary: master.summary });
      acc.skip({ legacy_key: key, kind: 'event', calendar_id: targetCal.id, collection_name: cal.collection_name, code: 'DUPLICATE_HOLIDAY', legacy_event_id: master.id, summary: master.summary });
      return;
    }
    preferredHref = holidayHref(date);
  } else if (cal.role === 'holidays') {
    preferredHref = closureHref(master.id);
  }

  // Override: anomalie di calendario, duplicati per RECURRENCE-ID.
  const mismatched = overrideRows.filter((o) => o.calendar_id !== master.calendar_id);
  if (mismatched.length) {
    acc.anomaly('OVERRIDE_CALENDAR_MISMATCH', targetCal.id, key, {
      event_id: master.id,
      summary: master.summary,
      overrides: capped(mismatched.map((o) => ({ override_id: o.id, calendar_id: o.calendar_id }))),
    });
  }
  const cancelledRows = overrideRows.filter((o) => o.status === 'cancelled');
  const modifiedRows = overrideRows.filter((o) => o.status !== 'cancelled');
  const firstBySecond = new Map<number, SourceEventRow>();
  const duplicates: SourceEventRow[] = [];
  for (const ov of modifiedRows.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const k = secondKey(msOf(ov.recurrence_id as string));
    if (firstBySecond.has(k)) duplicates.push(ov);
    else firstBySecond.set(k, ov);
  }
  const uniqueModified = modifiedRows.filter((o) => !duplicates.includes(o));

  // Modello effettivo con tutte le opzioni globali, poi classificazione degli orfani sull'oggetto di prova.
  const flags: EventFlags = { fixUntil: options.fix_until_admin_pattern, realignDst: options.realign_dst_exceptions, realignDtstart: true };
  const candidates = [...uniqueModified, ...cancelledRows].map(rowSnapshot).sort(byRecurrenceThenId);
  let eff: EffectiveEvent;
  try {
    eff = effectiveEvent(cal, masterSnap, candidates, flags, now);
  } catch (err) {
    invalidGroup(sctx, cal, targetCal, master, key, err);
    return;
  }

  if (eff.rule.status === 'until_before_dtstart') {
    acc.anomaly('UNTIL_BEFORE_DTSTART', targetCal.id, key, {
      event_id: master.id,
      summary: master.summary,
      rrule: eff.rule.raw,
      // NO_LEGACY_OCCURRENCE: UNTIL prima della prima occorrenza della regola (DTSTART fuori dalla regola).
      ...(eff.rule.codes.includes('NO_LEGACY_OCCURRENCE') ? { reason: 'no_legacy_occurrence' } : {}),
    });
    acc.skip({ legacy_key: key, kind: 'event', calendar_id: targetCal.id, collection_name: cal.collection_name, code: 'UNTIL_BEFORE_DTSTART', legacy_event_id: master.id, summary: master.summary });
    return;
  }
  if (eff.rule.status === 'limit') {
    acc.anomaly('RADICALE_RRULE_LIMIT', targetCal.id, key, { event_id: master.id, summary: master.summary, rrule: eff.rule.raw, codes: eff.rule.codes });
    acc.skip({ legacy_key: key, kind: 'event', calendar_id: targetCal.id, collection_name: cal.collection_name, code: 'INVALID_OBJECT', legacy_event_id: master.id, summary: master.summary });
    return;
  }

  const anomalies = new Set<AnomalyCode>();
  const expected = new Set<ExpectedDiffReason>();
  if (movedTo) {
    anomalies.add('NON_PROJECTION_IN_BOOKINGS');
    expected.add('NON_PROJECTION_MOVED');
  } else if (sourceCal.role === 'bookings') {
    anomalies.add('NON_PROJECTION_IN_BOOKINGS');
  }
  if (mismatched.length) anomalies.add('OVERRIDE_CALENDAR_MISMATCH');

  // Orfani: master singolo o con RRULE non valida → tutti gli override modificati; altrimenti fuori regola.
  const orphanReasons = new Map<string, string>();
  for (const d of duplicates) orphanReasons.set(d.id, 'duplicate_recurrence_id');
  if (eff.rule.status === 'ok') {
    const trial = assembleEvent(cal, eff, now);
    const check = findOrphanOverrides(trial, { tz: cal.timezone });
    for (const idx of check.orphans) {
      const row = eff.overrides[idx]?.row;
      if (row) orphanReasons.set(row.id, 'not_in_rule');
    }
  } else {
    for (const o of uniqueModified) orphanReasons.set(o.id, eff.rule.status === 'invalid' ? 'invalid_rrule' : 'single_master');
  }

  // Anomalie della regola e delle eccezioni.
  if (eff.rule.status === 'invalid') {
    anomalies.add('INVALID_RRULE');
    expected.add('INVALID_RRULE_SINGLE');
    acc.anomaly('INVALID_RRULE', targetCal.id, key, { event_id: master.id, summary: master.summary, rrule: eff.rule.raw, codes: eff.rule.codes });
  }
  if (eff.rule.status === 'ok' && eff.rule.text) {
    if (eff.rule.adminPattern) {
      anomalies.add('UNTIL_ADMIN_PATTERN');
      if (eff.rule.fixed) expected.add('UNTIL_REALIGNED');
      acc.anomaly('UNTIL_ADMIN_PATTERN', targetCal.id, key, {
        event_id: master.id, summary: master.summary, until_from: eff.rule.adminPattern.from, until_to: eff.rule.adminPattern.to, fixed: eff.rule.fixed,
      });
    }
    if (master.all_day && /(^|;)UNTIL=\d{8}T/i.test(eff.rule.raw ?? '')) {
      anomalies.add('ALLDAY_UNTIL_DATETIME');
      acc.anomaly('ALLDAY_UNTIL_DATETIME', targetCal.id, key, { event_id: master.id, summary: master.summary, rrule: eff.rule.raw });
    }
    if (master.all_day && eff.exdates.length > 0) {
      anomalies.add('ALLDAY_EXDATE_DATETIME');
      acc.anomaly('ALLDAY_EXDATE_DATETIME', targetCal.id, key, { event_id: master.id, summary: master.summary, exdates: eff.exdates.length });
    }
    if (!master.all_day && cal.timezone !== ROME) {
      anomalies.add('NON_ROME_SERIES');
      acc.anomaly('NON_ROME_SERIES', targetCal.id, key, { event_id: master.id, summary: master.summary, calendar_timezone: cal.timezone });
    }
    if (eff.rule.dtstart) {
      anomalies.add('DTSTART_NOT_IN_RULE');
      expected.add('DTSTART_REALIGNED');
      acc.anomaly('DTSTART_NOT_IN_RULE', targetCal.id, key, {
        event_id: master.id,
        summary: master.summary,
        rrule: eff.rule.text,
        dtstart_from: eff.rule.dtstart.from,
        dtstart_to: eff.rule.dtstart.to,
        ...dtstartExpansions(cal, masterSnap, eff.rule.text, now),
      });
    }
    if (isMixedByday(eff.rule.text)) {
      anomalies.add('MIXED_BYDAY');
      expected.add('MIXED_BYDAY');
      acc.anomaly('MIXED_BYDAY', targetCal.id, key, {
        event_id: master.id, summary: master.summary, rrule: eff.rule.text, ...mixedBydayExpansions(cal, masterSnap, eff.rule.text, now),
      });
    }
  }

  // Override che restano nell'oggetto (non orfani) e cancellati (EXDATE).
  const keptModified = eff.overrides.map((o) => o.row).filter((r) => !orphanReasons.has(r.id));
  const snapshotOverrides = eff.rule.status === 'ok'
    ? [...keptModified, ...cancelledRows.map(rowSnapshot)].sort(byRecurrenceThenId)
    : [];
  const dst = eff.dst;
  const dstRelevant = dst && options.realign_dst_exceptions
    ? dst.changes.filter((c) => c.kind === 'exdate' || snapshotOverrides.some((o) => o.id === c.event_id))
    : [];
  if (dst && (dst.changes.length > 0 || dst.skipped.length > 0)) {
    anomalies.add('DST_SHIFTED_EXCEPTION');
    if (dstRelevant.length > 0) expected.add('DST_REALIGNED');
    acc.anomaly('DST_SHIFTED_EXCEPTION', targetCal.id, key, {
      event_id: master.id,
      summary: master.summary,
      realigned: options.realign_dst_exceptions,
      to_fix: dst.changes.length,
      not_fixable: dst.skipped.length,
      changes: capped(dst.changes),
      skipped: capped(dst.skipped),
    });
  }

  const snapOptions: SnapshotOptions = {};
  if (eff.rule.fixed) snapOptions.fix_until_admin_pattern = true;
  if (eff.rule.dtstart) snapOptions.realign_dtstart = true;
  if (dstRelevant.length > 0) snapOptions.realign_dst_exceptions = true;
  if (movedTo) snapOptions.moved_to_calendar_id = movedTo;
  const snapshot: LegacyEventSnapshot = {
    v: 1,
    kind: 'event',
    calendar: cal,
    master: masterSnap,
    overrides: snapshotOverrides,
    options: snapOptions,
  };

  // All-day ambigui (master e override modificati che restano).
  const ambiguous = [masterSnap, ...keptModified].filter((r) => r.all_day && legacyAllDayToRange(r.start_time, r.end_time, cal.timezone).convention !== 'local-midnight');
  if (ambiguous.length) {
    anomalies.add('ALLDAY_AMBIGUOUS');
    expected.add('ALLDAY_NORMALIZED');
    acc.anomaly('ALLDAY_AMBIGUOUS', targetCal.id, key, {
      event_id: master.id,
      summary: master.summary,
      rows: capped(ambiguous.map((r) => ({ event_id: r.id, start_time: r.start_time, end_time: r.end_time }))),
    });
  }
  if (keptModified.length) expected.add('OVERRIDE_UID_MASTER');
  if (snapshotOverrides.some((o) => o.status === 'cancelled')) expected.add('CANCELLED_OVERRIDE_SUPPRESSED');

  let built: { built: BuiltObject; eff: EffectiveEvent } | null = null;
  try {
    built = buildEventObject(snapshot, now, sctx.stamps);
  } catch (err) {
    invalidGroup(sctx, cal, targetCal, master, key, err);
  }
  if (built) {
    const validation = validateBuilt(built.built, cal.timezone, now);
    if (!validation.ok) {
      acc.anomaly(validation.anomaly as AnomalyCode, targetCal.id, key, {
        event_id: master.id, summary: master.summary, codes: validation.codes, properties: validation.properties,
      });
      acc.skip({ legacy_key: key, kind: 'event', calendar_id: targetCal.id, collection_name: cal.collection_name, code: validation.skip as SkipCode, legacy_event_id: master.id, summary: master.summary });
    } else {
      const overrideIds: ReservedObjectId[] = [];
      for (const comp of built.built.object.overrides) {
        const legacyId = getTextValue(comp, X_CALDES.LEGACY_ID)?.trim();
        if (!legacyId) continue;
        overrideIds.push({ recurrence_key: componentRecurrenceKey(comp, { tz: cal.timezone, timezones: built.built.object.timezones }), id: legacyId, legacy_event_id: legacyId });
      }
      acc.pending.push({
        legacy_key: key,
        kind: 'event',
        calendar_id: targetCal.id,
        collection_name: cal.collection_name,
        preferredHref: preferredHref ?? eventHrefForUid(master.uid),
        uid: master.uid,
        built: built.built,
        legacy_snapshot: snapshot,
        legacy_event_id: master.id,
        legacy_uid: master.uid,
        overrideIds,
        resourceId: master.id,
        anomalies,
        expected,
        summary: master.summary,
        tz: cal.timezone,
      });
    }
  }

  // Override orfani: staccati (convert) o scartati (discard).
  const orphanRows = [...uniqueModified, ...duplicates]
    .filter((o) => orphanReasons.has(o.id))
    .sort((a, b) => byRecurrenceThenId(a, b));
  for (const ov of orphanRows) {
    const dkey = legacyKey('detached', ov.id);
    const reason = orphanReasons.get(ov.id) as string;
    acc.anomaly('ORPHAN_OVERRIDE_NOT_IN_RULE', targetCal.id, dkey, {
      master_id: master.id,
      override_id: ov.id,
      recurrence_id: ov.recurrence_id,
      start_time: ov.start_time,
      summary: ov.summary,
      reason,
      action: options.orphans,
    });
    if (options.orphans === 'discard') {
      acc.skip({ legacy_key: dkey, kind: 'detached', calendar_id: targetCal.id, collection_name: cal.collection_name, code: 'ORPHAN_DISCARDED', legacy_event_id: ov.id, summary: ov.summary });
      continue;
    }
    serializeDetached(sctx, cal, targetCal, master, ov, movedTo);
  }
}

function invalidGroup(sctx: SerializerContext, cal: CalendarSnapshot, targetCal: MigrationCalendar, master: SourceEventRow, key: LegacyKey, err: unknown): void {
  const message = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
  sctx.acc.anomaly('INVALID_OBJECT', targetCal.id, key, { event_id: master.id, summary: master.summary, error: message });
  sctx.acc.skip({ legacy_key: key, kind: 'event', calendar_id: targetCal.id, collection_name: cal.collection_name, code: 'INVALID_OBJECT', legacy_event_id: master.id, summary: master.summary });
}

function serializeDetached(
  sctx: SerializerContext,
  cal: CalendarSnapshot,
  targetCal: MigrationCalendar,
  master: SourceEventRow,
  ov: SourceEventRow,
  movedTo: string | null,
): void {
  const { acc, now } = sctx;
  const key = legacyKey('detached', ov.id);
  const options: SnapshotOptions = { orphans: 'convert' };
  if (movedTo) options.moved_to_calendar_id = movedTo;
  const snapshot: LegacyDetachedSnapshot = {
    v: 1,
    kind: 'detached',
    calendar: cal,
    master_id: master.id,
    master_uid: master.uid,
    override: rowSnapshot(ov),
    options,
  };
  let built: BuiltObject;
  try {
    built = buildDetachedObject(snapshot, now, sctx.stamps);
  } catch (err) {
    acc.anomaly('INVALID_OBJECT', targetCal.id, key, { override_id: ov.id, master_id: master.id, summary: ov.summary, error: err instanceof Error ? err.message.slice(0, 200) : 'errore' });
    acc.skip({ legacy_key: key, kind: 'detached', calendar_id: targetCal.id, collection_name: cal.collection_name, code: 'INVALID_OBJECT', legacy_event_id: ov.id, summary: ov.summary });
    return;
  }
  const validation = validateBuilt(built, cal.timezone, now);
  if (!validation.ok) {
    acc.anomaly(validation.anomaly as AnomalyCode, targetCal.id, key, { override_id: ov.id, master_id: master.id, summary: ov.summary, codes: validation.codes, properties: validation.properties });
    acc.skip({ legacy_key: key, kind: 'detached', calendar_id: targetCal.id, collection_name: cal.collection_name, code: validation.skip as SkipCode, legacy_event_id: ov.id, summary: ov.summary });
    return;
  }
  const uid = built.object.uid;
  const expected = new Set<ExpectedDiffReason>(['ORPHAN_CONVERTED']);
  if (movedTo) expected.add('NON_PROJECTION_MOVED');
  const anomalies = new Set<AnomalyCode>(['ORPHAN_OVERRIDE_NOT_IN_RULE']);
  if (movedTo) anomalies.add('NON_PROJECTION_IN_BOOKINGS');
  if (ov.all_day && legacyAllDayToRange(ov.start_time, ov.end_time, cal.timezone).convention !== 'local-midnight') {
    anomalies.add('ALLDAY_AMBIGUOUS');
    expected.add('ALLDAY_NORMALIZED');
  }
  acc.pending.push({
    legacy_key: key,
    kind: 'detached',
    calendar_id: targetCal.id,
    collection_name: cal.collection_name,
    preferredHref: eventHrefForUid(uid),
    uid,
    built,
    legacy_snapshot: snapshot,
    legacy_event_id: ov.id,
    legacy_uid: ov.uid,
    overrideIds: [],
    resourceId: ov.id,
    anomalies,
    expected,
    summary: ov.summary,
    tz: cal.timezone,
  });
}

function serializeBookings(sctx: SerializerContext, projectionRows: ReadonlyMap<string, SourceEventRow[]>): void {
  const { acc, source, now } = sctx;
  const bookingsCal = source.calendars
    .filter((c) => c.included && c.role === 'bookings' && c.collection_name)
    .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id))[0] ?? null;
  if (!bookingsCal) return;
  const cal = calendarSnapshot(bookingsCal);
  const bookingByUid = new Map<string, SourceBookingRow>(source.bookings.map((b) => [b.uid, b]));
  const uids = [...new Set([...source.bookings.map((b) => b.uid), ...projectionRows.keys()])].sort();

  for (const uid of uids) {
    const key = legacyKey('booking', uid);
    const booking = bookingByUid.get(uid) ?? null;
    const rows = (projectionRows.get(uid) ?? []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const activeRow = rows.find((r) => r.status !== 'cancelled') ?? null;
    const legacyRow = activeRow ?? rows[0] ?? null;

    if (!booking) {
      if (activeRow) {
        acc.anomaly('BOOKING_DRIFT', cal.id, key, { kind: 'orphan_projection', booking_uid: uid, legacy_event_id: activeRow.id });
      }
      if (legacyRow) {
        acc.skip({ legacy_key: key, kind: 'booking', calendar_id: cal.id, collection_name: cal.collection_name, code: 'BOOKING_NOT_PROJECTED', legacy_event_id: legacyRow.id, summary: null });
      }
      continue;
    }
    if (!PROJECTED_BOOKING_STATUSES.has(booking.status as BookingStatus)) {
      // Pending, annullate o riprogrammate: la riga legacy resta com'è, nella destinazione nessuna proiezione.
      if (legacyRow) {
        acc.skip({ legacy_key: key, kind: 'booking', calendar_id: cal.id, collection_name: cal.collection_name, code: 'BOOKING_NOT_PROJECTED', legacy_event_id: legacyRow.id, summary: null });
      }
      continue;
    }

    const anomalies = new Set<AnomalyCode>();
    const expected = new Set<ExpectedDiffReason>(['BOOKING_REGENERATED']);
    if (!activeRow) {
      anomalies.add('BOOKING_DRIFT');
      expected.add('BOOKING_DRIFT');
      acc.anomaly('BOOKING_DRIFT', cal.id, key, { kind: 'missing_projection', booking_uid: uid, legacy_event_id: legacyRow?.id ?? null });
    } else if (msOf(activeRow.start_time) !== msOf(booking.start_time) || msOf(activeRow.end_time) !== msOf(booking.end_time)) {
      anomalies.add('BOOKING_DRIFT');
      expected.add('BOOKING_DRIFT');
      acc.anomaly('BOOKING_DRIFT', cal.id, key, {
        kind: 'time_mismatch',
        booking_uid: uid,
        legacy_event_id: activeRow.id,
        legacy: { start_time: activeRow.start_time, end_time: activeRow.end_time },
        booking: { start_time: booking.start_time, end_time: booking.end_time },
      });
    }

    const minimized = booking.anonymized || isBookingProjectionExpired(booking.end_time, now);
    const snapshot: LegacyBookingSnapshot = {
      v: 1,
      kind: 'booking',
      calendar: cal,
      booking: minimized
        ? {
          uid,
          status: booking.status,
          start_time: booking.start_time,
          end_time: booking.end_time,
          title: '',
          attendee_name: '',
          attendee_phone: null,
          location: null,
          meeting_url: null,
          created_at: booking.created_at,
        }
        : {
          uid,
          status: booking.status,
          start_time: booking.start_time,
          end_time: booking.end_time,
          title: booking.title,
          attendee_name: booking.attendee_name,
          attendee_phone: booking.attendee_phone,
          location: booking.location,
          meeting_url: booking.meeting_url,
          created_at: booking.created_at,
        },
      legacy_event_id: legacyRow?.id ?? null,
      legacy_uid: legacyRow?.uid ?? null,
      minimized,
    };
    let built: BuiltObject;
    try {
      built = buildBookingObject(snapshot, now);
    } catch (err) {
      acc.anomaly('INVALID_OBJECT', cal.id, key, { booking_uid: uid, error: err instanceof Error ? err.message.slice(0, 120) : 'errore' });
      acc.skip({ legacy_key: key, kind: 'booking', calendar_id: cal.id, collection_name: cal.collection_name, code: 'INVALID_OBJECT', legacy_event_id: legacyRow?.id ?? null, summary: null });
      continue;
    }
    const validation = validateBuilt(built, cal.timezone, now);
    if (!validation.ok) {
      acc.anomaly(validation.anomaly as AnomalyCode, cal.id, key, { booking_uid: uid, codes: validation.codes, properties: validation.properties });
      acc.skip({ legacy_key: key, kind: 'booking', calendar_id: cal.id, collection_name: cal.collection_name, code: validation.skip as SkipCode, legacy_event_id: legacyRow?.id ?? null, summary: null });
      continue;
    }
    const projectionUid = bookingProjectionUid(uid);
    acc.pending.push({
      legacy_key: key,
      kind: 'booking',
      calendar_id: cal.id,
      collection_name: cal.collection_name,
      preferredHref: bookingHref(uid),
      uid: projectionUid,
      built,
      legacy_snapshot: snapshot,
      legacy_event_id: legacyRow?.id ?? null,
      legacy_uid: legacyRow?.uid ?? null,
      overrideIds: [],
      resourceId: legacyRow?.id ?? deterministicObjectId(projectionUid, MASTER_RECURRENCE_KEY),
      anomalies,
      expected,
      summary: null,
      tz: cal.timezone,
    });
  }
}

/**
 * POSSIBLE_DUPLICATE (informativa): singoli identici (stesso calendario,
 * titolo, orari e tipo) come le copie fatte con "Duplica", e singoli uguali a
 * un'occorrenza di una serie dello stesso calendario con lo stesso titolo.
 */
function flagPossibleDuplicates(sctx: SerializerContext, masters: readonly SourceEventRow[]): void {
  const { acc } = sctx;
  const pendingByKey = new Map(acc.pending.map((p) => [p.legacy_key as string, p]));
  const mark = (id: string): void => {
    pendingByKey.get(legacyKey('event', id))?.anomalies.add('POSSIBLE_DUPLICATE');
  };
  const singles = masters
    .filter((m) => !m.rrule && m.status !== 'cancelled' && sctx.calById.get(m.calendar_id)?.included)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const firstOf = new Map<string, SourceEventRow>();
  const flagged = new Set<string>();
  for (const s of singles) {
    const k = `${s.calendar_id}|${s.summary}|${msOf(s.start_time)}|${msOf(s.end_time)}|${s.all_day}`;
    const first = firstOf.get(k);
    if (!first) { firstOf.set(k, s); continue; }
    flagged.add(s.id);
    mark(s.id);
    acc.anomaly('POSSIBLE_DUPLICATE', s.calendar_id, legacyKey('event', s.id), {
      event_id: s.id, summary: s.summary, start_time: s.start_time, duplicate_of: first.id, source: s.source, source_id: s.source_id,
    });
  }
  // Singoli uguali a un'occorrenza di una serie migrata dello stesso calendario.
  const seriesByCalendar = new Map<string, PendingObject[]>();
  for (const p of acc.pending) {
    if (p.kind !== 'event' || p.legacy_snapshot.kind !== 'event' || !p.legacy_snapshot.master.rrule) continue;
    const list = seriesByCalendar.get(p.calendar_id) ?? [];
    list.push(p);
    seriesByCalendar.set(p.calendar_id, list);
  }
  for (const s of singles) {
    if (flagged.has(s.id)) continue;
    const series = (seriesByCalendar.get(s.calendar_id) ?? []).filter((p) => p.legacy_snapshot.kind === 'event' && p.legacy_snapshot.master.summary === s.summary);
    const start = msOf(s.start_time);
    const end = msOf(s.end_time);
    for (const p of series) {
      try {
        const exp = expandObject(p.built.object, { from: start, to: Math.max(end, start + 1000), tz: p.tz, computeRangeEnd: false });
        if (exp.occurrences.some((o) => o.startUtc === start && o.endUtc === end && o.status !== 'CANCELLED')) {
          mark(s.id);
          acc.anomaly('POSSIBLE_DUPLICATE', s.calendar_id, legacyKey('event', s.id), {
            event_id: s.id, summary: s.summary, start_time: s.start_time, duplicate_of_series: p.legacy_event_id, source: s.source, source_id: s.source_id,
          });
          break;
        }
      } catch {
        // Espansione non riuscita: nessuna segnalazione.
      }
    }
  }
}

/** Href (riuso del ledger e di cal_object_ids), unicità di href e UID per collezione, ordinamento finale. */
function finalize(sctx: SerializerContext): SerializationResult {
  const { acc, source } = sctx;
  const ledgerByCalKey = new Map<string, LedgerRow>();
  const ledgerByKey = new Map<string, LedgerRow[]>();
  const ledgerHrefOwner = new Map<string, string>();
  for (const l of source.ledger) {
    if (l.deleted_at) continue;
    ledgerByCalKey.set(`${l.calendar_id}|${l.legacy_key}`, l);
    const list = ledgerByKey.get(l.legacy_key) ?? [];
    list.push(l);
    ledgerByKey.set(l.legacy_key, list);
    ledgerHrefOwner.set(`${l.calendar_id}|${l.href}`, l.legacy_key);
  }
  const used = new Map<string, string>();
  const hrefOf = new Map<PendingObject, string>();
  const free = (cal: string, href: string, key: string): boolean => {
    if (!isValidObjectName(href)) return false;
    const owner = ledgerHrefOwner.get(`${cal}|${href}`);
    if (owner && owner !== key) return false;
    const taken = used.get(`${cal}|${href}`);
    return !taken || taken === key;
  };
  const take = (p: PendingObject, href: string): void => {
    used.set(`${p.calendar_id}|${href}`, p.legacy_key);
    hrefOf.set(p, href);
  };
  const ordered = [...acc.pending].sort((a, b) => a.legacy_key.localeCompare(b.legacy_key));
  // 1. href già noto nel ledger della stessa collezione: vince sempre.
  for (const p of ordered) {
    const l = ledgerByCalKey.get(`${p.calendar_id}|${p.legacy_key}`);
    if (l) take(p, l.href);
  }
  // 2. cal_object_ids della riga legacy, href dello stesso oggetto in un'altra collezione, href deterministico, ripiego.
  for (const p of ordered) {
    if (hrefOf.has(p)) continue;
    const oid = p.legacy_event_id ? source.objectIds.get(p.legacy_event_id) : undefined;
    const candidates: string[] = [];
    if (oid && oid.calendar_id === p.calendar_id && oid.recurrence_key === MASTER_RECURRENCE_KEY) candidates.push(oid.href);
    for (const l of ledgerByKey.get(p.legacy_key) ?? []) candidates.push(l.href);
    candidates.push(p.preferredHref, keyHref(p.legacy_key));
    const chosen = candidates.find((h) => free(p.calendar_id, h, p.legacy_key)) ?? keyHref(p.legacy_key);
    take(p, chosen);
  }

  // UID unici per collezione (Radicale rifiuta due risorse con lo stesso UID).
  const uidOwner = new Map<string, string>();
  const objects: SerializedObject[] = [];
  for (const p of ordered) {
    const href = hrefOf.get(p) as string;
    const uidKey = `${p.calendar_id}|${p.uid}`;
    const owner = uidOwner.get(uidKey);
    if (owner && owner !== p.legacy_key) {
      acc.anomaly('INVALID_OBJECT', p.calendar_id, p.legacy_key, { reason: 'duplicate_uid', uid: p.uid, kept_legacy_key: owner });
      acc.skip({ legacy_key: p.legacy_key, kind: p.kind, calendar_id: p.calendar_id, collection_name: p.collection_name, code: 'INVALID_OBJECT', legacy_event_id: p.legacy_event_id, summary: p.summary });
      continue;
    }
    uidOwner.set(uidKey, p.legacy_key);
    const objectIds: ReservedObjectId[] = [
      { recurrence_key: MASTER_RECURRENCE_KEY, id: p.resourceId, legacy_event_id: p.legacy_event_id },
      ...p.overrideIds,
    ];
    objects.push({
      legacy_key: p.legacy_key,
      kind: p.kind,
      calendar_id: p.calendar_id,
      collection_name: p.collection_name,
      href,
      uid: p.uid,
      ics: p.built.ics,
      fingerprint: p.built.fingerprint,
      legacy_snapshot: p.legacy_snapshot,
      legacy_hash: legacyHash(p.legacy_snapshot),
      legacy_event_id: p.legacy_event_id,
      legacy_uid: p.legacy_uid,
      object_ids: objectIds,
      anomalies: [...p.anomalies].sort(),
      expected_reasons: [...p.expected].sort(),
      summary: p.summary,
    });
  }
  objects.sort((a, b) => a.collection_name.localeCompare(b.collection_name) || a.href.localeCompare(b.href) || a.legacy_key.localeCompare(b.legacy_key));
  const skipped = [...acc.skipped].sort((a, b) => a.legacy_key.localeCompare(b.legacy_key) || a.calendar_id.localeCompare(b.calendar_id));
  const anomalies = [...acc.anomalies].sort((a, b) =>
    (a.calendar_id ?? '').localeCompare(b.calendar_id ?? '')
    || (a.legacy_key ?? '').localeCompare(b.legacy_key ?? '')
    || a.code.localeCompare(b.code)
    || canonicalJson(a.detail).localeCompare(canonicalJson(b.detail)));
  return { serializer_version: SERIALIZER_VERSION, objects, skipped, anomalies };
}

// ─── Patch per campo (shadow e righe adottate) ───────────────────────────────

/** Componenti di un oggetto per recurrence key (master = MASTER_RECURRENCE_KEY). */
function componentsByKey(obj: CalendarObject, tz: string): Map<string, IcsComponent> {
  const out = new Map<string, IcsComponent>();
  if (obj.master) out.set(MASTER_RECURRENCE_KEY, obj.master);
  for (const c of obj.overrides) {
    try {
      const k = componentRecurrenceKey(c, { tz, timezones: obj.timezones });
      if (!out.has(k)) out.set(k, c);
    } catch {
      // RECURRENCE-ID illeggibile: componente non indirizzabile, resta com'è.
    }
  }
  return out;
}

function fieldsOfOps(ops: readonly PatchOp[]): string[] {
  return ops.map((op) => (op.op === 'set' ? op.field : op.name));
}

/** Ops per le X-prop della provenienza cambiate fra prima e dopo (le altre X-* restano). */
function provenanceOps(before: IcsComponent, after: IcsComponent): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const name of PROVENANCE_XPROPS) {
    const a = getProperties(before, name).map((p) => p.value).join('\n');
    const b = getProperties(after, name).map((p) => p.value).join('\n');
    if (a !== b) ops.push({ op: 'setProperty', name, properties: getProperties(after, name).map((p) => ({ ...p, params: p.params.map((x) => ({ ...x, values: [...x.values] })) })) });
  }
  return ops;
}

function provenanceBase(before: IcsComponent): Record<string, IcsProperty[]> {
  const out: Record<string, IcsProperty[]> = {};
  for (const name of PROVENANCE_XPROPS) out[name] = getProperties(before, name).map((p) => ({ ...p, params: p.params.map((x) => ({ ...x, values: [...x.values] })) }));
  return out;
}

function legacyFieldsOf(comp: IcsComponent, tz: string, timezones: readonly IcsComponent[]): LegacyEventFields {
  return toLegacyEventFields(comp, { tz, timezones });
}

/**
 * Shadow e update delle righe adottate: applica all'oggetto corrente della destinazione solo i campi cambiati fra
 * lo snapshot precedente e quello nuovo (opsFromLegacyDiff per master e override; materializeOverride ed
 * excludeOccurrence per override aggiunti o tolti; per le proiezioni SUMMARY, DESCRIPTION, LOCATION, URL, DTSTART,
 * DTEND e STATUS), con CAS dei soli campi toccati (checkBase con la base dello snapshot precedente).
 *
 * Restituisce l'oggetto patchato anche in presenza di conflitti (vince il
 * valore nuovo): decide il chiamante (lo shadow scrive solo senza conflitti,
 * "forza" scrive il contenuto completo del piano). I campi degli override
 * hanno il prefisso `override[<recurrence key>]`.
 */
export function patchFromLegacyDiff(
  target: CalendarObject,
  previous: LegacySnapshot,
  current: LegacySnapshot,
  ctx: { tz: string; now: Date },
): FieldPatchResult {
  if (previous.kind !== current.kind || previous.kind === 'archive' || current.kind === 'archive') {
    throw new TypeError(`patch per campo non applicabile (${previous.kind} → ${current.kind})`);
  }
  if (previous.kind === 'booking' && current.kind === 'booking' && previous.minimized !== current.minimized) {
    // Cambio di minimizzazione (24 mesi, anonimizzazione): i campi della decisione 3 si riscrivono
    // comunque, con la base presa dall'oggetto corrente (come patchTowardSnapshot), anche se la
    // ricostruzione dello snapshot precedente non li distinguesse.
    return patchAgainstBase(target, target, safeTz(ctx.tz), current, ctx);
  }
  const prev = buildObjectFromSnapshot(previous, { now: ctx.now }).object;
  return patchAgainstBase(target, prev, previous.calendar.timezone, current, ctx);
}

/**
 * Patch per campo senza la base dello snapshot precedente: la usa l'erasure
 * GDPR, che azzera legacy_snapshot e legacy_hash della riga (contratto §13,
 * "patch dei campi redatti"). La base è l'oggetto corrente stesso: ogni campo
 * del piano diverso dall'oggetto voluto prende il valore del legacy
 * (autorevole in F3, e la cancellazione è dovuta), mentre VALARM, ATTENDEE e
 * X-* della destinazione restano come in ogni patch per campo (§4.4: mai la
 * riscrittura completa di una riga adottata). Senza base non ci sono conflitti
 * da rilevare.
 */
export function patchTowardSnapshot(target: CalendarObject, current: LegacySnapshot, ctx: { tz: string; now: Date }): FieldPatchResult {
  if (current.kind === 'archive') throw new TypeError('patch per campo non applicabile (archive)');
  return patchAgainstBase(target, target, safeTz(ctx.tz), current, ctx);
}

/** Esito di una patch per campo: oggetto patchato, campi toccati e conflitti del CAS. */
export interface FieldPatchResult {
  object: CalendarObject;
  changed: boolean;
  fields: string[];
  conflicts: FieldConflict[];
}

/**
 * Nucleo comune di patchFromLegacyDiff e patchTowardSnapshot: campi cambiati
 * fra `prev` (oggetto della base) e lo snapshot nuovo, applicati all'oggetto
 * corrente con il CAS dei soli campi toccati.
 */
function patchAgainstBase(
  target: CalendarObject,
  prev: CalendarObject,
  prevTz: string,
  current: Exclude<LegacySnapshot, { kind: 'archive' }>,
  ctx: { tz: string; now: Date },
): FieldPatchResult {
  const tz = safeTz(ctx.tz);
  const cur = buildObjectFromSnapshot(current, { now: ctx.now }).object;
  let work = cloneCalendarObject(target);
  const fields: string[] = [];
  const conflicts: FieldConflict[] = [];

  if (!work.master || !prev.master || !cur.master) {
    throw new TypeError('patch per campo: oggetto senza master');
  }

  if (current.kind === 'booking') {
    const before = readFieldValues(prev.master, PROJECTION_FIELDS);
    const after = readFieldValues(cur.master, PROJECTION_FIELDS);
    const ops: PatchOp[] = [...diffFieldValues(before, after), ...provenanceOps(prev.master, cur.master)];
    if (ops.length) {
      const touched = ops.filter((o): o is Extract<PatchOp, { op: 'set' }> => o.op === 'set').map((o) => o.field);
      conflicts.push(...checkBase(work.master, ops, { ...readFieldValues(prev.master, touched), properties: provenanceBase(prev.master) }));
      work = applyPatch(work, MASTER_RECURRENCE_KEY, ops, { tz, now: ctx.now }).object;
      fields.push(...fieldsOfOps(ops));
    }
    return { object: work, changed: semanticFingerprint(work) !== semanticFingerprint(target), fields: [...new Set(fields)].sort(), conflicts };
  }

  // Eventi e override staccati: master con opsFromLegacyDiff.
  const curTz = current.calendar.timezone;
  const masterOps: PatchOp[] = [
    ...opsFromLegacyDiff(work.master, legacyFieldsOf(prev.master, prevTz, prev.timezones), legacyFieldsOf(cur.master, curTz, cur.timezones), { tz, now: ctx.now, timezones: work.timezones }),
    ...provenanceOps(prev.master, cur.master),
  ];
  if (masterOps.length) {
    const touched = masterOps.filter((o): o is Extract<PatchOp, { op: 'set' }> => o.op === 'set').map((o) => o.field);
    conflicts.push(...checkBase(work.master, masterOps, { ...readFieldValues(prev.master, touched), properties: provenanceBase(prev.master) }));
    work = applyPatch(work, MASTER_RECURRENCE_KEY, masterOps, { tz, now: ctx.now }).object;
    fields.push(...fieldsOfOps(masterOps));
  }

  if (current.kind === 'event') {
    const prevComps = componentsByKey(prev, prevTz);
    const curComps = componentsByKey(cur, curTz);
    prevComps.delete(MASTER_RECURRENCE_KEY);
    curComps.delete(MASTER_RECURRENCE_KEY);
    const keys = [...new Set([...prevComps.keys(), ...curComps.keys()])].sort();
    for (const k of keys) {
      const p = prevComps.get(k) ?? null;
      const c = curComps.get(k) ?? null;
      const label = `override[${k}]`;
      const targetComps = componentsByKey(work, tz);
      const t = targetComps.get(k) ?? null;
      if (p && c) {
        const ops = opsFromLegacyDiff(t ?? p, legacyFieldsOf(p, prevTz, prev.timezones), legacyFieldsOf(c, curTz, cur.timezones), { tz, now: ctx.now, timezones: work.timezones });
        if (ops.length === 0) continue;
        if (t) {
          const touched = ops.filter((o): o is Extract<PatchOp, { op: 'set' }> => o.op === 'set').map((o) => o.field);
          conflicts.push(...checkBase(t, ops, readFieldValues(p, touched)).map((x) => ({ ...x, field: `${label}.${x.field}` })));
          work = applyPatch(work, k, ops, { tz, now: ctx.now, createOverride: false }).object;
          fields.push(...fieldsOfOps(ops).map((f) => `${label}.${f}`));
        } else {
          // Override tolto nella destinazione e cambiato nel legacy: conflitto, si rimette.
          conflicts.push({ field: label, base: 'presente', theirs: null, yours: 'presente' });
          work = addOverride(work, k, c, tz, ctx.now);
          fields.push(label);
        }
      } else if (c) {
        if (t) {
          const ops = diffFieldValues(readFieldValues(t, OVERRIDE_FIELDS), readFieldValues(c, OVERRIDE_FIELDS));
          if (ops.length === 0) continue;
          conflicts.push({ field: label, base: null, theirs: 'presente', yours: 'presente' });
          work = applyPatch(work, k, ops, { tz, now: ctx.now, createOverride: false }).object;
        } else {
          work = addOverride(work, k, c, tz, ctx.now);
        }
        fields.push(label);
      } else if (p) {
        if (!t) continue;
        const differs = diffFieldValues(readFieldValues(p, OVERRIDE_FIELDS), readFieldValues(t, OVERRIDE_FIELDS)).length > 0;
        if (differs) conflicts.push({ field: label, base: 'presente', theirs: 'modificato', yours: null });
        work = removeOverride(work, k, tz);
        fields.push(label);
      }
    }
  }
  return { object: work, changed: semanticFingerprint(work) !== semanticFingerprint(target), fields: [...new Set(fields)].sort(), conflicts };
}

/** Override nuovo: materializzato dall'oggetto corrente (VALARM e X-* del master restano), con i campi del legacy. */
function addOverride(obj: CalendarObject, key: string, wanted: IcsComponent, tz: string, now: Date): CalendarObject {
  const mat = materializeOverride(obj, key, { tz, now });
  const comp = mat.object.overrides[mat.index];
  const ops: PatchOp[] = [
    ...diffFieldValues(readFieldValues(comp, OVERRIDE_FIELDS), readFieldValues(wanted, OVERRIDE_FIELDS)),
  ];
  const legacyId = getTextValue(wanted, X_CALDES.LEGACY_ID);
  if (legacyId) ops.push({ op: 'setProperty', name: X_CALDES.LEGACY_ID, properties: [createProperty(X_CALDES.LEGACY_ID, encodeText(legacyId))] });
  if (ops.length === 0) return mat.object;
  return applyPatch(mat.object, key, ops, { tz, now, createOverride: false }).object;
}

function removeOverride(obj: CalendarObject, key: string, tz: string): CalendarObject {
  const out = cloneCalendarObject(obj);
  out.overrides = out.overrides.filter((c) => {
    try {
      return componentRecurrenceKey(c, { tz, timezones: out.timezones }) !== key;
    } catch {
      return true;
    }
  });
  return out;
}
