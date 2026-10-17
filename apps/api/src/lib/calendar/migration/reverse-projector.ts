/**
 * Proiezione inversa Radicale → Postgres nella finestra di rollback (fase F4
 * del passaggio del calendario a Radicale; design §13.11, §5, §9, §13.12;
 * contratto docs/calendar-radicale/contracts/f4-modules.md §4).
 *
 * Dopo il cutover la fonte di verità è Radicale, ma per 30 giorni si deve
 * poter tornare a Postgres senza perdere la semantica del busy: ogni modifica
 * fatta in Radicale (device, admin, MCP, sistema) viene proiettata in
 * calendar_events, che il codice legacy ritrova identico al momento del
 * rollback. È l'unico scrittore di calendar_events fuori da mode postgres (con
 * `SET LOCAL caldes.reverse_sync = 'on'`, guardia 166) e l'unico scrittore di
 * cal_migration_reverse_state.
 *
 * Mappatura totale e testata dall'indice allo schema legacy (§4.2 del
 * contratto). Per ogni risorsa indicizzata delle collezioni proiettate
 * (role ≠ subscription, origin ≠ migration, lifecycle active):
 *
 *  - rappresentabili (una riga master, gli override, le EXDATE): VEVENT
 *    singolo, oppure serie con DTSTART all-day, UTC o Europe/Rome senza RDATE,
 *    con override abbinati dello stesso tipo del master, la cui espansione
 *    legacy (legacy/rrule-legacy, la stessa del busy legacy) coincide istanza
 *    per istanza con le occorrenze dell'indice sull'orizzonte materializzato
 *    (confronto di inizio, fine e "blocca");
 *  - espansi (SEMANTIC_EXPANDED): tutto il resto (RDATE, TZID diversi da Roma,
 *    floating in un calendario non di Roma, override orfani, regole espanse
 *    diversamente, all-day con override timed, override su un evento singolo,
 *    all-day bloccanti della decisione 6, oggetti illeggibili) diventa una
 *    riga singola `caldes_derived = true` per ogni occorrenza non annullata di
 *    cal_occurrences, con id uuidv5 deterministico; l'orizzonte coperto si
 *    registra in cal_migration_reverse_state.horizon_until;
 *  - id: master = cal_object_ids (legacy_event_id dove esiste, cioè l'UUID
 *    legacy dei migrati), override = id della loro recurrence_key, derivate =
 *    uuidv5(`<object_id>|<recurrence_key>`) in CALDES_REVERSE_NAMESPACE;
 *  - UID (calendar_events.uid è UNIQUE): legacy_uid, poi l'UID della riga che
 *    esiste già con quell'id, poi l'UID iCalendar se è libero, altrimenti
 *    `<UID>@<collection_name>` (SANITIZED_UID); override e derivate
 *    `<UID>#<recurrence_key>` (un override riusa l'UID legacy della propria
 *    riga, se c'è);
 *  - sanificazione: SUMMARY vuoto → '(senza titolo)', durata nulla → +1 minuto
 *    (timed) o +1 giorno (all-day), STATUS fuori dai tre valori → 'tentative'
 *    (non blocca, come in Radicale), TRANSP:TRANSPARENT su un timed →
 *    'tentative' (SEMANTIC_TRANSP: busy identico);
 *  - rappresentazione persa (resta nel volume): VALARM, ATTENDEE/ORGANIZER,
 *    X-* (tranne X-CALDES-*), CATEGORIES, CLASS, PRIORITY, GEO, ATTACH,
 *    CONFERENCE e simili, TZID dei singoli fuori da Roma;
 *  - proiezioni delle prenotazioni (`booking-<uid>.ics` della collezione
 *    Prenotazioni): mai il contenuto della risorsa, ma la riga legacy legata
 *    (source booking + uid) con orari e stato da calendar_bookings; la risorsa
 *    sparita, o la prenotazione annullata o riprogrammata, porta la riga a
 *    'cancelled' (mai cancellata: l'id resta valido); una prenotazione della
 *    finestra senza riga la crea con il testo di createLegacyProjection
 *    (booking.ts);
 *  - cancellazioni: risorsa sparita → DELETE delle sole righe possedute
 *    (caldes_object_id o righe registrate nello stato); le righe legacy mai
 *    possedute restano congelate.
 *
 * Ogni degrado si registra per risorsa con la sua classe (DEGRADATION_CLASSES)
 * senza dati personali. Un upsert che fallisce comunque diventa REVERSE_FAILED
 * nello stato della risorsa, visibile nella salute e nell'anteprima del
 * rollback: mai un'eccezione propagata al job per un caso limite dei dati.
 *
 * Quando gira (§4.1): passata completa sincrona nel passo reverse_start del
 * cutover e reverse_final del rollback (il run tiene cal-migration); job
 * `reverse_projection` per collezione, accodato dal NOTIFY
 * calendar_index_changed con debounce di 2 s e dal giro di backstop ogni 15
 * minuti, solo in mode radicale con la finestra aperta. Il job prende
 * cal-migration con un solo tentativo (occupato da un run → errore d'attesa)
 * e non usa il gate cal-write né il pool calendario: scrive solo PG.
 *
 * Determinismo: computeReversePlan non scrive nulla e, a parità di indice e di
 * prenotazioni, produce lo stesso piano e lo stesso hash (reversePlanHash),
 * che l'anteprima del rollback conferma e il passo reverse_final ricontrolla.
 */

import {
  bookingProjectionUid,
  type CalendarObject,
  type CalendarRole,
  componentRecurrenceKey,
  deriveProvenance,
  expandObject,
  findOrphanOverrides,
  getProperties,
  getProperty,
  getSubcomponents,
  type IcsComponent,
  type IcsTime,
  ianaName,
  LEGACY_SERIES_TZ,
  masterTypeOf,
  parseCalendarObject,
  parseObjectHref,
  readEvent,
  readOverrides,
  readTimeProperty,
  resolveZone,
  toLegacyEventFields,
  UNTITLED_SUMMARY,
  type ZoneContext,
} from '@calicchia/calendar-core';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { projectionDescription } from '../adapters';
import { getEventType } from '../availability';
import { readBackendStateCached } from '../backend-mode';
import { CalendarUnavailableError } from '../errors';
import { CAL_CHANNELS } from '../index-model';
import {
  CAL_JOB_KINDS,
  CAL_JOB_PRIORITY,
  type CalendarJob,
  type CalendarJobContext,
  type CalendarJobOutcome,
  CalendarJobPermanentError,
  enqueueCalendarJob,
  registerCalendarJobHandler,
} from '../jobs';
import { expandRRule } from '../legacy/rrule-legacy';
import { resolveLocationForBooking } from '../meeting-url';
import { PROJECTED_BOOKING_STATUSES } from '../radicale/booking-projection';
import { uuidV5 } from '../radicale/ids';
import { pgText, safeTimezone } from '../radicale/index-worker';
import type { Db } from '../radicale/policy';
import type { Booking, BookingStatus, BusyRange, CalendarEventSource, CalendarEventStatus } from '../types';
import { readMigrationStateFresh } from './preflight';
import type * as RunsModule from './runs';
import {
  DEGRADATION_CLASSES,
  type DegradationClass,
  type DegradationRecord,
  isMigrationError,
  type MigrationBackendState,
  REVERSE_STATE_STATUSES,
  REVERSE_SYNC_GUC,
  type ReverseApplySummary,
  type ReverseProjectionHealthView,
  type ReverseRowRef,
  type ReverseStateStatus,
} from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-reverse-projection' });

// ─── Costanti ───────────────────────────────

/** Tipo del job della proiezione inversa (chiave = calendar_id). */
export const REVERSE_PROJECTION_JOB_KIND = CAL_JOB_KINDS.reverseProjection;

/**
 * Namespace degli id delle righe derivate (uuidv5 di `<object_id>|<recurrence_key>`).
 * Congelato: cambiarlo cambierebbe gli id delle righe già proiettate.
 */
export const CALDES_REVERSE_NAMESPACE = '0b6e3c1d-7f2a-4e58-9a63-2d4c8b1f5e07';

/** Attore della proiezione inversa nei log e nei riassunti dei job. */
export const REVERSE_ACTOR = 'system:reverse-projection';

/** Lease del job: una collezione intera, con l'espansione legacy delle serie. */
export const REVERSE_JOB_LEASE_MS = 10 * 60_000;

/** Debounce del NOTIFY calendar_index_changed (contratto §4.1) e attesa massima di una raffica. */
export const REVERSE_TRIGGER_DEBOUNCE_MS = 2_000;
export const REVERSE_TRIGGER_MAX_WAIT_MS = 10_000;

/** recurrence_key del blocco conservativo di un oggetto in quarantena (cal_occurrences). */
const CONSERVATIVE_KEY = 'conservative';

/** Fuso in cui il codice legacy espande le serie (expandRRule senza timezone). */
const ROME = LEGACY_SERIES_TZ;
const ROME_IANA = ianaName(ROME) ?? ROME;

/** Tetto delle occorrenze dell'espansione legacy nel confronto (expandRRule ne taglia 500 di default). */
const LEGACY_EXPAND_LIMIT = 200_000;

/** Risorse per transazione dell'apply (un SAVEPOINT per risorsa). */
const APPLY_BATCH = 50;

/** Righe e id per query (ANY di un array). */
const QUERY_CHUNK = 1_000;

/** Margine sul cutover delle proiezioni ritirate da riallineare (delta del cutover, prenotazioni annullate a cavallo del freeze). */
const RETIRED_BOOKING_MARGIN_MS = 86_400_000;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Proprietà dei componenti senza colonna legacy (REPR_LOSS_PROPERTY), oltre alle X-* diverse da X-CALDES-*. */
const LOST_PROPERTIES: ReadonlySet<string> = new Set([
  'CATEGORIES', 'CLASS', 'PRIORITY', 'GEO', 'ATTACH', 'CONFERENCE', 'COLOR', 'COMMENT', 'CONTACT', 'RESOURCES', 'RELATED-TO', 'IMAGE',
]);

/** Ordine delle classi nei degradi (ordinamento deterministico dei record). */
const CLASS_ORDER: ReadonlyMap<string, number> = new Map(DEGRADATION_CLASSES.map((c, i) => [c, i]));

// ─── Tipi del contratto (§4.4) ───────────────────────────────

/** Riga di calendar_events come la scrive il proiettore (colonne legacy più caldes_*). */
export interface LegacyReverseRow {
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
  source: string;
  source_id: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  caldes_object_id: string;
  caldes_derived: boolean;
}

export interface ReverseObjectPlan {
  object_id: string;
  calendar_id: string;
  collection_name: string;
  href: string;
  source_etag: string | null;
  source_sha256: string | null;
  status: ReverseStateStatus;
  rows: Array<ReverseRowRef & { row: LegacyReverseRow }>;
  degradations: DegradationRecord[];
  /** Righe possedute da cancellare (risorsa sparita, derivate in eccesso). */
  delete_row_ids: string[];
  error: { code: 'REVERSE_FAILED'; message: string } | null;
  unchanged: boolean;
  /** Fine dell'orizzonte delle righe derivate (ISO), null senza righe derivate. Aggiunta compatibile al contratto. */
  horizon_until?: string | null;
}

export interface ReversePlan {
  generated_at: string;
  horizon: { from: string; to: string };
  objects: ReverseObjectPlan[];
  hash: string;
  summary: ReverseApplySummary;
}

/**
 * Dati della prenotazione di una proiezione `booking-<uid>.ics` (gli stessi
 * di buildBookingProjectionIcs, più quelli che servono alla riga legacy):
 * prenotazione letta adesso (null se sparita), titolo del tipo e link della
 * riunione per una riga nuova, riga legacy legata se esiste.
 */
export interface BookingProjectionInput {
  booking: Pick<
    Booking,
    'uid' | 'status' | 'start_time' | 'end_time' | 'attendee_name' | 'attendee_email' | 'attendee_phone' | 'attendee_company' | 'attendee_message' | 'location_value'
  > | null;
  /** Titolo del tipo di prenotazione (null se il tipo non c'è più). */
  eventTitle: string | null;
  /** Link della riunione (resolveLocationForBooking), come createLegacyProjection. */
  meetingUrl: string | null;
  /** Riga legacy legata (source='booking', source_id=uid): il suo testo resta, cambiano orari e stato. */
  legacyRow: Pick<LegacyReverseRow, 'id' | 'uid' | 'summary' | 'description' | 'location' | 'url' | 'start_time' | 'end_time'> | null;
}

/** Occorrenza dell'indice (cal_occurrences) passata a projectObject. */
export interface ReverseOccurrenceInput {
  recurrence_key: string;
  start_utc: string;
  end_utc: string;
  all_day: boolean;
  status: string;
  transp: string | null;
  /** Regola `blocks` dell'indicizzatore; se assente si ricalcola da stato, TRANSP e all-day. */
  blocks?: boolean;
}

export interface ProjectObjectInput {
  object: { id: string; calendar_id: string; collection_name: string; href: string; etag: string | null; raw_ics: string; content_sha256: string | null };
  calendar: { id: string; collection_name: string; role: CalendarRole; timezone: string };
  ids: { master: { id: string; legacy_uid: string | null }; byRecurrenceKey: ReadonlyMap<string, string> };
  occurrences: ReadonlyArray<ReverseOccurrenceInput>;
  usedUids: ReadonlySet<string>;
  booking: BookingProjectionInput | null;
  horizon: { from: Date; to: Date };
  /** UID delle righe che esistono già con gli id del piano (riuso degli UID legacy). Aggiunta compatibile al contratto. */
  existingUids?: ReadonlyMap<string, string>;
}

// ─── Errori ───────────────────────────────

/**
 * Lock cal-migration tenuto da un run: errore d'attesa (il job torna in coda
 * senza consumare tentativi, contratto §4.1).
 */
export class ReverseLockBusyError extends CalendarUnavailableError {
  constructor(options?: { cause?: unknown }) {
    super('transition', 'run di migrazione in corso: proiezione inversa rimandata', options);
    this.name = 'ReverseLockBusyError';
  }
}

/** Errore dei dati di una risorsa: diventa REVERSE_FAILED (mai propagato). */
class ReverseObjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReverseObjectError';
  }
}

// ─── Utilità ───────────────────────────────

function isoOf(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) throw new ReverseObjectError('istante non valido');
  return d.toISOString();
}

function msOf(value: string | Date): number {
  return (value instanceof Date ? value : new Date(value)).getTime();
}

function textOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = pgText(value);
  return v.trim() === '' ? null : v;
}

/** JSON canonico (chiavi ordinate, nessuno spazio): base degli hash. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function uniqueSortedIso(values: readonly string[]): string[] {
  const seen = new Map<number, string>();
  for (const v of values) {
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) continue;
    const sec = Math.floor(ms / 1000);
    if (!seen.has(sec)) seen.set(sec, new Date(ms).toISOString());
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

function derivedRowId(objectId: string, recurrenceKey: string): string {
  return uuidV5(`${objectId.toLowerCase()}|${recurrenceKey}`, CALDES_REVERSE_NAMESPACE);
}

function chunks<T>(list: readonly T[], size = QUERY_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Messaggio d'errore di un upsert senza dati personali: SQLSTATE e nome del vincolo, mai i valori. */
function sanitizedDbError(err: unknown): { message: string; detail: Record<string, unknown> } {
  const e = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown; name?: unknown } | null;
  const code = typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  const constraintRaw = typeof e?.constraint_name === 'string' ? e.constraint_name : typeof e?.constraint === 'string' ? e.constraint : null;
  const constraint = constraintRaw && /^[a-z0-9_]{1,63}$/i.test(constraintRaw) ? constraintRaw : null;
  if (err instanceof ReverseObjectError) return { message: err.message.slice(0, 300), detail: { kind: 'data' } };
  if (code) {
    return {
      message: `Scrittura di calendar_events non riuscita (SQLSTATE ${code}${constraint ? `, vincolo ${constraint}` : ''})`,
      detail: { sqlstate: code, ...(constraint ? { constraint } : {}) },
    };
  }
  return { message: 'Errore interno della proiezione inversa: dettagli nei log del server', detail: { kind: 'internal' } };
}

// ─── Degradi ───────────────────────────────

class DegradationCollector {
  private readonly records = new Map<string, DegradationRecord>();

  add(cls: DegradationClass, recurrenceKey: string | null, detail?: Record<string, unknown>): void {
    const key = `${cls}|${recurrenceKey ?? ''}`;
    const prev = this.records.get(key);
    if (prev) {
      if (detail) prev.detail = mergeDetail(prev.detail ?? {}, detail);
      return;
    }
    const rec: DegradationRecord = { class: cls, recurrence_key: recurrenceKey };
    if (detail && Object.keys(detail).length > 0) rec.detail = detail;
    this.records.set(key, rec);
  }

  list(): DegradationRecord[] {
    return [...this.records.values()].sort(compareDegradations);
  }
}

function mergeDetail(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (Array.isArray(prev) && Array.isArray(v)) out[k] = [...new Set([...prev, ...v].map(String))].sort();
    else if (typeof prev === 'number' && typeof v === 'number') out[k] = prev + v;
    else out[k] = v;
  }
  return out;
}

function compareDegradations(a: DegradationRecord, b: DegradationRecord): number {
  const ca = CLASS_ORDER.get(a.class) ?? 99;
  const cb = CLASS_ORDER.get(b.class) ?? 99;
  if (ca !== cb) return ca - cb;
  return (a.recurrence_key ?? '').localeCompare(b.recurrence_key ?? '');
}

/** Degradi dello stato salvato (jsonb) normalizzati per il confronto. */
function normalizeDegradations(raw: unknown): DegradationRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: DegradationRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.class !== 'string' || !CLASS_ORDER.has(r.class)) continue;
    const rec: DegradationRecord = { class: r.class as DegradationClass, recurrence_key: typeof r.recurrence_key === 'string' ? r.recurrence_key : null };
    if (r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail)) rec.detail = r.detail as Record<string, unknown>;
    out.push(rec);
  }
  return out.sort(compareDegradations);
}

/** Classi dei degradi della rappresentazione per un componente (VALARM, ATTENDEE, proprietà). */
function representationLosses(c: IcsComponent, recurrenceKey: string, out: DegradationCollector): void {
  const alarms = getSubcomponents(c, 'VALARM').length;
  if (alarms > 0) out.add('REPR_LOSS_VALARM', recurrenceKey, { alarms });
  const attendees = getProperties(c, 'ATTENDEE').length;
  const organizer = getProperty(c, 'ORGANIZER') !== null;
  if (attendees > 0 || organizer) out.add('REPR_LOSS_ATTENDEE', recurrenceKey, { attendees, organizer });
  const lost = new Set<string>();
  for (const p of c.properties) {
    const name = p.name.toUpperCase();
    if (LOST_PROPERTIES.has(name)) lost.add(name);
    else if (name.startsWith('X-') && !name.startsWith('X-CALDES-')) lost.add(name.slice(0, 64));
  }
  if (lost.size > 0) out.add('REPR_LOSS_PROPERTY', recurrenceKey, { properties: [...lost].sort() });
}

// ─── Stato legacy di un componente ───────────────────────────────

type LegacyStatus = CalendarEventStatus;

/**
 * STATUS e TRANSP → stato legacy con lo stesso effetto sul busy di Radicale
 * (computeBlocks): CANCELLED e TENTATIVE invariati; un valore non standard non
 * blocca in Radicale → 'tentative' (SANITIZED_STATUS); un timed confermato
 * TRANSPARENT non blocca → 'tentative' (SEMANTIC_TRANSP).
 */
function legacyStatusFor(
  view: { status: string | null; transp: string | null },
  allDay: boolean,
  recurrenceKey: string,
  degr: DegradationCollector,
): LegacyStatus {
  const status = (view.status ?? 'CONFIRMED').trim().toUpperCase();
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'TENTATIVE') return 'tentative';
  if (status !== 'CONFIRMED') {
    degr.add('SANITIZED_STATUS', recurrenceKey, { status: [status.slice(0, 32)] });
    return 'tentative';
  }
  if (!allDay && (view.transp ?? '').trim().toUpperCase() === 'TRANSPARENT') {
    degr.add('SEMANTIC_TRANSP', recurrenceKey);
    return 'tentative';
  }
  return 'confirmed';
}

/**
 * Durata nulla (DTEND assente o non successivo): fine valida per il CHECK
 * legacy (start < end), +1 minuto timed o +1 giorno all-day
 * (SANITIZED_DURATION). In Radicale un timed a durata nulla non blocca mai
 * (span vuoto): la riga legacy allungata diventa 'tentative', così il busy
 * dopo il rollback resta quello di Radicale (detail.non_blocking).
 */
function sanitizeDuration(row: LegacyReverseRow, recurrenceKey: string, degr: DegradationCollector): LegacyReverseRow {
  const start = msOf(row.start_time);
  const end = msOf(row.end_time);
  if (end > start) return row;
  const out: LegacyReverseRow = { ...row, end_time: new Date(start + (row.all_day ? DAY_MS : MINUTE_MS)).toISOString() };
  const detail: Record<string, unknown> = { rows: 1 };
  if (!row.all_day && row.status === 'confirmed') {
    out.status = 'tentative';
    detail.non_blocking = 1;
  }
  degr.add('SANITIZED_DURATION', recurrenceKey, detail);
  return out;
}

// ─── Simulazione del busy legacy ───────────────────────────────

/** Occorrenza come la produce listOccurrences di legacy/events-pg.ts. */
export interface LegacySimulatedOccurrence {
  row_id: string;
  start: string;
  end: string;
  all_day: boolean;
  status: LegacyStatus;
  is_override: boolean;
}

/**
 * Espansione legacy di un insieme di righe di calendar_events nella finestra
 * [from, to), con la stessa logica di listOccurrences (legacy/events-pg.ts) e
 * la stessa espansione delle serie (expandRRule, ora da muro di Europe/Rome):
 * singoli sovrapposti, occorrenze dei master che iniziano nella finestra meno
 * quelle sostituite da un override (stesso secondo del recurrence_id, anche
 * se annullato), override sovrapposti. Con `includeCancelled` false le righe
 * annullate non si emettono (ma gli override annullati sopprimono comunque).
 * Pura: serve al confronto della mappatura, all'anteprima del rollback e ai test.
 */
export function simulateLegacyOccurrences(
  rows: ReadonlyArray<Pick<LegacyReverseRow, 'id' | 'start_time' | 'end_time' | 'all_day' | 'rrule' | 'exdates' | 'recurrence_id' | 'recurrence_master_id' | 'status'>>,
  fromMs: number,
  toMs: number,
  opts: { includeCancelled?: boolean } = {},
): LegacySimulatedOccurrence[] {
  const includeCancelled = opts.includeCancelled !== false;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const secKey = (masterId: string, value: string): string => `${masterId}|${Math.floor(msOf(value) / 1000)}`;
  const overrides = rows.filter((r) => r.recurrence_master_id !== null);
  const singletons = rows.filter((r) => r.recurrence_master_id === null && !r.rrule && (includeCancelled || r.status !== 'cancelled'));
  const masters = rows.filter((r) => r.recurrence_master_id === null && r.rrule && (includeCancelled || r.status !== 'cancelled'));
  const overridden = new Set<string>();
  for (const ov of overrides) {
    if (ov.recurrence_master_id && ov.recurrence_id) overridden.add(secKey(ov.recurrence_master_id, ov.recurrence_id));
  }
  const overlaps = (r: { start_time: string; end_time: string }): boolean => msOf(r.start_time) < toMs && msOf(r.end_time) > fromMs;
  const out: LegacySimulatedOccurrence[] = [];
  for (const s of singletons) {
    if (overlaps(s)) out.push({ row_id: s.id, start: isoOf(s.start_time), end: isoOf(s.end_time), all_day: s.all_day, status: s.status, is_override: false });
  }
  for (const m of masters) {
    const duration = msOf(m.end_time) - msOf(m.start_time);
    const starts = expandRRule({
      rrule: m.rrule as string,
      masterStartIso: isoOf(m.start_time),
      fromIso,
      toIso,
      exdates: m.exdates,
      limit: LEGACY_EXPAND_LIMIT,
    });
    for (const startIso of starts) {
      if (overridden.has(secKey(m.id, startIso))) continue;
      out.push({
        row_id: m.id,
        start: startIso,
        end: new Date(msOf(startIso) + duration).toISOString(),
        all_day: m.all_day,
        status: m.status,
        is_override: false,
      });
    }
  }
  for (const ov of overrides) {
    if (!includeCancelled && ov.status === 'cancelled') continue;
    if (overlaps(ov)) out.push({ row_id: ov.id, start: isoOf(ov.start_time), end: isoOf(ov.end_time), all_day: ov.all_day, status: ov.status, is_override: true });
  }
  out.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.row_id.localeCompare(b.row_id));
  return out;
}

/** Busy legacy (getBusyRanges di events-pg: occorrenze confermate e timed) di un insieme di righe. */
export function legacyBusyFromRows(
  rows: Parameters<typeof simulateLegacyOccurrences>[0],
  fromIso: string,
  toIso: string,
): BusyRange[] {
  const occ = simulateLegacyOccurrences(rows, msOf(fromIso), msOf(toIso), { includeCancelled: false });
  const seen = new Set<string>();
  const out: BusyRange[] = [];
  for (const o of occ) {
    if (o.status !== 'confirmed' || o.all_day) continue;
    const key = `${o.start}|${o.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start: o.start, end: o.end });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

/** Chiave di confronto di un'occorrenza: inizio, fine (giorni per gli all-day) e "blocca". */
function compareKey(startMs: number, endMs: number, allDay: boolean, blocks: boolean): string {
  const s = Math.floor(startMs / 1000);
  if (allDay) return `${s}|D${Math.max(1, Math.round((endMs - startMs) / DAY_MS))}|${blocks ? 1 : 0}`;
  let e = Math.floor(endMs / 1000);
  if (e <= s) e = s + 60;
  return `${s}|T${e}|${blocks ? 1 : 0}`;
}

/** Contributo al busy di un'occorrenza dell'indice: regola `blocks` e intervallo non vuoto (span [start, end)). */
function indexBlocks(o: ReverseOccurrenceInput): boolean {
  if (!(msOf(o.end_utc) > msOf(o.start_utc))) return false;
  if (typeof o.blocks === 'boolean') return o.blocks;
  return o.status === 'confirmed' && (o.transp ?? '').toUpperCase() !== 'TRANSPARENT' && !o.all_day;
}

/**
 * true se le righe legacy producono, istanza per istanza, le stesse
 * occorrenze non annullate dell'indice fra `from` e `to` (inizio nella
 * finestra; gli estremi dell'espansione legacy e dell'indice differiscono
 * per le occorrenze iniziate prima di `from`).
 */
function legacyMatchesIndex(rows: readonly LegacyReverseRow[], occurrences: readonly ReverseOccurrenceInput[], from: number, to: number): boolean {
  if (!(to > from)) return true;
  const expected: string[] = [];
  for (const o of occurrences) {
    const s = msOf(o.start_utc);
    if (o.status === 'cancelled' || !(s >= from && s < to)) continue;
    expected.push(compareKey(s, msOf(o.end_utc), o.all_day, indexBlocks(o)));
  }
  const actual: string[] = [];
  for (const o of simulateLegacyOccurrences(rows, from, to, { includeCancelled: true })) {
    const s = msOf(o.start);
    if (o.status === 'cancelled' || !(s >= from && s < to)) continue;
    actual.push(compareKey(s, msOf(o.end), o.all_day, o.status === 'confirmed' && !o.all_day));
  }
  if (expected.length !== actual.length) return false;
  expected.sort();
  actual.sort();
  return expected.every((k, i) => k === actual[i]);
}

// ─── UID ───────────────────────────────

/** Assegnazione degli UID di una risorsa contro quelli già usati (globali e della risorsa stessa). */
class UidAllocator {
  private readonly local = new Set<string>();

  constructor(private readonly used: ReadonlySet<string>) {}

  free(uid: string): boolean {
    return uid !== '' && !this.used.has(uid) && !this.local.has(uid);
  }

  take(uid: string): string {
    this.local.add(uid);
    return uid;
  }

  assigned(): string[] {
    return [...this.local];
  }
}

// ─── projectObject ───────────────────────────────

interface PlanBase {
  object_id: string;
  calendar_id: string;
  collection_name: string;
  href: string;
  source_etag: string | null;
  source_sha256: string | null;
}

function failedPlan(base: PlanBase, message: string): ReverseObjectPlan {
  return {
    ...base,
    status: 'failed',
    rows: [],
    degradations: [{ class: 'REVERSE_FAILED', recurrence_key: null, detail: { kind: 'data' } }],
    delete_row_ids: [],
    error: { code: 'REVERSE_FAILED', message: message.slice(0, 300) },
    unchanged: false,
    horizon_until: null,
  };
}

function finishPlan(base: PlanBase, rows: ReverseObjectPlan['rows'], degr: DegradationCollector, horizonUntil: string | null): ReverseObjectPlan {
  const degradations = degr.list();
  return {
    ...base,
    status: degradations.length > 0 ? 'degraded' : 'projected',
    rows: [...rows].sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.recurrence_key.localeCompare(b.recurrence_key) || a.id.localeCompare(b.id)),
    degradations,
    delete_row_ids: [],
    error: null,
    unchanged: false,
    horizon_until: horizonUntil,
  };
}

function roleOrder(role: ReverseRowRef['role']): number {
  return role === 'master' || role === 'projection' ? 0 : role === 'override' ? 1 : 2;
}

/**
 * Risorsa indicizzata → righe legacy e degradi (testa del file). Pura e
 * deterministica: non legge il database né l'orologio. Un errore dei dati
 * diventa un piano 'failed' (REVERSE_FAILED), mai un'eccezione.
 */
export function projectObject(input: ProjectObjectInput): ReverseObjectPlan {
  const base: PlanBase = {
    object_id: input.object.id.toLowerCase(),
    calendar_id: input.calendar.id.toLowerCase(),
    collection_name: input.calendar.collection_name,
    href: input.object.href,
    source_etag: input.object.etag,
    source_sha256: input.object.content_sha256 && SHA256_RE.test(input.object.content_sha256) ? input.object.content_sha256 : null,
  };
  try {
    const hrefInfo = parseObjectHref(input.object.href);
    if (input.calendar.role === 'bookings' && hrefInfo.kind === 'booking') {
      return projectBooking(input, base, hrefInfo.bookingUid as string, true);
    }
    return projectEvent(input, base);
  } catch (err) {
    const msg = err instanceof ReverseObjectError ? err.message : `risorsa non proiettabile: ${err instanceof Error ? err.name : 'errore'}`;
    return failedPlan(base, msg);
  }
}

/**
 * Proiezione di una prenotazione (§4.2): riga legacy legata con orari e stato
 * da calendar_bookings; testo della riga esistente, o di createLegacyProjection
 * per una prenotazione della finestra. `resourcePresent` false: la risorsa non
 * c'è più in Radicale (prenotazione annullata o riprogrammata) → 'cancelled'.
 */
function projectBooking(input: Pick<ProjectObjectInput, 'calendar' | 'ids' | 'usedUids' | 'booking' | 'object'>, base: PlanBase, bookingUid: string, resourcePresent: boolean): ReverseObjectPlan {
  const degr = new DegradationCollector();
  const info = input.booking ?? { booking: null, eventTitle: null, meetingUrl: null, legacyRow: null };
  const b = info.booking;
  const active = resourcePresent && b !== null && PROJECTED_BOOKING_STATUSES.has(b.status as BookingStatus);
  const legacy = info.legacyRow;
  if (!legacy && !active) return finishPlan(base, [], degr, null);

  const uids = new UidAllocator(input.usedUids);
  let uid: string;
  if (legacy) {
    uid = legacy.uid;
  } else {
    const preferred = bookingProjectionUid(bookingUid);
    if (uids.free(preferred)) uid = uids.take(preferred);
    else {
      const sanitized = `${preferred}@${input.calendar.collection_name}`;
      if (!uids.free(sanitized)) throw new ReverseObjectError('UID della proiezione già usato anche nella forma sanificata');
      degr.add('SANITIZED_UID', '', { reason: 'duplicate' });
      uid = uids.take(sanitized);
    }
  }
  const startIso = isoOf(b ? b.start_time : (legacy as NonNullable<typeof legacy>).start_time);
  const rawEnd = isoOf(b ? b.end_time : (legacy as NonNullable<typeof legacy>).end_time);
  const row: LegacyReverseRow = {
    id: (legacy?.id ?? input.ids.master.id).toLowerCase(),
    calendar_id: base.calendar_id,
    uid: pgText(uid),
    summary: legacy ? legacy.summary : pgText(`${info.eventTitle ?? 'Prenotazione'} – ${b?.attendee_name ?? ''}`.trim()),
    description: legacy ? legacy.description : b ? textOrNull(projectionDescription({
      uid: b.uid,
      attendee_name: b.attendee_name,
      attendee_email: b.attendee_email,
      attendee_phone: b.attendee_phone,
      attendee_company: b.attendee_company,
      attendee_message: b.attendee_message,
    })) : null,
    location: legacy ? legacy.location : textOrNull(b?.location_value ?? null),
    url: legacy ? legacy.url : textOrNull(info.meetingUrl),
    start_time: startIso,
    end_time: rawEnd,
    all_day: false,
    rrule: null,
    exdates: [],
    recurrence_id: null,
    recurrence_master_id: null,
    source: 'booking',
    source_id: bookingUid,
    status: active ? 'confirmed' : 'cancelled',
    caldes_object_id: base.object_id,
    caldes_derived: false,
  };
  const fixed = sanitizeDuration(row, '', degr);
  return finishPlan(base, [{ id: fixed.id, recurrence_key: '', role: 'projection', row: fixed }], degr, null);
}

interface ComponentFields {
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  status: string | null;
  transp: string | null;
}

/** Testo e stato di un componente (SUMMARY assente → '(senza titolo)', SANITIZED_SUMMARY). */
function componentFields(c: IcsComponent | null, recurrenceKey: string, degr: DegradationCollector): ComponentFields {
  if (!c) {
    degr.add('SANITIZED_SUMMARY', recurrenceKey);
    return { summary: UNTITLED_SUMMARY, description: null, location: null, url: null, status: null, transp: null };
  }
  let view: ReturnType<typeof readEvent> | null = null;
  try {
    view = readEvent(c);
  } catch {
    view = null;
  }
  const summaryRaw = view?.summary ?? null;
  const summary = summaryRaw !== null && summaryRaw.trim() !== '' ? pgText(summaryRaw) : null;
  if (summary === null) degr.add('SANITIZED_SUMMARY', recurrenceKey);
  return {
    summary: summary ?? UNTITLED_SUMMARY,
    description: textOrNull(view?.description ?? null),
    location: textOrNull(view?.location ?? null),
    url: textOrNull(view?.url ? view.url.replace(/[\r\n]+/g, '') : null),
    status: view?.status ?? null,
    transp: view?.transp ?? null,
  };
}

/** DTSTART di una serie in un fuso che il legacy espande allo stesso modo (all-day, UTC, Europe/Rome). */
function seriesZoneSupported(start: IcsTime, zctx: ZoneContext): boolean {
  if (start.type === 'date') return true;
  if (start.zone.kind === 'utc') return true;
  try {
    const { zone } = resolveZone(start.zone, { tz: zctx.tz, timezones: zctx.timezones });
    if (zone.kind === 'utc') return true;
    return zone.kind === 'iana' && (ianaName(zone.iana) ?? zone.iana) === ROME_IANA;
  } catch {
    return false;
  }
}

/** TZID di un evento singolo diverso da Roma e da UTC (rappresentazione persa: il legacy salva gli istanti). */
function singleZoneLost(start: IcsTime, zctx: ZoneContext): boolean {
  if (start.type === 'date' || start.zone.kind !== 'tzid') return false;
  return !seriesZoneSupported(start, zctx);
}

function projectEvent(input: ProjectObjectInput, base: PlanBase): ReverseObjectPlan {
  const degr = new DegradationCollector();
  const parsed = parseCalendarObject(input.object.raw_ics);
  if (!parsed.ok) return projectUnreadable(input, base, degr, 'unreadable');
  const obj = parsed.value;
  if (obj.componentType !== 'VEVENT') {
    // VTODO/VJOURNAL: nessuna colonna legacy; restano nel volume.
    degr.add('REPR_LOSS_PROPERTY', null, { component: obj.componentType });
    return finishPlan(base, [], degr, null);
  }
  const tz = safeTimezone(input.calendar.timezone);
  const zctx: ZoneContext = { tz, timezones: obj.timezones };
  const keyOf = (c: IcsComponent): string => {
    try {
      return componentRecurrenceKey(c, zctx);
    } catch {
      return 'invalid';
    }
  };
  if (obj.master) representationLosses(obj.master, '', degr);
  for (const ov of obj.overrides) representationLosses(ov, keyOf(ov), degr);

  const prov = deriveProvenance({ role: input.calendar.role, href: input.object.href, component: obj.master ?? obj.overrides[0] ?? null, uid: obj.uid });
  const reasons = new Set<string>();
  let masterView: ReturnType<typeof readEvent> | null = null;
  if (!obj.master) reasons.add('orphan_override');
  else {
    try {
      masterView = readEvent(obj.master);
    } catch {
      return projectUnreadable(input, base, degr, 'invalid_value', obj);
    }
  }

  // Override vincitori e orfani (stesso criterio dell'indicizzatore).
  const orphanCheck = findOrphanOverrides(obj, { tz, timezones: obj.timezones });
  const overrideSet = readOverrides(obj, masterTypeOf(obj), { tz, timezones: obj.timezones });
  const excluded = new Set([...orphanCheck.shadowed, ...orphanCheck.invalid]);
  if (orphanCheck.invalid.length > 0) degr.add('REPR_LOSS_PROPERTY', null, { properties: ['RECURRENCE-ID'] });
  const winners = overrideSet.winners.filter((i) => !excluded.has(i));
  if (orphanCheck.orphans.length > 0) reasons.add('orphan_override');
  if (orphanCheck.undetermined.length > 0) reasons.add('undetermined_override');

  if (masterView) {
    const isSeries = masterView.rrules.length > 0 || masterView.rdates.length > 0;
    if (masterView.rrules.length > 1) reasons.add('multiple_rrule');
    if (masterView.rdates.length > 0) reasons.add('rdate');
    if (!isSeries && winners.length > 0) reasons.add('override_on_single');
    const start = masterView.start as IcsTime;
    if (isSeries && !seriesZoneSupported(start, zctx)) reasons.add('timezone');
    if (!isSeries && singleZoneLost(start, zctx)) degr.add('REPR_LOSS_PROPERTY', '', { properties: ['TZID'] });
    for (const i of winners) {
      const p = getProperty(obj.overrides[i], 'DTSTART');
      try {
        const t = p ? readTimeProperty(p) : null;
        if (t && t.type !== start.type) reasons.add('allday_mismatch');
      } catch {
        reasons.add('allday_mismatch');
      }
    }
  }
  if (input.occurrences.some((o) => o.all_day && o.blocks === true)) reasons.add('allday_blocking');
  // Oggetto in quarantena (budget, regola invalida): l'indice ha il blocco conservativo, che solo le derivate rendono.
  if (input.occurrences.some((o) => o.recurrence_key === CONSERVATIVE_KEY)) reasons.add('quarantined');
  // Frequenze sotto l'ora: il legacy non le gestisce (e la sua espansione sull'orizzonte sarebbe enorme).
  const freq = masterView ? /(?:^|;)\s*FREQ=([A-Z]+)/i.exec(masterView.rrules[0] ?? '')?.[1]?.toUpperCase() : undefined;
  if (freq === 'SECONDLY' || freq === 'MINUTELY') reasons.add('frequency');

  const from = input.horizon.from.getTime();
  const to = input.horizon.to.getTime();
  const uids = new UidAllocator(input.usedUids);

  if (reasons.size === 0 && obj.master && masterView) {
    const rows = representableRows(input, base, obj, zctx, winners, prov, uids, degr);
    if (rows && legacyMatchesIndex(rows.map((r) => r.row), input.occurrences, from, to)) {
      return finishPlan(base, rows, degr, null);
    }
    reasons.add('rule_mismatch');
  }
  return derivedPlan(input, base, obj, zctx, prov, [...reasons], new DegradationCollectorView(degr));
}

/**
 * Collettore dei degradi della parte espansa: riparte dai degradi della
 * rappresentazione (VALARM, ATTENDEE, proprietà) e scarta quelli del
 * tentativo rappresentabile (UID, durata, stato degli override non più scritti).
 */
class DegradationCollectorView extends DegradationCollector {
  constructor(from: DegradationCollector) {
    super();
    for (const rec of from.list()) {
      if (rec.class === 'REPR_LOSS_VALARM' || rec.class === 'REPR_LOSS_ATTENDEE' || rec.class === 'REPR_LOSS_PROPERTY') {
        this.add(rec.class, rec.recurrence_key ?? null, rec.detail);
      }
    }
  }
}

/** Righe master e override di una risorsa rappresentabile, o null se un componente non si converte. */
function representableRows(
  input: ProjectObjectInput,
  base: PlanBase,
  obj: CalendarObject,
  zctx: ZoneContext,
  winners: readonly number[],
  prov: { source: CalendarEventSource; source_id: string | null },
  uids: UidAllocator,
  degr: DegradationCollector,
): ReverseObjectPlan['rows'] | null {
  const master = obj.master as IcsComponent;
  let mf: ReturnType<typeof toLegacyEventFields>;
  try {
    mf = toLegacyEventFields(master, { tz: zctx.tz, timezones: zctx.timezones });
  } catch {
    return null;
  }
  const masterId = input.ids.master.id.toLowerCase();
  const masterUid = resolveMasterUid(input, mf.uid, masterId, uids, degr);
  const masterFields = componentFields(master, '', degr);
  const masterRow: LegacyReverseRow = {
    id: masterId,
    calendar_id: base.calendar_id,
    uid: masterUid,
    summary: masterFields.summary,
    description: masterFields.description,
    location: masterFields.location,
    url: masterFields.url,
    start_time: isoOf(mf.start_time),
    end_time: isoOf(mf.end_time),
    all_day: mf.all_day,
    rrule: mf.rrule ? pgText(mf.rrule.trim().replace(/^RRULE:/i, '')) : null,
    exdates: uniqueSortedIso(mf.exdates),
    recurrence_id: null,
    recurrence_master_id: null,
    source: prov.source,
    source_id: prov.source_id ? pgText(prov.source_id) : null,
    status: legacyStatusFor(masterFields, mf.all_day, '', degr),
    caldes_object_id: base.object_id,
    caldes_derived: false,
  };
  const rows: ReverseObjectPlan['rows'] = [{ id: masterId, recurrence_key: '', role: 'master', row: sanitizeDuration(masterRow, '', degr) }];
  const masterDuration = msOf(mf.end_time) - msOf(mf.start_time);
  for (const index of winners) {
    const c = obj.overrides[index];
    let key: string;
    let of: ReturnType<typeof toLegacyEventFields>;
    try {
      key = componentRecurrenceKey(c, zctx);
      of = toLegacyEventFields(c, { tz: zctx.tz, timezones: zctx.timezones });
    } catch {
      return null;
    }
    if (!of.recurrence_id) return null;
    const id = (input.ids.byRecurrenceKey.get(key) ?? derivedRowId(base.object_id, key)).toLowerCase();
    const fields = componentFields(c, key, degr);
    // Override senza DTEND né DURATION: eredita la durata del master (calendar-core, RFC 5545).
    let endIso = of.end_time;
    if (!getProperty(c, 'DTEND') && !getProperty(c, 'DURATION') && masterDuration > 0) {
      endIso = new Date(msOf(of.start_time) + masterDuration).toISOString();
    }
    const existing = input.existingUids?.get(id) ?? null;
    let uid: string;
    if (existing && existing !== masterUid && uids.free(existing)) uid = uids.take(existing);
    else {
      const candidate = `${masterUid}#${key}`;
      if (!uids.free(candidate)) throw new ReverseObjectError(`UID dell'override ${key} già usato`);
      uid = uids.take(candidate);
      degr.add('SANITIZED_UID', key, { reason: 'override' });
    }
    rows.push({
      id,
      recurrence_key: key,
      role: 'override',
      row: sanitizeDuration({
        id,
        calendar_id: base.calendar_id,
        uid: pgText(uid),
        summary: fields.summary,
        description: fields.description,
        location: fields.location,
        url: fields.url,
        start_time: isoOf(of.start_time),
        end_time: isoOf(endIso),
        all_day: of.all_day,
        rrule: null,
        exdates: [],
        recurrence_id: isoOf(of.recurrence_id),
        recurrence_master_id: masterId,
        source: prov.source,
        source_id: prov.source_id ? pgText(prov.source_id) : null,
        status: legacyStatusFor(fields, of.all_day, key, degr),
        caldes_object_id: base.object_id,
        caldes_derived: false,
      }, key, degr),
    });
  }
  return rows;
}

/**
 * UID della riga master (§4.2): legacy_uid, poi l'UID della riga che esiste
 * già con quell'id, poi l'UID iCalendar se libero, poi `<UID>@<collezione>`
 * (SANITIZED_UID). Lancia ReverseObjectError se anche quello è usato.
 */
function resolveMasterUid(input: ProjectObjectInput, icalUid: string, rowId: string, uids: UidAllocator, degr: DegradationCollector): string {
  const preserved = [input.ids.master.legacy_uid, input.existingUids?.get(rowId) ?? null].filter((u): u is string => typeof u === 'string' && u !== '');
  const ical = pgText(icalUid);
  const sanitized = `${ical}@${input.calendar.collection_name}`;
  for (const u of preserved) {
    if (!uids.free(u)) continue;
    // Riga già proiettata con l'UID sanificato da una passata precedente: il degrado resta lo stesso a
    // ogni passata, così l'anteprima del rollback e la salute lo mostrano e lo stato non lo perde.
    if (u !== input.ids.master.legacy_uid && u === sanitized && u !== ical) degr.add('SANITIZED_UID', '', { reason: 'duplicate' });
    return uids.take(pgText(u));
  }
  if (uids.free(ical)) return uids.take(ical);
  if (!uids.free(sanitized)) throw new ReverseObjectError('UID già usato anche nella forma sanificata con il nome della collezione');
  degr.add('SANITIZED_UID', '', { reason: 'duplicate' });
  return uids.take(sanitized);
}

/** Base degli UID delle righe derivate (stesse regole del master, senza riga master). */
function derivedUidBase(input: ProjectObjectInput, icalUid: string | null, keys: readonly string[], uids: UidAllocator, degr: DegradationCollector): string {
  const preferred = [input.ids.master.legacy_uid, icalUid, input.object.href].filter((u): u is string => typeof u === 'string' && u !== '');
  const fits = (b: string): boolean => keys.every((k) => uids.free(k === '' ? b : `${b}#${k}`));
  const first = pgText(preferred[0]);
  if (fits(first)) return first;
  const sanitized = `${first}@${input.calendar.collection_name}`;
  if (fits(sanitized)) {
    degr.add('SANITIZED_UID', null, { reason: 'duplicate' });
    return sanitized;
  }
  throw new ReverseObjectError('UID delle righe derivate già usati anche nella forma sanificata');
}

/**
 * Righe derivate (SEMANTIC_EXPANDED): una per occorrenza non annullata
 * dell'indice sull'orizzonte materializzato, con il testo del componente che
 * la produce (override abbinato, orfano o master).
 */
function derivedPlan(
  input: ProjectObjectInput,
  base: PlanBase,
  obj: CalendarObject | null,
  zctx: ZoneContext,
  prov: { source: CalendarEventSource; source_id: string | null },
  reasons: string[],
  degr: DegradationCollector,
): ReverseObjectPlan {
  const to = input.horizon.to.getTime();
  // Componente di ogni recurrence_key: espansione di calendar-core sullo stesso orizzonte dell'indice.
  const sourceByKey = new Map<string, IcsComponent>();
  if (obj) {
    try {
      const exp = expandObject(obj, { from: input.horizon.from.getTime(), to, tz: zctx.tz });
      for (const occ of exp.occurrences) {
        const c = occ.source.type === 'override' ? obj.overrides[occ.source.index] : obj.master;
        if (c) sourceByKey.set(occ.recurrenceKey, c);
      }
    } catch {
      // Espansione non riuscita: il testo viene dal master (o '(senza titolo)').
    }
  }
  const occurrences = [...input.occurrences]
    .filter((o) => o.status !== 'cancelled' && msOf(o.start_utc) < to)
    .sort((a, b) => msOf(a.start_utc) - msOf(b.start_utc) || a.recurrence_key.localeCompare(b.recurrence_key));
  const seenKeys = new Set<string>();
  const unique = occurrences.filter((o) => (seenKeys.has(o.recurrence_key) ? false : (seenKeys.add(o.recurrence_key), true)));
  const uids = new UidAllocator(input.usedUids);
  const uidBase = derivedUidBase(input, obj?.uid ?? null, unique.map((o) => o.recurrence_key), uids, degr);
  const rows: ReverseObjectPlan['rows'] = [];
  for (const occ of unique) {
    const key = occ.recurrence_key;
    const comp = sourceByKey.get(key) ?? obj?.master ?? null;
    const compKey = comp ? (comp === obj?.master ? '' : safeKey(comp, zctx)) : key;
    const fields = componentFields(comp, compKey, degr);
    const allDayBlocking = occ.all_day && occ.blocks === true;
    const allDay = occ.all_day && !allDayBlocking;
    const startIso = isoOf(occ.start_utc);
    const statusView = comp ? fields : { status: occ.status.toUpperCase(), transp: occ.transp };
    const id = derivedRowId(base.object_id, key);
    const uid = uids.take(key === '' ? uidBase : `${uidBase}#${key}`);
    rows.push({
      id,
      recurrence_key: key,
      role: 'derived',
      row: sanitizeDuration({
        id,
        calendar_id: base.calendar_id,
        uid: pgText(uid),
        summary: fields.summary,
        description: fields.description,
        location: fields.location,
        url: fields.url,
        start_time: startIso,
        end_time: isoOf(occ.end_utc),
        all_day: allDay,
        rrule: null,
        exdates: [],
        recurrence_id: null,
        recurrence_master_id: null,
        source: prov.source,
        source_id: prov.source_id ? pgText(prov.source_id) : null,
        status: legacyStatusFor(statusView, allDay, compKey, degr),
        caldes_object_id: base.object_id,
        caldes_derived: true,
      }, compKey, degr),
    });
  }
  const horizonUntil = input.horizon.to.toISOString();
  degr.add('SEMANTIC_EXPANDED', null, { reasons: [...new Set(reasons)].sort(), rows: rows.length });
  return finishPlan(base, rows, degr, horizonUntil);
}

function safeKey(c: IcsComponent, zctx: ZoneContext): string {
  try {
    return componentRecurrenceKey(c, zctx);
  } catch {
    return 'invalid';
  }
}

/**
 * Risorsa che non si legge (testo non valido, DTSTART illeggibile): righe
 * derivate dalle occorrenze dell'indice (il blocco conservativo, o quelle
 * dell'ultima versione buona), così il busy legacy resta quello di Radicale.
 * Senza occorrenze non c'è nulla da proiettare: REVERSE_FAILED, visibile.
 */
function projectUnreadable(input: ProjectObjectInput, base: PlanBase, degr: DegradationCollector, reason: string, obj?: CalendarObject): ReverseObjectPlan {
  const live = input.occurrences.filter((o) => o.status !== 'cancelled');
  if (live.length === 0) return failedPlan(base, 'Risorsa illeggibile senza occorrenze nell\'indice: da correggere o rimuovere in Radicale');
  const prov = deriveProvenance({ role: input.calendar.role, href: input.object.href, component: obj?.master ?? null, uid: obj?.uid ?? null });
  const tz = safeTimezone(input.calendar.timezone);
  return derivedPlan(input, base, null, { tz, timezones: obj?.timezones ?? [] }, prov, [reason], new DegradationCollectorView(degr));
}

// ─── Hash del piano ───────────────────────────────

function canonicalRow(row: LegacyReverseRow): Record<string, unknown> {
  return {
    ...row,
    id: row.id.toLowerCase(),
    calendar_id: row.calendar_id.toLowerCase(),
    start_time: isoOf(row.start_time),
    end_time: isoOf(row.end_time),
    exdates: uniqueSortedIso(row.exdates),
    recurrence_id: row.recurrence_id ? isoOf(row.recurrence_id) : null,
    recurrence_master_id: row.recurrence_master_id ? row.recurrence_master_id.toLowerCase() : null,
    caldes_object_id: row.caldes_object_id.toLowerCase(),
  };
}

/**
 * sha256 del JSON canonico del piano (§4.4): per ogni oggetto lo stato finale
 * voluto (righe previste con il contenuto, degradi, REVERSE_FAILED), ordinati.
 * Esclude ciò che dipende dalla passata (unchanged, righe da cancellare, etag):
 * un'anteprima e la passata finale dello stesso volume hanno lo stesso hash
 * anche se nel frattempo un job ha già applicato le righe.
 */
export function reversePlanHash(plan: Pick<ReversePlan, 'objects'>): string {
  const objects = [...plan.objects]
    .sort((a, b) => a.object_id.localeCompare(b.object_id))
    .map((o) => ({
      object_id: o.object_id.toLowerCase(),
      calendar_id: o.calendar_id.toLowerCase(),
      href: o.href,
      status: o.status,
      rows: [...o.rows].sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({ id: r.id, recurrence_key: r.recurrence_key, role: r.role, row: canonicalRow(r.row) })),
      degradations: [...o.degradations].sort(compareDegradations).map((d) => ({ class: d.class, recurrence_key: d.recurrence_key ?? null, detail: d.detail ?? null })),
      error: o.error ? { code: o.error.code, message: o.error.message } : null,
    }));
  return sha256(canonical({ v: 1, objects }));
}

// ─── Lettura dal database ───────────────────────────────

interface CalendarScopeRow {
  id: string;
  collection_name: string;
  role: CalendarRole;
  timezone: string | null;
  blocks_availability: boolean;
  horizon_start: Date | null;
  horizon_end: Date | null;
}

interface ObjectRow {
  id: string;
  calendar_id: string;
  href: string;
  uid: string | null;
  etag: string | null;
  raw_ics: string | null;
  content_sha256: string | null;
  health: string;
  materialized_until: Date | null;
  first_seen_at: Date;
  good_raw: string | null;
  good_sha: string | null;
}

interface ObjectIdRow {
  id: string;
  calendar_id: string;
  href: string;
  recurrence_key: string;
  legacy_event_id: string | null;
  legacy_uid: string | null;
  retired_at: Date | null;
}

interface ReverseStateRow {
  object_id: string;
  calendar_id: string;
  href: string;
  source_etag: string | null;
  source_sha256: string | null;
  status: ReverseStateStatus;
  rows: unknown;
  degradations: unknown;
  error_code: string | null;
  error: string | null;
  attempts: number;
  horizon_until: Date | null;
  projected_at: Date | null;
}

interface EventDbRow {
  id: string;
  calendar_id: string;
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  start_time: Date;
  end_time: Date;
  all_day: boolean;
  rrule: string | null;
  exdates: unknown;
  recurrence_id: Date | null;
  recurrence_master_id: string | null;
  source: string;
  source_id: string | null;
  status: LegacyStatus;
  caldes_object_id: string | null;
  caldes_derived: boolean;
  created_at: Date;
}

const EVENT_COLUMNS = [
  'id', 'calendar_id', 'uid', 'summary', 'description', 'location', 'url', 'start_time', 'end_time', 'all_day', 'rrule', 'exdates',
  'recurrence_id', 'recurrence_master_id', 'source', 'source_id', 'status', 'caldes_object_id', 'caldes_derived', 'created_at',
] as const;

function rowRefs(raw: unknown): ReverseRowRef[] {
  if (!Array.isArray(raw)) return [];
  const out: ReverseRowRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) continue;
    const role = r.role === 'master' || r.role === 'override' || r.role === 'derived' || r.role === 'projection' ? r.role : 'derived';
    out.push({ id: r.id.toLowerCase(), recurrence_key: typeof r.recurrence_key === 'string' ? r.recurrence_key : '', role });
  }
  return out;
}

function exdatesOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/** Riga del database → forma del proiettore (per il confronto e per le righe legate). */
function dbRowToReverse(r: EventDbRow): LegacyReverseRow {
  return {
    id: r.id.toLowerCase(),
    calendar_id: r.calendar_id.toLowerCase(),
    uid: r.uid,
    summary: r.summary,
    description: r.description,
    location: r.location,
    url: r.url,
    start_time: r.start_time.toISOString(),
    end_time: r.end_time.toISOString(),
    all_day: r.all_day,
    rrule: r.rrule,
    exdates: exdatesOf(r.exdates),
    recurrence_id: r.recurrence_id ? r.recurrence_id.toISOString() : null,
    recurrence_master_id: r.recurrence_master_id ? r.recurrence_master_id.toLowerCase() : null,
    source: r.source,
    source_id: r.source_id,
    status: r.status,
    caldes_object_id: (r.caldes_object_id ?? '').toLowerCase(),
    caldes_derived: r.caldes_derived,
  };
}

function sameRow(planned: LegacyReverseRow, current: EventDbRow | undefined): boolean {
  if (!current) return false;
  return canonical(canonicalRow(planned)) === canonical(canonicalRow(dbRowToReverse(current)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- frammento di postgres-js (stesso schema di apply.ts)
async function selectEvents(db: Db, where: any): Promise<EventDbRow[]> {
  return db<EventDbRow[]>`SELECT ${db(EVENT_COLUMNS as unknown as string[])} FROM calendar_events WHERE ${where}`;
}

/** Calendari proiettati (§4.2): collezioni attive non iscrizioni e non archivio, con l'orizzonte dell'indice. */
async function loadScopeCalendars(db: Db, calendarIds: readonly string[] | undefined): Promise<CalendarScopeRow[]> {
  const ids = calendarIds ? [...new Set(calendarIds.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase()))] : null;
  if (ids && ids.length === 0) return [];
  return db<CalendarScopeRow[]>`
    SELECT c.id::text AS id, c.collection_name, c.role, c.timezone, c.blocks_availability,
           st.horizon_start, st.horizon_end
    FROM calendars c
    LEFT JOIN cal_collection_state st ON st.calendar_id = c.id
    WHERE c.collection_name IS NOT NULL
      AND c.role <> 'subscription'
      AND c.origin <> 'migration'
      AND c.lifecycle = 'active'
      ${ids ? db`AND c.id = ANY(${ids}::uuid[])` : db``}
    ORDER BY c.collection_name, c.id
  `;
}

interface BookingRow {
  uid: string;
  status: string;
  start_time: Date;
  end_time: Date;
  attendee_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  attendee_company: string | null;
  attendee_message: string | null;
  location_value: string | null;
  event_type_id: string;
  updated_at: Date;
}

// ─── computeReversePlan ───────────────────────────────

/** Contesto di un oggetto da proiettare, raccolto dal database. */
interface ObjectWork {
  kind: 'object' | 'removed';
  objectId: string;
  calendar: CalendarScopeRow;
  href: string;
  bookingUid: string | null;
  object: ObjectRow | null;
  ids: ObjectIdRow[];
  state: ReverseStateRow | null;
  sortKey: string;
}

function emptySummary(): ReverseApplySummary {
  return { objects: 0, projected: 0, degraded: 0, failed: 0, removed: 0, unchanged: 0, rows: { inserted: 0, updated: 0, deleted: 0 }, by_class: {}, duration_ms: 0 };
}

function countByClass(objects: readonly ReverseObjectPlan[]): Partial<Record<DegradationClass, number>> {
  const out: Partial<Record<DegradationClass, number>> = {};
  for (const o of objects) {
    if (o.status === 'removed') continue;
    for (const d of o.degradations) out[d.class] = (out[d.class] ?? 0) + 1;
  }
  return out;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('proiezione inversa interrotta');
}

/**
 * Piano della proiezione inversa (nessuna scrittura): per ogni risorsa delle
 * collezioni proiettate (o di quelle indicate) le righe legacy previste, i
 * degradi e i REVERSE_FAILED, più le risorse sparite (righe possedute da
 * cancellare, proiezioni da annullare). Deterministico a parità di indice e
 * di prenotazioni; `unchanged` dice se le righe e lo stato sono già quelli.
 */
export async function computeReversePlan(db: Db, opts: { calendarIds?: readonly string[]; now: Date; signal?: AbortSignal }): Promise<ReversePlan> {
  const started = Date.now();
  const calendars = await loadScopeCalendars(db, opts.calendarIds);
  const calById = new Map(calendars.map((c) => [c.id.toLowerCase(), c]));
  const calIds = [...calById.keys()];
  const generatedAt = opts.now.toISOString();
  if (calIds.length === 0) {
    const plan: ReversePlan = { generated_at: generatedAt, horizon: { from: generatedAt, to: generatedAt }, objects: [], hash: '', summary: emptySummary() };
    plan.hash = reversePlanHash(plan);
    return plan;
  }
  const [backend] = await db<Array<{ cutover_at: Date | null }>>`SELECT cutover_at FROM calendar_backend_state WHERE id`;
  const cutoverAt = backend?.cutover_at ?? null;

  // 1. Risorse indicizzate (testo corrente, o dell'ultima versione buona per le quarantene).
  const objects = await db<ObjectRow[]>`
    SELECT o.id::text AS id, o.calendar_id::text AS calendar_id, o.href, o.uid, o.etag, o.raw_ics, o.content_sha256, o.health,
           o.materialized_until, o.first_seen_at,
           v.raw_ics AS good_raw, v.content_sha256 AS good_sha
    FROM cal_objects o
    LEFT JOIN cal_object_versions v ON v.id = o.last_good_version_id AND v.valid
    WHERE o.calendar_id = ANY(${calIds}::uuid[]) AND o.origin_store = 'radicale'
  `;
  checkAborted(opts.signal);
  const objectIds = objects.map((o) => o.id.toLowerCase());

  // 2. Occorrenze dell'indice.
  const occByObject = new Map<string, ReverseOccurrenceInput[]>();
  for (const part of chunks(objectIds)) {
    const occ = await db<Array<{ object_id: string; recurrence_key: string; start_utc: Date; end_utc: Date; all_day: boolean; status: string; transp: string; blocks: boolean }>>`
      SELECT object_id::text AS object_id, recurrence_key, start_utc, end_utc, all_day, status, transp, blocks
      FROM cal_occurrences WHERE object_id = ANY(${part}::uuid[])
      ORDER BY object_id, start_utc, recurrence_key
    `;
    for (const o of occ) {
      const key = o.object_id.toLowerCase();
      const list = occByObject.get(key) ?? [];
      list.push({ recurrence_key: o.recurrence_key, start_utc: o.start_utc.toISOString(), end_utc: o.end_utc.toISOString(), all_day: o.all_day, status: o.status, transp: o.transp, blocks: o.blocks });
      occByObject.set(key, list);
    }
  }

  // 3. Stato della proiezione e id persistenti delle posizioni.
  const states = await db<ReverseStateRow[]>`
    SELECT object_id::text AS object_id, calendar_id::text AS calendar_id, href, source_etag, source_sha256, status, rows, degradations,
           error_code, error, attempts, horizon_until, projected_at
    FROM cal_migration_reverse_state WHERE calendar_id = ANY(${calIds}::uuid[])
  `;
  const stateById = new Map(states.map((s) => [s.object_id.toLowerCase(), s]));
  const idRows = await db<ObjectIdRow[]>`
    SELECT id::text AS id, calendar_id::text AS calendar_id, href, recurrence_key, legacy_event_id::text AS legacy_event_id, legacy_uid, retired_at
    FROM cal_object_ids WHERE calendar_id = ANY(${calIds}::uuid[])
  `;
  const idsByPosition = new Map<string, ObjectIdRow[]>();
  const masterIdRow = new Map<string, ObjectIdRow>();
  for (const r of idRows) {
    const pos = `${r.calendar_id.toLowerCase()}|${r.href}`;
    const list = idsByPosition.get(pos) ?? [];
    list.push(r);
    idsByPosition.set(pos, list);
    if (r.recurrence_key === '') masterIdRow.set(r.id.toLowerCase(), r);
  }
  checkAborted(opts.signal);

  // 4. Lavoro per oggetto: indicizzati, poi spariti (stato senza oggetto, proiezioni ritirate dal cutover).
  const work: ObjectWork[] = [];
  const known = new Set<string>();
  for (const o of objects) {
    const cal = calById.get(o.calendar_id.toLowerCase());
    if (!cal) continue;
    const id = o.id.toLowerCase();
    known.add(id);
    const info = parseObjectHref(o.href);
    work.push({
      kind: 'object',
      objectId: id,
      calendar: cal,
      href: o.href,
      bookingUid: cal.role === 'bookings' && info.kind === 'booking' ? (info.bookingUid as string) : null,
      object: o,
      ids: idsByPosition.get(`${o.calendar_id.toLowerCase()}|${o.href}`) ?? [],
      state: stateById.get(id) ?? null,
      sortKey: `0|${o.first_seen_at.toISOString()}|${cal.collection_name}|${o.href}|${id}`,
    });
  }
  // Risorse spostate in un'altra collezione proiettata (MOVE: stesso id): non sono sparite, le
  // proietta la passata della collezione di arrivo (una passata parziale non le cancella mai).
  const orphanStates = states.filter((st) => !known.has(st.object_id.toLowerCase())).map((st) => st.object_id.toLowerCase());
  const moved = new Set<string>();
  for (const part of chunks(orphanStates)) {
    const rows = await db<Array<{ id: string }>>`
      SELECT o.id::text AS id FROM cal_objects o JOIN calendars c ON c.id = o.calendar_id
      WHERE o.id = ANY(${part}::uuid[]) AND o.origin_store = 'radicale'
        AND c.collection_name IS NOT NULL AND c.role <> 'subscription' AND c.origin <> 'migration' AND c.lifecycle = 'active'
    `;
    for (const r of rows) moved.add(r.id.toLowerCase());
  }
  for (const s of states) {
    const id = s.object_id.toLowerCase();
    if (known.has(id) || moved.has(id)) continue;
    const cal = calById.get(s.calendar_id.toLowerCase());
    if (!cal) continue;
    known.add(id);
    const info = parseObjectHref(s.href);
    work.push({
      kind: 'removed',
      objectId: id,
      calendar: cal,
      href: s.href,
      bookingUid: cal.role === 'bookings' && info.kind === 'booking' ? (info.bookingUid as string) : null,
      object: null,
      ids: idsByPosition.get(`${s.calendar_id.toLowerCase()}|${s.href}`) ?? [],
      state: s,
      sortKey: `1|${cal.collection_name}|${s.href}|${id}`,
    });
  }
  // Proiezioni ritirate dal cutover (delta, annullamenti a cavallo del freeze) mai proiettate.
  const retiredSince = new Date((cutoverAt ?? opts.now).getTime() - RETIRED_BOOKING_MARGIN_MS);
  for (const r of idRows) {
    const id = r.id.toLowerCase();
    if (r.recurrence_key !== '' || !r.retired_at || r.retired_at < retiredSince || known.has(id) || !r.legacy_event_id) continue;
    const cal = calById.get(r.calendar_id.toLowerCase());
    const info = parseObjectHref(r.href);
    if (!cal || cal.role !== 'bookings' || info.kind !== 'booking') continue;
    known.add(id);
    work.push({
      kind: 'removed',
      objectId: id,
      calendar: cal,
      href: r.href,
      bookingUid: info.bookingUid as string,
      object: null,
      ids: idsByPosition.get(`${r.calendar_id.toLowerCase()}|${r.href}`) ?? [],
      state: null,
      sortKey: `2|${cal.collection_name}|${r.href}|${id}`,
    });
  }
  work.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  // 5. Righe legacy collegate: possedute, con gli id del piano, figlie dei master, proiezioni per uid.
  const candidateIds = new Set<string>();
  const ownerIds = new Set<string>();
  const bookingUids = new Set<string>();
  for (const w of work) {
    ownerIds.add(w.objectId);
    candidateIds.add(w.objectId);
    for (const r of w.ids) {
      candidateIds.add(r.id.toLowerCase());
      if (r.legacy_event_id) candidateIds.add(r.legacy_event_id.toLowerCase());
    }
    for (const ref of rowRefs(w.state?.rows)) candidateIds.add(ref.id);
    if (w.bookingUid) bookingUids.add(w.bookingUid);
  }
  const relatedById = new Map<string, EventDbRow>();
  const addRows = (rows: EventDbRow[]): void => {
    for (const r of rows) relatedById.set(r.id.toLowerCase(), r);
  };
  for (const part of chunks([...ownerIds])) addRows(await selectEvents(db, db`caldes_object_id = ANY(${part}::uuid[])`));
  for (const part of chunks([...candidateIds])) {
    addRows(await selectEvents(db, db`id = ANY(${part}::uuid[])`));
    addRows(await selectEvents(db, db`recurrence_master_id = ANY(${part}::uuid[])`));
  }
  for (const part of chunks([...bookingUids])) {
    addRows(await selectEvents(db, db`source = 'booking' AND source_id = ANY(${part}::text[]) AND recurrence_master_id IS NULL`));
  }
  checkAborted(opts.signal);

  // 6. Prenotazioni delle proiezioni.
  const bookings = new Map<string, BookingRow>();
  for (const part of chunks([...bookingUids])) {
    const rows = await db<BookingRow[]>`
      SELECT uid, status, start_time, end_time, attendee_name, attendee_email, attendee_phone, attendee_company, attendee_message,
             location_value, event_type_id::text AS event_type_id, updated_at
      FROM calendar_bookings WHERE uid = ANY(${part}::text[])
    `;
    for (const b of rows) bookings.set(b.uid, b);
  }

  // 7. Righe che tengono gli UID candidati (UNIQUE): basi e forme con '#'.
  const uidBases = new Set<string>();
  for (const w of work) {
    const cal = w.calendar;
    for (const r of w.ids) if (r.recurrence_key === '' && r.legacy_uid) uidBases.add(r.legacy_uid);
    const ical = w.object?.uid ?? null;
    if (ical) {
      uidBases.add(ical);
      uidBases.add(`${ical}@${cal.collection_name}`);
    }
    uidBases.add(w.href);
    uidBases.add(`${w.href}@${cal.collection_name}`);
    if (w.bookingUid) {
      uidBases.add(bookingProjectionUid(w.bookingUid));
      uidBases.add(`${bookingProjectionUid(w.bookingUid)}@${cal.collection_name}`);
    }
  }
  for (const r of relatedById.values()) uidBases.add(r.uid);
  const uidHolders = new Map<string, Array<{ id: string; caldes_object_id: string | null }>>();
  for (const part of chunks([...uidBases])) {
    const rows = await db<Array<{ id: string; uid: string; caldes_object_id: string | null }>>`
      SELECT id::text AS id, uid, caldes_object_id::text AS caldes_object_id FROM calendar_events
      WHERE uid = ANY(${part}::text[]) OR split_part(uid, '#', 1) = ANY(${part}::text[])
    `;
    for (const r of rows) {
      const list = uidHolders.get(r.uid) ?? [];
      if (!list.some((x) => x.id === r.id.toLowerCase())) list.push({ id: r.id.toLowerCase(), caldes_object_id: r.caldes_object_id?.toLowerCase() ?? null });
      uidHolders.set(r.uid, list);
    }
  }
  checkAborted(opts.signal);

  // 8. Id rivendicati da altre posizioni (figlie legacy di un master da non toccare).
  const childCandidates = [...relatedById.values()].filter((r) => r.recurrence_master_id).map((r) => r.id.toLowerCase());
  const claimedChildren = new Map<string, string>();
  for (const part of chunks(childCandidates)) {
    const rows = await db<Array<{ id: string; legacy_event_id: string | null; calendar_id: string; href: string }>>`
      SELECT id::text AS id, legacy_event_id::text AS legacy_event_id, calendar_id::text AS calendar_id, href FROM cal_object_ids
      WHERE retired_at IS NULL AND (id = ANY(${part}::uuid[]) OR legacy_event_id = ANY(${part}::uuid[]))
    `;
    for (const r of rows) {
      const pos = `${r.calendar_id.toLowerCase()}|${r.href}`;
      claimedChildren.set(r.id.toLowerCase(), pos);
      if (r.legacy_event_id) claimedChildren.set(r.legacy_event_id.toLowerCase(), pos);
    }
  }

  // 9. Piano per oggetto.
  const assignedInPass = new Set<string>();
  const out: ReverseObjectPlan[] = [];
  let horizonFrom: number | null = null;
  let horizonTo: number | null = null;
  const eventTypeCache = new Map<string, Awaited<ReturnType<typeof getEventType>>>();
  for (const w of work) {
    checkAborted(opts.signal);
    const cal = w.calendar;
    const masterRow = w.ids.find((r) => r.recurrence_key === '' && r.id.toLowerCase() === w.objectId) ?? w.ids.find((r) => r.recurrence_key === '') ?? null;
    const masterPlannedId = (masterRow?.legacy_event_id ?? masterRow?.id ?? w.objectId).toLowerCase();
    const byKey = new Map<string, string>();
    for (const r of w.ids) if (r.recurrence_key !== '') byKey.set(r.recurrence_key, (r.legacy_event_id ?? r.id).toLowerCase());
    const prevRefs = rowRefs(w.state?.rows);
    const ownIds = new Set<string>([masterPlannedId, w.objectId, ...byKey.values(), ...prevRefs.map((r) => r.id)]);
    for (const r of relatedById.values()) if ((r.caldes_object_id ?? '').toLowerCase() === w.objectId) ownIds.add(r.id.toLowerCase());

    // Riga legacy legata di una proiezione.
    let linked: EventDbRow | null = null;
    if (w.bookingUid) {
      const candidates = [...relatedById.values()].filter((r) => r.source === 'booking' && r.source_id === w.bookingUid && r.recurrence_master_id === null
        && (r.caldes_object_id === null || r.caldes_object_id.toLowerCase() === w.objectId));
      linked = candidates.find((r) => r.id.toLowerCase() === masterPlannedId)
        ?? candidates.find((r) => r.id.toLowerCase() === w.objectId)
        ?? candidates.find((r) => prevRefs.some((p) => p.id === r.id.toLowerCase()))
        ?? [...candidates].sort((a, b) => Number(a.status === 'cancelled') - Number(b.status === 'cancelled') || a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))[0]
        ?? null;
      if (linked) ownIds.add(linked.id.toLowerCase());
    }

    const used = new Set<string>(assignedInPass);
    for (const [uid, holders] of uidHolders) {
      if (holders.some((h) => h.caldes_object_id !== w.objectId && !ownIds.has(h.id))) used.add(uid);
    }
    const existingUids = new Map<string, string>();
    for (const id of ownIds) {
      const r = relatedById.get(id);
      if (r) existingUids.set(id, r.uid);
    }

    let plan: ReverseObjectPlan;
    const base: PlanBase = {
      object_id: w.objectId,
      calendar_id: cal.id.toLowerCase(),
      collection_name: cal.collection_name,
      href: w.href,
      source_etag: null,
      source_sha256: null,
    };
    if (w.kind === 'removed') {
      if (w.bookingUid) {
        const b = bookings.get(w.bookingUid) ?? null;
        const legacy = linked ? dbRowToReverse(linked) : null;
        let p: ReverseObjectPlan;
        try {
          p = projectBooking({
            calendar: { id: cal.id, collection_name: cal.collection_name, role: cal.role, timezone: cal.timezone ?? 'Europe/Rome' },
            ids: { master: { id: masterPlannedId, legacy_uid: masterRow?.legacy_uid ?? null }, byRecurrenceKey: byKey },
            usedUids: used,
            booking: { booking: b ? bookingInput(b) : null, eventTitle: null, meetingUrl: null, legacyRow: legacy },
            object: { id: w.objectId, calendar_id: cal.id, collection_name: cal.collection_name, href: w.href, etag: null, raw_ics: '', content_sha256: null },
          }, base, w.bookingUid, false);
        } catch (err) {
          // Caso limite dei dati (come in projectObject): REVERSE_FAILED della risorsa, mai un'eccezione al job.
          p = failedPlan(base, err instanceof ReverseObjectError ? err.message : 'proiezione della prenotazione ritirata non calcolabile');
        }
        plan = { ...p, status: p.status === 'failed' ? 'failed' : 'removed' };
        // Una proiezione ritirata senza riga legacy attiva da annullare non entra nel piano.
        if (!w.state && plan.rows.every((r) => relatedById.get(r.id)?.status === 'cancelled')) continue;
      } else {
        plan = { ...base, status: 'removed', rows: [], degradations: [], delete_row_ids: [], error: null, unchanged: false, horizon_until: null };
      }
    } else {
      const o = w.object as ObjectRow;
      const useGood = o.health === 'quarantined' && o.good_raw !== null;
      const raw = useGood ? (o.good_raw as string) : o.raw_ics ?? '';
      const sha = useGood ? o.good_sha : o.content_sha256;
      const hStart = cal.horizon_start;
      const hEnd = cal.horizon_end;
      if (!hStart || !hEnd) {
        plan = failedPlan({ ...base, source_etag: o.etag, source_sha256: sha && SHA256_RE.test(sha) ? sha : null }, 'Orizzonte dell\'indice della collezione non materializzato: la proiezione riprova dopo la sync');
      } else {
        const to = o.materialized_until && o.materialized_until < hEnd ? o.materialized_until : hEnd;
        horizonFrom = horizonFrom === null ? hStart.getTime() : Math.min(horizonFrom, hStart.getTime());
        horizonTo = horizonTo === null ? to.getTime() : Math.max(horizonTo, to.getTime());
        let bookingInfo: BookingProjectionInput | null = null;
        if (w.bookingUid) {
          const b = bookings.get(w.bookingUid) ?? null;
          let eventTitle: string | null = null;
          let meetingUrl: string | null = null;
          if (b && !linked) {
            if (!eventTypeCache.has(b.event_type_id)) eventTypeCache.set(b.event_type_id, await getEventType(b.event_type_id, { includeInactive: true }));
            const et = eventTypeCache.get(b.event_type_id) ?? null;
            eventTitle = et?.title ?? null;
            if (et) {
              const resolved = await resolveLocationForBooking({
                eventType: et,
                booking: { uid: b.uid, start_time: b.start_time.toISOString(), end_time: b.end_time.toISOString(), attendee_name: b.attendee_name, attendee_email: b.attendee_email },
                pushToGoogle: false,
              });
              meetingUrl = resolved.meetingUrl;
            }
          }
          bookingInfo = { booking: b ? bookingInput(b) : null, eventTitle, meetingUrl, legacyRow: linked ? dbRowToReverse(linked) : null };
        }
        plan = projectObject({
          object: { id: w.objectId, calendar_id: cal.id, collection_name: cal.collection_name, href: w.href, etag: o.etag, raw_ics: raw, content_sha256: sha },
          calendar: { id: cal.id, collection_name: cal.collection_name, role: cal.role, timezone: cal.timezone ?? 'Europe/Rome' },
          ids: { master: { id: masterPlannedId, legacy_uid: masterRow?.legacy_uid ?? null }, byRecurrenceKey: byKey },
          occurrences: occByObject.get(w.objectId) ?? [],
          usedUids: used,
          booking: bookingInfo,
          horizon: { from: hStart, to },
          existingUids,
        });
      }
    }

    // Id del piano posseduti da un'altra risorsa: mai sovrascritti.
    if (plan.status !== 'failed') {
      const stolen = plan.rows.find((r) => {
        const cur = relatedById.get(r.id);
        return cur && cur.caldes_object_id !== null && cur.caldes_object_id.toLowerCase() !== w.objectId;
      });
      if (stolen) plan = failedPlan({ ...base, source_etag: plan.source_etag, source_sha256: plan.source_sha256 }, 'Un id delle righe previste appartiene già alla proiezione di un\'altra risorsa');
    }

    // Righe da cancellare (mai quelle possedute da un'altra risorsa): le possedute non più previste;
    // per una risorsa viva anche le righe legacy con i suoi id (master e override migrati sostituiti
    // da righe derivate) e le figlie legacy non rivendicate dei suoi master (override annullati
    // diventati EXDATE). Una risorsa sparita cancella solo ciò che possiede (le cascate fanno il resto).
    if (plan.status !== 'failed' && !w.bookingUid) {
      const planned = new Set(plan.rows.map((r) => r.id));
      const candidates = new Set<string>(prevRefs.map((r) => r.id));
      for (const r of relatedById.values()) if ((r.caldes_object_id ?? '').toLowerCase() === w.objectId) candidates.add(r.id.toLowerCase());
      const masters = new Set<string>(prevRefs.filter((r) => r.role === 'master').map((r) => r.id));
      if (w.kind === 'object') {
        for (const id of [masterPlannedId, w.objectId, ...byKey.values()]) candidates.add(id);
        masters.add(masterPlannedId);
      }
      const position = `${cal.id.toLowerCase()}|${w.href}`;
      for (const r of relatedById.values()) {
        const id = r.id.toLowerCase();
        if (!r.recurrence_master_id || !masters.has(r.recurrence_master_id.toLowerCase()) || masters.has(id)) continue;
        const claim = claimedChildren.get(id);
        if (claim && claim !== position) continue;
        candidates.add(id);
      }
      plan.delete_row_ids = [...candidates].filter((id) => {
        if (planned.has(id)) return false;
        const cur = relatedById.get(id);
        return cur !== undefined && (cur.caldes_object_id === null || cur.caldes_object_id.toLowerCase() === w.objectId);
      }).sort();
    }

    // Già allineato?
    plan.unchanged = isUnchanged(plan, w.state, relatedById);
    for (const r of plan.rows) assignedInPass.add(r.row.uid);
    out.push(plan);
  }

  const plan: ReversePlan = {
    generated_at: generatedAt,
    horizon: {
      from: new Date(horizonFrom ?? opts.now.getTime()).toISOString(),
      to: new Date(horizonTo ?? opts.now.getTime()).toISOString(),
    },
    objects: out,
    hash: '',
    summary: planSummary(out, relatedById, Date.now() - started),
  };
  plan.hash = reversePlanHash(plan);
  return plan;
}

function bookingInput(b: BookingRow): NonNullable<BookingProjectionInput['booking']> {
  return {
    uid: b.uid,
    status: b.status as BookingStatus,
    start_time: b.start_time.toISOString(),
    end_time: b.end_time.toISOString(),
    attendee_name: b.attendee_name,
    attendee_email: b.attendee_email,
    attendee_phone: b.attendee_phone,
    attendee_company: b.attendee_company,
    attendee_message: b.attendee_message,
    location_value: b.location_value,
  };
}

function sameRefs(a: readonly ReverseRowRef[], b: readonly ReverseRowRef[]): boolean {
  const norm = (list: readonly ReverseRowRef[]): string => canonical([...list].map((r) => ({ id: r.id, recurrence_key: r.recurrence_key, role: r.role })).sort((x, y) => x.id.localeCompare(y.id)));
  return norm(a) === norm(b);
}

function isUnchanged(plan: ReverseObjectPlan, state: ReverseStateRow | null, current: ReadonlyMap<string, EventDbRow>): boolean {
  if (!state) return false;
  if (state.status !== plan.status) return false;
  if ((state.source_etag ?? null) !== (plan.source_etag ?? null) || (state.source_sha256 ?? null) !== (plan.source_sha256 ?? null)) return false;
  if (plan.delete_row_ids.length > 0) return false;
  const stateHorizon = state.horizon_until ? state.horizon_until.toISOString() : null;
  if (stateHorizon !== (plan.horizon_until ?? null)) return false;
  if (canonical(normalizeDegradations(state.degradations)) !== canonical(plan.degradations)) return false;
  if (plan.status === 'failed') return (state.error_code ?? null) === plan.error?.code && (state.error ?? null) === plan.error?.message;
  if (state.error_code !== null) return false;
  if (!sameRefs(rowRefs(state.rows), plan.rows)) return false;
  return plan.rows.every((r) => sameRow(r.row, current.get(r.id)));
}

function planSummary(objects: readonly ReverseObjectPlan[], current: ReadonlyMap<string, EventDbRow>, durationMs: number): ReverseApplySummary {
  const s = emptySummary();
  s.objects = objects.length;
  for (const o of objects) {
    if (o.status === 'projected') s.projected++;
    else if (o.status === 'degraded') s.degraded++;
    else if (o.status === 'failed') s.failed++;
    else s.removed++;
    if (o.unchanged) {
      s.unchanged++;
      continue;
    }
    for (const r of o.rows) {
      const cur = current.get(r.id);
      if (!cur) s.rows.inserted++;
      else if (!sameRow(r.row, cur)) s.rows.updated++;
    }
    s.rows.deleted += o.delete_row_ids.length;
  }
  s.by_class = countByClass(objects);
  s.duration_ms = durationMs;
  return s;
}

// ─── applyReversePlan ───────────────────────────────

const UPDATE_COLUMNS = [
  'calendar_id', 'uid', 'summary', 'description', 'location', 'url', 'start_time', 'end_time', 'all_day', 'rrule', 'exdates',
  'recurrence_id', 'recurrence_master_id', 'source', 'source_id', 'status', 'caldes_object_id', 'caldes_derived',
] as const;

/** Upsert per id di una riga: riscrive solo se qualche colonna cambia. Restituisce 'inserted', 'updated' o 'same'. */
async function upsertRow(tx: Db, row: LegacyReverseRow): Promise<'inserted' | 'updated' | 'same'> {
  const values = {
    id: row.id,
    calendar_id: row.calendar_id,
    uid: row.uid,
    summary: row.summary,
    description: row.description,
    location: row.location,
    url: row.url,
    start_time: row.start_time,
    end_time: row.end_time,
    all_day: row.all_day,
    rrule: row.rrule,
    exdates: tx.json(row.exdates as Parameters<typeof tx.json>[0]),
    recurrence_id: row.recurrence_id,
    recurrence_master_id: row.recurrence_master_id,
    source: row.source,
    source_id: row.source_id,
    status: row.status,
    caldes_object_id: row.caldes_object_id,
    caldes_derived: row.caldes_derived,
  };
  const set = UPDATE_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const distinct = `(${UPDATE_COLUMNS.map((c) => `calendar_events.${c}`).join(', ')}) IS DISTINCT FROM (${UPDATE_COLUMNS.map((c) => `EXCLUDED.${c}`).join(', ')})`;
  const rows = await tx<Array<{ inserted: boolean }>>`
    INSERT INTO calendar_events ${tx(values)}
    ON CONFLICT (id) DO UPDATE SET ${tx.unsafe(set)}
    WHERE ${tx.unsafe(distinct)}
    RETURNING (xmax = 0) AS inserted
  `;
  if (rows.length === 0) return 'same';
  return rows[0].inserted ? 'inserted' : 'updated';
}

interface ObjectOutcome {
  inserted: number;
  updated: number;
  deleted: number;
}

/** Scrive le righe e lo stato di una risorsa (dentro un SAVEPOINT, con il GUC del proiettore). */
async function applyObject(tx: Db, plan: ReverseObjectPlan): Promise<ObjectOutcome> {
  const outcome: ObjectOutcome = { inserted: 0, updated: 0, deleted: 0 };
  const plannedIds = plan.rows.map((r) => r.id);
  const lockIds = [...new Set([...plannedIds, ...plan.delete_row_ids])];
  const current = lockIds.length > 0
    ? await tx<Array<{ id: string; uid: string; caldes_object_id: string | null }>>`
        SELECT id::text AS id, uid, caldes_object_id::text AS caldes_object_id FROM calendar_events
        WHERE id = ANY(${lockIds}::uuid[]) FOR UPDATE
      `
    : [];
  const currentById = new Map(current.map((r) => [r.id.toLowerCase(), r]));
  for (const r of current) {
    if (r.caldes_object_id && r.caldes_object_id.toLowerCase() !== plan.object_id && plannedIds.includes(r.id.toLowerCase())) {
      throw new ReverseObjectError('Un id delle righe previste appartiene già alla proiezione di un\'altra risorsa');
    }
  }
  // 1. Cancellazioni (mai righe possedute da un'altra risorsa).
  if (plan.delete_row_ids.length > 0) {
    const deleted = await tx<Array<{ id: string }>>`
      DELETE FROM calendar_events
      WHERE id = ANY(${plan.delete_row_ids}::uuid[])
        AND (caldes_object_id IS NULL OR caldes_object_id = ${plan.object_id}::uuid)
      RETURNING id
    `;
    outcome.deleted += deleted.length;
  }
  // 2. Scambi di UID fra righe della stessa risorsa: UID temporanei prima degli upsert.
  const wantedUid = new Map(plan.rows.map((r) => [r.row.uid, r.id]));
  const swaps = [...currentById.values()].filter((r) => {
    const owner = wantedUid.get(r.uid);
    return owner !== undefined && owner !== r.id.toLowerCase() && plannedIds.includes(r.id.toLowerCase());
  });
  for (const r of swaps) {
    await tx`UPDATE calendar_events SET uid = ${`${r.uid}#~${r.id.toLowerCase()}`} WHERE id = ${r.id}::uuid`;
  }
  // 3. Upsert: prima le righe senza master (master, proiezione, derivate), poi gli override.
  const ordered = [...plan.rows].sort((a, b) => Number(a.row.recurrence_master_id !== null) - Number(b.row.recurrence_master_id !== null));
  for (const r of ordered) {
    const res = await upsertRow(tx, r.row);
    if (res === 'inserted') outcome.inserted++;
    else if (res === 'updated') outcome.updated++;
  }
  // 4. Stato della risorsa.
  await writeReverseState(tx, {
    plan,
    status: plan.status,
    rows: plan.rows.map((r) => ({ id: r.id, recurrence_key: r.recurrence_key, role: r.role })),
    degradations: plan.degradations,
    error: null,
  });
  return outcome;
}

async function writeReverseState(
  tx: Db,
  input: {
    plan: Pick<ReverseObjectPlan, 'object_id' | 'calendar_id' | 'href' | 'source_etag' | 'source_sha256' | 'horizon_until'>;
    status: ReverseStateStatus;
    rows: ReverseRowRef[];
    degradations: DegradationRecord[];
    error: { code: string; message: string } | null;
  },
): Promise<void> {
  const p = input.plan;
  const failed = input.status === 'failed';
  await tx`
    INSERT INTO cal_migration_reverse_state (
      object_id, calendar_id, href, source_etag, source_sha256, status, rows, degradations, error_code, error, attempts, horizon_until, projected_at
    ) VALUES (
      ${p.object_id}::uuid, ${p.calendar_id}::uuid, ${p.href}, ${p.source_etag}, ${p.source_sha256}, ${input.status},
      ${tx.json(input.rows as unknown as Parameters<typeof tx.json>[0])}, ${tx.json(input.degradations as unknown as Parameters<typeof tx.json>[0])},
      ${failed ? input.error?.code ?? 'REVERSE_FAILED' : null}, ${failed ? (input.error?.message ?? 'Proiezione non riuscita').slice(0, 500) : null},
      ${failed ? 1 : 0}, ${p.horizon_until ?? null}, now()
    )
    ON CONFLICT (object_id) DO UPDATE SET
      calendar_id = EXCLUDED.calendar_id,
      href = EXCLUDED.href,
      source_etag = EXCLUDED.source_etag,
      source_sha256 = EXCLUDED.source_sha256,
      status = EXCLUDED.status,
      rows = EXCLUDED.rows,
      degradations = EXCLUDED.degradations,
      error_code = EXCLUDED.error_code,
      error = EXCLUDED.error,
      attempts = CASE WHEN EXCLUDED.status = 'failed' THEN cal_migration_reverse_state.attempts + 1 ELSE 0 END,
      horizon_until = EXCLUDED.horizon_until,
      projected_at = now()
  `;
}

type SavepointDb = Db & { savepoint<T>(fn: (sp: Db) => Promise<T>): Promise<T> };

/**
 * Applica il piano (§4.2): per lotti di risorse, una transazione con
 * `SET LOCAL caldes.reverse_sync = 'on'` e un SAVEPOINT per risorsa. Una
 * risorsa che fallisce (vincolo, UID, errore del database) diventa
 * REVERSE_FAILED nel proprio stato, con le righe di prima intatte: le altre
 * proseguono e nessuna eccezione arriva al chiamante per un caso dei dati.
 * Le risorse già allineate non si riscrivono (si aggiorna solo projected_at).
 */
export async function applyReversePlan(db: Db, plan: ReversePlan, opts: { actor: string; runId?: string | null; signal?: AbortSignal }): Promise<ReverseApplySummary> {
  const started = Date.now();
  const summary = emptySummary();
  summary.objects = plan.objects.length;
  const finalStatus = new Map<string, ReverseStateStatus>();
  const failures: Array<{ object_id: string; message: string }> = [];
  for (const batch of chunks(plan.objects, APPLY_BATCH)) {
    checkAborted(opts.signal);
    await db.begin(async (txRaw) => {
      const tx = txRaw as unknown as SavepointDb;
      await tx`SELECT set_config(${REVERSE_SYNC_GUC}, 'on', true)`;
      const unchanged: string[] = [];
      for (const obj of batch) {
        if (obj.unchanged) {
          unchanged.push(obj.object_id);
          finalStatus.set(obj.object_id, obj.status);
          summary.unchanged++;
          continue;
        }
        if (obj.error) {
          await recordFailure(tx, obj, obj.error.message, obj.degradations);
          finalStatus.set(obj.object_id, 'failed');
          failures.push({ object_id: obj.object_id, message: obj.error.message });
          continue;
        }
        try {
          const res = await tx.savepoint((sp) => applyObject(sp, obj));
          summary.rows.inserted += res.inserted;
          summary.rows.updated += res.updated;
          summary.rows.deleted += res.deleted;
          finalStatus.set(obj.object_id, obj.status);
        } catch (err) {
          const clean = sanitizedDbError(err);
          if (!(err instanceof ReverseObjectError)) {
            log.warn({ objectId: obj.object_id, calendarId: obj.calendar_id, href: obj.href, err: clean.detail }, 'proiezione inversa di una risorsa non riuscita: REVERSE_FAILED');
          }
          await recordFailure(tx, obj, clean.message, [{ class: 'REVERSE_FAILED', recurrence_key: null, detail: clean.detail }]);
          finalStatus.set(obj.object_id, 'failed');
          failures.push({ object_id: obj.object_id, message: clean.message });
        }
      }
      if (unchanged.length > 0) {
        await tx`UPDATE cal_migration_reverse_state SET projected_at = now() WHERE object_id = ANY(${unchanged}::uuid[])`;
      }
    });
  }
  for (const o of plan.objects) {
    const st = finalStatus.get(o.object_id) ?? o.status;
    if (st === 'projected') summary.projected++;
    else if (st === 'degraded') summary.degraded++;
    else if (st === 'failed') summary.failed++;
    else summary.removed++;
  }
  summary.by_class = countByClass(plan.objects.map((o) => (finalStatus.get(o.object_id) === 'failed' && o.status !== 'failed'
    ? { ...o, status: 'failed' as const, degradations: [{ class: 'REVERSE_FAILED' as const, recurrence_key: null }] }
    : o)));
  summary.duration_ms = Date.now() - started;
  if (failures.length > 0) {
    log.warn({ actor: opts.actor, runId: opts.runId ?? null, failed: failures.length, objects: failures.slice(0, 20).map((f) => f.object_id) }, 'proiezione inversa con risorse REVERSE_FAILED');
  }
  return summary;
}

/** Stato REVERSE_FAILED di una risorsa (le righe di prima restano possedute). Non lancia: un errore qui si registra nei log. */
async function recordFailure(tx: SavepointDb, plan: ReverseObjectPlan, message: string, degradations: DegradationRecord[]): Promise<void> {
  try {
    await tx.savepoint(async (sp) => {
      const [prev] = await sp<Array<{ rows: unknown }>>`SELECT rows FROM cal_migration_reverse_state WHERE object_id = ${plan.object_id}::uuid`;
      await writeReverseState(sp, {
        plan,
        status: 'failed',
        rows: rowRefs(prev?.rows),
        degradations: degradations.length > 0 ? degradations : [{ class: 'REVERSE_FAILED', recurrence_key: null }],
        error: { code: 'REVERSE_FAILED', message },
      });
    });
  } catch (err) {
    log.error({ objectId: plan.object_id, calendarId: plan.calendar_id, err: sanitizedDbError(err).detail }, 'stato REVERSE_FAILED della proiezione inversa non registrato');
  }
}

/**
 * Passata della proiezione inversa (piano più apply) sulle collezioni indicate
 * o su tutte. Non prende lock né controlla il mode: la chiama il run (che
 * tiene cal-migration) o il job dopo i propri controlli.
 */
export async function runReverseProjection(opts: {
  db?: Db;
  calendarIds?: readonly string[];
  actor: string;
  runId?: string | null;
  now?: Date;
  signal?: AbortSignal;
}): Promise<ReverseApplySummary & { hash: string }> {
  const db = opts.db ?? sql;
  const started = Date.now();
  const plan = await computeReversePlan(db, { calendarIds: opts.calendarIds, now: opts.now ?? new Date(), signal: opts.signal });
  const summary = await applyReversePlan(db, plan, { actor: opts.actor, runId: opts.runId ?? null, signal: opts.signal });
  return { ...summary, duration_ms: Date.now() - started, hash: plan.hash };
}

// ─── Busy legacy previsto ───────────────────────────────

/**
 * Busy legacy (getBusyRanges di events-pg) che il codice legacy calcolerà
 * dopo l'applicazione del piano, senza scrivere: righe correnti dei
 * calendari bloccanti meno quelle che il piano cancella o riscrive, più le
 * righe previste. Serve al confronto `busy_identical` dell'anteprima del
 * rollback e ai test.
 */
export async function legacyBusyAfterPlan(db: Db, plan: Pick<ReversePlan, 'objects'>, fromIso: string, toIso: string): Promise<BusyRange[]> {
  const blocking = new Set(
    (await db<Array<{ id: string }>>`SELECT id::text AS id FROM calendars WHERE blocks_availability`).map((r) => r.id.toLowerCase()),
  );
  const replaced = new Set<string>();
  const removedMasters = new Set<string>();
  const planned: LegacyReverseRow[] = [];
  for (const o of plan.objects) {
    if (o.status === 'failed') continue;
    for (const id of o.delete_row_ids) {
      replaced.add(id);
      removedMasters.add(id);
    }
    for (const r of o.rows) {
      replaced.add(r.id);
      if (blocking.has(r.row.calendar_id)) planned.push(r.row);
    }
  }
  const current = await db<EventDbRow[]>`
    SELECT ${db(EVENT_COLUMNS as unknown as string[])} FROM calendar_events e
    WHERE EXISTS (SELECT 1 FROM calendars c WHERE c.id = e.calendar_id AND c.blocks_availability)
      AND (e.recurrence_master_id IS NOT NULL OR e.rrule IS NOT NULL
           OR (e.start_time < ${toIso}::timestamptz AND e.end_time > ${fromIso}::timestamptz))
  `;
  const rows: LegacyReverseRow[] = [...planned];
  for (const r of current) {
    const id = r.id.toLowerCase();
    if (replaced.has(id)) continue;
    if (r.recurrence_master_id && removedMasters.has(r.recurrence_master_id.toLowerCase())) continue;
    rows.push(dbRowToReverse(r));
  }
  return legacyBusyFromRows(rows, fromIso, toIso);
}

// ─── Stato e salute ───────────────────────────────

/** Proiezione inversa attiva: mode radicale con la finestra di rollback aperta. */
export function reverseProjectionActive(state: Pick<MigrationBackendState, 'mode' | 'rollback_until'>, now: Date): boolean {
  return state.mode === 'radicale' && state.rollback_until !== null && state.rollback_until.getTime() > now.getTime();
}

/** Salute della proiezione inversa per il wizard (contratto §6.3). */
export async function readReverseProjectionHealth(db: Db, now: Date = new Date()): Promise<ReverseProjectionHealthView> {
  const state = await readMigrationStateFresh(db);
  const byStatus = Object.fromEntries(REVERSE_STATE_STATUSES.map((s) => [s, 0])) as Record<ReverseStateStatus, number>;
  const counts = await db<Array<{ status: ReverseStateStatus; n: number; last: Date | null }>>`
    SELECT status, count(*)::int AS n, max(projected_at) AS last FROM cal_migration_reverse_state GROUP BY status
  `;
  let objects = 0;
  let last: Date | null = null;
  for (const c of counts) {
    if (c.status in byStatus) byStatus[c.status] = c.n;
    objects += c.n;
    if (c.last && (!last || c.last > last)) last = c.last;
  }
  const classes = await db<Array<{ cls: string; n: number }>>`
    SELECT d->>'class' AS cls, count(*)::int AS n
    FROM cal_migration_reverse_state s, jsonb_array_elements(s.degradations) d
    WHERE s.status <> 'removed'
    GROUP BY 1
  `;
  const byClass: Partial<Record<DegradationClass, number>> = {};
  for (const c of classes) if (CLASS_ORDER.has(c.cls)) byClass[c.cls as DegradationClass] = c.n;
  const [derived] = await db<Array<{ n: number }>>`SELECT count(*)::int AS n FROM calendar_events WHERE caldes_derived`;
  const queueRows = await db<Array<{ status: string; n: number }>>`
    SELECT status, count(*)::int AS n FROM cal_jobs WHERE kind = ${REVERSE_PROJECTION_JOB_KIND} AND status IN ('pending', 'running', 'dead') GROUP BY status
  `;
  const queue = { pending: 0, running: 0, dead: 0 };
  for (const q of queueRows) if (q.status === 'pending' || q.status === 'running' || q.status === 'dead') queue[q.status] = q.n;
  return {
    active: reverseProjectionActive(state, now),
    until: state.rollback_until ? state.rollback_until.toISOString() : null,
    objects,
    by_status: byStatus,
    by_class: byClass,
    derived_rows: derived?.n ?? 0,
    last_projected_at: last ? last.toISOString() : null,
    queue,
  };
}

// ─── Job, trigger e giro di backstop ───────────────────────────────

async function runs(): Promise<typeof RunsModule> {
  // Import dinamico: runs.ts importa (via cutover e rollback) questo modulo;
  // staticamente si importano solo i tipi, così le firme restano verificate.
  const specifier = './runs';
  return (await import(specifier)) as typeof RunsModule;
}

/**
 * withMigrationLock(…, { wait: false }) di runs.ts (contratto §4.1): un solo
 * tentativo su `cal-migration`; occupato da un run → ReverseLockBusyError
 * (errore d'attesa). Gli errori di `fn` passano invariati.
 */
export async function withReverseMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
  const { withMigrationLock } = await runs();
  let entered = false;
  try {
    return await withMigrationLock(async () => {
      entered = true;
      return fn();
    }, { wait: false });
  } catch (err) {
    if (!entered && isMigrationError(err) && err.code === 'MIGRATION_BUSY') throw new ReverseLockBusyError({ cause: err });
    throw err;
  }
}

/** Registra l'handler del job reverse_projection (bootstrap, prima di startCalendarJobWorker). Idempotente. */
export function registerReverseProjectionJob(): void {
  registerCalendarJobHandler(REVERSE_PROJECTION_JOB_KIND, handleReverseProjectionJob, { leaseMs: REVERSE_JOB_LEASE_MS });
}

/**
 * Handler del job reverse_projection (chiave = calendar_id): stato riletto;
 * fuori da mode radicale o a finestra chiusa si chiude senza azione; lock
 * cal-migration con un solo tentativo; stato riletto dentro il lock; passata
 * della sola collezione. I casi limite dei dati diventano REVERSE_FAILED nello
 * stato delle risorse, mai un job fallito.
 */
export async function handleReverseProjectionJob(job: CalendarJob, ctx: CalendarJobContext): Promise<CalendarJobOutcome> {
  const calendarId = job.key.toLowerCase();
  if (!UUID_RE.test(calendarId)) throw new CalendarJobPermanentError(`chiave della proiezione inversa non valida: ${job.key.slice(0, 80)}`);
  const skipped = (reason: string): CalendarJobOutcome => ({ result: { calendar_id: calendarId, skipped: reason } });
  const inactiveReason = (state: MigrationBackendState, now: Date): string | null => {
    if (state.mode !== 'radicale') return 'mode_not_radicale';
    if (!reverseProjectionActive(state, now)) return 'window_closed';
    return null;
  };
  const before = await readMigrationStateFresh(sql);
  const reason = inactiveReason(before, new Date());
  if (reason) return skipped(reason);
  return withReverseMigrationLock(async () => {
    const inner = await readMigrationStateFresh(sql);
    const innerReason = inactiveReason(inner, new Date());
    if (innerReason) return skipped(innerReason);
    const summary = await runReverseProjection({ db: sql, calendarIds: [calendarId], actor: REVERSE_ACTOR, signal: ctx.signal });
    ctx.log.info(
      { calendarId, objects: summary.objects, unchanged: summary.unchanged, failed: summary.failed, rows: summary.rows },
      'proiezione inversa della collezione',
    );
    return { result: { calendar_id: calendarId, ...summary } };
  });
}

/** Accoda la proiezione inversa di una collezione (coalescenza sui pending: un job per collezione). */
export async function enqueueReverseProjection(calendarId: string, opts: { db?: Db; delayMs?: number } = {}): Promise<void> {
  if (!UUID_RE.test(calendarId)) throw new TypeError(`calendar_id non valido: ${JSON.stringify(calendarId).slice(0, 60)}`);
  await enqueueCalendarJob(REVERSE_PROJECTION_JOB_KIND, calendarId.toLowerCase(), {}, {
    db: opts.db,
    delayMs: opts.delayMs,
    priority: CAL_JOB_PRIORITY.normal,
  });
}

/**
 * Chiude senza azione i job reverse_projection in coda (passo cleanup del
 * rollback, stop_reverse del finalize): status done con il motivo nel
 * risultato. Quelli in esecuzione finiscono da soli (rileggono lo stato).
 */
export async function closePendingReverseProjectionJobs(db: Db, reason: string): Promise<number> {
  const rows = await db<Array<{ id: string }>>`
    UPDATE cal_jobs
    SET status = 'done', finished_at = now(), updated_at = now(),
        result = ${db.json({ closed: reason.slice(0, 120) })}
    WHERE kind = ${REVERSE_PROJECTION_JOB_KIND} AND status = 'pending'
    RETURNING id
  `;
  return rows.length;
}

/** true se la collezione è fra quelle proiettate (non iscrizione, non archivio, attiva). */
async function inScope(db: Db, calendarId: string): Promise<boolean> {
  const [row] = await db<Array<{ ok: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM calendars
      WHERE id = ${calendarId}::uuid AND collection_name IS NOT NULL AND role <> 'subscription' AND origin <> 'migration' AND lifecycle = 'active'
    ) AS ok
  `;
  return row?.ok === true;
}

/**
 * LISTEN calendar_index_changed → enqueueReverseProjection (contratto §4.1):
 * debounce di 2 s per collezione (al più 10 s in una raffica), solo con mode
 * radicale (stato in cache) e per le collezioni proiettate. Alla
 * (ri)connessione del LISTEN un giro di backstop recupera le notifiche perse.
 * Restituisce la funzione che smette di ascoltare.
 */
export async function startReverseProjectionTrigger(): Promise<() => Promise<void>> {
  const timers = new Map<string, { timer: NodeJS.Timeout; firstAt: number }>();
  let stopped = false;
  const fire = (calendarId: string): void => {
    timers.delete(calendarId);
    if (stopped) return;
    void (async () => {
      try {
        const state = await readBackendStateCached(sql);
        if (state.mode !== 'radicale') return;
        if (!(await inScope(sql, calendarId))) return;
        await enqueueReverseProjection(calendarId);
      } catch (err) {
        log.warn({ calendarId, err: err instanceof Error ? err.message : String(err) }, 'accodamento della proiezione inversa non riuscito: lo recupera il giro di backstop');
      }
    })();
  };
  const onNotify = (payload: string): void => {
    if (stopped) return;
    let calendarId: string | null = null;
    try {
      const parsed = JSON.parse(payload) as { calendar_id?: unknown };
      calendarId = typeof parsed.calendar_id === 'string' && UUID_RE.test(parsed.calendar_id) ? parsed.calendar_id.toLowerCase() : null;
    } catch {
      calendarId = null;
    }
    if (!calendarId) return;
    const now = Date.now();
    const prev = timers.get(calendarId);
    if (prev) {
      clearTimeout(prev.timer);
      if (now - prev.firstAt >= REVERSE_TRIGGER_MAX_WAIT_MS) {
        fire(calendarId);
        return;
      }
    }
    const id = calendarId;
    const timer = setTimeout(() => fire(id), REVERSE_TRIGGER_DEBOUNCE_MS);
    timer.unref?.();
    timers.set(id, { timer, firstAt: prev?.firstAt ?? now });
  };
  const onListen = (): void => {
    if (stopped) return;
    void runReverseProjectionSweep().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'giro di backstop della proiezione inversa non riuscito');
    });
  };
  const sub = await sql.listen(CAL_CHANNELS.index, onNotify, onListen);
  return async () => {
    stopped = true;
    for (const t of timers.values()) clearTimeout(t.timer);
    timers.clear();
    await sub.unlisten();
  };
}

/**
 * Giro di backstop (cron ogni 15 minuti, solo mode radicale con la finestra
 * aperta): accoda le collezioni con risorse cambiate dopo l'ultima
 * proiezione, mai proiettate, sparite, REVERSE_FAILED, con l'orizzonte delle
 * righe derivate superato o con prenotazioni cambiate dopo la proiezione.
 */
export async function runReverseProjectionSweep(opts: { now?: Date } = {}): Promise<{ enqueued: number }> {
  const now = opts.now ?? new Date();
  const state = await readMigrationStateFresh(sql);
  if (!reverseProjectionActive(state, now)) return { enqueued: 0 };
  const rows = await sql<Array<{ id: string }>>`
    SELECT c.id::text AS id
    FROM calendars c
    LEFT JOIN cal_collection_state st ON st.calendar_id = c.id
    WHERE c.collection_name IS NOT NULL AND c.role <> 'subscription' AND c.origin <> 'migration' AND c.lifecycle = 'active'
      AND (
        EXISTS (
          SELECT 1 FROM cal_objects o
          LEFT JOIN cal_migration_reverse_state rs ON rs.object_id = o.id
          WHERE o.calendar_id = c.id AND o.origin_store = 'radicale'
            AND (rs.object_id IS NULL
                 OR rs.status = 'failed'
                 OR rs.projected_at IS NULL
                 OR rs.projected_at < o.changed_at
                 OR (rs.horizon_until IS NOT NULL AND st.horizon_end IS NOT NULL
                     AND rs.horizon_until < LEAST(st.horizon_end, COALESCE(o.materialized_until, st.horizon_end))))
        )
        OR EXISTS (
          SELECT 1 FROM cal_migration_reverse_state rs
          WHERE rs.calendar_id = c.id
            AND (rs.status = 'failed'
                 OR (rs.status <> 'removed' AND NOT EXISTS (SELECT 1 FROM cal_objects o WHERE o.id = rs.object_id)))
        )
        OR (c.role = 'bookings' AND EXISTS (
          SELECT 1 FROM cal_migration_reverse_state rs
          JOIN calendar_bookings b ON rs.href = 'booking-' || b.uid || '.ics'
          WHERE rs.calendar_id = c.id AND (rs.projected_at IS NULL OR b.updated_at > rs.projected_at)
        ))
      )
  `;
  for (const r of rows) await enqueueReverseProjection(r.id);
  if (rows.length > 0) log.info({ enqueued: rows.length }, 'giro di backstop della proiezione inversa');
  return { enqueued: rows.length };
}
