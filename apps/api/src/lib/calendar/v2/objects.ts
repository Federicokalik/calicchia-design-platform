/**
 * Orchestrazione dell'API admin del calendario v2 (F6, contratto
 * docs/calendar-radicale/contracts/f6-modules.md §3, §5.6, §10).
 *
 * Lettura live da Radicale (con ripiego sull'indice), PATCH con CAS per campo
 * (token di base, fusione dei campi disgiunti, noop, 412), POST e DELETE con
 * scope, MOVE dentro la PATCH. Ogni scrittura passa dalla pipeline dello
 * store (design §8): gate cal-write, GET, piano, PUT con precondizione,
 * write-through e audit; qui si decide solo il piano. Nessun testo di evento
 * nei log né in audit_logs.
 *
 * Grafo (contratto §10): routes → objects → (capabilities, view, series,
 * primitive dello store, calendar-core). view e series non importano lo store.
 */

import {
  applyComponentOps,
  type CalendarObject,
  type IcsComponent,
  type IcsProperty,
  type IcsTime,
  createCalendarObject,
  createTimeProperty,
  deriveProvenance,
  encodeText,
  formatTimeValue,
  getProperty,
  isRecurrenceKey,
  MASTER_RECURRENCE_KEY,
  msToWall,
  parseCalendarObject,
  type PatchOp,
  readTimeProperty,
  recurrenceKeyOf,
  recurrenceKeyToTime,
  serializeObject,
  setProperties,
  setProvenance,
  timeToIso,
  utcMsToTime,
  validateObject,
  type ValidationIssue,
  type ZoneContext,
} from '@calicchia/calendar-core';
import {
  CAL_V2_FIELDS,
  CAL_V2_RESERVED_PROPERTIES,
  CAL_V2_SCOPES,
  type CalV2CreateRequest,
  type CalV2DeleteBlockedReason,
  type CalV2FieldConflict,
  type CalV2Issue,
  type CalV2Notice,
  type CalV2ObjectView,
  type CalV2PatchRequest,
  type CalV2ReadonlyReason,
  type CalV2Scope,
  type CalV2WriteResult,
} from '@calicchia/shared';
import { z } from 'zod';
import { sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { CalendarConflictError, EventValidationError } from '../errors';
import { isValidObjectName, objectPath } from '../radicale/client';
import { isRadicaleError } from '../radicale/errors';
import { resolveEventRef } from '../radicale/ids';
import {
  ACTIVE_BOOKING_MESSAGE,
  allowedComponents,
  audit,
  collectionNameOf,
  type CurrentObject,
  fetchCurrent,
  generateEventUid,
  hrefForUid,
  ICS_READ_ONLY_MESSAGE,
  isActiveBookingProjection,
  moveObject,
  positionId,
  requireRadicale,
  safeTz,
  sidecarById,
  splitRecurringEvent,
  UNREADABLE_EVENT_MESSAGE,
  writeObject,
  writeThrough,
  type SidecarRow,
} from '../radicale/store';
import { radicaleRuntime, verifyVolumeIdentity } from '../radicale/sync';
import { isValidCollectionName } from '../radicale/types';
import { assertV2ObjectsAvailable, readCalendarV2Capabilities } from './capabilities';
import {
  CalendarV2Error,
  CalendarV2PreconditionError,
  invalidValue,
  readOnly,
  toV2Issue,
  v2ErrorFrom,
  validationFailed,
} from './errors';
import {
  applyScopedPatch,
  assertScope,
  changedKeys,
  conflictingKeys,
  planScopedDelete,
  planThisAndFuture,
  scopeInvalid,
  toCoreOps,
} from './series';
import { buildObjectView } from './view';

const log = rootLogger.child({ scope: 'calendar-admin-v2' });

export interface AdminActor {
  userId: string | null;
}

/** Tentativi di GET → PUT dopo un 412 di Radicale (§3.3). */
const MAX_ATTEMPTS = 3;
/** Timeout del GET diretto nelle letture (oltre si risponde dall'indice). */
const READ_GET_TIMEOUT_MS = 3_000;
const ARCHIVE_MESSAGE = 'Calendario d\'archivio della Fase 0: sola lettura';
const UNSUPPORTED_COMPONENT_MESSAGE = 'Questo elemento non è un evento (attività o note): per ora non si modifica da qui';
/** Attore delle righe di audit e della sync dopo la scrittura. */
const ACTOR = 'admin';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════════════════════════════════════════════════════════
// Validazione delle richieste (zod)
// ═══════════════════════════════════════════════════════════════════

const MAX_TEXT = 64 * 1024;
const MAX_OPS = 50;
const MAX_ALARMS = 20;
const MAX_ATTENDEES = 200;
const MAX_PROPERTIES_PER_NAME = 50;
const MAX_LIST = 2_000;
const MAX_CATEGORIES = 100;
const PROPERTY_NAME_RE = /^[A-Z][A-Z0-9-]*$/;
const UID_RE = /^[A-Za-z0-9@._-]{1,255}$/;
const RESERVED: ReadonlySet<string> = new Set(CAL_V2_RESERVED_PROPERTIES);

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const text = z.string().max(MAX_TEXT);

const zoneSchema = z.union([
  z.object({ kind: z.literal('utc') }).strict(),
  z.object({ kind: z.literal('floating') }).strict(),
  z.object({ kind: z.literal('tzid'), tzid: z.string().min(1).max(200) }).strict(),
]);
const dateSchema = z.object({ type: z.literal('date'), year: int(1, 9999), month: int(1, 12), day: int(1, 31) }).strict();
const dateTimeSchema = z
  .object({
    type: z.literal('date-time'),
    year: int(1, 9999),
    month: int(1, 12),
    day: int(1, 31),
    hour: int(0, 23),
    minute: int(0, 59),
    second: int(0, 60),
    zone: zoneSchema,
  })
  .strict();
const timeSchema = z.union([dateSchema, dateTimeSchema]);
const durationSchema = z
  .object({ negative: z.boolean(), weeks: int(0, 100_000), days: int(0, 1_000_000), hours: int(0, 100_000_000), minutes: int(0, 1_000_000_000), seconds: int(0, 100_000_000_000) })
  .strict();
const periodSchema = z
  .object({ type: z.literal('period'), start: dateTimeSchema, end: dateTimeSchema.nullable(), duration: durationSchema.nullable() })
  .strict();
const paramSchema = z.object({ name: z.string().min(1).max(100), values: z.array(z.string().max(2_000)).max(50) }).strict();
const propertySchema = z
  .object({ name: z.string().min(1).max(100), params: z.array(paramSchema).max(50), value: text })
  .strict();
interface ComponentShape {
  name: string;
  properties: Array<z.infer<typeof propertySchema>>;
  components: ComponentShape[];
}
const componentSchema: z.ZodType<ComponentShape> = z.lazy(() =>
  z.object({ name: z.string().min(1).max(100), properties: z.array(propertySchema).max(200), components: z.array(componentSchema).max(10) }).strict(),
);
const geoSchema = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict();

/** Schema del valore di ogni campo (§4 `CalV2FieldValues`). */
const FIELD_VALUE_SCHEMAS = {
  summary: text.nullable(),
  description: text.nullable(),
  location: text.nullable(),
  url: z.string().max(2_000).nullable(),
  status: z.enum(['CONFIRMED', 'TENTATIVE', 'CANCELLED']).nullable(),
  transp: z.enum(['OPAQUE', 'TRANSPARENT']).nullable(),
  class: z.string().max(100).nullable(),
  priority: int(0, 9).nullable(),
  categories: z.array(z.string().max(500)).max(MAX_CATEGORIES),
  color: z.string().max(100).nullable(),
  geo: geoSchema.nullable(),
  start: timeSchema,
  end: timeSchema.nullable(),
  duration: durationSchema.nullable(),
  rrule: z.string().max(2_000).nullable(),
  rdates: z.array(z.union([timeSchema, periodSchema])).max(MAX_LIST),
  exdates: z.array(timeSchema).max(MAX_LIST),
  alarms: z.array(componentSchema).max(MAX_ALARMS),
  organizer: propertySchema.nullable(),
  attendees: z.array(propertySchema).max(MAX_ATTENDEES),
} as const;

const scopeSchema = z.enum(CAL_V2_SCOPES, { errorMap: () => ({ message: 'scope non valido' }) });

function zodIssues(error: z.ZodError): CalV2Issue[] {
  return error.issues.slice(0, 30).map((i) => ({
    code: 'VALIDATION_FAILED',
    severity: 'error' as const,
    message: `${i.path.join('.') || 'richiesta'}: ${i.message}`.slice(0, 300),
    ...(i.path.length ? { property: String(i.path[0]).slice(0, 60) } : {}),
  }));
}

/** Proprietà non tipizzate per nome: stesse regole di 'set_property'. */
function checkRawProperties(name: string, properties: ReadonlyArray<{ name: string }>, ctx: z.RefinementCtx, path: Array<string | number>): void {
  if (!PROPERTY_NAME_RE.test(name)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `nome di proprietà non valido: "${name.slice(0, 40)}"` });
  } else if (RESERVED.has(name)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `${name} si modifica con il campo tipizzato, non come proprietà` });
  }
  if (properties.length > MAX_PROPERTIES_PER_NAME) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `al massimo ${MAX_PROPERTIES_PER_NAME} proprietà ${name.slice(0, 40)}` });
  }
  properties.forEach((p, i) => {
    if (p.name !== name) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, i, 'name'], message: `deve essere uguale a "${name.slice(0, 40)}"` });
  });
}

const opSchema = z
  .object({
    op: z.enum(['set', 'set_property']),
    field: z.enum(CAL_V2_FIELDS).optional(),
    value: z.unknown().optional(),
    name: z.string().max(100).optional(),
    properties: z.array(propertySchema).max(MAX_PROPERTIES_PER_NAME).optional(),
  })
  .strict()
  .superRefine((op, ctx) => {
    if (op.op === 'set') {
      if (!op.field) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['field'], message: 'campo mancante' });
        return;
      }
      if (op.name !== undefined || op.properties !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['op'], message: '"set" non accetta name né properties' });
      }
      const parsed = FIELD_VALUE_SCHEMAS[op.field].safeParse(op.value);
      if (!parsed.success) {
        for (const i of parsed.error.issues) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value', ...i.path], message: `${op.field}: ${i.message}` });
      }
    } else {
      if (!op.name || !op.properties) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: '"set_property" richiede name e properties' });
        return;
      }
      if (op.field !== undefined || op.value !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['op'], message: '"set_property" non accetta field né value' });
      }
      checkRawProperties(op.name, op.properties, ctx, ['properties']);
    }
  });

const opsSchema = z
  .array(opSchema)
  // Zero op solo con move_to_calendar_id: il controllo "almeno una modifica" è su patchRequestSchema.
  .min(0)
  .max(MAX_OPS, `al massimo ${MAX_OPS} modifiche`)
  .superRefine((ops, ctx) => {
    const seen = new Set<string>();
    ops.forEach((op, i) => {
      const key = op.op === 'set' ? `f:${op.field}` : `p:${op.name}`;
      if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: `${op.op === 'set' ? op.field : op.name} indicato più di una volta` });
      seen.add(key);
    });
  });

const patchRequestSchema = z
  .object({
    target: z.object({ recurrence_key: z.string().max(40) }).strict(),
    scope: scopeSchema,
    ops: opsSchema,
    base: z.record(z.string().max(100), z.string().max(64)).refine((b) => Object.keys(b).length <= 200, 'base troppo grande'),
    move_to_calendar_id: z.string().max(64).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.ops.length === 0 && r.move_to_calendar_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ops'], message: 'almeno una modifica' });
    }
  });

const rawPropertiesSchema = z
  .record(z.string().max(100), z.array(propertySchema).max(MAX_PROPERTIES_PER_NAME))
  .superRefine((props, ctx) => {
    for (const [name, list] of Object.entries(props)) checkRawProperties(name, list, ctx, [name]);
  });

const createRequestSchema = z
  .object({
    calendar_id: z.string().min(1).max(64),
    uid: z.string().regex(UID_RE, 'uid non valido').optional(),
    fields: z
      .object({ start: FIELD_VALUE_SCHEMAS.start })
      .catchall(z.unknown())
      .superRefine((fields, ctx) => {
        for (const [name, value] of Object.entries(fields)) {
          if (name === 'start') continue;
          if (!Object.prototype.hasOwnProperty.call(FIELD_VALUE_SCHEMAS, name)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'campo sconosciuto' });
            continue;
          }
          const parsed = FIELD_VALUE_SCHEMAS[name as keyof typeof FIELD_VALUE_SCHEMAS].safeParse(value);
          if (!parsed.success) {
            for (const i of parsed.error.issues) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name, ...i.path], message: i.message });
          }
        }
      }),
    properties: rawPropertiesSchema.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

/** Corpo di PATCH validato (400 VALIDATION_FAILED con `details.issues`). */
export function parsePatchRequest(raw: unknown): CalV2PatchRequest {
  // Uno scope fuori dall'elenco non è una combinazione ammessa: SCOPE_INVALID, non un errore di forma.
  if (raw !== null && typeof raw === 'object' && 'scope' in raw && !(CAL_V2_SCOPES as readonly unknown[]).includes((raw as { scope: unknown }).scope)) {
    throw scopeInvalid('scope non valido: ammessi this, this_and_future e all');
  }
  const parsed = patchRequestSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta di modifica non valida', zodIssues(parsed.error));
  const req = parsed.data as unknown as CalV2PatchRequest;
  if (req.target.recurrence_key !== MASTER_RECURRENCE_KEY && !isRecurrenceKey(req.target.recurrence_key)) {
    throw invalidValue('recurrence_key non valida', 'target');
  }
  if (req.move_to_calendar_id !== undefined && req.scope !== 'all') {
    throw scopeInvalid('Lo spostamento in un altro calendario vale solo per tutto l\'evento (scope "all")');
  }
  return req;
}

/** Corpo di POST validato. */
export function parseCreateRequest(raw: unknown): CalV2CreateRequest {
  const parsed = createRequestSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta di creazione non valida', zodIssues(parsed.error));
  return parsed.data as unknown as CalV2CreateRequest;
}

// ═══════════════════════════════════════════════════════════════════
// Risoluzione e lettura
// ═══════════════════════════════════════════════════════════════════

interface Resolved {
  /** Id risolto (master o override). */
  id: string;
  /** Id della risorsa (recurrence key ''). */
  objectId: string;
  /** Chiave del componente indicato dall'id (override), '' per il master. */
  recurrenceKey: string;
  href: string;
  calendar: SidecarRow;
}

function notFound(message = 'Evento non trovato'): CalendarV2Error {
  return new CalendarV2Error('NOT_FOUND', 404, message);
}

function targetGone(key: string): CalendarV2Error {
  return new CalendarV2Error('RECURRENCE_TARGET_GONE', 409, 'L\'occorrenza non esiste più nella serie: ricarica l\'evento e riprova', { recurrence_key: key });
}

/** `:id` = id della risorsa, id di un override o UID (§3.2). */
async function resolve(ref: string): Promise<Resolved> {
  const res = await resolveEventRef(sql, ref);
  if (res.kind === 'not_found') throw notFound();
  if (res.kind === 'ambiguous') {
    throw new CalendarV2Error('AMBIGUOUS_REF', 409, 'Più eventi con questo UID: indica l\'id', {
      candidates: res.candidates.slice(0, 5).map((c) => ({ id: c.id, calendar_id: c.calendarId, collection: c.collectionName, href: c.href })),
    });
  }
  const calendar = await sidecarById(res.calendarId, { activeOnly: true });
  if (!calendar) throw notFound();
  return { id: res.id, objectId: res.objectId, recurrenceKey: res.recurrenceKey, href: res.href, calendar };
}

interface IndexRow {
  id: string;
  uid: string | null;
  etag: string | null;
  component: string;
  raw_ics: string | null;
  health: CalV2ObjectView['health'];
  health_reason: string | null;
}

async function indexRow(calendarId: string, href: string): Promise<IndexRow | null> {
  const [row] = await sql<IndexRow[]>`
    SELECT id, uid, etag, component, raw_ics, health, health_reason
    FROM cal_objects WHERE calendar_id = ${calendarId}::uuid AND href = ${href}
  `;
  return row ?? null;
}

async function collectionHealthOf(calendarId: string): Promise<CalV2ObjectView['collection_health']> {
  const [row] = await sql<Array<{ health: CalV2ObjectView['collection_health'] }>>`
    SELECT health FROM cal_collection_state WHERE calendar_id = ${calendarId}::uuid
  `;
  return row?.health ?? 'healthy';
}

async function componentIdsOf(calendarId: string, href: string): Promise<Map<string, string>> {
  const rows = await sql<Array<{ recurrence_key: string; id: string }>>`
    SELECT recurrence_key, id FROM cal_object_ids
    WHERE calendar_id = ${calendarId}::uuid AND href = ${href} AND retired_at IS NULL
  `;
  return new Map(rows.map((r) => [r.recurrence_key, r.id]));
}

async function displayCalendarId(cal: SidecarRow): Promise<string> {
  if (cal.role !== 'subscription') return cal.id;
  const [row] = await sql<Array<{ calendar_id: string }>>`
    SELECT calendar_id FROM calendar_subscriptions WHERE collection_calendar_id = ${cal.id}::uuid LIMIT 1
  `;
  return row?.calendar_id ?? cal.parent_calendar_id ?? cal.id;
}

/** Testo, ETag e oggetto di una risorsa, da Radicale o (ripiego) dall'indice. */
interface Snapshot {
  resolved: Resolved;
  raw: string;
  etag: string | null;
  object: CalendarObject | null;
  parseError: string | null;
  source: 'radicale' | 'index';
}

function parsed(raw: string): { object: CalendarObject | null; parseError: string | null } {
  const res = parseCalendarObject(raw);
  return res.ok ? { object: res.value, parseError: null } : { object: null, parseError: res.error.message };
}

/** GET diretto come le letture dello store (identità verificata, timeout breve); null = non disponibile, 'missing' = 404. */
async function readLive(cal: SidecarRow, href: string): Promise<CurrentObject | 'missing' | null> {
  if (cal.role === 'subscription' || !isValidCollectionName(cal.collection_name) || !isValidObjectName(href)) return null;
  const rt = radicaleRuntime();
  if (!rt.client) return null;
  try {
    const { check } = await verifyVolumeIdentity({ db: sql });
    if (check.status !== 'ok') return null;
    const res = await rt.client.get(objectPath(rt.principal, cal.collection_name, href), { timeoutMs: READ_GET_TIMEOUT_MS });
    const p = parsed(res.body);
    return { raw: res.body, etag: res.etag, object: p.object, parseError: p.parseError };
  } catch (err) {
    if (isRadicaleError(err, 'not_found')) return 'missing';
    log.warn({ err: isRadicaleError(err) ? err.toLog() : err, calendarId: cal.id }, 'GET diretto non riuscito: rispondo dall\'indice');
    return null;
  }
}

async function snapshotOf(resolved: Resolved): Promise<Snapshot> {
  const live = await readLive(resolved.calendar, resolved.href);
  if (live === 'missing') throw notFound();
  if (live) return { resolved, raw: live.raw, etag: live.etag, object: live.object, parseError: live.parseError, source: 'radicale' };
  const row = await indexRow(resolved.calendar.id, resolved.href);
  if (!row) throw notFound();
  const raw = row.raw_ics ?? '';
  if (!raw) return { resolved, raw, etag: row.etag, object: null, parseError: 'Testo non disponibile', source: 'index' };
  const p = parsed(raw);
  return { resolved, raw, etag: row.etag, object: p.object, parseError: p.parseError, source: 'index' };
}

/** Motivo di sola lettura (§3.9) in ordine di precedenza. */
function readonlyReasonOf(cal: SidecarRow, obj: CalendarObject | null, writable: boolean): CalV2ReadonlyReason | null {
  if (cal.role === 'subscription') return 'subscription';
  if (cal.origin === 'migration') return 'archive';
  if (!obj) return 'unreadable';
  if (obj.componentType !== 'VEVENT') return 'component_unsupported';
  return writable ? null : 'writes_suspended';
}

interface ViewOptions {
  /** Garantisce un component_id per il target (override appena scritto). */
  ensureTargetId?: boolean;
}

async function viewOf(s: Snapshot, targetKey: string | null, opts: ViewOptions = {}): Promise<CalV2ObjectView> {
  const cal = s.resolved.calendar;
  const [row, collectionHealth, ids, caps, displayId, bookingActive] = await Promise.all([
    indexRow(cal.id, s.resolved.href),
    collectionHealthOf(cal.id),
    componentIdsOf(cal.id, s.resolved.href),
    readCalendarV2Capabilities(),
    displayCalendarId(cal),
    isActiveBookingProjection(cal, s.resolved.href),
  ]);
  const obj = s.object;
  const tz = safeTz(cal.timezone);
  const provenance = deriveProvenance({ role: cal.role, href: s.resolved.href, component: obj?.master ?? obj?.overrides[0] ?? null, uid: obj?.uid ?? row?.uid ?? null });
  const notices: CalV2Notice[] = [];
  const deleteBlocked: CalV2DeleteBlockedReason | null = bookingActive ? 'booking_active' : null;
  const view = buildObjectView(s.raw, obj, s.parseError, targetKey, {
    objectId: s.resolved.objectId || row?.id || '',
    calendarId: displayId,
    calendarTz: tz,
    href: s.resolved.href,
    etag: s.etag,
    source: s.source,
    health: row?.health ?? 'ok',
    healthReason: row?.health_reason ?? null,
    collectionHealth,
    provenance,
    readonlyReason: readonlyReasonOf(cal, obj, caps.objects.write),
    deleteBlockedReason: deleteBlocked,
    notices,
    componentIds: ids,
    now: new Date(),
    uid: row?.uid ?? null,
    componentType: row?.component === 'VTODO' || row?.component === 'VJOURNAL' ? row.component : 'VEVENT',
  });
  // Un override appena scritto ha già la sua posizione in Radicale: se il write-through non l'ha ancora indicizzata si prenota l'id.
  const target = view.target;
  if (opts.ensureTargetId && obj && target?.is_override && !target.component_id) {
    const id = await positionId(cal.id, s.resolved.href, target.recurrence_key, obj.uid);
    target.component_id = id;
    const listed = view.overrides.find((o) => o.recurrence_key === target.recurrence_key);
    if (listed) listed.component_id = id;
  }
  return view;
}

function masterStartOf(obj: CalendarObject): IcsTime | null {
  const p = obj.master ? getProperty(obj.master, 'DTSTART') : null;
  if (!p) return null;
  try {
    return readTimeProperty(p);
  } catch {
    return null;
  }
}

function isRecurring(obj: CalendarObject): boolean {
  return Boolean(obj.master && (getProperty(obj.master, 'RRULE') || getProperty(obj.master, 'RDATE')));
}

/** Chiave dell'istanza che inizia a `iso`, tipizzata come il DTSTART del master (§3.2). */
function keyForOriginalStart(obj: CalendarObject, iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw invalidValue('original_start non valido', 'original_start');
  if (!isRecurring(obj)) return MASTER_RECURRENCE_KEY;
  const start = masterStartOf(obj);
  if (!start) throw invalidValue('Evento senza inizio leggibile', 'DTSTART');
  const ctx: ZoneContext = { tz, timezones: obj.timezones };
  return recurrenceKeyOf(utcMsToTime(ms, start, ctx), ctx);
}

/** Istante ISO dell'istanza indicata da una chiave (per la saga "questa e le successive"). */
function isoForKey(obj: CalendarObject, key: string, tz: string): string {
  const start = masterStartOf(obj);
  if (!start) throw invalidValue('Evento senza inizio leggibile', 'DTSTART');
  const ctx: ZoneContext = { tz, timezones: obj.timezones };
  return timeToIso(recurrenceKeyToTime(key, start, ctx), ctx);
}

// ═══════════════════════════════════════════════════════════════════
// Letture
// ═══════════════════════════════════════════════════════════════════

export async function readObjectV2(ref: string, target: { recurrenceKey?: string; originalStart?: string }): Promise<CalV2ObjectView> {
  await assertV2ObjectsAvailable();
  if (target.recurrenceKey !== undefined && target.originalStart !== undefined) {
    throw invalidValue('Indica recurrence_key oppure original_start, non entrambi', 'recurrence_key');
  }
  const resolved = await resolve(ref);
  const snap = await snapshotOf(resolved);
  let key: string | null = null;
  if (snap.object) {
    const tz = safeTz(resolved.calendar.timezone);
    if (target.recurrenceKey !== undefined) {
      if (target.recurrenceKey !== MASTER_RECURRENCE_KEY && !isRecurrenceKey(target.recurrenceKey)) throw invalidValue('recurrence_key non valida', 'recurrence_key');
      key = target.recurrenceKey;
    } else if (target.originalStart !== undefined) {
      key = keyForOriginalStart(snap.object, target.originalStart, tz);
    } else if (resolved.recurrenceKey !== MASTER_RECURRENCE_KEY) {
      key = resolved.recurrenceKey;
    }
  }
  const view = await viewOf(snap, key);
  if (key !== null && !view.target) throw targetGone(key);
  return view;
}

export async function readObjectIcsV2(ref: string): Promise<{ ics: string; etag: string | null; uid: string }> {
  await assertV2ObjectsAvailable();
  const resolved = await resolve(ref);
  const snap = await snapshotOf(resolved);
  const row = snap.object ? null : await indexRow(resolved.calendar.id, resolved.href);
  const uid = snap.object?.uid ?? row?.uid ?? /^UID(?:;[^:\r\n]*)?:([^\r\n]*)/im.exec(snap.raw)?.[1]?.trim() ?? resolved.href.replace(/\.ics$/i, '');
  return { ics: snap.raw, etag: snap.etag, uid };
}

// ═══════════════════════════════════════════════════════════════════
// Scritture: utilità
// ═══════════════════════════════════════════════════════════════════

function normalizeEtag(etag: string | null | undefined): string {
  return (etag ?? '').trim().replace(/^W\//, '');
}

/** If-Match: un ETag esatto; assente o `*` → 428. */
export function requireIfMatch(ifMatch: string | null | undefined): string {
  const value = normalizeEtag(ifMatch);
  if (value === '' || value === '*') {
    throw new CalendarV2Error('PRECONDITION_REQUIRED', 428, 'Manca l\'header If-Match con l\'ETag dell\'evento letto: ricarica l\'evento e riprova');
  }
  return value;
}

function assertWritableCalendar(cal: SidecarRow): void {
  if (cal.role === 'subscription') throw readOnly(ICS_READ_ONLY_MESSAGE, 'subscription');
  if (cal.origin === 'migration') throw readOnly(ARCHIVE_MESSAGE, 'archive');
}

/** Oggetto illeggibile o non-VEVENT: nessuna scrittura (la DELETE `all` di un illeggibile è ammessa dal chiamante). */
function assertEditableObject(current: CurrentObject): CalendarObject {
  if (!current.object) throw readOnly(UNREADABLE_EVENT_MESSAGE, 'unreadable');
  if (current.object.componentType !== 'VEVENT') throw readOnly(UNSUPPORTED_COMPONENT_MESSAGE, 'component_unsupported');
  return current.object;
}

/** Il piano si ferma: la versione del server non è fondibile con la richiesta (412). */
class PreconditionMarker extends Error {
  constructor(readonly conflicts: CalV2FieldConflict[]) {
    super('precondition');
    this.name = 'PreconditionMarker';
  }
}

/** Piano → errore v2 (gli errori di calendar-core diventano 400/409 con i loro dettagli). */
function planError(err: unknown): unknown {
  return v2ErrorFrom(err) ?? err;
}

/** Le issue di un errore di validazione (400 VALIDATION_FAILED), altrimenti null: in dryRun non sono un errore ma `valid: false`. */
function validationIssuesOf(err: unknown): CalV2Issue[] | null {
  const v2 = v2ErrorFrom(err);
  if (!v2 || v2.code !== 'VALIDATION_FAILED') return null;
  return (v2.details?.issues as CalV2Issue[] | undefined) ?? [{ code: 'INVALID_VALUE', severity: 'error', message: v2.message }];
}

function validate(obj: CalendarObject, cal: SidecarRow, previous: CalendarObject | null, now: Date): { ok: boolean; issues: CalV2Issue[] } {
  const res = validateObject(obj, { tz: safeTz(cal.timezone), allowedComponents: allowedComponents(cal), previous, now });
  return { ok: res.ok, issues: res.issues.map((i: ValidationIssue) => toV2Issue(i)) };
}

function serialized(obj: CalendarObject, fallback: string): string {
  try {
    return serializeObject(obj, { prodid: 'preserve' });
  } catch {
    return fallback;
  }
}

/** Vista del server dopo un 412: lettura fresca, così il client rifà la modifica sulla versione più nuova. */
async function currentForPrecondition(resolved: Resolved, key: string): Promise<CalV2ObjectView> {
  const fresh = await locateFresh(resolved);
  return viewOf(await snapshotOf(fresh), key);
}

/** Rilegge la posizione (la risorsa può essere stata spostata da un device). */
async function locateFresh(resolved: Resolved): Promise<Resolved> {
  try {
    return await resolve(resolved.objectId || resolved.id);
  } catch {
    return resolved;
  }
}

interface AuditArgs {
  operation: 'v2.patch' | 'v2.patch+move' | 'v2.create' | 'v2.delete';
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  recordId: string | null;
  calendar: SidecarRow;
  href: string;
  etagBefore: string | null;
  etagAfter: string | null;
  changed: readonly string[];
  scope?: CalV2Scope;
  actor: AdminActor;
  extra?: Record<string, unknown>;
}

/** Riga in audit_logs: collezione, href, ETag prima e dopo, campi cambiati e scope; mai il testo. */
async function auditV2(a: AuditArgs): Promise<void> {
  await audit({
    action: a.action,
    recordId: a.recordId,
    operation: a.operation,
    calendar: a.calendar,
    href: a.href,
    etagBefore: a.etagBefore,
    etagAfter: a.etagAfter,
    changed: a.changed,
    actor: ACTOR,
    extra: { ...(a.scope ? { scope: a.scope } : {}), ...(a.actor.userId ? { user_id: a.actor.userId } : {}), ...(a.extra ?? {}) },
  });
}

function result(partial: Partial<CalV2WriteResult> & Pick<CalV2WriteResult, 'object' | 'etag'>): CalV2WriteResult {
  return {
    changed: [],
    noop: false,
    merged: false,
    sequence_bumped: false,
    orphaned_overrides: [],
    dry_run: false,
    valid: true,
    issues: [],
    ...partial,
  };
}

// ═══════════════════════════════════════════════════════════════════
// PATCH
// ═══════════════════════════════════════════════════════════════════

interface PatchDecision {
  kind: 'noop' | 'put';
  object: CalendarObject;
  previous: CalendarObject;
  changed: string[];
  sequenceBumped: boolean;
  merged: boolean;
  orphaned: string[];
  targetKey: string;
  issues: CalV2Issue[];
  valid: boolean;
}

interface PatchInput {
  key: string;
  scope: 'this' | 'all';
  req: CalV2PatchRequest;
  ifMatch: string;
  cal: SidecarRow;
  /** Solo dryRun: gli errori di validazione non lanciano ma restituiscono issue. */
  lenient: boolean;
}

/** Decisione di una PATCH su un testo: ETag, conflitti, scope e validazione (§3.3, §3.5). */
function decidePatch(current: CurrentObject, input: PatchInput): PatchDecision {
  const obj = assertEditableObject(current);
  const tz = safeTz(input.cal.timezone);
  const now = new Date();
  const ctx = { tz, now };
  let merged = false;
  try {
    // Uno spostamento senza modifiche ai campi chiede l'ETag esatto, come la DELETE, e non passa per la fusione.
    if (input.req.ops.length === 0 && normalizeEtag(current.etag) !== input.ifMatch) throw new PreconditionMarker([]);
    if (normalizeEtag(current.etag) !== input.ifMatch) {
      const conflicts = conflictingKeys(obj, input.key, input.scope, input.req.ops, input.req.base, ctx);
      if (conflicts.length > 0) throw new PreconditionMarker(conflicts);
      merged = true;
    }
    const res = applyScopedPatch(obj, input.key, input.scope, input.req.ops, ctx);
    if (res.noop) {
      return { kind: 'noop', object: obj, previous: obj, changed: [], sequenceBumped: false, merged: false, orphaned: res.orphanedOverrides, targetKey: input.key, issues: [], valid: true };
    }
    const check = validate(res.object, input.cal, obj, now);
    if (!check.ok && !input.lenient) {
      throw validationFailed(check.issues.find((i) => i.severity === 'error')?.message ?? 'Evento non valido', check.issues);
    }
    return {
      kind: 'put',
      object: res.object,
      previous: obj,
      changed: res.changed,
      sequenceBumped: res.sequenceBumped,
      merged,
      orphaned: res.orphanedOverrides,
      targetKey: res.targetKey,
      issues: check.issues,
      valid: check.ok,
    };
  } catch (err) {
    if (err instanceof PreconditionMarker) throw err;
    throw planError(err);
  }
}

async function resolveMoveDestination(req: CalV2PatchRequest, cal: SidecarRow): Promise<SidecarRow | null> {
  if (req.move_to_calendar_id === undefined) return null;
  if (req.scope !== 'all') throw scopeInvalid('Lo spostamento in un altro calendario vale solo per tutto l\'evento (scope "all")');
  if (!UUID_RE.test(req.move_to_calendar_id)) throw notFound('Calendario di destinazione non trovato');
  const dest = await sidecarById(req.move_to_calendar_id, { activeOnly: true });
  if (!dest) throw notFound('Calendario di destinazione non trovato');
  if (dest.id === cal.id) return null;
  assertWritableCalendar(dest);
  if (!allowedComponents(dest).includes('VEVENT')) throw readOnly('Il calendario di destinazione non accetta eventi', 'component_unsupported');
  return dest;
}

export async function patchObjectV2(ref: string, ifMatch: string, req: CalV2PatchRequest, actor: AdminActor): Promise<CalV2WriteResult> {
  await assertV2ObjectsAvailable();
  const ifm = requireIfMatch(ifMatch);
  const resolved = await resolve(ref);
  const cal = resolved.calendar;
  assertWritableCalendar(cal);
  const key = req.target.recurrence_key;
  const dest = await resolveMoveDestination(req, cal);
  if (req.scope === 'this_and_future') return patchThisAndFuture(resolved, key, ifm, req, actor);
  return patchInPlace(resolved, key, req.scope, ifm, req, dest, actor);
}

/** Scope 'this' e 'all' (e 'this_and_future' sulla prima istanza): GET → decisione → PUT → eventuale MOVE. */
async function patchInPlace(
  resolved: Resolved,
  key: string,
  scope: 'this' | 'all',
  ifm: string,
  req: CalV2PatchRequest,
  dest: SidecarRow | null,
  actor: AdminActor,
  wholeSeries = false,
): Promise<CalV2WriteResult> {
  const cal = resolved.calendar;
  const base: Omit<PatchInput, 'lenient'> = { key, scope, req, ifMatch: ifm, cal };

  if (req.dryRun) {
    const { client, principal } = requireRadicale();
    const current = await fetchCurrent(client, objectPath(principal, collectionNameOf(cal), resolved.href), 'l\'evento');
    if (!current) throw notFound();
    try {
      const decision = decidePatch(current, { ...base, lenient: true });
      return await dryRunResult(resolved, current, decision, wholeSeries);
    } catch (err) {
      if (err instanceof PreconditionMarker) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, key), err.conflicts);
      const issues = validationIssuesOf(err);
      if (!issues) throw err;
      // Anteprima di una modifica non valida: l'oggetto com'è, `valid: false` e le issue (non un 400).
      const snap: Snapshot = { resolved, raw: current.raw, etag: current.etag, object: current.object, parseError: current.parseError, source: 'radicale' };
      return result({ object: await viewOf(snap, key), etag: current.etag, dry_run: true, valid: false, issues });
    }
  }

  let missing = false;
  let decision: PatchDecision | null = null;
  let outcome;
  try {
    outcome = await writeObject({
      calendar: cal,
      href: resolved.href,
      what: 'l\'evento',
      maxAttempts: MAX_ATTEMPTS,
      plan: (current) => {
        missing = false;
        decision = null;
        if (!current) {
          missing = true;
          return { action: 'none' };
        }
        const d = decidePatch(current, { ...base, lenient: false });
        decision = d;
        if (d.kind === 'noop') return { action: 'none' };
        return { action: 'put', object: d.object, previous: d.previous, changed: d.changed };
      },
    });
  } catch (err) {
    if (err instanceof PreconditionMarker) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, key), err.conflicts);
    throw err;
  }
  if (missing) throw notFound();
  const d = decision as PatchDecision | null;
  if (!d) throw new Error('PATCH senza decisione');
  const put = outcome.action === 'put';

  // MOVE dopo la PUT (o subito, se gli op non cambiavano nulla).
  let finalCal = cal;
  let finalEtag = put ? outcome.etagAfter : outcome.etagBefore;
  if (dest) {
    try {
      finalEtag = await moveObject(cal, dest, resolved.href, finalEtag);
      finalCal = dest;
    } catch (err) {
      if (put) {
        await writeThrough([cal.id], ACTOR);
        await auditV2({ operation: 'v2.patch', action: 'UPDATE', recordId: resolved.objectId || resolved.id, calendar: cal, href: resolved.href, etagBefore: outcome.etagBefore, etagAfter: outcome.etagAfter, changed: d.changed, scope, actor, extra: { merged: d.merged } });
      }
      if (err instanceof CalendarConflictError || err instanceof EventValidationError) {
        throw new CalendarV2Error('MOVE_CONFLICT', 409, err.message, { patched: put, etag: finalEtag });
      }
      throw err;
    }
  }

  const changed = dest ? [...d.changed, 'calendar_id'] : d.changed;
  if (put || dest) {
    await writeThrough(dest ? [cal.id, dest.id] : [cal.id], ACTOR);
    await auditV2({
      operation: dest ? 'v2.patch+move' : 'v2.patch',
      action: 'UPDATE',
      recordId: resolved.objectId || resolved.id,
      calendar: finalCal,
      href: resolved.href,
      etagBefore: outcome.etagBefore,
      etagAfter: finalEtag,
      changed,
      scope,
      actor,
      extra: { merged: d.merged, ...(dest ? { from_calendar_id: cal.id } : {}), ...(d.targetKey !== MASTER_RECURRENCE_KEY ? { recurrence_key: d.targetKey } : {}) },
    });
  }

  const written = outcome.object ?? d.object;
  const raw = outcome.raw ?? '';
  const movedResolved: Resolved = dest ? { ...resolved, calendar: finalCal } : resolved;
  const snap: Snapshot = { resolved: movedResolved, raw, etag: finalEtag, object: written, parseError: null, source: 'radicale' };
  const view = await viewOf(snap, d.targetKey, { ensureTargetId: put && d.targetKey !== MASTER_RECURRENCE_KEY });
  const noop = !put && !dest;
  return result({
    object: view,
    etag: finalEtag,
    changed: noop ? [] : changed,
    noop,
    merged: put && d.merged,
    sequence_bumped: d.sequenceBumped,
    ...(wholeSeries ? { whole_series: true } : {}),
    orphaned_overrides: d.orphaned,
    issues: d.issues,
    valid: true,
  });
}

/** dryRun: la vista del risultato con l'ETag invariato, senza gate, PUT, MOVE né audit (§3.5). */
async function dryRunResult(resolved: Resolved, current: CurrentObject, d: PatchDecision, wholeSeries: boolean): Promise<CalV2WriteResult> {
  const raw = d.kind === 'put' ? serialized(d.object, current.raw) : current.raw;
  const snap: Snapshot = { resolved, raw, etag: current.etag, object: d.object, parseError: null, source: 'radicale' };
  const view = await viewOf(snap, d.targetKey);
  return result({
    object: view,
    etag: current.etag,
    changed: d.changed,
    noop: d.kind === 'noop',
    merged: d.kind === 'put' && d.merged,
    sequence_bumped: d.sequenceBumped,
    ...(wholeSeries ? { whole_series: true } : {}),
    orphaned_overrides: d.orphaned,
    dry_run: true,
    valid: d.valid,
    issues: d.issues,
  });
}

// ─── Questa e le successive ───────────────────────────────

async function patchThisAndFuture(resolved: Resolved, key: string, ifm: string, req: CalV2PatchRequest, actor: AdminActor): Promise<CalV2WriteResult> {
  const cal = resolved.calendar;
  const tz = safeTz(cal.timezone);
  const core = toCoreOps(req.ops);
  const snap = await snapshotOf(resolved);
  const obj = assertEditableObject({ raw: snap.raw, etag: snap.etag, object: snap.object, parseError: snap.parseError });
  assertScope(obj, key, 'this_and_future', core);

  const now = new Date();
  let plan;
  try {
    plan = planThisAndFuture(obj, key, req.ops, { tz, now });
  } catch (err) {
    const issues = req.dryRun ? validationIssuesOf(err) : null;
    if (issues) return result({ object: await viewOf(snap, key), etag: snap.etag, dry_run: true, valid: false, issues });
    throw planError(err);
  }
  // Primo evento della serie: come "tutta la serie".
  if (plan.wholeSeries) return patchInPlace(resolved, key, 'all', ifm, req, null, actor, true);

  const changed = changedKeys(obj, key, req.ops, { tz, now });
  const mergedHolder = { merged: false };
  const conflictsAt = (current: CalendarObject, etag: string | null): CalV2FieldConflict[] => {
    if (normalizeEtag(etag) === ifm) return [];
    mergedHolder.merged = true;
    return conflictingKeys(current, key, 'this_and_future', req.ops, req.base, { tz, now: new Date() });
  };

  if (req.dryRun) {
    const conflicts = conflictsAt(obj, snap.etag);
    if (conflicts.length) throw new CalendarV2PreconditionError(await viewOf(snap, key), conflicts);
    const check = validate(plan.tail, cal, null, now);
    const headCheck = plan.head ? validate(plan.head, cal, obj, now) : { ok: true, issues: [] };
    const headSnap: Snapshot = { resolved, raw: plan.head ? serialized(plan.head, snap.raw) : snap.raw, etag: snap.etag, object: plan.head, parseError: null, source: 'radicale' };
    const tailResolved: Resolved = { ...resolved, id: '', objectId: '', href: `${plan.tail.uid}.ics` };
    const tailSnap: Snapshot = { resolved: tailResolved, raw: serialized(plan.tail, ''), etag: null, object: plan.tail, parseError: null, source: 'radicale' };
    return result({
      object: await viewOf(headSnap, null),
      tail: await viewOf(tailSnap, MASTER_RECURRENCE_KEY),
      etag: snap.etag,
      changed,
      noop: changed.length === 0,
      merged: mergedHolder.merged,
      sequence_bumped: changed.some((c) => ['start', 'end', 'duration', 'rrule', 'rdates', 'exdates', 'location', 'status'].includes(c)),
      dry_run: true,
      valid: check.ok && headCheck.ok,
      issues: [...headCheck.issues, ...check.issues],
    });
  }

  if (changed.length === 0) {
    // Nessuna modifica effettiva: niente saga (non si divide la serie per niente).
    return result({ object: await viewOf(snap, key), etag: snap.etag, noop: true });
  }

  let etagBefore: string | null = null;
  let saga;
  try {
    saga = await splitRecurringEvent({
      masterEventId: resolved.objectId,
      originalStartIso: isoForKey(obj, key, tz),
      ops: core as PatchOp[],
      precheck: ({ etag, object }) => {
        etagBefore = etag;
        let conflicts: CalV2FieldConflict[];
        try {
          conflicts = conflictsAt(object, etag);
        } catch (err) {
          throw planError(err);
        }
        if (conflicts.length) throw new PreconditionMarker(conflicts);
      },
    });
  } catch (err) {
    if (err instanceof PreconditionMarker) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, key), err.conflicts);
    throw planError(err);
  }
  if (saga.wholeSeries) return patchInPlace(resolved, key, 'all', ifm, req, null, actor, true);

  // Vecchia serie troncata e nuova serie: due letture fresche.
  const headFresh = await snapshotOf(await locateFresh(resolved));
  const tailResolved = await resolve(saga.tail.id);
  const tailSnap = await snapshotOf(tailResolved);
  await auditV2({
    operation: 'v2.patch',
    action: 'UPDATE',
    recordId: resolved.objectId || resolved.id,
    calendar: cal,
    href: resolved.href,
    etagBefore,
    etagAfter: headFresh.etag,
    changed,
    scope: 'this_and_future',
    actor,
    extra: { merged: mergedHolder.merged, recurrence_key: key, tail_href: tailResolved.href },
  });
  return result({
    object: await viewOf(headFresh, null),
    tail: await viewOf(tailSnap, MASTER_RECURRENCE_KEY, { ensureTargetId: false }),
    etag: headFresh.etag,
    changed,
    merged: mergedHolder.merged,
    sequence_bumped: true,
  });
}

// ═══════════════════════════════════════════════════════════════════
// POST
// ═══════════════════════════════════════════════════════════════════

const CREATE_FIELD_ORDER = [
  'summary', 'description', 'location', 'url', 'status', 'transp', 'class', 'priority', 'categories', 'color', 'geo',
  'end', 'duration', 'rrule', 'rdates', 'exdates', 'alarms', 'organizer', 'attendees',
] as const;

function utcStamp(d: Date): string {
  return formatTimeValue({ type: 'date-time', ...msToWall(d.getTime()), zone: { kind: 'utc' } });
}

/** Nuovo VEVENT (design §5, §8): UID, DTSTAMP, CREATED, LAST-MODIFIED, SEQUENCE:0 e provenienza `admin`. */
function buildNewObject(uid: string, req: CalV2CreateRequest, tz: string, now: Date): { object: CalendarObject; changed: string[] } {
  const f = req.fields as Record<string, unknown> & { start: IcsTime };
  const stamp = utcStamp(now);
  const properties: IcsProperty[] = [
    { name: 'UID', params: [], value: encodeText(uid) },
    { name: 'DTSTAMP', params: [], value: stamp },
    { name: 'CREATED', params: [], value: stamp },
    { name: 'LAST-MODIFIED', params: [], value: stamp },
    { name: 'SEQUENCE', params: [], value: '0' },
    createTimeProperty('DTSTART', f.start),
  ];
  const component: IcsComponent = { name: 'VEVENT', properties, components: [] };
  setProvenance(component, { source: 'admin' });

  const ops: PatchOp[] = [];
  const fields: Record<string, unknown> = { ...f };
  if (fields.status === undefined) fields.status = 'CONFIRMED';
  if (fields.end === undefined && fields.duration === undefined && f.start.type === 'date') {
    // Tutto il giorno senza fine: un giorno (design §8).
    const next = new Date(Date.UTC(f.start.year, f.start.month - 1, f.start.day + 1));
    fields.end = { type: 'date', year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
  }
  if (fields.end == null && fields.duration == null && f.start.type === 'date-time') {
    throw invalidValue('Indica la fine (end) o la durata (duration) dell\'evento', 'DTEND');
  }
  for (const name of CREATE_FIELD_ORDER) {
    if (fields[name] === undefined) continue;
    ops.push({ op: 'set', field: name, value: fields[name] } as PatchOp);
  }
  for (const [name, list] of Object.entries(req.properties ?? {})) {
    ops.push({ op: 'setProperty', name, properties: list.map((p) => ({ name: p.name, params: p.params.map((x) => ({ name: x.name, values: [...x.values] })), value: p.value })) });
  }
  try {
    applyComponentOps(component, ops, { tz, now, timezones: [] });
  } catch (err) {
    throw planError(err);
  }
  // La creazione parte da SEQUENCE 0 anche se i campi applicati l'avrebbero incrementata.
  setProperties(component, 'SEQUENCE', [{ name: 'SEQUENCE', params: [], value: '0' }]);
  const changed = ['start', ...ops.map((o) => (o.op === 'set' ? o.field : `prop:${o.name.toUpperCase()}`))];
  return { object: createCalendarObject({ uid, componentType: 'VEVENT', master: component }), changed };
}

async function existingObjectId(cal: SidecarRow, href: string, uid: string): Promise<string | null> {
  const [byHref] = await sql<Array<{ id: string }>>`
    SELECT id FROM cal_object_ids
    WHERE calendar_id = ${cal.id}::uuid AND href = ${href} AND recurrence_key = '' AND retired_at IS NULL LIMIT 1
  `;
  if (byHref) return byHref.id;
  const [byUid] = await sql<Array<{ id: string }>>`
    SELECT id FROM cal_object_ids
    WHERE calendar_id = ${cal.id}::uuid AND uid = ${uid} AND recurrence_key = '' AND retired_at IS NULL LIMIT 1
  `;
  return byUid?.id ?? null;
}

function objectExists(objectId: string | null): CalendarV2Error {
  return new CalendarV2Error('OBJECT_EXISTS', 409, 'Esiste già un evento con questo identificativo', objectId ? { object_id: objectId } : undefined);
}

export async function createObjectV2(req: CalV2CreateRequest, actor: AdminActor): Promise<CalV2WriteResult> {
  await assertV2ObjectsAvailable();
  if (!UUID_RE.test(req.calendar_id)) throw notFound('Calendario non trovato');
  const cal = await sidecarById(req.calendar_id, { activeOnly: true });
  if (!cal) throw notFound('Calendario non trovato');
  assertWritableCalendar(cal);
  if (!allowedComponents(cal).includes('VEVENT')) throw readOnly('Questo calendario non accetta eventi', 'component_unsupported');
  const tz = safeTz(cal.timezone);
  const now = new Date();
  const generated = req.uid === undefined;

  let uid = req.uid ?? generateEventUid();
  let built: ReturnType<typeof buildNewObject>;
  try {
    built = buildNewObject(uid, req, tz, now);
  } catch (err) {
    const issues = req.dryRun ? validationIssuesOf(err) : null;
    // Anteprima di un evento non valido: nessuna vista, `valid: false` e le issue (non un 400).
    if (issues) return result({ object: null, etag: null, dry_run: true, valid: false, issues });
    throw err;
  }
  const check = validate(built.object, cal, null, now);
  if (!check.ok && !req.dryRun) throw validationFailed(check.issues.find((i) => i.severity === 'error')?.message ?? 'Evento non valido', check.issues);
  const resolvedFor = (id: string, href: string): Resolved => ({ id, objectId: id, recurrenceKey: MASTER_RECURRENCE_KEY, href, calendar: cal });

  if (req.dryRun) {
    const href = hrefForUid(uid);
    const snap: Snapshot = { resolved: resolvedFor('', href), raw: serialized(built.object, ''), etag: null, object: built.object, parseError: null, source: 'radicale' };
    return result({ object: await viewOf(snap, MASTER_RECURRENCE_KEY), etag: null, changed: built.changed, dry_run: true, valid: check.ok, issues: check.issues });
  }

  let href = hrefForUid(uid);
  let outcome;
  for (let round = 0; ; round++) {
    try {
      outcome = await writeObject({
        calendar: cal,
        href,
        what: 'l\'evento',
        maxAttempts: MAX_ATTEMPTS,
        plan: (current) => {
          if (current) throw new CreateCollision();
          return { action: 'put', object: built.object, previous: null };
        },
      });
      break;
    } catch (err) {
      const collision = err instanceof CreateCollision || (err instanceof EventValidationError && /UID già presente/.test(err.message));
      if (!collision) throw err;
      // UID generato che collide: se ne sceglie un altro; UID dell'admin: l'oggetto esiste già (retry dopo un errore di rete).
      if (generated && round < 2) {
        uid = generateEventUid();
        built = buildNewObject(uid, req, tz, new Date());
        href = hrefForUid(uid);
        continue;
      }
      throw objectExists(await existingObjectId(cal, href, uid));
    }
  }

  await writeThrough([cal.id], ACTOR);
  const id = await positionId(cal.id, href, MASTER_RECURRENCE_KEY, uid);
  await auditV2({ operation: 'v2.create', action: 'INSERT', recordId: id, calendar: cal, href, etagBefore: null, etagAfter: outcome.etagAfter, changed: built.changed, actor });
  const snap: Snapshot = { resolved: resolvedFor(id, href), raw: outcome.raw ?? '', etag: outcome.etagAfter, object: outcome.object ?? built.object, parseError: null, source: 'radicale' };
  return result({ object: await viewOf(snap, MASTER_RECURRENCE_KEY), etag: outcome.etagAfter, changed: built.changed, issues: check.issues });
}

class CreateCollision extends Error {
  constructor() {
    super('risorsa già esistente');
    this.name = 'CreateCollision';
  }
}

// ═══════════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════════

interface DeleteDecision {
  action: 'delete' | 'put';
  object?: CalendarObject;
  previous?: CalendarObject;
  changed: string[];
  issues: CalV2Issue[];
  valid: boolean;
}

function decideDelete(current: CurrentObject, cal: SidecarRow, scope: CalV2Scope, key: string, ifm: string, lenient: boolean): DeleteDecision {
  if (normalizeEtag(current.etag) !== ifm) throw new PreconditionMarker([]);
  // Un oggetto illeggibile si può solo eliminare per intero; un componente non-VEVENT non si tocca (§3.9).
  if (!current.object) {
    if (scope === 'all') return { action: 'delete', changed: [], issues: [], valid: true };
    throw readOnly(UNREADABLE_EVENT_MESSAGE, 'unreadable');
  }
  const obj = assertEditableObject(current);
  const now = new Date();
  try {
    const plan = planScopedDelete(obj, key, scope, { tz: safeTz(cal.timezone), now });
    if (plan.action === 'delete') return { action: 'delete', changed: [], issues: [], valid: true };
    const check = validate(plan.object, cal, obj, now);
    if (!check.ok && !lenient) throw validationFailed(check.issues.find((i) => i.severity === 'error')?.message ?? 'Evento non valido', check.issues);
    return { action: 'put', object: plan.object, previous: obj, changed: [scope === 'this' ? 'exdates' : 'rrule'], issues: check.issues, valid: check.ok };
  } catch (err) {
    throw planError(err);
  }
}

export async function deleteObjectV2(
  ref: string,
  ifMatch: string,
  req: { scope?: CalV2Scope; recurrenceKey?: string; dryRun: boolean },
  actor: AdminActor,
): Promise<CalV2WriteResult> {
  await assertV2ObjectsAvailable();
  const ifm = requireIfMatch(ifMatch);
  if (req.scope !== undefined && !CAL_V2_SCOPES.includes(req.scope)) throw scopeInvalid('scope non valido');
  const resolved = await resolve(ref);
  // Senza recurrence_key vale il componente indicato dall'id (§3.2): un id di override ha come target quell'override.
  const key = req.recurrenceKey ?? resolved.recurrenceKey;
  if (key !== MASTER_RECURRENCE_KEY && !isRecurrenceKey(key)) throw invalidValue('recurrence_key non valida', 'recurrence_key');
  // Senza scope vale "tutto" solo per il master: per un'istanza va scelto.
  const scope: CalV2Scope | null = req.scope ?? (key === MASTER_RECURRENCE_KEY ? 'all' : null);
  if (!scope) throw invalidValue('Indica lo scope (this, this_and_future o all) per eliminare un\'occorrenza', 'scope');
  const cal = resolved.calendar;
  assertWritableCalendar(cal);
  if (await isActiveBookingProjection(cal, resolved.href)) {
    throw readOnly(ACTIVE_BOOKING_MESSAGE, 'booking_active');
  }

  if (req.dryRun) {
    const { client, principal } = requireRadicale();
    const current = await fetchCurrent(client, objectPath(principal, collectionNameOf(cal), resolved.href), 'l\'evento');
    if (!current) throw notFound();
    try {
      const d = decideDelete(current, cal, scope, key, ifm, true);
      if (d.action === 'delete') return result({ object: null, etag: current.etag, dry_run: true });
      const snap: Snapshot = { resolved, raw: serialized(d.object as CalendarObject, current.raw), etag: current.etag, object: d.object as CalendarObject, parseError: null, source: 'radicale' };
      return result({ object: await viewOf(snap, null), etag: current.etag, changed: d.changed, dry_run: true, valid: d.valid, issues: d.issues });
    } catch (err) {
      if (err instanceof PreconditionMarker) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, key), []);
      throw err;
    }
  }

  let missing = false;
  let decision: DeleteDecision | null = null;
  let outcome;
  try {
    outcome = await writeObject({
      calendar: cal,
      href: resolved.href,
      what: 'l\'evento',
      maxAttempts: MAX_ATTEMPTS,
      plan: (current) => {
        missing = false;
        decision = null;
        if (!current) {
          missing = true;
          return { action: 'none' };
        }
        const d = decideDelete(current, cal, scope, key, ifm, false);
        decision = d;
        if (d.action === 'delete') return { action: 'delete' };
        return { action: 'put', object: d.object as CalendarObject, previous: d.previous as CalendarObject, changed: d.changed };
      },
    });
  } catch (err) {
    if (err instanceof PreconditionMarker) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, key), []);
    throw err;
  }
  if (missing) throw notFound();
  const d = decision as DeleteDecision | null;
  if (!d) throw new Error('DELETE senza decisione');
  const recordId = resolved.objectId || resolved.id;
  if (outcome.action === 'none') {
    // La risorsa è sparita fra la decisione e la DELETE: lo stato voluto c'è già.
    return result({ object: null, etag: null, noop: true });
  }
  await writeThrough([cal.id], ACTOR);
  if (outcome.action === 'delete') {
    await auditV2({ operation: 'v2.delete', action: 'DELETE', recordId, calendar: cal, href: resolved.href, etagBefore: outcome.etagBefore, etagAfter: null, changed: [], scope, actor, ...(key !== MASTER_RECURRENCE_KEY ? { extra: { recurrence_key: key } } : {}) });
    return result({ object: null, etag: null });
  }
  await auditV2({ operation: 'v2.delete', action: 'UPDATE', recordId, calendar: cal, href: resolved.href, etagBefore: outcome.etagBefore, etagAfter: outcome.etagAfter, changed: d.changed, scope, actor, extra: { recurrence_key: key } });
  const snap: Snapshot = { resolved, raw: outcome.raw ?? '', etag: outcome.etagAfter, object: outcome.object, parseError: null, source: 'radicale' };
  return result({ object: await viewOf(snap, null), etag: outcome.etagAfter, changed: d.changed, sequence_bumped: true, issues: d.issues });
}

