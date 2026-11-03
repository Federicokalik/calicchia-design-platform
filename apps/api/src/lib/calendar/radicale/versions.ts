/**
 * Versioni degli oggetti indicizzati (fase F2 del passaggio a Radicale;
 * migrazione 163, tabella cal_object_versions; design §1 invariante 3, §4,
 * §6.2 passo 9, §16.4; contratto dei moduli
 * docs/calendar-radicale/contracts/f2-modules.md §2.1 e §5.6).
 *
 * Ogni versione è il testo di una risorsa Radicale così come l'indicizzatore
 * l'ha visto (creazione, modifica, cancellazione con l'ultimo testo noto,
 * ripristino), con l'esito del parse (`valid`): la più recente valida è
 * "l'ultima versione buona" su cui un oggetto in quarantena continua a
 * bloccare (design §6.5). Le versioni non esistono per le iscrizioni
 * (role=subscription: fonte remota, revisione red-team punto 2).
 *
 * Scritture:
 *  - recordVersion() SOLO dentro la transazione dell'indicizzatore (lo stesso
 *    tx che aggiorna cal_objects), così testo, versione e last_good_version_id
 *    non divergono mai;
 *  - purgeExpiredVersions() dall'auditor notturno (retention 90 giorni), di
 *    default sul pool calendario dedicato (comandi brevi in autocommit);
 *  - purgeVersionsForErasure() dalla cancellazione GDPR (F3).
 *
 * Retention: 90 giorni (INDEX_TIMING.versionsRetentionMs), ma la purge non
 * tocca mai la versione indicata da cal_objects.last_good_version_id: per un
 * oggetto in quarantena è l'ultima buona che blocca al posto del testo rotto
 * (contratto §5.6); per un oggetto sano è il testo corrente, già presente
 * nell'indice e nel volume, quindi tenerlo non allunga la conservazione dei
 * dati e permette di ricostruire le occorrenze stale anche dopo un rebuild.
 *
 * cal_object_versions è persistente (gruppo S del backup JSON: esportata,
 * mai ripristinata) e sopravvive al rebuild dell'indice.
 */

import { calSql } from '../../../db';
import { INDEX_TIMING, VERSION_CHANGE_KINDS, type CalObjectVersionRow, type VersionChangeKind } from '../index-model';
import type { Db } from './policy';

/** Righe cancellate per giro dalla purge: transazioni brevi anche con molte versioni scadute. */
const PURGE_BATCH = 5_000;

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface RecordVersionInput {
  /** cal_object_ids.id della risorsa (recurrence_key ''). */
  objectId: string;
  calendarId: string;
  href: string;
  etag: string | null;
  /** Testo della versione; null ammesso solo per change_kind 'delete' (testo non più noto). */
  raw: string | null;
  sha256: string | null;
  semanticFp: string | null;
  changeKind: VersionChangeKind;
  /** Il testo si parsava ed espandeva: utilizzabile come ultima versione buona. */
  valid: boolean;
  /** device, admin:<id>, mcp, agent, system, sync, rebuild, restore... */
  actor: string | null;
}

/**
 * Registra una versione e ne restituisce l'id. Da chiamare SOLO dentro la
 * transazione dell'indicizzatore (`tx`). Lancia per un input fuori contratto
 * (change_kind sconosciuto, sha non esadecimale, testo assente fuori da una
 * cancellazione): sono difetti del chiamante, non dati da tollerare.
 */
export async function recordVersion(tx: Db, v: RecordVersionInput): Promise<string> {
  if (!VERSION_CHANGE_KINDS.includes(v.changeKind)) throw new Error(`recordVersion: change_kind non valido: ${JSON.stringify(v.changeKind)}`);
  if (v.sha256 !== null && !SHA256_RE.test(v.sha256)) throw new Error('recordVersion: content_sha256 non è uno SHA-256 esadecimale minuscolo');
  if (v.raw === null && v.changeKind !== 'delete') throw new Error('recordVersion: testo assente in una versione diversa da delete');
  if (v.raw === null && v.valid) throw new Error('recordVersion: una versione senza testo non può essere valida');
  const [row] = await tx<Array<{ id: string }>>`
    INSERT INTO cal_object_versions
      (object_id, calendar_id, href, etag, raw_ics, content_sha256, semantic_fp, change_kind, valid, actor)
    VALUES
      (${v.objectId}, ${v.calendarId}, ${v.href}, ${v.etag}, ${v.raw}, ${v.sha256}, ${v.semanticFp},
       ${v.changeKind}, ${v.valid}, ${v.actor})
    RETURNING id
  `;
  return row.id;
}

/** Versioni di un oggetto, dalla più recente (cronologia dell'admin, F6). */
export async function listObjectVersions(db: Db, objectId: string, opts: { limit?: number } = {}): Promise<CalObjectVersionRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), 500);
  const rows = await db<CalObjectVersionRow[]>`
    SELECT id, object_id, calendar_id, href, etag, raw_ics, content_sha256, semantic_fp, change_kind, valid, actor, created_at
    FROM cal_object_versions
    WHERE object_id = ${objectId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;
  return Array.from(rows);
}

/** Una versione per id, o null. */
export async function getObjectVersion(db: Db, versionId: string): Promise<CalObjectVersionRow | null> {
  const rows = await db<CalObjectVersionRow[]>`
    SELECT id, object_id, calendar_id, href, etag, raw_ics, content_sha256, semantic_fp, change_kind, valid, actor, created_at
    FROM cal_object_versions
    WHERE id = ${versionId}
  `;
  return rows[0] ?? null;
}

/** Versione valida più recente di un oggetto (ultima buona), o null. Le cancellazioni non contano. */
export async function lastValidVersion(db: Db, objectId: string): Promise<CalObjectVersionRow | null> {
  const rows = await db<CalObjectVersionRow[]>`
    SELECT id, object_id, calendar_id, href, etag, raw_ics, content_sha256, semantic_fp, change_kind, valid, actor, created_at
    FROM cal_object_versions
    WHERE object_id = ${objectId} AND valid AND change_kind <> 'delete' AND raw_ics IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Ultima versione registrata di un oggetto, per decidere se il testo nuovo merita una versione. */
export interface LatestVersionInfo {
  id: string;
  contentSha256: string | null;
  semanticFp: string | null;
  valid: boolean;
  changeKind: VersionChangeKind;
}

/**
 * Ultima versione (di qualsiasi tipo) per ciascun oggetto: serve
 * all'indicizzatore per non registrare versioni semanticamente identiche
 * (cambia solo DTSTAMP, LAST-MODIFIED o SEQUENCE, o è lo stesso testo).
 */
export async function latestVersions(db: Db, objectIds: readonly string[]): Promise<Map<string, LatestVersionInfo>> {
  const out = new Map<string, LatestVersionInfo>();
  if (objectIds.length === 0) return out;
  const rows = await db<Array<{ object_id: string; id: string; content_sha256: string | null; semantic_fp: string | null; valid: boolean; change_kind: VersionChangeKind }>>`
    SELECT DISTINCT ON (object_id) object_id, id, content_sha256, semantic_fp, valid, change_kind
    FROM cal_object_versions
    WHERE object_id = ANY(${objectIds as string[]}::uuid[])
    ORDER BY object_id, created_at DESC, id DESC
  `;
  for (const r of rows) {
    out.set(r.object_id, { id: r.id, contentSha256: r.content_sha256, semanticFp: r.semantic_fp, valid: r.valid, changeKind: r.change_kind });
  }
  return out;
}

/**
 * true se un testo nuovo va registrato come versione rispetto all'ultima:
 * dopo una cancellazione, al cambio di validità, e per un testo valido solo se
 * cambia il fingerprint semantico (nessuna versione se cambiano soltanto
 * DTSTAMP, LAST-MODIFIED o SEQUENCE, design §6.6 e revisione red-team punto 2);
 * per un testo non valido (senza fingerprint) se cambia il contenuto.
 */
export function needsNewVersion(
  latest: LatestVersionInfo | undefined,
  next: { sha256: string; semanticFp: string | null; valid: boolean },
): boolean {
  if (!latest || latest.changeKind === 'delete' || latest.valid !== next.valid) return true;
  if (next.valid && next.semanticFp && latest.semanticFp) return latest.semanticFp !== next.semanticFp;
  return latest.contentSha256 !== next.sha256;
}

/** Ultima versione valida per ciascun oggetto (ricostruzione delle occorrenze stale dopo un rebuild). */
export async function lastValidVersions(db: Db, objectIds: readonly string[]): Promise<Map<string, CalObjectVersionRow>> {
  const out = new Map<string, CalObjectVersionRow>();
  if (objectIds.length === 0) return out;
  const rows = await db<CalObjectVersionRow[]>`
    SELECT DISTINCT ON (object_id) id, object_id, calendar_id, href, etag, raw_ics, content_sha256, semantic_fp, change_kind, valid, actor, created_at
    FROM cal_object_versions
    WHERE object_id = ANY(${objectIds as string[]}::uuid[]) AND valid AND change_kind <> 'delete' AND raw_ics IS NOT NULL
    ORDER BY object_id, created_at DESC, id DESC
  `;
  for (const r of rows) out.set(r.object_id, r);
  return out;
}

/**
 * Cancella le versioni più vecchie di 90 giorni, a lotti. Mai quelle indicate
 * da cal_objects.last_good_version_id (ultima buona di un oggetto in
 * quarantena, testo corrente di un oggetto sano: vedi testa del file).
 * Restituisce il numero di righe cancellate.
 */
export async function purgeExpiredVersions(db: Db = calSql, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - INDEX_TIMING.versionsRetentionMs);
  let total = 0;
  for (;;) {
    const rows = await db<Array<{ id: string }>>`
      DELETE FROM cal_object_versions v
      WHERE v.id IN (
        SELECT x.id FROM cal_object_versions x
        WHERE x.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM cal_objects o WHERE o.last_good_version_id = x.id)
        ORDER BY x.created_at
        LIMIT ${PURGE_BATCH}
      )
      RETURNING v.id
    `;
    total += rows.length;
    if (rows.length < PURGE_BATCH) return total;
  }
}

/**
 * Cancella tutte le versioni degli oggetti o dei calendari indicati
 * (cancellazione GDPR, design §16.4; F3). Almeno uno dei due filtri è
 * obbligatorio: senza filtri non si cancella nulla. cal_objects.last_good_version_id
 * passa a NULL da sé (ON DELETE SET NULL).
 */
export async function purgeVersionsForErasure(db: Db, match: { objectIds?: string[]; calendarIds?: string[] }): Promise<number> {
  const objectIds = match.objectIds ?? [];
  const calendarIds = match.calendarIds ?? [];
  if (objectIds.length === 0 && calendarIds.length === 0) return 0;
  const rows = await db<Array<{ id: string }>>`
    DELETE FROM cal_object_versions
    WHERE object_id = ANY(${objectIds}::uuid[]) OR calendar_id = ANY(${calendarIds}::uuid[])
    RETURNING id
  `;
  return rows.length;
}
