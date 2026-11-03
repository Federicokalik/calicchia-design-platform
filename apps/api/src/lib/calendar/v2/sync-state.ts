/**
 * Stato di sincronizzazione e salute del calendario per la pagina "Salute"
 * dell'admin (F6 tranche C, passo C3; contratto
 * docs/calendar-radicale/contracts/f6-modules.md §9.1.5).
 *
 * `GET /sync-state` aggrega senza scrivere e senza chiamare Radicale: modo e
 * freeze, ultima verifica d'identità del volume, heartbeat e campanello,
 * salute dell'indice, collezioni (con hold e cancellazioni sospese), oggetti
 * con `health ≠ 'ok'`, job `dead`, conflitti di prenotazione aperti e
 * l'ultimo backup coordinato. Gli elenchi sono completi (nessun limite di
 * righe: sono piccoli per costruzione). Nessun testo di evento: solo
 * identificativi, href, motivi tecnici e conteggi.
 */

import type { CalV2CollectionState, CalV2QuarantinedObject, CalV2SyncState } from '@calicchia/shared';
import { sql } from '../../../db';
import { readBackendStateCached, writesSuspendedInMode } from '../backend-mode';
import { type CollectionHealthView, listCollectionHealth } from '../radicale/health';
import { getCalendarControlPlane } from '../radicale/heartbeat';
import type { Db } from '../radicale/policy';
import { currentWatchMode, inFlightSyncs, lastIdentityCheck, mountUntrusted } from '../radicale/sync';
import type { IdentityStatus } from '../radicale/types';
import { assertV2ObjectsAvailable } from './capabilities';

/** Oltre questa età l'heartbeat dell'API non è più "vivo" (stessa soglia della salute pubblica). */
const HEARTBEAT_MAX_AGE_MS = 2 * 60_000;
/** Un backup coordinato più vecchio di così è "da rifare" (contratto §9.1.5). */
const BACKUP_STALE_HOURS = 12;
/** Lunghezza massima dell'ultimo errore riportato (testo tecnico, mai dati del calendario). */
const MAX_ERROR_CHARS = 300;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const clip = (text: string | null | undefined): string | null => (text ? text.slice(0, MAX_ERROR_CHARS) : null);

// ─── Parti dello stato ───────────────────────────────

function identityOf(
  state: { volume_id: string | null; epoch: number },
  rawStatus: IdentityStatus | null,
  checkedAt: string | null,
  detail: string | null,
): CalV2SyncState['identity'] {
  // `uninitialized` e `unverified` non sono un'incongruenza accertata: per l'admin sono "sconosciuta".
  const status: CalV2SyncState['identity']['status'] = rawStatus === 'ok' ? 'ok' : rawStatus === 'mismatch' ? 'mismatch' : 'unknown';
  return { status, volume_id: state.volume_id, epoch: state.epoch, checked_at: checkedAt, reason: clip(detail) };
}

function heartbeatOf(now: Date): CalV2SyncState['heartbeat'] {
  const at = getCalendarControlPlane()?.status().lastHeartbeatAt ?? null;
  const ms = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(ms)) return { last_at: null, age_seconds: null, ok: false };
  const age = Math.max(0, now.getTime() - ms);
  return { last_at: at, age_seconds: Math.floor(age / 1000), ok: age <= HEARTBEAT_MAX_AGE_MS };
}

interface CollectionExtraRow {
  calendar_id: string;
  name: string;
  last_full_sync_at: Date | null;
}

async function collectionStates(db: Db, views: readonly CollectionHealthView[]): Promise<CalV2CollectionState[]> {
  if (views.length === 0) return [];
  const rows = await db<CollectionExtraRow[]>`
    SELECT c.id AS calendar_id, c.name, st.last_full_sync_at
    FROM calendars c
    LEFT JOIN cal_collection_state st ON st.calendar_id = c.id
    WHERE c.id = ANY(${views.map((v) => v.calendarId)}::uuid[])
  `;
  const extra = new Map(rows.map((r) => [r.calendar_id, r]));
  const inFlight = new Set(inFlightSyncs());
  return views.map((v) => {
    const e = extra.get(v.calendarId);
    return {
      calendar_id: v.calendarId,
      calendar_name: e?.name ?? '',
      collection_name: v.collectionName,
      health: v.health,
      hold_reason: (v.health === 'hold' ? v.holdReason : null) as CalV2CollectionState['hold_reason'],
      hold_since: v.health === 'hold' ? iso(v.healthSince) : null,
      pending_deletions: v.pendingDeletions,
      dirty_since: iso(v.dirtySince),
      last_synced_at: iso(v.lastSyncedAt),
      last_full_sync_at: iso(e?.last_full_sync_at),
      consecutive_failures: v.consecutiveFailures,
      last_error: clip(v.lastError),
      object_count: v.objectCount,
      quarantined_count: v.quarantined,
      sync_in_flight: inFlight.has(v.calendarId),
    };
  });
}

interface QuarantineRow {
  id: string;
  calendar_id: string;
  href: string;
  uid: string | null;
  health: 'quarantined' | 'pending_404';
  health_reason: string | null;
  health_since: Date | null;
  has_last_good: boolean;
}

/** Tutti gli oggetti con `health ≠ 'ok'` (nessun limite: il conteggio della collezione e l'elenco coincidono). */
async function quarantinedObjects(db: Db, now: Date): Promise<CalV2QuarantinedObject[]> {
  const rows = await db<QuarantineRow[]>`
    SELECT o.id, o.calendar_id, o.href, o.uid, o.health, o.health_reason, o.health_since,
           (o.last_good_version_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM cal_occurrences x WHERE x.object_id = o.id AND x.stale)) AS has_last_good
    FROM cal_objects o
    WHERE o.health <> 'ok'
    ORDER BY o.health_since DESC NULLS LAST, o.id
  `;
  return rows.map((r) => ({
    object_id: r.id,
    calendar_id: r.calendar_id,
    href: r.href,
    uid: r.uid,
    health: r.health,
    health_reason: r.health_reason,
    since: (r.health_since ?? now).toISOString(),
    has_last_good_version: r.has_last_good,
  }));
}

/** Job `dead` di tutti i tipi del calendario: lavori che non si risolveranno da soli. */
async function failedJobs(db: Db): Promise<CalV2SyncState['failed_jobs']> {
  const rows = await db<Array<{ id: string; kind: string; attempts: number; last_error: string | null; finished_at: Date | null }>>`
    SELECT id::text AS id, kind, attempts, last_error, finished_at
    FROM cal_jobs
    WHERE status = 'dead'
    ORDER BY finished_at DESC NULLS LAST, id DESC
  `;
  return rows.map((r) => ({ id: r.id, kind: r.kind, attempts: r.attempts, last_error: clip(r.last_error), finished_at: iso(r.finished_at) }));
}

async function openBookingConflicts(db: Db): Promise<CalV2SyncState['booking_conflicts']> {
  const rows = await db<
    Array<{ id: string; booking_id: string; detected_at: Date; detected_by: 'post_commit' | 'auditor'; booking_start: Date; booking_end: Date }>
  >`
    SELECT id::text AS id, booking_id::text AS booking_id, detected_at, detected_by, booking_start, booking_end
    FROM cal_booking_conflicts
    WHERE resolved_at IS NULL
    ORDER BY detected_at DESC, id DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    booking_id: r.booking_id,
    detected_at: r.detected_at.toISOString(),
    detected_by: r.detected_by,
    booking_start: r.booking_start.toISOString(),
    booking_end: r.booking_end.toISOString(),
  }));
}

/**
 * Ultimo backup coordinato (`calendar_backend_state.last_stack_backup`, scritto
 * da scripts/backup-calendar-stack.sh come lo legge il preflight della
 * migrazione). Assente, illeggibile, incompleto o più vecchio di 12 ore → `stale`.
 */
async function backupOf(db: Db, now: Date): Promise<CalV2SyncState['backup']> {
  const [row] = await db<Array<{ at: string | null; complete: boolean | null }>>`
    SELECT last_stack_backup->>'at' AS at, (last_stack_backup->>'complete')::boolean AS complete
    FROM calendar_backend_state
    WHERE id = true
  `;
  const ms = row?.at ? Date.parse(row.at) : Number.NaN;
  if (!Number.isFinite(ms)) return { last_stack_backup_at: null, age_hours: null, stale: true };
  const ageHours = Math.max(0, (now.getTime() - ms) / 3_600_000);
  return {
    last_stack_backup_at: new Date(ms).toISOString(),
    age_hours: Math.round(ageHours * 10) / 10,
    stale: row?.complete === false || ageHours > BACKUP_STALE_HOURS,
  };
}

async function orphanOverrides(db: Db): Promise<number> {
  const [row] = await db<Array<{ n: number }>>`SELECT count(*)::int AS n FROM cal_components WHERE orphan`;
  return row?.n ?? 0;
}

/** Orizzonte garantito a tutte le collezioni: il più vicino fra le loro fini. */
function horizonEnd(views: readonly CollectionHealthView[]): string | null {
  let min: number | null = null;
  for (const v of views) {
    if (!v.horizon) continue;
    const end = v.horizon.end.getTime();
    if (min === null || end < min) min = end;
  }
  return min === null ? null : new Date(min).toISOString();
}

// ─── Route ───────────────────────────────

/** `GET /sync-state`: lo stato aggregato per la pagina Salute (polling dell'admin ogni 20 s). */
export async function getSyncStateV2(db: Db = sql as unknown as Db): Promise<CalV2SyncState> {
  await assertV2ObjectsAvailable();
  const now = new Date();
  const state = await readBackendStateCached();
  const views = await listCollectionHealth(db, { now });
  const [collections, quarantined, jobs, conflicts, backup, orphans] = await Promise.all([
    collectionStates(db, views),
    quarantinedObjects(db, now),
    failedJobs(db),
    openBookingConflicts(db),
    backupOf(db, now),
    orphanOverrides(db),
  ]);

  const plane = getCalendarControlPlane()?.status() ?? null;
  const check = lastIdentityCheck() ?? plane?.lastTick?.identity ?? null;
  const watch = currentWatchMode();

  return {
    generated_at: now.toISOString(),
    mode: state.mode,
    write_freeze: state.write_freeze,
    writes_suspended: writesSuspendedInMode(state.mode),
    restore_guard_until: iso(state.restore_guard_until),
    identity: identityOf(state, check?.status ?? null, check?.checkedAt ?? null, check?.detail ?? null),
    heartbeat: heartbeatOf(now),
    canary: { watch_mode: watch.mode, reason: watch.reason, mount_untrusted: mountUntrusted(watch) },
    index: { rebuild_required: state.rebuild_required, horizon_end: horizonEnd(views), orphan_overrides: orphans },
    collections,
    quarantined,
    failed_jobs: jobs,
    booking_conflicts: conflicts,
    backup,
  };
}
