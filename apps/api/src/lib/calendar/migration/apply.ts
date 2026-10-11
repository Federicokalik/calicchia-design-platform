/**
 * Apply della migrazione a Radicale e primitive del ledger (fase F3 del
 * piano; design §13.6; contratto docs/calendar-radicale/contracts/f3-modules.md
 * §1.4, §4, §5 e §6.3).
 *
 * È l'unico scrittore di `cal_migration_ledger`: lo shadow mirror e l'archivio
 * della Fase 0 (init.ts) passano dalle primitive esportate qui. Ogni create,
 * update o delete segue il protocollo delle righe d'intento (contratto §4.3):
 *
 *  1. INTENTO, transazione breve committata PRIMA della richiesta: riga del
 *     ledger bloccata (o creata, o una riga ritirata allo stesso href
 *     riutilizzata), intent_op, fingerprint semantico del testo da scrivere,
 *     hash e snapshot della sorgente, If-Match usato, istante e run; nella
 *     stessa transazione reserveObjectId() per la risorsa e gli override (id
 *     legacy e legacy_uid, così list_events e il feed restano invariati);
 *  2. RICHIESTA: PUT con If-None-Match: * (create) o If-Match (update),
 *     DELETE con If-Match. Mai una transazione aperta attorno all'HTTP;
 *  3. ESITO, seconda transazione breve: etag scritto (dalla risposta o da un
 *     PROPFIND), fingerprint, hash e snapshot dell'intento, intento e
 *     rivalidazione azzerati; per una delete la riga si ritira;
 *  4. FALLIMENTI: 412 → intento azzerato e conflitto; 409 no-uid-conflict →
 *     ricerca dell'UID nella collezione e adozione (stesso contenuto) o
 *     UID_AT_OTHER_HREF; esito sconosciuto (timeout, connessione caduta, 5xx)
 *     → l'intento RESTA pendente e lo risolve il giro successivo con un GET
 *     della destinazione (adozione se ha il contenuto dell'intento).
 *
 * Così un kill in qualunque punto (anche fra la PUT e la transazione d'esito)
 * non duplica nulla: la riesecuzione adotta come noop ciò che era già stato
 * scritto, e una seconda esecuzione dopo un apply senza conflitti è al 100%
 * senza scritture (ApplySummary.zero_writes).
 *
 * runApply è il run `apply` del wizard (e dei giri notturni dello shadow):
 * ricalcola il piano con l'ambito e le opzioni dell'anteprima, si ferma con
 * PLAN_CHANGED prima di qualunque scrittura se l'hash non è quello visto
 * dall'utente (non alla ripresa dello stesso run dopo scritture del tentativo
 * precedente: il piano è cambiato per quelle), poi esegue per collezione adozioni, create e update e per
 * ultime le delete (uno spostamento crea nella nuova collezione prima di
 * cancellare nella vecchia), al più MIGRATION_LIMITS.maxPutsPerSecond
 * richieste al secondo, con l'identità del volume riverificata prima di ogni
 * collezione e almeno ogni 60 secondi, l'avanzamento a ogni item e
 * l'annullamento controllato solo fra un item e l'altro (mai a metà del
 * protocollo). Un solo run alla volta: l'esecutore tiene il lock
 * `cal-migration` e runApply lo verifica (e lo prende, se nessuno lo tiene).
 *
 * Mai MKCOL o MKCALENDAR: una collezione mancante è il conflitto
 * COLLECTION_MISSING (contratto §1.4 regola 1). Mai dati personali nei
 * dettagli delle righe, nei log e negli errori.
 */

import { type CalendarObject, parseCalendarObject, semanticFingerprint, serializeObject } from '@calicchia/calendar-core';
import { logger as rootLogger } from '../../logger';
import { objectPath, type RadicaleClient } from '../radicale/client';
import { clark, DAV_PROPS } from '../radicale/dav-xml';
import { isRadicaleError, type RadicaleError } from '../radicale/errors';
import { ObjectIdConflictError, reserveObjectId } from '../radicale/ids';
import type { Db } from '../radicale/policy';
import { inventoryAppPasswords } from './inventory';
import { buildPlan, objectItemDetail, type PlanInput, planItemKey, readTargetSnapshot } from './plan';
import { createIdentityGuard, describeRadicaleError, preconditionError, requireRadicale } from './preflight';
import { LEDGER_SELECT, ledgerRowFromDb, patchFromLegacyDiff, patchTowardSnapshot } from './serialize';
import {
  ANOMALY_DEFINITIONS,
  type ApplyOutcome,
  type ApplyParams,
  type ApplySummary,
  CONFLICT_CODES,
  type ConflictCode,
  emptyOutcomeCounts,
  FORCEABLE_CONFLICTS,
  isWriteAction,
  LEDGER_INTENT_OPS,
  LEDGER_KINDS,
  type LedgerIntentOp,
  type LedgerKind,
  type LedgerRow,
  type LegacyKey,
  type LegacySnapshot,
  MIGRATION_LIMITS,
  MIGRATION_LOCK_KEY,
  MigrationError,
  type MigrationItemInput,
  type MigrationRunContext,
  type MigrationScope,
  type PlanItem,
  type PlanMode,
  type ReservedObjectId,
  resolveMigrationOptions,
  type SkipCode,
  type TargetObject,
  type VerifyParams,
} from './types';

const log = rootLogger.child({ scope: 'calendar-migration-apply' });

// ─── Tipi del contratto (§6.3) ───────────────────────────────

export interface ExecuteContext {
  db: Db;
  client: RadicaleClient;
  principal: string;
  /** Run che esegue (null per i job shadow senza run). */
  runId: string | null;
  /** Attore di audit e log (admin:<id>, system:shadow...). */
  actor: string;
  mode: PlanMode;
  /**
   * Il chiamante autorizza le scritture forzate (conferma FORZA): un item con
   * un codice di conflitto e un'azione di scrittura (convenzione di plan.ts)
   * si esegue solo con forced = true, altrimenti resta un conflitto.
   */
  forced: boolean;
  signal?: AbortSignal;
  /** Limitatore delle richieste (migrationThrottle()). */
  throttle: () => Promise<void>;
  now: () => Date;
}

export interface ExecutedItem {
  outcome: ApplyOutcome;
  code: ConflictCode | SkipCode | null;
  etag_after: string | null;
  http_status: number | null;
  /** Messaggio breve senza dati personali (codice e status di Radicale, motivo). */
  error: string | null;
  fields: string[];
}

/** Ingresso di recordIntent (riga d'intento, contratto §4.3 passo 1). */
export interface RecordIntentInput {
  /** Riga già nota (anche ritirata: viene riattivata), o null. */
  ledgerId: string | null;
  calendar_id: string;
  collection_name: string;
  href: string;
  kind: LedgerKind;
  legacy_key: LegacyKey;
  legacy_event_id: string | null;
  uid: string | null;
  op: LedgerIntentOp;
  /** Fingerprint semantico del testo da scrivere (obbligatorio per create e update). */
  fingerprint: string | null;
  legacy_hash: string | null;
  snapshot: LegacySnapshot | null;
  /** If-Match usato (update e delete). */
  if_match: string | null;
  runId: string | null;
  objectIds: readonly ReservedObjectId[];
  legacy_uid: string | null;
}

/**
 * La riga d'intento non si può posizionare: href tracciato da un'altra chiave
 * (`href`), chiave già scritta a un altro href della collezione (`key`) o UID
 * vivo di un'altra chiave nella stessa collezione (`uid`). L'item diventa un
 * conflitto, mai una sovrascrittura.
 */
export class LedgerConflictError extends Error {
  constructor(readonly reason: 'href' | 'key' | 'uid', message: string, readonly otherHref: string | null = null) {
    super(message);
    this.name = 'LedgerConflictError';
  }
}

/** Stato del ledger diverso da quello che il chiamante si aspetta (riga sparita, intento assente). */
export class LedgerStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerStateError';
  }
}

// ─── Costanti e utilità ───────────────────────────────

const CONFLICT_SET: ReadonlySet<string> = new Set<string>(CONFLICT_CODES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const ITEM_ID_RE = /^[0-9]{1,19}$/;
/** Righe del run accumulate prima di un salvataggio (avanzamento visibile nel wizard). */
const ROWS_FLUSH_EVERY = 50;
/** Il contratto ammette al più 500 righe per addItems. */
const ROWS_CHUNK = 500;
const PG_UNIQUE_VIOLATION = '23505';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Esegue `fn` in una transazione breve (o direttamente se `db` è già una transazione). */
async function inTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const begin = (db as unknown as { begin?: unknown }).begin;
  if (typeof begin !== 'function') return fn(db);
  return (await db.begin(async (trx) => fn(trx as unknown as Db))) as T;
}

function isForcedItem(item: Pick<PlanItem, 'action' | 'code'>): boolean {
  return item.action !== 'conflict' && item.code !== null && CONFLICT_SET.has(item.code);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === PG_UNIQUE_VIOLATION;
}

function tzOf(snapshot: LegacySnapshot): string {
  return snapshot.kind === 'archive' ? 'Europe/Rome' : snapshot.calendar.timezone;
}

function shortError(err: unknown): string {
  if (isRadicaleError(err)) return describeRadicaleError(err);
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return String(err).slice(0, 300);
}

/** Esito d'errore che lascia l'intento pendente: la richiesta può essere arrivata a Radicale. */
function outcomeUnknown(err: unknown): boolean {
  if (!isRadicaleError(err)) return true;
  const e = err as RadicaleError;
  return e.outcomeUnknown || e.transient;
}

// ─── Limitatore di processo ───────────────────────────────

/** Prossimo istante libero del limitatore condiviso (ms dell'orologio di processo). */
let nextSlotAt = 0;

/**
 * Limitatore di processo condiviso da apply, shadow e archivio
 * (MIGRATION_LIMITS.maxPutsPerSecond): ogni chiamata della funzione
 * restituita prenota il prossimo slot libero e attende fino a quello. Tutte
 * le funzioni restituite condividono lo stesso stato, quindi il limite vale
 * per il processo intero (design §8: ≤ 20 PUT/s degli scrittori di sistema).
 */
export function migrationThrottle(): () => Promise<void> {
  return async () => {
    const interval = 1000 / MIGRATION_LIMITS.maxPutsPerSecond;
    const now = Date.now();
    const slot = Math.max(now, nextSlotAt);
    nextSlotAt = slot + interval;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  };
}

// ─── Primitive del ledger ───────────────────────────────

/**
 * Righe del ledger (vive, o anche ritirate con includeDeleted). I filtri si
 * combinano (AND); senza filtri tutte le righe vive.
 */
export async function readLedger(
  db: Db,
  filter: { calendarIds?: readonly string[]; legacyKeys?: readonly LegacyKey[]; includeDeleted?: boolean },
): Promise<LedgerRow[]> {
  const calendarIds = filter.calendarIds ? [...new Set(filter.calendarIds.map((id) => id.toLowerCase()))] : null;
  const keys = filter.legacyKeys ? [...new Set(filter.legacyKeys)] : null;
  if ((calendarIds && calendarIds.length === 0) || (keys && keys.length === 0)) return [];
  const rows = await db<Array<Record<string, unknown>>>`
    SELECT ${db.unsafe(LEDGER_SELECT)} FROM cal_migration_ledger
    WHERE (${calendarIds === null} OR calendar_id = ANY(${calendarIds ?? []}::uuid[]))
      AND (${keys === null} OR legacy_key = ANY(${keys ?? []}::text[]))
      AND (${filter.includeDeleted === true} OR deleted_at IS NULL)
    ORDER BY calendar_id, href, id
  `;
  return rows.map(ledgerRowFromDb);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- frammento di postgres-js (stesso schema di busy.ts e ids.ts)
async function selectRow(tx: Db, where: any, lock: boolean): Promise<LedgerRow | null> {
  const rows = await tx<Array<Record<string, unknown>>>`
    SELECT ${tx.unsafe(LEDGER_SELECT)} FROM cal_migration_ledger WHERE ${where}
    ORDER BY id
    ${lock ? tx`FOR UPDATE` : tx``}
  `;
  return rows[0] ? ledgerRowFromDb(rows[0]) : null;
}

async function rowById(tx: Db, id: string, lock = false): Promise<LedgerRow | null> {
  return selectRow(tx, tx`id = ${id}::bigint`, lock);
}

function neverWritten(row: Pick<LedgerRow, 'written_at' | 'written_etag'>): boolean {
  return row.written_at === null && row.written_etag === null;
}

/** Ritira una riga senza scritture né intento (residuo di un intento azzerato). */
async function retireStale(tx: Db, id: string): Promise<void> {
  await tx`
    UPDATE cal_migration_ledger
    SET deleted_at = now(), legacy_snapshot = NULL, legacy_hash = NULL, revalidate_reason = NULL, revalidate_since = NULL
    WHERE id = ${id}::bigint AND written_at IS NULL AND written_etag IS NULL AND intent_op IS NULL AND deleted_at IS NULL
  `;
}

/**
 * Posiziona la riga di una chiave su (calendario, href) dentro la transazione,
 * con le righe interessate bloccate: riga indicata, riga allo stesso href
 * (riutilizzata se ritirata o della stessa chiave), riga viva della stessa
 * chiave a un altro href (spostata se non è mai stata scritta), righe vive di
 * altre chiavi con lo stesso UID (ritirate se non sono mai state scritte).
 * Restituisce la riga da aggiornare (già allo href voluto e viva) o null se va
 * inserita. Lancia LedgerConflictError per le situazioni che non si risolvono
 * senza perdere informazione.
 */
async function positionRow(
  tx: Db,
  input: { ledgerId: string | null; calendar_id: string; href: string; legacy_key: LegacyKey; uid: string | null },
): Promise<LedgerRow | null> {
  const cal = input.calendar_id.toLowerCase();
  let row: LedgerRow | null = null;
  if (input.ledgerId) {
    row = await rowById(tx, input.ledgerId, true);
    if (!row) throw new LedgerStateError(`riga del ledger ${input.ledgerId} inesistente`);
    if (row.calendar_id !== cal || row.legacy_key !== input.legacy_key) {
      throw new LedgerStateError(`la riga del ledger ${input.ledgerId} appartiene a un'altra chiave o collezione`);
    }
  }

  const atHref = await selectRow(tx, tx`calendar_id = ${cal}::uuid AND href = ${input.href}`, true);
  if (atHref && atHref.id !== row?.id) {
    if (atHref.deleted_at === null) {
      if (atHref.legacy_key !== input.legacy_key) {
        throw new LedgerConflictError('href', `href ${input.href} già tracciato da ${atHref.legacy_key}`, atHref.href);
      }
      // Riga viva della stessa chiave allo href: è quella giusta (quella indicata non può essere viva, per l'indice unico).
      row = atHref;
    } else if (!row) {
      row = atHref; // riga ritirata allo stesso href: riutilizzata (una riga per href)
    } else {
      // La riga indicata si sposta qui: la riga ritirata che occupa l'href non serve più.
      await tx`DELETE FROM cal_migration_ledger WHERE id = ${atHref.id}::bigint AND deleted_at IS NOT NULL`;
    }
  }

  const sameKey = await selectRow(
    tx,
    tx`calendar_id = ${cal}::uuid AND legacy_key = ${input.legacy_key} AND deleted_at IS NULL AND href <> ${input.href}`,
    true,
  );
  if (sameKey && sameKey.id !== row?.id) {
    if (!neverWritten(sameKey) || sameKey.intent_op !== null) {
      throw new LedgerConflictError('key', `${input.legacy_key} è già scritta a ${sameKey.href} nella collezione`, sameKey.href);
    }
    if (!row || row.deleted_at !== null) {
      // Una riga mai scritta della stessa chiave si sposta all'href voluto; la ritirata indicata resta ritirata.
      if (row && row.deleted_at !== null && row.href === input.href) {
        await tx`DELETE FROM cal_migration_ledger WHERE id = ${row.id}::bigint AND deleted_at IS NOT NULL`;
      }
      row = sameKey;
    } else {
      await retireStale(tx, sameKey.id);
    }
  }

  if (input.uid) {
    const others = await tx<Array<Record<string, unknown>>>`
      SELECT ${tx.unsafe(LEDGER_SELECT)} FROM cal_migration_ledger
      WHERE calendar_id = ${cal}::uuid AND uid = ${input.uid} AND deleted_at IS NULL AND legacy_key <> ${input.legacy_key}
      ORDER BY id
      FOR UPDATE
    `;
    for (const raw of others) {
      const other = ledgerRowFromDb(raw);
      if (neverWritten(other) && other.intent_op === null) {
        await retireStale(tx, other.id);
        continue;
      }
      throw new LedgerConflictError('uid', `UID già tracciato da ${other.legacy_key} a ${other.href}`, other.href);
    }
  }

  if (row && row.href !== input.href) {
    if (!neverWritten(row) || row.intent_op !== null) {
      throw new LedgerConflictError('key', `${input.legacy_key} è già scritta a ${row.href}`, row.href);
    }
    await tx`UPDATE cal_migration_ledger SET href = ${input.href} WHERE id = ${row.id}::bigint`;
    row = { ...row, href: input.href };
  }
  return row;
}

async function reserveIds(
  tx: Db,
  input: { calendar_id: string; href: string; uid: string | null; legacy_uid: string | null; objectIds: readonly ReservedObjectId[] },
): Promise<void> {
  for (const oid of input.objectIds) {
    try {
      await reserveObjectId(tx, {
        calendarId: input.calendar_id,
        href: input.href,
        recurrenceKey: oid.recurrence_key,
        id: oid.id,
        uid: input.uid,
        legacyEventId: oid.legacy_event_id,
        legacyUid: oid.recurrence_key === '' ? input.legacy_uid : null,
      });
    } catch (err) {
      // L'id legacy è già di un'altra posizione (per esempio prima di uno spostamento): la
      // posizione nuova riceverà un id dalla sync (MOVE o X-CALDES-LEGACY-ID), mai un errore.
      if (err instanceof ObjectIdConflictError) {
        log.warn({ calendarId: input.calendar_id, href: input.href, recurrenceKey: oid.recurrence_key, id: oid.id }, 'id legacy già usato da un\'altra posizione: non preassegnato');
        continue;
      }
      throw err;
    }
  }
}

function validateIntent(input: RecordIntentInput): void {
  if (!(LEDGER_INTENT_OPS as readonly string[]).includes(input.op)) throw new TypeError(`operazione d'intento non valida: ${String(input.op)}`);
  if (!(LEDGER_KINDS as readonly string[]).includes(input.kind)) throw new TypeError(`tipo del ledger non valido: ${String(input.kind)}`);
  if (!input.legacy_key.startsWith(`${input.kind}:`)) throw new TypeError(`chiave ${input.legacy_key} non coerente con il tipo ${input.kind}`);
  if (!UUID_RE.test(input.calendar_id)) throw new TypeError('calendar_id non valido');
  if (input.op !== 'delete' && (!input.fingerprint || !input.legacy_hash)) {
    throw new TypeError('intento di create/update senza fingerprint o legacy_hash');
  }
  if (input.op === 'update' && !input.if_match) throw new TypeError('intento di update senza If-Match');
  if (input.op === 'delete' && !input.if_match) throw new TypeError('intento di delete senza If-Match');
}

/**
 * Riga d'intento (contratto §4.3 passo 1), in una transazione breve che il
 * chiamante committa PRIMA della richiesta a Radicale. Per create e update
 * preassegna anche gli id (reserveObjectId) della risorsa e degli override.
 * Lancia LedgerConflictError se la riga non si può posizionare senza perdere
 * informazione (href o UID tracciati da un'altra chiave).
 */
export async function recordIntent(db: Db, input: RecordIntentInput): Promise<LedgerRow> {
  validateIntent(input);
  const cal = input.calendar_id.toLowerCase();
  const writes = input.op !== 'delete';
  try {
    return await inTx(db, async (tx) => {
      const row = await positionRow(tx, { ledgerId: input.ledgerId, calendar_id: cal, href: input.href, legacy_key: input.legacy_key, uid: input.uid });
      const snapshot = writes && input.snapshot ? tx.json(input.snapshot as never) : null;
      let id: string;
      if (row) {
        const revive = row.deleted_at !== null;
        // Una riga ritirata di un'altra chiave allo stesso href si riutilizza da capo.
        const sameKey = row.legacy_key === input.legacy_key;
        await tx`
          UPDATE cal_migration_ledger SET
            kind = ${input.kind},
            legacy_key = ${input.legacy_key},
            collection_name = ${input.collection_name},
            uid = ${sameKey ? tx`COALESCE(${input.uid}, uid)` : tx`${input.uid}`},
            legacy_event_id = ${sameKey ? tx`COALESCE(${input.legacy_event_id}::uuid, legacy_event_id)` : tx`${input.legacy_event_id}::uuid`},
            deleted_at = NULL,
            adopted = CASE WHEN ${revive} THEN false ELSE adopted END,
            derived = CASE WHEN ${revive} THEN false ELSE derived END,
            intent_op = ${input.op},
            intent_fingerprint = ${writes ? input.fingerprint : null},
            intent_legacy_hash = ${writes ? input.legacy_hash : null},
            intent_snapshot = ${snapshot},
            intent_etag = ${input.if_match},
            intent_at = now(),
            intent_run_id = ${input.runId}::uuid
          WHERE id = ${row.id}::bigint
        `;
        id = row.id;
      } else {
        const [inserted] = await tx<Array<{ id: string }>>`
          INSERT INTO cal_migration_ledger (
            calendar_id, collection_name, href, kind, legacy_key, legacy_event_id, uid,
            intent_op, intent_fingerprint, intent_legacy_hash, intent_snapshot, intent_etag, intent_at, intent_run_id
          ) VALUES (
            ${cal}::uuid, ${input.collection_name}, ${input.href}, ${input.kind}, ${input.legacy_key}, ${input.legacy_event_id}::uuid, ${input.uid},
            ${input.op}, ${writes ? input.fingerprint : null}, ${writes ? input.legacy_hash : null}, ${snapshot}, ${input.if_match}, now(), ${input.runId}::uuid
          )
          RETURNING id::text AS id
        `;
        id = inserted.id;
      }
      if (writes && input.objectIds.length) {
        await reserveIds(tx, { calendar_id: cal, href: input.href, uid: input.uid, legacy_uid: input.legacy_uid, objectIds: input.objectIds });
      }
      const out = await rowById(tx, id);
      if (!out) throw new LedgerStateError(`riga del ledger ${id} sparita dopo l'intento`);
      return out;
    });
  } catch (err) {
    // Gara con un altro scrittore sugli indici unici (href, chiave o UID vivi).
    if (isUniqueViolation(err)) throw new LedgerConflictError('uid', `vincolo unico del ledger violato per ${input.legacy_key} a ${input.href}`);
    throw err;
  }
}

/**
 * Esito di una scrittura (contratto §4.3 passo 3): etag scritto, fingerprint,
 * hash e snapshot dell'intento; intento e rivalidazione azzerati. Con
 * `adopted` la riga diventa adottata (destinazione già con il contenuto
 * voluto: gli update successivi passano dalla patch per campo). Un intento di
 * delete ritira la riga. Lancia LedgerStateError se non c'è un intento.
 */
export async function completeIntent(db: Db, ledgerId: string, result: { etag: string | null; runId: string | null; adopted?: boolean }): Promise<LedgerRow> {
  const rows = await db<Array<Record<string, unknown>>>`
    UPDATE cal_migration_ledger SET
      written_etag = ${result.etag},
      written_fingerprint = intent_fingerprint,
      written_at = now(),
      legacy_hash = intent_legacy_hash,
      legacy_snapshot = intent_snapshot,
      intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL,
      intent_etag = NULL, intent_at = NULL, intent_run_id = NULL,
      revalidate_reason = NULL, revalidate_since = NULL,
      adopted = adopted OR ${result.adopted === true},
      last_run_id = COALESCE(${result.runId}::uuid, last_run_id)
    WHERE id = ${ledgerId}::bigint AND intent_op IN ('create', 'update')
    RETURNING ${db.unsafe(LEDGER_SELECT)}
  `;
  if (rows[0]) return ledgerRowFromDb(rows[0]);
  const current = await rowById(db, ledgerId);
  if (current?.intent_op === 'delete') {
    await retireLedgerRow(db, ledgerId, result.runId);
    return (await rowById(db, ledgerId)) as LedgerRow;
  }
  throw new LedgerStateError(`nessun intento da completare sulla riga ${ledgerId}`);
}

/**
 * Azzera l'intento (412, rifiuto certo, intento mai applicato). Una riga che
 * non è mai stata scritta si ritira: non traccia nulla e non deve occupare la
 * chiave né l'UID nella collezione (una ripresa la riattiva con recordIntent).
 */
export async function clearIntent(db: Db, ledgerId: string): Promise<void> {
  await db`
    UPDATE cal_migration_ledger SET
      intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL,
      intent_etag = NULL, intent_at = NULL, intent_run_id = NULL,
      deleted_at = CASE WHEN written_at IS NULL AND written_etag IS NULL THEN now() ELSE deleted_at END,
      legacy_snapshot = CASE WHEN written_at IS NULL AND written_etag IS NULL THEN NULL ELSE legacy_snapshot END,
      legacy_hash = CASE WHEN written_at IS NULL AND written_etag IS NULL THEN NULL ELSE legacy_hash END,
      revalidate_reason = CASE WHEN written_at IS NULL AND written_etag IS NULL THEN NULL ELSE revalidate_reason END,
      revalidate_since = CASE WHEN written_at IS NULL AND written_etag IS NULL THEN NULL ELSE revalidate_since END
    WHERE id = ${ledgerId}::bigint
  `;
}

/** Toglie la marcatura di rivalidazione (noop: la sorgente coincide con lo scritto) senza scrivere. */
async function clearRevalidation(db: Db, ledgerId: string, runId: string | null): Promise<void> {
  await db`
    UPDATE cal_migration_ledger SET revalidate_reason = NULL, revalidate_since = NULL, last_run_id = COALESCE(${runId}::uuid, last_run_id)
    WHERE id = ${ledgerId}::bigint AND revalidate_reason IS NOT NULL
  `;
}

/**
 * Adozione (contratto §4.4): la destinazione ha già il contenuto voluto
 * (adozione per fingerprint, no-uid-conflict con lo stesso contenuto,
 * destinazione cambiata fuori dallo strumento con il contenuto del piano) o
 * va solo registrato lo snapshot nuovo (sorgente cambiata con lo stesso testo,
 * etag cambiato con lo stesso contenuto). Nessuna richiesta a Radicale: la
 * riga della chiave si porta sull'href della destinazione con etag e
 * fingerprint correnti, snapshot e hash della sorgente; intento e
 * rivalidazione si azzerano. `adopted` diventa true salvo quando la
 * destinazione è ancora quella scritta dallo strumento (stesso etag o stesso
 * fingerprint dell'ultima scrittura), che conserva il flag.
 */
export async function adoptTarget(db: Db, input: { item: PlanItem; target: TargetObject; runId: string | null }): Promise<LedgerRow> {
  const { item, target, runId } = input;
  const s = item.source;
  if (!s) throw new TypeError('adoptTarget richiede l\'oggetto voluto (per una sorgente sparita si ritira la riga)');
  const cal = item.calendar_id.toLowerCase();
  try {
    return await inTx(db, async (tx) => {
      const known = item.ledger && item.ledger.calendar_id === cal && item.ledger.legacy_key === item.legacy_key ? item.ledger.id : null;
      const row = await positionRow(tx, { ledgerId: known, calendar_id: cal, href: target.href, legacy_key: item.legacy_key, uid: s.uid });
      const refresh = row !== null && row.deleted_at === null && row.written_at !== null
        && ((target.etag !== null && target.etag === row.written_etag)
          || (target.fingerprint !== null && row.written_fingerprint !== null && target.fingerprint === row.written_fingerprint));
      const adopted = refresh ? (row as LedgerRow).adopted : true;
      const etag = target.etag ?? (refresh ? (row as LedgerRow).written_etag : null);
      const fingerprint = target.fingerprint ?? (refresh ? (row as LedgerRow).written_fingerprint : null) ?? s.fingerprint;
      const snapshot = tx.json(s.legacy_snapshot as never);
      let id: string;
      if (row) {
        await tx`
          UPDATE cal_migration_ledger SET
            kind = ${item.kind}, legacy_key = ${item.legacy_key}, collection_name = ${item.collection_name}, uid = ${s.uid},
            legacy_event_id = ${row.legacy_key === item.legacy_key ? tx`COALESCE(${s.legacy_event_id}::uuid, legacy_event_id)` : tx`${s.legacy_event_id}::uuid`},
            derived = CASE WHEN ${row.deleted_at !== null || row.legacy_key !== item.legacy_key} THEN false ELSE derived END,
            legacy_snapshot = ${snapshot}, legacy_hash = ${s.legacy_hash},
            written_etag = ${etag}, written_fingerprint = ${fingerprint}, written_at = now(),
            intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL,
            intent_etag = NULL, intent_at = NULL, intent_run_id = NULL,
            revalidate_reason = NULL, revalidate_since = NULL,
            deleted_at = NULL,
            adopted = ${adopted},
            last_run_id = COALESCE(${runId}::uuid, last_run_id)
          WHERE id = ${row.id}::bigint
        `;
        id = row.id;
      } else {
        const [inserted] = await tx<Array<{ id: string }>>`
          INSERT INTO cal_migration_ledger (
            calendar_id, collection_name, href, kind, legacy_key, legacy_event_id, uid,
            legacy_snapshot, legacy_hash, written_etag, written_fingerprint, written_at, adopted, last_run_id
          ) VALUES (
            ${cal}::uuid, ${item.collection_name}, ${target.href}, ${item.kind}, ${item.legacy_key}, ${s.legacy_event_id}::uuid, ${s.uid},
            ${snapshot}, ${s.legacy_hash}, ${etag}, ${fingerprint}, now(), ${adopted}, ${runId}::uuid
          )
          RETURNING id::text AS id
        `;
        id = inserted.id;
      }
      if (s.object_ids.length) {
        await reserveIds(tx, { calendar_id: cal, href: target.href, uid: s.uid, legacy_uid: s.legacy_uid, objectIds: s.object_ids });
      }
      const out = await rowById(tx, id);
      if (!out) throw new LedgerStateError(`riga del ledger ${id} sparita dopo l'adozione`);
      return out;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new LedgerConflictError('uid', `vincolo unico del ledger violato adottando ${item.legacy_key} a ${target.href}`);
    throw err;
  }
}

/**
 * Ritira una riga (delete riuscita, destinazione già assente, sorgente
 * sparita senza scritture): scritture, hash, snapshot, intento e
 * rivalidazione a NULL. La riga resta per l'href (riutilizzata se lo stesso
 * href torna nel piano).
 */
export async function retireLedgerRow(db: Db, ledgerId: string, runId: string | null): Promise<void> {
  await db`
    UPDATE cal_migration_ledger SET
      deleted_at = COALESCE(deleted_at, now()),
      written_etag = NULL, written_fingerprint = NULL, written_at = NULL,
      legacy_hash = NULL, legacy_snapshot = NULL,
      intent_op = NULL, intent_fingerprint = NULL, intent_legacy_hash = NULL, intent_snapshot = NULL,
      intent_etag = NULL, intent_at = NULL, intent_run_id = NULL,
      revalidate_reason = NULL, revalidate_since = NULL,
      last_run_id = COALESCE(${runId}::uuid, last_run_id)
    WHERE id = ${ledgerId}::bigint
  `;
}

// ─── Letture puntuali della destinazione ───────────────────────────────

function targetFromText(calendarId: string, collectionName: string, href: string, etag: string | null, body: string): TargetObject {
  const parsed = parseCalendarObject(body);
  return {
    calendar_id: calendarId,
    collection_name: collectionName,
    href,
    etag,
    uid: parsed.ok ? parsed.value.uid : null,
    fingerprint: parsed.ok ? semanticFingerprint(parsed.value) : null,
    raw: body,
  };
}

/** GET di un oggetto della collezione; null se non esiste. */
async function fetchTarget(ctx: ExecuteContext, calendarId: string, collectionName: string, href: string): Promise<TargetObject | null> {
  try {
    const got = await ctx.client.get(objectPath(ctx.principal, collectionName, href));
    const etag = got.etag ?? (await readEtag(ctx, collectionName, href));
    return targetFromText(calendarId, collectionName, href, etag, got.body);
  } catch (err) {
    if (isRadicaleError(err, 'not_found')) return null;
    throw err;
  }
}

/** getetag di un oggetto (PROPFIND Depth 0); null se assente o non restituito. */
async function readEtag(ctx: ExecuteContext, collectionName: string, href: string): Promise<string | null> {
  const props = await ctx.client.readProps(objectPath(ctx.principal, collectionName, href), [DAV_PROPS.getetag]);
  return props?.[clark(DAV_PROPS.getetag)]?.trim() || null;
}

async function readEtagSafe(ctx: ExecuteContext, collectionName: string, href: string): Promise<string | null> {
  try {
    return await readEtag(ctx, collectionName, href);
  } catch (err) {
    log.warn({ href, err: describeRadicaleError(err) }, 'etag dopo la PUT non leggibile: lo registra il giro successivo');
    return null;
  }
}

/** L'oggetto della collezione che porta `uid` (409 no-uid-conflict), letto con PROPFIND e multiget. */
async function findUidInCollection(ctx: ExecuteContext, calendarId: string, collectionName: string, uid: string): Promise<TargetObject | null> {
  const snap = await readTargetSnapshot(ctx.client, ctx.principal, [{ calendar_id: calendarId, collection_name: collectionName }], {
    needContent: () => true,
    signal: ctx.signal,
  });
  const coll = snap.collections.get(calendarId);
  if (!coll?.exists) return null;
  for (const t of coll.objects.values()) if (t.uid === uid) return t;
  return null;
}

// ─── Esecuzione di un item (§4.3, tabella del §7.2) ───────────────────────────────

/** Esito di un intento pendente dalla destinazione (stessa regola di plan.ts, riga 1 del §7.2). */
function intentState(l: LedgerRow, t: TargetObject | null): 'applied' | 'stale' | 'unknown' {
  if (l.intent_op === 'delete') {
    if (!t) return 'applied';
    if (l.intent_etag !== null && t.etag === l.intent_etag) return 'stale';
    return 'unknown';
  }
  if (t && t.fingerprint !== null && t.fingerprint === l.intent_fingerprint) return 'applied';
  if (!t) return 'stale';
  if (t.fingerprint !== null && l.written_fingerprint !== null && t.fingerprint === l.written_fingerprint) return 'stale';
  return 'unknown';
}

function result(item: PlanItem, outcome: ApplyOutcome, extra: Partial<ExecutedItem> = {}): ExecutedItem {
  return { outcome, code: null, etag_after: null, http_status: null, error: null, fields: item.fields, ...extra };
}

function conflictResult(item: PlanItem, code: ConflictCode, extra: Partial<ExecutedItem> = {}): ExecutedItem {
  return result(item, 'conflict', { code, ...extra });
}

/** Contenuto della patch per campo sull'oggetto corrente (null se il testo non si legge o la patch non si applica). */
function patchContent(raw: string, previous: LegacySnapshot | null, current: LegacySnapshot, now: Date):
  { object: CalendarObject; changed: boolean; fields: string[]; conflicts: number } | null {
  const parsed = parseCalendarObject(raw);
  if (!parsed.ok) return null;
  try {
    // Senza lo snapshot precedente (redatto dall'erasure GDPR) la patch è senza base, verso l'oggetto voluto.
    const p = previous
      ? patchFromLegacyDiff(parsed.value, previous, current, { tz: tzOf(current), now })
      : patchTowardSnapshot(parsed.value, current, { tz: tzOf(current), now });
    return { object: p.object, changed: p.changed, fields: p.fields, conflicts: p.conflicts.length };
  } catch (err) {
    log.warn({ err: shortError(err) }, 'patch per campo non applicabile: riscrittura completa dal piano');
    return null;
  }
}

/**
 * Un item del piano con il protocollo del §4.3 (usata da runApply e dallo
 * shadow). Non lancia per gli esiti di Radicale né per i conflitti del
 * ledger (diventano esiti dell'item); rilancia solo MigrationError
 * (annullamento, guardie) e gli errori del database prima dell'intento.
 */
export async function executePlanItem(item: PlanItem, ctx: ExecuteContext): Promise<ExecutedItem> {
  try {
    switch (item.action) {
      case 'skip':
        return result(item, 'skipped', { code: item.code });
      case 'noop':
        return await executeNoop(item, ctx);
      case 'conflict':
        return await executeConflict(item, ctx);
      case 'adopt':
        return await executeAdopt(item, ctx);
      case 'create':
      case 'update':
        return await executeWrite(item, ctx);
      case 'delete':
        return await executeDelete(item, ctx);
      default:
        return result(item, 'failed', { error: `azione sconosciuta ${String(item.action)}` });
    }
  } catch (err) {
    if (err instanceof MigrationError) throw err;
    if (err instanceof LedgerConflictError) {
      return conflictResult(item, err.reason === 'uid' ? 'UID_AT_OTHER_HREF' : 'UNTRACKED_TARGET', { error: err.message.slice(0, 300) });
    }
    log.error({ err: shortError(err), href: item.href, action: item.action }, 'item dell\'apply non eseguito');
    return result(item, 'failed', { error: shortError(err) });
  }
}

async function executeNoop(item: PlanItem, ctx: ExecuteContext): Promise<ExecutedItem> {
  const l = item.ledger;
  if (l) {
    // Intento mai applicato (il piano lo ha escluso leggendo la destinazione): si azzera.
    if (l.intent_op) await clearIntent(ctx.db, l.id);
    // Sorgente e destinazione coincidono con lo scritto: la rivalidazione si toglie senza scrivere.
    if (l.revalidate_reason) await clearRevalidation(ctx.db, l.id, ctx.runId);
  }
  return result(item, 'noop');
}

async function executeConflict(item: PlanItem, ctx: ExecuteContext): Promise<ExecutedItem> {
  const l = item.ledger;
  // Un intento escluso dalla destinazione (mai applicato) si azzera; uno dall'esito ignoto resta per il "forza".
  if (l?.intent_op && intentState(l, item.target) === 'stale') await clearIntent(ctx.db, l.id);
  return conflictResult(item, (item.code as ConflictCode) ?? 'UNTRACKED_TARGET');
}

async function executeAdopt(item: PlanItem, ctx: ExecuteContext): Promise<ExecutedItem> {
  const forced = isForcedItem(item);
  if (forced && !ctx.forced) return conflictResult(item, item.code as ConflictCode);
  const outcome: ApplyOutcome = forced ? 'forced' : 'adopted';
  const l = item.ledger;

  // 1. Intento pendente con la destinazione nello stato voluto dall'intento: transazione d'esito senza richiesta.
  if (l?.intent_op) {
    const state = intentState(l, item.target);
    if (state === 'applied') {
      if (l.intent_op === 'delete') {
        await retireLedgerRow(ctx.db, l.id, ctx.runId);
        return result(item, outcome);
      }
      const etag = item.target?.etag ?? (await readEtag(ctx, item.collection_name, l.href));
      await completeIntent(ctx.db, l.id, { etag, runId: ctx.runId, adopted: true });
      return result(item, outcome, { etag_after: etag });
    }
    if (state === 'unknown') return conflictResult(item, 'UNTRACKED_TARGET', { error: 'intento pendente con una destinazione diversa' });
    // Intento mai applicato: si prosegue con l'adozione decisa dal piano (che azzera l'intento).
  }

  // 2. Sorgente sparita o saltata: la riga si ritira (destinazione assente o mai scritta).
  if (!item.source) {
    if (l) await retireLedgerRow(ctx.db, l.id, ctx.runId);
    return result(item, outcome);
  }

  // 3. Adozione della destinazione (anche all'href in cui vive l'UID dell'oggetto).
  let target = item.target;
  if (item.other_href) {
    await ctx.throttle();
    target = await fetchTarget(ctx, item.calendar_id, item.collection_name, item.other_href);
    if (!target || target.uid !== item.source.uid || target.fingerprint !== item.source.fingerprint) {
      if (l?.intent_op) await clearIntent(ctx.db, l.id);
      return conflictResult(item, 'UID_AT_OTHER_HREF', { error: 'oggetto all\'altro href cambiato dopo l\'anteprima' });
    }
  }
  if (!target) return result(item, 'failed', { error: 'destinazione da adottare assente' });
  if (!target.etag) target = { ...target, etag: await readEtag(ctx, item.collection_name, target.href) };
  await adoptTarget(ctx.db, { item, target, runId: ctx.runId });
  return result(item, outcome, { etag_after: target.etag });
}

interface WriteContent {
  ics: string;
  fingerprint: string;
  fields: string[];
}

/** Una PUT del protocollo §4.3 (create o update) con il contenuto da scrivere. */
interface WriteRequest {
  op: 'create' | 'update';
  href: string;
  ifMatch: string | null;
  content: WriteContent;
  forced: boolean;
  /** Shadow: dopo un 412 si rilegge e si riprova una volta con la patch (§9.3). */
  retryPatch: boolean;
  /**
   * Il contenuto è la patch per campo dell'oggetto corrente e conserva
   * proprietà della destinazione fuori dal piano (VALARM, ATTENDEE, X-* di un
   * device): l'esito rende la riga `adopted`, così V2 confronta solo i campi
   * del piano e gli update successivi, anche dell'apply, restano patch.
   */
  preservesTarget: boolean;
}

async function executeWrite(item: PlanItem, ctx: ExecuteContext): Promise<ExecutedItem> {
  const forced = isForcedItem(item);
  if (forced && !ctx.forced) return conflictResult(item, item.code as ConflictCode);
  const s = item.source;
  if (!s) return result(item, 'failed', { error: 'oggetto voluto assente per una scrittura' });
  const op = item.action as 'create' | 'update';
  const l = item.ledger;
  // UID_AT_OTHER_HREF forzato: si scrive all'href in cui vive l'UID, con l'etag letto lì.
  const href = op === 'update' && item.other_href ? item.other_href : item.href;

  let target = item.target;
  let ifMatch: string | null = null;
  if (op === 'update') {
    ifMatch = target?.etag ?? null;
    if (!ifMatch) {
      ifMatch = await readEtag(ctx, item.collection_name, href);
      if (!ifMatch) return conflictResult(item, 'DELETED_IN_TARGET', { error: 'destinazione sparita prima dell\'update' });
    }
  }

  // Contenuto: patch per campo sull'oggetto corrente per le righe adottate o derivate (e nello shadow), altrimenti il piano.
  let content: WriteContent = { ics: s.ics, fingerprint: s.fingerprint, fields: item.fields };
  const patchable = l !== null && s.legacy_snapshot.kind !== 'archive' && (l.legacy_snapshot === null || l.legacy_snapshot.kind === s.legacy_snapshot.kind);
  if (op === 'update' && item.patch && !forced && l && patchable) {
    let raw = target?.raw ?? null;
    if (raw === null) {
      await ctx.throttle();
      const fresh = await fetchTarget(ctx, item.calendar_id, item.collection_name, href);
      if (!fresh) return conflictResult(item, 'DELETED_IN_TARGET', { error: 'destinazione sparita prima della patch' });
      if (fresh.etag !== ifMatch) return conflictResult(item, 'BOTH_CHANGED', { error: 'destinazione cambiata dopo l\'anteprima' });
      target = fresh;
      raw = fresh.raw;
    }
    const patched = raw !== null ? patchContent(raw, l.legacy_snapshot, s.legacy_snapshot, ctx.now()) : null;
    if (patched) {
      if (!patched.changed && target) {
        // La destinazione ha già i campi voluti: si registra lo snapshot nuovo senza scrivere.
        await adoptTarget(ctx.db, { item, target: { ...target, etag: ifMatch }, runId: ctx.runId });
        return result(item, 'adopted', { etag_after: ifMatch, fields: patched.fields });
      }
      content = { ics: serializeObject(patched.object), fingerprint: semanticFingerprint(patched.object), fields: patched.fields };
    } else {
      content = { ...content, fields: [...content.fields, 'riscrittura completa'] };
    }
  }

  return writeWithIntent(item, ctx, {
    op,
    href,
    ifMatch,
    content,
    forced,
    retryPatch: ctx.mode === 'shadow' && item.patch && op === 'update',
    preservesTarget: content.fingerprint !== s.fingerprint,
  });
}

/** Passi 1-4 del §4.3 per una PUT (create o update). */
async function writeWithIntent(
  item: PlanItem,
  ctx: ExecuteContext,
  w: WriteRequest,
): Promise<ExecutedItem> {
  const s = item.source as NonNullable<PlanItem['source']>;
  const path = objectPath(ctx.principal, item.collection_name, w.href);
  const intent = await recordIntent(ctx.db, {
    ledgerId: item.ledger && item.ledger.calendar_id === item.calendar_id.toLowerCase() ? item.ledger.id : null,
    calendar_id: item.calendar_id,
    collection_name: item.collection_name,
    href: w.href,
    kind: item.kind,
    legacy_key: item.legacy_key,
    legacy_event_id: s.legacy_event_id,
    uid: s.uid,
    op: w.op,
    fingerprint: w.content.fingerprint,
    legacy_hash: s.legacy_hash,
    snapshot: s.legacy_snapshot,
    if_match: w.ifMatch,
    runId: ctx.runId,
    objectIds: s.object_ids,
    legacy_uid: s.legacy_uid,
  });

  await ctx.throttle();
  let put: { etag: string | null; created: boolean };
  try {
    put = await ctx.client.put(path, w.content.ics, w.op === 'create' ? { ifNoneMatch: '*' } : { ifMatch: w.ifMatch as string });
  } catch (err) {
    return handlePutError(item, ctx, w, intent, err);
  }
  const etag = put.etag ?? (await readEtagSafe(ctx, item.collection_name, w.href));
  try {
    await completeIntent(ctx.db, intent.id, { etag, runId: ctx.runId, adopted: w.preservesTarget });
  } catch (err) {
    // La PUT è riuscita ma l'esito non è registrato: l'intento resta pendente e il giro successivo lo adotta.
    log.error({ href: w.href, err: shortError(err) }, 'esito della scrittura non registrato nel ledger');
    return result(item, 'failed', { http_status: put.created ? 201 : 204, error: `esito non registrato: ${shortError(err)}` });
  }
  return result(item, w.forced ? 'forced' : 'done', { etag_after: etag, http_status: put.created ? 201 : 204, fields: w.content.fields });
}

async function handlePutError(
  item: PlanItem,
  ctx: ExecuteContext,
  w: WriteRequest,
  intent: LedgerRow,
  err: unknown,
): Promise<ExecutedItem> {
  const status = isRadicaleError(err) ? (err as RadicaleError).status : null;

  if (isRadicaleError(err, 'precondition_failed')) {
    if (w.op === 'create') {
      // Creata nel frattempo: con il contenuto voluto si adotta, altrimenti è un oggetto non tracciato.
      await ctx.throttle();
      const now = await fetchTarget(ctx, item.calendar_id, item.collection_name, w.href);
      if (now && now.fingerprint !== null && now.fingerprint === w.content.fingerprint) {
        await completeIntent(ctx.db, intent.id, { etag: now.etag, runId: ctx.runId, adopted: true });
        return result(item, 'adopted', { etag_after: now.etag, http_status: 412 });
      }
      await clearIntent(ctx.db, intent.id);
      return conflictResult(item, 'UNTRACKED_TARGET', { http_status: 412 });
    }
    if (w.retryPatch && item.ledger && item.source) {
      // Shadow (contratto §9.3): si rilegge e si riprova una volta con la patch sull'oggetto nuovo.
      return retryShadowPatch(item, ctx, w, intent);
    }
    await clearIntent(ctx.db, intent.id);
    return conflictResult(item, w.forced ? (item.code as ConflictCode) : 'BOTH_CHANGED', { http_status: 412 });
  }

  if (isRadicaleError(err, 'uid_conflict')) {
    await clearIntent(ctx.db, intent.id);
    const s = item.source as NonNullable<PlanItem['source']>;
    const other = await findUidInCollection(ctx, item.calendar_id, item.collection_name, s.uid);
    if (other && other.href !== w.href && other.fingerprint !== null && other.fingerprint === w.content.fingerprint) {
      const etag = other.etag ?? (await readEtag(ctx, item.collection_name, other.href));
      await adoptTarget(ctx.db, { item, target: { ...other, etag }, runId: ctx.runId });
      return result(item, 'adopted', { etag_after: etag, http_status: 409, fields: [...w.content.fields, `href:${other.href}`] });
    }
    return conflictResult(item, 'UID_AT_OTHER_HREF', { http_status: 409, error: other ? `UID già presente a ${other.href}` : 'UID già presente nella collezione' });
  }

  if (isRadicaleError(err, 'not_found') || isRadicaleError(err, 'conflict')) {
    // 404 o 409 senza no-uid-conflict: per una create manca la collezione (mai creata qui), per un update la risorsa è sparita.
    await clearIntent(ctx.db, intent.id);
    return conflictResult(item, w.op === 'create' ? 'COLLECTION_MISSING' : 'DELETED_IN_TARGET', { http_status: status });
  }

  if (outcomeUnknown(err)) {
    // Esito ignoto: l'intento resta pendente, il giro successivo lo risolve con un GET.
    return result(item, 'failed', { http_status: status, error: shortError(err) });
  }
  await clearIntent(ctx.db, intent.id);
  return result(item, 'failed', { http_status: status, error: shortError(err) });
}

/** 412 nello shadow: rilettura, patch ricalcolata (CAS dei campi toccati) e un solo nuovo tentativo. */
async function retryShadowPatch(
  item: PlanItem,
  ctx: ExecuteContext,
  w: WriteRequest,
  intent: LedgerRow,
): Promise<ExecutedItem> {
  const s = item.source as NonNullable<PlanItem['source']>;
  const previous = item.ledger?.legacy_snapshot ?? null;
  await ctx.throttle();
  const fresh = await fetchTarget(ctx, item.calendar_id, item.collection_name, w.href);
  if (!fresh || !fresh.raw || !fresh.etag) {
    await clearIntent(ctx.db, intent.id);
    return conflictResult(item, fresh ? 'BOTH_CHANGED' : 'DELETED_IN_TARGET', { http_status: 412 });
  }
  const patched = patchContent(fresh.raw, previous, s.legacy_snapshot, ctx.now());
  if (!patched || patched.conflicts > 0) {
    await clearIntent(ctx.db, intent.id);
    return conflictResult(item, 'BOTH_CHANGED', { http_status: 412, fields: patched?.fields ?? item.fields });
  }
  if (!patched.changed) {
    await clearIntent(ctx.db, intent.id);
    await adoptTarget(ctx.db, { item, target: fresh, runId: ctx.runId });
    return result(item, 'adopted', { etag_after: fresh.etag, http_status: 412, fields: patched.fields });
  }
  const content: WriteContent = { ics: serializeObject(patched.object), fingerprint: semanticFingerprint(patched.object), fields: patched.fields };
  return writeWithIntent({ ...item, target: fresh, ledger: intent }, ctx, {
    ...w,
    ifMatch: fresh.etag,
    content,
    retryPatch: false,
    preservesTarget: content.fingerprint !== s.fingerprint,
  });
}

async function executeDelete(item: PlanItem, ctx: ExecuteContext): Promise<ExecutedItem> {
  const forced = isForcedItem(item);
  if (forced && !ctx.forced) return conflictResult(item, item.code as ConflictCode);
  const l = item.ledger;
  if (!l) return result(item, 'failed', { error: 'riga del ledger assente per una cancellazione' });
  let ifMatch = item.target?.etag ?? null;
  if (!ifMatch) {
    ifMatch = await readEtag(ctx, item.collection_name, item.href);
    if (!ifMatch) {
      // Già sparita: si ritira la riga (riga 13 del §7.2).
      await retireLedgerRow(ctx.db, l.id, ctx.runId);
      return result(item, forced ? 'forced' : 'adopted', { code: item.code });
    }
  }
  const intent = await recordIntent(ctx.db, {
    ledgerId: l.id,
    calendar_id: l.calendar_id,
    collection_name: item.collection_name,
    href: l.href,
    kind: l.kind,
    legacy_key: l.legacy_key,
    legacy_event_id: l.legacy_event_id,
    uid: l.uid,
    op: 'delete',
    fingerprint: null,
    legacy_hash: null,
    snapshot: null,
    if_match: ifMatch,
    runId: ctx.runId,
    objectIds: [],
    legacy_uid: null,
  });
  await ctx.throttle();
  try {
    await ctx.client.delete(objectPath(ctx.principal, item.collection_name, l.href), { ifMatch });
  } catch (err) {
    const status = isRadicaleError(err) ? (err as RadicaleError).status : null;
    if (isRadicaleError(err, 'not_found')) {
      await retireLedgerRow(ctx.db, intent.id, ctx.runId);
      return result(item, forced ? 'forced' : 'adopted', { code: item.code, http_status: 404 });
    }
    if (isRadicaleError(err, 'precondition_failed')) {
      await clearIntent(ctx.db, intent.id);
      return conflictResult(item, 'TARGET_NEWER', { http_status: 412 });
    }
    if (!outcomeUnknown(err)) await clearIntent(ctx.db, intent.id);
    return result(item, 'failed', { http_status: status, error: shortError(err) });
  }
  try {
    await retireLedgerRow(ctx.db, intent.id, ctx.runId);
  } catch (err) {
    log.error({ href: l.href, err: shortError(err) }, 'cancellazione riuscita ma non registrata nel ledger');
    return result(item, 'failed', { http_status: 204, error: `esito non registrato: ${shortError(err)}` });
  }
  return result(item, forced ? 'forced' : 'done', { code: item.code, http_status: 204 });
}

// ─── Lock dello strumento ───────────────────────────────

/**
 * Esclusione fra i run e con i job shadow (contratto §5.3): l'esecutore tiene
 * `pg_advisory_lock(hashtext('cal-migration'))` per tutto il run. Se nessuna
 * sessione di questo database lo tiene (funzione chiamata fuori
 * dall'esecutore), lo si prende qui su una connessione riservata del pool
 * principale e lo si rilascia alla fine; se lo tiene un'altra sessione è
 * l'esecutore del run (l'indice unico cal_migration_runs_single_active
 * esclude un secondo run attivo).
 */
export async function withMigrationRunLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const reserve = (db as unknown as { reserve?: () => Promise<Db & { release(): void }> }).reserve;
  if (typeof reserve !== 'function') return fn();
  const conn = await reserve.call(db);
  let owned = false;
  try {
    const [row] = await conn<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${MIGRATION_LOCK_KEY})) AS ok`;
    owned = row?.ok === true;
    if (owned) {
      log.warn('lock cal-migration libero all\'avvio del run: preso dal modulo (esecutore senza lock?)');
    } else {
      const [held] = await conn<Array<{ held: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks l
          WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
            AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext(${MIGRATION_LOCK_KEY})::bigint
        ) AS held
      `;
      if (!held?.held) throw new MigrationError('INTERNAL', 'lock cal-migration in uno stato inatteso');
    }
    return await fn();
  } finally {
    if (owned) {
      await conn`SELECT pg_advisory_unlock(hashtext(${MIGRATION_LOCK_KEY}))`.catch((err: unknown) => {
        log.warn({ err: shortError(err) }, 'rilascio del lock cal-migration non riuscito: pg_advisory_unlock_all');
        return conn`SELECT pg_advisory_unlock_all()`.catch(() => undefined);
      });
    }
    conn.release();
  }
}

// ─── Run `apply` ───────────────────────────────

function normalizeScope(scope: MigrationScope | null | undefined): MigrationScope {
  const raw = Array.isArray(scope?.calendar_ids) ? scope.calendar_ids : [];
  if (raw.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    throw new MigrationError('VALIDATION_FAILED', 'Ambito: attesi id di calendario UUID');
  }
  const ids = [...new Set(raw.map((id) => id.toLowerCase()))].sort();
  return ids.length ? { calendar_ids: ids } : {};
}

interface NormalizedApplyParams {
  scope: MigrationScope;
  options: ApplyParams['options'];
  expected_plan_hash: string | null;
  force_item_ids: string[];
  force_codes: ConflictCode[];
  follow_up_verify: VerifyParams | null;
}

function normalizeApplyParams(params: Partial<ApplyParams> | null | undefined, planHash: string | null): NormalizedApplyParams {
  const p = params ?? {};
  const expected = p.expected_plan_hash === undefined ? planHash : p.expected_plan_hash;
  if (expected !== null && (typeof expected !== 'string' || !HASH_RE.test(expected))) {
    throw new MigrationError('VALIDATION_FAILED', 'expected_plan_hash: atteso uno sha256 esadecimale o null');
  }
  const ids = p.force_item_ids ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !ITEM_ID_RE.test(id))) {
    throw new MigrationError('VALIDATION_FAILED', 'force_item_ids: attesi id di righe del run d\'anteprima');
  }
  const codes = p.force_codes ?? [];
  if (!Array.isArray(codes) || codes.some((c) => !FORCEABLE_CONFLICTS.has(c as ConflictCode))) {
    throw new MigrationError('VALIDATION_FAILED', `force_codes: ammessi solo ${[...FORCEABLE_CONFLICTS].join(', ')}`);
  }
  return {
    scope: normalizeScope(p.scope),
    options: resolveMigrationOptions(p.options ?? null),
    expected_plan_hash: expected ?? null,
    force_item_ids: [...new Set(ids)],
    force_codes: [...new Set(codes)] as ConflictCode[],
    follow_up_verify: p.follow_up_verify ?? null,
  };
}

/** "Forza" per item: id delle righe 'object' del run d'anteprima → chiavi stabili degli item (planItemKey). */
async function resolveForce(db: Db, planRunId: string | null, params: NormalizedApplyParams): Promise<PlanInput['force']> {
  const codes = new Set<ConflictCode>(params.force_codes);
  if (params.force_item_ids.length === 0) return { itemKeys: new Set(), codes };
  if (!planRunId) throw new MigrationError('VALIDATION_FAILED', 'force_item_ids senza un run d\'anteprima di riferimento');
  const rows = await db<Array<{ id: string; calendar_id: string | null; href: string | null; legacy_key: string | null }>>`
    SELECT id::text AS id, calendar_id::text AS calendar_id, href, legacy_key
    FROM cal_migration_items
    WHERE run_id = ${planRunId}::uuid AND item_type = 'object' AND id = ANY(${params.force_item_ids}::bigint[])
  `;
  const found = new Set(rows.map((r) => r.id));
  const missing = params.force_item_ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new MigrationError('VALIDATION_FAILED', 'force_item_ids: righe non trovate nell\'anteprima', { missing: missing.slice(0, 20) });
  }
  const itemKeys = new Set<string>();
  for (const r of rows) {
    if (!r.calendar_id || !r.legacy_key) continue;
    itemKeys.add(planItemKey({ calendar_id: r.calendar_id, href: r.href ?? '', legacy_key: r.legacy_key as LegacyKey }));
  }
  return { itemKeys, codes };
}

/**
 * true se il run ha già lasciato tracce nel ledger: un intento registrato
 * (intent_run_id) o un esito completato, adottato o ritirato (last_run_id).
 * Ogni scrittura di runApply avviene dopo il controllo dell'hash del piano.
 */
async function runHasLedgerWrites(db: Db, runId: string): Promise<boolean> {
  const [row] = await db<Array<{ wrote: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM cal_migration_ledger WHERE last_run_id = ${runId}::uuid OR intent_run_id = ${runId}::uuid
    ) AS wrote
  `;
  return row?.wrote === true;
}

function severityOf(outcome: ApplyOutcome, code: string | null): 'info' | 'warning' | 'error' {
  if (outcome === 'failed') return 'error';
  if (outcome === 'conflict') return code === 'COLLECTION_MISSING' ? 'error' : 'warning';
  if (outcome === 'forced') return 'warning';
  return 'info';
}

/** Riga 'object' dell'apply: azione del piano, esito, codice e dettaglio senza dati personali. */
export function applyItemRow(item: PlanItem, executed: ExecutedItem, attempt: number): MigrationItemInput {
  const code = executed.code ?? item.code;
  return {
    item_type: 'object',
    calendar_id: item.calendar_id,
    collection_name: item.collection_name || null,
    href: item.href || null,
    legacy_key: item.legacy_key,
    action: item.action,
    outcome: executed.outcome,
    code,
    severity: severityOf(executed.outcome, code),
    forced: executed.outcome === 'forced',
    detail: {
      ...objectItemDetail(item),
      fields: executed.fields,
      etag_after: executed.etag_after,
      http_status: executed.http_status,
      error: executed.error,
      attempt,
    },
  };
}

/** Riassunto dell'apply con i conteggi per calendario e le riprese. */
export interface ApplyRunSummary extends ApplySummary {
  /** Tentativo dell'esecutore che ha prodotto i totali (> 1 dopo una ripresa). */
  attempt: number;
  /** Scritture riuscite nei tentativi precedenti dello stesso run (comprese in `writes`). */
  previous_attempt_writes: number;
  calendars: Array<{ calendar_id: string; collection_name: string; totals: Record<ApplyOutcome, number> }>;
  scope: MigrationScope;
}

/**
 * Ricalcola il piano con le opzioni e l'ambito del run d'anteprima, ferma se
 * expected_plan_hash differisce (PLAN_CHANGED, prima di qualsiasi scrittura),
 * poi esegue (testa del file).
 */
export async function runApply(ctx: MigrationRunContext<ApplyParams>): Promise<ApplySummary> {
  return withMigrationRunLock(ctx.db, () => applyLocked(ctx));
}

async function applyLocked(ctx: MigrationRunContext<ApplyParams>): Promise<ApplyRunSummary> {
  const started = Date.now();
  const params = normalizeApplyParams(ctx.params, ctx.planHash);
  const { client, principal } = requireRadicale();
  const guard = await createIdentityGuard({ db: ctx.db, client, principal });
  ctx.throwIfCancelled();

  // RESERVED_APP_PASSWORD blocca anche l'apply (il serializer non la vede: è dell'inventario).
  const apps = await inventoryAppPasswords(ctx.db, principal);
  if (apps.reserved.length > 0) {
    throw preconditionError('App-password attive con username riservato (caldes-*): revocale dall\'admin prima di applicare', ['PREFLIGHT_BLOCKING'], 'PRECONDITION_FAILED', {
      anomalies: ['RESERVED_APP_PASSWORD'],
      count: apps.reserved.length,
    });
  }
  const force = await resolveForce(ctx.db, ctx.planRunId, params);
  const forcing = force.itemKeys.size > 0 || force.codes.size > 0;

  const now = new Date();
  await ctx.progress({ phase: 'plan', message: 'Ricalcolo del piano dell\'anteprima' });
  const base = await buildPlan({ db: ctx.db, client, principal, mode: 'apply', scope: params.scope, options: params.options, now, signal: ctx.signal });
  ctx.throwIfCancelled();
  const blocking = [...new Set(base.serialization.anomalies.filter((a) => ANOMALY_DEFINITIONS[a.code].blocking).map((a) => a.code))].sort();
  if (blocking.length) {
    throw preconditionError(`Anomalie bloccanti da risolvere in PG prima di applicare: ${blocking.join(', ')}`, ['PREFLIGHT_BLOCKING'], 'PRECONDITION_FAILED', { anomalies: blocking });
  }
  if (params.expected_plan_hash !== null && base.hash !== params.expected_plan_hash) {
    // Ripresa dello stesso run (tentativo > 1, contratto §5.2) dopo che il tentativo precedente ha già
    // scritto: il piano differisce dall'anteprima per le scritture di questo stesso run (create fatte →
    // noop, intenti pendenti → adozione), quindi l'hash non è più confrontabile. Il controllo l'ha già
    // superato il primo tentativo, che scrive solo dopo; senza scritture precedenti vale come sempre.
    if (ctx.attempt > 1 && (await runHasLedgerWrites(ctx.db, ctx.runId))) {
      log.info({ runId: ctx.runId, attempt: ctx.attempt }, 'ripresa dell\'apply dopo scritture del tentativo precedente: hash dell\'anteprima non riconfrontato');
    } else {
      throw new MigrationError('PLAN_CHANGED', 'Il piano è cambiato dall\'anteprima: rigenera l\'anteprima e riprova', {
        expected_plan_hash: params.expected_plan_hash,
        plan_hash: base.hash,
      });
    }
  }
  // Con "forza" il piano si ricalcola con le conversioni dei conflitti scelti (l'hash confrontato resta quello senza forza).
  const plan = forcing
    ? await buildPlan({ db: ctx.db, client, principal, mode: 'apply', scope: params.scope, options: params.options, force, now, signal: ctx.signal })
    : base;
  ctx.throwIfCancelled();

  const execCtx: ExecuteContext = {
    db: ctx.db,
    client,
    principal,
    runId: ctx.runId,
    actor: ctx.actor,
    mode: 'apply',
    forced: forcing,
    signal: ctx.signal,
    throttle: migrationThrottle(),
    now: () => new Date(),
  };

  // Per collezione adozioni, create, update (e le righe senza scrittura); per ultime le delete.
  const groups = (items: PlanItem[]): PlanItem[][] => {
    const map = new Map<string, PlanItem[]>();
    for (const item of items) {
      const k = `${item.collection_name}|${item.calendar_id}`;
      const list = map.get(k) ?? [];
      list.push(item);
      map.set(k, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, list]) => list);
  };
  const phases = [groups(plan.items.filter((i) => i.action !== 'delete')), groups(plan.items.filter((i) => i.action === 'delete'))];
  const total = plan.items.length;

  // Chiavi spostate (decisione 8): la delete nella vecchia collezione aspetta la scrittura nella nuova.
  const movedSourceOutcome = new Map<string, ApplyOutcome>();
  const keysWithSource = new Set(plan.items.filter((i) => i.source).map((i) => i.legacy_key));

  const totals = emptyOutcomeCounts();
  const writes = { create: 0, update: 0, delete: 0 };
  const conflicts: ApplySummary['conflicts'] = {};
  const perCalendar = new Map<string, { calendar_id: string; collection_name: string; totals: Record<ApplyOutcome, number> }>();
  let plannedWrites = 0;
  let pending: MigrationItemInput[] = [];
  let done = 0;

  const flush = async (): Promise<void> => {
    while (pending.length) {
      const chunk = pending.slice(0, ROWS_CHUNK);
      await ctx.addItems(chunk);
      pending = pending.slice(chunk.length);
    }
  };

  const record = (item: PlanItem, executed: ExecutedItem): void => {
    totals[executed.outcome] += 1;
    if (isWriteAction(item.action)) plannedWrites += 1;
    if ((executed.outcome === 'done' || executed.outcome === 'forced') && isWriteAction(item.action)) {
      writes[item.action as 'create' | 'update' | 'delete'] += 1;
    }
    if (executed.outcome === 'conflict' && executed.code && CONFLICT_SET.has(executed.code)) {
      const c = executed.code as ConflictCode;
      conflicts[c] = (conflicts[c] ?? 0) + 1;
    }
    const calKey = item.calendar_id;
    const cal = perCalendar.get(calKey) ?? { calendar_id: item.calendar_id, collection_name: item.collection_name, totals: emptyOutcomeCounts() };
    cal.totals[executed.outcome] += 1;
    perCalendar.set(calKey, cal);
    if (item.source) movedSourceOutcome.set(item.legacy_key, executed.outcome);
    pending.push(applyItemRow(item, executed, ctx.attempt));
  };

  try {
    for (const phase of phases) {
      for (const group of phase) {
        ctx.throwIfCancelled();
        await guard.recheck({ force: true });
        const collection = group[0].collection_name;
        for (const item of group) {
          ctx.throwIfCancelled();
          await guard.recheck();
          let executed: ExecutedItem;
          if (item.action === 'delete' && !item.source && keysWithSource.has(item.legacy_key)) {
            const created = movedSourceOutcome.get(item.legacy_key);
            executed = created === 'done' || created === 'forced' || created === 'adopted' || created === 'noop'
              ? await executePlanItem(item, execCtx)
              : result(item, 'skipped', { code: item.code, error: 'spostamento non completato: la cancellazione nella collezione di origine attende la scrittura nella nuova' });
          } else {
            executed = await executePlanItem(item, execCtx);
          }
          record(item, executed);
          done += 1;
          if (pending.length >= ROWS_FLUSH_EVERY) await flush();
          await ctx.progress({
            phase: item.action === 'delete' ? 'delete' : 'write',
            done,
            total,
            calendar_id: item.calendar_id,
            message: `${item.action === 'delete' ? 'Cancellazioni' : 'Scrittura'} in ${collection || 'collezione'}`,
          });
        }
      }
    }
  } finally {
    // Righe già eseguite salvate anche con un annullamento o un errore: il wizard vede cosa è successo.
    await flush().catch((err: unknown) => log.error({ err: shortError(err) }, 'righe dell\'apply non salvate'));
  }

  let previousWrites = 0;
  if (ctx.attempt > 1) {
    const rows = await ctx.db<Array<{ action: string; n: number }>>`
      SELECT action, count(*)::int AS n FROM cal_migration_items
      WHERE run_id = ${ctx.runId}::uuid AND item_type = 'object' AND outcome IN ('done', 'forced')
        AND action IN ('create', 'update', 'delete')
        AND COALESCE((detail->>'attempt')::int, 1) < ${ctx.attempt}
      GROUP BY action
    `;
    for (const r of rows) {
      writes[r.action as 'create' | 'update' | 'delete'] += r.n;
      previousWrites += r.n;
    }
  }

  const writesDone = writes.create + writes.update + writes.delete;
  const conflictCount = Object.values(conflicts).reduce((a, b) => a + (b ?? 0), 0);
  await ctx.progress({ phase: 'done', done: total, total, message: 'Apply concluso' });
  return {
    plan_hash: base.hash,
    expected_plan_hash: params.expected_plan_hash,
    totals,
    writes,
    conflicts,
    failed: totals.failed,
    adopted: totals.adopted,
    forced: totals.forced,
    duration_ms: Date.now() - started,
    zero_writes: writesDone === 0 && plannedWrites === 0 && conflictCount === 0 && totals.failed === 0,
    attempt: ctx.attempt,
    previous_attempt_writes: previousWrites,
    calendars: [...perCalendar.values()].sort((a, b) => a.collection_name.localeCompare(b.collection_name) || a.calendar_id.localeCompare(b.calendar_id)),
    scope: params.scope,
  };
}
