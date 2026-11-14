/**
 * Azioni sulla collezione in hold dell'API admin v2 (F6 tranche C, passo C3;
 * contratto docs/calendar-radicale/contracts/f6-modules.md §9.1.1, §9.1.5).
 *
 * L'interruttore anti-cancellazione di massa sospende le cancellazioni
 * osservate (`cal_collection_state.pending_deletions`): le occorrenze
 * continuano a bloccare finché l'admin sceglie. Due azioni, entrambe in due
 * tempi (`dry_run` che restituisce il piano con `plan_hash`, poi `commit` con
 * `confirm` digitato, `plan_hash` e `Idempotency-Key`):
 *
 *  - Applica cancellazioni (`calendar_hold_apply`): `applyHeldDeletions`
 *    riverifica ogni href su Radicale (un oggetto ricomparso torna
 *    nell'indice, un file ancora su disco va in quarantena) e toglie dall'indice
 *    le cancellazioni confermate; l'hold cade se non ne restano.
 *  - Ricostruisci dall'indice (`calendar_hold_rebuild`, design §16.3 scenario
 *    A): per ogni href sospeso con un'ultima versione valida non scaduta
 *    riscrive il testo di quella versione con PUT `If-None-Match: *` (al più
 *    20 al secondo, dalla pipeline lossless dello store: gate cal-write, nessun
 *    ritocco del testo); una risorsa già presente si salta, senza versione
 *    valida si salta. Poi sync completa della collezione: le sospese ricostruite
 *    escono da `pending_deletions` e l'hold cade da sé se non ne restano.
 *
 * Il job ricalcola ogni voce prima di scriverla (una voce cambiata nel
 * frattempo va in `failed`, mai sovrascritta), conserva il punto raggiunto in
 * `cal_jobs.result` (riprende dopo un'attesa o un riavvio) e aggiorna
 * `progress` al più ogni 2 s sotto lease. Nessun testo di evento nei log né
 * nell'audit: solo collezione, href, conteggi e id di job.
 */

import { createHash } from 'node:crypto';
import { type CalendarObject, parseCalendarObject } from '@calicchia/calendar-core';
import {
  CAL_V2_HOLD_CONFIRMATIONS,
  type CalV2CollectionHealth,
  type CalV2HoldActionRequest,
  type CalV2HoldActionResult,
  type CalV2HoldPlan,
  type CalV2HoldPlanItem,
  type CalV2JobAccepted,
} from '@calicchia/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import { calSql, sql } from '../../../db';
import { logger as rootLogger } from '../../logger';
import { CalendarConflictError, EventValidationError, isCalendarUnavailable } from '../errors';
import { INDEX_LIMITS, INDEX_TIMING } from '../index-model';
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
import { isRadicaleError } from '../radicale/errors';
import { collectionHealthView } from '../radicale/health';
import type { Db } from '../radicale/policy';
import { applyHeldDeletions, radicaleRuntime, syncCollection } from '../radicale/sync';
import { audit, auditCalendarV2, collectionNameOf, sidecarById, type SidecarRow, writeObject } from '../radicale/store';
import { getObjectVersion, lastValidVersions } from '../radicale/versions';
import { withCalendarWriteGate } from '../radicale/write-gate';
import { assertV2ObjectsAvailable } from './capabilities';
import {
  CalendarV2Error,
  confirmationRequired,
  idempotencyConflict,
  idempotencyKeyRequired,
  invalidValue,
  notInHold,
  planChanged,
  validationFailed,
} from './errors';
import { requireIdempotencyKey } from './import-export';
import { type AdminActor, ACTOR, MAX_ATTEMPTS, notFound, UUID_RE, zodIssues } from './objects';

const log: Logger = rootLogger.child({ scope: 'calendar-admin-v2-hold' });

// ═══════════════════════════════════════════════════════════════════
// Costanti
// ═══════════════════════════════════════════════════════════════════

export type HoldAction = keyof typeof CAL_V2_HOLD_CONFIRMATIONS;

/** Scritture al secondo della ricostruzione (contratto §9.1.5). */
export const HOLD_REBUILD_WRITES_PER_SECOND = 20;
/** Intervallo minimo fra due salvataggi dell'avanzamento (contratto §9.1.1). */
export const HOLD_PROGRESS_INTERVAL_MS = 2_000;
export const HOLD_JOB_MAX_ATTEMPTS = 3;
const HOLD_JOB_LEASE_MS = 300_000;
/** Voci `failed` conservate nel risultato (il conteggio resta esatto). */
const MAX_FAILED_ENTRIES = 1000;
/** Titolo dell'evento nel piano: solo per aiutare la scelta dell'admin, mai nei log. */
const SUMMARY_MAX = 200;
const MAX_HREFS = 50_000;
const HEX64_RE = /^[0-9a-f]{64}$/;

const JOB_KIND: Record<HoldAction, string> = {
  apply_deletions: CAL_JOB_KINDS.calendarHoldApply,
  rebuild_from_index: CAL_JOB_KINDS.calendarHoldRebuild,
};

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const actorLabel = (userId: string | null | undefined): string => (userId ? `admin:${userId}` : 'admin');

// ═══════════════════════════════════════════════════════════════════
// Richiesta
// ═══════════════════════════════════════════════════════════════════

const holdSchema = z
  .object({
    mode: z.enum(['dry_run', 'commit']),
    confirm: z.string().max(200).optional(),
    plan_hash: z.string().regex(HEX64_RE, 'plan_hash non valido').optional(),
    hrefs: z.array(z.string().min(1).max(512)).max(MAX_HREFS).optional(),
  })
  .strict();

/** Corpo di un'azione di hold validato (la chiave d'idempotenza sta nell'header, mai nel corpo). */
export function parseHoldActionRequest(raw: unknown): CalV2HoldActionRequest {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).some((k) => /^idempotency[-_ ]?key$/i.test(k))) {
    throw idempotencyKeyRequired('La chiave d\'idempotenza va nell\'header Idempotency-Key, non nel corpo');
  }
  const parsed = holdSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed('Richiesta non valida', zodIssues(parsed.error));
  return parsed.data;
}

// ═══════════════════════════════════════════════════════════════════
// Stato di hold e piano
// ═══════════════════════════════════════════════════════════════════

interface HoldState {
  reason: CalV2HoldPlan['hold_reason'];
  /** Ordinate. */
  pending: string[];
}

/** Stato di hold della collezione, o null se non è in hold. */
async function readHold(calendarId: string, db: Db = sql as unknown as Db): Promise<HoldState | null> {
  const [row] = await db<Array<{ health: string; hold_reason: string | null; pending_deletions: string[] }>>`
    SELECT health, hold_reason, pending_deletions FROM cal_collection_state WHERE calendar_id = ${calendarId}::uuid
  `;
  if (!row || row.health !== 'hold') return null;
  return { reason: row.hold_reason as HoldState['reason'], pending: [...row.pending_deletions].sort() };
}

/** Calendario con collezione in Radicale (non iscrizione, attivo); altrimenti 404. */
async function requireCollection(id: string): Promise<SidecarRow> {
  const cal = UUID_RE.test(id) ? await sidecarById(id, { activeOnly: true }) : null;
  if (!cal || cal.role === 'subscription' || !cal.collection_name) throw notFound('Calendario non trovato');
  return cal;
}

interface HoldObjectRow {
  id: string;
  href: string;
  uid: string | null;
  summary: string | null;
}

async function objectsByHref(calendarId: string, hrefs: readonly string[]): Promise<Map<string, HoldObjectRow>> {
  if (hrefs.length === 0) return new Map();
  const rows = await sql<HoldObjectRow[]>`
    SELECT o.id, o.href, o.uid, left(cc.summary, ${SUMMARY_MAX}) AS summary
    FROM cal_objects o
    LEFT JOIN cal_components cc ON cc.object_id = o.id AND cc.recurrence_key = ''
    WHERE o.calendar_id = ${calendarId}::uuid AND o.href = ANY(${[...hrefs]}::text[])
  `;
  return new Map(rows.map((r) => [r.href, r]));
}

/**
 * Href già presenti su Radicale (una risorsa tornata da sola dopo la sospensione).
 * Best effort: se Radicale non risponde l'elenco è vuoto e il job controlla
 * comunque ogni voce prima di scriverla.
 */
async function presentInRadicale(cal: SidecarRow, hrefs: readonly string[]): Promise<Set<string>> {
  const present = new Set<string>();
  const rt = radicaleRuntime();
  if (!rt.client || hrefs.length === 0) return present;
  const collection = collectionNameOf(cal);
  const path = collectionPath(rt.principal, collection);
  try {
    for (let i = 0; i < hrefs.length; i += INDEX_LIMITS.multigetBatch) {
      const chunk = hrefs.slice(i, i + INDEX_LIMITS.multigetBatch);
      const res = await rt.client.calendarMultiget(path, chunk.map((h) => objectPath(rt.principal, collection, h)));
      for (const obj of res.objects) {
        const name = decodeURIComponent(obj.href.replace(/\/+$/, '').split('/').pop() ?? '');
        if (name) present.add(name);
      }
    }
  } catch (err) {
    // Collezione sparita: nessuna risorsa presente. Altri errori: si decide nel job.
    if (!isRadicaleError(err, 'not_found')) {
      log.warn({ calendarId: cal.id, err: isRadicaleError(err) ? err.toLog() : (err as Error)?.name }, 'controllo delle risorse presenti non riuscito: il piano non le esclude');
      present.clear();
    }
  }
  return present;
}

interface InternalPlan {
  plan: CalV2HoldPlan;
  /** Per il job: la versione scelta per ogni voce `put_to_radicale`. */
  versions: Map<string, string>;
}

function planHashOf(plan: Omit<CalV2HoldPlan, 'plan_hash'>): string {
  return sha256(JSON.stringify([plan.calendar_id, plan.action, plan.hold_reason, plan.items.map((i) => [i.href, i.object_id, i.version_id, i.action, i.reason])]));
}

async function computePlan(action: HoldAction, cal: SidecarRow, hold: HoldState, requested: readonly string[] | undefined): Promise<InternalPlan> {
  const pending = new Set(hold.pending);
  // Un href non sospeso non è una cancellazione da decidere: si ignora.
  const target = requested ? [...new Set(requested)].filter((h) => pending.has(h)).sort() : hold.pending;
  const objects = await objectsByHref(cal.id, target);
  const items: CalV2HoldPlanItem[] = [];
  const versions = new Map<string, string>();

  if (action === 'apply_deletions') {
    for (const href of target) {
      const o = objects.get(href);
      items.push({ href, object_id: o?.id ?? null, uid: o?.uid ?? null, summary: o?.summary ?? null, version_id: null, action: 'remove_from_index', reason: null });
    }
  } else {
    const ids = [...objects.values()].map((o) => o.id);
    const [latest, present] = await Promise.all([lastValidVersions(sql as unknown as Db, ids), presentInRadicale(cal, target)]);
    const cutoff = Date.now() - INDEX_TIMING.versionsRetentionMs;
    for (const href of target) {
      const o = objects.get(href);
      const base = { href, object_id: o?.id ?? null, uid: o?.uid ?? null, summary: o?.summary ?? null };
      const version = o ? latest.get(o.id) : undefined;
      if (present.has(href)) items.push({ ...base, version_id: null, action: 'skip', reason: 'present_in_radicale' });
      else if (!version) items.push({ ...base, version_id: null, action: 'skip', reason: 'no_valid_version' });
      else if (version.created_at.getTime() < cutoff) items.push({ ...base, version_id: version.id, action: 'skip', reason: 'expired' });
      else {
        versions.set(href, version.id);
        items.push({ ...base, version_id: version.id, action: 'put_to_radicale', reason: null });
      }
    }
  }
  const body = { calendar_id: cal.id, action, hold_reason: hold.reason, total: items.length, items };
  return { plan: { ...body, plan_hash: planHashOf(body) }, versions };
}

// ═══════════════════════════════════════════════════════════════════
// Route
// ═══════════════════════════════════════════════════════════════════

interface HoldJobItem {
  href: string;
  object_id: string | null;
  version_id: string | null;
  action: CalV2HoldPlanItem['action'];
  reason: string | null;
}

interface HoldJobPayload extends Record<string, unknown> {
  calendar_id: string;
  action: HoldAction;
  plan_hash: string;
  request_hash: string;
  user_id: string | null;
  items: HoldJobItem[];
}

interface JobRef {
  id: string;
  request_hash: string | null;
}

/** Il job più recente di questo tipo con questa chiave, qualunque sia il suo stato. */
async function findJobByKey(kind: string, key: string, db: Db = sql as unknown as Db): Promise<JobRef | null> {
  const [row] = await db<Array<{ id: string; request_hash: string | null }>>`
    SELECT id::text AS id, payload->>'request_hash' AS request_hash
    FROM cal_jobs WHERE kind = ${kind} AND key = ${key}
    ORDER BY id DESC LIMIT 1
  `;
  return row ?? null;
}

/** Stessa chiave: lo stesso job se la richiesta è identica, altrimenti 409 IDEMPOTENCY_CONFLICT. */
function sameRequest(known: JobRef, requestHash: string): CalV2JobAccepted {
  if (known.request_hash !== requestHash) throw idempotencyConflict();
  return { job_id: known.id, created: false };
}

/**
 * `POST /collections/:id/apply-deletions` e `/rebuild-from-index`:
 * `dry_run` → 200 `CalV2HoldPlan`; `commit` → 202 `CalV2JobAccepted`.
 * Collezione non in hold → 409 NOT_IN_HOLD; conferma errata → 400
 * CONFIRMATION_REQUIRED; piano cambiato dopo l'anteprima → 409 PLAN_CHANGED.
 */
export async function holdActionV2(
  action: HoldAction,
  calendarId: string,
  req: CalV2HoldActionRequest,
  idempotencyKey: string | null | undefined,
  actor: AdminActor,
): Promise<{ status: 200; body: CalV2HoldPlan } | { status: 202; body: CalV2JobAccepted }> {
  await assertV2ObjectsAvailable();
  const cal = await requireCollection(calendarId);

  if (req.mode === 'dry_run') {
    const hold = await readHold(cal.id);
    if (!hold) throw notInHold();
    return { status: 200, body: (await computePlan(action, cal, hold, req.hrefs)).plan };
  }

  const expected = CAL_V2_HOLD_CONFIRMATIONS[action];
  if (req.confirm !== expected) throw confirmationRequired(expected);
  const key = requireIdempotencyKey(idempotencyKey);
  if (!req.plan_hash) throw invalidValue('Per confermare serve il plan_hash dell\'anteprima', 'plan_hash');

  const kind = JOB_KIND[action];
  const jobKey = `${cal.id}:${key}`;
  const hrefs = req.hrefs ? [...new Set(req.hrefs)].sort() : null;
  const requestHash = sha256(JSON.stringify([cal.id, action, req.plan_hash, hrefs]));

  // Stessa chiave: nessun ricalcolo (a lavoro fatto la collezione non è più in hold) ma lo stesso job.
  const known = await findJobByKey(kind, jobKey);
  if (known) return { status: 202, body: sameRequest(known, requestHash) };

  const hold = await readHold(cal.id);
  if (!hold) throw notInHold();
  const { plan } = await computePlan(action, cal, hold, req.hrefs);
  if (plan.plan_hash !== req.plan_hash) throw planChanged(plan);
  if (plan.total === 0) throw invalidValue('Nessuna cancellazione sospesa tra quelle indicate', 'hrefs');

  const payload: HoldJobPayload = {
    calendar_id: cal.id,
    action,
    plan_hash: plan.plan_hash,
    request_hash: requestHash,
    user_id: actor.userId,
    items: plan.items.map((i) => ({ href: i.href, object_id: i.object_id, version_id: i.version_id, action: i.action, reason: i.reason })),
  };

  // La ricerca e l'inserimento stanno sotto lo stesso lock: due richieste uguali e contemporanee ottengono lo stesso job.
  const accepted = await sql.begin(async (tx) => {
    const db = tx as unknown as Db;
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`${kind}:${jobKey}`}, 0))`;
    const again = await findJobByKey(kind, jobKey, db);
    if (again) return sameRequest(again, requestHash);
    const job = await enqueueCalendarJob(kind, jobKey, payload, { db, priority: CAL_JOB_PRIORITY.normal, maxAttempts: HOLD_JOB_MAX_ATTEMPTS });
    return { job_id: job.id, created: true } satisfies CalV2JobAccepted;
  });
  return { status: 202, body: accepted };
}

// ═══════════════════════════════════════════════════════════════════
// Stato del job
// ═══════════════════════════════════════════════════════════════════

type FailedEntry = CalV2HoldActionResult['failed'][number];

interface HoldRunState {
  applied: number;
  skipped: number;
  failed: FailedEntry[];
  failedCount: number;
  /** Prossima voce da elaborare. */
  cursor: number;
  health: CalV2CollectionHealth;
}

function readState(result: unknown): HoldRunState {
  const r = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const progress = r.progress && typeof r.progress === 'object' ? (r.progress as Record<string, unknown>) : {};
  const failed = Array.isArray(r.failed) ? (r.failed as FailedEntry[]) : [];
  const health = r.collection_health;
  return {
    applied: num(r.applied),
    skipped: num(r.skipped),
    failed,
    failedCount: Math.max(num(progress.failed), failed.length),
    cursor: num(r.cursor),
    health: health === 'healthy' || health === 'stale' || health === 'unsyncable' || health === 'hold' ? health : 'hold',
  };
}

function stateResult(state: HoldRunState, total: number): Record<string, unknown> {
  return {
    applied: state.applied,
    skipped: state.skipped,
    failed: state.failed,
    collection_health: state.health,
    progress: { total, done: state.cursor, failed: state.failedCount },
    cursor: state.cursor,
  };
}

function parsePayload(payload: Record<string, unknown>, action: HoldAction): HoldJobPayload {
  const ok =
    typeof payload.calendar_id === 'string' &&
    payload.action === action &&
    Array.isArray(payload.items) &&
    payload.items.every((i) => i && typeof i === 'object' && typeof (i as { href?: unknown }).href === 'string');
  if (!ok) throw new CalendarJobPermanentError('Payload del job di hold non valido');
  return payload as HoldJobPayload;
}

async function saveState(job: CalendarJob, state: HoldRunState, total: number): Promise<void> {
  await calSql`
    UPDATE cal_jobs SET result = ${calSql.json(stateResult(state, total) as Parameters<typeof calSql.json>[0])}
    WHERE id = ${job.id} AND status = 'running' AND lease_token = ${job.leaseToken}::uuid
  `;
}

/** Salute della collezione a fine lavoro (derivata, come la mostra la pagina Salute). */
async function healthOf(calendarId: string): Promise<CalV2CollectionHealth> {
  try {
    return (await collectionHealthView(sql as unknown as Db, calendarId))?.health ?? 'healthy';
  } catch {
    return 'stale';
  }
}

// ═══════════════════════════════════════════════════════════════════
// Job calendar_hold_apply
// ═══════════════════════════════════════════════════════════════════

/** Applica le cancellazioni sospese indicate dal piano confermato. */
export async function runHoldApplyJob(job: CalendarJob, ctx: CalendarJobContext): Promise<CalendarJobOutcome> {
  const jobLog = ctx.log ?? log;
  const payload = parsePayload(job.payload, 'apply_deletions');
  const cal = await sidecarById(payload.calendar_id, { activeOnly: true });
  if (!cal) throw new CalendarJobPermanentError('Il calendario non esiste più');
  const hrefs = payload.items.filter((i) => i.action === 'remove_from_index').map((i) => i.href);
  const total = hrefs.length;
  const state = readState((await calSql<Array<{ result: unknown }>>`SELECT result FROM cal_jobs WHERE id = ${job.id}`)[0]?.result);
  await saveState(job, state, total).catch(() => undefined);

  const before = await objectsByHref(cal.id, hrefs);
  // Dentro il gate cal-write come import e rebuild: con write_freeze o in rollback il job attende (§9.1.1).
  const res = await withCalendarWriteGate(() => applyHeldDeletions(cal.id, { actor: actorLabel(payload.user_id), hrefs }), { expect: 'radicale' });
  const after = await objectsByHref(cal.id, hrefs);

  // Tolte dall'indice: quelle che prima c'erano e ora no. Il resto è rientrato (o è in quarantena) e resta fuori dal conteggio.
  const removed = hrefs.filter((h) => before.has(h) && !after.has(h));
  state.applied = Math.max(removed.length, res.deleted);
  state.skipped = Math.max(0, total - state.applied);
  state.cursor = total;
  state.health = await healthOf(cal.id);

  for (const href of removed) {
    await audit({
      action: 'DELETE',
      recordId: before.get(href)?.id ?? null,
      operation: 'v2.hold.apply',
      calendar: cal,
      href,
      etagBefore: null,
      etagAfter: null,
      changed: ['hold_apply'],
      actor: ACTOR,
      extra: { job_id: job.id, ...(payload.user_id ? { user_id: payload.user_id } : {}) },
    });
  }
  await auditCalendarV2({
    action: 'UPDATE',
    recordId: cal.id,
    operation: 'v2.hold.apply',
    changed: ['hold'],
    actor: ACTOR,
    extra: { job_id: job.id, applied: state.applied, skipped: state.skipped, total, collection_health: state.health, ...(payload.user_id ? { user_id: payload.user_id } : {}) },
  });
  jobLog.info({ calendarId: cal.id, applied: state.applied, skipped: state.skipped, total, health: state.health }, 'cancellazioni sospese applicate');
  const { cursor: _cursor, ...result } = stateResult(state, total);
  return { result };
}

// ═══════════════════════════════════════════════════════════════════
// Job calendar_hold_rebuild
// ═══════════════════════════════════════════════════════════════════

/** La voce non si può più ricostruire come da piano: `failed`, mai una sovrascrittura. */
class ItemChanged extends Error {
  constructor(readonly code: 'changed' | 'version_expired' | 'uid_exists') {
    super(code);
    this.name = 'ItemChanged';
  }
}

const ITEM_MESSAGES: Record<string, string> = {
  changed: 'La versione da ripristinare è cambiata dopo l\'anteprima: la voce non è stata riscritta',
  version_expired: 'La versione da ripristinare è scaduta',
  uid_exists: 'Nel calendario esiste già un evento con lo stesso UID',
  write_failed: 'Scrittura non riuscita',
  VALIDATION_FAILED: 'La versione non è valida per il calendario',
};

/** Voce fallita → codice e messaggio senza testo dell'evento. */
function failureOf(err: unknown): { code: string; message: string } {
  if (err instanceof ItemChanged) return { code: err.code, message: ITEM_MESSAGES[err.code] };
  if (err instanceof EventValidationError) {
    if (/UID già presente/.test(err.message)) return { code: 'uid_exists', message: ITEM_MESSAGES.uid_exists };
    return { code: 'VALIDATION_FAILED', message: ITEM_MESSAGES.VALIDATION_FAILED };
  }
  if (err instanceof CalendarConflictError) return { code: 'changed', message: ITEM_MESSAGES.changed };
  if (err instanceof CalendarV2Error) return { code: err.code, message: err.message.slice(0, 200) };
  return { code: 'write_failed', message: ITEM_MESSAGES.write_failed };
}

interface Rewritten {
  etagAfter: string | null;
  objectId: string | null;
}

/**
 * Riscrive il testo della versione scelta con PUT `If-None-Match: *`.
 * Restituisce null se la risorsa è già su Radicale (tornata nel frattempo):
 * non si tocca. Il testo è quello della versione, senza ritocchi (solo fine riga CRLF).
 */
async function rewriteItem(cal: SidecarRow, item: HoldJobItem): Promise<Rewritten | null> {
  if (!item.version_id || !item.object_id) throw new ItemChanged('changed');
  const [latest] = [...(await lastValidVersions(sql as unknown as Db, [item.object_id])).values()];
  if (!latest || latest.id !== item.version_id) throw new ItemChanged('changed');
  const version = await getObjectVersion(sql as unknown as Db, item.version_id);
  if (!version || !version.valid || !version.raw_ics || version.object_id !== item.object_id) throw new ItemChanged('changed');
  if (version.created_at.getTime() < Date.now() - INDEX_TIMING.versionsRetentionMs) throw new ItemChanged('version_expired');
  const parsed = parseCalendarObject(version.raw_ics);
  if (!parsed.ok) throw new ItemChanged('changed');
  const object: CalendarObject = parsed.value;
  const text = version.raw_ics.replace(/\r?\n/g, '\r\n');

  const outcome = await writeObject({
    calendar: cal,
    href: item.href,
    what: 'l\'evento',
    maxAttempts: MAX_ATTEMPTS,
    plan: async (current) => {
      // Esiste già (tornata da sola, o ricreata da un device): non si sovrascrive.
      if (current) return { action: 'none' };
      // Riletto dentro il gate, subito prima della PUT: se nel frattempo l'admin ha applicato le cancellazioni
      // (o la collezione è uscita dall'hold) la voce non va fatta risorgere (§9.1.1).
      const hold = await readHold(cal.id);
      if (!hold || !hold.pending.includes(item.href)) throw new ItemChanged('changed');
      const [still] = await sql<Array<{ one: number }>>`
        SELECT 1 AS one FROM cal_objects WHERE id = ${item.object_id}::uuid AND calendar_id = ${cal.id}::uuid AND href = ${item.href}
      `;
      if (!still) throw new ItemChanged('changed');
      return { action: 'put', object, previous: null, text, changed: ['hold_rebuild'] };
    },
  });
  if (outcome.action !== 'put') return null;
  return { etagAfter: outcome.etagAfter, objectId: item.object_id };
}

/** Ricostruisce da indice le risorse sospese: una scrittura alla volta, con ripresa dal punto raggiunto. */
export async function runHoldRebuildJob(job: CalendarJob, ctx: CalendarJobContext): Promise<CalendarJobOutcome> {
  const jobLog = ctx.log ?? log;
  const payload = parsePayload(job.payload, 'rebuild_from_index');
  const cal = await sidecarById(payload.calendar_id, { activeOnly: true });
  if (!cal) throw new CalendarJobPermanentError('Il calendario non esiste più');
  const items = payload.items as HoldJobItem[];
  const total = items.length;
  const state = readState((await calSql<Array<{ result: unknown }>>`SELECT result FROM cal_jobs WHERE id = ${job.id}`)[0]?.result);

  let lastSave = Date.now();
  let lastWrite = 0;
  const save = async (): Promise<void> => {
    await saveState(job, state, total);
    lastSave = Date.now();
  };
  const fail = (item: HoldJobItem, code: string, message: string): void => {
    state.failedCount++;
    if (state.failed.length < MAX_FAILED_ENTRIES) state.failed.push({ href: item.href, code, message });
  };

  try {
    for (let i = state.cursor; i < total; i++) {
      if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('job interrotto');
      const item = items[i];
      if (item.action !== 'put_to_radicale') {
        state.skipped++;
      } else {
        // Al più 20 scritture al secondo.
        const gap = 1000 / HOLD_REBUILD_WRITES_PER_SECOND - (Date.now() - lastWrite);
        if (gap > 0) await sleep(gap);
        lastWrite = Date.now();
        try {
          const written = await rewriteItem(cal, item);
          if (written) {
            state.applied++;
            await audit({
              action: 'INSERT',
              recordId: written.objectId,
              operation: 'v2.hold.rebuild',
              calendar: cal,
              href: item.href,
              etagBefore: null,
              etagAfter: written.etagAfter,
              changed: ['hold_rebuild'],
              actor: ACTOR,
              extra: { job_id: job.id, version_id: item.version_id, ...(payload.user_id ? { user_id: payload.user_id } : {}) },
            });
          } else {
            state.skipped++;
          }
        } catch (err) {
          // Radicale o il gate non disponibili: il job attende e riprende da qui, non è un errore della voce.
          if (isCalendarUnavailable(err) || isCalendarJobWaitError(err)) throw err;
          const f = failureOf(err);
          if (f.code === 'write_failed') jobLog.warn({ err: (err as Error)?.name }, 'voce di ricostruzione non scritta');
          fail(item, f.code, f.message);
        }
      }
      state.cursor = i + 1;
      if (Date.now() - lastSave >= HOLD_PROGRESS_INTERVAL_MS) {
        await save();
        await ctx.extendLease();
      }
    }
  } catch (err) {
    // Attesa o interruzione: si registra il punto raggiunto, così la ripresa non rifà il lavoro.
    await save().catch(() => undefined);
    throw err;
  }
  await save().catch(() => undefined);

  // Sync completa: le sospese ricostruite escono da pending_deletions e l'hold cade se non ne restano.
  if (items.some((i) => i.action === 'put_to_radicale')) {
    await syncCollection(cal.id, { reason: 'manual', full: true, actor: actorLabel(payload.user_id) });
  }
  state.health = await healthOf(cal.id);
  await save().catch(() => undefined);

  await auditCalendarV2({
    action: 'UPDATE',
    recordId: cal.id,
    operation: 'v2.hold.rebuild',
    changed: ['hold'],
    actor: ACTOR,
    extra: { job_id: job.id, applied: state.applied, skipped: state.skipped, failed: state.failedCount, total, collection_health: state.health, ...(payload.user_id ? { user_id: payload.user_id } : {}) },
  });
  jobLog.info({ calendarId: cal.id, applied: state.applied, skipped: state.skipped, failed: state.failedCount, total, health: state.health }, 'ricostruzione dall\'indice completata');
  const { cursor: _cursor, ...result } = stateResult(state, total);
  return { result };
}

/** Registra gli handler dei job `calendar_hold_apply` e `calendar_hold_rebuild` (idempotente; li chiama il cron del calendario). */
export function registerCalendarHoldJobs(): void {
  registerCalendarJobHandler(CAL_JOB_KINDS.calendarHoldApply, runHoldApplyJob, { leaseMs: HOLD_JOB_LEASE_MS });
  registerCalendarJobHandler(CAL_JOB_KINDS.calendarHoldRebuild, runHoldRebuildJob, { leaseMs: HOLD_JOB_LEASE_MS });
}
