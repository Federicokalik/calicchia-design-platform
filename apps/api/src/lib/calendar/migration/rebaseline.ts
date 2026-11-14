/**
 * Ri-baseline del ledger della migrazione (fase F4; design §13.12 passo 4;
 * contratto docs/calendar-radicale/contracts/f4-modules.md §5.3).
 *
 * Dopo la passata finale della proiezione inversa del rollback, Postgres
 * contiene le righe proiettate da Radicale e il volume resta intatto come
 * archivio. Il ledger (cal_migration_ledger) descrive però lo stato della
 * PRIMA migrazione: href scelti dal serializer, snapshot delle righe di
 * allora, etag delle scritture dello strumento. Senza riallineamento un nuovo
 * cutover riscriverebbe (o metterebbe in conflitto) anche gli oggetti che
 * nessuno ha toccato. La ri-baseline porta il ledger a:
 *
 *   A. risorsa rappresentata 1:1      riga `event:<master>` all'href reale,
 *                                     snapshot e hash del serializer sulle
 *                                     righe correnti, etag e fingerprint
 *                                     correnti della risorsa, adopted;
 *   B. risorsa espansa (derivate)     riga `event:<object_id>` con derived,
 *                                     snapshot LegacyDerivedSnapshot;
 *   C. proiezione booking-<uid>       riga `booking:<uid>` all'href reale;
 *   D. risorsa senza righe legacy     riga tolta dal ledger (REVERSE_FAILED,
 *                                     oggetti che il serializer salta): il
 *                                     piano non la cancella mai;
 *   E. oggetto creato nella finestra  riga nuova come A o B, con
 *                                     cal_object_ids.legacy_event_id e
 *                                     legacy_uid valorizzati dalle righe
 *                                     proiettate (riuso di id e UID);
 *   F. risorsa sparita                riga ritirata (deleted_at);
 *   G. iscrizioni e archivio          invariate (collezioni fuori dal piano).
 *
 * Lo snapshot e l'hash si calcolano SEMPRE con il serializer della F3
 * (loadLegacySource + serializeLegacy, con le opzioni dell'ultima anteprima),
 * mai a mano: il cutover successivo li ricalcola identici e trova `noop`
 * (etag uguale, hash uguale) per tutto ciò che nessuno tocca, compresi gli
 * oggetti creati da un iPhone con un href proprio e quelli toccati da admin o
 * MCP nella finestra. La destinazione si legge da Radicale con la stessa
 * funzione del piano (readTargetSnapshot), così etag e fingerprint sono
 * esattamente quelli che il piano vedrà.
 *
 * Idempotente: rieseguita (ripresa del passo `rebaseline` del rollback o run
 * di riparazione dal wizard) produce lo stesso ledger. Le scritture sul
 * ledger avvengono in una sola transazione (le righe vive delle collezioni
 * del piano si ritirano e si riscrivono: nessun vincolo unico violato a metà).
 * Nessun dato personale nei log e nel riassunto.
 */

import { parseCalendarObject, semanticFingerprint } from '@calicchia/calendar-core';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../../logger';
import type { RadicaleClient } from '../radicale/client';
import type { Db } from '../radicale/policy';
import { readTargetSnapshot, type TargetSnapshot } from './plan';
import { assertMigrationWritable, preconditionError, requireRadicale } from './preflight';
import { LEDGER_SELECT, ledgerRowFromDb, loadLegacySource, serializeLegacy } from './serialize';
import { referencePlan } from './shadow';
import {
  type LedgerRow,
  legacyKey,
  type MigrationOptions,
  type MigrationRunContext,
  type RebaselineParams,
  type RebaselineSummary,
  type ReverseRowRef,
  type SerializedObject,
  type TargetObject,
} from './types';

const log: Logger = rootLogger.child({ scope: 'calendar-rebaseline' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Righe per statement nelle scritture del ledger. */
const WRITE_CHUNK = 200;

// ─── Dipendenze ───────────────────────────────

/** Ingressi esterni (sostituibili nei test). */
export interface RebaselineDeps {
  /** Client caldes-svc e principal (lettura della destinazione). */
  radicale: () => { client: RadicaleClient; principal: string };
  now: () => Date;
}

export function defaultRebaselineDeps(): RebaselineDeps {
  return { radicale: requireRadicale, now: () => new Date() };
}

// ─── Utilità ───────────────────────────────

/** Transazione sul pool (o direttamente, se `db` è già una transazione). */
async function inTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const begin = (db as unknown as { begin?: unknown }).begin;
  if (typeof begin !== 'function') return fn(db);
  return (await db.begin(async (trx) => fn(trx as unknown as Db))) as T;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('ri-baseline interrotta');
    err.name = 'AbortError';
    throw err;
  }
}

/**
 * written_fingerprint di una destinazione: il fingerprint semantico letto (lo
 * stesso del piano), altrimenti quello calcolato dal testo; se il testo non si
 * legge, un valore che non coincide mai con un fingerprint semantico (il
 * vincolo del ledger richiede un valore con written_at).
 */
function targetFingerprint(t: TargetObject): string {
  if (t.fingerprint) return t.fingerprint;
  if (t.raw) {
    const parsed = parseCalendarObject(t.raw);
    if (parsed.ok) return semanticFingerprint(parsed.value);
    return `unparsed:${createHash('sha256').update(t.raw, 'utf8').digest('hex')}`;
  }
  return `unread:${createHash('sha256').update(`${t.calendar_id}|${t.href}|${t.etag ?? ''}`, 'utf8').digest('hex')}`;
}

function asRowRefs(v: unknown): ReverseRowRef[] {
  if (!Array.isArray(v)) return [];
  const out: ReverseRowRef[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || !UUID_RE.test(o.id) || typeof o.recurrence_key !== 'string') continue;
    const role = o.role;
    if (role !== 'master' && role !== 'override' && role !== 'derived' && role !== 'projection') continue;
    out.push({ id: o.id.toLowerCase(), recurrence_key: o.recurrence_key, role });
  }
  return out;
}

// ─── Fase 1: posizioni e id delle risorse proiettate (categorie A, C, E) ─────

interface ProjectedResource {
  object_id: string;
  calendar_id: string;
  href: string;
  rows: ReverseRowRef[];
}

/** Risorse proiettate (stato projected o degraded) delle collezioni del piano. */
async function loadProjectedResources(db: Db, calendarIds: readonly string[]): Promise<ProjectedResource[]> {
  if (calendarIds.length === 0) return [];
  const rows = await db<Array<{ object_id: string; calendar_id: string; href: string; rows: unknown }>>`
    SELECT object_id::text AS object_id, calendar_id::text AS calendar_id, href, rows
    FROM cal_migration_reverse_state
    WHERE status IN ('projected', 'degraded') AND calendar_id = ANY(${calendarIds as string[]}::uuid[])
    ORDER BY calendar_id, href, object_id
  `;
  return rows.map((r) => ({ object_id: r.object_id.toLowerCase(), calendar_id: r.calendar_id.toLowerCase(), href: r.href, rows: asRowRefs(r.rows) }));
}

/**
 * Categoria E (e riallineamento di A e C): `cal_object_ids.legacy_event_id`
 * di ogni componente proiettato (master, override, proiezione) = id della
 * riga legacy scritta dal proiettore, `legacy_uid` del master = UID della
 * riga master. Un id già tenuto da una posizione ritirata (risorsa spostata
 * con MOVE) le viene tolto; uno tenuto da una posizione viva diversa non si
 * tocca (log). Così il serializer, al cutover successivo, ritrova l'href
 * reale della risorsa e riusa id e UID.
 */
async function alignObjectIds(db: Db, resources: readonly ProjectedResource[]): Promise<{ aligned: number; conflicts: number }> {
  let aligned = 0;
  let conflicts = 0;
  const owned = resources.flatMap((r) => r.rows
    .filter((row) => row.role !== 'derived')
    .map((row) => ({ calendar_id: r.calendar_id, href: r.href, recurrence_key: row.recurrence_key, id: row.id, master: row.recurrence_key === '' })));
  if (owned.length === 0) return { aligned, conflicts };
  const uids = new Map<string, string>();
  for (let i = 0; i < owned.length; i += WRITE_CHUNK) {
    const part = owned.slice(i, i + WRITE_CHUNK).filter((o) => o.master).map((o) => o.id);
    if (!part.length) continue;
    const got = await db<Array<{ id: string; uid: string }>>`SELECT id::text AS id, uid FROM calendar_events WHERE id = ANY(${part}::uuid[])`;
    for (const g of got) uids.set(g.id.toLowerCase(), g.uid);
  }
  await inTx(db, async (tx) => {
    for (const o of owned) {
      const [pos] = await tx<Array<{ id: string; legacy_event_id: string | null; legacy_uid: string | null }>>`
        SELECT id::text AS id, legacy_event_id::text AS legacy_event_id, legacy_uid FROM cal_object_ids
        WHERE calendar_id = ${o.calendar_id}::uuid AND href = ${o.href} AND recurrence_key = ${o.recurrence_key} AND retired_at IS NULL
        FOR UPDATE
      `;
      if (!pos) continue;
      const uid = o.master ? uids.get(o.id) ?? null : null;
      const idOk = pos.legacy_event_id !== null && pos.legacy_event_id.toLowerCase() === o.id;
      const uidOk = !o.master || uid === null || pos.legacy_uid === uid;
      if (idOk && uidOk) continue;
      if (!idOk) {
        const holders = await tx<Array<{ id: string; retired: boolean }>>`
          SELECT id::text AS id, (retired_at IS NOT NULL) AS retired FROM cal_object_ids
          WHERE legacy_event_id = ${o.id}::uuid AND id <> ${pos.id}::uuid
          FOR UPDATE
        `;
        if (holders.some((h) => !h.retired)) {
          conflicts += 1;
          log.warn({ calendarId: o.calendar_id, recurrenceKey: o.recurrence_key }, 'ri-baseline: id legacy già tenuto da un\'altra posizione viva, non riassegnato');
          continue;
        }
        if (holders.length) {
          await tx`UPDATE cal_object_ids SET legacy_event_id = NULL, updated_at = now() WHERE id = ANY(${holders.map((h) => h.id)}::uuid[])`;
        }
      }
      const newUid = o.master && uid !== null ? uid : null;
      await tx`
        UPDATE cal_object_ids SET
          legacy_event_id = ${o.id}::uuid,
          legacy_uid = CASE WHEN ${newUid}::text IS NULL THEN legacy_uid ELSE ${newUid}::text END,
          updated_at = now()
        WHERE id = ${pos.id}::uuid
      `;
      aligned += 1;
    }
  });
  return { aligned, conflicts };
}

/**
 * Riga viva del ledger di una chiave proiettata a un href diverso da quello
 * reale della risorsa (spostata con MOVE nella finestra): si ritira prima di
 * serializzare, così il serializer non riusa l'href vecchio.
 */
async function retireStaleKeyPositions(db: Db, resources: readonly ProjectedResource[], runId: string | null): Promise<number> {
  let retired = 0;
  const wanted: Array<{ calendar_id: string; legacy_key: string; href: string }> = [];
  for (const r of resources) {
    const master = r.rows.find((row) => row.role === 'master' && row.recurrence_key === '');
    if (master) wanted.push({ calendar_id: r.calendar_id, legacy_key: legacyKey('event', master.id), href: r.href });
    const derived = r.rows.some((row) => row.role === 'derived');
    if (derived && !master) wanted.push({ calendar_id: r.calendar_id, legacy_key: legacyKey('event', r.object_id), href: r.href });
  }
  for (let i = 0; i < wanted.length; i += WRITE_CHUNK) {
    const part = wanted.slice(i, i + WRITE_CHUNK);
    const rows = await db<Array<{ id: string }>>`
      UPDATE cal_migration_ledger l SET
        deleted_at = COALESCE(l.deleted_at, now()),
        written_etag = NULL, written_fingerprint = NULL, written_at = NULL,
        legacy_hash = NULL, legacy_snapshot = NULL,
        intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL,
        intent_etag = NULL, intent_at = NULL, intent_run_id = NULL,
        revalidate_reason = NULL, revalidate_since = NULL,
        last_run_id = COALESCE(${runId}::uuid, l.last_run_id), updated_at = now()
      FROM (SELECT * FROM jsonb_to_recordset(${db.json(part as never)}) AS w(calendar_id uuid, legacy_key text, href text)) w
      WHERE l.calendar_id = w.calendar_id AND l.legacy_key = w.legacy_key AND l.href <> w.href AND l.deleted_at IS NULL
      RETURNING l.id::text AS id
    `;
    retired += rows.length;
  }
  return retired;
}

// ─── Fase 2: allineamento del ledger ───────────────────────────────

/** Riga voluta del ledger: oggetto serializzato con la sua destinazione reale. */
interface DesiredRow {
  s: SerializedObject;
  t: TargetObject;
}

/** Esito puro della riconciliazione fra serializer, destinazione e ledger (testabile senza database). */
export interface RebaselineDecision {
  desired: DesiredRow[];
  /** Righe vive senza oggetto voluto con la risorsa presente (categoria D): da togliere dal ledger. */
  untrack: LedgerRow[];
  /** Righe vive senza oggetto voluto con la risorsa assente (categoria F) o con un oggetto voluto senza risorsa: da ritirare. */
  retire: LedgerRow[];
  /** Oggetti voluti senza risorsa su Radicale (righe legacy mai migrate): il cutover successivo li crea. */
  missing: SerializedObject[];
}

/**
 * Riconciliazione pura (contratto §5.3): per ogni oggetto serializzato delle
 * collezioni del piano con la risorsa all'href voluto → riga voluta; righe
 * vive del ledger di quelle collezioni non coperte → D (risorsa presente) o
 * F (assente).
 */
export function decideRebaseline(input: {
  objects: readonly SerializedObject[];
  ledger: readonly LedgerRow[];
  target: TargetSnapshot;
  calendarIds: ReadonlySet<string>;
}): RebaselineDecision {
  const desired: DesiredRow[] = [];
  const missing: SerializedObject[] = [];
  const desiredHrefs = new Set<string>();
  for (const s of input.objects) {
    if (!input.calendarIds.has(s.calendar_id)) continue;
    const t = input.target.collections.get(s.calendar_id)?.objects.get(s.href) ?? null;
    if (!t) {
      missing.push(s);
      continue;
    }
    desired.push({ s, t });
    desiredHrefs.add(`${s.calendar_id}|${s.href}`);
  }
  const untrack: LedgerRow[] = [];
  const retire: LedgerRow[] = [];
  for (const l of input.ledger) {
    if (l.deleted_at !== null || l.kind === 'archive' || !input.calendarIds.has(l.calendar_id)) continue;
    if (desiredHrefs.has(`${l.calendar_id}|${l.href}`)) continue;
    const t = input.target.collections.get(l.calendar_id)?.objects.get(l.href) ?? null;
    if (t) untrack.push(l);
    else retire.push(l);
  }
  return { desired, untrack, retire, missing };
}

async function loadLiveLedger(db: Db, calendarIds: readonly string[]): Promise<LedgerRow[]> {
  if (calendarIds.length === 0) return [];
  const rows = await db<Array<Record<string, unknown>>>`
    SELECT ${db.unsafe(LEDGER_SELECT)} FROM cal_migration_ledger
    WHERE deleted_at IS NULL AND kind <> 'archive' AND calendar_id = ANY(${calendarIds as string[]}::uuid[])
    ORDER BY calendar_id, href, id
  `;
  return rows.map(ledgerRowFromDb);
}

/**
 * Scrive l'esito in una transazione: prima si ritirano tutte le righe vive
 * delle collezioni del piano che cambiano (così i vincoli unici per href,
 * chiave e UID non si violano a metà), poi si tolgono le righe D, infine si
 * scrivono le righe volute (UPDATE della riga allo stesso href, altrimenti
 * INSERT). Restituisce i conteggi.
 */
async function writeLedger(
  db: Db,
  decision: RebaselineDecision,
  ledger: readonly LedgerRow[],
  runId: string | null,
): Promise<{ rebaselined: number; created: number; retired: number; untracked: number; derived: number }> {
  const liveByCalKey = new Map<string, LedgerRow>();
  for (const l of ledger) if (l.deleted_at === null) liveByCalKey.set(`${l.calendar_id}|${l.legacy_key}`, l);
  let rebaselined = 0;
  let created = 0;
  let derived = 0;
  await inTx(db, async (tx) => {
    // 1. Ritiro di ogni riga viva toccata (voluta allo stesso href, F, D), in un colpo solo per collezione.
    const desiredAtHref = new Map(decision.desired.map((d) => [`${d.s.calendar_id}|${d.s.href}`, d]));
    const touched = ledger.filter((l) => l.deleted_at === null
      && (desiredAtHref.has(`${l.calendar_id}|${l.href}`) || decision.retire.includes(l) || decision.untrack.includes(l)));
    for (let i = 0; i < touched.length; i += WRITE_CHUNK) {
      const ids = touched.slice(i, i + WRITE_CHUNK).map((l) => l.id);
      await tx`
        UPDATE cal_migration_ledger SET
          deleted_at = now(),
          written_etag = NULL, written_fingerprint = NULL, written_at = NULL,
          legacy_hash = NULL, legacy_snapshot = NULL,
          intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL,
          intent_etag = NULL, intent_at = NULL, intent_run_id = NULL,
          revalidate_reason = NULL, revalidate_since = NULL,
          last_run_id = COALESCE(${runId}::uuid, last_run_id), updated_at = now()
        WHERE id = ANY(${ids}::bigint[])
      `;
    }
    // 2. Categoria D: l'oggetto resta nel volume, non più tracciato (il piano non lo cancella mai).
    const untrackIds = decision.untrack.map((l) => l.id);
    for (let i = 0; i < untrackIds.length; i += WRITE_CHUNK) {
      await tx`DELETE FROM cal_migration_ledger WHERE id = ANY(${untrackIds.slice(i, i + WRITE_CHUNK)}::bigint[])`;
    }
    // 3. Righe volute (A, B, C, E). Il ledger ammette un solo UID vivo per collezione: l'UID di una
    // risorsa espansa (derived, non serializzata dal legacy) che coincidesse con quello di un'altra riga
    // resta NULL invece di far fallire l'intera ri-baseline.
    const usedUids = new Set<string>();
    for (const { s } of decision.desired) if (s.legacy_snapshot.kind !== 'derived') usedUids.add(`${s.calendar_id.toLowerCase()}|${s.uid}`);
    for (const { s, t } of decision.desired) {
      const cal = s.calendar_id.toLowerCase();
      let uid: string | null = s.uid;
      if (s.legacy_snapshot.kind === 'derived') {
        const k = `${cal}|${s.uid}`;
        if (usedUids.has(k)) {
          uid = null;
          log.warn({ calendarId: cal }, 'ri-baseline: UID della risorsa espansa già usato da un\'altra riga del ledger, registrato senza UID');
        } else {
          usedUids.add(k);
        }
      }
      const previous = liveByCalKey.get(`${cal}|${s.legacy_key}`) ?? null;
      const isDerived = s.legacy_snapshot.kind === 'derived';
      const snapshot = tx.json(s.legacy_snapshot as never);
      const fingerprint = targetFingerprint(t);
      const [atHref] = await tx<Array<{ id: string }>>`
        SELECT id::text AS id FROM cal_migration_ledger WHERE calendar_id = ${cal}::uuid AND href = ${s.href} FOR UPDATE
      `;
      if (atHref) {
        await tx`
          UPDATE cal_migration_ledger SET
            collection_name = ${s.collection_name}, kind = ${s.kind}, legacy_key = ${s.legacy_key},
            legacy_event_id = ${s.legacy_event_id}::uuid, uid = ${uid},
            legacy_snapshot = ${snapshot}, legacy_hash = ${s.legacy_hash},
            written_etag = ${t.etag}, written_fingerprint = ${fingerprint}, written_at = now(),
            intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL,
            intent_etag = NULL, intent_at = NULL, intent_run_id = NULL,
            adopted = true, derived = ${isDerived},
            revalidate_reason = NULL, revalidate_since = NULL,
            deleted_at = NULL,
            last_run_id = COALESCE(${runId}::uuid, last_run_id), updated_at = now()
          WHERE id = ${atHref.id}::bigint
        `;
      } else {
        await tx`
          INSERT INTO cal_migration_ledger (
            calendar_id, collection_name, href, kind, legacy_key, legacy_event_id, uid,
            legacy_snapshot, legacy_hash, written_etag, written_fingerprint, written_at, adopted, derived, last_run_id
          ) VALUES (
            ${cal}::uuid, ${s.collection_name}, ${s.href}, ${s.kind}, ${s.legacy_key}, ${s.legacy_event_id}::uuid, ${uid},
            ${snapshot}, ${s.legacy_hash}, ${t.etag}, ${fingerprint}, now(), true, ${isDerived}, ${runId}::uuid
          )
        `;
      }
      if (previous && previous.href === s.href) rebaselined += 1;
      else created += 1;
      if (isDerived) derived += 1;
    }
  });
  return { rebaselined, created, retired: decision.retire.length, untracked: decision.untrack.length, derived };
}

// ─── Ri-baseline ───────────────────────────────

/**
 * Ri-baseline del ledger (contratto §5.3): passo `rebaseline` del rollback e
 * run di riparazione. Non controlla il mode né prende lock: lo fanno i
 * chiamanti (il run tiene `cal-migration`; nel rollback il volume è fermo).
 * `options`: opzioni dell'ultima anteprima riuscita (referencePlan).
 */
export async function runRebaseline(opts: {
  db: Db;
  actor: string;
  runId: string | null;
  options: MigrationOptions;
  signal?: AbortSignal;
  deps?: Partial<RebaselineDeps>;
}): Promise<RebaselineSummary> {
  const deps: RebaselineDeps = { ...defaultRebaselineDeps(), ...(opts.deps ?? {}) };
  const started = Date.now();
  const { db } = opts;
  const { client, principal } = deps.radicale();

  // Collezioni del piano (categoria G esclusa: iscrizioni, archivio, calendari esclusi).
  const calendars = await db<Array<{ id: string; collection_name: string }>>`
    SELECT id::text AS id, collection_name FROM calendars
    WHERE collection_name IS NOT NULL AND role <> 'subscription' AND origin <> 'migration' AND lifecycle = 'active'
    ORDER BY collection_name
  `;
  const calendarIds = calendars.map((c) => c.id.toLowerCase());

  // 1. Posizioni reali e id delle risorse proiettate (A, C, E), prima del serializer.
  const resources = await loadProjectedResources(db, calendarIds);
  const stale = await retireStaleKeyPositions(db, resources, opts.runId);
  const ids = await alignObjectIds(db, resources);
  throwIfAborted(opts.signal);

  // 2. Oggetti voluti dal serializer sulle righe correnti, con le opzioni dell'ultima anteprima.
  const now = deps.now();
  const source = await loadLegacySource(db, { scope: {}, now });
  const serialization = serializeLegacy(source, opts.options, { now });
  throwIfAborted(opts.signal);
  const included = new Set(source.calendars.filter((c) => c.included && c.collection_name).map((c) => c.id.toLowerCase()));
  const scope = new Set(calendarIds.filter((id) => included.has(id)));

  // 3. Destinazione come la vedrà il piano (PROPFIND e multiget di tutto: fingerprint di ogni risorsa).
  const collections = calendars.filter((c) => scope.has(c.id.toLowerCase())).map((c) => ({ calendar_id: c.id.toLowerCase(), collection_name: c.collection_name }));
  const target = await readTargetSnapshot(client, principal, collections, { needContent: () => true, signal: opts.signal });
  throwIfAborted(opts.signal);

  // 4. Riconciliazione e scrittura del ledger.
  const ledger = await loadLiveLedger(db, [...scope]);
  const decision = decideRebaseline({ objects: serialization.objects, ledger, target, calendarIds: scope });
  const written = await writeLedger(db, decision, ledger, opts.runId);
  const summary: RebaselineSummary = {
    rows: ledger.length,
    rebaselined: written.rebaselined,
    created: written.created,
    retired: written.retired + stale,
    untracked: written.untracked,
    derived: written.derived,
    adopted: decision.desired.length,
    skipped: decision.missing.length,
    duration_ms: Date.now() - started,
  };
  log.info({ ...summary, ids_aligned: ids.aligned, ids_conflicts: ids.conflicts, actor: opts.actor }, 'ri-baseline del ledger completata');
  return summary;
}

/** Parametri del run di riparazione normalizzati. */
function normalizeParams(params: Partial<RebaselineParams> | null | undefined): RebaselineParams {
  const p = params ?? {};
  const ids = Array.isArray(p.scope?.calendar_ids)
    ? [...new Set(p.scope.calendar_ids.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)).map((id) => id.toLowerCase()))].sort()
    : [];
  return { scope: ids.length ? { calendar_ids: ids } : {}, reason: p.reason === 'rollback' ? 'rollback' : 'manual' };
}

/**
 * Run `rebaseline` di riparazione dal wizard (contratto §5.3 e §6.1): solo in
 * mode postgres con l'identità del volume verificata, con le opzioni
 * dell'ultima anteprima riuscita. La conferma digitata (APPLICA) la verifica
 * la route. Utile dopo un rollback interrotto a metà della ri-baseline o dopo
 * un import di backup che ha toccato le righe proiettate.
 */
export async function runRebaselineRun(ctx: MigrationRunContext<RebaselineParams>, depsIn: Partial<RebaselineDeps> = {}): Promise<RebaselineSummary> {
  const deps: RebaselineDeps = { ...defaultRebaselineDeps(), ...depsIn };
  const params = normalizeParams(ctx.params);
  const { client, principal } = deps.radicale();
  const state = await assertMigrationWritable({ db: ctx.db, client, principal });
  if (state.mode !== 'postgres') {
    throw preconditionError('La ri-baseline di riparazione si esegue solo in mode postgres.', ['MODE_NOT_POSTGRES']);
  }
  const reference = await referencePlan(ctx.db);
  await ctx.progress({ phase: 'rebaseline', message: 'Ri-baseline del ledger sulle righe correnti di Postgres' });
  const summary = await runRebaseline({ db: ctx.db, actor: ctx.actor, runId: ctx.runId, options: reference.options, signal: ctx.signal, deps });
  await ctx.progress({ phase: 'done', message: `Ri-baseline completata: ${summary.adopted} righe allineate` });
  if (params.scope.calendar_ids?.length) {
    log.info({ requested: params.scope.calendar_ids.length }, 'ri-baseline: l\'ambito richiesto è ignorato, la ri-baseline vale per tutte le collezioni del piano');
  }
  return summary;
}
