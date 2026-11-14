/**
 * Id persistenti degli oggetti di calendario (fase F2 del passaggio a
 * Radicale; design §5 "Gli id" e "getEvent", contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §2.2 e §4.6).
 *
 * `cal_object_ids` (migrazione 163) associa (calendar_id, href,
 * recurrence_key) a un UUID stabile: l'id della risorsa (recurrence_key '')
 * è `cal_objects.id`, quello di un override è `cal_components.id` e delle sue
 * occorrenze. La tabella è persistente: sopravvive al rebuild dell'indice, ai
 * MOVE e alle cancellazioni (le righe si "ritirano" con retired_at e tornano
 * attive se l'href ricompare), così gli id che l'API ha già restituito
 * (list_events, admin, MCP) restano validi.
 *
 * Allocazione (allocateObjectIds), nell'ordine:
 *  1. riga esistente per (calendar_id, href, recurrence_key), riattivata se
 *     ritirata;
 *  2. MOVE: riga della risorsa ritirata da meno di 30 giorni con lo stesso UID
 *     in un'altra posizione (altra collezione, o altro href) → ri-chiavata su
 *     (calendar_id, href) con lo stesso id, insieme alle righe dei suoi
 *     override. Mai da o verso un'iscrizione (fonte remota: un evento copiato
 *     da un feed in un calendario proprio non eredita l'id del feed);
 *  3. X-CALDES-LEGACY-ID del componente, se è un UUID non ancora usato né
 *     come id né come legacy_event_id: id = quello, legacy_event_id = quello
 *     (oggetti migrati, ripristino dopo la perdita del database);
 *  4. UUID v4, oppure con idStrategy 'deterministic' (rebuild con la tabella
 *     vuota, scenario B del design §16.3) uuidv5(UID|recurrence_key).
 *
 * Tutte le scritture avvengono SOLO dentro la transazione dell'indicizzatore
 * (che tiene il lock cal-sync della collezione), salvo reserveObjectId (F3,
 * proiezioni). Le INSERT usano ON CONFLICT DO NOTHING: un conflitto (riga
 * nata nel frattempo da reserveObjectId, id deterministico già usato da un
 * UID duplicato in un'altra collezione) non abortisce mai la transazione
 * dell'indicizzatore, si risolve rileggendo o scegliendo un altro id.
 *
 * Il resolver (resolveEventRef) implementa i quattro passi di getEvent del
 * design §5: id (o legacy_event_id), UID esatto preferendo le collezioni
 * scrivibili, legacy_uid, UID con o senza @dominio. Corregge il bug legacy per
 * cui un UID con la forma di un UUID veniva cercato solo come id (design §14).
 */

import { createHash, randomUUID } from 'node:crypto';
import { INDEX_TIMING, MASTER_RECURRENCE_KEY, RECURRENCE_KEY_RE } from '../index-model';
import type { Db } from './policy';

// ─── Tipi del contratto (f2-modules §4.6) ───────────────────

export interface ObjectIdRequest {
  /** Nome della risorsa nella collezione (decodificato), es. `abc.ics`. */
  href: string;
  /** UID della risorsa (null se il testo non si parsa). */
  uid: string | null;
  /** recurrence_key degli override presenti nella risorsa (mai ''). */
  overrideKeys: readonly string[];
  /** X-CALDES-LEGACY-ID del master, se presente. */
  legacyId?: string | null;
}

export interface AllocatedIds {
  /** Id della risorsa (recurrence_key ''): cal_objects.id. */
  objectId: string;
  /** recurrence_key → id, compresa la chiave '' (= objectId) e una voce per ogni override richiesto. */
  componentIds: ReadonlyMap<string, string>;
  /** Posizione precedente se l'id è stato ri-chiavato da un MOVE. */
  movedFrom: { calendarId: string; href: string } | null;
}

export type EventRefResolution =
  | { kind: 'found'; id: string; objectId: string; calendarId: string; href: string; recurrenceKey: string }
  | { kind: 'ambiguous'; candidates: Array<{ id: string; calendarId: string; collectionName: string; href: string }> }
  | { kind: 'not_found' };

/** reserveObjectId con un id esplicito già usato da un'altra riga. */
export class ObjectIdConflictError extends Error {
  readonly code = 'OBJECT_ID_CONFLICT' as const;
  constructor(readonly id: string, message: string) {
    super(message);
    this.name = 'ObjectIdConflictError';
  }
}

// ─── Costanti e validazione ───────────────────

/**
 * Namespace degli uuidv5 deterministici (rebuild con cal_object_ids vuota).
 * Valore fisso e congelato: cambiarlo cambierebbe gli id ricostruiti.
 */
export const CALDES_OBJECT_ID_NAMESPACE = '5f0c2b7e-9a41-4d6c-8e3b-2a7d1c9f4e60';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Stesso CHECK di cal_object_ids.href: 1-1024 byte, niente '/', '\' né controlli.
// eslint-disable-next-line no-control-regex
const HREF_FORBIDDEN_RE = /[/\\\u0001-\u001f\u007f]/;
const MAX_REF_LENGTH = 1024;

/** Ruoli delle collezioni scrivibili dall'API e dai device (preferite dal resolver). */
const RANK_WRITABLE_ROLES = new Set(['user', 'tasks']);
/** Ruoli in sola lettura per i device ma scrivibili dall'API (design §8). */
const RANK_API_WRITABLE_ROLES = new Set(['bookings', 'holidays', 'deadlines']);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function assertHref(href: string): void {
  if (typeof href !== 'string' || !href || Buffer.byteLength(href, 'utf8') > 1024 || HREF_FORBIDDEN_RE.test(href)) {
    throw new TypeError(`href non valido per cal_object_ids: ${JSON.stringify(href)}`);
  }
}

function assertOverrideKey(key: string): void {
  if (typeof key !== 'string' || key === MASTER_RECURRENCE_KEY || !RECURRENCE_KEY_RE.test(key)) {
    throw new TypeError(`recurrence_key di override non valida: ${JSON.stringify(key)}`);
  }
}

// ─── uuidv5 ───────────────────

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** UUID v5 (RFC 9562 §5.5): SHA-1 di namespace + nome, versione 5, variante RFC. */
export function uuidV5(name: string, namespace: string = CALDES_OBJECT_ID_NAMESPACE): string {
  if (!isUuid(namespace)) throw new TypeError(`namespace non valido: ${JSON.stringify(namespace)}`);
  const hash = createHash('sha1').update(uuidBytes(namespace)).update(Buffer.from(name, 'utf8')).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/**
 * Id deterministico di (UID, recurrence_key): lo stesso oggetto riceve lo
 * stesso id a ogni ricostruzione da zero (contratto §2.2, idStrategy
 * 'deterministic').
 */
export function deterministicObjectId(uid: string, recurrenceKey: string): string {
  return uuidV5(`${uid}|${recurrenceKey}`);
}

/**
 * Candidati deterministici in ordine di preferenza: (UID, chiave), poi
 * qualificato con la posizione (lo stesso UID in due collezioni, come gli
 * inviti duplicati in lavoro e personale), poi la sola posizione se l'UID
 * manca. L'ultimo ripiego, se anche questi sono occupati, è un UUID v4.
 */
function deterministicCandidates(calendarId: string, href: string, uid: string | null, key: string): string[] {
  const where = `${calendarId}/${href}`;
  return uid ? [deterministicObjectId(uid, key), uuidV5(`${uid}|${key}|${where}`)] : [uuidV5(`|${key}|${where}`)];
}

// ─── Allocazione ───────────────────

interface IdRow {
  id: string;
  href: string;
  recurrence_key: string;
  uid: string | null;
  retired_at: Date | null;
}

interface PendingInsert {
  href: string;
  key: string;
  uid: string | null;
  legacyEventId: string | null;
  /** Id da provare nell'ordine; esaurita la lista si usa un UUID v4. */
  candidates: string[];
}

/**
 * Assegna gli id alle risorse indicizzate in questa transazione (contratto
 * §2.2). Va chiamata SOLO dentro la transazione dell'indicizzatore, che tiene
 * il lock della collezione: nessun altro scrittore dell'indice tocca le
 * stesse righe. Restituisce una voce per ogni href richiesto. Lancia
 * TypeError per href o chiavi fuori formato (errore di programmazione).
 */
export async function allocateObjectIds(
  tx: Db,
  calendarId: string,
  items: readonly ObjectIdRequest[],
  opts: { now: Date; idStrategy?: 'random' | 'deterministic' },
): Promise<Map<string, AllocatedIds>> {
  const cal = calendarId.toLowerCase();
  const strategy = opts.idStrategy ?? 'random';
  const out = new Map<string, AllocatedIds>();
  if (!items.length) return out;

  const byHref = new Map<string, ObjectIdRequest>();
  for (const item of items) {
    assertHref(item.href);
    for (const key of item.overrideKeys) assertOverrideKey(key);
    if (byHref.has(item.href)) throw new TypeError(`href ripetuto nella stessa allocazione: ${JSON.stringify(item.href)}`);
    byHref.set(item.href, item);
  }
  const hrefs = [...byHref.keys()];

  // 1. Righe esistenti (risorse e override) per gli href richiesti.
  const existingRows: IdRow[] = await tx`
    SELECT id, href, recurrence_key, uid, retired_at
    FROM cal_object_ids
    WHERE calendar_id = ${cal} AND href = ANY(${hrefs}::text[])
  `;
  const existing = new Map<string, Map<string, IdRow>>();
  for (const row of existingRows) {
    let keys = existing.get(row.href);
    if (!keys) existing.set(row.href, (keys = new Map()));
    keys.set(row.recurrence_key, row);
  }

  const masterIds = new Map<string, string>();
  const movedFrom = new Map<string, { calendarId: string; href: string }>();
  const touch: Array<{ id: string; uid: string | null }> = [];

  for (const [href, item] of byHref) {
    const row = existing.get(href)?.get(MASTER_RECURRENCE_KEY);
    if (!row) continue;
    masterIds.set(href, row.id);
    if (row.retired_at !== null || row.uid !== item.uid) touch.push({ id: row.id, uid: item.uid });
  }

  // 2. MOVE: UID ritirato altrove da meno di 30 giorni.
  const withoutMaster = [...byHref.values()].filter((i) => !masterIds.has(i.href));
  const moveUids = [...new Set(withoutMaster.map((i) => i.uid).filter((u): u is string => !!u))];
  if (moveUids.length) {
    const [target]: Array<{ role: string }> = await tx`SELECT role FROM calendars WHERE id = ${cal}`;
    if (target && target.role !== 'subscription') {
      const since = new Date(opts.now.getTime() - INDEX_TIMING.moveWindowMs);
      const candidates: Array<{ id: string; calendar_id: string; href: string; uid: string }> = await tx`
        SELECT DISTINCT ON (r.uid) r.id, r.calendar_id, r.href, r.uid
        FROM cal_object_ids r
        JOIN calendars c ON c.id = r.calendar_id
        WHERE r.recurrence_key = ''
          AND r.retired_at IS NOT NULL
          AND r.retired_at > ${since}
          AND r.uid = ANY(${moveUids}::text[])
          AND c.role <> 'subscription'
        ORDER BY r.uid, r.retired_at DESC, r.id
      `;
      const byUid = new Map(candidates.map((c) => [c.uid, c]));
      for (const item of withoutMaster) {
        const from = item.uid ? byUid.get(item.uid) : undefined;
        if (!from) continue;
        byUid.delete(item.uid as string); // un solo erede per riga ritirata
        // Condizioni ripetute nella UPDATE: con READ COMMITTED una sync
        // concorrente di un'altra collezione che ha appena adottato la stessa
        // riga la fa trovare non più ritirata (0 righe → si prosegue).
        const moved: Array<{ id: string }> = await tx`
          UPDATE cal_object_ids
          SET calendar_id = ${cal}, href = ${item.href}, uid = ${item.uid}, retired_at = NULL
          WHERE id = ${from.id} AND retired_at IS NOT NULL
            AND calendar_id = ${from.calendar_id} AND href = ${from.href} AND recurrence_key = ''
          RETURNING id
        `;
        if (!moved.length) continue;
        // Gli override seguono la risorsa (restano ritirati finché non ricompaiono).
        await tx`
          UPDATE cal_object_ids o
          SET calendar_id = ${cal}, href = ${item.href}
          WHERE o.calendar_id = ${from.calendar_id} AND o.href = ${from.href} AND o.recurrence_key <> ''
            AND NOT EXISTS (
              SELECT 1 FROM cal_object_ids x
              WHERE x.calendar_id = ${cal} AND x.href = ${item.href} AND x.recurrence_key = o.recurrence_key
            )
        `;
        masterIds.set(item.href, from.id);
        movedFrom.set(item.href, { calendarId: from.calendar_id, href: from.href });
        // Le righe degli override ri-chiavate valgono ora per questo href.
        const rekeyed: IdRow[] = await tx`
          SELECT id, href, recurrence_key, uid, retired_at FROM cal_object_ids
          WHERE calendar_id = ${cal} AND href = ${item.href}
        `;
        const keys = new Map<string, IdRow>();
        for (const row of rekeyed) keys.set(row.recurrence_key, row);
        existing.set(item.href, keys);
      }
    }
  }

  // 3-4. Nuove righe delle risorse: X-CALDES-LEGACY-ID libero, poi v4 o v5.
  const stillMissing = [...byHref.values()].filter((i) => !masterIds.has(i.href));
  const legacyCandidates = [...new Set(stillMissing.map((i) => i.legacyId?.toLowerCase()).filter((l): l is string => isUuid(l)))];
  const usedLegacy = new Set<string>();
  if (legacyCandidates.length) {
    const used: Array<{ id: string; legacy_event_id: string | null }> = await tx`
      SELECT id, legacy_event_id FROM cal_object_ids
      WHERE id = ANY(${legacyCandidates}::uuid[]) OR legacy_event_id = ANY(${legacyCandidates}::uuid[])
    `;
    for (const row of used) {
      usedLegacy.add(String(row.id).toLowerCase());
      if (row.legacy_event_id) usedLegacy.add(String(row.legacy_event_id).toLowerCase());
    }
  }
  const masterInserts: PendingInsert[] = [];
  for (const item of stillMissing) {
    const legacy = item.legacyId?.toLowerCase();
    const useLegacy = isUuid(legacy) && !usedLegacy.has(legacy);
    if (useLegacy) usedLegacy.add(legacy); // due risorse con lo stesso legacy id: solo la prima
    masterInserts.push({
      href: item.href,
      key: MASTER_RECURRENCE_KEY,
      uid: item.uid,
      legacyEventId: useLegacy ? legacy : null,
      candidates: useLegacy
        ? [legacy]
        : strategy === 'deterministic'
          ? deterministicCandidates(cal, item.href, item.uid, MASTER_RECURRENCE_KEY)
          : [],
    });
  }
  for (const [href, id] of await insertIds(tx, cal, masterInserts)) masterIds.set(href, id);

  // Riattivazione e UID aggiornato delle righe esistenti (risorse).
  await touchRows(tx, touch);

  // Override: riga esistente (riattivata), altrimenti nuova.
  const componentIds = new Map<string, Map<string, string>>();
  const overrideTouch: Array<{ id: string; uid: string | null }> = [];
  const overrideInserts: PendingInsert[] = [];
  for (const [href, item] of byHref) {
    const ids = new Map<string, string>([[MASTER_RECURRENCE_KEY, masterIds.get(href) as string]]);
    componentIds.set(href, ids);
    const keys = existing.get(href);
    for (const key of new Set(item.overrideKeys)) {
      const row = keys?.get(key);
      if (row) {
        ids.set(key, row.id);
        if (row.retired_at !== null || row.uid !== item.uid) overrideTouch.push({ id: row.id, uid: item.uid });
      } else {
        overrideInserts.push({
          href,
          key,
          uid: item.uid,
          legacyEventId: null,
          candidates: strategy === 'deterministic' ? deterministicCandidates(cal, href, item.uid, key) : [],
        });
      }
    }
  }
  await touchRows(tx, overrideTouch);
  const overrideIds = await insertIds(tx, cal, overrideInserts, true);
  for (const p of overrideInserts) {
    const id = overrideIds.get(`${p.href}\u0000${p.key}`);
    if (id) componentIds.get(p.href)?.set(p.key, id);
  }

  for (const href of hrefs) {
    out.set(href, {
      objectId: masterIds.get(href) as string,
      componentIds: componentIds.get(href) as Map<string, string>,
      movedFrom: movedFrom.get(href) ?? null,
    });
  }
  return out;
}

/** Riattiva le righe ritirate e aggiorna l'UID (una UPDATE per lotto). */
async function touchRows(tx: Db, rows: ReadonlyArray<{ id: string; uid: string | null }>): Promise<void> {
  if (!rows.length) return;
  await tx`
    UPDATE cal_object_ids o
    SET retired_at = NULL, uid = v.uid
    FROM unnest(${rows.map((r) => r.id)}::uuid[], ${rows.map((r) => r.uid)}::text[]) AS v(id, uid)
    WHERE o.id = v.id AND (o.retired_at IS NOT NULL OR o.uid IS DISTINCT FROM v.uid)
  `;
}

/**
 * INSERT a lotti con ON CONFLICT DO NOTHING. Una riga non inserita viene
 * risolta rileggendo (la riga di quella posizione è nata nel frattempo) o
 * riprovando con il candidato successivo (id già occupato), fino all'UUID v4.
 * Chiave del risultato: href (risorse) oppure `href\0key` (override).
 */
async function insertIds(tx: Db, calendarId: string, pending: PendingInsert[], keyed = false): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const keyOf = (p: { href: string; key: string }): string => (keyed ? `${p.href}\u0000${p.key}` : p.href);
  let queue = pending.map((p) => ({ ...p, candidates: [...p.candidates] }));
  for (let round = 0; queue.length && round < 6; round++) {
    const ids = queue.map((p) => p.candidates.shift() ?? randomUUID());
    const inserted: Array<{ id: string; href: string; recurrence_key: string }> = await tx`
      INSERT INTO cal_object_ids (id, calendar_id, href, recurrence_key, uid, legacy_event_id)
      SELECT v.id, ${calendarId}::uuid, v.href, v.key, v.uid, v.legacy
      FROM unnest(
        ${ids}::uuid[], ${queue.map((p) => p.href)}::text[], ${queue.map((p) => p.key)}::text[],
        ${queue.map((p) => p.uid)}::text[], ${queue.map((p) => p.legacyEventId)}::uuid[]
      ) AS v(id, href, key, uid, legacy)
      ON CONFLICT DO NOTHING
      RETURNING id, href, recurrence_key
    `;
    for (const row of inserted) result.set(keyOf({ href: row.href, key: row.recurrence_key }), row.id);
    const missing = queue.filter((p) => !result.has(keyOf(p)));
    if (!missing.length) {
      queue = [];
      break;
    }
    // Conflitto sulla posizione: la riga esiste già (reserveObjectId concorrente).
    const present: IdRow[] = await tx`
      SELECT id, href, recurrence_key, uid, retired_at FROM cal_object_ids
      WHERE calendar_id = ${calendarId}
        AND (href, recurrence_key) IN (
          SELECT * FROM unnest(${missing.map((p) => p.href)}::text[], ${missing.map((p) => p.key)}::text[])
        )
    `;
    for (const row of present) result.set(keyOf({ href: row.href, key: row.recurrence_key }), row.id);
    if (present.length) await touchRows(tx, present.map((r) => ({ id: r.id, uid: missing.find((m) => m.href === r.href)?.uid ?? r.uid })));
    // Conflitto sull'id: si riprova con il candidato successivo (senza legacy_event_id).
    queue = missing.filter((p) => !result.has(keyOf(p))).map((p) => ({ ...p, legacyEventId: null }));
  }
  if (queue.length) {
    // Sei tentativi di UUID v4 tutti in conflitto non accadono: è un errore vero.
    throw new Error(`allocazione degli id non riuscita per ${queue.length} risorse di ${calendarId}`);
  }
  return result;
}

/**
 * Ritira le righe (risorsa e override) degli href cancellati: restano per i
 * MOVE, le versioni e il cestino, e tornano attive se l'href ricompare.
 */
export async function retireObjectIds(tx: Db, calendarId: string, hrefs: readonly string[], now: Date): Promise<void> {
  if (!hrefs.length) return;
  await tx`
    UPDATE cal_object_ids SET retired_at = ${now}
    WHERE calendar_id = ${calendarId.toLowerCase()} AND href = ANY(${[...hrefs]}::text[]) AND retired_at IS NULL
  `;
}

/** Ritira gli override di una risorsa che non compaiono più fra `keepKeys`. */
export async function retireOverrideIds(tx: Db, calendarId: string, href: string, keepKeys: readonly string[], now: Date): Promise<void> {
  await tx`
    UPDATE cal_object_ids SET retired_at = ${now}
    WHERE calendar_id = ${calendarId.toLowerCase()} AND href = ${href}
      AND recurrence_key <> '' AND recurrence_key <> ALL(${[...keepKeys]}::text[])
      AND retired_at IS NULL
  `;
}

/**
 * Prenota (o ritrova) l'id di una posizione prima che l'oggetto esista in
 * Radicale (F3: migrazione e proiezioni legate alle righe legacy). Una riga
 * già presente vince: si completano solo i campi legacy e l'UID ancora vuoti,
 * mai sovrascritti. Con `id` esplicito già usato da un'altra posizione lancia
 * ObjectIdConflictError.
 */
export async function reserveObjectId(
  tx: Db,
  input: { calendarId: string; href: string; recurrenceKey?: string; id?: string; uid?: string | null; legacyEventId?: string | null; legacyUid?: string | null },
): Promise<string> {
  const cal = input.calendarId.toLowerCase();
  const key = input.recurrenceKey ?? MASTER_RECURRENCE_KEY;
  assertHref(input.href);
  if (key !== MASTER_RECURRENCE_KEY) assertOverrideKey(key);
  if (input.id !== undefined && !isUuid(input.id)) throw new TypeError(`id non valido: ${JSON.stringify(input.id)}`);
  if (input.legacyEventId != null && !isUuid(input.legacyEventId)) throw new TypeError(`legacy_event_id non valido: ${JSON.stringify(input.legacyEventId)}`);
  const uid = input.uid ?? null;
  const legacyEventId = input.legacyEventId?.toLowerCase() ?? null;
  const legacyUid = input.legacyUid ?? null;

  const fill = async (): Promise<string | null> => {
    const rows: Array<{ id: string }> = await tx`
      UPDATE cal_object_ids
      SET uid = COALESCE(uid, ${uid}),
          legacy_uid = COALESCE(legacy_uid, ${legacyUid}),
          legacy_event_id = COALESCE(legacy_event_id, ${legacyEventId}::uuid)
      WHERE calendar_id = ${cal} AND href = ${input.href} AND recurrence_key = ${key}
      RETURNING id
    `;
    return rows[0]?.id ?? null;
  };
  const found = await fill();
  if (found) return found;

  const id = (input.id ?? randomUUID()).toLowerCase();
  const inserted: Array<{ id: string }> = await tx`
    INSERT INTO cal_object_ids (id, calendar_id, href, recurrence_key, uid, legacy_event_id, legacy_uid)
    VALUES (${id}, ${cal}, ${input.href}, ${key}, ${uid}, ${legacyEventId}, ${legacyUid})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (inserted.length) return inserted[0].id;
  // Posizione nata nel frattempo, oppure id/legacy_event_id già usati altrove.
  const again = await fill();
  if (again) return again;
  throw new ObjectIdConflictError(id, `id ${id} (o legacy_event_id ${legacyEventId ?? '-'}) già usato da un'altra posizione`);
}

// ─── Resolver (getEvent, design §5) ───────────────────

interface RefRow {
  id: string;
  calendar_id: string;
  href: string;
  recurrence_key: string;
  role: string;
  collection_name: string | null;
  object_id: string | null;
}

function rankOf(role: string): number {
  if (RANK_WRITABLE_ROLES.has(role)) return 0;
  if (RANK_API_WRITABLE_ROLES.has(role)) return 1;
  return 2;
}

/** Sceglie fra più risorse: vince la collezione più scrivibile; a pari rango è ambiguo. */
function pick(rows: RefRow[]): EventRefResolution | null {
  if (!rows.length) return null;
  const best = Math.min(...rows.map((r) => rankOf(r.role)));
  const top = rows.filter((r) => rankOf(r.role) === best);
  if (top.length === 1) return found(top[0]);
  return {
    kind: 'ambiguous',
    candidates: rows
      .slice()
      .sort((a, b) => rankOf(a.role) - rankOf(b.role) || (a.collection_name ?? '').localeCompare(b.collection_name ?? '') || a.href.localeCompare(b.href))
      .map((r) => ({ id: r.id, calendarId: r.calendar_id, collectionName: r.collection_name ?? '', href: r.href })),
  };
}

function found(row: RefRow): EventRefResolution {
  return {
    kind: 'found',
    id: row.id,
    objectId: row.object_id ?? row.id,
    calendarId: row.calendar_id,
    href: row.href,
    recurrenceKey: row.recurrence_key,
  };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * getEvent(id_or_uid) del design §5, sulle sole righe attive (non ritirate)
 * di collezioni attive:
 *  1. id di cal_object_ids (o legacy_event_id): risorsa o override;
 *  2. UID esatto della risorsa, preferendo le collezioni scrivibili (user e
 *     tasks, poi bookings/holidays/deadlines, poi iscrizioni); a pari rango
 *     → ambiguous con i candidati;
 *  3. legacy_uid;
 *  4. UID con o senza @dominio (`abc` trova `abc@caldes.it`, `abc@x` trova `abc`).
 * Usa il db del chiamante (pool principale o transazione).
 */
export async function resolveEventRef(db: Db, idOrUid: string): Promise<EventRefResolution> {
  const ref = typeof idOrUid === 'string' ? idOrUid.trim() : '';
  if (!ref || ref.length > MAX_REF_LENGTH) return { kind: 'not_found' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- frammento di postgres-js (stesso pattern di src/)
  const select = (where: any): Promise<RefRow[]> => db<RefRow[]>`
    SELECT r.id, r.calendar_id, r.href, r.recurrence_key, c.role, c.collection_name, m.id AS object_id
    FROM cal_object_ids r
    JOIN calendars c ON c.id = r.calendar_id AND c.lifecycle = 'active'
    LEFT JOIN cal_object_ids m ON m.calendar_id = r.calendar_id AND m.href = r.href AND m.recurrence_key = ''
    WHERE r.retired_at IS NULL AND ${where}
    ORDER BY r.calendar_id, r.href, r.recurrence_key
    LIMIT 50
  `;

  // 1. Id (anche un override) o legacy_event_id.
  if (isUuid(ref)) {
    const lower = ref.toLowerCase();
    const rows = await select(db`(r.id = ${lower}::uuid OR r.legacy_event_id = ${lower}::uuid)`);
    const exact = rows.find((r) => r.id === lower) ?? rows[0];
    if (exact) return found(exact);
  }

  // 2. UID esatto.
  const byUid = pick(await select(db`r.recurrence_key = '' AND r.uid = ${ref}`));
  if (byUid) return byUid;

  // 3. legacy_uid.
  const byLegacy = pick(await select(db`r.recurrence_key = '' AND r.legacy_uid = ${ref}`));
  if (byLegacy) return byLegacy;

  // 4. Con o senza @dominio.
  const at = ref.indexOf('@');
  if (at > 0) {
    const local = ref.slice(0, at);
    const rows = await select(db`r.recurrence_key = '' AND (r.uid = ${local} OR r.legacy_uid = ${local})`);
    const res = pick(rows);
    if (res) return res;
  } else if (at < 0) {
    const pattern = `${escapeLike(ref)}@%`;
    const rows = await select(db`r.recurrence_key = '' AND (r.uid LIKE ${pattern} OR r.legacy_uid LIKE ${pattern})`);
    const res = pick(rows);
    if (res) return res;
  }
  return { kind: 'not_found' };
}
