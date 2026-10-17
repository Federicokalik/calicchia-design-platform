/**
 * Cronologia e cestino dell'API admin v2 (F6 tranche C, passo C1; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.3).
 *
 *  - `GET /objects/:id/versions[/:versionId]`: le righe di
 *    `cal_object_versions` (90 giorni) con i campi cambiati rispetto alla
 *    versione precedente e quella che corrisponde al testo corrente.
 *  - `POST /objects/:id/restore`: scrive il testo di una versione sull'oggetto
 *    vivo con `If-Match` esatto, DTSTAMP e LAST-MODIFIED nuovi e
 *    SEQUENCE = max(corrente, versione) + 1; la versione registrata dalla sync
 *    diventa `restore` con attore `admin:<id>`.
 *  - `GET /trash` e `POST /trash/:objectId/restore`: oggetti con la riga
 *    `cal_object_ids` ritirata e una versione `delete`; il ripristino è una
 *    PUT con `If-None-Match: *` sullo stesso href (la riga ritirata torna
 *    attiva: stesso id) o nel calendario indicato (riconosciuta come MOVE
 *    entro 30 giorni).
 *
 * Nessun testo di evento nei log né in `audit_logs`.
 */

import { createHash } from 'node:crypto';
import {
  type CalendarObject,
  type CalendarRole,
  cloneCalendarObject,
  deriveProvenance,
  getProperties,
  getTextValue,
  type IcsComponent,
  MASTER_RECURRENCE_KEY,
  parseCalendarObject,
  readTimeProperty,
  setProperties,
  timeToIso,
} from '@calicchia/calendar-core';
import {
  CAL_V2_ABSENT_TOKEN,
  CAL_V2_FIELDS,
  type CalV2TrashItem,
  type CalV2TrashList,
  type CalV2TrashNotRestorableReason,
  type CalV2TrashRestoreRequest,
  type CalV2RestoreRequest,
  type CalV2VersionDetail,
  type CalV2VersionList,
  type CalV2VersionSummary,
  type CalV2WriteResult,
} from '@calicchia/shared';
import { z } from 'zod';
import { sql } from '../../../db';
import { INDEX_TIMING, type CalObjectVersionRow } from '../index-model';
import { EventValidationError } from '../errors';
import { objectPath } from '../radicale/client';
import { getObjectVersion, listObjectVersions, markVersionRestored } from '../radicale/versions';
import {
  allowedComponents,
  collectionNameOf,
  fetchCurrent,
  positionId,
  requireRadicale,
  safeTz,
  sidecarById,
  type CurrentObject,
  type SidecarRow,
  writeObject,
  writeThrough,
} from '../radicale/store';
import { assertV2ObjectsAvailable } from './capabilities';
import { CalendarV2PreconditionError, invalidValue, notRestorable, validationFailed, versionNotRestorable, type VersionNotRestorableReason } from './errors';
import {
  ACTOR,
  type AdminActor,
  assertEditableObject,
  assertWritableCalendar,
  auditV2,
  currentForPrecondition,
  MAX_ATTEMPTS,
  normalizeEtag,
  notFound,
  PreconditionMarker,
  requireIfMatch,
  resolveObjectRef,
  type Resolved,
  result,
  type Snapshot,
  snapshotOf,
  utcStamp,
  UUID_RE,
  validate,
  viewOf,
  zodIssues,
} from './objects';
import { buildComponentView } from './view';

const DAY_MS = 86_400_000;
/** Conservazione delle versioni (giorni): quella di `purgeExpiredVersions`. */
export const VERSION_RETENTION_DAYS = Math.round(INDEX_TIMING.versionsRetentionMs / DAY_MS);
/** Righe al più nella lista di un oggetto. */
const MAX_VERSIONS_LISTED = 200;
const TRASH_DEFAULT_LIMIT = 50;
const TRASH_MAX_LIMIT = 100;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const expiryOf = (createdAt: Date): Date => new Date(createdAt.getTime() + INDEX_TIMING.versionsRetentionMs);
const isExpired = (createdAt: Date, now: number): boolean => expiryOf(createdAt).getTime() <= now;
const actorLabel = (actor: AdminActor): string => `admin:${actor.userId ?? 'admin'}`;

// ═══════════════════════════════════════════════════════════════════
// Richieste
// ═══════════════════════════════════════════════════════════════════

const uuid = z.string().regex(UUID_RE, 'identificativo non valido');
const restoreSchema = z.object({ version_id: uuid, dryRun: z.boolean().optional() }).strict();
const trashRestoreSchema = z
  .object({ version_id: uuid.optional(), calendar_id: z.string().min(1).max(64).optional(), dryRun: z.boolean().optional() })
  .strict();

/** Corpo di `POST /objects/:id/restore` validato. */
export function parseRestoreRequest(raw: unknown): CalV2RestoreRequest {
  const parsed = restoreSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta di ripristino non valida', zodIssues(parsed.error));
  return parsed.data;
}

/** Corpo di `POST /trash/:objectId/restore` validato. */
export function parseTrashRestoreRequest(raw: unknown): CalV2TrashRestoreRequest {
  const parsed = trashRestoreSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta di ripristino non valida', zodIssues(parsed.error));
  return parsed.data;
}

export interface TrashQuery {
  calendarId?: string;
  before?: string;
  limit: number;
}

/** Query di `GET /trash` (`calendar_id`, `before`, `limit` 1-100). */
export function parseTrashQuery(query: { calendar_id?: string; before?: string; limit?: string }): TrashQuery {
  let limit = TRASH_DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > TRASH_MAX_LIMIT) throw invalidValue(`limit deve essere un intero da 1 a ${TRASH_MAX_LIMIT}`, 'limit');
  }
  if (query.calendar_id !== undefined && !UUID_RE.test(query.calendar_id)) throw invalidValue('calendar_id non valido', 'calendar_id');
  return { limit, ...(query.calendar_id !== undefined ? { calendarId: query.calendar_id } : {}), ...(query.before !== undefined ? { before: query.before } : {}) };
}

// ═══════════════════════════════════════════════════════════════════
// Cronologia
// ═══════════════════════════════════════════════════════════════════

interface VersionParse {
  object: CalendarObject | null;
  tokens: Record<string, string> | null;
  summary: string | null;
}

function parseVersion(row: CalObjectVersionRow, tz: string, now: Date): VersionParse {
  const empty: VersionParse = { object: null, tokens: null, summary: null };
  if (!row.raw_ics) return empty;
  const parsed = parseCalendarObject(row.raw_ics);
  if (!parsed.ok) return empty;
  const object = parsed.value;
  const component = object.master ?? object.overrides[0] ?? null;
  const view = object.master ? buildComponentView(object, MASTER_RECURRENCE_KEY, { tz, now, componentId: null }) : null;
  return { object, tokens: view?.tokens ?? null, summary: component ? getTextValue(component, 'SUMMARY') : null };
}

/** Nomi dei campi tipizzati e di 'prop:<NOME>' che differiscono, più 'overrides' se cambia il numero di override. */
function changedFieldsBetween(next: VersionParse, previous: VersionParse): string[] {
  if (!next.object || !previous.object) return [];
  const a = next.tokens ?? {};
  const b = previous.tokens ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const order = new Map<string, number>(CAL_V2_FIELDS.map((f, i) => [f, i]));
  const changed = [...keys].filter((k) => (a[k] ?? CAL_V2_ABSENT_TOKEN) !== (b[k] ?? CAL_V2_ABSENT_TOKEN));
  changed.sort((x, y) => (order.get(x) ?? 1_000) - (order.get(y) ?? 1_000) || x.localeCompare(y));
  if (next.object.overrides.length !== previous.object.overrides.length) changed.push('overrides');
  return changed;
}

function summaryOfVersion(row: CalObjectVersionRow, parsed: VersionParse, changed: string[], current: boolean): CalV2VersionSummary {
  return {
    id: row.id,
    object_id: row.object_id,
    etag: row.etag,
    change_kind: row.change_kind,
    valid: row.valid,
    actor: row.actor,
    recorded_at: row.created_at.toISOString(),
    size_bytes: row.raw_ics ? Buffer.byteLength(row.raw_ics, 'utf8') : 0,
    summary: parsed.summary,
    changed_fields: changed,
    current,
    expires_at: expiryOf(row.created_at).toISOString(),
  };
}

/** SHA-256 del testo corrente (da Radicale, ripiego sull'indice). */
async function currentSha(resolved: Resolved): Promise<string | null> {
  try {
    const snap = await snapshotOf(resolved);
    return snap.raw ? sha256(snap.raw) : null;
  } catch {
    return null;
  }
}

/** `GET /objects/:id/versions`: dalla più recente, al più 200 righe non scadute. */
export async function listVersionsV2(ref: string): Promise<CalV2VersionList> {
  await assertV2ObjectsAvailable();
  const resolved = await resolveObjectRef(ref);
  const objectId = resolved.objectId || resolved.id;
  const now = new Date();
  const rows = (await listObjectVersions(sql, objectId, { limit: MAX_VERSIONS_LISTED })).filter((r) => !isExpired(r.created_at, now.getTime()));
  const tz = safeTz(resolved.calendar.timezone);
  const currentHash = await currentSha(resolved);
  const parsed = rows.map((r) => (r.valid ? parseVersion(r, tz, now) : { object: null, tokens: null, summary: null }));
  let currentTaken = false;
  const versions = rows.map((row, i) => {
    // La versione precedente più vicina che si può confrontare (valida e con testo).
    const older = parsed.slice(i + 1).find((p) => p.object !== null);
    const changed = row.valid && older ? changedFieldsBetween(parsed[i], older) : [];
    const current = !currentTaken && currentHash !== null && row.content_sha256 === currentHash && row.change_kind !== 'delete';
    if (current) currentTaken = true;
    return summaryOfVersion(row, parsed[i], changed, current);
  });
  return { object_id: objectId, retention_days: VERSION_RETENTION_DAYS, versions };
}

/** `GET /objects/:id/versions/:versionId`: testo e vista della versione (404 se è di un altro oggetto o è scaduta). */
export async function getVersionV2(ref: string, versionId: string): Promise<CalV2VersionDetail> {
  await assertV2ObjectsAvailable();
  const resolved = await resolveObjectRef(ref);
  const objectId = resolved.objectId || resolved.id;
  if (!UUID_RE.test(versionId)) throw notFound('Versione non trovata');
  const row = await getObjectVersion(sql, versionId);
  const now = new Date();
  if (!row || row.object_id !== objectId || isExpired(row.created_at, now.getTime())) throw notFound('Versione non trovata');

  const tz = safeTz(resolved.calendar.timezone);
  const parsed = row.valid ? parseVersion(row, tz, now) : { object: null, tokens: null, summary: null };
  const siblings = (await listObjectVersions(sql, objectId, { limit: MAX_VERSIONS_LISTED })).filter((r) => !isExpired(r.created_at, now.getTime()));
  const index = siblings.findIndex((r) => r.id === row.id);
  const olderRow = siblings.slice(index + 1).find((r) => r.valid && r.raw_ics);
  const changed = row.valid && olderRow ? changedFieldsBetween(parsed, parseVersion(olderRow, tz, now)) : [];
  const currentHash = await currentSha(resolved);
  const newestSame = siblings.find((r) => currentHash !== null && r.content_sha256 === currentHash && r.change_kind !== 'delete');
  const version = summaryOfVersion(row, parsed, changed, newestSame?.id === row.id);

  let view = null;
  if (parsed.object && row.raw_ics) {
    // Id ed ETag dell'oggetto corrente, testo della versione.
    const live = await snapshotOf(resolved);
    view = await viewOf({ ...live, raw: row.raw_ics, object: parsed.object, parseError: null, source: 'index' }, null);
  }
  return { version, ics: row.raw_ics, view };
}

// ═══════════════════════════════════════════════════════════════════
// Ripristino di una versione
// ═══════════════════════════════════════════════════════════════════

function sequenceOf(c: IcsComponent | null | undefined): number {
  const raw = c ? getProperties(c, 'SEQUENCE')[0]?.value : undefined;
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const recurrenceIdOf = (c: IcsComponent): string => getProperties(c, 'RECURRENCE-ID')[0]?.value ?? '';

/**
 * Testo da scrivere per un ripristino: la versione, con DTSTAMP e
 * LAST-MODIFIED di adesso e SEQUENCE = max(corrente, versione) + 1 su ogni
 * componente (così i device accettano la modifica). Con `current` nullo
 * (ripristino dal cestino o oggetto illeggibile) conta solo la versione.
 */
export function restoredObject(version: CalendarObject, current: CalendarObject | null, now: Date): CalendarObject {
  const stamp = utcStamp(now);
  const out = cloneCalendarObject(version);
  const currentByKey = new Map<string, IcsComponent>();
  if (current?.master) currentByKey.set('', current.master);
  for (const o of current?.overrides ?? []) currentByKey.set(recurrenceIdOf(o), o);
  const components: Array<[string, IcsComponent | null]> = [['', out.master], ...out.overrides.map((o): [string, IcsComponent] => [recurrenceIdOf(o), o])];
  for (const [key, comp] of components) {
    if (!comp) continue;
    const sequence = Math.max(sequenceOf(currentByKey.get(key) ?? current?.master), sequenceOf(comp)) + 1;
    setProperties(comp, 'DTSTAMP', [{ name: 'DTSTAMP', params: [], value: stamp }]);
    setProperties(comp, 'LAST-MODIFIED', [{ name: 'LAST-MODIFIED', params: [], value: stamp }]);
    setProperties(comp, 'SEQUENCE', [{ name: 'SEQUENCE', params: [], value: String(sequence) }]);
  }
  return out;
}

/** Controlli comuni di una versione da ripristinare: dell'oggetto, valida, non scaduta, con testo interpretabile. */
function restorableVersion(row: CalObjectVersionRow, objectId: string, now: Date): CalendarObject {
  const fail = (reason: VersionNotRestorableReason) => versionNotRestorable(reason);
  if (row.object_id !== objectId) throw fail('other_object');
  if (isExpired(row.created_at, now.getTime())) throw fail('expired');
  if (!row.valid || row.change_kind === 'delete' || !row.raw_ics) throw fail('invalid');
  const parsed = parseCalendarObject(row.raw_ics);
  if (!parsed.ok || parsed.value.componentType !== 'VEVENT') throw fail('invalid');
  return parsed.value;
}

interface RestoreDecision {
  object: CalendarObject;
  previous: CalendarObject | null;
  issues: ReturnType<typeof validate>['issues'];
  valid: boolean;
}

function decideRestore(current: CurrentObject, version: CalendarObject, ifm: string, cal: SidecarRow, lenient: boolean): RestoreDecision {
  if (normalizeEtag(current.etag) !== ifm) throw new PreconditionMarker([]);
  // Un oggetto illeggibile si ripara da qui; un VTODO/VJOURNAL corrente resta in sola lettura.
  if (current.object) assertEditableObject(current);
  if (current.object && current.object.uid !== version.uid) throw versionNotRestorable('other_object');
  const now = new Date();
  const object = restoredObject(version, current.object, now);
  const check = validate(object, cal, current.object, now);
  if (!check.ok && !lenient) throw validationFailed(check.issues.find((i) => i.severity === 'error')?.message ?? 'Evento non valido', check.issues);
  return { object, previous: current.object, issues: check.issues, valid: check.ok };
}

/** `POST /objects/:id/restore`: ripristina una versione sull'oggetto vivo (§9.1.3). */
export async function restoreVersionV2(ref: string, ifMatch: string, req: CalV2RestoreRequest, actor: AdminActor): Promise<CalV2WriteResult> {
  await assertV2ObjectsAvailable();
  const ifm = requireIfMatch(ifMatch);
  const resolved = await resolveObjectRef(ref);
  const cal = resolved.calendar;
  assertWritableCalendar(cal);
  const objectId = resolved.objectId || resolved.id;
  const row = await getObjectVersion(sql, req.version_id);
  if (!row) throw notFound('Versione non trovata');
  const version = restorableVersion(row, objectId, new Date());

  if (req.dryRun) {
    const { client, principal } = requireRadicale();
    const current = await fetchCurrent(client, objectPath(principal, collectionNameOf(cal), resolved.href), 'l\'evento');
    if (!current) throw notFound();
    try {
      const d = decideRestore(current, version, ifm, cal, true);
      const snap: Snapshot = { resolved, raw: current.raw, etag: current.etag, object: d.object, parseError: null, source: 'radicale' };
      return result({ object: await viewOf(snap, ''), etag: current.etag, changed: ['restore'], sequence_bumped: true, dry_run: true, valid: d.valid, issues: d.issues });
    } catch (err) {
      if (err instanceof PreconditionMarker) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, ''), []);
      throw err;
    }
  }

  let missing = false;
  let decision: RestoreDecision | null = null;
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
        const d = decideRestore(current, version, ifm, cal, false);
        decision = d;
        return { action: 'put', object: d.object, previous: d.previous, changed: ['restore'] };
      },
    });
  } catch (err) {
    if (err instanceof PreconditionMarker) throw new CalendarV2PreconditionError(await currentForPrecondition(resolved, ''), []);
    throw err;
  }
  if (missing) throw notFound();
  const d = decision as RestoreDecision | null;
  if (!d || outcome.action !== 'put') throw new Error('Ripristino senza scrittura');

  await writeThrough([cal.id], ACTOR);
  await markVersionRestored(sql, { objectId, href: resolved.href, etag: outcome.etagAfter, actor: actorLabel(actor) });
  await auditV2({
    operation: 'v2.restore',
    action: 'UPDATE',
    recordId: objectId,
    calendar: cal,
    href: resolved.href,
    etagBefore: outcome.etagBefore,
    etagAfter: outcome.etagAfter,
    changed: ['restore'],
    actor,
    extra: { version_id: row.id },
  });
  const snap: Snapshot = { resolved, raw: outcome.raw ?? '', etag: outcome.etagAfter, object: outcome.object ?? d.object, parseError: null, source: 'radicale' };
  return result({ object: await viewOf(snap, ''), etag: outcome.etagAfter, changed: ['restore'], sequence_bumped: true, issues: d.issues });
}

// ═══════════════════════════════════════════════════════════════════
// Cestino
// ═══════════════════════════════════════════════════════════════════

interface TrashRow {
  id: string;
  calendar_id: string;
  href: string;
  uid: string | null;
  calendar_name: string | null;
  calendar_timezone: string | null;
  lifecycle: string | null;
  role: string | null;
  origin: string | null;
  deleted_at: Date;
  deleted_at_text: string;
  deleted_by: string | null;
  version_id: string | null;
  version_at: Date | null;
}

function encodeCursor(row: Pick<TrashRow, 'deleted_at_text' | 'id'>): string {
  return Buffer.from(JSON.stringify({ t: row.deleted_at_text, i: row.id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { t: string; i: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
    if (typeof value.t === 'string' && typeof value.i === 'string' && UUID_RE.test(value.i) && !Number.isNaN(Date.parse(value.t))) {
      return { t: value.t, i: value.i };
    }
  } catch {
    // cursore illeggibile: errore di validazione sotto
  }
  throw invalidValue('before non valido', 'before');
}

/** Calendario in cui si può scrivere un evento: attivo, non iscrizione né archivio, con VEVENT. */
function calendarAccepts(c: { lifecycle: string | null; role: string | null; origin: string | null } | null): 'ok' | 'calendar_gone' | 'calendar_readonly' {
  if (!c || c.lifecycle !== 'active') return 'calendar_gone';
  if (c.role === 'subscription' || c.origin === 'migration') return 'calendar_readonly';
  return 'ok';
}

/** UID (fra quelli dati) attivi in un calendario scrivibile: un ripristino li duplicherebbe. */
async function activeUids(uids: readonly string[]): Promise<Set<string>> {
  if (uids.length === 0) return new Set();
  const rows = await sql<Array<{ uid: string }>>`
    SELECT DISTINCT r.uid FROM cal_object_ids r
    JOIN calendars c ON c.id = r.calendar_id AND c.lifecycle = 'active' AND c.role <> 'subscription'
    WHERE r.recurrence_key = '' AND r.retired_at IS NULL AND r.uid = ANY(${[...uids]}::text[])
  `;
  return new Set(rows.map((r) => r.uid));
}

/** Prima ragione che impedisce il ripristino, nell'ordine dei controlli del cestino. */
function firstReason(input: { hasVersion: boolean; versionExpired: boolean; uidActive: boolean; calendar: 'ok' | 'calendar_gone' | 'calendar_readonly' }): CalV2TrashNotRestorableReason | null {
  if (!input.hasVersion) return 'no_valid_version';
  if (input.versionExpired) return 'expired';
  if (input.uidActive) return 'uid_exists';
  return input.calendar === 'ok' ? null : input.calendar;
}

/** `GET /trash?calendar_id=&before=&limit=`: oggetti eliminati ripristinabili o no, dal più recente. */
export async function listTrashV2(query: TrashQuery): Promise<CalV2TrashList> {
  await assertV2ObjectsAvailable();
  const now = new Date();
  const cutoff = new Date(now.getTime() - INDEX_TIMING.versionsRetentionMs);
  const cursor = query.before !== undefined ? decodeCursor(query.before) : null;
  const rows = await sql<TrashRow[]>`
    SELECT r.id, r.calendar_id, r.href, r.uid,
           c.name AS calendar_name, c.timezone AS calendar_timezone, c.lifecycle, c.role, c.origin,
           d.created_at AS deleted_at,
           to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at_text,
           d.actor AS deleted_by,
           lv.id AS version_id, lv.created_at AS version_at
    FROM cal_object_ids r
    LEFT JOIN calendars c ON c.id = r.calendar_id
    JOIN LATERAL (
      SELECT created_at, actor FROM cal_object_versions
      WHERE object_id = r.id AND change_kind = 'delete'
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT id, created_at FROM cal_object_versions
      WHERE object_id = r.id AND valid AND change_kind <> 'delete' AND raw_ics IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) lv ON true
    WHERE r.recurrence_key = '' AND r.retired_at IS NOT NULL
      AND (d.created_at > ${cutoff} OR lv.created_at > ${cutoff})
      ${query.calendarId ? sql`AND r.calendar_id = ${query.calendarId}::uuid` : sql``}
      ${cursor ? sql`AND (d.created_at, r.id) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)` : sql``}
    ORDER BY d.created_at DESC, r.id DESC
    LIMIT ${query.limit + 1}
  `;
  const page = rows.slice(0, query.limit);

  // Testo delle versioni proposte, solo per la pagina: riepilogo, inizio e ricorrenza.
  const versionIds = page.map((r) => r.version_id).filter((v): v is string => v !== null);
  const texts = new Map<string, string>();
  if (versionIds.length) {
    const found = await sql<Array<{ id: string; raw_ics: string }>>`SELECT id, raw_ics FROM cal_object_versions WHERE id = ANY(${versionIds}::uuid[])`;
    for (const t of found) texts.set(t.id, t.raw_ics);
  }
  const parsedByVersion = new Map<string, CalendarObject>();
  for (const [id, text] of texts) {
    const parsed = parseCalendarObject(text);
    if (parsed.ok) parsedByVersion.set(id, parsed.value);
  }
  const uids = page.map((r) => r.uid ?? (r.version_id ? parsedByVersion.get(r.version_id)?.uid : undefined)).filter((u): u is string => Boolean(u));
  const active = await activeUids(uids);

  // Le proiezioni di prenotazione (booking-<uid>.ics in bookings) le cancella il proiettore: non si ripristinano a mano.
  const calendarOf = (r: (typeof page)[number]): ReturnType<typeof calendarAccepts> => {
    const accepts = calendarAccepts(r.calendar_name === null && r.lifecycle === null ? null : r);
    if (accepts === 'ok' && deriveProvenance({ role: (r.role ?? 'user') as CalendarRole, href: r.href }).source === 'booking') return 'calendar_readonly';
    return accepts;
  };

  const items: CalV2TrashItem[] = page.map((r) => {
    const obj = r.version_id ? parsedByVersion.get(r.version_id) ?? null : null;
    const uid = r.uid ?? obj?.uid ?? null;
    const component = obj ? obj.master ?? obj.overrides[0] ?? null : null;
    let startUtc: string | null = null;
    try {
      const dtstart = component ? getProperties(component, 'DTSTART')[0] : undefined;
      if (dtstart) startUtc = timeToIso(readTimeProperty(dtstart), { tz: safeTz(r.calendar_timezone ?? 'Europe/Rome'), timezones: obj?.timezones });
    } catch {
      startUtc = null;
    }
    const versionExpired = r.version_at ? isExpired(r.version_at, now.getTime()) : false;
    const reason = firstReason({
      hasVersion: r.version_id !== null,
      versionExpired,
      uidActive: uid !== null && active.has(uid),
      calendar: calendarOf(r),
    });
    return {
      object_id: r.id,
      calendar_id: r.calendar_id,
      calendar_name: r.calendar_name,
      href: r.href,
      uid,
      summary: component ? getTextValue(component, 'SUMMARY') : null,
      start_utc: startUtc,
      recurring: Boolean(obj?.master && (getProperties(obj.master, 'RRULE').length > 0 || getProperties(obj.master, 'RDATE').length > 0)),
      deleted_at: r.deleted_at.toISOString(),
      deleted_by: r.deleted_by,
      restore_version_id: r.version_id,
      expires_at: expiryOf(r.version_at ?? r.deleted_at).toISOString(),
      restorable: reason === null,
      not_restorable_reason: reason,
    };
  });
  return { items, next: rows.length > query.limit ? encodeCursor(page[page.length - 1]) : null, retention_days: VERSION_RETENTION_DAYS };
}

/** Marcatore: l'href di destinazione è occupato (409 NOT_RESTORABLE `href_taken`). */
class HrefTaken extends Error {
  constructor() {
    super('href occupato');
    this.name = 'HrefTaken';
  }
}

/** `POST /trash/:objectId/restore`: rimette un oggetto eliminato, con lo stesso id sullo stesso href (§9.1.3). */
export async function restoreFromTrashV2(objectId: string, req: CalV2TrashRestoreRequest, actor: AdminActor): Promise<CalV2WriteResult> {
  await assertV2ObjectsAvailable();
  if (!UUID_RE.test(objectId)) throw notFound('Elemento non trovato nel cestino');
  const [row] = await sql<Array<{ id: string; calendar_id: string; href: string; uid: string | null }>>`
    SELECT r.id, r.calendar_id, r.href, r.uid FROM cal_object_ids r
    WHERE r.id = ${objectId}::uuid AND r.recurrence_key = '' AND r.retired_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM cal_object_versions v WHERE v.object_id = r.id AND v.change_kind = 'delete')
  `;
  if (!row) throw notFound('Elemento non trovato nel cestino');
  const now = new Date();

  // Calendario di destinazione: quello indicato, altrimenti l'originale.
  let dest: SidecarRow | null;
  if (req.calendar_id !== undefined) {
    dest = UUID_RE.test(req.calendar_id) ? await sidecarById(req.calendar_id, { activeOnly: true }) : null;
    if (!dest) throw notFound('Calendario di destinazione non trovato');
  } else {
    dest = await sidecarById(row.calendar_id, { activeOnly: true });
    if (!dest) throw notRestorable('calendar_gone');
  }
  if (dest.role === 'subscription' || dest.origin === 'migration' || !allowedComponents(dest).includes('VEVENT')) throw notRestorable('calendar_readonly');
  // Una proiezione di prenotazione cancellata dal proiettore non torna a bloccare la disponibilità.
  const original = await sidecarById(row.calendar_id, { activeOnly: false });
  if (deriveProvenance({ role: (original?.role ?? 'user') as CalendarRole, href: row.href }).source === 'booking') throw notRestorable('calendar_readonly');

  // Versione: quella indicata (valida, dell'oggetto, non scaduta) o l'ultima valida.
  let version: CalObjectVersionRow | null;
  if (req.version_id !== undefined) {
    version = await getObjectVersion(sql, req.version_id);
    if (!version) throw notFound('Versione non trovata');
  } else {
    const [latest] = await sql<CalObjectVersionRow[]>`
      SELECT id, object_id, calendar_id, href, etag, raw_ics, content_sha256, semantic_fp, change_kind, valid, actor, created_at
      FROM cal_object_versions
      WHERE object_id = ${row.id}::uuid AND valid AND change_kind <> 'delete' AND raw_ics IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT 1
    `;
    if (!latest) throw notRestorable('no_valid_version');
    if (isExpired(latest.created_at, now.getTime())) throw notRestorable('expired');
    version = latest;
  }
  const versionObject = restorableVersion(version, row.id, now);

  const uid = versionObject.uid;
  if ((await activeUids([uid])).has(uid)) throw notRestorable('uid_exists');

  const object = restoredObject(versionObject, null, now);
  const check = validate(object, dest, null, now);
  if (!check.ok && !req.dryRun) throw validationFailed(check.issues.find((i) => i.severity === 'error')?.message ?? 'Evento non valido', check.issues);

  const sameCalendar = dest.id === row.calendar_id;
  const viewOfRestored = (id: string, raw: string, etag: string | null, obj: CalendarObject) => {
    const resolved: Resolved = { id, objectId: id, recurrenceKey: MASTER_RECURRENCE_KEY, href: row.href, calendar: dest as SidecarRow };
    return viewOf({ resolved, raw, etag, object: obj, parseError: null, source: 'radicale' }, MASTER_RECURRENCE_KEY);
  };

  if (req.dryRun) {
    const { client, principal } = requireRadicale();
    if (await fetchCurrent(client, objectPath(principal, collectionNameOf(dest), row.href), 'l\'evento')) throw notRestorable('href_taken');
    return result({ object: await viewOfRestored(sameCalendar ? row.id : '', '', null, object), etag: null, changed: ['restore'], sequence_bumped: true, dry_run: true, valid: check.ok, issues: check.issues });
  }

  let outcome;
  try {
    outcome = await writeObject({
      calendar: dest,
      href: row.href,
      what: 'l\'evento',
      maxAttempts: MAX_ATTEMPTS,
      plan: (current) => {
        if (current) throw new HrefTaken();
        return { action: 'put', object, previous: null, changed: ['restore'] };
      },
    });
  } catch (err) {
    if (err instanceof HrefTaken) throw notRestorable('href_taken');
    if (err instanceof EventValidationError && /UID già presente/.test(err.message)) throw notRestorable('uid_exists');
    throw err;
  }

  await writeThrough([dest.id], ACTOR);
  // Stesso calendario: la riga ritirata torna attiva (stesso id). Altro calendario: MOVE riconosciuta entro 30 giorni, altrimenti id nuovo.
  const id = await positionId(dest.id, row.href, MASTER_RECURRENCE_KEY, uid);
  await markVersionRestored(sql, { objectId: id, href: row.href, etag: outcome.etagAfter, actor: actorLabel(actor) });
  await auditV2({
    operation: 'v2.trash_restore',
    action: 'INSERT',
    recordId: id,
    calendar: dest,
    href: row.href,
    etagBefore: null,
    etagAfter: outcome.etagAfter,
    changed: ['restore'],
    actor,
    extra: { version_id: version.id, source_object_id: row.id, ...(sameCalendar ? {} : { from_calendar_id: row.calendar_id }) },
  });
  return result({ object: await viewOfRestored(id, outcome.raw ?? '', outcome.etagAfter, outcome.object ?? object), etag: outcome.etagAfter, changed: ['restore'], sequence_bumped: true, issues: check.issues });
}
