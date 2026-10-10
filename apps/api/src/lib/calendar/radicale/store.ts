/**
 * RadicaleStore: store del calendario per i modi radicale, rollback e
 * finalized (fase F2 del passaggio a Radicale; design §7, §8, §11 lato API,
 * §12, §13.1; contratto dei moduli docs/calendar-radicale/contracts/f2-modules.md
 * §6.2). Implementa CalendarStore di ../store.ts con le stesse firme, gli
 * stessi errori e gli stessi messaggi dello store legacy.
 *
 * LETTURE dall'indice derivato (pool principale `sql`):
 *  - listOccurrences: cal_occurrences ⋈ cal_components per sovrapposizione su
 *    `span`; oltre l'orizzonte materializzato della collezione e oltre
 *    materialized_until di un oggetto si espande al volo da cal_objects.raw_ics
 *    con calendar-core; le iscrizioni portano il calendario di destinazione
 *    come calendar_id (design §1);
 *  - getEvent: resolver degli id (ids.resolveEventRef) più GET diretto su
 *    Radicale; con Radicale giù, non configurato o identità del volume non
 *    verificata si risponde dall'indice in sola lettura;
 *  - getBusyRanges = busy.indexBusyRanges con le proiezioni delle
 *    prenotazioni (semantica della facade di oggi, BUSY), sync delle iscrizioni =
 *    subscriptions/pull (SUBS), buildCalendarFeed =
 *    feed-builder.buildIndexFeed (CONSUMERS, caricato alla prima chiamata:
 *    vedi "Feed dall'indice").
 *
 * SCRITTURE (pipeline del design §8):
 *  1. guardie API identiche a oggi (iscrizioni in sola lettura con il testo di
 *     assertWritable, proiezioni di prenotazioni attive non eliminabili,
 *     calendari di sistema non eliminabili, validazioni con gli stessi
 *     messaggi) più la whitelist di `source` (design §14) e validateObject di
 *     calendar-core;
 *  2. gate cal-write (write-gate.ts): lock condiviso, modo riletto senza
 *     cache, write_freeze; poi identità del volume `ok` (mai scrivere su un
 *     volume sconosciuto);
 *  3. GET (testo ed ETag);
 *  4. CAS per campo: per admin v1 e MCP la base è implicita (i valori letti
 *     al passo 3) con un solo nuovo tentativo dopo un 412: se i campi toccati
 *     hanno ancora i valori di base la modifica si riapplica al testo
 *     corrente, altrimenti 409 CalendarFieldConflictError {field, base,
 *     theirs, yours};
 *  5. patch lossless di calendar-core (VALARM, ATTENDEE, X-* e parametri
 *     sconosciuti restano), recurrence-ops per le ricorrenze;
 *  6. PUT con If-Match (creazione: If-None-Match: *) tramite il client F1,
 *     che ripete solo i metodi idempotenti; un 412 riparte dal passo 3;
 *  7. rilascio del gate, poi write-through syncCollection (reason
 *     'write-through'): se fallisce la scrittura resta valida, il DTO si
 *     costruisce dal testo scritto e il watcher indicizzerà;
 *  8. riga in audit_logs (table_name 'cal_objects', {collection, href, etag},
 *     mai il testo).
 * Un target {recurrence_key} che non è più un'istanza corrente →
 * CalendarRecurrenceConflictError (409). "Questa e le successive" è la saga
 * recurrence_split (splitRecurringEvent + job di recupero).
 *
 * CALENDARI: creazione con riga `creating` che prenota collection_name →
 * MKCALENDAR con le dead prop calendar-id e role → `active` (MKCALENDAR
 * fallita → riga eliminata); modifica con PROPPATCH più sidecar; eliminazione
 * con `deleting` → DELETE della collezione → delete della riga con
 * caldes.reverse_sync='on'. Le creazioni e cancellazioni rimaste a metà le
 * completa il job calendar_lifecycle (registerStoreJobs).
 *
 * Radicale non configurato o irraggiungibile: letture dall'indice, scritture
 * → CalendarUnavailableError('radicale_unreachable'). Mai MKCOL/MKCALENDAR
 * impliciti: l'unica MKCALENDAR è quella esplicita di createCalendar.
 *
 * In mode postgres (produzione dopo il deploy della F2) questo store non viene
 * selezionato: lo usa un modo diverso da postgres/cutover o un test che lo
 * forza con overrideCalendarStore('radicale'). La costruzione non fa I/O.
 *
 * Regola d'import: da ../store solo tipi (store.ts importa questo modulo).
 */

import { createHash } from 'node:crypto';
import {
  applyLegacyUpdate,
  buildEventFromLegacy,
  type CalendarObject,
  type CalendarRole,
  canonicalVtimezone,
  checkBase,
  cloneCalendarObject,
  componentRecurrenceKey,
  conservativeRangeFromText,
  createCalendarObject,
  dateToLegacyIso,
  deriveProvenance,
  excludeOccurrence,
  expandObject,
  getProperty,
  getTextValue,
  holidayHref,
  holidayUid,
  type IcsComponent,
  type IcsTime,
  IcsValueError,
  isCalendarCoreError,
  isClientSource,
  type LegacyEventUpdate,
  legacyStatusOf,
  materializeOverride,
  occurrenceExists,
  parseCalendarObject,
  PatchConflictError,
  type PatchBase,
  type PatchFieldName,
  type PatchOp,
  readFieldValues,
  readTimeProperty,
  recurrenceKeyOf,
  RecurrenceTargetError,
  removeProperties,
  serializeCalendar,
  serializeObject,
  shiftSeries,
  splitSeries,
  toLegacyEventFields,
  truncateSeries,
  UNTITLED_SUMMARY,
  utcMsToTime,
  validateObject,
  ValidationError,
  type ValidationIssue,
  type ZoneContext,
} from '@calicchia/calendar-core';
import { customAlphabet } from 'nanoid';
import type { Logger } from 'pino';
import postgres from 'postgres';
import { jsonb, sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { isoOrNull, toLegacyCalendar, toLegacyEvent, toLegacyOccurrence } from '../adapters';
import { assertReadyOrDegraded, indexBusyRanges } from '../busy';
import { PROJECTED_BOOKING_STATUSES } from '../booking-projection';
import {
  CalendarConflictError,
  CalendarFieldConflictError,
  CalendarRecurrenceConflictError,
  CalendarStoreUnavailableError,
  CalendarSystemError,
  CalendarUnavailableError,
  CalendarValidationError,
  EventReadOnlyError,
  EventValidationError,
  type FieldConflict,
  isCalendarUnavailable,
  SubscriptionValidationError,
} from '../errors';
import { type CalComponentRow, type CalOccurrenceRow, MASTER_RECURRENCE_KEY, targetHorizon } from '../index-model';
import { CAL_JOB_KINDS, type CalendarJob, type CalendarJobContext, CalendarJobPermanentError, enqueueCalendarJob, registerCalendarJobHandler } from '../jobs';
import type { CalendarStore, CalendarStoreOperation } from '../store';
import type {
  BusyRange,
  Calendar,
  CalendarEvent,
  CalendarEventOccurrence,
  CalendarEventSource,
  CalendarFeedOptions,
  CalendarFeedResult,
  CalendarSubscription,
  ClosureRow,
  ClosuresView,
  CreateCalendarInput,
  CreateEventInput,
  CreateOccurrenceOverrideInput,
  CreateSubscriptionInput,
  ListEventsOptions,
  SyncResult,
  UpdateCalendarInput,
  UpdateEventInput,
  UpdateSubscriptionInput,
} from '../types';
import { enableSubscriptionIndex, pullSubscriptionToIndex, toLegacySyncResult } from '../subscriptions/pull';
import { CALENDAR_SLUG_REGEX, isValidTimeZone } from '../validation';
import { collectionPath, isValidObjectName, objectPath, type RadicaleClient } from './client';
import { clark, DAV_PROPS, type DavPropName, type DavPropValue } from './dav-xml';
import { isRadicaleError, type RadicaleError } from './errors';
import { assertDisplayReady } from './freshness';
import { reserveObjectId, resolveEventRef } from './ids';
import type { Db } from './policy';
import { expectCollectionDeletion, forgetCollectionDeletion, radicaleRuntime, syncCollection, verifyVolumeIdentity } from './sync';
import { type CalendarBackendState, isValidCollectionName } from './types';
import { withCalendarWriteGate, type WriteGateContext } from './write-gate';

const log: Logger = rootLogger.child({ scope: 'calendar-radicale-store' });

// ═══════════════════════════════════════════════════════════════════
// Costanti e messaggi
// ═══════════════════════════════════════════════════════════════════

/** Testo di assertWritable dello store legacy (iscrizioni in sola lettura). */
export const ICS_READ_ONLY_MESSAGE =
  'Evento importato da sottoscrizione ICS (sola lettura): modificalo nel calendario di origine. ' +
  'Le modifiche locali verrebbero sovrascritte al prossimo sync.';
/** Testo della guardia legacy sulle proiezioni delle prenotazioni attive. */
export const ACTIVE_BOOKING_MESSAGE = 'Evento di una prenotazione attiva: annullala da Calendario → Prenotazioni.';
/** Oggetto il cui testo non si interpreta: l'API non lo modifica (lo si corregge dal dispositivo o dalla cronologia). */
export const UNREADABLE_EVENT_MESSAGE =
  'Evento non leggibile (in quarantena): correggilo dal dispositivo o ripristina una versione precedente';
/** Titolo delle occorrenze conservative (oggetti illeggibili) nei DTO. */
export const UNREADABLE_SUMMARY = '(evento non leggibile)';

/** Timeout del GET diretto nelle letture (oltre si risponde dall'indice). */
const READ_GET_TIMEOUT_MS = 3_000;
/** Scadenza del write-through dopo una scrittura (oltre, risponde comunque il testo scritto). */
const WRITE_THROUGH_DEADLINE_MS = 5_000;
/** Tentativi di GET → PUT dopo un 412 nelle scritture senza CAS esplicito. */
const MAX_WRITE_ATTEMPTS = 3;
/** Admin v1 e MCP: base implicita e un solo nuovo tentativo (design §8). */
const V1_WRITE_ATTEMPTS = 2;
/** Ritardo del job di recupero di creazioni e cancellazioni di calendari (oltre la durata di una richiesta). */
const LIFECYCLE_RECOVERY_DELAY_MS = 120_000;
/** Una riga `creating` più giovane di così è (forse) ancora in lavorazione: il recupero la rimanda. */
const CREATING_GRACE_MS = 90_000;
/** Ritardo del job di verifica della saga "questa e le successive". */
const SPLIT_RECOVERY_DELAY_MS = 120_000;
/** Fuso di ripiego (default del dominio calendario). */
const DEFAULT_CALENDAR_TZ = 'Europe/Rome';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** UID usabile così com'è nel nome della risorsa (`<uid>.ics`). */
const SAFE_UID_HREF_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,200}$/;
const HOLIDAY_SOURCE_ID_RE = /^it-holiday-(\d{4}-\d{2}-\d{2})$/;
const EVENT_SOURCES: readonly CalendarEventSource[] = ['manual', 'booking', 'admin', 'mcp', 'agent', 'ics_pull', 'system'];

const generateEventUid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);
const generateFeedToken = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 32);

/**
 * Transazione sul pool principale con il tipo Db (nei tipi di postgres-js
 * TransactionSql perde la firma di chiamata del tagged template).
 */
function inTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx as unknown as Db)) as Promise<T>;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function safeTz(tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_CALENDAR_TZ;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ═══════════════════════════════════════════════════════════════════
// Feed dall'indice (CONSUMERS)
// ═══════════════════════════════════════════════════════════════════
//
// feed-builder.ts appartiene al gruppo CONSUMERS (contratto §0, §9) e si
// carica alla prima chiamata con un import dinamico: lo store non dipende in
// compilazione da un file che questo gruppo non possiede. Firma del contratto
// §9: buildIndexFeed(db, calendar, opts). Modulo assente o senza la funzione
// → 503 CalendarStoreUnavailableError, mai un feed vuoto per errore. busy.ts
// (BUSY) e subscriptions/pull.ts (SUBS) si importano invece staticamente.

interface FeedBuilder {
  buildIndexFeed(db: Db, calendar: Calendar, opts: CalendarFeedOptions): Promise<CalendarFeedResult>;
}

const FEED_BUILDER_SPECIFIER = '../feed-builder';
let feedBuilderOverride: FeedBuilder | null = null;
let feedBuilderPromise: Promise<FeedBuilder> | null = null;

async function feedBuilder(): Promise<FeedBuilder> {
  if (feedBuilderOverride) return feedBuilderOverride;
  feedBuilderPromise ??= import(FEED_BUILDER_SPECIFIER).then((mod: Record<string, unknown>) => {
    if (typeof mod.buildIndexFeed !== 'function') throw new Error(`${FEED_BUILDER_SPECIFIER} non esporta buildIndexFeed`);
    return mod as unknown as FeedBuilder;
  });
  try {
    return await feedBuilderPromise;
  } catch (err) {
    feedBuilderPromise = null;
    log.error({ err }, 'feed-builder non disponibile per lo store Radicale');
    throw new CalendarStoreUnavailableError('radicale', 'buildCalendarFeed', `modulo ${FEED_BUILDER_SPECIFIER} non disponibile: ${errorMessage(err)}`);
  }
}

/** Solo test: sostituisce (o con null ripristina) il generatore del feed. Vietato in produzione. */
export function setRadicaleFeedBuilder(builder: FeedBuilder | null): void {
  if (builder && process.env.NODE_ENV === 'production') throw new Error('setRadicaleFeedBuilder: vietato in produzione');
  feedBuilderOverride = builder;
  feedBuilderPromise = null;
}

// ═══════════════════════════════════════════════════════════════════
// Sidecar dei calendari
// ═══════════════════════════════════════════════════════════════════

/** Riga di `calendars` con le colonne del sidecar (162). */
interface SidecarRow {
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
  created_at: Date;
  updated_at: Date;
  collection_name: string | null;
  role: CalendarRole;
  origin: string;
  lifecycle: 'creating' | 'active' | 'deleting';
  parent_calendar_id: string | null;
  components: string[];
}

const SIDECAR_COLUMNS = sql`
  id, slug, name, description, color, icon, timezone,
  is_default, is_system, blocks_availability, ics_feed_token, ics_feed_enabled,
  sort_order, created_at, updated_at,
  collection_name, role, origin, lifecycle, parent_calendar_id, components
`;

/** Calendari visibili alla facade: attivi e non sidecar d'iscrizione (design §7: le sub-* non compaiono). */
const VISIBLE = sql`lifecycle = 'active' AND role <> 'subscription'`;

/**
 * Cast a uuid come nelle query dello store legacy (`WHERE id = ${id}::uuid`):
 * le route di modifica, eliminazione e rotazione del token accettano solo
 * l'id, e con uno slug o un altro valore non UUID Postgres risponde 22P02,
 * che app.onError trasforma nel 400 "Dati non validi" (contratto admin v1).
 * Per un UUID in una forma che Postgres accetta restituisce la forma canonica.
 */
async function castLegacyUuid(value: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`SELECT ${value}::uuid::text AS id`;
  return row.id;
}

async function sidecarById(id: string, opts: { activeOnly: boolean }, db: Db = sql): Promise<SidecarRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db<SidecarRow[]>`
    SELECT ${SIDECAR_COLUMNS} FROM calendars
    WHERE id = ${id.toLowerCase()}::uuid ${opts.activeOnly ? db`AND lifecycle = 'active'` : db``}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Calendario di destinazione mostrato nei DTO: per un sidecar d'iscrizione quello dell'iscrizione. */
async function displayCalendarId(cal: Pick<SidecarRow, 'id' | 'role' | 'parent_calendar_id'>): Promise<string> {
  if (cal.role !== 'subscription') return cal.id;
  const [row] = await sql<Array<{ calendar_id: string }>>`
    SELECT calendar_id FROM calendar_subscriptions WHERE collection_calendar_id = ${cal.id}::uuid LIMIT 1
  `;
  return row?.calendar_id ?? cal.parent_calendar_id ?? cal.id;
}

function allowedComponents(cal: SidecarRow): Array<'VEVENT' | 'VTODO' | 'VJOURNAL'> {
  const out = (cal.components ?? []).filter((c): c is 'VEVENT' | 'VTODO' | 'VJOURNAL' => c === 'VEVENT' || c === 'VTODO' || c === 'VJOURNAL');
  return out.length ? out : ['VEVENT'];
}

// ═══════════════════════════════════════════════════════════════════
// Radicale: client, identità, errori
// ═══════════════════════════════════════════════════════════════════

interface RadicaleAccess {
  client: RadicaleClient;
  principal: string;
}

/** Client di servizio e principal; senza Radicale configurato → 503 'radicale_unreachable'. */
function requireRadicale(): RadicaleAccess {
  const rt = radicaleRuntime();
  if (!rt.client) {
    throw new CalendarUnavailableError('radicale_unreachable', rt.unavailableReason ?? 'Radicale non configurato (RADICALE_URL assente)');
  }
  return { client: rt.client, principal: rt.principal };
}

function collectionNameOf(cal: Pick<SidecarRow, 'id' | 'collection_name'>): string {
  if (!isValidCollectionName(cal.collection_name)) {
    throw new CalendarUnavailableError('radicale_unreachable', `calendario ${cal.id} senza una collezione Radicale valida`);
  }
  return cal.collection_name;
}

/**
 * Identità del volume `ok` (design §6.3, invariante 7): mai scrivere su un
 * volume vuoto, di un altro stack o ripristinato da uno snapshot vecchio.
 */
async function assertVolumeIdentity(state: CalendarBackendState): Promise<void> {
  let status: string;
  let detail: string | null = null;
  try {
    const { check } = await verifyVolumeIdentity({ state });
    status = check.status;
    detail = check.detail ?? null;
  } catch (err) {
    throw new CalendarUnavailableError('identity_unverified', `identità del volume non verificabile: ${errorMessage(err)}`, { cause: err });
  }
  if (status === 'ok') return;
  throw new CalendarUnavailableError(
    status === 'unverified' ? 'identity_unverified' : 'identity_mismatch',
    `identità del volume di Radicale ${status}${detail ? `: ${detail}` : ''}: scritture sospese`,
  );
}

/** Errore del client F1 in una scrittura → errore del dominio (mai un RadicaleError verso le route). */
function radicaleWriteError(err: RadicaleError, what: string): Error {
  switch (err.code) {
    case 'precondition_failed':
      return new CalendarConflictError('L\'evento è stato modificato nel frattempo: ricarica e riprova');
    case 'uid_conflict':
      return new EventValidationError('UID già presente in un altro evento del calendario');
    case 'bad_request':
      return new EventValidationError(`Radicale ha rifiutato ${what} (HTTP ${err.status ?? '?'})`);
    case 'forbidden':
      return new CalendarUnavailableError('identity_unverified', `Radicale ha rifiutato ${what} (403): policy o identità del volume`, { cause: err });
    case 'not_found':
      return new CalendarUnavailableError('radicale_unreachable', `collezione assente su Radicale (${what})`, { cause: err });
    case 'conflict':
      return new CalendarConflictError(`Conflitto su Radicale (${what}): ricarica e riprova`);
    default:
      return new CalendarUnavailableError('radicale_unreachable', `${what}: ${err.message}`, { cause: err });
  }
}

/** Errori di calendar-core (target, CAS, valori) → errori del dominio con i messaggi dell'API. */
function coreError(err: unknown): Error | null {
  if (err instanceof RecurrenceTargetError) {
    switch (err.code) {
      case 'RECURRENCE_TARGET_GONE':
        return new CalendarRecurrenceConflictError(err.recurrenceKey ?? '');
      case 'NOT_RECURRING':
        return new EventValidationError('L\'evento non è ricorrente');
      case 'NO_MASTER':
        return new EventValidationError('Evento senza evento principale: indica l\'occorrenza da modificare');
      case 'INVALID_TARGET':
        // Chiave malformata: messaggio generico. Taglio impossibile (computeCut
        // con soli override orfani prima dell'occorrenza, serie troppo lunga):
        // il messaggio di calendar-core, già scritto per l'utente.
        return new EventValidationError(/^Recurrence key non valida/.test(err.message) ? 'Occorrenza non valida' : err.message);
      default:
        return new EventValidationError('Occorrenza non valida');
    }
  }
  if (err instanceof PatchConflictError) return new CalendarFieldConflictError(err.conflicts as FieldConflict[]);
  if (err instanceof IcsValueError && err.property === 'RRULE') return new EventValidationError('RRULE non valida');
  if (err instanceof ValidationError) return validationError(err.issues);
  if (isCalendarCoreError(err)) return new EventValidationError(err.message);
  return null;
}

/** Converte gli errori noti; gli altri (difetti, database) passano invariati. */
function domainError(err: unknown, what: string): unknown {
  if (isRadicaleError(err)) return radicaleWriteError(err, what);
  return coreError(err) ?? err;
}

const RRULE_CODES = new Set<string>(['RRULE_INVALID', 'RRULE_COUNT_AND_UNTIL', 'UNTIL_TYPE_MISMATCH', 'UNTIL_BEFORE_DTSTART']);
const RRULE_LIMIT_CODES = new Set<string>(['RRULE_FREQ_NOT_ALLOWED', 'TOO_MANY_INSTANCES', 'RADICALE_LIMIT']);

/** Esito di validateObject → EventValidationError con i messaggi di oggi dove esistono. */
function validationError(issues: readonly ValidationIssue[]): EventValidationError {
  const errors = issues.filter((i) => i.severity === 'error');
  const rrule = errors.find((i) => RRULE_CODES.has(i.code));
  if (rrule) return new EventValidationError('RRULE non valida');
  const limit = errors.find((i) => RRULE_LIMIT_CODES.has(i.code));
  if (limit) return new EventValidationError(`RRULE non valida: ${limit.message}`);
  if (errors.some((i) => i.code === 'END_NOT_AFTER_START')) return new EventValidationError('end_time deve essere > start_time');
  return new EventValidationError(errors[0]?.message ?? 'Evento non valido');
}

// ═══════════════════════════════════════════════════════════════════
// Pipeline di scrittura di un oggetto (design §8)
// ═══════════════════════════════════════════════════════════════════

interface CurrentObject {
  raw: string;
  etag: string | null;
  object: CalendarObject | null;
  parseError: string | null;
}

type WritePlan =
  | { action: 'put'; object: CalendarObject; previous: CalendarObject | null; changed?: string[] }
  | { action: 'delete' }
  | { action: 'none' };

interface WriteOutcome {
  action: 'put' | 'delete' | 'none';
  created: boolean;
  etagBefore: string | null;
  etagAfter: string | null;
  /** Testo scritto (put) o corrente (none). */
  raw: string | null;
  object: CalendarObject | null;
  changed: string[];
}

interface ObjectWriteRequest {
  calendar: SidecarRow;
  href: string;
  /** Descrizione per i messaggi ("l'evento", "la serie"...). */
  what: string;
  maxAttempts: number;
  plan: (current: CurrentObject | null, attempt: number, ctx: WriteGateContext) => WritePlan | Promise<WritePlan>;
}

async function fetchCurrent(client: RadicaleClient, path: string, what: string): Promise<CurrentObject | null> {
  let res: { etag: string | null; body: string };
  try {
    res = await client.get(path);
  } catch (err) {
    if (isRadicaleError(err, 'not_found')) return null;
    throw domainError(err, what);
  }
  const parsed = parseCalendarObject(res.body);
  return parsed.ok
    ? { raw: res.body, etag: res.etag, object: parsed.value, parseError: null }
    : { raw: res.body, etag: res.etag, object: null, parseError: parsed.error.message };
}

/** validateObject di calendar-core (design §8 "validatori aggiuntivi") sul testo che si sta per scrivere. */
function assertValidForWrite(obj: CalendarObject, cal: SidecarRow, text: string, previous: CalendarObject | null): void {
  const result = validateObject(obj, {
    tz: safeTz(cal.timezone),
    allowedComponents: allowedComponents(cal),
    serializedBytes: Buffer.byteLength(text, 'utf8'),
    previous,
    now: new Date(),
  });
  if (!result.ok) throw validationError(result.issues);
}

/**
 * GET → piano → PUT/DELETE con precondizione, dentro il gate cal-write e con
 * l'identità del volume verificata. Un 412 riparte dal GET fino a
 * `maxAttempts`; poi CalendarConflictError. Gli errori del client F1 e di
 * calendar-core escono come errori del dominio.
 */
async function writeObject(req: ObjectWriteRequest): Promise<WriteOutcome> {
  const { client, principal } = requireRadicale();
  const path = objectPath(principal, collectionNameOf(req.calendar), req.href);
  return withCalendarWriteGate(async (ctx) => {
    await assertVolumeIdentity(ctx.state);
    for (let attempt = 1; ; attempt++) {
      const current = await fetchCurrent(client, path, req.what);
      let plan: WritePlan;
      try {
        plan = await req.plan(current, attempt, ctx);
      } catch (err) {
        throw domainError(err, req.what);
      }
      if (plan.action === 'none') {
        return { action: 'none', created: false, etagBefore: current?.etag ?? null, etagAfter: current?.etag ?? null, raw: current?.raw ?? null, object: current?.object ?? null, changed: [] };
      }
      if (plan.action === 'delete') {
        if (!current) return { action: 'none', created: false, etagBefore: null, etagAfter: null, raw: null, object: null, changed: [] };
        // Annunciata alla sync prima della richiesta: non è una cancellazione "osservata" (interruttore, guardia del ripristino).
        expectCollectionDeletion(req.calendar.id, req.href);
        try {
          await client.delete(path, { ifMatch: current.etag ?? '*' });
        } catch (err) {
          if (isRadicaleError(err, 'precondition_failed') && attempt < req.maxAttempts) {
            forgetCollectionDeletion(req.calendar.id, req.href);
            continue;
          }
          // Già sparito: lo stato voluto è raggiunto.
          if (!isRadicaleError(err, 'not_found')) {
            if (!(isRadicaleError(err) && err.outcomeUnknown)) forgetCollectionDeletion(req.calendar.id, req.href);
            throw domainError(err, req.what);
          }
        }
        return { action: 'delete', created: false, etagBefore: current.etag, etagAfter: null, raw: null, object: null, changed: [] };
      }
      let text: string;
      try {
        text = serializeObject(plan.object, current ? { prodid: 'preserve' } : {});
      } catch (err) {
        throw domainError(err, req.what);
      }
      assertValidForWrite(plan.object, req.calendar, text, plan.previous);
      try {
        const res = await client.put(path, text, current ? { ifMatch: current.etag ?? '*' } : { ifNoneMatch: '*' });
        return {
          action: 'put',
          created: !current,
          etagBefore: current?.etag ?? null,
          etagAfter: res.etag,
          raw: text,
          object: plan.object,
          changed: plan.changed ?? [],
        };
      } catch (err) {
        if (isRadicaleError(err, 'precondition_failed') && attempt < req.maxAttempts) continue;
        throw domainError(err, req.what);
      }
    }
  }, { expect: 'radicale' });
}

/**
 * Write-through (design §8 passo 7): sync delle collezioni toccate, in ordine
 * (per una MOVE prima l'origine e poi la destinazione, contratto §2.2). Un
 * fallimento non annulla la scrittura: il watcher indicizzerà.
 */
async function writeThrough(calendarIds: readonly string[], actor: string): Promise<boolean> {
  let ok = true;
  for (const id of calendarIds) {
    try {
      await syncCollection(id, { reason: 'write-through', actor, deadline: Date.now() + WRITE_THROUGH_DEADLINE_MS });
    } catch (err) {
      ok = false;
      log.warn({ err, calendarId: id }, 'write-through non riuscito: la scrittura resta valida, il watcher indicizzerà');
    }
  }
  return ok;
}

interface AuditEntry {
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  recordId: string | null;
  operation: string;
  calendar: Pick<SidecarRow, 'id' | 'collection_name'>;
  href: string;
  etagBefore: string | null;
  etagAfter: string | null;
  changed?: readonly string[];
  actor: string;
  extra?: Record<string, unknown>;
}

/** Riga in audit_logs (design §8 passo 8): collezione, href ed ETag prima e dopo, mai il testo. */
async function audit(entry: AuditEntry): Promise<void> {
  const collection = entry.calendar.collection_name;
  const before = entry.etagBefore !== null || entry.action !== 'INSERT' ? { collection, href: entry.href, etag: entry.etagBefore } : null;
  const after = entry.action === 'DELETE' ? null : { collection, href: entry.href, etag: entry.etagAfter };
  await sql`
    INSERT INTO audit_logs (
      user_email, user_role, action, table_name, record_id,
      old_data, new_data, changed_fields, user_agent, metadata
    ) VALUES (
      ${`calendar:${entry.actor}`}, 'system', ${entry.action}, 'cal_objects', ${entry.recordId},
      ${jsonb(before)}, ${jsonb(after)}, ${entry.changed?.length ? [...entry.changed] : null}, 'calendar-store',
      ${jsonb({ operation: entry.operation, calendar_id: entry.calendar.id, ...(entry.extra ?? {}) })}
    )
  `.catch((err: unknown) => log.error({ err, operation: entry.operation }, 'audit della scrittura del calendario non riuscito'));
}

/**
 * Id persistente di una posizione (cal_object_ids). Dopo il write-through c'è
 * già; se il write-through è fallito la posizione esiste comunque in Radicale
 * e l'id si prenota (ids.reserveObjectId), così il DTO ha subito l'id che
 * l'indicizzatore adotterà (allocazione, passo 1).
 */
async function positionId(calendarId: string, href: string, recurrenceKey: string, uid: string | null): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    SELECT id FROM cal_object_ids
    WHERE calendar_id = ${calendarId}::uuid AND href = ${href} AND recurrence_key = ${recurrenceKey}
    ORDER BY retired_at NULLS FIRST
    LIMIT 1
  `;
  if (row) return row.id;
  return reserveObjectId(sql, { calendarId, href, recurrenceKey, uid });
}

// ═══════════════════════════════════════════════════════════════════
// DTO
// ═══════════════════════════════════════════════════════════════════

interface EventMeta {
  objectId: string;
  calendarId: string;
  displayCalendarId: string;
  href: string;
  role: CalendarRole;
  timezone: string;
  firstSeenAt: Date | null;
  changedAt: Date | null;
}

async function eventMeta(cal: SidecarRow, href: string, objectId?: string): Promise<EventMeta> {
  const [row] = await sql<Array<{ id: string; first_seen_at: Date; changed_at: Date }>>`
    SELECT id, first_seen_at, changed_at FROM cal_objects WHERE calendar_id = ${cal.id}::uuid AND href = ${href}
  `;
  return {
    objectId: row?.id ?? objectId ?? '',
    calendarId: cal.id,
    displayCalendarId: await displayCalendarId(cal),
    href,
    role: cal.role,
    timezone: safeTz(cal.timezone),
    firstSeenAt: row?.first_seen_at ?? null,
    changedAt: row?.changed_at ?? null,
  };
}

/** Recurrence key di un componente, o null se il RECURRENCE-ID non si legge. */
function keyOf(c: IcsComponent, ctx: ZoneContext): string | null {
  try {
    return componentRecurrenceKey(c, ctx);
  } catch {
    return null;
  }
}

/** Componente di un oggetto per recurrence key ('' = master; per un oggetto senza master il primo override). */
function componentFor(obj: CalendarObject, key: string, tz: string): IcsComponent | null {
  if (key === MASTER_RECURRENCE_KEY) return obj.master ?? obj.overrides[0] ?? null;
  const ctx: ZoneContext = { tz, timezones: obj.timezones };
  return obj.overrides.find((c) => keyOf(c, ctx) === key) ?? null;
}

/**
 * true se `key` è un'istanza della regola esclusa da un'EXDATE (senza
 * override): esiste togliendo le EXDATE del master, non esiste con.
 */
function isExcludedInstance(obj: CalendarObject, key: string, tz: string, now: Date): boolean {
  if (!obj.master) return false;
  try {
    if (occurrenceExists(obj, key, { tz, now })) return false;
    const clone = cloneCalendarObject(obj);
    if (!clone.master || removeProperties(clone.master, 'EXDATE') === 0) return false;
    return occurrenceExists(clone, key, { tz, now });
  } catch {
    return false;
  }
}

/**
 * CalendarEvent dal testo di una risorsa (GET diretto o testo appena
 * scritto), con le convenzioni di toLegacyEventFields e la provenienza da
 * collezione e href. null se il componente non c'è (o non si interpreta).
 */
function eventFromObject(obj: CalendarObject, key: string, id: string, meta: EventMeta): CalendarEvent | null {
  const comp = componentFor(obj, key, meta.timezone);
  if (!comp) return null;
  let fields: ReturnType<typeof toLegacyEventFields>;
  try {
    fields = toLegacyEventFields(comp, { tz: meta.timezone, timezones: obj.timezones });
  } catch {
    return null;
  }
  const prov = deriveProvenance({ role: meta.role, href: meta.href, component: obj.master ?? comp, uid: obj.uid });
  const now = new Date().toISOString();
  const isOverride = key !== MASTER_RECURRENCE_KEY;
  return {
    id,
    calendar_id: meta.displayCalendarId,
    uid: fields.uid,
    summary: fields.summary,
    description: fields.description,
    location: fields.location,
    url: fields.url,
    start_time: fields.start_time,
    end_time: fields.end_time,
    all_day: fields.all_day,
    rrule: isOverride ? null : fields.rrule,
    exdates: isOverride ? [] : fields.exdates,
    recurrence_id: isOverride ? fields.recurrence_id : null,
    recurrence_master_id: isOverride ? meta.objectId || null : null,
    source: prov.source,
    source_id: prov.source_id,
    status: fields.status,
    created_at: isoOrNull(meta.firstSeenAt) ?? now,
    updated_at: isoOrNull(meta.changedAt) ?? now,
  };
}

/** Riga di cal_components del componente (object, key). */
async function componentRow(objectId: string, key: string, db: Db = sql): Promise<CalComponentRow | null> {
  const [row] = await db<CalComponentRow[]>`
    SELECT * FROM cal_components WHERE object_id = ${objectId}::uuid AND recurrence_key = ${key} LIMIT 1
  `;
  return row ?? null;
}

interface IndexedObjectRow {
  id: string;
  calendar_id: string;
  href: string;
  uid: string | null;
  source: CalendarEventSource;
  source_id: string | null;
  first_seen_at: Date;
  changed_at: Date;
}

/** CalendarEvent dall'indice (fallback in sola lettura). */
async function eventFromIndex(objectId: string, key: string, id: string, cal: SidecarRow): Promise<CalendarEvent | null> {
  const [obj] = await sql<IndexedObjectRow[]>`
    SELECT id, calendar_id, href, uid, source, source_id, first_seen_at, changed_at
    FROM cal_objects WHERE id = ${objectId}::uuid
  `;
  if (!obj) return null;
  const comp = await componentRow(objectId, key);
  if (!comp) return null;
  const dto = toLegacyEvent(comp, obj, {
    masterId: key === MASTER_RECURRENCE_KEY ? null : objectId,
    timezone: safeTz(cal.timezone),
    displayCalendarId: await displayCalendarId(cal),
  });
  return { ...dto, id };
}

// ═══════════════════════════════════════════════════════════════════
// Letture: occorrenze
// ═══════════════════════════════════════════════════════════════════

interface ScopeCalendar {
  id: string;
  role: CalendarRole;
  timezone: string;
  displayId: string;
  horizonStart: number | null;
  horizonEnd: number | null;
}

/**
 * Collezioni da leggere: attive, filtrate per calendario (anche i sidecar
 * delle iscrizioni che hanno quel calendario come destinazione) e, con
 * blockingOnly, con i flag della query di busy del design §7.
 */
async function occurrenceScope(opts: Pick<ListEventsOptions, 'calendarId' | 'blockingOnly'>): Promise<ScopeCalendar[]> {
  const rows = await sql<Array<{
    id: string;
    role: CalendarRole;
    timezone: string | null;
    blocks_availability: boolean;
    parent_calendar_id: string | null;
    sub_destination: string | null;
    sub_blocks: boolean | null;
    parent_blocks: boolean | null;
    horizon_start: Date | null;
    horizon_end: Date | null;
  }>>`
    SELECT c.id, c.role, c.timezone, c.blocks_availability, c.parent_calendar_id,
           s.calendar_id AS sub_destination, s.blocks_availability AS sub_blocks,
           p.blocks_availability AS parent_blocks,
           st.horizon_start, st.horizon_end
    FROM calendars c
    LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
    LEFT JOIN calendars p ON p.id = COALESCE(s.calendar_id, c.parent_calendar_id)
    LEFT JOIN cal_collection_state st ON st.calendar_id = c.id
    WHERE c.lifecycle = 'active'
  `;
  const out = new Map<string, ScopeCalendar>();
  for (const r of rows) {
    if (out.has(r.id)) continue;
    const isSub = r.role === 'subscription';
    const displayId = isSub ? r.sub_destination ?? r.parent_calendar_id : r.id;
    if (!displayId) continue;
    if (opts.calendarId && displayId !== opts.calendarId.toLowerCase()) continue;
    if (opts.blockingOnly && !(isSub ? Boolean(r.sub_blocks) && Boolean(r.parent_blocks) : r.blocks_availability)) continue;
    out.set(r.id, {
      id: r.id,
      role: r.role,
      timezone: safeTz(r.timezone),
      displayId,
      horizonStart: r.horizon_start ? r.horizon_start.getTime() : null,
      horizonEnd: r.horizon_end ? r.horizon_end.getTime() : null,
    });
  }
  return [...out.values()];
}

interface OccurrenceJoinRow extends CalOccurrenceRow {
  comp: Record<string, unknown> | null;
  o_uid: string | null;
  o_href: string;
  o_source: CalendarEventSource;
  o_source_id: string | null;
  o_first_seen_at: Date;
  o_changed_at: Date;
}

/** Riga JSON di cal_components (timestamptz come stringhe) → CalComponentRow tollerata dagli adattatori. */
function componentFromJson(json: Record<string, unknown>): CalComponentRow {
  return {
    ...(json as unknown as CalComponentRow),
    rdates: Array.isArray(json.rdates) ? (json.rdates as string[]) : [],
    exdates: Array.isArray(json.exdates) ? (json.exdates as string[]) : [],
  };
}

/** Componente sintetico per le occorrenze conservative (oggetto illeggibile, nessun componente). */
function conservativeComponent(row: OccurrenceJoinRow): CalComponentRow {
  return {
    id: row.object_id,
    object_id: row.object_id,
    calendar_id: row.calendar_id,
    recurrence_key: MASTER_RECURRENCE_KEY,
    component: 'VEVENT',
    uid: row.o_uid,
    summary: UNREADABLE_SUMMARY,
    description: null,
    location: null,
    url: null,
    status: row.status,
    transp: null,
    class: null,
    start_utc: row.start_utc,
    end_utc: row.end_utc,
    all_day: false,
    start_date: null,
    end_date: null,
    tzid: null,
    floating: false,
    rrule: null,
    rdates: [],
    exdates: [],
    recurrence_id_utc: null,
    orphan: false,
    sequence: null,
    dtstamp: null,
    created: null,
    last_modified: null,
    x_source: null,
    x_source_id: null,
    has_alarms: false,
    has_attendees: false,
  };
}

/** Finestre di [from, to) non coperte dall'orizzonte materializzato [hs, he). */
function uncovered(from: number, to: number, hs: number | null, he: number | null): Array<[number, number]> {
  if (hs === null || he === null) return [[from, to]];
  const out: Array<[number, number]> = [];
  if (from < Math.min(hs, to)) out.push([from, Math.min(hs, to)]);
  if (Math.max(he, from) < to) out.push([Math.max(he, from), to]);
  return out;
}

function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const sorted = windows.filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push([w[0], w[1]]);
  }
  return out;
}

/** Sovrapposizione con la semantica legacy: start < to e end > from; durata nulla inclusa se strettamente dentro. */
function overlaps(start: number, end: number, from: number, to: number): boolean {
  if (end > start) return start < to && end > from;
  return start > from && start < to;
}

/**
 * Espansione al volo da cal_objects.raw_ics (design §6.9): finestre fuori
 * dall'orizzonte materializzato della collezione e oltre materialized_until
 * dell'oggetto. Le chiavi già restituite dalla query (`seen`) non si ripetono.
 * Un testo illeggibile produce l'occorrenza conservativa sulla finestra.
 */
async function onTheFlyOccurrences(
  scope: readonly ScopeCalendar[],
  from: number,
  to: number,
  includeCancelled: boolean,
  seen: Set<string>,
): Promise<CalendarEventOccurrence[]> {
  const gaps = new Map<string, Array<[number, number]>>();
  for (const cal of scope) {
    const g = uncovered(from, to, cal.horizonStart, cal.horizonEnd);
    if (g.length) gaps.set(cal.id, g);
  }
  const ids = scope.map((c) => c.id);
  if (!ids.length) return [];
  const gapIds = [...gaps.keys()];
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const rows = await sql<Array<{
    id: string;
    calendar_id: string;
    href: string;
    uid: string | null;
    raw_ics: string | null;
    source: CalendarEventSource;
    source_id: string | null;
    first_seen_at: Date;
    changed_at: Date;
    materialized_until: Date | null;
  }>>`
    SELECT id, calendar_id, href, uid, raw_ics, source, source_id, first_seen_at, changed_at, materialized_until
    FROM cal_objects
    WHERE calendar_id = ANY(${ids}::uuid[])
      AND health <> 'pending_404'
      AND (range_start IS NULL OR range_start < ${toIso}::timestamptz)
      AND (range_end IS NULL OR range_end > ${fromIso}::timestamptz)
      AND (calendar_id = ANY(${gapIds}::uuid[]) OR (materialized_until IS NOT NULL AND materialized_until < ${toIso}::timestamptz))
  `;
  if (!rows.length) return [];
  const compIds = new Map<string, string>();
  const comps = await sql<Array<{ id: string; object_id: string; recurrence_key: string }>>`
    SELECT id, object_id, recurrence_key FROM cal_components WHERE object_id = ANY(${rows.map((r) => r.id)}::uuid[])
  `;
  for (const c of comps) compIds.set(`${c.object_id}|${c.recurrence_key}`, c.id);
  const byId = new Map(scope.map((c) => [c.id, c]));
  const out: CalendarEventOccurrence[] = [];

  for (const row of rows) {
    const cal = byId.get(row.calendar_id);
    if (!cal) continue;
    const windows = [...(gaps.get(row.calendar_id) ?? [])];
    if (row.materialized_until && row.materialized_until.getTime() < to) {
      windows.push([Math.max(from, row.materialized_until.getTime()), to]);
    }
    const created = row.first_seen_at.toISOString();
    const updated = row.changed_at.toISOString();
    const parsed = row.raw_ics ? parseCalendarObject(row.raw_ics) : null;
    for (const [w0, w1] of mergeWindows(windows)) {
      if (!parsed || !parsed.ok) {
        const key = `${row.id}|conservative`;
        if (seen.has(key)) continue;
        const range = row.raw_ics ? conservativeRangeFromText(row.raw_ics, { tz: cal.timezone }) : null;
        if (!range) continue;
        const start = Math.max(range.start, w0);
        const end = Math.min(range.end ?? w1, w1);
        if (!(start < end)) continue;
        seen.add(key);
        out.push({
          id: row.id,
          calendar_id: cal.displayId,
          uid: row.uid ?? row.href,
          summary: UNREADABLE_SUMMARY,
          description: null,
          location: null,
          url: null,
          start_time: new Date(start).toISOString(),
          end_time: new Date(end).toISOString(),
          all_day: false,
          recurrence_id: null,
          source: row.source,
          source_id: row.source_id,
          status: 'confirmed',
          created_at: created,
          updated_at: updated,
          original_start: null,
          is_override: false,
        });
        continue;
      }
      const obj = parsed.value;
      let expansion: ReturnType<typeof expandObject>;
      try {
        expansion = expandObject(obj, { from: w0, to: w1, tz: cal.timezone, computeRangeEnd: false });
      } catch (err) {
        log.warn({ err, objectId: row.id }, 'espansione al volo non riuscita: oggetto escluso dalla visualizzazione');
        continue;
      }
      if (expansion.materializedUntil !== null && expansion.materializedUntil < w1) {
        // Solo vista (il busy riprende a blocchi e chiude con una coda conservativa: expandRawOnTheFly).
        log.warn(
          { objectId: row.id, calendarId: row.calendar_id, materializedUntil: new Date(expansion.materializedUntil).toISOString(), windowEnd: new Date(w1).toISOString() },
          'vista: serie oltre il tetto di occorrenze per oggetto, elenco troncato',
        );
      }
      for (const occ of expansion.occurrences) {
        const key = `${row.id}|${occ.recurrenceKey}`;
        if (seen.has(key)) continue;
        if (!overlaps(occ.startUtc, occ.endUtc, w0, w1)) continue;
        const status = legacyStatusOf(occ.status);
        seen.add(key);
        if (!includeCancelled && status === 'cancelled') continue;
        const comp = occ.source.type === 'override' ? obj.overrides[occ.source.index] : obj.master ?? obj.overrides[0];
        let fields: ReturnType<typeof toLegacyEventFields> | null = null;
        try {
          if (comp) fields = toLegacyEventFields(comp, { tz: cal.timezone, timezones: obj.timezones });
        } catch {
          fields = null;
        }
        const isOverride = occ.kind === 'override' || occ.kind === 'orphan_override';
        const start = occ.allDay && occ.startDate ? dateToLegacyIso(occ.startDate, cal.timezone) : new Date(occ.startUtc).toISOString();
        const end = occ.allDay && occ.endDate ? dateToLegacyIso(occ.endDate, cal.timezone) : new Date(Math.max(occ.endUtc, occ.startUtc)).toISOString();
        const original = occ.originalStartUtc !== null ? new Date(occ.originalStartUtc).toISOString() : null;
        const prov = deriveProvenance({ role: cal.role, href: row.href, component: obj.master ?? comp ?? null, uid: obj.uid });
        out.push({
          id: isOverride ? compIds.get(`${row.id}|${occ.recurrenceKey}`) ?? row.id : row.id,
          calendar_id: cal.displayId,
          uid: fields?.uid ?? obj.uid,
          summary: occ.kind === 'conservative' && !fields ? UNREADABLE_SUMMARY : fields?.summary ?? UNTITLED_SUMMARY,
          description: fields?.description ?? null,
          location: fields?.location ?? null,
          url: fields?.url ?? null,
          start_time: start,
          end_time: end,
          all_day: occ.allDay,
          recurrence_id: isOverride ? original : null,
          source: prov.source,
          source_id: prov.source_id,
          status,
          created_at: created,
          updated_at: updated,
          original_start: isOverride ? original ?? start : expansion.isRecurring ? start : null,
          is_override: isOverride,
        });
      }
    }
  }
  return out;
}

/**
 * Intervalli delle prenotazioni che hanno una proiezione (confermate,
 * concluse, no-show) sovrapposte a [fromIso, toIso), se il calendario
 * Prenotazioni blocca: la stessa semantica della proiezione legacy (evento
 * confermato del calendario bookings), letta da calendar_bookings invece che
 * dall'indice, dove la proiezione arriva solo dopo il job project_booking.
 */
async function projectedBookingRanges(fromIso: string, toIso: string): Promise<BusyRange[]> {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return [];
  const rows = await sql<Array<{ start_time: Date; end_time: Date }>>`
    SELECT b.start_time, b.end_time
    FROM calendar_bookings b
    WHERE b.status = ANY(${[...PROJECTED_BOOKING_STATUSES]}::text[])
      AND b.start_time < ${new Date(to).toISOString()}::timestamptz
      AND b.end_time > ${new Date(from).toISOString()}::timestamptz
      AND EXISTS (
        SELECT 1 FROM calendars c WHERE c.role = 'bookings' AND c.lifecycle = 'active' AND c.blocks_availability
      )
    ORDER BY b.start_time, b.end_time
  `;
  return rows.map((r) => ({ start: r.start_time.toISOString(), end: r.end_time.toISOString() }));
}

/** listOccurrences dall'indice (design §7) più l'espansione al volo fuori orizzonte. */
async function listIndexedOccurrences(opts: ListEventsOptions): Promise<CalendarEventOccurrence[]> {
  // Parità con la query legacy (calendar_id = ${id}::uuid): un filtro che non è
  // un UUID fallisce il cast (22P02 → 400 in GET /events), non un elenco vuoto.
  const calendarId = opts.calendarId && !isUuid(opts.calendarId) ? await castLegacyUuid(opts.calendarId) : opts.calendarId;
  const from = Date.parse(opts.fromIso);
  const to = Date.parse(opts.toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return [];
  const scope = await occurrenceScope({ ...opts, calendarId });
  if (!scope.length) return [];
  const ids = scope.map((c) => c.id);
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const rows = await sql<OccurrenceJoinRow[]>`
    SELECT o.object_id, o.recurrence_key, o.component_id, o.calendar_id, o.start_utc, o.end_utc,
           o.start_date, o.end_date, o.all_day, o.status, o.transp, o.kind, o.blocks, o.stale,
           CASE WHEN comp.id IS NOT NULL THEN to_jsonb(comp) WHEN mc.id IS NOT NULL THEN to_jsonb(mc) END AS comp,
           obj.uid AS o_uid, obj.href AS o_href, obj.source AS o_source, obj.source_id AS o_source_id,
           obj.first_seen_at AS o_first_seen_at, obj.changed_at AS o_changed_at
    FROM cal_occurrences o
    JOIN cal_objects obj ON obj.id = o.object_id
    LEFT JOIN cal_components comp ON comp.id = o.component_id
    -- Occorrenza conservativa (budget esaurito, RRULE invalida): i testi del master, se c'è.
    LEFT JOIN cal_components mc ON o.component_id IS NULL AND mc.object_id = o.object_id AND mc.recurrence_key = ''
    WHERE o.calendar_id = ANY(${ids}::uuid[])
      AND (
        o.span && tstzrange(${fromIso}::timestamptz, ${toIso}::timestamptz, '[)')
        OR (o.start_utc = o.end_utc AND o.start_utc > ${fromIso}::timestamptz AND o.start_utc < ${toIso}::timestamptz)
      )
      ${opts.includeCancelled ? sql`` : sql`AND o.status <> 'cancelled'`}
    ORDER BY o.start_utc, o.object_id, o.recurrence_key
  `;
  const byId = new Map(scope.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: CalendarEventOccurrence[] = [];
  for (const row of rows) {
    const cal = byId.get(row.calendar_id);
    if (!cal) continue;
    seen.add(`${row.object_id}|${row.recurrence_key}`);
    const comp = row.comp ? componentFromJson(row.comp) : conservativeComponent(row);
    out.push(toLegacyOccurrence(row, comp, {
      source: row.o_source,
      source_id: row.o_source_id,
      first_seen_at: row.o_first_seen_at,
      changed_at: row.o_changed_at,
    }, { timezone: cal.timezone, displayCalendarId: cal.displayId }));
  }
  // Le cancellate escluse dalla query restano "viste": l'espansione al volo non le ripropone.
  if (!opts.includeCancelled) {
    const cancelled = await sql<Array<{ object_id: string; recurrence_key: string }>>`
      SELECT object_id, recurrence_key FROM cal_occurrences
      WHERE calendar_id = ANY(${ids}::uuid[]) AND status = 'cancelled'
        AND span && tstzrange(${fromIso}::timestamptz, ${toIso}::timestamptz, '[)')
    `;
    for (const c of cancelled) seen.add(`${c.object_id}|${c.recurrence_key}`);
  }
  const extra = await onTheFlyOccurrences(scope, from, to, Boolean(opts.includeCancelled), seen);
  const all = extra.length ? [...out, ...extra] : out;
  return all.sort((a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0));
}

// ═══════════════════════════════════════════════════════════════════
// Risoluzione degli eventi per le scritture
// ═══════════════════════════════════════════════════════════════════

interface ResolvedEvent {
  /** Id risolto (componente: master o override). */
  id: string;
  objectId: string;
  recurrenceKey: string;
  href: string;
  calendar: SidecarRow;
}

function ambiguousError(candidates: Array<{ id: string; collectionName: string; href: string }>): EventValidationError {
  const list = candidates.slice(0, 5).map((c) => `${c.collectionName}/${c.href} (id ${c.id})`).join(', ');
  return new EventValidationError(`Più eventi con questo UID: indica l'id. Candidati: ${list}`);
}

/**
 * Un id o uid che non è una stringa è un errore di chi chiama, non un evento
 * inesistente: lo store legacy lo rifiutava con l'errore della query
 * (UNDEFINED_VALUE di postgres-js), e i tool MCP lo trasformano nel messaggio
 * generico di executeTool. Stesso esito qui, invece di "Evento non trovato".
 */
function assertEventRef(idOrUid: unknown, operation: string): asserts idOrUid is string {
  if (typeof idOrUid !== 'string') throw new TypeError(`${operation}: id o uid dell'evento mancante`);
}

async function resolveEvent(idOrUid: string): Promise<ResolvedEvent | null> {
  assertEventRef(idOrUid, 'resolveEvent');
  const ref = await resolveEventRef(sql, idOrUid);
  if (ref.kind === 'not_found') return null;
  if (ref.kind === 'ambiguous') throw ambiguousError(ref.candidates);
  const calendar = await sidecarById(ref.calendarId, { activeOnly: true });
  if (!calendar) return null;
  return { id: ref.id, objectId: ref.objectId, recurrenceKey: ref.recurrenceKey, href: ref.href, calendar };
}

/** assertWritable dello store legacy: le iscrizioni sono in sola lettura. */
function assertEventWritable(cal: SidecarRow): void {
  if (cal.role === 'subscription') throw new EventReadOnlyError(ICS_READ_ONLY_MESSAGE);
}

/** Calendario di destinazione di un evento nuovo o spostato. */
/**
 * Errore di un vincolo della tabella legacy calendar_events, per le stesse
 * richieste che con PgLegacyStore arrivavano fino all'INSERT o all'UPDATE e lì
 * venivano rifiutate dal database: app.onError (mapDbError) e i tool MCP
 * (executeTool) le trasformano nelle stesse risposte di oggi (400 per un CHECK,
 * 409 per una foreign key), invece di un messaggio nuovo.
 */
function legacyConstraintError(code: '23514' | '23503', constraint: string): postgres.PostgresError {
  const message = code === '23514'
    ? `new row for relation "calendar_events" violates check constraint "${constraint}"`
    : `insert or update on table "calendar_events" violates foreign key constraint "${constraint}"`;
  // A runtime il costruttore di postgres-js riceve i campi dell'errore del server (i tipi dichiarano solo Error).
  const PgError = postgres.PostgresError as unknown as new (fields: Partial<postgres.PostgresError> & { message: string }) => postgres.PostgresError;
  return new PgError({ code, message, severity: 'ERROR', table_name: 'calendar_events', constraint_name: constraint });
}

/** Stati ammessi dal CHECK legacy di calendar_events.status. */
const LEGACY_EVENT_STATUSES: readonly string[] = ['confirmed', 'tentative', 'cancelled'];

/**
 * Calendario di destinazione di un evento. Come i vincoli dello store legacy:
 * un id che non è un UUID fallisce il cast (22P02 → 400), un calendario
 * inesistente (o il sidecar di un'iscrizione, che lo store legacy non vedeva)
 * viola la foreign key verso calendars (23503 → 409).
 */
async function eventTargetCalendar(calendarId: string): Promise<SidecarRow> {
  const id = isUuid(calendarId) ? calendarId : await castLegacyUuid(calendarId);
  const cal = await sidecarById(id, { activeOnly: true });
  if (!cal || cal.role === 'subscription') throw legacyConstraintError('23503', 'calendar_events_calendar_id_fkey');
  return cal;
}

/** Proiezione booking-* di una prenotazione pending/confirmed (guardia legacy della delete). */
async function isActiveBookingProjection(cal: SidecarRow, href: string): Promise<boolean> {
  const prov = deriveProvenance({ role: cal.role, href });
  if (prov.source !== 'booking' || !prov.source_id) return false;
  const [active] = await sql`
    SELECT 1 FROM calendar_bookings
    WHERE uid = ${prov.source_id} AND status IN ('pending', 'confirmed')
    LIMIT 1
  `;
  return Boolean(active);
}

/** Href di una risorsa nuova dall'UID (design §5): `<uid>.ics`, oppure lo sha256 se il nome non è sicuro. */
export function hrefForUid(uid: string): string {
  const candidate = `${uid}.ics`;
  if (SAFE_UID_HREF_RE.test(uid) && isValidObjectName(candidate)) return candidate;
  return `${createHash('sha256').update(uid, 'utf8').digest('hex').slice(0, 40)}.ics`;
}

/** DTSTART del master di un oggetto, o null. */
function masterStart(obj: CalendarObject): IcsTime | null {
  const p = obj.master ? getProperty(obj.master, 'DTSTART') : null;
  if (!p) return null;
  try {
    return readTimeProperty(p);
  } catch {
    return null;
  }
}

function isRecurringMaster(obj: CalendarObject): boolean {
  return Boolean(obj.master && (getProperty(obj.master, 'RRULE') || getProperty(obj.master, 'RDATE')));
}

/** Recurrence key dell'istanza che inizia a `iso` (tipizzata come il DTSTART del master). */
function recurrenceKeyForIso(obj: CalendarObject, iso: string, tz: string): string {
  const ms = Date.parse(iso);
  const start = masterStart(obj);
  if (!Number.isFinite(ms) || !start) throw new EventValidationError('original_start non valido');
  const ctx: ZoneContext = { tz, timezones: obj.timezones };
  return recurrenceKeyOf(utcMsToTime(ms, start, ctx), ctx);
}

/**
 * Valori di partenza (pre-immagine) del componente indicato da `key` per il
 * CAS implicito: il master, l'override esistente o la copia del master
 * all'istanza (quella che la patch materializzerebbe).
 */
function preImage(obj: CalendarObject, key: string, tz: string, now: Date): IcsComponent | null {
  if (key === MASTER_RECURRENCE_KEY) return obj.master ?? null;
  try {
    const mat = materializeOverride(obj, key, { tz, now });
    return mat.object.overrides[mat.index] ?? null;
  } catch {
    return componentFor(obj, key, tz);
  }
}

function baseFor(component: IcsComponent | null, ops: readonly PatchOp[]): PatchBase | undefined {
  if (!component) return undefined;
  const fields = [...new Set(ops.filter((o): o is Extract<PatchOp, { op: 'set' }> => o.op === 'set').map((o) => o.field))] as PatchFieldName[];
  if (!fields.length) return undefined;
  try {
    return readFieldValues(component, fields);
  } catch {
    return undefined;
  }
}

/** CAS implicito al nuovo tentativo: conflitto se un campo toccato non ha più il valore di base. */
function assertBaseUnchanged(current: CalendarObject, key: string, tz: string, now: Date, ops: readonly PatchOp[], base: PatchBase | undefined): void {
  if (!base) return;
  const target = preImage(current, key, tz, now);
  if (!target) throw new CalendarRecurrenceConflictError(key);
  const conflicts = checkBase(target, ops, base);
  if (conflicts.length) throw new CalendarFieldConflictError(conflicts as FieldConflict[]);
}

/** Validazioni legacy di start/end di updateEvent (stessi messaggi di events.ts). */
function checkLegacyTimes(input: UpdateEventInput): void {
  if (input.start_time !== undefined && Number.isNaN(new Date(input.start_time).getTime())) throw new EventValidationError('start_time non valido');
  if (input.end_time !== undefined && Number.isNaN(new Date(input.end_time).getTime())) throw new EventValidationError('end_time non valido');
}

/** Input v1 senza i campi che non sono patch (calendar_id) e senza undefined. */
function patchInput(input: UpdateEventInput): LegacyEventUpdate {
  const out: LegacyEventUpdate = {};
  if (input.summary !== undefined) out.summary = String(input.summary).trim().slice(0, 500);
  if (input.description !== undefined) out.description = input.description ? String(input.description).trim().slice(0, 5000) : null;
  if (input.location !== undefined) out.location = input.location ? String(input.location).trim().slice(0, 500) : null;
  if (input.url !== undefined) out.url = input.url ? String(input.url).trim().slice(0, 1000) : null;
  if (input.start_time !== undefined) out.start_time = new Date(input.start_time).toISOString();
  if (input.end_time !== undefined) out.end_time = new Date(input.end_time).toISOString();
  if (input.all_day !== undefined) out.all_day = Boolean(input.all_day);
  if (input.rrule !== undefined) out.rrule = input.rrule === '' ? null : input.rrule;
  if (input.exdates !== undefined) out.exdates = input.exdates;
  if (input.status !== undefined) out.status = input.status;
  return out;
}

interface TransformResult {
  object: CalendarObject;
  noop: boolean;
  changed: string[];
  ops: PatchOp[];
}

/**
 * updateEvent sul testo corrente. Sul master di una serie uno spostamento di
 * DTSTART è "tutta la serie" (design §8): recurrence-ops.shiftSeries sposta
 * dello stesso Δ RECURRENCE-ID, EXDATE, RDATE e UNTIL, così gli override non
 * diventano orfani; la fine resta quella data dal client (o quella di prima,
 * come il legacy, se manca). Il resto è applyLegacyUpdate (patch lossless).
 */
function transformUpdate(obj: CalendarObject, key: string, input: LegacyEventUpdate, tz: string, now: Date): TransformResult {
  const ctx = { tz, now };
  const target = componentFor(obj, key, tz) ?? (key === MASTER_RECURRENCE_KEY ? null : preImage(obj, key, tz, now));
  if (!target) throw new RecurrenceTargetError('RECURRENCE_TARGET_GONE', 'Occorrenza non più presente', key);
  const current = toLegacyEventFields(target, { tz, timezones: obj.timezones });
  // Validazione legacy: end > start con i valori risultanti.
  const newStart = input.start_time ?? current.start_time;
  const newEnd = input.end_time ?? current.end_time;
  if (Date.parse(newStart) >= Date.parse(newEnd)) throw new EventValidationError('end_time deve essere > start_time');

  if (
    key === MASTER_RECURRENCE_KEY
    && isRecurringMaster(obj)
    && input.start_time !== undefined
    && Date.parse(input.start_time) !== Date.parse(current.start_time)
    && (input.all_day === undefined || input.all_day === current.all_day)
  ) {
    const start = masterStart(obj);
    if (start) {
      const zctx: ZoneContext = { tz, timezones: obj.timezones };
      const shifted = shiftSeries(obj, utcMsToTime(Date.parse(input.start_time), start, zctx), ctx);
      const rest = applyLegacyUpdate(shifted.object, MASTER_RECURRENCE_KEY, { ...input, end_time: input.end_time ?? current.end_time }, { tz, now });
      const object = rest.noop ? shifted.object : rest.object;
      const after = object.master as IcsComponent;
      const fields: PatchFieldName[] = ['start', 'end', 'duration', 'exdates', 'rdates', 'rrule'];
      const values = readFieldValues(after, fields);
      const ops = fields.filter((f) => values[f] !== undefined).map((f) => ({ op: 'set', field: f, value: values[f] }) as PatchOp);
      return { object, noop: false, changed: [...new Set(['start', ...rest.changed])], ops: [...ops, ...rest.ops.filter((o) => o.op !== 'set' || !fields.includes(o.field))] };
    }
  }
  const res = applyLegacyUpdate(obj, key, input, { tz, now, createOverride: false });
  return { object: res.object, noop: res.noop, changed: res.changed, ops: res.ops };
}

// ═══════════════════════════════════════════════════════════════════
// Calendari: collezioni in Radicale
// ═══════════════════════════════════════════════════════════════════

/** calendar-timezone (VCALENDAR con il VTIMEZONE canonico) di un fuso IANA. */
function calendarTimezoneProp(tz: string): string | undefined {
  try {
    const vtz = canonicalVtimezone(tz);
    if (!vtz) return undefined;
    return serializeCalendar({ name: 'VCALENDAR', properties: [], components: [vtz] });
  } catch {
    return undefined;
  }
}

function isCollectionExistsError(err: unknown): boolean {
  return isRadicaleError(err, 'conflict') || (isRadicaleError(err) && err.status === 405);
}

/** Elimina la riga del sidecar con il GUC del trigger 166 (design §4, §8). Cascate: indice, id, versioni. */
async function deleteSidecarRow(calendarId: string): Promise<void> {
  await inTransaction(async (tx) => {
    await tx`SELECT set_config('caldes.reverse_sync', 'on', true)`;
    await tx`DELETE FROM calendars WHERE id = ${calendarId}::uuid`;
  });
}

/**
 * DELETE della collezione di un calendario (solo caldes-svc ha D), dentro il
 * gate e con l'identità verificata. 404 = già sparita. Un calendario senza
 * collezione Radicale (sidecar d'iscrizione non specchiato) non fa I/O.
 */
async function deleteCollection(cal: SidecarRow): Promise<void> {
  if (!isValidCollectionName(cal.collection_name)) return;
  const { client, principal } = requireRadicale();
  await withCalendarWriteGate(async (ctx) => {
    await assertVolumeIdentity(ctx.state);
    try {
      await client.delete(collectionPath(principal, cal.collection_name as string), { ifMatch: '*' });
    } catch (err) {
      if (isRadicaleError(err, 'not_found')) return;
      throw err;
    }
  }, { expect: 'radicale' });
}

/**
 * Cancellazione di un calendario (design §8): `deleting` con il job di
 * recupero nella stessa transazione → DELETE della collezione → delete della
 * riga. Se la DELETE non è partita (Radicale irraggiungibile, gate chiuso) la
 * riga torna `active` e l'errore arriva al chiamante; con esito ignoto, o se
 * fallisce solo la delete della riga, resta `deleting` e la completa il job.
 */
async function deleteCalendarLifecycle(cal: SidecarRow): Promise<void> {
  await inTransaction(async (tx) => {
    await tx`UPDATE calendars SET lifecycle = 'deleting' WHERE id = ${cal.id}::uuid`;
    await enqueueCalendarJob(CAL_JOB_KINDS.calendarLifecycle, cal.id, { phase: 'deleting' }, {
      db: tx,
      sourceVersion: 'deleting',
      delayMs: LIFECYCLE_RECOVERY_DELAY_MS,
    });
  });
  try {
    await deleteCollection(cal);
  } catch (err) {
    const unknownOutcome = isRadicaleError(err) && err.outcomeUnknown;
    if (!unknownOutcome) {
      await sql`UPDATE calendars SET lifecycle = 'active' WHERE id = ${cal.id}::uuid AND lifecycle = 'deleting'`
        .catch((e: unknown) => log.error({ err: e, calendarId: cal.id }, 'ripristino di lifecycle=active non riuscito: lo completerà il job'));
    }
    throw isRadicaleError(err) ? radicaleWriteError(err, 'l\'eliminazione del calendario') : err;
  }
  await deleteSidecarRow(cal.id);
}

/** Proprietà DAV della collezione dai campi del sidecar. */
function collectionDavProps(cal: Pick<SidecarRow, 'name' | 'color' | 'description' | 'sort_order' | 'timezone'>): { set: DavPropValue[]; remove: DavPropName[] } {
  const set: DavPropValue[] = [
    { ...DAV_PROPS.displayname, value: cal.name },
    { ...DAV_PROPS.calendarColor, value: cal.color },
    { ...DAV_PROPS.calendarOrder, value: String(cal.sort_order ?? 0) },
  ];
  const remove: DavPropName[] = [];
  if (cal.description) set.push({ ...DAV_PROPS.calendarDescription, value: cal.description });
  else remove.push(DAV_PROPS.calendarDescription);
  const tzProp = calendarTimezoneProp(safeTz(cal.timezone));
  if (tzProp) set.push({ ...DAV_PROPS.calendarTimezone, value: tzProp });
  return { set, remove };
}

// ═══════════════════════════════════════════════════════════════════
// RadicaleStore
// ═══════════════════════════════════════════════════════════════════

const SUBSCRIPTION_COLUMNS = sql`
  id, calendar_id, name, ics_url, sync_enabled,
  last_synced_at, last_error, etag, last_modified, event_count,
  created_at, updated_at
`;

/** Attore delle scritture di un evento (audit, write-through) dalla source dichiarata. */
function actorOf(source: string | null | undefined): string {
  return source && /^[a-z_]{1,32}$/.test(source) ? source : 'api';
}

class RadicaleStore implements CalendarStore {
  readonly kind = 'radicale' as const;

  // ── Eventi: letture ──

  async getEvent(idOrUid: string): Promise<CalendarEvent | null> {
    assertEventRef(idOrUid, 'getEvent');
    const ref = await resolveEventRef(sql, idOrUid);
    if (ref.kind === 'not_found') return null;
    if (ref.kind === 'ambiguous') throw ambiguousError(ref.candidates);
    const cal = await sidecarById(ref.calendarId, { activeOnly: true });
    if (!cal) return null;
    const fresh = await this.readFresh(cal, ref.href);
    if (fresh === 'missing') return null;
    if (fresh) {
      const meta = await eventMeta(cal, ref.href, ref.objectId);
      const dto = eventFromObject(fresh, ref.recurrenceKey, ref.id, meta);
      if (dto) return dto;
    }
    return eventFromIndex(ref.objectId, ref.recurrenceKey, ref.id, cal);
  }

  /**
   * Testo corrente dal GET diretto (design §7: l'editor legge da Radicale).
   * null = non disponibile (Radicale non configurato o giù, identità non
   * verificata, testo illeggibile, iscrizione): si risponde dall'indice.
   */
  private async readFresh(cal: SidecarRow, href: string): Promise<CalendarObject | null | 'missing'> {
    if (cal.role === 'subscription' || !isValidCollectionName(cal.collection_name) || !isValidObjectName(href)) return null;
    const rt = radicaleRuntime();
    if (!rt.client) return null;
    try {
      const { check } = await verifyVolumeIdentity({ db: sql });
      if (check.status !== 'ok') return null;
      const res = await rt.client.get(objectPath(rt.principal, cal.collection_name, href), { timeoutMs: READ_GET_TIMEOUT_MS });
      const parsed = parseCalendarObject(res.body);
      return parsed.ok ? parsed.value : null;
    } catch (err) {
      if (isRadicaleError(err, 'not_found')) return 'missing';
      log.warn({ err: isRadicaleError(err) ? err.toLog() : err, calendarId: cal.id, href }, 'GET diretto non riuscito: rispondo dall\'indice');
      return null;
    }
  }

  async getEventBySource(source: string, sourceId: string): Promise<CalendarEvent | null> {
    const [row] = await sql<Array<IndexedObjectRow & { timezone: string; role: CalendarRole; parent_calendar_id: string | null }>>`
      SELECT obj.id, obj.calendar_id, obj.href, obj.uid, obj.source, obj.source_id, obj.first_seen_at, obj.changed_at,
             c.timezone, c.role, c.parent_calendar_id
      FROM cal_objects obj
      JOIN calendars c ON c.id = obj.calendar_id AND c.lifecycle = 'active'
      WHERE obj.source = ${source} AND obj.source_id = ${sourceId}
      ORDER BY obj.first_seen_at, obj.id
      LIMIT 1
    `;
    if (!row) return null;
    const comp = await componentRow(row.id, MASTER_RECURRENCE_KEY);
    if (!comp) return null;
    return toLegacyEvent(comp, row, {
      masterId: null,
      timezone: safeTz(row.timezone),
      displayCalendarId: await displayCalendarId({ id: row.calendar_id, role: row.role, parent_calendar_id: row.parent_calendar_id }),
    });
  }

  listOccurrences(opts: ListEventsOptions): Promise<CalendarEventOccurrence[]> {
    return listIndexedOccurrences(opts);
  }

  async getBusyRanges(fromIso: string, toIso: string): Promise<BusyRange[]> {
    // Semantica della facade di oggi (store legacy: occorrenze confermate e
    // timed dei calendari bloccanti, proiezioni delle prenotazioni comprese),
    // per chi legge solo il calendario (find_free_slots). Slot e decisioni
    // usano busy.getBusyRanges, che le esclude perché leggono anche
    // calendar_bookings (design §9).
    // Livello display (design §7): campanello fermo, identità non ok o
    // collezione bloccante non sincronizzabile → 503 (o modalità degradata).
    await assertReadyOrDegraded(sql, () => assertDisplayReady(sql), 'display');
    const [indexed, bookings] = await Promise.all([
      indexBusyRanges(sql, fromIso, toIso, { includeBookingProjections: true }),
      projectedBookingRanges(fromIso, toIso),
    ]);
    if (!bookings.length) return indexed;
    // Le proiezioni nascono in modo asincrono (job project_booking): le
    // prenotazioni che le proiettano si leggono anche da calendar_bookings,
    // così una confermata non risulta libera con il job in coda o in dead
    // letter. Un'annullata la cui proiezione non è ancora stata tolta resta al
    // più occupata (verso sicuro).
    const seen = new Set<string>();
    return [...indexed, ...bookings]
      .filter((r) => {
        const key = `${r.start}|${r.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  }

  async listEventsForCollection(calendarId: string): Promise<CalendarEvent[]> {
    const cal = await sidecarById(calendarId, { activeOnly: true });
    if (!cal) return [];
    const rows = await sql<Array<{ comp: Record<string, unknown> } & IndexedObjectRow>>`
      SELECT to_jsonb(comp) AS comp, obj.id, obj.calendar_id, obj.href, obj.uid, obj.source, obj.source_id, obj.first_seen_at, obj.changed_at
      FROM cal_components comp
      JOIN cal_objects obj ON obj.id = comp.object_id
      WHERE comp.calendar_id = ${cal.id}::uuid AND comp.recurrence_key = '' AND comp.status <> 'cancelled'
      ORDER BY comp.start_utc NULLS LAST, obj.href
    `;
    const display = await displayCalendarId(cal);
    return rows.map((r) => toLegacyEvent(componentFromJson(r.comp), r, { masterId: null, timezone: safeTz(cal.timezone), displayCalendarId: display }));
  }

  async getEventOverrides(masterId: string): Promise<CalendarEvent[]> {
    const ref = await resolveEventRef(sql, masterId);
    if (ref.kind !== 'found') return [];
    const cal = await sidecarById(ref.calendarId, { activeOnly: true });
    if (!cal) return [];
    const rows = await sql<Array<{ comp: Record<string, unknown> } & IndexedObjectRow>>`
      SELECT to_jsonb(comp) AS comp, obj.id, obj.calendar_id, obj.href, obj.uid, obj.source, obj.source_id, obj.first_seen_at, obj.changed_at
      FROM cal_components comp
      JOIN cal_objects obj ON obj.id = comp.object_id
      WHERE comp.object_id = ${ref.objectId}::uuid AND comp.recurrence_key <> ''
      ORDER BY comp.recurrence_id_utc
    `;
    const display = await displayCalendarId(cal);
    return rows.map((r) => toLegacyEvent(componentFromJson(r.comp), r, { masterId: ref.objectId, timezone: safeTz(cal.timezone), displayCalendarId: display }));
  }

  async buildCalendarFeed(calendar: Calendar, opts: CalendarFeedOptions): Promise<CalendarFeedResult> {
    return (await feedBuilder()).buildIndexFeed(sql, calendar, opts);
  }

  // ── Eventi: scritture ──

  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    // Guardie di createEvent legacy, stessi messaggi e stesso ordine.
    if (!input.calendar_id) throw new EventValidationError('calendar_id richiesto');
    if (!input.summary?.trim()) throw new EventValidationError('Titolo richiesto');
    const start = new Date(input.start_time);
    const end = new Date(input.end_time);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new EventValidationError('Date non valide');
    if (start >= end) throw new EventValidationError('end_time deve essere > start_time');
    const source = (input.source || 'manual') as CalendarEventSource;
    // Vincoli dell'INSERT legacy, nell'ordine in cui Postgres li valutava:
    // cast di calendar_id (22P02), CHECK di source e status (23514), foreign
    // key verso calendars (23503, in eventTargetCalendar).
    const calendarId = isUuid(input.calendar_id) ? input.calendar_id : await castLegacyUuid(input.calendar_id);
    if (!EVENT_SOURCES.includes(source)) throw legacyConstraintError('23514', 'calendar_events_source_check');
    if (input.status !== undefined && input.status !== null && !LEGACY_EVENT_STATUSES.includes(input.status)) {
      throw legacyConstraintError('23514', 'calendar_events_status_check');
    }
    const cal = await eventTargetCalendar(calendarId);
    const tz = safeTz(cal.timezone);

    // Collocazione (design §5): la provenienza la decidono collezione e href.
    let uid = input.uid?.trim().slice(0, 255) || generateEventUid();
    let href = hrefForUid(uid);
    let idempotent = false;
    let declaredSource: string | null = source;
    let sourceId: string | null = input.source_id || null;
    if (source === 'system') {
      // Festività del cron (design §5 "Festività nuove"): href e UID deterministici, If-None-Match.
      const m = HOLIDAY_SOURCE_ID_RE.exec(input.source_id ?? '');
      if (cal.role !== 'holidays' || !m) throw new EventValidationError('source "system" ammessa solo per le festività nel calendario festività');
      href = holidayHref(m[1]);
      uid = holidayUid(m[1]);
      idempotent = true;
      declaredSource = null;
      sourceId = null;
    } else if (source === 'booking') {
      throw new EventValidationError('Le proiezioni delle prenotazioni le scrive il job project_booking: source "booking" non ammessa');
    } else if (!isClientSource(source)) {
      throw new EventValidationError(`source "${source}" non ammessa`);
    }

    const now = new Date();
    const build = (u: string): CalendarObject => createCalendarObject({
      uid: u,
      componentType: 'VEVENT',
      master: buildEventFromLegacy({
        uid: u,
        summary: input.summary.trim().slice(0, 500),
        description: input.description?.trim().slice(0, 5000) || null,
        location: input.location?.trim().slice(0, 500) || null,
        url: input.url?.trim().slice(0, 1000) || null,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        all_day: !!input.all_day,
        rrule: input.rrule || null,
        exdates: input.exdates || [],
        status: input.status || 'confirmed',
        source: declaredSource as CreateEventInput['source'] | null,
        source_id: sourceId,
      }, { tz, now, created: now, lastModified: now, sequence: 0 }),
    });
    let object: CalendarObject;
    try {
      object = build(uid);
      // Validazione prima del gate: un input non valido è un 400 anche con Radicale giù.
      assertValidForWrite(object, cal, serializeObject(object), null);
    } catch (err) {
      if (input.rrule && err instanceof IcsValueError) throw new EventValidationError('RRULE non valida');
      throw domainError(err, 'l\'evento');
    }

    requireRadicale();
    const generated = !input.uid?.trim() && !idempotent;
    let outcome: WriteOutcome | null = null;
    for (let round = 0; round < 3 && !outcome; round++) {
      try {
        outcome = await writeObject({
          calendar: cal,
          href,
          what: 'l\'evento',
          maxAttempts: MAX_WRITE_ATTEMPTS,
          plan: (current) => {
            if (!current) return { action: 'put', object, previous: null };
            if (idempotent) return { action: 'none' };
            throw new EventValidationError('UID già presente nel calendario');
          },
        });
      } catch (err) {
        // UID generato che collide con una risorsa esistente: se ne sceglie un altro.
        if (generated && err instanceof EventValidationError && err.message === 'UID già presente nel calendario') {
          uid = generateEventUid();
          href = hrefForUid(uid);
          object = build(uid);
          continue;
        }
        throw err;
      }
    }
    if (!outcome) throw new EventValidationError('UID già presente nel calendario');
    const actor = actorOf(source);
    await writeThrough([cal.id], actor);
    const id = await positionId(cal.id, href, MASTER_RECURRENCE_KEY, uid);
    if (outcome.action === 'put') {
      await audit({ action: 'INSERT', recordId: id, operation: 'createEvent', calendar: cal, href, etagBefore: null, etagAfter: outcome.etagAfter, actor });
    }
    const written = outcome.object ?? object;
    const meta = await eventMeta(cal, href, id);
    const dto = eventFromObject(written, MASTER_RECURRENCE_KEY, id, meta);
    if (!dto) throw new EventValidationError('Evento non leggibile dopo la scrittura');
    return dto;
  }

  async updateEvent(id: string, input: UpdateEventInput): Promise<CalendarEvent | null> {
    const ref = await resolveEvent(id);
    if (!ref) return null;
    assertEventWritable(ref.calendar);
    checkLegacyTimes(input);
    const tz = safeTz(ref.calendar.timezone);
    const update = patchInput(input);
    const moving = input.calendar_id !== undefined && input.calendar_id !== null && input.calendar_id.toLowerCase() !== ref.calendar.id;
    if (moving && ref.recurrenceKey !== MASTER_RECURRENCE_KEY) {
      throw new EventValidationError('Un\'occorrenza di una serie non può cambiare calendario da sola: sposta l\'intera serie');
    }
    const dest = moving ? await eventTargetCalendar(input.calendar_id as string) : null;
    requireRadicale();

    let casOps: PatchOp[] = [];
    let base: PatchBase | undefined;
    let missing = false;
    let changed: string[] = [];
    const outcome = await writeObject({
      calendar: ref.calendar,
      href: ref.href,
      what: 'l\'evento',
      maxAttempts: V1_WRITE_ATTEMPTS,
      plan: (current, attempt) => {
        if (!current) {
          missing = true;
          return { action: 'none' };
        }
        if (!current.object) throw new EventReadOnlyError(UNREADABLE_EVENT_MESSAGE);
        const now = new Date();
        if (attempt > 1) assertBaseUnchanged(current.object, ref.recurrenceKey, tz, now, casOps, base);
        const res = transformUpdate(current.object, ref.recurrenceKey, update, tz, now);
        if (attempt === 1) {
          casOps = res.ops;
          base = baseFor(preImage(current.object, ref.recurrenceKey, tz, now), res.ops);
        }
        changed = res.changed;
        if (res.noop) return { action: 'none' };
        return { action: 'put', object: res.object, previous: current.object, changed: res.changed };
      },
    });
    if (missing) return null;

    let finalCal = ref.calendar;
    let finalEtag = outcome.etagAfter;
    if (dest) {
      finalEtag = await this.moveObject(ref.calendar, dest, ref.href, outcome.etagAfter);
      finalCal = dest;
    }
    const actor = 'api';
    if (outcome.action === 'put' || dest) {
      await writeThrough(dest ? [ref.calendar.id, dest.id] : [ref.calendar.id], actor);
      await audit({
        action: 'UPDATE',
        recordId: ref.id,
        operation: dest ? 'updateEvent+move' : 'updateEvent',
        calendar: finalCal,
        href: ref.href,
        etagBefore: outcome.etagBefore,
        etagAfter: finalEtag,
        changed: dest ? [...changed, 'calendar_id'] : changed,
        actor,
        extra: dest ? { from_calendar_id: ref.calendar.id } : undefined,
      });
    }
    const written = outcome.object;
    if (!written) return this.getEvent(ref.id);
    const finalId = dest ? await positionId(dest.id, ref.href, MASTER_RECURRENCE_KEY, written.uid) : ref.id;
    const meta = await eventMeta(finalCal, ref.href, dest ? finalId : ref.objectId);
    return eventFromObject(written, ref.recurrenceKey, finalId, meta) ?? this.getEvent(finalId);
  }

  /**
   * Spostamento di calendario (design §8 "Sposta"): MOVE con Overwrite: F
   * dopo il controllo dell'ETag (Radicale non valuta If-Match sulla MOVE).
   * Restituisce l'ETag della risorsa nella destinazione (letto dopo la MOVE).
   */
  private async moveObject(from: SidecarRow, to: SidecarRow, href: string, expectedEtag: string | null): Promise<string | null> {
    const { client, principal } = requireRadicale();
    const src = objectPath(principal, collectionNameOf(from), href);
    const dst = objectPath(principal, collectionNameOf(to), href);
    return withCalendarWriteGate(async (ctx) => {
      await assertVolumeIdentity(ctx.state);
      const current = await fetchCurrent(client, src, 'l\'evento');
      if (!current) throw new CalendarConflictError('L\'evento non esiste più: ricarica e riprova');
      if (expectedEtag && current.etag && current.etag !== expectedEtag) {
        throw new CalendarConflictError('L\'evento è stato modificato nel frattempo: ricarica e riprova');
      }
      // L'origine sparisce per mano dell'API: per la sync non è una cancellazione osservata.
      expectCollectionDeletion(from.id, href);
      try {
        await client.move(src, dst, { overwrite: false });
      } catch (err) {
        if (!(isRadicaleError(err) && err.outcomeUnknown)) forgetCollectionDeletion(from.id, href);
        if (isRadicaleError(err, 'precondition_failed')) throw new EventValidationError('Esiste già un evento con lo stesso nome nel calendario di destinazione');
        if (isRadicaleError(err, 'uid_conflict')) throw new EventValidationError('UID già presente nel calendario di destinazione');
        throw domainError(err, 'lo spostamento dell\'evento');
      }
      const moved = await fetchCurrent(client, dst, 'l\'evento');
      return moved?.etag ?? null;
    }, { expect: 'radicale' });
  }

  async deleteEvent(id: string): Promise<boolean> {
    const ref = await resolveEvent(id);
    if (!ref) return false;
    assertEventWritable(ref.calendar);
    if (await isActiveBookingProjection(ref.calendar, ref.href)) throw new EventReadOnlyError(ACTIVE_BOOKING_MESSAGE);
    requireRadicale();
    const tz = safeTz(ref.calendar.timezone);
    const isOverride = ref.recurrenceKey !== MASTER_RECURRENCE_KEY;
    let alreadyExcluded = false;
    const outcome = await writeObject({
      calendar: ref.calendar,
      href: ref.href,
      what: 'l\'evento',
      maxAttempts: MAX_WRITE_ATTEMPTS,
      plan: (current) => {
        alreadyExcluded = false;
        if (!current) return { action: 'none' };
        if (!isOverride) return { action: 'delete' };
        // "Elimina questa": EXDATE tipizzato più rimozione dell'override (design §8).
        if (!current.object) throw new EventReadOnlyError(UNREADABLE_EVENT_MESSAGE);
        try {
          const object = excludeOccurrence(current.object, ref.recurrenceKey, { tz, now: new Date() });
          return { action: 'put', object, previous: current.object, changed: ['exdates'] };
        } catch (err) {
          // Occorrenza già esclusa (o non più nella serie) e senza override:
          // lo stato voluto c'è già. Successo idempotente come il legacy, dove
          // ripetere "elimina questa" rimarca 'cancelled' la stessa riga
          // (decisione 2, parità), invece di un 409.
          if (err instanceof RecurrenceTargetError && err.code === 'RECURRENCE_TARGET_GONE') {
            alreadyExcluded = true;
            return { action: 'none' };
          }
          throw err;
        }
      },
    });
    if (outcome.action === 'none') return alreadyExcluded;
    const actor = 'api';
    await writeThrough([ref.calendar.id], actor);
    await audit({
      action: isOverride ? 'UPDATE' : 'DELETE',
      recordId: ref.id,
      operation: isOverride ? 'deleteOccurrence' : 'deleteEvent',
      calendar: ref.calendar,
      href: ref.href,
      etagBefore: outcome.etagBefore,
      etagAfter: outcome.etagAfter,
      changed: outcome.changed,
      actor,
      extra: isOverride ? { recurrence_key: ref.recurrenceKey } : undefined,
    });
    return true;
  }

  async createOccurrenceOverride(opts: CreateOccurrenceOverrideInput): Promise<CalendarEvent> {
    const ref = await resolveEvent(opts.masterEventId);
    if (!ref) throw new EventValidationError('Master event non trovato');
    assertEventWritable(ref.calendar);
    if (ref.recurrenceKey !== MASTER_RECURRENCE_KEY) throw new EventValidationError('L\'evento non è ricorrente');
    const originalMs = Date.parse(opts.originalStartIso);
    if (!Number.isFinite(originalMs)) throw new EventValidationError('original_start non valido');
    if (opts.newStartIso !== undefined && !Number.isFinite(Date.parse(opts.newStartIso))) throw new EventValidationError('Date non valide');
    if (opts.newEndIso !== undefined && !Number.isFinite(Date.parse(opts.newEndIso))) throw new EventValidationError('Date non valide');
    requireRadicale();
    const tz = safeTz(ref.calendar.timezone);

    let key = '';
    let casOps: PatchOp[] = [];
    let base: PatchBase | undefined;
    let alreadyExcluded = false;
    const outcome = await writeObject({
      calendar: ref.calendar,
      href: ref.href,
      what: 'l\'occorrenza',
      maxAttempts: V1_WRITE_ATTEMPTS,
      plan: (current, attempt) => {
        alreadyExcluded = false;
        if (!current) throw new EventValidationError('Master event non trovato');
        if (!current.object) throw new EventReadOnlyError(UNREADABLE_EVENT_MESSAGE);
        const obj = current.object;
        if (!obj.master || !isRecurringMaster(obj)) throw new EventValidationError('L\'evento non è ricorrente');
        const now = new Date();
        key = recurrenceKeyForIso(obj, new Date(originalMs).toISOString(), tz);
        // "Elimina questa" (eccezione con status cancelled) su un'istanza già
        // esclusa con EXDATE (da un device o da un "elimina questa"
        // precedente): lo stato voluto c'è già. Successo idempotente come il
        // legacy (upsert della riga cancellata, decisione 2), nessuna scrittura.
        if (opts.status === 'cancelled' && isExcludedInstance(obj, key, tz, now)) {
          alreadyExcluded = true;
          return { action: 'none' };
        }
        if (attempt > 1) assertBaseUnchanged(obj, key, tz, now, casOps, base);
        // Semantica di createOccurrenceOverride legacy: orari dell'istanza (o nuovi) con la durata del
        // master, titolo nuovo o del master, descrizione nuova o del master, stato (default confirmed).
        const master = toLegacyEventFields(obj.master, { tz, timezones: obj.timezones });
        const duration = Date.parse(master.end_time) - Date.parse(master.start_time);
        const newStart = opts.newStartIso ? Date.parse(opts.newStartIso) : originalMs;
        const newEnd = opts.newEndIso ? Date.parse(opts.newEndIso) : newStart + duration;
        if (newStart >= newEnd) throw new EventValidationError('end_time deve essere > start_time');
        const masterSummary = getTextValue(obj.master, 'SUMMARY');
        const masterDescription = getTextValue(obj.master, 'DESCRIPTION');
        const update: LegacyEventUpdate = {
          start_time: new Date(newStart).toISOString(),
          end_time: new Date(newEnd).toISOString(),
          status: opts.status || 'confirmed',
        };
        const summary = opts.newSummary || masterSummary;
        if (summary) update.summary = summary;
        update.description = opts.newDescription !== undefined ? opts.newDescription || null : masterDescription || null;
        const res = applyLegacyUpdate(obj, key, update, { tz, now, createOverride: true });
        if (attempt === 1) {
          casOps = res.ops;
          base = baseFor(preImage(obj, key, tz, now), res.ops);
        }
        if (res.noop) {
          // Override già identico, o istanza che resterebbe uguale al master: si materializza comunque
          // (createOccurrenceOverride restituisce sempre la riga dell'override, come il legacy).
          const mat = materializeOverride(obj, key, { tz, now });
          if (!mat.created) return { action: 'none' };
          return { action: 'put', object: mat.object, previous: obj, changed: ['override'] };
        }
        return { action: 'put', object: res.object, previous: obj, changed: res.changed };
      },
    });
    const actor = 'api';
    if (outcome.action === 'put') await writeThrough([ref.calendar.id], actor);
    const written = outcome.object;
    if (!written) throw new EventValidationError('Master event non trovato');
    const id = await positionId(ref.calendar.id, ref.href, key, written.uid);
    if (outcome.action === 'put') {
      await audit({
        action: 'UPDATE',
        recordId: id,
        operation: 'createOccurrenceOverride',
        calendar: ref.calendar,
        href: ref.href,
        etagBefore: outcome.etagBefore,
        etagAfter: outcome.etagAfter,
        changed: outcome.changed,
        actor,
        extra: { recurrence_key: key },
      });
    }
    const meta = await eventMeta(ref.calendar, ref.href, ref.objectId);
    if (alreadyExcluded) {
      // Nessun override da restituire (l'istanza è un'EXDATE): la stessa forma
      // della riga cancellata che il legacy restituiva, dai campi del master.
      const master = eventFromObject(written, MASTER_RECURRENCE_KEY, ref.objectId, meta);
      if (master) {
        const duration = Date.parse(master.end_time) - Date.parse(master.start_time);
        const originalIso = new Date(originalMs).toISOString();
        return {
          ...master,
          id,
          summary: opts.newSummary || master.summary,
          description: opts.newDescription !== undefined ? opts.newDescription || null : master.description,
          start_time: originalIso,
          end_time: new Date(originalMs + Math.max(0, duration)).toISOString(),
          rrule: null,
          exdates: [],
          recurrence_id: originalIso,
          recurrence_master_id: ref.objectId || null,
          status: 'cancelled',
        };
      }
    }
    const dto = eventFromObject(written, key, id, meta);
    if (!dto) throw new CalendarRecurrenceConflictError(key);
    return dto;
  }

  // ── Calendari ──

  async listCalendars(): Promise<Calendar[]> {
    const rows = await sql<SidecarRow[]>`
      SELECT ${SIDECAR_COLUMNS} FROM calendars WHERE ${VISIBLE}
      ORDER BY sort_order ASC, name ASC
    `;
    return rows.map((r) => toLegacyCalendar(r as unknown as Record<string, unknown>));
  }

  async getCalendar(idOrSlug: string): Promise<Calendar | null> {
    const rows = await sql<SidecarRow[]>`
      SELECT ${SIDECAR_COLUMNS} FROM calendars
      WHERE ${isUuid(idOrSlug) ? sql`id = ${idOrSlug}::uuid` : sql`slug = ${idOrSlug}`} AND ${VISIBLE}
      LIMIT 1
    `;
    return rows[0] ? toLegacyCalendar(rows[0] as unknown as Record<string, unknown>) : null;
  }

  async getCalendarByFeedToken(token: string): Promise<Calendar | null> {
    if (!token || token.length !== 32) return null;
    const rows = await sql<SidecarRow[]>`
      SELECT ${SIDECAR_COLUMNS} FROM calendars
      WHERE ics_feed_token = ${token} AND ics_feed_enabled = true AND ${VISIBLE}
      LIMIT 1
    `;
    return rows[0] ? toLegacyCalendar(rows[0] as unknown as Record<string, unknown>) : null;
  }

  async getDefaultCalendar(): Promise<Calendar | null> {
    const rows = await sql<SidecarRow[]>`
      SELECT ${SIDECAR_COLUMNS} FROM calendars WHERE is_default = true AND ${VISIBLE} LIMIT 1
    `;
    return rows[0] ? toLegacyCalendar(rows[0] as unknown as Record<string, unknown>) : null;
  }

  async getBookingsCalendar(): Promise<Calendar | null> {
    const rows = await sql<SidecarRow[]>`
      SELECT ${SIDECAR_COLUMNS} FROM calendars
      WHERE role = 'bookings' AND lifecycle = 'active'
      ORDER BY (slug = 'bookings') DESC, created_at ASC
      LIMIT 1
    `;
    return rows[0] ? toLegacyCalendar(rows[0] as unknown as Record<string, unknown>) : null;
  }

  async getOrCreateFestivitaCalendar(): Promise<Calendar> {
    const rows = await sql<SidecarRow[]>`
      SELECT ${SIDECAR_COLUMNS} FROM calendars
      WHERE role = 'holidays' AND lifecycle = 'active'
      ORDER BY (slug = 'f') DESC, (slug = 'festivita') DESC, created_at ASC
      LIMIT 1
    `;
    if (rows[0]) return toLegacyCalendar(rows[0] as unknown as Record<string, unknown>);
    // Come il legacy: anche col vecchio nome o slug, se il ruolo non è stato riconciliato.
    const [byName] = await sql<SidecarRow[]>`
      SELECT ${SIDECAR_COLUMNS} FROM calendars
      WHERE ${VISIBLE} AND (slug = 'festivita' OR lower(name) IN ('festività', 'festività e chiusure'))
      ORDER BY created_at ASC
      LIMIT 1
    `;
    if (byName) return toLegacyCalendar(byName as unknown as Record<string, unknown>);
    return this.createCalendar({
      slug: 'festivita',
      name: 'Festività e chiusure',
      description: 'Festività nazionali italiane (auto) e chiusure manuali (ferie, ponti)',
      color: '#ef4444',
      timezone: 'Europe/Rome',
      blocks_availability: true,
      is_system: true,
    });
  }

  async createCalendar(input: CreateCalendarInput): Promise<Calendar> {
    // Guardie di createCalendar legacy, stessi messaggi e stesso ordine.
    if (input.timezone && !isValidTimeZone(input.timezone)) throw new CalendarValidationError('Timezone non valida (es. Europe/Rome)');
    if (!CALENDAR_SLUG_REGEX.test(input.slug)) throw new CalendarValidationError('Slug non valido (a-z, 0-9, -)');
    const name = input.name?.trim();
    if (!name) throw new CalendarValidationError('Nome richiesto');
    const slug = input.slug.toLowerCase();
    const [duplicate] = await sql<Array<{ slug: string; name: string }>>`
      SELECT slug, name FROM calendars
      WHERE slug = ${slug} OR lower(name) = ${name.toLowerCase()} OR collection_name = ${slug}
      LIMIT 1
    `;
    if (duplicate?.slug === slug || (duplicate && duplicate.name.toLowerCase() !== name.toLowerCase())) {
      throw new CalendarConflictError('Slug gia usato');
    }
    if (duplicate) throw new CalendarConflictError('Nome calendario gia usato');
    if (!isValidCollectionName(slug)) throw new CalendarValidationError('Slug non valido (a-z, 0-9, -)');
    const { client, principal } = requireRadicale();

    // 1. Riga `creating` che prenota collection_name, con il job di recupero nella stessa transazione.
    let row: SidecarRow;
    try {
      row = await inTransaction(async (tx) => {
        const [r] = await tx<SidecarRow[]>`
          INSERT INTO calendars ${tx({
            slug,
            name: name.slice(0, 200),
            description: input.description?.trim().slice(0, 1000) || null,
            color: input.color || '#7c3aed',
            icon: input.icon || null,
            timezone: input.timezone || 'Europe/Rome',
            is_default: !!input.is_default,
            is_system: !!input.is_system,
            blocks_availability: input.blocks_availability !== false,
            ics_feed_token: generateFeedToken(),
            ics_feed_enabled: true,
            sort_order: input.sort_order || 0,
            collection_name: slug,
            lifecycle: 'creating',
          })}
          RETURNING ${SIDECAR_COLUMNS}
        `;
        await enqueueCalendarJob(CAL_JOB_KINDS.calendarLifecycle, r.id, { phase: 'creating' }, {
          db: tx,
          sourceVersion: 'creating',
          delayMs: LIFECYCLE_RECOVERY_DELAY_MS,
        });
        return r;
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === '23505') throw new CalendarConflictError('Slug gia usato');
      throw err;
    }

    // 2. MKCALENDAR con le dead prop calendar-id e role (contratto control-plane §4.5).
    try {
      await withCalendarWriteGate(async (ctx) => {
        await assertVolumeIdentity(ctx.state);
        const props = collectionDavProps(row);
        await client.mkcalendar(collectionPath(principal, slug), {
          displayName: row.name,
          color: row.color,
          description: row.description ?? undefined,
          order: row.sort_order,
          timezone: props.set.find((p) => p.name === DAV_PROPS.calendarTimezone.name)?.value,
          components: allowedComponents(row),
          props: [
            { ...DAV_PROPS.calendarId, value: row.id },
            { ...DAV_PROPS.role, value: row.role },
          ],
        });
      }, { expect: 'radicale' });
    } catch (err) {
      const unknownOutcome = isRadicaleError(err) && err.outcomeUnknown;
      if (unknownOutcome) {
        // Il job di recupero adotta la collezione (dead prop calendar-id) o elimina la riga.
        throw new CalendarUnavailableError('radicale_unreachable', 'esito della creazione del calendario non noto: verrà completata o annullata automaticamente', { cause: err });
      }
      await deleteSidecarRow(row.id).catch((e: unknown) => log.error({ err: e, calendarId: row.id }, 'eliminazione della riga creating non riuscita: la completerà il job'));
      if (isCollectionExistsError(err)) throw new CalendarConflictError('Slug gia usato');
      throw isRadicaleError(err) ? radicaleWriteError(err, 'la creazione del calendario') : err;
    }

    // 3. Attivazione (e stato della collezione per freshness e salute).
    const activated = await this.activateCreated(row.id, !!input.is_default);
    await writeThrough([row.id], 'api');
    if (!activated) throw new CalendarConflictError('Calendario non più disponibile dopo la creazione');
    return toLegacyCalendar(activated as unknown as Record<string, unknown>);
  }

  /** creating → active (idempotente), con la riga di cal_collection_state. */
  async activateCreated(calendarId: string, makeDefault: boolean): Promise<SidecarRow | null> {
    const { ensureCollectionState } = await import('./indexer');
    return inTransaction(async (tx) => {
      if (makeDefault) await tx`UPDATE calendars SET is_default = false WHERE is_default = true AND id <> ${calendarId}::uuid`;
      const [r] = await tx<SidecarRow[]>`
        UPDATE calendars SET lifecycle = 'active'
        WHERE id = ${calendarId}::uuid AND lifecycle IN ('creating', 'active')
        RETURNING ${SIDECAR_COLUMNS}
      `;
      if (r) await ensureCollectionState(tx, calendarId, 'radicale');
      return r ?? null;
    });
  }

  async updateCalendar(id: string, input: UpdateCalendarInput): Promise<Calendar | null> {
    if (!isUuid(id)) {
      // Parità con updateCalendar legacy: senza campi da aggiornare la lettura
      // accetta anche lo slug, altrimenti l'UPDATE con il cast a uuid fallisce
      // (400). La timezone si valida prima, come nel legacy.
      if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) throw new CalendarValidationError('Timezone non valida (es. Europe/Rome)');
      const touches = input.name !== undefined || input.description !== undefined
        || (input.color !== undefined && /^#[0-9a-f]{6}$/i.test(input.color)) || input.icon !== undefined
        || input.timezone !== undefined || input.blocks_availability !== undefined || input.ics_feed_enabled !== undefined
        || input.sort_order !== undefined || input.is_default === true || input.is_default === false;
      if (!touches) return this.getCalendar(id);
      id = await castLegacyUuid(id);
    }
    const cal = await sidecarById(id, { activeOnly: true });
    if (!cal || cal.role === 'subscription') return null;
    // Stessa costruzione degli aggiornamenti di updateCalendar legacy.
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = String(input.name).trim().slice(0, 200);
    if (input.description !== undefined) updates.description = input.description ? String(input.description).trim().slice(0, 1000) : null;
    if (input.color !== undefined && /^#[0-9a-f]{6}$/i.test(input.color)) updates.color = input.color;
    if (input.icon !== undefined) updates.icon = input.icon;
    if (input.timezone !== undefined) {
      if (!isValidTimeZone(input.timezone)) throw new CalendarValidationError('Timezone non valida (es. Europe/Rome)');
      updates.timezone = input.timezone;
    }
    if (input.blocks_availability !== undefined) updates.blocks_availability = !!input.blocks_availability;
    if (input.ics_feed_enabled !== undefined) updates.ics_feed_enabled = !!input.ics_feed_enabled;
    if (input.sort_order !== undefined) updates.sort_order = parseInt(String(input.sort_order)) || 0;
    if (input.is_default === true) updates.is_default = true;
    else if (input.is_default === false) updates.is_default = false;
    if (Object.keys(updates).length === 0) return this.getCalendar(cal.id);

    const next = { ...cal, ...updates } as SidecarRow;
    const davChanged =
      next.name !== cal.name || next.color !== cal.color || (next.description ?? null) !== (cal.description ?? null)
      || next.sort_order !== cal.sort_order || next.timezone !== cal.timezone;
    if (davChanged && isValidCollectionName(cal.collection_name)) {
      // PROPPATCH (design §8 "Modifica"): i device vedono nome, colore, ordine, descrizione e fuso.
      const { client, principal } = requireRadicale();
      await withCalendarWriteGate(async (ctx) => {
        await assertVolumeIdentity(ctx.state);
        const props = collectionDavProps(next);
        try {
          await client.proppatch(collectionPath(principal, cal.collection_name as string), { set: props.set, remove: props.remove });
        } catch (err) {
          throw isRadicaleError(err) ? radicaleWriteError(err, 'la modifica del calendario') : err;
        }
      }, { expect: 'radicale' });
    }
    const updated = await inTransaction(async (tx) => {
      if (input.is_default === true) await tx`UPDATE calendars SET is_default = false WHERE is_default = true AND id != ${cal.id}::uuid`;
      const [r] = await tx<SidecarRow[]>`
        UPDATE calendars SET ${tx(updates)}
        WHERE id = ${cal.id}::uuid
        RETURNING ${SIDECAR_COLUMNS}
      `;
      return r ?? null;
    });
    if (updated && next.timezone !== cal.timezone) {
      // Cambio di fuso: floating e all-day si reinterpretano (contratto §2.4).
      try {
        const { rematerializeCollection } = await import('./indexer');
        await rematerializeCollection(cal.id, { horizon: targetHorizon(new Date()), reason: 'timezone' });
      } catch (err) {
        log.error({ err, calendarId: cal.id }, 'rimaterializzazione dopo il cambio di fuso non riuscita: la ripeterà l\'orizzonte');
      }
    }
    return updated ? toLegacyCalendar(updated as unknown as Record<string, unknown>) : null;
  }

  async deleteCalendar(id: string): Promise<void> {
    if (!isUuid(id)) {
      // Parità con deleteCalendar legacy: il calendario si cerca anche per
      // slug (inesistente → nessun errore, di sistema → 422), ma la DELETE
      // usa l'id con il cast a uuid, che per uno slug fallisce (400).
      const bySlug = await this.getCalendar(id);
      if (!bySlug) return;
      if (bySlug.is_system) throw new CalendarSystemError(`Calendario "${bySlug.name}" è di sistema e non può essere eliminato`);
      id = await castLegacyUuid(id);
    }
    const cal = await sidecarById(id, { activeOnly: true });
    if (!cal || cal.role === 'subscription') return;
    if (cal.is_system) throw new CalendarSystemError(`Calendario "${cal.name}" è di sistema e non può essere eliminato`);
    await deleteCalendarLifecycle(cal);
  }

  async rotateFeedToken(id: string): Promise<Calendar | null> {
    // Parità con rotateFeedToken legacy: un id non UUID fallisce il cast (400).
    if (!isUuid(id)) id = await castLegacyUuid(id);
    const rows = await sql<SidecarRow[]>`
      UPDATE calendars SET ics_feed_token = ${generateFeedToken()}
      WHERE id = ${id}::uuid AND ${VISIBLE}
      RETURNING ${SIDECAR_COLUMNS}
    `;
    return rows[0] ? toLegacyCalendar(rows[0] as unknown as Record<string, unknown>) : null;
  }

  async countEventsByCalendar(): Promise<Map<string, number>> {
    // Semantica legacy di event_count: VEVENT non cancellati, override compresi; le iscrizioni contano
    // nel calendario di destinazione (design §7).
    const counts = await sql<Array<{ calendar_id: string; n: number }>>`
      SELECT CASE WHEN c.role = 'subscription' THEN COALESCE(s.calendar_id, c.parent_calendar_id) ELSE c.id END AS calendar_id,
             COUNT(*)::int AS n
      FROM cal_components comp
      JOIN calendars c ON c.id = comp.calendar_id AND c.lifecycle = 'active'
      LEFT JOIN calendar_subscriptions s ON s.collection_calendar_id = c.id
      WHERE comp.component = 'VEVENT' AND comp.status <> 'cancelled'
      GROUP BY 1
    `;
    const out = new Map<string, number>();
    for (const r of counts) if (r.calendar_id) out.set(r.calendar_id, (out.get(r.calendar_id) ?? 0) + r.n);
    return out;
  }

  async listClosures(): Promise<ClosuresView> {
    // Collezione holidays: tutti gli item tranne le festività it-holiday-* (source system), con fine negli
    // ultimi 30 giorni o dopo. Niente creazione del calendario come effetto collaterale (design §7, §14).
    const [cal] = await sql<SidecarRow[]>`
      SELECT ${SIDECAR_COLUMNS} FROM calendars
      WHERE lifecycle = 'active' AND role <> 'subscription'
        AND (role = 'holidays' OR slug = 'festivita' OR lower(name) IN ('festività', 'festività e chiusure'))
      ORDER BY (role = 'holidays') DESC, (slug = 'f') DESC, (slug = 'festivita') DESC, created_at ASC
      LIMIT 1
    `;
    if (!cal) {
      throw new CalendarStoreUnavailableError('radicale', 'listClosures', 'calendario festività (role=holidays) assente: va creato dall\'inizializzazione');
    }
    const closures = await sql<ClosureRow[]>`
      SELECT comp.id,
             COALESCE(NULLIF(comp.summary, ''), ${UNTITLED_SUMMARY}) AS summary,
             comp.start_utc AS start_time, comp.end_utc AS end_time,
             obj.source, comp.status
      FROM cal_components comp
      JOIN cal_objects obj ON obj.id = comp.object_id
      WHERE comp.calendar_id = ${cal.id}::uuid
        AND comp.component = 'VEVENT'
        AND obj.source <> 'system'
        AND comp.end_utc > NOW() - interval '30 days'
      ORDER BY comp.start_utc ASC, comp.id
    `;
    return { closures, calendar: { id: cal.id, name: cal.name, timezone: cal.timezone } };
  }

  // ── Iscrizioni ──

  async listSubscriptions(): Promise<CalendarSubscription[]> {
    return sql<CalendarSubscription[]>`SELECT ${SUBSCRIPTION_COLUMNS} FROM calendar_subscriptions ORDER BY created_at DESC`;
  }

  async getSubscription(id: string): Promise<CalendarSubscription | null> {
    if (!isUuid(id)) return null;
    const rows = await sql<CalendarSubscription[]>`
      SELECT ${SUBSCRIPTION_COLUMNS} FROM calendar_subscriptions WHERE id = ${id}::uuid LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<CalendarSubscription> {
    if (!input.calendar_id) throw new SubscriptionValidationError('calendar_id richiesto');
    if (!input.name?.trim()) throw new SubscriptionValidationError('Nome richiesto');
    if (!/^https?:\/\//i.test(input.ics_url)) throw new SubscriptionValidationError('URL ICS deve iniziare con http:// o https://');
    const rows = await sql<CalendarSubscription[]>`
      INSERT INTO calendar_subscriptions ${sql({
        calendar_id: input.calendar_id,
        name: input.name.trim().slice(0, 200),
        ics_url: input.ics_url.trim(),
        sync_enabled: true,
      })}
      RETURNING ${SUBSCRIPTION_COLUMNS}
    `;
    const sub = rows[0];
    // Sidecar dell'indice (role=subscription): senza, il pull non indicizza. Un errore qui non fa fallire
    // la creazione: syncSubscription lo riprova.
    try {
      await enableSubscriptionIndex(sub.id);
    } catch (err) {
      log.warn({ err, subscriptionId: sub.id }, 'sidecar dell\'iscrizione non creato: lo creerà la prima sync');
    }
    return sub;
  }

  async updateSubscription(id: string, input: UpdateSubscriptionInput): Promise<CalendarSubscription | null> {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = String(input.name).trim().slice(0, 200);
    if (input.ics_url !== undefined) {
      if (!/^https?:\/\//i.test(input.ics_url)) throw new SubscriptionValidationError('URL ICS deve iniziare con http:// o https://');
      updates.ics_url = String(input.ics_url).trim();
      updates.etag = null;
      updates.last_modified = null;
    }
    if (input.sync_enabled !== undefined) updates.sync_enabled = !!input.sync_enabled;
    if (input.calendar_id !== undefined) updates.calendar_id = input.calendar_id;
    if (Object.keys(updates).length === 0) return this.getSubscription(id);
    if (!isUuid(id)) return null;
    return inTransaction(async (tx) => {
      const [sub] = await tx<Array<CalendarSubscription & { collection_calendar_id: string | null }>>`
        UPDATE calendar_subscriptions SET ${tx(updates)}
        WHERE id = ${id}::uuid
        RETURNING ${SUBSCRIPTION_COLUMNS}, collection_calendar_id
      `;
      if (!sub) return null;
      // Il sidecar segue il calendario di destinazione (parent_calendar_id).
      if (input.calendar_id !== undefined && sub.collection_calendar_id) {
        await tx`UPDATE calendars SET parent_calendar_id = ${input.calendar_id}::uuid WHERE id = ${sub.collection_calendar_id}::uuid`;
      }
      const { collection_calendar_id: _sidecar, ...rest } = sub;
      void _sidecar;
      return rest as CalendarSubscription;
    });
  }

  async deleteSubscription(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const [sub] = await sql<Array<{ id: string; collection_calendar_id: string | null; device_visible: boolean }>>`
      SELECT id, collection_calendar_id, device_visible FROM calendar_subscriptions WHERE id = ${id}::uuid
    `;
    if (!sub) return false;
    const sidecar = sub.collection_calendar_id ? await sidecarById(sub.collection_calendar_id, { activeOnly: false }) : null;
    const removed = await inTransaction(async (tx) => {
      const rows = await tx`DELETE FROM calendar_subscriptions WHERE id = ${id}::uuid RETURNING id`;
      if (sidecar && sidecar.role === 'subscription') {
        await tx`SELECT set_config('caldes.reverse_sync', 'on', true)`;
        await tx`DELETE FROM calendars WHERE id = ${sidecar.id}::uuid AND role = 'subscription'`;
      }
      return rows.length > 0;
    });
    // Specchio sui device (sub-*): la collezione si toglie dopo, al meglio (l'auditor segnala le orfane).
    if (removed && sidecar && sub.device_visible && isValidCollectionName(sidecar.collection_name)) {
      deleteCollection(sidecar).catch((err: unknown) => log.warn({ err, calendarId: sidecar.id }, 'collezione specchio dell\'iscrizione non eliminata'));
    }
    return removed;
  }

  async syncSubscription(id: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
    const sub = await this.getSubscription(id);
    if (!sub) throw new SubscriptionValidationError('Subscription non trovata');
    const [link] = await sql<Array<{ collection_calendar_id: string | null }>>`
      SELECT collection_calendar_id FROM calendar_subscriptions WHERE id = ${sub.id}::uuid
    `;
    // Sidecar dell'indice (role=subscription), creato alla prima sync se manca.
    if (!link?.collection_calendar_id) await enableSubscriptionIndex(sub.id);
    // Il pull non lancia per feed, rete o indice: l'esito è nel risultato, come il sync legacy.
    // updateSubscriptionRow: last_synced_at, last_error ed event_count dell'iscrizione (mai etag e
    // last_modified, cache del pull legacy).
    const result = await pullSubscriptionToIndex(sub.id, { force: opts.force, updateSubscriptionRow: true });
    if (result.status === 'skipped') {
      return { notModified: false, inserted: 0, removed: 0, error: result.error ?? 'Iscrizione senza indice' };
    }
    return toLegacySyncResult(result);
  }

  async replaceSubscriptionEvents(): Promise<{ inserted: number; removed: number }> {
    throw new CalendarStoreUnavailableError('radicale', 'replaceSubscriptionEvents', 'operazione dello store legacy: con Radicale il pull scrive nell\'indice');
  }

  async syncAllSubscriptions(): Promise<{ total: number; ok: number; failed: number; notModified: number }> {
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM calendar_subscriptions WHERE sync_enabled = true`;
    let ok = 0;
    let failed = 0;
    let notModified = 0;
    for (const { id } of rows) {
      try {
        const res = await this.syncSubscription(id);
        if (res.error) failed++;
        else if (res.notModified) {
          ok++;
          notModified++;
        } else ok++;
      } catch (err) {
        failed++;
        log.error({ err, subscriptionId: id }, 'sync dell\'iscrizione non riuscita');
      }
    }
    return { total: rows.length, ok, failed, notModified };
  }
}

// ═══════════════════════════════════════════════════════════════════
// "Questa e le successive": saga recurrence_split (design §8)
// ═══════════════════════════════════════════════════════════════════

export interface SplitRecurringEventInput {
  /** id o UID del master della serie. */
  masterEventId: string;
  /** Istante originale (ISO) dell'occorrenza da cui parte il taglio. */
  originalStartIso: string;
  /** Modifiche per la nuova serie, con la forma di updateEvent (calendar_id non ammesso). */
  changes?: UpdateEventInput;
}

export interface SplitRecurringEventResult {
  /** Taglio sulla prima istanza: la modifica è valsa per tutta la serie. */
  wholeSeries: boolean;
  /** Vecchia serie troncata (null se wholeSeries). */
  head: CalendarEvent | null;
  /** Nuova serie (o la serie intera modificata se wholeSeries). */
  tail: CalendarEvent;
}

interface SplitJobPayload extends Record<string, unknown> {
  calendarId: string;
  href: string;
  newHref: string;
  newUid: string;
  recurrenceKey: string;
  baseEtag: string | null;
  /**
   * started (prima della PUT della nuova serie), tail-written, done;
   * compensate: il taglio (b) è fallito in modo definitivo e la DELETE
   * compensativa della nuova serie non è riuscita: il job la ripete.
   */
  phase: 'started' | 'tail-written' | 'compensate' | 'done';
  /** Fase compensate: ETag della nuova serie scritta dalla saga (If-Match della DELETE). */
  tailEtag?: string | null;
}

async function enqueueSplitJob(masterUid: string, payload: SplitJobPayload, delayMs: number): Promise<void> {
  await enqueueCalendarJob(CAL_JOB_KINDS.recurrenceSplit, masterUid, payload, {
    sourceVersion: payload.baseEtag,
    delayMs,
  });
}

/**
 * "Questa e le successive" (design §8): (a) PUT della nuova serie con UID
 * nuovo (If-None-Match: *), RELATED-TO;RELTYPE=SIBLING, override ed
 * EXDATE/RDATE dal taglio e COUNT residuo; (b) PUT del vecchio master troncato
 * (UNTIL al giorno o all'istante precedente) con If-Match. Prima di (a) il job
 * recurrence_split registra la saga (recupero se il processo cade a metà);
 * se (b) fallisce in modo definitivo la nuova serie si cancella
 * (compensazione) e il chiamante riceve l'errore. Un taglio sulla prima
 * istanza equivale a "tutta la serie" (updateEvent sul master).
 */
export async function splitRecurringEvent(input: SplitRecurringEventInput): Promise<SplitRecurringEventResult> {
  const store = getRadicaleStore();
  const ref = await resolveEvent(input.masterEventId);
  if (!ref) throw new EventValidationError('Master event non trovato');
  assertEventWritable(ref.calendar);
  if (ref.recurrenceKey !== MASTER_RECURRENCE_KEY) throw new EventValidationError('L\'evento non è ricorrente');
  if (input.changes?.calendar_id !== undefined) throw new EventValidationError('"Questa e le successive" non può cambiare calendario');
  if (!Number.isFinite(Date.parse(input.originalStartIso))) throw new EventValidationError('original_start non valido');
  checkLegacyTimes(input.changes ?? {});
  const { client, principal } = requireRadicale();
  const cal = ref.calendar;
  const tz = safeTz(cal.timezone);
  const collection = collectionNameOf(cal);
  const masterPath = objectPath(principal, collection, ref.href);
  const changes = patchInput(input.changes ?? {});

  const outcome = await withCalendarWriteGate(async (ctx) => {
    await assertVolumeIdentity(ctx.state);
    const current = await fetchCurrent(client, masterPath, 'la serie');
    if (!current) throw new EventValidationError('Master event non trovato');
    if (!current.object) throw new EventReadOnlyError(UNREADABLE_EVENT_MESSAGE);
    const obj = current.object;
    const now = new Date();
    let key: string;
    let split: ReturnType<typeof splitSeries>;
    try {
      if (!isRecurringMaster(obj)) throw new EventValidationError('L\'evento non è ricorrente');
      key = recurrenceKeyForIso(obj, input.originalStartIso, tz);
      if (!occurrenceExists(obj, key, { tz, now })) throw new RecurrenceTargetError('RECURRENCE_TARGET_GONE', 'Occorrenza non più presente', key);
      const newUid = generateEventUid();
      split = splitSeries(obj, key, { newUid }, { tz, now });
    } catch (err) {
      throw domainError(err, 'la serie');
    }
    if (split.wholeSeries || !split.tail) return { whole: true as const };

    let tailObj = split.tail;
    if (Object.keys(changes).length) {
      try {
        const res = applyLegacyUpdate(tailObj, MASTER_RECURRENCE_KEY, changes, { tz, now });
        if (!res.noop) tailObj = res.object;
      } catch (err) {
        throw domainError(err, 'la nuova serie');
      }
    }
    const headText = serializeObject(split.head, { prodid: 'preserve' });
    const tailText = serializeObject(tailObj, {});
    assertValidForWrite(split.head, cal, headText, obj);
    assertValidForWrite(tailObj, cal, tailText, null);
    const newHref = hrefForUid(tailObj.uid);
    const tailPath = objectPath(principal, collection, newHref);
    const payload: SplitJobPayload = {
      calendarId: cal.id,
      href: ref.href,
      newHref,
      newUid: tailObj.uid,
      recurrenceKey: key,
      baseEtag: current.etag,
      phase: 'started',
    };
    await enqueueSplitJob(obj.uid, payload, SPLIT_RECOVERY_DELAY_MS);

    // (a) nuova serie
    let tailEtag: string | null;
    try {
      tailEtag = (await client.put(tailPath, tailText, { ifNoneMatch: '*' })).etag;
    } catch (err) {
      throw domainError(err, 'la nuova serie');
    }
    await enqueueSplitJob(obj.uid, { ...payload, phase: 'tail-written' }, SPLIT_RECOVERY_DELAY_MS).catch((err: unknown) =>
      log.warn({ err, uid: obj.uid }, 'aggiornamento del job della saga non riuscito: il recupero leggerà lo stato da Radicale'));

    // (b) vecchia serie troncata, con If-Match; su 412 si ricalcola il taglio sul testo corrente.
    let head = split.head;
    let headPut = headText;
    let etagBefore = current.etag;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await client.put(masterPath, headPut, { ifMatch: etagBefore ?? '*' });
        await enqueueSplitJob(obj.uid, { ...payload, phase: 'done' }, 0).catch(() => undefined);
        return { whole: false as const, head, tail: tailObj, newHref, headEtagBefore: current.etag, headEtag: res.etag, tailEtag, key };
      } catch (err) {
        const retry = isRadicaleError(err, 'precondition_failed') && attempt < MAX_WRITE_ATTEMPTS;
        if (retry) {
          const again = await fetchCurrent(client, masterPath, 'la serie');
          let truncated: CalendarObject | null = null;
          try {
            if (again?.object) truncated = truncateSeries(again.object, key, { tz, now: new Date() });
          } catch {
            truncated = null;
          }
          if (again?.object && truncated) {
            head = truncated;
            headPut = serializeObject(truncated, { prodid: 'preserve' });
            etagBefore = again.etag;
            continue;
          }
        }
        if (isRadicaleError(err) && (err.transient || err.outcomeUnknown)) {
          // Esito ignoto o Radicale giù: la saga resta registrata e il job la completa.
          throw new CalendarUnavailableError('radicale_unreachable', 'divisione della serie in corso: verrà completata automaticamente', { cause: err });
        }
        // Compensazione: via la nuova serie, la vecchia resta com'era. Se la
        // DELETE non riesce, la saga passa alla fase 'compensate' e il job la
        // ripete (mai 'done' con la nuova serie ancora accanto al vecchio
        // master non troncato: occorrenze doppie).
        expectCollectionDeletion(cal.id, newHref);
        let compensated = true;
        try {
          await client.delete(tailPath, { ifMatch: tailEtag ?? '*' });
        } catch (e) {
          if (!isRadicaleError(e, 'not_found')) {
            compensated = false;
            if (!(isRadicaleError(e) && e.outcomeUnknown)) forgetCollectionDeletion(cal.id, newHref);
            log.error({ err: e, uid: obj.uid, newHref }, 'compensazione della saga non riuscita: la completerà il job');
          }
        }
        await enqueueSplitJob(
          obj.uid,
          compensated ? { ...payload, phase: 'done' } : { ...payload, phase: 'compensate', tailEtag },
          0,
        ).catch((e: unknown) => log.error({ err: e, uid: obj.uid, newHref }, 'aggiornamento del job della saga non riuscito'));
        if (retry || isRadicaleError(err, 'precondition_failed')) throw new CalendarRecurrenceConflictError(key);
        throw domainError(err, 'la serie');
      }
    }
  }, { expect: 'radicale' });

  if (outcome.whole) {
    const updated = await store.updateEvent(ref.id, input.changes ?? {});
    if (!updated) throw new EventValidationError('Master event non trovato');
    return { wholeSeries: true, head: null, tail: updated };
  }
  const actor = 'api';
  await writeThrough([cal.id], actor);
  const headId = ref.id;
  const tailId = await positionId(cal.id, outcome.newHref, MASTER_RECURRENCE_KEY, outcome.tail.uid);
  await audit({ action: 'UPDATE', recordId: headId, operation: 'splitSeries:head', calendar: cal, href: ref.href, etagBefore: outcome.headEtagBefore, etagAfter: outcome.headEtag, actor, extra: { recurrence_key: outcome.key } });
  await audit({ action: 'INSERT', recordId: tailId, operation: 'splitSeries:tail', calendar: cal, href: outcome.newHref, etagBefore: null, etagAfter: outcome.tailEtag, actor, extra: { related_to: ref.href } });
  const headMeta = await eventMeta(cal, ref.href, ref.objectId);
  const tailMeta = await eventMeta(cal, outcome.newHref, tailId);
  const tail = eventFromObject(outcome.tail, MASTER_RECURRENCE_KEY, tailId, tailMeta);
  if (!tail) throw new EventValidationError('Nuova serie non leggibile dopo la scrittura');
  return { wholeSeries: false, head: eventFromObject(outcome.head, MASTER_RECURRENCE_KEY, headId, headMeta), tail };
}

/**
 * Recupero della saga (job recurrence_split): stato voluto calcolato da
 * Radicale all'esecuzione, mai solo dal payload.
 *  - phase done, oppure nuova serie assente (la saga non l'ha scritta): nulla;
 *  - master sparito: nulla (la nuova serie è dell'utente, mai cancellarla);
 *  - master già troncato (l'istanza di taglio non c'è più): fatto;
 *  - master invariato dall'inizio della saga (ETag di base): si applica il
 *    taglio (passo b) con If-Match;
 *  - master cambiato da altri prima del taglio: compensazione (DELETE della
 *    nuova serie), si torna allo stato di prima della saga.
 */
export async function runRecurrenceSplitJob(job: CalendarJob): Promise<{ result: string }> {
  const p = job.payload as Partial<SplitJobPayload>;
  if (p.phase === 'done') return { result: 'done' };
  if (!p.calendarId || !p.href || !p.newHref || !p.recurrenceKey) throw new CalendarJobPermanentError('payload della saga incompleto');
  const cal = await sidecarById(p.calendarId, { activeOnly: true });
  if (!cal) return { result: 'calendar-gone' };
  const { client, principal } = requireRadicale();
  const tz = safeTz(cal.timezone);
  const collection = collectionNameOf(cal);
  const masterPath = objectPath(principal, collection, p.href);
  const tailPath = objectPath(principal, collection, p.newHref);
  const newHref = p.newHref;
  const result = await withCalendarWriteGate(async (ctx) => {
    await assertVolumeIdentity(ctx.state);
    const tail = await fetchCurrent(client, tailPath, 'la nuova serie');
    if (!tail) return 'aborted';
    if (p.phase === 'compensate') {
      // Il taglio era fallito in modo definitivo e l'utente ha ricevuto
      // l'errore: la nuova serie scritta dalla saga va tolta. Se nel frattempo
      // qualcuno l'ha modificata (ETag diverso) è sua: resta.
      if (p.tailEtag && tail.etag && tail.etag !== p.tailEtag) {
        log.warn({ calendarId: cal.id, newHref }, 'saga "questa e le successive": nuova serie modificata dopo il fallimento, compensazione saltata');
        return 'tail-modified';
      }
      expectCollectionDeletion(cal.id, newHref, 'recurrence-split');
      try {
        await client.delete(tailPath, { ifMatch: tail.etag ?? '*' });
      } catch (err) {
        if (isRadicaleError(err, 'not_found')) return 'aborted';
        if (!(isRadicaleError(err) && err.outcomeUnknown)) forgetCollectionDeletion(cal.id, newHref);
        if (isRadicaleError(err, 'precondition_failed')) return 'tail-modified';
        throw err;
      }
      log.warn({ calendarId: cal.id, href: p.href, newHref }, 'saga "questa e le successive" compensata dal job dopo il fallimento del taglio');
      return 'compensated';
    }
    const master = await fetchCurrent(client, masterPath, 'la serie');
    if (!master) return 'master-gone';
    if (!master.object) return 'master-unreadable';
    const now = new Date();
    let present: boolean;
    try {
      present = occurrenceExists(master.object, p.recurrenceKey as string, { tz, now });
    } catch {
      present = false;
    }
    if (!present) return 'already-truncated';
    if (p.baseEtag && master.etag === p.baseEtag) {
      const truncated = truncateSeries(master.object, p.recurrenceKey as string, { tz, now });
      if (truncated) {
        await client.put(masterPath, serializeObject(truncated, { prodid: 'preserve' }), { ifMatch: master.etag });
        return 'truncated';
      }
    }
    expectCollectionDeletion(cal.id, newHref, 'recurrence-split');
    try {
      await client.delete(tailPath, { ifMatch: tail.etag ?? '*' });
    } catch (err) {
      if (!(isRadicaleError(err) && err.outcomeUnknown)) forgetCollectionDeletion(cal.id, newHref);
      throw err;
    }
    log.warn({ calendarId: cal.id, href: p.href, newHref: p.newHref }, 'saga "questa e le successive" compensata: la serie era cambiata prima del taglio');
    return 'compensated';
  }, { expect: 'radicale' });
  if (result === 'truncated' || result === 'compensated') await writeThrough([cal.id], 'recurrence-split');
  return { result };
}

// ═══════════════════════════════════════════════════════════════════
// Recupero del lifecycle dei calendari (job calendar_lifecycle)
// ═══════════════════════════════════════════════════════════════════

/**
 * Completa una creazione o una cancellazione rimasta a metà (design §8):
 *  - creating: collezione con la dead prop calendar-id della riga → active;
 *    collezione assente o di un altro → riga eliminata. Una riga troppo
 *    giovane (richiesta forse ancora in corso) viene rimandata;
 *  - deleting: DELETE della collezione (404 = già sparita), poi della riga;
 *  - active o riga assente: nulla.
 */
export async function runCalendarLifecycleJob(job: CalendarJob): Promise<{ result: string }> {
  const cal = await sidecarById(job.key, { activeOnly: false });
  if (!cal) return { result: 'gone' };
  if (cal.lifecycle === 'active') return { result: 'active' };
  if (cal.lifecycle === 'deleting') {
    await deleteCollection(cal);
    await deleteSidecarRow(cal.id);
    return { result: 'deleted' };
  }
  const age = Date.now() - new Date(cal.updated_at).getTime();
  if (age < CREATING_GRACE_MS) {
    await enqueueCalendarJob(CAL_JOB_KINDS.calendarLifecycle, cal.id, { phase: 'creating' }, {
      sourceVersion: 'creating',
      delayMs: CREATING_GRACE_MS - age + 1_000,
    });
    return { result: 'deferred' };
  }
  const { client, principal } = requireRadicale();
  const decision = await withCalendarWriteGate(async (ctx) => {
    await assertVolumeIdentity(ctx.state);
    if (!isValidCollectionName(cal.collection_name)) return 'invalid';
    const props = await client.readProps(collectionPath(principal, cal.collection_name), [DAV_PROPS.resourcetype, DAV_PROPS.calendarId]);
    if (props === null) return 'missing';
    return props[clark(DAV_PROPS.calendarId)]?.toLowerCase() === cal.id ? 'adopt' : 'foreign';
  }, { expect: 'radicale' });
  if (decision === 'adopt') {
    await getRadicaleStoreImpl().activateCreated(cal.id, cal.is_default);
    await writeThrough([cal.id], 'calendar-lifecycle');
    return { result: 'activated' };
  }
  log.warn({ calendarId: cal.id, collection: cal.collection_name, decision }, 'creazione del calendario non completata: riga creating eliminata');
  await deleteSidecarRow(cal.id);
  return { result: `removed:${decision}` };
}

let jobsRegistered = false;

/**
 * Registra gli handler dei job dello store (recurrence_split,
 * calendar_lifecycle). La chiama il bootstrap prima di startCalendarJobWorker
 * (contratto §12). Errori di indisponibilità → ripetibili (backoff); errori
 * di dominio definitivi → dead letter.
 */
export function registerStoreJobs(): void {
  if (jobsRegistered) return;
  jobsRegistered = true;
  const wrap = (fn: (job: CalendarJob) => Promise<{ result: string }>) => async (job: CalendarJob, ctx: CalendarJobContext) => {
    if (ctx.signal.aborted) throw new Error('job interrotto');
    try {
      return await fn(job);
    } catch (err) {
      if (err instanceof CalendarJobPermanentError || isCalendarUnavailable(err)) throw err;
      if (isRadicaleError(err)) {
        if (err.transient || err.outcomeUnknown) throw err;
        throw new CalendarJobPermanentError(`errore definitivo di Radicale: ${err.message}`, { cause: err });
      }
      if (err instanceof EventValidationError || err instanceof CalendarConflictError || isCalendarCoreError(err)) {
        throw new CalendarJobPermanentError(errorMessage(err), { cause: err });
      }
      throw err;
    }
  };
  registerCalendarJobHandler(CAL_JOB_KINDS.recurrenceSplit, wrap(runRecurrenceSplitJob));
  registerCalendarJobHandler(CAL_JOB_KINDS.calendarLifecycle, wrap(runCalendarLifecycleJob));
}

// ═══════════════════════════════════════════════════════════════════
// Istanza
// ═══════════════════════════════════════════════════════════════════

let instance: RadicaleStore | null = null;

function getRadicaleStoreImpl(): RadicaleStore {
  instance ??= new RadicaleStore();
  return instance;
}

/**
 * Istanza dello store Radicale del processo, creata alla prima richiesta.
 * La creazione non fa I/O: client, mount e pool si risolvono alla prima
 * operazione, così l'API parte anche con Radicale giù o non configurato.
 */
export function getRadicaleStore(): CalendarStore {
  return getRadicaleStoreImpl();
}



