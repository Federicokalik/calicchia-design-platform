/**
 * Import ed export di un calendario e lettura dei job dell'API admin v2 (F6
 * tranche C, passo C2; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.1, §9.1.4).
 *
 *  - Export (`GET /calendars/:id/export.ics`): un solo VCALENDAR con il PRODID
 *    del sistema, un VTIMEZONE per TZID (deduplicati) e ogni oggetto attivo
 *    dal testo di Radicale (fallback sull'indice), in streaming. I componenti
 *    si copiano riga per riga, senza rileggerli: nessuna perdita di VALARM,
 *    ATTENDEE o X-*.
 *  - Import dry run (`POST /calendars/:id/import`, `mode: dry_run`): il file si
 *    divide per UID (master e override insieme, VTIMEZONE allegati a chi li
 *    usa), ogni gruppo si valida con calendar-core e riceve un'azione
 *    (`create`, `replace`, `skip`, `new_uid`, `invalid`); il piano porta un
 *    `plan_hash`.
 *  - Import commit (`mode: commit` + `Idempotency-Key`): ricalcola il piano
 *    (hash diverso → 409 PLAN_CHANGED), accoda il job `calendar_import` (chiave
 *    `<calendar_id>:<Idempotency-Key>`, `request_hash` nel payload) e risponde
 *    202. Stessa chiave e stessa richiesta → lo stesso job, qualunque sia il
 *    suo stato; richiesta diversa → 409 IDEMPOTENCY_CONFLICT.
 *  - Il job scrive al più 20 oggetti al secondo, ciascuno dalla pipeline
 *    lossless dello store (gate cal-write, PUT con precondizione, audit senza
 *    testo), ricalcola ogni voce prima di scriverla (una voce cambiata nel
 *    frattempo va in `failed`, non si sovrascrive), aggiorna `result.progress`
 *    al più ogni 2 s sotto lease e riprende dal punto raggiunto dopo un'attesa
 *    (gate chiuso) o un riavvio. A fine lavoro (done o dead) il testo ICS si
 *    toglie dal payload: nessun testo di evento resta in `cal_jobs`.
 *  - Lettura (`GET /jobs/:jobId`): solo i tipi di `CAL_V2_JOB_KINDS`.
 */

import { createHash } from 'node:crypto';
import {
  CALDES_PRODID,
  type CalendarObject,
  cloneCalendarObject,
  componentUid,
  encodeText,
  FOLD_OCTETS,
  getProperty,
  getTextValue,
  type IcsComponent,
  IcsParseError,
  objectComponents,
  parseIcs,
  readTimeProperty,
  semanticFingerprint,
  serializeObject,
  setProperties,
  setProvenance,
  splitCalendar,
  timeToUtcMs,
  utf8ByteLength,
  X_CALDES,
} from '@calicchia/calendar-core';
import {
  CAL_V2_IMPORT_CONFLICT_MODES,
  CAL_V2_JOB_KINDS,
  type CalV2HoldActionResult,
  type CalV2ImportPlan,
  type CalV2ImportPlanItem,
  type CalV2ImportRequest,
  type CalV2ImportResult,
  type CalV2Issue,
  type CalV2JobAccepted,
  type CalV2JobKind,
  type CalV2JobView,
} from '@calicchia/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import { calSql, sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { CalendarConflictError, EventValidationError, isCalendarUnavailable } from '../errors';
import {
  CAL_JOB_KINDS,
  CAL_JOB_PRIORITY,
  type CalendarJob,
  type CalendarJobContext,
  CalendarJobPermanentError,
  type CalendarJobOutcome,
  enqueueCalendarJob,
  isCalendarJobWaitError,
  registerCalendarJobHandler,
} from '../jobs';
import { collectionPath, objectPath } from '../radicale/client';
import type { Db } from '../radicale/policy';
import {
  allowedComponents,
  audit,
  auditCalendarV2,
  collectionNameOf,
  generateEventUid,
  hrefForUid,
  positionId,
  requireRadicale,
  safeTz,
  sidecarById,
  type SidecarRow,
  writeObject,
  writeThrough,
} from '../radicale/store';
import { isValidCollectionName } from '../radicale/types';
import { assertV2ObjectsAvailable } from './capabilities';
import {
  CalendarV2Error,
  idempotencyConflict,
  idempotencyKeyRequired,
  invalidValue,
  payloadTooLarge,
  planChanged,
  readOnly,
  validationFailed,
} from './errors';
import { type AdminActor, ACTOR, MAX_ATTEMPTS, normalizeEtag, notFound, UUID_RE, validate, zodIssues } from './objects';

const log: Logger = rootLogger.child({ scope: 'calendar-admin-v2-import' });

// ═══════════════════════════════════════════════════════════════════
// Costanti
// ═══════════════════════════════════════════════════════════════════

/** Dimensione massima del file ICS (e del corpo della richiesta di import, che lo porta in JSON). */
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
/** Oggetti (gruppi per UID) al più per file. */
export const IMPORT_MAX_GROUPS = 5000;
/** Scritture al secondo del job (contratto §9.1.4). */
export const IMPORT_WRITES_PER_SECOND = 20;
/** Intervallo minimo fra due aggiornamenti di `result.progress` (e proroghe del lease). */
export const IMPORT_PROGRESS_INTERVAL_MS = 2_000;
/** Tentativi del job (contratto §9.1.1); le attese per indisponibilità non li consumano. */
export const IMPORT_JOB_MAX_ATTEMPTS = 3;
/** Lease del job: oltre i 120 s di default, perché 5000 oggetti a 20/s durano quattro minuti (il lease si proroga a ogni aggiornamento). */
const IMPORT_JOB_LEASE_MS = 300_000;
/** Scritture raccolte prima di write-through e audit. */
const FLUSH_EVERY = 100;
/** Voci di `failed` conservate nel risultato (il conteggio in `progress.failed` è sempre esatto). */
const MAX_FAILED_ENTRIES = 1000;
/** Oggetti per richiesta multiget dell'export. */
const EXPORT_BATCH = 50;
/** Righe di `summary` di una voce del piano. */
const SUMMARY_MAX = 200;
/** Proprietà descrittive del VCALENDAR del file che non appartengono alla singola risorsa. */
const DROPPED_CALENDAR_PROPERTIES = new Set(['METHOD', 'X-WR-CALNAME', 'X-WR-CALDESC', 'X-WR-TIMEZONE']);

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// ═══════════════════════════════════════════════════════════════════
// Richiesta
// ═══════════════════════════════════════════════════════════════════

const importSchema = z
  .object({
    ics: z.string().min(1, 'Il file ICS è vuoto'),
    mode: z.enum(['dry_run', 'commit']),
    on_conflict: z.enum(CAL_V2_IMPORT_CONFLICT_MODES),
    plan_hash: z.string().regex(HEX64_RE, 'plan_hash non valido').optional(),
  })
  .strict();

/** Corpo di `POST /calendars/:id/import` validato (la chiave d'idempotenza sta nell'header, mai nel corpo). */
export function parseImportRequest(raw: unknown): CalV2ImportRequest {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).some((k) => /^idempotency[-_ ]?key$/i.test(k))) {
    throw idempotencyKeyRequired('La chiave d\'idempotenza va nell\'header Idempotency-Key, non nel corpo');
  }
  const parsed = importSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta di import non valida', zodIssues(parsed.error));
  if (Buffer.byteLength(parsed.data.ics, 'utf8') > IMPORT_MAX_BYTES) throw payloadTooLarge(10);
  return parsed.data;
}

/** Header `Idempotency-Key` valido, altrimenti 400 IDEMPOTENCY_KEY_REQUIRED. */
export function requireIdempotencyKey(header: string | null | undefined): string {
  const value = (header ?? '').trim();
  if (!IDEMPOTENCY_KEY_RE.test(value)) throw idempotencyKeyRequired();
  return value;
}

// ═══════════════════════════════════════════════════════════════════
// Analisi del file
// ═══════════════════════════════════════════════════════════════════

interface ImportGroup {
  /** Posizione del gruppo nel file, da 0. */
  index: number;
  uid: string | null;
  /** Oggetto pronto da scrivere (METHOD tolto, provenienza `admin`); null se il gruppo è invalido. */
  object: CalendarObject | null;
  invalid: { reason: string } | null;
  summary: string | null;
  start_utc: string | null;
  recurring: boolean;
  issues: CalV2Issue[];
}

interface Analysis {
  groups: ImportGroup[];
  warnings: string[];
}

const INVALID_MESSAGES: Record<string, string> = {
  component_unsupported: 'Solo gli eventi (VEVENT) si importano: attività e note vengono ignorate',
  missing_uid: 'Componente senza UID: non si può importare',
  duplicate_master: 'Più eventi principali con lo stesso UID',
  too_large: 'Evento troppo grande (massimo 1 MB)',
  parse_error: 'Evento non interpretabile',
  validation_failed: 'Evento non valido',
};

function invalidReasonOf(code: string): string {
  switch (code) {
    case 'MISSING_UID':
      return 'missing_uid';
    case 'DUPLICATE_MASTER':
      return 'duplicate_master';
    case 'MIXED_COMPONENT_TYPES':
      return 'component_unsupported';
    case 'TOO_LARGE':
      return 'too_large';
    default:
      return 'parse_error';
  }
}

function invalidGroup(index: number, uid: string | null, reason: string, extra: CalV2Issue[] = []): ImportGroup {
  const base: CalV2Issue = { code: reason.toUpperCase(), severity: 'error', message: INVALID_MESSAGES[reason] ?? INVALID_MESSAGES.parse_error };
  return { index, uid, object: null, invalid: { reason }, summary: null, start_utc: null, recurring: false, issues: [base, ...extra] };
}

/**
 * Oggetto pronto per la scrittura: METHOD e proprietà descrittive del file
 * tolte, X-CALDES-* del file sostituite dalla provenienza `admin` del
 * sistema (design §5), UID nuovo per `new_uid` (RELATED-TO resta com'è).
 */
function prepareObject(source: CalendarObject, opts: { uid?: string; legacyId?: string | null } = {}): CalendarObject {
  const obj = cloneCalendarObject(source);
  obj.calendarProperties = obj.calendarProperties.filter((p) => !DROPPED_CALENDAR_PROPERTIES.has(p.name.toUpperCase()));
  for (const comp of objectComponents(obj)) {
    comp.properties = comp.properties.filter((p) => !p.name.toUpperCase().startsWith('X-CALDES-'));
    if (opts.uid) setProperties(comp, 'UID', [{ name: 'UID', params: [], value: encodeText(opts.uid) }]);
    setProvenance(comp, { source: 'admin' });
    if (opts.legacyId) setProvenance(comp, { legacyId: opts.legacyId });
  }
  if (opts.uid) obj.uid = opts.uid;
  return obj;
}

function summaryOf(obj: CalendarObject): string | null {
  const comp = obj.master ?? obj.overrides[0];
  const text = comp ? getTextValue(comp, 'SUMMARY')?.trim() : null;
  return text ? text.slice(0, SUMMARY_MAX) : null;
}

function startUtcOf(obj: CalendarObject, tz: string): string | null {
  const comp = obj.master ?? obj.overrides[0];
  const prop = comp ? getProperty(comp, 'DTSTART') : null;
  if (!prop) return null;
  try {
    return new Date(timeToUtcMs(readTimeProperty(prop), { tz, timezones: obj.timezones })).toISOString();
  } catch {
    return null;
  }
}

/** TZID usati dai componenti e non definiti da un VTIMEZONE del file né noti come fusi IANA. */
function undefinedTimezones(cal: IcsComponent, isKnown: (tz: string) => boolean): string[] {
  const defined = new Set<string>();
  for (const c of cal.components) {
    if (c.name !== 'VTIMEZONE') continue;
    const tz = c.properties.find((p) => p.name.toUpperCase() === 'TZID')?.value;
    if (tz) defined.add(tz);
  }
  const missing = new Set<string>();
  const visit = (c: IcsComponent): void => {
    for (const p of c.properties) {
      for (const param of p.params) {
        if (param.name.toUpperCase() !== 'TZID') continue;
        for (const v of param.values) if (!defined.has(v) && !isKnown(v)) missing.add(v);
      }
    }
    c.components.forEach(visit);
  };
  cal.components.filter((c) => c.name !== 'VTIMEZONE').forEach(visit);
  return [...missing];
}

/**
 * File ICS → gruppi per UID nell'ordine del file, ciascuno già validato per
 * il calendario di destinazione. Un file che non è iCalendar, o con più di
 * 5000 oggetti, è un 400; un gruppo rotto non ferma gli altri.
 */
export function analyzeIcs(ics: string, calendar: Pick<SidecarRow, 'timezone' | 'components' | 'role' | 'origin'>, now: Date = new Date()): Analysis {
  if (Buffer.byteLength(ics, 'utf8') > IMPORT_MAX_BYTES) throw payloadTooLarge(10);
  const parsed = parseIcs(ics, { malformedLines: 'skip', multipleCalendars: 'merge', maxBytes: IMPORT_MAX_BYTES });
  if (!parsed.ok) {
    throw invalidValue(
      parsed.error.code === 'TOO_LARGE' ? 'Il file ICS è troppo grande (massimo 10 MB)' : 'Il file non è un calendario iCalendar valido',
      'ics',
    );
  }
  const cal = parsed.value;
  const warnings: string[] = [];
  const skippedLines = parsed.warnings.filter((w) => w.code === 'SKIPPED_LINE').length;
  if (skippedLines > 0) warnings.push(`${skippedLines} righe malformate sono state ignorate`);
  if (parsed.warnings.some((w) => w.code === 'MERGED_VCALENDAR')) {
    warnings.push('Il file contiene più calendari: sono stati uniti in uno solo');
  }
  if (cal.properties.some((p) => p.name.toUpperCase() === 'METHOD')) warnings.push('La proprietà METHOD del file è stata rimossa');

  const split = splitCalendar(cal, { duplicateMasters: 'error' });
  const ignored = split.warnings.filter((w) => w.code === 'IGNORED_COMPONENT').length;
  if (ignored > 0) warnings.push(`${ignored} componenti di altro tipo (es. VFREEBUSY) sono stati ignorati`);

  const objectsByUid = new Map(split.objects.map((o) => [o.uid, o]));
  const errorsByUid = new Map<string, IcsParseError>();
  for (const e of split.errors) if (e.uid !== null) errorsByUid.set(e.uid, e.error);

  const tz = safeTz(calendar.timezone);
  const groups: ImportGroup[] = [];
  const seen = new Set<string>();
  for (const child of cal.components) {
    const name = child.name.toUpperCase();
    if (name !== 'VEVENT' && name !== 'VTODO' && name !== 'VJOURNAL') continue;
    const uid = componentUid(child);
    if (groups.length >= IMPORT_MAX_GROUPS && (uid === null || !seen.has(uid))) {
      throw invalidValue(`Il file contiene più di ${IMPORT_MAX_GROUPS} eventi: dividilo in più file`, 'ics');
    }
    const index = groups.length;
    if (uid === null) {
      groups.push(invalidGroup(index, null, 'missing_uid'));
      continue;
    }
    if (seen.has(uid)) continue;
    seen.add(uid);
    const error = errorsByUid.get(uid);
    if (error) {
      groups.push(invalidGroup(index, uid, invalidReasonOf(error.code)));
      continue;
    }
    const source = objectsByUid.get(uid);
    if (!source) {
      groups.push(invalidGroup(index, uid, 'parse_error'));
      continue;
    }
    if (source.componentType !== 'VEVENT') {
      groups.push(invalidGroup(index, uid, 'component_unsupported'));
      continue;
    }
    groups.push(describeEvent(index, source, calendar, tz, now));
  }

  const unknownTz = undefinedTimezones(cal, (id) => id !== '' && isIana(id));
  if (unknownTz.length > 0) {
    warnings.push(`Fusi orari non definiti nel file (VTIMEZONE mancante): ${unknownTz.slice(0, 5).join(', ')}${unknownTz.length > 5 ? '…' : ''}`);
  }
  if (groups.length === 0) warnings.push('Il file non contiene eventi');
  return { groups, warnings };
}

function isIana(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Gruppo VEVENT: oggetto preparato, validazione per il calendario, riepilogo per l'anteprima. */
function describeEvent(index: number, source: CalendarObject, calendar: Pick<SidecarRow, 'timezone' | 'components' | 'role' | 'origin'>, tz: string, now: Date): ImportGroup {
  let object: CalendarObject;
  try {
    object = prepareObject(source);
    serializeObject(object);
  } catch {
    return invalidGroup(index, source.uid, 'parse_error');
  }
  const check = validate(object, calendar as SidecarRow, null, now);
  const base = {
    index,
    uid: source.uid,
    summary: summaryOf(object),
    start_utc: startUtcOf(object, tz),
    recurring: Boolean(object.master && (getProperty(object.master, 'RRULE') || getProperty(object.master, 'RDATE'))),
    issues: check.issues,
  };
  if (!check.ok) {
    const reason = check.issues.some((i) => i.severity === 'error' && i.code === 'TOO_LARGE') ? 'too_large' : 'validation_failed';
    return { ...base, object: null, invalid: { reason } };
  }
  return { ...base, object, invalid: null };
}

// ═══════════════════════════════════════════════════════════════════
// Piano
// ═══════════════════════════════════════════════════════════════════

interface PlannedGroup {
  item: CalV2ImportPlanItem;
  group: ImportGroup;
  /** Oggetto già presente nel calendario con lo stesso UID (href ed ETag dell'indice). */
  existing: { href: string; etag: string | null } | null;
}

interface ImportPlanInternal {
  plan: CalV2ImportPlan;
  planned: PlannedGroup[];
  analysis: Analysis;
}

/** Il calendario accetta import: ruolo `user` o `deadlines`, non archivio, con VEVENT nel component-set. */
export function assertImportable(cal: SidecarRow): void {
  if (cal.role === 'subscription') readOnlyImport('subscription', 'Le iscrizioni sono in sola lettura: gli eventi arrivano dal calendario remoto');
  if (cal.origin === 'migration') readOnlyImport('archive', 'Archivio della Fase 0: sola lettura');
  if (cal.role !== 'user' && cal.role !== 'deadlines') readOnlyImport('system', 'Questo calendario è gestito dal sistema: non si importano eventi');
  if (!allowedComponents(cal).includes('VEVENT')) readOnlyImport('component_unsupported', 'Questo calendario non accetta eventi');
}

function readOnlyImport(reason: string, message: string): never {
  throw readOnly(message, reason);
}

async function requireImportTarget(calendarId: string): Promise<SidecarRow> {
  if (!UUID_RE.test(calendarId)) throw notFound('Calendario non trovato');
  const cal = await sidecarById(calendarId, { activeOnly: true });
  if (!cal) throw notFound('Calendario non trovato');
  return cal;
}

/** Piano di un import: azione per gruppo secondo lo stato corrente dell'indice. */
async function computePlan(cal: SidecarRow, ics: string, onConflict: CalV2ImportRequest['on_conflict']): Promise<ImportPlanInternal> {
  const analysis = analyzeIcs(ics, cal);
  const uids = [...new Set(analysis.groups.filter((g) => g.object).map((g) => (g.object as CalendarObject).uid))];
  const existingByUid = new Map<string, { href: string; etag: string | null }>();
  const elsewhere = new Set<string>();
  if (uids.length > 0) {
    const here = await sql<Array<{ uid: string; href: string; etag: string | null }>>`
      SELECT uid, href, etag FROM cal_objects
      WHERE calendar_id = ${cal.id}::uuid AND uid = ANY(${uids}) ORDER BY href
    `;
    for (const r of here) if (!existingByUid.has(r.uid)) existingByUid.set(r.uid, { href: r.href, etag: r.etag });
    const other = await sql<Array<{ uid: string }>>`
      SELECT DISTINCT o.uid FROM cal_objects o
      JOIN calendars c ON c.id = o.calendar_id AND c.lifecycle = 'active'
      WHERE o.calendar_id <> ${cal.id}::uuid AND o.uid = ANY(${uids})
    `;
    for (const r of other) elsewhere.add(r.uid);
  }

  const planned: PlannedGroup[] = analysis.groups.map((group) => {
    const base = { index: group.index, uid: group.uid, summary: group.summary, start_utc: group.start_utc, recurring: group.recurring, issues: group.issues };
    if (group.invalid || !group.object) {
      return { group, existing: null, item: { ...base, action: 'invalid', reason: group.invalid?.reason ?? 'parse_error' } };
    }
    const uid = group.object.uid;
    const existing = existingByUid.get(uid) ?? null;
    if (existing) {
      if (onConflict === 'skip') return { group, existing, item: { ...base, action: 'skip', reason: 'uid_exists' } };
      if (onConflict === 'replace') return { group, existing, item: { ...base, action: 'replace', reason: null } };
      return { group, existing, item: { ...base, action: 'new_uid', reason: 'uid_exists' } };
    }
    if (elsewhere.has(uid)) {
      if (onConflict === 'skip') return { group, existing: null, item: { ...base, action: 'skip', reason: 'uid_in_other_calendar' } };
      return { group, existing: null, item: { ...base, action: 'new_uid', reason: 'uid_in_other_calendar' } };
    }
    return { group, existing: null, item: { ...base, action: 'create', reason: null } };
  });

  const count = (action: CalV2ImportPlanItem['action']): number => planned.filter((p) => p.item.action === action).length;
  const items = planned.map((p) => p.item);
  // Il hash lega il piano al file (sha256), al calendario, alla modalità e, per le sostituzioni, all'ETag che si andrà a sovrascrivere.
  const planHash = sha256(
    JSON.stringify([
      cal.id,
      onConflict,
      sha256(ics),
      planned.map((p) => [p.item.index, p.item.uid, p.item.action, p.item.reason, p.item.action === 'replace' ? [p.existing?.href ?? null, p.existing?.etag ?? null] : null]),
    ]),
  );
  const plan: CalV2ImportPlan = {
    calendar_id: cal.id,
    total: items.length,
    create: count('create'),
    replace: count('replace'),
    skip: count('skip'),
    new_uid: count('new_uid'),
    invalid: count('invalid'),
    items,
    warnings: analysis.warnings,
    plan_hash: planHash,
  };
  return { plan, planned, analysis };
}

// ═══════════════════════════════════════════════════════════════════
// Route: import
// ═══════════════════════════════════════════════════════════════════

interface ImportJobItem {
  index: number;
  action: CalV2ImportPlanItem['action'];
  /** `replace`: href ed ETag dell'oggetto da sostituire all'anteprima. */
  href: string | null;
  etag: string | null;
  /** `new_uid`: UID scelto al commit (fisso nel payload, così una ripresa non ne genera un altro). */
  new_uid: string | null;
}

interface ImportJobPayload extends Record<string, unknown> {
  calendar_id: string;
  ics: string;
  on_conflict: CalV2ImportRequest['on_conflict'];
  plan_hash: string;
  request_hash: string;
  user_id: string | null;
  items: ImportJobItem[];
}

interface JobRef {
  id: string;
  request_hash: string | null;
}

/** Il job più recente con questa chiave, qualunque sia il suo stato. */
async function findJobByKey(key: string, db: Db = sql as unknown as Db): Promise<JobRef | null> {
  const [row] = await db<Array<{ id: string; request_hash: string | null }>>`
    SELECT id::text AS id, payload->>'request_hash' AS request_hash
    FROM cal_jobs WHERE kind = ${CAL_JOB_KINDS.calendarImport} AND key = ${key}
    ORDER BY id DESC LIMIT 1
  `;
  return row ?? null;
}

/** `POST /calendars/:id/import`: dry run → 200 `CalV2ImportPlan`; commit → 202 `CalV2JobAccepted`. */
export async function importCalendarV2(
  calendarId: string,
  req: CalV2ImportRequest,
  idempotencyKey: string | null | undefined,
  actor: AdminActor,
): Promise<{ status: 200; body: CalV2ImportPlan } | { status: 202; body: CalV2JobAccepted }> {
  await assertV2ObjectsAvailable();
  const cal = await requireImportTarget(calendarId);
  assertImportable(cal);

  if (req.mode === 'dry_run') {
    return { status: 200, body: (await computePlan(cal, req.ics, req.on_conflict)).plan };
  }

  const key = requireIdempotencyKey(idempotencyKey);
  if (!req.plan_hash) throw invalidValue('Per confermare l\'import serve il plan_hash dell\'anteprima', 'plan_hash');
  const jobKey = `${cal.id}:${key}`;
  const requestHash = sha256(JSON.stringify([cal.id, req.on_conflict, req.plan_hash, sha256(req.ics)]));

  // Stessa chiave: nessun ricalcolo del piano (a import fatto l'hash sarebbe cambiato) ma lo stesso job.
  const known = await findJobByKey(jobKey);
  if (known) return { status: 202, body: sameRequest(known, requestHash) };

  const computed = await computePlan(cal, req.ics, req.on_conflict);
  if (computed.plan.plan_hash !== req.plan_hash) throw planChanged(computed.plan);

  const items: ImportJobItem[] = computed.planned.map((p) => ({
    index: p.item.index,
    action: p.item.action,
    href: p.item.action === 'replace' ? p.existing?.href ?? null : null,
    etag: p.item.action === 'replace' ? p.existing?.etag ?? null : null,
    new_uid: p.item.action === 'new_uid' ? generateEventUid() : null,
  }));
  const payload: ImportJobPayload = {
    calendar_id: cal.id,
    ics: req.ics,
    on_conflict: req.on_conflict,
    plan_hash: req.plan_hash,
    request_hash: requestHash,
    user_id: actor.userId,
    items,
  };

  // La ricerca e l'inserimento stanno sotto lo stesso lock: due richieste uguali e contemporanee ottengono lo stesso job.
  const accepted = await sql.begin(async (tx) => {
    const db = tx as unknown as Db;
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`${CAL_JOB_KINDS.calendarImport}:${jobKey}`}, 0))`;
    const again = await findJobByKey(jobKey, db);
    if (again) return sameRequest(again, requestHash);
    const job = await enqueueCalendarJob(CAL_JOB_KINDS.calendarImport, jobKey, payload, {
      db,
      priority: CAL_JOB_PRIORITY.normal,
      maxAttempts: IMPORT_JOB_MAX_ATTEMPTS,
    });
    return { job_id: job.id, created: true } satisfies CalV2JobAccepted;
  });
  return { status: 202, body: accepted };
}

/** Stessa chiave: lo stesso job se la richiesta è identica, altrimenti 409 IDEMPOTENCY_CONFLICT. */
function sameRequest(known: JobRef, requestHash: string): CalV2JobAccepted {
  if (known.request_hash !== requestHash) throw idempotencyConflict();
  return { job_id: known.id, created: false };
}

// ═══════════════════════════════════════════════════════════════════
// Job calendar_import
// ═══════════════════════════════════════════════════════════════════

type FailedEntry = CalV2ImportResult['failed'][number];

interface ImportState {
  created: number;
  replaced: number;
  skipped: number;
  failed: FailedEntry[];
  failedCount: number;
  /** Prossimo gruppo da elaborare. */
  cursor: number;
}

function emptyState(): ImportState {
  return { created: 0, replaced: 0, skipped: 0, failed: [], failedCount: 0, cursor: 0 };
}

/** Stato conservato in `cal_jobs.result` (riletto a ogni ripresa). */
function stateResult(state: ImportState, total: number): Record<string, unknown> {
  return {
    created: state.created,
    replaced: state.replaced,
    skipped: state.skipped,
    failed: state.failed,
    progress: { total, done: state.cursor, failed: state.failedCount },
    cursor: state.cursor,
  };
}

function readState(result: unknown): ImportState {
  const r = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const progress = r.progress && typeof r.progress === 'object' ? (r.progress as Record<string, unknown>) : {};
  const failed = Array.isArray(r.failed) ? (r.failed as FailedEntry[]) : [];
  return {
    created: num(r.created),
    replaced: num(r.replaced),
    skipped: num(r.skipped),
    failed,
    failedCount: Math.max(num(progress.failed), failed.length),
    cursor: num(r.cursor),
  };
}

/** La voce non si può più scrivere come da piano (cambiata nel frattempo): `failed`, mai una sovrascrittura. */
class ItemChanged extends Error {
  constructor(readonly code: 'changed' | 'uid_exists' | 'object_gone') {
    super(code);
    this.name = 'ItemChanged';
  }
}

const ITEM_MESSAGES: Record<string, string> = {
  changed: 'L\'evento è cambiato dopo l\'anteprima: non è stato sovrascritto',
  uid_exists: 'Nel frattempo esiste già un evento con lo stesso UID',
  object_gone: 'L\'evento da sostituire non esiste più',
  write_failed: 'Scrittura non riuscita',
  VALIDATION_FAILED: 'L\'evento non è valido per il calendario',
};

/** Voce fallita → codice e messaggio senza testo dell'evento. */
function failureOf(err: unknown): { code: string; message: string } {
  if (err instanceof ItemChanged) return { code: err.code, message: ITEM_MESSAGES[err.code] };
  if (err instanceof EventValidationError) {
    if (/UID già presente/.test(err.message)) return { code: 'uid_exists', message: ITEM_MESSAGES.uid_exists };
    return { code: 'VALIDATION_FAILED', message: err.message.slice(0, 200) || ITEM_MESSAGES.VALIDATION_FAILED };
  }
  if (err instanceof CalendarConflictError) return { code: 'changed', message: ITEM_MESSAGES.changed };
  if (err instanceof CalendarV2Error) return { code: err.code, message: err.message.slice(0, 200) };
  return { code: 'write_failed', message: ITEM_MESSAGES.write_failed };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parsePayload(payload: Record<string, unknown>): ImportJobPayload {
  const ok =
    typeof payload.calendar_id === 'string' &&
    typeof payload.ics === 'string' &&
    Array.isArray(payload.items) &&
    typeof payload.on_conflict === 'string' &&
    (CAL_V2_IMPORT_CONFLICT_MODES as readonly string[]).includes(payload.on_conflict);
  if (!ok) throw new CalendarJobPermanentError('Payload del job di import non valido');
  return payload as ImportJobPayload;
}

/** Toglie il testo ICS dal payload (best effort: lo ripete la pulizia alla lettura del job). */
async function stripIcs(jobId: string): Promise<void> {
  try {
    await calSql`UPDATE cal_jobs SET payload = payload - 'ics' WHERE id = ${jobId}`;
  } catch (err) {
    log.warn({ err: (err as Error)?.name, jobId }, 'testo ICS non rimosso dal payload del job: lo toglierà la lettura del job');
  }
}

interface Written {
  href: string;
  uid: string;
  created: boolean;
  etagBefore: string | null;
  etagAfter: string | null;
}

/** Esegue l'import: una scrittura alla volta, con ripresa dal punto raggiunto. */
export async function runCalendarImportJob(job: CalendarJob, ctx: CalendarJobContext): Promise<CalendarJobOutcome> {
  const jobLog = ctx.log ?? log;
  try {
    return await executeImport(job, ctx, jobLog);
  } catch (err) {
    // Fine del lavoro per errore definitivo o tentativi esauriti: il testo dell'evento non deve restare in cal_jobs.
    if (err instanceof CalendarJobPermanentError || (!isCalendarJobWaitError(err) && job.attempts >= job.maxAttempts)) {
      await stripIcs(job.id);
    }
    throw err;
  }
}

async function executeImport(job: CalendarJob, ctx: CalendarJobContext, jobLog: Logger): Promise<CalendarJobOutcome> {
  const payload = parsePayload(job.payload);
  const cal = await sidecarById(payload.calendar_id, { activeOnly: true });
  if (!cal) throw new CalendarJobPermanentError('Il calendario di destinazione non esiste più');
  try {
    assertImportable(cal);
  } catch {
    throw new CalendarJobPermanentError('Il calendario di destinazione non accetta più import');
  }
  const analysis = analyzeIcs(payload.ics, cal);
  const items = payload.items as ImportJobItem[];
  if (analysis.groups.length !== items.length) throw new CalendarJobPermanentError('Il file non corrisponde al piano confermato');

  // Pulizia dei payload di import già chiusi (job dead per lease scaduto, mai passati dal nostro catch).
  await calSql`
    UPDATE cal_jobs SET payload = payload - 'ics'
    WHERE kind = ${CAL_JOB_KINDS.calendarImport} AND status IN ('done', 'dead', 'superseded') AND payload ? 'ics'
  `.catch((err: unknown) => jobLog.warn({ err: (err as Error)?.name }, 'pulizia dei payload di import chiusi non riuscita'));

  const [saved] = await calSql<Array<{ result: unknown }>>`SELECT result FROM cal_jobs WHERE id = ${job.id}`;
  const state = readState(saved?.result);
  const total = items.length;

  const pending: Written[] = [];
  let lastSave = Date.now();
  let lastWrite = 0;

  const save = async (): Promise<void> => {
    await calSql`
      UPDATE cal_jobs SET result = ${calSql.json(stateResult(state, total) as Parameters<typeof calSql.json>[0])}
      WHERE id = ${job.id} AND status = 'running' AND lease_token = ${job.leaseToken}::uuid
    `;
    lastSave = Date.now();
  };

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    try {
      await writeThrough([cal.id], ACTOR);
      for (const w of batch) {
        const id = await positionId(cal.id, w.href, '', w.uid);
        await audit({
          action: w.created ? 'INSERT' : 'UPDATE',
          recordId: id,
          operation: 'v2.import',
          calendar: cal,
          href: w.href,
          etagBefore: w.etagBefore,
          etagAfter: w.etagAfter,
          changed: ['import'],
          actor: ACTOR,
          extra: { job_id: job.id, ...(payload.user_id ? { user_id: payload.user_id } : {}) },
        });
      }
    } catch (err) {
      jobLog.warn({ err: (err as Error)?.name }, 'write-through o audit dell\'import non riusciti: le scritture restano valide, indicizzerà il watcher');
    }
  };

  const fail = (item: ImportJobItem, group: ImportGroup, code: string, message: string): void => {
    state.failedCount++;
    if (state.failed.length < MAX_FAILED_ENTRIES) state.failed.push({ index: item.index, uid: group.uid, code, message });
  };

  try {
    for (let i = state.cursor; i < total; i++) {
      if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('job interrotto');
      const item = items[i];
      const group = analysis.groups[i];
      if (item.action === 'skip') {
        state.skipped++;
      } else if (item.action === 'invalid' || !group.object) {
        fail(item, group, group.invalid?.reason ?? 'parse_error', INVALID_MESSAGES[group.invalid?.reason ?? 'parse_error'] ?? INVALID_MESSAGES.parse_error);
      } else {
        // Al più 20 scritture al secondo.
        const gap = 1000 / IMPORT_WRITES_PER_SECOND - (Date.now() - lastWrite);
        if (gap > 0) await sleep(gap);
        lastWrite = Date.now();
        try {
          const written = await writeItem(cal, group.object, item);
          if (written) {
            pending.push(written);
            if (item.action === 'replace') state.replaced++;
            else state.created++;
          } else if (item.action === 'replace') state.replaced++;
          else state.created++;
        } catch (err) {
          if (isCalendarUnavailable(err) || isCalendarJobWaitError(err)) throw err;
          const f = failureOf(err);
          if (f.code === 'write_failed') jobLog.warn({ err: (err as Error)?.name, index: item.index }, 'voce di import non scritta');
          fail(item, group, f.code, f.message);
        }
      }
      state.cursor = i + 1;
      if (pending.length >= FLUSH_EVERY) await flush();
      if (Date.now() - lastSave >= IMPORT_PROGRESS_INTERVAL_MS) {
        await save();
        await ctx.extendLease();
      }
    }
  } catch (err) {
    // Attesa o interruzione: si registra il punto raggiunto, così la ripresa non rifà il lavoro.
    await flush();
    await save().catch(() => undefined);
    throw err;
  }

  await flush();
  const result = stateResult(state, total);
  await save().catch(() => undefined);
  await stripIcs(job.id);
  await auditCalendarV2({
    action: 'UPDATE',
    recordId: cal.id,
    operation: 'v2.import.job',
    changed: ['import'],
    actor: ACTOR,
    extra: {
      job_id: job.id,
      created: state.created,
      replaced: state.replaced,
      skipped: state.skipped,
      failed: state.failedCount,
      total,
      ...(payload.user_id ? { user_id: payload.user_id } : {}),
    },
  });
  jobLog.info({ created: state.created, replaced: state.replaced, skipped: state.skipped, failed: state.failedCount, total }, 'import completato');
  return { result: { ...result, cursor: undefined } };
}

/**
 * La risorsa presente è già il risultato di questa voce (scritta da un tentativo
 * interrotto prima di registrare il punto raggiunto)? Si confronta il contenuto
 * semantico, non i byte: Radicale può riordinare le proprietà e DTSTAMP,
 * LAST-MODIFIED e SEQUENCE non contano.
 */
function alreadyApplied(current: CalendarObject | null, wanted: CalendarObject): boolean {
  if (!current) return false;
  try {
    return semanticFingerprint(current) === semanticFingerprint(wanted);
  } catch {
    return false;
  }
}

/**
 * Scrive una voce dalla pipeline dello store. Restituisce la scrittura
 * avvenuta, o null se il testo voluto c'era già (ripresa dopo un'interruzione
 * fra la PUT e il salvataggio del punto raggiunto).
 */
async function writeItem(cal: SidecarRow, source: CalendarObject, item: ImportJobItem): Promise<Written | null> {
  const newUid = item.action === 'new_uid' ? item.new_uid : null;
  if (item.action === 'new_uid' && !newUid) throw new ItemChanged('changed');
  if (item.action === 'replace' && !item.href) throw new ItemChanged('object_gone');
  const uid = newUid ?? source.uid;
  const href = item.action === 'replace' ? (item.href as string) : hrefForUid(uid);

  const outcome = await writeObject({
    calendar: cal,
    href,
    what: 'l\'evento',
    maxAttempts: MAX_ATTEMPTS,
    plan: (current) => {
      if (item.action === 'replace') {
        if (!current) throw new ItemChanged('object_gone');
        const legacy = current.object?.master ? getTextValue(current.object.master, X_CALDES.LEGACY_ID) : null;
        const object = prepareObject(source, { legacyId: legacy });
        const text = serializeObject(object);
        if (normalizeEtag(current.etag) !== normalizeEtag(item.etag)) {
          if (alreadyApplied(current.object, object)) return { action: 'none' };
          throw new ItemChanged('changed');
        }
        return { action: 'put', object, previous: current.object, text, changed: ['import'] };
      }
      const object = prepareObject(source, newUid ? { uid: newUid } : {});
      const text = serializeObject(object);
      if (current) {
        if (alreadyApplied(current.object, object)) return { action: 'none' };
        throw new ItemChanged('uid_exists');
      }
      return { action: 'put', object, previous: null, text, changed: ['import'] };
    },
  });
  if (outcome.action !== 'put') return null;
  return { href, uid, created: outcome.created, etagBefore: outcome.etagBefore, etagAfter: outcome.etagAfter };
}

/** Registra l'handler del job `calendar_import` (idempotente; lo chiama il cron del calendario). */
export function registerCalendarImportJob(): void {
  registerCalendarJobHandler(CAL_JOB_KINDS.calendarImport, runCalendarImportJob, { leaseMs: IMPORT_JOB_LEASE_MS });
}

// ═══════════════════════════════════════════════════════════════════
// Route: job
// ═══════════════════════════════════════════════════════════════════

interface JobDbRow {
  id: string;
  kind: string;
  status: CalV2JobView['status'];
  calendar_id: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  attempts: number;
  result: Record<string, unknown> | null;
  last_error: string | null;
}

function isJobKind(kind: string): kind is CalV2JobKind {
  return (CAL_V2_JOB_KINDS as readonly string[]).includes(kind);
}

/** `GET /jobs/:jobId`: solo i tipi di `CAL_V2_JOB_KINDS`, altrimenti 404. */
export async function readJobV2(jobId: string): Promise<CalV2JobView> {
  await assertV2ObjectsAvailable();
  if (!/^\d{1,18}$/.test(jobId)) throw notFound('Lavoro non trovato');
  const [row] = await sql<JobDbRow[]>`
    SELECT id::text AS id, kind, status,
           COALESCE(payload->>'calendar_id', split_part(key, ':', 1)) AS calendar_id,
           created_at, started_at, finished_at, attempts, result, last_error
    FROM cal_jobs
    WHERE id = ${jobId}::bigint AND kind = ANY(${[...CAL_V2_JOB_KINDS]})
  `;
  if (!row || !isJobKind(row.kind)) throw notFound('Lavoro non trovato');
  // Un job chiuso non deve tenere il testo ICS (anche se è finito senza passare dal nostro handler).
  if (row.status !== 'pending' && row.status !== 'running') {
    await sql`UPDATE cal_jobs SET payload = payload - 'ics' WHERE id = ${row.id}::bigint AND payload ? 'ics'`.catch(() => undefined);
  }
  const stored = row.result && typeof row.result === 'object' ? row.result : null;
  const p = stored?.progress && typeof stored.progress === 'object' ? (stored.progress as Record<string, unknown>) : null;
  const progress =
    p && [p.total, p.done, p.failed].every((n) => typeof n === 'number' && Number.isFinite(n))
      ? { total: p.total as number, done: p.done as number, failed: p.failed as number }
      : null;
  let result: CalV2JobView['result'] = null;
  if (stored && (row.status === 'done' || row.status === 'dead')) {
    const { progress: _progress, cursor: _cursor, ...rest } = stored;
    result = rest as unknown as CalV2ImportResult | CalV2HoldActionResult;
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    calendar_id: row.calendar_id ?? '',
    created_at: row.created_at.toISOString(),
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    attempts: row.attempts,
    progress,
    result,
    error: row.status === 'done' || !row.last_error ? null : row.last_error.slice(0, 300),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════════════

/** Riga logica piegata a 75 ottetti (RFC 5545 §3.1) con CRLF finale. */
function foldLine(line: string): string {
  if (utf8ByteLength(line) <= FOLD_OCTETS) return `${line}\r\n`;
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = FOLD_OCTETS;
  for (const ch of line) {
    const b = utf8ByteLength(ch);
    if (bytes + b > limit) {
      parts.push(current);
      current = '';
      bytes = 1;
      limit = FOLD_OCTETS;
    }
    current += ch;
    bytes += b;
  }
  parts.push(current);
  return `${parts.join('\r\n ')}\r\n`;
}

interface ExtractedResource {
  /** VTIMEZONE per TZID, righe già in CRLF. */
  timezones: Map<string, string>;
  /** Componenti diversi da VTIMEZONE, righe in CRLF, byte per byte come nel testo di origine. */
  body: string;
}

/**
 * Componenti di un VCALENDAR copiati riga per riga: i VTIMEZONE a parte (per
 * deduplicarli), tutto il resto così com'è. Le righe BEGIN/END non si
 * piegano mai, quindi la scansione per righe fisiche è esatta. Un testo che
 * non è un VCALENDAR (oggetto illeggibile) restituisce null.
 */
export function extractResource(raw: string): ExtractedResource | null {
  const lines = raw.split(/\r\n|\n|\r/);
  const timezones = new Map<string, string>();
  const body: string[] = [];
  let depth = 0;
  let seenCalendar = false;
  let child: { name: string; lines: string[]; tzid: string | null } | null = null;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:')) {
      depth++;
      if (depth === 1) {
        if (upper !== 'BEGIN:VCALENDAR') return null;
        seenCalendar = true;
        continue;
      }
      if (depth === 2) child = { name: upper.slice(6), lines: [], tzid: null };
    } else if (upper.startsWith('END:')) {
      if (child) child.lines.push(line);
      if (depth === 2 && child) {
        const text = child.lines.map((l) => `${l}\r\n`).join('');
        if (child.name === 'VTIMEZONE') {
          const key = child.tzid ?? `__${timezones.size}`;
          if (!timezones.has(key)) timezones.set(key, text);
        } else {
          body.push(text);
        }
        child = null;
      }
      depth--;
      continue;
    }
    if (depth >= 2 && child) {
      child.lines.push(line);
      if (depth === 2 && child.name === 'VTIMEZONE' && /^TZID[:;]/i.test(line)) child.tzid = line.slice(line.indexOf(':') + 1).trim();
    }
  }
  if (!seenCalendar || depth !== 0) return null;
  return { timezones, body: body.join('') };
}

/** Testo di ogni href: da Radicale in blocchi (multiget), con ripiego sul testo dell'indice. */
async function* exportTexts(cal: SidecarRow, hrefs: string[]): AsyncGenerator<string> {
  const fromRadicale = cal.role !== 'subscription' && isValidCollectionName(cal.collection_name);
  for (let i = 0; i < hrefs.length; i += EXPORT_BATCH) {
    const batch = hrefs.slice(i, i + EXPORT_BATCH);
    const texts = new Map<string, string>();
    if (fromRadicale) {
      try {
        const { client, principal } = requireRadicale();
        const base = collectionNameOf(cal);
        const res = await client.calendarMultiget(collectionPath(principal, base), batch.map((h) => objectPath(principal, base, h)), { timeoutMs: 10_000 });
        for (const o of res.objects) if (o.data) texts.set(o.name, o.data);
      } catch (err) {
        log.warn({ err: (err as Error)?.name, calendarId: cal.id }, 'export: lettura da Radicale non riuscita, si usa il testo dell\'indice');
      }
    }
    const missing = batch.filter((h) => !texts.has(h));
    if (missing.length > 0) {
      const rows = await sql<Array<{ href: string; raw_ics: string | null }>>`
        SELECT href, raw_ics FROM cal_objects WHERE calendar_id = ${cal.id}::uuid AND href = ANY(${missing})
      `;
      for (const r of rows) if (r.raw_ics) texts.set(r.href, r.raw_ics);
    }
    for (const href of batch) {
      const text = texts.get(href);
      if (text) yield text;
    }
  }
}

/**
 * Testo dell'export in blocchi: intestazione, i VTIMEZONE (uno per TZID,
 * raccolti mentre si scorrono gli oggetti) e i componenti. I VTIMEZONE vanno
 * prima degli eventi che li usano: si scrivono man mano che compaiono, in
 * testa al blocco dell'oggetto che li porta (una volta sola).
 */
async function* exportChunks(cal: SidecarRow, hrefs: string[]): AsyncGenerator<string> {
  yield 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n';
  yield foldLine(`PRODID:${CALDES_PRODID}`);
  yield 'CALSCALE:GREGORIAN\r\n';
  yield foldLine(`X-WR-CALNAME:${encodeText(cal.name)}`);
  yield foldLine(`X-WR-TIMEZONE:${cal.timezone}`);
  const emitted = new Set<string>();
  let skipped = 0;
  for await (const text of exportTexts(cal, hrefs)) {
    const resource = extractResource(text);
    if (!resource) {
      skipped++;
      continue;
    }
    for (const [tzid, tzText] of resource.timezones) {
      if (emitted.has(tzid)) continue;
      emitted.add(tzid);
      yield tzText;
    }
    yield resource.body;
  }
  if (skipped > 0) log.warn({ calendarId: cal.id, skipped }, 'export: oggetti illeggibili esclusi dal file');
  yield 'END:VCALENDAR\r\n';
}

/** Nome del file: lo slug del calendario (solo a-z, 0-9 e `-`). */
function exportFilename(cal: SidecarRow): string {
  const base = cal.slug.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 100);
  return `${base || 'calendario'}.ics`;
}

/** `GET /calendars/:id/export.ics`: nome del file e corpo in streaming. */
export async function openCalendarExportV2(calendarId: string): Promise<{ filename: string; body: ReadableStream<Uint8Array> }> {
  await assertV2ObjectsAvailable();
  const cal = await requireImportTarget(calendarId);
  const rows = await sql<Array<{ href: string }>>`SELECT href FROM cal_objects WHERE calendar_id = ${cal.id}::uuid ORDER BY href`;
  const iterator = exportChunks(cal, rows.map((r) => r.href));
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  return { filename: exportFilename(cal), body };
}
