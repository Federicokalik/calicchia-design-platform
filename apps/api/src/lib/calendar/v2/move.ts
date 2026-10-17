/**
 * Sposta e duplica un oggetto (F6 tranche C, passo C1; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.2).
 *
 *  - `POST /objects/:id/move`: MOVE della risorsa intera in un altro
 *    calendario con `Overwrite: F` (stesse guardie di `move_to_calendar_id`
 *    della PATCH); l'id resta quello perché ids.ts riconosce la MOVE.
 *    Stesso calendario → noop; href o UID presenti nella destinazione → 409
 *    `MOVE_CONFLICT`; ETag diverso → 412 con `current` e `conflicts: []`.
 *  - `POST /objects/:id/duplicate`: copia del componente target (la
 *    pre-immagine per un'istanza) come oggetto nuovo, senza RECURRENCE-ID né
 *    ricorrenza salvo `keep_recurrence` sul master. Provenienza `admin` con
 *    `X-CALDES-SOURCE-ID` = id dell'originale (come il "Duplica" legacy).
 *
 * Ogni scrittura passa dalla pipeline dello store (gate cal-write, PUT con
 * `If-None-Match: *`, write-through, audit senza testo).
 */

import {
  addDurationToTime,
  type CalendarObject,
  cloneCalendarObject,
  cloneComponent,
  createCalendarObject,
  createTimeProperty,
  encodeText,
  getProperty,
  type IcsComponent,
  type IcsTime,
  isRecurrenceKey,
  MASTER_RECURRENCE_KEY,
  readTimeProperty,
  setProperties,
  setProvenance,
  shiftSeries,
  timeToUtcMs,
  utcMsToTime,
  type ZoneContext,
} from '@calicchia/calendar-core';
import type { CalV2DuplicateRequest, CalV2Issue, CalV2MoveRequest, CalV2WriteResult } from '@calicchia/shared';
import { z } from 'zod';
import { sql } from '../../../db';
import { CalendarConflictError, EventValidationError } from '../errors';
import { objectPath } from '../radicale/client';
import {
  allowedComponents,
  collectionNameOf,
  fetchCurrent,
  generateEventUid,
  hrefForUid,
  moveObject,
  positionId,
  preImage,
  requireRadicale,
  safeTz,
  sidecarById,
  type SidecarRow,
  UNREADABLE_EVENT_MESSAGE,
  writeObject,
  writeThrough,
} from '../radicale/store';
import { assertV2ObjectsAvailable } from './capabilities';
import { CalendarV2Error, CalendarV2PreconditionError, invalidValue, readOnly, v2ErrorFrom, validationFailed } from './errors';
import {
  ACTOR,
  type AdminActor,
  assertEditableObject,
  assertWritableCalendar,
  auditV2,
  CreateCollision,
  currentForPrecondition,
  existingObjectId,
  MAX_ATTEMPTS,
  normalizeEtag,
  notFound,
  objectExists,
  requireIfMatch,
  resolveObjectRef,
  type Resolved,
  result,
  serialized,
  type Snapshot,
  snapshotOf,
  timeSchema,
  UID_RE,
  UNSUPPORTED_COMPONENT_MESSAGE,
  utcStamp,
  UUID_RE,
  validate,
  viewOf,
  zodIssues,
} from './objects';

// ═══════════════════════════════════════════════════════════════════
// Richieste
// ═══════════════════════════════════════════════════════════════════

const moveSchema = z.object({ calendar_id: z.string().min(1).max(64), dryRun: z.boolean().optional() }).strict();

/** Corpo di `POST /objects/:id/move` validato. */
export function parseMoveRequest(raw: unknown): CalV2MoveRequest {
  const parsed = moveSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta di spostamento non valida', zodIssues(parsed.error));
  return parsed.data;
}

const duplicateSchema = z
  .object({
    recurrence_key: z.string().max(64).optional(),
    start: timeSchema.optional(),
    calendar_id: z.string().min(1).max(64).optional(),
    uid: z.string().regex(UID_RE, 'uid non valido').optional(),
    keep_recurrence: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

/** Corpo di `POST /objects/:id/duplicate` validato. */
export function parseDuplicateRequest(raw: unknown): CalV2DuplicateRequest {
  const parsed = duplicateSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta di duplicazione non valida', zodIssues(parsed.error));
  const req = parsed.data as unknown as CalV2DuplicateRequest;
  const key = req.recurrence_key ?? MASTER_RECURRENCE_KEY;
  if (key !== MASTER_RECURRENCE_KEY && !isRecurrenceKey(key)) throw invalidValue('recurrence_key non valida', 'recurrence_key');
  if (req.keep_recurrence && key !== MASTER_RECURRENCE_KEY) {
    throw invalidValue('Si può mantenere la ricorrenza solo copiando l\'intera serie (recurrence_key vuota)', 'keep_recurrence');
  }
  return req;
}

// ═══════════════════════════════════════════════════════════════════
// Sposta
// ═══════════════════════════════════════════════════════════════════

/** Destinazione di uno spostamento o di una copia: attiva, scrivibile e con VEVENT nel component-set. */
async function writableDestination(calendarId: string): Promise<SidecarRow> {
  if (!UUID_RE.test(calendarId)) throw notFound('Calendario di destinazione non trovato');
  const dest = await sidecarById(calendarId, { activeOnly: true });
  if (!dest) throw notFound('Calendario di destinazione non trovato');
  assertWritableCalendar(dest);
  if (!allowedComponents(dest).includes('VEVENT')) throw readOnly('Il calendario di destinazione non accetta eventi', 'component_unsupported');
  return dest;
}

/** Problemi che una MOVE incontrerebbe nella destinazione (href o UID già presenti). */
async function moveCollisions(dest: SidecarRow, href: string, uid: string | null): Promise<CalV2Issue[]> {
  const { client, principal } = requireRadicale();
  const issues: CalV2Issue[] = [];
  const atHref = await fetchCurrent(client, objectPath(principal, collectionNameOf(dest), href), 'l\'evento');
  if (atHref) issues.push({ code: 'MOVE_CONFLICT', severity: 'error', message: 'Esiste già un evento con lo stesso nome nel calendario di destinazione', property: 'calendar_id' });
  if (uid) {
    const [row] = await sql<Array<{ id: string }>>`SELECT id FROM cal_objects WHERE calendar_id = ${dest.id}::uuid AND uid = ${uid} AND href <> ${href} LIMIT 1`;
    if (row) issues.push({ code: 'MOVE_CONFLICT', severity: 'error', message: 'Esiste già un evento con lo stesso UID nel calendario di destinazione', property: 'calendar_id' });
  }
  return issues;
}

/** `POST /objects/:id/move`: sposta la risorsa in un altro calendario (§9.1.2). */
export async function moveObjectV2(ref: string, ifMatch: string, req: CalV2MoveRequest, actor: AdminActor): Promise<CalV2WriteResult> {
  await assertV2ObjectsAvailable();
  const ifm = requireIfMatch(ifMatch);
  const resolved = await resolveObjectRef(ref);
  const cal = resolved.calendar;
  assertWritableCalendar(cal);
  const dest = await writableDestination(req.calendar_id);

  const { client, principal } = requireRadicale();
  const srcPath = objectPath(principal, collectionNameOf(cal), resolved.href);
  const current = await fetchCurrent(client, srcPath, 'l\'evento');
  if (!current) throw notFound();
  if (normalizeEtag(current.etag) !== ifm) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, ''), []);
  const obj = assertEditableObject(current);
  const asIs: Snapshot = { resolved, raw: current.raw, etag: current.etag, object: obj, parseError: null, source: 'radicale' };

  // Stesso calendario: nulla da fare.
  if (dest.id === cal.id) return result({ object: await viewOf(asIs, ''), etag: current.etag, noop: true, dry_run: Boolean(req.dryRun) });

  if (req.dryRun) {
    const issues = await moveCollisions(dest, resolved.href, obj.uid);
    const inDest: Snapshot = { ...asIs, resolved: { ...resolved, calendar: dest } };
    return result({ object: await viewOf(inDest, ''), etag: current.etag, changed: ['calendar_id'], dry_run: true, valid: issues.length === 0, issues });
  }

  let etagAfter: string | null;
  try {
    etagAfter = await moveObject(cal, dest, resolved.href, current.etag);
  } catch (err) {
    if (err instanceof EventValidationError) throw new CalendarV2Error('MOVE_CONFLICT', 409, err.message);
    if (err instanceof CalendarConflictError) {
      // La risorsa è cambiata o sparita fra la lettura e la MOVE (il gate l'ha riletta): 404, 412 o conflitto vero.
      const fresh = await fetchCurrent(client, srcPath, 'l\'evento');
      if (!fresh) throw notFound();
      if (normalizeEtag(fresh.etag) !== ifm) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, ''), []);
      throw new CalendarV2Error('MOVE_CONFLICT', 409, err.message);
    }
    throw err;
  }

  await writeThrough([cal.id, dest.id], ACTOR);
  await auditV2({
    operation: 'v2.move',
    action: 'UPDATE',
    recordId: resolved.objectId || resolved.id,
    calendar: dest,
    href: resolved.href,
    etagBefore: current.etag,
    etagAfter,
    changed: ['calendar_id'],
    actor,
    extra: { from_calendar_id: cal.id, to_calendar_id: dest.id },
  });
  const moved: Snapshot = { resolved: { ...resolved, calendar: dest }, raw: current.raw, etag: etagAfter, object: obj, parseError: null, source: 'radicale' };
  return result({ object: await viewOf(moved, ''), etag: etagAfter, changed: ['calendar_id'] });
}

// ═══════════════════════════════════════════════════════════════════
// Duplica
// ═══════════════════════════════════════════════════════════════════

const DAY_MS = 86_400_000;
/** Proprietà che una copia non eredita (identità, ricorrenza, marcatori temporali, legami con l'originale). */
const COPY_STRIPPED = ['UID', 'RECURRENCE-ID', 'RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'RELATED-TO', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE'] as const;
const REGENERATED = ['UID', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE'] as const;

function withoutProperties(c: IcsComponent, names: readonly string[], prefix?: string): void {
  const drop = new Set(names);
  c.properties = c.properties.filter((p) => !drop.has(p.name.toUpperCase()) && !(prefix && p.name.toUpperCase().startsWith(prefix)));
}

/** UID, marcatori temporali e provenienza di una copia: come `createEvent` con source `admin`. */
function stampCopy(c: IcsComponent, uid: string, stamp: string, sourceId: string | null): void {
  withoutProperties(c, REGENERATED, 'X-CALDES-');
  c.properties.push(
    { name: 'UID', params: [], value: encodeText(uid) },
    { name: 'DTSTAMP', params: [], value: stamp },
    { name: 'CREATED', params: [], value: stamp },
    { name: 'LAST-MODIFIED', params: [], value: stamp },
    { name: 'SEQUENCE', params: [], value: '0' },
  );
  setProvenance(c, { source: 'admin', sourceId });
}

function daysBetween(a: IcsTime, b: IcsTime): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

/** Copia di un solo componente come evento singolo, con inizio `start` (default quello del componente) e durata invariata. */
function singleCopy(source: CalendarObject, component: IcsComponent, req: CalV2DuplicateRequest, uid: string, stamp: string, tz: string, sourceId: string | null): CalendarObject {
  const comp = cloneComponent(component);
  const startProp = getProperty(comp, 'DTSTART');
  if (!startProp) throw invalidValue('L\'evento non ha un inizio (DTSTART): non si può duplicare', 'DTSTART');
  const from = readTimeProperty(startProp);
  const to: IcsTime = (req.start as IcsTime | undefined) ?? from;
  if (to.type !== from.type) {
    throw invalidValue('L\'inizio della copia deve essere dello stesso tipo dell\'originale (giornata intera o con orario)', 'start');
  }
  const zctx: ZoneContext = { tz, timezones: source.timezones };
  const endProp = getProperty(comp, 'DTEND');
  withoutProperties(comp, COPY_STRIPPED);
  if (endProp) {
    const end = readTimeProperty(endProp);
    let newEnd: IcsTime;
    if (from.type === 'date') {
      newEnd = addDurationToTime(to, { negative: false, weeks: 0, days: daysBetween(from, end), hours: 0, minutes: 0, seconds: 0 }, zctx);
    } else {
      const durationMs = timeToUtcMs(end, zctx) - timeToUtcMs(from, zctx);
      newEnd = utcMsToTime(timeToUtcMs(to, zctx) + durationMs, req.start ? to : end, zctx);
    }
    setProperties(comp, 'DTEND', [createTimeProperty('DTEND', newEnd)]);
  }
  setProperties(comp, 'DTSTART', [createTimeProperty('DTSTART', to)]);
  stampCopy(comp, uid, stamp, sourceId);
  return createCalendarObject({ uid, componentType: 'VEVENT', master: comp, timezones: source.timezones.map(cloneComponent) });
}

/** Copia dell'intera serie (master, override, eccezioni); `start` sposta tutta la serie con `shiftSeries`. */
function seriesCopy(source: CalendarObject, req: CalV2DuplicateRequest, uid: string, stamp: string, tz: string, now: Date, sourceId: string | null): CalendarObject {
  const base = req.start ? shiftSeries(source, req.start as IcsTime, { tz, now }).object : cloneCalendarObject(source);
  const copy: CalendarObject = { ...base, uid };
  // Master e override restano legati fra loro (UID e RECURRENCE-ID), ma sono un oggetto nuovo.
  for (const c of [copy.master, ...copy.overrides]) {
    if (!c) continue;
    withoutProperties(c, ['RELATED-TO']);
    stampCopy(c, uid, stamp, sourceId);
  }
  return copy;
}

interface CopyPlan {
  build: (uid: string, now: Date) => CalendarObject;
  changed: string[];
}

function planCopy(snapshot: Snapshot, req: CalV2DuplicateRequest, sourceId: string | null): CopyPlan {
  const source = snapshot.object as CalendarObject;
  const tz = safeTz(snapshot.resolved.calendar.timezone);
  const key = req.recurrence_key ?? MASTER_RECURRENCE_KEY;
  return {
    changed: ['duplicate'],
    build: (uid, now) => {
      const stamp = utcStamp(now);
      if (req.keep_recurrence) {
        if (!source.master) throw invalidValue('L\'oggetto non ha un evento principale: indica l\'occorrenza da duplicare', 'recurrence_key');
        return seriesCopy(source, req, uid, stamp, tz, now, sourceId);
      }
      if (key === MASTER_RECURRENCE_KEY && !source.master) {
        throw invalidValue('L\'oggetto non ha un evento principale: indica l\'occorrenza da duplicare', 'recurrence_key');
      }
      const component = preImage(source, key, tz, now);
      if (!component) throw new CalendarV2Error('RECURRENCE_TARGET_GONE', 409, 'L\'occorrenza non esiste più nella serie: ricarica l\'evento e riprova', { recurrence_key: key });
      return singleCopy(source, component, req, uid, stamp, tz, sourceId);
    },
  };
}

/** `POST /objects/:id/duplicate`: copia come oggetto nuovo (§9.1.2). */
export async function duplicateObjectV2(ref: string, req: CalV2DuplicateRequest, actor: AdminActor): Promise<CalV2WriteResult> {
  await assertV2ObjectsAvailable();
  const resolved = await resolveObjectRef(ref);
  const snapshot = await snapshotOf(resolved);
  if (!snapshot.object) throw readOnly(UNREADABLE_EVENT_MESSAGE, 'unreadable');
  if (snapshot.object.componentType !== 'VEVENT') throw readOnly(UNSUPPORTED_COMPONENT_MESSAGE, 'component_unsupported');
  const sourceId = resolved.objectId || resolved.id || null;

  // Destinazione: quella indicata o il calendario dell'originale (se non scrivibile → 403 READ_ONLY).
  let dest: SidecarRow;
  if (req.calendar_id !== undefined) {
    dest = await writableDestination(req.calendar_id);
  } else {
    dest = resolved.calendar;
    assertWritableCalendar(dest);
    if (!allowedComponents(dest).includes('VEVENT')) throw readOnly('Questo calendario non accetta eventi', 'component_unsupported');
  }

  const copy = planCopy(snapshot, req, sourceId);
  const generated = req.uid === undefined;
  let uid = req.uid ?? generateEventUid();
  let now = new Date();
  let built: CalendarObject;
  try {
    built = copy.build(uid, now);
  } catch (err) {
    throw planErrorOf(err);
  }
  const check = validate(built, dest, null, now);
  if (!check.ok && !req.dryRun) throw validationFailed(check.issues.find((i) => i.severity === 'error')?.message ?? 'Evento non valido', check.issues);
  const copyResolved = (id: string, href: string): Resolved => ({ id, objectId: id, recurrenceKey: MASTER_RECURRENCE_KEY, href, calendar: dest });

  if (req.dryRun) {
    const href = hrefForUid(uid);
    const snap: Snapshot = { resolved: copyResolved('', href), raw: serialized(built, ''), etag: null, object: built, parseError: null, source: 'radicale' };
    return result({ object: await viewOf(snap, MASTER_RECURRENCE_KEY), etag: null, changed: copy.changed, dry_run: true, valid: check.ok, issues: check.issues });
  }

  let href = hrefForUid(uid);
  let outcome;
  for (let round = 0; ; round++) {
    try {
      const toWrite = built;
      outcome = await writeObject({
        calendar: dest,
        href,
        what: 'l\'evento',
        maxAttempts: MAX_ATTEMPTS,
        plan: (current) => {
          if (current) throw new CreateCollision();
          return { action: 'put', object: toWrite, previous: null };
        },
      });
      break;
    } catch (err) {
      const collision = err instanceof CreateCollision || (err instanceof EventValidationError && /UID già presente/.test(err.message));
      if (!collision) throw err;
      // UID generato che collide: se ne sceglie un altro; UID dell'admin: l'oggetto esiste già (retry dopo un errore di rete).
      if (generated && round < 2) {
        uid = generateEventUid();
        now = new Date();
        try {
          built = copy.build(uid, now);
        } catch (e) {
          throw planErrorOf(e);
        }
        href = hrefForUid(uid);
        continue;
      }
      throw objectExists(await existingObjectId(dest, href, uid));
    }
  }

  await writeThrough([dest.id], ACTOR);
  const id = await positionId(dest.id, href, MASTER_RECURRENCE_KEY, uid);
  await auditV2({
    operation: 'v2.duplicate',
    action: 'INSERT',
    recordId: id,
    calendar: dest,
    href,
    etagBefore: null,
    etagAfter: outcome.etagAfter,
    changed: copy.changed,
    actor,
    extra: {
      source_object_id: sourceId,
      ...(req.recurrence_key ? { recurrence_key: req.recurrence_key } : {}),
      ...(req.keep_recurrence ? { keep_recurrence: true } : {}),
    },
  });
  const snap: Snapshot = { resolved: copyResolved(id, href), raw: outcome.raw ?? '', etag: outcome.etagAfter, object: outcome.object ?? built, parseError: null, source: 'radicale' };
  return result({ object: await viewOf(snap, MASTER_RECURRENCE_KEY), etag: outcome.etagAfter, changed: copy.changed, issues: check.issues });
}

/** Errori di calendar-core nella costruzione della copia → errori v2 (400/409). */
function planErrorOf(err: unknown): unknown {
  return v2ErrorFrom(err) ?? err;
}
